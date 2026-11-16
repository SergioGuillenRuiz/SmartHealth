import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { dataVersion } from '../app/state';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
}

/**
 * Carga asíncrona ligada a dependencias. Recarga cuando cambian `deps` o cuando cambian los datos guardados
 * (`dataVersion`). Conserva el dato anterior mientras recarga, para que la pantalla no parpadee, y descarta
 * respuestas que llegan tarde de una petición ya superada.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, loading: true, error: null });
  const version = dataVersion.value; // suscribe el componente a los cambios de datos
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ data: s.data, loading: true, error: null }));
    loadRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState({ data: undefined, loading: false, error });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);

  return state;
}

/** Anchura observada de un elemento (para gráficos que ocupan todo el ancho). */
export function useWidth<T extends HTMLElement>(fallback = 320): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  // La función ha de ser la MISMA en cada render: si cambiara, Preact la volvería a llamar tras cada renderizado (cada movimiento
  // del dedo sobre un gráfico), y cada vez se descartaría el observador, se crearía otro y se mediría el elemento a la fuerza.
  const ref = useCallback(
    (el: T | null): void => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      setWidth(Math.max(1, Math.round(el.getBoundingClientRect().width)) || fallback);
      observer.current = new ResizeObserver(([entry]) => {
        const w = Math.round(entry?.contentRect.width ?? 0);
        if (w > 0) setWidth(w);
      });
      observer.current.observe(el);
    },
    [fallback],
  );
  return [ref, width];
}

/**
 * Pasa a `true` cuando `active` lleva `delayMs` encendido. Para confirmaciones que aparecen justo donde acaba de estar
 * el botón que las pidió: un doble toque no debe confirmar (y menos descartar) algo sin querer.
 */
export function useArmed(active: boolean, delayMs = 700): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!active) return undefined;
    const timer = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return armed;
}
