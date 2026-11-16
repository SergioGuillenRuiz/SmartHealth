import type { ScaleTransport } from '../ble/scale/transport';
import type { RingTransport } from '../ble/transport';
import type { Store } from '../data/types';

/** Dependencias de la app, instaladas una vez al arrancar. Las pruebas instalan las suyas. */
export interface Services {
  store: Store;
  transport: RingTransport;
  /** El Bluetooth de la báscula de cocina (`undefined` donde no lo hay: un navegador sin la app). */
  scale?: ScaleTransport;
  now: () => number;
  /** `true` en modo demostración (datos de ejemplo y anillo simulado). */
  demo: boolean;
  /** Tiempos del sensor de pulso (ver `hr-cycle.ts`). Solo se tocan en la demostración, para que el anillo simulado responda al instante. */
  hrTiming?: { hrWarmupMs?: number; hrStreamAfterMs?: number };
}

let current: Services | undefined;

export function installServices(services: Services): void {
  current = services;
}

export function svc(): Services {
  if (!current) throw new Error('Los servicios de la app no están inicializados.');
  return current;
}
