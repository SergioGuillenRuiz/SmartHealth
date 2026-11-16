import { describe, expect, it } from 'vitest';
import { binarizeAdaptive, DARK_MEAN, estimateSkewDegrees, flattenBackground, inkIsLight, invertGrays, invertIfDark, medianFilter, otsuThreshold, removeRuledLines, sharpen, sharpnessOf } from './label-image';

/** Una imagen en grises (RGBA) de `w` × `h` con el fondo dado. */
function image(w: number, h: number, background: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([background, background, background, 255], i);
  return data;
}
const at = (data: Uint8ClampedArray, w: number, x: number, y: number): number => data[(y * w + x) * 4] as number;
function rect(data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([value, value, value, 255], (y * w + x) * 4);
}

describe('otsuThreshold', () => {
  it('separa la tinta del papel', () => {
    const data = image(40, 40, 230);
    rect(data, 40, 0, 0, 40, 10, 30);
    const t = otsuThreshold(data);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(230);
  });
});

describe('invertIfDark', () => {
  it('con letras claras sobre fondo oscuro la invierte para que quede tinta oscura sobre papel claro', () => {
    const data = image(40, 40, 30);
    rect(data, 40, 10, 10, 20, 20, 240);
    expect(invertIfDark(data)).toBe(true);
    expect(at(data, 40, 0, 0)).toBe(225);
    expect(at(data, 40, 15, 15)).toBe(15);
  });

  it('un papel claro se deja como está', () => {
    const data = image(40, 40, 220);
    expect(invertIfDark(data)).toBe(false);
    expect(at(data, 40, 3, 3)).toBe(220);
    expect(DARK_MEAN).toBe(120);
  });
});

describe('removeRuledLines', () => {
  const W = 300;
  const H = 180;

  function table(): Uint8ClampedArray {
    const data = image(W, H, 235);
    // Rayas de la tabla: dos filetes horizontales largos de 2 px y un borde vertical.
    rect(data, W, 20, 40, 280, 42, 20);
    rect(data, W, 20, 100, 280, 102, 20);
    rect(data, W, 150, 10, 152, 170, 20);
    // «Letras»: manchas pequeñas, una pegada a un filete.
    rect(data, W, 40, 52, 46, 64, 25);
    rect(data, W, 60, 60, 66, 72, 25);
    rect(data, W, 200, 43, 206, 54, 25);
    return data;
  }

  it('borra los filetes y los bordes de la tabla y deja las letras', () => {
    const data = table();
    const erased = removeRuledLines(data, W, H);
    expect(erased).toBeGreaterThan(260 * 2 * 2 + 160 * 2);
    expect(at(data, W, 100, 40)).toBe(255);
    expect(at(data, W, 100, 101)).toBe(255);
    expect(at(data, W, 151, 90)).toBe(255);
    // las letras, intactas (también la que tocaba el filete, salvo el píxel de margen)
    expect(at(data, W, 43, 58)).toBe(25);
    expect(at(data, W, 63, 66)).toBe(25);
    expect(at(data, W, 203, 50)).toBe(25);
  });

  it('una barra gruesa (con letras dentro, como una cabecera) no es una raya y no se borra', () => {
    const data = image(W, H, 235);
    rect(data, W, 10, 20, 290, 60, 20);
    rect(data, W, 30, 30, 36, 50, 240); // una letra clara dentro
    const before = Uint8ClampedArray.from(data);
    removeRuledLines(data, W, H);
    expect(data).toEqual(before);
  });

  it('sin rayas no toca nada', () => {
    const data = image(W, H, 230);
    rect(data, W, 40, 52, 46, 64, 25);
    const before = Uint8ClampedArray.from(data);
    expect(removeRuledLines(data, W, H)).toBe(0);
    expect(data).toEqual(before);
  });
});

describe('binarizeAdaptive', () => {
  it('deja solo blanco y negro aunque la luz sea desigual: el texto, negro; el papel, blanco', () => {
    const w = 120;
    const h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    // Fondo con degradado de 120 a 240 (luz desigual) y «texto» 60 puntos más oscuro que el fondo de su zona.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([120 + x, 120 + x, 120 + x, 255], (y * w + x) * 4);
    for (const x0 of [10, 60, 100]) rect(data, w, x0, 20, x0 + 4, 40, 120 + x0 - 70);
    binarizeAdaptive(data, w, h);
    for (let i = 0; i < data.length; i += 4) expect([0, 255]).toContain(data[i]);
    for (const x0 of [10, 60, 100]) expect(at(data, w, x0 + 1, 30)).toBe(0);
    expect(at(data, w, 30, 5)).toBe(255);
    expect(at(data, w, 80, 50)).toBe(255);
  });
});

/**
 * Una «tabla» de filas de trazos (como líneas de texto): `rows` filas con trazos oscuros de 3 px de alto, giradas `degrees` alrededor del centro (en el sentido de las agujas del reloj,
 * como `CanvasRenderingContext2D.rotate`).
 */
function ruledText(w: number, h: number, degrees: number, rows = 9): Uint8ClampedArray {
  const data = image(w, h, 235);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // El píxel de salida (x, y) viene del punto del texto sin girar que, al girarlo, cae ahí.
      const dx = x - w / 2;
      const dy = y - h / 2;
      const ux = dx * cos + dy * sin + w / 2;
      const uy = -dx * sin + dy * cos + h / 2;
      const row = Math.floor((uy - 40) / 28);
      if (row < 0 || row >= rows || ux < 60 || ux > w - 60) continue;
      const inRow = (uy - 40) % 28 < 11;
      // Trazos de 9 px con huecos de 4: lo que hace un texto a esta escala.
      if (inRow && (Math.floor(ux) % 13) < 9) data.set([40, 40, 40, 255], (y * w + x) * 4);
    }
  }
  return data;
}

describe('estimateSkewDegrees', () => {
  it('un texto recto no se gira', () => {
    expect(estimateSkewDegrees(ruledText(480, 360, 0), 480, 360)).toBe(0);
  });

  it('da el giro que lo endereza: lo contrario de lo que está torcido (positivo = agujas del reloj)', () => {
    for (const tilt of [-8, -3, 2, 5.5, 11]) {
      const found = estimateSkewDegrees(ruledText(480, 360, tilt), 480, 360);
      expect(Math.abs(found + tilt)).toBeLessThanOrEqual(0.75);
    }
  });

  it('con la imagen entera de otro color (un fondo oscuro con la tabla clara) también lo encuentra', () => {
    const data = ruledText(480, 360, 4);
    for (let i = 0; i < data.length; i += 4) {
      const inverted = 255 - (data[i] as number);
      data.set([inverted, inverted, inverted, 255], i);
    }
    expect(Math.abs(estimateSkewDegrees(data, 480, 360) + 4)).toBeLessThanOrEqual(0.75);
  });

  it('una imagen plana o diminuta no da ningún giro', () => {
    expect(estimateSkewDegrees(image(480, 360, 200), 480, 360)).toBe(0);
    expect(estimateSkewDegrees(image(10, 10, 200), 10, 10)).toBe(0);
  });
});

describe('flattenBackground', () => {
  it('con una luz que va de oscura a clara deja el papel blanco por todas partes y la tinta oscura', () => {
    const w = 320;
    const h = 200;
    const data = image(w, h, 0);
    // Papel de 110 (a la izquierda) a 250 (a la derecha), con trazos de tinta al 35 % del papel de cada sitio.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const paper = 110 + (140 * x) / (w - 1);
        const ink = (x % 14) < 4 && y > 40 && y < 160 && (y % 20) < 8;
        const v = Math.round(ink ? paper * 0.35 : paper);
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    flattenBackground(data, w, h);
    for (const x of [6, 90, 200, 313]) expect(at(data, w, x, 12)).toBeGreaterThanOrEqual(235);
    // La tinta sigue siendo mucho más oscura que el papel en la zona oscura y en la clara.
    let darkInk = 0;
    let lightInk = 0;
    for (let y = 40; y < 160; y++) {
      for (let x = 20; x < 300; x++) {
        if (!((x % 14) < 4 && (y % 20) < 8)) continue;
        if (x < 100 && at(data, w, x, y) < 140) darkInk++;
        if (x > 220 && at(data, w, x, y) < 140) lightInk++;
      }
    }
    expect(darkInk).toBeGreaterThan(300);
    expect(lightInk).toBeGreaterThan(300);
  });

  it('un papel liso se queda en blanco', () => {
    const data = image(120, 80, 180);
    flattenBackground(data, 120, 80);
    expect(at(data, 120, 60, 40)).toBeGreaterThanOrEqual(250);
  });
});

describe('sharpen y medianFilter', () => {
  it('el realce hace más marcado un borde borroso sin tocar lo liso', () => {
    const w = 60;
    const data = image(w, 10, 0);
    // Un escalón suave de 90 a 170 en seis píxeles.
    for (let y = 0; y < 10; y++) for (let x = 0; x < w; x++) data.set([x < 27 ? 90 : x > 33 ? 170 : 90 + ((x - 27) / 6) * 80, 0, 0, 255].map((v, k) => (k === 3 ? 255 : v)), (y * w + x) * 4);
    const before = [at(data, w, 26, 5), at(data, w, 34, 5)];
    sharpen(data, w, 10, 3, 1.5);
    expect(at(data, w, 26, 5)).toBeLessThan(before[0] as number);
    expect(at(data, w, 34, 5)).toBeGreaterThan(before[1] as number);
    expect(at(data, w, 2, 5)).toBe(90);
    expect(at(data, w, 57, 5)).toBe(170);
  });

  it('la mediana quita los puntos sueltos pero respeta un trazo de dos píxeles', () => {
    const w = 30;
    const data = image(w, 30, 220);
    rect(data, w, 10, 5, 12, 25, 30); // un trazo de 2 px de ancho
    data.set([0, 0, 0, 255], (15 * w + 20) * 4); // un punto negro
    data.set([255, 255, 255, 255], (10 * w + 11) * 4); // un punto blanco dentro del trazo
    medianFilter(data, w, 30);
    expect(at(data, w, 20, 15)).toBe(220);
    expect(at(data, w, 11, 10)).toBe(30);
    expect(at(data, w, 10, 14)).toBe(30);
  });
});

describe('inkIsLight e invertGrays', () => {
  it('una tabla clara con letra oscura y un borde oscuro del envase alrededor tiene la tinta oscura: no se invierte', () => {
    const w = 200;
    const h = 120;
    const data = image(w, h, 40); // el envase, oscuro, en el borde del recorte
    rect(data, w, 12, 8, 188, 112, 235); // el panel claro, casi todo el recorte
    for (let y = 30; y < 90; y += 12) rect(data, w, 30, y, 170, y + 4, 30); // líneas de letra oscura
    expect(inkIsLight(data, w, h)).toBe(false);
  });

  it('con letras claras sobre un fondo oscuro la tinta es clara', () => {
    const w = 200;
    const h = 120;
    const data = image(w, h, 30);
    for (let y = 20; y < 100; y += 12) rect(data, w, 20, y, 180, y + 4, 235);
    expect(inkIsLight(data, w, h)).toBe(true);
  });

  it('una imagen plana no tiene tinta clara', () => {
    expect(inkIsLight(image(80, 60, 200), 80, 60)).toBe(false);
  });

  it('invertir los grises da el negativo y dos veces devuelve lo de antes', () => {
    const data = image(4, 4, 70);
    rect(data, 4, 1, 1, 3, 3, 200);
    const copy = new Uint8ClampedArray(data);
    invertGrays(data);
    expect(at(data, 4, 0, 0)).toBe(185);
    expect(at(data, 4, 2, 2)).toBe(55);
    invertGrays(data);
    expect([...data]).toEqual([...copy]);
  });
});

describe('nitidez de una imagen (para elegir el fotograma menos borroso)', () => {
  /** Un patrón de rayas verticales de `period` píxeles, en RGBA. */
  const stripes = (width: number, height: number, period: number): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = Math.floor(x / period) % 2 === 0 ? 20 : 235;
        rgba.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return rgba;
  };
  /** La misma imagen desenfocada: cada píxel es la media de sus vecinos de la fila. */
  const blurred = (rgba: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(rgba.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let n = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          sum += rgba[(y * width + xx) * 4] as number;
          n++;
        }
        const v = sum / n;
        out.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return out;
  };

  it('la imagen enfocada puntúa más que la misma desenfocada, y más desenfoque puntúa menos', () => {
    const sharp = stripes(120, 80, 4);
    const a = sharpnessOf(sharp, 120, 80);
    const b = sharpnessOf(blurred(sharp, 120, 80, 1), 120, 80);
    const c = sharpnessOf(blurred(sharp, 120, 80, 3), 120, 80);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('una imagen lisa vale 0 y una imagen minúscula no falla', () => {
    expect(sharpnessOf(new Uint8ClampedArray(60 * 40 * 4).fill(128), 60, 40)).toBe(0);
    expect(sharpnessOf(new Uint8ClampedArray(2 * 2 * 4).fill(10), 2, 2)).toBe(0);
  });
});
