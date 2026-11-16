// Convierte datos de OpenStreetMap en un paquete de mapa (formato en `pack.ts`): se queda con las calles y sendas por las que se puede ir a pie o en bici, las zonas verdes y el agua para
// dibujar y los nombres para buscar. Acepta objetos ya leídos (`OplObject`, lo que hace la app con lo que le da Overpass: `overpass.ts`) o líneas de texto OPL (el formato de `osmium`, que
// usan las pruebas); en los dos casos primero llegan los nodos (ordenados por identificador), luego los caminos y por último las relaciones.
// Los datos son de OpenStreetMap (ODbL 1.0, © colaboradores de OpenStreetMap): ver docs/atribuciones.md.

import { E7, M_PER_DEG, e7, flatDistanceM, fromE7, toRad } from './geo.ts';
import { FLAG, HW, NO_NAME, PLACE, SHAPE, type PackInput } from './pack.ts';

// ───────────────────────────── OPL ─────────────────────────────

export interface OplObject {
  type: 'n' | 'w' | 'r';
  id: number;
  tags: Map<string, string>;
  /** Nodos: longitud y latitud (grados). */
  x?: number;
  y?: number;
  /** Caminos: los nodos que lo forman. */
  refs?: number[];
  /** Relaciones: sus miembros. */
  members?: Array<{ type: string; ref: number; role: string }>;
}

/** Los `%2c%` de OPL (un carácter escapado entre porcentajes, en hexadecimal) como el carácter. */
const unescapeOpl = (text: string): string => (text.includes('%') ? text.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))) : text);

/** Una línea OPL como objeto, o `null` si no lo es (vacía, comentario o de un tipo que no se usa). */
export function parseOplLine(line: string): OplObject | null {
  if (line.length < 2) return null;
  const kind = line[0]!;
  if (kind !== 'n' && kind !== 'w' && kind !== 'r') return null;
  const parts = line.split(' ');
  const id = Number(parts[0]!.slice(1));
  if (!Number.isFinite(id)) return null;
  const out: OplObject = { type: kind, id, tags: new Map() };
  for (let i = 1; i < parts.length; i++) {
    const field = parts[i]!;
    const tag = field[0];
    const rest = field.slice(1);
    if (tag === 'T') {
      if (rest === '') continue;
      for (const pair of rest.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        out.tags.set(unescapeOpl(pair.slice(0, eq)), unescapeOpl(pair.slice(eq + 1)));
      }
    } else if (tag === 'x') out.x = rest === '' ? undefined : Number(rest);
    else if (tag === 'y') out.y = rest === '' ? undefined : Number(rest);
    else if (tag === 'N') out.refs = rest === '' ? [] : rest.split(',').map((r) => Number(r.slice(1)));
    else if (tag === 'M') {
      out.members = [];
      if (rest !== '') {
        for (const m of rest.split(',')) {
          const at = m.indexOf('@');
          out.members.push({ type: m[0]!, ref: Number(m.slice(1, at === -1 ? undefined : at)), role: at === -1 ? '' : unescapeOpl(m.slice(at + 1)) });
        }
      }
    }
  }
  return out;
}

// ───────────────────────────── etiquetas → clase y banderas ─────────────────────────────

const HIGHWAY_CLASS: Record<string, number> = {
  motorway: HW.MOTORWAY,
  motorway_link: HW.MOTORWAY,
  trunk: HW.TRUNK,
  trunk_link: HW.TRUNK,
  primary: HW.PRIMARY,
  primary_link: HW.PRIMARY,
  secondary: HW.SECONDARY,
  secondary_link: HW.SECONDARY,
  tertiary: HW.TERTIARY,
  tertiary_link: HW.TERTIARY,
  unclassified: HW.UNCLASSIFIED,
  road: HW.UNCLASSIFIED,
  residential: HW.RESIDENTIAL,
  living_street: HW.LIVING_STREET,
  service: HW.SERVICE,
  pedestrian: HW.PEDESTRIAN,
  footway: HW.FOOTWAY,
  path: HW.PATH,
  bridleway: HW.PATH,
  cycleway: HW.CYCLEWAY,
  track: HW.TRACK,
  steps: HW.STEPS,
};

const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'grass', 'sand', 'mud', 'compacted', 'pebblestone', 'woodchips', 'dirt/sand', 'grass_paver']);
const PAVED = new Set(['paved', 'asphalt', 'concrete', 'paving_stones', 'sett', 'cobblestone', 'metal', 'wood', 'concrete:plates', 'concrete:lanes', 'bricks', 'unhewn_cobblestone']);
const YES = new Set(['yes', 'true', '1', 'designated', 'permissive']);
const BIKE_LANES = new Set(['lane', 'track', 'shared_lane', 'share_busway', 'opposite_lane', 'opposite_track', 'opposite']);

export interface HighwayInfo {
  cls: number;
  flags: number;
  name: string;
}

/** Qué es un camino de OpenStreetMap para el navegador, o `null` si no se recorre (no es una vía, una acera dibujada aparte, un aparcamiento…). */
export function classifyHighway(tags: ReadonlyMap<string, string>): HighwayInfo | null {
  const highway = tags.get('highway');
  if (highway === undefined) return null;
  const cls = HIGHWAY_CLASS[highway];
  if (cls === undefined) return null;
  if (tags.get('area') === 'yes') return null;
  const service = tags.get('service');
  if (cls === HW.SERVICE && service !== undefined && ['parking_aisle', 'driveway', 'drive-through', 'emergency_access'].includes(service)) return null;
  const footway = tags.get('footway');
  // Las aceras y los pasos de cebra se dibujan en OpenStreetMap como caminos aparte: aquí se camina por la calle, que es lo que da nombre a las instrucciones.
  if (cls === HW.FOOTWAY && footway !== undefined && ['sidewalk', 'crossing', 'traffic_island', 'access_aisle'].includes(footway)) return null;
  if (tags.get('access') === 'no' && !YES.has(tags.get('foot') ?? '') && !YES.has(tags.get('bicycle') ?? '')) return null;

  let flags = 0;
  const get = (key: string): string => tags.get(key) ?? '';
  const motorroad = get('motorroad') === 'yes';
  const hasCyclewayTag = ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'].some((k) => get(k) !== '' && get(k) !== 'no' && get(k) !== 'none');
  const hasSidewalk = ['both', 'left', 'right', 'yes', 'separate'].includes(get('sidewalk')) || ['yes', 'separate'].includes(get('sidewalk:left')) || ['yes', 'separate'].includes(get('sidewalk:right')) || ['yes', 'separate'].includes(get('sidewalk:both'));

  const footNo = ['no', 'private'].includes(get('foot'));
  const footYes = YES.has(get('foot'));
  if (footNo || highway.startsWith('motorway') || (motorroad && !footYes) || (cls === HW.TRUNK && !footYes && !hasSidewalk)) flags |= FLAG.FOOT_NO;
  const bikeNo = ['no', 'dismount', 'private'].includes(get('bicycle'));
  const bikeYes = YES.has(get('bicycle'));
  if (bikeNo || highway.startsWith('motorway') || (motorroad && !bikeYes) || (cls === HW.TRUNK && !bikeYes && !hasCyclewayTag)) flags |= FLAG.BIKE_NO;
  if (get('access') === 'private' && !footYes && !bikeYes) flags |= FLAG.FOOT_NO | FLAG.BIKE_NO;
  if ((cls === HW.FOOTWAY || cls === HW.PEDESTRIAN || cls === HW.PATH || cls === HW.STEPS) && bikeYes) flags |= FLAG.BIKE_YES;
  if (cls === HW.TRACK && bikeYes) flags |= FLAG.BIKE_YES;

  const oneway = get('oneway');
  const roundabout = ['roundabout', 'circular'].includes(get('junction'));
  if (roundabout) flags |= FLAG.ROUNDABOUT | FLAG.ONEWAY_FWD;
  else if (YES.has(oneway) && oneway !== 'designated' && oneway !== 'permissive') flags |= FLAG.ONEWAY_FWD;
  else if (oneway === '-1' || oneway === 'reverse') flags |= FLAG.ONEWAY_BWD;
  if (get('oneway:bicycle') === 'no' || ['opposite', 'opposite_lane', 'opposite_track'].some((v) => ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'].some((k) => get(k) === v))) flags |= FLAG.BIKE_CONTRAFLOW;
  if (['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'].some((k) => BIKE_LANES.has(get(k)))) flags |= FLAG.CYCLE_LANE;
  if (hasSidewalk) flags |= FLAG.SIDEWALK;

  const surface = get('surface');
  if (UNPAVED.has(surface) || (surface === '' && (cls === HW.TRACK || cls === HW.PATH))) flags |= FLAG.UNPAVED;
  if (PAVED.has(surface)) flags &= ~FLAG.UNPAVED;
  if (['yes', '24/7', 'automatic'].includes(get('lit'))) flags |= FLAG.LIT;
  if (get('bridge') !== '' && get('bridge') !== 'no') flags |= FLAG.BRIDGE;
  if (get('tunnel') !== '' && get('tunnel') !== 'no') flags |= FLAG.TUNNEL;

  let name = get('name');
  if (name === '' && cls <= HW.SECONDARY) name = get('ref');
  return { cls, flags, name };
}

const RAILWAYS = new Set(['rail', 'light_rail', 'tram', 'narrow_gauge', 'funicular', 'monorail']);
const CAMPUS_AMENITIES = new Set(['school', 'university', 'college', 'kindergarten', 'hospital']);
const PITCH_LEISURE = new Set(['pitch', 'playground', 'track', 'golf_course', 'swimming_pool', 'dog_park', 'sports_centre', 'stadium']);
const COMMERCIAL_LANDUSE = new Set(['retail', 'commercial', 'industrial']);
const FARM_LANDUSE = new Set(['grass', 'meadow', 'recreation_ground', 'village_green', 'farmland', 'orchard', 'vineyard', 'allotments', 'flowerbed']);

/** El tipo de zona que se dibuja, o `null`. `closed` dice si el camino es un anillo. */
export function classifyShape(tags: ReadonlyMap<string, string>, closed: boolean): number | null {
  const water = tags.get('natural') === 'water' || tags.get('waterway') === 'riverbank' || tags.get('landuse') === 'reservoir' || tags.get('landuse') === 'basin';
  if (closed && water) return SHAPE.WATER;
  const waterway = tags.get('waterway');
  if (waterway === 'river' || waterway === 'canal') return SHAPE.RIVER;
  if (waterway === 'stream') return SHAPE.STREAM;
  // Las vías de tren de superficie (el metro subterráneo no se ve): una línea fina.
  const railway = tags.get('railway');
  if (railway !== undefined && RAILWAYS.has(railway)) return SHAPE.RAIL;
  if (!closed) return null;
  // Un edificio manda sobre lo demás (un edificio con la etiqueta de un colegio es un edificio; el recinto es otro camino).
  const building = tags.get('building');
  if (building !== undefined && building !== 'no') return SHAPE.BUILDING;
  const leisure = tags.get('leisure');
  if (leisure === 'park' || leisure === 'garden' || leisure === 'nature_reserve') return SHAPE.PARK;
  const landuse = tags.get('landuse');
  if (tags.get('natural') === 'wood' || landuse === 'forest') return SHAPE.WOOD;
  if (landuse === 'grass' || landuse === 'meadow' || landuse === 'recreation_ground' || landuse === 'village_green' || tags.get('natural') === 'grassland' || tags.get('natural') === 'scrub') return SHAPE.GRASS;
  if (tags.get('natural') === 'beach' || tags.get('natural') === 'sand') return SHAPE.SAND;
  if (landuse === 'cemetery' || tags.get('amenity') === 'grave_yard') return SHAPE.CEMETERY;
  const amenity = tags.get('amenity');
  if (amenity !== undefined && CAMPUS_AMENITIES.has(amenity)) return SHAPE.CAMPUS;
  if (leisure !== undefined && PITCH_LEISURE.has(leisure)) return SHAPE.PITCH;
  if (amenity === 'parking') return SHAPE.PARKING;
  if (landuse !== undefined && COMMERCIAL_LANDUSE.has(landuse)) return SHAPE.COMMERCIAL;
  if (landuse !== undefined && FARM_LANDUSE.has(landuse)) return SHAPE.GRASS;
  return null;
}

const PLACE_KINDS: Record<string, number> = { city: PLACE.CITY, town: PLACE.TOWN, village: PLACE.VILLAGE, hamlet: PLACE.VILLAGE, suburb: PLACE.SUBURB, quarter: PLACE.SUBURB, neighbourhood: PLACE.NEIGHBOURHOOD, square: PLACE.POI };
const POI_AMENITIES = new Set(['hospital', 'university', 'college', 'library', 'theatre', 'cinema', 'townhall', 'marketplace', 'arts_centre', 'fountain', 'courthouse']);
/** Los sitios de la caja de detalle: categoría → tipos de `amenity`. */
const MARKER_AMENITIES: Record<string, number> = {
  restaurant: PLACE.FOOD,
  fast_food: PLACE.FOOD,
  food_court: PLACE.FOOD,
  ice_cream: PLACE.FOOD,
  cafe: PLACE.CAFE,
  bar: PLACE.CAFE,
  pub: PLACE.CAFE,
  biergarten: PLACE.CAFE,
  pharmacy: PLACE.HEALTH,
  clinic: PLACE.HEALTH,
  doctors: PLACE.HEALTH,
  dentist: PLACE.HEALTH,
  bicycle_rental: PLACE.BIKE,
  bicycle_repair_station: PLACE.BIKE,
  bank: PLACE.SERVICE,
  atm: PLACE.SERVICE,
  post_office: PLACE.SERVICE,
  fuel: PLACE.SERVICE,
  charging_station: PLACE.SERVICE,
  police: PLACE.SERVICE,
  fire_station: PLACE.SERVICE,
  school: PLACE.EDU,
  kindergarten: PLACE.EDU,
  drinking_water: PLACE.UTILITY,
  toilets: PLACE.UTILITY,
};

/**
 * Qué lugar es esto (para rotularlo, marcarlo y buscarlo), o `null`. Los de siempre (ciudades, barrios, parques, estaciones, sitios de interés) exigen nombre; los comercios y servicios de la
 * caja de detalle (`PLACE.FOOD` y siguientes) valen sin nombre: una parada de autobús o una fuente se marcan igual.
 */
export function classifyPlace(tags: ReadonlyMap<string, string>): number | null {
  const amenity = tags.get('amenity');
  if (amenity !== undefined && MARKER_AMENITIES[amenity] !== undefined) return MARKER_AMENITIES[amenity]!;
  if (tags.get('highway') === 'bus_stop' || tags.get('railway') === 'tram_stop' || tags.get('railway') === 'subway_entrance') return PLACE.TRANSIT;
  const shop = tags.get('shop');
  if (shop !== undefined && shop !== 'no' && shop !== 'vacant') return PLACE.SHOP;
  if (!tags.has('name')) return null;
  const place = tags.get('place');
  if (place !== undefined && PLACE_KINDS[place] !== undefined) return PLACE_KINDS[place]!;
  if (tags.get('railway') === 'station' || tags.get('public_transport') === 'station' || tags.get('railway') === 'halt') return PLACE.STATION;
  const leisure = tags.get('leisure');
  if (leisure === 'park' || leisure === 'garden' || leisure === 'nature_reserve') return PLACE.PARK;
  if (leisure === 'stadium' || leisure === 'sports_centre' || leisure === 'fitness_centre' || leisure === 'swimming_pool' || leisure === 'playground') return PLACE.POI;
  if (tags.has('tourism') && tags.get('tourism') !== 'information' && tags.get('tourism') !== 'artwork') return PLACE.POI;
  if (tags.has('historic')) return PLACE.POI;
  if (amenity !== undefined && POI_AMENITIES.has(amenity)) return PLACE.POI;
  if (amenity === 'place_of_worship') return PLACE.POI;
  return null;
}

// ───────────────────────────── ayudas ─────────────────────────────

class GrowI32 {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1 << 16) {
    this.data = new Int32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const bigger = new Int32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
  slice(): Int32Array {
    return this.data.slice(0, this.length);
  }
}

class GrowF64 {
  data: Float64Array;
  length = 0;
  constructor(capacity = 1 << 16) {
    this.data = new Float64Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const bigger = new Float64Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
}

/** Douglas-Peucker sobre puntos (lat, lon en e7): devuelve los índices que se conservan (siempre el primero y el último). */
export function simplifyIndices(lat: ArrayLike<number>, lon: ArrayLike<number>, toleranceM: number): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const kx = M_PER_DEG * Math.cos(toRad(lat[0]! / E7));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = (lon[a]! / E7) * kx;
    const ay = (lat[a]! / E7) * M_PER_DEG;
    const bx = (lon[b]! / E7) * kx;
    const by = (lat[b]! / E7) * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const px = (lon[i]! / E7) * kx;
      const py = (lat[i]! / E7) * M_PER_DEG;
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Une caminos abiertos por sus extremos en anillos (para las relaciones de tipo multipolígono). Los que no cierran se descartan. */
export function assembleRings(ways: readonly number[][]): number[][] {
  const pending = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: number[][] = [];
  while (pending.length > 0) {
    let ring = pending.pop()!;
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 10_000) {
      const end = ring[ring.length - 1]!;
      const at = pending.findIndex((w) => w[0] === end || w[w.length - 1] === end);
      if (at === -1) break;
      const next = pending.splice(at, 1)[0]!;
      ring = ring.concat(next[0] === end ? next.slice(1) : next.slice().reverse().slice(1));
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

// ───────────────────────────── el constructor ─────────────────────────────

export interface MapBuildOptions {
  name: string;
  title: string;
  source?: string;
  /** Tolerancia de la simplificación de los puntos de una calle (m). */
  simplifyM?: number;
  /** La caja en que se pidieron los edificios y los comercios (queda en el paquete: ver `PackMeta.detail`). */
  detail?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Un paquete de SOLO detalle (edificios y comercios, sin calles): para sumarlo a un mapa que ya las tiene (`pack-merge.ts`). Sin esto, una entrada sin calles es un error. */
  detailOnly?: boolean;
  log?: (message: string) => void;
}

export interface MapBuildStats {
  nodes: number;
  ways: number;
  highways: number;
  graphNodes: number;
  edges: number;
  shapes: number;
  places: number;
  streets: number;
  skippedWays: number;
  malformed: number;
  bytes: number;
}

const MAX_NAME = 120;
const MIN_BUILDING_M2 = 20;
const MAX_BUILDINGS = 150_000;

/** El área de un anillo (lat/lon en e7) en m², por la fórmula del cordón sobre un plano local. */
export function ringAreaM2(lat: ArrayLike<number>, lon: ArrayLike<number>): number {
  const n = lat.length;
  if (n < 4) return 0;
  const kx = M_PER_DEG * Math.cos(toRad(lat[0]! / E7));
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const x0 = (lon[i]! / E7) * kx;
    const y0 = (lat[i]! / E7) * M_PER_DEG;
    const x1 = (lon[i + 1]! / E7) * kx;
    const y1 = (lat[i + 1]! / E7) * M_PER_DEG;
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}
const STREET_AREA_RADIUS_M = 8000;

export async function buildMapPack(lines: AsyncIterable<string | OplObject> | Iterable<string | OplObject>, options: MapBuildOptions): Promise<{ input: PackInput; stats: MapBuildStats }> {
  const log = options.log ?? (() => undefined);
  const simplifyM = options.simplifyM ?? 1.5;
  const stats: MapBuildStats = { nodes: 0, ways: 0, highways: 0, graphNodes: 0, edges: 0, shapes: 0, places: 0, streets: 0, skippedWays: 0, malformed: 0, bytes: 0 };

  // Nodos: sus ids en orden (osmium los da ordenados) y su posición.
  const nodeIds = new GrowF64();
  const nodeLat = new GrowI32();
  const nodeLon = new GrowI32();
  let sorted = true;
  const places: Array<{ kind: number; lat: number; lon: number; name: string }> = [];

  // Caminos de calles: sus nodos (índices) en una sola lista.
  const wayRefs = new GrowI32();
  const wayStart = new GrowI32();
  const wayCls: number[] = [];
  const wayFlags: number[] = [];
  const wayName: string[] = [];
  const usage: { counts: Uint8Array | null } = { counts: null };

  // Otros caminos que pueden ser zonas o miembros de una relación: id → nodos.
  type Other = { refs: number[]; kind: number | null; place: number | null; name: string };
  const others = new Map<number, Other>();
  const shapesTmp: Array<{ kind: number; refs: number[] }> = [];

  const indexOfNode = (id: number): number => {
    let lo = 0;
    let hi = nodeIds.length - 1;
    const data = nodeIds.data;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = data[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  let phase: 'nodes' | 'ways' | 'relations' = 'nodes';
  const toWayRefs = (refs: number[]): number[] | null => {
    const out: number[] = [];
    for (const id of refs) {
      const idx = indexOfNode(id);
      if (idx === -1) return null; // un camino con un nodo que no está (recortado por el borde): se descarta
      out.push(idx);
    }
    return out;
  };

  for await (const raw of lines as AsyncIterable<string | OplObject>) {
    const obj = typeof raw === 'string' ? parseOplLine(raw) : raw;
    if (!obj) {
      if (typeof raw === 'string' && raw.trim() !== '' && !raw.startsWith('#')) stats.malformed++;
      continue;
    }
    if (obj.type === 'n') {
      if (phase !== 'nodes') {
        stats.malformed++;
        continue;
      }
      if (obj.x === undefined || obj.y === undefined || !Number.isFinite(obj.x) || !Number.isFinite(obj.y)) continue;
      if (nodeIds.length > 0 && obj.id <= nodeIds.data[nodeIds.length - 1]!) sorted = false;
      nodeIds.push(obj.id);
      nodeLat.push(e7(obj.y));
      nodeLon.push(e7(obj.x));
      stats.nodes++;
      const kind = classifyPlace(obj.tags);
      if (kind !== null) places.push({ kind, lat: e7(obj.y), lon: e7(obj.x), name: (obj.tags.get('name') ?? '').slice(0, MAX_NAME) });
      continue;
    }
    if (phase === 'nodes') {
      if (!sorted) throw new Error('Los nodos no vienen ordenados por identificador: ordena la entrada con «osmium sort».');
      phase = 'ways';
      usage.counts = new Uint8Array(nodeIds.length);
      log(`${stats.nodes} nodos leídos`);
    }
    if (obj.type === 'w') {
      stats.ways++;
      const refs = obj.refs ?? [];
      const info = classifyHighway(obj.tags);
      if (info) {
        const idx = toWayRefs(refs);
        if (!idx || idx.length < 2) {
          stats.skippedWays++;
          continue;
        }
        wayStart.push(wayRefs.length);
        for (const i of idx) {
          wayRefs.push(i);
          if (usage.counts![i]! < 2) usage.counts![i]!++;
        }
        wayCls.push(info.cls);
        wayFlags.push(info.flags);
        wayName.push(info.name.slice(0, MAX_NAME));
        stats.highways++;
        continue;
      }
      const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
      const kind = classifyShape(obj.tags, closed);
      const placeKind = closed ? classifyPlace(obj.tags) : null;
      if (kind !== null || placeKind !== null || obj.tags.size === 0) {
        const idx = toWayRefs(refs);
        if (idx) others.set(obj.id, { refs: idx, kind, place: placeKind, name: obj.tags.get('name') ?? '' });
      }
      continue;
    }
    // Relaciones: solo los multipolígonos de agua, parques y bosques.
    phase = 'relations';
    if (obj.tags.get('type') !== 'multipolygon') continue;
    const kind = classifyShape(obj.tags, true);
    if (kind === null || isLineKind(kind)) continue;
    const outers: number[][] = [];
    for (const m of obj.members ?? []) {
      if (m.type !== 'w' || (m.role !== 'outer' && m.role !== '')) continue;
      const way = others.get(m.ref);
      if (way) outers.push(way.refs);
    }
    for (const ring of assembleRings(outers)) shapesTmp.push({ kind, refs: ring });
  }
  if (phase === 'nodes') throw new Error('La entrada no tiene caminos: ¿es un archivo OPL?');
  const counts = usage.counts!;
  log(`${stats.highways} calles y sendas, ${others.size} zonas candidatas`);

  // Las zonas dibujables: caminos cerrados y líneas de agua.
  for (const way of others.values()) {
    if (way.kind !== null) shapesTmp.push({ kind: way.kind, refs: way.refs });
    if (way.place !== null && way.name !== '') {
      const c = centroid(way.refs, nodeLat.data, nodeLon.data);
      places.push({ kind: way.place, lat: c[0], lon: c[1], name: way.name.slice(0, MAX_NAME) });
    }
  }

  // Los nodos del grafo: cruces (usados por más de un tramo) y extremos de cada camino.
  const isJunction = new Uint8Array(nodeIds.length);
  for (let w = 0; w < wayStart.length; w++) {
    const from = wayStart.data[w]!;
    const to = w + 1 < wayStart.length ? wayStart.data[w + 1]! : wayRefs.length;
    isJunction[wayRefs.data[from]!] = 1;
    isJunction[wayRefs.data[to - 1]!] = 1;
    for (let k = from; k < to; k++) if (counts[wayRefs.data[k]!]! >= 2) isJunction[wayRefs.data[k]!] = 1;
  }
  const graphId = new Int32Array(nodeIds.length).fill(-1);
  const gLat = new GrowI32();
  const gLon = new GrowI32();
  const gid = (idx: number): number => {
    let g = graphId[idx]!;
    if (g === -1) {
      g = gLat.length;
      graphId[idx] = g;
      gLat.push(nodeLat.data[idx]!);
      gLon.push(nodeLon.data[idx]!);
    }
    return g;
  };

  // Los nombres (sin repetir).
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const nameId = (name: string): number => {
    if (name === '') return NO_NAME;
    let id = nameIds.get(name);
    if (id === undefined) {
      id = names.length;
      names.push(name);
      nameIds.set(name, id);
    }
    return id;
  };

  // Los tramos: cada camino se corta en sus cruces.
  const eA = new GrowI32();
  const eB = new GrowI32();
  const eLen = new GrowI32();
  const eCls: number[] = [];
  const eFlags: number[] = [];
  const eName = new GrowI32();
  const eGeomStart = new GrowI32();
  const geomLat = new GrowI32();
  const geomLon = new GrowI32();
  eGeomStart.push(0);
  for (let w = 0; w < wayStart.length; w++) {
    const from = wayStart.data[w]!;
    const to = w + 1 < wayStart.length ? wayStart.data[w + 1]! : wayRefs.length;
    const name = nameId(wayName[w]!);
    let segStart = from;
    for (let k = from + 1; k < to; k++) {
      if (!isJunction[wayRefs.data[k]!] && k !== to - 1) continue;
      const a = wayRefs.data[segStart]!;
      const b = wayRefs.data[k]!;
      // Los puntos del tramo (de uno a otro), su longitud y los que se conservan al simplificar.
      const pLat: number[] = [];
      const pLon: number[] = [];
      let length = 0;
      for (let j = segStart; j <= k; j++) {
        const idx = wayRefs.data[j]!;
        pLat.push(nodeLat.data[idx]!);
        pLon.push(nodeLon.data[idx]!);
        if (j > segStart) length += flatDistanceM(fromE7(pLat[pLat.length - 2]!), fromE7(pLon[pLon.length - 2]!), fromE7(pLat[pLat.length - 1]!), fromE7(pLon[pLon.length - 1]!));
      }
      if (a !== b || k - segStart > 1) {
        eA.push(gid(a));
        eB.push(gid(b));
        eLen.push(Math.max(1, Math.round(length * 10)));
        eCls.push(wayCls[w]!);
        eFlags.push(wayFlags[w]!);
        eName.push(name);
        for (const i of simplifyIndices(pLat, pLon, simplifyM).slice(1, -1)) {
          geomLat.push(pLat[i]!);
          geomLon.push(pLon[i]!);
        }
        eGeomStart.push(geomLat.length);
      }
      segStart = k;
    }
  }
  stats.graphNodes = gLat.length;
  stats.edges = eA.length;

  // Las zonas, con sus puntos simplificados.
  const shapeKind: number[] = [];
  const shapeStart: number[] = [0];
  const shapeLat: number[] = [];
  const shapeLon: number[] = [];
  let buildings = 0;
  for (const shape of shapesTmp) {
    const pLat = shape.refs.map((i) => nodeLat.data[i]!);
    const pLon = shape.refs.map((i) => nodeLon.data[i]!);
    const isBuilding = shape.kind === SHAPE.BUILDING;
    // Un edificio es pequeño: se conserva su silueta (tolerancia de ~1 m), no los trasteros ni las casetas (menos de ~20 m²) y, por memoria, como mucho `MAX_BUILDINGS`.
    if (isBuilding && (buildings >= MAX_BUILDINGS || ringAreaM2(pLat, pLon) < MIN_BUILDING_M2)) continue;
    const keep = simplifyIndices(pLat, pLon, isBuilding ? 1 : 3);
    if (keep.length < (isLineKind(shape.kind) ? 2 : 4)) continue;
    if (isBuilding) buildings++;
    shapeKind.push(shape.kind);
    for (const i of keep) {
      shapeLat.push(pLat[i]!);
      shapeLon.push(pLon[i]!);
    }
    shapeStart.push(shapeLat.length);
  }
  stats.shapes = shapeKind.length;

  // Lugares: los con nombre y una entrada por calle (cada conjunto de tramos con el mismo nombre que se tocan), con el barrio o localidad en que cae.
  const areaGrid = new Map<string, Array<{ lat: number; lon: number; name: string; rank: number }>>();
  const AREA_RANK: Record<number, number> = { [PLACE.NEIGHBOURHOOD]: 0, [PLACE.SUBURB]: 1, [PLACE.VILLAGE]: 2, [PLACE.TOWN]: 3, [PLACE.CITY]: 4 };
  for (const p of places) {
    if (AREA_RANK[p.kind] === undefined) continue;
    const key = `${Math.floor(fromE7(p.lat) / 0.1)}:${Math.floor(fromE7(p.lon) / 0.1)}`;
    const list = areaGrid.get(key) ?? [];
    list.push({ lat: fromE7(p.lat), lon: fromE7(p.lon), name: p.name, rank: AREA_RANK[p.kind]! });
    areaGrid.set(key, list);
  }
  const areaOf = (lat: number, lon: number): string => {
    let best = '';
    let bestD = STREET_AREA_RADIUS_M;
    const gy = Math.floor(lat / 0.1);
    const gx = Math.floor(lon / 0.1);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const c of areaGrid.get(`${gy + dy}:${gx + dx}`) ?? []) {
          // Entre lo cercano se prefiere lo más pequeño (un barrio antes que la ciudad).
          const d = flatDistanceM(lat, lon, c.lat, c.lon) * (1 + c.rank * 0.35);
          if (d < bestD) {
            bestD = d;
            best = c.name;
          }
        }
      }
    }
    return best;
  };

  const placeKind: number[] = [];
  const placeLat: number[] = [];
  const placeLon: number[] = [];
  const placeName: number[] = [];
  const placeArea: number[] = [];
  const addPlace = (kind: number, lat: number, lon: number, name: string, area: string): void => {
    placeKind.push(kind);
    placeLat.push(lat);
    placeLon.push(lon);
    placeName.push(nameId(name));
    placeArea.push(nameId(area));
  };
  // Los sin nombre (una parada, una fuente) no se buscan: no necesitan barrio.
  for (const p of places) addPlace(p.kind, p.lat, p.lon, p.name, p.name === '' || (AREA_RANK[p.kind] !== undefined && AREA_RANK[p.kind]! >= 3) ? '' : areaOf(fromE7(p.lat), fromE7(p.lon)));
  stats.streets = addStreets(eA, eB, eName, geomLat.length, gLat, gLon, names, (lat, lon, nm) => addPlace(PLACE.STREET, lat, lon, nm, areaOf(fromE7(lat), fromE7(lon))));
  stats.places = placeKind.length;

  // El rectángulo que cubre.
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < gLat.length; i++) {
    minLat = Math.min(minLat, gLat.data[i]!);
    maxLat = Math.max(maxLat, gLat.data[i]!);
    minLon = Math.min(minLon, gLon.data[i]!);
    maxLon = Math.max(maxLon, gLon.data[i]!);
  }
  if (!Number.isFinite(minLat)) {
    if (options.detailOnly !== true) throw new Error('No hay ninguna calle en la entrada.');
    minLat = maxLat = minLon = maxLon = 0;
  }

  const input: PackInput = {
    meta: {
      name: options.title,
      source: options.source ?? 'OpenStreetMap (© colaboradores de OpenStreetMap, ODbL 1.0)',
      generatedAt: new Date().toISOString(),
      bbox: { minLat: fromE7(minLat), minLon: fromE7(minLon), maxLat: fromE7(maxLat), maxLon: fromE7(maxLon) },
      ...(options.detail ? { detail: options.detail } : {}),
    },
    nodeLat: gLat.slice(),
    nodeLon: gLon.slice(),
    edgeA: eA.slice(),
    edgeB: eB.slice(),
    edgeLenDm: eLen.slice(),
    edgeCls: eCls,
    edgeFlags: eFlags,
    edgeName: eName.slice().map((v) => (v === -1 ? NO_NAME : v)),
    edgeGeomStart: eGeomStart.slice(),
    geomLat: geomLat.slice(),
    geomLon: geomLon.slice(),
    names,
    shapeKind,
    shapeStart,
    shapeLat,
    shapeLon,
    placeKind,
    placeLat,
    placeLon,
    placeName,
    placeArea,
  };
  return { input, stats };
}

const isLineKind = (kind: number): boolean => kind >= 16;

function centroid(refs: number[], lat: Int32Array, lon: Int32Array): [number, number] {
  let sy = 0;
  let sx = 0;
  for (const i of refs) {
    sy += lat[i]!;
    sx += lon[i]!;
  }
  return [Math.round(sy / refs.length), Math.round(sx / refs.length)];
}

/** Una entrada de lugar por cada calle (conjunto de tramos con el mismo nombre que se tocan): en el punto medio de su tramo más céntrico. Devuelve cuántas. */
function addStreets(eA: GrowI32, eB: GrowI32, eName: GrowI32, _geomPoints: number, gLat: GrowI32, gLon: GrowI32, names: readonly string[], emit: (lat: number, lon: number, name: string) => void): number {
  const m = eA.length;
  const parent = new Int32Array(m);
  for (let i = 0; i < m; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  // Para cada nodo, el último tramo con cada nombre que lo toca: los demás con ese nombre se unen a él.
  const lastAt = new Map<number, number>();
  for (let e = 0; e < m; e++) {
    const name = eName.data[e]!;
    if (name === -1 || name === NO_NAME) continue;
    for (const node of [eA.data[e]!, eB.data[e]!]) {
      const key = node * 262144 + (name % 262144);
      const other = lastAt.get(key);
      if (other !== undefined) parent[find(e)] = find(other);
      lastAt.set(key, e);
    }
  }
  const sums = new Map<number, { y: number; x: number; n: number }>();
  const mid = (e: number): [number, number] => [(gLat.data[eA.data[e]!]! + gLat.data[eB.data[e]!]!) / 2, (gLon.data[eA.data[e]!]! + gLon.data[eB.data[e]!]!) / 2];
  for (let e = 0; e < m; e++) {
    const name = eName.data[e]!;
    if (name === -1 || name === NO_NAME) continue;
    const root = find(e);
    const s = sums.get(root) ?? { y: 0, x: 0, n: 0 };
    const [y, x] = mid(e);
    s.y += y;
    s.x += x;
    s.n++;
    sums.set(root, s);
  }
  const best = new Map<number, { e: number; d: number }>();
  for (let e = 0; e < m; e++) {
    const name = eName.data[e]!;
    if (name === -1 || name === NO_NAME) continue;
    const root = find(e);
    const s = sums.get(root)!;
    const [y, x] = mid(e);
    const d = Math.hypot(y - s.y / s.n, x - s.x / s.n);
    const cur = best.get(root);
    if (!cur || d < cur.d) best.set(root, { e, d });
  }
  let count = 0;
  for (const { e } of best.values()) {
    const [y, x] = mid(e);
    emit(Math.round(y), Math.round(x), names[eName.data[e]!]!);
    count++;
  }
  return count;
}
