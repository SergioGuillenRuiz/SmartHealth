import { ageAt, type ProfileEntry, type Sex } from './profile';
import type { DayKey } from './dates';

// Estimaciones de distancia y energía. Todas son APROXIMACIONES con error de decenas por ciento según
// la persona; por eso la interfaz las etiqueta siempre como "estimadas" y deja calibrar la zancada.
// docs/estimaciones.md explica cada fórmula, su origen y sus límites.

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

// ───────────────────────────── zancada y distancia ─────────────────────────────

export interface StrideInfo {
  meters: number;
  /** `manual`: la fijó o calibró el usuario. `learned`: la dedujo la app de sus paseos con GPS. `height`: derivada de la altura. */
  source: 'manual' | 'learned' | 'height';
}

/**
 * Longitud de paso al caminar con normalidad. Si el usuario la fijó (p. ej. calibrándola con una
 * distancia conocida) manda; después, la que la app dedujo de sus paseos con GPS; si no hay ninguna, se deriva de la
 * altura con los coeficientes habituales de podómetros: 0,415 × altura (hombres) y 0,413 × altura (mujeres).
 */
export function baseStride(profile: Pick<ProfileEntry, 'heightCm' | 'sex' | 'strideCm' | 'strideAuto'>): StrideInfo {
  if (profile.strideCm !== undefined && profile.strideCm > 0) {
    return { meters: profile.strideCm / 100, source: profile.strideAuto ? 'learned' : 'manual' };
  }
  const coefficient = profile.sex === 'male' ? 0.415 : 0.413;
  return { meters: (profile.heightCm * coefficient) / 100, source: 'height' };
}

/**
 * Corrección de la zancada según la cadencia. Al correr el paso se alarga (a ~170 pasos/min la zancada es
 * ~1,35 veces la de caminar). Solo se corrige AL ALZA y a partir de 120 pasos/min: un tramo del anillo
 * puede incluir tiempo parado, lo que hace que la cadencia calculada salga baja, y acortar la zancada por
 * eso infravaloraría la distancia de un paseo normal.
 */
export function strideFactor(cadenceSpm: number | null): number {
  if (cadenceSpm === null || !Number.isFinite(cadenceSpm) || cadenceSpm <= 120) return 1;
  return Math.min(1.4, 1 + (cadenceSpm - 120) * 0.0072);
}

export function stepsToDistanceM(steps: number, stride: StrideInfo, cadenceSpm: number | null = null): number {
  return Math.max(0, steps) * stride.meters * strideFactor(cadenceSpm);
}

/** Zancada derivada de una distancia conocida recorrida con `steps` pasos (calibración). */
export function calibrateStrideCm(distanceM: number, steps: number): number | null {
  if (!(distanceM > 0) || !(steps >= 20)) return null;
  const cm = (distanceM / steps) * 100;
  return cm >= 30 && cm <= 150 ? Math.round(cm * 10) / 10 : null;
}

export function cadenceSpm(steps: number, durationMs: number): number | null {
  if (!(durationMs >= 60_000) || steps <= 0) return null;
  return steps / (durationMs / 60_000);
}

// ───────────────────────────── energía ─────────────────────────────

/** Interpolación lineal por tramos, acotada en los extremos. */
export function interpolate(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b && x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return last[1];
}

/**
 * MET (equivalente metabólico, bruto) de desplazarse a pie según la velocidad en km/h.
 * Valores del Compendio de Actividades Físicas (Ainsworth et al., 2011), interpolados.
 */
export const LOCOMOTION_MET: ReadonlyArray<readonly [number, number]> = [
  // Parado (de pie, esperando en un semáforo) son ~1,3 MET; de ahí sube hasta los 2,0 de andar muy despacio.
  [0, 1.3],
  [1.0, 1.5],
  [2.0, 2.0],
  [3.2, 2.8],
  [4.8, 3.5],
  [5.6, 4.3],
  [6.4, 5.0],
  [8.0, 8.3],
  [9.7, 9.8],
  [11.3, 11.0],
  [12.9, 11.8],
  [14.5, 12.8],
  [16.1, 14.5],
  [19.3, 19.0],
];

/**
 * MET del ciclismo por velocidad (Compendio 2011, puntos medios de cada tramo; en bici de pedales, sin motor). La tabla supone
 * terreno llano y sin viento. Con tope en 12 MET (a partir de ~29 km/h): rodar más rápido en la ciudad es sobre todo bajada o viento
 * a favor, no esfuerzo, y con los 15,8 MET del Compendio para más de 32 km/h una bajada de 5 minutos contaba ~100 kcal para quien
 * rueda sin pedalear (lo real son unas 10–20).
 */
export const CYCLING_MET: ReadonlyArray<readonly [number, number]> = [
  // Parado en un semáforo, ~1,3 MET; la tabla del Compendio empieza a 10 km/h.
  [0, 1.3],
  [10, 3.5],
  [12, 4.0],
  [17.5, 6.8],
  [20.7, 8.0],
  [24.1, 10.0],
  [29, 12.0],
];

export const locomotionMet = (speedKmh: number): number => interpolate(LOCOMOTION_MET, speedKmh);
export const cyclingMet = (speedKmh: number): number => interpolate(CYCLING_MET, speedKmh);

/**
 * Coste energético NETO (por encima del reposo) de desplazarse, en kcal por kg y km.
 * Caminar ≈ 0,55; correr ≈ 0,9 (cifras que salen de los MET del Compendio: (MET − 1) / velocidad).
 * Entre 6,5 y 8,5 km/h se pasa gradualmente de uno a otro.
 */
export function netCostKcalPerKgKm(speedKmh: number | null): number {
  if (speedKmh === null || !Number.isFinite(speedKmh)) return 0.55;
  return interpolate(
    [
      [6.5, 0.55],
      [8.5, 0.9],
    ],
    speedKmh,
  );
}

export interface Locomotion {
  distanceM: number;
  /** kcal netas (por encima del reposo). */
  kcal: number;
  speedKmh: number | null;
}

/**
 * Distancia y energía de `steps` pasos dados durante `durationMs` (si se conoce). Es la estimación que se
 * aplica al total diario de pasos fuera de los entrenos registrados.
 */
export function walkingFromSteps(steps: number, durationMs: number | null, stride: StrideInfo, weightKg: number): Locomotion {
  const cadence = durationMs === null ? null : cadenceSpm(steps, durationMs);
  const distanceM = stepsToDistanceM(steps, stride, cadence);
  const speedKmh = durationMs !== null && durationMs >= 60_000 ? distanceM / 1000 / (durationMs / 3_600_000) : null;
  // La velocidad solo orienta el coste cuando el tramo es corto: en uno largo incluye tiempo parado y sale baja.
  const usableSpeed = durationMs !== null && durationMs <= 30 * 60_000 ? speedKmh : null;
  return { distanceM, kcal: netCostKcalPerKgKm(usableSpeed) * weightKg * (distanceM / 1000), speedKmh };
}

/**
 * Metabolismo basal (kcal/día), ecuación de Mifflin-St Jeor: la mejor validada para población general.
 */
export function bmrKcalPerDay(profile: Pick<ProfileEntry, 'heightCm' | 'weightKg' | 'sex' | 'birthDate'>, day: DayKey): number {
  const age = ageAt(profile.birthDate, day);
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * age;
  return Math.max(800, base + (profile.sex === 'male' ? 5 : -161));
}

/** kcal NETAS de una actividad de intensidad `met` durante `hours`: (MET − 1) × kg × h. */
export function netKcalFromMet(met: number, weightKg: number, hours: number): number {
  return Math.max(0, met - 1) * weightKg * Math.max(0, hours);
}

/**
 * Gasto BRUTO por minuto a partir de la frecuencia cardiaca (Keytel et al., 2005). Solo es válida en
 * esfuerzo (≳ 90 lpm); por debajo puede dar cifras absurdas, por eso quien la use debe comprobarlo.
 */
export function keytelGrossKcalPerMin(sex: Sex, bpm: number, weightKg: number, age: number): number {
  const kj =
    sex === 'male'
      ? -55.0969 + 0.6309 * bpm + 0.1988 * weightKg + 0.2017 * age
      : -20.4022 + 0.4472 * bpm - 0.1263 * weightKg + 0.074 * age;
  return Math.max(0, kj / 4.184);
}

export const round = (value: number, decimals = 0): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

export { clamp };
