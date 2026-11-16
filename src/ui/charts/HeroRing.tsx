import type { ComponentChildren, JSX } from 'preact';

const SIZE = 220;
const CENTER = SIZE / 2;
/** Radios (en unidades del dibujo): el aro de progreso, el borde y el disco. */
const TRACK_R = 108;
const BAND = 21;
const ARC_R = TRACK_R - BAND / 2;
const RIM_R = TRACK_R - BAND - 3;
const DISC_R = RIM_R - 11;

/**
 * El anillo de pasos de la tarjeta principal, como el de Smart Health: un aro claro con el progreso en verde oscuro, y dentro
 * un disco con relieve donde van las cifras. Las cifras son HTML (se leen y se escalan como el resto del texto).
 */
export function HeroRing({ value, max, label, children }: { value: number; max: number; label: string; children: ComponentChildren }): JSX.Element {
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const circumference = 2 * Math.PI * ARC_R;
  return (
    <div class="hero-ring" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <defs>
          <linearGradient id="hero-disc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style="stop-color: var(--disc-1)" />
            <stop offset="1" style="stop-color: var(--disc-2)" />
          </linearGradient>
          <radialGradient id="hero-gloss" cx="0.5" cy="0" r="0.8">
            <stop offset="0" stop-color="#fff" stop-opacity="0.2" />
            <stop offset="1" stop-color="#fff" stop-opacity="0" />
          </radialGradient>
        </defs>
        <circle cx={CENTER} cy={CENTER} r={TRACK_R} style="fill: var(--hero-track)" />
        <circle cx={CENTER} cy={CENTER} r={RIM_R} style="fill: var(--hero-rim)" />
        {fraction > 0 && (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={ARC_R}
            fill="none"
            style="stroke: var(--hero-arc)"
            stroke-width={BAND}
            stroke-linecap="round"
            stroke-dasharray={`${Math.max(0.01, circumference * fraction)} ${circumference}`}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        )}
        <circle cx={CENTER} cy={CENTER} r={DISC_R} fill="url(#hero-disc)" />
        <circle cx={CENTER} cy={CENTER} r={DISC_R} fill="url(#hero-gloss)" />
      </svg>
      <div class="hero-ring__center">{children}</div>
    </div>
  );
}
