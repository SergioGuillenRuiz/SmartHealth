import { M_PER_DEG, mPerDegLon, type LatLon } from './geo.ts';
import type { OverpassResponse } from './overpass.ts';

// Lo que contestaría Overpass (`out geom`) para una ciudad de mentira: una cuadrícula de calles con nombre, un parque (un camino cerrado con nombre), un lago hecho de dos caminos sin etiquetas
// dentro de una relación multipolígono, un barrio y un museo, y lo de la caja de detalle (edificios, una vía de tren, comercios y una parada). Sirve para probar la traducción, la descarga y, en el e2e, el mapa entero sin tocar internet.

export const FIXTURE_CENTER: LatLon = { lat: 40.4168, lon: -3.7038 };

const EAST_WEST = ['Calle de Alcalá', 'Calle Mayor', 'Calle del Arenal', 'Calle de Preciados', 'Calle de Hortaleza', 'Avenida Principal', 'Calle de Fuencarral', 'Calle de Atocha', 'Calle de Toledo', 'Calle de Segovia', 'Calle de Bailén'];
const NORTH_SOUTH = ['Calle de Serrano', 'Calle de Velázquez', 'Calle de Goya', 'Calle de Génova', 'Calle de Embajadores', 'Avenida Central', 'Calle de Lavapiés', 'Calle de Argumosa', 'Calle de Montera', 'Calle de Carretas', 'Calle de Alfonso XII'];

export interface FixtureOptions {
  center?: LatLon;
  /** Manzanas por lado (de `blockM` metros). */
  blocks?: number;
  blockM?: number;
}

type Point = { lat: number; lon: number };

export function overpassCity(options: FixtureOptions = {}): OverpassResponse {
  const center = options.center ?? FIXTURE_CENTER;
  const blocks = options.blocks ?? 8;
  const blockM = options.blockM ?? 100;
  const kx = mPerDegLon(center.lat);
  const origin = { lat: center.lat - (blocks * blockM) / 2 / M_PER_DEG, lon: center.lon - (blocks * blockM) / 2 / kx };
  const at = (x: number, y: number): Point => ({ lat: Number((origin.lat + y / M_PER_DEG).toFixed(7)), lon: Number((origin.lon + x / kx).toFixed(7)) });
  const gridId = (i: number, j: number): number => 1_000_000 + i * 1000 + j;
  const elements: NonNullable<OverpassResponse['elements']> = [];

  // Las calles: una por fila y una por columna, con todos sus nodos de la cuadrícula.
  for (let j = 0; j <= blocks; j++) {
    const ids = Array.from({ length: blocks + 1 }, (_, i) => gridId(i, j));
    elements.push({ type: 'way', id: 10_000 + j, nodes: ids, geometry: ids.map((_, i) => at(i * blockM, j * blockM)), tags: { highway: j === Math.floor(blocks / 2) ? 'tertiary' : 'residential', name: EAST_WEST[j % EAST_WEST.length]! } });
  }
  for (let i = 0; i <= blocks; i++) {
    const ids = Array.from({ length: blocks + 1 }, (_, j) => gridId(i, j));
    elements.push({ type: 'way', id: 20_000 + i, nodes: ids, geometry: ids.map((_, j) => at(i * blockM, j * blockM)), tags: { highway: 'residential', name: NORTH_SOUTH[i % NORTH_SOUTH.length]! } });
  }
  // Una acera dibujada aparte (se ignora) y un camino sin salida.
  elements.push({ type: 'way', id: 30_001, nodes: [gridId(0, 0), 5_000_001], geometry: [at(0, 0), at(-60, 0)], tags: { highway: 'footway', footway: 'sidewalk' } });
  elements.push({ type: 'way', id: 30_002, nodes: [gridId(blocks, 1), 5_000_002], geometry: [at(blocks * blockM, blockM), at(blocks * blockM + 80, blockM)], tags: { highway: 'service', name: 'Calle sin Salida' } });

  // Un parque dentro de una manzana (anillo cerrado con nombre).
  const px = Math.floor(blocks * 0.6);
  const py = Math.floor(blocks * 0.6);
  const ring: Point[] = [at(px * blockM + 20, py * blockM + 20), at(px * blockM + 80, py * blockM + 20), at(px * blockM + 80, py * blockM + 80), at(px * blockM + 20, py * blockM + 80), at(px * blockM + 20, py * blockM + 20)];
  elements.push({ type: 'way', id: 40_001, nodes: [6_000_001, 6_000_002, 6_000_003, 6_000_004, 6_000_001], geometry: ring, tags: { leisure: 'park', name: 'Parque de la Ciudadela' } });

  // Un lago: dos mitades sin etiquetas dentro de una relación (Overpass solo da su geometría).
  const lx = 1;
  const ly = Math.floor(blocks * 0.2);
  const north: Point[] = [at(lx * blockM + 15, ly * blockM + 15), at(lx * blockM + 85, ly * blockM + 15), at(lx * blockM + 85, ly * blockM + 50)];
  const south: Point[] = [at(lx * blockM + 85, ly * blockM + 50), at(lx * blockM + 85, ly * blockM + 85), at(lx * blockM + 15, ly * blockM + 85), at(lx * blockM + 15, ly * blockM + 15)];
  elements.push({
    type: 'relation',
    id: 50_001,
    members: [
      { type: 'way', ref: 50_101, role: 'outer', geometry: north },
      { type: 'way', ref: 50_102, role: 'outer', geometry: south },
    ],
    tags: { type: 'multipolygon', natural: 'water', name: 'Estanque' },
  });

  // Lo de la caja de detalle: dos edificios (uno con nombre), una vía de tren y comercios, una parada sin nombre y un café.
  const house = (id: number, i: number, j: number, tags: Record<string, string>): void => {
    const ring2: Point[] = [at(i * blockM + 25, j * blockM + 25), at(i * blockM + 75, j * blockM + 25), at(i * blockM + 75, j * blockM + 70), at(i * blockM + 25, j * blockM + 70), at(i * blockM + 25, j * blockM + 25)];
    elements.push({ type: 'way', id, nodes: [id * 10 + 1, id * 10 + 2, id * 10 + 3, id * 10 + 4, id * 10 + 1], geometry: ring2, tags });
  };
  house(70_001, 3, 2, { building: 'yes' });
  house(70_002, 3, 3, { building: 'apartments', name: 'Edificio Aurora' });
  elements.push({ type: 'way', id: 70_003, nodes: [8_000_001, 8_000_002], geometry: [at(-50, -45), at(blocks * blockM + 50, -45)], tags: { railway: 'rail' } });
  const shop = at(5 * blockM + 10, 2 * blockM + 10);
  elements.push({ type: 'node', id: 60_003, lat: shop.lat, lon: shop.lon, tags: { shop: 'bakery', name: 'Panadería Sol' } });
  const stop = at(2 * blockM + 8, 6 * blockM + 8);
  elements.push({ type: 'node', id: 60_004, lat: stop.lat, lon: stop.lon, tags: { highway: 'bus_stop' } });
  const cafe = at(6 * blockM + 8, 6 * blockM + 8);
  elements.push({ type: 'node', id: 60_005, lat: cafe.lat, lon: cafe.lon, tags: { amenity: 'cafe', name: 'Café del Parque' } });

  // Lugares con nombre.
  const mid = at((blocks * blockM) / 2, (blocks * blockM) / 2);
  elements.push({ type: 'node', id: 60_001, lat: mid.lat, lon: mid.lon, tags: { place: 'suburb', name: 'Barrio Centro' } });
  const museum = at(2 * blockM + 50, 5 * blockM + 50);
  elements.push({ type: 'node', id: 60_002, lat: museum.lat, lon: museum.lon, tags: { tourism: 'museum', name: 'Museo del Prado' } });
  return { elements };
}

type FixtureElement = NonNullable<OverpassResponse['elements']>[number];

/** Lo que la consulta de DETALLE pide (edificios, comercios, paradas, cafés): el resto es lo ligero. */
const isDetailElement = (element: FixtureElement): boolean => {
  const tags = element.tags ?? {};
  return tags.building !== undefined || tags.shop !== undefined || tags.highway === 'bus_stop' || tags.amenity === 'cafe';
};

/** La ciudad SIN el detalle: lo que contesta Overpass a la consulta ligera con la que se abre el mapa (calles, parque, lago, barrio, museo, vía de tren). */
export const overpassCityLight = (options: FixtureOptions = {}): OverpassResponse => ({ elements: (overpassCity(options).elements ?? []).filter((element) => !isDetailElement(element)) });

/** SOLO el detalle de la ciudad: lo que contesta Overpass a la consulta de detalle (dos edificios, una panadería, una parada sin nombre y un café). */
export const overpassCityDetail = (options: FixtureOptions = {}): OverpassResponse => ({ elements: (overpassCity(options).elements ?? []).filter(isDetailElement) });

/** El centro de una manzana de la ciudad (para colocar una posición o un destino en pruebas). */
export function fixtureCorner(i: number, j: number, options: FixtureOptions = {}): LatLon {
  const center = options.center ?? FIXTURE_CENTER;
  const blocks = options.blocks ?? 8;
  const blockM = options.blockM ?? 100;
  const kx = mPerDegLon(center.lat);
  return { lat: center.lat - (blocks * blockM) / 2 / M_PER_DEG + (j * blockM) / M_PER_DEG, lon: center.lon - (blocks * blockM) / 2 / kx + (i * blockM) / kx };
}
