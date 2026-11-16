import { loadDayBundle } from '../app/queries';
import { WorkoutController, type LiveWorkoutState, type WorkoutPlatform } from '../app/workout-controller';
import { DiagnosticLog, SHARED_LOG_FRAMES } from '../ble/diag';
import { RingError } from '../ble/errors';
import { YcbtSession, type Timeouts } from '../ble/session';
import type { RingLink, RingTransport, ScanEntry } from '../ble/transport';
import type { Store } from '../data/types';
import { addDays, dayKeyOf } from '../domain/dates';
import type { ResolvedProfile } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import { runSync, SyncFailure, type SyncReport } from '../sync/run-sync';
import {
  analyzeHeartEvents,
  analyzeStepsRun,
  androidVersion,
  describeDevice,
  fmtSeconds,
  foreignTraffic,
  maskId,
  pickRing,
  plural,
  ringScore,
  toHeartEvent,
  type HeartEvent,
  type StepSample,
} from './analysis';
import type { Cue } from './cues';
import {
  countStatuses,
  renderReport,
  renderSummary,
  type SelfTestReport,
  type StepId,
  type StepRecord,
  type StepStatus,
  type TimelineEntry,
} from './report';
import type { ReportSaver, SavedFile } from './save';

// La prueba guiada del anillo: recorre de principio a fin lo que la app hará con el anillo real (buscar, conectar,
// sincronizar, pasos en directo, pulso, entreno y soltarlo), dice qué hacer en cada momento y lo apunta todo en un informe.
// Es temporal: sirve para la primera toma de contacto con el anillo. Para quitarla basta borrar `src/selftest` y los tres
// sitios que la enganchan (la tarjeta del resumen, su hoja en `App` y el uso `test` del anillo en `state.ts`).

export interface StepDef {
  id: StepId;
  title: string;
  /** Qué hace el paso, para la lista de la hoja. */
  hint: string;
}

export const STEP_DEFS: readonly StepDef[] = [
  { id: 'env', title: 'Móvil y Bluetooth', hint: 'Permisos, Bluetooth y ubicación.' },
  { id: 'scan', title: 'Buscar el anillo', hint: 'Lo busca por Bluetooth (10 s).' },
  { id: 'connect', title: 'Conectar y saludar', hint: 'Conecta, lee su información y se desconecta.' },
  { id: 'sync', title: 'Sincronizar', hint: 'Descarga pasos, sueño y pulso del anillo.' },
  { id: 'steps', title: 'Pasos en directo', hint: 'Caminas 30 s seguidos (≈ 1 min).' },
  { id: 'heart', title: 'Medir el pulso', hint: 'Quieto, unos 40 s.' },
  { id: 'workout', title: 'Entreno de prueba', hint: 'Caminas 2 min.' },
  { id: 'resync', title: 'Sincronizar otra vez', hint: 'Comprueba que lo caminado suma en el contador del día.' },
  { id: 'release', title: 'Comprobar que lo suelta', hint: 'El anillo debe quedar libre.' },
];

export type UiStepStatus = 'pending' | 'running' | StepStatus;

/** Lo que la persona debe hacer o ver ahora mismo. */
export interface Prompt {
  title: string;
  text?: string;
  /** Instante (reloj) en que acaba la fase, para la cuenta atrás. */
  endsAtMs?: number;
  /** Si lo hay, la prueba espera a que se pulse este botón. */
  button?: string;
  /** Un dato en directo: pulso, pasos… */
  live?: string;
}

export interface SelfTestResult {
  cancelled: boolean;
  counts: Record<StepStatus, number>;
  /** El informe entero (el que se guarda) y su resumen (lo que se puede copiar para pegarlo en un mensaje). */
  report: string;
  summary: string;
  filename: string;
  /** Dónde se guardó: el último guardado que salió bien (puede ser parcial si falló el final). */
  file: SavedFile | null;
  saveError: string | null;
}

export interface SelfTestUi {
  phase: 'running' | 'saving' | 'done';
  steps: Array<StepDef & { status: UiStepStatus; summary: string | null }>;
  prompt: Prompt | null;
  cancelling: boolean;
  /** Se ha pulsado «Saltar»: el paso acaba en cuanto termina la operación con el anillo que tuviera en curso. */
  skipping: boolean;
  startedMs: number;
  result: SelfTestResult | null;
}

export interface SelfTestDeps {
  transport: RingTransport;
  store: Store;
  now: () => number;
  saver: ReportSaver;
  getProfile: () => ResolvedProfile;
  onUpdate: (ui: SelfTestUi) => void;
  /** Datos del móvil para el informe. */
  phone: () => Promise<Record<string, unknown>>;
  app: { build: string; builtAt: string; native: boolean; demo: boolean };
  cue?: (cue: Cue) => void;
  /** Bloqueo de pantalla y avisos de visibilidad de la página; sin ellos la prueba corre igual. */
  platform?: Pick<WorkoutPlatform, 'wakeLock' | 'onVisible' | 'onHidden'>;
  /** Escala de las esperas propias de la prueba (1 = las reales); las pruebas automáticas la reducen. */
  timeScale?: number;
  /** No espera a «Estoy listo» (pruebas automáticas). */
  autoReady?: boolean;
  /** Tiempos del sensor de pulso: solo se tocan con el anillo simulado. */
  hrTiming?: { hrWarmupMs?: number; hrStreamAfterMs?: number };
  sessionTimeouts?: Partial<Timeouts>;
  /** Pausa (ms reales) antes de conectar de nuevo tras soltar el anillo; por defecto, 2 s por la escala. Las pruebas la fijan. */
  settleMs?: number;
  /** Cuánto se espera a que Android responda a los permisos (ms reales); por defecto, 90 s. Las pruebas lo acortan. */
  permissionWaitMs?: number;
}

interface Outcome {
  status: StepStatus;
  summary: string;
  data?: Record<string, unknown>;
  traces?: Record<string, string>;
}

interface OpenedRing {
  session: YcbtSession;
  link: RingLink;
  /** Por qué camino se conectó: `reconnect` (el anillo guardado, sin selector), `connectTo` (el visto al buscar) o `picker`. */
  via: 'reconnect' | 'connectTo' | 'picker';
  connectMs: number;
  handshakeMs: number;
}

const SCAN_MS = 10_000;
/** La marcha de la prueba de pasos y lo que se espera quieto al terminarla antes de releer el contador. */
const WALK_MS = 30_000;
const TAIL_MS = 4_000;
/**
 * Por debajo de esto, el anillo «no contó» la marcha. En una captura real el R99 tardó ~9 s en validar que se caminaba y
 * entonces sumó de golpe 11 pasos: con menos marcha o sin mover el brazo (el móvil en la mano del anillo) no cuenta nada.
 */
const MIN_COUNTED_STEPS = 15;
/** Lo que se espera (sin escalar: es el anillo, no la persona) a los envíos de pasos si `sessionTimeouts.status` no lo fija. */
const STATUS_WAIT_MS = 6_000;
/** Pasos caminados a partir de los cuales el contador del día tiene que haber subido de forma apreciable. */
const MIN_WALKED_TO_COMPARE = 30;
const HEART_COUNTDOWN_MS = 5_000;
const WORKOUT_MS = 120_000;
const WORKOUT_COUNTDOWN_MS = 5_000;
const WORKOUT_SNAPSHOT_MS = 10_000;
/** Pausa antes de cada conexión nueva: una persona nunca vuelve a conectar un milisegundo después de soltar el anillo. */
const SETTLE_MS = 2_000;
const RELEASE_PAUSE_MS = 3_000;
const RELEASE_SCAN_MS = 8_000;
/** Lo que se espera a que la persona responda a los permisos de Android antes de darlos por no concedidos. */
const PERMISSION_WAIT_MS = 90_000;
/** Los pasos que abren el anillo por su cuenta (pasos, pulso) lo intentan dos veces: un fallo puntual de Android no debe costar el paso. */
const OPEN_ATTEMPTS = 2;
const MAX_TIMELINE = 600;
const MAX_LIVE_EVENTS = 400;
const MAX_DEVICES_LISTED = 25;
const MAX_CAPTURED_ERRORS = 80;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const describeError = (error: unknown): Record<string, unknown> => ({
  name: error instanceof Error ? error.name : typeof error,
  message: messageOf(error),
  ...(error instanceof RingError ? { code: error.code } : {}),
  ...(error instanceof SyncFailure ? { code: error.code } : {}),
});

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Repetir una conexión que falló tiene sentido salvo que falte un permiso, el Bluetooth esté apagado o el dispositivo no hable YCBT. */
const isRetryable = (error: unknown): boolean => !(error instanceof RingError) || !['unsupported-platform', 'no-device', 'aborted', 'protocol'].includes(error.code);

/** Las direcciones Bluetooth de las listas del entorno, abreviadas como en el resto del informe. */
function maskDeviceLists(env: Record<string, unknown>): Record<string, unknown> {
  const out = { ...env };
  for (const key of ['connectedDevices', 'bondedDevices']) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((device: unknown) => (device && typeof device === 'object' && 'id' in device ? { ...device, id: maskId(String((device as { id: unknown }).id)) } : device));
  }
  return out;
}

/** Los dispositivos conectados ahora mismo cuyo nombre es el de un anillo R99 (los tiene cogidos otra app o la propia). */
function ringHolders(platform: Record<string, unknown>): string[] {
  const list = platform.connectedDevices;
  if (!Array.isArray(list)) return [];
  return list.flatMap((device: unknown) => {
    const name = device && typeof device === 'object' ? (device as { name?: unknown }).name : null;
    return typeof name === 'string' && /^r99/i.test(name.trim()) ? [name.trim()] : [];
  });
}
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class SelfTest {
  private readonly scale: number;
  private readonly records: StepRecord[] = [];
  private readonly statuses = new Map<StepId, { status: UiStepStatus; summary: string | null }>();
  private readonly traces: Record<string, string> = {};
  private readonly timeline: TimelineEntry[] = [];
  private startedMs = 0;
  private startedAtIso = '';
  private startedAtLocal = '';
  private prompt: Prompt | null = null;
  private phase: SelfTestUi['phase'] = 'running';
  private cancelled = false;
  private skipping = false;
  private stepAbort = new AbortController();
  private openGate: ((proceed: boolean) => void) | null = null;
  private candidate: ScanEntry | null = null;
  private ringOk = false;
  private ringId: string | null = null;
  /** Lo que se ha visto en pasos anteriores y la segunda sincronización necesita para comparar. */
  private syncLiveSteps: number | null = null;
  private stepsCounted: number | null = null;
  private workoutSteps: number | null = null;
  private phone: Record<string, unknown> = {};
  private result: SelfTestResult | null = null;
  private lock: { release(): Promise<void>; released?: boolean } | null = null;
  private stopWatching: Array<() => void> = [];
  private savedFile: SavedFile | null = null;
  private progressSaveBroken = false;
  private running = false;

  constructor(private readonly deps: SelfTestDeps) {
    this.scale = deps.timeScale ?? 1;
    for (const def of STEP_DEFS) this.statuses.set(def.id, { status: 'pending', summary: null });
  }

  // ───────────────────────────── control desde la interfaz ─────────────────────────────

  /** La persona pulsa «Estoy listo» (o «Reintentar»). */
  ready(): void {
    this.openGate?.(true);
  }

  /** Salta el paso en curso. */
  skip(): void {
    if (!this.running || this.cancelled || this.interrupted) return;
    this.log('La persona salta este paso');
    this.skipping = true;
    this.stepAbort.abort();
    this.emit();
  }

  /** Cancela la prueba: el paso en curso se detiene, se suelta el anillo y se guarda lo hecho hasta ahora. */
  cancel(): void {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.log('La persona cancela la prueba');
    this.stepAbort.abort();
    this.emit();
  }

  /** Recorre todos los pasos y guarda el informe. No lanza nunca: lo que falle queda apuntado en el informe. */
  async run(): Promise<SelfTestResult> {
    this.running = true;
    this.startedMs = this.deps.now();
    this.startedAtIso = new Date(this.startedMs).toISOString();
    this.startedAtLocal = new Date(this.startedMs).toString();
    this.log('Inicio de la prueba');
    this.emit();
    this.watchPage();
    await this.acquireLock();
    try {
      await this.runStep('env', () => this.stepEnv());
      await this.runStep('scan', () => this.stepScan());
      await this.runStep('connect', () => this.stepConnect());
      await this.runStep('sync', () => this.stepSync());
      await this.runStep('steps', () => this.stepSteps());
      await this.runStep('heart', () => this.stepHeart());
      await this.runStep('workout', () => this.stepWorkout());
      await this.runStep('resync', () => this.stepResync());
      await this.runStep('release', () => this.stepRelease());
    } finally {
      await this.releaseLock();
      for (const stop of this.stopWatching) stop();
      this.stopWatching = [];
    }
    this.cue('done');
    return this.finish();
  }

  // ───────────────────────────── esqueleto de los pasos ─────────────────────────────

  private get interrupted(): boolean {
    return this.stepAbort.signal.aborted;
  }

  private elapsed(): number {
    return this.deps.now() - this.startedMs;
  }

  private log(text: string): void {
    this.timeline.push({ t: this.elapsed(), text });
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(1, this.timeline.length - MAX_TIMELINE);
  }

  private cue(cue: Cue): void {
    try {
      this.deps.cue?.(cue);
    } catch {
      /* un aviso que falla no estropea la prueba */
    }
  }

  private async runStep(id: StepId, fn: () => Promise<Outcome>): Promise<void> {
    const def = STEP_DEFS.find((d) => d.id === id) as StepDef;
    this.stepAbort = new AbortController();
    this.skipping = false;
    if (this.cancelled) this.stepAbort.abort();
    const startMs = this.elapsed();
    let outcome: Outcome;
    if (this.cancelled) {
      outcome = { status: 'skipped', summary: 'Prueba cancelada antes de llegar aquí.' };
    } else {
      this.setStatus(id, 'running', null);
      this.log(`Paso «${def.title}»`);
      try {
        outcome = await fn();
      } catch (error) {
        outcome = this.interrupted
          ? { status: 'skipped', summary: this.cancelled ? 'Cancelado.' : 'Saltado por la persona.' }
          : { status: 'fail', summary: messageOf(error), data: { error: describeError(error) } };
      }
    }
    outcome = this.flagForeignTraffic(outcome);
    const record: StepRecord = { id, title: def.title, status: outcome.status, startMs, durationMs: this.elapsed() - startMs, summary: outcome.summary };
    if (outcome.data) record.data = outcome.data;
    this.records.push(record);
    Object.assign(this.traces, outcome.traces ?? {});
    this.log(`Resultado «${def.title}»: ${outcome.status} — ${outcome.summary}`);
    this.prompt = null;
    this.setStatus(id, outcome.status, outcome.summary);
    await this.saveProgress();
  }

  /**
   * Si en las trazas del paso aparecen respuestas que esta app no pidió (el apretón de manos de otra app), se avisa: un paso
   * correcto pasa a «aviso» y el resumen dice cuándo ocurrió. La causa habitual es Smart Health viva en segundo plano.
   */
  private flagForeignTraffic(outcome: Outcome): Outcome {
    if (outcome.status === 'skipped' || !outcome.traces) return outcome;
    for (const [name, trace] of Object.entries(outcome.traces)) {
      const foreign = foreignTraffic(trace);
      if (!foreign) continue;
      const note = `otra app habló con el anillo a los ${fmtSeconds(foreign.firstMs)} (¿Smart Health en segundo plano?)`;
      this.log(`Paso con tráfico ajeno en la traza «${name}»: ${note}`);
      return {
        ...outcome,
        status: outcome.status === 'ok' ? 'warn' : outcome.status,
        summary: `${outcome.summary} · ${note}`,
        data: { ...outcome.data, foreignTraffic: { trace: name, ...foreign } },
      };
    }
    return outcome;
  }

  private setStatus(id: StepId, status: UiStepStatus, summary: string | null): void {
    this.statuses.set(id, { status, summary });
    this.emit();
  }

  private setPrompt(prompt: Prompt | null): void {
    this.prompt = prompt;
    if (prompt) this.log(`Se indica: ${prompt.title}${prompt.text ? ` — ${prompt.text}` : ''}`);
    this.emit();
  }

  /** Actualiza el dato en directo del aviso actual sin apuntarlo en la cronología (cambia cada segundo). */
  private setLive(live: string): void {
    if (!this.prompt) return;
    this.prompt = { ...this.prompt, live };
    this.emit();
  }

  private endsIn(ms: number): number {
    return this.deps.now() + ms * this.scale;
  }

  /** Espera `ms` (por la escala de la prueba, salvo `scaled: false`); se corta al saltar el paso o cancelar. */
  private wait(ms: number, scaled = true): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stepAbort.signal;
      if (signal.aborted) return resolve();
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, scaled ? ms * this.scale : ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** La pausa antes de cada conexión nueva. */
  private settle(): Promise<void> {
    return this.deps.settleMs === undefined ? this.wait(SETTLE_MS) : this.wait(this.deps.settleMs, false);
  }

  /** Muestra el aviso con un botón y espera a que se pulse. `false` si se salta el paso o se cancela. */
  private async gate(prompt: Prompt): Promise<boolean> {
    this.setPrompt({ ...prompt, button: prompt.button ?? 'Estoy listo' });
    this.cue('attention');
    if (this.deps.autoReady) return !this.interrupted;
    const proceed = await new Promise<boolean>((resolve) => {
      const signal = this.stepAbort.signal;
      const onAbort = (): void => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.openGate = (go) => {
        signal.removeEventListener('abort', onAbort);
        resolve(go);
      };
      if (signal.aborted) resolve(false);
    });
    this.openGate = null;
    return proceed && !this.interrupted;
  }

  /**
   * El mismo transporte, pero apuntando cómo se conecta el flujo que lo usa: si reconecta por el anillo guardado o tiene que
   * abrir el selector (lo que el usuario vería como un diálogo inesperado), y cuánto tarda cada intento.
   */
  private spyTransport(calls: string[]): RingTransport {
    const { transport } = this.deps;
    /** Lo que el transporte ha apuntado por su cuenta (p. ej. por qué falló un intento de reconexión). */
    const notes = (): void => {
      for (const note of transport.takeNotes?.() ?? []) calls.push(`  · ${note}`);
    };
    return {
      kind: transport.kind,
      available: transport.available,
      ...(transport.unavailableReason ? { unavailableReason: transport.unavailableReason } : {}),
      pickAndConnect: async (options) => {
        const started = Date.now();
        // El selector de Bluetooth es un diálogo del sistema que aparece encima: la persona tiene que saber que debe elegir.
        const previous = this.prompt;
        this.setPrompt({ title: 'Elige tu anillo', text: 'Elígelo en la lista de Bluetooth (suele llamarse «R99…»).' });
        try {
          const link = await transport.pickAndConnect(options);
          calls.push(`pickAndConnect → conectado (${Date.now() - started} ms)`);
          return link;
        } catch (error) {
          calls.push(`pickAndConnect → ${messageOf(error)} (${Date.now() - started} ms)`);
          throw error;
        } finally {
          notes();
          if (this.prompt?.title === 'Elige tu anillo') {
            this.prompt = previous;
            this.emit();
          }
        }
      },
      reconnect: async (saved) => {
        const started = Date.now();
        try {
          const link = await transport.reconnect(saved);
          calls.push(`reconnect → ${link ? 'conectado' : 'sin conexión (null)'} (${Date.now() - started} ms)`);
          return link;
        } finally {
          notes();
        }
      },
    };
  }

  private skipped(summary: string, data?: Record<string, unknown>): Outcome {
    return { status: 'skipped', summary, ...(data ? { data } : {}) };
  }

  private noRing(): Outcome {
    return this.skipped('Sin conexión con el anillo: no se puede hacer.');
  }

  // ───────────────────────────── pantalla, avisos de página, guardado ─────────────────────────────

  private async acquireLock(): Promise<void> {
    try {
      this.lock = (await this.deps.platform?.wakeLock?.request('screen')) ?? null;
    } catch {
      this.log('No se pudo mantener la pantalla encendida');
    }
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    await lock?.release().catch(() => undefined);
  }

  /** Apunta cuándo la app pasa a segundo plano o vuelve: un Bluetooth cortado a mitad de un paso suele deberse a eso. */
  private watchPage(): void {
    const platform = this.deps.platform;
    const stopHidden = platform?.onHidden?.(() => this.log('La app ha pasado a segundo plano o se ha oculto la página'));
    const stopVisible = platform?.onVisible?.(() => {
      this.log('La app vuelve a verse');
      // El sistema suelta el bloqueo de pantalla al ocultar la app: se vuelve a pedir.
      if (this.running && (!this.lock || this.lock.released === true)) void this.acquireLock();
    });
    if (stopHidden) this.stopWatching.push(stopHidden);
    if (stopVisible) this.stopWatching.push(stopVisible);
    this.captureErrors();
  }

  /**
   * Apunta en la cronología los errores de la propia página (una excepción, una promesa rechazada que nadie recoge, un
   * `console.error`): en un móvil no hay consola a la vista y, si un plugin falla en silencio, es la única pista.
   */
  private captureErrors(): void {
    let count = 0;
    const note = (what: string, detail: string): void => {
      if (++count > MAX_CAPTURED_ERRORS) return;
      this.log(`${what}: ${detail.slice(0, 400)}`);
    };
    const target = globalThis as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
    const onError = (event: Event): void => note('error de la página', (event as ErrorEvent).message ?? String(event));
    const onRejection = (event: Event): void => note('promesa rechazada sin gestionar', messageOf((event as PromiseRejectionEvent).reason));
    target.addEventListener?.('error', onError);
    target.addEventListener?.('unhandledrejection', onRejection);
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      note('console.error', args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
      original.apply(console, args);
    };
    this.stopWatching.push(() => {
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('unhandledrejection', onRejection);
      console.error = original;
    });
  }

  private buildReport(complete: boolean): SelfTestReport {
    return {
      version: 1,
      app: { ...this.deps.app, transport: this.deps.transport.kind },
      startedAtIso: this.startedAtIso,
      startedAtLocal: this.startedAtLocal,
      finishedAtIso: complete ? new Date(this.deps.now()).toISOString() : null,
      complete: complete && !this.cancelled,
      cancelled: this.cancelled,
      phone: this.phone,
      steps: this.records,
      timeline: this.timeline,
      traces: this.traces,
    };
  }

  /** Guardado de seguridad tras cada paso: si algo cuelga la app, lo hecho hasta ahí ya está en Descargas. */
  private async saveProgress(): Promise<void> {
    if (this.progressSaveBroken) return;
    try {
      const saved = await this.deps.saver.save(renderReport(this.buildReport(false)), { final: false });
      if (saved) this.savedFile = saved;
    } catch (error) {
      // Si falla una vez fallará siempre (permisos, espacio…): no se insiste hasta el guardado final.
      this.progressSaveBroken = true;
      this.log(`No se pudo guardar el informe parcial: ${messageOf(error)}`);
    }
  }

  private async finish(): Promise<SelfTestResult> {
    this.running = false;
    this.phase = 'saving';
    this.prompt = { title: 'Guardando el informe…' };
    this.emit();
    this.log('Fin de la prueba');
    const report = this.buildReport(true);
    const text = renderReport(report);
    let saveError: string | null = null;
    try {
      const saved = await this.deps.saver.save(text, { final: true });
      if (saved) this.savedFile = saved;
    } catch (error) {
      saveError = messageOf(error);
    }
    const result: SelfTestResult = {
      cancelled: this.cancelled,
      counts: countStatuses(this.records),
      report: text,
      summary: renderSummary(report),
      filename: this.deps.saver.filename,
      file: this.savedFile,
      saveError,
    };
    this.result = result;
    this.phase = 'done';
    this.prompt = null;
    this.emit();
    return result;
  }

  private emit(): void {
    this.deps.onUpdate({
      phase: this.phase,
      steps: STEP_DEFS.map((def) => ({ ...def, ...(this.statuses.get(def.id) ?? { status: 'pending' as const, summary: null }) })),
      prompt: this.prompt,
      cancelling: this.cancelled && this.running,
      skipping: this.skipping && this.running && !this.cancelled,
      startedMs: this.startedMs,
      result: this.result,
    });
  }

  // ───────────────────────────── paso: móvil y Bluetooth ─────────────────────────────

  private async stepEnv(): Promise<Outcome> {
    const { transport } = this.deps;
    this.setPrompt({ title: 'Preparando la prueba…', text: 'Si Android te pide permisos de Bluetooth («Dispositivos cercanos») o de ubicación, acéptalos; la ubicación, precisa.' });
    this.phone = await this.deps.phone();

    let platform: Record<string, unknown> = {};
    let problem: string | null = null;
    for (let attempt = 1; ; attempt++) {
      platform = await this.environment();
      problem = this.environmentProblem(platform);
      if (!problem || attempt >= 3 || !transport.available) break;
      const retry = await this.gate({ title: 'Falta un ajuste del móvil', text: `${problem} Cuando lo hayas arreglado, pulsa «Reintentar».`, button: 'Reintentar' });
      if (!retry) break;
      this.setPrompt({ title: 'Comprobando otra vez…' });
    }

    const device = (this.phone as { device?: { manufacturer?: string; model?: string; osVersion?: string } }).device;
    const who = device ? `${[device.manufacturer, device.model].filter(Boolean).join(' ')} · Android ${androidVersion(device.osVersion)}` : 'móvil sin datos';
    const flag = (value: unknown): string => (value === true ? 'activado' : value === false ? 'apagado' : 'sin dato');
    const summary = `${who} · Bluetooth ${flag(platform.bluetoothEnabled)} · ubicación ${flag(platform.locationEnabled)}${problem ? ` · ${problem}` : ''}`;
    const initializeFailed = typeof platform.initialize === 'string' && platform.initialize !== 'ok';
    const status: StepStatus = !transport.available || initializeFailed ? 'fail' : problem ? 'warn' : 'ok';
    return { status, summary, data: { transportAvailable: transport.available, unavailableReason: transport.unavailableReason ?? null, platform } };
  }

  private async environment(): Promise<Record<string, unknown>> {
    const { transport } = this.deps;
    if (!transport.environment) return { transport: transport.kind };
    try {
      return maskDeviceLists(await withTimeout(transport.environment(), this.deps.permissionWaitMs ?? PERMISSION_WAIT_MS, 'No se respondió a los permisos a tiempo.'));
    } catch (error) {
      // Si Android no contesta, lo que el transporte fue anotando (cuánto tardó cada petición) es la única pista de dónde se atascó.
      const notes = transport.takeNotes?.() ?? [];
      return { initialize: `error: ${messageOf(error)}`, ...(notes.length > 0 ? { notes } : {}) };
    }
  }

  private environmentProblem(platform: Record<string, unknown>): string | null {
    const { transport } = this.deps;
    if (!transport.available) return transport.unavailableReason ?? 'Este dispositivo no puede usar Bluetooth desde la app.';
    if (typeof platform.initialize === 'string' && platform.initialize !== 'ok') {
      return 'No se pudo preparar el Bluetooth: revisa en Ajustes → Aplicaciones → SmartHealth → Permisos que «Dispositivos cercanos» y «Ubicación» (precisa) están permitidos.';
    }
    if (platform.bluetoothEnabled === false) return 'El Bluetooth del móvil está apagado: actívalo.';
    if (platform.locationEnabled === false) return 'La ubicación del móvil está apagada: actívala (Android la exige para buscar dispositivos Bluetooth).';
    const holders = ringHolders(platform);
    if (holders.length > 0) {
      return `«${holders[0]}» ya está conectado al móvil, seguramente a Smart Health: ciérrala del todo (Ajustes → Aplicaciones → Smart Health → Forzar detención), porque el anillo solo admite una conexión.`;
    }
    return null;
  }

  // ───────────────────────────── paso: buscar el anillo ─────────────────────────────

  private async stepScan(): Promise<Outcome> {
    const { transport } = this.deps;
    if (!transport.scan) return this.skipped('Este sistema no deja buscar sin el selector de Bluetooth: se elegirá el anillo en una lista.');

    const attempts: Array<Record<string, unknown>> = [];
    let entries: ScanEntry[] = [];
    let candidate: ScanEntry | null = null;
    for (let attempt = 1; attempt <= 3 && !candidate && !this.interrupted; attempt++) {
      this.setPrompt({
        title: 'Buscando el anillo…',
        text: 'Ponte el anillo en el dedo y acércalo al móvil. Smart Health tiene que estar cerrada del todo.',
        endsAtMs: this.endsIn(SCAN_MS),
      });
      const started = this.deps.now();
      try {
        entries = await transport.scan(SCAN_MS * this.scale);
        attempts.push({ attempt, durationMs: this.deps.now() - started, devicesSeen: entries.length });
        candidate = pickRing(entries);
      } catch (error) {
        attempts.push({ attempt, durationMs: this.deps.now() - started, error: describeError(error) });
        if (!(error instanceof RingError) || error.code !== 'unsupported-platform' || attempt >= 3) break;
        if (!(await this.gate({ title: 'No se puede buscar', text: `${error.message} Cuando lo hayas arreglado, pulsa «Reintentar».`, button: 'Reintentar' }))) break;
        continue;
      }
      if (!candidate && attempt < 3) {
        this.setPrompt({
          title: 'Todavía no lo veo',
          text: 'Acerca el anillo al móvil, tócalo para despertarlo y comprueba que Smart Health está cerrada (Ajustes → Aplicaciones → Smart Health → Forzar detención). Vuelvo a buscar.',
        });
        await this.wait(4000);
      }
    }
    if (this.interrupted && !candidate) return this.skipped('Búsqueda interrumpida.', { attempts });

    this.candidate = candidate;
    const sorted = [...entries].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
    const data = {
      attempts,
      devicesSeen: entries.length,
      ring: candidate ? describeDevice(candidate, true) : null,
      ringScore: candidate ? ringScore(candidate) : 0,
      nearby: sorted.filter((e) => e !== candidate).slice(0, MAX_DEVICES_LISTED).map((e) => describeDevice(e, false)),
    };
    if (!candidate) return { status: 'fail', summary: `No se ve el anillo entre ${entries.length} dispositivos Bluetooth: se elegirá a mano en la lista.`, data };
    const strong = candidate.name !== null && /^r99/i.test(candidate.name);
    return {
      status: strong ? 'ok' : 'warn',
      summary: `${candidate.name ?? 'Sin nombre'} (${candidate.rssi ?? '?'} dBm)${strong ? '' : ' · identificado solo por sus servicios o datos de fabricante, no por el nombre «R99»'}`,
      data,
    };
  }

  // ───────────────────────────── paso: conectar y saludar ─────────────────────────────

  private async stepConnect(): Promise<Outcome> {
    const { transport, store } = this.deps;
    const log = new DiagnosticLog();
    const attempts: Array<Record<string, unknown>> = [];
    const data: Record<string, unknown> = { attempts };
    let ready: { link: RingLink; session: YcbtSession; via: OpenedRing['via']; connectMs: number; handshakeMs: number; info: Awaited<ReturnType<YcbtSession['open']>> } | null = null;
    let lastStage: 'conexión' | 'saludo' = 'conexión';
    let lastError: unknown = null;

    // Cada intento conecta Y saluda: un saludo sin respuesta (el anillo aún dormido, una notificación que no llegó) se repite igual
    // que una conexión fallida, porque de este paso depende todo lo demás.
    for (let attempt = 1; attempt <= 3 && !ready && !this.interrupted; attempt++) {
      const usePicker = !this.candidate || !transport.connectTo || attempt === 3;
      const via: OpenedRing['via'] = usePicker ? 'picker' : 'connectTo';
      this.setPrompt(
        usePicker
          ? { title: 'Elige tu anillo', text: 'Elígelo en la lista de Bluetooth (suele llamarse «R99…»).' }
          : { title: 'Conectando con el anillo…', text: 'Puede tardar unos segundos.' },
      );
      const tried = Date.now();
      let link: RingLink | null = null;
      let session: YcbtSession | null = null;
      lastStage = 'conexión';
      try {
        link = usePicker || !transport.connectTo || !this.candidate ? await transport.pickAndConnect({ showAll: true }) : await transport.connectTo(this.candidate);
        const connectMs = Date.now() - tried;
        lastStage = 'saludo';
        this.setPrompt({ title: 'Hablando con el anillo…' });
        const details = await link.details?.().catch((error: unknown) => ({ error: messageOf(error) }));
        if (details) data.link = details;
        session = new YcbtSession(link, { log, ...(this.deps.sessionTimeouts ? { timeouts: this.deps.sessionTimeouts } : {}) });
        const handshakeStart = Date.now();
        const info = await session.open(new Date(this.deps.now()));
        ready = { link, session, via, connectMs, handshakeMs: Date.now() - handshakeStart, info };
        attempts.push({ attempt, via, ok: true, ms: connectMs, handshakeMs: ready.handshakeMs });
      } catch (error) {
        lastError = error;
        attempts.push({ attempt, via, stage: lastStage, ok: false, ms: Date.now() - tried, error: describeError(error) });
        await (session ? session.close() : link?.disconnect())?.catch(() => undefined);
        if (error instanceof RingError && error.code === 'no-device') break; // cerró el selector sin elegir
        if (attempt >= 3 || this.interrupted) break;
        if (!(await this.gate(this.connectRetryPrompt(error, lastStage)))) break;
      } finally {
        for (const note of transport.takeNotes?.() ?? []) log.info(`transporte: ${note}`);
      }
    }
    if (!ready) {
      if (this.interrupted) return this.skipped('Conexión interrumpida.', { attempts });
      const tries = attempts.length;
      return {
        status: 'fail',
        summary: lastStage === 'saludo' ? `Conectó, pero falló el saludo: ${messageOf(lastError)}` : `No se pudo conectar con el anillo (${tries} intento${tries === 1 ? '' : 's'}).`,
        data: { ...data, ...(lastError ? { error: describeError(lastError) } : {}) },
        traces: { connect: log.toText() },
      };
    }

    const { link, session, via, connectMs, handshakeMs, info } = ready;
    Object.assign(data, { via, connectMs, handshakeMs });
    try {
      data.ring = { id: maskId(link.id), name: link.name, firmware: info.firmware, batteryPercent: info.batteryPercent, capabilities: info.capabilities ? [...info.capabilities].sort() : null };
      await store.setRing({ id: link.id, name: link.name });
      this.ringOk = true;
      this.ringId = link.id;
      const summary = `${link.name} · firmware ${info.firmware ?? '?'} · batería ${info.batteryPercent ?? '?'} % · conectado en ${fmtSeconds(connectMs)}, saludo en ${fmtSeconds(handshakeMs)}`;
      return {
        status: info.capabilities ? 'ok' : 'warn',
        summary: info.capabilities ? summary : `${summary} · el anillo no declaró sus funciones`,
        data,
        traces: { connect: log.toText() },
      };
    } catch (error) {
      return { status: 'fail', summary: `Conectó y saludó, pero no se pudo guardar el anillo: ${messageOf(error)}`, data: { ...data, error: describeError(error) }, traces: { connect: log.toText() } };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Qué decirle a la persona cuando falla una conexión o un saludo y se le ofrece reintentar. */
  private connectRetryPrompt(error: unknown, stage: 'conexión' | 'saludo'): Prompt {
    const message = messageOf(error);
    if (stage === 'saludo') {
      return { title: 'El anillo no contestó', text: `Conectó, pero no respondió al saludo (${message.replace(/\.$/, '')}). Acércalo al móvil, tócalo para despertarlo y pulsa «Reintentar».`, button: 'Reintentar' };
    }
    // Un permiso, el Bluetooth o la ubicación no se arreglan cerrando Smart Health: el mensaje ya dice qué hacer.
    if (error instanceof RingError && error.code === 'unsupported-platform') {
      return { title: 'No se pudo conectar', text: `${message} Cuando lo hayas arreglado, pulsa «Reintentar».`, button: 'Reintentar' };
    }
    return {
      title: 'No se pudo conectar',
      text: `${message} Cierra Smart Health del todo (Ajustes → Aplicaciones → Smart Health → Forzar detención), acerca el anillo y pulsa «Reintentar».`,
      button: 'Reintentar',
    };
  }

  /**
   * Abre una sesión como lo hacen la medida y el entreno: por el anillo guardado y, si no, por el visto al buscar o el selector.
   * Si falla (una conexión que Android corta a la primera, un saludo sin respuesta) lo intenta una vez más tras la pausa.
   */
  private async openRing(log: DiagnosticLog): Promise<OpenedRing> {
    this.setPrompt({ title: 'Conectando con el anillo…', text: 'Puede tardar unos segundos.' });
    let lastError: unknown = new RingError('No se pudo conectar con el anillo.', 'connect-failed');
    for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
      await this.settle();
      // Interrumpido durante la pausa: no se llega a conectar (quien llama lo trata como un paso saltado).
      if (this.interrupted) throw new RingError('Interrumpido antes de conectar.', 'aborted');
      try {
        return await this.openOnce(log);
      } catch (error) {
        lastError = error;
        const retrying = attempt < OPEN_ATTEMPTS && !this.interrupted && isRetryable(error);
        log.warn(`Conexión, intento ${attempt} de ${OPEN_ATTEMPTS}: ${messageOf(error)}${retrying ? ' (se reintenta)' : ''}`);
        this.log(`Conexión, intento ${attempt} de ${OPEN_ATTEMPTS}: ${messageOf(error)}`);
        if (!retrying) break;
        this.setPrompt({ title: 'Reconectando…', text: 'El anillo no contestó a la primera; se intenta otra vez.' });
      }
    }
    throw lastError;
  }

  private async openOnce(log: DiagnosticLog): Promise<OpenedRing> {
    const { transport, store } = this.deps;
    const notes = (): void => {
      for (const note of transport.takeNotes?.() ?? []) log.info(`transporte: ${note}`);
    };
    const started = Date.now();
    let via: OpenedRing['via'] = 'reconnect';
    let link: RingLink | null = null;
    try {
      const saved = await store.getRing();
      link = saved ? await transport.reconnect(saved) : null;
      notes();
      if (!link && this.candidate && transport.connectTo) {
        via = 'connectTo';
        link = await transport.connectTo(this.candidate);
      }
      if (!link) {
        via = 'picker';
        this.setPrompt({ title: 'Elige tu anillo', text: 'Elígelo en la lista de Bluetooth (suele llamarse «R99…»).' });
        link = await transport.pickAndConnect({ showAll: true });
      }
    } finally {
      notes();
    }
    const connectMs = Date.now() - started;
    const session = new YcbtSession(link, {
      log,
      ...(this.deps.sessionTimeouts ? { timeouts: this.deps.sessionTimeouts } : {}),
      ...(this.deps.hrTiming ?? {}),
    });
    const handshakeStart = Date.now();
    try {
      await session.open(new Date(this.deps.now()));
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return { session, link, via, connectMs, handshakeMs: Date.now() - handshakeStart };
  }

  // ───────────────────────────── paso: sincronizar ─────────────────────────────

  private async stepSync(): Promise<Outcome> {
    if (!this.ringOk) return this.noRing();
    this.setPrompt({ title: 'Sincronizando…', text: 'Descargando pasos, sueño y pulso del anillo. No lo apartes del móvil.', live: 'Conectando…' });
    const { outcome, report, base } = await this.syncOnce('sync');
    this.syncLiveSteps = report?.liveSteps ?? null;
    return report ? { ...outcome, summary: `${base} · pasos hoy ${report.liveSteps ?? 'sin dato'}${report.warnings.length > 0 ? ` · ${report.warnings.length} aviso(s)` : ''}` } : outcome;
  }

  /**
   * Una sincronización completa, la misma que hace el botón de la app, con todo lo que interesa de ella. `base` es el resumen
   * sin los pasos de hoy (cada paso lo completa a su manera); `report` es `null` si no llegó a hacerse o falló.
   */
  private async syncOnce(traceName: 'sync' | 'resync'): Promise<{ outcome: Outcome; report: SyncReport | null; base: string }> {
    const { store } = this.deps;
    await this.settle();
    if (this.interrupted) return { outcome: this.skipped('Saltado antes de conectar.'), report: null, base: '' };
    const connection: string[] = [];
    try {
      const report = await runSync({
        transport: this.spyTransport(connection),
        store,
        now: this.deps.now,
        ...(this.deps.sessionTimeouts ? { timeouts: this.deps.sessionTimeouts } : {}),
        onProgress: (progress) => this.setLive(progress.message),
      });
      const added = report.added;
      const outcomes = report.outcomes.map((o) => `${o.type} ${o.status}`).join(', ');
      const base = `${fmtSeconds(report.durationMs)} · ${outcomes} · +${added.buckets} tramos, +${added.sleep} noches, +${added.heart} pulsos, +${added.spo2} oxígeno`;
      const summary = `${base} · pasos hoy ${report.liveSteps ?? 'sin dato'}${report.warnings.length > 0 ? ` · ${report.warnings.length} aviso(s)` : ''}`;
      const { log, ...rest } = report;
      return {
        outcome: {
          status: report.interrupted || report.warnings.length > 0 ? 'warn' : 'ok',
          summary,
          data: { ...rest, ringId: maskId(rest.ringId), connection, decoded: await this.decodedDays().catch((error: unknown) => [{ error: `No se pudieron decodificar los días: ${messageOf(error)}` }]) },
          traces: { [traceName]: log },
        },
        report,
        base,
      };
    } catch (error) {
      if (error instanceof SyncFailure) {
        return { outcome: { status: 'fail', summary: `La sincronización falló: ${error.message}`, data: { connection, error: describeError(error) }, traces: { [traceName]: error.log } }, report: null, base: '' };
      }
      throw error;
    }
  }

  /** Lo que la app ha entendido de los últimos tres días, para compararlo con lo que enseña Smart Health. */
  private async decodedDays(): Promise<Array<Record<string, unknown>>> {
    const { store } = this.deps;
    const nowMs = this.deps.now();
    const history = await store.getProfileHistory();
    const today = dayKeyOf(nowMs);
    const minutes = (seconds: number): number => Math.round(seconds / 60);
    const out: Array<Record<string, unknown>> = [];
    for (const day of [today, addDays(today, -1), addDays(today, -2)]) {
      const bundle = await loadDayBundle(day, nowMs, history, 0, store);
      const night = bundle.sleep?.night ?? null;
      out.push({
        day,
        steps: bundle.activity.steps,
        stepsSource: bundle.activity.stepsSource,
        ringDistanceM: bundle.activity.ringReportedDistanceM,
        lastDataAt: iso(bundle.activity.lastDataMs),
        hourlySteps: bundle.activity.hourlySteps,
        sleep: night && {
          start: iso(night.startMs),
          end: iso(night.endMs),
          asleepMin: minutes(night.asleepSec),
          inBedMin: minutes(night.inBedSec),
          deepMin: minutes(night.deepSec),
          lightMin: minutes(night.lightSec),
          remMin: minutes(night.remSec),
          awakeMin: minutes(night.awakeSec),
          hasStages: night.hasStages,
          sessions: night.sessions,
        },
        naps: (bundle.sleep?.naps ?? []).map((nap) => ({ start: iso(nap.startMs), end: iso(nap.endMs), minutes: minutes(nap.durationSec) })),
        heart: bundle.heart && { count: bundle.heart.count, min: bundle.heart.minBpm, max: bundle.heart.maxBpm, avg: bundle.heart.avgBpm, resting: bundle.heart.restingBpm, last: { at: iso(bundle.heart.last.tsMs), bpm: bundle.heart.last.bpm } },
        spo2: bundle.spo2 && { count: bundle.spo2.count, avg: bundle.spo2.avg, min: bundle.spo2.min },
      });
    }
    return out;
  }

  // ───────────────────────────── paso: pasos en directo ─────────────────────────────

  /** Espera a que se cumpla algo que debe mandar el anillo (no la persona: no se escala), o a saltar el paso. */
  private async until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (!condition()) {
      if (this.interrupted || Date.now() - started >= timeoutMs) return condition();
      await this.wait(20, false);
    }
    return true;
  }

  private async stepSteps(): Promise<Outcome> {
    if (!this.ringOk) return this.noRing();
    const go = await this.gate({
      title: 'Pasos: prepárate',
      text: `Guarda el móvil en el bolsillo o déjalo en una mesa: la mano del anillo tiene que ir libre, sin sujetar nada. Vas a caminar ${WALK_MS / 1000} segundos seguidos, a paso normal y moviendo los brazos. Vibrará al empezar y al terminar. Cuando estés listo, pulsa «Estoy listo».`,
    });
    if (!go) return this.skipped('Saltado por la persona.');

    const log = new DiagnosticLog();
    const samples: StepSample[] = [];
    const data: Record<string, unknown> = { walkSeconds: WALK_MS / 1000, minCountedSteps: MIN_COUNTED_STEPS };
    let opened: OpenedRing | null = null;
    let origin = 0;
    const phases = { walkStartMs: 0, walkEndMs: 0, rereadAtMs: 0 };
    let off: (() => void) | null = null;
    let offLost: (() => void) | null = null;
    let lostAtMs: number | null = null;
    /** Cuántos envíos había antes de la relectura final (−1: no se llegó a releer). */
    let split = -1;
    const statusWaitMs = this.deps.sessionTimeouts?.status ?? STATUS_WAIT_MS;
    try {
      opened = await this.openRing(log);
      Object.assign(data, { via: opened.via, connectMs: opened.connectMs, handshakeMs: opened.handshakeMs });
      const { session } = opened;
      origin = Date.now();
      // Si el anillo se va a mitad de la medida, el contador se queda quieto y parecería «no sube»: se apunta cuándo se fue.
      offLost = opened.link.onDisconnect(() => {
        if (lostAtMs !== null) return;
        lostAtMs = Date.now() - origin;
        log.warn(`El anillo se desconectó a los ${lostAtMs} ms`);
        this.log(`Pasos en directo: el anillo se desconectó a los ${fmtSeconds(lostAtMs)}`);
      });
      off = session.onLive((event) => {
        if (event.kind !== 'status') return;
        if (samples.length >= MAX_LIVE_EVENTS) return;
        samples.push({ t: Date.now() - origin, steps: event.status.steps, distanceM: event.status.distanceM, calories: event.status.calories });
        this.setLive(`${event.status.steps} pasos en el contador`);
      });
      await session.enableLiveStatus(true);
      data.enabledAfterMs = Date.now() - origin;

      // 1) El contador de partida: el primer envío del anillo (el R99 real tarda ~2,5 s en mandarlo).
      this.setPrompt({ title: 'Quieto un momento', text: 'Leo el contador de pasos del anillo.', live: 'Esperando el primer dato…' });
      await this.until(() => samples.length > 0, statusWaitMs);

      // 2) La marcha.
      phases.walkStartMs = Date.now() - origin;
      this.cue('go');
      this.setPrompt({
        title: `Camina ${WALK_MS / 1000} segundos`,
        text: 'A paso normal y sin parar, con los brazos sueltos y el móvil guardado. Vibrará cuando termine.',
        endsAtMs: this.endsIn(WALK_MS),
      });
      await this.wait(WALK_MS);

      phases.walkEndMs = Date.now() - origin;
      this.cue('attention');
      this.setPrompt({ title: 'Quieto otra vez', text: 'Vuelvo a leer el contador de pasos del anillo.', endsAtMs: this.endsIn(TAIL_MS) });
      await this.wait(TAIL_MS);

      // 3) La relectura: apagar y encender el empuje hace que el anillo mande el contador actual, lo hubiera avisado antes o no.
      // Así se distingue «no cuenta» de «cuenta pero no avisa».
      if (!this.interrupted && (lostAtMs as number | null) === null) {
        split = samples.length;
        phases.rereadAtMs = Date.now() - origin;
        try {
          await session.enableLiveStatus(false);
          await session.enableLiveStatus(true);
          await this.until(() => samples.length > split, statusWaitMs);
        } catch (error) {
          // La relectura es un extra: si no se puede (el anillo se fue ahora), se juzga con lo que fue avisando.
          log.warn(`No se pudo releer el contador: ${messageOf(error)}`);
          data.rereadError = messageOf(error);
        }
      }
      await session.enableLiveStatus(false).catch(() => undefined);
    } catch (error) {
      if (!this.interrupted) {
        return { status: 'fail', summary: `Falló a mitad: ${messageOf(error)}`, data: { ...data, phases, samples: samples.map(tuple), error: describeError(error) }, traces: { steps: log.toText({ maxFrames: SHARED_LOG_FRAMES }) } };
      }
    } finally {
      off?.();
      offLost?.(); // antes de cerrar: cerrar la sesión también «desconecta» y no es una pérdida
      await opened?.session.close().catch(() => undefined);
    }

    const lost = lostAtMs as number | null;
    const lostNote = lost !== null ? `; el anillo se desconectó a los ${fmtSeconds(lost)}` : '';
    const run = analyzeStepsRun(samples, split < 0 ? samples.length : split, { startMs: phases.walkStartMs, endMs: phases.walkEndMs });
    const { baseline, reread, counted, pushed, stream } = run;
    this.stepsCounted = baseline ? counted : null;
    Object.assign(data, {
      phases,
      analysis: stream,
      baseline,
      reread,
      counted,
      pushedWhileWalking: pushed,
      linkLostAtMs: lost,
      samples: samples.map(tuple),
      samplesFormat: '[ms, pasos, distanciaM, calorías]',
    });
    const traces = { steps: log.toText({ maxFrames: SHARED_LOG_FRAMES }) };
    if (this.interrupted) return { status: 'skipped', summary: 'Interrumpido.', data, traces };
    if (!baseline && !reread) return { status: 'fail', summary: `El anillo no mandó el contador de pasos en directo${lostNote}.`, data, traces };
    if (!baseline) {
      return { status: 'warn', summary: `El anillo no mandó el contador al activar el empuje; solo lo hizo al reactivarlo (${reread?.steps} pasos)${lostNote}.`, data, traces };
    }

    const seconds = WALK_MS / 1000;
    const finalSteps = Math.max(run.streamLast?.steps ?? 0, reread?.steps ?? 0);
    const range = `de ${baseline.steps} a ${finalSteps}`;
    const cadence = stream.gapsBetweenUpdates.medianMs !== null ? `, uno cada ${fmtSeconds(stream.gapsBetweenUpdates.medianMs)} (mediana)` : '';
    const latency = stream.firstChangeAfterWalkStartMs !== null ? `; el primer cambio llegó ${fmtSeconds(stream.firstChangeAfterWalkStartMs)} después de echar a andar` : '';
    if (counted >= MIN_COUNTED_STEPS) {
      if (pushed && lost === null) {
        return { status: 'ok', summary: `El contador subió ${counted} (${range}) en ${seconds} s de marcha; el anillo lo fue avisando solo: ${plural(stream.updates, 'envío', 'envíos')}${cadence}${latency}.`, data, traces };
      }
      const how = pushed ? '' : ', pero no lo avisó mientras andabas: solo lo dio al volver a pedirlo';
      return { status: 'warn', summary: `El contador subió ${counted} (${range}) en ${seconds} s de marcha${how}${lostNote}.`, data, traces };
    }
    if (counted > 0) {
      return { status: 'warn', summary: `El contador solo subió ${counted} (${range}) en ${seconds} s de marcha (se esperaban ${MIN_COUNTED_STEPS} o más)${lostNote}.`, data, traces };
    }
    return {
      status: 'warn',
      summary: `El contador no subió en ${seconds} s de marcha: ${plural(stream.updates, 'envío', 'envíos')} del anillo, siempre con ${baseline.steps}${reread ? ' y la relectura tampoco' : ''}. Si ibas con el móvil en la mano del anillo o caminaste poco, el anillo no detecta el paso${lostNote}.`,
      data,
      traces,
    };
  }

  // ───────────────────────────── paso: pulso ─────────────────────────────

  private async stepHeart(): Promise<Outcome> {
    if (!this.ringOk) return this.noRing();
    const log = new DiagnosticLog();
    const events: HeartEvent[] = [];
    const data: Record<string, unknown> = {};
    let opened: OpenedRing | null = null;
    let off: (() => void) | null = null;
    let bpm: number | null = null;
    let measureError: unknown = null;
    let origin = Date.now();
    try {
      opened = await this.openRing(log);
      Object.assign(data, { via: opened.via, connectMs: opened.connectMs, handshakeMs: opened.handshakeMs });
      const { session } = opened;
      this.setPrompt({
        title: 'Siéntate y no te muevas',
        text: 'Apoya la mano del anillo sobre la rodilla o la mesa. La medida empieza enseguida.',
        endsAtMs: this.endsIn(HEART_COUNTDOWN_MS),
      });
      await this.wait(HEART_COUNTDOWN_MS);
      if (this.interrupted) return this.skipped('Saltado por la persona.');

      origin = Date.now();
      off = session.onLive((event) => {
        if (events.length < MAX_LIVE_EVENTS) events.push(toHeartEvent(event, Date.now() - origin));
      });
      this.cue('go');
      this.setPrompt({ title: 'Midiendo el pulso', text: 'No te muevas ni hables. Dura unos 35 segundos.', live: 'Calentando el sensor…' });
      const stop = new AbortController();
      this.stepAbort.signal.addEventListener('abort', () => stop.abort(), { once: true });
      try {
        bpm = await session.measureHeartRate({ signal: stop.signal, onSample: (value) => this.setLive(`${value} lpm`) });
      } catch (error) {
        measureError = error;
      }
      data.measureMs = Date.now() - origin;
    } catch (error) {
      if (this.interrupted) return this.skipped('Interrumpido.', data);
      return { status: 'fail', summary: `No se pudo medir: ${messageOf(error)}`, data: { ...data, error: describeError(error) }, traces: { heart: log.toText({ maxFrames: SHARED_LOG_FRAMES }) } };
    } finally {
      off?.();
      await opened?.session.close().catch(() => undefined);
    }

    const analysis = analyzeHeartEvents(events);
    Object.assign(data, { bpm, analysis, events: events.map(eventTuple), eventsFormat: '[ms, tipo, valor]' });
    if (measureError) data.error = describeError(measureError);
    const traces = { heart: log.toText({ maxFrames: SHARED_LOG_FRAMES }) };
    if (this.interrupted) return { status: 'skipped', summary: 'Interrumpido.', data, traces };
    if (measureError) return { status: 'fail', summary: `La medida falló: ${messageOf(measureError)}`, data, traces };
    const plateau = analysis.plateau ? ` (antes hubo ${analysis.plateau.count} lecturas de ≈${analysis.plateau.bpm} lpm: una meseta del sensor en frío, no un pulso; la app la descarta)` : '';
    const timing = `${analysis.readings} lecturas${analysis.firstRealMs !== null ? `, la primera real a los ${fmtSeconds(analysis.firstRealMs)}` : ''}${plateau}${analysis.verdictMs !== null ? `, el anillo cerró la medida a los ${fmtSeconds(analysis.verdictMs)}` : ', el anillo no cerró la medida'}`;
    if (bpm === null) return { status: 'warn', summary: `Sin lectura de pulso: ${timing}`, data, traces };
    return { status: bpm >= 40 && bpm <= 200 ? 'ok' : 'warn', summary: `${bpm} lpm · ${timing}`, data, traces };
  }

  // ───────────────────────────── paso: entreno ─────────────────────────────

  private async stepWorkout(): Promise<Outcome> {
    if (!this.ringOk) return this.noRing();
    const go = await this.gate({
      title: 'Entreno: prepárate',
      text: 'Vas a caminar con normalidad unos 2 minutos, por casa o fuera. El móvil vibrará al empezar y al terminar. Cuando quieras empezar, pulsa «Estoy listo».',
    });
    if (!go) return this.skipped('Saltado por la persona.');

    const { store } = this.deps;
    const connection: string[] = [];
    const snapshots: Array<Record<string, unknown>> = [];
    let latest: LiveWorkoutState | null = null;
    let record: WorkoutRecord | null = null;
    let trace = '';
    const controller = new WorkoutController({
      transport: this.spyTransport(connection),
      // La prueba no deja borradores: si la app se cerrara a medias, no aparecería luego un «entreno recuperado» que no es real.
      store: { getRing: () => store.getRing(), setRing: (ring) => store.setRing(ring), setWorkoutDraft: async () => undefined },
      now: this.deps.now,
      platform: { geolocation: null, wakeLock: null },
      getProfile: this.deps.getProfile,
      onState: (state) => {
        // Al terminar o descartar el controlador avisa con `null`: se conserva el último estado real (avisos y funciones).
        if (state) latest = state;
      },
      onFinished: (finished) => {
        record = finished;
      },
      onDiagnostic: (text) => {
        trace = text;
      },
      ...(this.deps.sessionTimeouts ? { sessionTimeouts: this.deps.sessionTimeouts } : {}),
      ...(this.deps.hrTiming ?? {}),
    });

    const data: Record<string, unknown> = { connection };
    const origin = Date.now();
    // Saltar o cancelar suelta el anillo al momento, también si aún está conectando.
    // Un solo cierre, y todos esperan a él: el anillo no se da por suelto hasta que el cierre más temprano ha terminado.
    let closing: Promise<void> | null = null;
    const discard = (): Promise<void> => (closing ??= controller.discard().catch(() => undefined));
    const stop = (): void => void discard();
    this.stepAbort.signal.addEventListener('abort', stop, { once: true });
    try {
      this.setPrompt({ title: 'Conectando con el anillo…', text: 'Puede tardar unos segundos.' });
      await this.settle();
      if (this.interrupted) return this.skipped('Interrumpido.', data);
      await controller.start('walk', { gps: false });
      data.connectedAfterMs = Date.now() - origin;
      if (this.interrupted) {
        await discard();
        return this.skipped('Interrumpido.', data);
      }

      this.setPrompt({ title: 'Empieza en unos segundos', text: 'Prepárate para caminar con normalidad.', endsAtMs: this.endsIn(WORKOUT_COUNTDOWN_MS) });
      await this.wait(WORKOUT_COUNTDOWN_MS);

      const walkStart = Date.now();
      this.cue('go');
      this.setPrompt({ title: 'Camina con normalidad', text: 'Sin mirar el móvil si puedes. Vibrará cuando termine.', endsAtMs: this.endsIn(WORKOUT_MS) });
      let nextSnapshot = 0;
      while (!this.interrupted && Date.now() - walkStart < WORKOUT_MS * this.scale) {
        const state = latest as LiveWorkoutState | null;
        const snap = state?.snapshot ?? null;
        this.setLive(snap ? `${snap.bpm !== null ? `${snap.bpm} lpm` : 'pulso: —'} · ${snap.steps ?? 0} pasos` : 'Esperando datos del anillo…');
        if (Date.now() - walkStart >= nextSnapshot) {
          snapshots.push({
            t: Date.now() - walkStart,
            steps: snap?.steps ?? null,
            bpm: snap?.bpm ?? null,
            avgBpm: snap?.avgBpm ?? null,
            ringConnected: snap?.ringConnected ?? null,
            ringLost: state?.ringLost ?? null,
            warnings: state?.warnings.length ?? 0,
          });
          nextSnapshot += WORKOUT_SNAPSHOT_MS * this.scale;
        }
        await this.wait(1000);
      }
      this.cue('attention');
      this.setPrompt({ title: 'Terminado: ya puedes parar', text: 'Cerrando el entreno y soltando el anillo…' });
      data.walkedMs = Date.now() - walkStart;
      if (this.interrupted) await discard();
      else await controller.finish();
    } catch (error) {
      await discard();
      const state = latest as LiveWorkoutState | null;
      return { status: 'fail', summary: `El entreno falló: ${messageOf(error)}`, data: { ...data, snapshots, warnings: state?.warnings ?? [], error: describeError(error) }, traces: workoutTrace(trace) };
    } finally {
      this.stepAbort.signal.removeEventListener('abort', stop);
    }

    const state = latest as LiveWorkoutState | null;
    const finished = record as WorkoutRecord | null;
    this.workoutSteps = finished?.steps ?? null;
    const hr = finished?.hr ?? [];
    const bpms = hr.map(([, value]) => value);
    Object.assign(data, {
      features: state?.features ?? null,
      warnings: state?.warnings ?? [],
      snapshots,
      record: finished && {
        startedAt: iso(finished.startMs),
        endedAt: iso(finished.endMs),
        activeMs: finished.endMs - finished.startMs - finished.pausedMs,
        steps: finished.steps ?? null,
        hrSamples: hr.length,
        hrAvg: bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null,
        hrMin: bpms.length ? Math.min(...bpms) : null,
        hrMax: bpms.length ? Math.max(...bpms) : null,
        hr: hr.slice(0, 200).map(([t, value]) => [t - finished.startMs, value]),
        hrFormat: '[ms desde el inicio, lpm]',
      },
    });
    const traces = workoutTrace(trace);
    if (this.interrupted || !finished) return { status: 'skipped', summary: 'Interrumpido.', data, traces };
    const lost = (trace.match(/se perdió la conexión/g) ?? []).length;
    const summary = `${fmtSeconds(finished.endMs - finished.startMs)} · ${finished.steps ?? 'sin'} pasos · ${hr.length} lecturas de pulso${bpms.length ? ` (media ${Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length)})` : ''} · ${lost === 0 ? 'sin cortes de conexión' : `${lost} corte(s) de conexión`}`;
    const complete = hr.length >= 3 && (finished.steps ?? 0) > 0 && lost === 0;
    return { status: complete ? 'ok' : 'warn', summary, data, traces };
  }

  // ───────────────────────────── paso: sincronizar otra vez ─────────────────────────────

  /**
   * Otra sincronización tras caminar: el contador del día tiene que haber subido lo caminado y el historial puede traer ya
   * tramos nuevos. Así se ve si el contador es del día (como se supone) o se reinicia al conectar, y qué le muestra la app
   * a la persona justo después, para compararlo con Smart Health.
   */
  private async stepResync(): Promise<Outcome> {
    if (!this.ringOk) return this.noRing();
    this.setPrompt({ title: 'Sincronizando otra vez…', text: 'Compruebo que lo caminado suma en el contador del día y aparece en el historial. No apartes el anillo.', live: 'Conectando…' });
    const { outcome, report, base } = await this.syncOnce('resync');
    if (!report) return outcome;

    const before = this.syncLiveSteps;
    const after = report.liveSteps;
    const walked = (this.stepsCounted ?? 0) + (this.workoutSteps ?? 0);
    const gain = before !== null && after !== null ? after - before : null;
    const compare = { before, after, gain, walked, stepsCounted: this.stepsCounted, workoutSteps: this.workoutSteps };
    let status = outcome.status;
    let verdict: string;
    if (after === null) {
      verdict = 'el anillo no envió los pasos de hoy';
      status = 'warn';
    } else if (walked < MIN_WALKED_TO_COMPARE) {
      verdict = `pasos hoy ${before ?? 'sin dato'} → ${after} (sin marcha medida con la que comparar)`;
    } else if (gain !== null && gain >= walked * 0.6) {
      verdict = `pasos hoy ${before} → ${after}: suma lo caminado (≈ ${walked})`;
    } else {
      verdict = `pasos hoy ${before ?? 'sin dato'} → ${after}, pero se caminó ≈ ${walked}: el contador del día no lo refleja`;
      status = 'warn';
    }
    return {
      ...outcome,
      status,
      summary: `${verdict} · ${base}${report.warnings.length > 0 ? ` · ${report.warnings.length} aviso(s)` : ''}`,
      data: { ...outcome.data, compare },
    };
  }

  // ───────────────────────────── paso: comprobar que lo suelta ─────────────────────────────

  private async stepRelease(): Promise<Outcome> {
    const { transport } = this.deps;
    if (!transport.scan) return this.skipped('Este sistema no deja buscar sin el selector de Bluetooth.');
    if (!this.ringId) return this.noRing();
    this.setPrompt({ title: 'Comprobando que el anillo queda libre…', text: 'Ya puedes sentarte.' });
    await this.wait(RELEASE_PAUSE_MS);
    this.setPrompt({ title: 'Comprobando que el anillo queda libre…', text: 'Ya puedes sentarte.', endsAtMs: this.endsIn(RELEASE_SCAN_MS) });
    const entries = await transport.scan(RELEASE_SCAN_MS * this.scale);
    const seen = entries.find((entry) => entry.id === this.ringId) ?? null;
    // La comprobación directa: ¿hay alguna conexión abierta con el anillo (de esta app o de otra)? Mirar la publicidad solo lo infiere.
    const connected = transport.connectedDevices ? await transport.connectedDevices().catch(() => null) : null;
    const holding = connected?.some((device) => device.id === this.ringId) ?? false;
    const data = {
      devicesSeen: entries.length,
      ring: seen ? { rssi: seen.rssi, name: seen.name } : null,
      connectedDevices: connected ? connected.map((device) => ({ id: maskId(device.id), name: device.name })) : null,
    };
    if (holding) {
      return { status: 'fail', summary: 'El anillo sigue conectado a alguna app del móvil (la prueba ya lo había soltado): puede ser esta app o Smart Health.', data };
    }
    if (seen) return { status: 'ok', summary: `El anillo vuelve a verse (${seen.rssi ?? '?'} dBm): la app no lo deja conectado.`, data };
    return {
      status: 'warn',
      summary: 'El anillo no aparece al buscar tras terminar: puede que siga conectado a la app (gastaría batería) o que esté fuera de alcance.',
      data,
    };
  }
}

const workoutTrace = (text: string): Record<string, string> => (text ? { workout: text } : {});

const tuple = (sample: StepSample): number[] => [sample.t, sample.steps, sample.distanceM, sample.calories];

function eventTuple(event: HeartEvent): Array<number | string | boolean> {
  switch (event.kind) {
    case 'heartRate':
      return [event.t, 'pulso', event.bpm];
    case 'spo2':
      return [event.t, 'oxígeno', event.percent];
    case 'measurementEnd':
      return [event.t, 'fin de medida', event.success ? 'bien' : 'fallida'];
    case 'battery':
      return [event.t, 'batería', event.percent];
    case 'status':
      return [event.t, 'pasos', event.steps];
  }
}
