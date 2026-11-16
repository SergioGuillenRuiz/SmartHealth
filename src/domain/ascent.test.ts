import { describe, expect, it } from 'vitest';
import { AscentTracker, heightBetween } from './ascent';

/** Presión a `heightM` metros por encima de una referencia de 1013,25 hPa. */
const pressureAt = (heightM: number): number => 1013.25 * Math.pow(1 - heightM / 44_330, 5.255);

/** Una serie de alturas, una lectura por entrada. */
function ascentOf(heights: number[], noise = (_i: number): number => 0): number {
  const tracker = new AscentTracker();
  heights.forEach((h, i) => tracker.add(pressureAt(h + noise(i))));
  return tracker.ascentM;
}

const ramp = (from: number, to: number, steps: number): number[] => Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);

describe('heightBetween', () => {
  it('a nivel del mar, 1 hPa menos son unos 8,4 m más', () => {
    expect(heightBetween(1012.25, 1013.25)).toBeCloseTo(8.4, 0);
  });
});

describe('AscentTracker: metros subidos con el barómetro', () => {
  it('una subida sostenida de 40 m suma los 40 m (se pierde a lo sumo la banda muerta del final)', () => {
    const flat = Array(10).fill(0);
    const up = ascentOf([...flat, ...ramp(0, 40, 80), ...Array(10).fill(40)]);
    expect(up).toBeGreaterThan(40 - 3.5);
    expect(up).toBeLessThanOrEqual(40.5);
  });

  it('bajar no suma, y subir después de bajar suma solo la nueva subida', () => {
    const route = [...Array(8).fill(0), ...ramp(0, -30, 60), ...ramp(-30, -5, 50)];
    const up = ascentOf(route);
    expect(up).toBeGreaterThan(25 - 3.5);
    expect(up).toBeLessThanOrEqual(25.5);
  });

  it('el ruido del sensor en llano no suma nada', () => {
    const noise = (i: number): number => 0.4 * Math.sin(i * 1.7) + (i % 7 === 0 ? 0.6 : -0.2);
    expect(ascentOf(Array(600).fill(0), noise)).toBe(0);
  });

  it('un pico suelto (un portazo) no cuenta: lo quita la mediana', () => {
    const heights = Array(30).fill(0);
    heights[15] = 12;
    expect(ascentOf(heights)).toBe(0);
  });

  it('subir y bajar la misma cuesta varias veces suma cada subida', () => {
    const lap = [...ramp(0, 20, 40), ...ramp(20, 0, 40)];
    const total = ascentOf([...Array(8).fill(0), ...lap, ...lap, ...lap]);
    expect(total).toBeGreaterThan(3 * 20 - 3 * 3.5);
    expect(total).toBeLessThanOrEqual(3 * 20 + 1);
  });

  it('ignora lecturas imposibles y no se rompe con pocas lecturas', () => {
    const tracker = new AscentTracker();
    for (const bad of [0, -5, Number.NaN, 5000]) tracker.add(bad);
    tracker.add(1013);
    expect(tracker.ascentM).toBe(0);
  });

  it('tras cortar la serie no compara con lo de antes (una pausa en que se cambió de piso)', () => {
    const tracker = new AscentTracker();
    for (const h of Array(10).fill(0)) tracker.add(pressureAt(h));
    tracker.breakSeries();
    for (const h of Array(10).fill(30)) tracker.add(pressureAt(h)); // otra altura al reanudar: no es subida
    expect(tracker.ascentM).toBe(0);
  });
});
