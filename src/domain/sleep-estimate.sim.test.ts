import { describe, expect, it } from 'vitest';
import { estimateSleep } from './sleep-estimate';
import { evaluate, simulate, summarize, type Profile, type Schedule, type SimOptions, type Summary } from './sleep-sim.test-support';

// La estimación contra una persona simulada de la que se conoce la noche de verdad: horarios de noche, tardíos, de día, rotativos e
// irregulares; pasos activos, de oficina y mixtos; pulso cada 30 o 60 min; escapadas al baño, siestas, sofá antes de acostarse, huecos
// de datos. Con el algoritmo anterior (umbrales fijos sobre el pulso) las mismas simulaciones daban: noches halladas 66 %, inicio a 87 min
// y duración a 103 min de la verdad (medianas). Los límites de aquí son los que debe cumplir el actual, con algo de margen.

const schedules: Schedule[] = ['night', 'late', 'day', 'rotating', 'irregular'];
const profiles: Profile[] = ['active', 'desk', 'mixed'];

function run(extra: Partial<SimOptions> = {}, cadences: Array<30 | 60 | 120> = [30, 60], seeds = [1]): Summary {
  const scores = [];
  for (const schedule of schedules)
    for (const profile of profiles)
      for (const hrIntervalMin of cadences)
        for (const seed of seeds) {
          const sim = simulate({ seed: seed * 977 + hrIntervalMin, days: 28, hrIntervalMin, schedule, profile, ...extra });
          const found = estimateSleep({
            heart: sim.heart,
            buckets: sim.buckets,
            counters: sim.counters,
            workouts: sim.workouts,
            real: [],
            askedAtMs: sim.toMs + 3_600_000,
            fromMs: sim.fromMs,
            toMs: sim.toMs,
          });
          scores.push(evaluate(found, sim));
        }
  return summarize(scores);
}

describe('estimateSleep contra una simulación', () => {
  it('casi todas las noches, con el inicio y el fin a menos de media hora de la verdad y sin inventar noches', () => {
    const s = run();
    expect(s.nights).toBeGreaterThan(700);
    expect(s.found, 'noches halladas').toBeGreaterThanOrEqual(0.88);
    expect(s.startMin, 'error del inicio (mediana, min)').toBeLessThanOrEqual(42);
    expect(s.endMin, 'error del fin').toBeLessThanOrEqual(33);
    expect(s.durationMin, 'error de la duración').toBeLessThanOrEqual(70);
    expect(s.iou, 'parecido entre lo estimado y la verdad').toBeGreaterThanOrEqual(0.8);
    expect(s.falsePerWeek, 'noches inventadas por semana').toBeLessThanOrEqual(0.1);
  }, 60_000);

  it('con el pulso solo cada hora (lo normal del anillo) y cada dos horas sigue valiendo', () => {
    for (const cadences of [[60], [120]] as const) {
      const s = run({}, [...cadences]);
      expect(s.found, `cada ${cadences[0]} min`).toBeGreaterThanOrEqual(0.85);
      expect(s.iou).toBeGreaterThanOrEqual(0.78);
      expect(s.falsePerWeek).toBeLessThanOrEqual(0.1);
    }
  }, 60_000);

  it('aguanta lecturas ruidosas, poca diferencia entre dormido y despierto, huecos de datos y muchas idas al baño', () => {
    const cases: Array<[string, Partial<SimOptions>, number]> = [
      ['ruido x1,5', { noise: 1.5 }, 0.85],
      ['diferencia dormido/despierto x0,6', { separation: 0.6 }, 0.85],
      ['30 % de lecturas perdidas', { dropout: 0.3 }, 0.85],
      ['3 idas al baño por noche', { bathroom: 3 }, 0.75],
    ];
    for (const [name, extra, minimum] of cases) {
      const s = run(extra);
      expect(s.found, name).toBeGreaterThanOrEqual(minimum);
      expect(s.iou, name).toBeGreaterThanOrEqual(0.75);
      expect(s.falsePerWeek, name).toBeLessThanOrEqual(0.15);
    }
  }, 120_000);
});
