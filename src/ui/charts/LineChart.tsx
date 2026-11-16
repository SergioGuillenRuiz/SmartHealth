import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { maxOf, minOf } from '../../domain/extent';
import { useWidth } from '../hooks';
import { compact, linear, niceScale } from './scale';
import { Tooltip, type TooltipData } from './Tooltip';

export interface LinePoint {
  x: number;
  y: number | null;
}

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: readonly LinePoint[];
  /** Muestra siempre un marcador en cada punto (pocas lecturas); por defecto solo con ≤ 40 puntos. */
  markers?: boolean;
}

export interface XTick {
  x: number;
  label: string;
}

interface LineChartProps {
  series: readonly LineSeries[];
  xDomain: readonly [number, number];
  xTicks: readonly XTick[];
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  height?: number;
  ariaLabel: string;
  tooltipTitle: (x: number) => string;
  /** Rango Y fijo opcional (p. ej. SpO₂ 90–100). */
  yDomain?: readonly [number, number];
}

const MARKER_R = 4;

/** Segmentos continuos de una serie (un `null` corta la línea: un hueco no se une con una recta inventada). */
function segments(points: readonly LinePoint[]): LinePoint[][] {
  const out: LinePoint[][] = [];
  let current: LinePoint[] = [];
  for (const p of points) {
    if (p.y === null) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) out.push(current);
  return out;
}

export function LineChart({
  series,
  xDomain,
  xTicks,
  format,
  axisFormat = compact,
  height = 150,
  ariaLabel,
  tooltipTitle,
  yDomain,
}: LineChartProps): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [activeX, setActiveX] = useState<number | null>(null);

  const left = 38;
  const right = 10;
  const top = 10;
  const axisBand = 22;
  const plotW = Math.max(10, width - left - right);
  const base = top + height;

  const ys: number[] = [];
  for (const s of series) for (const p of s.points) if (p.y !== null) ys.push(p.y);
  const scale = yDomain
    ? niceScale(yDomain[0], yDomain[1], 3, false)
    : ys.length
      ? niceScale(minOf(ys), maxOf(ys), 3, false)
      : niceScale(0, 1, 3, false);
  const x = linear(xDomain[0], xDomain[1], left, left + plotW);
  const y = linear(scale.min, scale.max, base, top);

  // Posiciones X disponibles para el "imán" del cursor: la unión de los x de todas las series.
  const xs = [...new Set(series.flatMap((s) => s.points.filter((p) => p.y !== null).map((p) => p.x)))].sort((a, b) => a - b);

  const snap = (clientX: number, target: SVGElement): void => {
    if (!xs.length) return;
    const rect = target.getBoundingClientRect();
    const value = xDomain[0] + ((clientX - rect.left - left) / plotW) * (xDomain[1] - xDomain[0]);
    let best = xs[0] as number;
    for (const candidate of xs) if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
    setActiveX(best);
  };

  const step = (dir: 1 | -1): void => {
    if (!xs.length) return;
    const index = activeX === null ? (dir === 1 ? -1 : xs.length) : xs.indexOf(activeX);
    const next = Math.max(0, Math.min(xs.length - 1, index + dir));
    setActiveX(xs[next] ?? null);
  };

  const tooltip: TooltipData | null =
    activeX === null
      ? null
      : {
          x: x(activeX),
          title: tooltipTitle(activeX),
          rows: series
            .map((s) => {
              const p = s.points.find((q) => q.x === activeX && q.y !== null);
              return p && p.y !== null ? { label: s.label, value: format(p.y), color: s.color } : null;
            })
            .filter((r): r is { label: string; value: string; color: string } => r !== null),
        };

  return (
    <div ref={ref} class="plot" style={{ height: `${top + height + axisBand}px` }}>
      <svg
        width={width}
        height={top + height + axisBand}
        role="img"
        aria-label={ariaLabel}
        tabindex={0}
        class="plot__svg"
        onPointerMove={(e) => snap(e.clientX, e.currentTarget)}
        onPointerDown={(e) => snap(e.clientX, e.currentTarget)}
        onPointerLeave={(e) => e.pointerType !== 'touch' && setActiveX(null)}
        onBlur={() => setActiveX(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') step(-1);
          else if (e.key === 'ArrowRight') step(1);
          else if (e.key === 'Escape' && activeX !== null) setActiveX(null); // sin lectura que quitar, Esc es de la hoja
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
        {xTicks.map((t, i) => (
          // Los extremos se alinean hacia dentro para que la etiqueta no se salga del gráfico.
          <text
            key={t.x}
            x={x(t.x)}
            y={base + 16}
            class="plot__tick"
            text-anchor={i === 0 && x(t.x) - left < 24 ? 'start' : i === xTicks.length - 1 && left + plotW - x(t.x) < 24 ? 'end' : 'middle'}
          >
            {t.label}
          </text>
        ))}

        {series.map((s) => {
          const segs = segments(s.points);
          const total = segs.reduce((a, g) => a + g.length, 0);
          const showMarkers = s.markers ?? total <= 40;
          return (
            <g key={s.key}>
              {segs.map((seg, i) =>
                seg.length > 1 ? (
                  <polyline
                    key={i}
                    points={seg.map((p) => `${x(p.x)},${y(p.y as number)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    stroke-width={2}
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                ) : null,
              )}
              {showMarkers &&
                segs.flat().map((p) => (
                  <circle key={p.x} cx={x(p.x)} cy={y(p.y as number)} r={MARKER_R} fill={s.color} stroke="var(--surface)" stroke-width={2} />
                ))}
            </g>
          );
        })}

        {activeX !== null && (
          <g>
            <line x1={x(activeX)} x2={x(activeX)} y1={top} y2={base} class="plot__cross" />
            {series.map((s) => {
              const p = s.points.find((q) => q.x === activeX && q.y !== null);
              return p && p.y !== null ? (
                <circle key={s.key} cx={x(activeX)} cy={y(p.y)} r={MARKER_R + 1} fill={s.color} stroke="var(--surface)" stroke-width={2} />
              ) : null;
            })}
          </g>
        )}
      </svg>
      {tooltip && tooltip.rows.length > 0 && <Tooltip data={tooltip} width={width} />}
    </div>
  );
}
