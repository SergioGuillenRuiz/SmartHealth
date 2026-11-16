import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { detailMeal } from '../app/state';
import { loadMealItems, saveMealAmounts } from '../app/meal-items';
import { isScalable } from '../domain/dishes';
import { canEditAmounts, removeItemAt, setItemGrams } from '../domain/meal-items';
import type { MealEntry, MealItem } from '../domain/nutrition';
import { fmtInt, NBSP } from './format';
import { AmountField, TrashButton } from './text-review';

// Cambiar los gramos de lo YA anotado, alimento a alimento (de cualquier comida: a mano con cantidad, escaneada, contada con palabras, pesada o de un plato). Se abre desde los detalles de la
// comida; cada alimento enseña sus gramos en un campo (y, si hay una báscula a mano, el botón para tomarlos de ella), se recalcula al momento con la regla de tres y «Guardar» rehace la comida.

function total(items: readonly MealItem[]): { kcal: number; grams: number } {
  return { kcal: Math.round(items.reduce((sum, item) => sum + item.kcal, 0)), grams: Math.round(items.reduce((sum, item) => sum + (item.grams ?? 0), 0)) };
}

export function MealAmounts({ meal }: { meal: MealEntry }): JSX.Element | null {
  // `undefined`: leyendo lo que lleva; `null`: no hay gramos que cambiar.
  const [original, setOriginal] = useState<MealItem[] | null | undefined>(undefined);
  // Lo que se está editando (`null`: no se edita).
  const [draft, setDraft] = useState<MealItem[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setOriginal(undefined);
    setDraft(null);
    void loadMealItems(meal).then((items) => {
      if (alive) setOriginal(items);
    });
    return () => {
      alive = false;
    };
  }, [meal]);

  if (original === undefined) return null;
  if (!canEditAmounts(original)) {
    return <p class="field__hint meal-amounts__none">Esta comida no tiene gramos guardados: solo se anotaron sus calorías.</p>;
  }

  if (draft === null) {
    return (
      <div class="meal-amounts">
        <button type="button" class="btn btn--small" onClick={() => setDraft([...original])}>
          Cambiar cantidades
        </button>
      </div>
    );
  }

  const sum = total(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(original);
  const save = (): void => {
    if (saving || !changed) return;
    setSaving(true);
    void saveMealAmounts(meal, original, draft).then((next) => {
      setSaving(false);
      if (next !== null) detailMeal.value = next;
    });
  };

  return (
    <div class="meal-amounts is-editing" role="group" aria-label="Cantidades de lo que lleva la comida">
      <ul class="rv-list" aria-label="Lo que lleva la comida">
        {draft.map((item, i) => (
          <li key={`${item.name}-${i}`} class="rv-card">
            <div class="rv-row">
              <span class="rv-row__main">
                <span class="rv-row__name">{item.name}</span>
                <small>{fmtInt(item.kcal)} kcal</small>
              </span>
              {isScalable(item) ? <AmountField label={`Cantidad de ${item.name} (g)`} unit="g" value={item.grams as number} onCommit={(grams) => setDraft((current) => (current === null ? current : setItemGrams(current, i, grams)))} /> : <small class="rv-row__none">sin gramos</small>}
              {draft.length > 1 && <TrashButton name={item.name} small={false} onRemove={() => setDraft((current) => (current === null ? current : removeItemAt(current, i)))} />}
            </div>
          </li>
        ))}
      </ul>
      <p class="meal-amounts__total">
        Total: <strong>{fmtInt(sum.kcal)}</strong> kcal{sum.grams > 0 ? ` · ${fmtInt(sum.grams)}${NBSP}g` : ''}
      </p>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" disabled={!changed || saving} onClick={save}>
          Guardar
        </button>
        <button type="button" class="btn" disabled={saving} onClick={() => setDraft(null)}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
