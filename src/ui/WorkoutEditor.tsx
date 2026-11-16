import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { sportById } from '../domain/sports';
import type { WorkoutRecord } from '../domain/workout';
import { applyCorrections, contextOf, correctionProblems } from './workout-corrections';

/**
 * Correcciones manuales de un entrenamiento: distancia y calorías. Lo que se escribe aquí pasa a ser un dato
 * "manual" y sustituye a lo estimado; dejar el campo vacío vuelve a la estimación.
 */
export function WorkoutEditor({ record, onChange }: { record: WorkoutRecord; onChange: (record: WorkoutRecord, valid: boolean) => void }): JSX.Element {
  const sport = sportById(record.sport);
  // El registro tal como estaba al abrir: lo que se recupera si se escribe una corrección y luego se borra.
  const original = useRef(record).current;
  const [km, setKm] = useState(record.distanceSource === 'manual' && record.distanceM ? String(record.distanceM / 1000).replace('.', ',') : '');
  const [kcal, setKcal] = useState(record.kcalManual !== undefined ? String(record.kcalManual) : '');
  const showDistance = sport.kind !== 'other';

  const context = contextOf(record);
  const problems = correctionProblems(km, kcal, context);
  const messages = [problems.km, problems.kcal].filter((m): m is string => m !== null);

  // `valid` avisa a quien lo usa de que hay algo escrito que no vale: no debe dejar guardar hasta corregirlo o vaciarlo.
  const emit = (nextKm: string, nextKcal: string): void => {
    const next = correctionProblems(nextKm, nextKcal, context);
    onChange(applyCorrections(original, record, nextKm, nextKcal), next.km === null && next.kcal === null);
  };

  return (
    <details class="more">
      <summary>Corregir distancia o calorías</summary>
      <p class="field__hint" style={{ margin: '8px 0 12px' }}>
        Si sabes el dato real (de un ciclocomputador, de la máquina…), escríbelo: sustituye a la estimación y se marca como manual.
      </p>
      {messages.length > 0 && (
        <ul class="errors" role="alert">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div class="field-row">
        {showDistance && (
          <div class="field">
            <label for="wk-km">Distancia (km)</label>
            <input
              id="wk-km"
              class="input"
              inputMode="decimal"
              value={km}
              aria-invalid={problems.km !== null}
              placeholder="Sin corregir"
              onInput={(e) => {
                setKm(e.currentTarget.value);
                emit(e.currentTarget.value, kcal);
              }}
            />
          </div>
        )}
        <div class="field">
          <label for="wk-kcal">Calorías (kcal)</label>
          <input
            id="wk-kcal"
            class="input"
            inputMode="numeric"
            value={kcal}
            aria-invalid={problems.kcal !== null}
            placeholder="Sin corregir"
            onInput={(e) => {
              setKcal(e.currentTarget.value);
              emit(km, e.currentTarget.value);
            }}
          />
        </div>
      </div>
    </details>
  );
}
