import { fromE7 } from './geo.ts';

// El paquete de mapa: un solo archivo binario con lo que el navegador necesita de una zona (calles con su geometría y sus atributos, zonas verdes y agua para dibujar, y nombres de
// lugares y calles para buscar). Lo genera `tools/map-pack` a partir de OpenStreetMap y va dentro del APK (`maps/<zona>.map`): el navegador no pide nada a internet.
//
// Formato (little-endian): cabecera de 16 bytes —«SMAP», versión, número de secciones, reservado— y una tabla de secciones de 16 bytes cada una (id, desplazamiento, bytes, elementos);
// cada sección empieza alineada a 8 bytes para poder abrirla como un array tipado SIN copiarla. Las coordenadas son grados × 1e7 enteros.
//
// El grafo: los NODOS son cruces y extremos (los puntos intermedios de una calle no lo son); cada TRAMO (arista, sin dirección) une dos nodos y lleva su geometría intermedia, su
// longitud en decímetros, su clase de vía, sus banderas (sentido único, superficie, acceso a pie y en bici…) y el nombre de la calle.

export const PACK_MAGIC = 0x50414d53; // «SMAP»
// Versión 2 (ronda 44): formas nuevas (edificios, cementerios, recintos, campos deportivos, aparcamientos, zonas comerciales y vías de tren), lugares nuevos por
// categoría (comida, comercios, salud, transporte…) y, en los lugares sin nombre, `NO_NAME`. Un mapa guardado de la versión 1 se descarta y se vuelve a bajar.
export const PACK_VERSION = 2;
export const NO_NAME = 0xffffffff;

/** Clase de vía de un tramo (la etiqueta `highway` de OpenStreetMap, agrupada). */
export const HW = {
  MOTORWAY: 1,
  TRUNK: 2,
  PRIMARY: 3,
  SECONDARY: 4,
  TERTIARY: 5,
  UNCLASSIFIED: 6,
  RESIDENTIAL: 7,
  LIVING_STREET: 8,
  SERVICE: 9,
  PEDESTRIAN: 10,
  FOOTWAY: 11,
  PATH: 12,
  CYCLEWAY: 13,
  TRACK: 14,
  STEPS: 15,
} as const;
export const HW_MAX = 15;

/** Banderas de un tramo. */
export const FLAG = {
  /** Solo se recorre de `a` a `b` (vehículos y bicis). */
  ONEWAY_FWD: 1 << 0,
  /** Solo se recorre de `b` a `a`. */
  ONEWAY_BWD: 1 << 1,
  FOOT_NO: 1 << 2,
  BIKE_NO: 1 << 3,
  /** Una vía peatonal (acera, sendero, peatonal) por la que la bici también puede ir. */
  BIKE_YES: 1 << 4,
  UNPAVED: 1 << 5,
  LIT: 1 << 6,
  ROUNDABOUT: 1 << 7,
  BRIDGE: 1 << 8,
  TUNNEL: 1 << 9,
  /** Carril bici en la propia calle o junto a ella. */
  CYCLE_LANE: 1 << 10,
  /** Las bicis pueden ir en contra del sentido único. */
  BIKE_CONTRAFLOW: 1 << 11,
  SIDEWALK: 1 << 12,
} as const;

/**
 * Qué es una forma que se dibuja (no se recorre). Las que acaban en línea son abiertas (un río, una vía de tren); el resto son polígonos.
 * `BUILDING` solo viene dentro de la caja de detalle (`PackMeta.detail`).
 */
export const SHAPE = { PARK: 1, WOOD: 2, GRASS: 3, WATER: 4, SAND: 5, BUILDING: 6, CEMETERY: 7, CAMPUS: 8, PITCH: 9, PARKING: 10, COMMERCIAL: 11, RIVER: 16, STREAM: 17, RAIL: 18 } as const;
export const isLineShape = (kind: number): boolean => kind >= 16;

/**
 * Qué es un lugar que se busca o se rotula. Del 1 al 9, los de siempre (con nombre); del 10 en adelante, los comercios y servicios de la caja de detalle, que pueden no tener nombre (una
 * parada, una fuente) y se dibujan como una marca pequeña de su categoría.
 */
export const PLACE = { CITY: 1, TOWN: 2, VILLAGE: 3, SUBURB: 4, NEIGHBOURHOOD: 5, STREET: 6, PARK: 7, STATION: 8, POI: 9, FOOD: 10, CAFE: 11, SHOP: 12, HEALTH: 13, TRANSIT: 14, BIKE: 15, SERVICE: 16, EDU: 17, UTILITY: 18 } as const;
/** Los lugares que son una marca de categoría (con o sin nombre), no un rótulo de zona. */
export const isMarkerPlace = (kind: number): boolean => kind >= PLACE.FOOD;
export const PLACE_LABELS: Record<number, string> = {
  [PLACE.CITY]: 'Ciudad',
  [PLACE.TOWN]: 'Localidad',
  [PLACE.VILLAGE]: 'Pueblo',
  [PLACE.SUBURB]: 'Barrio',
  [PLACE.NEIGHBOURHOOD]: 'Barrio',
  [PLACE.STREET]: 'Calle',
  [PLACE.PARK]: 'Parque',
  [PLACE.STATION]: 'Estación',
  [PLACE.POI]: 'Lugar',
  [PLACE.FOOD]: 'Restaurante',
  [PLACE.CAFE]: 'Café o bar',
  [PLACE.SHOP]: 'Comercio',
  [PLACE.HEALTH]: 'Salud',
  [PLACE.TRANSIT]: 'Parada',
  [PLACE.BIKE]: 'Bicicletas',
  [PLACE.SERVICE]: 'Servicio',
  [PLACE.EDU]: 'Centro de estudios',
  [PLACE.UTILITY]: 'Agua o aseos',
};

export interface PackMeta {
  name: string;
  /** De dónde salen los datos y cuándo se generó (texto). */
  source: string;
  generatedAt: string;
  /** Caja que cubre el paquete, en grados. */
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /**
   * La caja en la que sí se bajaron los edificios y los comercios (más pequeña que `bbox`: son muchísimos más que las calles). Fuera de ella el mapa tiene calles, zonas verdes y agua, pero no
   * edificios, y se dibujan desvanecidos hacia su borde. Ausente: no hay detalle (o es toda la zona).
   */
  detail?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

/** El paquete abierto: arrays tipados sobre el mismo buffer (nada se copia) y los nombres para decodificar a demanda. */
export interface MapPack {
  meta: PackMeta;
  nodeCount: number;
  nodeLat: Int32Array;
  nodeLon: Int32Array;
  edgeCount: number;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  /** Longitud de cada tramo en decímetros. */
  edgeLenDm: Uint32Array;
  edgeCls: Uint8Array;
  edgeFlags: Uint16Array;
  edgeName: Uint32Array;
  /** `edgeGeomStart[i]..edgeGeomStart[i+1]` son los puntos intermedios del tramo `i` en `geomLat`/`geomLon`, de `a` a `b`. */
  edgeGeomStart: Uint32Array;
  geomLat: Int32Array;
  geomLon: Int32Array;
  nameOffsets: Uint32Array;
  nameBytes: Uint8Array;
  shapeCount: number;
  shapeKind: Uint8Array;
  shapeStart: Uint32Array;
  shapeLat: Int32Array;
  shapeLon: Int32Array;
  placeCount: number;
  placeKind: Uint8Array;
  placeLat: Int32Array;
  placeLon: Int32Array;
  placeName: Uint32Array;
  /** El nombre de la zona en que está (un barrio o localidad), o `NO_NAME`. */
  placeArea: Uint32Array;
}

/** Lo que recibe el escritor: los mismos arrays (cualquier lista de números) y los nombres como texto. */
export interface PackInput {
  meta: PackMeta;
  nodeLat: ArrayLike<number>;
  nodeLon: ArrayLike<number>;
  edgeA: ArrayLike<number>;
  edgeB: ArrayLike<number>;
  edgeLenDm: ArrayLike<number>;
  edgeCls: ArrayLike<number>;
  edgeFlags: ArrayLike<number>;
  edgeName: ArrayLike<number>;
  edgeGeomStart: ArrayLike<number>;
  geomLat: ArrayLike<number>;
  geomLon: ArrayLike<number>;
  names: readonly string[];
  shapeKind: ArrayLike<number>;
  shapeStart: ArrayLike<number>;
  shapeLat: ArrayLike<number>;
  shapeLon: ArrayLike<number>;
  placeKind: ArrayLike<number>;
  placeLat: ArrayLike<number>;
  placeLon: ArrayLike<number>;
  placeName: ArrayLike<number>;
  placeArea: ArrayLike<number>;
}

const SEC = {
  META: 1,
  NODE_LAT: 2,
  NODE_LON: 3,
  EDGE_A: 4,
  EDGE_B: 5,
  EDGE_LEN: 6,
  EDGE_CLS: 7,
  EDGE_FLAGS: 8,
  EDGE_NAME: 9,
  EDGE_GEOM_START: 10,
  GEOM_LAT: 11,
  GEOM_LON: 12,
  NAME_OFFSETS: 13,
  NAME_BYTES: 14,
  SHAPE_KIND: 15,
  SHAPE_START: 16,
  SHAPE_LAT: 17,
  SHAPE_LON: 18,
  PLACE_KIND: 19,
  PLACE_LAT: 20,
  PLACE_LON: 21,
  PLACE_NAME: 22,
  PLACE_AREA: 23,
} as const;
const SECTION_IDS = Object.values(SEC);
const HEADER_BYTES = 16;
const ENTRY_BYTES = 16;

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

const align8 = (n: number): number => (n + 7) & ~7;

type Typed = Int32Array | Uint32Array | Uint16Array | Uint8Array;

/** Escribe el paquete. */
export function writePack(input: PackInput): ArrayBuffer {
  const encoder = new TextEncoder();
  const nameChunks = input.names.map((n) => encoder.encode(n));
  const nameOffsets = new Uint32Array(nameChunks.length + 1);
  let total = 0;
  nameChunks.forEach((chunk, i) => {
    nameOffsets[i] = total;
    total += chunk.length;
  });
  nameOffsets[nameChunks.length] = total;
  const nameBytes = new Uint8Array(total);
  nameChunks.forEach((chunk, i) => nameBytes.set(chunk, nameOffsets[i]!));

  const sections: Array<{ id: number; data: Typed }> = [
    { id: SEC.META, data: encoder.encode(JSON.stringify(input.meta)) },
    { id: SEC.NODE_LAT, data: Int32Array.from(input.nodeLat) },
    { id: SEC.NODE_LON, data: Int32Array.from(input.nodeLon) },
    { id: SEC.EDGE_A, data: Uint32Array.from(input.edgeA) },
    { id: SEC.EDGE_B, data: Uint32Array.from(input.edgeB) },
    { id: SEC.EDGE_LEN, data: Uint32Array.from(input.edgeLenDm) },
    { id: SEC.EDGE_CLS, data: Uint8Array.from(input.edgeCls) },
    { id: SEC.EDGE_FLAGS, data: Uint16Array.from(input.edgeFlags) },
    { id: SEC.EDGE_NAME, data: Uint32Array.from(input.edgeName) },
    { id: SEC.EDGE_GEOM_START, data: Uint32Array.from(input.edgeGeomStart) },
    { id: SEC.GEOM_LAT, data: Int32Array.from(input.geomLat) },
    { id: SEC.GEOM_LON, data: Int32Array.from(input.geomLon) },
    { id: SEC.NAME_OFFSETS, data: nameOffsets },
    { id: SEC.NAME_BYTES, data: nameBytes },
    { id: SEC.SHAPE_KIND, data: Uint8Array.from(input.shapeKind) },
    { id: SEC.SHAPE_START, data: Uint32Array.from(input.shapeStart) },
    { id: SEC.SHAPE_LAT, data: Int32Array.from(input.shapeLat) },
    { id: SEC.SHAPE_LON, data: Int32Array.from(input.shapeLon) },
    { id: SEC.PLACE_KIND, data: Uint8Array.from(input.placeKind) },
    { id: SEC.PLACE_LAT, data: Int32Array.from(input.placeLat) },
    { id: SEC.PLACE_LON, data: Int32Array.from(input.placeLon) },
    { id: SEC.PLACE_NAME, data: Uint32Array.from(input.placeName) },
    { id: SEC.PLACE_AREA, data: Uint32Array.from(input.placeArea) },
  ];

  let offset = align8(HEADER_BYTES + sections.length * ENTRY_BYTES);
  const placed = sections.map((s) => {
    const at = offset;
    offset = align8(at + s.data.byteLength);
    return { ...s, at };
  });
  const buffer = new ArrayBuffer(offset);
  const header = new Uint32Array(buffer, 0, 4);
  header[0] = PACK_MAGIC;
  header[1] = PACK_VERSION;
  header[2] = sections.length;
  const table = new Uint32Array(buffer, HEADER_BYTES, sections.length * 4);
  const bytes = new Uint8Array(buffer);
  placed.forEach((s, i) => {
    table[i * 4] = s.id;
    table[i * 4 + 1] = s.at;
    table[i * 4 + 2] = s.data.byteLength;
    table[i * 4 + 3] = s.data.length;
    bytes.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength), s.at);
  });
  return buffer;
}

/** Abre un paquete comprobando que es coherente (un archivo cortado o estropeado no debe colgar el navegador en medio de una ruta). */
export function readPack(buffer: ArrayBuffer): MapPack {
  if (buffer.byteLength < HEADER_BYTES) throw new PackError('El archivo del mapa está vacío o cortado.');
  const header = new Uint32Array(buffer, 0, 4);
  if (header[0] !== PACK_MAGIC) throw new PackError('El archivo no es un mapa de SmartHealth.');
  if (header[1] !== PACK_VERSION) throw new PackError(`El mapa es de otra versión (${header[1]}); esta app lee la ${PACK_VERSION}.`);
  const count = header[2]!;
  if (count !== SECTION_IDS.length || HEADER_BYTES + count * ENTRY_BYTES > buffer.byteLength) throw new PackError('La tabla del mapa está incompleta.');
  const table = new Uint32Array(buffer, HEADER_BYTES, count * 4);
  const found = new Map<number, { at: number; bytes: number; length: number }>();
  for (let i = 0; i < count; i++) found.set(table[i * 4]!, { at: table[i * 4 + 1]!, bytes: table[i * 4 + 2]!, length: table[i * 4 + 3]! });

  const take = <T extends Typed>(id: number, ctor: new (b: ArrayBuffer, o: number, l: number) => T, size: number): T => {
    const entry = found.get(id);
    if (!entry) throw new PackError(`Falta la sección ${id} del mapa.`);
    if (entry.at % 8 !== 0 || entry.at + entry.bytes > buffer.byteLength || entry.length * size !== entry.bytes) throw new PackError(`La sección ${id} del mapa está cortada.`);
    return new ctor(buffer, entry.at, entry.length);
  };
  const metaEntry = found.get(SEC.META);
  if (!metaEntry || metaEntry.at + metaEntry.bytes > buffer.byteLength) throw new PackError('Falta la información del mapa.');
  let meta: PackMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, metaEntry.at, metaEntry.bytes))) as PackMeta;
  } catch {
    throw new PackError('La información del mapa está estropeada.');
  }

  const pack: MapPack = {
    meta,
    nodeCount: 0,
    nodeLat: take(SEC.NODE_LAT, Int32Array, 4),
    nodeLon: take(SEC.NODE_LON, Int32Array, 4),
    edgeCount: 0,
    edgeA: take(SEC.EDGE_A, Uint32Array, 4),
    edgeB: take(SEC.EDGE_B, Uint32Array, 4),
    edgeLenDm: take(SEC.EDGE_LEN, Uint32Array, 4),
    edgeCls: take(SEC.EDGE_CLS, Uint8Array, 1),
    edgeFlags: take(SEC.EDGE_FLAGS, Uint16Array, 2),
    edgeName: take(SEC.EDGE_NAME, Uint32Array, 4),
    edgeGeomStart: take(SEC.EDGE_GEOM_START, Uint32Array, 4),
    geomLat: take(SEC.GEOM_LAT, Int32Array, 4),
    geomLon: take(SEC.GEOM_LON, Int32Array, 4),
    nameOffsets: take(SEC.NAME_OFFSETS, Uint32Array, 4),
    nameBytes: take(SEC.NAME_BYTES, Uint8Array, 1),
    shapeCount: 0,
    shapeKind: take(SEC.SHAPE_KIND, Uint8Array, 1),
    shapeStart: take(SEC.SHAPE_START, Uint32Array, 4),
    shapeLat: take(SEC.SHAPE_LAT, Int32Array, 4),
    shapeLon: take(SEC.SHAPE_LON, Int32Array, 4),
    placeCount: 0,
    placeKind: take(SEC.PLACE_KIND, Uint8Array, 1),
    placeLat: take(SEC.PLACE_LAT, Int32Array, 4),
    placeLon: take(SEC.PLACE_LON, Int32Array, 4),
    placeName: take(SEC.PLACE_NAME, Uint32Array, 4),
    placeArea: take(SEC.PLACE_AREA, Uint32Array, 4),
  };
  pack.nodeCount = pack.nodeLat.length;
  pack.edgeCount = pack.edgeA.length;
  pack.shapeCount = pack.shapeKind.length;
  pack.placeCount = pack.placeKind.length;
  validatePack(pack);
  return pack;
}

function validatePack(p: MapPack): void {
  const bad = (what: string): never => {
    throw new PackError(`El mapa no es coherente: ${what}.`);
  };
  if (p.nodeLon.length !== p.nodeCount) bad('nodos');
  for (const arr of [p.edgeB, p.edgeLenDm, p.edgeCls, p.edgeFlags, p.edgeName]) if (arr.length !== p.edgeCount) bad('tramos');
  if (p.edgeGeomStart.length !== p.edgeCount + 1) bad('geometría de los tramos');
  if (p.geomLon.length !== p.geomLat.length) bad('puntos de los tramos');
  const names = p.nameOffsets.length - 1;
  if (names < 0 || p.nameOffsets[names] !== p.nameBytes.length) bad('nombres');
  for (let i = 0; i < p.edgeCount; i++) {
    if (p.edgeA[i]! >= p.nodeCount || p.edgeB[i]! >= p.nodeCount) bad('un tramo apunta a un nodo que no existe');
    const n = p.edgeName[i]!;
    if (n !== NO_NAME && n >= names) bad('un tramo apunta a un nombre que no existe');
    if (p.edgeGeomStart[i]! > p.edgeGeomStart[i + 1]!) bad('geometría desordenada');
  }
  if (p.edgeGeomStart[0] !== 0 || p.edgeGeomStart[p.edgeCount] !== p.geomLat.length) bad('geometría incompleta');
  for (let i = 0; i < names; i++) if (p.nameOffsets[i]! > p.nameOffsets[i + 1]!) bad('nombres desordenados');
  if (p.shapeStart.length !== p.shapeCount + 1) bad('formas');
  if (p.shapeLon.length !== p.shapeLat.length || p.shapeStart[0] !== 0 || p.shapeStart[p.shapeCount] !== p.shapeLat.length) bad('puntos de las formas');
  for (let i = 0; i < p.shapeCount; i++) if (p.shapeStart[i]! > p.shapeStart[i + 1]!) bad('formas desordenadas');
  for (const arr of [p.placeLat, p.placeLon, p.placeName, p.placeArea]) if (arr.length !== p.placeCount) bad('lugares');
  for (let i = 0; i < p.placeCount; i++) {
    const n = p.placeName[i]!;
    const a = p.placeArea[i]!;
    // Un comercio, una parada o una fuente pueden no tener nombre; los demás lugares sí.
    if ((n !== NO_NAME && n >= names) || (n === NO_NAME && !isMarkerPlace(p.placeKind[i]!)) || (a !== NO_NAME && a >= names)) bad('un lugar apunta a un nombre que no existe');
  }
}

const decoder = new TextDecoder();
const nameCache = new WeakMap<MapPack, Map<number, string>>();

/** El texto de un nombre del paquete (`''` si no hay). */
export function nameOf(pack: MapPack, id: number): string {
  if (id === NO_NAME || id >= pack.nameOffsets.length - 1) return '';
  let cache = nameCache.get(pack);
  if (!cache) {
    cache = new Map();
    nameCache.set(pack, cache);
  }
  const known = cache.get(id);
  if (known !== undefined) return known;
  const text = decoder.decode(pack.nameBytes.subarray(pack.nameOffsets[id]!, pack.nameOffsets[id + 1]!));
  cache.set(id, text);
  return text;
}

/** Las coordenadas de un nodo en grados. */
export const nodePoint = (pack: MapPack, node: number): { lat: number; lon: number } => ({ lat: fromE7(pack.nodeLat[node]!), lon: fromE7(pack.nodeLon[node]!) });
