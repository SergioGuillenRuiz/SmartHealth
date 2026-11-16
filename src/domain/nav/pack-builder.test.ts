import { describe, expect, it } from 'vitest';
import { assembleRings, buildMapPack, classifyHighway, classifyPlace, classifyShape, parseOplLine, simplifyIndices } from './pack-builder';
import { buildGraph } from './graph';
import { buildSteps } from './maneuvers';
import { FLAG, HW, nameOf, PLACE, readPack, SHAPE, writePack } from './pack';
import { PROFILES } from './profiles';
import { findRoute } from './router';
import { buildSearchIndex, searchPlaces } from './search';

// Un trocito de OpenStreetMap escrito a mano en formato OPL: una cuadrícula de 3×3 calles de ~100 m (la central, de sentido único), una acera dibujada aparte (que se ignora), una
// calle sin salida, un camino que sale del recorte, un parque, un lago hecho de dos caminos (multipolígono) y unos cuantos lugares.
const BASE_LAT = 40.4;
const BASE_LON = -3.7;
const lat = (j: number): string => (BASE_LAT + j * 0.0009).toFixed(7);
const lon = (i: number): string => (BASE_LON + i * 0.0012).toFixed(7);
const nodeId = (i: number, j: number): number => 1000 + i * 10 + j;
const node = (id: number, y: string, x: string, tags = ''): string => `n${id} v1 dV c1 t2020-01-01T00:00:00Z i1 uX T${tags} x${x} y${y}`;

function fixture(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out.push(node(nodeId(i, j), lat(j), lon(i)));
  out.push(node(2001, lat(3), lon(1)));
  out.push(node(2002, lat(0.5), lon(3)));
  out.push(node(3001, lat(1), lon(1.5), 'place=suburb,name=Barrio%20%Alto'));
  out.push(node(3002, lat(2.2), lon(0.4), 'tourism=museum,name=Museo%20%del%20%Prado'));
  out.push(node(3003, lat(1.1), lon(2.5), 'railway=station,name=Estación%20%Norte'));
  // Los nodos del lago.
  out.push(node(4001, lat(5), lon(5)), node(4002, lat(5), lon(6)), node(4003, lat(6), lon(6)), node(4004, lat(6), lon(5)));
  out.sort((a, b) => Number(a.split(' ')[0]!.slice(1)) - Number(b.split(' ')[0]!.slice(1)));
  const way = (id: number, tags: string, refs: number[]): string => `w${id} v1 dV c1 t2020-01-01T00:00:00Z i1 uX T${tags} N${refs.map((r) => `n${r}`).join(',')}`;
  // Calles este-oeste (j = 0, 1, 2) y norte-sur (i = 0, 1, 2).
  out.push(way(10, 'highway=residential,name=Calle%20%Sur', [nodeId(0, 0), nodeId(1, 0), nodeId(2, 0)]));
  out.push(way(11, 'highway=residential,name=Calle%20%Central,oneway=yes', [nodeId(0, 1), nodeId(1, 1), nodeId(2, 1)]));
  out.push(way(12, 'highway=residential,name=Calle%20%Norte', [nodeId(0, 2), nodeId(1, 2), nodeId(2, 2)]));
  out.push(way(13, 'highway=tertiary,name=Avenida%20%Oeste,sidewalk=both', [nodeId(0, 0), nodeId(0, 1), nodeId(0, 2)]));
  out.push(way(14, 'highway=residential,name=Calle%20%del%20%Medio', [nodeId(1, 0), nodeId(1, 1), nodeId(1, 2)]));
  out.push(way(15, 'highway=residential,name=Avenida%20%Este', [nodeId(2, 0), nodeId(2, 1), nodeId(2, 2)]));
  // Una calle sin salida que parte del norte.
  out.push(way(16, 'highway=service,name=Callejón', [nodeId(1, 2), 2001]));
  // La acera de la calle sur, dibujada aparte (no debe entrar), y un aparcamiento.
  out.push(way(17, 'highway=footway,footway=sidewalk', [nodeId(0, 0), nodeId(1, 0)]));
  out.push(way(18, 'highway=service,service=parking_aisle', [nodeId(1, 1), 2002]));
  // Un camino que apunta a un nodo que no está en el recorte (se descarta).
  out.push(way(19, 'highway=residential,name=Fuera', [nodeId(2, 2), 999_999]));
  // Un parque (anillo cerrado) y un lago dividido en dos caminos.
  out.push(way(20, 'leisure=park,name=Parque%20%Central', [nodeId(0, 0), nodeId(1, 0), nodeId(1, 1), nodeId(0, 1), nodeId(0, 0)]));
  out.push(way(21, '', [4001, 4002, 4003]));
  out.push(way(22, '', [4003, 4004, 4001]));
  out.push('r30 v1 dV c1 t2020-01-01T00:00:00Z i1 uX Ttype=multipolygon,natural=water Mw21@outer,w22@outer');
  return out;
}

describe('leer OPL', () => {
  it('una línea de nodo, de camino y de relación', () => {
    const n = parseOplLine(node(5, '40.1000000', '-3.2000000', 'name=Plaza%20%Mayor,shop=bakery'))!;
    expect(n).toMatchObject({ type: 'n', id: 5, x: -3.2, y: 40.1 });
    expect(n.tags.get('name')).toBe('Plaza Mayor');
    const w = parseOplLine('w9 v1 Thighway=residential,name=A%2c%B Nn1,n2,n3')!;
    expect(w.refs).toEqual([1, 2, 3]);
    expect(w.tags.get('name')).toBe('A,B');
    const r = parseOplLine('r7 v1 Ttype=multipolygon Mw1@outer,w2@inner,n3@')!;
    expect(r.members).toEqual([
      { type: 'w', ref: 1, role: 'outer' },
      { type: 'w', ref: 2, role: 'inner' },
      { type: 'n', ref: 3, role: '' },
    ]);
    expect(parseOplLine('')).toBeNull();
    expect(parseOplLine('# comentario')).toBeNull();
    expect(parseOplLine('xx')).toBeNull();
  });
});

describe('interpretar las etiquetas', () => {
  const t = (s: string): Map<string, string> => new Map(s.split(',').map((p) => p.split('=') as [string, string]));
  it('clases, sentido único, rotondas y acceso', () => {
    expect(classifyHighway(t('highway=residential,name=A'))).toMatchObject({ cls: HW.RESIDENTIAL, name: 'A' });
    expect(classifyHighway(t('highway=residential,oneway=yes'))!.flags & FLAG.ONEWAY_FWD).toBeTruthy();
    expect(classifyHighway(t('highway=residential,oneway=-1'))!.flags & FLAG.ONEWAY_BWD).toBeTruthy();
    const round = classifyHighway(t('highway=tertiary,junction=roundabout'))!;
    expect(round.flags & FLAG.ROUNDABOUT).toBeTruthy();
    expect(round.flags & FLAG.ONEWAY_FWD).toBeTruthy();
    const motorway = classifyHighway(t('highway=motorway'))!;
    expect(motorway.flags & FLAG.FOOT_NO).toBeTruthy();
    expect(motorway.flags & FLAG.BIKE_NO).toBeTruthy();
    expect(classifyHighway(t('highway=trunk'))!.flags & FLAG.FOOT_NO).toBeTruthy();
    expect(classifyHighway(t('highway=trunk,sidewalk=both'))!.flags & FLAG.FOOT_NO).toBeFalsy();
    expect(classifyHighway(t('highway=footway,bicycle=designated'))!.flags & FLAG.BIKE_YES).toBeTruthy();
    expect(classifyHighway(t('highway=residential,bicycle=no'))!.flags & FLAG.BIKE_NO).toBeTruthy();
    expect(classifyHighway(t('highway=residential,oneway=yes,oneway:bicycle=no'))!.flags & FLAG.BIKE_CONTRAFLOW).toBeTruthy();
    expect(classifyHighway(t('highway=secondary,cycleway=lane'))!.flags & FLAG.CYCLE_LANE).toBeTruthy();
    expect(classifyHighway(t('highway=path'))!.flags & FLAG.UNPAVED).toBeTruthy();
    expect(classifyHighway(t('highway=path,surface=asphalt'))!.flags & FLAG.UNPAVED).toBeFalsy();
    expect(classifyHighway(t('highway=secondary,ref=M-30'))!.name).toBe('M-30');
  });
  it('lo que no se recorre', () => {
    expect(classifyHighway(t('highway=footway,footway=sidewalk'))).toBeNull();
    expect(classifyHighway(t('highway=footway,footway=crossing'))).toBeNull();
    expect(classifyHighway(t('highway=service,service=parking_aisle'))).toBeNull();
    expect(classifyHighway(t('highway=pedestrian,area=yes'))).toBeNull();
    expect(classifyHighway(t('highway=residential,access=no'))).toBeNull();
    expect(classifyHighway(t('highway=elevator'))).toBeNull();
    expect(classifyHighway(t('building=yes'))).toBeNull();
  });
  it('zonas y lugares', () => {
    expect(classifyShape(t('leisure=park'), true)).toBe(SHAPE.PARK);
    expect(classifyShape(t('leisure=park'), false)).toBeNull();
    expect(classifyShape(t('natural=water'), true)).toBe(SHAPE.WATER);
    expect(classifyShape(t('waterway=river'), false)).toBe(SHAPE.RIVER);
    expect(classifyShape(t('landuse=forest'), true)).toBe(SHAPE.WOOD);
    expect(classifyPlace(t('place=suburb,name=X'))).toBe(PLACE.SUBURB);
    expect(classifyPlace(t('railway=station,name=X'))).toBe(PLACE.STATION);
    expect(classifyPlace(t('tourism=museum,name=X'))).toBe(PLACE.POI);
    expect(classifyPlace(t('tourism=museum'))).toBeNull();
  });
  it('los comercios, paradas y servicios valen sin nombre y se agrupan por categoría', () => {
    expect(classifyPlace(t('shop=bakery,name=X'))).toBe(PLACE.SHOP);
    expect(classifyPlace(t('shop=supermarket'))).toBe(PLACE.SHOP);
    expect(classifyPlace(t('shop=vacant'))).toBeNull();
    expect(classifyPlace(t('amenity=restaurant,name=X'))).toBe(PLACE.FOOD);
    expect(classifyPlace(t('amenity=fast_food'))).toBe(PLACE.FOOD);
    expect(classifyPlace(t('amenity=cafe'))).toBe(PLACE.CAFE);
    expect(classifyPlace(t('amenity=bar,name=X'))).toBe(PLACE.CAFE);
    expect(classifyPlace(t('amenity=pharmacy'))).toBe(PLACE.HEALTH);
    expect(classifyPlace(t('highway=bus_stop'))).toBe(PLACE.TRANSIT);
    expect(classifyPlace(t('railway=subway_entrance'))).toBe(PLACE.TRANSIT);
    expect(classifyPlace(t('amenity=bicycle_rental,name=BiciMAD'))).toBe(PLACE.BIKE);
    expect(classifyPlace(t('amenity=drinking_water'))).toBe(PLACE.UTILITY);
    expect(classifyPlace(t('amenity=toilets'))).toBe(PLACE.UTILITY);
    expect(classifyPlace(t('amenity=bank'))).toBe(PLACE.SERVICE);
    expect(classifyPlace(t('amenity=school'))).toBe(PLACE.EDU);
    // Lo de siempre sigue exigiendo nombre; una iglesia con nombre es un sitio de interés.
    expect(classifyPlace(t('amenity=place_of_worship,name=Catedral'))).toBe(PLACE.POI);
    expect(classifyPlace(t('amenity=place_of_worship'))).toBeNull();
    expect(classifyPlace(t('amenity=bench'))).toBeNull();
  });
  it('los edificios y las zonas nuevas', () => {
    expect(classifyShape(t('building=yes'), true)).toBe(SHAPE.BUILDING);
    expect(classifyShape(t('building=apartments,name=X'), true)).toBe(SHAPE.BUILDING);
    expect(classifyShape(t('building=no'), true)).toBeNull();
    expect(classifyShape(t('building=yes'), false)).toBeNull();
    // Un edificio con etiquetas de otra cosa sigue siendo un edificio (el recinto es otro camino).
    expect(classifyShape(t('building=school,amenity=school'), true)).toBe(SHAPE.BUILDING);
    expect(classifyShape(t('amenity=school'), true)).toBe(SHAPE.CAMPUS);
    expect(classifyShape(t('amenity=hospital'), true)).toBe(SHAPE.CAMPUS);
    expect(classifyShape(t('landuse=cemetery'), true)).toBe(SHAPE.CEMETERY);
    expect(classifyShape(t('leisure=pitch,sport=soccer'), true)).toBe(SHAPE.PITCH);
    expect(classifyShape(t('leisure=playground'), true)).toBe(SHAPE.PITCH);
    expect(classifyShape(t('amenity=parking'), true)).toBe(SHAPE.PARKING);
    expect(classifyShape(t('landuse=retail'), true)).toBe(SHAPE.COMMERCIAL);
    expect(classifyShape(t('landuse=industrial'), true)).toBe(SHAPE.COMMERCIAL);
    expect(classifyShape(t('landuse=farmland'), true)).toBe(SHAPE.GRASS);
    // Las vías de tren de superficie son líneas (cerradas o no); el metro subterráneo no se dibuja.
    expect(classifyShape(t('railway=rail'), false)).toBe(SHAPE.RAIL);
    expect(classifyShape(t('railway=tram'), false)).toBe(SHAPE.RAIL);
    expect(classifyShape(t('railway=subway'), false)).toBeNull();
    expect(classifyShape(t('railway=platform'), true)).toBeNull();
  });
  it('simplificar quita los puntos que no aportan y une anillos', () => {
    const lat = [0, 1, 2, 3, 4].map((v) => v * 1e-5 * 1e7);
    const lon = [0, 0, 0, 0, 0];
    expect(simplifyIndices(lat, lon, 1.5)).toEqual([0, 4]);
    expect(simplifyIndices([0, 0, 0], [0, 5e-4 * 1e7, 0], 1.5)).toEqual([0, 1, 2]);
    expect(assembleRings([[1, 2, 3], [3, 4, 1]])).toEqual([[3, 4, 1, 2, 3]].map((r) => expect.arrayContaining(r)));
    expect(assembleRings([[1, 2, 3]])).toEqual([]);
  });
});

describe('construir el paquete', async () => {
  const { input, stats } = await buildMapPack(fixture(), { name: 'prueba', title: 'Prueba' });
  const pack = readPack(writePack(input));
  const graph = buildGraph(pack);

  it('cuenta lo que hay', () => {
    expect(stats.nodes).toBe(9 + 2 + 3 + 4);
    expect(stats.highways).toBe(7); // 6 calles y el callejón: ni la acera, ni el aparcamiento, y «Fuera» se descarta por el nodo que falta
    expect(stats.skippedWays).toBe(1);
    expect(pack.edgeCount).toBeGreaterThanOrEqual(12);
    expect(pack.meta.name).toBe('Prueba');
  });

  it('corta en los cruces, con nombres y sentido único', () => {
    const names = new Set<string>();
    for (let e = 0; e < pack.edgeCount; e++) names.add(nameOf(pack, pack.edgeName[e]!));
    for (const n of ['Calle Sur', 'Calle Central', 'Calle Norte', 'Avenida Oeste', 'Calle del Medio', 'Avenida Este', 'Callejón']) expect(names.has(n)).toBe(true);
    expect(names.has('Fuera')).toBe(false);
    let oneway = 0;
    for (let e = 0; e < pack.edgeCount; e++) if (nameOf(pack, pack.edgeName[e]!) === 'Calle Central' && pack.edgeFlags[e]! & FLAG.ONEWAY_FWD) oneway++;
    expect(oneway).toBe(2);
    // La acera dibujada aparte no entra como tramo.
    for (let e = 0; e < pack.edgeCount; e++) expect(pack.edgeCls[e]).not.toBe(HW.FOOTWAY);
  });

  it('las zonas: el parque y el lago armado con un multipolígono', () => {
    const kinds = Array.from(pack.shapeKind);
    expect(kinds).toContain(SHAPE.PARK);
    expect(kinds).toContain(SHAPE.WATER);
  });

  it('los lugares y una entrada por calle con su barrio', () => {
    const index = buildSearchIndex(pack);
    const museum = searchPlaces(index, 'museo prado')[0];
    expect(museum).toMatchObject({ name: 'Museo del Prado', kind: PLACE.POI });
    expect(searchPlaces(index, 'estacion norte')[0]?.kind).toBe(PLACE.STATION);
    const street = searchPlaces(index, 'calle central')[0];
    expect(street).toMatchObject({ name: 'Calle Central', kind: PLACE.STREET, area: 'Barrio Alto' });
    expect(searchPlaces(index, 'parque central')[0]?.kind).toBe(PLACE.PARK);
  });

  it('con ese paquete se encuentra ruta, respetando el sentido único en bici, y salen instrucciones', () => {
    const a = { lat: BASE_LAT, lon: BASE_LON }; // esquina suroeste
    const b = { lat: BASE_LAT + 2 * 0.0009, lon: BASE_LON + 2 * 0.0012 }; // esquina noreste
    const walk = findRoute(graph, PROFILES.walk, a, b);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.route.distanceM).toBeGreaterThan(380);
    expect(walk.route.distanceM).toBeLessThan(430);
    const steps = buildSteps(graph, walk.route, b);
    expect(steps[0]!.text).toMatch(/^Camina hacia el /);
    expect(steps.at(-1)!.type).toBe('arrive');
    // Contra el sentido único de la calle central: a pie sí, en bici hay que dar la vuelta.
    const west = { lat: BASE_LAT + 0.0009, lon: BASE_LON + 0.0024 };
    const east = { lat: BASE_LAT + 0.0009, lon: BASE_LON };
    const onFoot = findRoute(graph, PROFILES.walk, west, east);
    const onBike = findRoute(graph, PROFILES.bike, west, east);
    expect(onFoot.ok && onBike.ok).toBe(true);
    if (onFoot.ok && onBike.ok) expect(onBike.route.distanceM).toBeGreaterThan(onFoot.route.distanceM + 100);
  });
});

describe('entradas rotas', () => {
  it('sin caminos o sin calles no inventa nada', async () => {
    await expect(buildMapPack([node(1, '40.0', '-3.0')], { name: 'x', title: 'x' })).rejects.toThrow(/no tiene caminos/);
    await expect(buildMapPack([node(1, '40.0', '-3.0'), 'w5 v1 Thighway=elevator N' + 'n1,n1'], { name: 'x', title: 'x' })).rejects.toThrow(/ninguna calle/);
  });
  it('nodos desordenados se piden ordenar', async () => {
    await expect(buildMapPack([node(5, '40.0', '-3.0'), node(3, '40.0', '-3.0'), 'w1 v1 Thighway=residential Nn5,n3'], { name: 'x', title: 'x' })).rejects.toThrow(/ordenados/);
  });
});
