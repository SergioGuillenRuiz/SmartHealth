/** Canal GATT por el que llega un fragmento. */
export type Channel = 'command' | 'stream';

/**
 * Lo que el lado nativo de la app de Android sabe de un fragmento recibido (ver `TrackerPlugin.java` y `RingKeeper.java`). Con la pantalla
 * apagada el WebView puede quedar parado y procesar los fragmentos mucho después de que llegaran: la hora y lo que ya se hizo por ellos
 * los pone el proceso nativo, que no se para.
 */
export interface ChunkMeta {
  /** Número de orden del fragmento desde que se armó el reflejo nativo (1, 2, 3…). */
  seq: number;
  /** Cuándo llegó (ms, reloj de pared del móvil), medido por el proceso nativo. */
  atMs: number;
  /** Cuándo pidió el reflejo nativo la última medida de pulso (0: nunca). */
  restartAtMs: number;
  /** El reflejo nativo ya atendió este fragmento (confirmó los avisos y, si cerraba la medida de pulso, la volvió a pedir). */
  reflexed: boolean;
}

/**
 * El reflejo nativo del pulso (solo en la app de Android): mientras está armado y la web no contesta a los avisos del servicio del entreno,
 * el proceso nativo confirma los avisos del anillo y le vuelve a pedir el pulso con la trama dada, sin esperar a la web.
 */
export interface LinkKeeper {
  /** Arma el reflejo con la trama (ya enmarcada) con la que se pide la medida de pulso. */
  arm(startHeartRate: Uint8Array): Promise<void>;
  disarm(): Promise<void>;
}

/**
 * Un anillo ya conectado, con los DOS canales suscritos. Lo implementan Web Bluetooth, el BLE nativo
 * (Capacitor) y el anillo simulado, de modo que el protocolo no sabe qué hay debajo.
 */
export interface RingLink {
  /** Identificador opaco y estable del dispositivo (en web lo asigna el navegador). */
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  /** Escribe una trama ya enmarcada en el canal de órdenes. Se resuelve cuando el sistema la acepta. */
  write(data: Uint8Array): Promise<void>;
  /** Registra el receptor de fragmentos entrantes (con lo que el lado nativo sepa de cada uno, si lo hay); devuelve la función de baja. */
  onData(listener: (channel: Channel, chunk: Uint8Array, meta?: ChunkMeta) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  /** Cierra la conexión GATT. Idempotente. */
  disconnect(): Promise<void>;
  /** Tabla GATT, MTU y señal de la conexión, si la plataforma lo da (para el diagnóstico). */
  details?(): Promise<LinkDetails>;
  /** El reflejo nativo del pulso, si la plataforma lo tiene (la app de Android). */
  readonly keeper?: LinkKeeper;
}

/** Un dispositivo visto al buscar (solo donde la plataforma deja buscar sin el selector del sistema). */
export interface ScanEntry {
  id: string;
  name: string | null;
  rssi: number | null;
  /** UUID de los servicios que anuncia. */
  services: string[];
  /** Datos de fabricante: código de empresa (hex) → bytes en hexadecimal. */
  manufacturer: Record<string, string>;
  /** El anuncio completo en hexadecimal, si la plataforma lo da. */
  raw: string | null;
}

/** Lo que se sabe de una conexión abierta, para diagnosticar. */
export interface LinkDetails {
  /** Tabla GATT: servicios y características con sus propiedades. */
  gatt: Array<{ service: string; characteristics: Array<{ uuid: string; properties: string[] }> }>;
  mtu: number | null;
  rssi: number | null;
}

export interface SavedRing {
  id: string;
  name: string;
}

export interface PickOptions {
  /** Mostrar todos los dispositivos BLE en vez de filtrar por nombre (por si el anillo anuncia otro nombre). */
  showAll?: boolean;
}

export interface ReconnectOptions {
  /**
   * Sin diálogos del sistema: una reconexión automática (con el entreno en marcha) no debe abrir, por ejemplo, el aviso de
   * «activar Bluetooth» ni la petición de permisos cada pocos segundos. Si hay que preguntar algo, falla (y queda el botón
   * manual, que sí es un gesto).
   */
  silent?: boolean;
  /** Intentos de conexión antes de rendirse; por omisión, los que decida el transporte (dos en el nativo). */
  attempts?: number;
  /** Cuánto espera cada intento a que el anillo conteste, en ms; por omisión, lo que decida el transporte. */
  timeoutMs?: number;
  /** Cancela la reconexión: termina cuanto antes con `null` y sin dejar ningún enlace abierto. */
  signal?: AbortSignal;
}

export interface RingTransport {
  readonly kind: 'web-bluetooth' | 'native' | 'simulator';
  /** `false` si la plataforma no puede usar Bluetooth; la UI explica por qué en lugar de fallar. */
  readonly available: boolean;
  /** Motivo legible cuando `available` es `false`. */
  readonly unavailableReason?: string;
  /** Selector del sistema + conexión. En web debe invocarse desde un gesto del usuario. */
  pickAndConnect(options?: PickOptions): Promise<RingLink>;
  /**
   * Reconecta a un anillo ya conocido sin selector, si la plataforma lo permite; `null` si no. Con `silent`, si falta algo que
   * habría que preguntar (permisos, Bluetooth apagado) puede lanzar `unsupported-platform` en vez de devolver `null`.
   */
  reconnect(saved: SavedRing, options?: ReconnectOptions): Promise<RingLink | null>;
  /** Busca dispositivos durante `durationMs` y devuelve todos los que ve, sin selector. Solo donde la plataforma lo permite. */
  scan?(durationMs: number): Promise<ScanEntry[]>;
  /** Conecta a un dispositivo visto en `scan`, sin selector. */
  connectTo?(device: { id: string; name: string | null }): Promise<RingLink>;
  /** Estado de la plataforma para diagnosticar (Bluetooth y ubicación activados, permisos…). */
  environment?(): Promise<Record<string, unknown>>;
  /** Dispositivos con una conexión GATT abierta en este momento (de cualquier app): dice si el anillo lo tiene cogido alguien. */
  connectedDevices?(): Promise<Array<{ id: string; name: string | null }>>;
  /** Lo que el transporte ha ido anotando para el diagnóstico (p. ej. por qué falló un intento de reconexión); se vacía al leerlo. */
  takeNotes?(): string[];
}
