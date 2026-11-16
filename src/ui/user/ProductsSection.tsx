import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { refreshProducts, removeUserProduct } from '../../app/actions';
import { savedProducts, showToast } from '../../app/state';
import { draftOfProduct, filterUserProducts, type UserProduct } from '../../domain/user-products';
import { fmtUpTo1 } from '../format';
import { Icon } from '../icons';
import { ForgetProduct, ProductForm } from '../product-form';

// «Mis productos» (menú de perfil): los productos que la persona le ha enseñado a la app con lo que pone su etiqueta. Se ven en una lista (con buscador cuando son muchos),
// se abren para corregirlos u olvidarlos y se pueden dar de alta aquí mismo tecleando el código. Se guardan en el móvil y van en la copia de seguridad.

type View = { name: 'list' } | { name: 'edit'; product: UserProduct };

/** A partir de cuántos productos sale el buscador. */
const SEARCH_FROM = 6;

export function ProductsSection(): JSX.Element {
  const [view, setView] = useState<View>({ name: 'list' });
  const [query, setQuery] = useState('');
  const products = savedProducts.value;
  useEffect(() => {
    void refreshProducts();
  }, []);
  const toList = (): void => setView({ name: 'list' });

  if (view.name === 'edit') {
    const { product } = view;
    return (
      <div>
        <ProductForm initial={draftOfProduct(product)} editing onSaved={toList} onCancel={toList} />
        <div class="meal__quick">
          <ForgetProduct
            onForget={() =>
              void removeUserProduct(product.barcode).then((done) => {
                if (!done) return;
                showToast('Producto olvidado: la próxima vez saldrá el de la base, si está.');
                toList();
              })
            }
          />
        </div>
      </div>
    );
  }

  const shown = products === null ? [] : filterUserProducts(products, query);
  return (
    <div>
      {products !== null && products.length === 0 && <p class="field__hint">Todavía no tienes ninguno. Se añaden al escanear un código que no esté en la base.</p>}
      {products !== null && products.length >= SEARCH_FROM && (
        <div class="field">
          <label for="products-search">Buscar en mis productos</label>
          <input id="products-search" class="input" type="search" autocomplete="off" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      )}
      {products !== null && products.length > 0 && (
        <>
          <ul class="menu" aria-label="Mis productos">
            {shown.map((product) => (
              <li key={product.barcode}>
                <button type="button" class="menu-row" onClick={() => setView({ name: 'edit', product })}>
                  <span class="menu-row__icon" style={{ color: 'var(--kcal)' }}>
                    <Icon name="ScanBarcode" size={20} />
                  </span>
                  <span class="menu-row__main">
                    <strong>{product.name}</strong>
                    <small>
                      {fmtUpTo1(product.per100g.kcal)} kcal por 100 g · código {product.barcode}
                    </small>
                  </span>
                  <Icon name="ChevronRight" size={18} />
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            <p class="field__hint" role="status">
              Ningún producto coincide con «{query.trim()}».
            </p>
          )}
        </>
      )}
    </div>
  );
}
