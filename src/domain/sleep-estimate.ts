import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';

// Sueño estimado, para las noches que el anillo NO ha guardado.
//
// El R99 devuelve el historial de sueño vacío fuera de lo que su firmware considera «noche» (no hay ninguna orden en su SDK para cambiar
// esa franja; ver docs/protocolo-ycbt.md) y aun así mide el pulso cada rato y apunta cada tramo de pasos las 24 h. Con eso se estima
// cuándo se durmió, y se dice que es una estimación: las horas valen ± media hora, no hay fases y solo se usa donde el anillo no ha dado
// nada (una noche del anillo manda siempre, y solo se estima tras haberle pedido el sueño). No se guarda: se calcula al leer.
//
// Cómo (ver docs/estimaciones.md → «Sueño estimado»): la franja de cada 10 minutos es «despierto» o «dormido» y el estado se decide de
// una pasada con un modelo oculto de Markov (Viterbi), con la evidencia de cada franja:
//   · pasos: andar es despertar (muy fuerte); una escapada al baño, no tanto; un rato entero sin ningún paso empuja hacia dormido;
//   · pulso: la persona tiene dos niveles de pulso en reposo (dormido y despierto-quieto) y se sacan de SUS lecturas quietas de los días
//     de alrededor (dos medias), así que no hay umbrales fijos ni dependen de la hora;
//   · hábito: una segunda pasada suma cuándo ha dormido esos días (mismo tramo del día), que ayuda con los horarios regulares y casi
//     nada con los irregulares;
//   · un despertar corto dentro de la noche (el baño) no la parte: tiene su propio estado, barato de entrar y salir (hasta hora y media; más es estar despierto).
// Los límites se afinan con los pasos (tras los últimos antes de dormir, antes de los primeros al despertar).
// La simulación de `sleep-estimate.sim.test.ts` (pulso cada 30 o 60 min, horarios de noche, de día, rotativos e irregulares) lo mide.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BIN = 10 * MIN;
const BINS_PER_DAY = DAY / BIN;
/** Franjas de margen en los extremos de los datos: un tramo dormido que llega hasta ahí no se sabe dónde empieza o acaba. */
const EDGE_BINS = 2;
/** Lo más que dura, en franjas, un despertar dentro de la noche sin partirla. */
const MAX_INSIDE_BINS = 9;

/** Menos que esto no es una noche (las siestas no se estiman: un rato quieto de tarde no es dormir). */
export const MIN_ESTIMATED_SLEEP_MS = 3 * HOUR;
/** Más que esto sin un solo paso ni un pulso alto es un anillo olvidado en una mesa, no una persona dormida. */
export const MAX_ESTIMATED_SLEEP_MS = 14 * HOUR;
/** Los días de datos que hacen falta a cada lado de lo que se estima: calibran el pulso de la persona y su hábito. */
export const BASELINE_DAYS = 9;

const PARAMS = {
  /** Coste (en unidades de evidencia) de pasar de despierto a dormido y al revés. */
  switchCost: 2.9,
  /** Despertar dentro de la noche: entrar, volver a dormirse y cada franja que dura (para que no se trague el día). */
  wakeIn: 0.62,
  wakeBack: 0.5,
  wakeStay: 0.18,
  /** Cada franja sin pasos con datos del anillo empuja un poco hacia dormido. */
  zeroSteps: 0.26,
  /** Lo máximo que cuenta una sola lectura de pulso. */
  hrClip: 3.3,
  /** Lecturas quietas mínimas, en los días de alrededor, para saber los dos niveles de pulso de la persona. */
  minQuiet: 24,
  /** Hábito: peso de la segunda pasada, tope a favor y en contra por franja, y días vecinos que se miran. */
  prior: 0.12,
  priorPos: 0.4,
  priorNeg: 0.3,
  priorDays: 7,
  /** Tras los últimos pasos antes de dormir hay un rato hasta dormirse; antes de los primeros al despertar, un poco despierto. */
  onsetMin: 18,
  wakeLeadMin: 6,
  /** Dos tramos dormidos separados por menos de esto son la misma noche (como la agrupación de la hoja del sueño). */
  mergeGapMs: 90 * MIN,
  /** Una estimación a menos de esto de una noche del anillo es esa misma noche vista de otra manera. */
  nearRealMs: 90 * MIN,
} as const;

export interface SleepEstimateInput {
  /** Todas las lecturas de pulso de los días de alrededor: las del anillo calibran, las medidas a mano y de entrenos son «despierto». */
  heart: readonly HeartSample[];
  buckets: readonly StepBucket[];
  /** Instantáneas del contador de pasos del día: dicen que el anillo estaba ahí, y si subió algo entre dos. */
  counters: readonly CounterSample[];
  /** Entrenos (cualquier cosa con inicio y fin): son momentos despierto. */
  workouts: ReadonlyArray<{ startMs: number; endMs: number }>;
  /** Las sesiones que sí dio el anillo: donde hay una, no se estima. */
  real: readonly SleepSessionRecord[];
  /**
   * Cuándo se le pidió al anillo, por última vez, su historial de sueño (la forma normal de saberlo; `null`: nunca). Una noche solo se
   * estima si acabó ANTES de ese momento: si no, el anillo aún no ha tenido ocasión de darla y lo normal es esperar a que lo haga.
   */
  askedAtMs: number | null;
  /** Solo se devuelven las estimaciones que se solapan con [fromMs, toMs). */
  fromMs: number;
  toMs: number;
}

interface HrModel {
  /** Pulso típico dormido y despierto-quieto, y lo que varía cada uno. */
  asleep: number;
  awake: number;
  sigma: number;
  /** 0–1: cuánto se fía uno de este modelo (con los dos niveles muy juntos, casi nada). */
  trust: number;
}

const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (at(sorted, Math.floor((sorted.length - 1) / 2)) + at(sorted, Math.ceil((sorted.length - 1) / 2))) / 2;
}

const quantile = (sorted: readonly number[], q: number): number => at(sorted, Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length))));

/** Dos medias (k-means de una dimensión): el nivel bajo y el alto de las lecturas quietas de la persona. */
function twoLevels(values: readonly number[]): HrModel | null {
  if (values.length < 8) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let low = quantile(sorted, 0.2);
  let high = quantile(sorted, 0.8);
  if (high - low < 1) return null;
  for (let round = 0; round < 12; round++) {
    const cut = (low + high) / 2;
    let sumLow = 0;
    let countLow = 0;
    let sumHigh = 0;
    let countHigh = 0;
    for (const v of sorted) {
      if (v <= cut) {
        sumLow += v;
        countLow++;
      } else {
        sumHigh += v;
        countHigh++;
      }
    }
    if (countLow === 0 || countHigh === 0) return null;
    const nextLow = sumLow / countLow;
    const nextHigh = sumHigh / countHigh;
    const settled = Math.abs(nextLow - low) < 0.01 && Math.abs(nextHigh - high) < 0.01;
    low = nextLow;
    high = nextHigh;
    if (settled) break;
  }
  const cut = (low + high) / 2;
  let squares = 0;
  for (const v of sorted) squares += (v - (v <= cut ? low : high)) ** 2;
  const sigma = Math.min(9, Math.max(3.5, Math.sqrt(squares / sorted.length)));
  return { asleep: low, awake: high, sigma, trust: Math.min(1, (high - low) / 9) };
}

/** Número de día local (para el hábito): no depende del cambio de hora. */
const localDayIndex = (ms: number): number => {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

const localBinOfDay = (ms: number): number => {
  const d = new Date(ms);
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / (BIN / MIN));
};

/**
 * Las noches que el anillo no ha dado, estimadas. `[]` si no se le ha pedido el sueño, si no hay lecturas de pulso suficientes o si
 * el pulso de la persona no distingue dormida de despierta. Cada estimación es una sesión sin fases con `estimated: true`.
 */
export function estimateSleep(input: SleepEstimateInput): SleepSessionRecord[] {
  if (input.askedAtMs === null) return [];
  const samples = input.heart.filter((s) => s.source === 'ring-auto' && s.bpm >= 30 && s.bpm <= 200).sort((a, b) => a.tsMs - b.tsMs);
  if (samples.length < PARAMS.minQuiet) return [];

  const first = samples[0] as HeartSample;
  const last = samples[samples.length - 1] as HeartSample;
  const t0 = Math.floor(first.tsMs / BIN) * BIN;
  const n = Math.ceil((last.tsMs + BIN - t0) / BIN);
  const bin = (ms: number): number => Math.floor((ms - t0) / BIN);
  const inRange = (i: number): boolean => i >= 0 && i < n;

  // Cada cuánto lee el anillo el pulso (la mediana de los huecos normales).
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const gap = (samples[i] as HeartSample).tsMs - (samples[i - 1] as HeartSample).tsMs;
    if (gap > 0 && gap <= 4 * HOUR) gaps.push(gap);
  }
  const typicalGap = Math.min(90 * MIN, Math.max(20 * MIN, median(gaps) || 60 * MIN));

  // Pasos por franja: de los tramos del anillo y, además, de lo que sube el contador entre dos instantáneas cercanas.
  const walk = new Float32Array(n);
  const spread = (fromMs: number, toMs: number, steps: number, mode: 'sum' | 'max'): void => {
    const end = toMs > fromMs ? toMs : fromMs + MIN;
    const from = Math.max(0, bin(fromMs));
    const to = Math.min(n - 1, bin(end - 1));
    for (let i = from; i <= to; i++) {
      const lo = Math.max(fromMs, t0 + i * BIN);
      const hi = Math.min(end, t0 + (i + 1) * BIN);
      const part = (steps * Math.max(0, hi - lo)) / (end - fromMs);
      walk[i] = mode === 'sum' ? at(walk, i) + part : Math.max(at(walk, i), part);
    }
  };
  for (const bucket of input.buckets) if (bucket.endMs - bucket.startMs <= 3 * HOUR) spread(bucket.startMs, bucket.endMs, bucket.steps, 'sum');
  const counters = [...input.counters].sort((a, b) => a.tsMs - b.tsMs);
  const seen: number[] = samples.map((s) => s.tsMs); // instantes en que el anillo estaba ahí
  counters.forEach((counter, index) => {
    seen.push(counter.tsMs);
    const previous = counters[index - 1];
    if (!previous) return;
    const gap = counter.tsMs - previous.tsMs;
    const sameDay = new Date(counter.tsMs).getDate() === new Date(previous.tsMs).getDate();
    if (sameDay && gap > 0 && gap <= 75 * MIN && counter.steps > previous.steps) spread(previous.tsMs, counter.tsMs, counter.steps - previous.steps, 'max');
  });
  seen.sort((a, b) => a - b);

  // Franjas con datos del anillo a menos de ~¾ de lectura: solo ahí «sin pasos» quiere decir algo (un anillo quitado no duerme).
  const covered = new Uint8Array(n);
  {
    const reach = Math.round(typicalGap * 0.75);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const centre = t0 + i * BIN + BIN / 2;
      while (j < seen.length && at(seen, j) < centre - reach) j++;
      if (j < seen.length && at(seen, j) <= centre + reach) covered[i] = 1;
    }
  }

  // Despierto seguro: entrenos y medidas hechas a mano.
  const awakeHard = new Uint8Array(n);
  for (const w of input.workouts) for (let i = Math.max(0, bin(w.startMs)); i <= Math.min(n - 1, bin(w.endMs)); i++) awakeHard[i] = 1;
  for (const s of input.heart) {
    const i = bin(s.tsMs);
    if (s.source !== 'ring-auto' && inRange(i)) awakeHard[i] = 1;
  }

  // Los dos niveles de pulso de la persona, por día natural, con sus lecturas quietas (sin pasos alrededor) de ±4 días (o ±8).
  const quiet: Array<{ day: number; bpm: number }> = [];
  for (const s of samples) {
    const i = bin(s.tsMs);
    if (!inRange(i) || awakeHard[i] || !covered[i]) continue;
    let near = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) near += at(walk, k);
    if (near <= 3) quiet.push({ day: localDayIndex(s.tsMs), bpm: s.bpm });
  }
  const models = new Map<number, HrModel | null>();
  const modelFor = (day: number): HrModel | null => {
    const known = models.get(day);
    if (known !== undefined) return known;
    let model: HrModel | null = null;
    for (const half of [4, 8]) {
      const values = quiet.filter((q) => Math.abs(q.day - day) <= half).map((q) => q.bpm);
      if (values.length >= PARAMS.minQuiet) {
        model = twoLevels(values);
        break;
      }
    }
    models.set(day, model);
    return model;
  };

  // Evidencia de cada franja a favor de «dormido» (positiva) o de «despierto» (negativa).
  const evidence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = at(walk, i);
    let value = 0;
    if (awakeHard[i]) value = -6;
    else if (w >= 40) value = -4;
    else if (w >= 15) value = -3;
    else if (w >= 5) value = -1.6;
    else if (w >= 1) value = -0.6;
    else if (covered[i]) value = PARAMS.zeroSteps;
    evidence[i] = value;
  }
  const span = Math.max(BIN, typicalGap); // cada lectura habla de ese rato a su alrededor
  for (const s of samples) {
    const model = modelFor(localDayIndex(s.tsMs));
    if (!model) continue;
    const ratio = (((s.bpm - model.awake) ** 2 - (s.bpm - model.asleep) ** 2) / (2 * model.sigma ** 2)) * model.trust;
    const value = Math.max(-PARAMS.hrClip, Math.min(PARAMS.hrClip, ratio));
    const from = Math.max(0, bin(s.tsMs - span / 2));
    const to = Math.min(n - 1, bin(s.tsMs + span / 2 - 1));
    if (to < from) continue;
    for (let i = from; i <= to; i++) evidence[i] = at(evidence, i) + value / (to - from + 1);
  }

  const asleepBins = decode(evidence, n);

  // Segunda pasada: el hábito de la persona (cuándo ha dormido los demás días, a esa hora) refuerza o resta.
  const dayOf = new Int32Array(n);
  const slotOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    dayOf[i] = localDayIndex(t0 + i * BIN + BIN / 2);
    slotOf[i] = localBinOfDay(t0 + i * BIN + BIN / 2);
  }
  const firstDay = at(dayOf, 0);
  const days = at(dayOf, n - 1) - firstDay + 1;
  const asleepAt = new Float32Array(days * BINS_PER_DAY);
  const seenAt = new Float32Array(days * BINS_PER_DAY);
  for (let i = 0; i < n; i++) {
    const cell = (at(dayOf, i) - firstDay) * BINS_PER_DAY + at(slotOf, i);
    seenAt[cell] = 1;
    asleepAt[cell] = at(asleepBins, i);
  }
  let asleepTotal = 0;
  let seenTotal = 0;
  for (let k = 0; k < asleepAt.length; k++) {
    asleepTotal += at(asleepAt, k);
    seenTotal += at(seenAt, k);
  }
  const baseRate = Math.min(0.6, Math.max(0.15, asleepTotal / Math.max(1, seenTotal)));
  const logit = (x: number): number => Math.log(x / (1 - x));
  const withPrior = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const day = at(dayOf, i) - firstDay;
    const slot = at(slotOf, i);
    let asleep = 0;
    let observed = 0;
    for (let other = Math.max(0, day - PARAMS.priorDays); other <= Math.min(days - 1, day + PARAMS.priorDays); other++) {
      if (other === day) continue;
      for (let s = Math.max(0, slot - 3); s <= Math.min(BINS_PER_DAY - 1, slot + 3); s++) {
        asleep += at(asleepAt, other * BINS_PER_DAY + s);
        observed += at(seenAt, other * BINS_PER_DAY + s);
      }
    }
    let prior = 0;
    if (observed >= 6) {
      const rate = Math.min(0.95, Math.max(0.05, asleep / observed));
      prior = Math.max(-PARAMS.priorNeg, Math.min(PARAMS.priorPos, PARAMS.prior * (logit(rate) - logit(baseRate))));
    }
    withPrior[i] = at(evidence, i) + prior;
  }
  const state = decode(withPrior, n);

  // Tramos dormidos, con los límites afinados con los pasos.
  const blocks: Array<{ startMs: number; endMs: number }> = [];
  for (let i = 0; i < n; ) {
    if (!at(state, i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && at(state, j)) j++;
    let startMs = t0 + i * BIN;
    let endMs = t0 + j * BIN;
    let lastWalk = -1;
    for (let k = Math.min(n - 1, i + 3); k >= Math.max(0, i - 12); k--) {
      if (at(walk, k) >= 5) {
        lastWalk = k;
        break;
      }
    }
    if (lastWalk >= 0) startMs = Math.min(endMs, t0 + (lastWalk + 1) * BIN + PARAMS.onsetMin * MIN);
    let firstWalk = -1;
    for (let k = Math.max(0, j - 4); k <= Math.min(n - 1, j + 12); k++) {
      if (at(walk, k) >= 5) {
        firstWalk = k;
        break;
      }
    }
    if (firstWalk >= 0) endMs = Math.max(startMs, t0 + firstWalk * BIN - PARAMS.wakeLeadMin * MIN + BIN / 2);
    // Un tramo pegado al principio o al final de los datos está cortado (empezó antes o sigue en curso): no se sabe cuándo empieza o acaba.
    const cut = i < EDGE_BINS || j > n - EDGE_BINS;
    if (endMs > startMs && !cut) blocks.push({ startMs, endMs });
    i = j;
  }
  // Los tramos separados por un despertar corto son la misma noche.
  const nights: Array<{ startMs: number; endMs: number }> = [];
  for (const block of blocks) {
    const previous = nights[nights.length - 1];
    if (previous && block.startMs - previous.endMs <= PARAMS.mergeGapMs) previous.endMs = Math.max(previous.endMs, block.endMs);
    else nights.push({ ...block });
  }

  const real = [...input.real];
  const out: SleepSessionRecord[] = [];
  for (const { startMs, endMs } of nights) {
    const length = endMs - startMs;
    if (length < MIN_ESTIMATED_SLEEP_MS || length > MAX_ESTIMATED_SLEEP_MS) continue;
    if (endMs <= input.fromMs || startMs >= input.toMs) continue;
    // Primero la forma normal: sin haberle pedido el sueño al anillo después de esa noche, no hay nada que suplir todavía.
    if (endMs > input.askedAtMs) continue;
    if (real.some((r) => r.startMs < endMs + PARAMS.nearRealMs && r.endMs > startMs - PARAMS.nearRealMs)) continue;
    out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), segments: [], estimated: true });
  }
  return out;
}

/**
 * Viterbi de tres estados sobre la evidencia de cada franja: 0 despierto, 1 dormido y 2 despierto DENTRO de la noche (solo entre dos
 * tramos dormidos, para que una escapada al baño no la parta). Devuelve 1 donde se duerme (el despertar de dentro cuenta como parte de la noche).
 */
function decode(evidence: Float32Array, n: number): Uint8Array {
  const none = -1e18;
  const score = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const back = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const [awake, asleep, inside] = score as [Float64Array, Float64Array, Float64Array];
  const [awakeBack, asleepBack, insideBack] = back as [Uint8Array, Uint8Array, Uint8Array];
  awake[0] = 0;
  asleep[0] = -PARAMS.switchCost + at(evidence, 0);
  inside[0] = none;
  for (let i = 1; i < n; i++) {
    const a = at(awake, i - 1);
    const s = at(asleep, i - 1);
    const w = at(inside, i - 1);
    // despierto
    const fromAsleep = s - PARAMS.switchCost;
    if (fromAsleep > a) {
      awake[i] = fromAsleep;
      awakeBack[i] = 1;
    } else {
      awake[i] = a;
      awakeBack[i] = 0;
    }
    // dormido
    let best = s;
    let from = 1;
    if (a - PARAMS.switchCost > best) {
      best = a - PARAMS.switchCost;
      from = 0;
    }
    if (w - PARAMS.wakeBack > best) {
      best = w - PARAMS.wakeBack;
      from = 2;
    }
    asleep[i] = best + at(evidence, i);
    asleepBack[i] = from;
    // despierto dentro de la noche
    const enter = s - PARAMS.wakeIn;
    const stay = w - PARAMS.wakeStay;
    if (enter > stay) {
      inside[i] = enter;
      insideBack[i] = 1;
    } else {
      inside[i] = stay;
      insideBack[i] = 2;
    }
  }
  const state = new Uint8Array(n);
  let current = at(asleep, n - 1) > at(awake, n - 1) ? 1 : 0;
  for (let i = n - 1; i >= 0; i--) {
    state[i] = current;
    current = at(current === 0 ? awakeBack : current === 1 ? asleepBack : insideBack, i);
  }
  // Un despertar de dentro de la noche que dura más que esto es estar despierto (un entreno, una caminata larga), no una escapada.
  for (let i = 0; i < n; ) {
    if (at(state, i) !== 2) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && at(state, j) === 2) j++;
    state.fill(j - i > MAX_INSIDE_BINS ? 0 : 1, i, j);
    i = j;
  }
  return state;
}
