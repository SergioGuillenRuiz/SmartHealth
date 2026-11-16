import type { PluginListenerHandle } from '@capacitor/core';
import { isNative, Tracker, type RawTrackFix, type TrackerAction, type TrackerState, type TrackerTick } from './native';

export type { TrackerAction, TrackerState, TrackerTick };

/** Una posición del GPS recogida por el servicio nativo (ver `TrackingService.java`). */
export interface TrackFix {
  /** Número de orden dentro de la pista del entreno (1, 2, 3…). */
  seq: number;
  /** Hora en ms según el reloj de pared del móvil: la del instante en que el chip fijó la posición, no la de entregarla. */
  tsMs: number;
  lat: number;
  lon: number;
  /** Precisión en metros; `Infinity` si el móvil no la dio (la posición se descarta). */
  accuracyM: number;
  speedMs: number | null;
  altM: number | null;
  vAccM: number | null;
  /** Presión del barómetro del móvil (hPa) en ese momento: da cuánto se sube. `null` si el móvil no tiene o la lectura es vieja. */
  pressureHpa: number | null;
}

/** Lo que la web usa de la grabación de la ruta en segundo plano. En las pruebas se sustituye por uno en memoria. */
export interface NativeTracker {
  /** Pide la ubicación (salvo con `gps: false`) y (desde Android 13) los avisos. `location` es lo único imprescindible con GPS. */
  askPermissions(options?: { gps?: boolean }): Promise<{ location: boolean; notifications: boolean }>;
  /** Empieza el servicio del entreno: graba su ruta (o, con `gps: false`, solo lo mantiene vivo). Debe llamarse con la app a la vista. */
  start(options: { sessionId: string; startedAtMs: number; title?: string; text?: string; gps?: boolean; resume?: boolean }): Promise<TrackerState>;
  /** Las posiciones posteriores a `sinceSeq` (hasta `limit`), en orden. */
  fixes(options: { sessionId: string; sinceSeq: number; limit?: number }): Promise<{ fixes: TrackFix[]; state: TrackerState }>;
  /** Deja de grabar; la pista se conserva hasta `clear`. */
  stop(): Promise<TrackerState>;
  clear(options: { sessionId: string }): Promise<void>;
  status(): Promise<TrackerState>;
  /** Abre el cuadro de Android para que no restrinja la app en segundo plano. */
  requestBatteryExemption(): Promise<TrackerState>;
  /**
   * Un aviso cada pocos segundos mientras dura el entreno, que llega aunque la app esté oculta y sus temporizadores espaciados (lo manda el
   * lado nativo). Devuelve cómo dejar de oírlo. Cada aviso se contesta con `ack`: si deja de contestarse, el lado nativo da por parada la web.
   */
  onTick(listener: (tick: TrackerTick) => void): () => void;
  /** Contesta a un aviso nativo: la web está viva. */
  ack(): void;
  /** Las órdenes de la notificación (pausa, reanudar, parar) pendientes, en orden y con su hora; se vacía la cola. Sin notificación (el navegador), nunca hay ninguna. */
  takeActions(): Promise<TrackerAction[]>;
  /** El entreno se pausó o se reanudó desde la app: la notificación lo refleja. No espera respuesta. */
  setPaused(paused: boolean, atMs: number): void;
  /** Se tocó un botón de la notificación (aunque la app estuviera oculta): hay que llamar a `takeActions`. Devuelve cómo dejar de oírlo. */
  onAction(listener: () => void): () => void;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Una fila del plugin como posición, o `null` si está rota (nunca debe tumbar el entreno por una fila mala). */
export function parseFix(raw: RawTrackFix): TrackFix | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [seq, tsMs, lat, lon, accuracy, speed, alt, vAcc, pressure] = raw;
  if (!finite(seq) || !finite(tsMs) || !finite(lat) || !finite(lon)) return null;
  return {
    seq,
    tsMs,
    lat,
    lon,
    accuracyM: finite(accuracy) ? accuracy : Number.POSITIVE_INFINITY,
    speedMs: finite(speed) ? speed : null,
    altM: finite(alt) ? alt : null,
    vAccM: finite(vAcc) ? vAcc : null,
    pressureHpa: finite(pressure) ? pressure : null,
  };
}

/** El grabador de la ruta de Android; `null` fuera de la app instalada (navegador, pruebas), donde se usa el GPS de la web. */
export function nativeTracker(): NativeTracker | null {
  if (!isNative()) return null;
  return {
    askPermissions: (options) => Tracker.askPermissions(options),
    start: (options) => Tracker.start(options),
    async fixes(options) {
      const reply = await Tracker.fixes(options);
      const fixes: TrackFix[] = [];
      for (const raw of reply.fixes ?? []) {
        const fix = parseFix(raw);
        if (fix) fixes.push(fix);
      }
      const { fixes: _raw, ...state } = reply;
      return { fixes, state };
    },
    stop: () => Tracker.stop(),
    clear: (options) => Tracker.clear(options),
    status: () => Tracker.status(),
    requestBatteryExemption: () => Tracker.requestBatteryExemption(),
    ack: () => void Tracker.ack().catch(() => undefined),
    async takeActions() {
      const reply = await Tracker.takeActions();
      return (reply.actions ?? []).filter((a) => (a.action === 'pause' || a.action === 'resume' || a.action === 'stop') && typeof a.atMs === 'number' && Number.isFinite(a.atMs));
    },
    setPaused: (paused, atMs) => void Tracker.setPaused({ paused, atMs }).catch(() => undefined),
    onAction(listener) {
      let handle: PluginListenerHandle | null = null;
      let stopped = false;
      Tracker.addListener('action', listener).then(
        (added) => {
          if (stopped) void added.remove();
          else handle = added;
        },
        () => undefined, // sin timbre, las órdenes se recogen igual al llegar un aviso nativo o al volver a verse la app
      );
      return () => {
        stopped = true;
        void handle?.remove();
      };
    },
    onTick(listener) {
      let handle: PluginListenerHandle | null = null;
      let stopped = false;
      Tracker.addListener('tick', listener).then(
        (added) => {
          if (stopped) void added.remove();
          else handle = added;
        },
        () => undefined, // sin aviso nativo, quedan los temporizadores y las tramas del anillo
      );
      return () => {
        stopped = true;
        void handle?.remove();
      };
    },
  };
}
