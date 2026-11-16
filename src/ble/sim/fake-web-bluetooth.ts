import { YCBT_COMMAND_CHAR, YCBT_SERVICE, YCBT_STREAM_CHAR } from '../constants';
import type { Channel } from '../transport';
import type { SimulatedRing } from './ring';

// Una implementación mínima de la API Web Bluetooth respaldada por `SimulatedRing`. Permite probar
// `WebBluetoothTransport` (y todo lo que hay encima) sin hardware, tanto en Vitest como dentro de
// Chromium en las pruebas e2e. Reproduce las restricciones que importan: servicios opcionales,
// una operación GATT a la vez, notificaciones que exigen `startNotifications()` y eventos de baja.

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  notifying = false;
  readonly properties: BluetoothCharacteristicProperties;

  constructor(
    readonly uuid: string,
    private readonly gatt: FakeGatt,
    private readonly channel: Channel,
    writable: boolean,
  ) {
    super();
    this.properties = {
      broadcast: false,
      read: false,
      writeWithoutResponse: false,
      write: writable,
      notify: false,
      indicate: true,
      authenticatedSignedWrites: false,
      reliableWrite: false,
      writableAuxiliaries: false,
    };
  }

  async startNotifications(): Promise<this> {
    await this.gatt.operation(async () => {
      this.notifying = true;
    });
    return this;
  }

  async stopNotifications(): Promise<this> {
    this.notifying = false;
    return this;
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    if (!this.properties.write) throw new DOMException('Write not permitted', 'NotSupportedError');
    await this.gatt.operation(async () => {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      await this.gatt.ring.write(bytes.slice());
    });
  }

  async writeValue(value: BufferSource): Promise<void> {
    return this.writeValueWithResponse(value);
  }

  /** Entrega un fragmento del anillo, solo si la app activó las notificaciones. */
  deliver(channel: Channel, chunk: Uint8Array): void {
    if (channel !== this.channel || !this.notifying) return;
    const copy = chunk.slice();
    this.value = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeService {
  constructor(
    readonly uuid: string,
    private readonly characteristics: Map<string, FakeCharacteristic>,
    private readonly gatt: FakeGatt,
  ) {}

  async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
    return this.gatt.operation(async () => {
      const found = this.characteristics.get(uuid);
      if (!found) throw new DOMException('No characteristics matching UUID found', 'NotFoundError');
      return found;
    });
  }
}

class FakeGatt {
  connected = false;
  private busy = false;
  private readonly characteristics = new Map<string, FakeCharacteristic>();

  constructor(
    readonly ring: SimulatedRing,
    private readonly device: FakeDevice,
    private readonly options: FakeBluetoothOptions,
  ) {
    this.characteristics.set(YCBT_COMMAND_CHAR, new FakeCharacteristic(YCBT_COMMAND_CHAR, this, 'command', true));
    this.characteristics.set(YCBT_STREAM_CHAR, new FakeCharacteristic(YCBT_STREAM_CHAR, this, 'stream', false));
  }

  /** Web Bluetooth rechaza una operación GATT mientras hay otra en curso. */
  async operation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new DOMException('GATT operation already in progress.', 'NetworkError');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  async connect(): Promise<this> {
    if (this.options.failConnect) throw new DOMException('Connection attempt failed.', 'NetworkError');
    if (this.options.hangConnect) await new Promise(() => undefined);
    this.connected = true;
    this.ring.onData((channel, chunk) => {
      for (const c of this.characteristics.values()) c.deliver(channel, chunk);
    });
    this.ring.onDisconnect(() => this.drop());
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    void this.ring.disconnect();
    this.drop();
  }

  private drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }

  async getPrimaryService(uuid: string): Promise<FakeService> {
    return this.operation(async () => {
      if (uuid !== YCBT_SERVICE || this.options.hideService) {
        throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, 'NotFoundError');
      }
      return new FakeService(uuid, this.characteristics, this);
    });
  }
}

class FakeDevice extends EventTarget {
  readonly gatt: FakeGatt;
  constructor(
    readonly id: string,
    readonly name: string,
    ring: SimulatedRing,
    options: FakeBluetoothOptions,
  ) {
    super();
    this.gatt = new FakeGatt(ring, this, options);
  }
}

export interface FakeBluetoothOptions {
  /** `requestDevice` falla como si el usuario cerrara el selector. */
  cancelPicker?: boolean;
  failConnect?: boolean;
  hangConnect?: boolean;
  /** El dispositivo no expone el servicio YCBT (otro tipo de anillo). */
  hideService?: boolean;
  /** Sin `getDevices` (lo habitual en Chrome móvil actual). */
  noGetDevices?: boolean;
}

export interface FakeBluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<FakeDevice>;
  getDevices?: () => Promise<FakeDevice[]>;
  /** Para inspeccionar en las pruebas. */
  readonly requests: RequestDeviceOptions[];
  readonly devices: FakeDevice[];
}

export function createFakeBluetooth(makeRing: () => SimulatedRing, options: FakeBluetoothOptions = {}): FakeBluetooth {
  const requests: RequestDeviceOptions[] = [];
  const devices: FakeDevice[] = [];
  const make = (): FakeDevice => {
    const ring = makeRing();
    const device = new FakeDevice(ring.id, ring.name, ring, options);
    devices.push(device);
    return device;
  };
  const bluetooth: FakeBluetooth = {
    requests,
    devices,
    async requestDevice(request: RequestDeviceOptions): Promise<FakeDevice> {
      requests.push(request);
      if (options.cancelPicker) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
      return make();
    },
  };
  if (!options.noGetDevices) {
    // Equivale a los dispositivos para los que el usuario ya concedió permiso.
    bluetooth.getDevices = async () => [...devices];
  }
  return bluetooth;
}

