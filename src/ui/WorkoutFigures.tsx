import type { JSX } from 'preact';
import { endOfDayMs } from '../domain/dates';
import { sportById } from '../domain/sports';
import { MIN_IDLE_TO_REPORT_MS, type WorkoutEstimate, type WorkoutRecord } from '../domain/workout';
import { LineChart } from './charts/LineChart';
import { ChartFrame } from './charts/ChartFrame';
import { fmt1, fmtClock, fmtDistance, fmtDuration, fmtInt } from './format';
import { KCAL_METHOD_LABEL } from './labels';
import { RouteMap } from './nav/RouteMap';
import { Stat } from './primitives';

/** Cifras de un entrenamiento (en el resumen tras terminar y en el detalle). Cada una con su procedencia. */
export function WorkoutFigures({ estimate: e }: { estimate: WorkoutEstimate }): JSX.Element {
  const distance = e.distanceM === null ? null : fmtDistance(e.distanceM);
  return (
    <div class="wk-grid">
      <Stat label="Duración" value={fmtDuration(e.activeMs / 1000)} />
      <Stat
        label="Distancia"
        value={distance ? distance.value : '—'}
        unit={distance?.unit}
        color="var(--distance)"
        {...(e.distanceProvenance ? { badge: e.distanceProvenance } : {})}
        {...(distance ? {} : { hint: 'No registrada' })}
      />
      <Stat label="Calorías activas" value={fmtInt(e.kcal)} unit="kcal" color="var(--kcal)" badge={e.kcalProvenance} hint={KCAL_METHOD_LABEL[e.kcalMethod]} />
      {e.idleMs >= MIN_IDLE_TO_REPORT_MS && <Stat label="Sin actividad" value={fmtDuration(e.idleMs / 1000)} hint="Parado o sin esfuerzo: no suma calorías de ejercicio" />}
      {e.avgSpeedKmh !== null && <Stat label="Velocidad media" value={fmt1(e.avgSpeedKmh)} unit="km/h" />}
      {e.steps !== null && <Stat label="Pasos" value={fmtInt(e.steps)} badge="ring" />}
      {e.ascentM !== null && <Stat label="Desnivel subido" value={fmtInt(e.ascentM)} unit="m" badge="phone" />}
      {e.avgBpm !== null && <Stat label="Pulso medio" value={String(e.avgBpm)} unit="lpm" color="var(--heart)" badge="ring" />}
      {e.maxBpm !== null && <Stat label="Pulso máximo" value={String(e.maxBpm)} unit="lpm" color="var(--heart)" badge="ring" />}
    </div>
  );
}

export function WorkoutHrChart({ record }: { record: WorkoutRecord }): JSX.Element | null {
  const hr = record.hr ?? [];
  if (hr.length < 4) return null;
  const start = record.startMs;
  const end = Math.min(record.endMs, endOfDayMs('9999-12-31'));
  const span = end - start;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: start + span * f, label: fmtClock(start + span * f) }));
  return (
    <ChartFrame title="Pulso durante el entrenamiento">
      <LineChart
        series={[{ key: 'hr', label: 'Pulso', color: 'var(--heart)', points: hr.map(([t, b]) => ({ x: t, y: b })), markers: false }]}
        xDomain={[start, end]}
        xTicks={ticks}
        format={(v) => `${Math.round(v)} lpm`}
        axisFormat={(v) => String(Math.round(v))}
        tooltipTitle={(x) => fmtClock(x)}
        ariaLabel={`Pulso durante ${sportById(record.sport).name}`}
        height={120}
      />
    </ChartFrame>
  );
}

/** El recorrido hecho (si el entreno lo grabó con el GPS), sobre el mapa de la zona si está guardado. Va junto a la gráfica de pulso, en la revisión y en el detalle. */
export function WorkoutRouteMap({ record }: { record: WorkoutRecord }): JSX.Element | null {
  const route = record.route;
  if (!route || route.length < 2) return null;
  return (
    <ChartFrame title="Recorrido">
      <RouteMap route={route} label={`Recorrido de ${sportById(record.sport).name}`} />
    </ChartFrame>
  );
}
