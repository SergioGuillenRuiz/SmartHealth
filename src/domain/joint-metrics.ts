import { startOfMonth, startOfWeek, type DayKey } from './dates';
import type { DaySummary, Granularity } from './summary';

// Los datos que puede enseñar el gráfico conjunto de Salud. La persona elige cuáles quiere ver y en qué orden, entre TODO lo que la app recoge, sin tope: cada dato es
// una banda con su propia escala (las medidas no comparten eje) y todas comparten el eje de tiempo y el cursor. Aquí está el catálogo y cómo se saca el valor de cada
// periodo (un día, una semana o un mes); cómo se dibuja es cosa de `ui/charts/JointChart.tsx`.

export type JointMetricId =
  | 'steps'
  | 'distance'
  | 'activeKcal'
  | 'workoutMin'
  | 'intake'
  | 'protein'
  | 'carbs'
  | 'fat'
  | 'fiber'
  | 'sugars'
  | 'salt'
  | 'water'
  | 'weight';

export type JointGroup = 'Actividad' | 'Comida y agua' | 'Cuerpo';

export const JOINT_GROUPS: readonly JointGroup[] = ['Actividad', 'Comida y agua', 'Cuerpo'];

/**
 * Datos que el gráfico llegó a ofrecer y se quitaron (el sueño, el pulso y el oxígeno ya tienen su propio gráfico en Salud y no se mezclan aquí). Una copia o unos ajustes
 * guardados que los traigan se aceptan y se limpian en silencio, para que importar una copia de la versión anterior siga valiendo.
 */
export const RETIRED_JOINT_METRICS: ReadonlySet<string> = new Set(['sleep', 'restingBpm', 'avgBpm', 'minBpm', 'maxBpm', 'spo2Avg', 'spo2Min']);

export interface JointMetric {
  id: JointMetricId;
  /** El título de la banda («Pasos al día») y su etiqueta («medido», «anotado»…). */
  title: string;
  tag: 'medido' | 'estimado' | 'anotado' | 'manual';
  group: JointGroup;
  /** Cómo se llama en la lectura del cursor: «5 200 pasos al día». */
  reading: string;
  /** Variable de color (`tokens.css`). */
  color: string;
  /** Barras desde cero o una línea que sigue el valor (el peso, el pulso…: lo que no se acumula). */
  mode: 'bars' | 'line';
  /** Alto del trazado de la banda (px). */
  plotH: number;
  /** Lo que se escribe en la banda si el periodo no tiene ese dato. */
  empty: string;
  decimals: 0 | 1;
  /** El valor de un día. El peso no tiene: se saca de las pesadas. */
  pick?: (day: DaySummary) => number | null;
  /** El día en curso, a medias, no entra en la media de una semana o un mes (hundiría la media): pasos, comida, agua… */
  partialToday: boolean;
}

const grams = (pick: (day: DaySummary) => number | null) => pick;

export const JOINT_METRICS: readonly JointMetric[] = [
  { id: 'steps', title: 'Pasos al día', tag: 'medido', group: 'Actividad', reading: 'pasos al día', color: 'var(--steps)', mode: 'bars', plotH: 210, empty: 'Sin pasos en este periodo', decimals: 0, pick: (d) => d.steps, partialToday: true },
  { id: 'distance', title: 'Distancia al día (km)', tag: 'estimado', group: 'Actividad', reading: 'km al día', color: 'var(--distance)', mode: 'bars', plotH: 150, empty: 'Sin distancia en este periodo', decimals: 1, pick: (d) => (d.distanceM === null ? null : d.distanceM / 1000), partialToday: true },
  { id: 'activeKcal', title: 'Calorías activas al día', tag: 'estimado', group: 'Actividad', reading: 'kcal activas al día', color: 'var(--macro-fat)', mode: 'bars', plotH: 150, empty: 'Sin calorías activas en este periodo', decimals: 0, pick: (d) => d.activeKcal, partialToday: true },
  { id: 'workoutMin', title: 'Entrenamiento al día (min)', tag: 'medido', group: 'Actividad', reading: 'min de entreno al día', color: 'var(--sleep-rem)', mode: 'bars', plotH: 150, empty: 'Sin entrenamientos en este periodo', decimals: 0, pick: (d) => (d.steps === null ? null : d.workoutMin), partialToday: true },
  { id: 'intake', title: 'Calorías al día', tag: 'anotado', group: 'Comida y agua', reading: 'kcal comidas', color: 'var(--kcal)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: (d) => d.intakeKcal, partialToday: true },
  { id: 'protein', title: 'Proteínas al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de proteínas', color: 'var(--macro-protein)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: grams((d) => d.intakeProteinG), partialToday: true },
  { id: 'carbs', title: 'Hidratos al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de hidratos', color: 'var(--macro-carbs)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: grams((d) => d.intakeCarbsG), partialToday: true },
  { id: 'fat', title: 'Grasas al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de grasas', color: 'var(--macro-fat)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: grams((d) => d.intakeFatG), partialToday: true },
  { id: 'fiber', title: 'Fibra al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de fibra', color: 'var(--steps)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: grams((d) => d.intakeFiberG), partialToday: true },
  { id: 'sugars', title: 'Azúcares al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de azúcares', color: 'var(--macro-carbs)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 0, pick: grams((d) => d.intakeSugarsG), partialToday: true },
  { id: 'salt', title: 'Sal al día (g)', tag: 'anotado', group: 'Comida y agua', reading: 'g de sal', color: 'var(--macro-salt)', mode: 'bars', plotH: 150, empty: 'Sin comidas anotadas en este periodo', decimals: 1, pick: grams((d) => d.intakeSaltG), partialToday: true },
  { id: 'water', title: 'Agua al día', tag: 'anotado', group: 'Comida y agua', reading: 'ml de agua', color: 'var(--water)', mode: 'bars', plotH: 150, empty: 'Sin agua anotada en este periodo', decimals: 0, pick: (d) => d.waterMl, partialToday: true },
  { id: 'weight', title: 'Peso (kg)', tag: 'manual', group: 'Cuerpo', reading: 'kg de peso', color: 'var(--weight)', mode: 'line', plotH: 150, empty: 'Sin registros de peso', decimals: 1, partialToday: false },
];

const BY_ID: ReadonlyMap<string, JointMetric> = new Map(JOINT_METRICS.map((m) => [m.id, m]));

export const jointMetricOf = (id: JointMetricId): JointMetric => BY_ID.get(id) as JointMetric;
export const isJointMetricId = (value: unknown): value is JointMetricId => typeof value === 'string' && BY_ID.has(value);

/** Lo que se ve antes de que la persona elija: los cuatro datos de siempre (pasos, calorías comidas, agua y peso), en ese orden. */
export const DEFAULT_JOINT_METRICS: readonly JointMetricId[] = ['steps', 'intake', 'water', 'weight'];

/** La lista de datos elegidos, limpia: solo los que existen, sin repetir y en el orden dado. Lo que no es una lista vuelve al valor por omisión; una lista vacía es válida (no ver ninguno). */
export function sanitizeJointMetrics(value: unknown): JointMetricId[] {
  if (!Array.isArray(value)) return [...DEFAULT_JOINT_METRICS];
  const seen = new Set<JointMetricId>();
  for (const item of value) if (isJointMetricId(item)) seen.add(item);
  return [...seen];
}

const roundTo = (value: number, decimals: number): number => Math.round(value * 10 ** decimals) / 10 ** decimals;

/**
 * El valor de un dato en cada periodo (`starts`: el primer día de cada uno, en orden): el de ese día si se agrupa por días; en semanas y meses, la media POR DÍA CON
 * DATO (un día sin dato no cuenta como cero). El día en curso, a medias, no entra en la media de los datos que se acumulan a lo largo del día. `null`: ese periodo no
 * tiene ese dato. El peso no pasa por aquí.
 */
export function jointValues(summaries: readonly DaySummary[], granularity: Granularity, today: DayKey, starts: readonly DayKey[], metric: JointMetric): Array<number | null> {
  const pick = metric.pick;
  if (!pick) return starts.map(() => null);
  const groups = new Map<DayKey, DaySummary[]>();
  for (const day of summaries) {
    const key = granularity === 'day' ? day.day : granularity === 'week' ? startOfWeek(day.day) : startOfMonth(day.day);
    const list = groups.get(key) ?? [];
    list.push(day);
    groups.set(key, list);
  }
  return starts.map((start) => {
    const days = groups.get(start) ?? [];
    const counted = granularity === 'day' || !metric.partialToday ? days : days.filter((d) => d.day !== today);
    const values = counted.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length === 0) return null;
    return roundTo(values.reduce((a, b) => a + b, 0) / values.length, metric.decimals);
  });
}
