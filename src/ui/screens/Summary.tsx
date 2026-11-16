import type { JSX } from 'preact';
import { hasRing } from '../../app/devices';
import { targetOptions } from '../../app/personal';
import { loadDayBundle } from '../../app/queries';
import { bumpData, lastSync, nowMs, profileHistory, profileSheetOpen, ring, ringSheetOpen, selectedDay, settings, summaryPanel, todayKey, type SummaryPanel } from '../../app/state';
import { dayKeyOf, type DayKey } from '../../domain/dates';
import { exerciseWater, waterGoalMl, type WaterEntry } from '../../domain/hydration';
import type { MealEntry } from '../../domain/nutrition';
import { activityParts, type ActivityPart } from '../../domain/breakdown';
import { nutritionTargets } from '../../domain/nutrition';
import { resolveProfile } from '../../domain/summary';
import { SelfTestEntry } from '../../selftest/SelfTestSheet';
import { useAsync } from '../hooks';
import { Icon } from '../icons';
import { Banner, Card, CardHeader, EmptyState, LoadError, MoreButton, ProgressBar, TapCard } from '../primitives';
import { HeroRing } from '../charts/HeroRing';
import { fmt2, fmtAgo, fmtClock, fmtInt, fmtKm } from '../format';
import { partIcon } from '../sport-style';
import { HeartMark, MoonMark } from '../watermarks';
import { HeartSheet, SleepSheet } from '../summary/DetailSheets';
import { NutritionCard } from '../summary/NutritionCard';
import { BigDuration } from '../summary/parts';
import type { DayActivity } from '../../domain/activity';
import type { HeartDay } from '../../domain/heart';
import type { SleepDay } from '../../domain/sleep';

const open = (panel: SummaryPanel) => (): void => {
  summaryPanel.value = panel;
};

export function SummaryScreen(): JSX.Element {
  const day = selectedDay.value;
  const history = profileHistory.value;
  // La actividad del día en curso depende del "ahora" (metabolismo basal); se recalcula cada 5 min.
  const minuteBucket = Math.floor(nowMs.value / 300_000);
  const { data, loading, error } = useAsync(() => loadDayBundle(day, nowMs.peek(), history), [day, history, minuteBucket]);
  const stale = loading && data !== undefined;

  return (
    <div class={stale ? 'is-stale' : undefined} data-day={data?.day}>
      <SelfTestEntry />
      <SyncBanner day={day} />
      {data?.activity.profileIsGeneric && (
        <Banner
          tone="warn"
          action={
            <button type="button" class="linkish" onClick={() => (profileSheetOpen.value = true)}>
              Completar
            </button>
          }
        >
          Completa tu perfil para afinar la distancia y las calorías.
        </Banner>
      )}
      {data ? (
        <>
          <ActivityCard activity={data.activity} />
          <NutritionSection day={data.day} meals={data.meals} water={data.water} sleep={data.sleep} activity={data.activity} />
          {/* Sin anillo no hay pulso ni sueño: las dos tarjetas no salen (con el interruptor del anillo encendido vuelven). */}
          {hasRing.value && (
            <>
              <HeartCard heart={data.heart} />
              <SleepCard sleep={data.sleep} />
              <SleepSheet bundle={data} />
              <HeartSheet bundle={data} stale={stale} />
            </>
          )}
        </>
      ) : error ? (
        <LoadError error={error} onRetry={bumpData} />
      ) : (
        <p class="sync-note" aria-live="polite">
          Cargando…
        </p>
      )}
    </div>
  );
}

// ───────────────────────────── aviso de sincronización ─────────────────────────────

const STALE_AFTER_MS = 6 * 3_600_000;

function SyncBanner({ day }: { day: string }): JSX.Element | null {
  const now = nowMs.value;
  // Sin anillo no hay nada que vincular ni sincronizar.
  if (!hasRing.value) return null;
  const isToday = day === todayKey.value;
  const openRing = (
    <button type="button" class="linkish" onClick={() => (ringSheetOpen.value = true)}>
      Abrir
    </button>
  );
  if (!ring.value && !lastSync.value) {
    return (
      <Banner action={openRing}>
        Vincula tu anillo para traer tus pasos, sueño y pulso.
      </Banner>
    );
  }
  const last = lastSync.value;
  if (!isToday) return null;
  if (!last) return <Banner tone="warn" action={openRing}>Aún no has sincronizado el anillo.</Banner>;
  if (now - last.tsMs > STALE_AFTER_MS) {
    return (
      <Banner tone="warn" action={openRing}>
        Última sincronización {fmtAgo(last.tsMs, now)}: los datos de hoy pueden estar incompletos.
      </Banner>
    );
  }
  return null;
}

// ───────────────────────────── actividad ─────────────────────────────

/**
 * La tarjeta principal: lo básico del día (pasos, calorías, objetivo y distancia) y, si hubo entrenos, lo que aporta cada
 * actividad. No se abre: lo que había en su detalle (la tarta del reparto) no decía nada que no esté ya aquí, y los entrenos se
 * abren desde el historial de Deportes.
 */
function ActivityCard({ activity: a }: { activity: DayActivity }): JSX.Element {
  const goal = settings.value.stepGoal;

  if (!a.hasData || (a.steps === null && a.distanceM === null)) {
    return (
      <Card label="Actividad diaria">
        <CardHeader icon="Footprints" title="Actividad" color="var(--steps)" />
        <EmptyState icon="Footprints" title="Sin datos de actividad">
          Sincroniza el anillo para ver los pasos, la distancia y las calorías de este día.
        </EmptyState>
      </Card>
    );
  }

  const parts = a.workouts.length > 0 ? activityParts(a) : [];
  return (
    <section class="hero-card" aria-label="Actividad diaria">
      <header class="hero-card__head">
        <span class="hero-card__icon">
          <Icon name="Footprints" size={18} />
        </span>
        <h2>Actividad</h2>
      </header>
      <HeroRing value={a.steps ?? 0} max={goal} label={a.steps === null ? 'Sin pasos del anillo este día' : `${fmtInt(a.steps)} pasos de un objetivo de ${fmtInt(goal)}`}>
        <span class="hero-ring__label">Pasos</span>
        <span class="hero-ring__value">{a.steps === null ? '—' : fmtInt(a.steps)}</span>
      </HeroRing>
      <ul class="hero-stats">
        <li>
          <Icon name="flame" size={22} />
          <span class="sr-only">Calorías activas: </span>
          <span>
            <strong>{a.activeKcal === null ? '—' : fmtInt(a.activeKcal)}</strong> kcal
          </span>
        </li>
        <li>
          <Icon name="flag" size={22} />
          <span class="sr-only">Objetivo de pasos: </span>
          <strong>{fmtInt(goal)}</strong>
        </li>
        <li>
          <Icon name="map-pin" size={22} />
          <span class="sr-only">Distancia: </span>
          <span>
            <strong>{a.distanceM === null ? '—' : fmtKm(a.distanceM)}</strong> km
          </span>
        </li>
      </ul>
      {parts.length > 0 && <HeroSports parts={parts} overlapping={a.overlappingWorkouts} />}
    </section>
  );
}

// ───────────────────────────── nutrición ─────────────────────────────

/**
 * Lo comido del día frente a lo que se propone según el objetivo de salud, con su lista y el botón de anotar una comida, y —en la otra cara de la tarjeta— el
 * agua bebida frente a su meta. La meta de calorías parte de las calorías de mantenimiento medidas de la persona cuando ya hay peso y comidas anotados para
 * saberlas. El ejercicio no mueve la meta de calorías ni la de nutrientes, pero sí la de agua: lo que se suda y se respira de más con los pasos y los entrenos del día se suma
 * a lo que toca beber (`exerciseWater`).
 */
function NutritionSection({
  day,
  meals,
  water,
  sleep,
  activity,
}: {
  day: DayKey;
  meals: readonly MealEntry[];
  water: readonly WaterEntry[];
  sleep: SleepDay | null;
  activity: DayActivity;
}): JSX.Element {
  const profile = resolveProfile(profileHistory.value, day).profile;
  const targets = nutritionTargets(profile, day, settings.value.healthGoal, targetOptions());
  // Cuándo se levantó ese día, si el anillo lo sabe: el agua que toca llevar a cada hora se reparte desde ahí.
  const wakeMs = sleep?.night && dayKeyOf(sleep.night.endMs) === day ? sleep.night.endMs : null;
  return (
    <NutritionCard
      day={day}
      today={todayKey.value}
      meals={meals}
      targets={targets}
      water={water}
      waterGoalMl={waterGoalMl(profile, day)}
      waterExerciseMl={exerciseWater({ workouts: activity.workouts, walkingKcal: activity.walking.kcal, walkingSteps: activity.walking.steps }).totalMl}
      wakeMs={wakeMs}
      nowMs={nowMs.value}
      // Lo que se anota cuenta siempre para hoy: en un día pasado la tarjeta enseña lo comido y lo bebido, sin botones.
      canAdd={day === todayKey.value}
    />
  );
}

/**
 * Lo que aporta cada actividad al total de arriba: andar y cada deporte del día, con sus calorías y su distancia (la bici o la
 * carrera).
 */
function HeroSports({ parts, overlapping }: { parts: readonly ActivityPart[]; overlapping: boolean }): JSX.Element {
  return (
    <>
      <ul class="hero-sports" aria-label="Actividades del día">
        {parts.map((p) => (
          <li key={p.key}>
            <span class="hero-sports__icon">
              <Icon name={partIcon(p)} size={16} />
            </span>
            <span class="hero-sports__name">{p.name}</span>
            <span class="hero-sports__kcal">{fmtInt(p.kcal)} kcal</span>
            <span class="hero-sports__km">{p.distanceM !== null && p.distanceM > 0 ? `${fmtKm(p.distanceM)} km` : ''}</span>
          </li>
        ))}
      </ul>
      {overlapping && (
        <p class="hero-card__warn">
          <Icon name="TriangleAlert" size={16} />
          Hay entrenamientos que se solapan en el tiempo: si uno está repetido, elimínalo desde el historial de Deportes.
        </p>
      )}
    </>
  );
}

// ───────────────────────────── sueño ─────────────────────────────

function SleepCard({ sleep }: { sleep: SleepDay | null }): JSX.Element {
  const night = sleep?.night ?? null;
  const naps = sleep?.naps ?? [];
  const goalH = settings.value.sleepGoalH;

  if (!night && naps.length > 0) {
    // El anillo dio sueño pero ninguno llega a ser el principal del día: se enseñan las siestas en vez de decir que no hay nada.
    const napSec = naps.reduce((sum, nap) => sum + nap.durationSec, 0);
    return (
      <TapCard label="Sueño" class="card--tile" onOpen={open('sleep')}>
        <CardHeader icon="Moon" title="Sueño" color="var(--sleep)" right={<MoreButton label="Ver el detalle del sueño" />} />
        <div class="tile">
          <div class="tile__value">
            <BigDuration seconds={napSec} />
          </div>
          <div class="tile__sub">
            de siesta · {fmtClock(naps[0]?.startMs ?? 0)} → {fmtClock(naps[naps.length - 1]?.endMs ?? 0)}
          </div>
          <MoonMark />
        </div>
      </TapCard>
    );
  }

  if (!night) {
    return (
      <Card label="Sueño" class="card--tile">
        <CardHeader icon="Moon" title="Sueño" color="var(--sleep)" />
        <div class="tile">
          <div class="tile__value">—</div>
          <MoonMark />
        </div>
        <EmptyState icon="Moon" title="Sin sueño registrado">
          Lleva el anillo puesto al dormir y sincroniza al despertar. La noche se asigna al día en que te levantas.
        </EmptyState>
      </Card>
    );
  }

  const fraction = night.asleepSec / (goalH * 3600);
  return (
    <TapCard label="Sueño" class="card--tile" onOpen={open('sleep')}>
      <CardHeader icon="Moon" title="Sueño" color="var(--sleep)" right={<MoreButton label="Ver el detalle del sueño" />} />
      <div class="tile">
        <div class="tile__value">
          <BigDuration seconds={night.asleepSec} />
        </div>
        <div class="tile__sub">
          {night.estimated ? 'dormidos (aproximado)' : 'dormidos'} · {fmtClock(night.startMs)} → {fmtClock(night.endMs)}
        </div>
        <MoonMark />
      </div>
      <ProgressBar value={fraction} color="var(--sleep)" label={`Sueño frente al objetivo de ${fmt2(goalH)} h`} />
      <p class="field__hint" style={{ marginTop: '6px' }}>
        {Math.round(fraction * 100)}&nbsp;% del objetivo de {fmt2(goalH)}&nbsp;h
      </p>
    </TapCard>
  );
}

// ───────────────────────────── pulso ─────────────────────────────

function HeartCard({ heart }: { heart: HeartDay | null }): JSX.Element {
  const interval = settings.value.heartIntervalMin;
  return (
    <TapCard label="Ritmo cardiaco" class="card--tile" onOpen={open('heart')}>
      <CardHeader icon="HeartPulse" title="Ritmo cardiaco" color="var(--heart)" right={<MoreButton label="Ver el detalle del ritmo cardiaco" />} />
      <div class="tile">
        <div class="tile__value">
          {heart ? heart.last.bpm : '—'}
          <small>lpm</small>
        </div>
        {heart && <div class="tile__sub">última lectura a las {fmtClock(heart.last.tsMs)}</div>}
        <HeartMark />
      </div>
      {!heart && (
        <EmptyState icon="HeartPulse" title="Sin lecturas de pulso">
          El anillo mide el pulso por su cuenta cada {interval} min mientras lo llevas puesto. Sincroniza para traerlas o toca aquí para medir ahora.
        </EmptyState>
      )}
    </TapCard>
  );
}
