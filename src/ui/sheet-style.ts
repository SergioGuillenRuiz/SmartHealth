// La versión del aspecto de las hojas inferiores (menús). La 2 es la de la ronda 53: un mismo lenguaje para todas, el de la hoja de pesar con la báscula (`styles/sheets-v2.css`). La 1 es el
// aspecto anterior, que sigue entero en `styles/app.css`: para volver a él basta poner 1. Una versión nueva se añade como `sheets-v3.css` (reglas bajo `:root[data-sheets='3']`) y se cambia
// esta constante: ninguna se borra, así se pueden comparar y alternar.
export const SHEET_STYLE: 1 | 2 = 2;

/** Marca en <html> la versión elegida (los estilos de `sheets-v2.css` solo valen con `data-sheets="2"`). */
export function applySheetStyle(root: HTMLElement = document.documentElement): void {
  root.dataset.sheets = String(SHEET_STYLE);
}
