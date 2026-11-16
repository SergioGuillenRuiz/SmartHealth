import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport, type SimBehavior } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { addDays, dayKeyOf, rangeDays } from '../domain/dates';
import { groupSleep } from '../domain/sleep';
import { buildDaySummaries } from '../domain/summary';
import { runSync, SyncFailure, type SyncProgress } from './run-sync';

const NOW = new Date(2026, 6, 10, 14, 30, 0).getTime();
const FAST = { reply: 300, header: 500, idle: 500 };

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`sync-${++counter}`);
  await store.putProfileEntry({ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' });
});

const setup = (behavior: SimBehavior = {}) => {
  const dataset = buildDemoDataset({ nowMs: NOW, days: 7, seed: 21 });
  const transport = new SimulatedTransport(dataset, { chunkSize: 20, ...behavior });
  return { dataset, transport };
};

describe('runSync (anillo simulado → almacén)', () => {
  it('sincroniza una semana completa, guarda el anillo y deja la conexión CERRADA', async () => {
    const { dataset, transport } = setup();
    const stages: string[] = [];
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST, onProgress: (p: SyncProgress) => stages.push(p.stage) });

    expect(report).toMatchObject({ ringName: 'R99 F265', firmware: '2.32', batteryPercent: 78, interrupted: false });
    expect(report.outcomes.map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(report.liveSteps).toBe(dataset.live.steps);
    expect(report.warnings).toEqual([]);
    expect(stages[0]).toBe('connecting');
    expect(stages.at(-1)).toBe('done');
    expect(await store.getRing()).toEqual({ id: 'sim-r99-0001', name: 'R99 F265' });

    // Batería del anillo: no queda ninguna conexión abierta.
    expect(transport.lastRing?.connected).toBe(false);
    expect(transport.lastRing?.state.measuring).toBeNull();
    expect(transport.lastRing?.state.liveStatus).toBe(false);
  });

  it('el informe dice cuánto tardó cada parte, en orden y con la conexión soltada al final, y la traza lo lleva también', async () => {
    const { transport } = setup();
    let clock = NOW;
    // Un reloj que avanza 100 ms cada vez que se mira: cada parte dura un número exacto de lecturas.
    const now = (): number => (clock += 100);
    const report = await runSync({ transport, store, now, timeouts: FAST });
    expect(report.phases.map((p) => p.stage)).toEqual(['connecting', 'handshake', 'configuring', 'steps', 'history', 'saving', 'closing']);
    for (const phase of report.phases) expect(phase.ms).toBeGreaterThan(0);
    expect(report.log).toMatch(/fases: connecting [\d.]+ s · handshake [\d.]+ s · configuring [\d.]+ s · steps [\d.]+ s · history [\d.]+ s/); // hasta que empieza a guardar: lo que falta no cabía aún en la traza
    // Lo que se enseña: sin «done» (no dura nada) y con el cierre.
    expect(report.phases.some((p) => p.stage === 'done')).toBe(false);
  });

  it('una sincronización que cruza la medianoche guarda el contador de pasos en el día en que se leyó', async () => {
    const dataset = buildDemoDataset({ nowMs: NOW, days: 7, seed: 21 });
    const transport = new SimulatedTransport(dataset, { chunkSize: 20 });
    // El contador se lee a las 23:59:57; cuando la sincronización pasa a «Guardando» ya son las 00:00:08 del día siguiente.
    const beforeMidnight = new Date(2026, 6, 10, 23, 59, 57).getTime();
    const afterMidnight = new Date(2026, 6, 11, 0, 0, 8).getTime();
    let saving = false;
    await runSync({ transport, store, now: () => (saving ? afterMidnight : beforeMidnight), timeouts: FAST, onProgress: (p: SyncProgress) => void (saving ||= p.stage === 'saving') });
    const counters = (await store.loadRange('2026-07-10', '2026-07-11')).counters.filter((c) => c.steps === dataset.live.steps);
    expect(counters.map((c) => c.tsMs)).toContain(beforeMidnight); // el contador en directo, con la hora de lectura
    expect(counters.map((c) => c.tsMs)).not.toContain(afterMidnight); // y no con la de guardar: pondría los pasos de ayer en hoy
  });

  it('guarda las funciones que declara el anillo: de ahí dependen los deportes y datos que se ofrecen', async () => {
    const { transport } = setup();
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(report.capabilities).toEqual(expect.arrayContaining(['heartRate', 'sleep', 'spo2', 'steps']));
    // El R99 real no declara HRV, temperatura ni estrés: no se inventan.
    expect(report.capabilities).not.toEqual(expect.arrayContaining(['hrv']));
    expect(report.capabilities).not.toEqual(expect.arrayContaining(['temperature']));
    expect(report.capabilities).not.toEqual(expect.arrayContaining(['stress']));
    expect((await store.lastSuccessfulSync())?.capabilities).toEqual(report.capabilities);
  });

  it('con «mostrar todos los dispositivos» no reutiliza el anillo guardado y pide el selector sin filtros', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const picks: unknown[] = [];
    const reconnects: unknown[] = [];
    const pick = transport.pickAndConnect.bind(transport);
    const reconnect = transport.reconnect.bind(transport);
    transport.pickAndConnect = (options) => (picks.push(options), pick(options));
    transport.reconnect = (saved) => (reconnects.push(saved), reconnect(saved));

    await runSync({ transport, store, now: () => NOW, timeouts: FAST }, { showAll: true });
    expect(picks).toEqual([{ showAll: true }]);
    expect(reconnects).toEqual([]);

    // Y sin la opción, un anillo ya vinculado se reconecta sin selector.
    picks.length = 0;
    await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(picks).toEqual([]);
    expect(reconnects).toHaveLength(1);
  });

  it('si el anillo no publica los pasos del día al arrancar, los vuelve a pedir tras el historial', async () => {
    const { dataset, transport } = setup({ suppressFirstLiveStatus: true });
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(report.liveSteps).toBe(dataset.live.steps);
    const enables = transport.lastRing!.received.filter((f) => f.group === 3 && f.cmd === 0x09 && f.payload[0] === 1);
    expect(enables).toHaveLength(2);
  });

  it('un anillo que nunca contesta a la consulta dedicada de oxígeno no llena cada sincronización de avisos si los datos ya vinieron en las constantes', async () => {
    const { transport } = setup({ silentOn: ['05:1a'] });
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(report.outcomes.find((o) => o.type === 'spo2')).toMatchObject({ status: 'timeout', detail: 'sin cabecera' });
    expect(report.warnings).toEqual([]);
    expect(report.added.spo2).toBeGreaterThan(0); // el oxígeno llegó por el registro de constantes
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('pero si lo que no contesta son las constantes o el pulso, sí se avisa', async () => {
    const { transport } = setup({ silentOn: ['05:06'] });
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(report.warnings.join(' ')).toMatch(/dejó de responder al leer/);
  });

  it('configura el anillo con el perfil vigente y los intervalos de medición', async () => {
    const { transport } = setup();
    await store.setSettings({ heartIntervalMin: 30, spo2IntervalMin: 120 });
    await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    const ring = transport.lastRing!;
    expect(ring.state.user).toEqual([178, 80, 1, 41]);
    expect(ring.state.heartMonitor).toEqual([1, 30]);
    expect(ring.state.spo2Monitor).toEqual([1, 120]);
    expect(ring.state.clock?.slice(0, 2)).toEqual([0xea, 0x07]); // 2026
  });

  it('los datos guardados reproducen lo que había en el anillo (pasos, sueño y FC por día)', async () => {
    const { dataset, transport } = setup();
    await runSync({ transport, store, now: () => NOW, timeouts: FAST });

    const days = rangeDays(addDays(dayKeyOf(NOW), -6), dayKeyOf(NOW));
    const range = await store.loadRange(days[0]!, days.at(-1)!);
    const summaries = buildDaySummaries(days, range, await store.getProfileHistory(), NOW);

    // Pasos: el máximo del contador acumulado de cada día del anillo.
    for (const summary of summaries) {
      const counters = dataset.all.filter((r) => dayKeyOf(r.tsMs) === summary.day).map((r) => r.steps);
      const expected = counters.length ? Math.max(...counters) : null;
      const sportSum = dataset.sport.filter((r) => dayKeyOf(r.startMs) === summary.day).reduce((a, r) => a + r.steps, 0);
      if (expected !== null) expect(summary.steps).toBeGreaterThanOrEqual(Math.min(expected, sportSum));
    }
    // Sueño: la duración dormida por noche coincide con la del anillo.
    const stored = groupSleep(range.sleep);
    for (const night of dataset.sleep) {
      const asleep = night.segments.filter((s) => s.stage !== 'awake').reduce((a, s) => a + s.durationSec, 0);
      expect(stored.get(dayKeyOf(night.endMs))?.night?.asleepSec).toBe(asleep);
    }
    // FC: hay curva diaria con lecturas.
    expect(summaries.filter((s) => s.avgBpm !== null).length).toBeGreaterThanOrEqual(5);
  });

  it('una segunda sincronización no duplica nada', async () => {
    const { transport } = setup();
    await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    const before = (await store.stats()).counts;
    // Un minuto después: lo único nuevo es el punto del contador de pasos leído en directo en ese instante.
    const second = await runSync({ transport, store, now: () => NOW + 60_000, timeouts: FAST });
    expect(second.added).toEqual({ buckets: 0, counters: 1, heart: 0, spo2: 0, sleep: 0 });
    expect(second.updated.heart).toBe(before.heart);
    expect((await store.stats()).counts).toEqual({ ...before, counters: before.counters! + 1, syncs: before.syncs! + 1 });
  });

  it('si el anillo ya estaba vinculado, reconecta sin selector', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const calls: string[] = [];
    const spy = {
      kind: transport.kind,
      available: true,
      pickAndConnect: async (o?: never) => (calls.push('pick'), transport.pickAndConnect(o)),
      reconnect: async (s: { id: string; name: string }) => (calls.push('reconnect'), transport.reconnect(s)),
    };
    await runSync({ transport: spy, store, now: () => NOW, timeouts: FAST });
    expect(calls).toEqual(['reconnect']);
  });

  it('si la conexión se corta a mitad, guarda lo ya leído, avisa y desconecta', async () => {
    const { transport } = setup();
    let stage: string | null = null;
    const report = await runSync({
      transport,
      store,
      now: () => NOW,
      timeouts: FAST,
      onProgress: (p) => {
        // Cortar justo al empezar a leer la FC (tercer tipo): actividad y sueño ya estarán a salvo.
        if (p.stage === 'history' && p.message.includes('frecuencia') && stage === null) {
          stage = 'cut';
          transport.lastRing?.simulateLinkLoss();
        }
      },
    });
    expect(report.interrupted).toBe(true);
    expect(report.warnings[0]).toMatch(/conexión/i);
    expect(report.added.buckets).toBeGreaterThan(0);
    expect(report.added.sleep).toBeGreaterThan(0);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('si el anillo no habla YCBT falla con la traza adjunta, lo registra y suelta la conexión', async () => {
    const { transport } = setup({ silentOn: ['02:03'] });
    const error = await runSync({ transport, store, now: () => NOW, timeouts: FAST }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncFailure);
    expect((error as SyncFailure).code).toBe('protocol');
    expect((error as SyncFailure).log).toContain('02 03');
    expect(transport.lastRing?.connected).toBe(false);
    const [last] = await store.listSyncs(1);
    expect(last?.error).toMatch(/YCBT/);
    expect(last?.log).toContain('02 03');
    expect(await store.getRing()).toBeNull(); // un anillo que no habla el protocolo no se recuerda
  });

  it('si el usuario cancela el selector no se registra ninguna sincronización fallida', async () => {
    const { transport } = setup();
    const cancelling = {
      kind: 'web-bluetooth' as const,
      available: true,
      pickAndConnect: async () => {
        const { RingError } = await import('../ble/errors');
        throw new RingError('No se ha elegido ningún anillo.', 'no-device');
      },
      reconnect: async () => null,
    };
    void transport;
    await expect(runSync({ transport: cancelling, store, now: () => NOW })).rejects.toMatchObject({ code: 'no-device' });
    expect(await store.listSyncs(5)).toHaveLength(0);
  });

  it('pide siempre los tipos básicos aunque el bitmap no los marque (no se fía del bitmap para lo esencial)', async () => {
    const dataset = buildDemoDataset({ nowMs: NOW, days: 2, seed: 2 });
    const bitmap = new Uint8Array(dataset.supportBitmap);
    bitmap[1] = 0x00; // el bitmap no marca SpO2…
    const transport = new SimulatedTransport({ ...dataset, supportBitmap: bitmap }, {});
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    // …pero se consulta igual: un bit mal puesto no debe dejar al usuario sin esos datos.
    expect(report.outcomes.map((o) => o.type)).toEqual(['sport', 'sleep', 'heart', 'all', 'spo2']);
    expect(report.capabilities).toContain('spo2');
  });

  it('lo que el anillo rechaza al pedírselo (0xFC) deja de contarse como función que ofrece', async () => {
    const { transport } = setup({ unsupportedHistory: ['heart', 'spo2'] });
    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(report.outcomes.filter((o) => o.status === 'unsupported').map((o) => o.type)).toEqual(['heart', 'spo2']);
    expect(report.capabilities).not.toContain('heartRate');
    expect(report.capabilities).not.toContain('spo2');
    expect(report.capabilities).toEqual(expect.arrayContaining(['steps', 'sleep']));
    expect((await store.lastSuccessfulSync())?.capabilities).toEqual(report.capabilities);
  });
});

describe('runSync automática (silenciosa y cancelable)', () => {
  it('reconecta en silencio con un solo intento corto, sincroniza y deja el anillo suelto', async () => {
    const { dataset, transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const asked: unknown[] = [];
    const reconnect = transport.reconnect.bind(transport);
    transport.reconnect = (saved, options) => (asked.push(options), reconnect(saved, options));
    const abort = new AbortController();

    const report = await runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true, signal: abort.signal });

    expect(asked).toEqual([{ silent: true, attempts: 1, timeoutMs: 8000, signal: abort.signal }]);
    expect(report.liveSteps).toBe(dataset.live.steps);
    expect(transport.lastRing?.connected).toBe(false);
    expect((await store.lastSuccessfulSync())?.tsMs).toBe(NOW);
  });

  it('con el anillo fuera de alcance no abre el selector del sistema ni anota un fallo: ni siquiera llegó a conectar', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    transport.reachable = false;
    let picked = 0;
    const pick = transport.pickAndConnect.bind(transport);
    transport.pickAndConnect = (options) => (picked++, pick(options));

    await expect(runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true })).rejects.toMatchObject({ code: 'connect-failed' });

    expect(picked).toBe(0);
    expect(await store.listSyncs(5)).toHaveLength(0);
  });

  it('sin anillo vinculado tampoco abre el selector: no hay nada que reconectar', async () => {
    const { transport } = setup();
    let picked = 0;
    const pick = transport.pickAndConnect.bind(transport);
    transport.pickAndConnect = (options) => (picked++, pick(options));
    await expect(runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true })).rejects.toMatchObject({ code: 'connect-failed' });
    expect(picked).toBe(0);
    expect(transport.connections).toBe(0);
  });

  it('cancelada a mitad del historial suelta el enlace, no guarda el historial a medias y no anota un error; el contador de pasos, que ya se había leído, sí queda guardado', async () => {
    const { dataset, transport } = setup({ latencyMs: 5 });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const abort = new AbortController();
    let liveSaved = 0;
    const syncing = runSync(
      { transport, store, now: () => NOW, timeouts: { reply: 2000, header: 2000, idle: 2000 }, onProgress: (p: SyncProgress) => p.stage === 'history' && abort.abort() },
      { silent: true, signal: abort.signal, onLiveSaved: () => void liveSaved++ },
    );

    await expect(syncing).rejects.toMatchObject({ code: 'aborted' });
    expect(transport.lastRing?.connected).toBe(false);
    expect(await store.listSyncs(5)).toHaveLength(0); // una cancelada no es un fallo del anillo
    const counts = (await store.stats()).counts;
    expect((counts.heart ?? 0) + (counts.buckets ?? 0) + (counts.sleep ?? 0)).toBe(0); // el historial, nada a medias
    // Un vistazo corto a la app corta la sincronización, pero los pasos se guardaron en cuanto se leyeron y la pantalla se avisó.
    expect(liveSaved).toBe(1);
    expect(counts.counters).toBe(1);
    const today = dayKeyOf(NOW);
    expect((await store.loadRange(today, today)).counters).toEqual([{ tsMs: NOW, steps: dataset.live.steps }]);
  });

  it('el contador guardado antes del historial no se duplica con el de la sincronización completa, y una a mano no lo guarda antes', async () => {
    const { dataset, transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    let liveSaved = 0;
    await runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true, onLiveSaved: () => void liveSaved++ });
    expect(liveSaved).toBe(1);
    const today = dayKeyOf(NOW);
    const mine = (await store.loadRange(today, today)).counters.filter((c) => c.tsMs === NOW);
    expect(mine).toEqual([{ tsMs: NOW, steps: dataset.live.steps }]);

    // Una a mano no hace el guardado adelantado (y no avisa a quien no lo pidió).
    const manual = setup();
    await runSync({ transport: manual.transport, store, now: () => NOW + 1000, timeouts: FAST }, { onLiveSaved: () => void liveSaved++ });
    expect(liveSaved).toBe(1);
  });

  it('cancelada ya antes de empezar no llega a abrir ningún enlace', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const abort = new AbortController();
    abort.abort();
    await expect(runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true, signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(transport.connections).toBe(0);
  });

  it('no toca el anillo vinculado (ni lo renombra ni lo recupera si se acaba de olvidar) y, si sale bien, guarda su registro sin traza BLE', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'Mi anillo' });
    await runSync({ transport, store, now: () => NOW, timeouts: FAST }, { silent: true });
    expect(await store.getRing()).toEqual({ id: 'sim-r99-0001', name: 'Mi anillo' }); // una a mano lo habría renombrado a «R99 F265»
    const record = (await store.listSyncs(1))[0];
    expect(record?.tsMs).toBe(NOW);
    expect(record?.log).toBeUndefined(); // se hacen cada diez minutos con la app a la vista y nadie las mira

    // Una sincronización a mano sí guarda su traza (y renombra).
    await runSync({ transport: setup().transport, store, now: () => NOW + 1000, timeouts: FAST });
    expect((await store.listSyncs(1))[0]?.log).toEqual(expect.any(String));
    expect(await store.getRing()).toEqual({ id: 'sim-r99-0001', name: 'R99 F265' });
  });

  it('una sincronización a mano, sin las opciones nuevas, se comporta como siempre (dos intentos largos y selector)', async () => {
    const { transport } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const asked: unknown[] = [];
    const reconnect = transport.reconnect.bind(transport);
    transport.reconnect = (saved, options) => (asked.push(options), reconnect(saved, options));
    await runSync({ transport, store, now: () => NOW, timeouts: FAST });
    expect(asked).toEqual([undefined]);
  });
});
