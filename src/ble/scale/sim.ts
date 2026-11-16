import { toHex } from '../bytes';
import type { LinkDetails } from '../transport';
import type { ScaleDecoder, ScaleFrame } from '../../domain/scale';
import { RingError } from '../errors';
import type { ScaleAdvert, ScaleConnectOptions, ScaleLink, ScaleTransport } from './transport';

// La báscula simulada de la demostración (`?demo=1`) y de las pruebas. Hace lo que haría una real: se ve al buscar, se conecta, manda tramas con el peso (de varias formas
// según `format`, para probar que la app aprende cualquiera), se «duerme» y se «despierta». Quien prueba le pone peso con `setWeight` (la demostración la deja en
// `window.__smartringScale`).

export type SimScaleFormat = 'be16' | 'le10' | 'ascii' | 'advert' | 'silent';

export interface SimScaleOptions {
  format?: SimScaleFormat;
  /** Cada cuántos ms manda una trama la báscula. */
  everyMs?: number;
  /** Tiempo que tarda en contestar buscar y conectar. */
  latencyMs?: number;
}

const SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHARACTERISTIC = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const SIM_SCALE_ID = 'SIM-SCALE-01';
export const SIM_SCALE_NAME = 'RENPHO-SCALE';
const SOURCE = 'n:ffe0/ffe1';

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const xor = (bytes: number[]): number => bytes.reduce((a, b) => a ^ b, 0);

/** Cómo codifica cada formato una trama con el peso (en gramos). */
export function encodeSimFrame(format: SimScaleFormat, grams: number, counter: number): Uint8Array {
  const g = Math.max(0, Math.round(grams));
  if (format === 'le10') return Uint8Array.from([counter & 0xff, 0xcc, (g * 10) & 0xff, ((g * 10) >> 8) & 0xff, 0x00]);
  if (format === 'ascii') return new TextEncoder().encode(`ST,GS,${g.toFixed(1).padStart(7, ' ')} g\r\n`);
  const body = [0xa5, 0x01, 0x04, ...be16(g), g > 0 ? 1 : 0];
  return Uint8Array.from([...body, xor(body)]);
}

/** El formato pedido en la dirección de la demostración (`?scale=ascii`); cualquier otra cosa, el de siempre. */
export function parseSimScaleFormat(value: string | null): SimScaleFormat {
  return value === 'le10' || value === 'ascii' || value === 'advert' || value === 'silent' ? value : 'be16';
}

/** El decodificador que corresponde a cada formato simulado (lo que aprendería la app): sirve para dejar la báscula ya emparejada en la demostración. */
export function simScaleDecoder(format: SimScaleFormat): ScaleDecoder {
  if (format === 'le10') return { v: 1, source: SOURCE, length: 5, kind: 'uint', offset: 2, width: 2, little: true, divisor: 10, guard: [], index: 0 };
  if (format === 'ascii') return { v: 1, source: SOURCE, length: null, kind: 'ascii', offset: 0, width: 1, little: false, divisor: 1, guard: [], index: 0 };
  if (format === 'advert') return { v: 1, source: 'a:m:ffff', length: 11, kind: 'uint', offset: 8, width: 2, little: false, divisor: 1, guard: [[0, 0xaa]], index: 0 };
  return { v: 1, source: SOURCE, length: 7, kind: 'uint', offset: 3, width: 2, little: false, divisor: 1, guard: [[0, 0xa5]], index: 0 };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SimulatedScaleTransport implements ScaleTransport {
  readonly kind = 'simulator' as const;
  readonly available = true;
  readonly format: SimScaleFormat;
  private readonly everyMs: number;
  private readonly latencyMs: number;
  private weight = 0;
  private awake = true;
  private counter = 0;
  private readonly links = new Set<SimLink>();
  private readonly watchers = new Set<(advert: ScaleAdvert) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Lo que se ha escrito o hecho con la báscula, para las pruebas. */
  readonly log: string[] = [];

  constructor(options: SimScaleOptions = {}) {
    this.format = options.format ?? 'be16';
    this.everyMs = options.everyMs ?? 100;
    this.latencyMs = options.latencyMs ?? 20;
  }

  /** Pone peso en la báscula (g). Despierta la báscula si dormía, como pasaría al poner algo encima. */
  setWeight(grams: number): void {
    this.weight = Math.max(0, grams);
    this.log.push(`peso ${this.weight}`);
    if (!this.awake) this.setAwake(true);
    this.emit();
  }

  getWeight(): number {
    return this.weight;
  }

  /** Apaga (o enciende) la báscula: apagada se corta la conexión y deja de anunciarse. */
  setAwake(awake: boolean): void {
    if (awake === this.awake) return;
    this.awake = awake;
    this.log.push(awake ? 'despierta' : 'dormida');
    if (!awake) for (const link of [...this.links]) void link.drop();
    this.ensureTimer();
    if (awake) this.emit();
  }

  isAwake(): boolean {
    return this.awake;
  }

  connectedCount(): number {
    return this.links.size;
  }

  /** Cuántos escuchan ahora los anuncios (para comprobar que no se sigue escaneando sin hacer falta). */
  watcherCount(): number {
    return this.watchers.size;
  }

  private advert(): ScaleAdvert {
    const advertised = this.format === 'advert';
    return {
      id: SIM_SCALE_ID,
      name: SIM_SCALE_NAME,
      rssi: -48,
      services: advertised ? [] : ['ffe0'],
      manufacturer: advertised ? { ffff: toHex(Uint8Array.from([0xaa, 0xbb, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, ...be16(Math.round(this.weight)), 0x02]), ' ') } : {},
      serviceData: {},
      raw: null,
      atMs: Date.now(),
    };
  }

  private emit(): void {
    if (!this.awake) return;
    this.counter++;
    for (const watcher of [...this.watchers]) watcher(this.advert());
    if (this.format === 'silent' || this.format === 'advert') return;
    for (const link of [...this.links]) link.push({ source: SOURCE, bytes: encodeSimFrame(this.format, this.weight, this.counter), atMs: Date.now() });
  }

  private ensureTimer(): void {
    const needed = this.awake && (this.links.size > 0 || this.watchers.size > 0);
    if (needed && this.timer === null) this.timer = setInterval(() => this.emit(), this.everyMs);
    if (!needed && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scan(durationMs: number, onSeen?: (advert: ScaleAdvert) => void): Promise<ScaleAdvert[]> {
    await sleep(Math.min(durationMs, this.latencyMs));
    const found: ScaleAdvert[] = [
      { id: 'SIM-BAND-07', name: 'Mi Smart Band 7', rssi: -71, services: ['fee0'], manufacturer: {}, serviceData: {}, raw: null, atMs: Date.now() },
      { id: 'SIM-UNKNOWN-1', name: null, rssi: -88, services: [], manufacturer: { '004c': '10 05 01 18 a1 b2 c3' }, serviceData: {}, raw: null, atMs: Date.now() },
    ];
    if (this.awake) found.push(this.advert());
    for (const advert of found) onSeen?.(advert);
    return found.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  async connect(device: { id: string; name: string | null }, options: ScaleConnectOptions = {}): Promise<ScaleLink> {
    await sleep(this.latencyMs);
    if (options.signal?.aborted) throw new RingError('Conexión cancelada.', 'aborted');
    if (device.id !== SIM_SCALE_ID) throw new RingError('No se pudo conectar con el dispositivo.', 'connect-failed');
    if (!this.awake) throw new RingError('No se pudo conectar con la báscula. Enciéndela (pulsa un botón o pon algo encima) y vuelve a intentarlo.', 'connect-failed');
    if (this.format === 'advert') throw new RingError('Este dispositivo no admite conexión: manda el peso en su anuncio.', 'connect-failed');
    const link = new SimLink(this, () => {
      this.links.delete(link);
      this.ensureTimer();
    });
    this.links.add(link);
    this.ensureTimer();
    queueMicrotask(() => this.emit());
    return link;
  }

  async watch(deviceId: string, onAdvert: (advert: ScaleAdvert) => void): Promise<() => void> {
    const listener = (advert: ScaleAdvert): void => {
      if (advert.id === deviceId) onAdvert(advert);
    };
    this.watchers.add(listener);
    this.ensureTimer();
    return () => {
      this.watchers.delete(listener);
      this.ensureTimer();
    };
  }

  async environment(): Promise<Record<string, unknown>> {
    return { simulator: true, format: this.format, awake: this.awake };
  }

  /** Para `SimLink`: el estado de la tabla GATT simulada. */
  gatt(): LinkDetails {
    return { gatt: [{ service: SERVICE, characteristics: [{ uuid: CHARACTERISTIC, properties: ['notify'] }] }], mtu: 23, rssi: -48 };
  }
}

class SimLink implements ScaleLink {
  readonly id = SIM_SCALE_ID;
  readonly name = SIM_SCALE_NAME;
  readonly subscribed = [`${SERVICE}/${CHARACTERISTIC}`];
  private open = true;
  private readonly frameListeners = new Set<(frame: ScaleFrame) => void>();
  private readonly dropListeners = new Set<() => void>();

  constructor(
    private readonly owner: SimulatedScaleTransport,
    private readonly onClose: () => void,
  ) {}

  get connected(): boolean {
    return this.open;
  }

  push(frame: ScaleFrame): void {
    if (!this.open) return;
    for (const listener of [...this.frameListeners]) listener(frame);
  }

  async drop(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.onClose();
    for (const listener of [...this.dropListeners]) listener();
  }

  onFrame(listener: (frame: ScaleFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  async details(): Promise<LinkDetails> {
    return this.owner.gatt();
  }

  async disconnect(): Promise<void> {
    await this.drop();
  }
}
