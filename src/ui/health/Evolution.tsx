import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { targetOptions } from '../../app/personal';
import { svc } from '../../app/services';
import { saveSettings } from '../../app/actions';
import { hasRing } from '../../app/devices';
import { bumpData, nowMs, profileHistory, profileSheetOpen, settings } from '../../app/state';
import { dayKeyOf, rangeDays, startOfDayMs, endOfDayMs, type DayKey } from '../../domain/dates';
import { maxOf, minOf } from '../../domain/extent';
import { JOINT_METRICS, jointMetricOf, jointValues, type JointMetricId } from '../../domain/joint-metrics';
import { autoGranularity, buildJointSlots, PRESETS, rangeForPreset, type DayRange, type Preset } from '../../domain/evolution';
import { nutritionTargets } from '../../domain/nutrition';
import type { ProfileEntry } from '../../domain/profile';
import { sleepRegularityOf } from '../../domain/sleep';
import { aggregate, buildDaySummaries, meanPerDay, resolveProfile, type DaySummary, type Granularity } from '../../domain/summary';
import { BarChart, type BarDatum } from '../charts/BarChart';
import { ChartFrame, type LegendItem } from '../charts/ChartFrame';
import { JointChart, type JointBand, type JointDatum } from '../charts/JointChart';
import { LineChart } from '../charts/LineChart';
import { clockAxis, clockCut, clockSpan } from '../charts/clock-axis';
import { RangeChart, valueAxis, type RangeDatum } from '../charts/RangeChart';
import { fmt1, fmtDayShort, fmtDayShortYear, fmtDayLong, fmtDuration, fmtInt, fmtMinutesOfDay, fmtUpTo1, plural } from '../format';
import { useAsync } from '../hooks';
import { Icon } from '../icons';
import { Badge, Card, CardHeader, EmptyState, Kpis, LoadError, Segmented } from '../primitives';
import { periodTitle, pointX, timeTicks, xLabel } from './evolution-data';
import { JointBlocks } from './JointBlocks';
import { JointPicker } from './JointPicker';
import { WeightGoalPanel } from './WeightGoalPanel';

interface EvolutionData {
  range: DayRange;
  days: DayKey[];
  summaries: DaySummary[];
}

async function loadEvolution(preset: Preset, history: readonly ProfileEntry[], now: number): Promise<EvolutionData> {
  const { store } = svc();
  const stats = await store.stats();
  const today = dayKeyOf(now);
  const candidates = [stats.firstDataMs ? dayKeyOf(stats.firstDataMs) : null, history[0]?.date ?? null].filter((d): d is DayKey => d !== null).sort();
  const range = rangeForPreset(preset, today, candidates[0] ?? null);
  const days = rangeDays(range.from, range.to);
  const raw = await store.loadRange(range.from, range.to);
  return { range, days, summaries: buildDaySummaries(days, raw, history, now) };
}

/**
 * Salud gira en torno a este panel: el periodo se elige en la regleta flotante de arriba (7 días, 30 días… y «Todo», que es con
 * lo que se abre) y TODOS los gráficos de la pestaña se redibujan para ese horizonte, siempre POR DÍAS (con muchos días, las barras se estrechan y la
 * barra vertical se arrastra para leer cada día): el gráfico conjunto de pasos, calorías comidas y peso, el sueño, el pulso y el oxígeno en sangre.
 */
export function Evolution(): JSX.Element {
  const history = profileHistory.value;
  const [preset, setPreset] = useState<Preset>('all');
  /** Los datos del gráfico mientras se editan (`null`: no se está editando). Nada se guarda hasta «Aplicar». */
  const [draft, setDraft] = useState<JointMetricId[] | null>(null);
  const [picking, setPicking] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const wasEditing = useRef(false);
  const { data, loading, error } = useAsync(() => loadEvolution(preset, history, nowMs.peek()), [preset, history]);
  const stale = loading && data !== undefined;
  const granularity: Granularity = autoGranularity(data?.days.length ?? 30);
  const editing = draft !== null;

  // El foco va a «Aplicar» al entrar a editar y vuelve a «Elegir qué datos ver» al salir. Al entrar, la tarjeta se coloca arriba (bajo la regleta del periodo): los bloques
  // son más cortos que el gráfico al que sustituyen y, sin esto, la página se quedaría con los primeros escondidos por encima.
  useEffect(() => {
    if (editing) {
      applyButton.current?.focus({ preventScroll: true });
      card.current?.scrollIntoView?.({ block: 'start' });
    } else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const finish = (apply: boolean): void => {
    if (apply && draft !== null) void saveSettings({ jointMetrics: draft });
    setDraft(null);
    setPicking(false);
  };
  const available = JOINT_METRICS.map((m) => m.id).filter((id) => !(draft ?? []).includes(id));

  return (
    <div>
      <div class="period-float">
        <Segmented label="Periodo de todos los gráficos" value={preset} onChange={setPreset} options={PRESETS} block />
      </div>
      <section class={`hero-card${editing ? ' is-editing' : ''}`} aria-label="Evolución" ref={card}>
        <header class="hero-card__head">
          <span class="hero-card__icon">
            <Icon name="chart-line" size={18} />
          </span>
          <h2>Evolución</h2>
        </header>
        {data ? (
          <JointPanel
            data={data}
            history={history}
            granularity={granularity}
            stale={stale}
            draft={draft}
            onDraft={setDraft}
            onAdd={available.length > 0 ? () => setPicking(true) : null}
          />
        ) : (
          !error && <p class="hero-card__note">Cargando…</p>
        )}
        {editing ? (
          <div class="hero-card__editbar">
            <button type="button" class="hero-card__action hero-card__action--primary" ref={applyButton} onClick={() => finish(true)}>
              <Icon name="Check" size={18} />
              Aplicar
            </button>
            <button type="button" class="hero-card__action" onClick={() => finish(false)}>
              <Icon name="X" size={18} />
              Descartar
            </button>
          </div>
        ) : (
          <>
            <WeightGoalPanel />
            <button type="button" class="hero-card__action" ref={editButton} onClick={() => setDraft([...settings.value.jointMetrics])}>
              <Icon name="SlidersHorizontal" size={18} />
              Elegir qué datos ver
            </button>
            <button type="button" class="hero-card__action" onClick={() => (profileSheetOpen.value = true)}>
              <Icon name="Scale" size={18} />
              Actualizar peso
            </button>
          </>
        )}
      </section>
      <JointPicker
        open={picking}
        available={available}
        onPick={(id) => {
          setDraft((current) => (current === null || current.includes(id) ? current : [...current, id]));
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
      {!hasRing.value ? null : data ? ( // sin anillo no salen el sueño, el pulso ni el oxígeno (lo ya guardado no se borra: vuelve al encender el anillo)
        <>
          <SleepChart data={data} granularity={granularity} stale={stale} />
          <PulseChart data={data} granularity={granularity} stale={stale} />
          <Spo2Chart data={data} granularity={granularity} stale={stale} />
        </>
      ) : error ? (
        <LoadError error={error} onRetry={bumpData} />
      ) : (
        <p class="sync-note">Cargando…</p>
      )}
    </div>
  );
}

// ───────────────────────────── gráfico conjunto ─────────────────────────────

const fmtValue = (decimals: 0 | 1) => (value: number): string => (decimals === 0 ? fmtInt(value) : fmt1(value));

/** «Sueño (h)» → «sueño»; «Pulso máximo (lpm)» → «pulso máximo»: el nombre del dato para el texto del gráfico. */
const plainName = (title: string): string => title.replace(/\s*\([^)]*\)\s*$/, '').replace(/ al día$/, '').toLowerCase();
const unitOf = (title: string): string => /\(([^)]+)\)\s*$/.exec(title)?.[1] ?? '';

/**
 * El gráfico conjunto de los datos que la persona elige (por omisión pasos, calorías comidas, agua y peso), en el orden que quiera, sobre un fondo claro dentro de la tarjeta
 * menta. Cada dato es una banda con su escala; el peso sale de las pesadas y los demás de los días del periodo (`jointValues`).
 */
function JointPanel({
  data,
  history,
  granularity,
  stale,
  draft,
  onDraft,
  onAdd,
}: {
  data: EvolutionData;
  history: readonly ProfileEntry[];
  granularity: Granularity;
  stale: boolean;
  /** Los datos que se están editando (`null`: se ve el gráfico normal). */
  draft: JointMetricId[] | null;
  onDraft: (ids: JointMetricId[]) => void;
  onAdd: (() => void) | null;
}): JSX.Element {
  const today = dayKeyOf(nowMs.value);
  const cfg = settings.value;
  const chosen = draft ?? cfg.jointMetrics;
  const slots = buildJointSlots(data.summaries, granularity, history, data.range, today);
  const starts = slots.map((s) => s.start);
  const valuesOf = (id: JointMetricId): Array<number | null> => (id === 'weight' ? slots.map((s) => s.weightKg) : jointValues(data.summaries, granularity, today, starts, jointMetricOf(id)));
  // La meta de calorías es la de hoy (con el objetivo de salud y el peso de ahora): una sola línea para todo el periodo.
  const kcalGoal = nutritionTargets(resolveProfile(history, today).profile, today, cfg.healthGoal, targetOptions()).kcal;
  const targetKg = cfg.targetWeightKg;
  // La meta media de agua de los días con agua anotada (cada día lleva la suya, que sube con el ejercicio).
  const waterGoalMean = meanPerDay(data.summaries.filter((d) => d.waterMl !== null), (d) => d.waterGoalMl, { skipDay: today });

  const bands: JointBand[] = chosen.map((id) => {
    const metric = jointMetricOf(id);
    const format = fmtValue(metric.decimals);
    const base: JointBand = { id, title: metric.title, tag: metric.tag, color: metric.color, plotH: metric.plotH, empty: metric.empty, mode: metric.mode, values: valuesOf(id), reading: metric.reading, format, tickFormat: format };
    if (id === 'steps') return { ...base, goal: { value: cfg.stepGoal, label: `Objetivo ${fmtInt(cfg.stepGoal)}` } };
    if (id === 'intake') return { ...base, goal: { value: kcalGoal, label: `Objetivo ${fmtInt(kcalGoal)}` } };
    if (id === 'water') {
      return { ...base, goalSeries: { values: slots.map((s) => s.waterGoalMl), ...(waterGoalMean !== null ? { label: `Meta ${fmtInt(waterGoalMean)}` } : {}), reading: 'meta de agua' } };
    }
    if (id === 'weight') {
      return {
        ...base,
        ...(targetKg !== null ? { goal: { value: targetKg, label: `Objetivo ${fmtUpTo1(targetKg)}` } } : {}),
        measured: { at: slots.map((s) => s.weighed), carriedReading: 'kg (último peso)' },
        change: { decimals: 1, unit: 'kg' },
      };
    }
    return base;
  });

  // Editando: los datos son bloques que se mueven, se quitan y se añaden; el dibujo de cada uno es una vista previa con los valores del periodo.
  if (draft !== null) {
    return (
      <JointBlocks
        ids={draft}
        bandOf={(id) => bands.find((band) => band.id === id) ?? { mode: 'bars', values: [], color: jointMetricOf(id).color }}
        onChange={onDraft}
        onAdd={onAdd}
      />
    );
  }
  if (chosen.length === 0) {
    return (
      <div class="hero-card__chart">
        <EmptyState icon="chart-line" title="Ningún dato elegido">
          Pulsa «Elegir qué datos ver» para añadir los que quieras al gráfico.
        </EmptyState>
      </div>
    );
  }
  if (!bands.some((band) => band.values.some((v) => v !== null))) {
    return (
      <div class="hero-card__chart">
        <EmptyState icon="chart-line" title="Sin datos en este periodo">
          Sincroniza el anillo para traer tus pasos, anota lo que comes y registra tu peso.
        </EmptyState>
      </div>
    );
  }

  const has = (id: JointMetricId): boolean => chosen.includes(id);
  const datums: JointDatum[] = slots.map((s) => ({
    key: s.start,
    label: xLabel(s, granularity, slots.length),
    title: periodTitle(s, granularity),
    // Una semana o un mes con pocos días con datos no pesa lo que uno completo: se dice cuántos son.
    ...(granularity !== 'day'
      ? {
          extra: [
            ...(has('steps') ? [{ label: 'días con datos', value: String(s.activityDays) }] : []),
            ...(has('intake') && s.intakeDays > 0 ? [{ label: 'días con comidas', value: String(s.intakeDays) }] : []),
            ...(has('water') && s.waterDays > 0 ? [{ label: 'días con agua', value: String(s.waterDays) }] : []),
          ],
        }
      : {}),
  }));

  // El nombre del gráfico dice lo que enseña: lo que no se ve se lee igual.
  const mean = (id: JointMetricId): number | null => meanPerDay(data.summaries, (d) => jointMetricOf(id).pick?.(d) ?? null, { skipDay: today });
  const parts = chosen.flatMap((id): string[] => {
    const metric = jointMetricOf(id);
    if (id === 'steps') return mean(id) !== null ? [`pasos, media de ${fmtInt(mean(id) as number)} al día`] : [];
    if (id === 'intake') return mean(id) !== null ? [`calorías comidas, media de ${fmtInt(mean(id) as number)} al día frente a ${fmtInt(kcalGoal)} propuestas`] : [];
    if (id === 'water') {
      const water = mean(id);
      return water !== null ? [`agua, media de ${fmtInt(water)} ml al día${waterGoalMean !== null ? ` frente a una meta de ${fmtInt(waterGoalMean)}` : ''}`] : [];
    }
    if (id === 'weight') {
      const kg = slots.flatMap((s) => (s.weightKg === null ? [] : [s.weightKg]));
      return [
        ...(kg.length > 1 ? [`peso, de ${fmt1(kg[0] ?? 0)} a ${fmt1(kg[kg.length - 1] ?? 0)} kg`] : kg.length === 1 ? [`peso, ${fmt1(kg[0] ?? 0)} kg`] : []),
        ...(kg.length > 0 && targetKg !== null ? [`peso objetivo, ${fmtUpTo1(targetKg)} kg`] : []),
      ];
    }
    const values = (bands.find((band) => band.id === id)?.values ?? []).filter((v): v is number => v !== null);
    if (values.length === 0) return [];
    const unit = unitOf(metric.title);
    const format = fmtValue(metric.decimals);
    return [`${plainName(metric.title)}, media de ${format(mean(id) ?? values.reduce((a, b) => a + b, 0) / values.length)}${unit ? ` ${unit}` : ''}`];
  });
  const ariaLabel = `Evolución entre el ${fmtDayShortYear(data.range.from, today)} y el ${fmtDayShortYear(data.range.to, today)}${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`;

  return (
    <div class="hero-card__chart">
      <ChartFrame stale={stale}>
        <JointChart data={datums} bands={bands} ariaLabel={ariaLabel} />
      </ChartFrame>
    </div>
  );
}

/** Leyenda de un gráfico de barras con línea de objetivo (continua) y de media (a trazos). */
function referenceLegend(series: string, color: string, goal: string | null, average: string | null): LegendItem[] {
  return [
    { label: series, color, kind: 'rect' },
    ...(goal ? [{ label: goal, color: 'var(--text-3)', kind: 'line' as const }] : []),
    ...(average ? [{ label: average, color: 'var(--text-3)', kind: 'dash' as const }] : []),
  ];
}

// ───────────────────────────── sueño ─────────────────────────────

function SleepChart({ data, granularity, stale }: { data: EvolutionData; granularity: Granularity; stale: boolean }): JSX.Element {
  const goalH = settings.value.sleepGoalH;
  const points = aggregate(data.summaries, granularity);
  const hours = (p: (typeof points)[number]): number | null => (p.sleepAsleepSec === null ? null : p.sleepAsleepSec / 3600);
  const withData = points.filter((p) => hours(p) !== null);
  const avg = meanPerDay(data.summaries, (d) => (d.sleepAsleepSec === null ? null : d.sleepAsleepSec / 3600));

  const nights = data.summaries.filter((d) => d.sleepBedMin !== null && d.sleepWakeMin !== null && d.sleepAsleepSec !== null);
  const regularity = sleepRegularityOf(nights.map((n) => ({ bedMin: n.sleepBedMin as number, wakeMin: n.sleepWakeMin as number, asleepSec: n.sleepAsleepSec as number })));
  const lastNights = nights.slice(-31);
  // El eje se corta por el rato del día en que nunca se duerme: vale igual para quien duerme de noche que para quien duerme de día.
  const cut = clockCut(lastNights.map((n) => ({ bedMin: n.sleepBedMin as number, wakeMin: n.sleepWakeMin as number })));
  const ranges: RangeDatum[] = lastNights.map((n) => {
    const span = n.sleepBedMin === null || n.sleepWakeMin === null ? null : clockSpan({ bedMin: n.sleepBedMin, wakeMin: n.sleepWakeMin }, cut);
    return {
      key: n.day,
      label: fmtDayShort(n.day),
      title: fmtDayLong(n.day),
      from: span?.from ?? null,
      to: span?.to ?? null,
      rows:
        n.sleepBedMin === null || n.sleepWakeMin === null
          ? []
          : [
              { label: 'Acostarse', value: fmtMinutesOfDay(n.sleepBedMin) },
              { label: 'Despertar', value: fmtMinutesOfDay(n.sleepWakeMin) },
              { label: `${fmtDuration(n.sleepAsleepSec ?? 0)} dormido`, value: '' },
            ],
    };
  });

  const bars: BarDatum[] = points.map((p) => ({
    key: p.start,
    label: xLabel(p, granularity, points.length),
    value: hours(p),
    title: periodTitle(p, granularity),
    ...(granularity !== 'day' ? { extra: [{ label: 'noches con datos', value: String(p.sleepNights) }] } : {}),
  }));

  return (
    <Card label="Sueño">
      <CardHeader icon="Moon" title="Sueño" color="var(--sleep)" right={<Badge kind="ring" />} />
      {withData.length === 0 ? (
        <EmptyState icon="Moon" title="Sin sueño en este periodo">
          Lleva el anillo puesto al dormir y sincroniza por la mañana.
        </EmptyState>
      ) : (
        <>
          <Kpis
            items={[
              ...(avg !== null ? [{ label: 'Media por noche', value: fmtDuration(avg * 3600) }] : []),
              { label: 'Objetivo', value: fmt1(goalH), unit: 'h' },
              ...(granularity === 'day'
                ? [{ label: 'Cumplido', value: `${withData.filter((p) => (hours(p) ?? 0) >= goalH).length}/${withData.length}`, unit: withData.length === 1 ? 'noche' : 'noches' }]
                : []),
            ]}
          />
          <ChartFrame
            title="Horas dormidas"
            stale={stale}
            legend={referenceLegend('Dormido', 'var(--sleep)', `Objetivo ${fmt1(goalH)} h`, avg !== null ? `Media ${fmt1(avg)} h` : null)}
          >
            <BarChart
              data={bars}
              height={200}
              color="var(--sleep)"
              seriesName="Dormido"
              format={(v) => fmtDuration(v * 3600)}
              axisFormat={(v) => `${fmt1(v)}`.replace(',0', '')}
              goal={{ value: goalH, label: `Objetivo ${fmt1(goalH)} h` }}
              {...(avg !== null ? { average: { value: avg, label: `Media ${fmt1(avg)} h` } } : {})}
              ariaLabel={`Horas dormidas, ${plural(withData.length, 'periodo', 'periodos')} con datos${avg !== null ? `, media ${fmt1(avg)} horas` : ''}`}
            />
          </ChartFrame>

          <h3 class="chart__title" style={{ margin: '18px 0 4px' }}>
            Regularidad
          </h3>
          {regularity ? (
            <>
              <Kpis
                items={[
                  { label: 'Te acuestas sobre las', value: fmtMinutesOfDay(regularity.meanBedMin), sub: `±${regularity.sdBedMin} min` },
                  { label: 'Te levantas sobre las', value: fmtMinutesOfDay(regularity.meanWakeMin), sub: `±${regularity.sdWakeMin} min` },
                  { label: 'Regularidad', value: regularity.label },
                ]}
              />
              <ChartFrame
                title="Ventana de sueño por noche"
                subtitle={`Últimas ${ranges.length} noches · cuanto más alineadas las barras, más estable tu horario`}
                stale={stale}
              >
                <RangeChart data={ranges} color="var(--sleep)" axis={clockAxis(cut)} height={210} ariaLabel={`Hora de acostarse y de despertar de las últimas ${ranges.length} noches`} />
              </ChartFrame>
              <p class="field__hint">
                Regularidad = dispersión de las horas de acostarse y levantarse: ≤ 30 min alta, ≤ 60 min media, más baja. Hace falta un mínimo de 4 noches.
              </p>
            </>
          ) : (
            <p class="field__hint">Hacen falta al menos 4 noches con datos en el periodo para medir la regularidad.</p>
          )}
        </>
      )}
    </Card>
  );
}

// ───────────────────────────── pulso ─────────────────────────────

/** El pulso del periodo, con la forma del de sueño: las cifras de arriba y, debajo, una barra por día de su pulso más bajo al más alto. */
function PulseChart({ data, granularity, stale }: { data: EvolutionData; granularity: Granularity; stale: boolean }): JSX.Element {
  const points = aggregate(data.summaries, granularity);
  const withData = points.filter((p) => p.minBpm !== null && p.maxBpm !== null);
  const avg = meanPerDay(data.summaries, (d) => d.avgBpm);
  const resting = meanPerDay(data.summaries, (d) => d.restingBpm);
  const highest = withData.length > 0 ? maxOf(withData.map((p) => p.maxBpm as number)) : null;
  const lowest = withData.length > 0 ? minOf(withData.map((p) => p.minBpm as number)) : null;

  const ranges: RangeDatum[] = points.map((p) => ({
    key: p.start,
    label: xLabel(p, granularity, points.length),
    title: periodTitle(p, granularity),
    from: p.minBpm,
    to: p.maxBpm,
    mark: p.avgBpm,
    rows:
      p.minBpm === null || p.maxBpm === null
        ? []
        : [
            { label: 'Máximo', value: `${p.maxBpm} lpm` },
            { label: 'Mínimo', value: `${p.minBpm} lpm` },
            ...(p.avgBpm !== null ? [{ label: 'Media', value: `${Math.round(p.avgBpm)} lpm` }] : []),
            ...(granularity !== 'day' ? [{ label: 'días con lecturas', value: String(p.heartDays) }] : []),
          ],
  }));

  return (
    <Card label="Pulso">
      <CardHeader icon="HeartPulse" title="Pulso" color="var(--heart)" right={<Badge kind="ring" />} />
      {withData.length === 0 ? (
        <EmptyState icon="HeartPulse" title="Sin pulso en este periodo">
          Sincroniza el anillo para traer sus lecturas.
        </EmptyState>
      ) : (
        <>
          <Kpis
            items={[
              ...(avg !== null ? [{ label: 'Media', value: String(Math.round(avg)), unit: 'lpm' }] : []),
              ...(resting !== null ? [{ label: 'Reposo', value: String(Math.round(resting)), unit: 'lpm' }] : []),
              ...(highest !== null ? [{ label: 'Máximo', value: String(highest), unit: 'lpm' }] : []),
            ]}
          />
          <ChartFrame
            title={granularity === 'day' ? 'Pulso por día' : granularity === 'week' ? 'Pulso por semana' : 'Pulso por mes'}
            subtitle="Cada barra va del pulso más bajo al más alto; la marca clara es la media."
            stale={stale}
          >
            <RangeChart
              data={ranges}
              color="var(--heart)"
              axis={valueAxis('Pulso', 20)}
              height={200}
              ariaLabel={`Pulso mínimo y máximo, ${plural(withData.length, 'periodo', 'periodos')} con datos${lowest !== null && highest !== null ? `: de ${lowest} a ${highest} lpm` : ''}${avg !== null ? `, media ${Math.round(avg)} lpm` : ''}`}
            />
          </ChartFrame>
        </>
      )}
    </Card>
  );
}

// ───────────────────────────── oxígeno en sangre ─────────────────────────────

function Spo2Chart({ data, granularity, stale }: { data: EvolutionData; granularity: Granularity; stale: boolean }): JSX.Element | null {
  const points = aggregate(data.summaries, granularity);
  const withData = points.filter((p) => p.spo2Avg !== null);
  if (withData.length === 0) return null; // sin lecturas no se ocupa espacio con un gráfico vacío
  const fromMs = startOfDayMs(data.range.from);
  const toMs = endOfDayMs(data.range.to);
  const mins = data.summaries.map((d) => d.spo2Min).filter((v): v is number => v !== null);
  // El eje se ajusta a lo dibujado (las medias), con un par de puntos de margen y siempre hasta 100 %.
  const low = Math.min(...withData.map((p) => p.spo2Avg as number));

  return (
    <Card label="Oxígeno en sangre">
      <CardHeader icon="Activity" title="Oxígeno en sangre (SpO₂)" color="var(--spo2)" right={<Badge kind="ring" />} />
      <Kpis
        items={[
          { label: 'Media', value: fmt1(meanPerDay(data.summaries, (d) => d.spo2Avg) ?? 0), unit: '%' },
          ...(mins.length > 0 ? [{ label: 'Mínimo', value: String(Math.min(...mins)), unit: '%' }] : []),
        ]}
      />
      <ChartFrame
        title="SpO₂ media diaria"
        stale={stale}
      >
        <LineChart
          series={[{ key: 's', label: 'SpO₂ media', color: 'var(--spo2)', points: points.map((p) => ({ x: pointX(p, fromMs), y: p.spo2Avg })) }]}
          xDomain={[fromMs, toMs]}
          xTicks={timeTicks(fromMs, toMs, 4)}
          format={(v) => `${fmt1(v)}\u00a0%`}
          axisFormat={(v) => `${Math.round(v)}`}
          yDomain={[Math.max(70, Math.floor(low) - 2), 100]}
          tooltipTitle={(x) => fmtDayLong(dayKeyOf(x))}
          ariaLabel={`Oxígeno en sangre medio, ${plural(withData.length, 'periodo', 'periodos')} con datos`}
          height={170}
        />
      </ChartFrame>
      <p class="field__hint">Lecturas del anillo, sobre todo nocturnas. Es una medida orientativa, no médica.</p>
    </Card>
  );
}
