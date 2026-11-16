import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScaleDecoder } from '../../domain/scale';
import { ScaleSession } from './session';
import { SIM_SCALE_ID, SIM_SCALE_NAME, SimulatedScaleTransport, type SimScaleFormat } from './sim';

const DEVICE = { id: SIM_SCALE_ID, name: SIM_SCALE_NAME };
const be16Decoder: ScaleDecoder = { v: 1, source: 'n:ffe0/ffe1', length: 7, kind: 'uint', offset: 3, width: 2, little: false, divisor: 1, guard: [[0, 0xa5]], index: 0 };
const advertDecoder: ScaleDecoder = { v: 1, source: 'a:m:ffff', length: 11, kind: 'uint', offset: 8, width: 2, little: false, divisor: 1, guard: [[0, 0xaa]], index: 0 };

let sim: SimulatedScaleTransport;
let session: ScaleSession;

const setup = (format: SimScaleFormat = 'be16'): void => {
  sim = new SimulatedScaleTransport({ format });
  session = new ScaleSession(sim);
};
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  // Con los relojes falsos, parar espera a lo que esté en vuelo (una conexión de la báscula simulada): se avanza el tiempo a la vez.
  const stopping = session.stop();
  await vi.advanceTimersByTimeAsync(500);
  await stopping;
  vi.useRealTimers();
});

describe('ScaleSession con la báscula simulada', () => {
  it('se conecta, da el peso y lo da por estable cuando deja de cambiar', async () => {
    setup();
    session.setDecoder(be16Decoder);
    session.start(DEVICE);
    await advance(300);
    expect(session.state.status).toBe('live');
    sim.setWeight(355);
    await advance(200);
    expect(session.state.reading).toMatchObject({ grams: 355, stable: false });
    await advance(900);
    expect(session.state.reading).toMatchObject({ grams: 355, stable: true });
    sim.setWeight(420);
    await advance(150);
    expect(session.state.reading).toMatchObject({ grams: 420, stable: false });
  });

  it('conectada y sabiendo leer sus tramas deja de escuchar anuncios (batería) y los retoma al perderla', async () => {
    setup();
    session.setDecoder(be16Decoder);
    session.start(DEVICE);
    await advance(300);
    expect(session.state.status).toBe('live');
    expect(sim.watcherCount()).toBe(0);
    sim.setAwake(false);
    await advance(300);
    expect(sim.watcherCount()).toBe(1); // vigilando para saber cuándo despierta
    sim.setAwake(true);
    await advance(2_000);
    expect(session.state.status).toBe('live');
    expect(sim.watcherCount()).toBe(0);
  });

  it('mientras aún se aprende (sin decodificador) sigue escuchando los anuncios: podrían llevar el peso', async () => {
    setup();
    session.start(DEVICE);
    await advance(300);
    expect(session.state.status).toBe('live');
    expect(sim.watcherCount()).toBe(1);
  });

  it('sin decodificador solo guarda las tramas (lo que hace falta para aprender) y no da peso', async () => {
    setup();
    session.start(DEVICE);
    sim.setWeight(250);
    await advance(1_000);
    expect(session.state.status).toBe('live');
    expect(session.state.reading).toBeNull();
    expect(session.state.frames).toBeGreaterThan(5);
    expect(session.frames().length).toBeGreaterThan(5);
    expect(session.frames()[0]?.source).toBe('n:ffe0/ffe1');
    expect(session.subscribed()).toEqual(['0000ffe0-0000-1000-8000-00805f9b34fb/0000ffe1-0000-1000-8000-00805f9b34fb']);
    // Con el decodificador puesto después, lee lo que ya había recibido.
    session.setDecoder(be16Decoder);
    expect(session.state.reading?.grams).toBe(250);
  });

  it('si la báscula se duerme lo dice y quita la lectura; al despertar vuelve a conectar sola', async () => {
    setup();
    session.setDecoder(be16Decoder);
    session.start(DEVICE);
    await advance(300);
    sim.setWeight(100);
    await advance(300);
    expect(session.state.reading?.grams).toBe(100);
    sim.setAwake(false);
    await advance(300);
    expect(session.state).toMatchObject({ status: 'asleep', reading: null });
    expect(session.state.message).toMatch(/dormido/);
    sim.setAwake(true);
    await advance(2_000);
    expect(session.state.status).toBe('live');
    expect(sim.connectedCount()).toBe(1);
  });

  it('si está apagada al empezar pide encenderla y conecta en cuanto se ve', async () => {
    setup();
    sim.setAwake(false);
    session.setDecoder(be16Decoder);
    session.start(DEVICE);
    await advance(500);
    expect(session.state).toMatchObject({ status: 'asleep' });
    expect(session.state.message).toMatch(/Enciende la báscula/);
    sim.setWeight(80); // al poner algo encima despierta
    await advance(1_500);
    expect(session.state.status).toBe('live');
    expect(session.state.reading?.grams).toBe(80);
  });

  it('una báscula que manda el peso en el anuncio no se conecta: lee los anuncios y se da por dormida si dejan de llegar', async () => {
    setup('advert');
    session.setDecoder(advertDecoder);
    session.start(DEVICE);
    sim.setWeight(333);
    await advance(1_500);
    expect(session.state).toMatchObject({ status: 'live' });
    expect(session.state.reading).toMatchObject({ grams: 333, stable: true });
    expect(sim.connectedCount()).toBe(0);
    sim.setAwake(false);
    await advance(7_500);
    expect(session.state).toMatchObject({ status: 'asleep', reading: null });
  });

  it('tras varios intentos viendo la báscula y sin poder conectar, avisa de lo probable: otra app la tiene cogida', async () => {
    setup('advert'); // se ve (anuncia) pero no admite conexión
    session.start(DEVICE);
    await advance(20_000);
    expect(session.state.status).toBe('asleep');
    expect(session.state.message).toMatch(/app de RENPHO/);
  });

  it('parar cierra la conexión y deja todo en reposo', async () => {
    setup();
    session.setDecoder(be16Decoder);
    session.start(DEVICE);
    await advance(300);
    expect(sim.connectedCount()).toBe(1);
    await session.stop();
    expect(sim.connectedCount()).toBe(0);
    expect(session.state).toMatchObject({ status: 'idle', reading: null });
    // Se puede volver a arrancar.
    session.start(DEVICE);
    await advance(300);
    expect(session.state.status).toBe('live');
  });

  it('las tramas guardadas tienen un tope', async () => {
    setup();
    session.start(DEVICE);
    sim.setWeight(10);
    await advance(400_000); // 4000 tramas a 10 por segundo
    expect(session.frames().length).toBeLessThanOrEqual(3_000);
    expect(session.frames().length).toBeGreaterThan(2_000);
  });
});
