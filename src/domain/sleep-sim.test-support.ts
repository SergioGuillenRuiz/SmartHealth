import type { CounterSample, HeartSample, StepBucket } from './types';

// Un simulador de lo que apunta el anillo (pulso cada 30 o 60 min, tramos de pasos de 15 min y contador del día) para una persona
// que duerme, anda y se queda quieta, con sus escapadas al baño, sus siestas, su sofá antes de acostarse y sus huecos de datos.
// Se conoce la noche de verdad y se compara con lo que estima `estimateSleep`. Solo para las pruebas (nada de la app lo importa).

const MIN = 60_000;

/** Un generador de números pseudoaleatorios con semilla (mulberry32): las pruebas dan siempre lo mismo. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (lo: number, hi: number): number => lo + (hi - lo) * next();
  const normal = (mean = 0, sd = 1): number => mean + sd * Math.sqrt(-2 * Math.log(Math.max(1e-9, next()))) * Math.cos(2 * Math.PI * next());
  const int = (lo: number, hi: number): number => Math.floor(uniform(lo, hi + 1));
  const chance = (p: number): boolean => next() < p;
  const poisson = (mean: number): number => {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= next();
    } while (p > limit);
    return k - 1;
  };
  return { uniform, normal, int, chance, poisson };
}

export type Schedule = 'night' | 'late' | 'day' | 'rotating' | 'irregular';
export type Profile = 'active' | 'desk' | 'mixed';

export interface SimOptions {
  seed: number;
  days: number;
  /** Cada cuántos minutos lee el anillo el pulso. */
  hrIntervalMin: 30 | 60 | 120;
  schedule: Schedule;
  profile: Profile;
  /** Probabilidad de que falte una lectura (anillo mal puesto, medida fallida). */
  dropout?: number;
  /** Escapadas al baño por noche, de media. */
  bathroom?: number;
  /** Multiplicadores del ruido del pulso y de la distancia entre dormido y despierto. */
  noise?: number;
  separation?: number;
}

export interface Span {
  startMs: number;
  endMs: number;
}

export interface Simulation {
  heart: HeartSample[];
  buckets: StepBucket[];
  counters: CounterSample[];
  workouts: Span[];
  /** Las noches de verdad (dormido, sin lo que se tarda en dormirse ni lo que se tarda en levantarse). */
  truth: Span[];
  naps: Span[];
  fromMs: number;
  toMs: number;
}

type Kind = 'sleep' | 'lying' | 'sofa' | 'sedentary' | 'walk' | 'nap' | 'work';

/** Lo que cuesta tener un valor sin salirse del rango de un `Float32Array`: fuera de él se lee 0 (ya no se escribe). */
const read = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

export function simulate(o: SimOptions): Simulation {
  const r = seeded(o.seed);
  const t0 = new Date(2026, 8, 1, 0, 0, 0).getTime(); // 1-sep-2026, sin cambio de hora en el periodo
  const total = o.days * 1440;
  const kind: Kind[] = new Array<Kind>(total).fill('sedentary');
  const steps = new Float32Array(total);
  const hrBias = new Float32Array(total);
  const add = (target: Float32Array, index: number, value: number): void => {
    if (index >= 0 && index < total) target[index] = read(target, index) + value;
  };
  const set = (index: number, value: Kind): void => {
    if (index >= 0 && index < total) kind[index] = value;
  };
  const sleepHR = r.uniform(46, 64);
  const restDelta = r.uniform(7, 18) * (o.separation ?? 1);
  const noiseSd = r.uniform(2.5, 5) * (o.noise ?? 1);
  const truth: Span[] = [];
  const naps: Span[] = [];
  const workouts: Span[] = [];

  // 1) las noches: empiezan el día d, `bed` minutos después de su medianoche
  const plan = (day: number): { bed: number; length: number } => {
    const type: Schedule = o.schedule === 'rotating' ? (['night', 'day', 'late'] as const)[Math.floor(day / 4) % 3] ?? 'night' : o.schedule;
    if (type === 'irregular') return { bed: r.uniform(20, 30) * 60, length: Math.round(r.normal(7.0, 1.4) * 60) };
    const centre = type === 'late' ? 25.8 : type === 'day' ? 8.2 : 23.5;
    return { bed: (centre + r.normal(0, 0.75)) * 60, length: Math.round(Math.min(10, Math.max(4.2, r.normal(7.4, 1.0))) * 60) };
  };
  const sleeps: Array<{ s: number; e: number }> = [];
  for (let d = 0; d < o.days; d++) {
    const night = plan(d);
    const s = Math.round(d * 1440 + night.bed);
    const e = s + night.length;
    const previous = sleeps[sleeps.length - 1];
    if (s < 0 || e >= total || (previous && s < previous.e + 3 * 60)) continue;
    sleeps.push({ s, e });
  }

  // 2) el día entre noche y noche
  for (let i = 0; i <= sleeps.length; i++) {
    const prevEnd = sleeps[i - 1]?.e ?? 0;
    const night = sleeps[i];
    const nextStart = night?.s ?? total;
    let m = prevEnd;
    if (i > 0) {
      const lie = r.int(0, 30);
      for (let k = 0; k < lie && m < nextStart; k++, m++) set(m, 'lying');
    }
    const windDown = night ? r.int(60, 180) : 0;
    const preLying = night ? r.int(5, 40) : 0;
    const awakeEnd = nextStart - preLying;
    const sofaStart = awakeEnd - windDown;
    while (m < awakeEnd) {
      if (night && m >= sofaStart) {
        set(m, 'sofa');
        if (r.chance(1 / 45)) {
          add(steps, m, r.int(3, 25));
          add(hrBias, m, 6);
        }
        m++;
        continue;
      }
      const walkP = o.profile === 'active' ? 0.55 : o.profile === 'desk' ? 0.25 : 0.4;
      if (r.chance(walkP)) {
        const duration = r.int(4, 28);
        const spm = r.uniform(70, 120);
        for (let k = 0; k < duration && m < sofaStart; k++, m++) {
          set(m, 'walk');
          add(steps, m, Math.max(0, r.normal(spm, 12)));
        }
      } else {
        const [lo, hi] = o.profile === 'desk' ? [60, 220] : o.profile === 'mixed' ? [20, 120] : [10, 50];
        const duration = r.int(lo ?? 10, hi ?? 50);
        const micro = o.profile === 'desk' ? 1 / 70 : 1 / 35;
        for (let k = 0; k < duration && m < sofaStart; k++, m++) {
          set(m, 'sedentary');
          if (r.chance(micro)) {
            add(steps, m, r.int(3, 30));
            add(hrBias, m, 5);
          }
        }
      }
      if (r.chance(0.002) && m + 60 < sofaStart) {
        const duration = r.int(30, 60);
        workouts.push({ startMs: t0 + m * MIN, endMs: t0 + (m + duration) * MIN });
        for (let k = 0; k < duration; k++, m++) {
          set(m, 'work');
          add(steps, m, r.normal(130, 15));
        }
      }
    }
    for (let k = 0; k < preLying && m < nextStart; k++, m++) set(m, 'lying');
    // una siesta de vez en cuando, entre las 13 y las 18
    if (night && r.chance(0.18)) {
      const napStart = Math.floor(m / 1440) * 1440 + r.int(13 * 60, 17 * 60);
      const duration = r.int(25, 100);
      if (napStart > prevEnd + 90 && napStart + duration < awakeEnd - 120) {
        for (let k = 0; k < duration; k++) set(napStart + k, 'nap');
        naps.push({ startMs: t0 + napStart * MIN, endMs: t0 + (napStart + duration) * MIN });
      }
    }
  }

  // 3) la noche en sí, con su pulso (más alto al dormirse y al despertar, con subidas de REM) y sus despertares
  const sleepCurve = (index: number, length: number): number => {
    const onset = Math.max(0, 8 * (1 - index / 60));
    const rise = index > length - 45 ? ((index - (length - 45)) / 45) * 9 : 0;
    const rem = 7 * Math.max(0, Math.sin((2 * Math.PI * index) / 90 + 1.3)) ** 3;
    return onset + rise + rem;
  };
  for (const { s, e } of sleeps) {
    const length = e - s;
    for (let m = s; m < e; m++) {
      set(m, 'sleep');
      add(hrBias, m, sleepCurve(m - s, length));
    }
    truth.push({ startMs: t0 + s * MIN, endMs: t0 + e * MIN });
    const trips = r.poisson(o.bathroom ?? 1.2);
    for (let t = 0; t < trips; t++) {
      const trip = s + r.int(60, length - 60);
      const awake = r.int(4, 12);
      for (let k = 0; k < awake; k++) {
        set(trip + k, 'lying');
        add(hrBias, trip + k, 6);
      }
      add(steps, trip + 2, r.int(10, 45));
    }
    if (r.chance(0.1)) {
      const wake = s + r.int(120, Math.max(121, length - 120));
      const awake = r.int(20, 55);
      for (let k = 0; k < awake; k++) {
        set(wake + k, 'lying');
        if (r.chance(0.15)) add(steps, wake + k, r.int(5, 25));
      }
    }
  }

  // 4) lo que ve el anillo
  const base: Record<Kind, number> = {
    sleep: sleepHR,
    nap: sleepHR + 4,
    lying: sleepHR + restDelta - 5,
    sofa: sleepHR + restDelta - 3,
    walk: sleepHR + restDelta + 22,
    work: sleepHR + restDelta + 60,
    sedentary: sleepHR + restDelta,
  };
  const heartAt = (m: number): number => Math.round(base[kind[m] ?? 'sedentary'] + read(hrBias, m) + r.normal(0, noiseSd));
  // anillo quitado (ducha, carga): una o dos veces por semana, de 1 a 3 h
  const off: Array<[number, number]> = [];
  for (let w = 0; w < o.days / 7; w++) {
    for (let k = r.int(1, 2); k > 0; k--) {
      const from = Math.floor(w * 7 * 1440 + r.uniform(0, 7 * 1440 - 200));
      off.push([from, from + r.int(60, 180)]);
    }
  }
  const isOff = (m: number): boolean => off.some(([a, b]) => m >= a && m < b);

  const heart: HeartSample[] = [];
  const counters: CounterSample[] = [];
  const buckets: StepBucket[] = [];
  const offset = r.int(0, o.hrIntervalMin - 1);
  const dropout = o.dropout ?? 0.1;
  for (let m = offset; m < total; m += o.hrIntervalMin) {
    if (isOff(m) || r.chance(dropout)) continue;
    heart.push({ tsMs: t0 + m * MIN, bpm: Math.max(35, Math.min(200, heartAt(m))), source: 'ring-auto' });
    let accumulated = 0;
    for (let k = Math.floor(m / 1440) * 1440; k <= m; k++) accumulated += read(steps, k);
    counters.push({ tsMs: t0 + m * MIN, steps: Math.round(accumulated) });
  }
  for (let b = 0; b < total; b += 15) {
    let sum = 0;
    let removed = false;
    for (let k = b; k < Math.min(total, b + 15); k++) {
      sum += read(steps, k);
      if (isOff(k)) removed = true;
    }
    if (!removed && sum >= 3) buckets.push({ startMs: t0 + b * MIN, endMs: t0 + (b + 15) * MIN, steps: Math.round(sum), ringDistanceM: Math.round(sum * 0.7), ringCalories: Math.round(sum * 0.06) });
  }
  return { heart, buckets, counters, workouts, truth, naps, fromMs: t0, toMs: t0 + total * MIN };
}

// ───────────────────────────── puntuación ─────────────────────────────

export interface Matched {
  /** Minutos de diferencia (estimado − verdad). */
  startErr: number;
  endErr: number;
  durErr: number;
  /** Intersección entre unión (1 = idénticas). */
  iou: number;
}

export interface Score {
  nights: number;
  matched: Matched[];
  falsePositives: number;
  days: number;
}

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** Compara lo estimado con las noches de verdad (las que caen enteras dentro, sin el primer ni el último día). */
export function evaluate(estimates: readonly Span[], sim: Simulation): Score {
  const day = 1440 * MIN;
  const eligible = sim.truth.filter((t) => t.startMs >= sim.fromMs + day && t.endMs <= sim.toMs - day);
  const matched: Matched[] = [];
  const used = new Set<Span>();
  for (const t of eligible) {
    let best: Span | null = null;
    let bestOverlap = 0;
    for (const e of estimates) {
      const ov = overlap(e, t);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = e;
      }
    }
    if (best && bestOverlap >= 0.4 * (t.endMs - t.startMs)) {
      used.add(best);
      const union = Math.max(best.endMs, t.endMs) - Math.min(best.startMs, t.startMs);
      matched.push({
        startErr: (best.startMs - t.startMs) / MIN,
        endErr: (best.endMs - t.endMs) / MIN,
        durErr: (best.endMs - best.startMs - (t.endMs - t.startMs)) / MIN,
        iou: bestOverlap / union,
      });
    }
  }
  const inside = estimates.filter((e) => e.startMs >= sim.fromMs + day / 2 && e.endMs <= sim.toMs - day / 2);
  const falsePositives = inside.filter((e) => !used.has(e) && !sim.truth.some((t) => overlap(e, t) > 0.2 * (e.endMs - e.startMs))).length;
  return { nights: eligible.length, matched, falsePositives, days: (sim.toMs - sim.fromMs) / day };
}

const middle = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};

export interface Summary {
  nights: number;
  found: number;
  /** Mediana del error absoluto del inicio, del fin y de la duración, en minutos. */
  startMin: number;
  endMin: number;
  durationMin: number;
  iou: number;
  /** Estimaciones sin ninguna noche detrás, por semana. */
  falsePerWeek: number;
}

export function summarize(scores: readonly Score[]): Summary {
  const nights = scores.reduce((a, s) => a + s.nights, 0);
  const matched = scores.flatMap((s) => s.matched);
  const days = scores.reduce((a, s) => a + s.days, 0);
  const fp = scores.reduce((a, s) => a + s.falsePositives, 0);
  return {
    nights,
    found: matched.length / Math.max(1, nights),
    startMin: middle(matched.map((m) => Math.abs(m.startErr))),
    endMin: middle(matched.map((m) => Math.abs(m.endErr))),
    durationMin: middle(matched.map((m) => Math.abs(m.durErr))),
    iou: middle(matched.map((m) => m.iou)),
    falsePerWeek: (7 * fp) / Math.max(1, days),
  };
}
