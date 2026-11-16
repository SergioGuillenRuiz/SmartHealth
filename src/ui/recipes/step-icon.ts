import type { CookAction } from '../../domain/recipes';
import type { IconName } from '../icons';

// El icono de cada paso de una receta: una línea del mismo trazo que el resto de la app (los de «Cómo está» del paso de pesar, los de Lucide y los de Tabler que ya lleva), en vez de una escena
// dibujada. Hasta la ronda 54 cada paso llevaba una ilustración (`CookScene`) y el plato de la receta otra; se quitaron por no alcanzar la calidad deseada.
export const STEP_ICON: Readonly<Record<CookAction, IconName | string>> = {
  cut: 'Slice',
  boil: 'prep-boiled',
  saute: 'prep-pan',
  bake: 'prep-oven',
  mix: 'bowl-spoon',
  toast: 'bread',
  blend: 'Blend',
  plate: 'Utensils',
  drain: 'Droplets',
  wait: 'Timer',
  season: 'salt',
  spread: 'jar',
};

/** Una palabra corta para quien no ve el icono (el icono es decorativo, pero la acción también se dice en el texto del paso). */
export const STEP_WORD: Readonly<Record<CookAction, string>> = {
  cut: 'Cortar',
  boil: 'Cocer',
  saute: 'Saltear',
  bake: 'Hornear',
  mix: 'Mezclar',
  toast: 'Tostar',
  blend: 'Triturar',
  plate: 'Servir',
  drain: 'Escurrir',
  wait: 'Esperar',
  season: 'Sazonar',
  spread: 'Untar',
};
