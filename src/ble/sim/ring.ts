import { toHex, type Bytes } from '../bytes';
import { crc16 } from '../crc';
import {
  AppControlKey,
  GetKey,
  Group,
  HEALTH_NO_DATA_PAYLOAD,
  HealthKey,
  HISTORY,
  MeasureMode,
  RealKey,
  SettingKey,
  type HistoryType,
} from '../constants';
import { buildFrame, parseFrame, type Frame } from '../frame';
import { RingError } from '../errors';
import type { Channel, PickOptions, ReconnectOptions, RingLink, RingTransport, SavedRing, ScanEntry } from '../transport';
import { encodeAll, encodeHeart, encodeSleep, encodeSport, encodeSpo2 } from './encode';
import type { SimDataset } from './dataset';

export interface SimBehavior {
  /** Bytes máximos por notificación (MTU − 3). 20 es el peor caso (MTU 23): obliga a reensamblar. */
  chunkSize?: number;
  /** Bytes de payload por trama de datos del historial. */
  dataFramePayload?: number;
  /** Entrega las respuestas DENTRO de `write()`, antes de que devuelva: el caso límite de carrera. */
  replyDuringWrite?: boolean;
  /** Retardo entre notificaciones (ms). */
  latencyMs?: number;
  /** Claves "GG:CC" en hex a las que el anillo no contesta nunca. */
  silentOn?: string[];
  /** Tipos de historial que el firmware no implementa (responde 0xFC). */
  unsupportedHistory?: Array<HistoryType['id']>;
  /** Pierde la primera trama de datos de este tipo en el primer intento: el CRC final no cuadrará. */
  dropFirstDataFrameOf?: HistoryType['id'];
  /** Como la anterior, pero en TODOS los intentos (un enlace que corrompe siempre). */
  alwaysDropFirstDataFrameOf?: HistoryType['id'];
  /** No envía nunca el bloque terminal de este tipo (el anillo se queda mudo a mitad). */
  dropTerminalOf?: HistoryType['id'];
  /** Envía un bloque terminal rezagado (de un tipo anterior) antes de la cabecera o justo después. */
  staleTerminal?: 'before-header' | 'after-header';
  /** Lecturas de FC en vivo tras `03 2f 01 00` (los ceros simulan el calentamiento del sensor). La última se repite. */
  hrSamples?: number[];
  hrIntervalMs?: number;
  /** Cierra la medida por su cuenta (`04 0e`) al entregar la última lectura de `hrSamples`, como hacen estos anillos. */
  hrVerdict?: 'success' | 'failure';
  /** Modos de medida que el anillo rechaza con estado 0x01. */
  refuseModes?: number[];
  /** Intervalo del empuje `06 00` (ms). */
  liveIntervalMs?: number;
  /** Como el anillo real: el contador de pasos solo se manda al activar el empuje y cuando cambia, no a intervalos fijos. */
  liveOnChange?: boolean;
  /** Retardo del primer `06 00` tras activar el empuje (ms; el R99 real tarda ~2,5 s). Por defecto, al instante. */
  liveFirstMs?: number;
  /** Manda el contador una sola vez al activar el empuje y nada más (lo que se vio en el R99 sin pulso en marcha). */
  liveFirstOnly?: boolean;
  /** Si es false, el anillo atiende consultas aunque no se haya confirmado la anterior (no es lo real). */
  strictAck?: boolean;
  /** Acepta el primer `03 09` pero no publica el acumulado de pasos (algunos firmwares, hasta que la conexión se asienta). */
  suppressFirstLiveStatus?: boolean;
}

const hexKey = (group: number, cmd: number): string =>
  `${group.toString(16).padStart(2, '0')}:${cmd.toString(16).padStart(2, '0')}`;

const HISTORY_BY_QUERY = new Map<number, HistoryType>(Object.values(HISTORY).map((t) => [t.queryKey, t]));

/**
 * El lado "anillo" del protocolo YCBT, en memoria. Responde a las mismas órdenes que el firmware real
 * del R99 (según lo documentado) y conserva sus peculiaridades: confirmación obligatoria entre tipos,
 * estados 0xFC para lo que no implementa, avisos con reenvío, fragmentación por MTU.
 */
export class SimulatedRing implements RingLink {
  readonly id = 'sim-r99-0001';
  readonly name: string;
  connected = true;
  /** Cuántas peticiones de medida más rechaza el anillo (estado 0x01), para probar los reintentos. */
  refuseNext = 0;
  /** Tramas válidas recibidas de la app, para comprobaciones en los tests. */
  readonly received: Frame[] = [];
  /** Configuración que la app ha escrito en el anillo. */
  readonly state = {
    clock: null as number[] | null,
    user: null as number[] | null,
    heartMonitor: null as number[] | null,
    spo2Monitor: null as number[] | null,
    liveStatus: false,
    measuring: null as number | null,
  };

  private readonly dataListeners = new Set<(channel: Channel, chunk: Bytes) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private awaitingAck: HistoryType | null = null;
  private dataFrameDropped = false;
  private liveSuppressed = false;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private liveFirstTimer: ReturnType<typeof setTimeout> | null = null;
  private hrTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly dataset: SimDataset,
    readonly behavior: SimBehavior = {},
  ) {
    this.name = dataset.deviceName;
  }

  // ───────────────────────────── RingLink ─────────────────────────────

  async write(data: Bytes): Promise<void> {
    if (!this.connected) throw new Error('GATT: dispositivo desconectado');
    const frame = parseFrame(data);
    if (!frame || !frame.crcOk) return; // el anillo descarta lo que no es una trama válida
    this.received.push(frame);
    if (this.behavior.silentOn?.includes(hexKey(frame.group, frame.cmd))) return;
    this.handle(frame);
  }

  onData(listener: (channel: Channel, chunk: Bytes) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.stopTimers();
    // En web, `gattserverdisconnected` también se dispara tras una desconexión pedida por la app.
    queueMicrotask(() => this.disconnectListeners.forEach((l) => l()));
  }

  /** Corte de enlace (anillo fuera de alcance, batería agotada…). */
  simulateLinkLoss(): void {
    void this.disconnect();
  }

  /** Empuja una trama del flujo en tiempo real (grupo 6), como el firmware. */
  pushReal(key: number, payload: ArrayLike<number>): void {
    this.deliver(Group.real, key, payload, 'stream');
  }

  /** Entrega una respuesta que la app no pidió, como si OTRA app (Smart Health en segundo plano) hablara con el anillo a la vez. */
  pushStray(group: number, key: number, payload: ArrayLike<number> = [0]): void {
    this.deliver(group, key, payload, 'command');
  }

  /** Empuja un aviso del anillo (grupo 4) como si lo hubiera generado el firmware. */
  pushDevControl(key: number, payload: ArrayLike<number>): void {
    this.deliver(Group.devControl, key, payload, 'stream');
  }

  // ───────────────────────────── firmware ─────────────────────────────

  private handle(frame: Frame): void {
    switch (frame.group) {
      case Group.get:
        return this.handleGet(frame);
      case Group.setting:
        return this.handleSetting(frame);
      case Group.appControl:
        return this.handleAppControl(frame);
      case Group.health:
        return this.handleHealth(frame);
      default:
        // Group.devControl desde la app es solo un ACK de aviso: se acepta sin respuesta.
        if (frame.group !== Group.devControl) this.reply(frame, [0xfb]);
    }
  }

  private handleGet(frame: Frame): void {
    switch (frame.cmd) {
      case GetKey.deviceInfo:
        return this.reply(frame, [0x34, 0x12, this.dataset.firmware.sub, this.dataset.firmware.main, 0x00, this.dataset.batteryPercent, 0, 0]);
      case GetKey.supportFunction:
        return this.reply(frame, this.dataset.supportBitmap);
      case GetKey.deviceName:
        return this.reply(frame, new TextEncoder().encode(this.dataset.deviceName));
      default:
        return this.reply(frame, [0xfc]);
    }
  }

  private handleSetting(frame: Frame): void {
    const payload = Array.from(frame.payload);
    switch (frame.cmd) {
      case SettingKey.time:
        this.state.clock = payload;
        return this.reply(frame, [0]);
      case SettingKey.userInfo:
        this.state.user = payload;
        return this.reply(frame, [0]);
      case SettingKey.heartMonitor:
        this.state.heartMonitor = payload;
        return this.reply(frame, [0]);
      case SettingKey.bloodOxygenMonitor:
        this.state.spo2Monitor = payload;
        return this.reply(frame, [0]);
      case 0x04: // unidades
      case 0x12: // idioma
        return this.reply(frame, [0]);
      default:
        // 0x1c (presión continua), 0x20 (temperatura), 0x45 (HRV): el R99 no los implementa.
        return this.reply(frame, [0xfc]);
    }
  }

  private handleAppControl(frame: Frame): void {
    switch (frame.cmd) {
      case AppControlKey.liveStatusPush:
        this.state.liveStatus = frame.payload[0] === 1;
        this.reply(frame, [0]);
        if (this.state.liveStatus && this.behavior.suppressFirstLiveStatus && !this.liveSuppressed) {
          this.liveSuppressed = true;
          return;
        }
        if (this.state.liveStatus) this.startLiveStatus();
        else this.stopLiveStatus();
        return;
      case AppControlKey.liveMeasurement: {
        const enable = frame.payload[0] === 1;
        const mode = frame.payload[1] ?? 0;
        if (enable && (this.behavior.refuseModes?.includes(mode) || this.refuseNext > 0)) {
          if (this.refuseNext > 0) this.refuseNext--;
          return this.reply(frame, [0x01]);
        }
        this.reply(frame, [0]);
        if (enable) this.startMeasurement(mode);
        else this.stopMeasurement();
        return;
      }
      case AppControlKey.findDevice:
        return this.reply(frame, [0]);
      default:
        return this.reply(frame, [0xfc]);
    }
  }

  private handleHealth(frame: Frame): void {
    if (frame.cmd === HealthKey.terminal) {
      // ACK de la app al bloque anterior. Con un NAK (0x04) la app vuelve a consultar el tipo.
      this.awaitingAck = null;
      return;
    }
    const type = HISTORY_BY_QUERY.get(frame.cmd);
    if (!type) return this.reply(frame, [0xfc], 'stream');
    // El anillo real no libera el siguiente tipo hasta recibir el ACK del anterior.
    if (this.awaitingAck && this.behavior.strictAck !== false) return;
    this.serveHistory(type);
  }

  private bufferFor(type: HistoryType): { buffer: Bytes; records: number } {
    const d = this.dataset;
    switch (type.id) {
      case 'sport':
        return { buffer: encodeSport(d.sport), records: d.sport.length };
      case 'sleep':
        return { buffer: encodeSleep(d.sleep), records: d.sleep.length };
      case 'heart':
        return { buffer: encodeHeart(d.heart), records: d.heart.length };
      case 'all':
        return { buffer: encodeAll(d.all), records: d.all.length };
      case 'spo2':
        return { buffer: encodeSpo2(d.spo2), records: d.spo2.length };
      default:
        return { buffer: new Uint8Array(), records: 0 };
    }
  }

  private serveHistory(type: HistoryType): void {
    if (this.behavior.unsupportedHistory?.includes(type.id)) {
      this.deliver(Group.health, type.queryKey, [0xfc], 'stream');
      return;
    }
    const { buffer, records } = this.bufferFor(type);
    if (this.behavior.staleTerminal === 'before-header') this.sendStaleTerminal();
    if (buffer.length === 0) {
      this.deliver(Group.health, type.queryKey, HEALTH_NO_DATA_PAYLOAD, 'stream');
      return;
    }

    const per = this.behavior.dataFramePayload ?? 40;
    const chunks: Bytes[] = [];
    for (let i = 0; i < buffer.length; i += per) chunks.push(buffer.slice(i, i + per));

    const header = new Uint8Array(10);
    header[0] = records & 0xff;
    header[1] = (records >> 8) & 0xff;
    new DataView(header.buffer).setUint32(2, chunks.length, true);
    new DataView(header.buffer).setUint32(6, buffer.length, true);
    this.deliver(Group.health, type.queryKey, header, 'stream');
    if (this.behavior.staleTerminal === 'after-header') this.sendStaleTerminal();

    const dropOnce = this.behavior.dropFirstDataFrameOf === type.id && !this.dataFrameDropped;
    const dropAlways = this.behavior.alwaysDropFirstDataFrameOf === type.id;
    chunks.forEach((chunk, index) => {
      if (index === 0 && (dropOnce || dropAlways)) return;
      this.deliver(Group.health, type.ackKey, chunk, 'stream');
    });
    if (this.behavior.dropFirstDataFrameOf === type.id) this.dataFrameDropped = true;
    if (this.behavior.dropTerminalOf === type.id) {
      this.awaitingAck = type;
      return;
    }

    const terminal = new Uint8Array(6);
    new DataView(terminal.buffer).setUint16(0, chunks.length & 0xffff, true);
    new DataView(terminal.buffer).setUint16(2, buffer.length & 0xffff, true);
    new DataView(terminal.buffer).setUint16(4, crc16(buffer), true);
    this.deliver(Group.health, HealthKey.terminal, terminal, 'stream');
    this.awaitingAck = type;
  }

  private sendStaleTerminal(): void {
    this.deliver(Group.health, HealthKey.terminal, [0x03, 0x00, 0x20, 0x00, 0x34, 0x12], 'stream');
  }

  // ───────────────────────────── flujo en vivo ─────────────────────────────

  private startLiveStatus(): void {
    this.stopLiveStatus();
    let lastSent: string | null = null;
    const emit = (): void => {
      const { steps, distanceM, calories } = this.dataset.live;
      const signature = `${steps}/${distanceM}/${calories}`;
      if (this.behavior.liveOnChange && signature === lastSent) return;
      lastSent = signature;
      const p = new Uint8Array(6);
      new DataView(p.buffer).setUint16(0, steps & 0xffff, true);
      new DataView(p.buffer).setUint16(2, distanceM & 0xffff, true);
      new DataView(p.buffer).setUint16(4, calories & 0xffff, true);
      this.deliver(Group.real, RealKey.status, p, 'stream');
    };
    // El primer empuje llega pronto (en el anillo real, a los ~2,5 s) y se manda siempre, aunque no haya cambiado.
    this.liveFirstTimer = setTimeout(emit, this.behavior.liveFirstMs ?? 1);
    if (!this.behavior.liveFirstOnly) this.liveTimer = setInterval(emit, this.behavior.liveIntervalMs ?? 1000);
  }

  private stopLiveStatus(): void {
    if (this.liveFirstTimer) clearTimeout(this.liveFirstTimer);
    this.liveFirstTimer = null;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  private startMeasurement(mode: number): void {
    this.stopMeasurement();
    this.state.measuring = mode;
    if (mode !== MeasureMode.heartRate && mode !== MeasureMode.spo2) return;
    const samples = this.behavior.hrSamples ?? [0, 0, 71, 72, 73, 72, 73, 73, 74, 73];
    let index = 0;
    this.hrTimer = setInterval(() => {
      const value = samples[Math.min(index, samples.length - 1)] ?? 0;
      index++;
      this.deliver(Group.real, mode === MeasureMode.heartRate ? RealKey.heartRate : RealKey.spo2, [value], 'stream');
      if (this.behavior.hrVerdict && index >= samples.length) {
        // El anillo da por terminada la medida: deja de medir y avisa con `04 0e [modo][1 = ok | 2 = fallida]`.
        this.stopMeasurement();
        this.pushDevControl(0x0e, [mode, this.behavior.hrVerdict === 'success' ? 1 : 2]);
      }
    }, this.behavior.hrIntervalMs ?? 10);
  }

  private stopMeasurement(): void {
    if (this.hrTimer) clearInterval(this.hrTimer);
    this.hrTimer = null;
    this.state.measuring = null;
  }

  private stopTimers(): void {
    this.stopLiveStatus();
    this.stopMeasurement();
  }

  // ───────────────────────────── salida ─────────────────────────────

  private reply(request: Frame, payload: ArrayLike<number>, channel: Channel = 'command'): void {
    this.deliver(request.group, request.cmd, payload, channel);
  }

  /** Enmarca, fragmenta según el MTU y entrega por el canal indicado, en orden. */
  private deliver(group: number, cmd: number, payload: ArrayLike<number>, channel: Channel): void {
    const frame = buildFrame(group, cmd, payload);
    const size = Math.max(1, this.behavior.chunkSize ?? 20);
    const chunks: Bytes[] = [];
    for (let i = 0; i < frame.length; i += size) chunks.push(frame.slice(i, i + size));
    for (const chunk of chunks) this.emit(channel, chunk);
  }

  private emit(channel: Channel, chunk: Bytes): void {
    const send = (): void => {
      if (!this.connected) return;
      for (const listener of [...this.dataListeners]) listener(channel, chunk);
    };
    if (this.behavior.replyDuringWrite) {
      send();
      return;
    }
    const latency = this.behavior.latencyMs ?? 0;
    // Una cadena de promesas garantiza el orden relativo aunque haya retardo.
    this.queue = this.queue.then(() => (latency > 0 ? new Promise<void>((r) => setTimeout(r, latency)) : Promise.resolve())).then(send);
  }

  /** Para depurar en pruebas. */
  describeReceived(): string[] {
    return this.received.map((f) => `${hexKey(f.group, f.cmd)} ${toHex(f.payload)}`);
  }
}

/** Transporte que entrega siempre un anillo simulado nuevo (pruebas, e2e y modo demostración). */
/** El identificador del anillo de mentira (la versión para betatesters lo deja ya vinculado: ver `app/beta.ts`). */
export const SIM_RING_ID = 'sim-r99-0001';

export class SimulatedTransport implements RingTransport {
  readonly kind = 'simulator' as const;
  readonly available = true;
  lastRing: SimulatedRing | null = null;
  /** Cuántas conexiones se han abierto (pruebas: cuánto «habla» la app con el anillo). */
  connections = 0;
  /** `false`: el anillo está fuera de alcance; reconectar da `null` y el selector no encuentra nada (pruebas). */
  reachable = true;
  /** Ganchos opcionales que las pruebas rellenan para imitar lo que sabe un transporte nativo (ver `RingTransport`). */
  takeNotes?: () => string[];
  connectedDevices?: () => Promise<Array<{ id: string; name: string | null }>>;

  constructor(
    private readonly dataset: SimDataset | (() => SimDataset),
    private readonly behavior: SimBehavior = {},
  ) {}

  private make(): SimulatedRing {
    const dataset = typeof this.dataset === 'function' ? this.dataset() : this.dataset;
    this.lastRing = new SimulatedRing(dataset, this.behavior);
    this.connections++;
    return this.lastRing;
  }

  async pickAndConnect(_options?: PickOptions): Promise<RingLink> {
    if (!this.reachable) throw new RingError('No se encontró el anillo.', 'connect-failed');
    return this.make();
  }

  async reconnect(_saved: SavedRing, options?: ReconnectOptions): Promise<RingLink | null> {
    if (!this.reachable || options?.signal?.aborted) return null;
    return this.make();
  }

  /** Lo que se «ve» al buscar: el anillo y un dispositivo cualquiera, como pasaría en una habitación con Bluetooth. */
  async scan(durationMs: number): Promise<ScanEntry[]> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, 50)));
    const dataset = typeof this.dataset === 'function' ? this.dataset() : this.dataset;
    return [
      {
        id: SIM_RING_ID,
        name: dataset.deviceName,
        rssi: -58,
        services: [],
        manufacturer: { '7810': '01 02 03 04' },
        raw: '02 01 06 05 09 52 39 39 20',
      },
      { id: 'sim-other-0002', name: 'Auriculares', rssi: -77, services: ['0000110b-0000-1000-8000-00805f9b34fb'], manufacturer: {}, raw: null },
    ];
  }

  async connectTo(_device: { id: string; name: string | null }): Promise<RingLink> {
    return this.make();
  }

  async environment(): Promise<Record<string, unknown>> {
    return { native: false, simulator: true };
  }
}

