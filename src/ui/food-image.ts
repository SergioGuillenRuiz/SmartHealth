import { mealArt } from './meal-icon';
import { artUrl, mealPhotoUrl } from './meal-photo';

/** La ilustración 3D de un alimento por su nombre («pechuga de pollo», «tomate»…), o `null` si no hay ninguna (se usa dentro de dibujos SVG, donde no cabe un icono de línea). */
export function foodImageUrl(name: string): string | null {
  const { icon, art } = mealArt(name);
  return artUrl(art) ?? mealPhotoUrl(icon);
}
