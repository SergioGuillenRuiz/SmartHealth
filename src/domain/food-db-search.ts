import type { FoodDb } from './food-db';

// Buscar productos de la base del móvil por las palabras de su nombre y su marca («kinder bueno white», «tarta de la abuela»): lo usa el
// lenguaje natural para las marcas y los productos envasados que la tabla de alimentos no trae. Es una búsqueda sencilla y honesta: un producto
// vale si tiene TODAS las palabras pedidas (con su plural o singular), y entre los que valen gana el de nombre más parecido al pedido, apoyado
// por los productos repetidos con las mismas cifras (el mismo producto con varios códigos de barras es lo más fiable que hay).
//
// La base son ~240 000 productos y ~8 MB de texto: se prepara una sola vez (todo el texto en una cadena en minúsculas y sin tildes, con el
// principio de cada producto anotado) y cada búsqueda salta de aparición en aparición de la palabra más larga, sin recorrer producto a producto.

export interface ProductHit {
  name: string;
  brand: string;
  /** Por cada 100 g (o 100 ml). */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  servingG: number | null;
  /** Fibra, azúcares y sal por 100 g; ausentes si la etiqueta no los trae. */
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
}

/** Cuántas apariciones de la palabra más larga se miran, como mucho, en una búsqueda (por si piden «pan»). */
const MAX_SCANNED = 40_000;

/** Cómo queda cada byte de un texto UTF-8 en la cadena de búsqueda: minúscula, y todo lo que no es letra ni cifra, un espacio. */
const BYTE_FOLD = (() => {
  const table = new Uint8Array(256).fill(32);
  for (let byte = 48; byte <= 57; byte++) table[byte] = byte;
  for (let byte = 97; byte <= 122; byte++) table[byte] = byte;
  for (let byte = 65; byte <= 90; byte++) table[byte] = byte + 32;
  table[10] = 10;
  return table;
})();

/** Las letras con tilde del latín (U+00C0 a U+017F), que en UTF-8 son dos bytes (`C3 xx`, `C4 xx`, `C5 xx`), pasadas a su letra sin tilde. */
const LATIN_FOLD: readonly Uint8Array[] = (() => {
  const tables = [new Uint8Array(64).fill(32), new Uint8Array(64).fill(32), new Uint8Array(64).fill(32)];
  for (let code = 0xc0; code <= 0x17f; code++) {
    const base = String.fromCharCode(code).normalize('NFD').charAt(0).toLowerCase();
    const lead = (0xc0 | (code >> 6)) - 0xc3;
    if (/^[a-z]$/.test(base) && lead >= 0 && lead <= 2) tables[lead]![code & 0x3f] = base.charCodeAt(0);
  }
  return tables;
})();

/** Una palabra pedida, en minúsculas y sin tildes ni signos. */
const foldTerm = (word: string): string =>
  word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Las formas con que se puede escribir una palabra en singular o plural: dos palabras son la misma si comparten alguna. */
function forms(word: string): string[] {
  const out = [word];
  if (word.length >= 4 && word.endsWith('s')) out.push(word.slice(0, -1));
  if (word.length >= 5 && word.endsWith('es')) out.push(word.slice(0, -2));
  return out;
}

const sameWord = (a: string, b: string): boolean => a === b || forms(a).some((form) => forms(b).includes(form));

const hasLetters = (text: string): boolean => /\p{L}{3}/u.test(text);

/**
 * El nombre con que se enseña un producto de la base: los datos de Open Food Facts los sube la gente y a veces el «nombre» es solo el código de barras
 * («4000177158210»); entonces vale la marca, y si tampoco la hay (o es otro número), el producto no sirve para nada y se queda sin nombre.
 */
export function readableName(name: string, brand: string): string {
  if (hasLetters(name)) return name;
  return hasLetters(brand) ? brand : '';
}

/** Palabras que explican un producto de 0 kcal sin nutrientes (agua, café, refrescos sin azúcar…): sin ellas, un 0 es un dato mal subido. */
const ZERO_CALORIE_WORDS = /\b(agua|cafe|te|infusion|manzanilla|tila|poleo|zero|cero|light|sin azucar|sin calorias|sin gas|edulcorante|sal|vinagre|especias|gelatina|refresco|bebida|cola|tonica|soda|sifon|mineral|hielo|pimienta|oregano|laurel)\b/;

/** Un producto con 0 kcal y 0 g de todo que no es de los que no llevan nada: una cifra que alguien se dejó sin rellenar. */
function looksUnfilled(product: { name: string; kcal: number; proteinG: number; carbsG: number; fatG: number }): boolean {
  return product.kcal === 0 && product.proteinG + product.carbsG + product.fatG === 0 && !ZERO_CALORIE_WORDS.test(foldTerm(product.name).replace(/[^a-z0-9]+/g, ' '));
}

export class ProductSearch {
  private folded = '';
  /** Dónde empieza (en `folded`) el texto de cada producto; el último es el final. */
  private starts = new Uint32Array(0);
  private ready = false;
  private readonly db: FoodDb;

  constructor(db: FoodDb) {
    this.db = db;
  }

  /** Prepara el buscador (lo que tarda la primera búsqueda) sin buscar nada: para hacerlo cuando la app está ociosa y no al pulsar «Calcular». */
  warm(): void {
    if (this.db.count > 0) this.prepare();
  }

  private prepare(): void {
    if (this.ready) return;
    const { pool, offsets } = this.db.textBlock();
    const count = this.db.count;
    // Todo el texto en una sola pasada: minúsculas, sin tildes y un salto de línea detrás de cada producto (para que el final de uno no se pegue al
    // principio del siguiente). Una letra con tilde (dos bytes) da una sola letra, así que el texto puede quedar más corto que el bloque.
    const folded = new Uint8Array(pool.length + count);
    const starts = new Uint32Array(count + 1);
    let write = 0;
    for (let i = 0; i < count; i++) {
      starts[i] = write;
      const to = offsets[i + 1]!;
      for (let at = offsets[i]!; at < to; at++) {
        const byte = pool[at]!;
        const accent = byte >= 0xc3 && byte <= 0xc5 && at + 1 < to ? LATIN_FOLD[byte - 0xc3] : undefined;
        if (accent) {
          folded[write++] = accent[pool[at + 1]! & 0x3f]!;
          at++;
        } else folded[write++] = BYTE_FOLD[byte]!;
      }
      folded[write++] = 10;
    }
    starts[count] = write;
    this.folded = new TextDecoder('latin1').decode(folded.subarray(0, write));
    this.starts = starts;
    this.ready = true;
  }

  /** El producto al que pertenece la letra `at` de `folded`. */
  private recordAt(at: number): number {
    let low = 0;
    let high = this.db.count - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.starts[mid]! <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /**
   * Los productos cuyo nombre y marca llevan todas las `words` (sin tildes ni mayúsculas, solo letras y cifras), del más parecido a lo pedido al
   * menos. Cada resultado es un producto distinto por sus cifras: los mismos datos con otro código de barras no se repiten.
   */
  find(words: readonly string[], limit = 3): ProductHit[] {
    const terms = [...new Set(words.map(foldTerm).filter((word) => word.length >= 2))];
    if (terms.length === 0 || this.db.count === 0) return [];
    this.prepare();
    // Se salta de aparición en aparición de la palabra más larga (la más rara) y se comprueban las demás dentro de ese producto.
    const pivot = terms.reduce((best, term) => (term.length > best.length ? term : best), '');
    const stem = pivot.length >= 5 && pivot.endsWith('s') ? pivot.slice(0, -1) : pivot;
    const found = new Map<number, number>();
    let last = -1;
    let scanned = 0;
    for (let at = this.folded.indexOf(stem); at !== -1 && scanned < MAX_SCANNED; at = this.folded.indexOf(stem, at + 1), scanned++) {
      if (at > 0 && /[a-z0-9]/.test(this.folded.charAt(at - 1))) continue; // la palabra tiene que empezar ahí
      const record = this.recordAt(at);
      if (record === last) continue;
      last = record;
      const text = this.folded.slice(this.starts[record]!, this.starts[record + 1]! - 1);
      const tokens = text.split(' ').filter((token) => token !== '');
      if (!terms.every((term) => tokens.some((token) => sameWord(token, term)))) continue;
      // Cuantas menos palabras de sobra, más parecido a lo que se pidió; un producto con ración, y uno que empieza por lo pedido, valen algo más.
      const extra = Math.max(0, tokens.length - terms.length);
      found.set(record, 100 - 6 * extra + (tokens[0] !== undefined && sameWord(tokens[0], terms[0]!) ? 4 : 0));
    }
    if (found.size === 0) return [];
    // Los productos con las mismas cifras son el mismo: pesa la mejor nota del grupo y cuántos son.
    const groups = new Map<string, { best: number; score: number; count: number }>();
    for (const [record, score] of found) {
      const product = this.db.at(record);
      if (readableName(product.name, product.brand) === '' || looksUnfilled(product)) continue;
      const key = `${product.kcal}|${product.proteinG}|${product.carbsG}|${product.fatG}`;
      const adjusted = score + (product.servingG === null ? 0 : 3) + (product.saltG == null ? 0 : 2);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { best: record, score: adjusted, count: 1 });
      else {
        group.count++;
        if (adjusted > group.score) {
          group.score = adjusted;
          group.best = record;
        }
      }
    }
    return [...groups.values()]
      .sort((a, b) => b.score + 4 * Math.min(b.count, 8) - (a.score + 4 * Math.min(a.count, 8)))
      .slice(0, limit)
      .map((group) => {
        const product = this.db.at(group.best);
        const named = readableName(product.name, product.brand);
        return {
          name: named,
          brand: named === product.name ? product.brand : '',
          kcal: product.kcal,
          proteinG: product.proteinG,
          carbsG: product.carbsG,
          fatG: product.fatG,
          servingG: product.servingG,
          ...(product.fiberG != null ? { fiberG: product.fiberG } : {}),
          ...(product.sugarsG != null ? { sugarsG: product.sugarsG } : {}),
          ...(product.saltG != null ? { saltG: product.saltG } : {}),
        };
      });
  }
}
