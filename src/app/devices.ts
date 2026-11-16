import { computed } from '@preact/signals';
import { saveSettings } from './actions';
import { cancelPairing, stopScaleNow } from './scale';
import { autoHoldsRing, ringUse, settings, showToast } from './state';

// Los dispositivos que tiene la persona (el menú de dispositivos de la barra superior): un interruptor por cada uno. Apagarlo solo cambia lo que la app ofrece y a qué intenta conectarse; NO
// borra ningún dato (lo que ya se guardó del anillo sigue ahí y vuelve a verse al encenderlo) ni olvida el dispositivo emparejado.

/** ¿Tiene anillo? Sin él no se sincroniza, sus gráficas salen «no disponibles» y solo se puede entrenar andando, medido con el móvil. */
export const hasRing = computed(() => settings.value.hasRing);
/** ¿Tiene báscula? Sin ella «Pesar con la báscula» no se puede usar. */
export const hasScale = computed(() => settings.value.hasScale);

/** Lo que dicen las gráficas y tarjetas de lo que solo da el anillo cuando no se tiene. */
export const NO_RING_TEXT = 'No disponible sin anillo';

/** ¿Lo usa algo que pidió la persona (un entreno, una medida o una sincronización a mano)? La actualización automática de fondo no cuenta: se aparta sola al apagar el anillo. */
export const ringBusy = (): boolean => ringUse.value !== null && !autoHoldsRing();

export async function setHasRing(on: boolean): Promise<void> {
  // Apagarlo con el anillo en uso dejaría esa tarea a medias: se espera a que acabe.
  if (!on && ringBusy()) {
    showToast('El anillo está en uso: espera a que termine para apagarlo.');
    return;
  }
  await saveSettings({ hasRing: on });
}

export async function setHasScale(on: boolean): Promise<void> {
  if (!on) {
    // Se suelta la báscula (y un emparejado a medias) antes de apagarla: no se queda conectada en segundo plano.
    await cancelPairing().catch(() => undefined);
    await stopScaleNow().catch(() => undefined);
  }
  await saveSettings({ hasScale: on });
}
