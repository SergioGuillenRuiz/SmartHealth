// El modelo PERSONAL de una señal del anillo (pulso o respiración) para la estimación del sueño: cuánto marca cuando la persona duerme y cuánto cuando está despierta
// y quieta, con las lecturas de SUS días de alrededor (nada de umbrales fijos: un pulso de 60 es dormido para uno y despierto para otro).
//
// Se aprende de dos maneras:
//   · sin etiquetas (`twoLevels`): dos medias (k-means de una dimensión) sobre las lecturas quietas; vale para empezar;
//   · con las etiquetas de la primera pasada (`levelsFromLabels`): las lecturas que el modelo oculto de Markov dio por dormidas (con los pasos y el hábito de por medio) y las
//     despiertas y quietas. Es el mismo modelo, pero afinado con la estructura del tiempo, que el k-means no ve: una persona que se pasa media hora despierta en la cama con el
//     pulso a medio camino ya no mezcla esas lecturas con las de dormir.
// La evidencia de una lectura (`evidenceOf`) es el logaritmo del cociente de verosimilitudes dormido / despierto, atada a las medias (una lectura mucho más alta que el nivel
// de despierto no es «más despierta»: o es ejercicio, que ya dicen los pasos, o es un fallo del sensor) y ponderada por lo que se fía uno del modelo.

/** Lo que una señal marca dormida y despierta-quieta, cuánto varía cada nivel y cuánto se fía uno de ella (0–1). */
export interface Level {
  asleep: number;
  awake: number;
  sigma: number;
  trust: number;
}

/** Cómo se ajusta cada señal: su separación mínima, lo que puede variar y la separación (en unidades de la señal) a partir de la cual se fía del todo. */
export interface SignalSpec {
  minSeparation: number;
  sigmaMin: number;
  sigmaMax: number;
  fullTrustAt: number;
  /** Lo máximo que cuenta una sola lectura en el cociente (cada señal tiene su tope). */
  clip: number;
}

export const HEART_SPEC: SignalSpec = { minSeparation: 1, sigmaMin: 3.5, sigmaMax: 9, fullTrustAt: 9, clip: 3.3 };
/** La respiración tiene valores enteros y poca variación: dormida ~12–14, despierta ~15–20. */
export const BREATH_SPEC: SignalSpec = { minSeparation: 1.2, sigmaMin: 0.9, sigmaMax: 3, fullTrustAt: 3.5, clip: 2.4 };

const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;
const quantile = (sorted: readonly number[], q: number): number => at(sorted, Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length))));

/** Lo que se recorta de cada punta antes de agrupar: una lectura disparada (el sensor se movió) no debe ser «el nivel de despierto» de nadie. */
const TRIM = 0.03;
/** Cada uno de los dos niveles tiene que reunir al menos esta parte de las lecturas: si no, el «nivel» es un par de lecturas sueltas. */
const MIN_SHARE = 0.1;

/** Dos medias (k-means de una dimensión): el nivel bajo y el alto de las lecturas quietas de la persona. `null` si no se distinguen. */
export function twoLevels(values: readonly number[], spec: SignalSpec): Level | null {
  if (values.length < 8) return null;
  const all = [...values].sort((a, b) => a - b);
  const trimmed = all.slice(Math.floor(all.length * TRIM), all.length - Math.floor(all.length * TRIM));
  const sorted = trimmed.length >= 8 ? trimmed : all;
  let low = quantile(sorted, 0.2);
  let high = quantile(sorted, 0.8);
  if (high - low < spec.minSeparation) return null;
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
  let belowCut = 0;
  for (const v of sorted) {
    squares += (v - (v <= cut ? low : high)) ** 2;
    if (v <= cut) belowCut++;
  }
  const sigma = Math.min(spec.sigmaMax, Math.max(spec.sigmaMin, Math.sqrt(squares / sorted.length)));
  if (high - low < spec.minSeparation) return null;
  if (belowCut < sorted.length * MIN_SHARE || sorted.length - belowCut < sorted.length * MIN_SHARE) return null;
  return { asleep: low, awake: high, sigma, trust: Math.min(1, (high - low) / spec.fullTrustAt) };
}

const meanOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Los dos niveles con lecturas YA etiquetadas (dormido / despierto y quieto): sus medias y la dispersión de dentro de cada nivel. `null` si faltan lecturas o no se distinguen. */
export function levelsFromLabels(asleep: readonly number[], awake: readonly number[], spec: SignalSpec, minEach = 8): Level | null {
  if (asleep.length < minEach || awake.length < minEach) return null;
  const low = meanOf(asleep);
  const high = meanOf(awake);
  if (high - low < spec.minSeparation) return null;
  let squares = 0;
  for (const v of asleep) squares += (v - low) ** 2;
  for (const v of awake) squares += (v - high) ** 2;
  const sigma = Math.min(spec.sigmaMax, Math.max(spec.sigmaMin, Math.sqrt(squares / (asleep.length + awake.length))));
  return { asleep: low, awake: high, sigma, trust: Math.min(1, (high - low) / spec.fullTrustAt) };
}

/** Mezcla dos modelos de la misma señal (el de las etiquetas y el de sin etiquetas): con pocas lecturas el segundo frena que el primero se desvíe. */
export function blendLevels(a: Level | null, b: Level | null, weightA: number): Level | null {
  if (a === null) return b;
  if (b === null) return a;
  const w = Math.max(0, Math.min(1, weightA));
  return {
    asleep: w * a.asleep + (1 - w) * b.asleep,
    awake: w * a.awake + (1 - w) * b.awake,
    sigma: w * a.sigma + (1 - w) * b.sigma,
    trust: w * a.trust + (1 - w) * b.trust,
  };
}

/**
 * La evidencia de una lectura a favor de «dormido» (positiva) o de «despierto» (negativa). La lectura se ata entre un poco por debajo del nivel de dormido y un poco por
 * encima del de despierto: pasarse más no cambia nada (un pulso de 120 en la cama no es «más despierto» que uno de 80: es un fallo del sensor o ejercicio, y de lo segundo ya
 * hablan los pasos).
 */
export function evidenceOf(level: Level, value: number, spec: SignalSpec): number {
  const x = Math.max(level.asleep - 0.5 * level.sigma, Math.min(level.awake + 0.5 * level.sigma, value));
  const ratio = (((x - level.awake) ** 2 - (x - level.asleep) ** 2) / (2 * level.sigma ** 2)) * level.trust;
  return Math.max(-spec.clip, Math.min(spec.clip, ratio));
}
