import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { removeDish, saveDish, saveMeal } from '../app/actions';
import { openCamera, PhotoError, describePhotoFailure, type CameraHandle } from '../app/photo-capture';
import { svc } from '../app/services';
import { mealSheetOpen, savedDishes, showToast } from '../app/state';
import {
  dishKcal,
  dishTotals,
  isScalable,
  MAX_DISH_NAME,
  mealDraftOfDish,
  mealOfDish,
  mealProblemOfDish,
  recipeGrams,
  scaleIngredient,
  validateDish,
  type DishIngredient,
  type SavedDish,
} from '../domain/dishes';
import { fmt1, fmtInt, NBSP } from './format';
import { Icon } from './icons';
import { TakeFromScale } from './scale/live';
import { addingIngredient, dishDraft, editDish, openDish, startNewDish, step, updateDraft, usingDish } from './meal-flow';
import { MealThumb } from './meal-thumb';
import { parseDecimal, UNITS } from './parse';
import { Banner } from './primitives';

// Platos guardados dentro de «He comido algo». La barra de arriba enseña los que hay (con su foto) y un + para guardar uno nuevo; un plato se monta con sus ingredientes por
// las mismas tres vías de siempre (a mano, código de barras o palabras) y una foto; y al anotarlo se eligen los gramos de cada ingrediente.

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** La foto de un plato o, si no tiene, la imagen de lo que parece por su nombre. */
function DishPicture({ dish, size }: { dish: Pick<SavedDish, 'name' | 'photo'>; size: number }): JSX.Element {
  if (dish.photo === undefined) return <MealThumb name={dish.name} size={size} />;
  return <img class="dish-photo" src={dish.photo} alt="" width={size} height={size} decoding="async" draggable={false} />;
}

// ───────────────────────────── la barra de platos guardados ─────────────────────────────

/** Los platos guardados en una barra deslizable y, debajo, el botón + para guardar uno nuevo. */
export function DishRail(): JSX.Element {
  const dishes = savedDishes.value;
  return (
    <section class="dishes" aria-labelledby="dishes-title">
      <h3 id="dishes-title" class="dishes__title">
        Mis platos
      </h3>
      {dishes.length > 0 ? (
        <ul class="dishes__rail" aria-label="Platos guardados">
          {dishes.map((dish) => (
            <li key={dish.id}>
              <button type="button" class="dish-card" onClick={() => openDish(dish)}>
                <span class="dish-card__picture">
                  <DishPicture dish={dish} size={96} />
                </span>
                <strong class="dish-card__name">{dish.name}</strong>
                <small>
                  {fmtInt(dishKcal(dish))}
                  {NBSP}kcal
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="dishes__empty">Guarda aquí lo que preparas a menudo y anótalo de un toque.</p>
      )}
      <div class="dishes__add-row">
        <button type="button" class="dishes__add" aria-label="Guardar un plato nuevo" onClick={startNewDish}>
          <Icon name="Plus" size={26} />
        </button>
      </div>
    </section>
  );
}

// ───────────────────────────── montar un plato ─────────────────────────────

/** `true` si lo que se está montando tiene algo que se perdería al salir (un plato nuevo con algo escrito, o uno guardado con cambios). */
export function hasUnsavedChanges(): boolean {
  const draft = dishDraft.value;
  if (draft === null) return false;
  const saved = draft.id === undefined ? undefined : savedDishes.value.find((dish) => dish.id === draft.id);
  if (saved === undefined) return draft.name.trim() !== '' || draft.ingredients.length > 0 || draft.photo !== undefined;
  return draft.name !== saved.name || draft.photo !== saved.photo || JSON.stringify(draft.ingredients) !== JSON.stringify(saved.ingredients);
}

/** «Volver» desde el constructor: si hay algo sin guardar pide un segundo toque antes de tirarlo. */
export function DishBack(): JSX.Element {
  const [confirm, setConfirm] = useState(false);
  return (
    <button
      type="button"
      class="linkish meal__back"
      onClick={() => {
        if (!confirm && hasUnsavedChanges()) {
          setConfirm(true);
          return;
        }
        dishDraft.value = null;
        step.value = 'menu';
      }}
    >
      <Icon name="ChevronLeft" size={16} />
      {confirm ? 'Toca otra vez para descartar los cambios' : 'Volver a mis platos'}
    </button>
  );
}

/** La foto del plato: hacerla con la cámara, repetirla o quitarla. La cámara solo está abierta mientras se enfoca. */
function PhotoField({ photo }: { photo: string | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<CameraHandle | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const element = video.current;
    if (!element) return undefined;
    let cancelled = false;
    setProblem(null);
    openCamera(element).then(
      (handle) => {
        if (cancelled) handle.stop();
        else camera.current = handle;
      },
      (error: unknown) => {
        if (cancelled) return;
        setProblem(error instanceof PhotoError ? error.message : describePhotoFailure('failed'));
        setOpen(false);
      },
    );
    return () => {
      cancelled = true;
      camera.current?.stop();
      camera.current = null;
    };
  }, [open]);

  const take = (): void => {
    const url = camera.current?.capture() ?? null;
    if (url === null) {
      setProblem('La cámara aún no tiene imagen: espera un momento y vuelve a intentarlo.');
      return;
    }
    updateDraft({ photo: url });
    setOpen(false);
  };

  return (
    <div class="field dish-photo-field">
      <span class="dish-photo-field__label" id="dish-photo-label">
        Foto (opcional)
      </span>
      {open ? (
        <>
          <div class="scan" role="group" aria-label="Cámara para la foto del plato">
            <video ref={video} class="scan__video" playsInline muted />
          </div>
          <div class="dish-photo-field__actions">
            <button type="button" class="btn btn--primary" onClick={take}>
              <Icon name="Camera" size={18} />
              Sacar foto
            </button>
            <button type="button" class="btn" onClick={() => setOpen(false)}>
              Cancelar
            </button>
          </div>
        </>
      ) : photo !== undefined ? (
        <>
          <img class="dish-photo-field__preview" src={photo} alt="Foto del plato" />
          <div class="dish-photo-field__actions">
            <button type="button" class="btn" onClick={() => setOpen(true)}>
              <Icon name="Camera" size={18} />
              Repetir foto
            </button>
            <button type="button" class="btn btn--ghost" onClick={() => updateDraft({ photo: undefined })}>
              Quitar foto
            </button>
          </div>
        </>
      ) : (
        <button type="button" class="btn btn--block" aria-describedby="dish-photo-label" onClick={() => setOpen(true)}>
          <Icon name="Camera" size={18} />
          Hacer una foto
        </button>
      )}
      {problem !== null && <Banner tone="warn">{problem}</Banner>}
    </div>
  );
}

const describeIngredient = (item: DishIngredient): string => `${item.name}${item.grams !== undefined ? ` (${fmtInt(item.grams)} g)` : ''}`;

/** El constructor de un plato: nombre, foto e ingredientes con su cantidad (que se añaden por las tres vías de siempre). */
export function DishBuilder(): JSX.Element {
  const draft = dishDraft.value;
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (draft === null) return <></>;

  const totals = dishTotals(draft.ingredients);
  const editing = draft.id !== undefined;

  const submit = (): void => {
    const problems = validateDish({ name: draft.name, ingredients: draft.ingredients });
    setErrors(problems);
    if (problems.length > 0) return;
    const now = svc().now();
    const dish: SavedDish = {
      id: draft.id ?? newId('p'),
      name: draft.name.trim().replace(/\s+/g, ' '),
      createdMs: draft.createdMs ?? now,
      updatedMs: now,
      ...(draft.lastUsedMs !== undefined ? { lastUsedMs: draft.lastUsedMs } : {}),
      ingredients: draft.ingredients,
      ...(draft.photo !== undefined ? { photo: draft.photo } : {}),
    };
    setSaving(true);
    void saveDish(dish).then((ok) => {
      if (!ok) {
        setSaving(false);
        return;
      }
      showToast(editing ? 'Plato actualizado' : 'Plato guardado');
      dishDraft.value = null;
      step.value = 'menu';
    });
  };

  const remove = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (draft.id === undefined) return;
    setSaving(true);
    void removeDish(draft.id).then((ok) => {
      if (!ok) {
        setSaving(false);
        return;
      }
      showToast('Plato borrado');
      dishDraft.value = null;
      step.value = 'menu';
    });
  };

  return (
    <form
      class="meal__form dish-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {errors.length > 0 && (
        <div class="errors errors--box" role="alert">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div class="field">
        <label for="dish-name">Nombre del plato</label>
        <input id="dish-name" class="input" maxLength={MAX_DISH_NAME} autocomplete="off" value={draft.name} onInput={(e) => updateDraft({ name: e.currentTarget.value })} />
      </div>
      <PhotoField photo={draft.photo} />
      <div class="field">
        <span class="dish-photo-field__label">Ingredientes</span>
        {draft.ingredients.length > 0 && (
          <ul class="meal__items dish-ingredients" aria-label="Ingredientes del plato">
            {draft.ingredients.map((item, i) => (
              <li key={`${item.name}-${i}`}>
                <span>{describeIngredient(item)}</span>
                <span class="dish-ingredients__kcal">{fmtInt(item.kcal)} kcal</span>
                <button
                  type="button"
                  class="icon-btn dish-ingredients__remove"
                  aria-label={`Quitar ${item.name}`}
                  onClick={() => updateDraft({ ingredients: draft.ingredients.filter((_, at) => at !== i) })}
                >
                  <Icon name="X" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          class="btn btn--block"
          onClick={() => {
            step.value = 'add';
          }}
        >
          <Icon name="Plus" size={18} />
          Añadir ingrediente
        </button>
      </div>
      <p class="meal__total" role="status">
        {draft.ingredients.length === 0 ? (
          'Aún no hay ingredientes.'
        ) : (
          <>
            Total <strong>{fmtInt(totals.kcal)}</strong> kcal
            <span class="dish-total__macros">
              {totals.proteinG !== undefined && ` · ${fmt1(totals.proteinG)} g P`}
              {totals.carbsG !== undefined && ` · ${fmt1(totals.carbsG)} g H`}
              {totals.fatG !== undefined && ` · ${fmt1(totals.fatG)} g G`}
            </span>
          </>
        )}
      </p>
      <button type="submit" class="btn btn--primary btn--block" disabled={saving}>
        <Icon name="Check" size={18} />
        Guardar plato
      </button>
      {editing && (
        <button type="button" class="btn btn--danger btn--block" style={{ marginTop: '10px' }} disabled={saving} onClick={remove}>
          <Icon name="Trash2" size={18} />
          {confirmDelete ? 'Toca otra vez para borrarlo' : 'Borrar plato'}
        </button>
      )}
    </form>
  );
}

// ───────────────────────────── anotar un plato guardado ─────────────────────────────

const gramsText = (grams: number | null): string => (grams === null ? '' : String(grams).replace('.', ','));

/** Anotar un plato guardado: los gramos de cada ingrediente (los de la receta vienen puestos), lo que suma todo y el botón de anotarlo. */
export function DishUse(): JSX.Element {
  const dish = usingDish.value;
  const [texts, setTexts] = useState<string[]>(() => (dish === null ? [] : recipeGrams(dish).map(gramsText)));
  const [saving, setSaving] = useState(false);
  if (dish === null) return <></>;

  // Un ingrediente de antes de las cantidades no se puede escalar: entra tal cual (null) y no pide gramos.
  const grams = dish.ingredients.map((item, i) => (isScalable(item) ? parseDecimal(texts[i] ?? '', UNITS.g) : null));
  const problem = mealProblemOfDish(dish, grams);
  const preview = problem === null ? mealDraftOfDish(dish, grams).draft : null;

  const save = (): void => {
    if (problem !== null) return;
    const meal = mealOfDish(dish, grams, { id: newId('c'), tsMs: svc().now() });
    setSaving(true);
    void saveMeal(meal)
      .then(() => saveDish({ ...dish, lastUsedMs: svc().now() }))
      .then(
        () => {
          mealSheetOpen.value = false;
          showToast(`Comida anotada: ${fmtInt(meal.kcal)} kcal`);
        },
        () => {
          setSaving(false);
          showToast('No se pudo anotar la comida.', 'error');
        },
      );
  };

  return (
    <form
      class="dish-use"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div class="dish-use__head">
        <DishPicture dish={dish} size={84} />
        <h3 class="meal__product-name">{dish.name}</h3>
      </div>
      <ul class="dish-use__rows" aria-label="Ingredientes del plato">
        {dish.ingredients.map((item, i) => {
          const amount = grams[i];
          const kcal = !isScalable(item) ? item.kcal : amount === null || amount === undefined ? null : scaleIngredient(item, amount).kcal;
          return (
            <li key={`${item.name}-${i}`}>
              {isScalable(item) ? (
                <>
                  <label class="dish-use__name" for={`dish-g-${i}`}>
                    {item.name}
                  </label>
                  <input
                    id={`dish-g-${i}`}
                    class="input dish-use__grams"
                    inputMode="decimal"
                    autocomplete="off"
                    value={texts[i] ?? ''}
                    onInput={(e) => {
                      const value = e.currentTarget.value;
                      setTexts((current) => current.map((text, at) => (at === i ? value : text)));
                    }}
                  />
                  <span class="dish-use__unit">
                    g
                    <TakeFromScale
                      name={item.name}
                      onTake={(taken) => setTexts((current) => current.map((text, at) => (at === i ? String(taken).replace('.', ',') : text)))}
                    />
                  </span>
                </>
              ) : (
                <span class="dish-use__name dish-use__name--fixed">{item.name}</span>
              )}
              <span class="dish-use__kcal">{kcal === null ? '—' : `${fmtInt(kcal)} kcal`}</span>
            </li>
          );
        })}
      </ul>
      <p class="meal__total" role="status">
        {problem !== null ? (
          problem
        ) : preview !== null && preview.kcal !== null ? (
          <>
            <strong>{fmtInt(preview.kcal)}</strong> kcal · {fmt1(preview.proteinG ?? 0)} g P · {fmt1(preview.carbsG ?? 0)} g H · {fmt1(preview.fatG ?? 0)} g G
          </>
        ) : null}
      </p>
      <button type="submit" class="btn btn--primary btn--block" disabled={problem !== null || saving}>
        <Icon name="Check" size={18} />
        Anotar
      </button>
      <button
        type="button"
        class="btn btn--block"
        style={{ marginTop: '10px' }}
        onClick={() => {
          addingIngredient.value = false;
          editDish(dish);
        }}
      >
        <Icon name="Pencil" size={18} />
        Editar plato
      </button>
    </form>
  );
}
