import type { OplObject } from './pack-builder.ts';
import type { Box } from './zones.ts';

// Hablar el idioma de Overpass (la API pública de consulta de OpenStreetMap): la consulta que pide lo que necesita el navegador de una zona y la traducción de lo que contesta a los objetos
// que lee el constructor del paquete (`pack-builder.ts`). Aquí no hay red: la petición la hace `app/nav/area-loader.ts`.

/** Los servidores públicos de Overpass, por orden. Si el primero está saturado, se prueba el siguiente. */
export const OVERPASS_ENDPOINTS: readonly string[] = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const HIGHWAYS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|road|residential|living_street|service|pedestrian|footway|path|bridleway|cycleway|track|steps';
const NATURAL = 'water|wood|grassland|scrub|beach|sand';
const LANDUSE = 'forest|grass|meadow|recreation_ground|village_green|reservoir|basin|farmland|orchard|vineyard|allotments|flowerbed';
const LEISURE_AREA = 'park|garden|nature_reserve';
const LEISURE_POI = 'stadium|sports_centre|fitness_centre|swimming_pool|playground';
const AMENITY = 'hospital|university|college|library|theatre|cinema|townhall|marketplace|arts_centre|fountain|courthouse';
const PLACES = 'city|town|village|hamlet|suburb|quarter|neighbourhood|square';
// Lo de toda la zona que casi no pesa: vías de tren de superficie, cementerios y las grandes zonas comerciales e industriales (pocas y grandes).
const RAILWAYS = 'rail|light_rail|tram|narrow_gauge|funicular|monorail';
const LANDUSE_WIDE = 'cemetery|retail|commercial|industrial';
// Lo de la caja de detalle, que pesa mucho (en una ciudad densa son decenas de miles): edificios, recintos, campos deportivos, aparcamientos, y los comercios y servicios.
const LEISURE_PITCH = 'pitch|playground|track|golf_course|swimming_pool|dog_park|sports_centre|stadium';
const AMENITY_AREA = 'school|university|college|kindergarten|hospital|parking|grave_yard';
const AMENITY_MARKER =
  'restaurant|fast_food|food_court|ice_cream|cafe|bar|pub|biergarten|pharmacy|clinic|doctors|dentist|bicycle_rental|bicycle_repair_station|bank|atm|post_office|fuel|charging_station|police|fire_station|school|kindergarten|drinking_water|toilets|place_of_worship';

/** Lo que se pide con más detalle (edificios, comercios…): solo un cuadrado alrededor de donde está la persona. */
export type DetailBox = Box;

/**
 * La consulta de Overpass para un cuadrado: calles y sendas, zonas verdes y agua (con sus anillos, para dibujarlas), las vías de tren y los sitios con nombre que se buscan. Con `detail`
 * (un cuadrado más pequeño) añade además los edificios, los recintos y campos deportivos, los aparcamientos y los comercios, paradas y servicios. Las instrucciones con su propia caja (`(s,w,n,e)`)
 * ignoran la general: así lo pesado queda en el cuadrado pequeño y lo ligero cubre toda la zona.
 */
export function overpassQuery(box: Box, detail?: DetailBox | null): string {
  const bb = (b: Box): string => [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(6)).join(',');
  const named = (key: string, values?: string): string => `["${key}"${values ? `~"^(${values})$"` : ''}]["name"]`;
  const lines = [
    `[out:json][timeout:180][bbox:${bb(box)}];`,
    '(',
    `  way["highway"~"^(${HIGHWAYS})$"];`,
    '  way["waterway"~"^(river|canal|stream|riverbank)$"];',
    `  way["railway"~"^(${RAILWAYS})$"];`,
    `  way["natural"~"^(${NATURAL})$"];`,
    `  way["landuse"~"^(${LANDUSE}|${LANDUSE_WIDE})$"];`,
    `  way["leisure"~"^(${LEISURE_AREA})$"];`,
    `  rel["type"="multipolygon"]["natural"~"^(${NATURAL})$"];`,
    `  rel["type"="multipolygon"]["landuse"~"^(${LANDUSE})$"];`,
    `  rel["type"="multipolygon"]["leisure"~"^(${LEISURE_AREA})$"];`,
    `  node${named('place', PLACES)};`,
    `  node${named('railway', 'station|halt')};`,
    `  node${named('amenity', AMENITY)};`,
    `  node${named('leisure', `${LEISURE_AREA}|${LEISURE_POI}`)};`,
    '  node["tourism"]["tourism"!~"^(information|artwork)$"]["name"];',
    '  node["historic"]["name"];',
    `  way${named('amenity', AMENITY)};`,
    `  way${named('leisure', LEISURE_POI)};`,
    '  way["tourism"]["tourism"!~"^(information|artwork)$"]["name"];',
    '  way["historic"]["name"];',
  ];
  if (detail) lines.push(...detailStatements(detail));
  // `qt`: sin ordenar por identificador (Overpass lo ahorra y contesta antes); aquí el orden da igual.
  lines.push(');', 'out geom qt;');
  return lines.join('\n');
}

const bbox = (b: Box): string => [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(6)).join(',');

/** Las instrucciones de lo pesado (edificios, recintos, campos deportivos, aparcamientos, comercios, paradas y servicios), cada una con su propia caja. */
function detailStatements(detail: DetailBox): string[] {
  const d = `(${bbox(detail)})`;
  return [
    `  way["building"]${d};`,
    `  way["amenity"~"^(${AMENITY_AREA})$"]${d};`,
    `  way["leisure"~"^(${LEISURE_PITCH})$"]${d};`,
    `  node["amenity"~"^(${AMENITY_MARKER})$"]${d};`,
    `  node["shop"]["shop"!~"^(no|vacant)$"]${d};`,
    `  node["highway"="bus_stop"]${d};`,
    `  node["railway"~"^(tram_stop|subway_entrance)$"]${d};`,
  ];
}

/**
 * La consulta de SOLO el detalle (ronda 46): los edificios y los comercios del cuadrado pequeño, sin las calles. El mapa se abre antes con lo ligero (`overpassQuery` sin detalle) y esto se pide
 * después, en segundo plano, para sumarlo al mapa guardado (`pack-merge.ts`): pedirlo todo en una sola consulta hacía esperar minutos (en el centro de una ciudad son decenas de miles de edificios).
 */
export function overpassDetailQuery(detail: DetailBox): string {
  return [`[out:json][timeout:120][bbox:${bbox(detail)}];`, '(', ...detailStatements(detail), ');', 'out geom qt;'].join('\n');
}

interface JsonPoint {
  lat?: number;
  lon?: number;
}

interface JsonElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: Array<JsonPoint | null>;
  members?: Array<{ type?: string; ref?: number; role?: string; geometry?: Array<JsonPoint | null> }>;
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements?: JsonElement[];
  /** Overpass avisa aquí de que no terminó («runtime error: Query timed out…»): lo recibido es parcial. */
  remark?: string;
}

export class OverpassError extends Error {
  constructor(
    readonly code: 'incomplete' | 'empty' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'OverpassError';
  }
}

const NO_TAGS: ReadonlyMap<string, string> = new Map();
const tagsOf = (raw: Record<string, string> | undefined): Map<string, string> => (raw ? new Map(Object.entries(raw)) : (NO_TAGS as Map<string, string>));
const valid = (p: JsonPoint | null | undefined): p is { lat: number; lon: number } => p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/**
 * Lo que contestó Overpass, como los objetos que lee el constructor del paquete, en el orden que necesita (nodos por identificador, luego caminos y por último relaciones). Los caminos
 * traen su geometría dentro, así que los nodos se sacan de ahí; los anillos de las relaciones (que no traen los identificadores de sus nodos) reciben identificadores propios, por encima
 * de los de OpenStreetMap. Lanza `OverpassError` si la respuesta está incompleta (Overpass se cortó a mitad) o no trae nada.
 */
export function overpassObjects(response: OverpassResponse, options: { allowNoWays?: boolean } = {}): OplObject[] {
  if (typeof response.remark === 'string' && /runtime error|timed out|out of memory/i.test(response.remark)) throw new OverpassError('incomplete', `Overpass no terminó la consulta: ${response.remark}`);
  const elements = response.elements;
  if (!Array.isArray(elements)) throw new OverpassError('malformed', 'La respuesta de Overpass no es la esperada.');

  const nodes = new Map<number, { lat: number; lon: number; tags?: Map<string, string> }>();
  const ways = new Map<number, OplObject>();
  const relations: OplObject[] = [];
  let maxId = 0;

  for (const el of elements) {
    if (typeof el.id !== 'number') continue;
    if (el.id > maxId) maxId = el.id;
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      nodes.set(el.id, { lat: el.lat!, lon: el.lon!, tags: tagsOf(el.tags) });
    } else if (el.type === 'way' && Array.isArray(el.nodes) && Array.isArray(el.geometry) && el.nodes.length === el.geometry.length) {
      const refs: number[] = [];
      let complete = true;
      el.nodes.forEach((id, i) => {
        const point = el.geometry![i];
        if (!valid(point)) {
          complete = false;
          return;
        }
        refs.push(id);
        if (id > maxId) maxId = id;
        if (!nodes.has(id)) nodes.set(id, { lat: point.lat, lon: point.lon });
      });
      // Un camino con puntos fuera del recorte que Overpass no dio se descarta: el constructor lo haría igual al no encontrar el nodo.
      if (complete) ways.set(el.id, { type: 'w', id: el.id, tags: tagsOf(el.tags), refs });
    }
  }

  // Las relaciones: sus anillos vienen como geometría suelta. Si el camino ya está (porque se pidió por sí mismo), se usa; si no, se crea con nodos propios.
  let synthetic = maxId + 1;
  const syntheticByPoint = new Map<string, number>();
  const syntheticNode = (lat: number, lon: number): number => {
    const key = `${lat},${lon}`;
    let id = syntheticByPoint.get(key);
    if (id === undefined) {
      id = synthetic++;
      syntheticByPoint.set(key, id);
      nodes.set(id, { lat, lon });
    }
    return id;
  };
  for (const el of elements) {
    if (el.type !== 'relation' || typeof el.id !== 'number' || !Array.isArray(el.members)) continue;
    const members: Array<{ type: string; ref: number; role: string }> = [];
    for (const m of el.members) {
      if (m.type !== 'way' || typeof m.ref !== 'number') continue;
      members.push({ type: 'w', ref: m.ref, role: m.role ?? '' });
      if (ways.has(m.ref) || !Array.isArray(m.geometry)) continue;
      const points = m.geometry.filter(valid);
      if (points.length < 2 || points.length !== m.geometry.length) continue;
      ways.set(m.ref, { type: 'w', id: m.ref, tags: new Map(), refs: points.map((p) => syntheticNode(p.lat, p.lon)) });
    }
    relations.push({ type: 'r', id: el.id, tags: tagsOf(el.tags), members });
  }

  if (ways.size === 0 && options.allowNoWays !== true) throw new OverpassError('empty', 'No hay ninguna calle en esta zona.');
  const ids = Float64Array.from(nodes.keys()).sort();
  const out: OplObject[] = [];
  for (const id of ids) {
    const n = nodes.get(id)!;
    out.push({ type: 'n', id, tags: n.tags ?? new Map(), x: n.lon, y: n.lat });
  }
  for (const way of [...ways.values()].sort((a, b) => a.id - b.id)) out.push(way);
  relations.sort((a, b) => a.id - b.id);
  for (const r of relations) out.push(r);
  return out;
}
