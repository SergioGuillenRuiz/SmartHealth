import { describe, expect, it } from 'vitest';
import { fromHex, toHex, u8 } from './bytes';
import { Commands } from './commands';
import { Group, HEALTH_NO_DATA_PAYLOAD, HISTORY, HealthKey } from './constants';
import { crc16 } from './crc';
import { DiagnosticLog } from './diag';
import { buildFrame, parseFrame } from './frame';
import {
  R99_ALL_0800_HEX,
  R99_ALL_HEX,
  R99_HEART_0800_HEX,
  R99_HEART_HEX,
  R99_HEART_MEASURE_FRAMES,
  R99_LIVE_FRAMES,
  R99_LIVE_STEPS_1390,
  R99_SPORT_0600_HEX,
  R99_SPORT_HEX,
  R99_SYNC_EXCHANGE,
} from './fixtures';
import { decodeAll, decodeHeart, decodeSport } from './records';
import { parseDeviceInfo, YcbtSession, type LiveEvent } from './session';
import type { Channel, RingLink } from './transport';

// Bytes reales de un R99 (firmware 2.32) capturados por la prueba guiada el 2026-10-13 (ver `fixtures.ts`). Estas pruebas son la
// red de seguridad de lo único verificado con un anillo físico: que las órdenes de la app son byte a byte las que el anillo
// acepta, que sus tramas pasan el CRC y que los registros se entienden como los entiende Smart Health.

const wire = (command: { group: number; cmd: number; payload: readonly number[] }): string => toHex(buildFrame(command.group, command.cmd, command.payload));

describe('R99 real · lo que manda la app', () => {
  it('cada orden de una sincronización es idéntica, byte a byte, a la que el anillo real aceptó', () => {
    // 5:02:06 del martes 13 de octubre de 2026; perfil de la persona que hizo la prueba (180 cm, 102 kg, hombre, 23 años).
    const ours = [
      Commands.getDeviceName(),
      Commands.setTime(new Date(2026, 9, 13, 5, 2, 6)),
      Commands.getDeviceInfo(),
      Commands.getSupportFunction(),
      Commands.setUserInfo({ heightCm: 180, weightKg: 102, male: true, age: 23 }),
      Commands.setHeartMonitor(true, 60),
      Commands.setBloodOxygenMonitor(true, 60),
      Commands.setLiveStatus(true),
      Commands.setLiveStatus(false),
      Commands.historyRequest(HISTORY.sport),
      Commands.historyAck(HealthKey.ackAccepted),
      Commands.historyRequest(HISTORY.sleep),
      Commands.historyRequest(HISTORY.heart),
      Commands.historyAck(HealthKey.ackAccepted),
      Commands.historyRequest(HISTORY.all),
      Commands.historyAck(HealthKey.ackAccepted),
      Commands.historyRequest(HISTORY.spo2),
    ].map(wire);
    const real = R99_SYNC_EXCHANGE.filter(([direction]) => direction === 'tx').map(([, hex]) => hex);
    expect(ours).toEqual(real);
  });

  it('las órdenes de medida en vivo y la confirmación del aviso de fin de medida también coinciden con las reales', () => {
    expect(wire(Commands.startMeasurement(0))).toBe('03' + '2f' + '0800' + '0100' + '4f1b');
    expect(wire(Commands.stopMeasurement(0))).toBe('03' + '2f' + '0800' + '0000' + '7e28');
    expect(wire(Commands.pushAck(0x0e))).toBe('040e07' + '0000' + 'c0bf');
  });
});

describe('R99 real · lo que contesta el anillo', () => {
  it('todas las tramas que llegaron pasan el CRC y se reconocen', () => {
    for (const [direction, hex] of R99_SYNC_EXCHANGE) {
      const frame = parseFrame(fromHex(hex));
      expect(frame, `${direction} ${hex}`).not.toBeNull();
      expect(frame?.crcOk, `${direction} ${hex}`).toBe(true);
    }
    for (const hex of Object.values(R99_LIVE_FRAMES)) expect(parseFrame(fromHex(hex))?.crcOk, hex).toBe(true);
  });

  it('el CRC del bloque terminal de cada historial es el del buffer reensamblado', () => {
    // `05 80`: [paquetes:u16][bytes:u16][crc16 del buffer:u16]. Es la verificación de integridad real de cada transferencia.
    expect(crc16(fromHex(R99_SPORT_HEX))).toBe(0x88d1);
    expect(crc16(fromHex(R99_HEART_HEX))).toBe(0x3dcd);
    expect(crc16(fromHex(R99_ALL_HEX))).toBe(0xfb32);
  });

  it('la información del dispositivo da firmware 2.32 y batería 100 %', () => {
    const reply = R99_SYNC_EXCHANGE.find(([direction, hex]) => direction === 'rx' && hex.startsWith('0200'));
    const frame = parseFrame(fromHex(reply?.[1] ?? ''));
    expect(parseDeviceInfo(frame?.payload ?? new Uint8Array())).toEqual({ firmware: '2.32', batteryPercent: 100 });
  });

  it('el historial de sueño vacío es una cabecera corta: «no hay nada», sin transferencia que confirmar', () => {
    const reply = R99_SYNC_EXCHANGE.find(([direction, hex]) => direction === 'rx' && hex.startsWith('0504'));
    const frame = parseFrame(fromHex(reply?.[1] ?? ''));
    expect(toHex(frame?.payload ?? [])).toBe(toHex(HEALTH_NO_DATA_PAYLOAD));
  });
});

describe('R99 real · registros', () => {
  it('actividad: un tramo de 30 min con 1.252 pasos, 846 m y 82 kcal (el anillo da la distancia en metros y las calorías en kcal)', () => {
    const [record, ...rest] = decodeSport(fromHex(R99_SPORT_HEX));
    expect(rest).toEqual([]);
    expect(record).toEqual({
      startMs: new Date(2026, 9, 12, 23, 0, 1).getTime(),
      endMs: new Date(2026, 9, 12, 23, 30, 1).getTime(),
      steps: 1252,
      distanceM: 846,
      calories: 82,
    });
    // 0,68 m por paso y 0,066 kcal por paso: la misma proporción que en las tramas en vivo (184 pasos → 123 m → 12 kcal).
    expect(846 / 1252).toBeCloseTo(0.676, 2);
  });

  it('pulso: 72 lpm a las 23:30:42 y 80 lpm a las 05:00:27 (la primera medida automática tras configurar el anillo)', () => {
    expect(decodeHeart(fromHex(R99_HEART_HEX))).toEqual([
      { tsMs: new Date(2026, 9, 12, 23, 30, 42).getTime(), bpm: 72 },
      { tsMs: new Date(2026, 9, 13, 5, 0, 27).getTime(), bpm: 80 },
    ]);
  });

  it('constantes: el contador del día (12.628 pasos al acabar el día, 0 a las 5 de la madrugada), pulso, oxígeno y respiración', () => {
    const records = decodeAll(fromHex(R99_ALL_HEX));
    expect(records).toEqual([
      { tsMs: new Date(2026, 9, 12, 23, 30, 42).getTime(), steps: 12_628, bpm: 72, spo2: 98, respiratoryRate: 14 },
      { tsMs: new Date(2026, 9, 13, 5, 0, 27).getTime(), steps: 0, bpm: 80, spo2: 98, respiratoryRate: 16 },
    ]);
  });
});

/** Un anillo que contesta con lo grabado: a cada orden le devuelve, en orden, las tramas que el real contestó a esa misma orden. */
class ReplayLink implements RingLink {
  readonly id = 'r99-real';
  readonly name = 'R99 F265';
  connected = true;
  readonly written: string[] = [];
  private readonly listeners = new Set<(channel: Channel, chunk: Uint8Array) => void>();
  private readonly script = new Map<string, string[][]>();

  constructor(exchange: ReadonlyArray<readonly ['tx' | 'rx', string]>) {
    let current: string[] = [];
    for (const [direction, hex] of exchange) {
      if (direction === 'tx') {
        current = [];
        const key = hex.slice(0, 4);
        this.script.set(key, [...(this.script.get(key) ?? []), current]);
      } else {
        current.push(hex);
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(toHex(data));
    const replies = this.script.get(toHex(data.subarray(0, 2)))?.shift() ?? [];
    for (const hex of replies) setTimeout(() => this.push(hex), 1);
  }

  /** Entrega una trama como si el anillo la mandara por su cuenta. */
  push(hex: string): void {
    const bytes = fromHex(hex);
    const channel: Channel = bytes[0] !== undefined && bytes[0] >= Group.devControl ? 'stream' : 'command';
    for (const listener of [...this.listeners]) listener(channel, bytes);
  }

  onData(listener: (channel: Channel, chunk: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(): () => void {
    return () => undefined;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

describe('R99 real · repetición de la primera sincronización', () => {
  it('con las respuestas grabadas, la sesión hace el mismo recorrido y entiende lo mismo que entendió el anillo real', async () => {
    const link = new ReplayLink(R99_SYNC_EXCHANGE);
    const log = new DiagnosticLog();
    // El anillo real no contestó a la consulta de oxígeno: con una espera corta la repetición acaba enseguida.
    const session = new YcbtSession(link, { log, timeouts: { reply: 500, header: 150, idle: 500, status: 500 } });

    const info = await session.open(new Date(2026, 9, 13, 5, 2, 6));
    expect(info).toMatchObject({ name: 'R99 F265', firmware: '2.32', batteryPercent: 100 });
    expect([...(info.capabilities ?? [])].sort()).toEqual(['bloodPressure', 'heartRate', 'manualBloodPressure', 'manualHeartRate', 'manualSpo2', 'sleep', 'spo2', 'steps']);

    await session.configure({ user: { heightCm: 180, weightKg: 102, male: true, age: 23 }, heartIntervalMin: 60, spo2IntervalMin: 60 });
    expect(await session.readLiveStatus()).toEqual({ steps: 0, distanceM: 0, calories: 0 });

    const result = await session.syncHistory();
    expect(result.interrupted).toBe(false);
    expect(result.outcomes.map((o) => [o.type, o.status, o.bytes, o.detail ?? ''])).toEqual([
      ['sport', 'ok', 14, '1 registro(s)'],
      ['sleep', 'empty', 0, ''],
      ['heart', 'ok', 12, '2 registro(s)'],
      ['all', 'ok', 40, '2 registro(s)'],
      ['spo2', 'timeout', 0, 'sin cabecera'],
    ]);
    expect(result.records.sport.map((r) => [r.steps, r.distanceM, r.calories])).toEqual([[1252, 846, 82]]);
    expect(result.records.heart.map((r) => r.bpm)).toEqual([72, 80]);
    expect(result.records.all.map((r) => [r.steps, r.bpm, r.spo2])).toEqual([[12_628, 72, 98], [0, 80, 98]]);
    expect(result.records.spo2).toEqual([]);

    // Se confirmó cada bloque recibido (y solo esos: ni el sueño vacío ni el oxígeno sin cabecera tienen nada que confirmar).
    expect(link.written.filter((hex) => hex === toHex(buildFrame(Group.health, HealthKey.terminal, [HealthKey.ackAccepted])))).toHaveLength(3);
    // Y se pidió lo mismo, en el mismo orden, que en la captura (menos lo que depende de la hora).
    const timeIndependent = (list: readonly string[]): string[] => list.filter((hex) => !hex.startsWith('0100'));
    expect(timeIndependent(link.written)).toEqual(timeIndependent(R99_SYNC_EXCHANGE.filter(([d]) => d === 'tx').map(([, hex]) => hex)));
    await session.close();
  });

  it('las tramas en vivo del entreno real se entienden: pasos, distancia y calorías, pulso y fin de medida (que se confirma)', async () => {
    const link = new ReplayLink([]);
    const session = new YcbtSession(link, { timeouts: { reply: 100 } });
    const events: LiveEvent[] = [];
    session.onLive((event) => events.push(event));

    link.push(R99_LIVE_FRAMES.stepsFirstCounted);
    link.push(R99_LIVE_FRAMES.stepsLast);
    link.push(R99_LIVE_FRAMES.heartRate76);
    link.push(R99_LIVE_FRAMES.measurementEndOk);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual([
      { kind: 'status', status: { steps: 11, distanceM: 7, calories: 1 } },
      { kind: 'status', status: { steps: 184, distanceM: 123, calories: 12 } },
      { kind: 'heartRate', bpm: 76 },
      { kind: 'measurementEnd', mode: 0, success: true },
    ]);
    // El anillo reenvía el fin de medida hasta que se confirma: la confirmación es la grabada.
    expect(link.written).toEqual(['040e0700' + '00c0bf']);
    await session.close();
  });

  it('las respuestas de otra app al apretón de manos (poner en hora, información) se anotan como «sin petición pendiente»', async () => {
    const link = new ReplayLink([]);
    const log = new DiagnosticLog();
    const session = new YcbtSession(link, { log });
    link.push(R99_LIVE_FRAMES.strayTimeReply);
    link.push(R99_LIVE_FRAMES.strayUnknownReply);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const text = log.toText();
    expect(text).toContain('respuesta sin petición pendiente: 1:0');
    expect(text).toContain('respuesta sin petición pendiente: 2:27');
    await session.close();
  });
});

describe('R99 real · segunda ronda, cotejada con lo que enseñó Smart Health', () => {
  it('constantes: pasos del día, pulso, presión 109/72 y SpO₂ 97 % en las posiciones documentadas (Smart Health enseñó 109/72 y 97 %)', () => {
    const buffer = fromHex(R99_ALL_0800_HEX);
    // La app solo usa pasos, pulso, oxígeno y respiración; la presión (sistólica @7, diastólica @8) no se decodifica, pero su
    // posición queda confirmada porque Smart Health enseñaba 109/72 del mismo registro.
    expect([u8(buffer, 7), u8(buffer, 8)]).toEqual([109, 72]);
    expect(decodeAll(buffer)).toEqual([{ tsMs: new Date(2026, 9, 13, 8, 0, 33).getTime(), steps: 1118, bpm: 96, spo2: 97, respiratoryRate: 20 }]);
  });

  it('pulso: la medida automática y un registro por cada ciclo del entreno; el último (89) es el que enseñó Smart Health', () => {
    const records = decodeHeart(fromHex(R99_HEART_0800_HEX));
    expect(records.map((r) => r.bpm)).toEqual([96, 101, 90, 90, 87, 89]);
    expect(records.map((r) => new Date(r.tsMs).toTimeString().slice(0, 8))).toEqual(['08:00:33', '08:09:43', '08:10:03', '08:10:21', '08:10:41', '08:11:01']);
  });

  it('actividad: el tramo de 30 min de las 06:00 con 588 pasos, 393 m y 38 kcal', () => {
    expect(decodeSport(fromHex(R99_SPORT_0600_HEX))).toEqual([
      { startMs: new Date(2026, 9, 13, 6, 0, 0).getTime(), endMs: new Date(2026, 9, 13, 6, 30, 0).getTime(), steps: 588, distanceM: 393, calories: 38 },
    ]);
  });

  it('pasos en directo: son los del DÍA (1.390), con la distancia en metros (929 = 0,929 km) y las kcal (92) que enseñó Smart Health', async () => {
    const link = new ReplayLink([]);
    const session = new YcbtSession(link, { timeouts: { reply: 100 } });
    const events: LiveEvent[] = [];
    session.onLive((event) => events.push(event));
    link.push(R99_LIVE_STEPS_1390);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([{ kind: 'status', status: { steps: 1390, distanceM: 929, calories: 92 } }]);
    await session.close();
  });

  it('«Medir ahora» con las lecturas y tiempos reales: descarta la meseta de 46-47 lpm, no hay veredicto y devuelve ≈ 94 como la app real', async () => {
    // Todo a escala 1/20: 45 s reales = 2,25 s. La espera máxima se fija entre dos lecturas (45,5 s reales) para que no dependa
    // de unos milisegundos.
    const SCALE = 20;
    const link = new ReplayLink([]);
    const original = link.write.bind(link);
    link.write = async (data: Uint8Array): Promise<void> => {
      await original(data);
      const frame = parseFrame(data);
      if (frame?.group === Group.appControl && frame.cmd === 0x2f) {
        setTimeout(() => link.push('032f070000ee99'), 1); // la respuesta real, la misma al empezar y al parar
        if (frame.payload[0] === 1) for (const [ms, hex] of R99_HEART_MEASURE_FRAMES) setTimeout(() => link.push(hex), ms / SCALE);
      }
    };
    const session = new YcbtSession(link, { timeouts: { reply: 200 }, hrWarmupMs: 28_000 / SCALE, hrStreamAfterMs: 60_000 / SCALE });
    const seen: number[] = [];
    const bpm = await session.measureHeartRate({ timeoutMs: 45_500 / SCALE, onSample: (value) => seen.push(value) });

    expect(seen.length).toBeGreaterThan(8);
    expect(seen.every((value) => value >= 80)).toBe(true); // ni una lectura de la meseta (46-47) llega a la persona
    expect([94, 95]).toContain(bpm); // la mediana de las tres últimas lecturas fiables (94, 95, 94 en la medida real)
    await session.close();
  });
});
