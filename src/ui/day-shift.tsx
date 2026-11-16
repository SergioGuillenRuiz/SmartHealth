import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { moveMealDay } from '../app/actions';
import { showToast } from '../app/state';
import { dayKeyOf, type DayKey } from '../domain/dates';
import { creditField, movedDay } from '../domain/day-credit';
import type { MealEntry } from '../domain/nutrition';
import { fmtCreditedDay } from './format';
import { useArmed } from './hooks';
import { Icon } from './icons';

/** Lo que dura armado un botón (agrandado, esperando el segundo toque) antes de volver a su tamaño. */
const ARMED_MS = 4_000;
/** Un segundo toque que llega antes de esto es un doble toque sin querer: no confirma. */
const CONFIRM_AFTER_MS = 400;

/**
 * Los dos botones para pasar una comida al día anterior (izquierda) o al siguiente (derecha). Pasarla de día cambia los totales de dos días, así que hace falta
 * **un segundo toque**: el primero agranda el botón (y cambia su nombre a «Confirmar…») para que se note, y el segundo la pasa. Si no llega, el botón vuelve a su
 * sitio solo, al perder el foco o al tocar el otro. Se apagan cuando no se puede (no se pasa a un día que aún no ha llegado ni a más de unos pocos días del día
 * en que se comió) con `aria-disabled` y no con `disabled`: un botón desactivado no recibe el toque, y entonces el toque iría a la tarjeta que lo contiene.
 */
export function DayShift({
  what,
  real,
  credited,
  today,
  onMove,
}: {
  /** De qué se trata, para los lectores de pantalla («Cena»). */
  what: string;
  /** El día en que se comió y el día para el que cuenta ahora. */
  real: DayKey;
  credited: DayKey;
  today: DayKey;
  onMove: (direction: -1 | 1) => void;
}): JSX.Element {
  const [armed, setArmed] = useState<-1 | 1 | null>(null);
  const ready = useArmed(armed !== null, CONFIRM_AFTER_MS);
  useEffect(() => {
    if (armed === null) return undefined;
    const timer = setTimeout(() => setArmed(null), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const button = (direction: -1 | 1): JSX.Element => {
    const possible = movedDay(real, credited, direction, today) !== null;
    const label = direction < 0 ? 'un día antes' : 'un día después';
    const isArmed = armed === direction;
    return (
      <button
        type="button"
        class={`day-shift__btn${isArmed ? ' is-armed' : ''}`}
        aria-label={isArmed ? `Confirmar: pasar ${what} ${label}` : `Pasar ${what} ${label}`}
        aria-disabled={!possible}
        onClick={() => {
          if (!possible) return;
          if (!isArmed) {
            setArmed(direction);
            return;
          }
          if (!ready) return; // un doble toque no confirma
          setArmed(null);
          onMove(direction);
        }}
        onBlur={() => setArmed((current) => (current === direction ? null : current))}
      >
        <Icon name={direction < 0 ? 'ChevronLeft' : 'ChevronRight'} size={18} />
      </button>
    );
  };
  return (
    <span class="day-shift" role="group" aria-label={`Pasar ${what} de día`}>
      {button(-1)}
      {button(1)}
      <span class="sr-only" role="status">
        {armed === null ? '' : 'Toca otra vez para confirmar.'}
      </span>
    </span>
  );
}

/**
 * Pasa una comida de día (y avisa a qué día cuenta ahora). Devuelve la comida como queda guardada, o `null` si no se pudo (la acción ya avisó del motivo).
 */
export async function shiftMeal(meal: MealEntry, direction: -1 | 1, today: DayKey): Promise<MealEntry | null> {
  const target = await moveMealDay(meal, direction);
  if (target === null) return null;
  showToast(`«${meal.name}» cuenta ahora para ${fmtCreditedDay(target, today)}`);
  const { day: _previous, ...rest } = meal;
  return { ...rest, ...creditField(dayKeyOf(meal.tsMs), target) };
}
