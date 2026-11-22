// Ajuste de una hoja al alto que hay: que se vea entera, sin deslizar, siempre que sobre poco.
//
// Una hoja ocupa como mucho el alto de la pantalla. Cuando su contenido se pasa por poco (una fila, dos líneas de más) obligar a deslizar
// por unos píxeles es lo peor de los dos mundos: la persona no ve que hay más abajo y se pierde lo último. Aquí se reduce el contenido lo
// justo (hasta `FIT_MIN`, un 12 %) para que quepa; si sobra más que eso es que hay mucha información y se deja a su tamaño, con scroll.

/** Lo máximo que se reduce un contenido para que quepa: por debajo de esto, el texto pequeño ya no se lee bien. */
export const FIT_MIN = 0.88;

/**
 * La escala (entre `min` y 1) con la que un contenido de `contentPx` de alto cabe en `availablePx`; 1 si ya cabe, o si habría que
 * reducirlo más de la cuenta (entonces no se toca: que se deslice).
 */
export function fitScale(contentPx: number, availablePx: number, min: number = FIT_MIN): number {
  if (!(availablePx > 0) || !(contentPx > availablePx)) return 1;
  const needed = availablePx / contentPx;
  return needed >= min - 1e-9 ? Math.max(needed, min) : 1;
}

/** Los píxeles que caben de contenido en la zona que desliza (sin su relleno). */
function availableHeight(body: HTMLElement): number {
  const style = getComputedStyle(body);
  return body.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
}

/** Quita la reducción: el contenido vuelve a su tamaño. */
function reset(box: HTMLElement, inner: HTMLElement): void {
  inner.style.transform = '';
  inner.style.width = '';
  box.style.height = '';
}

/**
 * Reduce `inner` (el contenido de la hoja) lo justo para que quepa en `body` (la zona que desliza). La reducción es una transformación (`scale`) con el ancho ampliado en la
 * misma proporción, así que el texto se recoloca como si la hoja fuese más ancha y luego se ve al tamaño de la hoja; `box` toma el alto ya reducido. (Con `zoom` también
 * cabía, pero cambia lo que miden los elementos y las herramientas de accesibilidad y de pruebas no aciertan a pulsar los controles.) Como reducir recoloca el texto (hay líneas
 * que ya no se parten), la escala se afina en un par de pasadas; si aun así no cabe, se quita y se deja el scroll.
 */
export function fitToSheet(body: HTMLElement, inner: HTMLElement, box: HTMLElement): void {
  reset(box, inner);
  const available = availableHeight(body);
  let scale = fitScale(inner.offsetHeight, available);
  if (scale === 1) return;
  for (let pass = 0; pass < 3; pass++) {
    inner.style.width = `${(100 / scale).toFixed(3)}%`;
    inner.style.transform = `scale(${scale.toFixed(4)})`;
    const height = inner.offsetHeight * scale;
    box.style.height = `${height.toFixed(2)}px`;
    if (height <= available + 0.5) return;
    const next = fitScale(height, available, FIT_MIN / scale);
    if (next === 1) break;
    scale = Math.max(FIT_MIN, scale * next - 0.002);
  }
  reset(box, inner);
}
