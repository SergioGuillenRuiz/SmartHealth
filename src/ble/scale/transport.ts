import { fromHex } from '../bytes';
import type { LinkDetails } from '../transport';
import type { ScaleFrame } from '../../domain/scale';

// Lo que la app necesita de «un Bluetooth» para hablar con la báscula de cocina. Lo implementan el BLE nativo de Android (`capacitor-scale.ts`) y una báscula simulada
// (`sim.ts`, para la demostración y las pruebas). Va aparte del transporte del anillo porque aquí NO se conoce el protocolo: no hay servicios ni órdenes que buscar, se
// escucha todo lo que el dispositivo cuente (avisos de todas sus características y datos de su anuncio) y la app averigua cuál es el peso (`domain/scale-learn.ts`).

/** Un anuncio de un dispositivo visto al buscar. */
export interface ScaleAdvert {
  id: string;
  name: string | null;
  rssi: number | null;
  /** UUID de los servicios que anuncia (en corto si son de 16 bits: «ffe0»). */
  services: string[];
  /** Datos de fabricante: código de empresa (hex, 4 cifras) → bytes en hexadecimal. */
  manufacturer: Record<string, string>;
  /** Datos de servicio: UUID → bytes en hexadecimal. */
  serviceData: Record<string, string>;
  /** El anuncio completo en hexadecimal, si la plataforma lo da. */
  raw: string | null;
  atMs: number;
}

/** Una conexión abierta con la báscula, con todas sus características de aviso suscritas. */
export interface ScaleLink {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  /** Las características a las que se suscribió (`servicio/característica`), para el informe. */
  readonly subscribed: readonly string[];
  /** Cada aviso recibido, con la fuente `n:<servicio>/<característica>`. */
  onFrame(listener: (frame: ScaleFrame) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  /** Tabla GATT, MTU y señal, para el diagnóstico. */
  details(): Promise<LinkDetails>;
  /** Cierra la conexión. Idempotente. */
  disconnect(): Promise<void>;
}

export interface ScaleConnectOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScaleTransport {
  readonly kind: 'native' | 'simulator' | 'none';
  /** `false` si la plataforma no puede usar Bluetooth (un navegador, por ejemplo): la interfaz explica por qué en lugar de fallar. */
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Busca dispositivos durante `durationMs` y devuelve los que ve (con `onSeen`, cada anuncio según llega). */
  scan(durationMs: number, onSeen?: (advert: ScaleAdvert) => void): Promise<ScaleAdvert[]>;
  connect(device: { id: string; name: string | null }, options?: ScaleConnectOptions): Promise<ScaleLink>;
  /** Escucha los anuncios de un dispositivo (se enciende al despertar la báscula, o lleva el peso en el anuncio). Devuelve la función que deja de escuchar. */
  watch(deviceId: string, onAdvert: (advert: ScaleAdvert) => void): Promise<() => void>;
  /** Estado de la plataforma para diagnosticar (Bluetooth y ubicación activados, permisos…). */
  environment?(): Promise<Record<string, unknown>>;
}

/** El UUID en corto si es de 16 bits («0000ffe1-0000-1000-8000-00805f9b34fb» → «ffe1»). */
export function shortUuid(uuid: string): string {
  const lower = uuid.toLowerCase();
  const match = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(lower);
  return match?.[1] ?? lower;
}

/** Las tramas que lleva un anuncio: una por cada dato de fabricante y de servicio, y el anuncio entero. */
export function advertFrames(advert: ScaleAdvert): ScaleFrame[] {
  const frames: ScaleFrame[] = [];
  const add = (source: string, hex: string): void => {
    try {
      const bytes = fromHex(hex);
      if (bytes.length > 0) frames.push({ source, bytes, atMs: advert.atMs });
    } catch {
      // un anuncio mal formado no debe romper nada
    }
  };
  for (const [company, hex] of Object.entries(advert.manufacturer)) add(`a:m:${company}`, hex);
  for (const [uuid, hex] of Object.entries(advert.serviceData)) add(`a:s:${shortUuid(uuid)}`, hex);
  if (advert.raw) add('a:r', advert.raw);
  return frames;
}

/** Un nombre que sugiere que el dispositivo es la báscula (para ponerlo el primero de la lista). */
export const LIKELY_SCALE_NAME = /renpho|es-?sng|sng\s?01|nutrition|scale|bascula|b[aá]scula|kitchen|food|qn-|ruiyi/i;
