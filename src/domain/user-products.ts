import { isBarcode, per100gFromLabel, type Per100g } from './food-label';
import type { FoodProduct } from './nutrition';

// Los productos que la persona le enseña a la app con lo que pone su etiqueta («Mis productos»): un producto que no está en la base del móvil
// (una marca rara, algo traído de fuera, un producto nuevo) se da de alta UNA vez, con su código de barras, y desde entonces se reconoce al escanearlo.
// También sirven para corregir una cifra mal subida a Open Food Facts: lo que enseña la persona manda sobre la base.

export const MAX_PRODUCT_NAME = 80;
/** Lo máximo que se guarda (y que admite una copia de seguridad): sobra para una persona. */
export const MAX_USER_PRODUCTS = 5_000;
export const MAX_SERVING_G = 5_000;

export interface UserProduct {
  /** El código de barras tal como se leyó o se tecleó (8 a 14 cifras con su cifra de control). */
  barcode: string;
  name: string;
  /** Lo que dice la etiqueta por cada 100 g (o 100 ml); la fibra, los azúcares y la sal solo si se anotaron. */
  per100g: Per100g;
  /** Gramos de una ración si la etiqueta la indica. */
  servingG: number | null;
  createdMs: number;
  updatedMs: number;
}

/** Lo que escribe la persona en el formulario de un producto, ya leído a números (`null`: vacío). */
export interface UserProductDraft {
  barcode: string;
  name: string;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarsG: number | null;
  saltG: number | null;
  servingG: number | null;
}

/**
 * La clave con que se guarda un producto: el código sin ceros a la izquierda, porque un UPC-A de 12 cifras y su EAN-13 con un cero delante son el mismo
 * producto (así lo trata también la base de la app).
 */
export const productKey = (barcode: string): string => String(Number(barcode));

/** Los problemas de lo escrito, en frases para la persona; vacío si se puede guardar. */
export function validateProductDraft(draft: UserProductDraft): string[] {
  const problems: string[] = [];
  if (!isBarcode(draft.barcode)) problems.push('El código de barras no es válido.');
  const name = draft.name.trim();
  if (name === '') problems.push('Ponle un nombre al producto.');
  else if ([...name].length > MAX_PRODUCT_NAME) problems.push(`El nombre admite como mucho ${MAX_PRODUCT_NAME} letras.`);
  if (draft.kcal === null) problems.push('Faltan las calorías por 100 g (o 100 ml).');
  else if (draft.kcal < 0) problems.push('Las calorías no pueden ser negativas.');
  else if (per100gFromLabel(rawOf(draft)) === null) {
    problems.push('Esas cifras no cuadran: revisa las calorías y los nutrientes, que son por 100 g (o 100 ml) y no por ración. Más de 900 kcal o más de 100 g de un nutriente por 100 g no puede ser, y las calorías tienen que parecerse a lo que suman las proteínas, los hidratos y las grasas.');
  }
  for (const [value, label] of [
    [draft.proteinG, 'Las proteínas'],
    [draft.carbsG, 'Los hidratos'],
    [draft.fatG, 'Las grasas'],
    [draft.fiberG, 'La fibra'],
    [draft.sugarsG, 'Los azúcares'],
    [draft.saltG, 'La sal'],
  ] as const) {
    if (value !== null && value < 0) problems.push(`${label} no pueden ser negativas.`);
  }
  if (draft.sugarsG !== null && draft.sugarsG > (draft.carbsG ?? 0) * 1.05 + 0.5) problems.push('Los azúcares son una parte de los hidratos: no pueden ser más que ellos.');
  if (draft.fiberG !== null && draft.fiberG > 80) problems.push('La fibra por 100 g no puede pasar de 80 g.');
  if (draft.saltG !== null && draft.saltG > 50) problems.push('La sal por 100 g no puede pasar de 50 g.');
  if (draft.servingG !== null && (draft.servingG < 1 || draft.servingG > MAX_SERVING_G)) problems.push(`La ración tiene que estar entre 1 y ${String(MAX_SERVING_G).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} g.`);
  return problems;
}

const rawOf = (draft: UserProductDraft) => ({
  kcal: draft.kcal ?? undefined,
  protein: draft.proteinG ?? undefined,
  carbs: draft.carbsG ?? undefined,
  fat: draft.fatG ?? undefined,
  fiber: draft.fiberG ?? undefined,
  sugars: draft.sugarsG ?? undefined,
  salt: draft.saltG ?? undefined,
});

/** El producto de un formulario ya validado (`null` si no lo está). `previous` conserva la fecha en que se enseñó por primera vez. */
export function userProductOf(draft: UserProductDraft, nowMs: number, previous?: UserProduct): UserProduct | null {
  if (validateProductDraft(draft).length > 0) return null;
  const per100g = per100gFromLabel(rawOf(draft));
  if (per100g === null) return null;
  return {
    barcode: draft.barcode,
    name: [...draft.name.trim().replace(/\s+/g, ' ')].slice(0, MAX_PRODUCT_NAME).join(''),
    per100g,
    servingG: draft.servingG === null ? null : Math.round(draft.servingG),
    createdMs: previous?.createdMs ?? nowMs,
    updatedMs: nowMs,
  };
}

/** Lo que se ve y se anota de un producto de la persona, igual que uno de la base (con la marca `own`). */
export function foodProductOf(product: UserProduct): FoodProduct {
  return { barcode: product.barcode, name: product.name, per100g: product.per100g, servingG: product.servingG, own: true };
}

/** El formulario de un producto ya guardado (para corregirlo): las cifras como números. */
export function draftOfProduct(product: FoodProduct | UserProduct): UserProductDraft {
  const per100g = product.per100g;
  return {
    barcode: product.barcode,
    name: product.name,
    kcal: per100g.kcal,
    proteinG: per100g.proteinG,
    carbsG: per100g.carbsG,
    fatG: per100g.fatG,
    fiberG: per100g.fiberG ?? null,
    sugarsG: per100g.sugarsG ?? null,
    saltG: per100g.saltG ?? null,
    servingG: product.servingG,
  };
}

/** Los productos de la persona que llevan TODAS las palabras (sin tildes ni mayúsculas) en el nombre: para encontrarlos al contar lo que comió con palabras. */
export function searchUserProducts(products: readonly UserProduct[], words: readonly string[], limit = 3): UserProduct[] {
  const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const terms = words.map(fold).filter((word) => word.length >= 2);
  if (terms.length === 0) return [];
  const stems = (word: string): string[] => [word, ...(word.length >= 4 && word.endsWith('s') ? [word.slice(0, -1)] : []), ...(word.length >= 5 && word.endsWith('es') ? [word.slice(0, -2)] : [])];
  return products
    .filter((product) => {
      const nameWords = fold(product.name).split(/[^a-z0-9]+/).filter((word) => word !== '');
      return terms.every((term) => nameWords.some((word) => stems(word).some((a) => stems(term).includes(a))));
    })
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, limit);
}

/**
 * Los productos de la lista que casan con lo escrito en el buscador de «Mis productos»: cada palabra tiene que estar en el nombre (sin tildes ni mayúsculas, en
 * cualquier parte de una palabra) o en el código. Sin nada escrito, todos, en el orden recibido.
 */
export function filterUserProducts(products: readonly UserProduct[], query: string): UserProduct[] {
  const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const terms = fold(query).split(/\s+/).filter((term) => term !== '');
  if (terms.length === 0) return [...products];
  return products.filter((product) => {
    const name = fold(product.name);
    return terms.every((term) => name.includes(term) || product.barcode.includes(term));
  });
}
