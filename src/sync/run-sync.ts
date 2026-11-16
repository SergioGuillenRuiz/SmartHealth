import { HISTORY } from '../ble/constants';
import { RingError } from '../ble/errors';
import { emptyHistory } from '../ble/records';
import { DiagnosticLog, SHARED_LOG_FRAMES } from '../ble/diag';
import { withBaseline, type Capability } from '../ble/support';
import { YcbtSession, type LiveStatus, type Timeouts, type TypeOutcome } from '../ble/session';
import type { RingLink, RingTransport } from '../ble/transport';
import type { RowCounts, Store, SyncRecord } from '../data/types';
import { dayKeyOf } from '../domain/dates';
import { ageAt, GENERIC_PROFILE, profileAt } from '../domain/profile';
import { sanitizeHistory } from '../domain/sanitize';
import { isExpectedSilence } from './outcomes';
import { autoReconnectOptions } from './silent';

export type SyncStage = 'connecting' | 'handshake' | 'configuring' | 'steps' | 'history' | 'saving' | 'done';

/** Cuánto tardó cada parte de la sincronización (en el orden en que ocurrieron): para ver DÓNDE se va el tiempo con el anillo de verdad. `closing` es soltar la conexión, ya con todo guardado. */
export interface SyncPhase {
  stage: SyncStage | 'closing';
  ms: number;
}

export interface SyncProgress {
  stage: SyncStage;
  message: string;
  /** 0–1, para la barra de progreso. */
  fraction: number;
}

export interface SyncDeps {
  transport: RingTransport;
  store: Store;
  now?: () => number;
  onProgress?: (progress: SyncProgress) => void;
  timeouts?: Partial<Timeouts>;
}

export interface SyncReport {
  ringId: string;
  ringName: string;
  firmware: string | null;
  batteryPercent: number | null;
  durationMs: number;
  interrupted: boolean;
  added: RowCounts;
  updated: RowCounts;
  dropped: Record<string, number>;
  outcomes: TypeOutcome[];
  liveSteps: number | null;
  /** Funciones que declaró el anillo (`null`: no contestó). */
  capabilities: string[] | null;
  /** Cosas que el usuario debería saber (un tipo no leído, conexión cortada…). */
  warnings: string[];
  /** Traza BLE en texto, para diagnóstico. */
  log: string;
  /** Cuánto tardó cada parte (conexión, saludo, ajuste, pasos, historial, guardado y soltar la conexión). */
  phases: SyncPhase[];
}

/** Fallo durante la sincronización con la traza BLE adjunta para poder diagnosticarlo. */
export class SyncFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly log: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SyncFailure';
  }
}

const zeroCounts = (): RowCounts => ({ buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 });

export interface SyncOptions {
  forcePick?: boolean;
  showAll?: boolean;
  /**
   * Sin selector ni diálogos del sistema: es la sincronización automática. Si el anillo no está a mano, falla (con
   * `connect-failed`) en lugar de abrir la lista de dispositivos.
   */
  silent?: boolean;
  /** Cancela la sincronización: suelta el enlace y termina con `aborted`, sin anotar un error ni guardar nada a medias. */
  signal?: AbortSignal;
  /**
   * Solo en la silenciosa: el contador de pasos ya está guardado (se guarda en cuanto se lee, sin esperar al historial) y la
   * pantalla puede ponerse al día. Si la app se oculta antes de que acabe el historial, la sincronización se corta, pero los pasos
   * ya están.
   */
  onLiveSaved?: () => void;
}

const cancelled = (cause?: unknown): RingError => new RingError('Sincronización cancelada.', 'aborted', cause === undefined ? undefined : { cause });


/**
 * Conectar → leer → guardar → DESCONECTAR. La conexión se suelta siempre al terminar (también si algo
 * falla): el anillo no debe quedarse enlazado ni gastando batería cuando ya no hace falta.
 *
 * En web `pickAndConnect` exige un gesto del usuario, así que lo primero que hace esta función es abrir
 * la conexión; solo se consulta el almacén lo imprescindible antes.
 */
export async function runSync(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncReport> {
  const { transport, store } = deps;
  const { signal } = options;
  const now = deps.now ?? Date.now;
  const started = now();
  // Cada cambio de etapa cierra la anterior con lo que duró: así el informe dice dónde se fue el tiempo (la conexión, la espera de los pasos, el historial…).
  const phases: SyncPhase[] = [];
  let phaseStage: SyncStage = 'connecting';
  let phaseSince = started;
  const progress = (stage: SyncStage, message: string, fraction: number): void => {
    if (stage !== phaseStage) {
      phases.push({ stage: phaseStage, ms: Math.max(0, now() - phaseSince) });
      phaseStage = stage;
      phaseSince = now();
    }
    deps.onProgress?.({ stage, message, fraction });
  };
  let finished: SyncReport | null = null;

  progress('connecting', 'Buscando el anillo…', 0.04);
  // `showAll`: el selector enseña TODOS los dispositivos Bluetooth, por si el anillo anuncia un nombre inesperado.
  const saved = options.forcePick || options.showAll ? null : await store.getRing();
  let link: RingLink | null = null;
  if (saved) {
    link = await transport.reconnect(saved, options.silent ? autoReconnectOptions(signal) : undefined);
  }
  if (!link && options.silent) {
    // La automática nunca abre el selector del sistema: sin el anillo a mano, se queda como está y se reintenta más tarde.
    if (signal?.aborted) throw cancelled();
    throw new RingError(saved ? 'No se encontró el anillo: ¿está cerca y con Smart Health cerrada?' : 'No hay ningún anillo vinculado.', 'connect-failed');
  }
  link ??= await transport.pickAndConnect(options.showAll ? { showAll: true } : {});
  if (signal?.aborted) {
    await link.disconnect().catch(() => undefined);
    throw cancelled();
  }

  const log = new DiagnosticLog();
  // Lo que anotó el transporte al conectar (intentos fallidos con su duración y lo que tardó cada paso del enlace): sin esto la traza no decía dónde se iba el tiempo de la conexión.
  for (const note of transport.takeNotes?.() ?? []) log.info(`transporte: ${note}`);
  const session = new YcbtSession(link, { log, ...(deps.timeouts ? { timeouts: deps.timeouts } : {}) });
  let live: LiveStatus | null = null;
  // Cancelar suelta el enlace al instante, también en mitad de una lectura: lo que esperaba falla y sube hasta el `catch`.
  const onAbort = (): void => void session.close().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    progress('handshake', 'Conectado. Hablando con el anillo…', 0.12);
    const info = await session.open(new Date(now()));
    // La automática no toca el anillo vinculado (ya lo está, y si se acaba de olvidar no debe reaparecer).
    if (!options.silent) await store.setRing({ id: link.id, name: link.name });

    progress('configuring', 'Ajustando el reloj y tu perfil…', 0.22);
    const today = dayKeyOf(now());
    const [history, settings] = await Promise.all([store.getProfileHistory(), store.getSettings()]);
    const profile = profileAt(history, today) ?? { ...GENERIC_PROFILE, date: today, extrapolated: false };
    await session.configure({
      user: { heightCm: profile.heightCm, weightKg: profile.weightKg, male: profile.sex === 'male', age: ageAt(profile.birthDate, today) },
      heartIntervalMin: settings.heartIntervalMin,
      spo2IntervalMin: settings.spo2IntervalMin,
    });

    progress('steps', 'Leyendo los pasos de hoy…', 0.3);
    // El contador se guarda con la hora en que se PIDIÓ, no con la de después de esperar la respuesta (y la orden de apagar el
    // empuje, hasta 1,5 s más): a las 23:59:59 un contador de ayer no puede sellarse como de las 00:00:00 de hoy (ver `sanitizeHistory`).
    let liveAtMs = now();
    live = await session.readLiveStatus(deps.timeouts?.reply);
    // A la vista, lo primero que se quiere ver son los pasos, y el historial tarda 10–15 s más (un vistazo corto a la app lo
    // cortaría sin haber guardado nada): el contador se guarda ya, como en la lectura ligera. Es idempotente, la guardada final
    // lo vuelve a incluir con el mismo sello.
    if (options.silent && live !== null && !signal?.aborted) {
      await store.ingest(sanitizeHistory(emptyHistory(), now(), live, liveAtMs));
      options.onLiveSaved?.();
    }

    const result = await session.syncHistory(typesFor(info.capabilities), (p) => {
      if (p.starting) progress('history', `Leyendo ${p.type.label}…`, 0.3 + 0.6 * (p.index / p.total));
    });

    // Cancelada mientras leía (se pidió el anillo para otra cosa, o la app pasó a segundo plano): lo leído hasta aquí no se guarda
    // ni se anota como un intento incompleto —no lo ha sido por el anillo—; el anillo lo conserva y entra en la siguiente.
    if (signal?.aborted) throw cancelled();

    // Algunos firmwares aceptan el empuje de pasos al arrancar pero no publican el acumulado hasta que la
    // conexión se asienta: si la primera lectura no llegó, se pide una vez más tras recorrer el historial.
    if (live === null && !result.interrupted) {
      liveAtMs = now();
      live = await session.readLiveStatus(deps.timeouts?.reply).catch(() => null);
    }

    progress('saving', 'Guardando los datos…', 0.93);
    const rows = sanitizeHistory(result.records, now(), live, liveAtMs);
    // Lo último que puede cortarse: pasado este punto se guarda (idempotente) y la sincronización se da por hecha.
    if (signal?.aborted) throw cancelled();
    const { added, updated } = await store.ingest(rows);

    const capabilities = effectiveCapabilities(info.capabilities, result.outcomes);

    // La traza lleva también cuánto tardó cada parte hasta aquí (lo que falta, soltar la conexión, se añade al informe después).
    log.info(`fases: ${phases.map((p) => `${p.stage} ${(p.ms / 1000).toFixed(1)} s`).join(' · ')}`);
    const report: SyncReport = {
      ringId: link.id,
      ringName: link.name,
      firmware: info.firmware,
      batteryPercent: info.batteryPercent,
      durationMs: now() - started,
      interrupted: result.interrupted,
      added,
      updated,
      dropped: rows.dropped,
      outcomes: result.outcomes,
      liveSteps: live?.steps ?? null,
      capabilities,
      warnings: warningsFor(result.outcomes, result.interrupted, live),
      log: log.toText({ maxFrames: SHARED_LOG_FRAMES }),
      phases,
    };
    finished = report;
    const record = toRecord(report, now());
    // Las automáticas que salen bien no guardan su traza BLE (hasta 400 tramas de texto): se hacen cada diez minutos con la app a la
    // vista y nadie las mira. La de una que se corta o falla sí se guarda, como la de una a mano; el almacén conserva solo las más
    // recientes (por posición, así que las de una a mano también se aligeran con el tiempo).
    if (options.silent && !report.interrupted) delete record.log;
    await store.addSync(record);
    progress('done', 'Sincronizado', 1);
    return report;
  } catch (error) {
    // Una sincronización cancelada (la persona pidió el anillo para otra cosa, o la app pasó a segundo plano) no es un fallo del
    // anillo: no se anota. Lo que no llegó a guardarse sigue en el anillo y entra en la siguiente.
    if (signal?.aborted) throw cancelled(error);
    const text = log.toText({ maxFrames: SHARED_LOG_FRAMES });
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RingError ? error.code : 'unknown';
    await store
      .addSync({
        tsMs: now(),
        ringName: link.name,
        firmware: session.info.firmware,
        batteryPercent: session.info.batteryPercent,
        durationMs: now() - started,
        interrupted: false,
        error: message,
        outcomes: [],
        added: zeroCounts(),
        dropped: {},
        liveSteps: null,
        capabilities: capabilityList(session.info.capabilities),
        log: text,
      })
      .catch(() => undefined);
    throw new SyncFailure(message, code, text, { cause: error });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Siempre se suelta la conexión: ni un fallo ni un éxito dejan el anillo enlazado.
    const closingFrom = now();
    await session.close().catch(() => undefined);
    // Soltar la conexión también es tiempo de espera para quien mira la pantalla: se anota (el informe ya se hizo, y se completa).
    if (finished !== null) finished.phases.push({ stage: 'closing', ms: Math.max(0, now() - closingFrom) });
  }
}

/** Solo se pide lo que el anillo declara tener; sin bitmap (no contestó) se pide todo lo que usamos. */
function typesFor(capabilities: Set<string> | null) {
  const wants = (cap: string): boolean => capabilities === null || capabilities.has(cap);
  const all = HISTORY_BY_CAPABILITY.filter(([cap]) => cap === null || wants(cap)).map(([, type]) => type);
  return all;
}

const HISTORY_BY_CAPABILITY = [
  ['steps', HISTORY.sport],
  ['sleep', HISTORY.sleep],
  ['heartRate', HISTORY.heart],
  // El registro de constantes es la copia de seguridad de varias métricas y ningún bit lo nombra.
  [null, HISTORY.all],
  ['spo2', HISTORY.spo2],
] as const;

function warningsFor(outcomes: readonly TypeOutcome[], interrupted: boolean, live: LiveStatus | null): string[] {
  const warnings: string[] = [];
  if (interrupted) warnings.push('Se perdió la conexión antes de terminar: faltan datos. Vuelve a sincronizar.');
  for (const o of outcomes) {
    if (isExpectedSilence(o, outcomes)) continue; // el oxígeno que algunos anillos nunca contestan: sus lecturas ya vienen en las constantes
    if (o.status === 'timeout') warnings.push(`El anillo dejó de responder al leer ${labelOf(o.type)}.`);
    if (o.status === 'corrupt') warnings.push(`Los datos de ${labelOf(o.type)} llegaron dañados y se descartaron.`);
    if (o.status === 'error') warnings.push(`No se pudo leer ${labelOf(o.type)}${o.detail ? ` (${o.detail})` : ''}.`);
  }
  if (live === null && !interrupted) warnings.push('El anillo no envió los pasos de hoy en directo; se usarán los del historial.');
  return warnings;
}

function labelOf(type: string): string {
  return Object.values(HISTORY).find((t) => t.id === type)?.label ?? type;
}

function toRecord(report: SyncReport, tsMs: number): SyncRecord {
  return {
    tsMs,
    ringName: report.ringName,
    firmware: report.firmware,
    batteryPercent: report.batteryPercent,
    durationMs: report.durationMs,
    interrupted: report.interrupted,
    outcomes: report.outcomes.map((o) => ({ type: o.type, status: o.status, bytes: o.bytes, ms: o.ms, ...(o.detail !== undefined ? { detail: o.detail } : {}) })),
    added: report.added,
    dropped: report.dropped,
    liveSteps: report.liveSteps,
    capabilities: report.capabilities,
    log: report.log,
  };
}

const capabilityList = (capabilities: ReadonlySet<string> | null): string[] | null => (capabilities ? [...capabilities].sort() : null);

/** Qué función deja de ofrecer el anillo cuando contesta 0xFB/0xFC a la consulta de este tipo de historial. */
const CAPABILITY_OF_HISTORY: Partial<Record<TypeOutcome['type'], Capability>> = { sport: 'steps', sleep: 'sleep', heart: 'heartRate', spo2: 'spo2' };

/**
 * Lo que el anillo realmente ofrece tras la sincronización: lo que declara más las funciones básicas de la familia,
 * menos lo que ha rechazado al pedírselo. Es lo que decide qué deportes y datos se ofrecen.
 */
function effectiveCapabilities(declared: ReadonlySet<Capability> | null, outcomes: readonly TypeOutcome[]): string[] {
  const set = new Set<Capability>(declared ?? withBaseline());
  for (const outcome of outcomes) {
    const capability = CAPABILITY_OF_HISTORY[outcome.type];
    if (outcome.status === 'unsupported' && capability) set.delete(capability);
  }
  return capabilityList(set) ?? [];
}
