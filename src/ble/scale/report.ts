import { toHex } from '../bytes';
import type { LinkDetails } from '../transport';
import { describeDecoder, type LearnCandidate, type ScaleLabel } from '../../domain/scale-learn';
import type { ScaleDecoder, ScaleFrame } from '../../domain/scale';
import type { ScaleAdvert } from './transport';

// El informe de la báscula: todo lo que hace falta para entender su protocolo sin tenerla delante (lo que anuncia, su tabla GATT, las tramas que manda con distintos pesos y lo
// que se aprendió). Se guarda como un archivo de texto en Descargas desde «Dispositivos → Báscula de cocina» y se puede enviar tal cual: no lleva datos personales (solo la dirección
// Bluetooth de la báscula, que es un identificador del aparato).

export interface ScaleReportInput {
  appBuild: string;
  nowMs: number;
  device: { id: string; name: string | null } | null;
  advert: ScaleAdvert | null;
  details: LinkDetails | null;
  subscribed: readonly string[];
  frames: readonly ScaleFrame[];
  decoder: ScaleDecoder | null;
  candidates: readonly LearnCandidate[];
  labels: readonly ScaleLabel[];
  /** Mensajes del transporte y del estado de la plataforma (permisos, Bluetooth…). */
  notes: readonly string[];
  environment?: Record<string, unknown> | null;
  status?: string;
  /** El motivo si el aprendizaje no encontró nada. */
  problem?: string | null;
}

/** Cuántas tramas distintas se enseñan por cada fuente y longitud, y cuántas líneas como máximo en todo el informe. */
const MAX_DISTINCT = 40;
const MAX_LINES = 600;

const hex = (bytes: Uint8Array): string => toHex(bytes, ' ');

function groupFrames(frames: readonly ScaleFrame[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, ScaleFrame[]>();
  for (const frame of frames) {
    const key = `${frame.source} · ${frame.bytes.length} bytes`;
    const group = groups.get(key);
    if (group) group.push(frame);
    else groups.set(key, [frame]);
  }
  const start = frames[0]?.atMs ?? 0;
  for (const [key, group] of groups) {
    const counts = new Map<string, { first: number; n: number }>();
    for (const frame of group) {
      const text = hex(frame.bytes);
      const seen = counts.get(text);
      if (seen) seen.n++;
      else counts.set(text, { first: frame.atMs - start, n: 1 });
    }
    out.push('', `# ${key}: ${group.length} tramas, ${counts.size} distintas`);
    // En el orden en que aparecieron (se ve cómo cambia con el peso); si son muchas, las primeras y las últimas.
    const entries = [...counts.entries()];
    const shown = entries.length <= MAX_DISTINCT ? entries : [...entries.slice(0, MAX_DISTINCT / 2), ['…', { first: 0, n: 0 }] as const, ...entries.slice(-MAX_DISTINCT / 2)];
    for (const [text, info] of shown) out.push(text === '…' ? '  …' : `  +${String(info.first).padStart(6)} ms  ×${String(info.n).padEnd(4)} ${text}`);
  }
  return out;
}

export function buildScaleReport(input: ScaleReportInput): string {
  const lines: string[] = [];
  const add = (...rows: string[]): void => void lines.push(...rows);
  add('INFORME DE LA BÁSCULA · SmartHealth', `Compilación: ${input.appBuild}`, `Fecha: ${new Date(input.nowMs).toISOString()}`, `Estado: ${input.status ?? '—'}`);
  add('', '## Dispositivo', input.device ? `${input.device.name ?? '(sin nombre)'} · ${input.device.id}` : '(ninguno elegido)');
  if (input.advert) {
    const a = input.advert;
    add(`Señal: ${a.rssi ?? '—'} dBm`, `Servicios anunciados: ${a.services.join(', ') || '—'}`);
    for (const [company, data] of Object.entries(a.manufacturer)) add(`Datos de fabricante ${company}: ${data}`);
    for (const [uuid, data] of Object.entries(a.serviceData)) add(`Datos de servicio ${uuid}: ${data}`);
    if (a.raw) add(`Anuncio completo: ${a.raw}`);
  }
  add('', '## Tabla GATT');
  if (input.details) {
    add(`MTU: ${input.details.mtu ?? '—'} · señal: ${input.details.rssi ?? '—'} dBm`);
    for (const service of input.details.gatt) {
      add(service.service);
      for (const c of service.characteristics) add(`  ${c.uuid}  ${c.properties.join('+') || '—'}`);
    }
  } else {
    add('(sin conexión: no se pudo leer)');
  }
  add('', `Suscrito a: ${input.subscribed.join(', ') || '—'}`);
  add('', '## Lo aprendido');
  if (input.decoder) add(`Decodificador guardado: ${describeDecoder(input.decoder)}`, JSON.stringify(input.decoder));
  else add('Aún no hay decodificador.');
  if (input.labels.length > 0) add(`Lo que marcaba la pantalla: ${input.labels.map((l) => `${l.value} g (a los +${l.atMs - (input.frames[0]?.atMs ?? l.atMs)} ms)`).join(' · ')}`);
  if (input.candidates.length > 0) {
    add('Candidatos:');
    for (const candidate of input.candidates.slice(0, 5)) add(`  ${candidate.rank} · ${describeDecoder(candidate.decoder)}`);
  } else if (input.problem) {
    add(`Sin candidatos: ${input.problem}`);
  }
  if (input.notes.length > 0) add('', '## Notas', ...input.notes.map((n) => `- ${n}`));
  if (input.environment) add('', '## Entorno', JSON.stringify(input.environment));
  add('', `## Tramas recibidas (${input.frames.length})`, ...groupFrames(input.frames));
  const out = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) out.push(`… (${lines.length - MAX_LINES} líneas más recortadas)`);
  return `${out.join('\n')}\n`;
}
