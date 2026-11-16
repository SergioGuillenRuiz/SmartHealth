import { describe, expect, it } from 'vitest';
import { HrCycle, medianBpm, spreadBpm } from './hr-cycle';

// Una medida real (capturas de anillos de la familia): eco, silencio, meseta y lecturas reales desde los ~26 s.
const RUN: Array<[number, number]> = [
  [0, 75], // eco del último valor guardado
  [14_000, 47],
  [17_000, 47],
  [20_000, 46],
  [23_000, 47], // meseta sin converger
  [27_000, 84],
  [29_000, 83],
  [31_000, 82],
  [33_000, 81],
];

function run(warmupMs = 26_000): HrCycle {
  const cycle = new HrCycle(0, warmupMs);
  for (const [t, bpm] of RUN) cycle.add(bpm, t);
  return cycle;
}

describe('HrCycle', () => {
  it('solo lo posterior al calentamiento es fiable: ni el eco ni la meseta', () => {
    expect(run().reliable().map((s) => s.bpm)).toEqual([84, 83, 82, 81]);
  });

  it('al veredicto se da por bueno lo fiable; la mediana de las últimas tres no es la meseta', () => {
    const cycle = run();
    expect(medianBpm(cycle.atVerdict().slice(-3))).toBe(82);
  });

  it('un anillo que cierra la medida antes del calentamiento no se queda sin resultado: valen sus últimas lecturas', () => {
    const cycle = new HrCycle(0, 26_000);
    for (const [t, bpm] of [[1000, 60], [3000, 72], [5000, 73], [7000, 74]] as const) cycle.add(bpm, t);
    expect(cycle.reliable()).toEqual([]);
    expect(cycle.atVerdict().map((s) => s.bpm)).toEqual([72, 73, 74]);
  });

  it('un cierre temprano nunca da por buena la lectura que llegó al instante: es el eco del último valor guardado', () => {
    const cycle = new HrCycle(0, 26_000);
    cycle.add(75, 400);
    expect(cycle.atVerdict()).toEqual([]);
    cycle.add(70, 9000);
    expect(cycle.atVerdict().map((s) => s.bpm)).toEqual([70]);
  });

  it('isReliable respeta el instante exacto del calentamiento', () => {
    const cycle = new HrCycle(10_000, 26_000);
    expect(cycle.isReliable(35_999)).toBe(false);
    expect(cycle.isReliable(36_000)).toBe(true);
  });
});

describe('medianBpm / spreadBpm', () => {
  it('mediana entera y rango', () => {
    const s = (...v: number[]) => v.map((bpm, i) => ({ bpm, tsMs: i }));
    expect(medianBpm(s(80, 60, 70))).toBe(70);
    expect(medianBpm([])).toBeNull();
    expect(spreadBpm(s(70, 76, 73))).toBe(6);
    expect(spreadBpm([])).toBe(0);
  });
});
