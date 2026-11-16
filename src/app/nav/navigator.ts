import { signal } from '@preact/signals';
import { bearingDeg, flatDistanceM, turnDeg } from '../../domain/nav/geo';
import { Guidance, type Cuer, type GuidanceState } from '../../domain/nav/guidance';
import { EDGE_MARGIN_M, zoneCovers } from '../../domain/nav/zones';
import { buildSteps, type Step } from '../../domain/nav/maneuvers';
import { profileForSport, relaxedProfile, type Profile } from '../../domain/nav/profiles';
import { findRoute, type Route, type RouteFailure } from '../../domain/nav/router';
import { searchPlaces, type SearchResult } from '../../domain/nav/search';
import { isBeta } from '../beta';
import { liveFix, liveWorkout, type LiveFix } from '../state';
import { svc } from '../services';
import { createIdbAreaStore } from './area-store';
import { downloadDetailFor, downloadZone, type DownloadProgress } from './area-download';
import { abortWhenHidden } from './hidden-guard';
import { createFixClock } from './fix-clock';
import { loadSyntheticCity, type NavData, type NavLoad } from './pack-loader';
import { createToneCuer } from './tones';
import { loadMostRecentStoredZone, loadStoredZoneCovering, loadZoneFor, type ZoneDeps } from './zone-manager';

// El navegador del entreno: elegir un destino, ver la ruta que propone para el deporte y seguirla con avisos sonoros (zumbidos en el oído del lado del giro, unos 5 s antes de él, `domain/nav/cues.ts`). Aquí vive el
// estado (señales que pinta la interfaz) y lo que une las piezas: el mapa de la zona (guardado o recién bajado: `zone-manager.ts`), el GPS del entreno (`liveFix`), la guía
// (`domain/nav/guidance.ts`) y los zumbidos.

/** `locating`: esperando la primera posición del GPS (hace falta para saber qué mapa). `loading`: buscando el mapa guardado. `downloading`: bajándolo de internet. */
export type NavPhase = 'closed' | 'locating' | 'loading' | 'downloading' | 'unavailable' | 'search' | 'preview' | 'navigating' | 'arrived';

export interface Destination {
  name: string;
  subtitle: string;
  lat: number;
  lon: number;
}

export interface NavState {
  phase: NavPhase;
  /** Qué falla (no hay mapa, no hay ruta…) o qué se espera (el GPS). */
  message: string | null;
  query: string;
  results: SearchResult[];
  destination: Destination | null;
  route: Route | null;
  steps: Step[];
  guidance: GuidanceState | null;
  profileLabel: string;
  routing: boolean;
  muted: boolean;
  /** Por qué no suenan los avisos (el WebView no tiene audio); `null` si suenan. */
  soundProblem: string | null;
  /** Se ha pulsado «elegir en el mapa»: la próxima pulsación larga o toque pone el destino. */
  pickingOnMap: boolean;
  /** Cómo va la bajada del mapa (solo en `downloading`). */
  download: DownloadProgress | null;
}

const CLOSED: NavState = { phase: 'closed', message: null, query: '', results: [], destination: null, route: null, steps: [], guidance: null, profileLabel: '', routing: false, muted: false, soundProblem: null, pickingOnMap: false, download: null };

export const navState = signal<NavState>(CLOSED);
/** El mapa abierto (para dibujarlo); `null` mientras no esté. */
export const navData = signal<NavData | null>(null);

export interface NavDeps {
  /** El mapa para esa posición (`null` si no hace falta saberla: la ciudad de prueba). */
  load: (position: { lat: number; lon: number } | null, onProgress: (progress: DownloadProgress) => void) => Promise<NavLoad>;
  /** ¿Hace falta la posición del GPS para saber qué mapa abrir? */
  needsPosition: () => boolean;
  /**
   * El mapa guardado que se usó más recientemente, para tenerlo en pantalla antes de que el GPS dé la primera posición (casi siempre se entrena por la misma zona). Nunca baja nada. `null` si no
   * hay; sin esta función no hay mapa provisional.
   */
  loadRecent?: () => Promise<NavData | null>;
  /** Los zumbidos (hay que crearlos desde un gesto de la persona). `null` si el WebView no puede reproducirlos. */
  makeCuer: (onProblem: (message: string) => void) => Cuer | null;
  now: () => number;
}

/** La demostración usa una ciudad de mentira (sin internet), salvo con `?mapdl` en la dirección (las pruebas de la descarga) y en la versión para betatesters, que baja el mapa de verdad. */
const usesSyntheticCity = (): boolean => svc().demo && !isBeta() && !new URLSearchParams(location.search).has('mapdl');

let zoneDeps: ZoneDeps | null = null;
const zones = (): ZoneDeps =>
  (zoneDeps ??= {
    store: createIdbAreaStore(),
    // Bajar y construir el mapa es trabajo pesado: con la app oculta (pantalla apagada, otra app delante) se corta y se retoma con la app a la vista (`hidden-guard.ts`).
    download: (lat, lon, onProgress) => {
      const guard = abortWhenHidden();
      return downloadZone(lat, lon, { now: () => svc().now(), onProgress, signal: guard.signal }).finally(guard.dispose);
    },
    // Los edificios y los comercios llegan después de abrir el mapa; si ese mapa sigue abierto y se está eligiendo destino, se cambia por el completo (con una ruta calculada no: la ruta es de aquel).
    downloadDetail: (zone, base) => {
      const guard = abortWhenHidden();
      return downloadDetailFor(zone, base, { now: () => svc().now(), signal: guard.signal }).finally(guard.dispose);
    },
    onUpgrade: (data) => {
      const current = navData.value;
      if (current && current.zoneId === data.zoneId && navState.value.phase === 'search' && !switchingZone) navData.value = data;
    },
    now: () => svc().now(),
  });

const defaultDeps = (): NavDeps => ({
  load: (position, onProgress) => (usesSyntheticCity() || !position ? loadSyntheticCity() : loadZoneFor(position.lat, position.lon, zones(), onProgress)),
  needsPosition: () => !usesSyntheticCity(),
  loadRecent: () => (usesSyntheticCity() ? Promise.resolve(null) : loadMostRecentStoredZone(zones())),
  makeCuer: (onProblem) => createToneCuer(onProblem),
  now: () => svc().now(),
});

let deps: NavDeps | null = null;
const d = (): NavDeps => (deps ??= defaultDeps());
/** Cambia las dependencias (solo las pruebas). */
export function setNavDepsForTests(next: NavDeps | null): void {
  deps = next;
  resetNav();
}

let profile: Profile | null = null;
let guidance: Guidance | null = null;
let cuer: (Cuer & { close?: () => void }) | null = null;
let unsubscribeFix: (() => void) | null = null;
let unsubscribeWorkout: (() => void) | null = null;
let unsubscribeZone: (() => void) | null = null;
let cancelWait: (() => void) | null = null;
let lastRerouteMs = 0;
let rerouting = false;
/** Cuándo sonó el último cambio de sentido: si se sigue en dirección contraria no se repite el zumbido a cada recálculo (cada 10 s), sino cada tanto. */
let lastReverseMs = -Infinity;
const REVERSE_REPEAT_MS = 25_000;
/** Las últimas posiciones (la más reciente al final): de ellas sale hacia dónde va la persona, para saber si la ruta nueva le manda dar la vuelta. */
const recentFixes: Array<{ lat: number; lon: number }> = [];
const RECENT_FIXES = 20;
/** Una vuelta de más de esto (grados) entre hacia donde se va y hacia donde sale la ruta nueva es un cambio de sentido, no un atajo. */
const TURN_AROUND_DEG = 110;
/** Cada apertura del navegador tiene su número: lo que termina tarde (una bajada) no toca el estado si ya se cerró o se abrió otra vez. */
let session = 0;
let switchingZone = false;
let lastZoneTryMs = 0;
/** Cuántas veces seguidas ha fallado cambiar de zona: cada fallo duplica la espera hasta el siguiente intento (menos peticiones a servidores que ya dijeron que no). */
let zoneFailures = 0;
const ZONE_RETRY_MS = 60_000;
const ZONE_RETRY_MAX_MS = 15 * 60_000;
const zoneBackoffMs = (): number => Math.min(ZONE_RETRY_MAX_MS, ZONE_RETRY_MS * 2 ** zoneFailures);

const patch = (change: Partial<NavState>): void => {
  navState.value = { ...navState.value, ...change };
};

/** Cierra todo y deja la navegación como al empezar. */
export function resetNav(): void {
  session++;
  cancelWait?.();
  cancelWait = null;
  unsubscribeFix?.();
  unsubscribeWorkout?.();
  unsubscribeZone?.();
  unsubscribeFix = null;
  unsubscribeWorkout = null;
  unsubscribeZone = null;
  switchingZone = false;
  lastZoneTryMs = 0;
  zoneFailures = 0;
  cuer?.close?.();
  cuer?.stop();
  cuer = null;
  guidance = null;
  profile = null;
  rerouting = false;
  lastRerouteMs = 0;
  navState.value = CLOSED;
}

const FAILURES: Record<RouteFailure, string> = {
  'no-road-near-start': 'No hay ninguna calle del mapa cerca de tu posición.',
  'no-road-near-destination': 'Ese destino queda lejos de cualquier calle del mapa.',
  'no-route': 'No encuentro un camino hasta ahí para este deporte.',
  'too-far': 'Queda demasiado lejos (más de 120 km).',
};

/** Espera la primera posición del GPS (devuelve `null` si el navegador se cierra mientras tanto). */
function waitForFix(): Promise<LiveFix | null> {
  return new Promise((resolve) => {
    let done = false;
    let off: (() => void) | null = null;
    const finish = (fix: LiveFix | null): void => {
      if (done) return;
      done = true;
      off?.();
      cancelWait = null;
      resolve(fix);
    };
    cancelWait = () => finish(null);
    off = liveFix.subscribe((fix) => {
      if (fix && d().now() - fix.receivedMs <= 60_000) finish(fix);
    });
    if (done) off();
  });
}

/** El mapa provisional ya pedido (al empezar el entreno, mientras se conecta el anillo y el GPS busca satélites) para no esperar a leerlo cuando se abre la pestaña del mapa. */
let warm: { promise: Promise<NavData | null>; at: number } | null = null;
const WARM_MS = 3 * 60_000;

/**
 * Adelanta la lectura del mapa guardado más reciente. Se llama en cuanto empieza un entreno guiado: leerlo de la base y montar el grafo lleva un rato y así ocurre mientras el anillo se
 * conecta y el GPS busca la primera posición, en vez de después. No hace nada si no hay zona guardada, y no baja nada de internet.
 */
export function warmNavigation(): void {
  if (!d().needsPosition() || !d().loadRecent || navState.value.phase !== 'closed') return;
  if (warm && d().now() - warm.at < WARM_MS) return; // ya se está leyendo (o está leído)
  const promise = d().loadRecent!().catch(() => null);
  warm = { promise, at: d().now() };
}

function takeWarm(): Promise<NavData | null> | null {
  const found = warm;
  warm = null;
  return found && d().now() - found.at < WARM_MS ? found.promise : null;
}

/** Abre el navegador para el deporte del entreno (solo los que tienen movilidad). Devuelve `false` si el deporte no tiene ruta. */
export async function openNavigation(sportId: string): Promise<boolean> {
  const p = profileForSport(sportId);
  if (!p) return false;
  profile = p;
  if (navState.value.phase !== 'closed' && navState.value.phase !== 'unavailable') return true;
  const mine = ++session;
  patch({ ...CLOSED, phase: 'loading', profileLabel: p.label });

  // Qué mapa hace falta depende de dónde está la persona: se espera al GPS (el entreno lo pide al empezar).
  let position: { lat: number; lon: number } | null = null;
  if (d().needsPosition()) {
    let fix = liveFix.value;
    if (!fix || d().now() - fix.receivedMs > 60_000) {
      // Sin posición todavía no se espera con los brazos cruzados: si hay un mapa guardado se enseña ya (casi siempre es el de la zona) y se comprueba con la primera posición.
      const recent = await (takeWarm() ?? d().loadRecent?.().catch(() => null) ?? null);
      if (session !== mine) return true;
      if (recent) {
        navData.value = recent;
        patch({ phase: 'search', message: null, download: null });
        finishOpening(mine, true, true);
        return true;
      }
      patch({ phase: 'locating' });
      fix = await waitForFix();
    }
    if (session !== mine || !fix) return true;
    position = { lat: fix.lat, lon: fix.lon };
    patch({ phase: 'loading' });
  }

  const loaded = await d().load(position, (progress) => {
    if (session === mine) patch({ phase: 'downloading', download: progress });
  });
  if (session !== mine) return true;
  if (!loaded.ok) {
    patch({ phase: 'unavailable', message: loaded.message, download: null });
    return true;
  }
  navData.value = loaded.data;
  patch({ phase: 'search', message: null, download: null });
  finishOpening(mine, position !== null, false);
  return true;
}

/** Lo que queda por montar cuando ya hay mapa: cerrar la navegación si el entreno termina y vigilar que la persona siga dentro de la zona. */
function finishOpening(mine: number, watch: boolean, provisional: boolean): void {
  unsubscribeWorkout?.();
  unsubscribeWorkout = liveWorkout.subscribe((state) => {
    if (!state && navState.value.phase !== 'closed') closeNavigation();
  });
  if (watch) watchZone(mine, provisional);
}

/**
 * Mientras se elige destino, si la persona sale del mapa de su zona (a pie o en bici se llega lejos), se baja el de la nueva. Durante una ruta o su vista previa el mapa no se cambia: la
 * ruta está calculada sobre él. Con un mapa provisional (abierto antes de tener posición), la primera posición decide: si no cae bien dentro (a más de 1 km del borde, como al abrir una zona
 * guardada) se busca el mapa de donde está de verdad.
 */
function watchZone(mine: number, provisional: boolean): void {
  unsubscribeZone?.();
  let unchecked = provisional;
  unsubscribeZone = liveFix.subscribe((fix) => {
    if (!fix || session !== mine || navState.value.phase !== 'search' || switchingZone) return;
    const data = navData.value;
    if (!data || zoneCovers(data.box, fix.lat, fix.lon, unchecked ? EDGE_MARGIN_M : 0)) {
      if (data) unchecked = false;
      return;
    }
    if (d().now() - lastZoneTryMs < (unchecked ? 0 : zoneBackoffMs())) return;
    const wasProvisional = unchecked;
    unchecked = false;
    void switchZone(mine, fix, wasProvisional);
  });
}

async function switchZone(mine: number, fix: LiveFix, wasProvisional: boolean): Promise<void> {
  switchingZone = true;
  lastZoneTryMs = d().now();
  patch({ message: wasProvisional ? 'Buscando el mapa de donde estás…' : 'Has salido de la zona del mapa. Bajando la nueva…' });
  try {
    const loaded = await d().load({ lat: fix.lat, lon: fix.lon }, () => undefined);
    if (session !== mine) return;
    if (!loaded.ok) {
      zoneFailures++;
      // El mapa provisional era de otra zona y no hay forma de tener el de esta: mejor decirlo que dejar buscar sobre un mapa que no es el de aquí.
      if (wasProvisional) {
        navData.value = null;
        patch({ phase: 'unavailable', message: loaded.message, download: null });
      } else {
        patch({ message: loaded.message });
      }
      return;
    }
    zoneFailures = 0;
    navData.value = loaded.data;
    patch({ message: null, query: '', results: [] });
  } finally {
    if (session === mine) switchingZone = false;
  }
}

export function closeNavigation(): void {
  resetNav();
}

/**
 * Vuelve al buscador de destino sin cerrar el navegador ni el mapa. Al cambiar de destino desde la vista previa se conserva lo que se había escrito; al dejar una ruta (`clear`) o llegar,
 * el buscador vuelve a estar como al abrir el mapa: sin texto ni resultados.
 */
export function backToSearch(options: { clear?: boolean } = {}): void {
  unsubscribeFix?.();
  unsubscribeFix = null;
  cuer?.stop();
  guidance = null;
  rerouting = false;
  patch({ phase: 'search', destination: null, route: null, steps: [], guidance: null, message: null, pickingOnMap: false, routing: false, ...(options.clear ? { query: '', results: [] } : {}) });
}

export function setQuery(query: string): void {
  const data = navData.value;
  const fix = liveFix.value;
  patch({ query, results: data && query.trim().length >= 2 ? searchPlaces(data.search, query, fix ? { lat: fix.lat, lon: fix.lon } : null, 8) : [] });
}

/** El destino elegido (de la lista o del mapa): se calcula la ruta y se enseña para confirmar. Si no se puede, se dice por qué y se sigue en el buscador (nunca se queda bloqueado). */
export function chooseDestination(destination: Destination): void {
  const data = navData.value;
  if (!data || !profile) return;
  const fix = liveFix.value;
  patch({ destination, message: null, pickingOnMap: false });
  if (!fix) {
    patch({ message: 'Esperando la posición del GPS para calcular la ruta… Sal a un sitio abierto.' });
    return;
  }
  patch({ routing: true });
  try {
    const result = findRoute(data.graph, profile, { lat: fix.lat, lon: fix.lon }, { lat: destination.lat, lon: destination.lon });
    if (!result.ok) {
      patch({ routing: false, route: null, steps: [], destination: null, message: FAILURES[result.reason] });
      return;
    }
    patch({ routing: false, route: result.route, steps: buildSteps(data.graph, result.route, destination), phase: 'preview', message: null });
  } catch {
    patch({ routing: false, route: null, steps: [], destination: null, message: 'No he podido calcular la ruta hasta ahí. Prueba con otro destino.' });
  }
}

export function chooseOnMap(lat: number, lon: number): void {
  chooseDestination({ name: 'Punto elegido en el mapa', subtitle: '', lat, lon });
}

export function togglePickOnMap(): void {
  patch({ pickingOnMap: !navState.value.pickingOnMap });
}

/** Empieza a guiar con los zumbidos. Se llama desde el toque en «Iniciar»: el audio del WebView solo arranca con un gesto de la persona. */
export function startNavigation(): void {
  const { route, steps } = navState.value;
  if (!route || !profile) return;
  cuer?.close?.();
  cuer = d().makeCuer((message) => patch({ soundProblem: message }));
  patch({ soundProblem: cuer ? null : 'Este móvil no puede reproducir los avisos sonoros: la guía será solo visual.' });
  const nominal = profile.speed(7, 0);
  recentFixes.length = 0;
  fixClock.reset();
  lastReverseMs = -Infinity;
  guidance = new Guidance(route, steps, cuer ?? { cue: () => undefined, stop: () => undefined }, { nominalSpeedMs: nominal, muted: navState.value.muted });
  patch({ phase: 'navigating', message: null, guidance: null });
  unsubscribeFix?.();
  unsubscribeFix = liveFix.subscribe((fix) => {
    if (fix) onFix(fix);
  });
}

/**
 * Una posición medida hace más que esto es historia: con la pantalla apagada la web puede quedar parada y, al encenderla, recibe de golpe todo lo que grabó el servicio nativo. Esas posiciones
 * ponen al día el progreso por la ruta, pero no deben hacer sonar los giros que ya se pasaron (sonarían todos a la vez al encender la pantalla) ni recalcular la ruta desde un sitio donde ya no se está.
 */
const STALE_FIX_MS = 8_000;
const fixClock = createFixClock(STALE_FIX_MS);

function onFix(fix: LiveFix): void {
  if (!guidance || navState.value.phase !== 'navigating') return;
  // Una posición vieja (el GPS se quedó sin dar) no se usa para nada.
  if (d().now() - fix.receivedMs > 20_000) return;
  // Si es vieja y cuánto hace de la medida (el GPS la da con algo de retraso y, mientras tanto, la persona ha seguido avanzando: la guía lo suma al calcular cuánto falta para el giro). Sin fiarse de
  // que el reloj del móvil y el del GPS coincidan: ver `fix-clock.ts`.
  const { stale, ageMs } = fixClock.observe(fix.tsMs, fix.receivedMs);
  recentFixes.push({ lat: fix.lat, lon: fix.lon });
  if (recentFixes.length > RECENT_FIXES) recentFixes.shift();
  const wasMuted = guidance.muted;
  if (stale) guidance.muted = true; // la guía da por avisado lo que se pasó, sin que suene
  const state = guidance.update({ lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, speedMs: fix.speedMs, tsMs: fix.tsMs, ageMs });
  guidance.muted = wasMuted;
  patch({ guidance: state });
  if (state.status === 'arrived') {
    unsubscribeFix?.();
    unsubscribeFix = null;
    patch({ phase: 'arrived' });
    return;
  }
  if (state.rerouteNeeded && !stale && !rerouting && d().now() - lastRerouteMs >= 10_000) void reroute(fix);
}

function reroute(fix: LiveFix): void {
  const data = navData.value;
  const { destination } = navState.value;
  if (!data || !profile || !destination || !guidance) return;
  rerouting = true;
  lastRerouteMs = d().now();
  try {
    // Para corregir, con el perfil relajado (ver `relaxedProfile`): quien se desvía no sigue las normas de un coche, y la ruta nueva no debe mandarle dar una vuelta enorme por un sentido único.
    const result = findRoute(data.graph, relaxedProfile(profile), { lat: fix.lat, lon: fix.lon }, { lat: destination.lat, lon: destination.lon });
    if (!result.ok) {
      patch({ message: FAILURES[result.reason] });
      return;
    }
    const steps = buildSteps(data.graph, result.route, destination);
    guidance.replaceRoute(result.route, steps);
    patch({ route: result.route, steps, message: null });
    // Suena el cambio de sentido solo si la ruta nueva manda dar la vuelta: si sigue por donde se iba (un atajo, una calle contigua), no hay nada que avisar.
    if (!navState.value.muted && d().now() - lastReverseMs >= REVERSE_REPEAT_MS && turnsAround(result.route)) {
      lastReverseMs = d().now();
      cuer?.cue({ kind: 'reverse', ear: 'both' }, { interrupt: true });
    }
  } catch {
    patch({ message: 'No he podido recalcular la ruta desde aquí.' });
  } finally {
    rerouting = false;
  }
}

/**
 * ¿La ruta recién calculada sale en dirección contraria a la que lleva la persona? Se mide con el rumbo de sus últimas posiciones (al menos a 15 m de la actual) y el del primer trozo de la ruta
 * nueva. Sin rumbo (quieta, o aún sin posiciones) no se puede saber y no se avisa.
 */
function turnsAround(route: Route): boolean {
  const here = recentFixes[recentFixes.length - 1];
  if (!here) return false;
  let from: { lat: number; lon: number } | null = null;
  for (let i = recentFixes.length - 2; i >= 0; i--) {
    if (flatDistanceM(recentFixes[i]!.lat, recentFixes[i]!.lon, here.lat, here.lon) >= 15) {
      from = recentFixes[i]!;
      break;
    }
  }
  if (!from) return false;
  const origin = route.points[0];
  const ahead = route.points.find((p) => origin && flatDistanceM(origin.lat, origin.lon, p.lat, p.lon) >= 5);
  if (!origin || !ahead) return false;
  return Math.abs(turnDeg(bearingDeg(from, here), bearingDeg(origin, ahead))) >= TURN_AROUND_DEG;
}

export function toggleMute(): void {
  const muted = !navState.value.muted;
  patch({ muted });
  if (guidance) guidance.muted = muted;
  if (muted) cuer?.stop();
}

/**
 * El mapa de fondo para dibujar un recorrido ya hecho (la revisión de un entreno): el de una zona guardada que lo cubra entero, sin bajar nada. `null` si no hay (el recorrido se ve
 * entonces sin mapa). La demostración usa la ciudad de mentira.
 */
export async function loadMapForRoute(points: ReadonlyArray<readonly [number, number]>): Promise<NavData | null> {
  try {
    if (usesSyntheticCity()) {
      const city = await loadSyntheticCity();
      return city.ok ? city.data : null;
    }
    return await loadStoredZoneCovering(
      points.map(([lat, lon]) => ({ lat, lon })),
      zones(),
    );
  } catch {
    return null;
  }
}
