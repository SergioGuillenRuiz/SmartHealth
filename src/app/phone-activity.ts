import { signal } from '@preact/signals';
import { DAY_MS } from '../domain/dates';
import { mergeSpans, parseSpans, withoutSpans } from '../domain/phone-activity';
import { isNative, NativeTools } from './native';
import { svc } from './services';
import { bumpData } from './state';

// El uso del móvil como señal para estimar el sueño de las noches sin anillo (ver `domain/sleep-phone.ts`).
//
// Qué se lee y qué no: el sistema Android guarda unos días de eventos de uso (cuándo se encendió y apagó la pantalla, cuándo se desbloqueó, qué app estuvo delante). De todo eso la app SOLO se
// queda con las HORAS en que el móvil estuvo en uso (de cuándo a cuándo): nunca qué apps, ni qué se hizo, y nada sale del móvil. Se lee con el acceso a «datos de uso» que la persona da una vez en los
// ajustes de Android; sin él no se lee nada y el sueño se estima como antes. Se lee al abrir la app y al volver a ella, y una vez por hora en segundo plano (un trabajo del sistema, sin servicio
// permanente ni gasto apreciable de batería).

export interface PhoneAccess {
  /** Ya se ha comprobado (para no enseñar «sin acceso» mientras aún no se sabe). */
  checked: boolean;
  /** Este Android (y esta versión de la app, no la web) puede dar el acceso. */
  supported: boolean;
  granted: boolean;
}

export const phoneAccess = signal<PhoneAccess>({ checked: false, supported: false, granted: false });

/** Lo que dio la última lectura buena, para que la persona (y quien arregle esto) vea que funciona: solo fechas y cifras, nunca qué apps ni qué se hizo. */
export interface PhoneDiag {
  /** Cuándo se hizo la lectura. */
  readAtMs: number;
  /** Desde cuándo conserva el sistema eventos (0: ninguno) y la hora del último. */
  firstMs: number;
  lastEventMs: number;
  /** Cuántos eventos de pantalla, de desbloqueo y de apps delante vio el sistema, y cuántos tramos de uso salieron de ellos. */
  screenEvents: number;
  unlockEvents: number;
  appEvents: number;
  uses: number;
}

export const phoneDiag = signal<PhoneDiag | null>(null);

/** Los primeros días que se piden al leer por primera vez: el sistema conserva unos pocos y de lo que no tiene no se dice nada. */
const FIRST_READ_MS = 10 * DAY_MS;
/** Se vuelve a leer un poco de lo ya leído: la lectura anterior pudo cortar un uso en marcha. */
const OVERLAP_MS = 15 * 60_000;
/** Entre una lectura y la siguiente, como mínimo esto (volver a la app varias veces seguidas no relee). */
const MIN_GAP_MS = 2 * 60_000;

let lastRunMs = 0;
let running: Promise<void> | null = null;

/** Mira si la persona ha dado el acceso. En la web (o en las pruebas) no hay nada que dar. */
export async function refreshPhoneAccess(): Promise<PhoneAccess> {
  if (!isNative()) {
    phoneAccess.value = { checked: true, supported: false, granted: false };
    return phoneAccess.value;
  }
  try {
    const status = await NativeTools.phoneActivityStatus();
    phoneAccess.value = { checked: true, supported: status.supported, granted: status.supported && status.granted };
  } catch {
    // Una versión de la app sin esta función: como si no se pudiera.
    phoneAccess.value = { checked: true, supported: false, granted: false };
  }
  return phoneAccess.value;
}

/** Lleva a la persona a la pantalla de ajustes de Android donde se da el acceso. Al volver, `startPhoneActivity` vuelve a mirar. */
export async function openPhoneAccessSettings(): Promise<void> {
  if (!isNative()) return;
  await NativeTools.openPhoneActivitySettings().catch(() => undefined);
}

/** Lee del móvil lo que falta desde la última lectura y lo guarda. Sin acceso (o en la web) no hace nada. Nunca falla hacia fuera. */
export function syncPhoneActivity(force = false): Promise<void> {
  if (running) return running;
  const { now } = svc();
  if (!force && now() - lastRunMs < MIN_GAP_MS) return Promise.resolve();
  running = (async () => {
    try {
      const access = await refreshPhoneAccess();
      if (!access.granted) return;
      const { store } = svc();
      const nowMs = now();
      const last = await store.lastPhoneRead();
      const since = last === null ? nowMs - FIRST_READ_MS : Math.max(last - OVERLAP_MS, nowMs - FIRST_READ_MS);
      const result = await NativeTools.readPhoneActivity({ sinceMs: since });
      if (!result.granted) {
        phoneAccess.value = { checked: true, supported: true, granted: false };
        return;
      }
      lastRunMs = nowMs;
      const spans = parseSpans(result.uses);
      phoneDiag.value = {
        readAtMs: nowMs,
        firstMs: result.firstMs,
        lastEventMs: result.lastEventMs ?? 0,
        screenEvents: result.screenEvents ?? 0,
        unlockEvents: result.unlockEvents ?? 0,
        appEvents: result.appEvents ?? 0,
        uses: spans.length,
      };
      // Se lee entero desde el primer evento que el sistema conserva (antes de eso no se sabe qué pasó), menos los ratos con el móvil apagado.
      const coverageFrom = result.firstMs > 0 ? Math.max(result.fromMs, result.firstMs) : result.toMs;
      const coverage = withoutSpans(coverageFrom < result.toMs ? [{ startMs: coverageFrom, endMs: result.toMs }] : [], parseSpans(result.offs));
      const uses = mergeSpans(spans, 60_000);
      if (uses.length === 0 && coverage.length === 0) return;
      await store.addPhoneActivity({ uses, coverage });
      // Lo guardado cambia las estimaciones del sueño: las pantallas que las enseñan se recargan.
      bumpData();
    } catch {
      // Sin acceso o con un fallo del sistema, el sueño se estima como antes: no es un error que enseñar.
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Arranca la lectura del uso del móvil: ahora, al volver a la app y cada hora en segundo plano. Devuelve cómo pararla. */
export function startPhoneActivity(): () => void {
  if (!isNative()) {
    void refreshPhoneAccess();
    return () => undefined;
  }
  void syncPhoneActivity(true);
  void NativeTools.schedulePhoneActivity().catch(() => undefined);
  const onBack = (): void => {
    // Al volver de los ajustes de Android el acceso puede haber cambiado: se mira siempre, y si acaba de darse se lee ya.
    const wasGranted = phoneAccess.value.granted;
    void refreshPhoneAccess().then((access) => syncPhoneActivity(access.granted && !wasGranted));
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') onBack();
  };
  document.addEventListener('visibilitychange', onVisible);
  // El WebView de algunos móviles no avisa con `visibilitychange` al volver de otra pantalla (los ajustes de Android): Capacitor sí avisa con «resume».
  let stopped = false;
  let removeResume: (() => void) | null = null;
  void import('@capacitor/app')
    .then(({ App }) => App.addListener('resume', onBack))
    .then((handle) => {
      if (stopped) void handle.remove();
      else removeResume = () => void handle.remove();
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    removeResume?.();
  };
}
