import { describe, expect, it } from 'vitest';
import { summarizeHeart, summarizeSpo2 } from './heart';
import type { HeartSample } from './types';

const at = (h: number, m = 0): number => new Date(2026, 6, 9, h, m, 0).getTime();
const hr = (h: number, bpm: number): HeartSample => ({ tsMs: at(h), bpm, source: 'ring-auto' });

describe('summarizeHeart', () => {
  it('sin lecturas del día devuelve null', () => {
    expect(summarizeHeart([], '2026-07-09')).toBeNull();
    expect(summarizeHeart([{ tsMs: new Date(2026, 6, 8, 12).getTime(), bpm: 70, source: 'ring-auto' }], '2026-07-09')).toBeNull();
  });

  it('mín, máx, media y última lectura; el reposo exige al menos 6 lecturas', () => {
    const few = summarizeHeart([hr(1, 52), hr(8, 70), hr(13, 85)], '2026-07-09');
    expect(few).toMatchObject({ count: 3, minBpm: 52, maxBpm: 85, avgBpm: 69, restingBpm: null });
    const many = summarizeHeart([hr(0, 55), hr(2, 52), hr(4, 54), hr(8, 70), hr(13, 85), hr(18, 78), hr(22, 66)], '2026-07-09');
    expect(many?.restingBpm).toBe(54); // media de 52, 54, 55
    expect(many?.last).toEqual({ tsMs: at(22), bpm: 66 });
  });

  it('descarta lecturas fuera de rango y ordena por hora', () => {
    const s = summarizeHeart([hr(10, 70), hr(9, 255), hr(8, 0), hr(7, 60)], '2026-07-09');
    expect(s?.samples.map((x) => x.bpm)).toEqual([60, 70]);
  });
});

describe('summarizeSpo2', () => {
  it('media y mínimo del día, ignorando valores imposibles', () => {
    const at2 = (h: number) => new Date(2026, 6, 9, h).getTime();
    const s = summarizeSpo2(
      [
        { tsMs: at2(1), percent: 96 },
        { tsMs: at2(3), percent: 94 },
        { tsMs: at2(5), percent: 98 },
        { tsMs: at2(7), percent: 20 },
      ],
      '2026-07-09',
    );
    expect(s).toEqual({ day: '2026-07-09', count: 3, avg: 96, min: 94 });
  });
});

describe('un día con una cantidad enorme de lecturas (una copia hostil o estropeada)', () => {
  // `Math.min(...lista)` lanza RangeError con ~120 000 elementos: el día entero se quedaba sin cargar.
  const big = Array.from({ length: 300_000 }, (_, i): HeartSample => ({ tsMs: at(0) + i * 100, bpm: 50 + (i % 70), source: 'ring-auto' }));

  it('el pulso del día sale bien', () => {
    expect(summarizeHeart(big, '2026-07-09')).toMatchObject({ count: 300_000, minBpm: 50, maxBpm: 119 });
  });

  it('el oxígeno del día también', () => {
    const spo2 = Array.from({ length: 300_000 }, (_, i) => ({ tsMs: at(0) + i * 100, percent: 90 + (i % 10) }));
    expect(summarizeSpo2(spo2, '2026-07-09')).toMatchObject({ count: 300_000, min: 90 });
  });
});

describe('el día que empieza a las 08:00', () => {
  it('las lecturas de madrugada son del día que empezó antes', () => {
    const samples = [hr(2, 60), hr(9, 70), hr(20, 80), { tsMs: at(26), bpm: 55, source: 'ring-auto' as const }];
    const day9 = summarizeHeart(samples, '2026-07-09', 8);
    expect(day9?.samples.map((s) => s.bpm)).toEqual([70, 80, 55]); // la de las 02:00 del 9 es del día 8
    expect(day9?.last.bpm).toBe(55); // la última lectura es la de las 02:00 del día 10
    expect(summarizeHeart(samples, '2026-07-08', 8)?.samples.map((s) => s.bpm)).toEqual([60]);
    expect(summarizeHeart(samples, '2026-07-09')?.samples.map((s) => s.bpm)).toEqual([60, 70, 80]); // de calendario, como siempre
  });

  it('el oxígeno también', () => {
    const spo2 = [
      { tsMs: at(3), percent: 90 },
      { tsMs: at(27), percent: 96 },
    ];
    expect(summarizeSpo2(spo2, '2026-07-09', 8)).toMatchObject({ count: 1, min: 96 });
    expect(summarizeSpo2(spo2, '2026-07-08', 8)).toMatchObject({ count: 1, min: 90 });
  });
});
