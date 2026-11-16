import type { Store } from '../data/types';

// La versión WEB para betatesters es la MISMA app compilada con `vite build --mode beta` y servida desde el PC de quien la ofrece (`beta-web/`): se abre en el navegador del móvil, se puede instalar
// como app desde él (PWA) y arranca como la demostración (anillo y báscula simulados, ~4 meses de historia de ejemplo) pero, a diferencia de ella, es una app de verdad: lo que la persona
// anota se queda en SU móvil (la demostración se reinicia en cada arranque; aquí los datos nunca pasan por el servidor), el GPS, la cámara, los mapas y las fotos de los productos son los
// reales (el navegador los pide con su permiso; necesitan HTTPS).

/** `true` en la compilación web para betatesters. */
export const isBeta = (): boolean => import.meta.env.MODE === 'beta';

/** Dónde se apunta que los datos de ejemplo ya se sembraron (fuera de la base: «Borrar todo» no debe traerlos de vuelta). */
export const BETA_SEED_KEY = 'smartring.beta.seeded.v1';

type Memory = Pick<Storage, 'getItem' | 'setItem'>;

/** El almacenamiento del navegador si se puede usar (puede faltar o fallar: ventana privada, datos bloqueados). */
export function betaMemory(): Memory | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * ¿Hay que sembrar los datos de ejemplo? Solo la primera vez: si ya se sembraron (la marca existe) o la base ya tiene perfil (alguien la usó), no, para no pisar lo que la persona ha
 * anotado. Si la marca no se puede leer pero hay perfil, tampoco.
 */
export async function shouldSeedBeta(store: Pick<Store, 'getProfileHistory'>, memory: Memory | null): Promise<boolean> {
  try {
    if (memory?.getItem(BETA_SEED_KEY)) return false;
  } catch {
    /* sin marca: se decide por la base */
  }
  return (await store.getProfileHistory()).length === 0;
}

/** Apunta que los datos de ejemplo ya están (si no se puede, la base con perfil basta para no repetirlo). */
export function markBetaSeeded(memory: Memory | null): void {
  try {
    memory?.setItem(BETA_SEED_KEY, '1');
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}
