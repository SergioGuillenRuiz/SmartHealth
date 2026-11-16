import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { SleepStageName } from '../../domain/types';
import { fmtClock, fmtDuration } from '../format';
import { useWidth } from '../hooks';
import { linear } from './scale';
import { Tooltip, type TooltipData } from './Tooltip';

export interface HypnoSegment {
  stage: Exclude<SleepStageName, 'nap'>;
  startMs: number;
  durationSec: number;
}

interface HypnogramProps {
  segments: readonly HypnoSegment[];
  startMs: number;
  endMs: number;
  ariaLabel: string;
}

/** De arriba a abajo: despierto, REM, ligero y profundo. La posición del carril ya dice la fase, aunque no se distingan los colores. */
const LANE_ORDER: ReadonlyArray<HypnoSegment['stage']> = ['awake', 'rem', 'light', 'deep'];

export const STAGE_LABEL: Record<HypnoSegment['stage'], string> = { awake: 'Despierto', rem: 'REM', light: 'Ligero', deep: 'Profundo' };
export const STAGE_COLOR: Record<HypnoSegment['stage'], string> = { awake: 'var(--sleep-awake)', rem: 'var(--sleep-rem)', light: 'var(--sleep-light)', deep: 'var(--sleep-deep)' };

const LANE_H = 36;
const BAR_H = 24;
const PAD_X = 2;
const TOP = 6;

/**
 * Las fases de la noche como en Smart Health: carriles a todo el ancho, sin rótulos (los colores y la leyenda de debajo dicen
 * qué es cada uno), solo la hora de acostarse y la de despertar en el eje, y al tocar (o con las flechas) una línea vertical y la
 * lectura del tramo: «08:59 – 09:21 · Profundo». El carril «despierto» solo existe si el anillo marca tramos despierto.
 */
export function Hypnogram({ segments, startMs, endMs, ariaLabel }: HypnogramProps): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  /** Dónde está el cursor (px): sigue al dedo; con el teclado se pone en el centro del tramo. */
  const [cursor, setCursor] = useState<number | null>(null);

  const lanes = segments.some((s) => s.stage === 'awake') ? LANE_ORDER : LANE_ORDER.filter((stage) => stage !== 'awake');
  const plotW = Math.max(10, width - 2 * PAD_X);
  const plotH = lanes.length * LANE_H;
  const base = TOP + plotH;
  const height = base + 24;
  const x = linear(startMs, endMs, PAD_X, PAD_X + plotW);
  /** Donde cae un instante, sin salirse del área: un tramo que acabara después del final de la noche no se pinta fuera del gráfico. */
  const xIn = (ms: number): number => Math.min(PAD_X + plotW, Math.max(PAD_X, x(ms)));
  const laneCenter = (stage: HypnoSegment['stage']): number => TOP + lanes.indexOf(stage) * LANE_H + LANE_H / 2;

  const pick = (clientX: number, target: SVGElement): void => {
    const rect = target.getBoundingClientRect();
    const px = Math.max(PAD_X, Math.min(PAD_X + plotW, clientX - rect.left));
    const t = startMs + ((px - PAD_X) / plotW) * (endMs - startMs);
    const index = segments.findIndex((s) => t >= s.startMs && t < s.startMs + s.durationSec * 1000);
    setActive(index >= 0 ? index : null);
    setCursor(index >= 0 ? px : null);
  };
  const select = (index: number | null): void => {
    setActive(index);
    const s = index === null ? undefined : segments[index];
    setCursor(s ? x(s.startMs + (s.durationSec * 1000) / 2) : null);
  };
  const clear = (): void => select(null);

  const seg = active === null ? undefined : segments[active];
  const tooltip: TooltipData | null =
    seg && cursor !== null
      ? {
          x: cursor,
          title: `${fmtClock(seg.startMs)} – ${fmtClock(seg.startMs + seg.durationSec * 1000)}`,
          rows: [{ label: STAGE_LABEL[seg.stage], value: fmtDuration(seg.durationSec), color: STAGE_COLOR[seg.stage] }],
        }
      : null;

  return (
    <div ref={ref} class="plot hypno" style={{ height: `${height}px` }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabindex={0}
        class="plot__svg"
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onPointerLeave={(e) => e.pointerType !== 'touch' && clear()}
        onBlur={clear}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') select(Math.max(0, (active ?? segments.length) - 1));
          else if (e.key === 'ArrowRight') select(Math.min(segments.length - 1, (active ?? -1) + 1));
          else if (e.key === 'Escape' && active !== null) clear(); // sin lectura que quitar, Esc es de la hoja: que la cierre
          else return;
          e.preventDefault();
        }}
      >
        {lanes.map((stage) => (
          <line key={stage} x1={PAD_X} x2={PAD_X + plotW} y1={laneCenter(stage)} y2={laneCenter(stage)} class="plot__grid hypno__lane" />
        ))}
        <line x1={PAD_X} x2={PAD_X + plotW} y1={base} y2={base} class="plot__axis" />
        <text x={PAD_X} y={base + 17} class="plot__tick" text-anchor="start">
          {fmtClock(startMs)}
        </text>
        <text x={PAD_X + plotW} y={base + 17} class="plot__tick" text-anchor="end">
          {fmtClock(endMs)}
        </text>

        {/* El hilo que une cada tramo con el siguiente cuando cambia de carril */}
        {segments.map((s, i) => {
          const next = segments[i + 1];
          if (!next || s.stage === next.stage) return null;
          const xEnd = xIn(s.startMs + s.durationSec * 1000);
          return <line key={`c${i}`} x1={xEnd} x2={xEnd} y1={laneCenter(s.stage)} y2={laneCenter(next.stage)} class="plot__link" />;
        })}
        {segments.map((s, i) => {
          const x0 = xIn(s.startMs);
          const w = Math.max(2, xIn(s.startMs + s.durationSec * 1000) - x0 - 1);
          return (
            <rect
              key={i}
              x={x0}
              y={laneCenter(s.stage) - BAR_H / 2}
              width={w}
              height={BAR_H}
              rx={Math.min(BAR_H / 2, w / 2)}
              fill={STAGE_COLOR[s.stage]}
              opacity={active !== null && active !== i ? 0.45 : 1}
            />
          );
        })}
        {seg && cursor !== null && <line x1={cursor} x2={cursor} y1={TOP} y2={base} class="plot__cross" />}
      </svg>
      {tooltip && <Tooltip data={tooltip} width={width} />}
    </div>
  );
}
