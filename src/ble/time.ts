import { RING_EPOCH_OFFSET_S } from './constants';

// El anillo no tiene noción de zona horaria: su reloj se ajusta con campos de hora local y avanza en
// hora local. Un sello del anillo son, por tanto, "segundos de pared desde 2000-01-01".
// Para recuperar el instante real hay que leer esos segundos como campos de pared UTC y
// reinterpretarlos en la zona local de ESA fecha (así el horario de verano se resuelve bien
// para un sello suelto: una lectura de pulso, el inicio de un tramo).
//
// Lo que NO sale bien es convertir por separado los dos extremos de algo que dura (una sesión de sueño, un tramo de
// actividad) cuando el cambio de hora cae en medio: el reloj del anillo no salta, así que la duración es la de sus
// segundos, y las demás horas del registro se miden desde su inicio (ver `decodeSleep` y `decodeSport`).

/** Segundos del anillo → milisegundos desde la época Unix. */
export function ringSecondsToMs(seconds: number): number {
  const wall = new Date((seconds + RING_EPOCH_OFFSET_S) * 1000);
  return new Date(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
  ).getTime();
}

/** Inverso de {@link ringSecondsToMs}. */
export function msToRingSeconds(ms: number): number {
  const d = new Date(ms);
  const wallMs = Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
  return Math.floor(wallMs / 1000) - RING_EPOCH_OFFSET_S;
}
