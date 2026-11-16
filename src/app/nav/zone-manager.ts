import { PACK_VERSION, PackError } from '../../domain/nav/pack';
import type { LatLon } from '../../domain/nav/geo';
import { DEFAULT_LIMITS, DETAIL_RETRY_MS, pickZone, zoneCovers, zonesToDelete, type ZoneMeta } from '../../domain/nav/zones';
import type { AreaStore } from './area-store';
import { ZONE_MESSAGES, ZoneError, type DownloadedZone, type DownloadProgress } from './area-download';
import { openPack, type NavData, type NavLoad } from './pack-loader';

// El mapa de donde está la persona. Si ya hay una zona guardada que cubre su posición, se abre esa (sin internet y casi al instante); si no, se baja la de su zona, se guarda y se abre. Cada
// vez se borra lo que lleva mucho sin usarse y, si hay demasiadas zonas o pesan demasiado, las menos usadas. Qué cubre qué y qué se borra: `domain/nav/zones.ts`.

export interface ZoneDeps {
  store: AreaStore;
  download: (lat: number, lon: number, onProgress: (progress: DownloadProgress) => void) => Promise<DownloadedZone>;
  /**
   * Baja el detalle (edificios y comercios) de una zona ya guardada y devuelve el paquete con él sumado, o `null` si no pudo (sin avisar de nada). Sin esta función no se baja detalle.
   */
  downloadDetail?: (zone: ZoneMeta, base: ArrayBuffer) => Promise<DownloadedZone | null>;
  /** Avisa de que una zona acaba de ganar su detalle y ya está guardada con él: quien tenga ese mapa abierto puede cambiarlo por este. */
  onUpgrade?: (data: NavData) => void;
  now: () => number;
}

/**
 * El último mapa abierto se recuerda en memoria un rato: abrirlo de nuevo (el siguiente entreno, o el mapa del recorrido al revisar el que acaba de terminar) es entonces instantáneo, sin leer
 * de la base ni volver a montar el grafo. Se identifica por zona y fecha de bajada (si la zona se vuelve a bajar o se borra, deja de valer) y se suelta pasado `REMEMBER_MS`.
 */
const REMEMBER_MS = 20 * 60_000;
let remembered: { id: string; createdMs: number; data: NavData; at: number; timer: ReturnType<typeof setTimeout> } | null = null;

function forget(ids?: readonly string[]): void {
  if (!remembered || (ids && !ids.includes(remembered.id))) return;
  clearTimeout(remembered.timer);
  remembered = null;
}

function remember(meta: ZoneMeta, data: NavData, nowMs: number): void {
  forget();
  remembered = { id: meta.id, createdMs: meta.createdMs, data, at: nowMs, timer: setTimeout(() => forget(), REMEMBER_MS) };
}

/** Solo para las pruebas: olvida el mapa recordado. */
export const forgetRememberedZoneForTests = (): void => {
  forget();
  upgrading.clear();
};

/** Las zonas cuyo detalle se está bajando ahora (una sola vez a la vez por zona). */
const upgrading = new Set<string>();

/** ¿Se están bajando o construyendo ahora los edificios y comercios de alguna zona? (el informe de la pantalla apagada lo cuenta: es trabajo pesado en segundo plano). */
export const isDetailUpgrading = (): boolean => upgrading.size > 0;

/**
 * Tras abrir una zona, en segundo plano y sin hacer esperar: si todavía no lleva los edificios y los comercios y no se intentó hace poco, se bajan y se suman al mapa guardado. Si sale bien, se guarda
 * y se avisa (`onUpgrade`); si no, se anota el intento y se deja como está (no se vuelve a intentar hasta pasado `DETAIL_RETRY_MS`). Nunca falla hacia fuera.
 */
function scheduleDetail(deps: ZoneDeps, meta: ZoneMeta): void {
  const { downloadDetail } = deps;
  if (!downloadDetail || meta.detailMs !== undefined || upgrading.has(meta.id)) return;
  if (meta.detailTriedMs !== undefined && deps.now() - meta.detailTriedMs < DETAIL_RETRY_MS) return;
  upgrading.add(meta.id);
  void (async () => {
    try {
      const base = await deps.store.get(meta.id);
      if (!base) return;
      await deps.store.update(meta.id, { detailTriedMs: deps.now() });
      const upgraded = await downloadDetail(meta, base);
      if (!upgraded) return;
      const data = openPack(upgraded.buffer, { title: upgraded.meta.name, box: upgraded.meta.box, zoneId: upgraded.meta.id });
      // Se guarda con la hora de último uso de ahora: quien lo tiene abierto lo está usando.
      const saved = { ...upgraded.meta, lastUsedMs: deps.now() };
      await deps.store.put(saved, upgraded.buffer);
      remember(saved, data, deps.now());
      deps.onUpgrade?.(data);
    } catch (error) {
      // Se cortó porque la app pasó a segundo plano: eso no cuenta como intento (se repetirá la próxima vez que se abra la zona con la app a la vista).
      if (error instanceof ZoneError && error.code === 'paused') await deps.store.update(meta.id, { detailTriedMs: 0 }).catch(() => undefined);
      /* si no, el mapa sigue como estaba: se reintenta otro día */
    } finally {
      upgrading.delete(meta.id);
    }
  })();
}

const BROKEN = (message: string): NavLoad => ({ ok: false, reason: 'broken', message: `El mapa guardado está estropeado: ${message}` });

/** Borra lo que sobra. Un fallo al borrar no impide navegar, así que se traga. */
async function prune(deps: ZoneDeps, keepId: string | null): Promise<void> {
  try {
    const zones = await deps.store.list();
    const doomed = zonesToDelete(zones, deps.now(), { ...DEFAULT_LIMITS, packVersion: PACK_VERSION }, keepId);
    forget(doomed);
    await deps.store.remove(doomed);
  } catch {
    /* se reintenta la próxima vez */
  }
}

/** Abre una zona guardada; `null` si no hay paquete o no se puede leer (entonces se borra: no sirve para nada). */
async function openStored(deps: Pick<ZoneDeps, 'store' | 'now'>, meta: ZoneMeta): Promise<NavLoad | null> {
  if (remembered && remembered.id === meta.id && remembered.createdMs === meta.createdMs && deps.now() - remembered.at < REMEMBER_MS) {
    await deps.store.touch(meta.id, deps.now());
    return { ok: true, data: remembered.data };
  }
  const buffer = await deps.store.get(meta.id);
  if (!buffer) {
    forget([meta.id]);
    await deps.store.remove([meta.id]);
    return null;
  }
  try {
    const data = openPack(buffer, { title: meta.name, box: meta.box, zoneId: meta.id });
    await deps.store.touch(meta.id, deps.now());
    remember(meta, data, deps.now());
    return { ok: true, data };
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    forget([meta.id]);
    await deps.store.remove([meta.id]);
    return null;
  }
}

/**
 * El mapa para esta posición: el guardado que la cubre o uno nuevo bajado de internet. `onProgress` cuenta los bytes que llegan y avisa cuando empieza a construir. Si bajarlo falla pero hay
 * una zona guardada que contiene la posición aunque esté cerca del borde, se usa esa antes que quedarse sin mapa.
 */
export async function loadZoneFor(lat: number, lon: number, deps: ZoneDeps, onProgress: (progress: DownloadProgress) => void = () => undefined): Promise<NavLoad> {
  let zones = await deps.store.list().catch(() => []);
  const stored = pickZone(zones, lat, lon);
  if (stored) {
    const opened = await openStored(deps, stored);
    if (opened) {
      // Limpiar lo viejo no hace falta para empezar: se hace después, sin hacer esperar al mapa.
      void prune(deps, stored.id);
      scheduleDetail(deps, stored);
      return opened;
    }
    zones = zones.filter((z) => z.id !== stored.id);
  }
  let downloaded: DownloadedZone;
  try {
    downloaded = await deps.download(lat, lon, onProgress);
  } catch (error) {
    // Con el borde cerca pero dentro, lo guardado sirve para empezar.
    const edge = pickZone(zones, lat, lon, 0);
    if (edge) {
      const opened = await openStored(deps, edge);
      if (opened) return opened;
    }
    if (error instanceof ZoneError) return { ok: false, reason: error.code, message: ZONE_MESSAGES[error.code] };
    return { ok: false, reason: 'failed', message: ZONE_MESSAGES.failed };
  }
  try {
    const data = openPack(downloaded.buffer, { title: downloaded.meta.name, box: downloaded.meta.box, zoneId: downloaded.meta.id });
    // Si guardar falla (sin espacio), el mapa se usa igual esta vez.
    try {
      forget([downloaded.meta.id]);
      await deps.store.put(downloaded.meta, downloaded.buffer);
    } catch {
      return { ok: true, data: { ...data, zoneId: null } };
    }
    remember(downloaded.meta, data, deps.now());
    await prune(deps, downloaded.meta.id);
    scheduleDetail(deps, downloaded.meta);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof PackError) return BROKEN(error.message);
    throw error;
  }
}

/**
 * El mapa guardado que contiene TODOS estos puntos, o `null`. Es para dibujar un recorrido ya hecho al revisar un entreno: nunca baja nada (sin zona guardada, el recorrido se ve sin mapa).
 * Si hay varias zonas que lo cubren, la que se abrió más recientemente.
 */
export async function loadStoredZoneCovering(points: readonly LatLon[], deps: Pick<ZoneDeps, 'store' | 'now'>): Promise<NavData | null> {
  if (points.length === 0) return null;
  const zones = await deps.store.list().catch(() => []);
  const candidates = zones
    .filter((z) => z.packVersion === PACK_VERSION && points.every((p) => zoneCovers(z.box, p.lat, p.lon, 0)))
    // El que acaba de usarse (está en memoria) primero; después, el abierto más recientemente.
    .sort((a, b) => Number(b.id === remembered?.id) - Number(a.id === remembered?.id) || b.lastUsedMs - a.lastUsedMs);
  for (const zone of candidates) {
    try {
      const opened = await openStored(deps, zone);
      if (opened?.ok) return opened.data;
    } catch {
      /* esa zona no se pudo leer: se prueba la siguiente */
    }
  }
  return null;
}

/**
 * El mapa guardado que se abrió más recientemente, sin saber todavía dónde está la persona (el GPS aún no ha dado la primera posición). Sirve para tener el mapa en pantalla desde el primer
 * momento: casi siempre se entrena en la misma zona. Nunca baja nada. `null` si no hay ninguna zona guardada que se pueda abrir.
 */
export async function loadMostRecentStoredZone(deps: Pick<ZoneDeps, 'store' | 'now'>): Promise<NavData | null> {
  const zones = await deps.store.list().catch(() => []);
  const candidates = zones.filter((z) => z.packVersion === PACK_VERSION).sort((a, b) => b.lastUsedMs - a.lastUsedMs);
  for (const zone of candidates.slice(0, 2)) {
    try {
      const opened = await openStored(deps, zone);
      if (opened?.ok) return opened.data;
    } catch {
      /* esa zona no se pudo leer */
    }
  }
  return null;
}
