import type { JSX } from 'preact';

// Ilustraciones suaves del fondo de las tarjetas de sueño y pulso (como las de Smart Health): decorativas, sin texto y sin
// significado propio, por eso van ocultas a los lectores de pantalla y con colores muy tenues.

const common = { viewBox: '0 0 120 100', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'tile__mark' } as const;

/** Luna creciente con una ola lila: el sueño. */
export function MoonMark(): JSX.Element {
  return (
    <svg {...common}>
      <path d="M59.7 19.5A33 33 0 1 0 82.7 68.4A27 27 0 0 1 59.7 19.5z" style="stroke: var(--mark-moon)" stroke-width="8" />
      <path d="M22 80c9-9 19 7 30-1s19 5 38-7" style="stroke: var(--mark-wave)" stroke-width="6" />
    </svg>
  );
}

/** Corazón con su pulso: el ritmo cardiaco. */
export function HeartMark(): JSX.Element {
  return (
    <svg {...common}>
      <path d="M60 90C30 68 14 52 14 34c0-12 9-21 21-21 10 0 19 6 25 15 6-9 15-15 25-15 12 0 21 9 21 21 0 18-16 34-46 56z" style="stroke: var(--mark-heart)" stroke-width="9" />
      <path d="M26 50h18l8-16 14 30 9-18h19" style="stroke: var(--mark-heart)" stroke-width="7" />
    </svg>
  );
}
