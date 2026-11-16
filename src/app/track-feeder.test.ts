import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackFeeder, type TrackerProblem } from './track-feeder';
import type { TrackFix } from './tracker';
import { fakeTracker, type FakeTrackerOptions } from './tracker.test-support';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function build(options: FakeTrackerOptions = {}) {
  const fake = fakeTracker(options);
  const delivered: TrackFix[] = [];
  const problems: Array<TrackerProblem | null> = [];
  const feeder = new TrackFeeder({
    tracker: fake.tracker,
    sessionId: 'w-1',
    startedAtMs: 1000,
    title: 'SmartHealth',
    text: 'Caminar: grabando la ruta',
    onFix: (fix) => delivered.push(fix),
    onProblem: (problem) => problems.push(problem),
    pollEveryMs: 1000,
  });
  return { ...fake, feeder, delivered, problems };
}

describe('TrackFeeder: recoge las posiciones que graba el servicio nativo', () => {
  it('pide los permisos, arranca la grabación con el identificador del entreno y recoge cada segundo', async () => {
    const { feeder, calls, record, delivered } = build();
    expect(await feeder.start()).toBe('ok');
    expect(calls.slice(0, 2)).toEqual(['askPermissions', 'start:w-1']);
    record(40, 10_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered.map((fix) => fix.seq)).toEqual([1]);
    record(40.0001, 11_000);
    record(40.0002, 12_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered.map((fix) => fix.seq)).toEqual([1, 2, 3]);
    await feeder.stop({ clear: true });
  });

  it('cada posición se entrega UNA vez y en orden, aunque se pida recoger varias veces seguidas', async () => {
    const { feeder, record, delivered, calls } = build();
    await feeder.start();
    for (let i = 0; i < 5; i++) record(40 + i / 1e4, 1000 * (i + 1));
    await Promise.all([feeder.flush(), feeder.flush(), feeder.flush()]);
    await feeder.flush();
    expect(delivered.map((fix) => fix.seq)).toEqual([1, 2, 3, 4, 5]);
    // Siempre pide «las posteriores a la última entregada»: nunca vuelve a pedir lo ya recogido.
    const asked = calls.filter((c) => c.startsWith('fixes:')).map((c) => Number(c.slice(6)));
    expect(asked.every((since, i) => i === 0 || since >= (asked[i - 1] ?? 0))).toBe(true);
    await feeder.stop({ clear: true });
  });

  it('una pista larga (más que el lote) se recoge entera, en varias vueltas', async () => {
    const { feeder, record, delivered } = build();
    await feeder.start();
    for (let i = 0; i < 4500; i++) record(40 + i / 1e5, 1000 * (i + 1));
    await feeder.flush();
    expect(delivered).toHaveLength(4500);
    expect(delivered.at(-1)?.seq).toBe(4500);
    await feeder.stop({ clear: true });
  });

  it('al parar recoge lo último, para el servicio y borra la pista (en ese orden); sin borrar, la deja', async () => {
    const { feeder, record, delivered, calls } = build();
    await feeder.start();
    record(40, 1000);
    calls.length = 0;
    await feeder.stop({ clear: true });
    expect(delivered).toHaveLength(1);
    expect(calls).toEqual(['fixes:0', 'stop', 'clear:w-1']);

    const keep = build();
    await keep.feeder.start();
    keep.calls.length = 0;
    await keep.feeder.stop({ clear: false });
    expect(keep.calls).toEqual(['fixes:0', 'stop']);
  });

  it('tras parar ya no recoge nada ni deja un temporizador vivo', async () => {
    const { feeder, record, delivered, calls } = build();
    await feeder.start();
    await feeder.stop({ clear: true });
    calls.length = 0;
    record(40, 5000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    expect(delivered).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('si se manda parar mientras todavía se pedían los permisos, no se queda recogiendo', async () => {
    const fake = fakeTracker();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ask = fake.tracker.askPermissions;
    fake.tracker.askPermissions = async () => {
      await gate;
      return ask();
    };
    const feeder = new TrackFeeder({ tracker: fake.tracker, sessionId: 'w-1', startedAtMs: 0, title: 't', text: 'x', onFix: () => undefined, pollEveryMs: 1000 });
    const starting = feeder.start();
    const stopping = feeder.stop({ clear: true });
    release();
    await Promise.all([starting, stopping]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TrackFeeder: cuando algo falla', () => {
  it('sin permiso de ubicación no se arranca nada', async () => {
    const { feeder, calls } = build({ denyLocation: true });
    expect(await feeder.start()).toBe('denied');
    expect(calls).toEqual(['askPermissions']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('si el servicio rechaza por falta de permiso es «denied»; por cualquier otra cosa, «failed» (se usa el GPS de la web)', async () => {
    expect(await build({ failStart: 'permission' }).feeder.start()).toBe('denied');
    expect(await build({ failStart: 'error' }).feeder.start()).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('si lo que se hace con una posición lanza un error, la recogida sigue viva y no queda un rechazo sin atender', async () => {
    const fake = fakeTracker();
    const delivered: number[] = [];
    let boom = true;
    const feeder = new TrackFeeder({
      tracker: fake.tracker,
      sessionId: 'w-1',
      startedAtMs: 1000,
      title: 't',
      text: 'x',
      onFix: (fix) => {
        if (boom) {
          boom = false;
          throw new Error('fallo al colocar la posición');
        }
        delivered.push(fix.seq);
      },
      pollEveryMs: 1000,
    });
    await feeder.start();
    fake.record(40, 1000);
    await vi.advanceTimersByTimeAsync(1000); // la primera lanza
    fake.record(40.0001, 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toEqual([2]); // la siguiente vuelta sigue funcionando
    await feeder.stop({ clear: true });
  });

  it('avisa si el GPS del móvil está apagado, y avisa de que ya no lo está', async () => {
    const { feeder, server, problems, record } = build({ gpsEnabled: false });
    await feeder.start();
    expect(problems).toEqual([{ kind: 'gps-off' }]);
    await vi.advanceTimersByTimeAsync(3000); // no repite el mismo aviso
    expect(problems).toHaveLength(1);
    server.gpsEnabled = true;
    record(40, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(problems).toEqual([{ kind: 'gps-off' }, null]);
    await feeder.stop({ clear: true });
  });

  it('si el servicio dice que no pudo grabar, lo avisa con su motivo', async () => {
    const { feeder, server, problems } = build();
    await feeder.start();
    server.error = 'Sin permiso de ubicación.';
    await vi.advanceTimersByTimeAsync(1000);
    expect(problems).toEqual([{ kind: 'error', message: 'Sin permiso de ubicación.' }]);
    await feeder.stop({ clear: true });
  });

  it('tres fallos seguidos al pedir las posiciones avisan (una vez) y el siguiente acierto sigue entregando', async () => {
    const { feeder, server, problems, record, delivered } = build();
    await feeder.start();
    server.failFixes = 3;
    record(40, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(problems).toEqual([{ kind: 'unreachable' }]);
    await vi.advanceTimersByTimeAsync(2000); // vuelve a contestar
    expect(delivered.map((fix) => fix.seq)).toEqual([1]);
    await feeder.stop({ clear: true });
  });
});

describe('TrackFeeder: el sistema para el servicio con el entreno en marcha', () => {
  function revivable() {
    const fake = fakeTracker();
    const delivered: number[] = [];
    const problems: Array<TrackerProblem | null> = [];
    const revived = vi.fn();
    const feeder = new TrackFeeder({
      tracker: fake.tracker,
      sessionId: 'w-1',
      startedAtMs: 1000,
      title: 'SmartHealth',
      text: 'Caminar: grabando la ruta',
      onFix: (fix) => delivered.push(fix.seq),
      onProblem: (problem) => problems.push(problem),
      onRevived: revived,
      pollEveryMs: 1000,
    });
    return { ...fake, feeder, delivered, problems, revived };
  }

  it('lo vuelve a levantar (con `resume`, sin tocar la pausa de la notificación) y la pista sigue por donde iba', async () => {
    const { feeder, kill, calls, record, delivered, revived, server } = revivable();
    await feeder.start();
    record(40, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toEqual([1]);
    kill(); // el móvil lo paró con la pantalla apagada
    await vi.advanceTimersByTimeAsync(1000);
    expect(revived).not.toHaveBeenCalled(); // una recogida sola puede ser un servicio arrancando
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.startsWith('start:'))).toEqual(['start:w-1', 'start:w-1:resume']);
    expect(revived).toHaveBeenCalledTimes(1);
    expect(server.dead).toBe(false);
    record(40.0001, 5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toEqual([1, 2]);
    await feeder.stop({ clear: true });
  });

  it('no insiste cada segundo: si no consigue levantarlo espera 15 s entre intentos', async () => {
    const { feeder, kill, tracker, revived } = revivable();
    await feeder.start();
    const start = tracker.start;
    let attempts = 0;
    tracker.start = async (request) => {
      if (request.resume) {
        attempts++;
        throw new Error('Android no deja arrancarlo desde segundo plano');
      }
      return start(request);
    };
    kill();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
    expect(revived).not.toHaveBeenCalled();
    await feeder.stop({ clear: true });
  });

  it('un entreno que ya no está activo (parado desde la notificación o con error) no se levanta', async () => {
    const stopped = revivable();
    await stopped.feeder.start();
    stopped.press('stop', 1000, false); // parar desde la notificación deja el servicio inactivo
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped.calls.filter((c) => c.startsWith('start:'))).toEqual(['start:w-1']);
    const failed = revivable();
    await failed.feeder.start();
    failed.server.error = 'Sin permiso de ubicación.';
    failed.kill();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed.calls.filter((c) => c.startsWith('start:'))).toEqual(['start:w-1']);
    await stopped.feeder.stop({ clear: true });
    await failed.feeder.stop({ clear: true });
  });

  it('con la app oculta no lo intenta (Android no deja arrancar un servicio en primer plano desde el fondo)', async () => {
    const { feeder, kill, calls, revived } = revivable();
    await feeder.start();
    const page = { visibilityState: 'hidden' };
    vi.stubGlobal('document', page);
    try {
      kill();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.filter((c) => c.endsWith(':resume'))).toHaveLength(0);
      page.visibilityState = 'visible';
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls.filter((c) => c.endsWith(':resume'))).toHaveLength(1);
      expect(revived).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
    await feeder.stop({ clear: true });
  });
});
