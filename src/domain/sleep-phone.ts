import { BIN, HOUR, MIN, PARAMS, calibrationOf, dayAndSlot, decode, pairsWithKnown, withHabit, MAX_ESTIMATED_SLEEP_MS, MIN_ESTIMATED_SLEEP_MS, type KnownNight, type SleepParams, type Span } from './sleep-estimate';
import { coveredMs, mergeSpans, type PhoneActivity } from './phone-activity';
import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';

// Sueño estimado para las noches SIN ANILLO a partir de lo que hizo el MÓVIL (ronda 57).
//
// Quien deja el anillo de noche no tiene pulso ni pasos que mirar. Lo que sí hay es el móvil: cuándo se encendió la pantalla o se desbloqueó (ver `phone-activity.ts`: solo horas), y
// además lo de siempre —los pasos del anillo de día, lo anotado (comidas, agua), las veces que se abrió la app—. Todo eso son marcas de «estaba despierta»: una noche es el rato largo
// en que no hay ninguna.
//
// Cómo: la misma máquina que la estimación con anillo (`sleep-estimate.ts`): franjas de 10 minutos con un modelo oculto de Markov (despierto / dormido / despierto dentro de la noche, que
// absorbe mirar el móvil a las 3 sin partir la noche) y el hábito de la persona. La evidencia de cada franja es:
//   · uso del móvil, entreno, pasos, algo anotado: despierta (muy fuerte con el móvil: no se mira la pantalla dormido);
//   · sin nada de eso y CON cobertura (el registro estaba leído): empuja hacia dormido, más por la noche que a mediodía;
//   · sin cobertura: nada (un móvil apagado no duerme).
// Los límites van tras el último uso (un rato de tardar en dormirse) y antes del primero (un rato despierta en la cama), y con las noches que la persona corrigió a mano (o que dio el
// anillo) se ve cuánto se adelanta o retrasa la estimación y se corrige ese sesgo.
// La simulación de `sleep-phone.sim.test.ts` (personas que usan el móvil en la cama, lo miran de madrugada, lo apagan algunas noches…) lo mide.

export const PHONE_PARAMS = {
  /** Evidencia de una franja con el móvil en uso, con un paso (por el contador) y de lo anotado o sincronizado. */
  useEvidence: -5,
  workoutEvidence: -6,
  loggedEvidence: -4,
  syncEvidence: -3,
  /** Franja sin cobertura del registro: ni dormido ni despierto, pero una noche no la atraviesa. */
  uncoveredEvidence: -3,
  /** Cada franja sin nada, con cobertura: empuja hacia dormido (de noche) o poco (de día). */
  quietDrift: 0.2,
  /** El hábito de las 24 h cuando aún no se sabe nada de la persona: de noche empuja a favor, a mediodía en contra (en franjas de 10 min). */
  nightPrior: 0.12,
  dayPrior: -0.12,
  /** Tras el último uso hasta dormirse, y desde despertar hasta el primer uso (min). */
  latencyMin: 15,
  leadMin: 8,
  /** Fracción de una franja que tiene que estar cubierta por el registro. */
  coverageShare: 0.7,
  /** Lo que mira hacia atrás y hacia delante para el límite de una noche. */
  edgeReachMs: 2 * HOUR,
};
export type PhoneParams = typeof PHONE_PARAMS;

export interface PhoneSleepInput {
  phone: PhoneActivity;
  buckets: readonly StepBucket[];
  counters: readonly CounterSample[];
  heart: readonly HeartSample[];
  workouts: ReadonlyArray<{ startMs: number; endMs: number }>;
  /** Instantes en que se anotó una comida o se bebió, y de sincronizaciones con la app abierta. */
  logged: readonly number[];
  syncs: readonly number[];
  /** Las noches conocidas (del anillo o corregidas a mano): donde hay una no se estima y con ellas se corrige el sesgo. */
  real: readonly SleepSessionRecord[];
  askedAtMs: number | null;
  fromMs: number;
  toMs: number;
}

/** Las noches de la persona que se deducen del móvil. `[]` si no se le ha pedido el sueño al anillo o no hay cobertura del registro del móvil. */
export function estimateSleepFromPhone(input: PhoneSleepInput, params: PhoneParams = PHONE_PARAMS, model: SleepParams = PARAMS): SleepSessionRecord[] {
  if (input.askedAtMs === null) return [];
  const nights = candidatePhoneNights(input, params, model);
  const shift = calibrationOf(nights, input.real, model);
  const out: SleepSessionRecord[] = [];
  for (const night of nights) {
    const startMs = night.startMs - (shift?.startMs ?? 0);
    const endMs = night.endMs - (shift?.endMs ?? 0);
    const length = endMs - startMs;
    if (length < MIN_ESTIMATED_SLEEP_MS || length > MAX_ESTIMATED_SLEEP_MS) continue;
    if (endMs <= input.fromMs || startMs >= input.toMs) continue;
    if (endMs > input.askedAtMs) continue;
    if (input.real.some((r) => r.startMs < endMs + model.nearRealMs && r.endMs > startMs - model.nearRealMs)) continue;
    out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), segments: [], estimated: true });
  }
  return out;
}

/**
 * La prueba con los datos de la propia persona: en cada noche conocida (la guardó el anillo o la corrigió ella), qué habría estimado la app con el móvil SIN saberla (en bruto, sin la
 * calibración). Ver `backtestEstimate` en `sleep-estimate.ts`, que hace lo mismo con la estimación con anillo.
 */
export function backtestPhoneSleep(input: PhoneSleepInput, params: PhoneParams = PHONE_PARAMS, model: SleepParams = PARAMS): KnownNight[] {
  return pairsWithKnown(candidatePhoneNights(input, params, model), input.real, model);
}

/** Las noches que salen de los datos, sin mirar lo que el anillo guardó ni lo que se pidió (eso lo decide quien las usa). */
export function candidatePhoneNights(input: PhoneSleepInput, p: PhoneParams, model: SleepParams): Span[] {
  const coverage = mergeSpans(input.phone.coverage, 0);
  if (coverage.length === 0) return [];
  const first = (coverage[0] as Span).startMs;
  const last = (coverage[coverage.length - 1] as Span).endMs;
  const t0 = Math.floor(first / BIN) * BIN;
  const n = Math.ceil((last - t0) / BIN);
  if (n < 12) return [];
  const bin = (ms: number): number => Math.floor((ms - t0) / BIN);
  const inRange = (i: number): boolean => i >= 0 && i < n;
  const at = <T>(values: ArrayLike<T>, index: number): T => values[index] as T;

  // Cobertura de cada franja.
  const covered = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (coveredMs(coverage, t0 + i * BIN, t0 + (i + 1) * BIN) >= p.coverageShare * BIN) covered[i] = 1;

  // Las marcas de «estaba despierta»: tramos con su evidencia (del móvil, del anillo de día y de la app).
  interface Mark {
    startMs: number;
    endMs: number;
    value: number;
  }
  const marks: Mark[] = [];
  for (const use of input.phone.uses) marks.push({ startMs: use.startMs, endMs: Math.max(use.endMs, use.startMs + 1), value: p.useEvidence });
  const stepsPerBin = new Float32Array(n);
  for (const bucket of input.buckets) {
    if (bucket.endMs - bucket.startMs > 3 * HOUR || bucket.steps < 1) continue;
    const from = Math.max(0, bin(bucket.startMs));
    const to = Math.min(n - 1, bin(Math.max(bucket.startMs, bucket.endMs - 1)));
    for (let i = from; i <= to; i++) {
      const lo = Math.max(bucket.startMs, t0 + i * BIN);
      const hi = Math.min(Math.max(bucket.endMs, bucket.startMs + 1), t0 + (i + 1) * BIN);
      stepsPerBin[i] = at(stepsPerBin, i) + (bucket.steps * Math.max(0, hi - lo)) / Math.max(1, bucket.endMs - bucket.startMs);
    }
  }
  const counters = [...input.counters].sort((a, b) => a.tsMs - b.tsMs);
  counters.forEach((counter, index) => {
    const previous = counters[index - 1];
    const sameDay = previous !== undefined && new Date(counter.tsMs).getDate() === new Date(previous.tsMs).getDate();
    if (previous && sameDay && counter.tsMs - previous.tsMs <= 75 * MIN && counter.steps > previous.steps) {
      const from = Math.max(0, bin(previous.tsMs));
      const to = Math.min(n - 1, bin(counter.tsMs));
      for (let i = from; i <= to; i++) stepsPerBin[i] = Math.max(at(stepsPerBin, i), (counter.steps - previous.steps) / (to - from + 1));
    }
  });
  for (const w of input.workouts) marks.push({ startMs: w.startMs, endMs: Math.max(w.endMs, w.startMs + 1), value: p.workoutEvidence });
  for (const s of input.heart) if (s.source !== 'ring-auto') marks.push({ startMs: s.tsMs, endMs: s.tsMs + 1, value: p.loggedEvidence });
  for (const ms of input.logged) marks.push({ startMs: ms, endMs: ms + 1, value: p.loggedEvidence });
  for (const ms of input.syncs) marks.push({ startMs: ms, endMs: ms + 1, value: p.syncEvidence });
  // Los pasos del anillo cuentan como marca (con su valor según cuántos) en los tramos donde hay pasos suficientes.
  const stepMarks: Mark[] = [];
  for (let i = 0; i < n; i++) {
    const w = at(stepsPerBin, i);
    const value = w >= 40 ? -4 : w >= 15 ? -3 : w >= 5 ? -1.6 : w >= 1 ? -0.6 : 0;
    if (value !== 0) stepMarks.push({ startMs: t0 + i * BIN, endMs: t0 + (i + 1) * BIN, value });
  }

  // Evidencia de cada franja: la más fuerte de las marcas que la tocan; sin ninguna (y con cobertura), empuja hacia dormido, más de noche que de día.
  const { dayOf, slotOf } = dayAndSlot(t0, n);
  const strongest = new Float32Array(n);
  const touch = (m: Mark): void => {
    const from = Math.max(0, bin(m.startMs));
    const to = Math.min(n - 1, bin(Math.max(m.startMs, m.endMs - 1)));
    for (let i = from; i <= to; i++) if (m.value < at(strongest, i)) strongest[i] = m.value;
  };
  for (const m of marks) touch(m);
  for (const m of stepMarks) touch(m);
  const slotsPerHour = HOUR / BIN;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const awake = at(strongest, i);
    if (awake < 0) {
      base[i] = awake;
      continue;
    }
    // Sin cobertura no se sabe nada: no se puede decir que durmió ahí (un móvil apagado no duerme), y una noche no atraviesa un tramo sin registro.
    if (!covered[i]) {
      base[i] = p.uncoveredEvidence;
      continue;
    }
    const hour = at(slotOf, i) / slotsPerHour;
    const circadian = hour >= 23 || hour < 7 ? p.nightPrior : hour >= 11 && hour < 19 ? p.dayPrior : 0;
    base[i] = p.quietDrift + circadian;
  }

  // Primera pasada, hábito aprendido de ella y segunda pasada.
  const first1 = decode(base, n, model);
  const state = decode(withHabit(base, first1, dayOf, slotOf, model), n, model);

  // Los tramos dormidos: sus límites van tras el último uso y antes del primero.
  const acts: Span[] = [...marks.map((m) => ({ startMs: m.startMs, endMs: m.endMs })), ...stepMarks.filter((m) => m.value <= -1.6).map((m) => ({ startMs: m.startMs, endMs: m.endMs }))].sort(
    (a, b) => a.startMs - b.startMs,
  );
  const lastActivityBefore = (ms: number): number | undefined => {
    let found: number | undefined;
    for (const a of acts) {
      if (a.startMs > ms) break;
      if (a.endMs <= ms && (found === undefined || a.endMs > found)) found = a.endMs;
    }
    return found;
  };
  const firstActivityAfter = (ms: number): number | undefined => {
    for (const a of acts) if (a.startMs >= ms) return a.startMs;
    return undefined;
  };
  const blocks: Span[] = [];
  for (let i = 0; i < n; ) {
    if (!at(state, i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && at(state, j)) j++;
    let startMs = t0 + i * BIN;
    let endMs = t0 + j * BIN;
    const before = lastActivityBefore(startMs + BIN);
    if (before !== undefined && startMs - before <= p.edgeReachMs) startMs = Math.min(endMs, Math.max(before + p.latencyMin * MIN, before));
    const after = firstActivityAfter(endMs - BIN);
    if (after !== undefined && after - endMs <= p.edgeReachMs) endMs = Math.max(startMs, Math.min(endMs, after - p.leadMin * MIN));
    // Un tramo pegado al principio o al final de lo cubierto está cortado (empezó antes o sigue en curso).
    const cut = i < 2 || j > n - 2 || !at(covered, i - 1) || !at(covered, j);
    if (endMs > startMs && !cut) blocks.push({ startMs, endMs });
    i = j;
  }
  const nights: Span[] = [];
  for (const block of blocks) {
    const previous = nights[nights.length - 1];
    if (previous && block.startMs - previous.endMs <= model.mergeGapMs) previous.endMs = Math.max(previous.endMs, block.endMs);
    else nights.push({ ...block });
  }
  void inRange;
  return nights;
}
