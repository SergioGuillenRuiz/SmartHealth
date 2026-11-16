import { dayOfMs, type DayKey } from './dates';
import { maxOf } from './extent';
import type { SleepSegmentRecord, SleepSessionRecord } from './types';

export interface SleepNight {
  /** Día en que despierta (el sueño de la noche del lunes al martes es "martes"). */
  day: DayKey;
  startMs: number;
  endMs: number;
  deepSec: number;
  lightSec: number;
  remSec: number;
  awakeSec: number;
  /** Tiempo dormido: profundo + ligero + REM. */
  asleepSec: number;
  /** Tiempo en la cama: lo que dura la sesión según el anillo (sin los huecos entre sesiones). */
  inBedSec: number;
  segments: SleepSegmentRecord[];
  /** `true` si el anillo distingue fases (≥ 2 tipos con tiempo); si no, solo hay duración fiable. */
  hasStages: boolean;
  sessions: number;
  /** La noche no la guardó el anillo: la ha estimado la app con el pulso y la falta de pasos (sin fases, con horas aproximadas). */
  estimated: boolean;
  /** Las horas las corrigió la persona a mano. */
  manual?: boolean;
}

export interface Nap {
  startMs: number;
  endMs: number;
  durationSec: number;
}

export interface SleepDay {
  night: SleepNight | null;
  naps: Nap[];
}

const minutesOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/** Hora «de noche»: entre las 20:00 y las 12:00. */
function isNightTime(ms: number): boolean {
  const minutes = minutesOfDay(ms);
  return minutes >= 20 * 60 || minutes < 12 * 60;
}

/**
 * El anillo parte un sueño en dos sesiones cuando hay un despertar largo: dos sesiones separadas por menos de esto (también si el
 * corte cae en la medianoche) son el mismo sueño. Más ya sería una siesta antes de acostarse, o un despertar de insomnio.
 */
const MAX_SPLIT_GAP_MS = 2 * 3_600_000;
/** Un sueño no dura más que esto de principio a fin: una cadena de sesiones más larga son varios sueños, no uno. */
const MAX_BLOCK_MS = 16 * 3_600_000;
/**
 * Un sueño de al menos esto en la cama es el principal del día A LA HORA QUE SEA: quien trabaja de noche, o se acuesta de madrugada,
 * duerme de día, y su sueño no es una siesta (antes cualquier cosa con el punto medio pasado el mediodía lo era, y la hoja del sueño
 * decía «Sin sueño registrado»). Por debajo de esto, solo es «de noche» si cae en horas de noche.
 */
const MIN_MAIN_SLEEP_MS = 3 * 3_600_000;

interface SleepBlock {
  sessions: SleepSessionRecord[];
  startMs: number;
  endMs: number;
  /** Tiempo en la cama: lo que duran las sesiones, sin los huecos entre ellas. */
  inBedMs: number;
}

/** Junta las sesiones que están a menos de `MAX_SPLIT_GAP_MS` una de otra, sin pasar de `MAX_BLOCK_MS` de principio a fin. */
function blocksOf(sessions: readonly SleepSessionRecord[]): SleepBlock[] {
  const blocks: SleepBlock[] = [];
  for (const session of [...sessions].sort((a, b) => a.startMs - b.startMs)) {
    const last = blocks[blocks.length - 1];
    if (last && session.startMs - last.endMs <= MAX_SPLIT_GAP_MS && Math.max(last.endMs, session.endMs) - last.startMs <= MAX_BLOCK_MS && !isAfternoonNap(last)) {
      last.sessions.push(session);
      last.endMs = Math.max(last.endMs, session.endMs);
      last.inBedMs += session.endMs - session.startMs;
    } else {
      blocks.push({ sessions: [session], startMs: session.startMs, endMs: session.endMs, inBedMs: session.endMs - session.startMs });
    }
  }
  return blocks;
}

/** Una siesta de tarde (corta y a horas de día) no es la primera parte de la noche que viene: no se junta con ella. */
const isAfternoonNap = (block: SleepBlock): boolean => block.inBedMs < MIN_MAIN_SLEEP_MS && !isNightTime((block.startMs + block.endMs) / 2);

const isMainSleep = (block: SleepBlock): boolean => block.inBedMs >= MIN_MAIN_SLEEP_MS || isNightTime((block.startMs + block.endMs) / 2);

/**
 * Agrupa las sesiones del anillo por día de despertar (el del final del sueño). Un sueño son las sesiones seguidas (el anillo parte
 * la noche si hay un despertar largo, y el corte puede caer en la medianoche); el principal del día es el más largo que dure lo
 * bastante o caiga en horas de noche, y todo lo demás son siestas.
 *
 * `dayStartHour` es la hora a la que empieza el día (0, la medianoche, por omisión; el Resumen cuenta desde las 08:00): un sueño
 * que acaba antes de esa hora es del día anterior. Quien se acuesta de madrugada y se levanta por la tarde tiene todo su sueño
 * dentro del mismo día; quien duerme de noche lo ve en el día en que se acostó.
 */
export function groupSleep(sessions: readonly SleepSessionRecord[], dayStartHour = 0): Map<DayKey, SleepDay> {
  const byDay = new Map<DayKey, SleepBlock[]>();
  for (const block of blocksOf(sessions.filter((session) => session.endMs > session.startMs))) {
    const day = dayOfMs(block.endMs, dayStartHour);
    const list = byDay.get(day) ?? [];
    list.push(block);
    byDay.set(day, list);
  }

  const out = new Map<DayKey, SleepDay>();
  for (const [day, blocks] of byDay) {
    // El más largo; a igualdad, el que acaba más tarde (el último despertar es el del día).
    const main = blocks.filter(isMainSleep).sort((a, b) => b.inBedMs - a.inBedMs || b.endMs - a.endMs)[0] ?? null;
    const naps = blocks
      .filter((block) => block !== main)
      .flatMap((block) => block.sessions)
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => ({ startMs: s.startMs, endMs: s.endMs, durationSec: Math.round((s.endMs - s.startMs) / 1000) }));
    out.set(day, { night: main ? buildNight(day, main.sessions) : null, naps });
  }
  return out;
}

function buildNight(day: DayKey, sessions: SleepSessionRecord[]): SleepNight {
  const sorted = [...sessions].sort((a, b) => a.startMs - b.startMs);
  const segments = sorted.flatMap((s) => s.segments).sort((a, b) => a.startMs - b.startMs);
  const total = (stage: SleepSegmentRecord['stage']): number =>
    segments.filter((s) => s.stage === stage).reduce((a, s) => a + s.durationSec, 0);
  const deepSec = total('deep');
  const lightSec = total('light');
  const remSec = total('rem');
  const awakeSec = total('awake');
  const stagesPresent = [deepSec, lightSec, remSec, awakeSec].filter((v) => v > 0).length;
  const inBedSec = Math.round(sorted.reduce((a, s) => a + (s.endMs - s.startMs), 0) / 1000);
  // Dormido = profundo + ligero + REM. Pero el anillo puede dar el sueño sin fases (solo cuándo empezó y acabó) o marcarlo entero
  // como siesta (un sueño de día): entonces no hay fases que sumar y valen la duración de las siestas o, si no hay tramos, la de la cama.
  const stagedSec = deepSec + lightSec + remSec;
  const napSec = total('nap');
  const asleepSec = stagedSec > 0 ? stagedSec : napSec > 0 ? Math.min(napSec, inBedSec) : awakeSec > 0 ? 0 : inBedSec;
  return {
    day,
    startMs: sorted[0]?.startMs ?? 0,
    // La noche acaba cuando acaba la sesión que más tarde acaba (no la última en empezar: una puede estar dentro de otra).
    endMs: sorted.length > 0 ? maxOf(sorted.map((s) => s.endMs)) : 0,
    deepSec,
    lightSec,
    remSec,
    awakeSec,
    asleepSec,
    inBedSec,
    segments,
    hasStages: stagesPresent >= 2,
    sessions: sorted.length,
    estimated: sorted.length > 0 && sorted.every((s) => s.estimated === true),
    manual: sorted.some((s) => s.manual === true),
  };
}

/** Cómo fue la noche, solo con lo que dan las fases: sin ellas no se puede saber si hubo despertares. */
export interface NightFacts {
  /** Veces que se despertó entre dormirse y el despertar definitivo (varios tramos «despierto» seguidos cuentan como una). */
  wakeUps: number;
  /** Lo que estuvo despierto antes de dormirse: el tramo «despierto» con que empieza la noche (`null` si no empieza así). */
  fellAsleepAfterSec: number | null;
}

/** Menos de esto despierto al empezar no es «tardar en dormirse»: es el ruido de la propia medida. */
const MIN_FALL_ASLEEP_SEC = 60;
/**
 * Un hueco así entre dos tramos es tiempo despierto aunque ningún tramo lo diga: el anillo parte la noche en dos sesiones
 * cuando hay un despertar largo, y lo que queda entre ellas no está en ninguna. Menos que esto es redondeo de la medida.
 */
const MIN_WAKE_GAP_SEC = 10 * 60;

export function nightFacts(night: SleepNight): NightFacts | null {
  if (!night.hasStages) return null;
  // Los tramos por orden de hora, con cada hueco largo entre ellos como un tramo «despierto» más (la siesta cubre su propio rato).
  const timeline: Array<{ stage: SleepSegmentRecord['stage']; durationSec: number }> = [];
  let coveredUntil: number | null = null;
  for (const segment of night.segments) {
    if (coveredUntil !== null && (segment.startMs - coveredUntil) / 1000 >= MIN_WAKE_GAP_SEC) {
      timeline.push({ stage: 'awake', durationSec: (segment.startMs - coveredUntil) / 1000 });
    }
    timeline.push(segment);
    coveredUntil = Math.max(coveredUntil ?? segment.startMs, segment.startMs + segment.durationSec * 1000);
  }
  const stages = timeline.filter((s) => s.stage !== 'nap');
  const first = stages.findIndex((s) => s.stage !== 'awake');
  if (first < 0) return null;
  let last = stages.length - 1;
  while (last > first && stages[last]?.stage === 'awake') last--;

  // Entre el primer tramo dormido y el último, cada racha de «despierto» es un despertar. Lo de antes (tardar en dormirse)
  // y lo de después (el despertar definitivo) no lo son.
  let wakeUps = 0;
  let awakeRun = false;
  for (let i = first; i <= last; i++) {
    const awake = stages[i]?.stage === 'awake';
    if (awake && !awakeRun) wakeUps++;
    awakeRun = awake;
  }
  const before = stages.slice(0, first).reduce((sum, s) => sum + s.durationSec, 0);
  return { wakeUps, fellAsleepAfterSec: before >= MIN_FALL_ASLEEP_SEC ? before : null };
}

export interface SleepRegularity {
  nights: number;
  meanAsleepSec: number;
  sdAsleepMin: number;
  /** Hora media de acostarse, en minutos desde medianoche. */
  meanBedMin: number;
  sdBedMin: number;
  meanWakeMin: number;
  sdWakeMin: number;
  label: 'alta' | 'media' | 'baja';
}

/** Mínimo de noches para hablar de regularidad: con menos, la desviación no significa nada. */
export const MIN_NIGHTS_FOR_REGULARITY = 4;

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const sd = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
};

export interface NightTimes {
  /** Hora de acostarse, en minutos desde la medianoche. */
  bedMin: number;
  /** Hora de levantarse, en minutos desde la medianoche. */
  wakeMin: number;
  asleepSec: number;
}

/**
 * Una serie de horas del día (minutos desde medianoche) «desenrollada»: el reloj es un círculo y 23:30 y 00:30 están a 1 h, no a 23. Se corta
 * por el hueco más grande entre dos valores (el rato del día en que la persona nunca hace eso), así que vale para cualquier horario: el de
 * quien duerme de noche, el de quien duerme de día y el de quien se acuesta pasada la medianoche. Devuelve los valores contados desde
 * el principio del grupo y la hora (del día) en que empieza ese grupo.
 */
export function unrollClock(minutes: readonly number[]): { values: number[]; start: number } {
  const day = 1440;
  const sorted = minutes.map((m) => ((m % day) + day) % day).sort((a, b) => a - b);
  if (sorted.length === 0) return { values: [], start: 0 };
  // El hueco entre cada valor y el siguiente (el último, con el primero del día siguiente): el mayor dice dónde cortar.
  let start = sorted[0] as number;
  let widest = -1;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? (sorted[i + 1] as number) : (sorted[0] as number) + day;
    const gap = next - (sorted[i] as number);
    if (gap > widest) {
      widest = gap;
      start = next % day;
    }
  }
  return { values: minutes.map((m) => ((((m % day) + day) % day) - start + day) % day), start };
}

/**
 * Regularidad del sueño: dispersión (desviación típica) de la hora de acostarse y de despertar.
 * Las horas se «desenrollan» (`unrollClock`) para que el grupo sea continuo (23:30 y 00:30 quedan a 1 h, también si se duerme de día).
 * Umbrales: ≤ 30 min alta, ≤ 60 min media, más baja (los estudios de regularidad suelen usar 60 min).
 */
export function sleepRegularityOf(times: readonly NightTimes[]): SleepRegularity | null {
  const usable = times.filter((n) => n.asleepSec > 0);
  if (usable.length < MIN_NIGHTS_FOR_REGULARITY) return null;
  const bed = unrollClock(usable.map((n) => n.bedMin));
  const wake = unrollClock(usable.map((n) => n.wakeMin));
  const asleep = usable.map((n) => n.asleepSec / 60);
  const sdBed = sd(bed.values);
  const sdWake = sd(wake.values);
  const worst = Math.max(sdBed, sdWake);
  return {
    nights: usable.length,
    meanAsleepSec: Math.round(mean(asleep) * 60),
    sdAsleepMin: Math.round(sd(asleep)),
    meanBedMin: Math.round((mean(bed.values) + bed.start) % 1440),
    sdBedMin: Math.round(sdBed),
    meanWakeMin: Math.round((mean(wake.values) + wake.start) % 1440),
    sdWakeMin: Math.round(sdWake),
    label: worst <= 30 ? 'alta' : worst <= 60 ? 'media' : 'baja',
  };
}

export function sleepRegularity(nights: readonly SleepNight[]): SleepRegularity | null {
  return sleepRegularityOf(nights.map((n) => ({ bedMin: minutesOfDay(n.startMs), wakeMin: minutesOfDay(n.endMs), asleepSec: n.asleepSec })));
}
