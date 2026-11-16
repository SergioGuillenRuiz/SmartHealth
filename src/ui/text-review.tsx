import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TextAnalysis, TextItem } from '../domain/food-text';
import { hasAmount, isEditableAmount, MAX_EDIT_AMOUNT, MIN_EDIT_AMOUNT, removeItem, removePart, setItemAmount, setPartAmount } from '../domain/text-edit';
import { fmtInt, fmtUpTo1 } from './format';
import { Icon } from './icons';
import { useArmed } from './hooks';
import { MealThumb } from './meal-thumb';
import { TakeFromScale } from './scale/live';
import { parseDecimal, UNITS } from './parse';

// La revisión de lo que calculó «contarlo con palabras» (y de los ingredientes de un plato que se cuentan igual): cada alimento, y cada pieza de un plato compuesto, con sus
// gramos EDITABLES y una papelera (de doble toque) para quitarlo. Se recalcula al momento con la regla de tres (`domain/text-edit.ts`): no hace falta reescribir el texto entero.

/** Los gramos de un alimento: un campo que cambia lo calculado en cuanto lo escrito es una cantidad válida (si no, se marca y queda lo de antes). */
export function AmountField({ label, unit, value, onCommit }: { label: string; unit: string; value: number; onCommit: (amount: number) => void }): JSX.Element {
  const [text, setText] = useState(fmtUpTo1(value));
  const [invalid, setInvalid] = useState(false);
  // Si la cantidad cambia desde fuera (cambiar el plato entero reparte entre sus piezas) el campo la sigue; lo que se está escribiendo no se pisa.
  useEffect(() => {
    if (parseDecimal(text, UNITS.g) !== value) {
      setText(fmtUpTo1(value));
      setInvalid(false);
    }
    // Solo cuando cambia la cantidad de fuera: depender también de `text` pisaría lo que se escribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  /** Toma el peso de la báscula como cantidad (si hay una emparejada, viva y con algo encima). */
  const take = (grams: number): void => {
    setText(fmtUpTo1(grams));
    setInvalid(false);
    if (isEditableAmount(grams) && grams !== value) onCommit(grams);
  };
  return (
    <span class="rv-amount-wrap">
      <label class="rv-amount">
        <input
          class="rv-amount__input"
          inputMode="decimal"
          autocomplete="off"
          value={text}
          aria-invalid={invalid ? 'true' : undefined}
          aria-label={label}
          onInput={(e) => {
            const next = e.currentTarget.value;
            setText(next);
            const amount = parseDecimal(next, UNITS.g);
            const ok = isEditableAmount(amount);
            setInvalid(!ok);
            if (ok && amount !== value) onCommit(amount);
          }}
          onBlur={() => {
            // Al salir con algo que no vale, vuelve la cantidad de antes.
            if (invalid) {
              setText(fmtUpTo1(value));
              setInvalid(false);
            }
          }}
        />
        <span class="rv-amount__unit" aria-hidden="true">
          {unit}
        </span>
      </label>
      <TakeFromScale name={label.replace(/^Cantidad de /, '').replace(/ \(.*\)$/, '')} onTake={take} />
    </span>
  );
}

export function TrashButton({ name, small, onRemove }: { name: string; small: boolean; onRemove: () => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const armed = useArmed(asking, 450);
  return (
    <button
      type="button"
      class={`rv-trash${small ? ' rv-trash--small' : ''}${asking ? ' is-confirming' : ''}`}
      aria-label={asking ? `Confirmar: quitar ${name}` : `Quitar ${name}`}
      onClick={() => {
        if (!asking) setAsking(true);
        else if (armed) onRemove();
      }}
      onBlur={() => setAsking(false)}
    >
      <Icon name="Trash2" size={small ? 15 : 17} />
      {asking && <span>Quitar</span>}
    </button>
  );
}

/** Un alimento (o una pieza de un plato): su nombre con las calorías debajo, los gramos en un solo campo con la unidad dentro y la papelera. */
function ItemRow({ item, part, onAmount, onRemove }: { item: TextItem; part: boolean; onAmount: (amount: number) => void; onRemove: () => void }): JSX.Element {
  return (
    <div class={`rv-row${part ? ' rv-row--part' : ''}`}>
      {!part && <MealThumb name={item.name} size={36} />}
      <span class="rv-row__main">
        <span class="rv-row__name">{item.name}</span>
        <small>{fmtInt(item.kcal)} kcal</small>
      </span>
      {hasAmount(item) ? <AmountField label={`Cantidad de ${item.name} (${item.unit})`} unit={item.unit} value={item.amount} onCommit={onAmount} /> : <small class="rv-row__none">sin gramos</small>}
      <TrashButton name={item.name} small={part} onRemove={onRemove} />
    </div>
  );
}

/**
 * Lo calculado, alimento a alimento y pieza a pieza, con los gramos editables. `onChange` recibe el cálculo ya rehecho. Al quitar algo el foco pasa a la lista, para no
 * perderse en un botón que desaparece.
 */
export function ItemsEditor({ analysis, onChange }: { analysis: TextAnalysis; onChange: (next: TextAnalysis) => void }): JSX.Element {
  const list = useRef<HTMLUListElement>(null);
  const removed = useRef(false);
  useEffect(() => {
    if (!removed.current) return;
    removed.current = false;
    list.current?.focus();
  }, [analysis]);
  const remove = (next: TextAnalysis): void => {
    removed.current = true;
    onChange(next);
  };
  return (
    <ul class="rv-list" aria-label="Lo que se ha calculado" ref={list} tabIndex={-1}>
      {analysis.items.map((item, i) => (
        <li key={`${item.name}-${i}`} class="rv-card">
          <ItemRow item={item} part={false} onAmount={(amount) => onChange(setItemAmount(analysis, i, amount))} onRemove={() => remove(removeItem(analysis, i))} />
          {item.parts && item.parts.length > 0 && (
            <ul class="rv-parts" aria-label={`Lo que lleva ${item.name}`}>
              {item.parts.map((part, p) => (
                <li key={`${part.name}-${p}`}>
                  <ItemRow item={part} part onAmount={(amount) => onChange(setPartAmount(analysis, i, p, amount))} onRemove={() => remove(removePart(analysis, i, p))} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export { MAX_EDIT_AMOUNT, MIN_EDIT_AMOUNT };
