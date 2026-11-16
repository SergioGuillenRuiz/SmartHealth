import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useWidth } from '../hooks';
import { linear, pickLabelIndexes } from './scale';
import { Tooltip, type TooltipData } from './Tooltip';

export interface RangeDatum {
  key: string;
  label: string;
  title: string;
  /** Extremos de la barra flotante, en las unidades de su eje (en la ventana de sueño, minutos desde el corte del eje: ver `clock-axis.ts`). */
  from: number | null;
  to: number | null;
  /** Una marca dentro de la barra (la media, en el pulso). */
  mark?: number | null;
  /** Filas del tooltip cuando hay datos; sin ellos sale «Sin datos». */
  rows: ReadonlyArray<{ label: string; value: string }>;
}

/** Cómo se coloca un valor en el eje: un valor normal, tal cual; el reloj, contado desde donde se corta el día (`clock-axis.ts`). */
export interface RangeAxis {
  position: (value: number) => number;
  /** Del valor que ocupa una posición al texto de su marca. */
  label: (position: number) => string;
  /** Los límites del eje para esos extremos (múltiplos de `step`). */
  domain: (lows: readonly number[], highs: readonly number[]) => [number, number];
  step: number;
  /** Lo que dice el tooltip cuando un periodo no tiene datos. */
  empty: string;
}

/** Un valor corriente (lpm…): de decena en decena, con un par de unidades de margen. */
export function valueAxis(empty: string, step = 10): RangeAxis {
  return {
    position: (value) => value,
    label: (position) => String(position),
    domain: (lows, highs) => {
      const lo = Math.max(0, Math.floor((Math.min(...lows, 1e9) - 3) / step) * step);
      const hi = Math.ceil((Math.max(...highs, 0) + 3) / step) * step;
      return [lo, Math.max(hi, lo + 2 * step)];
    },
    step,
    empty,
  };
}

/**
 * Ventana de sueño por noche: una barra flotante de la hora de acostarse a la de despertar. Con la
 * regularidad se ve de un vistazo: barras alineadas = horario estable.
 */
export function RangeChart({
  data,
  color,
  ariaLabel,
  axis,
  height = 170,
}: {
  data: readonly RangeDatum[];
  color: string;
  ariaLabel: string;
  axis: RangeAxis;
  height?: number;
}): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const left = 44;
  const right = 6;
  const top = 8;
  const axisBand = 22;
  const plotW = Math.max(10, width - left - right);
  const base = top + height;

  const usable = data.filter((d) => d.from !== null && d.to !== null);
  const [lo, hi] = axis.domain(
    usable.map((d) => axis.position(d.from as number)),
    usable.map((d) => axis.position(d.to as number)),
  );
  const y = linear(lo, hi, top, base);

  const n = data.length;
  const band = plotW / Math.max(1, n);
  const thick = Math.max(2, Math.min(18, band - 2));
  const labelIdx = new Set(pickLabelIndexes(n, plotW, 46));

  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += axis.step) ticks.push(t);

  const select = (clientX: number, target: SVGElement): void => {
    const rect = target.getBoundingClientRect();
    setActive(Math.max(0, Math.min(n - 1, Math.floor(((clientX - rect.left - left) / plotW) * n))));
  };
  const datum = active === null ? undefined : data[active];
  const tooltip: TooltipData | null =
    datum && active !== null
      ? {
          x: left + band * active + band / 2,
          title: datum.title,
          rows:
            datum.from === null || datum.to === null
              ? [{ label: axis.empty, value: 'Sin datos' }]
              : datum.rows.map((row, index) => (index < 2 ? { ...row, color } : row)),
        }
      : null;

  return (
    <div ref={ref} class="plot" style={{ height: `${top + height + axisBand}px` }}>
      <svg
        width={width}
        height={top + height + axisBand}
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
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} class="plot__grid" />
            <text x={left - 6} y={y(t)} class="plot__tick" text-anchor="end" dominant-baseline="central">
              {axis.label(t)}
            </text>
          </g>
        ))}
        <line x1={left} x2={left + plotW} y1={base} y2={base} class="plot__axis" />
        {data.map((d, i) => {
          if (d.from === null || d.to === null) return null;
          const a = y(axis.position(d.from));
          const b = y(axis.position(d.to));
          const x0 = left + band * i + (band - thick) / 2;
          const dim = active !== null && active !== i ? 0.45 : 1;
          return (
            <g key={d.key} opacity={dim}>
              <rect x={x0} y={Math.min(a, b)} width={thick} height={Math.max(3, Math.abs(b - a))} rx={Math.min(4, thick / 2)} fill={color} />
              {d.mark !== null && d.mark !== undefined && thick >= 3 && <rect x={x0} y={y(axis.position(d.mark)) - 1.5} width={thick} height={3} rx={1.5} fill="var(--surface)" />}
            </g>
          );
        })}
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
