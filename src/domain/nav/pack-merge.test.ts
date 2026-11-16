import { describe, expect, it } from 'vitest';
import { overpassObjects } from './overpass';
import { overpassCityDetail, overpassCityLight } from './overpass.test-support';
import { isMarkerPlace, NO_NAME, nameOf, PLACE, readPack, SHAPE, writePack, type MapPack } from './pack';
import { buildMapPack } from './pack-builder';
import { withDetail } from './pack-merge';
import { boxAround } from './zones';

const CENTER = { lat: 40.4168, lon: -3.7038 };

async function packs(): Promise<{ base: MapPack; detail: Awaited<ReturnType<typeof buildMapPack>>['input'] }> {
  const light = await buildMapPack(overpassObjects(overpassCityLight()), { name: 'z', title: 'Zona' });
  const detail = await buildMapPack(overpassObjects(overpassCityDetail(), { allowNoWays: true }), { name: 'z', title: 'Zona', detail: boxAround(CENTER.lat, CENTER.lon, 1000), detailOnly: true });
  return { base: readPack(writePack(light.input)), detail: detail.input };
}

const placeNames = (pack: MapPack): string[] => Array.from({ length: pack.placeCount }, (_, i) => (pack.placeName[i] === NO_NAME ? '' : nameOf(pack, pack.placeName[i]!)));

describe('withDetail: sumar edificios y comercios a un mapa que solo lleva lo ligero', () => {
  it('las calles no cambian; se añaden las formas y los lugares del detalle y la caja del detalle queda en el mapa', async () => {
    const { base, detail } = await packs();
    const merged = readPack(writePack(withDetail(base, detail)));
    expect(merged.nodeCount).toBe(base.nodeCount);
    expect(merged.edgeCount).toBe(base.edgeCount);
    expect(Array.from(merged.edgeA)).toEqual(Array.from(base.edgeA));
    expect(Array.from(merged.edgeName)).toEqual(Array.from(base.edgeName));
    expect(merged.shapeCount).toBe(base.shapeCount + 2);
    expect(Array.from(merged.shapeKind).filter((kind) => kind === SHAPE.BUILDING)).toHaveLength(2);
    expect(merged.placeCount).toBe(base.placeCount + 3);
    expect(merged.meta.detail).toEqual(detail.meta.detail);
    expect(merged.meta.bbox).toEqual(base.meta.bbox);
  });

  it('los nombres nuevos se añaden a la tabla y los de las calles siguen siendo los mismos', async () => {
    const { base, detail } = await packs();
    const merged = readPack(writePack(withDetail(base, detail)));
    expect(placeNames(merged)).toEqual(expect.arrayContaining(['Panadería Sol', 'Café del Parque', 'Barrio Centro', 'Museo del Prado']));
    for (let i = 0; i < base.edgeCount; i++) {
      const was = base.edgeName[i]!;
      const now = merged.edgeName[i]!;
      expect(now === NO_NAME ? '' : nameOf(merged, now)).toBe(was === NO_NAME ? '' : nameOf(base, was));
    }
    // Un comercio sin nombre (la parada) es una marca: se queda sin nombre, sin invalidar el mapa.
    const kinds = Array.from(merged.placeKind);
    expect(kinds).toContain(PLACE.TRANSIT);
    expect(kinds.filter(isMarkerPlace).length).toBeGreaterThanOrEqual(3);
  });

  it('lo que el detalle trae repetido (ya estaba en el mapa) no se duplica: sumar dos veces lo mismo no cambia nada', async () => {
    const { base, detail } = await packs();
    const once = readPack(writePack(withDetail(base, detail)));
    const twice = readPack(writePack(withDetail(once, detail)));
    expect(twice.shapeCount).toBe(once.shapeCount);
    expect(twice.placeCount).toBe(once.placeCount);
  });
});
