import { describe, expect, it, vi } from 'vitest';
import type { PluginListenerHandle } from '@capacitor/core';
import { withNotificationMeta, type NotificationPlugin } from './ble-meta';

type Event = { value?: string; seq?: number; at?: number; restartAt?: number; reflexed?: boolean };

/** El plugin de Bluetooth, a bajo nivel: un evento por clave y quien lo oye. */
function fakePlugin() {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const removed: string[] = [];
  const plugin: NotificationPlugin = {
    async addListener(eventName, listener) {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
      const handle: PluginListenerHandle = {
        async remove() {
          removed.push(eventName);
          listeners.set(eventName, (listeners.get(eventName) ?? []).filter((l) => l !== listener));
        },
      };
      return handle;
    },
  };
  const emit = (key: string, event: Event): void => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener(event);
  };
  return { plugin, emit, removed, count: (key: string) => listeners.get(key)?.length ?? 0 };
}

const KEY = 'notification|AA:BB|svc|chr';

describe('withNotificationMeta', () => {
  it('oye el evento del plugin ANTES de pedir las notificaciones al cliente, y entrega los bytes con lo que añadió el lado nativo', async () => {
    const { plugin, emit, count } = fakePlugin();
    const order: string[] = [];
    const client = {
      startNotifications: vi.fn(async () => void order.push(`client.start (oyentes: ${count(KEY)})`)),
      stopNotifications: vi.fn(async () => undefined),
    };
    const notes = withNotificationMeta(client, plugin);
    const received: Array<{ bytes: number[]; meta: unknown }> = [];
    await notes.startNotifications('AA:BB', 'svc', 'chr', (value, meta) => received.push({ bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)], meta }));
    expect(order).toEqual(['client.start (oyentes: 1)']);
    expect(client.startNotifications).toHaveBeenCalledWith('AA:BB', 'svc', 'chr', expect.any(Function), undefined);

    emit(KEY, { value: '040E0700FF', seq: 5, at: 1_700_000_000_123, restartAt: 1_700_000_000_000, reflexed: true });
    expect(received).toEqual([{ bytes: [0x04, 0x0e, 0x07, 0x00, 0xff], meta: { seq: 5, atMs: 1_700_000_000_123, restartAtMs: 1_700_000_000_000, reflexed: true } }]);
  });

  it('el oyente que se le da al cliente no hace nada (si no, cada aviso llegaría dos veces)', async () => {
    const { plugin } = fakePlugin();
    let clientCallback: ((value: DataView) => void) | undefined;
    const client = {
      startNotifications: vi.fn(async (_d: string, _s: string, _c: string, callback: (value: DataView) => void) => void (clientCallback = callback)),
      stopNotifications: vi.fn(async () => undefined),
    };
    const delivered = vi.fn();
    await withNotificationMeta(client as never, plugin).startNotifications('AA:BB', 'svc', 'chr', delivered);
    clientCallback?.(new DataView(new ArrayBuffer(2)));
    expect(delivered).not.toHaveBeenCalled();
  });

  it('un aviso sin lo que añade el lado nativo (un plugin sin el reflejo) llega sin meta', async () => {
    const { plugin, emit } = fakePlugin();
    const client = { startNotifications: vi.fn(async () => undefined), stopNotifications: vi.fn(async () => undefined) };
    const seen: unknown[] = [];
    await withNotificationMeta(client as never, plugin).startNotifications('AA:BB', 'svc', 'chr', (_value, meta) => seen.push(meta));
    emit(KEY, { value: '0102' });
    emit(KEY, { value: '0102', seq: 3 }); // sin hora tampoco vale
    expect(seen).toEqual([undefined, undefined]);
  });

  it('sin reinicio ni marca de atendido, esos campos valen 0 y falso', async () => {
    const { plugin, emit } = fakePlugin();
    const client = { startNotifications: vi.fn(async () => undefined), stopNotifications: vi.fn(async () => undefined) };
    const seen: unknown[] = [];
    await withNotificationMeta(client as never, plugin).startNotifications('AA:BB', 'svc', 'chr', (_value, meta) => seen.push(meta));
    emit(KEY, { value: '01', seq: 1, at: 99 });
    expect(seen).toEqual([{ seq: 1, atMs: 99, restartAtMs: 0, reflexed: false }]);
  });

  it('suscribirse otra vez a la misma característica no deja dos oyentes', async () => {
    const { plugin, emit, removed, count } = fakePlugin();
    const client = { startNotifications: vi.fn(async () => undefined), stopNotifications: vi.fn(async () => undefined) };
    const notes = withNotificationMeta(client as never, plugin);
    const seen: number[] = [];
    await notes.startNotifications('AA:BB', 'svc', 'chr', () => seen.push(1));
    await notes.startNotifications('AA:BB', 'svc', 'chr', () => seen.push(2));
    expect(removed).toEqual([KEY]);
    expect(count(KEY)).toBe(1);
    emit(KEY, { value: '01' });
    expect(seen).toEqual([2]);
  });

  it('parar quita el oyente propio y pide al cliente que pare', async () => {
    const { plugin, emit, removed, count } = fakePlugin();
    const client = { startNotifications: vi.fn(async () => undefined), stopNotifications: vi.fn(async () => undefined) };
    const notes = withNotificationMeta(client as never, plugin);
    const seen: number[] = [];
    await notes.startNotifications('AA:BB', 'svc', 'chr', () => seen.push(1));
    await notes.stopNotifications('AA:BB', 'svc', 'chr');
    expect(removed).toEqual([KEY]);
    expect(count(KEY)).toBe(0);
    expect(client.stopNotifications).toHaveBeenCalledWith('AA:BB', 'svc', 'chr');
    emit(KEY, { value: '01' });
    expect(seen).toEqual([]);
    // Parar algo que no estaba suscrito no falla.
    await expect(notes.stopNotifications('AA:BB', 'svc', 'otra')).resolves.toBeUndefined();
  });

  it('si el cliente no puede activar las notificaciones, no queda el oyente propio y el error sale', async () => {
    const { plugin, count } = fakePlugin();
    const client = { startNotifications: vi.fn(async () => Promise.reject(new Error('Setting notification failed.'))), stopNotifications: vi.fn(async () => undefined) };
    await expect(withNotificationMeta(client as never, plugin).startNotifications('AA:BB', 'svc', 'chr', () => undefined)).rejects.toThrow('Setting notification failed.');
    expect(count(KEY)).toBe(0);
  });
});
