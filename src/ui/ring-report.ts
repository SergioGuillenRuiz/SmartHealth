import type { SyncReport } from '../sync/run-sync';
import { NBSP } from './format';

/** Una sincronización que pasa de esto enseña dónde se fue el tiempo: lo normal con el anillo real son 9–13 s, y si es más, ver qué parte lo causa es lo que permite arreglarlo. */
export const SLOW_SYNC_MS = 6000;

const PHASE_NAME: Record<SyncReport['phases'][number]['stage'], string> = {
  connecting: 'conexión',
  handshake: 'saludo',
  configuring: 'ajuste',
  steps: 'pasos',
  history: 'historial',
  saving: 'guardado',
  done: 'fin',
  closing: 'cierre',
};

/** «conexión 2,4 s · saludo 0,5 s · pasos 3,1 s…»: lo que duró cada parte, en el orden en que ocurrieron. */
export function phaseText(phases: SyncReport['phases']): string {
  return phases.map((phase) => `${PHASE_NAME[phase.stage]} ${(phase.ms / 1000).toFixed(1).replace('.', ',')}${NBSP}s`).join(' · ');
}
