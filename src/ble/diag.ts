import { toHex } from './bytes';

export type DiagDirection = 'tx' | 'rx' | 'info' | 'warn';

/**
 * Tramas que se conservan en el texto de una traza (las primeras y las últimas): lo demás es repetitivo y los datos en bruto
 * de cada tipo van aparte, fijados al final. Así el texto guardado o enviado no ocupa cientos de kB.
 */
export const SHARED_LOG_FRAMES = 400;

export interface DiagEntry {
  /** Milisegundos desde el inicio de la sesión. */
  t: number;
  dir: DiagDirection;
  /** Trama en hexadecimal (si aplica). */
  hex?: string;
  note?: string;
}

/**
 * Registro acotado de lo que ocurre en una sesión BLE. Es la herramienta para diagnosticar un anillo
 * real sin tener el anillo delante: el usuario lo exporta y se puede reproducir el problema byte a byte.
 */
export class DiagnosticLog {
  private entries: DiagEntry[] = [];
  private pinned: string[] = [];
  private readonly startedAt = Date.now();
  constructor(private readonly capacity = 3000) {}

  add(dir: DiagDirection, note?: string, bytes?: ArrayLike<number>): void {
    const entry: DiagEntry = { t: Date.now() - this.startedAt, dir };
    if (note !== undefined) entry.note = note;
    if (bytes) entry.hex = toHex(bytes, ' ');
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  info(note: string): void {
    this.add('info', note);
  }

  warn(note: string): void {
    this.add('warn', note);
  }

  /**
   * Fija un bloque de texto que sale al final de la traza y NO se descarta por el límite de entradas: los datos en bruto
   * (p. ej. el buffer de sueño) con los que se puede decodificar un formato sin tener el anillo delante.
   */
  pin(title: string, lines: readonly string[]): void {
    this.pinned.push(`${title}\n${lines.join('\n')}`);
  }

  snapshot(): DiagEntry[] {
    return this.entries.slice();
  }

  /**
   * La traza en texto. Con `maxFrames`, las tramas (tx/rx) por encima de ese número se resumen —se conservan las primeras
   * y las últimas— para que un texto que se copia y se manda no ocupe cientos de kB; las notas y avisos se conservan
   * siempre, y los datos en bruto fijados van al final.
   */
  toText(options: { maxFrames?: number } = {}): string {
    const isFrame = (e: DiagEntry): boolean => e.dir === 'tx' || e.dir === 'rx';
    const total = this.entries.filter(isFrame).length;
    const limit = options.maxFrames;
    const head = limit !== undefined ? Math.ceil(limit / 2) : total;
    const tail = limit !== undefined ? Math.floor(limit / 2) : 0;
    const dropFrom = head;
    const dropTo = total - tail; // las tramas con rango en [dropFrom, dropTo) se omiten
    const lines: string[] = [];
    let rank = 0;
    let marked = false;
    for (const e of this.entries) {
      if (isFrame(e)) {
        const mine = rank++;
        if (limit !== undefined && total > limit && mine >= dropFrom && mine < dropTo) {
          if (!marked) {
            lines.push(`        … ${dropTo - dropFrom} tramas omitidas (se conservan las primeras y las últimas; los datos en bruto van al final) …`);
            marked = true;
          }
          continue;
        }
      }
      lines.push(`${String(e.t).padStart(7)} ms ${e.dir.padEnd(4)} ${e.hex ?? ''}${e.note ? `  ${e.note}` : ''}`.trimEnd());
    }
    if (this.pinned.length > 0) lines.push('', '--- datos en bruto (para decodificar sin el anillo) ---', this.pinned.join('\n\n'));
    return lines.join('\n');
  }
}
