import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { addWater } from '../app/actions';
import { showToast, waterSheetOpen } from '../app/state';
import { MAX_WATER_ML, MIN_WATER_ML } from '../domain/hydration';
import { fmtInt } from './format';
import { parseVolumeMl } from './parse';
import { Sheet } from './Sheet';

// «Otra cantidad» de agua: se escribe lo que se ha bebido (300, 300 ml, 33 cl, 0,5 l…) y se anota ahora. Unas cantidades de uso común rellenan el campo.

const QUICK_ML = [200, 330, 500, 750] as const;

export function WaterSheet(): JSX.Element {
  const open = waterSheetOpen.value;
  return (
    <Sheet open={open} onClose={() => (waterSheetOpen.value = false)} title="Anotar agua">
      {open && <WaterForm />}
    </Sheet>
  );
}

function WaterForm(): JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [text]);

  const submit = (event: Event): void => {
    event.preventDefault();
    const ml = parseVolumeMl(text);
    if (ml === null) {
      setError('Escribe la cantidad, por ejemplo 300, 33 cl o 0,5 l.');
      return;
    }
    if (ml < MIN_WATER_ML || ml > MAX_WATER_ML) {
      setError(`Una toma tiene que estar entre ${MIN_WATER_ML} y ${fmtInt(MAX_WATER_ML)} ml.`);
      return;
    }
    setBusy(true);
    void addWater(ml).then((ok) => {
      setBusy(false);
      if (!ok) return;
      waterSheetOpen.value = false;
      showToast(`Agua anotada: ${fmtInt(ml)} ml`);
    });
  };

  return (
    <form class="water-form" onSubmit={submit} noValidate>
      <div class="field">
        <label for="water-amount">Cantidad (ml)</label>
        <input
          id="water-amount"
          class="input"
          inputMode="decimal"
          autocomplete="off"
          value={text}
          aria-invalid={error !== null}
          aria-describedby={error ? 'water-error' : undefined}
          placeholder="Por ejemplo, 300"
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <p class="field__hint">También vale 33 cl o 0,5 l.</p>
      </div>
      <div class="water-quick" role="group" aria-label="Cantidades habituales">
        {QUICK_ML.map((ml) => (
          <button key={ml} type="button" class="chip" onClick={() => setText(String(ml))}>
            {fmtInt(ml)} ml
          </button>
        ))}
      </div>
      {error && (
        <div class="errors errors--box" role="alert">
          <ul>
            <li id="water-error">{error}</li>
          </ul>
        </div>
      )}
      <div class="btn-row" style={{ marginTop: '16px' }}>
        <button type="submit" class="btn btn--primary" disabled={busy}>
          Anotar
        </button>
      </div>
    </form>
  );
}
