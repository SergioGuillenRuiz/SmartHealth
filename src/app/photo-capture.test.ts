import { describe, expect, it } from 'vitest';
import { centerSquare, coverCrop, describePhotoFailure, fitWithin, PHOTO_MAX_SIDE } from './photo-capture';

describe('fitWithin: la foto se reduce para que su lado más largo no pase del máximo', () => {
  it('reduce una imagen horizontal y una vertical conservando la proporción', () => {
    expect(fitWithin(1280, 720, PHOTO_MAX_SIDE)).toEqual({ width: 480, height: 270 });
    expect(fitWithin(720, 1280, PHOTO_MAX_SIDE)).toEqual({ width: 270, height: 480 });
  });

  it('nunca agranda, y no da medidas de cero', () => {
    expect(fitWithin(320, 240, PHOTO_MAX_SIDE)).toEqual({ width: 320, height: 240 });
    expect(fitWithin(4000, 1, PHOTO_MAX_SIDE)).toEqual({ width: 480, height: 1 });
  });
});

describe('describePhotoFailure', () => {
  it('dice qué pasó y que el plato se puede guardar sin foto', () => {
    for (const failure of ['denied', 'no-camera', 'unsupported', 'failed'] as const) expect(describePhotoFailure(failure)).toMatch(/sin foto/);
    expect(describePhotoFailure('denied')).toMatch(/permiso/);
  });
});

describe('centerSquare: el recorte de la foto de perfil', () => {
  it('coge el cuadrado del centro, en horizontal y en vertical', () => {
    expect(centerSquare(1600, 900)).toEqual({ sx: 350, sy: 0, side: 900 });
    expect(centerSquare(900, 1600)).toEqual({ sx: 0, sy: 350, side: 900 });
    expect(centerSquare(500, 500)).toEqual({ sx: 0, sy: 0, side: 500 });
  });

  it('con medidas raras no da un lado de cero', () => {
    expect(centerSquare(0, 0).side).toBe(1);
    expect(centerSquare(3, 1)).toEqual({ sx: 1, sy: 0, side: 1 });
  });
});

describe('coverCrop: la foto es el recorte que enseñaba el visor, no el fotograma entero', () => {
  it('un fotograma 16:9 en un visor 4:3 pierde los lados', () => {
    expect(coverCrop(1280, 720, 320, 240)).toEqual({ sx: 160, sy: 0, sw: 960, sh: 720 });
  });
  it('un fotograma vertical 9:16 en un visor 4:3 pierde arriba y abajo', () => {
    expect(coverCrop(720, 1280, 320, 240)).toEqual({ sx: 0, sy: 370, sw: 720, sh: 540 });
  });
  it('si ya tiene la misma forma que el visor, es todo el fotograma', () => {
    expect(coverCrop(640, 480, 320, 240)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 });
    expect(coverCrop(1280, 720, 1280, 720)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });
  it('sin medidas del visor (oculto) se queda con el fotograma entero', () => {
    expect(coverCrop(1280, 720, 0, 0)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
    expect(coverCrop(1280, 720, 320, 0)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });
  it('el recorte siempre cabe dentro del fotograma y tiene la forma del visor', () => {
    for (const [vw, vh] of [[1920, 1080], [1080, 1920], [640, 480], [4032, 3024]] as const) {
      for (const [bw, bh] of [[320, 240], [240, 320], [300, 300], [1000, 400]] as const) {
        const c = coverCrop(vw, vh, bw, bh);
        expect(c.sx).toBeGreaterThanOrEqual(0);
        expect(c.sy).toBeGreaterThanOrEqual(0);
        expect(c.sx + c.sw).toBeLessThanOrEqual(vw);
        expect(c.sy + c.sh).toBeLessThanOrEqual(vh);
        expect(c.sw / c.sh).toBeCloseTo(bw / bh, 1);
      }
    }
    // Aunque el marco sea absurdo, el recorte nunca sale del fotograma ni queda vacío.
    for (const [vw, vh] of [[3, 1000], [1000, 3]] as const) {
      for (const [bw, bh] of [[1000, 10], [10, 1000]] as const) {
        const c = coverCrop(vw, vh, bw, bh);
        expect(c.sw).toBeGreaterThanOrEqual(1);
        expect(c.sh).toBeGreaterThanOrEqual(1);
        expect(c.sx + c.sw).toBeLessThanOrEqual(vw);
        expect(c.sy + c.sh).toBeLessThanOrEqual(vh);
      }
    }
  });
});
