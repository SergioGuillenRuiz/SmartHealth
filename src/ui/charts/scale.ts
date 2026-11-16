// Escalas y formato de ejes para los gráficos propios (SVG).

export interface NiceScale {
  min: number;
  max: number;
  ticks: number[];
  step: number;
}

/** Redondea hacia un paso "bonito" (1, 2, 2,5, 5 × 10ⁿ). */
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const fraction = rough / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

/**
 * Escala con marcas redondas. `includeZero` fuerza el 0 (obligatorio en barras: la longitud es el dato).
 * Con datos planos (min = max) abre un margen para que la línea no quede pegada al borde.
 */
export function niceScale(minValue: number, maxValue: number, targetTicks = 4, includeZero = false): NiceScale {
  let lo = includeZero ? Math.min(0, minValue) : minValue;
  let hi = includeZero ? Math.max(0, maxValue) : maxValue;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1], step: 1 };
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / Math.max(1, targetTicks));
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min, max, ticks, step };
}

/** Compacto desde 1000: 0, 1K, 2,5K, 12K. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${Math.round(value / 1000)}K`;
  if (abs >= 1000) return `${(Math.round(value / 100) / 10).toLocaleString('es-ES')}K`;
  return Number.isInteger(value) ? String(value) : value.toLocaleString('es-ES', { maximumFractionDigits: 1 });
}

export type Linear = (value: number) => number;

export function linear(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): Linear {
  const span = domainMax - domainMin || 1;
  return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

/** Índices de las etiquetas del eje X que caben sin pisarse (siempre incluye el primero y, si cabe, el último). */
export function pickLabelIndexes(count: number, plotWidth: number, minGapPx: number): number[] {
  if (count <= 0) return [];
  const maxLabels = Math.max(2, Math.floor(plotWidth / minGapPx));
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const stride = Math.ceil((count - 1) / (maxLabels - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i += stride) out.push(i);
  return out;
}

/**
 * Escala que se ajusta a lo dibujado: de un poco por debajo del mínimo a un poco por encima del máximo (sin cero: no son barras). Con `reference` (el
 * peso objetivo) también lo abarca si queda cerca de lo dibujado —a menos de 3 unidades o del doble del recorrido—; si queda lejos no se estira la escala,
 * porque aplastaría la curva que es lo que se quiere leer. `referenceShown` dice si se abarcó.
 */
export function rangeScale(values: readonly number[], reference?: number): { min: number; max: number; lo: number; hi: number; referenceShown: boolean } | null {
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const gap = reference === undefined ? Infinity : reference < lo ? lo - reference : reference > hi ? reference - hi : 0;
  const referenceShown = reference !== undefined && gap <= Math.max(3, 2 * (hi - lo));
  const from = referenceShown ? Math.min(lo, reference) : lo;
  const to = referenceShown ? Math.max(hi, reference) : hi;
  const pad = to > from ? (to - from) * 0.14 : Math.max(1, Math.abs(to) * 0.05);
  return { min: from - pad, max: to + pad, lo, hi, referenceShown };
}
