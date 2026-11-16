import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { saveUserProduct } from '../app/actions';
import { svc } from '../app/services';
import { showToast } from '../app/state';
import { MAX_PRODUCT_NAME, userProductOf, validateProductDraft, type UserProduct, type UserProductDraft } from '../domain/user-products';
import { useArmed } from './hooks';
import { Icon } from './icons';
import { parseDecimal, UNITS } from './parse';

// Los productos que la persona le enseña a la app: el formulario con lo que pone la etiqueta (lo usa `product-teach.tsx` para revisar lo leído de una foto o de unas palabras, y
// a mano como última opción) y el botón de olvidar uno, que pide un segundo toque. Se guardan en el móvil y no salen de él.

interface ProductFormValues {
  name: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  sugars: string;
  salt: string;
  serving: string;
}

const textOf = (value: number | null): string => (value === null ? '' : String(value).replace('.', ','));

const productFormOf = (draft: UserProductDraft): ProductFormValues => ({
  name: draft.name,
  kcal: textOf(draft.kcal),
  protein: textOf(draft.proteinG),
  carbs: textOf(draft.carbsG),
  fat: textOf(draft.fatG),
  fiber: textOf(draft.fiberG),
  sugars: textOf(draft.sugarsG),
  salt: textOf(draft.saltG),
  serving: textOf(draft.servingG),
});

interface ProductFormProps {
  initial: UserProductDraft;
  /** Corrige uno que ya existe (el botón dice «Guardar los cambios» y el código no se toca). */
  editing: boolean;
  onSaved: (product: UserProduct) => void;
  onCancel: () => void;
  /** Lo que dice el botón de salir (por defecto «Cancelar»). */
  cancelLabel?: string;
}

/**
 * Lo que pone la etiqueta de un producto (por cada 100 g o 100 ml): nombre, calorías y, si se quiere, nutrientes y ración. Se guarda en el móvil con su código de
 * barras y desde entonces se reconoce al escanearlo; también sirve para corregir una cifra de la base. No usa internet: los datos los pone la persona.
 */
export function ProductForm({ initial, editing, onSaved, onCancel, cancelLabel = 'Cancelar' }: ProductFormProps): JSX.Element {
  const [values, setValues] = useState(() => productFormOf(initial));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof ProductFormValues) => (e: { currentTarget: HTMLInputElement }) => setValues((v) => ({ ...v, [key]: e.currentTarget.value }));

  const submit = (): void => {
    const draft: UserProductDraft = {
      barcode: initial.barcode,
      name: values.name,
      kcal: parseDecimal(values.kcal, UNITS.kcal),
      proteinG: parseDecimal(values.protein, UNITS.g),
      carbsG: parseDecimal(values.carbs, UNITS.g),
      fatG: parseDecimal(values.fat, UNITS.g),
      fiberG: parseDecimal(values.fiber, UNITS.g),
      sugarsG: parseDecimal(values.sugars, UNITS.g),
      saltG: parseDecimal(values.salt, UNITS.g),
      servingG: parseDecimal(values.serving, UNITS.g),
    };
    const problems = validateProductDraft(draft);
    // Un campo que no es un número no se tira en silencio como si estuviera vacío.
    for (const [text, parsed, label] of [
      [values.kcal, draft.kcal, 'Las calorías'],
      [values.protein, draft.proteinG, 'Las proteínas'],
      [values.carbs, draft.carbsG, 'Los hidratos'],
      [values.fat, draft.fatG, 'Las grasas'],
      [values.fiber, draft.fiberG, 'La fibra'],
      [values.sugars, draft.sugarsG, 'Los azúcares'],
      [values.salt, draft.saltG, 'La sal'],
      [values.serving, draft.servingG, 'La ración'],
    ] as const) {
      if (text.trim() !== '' && parsed === null) problems.unshift(`${label} deben ser un número.`);
    }
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    void (async () => {
      const previous = await svc().store.getProduct(draft.barcode).catch(() => null);
      const product = userProductOf(draft, svc().now(), previous ?? undefined);
      if (product === null || !(await saveUserProduct(product))) {
        setSaving(false);
        return;
      }
      showToast(editing ? 'Producto corregido.' : 'Producto guardado: la próxima vez lo reconocerá.');
      onSaved(product);
    })();
  };

  return (
    <form
      class="meal__form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p class="field__hint">Código {initial.barcode} · valores por 100 g (o 100 ml).</p>
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
        <label for="product-name">Nombre del producto</label>
        <input id="product-name" class="input" maxLength={MAX_PRODUCT_NAME} autocomplete="off" value={values.name} onInput={set('name')} />
      </div>
      <div class="field">
        <label for="product-kcal">Calorías por 100 g (kcal)</label>
        <input id="product-kcal" class="input" inputMode="decimal" autocomplete="off" value={values.kcal} onInput={set('kcal')} />
      </div>
      <div class="field-row field-row--3">
        <div class="field">
          <label for="product-protein">Proteínas (g)</label>
          <input id="product-protein" class="input" inputMode="decimal" autocomplete="off" value={values.protein} onInput={set('protein')} />
        </div>
        <div class="field">
          <label for="product-carbs">Hidratos (g)</label>
          <input id="product-carbs" class="input" inputMode="decimal" autocomplete="off" value={values.carbs} onInput={set('carbs')} />
        </div>
        <div class="field">
          <label for="product-fat">Grasas (g)</label>
          <input id="product-fat" class="input" inputMode="decimal" autocomplete="off" value={values.fat} onInput={set('fat')} />
        </div>
      </div>
      <div class="field-row field-row--3">
        <div class="field">
          <label for="product-fiber">Fibra (g)</label>
          <input id="product-fiber" class="input" inputMode="decimal" autocomplete="off" value={values.fiber} onInput={set('fiber')} />
        </div>
        <div class="field">
          <label for="product-sugars">Azúcares (g)</label>
          <input id="product-sugars" class="input" inputMode="decimal" autocomplete="off" value={values.sugars} onInput={set('sugars')} />
        </div>
        <div class="field">
          <label for="product-salt">Sal (g)</label>
          <input id="product-salt" class="input" inputMode="decimal" autocomplete="off" value={values.salt} onInput={set('salt')} />
        </div>
      </div>
      <div class="field">
        <label for="product-serving">Ración (g), si la etiqueta la dice</label>
        <input id="product-serving" class="input" inputMode="decimal" autocomplete="off" value={values.serving} onInput={set('serving')} />
      </div>
      <p class="field__hint meal__hint">Solo el nombre y las calorías son obligatorios.</p>
      <button type="submit" class="btn btn--primary btn--block" disabled={saving}>
        <Icon name="Check" size={18} />
        {editing ? 'Guardar los cambios' : 'Guardar y usar'}
      </button>
      <button type="button" class="btn btn--ghost btn--block" onClick={onCancel}>
        {cancelLabel}
      </button>
    </form>
  );
}

/**
 * «Olvidar este producto» con un segundo toque que no vale al instante (`useArmed`): un doble toque no borra sin querer. Son botones sueltos, para ponerlos en la
 * misma fila que otros.
 */
export function ForgetProduct({ onForget }: { onForget: () => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const armed = useArmed(asking);
  if (!asking) {
    return (
      <button type="button" class="btn btn--small" onClick={() => setAsking(true)}>
        Olvidar este producto
      </button>
    );
  }
  return (
    <>
      <button type="button" class="btn btn--small btn--danger" disabled={!armed} onClick={onForget}>
        Sí, olvidarlo
      </button>
      <button type="button" class="btn btn--small" onClick={() => setAsking(false)}>
        No
      </button>
    </>
  );
}
