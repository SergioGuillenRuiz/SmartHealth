import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';

// Sueño estimado para las noches SIN ANILLO (ronda 47).
//
// `sleep-estimate.ts` necesita que el anillo esté puesto de noche: se apoya en su pulso y en que no haya pasos. Si la persona lo deja de noche en la mesa o cargando no hay pulso ni pasos que
// mirar y esa estimación no ve nada. Lo que sí queda es lo contrario: HUECOS de actividad. Cada vez que la persona hace algo con la app o con el anillo puesto, queda una marca con su hora
// (pasos del anillo, un entreno, una comida o un vaso de agua anotados, una medida a mano, una sincronización con la app abierta). Una noche sin anillo es un hueco largo entre la última marca
// de la tarde y la primera de la mañana, y dormir ocurre dentro de ese hueco.
//
// Cómo , SIN mirar cuánto dura (desde la ronda 56: hay quien duerme hasta 14 h y la duración descartaba esas noches):
//   · una noche es un hueco entre marcas de 5 a 22 h que pasa al menos una hora entre las 22:00 y las 07:00 (hora local: se ajusta solo a cada país); un hueco quieto de la mañana o de la
//     tarde no lo es. Un hueco que acaba en plena madrugada (01:00–04:30) no es una noche, y una marca suelta de madrugada con horas de silencio a cada lado es un despertar dentro de la noche;
//   · si en el hueco hay lecturas de pulso del anillo, el anillo ESTABA puesto: esa noche es de la otra estimación (o de ninguna), no de esta;
//   · se acuesta tras la última marca (un rato después, según qué marca: unos pasos o una comida anotada se hacen minutos antes de acostarse; una sincronización, menos) y, si esa marca es
//     de la tarde, no antes de las 22:00; se levanta poco antes de la primera marca de la mañana (menos si fue una anotación con el móvil, más si fueron los pasos del anillo recién puesto).
//   Las siestas no se cuentan: no pasan por las 22:00–07:00.
// Es una aproximación y se dice así: las horas valen ± una hora, no hay fases y no se guarda nunca (se calcula al leer, como la otra).

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Una marca de actividad: la persona estaba despierta. Un intervalo (pasos, entreno) o un instante (`endMs === startMs`). */
interface Mark {
  startMs: number;
  endMs: number;
  /** `steps`: el anillo puesto y andando; `logged`: algo anotado o medido a mano; `sync`: la app abierta sincronizando. */
  kind: 'steps' | 'logged' | 'sync';
}

export interface OffRingParams {
  minSleepMs: number;
  minGapMs: number;
  maxGapMs: number;
  minNightMs: number;
  ringOnReadings: number;
  ringOnMarginMs: number;
  awakeInNightMs: number;
  earliestWakeMs: { from: number; to: number };
  stepsToCount: number;
  latency: Record<Mark['kind'], number>;
  lead: Record<Mark['kind'], number>;
  nearRealMs: number;
  habitDays: number;
}

export const OFFRING: OffRingParams = {
  /** Una noche dura entre esto y esto (menos es una siesta; más, olvidar el móvil o el anillo). */
  minSleepMs: 3 * HOUR,
  /** El hueco entre la última marca de la tarde y la primera de la mañana. */
  minGapMs: 5 * HOUR,
  maxGapMs: 22 * HOUR,
  /** Lo que el hueco tiene que pasar entre las 22:00 y las 07:00 (hora local, así que se ajusta solo a cada país) para ser una noche y no una jornada sin anotar nada. */
  minNightMs: 60 * MIN,
  /** Lecturas de pulso del anillo dentro del hueco (sin los bordes) que dicen que estaba puesto. */
  ringOnReadings: 2,
  ringOnMarginMs: 20 * MIN,
  /** Una marca de menos de esto (un vaso de agua, mirar el móvil) en plena madrugada, con horas de silencio a cada lado, es un despertar dentro de la noche. */
  awakeInNightMs: 20 * MIN,
  /** Un hueco que acaba entre estas horas del día (01:00 y 04:30) acaba en plena madrugada: no se cuenta como noche. */
  earliestWakeMs: { from: 1 * HOUR, to: 4.5 * HOUR },
  /** Pasos que hacen falta en un tramo del anillo para contar como despierto (uno suelto se arrastra a veces con el anillo en la mano). */
  stepsToCount: 5,
  /** Rato entre la última marca y acostarse, y entre despertar y la primera marca, según la marca. */
  latency: { steps: 30 * MIN, logged: 25 * MIN, sync: 15 * MIN },
  lead: { steps: 20 * MIN, logged: 15 * MIN, sync: 15 * MIN },
  /** Una estimación a menos de esto de una noche del anillo es esa misma noche vista de otra manera. */
  nearRealMs: 90 * MIN,
  /** Las noches reales que se miran para el hábito: ± estos días. */
  habitDays: 45,
};

export interface OffRingInput {
  buckets: readonly StepBucket[];
  counters: readonly CounterSample[];
  heart: readonly HeartSample[];
  workouts: ReadonlyArray<{ startMs: number; endMs: number }>;
  /** Instantes en que se anotó una comida o se bebió (los que cuentan con su hora de verdad: no los pasados a otro día). */
  logged: readonly number[];
  /** Instantes de sincronizaciones con la app abierta (también las que fallaron: la app estaba abierta). */
  syncs: readonly number[];
  /** Las noches que el anillo SÍ dio (de ellas sale el hábito) y que impiden estimar esa misma noche. */
  real: readonly SleepSessionRecord[];
  /** Cuándo se le pidió al anillo, por última vez, su historial de sueño (`null`: nunca): una noche solo se estima si acabó antes. */
  askedAtMs: number | null;
  fromMs: number;
  toMs: number;
}

const at = <T>(values: readonly T[], index: number): T => values[index] as T;

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
};

/** El primer índice de `samples` (ordenadas por hora) con `tsMs >= ms`. */
function lowerBound(samples: readonly HeartSample[], ms: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(samples, mid).tsMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Quita de las marcas los despertares de madrugada: instantes entre la 01:00 y las 04:30 con al menos `minSleepMs` de silencio antes y después (la noche sigue siendo una). */
function withoutNightAwakenings(marks: readonly Mark[], params: OffRingParams): Mark[] {
  const keep: boolean[] = marks.map(() => true);
  let reach = -Infinity;
  for (let i = 0; i < marks.length; i++) {
    const mark = at(marks, i);
    const next = marks[i + 1];
    const timeOfDay = mark.startMs - startOfLocalDay(mark.startMs);
    const inSmallHours = timeOfDay >= params.earliestWakeMs.from && timeOfDay < params.earliestWakeMs.to;
    if (inSmallHours && mark.endMs - mark.startMs <= params.awakeInNightMs && next !== undefined && mark.startMs - reach >= params.minSleepMs && next.startMs - mark.endMs >= params.minSleepMs) keep[i] = false;
    // Las marcas quitadas no cuentan para lo que ya se ha visto: el silencio de antes sigue siendo el de la última marca de verdad.
    if (at(keep, i)) reach = Math.max(reach, mark.endMs);
  }
  return marks.filter((_, i) => at(keep, i));
}

/** Cuánto del hueco [a, b] cae entre las 22:00 y las 07:00 locales (de cualquiera de los días que cruza): la franja en la que se duerme de noche. */
function overlapWithNight(a: number, b: number): number {
  let total = 0;
  for (let day = startOfLocalDay(a - 24 * HOUR); day < b; day = startOfLocalDay(day + 26 * HOUR)) {
    const from = new Date(day).setHours(22, 0, 0, 0);
    const to = new Date(day).setHours(31, 0, 0, 0); // las 07:00 del día siguiente
    total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  }
  return total;
}

/** Las 22:00 locales que caen DENTRO del hueco (la última, si hay dos), o `null` si ninguna: antes de esa hora la persona se supone despierta aunque no haya dejado marcas. */
function lastEveningStart(a: number, b: number): number | null {
  let found: number | null = null;
  for (let day = startOfLocalDay(a); day <= b; day = startOfLocalDay(day + 26 * HOUR)) {
    const t = new Date(day).setHours(22, 0, 0, 0);
    if (t > a && t < b) found = t;
  }
  return found;
}

/** La marca que acaba en `endMs` (la que cierra el hueco por detrás). */
function markIndexEndingAt(marks: readonly Mark[], endMs: number): number {
  for (let i = marks.length - 1; i >= 0; i--) if (at(marks, i).endMs === endMs) return i;
  return 0;
}

function marksOf(input: OffRingInput, params: OffRingParams): Mark[] {
  const marks: Mark[] = [];
  for (const bucket of input.buckets) {
    if (bucket.steps >= params.stepsToCount && bucket.endMs - bucket.startMs <= 3 * HOUR) marks.push({ startMs: bucket.startMs, endMs: bucket.endMs, kind: 'steps' });
  }
  // El contador acumulado solo se apunta cuando cambia (o al sincronizar): una subida es andar, el resto es la app abierta.
  const counters = [...input.counters].sort((a, b) => a.tsMs - b.tsMs);
  counters.forEach((counter, index) => {
    const previous = counters[index - 1];
    const sameDay = previous !== undefined && new Date(counter.tsMs).getDate() === new Date(previous.tsMs).getDate();
    const walked = previous !== undefined && sameDay && counter.steps > previous.steps;
    marks.push({ startMs: counter.tsMs, endMs: counter.tsMs, kind: walked ? 'steps' : 'sync' });
  });
  for (const w of input.workouts) marks.push({ startMs: w.startMs, endMs: Math.max(w.startMs, w.endMs), kind: 'steps' });
  for (const s of input.heart) if (s.source !== 'ring-auto') marks.push({ startMs: s.tsMs, endMs: s.tsMs, kind: 'logged' });
  for (const ms of input.logged) marks.push({ startMs: ms, endMs: ms, kind: 'logged' });
  for (const ms of input.syncs) marks.push({ startMs: ms, endMs: ms, kind: 'sync' });
  return marks.sort((a, b) => a.startMs - b.startMs);
}

/** Las noches sin anillo estimadas con los huecos de actividad. `[]` si no se le ha pedido el sueño al anillo o no hay ninguna noche así en [fromMs, toMs). */
export function estimateSleepOffRing(input: OffRingInput, params: OffRingParams = OFFRING): SleepSessionRecord[] {
  if (input.askedAtMs === null) return [];
  const marks = withoutNightAwakenings(marksOf(input, params), params);
  if (marks.length < 2) return [];
  const ringOn = input.heart.filter((s) => s.source === 'ring-auto' && s.bpm >= 30 && s.bpm <= 200).sort((a, b) => a.tsMs - b.tsMs);

  const out: SleepSessionRecord[] = [];
  // Los huecos entre marcas, en orden: `reach` es lo más tarde que acaba cualquier marca anterior (un tramo largo puede tapar a las siguientes).
  let reach = at(marks, 0).endMs;
  for (let i = 1; i < marks.length; i++) {
    const next = at(marks, i);
    const a = reach;
    const b = next.startMs;
    reach = Math.max(reach, next.endMs);
    const gap = b - a;
    if (gap < params.minGapMs) continue;
    if (gap > params.maxGapMs) continue; // un día entero sin una sola marca no es una noche: es el móvil y el anillo olvidados
    if (b <= input.fromMs || a >= input.toMs + 24 * HOUR) continue;
    // Una noche tiene que pasar por la madrugada (de 01:00 a 07:00, al menos una hora): un hueco quieto de la mañana o de la tarde es una jornada sin anotar nada, no dormir. Así vale también
    // para quien se acuesta tarde y duerme hasta la tarde, que con las 04:00 como centro fijo se perdía.
    if (overlapWithNight(a, b) < params.minNightMs) continue;
    // Una marca en plena madrugada (entre la 01:00 y las 04:30) es una persona despierta: el hueco que acaba así es la primera mitad de una noche partida, no una noche.
    const timeOfWake = b - startOfLocalDay(b);
    if (timeOfWake >= params.earliestWakeMs.from && timeOfWake < params.earliestWakeMs.to) continue;
    // El anillo puesto de noche da pulso: esa noche no es de este estimador.
    let worn = 0;
    for (let k = lowerBound(ringOn, a + params.ringOnMarginMs); k < ringOn.length && at(ringOn, k).tsMs <= b - params.ringOnMarginMs && worn < params.ringOnReadings; k++) worn++;
    if (worn >= params.ringOnReadings) continue;
    const before: Mark = at(marks, markIndexEndingAt(marks, a));
    const after: Mark = next;
    // Sin mirar cuánto dura: la noche es el hueco. Empieza tras la última marca y, si esa marca es de la tarde (antes de las 22:00), no antes de las 22:00 (hasta entonces se supone despierta);
    // acaba poco antes de la primera marca de la mañana.
    const eveningStart = lastEveningStart(a, b);
    const onset = eveningStart !== null ? Math.max(a + params.latency[before.kind], eveningStart) : a + params.latency[before.kind];
    const wake = b - params.lead[after.kind];
    if (wake - onset < params.minSleepMs) continue;
    if (wake <= input.fromMs || onset >= input.toMs) continue;
    // Primero la forma normal: sin haberle pedido el sueño al anillo después de esa noche, no hay nada que suplir todavía.
    if (wake > input.askedAtMs) continue;
    if (input.real.some((r) => r.startMs < wake + params.nearRealMs && r.endMs > onset - params.nearRealMs)) continue;
    out.push({ startMs: Math.round(onset), endMs: Math.round(wake), segments: [], estimated: true });
  }
  return out;
}
