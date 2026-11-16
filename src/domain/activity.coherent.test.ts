import { describe, expect, it } from 'vitest';
import { summarizeActivity, type ActivityInputs } from './activity';
import type { ResolvedProfile } from './profile';
import type { CounterSample, StepBucket } from './types';
import type { WorkoutRecord } from './workout';

// Días generados que SÍ cuadran (tramos, contador y entrenos salen de la misma línea de tiempo de pasos), para comprobar los
// invariantes de los pasos con muchas combinaciones: lo que andas fuera de entrenos, entrenos a pie, deportes sin andar
// (la bici cuenta pasos falsos), una sincronización a media tarde y entrenos en directo posteriores que el anillo aún no vio.

const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };
const DAY = '2026-07-09';
const D0 = new Date(2026, 6, 9).getTime();
const NOW = new Date(2026, 6, 10, 9, 0, 0).getTime();
const MIN = 60_000;
const HALF = 30 * MIN;

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  input: ActivityInputs;
  /** Pasos que deben salir: lo andado y lo de los entrenos a pie, sin los falsos de la bici. */
  expected: number;
  syncedAt: number;
}

function buildDay(seed: number): Case {
  const r = rng(seed);
  const int = (lo: number, hi: number) => Math.floor(lo + r() * (hi - lo + 1));
  // Sincronización entre las 14:07 y las 21:37 (un minuto «raro», como en la vida real).
  const syncedAt = D0 + (int(28, 43) * 30 + 7) * MIN;
  const lastClosed = Math.floor((syncedAt - D0) / HALF) * HALF + D0;

  // Línea de tiempo por minuto: pasos reales y pasos falsos (la bici).
  const real = new Array<number>(24 * 60).fill(0);
  const fake = new Array<number>(24 * 60).fill(0);
  for (let m = 6 * 60; m < 22 * 60; m++) real[m] = r() < 0.35 ? int(40, 110) : 0;

  const workouts: WorkoutRecord[] = [];
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  let own = 0;
  for (let i = 0; i < int(0, 3); i++) {
    const startSlot = int(12, 43); // 06:00 – 21:30 en tramos de 30 min
    const slots = int(1, 3);
    const s = D0 + startSlot * HALF;
    const e = s + slots * HALF;
    // No se mezcla con el tramo en el que se sincroniza (el contador ya incluye a medias).
    if (e > lastClosed && s < syncedAt) continue;
    if (!free(s, e)) continue;
    taken.push([s, e]);
    const kind = (['walk', 'run', 'cycle', 'bicimad', 'gym'] as const)[int(0, 4)]!;
    const id = `w${i}`;
    const w: WorkoutRecord = { id, sport: kind, startMs: s, endMs: e, pausedMs: 0, source: 'live' };
    const m0 = (s - D0) / MIN;
    const m1 = (e - D0) / MIN;
    if (kind === 'walk' || kind === 'run') {
      let steps = 0;
      for (let m = m0; m < m1; m++) {
        real[m] = int(70, 120);
        steps += real[m]!;
      }
      w.steps = steps;
      if (r() < 0.5) {
        w.distanceM = Math.round(steps * 0.74);
        w.distanceSource = 'gps';
      }
      if (s >= syncedAt) own += steps;
    } else if (kind === 'cycle' || kind === 'bicimad') {
      for (let m = m0; m < m1; m++) {
        real[m] = 0;
        fake[m] = int(20, 60);
      }
      if (r() < 0.5) {
        let bogus = 0;
        for (let m = m0; m < m1; m++) bogus += fake[m]!;
        w.steps = bogus; // el anillo conectado también lo contó en directo
      }
      w.distanceM = 15_000;
      w.distanceSource = 'gps';
    } else {
      for (let m = m0; m < m1; m++) real[m] = 0;
    }
    workouts.push(w);
  }

  // Lo que ve el anillo: todo lo ocurrido hasta la sincronización.
  const upTo = (arr: number[], t: number, from = 0) => {
    let sum = 0;
    for (let m = from; m < Math.min(arr.length, Math.floor((t - D0) / MIN)); m++) sum += arr[m]!;
    return sum;
  };
  const buckets: StepBucket[] = [];
  for (let t = D0; t + HALF <= lastClosed; t += HALF) {
    const m = (t - D0) / MIN;
    let steps = 0;
    for (let k = m; k < m + 30; k++) steps += real[k]! + fake[k]!;
    if (steps > 0) buckets.push({ startMs: t, endMs: t + HALF, steps, ringDistanceM: steps * 0.7, ringCalories: steps * 0.05 });
  }
  const ringAtSync = upTo(real, syncedAt) + upTo(fake, syncedAt);
  const counters: CounterSample[] = [{ tsMs: syncedAt, steps: ringAtSync }];
  const expected = upTo(real, syncedAt) + own;
  return { input: { day: DAY, nowMs: NOW, profile, profileIsGeneric: false, buckets, counters, workouts }, expected, syncedAt };
}

describe('pasos del día con días coherentes', () => {
  it('el total es lo andado más los entrenos a pie, sin los pasos falsos de la bici, y las filas lo suman', () => {
    let withWorkouts = 0;
    let withStale = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const { input, expected, syncedAt } = buildDay(seed);
      if (input.workouts.length > 0) withWorkouts++;
      if (input.workouts.some((w) => w.startMs >= syncedAt && w.steps !== undefined)) withStale++;
      const a = summarizeActivity(input);
      const label = `seed ${seed}`;
      if (expected === 0 && input.workouts.length === 0) continue;
      // El total sale de las sumas de los tramos (alineados con los entrenos): exacto salvo redondeos.
      expect(Math.abs((a.steps ?? 0) - expected), `${label}: ${a.steps} frente a ${expected}`).toBeLessThanOrEqual(3);
      // Las filas (andar + cada entreno a pie) suman el total.
      const rows = a.walking.steps + Object.values(a.workoutSteps).reduce((x, y) => x + y, 0);
      expect(Math.abs(rows - (a.steps ?? 0)), `${label}: filas ${rows} frente a ${a.steps}`).toBeLessThanOrEqual(3);
      // Nada raro: ni negativos ni NaN, y la bici y el gimnasio no se llevan pasos.
      for (const v of [a.steps, a.walking.steps, a.walking.distanceM, a.walking.kcal, a.distanceM, a.activeKcal, a.ignoredSteps]) {
        expect(Number.isFinite(v), label).toBe(true);
        expect(v as number, label).toBeGreaterThanOrEqual(0);
      }
      for (const w of input.workouts) if (w.sport === 'cycle' || w.sport === 'bicimad' || w.sport === 'gym') expect(a.workoutSteps[w.id], `${label} ${w.sport}`).toBeUndefined();
      // El gráfico por horas no suma más que los pasos del día.
      if (a.hourlySteps) expect(a.hourlySteps.reduce((x, y) => x + y, 0), label).toBeLessThanOrEqual((a.steps ?? 0) + 3);
    }
    expect(withWorkouts).toBeGreaterThan(200);
    expect(withStale).toBeGreaterThan(20); // hay suficientes días con un entreno en directo posterior a la sincronización
  });
});
