import type { JSX } from 'preact';
import { todayKey } from '../../app/state';
import { atHourMs, dayWindow, type DayKey } from '../../domain/dates';
import type { HeartDay } from '../../domain/heart';
import { ChartFrame } from '../charts/ChartFrame';
import { LineChart } from '../charts/LineChart';
import { fmtClock, fmtDayLong, fmtDayTitle } from '../format';

/** El día de una hoja de detalle: «Hoy · martes, 13 de octubre» (o solo la fecha, si no es hoy ni ayer). */
export function DayCaption({ day }: { day: DayKey }): JSX.Element {
  const title = fmtDayTitle(day, todayKey.value);
  const text = title === 'Hoy' || title === 'Ayer' ? `${title} · ${fmtDayLong(day)}` : title.replace(/^./, (c) => c.toUpperCase());
  return <p class="sheet__day">{text}</p>;
}

/** Una duración grande, con las unidades pequeñas: «7 h 12 min». */
export function BigDuration({ seconds }: { seconds: number }): JSX.Element {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return (
    <>
      {h > 0 && (
        <>
          {h}
          <small>h</small>{' '}
        </>
      )}
      {m}
      <small>min</small>
    </>
  );
}

/** Evolución del pulso a lo largo del día (de 00:00 a 24:00). */
export function HeartCurve({ heart, stale }: { heart: HeartDay; stale: boolean }): JSX.Element {
  const { startMs: start, endMs: end } = dayWindow(heart.day, 0);
  // Cada seis horas desde la medianoche.
  const hourTick = (h: number) => ({ x: atHourMs(heart.day, h), label: String(h % 24).padStart(2, '0') });
  return (
    <ChartFrame title="Evolución del día" stale={stale}>
      <LineChart
        series={[{ key: 'hr', label: 'Pulso', color: 'var(--heart)', points: heart.samples.map((s) => ({ x: s.tsMs, y: s.bpm })) }]}
        xDomain={[start, end]}
        xTicks={[0, 6, 12, 18].map(hourTick)}
        format={(v) => `${Math.round(v)} lpm`}
        axisFormat={(v) => String(Math.round(v))}
        tooltipTitle={(x) => fmtClock(x)}
        ariaLabel={`Pulso a lo largo del día: mínimo ${heart.minBpm}, máximo ${heart.maxBpm} lpm`}
        height={130}
      />
    </ChartFrame>
  );
}
