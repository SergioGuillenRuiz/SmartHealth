import type { ComponentChildren, JSX } from 'preact';
import { Icon } from './icons';

/** Un número que se sube y se baja de paso en paso (objetivos): más fiable con el pulgar que escribirlo. */
export function Stepper({
  id,
  label,
  value,
  step,
  min,
  max,
  format,
  hint,
  children,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  format: (value: number) => string;
  /** Una línea que explica qué cambia el número, debajo del control. */
  hint?: string;
  /** Lo que acompaña al control dentro del mismo campo (avisos, un botón). */
  children?: ComponentChildren;
  onChange: (value: number) => void;
}): JSX.Element {
  const clamp = (v: number): number => Math.max(min, Math.min(max, v));
  return (
    <div class="field">
      <span class="field__label" id={`${id}-l`}>
        {label}
      </span>
      <div class="stepper" role="group" aria-labelledby={`${id}-l`}>
        <button type="button" class="icon-btn" aria-label={`Bajar ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          <Icon name="ChevronLeft" size={20} />
        </button>
        <output class="stepper__value" aria-live="polite">
          {format(value)}
        </output>
        <button type="button" class="icon-btn" aria-label={`Subir ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
          <Icon name="ChevronRight" size={20} />
        </button>
      </div>
      {hint && <span class="field__hint">{hint}</span>}
      {children}
    </div>
  );
}
