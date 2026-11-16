import { M_PER_DEG, mPerDegLon } from './geo.ts';

// Las zonas de mapa guardadas en el móvil. La app no lleva ningún mapa: baja el de donde está la persona (un cuadrado de unos 8 km de lado), lo guarda y lo reutiliza mientras siga dentro de él;
// si sale, baja el de la nueva zona. Aquí van las reglas puras: cuándo una zona cubre una posición, cuál se usa y qué se borra cuando hay demasiadas, pesan demasiado o llevan tiempo sin usarse.

export interface Box {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Lo que se sabe de una zona guardada sin abrirla. */
export interface ZoneMeta {
  id: string;
  /** El nombre para enseñar (un barrio o localidad cercana al centro). */
  name: string;
  box: Box;
  bytes: number;
  /** Cuándo se bajó. */
  createdMs: number;
  /** La última vez que se abrió para navegar. */
  lastUsedMs: number;
  /** La versión del formato del paquete (si cambia, la zona ya no sirve y se vuelve a bajar). */
  packVersion: number;
  /** Cuándo se sumaron al mapa los edificios y los comercios (se bajan aparte, después de abrir el mapa). Ausente: el mapa solo lleva lo ligero. */
  detailMs?: number;
  /** La última vez que se intentó bajar ese detalle (para no insistir a un servidor que no pudo: ver `DETAIL_RETRY_MS`). */
  detailTriedMs?: number;
}

/** El lado de la zona que se baja (la mitad, desde el centro) y el de la reducida si la grande no se puede bajar. */
export const ZONE_HALF_SIZE_M = [4000, 2500] as const;
/**
 * La mitad del lado del cuadrado central en el que, además de las calles, se bajan los edificios y los comercios (son decenas de miles en una ciudad densa: en toda la zona la respuesta
 * pesaría cientos de MB). Con 1 km de radio (4 km²) son del orden de 10–15 MB en el centro de una gran ciudad (con 1,4 km eran 20–30 MB y la bajada tardaba minutos).
 */
export const ZONE_DETAIL_HALF_SIZE_M = 1000;
/**
 * Lo que se intenta para ABRIR el mapa, por orden, hasta que un servidor contesta: la zona grande y, si es demasiado para él, la reducida. Solo lleva lo ligero (calles, zonas verdes, agua, vías
 * de tren y sitios con nombre: lo que hace falta para navegar). Hasta la ronda 45 el primer intento pedía también los edificios y los comercios en la MISMA consulta y, en el centro de una ciudad,
 * la persona esperaba minutos (o el servidor se cortaba y se repetía todo sin ellos): ahora van aparte, después (`overpassDetailQuery`), y no hacen esperar a nadie.
 */
export const ZONE_ATTEMPTS: ReadonlyArray<{ halfM: number }> = [{ halfM: ZONE_HALF_SIZE_M[0] }, { halfM: ZONE_HALF_SIZE_M[1] }];
/** Si el detalle de una zona no se pudo bajar, no se vuelve a intentar hasta pasado esto (un servidor que no pudo no mejora a los diez minutos). */
export const DETAIL_RETRY_MS = 12 * 3_600_000;
/** Una posición cuenta como «dentro» de una zona si queda a más de esto del borde (para que un paseo no salga del mapa al poco de empezar). */
export const EDGE_MARGIN_M = 1000;
/** Se borra lo que lleva sin abrirse más de esto. */
export const MAX_IDLE_DAYS = 60;
/** Y, si hay más zonas o pesan más que esto, se van borrando las menos usadas. */
export const MAX_ZONES = 6;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const DAY_MS = 86_400_000;

/** El cuadrado de `halfSizeM` metros desde el centro, en grados. */
export function boxAround(lat: number, lon: number, halfSizeM: number): Box {
  const dLat = halfSizeM / M_PER_DEG;
  const dLon = halfSizeM / mPerDegLon(lat);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

/** Los metros que hay desde un punto hasta el borde más cercano del cuadrado (negativo si está fuera). */
export function marginM(box: Box, lat: number, lon: number): number {
  const kx = mPerDegLon(lat);
  return Math.min((lat - box.minLat) * M_PER_DEG, (box.maxLat - lat) * M_PER_DEG, (lon - box.minLon) * kx, (box.maxLon - lon) * kx);
}

export const zoneCovers = (box: Box, lat: number, lon: number, margin: number = EDGE_MARGIN_M): boolean => marginM(box, lat, lon) >= margin;

/** Un identificador estable para la zona centrada en un punto (a ~100 m: dos bajadas casi en el mismo sitio no crean dos zonas). */
export const zoneIdFor = (lat: number, lon: number): string => `z${lat.toFixed(3)}_${lon.toFixed(3)}`;

/** La zona guardada que mejor cubre la posición (la que la deja más lejos del borde; a igualdad, la usada más recientemente), o `null` si ninguna. */
export function pickZone(zones: readonly ZoneMeta[], lat: number, lon: number, margin: number = EDGE_MARGIN_M): ZoneMeta | null {
  let best: ZoneMeta | null = null;
  let bestMargin = -Infinity;
  for (const zone of zones) {
    const m = marginM(zone.box, lat, lon);
    if (m < margin) continue;
    if (best === null || m > bestMargin + 50 || (Math.abs(m - bestMargin) <= 50 && zone.lastUsedMs > best.lastUsedMs)) {
      best = zone;
      bestMargin = m;
    }
  }
  return best;
}

export interface PruneLimits {
  maxIdleDays: number;
  maxZones: number;
  maxBytes: number;
  /** La versión del formato que sí se lee: lo de otra versión se borra. */
  packVersion: number;
}

export const DEFAULT_LIMITS: Omit<PruneLimits, 'packVersion'> = { maxIdleDays: MAX_IDLE_DAYS, maxZones: MAX_ZONES, maxBytes: MAX_TOTAL_BYTES };

/**
 * Qué zonas borrar: las de un formato que ya no se lee, las que llevan más de `maxIdleDays` sin abrirse y, de las que queden, las menos usadas hasta que no haya más de `maxZones` ni pesen
 * más de `maxBytes`. La de `keepId` (la que se está usando) nunca se toca.
 */
export function zonesToDelete(zones: readonly ZoneMeta[], nowMs: number, limits: PruneLimits, keepId: string | null = null): string[] {
  const doomed = new Set<string>();
  for (const zone of zones) {
    if (zone.id === keepId) continue;
    if (zone.packVersion !== limits.packVersion || nowMs - zone.lastUsedMs > limits.maxIdleDays * DAY_MS) doomed.add(zone.id);
  }
  const alive = zones.filter((z) => !doomed.has(z.id)).sort((a, b) => a.lastUsedMs - b.lastUsedMs);
  let total = alive.reduce((sum, z) => sum + z.bytes, 0);
  let count = alive.length;
  for (const zone of alive) {
    if (count <= limits.maxZones && total <= limits.maxBytes) break;
    if (zone.id === keepId) continue;
    doomed.add(zone.id);
    count--;
    total -= zone.bytes;
  }
  return [...doomed];
}
