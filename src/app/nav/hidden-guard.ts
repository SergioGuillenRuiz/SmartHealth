/**
 * Una señal que se activa cuando la página se oculta (la pantalla se apaga o hay otra app delante), y ya viene activada si lo está.
 *
 * Bajar y construir el mapa de una zona es trabajo pesado (decenas de MB de JSON, miles de objetos, el grafo de calles) y con la app oculta no
 * lo mira nadie: el móvil lo atiende con el WebView de segundo plano, los temporizadores espaciados y la memoria justa, y es justo lo que se
 * sospecha de cerrar la app entera con la pantalla apagada (se perdían el GPS y el pulso del entreno). Se corta al ocultarse y se retoma la próxima
 * vez que haga falta, con la app a la vista.
 */
export interface HiddenGuard {
  signal: AbortSignal;
  /** Deja de oír la visibilidad (llamar cuando el trabajo acaba, bien o mal). */
  dispose: () => void;
}

export function abortWhenHidden(): HiddenGuard {
  const controller = new AbortController();
  if (typeof document === 'undefined') return { signal: controller.signal, dispose: () => undefined };
  if (document.visibilityState === 'hidden') {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onChange = (): void => {
    if (document.visibilityState === 'hidden') controller.abort();
  };
  document.addEventListener('visibilitychange', onChange);
  return { signal: controller.signal, dispose: () => document.removeEventListener('visibilitychange', onChange) };
}
