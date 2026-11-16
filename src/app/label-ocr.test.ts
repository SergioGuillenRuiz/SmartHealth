import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeOcrFailure,
  ENGINE_TIMEOUT_MS,
  IDLE_MS,
  labelReaderSupported,
  LabelOcrError,
  READ_TIMEOUT_MS,
  readLabelFromImage,
  releaseLabelReader,
  stretchContrast,
  warmLabelReader,
  type LabelStage,
} from './label-ocr';
import { TILE_PASSES, WHOLE_PASSES, tileBoxes } from './label-reader';

// El motor de Tesseract se sustituye por uno falso: aquí se prueba cómo se arranca, se comparte, se cancela y se suelta, no el OCR en sí (eso lo hace el e2e con la lectura de verdad).
const engine = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('tesseract.js', () => ({ createWorker: engine.createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { SINGLE_BLOCK: 6, AUTO: 3 } }));

const pixels = (grays: readonly number[]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(grays.length * 4);
  grays.forEach((gray, i) => data.set([gray, gray, gray, 255], i * 4));
  return data;
};
const grayOf = (data: Uint8ClampedArray, index: number): number => data[index * 4] as number;

describe('stretchContrast', () => {
  it('estira un texto gris sobre fondo gris claro hasta blanco y negro', () => {
    // 90 % de fondo (200) y 10 % de tinta (120): poca diferencia.
    const data = pixels([...Array<number>(90).fill(200), ...Array<number>(10).fill(120)]);
    expect(stretchContrast(data)).toBe(true);
    expect(grayOf(data, 0)).toBe(255);
    expect(grayOf(data, 99)).toBe(0);
  });

  it('pasa el color a grises', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    stretchContrast(data);
    for (let i = 0; i < 4; i++) expect(new Set([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]).size).toBe(1);
  });

  it('una imagen plana no se estira (no hay nada que leer)', () => {
    const data = pixels(Array<number>(100).fill(128));
    expect(stretchContrast(data)).toBe(false);
    expect(grayOf(data, 5)).toBe(128);
  });

  it('un par de píxeles raros (menos del 1 % en cada extremo) no estropean el estirado', () => {
    // Un punto blanco puro y uno negro puro en una foto de tonos medios (1000 píxeles): se ignoran al buscar el negro y el blanco.
    const data = pixels([255, 0, ...Array<number>(499).fill(100), ...Array<number>(499).fill(150)]);
    expect(stretchContrast(data)).toBe(true);
    expect(grayOf(data, 2)).toBe(0); // el tono más oscuro de verdad pasa a negro
    expect(grayOf(data, 600)).toBe(255); // y el más claro, a blanco
  });
});

describe('las pasadas del lector', () => {
  it('con la foto entera: un bloque en grises y, al final, la página automática; con un bloque de texto: dos tamaños en grises y una de rescate con la polaridad contraria', async () => {
    const { CROP_PASSES } = await import('./label-reader');
    expect(WHOLE_PASSES.map((pass) => pass.mode)).toEqual(['block', 'auto']);
    expect(CROP_PASSES.map((pass) => pass.mode)).toEqual(['block', 'block', 'block']);
    // Medido con fotos de envases dibujadas: el blanco y negro adaptativo empeora la lectura de las fotos.
    expect([...CROP_PASSES, ...WHOLE_PASSES].every((pass) => pass.binary === false)).toBe(true);
    expect(CROP_PASSES.map((pass) => pass.capHeight)).toEqual([28, 28, 38]);
  });
});

describe('errores del lector de fotos', () => {
  it('cada fallo tiene su frase en español', () => {
    expect(describeOcrFailure('unsupported')).toContain('no puede');
    expect(describeOcrFailure('failed')).toContain('No se pudo leer');
    expect(describeOcrFailure('timeout')).toContain('tarda demasiado');
    expect(describeOcrFailure('image')).toContain('No se pudo abrir');
    expect(new LabelOcrError('failed').failure).toBe('failed');
    expect(new LabelOcrError('unsupported').message).toBe(describeOcrFailure('unsupported'));
  });
});


// ───────────────────────────── el motor: arrancar antes, compartir, cancelar y soltar ─────────────────────────────

// Una tabla completa y coherente (energía = 9·grasas + 4·hidratos + 4·proteínas + 2·fibra): con una pasada basta.
const TABLE = ['Valor energético 1046 kJ / 250 kcal', 'Grasas 12 g', 'Hidratos de carbono 28 g', 'de los cuales azúcares 4,0 g', 'Fibra alimentaria 2,5 g', 'Proteínas 6,0 g', 'Sal 0,52 g'].join('\n');
// Lo que lee una pasada que se salta filas: solo la energía y las grasas.
const PARTIAL = ['Valor energético 1046 kJ / 250 kcal', 'Grasas 12 g'].join('\n');

interface FakeWorker {
  setParameters: ReturnType<typeof vi.fn>;
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function fakeWorker(recognize?: () => Promise<{ data: { text: string } }>): FakeWorker {
  return {
    setParameters: vi.fn().mockResolvedValue(undefined),
    recognize: vi.fn(recognize ?? (() => Promise.resolve({ data: { text: TABLE } }))),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

const photo = new Blob(['x'], { type: 'image/jpeg' });

function fakeCanvas(): unknown {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
      putImageData: () => undefined,
    }),
  };
}

describe('el lector de fotos (motor falso)', () => {
  beforeEach(() => {
    engine.createWorker.mockReset();
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('document', { baseURI: 'https://localhost/', createElement: fakeCanvas });
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 4000, height: 3000, close: () => undefined }));
  });
  afterEach(() => {
    releaseLabelReader();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('este entorno (con WebAssembly SIMD y trabajadores) puede leer fotos; sin trabajadores no', () => {
    expect(labelReaderSupported()).toBe(true);
    vi.stubGlobal('Worker', undefined);
    expect(labelReaderSupported()).toBe(false);
  });

  it('sin soporte avisa de que no puede, sin intentar nada', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'unsupported' });
    expect(engine.createWorker).not.toHaveBeenCalled();
  });

  it('lee la foto: arranca el motor con los parámetros de una tabla y devuelve lo que entiende', async () => {
    const worker = fakeWorker();
    engine.createWorker.mockResolvedValue(worker);
    const result = await readLabelFromImage(photo);
    expect(result.text).toBe(TABLE);
    expect(result.reading.found).toBe(7);
    expect(worker.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: 6, preserve_interword_spaces: '1', tessedit_do_invert: '0' });
    expect(engine.createWorker).toHaveBeenCalledWith('spa', 1, expect.objectContaining({ workerBlobURL: false, cacheMethod: 'none', gzip: true, workerPath: 'https://localhost/ocr/worker.min.js' }));
  });

  it('el motor calentado al abrir la cámara se reutiliza: una sola carga para calentar y leer, y otra lectura sin cargar de nuevo', async () => {
    const worker = fakeWorker();
    engine.createWorker.mockResolvedValue(worker);
    warmLabelReader();
    warmLabelReader(); // dos avisos seguidos no arrancan dos motores
    await readLabelFromImage(photo);
    await readLabelFromImage(photo);
    expect(engine.createWorker).toHaveBeenCalledTimes(1);
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('avisa del paso en que va —preparar, arrancar el motor, leer— y el avance solo sube', async () => {
    engine.createWorker.mockImplementation(async (_lang: string, _oem: number, options: { logger: (m: { status: string; progress: number }) => void }) => {
      for (const status of ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api']) {
        options.logger({ status, progress: 0 });
        options.logger({ status, progress: 1 });
      }
      return fakeWorker(async () => {
        for (const progress of [0, 0.4, 0.8, 1]) options.logger({ status: 'recognizing text', progress });
        return { data: { text: TABLE } };
      });
    });
    const seen: Array<[number, LabelStage]> = [];
    await readLabelFromImage(photo, (fraction, stage) => seen.push([fraction, stage]));
    const stages = seen.map(([, stage]) => stage);
    expect(stages[0]).toBe('prepare');
    expect([...new Set(stages)]).toEqual(['prepare', 'load', 'read']);
    const fractions = seen.map(([fraction]) => fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    expect(Math.min(...fractions)).toBeGreaterThan(0);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
    expect(fractions.at(-1)).toBe(1);
  });

  it('una lectura completa y coherente a la primera no pide más pasadas', async () => {
    const worker = fakeWorker();
    engine.createWorker.mockResolvedValue(worker);
    await readLabelFromImage(photo);
    expect(worker.recognize).toHaveBeenCalledTimes(1);
  });

  it('si la primera pasada se salta filas, hace otra (con el análisis automático de la página) y junta lo que leyó cada una', async () => {
    const texts = [PARTIAL, ['Hidratos de carbono 28 g', 'de los cuales azúcares 4,0 g', 'Fibra alimentaria 2,5 g', 'Proteínas 6,0 g', 'Sal 0,52 g'].join('\n')];
    const worker = fakeWorker();
    worker.recognize.mockImplementation(() => Promise.resolve({ data: { text: texts.shift() ?? '' } }));
    engine.createWorker.mockResolvedValue(worker);
    const result = await readLabelFromImage(photo);
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    // La del arranque del motor (un bloque) y las dos pasadas: un bloque y, la segunda, la página automática.
    const modes = worker.setParameters.mock.calls.map(([params]) => (params as { tessedit_pageseg_mode: number }).tessedit_pageseg_mode);
    expect(modes).toEqual([6, 6, 3]);
    expect(result.reading).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, sugarsG: 4, fiberG: 2.5, proteinG: 6, saltG: 0.52, found: 7 });
  });

  it('prueba todas las pasadas y se queda con lo mejor de cada una; sin nada en ninguna, devuelve una lectura vacía', async () => {
    const worker = fakeWorker(() => Promise.resolve({ data: { text: 'nada que ver' } }));
    engine.createWorker.mockResolvedValue(worker);
    const result = await readLabelFromImage(photo);
    // La foto entera y, como último recurso, los cuatro cuadrantes.
    expect(worker.recognize).toHaveBeenCalledTimes(WHOLE_PASSES.length + tileBoxes(1, 1).length * TILE_PASSES.length);
    expect(result.reading.found).toBe(0);
  });

  it('el avance recorre todas las pasadas y nunca baja', async () => {
    const worker = fakeWorker(() => Promise.resolve({ data: { text: PARTIAL } }));
    engine.createWorker.mockResolvedValue(worker);
    const seen: number[] = [];
    await readLabelFromImage(photo, (fraction) => seen.push(fraction));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(1);
  });

  it('un motor que no arranca en 60 s falla con «tarda demasiado» y se suelta; la siguiente vez se arranca otro', async () => {
    vi.useFakeTimers();
    const stuck = fakeWorker();
    engine.createWorker.mockReturnValueOnce(new Promise(() => undefined));
    const reading = readLabelFromImage(photo);
    const outcome = expect(reading).rejects.toMatchObject({ failure: 'timeout' });
    await vi.advanceTimersByTimeAsync(ENGINE_TIMEOUT_MS + 10);
    await outcome;
    engine.createWorker.mockResolvedValue(stuck);
    await readLabelFromImage(photo);
    expect(engine.createWorker).toHaveBeenCalledTimes(2);
  });

  it('una lectura que se pasa de 120 s falla, termina el trabajador y la siguiente usa uno nuevo', async () => {
    vi.useFakeTimers();
    const hung = fakeWorker(() => new Promise(() => undefined));
    const fresh = fakeWorker();
    engine.createWorker.mockResolvedValueOnce(hung).mockResolvedValueOnce(fresh);
    const reading = readLabelFromImage(photo);
    const outcome = expect(reading).rejects.toMatchObject({ failure: 'timeout' });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 10);
    await outcome;
    expect(hung.terminate).toHaveBeenCalledTimes(1);
    const second = await readLabelFromImage(photo);
    expect(second.reading.found).toBeGreaterThan(0);
    expect(engine.createWorker).toHaveBeenCalledTimes(2);
  });

  it('cancelar a mitad de leer falla en el acto y termina el trabajador', async () => {
    const hung = fakeWorker(() => new Promise(() => undefined));
    engine.createWorker.mockResolvedValue(hung);
    const controller = new AbortController();
    const reading = readLabelFromImage(photo, (_fraction, stage) => stage === 'read' && controller.abort(), controller.signal);
    await expect(reading).rejects.toBeInstanceOf(LabelOcrError);
    expect(hung.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancelar mientras el motor arranca no lo tira: queda listo para el siguiente intento', async () => {
    let finish: (worker: FakeWorker) => void = () => undefined;
    const worker = fakeWorker();
    engine.createWorker.mockReturnValue(new Promise<FakeWorker>((resolve) => (finish = resolve)));
    const controller = new AbortController();
    const reading = readLabelFromImage(photo, undefined, controller.signal);
    const outcome = expect(reading).rejects.toBeInstanceOf(LabelOcrError);
    await Promise.resolve();
    controller.abort();
    await outcome;
    finish(worker);
    await readLabelFromImage(photo);
    expect(engine.createWorker).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('si el motor avisa de un error al arrancar (p. ej. el idioma da 404) la lectura falla en el acto, sin esperar a ningún tope', async () => {
    engine.createWorker.mockImplementationOnce((_lang: string, _oem: number, options: { errorHandler: (data: unknown) => void }) => {
      options.errorHandler('Network error while fetching https://localhost/ocr/spa.traineddata.gz. Response code: 404');
      return new Promise(() => undefined);
    });
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'failed' });
    // El siguiente intento arranca otro motor y funciona.
    engine.createWorker.mockResolvedValue(fakeWorker());
    await expect(readLabelFromImage(photo)).resolves.toBeTruthy();
    expect(engine.createWorker).toHaveBeenCalledTimes(2);
  });

  it('un trabajador que se acaba de crear cuando ya había fallado el arranque se termina (no queda un hilo suelto)', async () => {
    const late = fakeWorker();
    let finish: (worker: FakeWorker) => void = () => undefined;
    engine.createWorker.mockImplementationOnce((_lang: string, _oem: number, options: { errorHandler: (data: unknown) => void }) => {
      options.errorHandler('boom');
      return new Promise<FakeWorker>((resolve) => (finish = resolve));
    });
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'failed' });
    finish(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.terminate).toHaveBeenCalledTimes(1);
  });

  it('si el motor avisa de un error a mitad de leer, la lectura falla en el acto, se termina el trabajador y la siguiente usa uno nuevo', async () => {
    const hung = fakeWorker(() => new Promise(() => undefined));
    const fresh = fakeWorker();
    engine.createWorker.mockResolvedValueOnce(hung).mockResolvedValueOnce(fresh);
    const reading = readLabelFromImage(photo, (_fraction, stage) => {
      if (stage === 'read') {
        const options = engine.createWorker.mock.calls[0]?.[2] as { errorHandler: (data: unknown) => void };
        setTimeout(() => options.errorHandler('fallo interno'), 0); // los errores del motor llegan más tarde, no dentro del aviso
      }
    });
    await expect(reading).rejects.toMatchObject({ failure: 'failed' });
    expect(hung.terminate).toHaveBeenCalledTimes(1);
    await expect(readLabelFromImage(photo)).resolves.toBeTruthy();
    expect(engine.createWorker).toHaveBeenCalledTimes(2);
  });

  it('una foto que no se puede abrir lo dice con su propio aviso', async () => {
    engine.createWorker.mockResolvedValue(fakeWorker());
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('corrupta')));
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'image' });
  });

  it('si el motor falla al arrancar, avisa y no deja el fallo guardado', async () => {
    engine.createWorker.mockRejectedValueOnce(new Error('sin red del idioma'));
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'failed' });
    engine.createWorker.mockResolvedValue(fakeWorker());
    await expect(readLabelFromImage(photo)).resolves.toBeTruthy();
  });

  it('si no se pueden poner los parámetros, el trabajador se termina y no se queda a medias', async () => {
    const broken = fakeWorker();
    broken.setParameters.mockRejectedValue(new Error('no'));
    engine.createWorker.mockResolvedValue(broken);
    await expect(readLabelFromImage(photo)).rejects.toMatchObject({ failure: 'failed' });
    expect(broken.terminate).toHaveBeenCalledTimes(1);
  });

  it('soltar el lector termina el trabajador; y sin usarse se suelta solo pasado un rato', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    engine.createWorker.mockResolvedValue(worker);
    warmLabelReader();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    const second = fakeWorker();
    engine.createWorker.mockResolvedValue(second);
    warmLabelReader();
    await vi.advanceTimersByTimeAsync(10);
    releaseLabelReader();
    await vi.advanceTimersByTimeAsync(10);
    expect(second.terminate).toHaveBeenCalledTimes(1);
  });
});
