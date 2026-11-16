import { effect, signal, untracked } from '@preact/signals';
import { buildScaleReport } from '../ble/scale/report';
import { ScaleSession, type ScaleSessionState } from '../ble/scale/session';
import type { ScaleAdvert, ScaleTransport } from '../ble/scale/transport';
import type { SavedScale } from '../domain/scale';
import { learnDecoder, type LearnCandidate, type LearnResult, type ScaleLabel } from '../domain/scale-learn';
import { svc } from './services';
import { ringUse } from './state';

// La báscula de cocina en la app: cuál es la emparejada, la conexión viva mientras se usa y el emparejado, que APRENDE el protocolo (la báscula no lo documenta: ver
// `domain/scale-learn.ts` y docs/bascula.md). Todo el estado que pinta la interfaz son señales; la conexión y el aprendizaje, módulo aparte (`ble/scale`).

/** La báscula emparejada (`null`: ninguna). Se lee al arrancar (`loadScale`). */
export const scaleSaved = signal<SavedScale | null>(null);
/** Cómo va la conexión: reposo, conectando, viva (con el peso), dormida o con un problema. */
export const scaleState = signal<ScaleSessionState>({ status: 'idle', message: null, frames: 0, reading: null });

/**
 * ¿Quiere la persona la báscula ahora? Sí con la hoja «He comido algo» abierta (y el margen de después), no con la de Dispositivos. Mientras sí, la actualización automática del anillo espera
 * (`startAutoSync`): la sesión de la báscula escucha anuncios e intenta conectarse una y otra vez, y el Bluetooth del móvil no atiende bien dos conexiones y una búsqueda a la vez.
 */
export const scaleWanted = signal(false);

let session: ScaleSession | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
/** Mientras se empareja, la sesión busca el protocolo y no lee el peso aún. */
let pairing: Pairing | null = null;

interface Pairing {
  device: { id: string; name: string | null };
  labels: ScaleLabel[];
  restAtMs: number | null;
  candidates: LearnCandidate[];
  /** Cuál de los candidatos se está probando. */
  index: number;
  lastResult: LearnResult | null;
}

/** Olvida la sesión y el emparejado en curso (solo para las pruebas: cada una trae su propio Bluetooth simulado). */
export function resetScaleForTests(): void {
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  session = null;
  pairing = null;
  scaleWanted.value = false;
  scaleState.value = { status: 'idle', message: null, frames: 0, reading: null };
}

/** Cuánto tarda en soltarse la báscula tras cerrar la hoja (volver a abrirla enseguida no cuesta otra conexión). */
export const SCALE_GRACE_MS = 20_000;

/** El Bluetooth de la báscula, o `null` si esta plataforma no lo tiene. */
export function scaleTransport(): ScaleTransport | null {
  try {
    return svc().scale ?? null;
  } catch {
    return null;
  }
}

/** ¿Se puede usar la báscula aquí? Si no, por qué (un navegador no tiene el Bluetooth que hace falta). */
export function scaleSupport(): { available: boolean; reason: string | null } {
  const transport = scaleTransport();
  if (!transport) return { available: false, reason: 'La báscula solo funciona dentro de la app de Android.' };
  return transport.available ? { available: true, reason: null } : { available: false, reason: transport.unavailableReason ?? 'Este Bluetooth no está disponible.' };
}

function ensureSession(): ScaleSession | null {
  const transport = scaleTransport();
  if (!transport) return null;
  if (!session) {
    session = new ScaleSession(transport, () => svc().now());
    session.onChange((state) => {
      scaleState.value = state;
    });
  }
  return session;
}

/** Lee del móvil la báscula emparejada. */
export async function loadScale(): Promise<void> {
  scaleSaved.value = await svc().store.getScale();
}

// ───────────────────────────── usar la báscula ─────────────────────────────

/** Arranca la conexión con la báscula emparejada (la hoja «He comido algo» se abre). Si ya está en marcha, solo cancela una parada pendiente. */
export function startScale(): void {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  scaleWanted.value = scaleSaved.value !== null && scaleSupport().available;
  resumeScale();
}

/**
 * Pone en marcha la sesión si se puede. **El anillo manda**: con el anillo en uso por lo que sea (sincronizar, medir, entrenar, la prueba guiada o la actualización automática) la báscula espera
 * y no se pone a buscar ni a conectarse. Con la báscula y el anillo a la vez, el anillo tardaba hasta medio minuto en conectar, en saludar y en soltarse (una conexión pendiente a una báscula
 * apagada bloquea la del anillo hasta que caduca). Cuando el anillo queda libre, `ringFirst` la retoma si la persona sigue queriéndola.
 */
function resumeScale(): void {
  const saved = scaleSaved.value;
  const current = ensureSession();
  if (!saved || !current || pairing !== null || !scaleSupport().available) return;
  if (ringUse.value !== null) return;
  current.setDecoder(saved.decoder);
  current.start({ id: saved.id, name: saved.name });
}

// El anillo manda sobre la báscula: al reservarse (cualquier uso) se suelta la báscula en el acto, antes de que el anillo se ponga a conectar; al liberarse, vuelve si la persona la sigue queriendo.
const ringFirst = effect(() => {
  const busy = ringUse.value !== null;
  untracked(() => {
    if (busy) {
      if (session && pairing === null) void session.stop();
    } else if (scaleWanted.value) resumeScale();
  });
});
void ringFirst;

/** Suelta la báscula tras un rato (`graceMs`): cerrar la hoja y volver a abrirla enseguida no cuesta otra conexión. */
export function stopScale(graceMs: number = SCALE_GRACE_MS): void {
  if (stopTimer !== null) clearTimeout(stopTimer);
  if (!session) {
    scaleWanted.value = false;
    return;
  }
  const stopping = session;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    scaleWanted.value = false;
    if (pairing === null) void stopping.stop();
  }, graceMs);
}

export async function stopScaleNow(): Promise<void> {
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  scaleWanted.value = false;
  await session?.stop();
}

export async function forgetScale(): Promise<void> {
  await stopScaleNow();
  await svc().store.setScale(null);
  scaleSaved.value = null;
}

// ───────────────────────────── emparejar y aprender ─────────────────────────────

/** Busca dispositivos Bluetooth cercanos (con `onSeen`, según se ven). */
export async function scanScales(durationMs: number, onSeen?: (advert: ScaleAdvert) => void): Promise<ScaleAdvert[]> {
  const transport = scaleTransport();
  if (!transport) return [];
  await stopScaleNow();
  return transport.scan(durationMs, onSeen);
}

/** Empieza el emparejado con un dispositivo: se conecta y guarda lo que manda, sin saber aún dónde va el peso. */
export function startPairing(device: { id: string; name: string | null }): void {
  const current = ensureSession();
  if (!current) return;
  pairing = { device, labels: [], restAtMs: null, candidates: [], index: 0, lastResult: null };
  void current.stop().then(() => {
    current.clearFrames();
    current.setDecoder(null);
    current.start(device);
  });
}

export const isPairing = (): boolean => pairing !== null;

/** La báscula está vacía y marca 0 ahora: sirve para descartar campos que no son el peso. */
export function markScaleEmpty(): void {
  if (pairing) pairing.restAtMs = svc().now();
}

export interface LearnOutcome {
  /** El mejor candidato (ya puesto en la sesión: el peso se ve en `scaleState`), o `null` si no se encontró. */
  best: LearnCandidate | null;
  /** Cuántos candidatos quedan en total. */
  total: number;
  problem: LearnResult['problem'];
}

function activate(index: number): LearnCandidate | null {
  const current = pairing;
  if (!current || !session) return null;
  const candidate = current.candidates[index] ?? null;
  current.index = index;
  session.setDecoder(candidate?.decoder ?? null);
  return candidate;
}

/**
 * La persona dice lo que marca la pantalla (en gramos) en este momento: se busca qué campo de las tramas vale eso (junto con lo anterior que dijera) y se prueba el mejor
 * en vivo. Con varias pesadas, los campos que cuadraban por casualidad con una se descartan.
 */
export function learnWeight(typedGrams: number): LearnOutcome {
  const current = pairing;
  if (!current || !session) return { best: null, total: 0, problem: 'no-frames' };
  current.labels.push({ value: typedGrams, atMs: svc().now() });
  const result = learnDecoder({ frames: session.frames(), labels: current.labels, restAtMs: current.restAtMs });
  // Un número que no cuadra con nada (mal escrito, o con la báscula en movimiento) no se guarda: si se guardara, cada intento siguiente chocaría con él.
  if (result.candidates.length === 0) current.labels.pop();
  current.lastResult = result;
  current.candidates = result.candidates;
  const best = activate(0);
  return { best, total: result.candidates.length, problem: result.problem };
}

/** El candidato probado no era (la pantalla dice otra cosa): se prueba el siguiente sin pedir otra pesada. */
export function nextCandidate(): LearnOutcome {
  const current = pairing;
  if (!current) return { best: null, total: 0, problem: 'no-match' };
  const next = activate(current.index + 1);
  return { best: next, total: current.candidates.length, problem: next ? null : 'no-match' };
}

/** Da por buena la báscula: guarda el dispositivo con lo aprendido y la deja en uso. */
export async function finishPairing(): Promise<SavedScale | null> {
  const current = pairing;
  const candidate = current?.candidates[current.index];
  if (!current || !candidate) return null;
  const saved: SavedScale = { id: current.device.id, name: current.device.name ?? 'Báscula', decoder: candidate.decoder, pairedMs: svc().now() };
  await svc().store.setScale(saved);
  scaleSaved.value = saved;
  pairing = null;
  // La sesión del emparejado ya está conectada y con el decodificador puesto: sigue como sesión de uso.
  return saved;
}

/** Deja el emparejado sin guardar nada y suelta la báscula. */
export async function cancelPairing(): Promise<void> {
  pairing = null;
  await session?.stop();
  session?.setDecoder(null);
}

/** El informe de diagnóstico (lo que anuncia, su tabla GATT, las tramas y lo aprendido), como texto. */
export async function scaleReport(): Promise<string> {
  const current = ensureSession();
  const transport = scaleTransport();
  const saved = scaleSaved.value;
  const environment = await transport?.environment?.().catch((e: unknown) => ({ error: String(e) }));
  const state = scaleState.value;
  return buildScaleReport({
    appBuild: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'desconocida',
    nowMs: svc().now(),
    device: pairing?.device ?? (saved ? { id: saved.id, name: saved.name } : null),
    advert: current?.advert() ?? null,
    details: (await current?.details()) ?? null,
    subscribed: current?.subscribed() ?? [],
    frames: current?.frames() ?? [],
    decoder: saved?.decoder ?? pairing?.candidates[pairing.index]?.decoder ?? null,
    candidates: pairing?.candidates ?? [],
    labels: pairing?.labels ?? [],
    notes: state.message ? [state.message] : [],
    environment: environment ?? null,
    status: state.status,
    problem: pairing?.lastResult?.problem === 'no-frames' ? 'no llegó ninguna trama' : pairing?.lastResult?.problem === 'no-match' ? 'ningún campo de las tramas cuadra con lo que marcaba la pantalla' : null,
  });
}
