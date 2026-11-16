import { Component, type ComponentChildren, type JSX } from 'preact';
import { useState } from 'preact/hooks';

/** Nombre de la base de datos local según cómo se abrió la app (la demostración tiene la suya). */
export const storeNameFor = (search: string): string => (new URLSearchParams(search).has('demo') ? 'smartring-demo' : 'smartring');

/**
 * Borra la base de datos local entera. No pasa por la app (puede ser justo lo que está roto) sino por el propio navegador.
 * Si hay otra conexión abierta, el borrado queda pendiente y se completa al recargar: no se espera más.
 */
export function deleteLocalData(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Qué ha pasado, dicho de la forma más completa que se pueda: lo que no es un `Error` (un evento, un texto vacío, un objeto) también sale. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  if (error === null || error === undefined) return `Sin información del error (${String(error)})`;
  if (typeof error === 'object') {
    const { name, message, type } = error as { name?: unknown; message?: unknown; type?: unknown };
    const parts = [name, message, type].filter((part) => typeof part === 'string' && part !== '');
    if (parts.length > 0) return parts.join(': ');
    try {
      return `${Object.prototype.toString.call(error)} ${JSON.stringify(error)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error) || 'Error sin texto';
}

const stackOf = (error: unknown): string => [describeError(error).split('\n').slice(0, 7).join('\n'), '', navigator.userAgent].join('\n');

const RETRY_KEY = 'smartring.bootRetry';

/**
 * Un fallo al ARRANCAR suele ser pasajero (la primera visita en un móvil lento, la base de datos que tarda en abrirse): se recarga UNA vez sola antes de enseñar el error, para que la persona
 * no tenga que pulsar «Volver a intentarlo». Devuelve `true` si ha recargado. Si falla otra vez, sale la pantalla de error de siempre.
 */
export function retryBootOnce(): boolean {
  try {
    if (sessionStorage.getItem(RETRY_KEY) !== null) return false;
    sessionStorage.setItem(RETRY_KEY, '1');
    location.reload();
    return true;
  } catch {
    return false;
  }
}

/** Arrancó bien: el próximo fallo de arranque (otro día) vuelve a tener su reintento automático. */
export function bootSucceeded(): void {
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(RETRY_KEY);
    } catch {
      /* sin sessionStorage no hay reintento que limpiar */
    }
  }, 15_000);
}

/**
 * Lo que se ve cuando la app no puede seguir: al arrancar (unos datos guardados que la rompen) o más tarde (una pantalla
 * que falla al pintarse). Sin esto el único remedio sería borrar los datos desde los Ajustes de Android; así se puede
 * reintentar y, si sigue fallando, empezar de cero (con la confirmación que merece algo que no se puede deshacer).
 */
export function FatalScreen({ error, dbName }: { error: unknown; dbName: string }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const wipe = async (): Promise<void> => {
    setBusy(true);
    await deleteLocalData(dbName);
    location.reload();
  };
  return (
    <main class="fatal">
      <h1>La app no puede seguir</h1>
      <p>
        Ha ocurrido un error inesperado. Tus datos siguen guardados en este móvil: prueba a volver a abrir la app.
      </p>
      <button type="button" class="btn btn--primary btn--block" onClick={() => location.reload()}>
        Volver a intentarlo
      </button>

      <h2>Si sigue fallando</h2>
      {confirming ? (
        <div>
          <p>
            Se borrarán <strong>todos los datos guardados en este móvil</strong> (actividad, sueño, pulso, entrenamientos, perfil y ajustes) y se olvidará el anillo. El anillo conserva su propio historial reciente, y si tienes una copia exportada podrás importarla después. <strong>No se puede deshacer.</strong>
          </p>
          <div class="btn-row">
            <button type="button" class="btn btn--danger" disabled={busy} onClick={() => void wipe()}>
              Sí, borrar todo
            </button>
            <button type="button" class="btn" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" class="btn btn--block" onClick={() => setConfirming(true)}>
          Borrar los datos de la app y empezar de cero
        </button>
      )}

      <details class="fatal__details">
        <summary>Detalles técnicos (para quien tenga que arreglarlo)</summary>
        <pre tabIndex={0} data-selectable>
          {stackOf(error)}
        </pre>
      </details>
    </main>
  );
}

interface BoundaryProps {
  dbName: string;
  children?: ComponentChildren;
}

/** Recoge lo que falle al pintar cualquier pantalla y enseña `FatalScreen` en vez de dejar la app a medias. */
export class ErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static override getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('Error desconocido') };
  }

  override render(): ComponentChildren {
    return this.state.error !== null ? <FatalScreen error={this.state.error} dbName={this.props.dbName} /> : this.props.children;
  }
}
