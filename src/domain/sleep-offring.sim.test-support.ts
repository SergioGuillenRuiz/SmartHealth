import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';
import type { OffRingInput } from './sleep-offring';

// Una simulación de personas que NO duermen con el anillo, para medir lo bien o mal que la estimación de `sleep-offring.ts` encuentra cuándo se acuestan y se levantan. Cada noche tiene su verdad (la
// hora a la que se acostó y se levantó) y deja las marcas que dejaría una persona normal: pasos del anillo mientras lo lleva puesto, comidas y agua anotadas, y sincronizaciones con la app abierta.
// La simulación no sabe nada del estimador: solo genera la vida de la persona. Con semilla fija, para que las cifras se repitan.

const MIN = 60_000;
const HOUR = 60 * MIN;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Archetype {
  name: string;
  /** Hora de acostarse media (minutos desde las 00:00 del día en que empieza la noche; 1410 = 23:30, 1500 = 01:00) y su desviación. */
  bedMin: number;
  bedSd: number;
  /** Lo que duerme, en horas, y su desviación. */
  sleepH: number;
  sleepSd: number;
  /** Fracción de noches con el anillo puesto (estas las da el anillo: son las «noches reales» de las que aprende el hábito). */
  ringNights: number;
  /** Cuántas veces al día abre la app (cada vez deja unas cuantas sincronizaciones). */
  appOpens: number;
}

export const ARCHETYPES: readonly Archetype[] = [
  { name: 'regular', bedMin: 23 * 60 + 30, bedSd: 35, sleepH: 7.8, sleepSd: 0.5, ringNights: 0.35, appOpens: 5 },
  { name: 'tardío', bedMin: 25 * 60, bedSd: 60, sleepH: 8.2, sleepSd: 0.8, ringNights: 0.3, appOpens: 7 },
  { name: 'madrugador', bedMin: 22 * 60 + 15, bedSd: 30, sleepH: 7.2, sleepSd: 0.5, ringNights: 0.4, appOpens: 4 },
  { name: 'irregular', bedMin: 24 * 60 + 15, bedSd: 100, sleepH: 7.5, sleepSd: 1.3, ringNights: 0.3, appOpens: 5 },
  { name: 'nunca de noche', bedMin: 23 * 60 + 45, bedSd: 45, sleepH: 7.6, sleepSd: 0.7, ringNights: 0, appOpens: 5 },
];

export interface SimNight {
  /** Verdad. */
  startMs: number;
  endMs: number;
  ring: boolean;
}

export interface SimLife {
  input: OffRingInput;
  nights: SimNight[];
  /** Cuándo termina lo simulado (la última sincronización): ahí se le «pidió el sueño» al anillo. */
  endMs: number;
}

const dayMs = (day: number): number => new Date(2026, 5, 1 + day, 0, 0, 0, 0).getTime();

/** `days` días de vida de una persona con ese perfil, empezando el 1-jun-2026. La última noche simulada es la anterior al último día. */
export interface SimOptions {
  /** Probabilidad de que la persona pase la última parte de la tarde quieta (sofá): sin pasos ni nada anotado desde las 21:30 hasta acostarse. */
  quietEvening?: number;
}

export function simulateLife(arch: Archetype, days: number, seed: number, options: SimOptions = {}): SimLife {
  const random = rng(seed);
  const normal = (): number => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2; // ≈ N(0, 1)
  };
  const between = (lo: number, hi: number): number => lo + random() * (hi - lo);

  const buckets: StepBucket[] = [];
  const counters: CounterSample[] = [];
  const heart: HeartSample[] = [];
  const logged: number[] = [];
  const syncs: number[] = [];
  const real: SleepSessionRecord[] = [];
  const nights: SimNight[] = [];

  const addWalk = (fromMs: number, toMs: number): void => {
    // Tramos del anillo con pasos mientras lo lleva puesto, uno cada 20–60 min, y el contador sube con ellos.
    let t = fromMs + between(0, 30) * MIN;
    let steps = 0;
    while (t < toMs) {
      const length = between(5, 25) * MIN;
      const n = Math.round(between(15, 450));
      buckets.push({ startMs: t, endMs: Math.min(toMs, t + length), steps: n, ringDistanceM: 0, ringCalories: 0 });
      steps += n;
      t += length + between(15, 60) * MIN;
    }
    void steps;
  };

  let previousWake = dayMs(0) + 7 * HOUR;
  for (let d = 0; d < days; d++) {
    const midnight = dayMs(d);
    const bedMs = midnight + (arch.bedMin + normal() * arch.bedSd) * MIN;
    const sleepMs = clampH(arch.sleepH + normal() * arch.sleepSd) * HOUR;
    const wakeMs = bedMs + sleepMs;
    const ringOn = random() < arch.ringNights;
    nights.push({ startMs: bedMs, endMs: wakeMs, ring: ringOn });
    previousWake = wakeMs;

    // El día: el anillo puesto desde que se levanta hasta un rato antes de acostarse (si lo deja de noche) o hasta que se acuesta (si duerme con él).
    // El día de esa persona (con el anillo puesto) empieza después de levantarse, no a una hora fija.
    const eveningFrom = Math.max(midnight + between(8, 9.5) * HOUR, previousWake + between(10, 50) * MIN);
    const ringOffAt = ringOn ? bedMs : bedMs - between(10, 55) * MIN;
    // Una tarde quieta: los pasos y lo anotado se acaban a las 21:30 y hasta acostarse no hay nada.
    const quiet = random() < (options.quietEvening ?? 0);
    const quietFrom = midnight + between(21, 22) * HOUR;
    addWalk(eveningFrom, quiet ? Math.min(ringOffAt, quietFrom) : ringOffAt);

    // Anotaciones: la comida de la noche (casi siempre), el agua y alguna cosa más durante el día.
    const dinner = midnight + between(20.25, 22.25) * HOUR;
    const lastLog = quiet ? quietFrom : bedMs - 10 * MIN;
    if (random() < 0.8 && dinner < bedMs - 20 * MIN && dinner < lastLog) logged.push(dinner);
    for (let i = 0; i < 4; i++) {
      const t = midnight + between(9, 22) * HOUR;
      if (t < lastLog && random() < 0.8) logged.push(t);
    }
    // La app abierta: sincronizaciones sueltas durante el día; la última, a veces, justo antes de acostarse.
    for (let i = 0; i < arch.appOpens; i++) {
      const t = midnight + between(8.5, 23) * HOUR;
      if (t < bedMs - 5 * MIN && (!quiet || t < quietFrom)) {
        syncs.push(t);
        counters.push({ tsMs: t, steps: Math.round(between(500, 9000)) });
      }
    }
    if (!quiet && random() < 0.55) {
      const t = bedMs - between(2, 45) * MIN;
      syncs.push(t);
      counters.push({ tsMs: t, steps: Math.round(between(5000, 12000)) });
    }

    // La mañana siguiente: despertar, anillo puesto un rato después (si no durmió con él) y la app abierta pronto.
    if (ringOn) {
      real.push({ startMs: Math.round(bedMs), endMs: Math.round(wakeMs), segments: [] });
      // De noche el anillo puesto da pulso cada hora.
      for (let t = Math.ceil(bedMs / HOUR) * HOUR; t < wakeMs; t += HOUR) heart.push({ tsMs: t, bpm: Math.round(55 + normal() * 3), source: 'ring-auto' });
      addWalk(wakeMs + between(5, 40) * MIN, wakeMs + between(2, 4) * HOUR);
    } else {
      const ringOnAt = wakeMs + between(8, 50) * MIN;
      addWalk(ringOnAt, ringOnAt + between(2, 5) * HOUR);
    }
    if (random() < 0.85) {
      const t = wakeMs + between(1, 70) * MIN;
      syncs.push(t);
      counters.push({ tsMs: t, steps: Math.round(between(0, 300)) });
    }
    if (random() < 0.55) logged.push(wakeMs + between(15, 110) * MIN); // el desayuno
    if (random() < 0.5) logged.push(wakeMs + between(10, 90) * MIN); // un vaso de agua
  }

  const endMs = dayMs(days) + 14 * HOUR;
  syncs.push(endMs);
  counters.push({ tsMs: endMs, steps: 1200 });
  // Lo que dura todo lo simulado: se piden todas las noches menos las del borde (la primera, sin tarde anterior; la última, sin mañana).
  return {
    input: { buckets, counters, heart, workouts: [], logged, syncs, real, askedAtMs: endMs, fromMs: dayMs(1), toMs: dayMs(days) },
    nights,
    endMs,
  };
}

const clampH = (h: number): number => Math.min(11, Math.max(4, h));
