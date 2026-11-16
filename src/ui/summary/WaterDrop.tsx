import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { fractionOf } from '../../domain/nutrition';
import { fmtInt } from '../format';

/** El dibujo de la gota (viewBox 100 × 116): una punta arriba y un vientre ancho y redondo, para que quepa la cifra. */
const DROP = 'M50 4 C50 4 8 44 8 70 A42 42 0 0 0 92 70 C92 44 50 4 50 4 Z';
/** De la punta (y = 4) al fondo (y = 108) de la gota: lo que mide el nivel del agua. */
const TOP = 4;
const BOTTOM = 112;
const HEIGHT = BOTTOM - TOP;

let seq = 0;

/**
 * El agua bebida frente a su meta, en una gota translúcida que se va llenando. Es ancha y baja (el vientre da sitio a la cifra, que va dentro como HTML para que se lea y
 * escale como el resto del texto) y limpia: solo el contorno, el cristal y el agua. Es un `meter` para los lectores de pantalla.
 */
export function WaterDrop({
  value,
  target,
  label,
  unit,
  width,
  children,
}: {
  value: number;
  target: number;
  label: string;
  unit: string;
  /** Ancho en px: el alto sale de la forma (116/100). */
  width: number;
  children: ComponentChildren;
}): JSX.Element {
  // Un identificador propio para el recorte: dos gotas en la misma página no pueden compartirlo.
  const id = useRef(`water-drop-${++seq}`).current;
  const fraction = fractionOf(value, target);
  const levelY = BOTTOM - fraction * HEIGHT;
  return (
    <div
      class="water-drop"
      style={{ width: `${width}px`, height: `${Math.round((width * 116) / 100)}px` }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(target)}
      aria-valuenow={Math.round(Math.min(value, target))}
      aria-valuetext={`${fmtInt(value)} de ${fmtInt(target)} ${unit}`}
    >
      <svg viewBox="0 0 100 116" aria-hidden="true">
        <defs>
          <clipPath id={id}>
            <path d={DROP} />
          </clipPath>
        </defs>
        <path class="water-drop__glass" d={DROP} />
        <g clip-path={`url(#${id})`}>
          {fraction > 0 && (
            <g class="water-drop__level" style={{ transform: `translateY(${levelY}px)` }}>
              <path d="M-120 0 Q-105 -2.5 -90 0 T-60 0 T-30 0 T0 0 T30 0 T60 0 T90 0 T120 0 T150 0 T180 0 T210 0 T240 0 V130 H-120 Z" />
            </g>
          )}
        </g>
        <path class="water-drop__edge" d={DROP} />
      </svg>
      <div class="water-drop__center">{children}</div>
    </div>
  );
}
