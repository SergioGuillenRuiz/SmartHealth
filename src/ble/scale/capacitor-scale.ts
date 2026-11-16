import { ScanMode, type BleService, type ScanResult } from '@capacitor-community/bluetooth-le';
import { toHex } from '../bytes';
import { describeServices, messageOf, propertiesOf, translateError, withTimeout, type BleApi, type CapacitorBleTransport } from '../capacitor-ble';
import { RingError } from '../errors';
import type { LinkDetails } from '../transport';
import type { ScaleFrame } from '../../domain/scale';
import { shortUuid, type ScaleAdvert, type ScaleConnectOptions, type ScaleLink, type ScaleTransport } from './transport';

// El Bluetooth de Android para la báscula de cocina. Comparte con el del anillo (`CapacitorBleTransport`) los permisos, la inicialización del plugin y la comprobación de que
// el Bluetooth y la ubicación están activados, y añade lo propio de una báscula con protocolo desconocido: buscar viendo el anuncio entero, conectar suscribiéndose a TODAS las
// características que avisan, y escuchar los anuncios de un dispositivo (porque hay básculas que mandan el peso en el anuncio y no se conectan).

const CONNECT_TIMEOUT_MS = 12_000;
const OPERATION_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_500;
/** Android falla a veces la primera conexión con un dispositivo (estado 133): se intenta una segunda vez tras una pausa corta. */
const CONNECT_ATTEMPTS = 2;
const RETRY_PAUSE_MS = 1_200;
/** Los servicios estándar de «acceso genérico» y «atributo genérico» solo avisan de cambios en la tabla GATT: son ruido para esto. */
const SKIPPED_SERVICES = new Set(['1800', '1801']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hexOf = (view: DataView): string => toHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), ' ');

export function toAdvert(result: ScanResult, atMs: number): ScaleAdvert {
  const manufacturer: Record<string, string> = {};
  for (const [company, value] of Object.entries(result.manufacturerData ?? {})) manufacturer[Number(company).toString(16).padStart(4, '0')] = hexOf(value);
  const serviceData: Record<string, string> = {};
  for (const [uuid, value] of Object.entries(result.serviceData ?? {})) serviceData[shortUuid(uuid)] = hexOf(value);
  const raw = result.rawAdvertisement;
  return {
    id: result.device.deviceId,
    name: result.localName ?? result.device.name ?? null,
    rssi: result.rssi ?? null,
    services: (result.uuids ?? result.device.uuids ?? []).map(shortUuid),
    manufacturer,
    serviceData,
    raw: raw ? hexOf(raw) : null,
    atMs,
  };
}

/** Une los anuncios sucesivos de un mismo dispositivo (el nombre y los datos llegan a veces en anuncios distintos). */
function merge(before: ScaleAdvert | undefined, next: ScaleAdvert): ScaleAdvert {
  if (!before) return next;
  return {
    ...next,
    name: next.name ?? before.name,
    rssi: next.rssi ?? before.rssi,
    services: [...new Set([...before.services, ...next.services])],
    manufacturer: { ...before.manufacturer, ...next.manufacturer },
    serviceData: { ...before.serviceData, ...next.serviceData },
    raw: next.raw ?? before.raw,
  };
}

export class CapacitorScaleTransport implements ScaleTransport {
  readonly kind = 'native' as const;
  private readonly listeners = new Set<(advert: ScaleAdvert) => void>();
  private scanning = false;
  private scanStart: Promise<void> | null = null;

  constructor(
    private readonly base: CapacitorBleTransport,
    private readonly now: () => number = Date.now,
  ) {}

  private get ble(): BleApi {
    return this.base.bleApi;
  }

  get available(): boolean {
    return this.base.available;
  }

  get unavailableReason(): string | undefined {
    return this.base.unavailableReason;
  }

  // ───────────────────── buscar y escuchar anuncios (una sola búsqueda abierta) ─────────────────────

  /** Abre la búsqueda si no lo está. Android admite una a la vez: todos los que escuchan comparten la misma. */
  private async startScan(): Promise<void> {
    if (this.scanning) return;
    this.scanStart ??= (async () => {
      await this.base.prepare(true);
      try {
        await this.ble.requestLEScan({ allowDuplicates: true, scanMode: ScanMode.SCAN_MODE_LOW_LATENCY }, (result) => {
          const advert = toAdvert(result, this.now());
          for (const listener of [...this.listeners]) listener(advert);
        });
      } catch (error) {
        throw translateError(error, 'No se pudo buscar dispositivos', 'connect-failed');
      }
      this.scanning = true;
    })().finally(() => {
      this.scanStart = null;
    });
    await this.scanStart;
  }

  /** Cierra la búsqueda cuando ya no escucha nadie. */
  private async stopScanIfIdle(): Promise<void> {
    if (this.listeners.size > 0 || !this.scanning) return;
    this.scanning = false;
    await this.ble.stopLEScan().catch(() => undefined);
  }

  async scan(durationMs: number, onSeen?: (advert: ScaleAdvert) => void): Promise<ScaleAdvert[]> {
    const seen = new Map<string, ScaleAdvert>();
    const listener = (advert: ScaleAdvert): void => {
      const merged = merge(seen.get(advert.id), advert);
      seen.set(advert.id, merged);
      onSeen?.(merged);
    };
    this.listeners.add(listener);
    try {
      await this.startScan();
      await sleep(durationMs);
    } finally {
      this.listeners.delete(listener);
      await this.stopScanIfIdle();
    }
    return [...seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  async watch(deviceId: string, onAdvert: (advert: ScaleAdvert) => void): Promise<() => void> {
    const listener = (advert: ScaleAdvert): void => {
      if (advert.id === deviceId) onAdvert(advert);
    };
    this.listeners.add(listener);
    try {
      await this.startScan();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => {
      this.listeners.delete(listener);
      void this.stopScanIfIdle();
    };
  }

  // ───────────────────── conectar ─────────────────────

  async connect(device: { id: string; name: string | null }, options: ScaleConnectOptions = {}): Promise<ScaleLink> {
    if (!this.available) throw new RingError(this.unavailableReason ?? 'Bluetooth no disponible.', 'unsupported-platform');
    await this.base.prepare(false);
    let lastError: unknown;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      if (options.signal?.aborted) throw new RingError('Conexión cancelada.', 'aborted');
      try {
        return await this.open(device, options);
      } catch (error) {
        lastError = error;
        // Sin permisos o por una tabla GATT sin nada que escuchar, repetir no arregla nada.
        if (error instanceof RingError && (error.code === 'unsupported-platform' || error.code === 'protocol' || error.code === 'aborted')) throw error;
        if (attempt < CONNECT_ATTEMPTS) await sleep(RETRY_PAUSE_MS);
      }
    }
    // El fallo del plugin va entre paréntesis: lo que se puede hacer es lo que lee la persona y lo que falló, quien depura.
    throw new RingError(
      `No se pudo conectar con la báscula. Enciéndela (pulsa un botón o pon algo encima), acércala y cierra la app de RENPHO si la tienes abierta (solo admite una conexión a la vez). (${messageOf(lastError)})`,
      'connect-failed',
      { cause: lastError },
    );
  }

  private async open(device: { id: string; name: string | null }, options: ScaleConnectOptions): Promise<ScaleLink> {
    const ble = this.ble;
    const id = device.id;
    const frameListeners = new Set<(frame: ScaleFrame) => void>();
    const dropListeners = new Set<() => void>();
    let connected = false;
    let told = false;
    const tellDropped = (): void => {
      connected = false;
      if (told) return;
      told = true;
      for (const listener of [...dropListeners]) listener();
    };
    let closing: Promise<void> | null = null;
    const closeQuietly = (): Promise<void> => {
      closing ??= withTimeout(ble.disconnect(id), CLOSE_TIMEOUT_MS).then(
        () => undefined,
        () => undefined,
      );
      return closing;
    };
    // Conectar con una búsqueda abierta tarda más y falla más: se hace una pausa mientras se establece la conexión y se retoma después.
    const wasScanning = this.scanning;
    if (wasScanning) {
      this.scanning = false;
      await ble.stopLEScan().catch(() => undefined);
    }
    try {
      await withTimeout(ble.connect(id, () => tellDropped(), { timeout: options.timeoutMs ?? CONNECT_TIMEOUT_MS }), (options.timeoutMs ?? CONNECT_TIMEOUT_MS) + 2_000);
    } catch (error) {
      await closeQuietly();
      throw translateError(error, 'No se pudo conectar con la báscula', 'connect-failed');
    } finally {
      if (wasScanning && this.listeners.size > 0) void this.startScan().catch(() => undefined);
    }
    connected = true;
    if (options.signal?.aborted) {
      await closeQuietly();
      throw new RingError('Conexión cancelada.', 'aborted');
    }

    let services: BleService[];
    try {
      services = await ble.getServices(id);
    } catch (error) {
      await closeQuietly();
      throw translateError(error, 'No se pudieron leer los servicios de la báscula', 'protocol');
    }
    const subscribed: string[] = [];
    const failed: string[] = [];
    // En serie: Android admite una sola operación GATT a la vez. Cada una puede fallar sin que importe (el servicio de otro fabricante, una característica protegida).
    for (const service of services) {
      if (SKIPPED_SERVICES.has(shortUuid(service.uuid))) continue;
      for (const characteristic of service.characteristics) {
        const properties = propertiesOf(characteristic);
        if (!properties.includes('notify') && !properties.includes('indicate')) continue;
        const source = `n:${shortUuid(service.uuid)}/${shortUuid(characteristic.uuid)}`;
        try {
          await ble.startNotifications(
            id,
            service.uuid,
            characteristic.uuid,
            (value) => {
              // Se copia: el plugin puede reutilizar el búfer.
              const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
              const frame: ScaleFrame = { source, bytes, atMs: this.now() };
              for (const listener of [...frameListeners]) listener(frame);
            },
            { timeout: OPERATION_TIMEOUT_MS },
          );
          subscribed.push(`${shortUuid(service.uuid)}/${shortUuid(characteristic.uuid)}`);
        } catch (error) {
          failed.push(`${source}: ${messageOf(error)}`);
        }
      }
    }
    if (subscribed.length === 0) {
      await closeQuietly();
      throw new RingError(`La báscula no ofrece nada que escuchar (ninguna característica de aviso). Ofrece: ${describeServices(services)}.${failed.length > 0 ? ` Fallaron: ${failed.join('; ')}.` : ''}`, 'protocol');
    }
    const stopNotifications = async (): Promise<void> => {
      const jobs: Array<Promise<unknown>> = [];
      for (const service of services) {
        for (const characteristic of service.characteristics) {
          if (subscribed.includes(`${shortUuid(service.uuid)}/${shortUuid(characteristic.uuid)}`)) jobs.push(ble.stopNotifications(id, service.uuid, characteristic.uuid));
        }
      }
      await Promise.allSettled(jobs);
    };
    return {
      id,
      name: device.name ?? 'Báscula',
      subscribed,
      get connected(): boolean {
        return connected;
      },
      onFrame(listener): () => void {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      onDisconnect(listener): () => void {
        dropListeners.add(listener);
        return () => dropListeners.delete(listener);
      },
      async details(): Promise<LinkDetails> {
        return {
          gatt: services.map((s) => ({ service: s.uuid, characteristics: s.characteristics.map((c) => ({ uuid: c.uuid, properties: propertiesOf(c) })) })),
          mtu: await ble.getMtu(id).catch(() => null),
          rssi: await ble.readRssi(id).catch(() => null),
        };
      },
      async disconnect(): Promise<void> {
        if (connected) {
          connected = false;
          // Sin esperar a que la báscula confirme las bajas: si ya está apagada, se colgaría.
          await withTimeout(stopNotifications(), CLOSE_TIMEOUT_MS).catch(() => undefined);
          await closeQuietly();
        }
        queueMicrotask(tellDropped);
      },
    };
  }

  async environment(): Promise<Record<string, unknown>> {
    return this.base.environment();
  }
}
