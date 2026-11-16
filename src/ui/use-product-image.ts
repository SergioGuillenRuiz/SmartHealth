import { useEffect, useState } from 'preact/hooks';
import { knownProductImage, productImageUrl } from '../app/product-image';

/** La foto de Open Food Facts del producto con ese código (`app/product-image.ts`), o `null` mientras se pregunta, si no la hay o si no hay conexión: nunca avisa de nada. */
export function useProductImage(barcode: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (barcode ? (knownProductImage(barcode) ?? null) : null));
  useEffect(() => {
    if (!barcode) {
      setUrl(null);
      return undefined;
    }
    const known = knownProductImage(barcode);
    if (known !== undefined) {
      setUrl(known);
      return undefined;
    }
    let live = true;
    void productImageUrl(barcode).then((found) => {
      if (live) setUrl(found);
    });
    return () => {
      live = false;
    };
  }, [barcode]);
  return url;
}
