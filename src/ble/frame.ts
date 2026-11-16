import { concat, u16, u8, type Bytes } from './bytes';
import { crc16 } from './crc';
import { FrameStatus, Group } from './constants';

/**
 * Trama YCBT: `[TYPE:1][CMD:1][LEN:2 LE][PAYLOAD:N][CRC16:2 LE]`.
 * `LEN` es la longitud TOTAL de la trama (cabecera + payload + CRC), no la del payload.
 */
export interface Frame {
  readonly group: number;
  readonly cmd: number;
  readonly payload: Bytes;
  /** `false` si el CRC no cuadra. Se conserva la trama: la integridad real del historial la da el CRC del bloque terminal. */
  readonly crcOk: boolean;
}

const HEADER = 4;
const CRC_LEN = 2;
export const MIN_FRAME = HEADER + CRC_LEN;
/** Ninguna trama real se acerca a esto; una longitud mayor indica que estamos desalineados. */
export const MAX_FRAME = 1024;

export function buildFrame(group: number, cmd: number, payload: ArrayLike<number> = []): Bytes {
  const total = payload.length + MIN_FRAME;
  if (total > 0xffff) throw new RangeError('Trama demasiado larga');
  const out = new Uint8Array(total);
  out[0] = group;
  out[1] = cmd;
  out[2] = total & 0xff;
  out[3] = (total >> 8) & 0xff;
  out.set(payload as ArrayLike<number>, HEADER);
  const crc = crc16(out.subarray(0, total - CRC_LEN));
  out[total - 2] = crc & 0xff;
  out[total - 1] = (crc >> 8) & 0xff;
  return out;
}

/** Interpreta una trama completa. Devuelve `null` si la longitud declarada no coincide con la real. */
export function parseFrame(bytes: Bytes): Frame | null {
  if (bytes.length < MIN_FRAME) return null;
  if (u16(bytes, 2) !== bytes.length) return null;
  const given = u16(bytes, bytes.length - CRC_LEN);
  return {
    group: u8(bytes, 0),
    cmd: u8(bytes, 1),
    payload: bytes.slice(HEADER, bytes.length - CRC_LEN),
    crcOk: crc16(bytes.subarray(0, bytes.length - CRC_LEN)) === given,
  };
}

/** `0xFB..0xFF` en un payload de 1 byte es un estado de error, no un dato. Se comprueba ANTES de leer offsets. */
export function frameErrorOf(frame: Pick<Frame, 'payload'>): number | null {
  if (frame.payload.length !== 1) return null;
  const v = u8(frame.payload, 0);
  return v >= FrameStatus.unsupportedCommand ? v : null;
}

/** El anillo avisa así de que NUNCA responderá a esta clave en este firmware. */
export function isPermanentError(status: number): boolean {
  return status === FrameStatus.unsupportedCommand || status === FrameStatus.unsupportedKey;
}

/**
 * Reensambla notificaciones GATT en tramas lógicas. Una trama más larga que `MTU-3` llega en varias
 * notificaciones, y varias tramas cortas pueden llegar en una sola; por eso la delimitación sale del
 * campo de longitud y nunca de los límites de la notificación.
 *
 * Solo emite tramas con CRC válido (el anillo real las envía siempre así). Ante basura —la cola
 * truncada de una trama tras una desconexión, o una cabecera falsa— se resincroniza descartando un
 * byte cada vez hasta encontrar una trama completa y válida, para que un solo byte malo no
 * envenene el resto de la sesión.
 */
export class FrameAssembler {
  private pending = new Map<string, Bytes>();
  /** Bytes descartados al resincronizar; útil en el registro de diagnóstico. */
  droppedBytes = 0;

  reset(): void {
    this.pending.clear();
    this.droppedBytes = 0;
  }

  /**
   * @param channel Los dos canales (órdenes y flujo) se intercalan; un fragmento de uno jamás se
   *                concatena con el otro.
   */
  push(channel: string, chunk: Bytes): Bytes[] {
    const buffer = concat(this.pending.get(channel) ?? new Uint8Array(), chunk);
    const frames: Bytes[] = [];
    let start = 0;
    while (buffer.length - start >= HEADER) {
      const declared = declaredLength(buffer, start);
      if (declared === null) {
        start += 1; // no puede ser el inicio de una trama
        this.droppedBytes += 1;
        continue;
      }
      if (buffer.length - start >= declared) {
        if (hasValidCrc(buffer, start, declared)) {
          frames.push(buffer.slice(start, start + declared));
          start += declared;
        } else {
          start += 1; // longitud verosímil pero CRC erróneo: desalineados
          this.droppedBytes += 1;
        }
        continue;
      }
      // Trama incompleta. Si dentro de lo recibido ya hay una trama válida, la candidata era falsa.
      const inner = findValidFrame(buffer, start + 1);
      if (inner === -1) break; // plausible: esperar al resto
      this.droppedBytes += inner - start;
      start = inner;
    }
    this.pending.set(channel, buffer.slice(start));
    return frames;
  }
}

/** Longitud declarada si la cabecera en `at` es verosímil; `null` si no. */
function declaredLength(buffer: Bytes, at: number): number | null {
  const group = u8(buffer, at);
  const declared = u16(buffer, at + 2);
  const plausible =
    group >= Group.setting && group <= Group.real && declared >= MIN_FRAME && declared <= MAX_FRAME;
  return plausible ? declared : null;
}

function hasValidCrc(buffer: Bytes, at: number, length: number): boolean {
  const given = u16(buffer, at + length - CRC_LEN);
  return crc16(buffer.subarray(at, at + length - CRC_LEN)) === given;
}

/** Primer desplazamiento ≥ `from` con una trama completa y de CRC válido, o -1. */
function findValidFrame(buffer: Bytes, from: number): number {
  for (let at = from; buffer.length - at >= MIN_FRAME; at++) {
    const declared = declaredLength(buffer, at);
    if (declared !== null && buffer.length - at >= declared && hasValidCrc(buffer, at, declared)) {
      return at;
    }
  }
  return -1;
}
