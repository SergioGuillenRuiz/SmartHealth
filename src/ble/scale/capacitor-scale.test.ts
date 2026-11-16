import { describe, expect, it, vi } from 'vitest';
import type { BleService, ScanResult } from '@capacitor-community/bluetooth-le';
import { CapacitorBleTransport, type BleApi } from '../capacitor-ble';
import { RingError } from '../errors';
import { CapacitorScaleTransport } from './capacitor-scale';

const view = (bytes: ArrayLike<number>): DataView => new DataView(Uint8Array.from(bytes).buffer);
const props = (over: Partial<Record<'notify' | 'indicate' | 'read' | 'write', boolean>> = {}): BleService['characteristics'][number]['properties'] => ({
  broadcast: false,
  read: false,
  writeWithoutResponse: false,
  write: false,
  notify: false,
  indicate: false,
  authenticatedSignedWrites: false,
  ...over,
});

/** Un «Android» falso con lo justo para la báscula: una báscula con un servicio de avisos, y lo que se le pida. */
class FakeBle {
  calls: string[] = [];
  scanCallback: ((result: ScanResult) => void) | null = null;
  connectFailures: Error[] = [];
  services: BleService[] = [
    { uuid: '00001800-0000-1000-8000-00805f9b34fb', characteristics: [{ uuid: '00002a05-0000-1000-8000-00805f9b34fb', properties: props({ indicate: true }), descriptors: [] }] },
    {
      uuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
      characteristics: [
        { uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', properties: props({ notify: true }), descriptors: [] },
        { uuid: '0000ffe2-0000-1000-8000-00805f9b34fb', properties: props({ write: true }), descriptors: [] },
        { uuid: '0000ffe3-0000-1000-8000-00805f9b34fb', properties: props({ indicate: true, read: true }), descriptors: [] },
      ],
    },
  ];
  callbacks = new Map<string, (value: DataView) => void>();
  onDisconnect: ((id: string) => void) | null = null;
  failNotify = new Set<string>();

  async initialize(): Promise<void> {}
  async isEnabled(): Promise<boolean> {
    return true;
  }
  async requestEnable(): Promise<void> {}
  async isLocationEnabled(): Promise<boolean> {
    return true;
  }
  async requestLEScan(_options: unknown, callback: (result: ScanResult) => void): Promise<void> {
    this.calls.push('requestLEScan');
    this.scanCallback = callback;
  }
  async stopLEScan(): Promise<void> {
    this.calls.push('stopLEScan');
    this.scanCallback = null;
  }
  async connect(_id: string, onDisconnect?: (id: string) => void): Promise<void> {
    this.calls.push('connect');
    const failure = this.connectFailures.shift();
    if (failure) throw failure;
    this.onDisconnect = onDisconnect ?? null;
  }
  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
  }
  async getServices(): Promise<BleService[]> {
    return this.services;
  }
  async getMtu(): Promise<number> {
    return 185;
  }
  async readRssi(): Promise<number> {
    return -52;
  }
  async startNotifications(_id: string, service: string, characteristic: string, callback: (value: DataView) => void): Promise<void> {
    if (this.failNotify.has(characteristic)) throw new Error('GATT error');
    this.calls.push(`notify ${service.slice(4, 8)}/${characteristic.slice(4, 8)}`);
    this.callbacks.set(characteristic, callback);
  }
  async stopNotifications(_id: string, _service: string, characteristic: string): Promise<void> {
    this.calls.push(`stopNotify ${characteristic.slice(4, 8)}`);
  }
  // Lo que el transporte del anillo pide y la báscula no usa.
  async requestDevice(): Promise<never> {
    throw new Error('no se usa');
  }
  async getDevices(): Promise<[]> {
    return [];
  }
  async write(): Promise<void> {}
  async writeWithoutResponse(): Promise<void> {}

  /** Un anuncio de un dispositivo, como lo daría el plugin. */
  advert(id: string, over: Partial<ScanResult> = {}): ScanResult {
    return { device: { deviceId: id, name: undefined as unknown as string }, rssi: -60, localName: undefined, uuids: [], manufacturerData: {}, serviceData: {}, ...over } as ScanResult;
  }
}

const permissions = {
  requestBlePermissions: async () => ({ bluetoothScan: true, bluetoothConnect: true, fineLocation: true }),
  permissionStatus: async () => ({ bluetoothScan: true, bluetoothConnect: true, fineLocation: true }),
};

function make(ble = new FakeBle()): { ble: FakeBle; scale: CapacitorScaleTransport } {
  const base = new CapacitorBleTransport(ble as unknown as BleApi, true, permissions, 0, null);
  let t = 1_000;
  return { ble, scale: new CapacitorScaleTransport(base, () => (t += 10)) };
}

describe('CapacitorScaleTransport', () => {
  it('busca, junta los anuncios de cada dispositivo, ordena por señal y cierra la búsqueda', async () => {
    vi.useFakeTimers();
    try {
      const { ble, scale } = make();
      const done = scale.scan(3_000);
      await vi.advanceTimersByTimeAsync(10);
      ble.scanCallback?.(ble.advert('AA:01', { localName: 'RENPHO-SCALE', rssi: -48, uuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'] }));
      ble.scanCallback?.(ble.advert('AA:02', { rssi: -80, manufacturerData: { 76: view([0x10, 0x05]) } }));
      ble.scanCallback?.(ble.advert('AA:01', { rssi: -45, manufacturerData: { 65535: view([0xaa, 0xbb, 0x01, 0x63]) }, serviceData: { '0000ffe0-0000-1000-8000-00805f9b34fb': view([0x01]) } }));
      await vi.advanceTimersByTimeAsync(3_000);
      const found = await done;
      expect(found.map((d) => d.id)).toEqual(['AA:01', 'AA:02']);
      expect(found[0]).toMatchObject({ name: 'RENPHO-SCALE', rssi: -45, services: ['ffe0'], manufacturer: { ffff: 'aa bb 01 63' }, serviceData: { ffe0: '01' } });
      expect(found[1]?.manufacturer).toEqual({ '004c': '10 05' });
      expect(ble.calls.filter((c) => c === 'stopLEScan')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('se conecta y se suscribe a todo lo que avisa (sin el servicio genérico) y entrega las tramas con su fuente', async () => {
    const { ble, scale } = make();
    const link = await scale.connect({ id: 'AA:01', name: 'RENPHO-SCALE' });
    expect(link.subscribed).toEqual(['ffe0/ffe1', 'ffe0/ffe3']);
    expect(ble.calls.filter((c) => c.startsWith('notify'))).toEqual(['notify ffe0/ffe1', 'notify ffe0/ffe3']);
    const frames: Array<{ source: string; hex: string }> = [];
    link.onFrame((f) => frames.push({ source: f.source, hex: [...f.bytes].map((b) => b.toString(16).padStart(2, '0')).join('') }));
    ble.callbacks.get('0000ffe1-0000-1000-8000-00805f9b34fb')?.(view([0xa5, 0x01, 0x63]));
    ble.callbacks.get('0000ffe3-0000-1000-8000-00805f9b34fb')?.(view([0x07]));
    expect(frames).toEqual([
      { source: 'n:ffe0/ffe1', hex: 'a50163' },
      { source: 'n:ffe0/ffe3', hex: '07' },
    ]);
    const details = await link.details();
    expect(details.mtu).toBe(185);
    expect(details.gatt.map((g) => g.service)).toContain('0000ffe0-0000-1000-8000-00805f9b34fb');
  });

  it('una característica que no deja suscribirse no tira la conexión; si ninguna deja, dice qué ofrece', async () => {
    const { ble, scale } = make();
    ble.failNotify.add('0000ffe3-0000-1000-8000-00805f9b34fb');
    const link = await scale.connect({ id: 'AA:01', name: null });
    expect(link.subscribed).toEqual(['ffe0/ffe1']);

    const other = make();
    other.ble.services = [{ uuid: '0000ffb0-0000-1000-8000-00805f9b34fb', characteristics: [{ uuid: '0000ffb1-0000-1000-8000-00805f9b34fb', properties: props({ read: true, write: true }), descriptors: [] }] }];
    const error = await other.scale.connect({ id: 'AA:01', name: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RingError);
    expect((error as RingError).code).toBe('protocol');
    expect((error as RingError).message).toMatch(/ninguna característica de aviso.*0000ffb0/);
    expect(other.ble.calls).toContain('disconnect'); // no deja la conexión abierta
  });

  it('reintenta una vez si falla la primera conexión, y si siguen fallando explica qué hacer', async () => {
    vi.useFakeTimers();
    try {
      const first = make();
      first.ble.connectFailures = [new Error('GATT 133')];
      const pending = first.scale.connect({ id: 'AA:01', name: null });
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).connected).toBe(true);
      expect(first.ble.calls.filter((c) => c === 'connect')).toHaveLength(2);

      const second = make();
      second.ble.connectFailures = [new Error('GATT 133'), new Error('GATT 133')];
      const failed = second.scale.connect({ id: 'AA:01', name: null }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(4_000);
      const error = (await failed) as RingError;
      expect(error).toBeInstanceOf(RingError);
      expect(error.message).toMatch(/Enciéndela.*app de RENPHO/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('avisa cuando la báscula se desconecta y al cerrar da de baja los avisos', async () => {
    const { ble, scale } = make();
    const link = await scale.connect({ id: 'AA:01', name: null });
    const dropped = vi.fn();
    link.onDisconnect(dropped);
    ble.onDisconnect?.('AA:01');
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(link.connected).toBe(false);

    const again = await make().scale.connect({ id: 'AA:01', name: null });
    await again.disconnect();
    await again.disconnect(); // idempotente
    expect(again.connected).toBe(false);
  });

  it('escuchar anuncios de un dispositivo y buscar comparten una sola búsqueda; se cierra al irse el último', async () => {
    vi.useFakeTimers();
    try {
      const { ble, scale } = make();
      const seen: string[] = [];
      const stop = await scale.watch('AA:01', (a) => seen.push(`${a.id}:${a.manufacturer.ffff ?? ''}`));
      const scanning = scale.scan(1_000);
      await vi.advanceTimersByTimeAsync(10);
      ble.scanCallback?.(ble.advert('AA:01', { manufacturerData: { 65535: view([1, 2]) } }));
      ble.scanCallback?.(ble.advert('AA:09'));
      await vi.advanceTimersByTimeAsync(1_000);
      await scanning;
      expect(ble.calls.filter((c) => c === 'requestLEScan')).toHaveLength(1);
      expect(ble.calls).not.toContain('stopLEScan'); // aún escucha el que vigila
      expect(seen).toEqual(['AA:01:01 02']);
      stop();
      await vi.advanceTimersByTimeAsync(10);
      expect(ble.calls).toContain('stopLEScan');
    } finally {
      vi.useRealTimers();
    }
  });
});
