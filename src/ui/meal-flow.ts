import { signal } from '@preact/signals';
import { MAX_DISH_INGREDIENTS, type DishIngredient, type SavedDish } from '../domain/dishes';
import type { TextAnalysis } from '../domain/food-text';
import { appendAnalysis } from '../domain/text-edit';

// Por dónde va la hoja «He comido algo»: el paso en el que está y lo que se está montando (un plato nuevo o uno que se edita). Vive aparte de los componentes porque lo comparten la hoja
// (los tres modos de anotar), el constructor de platos y la barra de platos guardados.

/**
 * - `menu`: la barra de platos guardados y las tres formas de anotar.
 * - `manual`, `barcode`, `text`, `scale`: anotar una comida, o un ingrediente del plato si `addingIngredient` es `true` (`scale`: pesándola con la báscula).
 * - `dish`: el constructor (nombre, foto e ingredientes de un plato).
 * - `add`: elegir cómo añadir un ingrediente al plato.
 * - `use`: anotar un plato guardado, con los gramos de cada ingrediente.
 */
export type Step = 'menu' | 'manual' | 'barcode' | 'text' | 'scale' | 'dish' | 'add' | 'use';

export const step = signal<Step>('menu');

/** El plato que se está montando. Los números van como texto de formulario. */
export interface DishDraft {
  /** Si se edita un plato ya guardado: su identidad y lo que no se toca. */
  id?: string;
  createdMs?: number;
  lastUsedMs?: number;
  name: string;
  photo?: string;
  ingredients: DishIngredient[];
}

export const dishDraft = signal<DishDraft | null>(null);

/** `true` mientras manual / código de barras / palabras añaden un ingrediente al plato en vez de anotar una comida. */
export const addingIngredient = signal(false);

/** El plato guardado que se anota (paso `use`). */
export const usingDish = signal<SavedDish | null>(null);

// ───────────────────────────── el plato que se va pesando ─────────────────────────────
// El paso de pesar monta un plato ingrediente a ingrediente. Ese plato (y lo ya pesado que sigue en la báscula) NO puede vivir en el componente: desde el paso se sale a otras formas de
// añadir un ingrediente (el código de barras y, de ahí, «Anotarlo a mano» o «Enseñarle este producto»), eso desmonta el paso, y lo que salga de allí tiene que añadirse al MISMO plato y
// dejar a la persona de vuelta pesando, no anotarse en el diario ni cerrar la hoja.

/** Lo que lleva el plato que se pesa; `version` sube con cada cambio para que el formulario de debajo (que parte de esas cifras) se rehaga. */
export interface ScalePlate {
  analysis: TextAnalysis;
  version: number;
}

export const scalePlate = signal<ScalePlate | null>(null);

/** Lo ya pesado que sigue encima de la báscula (ver `netWeight`). */
export const scaleBaseline = signal(0);

/** `true` mientras una forma de añadir abierta DESDE el paso de pesar (código de barras, a mano) trabaja para ese plato: su resultado se suma al plato y se vuelve a pesar. */
export const fromScale = signal(false);

/** Suma al plato que se pesa lo que calculó otra cosa. `false` si no cabe (el plato admite un máximo de alimentos). */
export function addToScalePlate(extra: TextAnalysis): boolean {
  const current = scalePlate.value;
  const merged = current === null ? extra : appendAnalysis(current.analysis, extra);
  if (merged === null) return false;
  scalePlate.value = { analysis: merged, version: (current?.version ?? 0) + 1 };
  return true;
}

/** Empieza un plato de cero (al entrar a pesar desde el menú, o al salir de la hoja). */
export function clearScalePlate(): void {
  scalePlate.value = null;
  scaleBaseline.value = 0;
  fromScale.value = false;
}

/** Sale del paso de pesar hacia otra forma de añadir un ingrediente, que trabajará para el plato que se pesa. */
export function leaveScaleFor(next: 'barcode' | 'manual'): void {
  fromScale.value = true;
  step.value = next;
}

/** Vuelve al paso de pesar con el plato como estaba (más lo que se acabe de añadir). */
export function returnToScale(): void {
  fromScale.value = false;
  step.value = 'scale';
}

/** Deja la hoja como al abrirla (al cerrarla, o al volver al principio). */
export function resetMealFlow(): void {
  step.value = 'menu';
  dishDraft.value = null;
  addingIngredient.value = false;
  usingDish.value = null;
  clearScalePlate();
}

export function startNewDish(): void {
  dishDraft.value = { name: '', ingredients: [] };
  addingIngredient.value = false;
  step.value = 'dish';
}

export function editDish(dish: SavedDish): void {
  dishDraft.value = {
    id: dish.id,
    createdMs: dish.createdMs,
    ...(dish.lastUsedMs !== undefined ? { lastUsedMs: dish.lastUsedMs } : {}),
    name: dish.name,
    ...(dish.photo !== undefined ? { photo: dish.photo } : {}),
    ingredients: dish.ingredients.map((item) => ({ ...item })),
  };
  addingIngredient.value = false;
  usingDish.value = null;
  step.value = 'dish';
}

export function openDish(dish: SavedDish): void {
  usingDish.value = dish;
  addingIngredient.value = false;
  step.value = 'use';
}

/** Cambia lo que lleva el plato que se monta (sin tocar el resto). */
export function updateDraft(change: Partial<DishDraft>): void {
  const current = dishDraft.value;
  if (current !== null) dishDraft.value = { ...current, ...change };
}

/** Añade un ingrediente al plato que se monta y vuelve al constructor. */
export function addIngredientToDraft(ingredient: DishIngredient): void {
  addIngredientsToDraft([ingredient]);
}

/**
 * Añade varios ingredientes de una vez (lo calculado con palabras o pesado en la báscula, cada alimento por separado) y vuelve al constructor. Devuelve `false`, sin añadir nada, si
 * el plato no admite tantos.
 */
export function addIngredientsToDraft(ingredients: readonly DishIngredient[]): boolean {
  const current = dishDraft.value;
  if (current === null) return false;
  if (current.ingredients.length + ingredients.length > MAX_DISH_INGREDIENTS) return false;
  dishDraft.value = { ...current, ingredients: [...current.ingredients, ...ingredients] };
  addingIngredient.value = false;
  step.value = 'dish';
  return true;
}
