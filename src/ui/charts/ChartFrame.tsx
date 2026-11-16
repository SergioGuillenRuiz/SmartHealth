import type { ComponentChildren, JSX } from 'preact';

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'rect' | 'line' | 'dash';
}

interface ChartFrameProps {
  /** Si se omite, el gráfico se nombra solo con su `aria-label` (p. ej. un minigráfico dentro de una tarjeta ya titulada). */
  title?: string;
  subtitle?: string;
  right?: ComponentChildren;
  /** Con ≥ 2 series la leyenda es obligatoria; con una sola, el título ya dice qué es. */
  legend?: LegendItem[];
  /** Mientras se recargan los datos se conserva el gráfico anterior, atenuado, sin parpadeo ni salto de layout. */
  stale?: boolean;
  children: ComponentChildren;
}

/**
 * Marco de un gráfico: título, leyenda y atenuado mientras recarga. Los datos NUNCA se ofrecen en una tabla (regla del
 * proyecto): el gráfico se nombra con un resumen en su `aria-label` y se lee con el cursor, tocando o con las flechas.
 */
export function ChartFrame({ title, subtitle, right, legend, stale, children }: ChartFrameProps): JSX.Element {
  return (
    <figure class={`chart${stale ? ' is-stale' : ''}`}>
      {(title || subtitle || right) && (
        <figcaption class="chart__head">
          <div class="chart__titles">
            {title && <h3 class="chart__title">{title}</h3>}
            {subtitle && <p class="chart__subtitle">{subtitle}</p>}
          </div>
          {right}
        </figcaption>
      )}
      {legend && legend.length >= 2 && (
        <ul class="legend" aria-label="Leyenda">
          {legend.map((item) => (
            <li key={item.label}>
              <span class={`legend__key legend__key--${item.kind ?? 'rect'}`} style={{ background: item.color }} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {children}
    </figure>
  );
}
