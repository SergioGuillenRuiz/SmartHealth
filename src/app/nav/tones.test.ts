import { afterEach, describe, expect, it, vi } from 'vitest';
import { cueForStep, vibrationFor } from '../../domain/nav/cues';
import { step } from '../../domain/nav/guidance.test-support';
import { createToneCuer, ToneCuer, tonesAvailable, type AudioContextLike, type GainLike, type OscillatorLike, type PannerLike } from './tones';

// Un audio falso que apunta qué se pidió: cuántos osciladores, a qué frecuencia, cuándo, con qué volumen y por qué lado (la panoramización es lo que decide el oído).

interface Made {
  osc: OscillatorLike & { startAt?: number; stopAt?: number; stopped: boolean };
  pan: number | null;
  /** Los puntos de la curva de volumen: [instante, volumen]. */
  curve: Array<[number, number]>;
}

function fakeAudio(options: { withPanner?: boolean; state?: string; outputLatency?: number } = {}) {
  const made: Made[] = [];
  const resumed = { count: 0 };
  let currentOsc: Made | null = null;
  const ctx: AudioContextLike = {
    currentTime: 10,
    ...(options.outputLatency !== undefined ? { outputLatency: options.outputLatency } : {}),
    state: options.state ?? 'running',
    destination: {},
    resume: () => {
      resumed.count++;
      return Promise.resolve();
    },
    createOscillator: () => {
      const osc = { type: 'sine', frequency: { value: 0 }, onended: null as (() => void) | null, stopped: false, startAt: undefined as number | undefined, stopAt: undefined as number | undefined, connect: () => undefined, start: (t: number) => void (osc.startAt = t), stop: (t: number) => {
        osc.stopAt = t;
        osc.stopped = true;
      } };
      currentOsc = { osc: osc as never, pan: null, curve: [] };
      made.push(currentOsc);
      return osc as never;
    },
    createGain: (): GainLike => {
      const target = currentOsc!;
      return {
        gain: { value: 1, setValueAtTime: (v: number, time: number) => void target.curve.push([time, v]), linearRampToValueAtTime: (v: number, time: number) => void target.curve.push([time, v]) },
        connect: () => undefined,
      };
    },
    ...(options.withPanner === false
      ? {}
      : {
          createStereoPanner: (): PannerLike => {
            const target = currentOsc!;
            const panner = { pan: { value: 0 }, connect: () => undefined };
            Object.defineProperty(panner.pan, 'value', { get: () => target.pan ?? 0, set: (v: number) => void (target.pan = v) });
            return panner;
          },
        }),
  };
  return { ctx, made, resumed };
}

const turn = (kind: 'left' | 'right') => cueForStep(step('turn', 100, 'x', { turn: kind }))!;

describe('los zumbidos', () => {
  it('girar a la izquierda: dos zumbidos solo en el canal izquierdo', () => {
    const { ctx, made } = fakeAudio();
    new ToneCuer(ctx).cue(turn('left'));
    expect(made).toHaveLength(2);
    expect(made.map((m) => m.pan)).toEqual([-1, -1]);
    expect(made.every((m) => m.osc.type === 'sawtooth' && m.osc.frequency.value < 400)).toBe(true);
  });

  it('girar a la derecha: solo en el canal derecho', () => {
    const { ctx, made } = fakeAudio();
    new ToneCuer(ctx).cue(turn('right'));
    expect(made.map((m) => m.pan)).toEqual([1, 1]);
  });

  it('un aviso para los dos oídos suena en el centro', () => {
    const { ctx, made } = fakeAudio();
    new ToneCuer(ctx).cue({ kind: 'arrive', ear: 'both' });
    expect(made.map((m) => m.pan)).toEqual([0, 0, 0]);
  });

  it('los zumbidos se programan en el futuro, uno detrás de otro, sin pisarse', () => {
    const { ctx, made } = fakeAudio();
    new ToneCuer(ctx).cue(turn('left'));
    const [a, b] = made;
    expect(a!.osc.startAt!).toBeGreaterThan(10);
    expect(b!.osc.startAt!).toBeGreaterThan(a!.osc.stopAt!);
  });

  it('un aviso urgente corta lo que aún suena', () => {
    const { ctx, made } = fakeAudio();
    const cuer = new ToneCuer(ctx);
    cuer.cue(turn('left'));
    const first = [...made];
    cuer.cue(turn('right'), { interrupt: true });
    expect(first.every((m) => m.osc.stopped)).toBe(true);
    expect(made).toHaveLength(4);
  });

  it('despierta el audio si estaba dormido (hace falta un gesto de la persona)', () => {
    const { ctx, resumed } = fakeAudio({ state: 'suspended' });
    new ToneCuer(ctx).unlock();
    expect(resumed.count).toBe(1);
    const awake = fakeAudio({ state: 'running' });
    new ToneCuer(awake.ctx).unlock();
    expect(awake.resumed.count).toBe(0);
  });

  it('cada zumbido tiembla: el volumen sube y baja muchas veces por segundo entre el máximo y casi el silencio (eso es lo que lo hace zumbar y no pitar)', () => {
    const { ctx, made } = fakeAudio();
    new ToneCuer(ctx).cue(turn('left'));
    const first = made[0]!;
    const volumes = first.curve.map(([, v]) => v);
    const peak = Math.max(...volumes);
    const dips = volumes.filter((v) => v > 0 && v < peak * 0.3).length;
    expect(dips).toBeGreaterThanOrEqual(4); // 260 ms a unos 38 temblores por segundo son ≈ 9 subidas y bajadas
    expect(volumes.filter((v) => v === peak).length).toBeGreaterThanOrEqual(4);
    expect(first.curve.at(-1)![1]).toBe(0); // acaba en silencio (sin chasquido)
    for (let i = 1; i < first.curve.length; i++) expect(first.curve[i]![0]).toBeGreaterThanOrEqual(first.curve[i - 1]![0]); // la curva avanza en el tiempo
    const span = first.curve.at(-1)![0] - first.curve[0]![0];
    expect(span).toBeLessThan(0.3);
  });

  it('un aviso programado (delayMs) suena en su instante, no antes', () => {
    const { ctx, made } = fakeAudio();
    const cuer = new ToneCuer(ctx);
    cuer.cue(turn('left'), { delayMs: 800 });
    expect(made[0]!.osc.startAt!).toBeCloseTo(10.8, 2);
    cuer.cue(turn('left'));
    expect(made[2]!.osc.startAt!).toBeLessThan(10.1);
  });

  it('se adelanta lo que tarda el audio en salir por el altavoz (outputLatency), sin pasarse', () => {
    const slow = fakeAudio({ outputLatency: 0.12 });
    new ToneCuer(slow.ctx).cue(turn('left'), { delayMs: 800 });
    expect(slow.made[0]!.osc.startAt!).toBeCloseTo(10.68, 2);
    const absurd = fakeAudio({ outputLatency: 5 });
    new ToneCuer(absurd.ctx).cue(turn('left'), { delayMs: 800 });
    expect(absurd.made[0]!.osc.startAt!).toBeCloseTo(10.55, 2); // como mucho 250 ms
  });

  it('un aviso inmediato nunca se programa en el pasado aunque el audio diga que tarda mucho', () => {
    const { ctx, made } = fakeAudio({ outputLatency: 0.2 });
    new ToneCuer(ctx).cue(turn('left'));
    expect(made[0]!.osc.startAt!).toBeGreaterThan(10);
  });

  it('sin panoramización suena igual (centrado) en vez de fallar', () => {
    const { ctx, made } = fakeAudio({ withPanner: false });
    new ToneCuer(ctx).cue(turn('left'));
    expect(made).toHaveLength(2);
  });

  it('si el audio falla, avisa una vez y no rompe la guía', () => {
    const { ctx } = fakeAudio();
    const broken: AudioContextLike = { ...ctx, createOscillator: () => { throw new Error('sin audio'); } };
    const problems: string[] = [];
    new ToneCuer(broken, (m) => problems.push(m)).cue(turn('left'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/solo en pantalla/);
  });

  it('cortar (stop) para también lo que estaba programado para más tarde', () => {
    const { ctx, made } = fakeAudio();
    const cuer = new ToneCuer(ctx);
    cuer.cue(turn('left'), { delayMs: 1000 });
    cuer.stop();
    expect(made.every((m) => m.osc.stopped)).toBe(true);
  });

  it('createToneCuer: sin Web Audio devuelve null; con él, un cuer listo', () => {
    expect(tonesAvailable({})).toBe(false);
    expect(createToneCuer(undefined, {})).toBeNull();
    const { ctx } = fakeAudio();
    class Fake {
      constructor() {
        return ctx as never;
      }
    }
    expect(tonesAvailable({ AudioContext: Fake as never })).toBe(true);
    expect(createToneCuer(undefined, { AudioContext: Fake as never })).toBeInstanceOf(ToneCuer);
    expect(createToneCuer(undefined, { webkitAudioContext: Fake as never })).toBeInstanceOf(ToneCuer);
  });
});

describe('la vibración del móvil', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('vibra con el mismo ritmo que los zumbidos, a la vez que suenan', () => {
    const { ctx } = fakeAudio();
    const calls: number[][] = [];
    new ToneCuer(ctx, undefined, (pattern) => (calls.push(pattern), true)).cue(turn('left'));
    expect(calls).toEqual([vibrationFor(turn('left'))]);
  });

  it('un aviso programado vibra en su instante (y no antes)', () => {
    vi.useFakeTimers();
    const { ctx } = fakeAudio();
    const calls: number[][] = [];
    new ToneCuer(ctx, undefined, (pattern) => (calls.push(pattern), true)).cue(turn('left'), { delayMs: 900 });
    vi.advanceTimersByTime(800);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(150);
    expect(calls).toHaveLength(1);
  });

  it('cortar cancela la vibración que estaba programada', () => {
    vi.useFakeTimers();
    const { ctx } = fakeAudio();
    const calls: number[][] = [];
    const cuer = new ToneCuer(ctx, undefined, (pattern) => (calls.push(pattern), true));
    cuer.cue(turn('left'), { delayMs: 900 });
    cuer.stop();
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(0);
  });

  it('si el móvil no deja vibrar (o falla) el sonido sigue sin avisos de error', () => {
    const { ctx, made } = fakeAudio();
    const problems: string[] = [];
    new ToneCuer(ctx, (m) => problems.push(m), () => {
      throw new Error('sin permiso');
    }).cue(turn('left'));
    expect(made).toHaveLength(2);
    expect(problems).toEqual([]);
    const without = fakeAudio();
    new ToneCuer(without.ctx).cue(turn('left'));
    expect(without.made).toHaveLength(2);
  });

  it('createToneCuer usa la vibración del WebView si existe', () => {
    const { ctx } = fakeAudio();
    class Fake {
      constructor() {
        return ctx as never;
      }
    }
    const calls: number[][] = [];
    const cuer = createToneCuer(undefined, { AudioContext: Fake as never, navigator: { vibrate: (p: number[]) => (calls.push(p), true) } })!;
    cuer.cue(turn('right'));
    expect(calls).toHaveLength(1);
  });
});
