// La foto de un producto con código de barras, de Open Food Facts: lo ÚNICO que la app pide a internet (antes no usaba nada).
//
// Para el código de una comida anotada con el escáner se pregunta a la API de Open Food Facts por la imagen frontal del producto (solo se envía el código, sin nada de la persona) y se
// enseña como miniatura. Si no hay conexión, la API no contesta, el producto no tiene foto o la respuesta no es la esperada, NO se dice nada: la miniatura sigue siendo la ilustración
// de siempre. Lo que contestó la API se recuerda en la memoria y en el almacenamiento local (30 días si había foto, 14 si no la había) para no preguntar cada vez (cada pregunta es una petición a internet); un fallo
// de red no se recuerda más que media hora. Solo se aceptan direcciones de imágenes de los dominios de Open Food Facts.

import { isBarcode } from '../domain/food-label';
import { isBeta } from './beta';
import { svc } from './services';

const API = 'https://world.openfoodfacts.org/api/v2/product/';
const IMAGE_HOSTS: readonly string[] = ['images.openfoodfacts.org', 'static.openfoodfacts.org'];
const STORAGE_KEY = 'smartring.productimages.v1';
const WITH_PHOTO_MS = 30 * 24 * 3_600_000;
const WITHOUT_PHOTO_MS = 14 * 24 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const TIMEOUT_MS = 8_000;
const MAX_STORED = 1000;

interface Entry {
  /** La dirección de la foto, o `null` si el producto no tiene. */
  url: string | null;
  at: number;
}

const memory = new Map<string, Entry>();
const failedAt = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();
let loaded = false;

const keyOf = (barcode: string): string => String(Number(barcode));

/** ¿Es la dirección de una imagen de Open Food Facts (https, sin usuario ni puerto raro)? */
export function isOffImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 400) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) && url.username === '' && url.port === '' && /\.(?:jpe?g|png|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** La dirección de la foto que da la respuesta de la API, o `null` si no hay una válida. */
export function imageUrlFromResponse(data: unknown): string | null {
  const product = (data as { product?: Record<string, unknown> } | null)?.product;
  if (!product) return null;
  for (const field of ['image_front_small_url', 'image_front_url', 'image_small_url']) {
    const candidate = product[field];
    if (isOffImageUrl(candidate)) return candidate;
  }
  return null;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    for (const [key, entry] of Object.entries(stored)) {
      if (typeof entry?.at === 'number' && (entry.url === null || isOffImageUrl(entry.url))) memory.set(key, entry);
    }
  } catch {
    /* sin almacenamiento: solo se recuerda en la memoria */
  }
}

function save(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const recent = [...memory.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_STORED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* lleno o bloqueado: no pasa nada */
  }
}

const fresh = (entry: Entry, now: number): boolean => now - entry.at < (entry.url === null ? WITHOUT_PHOTO_MS : WITH_PHOTO_MS);

/**
 * Lo que ya se sabe de la foto de un código sin preguntar: la dirección, `null` si se sabe que no tiene foto y `undefined` si no se sabe (o está caducado). Síncrono, para pintar a la primera.
 */
export function knownProductImage(barcode: string, now: number = Date.now()): string | null | undefined {
  if (!isBarcode(barcode)) return null;
  load();
  const entry = memory.get(keyOf(barcode));
  return entry && fresh(entry, now) ? entry.url : undefined;
}

/** En la demostración y las pruebas no se pregunta (no hay que hablar con nadie): `?productimages=1` lo activa para probar la pantalla. */
function enabled(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    if (svc().demo && !isBeta() && typeof location !== 'undefined' && !new URLSearchParams(location.search).has('productimages')) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * La foto del producto con ese código, o `null` si no la hay o no se pudo saber. Nunca lanza ni avisa: cualquier problema es «sin foto». Las preguntas repetidas comparten la misma petición.
 */
export function productImageUrl(barcode: string, fetcher: typeof fetch = (...args) => fetch(...args), now: () => number = Date.now): Promise<string | null> {
  const known = knownProductImage(barcode, now());
  if (known !== undefined) return Promise.resolve(known);
  if (!isBarcode(barcode) || !enabled()) return Promise.resolve(null);
  const key = keyOf(barcode);
  const failed = failedAt.get(key);
  if (failed !== undefined && now() - failed < RETRY_AFTER_FAILURE_MS) return Promise.resolve(null);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetcher(`${API}${key}.json?fields=image_front_small_url,image_front_url,image_small_url`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 404) {
        memory.set(key, { url: null, at: now() });
        save();
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const url = imageUrlFromResponse(await response.json());
      memory.set(key, { url, at: now() });
      save();
      return url;
    } catch {
      failedAt.set(key, now());
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}

/** Solo para las pruebas: olvida todo lo recordado. */
export function resetProductImagesForTests(): void {
  memory.clear();
  failedAt.clear();
  inflight.clear();
  loaded = false;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada */
  }
}
