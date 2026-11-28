import type { JSX } from 'preact';
import { targetOptions } from '../app/personal';
import { detailMeal, profileHistory, settings, todayKey } from '../app/state';
import { dayKeyOf } from '../domain/dates';
import { mealDay } from '../domain/day-credit';
import { mealFacts, mealFit, type FitLevel, type IndicatorKey, type Rating } from '../domain/meal-fit';
import { HEALTH_GOALS, nutritionTargets, type MealEntry } from '../domain/nutrition';
import { resolveProfile } from '../domain/summary';
import { fmtClock, fmtCreditedDay, fmtDateFull, fmtInt, fmtUpTo1, NBSP } from './format';
import { Icon } from './icons';
import { MealAmounts } from './MealAmounts';
import { MealThumb } from './meal-thumb';
import { SuggestionNudge } from './MealSuggestions';
import { Sheet } from './Sheet';

// Los detalles de una comida, de lo concreto a lo interpretado: lo que se anotó (calorías y cantidad), los cuatro indicadores —proteína, hidratos, grasas y sal— con lo que pesan en la comida y
// en el día (y una nota con los azúcares y la fibra si se anotaron), las cantidades, y al final una valoración de cuánto encaja con lo que busca la persona (su objetivo de salud) con sus
// cinco criterios —densidad calórica, densidad proteica, sal y azúcar, saciedad y si es saludable—.

const LABEL: Record<IndicatorKey, string> = { proteinG: 'Proteína', carbsG: 'Hidratos', fatG: 'Grasas', saltG: 'Sal' };
const COLOR: Record<IndicatorKey, string> = {
  proteinG: 'var(--macro-protein)',
  carbsG: 'var(--macro-carbs)',
  fatG: 'var(--macro-fat)',
  saltG: 'var(--macro-salt)',
};

/** Cuántos de los tres tramos del medidor se llenan: muy buena 3, buena 2, normal 1, poco adecuada 0 (los tres vacíos y en rojo). */
const FIT_STEPS: Record<FitLevel, number> = { great: 3, good: 2, fair: 1, poor: 0, unknown: 0 };
/** Cómo sale cada criterio: una marca para la vista (el color solo no basta) y la palabra para quien lo escucha. */
const RATING_WORD: Record<Rating, string> = { good: 'Bien', ok: 'Regular', bad: 'Mal', unknown: 'Sin datos' };

function RatingMark({ rating }: { rating: Rating }): JSX.Element {
  return (
    <span class={`fit-row__mark fit-row__mark--${rating}`}>
      {rating === 'good' ? <Icon name="Check" size={14} strokeWidth={3} /> : rating === 'bad' ? <Icon name="TriangleAlert" size={13} strokeWidth={2.6} /> : <span aria-hidden="true">{rating === 'ok' ? '•' : '–'}</span>}
      <span class="sr-only">{RATING_WORD[rating]}: </span>
    </span>
  );
}

const percent = (share: number): string => `${fmtInt(share * 100)}${NBSP}%`;

export function MealDetailSheet(): JSX.Element {
  const meal = detailMeal.value;
  return (
    <Sheet open={meal !== null} onClose={() => (detailMeal.value = null)} title="Comida">
      {meal && <MealDetail meal={meal} />}
    </Sheet>
  );
}

function MealDetail({ meal }: { meal: MealEntry }): JSX.Element {
  const today = todayKey.value;
  const real = dayKeyOf(meal.tsMs);
  const credited = mealDay(meal);
  const goal = settings.value.healthGoal;
  // Las metas del día al que cuenta la comida, con el perfil de ese día: lo mismo que enseña la tarjeta.
  const targets = nutritionTargets(resolveProfile(profileHistory.value, credited).profile, credited, goal, targetOptions());
  const facts = mealFacts(meal, targets);
  const fit = mealFit(meal, goal, targets);
  const macros = facts.indicators.filter((i) => i.key !== 'saltG');
  // Nota al pie: los azúcares van dentro de los hidratos y la fibra aparte; solo lo que se anotó.
  const extras = [
    meal.sugarsG !== undefined && `Azúcares: ${fmtUpTo1(meal.sugarsG)}${NBSP}g (incluidos en los hidratos)`,
    meal.fiberG !== undefined && `Fibra: ${fmtUpTo1(meal.fiberG)}${NBSP}g`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    // Con los cinco criterios la hoja ya no cabe en una pantalla pequeña y se desplaza: al no haber nada pulsable dentro, el contenido es enfocable para poder recorrerlo con el teclado.
    <div class="meal-detail" tabIndex={0} role="group" aria-label={`Detalles de ${meal.name}`}>
      <div class="meal-detail__head">
        <MealThumb name={meal.name} size={72} barcode={meal.barcode} dishId={meal.dishId} />
        <div>
          <h3>{meal.name}</h3>
          <p>
            {fmtDateFull(real)} a las {fmtClock(meal.tsMs)}
          </p>
          {credited !== real && <p>Cuenta para {fmtCreditedDay(credited, today)}.</p>}
        </div>
      </div>

      <p class="meal-detail__kcal">
        <strong>{fmtInt(meal.kcal)}</strong> kcal
        <span>
          {meal.grams !== undefined && ` · ${fmtInt(meal.grams)}${NBSP}g`}
          {` · ${percent(facts.kcalDayShare)} de tu meta del día`}
        </span>
      </p>

      {facts.hasMacros ? (
        <>
          <div class="meal-detail__bar" aria-hidden="true">
            {macros.map((m) => (
              <span key={m.key} style={{ flexGrow: Math.max(0, (m.energyShare ?? 0) * 100), background: COLOR[m.key] }} />
            ))}
          </div>
          <dl class="meal-detail__macros">
            {facts.indicators.map((m) => (
              <div key={m.key}>
                <dt>
                  <span class="meal-detail__dot" style={{ background: COLOR[m.key] }} aria-hidden="true" />
                  {LABEL[m.key]}
                </dt>
                <dd>{m.grams === null ? '—' : `${fmtUpTo1(m.grams)}${NBSP}g`}</dd>
                {m.energyShare !== null && <dd class="meal-detail__sub meal-detail__sub--energy">{`${percent(m.energyShare)} de sus calorías`}</dd>}
                {m.dayShare !== null && <dd class="meal-detail__sub meal-detail__sub--day">{`${percent(m.dayShare)} ${m.key === 'saltG' ? 'del máximo diario' : 'de tu meta'}`}</dd>}
              </div>
            ))}
          </dl>
          {extras && <p class="meal-detail__note">{extras}</p>}
        </>
      ) : (
        <p class="field__hint">Solo se anotaron las calorías.</p>
      )}

      <MealAmounts meal={meal} />

      <SuggestionNudge meal={meal} level={fit.level} />

      <section class={`meal-fit is-${fit.level}`} aria-label="Para tu objetivo">
        <header class="meal-fit__head">
          <div>
            <h4>{fit.headline}</h4>
            <p class="meal-fit__goal">Tu objetivo: {HEALTH_GOALS[goal].label}</p>
          </div>
          <span class="meal-fit__meter" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <i key={i} class={i < FIT_STEPS[fit.level] ? 'is-on' : ''} />
            ))}
          </span>
        </header>
        {fit.criteria.length > 0 && (
          <ul class="fit-rows">
            {fit.criteria.map((c) => (
              <li key={c.key} class={`fit-row is-${c.rating}`}>
                <RatingMark rating={c.rating} />
                <span class="fit-row__main">
                  <span class="fit-row__label">{c.label}</span>
                  {c.detail !== null && <small>{c.detail}</small>}
                </span>
                <strong class="fit-row__value">{c.value}</strong>
              </li>
            ))}
          </ul>
        )}
        {fit.note !== null && <p class="fit-note">{fit.note}</p>}
      </section>

    </div>
  );
}
