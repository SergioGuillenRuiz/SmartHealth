import { AppControlKey, Group, GetKey, HealthKey, SettingKey, type HistoryType, type MeasureModeValue } from './constants';
import { msToRingSeconds } from './time';

/** Orden lógica: aún sin longitud ni CRC (los añade `buildFrame`). */
export interface Command {
  readonly group: number;
  readonly cmd: number;
  readonly payload: readonly number[];
}

const cmd = (group: number, key: number, payload: readonly number[] = []): Command => ({ group, cmd: key, payload });

const byte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** El muestreador automático del anillo rechaza intervalos inferiores a 30 min (Smart Health lo recorta igual). */
export const MIN_MONITOR_INTERVAL_MIN = 30;

export interface RingUserInfo {
  heightCm: number;
  weightKg: number;
  male: boolean;
  age: number;
}

export const Commands = {
  /**
   * `01 00` + `[año:u16][mes][día][hora][min][seg][díaSemana]`. El día de la semana va con lunes = 0 … domingo = 6
   * (en JS `getDay()` domingo = 0, de ahí el desplazamiento).
   */
  setTime(date: Date = new Date()): Command {
    const year = date.getFullYear();
    return cmd(Group.setting, SettingKey.time, [
      year & 0xff,
      (year >> 8) & 0xff,
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      (date.getDay() + 6) % 7,
    ]);
  },

  /** Las etiquetas de 2 bytes de los `Get` son cosmetic: el firmware las ignora, pero se conservan las de la app oficial. */
  getDeviceInfo: (): Command => cmd(Group.get, GetKey.deviceInfo, [0x47, 0x43]),
  getSupportFunction: (): Command => cmd(Group.get, GetKey.supportFunction, [0x47, 0x46]),
  getDeviceName: (): Command => cmd(Group.get, GetKey.deviceName, [0x47, 0x50]),

  /**
   * `01 03` + `[altura cm][peso kg][sexo][edad]`. El anillo lo usa en sus propios algoritmos de pasos/calorías.
   * La polaridad del byte de sexo (1 = hombre) es la convención del fabricante, pero no está verificada en hardware.
   */
  setUserInfo(info: RingUserInfo): Command {
    return cmd(Group.setting, SettingKey.userInfo, [byte(info.heightCm), byte(info.weightKg), info.male ? 1 : 0, byte(info.age)]);
  },

  /** `01 0c {activar, intervaloMin}`: medición automática de FC entre sincronizaciones. */
  setHeartMonitor: (enabled: boolean, intervalMin: number): Command =>
    cmd(Group.setting, SettingKey.heartMonitor, [enabled ? 1 : 0, clampInterval(intervalMin)]),

  /** `01 26 {activar, intervaloMin}`: medición automática de SpO₂. */
  setBloodOxygenMonitor: (enabled: boolean, intervalMin: number): Command =>
    cmd(Group.setting, SettingKey.bloodOxygenMonitor, [enabled ? 1 : 0, clampInterval(intervalMin)]),

  /** `03 09`: el anillo empuja `06 00` (pasos del día) de forma continua mientras haya conexión. */
  setLiveStatus: (enabled: boolean): Command => cmd(Group.appControl, AppControlKey.liveStatusPush, [enabled ? 1 : 0, 0x00, 0x02]),

  /**
   * `03 2f {activar, modo}`. La orden de PARADA repite el modo de la de inicio: parar un SpO₂ con modo 0
   * le diría al anillo que pare la FC y dejaría el barrido de SpO₂ en marcha.
   */
  startMeasurement: (mode: MeasureModeValue): Command => cmd(Group.appControl, AppControlKey.liveMeasurement, [1, mode]),
  stopMeasurement: (mode: MeasureModeValue): Command => cmd(Group.appControl, AppControlKey.liveMeasurement, [0, mode]),

  /** `03 00 {1,5,2}`: hace vibrar el anillo. Los tres argumentos son los que envía el botón de la app oficial (sin verificar). */
  findDevice: (): Command => cmd(Group.appControl, AppControlKey.findDevice, [0x01, 0x05, 0x02]),

  /** `05 <clave>` sin payload: "dame todo lo que tengas de este tipo". No hay cursor ni rango de fechas. */
  historyRequest: (type: HistoryType): Command => cmd(Group.health, type.queryKey),

  /** `05 80 {estado}`: confirmación obligatoria de fin de bloque. Sin ella el anillo no libera el siguiente tipo. */
  historyAck: (status: number): Command => cmd(Group.health, HealthKey.terminal, [status]),

  /** `04 <clave> {00}`: los avisos del anillo se reenvían hasta que la app los confirma. */
  pushAck: (key: number): Command => cmd(Group.devControl, key, [0x00]),
} as const;

function clampInterval(minutes: number): number {
  if (!(minutes > 0)) return 60;
  return byte(Math.max(MIN_MONITOR_INTERVAL_MIN, minutes));
}

export { msToRingSeconds };

/** `05 40…4E` borran el historial del anillo: no existe ninguna orden legítima de esta app en ese rango. */
export const isDestructiveCommand = (command: Pick<Command, 'group' | 'cmd'>): boolean =>
  command.group === Group.health && command.cmd >= 0x40 && command.cmd <= 0x4e;
