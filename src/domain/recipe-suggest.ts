import { bestRule, compileRules } from './name-match';
import { classifyName, type Criterion, type MealFit } from './meal-fit';
import { RECIPE_FAMILIES, type Need, type Recipe, type RecipeFamily, type RecipeIngredient, type Role } from './recipes';
import type { HealthGoal, MealEntry } from './nutrition';

// De una comida poco adecuada a las recetas que se le proponen: se mira qué tipo de plato es (pasta, arroz, hamburguesa…) por su nombre, qué le falla (sal, poca proteína, poco saciante…) por su
// valoración y se eligen, de ese tipo, las recetas que más arreglan lo que le falla; después se **ajustan al objetivo de salud** de la persona.

const FAMILY_RULES = compileRules(RECIPE_FAMILIES.filter((family) => family.words !== '').map((family) => ({ value: family.id, role: family.drink ? ('drink' as const) : ('main' as const), words: family.words })));

const GENERAL = RECIPE_FAMILIES.find((family) => family.id === 'general')!;
const SWEET = RECIPE_FAMILIES.find((family) => family.id === 'dulce')!;

/** Lo que se sabe de lo que lleva una comida, para reconocerla cuando su nombre no dice qué es. */
type Composition = Pick<MealEntry, 'kcal' | 'sugarsG'>;

/** Desde esta parte de las calorías en azúcares (4 kcal por gramo) una comida es, a efectos de recetas, un dulce: sirve cuando el nombre no es de nada conocido («unos buñuelos de la abuela»). */
const SWEET_SHARE = 0.3;

const looksSweet = (meal: Composition): boolean => meal.kcal > 0 && meal.sugarsG !== undefined && (meal.sugarsG * 4) / meal.kcal >= SWEET_SHARE;

/**
 * El tipo de plato de una comida: el que dice su nombre; si no dice ninguno, el del grupo de `classifyName` (comida rápida, bollería…); si tampoco, el que sale de lo que lleva (casi todo
 * azúcar: un dulce); y si nada de eso, el general. Antes, una comida de nombre desconocido caía siempre en el general y a unos buñuelos se les proponía una ensalada.
 */
export function familyOf(name: string, meal?: Composition): RecipeFamily {
  const id = bestRule(FAMILY_RULES, name);
  const byName = id === null ? undefined : RECIPE_FAMILIES.find((family) => family.id === id);
  if (byName) return byName;
  const group = classifyName(name).label;
  const byGroup = group === null ? undefined : RECIPE_FAMILIES.find((family) => family.group === group);
  if (byGroup) return byGroup;
  return meal !== undefined && looksSweet(meal) ? SWEET : GENERAL;
}

type MealNumbers = Pick<MealEntry, 'saltG' | 'sugarsG' | 'fiberG'>;

/** Hasta aquí la sal o el azúcar de una sola comida no es un problema (g): por encima, se busca una receta que lleve menos. */
const SALT_PER_MEAL_G = 1.5;
const SUGARS_PER_MEAL_G = 15;
const FIBER_PER_MEAL_G = 3;

/** Lo que una comida necesita mejorar, según su valoración y lo que se sabe de ella. */
export function needsOf(meal: MealNumbers, fit: MealFit): Need[] {
  const bad = (key: Criterion['key']): boolean => fit.criteria.some((criterion) => criterion.key === key && criterion.rating === 'bad');
  const needs = new Set<Need>();
  if (bad('energy')) needs.add('light');
  if (bad('protein')) needs.add('protein');
  if (bad('satiety')) needs.add('filling');
  if (bad('excess')) {
    // Si se sabe cuánto lleva de cada, se dice cuál; si no, las dos.
    const salty = meal.saltG !== undefined && meal.saltG >= SALT_PER_MEAL_G;
    const sweet = meal.sugarsG !== undefined && meal.sugarsG >= SUGARS_PER_MEAL_G;
    if (salty) needs.add('salt');
    if (sweet) needs.add('sugar');
    if (!salty && !sweet) {
      needs.add('salt');
      needs.add('sugar');
    }
  }
  if (bad('health') && (meal.fiberG === undefined || meal.fiberG < FIBER_PER_MEAL_G)) needs.add('fiber');
  return [...needs];
}

/** Los criterios de la valoración que salen mal: lo que se le dice a la persona que «pesa» en esta comida. */
export function weakPoints(fit: MealFit): Criterion[] {
  return fit.criteria.filter((criterion) => criterion.rating === 'bad');
}

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Un número repartido de forma pareja a partir de un texto (FNV-1a de 32 bits): sirve para que `variety` elija distinto con cada comida sin que haya nada aleatorio que no se pueda repetir. */
function shuffleKey(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Las recetas de un tipo de plato, de la que más conviene a la que menos: cuenta más que se parezca a la comida (`closeTo`) y después cuántas de las cosas que le fallan arregla.
 * A igualdad, el orden en que están escritas; o, si se da `variety` (por ejemplo, el identificador de la comida), un orden que cambia con ella: con tantas recetas y productos que encajan
 * igual de bien, así no sale siempre lo mismo. Lo que encaja mejor va siempre antes: la variedad solo mueve a las que empatan.
 */
export function rankRecipes(family: RecipeFamily, mealName: string, needs: readonly Need[], limit = 3, variety?: string): Recipe[] {
  const name = plain(mealName);
  const close = (recipe: Recipe): boolean => recipe.closeTo !== undefined && recipe.closeTo.split('|').some((word) => new RegExp(`(?<![a-z])${word}`).test(name));
  const score = (recipe: Recipe): number => {
    // Una receta salada entre las de un tipo dulce (la tostada con tomate) solo si la comida se le parece: a quien se come unos buñuelos no se le propone.
    if (recipe.savory === true && !close(recipe)) return -1;
    return (close(recipe) ? 3 : 0) + recipe.fixes.filter((fix) => needs.includes(fix)).length;
  };
  const ranked = family.recipes
    .map((recipe, order) => ({ recipe, order, points: score(recipe) }))
    .filter(({ points }) => points >= 0)
    .map((entry) => ({ ...entry, tie: variety === undefined ? entry.order : shuffleKey(`${variety}|${entry.recipe.id}`) }))
    .sort((a, b) => b.points - a.points || a.tie - b.tie || a.order - b.order)
    .map(({ recipe }) => recipe);
  const picked = ranked.slice(0, limit);
  // Que haya de las dos clases cuando el tipo las tiene: algo que se prepara y algo que se compra hecho. Con poca gana de cocinar, lo segundo es lo que de verdad se hace.
  if (limit >= 3 && picked.length === limit) {
    const isProduct = (recipe: Recipe): boolean => recipe.kind === 'product';
    if (!picked.some(isProduct)) {
      const product = ranked.find(isProduct);
      if (product) picked[limit - 1] = product;
    } else if (picked.every(isProduct)) {
      const cooked = ranked.find((recipe) => !isProduct(recipe));
      if (cooked) picked[limit - 1] = cooked;
    }
  }
  return picked;
}

// ───────────────────────────── ajustar la receta al objetivo ─────────────────────────────

/** Cuánto se multiplica cada tipo de ingrediente según el objetivo: perder y definir, más verdura y menos hidrato; ganar músculo, más proteína e hidrato; ganar peso, más de todo menos verdura. */
export const GOAL_SCALE: Readonly<Record<HealthGoal, Readonly<Record<Role, number>>>> = {
  lose: { protein: 1.1, carb: 0.8, veg: 1.4, fat: 0.8, fixed: 1 },
  define: { protein: 1.25, carb: 0.8, veg: 1.4, fat: 0.8, fixed: 1 },
  maintain: { protein: 1, carb: 1, veg: 1, fat: 1, fixed: 1 },
  muscle: { protein: 1.3, carb: 1.25, veg: 1, fat: 1, fixed: 1 },
  gain: { protein: 1.1, carb: 1.4, veg: 1, fat: 1.3, fixed: 1 },
};

export const GOAL_NOTE: Readonly<Record<HealthGoal, string>> = {
  lose: 'Ajustada para perder peso: más verdura y algo menos de hidrato.',
  define: 'Ajustada para definir: más proteína y verdura, y menos hidrato.',
  maintain: 'Ración equilibrada para mantener tu peso.',
  muscle: 'Ajustada para ganar músculo: más proteína y más hidrato.',
  gain: 'Ajustada para ganar peso: ración más grande, con más hidrato y grasa.',
};

export interface ScaledIngredient extends RecipeIngredient {
  /** La cantidad que toca con el objetivo (la de la receta, ajustada). */
  amount: number;
}

export interface ScaledRecipe {
  recipe: Recipe;
  goal: HealthGoal;
  ingredients: ScaledIngredient[];
  /** Lo que lleva, dicho con palabras y cantidades, para calcularlo con la tabla de alimentos. */
  text: string;
}

/** A múltiplos de 5 (de gramos o mililitros) para que se puedan pesar; las unidades no se tocan. */
function scaledAmount(ingredient: RecipeIngredient, factor: number): number {
  if (ingredient.unit === 'ud' || ingredient.role === 'fixed') return ingredient.q;
  return Math.max(5, Math.round((ingredient.q * factor) / 5) * 5);
}

/** El plural de la primera palabra del nombre («huevo» → «huevos»; «wrap integral» solo se pluraliza si hay más de uno, y entonces el adjetivo se queda: las recetas no lo piden). */
function pluralName(name: string, amount: number): string {
  if (amount === 1) return name;
  const [first = '', ...rest] = name.split(' ');
  const plural = /[aeiouáéíóú]$/.test(first) ? `${first}s` : /s$/.test(first) ? first : `${first}es`;
  return [plural, ...rest].join(' ');
}

/** Cómo se dice un ingrediente con su cantidad: «150 g de pechuga de pollo», «2 huevos». */
export function ingredientLine(ingredient: ScaledIngredient): string {
  return ingredient.unit === 'ud' ? `${ingredient.amount} ${pluralName(ingredient.name, ingredient.amount)}` : `${ingredient.amount} ${ingredient.unit} de ${ingredient.name}`;
}

export function scaleRecipe(recipe: Recipe, goal: HealthGoal): ScaledRecipe {
  const factors = GOAL_SCALE[goal];
  const ingredients = recipe.ingredients.map((ingredient): ScaledIngredient => ({ ...ingredient, amount: scaledAmount(ingredient, factors[ingredient.role]) }));
  const text = ingredients.map((ingredient) => (ingredient.unit === 'ud' ? `${ingredient.amount} ${pluralName(ingredient.food, ingredient.amount)}` : `${ingredient.amount} ${ingredient.unit} de ${ingredient.food}`)).join(', ');
  return { recipe, goal, ingredients, text };
}
