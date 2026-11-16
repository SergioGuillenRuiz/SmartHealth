import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTransport } from '../ble/sim/ring';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SIM_SCALE_ID, SIM_SCALE_NAME, SimulatedScaleTransport, simScaleDecoder, type SimScaleFormat } from '../ble/scale/sim';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { decodeFrame } from '../domain/scale';
import { cancelPairing, finishPairing, forgetScale, learnWeight, loadScale, markScaleEmpty, resetScaleForTests, scaleReport, scaleWanted, scaleSaved, scaleState, scaleSupport, scanScales, startPairing, startScale, stopScale, stopScaleNow } from './scale';
import { installServices } from './services';
import { ringUse } from './state';

let counter = 0;
let store: IdbStore;
let sim: SimulatedScaleTransport;
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

async function setup(format: SimScaleFormat = 'be16'): Promise<void> {
  store = await openIdbStore(`scale-${++counter}`);
  sim = new SimulatedScaleTransport({ format });
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: Date.now(), days: 1, seed: 1 })), scale: sim, now: () => Date.now(), demo: true });
  scaleSaved.value = null;
  resetScaleForTests();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
  const stopping = stopScaleNow();
  await advance(500);
  await stopping;
  const cancelling = cancelPairing();
  await advance(500);
  await cancelling;
  vi.useRealTimers();
});

/** El emparejado entero con lo que haría una persona: buscar, elegir, vaciar, pesar 355 g y comprobar con 480 g. */
async function pair(): Promise<void> {
  const found = await (async () => {
    const searching = scanScales(3_000);
    await advance(100);
    return searching;
  })();
  expect(found.map((d) => d.id)).toContain(SIM_SCALE_ID);
  startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
  await advance(600);
  // Una báscula que manda el peso en su anuncio no se conecta: solo se la escucha.
  if (sim.format !== 'advert') expect(scaleState.value.status).toBe('live');
  expect(scaleState.value.frames).toBeGreaterThan(0);
  markScaleEmpty();
  await advance(300); // la persona tarda en poner algo encima
  sim.setWeight(355);
  await advance(2_500);
  const outcome = learnWeight(355);
  expect(outcome.best).not.toBeNull();
  await advance(50);
  sim.setWeight(480);
  await advance(1_200);
  expect(scaleState.value.reading).toMatchObject({ grams: 480, stable: true });
}

describe('emparejar la báscula aprendiendo su protocolo', () => {
  it.each<SimScaleFormat>(['be16', 'le10', 'ascii', 'advert'])('con el formato «%s» aprende el campo, lo ve en vivo y lo guarda', async (format) => {
    await setup(format);
    await pair();
    const saved = await finishPairing();
    expect(saved).toMatchObject({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    expect(scaleSaved.value).toEqual(saved);
    expect(await store.getScale()).toEqual(saved);
    // Lo aprendido decodifica igual que el decodificador de verdad de ese formato.
    const real = simScaleDecoder(format);
    expect(saved!.decoder.source).toBe(real.source);
    const frames = (await import('../ble/scale/sim')).encodeSimFrame;
    if (format !== 'advert') {
      for (const grams of [0, 5, 120, 355, 1_000, 4_999]) {
        const frame = { source: real.source, bytes: frames(format, grams, 3), atMs: 0 };
        expect(decodeFrame(saved!.decoder, frame), `${grams} g`).toBeCloseTo(grams, 5);
      }
    }
  });

  it('una pesada pequeña deja varios candidatos; una segunda pesada mayor corrige el campo', async () => {
    await setup();
    startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    await advance(600);
    sim.setWeight(90);
    await advance(2_500);
    const first = learnWeight(90);
    expect(first.total).toBeGreaterThan(1); // 90 g cabe en un byte o en dos
    await advance(50); // la persona tarda en cambiar el peso
    sim.setWeight(620);
    await advance(2_500);
    const second = learnWeight(620);
    expect(second.best).not.toBeNull();
    sim.setWeight(300);
    await advance(1_200);
    expect(scaleState.value.reading?.grams).toBe(300);
  });

  it('un número mal escrito no estropea el siguiente intento', async () => {
    await setup();
    startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    await advance(600);
    markScaleEmpty();
    await advance(300);
    sim.setWeight(355);
    await advance(2_500);
    expect(learnWeight(777).best).toBeNull(); // la pantalla marcaba 355
    expect(learnWeight(355).best).not.toBeNull();
  });

  it('sin tramas (una báscula muda) lo dice y no inventa un decodificador', async () => {
    await setup('silent');
    startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    await advance(600);
    const outcome = learnWeight(355);
    expect(outcome.best).toBeNull();
    expect(outcome.problem).toBe('no-frames');
    expect(await finishPairing()).toBeNull();
    expect(await store.getScale()).toBeNull();
  });

  it('cancelar el emparejado no guarda nada y suelta la báscula', async () => {
    await setup();
    startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    await advance(600);
    expect(sim.connectedCount()).toBe(1);
    const cancelling = cancelPairing();
    await advance(300);
    await cancelling;
    expect(sim.connectedCount()).toBe(0);
    expect(await store.getScale()).toBeNull();
  });
});

describe('usar la báscula emparejada', () => {
  it('se conecta al arrancar, da el peso, y se suelta pasado el margen al parar', async () => {
    await setup();
    await pair();
    await finishPairing();
    await stopScaleNow();
    await advance(300);
    expect(sim.connectedCount()).toBe(0);

    startScale();
    await advance(600);
    expect(scaleState.value.status).toBe('live');
    sim.setWeight(250);
    await advance(1_200);
    expect(scaleState.value.reading).toMatchObject({ grams: 250, stable: true });
    stopScale(5_000);
    await advance(2_000);
    expect(sim.connectedCount()).toBe(1); // aún en el margen
    startScale(); // vuelve a abrirse la hoja: cancela la parada
    await advance(5_000);
    expect(sim.connectedCount()).toBe(1);
    stopScale(1_000);
    await advance(1_500);
    expect(sim.connectedCount()).toBe(0);
  });

  it('se recuerda entre arranques y se puede olvidar', async () => {
    await setup();
    await pair();
    await finishPairing();
    scaleSaved.value = null;
    await loadScale();
    expect((scaleSaved.value as { id: string } | null)?.id).toBe(SIM_SCALE_ID);
    await forgetScale();
    expect(scaleSaved.value).toBeNull();
    expect(await store.getScale()).toBeNull();
  });

  it('sin báscula emparejada no se conecta a nada', async () => {
    await setup();
    startScale();
    await advance(1_000);
    expect(sim.connectedCount()).toBe(0);
    expect(scaleState.value.status).toBe('idle');
  });

  it('donde no hay Bluetooth para la báscula (un navegador) lo dice', async () => {
    store = await openIdbStore(`scale-${++counter}`);
    installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: Date.now(), days: 1, seed: 1 })), now: () => Date.now(), demo: false });
    expect(scaleSupport()).toEqual({ available: false, reason: 'La báscula solo funciona dentro de la app de Android.' });
    startScale(); // no hace nada ni falla
    expect(await scanScales(100)).toEqual([]);
  });
});

describe('informe de la báscula', () => {
  it('lleva el dispositivo, la tabla GATT, las tramas y lo aprendido', async () => {
    await setup();
    startPairing({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME });
    await advance(600);
    sim.setWeight(355);
    await advance(2_500);
    learnWeight(355);
    const text = await scaleReport();
    expect(text).toContain('INFORME DE LA BÁSCULA');
    expect(text).toContain(`${SIM_SCALE_NAME} · ${SIM_SCALE_ID}`);
    expect(text).toContain('0000ffe1-0000-1000-8000-00805f9b34fb  notify');
    expect(text).toContain('# n:ffe0/ffe1 · 7 bytes');
    expect(text).toContain('355 g');
  });
});

describe('el anillo manda sobre la báscula (el Bluetooth no atiende bien las dos a la vez)', () => {
  async function pairedAndIdle(): Promise<void> {
    await setup();
    await pair();
    await finishPairing();
    await stopScaleNow();
    await advance(300);
    expect(sim.connectedCount()).toBe(0);
    ringUse.value = null;
  }
  afterEach(() => {
    ringUse.value = null;
  });

  it('con el anillo en uso la báscula no se pone a buscar ni a conectar, y arranca sola al quedar libre', async () => {
    await pairedAndIdle();
    ringUse.value = 'sync';
    startScale();
    await advance(1_500);
    expect(sim.connectedCount()).toBe(0);
    expect(sim.watcherCount()).toBe(0);
    expect(scaleState.value.status).toBe('idle');
    expect(scaleWanted.value).toBe(true); // la persona la quiere: la actualización automática espera
    ringUse.value = null;
    await advance(800);
    expect(scaleState.value.status).toBe('live');
    expect(sim.connectedCount()).toBe(1);
  });

  it('si el anillo se reserva con la báscula conectada, se suelta en el acto y vuelve cuando el anillo termina', async () => {
    await pairedAndIdle();
    startScale();
    await advance(800);
    expect(sim.connectedCount()).toBe(1);
    ringUse.value = 'sync';
    await advance(300);
    expect(sim.connectedCount()).toBe(0);
    expect(sim.watcherCount()).toBe(0);
    await advance(5_000); // y se queda quieta mientras dure el uso del anillo
    expect(sim.connectedCount()).toBe(0);
    ringUse.value = null;
    await advance(800);
    expect(sim.connectedCount()).toBe(1);
  });

  it('si la persona ya no la quiere (se soltó), no vuelve cuando el anillo termina', async () => {
    await pairedAndIdle();
    startScale();
    await advance(800);
    ringUse.value = 'measure';
    await advance(300);
    await stopScaleNow();
    expect(scaleWanted.value).toBe(false);
    ringUse.value = null;
    await advance(1_500);
    expect(sim.connectedCount()).toBe(0);
    expect(scaleState.value.status).toBe('idle');
  });

  it('«la quiere» solo si hay una báscula emparejada que usar; al soltarla con margen deja de quererla', async () => {
    await setup();
    startScale();
    expect(scaleWanted.value).toBe(false); // sin báscula emparejada la actualización automática no tiene por qué esperar
    await pair();
    await finishPairing();
    startScale();
    expect(scaleWanted.value).toBe(true);
    stopScale(2_000);
    expect(scaleWanted.value).toBe(true); // aún en el margen
    await advance(2_500);
    expect(scaleWanted.value).toBe(false);
  });
});
