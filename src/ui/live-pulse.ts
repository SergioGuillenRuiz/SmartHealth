import type { RecorderSnapshot } from '../sync/workout-recorder';
import { fmtDuration } from './format';

/**
 * La línea bajo el pulso de la pantalla en vivo. Estos anillos dan el pulso en ráfagas, al cierre de cada medida (cada 20–40 s), así que
 * «Esperando lectura» solo es cierto antes de la primera: si ya hubo alguna, se dice cuánto hace de ella en lugar de volver a decir que el sensor
 * está calentando (el sensor sigue midiendo; lo que falta es una lectura nueva).
 */
export function pulseCaption(snap: Pick<RecorderSnapshot, 'bpm' | 'zone' | 'lastPulse'>): string {
  if (snap.zone) return `Zona ${snap.zone.index} · ${snap.zone.name}`;
  if (snap.bpm !== null) return 'Por debajo de la zona 1';
  if (snap.lastPulse === null) return 'Esperando lectura: el sensor tarda ~30 s en dar el primero';
  const seconds = Math.round(snap.lastPulse.ageMs / 1000);
  const ago = seconds < 60 ? `${seconds} s` : fmtDuration(seconds);
  return `Sin lectura nueva desde hace ${ago} · última: ${snap.lastPulse.bpm} lpm`;
}
