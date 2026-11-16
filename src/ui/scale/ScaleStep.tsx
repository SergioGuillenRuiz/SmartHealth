import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { productLookup, withOwnProducts } from '../../app/food-db';
import { draftOfAnalysis, estimateMealFromText, foodTable, type TextAnalysis } from '../../app/food-text';
import { scaleSaved, scaleState, scaleSupport } from '../../app/scale';
import { svc } from '../../app/services';
import { savedDishes, savedProducts } from '../../app/state';
import { PREP_OPTIONS, withPrep, type PrepId } from '../../domain/food-prep';
import { suggestFoods } from '../../domain/food-suggest';
import { EMPTY_BELOW_G } from '../../domain/scale';
import { netWeight } from '../../domain/scale-plate';
import { MAX_EDIT_ITEMS } from '../../domain/text-edit';
import { fmtInt, fmtUpTo1 } from '../format';
import { Icon } from '../icons';
import { addingIngredient, addToScalePlate, leaveScaleFor, scaleBaseline, scalePlate } from '../meal-flow';
import { formOf, MealForm, totalAmount } from '../MealSheet';
import { MealThumb } from '../meal-thumb';
import { Banner } from '../primitives';
import { ItemsEditor } from '../text-review';
import { LiveWeight, ScaleDot, scaleStatusText } from './live';
import { ScaleSetup } from './ScaleSetup';

// «Pesar con la báscula»: la persona dice QUÉ es (escribiéndolo o eligiendo una sugerencia) y los gramos los pone la báscula. Se calcula con el mismo análisis de texto de
// «contarlo con palabras» («355 g de pechuga de pollo»), así que sirve cualquier cosa que ya entienda (la tabla, los productos y los platos suyos). Un plato se monta ingrediente a
// ingrediente sobre la misma báscula: tras añadir uno, se resta lo ya pesado (o se empieza de cero si se quita o se pulsa TARA: `domain/scale-plate.ts`).

/** Calcula «N g de X» como el paso de palabras: con la tabla, los productos de la base y los que enseñó la persona. */
async function analyze(text: string): Promise<ReturnType<typeof estimateMealFromText>> {
  const own = await svc().store.listProducts().catch(() => []);
  const lookup = withOwnProducts(await productLookup(), own);
  return estimateMealFromText(text, lookup ?? undefined);
}

type Preview = { name: 'idle' } | { name: 'busy' } | { name: 'ok'; analysis: TextAnalysis } | { name: 'unknown'; words: string[] } | { name: 'error'; message: string };

export function ScaleStep(): JSX.Element {
  const support = scaleSupport();
  // Sin báscula emparejada, el primer paso es conectarla: el asistente sigue en pantalla hasta que se pulsa «Listo» (aunque ya esté guardada, para ver que ha ido bien).
  const [wizard, setWizard] = useState(scaleSaved.peek() === null);
  if (!support.available) return <Banner tone="warn">{support.reason}</Banner>;
  if (wizard) return <ScaleSetup onDone={() => setWizard(false)} />;
  return <Weigh />;
}

function Weigh(): JSX.Element {
  const state = scaleState.value;
  const reading = state.status === 'live' ? state.reading : null;
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview>({ name: 'idle' });
  // El plato y lo ya pesado viven en `meal-flow.ts`, no aquí: el código de barras (y lo que cuelga de él) se abre desde este paso y su producto se suma a este mismo plato.
  const plate = scalePlate.value;
  /** Lo ya pesado que sigue en la báscula (ver `netWeight`). */
  const baseline = scaleBaseline.value;
  /** Cómo está lo que se pesa (crudo, cocido, a la plancha…): se añade a lo escrito al calcular. Vale para el ingrediente de ahora y se apaga al añadirlo. */
  const [prep, setPrep] = useState<PrepId | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Lo que pesa lo nuevo: lo que marca la báscula menos lo ya pesado; si el peso baja de lo ya pesado, se empieza de cero.
  const grams = reading?.grams ?? 0;
  useEffect(() => {
    if (reading === null) return;
    const next = netWeight(reading.grams, baseline);
    if (next.baselineG !== baseline) scaleBaseline.value = next.baselineG;
  }, [reading?.grams, baseline]);
  const net = reading === null ? 0 : netWeight(grams, baseline).netG;
  const stable = reading?.stable === true;
  const roundedNet = Math.round(net);

  // El cálculo se rehace cuando el peso se queda quieto o cambia lo escrito.
  useEffect(() => {
    const typed = text.trim();
    if (typed === '' || !stable || net < EMPTY_BELOW_G) {
      if (typed === '') setPreview({ name: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setPreview({ name: 'busy' });
    void analyze(`${roundedNet} g de ${withPrep(typed, prep)}`).then((result) => {
      if (cancelled) return;
      if (result.status === 'error') setPreview({ name: 'error', message: result.message });
      else if (result.analysis.items.length === 0) setPreview({ name: 'unknown', words: result.analysis.unknown });
      else setPreview({ name: 'ok', analysis: result.analysis });
    });
    return () => {
      cancelled = true;
    };
  }, [text, stable, roundedNet, prep]);

  const suggestions = useMemo(() => suggestFoods(text, { foods: foodTable(), dishes: savedDishes.value ?? [], products: savedProducts.value ?? [] }), [text, savedDishes.value, savedProducts.value]);
  const showSuggestions = suggestions.length > 0 && !(preview.name === 'ok' && suggestions.some((s) => s.label.toLowerCase() === text.trim().toLowerCase()));
  const full = plate !== null && plate.analysis.items.length >= MAX_EDIT_ITEMS;

  const add = (analysis: TextAnalysis): void => {
    if (!addToScalePlate(analysis)) return;
    // Lo recién añadido sigue en la báscula: el siguiente ingrediente se mide sobre ello.
    scaleBaseline.value = grams;
    setText('');
    setPrep(null);
    setPreview({ name: 'idle' });
    input.current?.focus();
  };

  const change = (next: TextAnalysis): void => {
    const current = scalePlate.value;
    if (current !== null) scalePlate.value = { analysis: next, version: current.version + 1 };
  };

  return (
    <div class="sc-step">
      <div class="sc-status">
        <ScaleDot status={state.status} />
        <span>{scaleStatusText(state)}</span>
      </div>
      <LiveWeight baselineG={baseline} />

      <div class="sc-what">
        <div class="field">
          <label for="scale-what">{addingIngredient.value ? '¿Qué ingrediente es?' : plate === null ? '¿Qué es?' : '¿Qué más vas a añadir?'}</label>
          <div class="meal__typed-row">
            <input
              id="scale-what"
              ref={input}
              class="input"
              autocomplete="off"
              maxLength={120}
              placeholder="Pechuga de pollo, arroz, manzana…"
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button type="button" class="btn sc-scan" aria-label="Escanear el código de barras" disabled={full} onClick={() => leaveScaleFor('barcode')}>
              <Icon name="ScanBarcode" size={18} />
            </button>
          </div>
        </div>

        {/* Cómo está lo que se pesa: una fila de cinco mosaicos con su dibujo, aparte de lo que se propone debajo. */}
        <div class="sc-how" role="group" aria-label="Cómo está">
          <span class="sc-cap" aria-hidden="true">
            Cómo está
          </span>
          <div class="sc-how__row">
            {PREP_OPTIONS.map((option) => (
              <button key={option.id} type="button" class={`sc-how__opt${prep === option.id ? ' is-on' : ''}`} aria-pressed={prep === option.id} onClick={() => setPrep((current) => (current === option.id ? null : option.id))}>
                <Icon name={option.icon} size={22} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        {showSuggestions && (
          <div class="sc-picks">
            <span class="sc-cap" aria-hidden="true">
              Sugerencias
            </span>
            <ul class="sc-suggest" aria-label="Sugerencias">
              {suggestions.map((s) => (
                <li key={`${s.kind}:${s.label}`}>
                  <button type="button" class="sc-suggest__item" onClick={() => setText(s.label)}>
                    <MealThumb name={s.label} size={28} />
                    <span>{s.label}</span>
                    {s.kind !== 'food' && <small>{s.kind === 'dish' ? 'plato tuyo' : 'producto tuyo'}</small>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <PreviewCard preview={preview} text={text} netG={roundedNet} stable={stable} hasWeight={net >= EMPTY_BELOW_G} full={full} onAdd={add} />
      </div>

      {plate !== null && (
        <>
          <h3 class="sc-plate__title">{addingIngredient.value ? 'Ingrediente' : 'En el plato'}</h3>
          <ItemsEditor analysis={plate.analysis} onChange={change} />
          <MealForm key={plate.version} initial={formOf(draftOfAnalysis(plate.analysis))} source="scale" submitLabel={addingIngredient.value ? 'Añadir al plato' : 'Anotar'} grams={totalAmount(plate.analysis)} items={plate.analysis.items} />
        </>
      )}
    </div>
  );
}

/** Lo que saldría de lo escrito con lo que pesa ahora, y el botón para añadirlo al plato. */
function PreviewCard({ preview, text, netG, stable, hasWeight, full, onAdd }: { preview: Preview; text: string; netG: number; stable: boolean; hasWeight: boolean; full: boolean; onAdd: (analysis: TextAnalysis) => void }): JSX.Element | null {
  const typed = text.trim();
  if (typed === '') return <p class="sc-hint">Pon la comida en la báscula y di qué es: los gramos los pone ella.</p>;
  if (!hasWeight) return <p class="sc-hint">Pon «{typed}» en la báscula.</p>;
  if (!stable) return <p class="sc-hint">Esperando a que la báscula se quede quieta…</p>;
  if (preview.name === 'busy' || preview.name === 'idle') return <p class="sc-hint">Calculando…</p>;
  if (preview.name === 'error') return <Banner tone="warn">{preview.message}</Banner>;
  if (preview.name === 'unknown') {
    return (
      <Banner tone="warn">
        No reconozco «{preview.words[0] ?? typed}». Prueba con otro nombre, escanea su código de barras o escribe sus calorías detrás («{typed} 350 kcal»).
      </Banner>
    );
  }
  const total = preview.analysis.items.reduce((sum, item) => sum + item.kcal, 0);
  const names = preview.analysis.items.map((item) => item.name).join(' + ');
  return (
    <div class="sc-preview" role="group" aria-label="Lo que saldría">
      <MealThumb name={names} size={44} />
      <div class="sc-preview__main">
        <strong>{names}</strong>
        <span>
          {fmtUpTo1(netG)}&nbsp;g · <b>{fmtInt(total)}</b> kcal
        </span>
      </div>
      <button type="button" class="btn btn--primary" disabled={full} onClick={() => onAdd(preview.analysis)}>
        <Icon name="Plus" size={16} />
        Añadir
      </button>
    </div>
  );
}
