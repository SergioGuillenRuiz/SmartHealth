import type { JSX } from 'preact';
import { scaleSaved, scaleState } from '../../app/scale';
import type { ScaleSessionState } from '../../ble/scale/session';
import { EMPTY_BELOW_G, formatGrams } from '../../domain/scale';
import { netWeight } from '../../domain/scale-plate';
import { fmtUpTo1 } from '../format';
import { Icon } from '../icons';

// Lo que se ve de la báscula en vivo: el peso grande con si está quieto, una línea de estado y el botón para tomar el peso en un campo de gramos.

/** Lo que le pasa a la conexión dicho en una frase corta. */
export function scaleStatusText(state: ScaleSessionState): string {
  if (state.status === 'live') {
    if (state.reading === null) return 'Conectada. Pon algo encima.';
    return state.reading.grams < EMPTY_BELOW_G ? 'Conectada y vacía' : 'Conectada';
  }
  if (state.status === 'connecting') return 'Conectando con la báscula…';
  if (state.status === 'asleep') return state.message ?? 'Enciende la báscula (pulsa un botón o pon algo encima).';
  if (state.status === 'error') return state.message ?? 'No se puede usar el Bluetooth.';
  return 'Báscula sin conectar';
}

/** Un punto de color según cómo va la conexión (el texto de al lado dice lo mismo: el color solo no basta). */
export function ScaleDot({ status }: { status: ScaleSessionState['status'] }): JSX.Element {
  return <span class={`sc-dot sc-dot--${status}`} aria-hidden="true" />;
}

/**
 * El peso en vivo: un número grande (con el plato ya pesado restado si se pasa `baselineG`) y debajo si está quieto, pesando o vacía. El lector de pantalla oye solo el peso
 * cuando se queda quieto, no cada gramo mientras sube.
 */
export function LiveWeight({ baselineG = 0 }: { baselineG?: number }): JSX.Element {
  const state = scaleState.value;
  const reading = state.status === 'live' ? state.reading : null;
  const net = reading === null ? null : Math.max(0, reading.grams - baselineG);
  const empty = reading !== null && reading.grams < EMPTY_BELOW_G;
  const mode = reading === null ? 'none' : empty ? 'empty' : reading.stable ? 'stable' : 'moving';
  const label = mode === 'none' ? scaleStatusText(state) : mode === 'empty' ? 'Vacía' : mode === 'stable' ? 'Quieta' : 'Pesando…';
  return (
    <div class={`sc-live sc-live--${mode}`} role="group" aria-label="Peso de la báscula">
      <div class="sc-live__number" aria-hidden="true">
        <strong>{net === null ? '—' : fmtUpTo1(net)}</strong>
        <span>g</span>
      </div>
      <p class="sc-live__state">
        <ScaleDot status={state.status} />
        {label}
      </p>
      {baselineG > 0 && reading !== null && !empty && <p class="sc-live__hint">Sin contar los {formatGrams(baselineG)} ya pesados</p>}
      <p class="sr-only" role="status">
        {mode === 'stable' && net !== null ? `${fmtUpTo1(net)} gramos` : mode === 'empty' ? 'Báscula vacía' : ''}
      </p>
    </div>
  );
}

/**
 * Un botón pequeño para tomar el peso de la báscula en un campo de gramos. Solo sale si hay una báscula emparejada, viva y con algo encima; se puede pulsar cuando el peso
 * está quieto (con la báscula moviéndose, el número cambiaría al soltar). Con `baselineG` (montando un plato) toma solo lo que pesa lo nuevo, sin lo ya pesado.
 */
export function TakeFromScale({ onTake, name, baselineG = 0 }: { onTake: (grams: number) => void; name: string; baselineG?: number }): JSX.Element | null {
  const state = scaleState.value;
  const reading = state.status === 'live' ? state.reading : null;
  if (scaleSaved.value === null || reading === null) return null;
  const net = netWeight(reading.grams, baselineG).netG;
  if (net < EMPTY_BELOW_G) return null;
  return (
    <button
      type="button"
      class="sc-take"
      disabled={!reading.stable}
      aria-label={`Tomar ${fmtUpTo1(net)} gramos de la báscula para ${name}`}
      title={`Tomar ${fmtUpTo1(net)} g de la báscula`}
      onClick={() => onTake(Math.round(net * 10) / 10)}
    >
      <Icon name="Scale" size={16} />
    </button>
  );
}
