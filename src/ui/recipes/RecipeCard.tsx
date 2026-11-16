import type { JSX } from 'preact';
import type { RecipeResult } from '../../app/meal-habits';
import { GOAL_NOTE, ingredientLine, type ScaledIngredient } from '../../domain/recipe-suggest';
import type { FitLevel } from '../../domain/meal-fit';
import { fmtInt } from '../format';
import { Icon } from '../icons';
import { STEP_ICON, STEP_WORD } from './step-icon';

// Una receta de las ideas para comer mejor, sin dibujos: arriba el nombre con lo que lleva (calorías, proteína, tiempo y cómo se valora para el objetivo), lo que cambia respecto a lo de siempre y,
// al abrirla, los ingredientes con su cantidad y el paso a paso con el icono de cada acción. Hasta la ronda 54 llevaba un plato dibujado con sus ingredientes y una escena por paso: se quitaron.

const LEVEL_WORD: Record<FitLevel, string> = { great: 'Muy buena', good: 'Buena', fair: 'Normal', poor: 'Poco adecuada', unknown: '' };

/** La cantidad y el nombre de un ingrediente por separado («200 g» · «patatas», «2» · «huevos»), para ponerlos en dos columnas. */
export function splitIngredient(ingredient: ScaledIngredient): { qty: string; name: string } {
  const line = ingredientLine(ingredient);
  const grams = /^(\d+(?:[.,]\d+)? (?:g|ml)) de (.+)$/.exec(line);
  if (grams) return { qty: grams[1]!, name: grams[2]! };
  const units = /^(\d+) (.+)$/.exec(line);
  return units ? { qty: units[1]!, name: units[2]! } : { qty: '', name: line };
}

function ProductBody({ result }: { result: RecipeResult }): JSX.Element {
  const { recipe, ingredients } = result.scaled;
  return (
    <>
      {recipe.shop !== undefined && <p class="recipe-card__shop">{recipe.shop}</p>}
      <p class="recipe-card__serving">
        <strong>Una ración:</strong> {ingredients.map((ingredient) => ingredientLine(ingredient)).join(', ')}
        {recipe.pantry.length > 0 ? `. Opcional: ${recipe.pantry.join(', ')}` : ''}.
      </p>
    </>
  );
}

export function RecipeCard({ result }: { result: RecipeResult }): JSX.Element {
  const { scaled, kcal, proteinG, level } = result;
  const { recipe, goal, ingredients } = scaled;
  const product = recipe.kind === 'product';
  return (
    <li class={`recipe-card${product ? ' recipe-card--product' : ''}`}>
      <div class="recipe-card__top">
        <span class="recipe-card__kind" aria-hidden="true">
          <Icon name={product ? 'ShoppingBasket' : 'ChefHat'} size={22} />
        </span>
        <div class="recipe-card__head">
          <h3>{recipe.title}</h3>
          <p class="recipe-card__meta">
            <span>{fmtInt(kcal)} kcal</span>
            {recipe.rated !== false && <span>{fmtInt(proteinG)} g proteína</span>}
            {product ? (
              <span class="recipe-card__shopchip">
                <Icon name="ShoppingBasket" size={12} /> De súper
              </span>
            ) : (
              <span>
                <Icon name="Timer" size={12} /> {recipe.minutes} min
              </span>
            )}
            {recipe.rated !== false && level !== 'unknown' && <span class={`recipe-card__level is-${level}`}>{LEVEL_WORD[level]}</span>}
          </p>
        </div>
      </div>
      <p class="recipe-card__change">{recipe.change}</p>
      {recipe.rated !== false && <p class="recipe-card__goal">{GOAL_NOTE[goal]}</p>}
      {product && <ProductBody result={result} />}
      {!product && (
        <details class="recipe-card__recipe">
          <summary>Ver la receta paso a paso</summary>
          <h4>Ingredientes (1 ración)</h4>
          <ul class="recipe-ingredients">
            {ingredients.map((ingredient) => {
              const { qty, name } = splitIngredient(ingredient);
              return (
                <li key={ingredient.name}>
                  <b>{qty}</b>
                  <span>{name}</span>
                </li>
              );
            })}
          </ul>
          {recipe.pantry.length > 0 && <p class="recipe-card__pantry">Y de casa: {recipe.pantry.join(', ')}.</p>}
          <h4>Paso a paso</h4>
          <ol class="cook-steps">
            {recipe.steps.map((step, index) => (
              <li key={step.text} class="cook-step">
                <span class="cook-step__icon" aria-hidden="true">
                  <Icon name={STEP_ICON[step.action]} size={20} />
                </span>
                <div class="cook-step__body">
                  <small>
                    Paso {index + 1} · {STEP_WORD[step.action]}
                  </small>
                  <p>{step.text}</p>
                  {step.minutes !== undefined && (
                    <span class="cook-step__time">
                      <Icon name="Timer" size={12} /> {step.minutes} min
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}
