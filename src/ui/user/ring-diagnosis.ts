import type { LatestData } from '../../data/types';
import { isExpectedSilence, type OutcomeLike } from '../../sync/outcomes';
import { fmtAgo, NBSP } from '../format';

/** Lo que el diagnóstico necesita saber de una sincronización (un `SyncRecord` lo cumple). */
export interface DiagnosisSync {
  tsMs: number;
  batteryPercent: number | null;
  interrupted: boolean;
  error?: string;
  outcomes: readonly OutcomeLike[];
}

export interface DiagnosisInput {
  nowMs: number;
  /** Hay un anillo vinculado. */
  linked: boolean;
  /** La última sincronización completa (sin error ni cortes). */
  lastSync: DiagnosisSync | null;
  /** El último intento, saliera bien o no. */
  lastAttempt: DiagnosisSync | null;
  latest: LatestData;
  /** Funciones que declaró el anillo (`null`: aún no se sabe). */
  capabilities: ReadonlySet<string> | null;
  /** Cuándo es el dato más antiguo que hay guardado (`null`: ninguno). Da los días que lleva la app con el anillo. */
  firstDataMs?: number | null;
}

export interface DiagnosisFinding {
  tone: 'warn' | 'bad';
  text: string;
}

export interface Diagnosis {
  tone: 'ok' | 'warn' | 'bad';
  /** Lo primero que se lee: «Todo en orden», «Hay algo que revisar»… */
  headline: string;
  /** Lo que se ha visto, lo más grave primero (vacío si todo está bien). */
  findings: DiagnosisFinding[];
  /** Qué hacer para arreglarlo si pasa por la hoja del anillo; `null`: nada que hacer ahí. */
  action: 'link' | 'sync' | null;
  /** La batería que se conoce: la del intento o la sincronización más reciente que la leyó. */
  battery: { percent: number; tsMs: number } | null;
}

/**
 * Umbrales orientativos. Una sincronización de hace más de seis horas ya es un aviso —es lo mismo que pinta de naranja el punto
 * del botón del anillo, y lo de hoy puede estar incompleto—; a los tres días, grave (el anillo solo guarda unos días de datos, y
 * lo más antiguo se pierde si no se trae). Con el anillo puesto, el pulso se mide solo cada media hora o cada hora: si la última
 * lectura que había al sincronizar ya tenía más de seis horas, el anillo no estaba midiendo.
 */
export const STALE_SYNC_HOURS = 6;
export const VERY_STALE_SYNC_DAYS = 3;
export const LOW_BATTERY_PERCENT = 20;
export const VERY_LOW_BATTERY_PERCENT = 10;
export const NO_HEART_HOURS = 6;
/** Con el anillo midiendo, sin ninguna noche guardada tras tantos días de uso —o con la última de hace más de esto— no está dando el sueño. */
export const NO_SLEEP_DAYS = 3;

const HOUR_MS = 3_600_000;
const MAX_ERROR_CHARS = 160;
const FAILED_STATUSES: readonly string[] = ['timeout', 'error', 'corrupt'];
/** Cómo se llama cada tipo de dato del anillo para la persona. */
const TYPE_LABEL: Readonly<Record<string, string>> = { sport: 'actividad', sleep: 'sueño', heart: 'pulso', all: 'pasos', spo2: 'oxígeno' };

/** «a», «a y b», «a, b y c». */
const joinList = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`);

/** El mensaje de un fallo, sin el punto final (la frase lo pone) y sin pasarse de largo. */
const shortError = (message: string): string => {
  const text = message.trim().replace(/\.+$/, '');
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
};

export function diagnoseRing(input: DiagnosisInput): Diagnosis {
  const { nowMs, linked, lastSync, lastAttempt, latest, capabilities } = input;
  if (!linked) return { tone: 'bad', headline: 'Sin anillo vinculado', findings: [], action: 'link', battery: null };

  const findings: DiagnosisFinding[] = [];
  let needsSync = false;

  // Un intento posterior a la última sincronización completa es que no acabó bien.
  if (lastAttempt && lastAttempt.tsMs > (lastSync?.tsMs ?? -Infinity)) {
    const ago = fmtAgo(lastAttempt.tsMs, nowMs);
    findings.push({ tone: 'warn', text: lastAttempt.error ? `El último intento, ${ago}, falló: ${shortError(lastAttempt.error)}.` : `El último intento, ${ago}, quedó incompleto.` });
    needsSync = true;
  }

  if (!lastSync) {
    findings.push({ tone: 'warn', text: 'Todavía no se ha completado ninguna sincronización.' });
    needsSync = true;
  } else {
    const age = nowMs - lastSync.tsMs;
    const ago = fmtAgo(lastSync.tsMs, nowMs);
    if (age >= VERY_STALE_SYNC_DAYS * 24 * HOUR_MS) {
      findings.push({ tone: 'bad', text: `La última sincronización fue ${ago}: el anillo solo guarda unos días de datos.` });
      needsSync = true;
    } else if (age >= STALE_SYNC_HOURS * HOUR_MS) {
      findings.push({ tone: 'warn', text: `La última sincronización fue ${ago}: lo de hoy puede estar incompleto.` });
      needsSync = true;
    }
  }

  const battery = [lastAttempt, lastSync]
    .filter((s): s is DiagnosisSync => s !== null && s.batteryPercent !== null)
    .sort((a, b) => b.tsMs - a.tsMs)
    .map((s) => ({ percent: s.batteryPercent as number, tsMs: s.tsMs }))[0] ?? null;
  if (battery && battery.percent <= LOW_BATTERY_PERCENT) {
    const reading = `${battery.percent}${NBSP}% (${fmtAgo(battery.tsMs, nowMs)})`;
    findings.push(battery.percent <= VERY_LOW_BATTERY_PERCENT ? { tone: 'bad', text: `Batería muy baja: ${reading}. Ponlo a cargar.` } : { tone: 'warn', text: `Batería baja: ${reading}.` });
  }

  // Lo que el anillo no pudo dar en el último intento (si el intento entero falló, ya se ha dicho).
  if (lastAttempt && !lastAttempt.error && !lastAttempt.interrupted) {
    const unread = lastAttempt.outcomes.filter((o) => FAILED_STATUSES.includes(o.status) && !isExpectedSilence(o, lastAttempt.outcomes)).map((o) => TYPE_LABEL[o.type] ?? o.type);
    if (unread.length > 0) {
      findings.push({ tone: 'warn', text: `No se pudo leer: ${joinList(unread)}.` });
      needsSync = true;
    }
  }

  // ¿Mide? Solo se mira con una sincronización reciente: si hace días que no se trae nada, lo que falta es eso.
  const heartExpected = capabilities === null || capabilities.has('heartRate');
  if (heartExpected && lastSync && nowMs - lastSync.tsMs < STALE_SYNC_HOURS * HOUR_MS) {
    if (latest.heartMs === null) findings.push({ tone: 'warn', text: 'Todavía no hay lecturas de pulso: ¿llevas el anillo puesto?' });
    else if (lastSync.tsMs - latest.heartMs > NO_HEART_HOURS * HOUR_MS) findings.push({ tone: 'warn', text: `La última lectura de pulso fue ${fmtAgo(latest.heartMs, nowMs)}: ¿llevas el anillo puesto?` });
  }

  // ¿Guarda sueño? Solo con el anillo midiendo (pulso de las últimas 24 h): si mide y no hay noches, no es que falten datos que
  // traer, es que el anillo no los da (no se lleva al dormir, queda flojo en el dedo, o otra app se lleva sus datos antes).
  const sleepExpected = capabilities === null || capabilities.has('sleep');
  if (sleepExpected && lastSync && latest.heartMs !== null && nowMs - latest.heartMs < 24 * HOUR_MS) {
    const hint = 'el anillo lo registra al dormir con él puesto y bien ajustado (quizá solo en su franja nocturna); mientras, la app estima la noche con el pulso y los pasos';
    if (latest.sleepEndMs === null) {
      const days = input.firstDataMs == null ? 0 : Math.floor((nowMs - input.firstDataMs) / (24 * HOUR_MS));
      if (days >= NO_SLEEP_DAYS) findings.push({ tone: 'warn', text: `No hay ninguna noche de sueño guardada tras ${days} días de uso: ${hint}.` });
    } else if (nowMs - latest.sleepEndMs >= NO_SLEEP_DAYS * 24 * HOUR_MS) {
      findings.push({ tone: 'warn', text: `La última noche de sueño guardada fue ${fmtAgo(latest.sleepEndMs, nowMs)}: ${hint}.` });
    }
  }

  findings.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));
  const tone = findings.some((f) => f.tone === 'bad') ? 'bad' : findings.length > 0 ? 'warn' : 'ok';
  return { tone, headline: tone === 'ok' ? 'Todo en orden' : tone === 'warn' ? 'Hay algo que revisar' : 'Necesita atención', findings, action: needsSync ? 'sync' : null, battery };
}
