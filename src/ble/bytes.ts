// Utilidades de bytes. Con `noUncheckedIndexedAccess` cada acceso devuelve `number | undefined`;
// estos lectores centralizan la comprobación para que el resto del código no la repita.

export type Bytes = Uint8Array;

/** Byte en `i`; fuera de rango devuelve 0 (los llamadores validan longitudes antes de leer campos). */
export function u8(b: ArrayLike<number>, i: number): number {
  return (b[i] ?? 0) & 0xff;
}

export function u16(b: ArrayLike<number>, i: number): number {
  return u8(b, i) | (u8(b, i + 1) << 8);
}

/** Entero de 3 bytes little-endian (duración de los tramos de sueño). */
export function u24(b: ArrayLike<number>, i: number): number {
  return u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16);
}

/** Sin signo: `>>> 0` evita que el bit 31 se interprete como signo. */
export function u32(b: ArrayLike<number>, i: number): number {
  return (u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16) | (u8(b, i + 3) << 24)) >>> 0;
}

export function concat(...parts: ArrayLike<number>[]): Bytes {
  return concatAll(parts);
}

/** Como `concat`, pero recibe la lista entera: pasar decenas de miles de trozos como argumentos (`...`) desborda la pila. */
export function concatAll(parts: readonly ArrayLike<number>[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p as ArrayLike<number>, offset);
    offset += p.length;
  }
  return out;
}

export function toHex(b: ArrayLike<number>, sep = ''): string {
  let out = '';
  for (let i = 0; i < b.length; i++) {
    if (i > 0) out += sep;
    out += u8(b, i).toString(16).padStart(2, '0');
  }
  return out;
}

/** Acepta espacios/guiones/dos puntos como separadores: `"05 06 06 00"` o `"05060600"`. */
export function fromHex(hex: string): Bytes {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`Hex con longitud impar: "${hex}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (u8(a, i) !== u8(b, i)) return false;
  return true;
}
