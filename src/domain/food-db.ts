// La base de productos del móvil: los alimentos envasados de Open Food Facts (recortados a lo que hace falta para anotar una comida) en
// un solo archivo binario, ordenado por código de barras para buscar sin cargarlo entero en objetos. Módulo sin importaciones: lo usan
// la app (leer) y `tools/build-food-db.ts` (escribir), que corre en Node sin compilar.
//
// Formato (little-endian). Cabecera de 32 bytes: «SRFD», versión (u8), 3 bytes reservados, nº de productos (u32), día de los datos (u32,
// días desde 1970), bytes del bloque de textos (u32) y 12 bytes reservados. Después, por este orden:
//   · códigos: n × f64 (el código como número, de menor a mayor; un EAN-13 cabe de sobra en los 53 bits de un f64)
//   · cifras:  n × 16 bytes (versión 2; en la 1, n × 10 y nada de lo que sigue a la ración) = kcal·10, proteínas·10, hidratos·10, grasas·10 y gramos de una
//              ración (todo u16; la ración 0 = no hay), y después fibra·10, azúcares·10 y sal·100 (u16; 0xFFFF = la etiqueta no lo dice)
//   · desfases: (n + 1) × u32 al bloque de textos
//   · textos:  «nombre NUL marca» en UTF-8, uno detrás de otro

export interface ProductRecord {
  /** Solo cifras (8 a 14). Un UPC-A de 12 cifras y su EAN-13 con un cero delante son el mismo producto. */
  code: string;
  name: string;
  brand: string;
  /** Por cada 100 g (o 100 ml). */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  servingG: number | null;
  /** Fibra, azúcares y sal por cada 100 g (o 100 ml); `null` o ausente = la etiqueta no lo dice (la base de la versión 1 no los traía). */
  fiberG?: number | null;
  sugarsG?: number | null;
  saltG?: number | null;
}

const MAGIC = [0x53, 0x52, 0x46, 0x44]; // «SRFD»
export const FOOD_DB_VERSION = 2;
const HEADER_BYTES = 32;
/** Bytes de las cifras de cada producto en la versión 1 (sin fibra, azúcares ni sal) y en la actual. */
const NUTRIENT_BYTES_V1 = 10;
const NUTRIENT_BYTES = 16;
/** El valor de fibra, azúcares o sal cuando la etiqueta no lo dice. */
const NO_DATA = 0xffff;
export const MAX_NAME_CHARS = 80;
export const MAX_BRAND_CHARS = 40;

const bytesOf = (data: ArrayBuffer | Uint8Array): Uint8Array => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** Un texto limpio y recortado (sin caracteres de control, ni espacios repetidos) a `max` letras. */
export function cleanText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = [...clean];
  return letters.length <= max ? clean : letters.slice(0, max).join('').trim();
}

const asCodeNumber = (code: string): number | null => (/^\d{8,14}$/.test(code) ? Number(code) : null);

const tenths = (value: number, field: string, max: number): number => {
  const n = Math.round(value * 10);
  if (!Number.isFinite(value) || n < 0 || n > max) throw new RangeError(`${field} fuera de rango: ${value}`);
  return n;
};

/** Un nutriente que puede faltar: sus décimas (o centésimas) o `NO_DATA`. */
const optional = (value: number | null | undefined, field: string, scale: number, max: number): number => {
  if (value === null || value === undefined) return NO_DATA;
  const n = Math.round(value * scale);
  if (!Number.isFinite(value) || n < 0 || n > max) throw new RangeError(`${field} fuera de rango: ${value}`);
  return n;
};

/** Escribe la base. Ordena por código; un código repetido o un campo imposible es un error (el constructor ya lo habrá filtrado). */
export function encodeFoodDb(records: readonly ProductRecord[], meta: { dumpDay: number }): Uint8Array {
  const rows = records.map((record) => {
    const n = asCodeNumber(record.code);
    if (n === null) throw new RangeError(`Código de barras no válido: ${record.code}`);
    const serving = record.servingG === null ? 0 : Math.round(record.servingG);
    if (serving < 0 || serving > 65_535) throw new RangeError(`Ración fuera de rango: ${record.servingG}`);
    return {
      n,
      kcal: tenths(record.kcal, 'kcal', 65_535),
      protein: tenths(record.proteinG, 'proteínas', 65_535),
      carbs: tenths(record.carbsG, 'hidratos', 65_535),
      fat: tenths(record.fatG, 'grasas', 65_535),
      fiber: optional(record.fiberG, 'fibra', 10, 65_534),
      sugars: optional(record.sugarsG, 'azúcares', 10, 65_534),
      salt: optional(record.saltG, 'sal', 100, 65_534),
      serving,
      text: new TextEncoder().encode(`${cleanText(record.name, MAX_NAME_CHARS)}\u0000${cleanText(record.brand, MAX_BRAND_CHARS)}`),
    };
  });
  rows.sort((a, b) => a.n - b.n);
  for (let i = 1; i < rows.length; i++) if (rows[i]!.n === rows[i - 1]!.n) throw new RangeError(`Código repetido: ${rows[i]!.n}`);

  const count = rows.length;
  const poolBytes = rows.reduce((sum, row) => sum + row.text.length, 0);
  const out = new Uint8Array(HEADER_BYTES + count * 8 + count * NUTRIENT_BYTES + (count + 1) * 4 + poolBytes);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, FOOD_DB_VERSION);
  view.setUint32(8, count, true);
  view.setUint32(12, meta.dumpDay, true);
  view.setUint32(16, poolBytes, true);

  const codesAt = HEADER_BYTES;
  const nutrientsAt = codesAt + count * 8;
  const offsetsAt = nutrientsAt + count * NUTRIENT_BYTES;
  const poolAt = offsetsAt + (count + 1) * 4;
  let pool = 0;
  rows.forEach((row, i) => {
    view.setFloat64(codesAt + i * 8, row.n, true);
    const at = nutrientsAt + i * NUTRIENT_BYTES;
    view.setUint16(at, row.kcal, true);
    view.setUint16(at + 2, row.protein, true);
    view.setUint16(at + 4, row.carbs, true);
    view.setUint16(at + 6, row.fat, true);
    view.setUint16(at + 8, row.serving, true);
    view.setUint16(at + 10, row.fiber, true);
    view.setUint16(at + 12, row.sugars, true);
    view.setUint16(at + 14, row.salt, true);
    view.setUint32(offsetsAt + i * 4, pool, true);
    out.set(row.text, poolAt + pool);
    pool += row.text.length;
  });
  view.setUint32(offsetsAt + count * 4, pool, true);
  return out;
}

/** La base abierta para buscar. Lanza si el archivo no es una base de productos entera. */
export class FoodDb {
  readonly count: number;
  /** Día (desde 1970) de los datos de Open Food Facts de los que sale. */
  readonly dumpDay: number;
  /** Versión del archivo: la 1 no trae fibra, azúcares ni sal. */
  readonly version: number;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly nutrientBytes: number;
  private readonly codesAt: number;
  private readonly nutrientsAt: number;
  private readonly offsetsAt: number;
  private readonly poolAt: number;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.bytes = bytesOf(data);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (this.bytes.length < HEADER_BYTES || MAGIC.some((byte, i) => this.bytes[i] !== byte)) throw new Error('No es una base de productos.');
    this.version = this.view.getUint8(4);
    if (this.version !== 1 && this.version !== FOOD_DB_VERSION) throw new Error(`Versión de la base de productos no admitida: ${this.version}.`);
    this.nutrientBytes = this.version === 1 ? NUTRIENT_BYTES_V1 : NUTRIENT_BYTES;
    this.count = this.view.getUint32(8, true);
    this.dumpDay = this.view.getUint32(12, true);
    const poolBytes = this.view.getUint32(16, true);
    this.codesAt = HEADER_BYTES;
    this.nutrientsAt = this.codesAt + this.count * 8;
    this.offsetsAt = this.nutrientsAt + this.count * this.nutrientBytes;
    this.poolAt = this.offsetsAt + (this.count + 1) * 4;
    if (this.poolAt + poolBytes !== this.bytes.length) throw new Error('La base de productos está incompleta o dañada.');
    if (this.view.getUint32(this.offsetsAt + this.count * 4, true) !== poolBytes) throw new Error('La base de productos está dañada (textos).');
  }

  private codeAt(index: number): number {
    return this.view.getFloat64(this.codesAt + index * 8, true);
  }

  /** El producto número `index` (de 0 a `count - 1`, por orden de código). */
  at(index: number): ProductRecord {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new RangeError(`Producto fuera de rango: ${index}`);
    const n = this.codeAt(index);
    const nutrients = this.nutrientsAt + index * this.nutrientBytes;
    const start = this.view.getUint32(this.offsetsAt + index * 4, true);
    const end = this.view.getUint32(this.offsetsAt + (index + 1) * 4, true);
    if (end < start) throw new Error('La base de productos está dañada (textos).');
    const text = new TextDecoder().decode(this.bytes.subarray(this.poolAt + start, this.poolAt + end));
    const split = text.indexOf('\u0000');
    const serving = this.view.getUint16(nutrients + 8, true);
    const extra = (offset: number, scale: number): number | null => {
      if (this.version === 1) return null;
      const raw = this.view.getUint16(nutrients + offset, true);
      return raw === NO_DATA ? null : raw / scale;
    };
    return {
      // Los de 12 o 13 cifras se dan como EAN-13 (con ceros delante); los de 8, como EAN-8.
      code: String(n).padStart(n < 1e8 ? 8 : 13, '0'),
      name: split < 0 ? text : text.slice(0, split),
      brand: split < 0 ? '' : text.slice(split + 1),
      kcal: this.view.getUint16(nutrients, true) / 10,
      proteinG: this.view.getUint16(nutrients + 2, true) / 10,
      carbsG: this.view.getUint16(nutrients + 4, true) / 10,
      fatG: this.view.getUint16(nutrients + 6, true) / 10,
      servingG: serving === 0 ? null : serving,
      fiberG: extra(10, 10),
      sugarsG: extra(12, 10),
      saltG: extra(14, 100),
    };
  }

  /**
   * Todos los textos («nombre NUL marca») de la base, sin crear un objeto por producto: los bytes y dónde empieza el de cada uno (`count + 1` desfases;
   * el último es el final). Sirve para buscar por palabras (`food-db-search.ts`) sin recorrer la base producto a producto.
   */
  textBlock(): { pool: Uint8Array; offsets: Uint32Array } {
    const end = this.view.getUint32(this.offsetsAt + this.count * 4, true);
    const offsets = new Uint32Array(this.count + 1);
    for (let i = 0; i <= this.count; i++) offsets[i] = this.view.getUint32(this.offsetsAt + i * 4, true);
    return { pool: this.bytes.subarray(this.poolAt, this.poolAt + end), offsets };
  }

  /** Busca un producto por su código de barras (como texto de cifras). `null` si no está. */
  find(code: string): ProductRecord | null {
    const target = asCodeNumber(code);
    if (target === null) return null;
    let low = 0;
    let high = this.count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const value = this.codeAt(mid);
      if (value === target) return this.at(mid);
      if (value < target) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }
}

/** El día (desde 1970) de una fecha `AAAA-MM-DD`. */
export function dayOfDate(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`Fecha no válida: ${date}`);
  return Math.floor(ms / 86_400_000);
}

/** La fecha `AAAA-MM-DD` de un día desde 1970. */
export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
