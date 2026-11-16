import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateBoxes, CAP_HEIGHT, CROP_PASSES, TILE_PASSES, tileBoxes, passCount, planPhoto, PhotoDecodeError, readPlan, WHOLE_PASSES, type OcrEngine, type PhotoPlan } from './label-reader';
import { H, sceneRgba, W } from './label-locate.test-support';

// Un lienzo de mentira que devuelve la escena de las pruebas del localizador al pedir sus píxeles (del tamaño que se pida: la escena se recorta o se repite a ese tamaño).
interface FakeCanvas {
  width: number;
  height: number;
  getContext: () => unknown;
}

function fakeCanvas(pixels: (w: number, h: number) => Uint8ClampedArray): () => FakeCanvas {
  return () => {
    const canvas: FakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillRect: () => undefined,
        drawImage: () => undefined,
        translate: () => undefined,
        rotate: () => undefined,
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: pixels(w, h), width: w, height: h }),
        putImageData: () => undefined,
      }),
    };
    return canvas;
  };
}

const flat = (value: number) => (w: number, h: number): Uint8ClampedArray => new Uint8ClampedArray(w * h * 4).fill(value);
const scene = (paper: number, ink: number) => (w: number, h: number): Uint8ClampedArray => (w === W && h === H ? sceneRgba(paper, ink) : flat(paper)(w, h));

const TABLE = ['Valor energético 1046 kJ / 250 kcal', 'Grasas 12 g', 'Hidratos de carbono 28 g', 'de los cuales azúcares 4,0 g', 'Fibra alimentaria 2,5 g', 'Proteínas 6,0 g', 'Sal 0,52 g'].join('\n');
const PARTIAL = ['Valor energético 1046 kJ / 250 kcal', 'Grasas 12 g'].join('\n');
const REST = ['Hidratos de carbono 28 g', 'de los cuales azúcares 4,0 g', 'Fibra alimentaria 2,5 g', 'Proteínas 6,0 g', 'Sal 0,52 g'].join('\n');

/** Un motor falso que da los textos de uno en uno y apunta qué se le pidió. */
function fakeEngine(texts: string[]): OcrEngine & { calls: Array<{ mode: string; whitelist?: string }> } {
  const calls: Array<{ mode: string; whitelist?: string }> = [];
  return {
    calls,
    async recognize(_image, mode, options) {
      calls.push({ mode, ...(options?.whitelist !== undefined ? { whitelist: options.whitelist } : {}) });
      options?.onProgress?.(0.5);
      return { text: texts.shift() ?? '', lines: [] };
    },
  };
}

const box = { x0: 10, y0: 10, x1: 200, y1: 140 };
const planOf = (steps: PhotoPlan['steps']): PhotoPlan => ({ full: fakeCanvas(flat(180))() as unknown as HTMLCanvasElement, steps });

describe('el lector de fotos por bloques', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas(scene(205, 50)) });
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: W, height: H, close: () => undefined }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('de una foto con una tabla saca el bloque de la tabla, luego la foto entera y, de último recurso, los cuatro cuadrantes', async () => {
    const plan = await planPhoto(new Blob(['x']));
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    const first = plan.steps[0] as PhotoPlan['steps'][number];
    // El primer bloque es la tabla (con un margen) y se lee con las pasadas de un recorte.
    expect(first.box.x0).toBeLessThan(215);
    expect(first.box.x1).toBeGreaterThan(425);
    expect(first.passes).toBe(CROP_PASSES);
    const tiles = plan.steps.slice(-4);
    expect(tiles.every((step) => step.passes === TILE_PASSES)).toBe(true);
    const last = plan.steps[plan.steps.length - 5] as PhotoPlan['steps'][number];
    expect(last.passes).toBe(WHOLE_PASSES);
    expect(last.box).toEqual({ x0: 0, y0: 0, x1: W, y1: H });
    expect(passCount(plan)).toBe(plan.steps.reduce((sum, step) => sum + step.passes.length, 0));
  });

  it('en una foto sin texto no hay bloques: se lee la foto entera y, si no sale nada, por cuadrantes', async () => {
    vi.stubGlobal('document', { createElement: fakeCanvas(flat(200)) });
    const plan = await planPhoto(new Blob(['x']));
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0]?.passes).toBe(WHOLE_PASSES);
    expect(plan.steps.slice(1).every((step) => step.passes === TILE_PASSES)).toBe(true);
  });

  it('los cuadrantes cubren la foto entera y se solapan (una tabla en el centro no se parte)', () => {
    const tiles = tileBoxes(1920, 1080);
    expect(tiles).toHaveLength(4);
    expect(Math.min(...tiles.map((t) => t.x0))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.x1))).toBe(1920);
    expect(Math.min(...tiles.map((t) => t.y0))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.y1))).toBe(1080);
    // Los cuadrantes se pisan en el centro: un rectángulo centrado de la quinta parte del ancho y del alto cabe entero en los cuatro.
    const center = { x0: 768, y0: 432, x1: 1152, y1: 648 };
    expect(tiles.every((t) => t.x0 <= center.x0 && t.y0 <= center.y0 && t.x1 >= center.x1 && t.y1 >= center.y1)).toBe(true);
    // Y uno de la mitad del ancho y del alto, aunque no quepa en uno solo, está entero en algún cuadrante cuando está en una esquina.
    const corner = { x0: 0, y0: 0, x1: 960, y1: 540 };
    expect(tiles.some((t) => t.x0 <= corner.x0 && t.y0 <= corner.y0 && t.x1 >= corner.x1 && t.y1 >= corner.y1)).toBe(true);
  });

  it('una foto que no se abre da su propio error', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('mala')));
    await expect(planPhoto(new Blob(['x']))).rejects.toBeInstanceOf(PhotoDecodeError);
  });

  it('los candidatos están dentro de la foto y ampliados un poco respecto del bloque', () => {
    const canvas = fakeCanvas(scene(205, 50))() as unknown as HTMLCanvasElement;
    canvas.width = W;
    canvas.height = H;
    const boxes = candidateBoxes(canvas);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(W);
      expect(b.y1).toBeLessThanOrEqual(H);
    }
    // El de la tabla (208–432 × 92–300 en la escena) sale con margen por los cuatro lados.
    const table = boxes[0] as (typeof boxes)[number];
    expect(table.x0).toBeLessThan(208);
    expect(table.y0).toBeLessThan(92);
    expect(table.x1).toBeGreaterThan(432);
    expect(table.y1).toBeGreaterThan(300);
  });

  it('para en cuanto una lectura es completa y coherente', async () => {
    const engine = fakeEngine([TABLE, TABLE]);
    const result = await readPlan(engine, planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]));
    expect(engine.calls).toHaveLength(1);
    expect(result.passes).toBe(1);
    expect(result.reading).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, found: 7 });
    expect(result.text).toBe(TABLE);
  });

  it('si una pasada se salta filas, sigue con la siguiente (y con el siguiente recorte) y junta lo que leyó cada una', async () => {
    const engine = fakeEngine([PARTIAL, 'nada que ver', REST]);
    const result = await readPlan(engine, planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]));
    expect(engine.calls.map((c) => c.mode)).toEqual(['block', 'block', 'block']);
    expect(result.reading).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, sugarsG: 4, fiberG: 2.5, proteinG: 6, saltG: 0.52, found: 7 });
  });

  it('la pasada de rescate (polaridad contraria) solo se hace si el recorte no dio ni tres cifras', async () => {
    // Con la primera pasada vacía entra la de rescate (polaridad contraria), que ya lee la tabla.
    const rescued = fakeEngine(['', TABLE]);
    const result = await readPlan(rescued, planOf([{ box, passes: CROP_PASSES }]));
    expect(rescued.calls).toHaveLength(2);
    expect(result.reading.found).toBe(7);
    // Si la primera ya dio tres cifras o más (aunque no sea una lectura completa), no se prueba la contraria: sigue con el otro tamaño.
    const enough = fakeEngine([PARTIAL + '\nProteínas 6,0 g', REST]);
    await readPlan(enough, planOf([{ box, passes: CROP_PASSES }]));
    expect(enough.calls).toHaveLength(2);
  });

  it('en un recorte donde no hay nada que leer no se gasta una pasada más con otro tamaño, y la foto entera solo se lee si no hay ni tres cifras', async () => {
    const empty = fakeEngine([]);
    await readPlan(empty, planOf([{ box, passes: CROP_PASSES }]));
    // La primera y la de rescate; la del otro tamaño (`needsSome`) se salta porque no se leyó nada.
    expect(empty.calls).toHaveLength(2);
    // Con un recorte que ya dio cuatro cifras sin llegar a lo completo, la foto entera no hace falta.
    const four = fakeEngine(['Valor energético 1046 kJ / 250 kcal\nGrasas 12 g\nHidratos de carbono 28 g\nProteínas 6,0 g', REST]);
    await readPlan(four, planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]));
    expect(four.calls.length).toBeLessThanOrEqual(3);
  });

  it('solo la pasada de rescate cambia la polaridad', () => {
    expect(CROP_PASSES.filter((pass) => pass.polarity === 'flip' && pass.rescue === true)).toHaveLength(1);
    expect(CROP_PASSES.filter((pass) => pass.polarity !== 'flip')).toHaveLength(2);
    expect(WHOLE_PASSES.every((pass) => pass.polarity === undefined && pass.rescue === undefined)).toBe(true);
  });

  it('sin nada en ninguna pasada devuelve una lectura vacía tras probarlas todas', async () => {
    const engine = fakeEngine([]);
    const plan = planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]);
    const result = await readPlan(engine, plan);
    // El recorte: primera y rescate (la del otro tamaño se salta: no había nada); la foto entera: sus dos pasadas.
    expect(engine.calls).toHaveLength(4);
    expect(engine.calls.length).toBeLessThan(passCount(plan));
    expect(result.reading.found).toBe(0);
    expect(result.text).toBe('');
  });

  it('el avance sube sin bajar nunca y acaba en 1', async () => {
    const seen: number[] = [];
    await readPlan(fakeEngine([PARTIAL, PARTIAL, PARTIAL, PARTIAL]), planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]), { progress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(4);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(1);
    expect(Math.min(...seen)).toBeGreaterThan(0);
  });

  it('cancelar corta entre pasadas y no sigue pidiéndole nada al motor', async () => {
    const engine = fakeEngine([PARTIAL, PARTIAL, PARTIAL]);
    let stop = false;
    const original = engine.recognize.bind(engine);
    engine.recognize = async (image, mode, options) => {
      const page = await original(image, mode, options);
      stop = true;
      return page;
    };
    await readPlan(engine, planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]), { aborted: () => stop });
    expect(engine.calls).toHaveLength(1);
  });

  it('pasado el plazo blando no empieza otra pasada si ya hay alguna hecha, y devuelve lo leído', async () => {
    const engine = fakeEngine([PARTIAL, REST, TABLE]);
    const result = await readPlan(engine, planOf([{ box, passes: CROP_PASSES }, { box, passes: WHOLE_PASSES }]), { deadline: Date.now() - 1 });
    // Siempre se hace al menos una pasada (si no, no habría nada que devolver).
    expect(engine.calls).toHaveLength(1);
    expect(result.reading).toMatchObject({ kcal: 250, fatG: 12 });
  });

  it('las pasadas pueden pedir al motor solo cifras (lista blanca)', async () => {
    const calls: Array<string | undefined> = [];
    const engine: OcrEngine = {
      async recognize(_image, _mode, options) {
        calls.push(options?.whitelist);
        return { text: '', lines: [] };
      },
    };
    await engine.recognize({} as HTMLCanvasElement, 'word', { whitelist: '0123456789,.' });
    expect(calls).toEqual(['0123456789,.']);
  });

  it('el tamaño de letra al que se lleva el recorte es fijo y la segunda lectura de un recorte lo ve a mayor escala', () => {
    expect(CAP_HEIGHT).toBe(28);
    const first = CROP_PASSES[0];
    const bigger = CROP_PASSES.find((pass) => pass.needsSome === true);
    expect(first?.capHeight).toBeLessThan(bigger?.capHeight ?? 0);
  });
});
