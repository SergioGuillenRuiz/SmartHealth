import { YCBT_COMMAND_CHAR, YCBT_SERVICE, YCBT_STREAM_CHAR } from './constants';
import { RingError } from './errors';
import type { Channel, PickOptions, RingLink, RingTransport, SavedRing } from './transport';

/** Código de empresa del SDK de Yucheng (0x7810) en los datos de fabricante que anuncia el anillo. */
const YUCHENG_COMPANY_ID = 0x7810;

/** Tiempo máximo para establecer la conexión GATT: un anillo apagado o fuera de alcance deja `connect()` colgado. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Transporte Web Bluetooth (Chrome/Edge en Android, escritorio, o Bluefy en iOS).
 *
 * Particularidades que condicionan el diseño:
 * - `requestDevice` exige un gesto del usuario y muestra siempre el selector del sistema; la
 *   reconexión sin selector (`getDevices`) solo existe en versiones recientes y se usa si está.
 * - El anillo NO anuncia el servicio `be940000`, así que se filtra por nombre ("R99 xxxx") o por el
 *   código de fabricante, y el servicio se declara como `optionalServices` para poder usarlo al conectar.
 * - Los canales de órdenes y flujo son de tipo "indicate": `startNotifications()` escribe el descriptor
 *   adecuado según las propiedades de la característica.
 */
export class WebBluetoothTransport implements RingTransport {
  readonly kind = 'web-bluetooth' as const;

  get available(): boolean {
    return this.unavailableReason === undefined;
  }

  get unavailableReason(): string | undefined {
    if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
      return 'Este navegador no permite Bluetooth en páginas web. Usa Chrome en Android (o Bluefy en iPhone).';
    }
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
      return 'Bluetooth solo funciona en páginas seguras (HTTPS).';
    }
    return undefined;
  }

  async pickAndConnect(options: PickOptions = {}): Promise<RingLink> {
    this.assertAvailable();
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice(
        options.showAll
          ? { acceptAllDevices: true, optionalServices: [YCBT_SERVICE] }
          : {
              filters: [{ namePrefix: 'R99' }, { manufacturerData: [{ companyIdentifier: YUCHENG_COMPANY_ID }] }],
              optionalServices: [YCBT_SERVICE],
            },
      );
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) {
        throw new RingError('No se ha elegido ningún anillo.', 'no-device', { cause: error });
      }
      if (isDomError(error, 'SecurityError') || isDomError(error, 'NotAllowedError')) {
        throw new RingError('El navegador no ha dado permiso para usar Bluetooth.', 'unsupported-platform', { cause: error });
      }
      throw new RingError('No se pudo buscar el anillo.', 'connect-failed', { cause: error });
    }
    return connect(device);
  }

  async reconnect(saved: SavedRing): Promise<RingLink | null> {
    if (!this.available) return null;
    // `getDevices` no está en todos los navegadores (ni sin activar permisos persistentes).
    const bluetooth = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    if (typeof bluetooth.getDevices !== 'function') return null;
    try {
      const known = await bluetooth.getDevices();
      const device = known.find((d) => d.id === saved.id);
      return device ? await connect(device) : null;
    } catch {
      return null;
    }
  }

  private assertAvailable(): void {
    const reason = this.unavailableReason;
    if (reason) throw new RingError(reason, 'unsupported-platform');
  }
}

async function connect(device: BluetoothDevice): Promise<RingLink> {
  const gatt = device.gatt;
  if (!gatt) throw new RingError('El dispositivo no admite conexiones GATT.', 'connect-failed');

  let server: BluetoothRemoteGATTServer;
  try {
    server = await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, () => gatt.disconnect());
  } catch (error) {
    throw new RingError(
      'No se pudo conectar con el anillo. Comprueba que está cerca y que la app Smart Health está cerrada (el anillo solo admite una conexión a la vez).',
      'connect-failed',
      { cause: error },
    );
  }

  let command: BluetoothRemoteGATTCharacteristic;
  let stream: BluetoothRemoteGATTCharacteristic;
  try {
    const service = await server.getPrimaryService(YCBT_SERVICE);
    command = await service.getCharacteristic(YCBT_COMMAND_CHAR);
    stream = await service.getCharacteristic(YCBT_STREAM_CHAR);
  } catch (error) {
    server.disconnect();
    throw new RingError('Este dispositivo no ofrece el servicio de Smart Health (YCBT).', 'protocol', { cause: error });
  }

  const dataListeners = new Set<(channel: Channel, chunk: Uint8Array) => void>();
  const disconnectListeners = new Set<() => void>();

  // Los oyentes van ANTES de activar las notificaciones: el primer aviso puede llegar enseguida.
  const forward = (channel: Channel) => (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    // Se copia: el navegador puede reutilizar el búfer de la notificación.
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    for (const listener of [...dataListeners]) listener(channel, chunk);
  };
  const onCommand = forward('command');
  const onStream = forward('stream');
  const onDisconnected = (): void => {
    for (const listener of [...disconnectListeners]) listener();
  };
  command.addEventListener('characteristicvaluechanged', onCommand);
  stream.addEventListener('characteristicvaluechanged', onStream);
  device.addEventListener('gattserverdisconnected', onDisconnected);

  try {
    // En serie: Chrome rechaza una segunda operación GATT mientras hay otra en curso.
    await command.startNotifications();
    await stream.startNotifications();
  } catch (error) {
    server.disconnect();
    throw new RingError('No se pudieron activar las notificaciones del anillo.', 'connect-failed', { cause: error });
  }

  const props = command.properties;
  const useResponse = props.write || !props.writeWithoutResponse;

  return {
    id: device.id,
    name: device.name ?? 'Anillo',
    get connected(): boolean {
      return gatt.connected;
    },
    async write(data: Uint8Array): Promise<void> {
      // Se copia a un ArrayBuffer propio para no depender de la vista que nos pasen.
      const copy = data.slice().buffer;
      if (useResponse) {
        // `writeValueWithResponse` llegó en Chrome 85; antes solo existía `writeValue`.
        const legacy = command as BluetoothRemoteGATTCharacteristic & { writeValueWithResponse?: unknown };
        if (typeof legacy.writeValueWithResponse === 'function') await command.writeValueWithResponse(copy);
        else await command.writeValue(copy);
      } else {
        await command.writeValueWithoutResponse(copy);
      }
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
      command.removeEventListener('characteristicvaluechanged', onCommand);
      stream.removeEventListener('characteristicvaluechanged', onStream);
      // Se cierra sin esperar a stopNotifications: si el anillo ya no está, ese await podría colgarse.
      if (gatt.connected) gatt.disconnect();
      // Dejar `gattserverdisconnected` enganchado hasta aquí permite avisar a la sesión de la baja.
      device.removeEventListener('gattserverdisconnected', onDisconnected);
      queueMicrotask(onDisconnected);
    },
  };
}

function isDomError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === name;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Tiempo agotado (${ms} ms)`));
    }, ms);
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
