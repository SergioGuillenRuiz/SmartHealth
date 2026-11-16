// Preparar la foto de una etiqueta para el OCR: funciones puras sobre los píxeles (RGBA, en grises: el rojo vale por los tres canales). Lo que más estropea la lectura de una tabla
// nutricional no es la letra pequeña sino lo que la rodea: el fondo oscuro con letras claras (Tesseract lee texto oscuro sobre claro) y, sobre todo, las rayas de la tabla —bordes y filetes
// entre filas—, con las que su análisis de la página se salta filas enteras. Medido con etiquetas dibujadas (docs/estimaciones.md → «Leer la tabla nutricional de una foto»).

/**
 * Pasa la imagen a grises y estira el contraste entre el 1 % más oscuro y el 1 % más claro (una etiqueta con poca luz o mate se lee peor): modifica `rgba` en su sitio.
 * Devuelve `false` si la imagen es plana (no hay nada que estirar).
 */
export function stretchContrast(rgba: Uint8ClampedArray): boolean {
  const histogram = new Uint32Array(256);
  const total = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const gray = Math.round(0.299 * (rgba[i] as number) + 0.587 * (rgba[i + 1] as number) + 0.114 * (rgba[i + 2] as number));
    rgba[i] = rgba[i + 1] = rgba[i + 2] = gray;
    histogram[gray] = (histogram[gray] as number) + 1;
  }
  let low = 0;
  let high = 255;
  for (let sum = 0; low < 255; low++) {
    sum += histogram[low] as number;
    if (sum >= total * 0.01) break;
  }
  for (let sum = 0; high > 0; high--) {
    sum += histogram[high] as number;
    if (sum >= total * 0.01) break;
  }
  if (high - low < 24) return false;
  const scale = 255 / (high - low);
  for (let i = 0; i < rgba.length; i += 4) {
    const value = Math.min(255, Math.max(0, Math.round(((rgba[i] as number) - low) * scale)));
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
  }
  return true;
}

/** El umbral de Otsu del canal rojo (lo que separa «tinta» de «papel» maximizando la diferencia entre los dos grupos). */
export function otsuThreshold(rgba: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    histogram[rgba[i] as number] = (histogram[rgba[i] as number] as number) + 1;
    total++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (histogram[t] as number);
  let sumBack = 0;
  let weightBack = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBack += histogram[t] as number;
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * (histogram[t] as number);
    const meanBack = sumBack / weightBack;
    const meanFore = (sum - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) * (meanBack - meanFore);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Si la foto es de letras claras sobre un fondo oscuro (media por debajo de {@link DARK_MEAN}), la invierte: Tesseract lee tinta oscura sobre papel claro. Devuelve `true` si invirtió.
 * Se mira una de cada cuatro píxeles (basta para saber si el fondo es claro u oscuro).
 */
export const DARK_MEAN = 120;
export function invertIfDark(rgba: Uint8ClampedArray): boolean {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 16) {
    sum += rgba[i] as number;
    count++;
  }
  if (count === 0 || sum / count >= DARK_MEAN) return false;
  for (let i = 0; i < rgba.length; i += 4) {
    const value = 255 - (rgba[i] as number);
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
  }
  return true;
}

/**
 * ¿Es de color claro la tinta de esta imagen en grises? La tinta es la clase **minoritaria** (el papel ocupa casi todo) del umbral de Otsu, mirando solo el interior (sin el 10 % de cada
 * borde, donde suele haber lo que rodea a la tabla). Con letras claras sobre un fondo oscuro, la tinta es clara; con un panel claro y letra oscura, oscura. A diferencia de mirar la media
 * de toda la imagen, no se confunde con un recorte que lleva un borde oscuro del envase alrededor de una tabla clara. (Un recorte que es mitad envase oscuro y mitad panel claro no tiene
 * una polaridad buena para todo: por eso hay una pasada de rescate con la contraria.)
 */
export function inkIsLight(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const mx = Math.floor(width * 0.1);
  const my = Math.floor(height * 0.1);
  const stride = Math.max(1, Math.round(Math.max(width, height) / 600));
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let y = my; y < height - my; y += stride) {
    for (let x = mx; x < width - mx; x += stride) {
      histogram[rgba[(y * width + x) * 4] as number] = (histogram[rgba[(y * width + x) * 4] as number] as number) + 1;
      total++;
    }
  }
  if (total === 0) return false;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (histogram[t] as number);
  let weightBack = 0;
  let sumBack = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBack += histogram[t] as number;
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * (histogram[t] as number);
    const between = weightBack * weightFore * (sumBack / weightBack - (sum - sumBack) / weightFore) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  let dark = 0;
  for (let t = 0; t <= threshold; t++) dark += histogram[t] as number;
  return total - dark < dark;
}

/** Invierte los grises (255 − valor): lo que era tinta clara sobre fondo oscuro pasa a tinta oscura sobre papel claro. Modifica `rgba` en su sitio. */
export function invertGrays(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const value = 255 - (rgba[i] as number);
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
  }
}

export interface LineOptions {
  /** Cuánto del ancho ha de cubrir una raya horizontal para serlo (0 a 1). */
  horizontal?: number;
  /** Cuánto del alto, una vertical. */
  vertical?: number;
}

/**
 * Borra (pinta de blanco) las rayas largas y finas de la imagen —los bordes y filetes de una tabla—: una trama continua de píxeles oscuros que cubre, al menos, el 15 % del ancho (o el
 * 10 % del alto) y no es gruesa (una barra gruesa no es una raya: puede llevar letras dentro). Las letras que las tocan pierden, como mucho, un píxel. Devuelve cuántos píxeles borró.
 */
export function removeRuledLines(rgba: Uint8ClampedArray, width: number, height: number, options: LineOptions = {}): number {
  const threshold = otsuThreshold(rgba);
  const dark = (x: number, y: number): boolean => (rgba[(y * width + x) * 4] as number) <= threshold;
  const minHorizontal = Math.max(8, Math.round(width * (options.horizontal ?? 0.15)));
  const minVertical = Math.max(8, Math.round(height * (options.vertical ?? 0.1)));
  const maxThickness = Math.max(6, Math.round(Math.min(width, height) * 0.012));
  const marked = new Uint8Array(width * height);

  const thickness = (x: number, y: number, vertical: boolean): number => {
    let n = 1;
    const step = (dx: number, dy: number): void => {
      for (let k = 1; k <= maxThickness + 1; k++) {
        const px = x + dx * k;
        const py = y + dy * k;
        if (px < 0 || py < 0 || px >= width || py >= height || !dark(px, py)) break;
        n++;
      }
    };
    if (vertical) {
      step(-1, 0);
      step(1, 0);
    } else {
      step(0, -1);
      step(0, 1);
    }
    return n;
  };

  // Es una raya si en algún punto de su recorrido es fina (en el cruce con otra raya se ve gruesa, y no por eso deja de serlo).
  const thinAlong = (from: number, to: number, measure: (at: number) => number): boolean => {
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) if (measure(Math.min(to - 1, from + Math.floor((to - from) * fraction))) <= maxThickness) return true;
    return false;
  };

  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x <= width; x++) {
      if (x < width && dark(x, y)) run++;
      else {
        if (run >= minHorizontal && thinAlong(x - run, x, (t) => thickness(t, y, false))) for (let k = x - run; k < x; k++) marked[y * width + k] = 1;
        run = 0;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y <= height; y++) {
      if (y < height && dark(x, y)) run++;
      else {
        if (run >= minVertical && thinAlong(y - run, y, (t) => thickness(x, t, true))) for (let k = y - run; k < y; k++) marked[k * width + x] = 1;
        run = 0;
      }
    }
  }

  // Un píxel de margen alrededor de cada raya (los bordes suavizados dejan un resto gris).
  let erased = 0;
  const wipe = new Uint8Array(marked);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (marked[y * width + x] === 0) continue;
      wipe[(y - 1) * width + x] = wipe[(y + 1) * width + x] = wipe[y * width + x - 1] = wipe[y * width + x + 1] = 1;
    }
  }
  for (let p = 0; p < width * height; p++) {
    if (wipe[p] === 0) continue;
    const q = p * 4;
    rgba[q] = rgba[q + 1] = rgba[q + 2] = 255;
    erased++;
  }
  return erased;
}

/**
 * Pasa la imagen a blanco y negro con un umbral que se adapta a cada zona (Sauvola con imágenes integrales): aguanta mejor la luz desigual y los reflejos que un umbral único. Modifica
 * `rgba` en su sitio.
 */
export function binarizeAdaptive(rgba: Uint8ClampedArray, width: number, height: number): void {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const squares = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 0; x < width; x++) {
      const v = rgba[(y * width + x) * 4] as number;
      rowSum += v;
      rowSquares += v * v;
      sum[(y + 1) * stride + x + 1] = (sum[y * stride + x + 1] as number) + rowSum;
      squares[(y + 1) * stride + x + 1] = (squares[y * stride + x + 1] as number) + rowSquares;
    }
  }
  const radius = Math.max(8, Math.round(Math.min(width, height) / 24));
  const k = 0.25;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const n = (x1 - x0) * (y1 - y0);
      const s = (sum[y1 * stride + x1] as number) - (sum[y0 * stride + x1] as number) - (sum[y1 * stride + x0] as number) + (sum[y0 * stride + x0] as number);
      const s2 = (squares[y1 * stride + x1] as number) - (squares[y0 * stride + x1] as number) - (squares[y1 * stride + x0] as number) + (squares[y0 * stride + x0] as number);
      const mean = s / n;
      const deviation = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const local = mean * (1 + k * (deviation / 128 - 1));
      const q = (y * width + x) * 4;
      const value = (rgba[q] as number) > local ? 255 : 0;
      rgba[q] = rgba[q + 1] = rgba[q + 2] = value;
    }
  }
}

/**
 * Cuánto hay que girar una imagen (grados, positivo = en el sentido de las agujas del reloj, como `CanvasRenderingContext2D.rotate`) para que las líneas de texto queden horizontales.
 * Se miran los píxeles donde la imagen cambia de arriba abajo mucho más que de lado a lado (los bordes horizontales: arriba y abajo de las letras, las rayas de la tabla) y se prueban
 * ángulos entre `-maxDegrees` y `maxDegrees`: gana aquel en el que esos puntos caen en filas más marcadas (la suma de cuadrados del perfil horizontal es mayor). No importa si hay
 * fondo oscuro alrededor ni de qué color es la letra. Devuelve 0 si no hay una inclinación clara. Una foto de una tabla sacada a mano casi nunca sale recta: con más de unos 3°
 * Tesseract lee mucho peor.
 */
export function estimateSkewDegrees(rgba: Uint8ClampedArray, width: number, height: number, maxDegrees = 15): number {
  // Una copia pequeña (promedio de bloques: quita el ruido de grano) en la que se buscan los bordes.
  const block = Math.max(1, Math.round(Math.max(width, height) / 640));
  const gw = Math.floor(width / block);
  const gh = Math.floor(height / block);
  if (gw < 24 || gh < 24) return 0;
  const small = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let sum = 0;
      for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) sum += rgba[((y * block + dy) * width + x * block + dx) * 4] as number;
      small[y * gw + x] = sum / (block * block);
    }
  }
  const verticalChange: number[] = [];
  const spots: number[] = [];
  let strongest = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const gy = Math.abs((small[(y + 1) * gw + x] as number) - (small[(y - 1) * gw + x] as number));
      const gx = Math.abs((small[y * gw + x + 1] as number) - (small[y * gw + x - 1] as number));
      if (gy > 1.3 * gx) {
        verticalChange.push(gy);
        spots.push(x, y);
        if (gy > strongest) strongest = gy;
      }
    }
  }
  const minChange = Math.max(14, strongest * 0.25);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < verticalChange.length; i++) {
    if ((verticalChange[i] as number) >= minChange) {
      xs.push(spots[i * 2] as number);
      ys.push(spots[i * 2 + 1] as number);
    }
  }
  if (xs.length < 150) return 0;
  const bins = new Float64Array(gh + gw + 4);
  const offset = gw + 2;
  const sharpness = (degrees: number): number => {
    const rad = (degrees * Math.PI) / 180;
    // Girar la imagen `degrees` (en el sentido de las agujas del reloj) lleva el punto (x, y) a y' = x·sin a + y·cos a.
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const at = Math.round((xs[i] as number) * sin + (ys[i] as number) * cos) + offset;
      bins[at] = (bins[at] as number) + 1;
    }
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += (bins[i] as number) ** 2;
    return score;
  };
  const flat = sharpness(0);
  let bestAngle = 0;
  let bestScore = flat;
  for (let d = -maxDegrees; d <= maxDegrees; d += 1) {
    const score = sharpness(d);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = d;
    }
  }
  const coarse = bestAngle;
  for (let d = coarse - 0.75; d <= coarse + 0.75; d += 0.25) {
    const score = sharpness(d);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = d;
    }
  }
  // Una mejora de menos del 3 % sobre la imagen sin girar es ruido: no se gira.
  return bestScore > flat * 1.03 ? bestAngle : 0;
}

/**
 * Quita la luz desigual de una imagen en grises con la tinta oscura sobre papel claro (brillos, sombras, un degradado del flash): estima el color del papel de cada zona —el valor más
 * alto de su entorno, suavizado— y divide por él, de modo que el papel queda blanco en todas partes y solo se conserva el contraste de la tinta. Sin esto, un reflejo o una sombra
 * hacen que el umbral de blanco y negro (y el borrado de rayas) tomen una zona oscura entera por tinta. Modifica `rgba` en su sitio.
 */
export function flattenBackground(rgba: Uint8ClampedArray, width: number, height: number): void {
  const block = Math.max(2, Math.round(Math.min(width, height) / 160));
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / block) * gw;
    for (let x = 0; x < width; x++) {
      const at = rowBase + Math.floor(x / block);
      const v = rgba[(y * width + x) * 4] as number;
      if (v > (grid[at] as number)) grid[at] = v;
    }
  }
  // El máximo del entorno (2 bloques) rellena las letras con el color del papel de alrededor; luego se suaviza para que el papel estimado no tenga escalones.
  const dilate = (source: Uint8Array, radius: number): Uint8Array => {
    const wide = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let best = 0;
        for (let k = Math.max(0, x - radius); k <= Math.min(gw - 1, x + radius); k++) best = Math.max(best, source[y * gw + k] as number);
        wide[y * gw + x] = best;
      }
    }
    const out = new Uint8Array(gw * gh);
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        let best = 0;
        for (let k = Math.max(0, y - radius); k <= Math.min(gh - 1, y + radius); k++) best = Math.max(best, wide[k * gw + x] as number);
        out[y * gw + x] = best;
      }
    }
    return out;
  };
  const paper = dilate(grid, 2);
  const radius = Math.max(2, Math.round(gw / 14));
  const soft = new Float32Array(gw * gh);
  const tmp = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    let sum = 0;
    let count = 0;
    for (let x = -radius; x < gw; x++) {
      const add = x + radius;
      if (add < gw) {
        sum += paper[y * gw + add] as number;
        count++;
      }
      const drop = x - radius - 1;
      if (drop >= 0) {
        sum -= paper[y * gw + drop] as number;
        count--;
      }
      if (x >= 0) tmp[y * gw + x] = sum / count;
    }
  }
  for (let x = 0; x < gw; x++) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y < gh; y++) {
      const add = y + radius;
      if (add < gh) {
        sum += tmp[add * gw + x] as number;
        count++;
      }
      const drop = y - radius - 1;
      if (drop >= 0) {
        sum -= tmp[drop * gw + x] as number;
        count--;
      }
      if (y >= 0) soft[y * gw + x] = sum / count;
    }
  }
  // El papel de cada píxel: interpolación bilineal entre los centros de bloque.
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1, Math.max(0, y / block - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, x / block - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = (soft[y0 * gw + x0] as number) * (1 - tx) + (soft[y0 * gw + x1] as number) * tx;
      const bottom = (soft[y1 * gw + x0] as number) * (1 - tx) + (soft[y1 * gw + x1] as number) * tx;
      const bg = Math.max(40, top * (1 - ty) + bottom * ty);
      const q = (y * width + x) * 4;
      const value = Math.min(255, Math.round(((rgba[q] as number) * 255) / bg));
      rgba[q] = rgba[q + 1] = rgba[q + 2] = value;
    }
  }
}

/** Desenfoque de caja de radio `radius` sobre el canal rojo (cada fila y cada columna con una suma móvil). Devuelve los valores suavizados. */
function boxBlur(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let x = -radius; x < width; x++) {
      const add = x + radius;
      if (add < width) {
        sum += rgba[(y * width + add) * 4] as number;
        count++;
      }
      const drop = x - radius - 1;
      if (drop >= 0) {
        sum -= rgba[(y * width + drop) * 4] as number;
        count--;
      }
      if (x >= 0) tmp[y * width + x] = sum / count;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y < height; y++) {
      const add = y + radius;
      if (add < height) {
        sum += tmp[add * width + x] as number;
        count++;
      }
      const drop = y - radius - 1;
      if (drop >= 0) {
        sum -= tmp[drop * width + x] as number;
        count--;
      }
      if (y >= 0) out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * Máscara de enfoque (unsharp mask): realza los bordes de las letras de una foto algo desenfocada restándole una versión borrosa. `radius` es el radio del desenfoque (px) y `amount`
 * cuánto se añade del borde (1 = lo que tiene). Modifica `rgba` en su sitio (grises).
 */
export function sharpen(rgba: Uint8ClampedArray, width: number, height: number, radius: number, amount: number): void {
  const blurred = boxBlur(rgba, width, height, Math.max(1, Math.round(radius)));
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const v = rgba[i] as number;
    const out = Math.min(255, Math.max(0, Math.round(v + amount * (v - (blurred[p] as number)))));
    rgba[i] = rgba[i + 1] = rgba[i + 2] = out;
  }
}

/** Filtro de mediana 3 × 3 (quita el ruido de grano de una foto con poca luz sin emborronar los bordes de las letras tanto como un desenfoque). Modifica `rgba` en su sitio (grises). */
export function medianFilter(rgba: Uint8ClampedArray, width: number, height: number): void {
  const source = new Uint8Array(width * height);
  for (let p = 0; p < source.length; p++) source[p] = rgba[p * 4] as number;
  const window = new Uint8Array(9);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) window[n++] = source[(y + dy) * width + x + dx] as number;
      // Ordenación de 9 valores por inserción: es lo bastante rápida y no reserva nada.
      for (let i = 1; i < 9; i++) {
        const v = window[i] as number;
        let j = i - 1;
        while (j >= 0 && (window[j] as number) > v) {
          window[j + 1] = window[j] as number;
          j--;
        }
        window[j + 1] = v;
      }
      const q = (y * width + x) * 4;
      rgba[q] = rgba[q + 1] = rgba[q + 2] = window[4] as number;
    }
  }
}

/**
 * El alto típico de una letra mayúscula o una cifra (px) de una imagen en grises con la tinta oscura sobre papel claro, o `null` si no hay letras suficientes para saberlo. Se cuentan
 * los trozos de tinta conectados que miden como una letra (ni motas ni rayas) y se toma el percentil 65 de sus alturas: las letras sin rabo ni asta («a», «e», «o») son más bajas que las
 * mayúsculas y las cifras, que son las que importan. Sirve para llevar el texto a un tamaño que el OCR lee bien sea cual sea la distancia a la que se hizo la foto.
 */
export function estimateGlyphHeight(rgba: Uint8ClampedArray, width: number, height: number): number | null {
  const threshold = otsuThreshold(rgba);
  const labels = new Int32Array(width * height).fill(-1);
  const parent: number[] = [];
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[a] !== root) {
      const next = parent[a] as number;
      parent[a] = root;
      a = next;
    }
    return root;
  };
  // Primera pasada: etiquetas provisionales con vecinos de la izquierda y de arriba.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if ((rgba[at * 4] as number) > threshold) continue;
      const left = x > 0 ? (labels[at - 1] as number) : -1;
      const up = y > 0 ? (labels[at - width] as number) : -1;
      if (left < 0 && up < 0) {
        labels[at] = parent.length;
        parent.push(parent.length);
      } else if (left >= 0 && up >= 0) {
        labels[at] = left;
        const a = find(left);
        const b = find(up);
        if (a !== b) parent[b] = a;
      } else labels[at] = left >= 0 ? left : up;
    }
  }
  // Segunda pasada: la caja de cada trozo.
  const boxes = new Map<number, [number, number, number, number, number]>(); // x0, y0, x1, y1, píxeles
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x] as number;
      if (label < 0) continue;
      const root = find(label);
      const box = boxes.get(root);
      if (box === undefined) boxes.set(root, [x, y, x, y, 1]);
      else {
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
        box[4]++;
      }
    }
  }
  const heights: number[] = [];
  const largest = Math.max(12, height * 0.2);
  for (const [x0, y0, x1, y1, pixels] of boxes.values()) {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // Una letra: ni una mota ni una raya ni un bloque grande; con tinta suficiente dentro de su caja (no un marco vacío).
    if (h < 3 || h > largest || w > 3 * h + 2 || pixels < 6 || pixels < 0.12 * w * h) continue;
    heights.push(h);
  }
  if (heights.length < 25) return null;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length * 0.65)] as number;
}

/**
 * Cuánta nitidez tiene una imagen: la media de los saltos de brillo AL CUADRADO entre píxeles vecinos (en horizontal y en vertical) de su parte central, en grises —al cuadrado porque la suma de los saltos sin
 * elevarlos no cambia con el desenfoque: solo reparte un salto en varios pequeños—. Una imagen movida o desenfocada da un número más bajo que la misma imagen enfocada. Sirve para elegir, entre varios fotogramas seguidos, el menos borroso (una foto de una etiqueta con el móvil en la mano sale
 * movida casi siempre; el mejor de unos cuantos fotogramas seguidos lee bastante mejor que el primero).
 */
export function sharpnessOf(rgba: Uint8ClampedArray, width: number, height: number): number {
  const x0 = Math.floor(width * 0.15);
  const x1 = Math.ceil(width * 0.85);
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.ceil(height * 0.85);
  let total = 0;
  let count = 0;
  const gray = (x: number, y: number): number => {
    const i = (y * width + x) * 4;
    return 0.299 * (rgba[i] as number) + 0.587 * (rgba[i + 1] as number) + 0.114 * (rgba[i + 2] as number);
  };
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const g = gray(x, y);
      const dx = g - gray(x + 1, y);
      const dy = g - gray(x, y + 1);
      total += dx * dx + dy * dy;
      count += 2;
    }
  }
  return count === 0 ? 0 : total / count;
}
