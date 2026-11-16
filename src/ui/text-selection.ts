// Nada de texto seleccionable salvo donde se escribe: al mantener pulsado sobre una gráfica, un botón o un número, el móvil no debe
// marcar palabras ni sacar el menú de copiar. El CSS (`user-select: none` en tokens.css) lo evita; esto lo cierra por si el WebView
// arranca la selección por otro camino (menú contextual, doble toque) y deja una sola excepción marcada: el detalle técnico de la
// pantalla de error (`data-selectable`), que es lo único que se puede querer copiar para contarlo.

const SELECTABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"], [data-selectable]';

interface Candidate {
  closest?: (selector: string) => unknown;
  parentElement?: Candidate | null;
}

/** ¿Es un campo donde la persona escribe (o la excepción marcada)? El objetivo de un evento puede ser un nodo de texto: se mira su elemento. */
export function allowsSelection(target: unknown): boolean {
  let node = target as Candidate | null;
  if (node && typeof node.closest !== 'function') node = node.parentElement ?? null;
  return typeof node?.closest === 'function' && node.closest(SELECTABLE) !== null;
}

/** Quita el menú contextual y el inicio de selección de todo lo que no sea un campo de texto. */
export function blockTextSelection(doc: Pick<Document, 'addEventListener'> = document): void {
  const block = (event: Event): void => {
    if (!allowsSelection(event.target)) event.preventDefault();
  };
  doc.addEventListener('contextmenu', block);
  doc.addEventListener('selectstart', block);
}
