import type { ReconnectOptions } from '../ble/transport';

/**
 * Cuánto espera una conexión automática a que el anillo conteste. Con el anillo cerca conecta en ~2,5 s: más tiempo solo
 * sirve para que un anillo fuera de alcance mantenga la radio del móvil ocupada, y para que quien pida el anillo (una
 * sincronización, una medida, un entreno) espere a que ese intento acabe.
 */
export const AUTO_CONNECT_TIMEOUT_MS = 8_000;

/**
 * Cómo se reconecta sin que nadie lo haya pedido (la actualización automática): sin diálogos del sistema ni permisos que
 * preguntar, un solo intento corto, y cancelable. Si algo no está a mano, falla en silencio y se vuelve a intentar más tarde.
 */
export function autoReconnectOptions(signal?: AbortSignal): ReconnectOptions {
  return { silent: true, attempts: 1, timeoutMs: AUTO_CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}) };
}
