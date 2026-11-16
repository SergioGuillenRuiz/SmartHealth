import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph';
import { nameOf, PLACE, readPack, SHAPE, writePack } from './pack';
import { buildMapPack } from './pack-builder';
import { overpassDetailQuery, overpassObjects, OverpassError, overpassQuery } from './overpass';
import { fixtureCorner, overpassCity } from './overpass.test-support';
import { PROFILES } from './profiles';
import { findRoute } from './router';
import { buildSearchIndex, searchPlaces } from './search';
import { boxAround } from './zones';

describe('la consulta', () => {
  const query = overpassQuery(boxAround(40.4168, -3.7038, 4000));

  it('pide JSON, el cuadrado de la zona y la geometría', () => {
    expect(query).toMatch(/^\[out:json\]\[timeout:\d+\]\[bbox:40\.38\d*,-3\.75\d*,40\.45\d*,-3\.65\d*\];/);
    expect(query.trimEnd().endsWith('out geom qt;')).toBe(true);
  });

  it('pide calles, zonas verdes, agua (también como relación) y lugares con nombre', () => {
    for (const piece of ['way["highway"~', 'way["leisure"~', 'way["natural"~', 'rel["type"="multipolygon"]["natural"', 'node["place"~', 'node["railway"~', '"tourism"']) expect(query).toContain(piece);
  });

  it('sin caja de detalle no pide edificios ni comercios, ni nada que el constructor no use (las vías de obra…)', () => {
    expect(query).not.toMatch(/construction|proposed|building|"shop"|bus_stop/);
  });

  it('pide siempre las vías de tren y las grandes zonas, que casi no pesan', () => {
    expect(query).toContain('way["railway"~"^(rail|light_rail|tram');
    expect(query).toMatch(/way\["landuse"~"\^\([^)]*cemetery\|retail\|commercial\|industrial\)\$"\]/);
  });

  describe('con la caja de detalle', () => {
    const zone = boxAround(40.4168, -3.7038, 4000);
    const detail = boxAround(40.4168, -3.7038, 1400);
    const withDetail = overpassQuery(zone, detail);
    const bb = (b: typeof zone): string => [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(6)).join(',');

    it('añade los edificios, los recintos y campos deportivos, los comercios, las paradas y los servicios, cada uno con SU caja (la pequeña)', () => {
      for (const piece of ['way["building"]', 'way["amenity"~', 'way["leisure"~"^(pitch', 'node["amenity"~', 'node["shop"]', 'node["highway"="bus_stop"]', 'node["railway"~"^(tram_stop|subway_entrance)$"]']) expect(withDetail).toContain(piece);
      const heavy = withDetail.split('\n').filter((line) => /building|"shop"|bus_stop|tram_stop|pitch|parking/.test(line));
      expect(heavy.length).toBeGreaterThanOrEqual(6);
      for (const line of heavy) expect(line.trim().endsWith(`(${bb(detail)});`), line).toBe(true);
    });

    it('lo ligero sigue en toda la zona, sin caja propia: lo hereda de la general', () => {
      expect(withDetail.startsWith(`[out:json][timeout:180][bbox:${bb(zone)}];`)).toBe(true);
      const calles = withDetail.split('\n').find((line) => line.includes('way["highway"~'))!;
      expect(calles.trim().endsWith(');')).toBe(false);
      expect(calles.trim().endsWith('$"];')).toBe(true);
    });

    it('el resto de la consulta es la misma que sin detalle', () => {
      const plain = query.split('\n').slice(2, -2); // sin la primera línea (la caja cambia), '(' ni el final
      void plain;
      expect(withDetail.trimEnd().endsWith('out geom qt;')).toBe(true);
      expect(withDetail).toContain('\n);\n');
    });
  });
});

describe('traducir lo que contesta Overpass', () => {
  const objects = overpassObjects(overpassCity());

  it('primero los nodos (por identificador, sin repetir), luego los caminos y por último las relaciones', () => {
    const types = objects.map((o) => o.type).join('');
    expect(types).toMatch(/^n+w+r+$/);
    const nodeIds = objects.filter((o) => o.type === 'n').map((o) => o.id);
    expect(nodeIds).toEqual([...nodeIds].sort((a, b) => a - b));
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    // Los 81 cruces de la cuadrícula se comparten entre calle y calle.
    expect(nodeIds.filter((id) => id >= 1_000_000 && id < 1_010_000)).toHaveLength(81);
  });

  it('los anillos de una relación (sin identificadores de nodos) reciben los suyos, por encima de los de OpenStreetMap', () => {
    const relation = objects.find((o) => o.type === 'r')!;
    expect(relation.members).toEqual([
      { type: 'w', ref: 50_101, role: 'outer' },
      { type: 'w', ref: 50_102, role: 'outer' },
    ]);
    const ring = objects.find((o) => o.type === 'w' && o.id === 50_101)!;
    expect(ring.tags.size).toBe(0);
    expect(Math.min(...ring.refs!)).toBeGreaterThan(6_000_004);
  });

  it('las etiquetas pasan tal cual (sin escapes)', () => {
    const park = objects.find((o) => o.type === 'w' && o.id === 40_001)!;
    expect(park.tags.get('name')).toBe('Parque de la Ciudadela');
    const museum = objects.find((o) => o.type === 'n' && o.id === 60_002)!;
    expect(museum.tags.get('tourism')).toBe('museum');
  });

  it('una respuesta cortada por el servidor (remark) se rechaza en vez de dar un mapa a medias', () => {
    expect(() => overpassObjects({ ...overpassCity(), remark: 'runtime error: Query timed out in "query" at line 3 after 121 seconds.' })).toThrow(OverpassError);
    try {
      overpassObjects({ elements: [], remark: 'runtime error: out of memory' });
    } catch (error) {
      expect((error as OverpassError).code).toBe('incomplete');
    }
  });

  it('sin calles dice que está vacío; algo que no es una respuesta, que está mal formado', () => {
    expect(() => overpassObjects({ elements: [] })).toThrow(expect.objectContaining({ code: 'empty' }));
    expect(() => overpassObjects({} as never)).toThrow(expect.objectContaining({ code: 'malformed' }));
  });

  it('un camino con un punto sin coordenadas se descarta entero', () => {
    const response = overpassCity();
    const first = response.elements!.find((e) => e.type === 'way')!;
    first.geometry![2] = null;
    const ways = overpassObjects(response).filter((o) => o.type === 'w');
    expect(ways.find((w) => w.id === first.id)).toBeUndefined();
    expect(ways.length).toBeGreaterThan(10);
  });
});

describe('de Overpass a un mapa que se puede usar', () => {
  async function build() {
    const { input, stats } = await buildMapPack(overpassObjects(overpassCity()), { name: 'prueba', title: 'Tu zona' });
    return { pack: readPack(writePack(input)), stats };
  }

  it('el paquete sale coherente y con las calles, las zonas y los lugares', async () => {
    const { pack, stats } = await build();
    expect(stats.highways).toBe(9 + 9 + 1); // 18 de la cuadrícula + la calle sin salida; la acera dibujada aparte no cuenta
    expect(pack.shapeKind).toContain(SHAPE.PARK);
    expect(pack.shapeKind).toContain(SHAPE.WATER);
    const kinds = Array.from(pack.placeKind);
    expect(kinds).toContain(PLACE.SUBURB);
    expect(kinds).toContain(PLACE.POI);
    expect(kinds).toContain(PLACE.PARK);
    expect(kinds).toContain(PLACE.STREET);
  });

  it('los edificios, la vía de tren y los comercios entran en el paquete (la parada sin nombre también, pero no se busca)', async () => {
    const { pack } = await build();
    expect(Array.from(pack.shapeKind).filter((k) => k === SHAPE.BUILDING)).toHaveLength(2);
    expect(Array.from(pack.shapeKind)).toContain(SHAPE.RAIL);
    const kinds = Array.from(pack.placeKind);
    expect(kinds).toContain(PLACE.SHOP);
    expect(kinds).toContain(PLACE.CAFE);
    expect(kinds).toContain(PLACE.TRANSIT);
    const stop = kinds.indexOf(PLACE.TRANSIT);
    expect(pack.placeName[stop]).toBe(0xffffffff); // sin nombre
    const search = buildSearchIndex(pack);
    expect(searchPlaces(search, 'panaderia', null, 3)[0]).toMatchObject({ name: 'Panadería Sol', kind: PLACE.SHOP });
    expect(searchPlaces(search, 'parada', null, 5).some((r) => r.kind === PLACE.TRANSIT)).toBe(false);
  });

  it('se puede buscar por nombre y calcular una ruta entre dos esquinas', async () => {
    const { pack } = await build();
    const search = buildSearchIndex(pack);
    expect(searchPlaces(search, 'parque ciud', null, 3)[0]?.name).toBe('Parque de la Ciudadela');
    expect(searchPlaces(search, 'prado', null, 3)[0]?.name).toBe('Museo del Prado');
    expect(searchPlaces(search, 'Calle de Serrano', null, 3)[0]?.name).toBe('Calle de Serrano');
    const graph = buildGraph(pack);
    const from = fixtureCorner(0, 0);
    const to = fixtureCorner(6, 4);
    const result = findRoute(graph, PROFILES.walk, from, to);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.distanceM).toBeGreaterThan(900);
      expect(result.route.distanceM).toBeLessThan(1100); // 6 + 4 manzanas de 100 m
    }
  });

  it('el título de la zona sale del barrio más cercano', async () => {
    const { pack } = await build();
    expect(nameOf(pack, pack.placeName[Array.from(pack.placeKind).indexOf(PLACE.SUBURB)]!)).toBe('Barrio Centro');
  });

  it('el mismo resultado de siempre con los mismos datos (nada depende del orden en que llegaron)', async () => {
    const response = overpassCity();
    const reversed = { elements: [...response.elements!].reverse() };
    const a = await buildMapPack(overpassObjects(response), { name: 'a', title: 'x' });
    const b = await buildMapPack(overpassObjects(reversed), { name: 'a', title: 'x' });
    expect(a.stats).toEqual({ ...b.stats });
  });
});


describe('la consulta de solo detalle (ronda 46)', () => {
  const detail = boxAround(40.4168, -3.7038, 1000);
  const query = overpassDetailQuery(detail);

  it('pide edificios, recintos, comercios, paradas y servicios, y NADA de calles ni zonas verdes', () => {
    for (const wanted of ['way["building"]', 'node["shop"]', '"bus_stop"', 'node["amenity"~', 'way["leisure"~']) expect(query).toContain(wanted);
    for (const unwanted of ['way["highway"~', 'way["waterway"', 'rel["type"="multipolygon"]', 'way["natural"', 'node["place"']) expect(query).not.toContain(unwanted);
  });

  it('cada instrucción lleva su caja y la general es la misma; acaba con `out geom qt` y un tiempo máximo razonable', () => {
    const bb = [detail.minLat, detail.minLon, detail.maxLat, detail.maxLon].map((v) => v.toFixed(6)).join(',');
    expect(query).toContain(`[bbox:${bb}]`);
    expect(query).toMatch(/timeout:(\d+)/);
    expect(Number(query.match(/timeout:(\d+)/)![1])).toBeLessThanOrEqual(120);
    expect(query.trimEnd().endsWith('out geom qt;')).toBe(true);
  });

  it('una respuesta sin calles solo vale con `allowNoWays` (la de detalle); la de las calles sin ellas sigue siendo un error', () => {
    expect(() => overpassObjects({ elements: [] })).toThrow(OverpassError);
    expect(overpassObjects({ elements: [] }, { allowNoWays: true })).toEqual([]);
  });
});
