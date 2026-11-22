import { describe, expect, it } from 'vitest';
import { estimateSleepOffRing } from './sleep-offring';
import { ARCHETYPES } from './sleep-offring.sim.test-support';
import { estimateSleepFromPhone } from './sleep-phone';
import { simulatePhoneLife, type PhoneLife, type PhoneSimOptions } from './sleep-phone.sim.test-support';

// La estimación con el móvil contra personas simuladas que dejan el anillo de noche (cinco horarios) y usan el móvil como la gente: sesiones de pantalla de día y de tarde, el rato en
// la cama, mirarlo de madrugada, la alarma y noches con el móvil apagado. Se compara con la estimación de antes (solo huecos de actividad: pasos del anillo, lo anotado y las
// sincronizaciones), que con las mismas vidas daba: hora de acostarse a ~47 min de la verdad de media (90 con tardes quietas), de levantarse a ~19 y duración a ~55.

const MIN = 60_000;
const SEEDS = [11, 12, 13, 14];

interface Score {
  nights: number;
  found: number;
  onset: number[];
  wake: number[];
  length: number[];
  spurious: number;
}

function evaluate(estimate: (life: PhoneLife) => Array<{ startMs: number; endMs: number }>, options: PhoneSimOptions): Score {
  const score: Score = { nights: 0, found: 0, onset: [], wake: [], length: [], spurious: 0 };
  for (const arch of ARCHETYPES)
    for (const seed of SEEDS) {
      const life = simulatePhoneLife(arch, 45, seed, options);
      const found = estimate(life);
      const matched = new Set<number>();
      for (const night of life.nights) {
        if (night.ring) continue;
        if (night.endMs <= life.input.fromMs || night.startMs >= life.input.toMs - 14 * 60 * MIN) continue;
        // Una noche con el móvil apagado no se puede estimar: no cuenta.
        if (!life.phone.coverage.some((c) => c.startMs <= night.startMs && c.endMs >= night.endMs)) continue;
        score.nights++;
        const hit = found.findIndex((e) => e.startMs < night.endMs && e.endMs > night.startMs);
        if (hit < 0) continue;
        matched.add(hit);
        const e = found[hit]!;
        score.found++;
        score.onset.push(Math.abs(e.startMs - night.startMs) / MIN);
        score.wake.push(Math.abs(e.endMs - night.endMs) / MIN);
        score.length.push(Math.abs(e.endMs - e.startMs - (night.endMs - night.startMs)) / MIN);
      }
      score.spurious += found.filter((_, i) => !matched.has(i)).length;
    }
  return score;
}

const phone = (life: PhoneLife) =>
  estimateSleepFromPhone({
    phone: life.phone,
    buckets: life.input.buckets,
    counters: life.input.counters,
    heart: life.input.heart,
    workouts: life.input.workouts,
    logged: life.input.logged,
    syncs: life.input.syncs,
    real: life.input.real,
    askedAtMs: life.input.askedAtMs,
    fromMs: life.input.fromMs,
    toMs: life.input.toMs,
  });
const before = (life: PhoneLife) => estimateSleepOffRing(life.input);
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('sueño con el móvil: simulación de personas que dejan el anillo de noche', () => {
  it('halla casi todas las noches con la hora de acostarse y de levantarse a menos de ~20 min de la verdad, y mucho mejor que solo con huecos de actividad', () => {
    const now = evaluate(phone, {});
    const old = evaluate(before, {});
    expect(now.nights).toBeGreaterThan(500);
    expect(now.found / now.nights, 'noches halladas').toBeGreaterThanOrEqual(0.97);
    expect(mean(now.onset), 'error de acostarse (media, min)').toBeLessThanOrEqual(22);
    expect(mean(now.wake), 'error de levantarse').toBeLessThanOrEqual(24);
    expect(mean(now.length), 'error de la duración').toBeLessThanOrEqual(32);
    expect(now.spurious / now.nights, 'noches inventadas').toBeLessThanOrEqual(0.04);
    expect(mean(now.onset)).toBeLessThan(mean(old.onset) * 0.6);
    expect(mean(now.length)).toBeLessThan(mean(old.length) * 0.65);
  }, 120_000);

  it('las tardes quietas (sin pasos ni nada anotado antes de acostarse) ya no son lo difícil: el móvil dice cuándo dejó de usarse', () => {
    const now = evaluate(phone, { quietEvening: 0.7 });
    const old = evaluate(before, { quietEvening: 0.7 });
    expect(now.found / now.nights).toBeGreaterThanOrEqual(0.97);
    expect(mean(now.onset)).toBeLessThanOrEqual(22);
    expect(mean(now.onset)).toBeLessThan(mean(old.onset) * 0.4);
  }, 120_000);

  it('aguanta quien se duerme con el móvil en la mano, quien lo mira mucho de madrugada y quien se pasa un buen rato con él', () => {
    for (const [name, options, minimum] of [
      ['siempre con el móvil en la cama', { inBed: 1 }, 0.97],
      ['lo mira dos veces cada noche', { nightChecks: 2 }, 0.95],
      ['una de cada tres noches, un buen rato de madrugada', { scrollNight: 0.3 }, 0.95],
    ] as const) {
      const s = evaluate(phone, options);
      expect(s.found / s.nights, name).toBeGreaterThanOrEqual(minimum);
      expect(mean(s.onset), name).toBeLessThanOrEqual(26);
      expect(mean(s.wake), name).toBeLessThanOrEqual(34);
    }
  }, 180_000);

  it('quien casi no usa el móvil (una vez por hora) también se halla, y no peor que con solo huecos de actividad', () => {
    const now = evaluate(phone, { rate: 1 });
    const old = evaluate(before, { rate: 1 });
    expect(now.found / now.nights).toBeGreaterThanOrEqual(0.95);
    expect(mean(now.onset), 'error de acostarse').toBeLessThanOrEqual(65);
    expect(mean(now.onset)).toBeLessThanOrEqual(mean(old.onset) * 1.1);
    expect(mean(now.length)).toBeLessThanOrEqual(mean(old.length));
  }, 120_000);

  it('nunca da una noche donde el registro del móvil no estaba (móvil apagado)', () => {
    for (const arch of ARCHETYPES) {
      const life = simulatePhoneLife(arch, 45, 11, { phoneOff: 0.3 });
      for (const night of phone(life)) {
        expect(life.phone.coverage.some((c) => c.startMs <= night.startMs && c.endMs >= night.endMs), `${arch.name}: ${new Date(night.startMs).toISOString()}`).toBe(true);
      }
    }
  });
});
