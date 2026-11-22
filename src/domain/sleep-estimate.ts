import { BREATH_SPEC, HEART_SPEC, blendLevels, evidenceOf, levelsFromLabels, twoLevels, type Level } from './sleep-model';
import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';

// Sueño estimado, para las noches que el anillo NO ha guardado.
//
// El R99 devuelve el historial de sueño vacío fuera de lo que su firmware considera «noche» (no hay ninguna orden en su SDK para cambiar
// esa franja; ver docs/protocolo-ycbt.md) y aun así mide el pulso y la respiración cada rato y apunta cada tramo de pasos las 24 h. Con eso se estima
// cuándo se durmió, y se dice que es una estimación: las horas valen ± media hora o una hora, no hay fases y solo se usa donde el anillo no ha dado
// nada (una noche del anillo manda siempre, y solo se estima tras haberle pedido el sueño). No se guarda: se calcula al leer.
//
// Cómo (ver docs/estimaciones.md → «Sueño estimado»): la franja de cada 10 minutos es «despierto» o «dormido» y el estado se decide de
// una pasada con un modelo oculto de Markov (Viterbi), con la evidencia de cada franja:
//   · pasos: andar es despertar (muy fuerte); una escapada al baño, no tanto; un rato entero sin ningún paso empuja hacia dormido;
//   · pulso Y respiración (`sleep-model.ts`): la persona tiene dos niveles de cada una (dormido y despierto-quieto) y se sacan de SUS lecturas de los días de
//     alrededor, así que no hay umbrales fijos ni dependen de la hora. Los niveles se aprenden dos veces: sin etiquetas y, con la primera pasada, con las
//     lecturas que ya se dieron por dormidas o despiertas (así el rato despierto en la cama, con el pulso a medio camino, no los emborrona);
//   · lo que la persona hizo con la app (anotar una comida o un vaso de agua, medir el pulso a mano): ahí estaba despierta;
//   · hábito: una segunda pasada suma cuándo ha dormido esos días (mismo tramo del día), que ayuda con los horarios regulares y casi
//     nada con los irregulares;
//   · un despertar corto dentro de la noche (el baño) no la parte: tiene su propio estado, barato de entrar y salir (hasta hora y media; más es estar despierto).
// Los límites se afinan con los pasos (tras los últimos antes de dormir, antes de los primeros al despertar) y, por último, con lo que se sabe de la propia
// persona: donde el anillo SÍ guardó noches (o donde ella corrigió la hora), se ve cuánto se adelanta o se retrasa la estimación y se corrige ese sesgo.
// Las simulaciones de `sleep-estimate.sim.test.ts` (pulso cada 30 o 60 min, horarios de noche, de día, rotativos e irregulares, y una vida «dura» con artefactos,
// noches malas, insomnio y rato despierto en la cama) lo miden.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** La franja del modelo: 10 minutos. */
export const BIN = 10 * MIN;
const BINS_PER_DAY = DAY / BIN;
/** Franjas de margen en los extremos de los datos: un tramo dormido que llega hasta ahí no se sabe dónde empieza o acaba. */
const EDGE_BINS = 2;

/** Menos que esto no es una noche (las siestas no se estiman: un rato quieto de tarde no es dormir). */
export const MIN_ESTIMATED_SLEEP_MS = 3 * HOUR;
/** Más que esto sin un solo paso ni un pulso alto es un anillo olvidado en una mesa, no una persona dormida. */
export const MAX_ESTIMATED_SLEEP_MS = 14 * HOUR;
/** Los días de datos que se miran a cada lado de lo que se estima: calibran el pulso y la respiración de la persona, su hábito y, con las noches que sí guardó el anillo, el sesgo de la estimación. */
export const BASELINE_DAYS = 21;

/** Parámetros de la estimación. Las funciones los reciben para que las pruebas de ajuste puedan probar otros valores; la app usa siempre `PARAMS`. */
export const PARAMS = {
  /** Coste (en unidades de evidencia) de pasar de despierto a dormido y al revés. */
  switchCost: 2.9,
  /** Despertar dentro de la noche: entrar, volver a dormirse y cada franja que dura (para que no se trague el día). */
  wakeIn: 0.62,
  wakeBack: 0.5,
  wakeStay: 0.18,
  /** Lo más que dura, en franjas, un despertar dentro de la noche sin partirla. */
  maxInsideBins: 12,
  /** Cada franja sin pasos con datos del anillo empuja un poco hacia dormido. */
  zeroSteps: 0.26,
  /** Lecturas quietas mínimas, en los días de alrededor, para saber los dos niveles de la persona. */
  minQuiet: 24,
  /** Hábito: peso de la segunda pasada, tope a favor y en contra por franja, y días vecinos que se miran. */
  prior: 0.12,
  priorPos: 0.4,
  priorNeg: 0.3,
  priorDays: 7,
  /** Tras los últimos pasos antes de dormir hay un rato hasta dormirse; antes de los primeros al despertar, un poco despierto. */
  onsetMin: 18,
  wakeLeadMin: 6,
  /** Dos tramos dormidos separados por menos de esto son la misma noche (como la agrupación de la hoja del sueño, que junta lo que está a menos de 2 h). */
  mergeGapMs: 2 * HOUR,
  /** Una estimación a menos de esto de una noche del anillo es esa misma noche vista de otra manera. */
  nearRealMs: 90 * MIN,
  /** Cuánto cuenta saber que la persona estaba despierta en un instante (lo que anotó con la app). */
  markEvidence: -4,
  /** Una lectura es «claramente dormida/despierta» (un ancla para colocar los límites) si su evidencia pasa de esto; y las dos anclas de un límite no pueden estar a más de esto. */
  anchorEvidence: 1,
  anchorMaxGapMs: 6 * HOUR,
  /** Lo más que las anclas pueden mover un límite respecto al que decidió el modelo: una lectura suelta (un pico de REM) no debe llevarse media noche por delante. */
  anchorMaxShiftMs: 60 * MIN,
  /** Cuánto del desplazamiento que proponen las anclas se aplica (1: todo; 0: nada, como antes). */
  anchorWeight: 0.6,
  /** 1: el final va casi pegado a los primeros pasos / lo anotado (llegan poco después de despertar); 0: siempre en medio de la última lectura dormida y lo primero que se sabe despierta. */
  endTight: 1,
  /** Dos tramos dormidos separados por hasta esto, con pocos pasos entre ellos (idas al baño) y a lo sumo una lectura claramente despierta, son la misma noche. */
  bridgeGapMs: 3 * HOUR,
  bridgeMaxSteps: 400,
  /** Pasadas de aprendizaje de los niveles con las etiquetas de la anterior. */
  refinePasses: 1,
  /** Cuánto pesan las etiquetas de la pasada anterior frente a los dos niveles sin etiquetas al reentrenar el modelo (1: solo etiquetas). */
  labelWeight: 0.5,
  /** Calibración con noches conocidas: pares mínimos, cuánto se fía (n / (n + esto)) y lo máximo que corrige. */
  calibrationMinPairs: 3,
  calibrationSoft: 3,
  calibrationMaxShiftMs: 60 * MIN,
}

export type SleepParams = { -readonly [K in keyof typeof PARAMS]: number };

export interface SleepEstimateInput {
  /** Todas las lecturas de pulso de los días de alrededor: las del anillo calibran, las medidas a mano y de entrenos son «despierto». */
  heart: readonly HeartSample[];
  buckets: readonly StepBucket[];
  /** Instantáneas del contador de pasos del día: dicen que el anillo estaba ahí, y si subió algo entre dos. */
  counters: readonly CounterSample[];
  /** Entrenos (cualquier cosa con inicio y fin): son momentos despierto. */
  workouts: ReadonlyArray<{ startMs: number; endMs: number }>;
  /** Las sesiones que sí dio el anillo (o que la persona corrigió a mano): donde hay una, no se estima, y con ellas se calibra el sesgo de la estimación. */
  real: readonly SleepSessionRecord[];
  /**
   * Cuándo se le pidió al anillo, por última vez, su historial de sueño (la forma normal de saberlo; `null`: nunca). Una noche solo se
   * estima si acabó ANTES de ese momento: si no, el anillo aún no ha tenido ocasión de darla y lo normal es esperar a que lo haga.
   */
  askedAtMs: number | null;
  /** Solo se devuelven las estimaciones que se solapan con [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  /** Instantes en que la persona estaba despierta por lo que hizo con la app (una comida o un vaso de agua anotados, la app abierta sincronizando). */
  awakeMarks?: readonly number[];
}

export interface Span {
  startMs: number;
  endMs: number;
}

/** Los niveles de la persona (pulso y respiración) para un día. Una señal sin niveles fiables no aporta nada. */
interface DayModel {
  hr: Level | null;
  resp: Level | null;
}

const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (at(sorted, Math.floor((sorted.length - 1) / 2)) + at(sorted, Math.ceil((sorted.length - 1) / 2))) / 2;
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
export function estimateSleep(input: SleepEstimateInput, params: SleepParams = PARAMS): SleepSessionRecord[] {
  if (input.askedAtMs === null) return [];
  const nights = candidateNights(input, params);
  const shift = calibrationOf(nights, input.real, params);

  const real = [...input.real];
  const out: SleepSessionRecord[] = [];
  for (const night of nights) {
    const startMs = night.startMs - (shift?.startMs ?? 0);
    const endMs = night.endMs - (shift?.endMs ?? 0);
    const length = endMs - startMs;
    if (length < MIN_ESTIMATED_SLEEP_MS || length > MAX_ESTIMATED_SLEEP_MS) continue;
    if (endMs <= input.fromMs || startMs >= input.toMs) continue;
    // Primero la forma normal: sin haberle pedido el sueño al anillo después de esa noche, no hay nada que suplir todavía.
    if (endMs > input.askedAtMs) continue;
    if (real.some((r) => r.startMs < endMs + params.nearRealMs && r.endMs > startMs - params.nearRealMs)) continue;
    out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), segments: [], estimated: true });
  }
  return out;
}

/**
 * Las noches que salen de los datos, SIN mirar lo que el anillo guardó ni lo que se pidió (eso lo decide quien las usa): el modelo oculto de Markov sobre franjas de
 * 10 minutos, con los niveles de la persona aprendidos en dos pasadas, el hábito y los límites afinados con los pasos y lo anotado con la app.
 */
function candidateNights(input: SleepEstimateInput, p: SleepParams): Span[] {
  const samples = input.heart.filter((s) => s.source === 'ring-auto' && s.bpm >= 30 && s.bpm <= 200).sort((a, b) => a.tsMs - b.tsMs);
  if (samples.length < p.minQuiet) return [];

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
  // Con una lectura cada hora o menos las etiquetas de la primera pasada son de fiar; con lecturas más espaciadas (cada dos horas) hay pocas por noche y pesan menos.
  const labelWeight = p.labelWeight * (typicalGap <= 45 * MIN ? 1.4 : typicalGap >= 90 * MIN ? 0.5 : 1);

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
  // Despierto por lo que hizo con la app: cuenta mucho, pero no tanto como un entreno (una sincronización automática puede pasar con el móvil sobre la mesilla).
  const marked = new Uint8Array(n);
  for (const ms of input.awakeMarks ?? []) {
    const i = bin(ms);
    if (inRange(i)) marked[i] = 1;
  }

  const { dayOf, slotOf } = dayAndSlot(t0, n);

  // Lo que dice la franja por sí sola: pasos, entrenos y marcas (las lecturas de pulso y respiración se suman después, con los niveles de la persona).
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = at(walk, i);
    let value = 0;
    if (awakeHard[i]) value = -6;
    else if (w >= 40) value = -4;
    else if (w >= 15) value = -3;
    else if (w >= 5) value = -1.6;
    else if (w >= 1) value = -0.6;
    else if (covered[i]) value = p.zeroSteps;
    if (marked[i] && !awakeHard[i]) value = Math.min(value, p.markEvidence);
    base[i] = value;
  }

  // Lecturas quietas (sin pasos alrededor) y el día al que pertenece cada lectura.
  interface Reading {
    day: number;
    bin: number;
    bpm: number;
    resp: number | undefined;
  }
  const readings: Reading[] = samples.map((s) => ({ day: localDayIndex(s.tsMs), bin: bin(s.tsMs), bpm: s.bpm, resp: s.resp }));
  const quiet: Reading[] = [];
  for (const r of readings) {
    if (!inRange(r.bin) || awakeHard[r.bin] || !covered[r.bin]) continue;
    let near = 0;
    for (let k = Math.max(0, r.bin - 2); k <= Math.min(n - 1, r.bin + 2); k++) near += at(walk, k);
    if (near <= 3) quiet.push(r);
  }

  /** Los niveles de cada día con los valores que `pick` saca de las lecturas de ±4 días (o ±8): primero los etiquetados si hay bastantes, y si no, los dos niveles sin etiquetas. */
  const fitModels = (labels: Uint8Array | null, fallback: ((day: number) => DayModel) | null): ((day: number) => DayModel) => {
    const cache = new Map<number, DayModel>();
    // Con etiquetas (la pasada anterior): dormidas = lecturas dentro de una noche (con margen de 20 min a cada lado); despiertas = quietas fuera de ella.
    const sure = (i: number, want: number): boolean => {
      for (let k = i - 2; k <= i + 2; k++) if (inRange(k) && at(labels as Uint8Array, k) !== want) return false;
      return true;
    };
    const asleepReadings: Reading[] = labels ? readings.filter((r) => inRange(r.bin) && !awakeHard[r.bin] && sure(r.bin, 1)) : [];
    const awakeReadings: Reading[] = labels ? quiet.filter((r) => sure(r.bin, 0)) : [];
    return (day: number): DayModel => {
      const known = cache.get(day);
      if (known) return known;
      const model: DayModel = { hr: null, resp: null };
      for (const half of [4, 8]) {
        const near = (r: Reading): boolean => Math.abs(r.day - day) <= half;
        const pick = (list: Reading[], f: (r: Reading) => number | undefined): number[] => list.filter(near).flatMap((r) => {
          const v = f(r);
          return v === undefined ? [] : [v];
        });
        const bpm = (r: Reading): number => r.bpm;
        const resp = (r: Reading): number | undefined => r.resp;
        if (model.hr === null) {
          const plain = pick(quiet, bpm).length >= p.minQuiet ? twoLevels(pick(quiet, bpm), HEART_SPEC) : null;
          const labelled = labels ? levelsFromLabels(pick(asleepReadings, bpm), pick(awakeReadings, bpm), HEART_SPEC) : null;
          model.hr = blendLevels(labelled, plain, labelWeight);
        }
        if (model.resp === null) {
          const plain = pick(quiet, resp).length >= p.minQuiet ? twoLevels(pick(quiet, resp), BREATH_SPEC) : null;
          const labelled = labels ? levelsFromLabels(pick(asleepReadings, resp), pick(awakeReadings, resp), BREATH_SPEC) : null;
          model.resp = blendLevels(labelled, plain, labelWeight);
        }
        if (model.hr !== null && model.resp !== null) break;
      }
      // Sin respaldo en los días con pocas lecturas etiquetadas: lo que dieron los niveles de la pasada anterior.
      if (fallback) {
        const before = fallback(day);
        model.hr ??= before.hr;
        model.resp ??= before.resp;
      }
      cache.set(day, model);
      return model;
    };
  };

  const span = Math.max(BIN, typicalGap); // cada lectura habla de ese rato a su alrededor
  const evidenceWith = (modelFor: (day: number) => DayModel): Float32Array => {
    const evidence = Float32Array.from(base);
    for (const s of samples) {
      const model = modelFor(localDayIndex(s.tsMs));
      let value = 0;
      if (model.hr) value += evidenceOf(model.hr, s.bpm, HEART_SPEC);
      if (model.resp && s.resp !== undefined) value += evidenceOf(model.resp, s.resp, BREATH_SPEC);
      if (value === 0) continue;
      const from = Math.max(0, bin(s.tsMs - span / 2));
      const to = Math.min(n - 1, bin(s.tsMs + span / 2 - 1));
      if (to < from) continue;
      for (let i = from; i <= to; i++) evidence[i] = at(evidence, i) + value / (to - from + 1);
    }
    return evidence;
  };

  // Primera pasada con los niveles sin etiquetas; después, tantas como `refinePasses` aprendiéndolos de las etiquetas de la anterior.
  let modelFor = fitModels(null, null);
  if (!hasAnyModel(readings, modelFor)) return [];
  let evidence = evidenceWith(modelFor);
  let asleepBins = decode(evidence, n, p);
  for (let pass = 0; pass < p.refinePasses; pass++) {
    modelFor = fitModels(asleepBins, modelFor);
    evidence = evidenceWith(modelFor);
    asleepBins = decode(evidence, n, p);
  }

  // Segunda pasada: el hábito de la persona (cuándo ha dormido los demás días, a esa hora) refuerza o resta.
  const state = decode(withHabit(evidence, asleepBins, dayOf, slotOf, p), n, p);

  // Lo que dice cada lectura por sí sola con los niveles finales: las «claramente dormidas» y «claramente despiertas» son las anclas de los límites.
  const anchors = samples.map((s) => {
    const model = modelFor(localDayIndex(s.tsMs));
    let v = 0;
    if (model.hr) v += evidenceOf(model.hr, s.bpm, HEART_SPEC);
    if (model.resp && s.resp !== undefined) v += evidenceOf(model.resp, s.resp, BREATH_SPEC);
    return { tsMs: s.tsMs, v };
  });

  // Tramos dormidos. Los límites se colocan con TRES cosas: lo que decide el modelo; las lecturas claras (entre la última claramente despierta y la primera claramente dormida, que
  // con una lectura por hora pueden estar separadas por mucho rato en el que no se sabe nada, el límite va en medio y no pegado a un lado); y los pasos (nadie se duerme antes de
  // dejar de andar ni sigue dormido cuando echa a andar).
  const lastSteps = (from: number, to: number): number => {
    for (let k = Math.min(n - 1, to); k >= Math.max(0, from); k--) if (at(walk, k) >= 5) return k;
    return -1;
  };
  const firstSteps = (from: number, to: number): number => {
    for (let k = Math.max(0, from); k <= Math.min(n - 1, to); k++) if (at(walk, k) >= 5) return k;
    return -1;
  };
  const markTimes = [...(input.awakeMarks ?? [])].sort((a, b) => a - b);
  const lastMarkBefore = (ms: number, notBefore: number): number | undefined => {
    for (let k = markTimes.length - 1; k >= 0; k--) if ((markTimes[k] as number) < ms) return (markTimes[k] as number) >= notBefore ? (markTimes[k] as number) + 5 * MIN : undefined;
    return undefined;
  };
  const firstMarkAfter = (ms: number, notAfter: number): number | undefined => {
    for (const t of markTimes) if (t > ms) return t <= notAfter ? t - 5 * MIN : undefined;
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
    const blockStart = t0 + i * BIN;
    const blockEnd = t0 + j * BIN;
    const inside = anchors.filter((a) => a.tsMs >= blockStart && a.tsMs < blockEnd);

    // Principio: lo último que se sabe despierta (una lectura claramente despierta, los últimos pasos más lo que se tarda en acostarse, lo último que anotó con la app) y la primera lectura claramente
    // dormida del tramo. Entre las dos no se sabe cuándo se durmió: en medio, y no pegado al principio del tramo (que es adonde empuja el «sin pasos»).
    let startMs = blockStart;
    const firstAsleep = inside.find((a) => a.v >= p.anchorEvidence);
    if (firstAsleep) {
      const bound = firstAsleep.tsMs - p.anchorMaxGapMs;
      const awakeReading = [...anchors].reverse().find((a) => a.tsMs < firstAsleep.tsMs && a.tsMs >= bound && a.v <= -p.anchorEvidence)?.tsMs;
      const walkBin = lastSteps(Math.max(0, Math.floor((bound - t0) / BIN)), Math.floor((firstAsleep.tsMs - t0) / BIN));
      const awakeSteps = walkBin >= 0 ? t0 + (walkBin + 1) * BIN + p.onsetMin * MIN : undefined;
      const awakeMark = lastMarkBefore(firstAsleep.tsMs, bound);
      const awakeAt = Math.max(awakeReading ?? -Infinity, awakeSteps ?? -Infinity, awakeMark ?? -Infinity);
      if (awakeAt > -Infinity && awakeAt < firstAsleep.tsMs) startMs = Math.max(blockStart, Math.min(blockStart + p.anchorMaxShiftMs, firstAsleep.tsMs, (awakeAt + firstAsleep.tsMs) / 2));
      else if (awakeAt >= firstAsleep.tsMs) startMs = Math.max(blockStart, Math.min(blockStart + p.anchorMaxShiftMs, firstAsleep.tsMs));
    } else {
      const lastWalk = lastSteps(i - 12, i + 3);
      if (lastWalk >= 0) startMs = t0 + (lastWalk + 1) * BIN + p.onsetMin * MIN;
    }
    startMs = Math.min(blockStart + p.anchorWeight * (startMs - blockStart), blockEnd);

    // Final: lo mismo al revés (la última lectura claramente dormida y lo primero que se sabe despierta: una lectura claramente despierta, los primeros pasos, lo anotado con la app).
    let endMs = blockEnd;
    const lastAsleep = [...inside].reverse().find((a) => a.v >= p.anchorEvidence);
    if (lastAsleep) {
      const bound = lastAsleep.tsMs + p.anchorMaxGapMs;
      const awakeReading = anchors.find((a) => a.tsMs > lastAsleep.tsMs && a.tsMs <= bound && a.v <= -p.anchorEvidence)?.tsMs;
      const walkBin = firstSteps(Math.floor((lastAsleep.tsMs - t0) / BIN), Math.floor((bound - t0) / BIN));
      const awakeSteps = walkBin >= 0 ? t0 + walkBin * BIN - p.wakeLeadMin * MIN + BIN / 2 : undefined;
      const awakeMark = firstMarkAfter(lastAsleep.tsMs, bound);
      // Los pasos y lo anotado con la app llegan poco después de despertar (el límite va casi pegado a ellos); una lectura despierta puede ser de mucho después (el límite va en medio).
      const tight = Math.min(awakeSteps ?? Infinity, awakeMark ?? Infinity);
      const loose = awakeReading === undefined ? Infinity : (lastAsleep.tsMs + awakeReading) / 2;
      const first = Math.min(awakeReading ?? Infinity, awakeSteps ?? Infinity, awakeMark ?? Infinity);
      const awakeAt = p.endTight ? Math.min(tight, loose) : first < Infinity ? (lastAsleep.tsMs + first) / 2 : Infinity;
      if (awakeAt < Infinity) endMs = Math.min(blockEnd, Math.max(lastAsleep.tsMs, blockEnd - p.anchorMaxShiftMs, awakeAt));
    } else {
      const firstWalk = firstSteps(j - 4, j + 12);
      if (firstWalk >= 0) endMs = t0 + firstWalk * BIN - p.wakeLeadMin * MIN + BIN / 2;
    }
    endMs = Math.max(blockEnd + p.anchorWeight * (endMs - blockEnd), startMs);

    // Un tramo pegado al principio o al final de los datos está cortado (empezó antes o sigue en curso): no se sabe cuándo empieza o acaba.
    const cut = i < EDGE_BINS || j > n - EDGE_BINS;
    if (endMs > startMs && !cut) blocks.push({ startMs, endMs });
    i = j;
  }
  // Los tramos separados por un despertar corto son la misma noche; también si el hueco es algo más largo pero solo hay unos pasos sueltos (idas al baño) y casi ninguna lectura que diga despierta.
  const stepsBetween = (fromMs: number, toMs: number): number => {
    let total = 0;
    for (let k = Math.max(0, bin(fromMs)); k <= Math.min(n - 1, bin(toMs)); k++) total += at(walk, k);
    return total;
  };
  const clearAwakeBetween = (fromMs: number, toMs: number): number => anchors.filter((a) => a.tsMs > fromMs && a.tsMs < toMs && a.v <= -p.anchorEvidence).length;
  const nights: Span[] = [];
  for (const block of blocks) {
    const previous = nights[nights.length - 1];
    const gap = previous ? block.startMs - previous.endMs : Infinity;
    const bridges = previous && gap <= p.bridgeGapMs && stepsBetween(previous.endMs, block.startMs) <= p.bridgeMaxSteps && clearAwakeBetween(previous.endMs, block.startMs) <= 1;
    if (previous && (gap <= p.mergeGapMs || bridges)) previous.endMs = Math.max(previous.endMs, block.endMs);
    else nights.push({ ...block });
  }
  return nights;
}

/**
 * La evidencia con el hábito de la persona sumado: en cada franja del día, cuánto ha dormido en las mismas franjas (±30 min) los demás días de alrededor (a lo sumo `priorDays`
 * a cada lado) frente a lo normal en ella, a partir de lo que dio una primera pasada (`asleepBins`). Ayuda con los horarios regulares y casi nada con los irregulares.
 */
export function withHabit(evidence: Float32Array, asleepBins: Uint8Array, dayOf: Int32Array, slotOf: Int32Array, p: SleepParams): Float32Array {
  const n = evidence.length;
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
    for (let other = Math.max(0, day - p.priorDays); other <= Math.min(days - 1, day + p.priorDays); other++) {
      if (other === day) continue;
      for (let s = Math.max(0, slot - 3); s <= Math.min(BINS_PER_DAY - 1, slot + 3); s++) {
        asleep += at(asleepAt, other * BINS_PER_DAY + s);
        observed += at(seenAt, other * BINS_PER_DAY + s);
      }
    }
    let prior = 0;
    if (observed >= 6) {
      const rate = Math.min(0.95, Math.max(0.05, asleep / observed));
      prior = Math.max(-p.priorNeg, Math.min(p.priorPos, p.prior * (logit(rate) - logit(baseRate))));
    }
    withPrior[i] = at(evidence, i) + prior;
  }
  return withPrior;
}

/** Número de día local y franja de 10 min del día de cada franja de `n` desde `t0` (para el hábito: no depende del cambio de hora). */
export function dayAndSlot(t0: number, n: number): { dayOf: Int32Array; slotOf: Int32Array } {
  const dayOf = new Int32Array(n);
  const slotOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    dayOf[i] = localDayIndex(t0 + i * BIN + BIN / 2);
    slotOf[i] = localBinOfDay(t0 + i * BIN + BIN / 2);
  }
  return { dayOf, slotOf };
}

/** ¿Distingue la persona dormida de despierta con alguna de las dos señales? (Sin eso, solo quedarían los pasos y no se opina.) */
function hasAnyModel(readings: ReadonlyArray<{ day: number }>, modelFor: (day: number) => DayModel): boolean {
  const seenDays = new Set(readings.map((r) => r.day));
  for (const day of seenDays) {
    const model = modelFor(day);
    if (model.hr || model.resp) return true;
  }
  return false;
}

// ───────────────────────────── calibración con noches conocidas ─────────────────────────────

/** Junta las sesiones que están a menos de lo que junta la hoja del sueño (como `groupSleep`): una noche partida por un despertar largo es una sola. */
function mergeSessions(sessions: readonly SleepSessionRecord[], p: SleepParams): Span[] {
  const sorted = sessions.filter((s) => s.endMs > s.startMs).sort((a, b) => a.startMs - b.startMs);
  const merged: Span[] = [];
  for (const s of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && s.startMs - previous.endMs <= p.mergeGapMs) previous.endMs = Math.max(previous.endMs, s.endMs);
    else merged.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return merged;
}

const overlapMs = (a: Span, b: Span): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** Las noches conocidas (las del anillo o las corregidas a mano) con la estimación que se habría hecho sin saberlas. */
export interface KnownNight {
  known: Span;
  estimate: Span;
}

export function pairsWithKnown(nights: readonly Span[], real: readonly SleepSessionRecord[], p: SleepParams): KnownNight[] {
  const pairs: KnownNight[] = [];
  for (const known of mergeSessions(real, p)) {
    if (known.endMs - known.startMs < MIN_ESTIMATED_SLEEP_MS) continue;
    let best: Span | null = null;
    let bestIou = 0;
    for (const night of nights) {
      const common = overlapMs(night, known);
      const iou = common / (night.endMs - night.startMs + (known.endMs - known.startMs) - common);
      if (iou > bestIou) {
        bestIou = iou;
        best = night;
      }
    }
    // Solo es «la misma noche» si se parecen: un hueco enorme entre las dos es otra cosa (otro tramo del día o una detección rota).
    if (best && bestIou >= 0.5) pairs.push({ known, estimate: { ...best } });
  }
  return pairs;
}

/**
 * Cuánto se adelanta (+) o se retrasa (−) la estimación respecto a lo que se sabe de la propia persona. Mide los pares «noche conocida / estimación sin ella» y, con al
 * menos tres, devuelve el desvío mediano del inicio y del final, atenuado cuando hay pocos pares y acotado. `null` si no hay pares bastantes.
 */
export function calibrationOf(nights: readonly Span[], real: readonly SleepSessionRecord[], p: SleepParams): { startMs: number; endMs: number; pairs: number } | null {
  const pairs = pairsWithKnown(nights, real, p);
  if (pairs.length < p.calibrationMinPairs) return null;
  const trust = pairs.length / (pairs.length + p.calibrationSoft);
  const clamp = (ms: number): number => Math.max(-p.calibrationMaxShiftMs, Math.min(p.calibrationMaxShiftMs, ms));
  return {
    startMs: clamp(median(pairs.map((p) => p.estimate.startMs - p.known.startMs)) * trust),
    endMs: clamp(median(pairs.map((p) => p.estimate.endMs - p.known.endMs)) * trust),
    pairs: pairs.length,
  };
}

/**
 * La prueba con los datos de la propia persona: en cada noche conocida (la guardó el anillo o la corrigió ella), qué habría estimado la app SIN saberla. Sirve para decir
 * cuánto se equivoca en su caso y para ver si la calibración tiene de dónde aprender. No usa la calibración (mide la estimación en bruto).
 */
export function backtestEstimate(input: SleepEstimateInput, params: SleepParams = PARAMS): KnownNight[] {
  return pairsWithKnown(candidateNights(input, params), input.real, params);
}

export interface BacktestSummary {
  nights: number;
  /** Error mediano (en minutos, sin signo) del inicio, del final y de la duración. */
  startMin: number;
  endMin: number;
  durationMin: number;
}

/** Resume una prueba: errores medianos en minutos. `null` si no hay ninguna noche con la que comparar. */
export function summarizeBacktest(pairs: readonly KnownNight[]): BacktestSummary | null {
  if (pairs.length === 0) return null;
  const abs = (f: (p: KnownNight) => number): number => Math.round(median(pairs.map((p) => Math.abs(f(p)))) / MIN);
  return {
    nights: pairs.length,
    startMin: abs((p) => p.estimate.startMs - p.known.startMs),
    endMin: abs((p) => p.estimate.endMs - p.known.endMs),
    durationMin: abs((p) => p.estimate.endMs - p.estimate.startMs - (p.known.endMs - p.known.startMs)),
  };
}

/**
 * Viterbi de tres estados sobre la evidencia de cada franja: 0 despierto, 1 dormido y 2 despierto DENTRO de la noche (solo entre dos
 * tramos dormidos, para que una escapada al baño no la parta). Devuelve 1 donde se duerme (el despertar de dentro cuenta como parte de la noche).
 */
export function decode(evidence: Float32Array, n: number, p: SleepParams): Uint8Array {
  const none = -1e18;
  const score = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const back = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const [awake, asleep, inside] = score as [Float64Array, Float64Array, Float64Array];
  const [awakeBack, asleepBack, insideBack] = back as [Uint8Array, Uint8Array, Uint8Array];
  awake[0] = 0;
  asleep[0] = -p.switchCost + at(evidence, 0);
  inside[0] = none;
  for (let i = 1; i < n; i++) {
    const a = at(awake, i - 1);
    const s = at(asleep, i - 1);
    const w = at(inside, i - 1);
    // despierto
    const fromAsleep = s - p.switchCost;
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
    if (a - p.switchCost > best) {
      best = a - p.switchCost;
      from = 0;
    }
    if (w - p.wakeBack > best) {
      best = w - p.wakeBack;
      from = 2;
    }
    asleep[i] = best + at(evidence, i);
    asleepBack[i] = from;
    // despierto dentro de la noche
    const enter = s - p.wakeIn;
    const stay = w - p.wakeStay;
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
    state.fill(j - i > p.maxInsideBins ? 0 : 1, i, j);
    i = j;
  }
  return state;
}
