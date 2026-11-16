/**
 * Si al cerrar una hoja o una pantalla el foco se ha perdido (el botón que la abrió ya no existe y el navegador lo deja
 * en `<body>`), lo lleva a la pestaña activa de la barra inferior: quien navega con teclado o lector de pantalla no debe
 * quedarse sin un punto de partida.
 */
export function recoverLostFocus(): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    document.querySelector<HTMLElement>('nav [aria-current="page"]')?.focus();
  }, 0);
}
