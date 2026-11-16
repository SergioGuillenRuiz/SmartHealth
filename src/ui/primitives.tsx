import type { ComponentChildren, JSX } from 'preact';
import type { Provenance } from '../domain/types';
import { Icon, RingIcon } from './icons';

export function Card({ children, class: className, label }: { children: ComponentChildren; class?: string; label?: string }): JSX.Element {
  return (
    <section class={`card${className ? ` ${className}` : ''}`} aria-label={label}>
      {children}
    </section>
  );
}

/**
 * Tarjeta que abre su detalle al tocarla en cualquier punto. El botón de la esquina (`MoreButton`) es lo mismo para el
 * teclado y los lectores de pantalla: su clic sube hasta la tarjeta, que es quien abre.
 */
export function TapCard({
  children,
  class: className,
  label,
  onOpen,
}: {
  children: ComponentChildren;
  class?: string;
  label: string;
  /** Recibe el clic (la tarjeta de nutrición mira de dónde viene para no girarse con un toque a sus botones). */
  onOpen: (event: MouseEvent) => void;
}): JSX.Element {
  return (
    <section class={`card card--tap${className ? ` ${className}` : ''}`} aria-label={label} onClick={onOpen}>
      {children}
    </section>
  );
}

/** La flecha de una tarjeta que se abre. Sin controlador propio: el clic lo recoge la tarjeta (`TapCard`). */
export function MoreButton({ label, class: className }: { label: string; class?: string }): JSX.Element {
  return (
    <button type="button" class={`more-btn${className ? ` ${className}` : ''}`} aria-label={label}>
      <Icon name="ChevronRight" size={18} />
    </button>
  );
}

export function CardHeader({
  icon,
  title,
  color,
  right,
}: {
  icon: string;
  title: string;
  color: string;
  right?: ComponentChildren;
}): JSX.Element {
  return (
    <header class="card__head">
      <span class="card__icon" style={{ color }}>
        <Icon name={icon} size={18} />
      </span>
      <h2 class="card__title">{title}</h2>
      <div class="card__right">{right}</div>
    </header>
  );
}

const PROVENANCE: Record<Provenance, { label: string; hint: string; icon: 'ring' | 'approx' | 'pencil' | 'pin' }> = {
  ring: { label: 'Medido', hint: 'Medido por el anillo', icon: 'ring' },
  phone: { label: 'GPS', hint: 'Medido con el GPS del móvil', icon: 'pin' },
  estimated: { label: 'Estimado', hint: 'Calculado por la app a partir de tus datos: es una estimación', icon: 'approx' },
  manual: { label: 'Manual', hint: 'Introducido por ti', icon: 'pencil' },
};

/** Procedencia del dato: medido por el anillo, estimado por la app o escrito a mano. */
export function Badge({ kind, compact }: { kind: Provenance; compact?: boolean }): JSX.Element {
  const meta = PROVENANCE[kind];
  const glyph = (
    <>
      {meta.icon === 'ring' && <RingIcon size={12} />}
      {meta.icon === 'approx' && <span aria-hidden="true">≈</span>}
      {meta.icon === 'pencil' && <Icon name="Pencil" size={11} />}
      {meta.icon === 'pin' && <Icon name="map-pin" size={11} />}
    </>
  );
  // Con texto, el propio rótulo es el nombre accesible; solo el icono suelto necesita `role="img"` para poder llevar `aria-label`.
  return compact ? (
    <span class={`badge badge--${kind}`} role="img" title={meta.hint} aria-label={meta.hint}>
      {glyph}
    </span>
  ) : (
    <span class={`badge badge--${kind}`} title={meta.hint}>
      {glyph}
      {meta.label}
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  color,
  badge,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  badge?: Provenance;
  hint?: string;
}): JSX.Element {
  return (
    <div class="stat">
      <div class="stat__label">{label}</div>
      <div class="stat__value" style={color ? { color } : undefined}>
        {value}
        {unit && <span class="stat__unit">{unit}</span>}
      </div>
      {badge && (
        <div class="stat__badge">
          <Badge kind={badge} />
        </div>
      )}
      {hint && <div class="stat__hint">{hint}</div>}
    </div>
  );
}

export interface KpiItem {
  label: string;
  value: string;
  /** Unidad, en pequeño al lado de la cifra. */
  unit?: string;
  /** Línea pequeña bajo el nombre. */
  sub?: string;
}

/** Unas pocas cifras clave de una tarjeta, en recuadros con el número grande (y su unidad pequeña) y su nombre debajo. */
export function Kpis({ items }: { items: readonly KpiItem[] }): JSX.Element {
  return (
    <dl class="kpis">
      {items.map((item) => (
        <div key={item.label}>
          <dt>
            {item.label}
            {item.sub && <small>{item.sub}</small>}
          </dt>
          <dd>
            {item.value}
            {item.unit && <small>{item.unit}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <span class="empty__icon">
        <Icon name={icon} size={26} />
      </span>
      <p class="empty__title">{title}</p>
      {children && <p class="empty__text">{children}</p>}
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
  action,
  live,
}: {
  tone?: 'info' | 'warn' | 'danger';
  children: ComponentChildren;
  action?: ComponentChildren;
  /** Anunciar a los lectores de pantalla cuando aparece (un aviso que surge solo, como «se perdió la conexión»). */
  live?: 'status' | 'alert';
}): JSX.Element {
  const icon = tone === 'info' ? 'Info' : 'TriangleAlert';
  return (
    <div class={`banner banner--${tone}`} role={live ?? (tone === 'danger' ? 'alert' : undefined)}>
      <Icon name={icon} size={18} />
      <div class="banner__text">{children}</div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  block,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Ocupa todo el ancho, con las opciones repartidas por igual. */
  block?: boolean;
}): JSX.Element {
  return (
    <div class={`segmented${block ? ' segmented--block' : ''}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          class={`segmented__item${option.value === value ? ' is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, color, label }: { value: number; color: string; label: string }): JSX.Element {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div class="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div class="bar__fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

/** No se pudieron leer los datos guardados: se dice, con un botón para reintentar (si no, la pantalla se quedaría en «Cargando…»). */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }): JSX.Element {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return (
    <Banner
      tone="danger"
      action={
        <button type="button" class="linkish" onClick={onRetry}>
          Reintentar
        </button>
      }
    >
      No se pudieron leer los datos guardados en este dispositivo{detail}.
    </Banner>
  );
}
