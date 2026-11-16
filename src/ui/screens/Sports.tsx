import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hasRing } from '../../app/devices';
import { loadHistory, type HistoryItem } from '../../app/queries';
import { activeWorkout, bumpData, detailWorkoutId, liveSport, manualWorkoutOpen, nowMs, profileHistory, readySport, ring, ringCapabilities, ringSheetOpen } from '../../app/state';
import { dayKeyOf, type DayKey } from '../../domain/dates';
import { reachesToday, shiftPeriod, type HistoryPeriod } from '../../domain/periods';
import { SPORTS, sportById, sportSupport } from '../../domain/sports';
import { useAsync } from '../hooks';
import { Icon } from '../icons';
import { sportBackground } from '../sport-style';
import { fmtClock, fmtDayShortYear, fmtDistance, fmtDuration, fmtInt, fmtKm, fmtPeriod, plural } from '../format';
import { Badge, Banner, Card, CardHeader, EmptyState, LoadError, Segmented } from '../primitives';

export function SportsScreen(): JSX.Element {
  const live = liveSport.value;
  const caps = ringCapabilities.value;
  return (
    <div>
      {live !== null && (
        <Banner tone="warn">
          Hay un entrenamiento en curso ({sportById(live).name}). La pantalla de seguimiento está abierta.
        </Banner>
      )}
      {hasRing.value && <RingSupportNote caps={caps} linked={ring.value !== null} />}

      <section class="hero-card" aria-label="Elegir actividad">
        <header class="hero-card__head">
          <span class="hero-card__icon">
            <Icon name="SportShoe" size={18} />
          </span>
          <h2>Elige una actividad</h2>
        </header>
        <div class={`sports-grid${hasRing.value ? '' : ' sports-grid--solo'}`}>
          {SPORTS.filter((sport) => hasRing.value || sport.id === 'walk').map((sport) => {
            // Sin anillo solo se puede entrenar andando (medido con el móvil): lo demás no sale; con el interruptor del anillo encendido vuelve todo.
            const support = sportSupport(sport, caps);
            return (
              <button
                type="button"
                class="sport"
                key={sport.id}
                onClick={() => (readySport.value = sport.id)}
                disabled={live !== null || activeWorkout.value !== null || (hasRing.value && !support.ringUseful)}
                title={support.ringUseful || !hasRing.value ? undefined : 'Tu anillo no aporta datos en directo para esta actividad: añádela a mano.'}
              >
                <span class="sport__icon">
                  <Icon name={sport.icon} size={26} />
                </span>
                <span class="sport__name">{sport.name}</span>
              </button>
            );
          })}
          {/* El aviso va a la derecha de la única actividad (debajo dejaba la zona vacía) y en corto. */}
          {!hasRing.value && <p class="locked-note">Sin anillo solo se puede andar (con el GPS del móvil). El resto de deportes, el pulso y las kcal precisas necesitan anillo.</p>}
        </div>
      </section>

      <Card class="manual-card">
        <div class="manual-card__row">
          <span class="manual-card__icon">
            <Icon name="Pencil" size={18} />
          </span>
          <div class="manual-card__text">
            <strong>¿Hiciste deporte sin el anillo?</strong>
            <p class="field__hint">Añádelo a mano y contará en tus totales del día.</p>
          </div>
          <button type="button" class="manual-card__add" aria-label="Añadir entrenamiento a mano" onClick={() => (manualWorkoutOpen.value = true)}>
            <Icon name="Plus" size={22} />
          </button>
        </div>
      </Card>

      <History />
    </div>
  );
}

/** Lo que el anillo ofrece en directo: de ello dependen los deportes y los datos que se ofrecen. */
function RingSupportNote({ caps, linked }: { caps: ReadonlySet<string> | null; linked: boolean }): JSX.Element | null {
  if (caps === null) {
    return (
      <Banner
        action={
          <button type="button" class="linkish" onClick={() => (ringSheetOpen.value = true)}>
            Abrir
          </button>
        }
      >
        {linked ? 'Sincroniza una vez para que la app sepa qué datos en directo ofrece tu anillo.' : 'Vincula tu anillo para ajustar los deportes a lo que mide.'} Mientras tanto se ofrecen todos.
      </Banner>
    );
  }
  const heart = caps.has('heartRate');
  const steps = caps.has('steps');
  if (heart && steps) return null;
  if (!heart && !steps) {
    return <Banner tone="warn">Tu anillo no ofrece pulso ni pasos en directo, así que los deportes solo pueden añadirse a mano.</Banner>;
  }
  return (
    <Banner>
      {!heart
        ? 'Tu anillo no ofrece medida de pulso: en directo solo se miden los deportes a pie (con pasos), sin pulso ni zonas. El resto puede añadirse a mano.'
        : 'Tu anillo no ofrece pasos en directo: en los deportes a pie la distancia saldrá del GPS o la escribirás tú.'}
    </Banner>
  );
}

// ───────────────────────────── historial ─────────────────────────────

const PERIODS: ReadonlyArray<{ value: HistoryPeriod; label: string }> = [
  { value: 'day', label: 'Día' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'all', label: 'Todos' },
];

const EMPTY_TEXT: Record<Exclude<HistoryPeriod, 'all'>, string> = {
  day: 'No hay entrenamientos este día.',
  week: 'No hay entrenamientos esta semana.',
  month: 'No hay entrenamientos este mes.',
};

/** Cuántos entrenos se traen de una vez con «Todos»; «Ver más» trae otros tantos. */
const PAGE = 20;

/**
 * Entrenamientos guardados, con un filtro: los de un día, una semana o un mes (con flechas para ir a los anteriores) o todos,
 * de más recientes a más antiguos. Parte del día de hoy.
 */
function History(): JSX.Element {
  const profile = profileHistory.value;
  const today = dayKeyOf(nowMs.value);
  const [period, setPeriod] = useState<HistoryPeriod>('all');
  const [anchor, setAnchor] = useState<DayKey>(today);
  const [limit, setLimit] = useState(PAGE);
  const card = useRef<HTMLDivElement>(null);
  // A qué entreno pasa el foco cuando llegan los que trae «Ver más» (si no, al agotarse el botón el foco se perdería).
  const focusFrom = useRef<number | null>(null);

  // El periodo al que pertenece lo que se enseña. Cambia con el filtro y las flechas, no con «Ver más»: mientras llega el
  // periodo nuevo no se enseñan las filas y las sumas del anterior bajo el rótulo nuevo.
  const key = `${period}|${anchor}`;
  const { data, error } = useAsync(async () => ({ key, page: await loadHistory(period, anchor, profile, limit) }), [period, anchor, profile, limit]);
  const fresh = data !== undefined && data.key === key ? data.page : undefined;

  useEffect(() => {
    if (fresh === undefined || focusFrom.current === null) return;
    card.current?.querySelectorAll<HTMLButtonElement>('ul.wk-list > li > button')[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [fresh]);

  const change = (next: HistoryPeriod): void => {
    setPeriod(next);
    setLimit(PAGE);
    // Al elegir un periodo se parte de hoy: «el día» y «la semana» que se esperan son los de ahora.
    setAnchor(today);
  };
  const shown = period === 'all' ? null : fmtPeriod(period, anchor, today);

  return (
    <Card label="Entrenamientos">
      <CardHeader icon="Timer" title="Entrenamientos" color="var(--brand)" />
      <Segmented label="Periodo del historial" options={PERIODS} value={period} onChange={change} block />

      {shown && period !== 'all' && (
        <div class="period-nav" role="group" aria-label="Periodo">
          <button type="button" class="icon-btn" aria-label="Periodo anterior" onClick={() => setAnchor(shiftPeriod(period, anchor, -1))}>
            <Icon name="ChevronLeft" size={22} />
          </button>
          <div class="period-nav__label" aria-live="polite">
            <strong>{shown.title}</strong>
            <small>{shown.subtitle}</small>
          </div>
          <button type="button" class="icon-btn" aria-label="Periodo siguiente" disabled={reachesToday(period, anchor, today)} onClick={() => setAnchor(shiftPeriod(period, anchor, 1))}>
            <Icon name="ChevronRight" size={22} />
          </button>
        </div>
      )}

      <div ref={card}>
        {fresh ? (
          <>
            {fresh.items.length > 0 && (
              <p class="sr-only" role="status">
                {plural(fresh.items.length, 'entrenamiento', 'entrenamientos')}
                {fresh.more ? ' o más' : ''}
              </p>
            )}
            {period !== 'all' && fresh.items.length > 0 && <Totals items={fresh.items} />}
            {fresh.items.length === 0 ? <Empty period={period} /> : <WorkoutList items={fresh.items} showDate={period !== 'day'} today={today} />}
            {fresh.more && (
              <button
                type="button"
                class="btn btn--block btn--ghost"
                style={{ marginTop: '10px' }}
                onClick={() => {
                  focusFrom.current = fresh.items.length;
                  setLimit(limit + PAGE);
                }}
              >
                Ver más
              </button>
            )}
          </>
        ) : error ? (
          <LoadError error={error} onRetry={bumpData} />
        ) : (
          <p class="sync-note">Cargando…</p>
        )}
      </div>
    </Card>
  );
}

function Empty({ period }: { period: HistoryPeriod }): JSX.Element {
  if (period === 'all') {
    return (
      <div role="status">
        <EmptyState icon="SportShoe" title="Aún no hay entrenamientos">
          Elige una actividad arriba. El anillo medirá tu pulso en directo y, al terminar, se sumará a tu actividad del día sin duplicar los pasos.
        </EmptyState>
      </div>
    );
  }
  return (
    <div role="status">
      <EmptyState icon="SportShoe" title="Sin entrenamientos">
        {EMPTY_TEXT[period]} Prueba con otro periodo, con «Todos» o añade uno a mano.
      </EmptyState>
    </div>
  );
}

/** Lo que suman los entrenos del periodo: cuántos, cuánto tiempo, calorías y distancia (solo de los que la tienen). */
function Totals({ items }: { items: readonly HistoryItem[] }): JSX.Element {
  const ms = items.reduce((sum, i) => sum + i.estimate.activeMs, 0);
  const kcal = items.reduce((sum, i) => sum + i.estimate.kcal, 0);
  const meters = items.reduce((sum, i) => sum + (i.estimate.distanceM ?? 0), 0);
  return (
    <dl class="history-totals">
      <div>
        <dt>{items.length === 1 ? 'entreno' : 'entrenos'}</dt>
        <dd>{items.length}</dd>
      </div>
      <div>
        <dt>tiempo</dt>
        <dd>{fmtDuration(ms / 1000)}</dd>
      </div>
      <div>
        <dt>kcal</dt>
        <dd>{fmtInt(kcal)}</dd>
      </div>
      <div>
        <dt>km</dt>
        <dd>{meters > 0 ? fmtKm(meters) : '—'}</dd>
      </div>
    </dl>
  );
}

function WorkoutList({ items, showDate, today }: { items: readonly HistoryItem[]; showDate: boolean; today: DayKey }): JSX.Element {
  return (
    <ul class="wk-list">
      {items.map(({ record, estimate }) => {
        const sport = sportById(record.sport);
        const distance = estimate.distanceM === null ? null : fmtDistance(estimate.distanceM);
        return (
          <li key={record.id}>
            <button type="button" class="wk-row" onClick={() => (detailWorkoutId.value = record.id)}>
              <span class="wk-row__icon" style={{ background: sportBackground(sport.id) }}>
                <Icon name={sport.icon} size={20} />
              </span>
              <span class="wk-row__main">
                <strong>{sport.name}</strong>
                <span class="wk-row__sub">
                  {showDate ? `${fmtDayShortYear(estimate.day, today)} · ` : ''}
                  {fmtClock(record.startMs)} · {fmtDuration(estimate.activeMs / 1000)}
                  {record.source === 'manual' && <Badge kind="manual" compact />}
                </span>
              </span>
              <span class="wk-row__nums">
                <strong>{fmtInt(estimate.kcal)} kcal</strong>
                {distance && (
                  <span>
                    {distance.value} {distance.unit}
                  </span>
                )}
              </span>
              <Icon name="ChevronRight" size={18} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
