import type { NativeTracker, TrackerState, TrackFix } from './tracker';

/** Posiciones que se piden por llamada (una hora a una por segundo son dos): el resto se pide con la siguiente vuelta del bucle. */
const BATCH = 2000;
/** Cada cuánto se recogen las posiciones: con la app a la vista llegan casi al momento; oculta, los temporizadores se espacian y no importa. */
const POLL_EVERY_MS = 1000;
/** Tras tantos fallos seguidos al pedir las posiciones se avisa (el servicio no responde): una sola vez. */
const MAX_FAILURES = 3;
/** Recogidas seguidas con el servicio parado antes de volver a levantarlo (uno que acaba de arrancar tarda un instante en estar vivo). */
const DEAD_POLLS_BEFORE_REVIVE = 2;
/** Entre un intento de volver a levantarlo y el siguiente. */
const REVIVE_EVERY_MS = 15_000;

export type TrackerProblem =
  /** El GPS del móvil está apagado. */
  | { kind: 'gps-off' }
  /** El servicio no pudo grabar (permiso retirado, sin GPS…). */
  | { kind: 'error'; message: string }
  /** El servicio no contesta. */
  | { kind: 'unreachable' };

export interface TrackFeederOptions {
  tracker: NativeTracker;
  /** Identificador del entrenamiento (el de la pista nativa). */
  sessionId: string;
  startedAtMs: number;
  /** Título y texto del aviso fijo de Android mientras se graba. */
  title: string;
  text: string;
  /** Cada posición recogida, EN ORDEN y una sola vez. */
  onFix: (fix: TrackFix) => void;
  /** Cambia lo que impide grabar (`null`: ya no hay problema). */
  onProblem?: (problem: TrackerProblem | null) => void;
  /** El sistema había parado el servicio con el entreno en marcha y se ha vuelto a levantar. */
  onRevived?: () => void;
  pollEveryMs?: number;
}

/**
 * Recoge del servicio nativo las posiciones del GPS de un entreno y las entrega en orden, una vez cada una. El servicio las graba
 * aunque la pantalla esté apagada o la app oculta; aquí se piden por número de secuencia («dame las posteriores a la N»), así que da
 * igual cuánto se tarde: cada una lleva la hora a la que se midió, y el grabador la coloca en su minuto.
 */
export class TrackFeeder {
  private lastSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  private stopped = false;
  /** Ya se mandó parar (aunque la recogida final siga en curso). */
  private stopping = false;
  private failures = 0;
  private problem: TrackerProblem | null = null;
  /** Recogidas seguidas en que el servicio figuraba parado con el entreno en marcha, y cuándo se intentó levantarlo por última vez. */
  private deadPolls = 0;
  private lastReviveMs = 0;

  constructor(private readonly options: TrackFeederOptions) {}

  /**
   * Pide los permisos, arranca la grabación y empieza a recoger. `denied`: sin permiso de ubicación (no se graba nada); `failed`: el
   * servicio no arrancó (hay que usar el GPS de la web mientras la app se vea).
   */
  async start(): Promise<'ok' | 'denied' | 'failed'> {
    const { tracker } = this.options;
    try {
      const permissions = await tracker.askPermissions();
      if (!permissions.location) return 'denied';
    } catch {
      return 'failed';
    }
    try {
      const state = await tracker.start({
        sessionId: this.options.sessionId,
        startedAtMs: this.options.startedAtMs,
        title: this.options.title,
        text: this.options.text,
      });
      this.report(state);
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      return code === 'PERMISSION' ? 'denied' : 'failed';
    }
    // Si se mandó parar mientras se pedían los permisos o arrancaba el servicio, no se queda un temporizador recogiendo.
    if (this.stopping) return 'failed';
    this.timer = setInterval(() => void this.flush(), this.options.pollEveryMs ?? POLL_EVERY_MS);
    return 'ok';
  }

  /** Recoge ahora todo lo que haya, y devuelve cuando ya se ha entregado. Varias llamadas seguidas comparten la misma recogida. */
  flush(): Promise<void> {
    if (this.queued) return this.chain;
    this.queued = true;
    // Un fallo (de lo que entrega `onFix`, por ejemplo) no puede dejar la cadena rechazada: la recogida seguiría muerta para siempre.
    this.chain = this.chain.then(async () => {
      this.queued = false;
      try {
        await this.pollAll();
      } catch {
        /* la siguiente vuelta lo vuelve a intentar */
      }
    });
    return this.chain;
  }

  /** Recoge lo último, deja de grabar y (con `clear`) borra la pista: ya está toda en el entreno. */
  async stop(options: { clear: boolean }): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.stopped = true;
    await this.options.tracker.stop().catch(() => undefined);
    if (options.clear) await this.options.tracker.clear({ sessionId: this.options.sessionId }).catch(() => undefined);
  }

  /** Lo que se pasó a `onFix` hasta ahora (número de la última posición). */
  get delivered(): number {
    return this.lastSeq;
  }

  private async pollAll(): Promise<void> {
    if (this.stopped) return;
    // Un tope de vueltas: una pista enorme se recoge en varias respuestas, pero un servicio que no deja de dar filas no debe colgar esto.
    for (let round = 0; round < 50; round++) {
      let reply: { fixes: TrackFix[]; state: TrackerState };
      try {
        reply = await this.options.tracker.fixes({ sessionId: this.options.sessionId, sinceSeq: this.lastSeq, limit: BATCH });
      } catch {
        if (++this.failures === MAX_FAILURES) this.setProblem({ kind: 'unreachable' });
        return;
      }
      this.failures = 0;
      for (const fix of reply.fixes) {
        if (fix.seq <= this.lastSeq) continue; // ya entregada
        this.lastSeq = fix.seq;
        this.options.onFix(fix);
      }
      this.report(reply.state);
      await this.reviveIfDead(reply.state);
      if (reply.fixes.length < BATCH) return;
    }
  }

  /**
   * Android (sobre todo en móviles con ahorro de batería agresivo) puede parar el servicio con la pantalla apagada sin cerrar la app: el
   * entreno sigue en pantalla pero el GPS ya no se graba. Se nota porque el estado dice que hay un entreno activo y el servicio no vive;
   * con la app a la vista (Android no deja arrancar un servicio en primer plano desde el fondo) se vuelve a levantar, sin tocar la pausa
   * ni las órdenes pendientes de la notificación, y la pista sigue por donde iba.
   */
  private async reviveIfDead(state: TrackerState): Promise<void> {
    const dead = state.active && !state.running && !state.error;
    if (!dead || this.stopping || this.stopped) {
      this.deadPolls = 0;
      return;
    }
    if (++this.deadPolls < DEAD_POLLS_BEFORE_REVIVE) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - this.lastReviveMs < REVIVE_EVERY_MS) return;
    this.lastReviveMs = now;
    try {
      const next = await this.options.tracker.start({
        sessionId: this.options.sessionId,
        startedAtMs: this.options.startedAtMs,
        title: this.options.title,
        text: this.options.text,
        resume: true,
      });
      this.deadPolls = 0;
      this.report(next);
      this.options.onRevived?.();
    } catch {
      /* se vuelve a intentar dentro de unos segundos */
    }
  }

  /** Lo que dice el estado del servicio que importa a la persona: el GPS apagado o un fallo del servicio. */
  private report(state: TrackerState): void {
    if (state.error) this.setProblem({ kind: 'error', message: state.error });
    else if (!state.gpsEnabled) this.setProblem({ kind: 'gps-off' });
    else this.setProblem(null);
  }

  private setProblem(problem: TrackerProblem | null): void {
    const same = problem?.kind === this.problem?.kind && (problem?.kind !== 'error' || (this.problem?.kind === 'error' && problem.message === this.problem.message));
    if (same) return;
    this.problem = problem;
    this.options.onProblem?.(problem);
  }
}
