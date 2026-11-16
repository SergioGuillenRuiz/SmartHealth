import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { adviceFor, repeatsOf, shouldSuggest } from '../app/meal-habits';
import { settings, suggestMeal } from '../app/state';
import type { FitLevel } from '../domain/meal-fit';
import { REPEAT_WINDOW_DAYS } from '../domain/meal-repeat';
import { HEALTH_GOALS, type MealEntry } from '../domain/nutrition';
import { fmtInt } from './format';
import { Icon } from './icons';
import { MealThumb } from './meal-thumb';
import { RecipeCard } from './recipes/RecipeCard';
import { Sheet } from './Sheet';

// Ideas para comer mejor: cuando una comida poco adecuada se REPITE (la misma, varias veces en la semana), la hoja de sus detalles lleva un aviso discreto (un punto que late unas veces y se
// queda quieto) y, al pulsarlo, una hoja que analiza esa comida y propone recetas del mismo tipo, más sanas y ajustadas al objetivo de la persona, con el paso a paso animado (`domain/recipes.ts`).
// Se puede apagar en el menú de perfil → Objetivos y medición.

/** El aviso de encima de la valoración: solo sale si la función está activada, la comida es poco adecuada y esta misma comida se ha repetido esa semana. */
export function SuggestionNudge({ meal, level }: { meal: MealEntry; level: FitLevel }): JSX.Element | null {
  const enabled = settings.value.mealSuggestions;
  const [repeats, setRepeats] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || level !== 'poor') {
      setRepeats(null);
      return undefined;
    }
    let live = true;
    void repeatsOf(meal)
      .then((count) => {
        if (live) setRepeats(count);
      })
      .catch(() => undefined); // sin poder contar, no se avisa de nada
    return () => {
      live = false;
    };
  }, [meal.id, meal.name, enabled, level, settings.value.healthGoal]);
  if (repeats === null || !shouldSuggest(level, repeats, enabled)) return null;
  return (
    <button type="button" class="suggest-nudge" onClick={() => (suggestMeal.value = { meal, repeats })} aria-haspopup="dialog">
      <span class="suggest-nudge__pulse" aria-hidden="true" />
      <span class="suggest-nudge__text">
        <strong>{`La has comido ${repeats} veces en ${REPEAT_WINDOW_DAYS} días`}</strong>
        <small>Ver recetas parecidas, más sanas</small>
      </span>
      <Icon name="ChevronRight" size={16} />
    </button>
  );
}

export function SuggestionsSheet(): JSX.Element {
  const current = suggestMeal.value;
  return (
    <Sheet open={current !== null} onClose={() => (suggestMeal.value = null)} title="Ideas para comer mejor">
      {current && <Suggestions meal={current.meal} repeats={current.repeats} />}
    </Sheet>
  );
}

function Suggestions({ meal, repeats }: { meal: MealEntry; repeats: number }): JSX.Element {
  const goal = settings.value.healthGoal;
  const { family, weak, results } = adviceFor(meal, goal);
  const goalLabel = HEALTH_GOALS[goal].label.toLowerCase();
  return (
    <div class="swaps">
      <section class="advice" aria-label="Lo que he visto en tu comida">
        <div class="advice__meal">
          <MealThumb name={meal.name} size={44} barcode={meal.barcode} dishId={meal.dishId} />
          <div>
            <strong>{meal.name}</strong>
            <small>
              {repeats} veces en {REPEAT_WINDOW_DAYS} días · {fmtInt(meal.kcal)} kcal
            </small>
          </div>
        </div>
        {weak.length > 0 && (
          <p class="advice__weak">
            <span>Lo que más pesa:</span>
            {weak.map((criterion) => (
              <span class="advice__chip" key={criterion.key}>
                {criterion.key === 'health' ? criterion.value : `${criterion.label}: ${criterion.value.toLowerCase()}`}
              </span>
            ))}
          </p>
        )}
        <p class="advice__lead">
          {family.id === 'general' ? 'Platos sencillos y completos' : `Recetas de ${family.label} más sanas`}, rápidas y ajustadas a tu objetivo de <strong>{goalLabel}</strong>.
        </p>
      </section>
      <ul class="recipe-list">
        {results.map((result) => (
          <RecipeCard key={result.scaled.recipe.id} result={result} />
        ))}
      </ul>
      <p class="field__hint">Son ideas habituales, no una pauta médica. Las calorías salen de la tabla de alimentos de la app, con las cantidades de cada receta.</p>
    </div>
  );
}
