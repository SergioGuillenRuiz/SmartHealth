import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** `true` dentro de la app instalada en Android (el contenedor nativo); `false` en el navegador y en las pruebas. */
export const isNative = (): boolean => Capacitor.isNativePlatform();

/** Qué permisos de ejecución tiene la app ahora mismo (los de Bluetooth cercano solo existen desde Android 12). */
export interface PermissionStatus {
  sdk: number;
  bluetoothScan?: boolean;
  bluetoothConnect?: boolean;
  fineLocation: boolean;
  coarseLocation: boolean;
}

/** Lo que la app necesita del sistema Android y no existe en la web: ver `NativeToolsPlugin.java`. */
export interface NativeToolsPlugin {
  /**
   * Guarda un texto como fichero en la carpeta pública Descargas (Android 10 o posterior). Con `uri` (la de un guardado
   * anterior) reescribe ese mismo fichero en vez de crear otro; si ya no existe, crea uno nuevo.
   */
  saveToDownloads(options: { filename: string; text: string; mime?: string; uri?: string }): Promise<{ uri: string; location: string }>;
  /** Abre el menú de compartir de Android con un fichero (por su `uri`) o con un texto. */
  share(options: { uri?: string; text?: string; title?: string; mime?: string }): Promise<void>;
  /** Mantiene la pantalla encendida mientras la app está delante. */
  keepScreenOn(options: { enabled: boolean }): Promise<void>;
  /**
   * Pide de una vez los permisos para buscar y conectar por Bluetooth: «Dispositivos cercanos» (Android 12 o posterior) y la
   * ubicación precisa JUNTO con la aproximada. El plugin de Bluetooth pide la precisa sola y Android 12 ignora esa petición.
   * Devuelve cómo quedan los permisos.
   */
  requestBlePermissions(): Promise<PermissionStatus>;
  /** Cómo están ahora los permisos de Bluetooth y ubicación (para el diagnóstico). */
  permissionStatus(): Promise<PermissionStatus>;
  /**
   * El acceso a cuándo se usa el móvil (el «acceso a datos de uso» de Android: pantalla encendida y desbloqueos, solo HORAS). Sin él, el sueño de las noches sin anillo se estima con menos
   * datos. `supported`: este Android lo ofrece; `granted`: la persona lo ha dado; `screenEvents`: el sistema da la pantalla encendida y apagada (Android 9 o posterior).
   */
  phoneActivityStatus(): Promise<{ supported: boolean; granted: boolean; screenEvents: boolean }>;
  /** Abre la pantalla de ajustes de Android donde se da el acceso a los datos de uso a esta app. */
  openPhoneActivitySettings(): Promise<void>;
  /**
   * Lo que hizo el móvil desde `sinceMs` hasta ahora: `uses` son los tramos con la pantalla encendida o la app en primer plano («inicio:fin;inicio:fin», ms), `firstMs` la hora del primer evento
   * que el sistema aún conserva (antes de eso no se sabe nada) y `offs` los tramos con el móvil apagado. Sin acceso, `granted: false` y nada más.
   */
  readPhoneActivity(options: { sinceMs: number }): Promise<{
    granted: boolean;
    fromMs: number;
    toMs: number;
    firstMs: number;
    uses: string;
    offs: string;
    /** Qué da este móvil: la hora del último evento y cuántos de pantalla, desbloqueo y apps delante (solo cifras). Una versión antigua de la parte nativa no los manda. */
    lastEventMs?: number;
    screenEvents?: number;
    unlockEvents?: number;
    appEvents?: number;
  }>;
  /** Programa la lectura periódica en segundo plano (cada hora, sin servicio permanente) para que lo del móvil no se pierda aunque no se abra la app. */
  schedulePhoneActivity(): Promise<void>;
}

export const NativeTools = registerPlugin<NativeToolsPlugin>('NativeTools');

/**
 * Una posición del GPS que recogió el servicio nativo: `[número, hora en ms (reloj de pared del móvil), latitud, longitud,
 * precisión (m), velocidad (m/s), altitud (m), precisión vertical (m), presión (hPa)]`. Lo que el móvil no dio va como `null`.
 */
export type RawTrackFix = [number, number, number, number, number | null, number | null, number | null, number | null, (number | null)?];

/** Cómo va la grabación de la ruta: ver `TrackerPlugin.java` y `TrackingService.java`. */
export interface TrackerState {
  /** El servicio está vivo ahora mismo. */
  running: boolean;
  /** Hay un entreno grabándose (el servicio vuelve a arrancar solo si el sistema lo cierra). */
  active: boolean;
  sessionId: string | null;
  startedAtMs: number;
  /** Número de la última posición recogida y su hora. */
  lastSeq: number;
  lastTsMs: number;
  /** El GPS del móvil está encendido. */
  gpsEnabled: boolean;
  /** Android no restringe la app en segundo plano. */
  batteryExempt: boolean;
  /** Por qué no se pudo grabar, si falló. */
  error?: string | null;
  /**
   * Cómo está el móvil, para explicar por qué se interrumpió una grabación con la pantalla apagada (ver `screen-off-report.ts`). Lo que el
   * móvil no sabe contestar va ausente.
   */
  powerSave?: boolean;
  idle?: boolean;
  bgRestricted?: boolean;
  /** El permiso de ubicación es «Permitir siempre». */
  bgLocation?: boolean;
  /** Xiaomi/Redmi/Poco: el «Inicio automático» de la app está activado (sin él el móvil cierra la app al apagar la pantalla). Ausente en otras marcas o si el móvil no lo deja leer. */
  autostart?: boolean;
  /** Cubo de uso de Android (10 activa … 45 restringida). */
  bucket?: number;
  /** Cuándo murió el motor web (el «renderizador» del WebView) del último entreno y si fue un fallo suyo o lo mató el sistema (sin memoria): Android cierra la app entera cuando pasa. Ausente si no ha pasado. */
  renderGoneAt?: number;
  renderGoneCrashed?: boolean;
}

/** Lo que trae cada aviso nativo del entreno (cada pocos segundos): ver `TrackerPlugin.tick`. */
export interface TrackerTick {
  /** La hora del móvil cuando el lado nativo mandó el aviso (ms): comparada con la de recibirlo, dice cuánto estuvo parado el WebView. */
  now?: number;
  /** El número del último aviso del anillo que vio el reflejo nativo. */
  seq?: number;
  /** El reflejo del pulso está armado; la web lleva tiempo sin contestar (parada) y cuántas veces lo ha estado. */
  armed?: boolean;
  stalled?: boolean;
  stalls?: number;
  /** Cuántas órdenes ha escrito el reflejo al anillo, y cuántas no pudo. */
  writes?: number;
  failed?: number;
  /** Cuántas órdenes de la notificación (pausa, reanudar, parar) esperan a que la web las recoja con `takeActions`. */
  pending?: number;
  /** Cuándo vio el lado nativo caerse la conexión con el anillo (ms, reloj del móvil); 0 si no se ha caído en este entreno. */
  ringDownAt?: number;
  /** Número de este aviso desde que empezó el entreno (1, 2, 3…): los saltos son avisos que se perdieron por el camino. */
  n?: number;
}

/**
 * Lo que se toca en los botones de la notificación del entreno: `pause`, `resume` o `stop` (parar y guardar), con la hora (ms) a la que se tocó. El lado nativo las anota y la web las recoge
 * en orden cuando puede (`takeActions`), así que una web parada un rato no pierde ni retrasa la hora de la pausa o de la parada.
 */
export interface TrackerAction {
  action: 'pause' | 'resume' | 'stop';
  atMs: number;
}

/**
 * Mantiene vivo un entreno con la pantalla apagada o la app oculta: un servicio en primer plano (con su aviso fijo) que, con GPS, recoge
 * cada posición y la guarda para que la web la pida cuando pueda. Con la app oculta el WebView no recibe el GPS, y algunos móviles lo dejan
 * parado, así que el pulso del anillo lo mantiene también el lado nativo (el «reflejo»: `RingKeeper.java`).
 */
export interface TrackerPlugin {
  /** Pide de una vez la ubicación (precisa y aproximada, salvo con `gps: false`) y, desde Android 13, los avisos. Devuelve cómo quedan. */
  askPermissions(options?: { gps?: boolean }): Promise<{ location: boolean; notifications: boolean }>;
  permissionState(): Promise<{ location: boolean; notifications: boolean }>;
  /**
   * Empieza el servicio del entreno `sessionId`: graba su ruta GPS o, con `gps: false`, solo lo mantiene vivo (y entrega los avisos nativos).
   * Debe llamarse con la app a la vista. Con `resume: true` vuelve a levantar un servicio que se paró SIN tocar la pausa ni las órdenes pendientes de la notificación.
   */
  start(options: { sessionId: string; startedAtMs: number; title?: string; text?: string; gps?: boolean; resume?: boolean }): Promise<TrackerState>;
  /**
   * Pone al lado nativo a oír los avisos del anillo (con su número de orden y su hora de recepción) ANTES de que la web se suscriba a ellos.
   * `ok: false` si no pudo: la web recibe los avisos igual, sin esos datos.
   */
  ringPrepare(options: { deviceId: string; service: string; characteristics: string[] }): Promise<{ ok: boolean; armed: boolean }>;
  /** Arma el reflejo del pulso: `startHr` es la trama (en hexadecimal) con la que la web pide la medida de pulso. */
  ringArm(options: { deviceId: string; service: string; command: string; withResponse: boolean; startHr: string }): Promise<{ ok: boolean; armed: boolean }>;
  ringDisarm(): Promise<{ ok: boolean; armed: boolean }>;
  /** La web contesta a un aviso nativo: está viva (si deja de contestar, el reflejo atiende al anillo). */
  ack(): Promise<void>;
  /** Las posiciones posteriores a la número `sinceSeq` (hasta `limit`). */
  fixes(options: { sessionId?: string; sinceSeq: number; limit?: number }): Promise<TrackerState & { fixes: RawTrackFix[] }>;
  /** Deja de grabar; la pista se conserva hasta `clear`. */
  stop(): Promise<TrackerState>;
  clear(options: { sessionId: string }): Promise<void>;
  status(): Promise<TrackerState>;
  /** Abre el cuadro de Android para no restringir la app en segundo plano (el ahorro de batería de algunos fabricantes cierra los servicios). */
  requestBatteryExemption(): Promise<TrackerState>;
  /** Las órdenes que se tocaron en la notificación desde la última vez que se pidieron, en orden; las borra del lado nativo. */
  takeActions(): Promise<{ actions: TrackerAction[] }>;
  /** Cuenta al lado nativo si el entreno está en pausa (cuando se pausa o se reanuda desde la app), para que la notificación enseñe «Reanudar» o «Pausa» y pare o siga su cronómetro. */
  setPaused(options: { paused: boolean; atMs: number }): Promise<void>;
  /**
   * Un aviso cada pocos segundos mientras se graba un entreno, venga de donde venga el reloj: lo manda el servicio nativo, que sigue
   * vivo con la app oculta, y llega al WebView aunque sus temporizadores estén espaciados. Sirve para despertar lo que depende de ellos.
   */
  addListener(eventName: 'tick', listener: (tick: TrackerTick) => void): Promise<PluginListenerHandle>;
  /** Se tocó un botón de la notificación: es solo el timbre; lo que se tocó se recoge con `takeActions`. */
  addListener(eventName: 'action', listener: () => void): Promise<PluginListenerHandle>;
}

export const Tracker = registerPlugin<TrackerPlugin>('Tracker');

/**
 * Bloqueo de pantalla para el WebView, donde `navigator.wakeLock` no es de fiar: durante un entrenamiento o la prueba
 * guiada la pantalla debe seguir encendida para que los temporizadores y el Bluetooth no se detengan.
 */
export function nativeWakeLock(): { request(type: 'screen'): Promise<{ release(): Promise<void>; released?: boolean }> } {
  return {
    async request() {
      await NativeTools.keepScreenOn({ enabled: true });
      const lock = {
        released: false,
        async release(): Promise<void> {
          lock.released = true;
          await NativeTools.keepScreenOn({ enabled: false });
        },
      };
      return lock;
    },
  };
}

/**
 * Suelta el bloqueo de pantalla al arrancar. Al empezar (o recargarse) la app no hay ningún entrenamiento ni prueba en marcha,
 * pero el indicador de Android vive en la ventana y SOBREVIVE a la recarga de la página: tras una pantalla de error con un
 * entrenamiento abierto quedaría la pantalla forzada encendida y nadie volvería a soltarla.
 */
export function releaseNativeScreenLock(): void {
  if (!isNative()) return;
  void NativeTools.keepScreenOn({ enabled: false }).catch(() => undefined);
}
