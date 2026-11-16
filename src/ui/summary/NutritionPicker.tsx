import type { JSX } from 'preact';
import { panelIndicatorOf, type PanelIndicatorId } from '../../domain/nutrition-panel';
import { Sheet } from '../Sheet';

/** El selector para añadir un indicador al panel de Nutrición: una tarjeta por cada uno que aún no está, con su color y una frase de qué mide. Al elegir uno se añade al final y se cierra. */
export function NutritionPicker({ open, available, onPick, onClose }: { open: boolean; available: readonly PanelIndicatorId[]; onPick: (id: PanelIndicatorId) => void; onClose: () => void }): JSX.Element {
  return (
    <Sheet open={open} onClose={onClose} title="Añadir un indicador">
      <ul class="np-list" aria-label="Indicadores que faltan">
        {available.map(panelIndicatorOf).map((indicator) => (
          <li key={indicator.id}>
            <button type="button" class="np-card" aria-label={`Añadir ${indicator.label}`} onClick={() => onPick(indicator.id)}>
              <span class="np-card__dot" style={{ background: indicator.color }} aria-hidden="true" />
              <span class="np-card__text">
                <strong>{indicator.label}</strong>
                <small>{indicator.hint}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
