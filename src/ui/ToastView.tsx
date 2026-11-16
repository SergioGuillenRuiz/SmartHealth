import type { JSX } from 'preact';
import { toast } from '../app/state';

/**
 * Aviso temporal (confirmaciones y errores leves). Se pinta en la app Y dentro de cada hoja o pantalla modal abierta
 * (`<dialog>`): una hoja modal está en la capa superior y deja el resto de la página inerte, así que un aviso de la app
 * quedaría tapado y, al estar inerte, tampoco lo anunciaría un lector de pantalla. Mientras haya un diálogo abierto, el
 * de la app se oculta (ver `.toast--app`) y solo se ve —y se anuncia— el del propio diálogo.
 *
 * Con varias hojas apiladas solo la de arriba lleva el texto (`muted` en las demás): su contenedor existe igualmente, vacío,
 * para que sea una región viva antes de que llegue el texto. Si la de arriba se cierra en el mismo instante en que sale el
 * aviso (guardar y cerrar), la de debajo lo recibe en un contenedor que ya existía y se anuncia.
 */
export function ToastView({ inApp = false, muted = false }: { inApp?: boolean; muted?: boolean }): JSX.Element {
  const t = toast.value;
  const classes = ['toast', t?.tone === 'error' ? 'toast--error' : '', inApp ? 'toast--app' : ''].filter(Boolean).join(' ');
  return (
    <div class={classes} role="status" aria-live="polite">
      {!muted && t?.message}
    </div>
  );
}
