import { destinationPoint, type LatLon } from './geo';
import { describeCue, type NavCue } from './cues';
import { positionAlong, type Cuer, type Fix } from './guidance';
import type { Step } from './maneuvers';
import { PROFILES, type Profile } from './profiles';
import type { Route } from './router';

/** Un `Cuer` que apunta qué avisos suenan y a qué distancia de la ruta sonaron (la que marque `at`). */
export class CapturingCuer implements Cuer {
  readonly cues: Array<{ cue: NavCue; interrupt: boolean; atM: number; delayMs: number }> = [];
  stops = 0;
  at = 0;
  cue(cue: NavCue, options?: { interrupt?: boolean; delayMs?: number }): void {
    this.cues.push({ cue, interrupt: options?.interrupt ?? false, atM: this.at, delayMs: options?.delayMs ?? 0 });
  }
  stop(): void {
    this.stops++;
  }
  /** Los avisos dichos con palabras, en orden. */
  get described(): string[] {
    return this.cues.map((c) => describeCue(c.cue));
  }
}

/** Una ruta recta hacia el este de `lengthM` metros, para probar la guía sin una ciudad. */
export function lineRoute(lengthM: number, profile: Profile = PROFILES.walk, stepEveryM = 25): Route {
  const origin: LatLon = { lat: 40.4, lon: -3.7 };
  const points: LatLon[] = [];
  const cumM: number[] = [];
  for (let m = 0; m < lengthM; m += stepEveryM) {
    points.push(destinationPoint(origin, 90, m));
    cumM.push(m);
  }
  points.push(destinationPoint(origin, 90, lengthM));
  cumM.push(lengthM);
  const snap = { edge: 0, t: 0, lat: origin.lat, lon: origin.lon, distM: 0, lengthM };
  return { profile, points, cumM, distanceM: lengthM, durationS: lengthM / profile.speed(7, 0), legs: [], origin: snap, destination: snap };
}

export function step(type: Step['type'], atM: number, text: string, extra: Partial<Step> = {}): Step {
  return { type, turn: 'straight', exit: null, street: '', generic: '', pointIndex: 0, atM, lengthM: 0, text, heading: null, side: null, ...extra };
}

/** Una posición a `alongM` de la ruta y `lateralM` metros al norte de ella. */
export function fixAt(route: Route, alongM: number, tsMs: number, lateralM = 0, speedMs: number | null = null, accuracyM = 5): Fix {
  const base = positionAlong(route, alongM).position;
  const p = lateralM === 0 ? base : destinationPoint(base, 0, lateralM);
  return { lat: p.lat, lon: p.lon, accuracyM, speedMs, tsMs };
}
