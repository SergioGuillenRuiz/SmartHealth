import type { LiveStatus } from '../session';
import type { AllRecord, HeartRecord, SleepSegment, SleepSession, SleepStage, SportRecord, Spo2Record } from '../records';
import { fromHex } from '../bytes';

/** Bitmap `02 01` REAL de un R99 con firmware 2.32 (24 bytes + relleno hasta 60). */
export const R99_SUPPORT_BITMAP: Uint8Array = (() => {
  const claimed = fromHex('f9 09 00 00 00 00 0c d8 10 04 01 b2 b6 00 40 0f 00 14 50 00 00 00 20 00');
  const out = new Uint8Array(60);
  out.set(claimed);
  return out;
})();

/** Lo que "guarda" el anillo simulado: se vuelca por el protocolo como lo haría el firmware. */
export interface SimDataset {
  deviceName: string;
  firmware: { main: number; sub: number };
  batteryPercent: number;
  supportBitmap: Uint8Array;
  sport: SportRecord[];
  sleep: SleepSession[];
  heart: HeartRecord[];
  all: AllRecord[];
  spo2: Spo2Record[];
  /** Lo que empuja `06 00` mientras hay conexión. */
  live: LiveStatus;
}

/** PRNG determinista (mulberry32): los datos de demostración son reproducibles. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal aproximada (Box-Muller). */
function gauss(rand: () => number, mean: number, sd: number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Cuándo vive la persona de la demostración: `noche` duerme de noche (de 23:00 a 07:00); `dia` hace turno de noche y duerme de ~08:00 a ~18:00. */
export type DemoSchedule = 'noche' | 'dia';

export const parseDemoSchedule = (value: string | null): DemoSchedule => (value === 'dia' ? 'dia' : 'noche');

export interface DemoOptions {
  /** "Ahora" del anillo simulado (ms). */
  nowMs: number;
  /** Días de historial que conserva el anillo (por defecto 7, como un anillo real sin vaciar). */
  days?: number;
  seed?: number;
  /** Media de pasos diarios. */
  stepsMean?: number;
  /** Longitud de zancada con la que "calcula" el anillo su distancia (m). */
  strideM?: number;
  deviceName?: string;
  /** Horario de la persona (por defecto duerme de noche). */
  schedule?: DemoSchedule;
}

// Fracción de los pasos del día que cae en cada hora (suma 1). Perfil de oficina con paseos.
const HOURLY_STEPS = [0, 0, 0, 0, 0, 0, 0.02, 0.07, 0.09, 0.05, 0.05, 0.05, 0.08, 0.08, 0.05, 0.05, 0.06, 0.09, 0.1, 0.07, 0.04, 0.03, 0.01, 0];
// Lo mismo para quien hace turno de noche: se mueve desde que se levanta (~18:00) hasta que se acuesta (~08:00) y de día duerme.
const HOURLY_STEPS_NIGHT_SHIFT = [0.09, 0.07, 0.06, 0.05, 0.04, 0.04, 0.04, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.12, 0.11, 0.1, 0.09, 0.08];

const HOUR = 3_600_000;
const MIN = 60_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Construye una noche de sueño con ciclos de ~90 min: ligero → profundo → ligero → REM, con algún despertar. */
function buildNight(rand: () => number, bedMs: number, wakeMs: number): SleepSession {
  const segments: SleepSegment[] = [];
  let cursor = bedMs;
  const push = (stage: SleepStage, minutes: number): void => {
    const end = Math.min(cursor + minutes * MIN, wakeMs);
    const durationSec = Math.round((end - cursor) / 1000);
    if (durationSec <= 0) return;
    segments.push({ stage, startMs: cursor, durationSec });
    cursor = end;
  };
  let cycle = 0;
  while (cursor < wakeMs - 5 * MIN) {
    push('light', 12 + rand() * 14);
    // El sueño profundo domina las primeras horas; el REM, las últimas.
    const deepShare = Math.max(0.15, 1 - cycle * 0.28);
    push('deep', (22 + rand() * 18) * deepShare);
    push('light', 14 + rand() * 18);
    push('rem', (5 + rand() * 8) * (0.5 + cycle * 0.45));
    if (rand() < 0.35) push('awake', 2 + rand() * 6);
    cycle++;
  }
  const last = segments[segments.length - 1];
  return {
    startMs: bedMs,
    endMs: last ? last.startMs + last.durationSec * 1000 : wakeMs,
    segments,
  };
}

export function buildDemoDataset(options: DemoOptions): SimDataset {
  const rand = mulberry32(options.seed ?? 7);
  const days = options.days ?? 7;
  const stride = options.strideM ?? 0.74;
  const nowMs = options.nowMs;
  const nightShift = options.schedule === 'dia';
  const hourlySteps = nightShift ? HOURLY_STEPS_NIGHT_SHIFT : HOURLY_STEPS;
  const todayStart = startOfDay(nowMs);

  const sport: SportRecord[] = [];
  const heart: HeartRecord[] = [];
  const spo2: Spo2Record[] = [];
  const all: AllRecord[] = [];
  const sleep: SleepSession[] = [];
  let liveSteps = 0;

  for (let back = days - 1; back >= 0; back--) {
    const dayStart = startOfDay(todayStart - back * 24 * HOUR + 12 * HOUR); // robusto frente al cambio de hora
    const weekday = new Date(dayStart).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const target = Math.max(1500, Math.round(gauss(rand, (options.stepsMean ?? 7800) * (weekend ? 0.85 : 1.05), 2200)));

    // Quien duerme de noche: la noche que TERMINA esta mañana. Quien hace turno de noche: el sueño de ~08:15 a ~18:15 de este mismo día.
    const bed = nightShift ? dayStart + 8 * HOUR + Math.round(gauss(rand, 15, 40)) * MIN : dayStart - HOUR + Math.round(gauss(rand, 0, 40)) * MIN; // ≈ 23:00 del día anterior
    const wake = nightShift ? bed + 10 * HOUR + Math.round(gauss(rand, 0, 20)) * MIN : dayStart + 7 * HOUR + Math.round(gauss(rand, 0, 35)) * MIN;
    if (wake <= nowMs) sleep.push(buildNight(rand, bed, wake));

    let cumulative = 0;
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * HOUR;
      if (hourStart > nowMs) break;
      const hourEnd = hourStart + HOUR;
      const hourSteps = Math.round(target * (hourlySteps[h] ?? 0) * (0.8 + rand() * 0.4));

      // Pasos de esa hora en 1–3 tramos de 5–18 min.
      if (hourSteps > 0) {
        const bursts = 1 + Math.floor(rand() * 3);
        let remaining = hourSteps;
        for (let b = 0; b < bursts && remaining > 0; b++) {
          const start = hourStart + Math.round(rand() * 35) * MIN + b * 3 * MIN;
          const length = (5 + Math.round(rand() * 13)) * MIN;
          const end = Math.min(start + length, hourEnd - 1000);
          if (start >= nowMs) continue;
          const share = b === bursts - 1 ? remaining : Math.round(remaining * (0.4 + rand() * 0.3));
          remaining -= share;
          const stepsInBurst = Math.min(share, Math.round(((end - start) / MIN) * (95 + rand() * 20)));
          if (stepsInBurst <= 0) continue;
          sport.push({
            startMs: start,
            endMs: Math.min(end, nowMs),
            steps: stepsInBurst,
            distanceM: Math.round(stepsInBurst * stride),
            calories: Math.round(stepsInBurst * 0.6),
          });
          cumulative += stepsInBurst;
        }
      }

      // Registros automáticos del anillo, uno por hora, con el contador acumulado del día.
      const ts = hourStart + Math.floor(rand() * 59) * 1000;
      if (ts <= nowMs) {
        const asleep = nightShift ? h >= 9 && h < 18 : h < 7 || h >= 23;
        const base = asleep ? 56 : 72;
        const bpm = Math.round(base + Math.sin((h / 24) * Math.PI * 2) * 4 + gauss(rand, 0, 5) + (hourSteps > 400 ? 12 : 0));
        heart.push({ tsMs: ts, bpm: Math.max(42, Math.min(150, bpm)) });
        const sat = Math.round(gauss(rand, asleep ? 96 : 97.5, 1.1));
        spo2.push({ tsMs: ts, percent: Math.max(90, Math.min(100, sat)) });
        all.push({
          tsMs: ts,
          steps: cumulative,
          bpm: Math.max(42, Math.min(150, bpm)),
          spo2: Math.max(90, Math.min(100, sat)),
          respiratoryRate: Math.round(gauss(rand, asleep ? 13 : 16, 1.2)),
        });
      }
    }
    if (back === 0) liveSteps = cumulative;
  }

  return {
    deviceName: options.deviceName ?? 'R99 F265',
    firmware: { main: 2, sub: 32 },
    batteryPercent: 78,
    supportBitmap: R99_SUPPORT_BITMAP,
    sport,
    sleep,
    heart,
    all,
    spo2,
    live: { steps: liveSteps, distanceM: Math.round(liveSteps * stride), calories: Math.round(liveSteps * 0.6) },
  };
}
