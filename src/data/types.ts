import type { SavedRing } from '../ble/transport';
import type { BacktestSummary } from '../domain/sleep-estimate';
import type { SavedScale } from '../domain/scale';
import type { ProfileEntry } from '../domain/profile';
import type { RawRange } from '../domain/summary';
import type { WorkoutDraft, WorkoutRecord } from '../domain/workout';
import type { DayKey } from '../domain/dates';
import type { IngestRows } from '../domain/sanitize';
import type { WaterEntry } from '../domain/hydration';
import type { SavedDish } from '../domain/dishes';
import type { UserProduct } from '../domain/user-products';
import type { SocialProfile } from '../domain/social-profile';
import { DEFAULT_JOINT_METRICS, type JointMetricId } from '../domain/joint-metrics';
import { DEFAULT_NUTRITION_PANEL, type PanelIndicatorId } from '../domain/nutrition-panel';
import { DEFAULT_HEALTH_GOAL, type HealthGoal, type MealEntry } from '../domain/nutrition';

export interface Settings {
  /** Objetivo diario de pasos. */
  stepGoal: number;
  /** Objetivo de sueño (horas). */
  sleepGoalH: number;
  /** Cada cuántos minutos mide el anillo la FC por su cuenta (mínimo 30; menos = más batería gastada en el anillo). */
  heartIntervalMin: number;
  spo2IntervalMin: number;
  /** Cuándo se exportó por última vez una copia de seguridad (`null`: nunca). Sirve para recordarlo. */
  lastBackupMs: number | null;
  /**
   * Con la app a la vista, traer sola los datos del anillo (los pasos cada minuto y el historial cada diez). Con `false`, solo
   * se sincroniza al pulsar el botón.
   */
  autoSync: boolean;
  /** Qué busca la persona con lo que come: decide las calorías y los nutrientes que se le proponen (ver `nutritionTargets`). */
  healthGoal: HealthGoal;
  /**
   * El peso al que quiere llegar (kg; `null`: sin peso objetivo). Complementa al objetivo de salud: este dice cómo come, aquel hasta dónde (ver
   * `weightGoalPlan`). No cambia las calorías por sí mismo: avisa si el objetivo de salud no lleva hasta ese peso.
   */
  targetWeightKg: number | null;
  /** Los datos que enseña el gráfico conjunto de Salud, en el orden en que los eligió la persona (puede ser cualquier cantidad, también ninguno). */
  jointMetrics: JointMetricId[];
  /** Los indicadores del panel de Nutrición del Resumen, en el orden elegido (de 0 a 8: dos filas de cuatro). */
  nutritionPanel: PanelIndicatorId[];
  /**
   * Ofrecer ideas para comer mejor cuando una comida se valora como poco adecuada y se repite en la semana (ver `domain/recipes.ts`). Con `false`, la hoja de detalles de una comida
   * no avisa de nada.
   */
  mealSuggestions: boolean;
  /**
   * Qué dispositivos tiene la persona (menú de dispositivos de la barra superior). Sin anillo, la app no intenta conectarse a él, sus datos (pulso, sueño y oxígeno) salen
   * «no disponibles» y de los entrenamientos solo queda andar, medido con el móvil. Sin báscula, «Pesar con la báscula» no se puede usar. Apagar uno NO borra nada: los datos que ya
   * se guardaron siguen y vuelven a verse al encenderlo.
   */
  hasRing: boolean;
  hasScale: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  stepGoal: 8000,
  sleepGoalH: 8,
  heartIntervalMin: 60,
  spo2IntervalMin: 60,
  lastBackupMs: null,
  autoSync: true,
  healthGoal: DEFAULT_HEALTH_GOAL,
  targetWeightKg: null,
  jointMetrics: [...DEFAULT_JOINT_METRICS],
  nutritionPanel: [...DEFAULT_NUTRITION_PANEL],
  mealSuggestions: true,
  hasRing: true,
  hasScale: true,
};

export interface SyncOutcomeRecord {
  type: string;
  status: string;
  bytes: number;
  ms: number;
  detail?: string;
}

export interface RowCounts {
  buckets: number;
  counters: number;
  heart: number;
  spo2: number;
  sleep: number;
}

/** Resumen de una sincronización, para el historial y para poder diagnosticar sin tener el anillo. */
export interface SyncRecord {
  tsMs: number;
  ringName: string;
  firmware: string | null;
  batteryPercent: number | null;
  durationMs: number;
  interrupted: boolean;
  /** Mensaje de error si la sincronización falló. */
  error?: string;
  outcomes: SyncOutcomeRecord[];
  /** Filas NUEVAS añadidas (las que ya existían se actualizan sin contarse). */
  added: RowCounts;
  dropped: Record<string, number>;
  liveSteps: number | null;
  /**
   * Funciones que el anillo ofrecía tras esa sincronización (`steps`, `heartRate`…): las que declara más las básicas
   * de la familia, menos las que rechazó al pedírselas (0xFB/0xFC). Ausente: sincronización anterior a que se guardara.
   * De aquí sale qué deportes y datos ofrece la pestaña Deportes.
   */
  capabilities?: string[] | null;
  /** Traza BLE en texto; solo se conserva en las últimas sincronizaciones. */
  log?: string;
}

export interface IngestResult {
  added: RowCounts;
  updated: RowCounts;
}

export interface StoreStats {
  counts: Record<string, number>;
  firstDataMs: number | null;
}

/** Cuándo se tomó lo último que hay guardado de cada tipo (`null`: de ese tipo no hay nada). */
export interface LatestData {
  heartMs: number | null;
  spo2Ms: number | null;
  /** Pasos y calorías: hasta cuándo contó el anillo, sea por franja (donde acaba la última) o por el contador del día. */
  activityMs: number | null;
  /** Cuándo terminó la última sesión de sueño guardada (una siesta también cuenta). */
  sleepEndMs: number | null;
}

export interface BackupFile {
  format: 'smartring-backup';
  version: 1;
  exportedAt: string;
  data: {
    profile: ProfileEntry[];
    settings: Settings;
    workouts: WorkoutRecord[];
    buckets: unknown[];
    counters: unknown[];
    heart: unknown[];
    spo2: unknown[];
    sleep: unknown[];
    syncs: SyncRecord[];
    /** Comidas anotadas. Las copias anteriores a la alimentación no lo traen. */
    meals?: MealEntry[];
    /** Tomas de agua anotadas. Las copias anteriores a la hidratación no lo traen. */
    water?: WaterEntry[];
    /** Platos guardados. Las copias anteriores a los platos no lo traen. */
    dishes?: SavedDish[];
    /** Productos que la persona enseñó con su etiqueta («Mis productos»). Las copias anteriores no lo traen. */
    products?: UserProduct[];
    /** El perfil de cara a los demás (identificador, nombre de usuario, estado y foto). Las copias anteriores no lo traen. */
    social?: SocialProfile;
  };
}

/** Contrato del almacén. La UI y la sincronización dependen de esto, no de IndexedDB. */
export interface Store {
  // Datos del anillo
  ingest(rows: IngestRows): Promise<IngestResult>;
  /** Todo lo necesario para resumir los días `from`..`to` (con margen para lo que cruza medianoche). */
  loadRange(from: DayKey, to: DayKey): Promise<RawRange>;
  /**
   * Lo mismo para un intervalo cualquiera `[start, end)` (en ms): el día del Resumen empieza a las 08:00 y cruza la medianoche. Los
   * entrenos que empezaron antes de `start` y siguen dentro vienen en `carryWorkouts`.
   */
  loadWindow(start: number, end: number): Promise<RawRange>;
  /**
   * Cuánto se equivoca la estimación del sueño CON LOS DATOS DE ESTA PERSONA: en cada noche que guardó el anillo o que ella corrigió a mano (de los últimos `days` días), qué
   * habría estimado la app sin saberla (ver `backtestEstimate`). `null` si no hay ninguna noche con la que comparar.
   */
  sleepAccuracy(nowMs: number, days?: number): Promise<BacktestSummary | null>;
  stats(): Promise<StoreStats>;
  /** Lo más reciente de cada tipo de dato: sirve para ver si el anillo está midiendo. */
  latestData(): Promise<LatestData>;

  // Perfil con vigencia por fecha
  getProfileHistory(): Promise<ProfileEntry[]>;
  putProfileEntry(entry: ProfileEntry): Promise<void>;

  /**
   * Guarda de una vez perfil, entrenos, comidas y agua EN UNA SOLA TRANSACCIÓN (lo mismo que llamar a `putProfileEntry`, `putWorkout`, `putMeal` y `putWater` por cada uno, pero sin una transacción
   * —y su escritura a disco— por registro). Sirve para sembrar muchos datos juntos (los de ejemplo): cientos de transacciones seguidas tardan decenas de segundos en un móvil.
   */
  putMany(rows: { profile?: readonly ProfileEntry[]; workouts?: readonly WorkoutRecord[]; meals?: readonly MealEntry[]; water?: readonly WaterEntry[] }): Promise<void>;

  // Entrenamientos
  /**
   * Borrador del entrenamiento en curso (o terminado pero aún sin revisar), guardado cada poco por si la app se cierra
   * antes de terminarlo: así se puede recuperar. `null` lo borra.
   */
  getWorkoutDraft(): Promise<WorkoutDraft | null>;
  setWorkoutDraft(record: WorkoutDraft | null): Promise<void>;
  putWorkout(workout: WorkoutRecord): Promise<void>;
  deleteWorkout(id: string): Promise<void>;
  getWorkout(id: string): Promise<WorkoutRecord | null>;
  listWorkouts(fromMs: number, toMs: number): Promise<WorkoutRecord[]>;
  recentWorkouts(limit: number): Promise<WorkoutRecord[]>;

  // Comidas
  putMeal(meal: MealEntry): Promise<void>;
  /** Borra una comida (hace falta su hora para saber en qué día está). */
  deleteMeal(meal: Pick<MealEntry, 'id' | 'tsMs'>): Promise<void>;
  /** Las comidas con `fromMs <= tsMs < toMs`, de la más antigua a la más reciente. */
  listMeals(fromMs: number, toMs: number): Promise<MealEntry[]>;
  /** Las comidas que CUENTAN para los días `fromDay`..`toDay` (con su día guardado si la pasaron de un día a otro: ver `day-credit.ts`), de la más antigua a la más reciente. */
  listMealsByDay(fromDay: DayKey, toDay: DayKey): Promise<MealEntry[]>;

  // Agua
  putWater(entry: WaterEntry): Promise<void>;
  deleteWater(entry: Pick<WaterEntry, 'id' | 'tsMs'>): Promise<void>;
  /** Las tomas con `fromMs <= tsMs < toMs`, de la más antigua a la más reciente. */
  listWater(fromMs: number, toMs: number): Promise<WaterEntry[]>;

  // Platos guardados
  /** Guarda un plato (o lo sustituye si ya había uno con ese `id`). */
  putDish(dish: SavedDish): Promise<void>;
  deleteDish(id: string): Promise<void>;
  /** Todos los platos guardados, el último que se anotó primero. */
  listDishes(): Promise<SavedDish[]>;

  // Mis productos (los que la persona enseña con lo que pone la etiqueta, por su código de barras)
  /** Guarda un producto (o lo sustituye si ya había uno con ese código). */
  putProduct(product: UserProduct): Promise<void>;
  deleteProduct(barcode: string): Promise<void>;
  /** El producto con ese código, o `null` (un UPC-A y su EAN-13 con un cero delante son el mismo). */
  getProduct(barcode: string): Promise<UserProduct | null>;
  /** Todos, el último que se enseñó o corrigió primero. */
  listProducts(): Promise<UserProduct[]>;

  // El perfil social (identidad, nombre de usuario, estado y foto): ver `domain/social-profile.ts`
  getSocial(): Promise<SocialProfile | null>;
  setSocial(profile: SocialProfile): Promise<void>;

  // Ajustes y anillo vinculado
  getSettings(): Promise<Settings>;
  setSettings(partial: Partial<Settings>): Promise<Settings>;
  getRing(): Promise<SavedRing | null>;
  setRing(ring: SavedRing | null): Promise<void>;
  /** La báscula de cocina emparejada y lo que se aprendió de su protocolo (no va en la copia de seguridad: se vuelve a emparejar). */
  getScale(): Promise<SavedScale | null>;
  setScale(scale: SavedScale | null): Promise<void>;

  // Sincronizaciones
  addSync(record: SyncRecord): Promise<void>;
  listSyncs(limit: number): Promise<SyncRecord[]>;
  lastSuccessfulSync(): Promise<SyncRecord | null>;

  // Copia de seguridad y borrado
  exportAll(): Promise<BackupFile>;
  importAll(file: unknown, mode: 'merge' | 'replace'): Promise<{ imported: Record<string, number> }>;
  wipe(): Promise<void>;
}
