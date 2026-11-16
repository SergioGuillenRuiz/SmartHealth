import { RingError } from '../ble/errors';
import { emptyHistory } from '../ble/records';
import { YcbtSession, type Timeouts } from '../ble/session';
import type { RingTransport } from '../ble/transport';
import type { Store } from '../data/types';
import { dayKeyOf, type DayKey } from '../domain/dates';
import { maxCounterAt, sanitizeHistory } from '../domain/sanitize';
import { autoReconnectOptions } from './silent';

export interface LiveRefreshDeps {
  transport: RingTransport;
  store: Pick<Store, 'getRing' | 'ingest'>;
  now?: () => number;
  timeouts?: Partial<Timeouts>;
  /** Cancela la lectura: suelta el enlace y termina con `aborted`. */
  signal?: AbortSignal;
}

/** Los pasos de hoy tal y como los dio el anillo la última vez que se leyeron, y cuándo. */
export interface LiveSteps {
  day: DayKey;
  steps: number;
  atMs: number;
}

/**
 * Lo máximo que sube el contador de pasos por minuto (con holgura: un esprint ronda los 200 pasos/min) más un margen fijo. Una
 * subida mayor entre dos lecturas del mismo día no es andar sino ruido, y guardada se quedaría como el máximo del día (los pasos
 * del día son el mayor valor del contador) hasta medianoche. Con la lectura anterior lejos en el tiempo (la app estuvo oculta
 * horas) el margen crece con ellas, así que una subida de verdad nunca se descarta.
 */
export const MAX_STEPS_PER_MINUTE = 260;
export const STEPS_JUMP_SLACK = 100;

export interface LiveRefreshResult {
  /** Pasos de hoy que dio el anillo (`null`: no los mandó a tiempo). */
  steps: number | null;
  /** Cuándo se leyeron. */
  atMs: number;
  /** Los pasos son distintos de la lectura anterior (o es de otro día) y se guardaron: hay algo nuevo que pintar. */
  changed: boolean;
  /** La subida desde la lectura anterior no es creíble para el tiempo que pasó: no se guardó (y no es la nueva base). */
  implausible?: boolean;
  batteryPercent: number | null;
}

const cancelled = (cause?: unknown): RingError => new RingError('Actualización cancelada.', 'aborted', cause === undefined ? undefined : { cause });

/**
 * La lectura ligera de la actualización automática: conecta, pide el contador de pasos del día (`06 00`), lo guarda si ha
 * cambiado y SUELTA el anillo. Con el R99 real dura unos 5–6 s (2,4 s de conexión, 0,4 de saludo y ~2,5 hasta el primer envío),
 * frente a los 10–15 s de una sincronización completa, que además relee todo el historial guardado en el anillo.
 *
 * Solo escribe una lectura del contador (un punto más del acumulado del día, ver `sanitizeHistory`): no toca nada de lo ya
 * guardado ni deja constancia en el historial de sincronizaciones. El historial (tramos, pulso, sueño) lo trae la
 * sincronización completa; mientras tanto el anillo lo conserva todo.
 *
 * Nunca abre diálogos del sistema ni el selector de dispositivos: sin el anillo a mano, falla con `connect-failed`.
 */
export async function refreshLive(deps: LiveRefreshDeps, previous: LiveSteps | null): Promise<LiveRefreshResult> {
  const { transport, store, signal } = deps;
  const now = deps.now ?? Date.now;
  const saved = await store.getRing();
  if (!saved) throw new RingError('No hay ningún anillo vinculado.', 'no-device');
  const link = await transport.reconnect(saved, autoReconnectOptions(signal));
  if (!link) {
    if (signal?.aborted) throw cancelled();
    throw new RingError('No se encontró el anillo: ¿está cerca y con Smart Health cerrada?', 'connect-failed');
  }
  if (signal?.aborted) {
    await link.disconnect().catch(() => undefined);
    throw cancelled();
  }

  const session = new YcbtSession(link, { ...(deps.timeouts ? { timeouts: deps.timeouts } : {}) });
  const onAbort = (): void => void session.close().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const info = await session.open(new Date(now()));
    // El contador se sella con la hora en que se PIDIÓ, no con la de después de esperar la respuesta y la orden de apagar el empuje
    // (hasta 1,5 s más): a las 23:59:59 un contador de ayer no puede quedar como el de las 00:00:00 de hoy.
    const atMs = now();
    const live = await session.readLiveStatus(deps.timeouts?.reply);
    if (signal?.aborted) throw cancelled();
    if (live === null) return { steps: null, atMs, changed: false, batteryPercent: info.batteryPercent };

    const day = dayKeyOf(atMs);
    const sameDay = previous !== null && previous.day === day;
    // Ruido: un total imposible para la hora del día (a las 00:00:00,5 el anillo puede dar aún el de ayer) o, dentro del mismo día,
    // una subida imposible para el tiempo que pasó. Con el reloj atrasado entre dos lecturas no se puede juzgar el tiempo: se cree.
    const elapsedMin = previous === null ? 0 : (atMs - previous.atMs) / 60_000;
    const jumpTooBig = previous !== null && sameDay && elapsedMin >= 0 && live.steps - previous.steps > MAX_STEPS_PER_MINUTE * elapsedMin + STEPS_JUMP_SLACK;
    if (jumpTooBig || live.steps > maxCounterAt(atMs)) {
      return { steps: live.steps, atMs, changed: false, implausible: true, batteryPercent: info.batteryPercent };
    }
    const changed = previous === null || !sameDay || previous.steps !== live.steps;
    if (changed) await store.ingest(sanitizeHistory(emptyHistory(), now(), live, atMs));
    return { steps: live.steps, atMs, changed, batteryPercent: info.batteryPercent };
  } catch (error) {
    if (signal?.aborted) throw cancelled(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await session.close().catch(() => undefined);
  }
}
