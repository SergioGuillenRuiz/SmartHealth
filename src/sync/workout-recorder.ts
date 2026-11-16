import { baseStride, cadenceSpm, stepsToDistanceM, round } from '../domain/estimation';
import { AscentTracker } from '../domain/ascent';
import { GpsTracker, type GpsFix } from '../domain/gps';
import { RouteCollector } from '../domain/route-trace';
import { ageAt, type ResolvedProfile } from '../domain/profile';
import { hrMaxForAge, zoneOf, type HrProfile, type HrZone } from '../domain/hrzones';
import { sportById, type SportId } from '../domain/sports';
import { dayKeyOf } from '../domain/dates';
import { activeMsOf, estimateWorkout, type KcalMethod, type WorkoutRecord } from '../domain/workout';

export type RecorderStatus = 'running' | 'paused' | 'finished';

export interface RecorderSnapshot {
  status: RecorderStatus;
  startedMs: number;
  /** Tiempo activo (sin pausas). */
  activeMs: number;
  pausedMs: number;
  /** Último pulso si es reciente (≤ 75 s: con estos anillos llega en ráfagas al cierre de cada medida); si no, `null`. */
  bpm: number | null;
  /** La última lectura de pulso que hubo, sea o no reciente, y cuánto hace de ella (ms); `null` si aún no ha habido ninguna. */
  lastPulse: { bpm: number; ageMs: number } | null;
  avgBpm: number | null;
  maxBpm: number | null;
  zone: HrZone | null;
  hrMax: number;
  steps: number | null;
  distanceM: number | null;
  distanceSource: 'gps' | 'steps' | null;
  kcal: number;
  kcalMethod: KcalMethod;
  gps: 'off' | 'none' | 'poor' | 'good';
  ringConnected: boolean;
}

export interface RecorderOptions {
  sport: SportId;
  profile: ResolvedProfile;
  now: () => number;
  useGps: boolean;
  id?: string;
  /** Los pulsos personales (máximo observado y reposo) con los que se miden las zonas; sin ellos, la fórmula por edad. */
  hr?: HrProfile | null;
}

/** Las muestras de pulso se guardan como mucho cada ~5 s: 2 h de entreno son ~1 400 puntos, no 7 000. */
const HR_STORE_EVERY_MS = 4500;
/** Con estos anillos el pulso llega en ráfagas al cierre de cada medida (~35 s): una lectura sigue valiendo más de un minuto. */
const HR_FRESH_MS = 75_000;
const MIN_GPS_DISTANCE_M = 10;
/** Tope de minutos que se guardan con velocidad (24 h): un reloj del GPS descuadrado no puede crecer sin límite. */
export const MAX_SPLITS = 24 * 60;
/** Lo máximo que se guarda para un minuto (más de 300 km/h): un valor así es un error, y no debe invalidar una copia. */
export const MAX_SPLIT_M = 5000;
/**
 * Si la hora de una lectura del GPS difiere de la del móvil más que esto (reloj descuadrado, o lecturas que llegan muy
 * tarde), se usa la del móvil: una lectura llega al segundo de darse, y un desfase de decenas de segundos movería los
 * minutos de sitio.
 */
const MAX_GPS_CLOCK_SKEW_MS = 5_000;
/**
 * Reconciliación del GPS con los pasos en deportes a pie: en un minuto con al menos este número de pasos se está andando de
 * verdad (el brazo quieto o un gesto no llegan ni a la mitad). Si el GPS dice entonces menos de la mitad de lo que dicen los pasos,
 * el GPS falla en ese minuto —la pantalla apagada o la app en segundo plano sin señal, o una marcha tan lenta que el GPS la toma por
 * estar parado— y vale lo que dicen los pasos. Con el GPS bien, no cambia nada.
 */
const MIN_STEPS_PER_MINUTE = 20;
const GPS_UNDERREPORT_RATIO = 0.5;
/**
 * Un minuto cuyos metros solo son la cuerda repartida por un hueco del GPS (sin ninguna lectura propia) queda siempre corto
 * —la cuerda es el camino más corto, y en un recorrido con curvas pierde hasta un 30 %—: ahí basta que los pasos digan más.
 * Entre lecturas más separadas que esto (s) hay un hueco.
 */
const GPS_GAP_S = 10;
/**
 * Ritmo máximo creíble del contador del anillo (con holgura: la muñeca puede contar de más) y margen fijo. El margen deja
 * pasar subidas a saltos o repartidas en ráfagas (un contador que se queda plano y luego sube de golpe) y sigue rechazando
 * lo que es ruido: un contador que pasa de 0 al total del día son miles de pasos.
 */
const MAX_STEPS_PER_S = 6;
const STEPS_SLACK = 150;

/**
 * Máquina de estados de un entrenamiento en directo. No sabe nada de Bluetooth, GPS ni pantalla: recibe
 * pulso, pasos y posiciones y mantiene el cronómetro, las pausas y las cifras. Así se prueba sin hardware.
 *
 * Mientras está en pausa se ignoran el pulso, los pasos y el GPS: lo que ocurre en una pausa no es del entreno.
 */
export class WorkoutRecorder {
  readonly id: string;
  private status: RecorderStatus = 'running';
  private readonly startedMs: number;
  private endedMs: number | null = null;
  private pauseStartedMs: number | null = null;
  private pausedMs = 0;
  /**
   * Los tramos de pausa (inicio, y fin o `null` si sigue en pausa). Con ellos se sabe qué minuto ACTIVO es cualquier instante, también
   * el de una posición que llega tarde: la grabación del GPS en segundo plano las entrega al volver a verse la app, con su hora.
   */
  private readonly pauses: Array<[number, number | null]> = [];
  /**
   * Desde cuándo hay que cortar el recorrido del GPS tras reanudar: la primera posición con una hora igual o posterior empieza uno
   * nuevo. Las que recoge el servicio nativo pueden llegar DESPUÉS de reanudar con horas de antes de la pausa (y las de dentro de la
   * pausa se descartan): el corte tiene que caer en su sitio en la secuencia de posiciones, no en el momento de reanudar.
   */
  private pendingBreakAtMs: number | null = null;

  private lastBpm: { bpm: number; tsMs: number } | null = null;
  private hr: Array<[number, number]> = [];
  private lastStoredHrMs = 0;
  private hrSum = 0;
  private hrCount = 0;
  private hrMaxSeen: number | null = null;

  private stepsLastTotal: number | null = null;
  private stepsLastTs = 0;
  private stepsCounted = 0;

  private readonly gps: GpsTracker;
  /** Por dónde se ha ido (ver `WorkoutRecord.route`). */
  private readonly route = new RouteCollector();
  /** Metros subidos según el barómetro del móvil: solo al andar (ver `WorkoutRecord.ascentM`). */
  private readonly ascent: AscentTracker | null;
  /** Metros por minuto de tiempo activo y minutos con alguna lectura del GPS (ver `WorkoutRecord.splitsM`). */
  private splitMeters: number[] = [];
  private splitCovered: boolean[] = [];
  /** Minutos con alguna lectura del GPS propia (no solo la cuerda de un hueco repartida por ellos). */
  private splitReal: boolean[] = [];
  /** Instante (en tiempo activo) de la última lectura válida del GPS: desde ahí se reparte lo recorrido. */
  private lastSplitAt: number | null = null;
  /** Pasos por minuto de tiempo activo (con el mismo reloj que `splitMeters`) y desde dónde se repartió el último incremento. */
  private stepSplits: number[] = [];
  private lastStepSplitAt: number | null = null;
  private ringConnected = true;

  private readonly hrMax: number;

  constructor(private readonly options: RecorderOptions) {
    this.id = options.id ?? `w-${options.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.startedMs = options.now();
    // Cada deporte tiene su velocidad máxima creíble: con la de la bici (la más alta) un paseo daría por buenos saltos de GPS de
    // decenas de metros; con la de un paseo, una bajada en bici no contaría.
    const { maxGpsSpeedMs, maxGpsAccelerationMs2 } = sportById(options.sport);
    this.gps = new GpsTracker({
      ...(maxGpsSpeedMs === undefined ? {} : { maxSpeedMs: maxGpsSpeedMs }),
      ...(maxGpsAccelerationMs2 === undefined ? {} : { maxAccelerationMs2: maxGpsAccelerationMs2 }),
    });
    this.hrMax = options.hr?.hrMax ?? hrMaxForAge(ageAt(options.profile.birthDate, dayKeyOf(this.startedMs)));
    this.ascent = options.sport === 'walk' ? new AscentTracker() : null;
  }

  // ───────────────────────────── entradas ─────────────────────────────

  onHeartRate(bpm: number, tsMs: number = this.options.now()): void {
    if (this.status !== 'running' || bpm < 35 || bpm > 220) return;
    // Las lecturas pueden llegar tarde y con su hora (la web estuvo parada): la última es la más reciente, no la última en procesarse.
    if (this.lastBpm === null || tsMs >= this.lastBpm.tsMs) this.lastBpm = { bpm, tsMs };
    this.hrSum += bpm;
    this.hrCount++;
    this.hrMaxSeen = Math.max(this.hrMaxSeen ?? 0, bpm);
    if (tsMs - this.lastStoredHrMs >= HR_STORE_EVERY_MS) {
      this.hr.push([tsMs, bpm]);
      this.lastStoredHrMs = tsMs;
    }
  }

  /**
   * Pasos acumulados del DÍA que reporta el anillo: se cuentan solo los incrementos mientras corre el cronómetro.
   * Un salto imposible para el tiempo transcurrido (un contador que pasa de 0 al total del día, por ejemplo) o un
   * descenso que no es el reinicio de medianoche no suman nada: solo mueven el punto de partida. Así el ruido del
   * contador no se convierte en cientos de pasos de entreno.
   */
  onSteps(dayTotal: number, tsMs: number = this.options.now()): void {
    const last = this.stepsLastTotal;
    const lastTs = this.stepsLastTs;
    this.stepsLastTotal = dayTotal;
    // El tiempo de referencia es el del último CAMBIO del contador, no el de la última lectura: si el anillo repite el mismo
    // total cada segundo y luego sube de golpe, la subida se dio a lo largo de todo ese rato y no en el último segundo.
    if (last === null || dayTotal !== last) this.stepsLastTs = tsMs;
    if (last === null) return; // la primera lectura fija el punto de partida
    if (this.status !== 'running') return;
    const plausible = (steps: number): boolean => steps <= MAX_STEPS_PER_S * Math.max(1, (tsMs - lastTs) / 1000) + STEPS_SLACK;
    const delta = dayTotal - last;
    if (delta >= 0) {
      if (plausible(delta)) {
        this.stepsCounted += delta;
        this.addStepSplit(tsMs, delta);
      }
    } else if (dayKeyOf(tsMs) !== dayKeyOf(lastTs) && plausible(dayTotal)) {
      // El contador se reinicia a medianoche: lo que lleva desde el reinicio es nuevo.
      this.stepsCounted += dayTotal;
      this.addStepSplit(tsMs, dayTotal);
    }
  }

  /**
   * Apunta los pasos recién contados en los minutos de tiempo ACTIVO que ocupan, repartidos desde el incremento anterior (el
   * anillo manda el contador solo cuando cambia: tras un rato plano, la subida se dio a lo largo de todo ese rato).
   */
  private addStepSplit(tsMs: number, steps: number): void {
    if (steps <= 0) return;
    const at = this.activeAt(tsMs);
    if (!(at >= 0)) return;
    const from = this.lastStepSplitAt === null ? at : Math.min(at, this.lastStepSplitAt);
    this.lastStepSplitAt = at;
    const span = at - from;
    const first = Math.floor(from / 60_000);
    const last = Math.floor(at / 60_000);
    for (let minute = first; minute <= last && minute < MAX_SPLITS; minute++) {
      while (this.stepSplits.length <= minute) this.stepSplits.push(0);
      const inside = Math.min(at, (minute + 1) * 60_000) - Math.max(from, minute * 60_000);
      const share = span > 0 ? Math.max(0, inside) / span : 1;
      this.stepSplits[minute] = (this.stepSplits[minute] ?? 0) + steps * share;
    }
  }

  /**
   * Una posición del GPS. Con `trustTime` (las que recoge el servicio nativo, con la hora del reloj de pared del móvil) se respeta su
   * hora aunque llegue minutos tarde —la app estaba oculta— y se acepta si el entreno corría en ese instante, aunque ahora esté en
   * pausa; sin él (el GPS de la web, que llega al segundo), una hora que se aparta del reloj del móvil se sustituye por la del móvil.
   */
  onGps(fix: GpsFix, options: { trustTime?: boolean } = {}): void {
    if (!this.options.useGps) return;
    if (options.trustTime) {
      if (this.status === 'finished' || fix.tsMs < this.startedMs || this.inPause(fix.tsMs)) return;
    } else if (this.status !== 'running') {
      return;
    }
    if (this.pendingBreakAtMs !== null) {
      if (!options.trustTime) {
        this.pendingBreakAtMs = null; // el GPS de la web llega al segundo: el corte de al reanudar ya vale
      } else if (fix.tsMs >= this.pendingBreakAtMs) {
        this.gps.breakSegment();
        this.ascent?.breakSeries();
        this.lastSplitAt = null;
        this.pendingBreakAtMs = null;
      }
    }
    const before = this.gps.distanceM;
    this.gps.add(fix);
    // Una lectura descartada (mala precisión, un salto) no cuenta como señal; una que no suma porque se está parado, sí.
    if (!this.gps.lastReadingValid) return;
    this.route.add(fix.lat, fix.lon);
    if (fix.pressureHpa != null) this.ascent?.add(fix.pressureHpa);
    // Lo que el tracker suma de golpe al descubrir que la velocidad no era de fiar es de los minutos anteriores, no de este.
    const retroactive = this.gps.takeRetroactive();
    const metersNow = this.gps.distanceM - before - (retroactive?.meters ?? 0);
    const now = this.options.now();
    const wall = options.trustTime || Math.abs(fix.tsMs - now) <= MAX_GPS_CLOCK_SKEW_MS ? fix.tsMs : now;
    this.addSplit(wall, metersNow, retroactive?.meters ?? 0, retroactive?.fromMs);
  }

  /** Milisegundos de tiempo ACTIVO (sin pausas) desde el inicio hasta el instante `ts`. */
  private activeAt(ts: number): number {
    let paused = 0;
    for (const [from, to] of this.pauses) {
      if (ts <= from) break; // las pausas van en orden: las demás empiezan después de `ts`
      paused += Math.min(ts, to ?? ts) - from;
    }
    return ts - this.startedMs - paused;
  }

  /** ¿Estaba el entreno en pausa en el instante `ts`? */
  private inPause(ts: number): boolean {
    return this.pauses.some(([from, to]) => ts >= from && (to === null || ts < to));
  }

  /**
   * Apunta lo recorrido desde la lectura anterior repartido por los minutos de tiempo ACTIVO que ocupa: casi siempre es uno
   * solo, pero tras un hueco del GPS (una calle cubierta, la app en segundo plano) lo avanzado se reparte por todo el hueco
   * y no cae en el minuto en que vuelve la señal, que saldría como una velocidad imposible. `retroMeters` son los metros que se
   * descubrieron tarde (ver `GpsTracker.takeRetroactive`): se reparten desde `retroFromMs`, que es cuando de verdad se avanzaron.
   */
  private addSplit(wall: number, meters: number, retroMeters = 0, retroFromMs?: number): void {
    const at = this.activeAt(wall);
    if (!(at >= 0)) return;
    const from = this.lastSplitAt === null ? at : Math.min(at, this.lastSplitAt);
    this.lastSplitAt = at;
    if (retroMeters > 0 && retroFromMs !== undefined) {
      const retroFrom = Math.max(0, Math.min(at, this.activeAt(retroFromMs)));
      this.spreadMeters(retroFrom, at, retroMeters);
    }
    this.spreadMeters(from, at, meters);
    // Los minutos con una lectura propia: la de este instante, y todo lo que abarca si no hay hueco desde la anterior.
    const firstReal = (at - from) / 1000 <= GPS_GAP_S ? Math.floor(from / 60_000) : Math.floor(at / 60_000);
    for (let minute = firstReal; minute <= Math.floor(at / 60_000) && minute < MAX_SPLITS; minute++) this.splitReal[minute] = true;
  }

  /** Reparte `meters` por los minutos activos de [from, at] en proporción al tiempo de cada uno (y los da por con señal). */
  private spreadMeters(from: number, at: number, meters: number): void {
    const span = at - from;
    const first = Math.floor(from / 60_000);
    const last = Math.floor(at / 60_000);
    for (let minute = first; minute <= last && minute < MAX_SPLITS; minute++) {
      while (this.splitMeters.length <= minute) {
        this.splitMeters.push(0);
        this.splitCovered.push(false);
        this.splitReal.push(false);
      }
      const inside = Math.min(at, (minute + 1) * 60_000) - Math.max(from, minute * 60_000);
      const share = span > 0 ? Math.max(0, inside) / span : 1;
      this.splitMeters[minute] = (this.splitMeters[minute] ?? 0) + Math.max(0, meters) * share;
      this.splitCovered[minute] = true;
    }
  }

  setRingConnected(connected: boolean): void {
    this.ringConnected = connected;
  }

  // ───────────────────────────── control ─────────────────────────────

  /**
   * La hora de un cambio de estado (pausa, reanudar, terminar): la que se pide, si se da, sin pasar del presente ni quedar antes de lo último que pasó (el inicio, o el final de la pausa anterior).
   * Sirve cuando el cambio lo pidió algo que no es la pantalla (el botón de la notificación, con la app parada un rato): cuenta desde que se tocó, no desde que la web se enteró.
   */
  private changeTime(atMs: number | undefined, notBefore: number): number {
    const now = this.options.now();
    if (atMs === undefined || !Number.isFinite(atMs)) return now;
    return Math.max(notBefore, Math.min(now, atMs));
  }

  pause(atMs?: number): void {
    if (this.status !== 'running') return;
    const lastBoundary = this.pauses.reduce((latest, [, resumed]) => Math.max(latest, resumed ?? 0), this.startedMs);
    this.status = 'paused';
    this.pauseStartedMs = this.changeTime(atMs, lastBoundary);
    this.pauses.push([this.pauseStartedMs, null]);
  }

  resume(atMs?: number): void {
    if (this.status !== 'paused' || this.pauseStartedMs === null) return;
    const resumedMs = this.changeTime(atMs, this.pauseStartedMs);
    this.pausedMs += resumedMs - this.pauseStartedMs;
    this.pauseStartedMs = null;
    const last = this.pauses[this.pauses.length - 1];
    if (last) last[1] = resumedMs;
    this.status = 'running';
    this.pendingBreakAtMs = resumedMs;
    this.gps.breakSegment();
    this.ascent?.breakSeries();
    this.lastSplitAt = null;
    this.lastStepSplitAt = null;
  }

  finish(atMs?: number): WorkoutRecord {
    // Si estaba en pausa, la pausa acaba donde termina el entreno (una parada pedida desde la notificación trae su hora).
    const lastBoundary = this.pauseStartedMs ?? this.pauses.reduce((latest, [, resumed]) => Math.max(latest, resumed ?? 0), this.startedMs);
    const endMs = this.changeTime(atMs, lastBoundary);
    if (this.status === 'paused') this.resume(endMs);
    this.status = 'finished';
    this.endedMs = endMs;
    return this.toRecord();
  }

  // ───────────────────────────── salidas ─────────────────────────────

  private currentPausedMs(now: number): number {
    return this.pausedMs + (this.pauseStartedMs !== null ? now - this.pauseStartedMs : 0);
  }

  toRecord(): WorkoutRecord {
    const now = this.endedMs ?? this.options.now();
    const sport = sportById(this.options.sport);
    const record: WorkoutRecord = {
      id: this.id,
      sport: this.options.sport,
      startMs: this.startedMs,
      endMs: now,
      pausedMs: this.currentPausedMs(now),
      source: 'live',
    };
    // Con el contador del anillo en marcha (ya dio una lectura) se guarda también el cero: «no se anduvo» no es lo mismo que «no se sabe».
    if (sport.kind === 'ambulatory' && (this.stepsCounted > 0 || this.stepsLastTotal !== null)) record.steps = Math.round(this.stepsCounted);
    if (this.options.useGps && this.gps.distanceM >= MIN_GPS_DISTANCE_M) {
      const merged = this.reconcileWithSteps();
      record.distanceM = Math.round(this.gps.distanceM + merged.extraM);
      record.distanceSource = 'gps';
      const route = this.route.points();
      if (route) record.route = route;
      if (merged.meters.length > 0) record.splitsM = merged.meters.map((m, i) => (merged.covered[i] ? Math.min(MAX_SPLIT_M, Math.round(m)) : -1));
    }
    else if (this.options.useGps && (sport.kind === 'ambulatory' || sport.kind === 'cycling') && this.gpsSaysStill(activeMsOf(record))) {
      // El GPS ha dado señal buena casi todo el rato y no se ha avanzado ni diez metros: es «no se movió», no «no se sabe». Sin esto, el entreno sin pasos (sin anillo, o con el
      // contador aún sin dar nada) caía en el MET genérico de caminar y sumaba calorías de paseo sentado (≈ 3 por minuto a 80 kg; al correr, ≈ 11; en bici parada, ≈ 7).
      record.distanceM = 0;
      record.distanceSource = 'gps';
    }
    if (this.ascent && Math.round(this.ascent.ascentM) >= 1) record.ascentM = Math.round(this.ascent.ascentM);
    if (this.hr.length > 0) record.hr = this.hr.slice();
    return record;
  }

  /**
   * ¿Hay pruebas de que NO se anduvo? Hace falta que ni un paso (el anillo, si lo hay, no ha contado ninguno) y que el GPS haya dado lecturas propias en al menos la mitad de los
   * minutos activos: con el GPS sin señal (un permiso retirado, un túnel) no se sabe nada y manda la estimación genérica del deporte. Los pasos, si los hay, ganan: andar en una cinta
   * deja el GPS quieto y no por eso es no moverse.
   */
  private gpsSaysStill(activeMs: number): boolean {
    // En bici los pasos del anillo no dicen nada (la muñeca se mueve con el manillar): solo cuentan a pie.
    if ((sportById(this.options.sport).kind === 'ambulatory' && this.stepsCounted > 0) || activeMs <= 0) return false;
    const activeMinutes = Math.max(1, Math.ceil(activeMs / 60_000));
    let real = 0;
    for (let minute = 0; minute < this.splitReal.length && minute < activeMinutes; minute++) if (this.splitReal[minute]) real++;
    return real >= Math.max(1, Math.ceil(activeMinutes / 2));
  }

  /**
   * Metros de cada minuto activo: los del GPS, salvo en deportes a pie en los minutos en que el GPS falla (no hay lecturas, o dice
   * menos de la mitad de lo que dicen los pasos), donde valen los pasos. `extraM` es lo que esto suma al total del GPS.
   */
  private reconcileWithSteps(): { meters: number[]; covered: boolean[]; extraM: number } {
    const walking = sportById(this.options.sport).kind === 'ambulatory';
    const minutes = walking ? Math.max(this.splitMeters.length, this.stepSplits.length) : this.splitMeters.length;
    const stride = baseStride(this.options.profile);
    const meters: number[] = [];
    const covered: boolean[] = [];
    let extraM = 0;
    for (let i = 0; i < minutes; i++) {
      const hasGps = this.splitCovered[i] === true;
      const gpsM = hasGps ? (this.splitMeters[i] ?? 0) : 0;
      const steps = walking ? (this.stepSplits[i] ?? 0) : 0;
      if (steps >= MIN_STEPS_PER_MINUTE) {
        // La cadencia de ese minuto da la zancada (al correr se alarga), como en el resto de estimaciones.
        const byStepsM = stepsToDistanceM(steps, stride, steps);
        const chordOnly = hasGps && this.splitReal[i] !== true;
        if (!hasGps || gpsM < (chordOnly ? 1 : GPS_UNDERREPORT_RATIO) * byStepsM) {
          extraM += byStepsM - gpsM;
          meters.push(byStepsM);
          covered.push(true);
          continue;
        }
      }
      meters.push(gpsM);
      covered.push(hasGps);
    }
    return { meters, covered, extraM };
  }

  snapshot(): RecorderSnapshot {
    const now = this.endedMs ?? this.options.now();
    const record = this.toRecord();
    const estimate = estimateWorkout(record, this.options.profile);
    const sport = sportById(this.options.sport);

    let distanceM: number | null = null;
    let distanceSource: RecorderSnapshot['distanceSource'] = null;
    if (record.distanceM !== undefined) {
      distanceM = record.distanceM;
      distanceSource = 'gps';
    } else if (sport.kind === 'ambulatory' && this.stepsCounted > 0) {
      const activeMs = estimate.activeMs;
      distanceM = round(stepsToDistanceM(this.stepsCounted, baseStride(this.options.profile), cadenceSpm(this.stepsCounted, activeMs)));
      distanceSource = 'steps';
    }

    const fresh = this.lastBpm && now - this.lastBpm.tsMs <= HR_FRESH_MS ? this.lastBpm.bpm : null;
    return {
      status: this.status,
      startedMs: this.startedMs,
      activeMs: estimate.activeMs,
      pausedMs: record.pausedMs,
      bpm: fresh,
      lastPulse: this.lastBpm ? { bpm: this.lastBpm.bpm, ageMs: Math.max(0, now - this.lastBpm.tsMs) } : null,
      avgBpm: this.hrCount ? Math.round(this.hrSum / this.hrCount) : null,
      maxBpm: this.hrMaxSeen,
      zone: fresh === null ? null : zoneOf(fresh, this.hrMax),
      hrMax: this.hrMax,
      steps: sport.kind === 'ambulatory' && this.stepsLastTotal !== null ? Math.round(this.stepsCounted) : null,
      distanceM,
      distanceSource,
      kcal: estimate.kcal,
      kcalMethod: estimate.kcalMethod,
      gps: this.options.useGps ? this.gps.quality(now) : 'off',
      ringConnected: this.ringConnected,
    };
  }
}
