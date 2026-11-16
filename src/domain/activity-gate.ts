import { clamp } from './estimation';
import type { Sport } from './sports';

// ¿Se está haciendo el ejercicio o no? Hasta la ronda 45 la energía de un entreno suponía que TODO el tiempo era ejercicio (el MET del deporte por el tiempo que corría el cronómetro), y quien
// se queda parado sin pulsar «Pausa» —en el semáforo, entre series, o se olvida al terminar— seguía sumando calorías (en bici ≈ 7 por minuto a 80 kg; en fuerza ≈ 4). Aquí se decide, minuto a
// minuto, con lo que haya: la velocidad del GPS (ver `moveThresholdKmh`) y, si no, el pulso del anillo. Sin ninguna señal no se inventa nada: se sigue suponiendo ejercicio, como antes.

/** Por debajo de esta velocidad (km/h) un minuto es de parada: en bici, un semáforo o ir andando con la bici al lado; a pie, estar quieto. */
export function moveThresholdKmh(kind: Sport['kind']): number {
  return kind === 'cycling' ? 4 : 1.5;
}

/**
 * Pulso (lpm) por debajo del cual un minuto de un deporte SIN velocidad (fuerza, natación, pelota…) se da por reposo. Con casi cualquier ejercicio, el pulso de la muñeca o del dedo
 * pasa de los ~85 lpm (el 45 % del máximo, con holgura entre 82 y 96 según la edad); sentado o de pie sin hacer nada queda entre 55 y 80. El yoga y lo suave tienen un umbral más bajo
 * (el 36 % del máximo, entre 62 y 74), porque su pulso es de verdad bajo.
 */
export function hrRestFloor(hrMax: number, genericMet: number): number {
  if (genericMet < 3) return clamp(Math.round(0.36 * hrMax), 62, 74);
  return clamp(Math.round(0.45 * hrMax), 82, 96);
}

/** Minutos mínimos con pulso para fiarse de él: un solo minuto puede ser el eco de la lectura anterior al empezar. */
const MIN_KNOWN_MINUTES = 2;

export interface HrActivity {
  /** Minutos (del reloj de pared desde el inicio) con alguna lectura de pulso, y cuántos de ellos son de esfuerzo. */
  knownMinutes: number;
  activeMinutes: number;
  /** Parte de los minutos con pulso que son de reposo (0–1); `null` si no hay pulso suficiente para decirlo. */
  idleShare: number | null;
  /** Cuánto esfuerzo hay de media en esos minutos (0–1), con la rampa de `hrEffort`: es lo que pondera la energía (sin saltos al cruzar el umbral); `null` si no hay pulso suficiente. */
  effortShare: number | null;
}

/**
 * Reparte en minutos las lecturas de pulso (instante, lpm) de un entreno y dice cuántos son de reposo. El minuto vale lo que marca su lectura MÁS ALTA (el anillo da el pulso en ráfagas y el
 * sensor repite a veces un valor bajo antes de enganchar: con la media, un minuto de esfuerzo parecería de reposo). Los minutos sin lectura no cuentan ni a favor ni en contra: así una pausa
 * (sin lecturas) no se toma por reposo.
 */
export function hrActivity(hr: ReadonlyArray<readonly [number, number]>, startMs: number, floorBpm: number): HrActivity {
  const peakByMinute = new Map<number, number>();
  for (const [ts, bpm] of hr) {
    const minute = Math.floor((ts - startMs) / 60_000);
    if (minute < 0) continue;
    peakByMinute.set(minute, Math.max(peakByMinute.get(minute) ?? 0, bpm));
  }
  let active = 0;
  let effort = 0;
  for (const peak of peakByMinute.values()) {
    if (peak >= floorBpm) active++;
    effort += hrEffort(peak, floorBpm);
  }
  const known = peakByMinute.size;
  const enough = known >= MIN_KNOWN_MINUTES;
  return { knownMinutes: known, activeMinutes: active, idleShare: enough ? (known - active) / known : null, effortShare: enough ? effort / known : null };
}

/**
 * Cuánto cuenta una lectura de pulso como ejercicio (0–1): nada por debajo del umbral de reposo y entera 10 lpm por encima, con una rampa entre medias para que la energía no dé un salto al
 * cruzarlo.
 */
export const hrEffort = (bpm: number, floorBpm: number): number => clamp((bpm - floorBpm) / 10, 0, 1);
