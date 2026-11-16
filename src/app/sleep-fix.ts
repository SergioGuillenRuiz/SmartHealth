import { correctedNight } from '../domain/sleep-correction';
import { bumpData, showToast } from './state';
import { svc } from './services';

/**
 * Guarda las horas que la persona pone a una noche (la que estaba estimada): una sesión normal, sin fases y marcada `manual`. Si el anillo da luego esa noche, la sustituye (el almacén
 * cambia una sesión cubierta al menos al 50 % por otra del lote). `false` si las horas no valen.
 */
export async function saveSleepCorrection(wakeDayMs: number, bed: string, wake: string): Promise<boolean> {
  const night = correctedNight(wakeDayMs, bed, wake);
  if (night === null) {
    showToast('Esas horas no cuadran: una noche dura entre media hora y 20 horas.', 'error');
    return false;
  }
  await svc().store.ingest({ buckets: [], counters: [], heart: [], spo2: [], sleep: [{ startMs: night.startMs, endMs: night.endMs, segments: [], manual: true }], dropped: {} });
  bumpData();
  showToast('Hora de dormir corregida.');
  return true;
}
