import { cyclingMet, locomotionMet } from './estimation';

/** Deportes que ya no se ofrecen, pero que pueden estar en entrenos guardados o en una copia de seguridad. */
export type RetiredSportId = 'hiit' | 'badminton' | 'tabletennis' | 'rope' | 'elliptical' | 'rowing' | 'dance';

export type SportId =
  | 'walk'
  | 'run'
  | 'hike'
  | 'cycle'
  | 'bicimad'
  | 'swim'
  | 'gym'
  | 'yoga'
  | 'football'
  | 'basketball'
  | 'tennis'
  | 'padel'
  | RetiredSportId;

export interface Sport {
  id: SportId;
  name: string;
  /** Nombre del icono (ver `ui/icons.tsx`). */
  icon: string;
  /**
   * `ambulatory`: se avanza a pie y los pasos del anillo son reales (distancia = pasos × zancada).
   * `cycling`: los pasos del anillo no sirven (la muñeca se mueve con el manillar); la distancia viene del GPS o se
   * introduce a mano.
   * `other`: ni distancia ni pasos significativos.
   */
  kind: 'ambulatory' | 'cycling' | 'other';
  /** El GPS del móvil aporta una distancia útil en esta actividad. */
  gpsUseful: boolean;
  /**
   * La velocidad más alta que se da por creíble con el GPS (m/s): por encima es un salto de posición o un glitch, no movimiento.
   * Cuanto más ajustada, mejor caza los saltos de un GPS flojo; pero debe cubrir lo que de verdad se hace (una bajada en bici
   * pasa de 15 m/s = 54 km/h).
   */
  maxGpsSpeedMs?: number;
  /** Lo mismo para la aceleración de la velocidad que mide el GPS (m/s²): por encima es un glitch del chip. */
  maxGpsAccelerationMs2?: number;
  /** MET bruto cuando no hay velocidad ni FC fiable (Compendio de Actividades Físicas, valores generales). */
  genericMet: number;
  /** MET en función de la velocidad (km/h). Solo donde la velocidad dice cuánto esfuerzo se hace. */
  speedMet?: (speedKmh: number) => number;
}

/**
 * Lo que se ofrece al empezar o registrar un entreno, en el orden en que se muestra: a pie, con ruedas, gimnasio y agua, y
 * deportes de pelota.
 */
export const SPORTS: readonly Sport[] = [
  { id: 'walk', name: 'Caminar', icon: 'walk', kind: 'ambulatory', gpsUseful: true, maxGpsSpeedMs: 6, maxGpsAccelerationMs2: 2, genericMet: 3.5, speedMet: locomotionMet },
  { id: 'run', name: 'Correr', icon: 'run', kind: 'ambulatory', gpsUseful: true, maxGpsSpeedMs: 12, maxGpsAccelerationMs2: 4, genericMet: 9.8, speedMet: locomotionMet },
  { id: 'hike', name: 'Senderismo', icon: 'trekking', kind: 'ambulatory', gpsUseful: true, maxGpsSpeedMs: 6, maxGpsAccelerationMs2: 2, genericMet: 6.0 },
  { id: 'cycle', name: 'Ciclismo', icon: 'bike', kind: 'cycling', gpsUseful: true, maxGpsSpeedMs: 30, maxGpsAccelerationMs2: 5, genericMet: 6.8, speedMet: cyclingMet },
  // La bici eléctrica del BiciMAD: el motor pone parte del esfuerzo, así que la velocidad ya no dice cuánto se pedalea y no
  // hay MET por velocidad; el pulso (si hay) o el MET de «asistencia alta» del Compendio 2024 (01088: 4,0) mandan.
  { id: 'bicimad', name: 'BiciMAD', icon: 'bicimad', kind: 'cycling', gpsUseful: true, maxGpsSpeedMs: 16, maxGpsAccelerationMs2: 5, genericMet: 4.0 },
  { id: 'swim', name: 'Natación', icon: 'swimming', kind: 'other', gpsUseful: false, genericMet: 6.0 },
  { id: 'gym', name: 'Fuerza', icon: 'barbell', kind: 'other', gpsUseful: false, genericMet: 4.0 },
  { id: 'yoga', name: 'Yoga', icon: 'yoga', kind: 'other', gpsUseful: false, genericMet: 2.5 },
  { id: 'football', name: 'Fútbol', icon: 'football', kind: 'other', gpsUseful: false, genericMet: 7.0 },
  { id: 'basketball', name: 'Baloncesto', icon: 'basketball', kind: 'other', gpsUseful: false, genericMet: 6.5 },
  { id: 'tennis', name: 'Tenis', icon: 'tennis', kind: 'other', gpsUseful: false, genericMet: 7.3 },
  { id: 'padel', name: 'Pádel', icon: 'padel', kind: 'other', gpsUseful: false, genericMet: 6.0 },
];

/**
 * Deportes retirados de la lista. Un entreno guardado con uno de ellos (o una copia de seguridad que lo lleve) se sigue
 * leyendo con su nombre y su gasto de siempre: si no, `sportById` lo convertiría en «Caminar» y le inventaría pasos.
 */
const RETIRED: readonly Sport[] = [
  { id: 'hiit', name: 'HIIT', icon: 'bolt', kind: 'other', gpsUseful: false, genericMet: 8.0 },
  { id: 'badminton', name: 'Bádminton', icon: 'Activity', kind: 'other', gpsUseful: false, genericMet: 5.5 },
  { id: 'tabletennis', name: 'Tenis de mesa', icon: 'ping-pong', kind: 'other', gpsUseful: false, genericMet: 4.0 },
  { id: 'rope', name: 'Comba', icon: 'jump-rope', kind: 'other', gpsUseful: false, genericMet: 10.0 },
  { id: 'elliptical', name: 'Elíptica', icon: 'Activity', kind: 'other', gpsUseful: false, genericMet: 5.0 },
  { id: 'rowing', name: 'Remo', icon: 'sailboat', kind: 'other', gpsUseful: false, genericMet: 7.0 },
  { id: 'dance', name: 'Baile', icon: 'music', kind: 'other', gpsUseful: false, genericMet: 5.0 },
];

const BY_ID = new Map<string, Sport>([...SPORTS, ...RETIRED].map((s) => [s.id, s]));

export function sportById(id: string): Sport {
  const sport = BY_ID.get(id) ?? BY_ID.get('walk');
  if (!sport) throw new Error('Catálogo de deportes vacío');
  return sport;
}

export function isSportId(value: string): value is SportId {
  return BY_ID.has(value);
}

/** Lo que el anillo aporta EN DIRECTO durante una actividad, según las funciones que declara. */
export interface SportSupport {
  /** Pulso en directo. */
  heartRate: boolean;
  /** Pasos en directo (solo en actividades a pie: en bici o en el gimnasio no significan nada). */
  steps: boolean;
  /** El anillo aporta algo en directo. Si no, solo habría cronómetro y la actividad solo puede añadirse a mano. */
  ringUseful: boolean;
}

/**
 * `capabilities` es lo que el anillo declaró en su última conexión; `null` = aún no se sabe (p. ej. antes de la
 * primera sincronización). Sin información no se recorta nada: se intenta y, si el anillo no lo da, se avisa.
 */
export function sportSupport(sport: Sport, capabilities: ReadonlySet<string> | null): SportSupport {
  const heartRate = capabilities === null || capabilities.has('heartRate');
  const steps = sport.kind === 'ambulatory' && (capabilities === null || capabilities.has('steps'));
  return { heartRate, steps, ringUseful: heartRate || steps };
}
