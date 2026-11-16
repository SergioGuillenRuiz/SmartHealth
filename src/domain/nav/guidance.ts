import { bearingDeg, projectOnSegment, type LatLon } from './geo';
import { cueForStep, type NavCue } from './cues';
import type { Step } from './maneuvers';
import type { Route } from './router';

// La guía: va siguiendo la posición del GPS sobre la ruta y avisa en el momento justo con zumbidos (`cues.ts`: dos zumbidos en el oído del lado del giro). Es lógica pura (sin reloj propio ni
// sonido): quien la usa le pasa las posiciones y un `Cuer`.
//
// Cuándo avisa (lo que más cuenta para no tener que mirar la pantalla):
//  - Cada giro se avisa UNA vez, unos 5 segundos antes de llegar a él. Esos 5 segundos son de marcha REAL: a la velocidad que lleva la persona ahora (andando 7 m, corriendo 17 m, en bici
//    35 m o más), con un mínimo de 8 m para que a paso muy lento no suene ya pasado el cruce.
//  - Para ser lo más exacta posible no se fía de la lectura suelta del GPS (que baila varios metros): sigue la posición con un filtro que mezcla la ruta, la velocidad que mide el GPS
//    (efecto Doppler, muy fina) y la edad de la lectura (una lectura que llega 1 s tarde ya es de hace 1 s: se le suma lo que se ha avanzado desde entonces).
//  - Y como el GPS da una lectura por segundo, si el momento del aviso cae ENTRE dos lecturas se programa para su instante exacto (`delayMs`; el reloj del audio no tiene hueco de un segundo)
//    en lugar de esperar a la siguiente.
//  - Si dos giros están tan juntos que el segundo caería dentro del aviso del primero, suenan seguidos en un solo aviso: el primero y, tras una pausa, el segundo en su oído.
//  - Nada suena dos veces. Seguir recto y salir no suenan: avisar de más cansa y hace perder los avisos que importan.

export interface Cuer {
  /** `interrupt`: corta lo que suena. `delayMs`: que suene dentro de tantos milisegundos (para el instante exacto entre dos lecturas del GPS). */
  cue(cue: NavCue, options?: { interrupt?: boolean; delayMs?: number }): void;
  stop(): void;
}

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMs: number | null;
  /** Cuándo se midió (ms). */
  tsMs: number;
  /** Cuánto hace de la medida cuando llega aquí (ms; 0 si no se sabe). */
  ageMs?: number;
}

export type GuidanceStatus = 'approaching' | 'navigating' | 'off-route' | 'arrived';

export interface GuidanceState {
  status: GuidanceStatus;
  /** Cuánto se ha avanzado por la ruta (m). */
  progressM: number;
  remainingM: number;
  remainingS: number;
  /** La siguiente instrucción (`null` al llegar). */
  nextStep: Step | null;
  nextStepIndex: number;
  distToNextM: number;
  /** A cuánto está de la ruta (m). */
  offRouteM: number;
  /** La posición sobre la ruta y hacia dónde apunta la ruta ahí (grados). */
  position: LatLon;
  heading: number;
  /** Hay que pedir otra ruta desde la posición actual. */
  rerouteNeeded: boolean;
  /** La velocidad que se está usando (m/s). */
  speedMs: number;
}

export interface GuidanceOptions {
  /** Velocidad típica del deporte (m/s), hasta que se mida la real. */
  nominalSpeedMs: number;
  muted?: boolean;
}

/** Cuántos segundos antes del giro suena el aviso. */
export const ALERT_S = 5;
/** Aunque se vaya muy despacio, el aviso suena al menos a esta distancia del giro (m) y como mucho a esta otra. */
export const MIN_ALERT_M = 8;
const MAX_ALERT_M = 150;
/** Si el momento del aviso cae dentro de este margen (s) se programa para su instante exacto; antes de eso, todavía no. Algo más que el intervalo del GPS (1 s). */
const HORIZON_S = 1.6;
/** Para calcular el tiempo que falta, la velocidad no baja de esto (m/s) ni de esta fracción de la de marcha: parado en un semáforo, no se avisa hasta que se echa a andar. */
const MIN_TIMING_SPEED_MS = 0.5;
const CRUISE_FLOOR = 0.6;
/** Una lectura más vieja que esto (s) no se «adelanta» más: el reloj del móvil y el del GPS no son de fiar para más. */
const MAX_FIX_AGE_S = 3;
/** Si el aviso del giro siguiente caería a menos de esto (s de marcha) del de este, el primero aún estaría sonando: van en un solo aviso. */
const CHAIN_S = 2;
const ARRIVE_M = 15;
const OFF_ROUTE_MIN_M = 25;
const OFF_ROUTE_MAX_M = 70;
/** Un GPS peor que esto (m de error) no vale para decidir nada. */
const MAX_USABLE_ACCURACY_M = 60;
/** Cuánto se tolera estar fuera para pedir otra ruta (s) y cuántas lecturas seguidas. */
const OFF_ROUTE_AFTER_S = 6;
const OFF_ROUTE_FIXES = 3;
const APPROACH_GIVE_UP_S = 120;
const APPROACH_GIVE_UP_M = 500;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** La posición y el rumbo de la ruta a `m` metros de su inicio. */
export function positionAlong(route: Route, m: number): { position: LatLon; heading: number } {
  const last = route.points.length - 1;
  const target = clamp(m, 0, route.distanceM);
  let i = 1;
  while (i < last && route.cumM[i]! < target) i++;
  const a = route.points[Math.max(0, i - 1)]!;
  const b = route.points[Math.min(last, i)]!;
  const span = (route.cumM[Math.min(last, i)] ?? 0) - (route.cumM[Math.max(0, i - 1)] ?? 0);
  const t = span === 0 ? 0 : clamp((target - (route.cumM[Math.max(0, i - 1)] ?? 0)) / span, 0, 1);
  return { position: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }, heading: a === b ? 0 : bearingDeg(a, b) };
}

export class Guidance {
  private route: Route;
  private steps: Step[];
  private along = 0;
  private everOnRoute = false;
  private startedMs: number | null = null;
  private offSinceMs: number | null = null;
  private offFixes = 0;
  private alerted = new Set<number>();
  /** La posición a lo largo de la ruta y la velocidad ESTIMADAS (más finas que la lectura suelta): de aquí sale el tiempo que falta para cada giro. */
  private track: { s: number; v: number; tsMs: number } | null = null;
  private arrivedSpoken = false;
  private rerouteSpoken = false;
  private speed: number;
  private lastFix: { along: number; tsMs: number } | null = null;
  private movingS = 0;
  private lastState: GuidanceState | null = null;
  muted: boolean;

  constructor(
    route: Route,
    steps: Step[],
    private readonly cuer: Cuer,
    private readonly options: GuidanceOptions,
  ) {
    this.route = route;
    this.steps = steps;
    this.speed = options.nominalSpeedMs;
    this.muted = options.muted ?? false;
  }

  get currentRoute(): Route {
    return this.route;
  }

  /** Cambia la ruta por otra recalculada: se vuelve a empezar desde su principio. */
  replaceRoute(route: Route, steps: Step[]): void {
    this.route = route;
    this.steps = steps;
    this.along = 0;
    this.everOnRoute = false;
    this.startedMs = null;
    this.offSinceMs = null;
    this.offFixes = 0;
    this.alerted.clear();
    this.track = null;
    this.arrivedSpoken = false;
    this.rerouteSpoken = false;
    this.lastFix = null;
  }

  private emit(cue: NavCue | null, interrupt: boolean, delayMs = 0): void {
    if (this.muted || cue === null) return;
    this.cuer.cue(cue, delayMs > 0 ? { interrupt, delayMs } : { interrupt });
  }

  /** Procesa una posición del GPS. Devuelve cómo va el recorrido. */
  update(fix: Fix): GuidanceState {
    const route = this.route;
    if (fix.accuracyM > MAX_USABLE_ACCURACY_M && this.lastState) return this.lastState;
    if (this.startedMs === null) this.startedMs = fix.tsMs;

    // Se busca la proyección sobre la ruta en una ventana alrededor de lo avanzado (o en toda si aún no se ha entrado en ella).
    const proj = this.project(fix, this.everOnRoute ? { back: 40, ahead: 300 } : null);
    const speedNow = this.measureSpeed(fix, proj.along);
    const onRoute = proj.distM <= this.offLimit(fix);
    this.updateTrack(fix, onRoute ? proj.along : null);
    if (onRoute) {
      this.everOnRoute = true;
      this.along = proj.along;
      this.offSinceMs = null;
      this.offFixes = 0;
      this.rerouteSpoken = false;
    }

    const remainingM = Math.max(0, route.distanceM - this.along);
    let status: GuidanceStatus = this.everOnRoute ? 'navigating' : 'approaching';
    let rerouteNeeded = false;

    // Fuera de la ruta.
    if (proj.distM > this.offLimit(fix)) {
      if (this.everOnRoute) {
        this.offFixes++;
        if (this.offSinceMs === null) this.offSinceMs = fix.tsMs;
        const longEnough = (fix.tsMs - this.offSinceMs) / 1000 >= OFF_ROUTE_AFTER_S && this.offFixes >= OFF_ROUTE_FIXES;
        const farAway = proj.distM > this.offLimit(fix) * 2 && this.offFixes >= 2;
        if (longEnough || farAway) {
          status = 'off-route';
          rerouteNeeded = true;
        }
      } else if (proj.distM > APPROACH_GIVE_UP_M || (fix.tsMs - this.startedMs) / 1000 > APPROACH_GIVE_UP_S) {
        status = 'off-route';
        rerouteNeeded = true;
      }
      // Que se haya salido de la ruta no suena: puede ser un atajo (una calle contigua, un parque). Lo que suena es el cambio de sentido o la equivocación, y eso lo sabe quien recalcula la ruta
      // (`app/nav/navigator.ts`): solo si la ruta nueva manda dar la vuelta.
      if (rerouteNeeded && !this.rerouteSpoken) this.rerouteSpoken = true;
    }

    // Llegada.
    const arrived = this.everOnRoute && remainingM <= Math.max(ARRIVE_M, Math.min(25, fix.accuracyM));
    if (arrived) {
      status = 'arrived';
      if (!this.arrivedSpoken) {
        this.arrivedSpoken = true;
        this.emit({ kind: 'arrive', ear: 'both' }, true);
      }
    }

    // Instrucciones.
    const nextIndex = this.nextStepIndex(this.along);
    const next = this.steps[nextIndex] ?? null;
    const distToNext = next ? Math.max(0, next.atM - this.along) : 0;
    if (status === 'navigating' && next) this.announce(nextIndex, next, fix);

    const here = positionAlong(route, this.along);
    const nominal = this.options.nominalSpeedMs;
    const paceFactor = this.movingS >= 60 ? clamp(this.speed / nominal, 0.6, 1.6) : 1;
    const state: GuidanceState = {
      status,
      progressM: this.along,
      remainingM,
      remainingS: route.distanceM > 0 ? ((route.durationS * remainingM) / route.distanceM) / paceFactor : 0,
      nextStep: next,
      nextStepIndex: nextIndex,
      distToNextM: distToNext,
      offRouteM: proj.distM,
      position: here.position,
      heading: here.heading,
      rerouteNeeded,
      speedMs: speedNow,
    };
    this.lastState = state;
    return state;
  }

  private offLimit(fix: Fix): number {
    return clamp(15 + fix.accuracyM + (fix.speedMs ?? this.speed), OFF_ROUTE_MIN_M, OFF_ROUTE_MAX_M);
  }

  private nextStepIndex(along: number): number {
    for (let i = 1; i < this.steps.length; i++) if (this.steps[i]!.atM > along + 3) return i;
    return Math.max(0, this.steps.length - 1);
  }

  private project(fix: Fix, window: { back: number; ahead: number } | null): { along: number; distM: number } {
    const { points, cumM } = this.route;
    let from = 0;
    let to = points.length - 2;
    if (window) {
      const lo = Math.max(0, this.along - window.back);
      const hi = this.along + window.ahead;
      from = Math.max(0, this.indexAtOrBefore(lo));
      to = Math.min(points.length - 2, this.indexAtOrBefore(hi) + 1);
    }
    let best = { along: 0, distM: Infinity };
    const search = (a: number, b: number): void => {
      for (let i = a; i <= b; i++) {
        const p = points[i]!;
        const q = points[i + 1]!;
        const proj = projectOnSegment(fix.lat, fix.lon, p.lat, p.lon, q.lat, q.lon);
        if (proj.distM < best.distM) best = { distM: proj.distM, along: cumM[i]! + proj.t * (cumM[i + 1]! - cumM[i]!) };
      }
    };
    search(from, to);
    // Si en la ventana está lejos pero en toda la ruta hay algo cerca (se perdió la cuenta), se coge lo de toda la ruta.
    if (window && best.distM > OFF_ROUTE_MIN_M) {
      const all = { ...best };
      best = { along: 0, distM: Infinity };
      search(0, points.length - 2);
      if (best.distM > all.distM - 5) best = all;
    }
    return best;
  }

  private indexAtOrBefore(m: number): number {
    const { cumM } = this.route;
    let lo = 0;
    let hi = cumM.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumM[mid]! <= m) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private measureSpeed(fix: Fix, along: number): number {
    let v = fix.speedMs !== null && fix.speedMs >= 0 && fix.speedMs < 30 ? fix.speedMs : null;
    if (this.lastFix && fix.tsMs > this.lastFix.tsMs) {
      const dt = (fix.tsMs - this.lastFix.tsMs) / 1000;
      if (v === null && dt >= 0.5 && dt <= 15) v = Math.max(0, (along - this.lastFix.along) / dt);
      if (v !== null && v > 0.5) this.movingS += Math.min(dt, 10);
    }
    this.lastFix = { along, tsMs: fix.tsMs };
    // Parado o muy lento no cambia cuándo se habla: se conserva la velocidad de marcha.
    if (v !== null && v >= 0.8) this.speed = this.speed * 0.8 + v * 0.2;
    return this.speed;
  }

  /**
   * Sigue la posición y la velocidad con un filtro sencillo (alfa-beta): predice dónde debería estar y corrige con lo que mide el GPS, más cuanto mejor es la lectura. La velocidad
   * del GPS (Doppler) pesa mucho: es mucho más fina que la que sale de restar posiciones. Fuera de la ruta no se corrige (se sigue avanzando con la última velocidad).
   */
  private updateTrack(fix: Fix, measuredAlong: number | null): void {
    const doppler = fix.speedMs !== null && fix.speedMs >= 0 && fix.speedMs < 30 ? fix.speedMs : null;
    const previous = this.track;
    if (previous === null || (fix.tsMs - previous.tsMs) / 1000 > 10) {
      if (measuredAlong !== null) this.track = { s: measuredAlong, v: doppler ?? 0, tsMs: fix.tsMs };
      return;
    }
    const dt = (fix.tsMs - previous.tsMs) / 1000;
    if (dt <= 0) return;
    const predicted = previous.s + previous.v * dt;
    if (measuredAlong === null) {
      this.track = { s: predicted, v: previous.v, tsMs: fix.tsMs };
      return;
    }
    const residual = measuredAlong - predicted;
    const gain = clamp(0.8 - fix.accuracyM / 60, 0.25, 0.75);
    let v = previous.v + (0.3 * gain * residual) / dt;
    if (doppler !== null) v = 0.35 * v + 0.65 * doppler;
    this.track = { s: predicted + gain * residual, v: clamp(v, 0, 15), tsMs: fix.tsMs };
  }

  /** La velocidad con la que se calcula cuánto falta para un giro: la de ahora, sin bajar de una parte de la de marcha (parado un momento no se avisa hasta echar a andar). */
  private timingSpeed(): number {
    return Math.max(this.track?.v ?? 0, this.speed * CRUISE_FLOOR, MIN_TIMING_SPEED_MS);
  }

  /** A cuántos metros del giro suena el aviso a la velocidad de ahora (≈ 5 s de marcha). */
  private alertM(): number {
    return clamp(this.timingSpeed() * ALERT_S, MIN_ALERT_M, MAX_ALERT_M);
  }

  private announce(index: number, step: Step, fix: Fix): void {
    // A la llegada solo suena el aviso de «has llegado» (lo da `update`).
    if (step.type === 'arrive' || this.alerted.has(index) || this.track === null) return;
    // La posición de AHORA: la estimada en el momento de la lectura, más lo que se ha avanzado desde entonces.
    const ageS = clamp((fix.ageMs ?? 0) / 1000, 0, MAX_FIX_AGE_S);
    const now = this.track.s + this.track.v * ageS;
    const v = this.timingSpeed();
    const alertM = this.alertM();
    const toGoM = step.atM - now - alertM;
    const waitS = toGoM / v;
    if (waitS > HORIZON_S) return;
    this.alerted.add(index);
    const delayMs = waitS <= 0.05 ? 0 : Math.round(waitS * 1000);
    this.emit(this.withFollowUp(index, cueForStep(step), v), delayMs === 0, delayMs);
  }

  /** Si el giro siguiente es tan cercano que su aviso caería encima de este (los dos avisos están a la misma distancia de su giro, así que distan entre sí lo que distan los giros), suena a continuación con su propio oído. */
  private withFollowUp(index: number, cue: NavCue | null, speed: number): NavCue | null {
    if (cue === null) return null;
    const step = this.steps[index]!;
    const after = this.steps[index + 1];
    if (!after || after.type === 'arrive') return cue;
    if (after.atM - step.atM > Math.min(40, speed * CHAIN_S)) return cue;
    const followUp = cueForStep(after);
    if (followUp === null) return cue;
    this.alerted.add(index + 1);
    return { ...cue, then: followUp };
  }
}
