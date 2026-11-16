import { addDays, startOfMonth, startOfWeek, type DayKey } from './dates';
import { profileAt, weightSeries, type ProfileEntry } from './profile';
import { aggregate, type DaySummary, type Granularity } from './summary';

export type Preset = '7' | '30' | '90' | '365' | 'all';

export const PRESETS: ReadonlyArray<{ value: Preset; label: string }> = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '365', label: '1 año' },
  { value: 'all', label: 'Todo' },
];

export interface DayRange {
  from: DayKey;
  to: DayKey;
}

/** Rango que corresponde a un preset terminando hoy. `firstDay` es el primer día con datos (para "Todo"). */
export function rangeForPreset(preset: Preset, today: DayKey, firstDay: DayKey | null): DayRange {
  if (preset === 'all') {
    const from = firstDay && firstDay < today ? firstDay : addDays(today, -29);
    return { from, to: today };
  }
  return { from: addDays(today, -(Number(preset) - 1)), to: today };
}

/**
 * Cómo se agrupan los datos de los gráficos de Salud: SIEMPRE por días, sea cual sea el periodo. Antes, con más de 45 días se agrupaba por semanas y con más de 200 por meses, y lo que se enseñaba
 * (calorías acumuladas de una semana o de un mes) no le servía a nadie. Todos los días entran a la vez en el ancho de la pantalla (las barras se estrechan) y la barra vertical se arrastra para leer cada uno.
 */
export function autoGranularity(_days: number): Granularity {
  return 'day';
}

/** Un periodo del gráfico conjunto de la evolución (un día, una semana o un mes) con lo que se dibuja de cada medida. */
export interface JointSlot {
  /** Primer día del periodo (lunes en las semanas, día 1 en los meses). */
  start: DayKey;
  /** Último día del periodo incluido en el rango. */
  end: DayKey;
  /** Pasos al día: media por día con datos y sin el día en curso (aún no ha terminado) en semanas y meses. */
  steps: number | null;
  /** Días que entran en esa media: una semana de un solo día no pesa lo que una de siete. */
  activityDays: number;
  /** Calorías comidas al día: media por día con comidas anotadas y sin el día en curso (aún no ha terminado) en semanas y meses. */
  intakeKcal: number | null;
  /** Días con comidas anotadas que entran en esa media. */
  intakeDays: number;
  /** Agua anotada al día (ml): media por día con agua anotada y sin el día en curso en semanas y meses; y la meta media de esos días (la base de su perfil más lo del ejercicio). */
  waterMl: number | null;
  waterGoalMl: number | null;
  /** Días con agua anotada que entran en esa media. */
  waterDays: number;
  /**
   * El peso al terminar el periodo: el de la última pesada dentro de él o, si no hubo ninguna, el que ya tenía la persona (el peso solo se anota cuando cambia: sin
   * pesada nueva no ha variado). `null` solo antes de la primera pesada que se conoce.
   */
  weightKg: number | null;
  /** Hubo una pesada de verdad dentro del periodo (y no se arrastra el peso del anterior): la marca del gráfico va solo ahí. */
  weighed: boolean;
}

/** El periodo (día, semana o mes) al que pertenece un día. */
const slotStart = (day: DayKey, granularity: Granularity): DayKey => (granularity === 'day' ? day : granularity === 'week' ? startOfWeek(day) : startOfMonth(day));

/**
 * Lo que dibuja el gráfico conjunto de actividad, comida, agua y peso: un punto por periodo con las medidas alineadas en el
 * tiempo. El peso no se mide a diario: cada pesada cae en su periodo (la última, si hay varias) y los periodos sin pesada
 * **arrastran el último peso conocido** (quien no se pesa es que no ha cambiado), hasta hoy; antes de la primera pesada no se inventa
 * ninguno. Las entradas que solo fijan la zancada no son pesadas.
 */
export function buildJointSlots(summaries: readonly DaySummary[], granularity: Granularity, history: readonly ProfileEntry[], range: DayRange, today: DayKey): JointSlot[] {
  const weighIns = new Map<DayKey, number>();
  for (const w of weightSeries(history)) {
    if (w.date >= range.from && w.date <= range.to) weighIns.set(slotStart(w.date, granularity), w.weightKg); // la última del periodo gana
  }
  // El peso que ya regía al empezar el rango, si lo hubo de verdad (antes de la primera pesada no se extrapola uno).
  const carry = profileAt(history, range.from);
  let weightKg: number | null = carry && !carry.extrapolated ? carry.weightKg : null;
  return aggregate(summaries, granularity, { partialDay: today }).map((p) => {
    const own = weighIns.get(p.start);
    if (own !== undefined) weightKg = own;
    return {
      start: p.start,
      end: p.end,
      steps: p.steps,
      activityDays: p.activityDays,
      intakeKcal: p.intakeKcal,
      intakeDays: p.intakeDays,
      waterMl: p.waterMl,
      waterGoalMl: p.waterGoalMl,
      waterDays: p.waterDays,
      weightKg,
      weighed: own !== undefined,
    };
  });
}
