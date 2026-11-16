import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RingError } from '../ble/errors';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport, type SimBehavior } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { dayKeyOf } from '../domain/dates';
import { refreshLive } from './live-refresh';

const NOW = new Date(2026, 6, 10, 14, 30, 0).getTime();
const FAST = { reply: 300, header: 500, idle: 500, status: 500 };

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`live-${++counter}`);
  await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
});

const setup = (behavior: SimBehavior = {}) => {
  const dataset = buildDemoDataset({ nowMs: NOW, days: 3, seed: 21 });
  const transport = new SimulatedTransport(dataset, { chunkSize: 20, ...behavior });
  return { dataset, transport };
};

const today = dayKeyOf(NOW);
const countersOf = async (): Promise<number[]> => (await store.loadRange(today, today)).counters.map((c) => c.steps);

describe('refreshLive (la lectura ligera de la actualización automática)', () => {
  it('lee el contador de pasos, lo guarda con la hora de lectura y suelta el anillo', async () => {
    const { dataset, transport } = setup();
    const result = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, null);

    expect(result).toMatchObject({ steps: dataset.live.steps, atMs: NOW, changed: true, batteryPercent: 78 });
    const counters = (await store.loadRange(today, today)).counters;
    expect(counters).toEqual([{ tsMs: NOW, steps: dataset.live.steps }]);
    // Batería: ninguna conexión abierta ni el empuje de pasos encendido.
    expect(transport.lastRing?.connected).toBe(false);
    expect(transport.lastRing?.state.liveStatus).toBe(false);
  });

  it('no relee el historial, no toca lo guardado y no deja constancia en las sincronizaciones', async () => {
    const { transport } = setup();
    await store.ingest({ buckets: [{ startMs: NOW - 3_600_000, endMs: NOW - 3_000_000, steps: 400, ringDistanceM: 300, ringCalories: 20 }], counters: [], heart: [{ tsMs: NOW - 1_800_000, bpm: 70, source: 'ring-auto' }], spo2: [], sleep: [], dropped: {} });
    const before = await store.stats();

    await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, null);

    const after = await store.stats();
    expect(after.counts.buckets).toBe(before.counts.buckets);
    expect(after.counts.heart).toBe(before.counts.heart);
    expect(after.counts.counters).toBe((before.counts.counters ?? 0) + 1);
    expect(await store.listSyncs(10)).toEqual([]);
    // Solo habló lo imprescindible: nada de consultas de historial (grupo 05).
    const sent = transport.lastRing?.describeReceived() ?? [];
    expect(sent.filter((line) => line.startsWith('05:'))).toEqual([]);
    expect(sent.some((line) => line.startsWith('03:09 01'))).toBe(true); // pidió el empuje de pasos…
    expect(sent.some((line) => line.startsWith('03:09 00'))).toBe(true); // …y lo apagó
  });

  it('con los mismos pasos que la lectura anterior no guarda nada (una fila por minuto sentado no tiene sentido)', async () => {
    const { dataset, transport } = setup();
    const previous = { day: today, steps: dataset.live.steps, atMs: NOW - 60_000 };
    const result = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, previous);
    expect(result).toMatchObject({ steps: dataset.live.steps, changed: false });
    expect(await countersOf()).toEqual([]);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('con pasos distintos, o de otro día, sí guarda: es un punto más del contador', async () => {
    const { dataset, transport } = setup();
    const more = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, { day: today, steps: dataset.live.steps - 25, atMs: NOW - 60_000 });
    expect(more.changed).toBe(true);
    expect(await countersOf()).toEqual([dataset.live.steps]);

    // El contador del anillo vuelve a empezar a medianoche: aunque dé lo mismo que la víspera, es otro día.
    const { transport: other } = setup();
    const nextDay = await refreshLive({ transport: other, store, now: () => NOW + 60_000, timeouts: FAST }, { day: '2026-07-09', steps: dataset.live.steps, atMs: NOW - 86_400_000 });
    expect(nextDay.changed).toBe(true);
    expect(await countersOf()).toHaveLength(2);
  });

  it('sella el contador con la hora en que se pidió, no con la de después de esperar la respuesta: a medianoche no puede cambiar de día', async () => {
    const { dataset, transport } = setup({ liveFirstMs: 20 });
    // Las dos primeras horas que pide (al abrir y al pedir los pasos) son de antes de medianoche; las siguientes, de después.
    const before = new Date(2026, 6, 10, 23, 59, 59).getTime();
    const after = new Date(2026, 6, 11, 0, 0, 1).getTime();
    let calls = 0;
    const result = await refreshLive({ transport, store, now: () => (++calls <= 2 ? before : after), timeouts: { ...FAST, status: 500, reply: 500 } }, null);
    expect(result.atMs).toBe(before);
    const counters = (await store.loadRange('2026-07-10', '2026-07-11')).counters;
    expect(counters).toEqual([{ tsMs: before, steps: dataset.live.steps }]); // el de ayer sigue siendo de ayer
  });

  it('una subida de pasos imposible para el tiempo que pasó es ruido: no se guarda (se quedaría como el máximo del día)', async () => {
    const { dataset, transport } = setup();
    // La lectura anterior fue hace un minuto con 100 pasos menos de los que ahora dice el anillo… más de 260 pasos/min + 100.
    const result = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, { day: today, steps: dataset.live.steps - 5000, atMs: NOW - 60_000 });
    expect(result).toMatchObject({ steps: dataset.live.steps, changed: false, implausible: true });
    expect(await countersOf()).toEqual([]);
    expect(transport.lastRing?.connected).toBe(false);

    // La misma subida con la app oculta durante horas (la anterior es de hace 6 h) es andar: sí se guarda.
    const { transport: later } = setup();
    const ok = await refreshLive({ transport: later, store, now: () => NOW, timeouts: FAST }, { day: today, steps: dataset.live.steps - 5000, atMs: NOW - 6 * 3_600_000 });
    expect(ok).toMatchObject({ changed: true });
    expect(ok.implausible).toBeUndefined();
    expect(await countersOf()).toEqual([dataset.live.steps]);
  });

  it('a las 00:00:01 un total de ayer (el reloj del anillo va unos segundos atrás) es ruido: no se guarda como el de hoy', async () => {
    const { dataset, transport } = setup();
    const midnight = new Date(2026, 6, 11, 0, 0, 1).getTime();
    expect(dataset.live.steps).toBeGreaterThan(1000);
    const result = await refreshLive({ transport, store, now: () => midnight, timeouts: FAST }, null);
    expect(result).toMatchObject({ steps: dataset.live.steps, changed: false, implausible: true });
    expect((await store.loadRange('2026-07-11', '2026-07-11')).counters).toEqual([]);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('con el reloj atrasado entre dos lecturas no se puede juzgar el tiempo que pasó: la subida se cree', async () => {
    const { dataset, transport } = setup();
    const result = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, { day: today, steps: dataset.live.steps - 3000, atMs: NOW + 2 * 3_600_000 });
    expect(result).toMatchObject({ changed: true });
    expect(result.implausible).toBeUndefined();
    expect(await countersOf()).toEqual([dataset.live.steps]);
  });

  it('si el anillo no manda los pasos a tiempo, no inventa nada y también suelta el enlace', async () => {
    const { transport } = setup({ silentOn: ['03:09'] });
    const result = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, null);
    expect(result).toMatchObject({ steps: null, changed: false });
    expect(await countersOf()).toEqual([]);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('con el anillo fuera de alcance falla sin abrir nunca el selector del sistema', async () => {
    const { transport } = setup();
    transport.reachable = false;
    let picked = 0;
    const pick = transport.pickAndConnect.bind(transport);
    transport.pickAndConnect = (options) => (picked++, pick(options));
    await expect(refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, null)).rejects.toMatchObject({ code: 'connect-failed' });
    expect(picked).toBe(0);
    expect(transport.connections).toBe(0);
  });

  it('sin anillo vinculado no hay nada que leer', async () => {
    const { transport } = setup();
    await store.setRing(null);
    await expect(refreshLive({ transport, store, now: () => NOW, timeouts: FAST }, null)).rejects.toMatchObject({ code: 'no-device' });
    expect(transport.connections).toBe(0);
  });

  it('reconecta en silencio: un solo intento corto y cancelable (no los dos largos de una sincronización a mano)', async () => {
    const { transport } = setup();
    const asked: unknown[] = [];
    const reconnect = transport.reconnect.bind(transport);
    transport.reconnect = (saved, options) => (asked.push(options), reconnect(saved, options));
    const abort = new AbortController();
    await refreshLive({ transport, store, now: () => NOW, timeouts: FAST, signal: abort.signal }, null);
    expect(asked).toEqual([{ silent: true, attempts: 1, timeoutMs: 8000, signal: abort.signal }]);
  });

  it('cancelarla en mitad de la lectura suelta el anillo enseguida y no guarda nada', async () => {
    // El primer envío de pasos tarda lo que el anillo real (2,5 s): da tiempo a cancelar con el enlace ya abierto.
    const { transport } = setup({ liveFirstMs: 2500 });
    const abort = new AbortController();
    const running = refreshLive({ transport, store, now: () => NOW, timeouts: { ...FAST, status: 5000, reply: 5000 }, signal: abort.signal }, null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.lastRing?.connected).toBe(true);
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
    expect(transport.lastRing?.connected).toBe(false);
    expect(await countersOf()).toEqual([]);
  });

  it('cancelada antes de empezar (o durante la reconexión) no llega a abrir el enlace', async () => {
    const { transport } = setup();
    const abort = new AbortController();
    abort.abort();
    const error = await refreshLive({ transport, store, now: () => NOW, timeouts: FAST, signal: abort.signal }, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RingError);
    expect((error as RingError).code).toBe('aborted');
    expect(transport.connections).toBe(0);
  });

  it('ya con la cancelación pedida, un enlace que sí llegó a abrirse se suelta', async () => {
    const { transport } = setup();
    const abort = new AbortController();
    // Un transporte que ignora la señal y devuelve el enlace aun así (la cancelación llegó justo al terminar de conectar).
    const reconnect = transport.reconnect.bind(transport);
    transport.reconnect = async (saved) => {
      const link = await reconnect(saved);
      abort.abort();
      return link;
    };
    await expect(refreshLive({ transport, store, now: () => NOW, timeouts: FAST, signal: abort.signal }, null)).rejects.toMatchObject({ code: 'aborted' });
    expect(transport.lastRing?.connected).toBe(false);
  });
});
