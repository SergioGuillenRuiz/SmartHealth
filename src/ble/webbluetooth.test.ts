import { afterEach, describe, expect, it, vi } from 'vitest';
import { HISTORY } from './constants';
import { YcbtSession } from './session';
import { buildDemoDataset } from './sim/dataset';
import { createFakeBluetooth, type FakeBluetoothOptions } from './sim/fake-web-bluetooth';
import { SimulatedRing, type SimBehavior } from './sim/ring';
import { WebBluetoothTransport } from './webbluetooth';

const NOW = new Date(2026, 6, 10, 14, 30, 0).getTime();

function install(behavior: SimBehavior = {}, options: FakeBluetoothOptions = {}) {
  const rings: SimulatedRing[] = [];
  const fake = createFakeBluetooth(() => {
    const ring = new SimulatedRing(buildDemoDataset({ nowMs: NOW, days: 2, seed: 5 }), behavior);
    rings.push(ring);
    return ring;
  }, options);
  vi.stubGlobal('navigator', { bluetooth: fake });
  vi.stubGlobal('isSecureContext', true);
  return { fake, rings };
}

afterEach(() => vi.unstubAllGlobals());

describe('WebBluetoothTransport', () => {
  it('conecta, sincroniza el historial completo y se desconecta', async () => {
    const { rings } = install({ chunkSize: 20 });
    const transport = new WebBluetoothTransport();
    const link = await transport.pickAndConnect();
    expect(link.name).toBe('R99 F265');

    const session = new YcbtSession(link, { timeouts: { reply: 300, header: 500, idle: 500 } });
    const info = await session.open();
    expect(info.firmware).toBe('2.32');
    const result = await session.syncHistory();
    expect(result.outcomes.every((o) => o.status === 'ok')).toBe(true);
    expect(result.records.heart.length).toBeGreaterThan(10);

    await session.close();
    expect(link.connected).toBe(false);
    expect(rings[0]?.connected).toBe(false);
  });

  it('filtra por nombre R99 / fabricante Yucheng y declara el servicio como opcional', async () => {
    const { fake } = install();
    await new WebBluetoothTransport().pickAndConnect();
    const request = fake.requests[0] as { filters?: unknown[]; optionalServices?: string[] };
    expect(request.filters).toContainEqual({ namePrefix: 'R99' });
    expect(request.filters).toContainEqual({ manufacturerData: [{ companyIdentifier: 0x7810 }] });
    expect(request.optionalServices).toContain('be940000-7333-be46-b7ae-689e71722bd5');
  });

  it('con "mostrar todos" acepta cualquier dispositivo', async () => {
    const { fake } = install();
    await new WebBluetoothTransport().pickAndConnect({ showAll: true });
    expect((fake.requests[0] as { acceptAllDevices?: boolean }).acceptAllDevices).toBe(true);
  });

  it('si el usuario cierra el selector, el error es no-device', async () => {
    install({}, { cancelPicker: true });
    await expect(new WebBluetoothTransport().pickAndConnect()).rejects.toMatchObject({ code: 'no-device' });
  });

  it('si la conexión GATT falla, el mensaje menciona la app oficial abierta', async () => {
    install({}, { failConnect: true });
    const error = await new WebBluetoothTransport().pickAndConnect().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'connect-failed' });
    expect((error as Error).message).toMatch(/Smart Health/);
  });

  it('un dispositivo sin el servicio YCBT se reconoce como otro protocolo', async () => {
    install({}, { hideService: true });
    await expect(new WebBluetoothTransport().pickAndConnect()).rejects.toMatchObject({ code: 'protocol' });
  });

  it('avisa a la sesión cuando el anillo se desconecta por su cuenta', async () => {
    const { rings } = install();
    const link = await new WebBluetoothTransport().pickAndConnect();
    const session = new YcbtSession(link, { timeouts: { reply: 300, header: 500, idle: 500 } });
    await session.open();
    rings[0]?.simulateLinkLoss();
    await new Promise((r) => setTimeout(r, 10));
    expect(session.isOpen).toBe(false);
  });

  it('sin la API Bluetooth explica el motivo en lugar de fallar con un error técnico', async () => {
    vi.stubGlobal('navigator', {});
    const transport = new WebBluetoothTransport();
    expect(transport.available).toBe(false);
    expect(transport.unavailableReason).toMatch(/Chrome/);
    await expect(transport.pickAndConnect()).rejects.toMatchObject({ code: 'unsupported-platform' });
  });

  it('reconnect devuelve null cuando el navegador no tiene getDevices', async () => {
    install({}, { noGetDevices: true });
    expect(await new WebBluetoothTransport().reconnect({ id: 'x', name: 'R99 F265' })).toBeNull();
  });

  it('las escrituras GATT se hacen en serie aunque la sesión encole varias a la vez', async () => {
    install();
    const link = await new WebBluetoothTransport().pickAndConnect();
    const session = new YcbtSession(link, { timeouts: { reply: 300, header: 500, idle: 500 } });
    // open() y configure() escriben varias órdenes seguidas; si no se serializaran, el GATT falso lanzaría NetworkError.
    await session.open();
    await session.configure({ user: { heightCm: 180, weightKg: 75, male: true, age: 40 }, heartIntervalMin: 60, spo2IntervalMin: 60 });
    await session.syncHistory([HISTORY.heart]);
    await session.close();
  });
});
