// La etiqueta de un producto (calorías y nutrientes por cada 100 g) y cómo se da por buena. Módulo sin importaciones: lo usan la app y
// también `tools/build-food-db.ts`, que corre en Node sin compilar. Los datos de Open Food Facts los sube la gente: una cifra
// imposible o incoherente se descarta antes de que llegue a la base del móvil, no cuando alguien la anota.

/** Lo que dice la etiqueta de un producto por cada 100 g (o 100 ml). */
export interface Per100g {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Fibra, azúcares (parte de los hidratos) y sal por 100 g. Ausentes si la etiqueta (o la base antigua) no los trae: «sin dato», no cero. */
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
}

export const KJ_PER_KCAL = 4.184;

/** Más de esto por 100 g es más que grasa pura (900 kcal): un dato mal subido. */
export const MAX_KCAL_PER_100G = 900;

export const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Un número de una celda de texto o de un JSON; `null` si está vacío, no es un número o es negativo. */
export const asNumber = (value: unknown): number | null => {
  // Una cadena vacía no es un cero (`Number('')` vale 0): sería un producto de 0 kcal en vez de «sin dato».
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Los valores crudos de la etiqueta tal como vienen en la base de datos. */
export interface RawLabel {
  kcal?: unknown;
  /** Energía en kJ: se usa si no hay kcal. */
  kj?: unknown;
  protein?: unknown;
  carbs?: unknown;
  fat?: unknown;
  fiber?: unknown;
  sugars?: unknown;
  /** Sal en g; si no hay, se usa el sodio (g) × 2,5. */
  salt?: unknown;
  sodium?: unknown;
}

/** Gramos de sal (cloruro sódico) por gramo de sodio. */
export const SALT_PER_SODIUM = 2.5;

/**
 * Fibra, azúcares y sal de una etiqueta, solo los que se pueden creer: cada uno es `null` si falta o no es creíble (los azúcares no pueden ser más que los
 * hidratos —más un margen por el redondeo de la etiqueta—, ni nada pasar de 100 g por cada 100 g; una sal de más de 50 g por 100 g no es un alimento). Falta de dato no es cero.
 */
export function extrasFromLabel(raw: RawLabel, carbsG: number): { fiberG: number | null; sugarsG: number | null; saltG: number | null } {
  const fiber = asNumber(raw.fiber);
  const sugars = asNumber(raw.sugars);
  const salt = asNumber(raw.salt);
  const sodium = asNumber(raw.sodium);
  const saltG = salt ?? (sodium !== null ? sodium * SALT_PER_SODIUM : null);
  return {
    fiberG: fiber !== null && fiber <= 80 ? roundTo(fiber, 1) : null,
    sugarsG: sugars !== null && sugars <= carbsG * 1.05 + 0.5 ? roundTo(sugars, 1) : null,
    saltG: saltG !== null && saltG <= 50 ? roundTo(saltG, 2) : null,
  };
}

/**
 * La etiqueta convertida en cifras fiables, o `null` si no hay calorías (por 100 g, o en kJ, que se pasan a kcal) o los datos no
 * pueden ser ciertos: más de 900 kcal o de 100 g de un nutriente por cada 100 g, o calorías que no cuadran con los nutrientes (0 kcal con
 * 70 g de hidratos). Un nutriente que falta cuenta como 0.
 */
export function per100gFromLabel(raw: RawLabel): Per100g | null {
  const kcalDirect = asNumber(raw.kcal);
  const kj = asNumber(raw.kj);
  const kcal = kcalDirect ?? (kj !== null ? kj / KJ_PER_KCAL : null);
  if (kcal === null || kcal > MAX_KCAL_PER_100G) return null;
  const protein = asNumber(raw.protein) ?? 0;
  const carbs = asNumber(raw.carbs) ?? 0;
  const fat = asNumber(raw.fat) ?? 0;
  if (protein > 100 || carbs > 100 || fat > 100) return null;
  if (kcal < 0.5 * (4 * protein + 4 * carbs + 9 * fat) - 20) return null;
  const extras = extrasFromLabel(raw, carbs);
  return {
    kcal: roundTo(kcal, 1),
    proteinG: roundTo(protein, 1),
    carbsG: roundTo(carbs, 1),
    fatG: roundTo(fat, 1),
    ...(extras.fiberG !== null ? { fiberG: extras.fiberG } : {}),
    ...(extras.sugarsG !== null ? { sugarsG: extras.sugarsG } : {}),
    ...(extras.saltG !== null ? { saltG: extras.saltG } : {}),
  };
}

/** ¿Es un código de barras de producto? (EAN-8, UPC-A, EAN-13 o GTIN-14: solo cifras, con su dígito de control correcto). */
export function isBarcode(text: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(text)) return false;
  const digits = [...text].map(Number);
  const check = digits.pop() as number;
  // De derecha a izquierda, los pesos alternan 3 y 1 empezando por 3 (la cifra de control queda fuera).
  const sum = digits.reverse().reduce((total, d, i) => total + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
