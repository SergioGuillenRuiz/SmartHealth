import { BleClient, BluetoothLe, hexStringToDataView, type TimeoutOptions } from '@capacitor-community/bluetooth-le';
import type { PluginListenerHandle } from '@capacitor/core';
import type { ChunkMeta } from './transport';

/** El cliente Bluetooth nativo sin tocar (lo que cambia es solo cómo se reciben los avisos de una característica). */
type Client = typeof BleClient;

/** El plugin de Bluetooth a bajo nivel: lo único que se le pide aquí es oír un evento. */
export interface NotificationPlugin {
  addListener(eventName: string, listener: (event: { value?: string; seq?: number; at?: number; restartAt?: number; reflexed?: boolean }) => void): Promise<PluginListenerHandle>;
}

export interface MetaNotifications {
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView, meta?: ChunkMeta) => void,
    options?: TimeoutOptions,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
}

/** Lo que el lado nativo añade a un aviso (ver `TrackerPlugin.onRingNotification`), si lo añadió. */
function metaOf(event: { seq?: number; at?: number; restartAt?: number; reflexed?: boolean }): ChunkMeta | undefined {
  if (typeof event.seq !== 'number' || typeof event.at !== 'number') return undefined;
  return { seq: event.seq, atMs: event.at, restartAtMs: typeof event.restartAt === 'number' ? event.restartAt : 0, reflexed: event.reflexed === true };
}

/**
 * Las notificaciones de una característica entregando también lo que el lado nativo añade a cada una: su hora de recepción, su número de orden
 * y si el reflejo nativo ya la atendió (ver `ChunkMeta`). `BleClient.startNotifications` solo entrega los bytes, así que se pone un oyente
 * propio al evento del plugin (los oyentes de un mismo evento reciben el mismo objeto, con lo que añadió el lado nativo) y se le pide al
 * cliente lo demás —la cola de operaciones y activar las notificaciones en el anillo— con un oyente suyo que no hace nada.
 */
export function withNotificationMeta(client: Pick<Client, 'startNotifications' | 'stopNotifications'>, plugin: NotificationPlugin = BluetoothLe as unknown as NotificationPlugin): MetaNotifications {
  const handles = new Map<string, PluginListenerHandle>();
  const keyOf = (deviceId: string, service: string, characteristic: string): string => `notification|${deviceId}|${service}|${characteristic}`;
  return {
    async startNotifications(deviceId, service, characteristic, callback, options) {
      const key = keyOf(deviceId, service, characteristic);
      await handles.get(key)?.remove();
      handles.set(
        key,
        await plugin.addListener(key, (event) => {
          callback(hexStringToDataView(event.value ?? ''), metaOf(event));
        }),
      );
      try {
        await client.startNotifications(deviceId, service, characteristic, () => undefined, options);
      } catch (error) {
        await handles.get(key)?.remove();
        handles.delete(key);
        throw error;
      }
    },
    async stopNotifications(deviceId, service, characteristic) {
      const key = keyOf(deviceId, service, characteristic);
      const handle = handles.get(key);
      handles.delete(key);
      await handle?.remove();
      await client.stopNotifications(deviceId, service, characteristic);
    },
  };
}
