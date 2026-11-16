import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../ble/bytes';
import { buildFrame } from '../ble/frame';
import { r99Timeline } from '../ble/r99-timeline.test-support';
import { buildDemoDataset, type SimDataset } from '../ble/sim/dataset';
import { SimulatedRing, SimulatedTransport, type SimBehavior } from '../ble/sim/ring';
import type { ChunkMeta, RingLink, RingTransport } from '../ble/transport';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import type { ResolvedProfile } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import type { NativeTracker } from './tracker';
import { fakeTracker, type FakeTrackerOptions } from './tracker.test-support';
import { WorkoutController, type FinishMeta, type LiveWorkoutState, type WakeInfo, type WorkoutDeps, type WorkoutPlatform } from './workout-controller';

const NOW = new Date(2026, 6, 10, 18, 0, 0).getTime();
const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`wk-${++counter}`);
});
afterEach(() => vi.useRealTimers());

function fakePlatform() {
  const watchers = new Map<number, { ok: PositionCallback; err: PositionErrorCallback | null | undefined }>();
  let next = 1;
  const lock = { release: vi.fn(async () => undefined), released: false };
  let visibleCallback: (() => void) | null = null;
  const stopVisible = vi.fn(() => {
    visibleCallback = null;
  });
  let hiddenCallback: (() => void) | null = null;
  const stopHidden = vi.fn(() => {
    hiddenCallback = null;
  });
  let wakeCallback: ((wake?: WakeInfo) => void) | null = null;
  const stopWake = vi.fn(() => {
    wakeCallback = null;
  });
  const platform: WorkoutPlatform = {
    onWake: (cb) => {
      wakeCallback = cb;
      return stopWake;
    },
    onVisible: (cb) => {
      visibleCallback = cb;
      return stopVisible;
    },
    onHidden: (cb) => {
      hiddenCallback = cb;
      return stopHidden;
    },
    geolocation: {
      watchPosition: (ok, err) => {
        watchers.set(next, { ok, err });
        return next++;
      },
      clearWatch: (id) => void watchers.delete(id),
    },
    wakeLock: { request: vi.fn(async () => lock) },
  };
  const push = (lat: number, tsMs: number, accuracy = 5, lon = -3): void => {
    for (const w of watchers.values()) {
      w.ok({ coords: { latitude: lat, longitude: lon, accuracy } as GeolocationCoordinates, timestamp: tsMs } as GeolocationPosition);
    }
  };
  return {
    platform,
    watchers,
    lock,
    push,
    stopVisible,
    stopHidden,
    stopWake,
    becomeVisible: () => visibleCallback?.(),
    becomeHidden: () => hiddenCallback?.(),
    wake: (info?: WakeInfo) => wakeCallback?.(info),
    isWatchingWake: () => wakeCallback !== null,
  };
}

function setup(behavior: SimBehavior = {}, platformOverride?: WorkoutPlatform, extra: { tracker?: NativeTracker; deps?: Partial<WorkoutDeps> } = {}) {
  const transport = new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80, 90, 100, 110, 120], hrIntervalMs: 4, liveIntervalMs: 6, ...behavior });
  const states: Array<LiveWorkoutState | null> = [];
  const finished: WorkoutRecord[] = [];
  const fake = fakePlatform();
  const controller = new WorkoutController({
    transport,
    store,
    now: () => Date.now(),
    platform: platformOverride ?? (extra.tracker ? { ...fake.platform, tracker: extra.tracker } : fake.platform),
    getProfile: () => profile,
    onState: (s) => states.push(s),
    onFinished: (r) => finished.push(r),
    tickMs: 20,
    reconnectEveryMs: 20,
    sessionTimeouts: { reply: 200, header: 300, idle: 300 },
    // Sin calentamiento del sensor: el anillo simulado entrega el pulso de inmediato.
    hrWarmupMs: 0,
    hrStreamAfterMs: 0,
    ...extra.deps,
  });
  return { controller, transport, states, finished, fake };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WorkoutController', () => {
  it('arranca con el anillo: mide el pulso, deja la pantalla encendida y al terminar suelta TODO', async () => {
    const { controller, transport, finished, states, fake } = setup();
    await controller.start('gym', { gps: false });
    await wait(80);
    const last = states.at(-1);
    expect(last?.phase).toBe('live');
    expect(last?.snapshot?.maxBpm).toBeGreaterThanOrEqual(110);
    expect(transport.lastRing?.state.measuring).toBe(0); // medida de FC en marcha
    expect(fake.platform.wakeLock?.request).toHaveBeenCalledWith('screen');

    await controller.finish();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ sport: 'gym', source: 'live' });
    expect(finished[0]?.hr?.length).toBeGreaterThan(0);
    // Batería del anillo: sensor apagado y conexión cerrada.
    expect(transport.lastRing?.state.measuring).toBeNull();
    expect(transport.lastRing?.connected).toBe(false);
    expect(fake.lock.release).toHaveBeenCalled();
    expect(states.at(-1)).toBeNull();
    expect(controller.isActive).toBe(false);
  });

  it('si el anillo rechaza la medida de pulso, el entreno sigue sin ella, avisa y no deja nada encendido', async () => {
    const { controller, transport, states, finished } = setup({ refuseModes: [0] });
    await controller.start('gym', { gps: false });
    await wait(60);
    expect(transport.lastRing?.state.measuring).toBeNull(); // el sensor no llegó a encenderse
    const last = states.at(-1);
    expect(last?.phase).toBe('live');
    expect(last?.features).toEqual({ heartRate: false, steps: false });
    expect(last?.warnings.join(' ')).toMatch(/rechazado la medida de pulso/);
    expect(last?.snapshot?.bpm).toBeNull();
    await controller.finish();
    expect(finished[0]?.hr?.length ?? 0).toBe(0);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('a pie, con el pulso rechazado, siguen los pasos en directo', async () => {
    const { controller, transport, states } = setup({ refuseModes: [0] });
    await controller.start('walk', { gps: false });
    await wait(60);
    expect(transport.lastRing?.state.liveStatus).toBe(true);
    expect(states.at(-1)?.features).toEqual({ heartRate: false, steps: true });
    await controller.discard();
  });

  it('si el navegador suelta el bloqueo de pantalla al cambiar de app, lo recupera al volver y deja de vigilar al terminar', async () => {
    const { controller, fake } = setup();
    await controller.start('gym', { gps: false });
    expect(fake.platform.wakeLock?.request).toHaveBeenCalledTimes(1);

    fake.becomeVisible(); // el bloqueo sigue vigente: no se pide otro
    await wait(5);
    expect(fake.platform.wakeLock?.request).toHaveBeenCalledTimes(1);

    fake.lock.released = true; // el navegador lo soltó al ocultarse la página
    fake.becomeVisible();
    await wait(5);
    expect(fake.platform.wakeLock?.request).toHaveBeenCalledTimes(2);

    await controller.discard();
    expect(fake.stopVisible).toHaveBeenCalled();
  });

  it('en deportes a pie activa los pasos en directo y los cuenta desde el inicio', async () => {
    const { controller, transport, states } = setup();
    await controller.start('walk', { gps: false });
    expect(transport.lastRing?.state.liveStatus).toBe(true);
    // Los pasos del día suben desde la primera lectura: la distancia sale de los pasos nuevos.
    const dataset = transport.lastRing!.dataset;
    await wait(40);
    for (let i = 0; i < 20; i++) {
      dataset.live.steps += 25; // un ritmo creíble: el contador no salta cientos de pasos de golpe
      await wait(10);
    }
    await wait(30);
    const snap = states.at(-1)?.snapshot;
    expect(snap?.steps).toBeGreaterThanOrEqual(400);
    expect(snap?.distanceSource).toBe('steps');
    await controller.discard();
  });

  it('con GPS acumula la distancia y al terminar queda en el registro', async () => {
    const { controller, finished, fake } = setup();
    await controller.start('cycle', { gps: true });
    const t = Date.now();
    for (let i = 0; i < 30; i++) fake.push(40 + (i * 60) / 111_195, t + i * 8000);
    await controller.finish();
    expect(finished[0]?.distanceSource).toBe('gps');
    expect(finished[0]?.distanceM).toBeGreaterThan(1700);
    expect(fake.watchers.size).toBe(0); // se dejó de escuchar el GPS
  });

  it('si el usuario deniega el GPS el entreno sigue y avisa', async () => {
    const { controller, states, fake } = setup();
    await controller.start('run', { gps: true });
    for (const w of fake.watchers.values()) w.err?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/permiso de ubicación/);
    expect(states.at(-1)?.phase).toBe('live');
    await controller.discard();
  });

  it('sin API de ubicación avisa y continúa', async () => {
    const { controller, states } = setup({}, { geolocation: null, wakeLock: null });
    await controller.start('run', { gps: true });
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/ubicación/);
    await controller.discard();
  });

  it('si se pierde el anillo marca la desconexión y reconecta solo cuando puede', async () => {
    const { controller, transport, states } = setup();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    const first = transport.lastRing!;
    first.simulateLinkLoss();
    await wait(40);
    // El simulador sí permite reconectar sin selector: vuelve a conectar y retoma la medida.
    await wait(120);
    expect(transport.lastRing).not.toBe(first);
    expect(states.at(-1)?.ringLost).toBe(false);
    expect(states.at(-1)?.snapshot?.ringConnected).toBe(true);
    expect(transport.lastRing?.state.measuring).toBe(0);
    await controller.discard();
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('si no se puede conectar, el error sube y no queda nada a medias', async () => {
    const { controller, states } = setup({ silentOn: ['02:03'] });
    await expect(controller.start('gym', { gps: false })).rejects.toBeTruthy();
    expect(controller.isActive).toBe(false);
    expect(states.at(-1)).toBeNull();
  });

  it('en pausa suelta la pantalla y no la vuelve a forzar al volver a la app; al reanudar la pide otra vez', async () => {
    const { controller, fake } = setup();
    await controller.start('gym', { gps: false });
    const request = fake.platform.wakeLock?.request as ReturnType<typeof vi.fn>;
    expect(request).toHaveBeenCalledTimes(1);

    controller.pause();
    await wait(5);
    expect(fake.lock.release).toHaveBeenCalledTimes(1);
    fake.becomeVisible(); // cambiar de app y volver con el entreno en pausa: la pantalla sigue libre
    await wait(5);
    expect(request).toHaveBeenCalledTimes(1);

    controller.resume();
    await wait(5);
    expect(request).toHaveBeenCalledTimes(2);
    await controller.discard();
    expect(fake.lock.release).toHaveBeenCalledTimes(2); // y al terminar suelta la de después de reanudar
  });

  it('si se pone en pausa mientras se pedía la pantalla, el bloqueo que llega no se queda sin dueño', async () => {
    const { controller, fake } = setup();
    let grant!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<typeof fake.lock>((resolve) => {
          grant = () => resolve(fake.lock);
        }),
    );
    (fake.platform as { wakeLock: unknown }).wakeLock = { request: slow };
    const starting = controller.start('gym', { gps: false });
    await wait(20);
    controller.pause();
    grant(); // el sistema concede la pantalla cuando ya está en pausa
    await starting;
    await wait(5);
    expect(fake.lock.release).toHaveBeenCalledTimes(1);
    await controller.discard();
  });

  it('pausa y reanuda sin perder la conexión', async () => {
    const { controller, states } = setup();
    await controller.start('gym', { gps: false });
    controller.pause();
    expect(states.at(-1)?.snapshot?.status).toBe('paused');
    controller.resume();
    expect(states.at(-1)?.snapshot?.status).toBe('running');
    await controller.discard();
  });
});

// ───────────────────────────── cancelación, enlaces huérfanos y reserva del anillo ─────────────────────────────

/** Transporte de pruebas que recuerda TODOS los anillos que abrió y puede retener la conexión hasta que se abra `gate`. */
class TrackingTransport implements RingTransport {
  readonly kind = 'simulator' as const;
  readonly available = true;
  readonly rings: SimulatedRing[] = [];
  gate: Promise<void> | null = null;
  constructor(
    private readonly dataset: SimDataset,
    private readonly behavior: SimBehavior = {},
  ) {}
  private async make(): Promise<RingLink> {
    if (this.gate) await this.gate;
    const ring = new SimulatedRing(this.dataset, this.behavior);
    this.rings.push(ring);
    return ring;
  }
  pickAndConnect(): Promise<RingLink> {
    return this.make();
  }
  reconnect(): Promise<RingLink | null> {
    return this.make();
  }
}

/** El primer anillo conecta; las reconexiones fallan (anillo fuera de alcance) y quedan apuntadas con su hora y sus opciones. */
/** La reconexión por la dirección guardada «no encuentra» el anillo (tras esperar a `gate`) y cuenta las veces que se abre el selector. */
class NotFoundTransport extends TrackingTransport {
  picks = 0;
  override async reconnect(): Promise<RingLink | null> {
    if (this.gate) await this.gate;
    return null;
  }
  override pickAndConnect(): Promise<RingLink> {
    this.picks++;
    return super.pickAndConnect();
  }
}

class OutOfRangeTransport extends TrackingTransport {
  readonly attempts: Array<{ at: number; options: unknown }> = [];
  override reconnect(_saved?: unknown, options?: unknown): Promise<RingLink | null> {
    this.attempts.push({ at: Date.now(), options });
    return Promise.resolve(null);
  }
}

/** El primer anillo conecta; cada reconexión posterior «conecta» pero el enlace se cae al instante, a mitad del apretón de manos (un anillo al borde del alcance). */
class FlappingTransport extends TrackingTransport {
  readonly attempts: Array<{ at: number; options: unknown }> = [];
  private calls = 0;
  override async reconnect(_saved?: unknown, options?: unknown): Promise<RingLink | null> {
    const link = await super.reconnect();
    if (++this.calls > 1) {
      this.attempts.push({ at: Date.now(), options });
      const ring = this.rings.at(-1);
      setTimeout(() => ring?.simulateLinkLoss(), 1);
    }
    return link;
  }
}

function build(behavior: SimBehavior = {}, overrides: Partial<WorkoutDeps> = {}) {
  const transport = new TrackingTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80, 90, 100], hrIntervalMs: 4, liveIntervalMs: 6, ...behavior });
  const states: Array<LiveWorkoutState | null> = [];
  const claims = { held: false, taken: 0, denied: 0 };
  const fake = fakePlatform();
  const controller = new WorkoutController({
    transport,
    store,
    now: () => Date.now(),
    platform: fake.platform,
    getProfile: () => profile,
    claimRing: () => {
      if (claims.held) {
        claims.denied++;
        return null;
      }
      claims.held = true;
      claims.taken++;
      return () => {
        claims.held = false;
      };
    },
    onState: (state) => states.push(state),
    onFinished: () => undefined,
    tickMs: 20,
    draftEveryMs: 25,
    reconnectEveryMs: 20,
    sessionTimeouts: { reply: 200, header: 300, idle: 300 },
    hrWarmupMs: 0,
    hrStreamAfterMs: 0,
    ...overrides,
  });
  const gate = (): (() => void) => {
    let open!: () => void;
    transport.gate = new Promise<void>((resolve) => (open = resolve));
    return () => {
      transport.gate = null;
      open();
    };
  };
  return { controller, transport, states, claims, fake, gate };
}

describe('WorkoutController: cancelación y enlaces huérfanos', () => {
  it('si el apretón de manos falla, el enlace se cierra: el anillo no se queda conectado', async () => {
    const { controller, transport, claims } = build({ silentOn: ['02:03'] });
    await expect(controller.start('gym', { gps: false })).rejects.toBeTruthy();
    expect(transport.rings).toHaveLength(1);
    expect(transport.rings[0]?.connected).toBe(false);
    expect(claims.held).toBe(false);
  });

  it('cancelar mientras se conecta no arranca el entreno después ni deja el enlace abierto', async () => {
    const { controller, transport, states, claims, gate } = build();
    const open = gate();
    const starting = controller.start('gym', { gps: false });
    await wait(10);
    expect(states.at(-1)?.phase).toBe('connecting');

    await controller.discard();
    expect(states.at(-1)).toBeNull();
    expect(claims.held).toBe(true); // la conexión en vuelo todavía puede llegar: el anillo sigue reservado

    open();
    await starting; // termina sin error
    await wait(30);
    expect(transport.rings[0]?.connected).toBe(false);
    expect(states.at(-1)).toBeNull(); // ningún estado fantasma
    expect(states.filter((s) => s?.phase === 'live')).toEqual([]);
    expect(controller.isActive).toBe(false);
    expect(claims.held).toBe(false);
  });

  it('cancelar durante el apretón de manos cierra el enlace y no enciende el pulso', async () => {
    const { controller, transport, states, claims } = build({ latencyMs: 40 });
    const starting = controller.start('gym', { gps: false });
    await wait(70);
    await controller.discard();
    await starting;
    await wait(50);
    expect(transport.rings[0]?.connected).toBe(false);
    expect(transport.rings[0]?.state.measuring).toBeNull();
    expect(states.at(-1)).toBeNull();
    expect(claims.held).toBe(false);
  });

  it('terminar con una reconexión en vuelo cierra el enlace que llega tarde y no deja un estado fantasma', async () => {
    const { controller, transport, states, claims, gate } = build();
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    const open = gate(); // las siguientes conexiones se quedan esperando
    transport.rings[0]?.simulateLinkLoss();
    await wait(60); // la reconexión automática ya está en vuelo
    await controller.finish();
    const seen = states.length;
    expect(states.at(-1)).toBeNull();

    open();
    await wait(80);
    expect(transport.rings.length).toBeGreaterThan(1);
    expect(transport.rings.every((r) => !r.connected)).toBe(true);
    expect(states).toHaveLength(seen); // nada se emitió después de terminar
    expect(controller.isActive).toBe(false);
    expect(claims.held).toBe(false);
  });

  it('terminar libera la pantalla al instante; la reserva del anillo dura hasta que está suelto', async () => {
    const { controller, claims, states } = build();
    await controller.start('gym', { gps: false });
    expect(claims.held).toBe(true);
    const finishing = controller.finish();
    expect(states.at(-1)).toBeNull(); // el panel ya se puede repintar
    expect(claims.held).toBe(true); // pero el anillo aún se está soltando
    await finishing;
    expect(claims.held).toBe(false);
  });

  it('tras cancelar mientras conecta, un nuevo intento llega a pedir el anillo (que avisa) en vez de no hacer nada en silencio', async () => {
    const { controller, transport, claims, states, gate } = build();
    const open = gate(); // la primera conexión se queda esperando (anillo apagado o fuera de alcance)
    const first = controller.start('gym', { gps: false });
    await wait(10);
    await controller.discard();
    expect(controller.isActive).toBe(false); // lo cancelado ya no es un entrenamiento en curso
    expect(claims.held).toBe(true); // pero el intento anterior aún no ha soltado el anillo

    await controller.start('walk', { gps: false });
    expect(claims.denied).toBe(1); // el nuevo intento llamó a reservar el anillo: quien reserva es quien avisa
    expect(controller.isActive).toBe(false);
    expect(transport.rings).toHaveLength(0);

    open();
    await first;
    await wait(30);
    expect(transport.rings[0]?.connected).toBe(false);
    expect(claims.held).toBe(false);
    // Ya suelto, un nuevo intento funciona.
    await controller.start('walk', { gps: false });
    expect(states.at(-1)?.phase).toBe('live');
    await controller.discard();
  });

  it('dos toques seguidos en «Iniciar» mientras conecta no reservan el anillo dos veces ni avisan', async () => {
    const { controller, claims, gate } = build();
    const open = gate();
    const first = controller.start('gym', { gps: false });
    await wait(10);
    await controller.start('gym', { gps: false }); // el primero sigue en marcha: este es un no-op legítimo
    expect(claims.denied).toBe(0);
    expect(claims.taken).toBe(1);
    open();
    await first;
    await controller.discard();
  });

  it('si el anillo ya lo usa otra cosa, el entreno no arranca ni toca el Bluetooth', async () => {
    const { controller, transport, claims, states } = build();
    claims.held = true;
    await controller.start('gym', { gps: false });
    expect(controller.isActive).toBe(false);
    expect(transport.rings).toHaveLength(0);
    expect(states).toEqual([]);
  });
});

describe('WorkoutController: traza para el diagnóstico', () => {
  it('al terminar entrega la traza BLE completa del entreno, con el anillo ya suelto', async () => {
    const texts: string[] = [];
    const { controller, transport } = build({}, { onDiagnostic: (text) => texts.push(text) });
    await controller.start('gym', { gps: false });
    await wait(40);
    expect(texts).toEqual([]); // mientras dura no se entrega nada
    await controller.finish();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('entreno: gym');
    expect(texts[0]).toMatch(/\btx\s+03 2f 08 00 01 00/); // pidió la medida de pulso
    expect(texts[0]).toMatch(/\brx\b/);
    expect(transport.rings[0]?.connected).toBe(false);
  });

  it('también deja traza si el entreno no llega a arrancar, con el motivo', async () => {
    const texts: string[] = [];
    const { controller } = build({ silentOn: ['02:03'] }, { onDiagnostic: (text) => texts.push(text) });
    await expect(controller.start('gym', { gps: false })).rejects.toBeTruthy();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('error al empezar');
  });

  it('una pérdida de enlace y la reconexión quedan anotadas', async () => {
    const texts: string[] = [];
    const { controller, transport } = build({}, { onDiagnostic: (text) => texts.push(text) });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    transport.rings[0]?.simulateLinkLoss();
    await wait(120);
    await controller.finish();
    expect(texts[0]).toContain('se perdió la conexión con el anillo');
    expect(texts[0]).toMatch(/reconectado solo/);
  });
});

describe('WorkoutController: borrador por si la app se cierra', () => {
  it('al ocultarse la página se guarda el borrador al momento, sin esperar al intervalo; terminar deja de vigilarlo', async () => {
    const { controller, fake } = build({}, { draftEveryMs: 60_000 });
    await controller.start('gym', { gps: false });
    expect(await store.getWorkoutDraft()).toBeNull();
    fake.becomeHidden(); // cambiar de app: el navegador va a estrangular los temporizadores
    await wait(30);
    expect(await store.getWorkoutDraft()).toMatchObject({ sport: 'gym', source: 'live' });

    await controller.discard();
    expect(fake.stopHidden).toHaveBeenCalled();
    await store.setWorkoutDraft(null);
    fake.becomeHidden(); // ya no hay entrenamiento: no debe resucitar un borrador
    await wait(30);
    expect(await store.getWorkoutDraft()).toBeNull();
  });

  it('mientras dura el entreno se guarda un borrador cada poco; descartar lo borra', async () => {
    const { controller } = build();
    await controller.start('gym', { gps: false });
    expect(await store.getWorkoutDraft()).toBeNull(); // aún no ha pasado el primer intervalo
    await wait(90);
    const draft = await store.getWorkoutDraft();
    expect(draft).toMatchObject({ sport: 'gym', source: 'live' });
    expect(draft?.endMs).toBeGreaterThan(draft?.startMs ?? Infinity);
    await controller.discard();
    await wait(60);
    expect(await store.getWorkoutDraft()).toBeNull();
  });

  it('al terminar, el borrador pasa a ser el entrenamiento terminado hasta que se revise (por si se cierra antes)', async () => {
    const { controller } = build();
    await controller.start('gym', { gps: false });
    await wait(60);
    await controller.finish();
    await wait(30);
    const draft = await store.getWorkoutDraft();
    expect(draft).toMatchObject({ sport: 'gym' });
    expect(draft?.pausedMs).toBe(0);
  });

  it('el temporizador del borrador se para al terminar (no sigue escribiendo)', async () => {
    const { controller } = build();
    await controller.start('gym', { gps: false });
    await wait(60);
    await controller.discard();
    await wait(40);
    await store.setWorkoutDraft(null);
    await wait(100); // varios intervalos más
    expect(await store.getWorkoutDraft()).toBeNull();
  });
});

describe('WorkoutController: reconexión automática con el anillo fuera de alcance', () => {
  const lose = async (reconnectEveryMs: number, Transport: typeof OutOfRangeTransport | typeof FlappingTransport = OutOfRangeTransport, behavior: SimBehavior = {}) => {
    const transport = new Transport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80, 90], hrIntervalMs: 4, liveIntervalMs: 6, ...behavior });
    const fake = fakePlatform();
    const controller = new WorkoutController({
      transport,
      store,
      now: () => Date.now(),
      platform: fake.platform,
      getProfile: () => profile,
      onState: () => undefined,
      onFinished: () => undefined,
      tickMs: 50,
      reconnectEveryMs,
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      hrWarmupMs: 0,
      hrStreamAfterMs: 0,
    });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    transport.attempts.length = 0; // el primero lo hizo el propio arranque (con el anillo ya guardado): aquí cuentan los de después
    transport.rings[0]?.simulateLinkLoss();
    return { controller, transport };
  };

  it('los intentos son silenciosos: sin avisos del sistema (el del Bluetooth apagado saldría cada pocos segundos sobre el entreno)', async () => {
    const { controller, transport } = await lose(10);
    await wait(80);
    expect(transport.attempts.length).toBeGreaterThan(0);
    expect(transport.attempts.every((a) => (a.options as { silent?: boolean }).silent === true)).toBe(true);
    await controller.discard();
  });

  it('cada intento fallido espera más que el anterior: no se queda «iniciando conexión» todo el entreno', async () => {
    const { controller, transport } = await lose(15);
    await wait(700);
    await controller.discard();
    const at = transport.attempts.map((a) => a.at);
    // Con un intervalo fijo de 15 ms habría ~45 intentos en 700 ms; con el retroceso (15, 30, 60, 120, 240…) son unos 6.
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(at.length).toBeLessThanOrEqual(10);
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    expect(gaps.at(-1) ?? 0, `esperas entre intentos: ${gaps.join(', ')} ms`).toBeGreaterThan((gaps[0] ?? 0) * 2);
  });

  it('también crece la espera si el enlace se cae a mitad del apretón de manos (un anillo al borde del alcance): no hay un intento cada pocos segundos todo el entreno', async () => {
    // Con 5 ms por respuesta el apretón de manos dura bastante más que el milisegundo que tarda en caerse el enlace.
    const { controller, transport } = await lose(15, FlappingTransport, { latencyMs: 5 });
    await wait(700);
    await controller.discard();
    const at = transport.attempts.map((a) => a.at);
    // Reiniciar la espera en cada caída dejaba un intento cada ~15 ms (decenas en 700 ms); con el retroceso son unos 6.
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(at.length, `intentos a las ${at.map((t) => t - (at[0] ?? 0)).join(', ')} ms`).toBeLessThanOrEqual(10);
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    expect(gaps.at(-1) ?? 0, `esperas entre intentos: ${gaps.join(', ')} ms`).toBeGreaterThan((gaps[0] ?? 0) * 2);
  });

  it('al terminar el entreno no quedan intentos pendientes', async () => {
    const { controller, transport } = await lose(10);
    await wait(40);
    await controller.discard();
    const before = transport.attempts.length;
    await wait(120);
    expect(transport.attempts).toHaveLength(before);
  });
});

describe('WorkoutController: con la app oculta los temporizadores se espacian', () => {
  it('oye el aviso de despertar solo mientras dura el entreno', async () => {
    const { controller, fake } = setup();
    expect(fake.isWatchingWake()).toBe(false);
    await controller.start('gym', { gps: false });
    expect(fake.isWatchingWake()).toBe(true);
    await controller.finish();
    expect(fake.stopWake).toHaveBeenCalledTimes(1);
    expect(fake.isWatchingWake()).toBe(false);
  });

  it('el aviso adelanta el intento de reconexión que ya tocaba aunque su temporizador no haya corrido', async () => {
    let clock = 1_000_000;
    const transport = new OutOfRangeTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80, 90], hrIntervalMs: 4, liveIntervalMs: 6 });
    const fake = fakePlatform();
    const controller = new WorkoutController({
      transport,
      store,
      now: () => clock,
      platform: fake.platform,
      getProfile: () => profile,
      onState: () => undefined,
      onFinished: () => undefined,
      tickMs: 50,
      reconnectEveryMs: 60_000, // el temporizador real no llega a correr en el test
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      hrWarmupMs: 0,
      hrStreamAfterMs: 0,
    });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    transport.attempts.length = 0;
    transport.rings[0]?.simulateLinkLoss();
    await wait(30);

    fake.wake(); // aún no toca (faltan 60 s)
    await wait(20);
    expect(transport.attempts).toHaveLength(0);

    clock += 61_000; // el reloj avanza, pero el temporizador del WebView no ha dado señales de vida
    fake.wake();
    await wait(30);
    expect(transport.attempts).toHaveLength(1);
    await controller.discard();
  });

  it('un aviso nativo que llega con minutos de retraso (el WebView estaba parado) no se toma por el reloj: no adelanta nada', async () => {
    let clock = 1_000_000;
    const transport = new OutOfRangeTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80, 90], hrIntervalMs: 4, liveIntervalMs: 6 });
    const fake = fakePlatform();
    const controller = new WorkoutController({
      transport,
      store,
      now: () => clock,
      platform: fake.platform,
      getProfile: () => profile,
      onState: () => undefined,
      onFinished: () => undefined,
      tickMs: 50,
      reconnectEveryMs: 60_000,
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      hrWarmupMs: 0,
      hrStreamAfterMs: 0,
    });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    transport.attempts.length = 0;
    transport.rings[0]?.simulateLinkLoss();
    await wait(30);

    clock += 61_000; // ya tocaba reintentar
    fake.wake({ source: 'tick', lagMs: 45_000 }); // pero este aviso salió hace 45 s: es de cuando nada corría
    await wait(30);
    expect(transport.attempts).toHaveLength(0);
    fake.wake({ source: 'tick', lagMs: 20 }); // uno a tiempo sí
    await wait(30);
    expect(transport.attempts).toHaveLength(1);
    await controller.discard();
  });

  it('un aviso sin entreno en marcha no hace nada', async () => {
    const { controller } = setup();
    expect(() => controller.poke()).not.toThrow();
    await controller.start('gym', { gps: false });
    await controller.discard();
    expect(() => controller.poke()).not.toThrow();
  });
});

describe('WorkoutController: el servicio nativo mantiene vivo el entreno aunque no lleve GPS', () => {
  const withTracker = (trackerOptions: FakeTrackerOptions = {}) => {
    const t = fakeTracker(trackerOptions);
    return { t, ...setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 10 } }) };
  };

  it('un entreno sin GPS (fuerza, yoga…) arranca el servicio sin ubicación, pide solo los avisos y lo para al terminar', async () => {
    const { t, controller, finished } = withTracker();
    await controller.start('gym', { gps: false });
    await wait(30);
    expect(t.calls).toContain('askPermissions:nogps');
    expect(t.calls.some((c) => /^start:w-.+:nogps$/.test(c))).toBe(true);
    expect(t.server.active).toBe(true);
    expect(t.calls.some((c) => c.startsWith('fixes:')), 'sin ruta no se piden posiciones').toBe(false);
    await controller.finish();
    expect(finished).toHaveLength(1);
    expect(t.server.active).toBe(false);
  });

  it('descartar el entreno sin GPS también para el servicio (un servicio olvidado gastaría batería)', async () => {
    const { t, controller } = withTracker();
    await controller.start('gym', { gps: false });
    await wait(30);
    await controller.discard();
    expect(t.server.active).toBe(false);
    expect(t.calls.at(-1)).toBe('stop');
  });

  it('un entreno con GPS no arranca además el servicio sin ubicación (ya lo lleva el de la ruta)', async () => {
    const { t, controller } = withTracker();
    await controller.start('cycle', { gps: true });
    await wait(30);
    expect(t.calls.filter((c) => c.startsWith('start:'))).toHaveLength(1);
    expect(t.calls.some((c) => c.endsWith(':nogps'))).toBe(false);
    await controller.discard();
  });

  it('si el servicio sin GPS no arranca, avisa de que con la pantalla apagada el pulso puede perderse, y el entreno sigue', async () => {
    const { controller, states } = withTracker({ failStart: 'error' });
    await controller.start('gym', { gps: false });
    await wait(30);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/No se pudo mantener el entreno en segundo plano/);
    expect(states.at(-1)?.phase).toBe('live');
    await controller.discard();
  });

  it('cancelar mientras arranca el servicio no lo deja corriendo', async () => {
    const t = fakeTracker();
    const realStart = t.tracker.start.bind(t.tracker);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.tracker.start = async (request) => {
      await gate;
      return realStart(request);
    };
    const { controller } = setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 10 } });
    await controller.start('gym', { gps: false });
    await wait(10);
    await controller.discard();
    release();
    await wait(30);
    expect(t.server.active, 'el servicio que arrancó tarde se para solo').toBe(false);
  });

  it('sin plugin nativo (el navegador) no intenta nada', async () => {
    const { controller, states } = setup();
    await controller.start('gym', { gps: false });
    await wait(20);
    expect(states.at(-1)?.warnings ?? []).toHaveLength(0);
    await controller.discard();
  });
});

describe('WorkoutController: cancelar mientras se reconecta', () => {
  it('si el entreno se cancela mientras busca el anillo guardado, no abre después el selector del sistema', async () => {
    const transport = new NotFoundTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80], hrIntervalMs: 4, liveIntervalMs: 6 });
    let open!: () => void;
    transport.gate = new Promise<void>((resolve) => (open = resolve));
    const fake = fakePlatform();
    const controller = new WorkoutController({
      transport,
      store,
      now: () => Date.now(),
      platform: fake.platform,
      getProfile: () => profile,
      onState: () => undefined,
      onFinished: () => undefined,
      tickMs: 50,
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      hrWarmupMs: 0,
      hrStreamAfterMs: 0,
    });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const starting = controller.start('gym', { gps: false });
    await wait(10);
    await controller.discard(); // cancela mientras reconecta
    transport.gate = null;
    open();
    await starting; // termina sin error
    expect(transport.picks).toBe(0);
    expect(transport.rings).toHaveLength(0);
    expect(controller.isActive).toBe(false);
  });

  it('sin cancelar, si no encuentra el anillo guardado, abre el selector como siempre', async () => {
    const transport = new NotFoundTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [0, 80], hrIntervalMs: 4, liveIntervalMs: 6 });
    const fake = fakePlatform();
    const controller = new WorkoutController({
      transport,
      store,
      now: () => Date.now(),
      platform: fake.platform,
      getProfile: () => profile,
      onState: () => undefined,
      onFinished: () => undefined,
      tickMs: 50,
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      hrWarmupMs: 0,
      hrStreamAfterMs: 0,
    });
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await controller.start('gym', { gps: false });
    expect(transport.picks).toBe(1);
    expect(controller.isActive).toBe(true);
    await controller.discard();
  });

  describe('GPS: avisos', () => {
    it('el aviso de que no hay ubicación desaparece en cuanto llega una posición', async () => {
      const { controller, states, fake } = setup();
      await controller.start('walk', { gps: true });
      await wait(30);
      const failing = [...fake.watchers.values()][0];
      failing?.err?.({ code: 3, message: 'timeout', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
      expect(states.at(-1)?.warnings).toContain('No se pudo obtener la ubicación.');
      fake.push(40, Date.now());
      expect(states.at(-1)?.warnings).not.toContain('No se pudo obtener la ubicación.');
      // Pero el permiso denegado no se va: no vendrán posiciones.
      failing?.err?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
      fake.push(40.0001, Date.now());
      expect(states.at(-1)?.warnings.join(' ')).toMatch(/denegado el permiso de ubicación/);
      await controller.discard();
    });

    it('si la app estuvo oculta un buen rato con el GPS, al volver se dice cuánto y que ese tramo no tiene GPS', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const { controller, states, fake } = setup();
      await controller.start('cycle', { gps: true });
      fake.becomeHidden();
      vi.setSystemTime(NOW + 3 * 60_000);
      fake.becomeVisible();
      const warning = states.at(-1)?.warnings.find((w) => w.startsWith('La app estuvo oculta'));
      expect(warning).toMatch(/oculta 3 min/);
      expect(warning).toMatch(/puede salir más corto/); // en bici no hay pasos con los que completar
      // Otra ausencia: el aviso se actualiza con el total, no se apila.
      fake.becomeHidden();
      vi.setSystemTime(NOW + 10 * 60_000);
      fake.becomeVisible();
      expect(states.at(-1)?.warnings.filter((w) => w.startsWith('La app estuvo oculta'))).toHaveLength(1);
      expect(states.at(-1)?.warnings.find((w) => w.startsWith('La app estuvo oculta'))).toMatch(/oculta 10 min/);
      await controller.discard();
    });

    it('un vistazo corto a otra app no avisa, ni sin GPS, ni en pausa; y a pie dice que se completa con los pasos', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const { controller, states, fake } = setup();
      await controller.start('walk', { gps: true });
      fake.becomeHidden();
      vi.setSystemTime(NOW + 20_000);
      fake.becomeVisible();
      expect(states.at(-1)?.warnings.some((w) => w.startsWith('La app estuvo oculta'))).toBe(false);

      controller.pause();
      fake.becomeHidden();
      vi.setSystemTime(NOW + 5 * 60_000);
      fake.becomeVisible();
      expect(states.at(-1)?.warnings.some((w) => w.startsWith('La app estuvo oculta'))).toBe(false);
      controller.resume();

      fake.becomeHidden();
      vi.setSystemTime(NOW + 8 * 60_000);
      fake.becomeVisible();
      expect(states.at(-1)?.warnings.find((w) => w.startsWith('La app estuvo oculta'))).toMatch(/se completa con los pasos del anillo/);
      await controller.discard();

      // Sin GPS no hay nada que avisar.
      const sin = setup();
      await sin.controller.start('gym', { gps: false });
      sin.fake.becomeHidden();
      vi.setSystemTime(NOW + 20 * 60_000);
      sin.fake.becomeVisible();
      expect(sin.states.at(-1)?.warnings.some((w) => w.startsWith('La app estuvo oculta'))).toBe(false);
      await sin.controller.discard();
    });
  });
});

describe('WorkoutController: GPS nativo (el servicio de Android graba con la pantalla apagada o la app oculta)', () => {
  const lat = (meters: number): number => 40 + meters / 111_195;
  const native = (trackerOptions: FakeTrackerOptions = {}, pollMs = 10) => {
    const t = fakeTracker(trackerOptions);
    return { t, ...setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: pollMs } }) };
  };

  it('arranca el servicio con el identificador del entreno, recoge las posiciones y no usa el GPS de la web', async () => {
    const { t, controller, states, fake } = native();
    await controller.start('cycle', { gps: true });
    await wait(30);
    expect(t.calls.some((c) => c.startsWith('start:w-'))).toBe(true);
    expect(fake.watchers.size).toBe(0);
    const from = Date.now();
    for (let i = 0; i < 20; i++) t.record(lat(i * 6), from + i * 1000, 6);
    await wait(60);
    expect(states.at(-1)?.snapshot?.distanceM ?? 0).toBeGreaterThan(100); // 19 s a 6 m/s
    expect(states.at(-1)?.snapshot?.distanceSource).toBe('gps');
    await controller.discard();
  });

  it('al terminar recoge lo último que grabó el servicio (aunque nadie lo hubiera pedido aún), lo deja en el entreno, y para el servicio y borra la pista', async () => {
    const { t, controller, finished } = native({}, 60_000);
    await controller.start('cycle', { gps: true });
    await wait(30);
    const from = Date.now();
    for (let i = 0; i < 30; i++) t.record(lat(i * 6), from + i * 1000, 6); // el servicio las graba y la web aún no las ha pedido
    await controller.finish();
    expect(finished[0]?.distanceM ?? 0).toBeGreaterThan(150); // 29 s a 6 m/s
    expect(finished[0]?.distanceSource).toBe('gps');
    expect(t.calls.slice(-2)).toEqual(['stop', `clear:${t.server.session}`]);
    expect(t.server.active).toBe(false);
    expect(t.track).toHaveLength(0);
  });

  it('el borrador anota hasta qué posición del servicio lleva, y se guarda otra vez tras recoger las nuevas', async () => {
    const drafts: Array<{ trackSeq?: number }> = [];
    const store = { getRing: async () => null, setRing: async () => undefined, setWorkoutDraft: async (d: { trackSeq?: number } | null) => void (d && drafts.push(d)) };
    const t = fakeTracker();
    const { controller } = setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 60_000, draftEveryMs: 40, store } });
    await controller.start('walk', { gps: true });
    await wait(20);
    const from = Date.now();
    for (let i = 0; i < 7; i++) t.record(lat(i * 2), from + i * 1000, 1.4);
    await wait(120); // salta el guardado del borrador: guarda el actual y, tras recoger lo que había, otra vez
    expect(drafts.some((d) => d.trackSeq === 7)).toBe(true);
    await controller.discard();
  });

  it('un servicio que no contesta al parar no deja el anillo sin soltar', async () => {
    const t = fakeTracker();
    const hang = new Promise<never>(() => undefined);
    t.tracker.stop = () => hang;
    const { controller, fake, finished } = setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 10, trackStopMs: 60 } });
    await controller.start('walk', { gps: true });
    await wait(30);
    await controller.finish(); // sin el tope no acabaría nunca
    expect(finished).toHaveLength(1);
    expect(fake.lock.release).toHaveBeenCalled();
  });

  it('descartar el entreno también para el servicio y borra la pista (un servicio de ubicación olvidado gastaría batería)', async () => {
    const { t, controller } = native();
    await controller.start('walk', { gps: true });
    await wait(30);
    t.record(lat(0), Date.now());
    await controller.discard();
    expect(t.server.active).toBe(false);
    expect(t.calls.at(-1)).toMatch(/^clear:/);
  });

  it('sin permiso de ubicación avisa, no arranca el servicio y no recurre al GPS de la web (tampoco se concedería)', async () => {
    const { t, controller, states, fake } = native({ denyLocation: true });
    await controller.start('walk', { gps: true });
    await wait(30);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/denegado el permiso de ubicación/);
    expect(t.calls.some((c) => /^start:w-[^:]+$/.test(c)), 'el servicio de la ruta no arranca').toBe(false);
    expect(t.calls.some((c) => /^start:w-.+:nogps$/.test(c)), 'pero el entreno sí se mantiene vivo (sin ubicación)').toBe(true);
    expect(fake.watchers.size).toBe(0);
    await controller.discard();
    expect(t.calls.at(-1)).toBe('stop');
  });

  it('si el servicio no arranca, avisa y usa el GPS de la web mientras la app se vea', async () => {
    const { controller, states, fake } = native({ failStart: 'error' });
    await controller.start('walk', { gps: true });
    await wait(30);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/No se pudo grabar el GPS en segundo plano/);
    expect(fake.watchers.size).toBe(1);
    await controller.discard();
  });

  it('avisa si el GPS del móvil está apagado, y el aviso se va solo cuando se enciende', async () => {
    const { t, controller, states } = native({ gpsEnabled: false });
    await controller.start('walk', { gps: true });
    await wait(40);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/GPS del móvil está apagado/);
    t.server.gpsEnabled = true;
    await wait(40);
    expect(states.at(-1)?.warnings.join(' ')).not.toMatch(/GPS del móvil está apagado/);
    await controller.discard();
  });

  it('si el servicio falla a mitad del entreno, lo dice y la web da el GPS mientras la app se vea', async () => {
    const { t, controller, states, fake } = native();
    await controller.start('walk', { gps: true });
    await wait(30);
    expect(fake.watchers.size).toBe(0);
    t.server.error = 'Sin permiso de ubicación.';
    await wait(40);
    expect(states.at(-1)?.warnings.join(' ')).toMatch(/No se puede grabar el GPS en segundo plano: Sin permiso de ubicación/);
    expect(fake.watchers.size).toBe(1);
    await controller.discard();
  });

  it('con el servicio nativo no hay aviso de «la app estuvo oculta»: el GPS sigue grabando con la app oculta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { controller, states, fake } = native();
    await controller.start('cycle', { gps: true });
    await wait(30);
    fake.becomeHidden();
    vi.setSystemTime(NOW + 10 * 60_000);
    fake.becomeVisible();
    expect(states.at(-1)?.warnings.some((w) => w.startsWith('La app estuvo oculta'))).toBe(false);
    await controller.discard();
  });

  it('una pausa en medio: lo grabado durante la pausa no suma, y lo de justo antes de pausar sí aunque aún no se hubiera recogido', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { t, controller, finished } = native({}, 60_000);
    await controller.start('cycle', { gps: true });
    await wait(30);
    for (let s = 0; s < 60; s++) t.record(lat(s * 6), NOW + s * 1000, 6);
    vi.setSystemTime(NOW + 60_000);
    controller.pause(); // recoge YA lo de antes de la pausa
    for (let s = 60; s < 120; s++) t.record(lat(s * 6), NOW + s * 1000, 6); // la persona sigue moviéndose con la grabación en pausa
    vi.setSystemTime(NOW + 120_000);
    controller.resume();
    for (let s = 120; s < 180; s++) t.record(lat(s * 6), NOW + s * 1000, 6);
    vi.setSystemTime(NOW + 180_000);
    await controller.finish();
    const distance = finished[0]?.distanceM ?? 0;
    expect(distance).toBeGreaterThan(690); // 59 s + 59 s a 6 m/s
    expect(distance).toBeLessThan(740);
  });

  it('pide a Android que no restrinja la app en segundo plano UNA vez (el ahorro de batería de algunos fabricantes cierra los servicios)', async () => {
    // El almacenamiento del WebView, en memoria.
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
    const first = native({ batteryExempt: false });
    await first.controller.start('walk', { gps: true });
    await wait(40);
    expect(first.t.calls.filter((c) => c === 'battery')).toHaveLength(1);
    await first.controller.discard();

    const second = native({ batteryExempt: false });
    await second.controller.start('walk', { gps: true });
    await wait(40);
    expect(second.t.calls).not.toContain('battery'); // ya se preguntó
    await second.controller.discard();

    memory.clear();
    const exempt = native({ batteryExempt: true });
    await exempt.controller.start('walk', { gps: true });
    await wait(40);
    expect(exempt.t.calls).not.toContain('battery'); // ya no está restringida: no hay nada que pedir
    await exempt.controller.discard();
    vi.unstubAllGlobals();
  });
});


// ───────────────────────────── el pulso al encender la pantalla ─────────────────────────────

/**
 * Un transporte «nativo»: el anillo simulado entrega cada trama con lo que le habría añadido el lado nativo de Android (la hora a la que llegó, si el reflejo la
 * atendió…), y las pruebas empujan las tramas que el anillo mandó mientras el WebView estaba parado.
 */
class NativeStyleTransport implements RingTransport {
  readonly kind = 'simulator' as const;
  readonly available = true;
  ring: SimulatedRing | null = null;
  private readonly metas = new Map<string, ChunkMeta[]>();
  constructor(
    private readonly dataset: SimDataset,
    private readonly behavior: SimBehavior = {},
  ) {}
  private make(): RingLink {
    const ring = new SimulatedRing(this.dataset, this.behavior);
    this.ring = ring;
    const metas = this.metas;
    return {
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
      onData: (listener) => ring.onData((channel, chunk) => listener(channel, chunk, metas.get(toHex(chunk))?.shift())),
      onDisconnect: (listener) => ring.onDisconnect(listener),
      disconnect: () => ring.disconnect(),
      keeper: { arm: async () => undefined, disarm: async () => undefined },
    };
  }
  async pickAndConnect(): Promise<RingLink> {
    return this.make();
  }
  async reconnect(): Promise<RingLink | null> {
    return this.make();
  }
  push(kind: 'real' | 'devControl', key: number, payload: number[], native: ChunkMeta): void {
    const hex = toHex(buildFrame(kind === 'real' ? 6 : 4, key, payload));
    this.metas.set(hex, [...(this.metas.get(hex) ?? []), native]);
    if (kind === 'real') this.ring?.pushReal(key, payload);
    else this.ring?.pushDevControl(key, payload);
  }
  /** Cuántas veces se le ha pedido al anillo que empiece a medir el pulso. */
  get starts(): number {
    return this.ring?.received.filter((f) => f.group === 3 && f.cmd === 0x2f && toHex(f.payload) === '0100').length ?? 0;
  }
}

describe('WorkoutController: el pulso al encender la pantalla tras apagarla', () => {
  function nativeController() {
    const transport = new NativeStyleTransport(buildDemoDataset({ nowMs: NOW, days: 2, seed: 4 }), { hrSamples: [80], hrIntervalMs: 100_000, liveIntervalMs: 100_000 });
    const fake = fakePlatform();
    const states: Array<LiveWorkoutState | null> = [];
    const finished: WorkoutRecord[] = [];
    const controller = new WorkoutController({
      transport,
      store,
      now: () => Date.now(),
      platform: fake.platform,
      getProfile: () => profile,
      onState: (s) => states.push(s),
      onFinished: (r) => finished.push(r),
      tickMs: 20,
      reconnectEveryMs: 60_000,
      sessionTimeouts: { reply: 200, header: 300, idle: 300 },
      // Los tiempos de verdad del anillo (calentamiento de 28 s, continuo a partir de 60 s): lo que ocurre en un entreno real.
    });
    return { transport, fake, states, finished, controller };
  }

  for (const order of ['el aviso de «visible» primero', 'lo atrasado primero'] as const) {
    it(`con ${order}: la pantalla enseña el pulso al instante, sin «esperando lectura», el sensor no se reinicia y el entreno guarda lo medido con la pantalla apagada`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { transport, fake, states, finished, controller } = nativeController();
      const start = Date.now();
      await controller.start('gym', { gps: false });
      expect(transport.starts).toBe(1);

      // El WebView se queda parado casi dos minutos: el anillo cierra cinco ciclos y el reflejo nativo reabre la medida cada vez.
      vi.setSystemTime(start + 105_000);
      const { events, expected } = r99Timeline(start, 5);
      const deliver = async (): Promise<void> => {
        for (const e of events) transport.push(e.kind, e.key, e.payload, e.native);
        await wait(40);
      };
      if (order === 'lo atrasado primero') {
        await deliver();
        fake.wake({ source: 'visible', lagMs: 0 });
      } else {
        fake.wake({ source: 'visible', lagMs: 0 });
        await wait(10);
        await deliver();
      }
      // La pantalla se refresca cada 20 ms de reloj real: se espera a que lo atrasado esté procesado y pintado (con el equipo cargado, como en el CI, tarda más).
      await vi.waitFor(() => expect(states.at(-1)?.snapshot?.bpm, 'el último pulso (ciclo 5) ya se ve').toBe(74), { timeout: 10_000, interval: 10 });
      const snap = states.at(-1)?.snapshot;
      expect(snap?.lastPulse?.ageMs).toBeLessThan(10_000);
      expect(transport.starts, 'ninguna orden de más al anillo al despertar').toBe(1);

      await controller.finish();
      const record = finished[0];
      // Una lectura guardada cada ≥ 4,5 s: la primera de las tres últimas de cada ciclo.
      expect(record?.hr?.map(([ts, bpm]) => [bpm, ts])).toEqual([0, 1, 2, 3, 4].map((k) => expected[k * 3] as [number, number]));
    });
  }

  it('si el sensor de verdad dejó de dar lecturas, la pantalla lo dice con la antigüedad de la última en lugar de repetir «el sensor tarda ~30 s»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { transport, states, controller } = nativeController();
    const start = Date.now();
    await controller.start('gym', { gps: false });
    const { events } = r99Timeline(start, 1);
    vi.setSystemTime(start + 21_000);
    for (const e of events) transport.push(e.kind, e.key, e.payload, e.native);
    await vi.waitFor(() => expect(states.at(-1)?.snapshot?.bpm).toBe(70), { timeout: 10_000, interval: 10 });
    vi.setSystemTime(start + 21_000 + 100_000); // y ya no llega nada en minuto y medio
    await vi.waitFor(() => expect(states.at(-1)?.snapshot?.bpm).toBeNull(), { timeout: 10_000, interval: 10 });
    const snap = states.at(-1)?.snapshot;
    expect(snap?.bpm).toBeNull();
    expect(snap?.lastPulse?.bpm).toBe(70);
    expect(snap?.lastPulse?.ageMs).toBeGreaterThan(75_000);
    await controller.discard();
  });
});

describe('WorkoutController: paseo de calibración de la zancada', () => {
  it('marca su propósito en el estado, entrega el registro con él y no deja borrador', async () => {
    const purposes: string[] = [];
    const records: WorkoutRecord[] = [];
    const { controller, states, fake } = setup({}, undefined, {
      deps: {
        draftEveryMs: 10,
        onFinished: (record, purpose) => {
          records.push(record);
          purposes.push(purpose);
        },
      },
    });
    await controller.start('walk', { gps: true, purpose: 'stride' });
    const t = Date.now();
    for (let i = 0; i < 30; i++) fake.push(40 + (i * 10) / 111_195, t + i * 8000);
    await wait(60); // da tiempo a varios guardados de borrador
    expect(states.filter((s) => s !== null).every((s) => s?.purpose === 'stride')).toBe(true);
    expect(await store.getWorkoutDraft()).toBeNull();

    await controller.finish();
    expect(purposes).toEqual(['stride']);
    expect(records[0]).toMatchObject({ sport: 'walk', distanceSource: 'gps' });
    expect(await store.getWorkoutDraft()).toBeNull(); // el paseo de calibración no queda pendiente de revisar
    expect(fake.watchers.size).toBe(0);
  });

  it('un entrenamiento normal no lleva propósito en su estado y deja su borrador', async () => {
    const purposes: string[] = [];
    const { controller, states } = setup({}, undefined, { deps: { draftEveryMs: 10, onFinished: (_r, purpose) => void purposes.push(purpose) } });
    await controller.start('gym', { gps: false });
    await wait(60);
    expect(states.filter((s) => s !== null).every((s) => s?.purpose === undefined)).toBe(true);
    expect(await store.getWorkoutDraft()).toMatchObject({ sport: 'gym' });
    await controller.finish();
    expect(purposes).toEqual(['workout']);
  });

  it('cancelar una calibración no borra el borrador de un entreno anterior que sigue pendiente', async () => {
    await store.setWorkoutDraft({ id: 'old', sport: 'gym', startMs: NOW - 3_600_000, endMs: NOW - 1_800_000, pausedMs: 0, source: 'live' });
    const { controller } = setup();
    await controller.start('walk', { gps: true, purpose: 'stride' });
    await controller.discard();
    expect(await store.getWorkoutDraft()).toMatchObject({ id: 'old' });
  });

  describe('sin anillo: andar medido solo con el móvil', () => {
    it('no toca el Bluetooth ni reserva el anillo, activa el GPS aunque no se pida y lo marca en el estado', async () => {
      const claimRing = vi.fn(() => () => undefined);
      const { controller, transport, states, fake, finished } = setup({}, undefined, { deps: { claimRing, draftEveryMs: 10_000 } });
      await controller.start('walk', { gps: false, ring: false });
      await wait(40);
      expect(claimRing).not.toHaveBeenCalled(); // no hay anillo que reservar
      expect(transport.lastRing).toBeNull(); // ni conexión: el simulador no llegó a abrir ningún anillo
      const live = states.filter((s): s is LiveWorkoutState => s !== null).at(-1)!;
      expect(live.phase).toBe('live');
      expect(live.ring).toBe(false);
      expect(live.ringLost).toBe(false);
      expect(live.features).toEqual({ heartRate: false, steps: false });
      expect(live.useGps).toBe(true); // la única fuente de distancia
      expect(fake.watchers.size).toBe(1); // el GPS de la web, que es lo que hay sin servicio nativo
      expect(fake.platform.wakeLock?.request).toHaveBeenCalledWith('screen');

      await controller.finish();
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ sport: 'walk', source: 'live' });
      expect(finished[0]?.hr ?? []).toEqual([]); // sin pulso
      expect(controller.isActive).toBe(false);
    });

    it('mide la distancia con el GPS y calcula las calorías con el móvil, sin pasos del anillo', async () => {
      const { controller, states, fake } = setup();
      await controller.start('walk', { gps: true, ring: false });
      const now = Date.now();
      // Unos 100 m al norte en 70 s (≈ 5 km/h): 0,0009° de latitud ≈ 100 m.
      fake.push(40.0, now);
      fake.push(40.0009, now + 70_000);
      await wait(40);
      const snap = states.filter((s): s is LiveWorkoutState => s !== null).at(-1)!.snapshot!;
      expect(snap.distanceSource).toBe('gps');
      expect(snap.distanceM).toBeGreaterThan(60);
      expect(snap.steps).toBeNull();
      expect(snap.bpm).toBeNull();
      await controller.discard();
    });

    it('cancelar antes de empezar no deja nada abierto, y un entreno con anillo posterior sigue pidiendo el anillo', async () => {
      const claimRing = vi.fn(() => () => undefined);
      const { controller, transport } = setup({}, undefined, { deps: { claimRing } });
      await controller.start('walk', { gps: true, ring: false });
      await controller.discard();
      expect(controller.isActive).toBe(false);
      await controller.start('gym', { gps: false });
      await wait(40);
      expect(claimRing).toHaveBeenCalledTimes(1);
      expect(transport.lastRing?.connected).toBe(true);
      await controller.discard();
    });
  });
});

describe('WorkoutController: navegación guiada y recorrido', () => {
  it('«guiada» solo cuenta con el GPS y en un entreno de verdad: el estado lo dice para que la pantalla lleve las dos pestañas', async () => {
    const guided = async (options: Parameters<WorkoutController['start']>[1], sport: 'walk' | 'gym' = 'walk'): Promise<boolean | undefined> => {
      const { controller, states } = setup();
      await controller.start(sport, options);
      await wait(30);
      const last = states.filter((s): s is LiveWorkoutState => s !== null).at(-1)!;
      await controller.discard();
      return last.guided;
    };
    expect(await guided({ gps: true, guided: true })).toBe(true);
    expect(await guided({ gps: true })).toBeUndefined();
    expect(await guided({ gps: true, guided: false })).toBeUndefined();
    // Sin GPS no hay a quién guiar, aunque se pida.
    expect(await guided({ gps: false, guided: true })).toBeUndefined();
    // Una calibración de la zancada no es un entreno que se pueda guiar.
    expect(await guided({ gps: true, guided: true, purpose: 'stride' })).toBeUndefined();
  });

  it('el borrador y el registro final llevan por dónde se fue, con la salida y la llegada', async () => {
    const records: WorkoutRecord[] = [];
    const { controller, fake } = setup({}, undefined, { deps: { draftEveryMs: 10, onFinished: (record) => void records.push(record) } });
    await controller.start('walk', { gps: true, guided: true });
    const t = Date.now();
    // Hacia el norte y luego hacia el este, 600 m en total (una esquina que el dibujo tiene que conservar).
    for (let i = 0; i <= 30; i++) fake.push(40 + (i * 10) / 111_195, t + i * 7000);
    for (let i = 1; i <= 30; i++) fake.push(40 + 300 / 111_195, t + (30 + i) * 7000, 5, -3 + (i * 10) / 85_000);
    await wait(60);
    const draft = await store.getWorkoutDraft();
    expect(draft?.route?.length).toBeGreaterThanOrEqual(2);
    await controller.finish();
    const route = records[0]!.route!;
    expect(route.length).toBeGreaterThanOrEqual(3);
    expect(route.length).toBeLessThanOrEqual(600);
    expect(route[0]![0]).toBeCloseTo(40, 4);
    const last = route[route.length - 1]!;
    expect(last[0]).toBeCloseTo(40 + 300 / 111_195, 4);
    expect(last[1]).toBeGreaterThan(-3);
  });

  it('un entreno sin GPS no lleva recorrido', async () => {
    const records: WorkoutRecord[] = [];
    const { controller } = setup({}, undefined, { deps: { draftEveryMs: 10, onFinished: (record) => void records.push(record) } });
    await controller.start('gym', { gps: false });
    await wait(40);
    await controller.finish();
    expect(records[0]!.route).toBeUndefined();
  });
});

describe('WorkoutController: los botones de la notificación del entreno', () => {
  const withNotification = () => {
    const t = fakeTracker();
    const ended: Array<{ record: WorkoutRecord; purpose: string; meta: FinishMeta | undefined }> = [];
    const made = setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 10, onFinished: (record, purpose, meta) => void ended.push({ record, purpose, meta }) } });
    return { t, ended, ...made };
  };

  it('«Pausa» en la notificación pausa el entreno desde la hora del toque y «Reanudar» lo reanuda', async () => {
    const { t, controller, states } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(80);
    const pausedAt = Date.now() - 40;
    t.press('pause', pausedAt);
    await wait(40);
    expect(states.at(-1)?.snapshot?.status).toBe('paused');
    // La web se lo cuenta a la notificación con la misma hora (no cambia nada: ya lo sabía).
    expect(t.notification.sets.at(-1)).toEqual({ paused: true, atMs: pausedAt });
    const resumedAt = Date.now() - 10;
    t.press('resume', resumedAt);
    await wait(40);
    expect(states.at(-1)?.snapshot?.status).toBe('running');
    expect(states.at(-1)?.snapshot?.pausedMs).toBeGreaterThanOrEqual(resumedAt - pausedAt - 1);
    expect(t.notification.paused).toBe(false);
    await controller.discard();
  });

  it('«Parar» termina el entreno sin pedir confirmación, con la hora del toque, y lo entrega para guardarlo directamente', async () => {
    const { t, controller, states, ended } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(80);
    const stoppedAt = Date.now() - 20;
    t.press('stop', stoppedAt);
    await wait(80);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.meta).toEqual({ fromNotification: true });
    expect(ended[0]!.purpose).toBe('workout');
    expect(ended[0]!.record.endMs).toBe(stoppedAt);
    expect(ended[0]!.record.hr?.length).toBeGreaterThan(0);
    expect(states.at(-1)).toBeNull();
    expect(controller.isActive).toBe(false);
    expect(t.server.active).toBe(false);
  });

  it('parar desde la pantalla no lleva esa marca: se revisa como siempre', async () => {
    const { controller, ended } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(60);
    await controller.finish();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.meta).toBeUndefined();
  });

  it('pausar y luego parar desde la notificación: la pausa dura hasta la parada y el entreno acaba en ella', async () => {
    const { t, controller, ended } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(80);
    const now = Date.now();
    t.press('pause', now - 60, false); // la web estaba parada: la orden espera
    expect(t.pendingActions()).toBe(1);
    t.press('stop', now - 10); // al sonar el timbre se recogen las dos, en orden
    await wait(80);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.record.endMs).toBe(now - 10);
    expect(ended[0]!.record.pausedMs).toBe(50); // de la pausa a la parada
    expect(t.pendingActions()).toBe(0);
  });

  it('sin timbre (la web estaba parada), la orden se recoge con el aviso nativo que dice que hay órdenes esperando', async () => {
    const { t, controller, states, fake } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(80);
    t.press('pause', Date.now() - 30, false);
    await wait(30);
    expect(states.at(-1)?.snapshot?.status).toBe('running'); // nadie la recogió aún
    fake.wake({ source: 'tick', lagMs: 0, tick: { pending: 1 } });
    await wait(40);
    expect(states.at(-1)?.snapshot?.status).toBe('paused');
    await controller.discard();
  });

  it('sin timbre ni aviso, al volver a ver la app se revisan las órdenes', async () => {
    const { t, controller, states, fake } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(80);
    t.press('pause', Date.now() - 30, false);
    fake.wake({ source: 'visible', lagMs: 0 });
    await wait(40);
    expect(states.at(-1)?.snapshot?.status).toBe('paused');
    await controller.discard();
  });

  it('un aviso nativo sin órdenes esperando no recoge nada (no se pregunta cada 2 s en balde)', async () => {
    const { t, controller, fake } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(60);
    const before = t.calls.filter((c) => c === 'takeActions').length;
    fake.wake({ source: 'tick', lagMs: 0, tick: { pending: 0 } });
    fake.wake({ source: 'tick', lagMs: 0, tick: {} });
    await wait(30);
    expect(t.calls.filter((c) => c === 'takeActions').length).toBe(before);
    await controller.discard();
  });

  it('pausar y reanudar desde la pantalla se lo cuenta a la notificación', async () => {
    const { t, controller } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(60);
    controller.pause();
    controller.resume();
    expect(t.calls.filter((c) => c.startsWith('setPaused:'))).toEqual(['setPaused:true', 'setPaused:false']);
    expect(t.notification.paused).toBe(false);
    await controller.discard();
  });

  it('el timbre solo se oye mientras dura el entreno', async () => {
    const { t, controller } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(60);
    expect(t.doorbells()).toBe(1);
    await controller.discard();
    expect(t.doorbells()).toBe(0);
  });

  it('una orden que llega cuando ya no hay entreno no hace nada', async () => {
    const { t, controller, ended } = withNotification();
    await controller.start('gym', { gps: false });
    await wait(60);
    await controller.discard();
    t.press('stop', Date.now()); // sin timbre que oiga: queda anotada para la próxima vez que se pregunte
    await wait(30);
    expect(ended).toHaveLength(0);
    expect(controller.isActive).toBe(false);
  });
});

describe('WorkoutController: qué pasó con la pantalla apagada (informe al volver y servicio que se levanta)', () => {
  const lat = (meters: number): number => 40 + meters / 111_195;
  /** Un reloj que se adelanta a voluntad: seis minutos de pantalla apagada sin esperarlos. */
  const clocked = (trackerOptions: FakeTrackerOptions = {}, ring = true) => {
    const clock = { skew: 0 };
    const t = fakeTracker(trackerOptions);
    const made = setup({}, undefined, { tracker: t.tracker, deps: { now: () => Date.now() + clock.skew, trackPollEveryMs: 10, screenReportDelayMs: 20 } });
    return { clock, t, ring, ...made };
  };
  const MIN = 60_000;

  it('tras seis minutos oculta sin una sola posición del GPS avisa de qué se perdió y qué mirar, con las cifras del móvil', async () => {
    const { clock, t, controller, fake, states } = clocked({ phone: { powerSave: true, bgLocation: false, autostart: false } });
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    fake.becomeHidden();
    clock.skew += 6 * MIN;
    fake.becomeVisible();
    await wait(120);
    const warning = states.at(-1)?.warnings.find((w) => w.includes('interrumpió la grabación')) ?? '';
    expect(warning).toContain('el GPS no dio ninguna posición');
    expect(warning).toContain('ahorro de batería de Android');
    expect(warning).toContain('Permitir siempre');
    expect(warning).toContain('«Inicio automático» está DESACTIVADO');
    expect(warning).toContain('[apagada 6 min');
    expect(t.calls).toContain('status'); // preguntó al servicio cómo está el móvil
    await controller.discard();
  });

  it('si lo grabado con la pantalla apagada llegó entero, no dice nada', async () => {
    const { clock, t, controller, fake, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    fake.becomeHidden();
    const from = Date.now() + clock.skew;
    clock.skew += 6 * MIN;
    for (let i = 0; i < 360; i++) t.record(lat(i * 1.4), from + 500 + i * 1000, 1.4); // el servicio grabó una por segundo
    fake.becomeVisible();
    await wait(150);
    expect(states.at(-1)?.warnings.filter((w) => w.includes('interrumpió'))).toEqual([]);
    await controller.discard();
  });

  it('un vistazo corto a otra app no se comenta', async () => {
    const { clock, t, controller, fake, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    const statusCalls = t.calls.filter((c) => c === 'status').length; // las del arranque (ajustes del móvil)
    fake.becomeHidden();
    clock.skew += 40_000;
    fake.becomeVisible();
    await wait(100);
    expect(states.at(-1)?.warnings.filter((w) => w.includes('interrumpió'))).toEqual([]);
    expect(t.calls.filter((c) => c === 'status')).toHaveLength(statusCalls); // no preguntó nada al volver
    await controller.discard();
  });

  it('el proceso que el móvil congeló se nota en el hueco entre los avisos nativos', async () => {
    const { clock, controller, fake, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    const from = Date.now() + clock.skew;
    fake.becomeHidden();
    clock.skew += 6 * MIN;
    // Avisos de los dos primeros segundos y de los dos últimos minutos: entre medias, nada (el proceso estaba parado).
    for (const at of [1000, 3000, 5000, 4 * MIN, 4 * MIN + 2000, 5 * MIN]) fake.wake({ source: 'tick', lagMs: 0, tick: { now: from + at, stalls: 0, writes: 0, failed: 0 } });
    fake.becomeVisible();
    await wait(150);
    const warning = states.at(-1)?.warnings.find((w) => w.includes('interrumpió la grabación')) ?? '';
    expect(warning).toContain('el móvil dejó la app congelada');
    expect(warning).toContain('Inicio automático');
    await controller.discard();
  });

  it('el anillo que el lado nativo vio caerse con la pantalla apagada se dice (con la hora que él anotó, no la de enterarse)', async () => {
    const { clock, controller, fake, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    const from = Date.now() + clock.skew;
    fake.becomeHidden();
    clock.skew += 6 * MIN;
    fake.wake({ source: 'tick', lagMs: 0, tick: { now: from + 2000, ringDownAt: from + 90_000 } });
    fake.becomeVisible();
    await wait(150);
    expect(states.at(-1)?.warnings.join(' ')).toContain('el anillo se desconectó');
    await controller.discard();
  });

  it('dos tramos seguidos se revisan juntos y el aviso se renueva en vez de apilarse', async () => {
    const { clock, controller, fake, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    fake.becomeHidden();
    clock.skew += 6 * MIN;
    fake.becomeVisible();
    fake.becomeHidden(); // vuelve a apagar antes de que dé tiempo a revisar el primer tramo
    clock.skew += 2 * MIN;
    fake.becomeVisible();
    await wait(150);
    const warnings = states.at(-1)?.warnings.filter((w) => w.includes('interrumpió la grabación')) ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('(8 min)');
    // Un tercer tramo sustituye el aviso anterior.
    fake.becomeHidden();
    clock.skew += 3 * MIN;
    fake.becomeVisible();
    await wait(150);
    expect(states.at(-1)?.warnings.filter((w) => w.includes('interrumpió la grabación'))).toHaveLength(1);
    await controller.discard();
  });

  it('si el sistema paró el servicio del GPS con el entreno en marcha, se levanta de nuevo y lo cuenta', async () => {
    const { t, controller, states } = clocked();
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    t.kill();
    await wait(80);
    expect(t.calls.filter((c) => c.endsWith(':resume'))).toHaveLength(1);
    expect(states.at(-1)?.warnings.join(' ')).toContain('Android había parado la grabación del GPS');
    expect(t.server.dead).toBe(false);
    await controller.discard();
  });

  it('al empezar avisa de los ajustes del móvil que cierran la app con la pantalla apagada; con el móvil en orden, no dice nada', async () => {
    const risky = clocked({ batteryExempt: false, phone: { autostart: false, powerSave: true } });
    await risky.controller.start('walk', { gps: true, ring: false });
    await wait(60);
    const text = risky.states.at(-1)?.warnings.join(' ') ?? '';
    expect(text).toContain('«Inicio automático» está desactivado');
    expect(text).toContain('ahorro de batería de Android');
    expect(text).toContain('Sin restricciones');
    await risky.controller.discard();
    const fine = clocked({ phone: { autostart: true, powerSave: false, bgRestricted: false } });
    await fine.controller.start('walk', { gps: true, ring: false });
    await wait(60);
    expect(fine.states.at(-1)?.warnings).toEqual([]);
    await fine.controller.discard();
  });

  it('también en un entreno sin GPS (solo se mantiene vivo)', async () => {
    const risky = clocked({ phone: { autostart: false } });
    await risky.controller.start('gym', { gps: false, ring: false });
    await wait(60);
    expect(risky.states.at(-1)?.warnings.join(' ')).toContain('«Inicio automático» está desactivado');
    await risky.controller.discard();
  });

  it('cada aviso nativo recoge las posiciones que grabó el servicio, sin esperar al temporizador (con la app oculta Android lo espacia hasta un minuto)', async () => {
    const t = fakeTracker();
    const { controller, fake, states } = setup({}, undefined, { tracker: t.tracker, deps: { trackPollEveryMs: 600_000 } }); // el temporizador casi no corre
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    const from = Date.now();
    for (let i = 0; i < 30; i++) t.record(40 + i * 0.00005, from + i * 1000, 5.5); // el servicio las graba
    expect(states.at(-1)?.snapshot?.distanceM ?? 0).toBe(0); // la web aún no las ha pedido
    fake.wake({ source: 'tick', lagMs: 0, tick: { now: Date.now(), n: 1 } });
    await wait(60);
    expect(states.at(-1)?.snapshot?.distanceM ?? 0).toBeGreaterThan(100);
    await controller.discard();
  });

  it('si había trabajo del mapa en marcha al ocultarse la app, el aviso lo cuenta', async () => {
    const clock = { skew: 0 };
    const t = fakeTracker();
    const { controller, fake, states } = setup({}, undefined, {
      tracker: t.tracker,
      deps: { now: () => Date.now() + clock.skew, trackPollEveryMs: 10, screenReportDelayMs: 20, mapBusy: () => 'bajando el mapa' },
    });
    await controller.start('walk', { gps: true, ring: false });
    await wait(40);
    fake.becomeHidden();
    clock.skew += 6 * MIN;
    fake.becomeVisible();
    await wait(120);
    const warning = states.at(-1)?.warnings.find((w) => w.includes('interrumpió la grabación')) ?? '';
    expect(warning).toContain('se estaba bajando el mapa al apagarse la pantalla');
    expect(warning).toContain('mapa: bajando el mapa');
    await controller.discard();
  });

  it('un entreno sin servicio nativo (el navegador) no revisa nada ni lo intenta', async () => {
    const { controller, fake, states } = setup({}, undefined, { deps: { screenReportDelayMs: 20 } });
    await controller.start('gym', { gps: false });
    await wait(40);
    fake.becomeHidden();
    fake.becomeVisible();
    await wait(100);
    expect(states.at(-1)?.warnings.filter((w) => w.includes('interrumpió'))).toEqual([]);
    await controller.discard();
  });
});
