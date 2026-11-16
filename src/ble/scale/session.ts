import { decodeFrame, WeightStabilizer, type ScaleDecoder, type ScaleFrame, type ScaleReading } from '../../domain/scale';
import { RingError } from '../errors';
import type { LinkDetails } from '../transport';
import { advertFrames, type ScaleAdvert, type ScaleLink, type ScaleTransport } from './transport';

// La conexión viva con la báscula mientras la app la necesita (la hoja «He comido algo» abierta): la busca, se conecta, se vuelve a conectar si se duerme o se aparta, y
// va dando «el peso es X y está quieto». Guarda las últimas tramas recibidas porque son lo que se necesita para APRENDER el protocolo (`domain/scale-learn.ts`) y para el
// informe de diagnóstico cuando no se entiende.

export type ScaleStatus = 'idle' | 'connecting' | 'live' | 'asleep' | 'error';

export interface ScaleSessionState {
  status: ScaleStatus;
  /** Qué le pasa a la báscula dicho para la persona («Enciéndela…», «Falta un permiso…»); `null` si todo va bien. */
  message: string | null;
  /** Cuántas tramas han llegado desde que se arrancó. */
  frames: number;
  /** El peso, si ya se sabe descifrar (hay decodificador) y la báscula está viva. */
  reading: ScaleReading | null;
}

const IDLE: ScaleSessionState = { status: 'idle', message: null, frames: 0, reading: null };

/** Tramas que se guardan (las más recientes): sobra para aprender y para un informe. */
const MAX_FRAMES = 3_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** Cada cuánto se recalcula si el peso ya está quieto (la báscula puede callar cuando no cambia). */
const TICK_MS = 150;
/** Un anuncio de hace más que esto, y la báscula (que manda el peso en el anuncio) se da por dormida. */
const ADVERT_STALE_MS = 6_000;
/** Tras esos fallos seguidos de conexión viendo a la báscula, se avisa de lo probable: otra app la tiene cogida. */
const BUSY_AFTER_FAILS = 3;
const RETRY_AFTER_DROP_MS = 800;
/** Tras un fallo de conexión se espera al menos esto (y más cuantos más fallos seguidos, hasta el tope) aunque la báscula se siga viendo: reintentar sin pausa gastaría batería y saturaría el Bluetooth. */
const RETRY_MIN_MS = 1_500;
/** Cuánto tiene que llevar sin verse una báscula para que su siguiente anuncio cuente como «ha despertado». */
const WAKE_GAP_MS = 2_000;
const RETRY_MAX_MS = 8_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** Se resuelve cuando se cancela. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

export class ScaleSession {
  private current: ScaleSessionState = IDLE;
  private readonly listeners = new Set<(state: ScaleSessionState) => void>();
  private decoder: ScaleDecoder | null = null;
  private stabilizer = new WeightStabilizer();
  private buffer: ScaleFrame[] = [];
  private frameCount = 0;
  private lastAdvertMs = 0;
  private lastAdvert: ScaleAdvert | null = null;
  private link: ScaleLink | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  /** Quienes esperan a que la báscula «despierte» (vuelva a anunciarse tras un rato sin verse). */
  private wakeWaiters = new Set<() => void>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private lastFramesEmitMs = 0;

  constructor(
    private readonly transport: ScaleTransport,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): ScaleSessionState {
    return this.current;
  }

  onChange(listener: (state: ScaleSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: Partial<ScaleSessionState>): void {
    const next = { ...this.current, ...change };
    const same = next.status === this.current.status && next.message === this.current.message && next.frames === this.current.frames && sameReading(next.reading, this.current.reading);
    if (same) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  /** Cómo se descifra el peso (`null`: aún no se sabe: solo se guardan las tramas). */
  setDecoder(decoder: ScaleDecoder | null): void {
    this.decoder = decoder;
    this.stabilizer = new WeightStabilizer();
    this.set({ reading: null });
    if (decoder) for (const frame of this.buffer.slice(-40)) this.decode(frame);
  }

  get decoderSource(): string | null {
    return this.decoder?.source ?? null;
  }

  frames(): ScaleFrame[] {
    return [...this.buffer];
  }

  clearFrames(): void {
    this.buffer = [];
    this.frameCount = 0;
    this.stabilizer.reset();
    this.set({ frames: 0, reading: null });
  }

  /** Los datos del último anuncio visto (para el informe). */
  advert(): ScaleAdvert | null {
    return this.lastAdvert;
  }

  /** A qué características está suscrita la conexión abierta (para el informe). */
  subscribed(): readonly string[] {
    return this.link?.subscribed ?? [];
  }

  async details(): Promise<LinkDetails | null> {
    return this.link ? await this.link.details().catch(() => null) : null;
  }

  /** ¿La báscula manda el peso en su anuncio (no hace falta conectarse)? */
  private get advertOnly(): boolean {
    return this.decoder?.source.startsWith('a:') ?? false;
  }

  // ───────────────────── arrancar y parar ─────────────────────

  /** Empieza a buscar y a conectar con la báscula. Si ya está en marcha no hace nada. */
  start(device: { id: string; name: string | null }): void {
    if (this.running) return;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ status: 'connecting', message: null });
    this.tick = setInterval(() => this.refresh(), TICK_MS);
    this.running = this.run(device, abort.signal)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) this.set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.running = null;
      });
  }

  /** Deja de buscar, cierra la conexión y suelta el Bluetooth. */
  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
    const link = this.link;
    this.link = null;
    await link?.disconnect().catch(() => undefined);
    await this.running?.catch(() => undefined);
    this.stabilizer.reset();
    this.set({ status: 'idle', message: null, reading: null });
  }

  private async run(device: { id: string; name: string | null }, signal: AbortSignal): Promise<void> {
    // Los anuncios sirven para dos cosas: despertar al bucle cuando la báscula vuelve a verse y, si el peso va en el anuncio (o aún se está aprendiendo dónde va), leerlo.
    // Conectada y sabiendo ya leer sus tramas no hacen falta: se deja de escuchar (una búsqueda abierta gasta batería) y se retoma al perderla.
    let stopWatching: (() => void) | null = null;
    const watch = async (): Promise<boolean> => {
      if (stopWatching) return true;
      try {
        stopWatching = await this.transport.watch(device.id, (advert) => this.onAdvert(advert));
        return true;
      } catch (error) {
        if (error instanceof RingError && error.code === 'unsupported-platform') {
          this.set({ status: 'error', message: error.message });
          return false;
        }
        // Sin poder escuchar anuncios (la ubicación apagada, p. ej.) se intenta conectar igual, sin la ayuda de saber cuándo despierta.
        return true;
      }
    };
    const unwatch = (): void => {
      stopWatching?.();
      stopWatching = null;
    };
    if (!(await watch())) return;
    let fails = 0;
    try {
      while (!signal.aborted) {
        if (this.advertOnly) {
          this.refresh();
          await sleep(TICK_MS * 2, signal);
          continue;
        }
        if (!(await watch())) return;
        // Los reintentos tras un fallo no vuelven a poner «conectando»: la pantalla seguiría diciendo lo que le pasa a la báscula, sin parpadear.
        if (this.current.status === 'idle') this.set({ status: 'connecting' });
        let link: ScaleLink;
        try {
          link = await this.transport.connect(device, { timeoutMs: CONNECT_TIMEOUT_MS, signal });
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof RingError && error.code === 'unsupported-platform') {
            this.set({ status: 'error', message: error.message });
            return;
          }
          fails++;
          const busy = fails >= BUSY_AFTER_FAILS && this.seenRecently();
          this.set({
            status: 'asleep',
            message: busy
              ? 'No consigo conectar con la báscula. Cierra la app de RENPHO (la báscula solo admite una conexión a la vez) y pulsa un botón de la báscula.'
              : 'Enciende la báscula (pulsa un botón o pon algo encima).',
            reading: null,
          });
          // Una pausa con retroceso; si la báscula se ve despertar mientras tanto, se reintenta enseguida.
          await this.pause(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (fails - 1)), signal, true);
          continue;
        }
        fails = 0;
        if (this.decoder !== null) unwatch();
        this.link = link;
        const dropped = new Promise<void>((resolve) => link.onDisconnect(resolve));
        const off = link.onFrame((frame) => this.onFrame(frame));
        this.set({ status: 'live', message: null });
        await Promise.race([dropped, aborted(signal)]);
        off();
        this.link = null;
        await link.disconnect().catch(() => undefined);
        if (signal.aborted) break;
        // La báscula se apagó sola (o se apartó): sin lectura hasta que vuelva.
        this.stabilizer.reset();
        this.set({ status: 'asleep', message: 'La báscula se ha dormido. Pulsa un botón o pon algo encima.', reading: null });
        // Se vuelve a vigilar sus anuncios ya, para no perder el momento en que despierte durante la pausa.
        if (!(await watch())) return;
        await this.pause(RETRY_AFTER_DROP_MS, signal, false);
      }
    } finally {
      unwatch();
    }
  }

  private seenRecently(): boolean {
    return this.now() - this.lastAdvertMs < ADVERT_STALE_MS;
  }

  /** Espera `ms` (o hasta cancelar); con `wakeEarly`, también termina si la báscula despierta. */
  private pause(ms: number, signal: AbortSignal, wakeEarly: boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakeWaiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (wakeEarly) this.wakeWaiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // ───────────────────── lo que llega ─────────────────────

  private onAdvert(advert: ScaleAdvert): void {
    const gap = this.now() - this.lastAdvertMs;
    this.lastAdvert = advert;
    this.lastAdvertMs = this.now();
    for (const frame of advertFrames(advert)) this.onFrame(frame);
    // Un anuncio tras un rato sin verla es la báscula despertando: se reintenta la conexión sin esperar a que acabe la pausa.
    if (gap >= WAKE_GAP_MS) for (const wake of [...this.wakeWaiters]) wake();
  }

  private onFrame(frame: ScaleFrame): void {
    this.buffer.push(frame);
    if (this.buffer.length > MAX_FRAMES) this.buffer.splice(0, this.buffer.length - MAX_FRAMES + 500);
    this.frameCount++;
    this.decode(frame);
    // El contador sube con cada trama: se avisa como mucho cada cuarto de segundo para no repintar la pantalla a 10 veces por segundo.
    if (this.now() - this.lastFramesEmitMs >= 250 || this.current.frames === 0) {
      this.lastFramesEmitMs = this.now();
      this.set({ frames: this.frameCount });
    }
  }

  private decode(frame: ScaleFrame): void {
    if (!this.decoder) return;
    const grams = decodeFrame(this.decoder, frame);
    if (grams === null) return;
    this.stabilizer.push(grams, frame.atMs);
    this.refresh();
  }

  /** Recalcula la lectura con el reloj de ahora (el peso puede haberse quedado quieto sin tramas nuevas). */
  private refresh(): void {
    if (!this.decoder) return;
    if (this.advertOnly) {
      const alive = this.seenRecently();
      if (!alive) {
        if (this.current.status === 'live') this.stabilizer.reset();
        this.set({ status: 'asleep', message: 'Enciende la báscula (pulsa un botón o pon algo encima).', reading: null });
        return;
      }
      this.set({ status: 'live', message: null, reading: this.stabilizer.read(this.now()) });
      return;
    }
    if (this.current.status !== 'live') return;
    this.set({ reading: this.stabilizer.read(this.now()) });
  }
}

function sameReading(a: ScaleReading | null, b: ScaleReading | null): boolean {
  if (a === null || b === null) return a === b;
  return a.grams === b.grams && a.stable === b.stable;
}
