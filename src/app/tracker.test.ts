import { describe, expect, it } from 'vitest';
import type { RawTrackFix } from './native';
import { parseFix } from './tracker';

describe('parseFix: una fila del servicio nativo', () => {
  it('lee la presión del barómetro (la novena columna)', () => {
    expect(parseFix([3, 1000, 40.1, -3.2, 4.5, 1.3, 650, 8, 1008.4])).toMatchObject({ seq: 3, tsMs: 1000, lat: 40.1, lon: -3.2, accuracyM: 4.5, speedMs: 1.3, pressureHpa: 1008.4 });
  });

  it('sin barómetro (null) o con una fila de antes de que se midiera (8 columnas), la presión es null', () => {
    expect(parseFix([1, 1, 40, -3, 5, null, null, null, null])?.pressureHpa).toBeNull();
    expect(parseFix([1, 1, 40, -3, 5, null, null, null])?.pressureHpa).toBeNull();
  });

  it('una fila rota se descarta en vez de tumbar el entreno', () => {
    expect(parseFix([1, 1, 40] as unknown as RawTrackFix)).toBeNull();
    expect(parseFix([1, Number.NaN, 40, -3, 5, 1, 1, 1, 1000])).toBeNull();
    expect(parseFix([1, 1, 40, -3, 5, 1, 1, 1, Number.NaN])?.pressureHpa).toBeNull();
  });
});
