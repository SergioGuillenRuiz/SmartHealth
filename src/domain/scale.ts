// La báscula de cocina Bluetooth (RENPHO Smart Nutrition Scale 1 y parecidas): cómo se lee el peso de lo que manda y cuándo se da por bueno.
//
// [Seguro] El protocolo de esta báscula NO está documentado en ninguna parte que se pueda consultar. Por eso la app no lo da por sabido: la primera vez se APRENDE
// (`scale-learn.ts`: la persona escribe lo que marca la pantalla y se busca en qué bytes de las tramas va ese número) y lo aprendido se guarda como un `ScaleDecoder`.
// Este archivo tiene lo que no depende de cuál sea el protocolo: leer un campo de una trama con un decodificador y estabilizar las lecturas.
// docs/bascula.md explica el método, sus límites y qué hacer si no funciona.

/** Una trama recibida de la báscula: por dónde llegó, qué bytes trae y cuándo. */
export interface ScaleFrame {
  /** `n:<servicio>/<característica>` (aviso GATT), `a:m:<empresa>` (datos de fabricante del anuncio), `a:s:<servicio>` (datos de servicio) o `a:r` (el anuncio entero). */
  source: string;
  bytes: Uint8Array;
  atMs: number;
}

/** Lo que pesa como máximo la báscula (5000 g / 5000 ml según la caja). Fuera de un margen alrededor de esto, una lectura es basura. */
export const MAX_SCALE_G = 5000;
export const MIN_PLAUSIBLE_G = -50;
export const MAX_PLAUSIBLE_G = 5500;

export type FieldKind = 'uint' | 'float32' | 'ascii';
export type Divisor = 1 | 10 | 100 | 1000;

/**
 * Dónde está el peso en las tramas de una fuente y cómo se lee. Se guarda en el móvil (clave `scale`) y se valida al leerlo.
 * - `uint`: entero sin signo de `width` bytes (1 a 4) en `offset`, partido por `divisor`.
 * - `float32`: número de coma flotante de 4 bytes en `offset`.
 * - `ascii`: la trama es texto («ST,GS,  355.0 g») y el peso es el número que ocupa el lugar `index`.
 */
export interface ScaleDecoder {
  v: 1;
  source: string;
  /** Solo se leen las tramas de esta longitud (`null`: cualquiera). */
  length: number | null;
  kind: FieldKind;
  offset: number;
  width: 1 | 2 | 3 | 4;
  little: boolean;
  divisor: Divisor;
  /** Bytes fijos de las tramas de peso (la cabecera): `[posición, valor]`. Sirven para no confundirlas con otros mensajes de la misma fuente. */
  guard: Array<[number, number]>;
  /** Solo con `ascii`: qué número del texto (0 = el primero). */
  index: number;
}

const DIVISORS: readonly number[] = [1, 10, 100, 1000];

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Un decodificador guardado, o `null` si lo leído no lo es (un valor de otra versión o estropeado no debe romper la báscula: se vuelve a aprender). */
export function sanitizeDecoder(value: unknown): ScaleDecoder | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;
  if (d.v !== 1 || typeof d.source !== 'string' || d.source.length === 0 || d.source.length > 200) return null;
  if (d.kind !== 'uint' && d.kind !== 'float32' && d.kind !== 'ascii') return null;
  if (!(d.length === null || isInt(d.length, 1, 512))) return null;
  if (!isInt(d.offset, 0, 511) || !(d.width === 1 || d.width === 2 || d.width === 3 || d.width === 4)) return null;
  if (typeof d.little !== 'boolean' || typeof d.divisor !== 'number' || !DIVISORS.includes(d.divisor)) return null;
  if (!isInt(d.index, 0, 20)) return null;
  if (!Array.isArray(d.guard) || d.guard.length > 8) return null;
  const guard: Array<[number, number]> = [];
  for (const pair of d.guard) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isInt(pair[0], 0, 511) || !isInt(pair[1], 0, 255)) return null;
    guard.push([pair[0], pair[1]]);
  }
  return { v: 1, source: d.source, length: d.length as number | null, kind: d.kind, offset: d.offset, width: d.width, little: d.little, divisor: d.divisor as Divisor, guard, index: d.index };
}

/** Entero sin signo de `width` bytes (como número normal: con 4 bytes no pasa de 2³²). */
export function readUint(bytes: Uint8Array, offset: number, width: number, little: boolean): number | null {
  if (offset < 0 || offset + width > bytes.length) return null;
  let out = 0;
  for (let i = 0; i < width; i++) {
    const byte = bytes[little ? offset + width - 1 - i : offset + i] ?? 0;
    out = out * 256 + byte;
  }
  return out;
}

export function readFloat32(bytes: Uint8Array, offset: number, little: boolean): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, little);
}

/** ¿Es la trama texto imprimible (con saltos de línea y tabuladores)? */
export function isPrintable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const byte of bytes) if (!(byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127))) return false;
  return true;
}

const NUMBER = /[-+]?\d+(?:[.,]\d+)?/g;

/** Los números que contiene un texto, en orden (la coma decimal vale). */
export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? []).map((n) => Number(n.replace(',', '.'))).filter((n) => Number.isFinite(n));
}

const asText = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** El valor del campo, tal cual (sin comprobar si es creíble), o `null` si la trama no lo tiene. */
export function readField(decoder: Pick<ScaleDecoder, 'kind' | 'offset' | 'width' | 'little' | 'divisor' | 'index'>, bytes: Uint8Array): number | null {
  if (decoder.kind === 'uint') {
    const raw = readUint(bytes, decoder.offset, decoder.width, decoder.little);
    return raw === null ? null : raw / decoder.divisor;
  }
  if (decoder.kind === 'float32') return readFloat32(bytes, decoder.offset, decoder.little);
  if (!isPrintable(bytes)) return null;
  return numbersIn(asText(bytes))[decoder.index] ?? null;
}

/** ¿Una lectura así cabe en lo que mide la báscula? */
export const isPlausibleWeight = (grams: number): boolean => Number.isFinite(grams) && grams >= MIN_PLAUSIBLE_G && grams <= MAX_PLAUSIBLE_G;

/**
 * El peso que dice una trama según el decodificador, en gramos (con una décima como mucho), o `null` si no es una trama de peso de esa fuente (otra longitud, otra
 * cabecera) o el número no es creíble. Un peso un poco negativo (la báscula en tara) se da como 0.
 */
export function decodeFrame(decoder: ScaleDecoder, frame: Pick<ScaleFrame, 'source' | 'bytes'>): number | null {
  if (frame.source !== decoder.source) return null;
  if (decoder.length !== null && frame.bytes.length !== decoder.length) return null;
  for (const [position, value] of decoder.guard) if (frame.bytes[position] !== value) return null;
  const value = readField(decoder, frame.bytes);
  if (value === null || !isPlausibleWeight(value)) return null;
  return value <= 0 ? 0 : Math.round(value * 10) / 10;
}

/** La báscula emparejada: qué dispositivo es y cómo se lee su peso (lo aprendido en el emparejado). Se guarda en el móvil (clave `scale`). */
export interface SavedScale {
  id: string;
  name: string;
  decoder: ScaleDecoder;
  pairedMs: number;
}

/** Una báscula guardada, o `null` si lo leído no lo es (se vuelve a emparejar). */
export function sanitizeSavedScale(value: unknown): SavedScale | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 100) return null;
  const decoder = sanitizeDecoder(v.decoder);
  if (!decoder) return null;
  const name = typeof v.name === 'string' && v.name.length <= 100 ? v.name : 'Báscula';
  const pairedMs = typeof v.pairedMs === 'number' && Number.isFinite(v.pairedMs) && v.pairedMs > 0 ? v.pairedMs : 0;
  return { id: v.id, name, decoder, pairedMs };
}

// ───────────────────────────── estabilizar ─────────────────────────────

/** Cuánto tiene que llevar el peso sin cambiar para darlo por bueno, y cuánto puede bailar (la báscula marca de 1 en 1 g). */
export const STABLE_MS = 700;
export const STABLE_TOLERANCE_G = 1;
/** A partir de cuánto se considera que hay algo en la báscula (por debajo, vacía). */
export const EMPTY_BELOW_G = 0.5;

export interface ScaleReading {
  grams: number;
  /** Lleva ya el tiempo suficiente sin cambiar. */
  stable: boolean;
  /** Cuándo llegó la última trama (ms). */
  atMs: number;
}

/**
 * Convierte la corriente de lecturas en «el peso es X y está quieto». Una báscula manda tramas sin parar o solo cuando cambia: en los dos casos el peso queda quieto
 * si no cambia más de la tolerancia durante `STABLE_MS`, lleguen o no tramas nuevas (por eso `read` mira el reloj).
 */
export class WeightStabilizer {
  private last: { grams: number; atMs: number } | null = null;
  private anchor: { grams: number; sinceMs: number } | null = null;

  constructor(
    private readonly stableMs: number = STABLE_MS,
    private readonly tolerance: number = STABLE_TOLERANCE_G,
  ) {}

  push(grams: number, atMs: number): void {
    this.last = { grams, atMs };
    // El ancla es el último valor «de partida»: mientras las lecturas no se alejen de ella más de la tolerancia, el peso sigue quieto.
    if (this.anchor === null || Math.abs(grams - this.anchor.grams) > this.tolerance) this.anchor = { grams, sinceMs: atMs };
  }

  reset(): void {
    this.last = null;
    this.anchor = null;
  }

  /** La lectura a `nowMs`, o `null` si aún no ha llegado ninguna. */
  read(nowMs: number): ScaleReading | null {
    if (this.last === null || this.anchor === null) return null;
    return { grams: this.last.grams, stable: nowMs - this.anchor.sinceMs >= this.stableMs, atMs: this.last.atMs };
  }
}

/** «355 g», «0,5 g» (una décima solo si la lleva). */
export function formatGrams(grams: number): string {
  const rounded = Math.round(grams * 10) / 10;
  return `${rounded.toLocaleString('es-ES', { maximumFractionDigits: 1 })} g`;
}
