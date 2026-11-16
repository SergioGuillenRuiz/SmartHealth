import { BleClient, ScanMode, type BleService, type ScanResult, type TimeoutOptions } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
import { NativeTools, Tracker } from '../app/native';
import { withNotificationMeta } from './ble-meta';
import { toHex } from './bytes';
import { YCBT_COMMAND_CHAR, YCBT_SERVICE, YCBT_STREAM_CHAR } from './constants';
import { RingError } from './errors';
import type { Channel, ChunkMeta, LinkDetails, LinkKeeper, PickOptions, ReconnectOptions, RingLink, RingTransport, SavedRing, ScanEntry } from './transport';

/**
 * El subconjunto del cliente BLE nativo (plugin de Capacitor) que usa el transporte. Las pruebas lo sustituyen por uno
 * falso que habla con el anillo simulado.
 */
export type BleApi = Pick<
  typeof BleClient,
  | 'initialize'
  | 'isEnabled'
  | 'requestEnable'
  | 'isLocationEnabled'
  | 'requestDevice'
  | 'requestLEScan'
  | 'stopLEScan'
  | 'getDevices'
  | 'connect'
  | 'disconnect'
  | 'getServices'
  | 'getMtu'
  | 'readRssi'
  | 'write'
  | 'writeWithoutResponse'
  | 'stopNotifications'
> & {
    /** Como el de `BleClient`, pero el receptor recibe también lo que el lado nativo añade a cada aviso (ver `ChunkMeta`), si lo hay. */
    startNotifications(
      deviceId: string,
      service: string,
      characteristic: string,
      callback: (value: DataView, meta?: ChunkMeta) => void,
      options?: TimeoutOptions,
    ): Promise<void>;
  } & Partial<Pick<typeof BleClient, 'getConnectedDevices' | 'getBondedDevices'>>;

/**
 * El cliente Bluetooth de la app instalada: el de `BleClient` con las notificaciones que traen la hora y el número de orden que les pone el lado
 * nativo (ver `withNotificationMeta`).
 */
export function defaultBle(): BleApi {
  const client = BleClient;
  const notifications = withNotificationMeta(client);
  return {
    initialize: (options) => client.initialize(options),
    isEnabled: () => client.isEnabled(),
    requestEnable: () => client.requestEnable(),
    isLocationEnabled: () => client.isLocationEnabled(),
    requestDevice: (options) => client.requestDevice(options),
    requestLEScan: (options, callback) => client.requestLEScan(options, callback),
    stopLEScan: () => client.stopLEScan(),
    getDevices: (deviceIds) => client.getDevices(deviceIds),
    connect: (deviceId, onDisconnect, options) => client.connect(deviceId, onDisconnect, options),
    disconnect: (deviceId) => client.disconnect(deviceId),
    getServices: (deviceId) => client.getServices(deviceId),
    getMtu: (deviceId) => client.getMtu(deviceId),
    readRssi: (deviceId) => client.readRssi(deviceId),
    write: (deviceId, service, characteristic, value, options) => client.write(deviceId, service, characteristic, value, options),
    writeWithoutResponse: (deviceId, service, characteristic, value, options) => client.writeWithoutResponse(deviceId, service, characteristic, value, options),
    startNotifications: notifications.startNotifications,
    stopNotifications: notifications.stopNotifications,
    getConnectedDevices: (services) => client.getConnectedDevices(services),
    getBondedDevices: () => client.getBondedDevices(),
  };
}

/**
 * Lo que el transporte pide al lado nativo del entreno para el reflejo del pulso (ver `RingKeeper.java`). Fuera de la app instalada no hay.
 */
export interface NativeKeeperApi {
  /** Pone al lado nativo a oír los avisos del anillo ANTES de que la web se suscriba a ellos. */
  prepare(deviceId: string, service: string, characteristics: string[]): Promise<void>;
  arm(options: { deviceId: string; service: string; command: string; withResponse: boolean; startHr: Uint8Array }): Promise<void>;
  disarm(): Promise<void>;
}

function defaultKeeperApi(native: boolean): NativeKeeperApi | null {
  if (!native) return null;
  return {
    async prepare(deviceId, service, characteristics) {
      await Tracker.ringPrepare({ deviceId, service, characteristics });
    },
    async arm({ startHr, ...rest }) {
      await Tracker.ringArm({ ...rest, startHr: toHex(startHr, '').toUpperCase() });
    },
    async disarm() {
      await Tracker.ringDisarm();
    },
  };
}

/** Lo que el transporte pide al sistema fuera del plugin de Bluetooth: ver `NativeToolsPlugin`. */
export interface BlePermissionTools {
  requestBlePermissions(): Promise<unknown>;
  permissionStatus(): Promise<unknown>;
}

/** Cómo han quedado los permisos tras pedirlos la app: los que faltan y si consta que está todo concedido. */
interface PermissionOutcome {
  missing: string[];
  /** `true` solo si `NativeTools` confirmó la ubicación precisa (y, si procede, «Dispositivos cercanos»). */
  confirmed: boolean;
}

function permissionOutcome(status: unknown): PermissionOutcome {
  if (!status || typeof status !== 'object') return { missing: [], confirmed: false };
  const state = status as { bluetoothScan?: unknown; bluetoothConnect?: unknown; fineLocation?: unknown };
  const missing: string[] = [];
  if (state.bluetoothScan === false || state.bluetoothConnect === false) missing.push('«Dispositivos cercanos»');
  if (state.fineLocation === false) missing.push('«Ubicación» precisa');
  return { missing, confirmed: missing.length === 0 && state.fineLocation === true };
}

/** Código de empresa del SDK de Yucheng (0x7810), como lo da el plugin: en decimal. */
const YUCHENG_COMPANY_ID = 0x7810;

/** Tiempo máximo para establecer la conexión GATT: un anillo apagado o fuera de alcance deja `connect()` colgado. */
const CONNECT_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 5_000;
/** Al cerrar no se espera mucho: si el anillo ya no está, esas operaciones podrían colgarse. */
const CLOSE_TIMEOUT_MS = 2_500;
/**
 * Reconectar con un anillo que se acaba de soltar falla a veces la primera vez en Android (estado GATT 133, tiempo agotado):
 * se intenta una segunda vez tras una pausa antes de rendirse (y de que quien llama abra la lista de dispositivos).
 */
const RECONNECT_ATTEMPTS = 2;
const RECONNECT_RETRY_MS = 1_500;

/**
 * Lo que tardó cada paso de un enlace que ya conectó, en una línea para la traza («enlace: conectar 14200 ms · servicios 380 ms · reflejo 4 ms · avisos 510 ms»).
 * «Conectar» es todo lo que hace el plugin en una sola llamada: unirse al anillo, descubrir sus servicios y pedir el MTU.
 */
export function linkTiming(steps: { connect?: number; services?: number; keeper?: number; notifications?: number }): string {
  const part = (label: string, ms: number | undefined): string => (ms === undefined ? '' : ` · ${label} ${ms} ms`);
  return `enlace${part('conectar', steps.connect)}${part('servicios', steps.services)}${part('reflejo', steps.keeper)}${part('avisos', steps.notifications)}`.replace('enlace ·', 'enlace:');
}

const sameUuid = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms} ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error));

/** Traduce los rechazos del plugin (en inglés, sin código) a errores de la app. */
export function translateError(error: unknown, fallback: string, code: RingError['code']): RingError {
  if (error instanceof RingError) return error;
  const text = messageOf(error);
  // Solo el selector cerrado sin elegir (el plugin dice «requestDevice cancelled»); una petición de emparejamiento que se
  // cancela («Pairing request was cancelled by the user») es un fallo de conexión, no «no has elegido».
  if (/requestDevice cancelled|no device found/i.test(text)) {
    return new RingError('No se ha elegido ningún anillo.', 'no-device', { cause: error });
  }
  if (/pairing|bond/i.test(text)) {
    return new RingError(`Android pidió emparejar el anillo y el emparejamiento no se completó (${text}). Si aparece una ventana de emparejamiento, acéptala y vuelve a intentarlo.`, code, { cause: error });
  }
  if (/permission/i.test(text)) {
    return new RingError(
      'Falta un permiso de Bluetooth o de ubicación. Concédelo en Ajustes → Aplicaciones → SmartHealth → Permisos («Dispositivos cercanos» y «Ubicación» precisa) y vuelve a intentarlo.',
      'unsupported-platform',
      { cause: error },
    );
  }
  return new RingError(`${fallback} (${text})`, code, { cause: error });
}

export const propertiesOf = (characteristic: BleService['characteristics'][number]): string[] =>
  Object.entries(characteristic.properties)
    .filter(([, on]) => on === true)
    .map(([name]) => name);

/** `uuid [característica:propiedades, …]; …`: la tabla GATT en una línea, recortada para que quepa en un mensaje. */
export function describeServices(services: readonly BleService[]): string {
  if (services.length === 0) return 'ningún servicio';
  const shown = services.slice(0, 8).map((service) => {
    const characteristics = service.characteristics.map((c) => `${c.uuid}:${propertiesOf(c).join('+') || '-'}`).join(', ');
    return `${service.uuid} [${characteristics}]`;
  });
  return `${shown.join('; ')}${services.length > shown.length ? `; y ${services.length - shown.length} más` : ''}`;
}

function toScanEntry(result: ScanResult): ScanEntry {
  const manufacturer: Record<string, string> = {};
  for (const [company, value] of Object.entries(result.manufacturerData ?? {})) {
    manufacturer[Number(company).toString(16).padStart(4, '0')] = toHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), ' ');
  }
  const raw = result.rawAdvertisement;
  return {
    id: result.device.deviceId,
    name: result.localName ?? result.device.name ?? null,
    rssi: result.rssi ?? null,
    services: result.uuids ?? result.device.uuids ?? [],
    manufacturer,
    raw: raw ? toHex(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), ' ') : null,
  };
}

/**
 * Transporte Bluetooth nativo de Android (plugin `@capacitor-community/bluetooth-le`), el que usa la app instalada: un
 * WebView no tiene Web Bluetooth. Hace lo mismo que `WebBluetoothTransport`: selector del sistema (o búsqueda), conexión
 * GATT, los dos canales del anillo suscritos y escritura en el de órdenes.
 *
 * Particularidades:
 * - Android exige permisos en ejecución (Bluetooth cercano; ubicación en versiones antiguas) y, para buscar, la ubicación
 *   del sistema encendida: se piden en `initialize` y se comprueba antes de buscar para dar un mensaje claro.
 * - El plugin pide un MTU grande al conectar y escribe el descriptor de notificación o de indicación según las
 *   propiedades de la característica (los canales del anillo son de tipo «indicate»).
 * - El identificador del dispositivo es su dirección MAC, estable: sirve para reconectar sin selector.
 */
export class CapacitorBleTransport implements RingTransport {
  readonly kind = 'native' as const;
  private ready: Promise<void> | null = null;
  private notes: string[] = [];

  constructor(
    private readonly ble: BleApi = defaultBle(),
    private readonly native: boolean = Capacitor.isNativePlatform(),
    private readonly permissions: BlePermissionTools = NativeTools,
    private readonly retryDelayMs: number = RECONNECT_RETRY_MS,
    private readonly keeperApi: NativeKeeperApi | null = defaultKeeperApi(native),
  ) {}

  /** El cliente Bluetooth que usa este transporte: la báscula (`ble/scale`) comparte permisos e inicialización con el anillo. */
  get bleApi(): BleApi {
    return this.ble;
  }

  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  get available(): boolean {
    return this.native;
  }

  get unavailableReason(): string | undefined {
    return this.native ? undefined : 'Este Bluetooth solo funciona dentro de la app de Android.';
  }

  /** Pide los permisos en ejecución y inicializa el plugin. Se hace una sola vez (si se deniegan, la siguiente vuelve a pedirlos). */
  private async initialize(): Promise<void> {
    this.ready ??= this.askPermissions()
      .then(async ({ missing, confirmed }) => {
        // Si la persona acaba de denegar algo, no se vuelve a preguntar con el plugin: dos negativas seguidas hacen que Android
        // deje de preguntar para siempre. Se avisa de lo que falta y, al reintentar, se pide otra vez.
        if (missing.length > 0) {
          throw new RingError(
            `Falta permiso para ${missing.join(' y ')}. Concédelo en Ajustes → Aplicaciones → SmartHealth → Permisos («Dispositivos cercanos» y «Ubicación» precisa) y vuelve a intentarlo.`,
            'unsupported-platform',
          );
        }
        // Con la ubicación ya concedida por la app, el plugin no tiene que volver a pedirla: pide la precisa sola, sin la
        // aproximada, y Android 12 ignora esa petición (aun concedida, la respuesta no llegaba). `androidNeverForLocation`
        // solo cambia qué permisos pide el plugin, no cómo se busca (eso lo decide el manifiesto, que no lo declara).
        const started = Date.now();
        await this.ble.initialize({ androidNeverForLocation: confirmed });
        this.notes.push(`inicialización del plugin (sin pedir ubicación: ${confirmed ? 'sí' : 'no'}): ${Date.now() - started} ms`);
      })
      .catch((error: unknown) => {
        this.ready = null;
        throw translateError(error, 'No se pudo preparar el Bluetooth', 'unsupported-platform');
      });
    await this.ready;
  }

  /**
   * Los permisos se piden aquí, juntos y bien: el plugin de Bluetooth pide la ubicación precisa sin la aproximada y Android 12
   * lo ignora. Si esta petición falla no pasa nada: el plugin pide los suyos después y, si falta alguno, rechaza con un error
   * que se traduce a un aviso claro.
   */
  private async askPermissions(): Promise<PermissionOutcome> {
    const started = Date.now();
    try {
      const status = await Promise.resolve().then(() => this.permissions.requestBlePermissions());
      this.notes.push(`petición de permisos de la app: ${Date.now() - started} ms, ${JSON.stringify(status)}`);
      return permissionOutcome(status);
    } catch (error) {
      this.notes.push(`petición de permisos de la app: ${messageOf(error)} (${Date.now() - started} ms)`);
      return { missing: [], confirmed: false };
    }
  }

  /**
   * Permisos y Bluetooth listos, y, si se va a buscar, la ubicación del sistema encendida (Android la exige para buscar; para
   * conectar con un dispositivo ya conocido no hace falta). Lo que la persona pueda cambiar después se comprueba cada vez.
   */
  async prepare(scanning: boolean, silent = false): Promise<void> {
    if (silent && !this.ready) {
      // Una reconexión silenciosa no pregunta nada: si los permisos aún no están concedidos, no hay nada que hacer (la normal,
      // la del botón, sí los pide).
      const status = await Promise.resolve()
        .then(() => this.permissions.permissionStatus())
        .catch(() => null);
      if (!permissionOutcome(status).confirmed) throw new RingError('Faltan permisos de Bluetooth o de ubicación.', 'unsupported-platform');
    }
    await this.initialize();
    if (!(await this.ble.isEnabled())) {
      // En una reconexión automática no se abre el aviso del sistema: saldría cada pocos segundos sobre el entreno.
      if (silent) throw new RingError('El Bluetooth del móvil está apagado.', 'unsupported-platform');
      try {
        await this.ble.requestEnable();
      } catch (error) {
        throw new RingError('El Bluetooth del móvil está apagado. Actívalo y vuelve a intentarlo.', 'unsupported-platform', { cause: error });
      }
    }
    if (scanning && !(await this.ble.isLocationEnabled().catch(() => true))) {
      throw new RingError(
        'Activa la ubicación del móvil: Android la exige para buscar dispositivos Bluetooth (la app no la usa para nada más que los entrenos con GPS).',
        'unsupported-platform',
      );
    }
  }

  async pickAndConnect(options: PickOptions = {}): Promise<RingLink> {
    this.assertAvailable();
    await this.prepare(true);
    let device: { deviceId: string; name?: string };
    try {
      device = await this.ble.requestDevice(
        options.showAll
          ? { optionalServices: [YCBT_SERVICE], displayMode: 'list' }
          : { namePrefix: 'R99', optionalServices: [YCBT_SERVICE] },
      );
    } catch (error) {
      throw translateError(error, 'No se pudo buscar el anillo', 'connect-failed');
    }
    return this.link(device.deviceId, device.name ?? null);
  }

  async reconnect(saved: SavedRing, options: ReconnectOptions = {}): Promise<RingLink | null> {
    if (!this.available) return null;
    const { signal } = options;
    const attempts = Math.max(1, Math.floor(options.attempts ?? RECONNECT_ATTEMPTS));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal?.aborted) return null;
      const attemptStart = Date.now();
      try {
        await this.prepare(false, options.silent === true);
        if (signal?.aborted) return null;
        const known = await this.ble.getDevices([saved.id]);
        const device = known[0];
        if (!device) {
          this.notes.push('reconexión: el sistema no conoce el anillo guardado');
          return null;
        }
        return await this.link(device.deviceId, device.name ?? saved.name, { timeoutMs: options.timeoutMs, signal });
      } catch (error) {
        if (signal?.aborted) return null; // cancelada: no es un fallo que apuntar ni que reintentar
        this.notes.push(`reconexión, intento ${attempt} de ${attempts} (${Date.now() - attemptStart} ms): ${messageOf(error)}`);
        // Sin permisos, con el Bluetooth apagado o con un dispositivo que no habla YCBT, repetir no arregla nada.
        const hopeless = error instanceof RingError && (error.code === 'unsupported-platform' || error.code === 'protocol');
        // Una reconexión silenciosa que no puede por falta de permisos o con el Bluetooth apagado lo dice en vez de devolver `null`:
        // así quien llama sabe que no ha gastado radio y que reintentar pronto no cuesta nada (ver `AutoSync`).
        if (options.silent === true && error instanceof RingError && error.code === 'unsupported-platform') throw error;
        if (hopeless || attempt >= attempts) return null;
        await sleep(this.retryDelayMs);
      }
    }
    return null;
  }

  async scan(durationMs: number): Promise<ScanEntry[]> {
    this.assertAvailable();
    await this.prepare(true);
    const seen = new Map<string, ScanEntry>();
    try {
      await this.ble.requestLEScan({ allowDuplicates: true, scanMode: ScanMode.SCAN_MODE_LOW_LATENCY }, (result) => {
        const entry = toScanEntry(result);
        const before = seen.get(entry.id);
        // El nombre y los datos llegan a veces en anuncios distintos: se completan, y se queda la mejor señal.
        seen.set(entry.id, {
          ...entry,
          name: entry.name ?? before?.name ?? null,
          rssi: Math.max(entry.rssi ?? -999, before?.rssi ?? -999) === -999 ? null : Math.max(entry.rssi ?? -999, before?.rssi ?? -999),
          services: [...new Set([...(before?.services ?? []), ...entry.services])],
          manufacturer: { ...before?.manufacturer, ...entry.manufacturer },
          raw: entry.raw ?? before?.raw ?? null,
        });
      });
      await sleep(durationMs);
    } catch (error) {
      throw translateError(error, 'No se pudo buscar dispositivos', 'connect-failed');
    } finally {
      await this.ble.stopLEScan().catch(() => undefined);
    }
    return [...seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  async connectTo(device: { id: string; name: string | null }): Promise<RingLink> {
    this.assertAvailable();
    await this.prepare(false);
    return this.link(device.id, device.name);
  }

  async connectedDevices(): Promise<Array<{ id: string; name: string | null }>> {
    const list = (await this.ble.getConnectedDevices?.([YCBT_SERVICE])) ?? [];
    return list.map((device) => ({ id: device.deviceId, name: device.name ?? null }));
  }

  async environment(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { native: this.native, yuchengCompanyId: YUCHENG_COMPANY_ID };
    try {
      await this.initialize();
      out.initialize = 'ok';
    } catch (error) {
      out.initialize = `error: ${messageOf(error)}`;
    }
    const attempt = async <T>(read: () => Promise<T> | T): Promise<T | string> => {
      try {
        return await read();
      } catch (error) {
        return `error: ${messageOf(error)}`;
      }
    };
    out.bluetoothEnabled = await attempt(() => this.ble.isEnabled());
    out.locationEnabled = await attempt(() => this.ble.isLocationEnabled());
    out.permissions = await attempt(() => this.permissions.permissionStatus());
    // Quién tiene cogido el anillo (otra app, p. ej. Smart Health) y qué anillos tiene emparejados el móvil.
    out.connectedDevices = await attempt(() => this.connectedDevices());
    const bonded = this.ble.getBondedDevices;
    if (bonded) out.bondedDevices = await attempt(async () => (await bonded.call(this.ble)).map((device) => ({ id: device.deviceId, name: device.name ?? null })));
    const notes = this.takeNotes();
    if (notes.length > 0) out.notes = notes;
    return out;
  }

  private assertAvailable(): void {
    const reason = this.unavailableReason;
    if (reason) throw new RingError(reason, 'unsupported-platform');
  }

  /**
   * Conecta, comprueba que el dispositivo habla YCBT y suscribe los dos canales. Si algo falla, no deja la conexión abierta.
   * Con `signal`, cancelar suelta el enlace aunque aún se esté estableciendo.
   */
  private async link(deviceId: string, name: string | null, options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {}): Promise<RingLink> {
    const ble = this.ble;
    const { signal } = options;
    const dataListeners = new Set<(channel: Channel, chunk: Uint8Array, meta?: ChunkMeta) => void>();
    const disconnectListeners = new Set<() => void>();
    let connected = false;
    let notified = false;
    const notifyDisconnect = (): void => {
      connected = false;
      if (notified) return;
      notified = true;
      for (const listener of [...disconnectListeners]) listener();
    };
    // Se suelta una sola vez por enlace: varios caminos pueden querer cerrarlo (cancelar, un fallo, la conexión que llega tarde).
    let closing: Promise<void> | null = null;
    const closeQuietly = (): Promise<void> => {
      closing ??= withTimeout(ble.disconnect(deviceId), CLOSE_TIMEOUT_MS).then(
        () => undefined,
        () => undefined,
      );
      return closing;
    };

    // Cancelar mientras aún conecta no espera a que el plugin acabe: atiende sus operaciones en cola, así que el `disconnect` queda
    // detrás del `connect` en vuelo hasta que este acaba o vence su tiempo (unos segundos en los que quien cancela —y quien pide el
    // anillo para otra cosa— se quedaría esperando). Se corta al momento y la conexión que sigue en vuelo se suelta en cuanto
    // llegue o falle.
    let cancelConnect: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelConnect = () => reject(new RingError('Conexión cancelada.', 'aborted'));
    });
    cancelled.catch(() => undefined); // si gana la conexión, nadie recoge este rechazo
    const onAbort = (): void => {
      cancelConnect?.();
      void closeQuietly();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let connecting: Promise<void> | null = null;
    // Cuánto tardó cada paso del enlace: la conexión de la hoja del anillo llegó a 17 s y no se sabía dónde se iba (ver `linkTiming`).
    const stepMs: { connect?: number; services?: number; keeper?: number; notifications?: number } = {};
    let stepAt = Date.now();
    try {
      if (signal?.aborted) throw new RingError('Conexión cancelada.', 'aborted');
      stepAt = Date.now();
      connecting = ble.connect(deviceId, () => notifyDisconnect(), { timeout: options.timeoutMs ?? CONNECT_TIMEOUT_MS });
      await Promise.race([connecting, cancelled]);
      stepMs.connect = Date.now() - stepAt;
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      if (error instanceof RingError && error.code === 'aborted') {
        if (connecting) void connecting.then(closeQuietly, closeQuietly);
        throw error;
      }
      // El plugin puede rechazar con el enlace ya abierto (si falla el descubrimiento de servicios o el MTU) sin cerrarlo:
      // sin esto quedaría conectado, sin dueño, gastando batería en el anillo y sin dejar entrar a Smart Health.
      await closeQuietly();
      throw translateError(
        error,
        'No se pudo conectar con el anillo. Comprueba que está cerca y que la app Smart Health está cerrada (el anillo solo admite una conexión a la vez)',
        'connect-failed',
      );
    }
    signal?.removeEventListener('abort', onAbort);
    connected = true;
    // Cancelada justo al terminar de conectar: no se sigue (nadie recibiría el enlace) y se suelta.
    if (signal?.aborted) {
      await closeQuietly();
      throw new RingError('Conexión cancelada.', 'aborted');
    }

    let services: BleService[];
    try {
      stepAt = Date.now();
      services = await ble.getServices(deviceId);
      stepMs.services = Date.now() - stepAt;
    } catch (error) {
      await closeQuietly();
      throw translateError(error, 'No se pudieron leer los servicios del anillo', 'protocol');
    }
    const service = services.find((s) => sameUuid(s.uuid, YCBT_SERVICE));
    const command = service?.characteristics.find((c) => sameUuid(c.uuid, YCBT_COMMAND_CHAR));
    const stream = service?.characteristics.find((c) => sameUuid(c.uuid, YCBT_STREAM_CHAR));
    if (!service || !command || !stream) {
      await closeQuietly();
      // Lo que SÍ ofrece va en el mensaje: si el anillo usa otros identificadores, con eso se corrigen sin tenerlo delante.
      throw new RingError(`Este dispositivo no ofrece el servicio de Smart Health (YCBT). Ofrece: ${describeServices(services)}.`, 'protocol');
    }

    // Los oyentes ya están antes de activar las notificaciones: el primer aviso puede llegar enseguida.
    const forward = (channel: Channel) => (value: DataView, meta?: ChunkMeta) => {
      // Se copia: el plugin puede reutilizar el búfer.
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      for (const listener of [...dataListeners]) listener(channel, chunk, meta);
    };
    // El lado nativo se pone a oír los mismos avisos ANTES que la web (para ponerles hora y número, y atender al anillo si la web se para). Si
    // no puede, la web recibe los avisos igual, sin esos datos.
    const keeperApi = this.keeperApi;
    stepAt = Date.now();
    if (keeperApi) {
      await withTimeout(keeperApi.prepare(deviceId, YCBT_SERVICE, [YCBT_COMMAND_CHAR, YCBT_STREAM_CHAR]), OPERATION_TIMEOUT_MS).catch(() => undefined);
    }
    stepMs.keeper = Date.now() - stepAt;
    stepAt = Date.now();
    try {
      // En serie, como en web: Android admite una sola operación GATT a la vez.
      await ble.startNotifications(deviceId, YCBT_SERVICE, YCBT_COMMAND_CHAR, forward('command'), { timeout: OPERATION_TIMEOUT_MS });
      await ble.startNotifications(deviceId, YCBT_SERVICE, YCBT_STREAM_CHAR, forward('stream'), { timeout: OPERATION_TIMEOUT_MS });
      stepMs.notifications = Date.now() - stepAt;
    } catch (error) {
      await closeQuietly();
      throw translateError(error, 'No se pudieron activar las notificaciones del anillo', 'connect-failed');
    }

    this.notes.push(linkTiming(stepMs));
    const useResponse = command.properties.write || !command.properties.writeWithoutResponse;
    const keeper: LinkKeeper | undefined = keeperApi
      ? {
          arm: (startHeartRate) =>
            withTimeout(keeperApi.arm({ deviceId, service: YCBT_SERVICE, command: YCBT_COMMAND_CHAR, withResponse: useResponse, startHr: startHeartRate }), OPERATION_TIMEOUT_MS),
          disarm: () => withTimeout(keeperApi.disarm(), OPERATION_TIMEOUT_MS),
        }
      : undefined;
    return {
      id: deviceId,
      ...(keeper ? { keeper } : {}),
      name: name ?? 'Anillo',
      get connected(): boolean {
        return connected;
      },
      async write(data: Uint8Array): Promise<void> {
        if (!connected) throw new Error('GATT: dispositivo desconectado');
        // Una copia propia: no se depende de la vista que nos pasen.
        const copy = data.slice();
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        if (useResponse) await ble.write(deviceId, YCBT_SERVICE, YCBT_COMMAND_CHAR, view, { timeout: OPERATION_TIMEOUT_MS });
        else await ble.writeWithoutResponse(deviceId, YCBT_SERVICE, YCBT_COMMAND_CHAR, view, { timeout: OPERATION_TIMEOUT_MS });
      },
      onData(listener): () => void {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onDisconnect(listener): () => void {
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
      async disconnect(): Promise<void> {
        if (connected) {
          connected = false;
          // Sin esperar a que el anillo confirme las bajas de notificación: si ya no está, se colgaría.
          await withTimeout(
            Promise.allSettled([ble.stopNotifications(deviceId, YCBT_SERVICE, YCBT_COMMAND_CHAR), ble.stopNotifications(deviceId, YCBT_SERVICE, YCBT_STREAM_CHAR)]),
            CLOSE_TIMEOUT_MS,
          ).catch(() => undefined);
          await closeQuietly();
        }
        // Se avisa a la sesión de la baja aunque el plugin no lo haga tras una desconexión pedida por la app.
        queueMicrotask(notifyDisconnect);
      },
      async details(): Promise<LinkDetails> {
        return {
          gatt: services.map((s) => ({ service: s.uuid, characteristics: s.characteristics.map((c) => ({ uuid: c.uuid, properties: propertiesOf(c) })) })),
          mtu: await ble.getMtu(deviceId).catch(() => null),
          rssi: await ble.readRssi(deviceId).catch(() => null),
        };
      },
    };
  }
}
