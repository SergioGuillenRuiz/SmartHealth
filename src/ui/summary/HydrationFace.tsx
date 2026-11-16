import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { addWater, removeWater } from '../../app/actions';
import { showToast, waterSheetOpen } from '../../app/state';
import { GLASS_ML, HYDRATION_LABEL, type HydrationStatus, type WaterEntry } from '../../domain/hydration';
import { fmtClock, fmtInt } from '../format';
import { useArmed } from '../hooks';
import { Icon } from '../icons';
import { WaterDrop } from './WaterDrop';

/** Una toma de agua de la lista: la gota, los ml y la hora, y la papelera (dos toques: el segundo confirma). */
function WaterRow({ entry, confirming, onRemove, onBlur }: { entry: WaterEntry; confirming: boolean; onRemove: () => void; onBlur: () => void }): JSX.Element {
  return (
    <li>
      <span class="food-meals__item">
        <span class="meal-thumb meal-thumb--water" style={{ width: '38px', height: '38px' }} aria-hidden="true">
          <Icon name="Droplet" size={22} />
        </span>
        <span class="food-meals__main">
          <strong>{fmtInt(entry.ml)} ml</strong>
          <small>{fmtClock(entry.tsMs)}</small>
        </span>
      </span>
      <button
        type="button"
        class={`food-meals__del${confirming ? ' is-confirming' : ''}`}
        aria-label={confirming ? `Confirmar: borrar ${fmtInt(entry.ml)} ml de las ${fmtClock(entry.tsMs)}` : `Borrar ${fmtInt(entry.ml)} ml de las ${fmtClock(entry.tsMs)}`}
        onClick={onRemove}
        onBlur={onBlur}
      >
        <Icon name="Trash2" size={16} />
        {confirming && 'Borrar'}
      </button>
    </li>
  );
}

/**
 * La otra cara de la tarjeta Nutrición: el agua bebida frente a la meta en una gota que se va llenando, dos botones para anotar (un vaso o una cantidad), una línea
 * con lo que tocaría llevar a esta hora y el nivel de hidratación, y la lista de tomas del día debajo. Tiene la misma forma que la cara de la comida.
 * `canAdd` es falso en los días pasados: lo que se anota cuenta siempre para hoy.
 */
export function HydrationFace({ entries, status, canAdd }: { entries: readonly WaterEntry[]; status: HydrationStatus; canAdd: boolean }): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const armed = useArmed(confirming !== null);
  const left = status.goalMl - status.intakeMl;
  const ordered = [...entries].sort((a, b) => a.tsMs - b.tsMs);

  const remove = (entry: WaterEntry): void => {
    if (confirming !== entry.id) {
      setConfirming(entry.id);
      return;
    }
    if (!armed) return; // un doble toque no confirma
    setConfirming(null);
    void removeWater(entry).then(
      () => showToast('Toma borrada'),
      () => showToast('No se pudo borrar la toma.', 'error'),
    );
  };
  const glass = (): void => {
    void addWater(GLASS_ML).then((ok) => ok && showToast(`Un vaso anotado: ${GLASS_ML} ml`));
  };

  return (
    <>
      <div role="group" aria-label="Hidratación del día">
        <div class="food-top">
          <WaterDrop value={status.intakeMl} target={status.goalMl} label="Agua bebida" unit="ml" width={116}>
            <span class="food-top__value">{fmtInt(status.intakeMl)}</span>
            <span class="food-top__unit">de {fmtInt(status.goalMl)} ml</span>
          </WaterDrop>
          <div class="food-top__side">
            <p class="food-top__left">
              {status.intakeMl === 0 ? (
                canAdd ? (
                  'Aún no has anotado agua'
                ) : (
                  'No anotaste agua este día'
                )
              ) : left > 0 ? (
                <>
                  Te faltan <strong>{fmtInt(left)} ml</strong>
                </>
              ) : (
                <strong>Meta del día cumplida</strong>
              )}
            </p>
            {canAdd && (
              <div class="water-actions">
                <button type="button" class="food-add" onClick={glass}>
                  <Icon name="Plus" size={18} />
                  Un vaso
                </button>
                <button type="button" class="food-add food-add--ghost" onClick={() => (waterSheetOpen.value = true)}>
                  Otra cantidad
                </button>
              </div>
            )}
          </div>
        </div>

        <p class="water-status">
          <span class="water-status__expected">
            Esperado <strong>{fmtInt(status.expectedMl)} ml</strong>
          </span>
          <span class={`water-level is-${status.level}`}>
            <Icon name="Droplet" size={15} />
            {HYDRATION_LABEL[status.level]}
          </span>
        </p>
        {status.exerciseMl > 0 && (
          <p class="water-note">
            La meta incluye <strong>{fmtInt(status.exerciseMl)} ml</strong> por el ejercicio del día (sudor y respiración).
          </p>
        )}
        <p class="water-note">Estimado con lo que anotas, tu perfil, tus pasos y entrenos y la hora del día: no mide tu hidratación real.</p>
      </div>

      {ordered.length > 0 ? (
        <ul class="food-meals" aria-label="Tomas de agua del día">
          {ordered.map((entry) => (
            <WaterRow
              key={entry.id}
              entry={entry}
              confirming={confirming === entry.id}
              onRemove={() => remove(entry)}
              onBlur={() => setConfirming((current) => (current === entry.id ? null : current))}
            />
          ))}
        </ul>
      ) : (
        canAdd && <p class="food-empty">Lo que bebas hoy saldrá aquí.</p>
      )}
    </>
  );
}
