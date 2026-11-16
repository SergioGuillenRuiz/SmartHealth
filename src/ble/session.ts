import { concatAll, toHex, u16, u32, u8, type Bytes } from './bytes';
import { Commands, isDestructiveCommand, type Command } from './commands';
import { crc16 } from './crc';
import {
  DevControlKey,
  Group,
  HealthKey,
  HISTORY_ORDER,
  MeasureMode,
  RealKey,
  type HistoryType,
} from './constants';
import { DiagnosticLog } from './diag';
import { DEFAULT_HR_STREAM_AFTER_MS, DEFAULT_HR_WARMUP_MS, HrCycle, medianBpm, spreadBpm, type HrSample } from './hr-cycle';
import { RingError } from './errors';
import { buildFrame, FrameAssembler, frameErrorOf, isPermanentError, parseFrame, type Frame } from './frame';
import { decodeInto, emptyHistory, type HistoryRecords } from './records';
import { parseSupportFunction, withBaseline, type Capability } from './support';
import type { Channel, ChunkMeta, RingLink } from './transport';

/** Lo que se sabe del anillo tras abrir la sesión. */
export interface RingInfo {
  name: string;
  /** "principal.sub" con el sub rellenado a dos cifras (2.32). */
  firmware: string | null;
  batteryPercent: number | null;
  /** Funciones del anillo: las básicas de la familia más las que declara en `02 01`; `null` si no contestó. */
  capabilities: Set<Capability> | null;
}

export interface LiveStatus {
  /** Pasos acumulados del día. */
  steps: number;
  /** Distancia que calcula el anillo (m, sin verificar). */
  distanceM: number;
  /** Calorías según el anillo (unidad sin verificar). */
  calories: number;
}

type LiveBody =
  | { kind: 'heartRate'; bpm: number }
  | { kind: 'spo2'; percent: number }
  /** El anillo dio por terminada una medida puntual por su cuenta (`04 0e`): `success` = lectura obtenida. */
  | { kind: 'measurementEnd'; mode: number; success: boolean }
  | { kind: 'status'; status: LiveStatus }
  | { kind: 'battery'; percent: number; charging: boolean };

/**
 * Lo que el lado nativo de la app de Android añade a un evento (ver `ChunkMeta`); sin él —navegador, pruebas— no hay nada de esto y la hora
 * es la de procesarlo. Con la pantalla apagada el WebView puede procesar un evento mucho después de que el anillo lo mandara.
 */
export interface LiveStamp {
  /** Cuándo llegó el evento (ms, reloj de pared del móvil). */
  tsMs?: number;
  /** El reflejo nativo ya atendió el evento: no hay que confirmarlo ni volver a pedir nada por él. */
  reflexed?: boolean;
  /** Cuándo pidió el reflejo nativo la última medida de pulso (0: nunca). */
  restartAtMs?: number;
}

export type LiveEvent = LiveBody & LiveStamp;

export type TransferStatus =
  /** Datos recibidos, verificados y decodificados. */
  | 'ok'
  /** El anillo no tiene nada almacenado de este tipo. */
  | 'empty'
  /** El firmware no implementa este tipo (0xFB/0xFC): el sensor no existe en este modelo. */
  | 'unsupported'
  /** El anillo dejó de responder. No se confirmó nada. */
  | 'timeout'
  /** El CRC o las cuentas no cuadran incluso tras reintentar. */
  | 'corrupt'
  | 'error';

export interface TypeOutcome {
  type: HistoryType['id'];
  status: TransferStatus;
  bytes: number;
  ms: number;
  detail?: string;
}

export interface HistoryResult {
  records: HistoryRecords;
  outcomes: TypeOutcome[];
  /** `true` si la conexión se perdió a mitad: `records` conserva lo ya recibido y verificado. */
  interrupted: boolean;
}

export interface HistoryProgress {
  type: HistoryType;
  index: number;
  total: number;
  /** `true` al empezar el tipo, `false` al terminarlo. */
  starting: boolean;
}

export interface Timeouts {
  /** Respuesta a una orden normal. */
  reply: number;
  /** Cabecera tras una consulta de historial. */
  header: number;
  /** Silencio máximo entre tramas de una transferencia. */
  idle: number;
  /** Primer envío de pasos (`06 00`) tras activar el empuje: el R99 real tarda ~2,3–2,9 s en mandarlo. */
  status: number;
}

const DEFAULT_TIMEOUTS: Timeouts = { reply: 4000, header: 6000, idle: 10_000, status: 6000 };

/**
 * Espera a la cabecera de la consulta dedicada de oxígeno (`05 1a`). El R99 real NO la contesta nunca (sus lecturas de
 * oxígeno vienen en las constantes, `05 09`), mientras que el resto de consultas las contesta en ~0,1–0,3 s (las órdenes más lentas,
 * en ~0,6 s): esperar los 6 s generales solo alarga cada sincronización, y con 1,2 s hay el doble de margen sobre lo más lento medido.
 * Si el anillo contestara más tarde, no se pierde nada: ese silencio no se avisa mientras las constantes hayan llegado (`isExpectedSilence`).
 */
const SPO2_HEADER_MS = 1200;

/** Pulso en directo: sin ninguna lectura en este tiempo se entiende que el anillo dejó de medir y se vuelve a pedir. */
const SILENCE_RESTART_MS = 25_000;
/** Un cierre de la medida que llega tan pegado al reinicio es el mismo reenviado, no el de la medida nueva. */
const DUPLICATE_END_MS = 1000;
/** Un evento que llega con más retraso que esto (ms) es de cuando la web estaba parada: no despierta nada que dependa del reloj. */
const STALE_EVENT_MS = 3000;
/**
 * Si entre dos señales de vida de la medida de pulso (una comprobación o un evento del anillo) pasa más que esto, la web estuvo parada (pantalla
 * apagada, app oculta): lo que el anillo mandó entonces está por procesarse y el «silencio» que se ve no es real. Con la web viva hay una
 * señal cada pocos segundos (el aviso nativo cada 2 s, las tramas cada segundo, el vigilante cada 5 s).
 */
const STALL_GAP_MS = 7000;
/**
 * Mientras se procesan eventos atrasados, y tras detectar una parada, tampoco actúan los comprobadores de silencio durante este margen (ms). Tiene que
 * cubrir TODO el hueco que `STALL_GAP_MS` deja sin detectar: un hueco de hasta 7 s entre dos lotes de lo atrasado no cuenta como parada, y si el margen fuera
 * menor (antes, 4 s) los huecos de 4 a 7 s dejaban pasar un silencio falso que reabría la medida y descartaba el resto. De ahí 1 s más que el hueco.
 */
const DRAIN_GRACE_MS = STALL_GAP_MS + 1000;
const WAKE_GRACE_MS = STALL_GAP_MS + 1000;
/**
 * Un cierre de la medida que no atendió el reflejo nativo y llega con más retraso que esto salió cuando la web ya llevaba parada lo bastante
 * (`RingKeeper.STALL_MS`, 7 s) para que el reflejo confirmara las copias que reenvía el anillo y volviera a pedir la medida: la web no repite esa orden
 * (si nadie la pidió, el silencio lo detecta enseguida).
 */
const REFLEX_COVERS_MS = 8000;
/** Si el anillo rechaza reabrir la medida (aún cerrando la anterior), cuánto se espera para volver a intentarlo y cuántas veces seguidas. */
const RESTART_RETRY_MS = 1500;
const MAX_RESTART_RETRIES = 4;

/**
 * Cuántos bytes en bruto de cada tipo de historial se guardan en el diagnóstico: el sueño entero (su formato es el menos
 * verificado) y, de los demás, una muestra con la que comprobar el formato sin tener el anillo delante.
 */
export const RAW_SLEEP_BYTES = 8192;
export const RAW_SAMPLE_BYTES = 512;

/** Tope del buffer de una transferencia: protege de un flujo desincronizado que nunca termina. */
const BUFFER_CAP = 256 * 1024;
/**
 * Lo máximo que se acepta de una transferencia aunque su cabecera anuncie más: la cabecera la escribe el otro extremo (un
 * anillo estropeado, o algo que se hace pasar por él), y un tamaño de 4 GB no puede dejar de limitar la memoria. Un año de
 * historial ocupa unas decenas de KB.
 */
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;
/** Una transferencia real dura segundos: si pasa de esto, el otro lado manda tramas sin parar y no hay que esperarlo. */
const MAX_TRANSFER_MS = 90_000;
/** Tramas de la consulta de historial que nadie ha leído todavía: sobre este número se tiran las más viejas. */
const MAX_QUEUED_FRAMES = 256;

interface Waiter {
  resolve: (frame: Frame | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Cola de tramas del grupo Health con espera acotada. */
class FrameQueue {
  private items: Frame[] = [];
  private waiter: { resolve: (f: Frame | null) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: Error | null = null;

  push(frame: Frame): void {
    if (this.waiter) {
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve(frame);
    } else {
      this.items.push(frame);
      // Solo se vacía al pedir un historial: sin tope, un otro extremo que no para de mandar tramas llenaría la memoria.
      if (this.items.length > MAX_QUEUED_FRAMES) this.items.shift();
    }
  }

  next(timeoutMs: number): Promise<Frame | null> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.items.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  clear(): void {
    this.items = [];
  }

  fail(error: Error): void {
    this.failure = error;
    if (this.waiter) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(error);
    }
  }
}

const replyKey = (group: number, cmd: number): string => `${group}:${cmd}`;

/** Decodifica la respuesta de `02 00`: firmware en [3].[2] y batería en [5]. */
export function parseDeviceInfo(payload: Bytes): { firmware: string | null; batteryPercent: number | null } {
  const firmware = payload.length >= 4 ? `${u8(payload, 3)}.${String(u8(payload, 2)).padStart(2, '0')}` : null;
  const battery = payload.length >= 6 ? u8(payload, 5) : null;
  return { firmware, batteryPercent: battery !== null && battery <= 100 ? battery : null };
}

/**
 * ¿Aceptó el anillo una orden de medida? Solo un estado de 1 byte distinto de 0 (o un error FB–FF) es un rechazo; una
 * respuesta con otra forma se toma como aceptada (es lo que hace PulseLoop con anillos reales de esta familia).
 */
const isStatusOk = (frame: Frame | null): boolean =>
  frame !== null && frameErrorOf(frame) === null && (frame.payload.length !== 1 || u8(frame.payload, 0) === 0);

/**
 * Sesión YCBT sobre un anillo ya conectado. Encapsula todo lo delicado del protocolo:
 *
 * - petición/respuesta con espera acotada (el waiter se registra ANTES de escribir, porque la
 *   respuesta puede llegar antes de que la escritura GATT devuelva el control);
 * - escrituras en serie (Android admite una sola operación GATT pendiente);
 * - confirmación obligatoria de los avisos del anillo (los reenvía hasta recibirla);
 * - transferencias de historial: cabecera → tramas → bloque terminal → ACK, con verificación de CRC.
 */
export class YcbtSession {
  readonly log: DiagnosticLog;
  readonly info: RingInfo;
  /** Última lectura de `06 00` (pasos del día), si el anillo la ha enviado. */
  lastStatus: LiveStatus | null = null;

  private readonly timeouts: Timeouts;
  private readonly hrWarmupMs: number;
  private readonly hrStreamAfterMs: number;
  private readonly hrRetryMs: number;
  private readonly assembler = new FrameAssembler();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly healthQueue = new FrameQueue();
  private readonly liveListeners = new Set<(event: LiveEvent) => void>();
  private readonly cleanup: Array<() => void> = [];
  /** Comprobaciones que no pueden depender de un temporizador (ver `poke`). */
  private readonly pokes = new Set<() => void>();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private measuring: number | null = null;
  private markClosed: () => void = () => undefined;
  /** Se resuelve cuando la sesión se cierra (por nuestra parte o porque el enlace cayó). */
  private readonly maxTransferBytes: number;
  private readonly maxTransferMs: number;
  private readonly whenClosed = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  constructor(
    private readonly link: RingLink,
    options: {
      log?: DiagnosticLog;
      timeouts?: Partial<Timeouts>;
      /** Calentamiento del sensor de pulso (ms) y tiempo sin cierre tras el que se entiende que emite en continuo; inyectables para las pruebas. */
      hrWarmupMs?: number;
      hrStreamAfterMs?: number;
      /** Espera antes de reintentar reabrir la medida de pulso si el anillo la rechaza; inyectable para las pruebas. */
      hrRetryMs?: number;
      /** Topes de una transferencia de historial (bytes y ms); inyectables para las pruebas. */
      maxTransferBytes?: number;
      maxTransferMs?: number;
    } = {},
  ) {
    this.maxTransferBytes = options.maxTransferBytes ?? MAX_TRANSFER_BYTES;
    this.maxTransferMs = options.maxTransferMs ?? MAX_TRANSFER_MS;
    this.log = options.log ?? new DiagnosticLog();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.hrWarmupMs = options.hrWarmupMs ?? DEFAULT_HR_WARMUP_MS;
    this.hrStreamAfterMs = options.hrStreamAfterMs ?? DEFAULT_HR_STREAM_AFTER_MS;
    this.hrRetryMs = options.hrRetryMs ?? RESTART_RETRY_MS;
    this.info = { name: link.name, firmware: null, batteryPercent: null, capabilities: null };
    this.cleanup.push(link.onData((channel, chunk, meta) => this.onChunk(channel, chunk, meta)));
    this.cleanup.push(link.onDisconnect(() => this.onDisconnect()));
    if (!link.connected) this.onDisconnect();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // ───────────────────────────── ciclo de vida ─────────────────────────────

  /**
   * Handshake. Primero una orden barata que demuestra que el anillo habla YCBT; después el reloj
   * (antes de leer historial: lo almacenado se sella con el reloj propio del anillo), la información
   * del dispositivo y el mapa de capacidades.
   */
  async open(now: Date = new Date()): Promise<RingInfo> {
    let name = await this.request(Commands.getDeviceName(), this.timeouts.reply);
    if (!name) name = await this.request(Commands.getDeviceName(), this.timeouts.reply * 2);
    if (!name) {
      throw new RingError('El anillo no responde al protocolo de Smart Health (YCBT).', 'protocol');
    }
    if (name.payload.length > 0 && frameErrorOf(name) === null) {
      const text = new TextDecoder().decode(name.payload).replace(/\0+$/g, '').trim();
      if (text) this.log.info(`nombre almacenado: ${text}`);
    }

    await this.request(Commands.setTime(now), this.timeouts.reply);

    const info = await this.request(Commands.getDeviceInfo(), this.timeouts.reply);
    if (info && frameErrorOf(info) === null) {
      const parsed = parseDeviceInfo(info.payload);
      this.info.firmware = parsed.firmware;
      this.info.batteryPercent = parsed.batteryPercent;
    }

    const support = await this.request(Commands.getSupportFunction(), this.timeouts.reply);
    if (support && frameErrorOf(support) === null) {
      const declared = parseSupportFunction(support.payload);
      // Las funciones básicas se dan por hechas (ver `BASELINE_CAPABILITIES`); el bitmap añade las opcionales.
      this.info.capabilities = withBaseline(declared);
      this.log.info(`capacidades declaradas: ${[...declared].join(', ') || '(ninguna)'}; efectivas: ${[...this.info.capabilities].join(', ')}`);
    }
    return this.info;
  }

  /** Cierra todo y suelta la conexión GATT. Para una medida en curso si la hubiera. */
  async close(): Promise<void> {
    if (this.measuring !== null && !this.closed) {
      const mode = this.measuring;
      this.measuring = null;
      try {
        await this.request(Commands.stopMeasurement(mode as 0 | 1 | 2), 1500);
      } catch {
        /* la desconexión limpia la medida de todos modos */
      }
    }
    this.shutdown(new RingError('Sesión cerrada.', 'aborted'));
    await this.link.disconnect();
  }

  // ───────────────────────────── configuración ─────────────────────────────

  /**
   * Perfil del usuario y medición automática. Un monitor que el modelo no implementa responde 0xFC;
   * es inofensivo y se registra, no se trata como error.
   */
  async configure(config: {
    user: { heightCm: number; weightKg: number; male: boolean; age: number };
    heartIntervalMin: number;
    spo2IntervalMin: number;
  }): Promise<void> {
    await this.request(Commands.setUserInfo(config.user), this.timeouts.reply);
    const caps = this.info.capabilities;
    if (!caps || caps.has('heartRate')) {
      await this.request(Commands.setHeartMonitor(true, config.heartIntervalMin), this.timeouts.reply);
    }
    if (!caps || caps.has('spo2')) {
      await this.request(Commands.setBloodOxygenMonitor(true, config.spo2IntervalMin), this.timeouts.reply);
    }
  }

  /** Pide los pasos del día en curso. Activa el empuje de `06 00` y espera la primera trama. */
  async readLiveStatus(timeoutMs: number = this.timeouts.status): Promise<LiveStatus | null> {
    const waitForStatus = new Promise<LiveStatus | null>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.onLive((event) => {
        if (event.kind === 'status') {
          clearTimeout(timer);
          off();
          resolve(event.status);
        }
      });
      // Si la sesión se cierra mientras se espera (se cancela la lectura o cae el enlace), no hay nada más que esperar: sin esto
      // quien cancelaba tenía que aguardar a que venciera el tiempo (varios segundos) para que el anillo se soltara.
      void this.whenClosed.then(() => {
        clearTimeout(timer);
        off();
        resolve(null);
      });
    });
    await this.request(Commands.setLiveStatus(true), this.timeouts.reply);
    const status = await waitForStatus;
    // Se deja de empujar: no hace falta mientras no haya una sesión abierta que lo consuma.
    if (!this.closed) await this.request(Commands.setLiveStatus(false), 1500).catch(() => null);
    return status;
  }

  // ───────────────────────────── historial ─────────────────────────────

  async syncHistory(
    types: readonly HistoryType[] = HISTORY_ORDER,
    onProgress?: (progress: HistoryProgress) => void,
  ): Promise<HistoryResult> {
    const records = emptyHistory();
    const outcomes: TypeOutcome[] = [];
    let interrupted = false;
    for (const [index, type] of types.entries()) {
      onProgress?.({ type, index, total: types.length, starting: true });
      let outcome: TypeOutcome;
      try {
        outcome = await this.fetchHistory(type, records);
      } catch (error) {
        // Una conexión perdida a mitad no debe tirar lo ya verificado de los tipos anteriores.
        if (error instanceof RingError && error.code === 'link-closed') {
          outcomes.push({ type: type.id, status: 'error', bytes: 0, ms: 0, detail: 'conexión perdida' });
          interrupted = true;
          break;
        }
        if (error instanceof RingError && error.code === 'write-failed') {
          // El enlace sigue abierto: este tipo no se pudo pedir, pero los demás pueden leerse.
          this.log.warn(`${type.label}: ${error.message}`);
          outcomes.push({ type: type.id, status: 'error', bytes: 0, ms: 0, detail: 'no se pudo enviar la orden' });
          onProgress?.({ type, index, total: types.length, starting: false });
          continue;
        }
        throw error;
      }
      outcomes.push(outcome);
      this.log.info(`${type.label}: ${outcome.status} (${outcome.bytes} B, ${outcome.ms} ms)${outcome.detail ? ` — ${outcome.detail}` : ''}`);
      onProgress?.({ type, index, total: types.length, starting: false });
    }
    return { records, outcomes, interrupted };
  }

  private async fetchHistory(type: HistoryType, into: HistoryRecords): Promise<TypeOutcome> {
    const started = Date.now();
    const finish = (status: TransferStatus, bytes = 0, detail?: string): TypeOutcome => {
      const outcome: TypeOutcome = { type: type.id, status, bytes, ms: Date.now() - started };
      if (detail !== undefined) outcome.detail = detail;
      return outcome;
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      this.healthQueue.clear();
      await this.send(Commands.historyRequest(type));
      const transfer = await this.receiveTransfer(type);
      if (transfer.buffer && transfer.buffer.length > 0) this.pinRaw(type, transfer.buffer);
      if (transfer.status === 'corrupt' && attempt === 1) {
        this.log.warn(`${type.label}: transferencia corrupta, se reintenta una vez (${transfer.detail ?? ''})`);
        continue;
      }
      if (transfer.status === 'ok' && transfer.buffer) {
        const summary = decodeInto(type, transfer.buffer, into);
        for (const note of summary.notes) this.log.warn(note);
        return finish('ok', transfer.buffer.length, `${summary.records} registro(s)`);
      }
      return finish(transfer.status, transfer.buffer?.length ?? 0, transfer.detail);
    }
    return finish('corrupt');
  }

  /**
   * Guarda en el diagnóstico los bytes reensamblados de un tipo de historial: el sueño entero (su formato no está verificado
   * con un R99) y, de los demás, una muestra para comprobar que el formato coincide. Con eso se puede decodificar o ajustar
   * un formato sin tener el anillo delante.
   */
  private pinRaw(type: HistoryType, buffer: Bytes): void {
    const limit = type.id === 'sleep' ? RAW_SLEEP_BYTES : RAW_SAMPLE_BYTES;
    const shown = buffer.subarray(0, limit);
    const lines: string[] = [];
    for (let at = 0; at < shown.length; at += 32) lines.push(`${at.toString(16).padStart(4, '0')}: ${toHex(shown.subarray(at, at + 32), ' ')}`);
    const cut = buffer.length > limit ? `; se muestran ${limit}` : '';
    this.log.pin(`${type.label}: buffer reensamblado (${buffer.length} B${cut})`, lines);
  }

  private async receiveTransfer(type: HistoryType): Promise<{ status: TransferStatus; buffer?: Bytes; detail?: string }> {
    // 1) Cabecera. Tramas que no sean la cabecera de ESTE tipo (restos de un tipo anterior) se ignoran.
    let header: Frame | null = null;
    const headerWaitMs = type.id === 'spo2' ? Math.min(this.timeouts.header, SPO2_HEADER_MS) : this.timeouts.header;
    for (let guard = 0; guard < 8; guard++) {
      header = await this.healthQueue.next(headerWaitMs);
      if (!header) return { status: 'timeout', detail: 'sin cabecera' };
      if (header.cmd === type.queryKey) break;
      this.log.warn(`trama ajena mientras se espera la cabecera de ${type.label}: 05 ${header.cmd.toString(16).padStart(2, '0')}`);
      header = null;
    }
    if (!header) return { status: 'timeout', detail: 'solo tramas ajenas' };

    const error = frameErrorOf(header);
    if (error !== null) {
      return { status: isPermanentError(error) ? 'unsupported' : 'error', detail: `estado 0x${error.toString(16)}` };
    }
    // Un payload de ≤ 9 bytes es la respuesta "no hay nada almacenado": no hay transferencia que confirmar.
    if (header.payload.length < 10) return { status: 'empty' };

    const expectedPackets = u32(header.payload, 2);
    const expectedBytes = u32(header.payload, 6);
    const chunks: Bytes[] = [];
    let received = 0;
    const limitBytes = Math.min(Math.max(BUFFER_CAP, expectedBytes), this.maxTransferBytes);
    const deadline = Date.now() + this.maxTransferMs;

    // 2) Tramas de datos hasta el bloque terminal. Se concatenan: un registro puede cruzar dos tramas.
    for (;;) {
      const frame = await this.healthQueue.next(this.timeouts.idle);
      if (!frame) return { status: 'timeout', detail: `silencio con ${received}/${expectedBytes} B` };
      // El silencio de `idle` no basta: un otro extremo que manda una trama de vez en cuando no terminaría nunca.
      if (Date.now() > deadline) return { status: 'timeout', detail: `la transferencia no acaba (${received}/${expectedBytes} B tras ${Math.round(this.maxTransferMs / 1000)} s)` };

      const err = frameErrorOf(frame);
      if (err !== null) return { status: isPermanentError(err) ? 'unsupported' : 'error', detail: `estado 0x${err.toString(16)}` };

      if (frame.cmd === type.ackKey) {
        if (received + frame.payload.length > limitBytes) {
          return { status: 'error', detail: 'el buffer supera el tope' };
        }
        chunks.push(frame.payload);
        received += frame.payload.length;
        continue;
      }

      if (frame.cmd === HealthKey.terminal) {
        // Un terminal sin datos previos es de un tipo anterior que llega tarde: no es nuestro.
        if (received === 0 && expectedBytes > 0) {
          this.log.warn('bloque terminal tardío de otro tipo; se ignora');
          continue;
        }
        if (frame.payload.length < 6) return { status: 'error', detail: 'terminal corto' };
        const buffer = concatAll(chunks);
        const packets = u16(frame.payload, 0);
        const bytes = u16(frame.payload, 2);
        const crcGiven = u16(frame.payload, 4);
        const crcOk = crc16(buffer) === crcGiven;
        // El CRC del bloque es la garantía de integridad (cubre tramas perdidas); las cuentas solo avisan.
        if (crcOk && (packets !== (expectedPackets & 0xffff) || bytes !== (buffer.length & 0xffff))) {
          this.log.warn(`cuentas distintas con CRC válido: paquetes ${packets}/${expectedPackets & 0xffff}, bytes ${bytes}/${buffer.length & 0xffff}`);
        }
        // El ACK va ANTES de decodificar: el anillo no libera el siguiente tipo sin él. Si no se puede enviar, el bloque
        // (verificado por CRC) no se tira: el siguiente envío fallará por sí solo y se contará como conexión perdida.
        await this.acknowledge(crcOk ? HealthKey.ackAccepted : HealthKey.ackCrcFailure);
        if (!crcOk) {
          return { status: 'corrupt', buffer, detail: `CRC ${crcGiven.toString(16)} ≠ ${crc16(buffer).toString(16)}` };
        }
        return { status: 'ok', buffer };
      }
      // Otra clave del grupo Health: no es de este tipo.
    }
  }

  /**
   * Confirma al anillo el bloque recibido. Un fallo de escritura aislado (el enlace sigue vivo) se reintenta UNA vez: sin el
   * ACK el anillo no libera el siguiente tipo y cada uno de los que faltan agotaría su tiempo de espera. Si el enlace se
   * cerró no hay nada que reintentar. Nunca lanza: el bloque ya está verificado y no se tira por no poder confirmarlo.
   */
  private async acknowledge(status: number): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.send(Commands.historyAck(status));
        return;
      } catch (error) {
        const retry = attempt === 1 && error instanceof RingError && error.code === 'write-failed';
        this.log.warn(`no se pudo confirmar el bloque al anillo${retry ? ' (se reintenta)' : ''}: ${error instanceof Error ? error.message : String(error)}`);
        if (!retry) return;
      }
    }
  }

  // ───────────────────────────── medidas en vivo ─────────────────────────────

  onLive(listener: (event: LiveEvent) => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  /**
   * Medida puntual de pulso. El anillo da un eco del último valor guardado, calla, mantiene una meseta sin converger
   * y a los ~26 s da lecturas reales; a los ~35 s cierra él mismo la medida con `04 0e` (ver `hr-cycle.ts`). Por eso
   * se espera su veredicto —no una racha de valores parecidos, que la meseta también produce— y se devuelve la
   * última lectura posterior al calentamiento. Si el anillo da la medida por fallida, o nunca la
   * cierra, no se inventa un valor: `null`. Con `signal` se puede cancelar (también devuelve `null`). Si el enlace cae
   * antes de que haya veredicto, lanza `link-closed`: no es lo mismo que «el anillo no obtuvo lectura».
   */
  async measureHeartRate(options: { timeoutMs?: number; signal?: AbortSignal; onSample?: (bpm: number) => void } = {}): Promise<number | null> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const cycle = new HrCycle(Date.now(), this.hrWarmupMs);
    let verdict: { success: boolean } | null = null;
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (settle = resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => settle();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const off = this.onLive((event) => {
      if (event.kind === 'measurementEnd' && event.mode === MeasureMode.heartRate) {
        verdict ??= { success: event.success }; // un cierre repetido (el anillo reenvía hasta que se confirma) no cambia nada
        settle();
        return;
      }
      if (event.kind !== 'heartRate' || !isPlausibleBpm(event.bpm)) return;
      const ts = Date.now();
      cycle.add(event.bpm, ts);
      // Solo se enseña lo posterior al calentamiento: antes es el eco del último valor guardado y una meseta.
      if (cycle.isReliable(ts)) options.onSample?.(event.bpm);
    });

    try {
      await this.startMeasurementOrThrow(MeasureMode.heartRate);
      if (options.signal?.aborted) return null;
      await Promise.race([done, this.whenClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      off();
      await this.stopMeasurement(MeasureMode.heartRate);
    }

    if (options.signal?.aborted) return null;
    const outcome = verdict as { success: boolean } | null;
    if (outcome) {
      if (!outcome.success) {
        this.log.warn('el anillo dio la medida por fallida o cancelada (04 0e)');
        return null;
      }
      // La última lectura: es la que el anillo da por buena y la que guarda en su propio historial (la devolverá en la
      // próxima sincronización), así lo que se ve ahora coincide con lo que quedará guardado.
      return cycle.atVerdict().at(-1)?.bpm ?? null;
    }
    if (this.closed) throw new RingError('Se perdió la conexión con el anillo antes de terminar la medida.', 'link-closed');
    // Sin veredicto (tiempo máximo): solo vale una racha estable posterior al calentamiento.
    const tail = cycle.reliable().slice(-3);
    if (tail.length === 3 && spreadBpm(tail) <= 6) return medianBpm(tail);
    this.log.warn('medida sin veredicto del anillo ni racha estable posterior al calentamiento: se descarta');
    return null;
  }

  /**
   * Pulso continuo para una sesión deportiva. Estos anillos cierran SOLOS cada medida (~35 s), así que se vuelve a
   * pedir tras cada cierre, y de cada ciclo solo se entrega lo fiable (posterior al calentamiento) cuando el anillo da
   * su veredicto. Si pasa más de un minuto sin cierre se entiende que emite en continuo y se entregan las lecturas
   * conforme llegan. Devuelve la función que lo detiene. Los temporizadores se paran también si la sesión se cierra
   * por su cuenta (enlace perdido), aunque nadie llame a esa función.
   */
  async startLiveHeartRate(onSample: (bpm: number, tsMs: number) => void): Promise<() => Promise<void>> {
    let active = true;
    let streaming = false;
    let cycle = new HrCycle(Date.now(), this.hrWarmupMs);
    let lastSampleAt = Date.now();
    let restarts = 0;
    let restartedAt = 0;
    let retries = 0;
    /** Cuándo toca reintentar una reapertura que el anillo rechazó (`0`: nada pendiente). */
    let retryDueAt = 0;
    /** Hasta cuándo se están procesando eventos atrasados (la web estuvo parada): los comprobadores de silencio no actúan entonces. */
    let drainingUntil = 0;
    /** Cuándo corrió por última vez algo de esta medida (una comprobación o un evento del anillo): un hueco grande es que la web estuvo parada. */
    let lastAliveAt = Date.now();
    /** El último margen que se dio para lo atrasado pasó sin que llegara ningún evento (no había nada atrasado): otra parada no merece otro margen. */
    let emptyWait = false;
    /** El anillo cerró la medida y aún no hay señal de que nadie la reabriera (ni lecturas nuevas ni petición del reflejo nativo). */
    let awaitingRestart = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const keeper = this.link.keeper;
    const stopTimers = (): void => {
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      this.pokes.delete(check);
      // El reflejo nativo solo vale mientras dura este pulso en vivo (si el enlace cayó, nativo ya lo desarma solo).
      void keeper?.disarm().catch(() => undefined);
    };
    const emit = (samples: readonly HrSample[]): void => {
      for (const sample of samples) onSample(sample.bpm, sample.tsMs);
    };
    const scheduleRetry = (): void => {
      if (retries >= MAX_RESTART_RETRIES) return; // el vigilante de silencio sigue ahí
      retries++;
      retryDueAt = Date.now() + this.hrRetryMs;
      clearTimeout(retryTimer);
      // El temporizador puede dispararse un milisegundo antes de la hora marcada: entonces `check` no vería «ya toca» y el reintento esperaría al vigilante.
      retryTimer = setTimeout(() => {
        if (retryDueAt > 0) retryDueAt = Math.min(retryDueAt, Date.now());
        check();
      }, this.hrRetryMs);
    };
    const requestStart = (): void => {
      // Se espera la respuesta (sin bloquear): si no, llegaría como «respuesta sin petición pendiente» y se confundiría con
      // otra app hablando con el anillo. Si el anillo la rechaza (aún cerrando la anterior) se reintenta enseguida en vez de esperar
      // 25 s de silencio con el sensor apagado.
      void this.request(Commands.startMeasurement(MeasureMode.heartRate), this.timeouts.reply).then(
        (reply) => {
          if (!active || this.closed) return;
          if (reply && !isStatusOk(reply)) {
            this.log.warn('pulso en vivo: el anillo rechazó reabrir la medida; se reintenta');
            scheduleRetry();
          } else {
            retries = 0;
          }
        },
        () => undefined, // el enlace cayó: lo recoge la sesión
      );
    };
    /**
     * Empieza un ciclo de medida. Normalmente lo pide esta sesión (`send`) y el ciclo empieza ahora; si lo pidió ya el reflejo nativo (la web
     * estaba parada), solo se anota cuándo empezó (`at`, la hora de nativo) y no se manda nada.
     */
    const beginCycle = (why: string, at: number = Date.now(), send = true): void => {
      if (!active || this.closed) return;
      restarts++;
      restartedAt = at;
      retryDueAt = 0;
      awaitingRestart = false;
      this.log.info(`pulso en vivo: ${why}; nuevo ciclo (${restarts})`);
      cycle = new HrCycle(at, this.hrWarmupMs);
      lastSampleAt = Math.max(lastSampleAt, at);
      streaming = false;
      if (send) requestStart();
    };
    /**
     * Anota que la web corre ahora. Si viene de una parada larga (pantalla apagada, app oculta), lo que el anillo mandó entonces está por
     * procesarse —en el orden que sea: este aviso puede llegar antes que lo atrasado— y el silencio que se ve no es real: se da un margen
     * antes de reabrir la medida. Reabrirla ahora reiniciaría el sensor y descartaría esas lecturas, que son de un ciclo anterior al nuevo.
     * Si el margen anterior pasó sin que llegara nada, no había nada atrasado que esperar (temporizadores muy espaciados, no una parada): no se
     * vuelve a dar hasta que haya movimiento, para que un anillo callado no aplace sin fin la reapertura.
     */
    const noteAlive = (now: number, isEvent: boolean): void => {
      if (isEvent) emptyWait = false;
      if (now - lastAliveAt > STALL_GAP_MS && !emptyWait) {
        drainingUntil = Math.max(drainingUntil, now + WAKE_GRACE_MS);
        emptyWait = !isEvent;
        this.log.info(`pulso en vivo: la web estuvo parada ${Math.round((now - lastAliveAt) / 1000)} s; se espera a lo que el anillo mandó entonces`);
      }
      lastAliveAt = now;
    };
    // Lo que no puede depender de un temporizador: con la app oculta el WebView los espacia hasta un minuto, y el anillo se quedaba
    // con el sensor apagado todo ese rato. Se comprueba con cada trama del anillo, con cada aviso nativo del servicio de entreno y
    // al volver a verse la app (`poke`), además de con el vigilante de siempre.
    const check = (): void => {
      if (!active || this.closed) return;
      const now = Date.now();
      noteAlive(now, false);
      if (now < drainingUntil) return; // se están procesando eventos de cuando la web estaba parada: el silencio que se ve no es de ahora
      if (retryDueAt > 0 && now >= retryDueAt) beginCycle('reintento tras un rechazo');
      else if (awaitingRestart) beginCycle('el anillo cerró la medida y nadie la reabrió');
      else if (retryDueAt === 0 && now - lastSampleAt > SILENCE_RESTART_MS) beginCycle(`silencio de ${Math.round((now - lastSampleAt) / 1000)} s`);
    };

    const off = this.onLive((event) => {
      // La hora del evento es la de cuando el anillo lo mandó (la que anotó el lado nativo), no la de procesarlo: con la pantalla apagada
      // el WebView puede tardar minutos, y las lecturas del calentamiento pasarían por buenas si se les pusiera la hora de ahora.
      const now = Date.now();
      const ts = event.tsMs ?? now;
      const lagMs = now - ts;
      noteAlive(now, true);
      if (lagMs > STALE_EVENT_MS) drainingUntil = Math.max(drainingUntil, now + DRAIN_GRACE_MS);
      if (event.kind === 'heartRate' && isPlausibleBpm(event.bpm)) {
        // El reflejo nativo pidió una medida nueva sin que la web se enterase (el anillo calló y la volvió a pedir él): el ciclo empieza ahí.
        // «Estrictamente antes»: una petición del reflejo a la misma hora que la lectura es la que provocó el cierre que viene en el MISMO fragmento (el reflejo les pone a
        // las dos tramas la misma hora de petición), y empezar ahí un ciclo nuevo haría caer ese cierre como copia y perder lo leído.
        const nativeRestart = event.restartAtMs ?? 0;
        if (nativeRestart > cycle.startedMs && nativeRestart < ts) beginCycle('el reflejo nativo pidió la medida', nativeRestart, false);
        lastSampleAt = Math.max(lastSampleAt, ts); // lo atrasado puede llegar con horas anteriores a la de un reinicio ya hecho: la última lectura no retrocede
        retries = 0;
        awaitingRestart = false; // hay lecturas: la medida está abierta
        cycle.add(event.bpm, ts);
        if (!streaming && ts - cycle.startedMs > this.hrStreamAfterMs) {
          streaming = true; // el anillo no cierra la medida: emite en continuo
          emit(cycle.reliable());
        } else if (streaming && cycle.isReliable(ts)) {
          onSample(event.bpm, ts);
        }
      } else if (event.kind === 'measurementEnd' && event.mode === MeasureMode.heartRate) {
        // El anillo reenvía el cierre hasta que se confirma (y se confirma al instante): uno que llega pegado al reinicio es el mismo.
        if (ts - restartedAt < DUPLICATE_END_MS) return;
        if (event.success && !streaming) {
          const delivered = cycle.atVerdict();
          this.log.info(`pulso en vivo: el anillo cerró la medida a los ${Math.round((ts - cycle.startedMs) / 1000)} s con ${cycle.count} lecturas; se entregan ${delivered.length}`);
          emit(delivered);
        } else if (!event.success) this.log.warn('pulso en vivo: el anillo dio la medida por fallida o cancelada (04 0e)');
        if (event.reflexed) {
          // La web estaba parada y el reflejo nativo ya confirmó el cierre y volvió a pedir la medida: el ciclo nuevo empezó cuando él la pidió.
          beginCycle('el anillo cerró la medida (atendido por el reflejo nativo)', event.restartAtMs || ts, false);
        } else if (lagMs > REFLEX_COVERS_MS) {
          // Un cierre de cuando la web estaba parada, que el reflejo no vio pasar (llegó antes de darla por parada): las copias que reenvió el anillo
          // y el silencio ya los atendió él, así que aquí solo se anota cuándo se cerró. Pedir ahora la medida reiniciaría el sensor que el reflejo ya
          // reabrió; si lo atrasado que sigue no muestra que alguien la reabriera (lecturas nuevas o una petición del reflejo), la pide la comprobación
          // de después, ya con todo lo atrasado procesado.
          beginCycle('el anillo cerró la medida mientras la web estaba parada', ts, false);
          awaitingRestart = true;
        } else {
          // Sin esperar a ningún temporizador: ahora mismo, que es cuando la app puede estar oculta y con los temporizadores parados.
          beginCycle('el anillo cerró la medida');
        }
      }
    });
    try {
      await this.startMeasurementOrThrow(MeasureMode.heartRate);
    } catch (error) {
      // Si el anillo rechaza la medida no debe quedar un oyente vivo que la reinicie con un `04 0e` perdido.
      active = false;
      off();
      stopTimers();
      throw error;
    }
    cycle = new HrCycle(Date.now(), this.hrWarmupMs);
    lastSampleAt = Date.now();
    lastAliveAt = lastSampleAt;
    // Red de seguridad por si el anillo deja de emitir sin avisar.
    watchdog = setInterval(check, 5000);
    this.pokes.add(check);
    if (this.closed) stopTimers();
    else {
      this.cleanup.push(stopTimers);
      // El reflejo nativo (solo en la app de Android) se arma con la misma trama con la que esta sesión pide el pulso.
      const start = Commands.startMeasurement(MeasureMode.heartRate);
      void keeper?.arm(buildFrame(start.group, start.cmd, start.payload)).catch(() => undefined);
    }
    return async () => {
      active = false;
      stopTimers();
      off();
      await this.stopMeasurement(MeasureMode.heartRate);
    };
  }

  /**
   * Despierta lo que la sesión espera por temporizador (reabrir la medida de pulso si el anillo calló o la rechazó). Con la app oculta
   * el WebView espacia los temporizadores; quien oye otro reloj (el aviso nativo del servicio del entreno, la app que vuelve a verse)
   * lo llama para que no se pierda ese tiempo. También se llama solo con cada trama que llega del anillo.
   */
  poke(): void {
    if (this.closed) return;
    for (const check of [...this.pokes]) check();
  }


  /** Activa el empuje de pasos del día (`06 00`) para sesiones deportivas. */
  async enableLiveStatus(enabled: boolean): Promise<void> {
    await this.request(Commands.setLiveStatus(enabled), this.timeouts.reply);
  }

  async findRing(): Promise<void> {
    await this.request(Commands.findDevice(), this.timeouts.reply);
  }

  private async startMeasurementOrThrow(mode: 0 | 1 | 2): Promise<void> {
    // Se marca ANTES de esperar la respuesta: si se cancela o se cierra la sesión mientras tanto (hasta unos segundos con
    // un anillo que no contesta), `close()` debe mandar la orden de parar, porque el sensor pudo arrancar aunque su
    // respuesta no llegue. Solo se deshace si la orden no llegó a darse (rechazada o sin poder enviarse).
    this.measuring = mode;
    try {
      const reply = await this.request(Commands.startMeasurement(mode), this.timeouts.reply);
      if (reply && !isStatusOk(reply)) {
        throw new RingError('El anillo ha rechazado la medida (¿sensor no disponible?).', 'refused');
      }
    } catch (error) {
      if (this.measuring === mode) this.measuring = null;
      throw error;
    }
  }

  private async stopMeasurement(mode: 0 | 1 | 2): Promise<void> {
    if (this.closed || this.measuring === null) return;
    this.measuring = null;
    await this.request(Commands.stopMeasurement(mode), 2000).catch(() => null);
  }

  // ───────────────────────────── transporte ─────────────────────────────

  /** Escribe en serie: Android permite una única operación GATT pendiente y Web Bluetooth lanza si hay otra. */
  private send(command: Command): Promise<void> {
    // Red de seguridad: `05 40…4E` BORRAN el historial del anillo. La app solo lee; ninguna orden suya llega a ese
    // rango, pero que una errata futura no pueda destruir datos que no se pueden recuperar.
    if (isDestructiveCommand(command)) throw new RingError('Orden de borrado bloqueada: esta app solo lee del anillo.', 'protocol');
    const bytes = buildFrame(command.group, command.cmd, command.payload);
    const run = async (): Promise<void> => {
      if (this.closed) throw new RingError('La conexión con el anillo está cerrada.', 'link-closed');
      this.log.add('tx', undefined, bytes);
      try {
        await this.link.write(bytes);
      } catch (error) {
        // Una escritura que falla porque el enlace cayó es una conexión perdida, no un error desconocido.
        if (this.closed || !this.link.connected) {
          throw new RingError('Se perdió la conexión con el anillo.', 'link-closed', { cause: error });
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new RingError(`No se pudo enviar la orden al anillo (${detail}).`, 'write-failed', { cause: error });
      }
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  /**
   * Envía una orden y espera su respuesta (misma pareja grupo/clave). Devuelve `null` si no llega a
   * tiempo: la mayoría de órdenes no son críticas y la sesión continúa.
   */
  private request(command: Command, timeoutMs: number): Promise<Frame | null> {
    if (this.closed) return Promise.reject(new RingError('La conexión con el anillo está cerrada.', 'link-closed'));
    const key = replyKey(command.group, command.cmd);
    return new Promise<Frame | null>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter);
          this.log.warn(`sin respuesta a ${key} en ${timeoutMs} ms`);
          resolve(null);
        }, timeoutMs),
      };
      const list = this.waiters.get(key) ?? [];
      list.push(waiter);
      this.waiters.set(key, list);
      this.send(command).catch((error: unknown) => {
        clearTimeout(waiter.timer);
        this.removeWaiter(key, waiter);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const list = this.waiters.get(key);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(key);
  }

  /** Lo que el lado nativo sabe del fragmento que se está procesando (hora de recepción, si ya se atendió…). */
  private chunkMeta: ChunkMeta | undefined;

  private onChunk(channel: Channel, chunk: Bytes, meta?: ChunkMeta): void {
    this.chunkMeta = meta;
    try {
      for (const raw of this.assembler.push(channel, chunk)) {
        const frame = parseFrame(raw);
        if (!frame || !frame.crcOk) continue;
        this.log.add('rx', undefined, raw);
        this.dispatch(frame);
      }
    } finally {
      this.chunkMeta = undefined;
    }
  }

  private dispatch(frame: Frame): void {
    this.route(frame);
    // Después de tratar la trama (una lectura de pulso que llega ahora no es silencio). Una trama atrasada (la web estaba parada) no despierta
    // nada: lo que dependía del reloj ya lo atendió el reflejo nativo o lo hará la siguiente que llegue a tiempo.
    const meta = this.chunkMeta;
    if (this.pokes.size > 0 && !(meta && Date.now() - meta.atMs > STALE_EVENT_MS)) this.poke();
  }

  private route(frame: Frame): void {
    switch (frame.group) {
      case Group.devControl:
        this.handlePush(frame);
        return;
      case Group.real:
        this.handleRealtime(frame);
        return;
      case Group.health:
        this.healthQueue.push(frame);
        return;
      default: {
        const key = replyKey(frame.group, frame.cmd);
        const list = this.waiters.get(key);
        const waiter = list?.shift();
        if (list && list.length === 0) this.waiters.delete(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else {
          this.log.info(`respuesta sin petición pendiente: ${key}`);
        }
      }
    }
  }

  /** Avisos del anillo: se confirman SIEMPRE (salvo estados de error), antes de interpretarlos. */
  private handlePush(frame: Frame): void {
    if (frameErrorOf(frame) !== null) return;
    // Si el reflejo nativo ya lo confirmó (la web estaba parada), no se confirma otra vez.
    if (!this.chunkMeta?.reflexed) void this.send(Commands.pushAck(frame.cmd)).catch(() => undefined);
    if (frame.cmd === DevControlKey.measurementStatus && frame.payload.length >= 3) {
      // [tipo][estado][valor…]: para FC (tipo 0) el valor es el pulso.
      if (u8(frame.payload, 0) === MeasureMode.heartRate && u8(frame.payload, 2) > 0) {
        this.emit({ kind: 'heartRate', bpm: u8(frame.payload, 2) });
      }
    }
    if (frame.cmd === DevControlKey.measurementResult && frame.payload.length >= 2) {
      // `04 0e [tipo][1 = ok | 2 = fallida | otro = cancelada]`: los anillos de esta familia cierran SOLA la medida
      // puntual a los ~35 s (tras ~26 s de calentamiento del sensor sin lecturas válidas).
      this.emit({ kind: 'measurementEnd', mode: u8(frame.payload, 0), success: u8(frame.payload, 1) === 1 });
    }
  }

  private handleRealtime(frame: Frame): void {
    const p = frame.payload;
    switch (frame.cmd) {
      case RealKey.status:
        // Se exigen los tres campos: una trama corta no debe pasar por un "0 pasos" medido.
        if (p.length >= 6) {
          const status: LiveStatus = { steps: u16(p, 0), distanceM: u16(p, 2), calories: u16(p, 4) };
          this.lastStatus = status;
          this.emit({ kind: 'status', status });
        }
        return;
      case RealKey.heartRate:
        if (p.length >= 1) this.emit({ kind: 'heartRate', bpm: u8(p, 0) });
        return;
      case RealKey.spo2:
        if (p.length >= 1) this.emit({ kind: 'spo2', percent: u8(p, 0) });
        return;
      case RealKey.vitals:
        // `[sistólica][diastólica][fc][hrv][spo2]…`: algunos firmwares dan aquí el pulso en vez de en `06 01`.
        if (p.length >= 3 && u8(p, 2) > 0) this.emit({ kind: 'heartRate', bpm: u8(p, 2) });
        return;
      case RealKey.battery:
        if (p.length >= 2) this.emit({ kind: 'battery', percent: u8(p, 1), charging: u8(p, 0) !== 0 });
        return;
      default:
        return;
    }
  }

  private emit(event: LiveBody): void {
    const meta = this.chunkMeta;
    const stamped: LiveEvent = meta ? { ...event, tsMs: meta.atMs, reflexed: meta.reflexed, restartAtMs: meta.restartAtMs } : event;
    for (const listener of [...this.liveListeners]) listener(stamped);
  }

  private onDisconnect(): void {
    this.shutdown(new RingError('Se perdió la conexión con el anillo.', 'link-closed'));
  }

  private shutdown(error: RingError): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    this.healthQueue.fail(error);
    this.liveListeners.clear();
    this.markClosed();
  }
}

const isPlausibleBpm = (bpm: number): boolean => bpm >= 35 && bpm <= 220;
