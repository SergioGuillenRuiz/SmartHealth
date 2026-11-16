import { DiagnosticLog, SHARED_LOG_FRAMES } from '../ble/diag';
import { YcbtSession, type Timeouts } from '../ble/session';
import { RingError } from '../ble/errors';
import type { RingLink, RingTransport } from '../ble/transport';
import type { Store } from '../data/types';
import type { SportId } from '../domain/sports';
import { sportById, sportSupport } from '../domain/sports';
import type { HrProfile } from '../domain/hrzones';
import type { ResolvedProfile } from '../domain/profile';
import type { WorkoutDraft, WorkoutRecord } from '../domain/workout';
import type { GpsFix } from '../domain/gps';
import { WorkoutRecorder, type RecorderSnapshot } from '../sync/workout-recorder';
import { isNative, nativeWakeLock } from './native';
import { TrackFeeder, type TrackerProblem } from './track-feeder';
import { nativeTracker, type NativeTracker, type TrackerTick } from './tracker';
import { MIN_REPORT_MS, phoneRisk, reportScreenOff, serviceFactsOf, type ScreenOffFacts, type ServiceFacts } from './screen-off-report';

type WakeLockHandle = { release(): Promise<void>; released?: boolean };

/** Aviso pasajero: el GPS no dio ninguna posición a tiempo. Desaparece en cuanto llega una. */
const GPS_UNAVAILABLE = 'No se pudo obtener la ubicación.';
/** Con la app oculta menos que esto (un vistazo a otra app) no se avisa: el hueco del GPS no llega a notarse. */
const MIN_HIDDEN_WARN_MS = 30_000;

/** Una vez por instalación se pide a Android que no restrinja la app en segundo plano (ver `askBatteryExemptionOnce`). */
const BATTERY_ASKED_KEY = 'smartring.batteryExemptionAsked';

/** Lo más que se espera a que el servicio del GPS pare y entregue lo último: un plugin que no contesta no debe dejar el anillo sin soltar. */
const TRACKER_STOP_MS = 5_000;

/** Tras volver a verse la app se espera esto antes de comparar lo recibido con lo que tocaba: lo grabado con la pantalla apagada llega de golpe y tarda unos segundos en procesarse. */
const SCREEN_REPORT_DELAY_MS = 10_000;
/** Lo más que se espera a que el servicio nativo cuente cómo está el móvil para el informe de la pantalla apagada. */
const SERVICE_STATUS_MS = 3_000;
/** Tope de horas que se guardan de posiciones, lecturas y avisos para ese informe (un entreno de horas no crece sin límite). */
const MAX_STAMPS = 6_000;

/** Un aviso nativo que llega con más retraso que esto (ms) es de cuando el WebView estaba parado: no despierta nada que dependa del reloj. */
const STALE_WAKE_MS = 3_000;

/** Espera a `promise` (sin propagar su error) como mucho `ms`. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Primer intento de reconexión automática tras perder el anillo, y tope de la espera entre intentos (ver `scheduleReconnect`). */
const RECONNECT_EVERY_MS = 8_000;
/** Cada intento fallido espera 1,5 veces el anterior, hasta medio minuto: un minuto entero era demasiado pulso perdido si el anillo volvía enseguida. */
const RECONNECT_BACKOFF = 1.5;
const MAX_RECONNECT_EVERY_MS = 30_000;

export interface WorkoutPlatform {
  geolocation: Pick<Geolocation, 'watchPosition' | 'clearWatch'> | null;
  /**
   * La grabación nativa de la ruta (solo en la app de Android): un servicio en primer plano recoge el GPS aunque la pantalla esté
   * apagada o la app oculta, que es cuando el GPS de la web (`geolocation`) no llega. Sin ella, se usa `geolocation`.
   */
  tracker?: NativeTracker | null;
  wakeLock: { request(type: 'screen'): Promise<WakeLockHandle> } | null;
  /** Avisa cuando la página vuelve a verse: el navegador suelta el bloqueo de pantalla al ocultarla (cambiar de app). */
  onVisible?: (callback: () => void) => () => void;
  /**
   * Avisa cuando la página se oculta o se descarga (cambiar de app, cerrar la pestaña). Es el último momento seguro para
   * guardar: con la página oculta el navegador estrangula o congela los temporizadores y puede cerrarla sin más aviso.
   */
  onHidden?: (callback: () => void) => () => void;
  /**
   * Avisa cuando algo despierta a la app aunque sus temporizadores estén espaciados (con la pantalla apagada o con otra app delante):
   * el aviso del servicio nativo del entreno y volver a verse la página. Reabre lo que dependía de un temporizador (la medida de pulso,
   * la reconexión del anillo) sin esperar a que el WebView lo deje correr. El aviso nativo trae su hora (`tick.now`): si llega mucho
   * después, el WebView estuvo parado y ese aviso es de cuando no corría nada (la plataforma ya lo ha contestado).
   */
  onWake?: (callback: (wake?: WakeInfo) => void) => () => void;
}

/** Qué despertó a la app: el aviso nativo (con su retraso) o volver a verse la página. */
export interface WakeInfo {
  source: 'tick' | 'visible';
  /** Cuánto tardó el aviso en llegar al WebView desde que lo mandó el lado nativo (ms); 0 si no se sabe. */
  lagMs: number;
  tick?: TrackerTick;
}

/** Plataforma real del navegador. */
export function browserPlatform(): WorkoutPlatform {
  return {
    geolocation: typeof navigator !== 'undefined' && 'geolocation' in navigator ? navigator.geolocation : null,
    tracker: nativeTracker(),
    wakeLock: isNative()
      ? nativeWakeLock()
      : typeof navigator !== 'undefined' && 'wakeLock' in navigator
        ? (navigator as Navigator & { wakeLock: WorkoutPlatform['wakeLock'] }).wakeLock
        : null,
    onVisible: (callback) => {
      const handler = (): void => {
        if (document.visibilityState === 'visible') callback();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
    onWake: (callback) => {
      // Con el servicio nativo llegan avisos cada 2 s. Van por la MISMA cola ordenada que las tramas del anillo, así que cuando llega uno fresco ya se procesó todo lo que el
      // anillo mandó antes. El aviso de «visible», en cambio, puede adelantarse a esa cola (el WebView parado procesa lo acumulado después): hacerle caso reabriría la medida a ciegas
      // antes de ver lo atrasado. Por eso, en cuanto ha llegado algún aviso nativo, «visible» ya no despierta nada (el siguiente aviso lo hace, ≤ 2 s después); sin avisos nativos
      // (el navegador, o un servicio que no arrancó), sigue siendo la señal.
      let nativeTicks = false;
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible' && !nativeTicks) callback({ source: 'visible', lagMs: 0 });
      };
      document.addEventListener('visibilitychange', onVisibility);
      const tracker = nativeTracker();
      const offTick = tracker?.onTick((tick) => {
        nativeTicks = true;
        // Lo primero, contestar al lado nativo: mientras conteste, el reflejo nativo del pulso no hace nada y lo atiende todo esta web.
        tracker.ack();
        callback({ source: 'tick', lagMs: typeof tick.now === 'number' ? Math.max(0, Date.now() - tick.now) : 0, tick });
      });
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        offTick?.();
      };
    },
    onHidden: (callback) => {
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') callback();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', callback);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', callback);
      };
    },
  };
}

/** Cómo terminó un entreno, si no fue desde la pantalla: ver `WorkoutDeps.onFinished`. */
export interface FinishMeta {
  fromNotification?: true;
}

/** Para qué se graba el paseo: `stride` mide la zancada (no se guarda como entreno, ni deja borrador) y no abre la pantalla de seguimiento. */
export type LivePurpose = 'workout' | 'stride';

export interface LiveWorkoutState {
  phase: 'connecting' | 'live';
  /** Ausente: un entrenamiento normal. */
  purpose?: LivePurpose;
  sport: SportId;
  useGps: boolean;
  /** Ausente: el entreno de siempre. `true`: con navegación guiada (el menú de dos pestañas con el mapa). */
  guided?: true;
  snapshot: RecorderSnapshot | null;
  /** Avisos para el usuario (GPS denegado, anillo desconectado…). */
  warnings: string[];
  /** El anillo se desconectó y hay que reconectar (automática o manualmente). */
  ringLost: boolean;
  /** Qué datos en directo da el anillo en esta actividad (según lo que declara). */
  features: { heartRate: boolean; steps: boolean };
  /** Ausente: se entrena con el anillo. `false`: sin anillo, medido solo con el móvil (GPS y tiempo; ni pulso ni pasos del anillo). */
  ring?: false;
}

export interface WorkoutDeps {
  transport: RingTransport;
  /** Solo lo que usa: el anillo vinculado y el borrador del entreno (la prueba guiada pasa uno que no guarda borradores). */
  store: Pick<Store, 'getRing' | 'setRing' | 'setWorkoutDraft'>;
  now: () => number;
  platform: WorkoutPlatform;
  getProfile: () => ResolvedProfile;
  /** Los pulsos personales (máximo y reposo) con los que se miden las zonas del entreno; sin ellos, la fórmula por edad. */
  getHrProfile?: () => HrProfile | null;
  /**
   * Reserva el anillo para el entrenamiento (ver `claimRing`): devuelve cómo liberarlo, o `null` si ya lo usa otra
   * cosa. Se libera cuando el anillo está del todo suelto, no antes. Por defecto, siempre libre.
   */
  claimRing?: () => (() => void) | null;
  onState: (state: LiveWorkoutState | null) => void;
  /**
   * El entrenamiento terminó y queda pendiente de revisar y guardar (o, si era para calibrar la zancada, de medirla). Con `meta.fromNotification` se paró desde el botón de la notificación:
   * no se revisa, se guarda tal cual y se enseña ya guardado (ver `onFinished` de `workout-actions.ts`).
   */
  onFinished: (record: WorkoutRecord, purpose: LivePurpose, meta?: FinishMeta) => void;
  /** Traza BLE del entrenamiento, cuando el anillo ya está suelto (solo la pide la prueba guiada). */
  onDiagnostic?: (text: string) => void;
  /** Cada posición del GPS que llega (la que ve el navegador por audio). */
  onGpsFix?: (fix: GpsFix) => void;
  /** Intervalos (ms), inyectables para las pruebas. */
  tickMs?: number;
  /** Cada cuánto se guarda el borrador del entrenamiento en curso (por defecto, 15 s). */
  draftEveryMs?: number;
  /** Cada cuánto se recogen las posiciones que graba el servicio nativo del GPS (por defecto, 1 s). */
  trackPollEveryMs?: number;
  /** Lo más que se espera a que el servicio del GPS pare al terminar (por defecto, 5 s). */
  trackStopMs?: number;
  /** Cuánto se espera tras volver a verse la app antes de revisar qué se perdió con la pantalla apagada (por defecto, 10 s). */
  screenReportDelayMs?: number;
  /** Qué trabajo del mapa está en marcha ahora (bajándolo, construyéndolo, completándolo con los edificios y comercios), o `null`: es lo más pesado que hace la app, y se anota al ocultarse. */
  mapBusy?: () => string | null;
  reconnectEveryMs?: number;
  sessionTimeouts?: Partial<Timeouts>;
  /** Calentamiento del sensor de pulso y espera para entender que emite en continuo (ms). Inyectables para las pruebas. */
  hrWarmupMs?: number;
  hrStreamAfterMs?: number;
}

/**
 * Orquesta un entrenamiento en directo: ring (pulso y pasos) + GPS opcional + pantalla encendida.
 * Es el ÚNICO caso en que la app mantiene el anillo conectado de forma prolongada, y lo suelta al terminar.
 */
export class WorkoutController {
  private recorder: WorkoutRecorder | null = null;
  private session: YcbtSession | null = null;
  private stopHr: (() => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draftTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Espera hasta el próximo intento de reconexión automática: crece con cada fallo (ver `scheduleReconnect`). */
  private reconnectDelayMs = 0;
  /** Cuándo toca el próximo intento (`0`: ninguno programado): si el temporizador se retrasa, un aviso (`poke`) lo adelanta. */
  private reconnectDueAt = 0;
  private stopWakeWatch: (() => void) | null = null;
  /** Oye los botones de la notificación del entreno (pausa, reanudar, parar) y se recogen sus órdenes. */
  private stopActionWatch: (() => void) | null = null;
  /** Se están recogiendo y aplicando las órdenes de la notificación (una a la vez, en orden). */
  private draining = false;
  private watchId: number | null = null;
  /** La recogida de las posiciones que graba el servicio nativo (`null`: se usa el GPS de la web, o no hay GPS). */
  private feeder: TrackFeeder | null = null;
  /** El servicio nativo que mantiene vivo el entreno SIN GPS (con GPS lo lleva `feeder`); `null`: no lo hay. */
  private keepAlive: NativeTracker | null = null;
  /** Lo último que dijo el aviso nativo del reflejo del pulso (paradas del WebView y órdenes escritas): para anotar solo cuando cambia. */
  private lastReflex = { stalls: 0, writes: 0, failed: 0 };
  /** El aviso vigente sobre la grabación nativa (GPS apagado, fallo del servicio…), para quitarlo cuando se arregla. */
  private trackerWarning: string | null = null;
  private lock: WakeLockHandle | null = null;
  private stopVisibleWatch: (() => void) | null = null;
  private stopHiddenWatch: (() => void) | null = null;
  private sport: SportId = 'walk';
  private purpose: LivePurpose = 'workout';
  private useGps = false;
  private guided = false;
  private warnings: string[] = [];
  private ringLost = false;
  /** Sin anillo (la persona no lo tiene): no se conecta a nada y el entreno se mide solo con el móvil. */
  private withoutRing = false;
  private phase: LiveWorkoutState['phase'] = 'connecting';
  private features: LiveWorkoutState['features'] = { heartRate: true, steps: false };
  /** El anillo ya rechazó el pulso en este entrenamiento: no se insiste al reconectar. */
  private hrRefused = false;
  private starting = false;
  private reconnecting = false;
  /** El entreno está en pausa: la pantalla no se fuerza (ver `pause`). */
  private paused = false;
  /** Hay una petición de bloqueo de pantalla en vuelo: no se lanza otra encima. */
  private lockPending = false;
  /** Se incrementa en `teardown()`: lo que estaba en vuelo (conexión, apretón de manos, reconexión) lo ve y se retira. */
  private epoch = 0;
  /** El apretón de manos terminó: ya se pueden mandar órdenes por la sesión. */
  private sessionOpen = false;
  private tearingDown = 0;
  private releaseRing: (() => void) | null = null;
  /** Hay un entrenamiento (o su arranque) que no ha sido cancelado ni terminado: solo entonces se emite estado. */
  private running = false;
  /** Traza BLE de todo el entrenamiento (todas las sesiones, también tras reconectar). */
  private log: DiagnosticLog | null = null;
  /** Cuándo se ocultó la app (`null`: está a la vista) y cuánto tiempo lleva oculta en este entreno. */
  private hiddenAtMs: number | null = null;
  private hiddenTotalMs = 0;
  private hiddenWarning: string | null = null;
  /** Para el informe de la pantalla apagada (ver `screen-off-report.ts`): las horas de las posiciones del servicio nativo y de las lecturas de pulso que llegaron, y los avisos nativos vistos. */
  private gpsMs: number[] = [];
  private pulseMs: number[] = [];
  private tickSeen: Array<{ nowMs: number; arrivedMs: number; n?: number }> = [];
  private lastTick: TrackerTick | null = null;
  private ringDownAtMs = 0;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  /** Desde cuándo está oculta la app en el tramo que aún no se ha revisado (si se vuelve a ocultar antes de revisarlo, el tramo sigue desde el primero). */
  private unreportedFromMs: number | null = null;
  private offWarning: string | null = null;
  /** Qué trabajo del mapa había en marcha cuando se ocultó la app (el primero del tramo si se junta con otros). */
  private mapBusyAtHide: string | null = null;

  constructor(private readonly deps: WorkoutDeps) {}

  /**
   * Hay un entrenamiento en curso o arrancando. Un arranque cancelado (`running` ya en `false`) sigue en vuelo hasta que su
   * conexión resuelve, pero ya no es un entrenamiento: un nuevo intento debe llegar a pedir el anillo —que avisa de que aún
   * se está soltando— y no quedarse en un no-op mudo.
   */
  get isActive(): boolean {
    return this.recorder !== null || (this.starting && this.running);
  }

  /**
   * Debe llamarse desde un gesto del usuario (selector Bluetooth y permiso de ubicación). Si se cancela mientras se
   * conecta (`discard()`), termina sin error y sin dejar nada abierto.
   */
  async start(sport: SportId, options: { gps: boolean; guided?: boolean; purpose?: LivePurpose; ring?: boolean }): Promise<void> {
    if (this.isActive) return;
    // Sin anillo (`ring: false`) el entreno no toca el Bluetooth ni reserva el anillo: es el del móvil, con su GPS.
    const withRing = options.ring !== false;
    const release = !withRing ? () => undefined : this.deps.claimRing ? this.deps.claimRing() : () => undefined;
    if (!release) return; // el anillo lo usa otra cosa; quien lo reservó ya avisó
    this.releaseRing = release;
    this.starting = true;
    this.running = true;
    this.log = new DiagnosticLog();
    this.log.info(`entreno: ${sport}${options.gps ? ' con GPS' : ''}${withRing ? '' : ' sin anillo (solo el móvil)'}`);
    const epoch = this.epoch;
    this.sport = sport;
    this.purpose = options.purpose ?? 'workout';
    this.withoutRing = !withRing;
    // Sin anillo el GPS es la única fuente de distancia: va siempre encendido.
    this.useGps = (options.gps || !withRing) && sportById(sport).gpsUseful;
    this.guided = options.guided === true && this.useGps && this.purpose === 'workout';
    this.warnings = [];
    this.hiddenAtMs = null;
    this.hiddenTotalMs = 0;
    this.hiddenWarning = null;
    this.gpsMs = [];
    this.pulseMs = [];
    this.tickSeen = [];
    this.lastTick = null;
    this.ringDownAtMs = 0;
    this.unreportedFromMs = null;
    this.offWarning = null;
    this.mapBusyAtHide = null;
    this.ringLost = false;
    this.hrRefused = false;
    this.paused = false;
    this.phase = 'connecting';
    const support = sportSupport(sportById(sport), null);
    this.features = withRing ? { heartRate: support.heartRate, steps: support.steps } : { heartRate: false, steps: false };
    this.emit();
    try {
      const makeRecorder = (): WorkoutRecorder => new WorkoutRecorder({ sport, profile: this.deps.getProfile(), now: this.deps.now, useGps: this.useGps, hr: this.deps.getHrProfile?.() ?? null });
      if (withRing) {
        const link = await this.connect(epoch);
        if (!link) return; // cancelado antes de abrir el selector
        if (epoch !== this.epoch) {
          // Se canceló mientras se conectaba: el enlace recién abierto no tiene dueño y hay que soltarlo.
          await link.disconnect().catch(() => undefined);
          return;
        }
        this.recorder = makeRecorder();
        if (!(await this.attach(link, epoch))) return;
      } else {
        // Sin anillo no hay nada a lo que conectarse: el grabador empieza ya y solo tiene el GPS y el reloj.
        this.recorder = makeRecorder();
      }
      this.phase = 'live';
      this.startGps();
      await this.acquireWakeLock();
      if (epoch !== this.epoch) return;
      // Al volver a la app tras cambiar de aplicación, la pantalla debe seguir encendida durante el entreno.
      this.stopVisibleWatch =
        this.deps.platform.onVisible?.(() => {
          this.noteVisible();
          void this.acquireWakeLock();
          // Se tocó algo en la notificación mientras la app estaba oculta y el timbre aún no se atendió: se recoge ahora.
          void this.drainActions();
        }) ?? null;
      // Con la app oculta los temporizadores se espacian hasta un minuto: el aviso del servicio nativo y las tramas del anillo
      // reabren a tiempo la medida de pulso y la reconexión, que de otro modo dejarían el sensor apagado ese rato.
      this.stopWakeWatch = this.deps.platform.onWake?.((wake) => this.onWake(wake)) ?? null;
      // Los botones de la notificación (pausa y parar): suena un timbre cuando se toca uno y entonces se recoge lo que se tocó.
      this.stopActionWatch = this.deps.platform.tracker?.onAction(() => void this.drainActions()) ?? null;
      this.timer = setInterval(() => this.emit(), this.deps.tickMs ?? 1000);
      // El entrenamiento solo vive en memoria: se guarda un borrador cada poco para poder recuperarlo si el sistema
      // cierra la pestaña (cambiar de aplicación a mitad de un entreno es normal) o la app se recarga.
      this.draftTimer = setInterval(() => this.saveDraft(), this.deps.draftEveryMs ?? 15_000);
      // Con la página oculta el navegador estrangula los temporizadores: al ocultarse se guarda al momento, que es justo
      // cuando más probable es que la cierre sin avisar.
      this.stopHiddenWatch =
        this.deps.platform.onHidden?.(() => {
          if (this.hiddenAtMs === null) {
            this.hiddenAtMs = this.deps.now();
            this.mapBusyAtHide ??= this.deps.mapBusy?.() ?? null;
          }
          // Se vuelve a ocultar antes de revisar el tramo anterior: se revisará todo junto al volver.
          if (this.reportTimer) clearTimeout(this.reportTimer);
          this.reportTimer = null;
          this.saveDraft();
        }) ?? null;
      this.emit();
    } catch (error) {
      if (epoch !== this.epoch) return; // cancelado: ya lo deshizo `teardown()`
      this.log?.warn(`error al empezar: ${error instanceof Error ? error.message : String(error)}`);
      const closing = this.teardown();
      this.deps.onState(null);
      await closing;
      throw error;
    } finally {
      this.starting = false;
      this.settle();
    }
  }

  /** `atMs`: la hora a la que se pidió, si no fue desde la pantalla (el botón de la notificación). */
  pause(atMs?: number): void {
    // Las posiciones de justo antes de la pausa, que el servicio nativo quizá aún no ha entregado, se recogen YA: el grabador las
    // coloca por su hora, y las de dentro de la pausa las descarta.
    void this.feeder?.flush();
    this.recorder?.pause(atMs);
    // En pausa no hace falta forzar la pantalla encendida: se apaga sola según los ajustes del móvil (con una pausa corta
    // ni se nota) y vuelve a forzarse al reanudar. El pulso y el GPS siguen: pararlos y rearrancarlos cuesta más (el sensor
    // tarda en calentar y el GPS en fijar) de lo que ahorra una pausa normal.
    this.paused = true;
    void this.releaseWakeLock();
    this.emit();
    // La notificación enseña «Reanudar» y para su cronómetro (si la pausa vino de ella, ya lo sabe y no cambia nada).
    this.deps.platform.tracker?.setPaused(true, atMs ?? this.deps.now());
  }

  resume(atMs?: number): void {
    this.recorder?.resume(atMs);
    this.paused = false;
    void this.acquireWakeLock();
    this.emit();
    this.deps.platform.tracker?.setPaused(false, atMs ?? this.deps.now());
  }

  /**
   * Termina y entrega el registro para revisarlo. La pantalla se libera al instante; la promesa se resuelve cuando el
   * anillo ya está del todo suelto (cerrar la conexión puede tardar unos segundos si el anillo no contesta).
   */
  async finish(options: { atMs?: number; fromNotification?: boolean } = {}): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    // Lo último que grabó el servicio del GPS y aún no se ha recogido. Solo se espera si lo hay: sin él, terminar sigue siendo
    // síncrono hasta soltar la pantalla (un `await` de más retrasaría ese primer paso).
    if (this.feeder) {
      await within(this.feeder.flush(), this.deps.trackStopMs ?? TRACKER_STOP_MS);
      if (this.recorder !== recorder) return; // se canceló mientras tanto
    }
    const record = recorder.finish(options.atMs);
    const purpose = this.purpose;
    const closing = this.teardown();
    // Hasta que se guarde o se descarte tras revisarlo, el borrador es el entrenamiento terminado. Un paseo de calibración no es un entreno: no deja borrador.
    if (purpose !== 'stride') void this.deps.store.setWorkoutDraft(record).catch(() => undefined);
    this.deps.onState(null);
    this.deps.onFinished(record, purpose, options.fromNotification ? { fromNotification: true } : undefined);
    await closing;
  }

  /**
   * Recoge las órdenes que se tocaron en la notificación del entreno y las aplica en orden, cada una con la hora a la que se tocó: la web puede llevar un rato parada (pantalla apagada) y la
   * pausa o la parada cuentan desde el toque, no desde que ella se enteró. Parar termina el entreno (sin pedir confirmación) y deja lo demás sin hacer.
   */
  private async drainActions(): Promise<void> {
    const tracker = this.deps.platform.tracker;
    if (!tracker || this.draining || !this.recorder) return;
    this.draining = true;
    try {
      const actions = await tracker.takeActions();
      for (const { action, atMs } of actions) {
        if (!this.recorder) break;
        if (action === 'pause') this.pause(atMs);
        else if (action === 'resume') this.resume(atMs);
        else {
          this.log?.info('parar desde la notificación');
          await this.finish({ atMs, fromNotification: true });
          break;
        }
      }
    } catch (error) {
      this.log?.warn(`no se pudieron recoger las órdenes de la notificación: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  async discard(): Promise<void> {
    // Descartar una calibración no toca el borrador: puede ser el de un entreno anterior que sigue pendiente de revisar.
    const keepDraft = this.purpose === 'stride';
    const closing = this.teardown();
    if (!keepDraft) void this.deps.store.setWorkoutDraft(null).catch(() => undefined);
    this.deps.onState(null);
    await closing;
  }

  /** Reconexión manual con el anillo (necesita gesto del usuario si hay que abrir el selector). */
  async reconnect(): Promise<void> {
    if (!this.recorder || this.reconnecting || !this.ringLost) return;
    this.reconnecting = true;
    const epoch = this.epoch;
    try {
      const link = await this.connect(epoch);
      if (!link) return;
      if (!(await this.attach(link, epoch))) return;
      this.ringLost = false;
      this.log?.info('reconectado a mano');
      this.recorder?.setRingConnected(true);
      this.stopAutoReconnect();
      this.emit();
    } finally {
      this.reconnecting = false;
      this.settle();
    }
  }

  // ───────────────────────────── internos ─────────────────────────────

  /** El anillo conectado, o `null` si el entrenamiento se canceló mientras se reconectaba (entonces no se abre el selector del sistema). */
  private async connect(epoch: number): Promise<RingLink | null> {
    const saved = await this.deps.store.getRing();
    const known = saved ? await this.deps.transport.reconnect(saved) : null;
    if (known) return known;
    if (epoch !== this.epoch) return null;
    return this.deps.transport.pickAndConnect();
  }

  /**
   * Abre la sesión con el anillo ya conectado y arranca pulso y pasos. Devuelve `false` si el entrenamiento se canceló
   * mientras tanto (el enlace queda cerrado). Si falla, el enlace SE CIERRA antes de lanzar el error: un anillo que no
   * contesta no debe quedarse conectado gastando batería.
   */
  private async attach(link: RingLink, epoch: number): Promise<boolean> {
    const recorder = this.recorder;
    if (!recorder || epoch !== this.epoch) {
      await link.disconnect().catch(() => undefined);
      return false;
    }
    const session = new YcbtSession(link, {
      ...(this.log ? { log: this.log } : {}),
      ...(this.deps.sessionTimeouts ? { timeouts: this.deps.sessionTimeouts } : {}),
      ...(this.deps.hrWarmupMs !== undefined ? { hrWarmupMs: this.deps.hrWarmupMs } : {}),
      ...(this.deps.hrStreamAfterMs !== undefined ? { hrStreamAfterMs: this.deps.hrStreamAfterMs } : {}),
    });
    // Desde ya `teardown()` sabe cerrarla, también si el apretón de manos se queda a medias.
    this.session = session;
    this.sessionOpen = false;
    link.onDisconnect(() => {
      if (this.session !== session) return; // una sesión ya sustituida
      this.onRingLost();
    });
    try {
      await session.open(new Date(this.deps.now()));
      if (epoch !== this.epoch) return false;
      this.sessionOpen = true;
      await this.deps.store.setRing({ id: link.id, name: link.name });
      if (epoch !== this.epoch) return false;
      // Se pide siempre pulso (y pasos a pie): las funciones básicas se dan por hechas y, si el anillo rechaza la
      // medida, el entrenamiento sigue sin ella en lugar de abortarse.
      if (!this.hrRefused) {
        try {
          const stop = await session.startLiveHeartRate((bpm, ts) => {
            recorder.onHeartRate(bpm, ts);
            this.noteStamp(this.pulseMs, ts);
          });
          if (epoch !== this.epoch) {
            await stop().catch(() => undefined);
            return false;
          }
          this.stopHr = stop;
        } catch (error) {
          if (epoch !== this.epoch) return false;
          if (!(error instanceof RingError) || error.code !== 'refused') throw error;
          this.hrRefused = true;
          this.features = { ...this.features, heartRate: false };
          this.warn('Tu anillo ha rechazado la medida de pulso: este entrenamiento tendrá tiempo y calorías por tipo de actividad, sin pulso.');
        }
      }
      if (sportSupport(sportById(this.sport), session.info.capabilities).steps) {
        session.onLive((event) => {
          // Con la hora a la que el anillo mandó los pasos (la del lado nativo): con la pantalla apagada el WebView puede procesarlos mucho después.
          if (event.kind === 'status') recorder.onSteps(event.status.steps, event.tsMs);
        });
        await session.enableLiveStatus(true);
        if (epoch !== this.epoch) return false;
      }
      if (!link.connected) throw new RingError('Se perdió la conexión con el anillo.', 'link-closed');
      recorder.setRingConnected(true);
      return true;
    } catch (error) {
      if (epoch !== this.epoch) return false; // cancelado: `teardown()` ya se ocupó de cerrarlo todo
      // Fallo de verdad: se apaga lo que se hubiera encendido y se suelta el enlace antes de avisar.
      const stop = this.stopHr;
      if (this.session === session) {
        this.session = null;
        this.stopHr = null;
        this.sessionOpen = false;
      }
      await stop?.().catch(() => undefined);
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  private onRingLost(): void {
    if (!this.recorder) return;
    this.log?.warn('se perdió la conexión con el anillo');
    const session = this.session;
    const stopHr = this.stopHr;
    this.ringLost = true;
    this.session = null;
    this.stopHr = null;
    this.sessionOpen = false;
    // El enlace ya no existe: no hay a quién pedirle que pare, pero sí hay que apagar los temporizadores del pulso.
    void stopHr?.().catch(() => undefined);
    void session?.close().catch(() => undefined);
    this.recorder.setRingConnected(false);
    this.emit();
    // Se intenta reconectar sin selector; si la plataforma no puede, queda el botón manual. Si el enlace se cae EN PLENO intento
    // (el apretón de manos de un anillo al borde del alcance), el intento en vuelo ya programa el siguiente con el doble de
    // espera: reiniciarla aquí dejaba un intento cada pocos segundos durante todo el entreno.
    if (!this.reconnectTimer && !this.reconnecting) {
      this.reconnectDelayMs = this.deps.reconnectEveryMs ?? RECONNECT_EVERY_MS;
      this.scheduleReconnect();
    }
  }

  /**
   * Cada intento fallido espera 1,5 veces el anterior (hasta medio minuto): un anillo fuera de alcance mantenía el móvil
   * «iniciando conexión» casi todo el entreno, y cada intento cuesta radio. En cuanto vuelve, el siguiente intento lo coge.
   */
  private scheduleReconnect(): void {
    this.reconnectDueAt = this.deps.now() + this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => this.fireReconnect(), this.reconnectDelayMs);
  }

  private fireReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDueAt = 0;
    void this.tryAutoReconnect().then(() => {
      if (!this.running || !this.recorder || !this.ringLost || this.reconnectTimer) return;
      const base = this.deps.reconnectEveryMs ?? RECONNECT_EVERY_MS;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * RECONNECT_BACKOFF, Math.max(base, MAX_RECONNECT_EVERY_MS));
      this.scheduleReconnect();
    });
  }

  /**
   * Algo despertó a la app (un aviso nativo o volver a verse). Un aviso nativo que llega con minutos de retraso es de cuando el WebView estaba
   * parado: no se hace caso de él como reloj (el reflejo nativo ya atendió al anillo entonces), y se anota qué hizo el reflejo.
   */
  private onWake(wake?: WakeInfo): void {
    if (!this.running || !this.recorder) return;
    if (wake?.tick) {
      this.noteTick(wake.tick);
      // Con la app oculta Android espacia los temporizadores (hasta uno por minuto pasados cinco): el recogedor del GPS, que vive de uno, llegaría con las posiciones de un minuto de golpe y los avisos de la
      // navegación sonarían tarde. El aviso nativo (cada 2 s) no lo espacia nadie: cada vez que llega se recoge lo que haya.
      void this.feeder?.flush();
    }
    // Algo se tocó en la notificación y el timbre no llegó (WebView parado): el aviso nativo lo cuenta, y volver a ver la app también lo revisa.
    if ((wake?.tick?.pending ?? 0) > 0 || wake?.source === 'visible') void this.drainActions();
    const stale = wake !== undefined && wake.lagMs > STALE_WAKE_MS;
    if (wake?.tick) this.noteReflex(wake.tick, wake.lagMs);
    if (!stale) this.poke();
  }

  /** Anota en la traza del entreno cuándo estuvo parado el WebView y lo que hizo el reflejo nativo del pulso (solo cuando cambia). */
  private noteReflex(tick: TrackerTick, lagMs: number): void {
    const stalls = tick.stalls ?? 0;
    const writes = tick.writes ?? 0;
    const failed = tick.failed ?? 0;
    const last = this.lastReflex;
    if (lagMs > STALE_WAKE_MS) this.log?.warn(`la app estuvo parada: el aviso nativo tardó ${Math.round(lagMs / 1000)} s en llegar`);
    if (stalls !== last.stalls || writes !== last.writes || failed !== last.failed) {
      this.log?.info(`reflejo nativo del pulso: web parada ${stalls} vez/veces, ${writes} orden(es) escritas al anillo, ${failed} sin poder`);
      this.lastReflex = { stalls, writes, failed };
    }
  }

  /**
   * Despierta lo que espera por temporizador. Con la app oculta el WebView los espacia (hasta un minuto) y el anillo se quedaba sin
   * medir ese rato: la reapertura de la medida de pulso y el siguiente intento de reconexión se adelantan aquí si ya les tocaba. Lo llaman
   * el aviso del servicio nativo del entreno y volver a ver la app; es barato y no hace nada si no toca.
   */
  poke(): void {
    if (!this.running || !this.recorder) return;
    this.session?.poke();
    if (this.ringLost && this.reconnectTimer && this.reconnectDueAt > 0 && this.deps.now() >= this.reconnectDueAt) this.fireReconnect();
  }

  private async tryAutoReconnect(): Promise<void> {
    if (!this.recorder || this.reconnecting || !this.ringLost) return;
    this.reconnecting = true;
    const epoch = this.epoch;
    try {
      const saved = await this.deps.store.getRing();
      const link = saved ? await this.deps.transport.reconnect(saved, { silent: true }) : null;
      if (!link) return;
      if (!(await this.attach(link, epoch))) return;
      this.ringLost = false;
      this.log?.info('reconectado solo');
      this.stopAutoReconnect();
      this.emit();
    } catch {
      /* se reintenta en el siguiente ciclo */
    } finally {
      this.reconnecting = false;
      this.settle();
    }
  }

  private saveDraft(): void {
    const recorder = this.recorder;
    if (!recorder || this.purpose === 'stride') return;
    const feeder = this.feeder;
    // Con el GPS nativo el borrador anota hasta qué posición lleva: si la app se cierra, lo grabado DESPUÉS de esa se suma al recuperarlo
    // (cortar por número no pierde las que el servicio ya tenía y la web aún no había recogido; cortar por hora, sí).
    const save = (): void => {
      const draft: WorkoutDraft = feeder ? { ...recorder.toRecord(), trackSeq: feeder.delivered } : recorder.toRecord();
      void this.deps.store.setWorkoutDraft(draft).catch(() => undefined);
    };
    save();
    // Con el GPS nativo se guarda otra vez al recoger lo que el servicio grabó desde la última vez: así el borrador llega hasta lo
    // recogido y, si la app se cierra, lo que el servicio siga grabando puede continuarlo sin contar nada dos veces (ver `extendWithTrack`).
    if (feeder) {
      void feeder.flush().then(() => {
        if (this.recorder === recorder) save();
      });
    }
  }

  private stopAutoReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDueAt = 0;
  }

  private startGps(): void {
    if (!this.recorder) return;
    const tracker = this.deps.platform.tracker;
    if (!this.useGps) {
      // Sin GPS (yoga, fuerza…) el entreno también necesita el servicio nativo: es lo que lo mantiene vivo con la pantalla apagada.
      if (tracker) void this.startKeepAlive(tracker);
      return;
    }
    if (tracker) {
      void this.startNativeGps(tracker);
      return;
    }
    this.startWebGps();
  }

  /**
   * Arranca el servicio nativo SIN ubicación: un aviso fijo en la barra que mantiene vivo el proceso y la CPU despierta (lo que el anillo,
   * que habla por Bluetooth, necesita para seguir midiendo el pulso con la pantalla apagada) y trae los avisos nativos que despiertan a la web.
   */
  private async startKeepAlive(tracker: NativeTracker): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || this.keepAlive) return;
    const epoch = this.epoch;
    try {
      await tracker.askPermissions({ gps: false }).catch(() => undefined); // los avisos (Android 13); sin ellos el servicio corre igual
      if (epoch !== this.epoch) return;
      await tracker.start({ sessionId: recorder.id, startedAtMs: this.deps.now(), title: 'SmartHealth', text: `${sportById(this.sport).name}: entrenamiento en curso`, gps: false });
      if (epoch !== this.epoch) {
        // Se canceló el entreno mientras arrancaba: no se deja corriendo.
        void tracker.stop().catch(() => undefined);
        return;
      }
      this.keepAlive = tracker;
      void this.askBatteryExemptionOnce(tracker);
      void this.warnAboutPhone(tracker, epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.log?.warn(`no se pudo arrancar el servicio nativo del entreno: ${error instanceof Error ? error.message : String(error)}`);
      this.warn('No se pudo mantener el entreno en segundo plano: con la pantalla apagada el pulso puede perderse. Mantén la app a la vista.');
    }
  }

  /** El GPS de la web (el navegador, y la app si el servicio nativo falla): solo llega con la app a la vista. */
  private startWebGps(): void {
    const geo = this.deps.platform.geolocation;
    const recorder = this.recorder;
    if (!geo || !recorder || this.watchId !== null) {
      if (!geo) this.warn('Este navegador no da la ubicación: no se medirá la distancia por GPS.');
      return;
    }
    this.watchId = geo.watchPosition(
      (position) =>
        this.gpsArrived(
          recorder,
          {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyM: position.coords.accuracy,
            tsMs: position.timestamp,
            // La velocidad que mide el propio GPS (null si el dispositivo no la da): con ella la distancia no depende del ruido.
            speedMs: position.coords.speed,
          },
          false,
        ),
      (error) => {
        this.warn(error.code === 1 ? 'Has denegado el permiso de ubicación: no se medirá la distancia por GPS.' : GPS_UNAVAILABLE);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  /**
   * El GPS nativo: un servicio de Android en primer plano graba la ruta aunque la pantalla esté apagada o la app oculta, y aquí se
   * recoge (con la hora de cada posición). Si el servicio no arranca, se usa el de la web mientras la app se vea.
   */
  private async startNativeGps(tracker: NativeTracker): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    const epoch = this.epoch;
    const feeder = new TrackFeeder({
      tracker,
      sessionId: recorder.id,
      startedAtMs: this.deps.now(),
      title: 'SmartHealth',
      text: `${sportById(this.sport).name}: grabando la ruta`,
      onFix: (fix) =>
        this.gpsArrived(recorder, { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, tsMs: fix.tsMs, speedMs: fix.speedMs, pressureHpa: fix.pressureHpa }, true),
      onProblem: (problem) => this.onTrackerProblem(epoch, problem),
      onRevived: () => this.onTrackerRevived(epoch),
      ...(this.deps.trackPollEveryMs !== undefined ? { pollEveryMs: this.deps.trackPollEveryMs } : {}),
    });
    this.feeder = feeder;
    const result = await feeder.start();
    if (epoch !== this.epoch) {
      // Se canceló el entreno mientras se pedían los permisos o arrancaba el servicio: no se deja grabando.
      void feeder.stop({ clear: true });
      return;
    }
    if (result === 'denied') {
      this.feeder = null;
      this.warn('Has denegado el permiso de ubicación: no se medirá la distancia por GPS.');
      // Sin ubicación no hay ruta, pero el entreno sigue necesitando el servicio que lo mantiene vivo con la pantalla apagada.
      void this.startKeepAlive(tracker);
    } else if (result === 'failed') {
      this.feeder = null;
      this.warn('No se pudo grabar el GPS en segundo plano: solo se medirá con la app a la vista.');
      this.startWebGps();
    } else {
      void this.askBatteryExemptionOnce(tracker);
      void this.warnAboutPhone(tracker, epoch);
    }
  }

  /**
   * Al empezar, avisa de los ajustes del móvil que se sabe que cierran o frenan la app con la pantalla apagada (el «Inicio automático» de Xiaomi apagado, el ahorro de batería,
   * la app restringida), antes de que falle nada. Si el móvil no sabe contestar, no dice nada.
   */
  private async warnAboutPhone(tracker: NativeTracker, epoch: number): Promise<void> {
    try {
      const state = await tracker.status();
      if (epoch !== this.epoch || !this.running) return;
      const message = phoneRisk(serviceFactsOf(state));
      if (message) this.warn(message);
    } catch {
      /* sin estado del servicio no hay nada que decir */
    }
  }

  /**
   * Algunos fabricantes (Xiaomi, Huawei…) cierran los servicios de las apps con el ahorro de batería aunque tengan su aviso fijo:
   * una vez por instalación se pide a Android que no restrinja esta (un cuadro del sistema que la persona puede rechazar).
   */
  private async askBatteryExemptionOnce(tracker: NativeTracker): Promise<void> {
    try {
      if (localStorage.getItem(BATTERY_ASKED_KEY)) return;
      const state = await tracker.status();
      if (state.batteryExempt) return;
      localStorage.setItem(BATTERY_ASKED_KEY, '1');
      await tracker.requestBatteryExemption();
    } catch {
      /* sin almacenamiento o sin pantalla de ajustes: no es un fallo del entreno */
    }
  }

  /** Una posición del GPS (de la web o del servicio nativo, que trae la hora de cuando se midió). */
  private gpsArrived(recorder: WorkoutRecorder, fix: GpsFix, trustTime: boolean): void {
    recorder.onGps(fix, { trustTime });
    if (trustTime) this.noteStamp(this.gpsMs, fix.tsMs);
    this.deps.onGpsFix?.(fix);
    // El GPS tardó en fijar (o se fue un rato) y ya da posiciones: el aviso de que no las daba sobra.
    if (this.warnings.includes(GPS_UNAVAILABLE)) {
      this.warnings = this.warnings.filter((w) => w !== GPS_UNAVAILABLE);
      this.emit();
    }
  }

  /** Algo impide grabar (el GPS apagado, un fallo del servicio) o ya no: el aviso se pone y se quita solo. */
  private onTrackerProblem(epoch: number, problem: TrackerProblem | null): void {
    if (epoch !== this.epoch || !this.running) return;
    if (this.trackerWarning) this.warnings = this.warnings.filter((w) => w !== this.trackerWarning);
    this.trackerWarning = null;
    if (!problem) {
      this.emit();
      return;
    }
    this.trackerWarning =
      problem.kind === 'gps-off'
        ? 'El GPS del móvil está apagado: actívalo para medir la distancia.'
        : problem.kind === 'error'
          ? `No se puede grabar el GPS en segundo plano: ${problem.message}`
          : 'No se reciben las posiciones del GPS en segundo plano.';
    this.warn(this.trackerWarning);
    // Si el servicio nativo falló, la web las da mientras la app se vea.
    if (problem.kind === 'error') this.startWebGps();
  }

  /**
   * La app vuelve a verse. Con la pantalla apagada o con otra app delante el WebView no recibe el GPS, así que si estuvo oculta un
   * rato se dice (con el total del entreno): ese tramo no tiene posiciones y se completa con los pasos del anillo, o sale en línea recta.
   */
  private noteVisible(): void {
    const since = this.hiddenAtMs;
    this.hiddenAtMs = null;
    if (since !== null) this.scheduleScreenOffReport(since);
    // Con la grabación nativa no hay hueco que avisar: el servicio sigue recogiendo el GPS con la app oculta.
    if (since === null || !this.recorder || !this.useGps || this.paused || this.feeder) return;
    const away = this.deps.now() - since;
    if (away < MIN_HIDDEN_WARN_MS) return;
    this.hiddenTotalMs += away;
    const minutes = Math.max(1, Math.round(this.hiddenTotalMs / 60_000));
    const message = `La app estuvo oculta ${minutes} min (pantalla apagada u otra app delante): el GPS no mide entonces y ese tramo ${
      this.features.steps ? 'se completa con los pasos del anillo' : 'puede salir más corto'
    }. Mantén la app a la vista.`;
    if (this.hiddenWarning) this.warnings = this.warnings.filter((w) => w !== this.hiddenWarning);
    this.hiddenWarning = message;
    this.warn(message);
  }

  /** Guarda la hora de una posición o lectura para el informe de la pantalla apagada (con tope). */
  private noteStamp(list: number[], ms: number): void {
    if (!Number.isFinite(ms)) return;
    list.push(ms);
    if (list.length > MAX_STAMPS) list.splice(0, list.length - MAX_STAMPS);
  }

  /** Un aviso del servicio nativo: cuándo lo mandó y cuándo llegó (dice si el móvil paró el proceso o solo la web) y lo último que sabe del reflejo y del anillo. */
  private noteTick(tick: TrackerTick): void {
    this.lastTick = tick;
    if (typeof tick.ringDownAt === 'number' && tick.ringDownAt > 0) this.ringDownAtMs = tick.ringDownAt;
    if (typeof tick.now !== 'number') return;
    this.tickSeen.push({ nowMs: tick.now, arrivedMs: this.deps.now(), ...(typeof tick.n === 'number' ? { n: tick.n } : {}) });
    if (this.tickSeen.length > MAX_STAMPS) this.tickSeen.splice(0, this.tickSeen.length - MAX_STAMPS);
  }

  /**
   * La app vuelve a verse tras un rato oculta: pasado un momento (lo grabado con la pantalla apagada llega de golpe), se compara lo que llegó con
   * lo que tocaba (ver `screen-off-report.ts`). Si el móvil interrumpió el GPS o el pulso, se dice y se dice por qué.
   */
  private scheduleScreenOffReport(since: number): void {
    const from = this.unreportedFromMs ?? since;
    const to = this.deps.now();
    if (to - from < MIN_REPORT_MS) return;
    this.unreportedFromMs = from;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    const epoch = this.epoch;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      this.unreportedFromMs = null;
      void this.reportScreenOff(epoch, from, to);
    }, this.deps.screenReportDelayMs ?? SCREEN_REPORT_DELAY_MS);
  }

  private async reportScreenOff(epoch: number, fromMs: number, toMs: number): Promise<void> {
    if (epoch !== this.epoch || !this.running || !this.recorder) return;
    let service: ServiceFacts | null = null;
    const tracker = this.deps.platform.tracker;
    if (tracker) {
      try {
        const state = await new Promise<Awaited<ReturnType<NativeTracker['status']>>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), SERVICE_STATUS_MS);
          tracker.status().then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
        service = serviceFactsOf(state);
      } catch {
        service = null; // sin respuesta del servicio no se dice nada de él
      }
      if (epoch !== this.epoch || !this.running || !this.recorder) return;
    }
    const last = this.lastTick;
    const facts: ScreenOffFacts = {
      fromMs,
      toMs,
      gpsMs: this.feeder ? this.gpsMs : null,
      pulseMs: !this.withoutRing && this.features.heartRate && !this.hrRefused ? this.pulseMs : null,
      ticks: this.tickSeen,
      service,
      reflex: last ? { stalls: last.stalls ?? 0, writes: last.writes ?? 0, failed: last.failed ?? 0 } : null,
      ringDownAtMs: this.ringDownAtMs > 0 ? this.ringDownAtMs : null,
      mapBusy: this.mapBusyAtHide,
    };
    this.mapBusyAtHide = null;
    const report = reportScreenOff(facts);
    if (!report) return;
    this.log?.info(`pantalla apagada: ${report.technical}`);
    if (!report.problem) return;
    if (this.offWarning) this.warnings = this.warnings.filter((w) => w !== this.offWarning);
    this.offWarning = report.message;
    this.warn(report.message);
  }

  /** El sistema había parado el servicio del GPS con el entreno en marcha y se ha vuelto a levantar (ver `TrackFeeder`). */
  private onTrackerRevived(epoch: number): void {
    if (epoch !== this.epoch || !this.running) return;
    this.log?.warn('el servicio nativo del GPS estaba parado: se ha vuelto a levantar');
    this.warn('Android había parado la grabación del GPS en segundo plano y se ha vuelto a activar. El tramo sin GPS se completa con los pasos del anillo, si los hay.');
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    await lock?.release().catch(() => undefined);
  }

  private async acquireWakeLock(): Promise<void> {
    if (!this.recorder || this.paused || this.lockPending || (this.lock && this.lock.released !== true)) return;
    const epoch = this.epoch;
    this.lockPending = true;
    try {
      const lock = (await this.deps.platform.wakeLock?.request('screen')) ?? null;
      if (epoch !== this.epoch || this.paused) {
        // El entreno terminó (o se puso en pausa) mientras se pedía: un bloqueo de pantalla sin dueño la dejaría encendida.
        await lock?.release().catch(() => undefined);
        return;
      }
      this.lock = lock;
    } catch {
      if (epoch === this.epoch) this.warn('No se pudo mantener la pantalla encendida: mantenla activa a mano durante el entreno.');
    } finally {
      this.lockPending = false;
    }
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings = [...this.warnings, message];
    this.log?.warn(`aviso al usuario: ${message}`);
    this.emit();
  }

  private emit(): void {
    if (!this.running) return; // cancelado o terminado: nada de estados fantasma
    this.deps.onState({
      phase: this.phase,
      ...(this.purpose === 'workout' ? {} : { purpose: this.purpose }),
      sport: this.sport,
      useGps: this.useGps,
      ...(this.guided ? { guided: true as const } : {}),
      snapshot: this.recorder ? this.recorder.snapshot() : null,
      warnings: this.warnings,
      ringLost: this.ringLost,
      features: this.features,
      ...(this.withoutRing ? { ring: false as const } : {}),
    });
  }

  /**
   * Deshace todo. La parte síncrona (estado, temporizadores, GPS) ocurre YA, antes del primer `await`: así el panel
   * puede cerrarse al instante y cualquier operación en vuelo ve la nueva época y se retira. La promesa se resuelve
   * cuando el anillo está del todo suelto.
   */
  private teardown(): Promise<void> {
    this.epoch++;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.draftTimer) clearInterval(this.draftTimer);
    this.draftTimer = null;
    this.stopVisibleWatch?.();
    this.stopVisibleWatch = null;
    this.stopHiddenWatch?.();
    this.stopHiddenWatch = null;
    this.stopWakeWatch?.();
    this.stopWakeWatch = null;
    this.stopActionWatch?.();
    this.stopActionWatch = null;
    this.stopAutoReconnect();
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    this.unreportedFromMs = null;
    if (this.watchId !== null) this.deps.platform.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
    const feeder = this.feeder;
    this.feeder = null;
    const keepAlive = this.keepAlive;
    this.keepAlive = null;
    this.lastReflex = { stalls: 0, writes: 0, failed: 0 };
    this.trackerWarning = null;
    const lock = this.lock;
    const session = this.session;
    const stopHr = this.stopHr;
    const open = this.sessionOpen;
    const log = this.log;
    this.log = null;
    this.lock = null;
    this.session = null;
    this.stopHr = null;
    this.sessionOpen = false;
    this.recorder = null;
    this.tearingDown++;
    return (async () => {
      try {
        // Se deja de grabar la ruta (ya está toda en el entreno, o el entreno se descarta): un servicio de ubicación olvidado
        // gastaría batería con su aviso fijo puesto.
        if (feeder) await within(feeder.stop({ clear: true }), this.deps.trackStopMs ?? TRACKER_STOP_MS);
        if (keepAlive) await within(keepAlive.stop(), this.deps.trackStopMs ?? TRACKER_STOP_MS);
        await lock?.release().catch(() => undefined);
        if (session) {
          if (open) {
            await stopHr?.().catch(() => undefined);
            await session.enableLiveStatus(false).catch(() => undefined);
          }
          await session.close().catch(() => undefined);
        }
      } finally {
        // Con el anillo ya suelto, la traza del entreno se entrega a quien la pida (solo la prueba guiada: no se arma el texto si nadie la quiere).
        if (this.deps.onDiagnostic) {
          const text = log?.toText({ maxFrames: SHARED_LOG_FRAMES }) ?? '';
          if (text) this.deps.onDiagnostic(text);
        }
        this.tearingDown--;
        this.settle();
      }
    })();
  }

  /** Suelta la reserva del anillo cuando ya no queda nada en vuelo ni abierto. */
  private settle(): void {
    if (this.starting || this.reconnecting || this.tearingDown > 0 || this.recorder || this.session) return;
    const release = this.releaseRing;
    this.releaseRing = null;
    release?.();
  }
}
