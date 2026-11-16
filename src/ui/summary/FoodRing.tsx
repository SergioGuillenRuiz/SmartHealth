import type { ComponentChildren, JSX } from 'preact';
import { fractionOf } from '../../domain/nutrition';
import { fmtInt } from '../format';
import { Icon } from '../icons';

/**
 * Un anillo de lo comido frente a su meta: se llena al llegar a ella y, si se pasa de largo, se pinta de rojo y lleva encima un triangulito de aviso que
 * late (sin texto: el lector de pantalla ya oye «por encima de lo propuesto» en el propio medidor). Lleva su cifra dentro (HTML, para que se lea y escale
 * como el resto del texto) y es un `meter` para los lectores de pantalla.
 */
export function FoodRing({
  value,
  target,
  label,
  unit,
  color,
  size,
  stroke,
  warnOver = true,
  overLabel = 'por encima de lo propuesto',
  children,
}: {
  value: number;
  target: number;
  label: string;
  unit: string;
  color: string;
  size: number;
  stroke: number;
  /** Si lo que pasa de la meta se pinta de rojo (para lo comido; el agua no se «pasa»). */
  warnOver?: boolean;
  /** Lo que dice el lector de pantalla cuando se pasa de la meta (la sal es un máximo, no una meta). */
  overLabel?: string;
  children: ComponentChildren;
}): JSX.Element {
  const fraction = fractionOf(value, target);
  const over = warnOver && target > 0 && value > target * 1.05;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      class={`food-ring${over ? ' is-over' : ''}`}
      style={{ width: `${size}px`, height: `${size}px`, '--ring': color }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(target)}
      aria-valuenow={Math.round(Math.min(value, target))}
      aria-valuetext={`${fmtInt(value)} de ${fmtInt(target)} ${unit}${over ? `, ${overLabel}` : ''}`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle class="food-ring__track" cx={size / 2} cy={size / 2} r={radius} fill="none" stroke-width={stroke} />
        {fraction > 0 && (
          <circle
            class="food-ring__arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke-width={stroke}
            stroke-linecap="round"
            stroke-dasharray={`${Math.max(0.01, circumference * fraction)} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div class="food-ring__center">{children}</div>
      {over && (
        <span class={`food-ring__warn${size >= 100 ? ' food-ring__warn--big' : ''}`} aria-hidden="true">
          <Icon name="TriangleAlert" size={size >= 100 ? 20 : 15} strokeWidth={2.4} />
        </span>
      )}
    </div>
  );
}
