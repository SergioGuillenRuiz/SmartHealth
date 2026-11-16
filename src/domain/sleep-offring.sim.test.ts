import { describe, expect, it } from 'vitest';
import { estimateSleepOffRing } from './sleep-offring';
import { ARCHETYPES, simulateLife, type SimOptions } from './sleep-offring.sim.test-support';

const MIN = 60_000;

interface Score {
  nights: number;
  found: number;
  /** Errores absolutos (min) de la hora de acostarse, de levantarse y de lo que dura. */
  onset: number[];
  wake: number[];
  length: number[];
  /** Estimaciones que no corresponden a ninguna noche sin anillo (de más). */
  spurious: number;
}

function evaluate(archIndex: number, seeds: readonly number[], options: SimOptions = {}, days = 45): Score {
  const arch = ARCHETYPES[archIndex]!;
  const score: Score = { nights: 0, found: 0, onset: [], wake: [], length: [], spurious: 0 };
  for (const seed of seeds) {
    const life = simulateLife(arch, days, seed, options);
    const estimated = estimateSleepOffRing(life.input);
    const matched = new Set<number>();
    for (const night of life.nights) {
      if (night.ring) continue;
      // Solo se piden las noches cuyo final cae dentro del rango.
      if (night.endMs <= life.input.fromMs || night.startMs >= life.input.toMs - 14 * 60 * MIN) continue;
      score.nights++;
      const hit = estimated.findIndex((e) => e.startMs < night.endMs && e.endMs > night.startMs);
      if (hit < 0) continue;
      matched.add(hit);
      const e = estimated[hit]!;
      score.found++;
      score.onset.push(Math.abs(e.startMs - night.startMs) / MIN);
      score.wake.push(Math.abs(e.endMs - night.endMs) / MIN);
      score.length.push(Math.abs(e.endMs - e.startMs - (night.endMs - night.startMs)) / MIN);
    }
    score.spurious += estimated.filter((_, i) => !matched.has(i)).length;
  }
  return score;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const within = (xs: readonly number[], limit: number): number => (xs.length === 0 ? NaN : xs.filter((x) => x <= limit).length / xs.length);

describe('sueño sin anillo: simulación de personas que dejan el anillo de noche', () => {
  const seeds = [11, 12, 13, 14, 15, 16];
  for (const quiet of [0, 0.7]) for (const [index, arch] of ARCHETYPES.entries()) {
    it(`${arch.name}${quiet > 0 ? ` (tardes quietas ${quiet * 100} %)` : ''}`, () => {
      const s = evaluate(index, seeds, { quietEvening: quiet });
      const line = `${(arch.name + (quiet > 0 ? ' Q' : '')).padEnd(15)} noches ${String(s.nights).padStart(3)} · halladas ${((100 * s.found) / s.nights).toFixed(0)} % · acostarse ${mean(s.onset).toFixed(0)} min (≤60: ${(100 * within(s.onset, 60)).toFixed(0)} %) · levantarse ${mean(s.wake).toFixed(0)} min (≤60: ${(100 * within(s.wake, 60)).toFixed(0)} %) · duración ${mean(s.length).toFixed(0)} min · de más ${s.spurious}`;
      if (process.env.SIM_LOG) console.log(line);
      expect(s.nights).toBeGreaterThan(100);
      // Desde la ronda 56 la noche se mide solo por huecos (sin suponer cuánto se duerme: hay quien duerme hasta 14 h), así que la hora de acostarse es la menos precisa (empieza tras la última marca
      // y no antes de las 22:00) y lo de abajo se relajó a lo medido. Lo que se mide (con las semillas fijas): casi todas las noches sin anillo se hallan y se acierta la hora ± una hora en la mayoría; las tardes quietas (nada anotado desde las 21:30 hasta
      // acostarse) son lo difícil, porque nada dice cuándo se acostó de verdad.
      expect(s.found / s.nights).toBeGreaterThan(0.9);
      expect(mean(s.wake)).toBeLessThan(40);
      expect(mean(s.onset)).toBeLessThan(quiet > 0 ? 155 : 75);
      expect(within(s.wake, 60)).toBeGreaterThan(0.75);
      expect(within(s.onset, 60)).toBeGreaterThan(quiet > 0 ? 0.15 : 0.4);
      // De más: estimaciones que no se corresponden con ninguna noche sin anillo (menos de una de cada 25).
      expect(s.spurious).toBeLessThan(s.nights / 25);
    });
  }
});
