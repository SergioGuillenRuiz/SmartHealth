import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { savedDishes } from '../app/state';
import { Icon } from './icons';
import { mealArt } from './meal-icon';
import { artUrl, mealPhotoUrl } from './meal-photo';
import { useProductImage } from './use-product-image';

/**
 * La miniatura de una comida, de lo más parecido a lo más general: la foto del plato guardado con el que se anotó (`dishId`; la que sacó la persona manda sobre todo lo demás), la foto del producto de Open Food Facts si la comida se anotó con su código de barras y hay conexión
 * (`app/product-image.ts`; si no, no se dice nada y se sigue); la ilustración 3D de lo que es (ver `meal-icon.ts`: una fina —un gofre, un mango— si la hay y, si no, la del tipo
 * general); y, si no hay ninguna, su icono de línea. Es decorativa: el nombre de la comida ya está escrito al lado.
 */
export function MealThumb({ name, size = 38, barcode, dishId }: { name: string; size?: number; barcode?: string | undefined; dishId?: string | undefined }): JSX.Element {
  const product = useProductImage(barcode);
  // La foto del plato guardado: prioridad máxima. Si el plato se borró o no tiene foto, se sigue con lo demás.
  const dishPhoto = dishId === undefined ? undefined : savedDishes.value.find((dish) => dish.id === dishId)?.photo;
  // Una foto que no llega a cargar (la conexión se cae a medias) se deja: vuelve la ilustración, sin avisos.
  const [broken, setBroken] = useState<string | null>(null);
  const box = { width: `${size}px`, height: `${size}px` };
  if (dishPhoto !== undefined) {
    return (
      <span class="meal-thumb meal-thumb--dish" style={box} aria-hidden="true">
        <img src={dishPhoto} alt="" width={size} height={size} decoding="async" draggable={false} />
      </span>
    );
  }
  if (product !== null && broken !== product) {
    return (
      <span class="meal-thumb meal-thumb--product" style={box} aria-hidden="true">
        <img src={product} alt="" width={size} height={size} decoding="async" loading="lazy" referrerpolicy="no-referrer" draggable={false} onError={() => setBroken(product)} />
      </span>
    );
  }
  const { icon, art } = mealArt(name);
  const photo = artUrl(art) ?? mealPhotoUrl(icon);
  return (
    <span class="meal-thumb" style={box} aria-hidden="true">
      {photo ? <img src={photo} alt="" width={size} height={size} decoding="async" draggable={false} /> : <Icon name={icon} size={Math.round(size * 0.58)} />}
    </span>
  );
}
