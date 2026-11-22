import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { saveSleepCorrection } from '../../app/sleep-fix';
import { svc } from '../../app/services';
import { clockOf } from '../../domain/sleep-correction';
import type { DayBundle } from '../../app/queries';
import { measureSheetOpen, settings, summaryPanel } from '../../app/state';
import { MIN_SAMPLES_FOR_CURVE, type HeartDay } from '../../domain/heart';
import { nightFacts, type SleepDay } from '../../domain/sleep';
import type { BacktestSummary } from '../../domain/sleep-estimate';
import { Hypnogram, STAGE_COLOR, STAGE_LABEL, type HypnoSegment } from '../charts/Hypnogram';
import { fmt2, fmtClock, fmtDuration, NBSP } from '../format';
import { Icon } from '../icons';
import { Banner, EmptyState, ProgressBar, Stat } from '../primitives';
import { Sheet } from '../Sheet';
import { PhoneActivityAccess } from '../user/PhoneActivityAccess';
import { BigDuration, DayCaption, HeartCurve } from './parts';
import { analyzeSleep } from './sleep-analysis';

const close = (): void => {
  summaryPanel.value = null;
};

// ───────────────────────────── sueño ─────────────────────────────

export function SleepSheet({ bundle }: { bundle: DayBundle }): JSX.Element {
  const open = summaryPanel.value === 'sleep';
  return (
    <Sheet open={open} onClose={close} title="Sueño">
      {open && <SleepDetail bundle={bundle} />}
    </Sheet>
  );
}

/** Las tres fases con tiempo propio, en el orden de la leyenda de Smart Health: profundo, ligero y REM. */
const STAGE_ORDER = ['deep', 'light', 'rem'] as const;

function SleepDetail({ bundle }: { bundle: DayBundle }): JSX.Element {
  const sleep: SleepDay | null = bundle.sleep;
  const night = sleep?.night ?? null;
  const goalH = settings.value.sleepGoalH;
  if (!sleep || !night) {
    const naps = sleep?.naps ?? [];
    return (
      <div>
        <DayCaption day={bundle.day} />
        {naps.length === 0 && (
          <EmptyState icon="Moon" title="Sin sueño registrado">
            Lleva el anillo puesto al dormir y sincroniza al despertar. La noche se asigna al día en que te levantas.
          </EmptyState>
        )}
        <NapsList naps={naps} />
      </div>
    );
  }
  const fraction = night.asleepSec / (goalH * 3600);
  const facts = nightFacts(night);
  const analysis = analyzeSleep(night, goalH);
  const secondsOf = { deep: night.deepSec, light: night.lightSec, rem: night.remSec } as const;
  return (
    <div>
      <DayCaption day={bundle.day} />

      <dl class="sleep-facts">
        <div>
          <dt>Duración del sueño</dt>
          <dd class="sleep-facts__value">
            <BigDuration seconds={night.asleepSec} />
          </dd>
          <dd class="sleep-facts__note">
            {Math.round(fraction * 100)}
            {NBSP}% de tu objetivo de {fmt2(goalH)}
            {NBSP}h
          </dd>
          {!night.hasStages && (
            <dd class="sleep-facts__note">
              de {fmtClock(night.startMs)} a {fmtClock(night.endMs)}
            </dd>
          )}
        </div>
        {facts && (
          <div>
            <dt>Número de despertares</dt>
            <dd class="sleep-facts__value">{facts.wakeUps}</dd>
          </div>
        )}
      </dl>
      <ProgressBar value={fraction} color="var(--sleep)" label={`Sueño frente al objetivo de ${fmt2(goalH)} h`} />

      {analysis && (
        <section class={`analysis analysis--${analysis.tone}`} aria-label="Análisis del sueño">
          <h3 class="detail-title">
            <Icon name={analysis.tone === 'good' ? 'Check' : 'Info'} size={17} />
            Análisis del sueño
          </h3>
          <p>{analysis.text}</p>
        </section>
      )}

      {night.hasStages ? (
        <section aria-label="Fases del sueño">
          <h3 class="detail-title">Fases del sueño</h3>
          <Hypnogram
            segments={night.segments.filter((s): s is HypnoSegment => s.stage !== 'nap')}
            startMs={night.startMs}
            endMs={night.endMs}
            ariaLabel={`Fases del sueño de ${fmtClock(night.startMs)} a ${fmtClock(night.endMs)}: profundo ${fmtDuration(night.deepSec)}, ligero ${fmtDuration(night.lightSec)}, REM ${fmtDuration(night.remSec)}`}
          />
          <ul class="stage-totals" aria-label="Fases de la noche">
            {STAGE_ORDER.map((stage) => (
              <li key={stage}>
                <span class="stage-total__value">
                  <BigDuration seconds={secondsOf[stage]} />
                </span>
                <span class="stage-total__name">
                  <span class="stage-total__dot" style={{ background: STAGE_COLOR[stage] }} aria-hidden="true" />
                  {STAGE_LABEL[stage]}
                </span>
                <span class="stage-total__pct">{night.asleepSec > 0 ? Math.round((secondsOf[stage] / night.asleepSec) * 100) : 0}{NBSP}%</span>
              </li>
            ))}
          </ul>
          {night.awakeSec > 0 && (
            <p class="stage-awake">
              <span class="stage-total__dot" style={{ background: STAGE_COLOR.awake }} aria-hidden="true" />
              Despierto: {fmtDuration(night.awakeSec)}
            </p>
          )}
        </section>
      ) : (
        // Una noche estimada no lleva gráfico ni fases (no las hay): solo el aviso de que es una aproximación y la forma de corregirla.
        <>
          <Banner>
            {night.estimated
              ? 'El anillo no guardó esta noche: la app la ha estimado a partir de los pasos y el pulso del anillo o, si no lo llevabas puesto, de cuándo dejó de haber actividad por la noche y cuándo volvió. Es una aproximación: las horas pueden variar en torno a una hora y no hay fases del sueño.'
              : night.manual
                ? 'Las horas de esta noche las pusiste tú. No hay fases del sueño.'
                : 'El anillo ha dado la duración de la noche, pero no las fases del sueño (profundo, ligero y REM).'}
          </Banner>
          {night.estimated && <EstimateAccuracy />}
          {night.estimated && <PhoneActivityAccess compact />}
          {(night.estimated || night.manual) && <FixNight startMs={night.startMs} endMs={night.endMs} />}
        </>
      )}

      <NapsList naps={sleep.naps} />
    </div>
  );
}

/** Menos noches que estas conocidas y la mediana no dice nada: no se enseña. */
const MIN_NIGHTS_TO_SHOW = 3;

/**
 * Cuánto se equivoca la estimación CON LOS DATOS DE ESTA PERSONA: en las noches que sí guardó el anillo o que corrigió a mano, qué habría estimado la app sin saberlas.
 * Es la única cifra de acierto que no es de un simulador. No se enseña si hay menos de tres noches con las que comparar.
 */
function EstimateAccuracy(): JSX.Element | null {
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  useEffect(() => {
    let alive = true;
    const { store, now } = svc();
    store
      .sleepAccuracy(now())
      .then((found) => {
        if (alive) setSummary(found);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!summary || summary.nights < MIN_NIGHTS_TO_SHOW) return null;
  return (
    <p class="sleep-accuracy">
      En tus {summary.nights} noches que guardó el anillo o que corregiste, esta estimación (sin saberlas) se habría equivocado, de mediana, {summary.startMin}
      {NBSP}min al acostarte y {summary.endMin}
      {NBSP}min al levantarte. Cada noche que corriges a mano la ajusta mejor a ti.
    </p>
  );
}

/** Corregir las horas de una noche estimada (o ya corregida): un botón que abre dos campos de hora con las actuales y «Guardar». Rápido y sin más pantallas. */
function FixNight({ startMs, endMs }: { startMs: number; endMs: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [bed, setBed] = useState(clockOf(startMs));
  const [wake, setWake] = useState(clockOf(endMs));
  if (!open) {
    return (
      <button type="button" class="btn btn--block" style={{ marginTop: '12px' }} onClick={() => setOpen(true)}>
        <Icon name="PenLine" size={18} />
        Corregir las horas
      </button>
    );
  }
  return (
    <form
      class="sleep-fix"
      aria-label="Corregir las horas de la noche"
      onSubmit={(e) => {
        e.preventDefault();
        void saveSleepCorrection(endMs, bed, wake).then((saved) => {
          if (saved) setOpen(false);
        });
      }}
    >
      <div class="sleep-fix__row">
        <div class="field">
          <label for="sleep-fix-bed">Me acosté a las</label>
          <input id="sleep-fix-bed" class="input" type="time" value={bed} required onInput={(e) => setBed(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="sleep-fix-wake">Me levanté a las</label>
          <input id="sleep-fix-wake" class="input" type="time" value={wake} required onInput={(e) => setWake(e.currentTarget.value)} />
        </div>
      </div>
      <div class="sleep-fix__actions">
        <button type="submit" class="btn btn--primary">
          Guardar
        </button>
        <button type="button" class="btn btn--ghost" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** Las siestas del día (el sueño que no llega a ser el principal). */
function NapsList({ naps }: { naps: SleepDay['naps'] }): JSX.Element | null {
  if (naps.length === 0) return null;
  return (
    <>
      <h3 class="detail-title">Siestas</h3>
      <div class="chips">
        {naps.map((n) => (
          <span class="chip" key={n.startMs}>
            <Icon name="Moon" size={14} />
            <strong>
              {fmtClock(n.startMs)} – {fmtClock(n.endMs)}
            </strong>{' '}
            ({fmtDuration(n.durationSec)})
          </span>
        ))}
      </div>
    </>
  );
}

// ───────────────────────────── ritmo cardiaco ─────────────────────────────

export function HeartSheet({ bundle, stale }: { bundle: DayBundle; stale: boolean }): JSX.Element {
  const open = summaryPanel.value === 'heart';
  return (
    <Sheet open={open} onClose={close} title="Ritmo cardiaco">
      {open && <HeartDetail heart={bundle.heart} day={bundle.day} stale={stale} />}
    </Sheet>
  );
}

function HeartDetail({ heart, day, stale }: { heart: HeartDay | null; day: string; stale: boolean }): JSX.Element {
  const interval = settings.value.heartIntervalMin;
  return (
    <div>
      <DayCaption day={day} />
      {!heart ? (
        <EmptyState icon="HeartPulse" title="Sin lecturas de pulso">
          Sincroniza el anillo para traerlas o mide ahora.
        </EmptyState>
      ) : (
        <>
          <div class="tile tile--plain">
            <div class="tile__value">
              {heart.last.bpm}
              <small>lpm</small>
            </div>
            <div class="tile__sub">última lectura a las {fmtClock(heart.last.tsMs)}</div>
          </div>
          <div class="minmax">
            <Stat label="Mínimo" value={String(heart.minBpm)} />
            <Stat label="Media" value={String(heart.avgBpm)} />
            <Stat label="Máximo" value={String(heart.maxBpm)} />
            <Stat label="Reposo" value={heart.restingBpm === null ? '—' : String(heart.restingBpm)} />
          </div>
          {heart.count >= MIN_SAMPLES_FOR_CURVE ? (
            <HeartCurve heart={heart} stale={stale} />
          ) : (
            <>
              <p class="field__hint">Hay pocas lecturas ({heart.count}) para dibujar la evolución del día.</p>
              <ul class="readings">
                {heart.samples.map((s) => (
                  <li key={s.tsMs}>
                    <span>{fmtClock(s.tsMs)}</span>
                    <strong>{s.bpm} lpm</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <p class="field__hint" style={{ margin: '14px 0 12px' }}>
        El anillo mide por su cuenta cada {interval} min. Puedes cambiarlo en el menú de tu perfil, en «Objetivos y medición».
      </p>
      <button type="button" class="btn btn--primary btn--block" onClick={() => (measureSheetOpen.value = true)}>
        <Icon name="HeartPulse" size={18} />
        Medir ahora
      </button>
    </div>
  );
}
