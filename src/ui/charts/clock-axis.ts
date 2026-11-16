import { fmtMinutesOfDay } from '../format';
import type { RangeAxis } from './RangeChart';

// El eje de la ventana de sueño. El reloj es un círculo y hay que cortarlo por algún sitio para dibujar las noches como barras: se corta
// por el rato del día en que NUNCA se duerme (en quien duerme de noche, por la tarde; en quien duerme de día, de madrugada), no por una hora
// fija. Con un corte fijo a las 18:00, quien se levanta pasadas las 18:00 tenía las barras del revés y fuera del gráfico.

const DAY = 1440;

/** Una noche: cuándo se acuesta y cuándo despierta, en minutos desde medianoche. */
export interface SleepWindow {
  bedMin: number;
  wakeMin: number;
}

/** Lo que dura una ventana (si la hora de despertar es «anterior» a la de acostarse, cruza la medianoche). */
export const windowLength = (w: SleepWindow): number => (((w.wakeMin - w.bedMin) % DAY) + DAY) % DAY;

/**
 * Dónde empieza el eje (minutos del día): en medio del rato más largo en que nunca se duerme, en una hora par si cabe una dentro (para que las
 * marcas del eje caigan en horas redondas). Sin ningún hueco (se duerme a todas horas), las 18:00 de siempre.
 */
export function clockCut(windows: readonly SleepWindow[]): number {
  const slept = new Uint8Array(DAY);
  for (const w of windows) {
    const bed = ((Math.round(w.bedMin) % DAY) + DAY) % DAY;
    for (let k = 0; k < windowLength(w); k++) slept[(bed + k) % DAY] = 1;
  }
  // El rato más largo sin dormir, dando la vuelta al día.
  let best = { start: -1, length: 0 };
  for (let start = 0; start < DAY; start++) {
    if (slept[start] || slept[(start + DAY - 1) % DAY] === 0) continue; // solo se mira desde donde empieza un hueco
    let length = 0;
    while (length < DAY && !slept[(start + length) % DAY]) length++;
    if (length > best.length) best = { start, length };
  }
  if (best.length === 0) return 18 * 60;
  const middle = best.start + best.length / 2;
  // Las horas pares (cada 120 min) que caen dentro del hueco; la más cercana al medio.
  let cut = Math.round(middle) % DAY;
  let nearest = Infinity;
  for (let step = Math.ceil(best.start / 120) * 120; step <= best.start + best.length; step += 120) {
    const distance = Math.abs(step - middle);
    if (distance < nearest) {
      nearest = distance;
      cut = step % DAY;
    }
  }
  return cut;
}

/** Los extremos de una ventana en el eje que empieza en `cut`: la barra siempre va hacia delante (la de despertar es mayor que la de acostarse). */
export function clockSpan(w: SleepWindow, cut: number): { from: number; to: number } {
  const from = (((w.bedMin - cut) % DAY) + DAY) % DAY;
  return { from, to: from + windowLength(w) };
}

/** El eje de la ventana de sueño con el corte dado: marcas cada 2 h, con la hora del reloj. */
export function clockAxis(cut: number): RangeAxis {
  return {
    position: (value) => value,
    label: (position) => fmtMinutesOfDay(position + cut),
    domain: (lows, highs) => {
      const lo = Math.max(0, Math.floor((Math.min(...lows, DAY) - 30) / 120) * 120);
      const hi = Math.ceil((Math.max(...highs, 0) + 30) / 120) * 120;
      return [lo, Math.max(hi, lo + 240)];
    },
    step: 120,
    empty: 'Sueño',
  };
}
