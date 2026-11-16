import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useWidth } from '../hooks';
import { compact, linear, niceScale, pickLabelIndexes } from './scale';
import { Tooltip, type TooltipData } from './Tooltip';

export interface BarDatum {
  key: string;
  /** Etiqueta del eje X, ya formateada. */
  label: string;
  value: number | null;
  /** Cabecera del tooltip. */
  title: string;
  /** Filas extra del tooltip. */
  extra?: Array<{ label: string; value: string }>;
}

export interface BarReference {
  value: number;
  label: string;
}

interface BarChartProps {
  data: readonly BarDatum[];
  color: string;
  /** Nombre de la serie en el tooltip. */
  seriesName: string;
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  height?: number;
  /** Objetivo (continua) y media (a trazos): líneas finas de referencia. Se nombran en la leyenda del marco, no sobre las barras. */
  goal?: BarReference;
  average?: BarReference;
  ariaLabel: string;
  minLabelGap?: number;
}

const MAX_BAR = 24;
const GAP = 2;

/** Barra con el extremo de datos redondeado (4 px) y el arranque recto en la base. */
export function barPath(x: number, y: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - y));
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

export function BarChart({
  data,
  color,
  seriesName,
  format,
  axisFormat = compact,
  height = 150,
  goal,
  average,
  ariaLabel,
  minLabelGap = 46,
}: BarChartProps): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const left = 38;
  const right = 6;
  const top = 8;
  const axisBand = 22;
  const plotW = Math.max(10, width - left - right);
  const plotH = height;
  const base = top + plotH;

  const values = data.map((d) => d.value ?? 0);
  const maxRef = Math.max(0, goal?.value ?? 0, average?.value ?? 0);
  const scale = niceScale(0, Math.max(1, ...values, maxRef), 3, true);
  const y = linear(scale.min, scale.max, base, top);

  const n = data.length;
  const band = plotW / Math.max(1, n);
  const thick = Math.max(1.5, Math.min(MAX_BAR, band - GAP));
  const xOf = (i: number): number => left + band * i + (band - thick) / 2;

  const labelIdx = new Set(pickLabelIndexes(n, plotW, minLabelGap));

  const select = (clientX: number, target: HTMLElement | SVGElement): void => {
    const rect = target.getBoundingClientRect();
    const i = Math.floor(((clientX - rect.left - left) / plotW) * n);
    setActive(Math.max(0, Math.min(n - 1, i)));
  };

  const datum = active === null ? undefined : data[active];
  const tooltip: TooltipData | null =
    datum && active !== null
      ? {
          x: left + band * active + band / 2,
          title: datum.title,
          rows: [
            { label: seriesName, value: datum.value === null ? 'Sin datos' : format(datum.value), color },
            ...(datum.extra ?? []),
          ],
        }
      : null;

  return (
    <div ref={ref} class="plot" style={{ height: `${top + plotH + axisBand}px` }}>
      <svg
        width={width}
        height={top + plotH + axisBand}
        role="img"
        aria-label={ariaLabel}
        tabindex={0}
        class="plot__svg"
        onPointerMove={(e) => select(e.clientX, e.currentTarget)}
        onPointerDown={(e) => select(e.clientX, e.currentTarget)}
        onPointerLeave={(e) => e.pointerType !== 'touch' && setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
          else if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
          else if (e.key === 'Escape' && active !== null) setActive(null); // sin lectura que quitar, Esc es de la hoja
          else return;
          e.preventDefault();
        }}
      >
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} class="plot__grid" />
            <text x={left - 6} y={y(t)} class="plot__tick" text-anchor="end" dominant-baseline="central">
              {axisFormat(t)}
            </text>
          </g>
        ))}
        <line x1={left} x2={left + plotW} y1={base} y2={base} class="plot__axis" />

        {data.map((d, i) => {
          const x = xOf(i);
          const dim = active !== null && active !== i;
          if (d.value === null) {
            return <rect key={d.key} x={x} y={base - 2} width={thick} height={2} rx={1} class="plot__nodata" />;
          }
          const h = Math.max(0, base - y(d.value));
          if (h < 0.5) return null;
          return <path key={d.key} d={barPath(x, base - h, thick, base)} fill={color} opacity={dim ? 0.45 : 1} />;
        })}

        {goal && (
          <line x1={left} x2={left + plotW} y1={y(goal.value)} y2={y(goal.value)} class="plot__ref">
            <title>{goal.label}</title>
          </line>
        )}
        {average && (
          <line x1={left} x2={left + plotW} y1={y(average.value)} y2={y(average.value)} class="plot__ref plot__ref--avg">
            <title>{average.label}</title>
          </line>
        )}

        {data.map((d, i) =>
          labelIdx.has(i) ? (
            <text key={`x${d.key}`} x={left + band * i + band / 2} y={base + 16} class="plot__tick" text-anchor="middle">
              {d.label}
            </text>
          ) : null,
        )}
      </svg>
      {tooltip && <Tooltip data={tooltip} width={width} />}
    </div>
  );
}
