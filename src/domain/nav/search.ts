import { flatDistanceM, fromE7, type LatLon } from './geo';
import { nameOf, NO_NAME, PLACE, PLACE_LABELS, type MapPack } from './pack';

// Buscar un destino por su nombre (una calle, un parque, una estación, un barrio…) dentro del paquete de mapa. No hay conexión ni servidor: se recorren los nombres del paquete,
// normalizados (sin tildes, en minúsculas, con «c/», «avda.» y compañía escritos enteros) y se ordenan por lo que pesa cada tipo de lugar y por lo cerca que queda.

export interface SearchResult {
  name: string;
  kind: number;
  kindLabel: string;
  /** El barrio o localidad en que está (`''` si no se sabe). */
  area: string;
  lat: number;
  lon: number;
  /** A cuántos metros queda de `near` (`null` si no se dio). */
  distanceM: number | null;
}

export interface SearchIndex {
  pack: MapPack;
  normalized: Array<string | undefined>;
}

const ABBREVIATIONS: Record<string, string> = {
  c: 'calle',
  cl: 'calle',
  cll: 'calle',
  avda: 'avenida',
  avd: 'avenida',
  av: 'avenida',
  pza: 'plaza',
  pl: 'plaza',
  plza: 'plaza',
  pso: 'paseo',
  pg: 'paseo',
  ps: 'paseo',
  ctra: 'carretera',
  urb: 'urbanizacion',
  gta: 'glorieta',
  rda: 'ronda',
  trv: 'travesia',
  cmno: 'camino',
};

/** Un texto como se compara: sin tildes ni signos, en minúsculas, con las abreviaturas habituales escritas enteras. */
export function normalizeText(text: string): string {
  const plain = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
  return plain
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(' ');
}

export function buildSearchIndex(pack: MapPack): SearchIndex {
  return { pack, normalized: new Array<string | undefined>(pack.nameOffsets.length - 1) };
}

function normalizedName(index: SearchIndex, nameId: number): string {
  let value = index.normalized[nameId];
  if (value === undefined) {
    value = normalizeText(nameOf(index.pack, nameId));
    index.normalized[nameId] = value;
  }
  return value;
}

const KIND_WEIGHT: Record<number, number> = {
  [PLACE.CITY]: 100,
  [PLACE.TOWN]: 90,
  [PLACE.PARK]: 85,
  [PLACE.STATION]: 85,
  [PLACE.POI]: 80,
  [PLACE.VILLAGE]: 75,
  [PLACE.SUBURB]: 70,
  [PLACE.NEIGHBOURHOOD]: 65,
  [PLACE.STREET]: 60,
  // Los comercios y servicios de la caja de detalle: por debajo de las calles (escribir «Mayor» busca una calle antes que una pastelería de ese nombre), pero se encuentran.
  [PLACE.EDU]: 56,
  [PLACE.HEALTH]: 56,
  [PLACE.BIKE]: 56,
  [PLACE.FOOD]: 54,
  [PLACE.CAFE]: 54,
  [PLACE.SHOP]: 54,
  [PLACE.SERVICE]: 52,
  [PLACE.TRANSIT]: 50,
};

/** Los lugares que encajan con lo escrito, los mejores primero. Cada palabra escrita tiene que ser el principio de alguna palabra del nombre. */
export function searchPlaces(index: SearchIndex, query: string, near: LatLon | null = null, limit = 8): SearchResult[] {
  const q = normalizeText(query);
  if (q.length < 2) return [];
  const tokens = q.split(' ');
  const pack = index.pack;
  const scored: Array<{ i: number; score: number; distanceM: number | null }> = [];
  for (let i = 0; i < pack.placeCount; i++) {
    // Una parada o una fuente sin nombre se marcan en el mapa pero no se buscan.
    if (pack.placeName[i] === NO_NAME) continue;
    const norm = normalizedName(index, pack.placeName[i]!);
    const padded = ` ${norm}`;
    let ok = true;
    for (const token of tokens) {
      if (!padded.includes(` ${token}`)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let score = KIND_WEIGHT[pack.placeKind[i]!] ?? 50;
    if (norm === q) score += 60;
    else if (norm.startsWith(q)) score += 30;
    score -= Math.min(15, Math.max(0, norm.split(' ').length - tokens.length));
    const distanceM = near ? flatDistanceM(near.lat, near.lon, fromE7(pack.placeLat[i]!), fromE7(pack.placeLon[i]!)) : null;
    // Entre iguales, lo más cercano (hasta 25 puntos menos por lejanía, saturando a 50 km).
    if (distanceM !== null) score -= Math.min(25, (distanceM / 50_000) * 25);
    scored.push({ i, score, distanceM });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const { i, distanceM } of scored) {
    const name = nameOf(pack, pack.placeName[i]!);
    const area = nameOf(pack, pack.placeArea[i]!);
    // La misma calle partida en varios trozos del mismo barrio sale una vez.
    const key = `${name}|${area}|${pack.placeKind[i]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind: pack.placeKind[i]!, kindLabel: PLACE_LABELS[pack.placeKind[i]!] ?? 'Lugar', area, lat: fromE7(pack.placeLat[i]!), lon: fromE7(pack.placeLon[i]!), distanceM });
    if (out.length >= limit) break;
  }
  return out;
}
