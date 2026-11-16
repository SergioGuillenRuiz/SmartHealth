import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { fmt1 } from '../format';
import { useWidth } from '../hooks';
import { barPath } from './BarChart';
import { changeOf } from './joint-marks';
import { compact, linear, niceScale, pickLabelIndexes, rangeScale } from './scale';
import { Tooltip, type TooltipData } from './Tooltip';

/** Un periodo del gráfico: su clave, las etiquetas del eje y de la lectura, y filas extra (p. ej. los días con datos de una semana). El valor de cada dato va en su banda. */
export interface JointDatum {
  key: string;
  /** Etiqueta corta del eje X, ya formateada. */
  label: string;
  /** Cabecera de la lectura. */
  title: string;
  /** Filas extra de la lectura (p. ej. los días con datos de una semana). */
  extra?: Array<{ label: string; value: string }>;
}

/**
 * Una banda del gráfico: un dato con su propia escala (las medidas no se pueden poner en un solo eje) y el valor de cada periodo. Las bandas son las que elige la persona,
 * en el orden que quiera y sin tope: el gráfico crece con ellas.
 */
export interface JointBand {
  id: string;
  title: string;
  tag: string;
  /** Variable de color (`tokens.css`). */
  color: string;
  /** Alto del trazado (px). */
  plotH: number;
  /** Lo que se escribe en la banda si ningún periodo tiene el dato. */
  empty: string;
  /** Barras desde cero (lo que se acumula en el día) o una línea que sigue el valor (el peso, el pulso…). */
  mode: 'bars' | 'line';
  /** El valor de cada periodo, en el orden de `data` (`null`: ese periodo no lo tiene, que no es un cero). */
  values: ReadonlyArray<number | null>;
  /** Cómo se llama en la lectura del cursor («pasos al día») y cómo se escribe su valor. */
  reading: string;
  format: (value: number) => string;
  /** Cómo se escriben los números del eje. */
  tickFormat: (value: number) => string;
  /**
   * Un objetivo: en las barras, una línea fina con su etiqueta junto al título; en una línea (el peso), la línea fina y la etiqueta DENTRO del trazado (si queda cerca de lo
   * dibujado; si no, solo la etiqueta con una flecha hacia donde está).
   */
  goal?: { value: number; label: string };
  /** Una meta distinta en cada periodo (la del agua sube con el ejercicio): una línea fina que la sigue, su etiqueta junto al título y cómo se llama en la lectura. */
  goalSeries?: { values: ReadonlyArray<number | null>; label?: string; reading: string };
  /** En una línea que se arrastra entre medidas (el peso solo se anota cuando cambia): dónde hubo una medida de verdad (solo ahí va la marca) y cómo se llama la que se arrastra. */
  measured?: { at: ReadonlyArray<boolean>; carriedReading: string };
  /** Escribir junto al título lo que cambió el dato de principio a fin («−0,6 kg»). */
  change?: { decimals: 0 | 1; unit: string };
}

interface JointChartProps {
  data: readonly JointDatum[];
  bands: readonly JointBand[];
  ariaLabel: string;
}

const LEFT = 40;
const RIGHT = 10;
const TOP = 2;
const TITLE_H = 26;
const GAP = 20;
const AXIS_H = 28;
const MAX_BAR = 30;
const BAR_GAP = 2;
const MARKER_R = 4.5;

/** «−0,6 kg», «+2 lpm» o «sin cambio»: lo que cambió una medida de principio a fin del periodo. */
function formatChange(change: number | null, decimals: 0 | 1, unit: string): string | null {
  if (change === null) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(change * factor) / factor;
  if (rounded === 0) return 'sin cambio';
  const abs = Math.abs(rounded);
  return `${rounded > 0 ? '+' : '−'}${decimals === 0 ? String(abs) : fmt1(abs)} ${unit}`;
}

const presentOf = (values: ReadonlyArray<number | null>): number[] => values.filter((v): v is number => v !== null);

/**
 * Dónde va la etiqueta del peso objetivo, DENTRO del trazado (en la fila del título no cabe a 360 px junto al cambio de peso). Con la línea dibujada, pegada a ella: por
 * debajo si el objetivo queda por debajo de todo lo dibujado y por encima en los demás casos, lejos de la curva. Sin línea (el objetivo queda lejos de lo dibujado), a ras
 * del borde hacia el que está, con una flecha.
 */
function goalLabelY(goal: number, scale: { lo: number; referenceShown: boolean }, band: { top: number; bottom: number }, yAt: (v: number) => number): number {
  if (scale.referenceShown) return goal < scale.lo ? yAt(goal) + 13 : yAt(goal) - 4;
  return goal < scale.lo ? band.bottom - 4 : band.top + 12;
}

/** Los puntos de una línea partida donde falta el dato: cada tramo seguido es una polilínea (un hueco no se une con una raya como si hubiera valores). */
function runsOf(points: ReadonlyArray<{ x: number; y: number; i: number } | null>): Array<Array<{ x: number; y: number; i: number }>> {
  const runs: Array<Array<{ x: number; y: number; i: number }>> = [];
  let current: Array<{ x: number; y: number; i: number }> = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Dónde va cada banda y con qué escala: barras desde cero o una línea ajustada a lo dibujado (y a su objetivo, si queda cerca). */
function layoutBands(specs: readonly JointBand[]) {
  let cursor = TOP;
  return specs.map((spec) => {
    const titleY = cursor;
    const top = cursor + TITLE_H;
    const bottomY = top + spec.plotH;
    cursor = bottomY + GAP;
    const present = presentOf(spec.values);
    const bars =
      spec.mode === 'bars' && present.length > 0
        ? niceScale(0, Math.max(1, ...present, spec.goal?.value ?? 0, ...presentOf(spec.goalSeries?.values ?? [])), 3, true)
        : null;
    const line = spec.mode === 'line' ? rangeScale(present, spec.goal?.value) : null;
    const extent = bars ?? line;
    const y = extent ? linear(extent.min, extent.max, bottomY, top) : null;
    return { spec, titleY, top, bottom: bottomY, bars, line, y };
  });
}

/** Hasta cuántos periodos se atenúan las barras que no son la leída: con más (un año, todo) las barras son finas, no se nota, y rehacer cientos de ellas con cada movimiento del dedo no compensa. */
const DIM_UP_TO = 60;
/** Ancho medio (px) de un carácter del título, de su aviso y de la etiqueta de la derecha, y el hueco mínimo entre ellos: sirven para saber si caben en la misma fila. */
const TITLE_CHAR_W = 6.3;
const TAG_CHAR_W = 6.4;
const REF_CHAR_W = 6.4;
const TITLE_GAP = 10;

/** Hasta cuántos periodos se marca cada punto de una línea: con muchos, las marcas taparían la curva. */
const MAX_MARKED = 45;
const SMALL_R = 3;

/**
 * Gráfico conjunto de la evolución: UNA banda para cada dato que la persona elige (pasos, calorías, peso, sueño, pulso…), cada una con su escala y todas con el mismo eje
 * de tiempo y el mismo cursor. Así se ve de un vistazo cómo se mueven a la vez, sin inventar una correlación dibujando dos escalas distintas sobre un mismo eje. Se lee con el
 * dedo, el ratón o las flechas ← →.
 */
export function JointChart({ data, bands: specs, ariaLabel }: JointChartProps): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const n = data.length;
  const plotW = Math.max(10, width - LEFT - RIGHT);
  const slotW = plotW / Math.max(1, n);
  const cx = (i: number): number => LEFT + slotW * (i + 0.5);

  // El trazado de las bandas (escalas y posiciones) solo cambia si cambian los datos: al arrastrar la barra de lectura por los días no se rehace.
  const bands = useMemo(() => layoutBands(specs), [specs]);
  const bottom = bands.length > 0 ? (bands[bands.length - 1] as (typeof bands)[number]).bottom : TOP + AXIS_H;
  const height = bottom + AXIS_H;

  const thick = Math.max(1.5, Math.min(MAX_BAR, slotW - BAR_GAP));
  const labelIdx = new Set(pickLabelIndexes(n, plotW, 52));

  const select = (clientX: number, target: SVGElement): void => {
    const rect = target.getBoundingClientRect();
    const i = Math.floor(((clientX - rect.left - LEFT) / plotW) * n);
    setActive(Math.max(0, Math.min(n - 1, i)));
  };

  // Si el periodo cambia con el cursor puesto, su posición puede no existir ya: entonces no hay cursor.
  const shown = active !== null && active < n ? active : null;
  /** La barra que se deja a todo color mientras se lee otra (solo con pocos periodos: con muchos no se nota y obligaría a rehacer cientos de barras con cada movimiento del dedo). */
  const dimIndex = n <= DIM_UP_TO ? shown : null;
  const datum = shown === null ? undefined : data[shown];
  const tooltip: TooltipData | null =
    datum && shown !== null
      ? {
          x: cx(shown),
          title: datum.title,
          rows: [
            ...bands.flatMap(({ spec }) => {
              const value = spec.values[shown] ?? null;
              if (value === null) return [];
              const carried = spec.measured !== undefined && spec.measured.at[shown] !== true;
              const goal = spec.goalSeries?.values[shown] ?? null;
              return [
                { label: carried ? (spec.measured?.carriedReading ?? spec.reading) : spec.reading, value: spec.format(value), color: spec.color },
                ...(goal !== null && spec.goalSeries ? [{ label: spec.goalSeries.reading, value: spec.format(goal) }] : []),
              ];
            }),
            ...(bands.every(({ spec }) => (spec.values[shown] ?? null) === null) ? [{ label: 'Sin datos', value: '—' }] : []),
            ...(datum.extra ?? []),
          ],
        }
      : null;

  const empty = (band: (typeof bands)[number]): JSX.Element => (
    <text x={LEFT + plotW / 2} y={(band.top + band.bottom) / 2} class="jc__empty" text-anchor="middle" dominant-baseline="central">
      {band.spec.empty}
    </text>
  );

  const rangeTicks = (scale: { lo: number; hi: number }, y: (v: number) => number, format: (v: number) => string): JSX.Element[] =>
    (scale.lo === scale.hi ? [scale.lo] : [scale.lo, scale.hi]).map((t) => (
      <g key={t}>
        <line x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} class="plot__grid" />
        <text x={LEFT - 6} y={y(t)} class="plot__tick" text-anchor="end" dominant-baseline="central">
          {format(t)}
        </text>
      </g>
    ));

  const bar = (band: (typeof bands)[number], yAt: (v: number) => number): JSX.Element => (
    <g>
      {(band.bars?.ticks ?? []).map((t) => (
        <g key={t}>
          <line x1={LEFT} x2={LEFT + plotW} y1={yAt(t)} y2={yAt(t)} class="plot__grid" />
          <text x={LEFT - 6} y={yAt(t)} class="plot__tick" text-anchor="end" dominant-baseline="central">
            {compact(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = cx(i) - thick / 2;
        const dim = dimIndex !== null && dimIndex !== i;
        const value = band.spec.values[i] ?? null;
        if (value === null) return <rect key={d.key} x={x} y={band.bottom - 2} width={thick} height={2} rx={1} class="plot__nodata" />;
        const h = Math.max(0, band.bottom - yAt(value));
        return h < 0.5 ? null : <path key={d.key} d={barPath(x, band.bottom - h, thick, band.bottom)} fill={band.spec.color} opacity={dim ? 0.45 : 1} />;
      })}
      {band.spec.goal && <line x1={LEFT} x2={LEFT + plotW} y1={yAt(band.spec.goal.value)} y2={yAt(band.spec.goal.value)} class="plot__ref" />}
      {(() => {
        // La meta de cada periodo (con el ejercicio cambia de un día a otro): una línea que la sigue por encima de las barras.
        const goalPoints = (band.spec.goalSeries?.values ?? []).flatMap((v, i) => (v === null ? [] : [{ x: cx(i), y: yAt(v) }]));
        if (goalPoints.length > 1) return <polyline points={goalPoints.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" class="plot__ref" />;
        const only = goalPoints[0];
        return only ? <line x1={LEFT} x2={LEFT + plotW} y1={only.y} y2={only.y} class="plot__ref" /> : null;
      })()}
    </g>
  );

  const lineBand = (band: (typeof bands)[number], yAt: (v: number) => number, scale: NonNullable<(typeof bands)[number]['line']>): JSX.Element => {
    const points = band.spec.values.map((v, i) => (v === null ? null : { x: cx(i), y: yAt(v), i }));
    const runs = runsOf(points);
    const drawn = points.filter((p): p is { x: number; y: number; i: number } => p !== null);
    const goal = band.spec.goal;
    const measured = band.spec.measured;
    // Con el dato medido solo a veces (el peso), la marca va solo en las medidas; si no, en todos los puntos mientras no sean tantos que tapen la curva.
    const marked = (i: number): boolean => (measured ? measured.at[i] === true || drawn.length === 1 : drawn.length <= MAX_MARKED);
    return (
      <g>
        {rangeTicks(scale, yAt, band.spec.tickFormat)}
        {goal && scale.referenceShown && <line x1={LEFT} x2={LEFT + plotW} y1={yAt(goal.value)} y2={yAt(goal.value)} class="plot__ref" />}
        {goal && (
          <text x={LEFT + plotW - 2} y={goalLabelY(goal.value, scale, band, yAt)} class="jc__ref" text-anchor="end">
            {scale.referenceShown ? goal.label : `${goal.value < scale.lo ? '↓' : '↑'} ${goal.label}`}
          </text>
        )}
        {runs.map((run) => (run.length > 1 ? <polyline key={run[0]?.i} points={run.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={band.spec.color} stroke-width={2} stroke-linejoin="round" stroke-linecap="round" /> : null))}
        {drawn.map((p) => (marked(p.i) ? <circle key={p.i} cx={p.x} cy={p.y} r={measured ? MARKER_R : SMALL_R} fill={band.spec.color} stroke="var(--surface)" stroke-width={measured ? 2 : 1.5} /> : null))}
      </g>
    );
  };

  // A la derecha del título: el objetivo de las barras, la meta que cambia de un periodo a otro o lo que cambió una línea de principio a fin.
  const rightLabelOf = (band: (typeof bands)[number]): string | null | undefined =>
    band.bars
      ? (band.spec.goal?.label ?? band.spec.goalSeries?.label)
      : band.spec.change
        ? formatChange(changeOf(band.spec.values), band.spec.change.decimals, band.spec.change.unit)
        : null;

  // Todo lo que no depende del cursor (títulos, barras o líneas, ejes y etiquetas) se arma una sola vez: arrastrar la barra de lectura por mil días solo rehace la barra, el punto y la lectura.
  const staticLayer = useMemo(
    () => (
      <>
        {bands.map((band) => {
          // En una pantalla estrecha el título con su aviso («· anotado») y la etiqueta de la derecha («Objetivo 1820») no caben en la misma fila: primero se quita el aviso.
          const label = rightLabelOf(band);
          const needed = band.spec.title.length * TITLE_CHAR_W + (label ? label.length * REF_CHAR_W + TITLE_GAP : 0);
          const withTag = needed + (band.spec.tag.length + 3) * TAG_CHAR_W <= plotW - 18;
          return (
            <g key={band.spec.id}>
              <rect x={LEFT} y={band.titleY + TITLE_H / 2 - 1.5} width={12} height={3} rx={1.5} fill={band.spec.color} />
              <text x={LEFT + 18} y={band.titleY + TITLE_H / 2} class="jc__title" dominant-baseline="central">
                {band.spec.title}
                {withTag && <tspan class="jc__tag"> · {band.spec.tag}</tspan>}
              </text>
            </g>
          );
        })}
        {bands.map((band) => {
          const label = rightLabelOf(band);
          return label ? (
            <text key={`r${band.spec.id}`} x={LEFT + plotW} y={band.titleY + TITLE_H / 2} class="jc__ref" text-anchor="end" dominant-baseline="central">
              {label}
            </text>
          ) : null;
        })}

        {bands.map((band) => {
          const body = band.bars && band.y ? bar(band, band.y) : band.line && band.y ? lineBand(band, band.y, band.line) : empty(band);
          return <g key={`b${band.spec.id}`}>{body}</g>;
        })}

        <line x1={LEFT} x2={LEFT + plotW} y1={bottom} y2={bottom} class="plot__axis" />
        {data.map((d, i) =>
          labelIdx.has(i) ? (
            <text key={`x${d.key}`} x={cx(i)} y={bottom + 19} class="plot__tick" text-anchor="middle">
              {d.label}
            </text>
          ) : null,
        )}
      </>
    ),
    [bands, data, plotW, dimIndex, thick],
  );

  return (
    <div ref={ref} class="plot" style={{ height: `${height}px` }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabindex={0}
        class="plot__svg jc"
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
        {staticLayer}

        {datum && shown !== null && bands.length > 0 && (
          <g>
            <line x1={cx(shown)} x2={cx(shown)} y1={(bands[0] as (typeof bands)[number]).top} y2={bottom} class="plot__cross" />
            {bands.map((band) => {
              const value = band.spec.values[shown] ?? null;
              return band.line && band.y && value !== null ? <circle key={band.spec.id} cx={cx(shown)} cy={band.y(value)} r={MARKER_R + 1} fill={band.spec.color} stroke="var(--surface)" stroke-width={2} /> : null;
            })}
          </g>
        )}
      </svg>
      {tooltip && <Tooltip data={tooltip} width={width} />}
    </div>
  );
}
