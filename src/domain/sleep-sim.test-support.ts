import type { CounterSample, HeartSample, SleepSessionRecord, StepBucket } from './types';

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
  /**
   * Efectos de la vida real que el simulador «limpio» no tiene (todos apagados por omisión, y con su propio generador de números: lo de antes sale idéntico).
   * `harsh: true` los enciende todos con valores típicos; cada uno se puede fijar aparte.
   */
  harsh?: boolean;
  /** Las lecturas de pulso traen la respiración (`resp`), como el registro de constantes del anillo (el 85 % de las veces). */
  resp?: boolean;
  /** Probabilidad de que una lectura de pulso salga disparada (el sensor se mueve o apoya mal): +12 a +45 lpm. */
  artifacts?: number;
  /** Fracción de noches «malas» (alcohol, cena pesada, malestar): el pulso va 5–12 lpm más alto toda la noche. */
  badNights?: number;
  /** Rato despierto en la cama antes de dormir (20–90 min) y al despertar (10–60 min), sin pasos y con el pulso bajo. */
  lieAwake?: boolean;
  /** Fracción de noches con un despertar largo (60–150 min) en mitad de la noche. */
  insomnia?: number;
  /** Fracción de días con ejercicio de tarde-noche (19–22 h): el pulso sigue alto un buen rato después. */
  eveningExercise?: number;
  /** Amplitud (lpm) de una deriva lenta del pulso base de unos días a otros (forma física, estrés, calor). */
  drift?: number;
  /** El anillo guarda por sí mismo las noches que empiezan entre las 20:00 y las 04:00 (con su error propio): salen en `ringSessions`. */
  ringLabels?: boolean;
}

export interface Span {
  startMs: number;
  endMs: number;
}

export interface Simulation {
  /** Las noches que guardó el anillo por sí mismo (si `ringLabels`): con ellas no se estima y sirven de etiqueta para calibrar. */
  ringSessions: SleepSessionRecord[];
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

type Kind = 'sleep' | 'lying' | 'sofa' | 'sedentary' | 'walk' | 'nap' | 'work' | 'bed';

/** Lo que cuesta tener un valor sin salirse del rango de un `Float32Array`: fuera de él se lee 0 (ya no se escribe). */
const read = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

export function simulate(options: SimOptions): Simulation {
  const o: SimOptions = options.harsh
    ? { resp: true, artifacts: 0.03, badNights: 0.15, lieAwake: true, insomnia: 0.12, eveningExercise: 0.3, drift: 4, ringLabels: true, ...options }
    : options;
  const r = seeded(o.seed);
  // Todo lo nuevo saca sus números de aquí: con las opciones apagadas el simulador de antes da exactamente lo mismo.
  const x = seeded((o.seed ^ 0x9e3779b9) >>> 0);
  const t0 = new Date(2026, 8, 1, 0, 0, 0).getTime(); // 1-sep-2026, sin cambio de hora en el periodo
  const total = o.days * 1440;
  const kind: Kind[] = new Array<Kind>(total).fill('sedentary');
  const steps = new Float32Array(total);
  const hrBias = new Float32Array(total);
  const respBias = new Float32Array(total);
  const add = (target: Float32Array, index: number, value: number): void => {
    if (index >= 0 && index < total) target[index] = read(target, index) + value;
  };
  const set = (index: number, value: Kind): void => {
    if (index >= 0 && index < total) kind[index] = value;
  };
  const sleepHR = r.uniform(46, 64);
  const restDelta = r.uniform(7, 18) * (o.separation ?? 1);
  const noiseSd = r.uniform(2.5, 5) * (o.noise ?? 1);
  const respAwake = x.uniform(14, 18);
  const respAsleep = respAwake - x.uniform(2, 3.5);
  const driftPhase = x.uniform(0, 6.28);
  const drift = (m: number): number => (o.drift ?? 0) * Math.sin((2 * Math.PI * (m / 1440)) / 17 + driftPhase);
  const truth: Span[] = [];
  const naps: Span[] = [];
  const workouts: Span[] = [];
  const ringSessions: SleepSessionRecord[] = [];
  /** Estar despierto en la cama: sin pasos y con el pulso por debajo de estar sentado (en el simulador de antes era `lying`, mucho más alto). */
  const lyingKind: Kind = o.lieAwake ? 'bed' : 'lying';

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
      const lie = o.lieAwake ? x.int(10, 60) : r.int(0, 30);
      for (let k = 0; k < lie && m < nextStart; k++, m++) set(m, lyingKind);
    }
    const windDown = night ? r.int(60, 180) : 0;
    const preLying = night ? (o.lieAwake ? x.int(20, 90) : r.int(5, 40)) : 0;
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
    for (let k = 0; k < preLying && m < nextStart; k++, m++) set(m, lyingKind);
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

  // 2b) ejercicio de tarde-noche: el pulso (y la respiración) siguen altos un buen rato después, hasta cerca de acostarse
  if (o.eveningExercise) {
    for (let d = 0; d < o.days; d++) {
      if (!x.chance(o.eveningExercise)) continue;
      const start = d * 1440 + x.int(19 * 60, 20 * 60 + 30);
      const duration = x.int(30, 60);
      let clear = true;
      for (let k = -20; k < duration + 150 && clear; k++) if (kind[start + k] === 'sleep' || kind[start + k] === 'nap' || kind[start + k] === 'bed') clear = false;
      if (!clear || start + duration + 150 >= total) continue;
      for (let k = 0; k < duration; k++) {
        set(start + k, 'work');
        add(steps, start + k, x.normal(125, 15));
      }
      if (x.chance(0.5)) workouts.push({ startMs: t0 + start * MIN, endMs: t0 + (start + duration) * MIN });
      for (let k = 0; k < 150; k++) {
        const decay = Math.exp(-k / 55);
        add(hrBias, start + duration + k, 24 * decay);
        add(respBias, start + duration + k, 3.5 * decay);
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
    if (o.badNights && x.chance(o.badNights)) {
      const extra = x.uniform(5, 12);
      for (let m = s; m < e; m++) {
        add(hrBias, m, extra * (1 - 0.5 * ((m - s) / length)));
        add(respBias, m, 1.4);
      }
    }
    if (o.insomnia && x.chance(o.insomnia)) {
      const wake = s + x.int(90, Math.max(91, length - 180));
      const awake = x.int(60, 150);
      for (let k = 0; k < awake && wake + k < e - 30; k++) {
        set(wake + k, lyingKind);
        if (x.chance(0.04)) add(steps, wake + k, x.int(5, 30));
      }
    }
    if (o.ringLabels) {
      const hour = (s % 1440) / 60;
      if ((hour >= 20 || hour < 4) && x.chance(0.9)) {
        ringSessions.push({
          startMs: t0 + (s + Math.max(0, Math.round(x.normal(10, 8)))) * MIN,
          endMs: t0 + (e - Math.max(0, Math.round(x.normal(4, 4)))) * MIN,
          segments: [],
        });
      }
    }
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
        set(wake + k, lyingKind);
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
    bed: sleepHR + restDelta * 0.45 + 1,
  };
  const heartAt = (m: number): number => {
    let bpm = base[kind[m] ?? 'sedentary'] + read(hrBias, m) + drift(m) + r.normal(0, noiseSd);
    if (o.artifacts && x.chance(o.artifacts)) bpm += x.uniform(12, 45);
    return Math.round(bpm);
  };
  const respBase: Record<Kind, number> = {
    sleep: respAsleep,
    nap: respAsleep + 0.5,
    lying: respAwake - 0.6,
    sofa: respAwake - 0.4,
    walk: respAwake + 2.5,
    work: respAwake + 7,
    sedentary: respAwake,
    bed: respAwake - 1.2,
  };
  const respAt = (m: number): number => {
    const kindNow = kind[m] ?? 'sedentary';
    const rem = kindNow === 'sleep' ? 0.9 * Math.max(0, Math.sin((2 * Math.PI * (m - 0)) / 90 + 1.3)) ** 3 : 0;
    return Math.round(respBase[kindNow] + rem + read(respBias, m) + x.normal(0, 1.2 * (o.noise ?? 1)));
  };
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
    const sample: HeartSample = { tsMs: t0 + m * MIN, bpm: Math.max(35, Math.min(200, heartAt(m))), source: 'ring-auto' };
    if (o.resp && x.chance(0.85)) sample.resp = Math.max(6, Math.min(40, respAt(m)));
    heart.push(sample);
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
  return { ringSessions, heart, buckets, counters, workouts, truth, naps, fromMs: t0, toMs: t0 + total * MIN };
}

// ───────────────────────────── puntuación ─────────────────────────────

export interface Matched {
  /** Minutos de diferencia (estimado − verdad). */
  startErr: number;
  endErr: number;
  durErr: number;
  /** Intersección entre unión (1 = idénticas). */
  iou: number;
  /** Lo que dura la noche de verdad, en minutos. */
  truthMin: number;
}

export interface Score {
  nights: number;
  matched: Matched[];
  /** El parecido (IoU) de CADA noche de verdad con lo estimado: 0 si no se halló. */
  ious: number[];
  falsePositives: number;
  days: number;
}

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** Compara lo estimado con las noches de verdad (las que caen enteras dentro, sin el primer ni el último día). */
export function evaluate(estimates: readonly Span[], sim: Simulation): Score {
  const day = 1440 * MIN;
  // Las noches que el anillo guardó por sí mismo no se estiman (y no cuentan aquí): sirven de etiqueta.
  const eligible = sim.truth.filter((t) => t.startMs >= sim.fromMs + day && t.endMs <= sim.toMs - day && !sim.ringSessions.some((ring) => overlap(ring, t) > 0));
  const matched: Matched[] = [];
  const ious: number[] = [];
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
        truthMin: (t.endMs - t.startMs) / MIN,
      });
      ious.push(bestOverlap / union);
    } else ious.push(0);
  }
  const inside = estimates.filter((e) => e.startMs >= sim.fromMs + day / 2 && e.endMs <= sim.toMs - day / 2);
  const falsePositives = inside.filter((e) => !used.has(e) && !sim.truth.some((t) => overlap(e, t) > 0.2 * (e.endMs - e.startMs))).length;
  return { nights: eligible.length, matched, ious, falsePositives, days: (sim.toMs - sim.fromMs) / day };
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
  /** Fracción de TODAS las noches de verdad cuyo parecido es ≥ 0,7 (las no halladas cuentan como fallos) y fracción de las que fallan de lleno (< 0,5). */
  hit: number;
  miss: number;
  /** Error relativo medio de la duración (|estimada − real| / real) en las noches halladas. */
  relDuration: number;
  /** Estimaciones sin ninguna noche detrás, por semana. */
  falsePerWeek: number;
}

export function summarize(scores: readonly Score[]): Summary {
  const nights = scores.reduce((a, s) => a + s.nights, 0);
  const matched = scores.flatMap((s) => s.matched);
  const days = scores.reduce((a, s) => a + s.days, 0);
  const fp = scores.reduce((a, s) => a + s.falsePositives, 0);
  const ious = scores.flatMap((s) => s.ious);
  return {
    nights,
    found: matched.length / Math.max(1, nights),
    startMin: middle(matched.map((m) => Math.abs(m.startErr))),
    endMin: middle(matched.map((m) => Math.abs(m.endErr))),
    durationMin: middle(matched.map((m) => Math.abs(m.durErr))),
    iou: middle(matched.map((m) => m.iou)),
    hit: ious.filter((v) => v >= 0.7).length / Math.max(1, ious.length),
    miss: ious.filter((v) => v < 0.5).length / Math.max(1, ious.length),
    relDuration: matched.length === 0 ? Number.NaN : matched.reduce((a, m) => a + Math.abs(m.durErr) / m.truthMin, 0) / matched.length,
    falsePerWeek: (7 * fp) / Math.max(1, days),
  };
}
