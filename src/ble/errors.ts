export type RingErrorCode =
  /** La conexión se cerró (fuera de alcance, anillo apagado, usuario…). */
  | 'link-closed'
  /** El anillo no contestó a tiempo a una orden imprescindible. */
  | 'timeout'
  /** El anillo contesta, pero no habla YCBT (otro firmware o protocolo). */
  | 'protocol'
  /** El anillo rechazó explícitamente la orden (p. ej. sensor ausente). */
  | 'refused'
  /** Falló el envío de una orden aunque el enlace sigue abierto (error GATT puntual). */
  | 'write-failed'
  /** La operación se canceló desde la app. */
  | 'aborted'
  /** El navegador/plataforma no puede usar Bluetooth. */
  | 'unsupported-platform'
  /** El usuario cerró el selector sin elegir anillo. */
  | 'no-device'
  /** Falló la conexión GATT (rango, anillo ocupado con otra app, permisos). */
  | 'connect-failed';

export class RingError extends Error {
  constructor(
    message: string,
    readonly code: RingErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RingError';
  }
}
