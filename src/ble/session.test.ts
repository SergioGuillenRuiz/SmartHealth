import { describe, expect, it, vi } from 'vitest';
import { isDestructiveCommand } from './commands';
import { HISTORY } from './constants';
import { RingError } from './errors';
import { RAW_SAMPLE_BYTES, RAW_SLEEP_BYTES, YcbtSession, type LiveEvent } from './session';
import { buildDemoDataset } from './sim/dataset';
import { SimulatedRing, type SimBehavior } from './sim/ring';
import { toHex } from './bytes';
import { DiagnosticLog } from './diag';
import { buildFrame } from './frame';
import { r99Timeline, type RingPush } from './r99-timeline.test-support';
import type { ChunkMeta, LinkKeeper, RingLink } from './transport';

const NOW = new Date(2026, 6, 10, 14, 30, 0).getTime(); // viernes 10 de julio de 2026, 14:30

const FAST = { reply: 200, header: 300, idle: 300 };

function setup(
  behavior: SimBehavior = {},
  dataset = buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 }),
  sessionOptions: { hrWarmupMs?: number; hrStreamAfterMs?: number; hrRetryMs?: number } = {},
) {
  const ring = new SimulatedRing(dataset, behavior);
  const session = new YcbtSession(ring, { timeouts: FAST, ...sessionOptions });
  return { ring, session, dataset };
}

// Una medida puntual real (capturas de anillos de la familia): eco del último valor guardado, silencio, meseta sin
// converger y, pasado el calentamiento, lecturas reales; el anillo cierra la medida él mismo. Aquí a escala de ms:
// una lectura cada 60 ms, calentamiento de 450 ms (la meseta termina a los 420 ms; la primera lectura real llega a los 480).
const REAL_RUN = { hrSamples: [75, 0, 0, 47, 47, 47, 47, 84, 83, 82, 81, 81], hrIntervalMs: 60, hrVerdict: 'success' as const };
const WARMUP = { hrWarmupMs: 450 };

describe('YcbtSession.open', () => {
  it('lee firmware, batería y capacidades del R99 y ajusta el reloj', async () => {
    const { ring, session } = setup();
    const info = await session.open(new Date(2026, 6, 6, 12, 34, 14)); // lunes
    expect(info.firmware).toBe('2.32');
    expect(info.batteryPercent).toBe(78);
    expect(info.capabilities?.has('heartRate')).toBe(true);
    expect(info.capabilities?.has('hrv')).toBe(false);
    // 01 00 + año 2026 LE, mes, día, hora, min, seg, día de la semana (lunes = 0)
    expect(ring.state.clock).toEqual([0xea, 0x07, 7, 6, 12, 34, 14, 0]);
  });

  it('funciona aunque la respuesta llegue antes de que write() devuelva (carrera)', async () => {
    const { session } = setup({ replyDuringWrite: true });
    const info = await session.open();
    expect(info.firmware).toBe('2.32');
  });

  it('funciona con fragmentos de 20 bytes y retardo entre notificaciones', async () => {
    const { session } = setup({ chunkSize: 20, latencyMs: 2 });
    expect((await session.open()).capabilities).not.toBeNull();
  });

  it('si el anillo no responde al protocolo, falla con un error claro', async () => {
    const { session } = setup({ silentOn: ['02:03'] });
    await expect(session.open()).rejects.toMatchObject({ code: 'protocol' });
  });

  it('si el firmware no contesta a una orden no crítica, la apertura continúa', async () => {
    const { session } = setup({ silentOn: ['02:01'] });
    const info = await session.open();
    expect(info.capabilities).toBeNull();
    expect(info.firmware).toBe('2.32');
  });
});

describe('YcbtSession.configure', () => {
  it('escribe el perfil y los monitores de FC y SpO2 con intervalo mínimo de 30 min', async () => {
    const { ring, session } = setup();
    await session.open();
    await session.configure({
      user: { heightCm: 178, weightKg: 79.6, male: true, age: 41 },
      heartIntervalMin: 10, // por debajo del mínimo del firmware
      spo2IntervalMin: 60,
    });
    expect(ring.state.user).toEqual([178, 80, 1, 41]);
    expect(ring.state.heartMonitor).toEqual([1, 30]);
    expect(ring.state.spo2Monitor).toEqual([1, 60]);
  });
});

describe('YcbtSession.syncHistory', () => {
  it('recupera todos los tipos y los datos coinciden con los almacenados (ida y vuelta completa)', async () => {
    const { session, dataset } = setup({ chunkSize: 20, dataFramePayload: 40 });
    await session.open();
    const result = await session.syncHistory();
    expect(result.interrupted).toBe(false);
    expect(result.outcomes.map((o) => [o.type, o.status])).toEqual([
      ['sport', 'ok'],
      ['sleep', 'ok'],
      ['heart', 'ok'],
      ['all', 'ok'],
      ['spo2', 'ok'],
    ]);
    const { records } = result;
    expect(records.heart.map((r) => r.bpm)).toEqual(dataset.heart.map((r) => r.bpm));
    expect(records.heart.map((r) => r.tsMs)).toEqual(dataset.heart.map((r) => Math.floor(r.tsMs / 1000) * 1000));
    expect(records.spo2).toHaveLength(dataset.spo2.length);
    expect(records.all.map((r) => r.steps)).toEqual(dataset.all.map((r) => r.steps));
    expect(records.sport.reduce((a, r) => a + r.steps, 0)).toBe(dataset.sport.reduce((a, r) => a + r.steps, 0));
    expect(records.sleep).toHaveLength(dataset.sleep.length);
    const totalSleep = (list: typeof dataset.sleep) => list.reduce((a, s) => a + s.segments.reduce((b, g) => b + g.durationSec, 0), 0);
    expect(totalSleep(records.sleep)).toBe(totalSleep(dataset.sleep));
  });

  it('confirma cada bloque con 05 80 00 antes de pedir el siguiente tipo', async () => {
    const { ring, session } = setup();
    await session.open();
    await session.syncHistory([HISTORY.heart, HISTORY.spo2]);
    const health = ring.received.filter((f) => f.group === 5).map((f) => `${f.cmd.toString(16)}:${toHex(f.payload)}`);
    expect(health).toEqual(['6:', '80:00', '1a:', '80:00']);
  });

  it('si la escritura del ACK falla una vez con el enlace vivo, se reintenta y el siguiente tipo no se queda esperando', async () => {
    const { ring, session } = setup();
    await session.open();
    let failed = false;
    const write = ring.write.bind(ring);
    ring.write = async (data) => {
      // El primer 05 80 00 (el ACK de la frecuencia cardiaca) falla como lo haría un GATT ocupado.
      if (!failed && data[0] === 0x05 && data[1] === 0x80) {
        failed = true;
        throw new Error('GATT operation already in progress');
      }
      return write(data);
    };
    const result = await session.syncHistory([HISTORY.heart, HISTORY.spo2]);
    expect(failed).toBe(true);
    expect(result.outcomes.map((o) => [o.type, o.status])).toEqual([
      ['heart', 'ok'],
      ['spo2', 'ok'],
    ]);
    const health = ring.received.filter((f) => f.group === 5).map((f) => `${f.cmd.toString(16)}:${toHex(f.payload)}`);
    expect(health).toEqual(['6:', '80:00', '1a:', '80:00']); // el ACK reintentado llegó
  });

  it('si el enlace cae al enviar el ACK no se reintenta (no hay a quién) y lo ya verificado se conserva', async () => {
    const { ring, session } = setup();
    await session.open();
    const write = ring.write.bind(ring);
    let ackWrites = 0;
    ring.write = async (data) => {
      if (data[0] === 0x05 && data[1] === 0x80) {
        ackWrites++;
        ring.simulateLinkLoss();
        throw new Error('GATT: dispositivo desconectado');
      }
      return write(data);
    };
    const result = await session.syncHistory([HISTORY.heart, HISTORY.spo2]);
    expect(ackWrites).toBe(1);
    expect(result.records.heart.length).toBeGreaterThan(0);
    expect(result.interrupted).toBe(true);
  });

  it('el diagnóstico guarda en bruto el buffer de sueño y una muestra de los demás tipos, fuera del límite de la traza', async () => {
    // Con una semana el pulso ocupa más que la muestra (con tres días cabría entero y no se recortaría).
    const { session, dataset } = setup({}, buildDemoDataset({ nowMs: NOW, days: 7, seed: 11 }));
    await session.open();
    await session.syncHistory([HISTORY.sleep, HISTORY.heart]);
    const text = session.log.toText();
    expect(text).toContain('--- datos en bruto (para decodificar sin el anillo) ---');
    expect(text).toMatch(new RegExp(`sueño: buffer reensamblado \\(\\d+ B(; se muestran ${RAW_SLEEP_BYTES})?\\)\\n0000: af fa`));
    expect(text).toMatch(new RegExp(`frecuencia cardiaca: buffer reensamblado \\(\\d+ B; se muestran ${RAW_SAMPLE_BYTES}\\)\\n0000: `));
    // La muestra de un tipo conocido es solo el principio del buffer (líneas de 32 B), no todo.
    const heartBlock = text.slice(text.indexOf('frecuencia cardiaca: buffer reensamblado'));
    expect(heartBlock.split('\n').filter((l) => /^[0-9a-f]{4}: /.test(l))).toHaveLength(RAW_SAMPLE_BYTES / 32);
    expect(dataset.heart.length).toBeGreaterThan(20);
  });

  it('un tipo que el firmware no implementa (0xFC) se omite sin afectar al resto', async () => {
    const { session } = setup({ unsupportedHistory: ['spo2'] });
    await session.open();
    const result = await session.syncHistory([HISTORY.spo2, HISTORY.heart]);
    expect(result.outcomes.map((o) => [o.type, o.status])).toEqual([
      ['spo2', 'unsupported'],
      ['heart', 'ok'],
    ]);
    expect(result.records.heart.length).toBeGreaterThan(0);
  });

  it('un tipo sin datos almacenados se resuelve como vacío, sin ACK pendiente', async () => {
    const { ring, session } = setup({}, { ...buildDemoDataset({ nowMs: NOW, days: 2, seed: 3 }), spo2: [] });
    await session.open();
    const result = await session.syncHistory([HISTORY.spo2, HISTORY.heart]);
    expect(result.outcomes.map((o) => o.status)).toEqual(['empty', 'ok']);
    // Tras 'empty' no hay nada que confirmar: lo siguiente que se escribe es la consulta de FC.
    const health = ring.received.filter((f) => f.group === 5).map((f) => f.cmd);
    expect(health).toEqual([0x1a, 0x06, 0x80]);
  });

  it('una trama de datos perdida se detecta por CRC, se confirma con NAK y se reintenta una vez', async () => {
    const { ring, session, dataset } = setup({ dropFirstDataFrameOf: 'heart' });
    await session.open();
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]?.status).toBe('ok');
    expect(result.records.heart).toHaveLength(dataset.heart.length);
    const acks = ring.received.filter((f) => f.group === 5 && f.cmd === 0x80).map((f) => f.payload[0]);
    expect(acks).toEqual([0x04, 0x00]);
  });

  it('si el CRC sigue fallando tras el reintento, el tipo se descarta como corrupto', async () => {
    const { session } = setup({ alwaysDropFirstDataFrameOf: 'heart' });
    await session.open();
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]?.status).toBe('corrupt');
    expect(result.records.heart).toHaveLength(0);
  });

  it('ignora un bloque terminal rezagado de otro tipo, antes o después de la cabecera', async () => {
    for (const staleTerminal of ['before-header', 'after-header'] as const) {
      const { session, dataset } = setup({ staleTerminal });
      await session.open();
      const result = await session.syncHistory([HISTORY.heart]);
      expect(result.outcomes[0]?.status, staleTerminal).toBe('ok');
      expect(result.records.heart).toHaveLength(dataset.heart.length);
    }
  });

  it('si el anillo se queda mudo a mitad de transferencia, se marca timeout y NO se confirma nada', async () => {
    const { ring, session } = setup({ dropTerminalOf: 'heart' });
    await session.open();
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]?.status).toBe('timeout');
    expect(ring.received.some((f) => f.group === 5 && f.cmd === 0x80)).toBe(false);
  });

  it('si se pierde la conexión a mitad, conserva lo ya verificado y lo marca como interrumpido', async () => {
    const { ring, session } = setup();
    await session.open();
    const result = await session.syncHistory([HISTORY.heart, HISTORY.spo2, HISTORY.sport], (p) => {
      if (p.type.id === 'spo2' && p.starting) ring.simulateLinkLoss();
    });
    expect(result.interrupted).toBe(true);
    expect(result.records.heart.length).toBeGreaterThan(0);
    expect(result.outcomes.map((o) => o.type)).toEqual(['heart', 'spo2']);
  });

  it('si una escritura falla porque el enlace ya cayó (sin aviso todavía), cuenta como conexión perdida y conserva lo leído', async () => {
    const { ring, session } = setup();
    await session.open();
    const result = await session.syncHistory([HISTORY.heart, HISTORY.spo2, HISTORY.sport], (p) => {
      // El enlace se cae sin que la sesión se entere: la siguiente escritura rechaza con un error nativo.
      if (p.type.id === 'spo2' && p.starting) ring.connected = false;
    });
    expect(result.interrupted).toBe(true);
    expect(result.records.heart.length).toBeGreaterThan(0);
    expect(result.outcomes.map((o) => [o.type, o.status])).toEqual([
      ['heart', 'ok'],
      ['spo2', 'error'],
    ]);
  });

  it('si una escritura falla con el enlace abierto, ese tipo se marca como error y se siguen leyendo los demás', async () => {
    const { ring, session } = setup();
    await session.open();
    const write = ring.write.bind(ring);
    ring.write = async (data) => {
      if (data[0] === 0x05 && data[1] === HISTORY.spo2.queryKey) throw new Error('GATT operation failed');
      return write(data);
    };
    const result = await session.syncHistory([HISTORY.heart, HISTORY.spo2, HISTORY.sport]);
    expect(result.interrupted).toBe(false);
    expect(result.outcomes.map((o) => [o.type, o.status])).toEqual([
      ['heart', 'ok'],
      ['spo2', 'error'],
      ['sport', 'ok'],
    ]);
    expect(result.outcomes[1]?.detail).toMatch(/no se pudo enviar/);
  });

  it('si no se puede confirmar un bloque ya verificado por CRC, el bloque no se tira', async () => {
    const { ring, session, dataset } = setup();
    await session.open();
    const write = ring.write.bind(ring);
    ring.write = async (data) => {
      if (data[0] === 0x05 && data[1] === 0x80) throw new Error('GATT operation failed');
      return write(data);
    };
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]?.status).toBe('ok');
    expect(result.records.heart).toHaveLength(dataset.heart.length);
  });

  it('informa del progreso por tipo', async () => {
    const { session } = setup();
    await session.open();
    const seen: string[] = [];
    await session.syncHistory([HISTORY.heart, HISTORY.spo2], (p) => seen.push(`${p.type.id}:${p.starting ? 'ini' : 'fin'}:${p.index + 1}/${p.total}`));
    expect(seen).toEqual(['heart:ini:1/2', 'heart:fin:1/2', 'spo2:ini:2/2', 'spo2:fin:2/2']);
  });
});

describe('YcbtSession: topes frente a un otro extremo que no se porta como un anillo', () => {
  it('una transferencia que pasa del tope de bytes se corta con un error, sea cual sea el tamaño que anuncie su cabecera', async () => {
    const ring = new SimulatedRing(buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 }), { dataFramePayload: 40 });
    const session = new YcbtSession(ring, { timeouts: FAST, maxTransferBytes: 200 });
    await session.open();
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]).toMatchObject({ type: 'heart', status: 'error', detail: 'el buffer supera el tope' });
    expect(result.records.heart).toHaveLength(0);
  });

  it('una transferencia que no acaba nunca (el otro lado sigue mandando tramas) se corta por tiempo total, no solo por silencio', async () => {
    const ring = new SimulatedRing(buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 }), { dataFramePayload: 20, latencyMs: 4 });
    const session = new YcbtSession(ring, { timeouts: FAST, maxTransferMs: 15 });
    await session.open();
    const result = await session.syncHistory([HISTORY.heart]);
    expect(result.outcomes[0]).toMatchObject({ type: 'heart', status: 'timeout' });
    expect(result.outcomes[0]?.detail).toMatch(/la transferencia no acaba/);
  });

  it('con los topes de verdad, una sincronización normal sigue entera', async () => {
    const { session } = setup({ chunkSize: 20, dataFramePayload: 40 });
    await session.open();
    const result = await session.syncHistory();
    expect(result.outcomes.every((o) => o.status === 'ok')).toBe(true);
  });
});

describe('YcbtSession: avisos del anillo', () => {
  it('confirma con 04 <clave> 00 cada aviso, pero no los estados de error', async () => {
    const { ring, session } = setup();
    await session.open();
    ring.pushDevControl(0x0e, [0x00, 0x01]); // resultado de medida
    ring.pushDevControl(0x16, [0xfc]); // 1 byte 0xFC = estado de error, no un aviso
    await new Promise((r) => setTimeout(r, 20));
    const acks = ring.received.filter((f) => f.group === 4).map((f) => `${f.cmd.toString(16)}:${toHex(f.payload)}`);
    expect(acks).toEqual(['e:00']);
  });
});

describe('YcbtSession: medidas en vivo', () => {
  it('lee los pasos del día y vuelve a desactivar el empuje', async () => {
    const { ring, session, dataset } = setup();
    await session.open();
    const status = await session.readLiveStatus(500);
    expect(status).toEqual(dataset.live);
    expect(ring.state.liveStatus).toBe(false);
  });

  it('medida puntual de FC: espera el veredicto del anillo y devuelve lo posterior al calentamiento (ni el eco ni la meseta)', async () => {
    const { ring, session } = setup(REAL_RUN, undefined, WARMUP);
    await session.open();
    const seen: number[] = [];
    const bpm = await session.measureHeartRate({ timeoutMs: 3000, onSample: (v) => seen.push(v) });
    // Eco 75 y meseta 47 47 47 47 NO cuentan, aunque la meseta «se estabilice» (cuatro valores iguales seguidos).
    expect(bpm).toBe(81); // la última lectura fiable (la que el anillo da por buena y guarda en su historial)
    expect(seen).toEqual([84, 83, 82, 81, 81]); // y al usuario solo se le enseña lo posterior al calentamiento
    expect(ring.state.measuring).toBeNull();
    const modes = ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f).map((f) => toHex(f.payload));
    expect(modes).toEqual(['0100', '0000']); // inicio y PARADA con el mismo modo
  });

  it('si el anillo da la medida por fallida (04 0e estado 2) no se inventa un valor', async () => {
    const { session } = setup({ ...REAL_RUN, hrVerdict: 'failure' }, undefined, WARMUP);
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 3000 })).toBeNull();
  });

  it('si el anillo cierra la medida antes de terminar el calentamiento, se usan sus últimas lecturas (sin el eco inicial)', async () => {
    const { session } = setup({ hrSamples: [75, 0, 72, 73, 74], hrIntervalMs: 20, hrVerdict: 'success' }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 3000 })).toBe(74);
  });

  it('un cierre «con éxito» cuya única lectura es el eco del último valor guardado NO se da por medida', async () => {
    const { session } = setup({ hrSamples: [75], hrIntervalMs: 20, hrVerdict: 'success' }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 3000 })).toBeNull();
  });

  it('si el enlace cae a mitad de una medida puntual falla enseguida con link-closed, sin esperar al tiempo máximo', async () => {
    const { ring, session } = setup({ hrSamples: [75, 0, 0, 0], hrIntervalMs: 50 }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    setTimeout(() => ring.simulateLinkLoss(), 80);
    const started = Date.now();
    await expect(session.measureHeartRate({ timeoutMs: 20_000 })).rejects.toMatchObject({ code: 'link-closed' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('una medida puntual se puede cancelar: devuelve null y deja el sensor apagado', async () => {
    const { ring, session } = setup({ hrSamples: [75, 0, 0, 0], hrIntervalMs: 50 }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 80);
    const started = Date.now();
    expect(await session.measureHeartRate({ timeoutMs: 20_000, signal: abort.signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ring.state.measuring).toBeNull();
  });

  it('cerrar la sesión mientras el anillo no contesta a «empezar medida» manda igualmente la orden de parar', async () => {
    // Cancelar una medida cierra la sesión al instante (ver `measureHeartRateNow`). El sensor pudo arrancar aunque su
    // respuesta no llegue: cerrar sin mandar el stop lo dejaría encendido (batería).
    const { ring, session } = setup({ silentOn: ['03:2f'] }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    const measuring = session.measureHeartRate({ timeoutMs: 20_000 }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50)); // dentro de la espera de la respuesta (200 ms)
    await session.close();
    expect(await measuring).toMatchObject({ code: 'link-closed' });
    const measureOrders = ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f).map((f) => [...f.payload]);
    expect(measureOrders).toEqual([
      [1, 0], // empezar
      [0, 0], // parar
    ]);
  });

  it('una medida rechazada por el anillo no manda una orden de parar que no hace falta', async () => {
    const { ring, session } = setup({ refuseModes: [0] });
    await session.open();
    await expect(session.measureHeartRate({ timeoutMs: 3000 })).rejects.toMatchObject({ code: 'refused' });
    await session.close();
    const measureOrders = ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f).map((f) => [...f.payload]);
    expect(measureOrders).toEqual([[1, 0]]);
  });

  it('una medida cancelada antes de empezar ni siquiera enciende el sensor más de lo imprescindible', async () => {
    const { ring, session } = setup({ hrSamples: [75, 0, 0, 0], hrIntervalMs: 50 });
    await session.open();
    const abort = new AbortController();
    abort.abort();
    expect(await session.measureHeartRate({ timeoutMs: 20_000, signal: abort.signal })).toBeNull();
    expect(ring.state.measuring).toBeNull();
  });

  it('sin veredicto del anillo solo vale una racha estable posterior al calentamiento', async () => {
    const { session } = setup({ hrSamples: [75, 0, 47, 47, 47, 84, 83, 83], hrIntervalMs: 20 }, undefined, { hrWarmupMs: 100 });
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 600 })).toBe(83);
  });

  it('sin veredicto y sin lecturas posteriores al calentamiento devuelve null (la meseta no es una medida)', async () => {
    const { session } = setup({ hrSamples: [75, 0, 47, 47, 47, 47, 47, 47], hrIntervalMs: 20 }, undefined, { hrWarmupMs: 60_000 });
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 300 })).toBeNull();
  });

  it('si el anillo no da ninguna lectura válida devuelve null', async () => {
    const { session } = setup({ hrSamples: [0, 0, 0, 0] });
    await session.open();
    expect(await session.measureHeartRate({ timeoutMs: 150 })).toBeNull();
  });

  it('si el anillo rechaza la medida lo comunica como error y no deja nada encendido', async () => {
    const { ring, session } = setup({ refuseModes: [0] });
    await session.open();
    await expect(session.measureHeartRate({ timeoutMs: 200 })).rejects.toMatchObject({ code: 'refused' });
    expect(ring.state.measuring).toBeNull();
  });

  it('acepta el pulso en directo también por la trama de constantes vitales (06 03)', async () => {
    const { ring, session } = setup({ hrSamples: [0] }, undefined, { hrWarmupMs: 0, hrStreamAfterMs: 0 });
    await session.open();
    const got: number[] = [];
    const stop = await session.startLiveHeartRate((bpm) => got.push(bpm));
    await new Promise((r) => setTimeout(r, 5));
    ring.pushReal(0x03, [0, 0, 77, 0, 0, 0, 0]); // [sis][dia][fc][hrv][spo2]…
    ring.pushReal(0x03, [0, 0, 0, 0, 0, 0, 0]); // sin lectura: no cuenta
    await new Promise((r) => setTimeout(r, 30));
    await stop();
    expect(got).toEqual([77]);
  });

  it('en deporte, si el anillo cierra la medida por su cuenta se vuelve a pedir; al parar ya no', async () => {
    const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 5 });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate(() => undefined);
    expect(starts()).toBe(1);

    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 60));
    expect(starts()).toBe(2); // reinicio automático

    await new Promise((r) => setTimeout(r, 1100)); // pasada la ventana de los cierres repetidos, otro cierre es de la medida nueva
    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 60));
    expect(starts()).toBe(3);

    await stop();
    ring.pushDevControl(0x0e, [0, 1]); // un cierre rezagado tras parar no reabre nada
    await new Promise((r) => setTimeout(r, 1200));
    expect(starts()).toBe(3);
    expect(ring.state.measuring).toBeNull();
  });

  it('pulso continuo: la medida se reabre en cuanto el anillo la cierra, sin esperar a ningún temporizador (con la app oculta se espacian hasta un minuto)', async () => {
    const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 5 });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate(() => undefined);
    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 40)); // lo que antes tardaba 500 ms
    expect(starts()).toBe(2);
    await stop();
  });

  it('pulso continuo: si el anillo rechaza reabrir la medida se reintenta enseguida, sin dejar el sensor apagado hasta el silencio de 25 s', async () => {
    const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 }, undefined, { hrRetryMs: 30 });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate(() => undefined);
    ring.refuseNext = 2; // las dos siguientes peticiones de medida las rechaza (aún cerrando la anterior)
    ring.pushDevControl(0x0e, [0, 1]);
    // Se espera a que el anillo acepte la reapertura (con el equipo cargado, como en el CI, los temporizadores se retrasan).
    await vi.waitFor(
      () => {
        expect(starts()).toBeGreaterThanOrEqual(4); // la inicial, la reapertura rechazada, un reintento rechazado y otro aceptado
        expect(ring.state.measuring).toBe(0);
      },
      { timeout: 10_000, interval: 10 },
    );
    const accepted = starts();
    await new Promise((r) => setTimeout(r, 300));
    expect(starts()).toBe(accepted); // aceptada: no se sigue insistiendo
    await stop();
  }, 20_000);

  it('pulso continuo: se deja de reintentar tras unos cuantos rechazos seguidos (el vigilante de silencio sigue ahí)', async () => {
    const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 }, undefined, { hrRetryMs: 10 });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate(() => undefined);
    ring.refuseNext = 100;
    ring.pushDevControl(0x0e, [0, 1]);
    // Se espera a que ocurra (no un tiempo fijo: con el equipo cargado, como en el CI, los temporizadores se retrasan) y luego se comprueba que se para.
    await vi.waitFor(() => expect(starts()).toBe(1 + 1 + 4), { timeout: 10_000, interval: 10 }); // inicial + reapertura + 4 reintentos
    await new Promise((r) => setTimeout(r, 200));
    expect(starts()).toBe(1 + 1 + 4); // y ahí se para
    await stop();
  }, 20_000);

  it('poke(): tras un silencio de más de 25 s reabre la medida aunque los temporizadores no hayan corrido', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // solo el reloj: los temporizadores «no corren», como con la app oculta
    try {
      const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
      await session.open();
      const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
      const stop = await session.startLiveHeartRate(() => undefined);
      expect(starts()).toBe(1);

      vi.setSystemTime(Date.now() + 10_000);
      session.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(1); // 10 s sin lecturas todavía es normal (el sensor calienta)

      vi.setSystemTime(Date.now() + 20_000);
      session.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(2); // 30 s de silencio: se vuelve a pedir
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cualquier trama del anillo también despierta la comprobación (llega aunque los temporizadores estén parados)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
      await session.open();
      const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
      const stop = await session.startLiveHeartRate(() => undefined);
      // Una trama cada pocos segundos (aquí, del contador de pasos en directo) y ninguna lectura de pulso: a los 30 s de silencio se vuelve a pedir.
      for (let seconds = 5; seconds <= 30; seconds += 5) {
        vi.setSystemTime(Date.now() + 5000);
        ring.pushReal(0x00, [0, 0, 0, 0, 0, 0]);
        await new Promise((r) => setTimeout(r, 30));
        expect(starts(), `a los ${seconds} s`).toBe(seconds < 30 ? 1 : 2);
      }
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tras una parada larga de la web (nada corrió en más de 7 s) se espera a lo atrasado antes de dar un silencio por bueno', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
      await session.open();
      const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
      const stop = await session.startLiveHeartRate(() => undefined);
      vi.setSystemTime(Date.now() + 60_000); // la web estuvo parada un minuto
      session.poke(); // lo primero que corre es la comprobación: lo que mandó el anillo aún no se ha procesado
      await new Promise((r) => setTimeout(r, 30));
      expect(starts(), 'no se reinicia el sensor a ciegas').toBe(1);
      vi.setSystemTime(Date.now() + 9000); // pasado el margen (8 s) y sin que llegara nada: el silencio es real
      session.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(2);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('un hueco de 12 s entre comprobaciones ya es una parada de la web: con 32 s de silencio no se reabre a ciegas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
      await session.open();
      const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
      const stop = await session.startLiveHeartRate(() => undefined);
      for (let seconds = 5; seconds <= 20; seconds += 5) {
        vi.setSystemTime(Date.now() + 5000); // una comprobación cada 5 s: web viva
        session.poke();
      }
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(1);
      vi.setSystemTime(Date.now() + 12_000); // 12 s sin que corra nada: la web estuvo parada, y esto ya son 32 s sin lecturas
      session.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts(), 'primero se espera a lo atrasado').toBe(1);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('con temporizadores muy espaciados y sin nada que procesar, el margen no aplaza sin fin la reapertura', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
      await session.open();
      const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
      const stop = await session.startLiveHeartRate(() => undefined);
      vi.setSystemTime(Date.now() + 60_000);
      session.poke(); // primer hueco largo: se espera
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(1);
      // El margen pasó sin que llegara ningún evento: no había nada atrasado. Otro hueco igual de largo ya no se aplaza.
      vi.setSystemTime(Date.now() + 60_000);
      session.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts()).toBe(2);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('poke() no hace nada con la sesión cerrada ni tras parar el pulso', async () => {
    const { ring, session } = setup({ hrSamples: [80], hrIntervalMs: 100_000 });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate(() => undefined);
    await stop();
    session.poke();
    await session.close();
    session.poke();
    await new Promise((r) => setTimeout(r, 30));
    expect(starts()).toBe(1);
  });

  it('pulso continuo con un anillo que cierra la medida: entrega al veredicto solo lo fiable y vuelve a pedirla', async () => {
    const { ring, session } = setup(REAL_RUN, undefined, WARMUP);
    await session.open();
    const got: number[] = [];
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate((bpm) => got.push(bpm));

    await new Promise((r) => setTimeout(r, 400));
    expect(got).toEqual([]); // eco y meseta no llegan al entrenamiento
    await new Promise((r) => setTimeout(r, 450)); // veredicto a los ~720 ms
    expect(got).toEqual([84, 83, 82, 81, 81]);

    await new Promise((r) => setTimeout(r, 700)); // reinicio a los 500 ms del cierre
    expect(starts()).toBe(2);
    await stop();
    expect(ring.state.measuring).toBeNull();
  });

  it('pulso continuo: un cierre repetido (04 0e reenviado) no duplica lecturas ni reinicios', async () => {
    const { ring, session } = setup(REAL_RUN, undefined, WARMUP);
    await session.open();
    const got: number[] = [];
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const stop = await session.startLiveHeartRate((bpm) => got.push(bpm));
    await new Promise((r) => setTimeout(r, 850)); // veredicto a los ~720 ms
    ring.pushDevControl(0x0e, [0, 1]); // el anillo reenvía el mismo cierre
    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 700));
    expect(got).toEqual([84, 83, 82, 81, 81]); // entregado una sola vez
    expect(starts()).toBe(2); // y un solo reinicio
    await stop();
  });

  it('si el anillo rechaza el pulso en directo no queda ningún oyente que lo reinicie con un 04 0e perdido', async () => {
    const { ring, session } = setup({ refuseModes: [0] });
    await session.open();
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    await expect(session.startLiveHeartRate(() => undefined)).rejects.toMatchObject({ code: 'refused' });
    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 700));
    expect(starts()).toBe(1); // solo el intento rechazado
  });

  it('el vigilante del pulso se apaga solo si el enlace se pierde, aunque nadie llame a la función de parada', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { ring, session } = setup({ hrSamples: [0], hrIntervalMs: 1000 });
      await session.open();
      await session.startLiveHeartRate(() => undefined);
      expect(vi.getTimerCount()).toBe(2); // el temporizador del simulador y el vigilante de la sesión
      ring.simulateLinkLoss();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pulso continuo: si el anillo no cierra la medida en un minuto se entiende que emite en continuo', async () => {
    const { session } = setup({ hrSamples: [70], hrIntervalMs: 15 }, undefined, { hrWarmupMs: 60, hrStreamAfterMs: 200 });
    await session.open();
    const got: number[] = [];
    const stop = await session.startLiveHeartRate((bpm) => got.push(bpm));
    await new Promise((r) => setTimeout(r, 120));
    expect(got).toEqual([]); // aún no se sabe si cerrará la medida: se retiene
    await new Promise((r) => setTimeout(r, 350));
    expect(got.length).toBeGreaterThan(8); // ya entrega conforme llegan
    await stop();
  });

  it('FC continua en un anillo que emite sin cerrar la medida: entrega cada muestra y se detiene al parar', async () => {
    const { ring, session } = setup({ hrSamples: [80, 82, 85, 90], hrIntervalMs: 5 }, undefined, { hrWarmupMs: 0, hrStreamAfterMs: 0 });
    await session.open();
    const got: number[] = [];
    const stop = await session.startLiveHeartRate((bpm) => got.push(bpm));
    await new Promise((r) => setTimeout(r, 60));
    await stop();
    expect(got.slice(0, 4)).toEqual([80, 82, 85, 90]);
    expect(ring.state.measuring).toBeNull();
  });

  it('emite eventos en vivo de pasos mientras el empuje está activo', async () => {
    const { session, dataset } = setup({ liveIntervalMs: 5 });
    await session.open();
    const events: LiveEvent[] = [];
    session.onLive((e) => events.push(e));
    await session.enableLiveStatus(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(events.some((e) => e.kind === 'status' && e.status.steps === dataset.live.steps)).toBe(true);
  });
});

describe('YcbtSession: cierre', () => {
  it('close() suelta la conexión y las operaciones posteriores fallan con link-closed', async () => {
    const { ring, session } = setup();
    await session.open();
    await session.close();
    expect(ring.connected).toBe(false);
    expect(session.isOpen).toBe(false);
    await expect(session.readLiveStatus(50)).rejects.toBeInstanceOf(RingError);
  });

  it('si el enlace cae durante open(), falla con link-closed', async () => {
    const { ring, session } = setup({ latencyMs: 20 });
    const opening = session.open();
    setTimeout(() => ring.simulateLinkLoss(), 5);
    await expect(opening).rejects.toMatchObject({ code: 'link-closed' });
  });
});


describe('guardia anti-borrado (05 40…4E vacían el historial del anillo)', () => {
  it('reconoce el rango destructivo y solo ese', () => {
    expect(isDestructiveCommand({ group: 0x05, cmd: 0x40 })).toBe(true);
    expect(isDestructiveCommand({ group: 0x05, cmd: 0x4e })).toBe(true);
    expect(isDestructiveCommand({ group: 0x05, cmd: 0x3f })).toBe(false);
    expect(isDestructiveCommand({ group: 0x05, cmd: 0x4f })).toBe(false);
    expect(isDestructiveCommand({ group: 0x03, cmd: 0x40 })).toBe(false);
    for (const type of Object.values(HISTORY)) expect(isDestructiveCommand({ group: 0x05, cmd: type.queryKey })).toBe(false);
  });

  it('una sincronización completa, una medida y un entreno no envían ninguna orden de borrado', async () => {
    const { ring, session } = setup();
    const sent: Array<[number, number]> = [];
    const write = ring.write.bind(ring);
    ring.write = async (data) => {
      sent.push([data[0] ?? 0, data[1] ?? 0]);
      return write(data);
    };
    await session.open(new Date(NOW));
    await session.configure({ user: { heightCm: 178, weightKg: 80, male: true, age: 41 }, heartIntervalMin: 60, spo2IntervalMin: 60 });
    await session.syncHistory();
    await session.enableLiveStatus(true);
    await session.enableLiveStatus(false);
    await session.close();
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter(([group, cmd]) => isDestructiveCommand({ group, cmd }))).toEqual([]);
  });
});

describe('YcbtSession: esperas calibradas con el R99 real', () => {
  const dataset = () => buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 });

  it('la consulta de oxígeno (05 1a), que el R99 no contesta nunca, se da por perdida a los 1,2 s y no a los 6 s', async () => {
    vi.useFakeTimers();
    try {
      const session = new YcbtSession(new SimulatedRing(dataset(), { silentOn: ['05:1a'] }), { timeouts: { header: 6000 } });
      let result: Awaited<ReturnType<YcbtSession['syncHistory']>> | null = null;
      void session.syncHistory([HISTORY.spo2]).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(1100);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toMatchObject({ outcomes: [{ type: 'spo2', status: 'timeout', detail: 'sin cabecera' }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('el resto de consultas de historial conservan la espera general de la cabecera', async () => {
    vi.useFakeTimers();
    try {
      const session = new YcbtSession(new SimulatedRing(dataset(), { silentOn: ['05:06'] }), { timeouts: { header: 6000 } });
      let result: Awaited<ReturnType<YcbtSession['syncHistory']>> | null = null;
      void session.syncHistory([HISTORY.heart]).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(5900);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toMatchObject({ outcomes: [{ type: 'heart', status: 'timeout' }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('el primer envío de pasos del R99 tarda ~2,5 s: la espera por defecto (6 s) lo recoge', async () => {
    vi.useFakeTimers();
    try {
      const data = dataset();
      const session = new YcbtSession(new SimulatedRing(data, { liveFirstMs: 2500, liveFirstOnly: true }));
      let status: unknown = 'pendiente';
      void session.readLiveStatus().then((s) => (status = s));
      await vi.advanceTimersByTimeAsync(2600);
      expect(status).toEqual(data.live);
    } finally {
      vi.useRealTimers();
    }
  });

  it('al reiniciar el ciclo de pulso la respuesta del anillo se espera: no queda como «respuesta sin petición pendiente»', async () => {
    // Esas líneas son la señal de que OTRA app habla con el anillo; las órdenes de la propia app no deben producirlas.
    const log = new DiagnosticLog();
    const ring = new SimulatedRing(dataset(), { hrSamples: [80], hrIntervalMs: 5 });
    const session = new YcbtSession(ring, { timeouts: FAST, log });
    await session.open();
    const stop = await session.startLiveHeartRate(() => undefined);
    ring.pushDevControl(0x0e, [0, 1]);
    await new Promise((r) => setTimeout(r, 700)); // el cierre del anillo provoca el reinicio a los 500 ms
    await stop();
    const starts = ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    expect(starts).toBe(2);
    expect(log.toText()).not.toContain('sin petición pendiente');
  });
});


describe('YcbtSession: lo que añade el lado nativo (la app de Android con la pantalla apagada)', () => {
  /**
   * El anillo simulado con lo que haría el lado nativo de Android: cada fragmento que llega lleva la hora a la que llegó de verdad, que puede
   * ser muy anterior a la de procesarlo si el WebView estuvo parado. Cada prueba dice qué lleva cada trama que empuja el anillo (`push`).
   */
  function nativeSetup(sessionOptions: { hrWarmupMs?: number; hrStreamAfterMs?: number; hrRetryMs?: number } = {}) {
    const ring = new SimulatedRing(buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 }), { hrSamples: [80], hrIntervalMs: 100_000 });
    // Lo que lleva cada trama, por sus bytes: la entrega al enlace es asíncrona y varias pueden estar en vuelo a la vez.
    const metas = new Map<string, ChunkMeta[]>();
    const keeper = { arm: vi.fn(async (_frame: Uint8Array) => undefined), disarm: vi.fn(async () => undefined) } satisfies LinkKeeper;
    const link: RingLink = {
      get id() {
        return ring.id;
      },
      get name() {
        return ring.name;
      },
      get connected() {
        return ring.connected;
      },
      write: (data) => ring.write(data),
      onData: (listener) =>
        ring.onData((channel, chunk) => {
          const queue = metas.get(toHex(chunk));
          listener(channel, chunk, queue?.shift());
        }),
      onDisconnect: (listener) => ring.onDisconnect(listener),
      disconnect: () => ring.disconnect(),
      keeper,
    };
    const session = new YcbtSession(link, { timeouts: FAST, ...sessionOptions });
    const starts = (): number => ring.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length;
    const acksOf = (cmd: number): number => ring.received.filter((f) => f.group === 4 && f.cmd === cmd).length;
    /** Empuja una trama del anillo con lo que el lado nativo le añadió (o sin nada). */
    const push = (kind: 'real' | 'devControl', key: number, payload: number[], native?: ChunkMeta): void => {
      const group = kind === 'real' ? 6 : 4;
      if (native) {
        const hex = toHex(buildFrame(group, key, payload));
        metas.set(hex, [...(metas.get(hex) ?? []), native]);
      }
      if (kind === 'real') ring.pushReal(key, payload);
      else ring.pushDevControl(key, payload);
    };
    return { ring, session, keeper, starts, acksOf, push };
  }
  const meta = (atMs: number, extra: Partial<ChunkMeta> = {}): ChunkMeta => ({ seq: 1, atMs, restartAtMs: 0, reflexed: false, ...extra });
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  it('arma el reflejo nativo con la trama con la que pide el pulso, y lo desarma al parar', async () => {
    const { session, keeper } = nativeSetup();
    await session.open();
    const stop = await session.startLiveHeartRate(() => undefined);
    expect(keeper.arm).toHaveBeenCalledTimes(1);
    expect(keeper.arm.mock.calls[0]?.[0]).toEqual(buildFrame(0x03, 0x2f, [1, 0]));
    expect(keeper.disarm).not.toHaveBeenCalled();
    await stop();
    expect(keeper.disarm).toHaveBeenCalled();
  });

  it('si el anillo rechaza el pulso, el reflejo no queda armado', async () => {
    const { ring, session, keeper } = nativeSetup();
    await session.open();
    ring.refuseNext = 1;
    await expect(session.startLiveHeartRate(() => undefined)).rejects.toMatchObject({ code: 'refused' });
    expect(keeper.arm).not.toHaveBeenCalled();
  });

  it('un aviso que el reflejo nativo ya atendió no se vuelve a confirmar; uno normal, sí', async () => {
    const { ring, session, push, acksOf } = nativeSetup();
    await session.open();
    await session.startLiveHeartRate(() => undefined);
    push('devControl', 0x13, [0, 1, 80], meta(Date.now(), { reflexed: false }));
    await settle();
    expect(acksOf(0x13)).toBe(1);
    push('devControl', 0x13, [0, 1, 81], meta(Date.now(), { reflexed: true }));
    await settle();
    expect(acksOf(0x13), 'el reflejo ya lo confirmó').toBe(1);
    // Sin lo nativo (el navegador) se confirma, como siempre.
    push('devControl', 0x13, [0, 1, 82]);
    await settle();
    expect(acksOf(0x13)).toBe(2);
    expect(ring.connected).toBe(true);
  });

  describe('con el WebView parado, las lecturas llegan tarde pero con su hora', () => {
    it('el cierre de la medida que ya atendió el reflejo no vuelve a pedirla, y solo vale lo posterior al calentamiento según la hora de llegada', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        expect(starts()).toBe(1);

        // El WebView se queda parado 70 s. Lo que sigue es lo que el anillo mandó durante ese rato, procesado de golpe al volver.
        vi.setSystemTime(start + 70_000);
        const at = (seconds: number, extra: Partial<ChunkMeta> = {}): ChunkMeta => meta(start + seconds * 1000, extra);
        push('real', 0x01, [62], at(1)); // el eco del último valor guardado: no es una lectura
        push('real', 0x01, [63], at(15)); // la meseta
        push('real', 0x01, [120], at(30)); // ya calentó (28 s)
        push('real', 0x01, [125], at(33));
        push('devControl', 0x0e, [0, 1], at(35, { reflexed: true, restartAtMs: start + 35_000 })); // el anillo cierra y el reflejo ya la volvió a pedir
        await settle();

        expect(got.map(([bpm]) => bpm)).toEqual([120, 125]);
        expect(got.map(([, ts]) => ts)).toEqual([start + 30_000, start + 33_000]);
        expect(starts(), 'no se pide otra vez: ya lo hizo el reflejo').toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sin la hora de nativo (el navegador) se cuenta la de procesar la lectura, como siempre', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 40_000);
        push('real', 0x01, [90]);
        push('devControl', 0x0e, [0, 1]);
        await settle();
        expect(got).toEqual([[90, start + 40_000]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('mientras se procesan lecturas atrasadas, el silencio que se ve no es de ahora: no se vuelve a pedir la medida', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const start = Date.now();
        await session.startLiveHeartRate(() => undefined);
        vi.setSystemTime(start + 100_000); // el WebView estuvo parado un minuto y medio
        push('real', 0x01, [100], meta(start + 90_000)); // y esta lectura es de hace 10 s
        await settle();
        session.poke(); // un aviso nativo, mientras aún se procesa lo atrasado
        await settle();
        expect(starts()).toBe(1);

        // Ya al día: 15 s después de esa lectura aún no es silencio (25 s).
        vi.setSystemTime(start + 105_000);
        session.poke();
        await settle();
        expect(starts()).toBe(1);
        // La web vuelve a pararse y a los 40 s de aquella lectura despierta: primero se espera a lo atrasado, y pasado el margen, sin nada más, es un silencio de verdad.
        vi.setSystemTime(start + 130_000);
        session.poke();
        await settle();
        expect(starts()).toBe(1);
        vi.setSystemTime(start + 139_000); // pasado el margen (8 s desde el aviso de los 130 s)
        session.poke();
        await settle();
        expect(starts()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('una petición del reflejo nativo que la web no vio (el anillo calló y la pidió él) empieza un ciclo nuevo en su hora', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: number[] = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm) => got.push(bpm));
        vi.setSystemTime(start + 80_000);
        // A los 40 s el reflejo pidió el pulso otra vez; una lectura de los 45 s es del 5.º segundo de ese ciclo (calentando), no del 45.º del primero.
        push('real', 0x01, [58], meta(start + 45_000, { restartAtMs: start + 40_000 }));
        push('real', 0x01, [118], meta(start + 75_000, { restartAtMs: start + 40_000 })); // 35 s después del reinicio: ya vale
        push('devControl', 0x0e, [0, 1], meta(start + 76_000, { restartAtMs: start + 40_000 }));
        await settle();
        // Al cierre se entrega lo posterior al calentamiento de ESE ciclo (el 58 de los 5 s no cuenta).
        expect(got).toEqual([118]);
        expect(starts(), 'el cierre no atendido por el reflejo sí lo repite la web').toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('al encender la pantalla tras una parada larga del WebView', () => {
    type Push = ReturnType<typeof nativeSetup>['push'];
    const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    /** Entrega lo atrasado de golpe, con avisos (`poke`) intercalados en los puntos indicados (antes del evento con ese índice; `events.length` = al final). */
    async function feed(push: Push, events: readonly RingPush[], poke: () => void, pokeBefore: readonly number[] = []): Promise<void> {
      for (let i = 0; i <= events.length; i++) {
        if (pokeBefore.includes(i)) {
          await macrotask(); // lo ya entregado se procesa antes que el aviso
          poke();
        }
        const event = events[i];
        if (event) push(event.kind, event.key, event.payload, event.native);
      }
      await settle();
    }

    it('el aviso de «pantalla encendida» llega ANTES que lo atrasado: no se reinicia el sensor y no se pierde ninguna lectura', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 105_000); // casi dos minutos con el WebView parado
        const { events, expected } = r99Timeline(start, 5);
        await feed(push, events, () => session.poke(), [0]);
        expect(got).toEqual(expected);
        expect(starts(), 'ningún arranque extra: el reflejo nativo ya iba reabriendo la medida').toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('el aviso llega DESPUÉS de lo atrasado: igual', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 105_000);
        const { events, expected } = r99Timeline(start, 5);
        await feed(push, events, () => session.poke(), [events.length]);
        expect(got).toEqual(expected);
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('da igual en qué punto de lo atrasado llegue el aviso (o si llegan varios): ni arranque extra ni lecturas perdidas', async () => {
      const length = r99Timeline(0, 3).events.length;
      for (let at = 0; at <= length; at++) {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const { session, push, starts } = nativeSetup();
          await session.open();
          const got: Array<[number, number]> = [];
          const start = Date.now();
          await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
          vi.setSystemTime(start + 65_000);
          const { events, expected } = r99Timeline(start, 3);
          await feed(push, events, () => session.poke(), [at, Math.min(length, at + 5)]);
          expect(got, `aviso antes del evento ${at}`).toEqual(expected);
          expect(starts(), `aviso antes del evento ${at}`).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      }
    });

    it('después de despertar la medida sigue su ciclo con normalidad: el siguiente cierre reabre el sensor y entrega sus lecturas', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 105_000); // el 6.º ciclo (que empezó a los 100 s) lleva 5 s
        const { events, expected } = r99Timeline(start, 5);
        await feed(push, events, () => session.poke(), [0]);
        expect(got).toEqual(expected);
        // Ya con la web viva: lecturas y cierre del 6.º ciclo, a su hora.
        for (let s = 8; s <= 18; s++) {
          vi.setSystemTime(start + 100_000 + s * 1000);
          push('real', 0x01, [90], meta(Date.now(), { restartAtMs: start + 100_000 }));
          await settle();
        }
        vi.setSystemTime(start + 120_000);
        push('devControl', 0x0e, [0, 1], meta(Date.now(), { restartAtMs: start + 100_000 }));
        await settle();
        expect(got.slice(-3)).toEqual([
          [90, start + 116_000],
          [90, start + 117_000],
          [90, start + 118_000],
        ]);
        expect(starts(), 'este cierre no lo atendió el reflejo (la web estaba viva): lo reabre la web').toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('mirar el móvil dos veces seguidas (la web vuelve a pararse a los pocos segundos de despertar) tampoco pierde nada', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        const { events, expected } = r99Timeline(start, 6);
        const firstWake = start + 65_000;
        const early = events.filter((e) => e.native.atMs <= firstWake);
        const late = events.filter((e) => e.native.atMs > firstWake);
        vi.setSystemTime(firstWake);
        await feed(push, early, () => session.poke(), [0]);
        vi.setSystemTime(firstWake + 3000); // tres segundos con la pantalla encendida… y se apaga otra vez
        session.poke();
        vi.setSystemTime(start + 125_000);
        await feed(push, late, () => session.poke(), [0]);
        expect(got).toEqual(expected);
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('un cierre que el reflejo no vio pasar (llegó antes de darse por parada la web) y cuya copia sí atendió: no se repite la orden', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 105_000);
        const { events, expected } = r99Timeline(start, 4, { firstReflexed: false, firstCopyAfterS: 6 });
        await feed(push, events, () => session.poke(), [0]);
        expect(got).toEqual(expected);
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('un cierre que nadie atendió ni reabrió se repite al despertar, pero solo cuando ya se procesó todo lo atrasado', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 60_000);
        const { events, expected } = r99Timeline(start, 1, { firstReflexed: false });
        await feed(push, events, () => session.poke(), [0, events.length]);
        expect(got).toEqual(expected);
        expect(starts(), 'aún se está procesando lo atrasado').toBe(1);
        vi.setSystemTime(start + 66_000); // dentro del margen (8 s): una comprobación cada pocos segundos, como con la web viva
        session.poke();
        vi.setSystemTime(start + 69_000); // pasado el margen
        session.poke();
        await settle();
        expect(starts(), 'pasado el margen y sin que nadie la reabriera').toBe(2);
        vi.setSystemTime(start + 75_000);
        session.poke();
        await settle();
        expect(starts(), 'y una sola vez').toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('si lo atrasado muestra que el reflejo ya reabrió la medida (lecturas posteriores al cierre), la web no la pide', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const start = Date.now();
        await session.startLiveHeartRate(() => undefined);
        vi.setSystemTime(start + 60_000);
        const { events } = r99Timeline(start, 1, { firstReflexed: false });
        // Tras el cierre sin atender, el reflejo reabrió la medida a los 25 s (silencio) y llegaron lecturas del ciclo nuevo.
        const reopenedAt = start + 45_000;
        for (let s = 8; s <= 12; s++) events.push({ kind: 'real', key: 0x01, payload: [88], native: meta(reopenedAt + s * 1000, { restartAtMs: reopenedAt }) });
        await feed(push, events, () => session.poke(), [events.length]);
        vi.setSystemTime(start + 70_000);
        session.poke();
        await settle();
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('un cierre sin atender y sin copias, con 9 s de retraso, se reabre al acabar el margen: no hay que esperar a los 25 s de silencio', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        const closeAt = start + 20_000;
        const wake = closeAt + 9_000; // el cierre llega con 9 s de retraso (más de lo que cubre el reflejo)
        vi.setSystemTime(wake);
        const { events, expected } = r99Timeline(start, 1, { firstReflexed: false });
        await feed(push, events, () => session.poke(), [0]);
        expect(got).toEqual(expected);
        expect(starts(), 'aún dentro del margen').toBe(1);
        vi.setSystemTime(wake + 6000);
        session.poke();
        await settle();
        expect(starts(), 'sigue dentro del margen (8 s)').toBe(1);
        vi.setSystemTime(wake + 9000); // 18 s después del cierre: aún no son los 25 s de silencio, pero nadie reabrió la medida
        session.poke();
        await settle();
        expect(starts(), 'se reabre al acabar el margen').toBe(2);
        vi.setSystemTime(wake + 10_000);
        session.poke();
        await settle();
        expect(starts(), 'y una sola vez').toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('si tras el cierre sin atender llegan lecturas (la medida se reabrió sin que el reflejo lo dijera), la web tampoco la pide', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const start = Date.now();
        await session.startLiveHeartRate(() => undefined);
        const closeAt = start + 20_000;
        vi.setSystemTime(closeAt + 20_000);
        const { events } = r99Timeline(start, 1, { firstReflexed: false });
        // Lecturas posteriores al cierre, sin dato de reinicio del reflejo: la medida está abierta.
        for (let s = 8; s <= 12; s++) events.push({ kind: 'real', key: 0x01, payload: [88], native: meta(closeAt + s * 1000, { restartAtMs: 0 }) });
        await feed(push, events, () => session.poke(), [0]);
        vi.setSystemTime(Date.now() + 6000);
        session.poke();
        vi.setSystemTime(Date.now() + 3000); // ya pasado el margen
        session.poke();
        await settle();
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('huecos de 5 y 6,5 s entre lotes de lo atrasado (más que el margen de antes, menos que el hueco de parada) no reabren la medida ni pierden lecturas', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        const { events, expected } = r99Timeline(start, 3);
        const third = Math.floor(events.length / 3);
        const batches = [events.slice(0, third), events.slice(third, 2 * third), events.slice(2 * third)];
        vi.setSystemTime(start + 65_000);
        for (const [i, batch] of batches.entries()) {
          if (i > 0) vi.setSystemTime(Date.now() + (i === 1 ? 5000 : 6500)); // el WebView procesa un lote, se frena y llega el siguiente con un aviso por medio
          await feed(push, batch, () => session.poke(), [0]);
        }
        expect(got).toEqual(expected);
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('un reinicio hecho a hora de proceso no hace retroceder la última lectura: lo atrasado que llega después con horas anteriores no provoca una cadena de reaperturas', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const start = Date.now();
        await session.startLiveHeartRate(() => undefined);
        vi.setSystemTime(start + 125_000);
        const { events } = r99Timeline(start, 3);
        // Lo atrasado llega en tres lotes, cada uno tras un hueco de 7,1 s (ya cuenta como parada) y un aviso: nunca debe haber más de una orden de más.
        const third = Math.floor(events.length / 3);
        for (const [i, batch] of [events.slice(0, third), events.slice(third, 2 * third), events.slice(2 * third)].entries()) {
          if (i > 0) vi.setSystemTime(Date.now() + 7100);
          await feed(push, batch, () => session.poke(), [0]);
        }
        expect(starts()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('la última lectura y el cierre que atendió el reflejo en el MISMO fragmento (misma hora de petición): se entregan las tres últimas lecturas, no se pierde el ciclo', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const got: Array<[number, number]> = [];
        const start = Date.now();
        await session.startLiveHeartRate((bpm, ts) => got.push([bpm, ts]));
        vi.setSystemTime(start + 60_000);
        const closeAt = start + 20_000;
        for (let s = 8; s <= 16; s++) push('real', 0x01, [70], meta(start + s * 1000));
        // El reflejo les pone la misma hora de petición (la del cierre) a las dos tramas del fragmento.
        push('real', 0x01, [70], meta(closeAt, { restartAtMs: closeAt, reflexed: true }));
        push('devControl', 0x0e, [0, 1], meta(closeAt, { restartAtMs: closeAt, reflexed: true }));
        await settle();
        expect(got.map(([bpm]) => bpm)).toEqual([70, 70, 70]);
        expect(got.at(-1)).toEqual([70, closeAt]);
        expect(starts(), 'el reflejo ya la reabrió').toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('si la cola atrasada llega mucho después del margen (ya se reabrió a ciegas una vez), lo atrasado no hace volver atrás la última lectura ni provoca otra reapertura', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { session, push, starts } = nativeSetup();
        await session.open();
        const start = Date.now();
        await session.startLiveHeartRate(() => undefined);
        vi.setSystemTime(start + 125_000);
        session.poke(); // la web despierta y los avisos corren, pero la cola del WebView no llega: parada detectada, margen de 8 s
        vi.setSystemTime(start + 129_000);
        session.poke();
        vi.setSystemTime(start + 134_000); // pasado el margen sin que haya llegado nada: no había nada atrasado que esperar, se reabre
        session.poke();
        await settle();
        expect(starts()).toBe(2);
        // Y ahora llega la cola, con horas de antes del reinicio.
        const { events } = r99Timeline(start, 5);
        await feed(push, events, () => undefined);
        // Una comprobación cada pocos segundos hasta 25 s después: la última lectura no ha retrocedido a las de la cola, así que no hay silencio.
        for (let seconds = 5; seconds <= 25; seconds += 5) {
          vi.setSystemTime(Date.now() + 5000);
          session.poke();
        }
        await settle();
        expect(starts()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
