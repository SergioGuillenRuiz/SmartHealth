import { M_PER_DEG } from '../../domain/nav/geo';
import { OVERPASS_ENDPOINTS, OverpassError, overpassDetailQuery, overpassObjects, overpassQuery, type OverpassResponse } from '../../domain/nav/overpass';
import { PACK_VERSION, readPack, writePack, type PackInput } from '../../domain/nav/pack';
import { buildMapPack, type OplObject } from '../../domain/nav/pack-builder';
import { withDetail } from '../../domain/nav/pack-merge';
import { boxAround, zoneIdFor, ZONE_ATTEMPTS, ZONE_DETAIL_HALF_SIZE_M, type ZoneMeta } from '../../domain/nav/zones';

// Bajar de internet el mapa de una zona: pide a Overpass (la API pública de OpenStreetMap) las calles, zonas verdes, agua y lugares de un cuadrado alrededor de la posición y lo convierte en un
// paquete de mapa (`domain/nav/pack.ts`) que se guarda para no volver a pedirlo. Eso es lo que hace esperar a la persona; los edificios y los comercios del centro se bajan DESPUÉS, en segundo plano
// (`downloadDetailFor`), y se suman al mapa guardado. Es el único sitio de la navegación que usa internet.

export type ZoneErrorCode = 'offline' | 'busy' | 'failed' | 'empty' | 'paused';

export class ZoneError extends Error {
  constructor(
    readonly code: ZoneErrorCode,
    message: string,
    /** Pedir una zona más pequeña puede ayudar (la consulta era demasiado pesada para el servidor). Con un servidor que rechaza por exceso de peticiones, no: sería otra petición inútil. */
    readonly smaller: boolean = false,
  ) {
    super(message);
    this.name = 'ZoneError';
  }
}

/** Lo que se le cuenta a la persona de cada fallo. */
export const ZONE_MESSAGES: Record<ZoneErrorCode, string> = {
  offline: 'Sin conexión: hace falta internet una vez para bajar el mapa de esta zona. Después queda guardado.',
  busy: 'Los servidores del mapa están saturados. Prueba otra vez en un minuto.',
  failed: 'No se pudo bajar el mapa de esta zona.',
  empty: 'No hay calles de OpenStreetMap en esta zona.',
  paused: 'La bajada del mapa se paró porque la app pasó a segundo plano. Pulsa «Reintentar» con la app a la vista.',
};

export type DownloadProgress = { stage: 'download'; bytes: number } | { stage: 'build' };

export interface DownloadedZone {
  meta: ZoneMeta;
  buffer: ArrayBuffer;
}

export interface DownloadOptions {
  fetchFn?: typeof fetch;
  endpoints?: readonly string[];
  now: () => number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Cuánto se espera a un servidor antes de probar el siguiente (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Lo máximo que se acepta de respuesta (un mapa de ciudad grande ocupa decenas de MB; más que esto es que algo va mal). */
const MAX_RESPONSE_BYTES = 160 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Lo del detalle (edificios y comercios del centro) no hace esperar a nadie: si el servidor tarda más que esto o responde con más que esto, se deja para otro día. */
const DETAIL_TIMEOUT_MS = 100_000;
const MAX_DETAIL_BYTES = 48 * 1024 * 1024;

/** Lee el cuerpo contando los bytes que llegan (para enseñarlos) y lo devuelve como JSON. */
async function readJson(response: Response, onBytes: (bytes: number) => void, maxBytes: number = MAX_RESPONSE_BYTES): Promise<OverpassResponse> {
  if (!response.body) {
    const text = await response.text();
    onBytes(text.length);
    return JSON.parse(text) as OverpassResponse;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ZoneError('failed', 'La respuesta del mapa es demasiado grande.');
    }
    onBytes(total);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all)) as OverpassResponse;
}

/**
 * Pasa por el bucle de eventos cada tanto, para que la pantalla no se quede congelada mientras se construye el mapa. Con `signal` (la app se ocultó) corta la construcción en la
 * siguiente pausa: nadie mira el mapa y es trabajo pesado en segundo plano.
 */
async function* paced(objects: readonly OplObject[], signal?: AbortSignal): AsyncGenerator<OplObject> {
  for (let i = 0; i < objects.length; i++) {
    yield objects[i]!;
    if (i % 8000 === 7999) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw new DOMException('Construcción cortada', 'AbortError');
    }
  }
}

const AREA_RANK: Record<number, number> = { 5: 0, 4: 1, 3: 2, 2: 3, 1: 4 }; // barrio, barrio, pueblo, localidad, ciudad (los `PLACE.*` de pack.ts)

/** El nombre de la zona: el barrio o localidad con nombre más cercano al centro (lo más pequeño que esté cerca). */
export function zoneTitle(input: PackInput, lat: number, lon: number): string {
  let best = '';
  let bestScore = Infinity;
  for (let i = 0; i < input.placeKind.length; i++) {
    const rank = AREA_RANK[input.placeKind[i]!];
    if (rank === undefined) continue;
    const dLat = (Number(input.placeLat[i]) / 1e7 - lat) * M_PER_DEG;
    const dLon = (Number(input.placeLon[i]) / 1e7 - lon) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const score = Math.hypot(dLat, dLon) * (1 + rank * 0.35);
    if (score < bestScore) {
      bestScore = score;
      best = input.names[Number(input.placeName[i])] ?? '';
    }
  }
  return best === '' ? 'Tu zona' : best;
}

/** Una petición a un servidor: devuelve la respuesta ya leída o lanza con el motivo (`retryNext`: probar con otro servidor o con una zona más pequeña). */
async function fetchOnce(endpoint: string, query: string, options: DownloadOptions, maxBytes: number = MAX_RESPONSE_BYTES): Promise<OverpassResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  // Desde aquí la pantalla dice que está bajando (el servidor puede tardar varios segundos en empezar a contestar).
  options.onProgress?.({ stage: 'download', bytes: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetchFn(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }), signal: controller.signal });
    // 429 (demasiadas peticiones) y 502/503 (servidor caído o saturado): otra zona más pequeña no cambia nada. 504 (se acabó el tiempo en el servidor): la consulta era demasiado pesada, una zona menor sí puede.
    if (response.status === 504) throw new ZoneError('busy', ZONE_MESSAGES.busy, true);
    if (response.status === 429 || response.status === 502 || response.status === 503) throw new ZoneError('busy', ZONE_MESSAGES.busy);
    if (!response.ok) throw new ZoneError('failed', ZONE_MESSAGES.failed);
    return await readJson(response, (bytes) => options.onProgress?.({ stage: 'download', bytes }), maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

const offline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Baja el mapa de la zona de `lat`/`lon`: las calles, zonas verdes, agua y sitios con nombre, SIN los edificios ni los comercios (esos van aparte: `downloadDetailFor`). Prueba los servidores por orden y,
 * si la zona grande es demasiado para ellos (se cortan o la respuesta viene a medias), la reducida. Devuelve el paquete listo para guardar. Lanza `ZoneError`.
 */
export async function downloadZone(lat: number, lon: number, options: DownloadOptions): Promise<DownloadedZone> {
  if (offline()) throw new ZoneError('offline', ZONE_MESSAGES.offline);
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS;
  let lastError: ZoneError = new ZoneError('failed', ZONE_MESSAGES.failed);
  for (const attempt of ZONE_ATTEMPTS) {
    const box = boxAround(lat, lon, attempt.halfM);
    const query = overpassQuery(box);
    for (const endpoint of endpoints) {
      let json: OverpassResponse;
      try {
        json = await fetchOnce(endpoint, query, options);
      } catch (error) {
        if (options.signal?.aborted) throw new ZoneError('paused', ZONE_MESSAGES.paused);
        if (error instanceof ZoneError) lastError = error;
        else if (error instanceof SyntaxError) lastError = new ZoneError('failed', ZONE_MESSAGES.failed);
        // El servidor no contestó a tiempo: tampoco acaba una consulta demasiado grande para él, así que probar con una zona más pequeña sí puede ayudar.
        else if (error instanceof DOMException && error.name === 'AbortError') lastError = new ZoneError('busy', ZONE_MESSAGES.busy, true);
        else lastError = new ZoneError(offline() ? 'offline' : 'failed', offline() ? ZONE_MESSAGES.offline : ZONE_MESSAGES.failed);
        continue;
      }
      let objects: OplObject[];
      try {
        objects = overpassObjects(json);
      } catch (error) {
        if (error instanceof OverpassError && error.code === 'empty') {
          // Sin calles en el cuadrado grande no las habrá en el pequeño.
          throw new ZoneError('empty', ZONE_MESSAGES.empty);
        }
        // A medias (se acabó el tiempo en el servidor): una zona más pequeña sí puede terminar.
        lastError = new ZoneError('busy', ZONE_MESSAGES.busy, true);
        break;
      }
      options.onProgress?.({ stage: 'build' });
      if (options.signal?.aborted) throw new ZoneError('paused', ZONE_MESSAGES.paused);
      let input: PackInput;
      try {
        ({ input } = await buildMapPack(paced(objects, options.signal), { name: zoneIdFor(lat, lon), title: 'Tu zona' }));
      } catch (error) {
        if (options.signal?.aborted) throw new ZoneError('paused', ZONE_MESSAGES.paused);
        throw error;
      }
      input.meta.name = zoneTitle(input, lat, lon);
      const buffer = writePack(input);
      const now = options.now();
      return { buffer, meta: { id: zoneIdFor(lat, lon), name: input.meta.name, box, bytes: buffer.byteLength, createdMs: now, lastUsedMs: now, packVersion: PACK_VERSION } };
    }
    // Una zona más pequeña solo ayuda cuando el problema es el tamaño (a medias, sin tiempo o que no contesta a tiempo): con la red caída, una petición rechazada o un servidor saturado, no.
    if (!lastError.smaller) break;
  }
  throw lastError;
}

/**
 * Baja el DETALLE (edificios, recintos, campos deportivos, aparcamientos, comercios, paradas y servicios) del centro de una zona ya guardada y lo suma a su paquete. Se pide después de abrir el mapa y
 * nunca hace esperar: devuelve `null` —sin avisar de nada— si no hay conexión, el servidor tarda o está saturado, la respuesta es enorme o no hay nada que sumar. El centro es el de la zona (donde
 * estaba la persona al bajarla).
 */
export async function downloadDetailFor(zone: ZoneMeta, base: ArrayBuffer, options: DownloadOptions): Promise<DownloadedZone | null> {
  if (offline()) return null;
  // Se corta si la app se oculta (ver `hidden-guard.ts`): se lanza `paused` para que quien lo pidió no cuente el intento y lo repita con la app a la vista.
  const paused = (): never => {
    throw new ZoneError('paused', ZONE_MESSAGES.paused);
  };
  if (options.signal?.aborted) return paused();
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS;
  const centerLat = (zone.box.minLat + zone.box.maxLat) / 2;
  const centerLon = (zone.box.minLon + zone.box.maxLon) / 2;
  const detail = boxAround(centerLat, centerLon, ZONE_DETAIL_HALF_SIZE_M);
  const query = overpassDetailQuery(detail);
  // El progreso de esta bajada no se enseña: la pantalla ya está en el mapa.
  const quiet: DownloadOptions = { ...options, timeoutMs: options.timeoutMs ?? DETAIL_TIMEOUT_MS, onProgress: () => undefined };
  for (const endpoint of endpoints) {
    let json: OverpassResponse;
    try {
      json = await fetchOnce(endpoint, query, quiet, MAX_DETAIL_BYTES);
    } catch {
      if (options.signal?.aborted) return paused();
      // Un servidor que se corta o no contesta a tiempo con esta consulta no la acabará mejor el otro: no se insiste (se reintentará otro día).
      if (offline()) return null;
      continue;
    }
    try {
      const objects = overpassObjects(json, { allowNoWays: true });
      const { input } = await buildMapPack(paced(objects, options.signal), { name: zone.id, title: zone.name, detail, detailOnly: true });
      if (input.shapeKind.length === 0 && input.placeKind.length === 0) return null;
      const merged = withDetail(readPack(base), input);
      const buffer = writePack(merged);
      const now = options.now();
      return { buffer, meta: { ...zone, bytes: buffer.byteLength, detailMs: now } };
    } catch {
      // A medias o ilegible: se deja el mapa como está (salvo que se cortara por ocultarse la app: eso no cuenta como intento).
      if (options.signal?.aborted) return paused();
      return null;
    }
  }
  return null;
}
