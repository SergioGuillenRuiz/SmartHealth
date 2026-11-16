import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./services', () => ({ svc: () => ({ demo: false }) }));

import { imageUrlFromResponse, isOffImageUrl, knownProductImage, productImageUrl, resetProductImagesForTests } from './product-image';

const CODE = '5449000000996';
const PHOTO = 'https://images.openfoodfacts.org/images/products/544/900/000/0996/front_es.45.200.jpg';

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => resetProductImagesForTests());
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

describe('direcciones de imagen', () => {
  it.each([
    [PHOTO, true],
    ['https://static.openfoodfacts.org/images/x/y.png', true],
    ['http://images.openfoodfacts.org/a.jpg', false], // sin https
    ['https://evil.example.com/a.jpg', false],
    ['https://images.openfoodfacts.org.evil.com/a.jpg', false],
    ['https://user@images.openfoodfacts.org/a.jpg', false],
    ['https://images.openfoodfacts.org:8443/a.jpg', false],
    ['https://images.openfoodfacts.org/a.svg', false],
    ['javascript:alert(1)', false],
    ['', false],
    [42, false],
  ])('%j → %s', (value, ok) => {
    expect(isOffImageUrl(value)).toBe(ok);
  });

  it('toma la foto frontal pequeña, o la grande, y descarta lo que no sea de Open Food Facts', () => {
    expect(imageUrlFromResponse({ product: { image_front_small_url: PHOTO } })).toBe(PHOTO);
    expect(imageUrlFromResponse({ product: { image_front_small_url: 'https://evil.example.com/a.jpg', image_front_url: PHOTO } })).toBe(PHOTO);
    expect(imageUrlFromResponse({ product: {} })).toBeNull();
    expect(imageUrlFromResponse({ status: 0 })).toBeNull();
    expect(imageUrlFromResponse(null)).toBeNull();
  });
});

describe('productImageUrl', () => {
  it('pide la foto por el código y la recuerda: la segunda vez no pregunta', async () => {
    const fetcher = vi.fn(async () => reply({ product: { image_front_small_url: PHOTO } }));
    expect(await productImageUrl(CODE, fetcher)).toBe(PHOTO);
    expect(String((fetcher.mock.calls as unknown[][])[0]?.[0])).toBe(`https://world.openfoodfacts.org/api/v2/product/${Number(CODE)}.json?fields=image_front_small_url,image_front_url,image_small_url`);
    expect(knownProductImage(CODE)).toBe(PHOTO);
    expect(await productImageUrl(CODE, fetcher)).toBe(PHOTO);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dos preguntas a la vez comparten la petición', async () => {
    const fetcher = vi.fn(async () => reply({ product: { image_front_small_url: PHOTO } }));
    const [a, b] = await Promise.all([productImageUrl(CODE, fetcher), productImageUrl(CODE, fetcher)]);
    expect([a, b]).toEqual([PHOTO, PHOTO]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sin conexión o con la API caída da «sin foto» en silencio y no insiste durante media hora', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await productImageUrl(CODE, fetcher, () => now)).toBeNull();
    expect(knownProductImage(CODE, now)).toBeUndefined(); // un fallo de red no se da por «el producto no tiene foto»
    expect(await productImageUrl(CODE, fetcher, () => now)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 20 * 60_000;
    expect(await productImageUrl(CODE, fetcher, () => now)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1); // a los 20 min aún no
    now += 11 * 60_000;
    expect(await productImageUrl(CODE, fetcher, () => now)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('un error del servidor tampoco avisa ni se recuerda como «sin foto»', async () => {
    const fetcher = vi.fn(async () => reply({ error: 'x' }, 503));
    expect(await productImageUrl(CODE, fetcher)).toBeNull();
    expect(knownProductImage(CODE)).toBeUndefined();
  });

  it('un producto que no existe (404) o sin foto se recuerda 14 días como «sin foto»; uno con foto, 30', async () => {
    let now = 5_000_000;
    const fetcher = vi.fn(async () => reply({ status: 0 }, 404));
    expect(await productImageUrl(CODE, fetcher, () => now)).toBeNull();
    expect(knownProductImage(CODE, now + 13 * 86_400_000)).toBeNull();
    expect(knownProductImage(CODE, now + 15 * 86_400_000)).toBeUndefined();

    const withPhoto = vi.fn(async () => reply({ product: { image_front_small_url: PHOTO } }));
    expect(await productImageUrl('8410000000009', withPhoto, () => now)).toBe(PHOTO);
    expect(knownProductImage('8410000000009', now + 29 * 86_400_000)).toBe(PHOTO);
    expect(knownProductImage('8410000000009', now + 31 * 86_400_000)).toBeUndefined();
  });

  it('una respuesta con una dirección que no es de Open Food Facts da «sin foto»', async () => {
    const fetcher = vi.fn(async () => reply({ product: { image_front_small_url: 'https://evil.example.com/a.jpg' } }));
    expect(await productImageUrl(CODE, fetcher)).toBeNull();
  });

  it('un código que no es un código de barras no se pregunta', async () => {
    const fetcher = vi.fn();
    expect(await productImageUrl('hola', fetcher as unknown as typeof fetch)).toBeNull();
    expect(await productImageUrl('1234567890123', fetcher as unknown as typeof fetch)).toBeNull(); // cifra de control mala
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('con el navegador sin conexión ni lo intenta', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const fetcher = vi.fn();
    expect(await productImageUrl(CODE, fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
