import type { NativeTracker, TrackerAction, TrackFix, TrackerState, TrackerTick } from './tracker';

export interface FakeTrackerOptions {
  /** La persona no concede el permiso de ubicación. */
  denyLocation?: boolean;
  /** El servicio no arranca: `permission` (como si faltara el permiso) o `error`. */
  failStart?: 'permission' | 'error';
  gpsEnabled?: boolean;
  batteryExempt?: boolean;
  /** Lo que el servicio cuenta de cómo está el móvil (ahorro de batería, restricciones…). */
  phone?: Partial<Pick<TrackerState, 'powerSave' | 'idle' | 'bgRestricted' | 'bgLocation' | 'bucket' | 'autostart' | 'renderGoneAt' | 'renderGoneCrashed'>>;
}

/**
 * Un grabador de la ruta en memoria, como el servicio de Android: numera las posiciones y las entrega cuando se piden. Solo para las
 * pruebas (nada de la app lo importa).
 */
export function fakeTracker(options: FakeTrackerOptions = {}) {
  const track: TrackFix[] = [];
  const calls: string[] = [];
  const server = { active: false, session: null as string | null, gpsEnabled: options.gpsEnabled ?? true, error: null as string | null, failFixes: 0, dead: false };
  const state = (): TrackerState => ({
    // `dead`: el sistema paró el servicio pero el entreno sigue marcado como activo (como con el ahorro de batería de algunos móviles).
    running: server.active && !server.dead,
    active: server.active,
    sessionId: server.session,
    startedAtMs: 0,
    lastSeq: track.length,
    lastTsMs: track.at(-1)?.tsMs ?? 0,
    gpsEnabled: server.gpsEnabled,
    batteryExempt: options.batteryExempt ?? true,
    error: server.error,
    ...options.phone,
  });
  const ticks = new Set<(tick: TrackerTick) => void>();
  let acks = 0;
  /** Lo que se tocó en los botones de la notificación y la web aún no ha recogido (como la cola que guarda el servicio de Android), y quién oye el timbre. */
  const queue: TrackerAction[] = [];
  const doorbells = new Set<() => void>();
  /** Lo que le contó la web a la notificación: pausado o no, y desde cuándo. */
  const notification = { paused: false, pausedAtMs: null as number | null, sets: [] as Array<{ paused: boolean; atMs: number }> };
  const tracker: NativeTracker = {
    async askPermissions(request) {
      calls.push(request?.gps === false ? 'askPermissions:nogps' : 'askPermissions');
      return { location: !options.denyLocation, notifications: true };
    },
    async start(request) {
      calls.push(request.gps === false ? `start:${request.sessionId}:nogps` : request.resume ? `start:${request.sessionId}:resume` : `start:${request.sessionId}`);
      if (options.failStart === 'permission') throw Object.assign(new Error('Sin permiso de ubicación.'), { code: 'PERMISSION' });
      if (options.failStart === 'error') throw new Error('No se pudo arrancar.');
      server.active = true;
      server.dead = false;
      server.session = request.sessionId;
      return state();
    },
    async fixes({ sinceSeq, limit }) {
      calls.push(`fixes:${sinceSeq}`);
      if (server.failFixes > 0) {
        server.failFixes--;
        throw new Error('El servicio no contesta.');
      }
      return { fixes: track.filter((fix) => fix.seq > sinceSeq).slice(0, limit ?? 2000), state: state() };
    },
    async stop() {
      calls.push('stop');
      server.active = false;
      return state();
    },
    async clear({ sessionId }) {
      calls.push(`clear:${sessionId}`);
      track.length = 0;
    },
    async status() {
      calls.push('status');
      return state();
    },
    async requestBatteryExemption() {
      calls.push('battery');
      return state();
    },
    onTick(listener) {
      ticks.add(listener);
      return () => ticks.delete(listener);
    },
    ack() {
      acks++;
    },
    async takeActions() {
      calls.push('takeActions');
      return queue.splice(0, queue.length);
    },
    setPaused(paused, atMs) {
      calls.push(`setPaused:${paused}`);
      notification.sets.push({ paused, atMs });
      notification.paused = paused;
      notification.pausedAtMs = paused ? atMs : null;
    },
    onAction(listener) {
      doorbells.add(listener);
      return () => doorbells.delete(listener);
    },
  };
  /** El servicio recoge una posición (en línea recta por latitud, con velocidad del GPS). */
  const record = (lat: number, tsMs: number, speedMs: number | null = 1.3, accuracyM = 5, pressureHpa: number | null = null): TrackFix => {
    const fix: TrackFix = { seq: track.length + 1, tsMs, lat, lon: -3, accuracyM, speedMs, altM: null, vAccM: null, pressureHpa };
    track.push(fix);
    return fix;
  };
  /** El servicio avisa (cada pocos segundos, con la app oculta o no); con `at` el aviso trae la hora del lado nativo, como el de Android. */
  const tick = (payload: TrackerTick = {}): void => {
    for (const listener of [...ticks]) listener(payload);
  };
  /** Alguien toca un botón de la notificación: se anota con su hora y suena el timbre (con `ring: false`, solo se anota: la web está parada y lo recoge cuando despierta). */
  const press = (action: TrackerAction['action'], atMs: number, ring = true): void => {
    queue.push({ action, atMs });
    if (action === 'pause') {
      notification.paused = true;
      notification.pausedAtMs = atMs;
    } else if (action === 'resume') {
      notification.paused = false;
      notification.pausedAtMs = null;
    } else {
      server.active = false; // parar: el servicio deja de grabar en el acto
    }
    if (ring) for (const listener of [...doorbells]) listener();
  };
  /** El sistema para el servicio con el entreno en marcha (sin cerrar la app). */
  const kill = (): void => {
    server.dead = true;
  };
  return { tracker, calls, track, server, record, tick, press, kill, notification, pendingActions: () => queue.length, listeners: () => ticks.size, doorbells: () => doorbells.size, acks: () => acks };
}
