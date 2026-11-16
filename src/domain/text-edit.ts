import type { TextAnalysis, TextItem } from './food-text';
import { buildMeal, type MealDraft } from './nutrition';

// Corregir lo que calculó el texto («dos huevos con jamón y pan») SIN volver a escribirlo: cambiar los gramos de un alimento o de una pieza de un plato compuesto, quitarlos
// o añadir otro. Todo se recalcula con la regla de tres sobre lo que la tabla ya calculó (los nutrientes de un alimento son proporcionales a su cantidad) y un plato
// compuesto sigue sumando lo que llevan sus piezas. Son las mismas cifras que saldrían de escribirlo con otras cantidades, sin pasar por las palabras.

/** Lo mínimo y lo máximo que se puede poner de un alimento (g o ml): lo mismo que admite el analizador de texto. */
export const MIN_EDIT_AMOUNT = 1;
export const MAX_EDIT_AMOUNT = 5_000;
/** Cuántos alimentos puede llevar lo calculado (el mismo tope que el analizador de texto). */
export const MAX_EDIT_ITEMS = 20;

export const isEditableAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= MIN_EDIT_AMOUNT && value <= MAX_EDIT_AMOUNT;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** ¿Se puede cambiar su cantidad? Un alimento dicho solo con sus calorías («tarta 350 kcal») no tiene gramos de los que partir. */
export const hasAmount = (item: TextItem): boolean => item.kcalOnly !== true && item.amount > 0;

/** El mismo alimento con otra cantidad: calorías y nutrientes proporcionales; un plato compuesto reparte el cambio entre todas sus piezas. */
export function withAmount(item: TextItem, amount: number): TextItem {
  if (!hasAmount(item) || !isEditableAmount(amount)) return item;
  const factor = amount / item.amount;
  if (item.parts && item.parts.length > 0) {
    return fromParts(
      item,
      item.parts.map((part) => withAmount(part, round1(part.amount * factor))),
    );
  }
  return {
    ...item,
    amount: round1(amount),
    kcal: Math.round(item.kcal * factor),
    proteinG: round1(item.proteinG * factor),
    carbsG: round1(item.carbsG * factor),
    fatG: round1(item.fatG * factor),
    ...(item.fiberG !== undefined ? { fiberG: round1(item.fiberG * factor) } : {}),
    ...(item.sugarsG !== undefined ? { sugarsG: round1(item.sugarsG * factor) } : {}),
    ...(item.saltG !== undefined ? { saltG: round2(item.saltG * factor) } : {}),
    // Con una cantidad puesta a mano ya no es «una ración habitual».
    assumed: false,
  };
}

/** Un plato compuesto con estas piezas: su cantidad y sus nutrientes son la suma de ellas. */
function fromParts(item: TextItem, parts: TextItem[]): TextItem {
  const sum = (pick: (part: TextItem) => number): number => parts.reduce((total, part) => total + pick(part), 0);
  const known = (pick: (part: TextItem) => number | undefined, round: (n: number) => number): number | undefined => {
    const values = parts.map(pick).filter((v): v is number => v !== undefined);
    return values.length === 0 ? undefined : round(values.reduce((a, b) => a + b, 0));
  };
  const fiberG = known((p) => p.fiberG, round1);
  const sugarsG = known((p) => p.sugarsG, round1);
  const saltG = known((p) => p.saltG, round2);
  return {
    ...item,
    parts,
    amount: round1(sum((p) => p.amount)),
    kcal: Math.round(sum((p) => p.kcal)),
    proteinG: round1(sum((p) => p.proteinG)),
    carbsG: round1(sum((p) => p.carbsG)),
    fatG: round1(sum((p) => p.fatG)),
    ...(fiberG !== undefined ? { fiberG } : {}),
    ...(sugarsG !== undefined ? { sugarsG } : {}),
    ...(saltG !== undefined ? { saltG } : {}),
    assumed: false,
  };
}

const replaceAt = <T,>(list: readonly T[], index: number, value: T | null): T[] => list.flatMap((entry, i) => (i !== index ? [entry] : value === null ? [] : [value]));

/** Pone otra cantidad a un alimento de la lista (si no es válida, o no se puede cambiar, la lista queda igual). */
export function setItemAmount(analysis: TextAnalysis, index: number, amount: number): TextAnalysis {
  const item = analysis.items[index];
  if (!item) return analysis;
  return { ...analysis, items: replaceAt(analysis.items, index, withAmount(item, amount)) };
}

/** Pone otra cantidad a una pieza de un plato compuesto («la carne del kebab»): el plato suma lo que llevan ahora sus piezas. */
export function setPartAmount(analysis: TextAnalysis, index: number, partIndex: number, amount: number): TextAnalysis {
  const item = analysis.items[index];
  const part = item?.parts?.[partIndex];
  if (!item || !item.parts || !part) return analysis;
  const changed = withAmount(part, amount);
  if (changed === part) return analysis;
  return { ...analysis, items: replaceAt(analysis.items, index, fromParts(item, replaceAt(item.parts, partIndex, changed))) };
}

/** Quita un alimento de la lista. */
export function removeItem(analysis: TextAnalysis, index: number): TextAnalysis {
  return analysis.items[index] ? { ...analysis, items: replaceAt(analysis.items, index, null) } : analysis;
}

/** Quita una pieza de un plato compuesto («sin la cebolla»); si era la única, se quita el plato. */
export function removePart(analysis: TextAnalysis, index: number, partIndex: number): TextAnalysis {
  const item = analysis.items[index];
  if (!item?.parts?.[partIndex]) return analysis;
  if (item.parts.length === 1) return removeItem(analysis, index);
  return { ...analysis, items: replaceAt(analysis.items, index, fromParts(item, replaceAt(item.parts, partIndex, null))) };
}

/**
 * Añade a lo calculado lo que calculó otro texto («20 g de queso»). Devuelve `null` si pasaría del máximo de alimentos. Lo no reconocido y lo supuesto se suman a lo que ya había.
 */
export function appendAnalysis(analysis: TextAnalysis, extra: TextAnalysis): TextAnalysis | null {
  if (analysis.items.length + extra.items.length > MAX_EDIT_ITEMS) return null;
  return {
    items: [...analysis.items, ...extra.items],
    unknown: [...analysis.unknown, ...extra.unknown],
    assumptions: [analysis.assumptions, extra.assumptions].filter((text) => text !== '').join(' '),
  };
}

/**
 * Un alimento de lo calculado a partir de unas cifras que ya se tienen (un producto de código de barras con su cantidad, o lo anotado a mano): así se suma al plato que se pesa
 * igual que lo escrito con palabras, y su cantidad se puede corregir después (regla de tres). Se redondea como una comida; sin nombre se llama «Ingrediente».
 */
export function itemOfDraft(draft: MealDraft, amount: number): TextItem {
  const meal = buildMeal({ ...draft, name: draft.name.trim() === '' ? 'Ingrediente' : draft.name }, { id: 'item', tsMs: 0, source: 'manual' });
  return {
    name: meal.name,
    amount: round1(amount),
    unit: 'g',
    kcal: meal.kcal,
    proteinG: meal.proteinG ?? 0,
    carbsG: meal.carbsG ?? 0,
    fatG: meal.fatG ?? 0,
    ...(meal.fiberG !== undefined ? { fiberG: meal.fiberG } : {}),
    ...(meal.sugarsG !== undefined ? { sugarsG: meal.sugarsG } : {}),
    ...(meal.saltG !== undefined ? { saltG: meal.saltG } : {}),
    assumed: false,
  };
}

/** Lo calculado que es solo este alimento (para sumarlo con `appendAnalysis`). */
export const analysisOfItem = (item: TextItem): TextAnalysis => ({ items: [item], assumptions: '', unknown: [] });
