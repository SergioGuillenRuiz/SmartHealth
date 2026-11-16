import type { ChunkMeta } from './transport';

// El pulso en directo de un R99 real en un entreno, tal y como lo recibe el lado nativo de la app de Android, para probar qué hace la web cuando estuvo parada
// (pantalla apagada) y procesa de golpe lo acumulado. Los tiempos son los medidos con el anillo (docs/protocolo-ycbt.md, «Verificado con un R99 real»).

/** Una trama que empuja el anillo, con lo que le añadió el lado nativo (hora de llegada, si el reflejo la atendió, cuándo pidió él la última medida). */
export interface RingPush {
  kind: 'real' | 'devControl';
  key: number;
  payload: number[];
  native: ChunkMeta;
}

export const nativeMeta = (atMs: number, extra: Partial<ChunkMeta> = {}): ChunkMeta => ({ seq: 1, atMs, restartAtMs: 0, reflexed: false, ...extra });

export interface R99Options {
  /** El primer cierre lo atendió el reflejo nativo (por omisión sí). Si no, llegó antes de darse por parada la web y nadie lo confirmó ni reabrió la medida. */
  firstReflexed?: boolean;
  /** Con `firstReflexed: false`: a los cuántos segundos una copia del primer cierre (el anillo las reenvía hasta que se confirman) sí la atiende el reflejo. */
  firstCopyAfterS?: number;
}

/**
 * Ciclos de medida de 20 s: se pide, la primera trama llega a los 8 s, una por segundo hasta los 18 s (cada ciclo con su valor, `70 + n`), el anillo cierra la medida con
 * `04 0e` a los 20 s y el reflejo nativo la reabre al instante. Devuelve las tramas en orden y lo que debe entregar la web: las tres últimas lecturas de cada ciclo
 * cerrado (con la hora a la que llegaron).
 */
export function r99Timeline(startMs: number, cycles: number, options: R99Options = {}): { events: RingPush[]; expected: Array<[bpm: number, tsMs: number]> } {
  const { firstReflexed = true, firstCopyAfterS } = options;
  const events: RingPush[] = [];
  const expected: Array<[number, number]> = [];
  let cycleStart = startMs;
  let restartAt = 0; // la última vez que pidió la medida el reflejo nativo (0: nunca)
  for (let k = 0; k < cycles; k++) {
    for (let s = 8; s <= 18; s++) events.push({ kind: 'real', key: 0x01, payload: [70 + k], native: nativeMeta(cycleStart + s * 1000, { restartAtMs: restartAt }) });
    for (const s of [16, 17, 18]) expected.push([70 + k, cycleStart + s * 1000]);
    const closeAt = cycleStart + 20_000;
    const reflexed = k > 0 || firstReflexed;
    if (reflexed) restartAt = closeAt;
    events.push({ kind: 'devControl', key: 0x0e, payload: [0, 1], native: nativeMeta(closeAt, { reflexed, restartAtMs: restartAt }) });
    cycleStart = closeAt;
    if (k === 0 && !firstReflexed && firstCopyAfterS !== undefined) {
      cycleStart = closeAt + firstCopyAfterS * 1000;
      restartAt = cycleStart;
      events.push({ kind: 'devControl', key: 0x0e, payload: [0, 1], native: nativeMeta(cycleStart, { reflexed: true, restartAtMs: restartAt }) });
    }
  }
  return { events, expected };
}
