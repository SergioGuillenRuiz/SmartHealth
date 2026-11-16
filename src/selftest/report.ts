import { androidVersion, fmtSeconds } from './analysis';

// El informe de la prueba guiada: un texto que se guarda en Descargas y se manda para depurar sin tener el anillo delante.
// Va en texto y no en JSON puro porque las trazas Bluetooth (cientos de líneas) se leen mal con las comillas y los saltos de
// línea escapados; los datos estructurados van en un bloque JSON aparte, con las listas de números en una sola línea.

export type StepId = 'env' | 'scan' | 'connect' | 'sync' | 'steps' | 'heart' | 'workout' | 'resync' | 'release';
export type StepStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface StepRecord {
  id: StepId;
  title: string;
  status: StepStatus;
  /** Instante de inicio, en ms desde el inicio de la prueba. */
  startMs: number;
  durationMs: number;
  /** Una línea con lo esencial: la que sale en el resumen. */
  summary: string;
  data?: Record<string, unknown>;
}

export interface TimelineEntry {
  /** ms desde el inicio de la prueba. */
  t: number;
  text: string;
}

export interface SelfTestReport {
  /** Versión del formato del informe. */
  version: 1;
  app: { build: string; builtAt: string; native: boolean; demo: boolean; transport: string };
  /** Cuándo empezó (ISO, y como lo ve el móvil con su zona horaria). */
  startedAtIso: string;
  startedAtLocal: string;
  finishedAtIso: string | null;
  /** Se llegó al final sin cancelar. */
  complete: boolean;
  cancelled: boolean;
  phone: Record<string, unknown>;
  steps: StepRecord[];
  timeline: TimelineEntry[];
  /** Trazas Bluetooth y de depuración, por nombre. */
  traces: Record<string, string>;
}

const STATUS_LABEL: Record<StepStatus, string> = { ok: 'OK', warn: 'AVISO', fail: 'FALLO', skipped: 'SALTADO' };

export const countStatuses = (steps: readonly StepRecord[]): Record<StepStatus, number> => {
  const counts: Record<StepStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const step of steps) counts[step.status]++;
  return counts;
};

const two = (n: number): string => String(n).padStart(2, '0');

/** `SmartHealth-prueba-20261012-2315.txt` (hora local del móvil). */
export function reportFilename(date: Date): string {
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  return `SmartHealth-prueba-${day}-${two(date.getHours())}${two(date.getMinutes())}.txt`;
}

/** `m:ss.d` desde el inicio: la cronología se lee de arriba abajo. */
const fmtClock = (ms: number): string => {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${two(seconds)}.${tenths}`;
};

/**
 * JSON legible: objetos con sangría, pero las listas de números, textos o listas cortas de números en una sola línea (con
 * `JSON.stringify(x, null, 2)` cada número de una serie ocuparía una línea).
 */
export function stringify(value: unknown, indent = ''): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const flat = value.every((item) => item === null || typeof item !== 'object' || (Array.isArray(item) && item.every((x) => x === null || typeof x !== 'object')));
    if (flat) {
      const line = `[${value.map((item) => stringify(item)).join(', ')}]`;
      if (line.length <= 110) return line;
    }
    return `[\n${value.map((item) => `${inner}${stringify(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${stringify(v, inner)}`).join(',\n')}\n${indent}}`;
}

/** El resumen: una línea por paso. Es lo primero del informe y lo que se puede copiar para pegarlo en un mensaje. */
export function renderSummary(report: SelfTestReport): string {
  const lines = report.steps.map((step) => `[${STATUS_LABEL[step.status].padEnd(7)}] ${step.title}: ${step.summary}`);
  const counts = countStatuses(report.steps);
  // «Completa» es que llegó al final sin fallos; llegar al final con fallos es otra cosa.
  const verdict = report.cancelled ? 'CANCELADA' : report.complete ? (counts.fail === 0 ? 'completa' : 'terminada CON FALLOS') : 'INCOMPLETA';
  return [
    `Prueba ${verdict}: ${counts.ok} bien, ${counts.warn} con aviso, ${counts.fail} con fallo, ${counts.skipped} saltados.`,
    ...lines,
  ].join('\n');
}

export function renderReport(report: SelfTestReport): string {
  const total = report.steps.reduce((end, step) => Math.max(end, step.startMs + step.durationMs), 0);
  const phone = report.phone as { device?: { model?: string; manufacturer?: string; osVersion?: string; androidSDKVersion?: number; webViewVersion?: string } };
  const device = phone.device;
  const head = [
    'SmartHealth · informe de la prueba guiada',
    '======================================',
    `Formato ${report.version} · app ${report.app.build} (compilada ${report.app.builtAt}) · ${report.app.native ? 'Android nativo' : 'navegador'}${report.app.demo ? ' · MODO DEMOSTRACIÓN' : ''} · transporte ${report.app.transport}`,
    `Inicio: ${report.startedAtLocal} (${report.startedAtIso}) · duración: ${fmtSeconds(total)}`,
    device ? `Móvil: ${[device.manufacturer, device.model].filter(Boolean).join(' ')} · Android ${androidVersion(device.osVersion)} (SDK ${device.androidSDKVersion ?? '?'}) · WebView ${device.webViewVersion ?? '?'}` : 'Móvil: sin datos',
  ];
  const data = { app: report.app, phone: report.phone, steps: report.steps.map((step) => ({ id: step.id, status: step.status, startMs: step.startMs, durationMs: step.durationMs, summary: step.summary, data: step.data })) };
  const timeline = report.timeline.map((entry) => `${fmtClock(entry.t).padStart(8)}  ${entry.text}`);
  const traces = Object.entries(report.traces).map(([name, text]) => `===== TRAZA «${name}» (${text.split('\n').length} líneas) =====\n${text.trimEnd()}`);
  return [
    head.join('\n'),
    '',
    'RESUMEN',
    '-------',
    renderSummary(report),
    '',
    'DATOS ESTRUCTURADOS (JSON)',
    '--------------------------',
    stringify(data),
    '',
    'CRONOLOGÍA',
    '----------',
    timeline.join('\n'),
    '',
    ...(traces.length > 0 ? [traces.join('\n\n'), ''] : []),
    '===== FIN DEL INFORME =====',
    '',
  ].join('\n');
}
