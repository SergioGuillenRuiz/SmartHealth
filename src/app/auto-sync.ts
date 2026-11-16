import { effect } from '@preact/signals';
import { RingError } from '../ble/errors';
import { dayKeyOf } from '../domain/dates';
import { refreshLive, type LiveRefreshResult, type LiveSteps } from '../sync/live-refresh';
import { runSync, SyncFailure } from '../sync/run-sync';
import { reloadAll } from './actions';
import { scaleWanted } from './scale';
import { svc } from './services';
import { bumpData, lastSync, ring, setAutoYield, settings, tryClaimRing } from './state';

// La actualización automática: con la app a la vista y un anillo vinculado, trae sola los datos del anillo.
//
// El anillo no se queda conectado (cada conexión gasta batería en él y en el móvil): se conecta, lee, guarda y suelta, como
// la sincronización de siempre. Hay dos lecturas:
// - la ligera, cada minuto: solo el contador de pasos del día (~5 s con el anillo real). Con ella los pasos, la distancia y
//   las calorías del Resumen van subiendo mientras se anda;
// - la completa, cada diez minutos: además trae el historial (tramos de actividad, pulso, sueño). Dura 10–15 s y relee todo
//   lo que guarda el anillo, por eso no se hace cada minuto.
//
// Nada de esto toca lo que el anillo guarda: el historial sigue en el anillo hasta que se trae, y traerlo es idempotente.
// Solo trabaja con la app a la vista (con la pantalla apagada o en otra app no hay nada que pintar, y las conexiones se
// pararían de golpe), nunca abre diálogos del sistema y siempre cede el anillo a lo que pida la persona.

/** Cada cuánto se lee el contador de pasos. */
export const LIVE_EVERY_MS = 60_000;
/** Con los pasos quietos (sin andar) se espacian las lecturas, hasta este tope. */
export const MAX_QUIET_EVERY_MS = 5 * 60_000;
/** Cada cuánto se trae también el historial. */
export const FULL_EVERY_MS = 10 * 60_000;
/** Un intento de sincronización completa que falló no se repite antes de esto (entre medias sigue la lectura ligera). */
export const FULL_RETRY_MS = 10 * 60_000;
/** Espera tras volver a ver la app (o activarla) antes de leer, para que la pantalla pinte primero. */
export const RESUME_DELAY_MS = 1_500;
/** Al volver a ver la app no se repite lo que se acaba de hacer. */
export const MIN_GAP_MS = 20_000;
/** Si el anillo lo tiene otra cosa (un entreno, una medida), se mira de nuevo cada tanto. */
export const BUSY_RETRY_MS = 10_000;
/** Tras fallos seguidos (anillo fuera de alcance, Bluetooth apagado) la espera se duplica hasta este tope. */
export const MAX_BACKOFF_MS = 4 * 60_000;
/** Lo máximo que espera quien pide el anillo a que la automática lo suelte (ver `yieldRing`). */
export const YIELD_WAIT_MS = 5_000;

export interface AutoSyncDeps {
  now: () => number;
  /** ¿Puede trabajar ahora? Activada, con un anillo vinculado y la app a la vista. */
  eligible: () => boolean;
  /** Reserva el anillo sin avisar de nada; `null` si lo usa otra cosa. */
  claim: () => (() => void) | null;
  /** Cuándo acabó la última sincronización completa (`null`: ninguna). */
  lastFullMs: () => number | null;
  /** Los pasos de hoy que se conocen de la última sincronización completa, para saber si la lectura ligera trae algo nuevo. */
  baseline: () => LiveSteps | null;
  /** Sincronización completa y silenciosa; si sale bien, la pantalla ya está al día. */
  full: (signal: AbortSignal) => Promise<void>;
  /** Lectura ligera del contador de pasos. */
  live: (signal: AbortSignal, previous: LiveSteps | null) => Promise<LiveRefreshResult>;
  /** La lectura ligera trajo algo nuevo: hay que repintar. */
  changed: () => void;
}

const cancelledBy = (signal: AbortSignal): boolean => signal.aborted;

/** El Bluetooth apagado o sin permisos no gasta radio: reintentar pronto no cuesta nada y no merece esperas largas. */
const isCheapFailure = (error: unknown): boolean => (error instanceof RingError || error instanceof SyncFailure) && error.code === 'unsupported-platform';

/**
 * Decide cuándo leer el anillo y cuándo no. No sabe nada de Bluetooth ni de pantallas (las recibe en `AutoSyncDeps`), así que se
 * prueba con relojes falsos.
 */
export class AutoSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: { abort: AbortController; done: Promise<void> } | null = null;
  private stopped = true;
  /** Si estaba en condiciones de trabajar la última vez que se miró: al volver a estarlo, se pone al día pronto. */
  private wasEligible = false;
  private failures = 0;
  /** Lecturas ligeras seguidas sin pasos nuevos. */
  private quiet = 0;
  private lastLive: LiveSteps | null = null;
  private lastEndMs = 0;
  private lastFullAttemptMs = 0;

  constructor(private readonly deps: AutoSyncDeps) {}

  start(): void {
    this.stopped = false;
    this.wasEligible = false;
    this.recheck();
  }

  stop(): void {
    this.stopped = true;
    this.wasEligible = false;
    this.cancelTimer();
    this.current?.abort.abort();
  }

  /** Hay una lectura en marcha (para saber si quien pide el anillo tendrá que esperar a que lo suelte). */
  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Algo que decide si puede trabajar ha cambiado (la app se oculta o se ve, se activa o se desactiva, se vincula o se olvida
   * el anillo). Si deja de poder, corta lo que hace; si vuelve a poder, se pone al día enseguida.
   */
  recheck(): void {
    if (this.stopped) return;
    if (!this.deps.eligible()) {
      this.wasEligible = false;
      this.cancelTimer();
      this.current?.abort.abort();
      return;
    }
    if (this.wasEligible) return;
    this.wasEligible = true;
    this.failures = 0;
    // Sin repetir lo que acaba de hacerse, pero acotado: con el reloj atrasado (una hora corregida) la espera no puede crecer.
    if (!this.current) this.schedule(Math.min(MIN_GAP_MS, Math.max(RESUME_DELAY_MS, MIN_GAP_MS - (this.deps.now() - this.lastEndMs))));
  }

  /**
   * Quien pide el anillo para otra cosa (sincronizar a mano, medir el pulso, empezar un entreno) lo tiene antes: se corta la
   * lectura en marcha y se espera —poco— a que suelte el enlace.
   */
  async yieldRing(maxWaitMs: number = YIELD_WAIT_MS): Promise<void> {
    const current = this.current;
    if (!current) return;
    current.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxWaitMs)))]);
    clearTimeout(timer);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (this.stopped) return;
    if (!this.deps.eligible()) {
      this.wasEligible = false;
      return;
    }
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (!this.deps.eligible()) {
      this.wasEligible = false;
      return;
    }
    const release = this.deps.claim();
    if (!release) {
      this.schedule(BUSY_RETRY_MS);
      return;
    }
    const abort = new AbortController();
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    this.current = { abort, done };
    let next = LIVE_EVERY_MS;
    try {
      next = await this.work(abort.signal);
    } catch (error) {
      if (cancelledBy(abort.signal)) {
        // Cortada (la app se ocultó, o la persona pidió el anillo): no es un fallo. Si la app ya se ve de nuevo, vuelve a lo suyo
        // pronto, no al cabo de un minuto entero.
        next = MIN_GAP_MS;
      } else if (isCheapFailure(error)) {
        next = LIVE_EVERY_MS;
      } else {
        this.failures++;
        next = Math.min(MAX_BACKOFF_MS, LIVE_EVERY_MS * 2 ** this.failures);
      }
    } finally {
      this.lastEndMs = this.deps.now();
      this.current = null;
      release();
      finish();
    }
    this.schedule(next);
  }

  /** Una lectura (completa si toca, ligera si no). Devuelve cuánto esperar a la siguiente. */
  private async work(signal: AbortSignal): Promise<number> {
    const now = this.deps.now();
    const lastFull = this.deps.lastFullMs();
    // Una fecha del futuro (el reloj del móvil se atrasó) no puede bloquear la completa hasta que se alcance: se da por vencida.
    const sinceFull = lastFull === null ? Infinity : now - lastFull;
    const sinceAttempt = now - this.lastFullAttemptMs;
    const fullDue = (sinceFull < 0 || sinceFull >= FULL_EVERY_MS) && (sinceAttempt < 0 || sinceAttempt >= FULL_RETRY_MS);
    if (fullDue) {
      try {
        await this.deps.full(signal);
      } catch (error) {
        // Una cancelada no cuenta como intento: en cuanto el anillo esté libre se vuelve a intentar.
        if (!cancelledBy(signal)) this.lastFullAttemptMs = this.deps.now();
        throw error;
      }
      this.lastFullAttemptMs = this.deps.now();
      this.failures = 0;
      this.quiet = 0;
      this.lastLive = null; // la completa también leyó el contador: la base es la suya
      return LIVE_EVERY_MS;
    }
    const result = await this.deps.live(signal, this.lastLive ?? this.deps.baseline());
    this.failures = 0;
    // Una lectura que no se creyó (una subida imposible) no pasa a ser la base de la siguiente.
    if (result.steps !== null && result.implausible !== true) this.lastLive = { day: dayKeyOf(result.atMs), steps: result.steps, atMs: result.atMs };
    if (result.changed) {
      this.quiet = 0;
      this.deps.changed();
    } else {
      this.quiet++;
    }
    return Math.min(MAX_QUIET_EVERY_MS, LIVE_EVERY_MS * (1 + this.quiet));
  }
}

// ───────────────────────────── en la app ─────────────────────────────

const pageVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * La base de la lectura ligera: los pasos que leyó la última sincronización completa y cuándo. Sin base si no leyó el contador o si
 * es «del futuro» (el reloj del móvil se atrasó después): no se sabe cuánto tiempo ha pasado y se descartarían subidas verdaderas.
 */
export function baselineFromSync(last: { tsMs: number; liveSteps: number | null } | null, nowMs: number): LiveSteps | null {
  if (!last || last.liveSteps === null || last.tsMs > nowMs) return null;
  return { day: dayKeyOf(last.tsMs), steps: last.liveSteps, atMs: last.tsMs };
}

/**
 * Arranca la actualización automática de la app. Devuelve cómo pararla. Solo la llaman el arranque con el Bluetooth nativo
 * (y la demostración que la pide) y las pruebas.
 */
export function startAutoSync(): () => void {
  const { transport, store, now } = svc();
  const controller = new AutoSync({
    now,
    // Con la báscula en uso (pesando una comida) la actualización espera: la báscula y el anillo a la vez se estorban en el Bluetooth del móvil (`scaleWanted`).
    eligible: () => settings.value.autoSync && settings.value.hasRing && ring.value !== null && transport.available && pageVisible() && !scaleWanted.value,
    claim: () => tryClaimRing('sync'),
    lastFullMs: () => lastSync.value?.tsMs ?? null,
    baseline: () => baselineFromSync(lastSync.value, now()),
    full: async (signal) => {
      await runSync({ transport, store, now }, { silent: true, signal, onLiveSaved: bumpData });
      await reloadAll();
      bumpData();
    },
    live: (signal, previous) => refreshLive({ transport, store, now, signal }, previous),
    changed: bumpData,
  });
  setAutoYield(() => controller.yieldRing());
  const onVisibility = (): void => controller.recheck();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  controller.start();
  // Lo que lee `eligible` (el ajuste y el anillo vinculado) suscribe este efecto: al cambiar, el planificador vuelve a mirar.
  const stopWatching = effect(() => {
    controller.recheck();
  });
  return () => {
    stopWatching();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    setAutoYield(null);
    controller.stop();
  };
}
