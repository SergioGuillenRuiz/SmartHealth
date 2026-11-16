import { WALKING_KEY, type ActivityPart } from '../domain/breakdown';
import { sportById, type SportId } from '../domain/sports';

/** Lo que tiene color propio: los deportes, andar fuera de entrenos y «Otros» (los retirados y desconocidos). */
export type ActivityId = SportId | 'walking' | 'other';

/** Icono de una parte del día: andar usa el de «Caminar». */
export const partIcon = (part: Pick<ActivityPart, 'sport'>): string => sportById(part.sport === WALKING_KEY ? 'walk' : part.sport).icon;

/**
 * Color de cada deporte: [claro, oscuro]. Se mezclan en el degradado de la «medalla» (el icono va en blanco encima). El
 * color nunca es lo único que identifica un deporte: la medalla lleva su icono y al lado va su nombre.
 */
export const TINTS: Readonly<Record<ActivityId, readonly [string, string]>> = {
  walking: ['#2ea878', '#178a60'],
  walk: ['#1f8f66', '#0e6b48'],
  run: ['#ee8434', '#cf5f10'],
  hike: ['#b08a4a', '#8c6a2c'],
  cycle: ['#3f9be8', '#1f74cc'],
  bicimad: ['#ee5c6c', '#d1344a'],
  swim: ['#25a8cf', '#107fa6'],
  gym: ['#8f74e6', '#6a4bcf'],
  yoga: ['#d46fc0', '#b24a9e'],
  football: ['#4caa57', '#2f8a3b'],
  basketball: ['#f0a81f', '#c47f00'],
  tennis: ['#1fa6a0', '#0f7f7a'],
  padel: ['#5a78e0', '#3f58c4'],
  // «Otros» y los deportes retirados (que ya no se ofrecen): grises apagados.
  other: ['#8a9a95', '#66766f'],
  hiit: ['#8a9a95', '#66766f'],
  badminton: ['#8a9a95', '#66766f'],
  tabletennis: ['#8a9a95', '#66766f'],
  rope: ['#8a9a95', '#66766f'],
  elliptical: ['#8a9a95', '#66766f'],
  rowing: ['#8a9a95', '#66766f'],
  dance: ['#8a9a95', '#66766f'],
};

const tints = (id: string): readonly [string, string] => TINTS[id as ActivityId] ?? TINTS.other;

/** Valor de `background` para la medalla de un deporte (un id desconocido se ve como «Otros»). */
export function sportBackground(id: string): string {
  const [from, to] = tints(id);
  return `linear-gradient(145deg, ${from}, ${to})`;
}
