import { Haptics } from '@capacitor/haptics';
import { isNative } from '../app/native';

/** Avisos al cuerpo: la persona camina o está quieta y puede no estar mirando la pantalla. */
export type Cue = 'attention' | 'go' | 'done';

/** Vibración y pausa alternadas (ms), empezando por vibración. */
const PATTERN: Record<Cue, number[]> = { attention: [250], go: [600], done: [180, 140, 180, 140, 180] };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Hace vibrar el móvil. Nunca falla ni espera: es un aviso, no parte de la prueba. */
export function vibrateCue(cue: Cue): void {
  const pattern = PATTERN[cue];
  if (!isNative()) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* sin vibración en este navegador */
    }
    return;
  }
  void (async () => {
    for (let i = 0; i < pattern.length; i += 2) {
      await Haptics.vibrate({ duration: pattern[i] as number });
      const gap = pattern[i + 1];
      if (gap !== undefined) await pause(gap + (pattern[i] as number));
    }
  })().catch(() => undefined);
}
