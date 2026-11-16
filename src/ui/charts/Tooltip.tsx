import type { JSX } from 'preact';

export interface TooltipRow {
  label: string;
  value: string;
  /** Color de la serie: se muestra como un trazo corto, no como una caja. */
  color?: string;
}

export interface TooltipData {
  /** Posición horizontal (px) dentro del contenedor del gráfico. */
  x: number;
  title: string;
  rows: TooltipRow[];
}

const HALF_WIDTH = 84;

/**
 * Lectura de un punto: el valor manda (alto contraste) y el nombre de la serie va detrás. Se coloca
 * encima del área de trazado y se mantiene dentro del ancho del gráfico.
 */
export function Tooltip({ data, width }: { data: TooltipData; width: number }): JSX.Element {
  const left = Math.max(HALF_WIDTH, Math.min(width - HALF_WIDTH, data.x));
  return (
    <div class="tip" style={{ left: `${left}px` }} role="status">
      <div class="tip__title">{data.title}</div>
      {data.rows.map((row) => (
        <div class="tip__row" key={row.label}>
          {row.color && <span class="tip__key" style={{ background: row.color }} aria-hidden="true" />}
          <span class="tip__value">{row.value}</span>
          <span class="tip__label">{row.label}</span>
        </div>
      ))}
    </div>
  );
}
