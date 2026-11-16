import { validCreditDay } from '../domain/day-credit';
import { dayKeyOf, isValidDayKey } from '../domain/dates';
import { ageAt, type ProfileEntry } from '../domain/profile';
import type { CounterSample, HeartSample, SleepSessionRecord, Spo2Sample, StepBucket } from '../domain/types';
import { MAX_DISH_INGREDIENTS, MAX_DISH_NAME, MAX_INGREDIENT_G, isPhoto, withoutServings, type DishIngredient, type SavedDish } from '../domain/dishes';
import { isBarcode } from '../domain/food-label';
import { MAX_PRODUCT_NAME, MAX_SERVING_G, MAX_USER_PRODUCTS, type UserProduct } from '../domain/user-products';
import { MAX_WATER_ML, MIN_WATER_ML, type WaterEntry } from '../domain/hydration';
import { isValidRoute } from '../domain/route-trace';
import { isSportId } from '../domain/sports';
import { cleanSocialProfile, isSocialProfile, type SocialProfile } from '../domain/social-profile';
import { isHealthGoal, MAX_MEAL_ITEMS, MAX_MEAL_KCAL, MAX_MEAL_NAME, MAX_MEAL_NUTRIENT_G, MEAL_SOURCES, type MealEntry } from '../domain/nutrition';
import { isPanelIndicatorId, MAX_PANEL_INDICATORS } from '../domain/nutrition-panel';
import { isJointMetricId, JOINT_METRICS, RETIRED_JOINT_METRICS, sanitizeJointMetrics } from '../domain/joint-metrics';
import { isTargetWeight } from '../domain/weight-goal';
import type { WorkoutRecord } from '../domain/workout';
import type { RowCounts, Settings, SyncRecord } from './types';

export interface ParsedBackup {
  profile: ProfileEntry[];
  /** Ajustes de la copia (solo los que traía, ya validados). */
  settings: Partial<Settings>;
  /** `true` si la copia traía el apartado de ajustes. */
  hasSettings: boolean;
  workouts: WorkoutRecord[];
  /** Comidas anotadas (las copias anteriores a la alimentación no traen ninguna). */
  meals: MealEntry[];
  /** Tomas de agua (las copias anteriores a la hidratación no traen ninguna). */
  water: WaterEntry[];
  /** Platos guardados (las copias anteriores a los platos no traen ninguno). */
  dishes: SavedDish[];
  /** Productos que la persona enseñó con su etiqueta (las copias anteriores no traen ninguno). */
  products: UserProduct[];
  /** El perfil social de la copia (las copias anteriores no lo traen: `null`). */
  social: SocialProfile | null;
  buckets: StepBucket[];
  counters: CounterSample[];
  heart: HeartSample[];
  spo2: Spo2Sample[];
  sleep: SleepSessionRecord[];
  syncs: SyncRecord[];
  /** Apartados de datos que el archivo traía como listas. */
  sections: string[];
  /** Registros con una fecha imposible (antes del año 2000, de dentro de más de dos días, o un tramo de semanas): se dejan fuera. */
  skipped: number;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const between = (value: unknown, min: number, max: number): value is number => num(value) && value >= min && value <= max;
const str = (value: unknown, maxLength: number): value is string => typeof value === 'string' && value.length <= maxLength;

/** Una copia con más bytes que esto no es una copia de SmartHealth: un año entero con el anillo ocupa unos pocos MB. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

const DAY_MS = 86_400_000;
/**
 * Las fechas de una copia caen entre el año 2000 (el origen del reloj del anillo) y dentro de dos días: fuera de ahí (un `1e300`,
 * el año 3000, 1970 de un móvil con el reloj roto) no hay dato real, y desbordaría los cálculos con fechas. Un registro así se
 * DEJA FUERA y se cuenta (`skipped`) en vez de rechazar la copia entera: una copia que la propia app exportó tiene que poder
 * restaurarse aunque guarde un dato suelto de cuando el reloj iba mal.
 */
const MIN_TS = Date.UTC(2000, 0, 1);
const tsOk = (value: unknown): value is number => num(value) && value >= MIN_TS && value <= Date.now() + 2 * DAY_MS;
/** Un tramo (de actividad, sueño, entreno…) que empieza y acaba en fechas válidas y dura como mucho `maxMs`. */
const spanOk = (startMs: unknown, endMs: unknown, maxMs: number): boolean => tsOk(startMs) && tsOk(endMs) && endMs >= startMs && endMs - startMs <= maxMs;

/** Lo máximo que se admite de cada apartado: con esto una copia estropeada o hostil no puede agotar la memoria del móvil. */
const MAX_RECORDS = { profile: 5_000, workouts: 50_000, meals: 100_000, water: 200_000, dishes: 2_000, products: MAX_USER_PRODUCTS, buckets: 600_000, counters: 600_000, heart: 600_000, spo2: 600_000, sleep: 50_000, syncs: 5_000 } as const;

/**
 * Valida cada registro y entrega una COPIA reconstruida solo con los campos conocidos: lo que la copia traiga de más (campos
 * sueltos, objetos enormes) nunca llega al almacén, y lo que se guarda tiene exactamente la forma que espera la app.
 */
function list<T, R>(
  value: unknown,
  name: string,
  max: number,
  valid: (item: unknown) => item is T,
  plausible: (item: T) => boolean,
  clean: (item: T) => R,
  skipped: { count: number },
): R[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BackupError(`El apartado "${name}" de la copia no es una lista.`);
  if (value.length > max) throw new BackupError(`El apartado "${name}" de la copia trae demasiados registros (${value.length}).`);
  const out: R[] = [];
  for (const [index, item] of value.entries()) {
    // Estructura o valores imposibles (una altura de −50 cm, un pulso de 0): la copia está estropeada y se rechaza entera.
    if (!valid(item)) throw new BackupError(`El apartado "${name}" contiene un registro no válido (posición ${index + 1}).`);
    // Con la estructura bien pero una fecha imposible, solo ese registro se deja fuera.
    if (!plausible(item)) {
      skipped.count++;
      continue;
    }
    out.push(clean(item));
  }
  return out;
}

// Los rangos son los mismos que impone la app al escribir un dato a mano o al recibirlo del anillo (ver `profile.ts` y
// `sanitize.ts`), algo más holgados: una copia con una altura de −50 cm o un contador de 10⁹ pasos está estropeada, y
// meterla en el almacén contaminaría para siempre los cálculos de todos los días.
const isProfile = (v: unknown): v is ProfileEntry =>
  isRecord(v) &&
  typeof v.date === 'string' &&
  isValidDayKey(v.date) &&
  between(v.heightCm, 80, 260) &&
  between(v.weightKg, 15, 400) &&
  (v.sex === 'male' || v.sex === 'female') &&
  typeof v.birthDate === 'string' &&
  isValidDayKey(v.birthDate) &&
  (v.strideCm === undefined || between(v.strideCm, 20, 200)) &&
  (v.strideOnly === undefined || typeof v.strideOnly === 'boolean') &&
  (v.strideAuto === undefined || typeof v.strideAuto === 'boolean');
/**
 * La vigencia del perfil cae entre el año 2000 y dentro de dos días, y la persona tiene entre 5 y 110 años (la edad, como al
 * escribirlo a mano: ver `validateProfileEntry`). Una entrada que no cumple se deja fuera: con una fecha de nacimiento de 1700 todo
 * cálculo con el pulso máximo sale mal en silencio, y una vigencia del año 100 estiraría el periodo «Todo» a 700 000 días.
 */
const plausibleProfile = (v: ProfileEntry): boolean => {
  const today = dayKeyOf(Date.now());
  const age = ageAt(v.birthDate, today);
  return v.date >= '2000-01-01' && v.date <= dayKeyOf(Date.now() + 2 * DAY_MS) && v.birthDate < today && age >= 5 && age <= 110;
};
const cleanProfile = (v: ProfileEntry): ProfileEntry => ({
  date: v.date,
  heightCm: v.heightCm,
  weightKg: v.weightKg,
  sex: v.sex,
  birthDate: v.birthDate,
  ...(v.strideCm !== undefined ? { strideCm: v.strideCm } : {}),
  ...(v.strideOnly !== undefined ? { strideOnly: v.strideOnly } : {}),
  ...(v.strideAuto !== undefined ? { strideAuto: v.strideAuto } : {}),
});

const isWorkout = (v: unknown): v is WorkoutRecord =>
  isRecord(v) &&
  str(v.id, 64) &&
  v.id.length > 0 &&
  typeof v.sport === 'string' &&
  isSportId(v.sport) &&
  num(v.startMs) &&
  num(v.endMs) &&
  v.endMs >= v.startMs &&
  between(v.pausedMs, 0, Number.MAX_SAFE_INTEGER) &&
  (v.source === undefined || v.source === 'live' || v.source === 'manual') &&
  (v.distanceSource === undefined || v.distanceSource === 'gps' || v.distanceSource === 'manual') &&
  (v.steps === undefined || between(v.steps, 0, 200_000)) &&
  (v.distanceM === undefined || between(v.distanceM, 0, 2_000_000)) &&
  (v.ascentM === undefined || between(v.ascentM, 0, 20_000)) &&
  (v.kcalManual === undefined || between(v.kcalManual, 0, 50_000)) &&
  (v.note === undefined || str(v.note, 2_000)) &&
  (v.splitsM === undefined || (Array.isArray(v.splitsM) && v.splitsM.length <= 1440 && v.splitsM.every((m) => between(m, -1, 20_000)))) &&
  (v.route === undefined || isValidRoute(v.route)) &&
  (v.hr === undefined || (Array.isArray(v.hr) && v.hr.length <= 50_000 && v.hr.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && between(p[1], 20, 260))));
const plausibleWorkout = (v: WorkoutRecord): boolean => spanOk(v.startMs, v.endMs, 14 * DAY_MS) && v.pausedMs <= v.endMs - v.startMs;
const cleanWorkout = (v: WorkoutRecord): WorkoutRecord => ({
  id: v.id,
  sport: v.sport,
  startMs: v.startMs,
  endMs: v.endMs,
  pausedMs: v.pausedMs,
  // Las copias antiguas no lo traían: un entreno sin origen se tiene por añadido a mano.
  source: v.source === 'live' ? 'live' : 'manual',
  ...(v.steps !== undefined ? { steps: v.steps } : {}),
  ...(v.distanceM !== undefined ? { distanceM: v.distanceM } : {}),
  ...(v.distanceSource !== undefined ? { distanceSource: v.distanceSource } : {}),
  ...(v.splitsM !== undefined ? { splitsM: [...v.splitsM] } : {}),
  ...(v.route !== undefined && v.route.length > 0 ? { route: v.route.map((p): [number, number] => [p[0], p[1]]) } : {}),
  ...(v.ascentM !== undefined ? { ascentM: v.ascentM } : {}),
  ...(v.kcalManual !== undefined ? { kcalManual: v.kcalManual } : {}),
  // Las muestras de pulso de fuera del entreno (un día de margen) no son de él: se descartan.
  ...(v.hr !== undefined ? { hr: v.hr.filter(([t]) => t >= v.startMs - DAY_MS && t <= v.endMs + DAY_MS).map(([t, bpm]): [number, number] => [t, bpm]) } : {}),
  ...(v.note !== undefined ? { note: v.note } : {}),
});

const isMeal = (v: unknown): v is MealEntry =>
  isRecord(v) &&
  str(v.id, 64) &&
  v.id.length > 0 &&
  num(v.tsMs) &&
  str(v.name, MAX_MEAL_NAME) &&
  between(v.kcal, 0, MAX_MEAL_KCAL) &&
  (v.proteinG === undefined || between(v.proteinG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.carbsG === undefined || between(v.carbsG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.fatG === undefined || between(v.fatG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.fiberG === undefined || between(v.fiberG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.sugarsG === undefined || between(v.sugarsG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.saltG === undefined || between(v.saltG, 0, MAX_MEAL_NUTRIENT_G)) &&
  typeof v.source === 'string' &&
  (MEAL_SOURCES as readonly string[]).includes(v.source) &&
  (v.barcode === undefined || (typeof v.barcode === 'string' && /^\d{8,14}$/.test(v.barcode))) &&
  (v.grams === undefined || between(v.grams, 0, 100_000)) &&
  (v.dishId === undefined || (typeof v.dishId === 'string' && v.dishId.length > 0 && v.dishId.length <= 64)) &&
  (v.day === undefined || typeof v.day === 'string') &&
  (v.items === undefined || (Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= MAX_MEAL_ITEMS && v.items.every(isIngredient)));
const plausibleMeal = (v: MealEntry): boolean => tsOk(v.tsMs);
const cleanMeal = (v: MealEntry): MealEntry => ({
  id: v.id,
  tsMs: v.tsMs,
  name: v.name,
  kcal: v.kcal,
  ...(v.proteinG !== undefined ? { proteinG: v.proteinG } : {}),
  ...(v.carbsG !== undefined ? { carbsG: v.carbsG } : {}),
  ...(v.fatG !== undefined ? { fatG: v.fatG } : {}),
  ...(v.fiberG !== undefined ? { fiberG: v.fiberG } : {}),
  ...(v.sugarsG !== undefined ? { sugarsG: v.sugarsG } : {}),
  ...(v.saltG !== undefined ? { saltG: v.saltG } : {}),
  source: v.source,
  ...(v.barcode !== undefined ? { barcode: v.barcode } : {}),
  ...(v.grams !== undefined ? { grams: v.grams } : {}),
  ...(v.dishId !== undefined ? { dishId: v.dishId } : {}),
  ...(validCreditDay(dayKeyOf(v.tsMs), v.day) !== undefined ? { day: validCreditDay(dayKeyOf(v.tsMs), v.day) } : {}),
  ...(v.items !== undefined ? { items: v.items.map(cleanIngredient) } : {}),
});

const isWater = (v: unknown): v is WaterEntry =>
  isRecord(v) && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 80 && num(v.tsMs) && between(v.ml, MIN_WATER_ML, MAX_WATER_ML);
const plausibleWater = (v: WaterEntry): boolean => tsOk(v.tsMs);
const cleanWater = (v: WaterEntry): WaterEntry => ({ id: v.id, tsMs: v.tsMs, ml: Math.round(v.ml) });

/** Hasta cuántas raciones admitía un plato la versión con raciones (para leer sus copias). */
const LEGACY_MAX_SERVINGS = 100;

const isIngredient = (v: unknown): v is DishIngredient =>
  isRecord(v) &&
  str(v.name, MAX_MEAL_NAME) &&
  between(v.kcal, 0, MAX_MEAL_KCAL) &&
  (v.proteinG === undefined || between(v.proteinG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.carbsG === undefined || between(v.carbsG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.fatG === undefined || between(v.fatG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.fiberG === undefined || between(v.fiberG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.sugarsG === undefined || between(v.sugarsG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.saltG === undefined || between(v.saltG, 0, MAX_MEAL_NUTRIENT_G)) &&
  (v.grams === undefined || between(v.grams, 0, Math.max(100_000, MAX_INGREDIENT_G))) &&
  (v.barcode === undefined || (typeof v.barcode === 'string' && /^\d{8,14}$/.test(v.barcode)));
const cleanIngredient = (v: DishIngredient): DishIngredient => ({
  name: v.name,
  kcal: v.kcal,
  ...(v.proteinG !== undefined ? { proteinG: v.proteinG } : {}),
  ...(v.carbsG !== undefined ? { carbsG: v.carbsG } : {}),
  ...(v.fatG !== undefined ? { fatG: v.fatG } : {}),
  ...(v.fiberG !== undefined ? { fiberG: v.fiberG } : {}),
  ...(v.sugarsG !== undefined ? { sugarsG: v.sugarsG } : {}),
  ...(v.saltG !== undefined ? { saltG: v.saltG } : {}),
  ...(v.grams !== undefined ? { grams: v.grams } : {}),
  ...(v.barcode !== undefined ? { barcode: v.barcode } : {}),
});
/** Un plato guardado: estructura y rangos como al crearlo; una foto que no es un JPEG en texto de tamaño razonable rechaza la copia (no se mete nada raro en un `<img>`). */
const isDishRecord = (v: unknown): v is SavedDish =>
  isRecord(v) &&
  str(v.id, 64) &&
  v.id.length > 0 &&
  str(v.name, MAX_DISH_NAME) &&
  v.name.trim().length > 0 &&
  num(v.createdMs) &&
  num(v.updatedMs) &&
  (v.lastUsedMs === undefined || num(v.lastUsedMs)) &&
  // `servings` es de las copias hechas cuando los platos tenían raciones: se admite y se pasa a una ración al leerlo (`withoutServings`).
  (v.servings === undefined || (Number.isInteger(v.servings) && between(v.servings, 1, LEGACY_MAX_SERVINGS))) &&
  Array.isArray(v.ingredients) &&
  v.ingredients.length >= 1 &&
  v.ingredients.length <= MAX_DISH_INGREDIENTS &&
  v.ingredients.every(isIngredient) &&
  (v.photo === undefined || isPhoto(v.photo));
const plausibleDish = (v: SavedDish): boolean => tsOk(v.createdMs) && tsOk(v.updatedMs) && (v.lastUsedMs === undefined || tsOk(v.lastUsedMs));
const cleanDish = (v: SavedDish & { servings?: number }): SavedDish =>
  withoutServings({
    id: v.id,
    name: v.name,
    createdMs: v.createdMs,
    updatedMs: v.updatedMs,
    ...(v.lastUsedMs !== undefined ? { lastUsedMs: v.lastUsedMs } : {}),
    ...(v.servings !== undefined ? { servings: v.servings } : {}),
    ingredients: v.ingredients.map(cleanIngredient),
    ...(v.photo !== undefined ? { photo: v.photo } : {}),
  });

/** Un producto enseñado con su etiqueta: código de barras con su cifra de control, nombre y cifras por 100 g en rango (las mismas que al crearlo). */
const isProductRecord = (v: unknown): v is UserProduct =>
  isRecord(v) &&
  typeof v.barcode === 'string' &&
  isBarcode(v.barcode) &&
  str(v.name, MAX_PRODUCT_NAME * 2) &&
  v.name.trim().length > 0 &&
  isRecord(v.per100g) &&
  between(v.per100g.kcal, 0, 900) &&
  between(v.per100g.proteinG, 0, 100) &&
  between(v.per100g.carbsG, 0, 100) &&
  between(v.per100g.fatG, 0, 100) &&
  (v.per100g.fiberG === undefined || between(v.per100g.fiberG, 0, 80)) &&
  (v.per100g.sugarsG === undefined || between(v.per100g.sugarsG, 0, 100)) &&
  (v.per100g.saltG === undefined || between(v.per100g.saltG, 0, 50)) &&
  (v.servingG === null || between(v.servingG, 1, MAX_SERVING_G)) &&
  num(v.createdMs) &&
  num(v.updatedMs);
const plausibleProduct = (v: UserProduct): boolean => tsOk(v.createdMs) && tsOk(v.updatedMs);
const cleanProduct = (v: UserProduct): UserProduct => ({
  barcode: v.barcode,
  name: v.name,
  per100g: {
    kcal: v.per100g.kcal,
    proteinG: v.per100g.proteinG,
    carbsG: v.per100g.carbsG,
    fatG: v.per100g.fatG,
    ...(v.per100g.fiberG !== undefined ? { fiberG: v.per100g.fiberG } : {}),
    ...(v.per100g.sugarsG !== undefined ? { sugarsG: v.per100g.sugarsG } : {}),
    ...(v.per100g.saltG !== undefined ? { saltG: v.per100g.saltG } : {}),
  },
  servingG: v.servingG,
  createdMs: v.createdMs,
  updatedMs: v.updatedMs,
});

const isBucket = (v: unknown): v is StepBucket => isRecord(v) && num(v.startMs) && num(v.endMs) && v.endMs >= v.startMs && between(v.steps, 0, 100_000);
const plausibleBucket = (v: StepBucket): boolean => spanOk(v.startMs, v.endMs, DAY_MS);
const cleanBucket = (v: StepBucket): StepBucket => ({
  startMs: v.startMs,
  endMs: v.endMs,
  steps: v.steps,
  // Solo informativos, y las copias antiguas pueden no traerlos.
  ringDistanceM: between(v.ringDistanceM, 0, 10_000_000) ? v.ringDistanceM : 0,
  ringCalories: between(v.ringCalories, 0, 10_000_000) ? v.ringCalories : 0,
});
const isCounter = (v: unknown): v is CounterSample => isRecord(v) && num(v.tsMs) && between(v.steps, 0, 100_000);
const plausibleCounter = (v: CounterSample): boolean => tsOk(v.tsMs);
const cleanCounter = (v: CounterSample): CounterSample => ({ tsMs: v.tsMs, steps: v.steps });
const isHeart = (v: unknown): v is HeartSample =>
  isRecord(v) && num(v.tsMs) && between(v.bpm, 20, 260) && (v.source === 'ring-auto' || v.source === 'ring-spot' || v.source === 'workout');
const plausibleHeart = (v: HeartSample): boolean => tsOk(v.tsMs);
const cleanHeart = (v: HeartSample): HeartSample => ({ tsMs: v.tsMs, bpm: v.bpm, source: v.source });
const isSpo2 = (v: unknown): v is Spo2Sample => isRecord(v) && num(v.tsMs) && between(v.percent, 50, 100);
const plausibleSpo2 = (v: Spo2Sample): boolean => tsOk(v.tsMs);
const cleanSpo2 = (v: Spo2Sample): Spo2Sample => ({ tsMs: v.tsMs, percent: v.percent });
const STAGES = new Set(['deep', 'light', 'rem', 'awake', 'nap']);
const isSleep = (v: unknown): v is SleepSessionRecord =>
  isRecord(v) &&
  num(v.startMs) &&
  num(v.endMs) &&
  v.endMs > v.startMs &&
  Array.isArray(v.segments) &&
  v.segments.length <= 5_000 &&
  v.segments.every((s) => isRecord(s) && num(s.startMs) && between(s.durationSec, 0, 86_400) && typeof s.stage === 'string' && STAGES.has(s.stage));
const plausibleSleep = (v: SleepSessionRecord): boolean => spanOk(v.startMs, v.endMs, DAY_MS) && v.segments.every((s) => tsOk(s.startMs));
const cleanSleep = (v: SleepSessionRecord): SleepSessionRecord => ({
  startMs: v.startMs,
  endMs: v.endMs,
  segments: v.segments.map((s) => ({ stage: s.stage, startMs: s.startMs, durationSec: s.durationSec })),
  ...(v.manual === true ? { manual: true as const } : {}),
});

const isSync = (v: unknown): v is Record<string, unknown> => isRecord(v) && num(v.tsMs) && str(v.ringName, 80);
const plausibleSync = (v: Record<string, unknown>): boolean => tsOk(v.tsMs);
/**
 * Las sincronizaciones pasadas solo sirven de diagnóstico (y para saber qué ofrecía el anillo): se reconstruyen con valores
 * acotados y lo que no cuadra se sustituye por un valor neutro, sin rechazar la copia. Es lo que más se lee al arrancar
 * (`capabilities` se recorre como una lista): un valor raro ahí dejaría la app sin arrancar.
 */
function cleanSync(v: Record<string, unknown>): SyncRecord {
  const count = (x: unknown, max: number): number => (between(x, 0, max) ? x : 0);
  const rows = (x: unknown): RowCounts => {
    const r = isRecord(x) ? x : {};
    return { buckets: count(r.buckets, 1e7), counters: count(r.counters, 1e7), heart: count(r.heart, 1e7), spo2: count(r.spo2, 1e7), sleep: count(r.sleep, 1e7) };
  };
  const outcomes = (Array.isArray(v.outcomes) ? v.outcomes : [])
    .slice(0, 20)
    .filter(isRecord)
    .map((o) => ({
      type: str(o.type, 20) ? o.type : '?',
      status: str(o.status, 20) ? o.status : '?',
      bytes: count(o.bytes, 1e9),
      ms: count(o.ms, 1e9),
      ...(str(o.detail, 200) ? { detail: o.detail } : {}),
    }));
  const dropped = isRecord(v.dropped)
    ? Object.fromEntries(
        Object.entries(v.dropped)
          .filter(([key, n]) => key !== '__proto__' && key.length <= 120 && between(n, 0, 1e9))
          .slice(0, 30),
      )
    : {};
  const capabilities = Array.isArray(v.capabilities) ? v.capabilities.filter((c): c is string => str(c, 40)).slice(0, 32) : v.capabilities === null ? null : undefined;
  return {
    tsMs: v.tsMs as number,
    ringName: v.ringName as string,
    firmware: str(v.firmware, 60) ? v.firmware : null,
    batteryPercent: between(v.batteryPercent, 0, 100) ? v.batteryPercent : null,
    durationMs: count(v.durationMs, 3_600_000),
    interrupted: v.interrupted === true,
    ...(str(v.error, 500) ? { error: v.error } : {}),
    outcomes,
    added: rows(v.added),
    dropped: dropped as Record<string, number>,
    liveSteps: between(v.liveSteps, 0, 100_000) ? v.liveSteps : null,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

/** Ajustes: se valida cada clave presente con el rango que permite la interfaz; una inválida invalida la copia. */
function parseSettings(value: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const check = (key: keyof Settings, ok: (v: unknown) => boolean, label: string): void => {
    const v = value[key];
    if (v === undefined) return;
    if (!ok(v)) throw new BackupError(`El ajuste «${label}» de la copia no es válido.`);
    (out as Record<string, unknown>)[key] = v;
  };
  check('stepGoal', (v) => between(v, 500, 100_000), 'objetivo de pasos');
  check('sleepGoalH', (v) => between(v, 2, 16), 'objetivo de sueño');
  check('heartIntervalMin', (v) => between(v, 30, 720), 'intervalo de pulso');
  check('spo2IntervalMin', (v) => between(v, 30, 720), 'intervalo de oxígeno');
  check('lastBackupMs', (v) => v === null || num(v), 'fecha de la última copia');
  check('autoSync', (v) => typeof v === 'boolean', 'actualización automática');
  check('mealSuggestions', (v) => typeof v === 'boolean', 'ideas para comer mejor');
  check('hasRing', (v) => typeof v === 'boolean', 'tengo anillo');
  check('hasScale', (v) => typeof v === 'boolean', 'tengo báscula');
  check('healthGoal', isHealthGoal, 'objetivo de salud');
  check('targetWeightKg', (v) => v === null || isTargetWeight(v), 'peso objetivo');
  check('jointMetrics', (v) => Array.isArray(v) && v.length <= JOINT_METRICS.length + RETIRED_JOINT_METRICS.size && v.every((id) => isJointMetricId(id) || RETIRED_JOINT_METRICS.has(id as string)) && new Set(v).size === v.length, 'datos del gráfico de Salud');
  check('nutritionPanel', (v) => Array.isArray(v) && v.length <= MAX_PANEL_INDICATORS && v.every(isPanelIndicatorId) && new Set(v).size === v.length, 'indicadores del panel de nutrición');
  // Los datos que el gráfico ya no ofrece (el sueño, el pulso y el oxígeno) se quitan al importar.
  if (out.jointMetrics !== undefined) out.jointMetrics = sanitizeJointMetrics(out.jointMetrics);
  // (Las copias de la versión que tenía «Inicio del día» traen `dayStartHour`: ya no existe, los días empiezan a las 00:00, y se ignora.)
  // Solo sirve para el recordatorio de hacer copias: una fecha imposible (un móvil con el reloj roto, un `1e300`) no rechaza la copia, se ignora.
  if (typeof out.lastBackupMs === 'number' && !tsOk(out.lastBackupMs)) delete out.lastBackupMs;
  return out;
}

const DATA_SECTIONS = ['profile', 'workouts', 'buckets', 'counters', 'heart', 'spo2', 'sleep'] as const;
const SECTION_NAME: Record<(typeof DATA_SECTIONS)[number], string> = {
  profile: 'perfil',
  workouts: 'entrenamientos',
  buckets: 'actividad',
  counters: 'contador de pasos',
  heart: 'frecuencia cardiaca',
  spo2: 'oxígeno en sangre',
  sleep: 'sueño',
};

/** El perfil social de la copia: si viene, tiene que ser válido (una copia con un perfil roto está estropeada); si no viene, no hay. */
function parseSocial(value: unknown): SocialProfile | null {
  if (value === undefined || value === null) return null;
  if (!isSocialProfile(value)) throw new BackupError('El perfil de la copia no es válido.');
  return cleanSocialProfile(value);
}

/** Valida el archivo de copia por completo antes de que se escriba nada. */
export function parseBackup(file: unknown): ParsedBackup {
  if (!isRecord(file) || file.format !== 'smartring-backup') {
    throw new BackupError('Este archivo no es una copia de seguridad de SmartHealth.');
  }
  if (file.version !== 1) throw new BackupError('La versión de esta copia no es compatible con la app.');
  const data = file.data;
  if (!isRecord(data)) throw new BackupError('La copia no contiene datos.');
  const settings = isRecord(data.settings) ? parseSettings(data.settings) : {};
  const skipped = { count: 0 };
  const parsed: ParsedBackup = {
    profile: list(data.profile, 'perfil', MAX_RECORDS.profile, isProfile, plausibleProfile, cleanProfile, skipped),
    settings,
    hasSettings: isRecord(data.settings),
    workouts: list(data.workouts, 'entrenamientos', MAX_RECORDS.workouts, isWorkout, plausibleWorkout, cleanWorkout, skipped),
    meals: list(data.meals, 'comidas', MAX_RECORDS.meals, isMeal, plausibleMeal, cleanMeal, skipped),
    water: list(data.water, 'tomas de agua', MAX_RECORDS.water, isWater, plausibleWater, cleanWater, skipped),
    dishes: list(data.dishes, 'platos', MAX_RECORDS.dishes, isDishRecord, plausibleDish, cleanDish, skipped),
    products: list(data.products, 'productos', MAX_RECORDS.products, isProductRecord, plausibleProduct, cleanProduct, skipped),
    social: parseSocial(data.social),
    buckets: list(data.buckets, 'actividad', MAX_RECORDS.buckets, isBucket, plausibleBucket, cleanBucket, skipped),
    counters: list(data.counters, 'contador de pasos', MAX_RECORDS.counters, isCounter, plausibleCounter, cleanCounter, skipped),
    heart: list(data.heart, 'frecuencia cardiaca', MAX_RECORDS.heart, isHeart, plausibleHeart, cleanHeart, skipped),
    spo2: list(data.spo2, 'oxígeno en sangre', MAX_RECORDS.spo2, isSpo2, plausibleSpo2, cleanSpo2, skipped),
    sleep: list(data.sleep, 'sueño', MAX_RECORDS.sleep, isSleep, plausibleSleep, cleanSleep, skipped),
    syncs: list(data.syncs, 'sincronizaciones', MAX_RECORDS.syncs, isSync, plausibleSync, cleanSync, skipped),
    sections: DATA_SECTIONS.filter((name) => Array.isArray(data[name])),
    skipped: 0,
  };
  parsed.skipped = skipped.count;
  return parsed;
}

/**
 * Reemplazar borra TODO lo que hay: solo se admite una copia completa (con todos los apartados como listas, aunque
 * estén vacías). Un archivo con `data: {}` o al que le falta un apartado no debe poder vaciar el almacén.
 */
export function requireCompleteBackup(parsed: ParsedBackup): void {
  const missing = DATA_SECTIONS.filter((name) => !parsed.sections.includes(name));
  if (missing.length > 0) {
    throw new BackupError(`La copia está incompleta (falta: ${missing.map((name) => SECTION_NAME[name]).join(', ')}): no se puede usar para reemplazar los datos. Puedes combinarla con los actuales.`);
  }
}
