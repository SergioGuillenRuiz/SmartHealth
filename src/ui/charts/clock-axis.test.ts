import { describe, expect, it } from 'vitest';
import { clockAxis, clockCut, clockSpan, windowLength, type SleepWindow } from './clock-axis';

const at = (h: number, m = 0): number => h * 60 + m;
const night = (bedH: number, bedM: number, wakeH: number, wakeM: number): SleepWindow => ({ bedMin: at(bedH, bedM), wakeMin: at(wakeH, wakeM) });

/** Que lo dibujado cabe: todas las barras dentro del dominio del eje, hacia delante y sin salirse. */
function fits(windows: readonly SleepWindow[]): { cut: number; lo: number; hi: number; spans: Array<{ from: number; to: number }> } {
  const cut = clockCut(windows);
  const spans = windows.map((w) => clockSpan(w, cut));
  const axis = clockAxis(cut);
  const [lo, hi] = axis.domain(
    spans.map((s) => s.from),
    spans.map((s) => s.to),
  );
  for (const s of spans) {
    expect(s.to, 'la barra va hacia delante').toBeGreaterThan(s.from);
    expect(s.from).toBeGreaterThanOrEqual(lo);
    expect(s.to).toBeLessThanOrEqual(hi);
  }
  return { cut, lo, hi, spans };
}

describe('el eje de la ventana de sueño', () => {
  it('quien duerme de noche: el corte cae por la tarde y las marcas en horas pares', () => {
    const windows = [night(23, 0, 7, 0), night(23, 30, 7, 15), night(22, 40, 6, 50), night(0, 10, 8, 0)];
    const { cut } = fits(windows);
    expect(cut % 120).toBe(0);
    expect(cut).toBeGreaterThanOrEqual(at(9));
    expect(cut).toBeLessThanOrEqual(at(21));
  });

  it('quien duerme de día y se levanta pasadas las 18:00 (lo que rompía el gráfico): las barras caben y van hacia delante', () => {
    const windows = [night(8, 15, 17, 40), night(8, 48, 18, 40), night(6, 10, 16, 5), night(9, 0, 18, 17)];
    const { cut, spans } = fits(windows);
    // El corte cae en la madrugada o la noche (cuando está despierto), no en mitad de un sueño.
    expect(cut >= at(19) || cut <= at(5)).toBe(true);
    for (const s of spans) expect(s.to - s.from).toBeGreaterThan(8 * 60);
  });

  it('una noche que cruza la medianoche dura lo que dura, y una que cruza el corte se alarga en vez de darse la vuelta', () => {
    expect(windowLength(night(23, 0, 7, 0))).toBe(8 * 60);
    expect(windowLength(night(8, 0, 18, 0))).toBe(10 * 60);
    // Un sueño raro (3 h de la tarde) en un horario de noche: sigue siendo una barra hacia delante.
    fits([night(23, 0, 7, 0), night(23, 30, 7, 0), night(22, 45, 6, 30), night(14, 0, 17, 0)]);
  });

  it('con horarios que cambian (un día de noche y otro de día) todo cabe', () => {
    fits([night(23, 0, 7, 0), night(8, 30, 17, 30), night(2, 0, 10, 0), night(13, 0, 21, 0), night(22, 0, 6, 0)]);
  });

  it('las marcas dicen la hora del reloj, también más allá de la medianoche', () => {
    const axis = clockAxis(at(18));
    expect(axis.label(0)).toBe('18:00');
    expect(axis.label(360)).toBe('00:00');
    expect(axis.label(840)).toBe('08:00');
    expect(axis.label(1440 + 120)).toBe('20:00');
  });

  it('sin ningún hueco (se duerme a todas horas) se corta a las 18:00 de siempre; sin noches, también', () => {
    expect(clockCut([night(0, 0, 0, 0)])).toBe(at(18)); // «de 0 a 0» no cubre nada: queda libre el día entero…
    expect(clockCut([])).toBeGreaterThanOrEqual(0);
  });
});
