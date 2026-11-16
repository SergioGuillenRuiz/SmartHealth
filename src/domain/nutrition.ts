import { bmrKcalPerDay, clamp } from './estimation';
import type { DayKey } from './dates';
import { roundTo, type Per100g } from './food-label';
import type { ProfileEntry } from './profile';

export { isBarcode, type Per100g } from './food-label';

// Alimentación: lo que se come (comidas anotadas), lo que conviene según el objetivo de salud y las cuentas que las ponen
// frente a frente. Todo son ESTIMACIONES: ni lo que la persona anota (una ración «a ojo», la etiqueta de un producto, lo que
// calcula la tabla de alimentos de la app) ni las metas (metabolismo basal por fórmula × un nivel de actividad fijo) tienen mejor error que decenas por
// ciento. docs/estimaciones.md explica de dónde sale cada cifra.

// ───────────────────────────── comidas ─────────────────────────────

/**
 * De dónde salieron las cifras de una comida: a mano, de un código de barras, de lo escrito con palabras (`text`), de un plato guardado (`dish`) o de pesarla con la
 * báscula (`scale`). `ai` es de las comidas anotadas con la IA en una versión anterior: ya no se crea, pero se sigue entendiendo.
 */
export type MealSource = 'manual' | 'barcode' | 'text' | 'ai' | 'dish' | 'scale';

export const MEAL_SOURCES: readonly MealSource[] = ['manual', 'barcode', 'text', 'ai', 'dish', 'scale'];

/**
 * Un alimento de los que suman una comida, con SUS cifras para la cantidad que lleva (las mismas que un ingrediente de plato: ver `DishIngredient`). Se guarda con la comida para poder
 * cambiar sus gramos después, ingrediente a ingrediente, con la regla de tres. Sin `grams` (calorías dichas, ingrediente de antes de las cantidades) no se puede escalar.
 */
export interface MealItem {
  name: string;
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  grams?: number;
  barcode?: string;
}

/** Cuántos alimentos puede llevar una comida guardada (lo mismo que un plato). */
export const MAX_MEAL_ITEMS = 20;

/** Una comida anotada. Los nutrientes son opcionales: a mano puede anotarse solo las calorías. */
export interface MealEntry {
  id: string;
  /** Cuándo se anotó (o cuándo se comió): decide a qué día cuenta. */
  tsMs: number;
  /** Qué se comió, como lo escribió la persona o lo dio el producto. */
  name: string;
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  /** Fibra, azúcares (parte de los hidratos) y sal en gramos. Opcionales: una comida anotada antes de que existieran, o a mano sin ellos, no los trae («sin dato», no cero). */
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  source: MealSource;
  /** Código de barras del producto (solo con `source: 'barcode'`). */
  barcode?: string;
  /** Cantidad en gramos (o mililitros) si se conoce. */
  grams?: number;
  /** El plato guardado con el que se anotó (solo con `source: 'dish'`): su foto, si la tiene, es la miniatura de la comida (ver `ui/meal-thumb.tsx`). */
  dishId?: string;
  /** El día al que cuenta si no es el de `tsMs` (se pasó al día anterior o al siguiente: ver `day-credit.ts`). */
  day?: string;
  /** Lo que lleva, alimento a alimento con sus gramos, si se sabe (ver `MealItem`): permite cambiar las cantidades de lo ya anotado. Las comidas anteriores no lo traen y se reconstruye al abrirlas. */
  items?: MealItem[];
}

export const MAX_MEAL_KCAL = 10_000;
export const MAX_MEAL_NUTRIENT_G = 1_000;
export const MAX_MEAL_NAME = 120;

/** Lo que suman las comidas de un día. Los nutrientes son solo de las comidas que los traían. */
export interface IntakeTotals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Fibra y azúcares en gramos y sal con una décima: de las comidas que los traían. */
  fiberG: number;
  sugarsG: number;
  saltG: number;
  /** Número de comidas anotadas. */
  meals: number;
}

/** Suma las comidas de un día (`null` si no hay ninguna: no anotar nada no es haber comido cero). */
export function intakeOf(meals: readonly MealEntry[]): IntakeTotals | null {
  if (meals.length === 0) return null;
  return {
    kcal: Math.round(meals.reduce((sum, m) => sum + m.kcal, 0)),
    proteinG: Math.round(meals.reduce((sum, m) => sum + (m.proteinG ?? 0), 0)),
    carbsG: Math.round(meals.reduce((sum, m) => sum + (m.carbsG ?? 0), 0)),
    fatG: Math.round(meals.reduce((sum, m) => sum + (m.fatG ?? 0), 0)),
    fiberG: Math.round(meals.reduce((sum, m) => sum + (m.fiberG ?? 0), 0)),
    sugarsG: Math.round(meals.reduce((sum, m) => sum + (m.sugarsG ?? 0), 0)),
    saltG: roundTo(
      meals.reduce((sum, m) => sum + (m.saltG ?? 0), 0),
      1,
    ),
    meals: meals.length,
  };
}

/** Los campos de una comida nueva que se rellenan en un formulario (todo texto ya interpretado). */
export interface MealDraft {
  name: string;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  /** Fibra, azúcares y sal (g): opcionales, `null` o ausentes = sin dato. */
  fiberG?: number | null;
  sugarsG?: number | null;
  saltG?: number | null;
}

/**
 * Lo que falla en una comida a punto de guardarse (vacío si está bien). Con calorías vacías pero nutrientes se pueden
 * calcular (ver `kcalFromMacros`), así que eso no es un fallo.
 */
export function validateMealDraft(draft: MealDraft): string[] {
  const problems: string[] = [];
  const kcal = draft.kcal ?? kcalFromMacros(draft);
  if (kcal === null) problems.push('Indica las calorías (o proteínas, hidratos y grasas para que se calculen).');
  else if (kcal < 0 || kcal > MAX_MEAL_KCAL) problems.push(`Las calorías deben estar entre 0 y ${MAX_MEAL_KCAL.toLocaleString('es-ES')}.`);
  for (const [value, label] of [
    [draft.proteinG, 'Las proteínas'],
    [draft.carbsG, 'Los hidratos'],
    [draft.fatG, 'Las grasas'],
    [draft.fiberG ?? null, 'La fibra'],
    [draft.sugarsG ?? null, 'Los azúcares'],
    [draft.saltG ?? null, 'La sal'],
  ] as const) {
    if (value !== null && (value < 0 || value > MAX_MEAL_NUTRIENT_G)) problems.push(`${label} deben estar entre 0 y ${MAX_MEAL_NUTRIENT_G.toLocaleString('es-ES')} g.`);
  }
  // Los azúcares son una parte de los hidratos: más azúcares que hidratos es un error de dedo.
  if (draft.sugarsG != null && draft.carbsG !== null && draft.sugarsG > draft.carbsG * 1.02 + 0.3) problems.push('Los azúcares no pueden ser más que los hidratos.');
  if (draft.name.length > MAX_MEAL_NAME) problems.push(`El nombre admite como mucho ${MAX_MEAL_NAME} letras.`);
  return problems;
}

/** Calorías que salen de los nutrientes (proteínas y carbohidratos 4 kcal/g, grasas 9), o `null` si no hay ninguno. */
export function kcalFromMacros(draft: Pick<MealDraft, 'proteinG' | 'carbsG' | 'fatG'>): number | null {
  if (draft.proteinG === null && draft.carbsG === null && draft.fatG === null) return null;
  return Math.round(4 * (draft.proteinG ?? 0) + 4 * (draft.carbsG ?? 0) + 9 * (draft.fatG ?? 0));
}

/**
 * Una comida lista para guardar. El nombre vacío se sustituye por «Comida»; las calorías, si faltan, salen de los nutrientes. Los
 * números se redondean (las calorías al entero, los gramos a una décima) y lo vacío no se guarda como cero.
 */
export function buildMeal(
  draft: MealDraft,
  extra: { id: string; tsMs: number; source: MealSource; barcode?: string; grams?: number; dishId?: string; items?: readonly MealItem[] },
): MealEntry {
  const kcal = draft.kcal ?? kcalFromMacros(draft) ?? 0;
  const name = draft.name.trim().replace(/\s+/g, ' ').slice(0, MAX_MEAL_NAME);
  return {
    id: extra.id,
    tsMs: extra.tsMs,
    name: name === '' ? 'Comida' : name,
    kcal: Math.round(kcal),
    ...(draft.proteinG !== null ? { proteinG: roundTo(draft.proteinG, 1) } : {}),
    ...(draft.carbsG !== null ? { carbsG: roundTo(draft.carbsG, 1) } : {}),
    ...(draft.fatG !== null ? { fatG: roundTo(draft.fatG, 1) } : {}),
    ...(draft.fiberG != null ? { fiberG: roundTo(draft.fiberG, 1) } : {}),
    ...(draft.sugarsG != null ? { sugarsG: roundTo(draft.sugarsG, 1) } : {}),
    ...(draft.saltG != null ? { saltG: roundTo(draft.saltG, 2) } : {}),
    source: extra.source,
    ...(extra.barcode !== undefined ? { barcode: extra.barcode } : {}),
    ...(extra.grams !== undefined ? { grams: roundTo(extra.grams, 1) } : {}),
    ...(extra.dishId !== undefined ? { dishId: extra.dishId } : {}),
    ...(extra.items !== undefined && extra.items.length > 0 && extra.items.length <= MAX_MEAL_ITEMS ? { items: extra.items.map((item) => ({ ...item })) } : {}),
  };
}

// ───────────────────────────── objetivo de salud y metas ─────────────────────────────

/** Qué busca la persona con lo que come. Decide cuántas calorías y cuánta proteína se le proponen. */
export type HealthGoal = 'lose' | 'define' | 'maintain' | 'muscle' | 'gain';

export const DEFAULT_HEALTH_GOAL: HealthGoal = 'maintain';

interface GoalRule {
  label: string;
  /** Una línea para elegir: qué significa. */
  hint: string;
  /** Ajuste sobre las calorías de mantenimiento (−0,2 = un 20 % menos). */
  adjust: number;
  /** Proteína por kilo de peso al día. */
  proteinPerKg: number;
  /** Parte de las calorías que se reserva a las grasas. */
  fatShare: number;
}

/**
 * Las cinco opciones. Los porcentajes y la proteína siguen las recomendaciones habituales de nutrición deportiva (déficit de un
 * 15–25 % para perder grasa sin perder músculo, superávit de un 5–15 % para ganarlo, 1,4–1,9 g de proteína por kilo según la meta):
 * son una orientación para quien no tiene a un dietista, no una pauta médica.
 */
export const HEALTH_GOALS: Readonly<Record<HealthGoal, GoalRule>> = {
  lose: { label: 'Perder peso', hint: 'Un 20 % menos de calorías y bastante proteína.', adjust: -0.2, proteinPerKg: 1.6, fatShare: 0.28 },
  define: { label: 'Definir', hint: 'Perder grasa conservando el músculo: un 15 % menos y la proteína más alta.', adjust: -0.15, proteinPerKg: 1.9, fatShare: 0.25 },
  maintain: { label: 'Mantener peso', hint: 'Comer lo que gastas.', adjust: 0, proteinPerKg: 1.4, fatShare: 0.3 },
  muscle: { label: 'Ganar masa muscular', hint: 'Un 10 % más de calorías y bastante proteína.', adjust: 0.1, proteinPerKg: 1.7, fatShare: 0.27 },
  gain: { label: 'Ganar peso', hint: 'Un 15 % más de calorías.', adjust: 0.15, proteinPerKg: 1.4, fatShare: 0.28 },
};

export const HEALTH_GOAL_IDS = Object.keys(HEALTH_GOALS) as HealthGoal[];

export const isHealthGoal = (value: unknown): value is HealthGoal => typeof value === 'string' && Object.hasOwn(HEALTH_GOALS, value);

/**
 * Nivel de actividad con el que se pasa del metabolismo basal a las calorías de mantenimiento: 1,4 es una vida «ligeramente
 * activa» (trabajo de pie o paseos diarios). Es fijo a propósito: si siguiera a los pasos del día, la meta se movería mientras se
 * come y una barra de «cuánto me falta» no tendría sentido.
 */
export const ACTIVITY_LEVEL = 1.4;

export interface NutritionTargets {
  /** Calorías de mantenimiento: lo que se estima que gasta la persona en un día normal. */
  maintenanceKcal: number;
  /** Calorías que se proponen al día según el objetivo. */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Lo máximo de sal que se propone al día (g): el tope de la OMS, el mismo para todos. */
  saltG: number;
}

/** IMC desde el que el exceso de peso se cuenta solo en parte para la proteína (por encima de 30 es obesidad). */
const PROTEIN_BMI_LIMIT = 30;
/** Parte del peso que pasa de ese IMC que se cuenta (el exceso es sobre todo grasa, y la grasa no necesita proteína; la masa magra es ~1/4 del exceso). */
const PROTEIN_EXCESS_SHARE = 0.25;

/**
 * El peso sobre el que se calcula la proteína. Hasta un IMC de 30 es el peso entero. Por encima, lo que pasa de ese IMC cuenta
 * un cuarto: con 118 kg a 1,62 m, «1,8 g por kilo» de peso total serían 212 g al día (el 40 % de una dieta de 2000 kcal), una cifra
 * de deportista de fuerza que una persona con obesidad no necesita ni suele poder cumplir. Es continuo: no da un salto al cruzar el IMC 30.
 */
export function proteinReferenceKg(profile: Pick<ProfileEntry, 'heightCm' | 'weightKg'>): number {
  const meters = profile.heightCm / 100;
  const limitKg = PROTEIN_BMI_LIMIT * meters * meters;
  return profile.weightKg <= limitKg ? profile.weightKg : limitKg + PROTEIN_EXCESS_SHARE * (profile.weightKg - limitKg);
}

/**
 * Máximo de sal al día en gramos: la OMS recomienda menos de 5 g (2 g de sodio) para los adultos; la AESAN y la sociedad española de hipertensión dicen lo mismo. Es un
 * LÍMITE, no una meta: a diferencia de los nutrientes, no se «llega» a ella.
 */
export const SALT_LIMIT_G = 5;

/** Suelo de calorías al día: por debajo no se propone nada, sea cual sea el objetivo. */
const KCAL_FLOOR = { male: 1500, female: 1200 } as const;

/** Tope de la proteína (parte de las calorías) y mínimo de grasas (g por kilo de peso de referencia). */
const PROTEIN_MAX_SHARE = 0.3;
const FAT_MIN_PER_KG = 0.7;

/** Con qué se calculan las metas: lo que cambia de una persona a otra más allá del perfil. */
export interface TargetOptions {
  /**
   * Las calorías de mantenimiento medidas de esta persona (`adaptiveMaintenance`). Sin ellas se usa la fórmula: metabolismo basal × `ACTIVITY_LEVEL`.
   */
  maintenanceKcal?: number;
}

type TargetProfile = Pick<ProfileEntry, 'heightCm' | 'weightKg' | 'sex' | 'birthDate'>;

function targetsFrom(profile: TargetProfile, bmr: number, maintenance: number, goal: HealthGoal): NutritionTargets {
  const rule = HEALTH_GOALS[goal];
  const floor = Math.max(bmr, KCAL_FLOOR[profile.sex]);
  const kcal = Math.round(Math.max(floor, maintenance * (1 + rule.adjust)) / 10) * 10;
  // La proteína no pasa del 30 % de las calorías (con mucho peso y pocas calorías, 2 g/kg se comería casi toda la dieta y nadie lo cumpliría).
  const referenceKg = proteinReferenceKg(profile);
  const proteinG = Math.round(Math.min(referenceKg * rule.proteinPerKg, (kcal * PROTEIN_MAX_SHARE) / 4));
  // Las grasas son una parte de las calorías, pero nunca menos de 0,7 g por kilo (salud hormonal): en días de pocas calorías mandaría el mínimo.
  const fatG = Math.round(Math.max((kcal * rule.fatShare) / 9, referenceKg * FAT_MIN_PER_KG));
  const carbsG = Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));
  return { maintenanceKcal: Math.round(maintenance / 10) * 10, kcal, proteinG, carbsG, fatG, saltG: SALT_LIMIT_G };
}

/**
 * Las metas de un día: calorías de mantenimiento (las medidas de la persona si se conocen; si no, Mifflin-St Jeor × nivel de actividad)
 * corregidas por el objetivo, con la proteína por kilo de peso (ver `proteinReferenceKg`), las grasas como parte de las calorías y los hidratos
 * con lo que sobra. Nunca por debajo del metabolismo basal ni del suelo de calorías de su sexo (para no proponer una dieta peligrosa a una
 * persona pequeña).  El ejercicio del día no la mueve: el mantenimiento ya lleva la actividad de un día normal.
 */
export function nutritionTargets(profile: TargetProfile, day: DayKey, goal: HealthGoal, options: TargetOptions = {}): NutritionTargets {
  const bmr = bmrKcalPerDay(profile, day);
  return targetsFrom(profile, bmr, options.maintenanceKcal ?? bmr * ACTIVITY_LEVEL, goal);
}

/** Lo ingerido frente a su meta, de 0 a 1 (más de la meta se queda en 1: la barra no se sale). */
export const fractionOf = (value: number, target: number): number => (target > 0 ? clamp(value / target, 0, 1) : 0);

// ───────────────────────────── productos envasados ─────────────────────────────

export interface FoodProduct {
  barcode: string;
  name: string;
  per100g: Per100g;
  /** Gramos de una ración si la etiqueta la indica. */
  servingG: number | null;
  /** Lo enseñó la persona con su etiqueta (no sale de la base de la app): se puede corregir u olvidar. */
  own?: boolean;
}

/** Las cifras de `grams` gramos de un producto (por regla de tres sobre sus 100 g). */
export function scaleProduct(per100g: Per100g, grams: number): Pick<MealDraft, 'kcal' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarsG' | 'saltG'> {
  const factor = grams / 100;
  return {
    kcal: Math.round(per100g.kcal * factor),
    proteinG: roundTo(per100g.proteinG * factor, 1),
    carbsG: roundTo(per100g.carbsG * factor, 1),
    fatG: roundTo(per100g.fatG * factor, 1),
    fiberG: per100g.fiberG === undefined ? null : roundTo(per100g.fiberG * factor, 1),
    sugarsG: per100g.sugarsG === undefined ? null : roundTo(per100g.sugarsG * factor, 1),
    saltG: per100g.saltG === undefined ? null : roundTo(per100g.saltG * factor, 2),
  };
}
