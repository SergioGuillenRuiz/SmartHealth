import { describe, expect, it } from 'vitest';
import { draftOfProduct, foodProductOf, filterUserProducts, productKey, searchUserProducts, userProductOf, validateProductDraft, type UserProduct, type UserProductDraft } from './user-products';

const draft = (over: Partial<UserProductDraft> = {}): UserProductDraft => ({
  barcode: '8410000000016',
  name: 'Galletas de la abuela',
  kcal: 450,
  proteinG: 6,
  carbsG: 70,
  fatG: 16,
  fiberG: 3,
  sugarsG: 25,
  saltG: 0.6,
  servingG: 30,
  ...over,
});

describe('productKey', () => {
  it('quita los ceros de delante: el UPC-A y su EAN-13 son el mismo producto', () => {
    expect(productKey('036000291452')).toBe('36000291452');
    expect(productKey('0036000291452')).toBe('36000291452');
    expect(productKey('8410000000016')).toBe('8410000000016');
  });
});

describe('validateProductDraft', () => {
  it('un formulario completo y coherente no tiene problemas', () => {
    expect(validateProductDraft(draft())).toEqual([]);
    expect(validateProductDraft(draft({ proteinG: null, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, servingG: null }))).toEqual([]); // solo las calorías
  });

  it('dice qué falla, con frases', () => {
    expect(validateProductDraft(draft({ barcode: '8410000000019' }))).toContain('El código de barras no es válido.');
    expect(validateProductDraft(draft({ name: '  ' }))).toContain('Ponle un nombre al producto.');
    expect(validateProductDraft(draft({ name: 'x'.repeat(81) })).join(' ')).toMatch(/como mucho 80 letras/);
    expect(validateProductDraft(draft({ kcal: null }))).toContain('Faltan las calorías por 100 g (o 100 ml).');
    expect(validateProductDraft(draft({ kcal: -3 }))).toContain('Las calorías no pueden ser negativas.');
    expect(validateProductDraft(draft({ kcal: 1200 })).join(' ')).toMatch(/no cuadran/);
    expect(validateProductDraft(draft({ kcal: 20 })).join(' ')).toMatch(/no cuadran/); // 20 kcal con 70 g de hidratos
    expect(validateProductDraft(draft({ proteinG: -1 }))).toContain('Las proteínas no pueden ser negativas.');
    expect(validateProductDraft(draft({ sugarsG: 90 }))).toContain('Los azúcares son una parte de los hidratos: no pueden ser más que ellos.');
    expect(validateProductDraft(draft({ saltG: 60 }))).toContain('La sal por 100 g no puede pasar de 50 g.');
    expect(validateProductDraft(draft({ servingG: 0 })).join(' ')).toMatch(/entre 1 y 5\.000 g/);
  });

  it('una bebida de 0 kcal sin nada más es válida', () => {
    expect(validateProductDraft(draft({ kcal: 0, proteinG: null, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, servingG: null }))).toEqual([]);
  });
});

describe('userProductOf', () => {
  it('el producto sale con las cifras de la etiqueta, el nombre limpio y las fechas', () => {
    const product = userProductOf(draft({ name: '  Galletas   de la abuela ' }), 1_000)!;
    expect(product).toEqual({
      barcode: '8410000000016',
      name: 'Galletas de la abuela',
      per100g: { kcal: 450, proteinG: 6, carbsG: 70, fatG: 16, fiberG: 3, sugarsG: 25, saltG: 0.6 },
      servingG: 30,
      createdMs: 1_000,
      updatedMs: 1_000,
    });
  });

  it('al corregirlo conserva la fecha en que se enseñó', () => {
    const first = userProductOf(draft(), 1_000)!;
    const second = userProductOf(draft({ kcal: 460 }), 5_000, first)!;
    expect(second.createdMs).toBe(1_000);
    expect(second.updatedMs).toBe(5_000);
    expect(second.per100g.kcal).toBe(460);
  });

  it('con problemas no hay producto', () => {
    expect(userProductOf(draft({ name: '' }), 1)).toBeNull();
    expect(userProductOf(draft({ kcal: 2000 }), 1)).toBeNull();
  });

  it('la ración se redondea a gramos enteros y sin ella queda en null', () => {
    expect(userProductOf(draft({ servingG: 27.6 }), 1)!.servingG).toBe(28);
    expect(userProductOf(draft({ servingG: null }), 1)!.servingG).toBeNull();
  });
});

describe('foodProductOf y draftOfProduct', () => {
  it('un producto de la persona se ve como uno de la base, marcado como suyo', () => {
    const product = userProductOf(draft(), 1)!;
    expect(foodProductOf(product)).toEqual({ barcode: '8410000000016', name: 'Galletas de la abuela', per100g: product.per100g, servingG: 30, own: true });
  });

  it('el formulario de uno guardado lleva sus cifras (para corregirlas), también el de uno de la base', () => {
    const product = userProductOf(draft(), 1)!;
    expect(draftOfProduct(product)).toEqual(draft());
    expect(draftOfProduct({ barcode: '8410000000016', name: 'Leche', per100g: { kcal: 46, proteinG: 3.1, carbsG: 4.7, fatG: 1.6 }, servingG: null })).toMatchObject({ fiberG: null, sugarsG: null, saltG: null, servingG: null, kcal: 46 });
  });
});

describe('searchUserProducts', () => {
  const make = (name: string, updatedMs: number): UserProduct => userProductOf(draft({ name }), updatedMs)!;
  const all = [make('Galletas de la abuela', 1), make('Galletas de avena Flurbo', 3), make('Yogur de coco', 2)];

  it('vale el que lleva todas las palabras, sin tildes ni mayúsculas, con plurales', () => {
    expect(searchUserProducts(all, ['galletas']).map((p) => p.name)).toEqual(['Galletas de avena Flurbo', 'Galletas de la abuela']); // el último tocado primero
    expect(searchUserProducts(all, ['galleta', 'abuela']).map((p) => p.name)).toEqual(['Galletas de la abuela']);
    expect(searchUserProducts(all, ['YOGUR', 'cocó'.replace('ó', 'o')]).map((p) => p.name)).toEqual(['Yogur de coco']);
  });

  it('sin palabras o sin coincidencia no hay nada', () => {
    expect(searchUserProducts(all, [])).toEqual([]);
    expect(searchUserProducts(all, ['a'])).toEqual([]);
    expect(searchUserProducts(all, ['pizza'])).toEqual([]);
  });

  it('respeta el límite', () => {
    expect(searchUserProducts(all, ['galletas'], 1)).toHaveLength(1);
  });
});

describe('filterUserProducts (el buscador de «Mis productos»)', () => {
  const make = (barcode: string, name: string): UserProduct => ({ barcode, name, per100g: { kcal: 100, proteinG: 1, carbsG: 20, fatG: 1 }, servingG: null, createdMs: 1, updatedMs: 1 });
  const list = [make('8410000000016', 'Galletas de la Abuela'), make('8410000000023', 'Crema de cacahuete'), make('036000291452', 'Fideos Ñoquis')];

  it('sin nada escrito salen todos, en el mismo orden', () => {
    expect(filterUserProducts(list, '')).toEqual(list);
    expect(filterUserProducts(list, '   ')).toEqual(list);
  });

  it('busca sin tildes ni mayúsculas, en cualquier parte del nombre', () => {
    expect(filterUserProducts(list, 'ABUELA').map((p) => p.name)).toEqual(['Galletas de la Abuela']);
    expect(filterUserProducts(list, 'cacahue').map((p) => p.name)).toEqual(['Crema de cacahuete']);
    expect(filterUserProducts(list, 'noquis').map((p) => p.name)).toEqual(['Fideos Ñoquis']);
    expect(filterUserProducts(list, 'ñoquis').map((p) => p.name)).toEqual(['Fideos Ñoquis']);
  });

  it('todas las palabras tienen que estar (en cualquier orden) y también vale el código', () => {
    expect(filterUserProducts(list, 'abuela galletas')).toHaveLength(1);
    expect(filterUserProducts(list, 'galletas cacahuete')).toEqual([]);
    expect(filterUserProducts(list, '0023').map((p) => p.name)).toEqual(['Crema de cacahuete']);
    expect(filterUserProducts(list, 'crema 841').map((p) => p.name)).toEqual(['Crema de cacahuete']);
  });
});
