import { describe, expect, it } from 'vitest';
import { estimateSleep } from './sleep-estimate';
import { evaluate, simulate, summarize, type Profile, type Schedule, type SimOptions, type Summary } from './sleep-sim.test-support';

// La estimación contra una persona simulada de la que se conoce la noche de verdad: horarios de noche, tardíos, de día, rotativos e
// irregulares; pasos activos, de oficina y mixtos; pulso cada 30 o 60 min; escapadas al baño, siestas, sofá antes de acostarse, huecos
// de datos. Con el algoritmo anterior (umbrales fijos sobre el pulso) las mismas simulaciones daban: noches halladas 66 %, inicio a 87 min
// y duración a 103 min de la verdad (medianas). Los límites de aquí son los que debe cumplir el actual, con algo de margen.
//
// Además, una vida «dura» (`harsh`): artefactos del sensor, noches malas con el pulso alto, insomnio, rato despierto en la cama antes de dormir y al despertar, ejercicio
// por la tarde-noche y deriva del pulso. Ahí el algoritmo de antes de la ronda 57 se equivocaba una mediana de 115 min en la duración (el 29 %) y acertaba el 60 % de las noches
// (parecido ≥ 0,7); ahora ~50 min (el 15 %) y el 78 %.

const schedules: Schedule[] = ['night', 'late', 'day', 'rotating', 'irregular'];
const profiles: Profile[] = ['active', 'desk', 'mixed'];

function run(extra: Partial<SimOptions> = {}, cadences: Array<30 | 60 | 120> = [30, 60], seeds = [1], useRing = false, only: readonly Schedule[] = schedules): Summary {
  const scores = [];
  for (const schedule of only)
    for (const profile of profiles)
      for (const hrIntervalMin of cadences)
        for (const seed of seeds) {
          const sim = simulate({ seed: seed * 977 + hrIntervalMin, days: 28, hrIntervalMin, schedule, profile, ...extra, ringLabels: useRing });
          const found = estimateSleep({
            heart: sim.heart,
            buckets: sim.buckets,
            counters: sim.counters,
            workouts: sim.workouts,
            real: useRing ? sim.ringSessions : [],
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

  it('en una vida dura (artefactos, noches malas, insomnio, rato despierto en la cama) sigue acertando la mayoría de las noches y la duración a menos de una hora', () => {
    const s = run({ harsh: true, resp: false }, [60], [1, 2]);
    expect(s.found, 'noches halladas').toBeGreaterThanOrEqual(0.82);
    expect(s.startMin, 'error del inicio (mediana, min)').toBeLessThanOrEqual(50);
    expect(s.endMin, 'error del fin').toBeLessThanOrEqual(38);
    expect(s.durationMin, 'error de la duración').toBeLessThanOrEqual(75);
    expect(s.hit, 'noches con parecido ≥ 0,7').toBeGreaterThanOrEqual(0.68);
    expect(s.miss, 'noches falladas de lleno').toBeLessThanOrEqual(0.18);
    expect(s.falsePerWeek, 'noches inventadas por semana').toBeLessThanOrEqual(0.15);
  }, 120_000);

  it('la respiración que da el anillo en cada medida mejora lo anterior', () => {
    const without = run({ harsh: true, resp: false }, [60], [1, 2]);
    const withResp = run({ harsh: true, resp: true }, [60], [1, 2]);
    expect(withResp.hit).toBeGreaterThan(without.hit);
    expect(withResp.durationMin).toBeLessThan(without.durationMin);
    expect(withResp.hit, 'noches con parecido ≥ 0,7').toBeGreaterThanOrEqual(0.72);
    expect(withResp.durationMin, 'error de la duración').toBeLessThanOrEqual(60);
  }, 120_000);

  it('con las noches que el anillo sí guarda (horarios que mezclan dentro y fuera de su franja) corrige su propio sesgo: el inicio sale mejor', () => {
    const mixed = ['rotating', 'irregular'] as const;
    const blind = run({ harsh: true }, [60], [1, 2, 3], false, mixed);
    const learned = run({ harsh: true }, [60], [1, 2, 3], true, mixed);
    expect(learned.startMin, 'error del inicio con noches conocidas').toBeLessThan(blind.startMin);
    // Las noches del anillo de la simulación empiezan unos minutos más tarde y acaban unos minutos antes que la verdad (como el anillo real, que tarda en darse cuenta): aprender de
    // ellas acerca la estimación a lo que dice el anillo, no necesariamente a la verdad, así que la duración solo tiene que no empeorar de forma apreciable.
    expect(learned.durationMin, 'error de la duración con noches conocidas').toBeLessThanOrEqual(blind.durationMin + 5);
    expect(learned.durationMin).toBeLessThanOrEqual(65);
  }, 120_000);
});
