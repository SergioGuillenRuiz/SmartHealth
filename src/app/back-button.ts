import { App } from '@capacitor/app';
import { isNative } from './native';

/**
 * La hoja de arriba de las abiertas: la última que se abrió (`Sheet` anota su orden en `data-opened`). Las hojas pueden
 * apilarse y su orden en el documento no es el de apertura (la del anillo, que cuelga de la raíz, se puede abrir encima de un
 * apartado del menú de perfil); a igualdad de orden, o sin anotarlo, vale la última del documento.
 */
export function topDialog<T extends { dataset: { opened?: string | undefined } }>(open: readonly T[]): T | undefined {
  const order = (dialog: T): number => Number(dialog.dataset.opened ?? 0);
  return [...open].sort((a, b) => order(a) - order(b)).at(-1);
}

/**
 * El botón «atrás» de Android: cierra la hoja abierta (respetando las que no se pueden cerrar, igual que Esc) y, si no hay
 * ninguna, pasa la app a segundo plano en vez de cerrarla: puede haber un entrenamiento o una medida en curso.
 */
export function installBackButton(): void {
  if (!isNative()) return;
  void App.addListener('backButton', () => {
    const top = topDialog([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')]);
    if (top) {
      // Mismo camino que Esc: `cancel` (una hoja no cerrable lo impide) y, si nadie lo impide, se cierra.
      if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
      return;
    }
    void App.minimizeApp();
  });
}
