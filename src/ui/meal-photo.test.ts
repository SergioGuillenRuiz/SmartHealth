import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DETAIL_ARTS, MEAL_ICON_NAMES, mealArt, mealIconName } from './meal-icon';
import { hasIcon } from './icons';
import { artUrl, mealPhotoUrl, PHOTO_FILE } from './meal-photo';

const FILES = readdirSync(new URL('./food-photos/', import.meta.url))
  .filter((name) => name.endsWith('.svg'))
  .map((name) => name.replace(/\.svg$/, ''));

describe('imágenes de las comidas', () => {
  it('cada tipo de comida que reconoce `meal-icon.ts` tiene su imagen', () => {
    for (const icon of MEAL_ICON_NAMES) {
      expect(PHOTO_FILE[icon], `sin imagen para el icono «${icon}»`).toBeDefined();
      expect(mealPhotoUrl(icon), `no se encuentra la imagen de «${icon}»`).toBeTruthy();
    }
  });

  it('la tabla no apunta a archivos que no existen ni deja archivos sin usar', () => {
    // Las ilustraciones finas (`DETAIL` en `meal-icon.ts`) son archivos aparte: cuentan como usadas aunque el CI aún no las haya bajado.
    const used = new Set([...Object.values(PHOTO_FILE), ...DETAIL_ARTS.map((d) => d.art)]);
    const detail = new Set(DETAIL_ARTS.map((d) => d.art));
    for (const file of used) if (!detail.has(file)) expect(FILES, `falta food-photos/${file}.svg`).toContain(file);
    for (const file of FILES) expect(used.has(file), `food-photos/${file}.svg no lo usa nadie`).toBe(true);
    for (const icon of Object.keys(PHOTO_FILE)) expect(MEAL_ICON_NAMES, `«${icon}» ya no es un icono de comida`).toContain(icon);
  });

  it('lo que no se reconoce tiene la imagen del cubierto, y un icono que no existe no tiene ninguna', () => {
    expect(mealPhotoUrl(mealIconName('algo rarísimo que nadie ha comido'))).toBeTruthy();
    expect(mealPhotoUrl('NoExiste')).toBeNull();
  });

  it('comidas de todos los días tienen una imagen distinta según lo que son', () => {
    const photo = (name: string): string | null => mealPhotoUrl(mealIconName(name));
    expect(photo('Hamburguesa con queso')).not.toBe(photo('Ensalada de pollo'));
    expect(photo('Café con leche')).not.toBe(photo('Cerveza'));
    expect(photo('Manzana')).toBeTruthy();
  });

  it('cada ilustración fina tiene un icono de línea de repuesto que existe y una clave que no choca con las generales', () => {
    const general = new Set(Object.values(PHOTO_FILE));
    for (const { art, icon } of DETAIL_ARTS) {
      expect(hasIcon(icon), `«${art}»: el icono de repuesto «${icon}» no existe`).toBe(true);
      expect(general.has(art), `«${art}» ya es una ilustración general`).toBe(false);
    }
    expect(new Set(DETAIL_ARTS.map((d) => d.art)).size).toBe(DETAIL_ARTS.length);
  });

  it('una comida con ilustración fina la usa y, si no la hay empaquetada, la miniatura vuelve a la del tipo general', () => {
    expect(mealArt('Gofre con nata')).toEqual({ icon: 'Dessert', art: 'waffle' });
    expect(mealArt('Mango')).toEqual({ icon: 'Apple', art: 'mango' });
    expect(mealArt('Manzana')).toEqual({ icon: 'Apple', art: 'Apple' });
    expect(mealArt('Zumo de naranja')).toEqual({ icon: 'Citrus', art: 'Citrus' });
    // Sin el archivo de la fina (aún no bajada), `artUrl` da `null` y `MealThumb` usa `mealPhotoUrl(icon)`.
    expect(artUrl('no_existe')).toBeNull();
    expect(mealPhotoUrl('Dessert')).toBeTruthy();
  });
});
