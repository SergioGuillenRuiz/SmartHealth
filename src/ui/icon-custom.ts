import type { IconNode } from './icon-set';

// Iconos dibujados para la app donde Tabler no tiene el deporte ni la comida. Misma rejilla de 24 px, trazo de 2 y extremos redondos.

export const CUSTOM_ICONS: Readonly<Record<string, IconNode>> = {
  /** Pala de pádel (cabeza redondeada con agujeros y mango corto) inclinada, y la bola. */
  padel: [
    ['path', { d: 'M12 1.8c-3.9 0-7 3-7 7 0 2.9 1.7 5.3 4 6.3v1.6h6v-1.6c2.3-1 4-3.4 4-6.3 0-4-3.1-7-7-7z', transform: 'rotate(38 12 12)' }],
    ['path', { d: 'M10.6 16.7v4.3a1.4 1.4 0 0 0 2.8 0v-4.3', transform: 'rotate(38 12 12)' }],
    ['path', { d: 'M9.6 6.6h.01M14.4 6.6h.01M12 9.6h.01M9.6 12.2h.01M14.4 12.2h.01', transform: 'rotate(38 12 12)' }],
    ['circle', { cx: 19.4, cy: 19.2, r: 2 }],
  ],
  /** BiciMAD: la bici con el rayo de la asistencia eléctrica. */
  bicimad: [
    ['path', { d: 'M2 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0' }],
    ['path', { d: 'M16 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0' }],
    ['path', { d: 'M12 19v-4l-3 -3l5 -4l2 3h3' }],
    ['path', { d: 'M13.007 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' }],
    ['path', { d: 'M6.6 1.6 2.4 7.6h2.7L4.3 11.8 8.8 5.6H6.1z', fill: 'currentColor', stroke: 'none' }],
  ],

  /** La báscula de cocina: el cuenco sobre su pie y la base con la pantalla (la balanza de lucide es la de la justicia y no dice «cocina»). */
  'kitchen-scale': [
    ['path', { d: 'M5 8h14c0 3.2-3 5.2-7 5.2S5 11.2 5 8z' }],
    ['path', { d: 'M12 13.2V16' }],
    ['rect', { x: 3, y: 16, width: 18, height: 5, rx: 2 }],
    ['path', { d: 'M9 18.5h6' }],
  ],

  // ───────────── cómo está lo que se pesa (`domain/food-prep.ts`): cinco dibujos que se distinguen de un vistazo ─────────────
  /** Crudo: una hoja con su nervio. */
  'prep-raw': [
    ['path', { d: 'M5 19C5 10.5 10 5 19.5 4.5 19 14 13.5 19 5 19z' }],
    ['path', { d: 'M5 19 13 11' }],
  ],
  /** Cocido: la olla con sus asas y el vapor. */
  'prep-boiled': [
    ['path', { d: 'M4 11h16v5.5a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5V11z' }],
    ['path', { d: 'M2 12.5h2M20 12.5h2' }],
    ['path', { d: 'M8.5 4.5c0 1.5 1.3 1.7 1.3 3.2M13 3.5c0 1.5 1.3 1.7 1.3 3.2' }],
  ],
  /** A la plancha: la sartén baja con su mango y el calor que sube. */
  'prep-pan': [
    ['path', { d: 'M3 13h14v2.5A3.5 3.5 0 0 1 13.5 19h-7A3.5 3.5 0 0 1 3 15.5V13z' }],
    ['path', { d: 'M17 14h5' }],
    ['path', { d: 'M7 4.5c-1 1.3 1 2.3 0 3.6M11 4.5c-1 1.3 1 2.3 0 3.6M15 4.5c-1 1.3 1 2.3 0 3.6' }],
  ],
  /** Al horno: la puerta con su ventana y los mandos. */
  'prep-oven': [
    ['rect', { x: 3, y: 3.5, width: 18, height: 17, rx: 2.5 }],
    ['path', { d: 'M3 8.5h18' }],
    ['rect', { x: 6.5, y: 11, width: 11, height: 6, rx: 1.2 }],
    ['path', { d: 'M7 6h.01M10 6h.01' }],
  ],
  /** Frito: el cucurucho de patatas. */
  'prep-fried': [
    ['path', { d: 'M5.5 11 7 20.5h10L18.5 11z' }],
    ['path', { d: 'M8.5 11V5.5M12 11V4M15.5 11V5.5' }],
  ],

  // ───────────── comida (ver `meal-icon.ts`): lo que ni lucide ni Tabler dibujan ─────────────
  /** Un tomate: el fruto redondo con el rabito y dos hojas. */
  tomato: [
    ['path', { d: 'M12 6.6c-3.9-.1-8 2.1-8 7 0 3.7 3.5 6.9 8 6.9s8-3.2 8-6.9c0-4.9-4.1-7.1-8-7z' }],
    ['path', { d: 'M12 6.6V3.4' }],
    ['path', { d: 'M12 6.6 8.2 5.2M12 6.6l3.8-1.4' }],
  ],
  /** Una patata: el tubérculo irregular con sus ojos. */
  potato: [
    ['path', { d: 'M5.2 9.4c1.4-3.2 5-5.2 8.7-4.5 3.9.7 6.6 3.9 5 8.1-1.6 4.1-6.1 7.1-10 6.3-3.9-.8-5.1-6.1-3.7-9.9z' }],
    ['path', { d: 'M9.6 9.6h.01M13.6 8.6h.01M13.8 13.2h.01M9.2 13.8h.01' }],
  ],
  /** Un brócoli: la copa de ramilletes sobre el tallo. */
  broccoli: [
    ['path', { d: 'M7.6 12.2A3.6 3.6 0 0 1 5.6 6a3.9 3.9 0 0 1 5.4-2 3.9 3.9 0 0 1 7.4 1.7 3.6 3.6 0 0 1-1.6 6.5' }],
    ['path', { d: 'M7.6 12.2h8.8' }],
    ['path', { d: 'M10 12.2v7.4a1.4 1.4 0 0 0 1.4 1.4h1.2a1.4 1.4 0 0 0 1.4-1.4v-7.4' }],
    ['path', { d: 'M10 8.2l1.2 1.4M14.4 7.4l-1.4 1.6' }],
  ],
  /** Una fresa: con su cáliz y las pepitas. */
  strawberry: [
    ['path', { d: 'M12 21.2c-4.2-2.3-7-6-7-9.6C5 8.6 7.7 7 12 7s7 1.6 7 4.6c0 3.6-2.8 7.3-7 9.6z' }],
    ['path', { d: 'M12 7V3.6M12 7 8.2 5.2M12 7l3.8-1.8' }],
    ['path', { d: 'M9.3 11h.01M14.7 11h.01M12 13.4h.01M9.8 16h.01M14.2 16h.01' }],
  ],
  /** Una rodaja de sandía: la media luna con la corteza y las pepitas. */
  watermelon: [
    ['path', { d: 'M2.5 9.5h19a9.5 9.5 0 0 1-19 0z' }],
    ['path', { d: 'M5.8 9.5a6.2 6.2 0 0 0 12.4 0' }],
    ['path', { d: 'M9.5 12.4h.01M14.5 12.4h.01M12 15h.01' }],
  ],
  /** Una piña: el cuerpo con su rejilla y la corona de hojas. */
  pineapple: [
    ['path', { d: 'M7.2 14.6c0-3.2 2-5.7 4.8-5.7s4.8 2.5 4.8 5.7c0 3.5-2 6.4-4.8 6.4s-4.8-2.9-4.8-6.4z' }],
    ['path', { d: 'M12 8.9C12 6.2 10.3 4.4 8.4 3.6M12 8.9c0-2.7 1.7-4.5 3.6-5.3M12 8.9V2.5' }],
    ['path', { d: 'M8.7 12.6l6.6 6.9M15.3 12.6l-6.6 6.9' }],
  ],
  /** Patatas fritas: el cartucho con los palitos asomando. */
  fries: [
    ['path', { d: 'M6.8 11h10.4l-1.1 8.9a1.2 1.2 0 0 1-1.2 1.1H9.1a1.2 1.2 0 0 1-1.2-1.1z' }],
    ['path', { d: 'M8.6 11 8 5.2M11 11V3.4M13.2 11l.5-6.8M15.6 11l1-5' }],
  ],
  /** Un kebab: el cono de carne en su espetón. */
  kebab: [
    ['path', { d: 'M7 4.6c1.7.7 8.3.7 10 0l-2.4 14.2c-1.5.6-3.7.6-5.2 0z' }],
    ['path', { d: 'M12 2v2.5M12 19v3' }],
    ['path', { d: 'M8.1 9.3c2.5.8 5.3.8 7.8 0M8.9 13.9c2 .6 4.2.6 6.2 0' }],
  ],
  /** Un wrap o un burrito: el rollo en diagonal, con el papel que lo sujeta. */
  wrap: [
    ['rect', { x: 2.2, y: 8.6, width: 19.6, height: 6.8, rx: 3.4, transform: 'rotate(-40 12 12)' }],
    ['path', { d: 'M5.8 19.6 9 16.4M7.4 21l3.2-3.2' }],
    ['path', { d: 'M15.5 8.7l1.2-1.2M13.6 6.8l1.2-1.2' }],
  ],
  /** Un plato de pasta: el bol con los espaguetis enrollados y el vapor. */
  pasta: [
    ['path', { d: 'M2.8 13.2h18.4a9.2 6.4 0 0 1-18.4 0z' }],
    ['path', { d: 'M6 13.2c.4-2.4 1.6-3.6 3.2-3.6s2 1.4 3 1.4 1.8-1.5 3.3-1.5 2.4 1.3 2.5 3.7' }],
    ['path', { d: 'M8 10.2c0-2.2 1.3-3.6 3.2-4M12 9.6c.3-2 1.6-3.4 3.4-3.6' }],
  ],
  /** Arroz: el bol con el montículo de granos. */
  rice: [
    ['path', { d: 'M3.5 12.5h17a8.5 7.5 0 0 1-17 0z' }],
    ['path', { d: 'M6.2 12.5a5.8 5.2 0 0 1 11.6 0' }],
    ['path', { d: 'M9.6 9.8h.01M12.2 8.2h.01M14.4 9.9h.01M12 10.8h.01' }],
  ],
};
