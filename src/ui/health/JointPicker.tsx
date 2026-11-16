import type { JSX } from 'preact';
import { JOINT_GROUPS, jointMetricOf, type JointMetricId } from '../../domain/joint-metrics';
import { Sheet } from '../Sheet';
import { MiniBand } from './JointBlocks';

/** Unos valores de ejemplo para dibujar cada tarjeta (barras o línea): solo enseñan qué clase de gráfico es. */
const SAMPLE: ReadonlyArray<number | null> = [4, 6, 5, 8, 7, 9, 6, 8];

/**
 * El selector gráfico para añadir un bloque al gráfico de Salud: una tarjeta por cada dato que aún no está, agrupadas, con su dibujo y su color. Al elegir una se añade al
 * final y se cierra. Los datos que ya están no se ofrecen.
 */
export function JointPicker({ open, available, onPick, onClose }: { open: boolean; available: readonly JointMetricId[]; onPick: (id: JointMetricId) => void; onClose: () => void }): JSX.Element {
  return (
    <Sheet open={open} onClose={onClose} title="Añadir un gráfico" tall>
      {JOINT_GROUPS.map((group) => {
        const items = available.map(jointMetricOf).filter((metric) => metric.group === group);
        return items.length === 0 ? null : (
          <section key={group} class="jp-group" aria-label={group}>
            <h3 class="jp-group__title">{group}</h3>
            <ul class="jp-grid">
              {items.map((metric) => (
                <li key={metric.id}>
                  <button type="button" class="jp-card" aria-label={`Añadir ${metric.title}`} onClick={() => onPick(metric.id)}>
                    <MiniBand band={{ mode: metric.mode, values: SAMPLE, color: metric.color }} height={52} />
                    <strong>{metric.title}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Sheet>
  );
}
