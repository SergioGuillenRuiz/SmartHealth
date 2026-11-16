import { dayKeyOf, type DayKey } from './dates';
import {
  baseStride,
  bmrKcalPerDay,
  cadenceSpm,
  keytelGrossKcalPerMin,
  locomotionMet,
  netKcalFromMet,
  round,
  stepsToDistanceM,
} from './estimation';
import { CLIMB_KCAL_PER_KG_M } from './ascent';
import { hrActivity, hrEffort, hrRestFloor, moveThresholdKmh } from './activity-gate';
import { hrMaxForAge } from './hrzones';
import { ageAt, type ResolvedProfile } from './profile';
import { sportById, type SportId } from './sports';
import type { Provenance } from './types';

/** Un entrenamiento tal y como se guarda: solo hechos, sin cifras derivadas (esas se calculan al leer). */
export interface WorkoutRecord {
  id: string;
  sport: SportId;
  startMs: number;
  endMs: number;
  /** Tiempo en pausa dentro de [startMs, endMs]. */
  pausedMs: number;
  /** `live`: grabado con el anillo en la app. `manual`: añadido a posteriori. */
  source: 'live' | 'manual';
  /** Pasos que contó el anillo durante la sesión. `0`: el contador del anillo estaba en marcha y no contó ninguno (no se anduvo); sin el campo, no se sabe. */
  steps?: number;
  /** Distancia aportada por el GPS o escrita por el usuario. */
  distanceM?: number;
  distanceSource?: 'gps' | 'manual';
  /**
   * Con GPS: metros recorridos en cada minuto de tiempo ACTIVO (las pausas no cuentan), y -1 en los minutos sin ninguna
   * lectura del GPS (un túnel, una calle cubierta). Da la velocidad minuto a minuto: la energía se calcula con ella y no
   * con la media, que mezclaría los semáforos con el resto del paseo.
   */
  splitsM?: number[];
  /**
   * Por dónde se fue, con el GPS: pares [latitud, longitud] simplificados (≤ 600 puntos, ver `domain/route-trace.ts`). Sirve para dibujar el recorrido al revisar el entreno; no entra en
   * ningún cálculo. Sin GPS, o en un entreno añadido a mano, no existe.
   */
  route?: Array<[number, number]>;
  /**
   * Metros subidos durante un paseo, medidos con el barómetro del móvil (solo en `Caminar` con la ruta grabada en el móvil). Se suma a
   * las calorías cuando no salen del pulso: la velocidad por sí sola no sabe de cuestas.
   */
  ascentM?: number;
  /** Calorías fijadas por el usuario (anulan la estimación). */
  kcalManual?: number;
  /** Muestras de FC del anillo: [instante, lpm]. */
  hr?: Array<[number, number]>;
  note?: string;
}

/** El borrador de un entreno en curso: el registro hasta ahora, más hasta qué posición del GPS nativo ya lleva (ver `extendWithTrack`). */
export interface WorkoutDraft extends WorkoutRecord {
  trackSeq?: number;
}

export type KcalMethod = 'manual' | 'speed-met' | 'hr' | 'met';

/** Un entreno con menos de esto parado (sin actividad) no lo enseña como «sin actividad»: unos segundos en un semáforo no son un error de nadie. */
export const MIN_IDLE_TO_REPORT_MS = 3 * 60_000;

export interface WorkoutEstimate {
  id: string;
  sport: SportId;
  day: DayKey;
  activeMs: number;
  distanceM: number | null;
  distanceProvenance: Provenance | null;
  avgSpeedKmh: number | null;
  /** kcal NETAS (por encima del reposo). */
  kcal: number;
  kcalMethod: KcalMethod;
  kcalProvenance: Provenance;
  steps: number | null;
  /** Metros subidos (solo si se midieron en un paseo). */
  ascentM: number | null;
  /**
   * Tiempo activo en el que NO se estaba haciendo el ejercicio (parado en un semáforo, entre series, o sin pulsar «Pausa» al acabar), según la velocidad del GPS o el pulso del
   * anillo; 0 si no hay con qué decirlo. Ese tiempo suma calorías de reposo, no de ejercicio (ver `domain/activity-gate.ts`).
   */
  idleMs: number;
  avgBpm: number | null;
  maxBpm: number | null;
  minBpm: number | null;
}

const MIN_ACTIVE_FOR_SPEED_MS = 3 * 60_000;
/** Para usar la FC deben cubrirse al menos la mitad de los minutos activos y estar en rango de esfuerzo. */
const MIN_HR_COVERAGE = 0.5;
const MIN_HR_FOR_KEYTEL = 90;
const MAX_SAMPLE_GAP_MS = 30_000;

export const workoutDay = (w: Pick<WorkoutRecord, 'startMs'>): DayKey => dayKeyOf(w.startMs);

export function activeMsOf(w: Pick<WorkoutRecord, 'startMs' | 'endMs' | 'pausedMs'>): number {
  return Math.max(0, w.endMs - w.startMs - Math.max(0, w.pausedMs));
}

/**
 * Estima distancia, velocidad y energía de un entrenamiento. `ringSteps` son los pasos que el anillo contó durante su
 * ventana cuando el propio entrenamiento no tiene pasos ni distancia (uno manual a pie, por ejemplo): solo se usan
 * entonces y solo en deportes a pie. `ringShare` (0–1] es la parte del entrenamiento que esos pasos cubren: menos de 1 si
 * cruza la medianoche y solo se conocen los pasos del día en que empezó.
 */
export function estimateWorkout(w: WorkoutRecord, profile: ResolvedProfile, ringSteps = 0, ringShare = 1): WorkoutEstimate {
  const sport = sportById(w.sport);
  const day = workoutDay(w);
  const activeMs = activeMsOf(w);
  const activeHours = activeMs / 3_600_000;
  const stride = baseStride(profile);

  // El GPS midió «no se movió» (ver `WorkoutRecorder.gpsSaysStill`): se guarda como distancia 0 con origen GPS. A pie y en bici (los deportes en que el GPS dice si se avanza).
  const gpsStill = (sport.kind === 'ambulatory' || sport.kind === 'cycling') && w.distanceSource === 'gps' && w.distanceM === 0;
  // Distancia: GPS/manual si la hay; si no, solo a pie y con los pasos reales del anillo.
  let distanceM: number | null = null;
  let distanceProvenance: Provenance | null = null;
  // Tiempo activo al que corresponde la distancia (todo el entreno, salvo que solo se conozcan los pasos de una parte).
  let measuredMs = activeMs;
  if (w.distanceM !== undefined && w.distanceM > 0) {
    distanceM = w.distanceM;
    distanceProvenance = w.distanceSource === 'gps' ? 'phone' : 'manual';
  } else if (sport.kind === 'ambulatory' && (w.steps ?? 0) > 0) {
    distanceM = stepsToDistanceM(w.steps ?? 0, stride, cadenceSpm(w.steps ?? 0, activeMs));
    distanceProvenance = 'estimated';
  } else if (sport.kind === 'ambulatory' && ringSteps > 0) {
    // Los pasos del anillo en la ventana, sobre el tiempo activo (como los pasos propios): una pausa suele ser parada.
    // Si solo cubren una parte del entreno, la cadencia y la velocidad se miden sobre esa misma parte.
    measuredMs = activeMs * Math.min(1, Math.max(ringShare, 0.01));
    distanceM = stepsToDistanceM(ringSteps, stride, cadenceSpm(ringSteps, measuredMs));
    distanceProvenance = 'estimated';
  } else if (gpsStill) {
    // El GPS dio señal casi todo el rato y no se avanzó nada (y no hay ni un paso en contra): distancia 0 medida, no «sin dato».
    distanceM = 0;
    distanceProvenance = 'phone';
  }
  // Con distancia 0 («no se movió») no hay velocidad media que enseñar ni MET de velocidad: la energía sale del pulso, si lo hay, o del MET de estar parado.
  const avgSpeedKmh = distanceM !== null && distanceM > 0 && measuredMs >= MIN_ACTIVE_FOR_SPEED_MS ? distanceM / 1000 / (measuredMs / 3_600_000) : null;

  // Frecuencia cardiaca
  const hr = (w.hr ?? []).filter(([, bpm]) => bpm >= 35 && bpm <= 220).sort((a, b) => a[0] - b[0]);
  const bpms = hr.map(([, bpm]) => bpm);
  const avgBpm = bpms.length ? round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null;
  const maxBpm = bpms.length ? Math.max(...bpms) : null;
  const minBpm = bpms.length ? Math.min(...bpms) : null;

  // ¿Se estaba haciendo el ejercicio? Primero con la velocidad minuto a minuto del GPS (la que ya guarda el entreno); si no la hay, con el pulso. Sin ninguna, no se sabe y se sigue
  // suponiendo que sí (`null`).
  const hrFloor = hrRestFloor(hrMaxForAge(ageAt(profile.birthDate, day)), sport.genericMet);
  const splitStates = splitMinutes();
  const hrGate = splitStates === null && hr.length > 0 ? hrActivity(hr, w.startMs, hrFloor) : null;
  const hrIdle = hrGate?.idleShare ?? null;
  const idleMs = Math.round(
    splitStates !== null
      ? splitStates.idleShare * activeMs
      : hrIdle !== null
        ? hrIdle * activeMs
        : gpsStill
          ? activeMs
          : 0,
  );

  const base = energy();
  // Subir cuesta aparte: la velocidad (MET) no sabe de pendientes. Solo a pie y solo si las calorías no salen del pulso, que ya lo recoge.
  const climbKcal = sport.id === 'walk' && (base.method === 'speed-met' || base.method === 'met') && (w.ascentM ?? 0) > 0 ? CLIMB_KCAL_PER_KG_M * profile.weightKg * (w.ascentM ?? 0) : 0;
  const kcal = base.kcal + climbKcal;
  const method = base.method;
  const provenance = base.provenance;

  return {
    id: w.id,
    sport: w.sport,
    day,
    activeMs,
    distanceM: distanceM === null ? null : round(distanceM),
    distanceProvenance,
    avgSpeedKmh: avgSpeedKmh === null ? null : round(avgSpeedKmh, 1),
    kcal: round(kcal),
    kcalMethod: method,
    kcalProvenance: provenance,
    steps: w.steps ?? null,
    ascentM: w.ascentM !== undefined && w.ascentM > 0 ? w.ascentM : null,
    idleMs,
    avgBpm,
    maxBpm,
    minBpm,
  };

  function energy(): { kcal: number; method: KcalMethod; provenance: Provenance } {
    if (w.kcalManual !== undefined && w.kcalManual >= 0) {
      return { kcal: w.kcalManual, method: 'manual', provenance: 'manual' };
    }
    // 1) Velocidad conocida → MET de esa velocidad (más robusta que una FC de muñeca/dedo en movimiento). Con la velocidad
    // minuto a minuto del GPS, cada minuto con su propio MET; si no, con la media.
    if (sport.speedMet && avgSpeedKmh !== null) {
      const bySplits = energyBySplits(sport.speedMet);
      const kcal = bySplits ?? netKcalFromMet(sport.speedMet(avgSpeedKmh), profile.weightKg, activeHours);
      return { kcal, method: 'speed-met', provenance: 'estimated' };
    }
    // 2) FC suficiente → Keytel integrada, descontando el reposo (y sin contar lo que está por debajo del umbral de reposo: ver `keytelNet`).
    const fromHr = keytelNet();
    if (fromHr !== null) return { kcal: fromHr, method: 'hr', provenance: 'estimated' };
    // 3) Con el GPS diciendo que no se avanzó (a pie o en bici), o a pie con el contador de pasos del anillo en marcha y ni un paso (ni distancia): no se ha hecho el ejercicio. El MET genérico de
    // caminar (3,5) por tiempo contaría como paseo un rato sentado (≈3 kcal por minuto a 80 kg), y el de la bici (6,8) ≈ 7; aquí manda el MET de estar parado, el de la velocidad 0.
    if (gpsStill || (sport.kind === 'ambulatory' && w.steps === 0 && distanceM === null)) {
      return { kcal: netKcalFromMet(locomotionMet(0), profile.weightKg, activeHours), method: 'speed-met', provenance: 'estimated' };
    }
    // 4) Sin MET por velocidad (BiciMAD, senderismo…) pero con el GPS minuto a minuto: se hace el ejercicio en los minutos en que se avanza, y en los de parada, reposo.
    if (splitStates !== null) {
      const active = netKcalFromMet(sport.genericMet, profile.weightKg, activeHours * (1 - splitStates.idleShare));
      const rest = netKcalFromMet(locomotionMet(0), profile.weightKg, activeHours * splitStates.idleShare);
      return { kcal: active + rest, method: 'met', provenance: 'estimated' };
    }
    // 5) MET genérico del deporte, solo en los minutos en que el pulso dice que se hace ejercicio (fuerza, natación, pelota…); el resto, reposo. Sin pulso suficiente se supone que se
    // hace todo el rato, como siempre.
    const share = hrGate?.effortShare === null || hrGate?.effortShare === undefined ? 0 : 1 - hrGate.effortShare;
    return {
      kcal: netKcalFromMet(sport.genericMet, profile.weightKg, activeHours * (1 - share)) + netKcalFromMet(locomotionMet(0), profile.weightKg, activeHours * share),
      method: 'met',
      provenance: 'estimated',
    };
  }

  /**
   * Los minutos del GPS (`splitsM`) como velocidades, si valen: con GPS, con la distancia que cuadra con ellos (si se corrigió a mano ya no son estos), y los minutos sin lectura (-1) se
   * completan con la proporción de los demás. `idleShare` es la parte del tiempo en que no se avanzaba (por debajo de `moveThresholdKmh`).
   */
  function splitMinutes(): { minutes: Array<{ ms: number; kmh: number }>; coveredMs: number; idleShare: number } | null {
    const splits = w.splitsM;
    if (!splits || splits.length === 0 || w.distanceSource !== 'gps' || !(w.distanceM !== undefined && w.distanceM > 0)) return null;
    const covered = splits.filter((m) => m >= 0);
    if (covered.length === 0) return null;
    const total = covered.reduce((a, b) => a + b, 0);
    if (Math.abs(total - w.distanceM) > Math.max(50, w.distanceM * 0.1)) return null;
    const minutes: Array<{ ms: number; kmh: number }> = [];
    let coveredMs = 0;
    let idleMs = 0;
    const threshold = moveThresholdKmh(sport.kind);
    splits.forEach((meters, i) => {
      if (meters < 0) return;
      // El último minuto puede ser parcial: se mide con lo que de verdad duró.
      const ms = i < splits.length - 1 ? 60_000 : Math.min(60_000, Math.max(5_000, activeMs - i * 60_000));
      const kmh = (meters / (ms / 1000)) * 3.6;
      minutes.push({ ms, kmh });
      coveredMs += ms;
      if (kmh < threshold) idleMs += ms;
    });
    return coveredMs > 0 ? { minutes, coveredMs, idleShare: idleMs / coveredMs } : null;
  }

  /**
   * kcal netas sumando el MET de la velocidad de cada minuto. El MET no es lineal con la velocidad, así que promediar la
   * velocidad de un paseo con semáforos (o de unas series) no da lo gastado: con los parones cuentan como parados y el
   * resto como lo que se iba. Los minutos sin GPS (-1) se completan con la intensidad media de los demás. Solo vale si
   * los minutos cuadran con la distancia guardada: si se corrigió a mano, ya no son estos.
   */
  function energyBySplits(speedMet: (speedKmh: number) => number): number | null {
    if (splitStates === null) return null;
    let kcal = 0;
    for (const { ms, kmh } of splitStates.minutes) kcal += netKcalFromMet(speedMet(kmh), profile.weightKg, ms / 3_600_000);
    return kcal * (activeMs / splitStates.coveredMs);
  }

  function keytelNet(): number | null {
    if (hr.length < 5 || activeMs <= 0 || avgBpm === null || avgBpm < MIN_HR_FOR_KEYTEL) return null;
    const age = ageAt(profile.birthDate, day);
    const restingPerMin = bmrKcalPerDay(profile, day) / 1440;
    let coveredMs = 0;
    let netKcal = 0;
    for (let i = 0; i < hr.length; i++) {
      const current = hr[i];
      const next = hr[i + 1];
      if (!current) continue;
      const gap = next ? Math.min(next[0] - current[0], MAX_SAMPLE_GAP_MS) : MAX_SAMPLE_GAP_MS / 2;
      if (gap <= 0) continue;
      coveredMs += gap;
      // Una lectura de reposo (por debajo del umbral) no es ejercicio: Keytel solo vale en esfuerzo y a 80 lpm sentado daría ~3 kcal por minuto. Entre el umbral y 10 lpm más, cuenta en proporción.
      const net = Math.max(0, keytelGrossKcalPerMin(profile.sex, current[1], profile.weightKg, age) - restingPerMin);
      netKcal += net * hrEffort(current[1], hrFloor) * (gap / 60_000);
    }
    if (coveredMs / activeMs < MIN_HR_COVERAGE) return null;
    // Los tramos sin muestra se completan con la media de los cubiertos.
    return netKcal * (activeMs / coveredMs);
  }
}
