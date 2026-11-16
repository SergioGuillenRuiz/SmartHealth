// Encontrar DÓNDE está la tabla nutricional en la foto de un envase, antes de leerla (ronda 46). Una foto de verdad no es una tabla recortada: es un envase entero, con marca, ingredientes,
// código de barras y colores, y la tabla ocupa una parte pequeña y casi siempre torcida. Tesseract, con la foto entera, se pierde: su análisis de la página toma por texto lo que no lo es
// y lee mal lo que sí (con una tabla clara sobre un envase oscuro no leía casi nada). Aquí, sin OCR y solo con los píxeles, se buscan los bloques de texto (muchos bordes pequeños
// juntos, en filas) y se devuelven como candidatos, de más a menos probable; cada uno se recorta de la foto original, se endereza y se lee a un tamaño cómodo (`label-ocr.ts`).
//
// Funciones puras sobre una imagen en grises (un byte por píxel), sin canvas: se pueden probar en node.

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextBlock extends Box {
  /** Cuántas filas de texto se distinguen dentro (una tabla tiene muchas; un código de barras o una marca en letras grandes, una). */
  rows: number;
  /** Qué parte de los cuadros de la caja tiene bordes de texto (0 a 1). */
  density: number;
  /** Para ordenarlos: más es más probable que sea una tabla. */
  score: number;
}

/** Pasa píxeles RGBA a grises (un byte por píxel). */
export function grayOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) out[p] = (rgba[i] as number) * 0.299 + (rgba[i + 1] as number) * 0.587 + (rgba[i + 2] as number) * 0.114;
  return out;
}

/** Desenfoque de caja 3 × 3 (quita el ruido de sensor antes de buscar bordes). */
function blur3(gray: Uint8Array, width: number, height: number): Uint8Array {
  const tmp = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = gray[row + Math.max(0, x - 1)] as number;
      const b = gray[row + x] as number;
      const c = gray[row + Math.min(width - 1, x + 1)] as number;
      tmp[row + x] = a + b + c;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const mid = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) out[mid + x] = ((tmp[up + x] as number) + (tmp[mid + x] as number) + (tmp[down + x] as number)) / 9;
  }
  return out;
}

/** Los píxeles del contorno de la imagen no cuentan: al reescalar una foto queda ahí una línea de color distinto que no es un borde de texto. */
const EDGE_MARGIN = 3;

/** Fuerza del borde de cada píxel (diferencias en los dos ejes sobre la imagen ya desenfocada), de 0 a 255. */
export function edgeStrength(gray: Uint8Array, width: number, height: number): Uint8Array {
  const smooth = blur3(gray, width, height);
  const out = new Uint8Array(width * height);
  for (let y = EDGE_MARGIN; y < height - EDGE_MARGIN; y++) {
    for (let x = EDGE_MARGIN; x < width - EDGE_MARGIN; x++) {
      const i = y * width + x;
      const gx = Math.abs((smooth[i + 1] as number) - (smooth[i - 1] as number));
      const gy = Math.abs((smooth[i + width] as number) - (smooth[i - width] as number));
      out[i] = Math.min(255, gx + gy);
    }
  }
  return out;
}

export interface LocateOptions {
  /** Lado de cada cuadro en el que se cuentan bordes (px de la imagen que se le pasa). */
  cell?: number;
  /** Cuántos cuadros se unen en horizontal para que las letras formen palabras y líneas. */
  gapX?: number;
  /** Cuántos cuadros se unen en horizontal en el nivel «tabla de columnas separadas». */
  wideGapX?: number;
  /** Cuántos cuadros se unen en vertical para que las líneas formen un bloque. */
  gapY?: number;
  /** Cuántos candidatos como mucho. */
  max?: number;
  /** Ajustes del umbral de borde (para medir; los de serie son los buenos). */
  minEdge?: number;
  edgeFraction?: number;
  needFraction?: number;
  neighbourhood?: number;
}

interface Component {
  cells: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** El valor mayor de cada ventana de `2 · radius + 1` cuadros (máximo separable: primero por filas y luego por columnas). */
function maxFilter(values: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  const wide = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let best = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(cols - 1, x + radius); k++) best = Math.max(best, values[y * cols + k] as number);
      wide[y * cols + x] = best;
    }
  }
  const out = new Uint8Array(cols * rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      let best = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(rows - 1, y + radius); k++) best = Math.max(best, wide[k * cols + x] as number);
      out[y * cols + x] = best;
    }
  }
  return out;
}

/** El borde más débil que cuenta como borde de texto (por debajo es ruido del sensor o de la compresión) y qué parte del borde más fuerte de su entorno ha de tener. */
const MIN_EDGE = 13;
const EDGE_FRACTION = 0.3;
const NEED_FRACTION = 0.14;
const NEIGHBOURHOOD = 3;

/**
 * Cuadros «con texto» (rejilla de `cell` px) a partir de los bordes. El umbral de borde es **local**: una fracción del borde más fuerte de su entorno (con un mínimo). Con un umbral para
 * toda la foto, una tabla de letra gris sobre un panel claro —bordes flojos— quedaba por debajo de los bordes fuertes de la marca o del fondo y desaparecía.
 */
export function textCells(gray: Uint8Array, width: number, height: number, cell: number, options: LocateOptions): { grid: Uint8Array; cols: number; rows: number } {
  const edges = edgeStrength(gray, width, height);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cellMax = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      const at = rowBase + Math.floor(x / cell);
      const e = edges[y * width + x] as number;
      if (e > (cellMax[at] as number)) cellMax[at] = e;
    }
  }
  const around = maxFilter(cellMax, cols, rows, options.neighbourhood ?? NEIGHBOURHOOD);
  const counts = new Uint16Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      const at = rowBase + Math.floor(x / cell);
      const threshold = Math.max(options.minEdge ?? MIN_EDGE, (options.edgeFraction ?? EDGE_FRACTION) * (around[at] as number));
      if ((edges[y * width + x] as number) >= threshold) counts[at] = (counts[at] as number) + 1;
    }
  }
  const need = Math.max(2, Math.round(cell * cell * (options.needFraction ?? NEED_FRACTION)));
  const grid = new Uint8Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = (counts[i] as number) >= need ? 1 : 0;
  return { grid, cols, rows };
}

/** Une los cuadros que están a `gapX` en horizontal y `gapY` en vertical, y devuelve cada grupo con su caja (en cuadros) y cuántos cuadros con texto tiene. */
function groupCells(grid: Uint8Array, cols: number, rows: number, gapX: number, gapY: number): Component[] {
  // Dilatación horizontal y vertical (por separado: una línea de texto se une primero a lo largo y luego las líneas se unen entre sí).
  const wide = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    let last = -1e9;
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x]) {
        last = x;
        wide[y * cols + x] = 1;
      } else if (x - last <= gapX) wide[y * cols + x] = 1;
    }
    // La misma pasada hacia atrás para que el hueco se cierre por los dos lados.
    last = 1e9;
    for (let x = cols - 1; x >= 0; x--) {
      if (grid[y * cols + x]) last = x;
      else if (last - x <= gapX) wide[y * cols + x] = 1;
    }
  }
  const tall = new Uint8Array(cols * rows);
  for (let x = 0; x < cols; x++) {
    let last = -1e9;
    for (let y = 0; y < rows; y++) {
      if (wide[y * cols + x]) {
        last = y;
        tall[y * cols + x] = 1;
      } else if (y - last <= gapY) tall[y * cols + x] = 1;
    }
    last = 1e9;
    for (let y = rows - 1; y >= 0; y--) {
      if (wide[y * cols + x]) last = y;
      else if (last - y <= gapY) tall[y * cols + x] = 1;
    }
  }
  // Componentes conexas de lo dilatado; las estadísticas se toman de los cuadros originales que hay dentro.
  const label = new Int32Array(cols * rows).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    if (!tall[start] || (label[start] as number) >= 0) continue;
    const id = components.length;
    const comp: Component = { cells: 0, x0: cols, y0: rows, x1: -1, y1: -1 };
    stack.push(start);
    label[start] = id;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const x = at % cols;
      const y = (at - x) / cols;
      if (grid[at]) {
        comp.cells++;
        if (x < comp.x0) comp.x0 = x;
        if (x > comp.x1) comp.x1 = x;
        if (y < comp.y0) comp.y0 = y;
        if (y > comp.y1) comp.y1 = y;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const next = ny * cols + nx;
        if (tall[next] && (label[next] as number) < 0) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
    if (comp.cells > 0) components.push(comp);
  }
  return components;
}

/**
 * Cuántas filas de texto hay en la caja: tramos de filas de cuadros cuya cantidad de texto pasa de un tercio de la fila más llena. Una tabla con rayas entre filas no tiene huecos
 * vacíos (las rayas llenan todo el ancho), pero las rayas y las líneas de texto se alternan igualmente y cada una cuenta como un tramo.
 */
function countRows(grid: Uint8Array, cols: number, comp: Component): number {
  const widthCells = comp.x1 - comp.x0 + 1;
  const profile: number[] = [];
  let peak = 0;
  for (let y = comp.y0; y <= comp.y1; y++) {
    let n = 0;
    for (let x = comp.x0; x <= comp.x1; x++) n += grid[y * cols + x] as number;
    profile.push(n);
    if (n > peak) peak = n;
  }
  if (peak < Math.max(3, widthCells * 0.12)) return 0;
  const need = Math.max(2, peak * 0.33);
  let rows = 0;
  let inside = false;
  for (const n of profile) {
    const on = n >= need;
    if (on && !inside) rows++;
    inside = on;
  }
  return rows;
}

function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

const areaOf = (b: Box): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/** Quita los candidatos que casi coinciden con uno anterior (más probable). */
function dedupe(blocks: readonly TextBlock[]): TextBlock[] {
  const kept: TextBlock[] = [];
  for (const block of blocks) {
    const duplicate = kept.some((other) => {
      const inter = intersection(block, other);
      return inter / Math.min(areaOf(block), areaOf(other)) > 0.8 && inter / Math.max(areaOf(block), areaOf(other)) > 0.5;
    });
    if (!duplicate) kept.push(block);
  }
  return kept;
}

/**
 * Los bloques de texto de la imagen, de más a menos probable que sean una tabla (muchas filas, ni demasiado vacíos ni macizos). Se miran dos niveles de unión vertical: uno estrecho
 * (cada bloque de líneas separado) y otro amplio (una tabla con filas muy separadas, o cuyas filas tienen rayas entre ellas).
 */
export function findTextBlocks(gray: Uint8Array, width: number, height: number, options: LocateOptions = {}): TextBlock[] {
  const cell = options.cell ?? 4;
  const { grid, cols, rows } = textCells(gray, width, height, cell, options);
  const found: TextBlock[] = [];
  // Cuatro niveles de unión: líneas sueltas, líneas que forman un bloque y, con hueco entre columnas (nombres a un lado y cifras al otro, sin rayas), la tabla entera con un hueco normal o muy ancho.
  for (const [gapX, gapY] of [[options.gapX ?? 4, 1], [options.gapX ?? 4, options.gapY ?? 3], [12, options.gapY ?? 3], [options.wideGapX ?? 26, (options.gapY ?? 3) + 1]] as const) {
    for (const comp of groupCells(grid, cols, rows, gapX, gapY)) {
      const w = comp.x1 - comp.x0 + 1;
      const h = comp.y1 - comp.y0 + 1;
      if (w * cell < 70 || h * cell < 36) continue;
      const rowCount = countRows(grid, cols, comp);
      if (rowCount < 3) continue;
      const density = comp.cells / (w * h);
      if (density < 0.06 || density > 0.85) continue;
      // Más filas, más probable; una caja que ocupa toda la foto no es «un bloque» (es el envase con su fondo).
      const frame = (w * h * cell * cell) / (width * height);
      if (frame > 0.7) continue;
      const score = rowCount * (1 + Math.min(1, density * 2)) * (1 - frame) ** 2;
      found.push({ x0: comp.x0 * cell, y0: comp.y0 * cell, x1: (comp.x1 + 1) * cell, y1: (comp.y1 + 1) * cell, rows: rowCount, density, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return dedupe(found).slice(0, options.max ?? 6);
}

/** Una caja ampliada un `fraction` de su tamaño más `pad` px por cada lado, sin salirse de la imagen. */
export function expandBox(box: Box, fraction: number, pad: number, width: number, height: number): Box {
  const dx = (box.x1 - box.x0) * fraction + pad;
  const dy = (box.y1 - box.y0) * fraction + pad;
  return { x0: Math.max(0, Math.floor(box.x0 - dx)), y0: Math.max(0, Math.floor(box.y0 - dy)), x1: Math.min(width, Math.ceil(box.x1 + dx)), y1: Math.min(height, Math.ceil(box.y1 + dy)) };
}
