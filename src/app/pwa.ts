import { isNative } from './native';
import { activeWorkout, autoHoldsRing, pendingWorkout, ringUse, showToast, updateReady } from './state';

/**
 * Registra el service worker (solo en producción) para que la app abra sin conexión, y avisa cuando hay una
 * versión nueva esperando. Sin service worker la app funciona igual; lo único que se pierde es abrir offline.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // En la app de Android los ficheros ya van dentro del APK: un service worker solo podría servir una versión vieja
  // guardada de antes tras actualizar. Si quedara alguno registrado, se da de baja.
  if (isNative()) {
    void navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => void r.unregister())).catch(() => undefined);
    return;
  }
  // El arranque es asíncrono (abre IndexedDB): `load` puede haberse disparado ya cuando se llega aquí.
  const register = (): void => {
    navigator.serviceWorker.register('./sw.js').then(
      (registration: ServiceWorkerRegistration | undefined) => {
        // Algunos entornos (un navegador con los service workers bloqueados) responden sin registro: no hay nada que vigilar.
        if (!registration) return;
        const track = (worker: ServiceWorker | null): void => {
          worker?.addEventListener('statechange', () => {
            // Con `controller` nulo es la primera instalación: no hay nada que "actualizar".
            if (worker.state === 'installed' && navigator.serviceWorker.controller) updateReady.value = registration;
          });
        };
        if (registration.waiting && navigator.serviceWorker.controller) updateReady.value = registration;
        track(registration.installing);
        registration.addEventListener('updatefound', () => track(registration.installing));
        // Una PWA puede quedarse abierta días en segundo plano: se busca versión nueva al volver a ella.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
        });
      },
      () => undefined,
    );
  };
  // Sin prisa: el service worker se instala cuando la página ya cargó y el móvil está libre, para que no compita con el arranque (es lo primero que tiene que ir rápido).
  const whenIdle = (): void => {
    const idle = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(register, { timeout: 4000 });
    else window.setTimeout(register, 1500);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

let reloading = false;

function updateBlocker(): string | null {
  if (activeWorkout.value) return 'Termina el entrenamiento antes de actualizar.';
  if (pendingWorkout.value) return 'Guarda o descarta el entrenamiento terminado antes de actualizar.';
  // La actualización automática no es algo que se pierda al recargar: se corta y lo leído vuelve a leerse la próxima vez.
  if (ringUse.value === 'sync' && !autoHoldsRing()) return 'Espera a que termine la sincronización antes de actualizar.';
  if (ringUse.value === 'measure') return 'Espera a que termine la medida de pulso antes de actualizar.';
  return null;
}

/**
 * Activa la versión nueva y recarga. Nunca en mitad de algo que se perdería al recargar: un entrenamiento (en curso o
 * pendiente de revisar) o una sincronización/medida con el anillo.
 */
export function applyUpdate(): void {
  const waiting = updateReady.value?.waiting;
  if (!waiting) return;
  const reason = updateBlocker();
  if (reason) {
    showToast(reason, 'error');
    return;
  }
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    },
    { once: true },
  );
  waiting.postMessage('SKIP_WAITING');
}
