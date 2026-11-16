import { describe, expect, it } from 'vitest';
import { buildMapIndex, placesInBox, shapesInBox } from './map-index';
import { PLACE, readPack, SHAPE, writePack } from './pack';
import { buildSyntheticCity } from './synthetic-city';

const city = buildSyntheticCity();
const pack = readPack(writePack(city.input));
const index = buildMapIndex(pack);
const center = city.center;

describe('el índice del mapa', () => {
  it('las zonas que tocan una caja, y solo ellas', () => {
    const all = shapesInBox(index, { minLat: center.lat - 1, maxLat: center.lat + 1, minLon: center.lon - 1, maxLon: center.lon + 1 });
    expect(all).toHaveLength(pack.shapeCount);
    expect(shapesInBox(index, { minLat: 10, maxLat: 11, minLon: 10, maxLon: 11 })).toEqual([]);
    const parkAt = city.at('p_mid');
    const near = shapesInBox(index, { minLat: parkAt.lat - 0.0001, maxLat: parkAt.lat + 0.0001, minLon: parkAt.lon - 0.0001, maxLon: parkAt.lon + 0.0001 });
    expect(near.some((s) => pack.shapeKind[s] === SHAPE.PARK)).toBe(true);
  });
  it('los lugares dentro de una caja', () => {
    const box = { minLat: center.lat - 0.05, maxLat: center.lat + 0.05, minLon: center.lon - 0.05, maxLon: center.lon + 0.05 };
    const found = placesInBox(index, box);
    expect(found).toHaveLength(pack.placeCount);
    expect(found.some((p) => pack.placeKind[p] === PLACE.PARK)).toBe(true);
    expect(placesInBox(index, { minLat: 0, maxLat: 0.01, minLon: 0, maxLon: 0.01 })).toEqual([]);
  });
});
