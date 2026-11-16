import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { refreshDishes, removeUserProduct, saveMeal } from '../app/actions';
import { describeScannerFailure, ScannerError, startScanner } from '../app/barcode-scanner';
import { lookupBarcode, productLookup, suggestCodes, withOwnProducts, type CodeSuggestion, type FoodDbInfo } from '../app/food-db';
import { draftOfAnalysis, estimateMealFromText, type TextAnalysis, type TextItem } from '../app/food-text';
import { analysisOfItem, appendAnalysis, itemOfDraft, MAX_EDIT_AMOUNT, MAX_EDIT_ITEMS } from '../domain/text-edit';
import { svc } from '../app/services';
import { hasScale } from '../app/devices';
import { scaleSaved, scaleState, scaleSupport, startScale, stopScale } from '../app/scale';
import { mealSheetOpen, showToast } from '../app/state';
import { typedBarcode, unlistedReason } from '../domain/barcode';
import { ingredientOf, ingredientsOfItems, MAX_DISH_INGREDIENTS, MAX_INGREDIENT_G } from '../domain/dishes';
import { netWeight } from '../domain/scale-plate';
import { buildMeal, MAX_MEAL_KCAL, scaleProduct, validateMealDraft, type FoodProduct, type MealDraft, type MealSource } from '../domain/nutrition';
import { draftOfProduct, foodProductOf, type UserProduct, type UserProductDraft } from '../domain/user-products';
import { inWayOrder, type WayId } from './add-ways';
import { DishBack, DishBuilder, DishRail, DishUse, hasUnsavedChanges } from './dishes';
import { fmt1, fmt2, fmtInt, fmtUpTo1 } from './format';
import { Icon } from './icons';
import { addIngredientToDraft, addIngredientsToDraft, addingIngredient, addToScalePlate, clearScalePlate, dishDraft, fromScale, resetMealFlow, returnToScale, scaleBaseline, step, type Step } from './meal-flow';
import { parseDecimal, parseWhole, UNITS } from './parse';
import { ForgetProduct, ProductForm } from './product-form';
import { ProductTeach } from './product-teach';
import { scaleStatusText, TakeFromScale } from './scale/live';
import { ScaleStep } from './scale/ScaleStep';
import { ItemsEditor } from './text-review';
import { Banner } from './primitives';
import { Sheet } from './Sheet';

// «He comido algo»: la hoja que se abre desde el botón de la tarjeta Nutrición del Resumen (solo en el día de hoy). Arriba, los platos guardados (una barra deslizable y un + para
// guardar uno nuevo: `dishes.tsx`); debajo, de qué forma se quiere anotar (código de barras, lenguaje natural o calorías a mano, por ese orden en todos los menús: `add-ways.ts`), que se guarda como una comida del diario. Esas
// tres formas también sirven para añadir ingredientes a un plato (`addingIngredient`). Todo se calcula en el móvil, sin internet: los productos salen de la base que lleva la app
// (`food-db.ts`) y lo escrito con palabras, de su tabla de alimentos (`food-text.ts`).

const TITLES: Record<Step, string> = {
  menu: 'He comido algo',
  manual: 'Anotar calorías',
  barcode: 'Código de barras',
  text: 'Con lenguaje natural',
  scale: 'Pesar con la báscula',
  dish: 'Nuevo plato',
  add: 'Añadir ingrediente',
  use: 'Anotar un plato',
};

/** Los títulos de las tres formas de anotar cuando lo que se anota es un ingrediente del plato. */
const INGREDIENT_TITLES: Partial<Record<Step, string>> = {
  manual: 'Ingrediente a mano',
  barcode: 'Ingrediente con código de barras',
  text: 'Ingrediente con palabras',
  scale: 'Ingrediente con la báscula',
};

/** A dónde lleva «volver» desde cada paso. */
const BACK: Partial<Record<Step, { to: Step; label: string }>> = {
  manual: { to: 'menu', label: 'Elegir otra forma' },
  barcode: { to: 'menu', label: 'Elegir otra forma' },
  text: { to: 'menu', label: 'Elegir otra forma' },
  scale: { to: 'menu', label: 'Elegir otra forma' },
  add: { to: 'dish', label: 'Volver al plato' },
  use: { to: 'menu', label: 'Volver a mis platos' },
};

export function MealSheet(): JSX.Element {
  const open = mealSheetOpen.value;
  useEffect(() => {
    if (open) {
      void refreshDishes();
      // La báscula emparejada se conecta sola mientras la hoja está abierta (y se suelta un rato después de cerrarla).
      startScale();
    } else {
      resetMealFlow();
      stopScale();
    }
  }, [open]);
  const close = (): void => {
    mealSheetOpen.value = false;
  };
  const current = step.value;
  // Con `fromScale`, el código de barras o la anotación a mano se abrieron desde el paso de pesar: lo que salga se suma al plato que se pesa y se vuelve a pesar.
  const viaScale = fromScale.value && (current === 'barcode' || current === 'manual');
  const ingredient = addingIngredient.value || viaScale;
  // Desde las tres formas de anotar un ingrediente se vuelve a elegir cómo añadirlo, no al menú principal; desde el pesaje, a pesar.
  const back = viaScale
    ? { to: 'scale' as const, label: 'Volver a pesar' }
    : ingredient && (current === 'manual' || current === 'barcode' || current === 'text' || current === 'scale')
      ? { to: 'add' as const, label: 'Elegir otra forma' }
      : BACK[current];
  const title = (ingredient ? INGREDIENT_TITLES[current] : undefined) ?? (current === 'dish' && dishDraft.value?.id !== undefined ? 'Editar plato' : TITLES[current]);
  return (
    // Con un plato a medias la hoja no se cierra con el fondo, Esc o «atrás»: un toque de más no tira lo montado (se sale con «Volver», que pide confirmar, o guardándolo).
    <Sheet open={open} onClose={close} title={title} tall={current === 'barcode' || current === 'dish' || current === 'scale'} dismissible={!(dishDraft.value !== null && hasUnsavedChanges())}>
      {open && (
        <>
          {current === 'dish' && <DishBack />}
          {back !== undefined && (
            <button type="button" class="linkish meal__back" onClick={() => (back.to === 'scale' ? returnToScale() : (step.value = back.to))}>
              <Icon name="ChevronLeft" size={16} />
              {back.label}
            </button>
          )}
          {current === 'menu' && <MealMenu />}
          {current === 'manual' && <MealForm initial={EMPTY_FORM} source="manual" submitLabel={ingredient ? 'Añadir al plato' : 'Anotar'} />}
          {current === 'barcode' && <BarcodeStep />}
          {current === 'text' && <TextStep />}
          {current === 'scale' && <ScaleStep />}
          {current === 'dish' && <DishBuilder />}
          {current === 'add' && <MealMenu forIngredient />}
          {current === 'use' && <DishUse />}
        </>
      )}
    </Sheet>
  );
}

// ───────────────────────────── elegir cómo anotar ─────────────────────────────

type MenuOption = { way: WayId; step: Exclude<Step, 'menu'>; icon: string; title: string; summary: string };

/** Las formas de anotar, en el orden de siempre (`add-ways.ts`): lectura del código, palabras y, la última, a mano. La báscula, la primera, se suma donde la hay. */
const OPTIONS: ReadonlyArray<MenuOption> = inWayOrder<MenuOption>([
  { way: 'scan', step: 'barcode', icon: 'ScanBarcode', title: 'Escanear un código de barras', summary: 'Un producto envasado, con sus valores de la etiqueta' },
  { way: 'words', step: 'text', icon: 'MessageSquareText', title: 'Contarlo con tus palabras', summary: 'Se calcula con la tabla de alimentos de la app' },
  { way: 'manual', step: 'manual', icon: 'PenLine', title: 'Añadir las calorías a mano', summary: 'Si ya sabes cuántas son' },
]);

/** Cómo está la báscula, para la fila del menú: cuánto hay encima si hay algo, y si no, cómo va la conexión. */
function scaleSummary(): string {
  const state = scaleState.value;
  const reading = state.status === 'live' ? state.reading : null;
  return reading !== null && reading.grams >= 0.5 ? `Conectada · hay ${fmtUpTo1(reading.grams)} g encima` : scaleStatusText(state);
}

/** Las formas de anotar. Con `forIngredient` (desde el constructor de un plato) lo que se anote se añade al plato; si no, va al diario y arriba salen los platos guardados. */
function MealMenu({ forIngredient = false }: { forIngredient?: boolean }): JSX.Element {
  // Pesar con la báscula va el primero donde hay Bluetooth para ella: si ya está emparejada dice cómo va; si no, que se conecta una sola vez.
  // Sin báscula (el interruptor del menú de dispositivos) la fila no sale: quien quiera ver todo lo que ofrece la app solo tiene que dejar el interruptor encendido.
  const scaleOn = scaleSupport().available && hasScale.value;
  const options: ReadonlyArray<MenuOption> = scaleOn
    ? inWayOrder<MenuOption>([
        {
          way: 'scale',
          step: 'scale' as const,
          icon: 'kitchen-scale',
          title: 'Pesar con la báscula',
          summary: scaleSaved.value !== null ? scaleSummary() : 'Conéctala una vez y los gramos los pone ella',
        },
        ...OPTIONS,
      ])
    : OPTIONS;
  return (
    <div>
      {!forIngredient && <DishRail />}
      {!forIngredient && <h3 class="meal__other">Otras formas de anotar</h3>}
      <ul class="menu">
        {options.map((option) => (
          <li key={option.step}>
            <button
              type="button"
              class="menu-row"
              onClick={() => {
                addingIngredient.value = forIngredient;
                // Pesar desde el menú empieza un plato nuevo; solo el viaje al código de barras desde el propio pesaje conserva el que se llevaba.
                clearScalePlate();
                step.value = option.step;
              }}
            >
              <span class="menu-row__icon" style={{ color: 'var(--kcal)' }}>
                <Icon name={option.icon} size={20} />
              </span>
              <span class="menu-row__main">
                <strong>{option.title}</strong>
                <small>{option.summary}</small>
              </span>
              <Icon name="ChevronRight" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────── formulario de una comida ─────────────────────────────

export interface FormValues {
  name: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  sugars: string;
  salt: string;
}

const EMPTY_FORM: FormValues = { name: '', kcal: '', protein: '', carbs: '', fat: '', fiber: '', sugars: '', salt: '' };

const asText = (n: number | null): string => (n === null ? '' : String(n).replace('.', ','));

/** Las cifras de un borrador como texto de formulario. */
export const formOf = (draft: MealDraft): FormValues => ({
  name: draft.name,
  kcal: asText(draft.kcal),
  protein: asText(draft.proteinG),
  carbs: asText(draft.carbsG),
  fat: asText(draft.fatG),
  fiber: asText(draft.fiberG ?? null),
  sugars: asText(draft.sugarsG ?? null),
  salt: asText(draft.saltG ?? null),
});

export const newMealId = (): string => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface MealFormProps {
  initial: FormValues;
  source: MealSource;
  submitLabel: string;
  barcode?: string;
  grams?: number;
  /**
   * Los alimentos de los que sale lo que se está viendo (lo calculado con palabras o pesado): al AÑADIR AL PLATO cada uno entra como un ingrediente suelto con sus gramos, para poder
   * cambiarlos uno a uno al comer el plato. Si en el formulario se cambia algo (nombre, calorías…), se respeta y entra como un solo ingrediente.
   */
  items?: readonly TextItem[];
}

/** El formulario de una comida (calorías y, si se quiere, nutrientes): lo usa la entrada a mano y la revisión de lo que se calcula con palabras. */
export function MealForm({ initial, source, submitLabel, barcode, grams, items }: MealFormProps): JSX.Element {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Al añadir un ingrediente a un plato hace falta su cantidad (sobre ella se calcula lo que sale al comer otra): viene puesta si se calculó con palabras.
  const [amountText, setAmountText] = useState(grams === undefined ? '' : String(grams).replace('.', ','));
  // Un ingrediente de un plato guardado, o de lo que se pesa en la báscula (`fromScale`): lleva su cantidad y no se anota como comida.
  const asIngredient = addingIngredient.value || fromScale.value;
  // Al montar un plato, varios alimentos entran por separado mientras el formulario siga como salió del cálculo.
  const separate = addingIngredient.value && !fromScale.value && items !== undefined ? ingredientsOfItems(items) : [];
  const untouched = (Object.keys(initial) as Array<keyof FormValues>).every((key) => values[key] === initial[key]);
  const splitInto = separate.length > 1 && untouched ? separate : null;
  const set = (key: keyof FormValues) => (e: { currentTarget: HTMLInputElement }) => setValues((v) => ({ ...v, [key]: e.currentTarget.value }));

  const submit = (): void => {
    const draft: MealDraft = {
      name: values.name,
      kcal: parseWhole(values.kcal, UNITS.kcal),
      proteinG: parseDecimal(values.protein, UNITS.g),
      carbsG: parseDecimal(values.carbs, UNITS.g),
      fatG: parseDecimal(values.fat, UNITS.g),
      fiberG: parseDecimal(values.fiber, UNITS.g),
      sugarsG: parseDecimal(values.sugars, UNITS.g),
      saltG: parseDecimal(values.salt, UNITS.g),
    };
    const problems = validateMealDraft(draft);
    // Un campo que no es un número («2 pizzas») no se tira en silencio como si estuviera vacío.
    for (const [text, parsed, label] of [
      [values.kcal, draft.kcal, 'Las calorías'],
      [values.protein, draft.proteinG, 'Las proteínas'],
      [values.carbs, draft.carbsG, 'Los hidratos'],
      [values.fat, draft.fatG, 'Las grasas'],
      [values.fiber, draft.fiberG ?? null, 'La fibra'],
      [values.sugars, draft.sugarsG ?? null, 'Los azúcares'],
      [values.salt, draft.saltG ?? null, 'La sal'],
    ] as const) {
      if (text.trim() !== '' && parsed === null) problems.unshift(`${label} deben ser un número.`);
    }
    // Montando un plato con varios alimentos sin tocar: cada uno es su propio ingrediente (con sus gramos) y no se pide la cantidad de la suma.
    if (splitInto !== null) {
      if (!addIngredientsToDraft(splitInto)) setErrors([`Un plato admite como mucho ${MAX_DISH_INGREDIENTS} ingredientes: quita alguno antes de añadir ${splitInto.length} más.`]);
      return;
    }
    // Montando un plato: la comida no se anota, se añade como ingrediente (con su cantidad) y se vuelve al plato.
    const toScale = fromScale.value;
    const amount = asIngredient ? parseDecimal(amountText, UNITS.g) : null;
    const top = toScale ? MAX_EDIT_AMOUNT : MAX_INGREDIENT_G;
    if (asIngredient && (amount === null || amount <= 0 || amount > top)) problems.unshift(`La cantidad tiene que estar entre 1 y ${top.toLocaleString('es-ES')} g.`);
    if (toScale && problems.length === 0 && amount !== null && !addToScalePlate(analysisOfItem(itemOfDraft(draft, amount)))) problems.push(`El plato no admite más de ${MAX_EDIT_ITEMS} alimentos.`);
    setErrors(problems);
    if (problems.length > 0) return;
    if (toScale) {
      // Escrito a mano desde el pesaje: ya está sumado al plato que se pesa; se vuelve a pesar.
      returnToScale();
      return;
    }
    if (addingIngredient.value && amount !== null) {
      addIngredientToDraft(ingredientOf(draft, { grams: amount, ...(barcode !== undefined ? { barcode } : {}) }));
      return;
    }
    // Lo que lleva la comida, alimento a alimento con sus gramos, para poder cambiarlos después desde sus detalles: lo calculado o pesado si el formulario sigue como salió, o la comida entera
    // como un solo alimento si se conoce su cantidad (un producto escaneado, una cantidad dicha).
    const kept = items !== undefined && untouched ? ingredientsOfItems(items) : [];
    const single = kept.length === 0 && grams !== undefined && grams > 0 ? [ingredientOf(draft, { grams, ...(barcode !== undefined ? { barcode } : {}) })] : [];
    const meal = buildMeal(draft, { id: newMealId(), tsMs: svc().now(), source, ...(barcode !== undefined ? { barcode } : {}), ...(grams !== undefined ? { grams } : {}), items: kept.length > 0 ? kept : single });
    setSaving(true);
    void saveMeal(meal).then(
      () => {
        mealSheetOpen.value = false;
        showToast(`Comida anotada: ${fmtInt(meal.kcal)} kcal`);
      },
      (error: unknown) => {
        setSaving(false);
        showToast(`No se pudo anotar la comida${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
      },
    );
  };

  return (
    <form
      class="meal__form"
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
        <label for="meal-name">{asIngredient ? 'Ingrediente (opcional)' : 'Qué has comido (opcional)'}</label>
        <input id="meal-name" class="input" maxLength={120} autocomplete="off" value={values.name} onInput={set('name')} />
      </div>
      {asIngredient && (
        <div class="field">
          <label for="meal-amount">Cantidad (g o ml)</label>
          <input id="meal-amount" class="input" inputMode="decimal" autocomplete="off" value={amountText} onInput={(e) => setAmountText(e.currentTarget.value)} />
          {splitInto !== null && (
            <span class="field__hint" role="status">
              Se añaden {splitInto.length} ingredientes por separado, cada uno con sus gramos: así podrás cambiarlos uno a uno al comer el plato. Si cambias el nombre o las cifras de aquí, se añade como uno solo.
            </span>
          )}
        </div>
      )}
      <div class="field">
        <label for="meal-kcal">Calorías (kcal)</label>
        <input id="meal-kcal" class="input" inputMode="numeric" autocomplete="off" value={values.kcal} onInput={set('kcal')} />
      </div>
      <div class="field-row field-row--3">
        <div class="field">
          <label for="meal-protein">Proteínas (g)</label>
          <input id="meal-protein" class="input" inputMode="decimal" autocomplete="off" value={values.protein} onInput={set('protein')} />
        </div>
        <div class="field">
          <label for="meal-carbs">Hidratos (g)</label>
          <input id="meal-carbs" class="input" inputMode="decimal" autocomplete="off" value={values.carbs} onInput={set('carbs')} />
        </div>
        <div class="field">
          <label for="meal-fat">Grasas (g)</label>
          <input id="meal-fat" class="input" inputMode="decimal" autocomplete="off" value={values.fat} onInput={set('fat')} />
        </div>
      </div>
      <div class="field-row field-row--3">
        <div class="field">
          <label for="meal-fiber">Fibra (g)</label>
          <input id="meal-fiber" class="input" inputMode="decimal" autocomplete="off" value={values.fiber} onInput={set('fiber')} />
        </div>
        <div class="field">
          <label for="meal-sugars">Azúcares (g)</label>
          <input id="meal-sugars" class="input" inputMode="decimal" autocomplete="off" value={values.sugars} onInput={set('sugars')} />
        </div>
        <div class="field">
          <label for="meal-salt">Sal (g)</label>
          <input id="meal-salt" class="input" inputMode="decimal" autocomplete="off" value={values.salt} onInput={set('salt')} />
        </div>
      </div>
      <p class="field__hint meal__hint">Los nutrientes son opcionales; si dejas vacías las calorías, se calculan con ellos. Los azúcares son una parte de los hidratos.</p>
      <button type="submit" class="btn btn--primary btn--block" disabled={saving}>
        <Icon name="Check" size={18} />
        {submitLabel}
      </button>
    </form>
  );
}

// ───────────────────────────── código de barras ─────────────────────────────

type BarcodePhase =
  | { name: 'scanning' }
  | { name: 'looking'; code: string }
  | { name: 'product'; product: FoodProduct }
  | { name: 'missing'; code: string; info: FoodDbInfo }
  /** La persona le enseña el producto a la app con lo que pone la etiqueta (`editing`: corrige uno que ya había). */
  | { name: 'teach'; initial: UserProductDraft; editing: boolean; /** El producto que se estaba corrigiendo: «Cancelar» vuelve a él. */ back: FoodProduct | null }
  | { name: 'failed'; code: string; message: string };

/** Los productos que la persona enseñó, para `lookupBarcode`: así se encuentran antes que los de la base. */
async function ownProduct(code: string): Promise<FoodProduct | null> {
  const mine = await svc().store.getProduct(code);
  return mine === null ? null : foodProductOf(mine);
}

const emptyProductDraft = (barcode: string): UserProductDraft => ({ barcode, name: '', kcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, servingG: null });

function BarcodeStep(): JSX.Element {
  const [phase, setPhase] = useState<BarcodePhase>({ name: 'scanning' });
  const [cameraProblem, setCameraProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  /** Si el código tecleado no es válido pero hay UN producto conocido a una cifra de distancia: «¿era este?». */
  const [suggestion, setSuggestion] = useState<CodeSuggestion | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const searchAbort = useRef<AbortController | null>(null);
  /** Con la app oculta (otra app delante, pantalla apagada) la cámara se suelta, y al volver se reabre: no se queda un vídeo negro. */
  const [visible, setVisible] = useState(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const lookup = (code: string): void => {
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    setPhase({ name: 'looking', code });
    void lookupBarcode(code, { signal: abort.signal, own: ownProduct }).then((result) => {
      if (abort.signal.aborted) return;
      if (result.status === 'found') setPhase({ name: 'product', product: result.product });
      else if (result.status === 'not-found') setPhase({ name: 'missing', code, info: result.info });
      else setPhase({ name: 'failed', code, message: result.message });
    });
  };
  useEffect(() => () => searchAbort.current?.abort(), []);

  // La cámara solo está abierta mientras se escanea.
  useEffect(() => {
    if (phase.name !== 'scanning' || !visible) return undefined;
    const element = video.current;
    if (!element) return undefined;
    let cancelled = false;
    let handle: { stop(): void } | null = null;
    setCameraProblem(null);
    startScanner(element, (code) => {
      if (!cancelled) lookup(code);
    }).then(
      (started) => {
        if (cancelled) started.stop();
        else handle = started;
      },
      (error: unknown) => {
        if (!cancelled) setCameraProblem(error instanceof ScannerError ? error.message : describeScannerFailure('failed'));
      },
    );
    return () => {
      cancelled = true;
      handle?.stop();
    };
    // `lookup` solo usa referencias estables y el estado se cambia con su setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name, visible]);

  if (phase.name === 'product') {
    const product = phase.product;
    return (
      <ProductStep
        product={product}
        onEdit={() => setPhase({ name: 'teach', initial: draftOfProduct(product), editing: true, back: product })}
        onForget={
          product.own === true
            ? () =>
                void removeUserProduct(product.barcode).then((done) => {
                  if (!done) return;
                  showToast('Producto olvidado: la próxima vez saldrá el de la base, si está.');
                  setPhase({ name: 'scanning' });
                })
            : undefined
        }
      />
    );
  }
  if (phase.name === 'teach') {
    const { initial, editing, back } = phase;
    const saved = (product: UserProduct): void => setPhase({ name: 'product', product: foodProductOf(product) });
    const cancel = (): void => setPhase(back !== null ? { name: 'product', product: back } : { name: 'scanning' });
    // Corregir uno que ya hay: directo al formulario. Uno nuevo: primero se elige cómo darle los valores (foto, palabras o, al final, a mano).
    return editing ? <ProductForm initial={initial} editing onSaved={saved} onCancel={cancel} /> : <ProductTeach barcode={initial.barcode} onSaved={saved} onCancel={cancel} />;
  }

  const searchTyped = (): void => {
    const code = typedBarcode(typed);
    setSuggestion(null);
    if (code === null) {
      setTypedError('Ese código no es válido: revisa las cifras (suelen ser 13, y debajo de las barras).');
      const digits = typed.replace(/[\s-]/g, '');
      // Una cifra mal tecleada es lo más corriente: si solo hay un producto conocido a una cifra de distancia, se propone.
      if (/^\d{8}$|^\d{12,14}$/.test(digits)) void suggestCodes(digits, { own: ownProduct }).then((found) => setSuggestion(found.length === 1 ? (found[0] ?? null) : null));
      return;
    }
    setTypedError(null);
    lookup(code);
  };

  return (
    <div>
      {phase.name === 'scanning' && (
        <>
          <div class="scan" role="group" aria-label="Cámara para escanear el código">
            <video ref={video} class="scan__video" playsInline muted />
            {cameraProblem === null && <div class="scan__guide" aria-hidden="true" />}
          </div>
          {cameraProblem !== null ? <Banner tone="warn">{cameraProblem}</Banner> : <p class="field__hint meal__hint">Apunta a las barras del envase, con buena luz y sin acercarte demasiado.</p>}
        </>
      )}
      {phase.name === 'looking' && <p class="sync-note" role="status">Buscando el producto {phase.code}…</p>}
      {phase.name === 'missing' && (
        <Banner tone="warn">
          El producto {phase.code} no está en la base de la app. {unlistedReason(phase.code) ?? ''}
        </Banner>
      )}
      {phase.name === 'failed' && (
        <Banner
          tone="danger"
          action={
            <button type="button" class="linkish" onClick={() => lookup(phase.code)}>
              Reintentar
            </button>
          }
        >
          {phase.message}
        </Banner>
      )}
      {/* Las salidas, en el orden de siempre (`add-ways.ts`): leer otro código, enseñarle el producto a la app y, la última, anotarlo a mano. */}
      {(phase.name === 'missing' || phase.name === 'failed') && (
        <button type="button" class="btn btn--block" style={{ marginTop: '12px' }} onClick={() => setPhase({ name: 'scanning' })}>
          <Icon name="ScanBarcode" size={18} />
          Escanear otro
        </button>
      )}
      {phase.name === 'missing' && unlistedReason(phase.code) === null && (
        <button type="button" class="btn btn--primary btn--block" style={{ marginTop: '10px' }} onClick={() => setPhase({ name: 'teach', initial: emptyProductDraft(phase.code), editing: false, back: null })}>
          <Icon name="MessageSquareText" size={18} />
          Enseñarle este producto
        </button>
      )}
      {phase.name === 'missing' && (
        <button type="button" class="btn btn--block" style={{ marginTop: '10px' }} onClick={() => (step.value = 'manual')}>
          <Icon name="PenLine" size={18} />
          Anotarlo a mano
        </button>
      )}
      <form
        class="meal__typed"
        onSubmit={(e) => {
          e.preventDefault();
          searchTyped();
        }}
      >
        <div class="field">
          <label for="barcode-typed">O teclea el código</label>
          <div class="meal__typed-row">
            <input
              id="barcode-typed"
              class="input"
              inputMode="numeric"
              autocomplete="off"
              value={typed}
              onInput={(e) => {
                setTyped(e.currentTarget.value);
                setSuggestion(null); // lo propuesto era para el código de antes
              }}
            />
            <button type="submit" class="btn" disabled={phase.name === 'looking'}>
              Buscar
            </button>
          </div>
          {typedError !== null && (
            <span class="field__hint meal__error" role="alert">
              {typedError}
            </span>
          )}
          {suggestion !== null && (
            <button
              type="button"
              class="linkish"
              onClick={() => {
                setTyped(suggestion.code);
                setTypedError(null);
                setSuggestion(null);
                lookup(suggestion.code);
              }}
            >
              ¿Era {suggestion.code}, «{suggestion.name}»? Usar ese código
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * El producto encontrado: cuánto se ha comido (gramos) y lo que eso suma. `onEdit` abre el formulario para corregir sus cifras (si la base trae mal una, lo que
 * se corrige manda sobre ella); `onForget` solo está en los productos que enseñó la persona.
 */
function ProductStep({ product, onEdit, onForget }: { product: FoodProduct; onEdit: () => void; onForget?: (() => void) | undefined }): JSX.Element {
  const [grams, setGrams] = useState(String(product.servingG ?? 100).replace('.', ','));
  const [saving, setSaving] = useState(false);
  // Con la báscula emparejada, viva y con el producto encima, los gramos se ponen solos (hasta que la persona escriba otra cosa).
  const typedByHand = useRef(false);
  /** ¿Los gramos que hay puestos salen de lo que marca la báscula? (Si no, el producto no está encima de ella.) */
  const fromTheScale = useRef(false);
  const onScale = scaleState.value.status === 'live' ? scaleState.value.reading : null;
  // Abierto desde el paso de pesar: el producto va al plato que se pesa y la báscula marca también lo ya pesado, que se resta.
  const toScalePlate = fromScale.value;
  const baselineG = toScalePlate ? scaleBaseline.value : 0;
  const onScaleG = onScale === null ? 0 : netWeight(onScale.grams, baselineG).netG;
  useEffect(() => {
    if (!typedByHand.current && scaleSaved.value !== null && onScale !== null && onScale.stable && onScaleG >= 1) {
      fromTheScale.current = true;
      setGrams(String(onScaleG).replace('.', ','));
    }
  }, [onScale?.stable, onScaleG]);
  /** Los gramos los puso la persona (a mano o con un atajo): ya no los cambia la báscula. */
  const byHand = (): void => {
    typedByHand.current = true;
    fromTheScale.current = false;
  };
  const amount = parseDecimal(grams, UNITS.g);
  const inRange = amount !== null && amount > 0 && amount <= 5000;
  const scaled = inRange ? scaleProduct(product.per100g, amount) : null;
  // Con una cantidad enorme las cifras pasan de lo que admite una comida (y una copia de seguridad con ella no se podría restaurar).
  const tooBig = scaled !== null && validateMealDraft({ name: product.name, ...scaled }).length > 0;
  const valid = inRange && scaled !== null && !tooBig;

  const save = (): void => {
    if (!valid || scaled === null) return;
    if (toScalePlate) {
      // Escaneado desde el pesaje: un ingrediente más del plato que se pesa (no se anota en el diario) y se vuelve a pesar.
      if (!addToScalePlate(analysisOfItem(itemOfDraft({ name: product.name, ...scaled }, amount)))) {
        showToast(`El plato no admite más de ${MAX_EDIT_ITEMS} alimentos.`, 'error');
        return;
      }
      // Si el producto estaba encima de la báscula, ya forma parte de lo pesado: el siguiente ingrediente se mide sobre ello.
      if (fromTheScale.current && onScale !== null) scaleBaseline.value = onScale.grams;
      returnToScale();
      return;
    }
    if (addingIngredient.value) {
      addIngredientToDraft(ingredientOf({ name: product.name, ...scaled }, { grams: amount, barcode: product.barcode }));
      return;
    }
    const meal = buildMeal({ name: product.name, ...scaled }, { id: newMealId(), tsMs: svc().now(), source: 'barcode', barcode: product.barcode, grams: amount, items: [ingredientOf({ name: product.name, ...scaled }, { grams: amount, barcode: product.barcode })] });
    setSaving(true);
    void saveMeal(meal).then(
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
      class="meal__product"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h3 class="meal__product-name">{product.name}</h3>
      <p class="field__hint">
        Por 100 g: {fmtInt(product.per100g.kcal)} kcal · {fmt1(product.per100g.proteinG)} g de proteínas · {fmt1(product.per100g.carbsG)} g de hidratos · {fmt1(product.per100g.fatG)} g de grasas
        {product.per100g.saltG !== undefined && <> · {fmt2(product.per100g.saltG)} g de sal</>}
      </p>
      <div class="field">
        <label for="product-grams">Cantidad que has comido (g o ml)</label>
        <div class="meal__typed-row">
          <input
            id="product-grams"
            class="input"
            inputMode="decimal"
            autocomplete="off"
            value={grams}
            onInput={(e) => {
              byHand();
              setGrams(e.currentTarget.value);
            }}
          />
          <TakeFromScale
            name={product.name}
            baselineG={baselineG}
            onTake={(taken) => {
              typedByHand.current = true;
              fromTheScale.current = true;
              setGrams(String(taken).replace('.', ','));
            }}
          />
        </div>
        <div class="meal__quick">
          {product.servingG !== null && (
            <button
              type="button"
              class="btn btn--small"
              onClick={() => {
                byHand();
                setGrams(String(product.servingG).replace('.', ','));
              }}
            >
              1 ración ({fmtInt(product.servingG)} g)
            </button>
          )}
          <button
            type="button"
            class="btn btn--small"
            onClick={() => {
              byHand();
              setGrams('100');
            }}
          >
            100 g
          </button>
        </div>
      </div>
      <p class="meal__total" role="status">
        {tooBig ? (
          `Con esa cantidad salen más de ${fmtInt(MAX_MEAL_KCAL)} kcal, o demasiados gramos de un nutriente: revisa los gramos.`
        ) : scaled !== null && scaled.kcal !== null ? (
          <>
            <strong>{fmtInt(scaled.kcal)}</strong> kcal · {fmt1(scaled.proteinG ?? 0)} g P · {fmt1(scaled.carbsG ?? 0)} g H · {fmt1(scaled.fatG ?? 0)} g G
          </>
        ) : (
          'Indica una cantidad entre 1 y 5.000.'
        )}
      </p>
      <button type="submit" class="btn btn--primary btn--block" disabled={!valid || saving}>
        <Icon name="Check" size={18} />
        {addingIngredient.value || toScalePlate ? 'Añadir al plato' : 'Anotar'}
      </button>
      {product.own === true && <p class="field__hint">Es un producto que le enseñaste tú: sale antes que el de la base.</p>}
      <div class="meal__quick">
        <button type="button" class="btn btn--small" onClick={onEdit}>
          Corregir los datos
        </button>
        {onForget !== undefined && <ForgetProduct onForget={onForget} />}
      </div>
    </form>
  );
}

// ───────────────────────────── lenguaje natural ─────────────────────────────

/** `version` sube con cada cambio de lo calculado: así el formulario de debajo (que parte de esas cifras) se rehace con ellas. */
type TextPhase = { name: 'compose' } | { name: 'review'; analysis: TextAnalysis; version: number };

/** Lo que pesa lo calculado (g y ml juntos: un ml de lo que se bebe pesa casi un gramo), o `undefined` si no hay nada: va con la comida para decir cuánto se comió. */
export function totalAmount(analysis: TextAnalysis): number | undefined {
  const total = Math.round(analysis.items.reduce((sum, item) => sum + item.amount, 0));
  return total > 0 && total <= 100_000 ? total : undefined;
}

/** Añadir otro alimento a lo calculado escribiéndolo («20 g de queso»): se calcula igual que el texto de antes y se suma, sin reescribir lo demás. */
function AddFood({ onAdd, full }: { onAdd: (text: string) => Promise<string | null>; full: boolean }): JSX.Element {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (busy || value.trim() === '') return;
    setBusy(true);
    void onAdd(value).then((message) => {
      setBusy(false);
      setProblem(message);
      if (message === null) setValue('');
    });
  };
  return (
    <form
      class="meal__typed"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="field">
        <label for="text-add">Añadir otro alimento</label>
        <div class="meal__typed-row">
          <input id="text-add" class="input" autocomplete="off" maxLength={200} placeholder="20 g de queso" value={value} disabled={full} onInput={(e) => setValue(e.currentTarget.value)} />
          <button type="submit" class="btn" disabled={busy || full || value.trim() === ''}>
            <Icon name="Plus" size={16} />
            Añadir
          </button>
        </div>
        {problem !== null && (
          <span class="field__hint meal__error" role="alert">
            {problem}
          </span>
        )}
      </div>
    </form>
  );
}

function TextStep(): JSX.Element {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<TextPhase>({ name: 'compose' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // La base de productos (marcas y productos envasados) se prepara mientras se escribe, para que «Calcular» no espere.
  useEffect(() => {
    void productLookup();
  }, []);

  /** Calcula un texto con la tabla de alimentos y, si ésta no lo entiende, con los productos de la base y los que enseñó la persona. */
  const analyze = async (input: string): Promise<ReturnType<typeof estimateMealFromText>> => {
    const own = await svc().store.listProducts().catch(() => []);
    const lookup = withOwnProducts(await productLookup(), own);
    return estimateMealFromText(input, lookup ?? undefined);
  };

  const calculate = async (): Promise<void> => {
    setBusy(true);
    const result = await analyze(text);
    setBusy(false);
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    setError(null);
    setPhase({ name: 'review', analysis: result.analysis, version: 0 });
  };

  /** Añade a lo calculado otro alimento escrito aparte, sin tocar lo demás. Devuelve el aviso si no se pudo. */
  const addFood = async (input: string, current: TextAnalysis, version: number): Promise<string | null> => {
    const result = await analyze(input);
    if (result.status === 'error') return result.message;
    const merged = appendAnalysis(current, result.analysis);
    if (merged === null) return `No caben más de ${MAX_EDIT_ITEMS} alimentos: quita alguno antes de añadir otro.`;
    setPhase({ name: 'review', analysis: merged, version: version + 1 });
    return null;
  };

  if (phase.name === 'review') {
    const { analysis, version } = phase;
    const change = (next: TextAnalysis): void => setPhase({ name: 'review', analysis: next, version: version + 1 });
    return (
      <div>
        {analysis.items.length > 0 ? (
          <ItemsEditor analysis={analysis} onChange={change} />
        ) : (
          <p class="field__hint" role="status">
            No queda ningún alimento: añade uno abajo o vuelve a escribirlo.
          </p>
        )}
        <AddFood onAdd={(input) => addFood(input, analysis, version)} full={analysis.items.length >= MAX_EDIT_ITEMS} />
        {analysis.unknown.length > 0 && (
          <Banner tone="warn">No he reconocido {analysis.unknown.map((phrase) => `«${phrase}»`).join(', ')}: no está sumado. Si sabes sus calorías, escríbelas detrás («{analysis.unknown[0]} 350 kcal») y las usaré; o añádelo a mano abajo.</Banner>
        )}
        {analysis.assumptions !== '' && <p class="meal__explain">{analysis.assumptions}</p>}
        <p class="field__hint meal__hint">Cambia los gramos y se recalcula solo. Son raciones medias: una estimación.</p>
        {analysis.items.length > 0 && (
          <MealForm key={version} initial={formOf(draftOfAnalysis(analysis))} source="text" submitLabel={addingIngredient.value ? 'Añadir al plato' : 'Anotar'} grams={totalAmount(analysis)} items={analysis.items} />
        )}
        <button type="button" class="btn btn--ghost btn--block" onClick={() => setPhase({ name: 'compose' })}>
          Volver a escribirlo
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void calculate();
      }}
    >
      {error !== null && (
        <div class="errors errors--box" role="alert">
          {error}
        </div>
      )}
      <div class="field">
        <label for="meal-text">¿Qué has comido?</label>
        <textarea
          id="meal-text"
          class="input meal__textarea"
          rows={4}
          maxLength={1000}
          placeholder="Por ejemplo: dos huevos revueltos con una rebanada de pan y un café con leche"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <span class="field__hint">Pon cada alimento con su cantidad («200 g de arroz», «dos huevos», «un vaso de leche»). Sin cantidad, se supone una ración normal. Si ya sabes las calorías, escríbelas («tarta 350 kcal»).</span>
      </div>
      <button type="submit" class="btn btn--primary btn--block" disabled={busy}>
        <Icon name="Calculator" size={18} />
        {busy ? 'Calculando…' : 'Calcular calorías'}
      </button>
    </form>
  );
}
