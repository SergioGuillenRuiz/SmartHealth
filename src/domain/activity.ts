import { addDays, dayKeyOf, dayWindow, elapsedFractionOfDay, HOUR_MS, startOfDayMs, type DayKey } from './dates';
import { baseStride, bmrKcalPerDay, round, walkingFromSteps, type StrideInfo } from './estimation';
import { maxOf } from './extent';
import type { ResolvedProfile } from './profile';
import { sportById } from './sports';
import type { CounterSample, StepBucket } from './types';
import { estimateWorkout, type WorkoutEstimate, type WorkoutRecord } from './workout';

// Actividad física TOTAL de un día: pasos medidos por el anillo + entrenamientos, sin omisiones ni duplicados.
//
// Regla de integración: dentro de la ventana de un entrenamiento, lo que el entrenamiento aporta
// (distancia y energía) SUSTITUYE a lo que se habría estimado con los pasos del anillo en esa misma
// ventana. Así una caminata registrada no se cuenta dos veces (una por los pasos y otra por el
// entrenamiento) y una sesión de bici no suma como "andar" los golpecitos que el anillo cuenta como pasos.
// Pasos del día = andar fuera de entrenos + pasos de los entrenos a pie. Los que el anillo cuenta durante un deporte en el
// que no se anda (la bici mueve la muñeca y se leen como pasos) no se suman. Distancia y energía suman el andar y todos los
// entrenos que las aportan (los que no tienen distancia, como el gimnasio, no suman kilómetros).

export interface ActivityInputs {
  day: DayKey;
  /**
   * Hora a la que empieza el día (0–12; 0, la medianoche, si falta; la app siempre usa 0). Con otra hora, el día acaba a esa hora del
   * día siguiente (ver `dayWindow`). Todo lo que se pasa aquí debe cubrir esa ventana entera.
   */
  dayStartHour?: number;
  nowMs: number;
  profile: ResolvedProfile;
  /** `true` si el perfil son los valores genéricos (aún no se han introducido datos personales). */
  profileIsGeneric: boolean;
  /** Tramos del anillo que se solapan con el día. */
  buckets: readonly StepBucket[];
  /** Lecturas del contador acumulado del anillo (que parte de 0 a medianoche) dentro del día. */
  counters: readonly CounterSample[];
  /** Entrenamientos que empiezan en el día. */
  workouts: readonly WorkoutRecord[];
  /**
   * Entrenamientos que empezaron un día antes y siguen dentro de este (cruzan el cambio de día). Sus cifras pertenecen al
   * día en que empezaron; aquí solo sirven para no volver a contar como paseo los pasos que dieron después de él.
   */
  carryOverWorkouts?: readonly WorkoutRecord[];
}

export interface DayActivity {
  day: DayKey;
  hasData: boolean;
  /**
   * Pasos del día: los que el anillo contó andando fuera de entrenos y durante entrenos a pie. No incluye los que contó
   * durante deportes en los que no se anda (bici…): esos están en `ignoredSteps`.
   */
  steps: number | null;
  /** De dónde sale `steps`: contador del anillo, suma de sus tramos, o solo los pasos propios de los entrenos. */
  stepsSource: 'counter' | 'buckets' | 'workouts' | 'none';
  /** Distancia total estimada: pasos fuera de entrenos + entrenos. */
  distanceM: number | null;
  /** Energía activa estimada (por encima del reposo): pasos fuera de entrenos + entrenos. */
  activeKcal: number | null;
  /** Metabolismo basal estimado, proporcional a lo transcurrido del día. */
  basalKcal: number | null;
  /** Basal + activa. */
  totalKcal: number | null;
  stride: StrideInfo;
  weightKg: number;
  profileIsGeneric: boolean;
  /** `true` si el día es anterior a la primera entrada del perfil y se han usado esos primeros datos por no haber otros. */
  profileExtrapolated: boolean;
  /** Aporte de los pasos del anillo fuera de entrenamientos. */
  walking: { steps: number; distanceM: number; kcal: number };
  workouts: WorkoutEstimate[];
  /** Hay entrenos que se pisan en el tiempo (más de un minuto): suele ser uno repetido, y sus calorías se suman tal cual. */
  overlappingWorkouts: boolean;
  /** Pasos del anillo contados durante entrenos en los que no se anda (bici…): no suman a `steps` ni a la distancia o la energía. */
  ignoredSteps: number;
  /**
   * Pasos que se lleva cada entreno a pie (por id): los de su ventana. Con `walking` suman `steps`; los entrenos en los que
   * no se anda no aparecen.
   */
  workoutSteps: Record<string, number>;
  /** Pasos por hora local (0–23), si el anillo dio el detalle temporal. */
  hourlySteps: number[] | null;
  /** Distancia que calcula el propio anillo, solo para que el usuario pueda comparar. */
  ringReportedDistanceM: number | null;
  /** Instante del último dato del anillo de ese día. */
  lastDataMs: number | null;
  notes: string[];
}

/** Lo que un entreno se lleva de los pasos del anillo del día. */
interface WorkoutShare {
  workout: WorkoutRecord;
  ambulatory: boolean;
  /** Pasos del anillo en la parte de su ventana que no reclamó antes otro entreno. */
  inWindow: number;
  /** Esa parte de su ventana (la que no reclamó antes otro entreno), fusionada y ordenada. */
  exclusive: Array<[number, number]>;
  /** Parte de su ventana (0–1) que cae en este día: un entreno que cruza la medianoche reparte sus pasos entre dos días. */
  dayShare: number;
  /** Pasos del anillo de los que sale su distancia cuando no tiene pasos propios ni distancia. */
  ringSteps: number;
}

interface ClippedBucket {
  startMs: number;
  endMs: number;
  steps: number;
  ringDistanceM: number;
}

/** Recorta un tramo al día; si cruza la medianoche, reparte sus pasos en proporción al tiempo. */
function clipBucket(bucket: StepBucket, dayStart: number, dayEnd: number): ClippedBucket | null {
  const length = bucket.endMs - bucket.startMs;
  if (length <= 0) {
    return bucket.startMs >= dayStart && bucket.startMs < dayEnd
      ? { startMs: bucket.startMs, endMs: bucket.startMs, steps: bucket.steps, ringDistanceM: bucket.ringDistanceM }
      : null;
  }
  const start = Math.max(bucket.startMs, dayStart);
  const end = Math.min(bucket.endMs, dayEnd);
  if (end <= start) return null;
  const fraction = (end - start) / length;
  return { startMs: start, endMs: end, steps: bucket.steps * fraction, ringDistanceM: bucket.ringDistanceM * fraction };
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Lo que queda de [start, end] al quitarle los bloques (fusionados y ordenados). */
function subtractIntervals(start: number, end: number, blocks: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = start;
  for (const [s, e] of blocks) {
    if (e <= cursor) continue;
    if (s >= end) break;
    if (s > cursor) out.push([cursor, Math.min(s, end)]);
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push([cursor, end]);
  return out;
}

/** Fracción de [start, end] cubierta por los intervalos (ya fusionados). */
function coveredFraction(start: number, end: number, merged: ReadonlyArray<readonly [number, number]>): number {
  if (end <= start) return merged.some(([s, e]) => start >= s && start <= e) ? 1 : 0;
  let covered = 0;
  for (const [s, e] of merged) covered += Math.max(0, Math.min(end, e) - Math.max(start, s));
  return Math.min(1, covered / (end - start));
}

/**
 * Reparte los pasos del anillo entre los entrenamientos de un día. Cada uno reclama los de su ventana; si dos se solapan
 * (uno repetido, o dos añadidos a mano), cada paso se atribuye a UNO solo: primero a los que traen medidas propias (pasos o
 * distancia) y, entre iguales, al que empezó antes. Sin esto, dos entrenos sobre la misma hora derivarían la distancia de
 * los mismos pasos y la contarían dos veces. Devuelve un reparto por entreno, en el mismo orden que `workouts`.
 */
function allocateWorkoutSteps(workouts: readonly WorkoutRecord[], clipped: readonly ClippedBucket[], dayStart: number, dayEnd: number): WorkoutShare[] {
  const order = workouts
    .map((w, index) => ({ w, index, measured: (w.steps ?? 0) > 0 || (w.distanceM ?? 0) > 0 }))
    .sort((a, b) => Number(b.measured) - Number(a.measured) || a.w.startMs - b.w.startMs || a.index - b.index);
  let claimed: Array<[number, number]> = [];
  const shares = new Array<WorkoutShare>(workouts.length);
  for (const { w, index } of order) {
    const exclusive = subtractIntervals(w.startMs, w.endMs, claimed);
    let inWindow = 0;
    for (const bucket of clipped) inWindow += bucket.steps * coveredFraction(bucket.startMs, bucket.endMs, exclusive);
    claimed = mergeIntervals([...claimed, [w.startMs, w.endMs]]);
    const length = w.endMs - w.startMs;
    const dayShare = length > 0 ? Math.max(0, Math.min(w.endMs, dayEnd) - Math.max(w.startMs, dayStart)) / length : 1;
    const ambulatory = sportById(w.sport).kind === 'ambulatory';
    // Un entreno a pie sin distancia ni pasos propios (manual, o con el anillo sin pasos) no puede quitar los pasos que el
    // anillo sí contó en su ventana sin aportar nada a cambio: su distancia sale de esos pasos.
    const ringSteps = ambulatory && !((w.distanceM ?? 0) > 0) && !((w.steps ?? 0) > 0) ? Math.round(inWindow) : 0;
    shares[index] = { workout: w, ambulatory, inWindow, exclusive, dayShare, ringSteps };
  }
  return shares;
}

/** Parte (0–1) de un entreno que ocurrió después de `until`: lo que el anillo aún no había contado cuando se sincronizó. */
function fractionAfter(w: Pick<WorkoutRecord, 'startMs' | 'endMs'>, until: number): number {
  const length = w.endMs - w.startMs;
  if (length <= 0) return w.startMs > until ? 1 : 0;
  return Math.max(0, Math.min(1, (w.endMs - Math.max(w.startMs, until)) / length));
}

/**
 * Estima los entrenamientos que empiezan en `day` con las MISMAS reglas que el resumen del día (pasos del anillo de su
 * ventana, sin repartirlos dos veces entre entrenos solapados), para que cada cifra sea la misma en todas las pantallas.
 * Devuelve una estimación por entreno, en el mismo orden.
 */
export function estimateDayWorkouts(
  day: DayKey,
  workouts: readonly WorkoutRecord[],
  buckets: readonly StepBucket[],
  profile: ResolvedProfile,
  dayStartHour = 0,
): WorkoutEstimate[] {
  const { startMs: dayStart, endMs: dayEnd } = dayWindow(day, dayStartHour);
  const clipped = buckets.map((b) => clipBucket(b, dayStart, dayEnd)).filter((b): b is ClippedBucket => b !== null && b.steps > 0);
  return allocateWorkoutSteps(workouts, clipped, dayStart, dayEnd).map((share) => estimateWorkout(share.workout, profile, share.ringSteps, share.dayShare));
}

export function summarizeActivity(input: ActivityInputs): DayActivity {
  const { day, nowMs, profile } = input;
  const startHour = input.dayStartHour ?? 0;
  const { startMs: dayStart, endMs: dayEnd } = dayWindow(day, startHour);
  const stride = baseStride(profile);
  const notes: string[] = [];

  const clipped = input.buckets.map((b) => clipBucket(b, dayStart, dayEnd)).filter((b): b is ClippedBucket => b !== null && b.steps > 0);
  const bucketSteps = clipped.reduce((a, b) => a + b.steps, 0);
  // Un contador a 0 no es una medida de «cero pasos»: es un anillo sin llevar o recién reiniciado. Con él solo, el día no
  // tiene datos (si no, contaría como un día de 0 pasos en las medias).
  const rawCounters = input.counters.filter((c) => c.tsMs >= dayStart && c.tsMs < dayEnd);
  const dayCounters = countersSinceStart(rawCounters, dayStart, dayEnd);
  const counters = dayCounters.filter((c) => c.steps > 0);
  const counterMax = counters.length ? maxOf(counters.map((c) => c.steps)) : null;

  const shares = allocateWorkoutSteps(input.workouts, clipped, dayStart, dayEnd);
  const workouts = shares.map((share) => estimateWorkout(share.workout, profile, share.ringSteps, share.dayShare));
  const carryOver = input.carryOverWorkouts ?? [];

  // Solapes de más de un minuto (se compara con el final más tardío hasta ahora: uno corto dentro de otro no esconde un tercero).
  let latestEnd = -Infinity;
  let overlapping = false;
  for (const w of [...input.workouts].sort((a, b) => a.startMs - b.startMs)) {
    if (w.startMs < latestEnd - 60_000) overlapping = true;
    latestEnd = Math.max(latestEnd, w.endMs);
  }

  const base = {
    day,
    stride,
    weightKg: profile.weightKg,
    profileIsGeneric: input.profileIsGeneric,
    profileExtrapolated: profile.extrapolated,
    workouts,
    overlappingWorkouts: overlapping,
    notes,
  };
  if (profile.extrapolated && !input.profileIsGeneric) {
    notes.push('Este día es anterior a tu primer dato personal guardado: las estimaciones usan esos primeros datos (peso, altura…) por no haber otros.');
  }

  if (clipped.length === 0 && counterMax === null) {
    const workoutDistance = sumDistances(workouts);
    const workoutKcal = workouts.reduce((a, w) => a + w.kcal, 0);
    const hasWorkouts = workouts.length > 0;
    // Sin datos del anillo en el día, los pasos que los propios entrenos a pie trajeron siguen siendo pasos del día.
    const ownSteps = ambulatoryWorkoutSteps(shares);
    const ownTotal = Object.values(ownSteps).reduce((a, b) => a + b, 0);
    return {
      ...base,
      hasData: hasWorkouts,
      steps: ownTotal > 0 ? ownTotal : null,
      stepsSource: ownTotal > 0 ? 'workouts' : 'none',
      workoutSteps: ownSteps,
      distanceM: hasWorkouts ? round(workoutDistance) : null,
      activeKcal: hasWorkouts ? round(workoutKcal) : null,
      basalKcal: hasWorkouts ? basal() : null,
      totalKcal: hasWorkouts ? round(workoutKcal + basal()) : null,
      walking: { steps: 0, distanceM: 0, kcal: 0 },
      ignoredSteps: 0,
      hourlySteps: null,
      ringReportedDistanceM: null,
      lastDataMs: null,
    };
  }

  // Total de pasos: el contador acumulado y la suma de tramos son dos vistas del mismo dato; si el
  // anillo solo dio una parte de los tramos, el contador es la verdad. Se usa el mayor.
  const total = Math.round(Math.max(bucketSteps, counterMax ?? 0));
  const stepsSource: DayActivity['stepsSource'] = counterMax !== null && counterMax >= bucketSteps ? 'counter' : 'buckets';
  if (counterMax !== null && bucketSteps > 0) {
    const gap = Math.abs(counterMax - bucketSteps) / Math.max(counterMax, bucketSteps);
    if (gap > 0.2) {
      notes.push(`Las dos fuentes de pasos del anillo difieren (${Math.round(counterMax)} frente a ${Math.round(bucketSteps)}); se usa la mayor.`);
    }
  }

  // Hasta cuándo sabe el anillo lo que se anduvo: la última lectura del contador o el final del último tramo. Lo que un
  // entreno en directo contó DESPUÉS (aún sin sincronizar) no está en los pasos del anillo y se suma aparte.
  const ringKnownUntil = Math.max(maxOf(clipped.map((b) => b.endMs)), maxOf(rawCounters.filter((c) => c.steps > 0).map((c) => c.tsMs)), 0);

  // Ventanas de entrenamiento fusionadas (si dos se solapan por error, no se descuenta dos veces). Incluyen los que
  // vienen de la víspera: su parte posterior a medianoche tampoco es un paseo aparte.
  // Los de la víspera solo cubren si el propio entreno explica sus pasos (distancia, pasos propios o un deporte sin
  // desplazamiento, cuyos pasos se ignoran): uno a pie SIN distancia ni pasos propios deriva su distancia de los pasos de
  // su día de inicio y los de después de medianoche no los explica nadie, así que cuentan como paseo.
  const coveringCarry = carryOver.filter((w) => sportById(w.sport).kind !== 'ambulatory' || (w.distanceM ?? 0) > 0 || (w.steps ?? 0) > 0);
  const allWorkouts = [...input.workouts, ...coveringCarry];
  const windows = mergeIntervals(allWorkouts.map((w) => [w.startMs, w.endMs] as [number, number]));
  // Lo que reclaman los entrenos en los que no se anda, SIN pisar lo que reclamó antes otro entreno (cada paso es de uno
  // solo: si no, los de un paseo que se solapa con una bici se restarían y se atribuirían al paseo a la vez). En esas
  // franjas los pasos del anillo no son andar: la bici mueve la muñeca.
  const claimedToday = mergeIntervals(input.workouts.map((w) => [w.startMs, w.endMs] as [number, number]));
  const nonAmbulatoryWindows = mergeIntervals([
    ...shares.filter((share) => !share.ambulatory).flatMap((share) => share.exclusive),
    ...coveringCarry.filter((w) => sportById(w.sport).kind !== 'ambulatory').flatMap((w) => subtractIntervals(w.startMs, w.endMs, claimedToday)),
  ]);

  // Línea base: lo que se estima con los pasos del anillo, tramo a tramo, descontando lo cubierto por entrenos.
  let walkSteps = 0;
  let walkDistance = 0;
  let walkKcal = 0;
  let ignoredSteps = 0;
  for (const bucket of clipped) {
    const durationMs = bucket.endMs - bucket.startMs;
    const covered = coveredFraction(bucket.startMs, bucket.endMs, windows);
    const free = bucket.steps * (1 - covered);
    ignoredSteps += bucket.steps * coveredFraction(bucket.startMs, bucket.endMs, nonAmbulatoryWindows);
    if (free <= 0) continue;
    const loco = walkingFromSteps(free, durationMs > 0 ? durationMs * (1 - covered) : null, stride, profile.weightKg);
    walkSteps += free;
    walkDistance += loco.distanceM;
    walkKcal += loco.kcal;
  }

  const hourlyResult = hourly(clipped, dayCounters, total, bucketSteps, dayStart, nonAmbulatoryWindows);

  // Lo que se lleva cada entreno de los pasos del día, y qué pasos no son de nadie:
  // - sin hora: los que el contador tiene y los tramos no (p. ej. el tramo que sigue abierto), más los que el anillo contó en
  //   la ventana de un entreno a pie y que el propio entreno no se atribuye (una pausa). Se estiman como caminar sin ventana.
  // - sin sincronizar: los pasos propios que un entreno en directo contó después de la última lectura del anillo.
  let leftover = Math.max(0, total - bucketSteps);
  let strays = 0;
  let extraSteps = 0;
  let extraIgnored = 0;
  let ownTotal = 0;
  const attributed: Record<string, number> = {};
  for (const share of shares) {
    const w = share.workout;
    const own = (w.steps ?? 0) * share.dayShare;
    // Solo cuenta lo que cae en este día: un entreno que cruza la medianoche reparte sus pasos entre los dos.
    const after = fractionAfter({ startMs: Math.max(w.startMs, dayStart), endMs: Math.min(w.endMs, dayEnd) }, ringKnownUntil);
    // De sus pasos propios, los que el anillo ya tenía cuando se sincronizó.
    const known = own * (1 - after);
    if (!share.ambulatory) {
      // Pasos que el anillo contó pedaleando que los tramos aún no reflejan: ya están en el contador y no se suman.
      extraIgnored += Math.max(0, known - share.inWindow);
      continue;
    }
    let mine = share.inWindow;
    if (own > 0) {
      // Sus pasos de después de la última lectura del anillo no están en el total: se suman aparte y son suyos.
      const afterPart = own * after;
      extraSteps += afterPart;
      let covered: number;
      if (known > share.inWindow) {
        // Pasos del entreno que los tramos no cubren: si el anillo ya los tenía, están en el contador y ya van en la
        // distancia del entreno, no como paseo.
        leftover = Math.max(0, leftover - (known - share.inWindow));
        covered = known;
      } else {
        // El anillo contó más dentro de la ventana de lo que el entreno se atribuye. Si el entreno tiene distancia propia (GPS
        // o escrita), su ventana ya está cubierta y solo la pausa puede haber sido caminar aparte; si no, esa diferencia es
        // caminar (una pausa, o pasos que el enlace perdió). Lo que no es paseo es del entreno: el enlace pudo caerse antes
        // de que acabara, y los pasos que el anillo contó en su ventana no pueden quedar sin dueño.
        let stray = share.inWindow - known;
        if ((w.distanceM ?? 0) > 0) {
          const length = w.endMs - w.startMs;
          const pausedShare = length > 0 ? Math.min(1, Math.max(0, w.pausedMs) / length) : 0;
          stray = Math.min(stray, share.inWindow * pausedShare);
        }
        strays += stray;
        covered = share.inWindow - stray;
      }
      mine = covered + afterPart;
    }
    ownTotal += mine;
    if (mine >= 0.5) attributed[w.id] = Math.round(mine);
  }
  const unlocated = leftover + strays;
  if (unlocated > 0) {
    const loco = walkingFromSteps(unlocated, null, stride, profile.weightKg);
    walkSteps += unlocated;
    walkDistance += loco.distanceM;
    walkKcal += loco.kcal;
  }

  // Pasos contados durante deportes sin andar: los de los tramos que caen en esas franjas, los que el contador tiene de
  // más cuando el propio entreno los trajo y los tramos aún no los reflejan, y los que se ven en el contador por horas.
  const ignored = Math.min(total, Math.max(ignoredSteps + extraIgnored, hourlyResult.excluded));
  // Pasos del día según el anillo, sin esos, más lo que los entrenos en directo contaron tras la última lectura.
  const ringSteps = total - ignored + extraSteps;

  // Conservación: entre lo que caminas fuera de entrenos y lo que los entrenos a pie se atribuyen no puede haber más pasos
  // de los que hay. Un tramo grueso que desborda la ventana de un entreno puede hacer que lo «libre» salga de más; se
  // recorta a lo que queda.
  const maxWalk = Math.max(0, ringSteps - ownTotal);
  if (walkSteps > maxWalk + 0.5) {
    const factor = walkSteps > 0 ? maxWalk / walkSteps : 0;
    walkSteps *= factor;
    walkDistance *= factor;
    walkKcal *= factor;
  }
  // Pasos del día: los del anillo sin los de los deportes en los que no se anda y con los de los entrenos en directo aún sin
  // sincronizar. Si, con datos que no cuadran, andar + lo que se atribuyen los entrenos pasa de eso, manda esa suma: el total
  // nunca es menor que sus partes.
  const steps = Math.max(Math.round(ringSteps), Math.round(walkSteps + ownTotal));

  const workoutDistance = sumDistances(workouts);
  const workoutKcal = workouts.reduce((a, w) => a + w.kcal, 0);

  for (const w of workouts) {
    if (sportById(w.sport).kind === 'cycling' && w.distanceM === null) {
      notes.push('Hay un entrenamiento de ciclismo sin distancia registrada: cuenta para las calorías, no para la distancia.');
      break;
    }
  }
  if (ignored >= 1) {
    notes.push(`No se suman ${Math.round(ignored)} pasos que el anillo contó durante deportes en los que no se anda.`);
  }
  const boundary = `${String(startHour).padStart(2, '0')}:00`;
  for (const share of shares) {
    if (share.ringSteps > 0 && share.dayShare < 0.999) {
      notes.push(
        startHour === 0
          ? `«${sportById(share.workout.sport).name}» cruza la medianoche: su distancia estimada solo recoge los pasos hasta las 00:00; los de después cuentan como paseo del día siguiente.`
          : `«${sportById(share.workout.sport).name}» cruza el cambio de día (las ${boundary}): su distancia estimada solo recoge los pasos hasta esa hora; los de después cuentan como paseo del día siguiente.`,
      );
    }
  }
  if (overlapping) {
    notes.push('Hay entrenamientos que se solapan en el tiempo: sus pasos se atribuyen a uno solo, pero sus calorías se suman tal cual. Si uno está repetido, elimínalo.');
  }
  if (carryOver.length > 0) {
    const carryWindows = mergeIntervals(coveringCarry.map((w) => [w.startMs, w.endMs] as [number, number]));
    const carried = clipped.reduce((sum, b) => sum + b.steps * coveredFraction(b.startMs, b.endMs, carryWindows), 0);
    if (carried >= 1) {
      notes.push(
        `${Math.round(carried)} pasos de este día son del entrenamiento que empezó ayer antes de ${startHour === 0 ? 'medianoche' : `las ${boundary}`}: su distancia y sus calorías se cuentan en el día en que empezó.`,
      );
    }
  }

  const activeKcal = walkKcal + workoutKcal;
  const ringDistance = clipped.reduce((a, b) => a + b.ringDistanceM, 0);
  // La distancia del anillo es la suma de la de sus tramos: solo es «la del día» si los tramos cubren (casi) todos los pasos.
  // Si otra app (Smart Health) ya se llevó parte de ellos del anillo, sumaría una fracción (846 m con 12.628 pasos en una
  // captura real) y se leería como la distancia del día.
  const ringDistanceCovers = bucketSteps >= total * RING_DISTANCE_MIN_COVERAGE;

  return {
    ...base,
    hasData: true,
    steps,
    stepsSource,
    distanceM: round(walkDistance + workoutDistance),
    activeKcal: round(activeKcal),
    basalKcal: basal(),
    totalKcal: round(activeKcal + basal()),
    walking: { steps: Math.round(walkSteps), distanceM: round(walkDistance), kcal: round(walkKcal) },
    ignoredSteps: Math.round(ignored),
    workoutSteps: attributed,
    hourlySteps: hourlyResult.hours,
    ringReportedDistanceM: ringDistance > 0 && ringDistanceCovers ? round(ringDistance) : null,
    lastDataMs: ringKnownUntil > 0 ? ringKnownUntil : null,
  };

  function basal(): number {
    return round(bmrKcalPerDay(profile, day) * elapsedFractionOfDay(day, nowMs, startHour));
  }
}

/**
 * Sin datos del anillo en el día, lo único que se sabe de los pasos son los que trajo cada entreno a pie en directo.
 */
function ambulatoryWorkoutSteps(shares: readonly WorkoutShare[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const share of shares) {
    if (!share.ambulatory) continue;
    const own = Math.round((share.workout.steps ?? 0) * share.dayShare);
    if (own > 0) out[share.workout.id] = own;
  }
  return out;
}

function sumDistances(workouts: readonly WorkoutEstimate[]): number {
  return workouts.reduce((a, w) => a + (w.distanceM ?? 0), 0);
}

/**
 * El contador del anillo cuenta los pasos DESDE MEDIANOCHE y vuelve a 0 al llegar a ella. Un día que empieza a otra hora (el del
 * Resumen, a las 08:00) lo ve reiniciarse a la mitad: aquí se convierte en los pasos DESDE EL INICIO DEL DÍA, que es lo que espera el
 * resto del cálculo. De antes de medianoche se descuenta lo que ya llevaba la primera lectura del día (no hay otra forma de saber
 * cuánto llevaba a las 08:00: sale algo de menos, nunca de más, y los tramos del anillo, que mandan si son más, dicen el resto); lo
 * de después de medianoche suma lo que se anduvo antes. `samples` son las lecturas que caen en [startMs, endMs).
 */
function countersSinceStart(samples: readonly CounterSample[], startMs: number, endMs: number): CounterSample[] {
  const midnight = startOfDayMs(addDays(dayKeyOf(startMs), 1));
  if (midnight >= endMs) return [...samples];
  const positive = samples.filter((c) => c.steps > 0).sort((a, b) => a.tsMs - b.tsMs);
  const before = positive.filter((c) => c.tsMs < midnight);
  const after = positive.filter((c) => c.tsMs >= midnight);
  const base = before[0]?.steps ?? 0;
  const first = before.map((c) => ({ tsMs: c.tsMs, steps: Math.max(0, c.steps - base) }));
  const walked = first.reduce((most, c) => Math.max(most, c.steps), 0);
  return [...first, ...after.map((c) => ({ tsMs: c.tsMs, steps: c.steps + walked }))];
}

/** Fracción de los pasos del día que deben venir en tramos del anillo para dar por buena la suma de sus distancias. */
const RING_DISTANCE_MIN_COVERAGE = 0.9;

/** Entre dos lecturas del contador más separadas que esto no se sabe cuándo se dieron los pasos. */
const MAX_COUNTER_GAP_MS = 3 * HOUR_MS;

/** Reparte `steps` entre las horas locales que toca [startMs, endMs], en proporción al tiempo. */
function spreadOverHours(hours: number[], startMs: number, endMs: number, steps: number): void {
  const length = endMs - startMs;
  if (length <= 0) {
    const h = new Date(startMs).getHours();
    hours[h] = (hours[h] ?? 0) + steps;
    return;
  }
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const sliceEnd = Math.min(endMs, nextHour);
    hours[d.getHours()] = (hours[d.getHours()] ?? 0) + (steps * (sliceEnd - cursor)) / length;
    cursor = sliceEnd;
  }
}

/**
 * Como `spreadOverHours`, sin la parte de [startMs, endMs] que cae en los bloques (lo que ocurre en ellos no cuenta).
 * Devuelve los pasos que quedaron fuera.
 */
function spreadOutsideBlocks(hours: number[], startMs: number, endMs: number, steps: number, blocks: ReadonlyArray<readonly [number, number]>): number {
  if (blocks.length === 0) {
    spreadOverHours(hours, startMs, endMs, steps);
    return 0;
  }
  const length = endMs - startMs;
  if (length <= 0) {
    if (blocks.some(([s, e]) => startMs >= s && startMs <= e)) return steps;
    spreadOverHours(hours, startMs, endMs, steps);
    return 0;
  }
  let kept = 0;
  for (const [s, e] of subtractIntervals(startMs, endMs, blocks)) {
    const portion = (steps * (e - s)) / length;
    spreadOverHours(hours, s, e, portion);
    kept += portion;
  }
  return steps - kept;
}

/**
 * Pasos por hora local. Los tramos del anillo dicen CUÁNDO se dieron los pasos, así que valen si cubren casi todo el
 * total. El contador solo dice cuántos lleva a cada lectura: lo que sube entre dos lecturas cercanas se reparte entre
 * ellas, pero si están muy separadas (o la primera llega muy tarde) no se sabe a qué hora fue y no se dibuja nada: poner
 * todo el incremento en la hora de la lectura mostraría como medido algo que no lo es. Los pasos de las ventanas sin andar
 * (`excluded`, la bici) no se dibujan: la suma de las horas es la de los pasos del día. Devuelve también cuántos pasos dejó
 * fuera por eso (`excluded`), que con solo el contador es la única medida de lo que se contó pedaleando.
 */
function hourly(
  buckets: readonly ClippedBucket[],
  counters: readonly CounterSample[],
  total: number,
  bucketSteps: number,
  dayStart: number,
  excluded: ReadonlyArray<readonly [number, number]>,
): { hours: number[] | null; excluded: number } {
  if (buckets.length > 0 && bucketSteps >= total * 0.8) {
    const hours = new Array<number>(24).fill(0);
    let left = 0;
    for (const b of buckets) left += spreadOutsideBlocks(hours, b.startMs, b.endMs, b.steps, excluded);
    // Un tramo aún abierto (el último, de hasta 30 min) no llega en el historial hasta que se cierra, pero sus pasos ya están en el
    // contador: la bici recién terminada, sin esto, contaba sus «pasos» de manillar como andar justo cuando se mira el resumen.
    left += counterStepsInBlocksAfter(counters, maxOf(buckets.map((b) => b.endMs)), excluded);
    return { hours: hours.map((h) => Math.round(h)), excluded: left };
  }
  if (counters.length >= 2) {
    const sorted = [...counters].sort((a, b) => a.tsMs - b.tsMs);
    const hours = new Array<number>(24).fill(0);
    let left = 0;
    // Una subida entre dos lecturas muy separadas no dice a qué hora se dio: el detalle por horas no se da, pero lo que sí se sabe
    // de las demás (los pasos de las franjas sin andar) no se tira por eso.
    let unknown = false;
    let previousTs = dayStart; // el contador del anillo parte de 0 a medianoche
    let previousSteps = 0;
    for (const c of sorted) {
      const delta = Math.max(0, c.steps - previousSteps);
      if (delta > 0) {
        if (c.tsMs - previousTs > MAX_COUNTER_GAP_MS) unknown = true;
        else left += spreadOutsideBlocks(hours, previousTs, c.tsMs, delta, excluded);
      }
      previousTs = Math.max(previousTs, c.tsMs);
      previousSteps = Math.max(previousSteps, c.steps);
    }
    return { hours: unknown ? null : hours.map((h) => Math.round(h)), excluded: left };
  }
  return { hours: null, excluded: 0 };
}

/**
 * Pasos que el contador subió DESPUÉS de `after` (el final del último tramo cerrado) y que caen en los bloques dados, repartiendo
 * lo que sube entre dos lecturas en proporción al tiempo. Solo cuentan las subidas entre lecturas a menos de `MAX_COUNTER_GAP_MS`.
 */
function counterStepsInBlocksAfter(counters: readonly CounterSample[], after: number, blocks: ReadonlyArray<readonly [number, number]>): number {
  if (blocks.length === 0 || counters.length < 2) return 0;
  const sorted = [...counters].sort((a, b) => a.tsMs - b.tsMs);
  let inBlocks = 0;
  let previousTs: number | null = null;
  let previousSteps = 0;
  for (const c of sorted) {
    if (previousTs !== null && c.tsMs > after && c.steps > previousSteps && c.tsMs - previousTs <= MAX_COUNTER_GAP_MS) {
      const from = Math.max(previousTs, after);
      let overlap = 0;
      for (const [s, e] of blocks) overlap += Math.max(0, Math.min(c.tsMs, e) - Math.max(from, s));
      inBlocks += ((c.steps - previousSteps) * overlap) / (c.tsMs - previousTs);
    }
    previousTs = previousTs === null ? c.tsMs : Math.max(previousTs, c.tsMs);
    previousSteps = Math.max(previousSteps, c.steps);
  }
  return inBlocks;
}
