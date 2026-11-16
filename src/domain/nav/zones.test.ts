import { describe, expect, it } from 'vitest';
import { PACK_VERSION } from './pack';
import { boxAround, DEFAULT_LIMITS, EDGE_MARGIN_M, marginM, pickZone, zoneCovers, zoneIdFor, zonesToDelete, type ZoneMeta } from './zones';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4);
const limits = { ...DEFAULT_LIMITS, packVersion: PACK_VERSION };

const zone = (id: string, lat: number, lon: number, extra: Partial<ZoneMeta> = {}): ZoneMeta => ({ id, name: id, box: boxAround(lat, lon, 4000), bytes: 5_000_000, createdMs: NOW - DAY, lastUsedMs: NOW - DAY, packVersion: PACK_VERSION, ...extra });

describe('el cuadrado de una zona', () => {
  it('mide unos 8 km de lado y deja el centro a 4 km de cada borde', () => {
    const box = boxAround(40.4, -3.7, 4000);
    expect(marginM(box, 40.4, -3.7)).toBeGreaterThan(3990);
    expect(marginM(box, 40.4, -3.7)).toBeLessThan(4010);
    expect((box.maxLat - box.minLat) * 111_195).toBeCloseTo(8000, -1);
    expect((box.maxLon - box.minLon) * 111_195 * Math.cos((40.4 * Math.PI) / 180)).toBeCloseTo(8000, -1);
  });

  it('cubre una posición solo si queda a más del margen del borde', () => {
    const box = boxAround(40.4, -3.7, 4000);
    expect(zoneCovers(box, 40.4, -3.7)).toBe(true);
    expect(zoneCovers(box, 40.4 + 3500 / 111_195, -3.7)).toBe(false); // a 500 m del borde
    expect(zoneCovers(box, 40.4 + 3500 / 111_195, -3.7, 0)).toBe(true);
    expect(zoneCovers(box, 40.6, -3.7, 0)).toBe(false);
    expect(EDGE_MARGIN_M).toBe(1000);
  });

  it('la identidad de la zona es estable a ~100 m', () => {
    expect(zoneIdFor(40.41683, -3.70381)).toBe(zoneIdFor(40.41701, -3.70402));
    expect(zoneIdFor(40.4168, -3.7038)).not.toBe(zoneIdFor(40.4368, -3.7038));
  });
});

describe('qué zona se usa', () => {
  it('ninguna si ninguna cubre la posición', () => {
    expect(pickZone([zone('a', 41, -3)], 40.4, -3.7)).toBeNull();
    expect(pickZone([], 40.4, -3.7)).toBeNull();
  });

  it('la que deja la posición más lejos del borde', () => {
    const near = zone('near', 40.4 + 0.03, -3.7);
    const centred = zone('centred', 40.4, -3.7);
    expect(pickZone([near, centred], 40.4, -3.7)?.id).toBe('centred');
  });

  it('a igualdad, la usada más recientemente', () => {
    const old = zone('old', 40.4, -3.7, { lastUsedMs: NOW - 30 * DAY });
    const fresh = zone('fresh', 40.4, -3.7, { lastUsedMs: NOW - DAY });
    expect(pickZone([old, fresh], 40.4, -3.7)?.id).toBe('fresh');
    expect(pickZone([fresh, old], 40.4, -3.7)?.id).toBe('fresh');
  });
});

describe('qué zonas se borran', () => {
  it('nada si todo está en orden', () => {
    expect(zonesToDelete([zone('a', 40, -3), zone('b', 41, -3)], NOW, limits)).toEqual([]);
  });

  it('las que llevan más de 60 días sin abrirse', () => {
    const zones = [zone('viva', 40, -3, { lastUsedMs: NOW - 59 * DAY }), zone('muerta', 41, -3, { lastUsedMs: NOW - 61 * DAY })];
    expect(zonesToDelete(zones, NOW, limits)).toEqual(['muerta']);
  });

  it('las de otra versión del formato', () => {
    expect(zonesToDelete([zone('vieja', 40, -3, { packVersion: PACK_VERSION - 1 }), zone('ok', 41, -3)], NOW, limits)).toEqual(['vieja']);
  });

  it('si hay más de 6, se van las menos usadas', () => {
    const zones = Array.from({ length: 9 }, (_, i) => zone(`z${i}`, 40 + i, -3, { lastUsedMs: NOW - (10 - i) * DAY }));
    expect(zonesToDelete(zones, NOW, limits).sort()).toEqual(['z0', 'z1', 'z2']);
  });

  it('si pesan demasiado, se van las menos usadas hasta que quepan', () => {
    const zones = [zone('a', 40, -3, { bytes: 30e6, lastUsedMs: NOW - 5 * DAY }), zone('b', 41, -3, { bytes: 30e6, lastUsedMs: NOW - 4 * DAY }), zone('c', 42, -3, { bytes: 30e6, lastUsedMs: NOW - 3 * DAY })];
    expect(zonesToDelete(zones, NOW, limits)).toEqual(['a']);
  });

  it('la que se está usando no se toca aunque sea la más vieja o la más pesada', () => {
    const zones = [zone('uso', 40, -3, { bytes: 70e6, lastUsedMs: NOW - 90 * DAY }), zone('otra', 41, -3, { bytes: 1e6 })];
    expect(zonesToDelete(zones, NOW, limits, 'uso')).toEqual(['otra']);
    expect(zonesToDelete([zone('uso', 40, -3, { packVersion: 0 })], NOW, limits, 'uso')).toEqual([]);
  });
});
