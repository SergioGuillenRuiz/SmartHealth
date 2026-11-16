import type { SocialProfile } from '../domain/social-profile';
import { computed, signal } from '@preact/signals';
import type { SavedRing } from '../ble/transport';
import { DEFAULT_SETTINGS, type Settings, type SyncRecord } from '../data/types';
import { dayOfMs, type DayKey } from '../domain/dates';
import type { SavedDish } from '../domain/dishes';
import type { UserProduct } from '../domain/user-products';
import type { MealEntry } from '../domain/nutrition';
import type { ProfileEntry } from '../domain/profile';
import type { SyncProgress, SyncReport } from '../sync/run-sync';
import type { WorkoutRecord } from '../domain/workout';
import type { SportId } from '../domain/sports';
import type { LiveWorkoutState } from './workout-controller';

// Estado global reactivo (señales). Los DATOS viven en IndexedDB; aquí solo lo que la interfaz necesita
// para pintar al instante y reaccionar: pestaña activa, día seleccionado, anillo vinculado, sincronización.

export type TabIndex = 0 | 1 | 2;

export const activeTab = signal<TabIndex>(0);

/** "Ahora" de la app, refrescado periódicamente para que "hace 5 min" y el día en curso no se queden viejos. */
export const nowMs = signal<number>(Date.now());

/** El día que enseña el Resumen (día de calendario). */
export const selectedDay = signal<DayKey>(dayOfMs(Date.now()));

/** Se incrementa cada vez que cambian los datos guardados; las pantallas recargan al verlo cambiar. */
export const dataVersion = signal(0);
export const bumpData = (): void => {
  dataVersion.value += 1;
};

export const profileHistory = signal<ProfileEntry[]>([]);
export const settings = signal<Settings>(DEFAULT_SETTINGS);

/**
 * El «hoy» del Resumen. El día empieza a la hora de los ajustes (las 08:00 por omisión), así que antes de ella aún es el de ayer:
 * lo que se come o se hace a las 2 de la madrugada se suma al día que empezó antes. Las gráficas de Salud usan días de calendario.
 */
export const todayKey = computed<DayKey>(() => dayOfMs(nowMs.value));
export const ring = signal<SavedRing | null>(null);
export const lastSync = signal<SyncRecord | null>(null);

/** Funciones que declaró el anillo en la última sincronización (`null`: aún no se sabe). */
export const ringCapabilities = computed<ReadonlySet<string> | null>(() => {
  const list: unknown = lastSync.value?.capabilities;
  // Se lee al arrancar, con tres pantallas montadas a la vez: un valor que no sea una lista (de una copia rara ya guardada)
  // no puede tumbar el arranque.
  return Array.isArray(list) ? new Set(list.filter((c): c is string => typeof c === 'string')) : null;
});

export type SyncUi =
  | { status: 'idle' }
  | { status: 'running'; progress: SyncProgress }
  | { status: 'done'; report: SyncReport }
  | { status: 'error'; message: string; code: string };

export const syncUi = signal<SyncUi>({ status: 'idle' });

export type MeasureUi =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'measuring'; live: number | null }
  /** Se canceló y el anillo se está soltando (si aún estaba conectando, hasta que acabe ese intento). */
  | { status: 'cancelling' }
  | { status: 'done'; bpm: number }
  | { status: 'error'; message: string };

export const measureUi = signal<MeasureUi>({ status: 'idle' });
export const measureSheetOpen = signal(false);

/** Entrenamiento en curso (mantiene una conexión viva con el anillo: es el único caso en que se permite). */
export const activeWorkout = signal<{ sport: WorkoutRecord['sport']; startedMs: number } | null>(null);

export const ringSheetOpen = signal(false);

/** Panel del resumen cuyo detalle está abierto en una hoja (`null`: ninguno). */
export type SummaryPanel = 'sleep' | 'heart';
export const summaryPanel = signal<SummaryPanel | null>(null);

/** Menú de la persona (arriba a la izquierda): sus datos, objetivos y copias de seguridad. */
export const userMenuOpen = signal(false);
/** Qué apartado del menú está abierto (encima del menú): `null` si ninguno. */
export type UserSection = 'profile' | 'goals' | 'products' | 'backup';
export const userSection = signal<UserSection | null>(null);

/**
 * Para qué se usa el anillo ahora mismo. Solo puede ser una cosa a la vez: dos sesiones sobre el mismo enlace GATT se
 * cortan entre sí (al cerrar una se desconecta la otra).
 */
export type RingUse = 'sync' | 'measure' | 'workout' | 'test';
export const ringUse = signal<RingUse | null>(null);

const DOING: Record<RingUse, string> = {
  sync: 'Se está sincronizando',
  measure: 'Se está midiendo el pulso',
  workout: 'Hay un entrenamiento en curso',
  test: 'Se está haciendo la prueba guiada',
};
const BEFORE: Record<RingUse, string> = { sync: 'sincronizar', measure: 'medir el pulso', workout: 'empezar un entrenamiento', test: 'empezar la prueba guiada' };

/**
 * Reserva el anillo para un uso sin avisar a nadie si no se puede (lo usa la actualización automática, que no debe sacar
 * avisos de lo que nadie le ha pedido). Devuelve cómo liberarlo, o `null` si ya lo usa otra cosa.
 */
export function tryClaimRing(wanted: RingUse): (() => void) | null {
  if (ringUse.value !== null) return null;
  ringUse.value = wanted;
  return () => {
    if (ringUse.value === wanted) ringUse.value = null;
  };
}

/**
 * Reserva el anillo para un uso. Devuelve cómo liberarlo, o `null` —avisando de por qué— si ya lo usa otra cosa.
 * Quien lo reserva es quien lo libera, y solo cuando ya ha soltado la conexión.
 */
export function claimRing(wanted: RingUse): (() => void) | null {
  const release = tryClaimRing(wanted);
  if (release) return release;
  const current = ringUse.value;
  if (current !== null) {
    // Un entrenamiento o una medida que se cancelan siguen reservando el anillo hasta que lo han soltado: decir «hay un
    // entrenamiento en curso» sería falso. Para sincronizar dos veces seguidas, en cambio, el aviso de siempre es el cierto.
    showToast(
      current === wanted && wanted !== 'sync'
        ? 'El anillo aún se está soltando del intento anterior: espera unos segundos y vuelve a intentarlo.'
        : `${DOING[current]}: espera a que termine antes de ${BEFORE[wanted]}.`,
      'error',
    );
  }
  return null;
}

/**
 * ¿Tiene el anillo la actualización automática? Es una sincronización que la persona no ha pedido: no pinta progreso (una
 * sincronización pedida pone `syncUi` en marcha en el mismo instante en que reserva el anillo).
 */
export const autoHoldsRing = (): boolean => ringUse.value === 'sync' && syncUi.value.status !== 'running';

/**
 * Para qué usa el anillo algo que NO sea `except` y que haya que esperar (`null`: nada). La actualización automática no cuenta: se
 * aparta cuando se le pide (ver `yieldRingToUser`), así que ni los botones de la interfaz ni las comprobaciones deben tratarla
 * como un uso que bloquea.
 */
export function ringUsedByOther(except: RingUse): RingUse | null {
  const current = ringUse.value;
  if (current === null || current === except || autoHoldsRing()) return null;
  return current;
}

/**
 * La actualización automática solo usa el anillo cuando nadie más lo quiere: lo que pide la persona (sincronizar, medir el
 * pulso, entrenar) tiene preferencia y le hace soltarlo antes de reservarlo. Quien arranca la automática registra aquí cómo.
 */
let yieldAuto: (() => Promise<void>) | null = null;
export const setAutoYield = (fn: (() => Promise<void>) | null): void => {
  yieldAuto = fn;
};
export const yieldRingToUser = async (): Promise<void> => {
  await yieldAuto?.();
};

/** Estado en vivo del entrenamiento en curso (`null` si no hay ninguno). */
export const liveWorkout = signal<LiveWorkoutState | null>(null);

/** La última posición del GPS durante un entreno (la usa el navegador por audio); `null` si aún no hay o no hay entreno. */
export interface LiveFix {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMs: number | null;
  /** La hora de la posición según el GPS (solo para medir tiempos entre posiciones). */
  tsMs: number;
  /** Cuándo llegó a la app (reloj de la app): con ella se sabe si la posición está al día. */
  receivedMs: number;
}
export const liveFix = signal<LiveFix | null>(null);
/**
 * Qué deporte se está haciendo (`null` si ninguno). El estado en vivo es un objeto nuevo cada segundo; quien solo necesita
 * saber si hay entreno y cuál es (la pestaña Deportes, que está debajo de la pantalla de seguimiento) lee esto y no se
 * vuelve a pintar cada segundo.
 */
/** El deporte del entrenamiento en curso; un paseo de calibración de la zancada no cuenta (no es un entreno ni abre la pantalla de seguimiento). */
export const liveSport = computed(() => (liveWorkout.value?.purpose === 'stride' ? null : (liveWorkout.value?.sport ?? null)));
/** El paseo de calibración que acaba de terminar, a la espera de medir la zancada (ver `stride-calibration.ts`). */
export const strideWalk = signal<WorkoutRecord | null>(null);
/** Entrenamiento terminado que espera a que el usuario lo revise y lo guarde o lo descarte. */
export const pendingWorkout = signal<WorkoutRecord | null>(null);
/** `true` si el entrenamiento pendiente es un borrador recuperado tras cerrarse la app. */
export const pendingRecovered = signal(false);
/** Por qué se cerró la app a mitad del entreno recuperado, si se sabe (ver `recoveryCause`): el motor web murió. */
export const recoveredCause = signal<string | null>(null);
/** Deporte elegido en el selector (hoja de inicio abierta). */
export const readySport = signal<SportId | null>(null);
export const manualWorkoutOpen = signal(false);

/** Hoja de «He comido algo»: elegir cómo anotarlo (código de barras, a mano o con lenguaje natural) y anotarlo. */
export const mealSheetOpen = signal(false);
/** Los platos guardados (la barra de «He comido algo»), el último que se anotó primero. Se recargan al abrir la hoja y al guardar, usar o borrar uno. */
export const savedDishes = signal<SavedDish[]>([]);
/** Los productos que la persona ha enseñado («Mis productos»), el último que enseñó o corrigió primero. `null` hasta que se leen (al abrir el menú de perfil). */
export const savedProducts = signal<UserProduct[] | null>(null);
/** La comida de la que se enseñan los detalles (hoja que se abre al pulsarla en la lista de la tarjeta Nutrición). */
export const detailMeal = signal<MealEntry | null>(null);
/** La comida para la que se están viendo ideas para comer mejor (`ui/MealSuggestions.tsx`) y las veces que se ha repetido esa semana; `null`: la hoja está cerrada. */
export const suggestMeal = signal<{ meal: MealEntry; repeats: number } | null>(null);
/** La tarjeta de nutrición tiene dos caras y da la vuelta al pulsarla: la comida (`food`) y la hidratación (`water`). La cara en que se queda no se guarda. */
export const foodFace = signal<'food' | 'water'>('food');
/** Hoja de «Otra cantidad» de agua. */
export const waterSheetOpen = signal(false);

/** Hoja de datos personales: da de alta una entrada nueva (vigente desde hoy o desde la fecha que se elija). */
export const profileSheetOpen = signal(false);
export const calibrateOpen = signal(false);
export const detailWorkoutId = signal<string | null>(null);

/** Versión nueva de la app instalada y a la espera: la persona decide cuándo recargar (ver `pwa.ts`). */
export const updateReady = signal<ServiceWorkerRegistration | null>(null);

/** Aviso temporal en pantalla (confirmaciones y errores leves). */
export const toast = signal<{ id: number; message: string; tone: 'info' | 'error' } | null>(null);
let toastId = 0;
export function showToast(message: string, tone: 'info' | 'error' = 'info'): void {
  const id = ++toastId;
  toast.value = { id, message, tone };
  setTimeout(() => {
    if (toast.value?.id === id) toast.value = null;
  }, 4200);
}

/** El perfil de cara a los demás (identificador, nombre de usuario, estado y foto). `null` hasta que se lee del almacén al arrancar. */
export const socialProfile = signal<SocialProfile | null>(null);

