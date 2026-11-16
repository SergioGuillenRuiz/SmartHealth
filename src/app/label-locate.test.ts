import { describe, expect, it } from 'vitest';
import { expandBox, findTextBlocks, grayOf } from './label-locate';
import { H, scene, W, type Box } from './label-locate.test-support';

const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? (w * h) / ((b.x1 - b.x0) * (b.y1 - b.y0)) : 0;
};

describe('findTextBlocks', () => {
  it('encuentra la tabla (muchas filas de texto) la primera y no confunde con ella el código de barras', () => {
    const { gray, table } = scene(205, 50);
    const blocks = findTextBlocks(gray, W, H);
    expect(blocks.length).toBeGreaterThan(0);
    const first = blocks[0] as Box;
    expect(overlap(first, table)).toBeGreaterThan(0.85);
    expect((first.x1 - first.x0) * (first.y1 - first.y0)).toBeLessThan(2.5 * (table.x1 - table.x0) * (table.y1 - table.y0));
    // El código de barras (una sola «fila») no es un candidato por sí solo (sí puede entrar en un bloque amplio que también lleva la tabla).
    const barcode: Box = { x0: 500, y0: 250, x1: 600, y1: 330 };
    expect(blocks.some((b) => overlap(barcode, b) > 0.5)).toBe(false);
  });

  it('también la encuentra con letras claras sobre un fondo oscuro, y con la letra de bajo contraste', () => {
    const dark = scene(40, 215);
    expect(overlap(findTextBlocks(dark.gray, W, H)[0] as Box, dark.table)).toBeGreaterThan(0.85);
    const faint = scene(200, 135, 3);
    expect(overlap(findTextBlocks(faint.gray, W, H)[0] as Box, faint.table)).toBeGreaterThan(0.85);
  });

  it('con mucho grano de sensor y nada de texto no inventa candidatos', () => {
    const gray = new Uint8Array(W * H);
    let seed = 3;
    for (let i = 0; i < gray.length; i++) gray[i] = 130 + ((((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5) * 24);
    expect(findTextBlocks(gray, W, H)).toEqual([]);
    expect(findTextBlocks(new Uint8Array(W * H).fill(200), W, H)).toEqual([]);
  });

  it('el borde de la imagen (la línea que deja un reescalado) no cuenta como texto', () => {
    const gray = new Uint8Array(W * H).fill(200);
    for (let x = 0; x < W; x++) {
      gray[x] = 0;
      gray[(H - 1) * W + x] = 0;
    }
    for (let y = 0; y < H; y++) {
      gray[y * W] = 0;
      gray[y * W + W - 1] = 0;
    }
    expect(findTextBlocks(gray, W, H)).toEqual([]);
  });

  it('da como mucho el número de candidatos pedido, de más a menos probable', () => {
    const { gray } = scene(205, 50);
    const blocks = findTextBlocks(gray, W, H, { max: 1 });
    expect(blocks).toHaveLength(1);
    const all = findTextBlocks(gray, W, H);
    for (let i = 1; i < all.length; i++) expect((all[i - 1] as { score: number }).score).toBeGreaterThanOrEqual((all[i] as { score: number }).score);
  });
});

describe('grayOf y expandBox', () => {
  it('pasa de RGBA a grises con los pesos de la luminancia', () => {
    const gray = grayOf(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
    expect([...gray]).toEqual([76, 149, 29, 255]);
  });

  it('amplía una caja sin salirse de la imagen', () => {
    expect(expandBox({ x0: 100, y0: 50, x1: 200, y1: 150 }, 0.1, 5, 640, 360)).toEqual({ x0: 85, y0: 35, x1: 215, y1: 165 });
    expect(expandBox({ x0: 2, y0: 2, x1: 636, y1: 358 }, 0.1, 5, 640, 360)).toEqual({ x0: 0, y0: 0, x1: 640, y1: 360 });
  });
});
