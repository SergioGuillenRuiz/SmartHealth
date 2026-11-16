// La «foto» de mentira de las pruebas del localizador y del lector: papel con un poco de grano, una «tabla» de nueve filas de trazos (como líneas de texto) y un código de barras.
export const W = 640;
export const H = 360;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Una escena en grises (un byte por píxel): papel de `paper`, tinta de `ink`, grano de `noise`. `table` es dónde está la tabla. */
export function scene(paper: number, ink: number, noise = 6): { gray: Uint8Array; table: Box } {
  const gray = new Uint8Array(W * H);
  let seed = 7;
  const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, paper + (random() - 0.5) * 2 * noise));
  const table: Box = { x0: 200, y0: 90, x1: 440, y1: 90 + 9 * 24 };
  for (let row = 0; row < 9; row++) {
    const y = 96 + row * 24;
    for (let x = 210; x < 430; x += 11) {
      // Trazos de 8 px con huecos de 3 px y de altura 9: lo que hace una línea de letras pequeñas.
      if (row % 3 === 2 && x > 330) continue;
      for (let dy = 0; dy < 9; dy++) for (let dx = 0; dx < 8; dx++) gray[(y + dy) * W + x + dx] = ink;
    }
  }
  // Un código de barras: rayas verticales continuas (una sola «fila»).
  for (let x = 500; x < 600; x += 6) for (let y = 250; y < 330; y++) for (let dx = 0; dx < 3; dx++) gray[y * W + x + dx] = ink;
  return { gray, table };
}

/** La misma escena como RGBA (lo que devuelve `getImageData`). */
export function sceneRgba(paper: number, ink: number, noise = 6): Uint8ClampedArray {
  const { gray } = scene(paper, ink, noise);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < gray.length; i++) rgba.set([gray[i] as number, gray[i] as number, gray[i] as number, 255], i * 4);
  return rgba;
}

