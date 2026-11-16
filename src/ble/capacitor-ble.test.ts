import { describe, expect, it, vi } from 'vitest';
import type { BleDevice, BleService, ScanResult } from '@capacitor-community/bluetooth-le';
import { CapacitorBleTransport, linkTiming, type BleApi, type NativeKeeperApi } from './capacitor-ble';
import { YCBT_COMMAND_CHAR, YCBT_SERVICE, YCBT_STREAM_CHAR } from './constants';
import { RingError } from './errors';
import { YcbtSession } from './session';
import { buildDemoDataset } from './sim/dataset';
import { SimulatedRing, type SimBehavior } from './sim/ring';
import type { ChunkMeta } from './transport';

const NOW = new Date(2026, 6, 10, 14, 30, 0).getTime();
const view = (bytes: ArrayLike<number>): DataView => new DataView(Uint8Array.from(bytes).buffer);

/**
 * Un «Android» falso: el cliente BLE del plugin conectado al anillo simulado. Respeta lo que importa del plugin real: los
 * valores son DataView, las notificaciones se activan característica a característica y la desconexión se avisa por callback.
 */
class FakeBle implements BleApi {
  readonly ring: SimulatedRing;
  calls: string[] = [];
  enabled = true;
  locationEnabled = true;
  initializeError: Error | null = null;
  connectError: Error | null = null;
  pickError: Error | null = null;
  services: BleService[] = [
    {
      uuid: YCBT_SERVICE,
      characteristics: [
        { uuid: YCBT_COMMAND_CHAR, properties: { write: true, indicate: true, notify: false, read: false, writeWithoutResponse: false, broadcast: false, authenticatedSignedWrites: false }, descriptors: [] },
        { uuid: YCBT_STREAM_CHAR, properties: { notify: true, write: false, read: false, writeWithoutResponse: false, indicate: false, broadcast: false, authenticatedSignedWrites: false }, descriptors: [] },
      ],
    },
  ];
  scanResults: ScanResult[] = [];
  /** Errores que lanzan, en orden, las primeras conexiones (para probar los reintentos). */
  connectFailures: Error[] = [];
  connected: BleDevice[] = [];
  bonded: BleDevice[] = [];
  private callbacks = new Map<string, (value: DataView, meta?: ChunkMeta) => void>();
  /** Lo que el lado nativo añadiría a cada aviso (hora, número de orden…); sin ello, los avisos llegan sin esos datos. */
  metaFor: ((channel: 'command' | 'stream', chunk: Uint8Array) => ChunkMeta | undefined) | null = null;
  private unsubscribe: (() => void) | null = null;
  private onDisconnect: ((deviceId: string) => void) | null = null;
  /** Si se pone, el plugin no avisa de la desconexión pedida por la app (algunas versiones no lo hacen). */
  silentDisconnect = false;
  /** Lo que se le pasó a cada `connect` (el tiempo máximo, sobre todo). */
  connectOptions: unknown[] = [];
  /** La conexión no termina hasta que se suelta el dispositivo (un anillo fuera de alcance al que se deja de esperar). */
  hangConnect = false;
  /** Ms tras los que una conexión colgada acaba fallando sola (su tiempo máximo); 0: nunca. */
  hangMs = 0;
  /** Como el plugin real: atiende las operaciones en cola, así que `disconnect` espera a que acabe el `connect` en vuelo. */
  queuedDisconnect = false;
  /** Ms que tarda un `connect` que SÍ acaba conectando (el plugin puede acabar de conectar después de que la app cancelara); 0: al momento. */
  connectDelayMs = 0;
  private rejectHang: ((error: Error) => void) | null = null;
  private pendingConnect: Promise<void> | null = null;

  constructor(behavior: SimBehavior = {}) {
    this.ring = new SimulatedRing(buildDemoDataset({ nowMs: NOW, days: 3, seed: 11 }), behavior);
  }

  initializeOptions: unknown[] = [];
  async initialize(options?: unknown): Promise<void> {
    this.calls.push('initialize');
    this.initializeOptions.push(options);
    if (this.initializeError) throw this.initializeError;
  }
  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }
  async requestEnable(): Promise<void> {
    this.calls.push('requestEnable');
    if (!this.enabled) throw new Error('requestEnable failed.');
    this.enabled = true;
  }
  async isLocationEnabled(): Promise<boolean> {
    return this.locationEnabled;
  }
  async requestDevice(options?: unknown): Promise<BleDevice> {
    this.calls.push(`requestDevice ${JSON.stringify(options)}`);
    if (this.pickError) throw this.pickError;
    return { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' };
  }
  async requestLEScan(_options: unknown, callback: (result: ScanResult) => void): Promise<void> {
    this.calls.push('requestLEScan');
    for (const result of this.scanResults) callback(result);
  }
  async stopLEScan(): Promise<void> {
    this.calls.push('stopLEScan');
  }
  async getDevices(ids: string[]): Promise<BleDevice[]> {
    return ids.map((deviceId) => ({ deviceId, name: undefined as unknown as string }));
  }
  async getConnectedDevices(): Promise<BleDevice[]> {
    return this.connected;
  }
  async getBondedDevices(): Promise<BleDevice[]> {
    return this.bonded;
  }
  async connect(deviceId: string, onDisconnect?: (deviceId: string) => void, options?: unknown): Promise<void> {
    this.calls.push('connect');
    this.connectOptions.push(options);
    if (this.connectDelayMs > 0) {
      this.pendingConnect = new Promise<void>((resolve) => setTimeout(resolve, this.connectDelayMs));
      await this.pendingConnect;
    }
    if (this.hangConnect) {
      this.pendingConnect = new Promise<void>((_resolve, reject) => {
        this.rejectHang = reject;
        if (this.hangMs > 0) setTimeout(() => reject(new Error('Connection timeout.')), this.hangMs);
      });
      await this.pendingConnect;
    }
    const failure = this.connectFailures.shift();
    if (failure) throw failure;
    if (this.connectError) throw this.connectError;
    this.onDisconnect = onDisconnect ?? null;
    this.ring.onDisconnect(() => {
      if (!this.silentDisconnect) this.onDisconnect?.(deviceId);
    });
  }
  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    if (this.queuedDisconnect && this.pendingConnect) await this.pendingConnect.catch(() => undefined);
    else this.rejectHang?.(new Error('Connection cancelled.'));
    await this.ring.disconnect();
  }
  async getServices(): Promise<BleService[]> {
    return this.services;
  }
  async getMtu(): Promise<number> {
    return 247;
  }
  async readRssi(): Promise<number> {
    return -61;
  }
  async write(_deviceId: string, _service: string, characteristic: string, value: DataView): Promise<void> {
    this.calls.push(`write ${characteristic.slice(0, 8)}`);
    await this.ring.write(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }
  async writeWithoutResponse(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void> {
    this.calls.push(`writeWithoutResponse ${characteristic.slice(0, 8)}`);
    await this.write(deviceId, service, characteristic, value);
  }
  async startNotifications(_deviceId: string, _service: string, characteristic: string, callback: (value: DataView, meta?: ChunkMeta) => void): Promise<void> {
    this.calls.push(`startNotifications ${characteristic.slice(0, 8)}`);
    this.callbacks.set(characteristic, callback);
    this.unsubscribe ??= this.ring.onData((channel, chunk) => {
      const target = channel === 'command' ? YCBT_COMMAND_CHAR : YCBT_STREAM_CHAR;
      // El plugin entrega un DataView sobre un búfer que puede reutilizar.
      this.callbacks.get(target)?.(new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength), this.metaFor?.(channel, chunk));
    });
  }
  async stopNotifications(_deviceId: string, _service: string, characteristic: string): Promise<void> {
    this.calls.push(`stopNotifications ${characteristic.slice(0, 8)}`);
    this.callbacks.delete(characteristic);
  }
}

/** Los permisos propios de la app (NativeTools): comparten el registro de llamadas con el cliente BLE para ver el orden. */
class FakeTools {
  requestError: Error | null = null;
  status = { sdk: 34, bluetoothScan: true, bluetoothConnect: true, fineLocation: true, coarseLocation: true };
  constructor(private readonly calls: string[]) {}
  async requestBlePermissions(): Promise<unknown> {
    this.calls.push('requestBlePermissions');
    if (this.requestError) throw this.requestError;
    return this.status;
  }
  async permissionStatus(): Promise<unknown> {
    return this.status;
  }
}

const transport = (fake: FakeBle, native = true, tools: FakeTools = new FakeTools(fake.calls), keeperApi: NativeKeeperApi | null = null): CapacitorBleTransport =>
  new CapacitorBleTransport(fake as unknown as BleApi, native, tools, 0, keeperApi);

describe('CapacitorBleTransport', () => {
  it('con el anillo simulado detrás, el protocolo entero funciona: apretón de manos y sincronización completa', async () => {
    const fake = new FakeBle({ chunkSize: 20, latencyMs: 1 });
    const link = await transport(fake).pickAndConnect();
    const session = new YcbtSession(link, { timeouts: { reply: 300, header: 400, idle: 400 } });
    const info = await session.open(new Date(2026, 6, 10, 14, 30, 0));
    expect(info.firmware).toBe('2.32');
    const result = await session.syncHistory();
    expect(result.interrupted).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(result.records.heart.length).toBeGreaterThan(20);
    await session.close();
    expect(link.connected).toBe(false);
    expect(fake.ring.connected).toBe(false);
  });

  it('activa las dos notificaciones EN SERIE antes de escribir nada y lee las propiedades de la característica de órdenes', async () => {
    const fake = new FakeBle();
    await transport(fake).pickAndConnect();
    expect(fake.calls.filter((c) => c.startsWith('startNotifications'))).toEqual(['startNotifications be940001', 'startNotifications be940003']);
    expect(fake.calls.indexOf('startNotifications be940003')).toBeGreaterThan(fake.calls.indexOf('connect'));
  });

  describe('el reflejo nativo del pulso', () => {
    const keeperFor = (fake: FakeBle) => {
      const keeper = {
        prepare: vi.fn(async (_deviceId: string, _service: string, _characteristics: string[]) => void fake.calls.push('keeper.prepare')),
        arm: vi.fn(async (_options: { deviceId: string; service: string; command: string; withResponse: boolean; startHr: Uint8Array }) => void fake.calls.push('keeper.arm')),
        disarm: vi.fn(async () => void fake.calls.push('keeper.disarm')),
      };
      return keeper;
    };

    it('el lado nativo se pone a oír ANTES de que la web se suscriba, con el anillo y los dos canales', async () => {
      const fake = new FakeBle();
      const keeper = keeperFor(fake);
      await transport(fake, true, undefined, keeper).pickAndConnect();
      expect(keeper.prepare).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', YCBT_SERVICE, [YCBT_COMMAND_CHAR, YCBT_STREAM_CHAR]);
      expect(fake.calls.indexOf('keeper.prepare')).toBeLessThan(fake.calls.indexOf('startNotifications be940001'));
    });

    it('lo que el lado nativo añade a cada aviso (hora, número de orden, si ya lo atendió) llega a quien oye el enlace', async () => {
      const fake = new FakeBle();
      fake.metaFor = (channel, chunk) => ({ seq: chunk.length, atMs: 123_456, restartAtMs: 120_000, reflexed: channel === 'stream' });
      const link = await transport(fake, true, undefined, keeperFor(fake)).pickAndConnect();
      const seen: Array<{ channel: string; meta: ChunkMeta | undefined }> = [];
      link.onData((channel, _chunk, meta) => seen.push({ channel, meta }));
      fake.ring.pushReal(0x01, [88]);
      fake.ring.pushStray(0x02, 0x03, [1, 2]);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen.find((s) => s.channel === 'stream')?.meta).toMatchObject({ atMs: 123_456, restartAtMs: 120_000, reflexed: true });
      expect(seen.find((s) => s.channel === 'command')?.meta).toMatchObject({ atMs: 123_456, reflexed: false });
    });

    it('sin lado nativo los avisos llegan igual, sin esos datos, y el enlace no ofrece reflejo', async () => {
      const fake = new FakeBle();
      const link = await transport(fake).pickAndConnect();
      expect(link.keeper).toBeUndefined();
      const metas: Array<ChunkMeta | undefined> = [];
      link.onData((_channel, _chunk, meta) => metas.push(meta));
      fake.ring.pushReal(0x01, [88]);
      await new Promise((r) => setTimeout(r, 20));
      expect(metas).toEqual([undefined]);
    });

    it('armar el reflejo pasa el anillo, el canal de órdenes, si se escribe con respuesta y la trama con la que se pide el pulso', async () => {
      const fake = new FakeBle();
      const keeper = keeperFor(fake);
      const link = await transport(fake, true, undefined, keeper).pickAndConnect();
      await link.keeper?.arm(Uint8Array.from([3, 0x2f, 8, 0, 1, 0, 0xaa, 0xbb]));
      expect(keeper.arm).toHaveBeenCalledWith({
        deviceId: 'AA:BB:CC:DD:EE:FF',
        service: YCBT_SERVICE,
        command: YCBT_COMMAND_CHAR,
        withResponse: true,
        startHr: Uint8Array.from([3, 0x2f, 8, 0, 1, 0, 0xaa, 0xbb]),
      });
      await link.keeper?.disarm();
      expect(keeper.disarm).toHaveBeenCalledTimes(1);

      // Una característica de órdenes que solo admite escribir sin respuesta se arma así.
      const onlyWithout = new FakeBle();
      const command = onlyWithout.services[0]?.characteristics[0];
      if (command) (command as { properties: unknown }).properties = { write: false, writeWithoutResponse: true, notify: false, indicate: true, read: false, broadcast: false, authenticatedSignedWrites: false };
      const keeper2 = keeperFor(onlyWithout);
      const link2 = await transport(onlyWithout, true, undefined, keeper2).pickAndConnect();
      await link2.keeper?.arm(Uint8Array.from([1]));
      expect(keeper2.arm.mock.calls[0]?.[0].withResponse).toBe(false);
    });

    it('si el lado nativo no puede ponerse a oír, el enlace se abre igual (la web recibe los avisos de siempre)', async () => {
      const fake = new FakeBle();
      const keeper = keeperFor(fake);
      keeper.prepare.mockRejectedValueOnce(new Error('plugin no cargado'));
      const link = await transport(fake, true, undefined, keeper).pickAndConnect();
      expect(link.connected).toBe(true);
      const session = new YcbtSession(link, { timeouts: { reply: 300, header: 400, idle: 400 } });
      expect((await session.open()).firmware).toBe('2.32');
      await session.close();
    });
  });

  it('escribe con respuesta si la característica lo admite y sin respuesta si solo admite eso', async () => {
    const withResponse = new FakeBle();
    const link = await transport(withResponse).pickAndConnect();
    await link.write(Uint8Array.from([1, 2, 3]));
    expect(withResponse.calls).toContain('write be940001');

    const onlyWithout = new FakeBle();
    const command = onlyWithout.services[0]?.characteristics[0];
    if (command) (command as { properties: unknown }).properties = { write: false, writeWithoutResponse: true, notify: false, indicate: true, read: false, broadcast: false, authenticatedSignedWrites: false };
    const link2 = await transport(onlyWithout).pickAndConnect();
    await link2.write(Uint8Array.from([1, 2, 3]));
    expect(onlyWithout.calls).toContain('writeWithoutResponse be940001');
  });

  it('copia lo que recibe: el plugin puede reutilizar el búfer de la notificación', async () => {
    const fake = new FakeBle();
    const link = await transport(fake).pickAndConnect();
    const seen: Uint8Array[] = [];
    link.onData((_channel, chunk) => seen.push(chunk));
    const shared = Uint8Array.from([1, 2, 3, 4]);
    // Se entrega el mismo búfer dos veces con distinto contenido, como podría hacer el plugin.
    fake['callbacks'].get(YCBT_COMMAND_CHAR)?.(new DataView(shared.buffer));
    shared.set([9, 9, 9, 9]);
    fake['callbacks'].get(YCBT_COMMAND_CHAR)?.(new DataView(shared.buffer));
    expect(seen.map((c) => [...c])).toEqual([[1, 2, 3, 4], [9, 9, 9, 9]]);
  });

  it('el anillo que pierde la conexión se avisa una sola vez; cerrar desde la app también avisa aunque el plugin no lo haga', async () => {
    const lost = new FakeBle();
    const link = await transport(lost).pickAndConnect();
    let calls = 0;
    link.onDisconnect(() => calls++);
    lost.ring.simulateLinkLoss();
    await Promise.resolve();
    expect(link.connected).toBe(false);
    await link.disconnect(); // ya estaba caída: no hace nada más
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);

    const quiet = new FakeBle();
    quiet.silentDisconnect = true;
    const link2 = await transport(quiet).pickAndConnect();
    let calls2 = 0;
    link2.onDisconnect(() => calls2++);
    await link2.disconnect();
    await link2.disconnect(); // idempotente
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls2).toBe(1);
    expect(link2.connected).toBe(false);
  });

  it('si el dispositivo no habla YCBT, se cierra la conexión y se dice por qué', async () => {
    const fake = new FakeBle();
    fake.services = [
      {
        uuid: '0000180f-0000-1000-8000-00805f9b34fb',
        characteristics: [{ uuid: '00002a19-0000-1000-8000-00805f9b34fb', properties: { read: true, notify: true, write: false, writeWithoutResponse: false, indicate: false, broadcast: false, authenticatedSignedWrites: false }, descriptors: [] }],
      },
    ];
    await expect(transport(fake).pickAndConnect()).rejects.toMatchObject({ code: 'protocol' });
    expect(fake.calls).toContain('disconnect');
  });

  it('si no habla YCBT, el mensaje lleva la tabla GATT que sí ofrece (para corregir los identificadores sin el anillo)', async () => {
    const fake = new FakeBle();
    fake.services = [
      {
        uuid: '0000180f-0000-1000-8000-00805f9b34fb',
        characteristics: [{ uuid: '00002a19-0000-1000-8000-00805f9b34fb', properties: { read: true, notify: true, write: false, writeWithoutResponse: false, indicate: false, broadcast: false, authenticatedSignedWrites: false }, descriptors: [] }],
      },
    ];
    await expect(transport(fake).pickAndConnect()).rejects.toMatchObject({
      message: expect.stringContaining('Ofrece: 0000180f-0000-1000-8000-00805f9b34fb [00002a19-0000-1000-8000-00805f9b34fb:read+notify]'),
    });
    const none = new FakeBle();
    none.services = [];
    await expect(transport(none).pickAndConnect()).rejects.toMatchObject({ message: expect.stringContaining('Ofrece: ningún servicio') });
    // El servicio está pero falta una característica: también se ve lo que hay.
    const partial = new FakeBle();
    partial.services = [{ uuid: YCBT_SERVICE, characteristics: [{ uuid: YCBT_COMMAND_CHAR, properties: { write: true, indicate: false, notify: false, read: false, writeWithoutResponse: false, broadcast: false, authenticatedSignedWrites: false }, descriptors: [] }] }];
    await expect(transport(partial).pickAndConnect()).rejects.toMatchObject({ message: expect.stringContaining(`${YCBT_COMMAND_CHAR}:write]`) });
  });

  it('si no se puede conectar, el error explica qué comprobar; cancelar el selector es «sin anillo», no un fallo', async () => {
    const fake = new FakeBle();
    fake.connectError = new Error('Connection timeout.');
    await expect(transport(fake).pickAndConnect()).rejects.toMatchObject({ code: 'connect-failed', message: expect.stringContaining('Smart Health está cerrada') });

    const cancelled = new FakeBle();
    cancelled.pickError = new Error('requestDevice cancelled.');
    await expect(transport(cancelled).pickAndConnect()).rejects.toMatchObject({ code: 'no-device' });
    const empty = new FakeBle();
    empty.pickError = new Error('No device found.');
    await expect(transport(empty).pickAndConnect()).rejects.toMatchObject({ code: 'no-device' });
  });

  it('sin permisos, Bluetooth apagado o ubicación apagada, falla con un mensaje claro y sin buscar', async () => {
    const denied = new FakeBle();
    denied.initializeError = new Error('Permission denied.');
    await expect(transport(denied).pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('permiso') });

    const off = new FakeBle();
    off.enabled = false;
    await expect(transport(off).pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('Bluetooth del móvil está apagado') });
    expect(off.calls.some((c) => c.startsWith('requestDevice'))).toBe(false);

    const noLocation = new FakeBle();
    noLocation.locationEnabled = false;
    await expect(transport(noLocation).pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('ubicación') });
  });

  it('fuera de Android no está disponible y lo explica', async () => {
    const t = transport(new FakeBle(), false);
    expect(t.available).toBe(false);
    expect(t.unavailableReason).toMatch(/app de Android/);
    await expect(t.pickAndConnect()).rejects.toBeInstanceOf(RingError);
    expect(await t.reconnect({ id: 'x', name: 'y' })).toBeNull();
  });

  it('«mostrar todos» no filtra por nombre; el filtro normal es por el prefijo R99', async () => {
    const fake = new FakeBle();
    await transport(fake).pickAndConnect();
    await transport(fake).pickAndConnect({ showAll: true });
    const picks = fake.calls.filter((c) => c.startsWith('requestDevice'));
    expect(picks[0]).toContain('"namePrefix":"R99"');
    expect(picks[1]).not.toContain('namePrefix');
    expect(picks[1]).toContain('"displayMode":"list"');
  });

  it('reconecta por identificador sin selector, y devuelve null (sin lanzar) si no se puede', async () => {
    const fake = new FakeBle();
    const link = await transport(fake).reconnect({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' });
    expect(link?.id).toBe('AA:BB:CC:DD:EE:FF');
    expect(link?.name).toBe('R99 F265');
    expect(fake.calls.some((c) => c.startsWith('requestDevice'))).toBe(false);

    const away = new FakeBle();
    away.connectError = new Error('Connection timeout.');
    expect(await transport(away).reconnect({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' })).toBeNull();
  });

  it('la búsqueda junta lo que llega en varios anuncios (nombre, servicios, datos de fabricante) y ordena por señal', async () => {
    const fake = new FakeBle();
    fake.scanResults = [
      { device: { deviceId: 'A', name: undefined }, rssi: -80, manufacturerData: { '30736': view([1, 2]) } },
      { device: { deviceId: 'B', name: 'Auriculares' }, rssi: -50 },
      { device: { deviceId: 'A', name: undefined }, localName: 'R99 F265', rssi: -60, uuids: ['be940000-7333-be46-b7ae-689e71722bd5'], rawAdvertisement: view([2, 1, 6]) },
    ];
    const found = await transport(fake).scan(1);
    expect(found.map((d) => d.id)).toEqual(['B', 'A']);
    expect(found[1]).toMatchObject({ name: 'R99 F265', rssi: -60, services: ['be940000-7333-be46-b7ae-689e71722bd5'], manufacturer: { '7810': '01 02' }, raw: '02 01 06' });
    expect(fake.calls.at(-1)).toBe('stopLEScan'); // siempre se detiene la búsqueda
  });

  it('los detalles de la conexión incluyen la tabla GATT con las propiedades de cada característica, el MTU y la señal', async () => {
    const link = await transport(new FakeBle()).pickAndConnect();
    const details = await link.details?.();
    expect(details?.mtu).toBe(247);
    expect(details?.rssi).toBe(-61);
    expect(details?.gatt[0]?.service).toBe(YCBT_SERVICE);
    expect(details?.gatt[0]?.characteristics.find((c) => c.uuid === YCBT_COMMAND_CHAR)?.properties).toEqual(['write', 'indicate']);
  });

  it('el entorno informa de Bluetooth y ubicación, y de por qué falló la preparación si falló', async () => {
    const fake = new FakeBle();
    fake.locationEnabled = false;
    expect(await transport(fake).environment()).toMatchObject({ native: true, initialize: 'ok', bluetoothEnabled: true, locationEnabled: false });
    const denied = new FakeBle();
    denied.initializeError = new Error('Permission denied.');
    expect((await transport(denied).environment()).initialize).toMatch(/error/);
  });

  it('el entorno incluye los permisos, quién tiene conectado el anillo y lo que el móvil tiene emparejado', async () => {
    const fake = new FakeBle();
    fake.connected = [{ deviceId: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' }];
    fake.bonded = [{ deviceId: '11:22:33:44:55:66' }];
    const t = transport(fake);
    expect(await t.environment()).toMatchObject({
      permissions: { sdk: 34, bluetoothScan: true, bluetoothConnect: true, fineLocation: true, coarseLocation: true },
      connectedDevices: [{ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' }],
      bondedDevices: [{ id: '11:22:33:44:55:66', name: null }],
    });
    expect(await t.connectedDevices()).toEqual([{ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' }]);
  });

  it('sin saber leer los dispositivos conectados o emparejados (plugin antiguo), el entorno sigue funcionando', async () => {
    const fake = new FakeBle();
    (fake as unknown as { getConnectedDevices?: unknown }).getConnectedDevices = undefined;
    (fake as unknown as { getBondedDevices?: unknown }).getBondedDevices = undefined;
    const env = await transport(fake).environment();
    expect(env.connectedDevices).toEqual([]);
    expect(env).not.toHaveProperty('bondedDevices');
  });

  describe('permisos', () => {
    it('los pide la app misma (ubicación precisa con la aproximada y «Dispositivos cercanos») ANTES de inicializar el plugin', async () => {
      const fake = new FakeBle();
      await transport(fake).pickAndConnect();
      const asked = fake.calls.indexOf('requestBlePermissions');
      expect(asked).toBeGreaterThanOrEqual(0);
      expect(asked).toBeLessThan(fake.calls.indexOf('initialize'));
    });

    it('con la ubicación ya concedida por la app, el plugin no la vuelve a pedir (su petición de la precisa sola no llega a buen puerto)', async () => {
      const fake = new FakeBle();
      await transport(fake).pickAndConnect();
      expect(fake.initializeOptions).toEqual([{ androidNeverForLocation: true }]);
    });

    it('si la petición propia no da un resultado fiable, el plugin pide sus permisos como siempre', async () => {
      const fake = new FakeBle();
      const tools = new FakeTools(fake.calls);
      tools.requestError = new Error('NativeTools no disponible');
      await transport(fake, true, tools).pickAndConnect();
      expect(fake.initializeOptions).toEqual([{ androidNeverForLocation: false }]);
    });

    it('las notas dicen cuánto tardó cada petición (para ver dónde se atasca)', async () => {
      const fake = new FakeBle();
      const t = transport(fake);
      await t.pickAndConnect();
      const notes = t.takeNotes();
      expect(notes[0]).toMatch(/^petición de permisos de la app: \d+ ms, \{/);
      expect(notes[1]).toMatch(/^inicialización del plugin \(sin pedir ubicación: sí\): \d+ ms$/);
    });

    it('solo se piden una vez si salen bien', async () => {
      const fake = new FakeBle();
      const t = transport(fake);
      await t.pickAndConnect();
      await t.scan(1);
      expect(fake.calls.filter((c) => c === 'requestBlePermissions')).toHaveLength(1);
      expect(fake.calls.filter((c) => c === 'initialize')).toHaveLength(1);
    });

    it('si esa petición propia falla, se sigue con el plugin y queda apuntado', async () => {
      const fake = new FakeBle();
      const tools = new FakeTools(fake.calls);
      tools.requestError = new Error('NativeTools no disponible');
      const t = transport(fake, true, tools);
      expect((await t.pickAndConnect()).connected).toBe(true);
      expect(t.takeNotes().filter((note) => note.includes('NativeTools no disponible'))).toHaveLength(1);
      expect(t.takeNotes()).toEqual([]); // se vacían al leerlas
    });

    it('si la petición propia deja un permiso sin conceder, falla enseguida diciendo cuál y sin volver a preguntar con el plugin', async () => {
      const fake = new FakeBle();
      const tools = new FakeTools(fake.calls);
      tools.status = { ...tools.status, fineLocation: false, coarseLocation: true }; // eligió «aproximada»
      const t = transport(fake, true, tools);
      await expect(t.pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('«Ubicación» precisa') });
      expect(fake.calls).not.toContain('initialize'); // dos negativas seguidas harían que Android dejara de preguntar
      tools.status = { sdk: 34, bluetoothScan: false, bluetoothConnect: false, fineLocation: true, coarseLocation: true };
      await expect(t.pickAndConnect()).rejects.toMatchObject({ message: expect.stringContaining('«Dispositivos cercanos»') });
      tools.status = { sdk: 34, bluetoothScan: true, bluetoothConnect: true, fineLocation: true, coarseLocation: true };
      expect((await t.pickAndConnect()).connected).toBe(true); // al reintentar, se pide otra vez y sale
      expect(fake.calls.filter((c) => c === 'requestBlePermissions')).toHaveLength(3);
    });

    it('en Android 11 o anterior (sin «Dispositivos cercanos») solo cuenta la ubicación', async () => {
      const fake = new FakeBle();
      const tools = new FakeTools(fake.calls);
      tools.status = { sdk: 30, fineLocation: true, coarseLocation: true } as typeof tools.status;
      expect((await transport(fake, true, tools).pickAndConnect()).connected).toBe(true);
    });

    it('si se deniegan, el aviso lo dice y el siguiente intento vuelve a pedirlos', async () => {
      const fake = new FakeBle();
      fake.initializeError = new Error('Permission denied.');
      const t = transport(fake);
      await expect(t.pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('permiso') });
      fake.initializeError = null;
      expect((await t.pickAndConnect()).connected).toBe(true);
      expect(fake.calls.filter((c) => c === 'requestBlePermissions')).toHaveLength(2);
    });
  });

  describe('reconexión', () => {
    const saved = { id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' };

    it('si la primera conexión falla (estado 133 al volver a conectar enseguida), lo intenta una segunda vez y lo apunta', async () => {
      const fake = new FakeBle();
      fake.connectFailures = [new Error('Connection failed with status 133 (GATT_ERROR).')];
      const t = transport(fake);
      const link = await t.reconnect(saved);
      expect(link?.connected).toBe(true);
      expect(fake.calls.filter((c) => c === 'connect')).toHaveLength(2);
      expect(t.takeNotes().filter((note) => note.startsWith('reconexión'))).toEqual([expect.stringMatching(/intento 1 de 2 \(\d+ ms\): .*status 133/)]);
    });

    it('si fallan las dos, devuelve null con las dos causas anotadas', async () => {
      const fake = new FakeBle();
      fake.connectFailures = [new Error('Connection timeout.'), new Error('Connection failed with status 133 (GATT_ERROR).')];
      const t = transport(fake);
      expect(await t.reconnect(saved)).toBeNull();
      expect(fake.calls.filter((c) => c === 'connect')).toHaveLength(2);
      const notes = t.takeNotes().filter((note) => note.startsWith('reconexión'));
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain('intento 1 de 2');
      expect(notes[1]).toContain('intento 2 de 2');
    });

    it('una reconexión silenciosa (la automática del entreno) con el Bluetooth apagado no abre el aviso del sistema; la normal sí', async () => {
      const silent = new FakeBle();
      silent.enabled = false;
      // Lo dice (no devuelve `null`): quien llama sabe que no se gastó radio y que reintentar pronto no cuesta nada.
      await expect(transport(silent).reconnect(saved, { silent: true })).rejects.toMatchObject({ code: 'unsupported-platform' });
      expect(silent.calls).not.toContain('requestEnable');
      expect(silent.calls).not.toContain('connect');

      const loud = new FakeBle();
      loud.enabled = false;
      expect(await transport(loud).reconnect(saved)).toBeNull();
      expect(loud.calls).toContain('requestEnable');
    });

    it('una reconexión automática (silenciosa) no pregunta nada: sin los permisos ya concedidos no inicializa ni conecta, y la normal sí los pide', async () => {
      const fake = new FakeBle();
      const tools = new FakeTools(fake.calls);
      tools.status = { sdk: 34, bluetoothScan: false, bluetoothConnect: false, fineLocation: false, coarseLocation: false };
      await expect(transport(fake, true, tools).reconnect(saved, { silent: true })).rejects.toMatchObject({ code: 'unsupported-platform' });
      expect(fake.calls).toEqual([]); // ni petición de permisos, ni inicialización del plugin, ni conexión

      // Con los permisos ya concedidos, conecta como siempre.
      const granted = new FakeBle();
      const link = await transport(granted).reconnect(saved, { silent: true });
      expect(link?.connected).toBe(true);
      expect(granted.calls).toContain('connect');
      await link?.disconnect();
    });

    it('los intentos y el tiempo de espera de cada conexión se pueden acortar (la automática: uno solo y corto)', async () => {
      const fake = new FakeBle();
      fake.connectFailures = [new Error('Connection timeout.'), new Error('Connection timeout.')];
      const t = transport(fake);
      expect(await t.reconnect(saved, { attempts: 1, timeoutMs: 8000 })).toBeNull();
      expect(fake.calls.filter((c) => c === 'connect')).toHaveLength(1);
      expect(fake.connectOptions).toEqual([{ timeout: 8000 }]);
      expect(t.takeNotes().filter((n) => n.startsWith('reconexión'))).toEqual([expect.stringMatching(/intento 1 de 1/)]);

      // Sin pedir nada, lo de siempre: dos intentos de 15 s.
      const normal = new FakeBle();
      normal.connectFailures = [new Error('Connection timeout.')];
      await transport(normal).reconnect(saved);
      expect(normal.connectOptions).toEqual([{ timeout: 15000 }, { timeout: 15000 }]);
    });

    it('cancelar mientras aún conecta suelta el dispositivo, termina con null al momento y no lo anota como un fallo', async () => {
      const fake = new FakeBle();
      fake.hangConnect = true;
      const t = transport(fake);
      const abort = new AbortController();
      const connecting = t.reconnect(saved, { signal: abort.signal, attempts: 2 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.calls).toContain('connect');
      abort.abort();
      expect(await connecting).toBeNull();
      expect(fake.calls).toContain('disconnect');
      expect(fake.calls.filter((c) => c === 'connect')).toHaveLength(1); // no reintenta tras cancelar
      expect(t.takeNotes().filter((n) => n.startsWith('reconexión'))).toEqual([]);
    });

    it('con la cola del plugin real (el disconnect espera al connect en vuelo), cancelar no espera a que el connect acabe y el enlace tardío se suelta', async () => {
      const fake = new FakeBle();
      fake.hangConnect = true;
      fake.hangMs = 300; // el tiempo máximo del connect en vuelo
      fake.queuedDisconnect = true;
      const t = transport(fake);
      const abort = new AbortController();
      const started = Date.now();
      const connecting = t.reconnect(saved, { signal: abort.signal, attempts: 1, timeoutMs: 8000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      abort.abort();
      expect(await connecting).toBeNull();
      expect(Date.now() - started).toBeLessThan(200); // no esperó a los 300 ms del connect: quien pide el anillo no se queda esperando
      // Cuando el connect en vuelo acaba, se suelta (una sola vez) y no queda ningún enlace abierto.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(fake.calls.filter((c) => c === 'disconnect')).toHaveLength(1);
      expect(fake.ring.connected).toBe(false);
    });

    it('un connect que SÍ acaba conectando después de cancelar no deja el enlace abierto: se suelta en cuanto llega, una sola vez', async () => {
      const fake = new FakeBle();
      fake.connectDelayMs = 300;
      fake.queuedDisconnect = true;
      const t = transport(fake);
      const abort = new AbortController();
      const started = Date.now();
      const connecting = t.reconnect(saved, { signal: abort.signal, attempts: 1, timeoutMs: 8000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      abort.abort();
      expect(await connecting).toBeNull();
      expect(Date.now() - started).toBeLessThan(200);
      expect(fake.ring.connected).toBe(true); // el connect en vuelo aún no ha llegado…
      await new Promise((resolve) => setTimeout(resolve, 450));
      // …y cuando llega, conectado de verdad, se suelta.
      expect(fake.calls.filter((c) => c === 'disconnect')).toHaveLength(1);
      expect(fake.ring.connected).toBe(false);
    });

    it('cancelada antes de empezar, ni prepara el Bluetooth ni conecta', async () => {
      const fake = new FakeBle();
      const abort = new AbortController();
      abort.abort();
      expect(await transport(fake).reconnect(saved, { signal: abort.signal })).toBeNull();
      expect(fake.calls).toEqual([]);
    });

    it('sin permisos, con el Bluetooth apagado o con un dispositivo que no habla YCBT no insiste', async () => {
      const denied = new FakeBle();
      denied.initializeError = new Error('Permission denied.');
      const a = transport(denied);
      expect(await a.reconnect(saved)).toBeNull();
      expect(a.takeNotes().filter((n) => n.startsWith('reconexión'))).toHaveLength(1);

      const off = new FakeBle();
      off.enabled = false;
      const b = transport(off);
      expect(await b.reconnect(saved)).toBeNull();
      expect(off.calls).not.toContain('connect');

      const other = new FakeBle();
      other.services = [];
      expect(await transport(other).reconnect(saved)).toBeNull();
      expect(other.calls.filter((c) => c === 'connect')).toHaveLength(1);
    });
  });

  it('si connect() rechaza, cierra el enlace por si el plugin lo dejó abierto (sin dueño gastaría batería en el anillo)', async () => {
    const fake = new FakeBle();
    fake.connectFailures = [new Error('Failed to discover services.')];
    const t = transport(fake);
    await expect(t.connectTo({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' })).rejects.toMatchObject({ code: 'connect-failed' });
    const calls = fake.calls.filter((c) => c === 'connect' || c === 'disconnect');
    expect(calls).toEqual(['connect', 'disconnect']);
  });

  it('sin la ubicación del sistema se puede conectar a un anillo conocido (no hace falta), pero no buscar', async () => {
    const fake = new FakeBle();
    fake.locationEnabled = false;
    const t = transport(fake);
    const known = await t.reconnect({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' });
    expect(known?.connected).toBe(true);
    await known?.disconnect();
    const direct = await t.connectTo({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' });
    expect(direct.connected).toBe(true);
    await expect(t.scan(1)).rejects.toMatchObject({ code: 'unsupported-platform', message: expect.stringContaining('ubicación') });
    await expect(t.pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform' });
  });

  it('un emparejamiento cancelado por la persona no es «no has elegido anillo»: es un fallo de conexión con una pista', async () => {
    const fake = new FakeBle();
    fake.connectError = new Error('Pairing request was cancelled by the user.');
    await expect(transport(fake).pickAndConnect()).rejects.toMatchObject({ code: 'connect-failed', message: expect.stringContaining('emparejar') });
  });

describe('lo que tarda cada paso del enlace (la conexión llegó a 17 s sin saber por qué)', () => {
  it('linkTiming lo cuenta en una línea y omite lo que no se midió', () => {
    expect(linkTiming({ connect: 14200, services: 380, keeper: 4, notifications: 510 })).toBe('enlace: conectar 14200 ms · servicios 380 ms · reflejo 4 ms · avisos 510 ms');
    expect(linkTiming({ connect: 90 })).toBe('enlace: conectar 90 ms');
  });

  it('una conexión que sale bien deja la nota con los tiempos de sus pasos', async () => {
    const t = transport(new FakeBle(), true, undefined, { prepare: async () => undefined, arm: async () => undefined, disarm: async () => undefined });
    const link = await t.reconnect({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' });
    expect(link?.connected).toBe(true);
    expect(t.takeNotes().filter((n) => n.startsWith('enlace'))).toEqual([expect.stringMatching(/^enlace: conectar \d+ ms · servicios \d+ ms · reflejo \d+ ms · avisos \d+ ms$/)]);
    await link?.disconnect();
  });
});

});
