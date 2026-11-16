// Constantes del protocolo Yucheng YCBT, el que habla el R99 con la app Smart Health.
// Fuente: SDK del fabricante (com.yucheng.ycbtsdk) tal y como lo documenta el proyecto PulseLoop
// (https://github.com/saksham2001/PulseLoopiOS, CC BY 4.0), contrastado con un R99 real.
// Detalle byte a byte en docs/protocolo-ycbt.md.

export const YCBT_SERVICE = 'be940000-7333-be46-b7ae-689e71722bd5';
/** Canal de órdenes: se escribe aquí y aquí llegan las respuestas (write + indicate). */
export const YCBT_COMMAND_CHAR = 'be940001-7333-be46-b7ae-689e71722bd5';
/** Canal asíncrono: medidas en vivo y volcado de historial (solo indicate). */
export const YCBT_STREAM_CHAR = 'be940003-7333-be46-b7ae-689e71722bd5';

/** Byte `TYPE` de la trama: el grupo de la orden. */
export const Group = {
  /** App → anillo: reloj, perfil, monitores automáticos. */
  setting: 0x01,
  /** App → anillo: información del dispositivo. */
  get: 0x02,
  /** App → anillo: iniciar/parar medidas en vivo, buscar anillo. */
  appControl: 0x03,
  /** Anillo → app: avisos (resultado de medida, SOS…). Exigen confirmación. */
  devControl: 0x04,
  /** Ambos: consultas de historial, datos y bloque terminal. */
  health: 0x05,
  /** Anillo → app: flujo en tiempo real (FC, pasos, batería). */
  real: 0x06,
} as const;

export const GetKey = {
  deviceInfo: 0x00,
  supportFunction: 0x01,
  deviceName: 0x03,
  userConfig: 0x07,
  chipScheme: 0x1b,
} as const;

export const SettingKey = {
  time: 0x00,
  userInfo: 0x03,
  heartMonitor: 0x0c,
  bloodOxygenMonitor: 0x26,
} as const;

export const AppControlKey = {
  findDevice: 0x00,
  liveStatusPush: 0x09,
  liveMeasurement: 0x2f,
} as const;

export const DevControlKey = {
  measurementResult: 0x0e,
  measurementStatus: 0x13,
} as const;

export const RealKey = {
  status: 0x00,
  heartRate: 0x01,
  spo2: 0x02,
  vitals: 0x03,
  wearing: 0x13,
  battery: 0x15,
} as const;

/** Modo del `03 2f`: elige el sensor/LED. Un solo modo activo a la vez. */
export const MeasureMode = {
  heartRate: 0x00,
  bloodPressure: 0x01,
  spo2: 0x02,
} as const;
export type MeasureModeValue = (typeof MeasureMode)[keyof typeof MeasureMode];

export const HealthKey = {
  /** Entrante: cierra una transferencia. Saliente: ACK obligatorio. */
  terminal: 0x80,
  ackAccepted: 0x00,
  ackCrcFailure: 0x04,
} as const;

/** Un payload de 1 byte en este rango es un estado de error, no un dato. */
export const FrameStatus = {
  unsupportedCommand: 0xfb,
  unsupportedKey: 0xfc,
  length: 0xfd,
  data: 0xfe,
  crc: 0xff,
} as const;

/** Payload corto (≤ 9 bytes) con el que el anillo contesta "no hay nada almacenado de este tipo". */
export const HEALTH_NO_DATA_PAYLOAD: readonly number[] = [0x00, 0x00];

export interface HistoryType {
  readonly id: 'sport' | 'sleep' | 'heart' | 'blood' | 'all' | 'spo2';
  /** `05 <queryKey>` con payload vacío pide todo lo almacenado de este tipo. */
  readonly queryKey: number;
  /** Clave con la que vuelven las tramas de datos (distinta de la de consulta). */
  readonly ackKey: number;
  /** Tamaño fijo de registro; `null` = longitud variable (sueño). */
  readonly stride: number | null;
  readonly label: string;
}

export const HISTORY = {
  sport: { id: 'sport', queryKey: 0x02, ackKey: 0x11, stride: 14, label: 'actividad' },
  sleep: { id: 'sleep', queryKey: 0x04, ackKey: 0x13, stride: null, label: 'sueño' },
  heart: { id: 'heart', queryKey: 0x06, ackKey: 0x15, stride: 6, label: 'frecuencia cardiaca' },
  blood: { id: 'blood', queryKey: 0x08, ackKey: 0x17, stride: 8, label: 'presión arterial' },
  all: { id: 'all', queryKey: 0x09, ackKey: 0x18, stride: 20, label: 'constantes' },
  spo2: { id: 'spo2', queryKey: 0x1a, ackKey: 0x22, stride: 6, label: 'oxígeno en sangre' },
} as const satisfies Record<string, HistoryType>;

/**
 * Orden de consulta. `sport` antes que `all`: los tramos de actividad son acumulables y fijan el
 * total de un día pasado, mientras que el contador acumulado de `all` solo puede subirlo.
 */
export const HISTORY_ORDER: readonly HistoryType[] = [
  HISTORY.sport,
  HISTORY.sleep,
  HISTORY.heart,
  HISTORY.all,
  HISTORY.spo2,
];

/** Segundos entre 1970-01-01 y 2000-01-01 (época de los sellos de tiempo del anillo). */
export const RING_EPOCH_OFFSET_S = 946_684_800;
