import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RingError } from '../ble/errors';
import { dayKeyOf } from '../domain/dates';
import type { LiveRefreshResult, LiveSteps } from '../sync/live-refresh';
import { AutoSync, baselineFromSync, BUSY_RETRY_MS, FULL_EVERY_MS, FULL_RETRY_MS, LIVE_EVERY_MS, MAX_BACKOFF_MS, MAX_QUIET_EVERY_MS, MIN_GAP_MS, RESUME_DELAY_MS, type AutoSyncDeps } from './auto-sync';

const START = new Date(2026, 6, 10, 10, 0, 0).getTime();

interface Harness {
  controller: AutoSync;
  deps: AutoSyncDeps;
  eligible: { value: boolean };
  busy: { value: boolean };
  lastFull: { value: number | null; fresh: boolean };
  calls: string[];
  /** Respuestas de las lecturas, en orden; si no quedan, la ligera trae lo mismo que la anterior. */
  fullResults: Array<'ok' | Error>;
  liveResults: Array<Partial<LiveRefreshResult> | Error>;
  signals: AbortSignal[];
  baseline: { value: LiveSteps | null };
  changed: number;
}

function harness(options: { hold?: boolean } = {}): Harness {
  const h = {
    eligible: { value: true },
    busy: { value: false },
    lastFull: { value: null as number | null, fresh: false },
    calls: [] as string[],
    fullResults: [] as Array<'ok' | Error>,
    liveResults: [] as Array<Partial<LiveRefreshResult> | Error>,
    signals: [] as AbortSignal[],
    baseline: { value: null as LiveSteps | null },
    changed: 0,
  };
  let steps = 1000;
  const deps: AutoSyncDeps = {
    now: () => Date.now(),
    eligible: () => h.eligible.value,
    claim: () => {
      if (h.busy.value) return null;
      h.busy.value = true;
      h.calls.push('claim');
      return () => {
        h.busy.value = false;
        h.calls.push('release');
      };
    },
    // `fresh`: la última completa es siempre «de ahora» (la completa no toca en toda la prueba).
    lastFullMs: () => (h.lastFull.fresh ? Date.now() : h.lastFull.value),
    baseline: () => h.baseline.value,
    full: async (signal) => {
      h.calls.push('full');
      h.signals.push(signal);
      if (options.hold) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      const result = h.fullResults.shift() ?? 'ok';
      if (signal.aborted) throw new RingError('Sincronización cancelada.', 'aborted');
      if (result instanceof Error) throw result;
      h.lastFull.value = Date.now();
    },
    live: async (signal, previous) => {
      h.calls.push(`live(${previous === null ? 'null' : previous.steps})`);
      h.signals.push(signal);
      if (options.hold) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      const result = h.liveResults.shift();
      if (signal.aborted) throw new RingError('Actualización cancelada.', 'aborted');
      if (result instanceof Error) throw result;
      steps = result?.steps === undefined ? steps : (result.steps ?? steps);
      return { steps, atMs: Date.now(), changed: false, batteryPercent: 80, ...result };
    },
    changed: () => {
      h.changed++;
    },
  };
  const controller = new AutoSync(deps);
  return { controller, deps, ...h, get changed() { return h.changed; } } as Harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('AutoSync: cuándo lee el anillo', () => {
  it('al arrancar espera un momento (que pinte la pantalla) y, sin ninguna sincronización completa, hace una completa', async () => {
    const h = harness();
    h.controller.start();
    await advance(RESUME_DELAY_MS - 1);
    expect(h.calls).toEqual([]);
    await advance(1);
    expect(h.calls).toEqual(['claim', 'full', 'release']);
  });

  it('tras la completa lee solo los pasos cada minuto, y vuelve a traer el historial a los diez', async () => {
    const h = harness();
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(1);

    await advance(LIVE_EVERY_MS - 1);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(0);
    await advance(1);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(1);

    // Con los pasos siempre cambiando (se anda), sigue cada minuto hasta que toca el historial.
    for (let i = 0; i < 20; i++) {
      h.liveResults.push({ steps: 1000 + i * 40, changed: true });
    }
    await advance(FULL_EVERY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(2);
    expect(h.calls.filter((c) => c.startsWith('live')).length).toBeGreaterThanOrEqual(8);
    h.controller.stop();
  });

  it('si ya hay una sincronización completa reciente (hecha a mano), empieza por la ligera', async () => {
    const h = harness();
    h.lastFull.value = START - 2 * 60_000;
    h.baseline.value = { day: dayKeyOf(START), steps: 4321, atMs: START - 2 * 60_000 };
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'live(4321)', 'release']); // la base es lo que ya se sabe de la completa
  });

  it('la base de la ligera es la última lectura propia, y tras una completa vuelve a ser la de esa completa', async () => {
    const h = harness();
    h.lastFull.value = START;
    h.controller.start();
    h.liveResults.push({ steps: 1500, changed: true }, { steps: 1500, changed: false });
    await advance(RESUME_DELAY_MS);
    await advance(LIVE_EVERY_MS * 2);
    expect(h.calls.filter((c) => c.startsWith('live'))).toEqual(['live(null)', 'live(1500)']);
    h.controller.stop();
  });

  it('los pasos solo se repintan cuando cambian', async () => {
    const h = harness();
    h.lastFull.fresh = true;
    h.controller.start();
    h.liveResults.push({ steps: 1100, changed: true }, { steps: 1100, changed: false }, { steps: 1150, changed: true });
    await advance(RESUME_DELAY_MS);
    expect(h.changed).toBe(1);
    await advance(MAX_QUIET_EVERY_MS * 2);
    expect(h.changed).toBe(2);
    h.controller.stop();
  });

  it('sentado (pasos sin cambios) espacia las lecturas hasta un tope, y en cuanto se anda vuelve a cada minuto', async () => {
    const h = harness();
    h.lastFull.fresh = true; // la completa no toca en toda la prueba
    for (let i = 0; i < 6; i++) h.liveResults.push({ changed: false });
    h.liveResults.push({ steps: 2000, changed: true }, { changed: false });
    const times: number[] = [];
    const original = h.deps.live;
    h.deps.live = async (signal, previous) => {
      times.push(Date.now());
      return original(signal, previous);
    };
    h.controller.start();
    await advance(RESUME_DELAY_MS + 40 * 60_000);
    h.controller.stop();
    const gaps = times.slice(1).map((t, i) => Math.round((t - (times[i] ?? 0)) / 60_000));
    // Primera lectura a los 1,5 s; luego a los 2, 3, 4 y 5 minutos, y se queda en el tope (5) mientras no haya pasos nuevos; con los
    // pasos nuevos vuelve a cada minuto y de ahí a espaciarse otra vez.
    expect(gaps.slice(0, 8)).toEqual([2, 3, 4, 5, 5, 5, 1, 2]);
    expect(MAX_QUIET_EVERY_MS).toBe(5 * 60_000);
  });

  it('con otra cosa usando el anillo no hace nada y se asoma de nuevo a los 10 s, sin avisar a nadie', async () => {
    const h = harness();
    h.busy.value = true;
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual([]);
    await advance(BUSY_RETRY_MS * 3);
    expect(h.calls).toEqual([]);
    h.busy.value = false;
    await advance(BUSY_RETRY_MS);
    expect(h.calls).toEqual(['claim', 'full', 'release']);
    h.controller.stop();
  });
});

describe('AutoSync: cuando falla', () => {
  const unreachable = (): RingError => new RingError('No se encontró el anillo.', 'connect-failed');

  it('espera el doble tras cada fallo seguido, hasta un tope, y vuelve a lo normal con el primer acierto', async () => {
    const h = harness();
    h.lastFull.fresh = true; // la completa no toca en toda la prueba
    h.liveResults.push(unreachable(), unreachable(), unreachable(), unreachable(), { changed: true, steps: 1500 }, { changed: true, steps: 1600 });
    const times: number[] = [];
    const original = h.deps.live;
    h.deps.live = async (signal, previous) => {
      times.push(Date.now());
      return original(signal, previous);
    };
    h.controller.start();
    await advance(RESUME_DELAY_MS + 30 * 60_000);
    h.controller.stop();
    const gaps = times.slice(1).map((t, i) => Math.round((t - (times[i] ?? 0)) / 60_000));
    // 1.er fallo: 2 min; 2.º: 4 min; luego el tope (4 min), también tras el 4.º; con el primer acierto, otra vez cada minuto.
    expect(gaps.slice(0, 5)).toEqual([2, 4, 4, 4, 1]);
    expect(MAX_BACKOFF_MS).toBe(4 * 60_000);
  });

  it('el Bluetooth apagado o sin permisos no cuesta nada: se reintenta al minuto, sin esperas largas', async () => {
    const h = harness();
    h.lastFull.value = START;
    h.liveResults.push(new RingError('El Bluetooth del móvil está apagado.', 'unsupported-platform'), new RingError('El Bluetooth del móvil está apagado.', 'unsupported-platform'), new RingError('El Bluetooth del móvil está apagado.', 'unsupported-platform'));
    h.controller.start();
    await advance(RESUME_DELAY_MS + 3 * LIVE_EVERY_MS);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(4);
    h.controller.stop();
  });

  it('una completa que falla no se repite hasta pasados diez minutos: entre medias sigue la lectura ligera', async () => {
    const h = harness();
    h.fullResults.push(unreachable());
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(1);
    // Segundo intento a los 2 min (el primer fallo espera el doble): toca la completa de nuevo, pero hace menos de 10 min.
    await advance(2 * LIVE_EVERY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith('live')).length).toBeGreaterThanOrEqual(1);
    await advance(FULL_RETRY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(2);
    h.controller.stop();
  });

  it('el reloj no pierde el hilo si una lectura revienta con un error cualquiera', async () => {
    const h = harness();
    h.lastFull.value = START;
    h.liveResults.push(new Error('boom'));
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    await advance(2 * LIVE_EVERY_MS);
    expect(h.calls.filter((c) => c.startsWith('live')).length).toBeGreaterThanOrEqual(2);
    expect(h.calls.filter((c) => c === 'release').length).toBe(h.calls.filter((c) => c === 'claim').length); // nunca deja el anillo reservado
    h.controller.stop();
  });
});

describe('AutoSync: la app a la vista, el ajuste y el anillo', () => {
  it('con la app oculta (o el ajuste apagado, o sin anillo) no programa nada; al volver, se pone al día pronto', async () => {
    const h = harness();
    h.eligible.value = false;
    h.controller.start();
    await advance(60 * 60_000);
    expect(h.calls).toEqual([]);

    h.eligible.value = true;
    h.controller.recheck();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'full', 'release']);
    h.controller.stop();
  });

  it('al ocultarse la app corta la lectura en marcha, suelta el anillo, no cuenta un fallo y no reprograma', async () => {
    const h = harness({ hold: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'full']);
    expect(h.busy.value).toBe(true);

    h.eligible.value = false;
    h.controller.recheck();
    await advance(0);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.busy.value).toBe(false); // soltó el anillo
    await advance(60 * 60_000);
    expect(h.calls).toEqual(['claim', 'full', 'release']); // y no volvió a intentarlo con la app oculta
    h.controller.stop();
  });

  it('al volver a verse no repite lo que acaba de hacer: espera hasta que pasen 20 s desde la última lectura', async () => {
    const h = harness();
    h.lastFull.value = START;
    h.controller.start();
    await advance(RESUME_DELAY_MS); // lectura ligera a los 1,5 s
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(1);

    h.eligible.value = false;
    h.controller.recheck();
    await advance(5_000);
    h.eligible.value = true;
    h.controller.recheck(); // vuelve a los 6,5 s: han pasado 5 s desde la última lectura
    await advance(MIN_GAP_MS - 5_000 - 1);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(1);
    await advance(1);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(2);
    h.controller.stop();
  });

  it('volver a verse tras un tiempo largo lee casi al momento', async () => {
    const h = harness();
    h.lastFull.value = START - 3 * 3_600_000;
    h.eligible.value = false;
    h.controller.start();
    await advance(2 * 3_600_000);
    h.eligible.value = true;
    h.controller.recheck();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'full', 'release']); // la última completa es de hace horas: toca el historial
    h.controller.stop();
  });

  it('un cambio que no altera si puede trabajar (otro ajuste, el anillo que se relee) no reinicia la espera', async () => {
    const h = harness();
    h.lastFull.fresh = true;
    h.liveResults.push({ changed: true, steps: 1100 }); // se anda: la siguiente lectura es al minuto
    h.controller.start();
    await advance(RESUME_DELAY_MS + LIVE_EVERY_MS - 10_000);
    const before = h.calls.length;
    h.controller.recheck();
    h.controller.recheck();
    await advance(10_000 + 1);
    expect(h.calls.length).toBeGreaterThan(before); // la lectura sale a su hora: no se retrasó
    h.controller.stop();
  });

  it('parada del todo (stop): no vuelve a programar nada', async () => {
    const h = harness();
    h.controller.start();
    h.controller.stop();
    await advance(60 * 60_000);
    expect(h.calls).toEqual([]);
    h.controller.recheck();
    await advance(60 * 60_000);
    expect(h.calls).toEqual([]);
  });
});

describe('AutoSync: relojes y lecturas dudosas', () => {
  it('si la app se oculta y vuelve a verse mientras la lectura cortada aún suelta el enlace, la siguiente llega a los 20 s, no a los 60', async () => {
    const h = harness({ hold: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'full']);

    h.eligible.value = false;
    h.controller.recheck(); // corta la lectura…
    h.eligible.value = true;
    h.controller.recheck(); // …y la app vuelve a verse antes de que acabe de soltar el enlace
    await advance(MIN_GAP_MS - 1);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(1);
    await advance(1);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(2);
    h.controller.stop();
  });

  it('con el reloj del móvil atrasado dos horas, al volver a ver la app no espera horas: la espera se acota a 20 s', async () => {
    const h = harness();
    h.lastFull.fresh = true;
    h.liveResults.push({ steps: 1100, changed: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(1);

    h.eligible.value = false;
    h.controller.recheck();
    vi.setSystemTime(START - 2 * 3_600_000); // alguien corrige la hora del móvil
    h.eligible.value = true;
    h.controller.recheck();
    await advance(MIN_GAP_MS);
    expect(h.calls.filter((c) => c.startsWith('live'))).toHaveLength(2);
    h.controller.stop();
  });

  it('una sincronización completa «del futuro» (el reloj se atrasó después) no bloquea la completa: se da por vencida', async () => {
    const h = harness();
    h.lastFull.value = START + 3_600_000;
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls).toEqual(['claim', 'full', 'release']);
    h.controller.stop();
  });

  it('una lectura que no se creyó (subida imposible) no pasa a ser la base de la siguiente', async () => {
    const h = harness();
    h.lastFull.fresh = true;
    h.liveResults.push({ steps: 9000, changed: false, implausible: true }, { steps: 1150, changed: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    await advance(2 * LIVE_EVERY_MS); // quieta: la siguiente a los 2 min
    // La segunda lectura compara con lo que se sabía antes (nada), no con el 9000 dudoso.
    expect(h.calls.filter((c) => c.startsWith('live'))).toEqual(['live(null)', 'live(null)']);
    h.controller.stop();
  });
});

describe('baselineFromSync (la base de la lectura ligera)', () => {
  it('son los pasos que leyó la última sincronización completa, con la hora en que acabó', () => {
    expect(baselineFromSync({ tsMs: START, liveSteps: 4200 }, START + 60_000)).toEqual({ day: dayKeyOf(START), steps: 4200, atMs: START });
  });

  it('sin lectura del contador, sin sincronización, o con una «del futuro» (el reloj del móvil se atrasó después) no hay base: no se sabe cuánto tiempo ha pasado', () => {
    expect(baselineFromSync(null, START)).toBeNull();
    expect(baselineFromSync({ tsMs: START, liveSteps: null }, START + 1000)).toBeNull();
    expect(baselineFromSync({ tsMs: START + 2 * 3_600_000, liveSteps: 4200 }, START)).toBeNull();
    expect(baselineFromSync({ tsMs: START, liveSteps: 4200 }, START)).not.toBeNull(); // la misma hora sí vale
  });
});

describe('AutoSync: ceder el anillo a lo que pida la persona', () => {
  it('sin ninguna lectura en marcha no espera nada', async () => {
    const h = harness();
    h.controller.start();
    await expect(h.controller.yieldRing()).resolves.toBeUndefined();
    h.controller.stop();
  });

  it('con una lectura en marcha, la corta y devuelve el control cuando el anillo ya está suelto', async () => {
    const h = harness({ hold: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.controller.running).toBe(true);
    expect(h.busy.value).toBe(true);

    let resolved = false;
    const yielding = h.controller.yieldRing().then(() => (resolved = true));
    await advance(0);
    await yielding;
    expect(resolved).toBe(true);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.busy.value).toBe(false); // ya se puede reservar
    expect(h.controller.running).toBe(false);
    h.controller.stop();
  });

  it('una cancelada no cuenta como fallo ni como intento de completa: en cuanto el anillo esté libre, vuelve a lo suyo', async () => {
    const h = harness({ hold: true });
    h.controller.start();
    await advance(RESUME_DELAY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(1);
    void h.controller.yieldRing();
    await advance(0);
    // La persona termina lo suyo; la automática se asoma al minuto (sin esperas por fallo) y como la completa no llegó a hacerse, la repite.
    await advance(LIVE_EVERY_MS);
    expect(h.calls.filter((c) => c === 'full')).toHaveLength(2);
    h.controller.stop();
  });

  it('no espera para siempre a un anillo que no se suelta', async () => {
    const h = harness();
    // Una lectura que ignora la cancelación (una conexión colgada).
    h.deps.full = async () => {
      h.calls.push('full');
      await new Promise<void>(() => undefined);
    };
    const stuck = new AutoSync(h.deps);
    stuck.start();
    await advance(RESUME_DELAY_MS);
    let resolved = false;
    void stuck.yieldRing(5_000).then(() => (resolved = true));
    await advance(4_999);
    expect(resolved).toBe(false);
    await advance(1);
    expect(resolved).toBe(true);
    stuck.stop();
  });
});
