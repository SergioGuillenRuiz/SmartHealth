// Filtro de las lecturas de pulso de UNA medida del anillo (desde que se pide hasta que el anillo la cierra).
//
// Lo que se sabe de estos anillos por capturas reales (proyecto PulseLoop, incidencia #59, con un anillo de la
// misma familia y la app oficial):
//   - nada más empezar, contesta al instante con el ÚLTIMO pulso que tenía guardado (un eco, no una lectura);
//   - después calla ~14 s y mantiene ~12 s un valor casi constante que todavía no ha convergido (una meseta);
//   - a los ~26 s da lecturas reales, y a los ~35 s CIERRA él mismo la medida con `04 0e`.
// Por eso un valor no es bueno «en cuanto aparece» ni «cuando se repite tres veces» (la meseta se repite): solo
// cuentan las lecturas posteriores al calentamiento o, si la medida se cierra antes de que pase, las últimas.

/**
 * Tiempo que se descarta desde que empieza la medida. Lo capturado es que el sensor da lecturas reales a partir de
 * ~26 s; se deja un margen de 2 s para que el final de la meseta no se cuele.
 */
export const DEFAULT_HR_WARMUP_MS = 28_000;

/** El anillo contesta al instante con el ÚLTIMO pulso guardado (un eco, no una lectura): lo que llega en estos primeros ms. */
export const ECHO_WINDOW_MS = 3000;

/** Pasado este tiempo sin que el anillo cierre la medida, se entiende que emite en continuo. */
export const DEFAULT_HR_STREAM_AFTER_MS = 60_000;

export interface HrSample {
  bpm: number;
  tsMs: number;
}

export class HrCycle {
  private readonly samples: HrSample[] = [];

  constructor(
    readonly startedMs: number,
    private readonly warmupMs: number = DEFAULT_HR_WARMUP_MS,
  ) {}

  add(bpm: number, tsMs: number): void {
    this.samples.push({ bpm, tsMs });
  }

  get count(): number {
    return this.samples.length;
  }

  /** ¿Ha pasado ya el calentamiento en este instante? */
  isReliable(tsMs: number): boolean {
    return tsMs - this.startedMs >= this.warmupMs;
  }

  /** Lecturas posteriores al calentamiento. */
  reliable(): HrSample[] {
    return this.samples.filter((s) => this.isReliable(s.tsMs));
  }

  /**
   * Lo que se da por bueno cuando el anillo cierra la medida con éxito: lo posterior al calentamiento o, si se cerró
   * antes de que pasara, las últimas lecturas (un anillo más rápido no debe quedarse sin resultado). El eco inicial
   * nunca cuenta: es el último valor guardado, no una medida de ahora.
   */
  atVerdict(): HrSample[] {
    const reliable = this.reliable();
    if (reliable.length > 0) return reliable;
    const [first, ...rest] = this.samples;
    const withoutEcho = first && first.tsMs - this.startedMs < ECHO_WINDOW_MS ? rest : this.samples;
    return withoutEcho.slice(-3);
  }
}

/** Mediana de una lista de lecturas (entera). */
export function medianBpm(samples: readonly HrSample[]): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.map((s) => s.bpm).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Diferencia entre la lectura mayor y la menor. */
export const spreadBpm = (samples: readonly HrSample[]): number =>
  samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.bpm)) - Math.min(...samples.map((s) => s.bpm));
