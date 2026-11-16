import { describe, expect, it } from 'vitest';
import { decodeFrame, formatGrams, isPlausibleWeight, numbersIn, readUint, sanitizeDecoder, WeightStabilizer, type ScaleDecoder } from './scale';

const decoder: ScaleDecoder = { v: 1, source: 'n:ffe0/ffe1', length: 7, kind: 'uint', offset: 3, width: 2, little: false, divisor: 1, guard: [[0, 0xa5]], index: 0 };
const frame = (bytes: number[], source = 'n:ffe0/ffe1') => ({ source, bytes: Uint8Array.from(bytes) });

describe('decodeFrame', () => {
  it('lee el peso del campo aprendido', () => {
    expect(decodeFrame(decoder, frame([0xa5, 0x01, 0x04, 0x01, 0x63, 0x01, 0x00]))).toBe(355);
    expect(decodeFrame({ ...decoder, little: true }, frame([0xa5, 0x01, 0x04, 0x63, 0x01, 0x01, 0x00]))).toBe(355);
    expect(decodeFrame({ ...decoder, divisor: 10 }, frame([0xa5, 0x01, 0x04, 0x0d, 0xe6, 0x01, 0x00]))).toBe(355.8); // 3558 / 10
  });

  it('ignora lo que no es una trama de peso de esa fuente: otra fuente, otra longitud, otra cabecera', () => {
    expect(decodeFrame(decoder, frame([0xa5, 0x01, 0x04, 0x01, 0x63, 0x01, 0x00], 'n:otra'))).toBeNull();
    expect(decodeFrame(decoder, frame([0xa5, 0x01, 0x04, 0x01, 0x63, 0x01]))).toBeNull();
    expect(decodeFrame(decoder, frame([0xb0, 0x01, 0x04, 0x01, 0x63, 0x01, 0x00]))).toBeNull();
  });

  it('no se cree una lectura imposible (más de lo que pesa la báscula) y da 0 a una tara un poco negativa', () => {
    expect(decodeFrame(decoder, frame([0xa5, 0x01, 0x04, 0xff, 0xff, 0x01, 0x00]))).toBeNull(); // 65535
    expect(decodeFrame({ ...decoder, divisor: 10, kind: 'uint' }, frame([0xa5, 0x01, 0x04, 0x00, 0x00, 0x01, 0x00]))).toBe(0);
    expect(isPlausibleWeight(-3)).toBe(true);
    expect(isPlausibleWeight(-400)).toBe(false);
    expect(isPlausibleWeight(Number.NaN)).toBe(false);
  });

  it('lee texto y decimales de 4 bytes', () => {
    const ascii: ScaleDecoder = { ...decoder, kind: 'ascii', length: null, guard: [], index: 0 };
    expect(decodeFrame(ascii, { source: ascii.source, bytes: new TextEncoder().encode('ST,GS,  355.5 g\r\n') })).toBe(355.5);
    expect(decodeFrame(ascii, { source: ascii.source, bytes: Uint8Array.from([0xa5, 0x01]) })).toBeNull();
    const float: ScaleDecoder = { ...decoder, kind: 'float32', width: 4, offset: 1, length: 5, guard: [], little: true };
    const bytes = new Uint8Array(5);
    new DataView(bytes.buffer).setFloat32(1, 123.5, true);
    expect(decodeFrame(float, { source: float.source, bytes })).toBe(123.5);
  });

  it('readUint y numbersIn: bordes', () => {
    expect(readUint(Uint8Array.from([1, 2, 3]), 1, 2, false)).toBe(0x0203);
    expect(readUint(Uint8Array.from([1, 2, 3]), 2, 2, false)).toBeNull();
    expect(readUint(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0, 4, true)).toBe(4294967295);
    expect(numbersIn('ST,GS, 12,5 g -3')).toEqual([12.5, -3]);
  });
});

describe('sanitizeDecoder', () => {
  it('admite uno bueno y rechaza lo estropeado o de otra versión', () => {
    expect(sanitizeDecoder(decoder)).toEqual(decoder);
    expect(sanitizeDecoder(JSON.parse(JSON.stringify(decoder)))).toEqual(decoder);
    for (const bad of [null, 5, 'x', {}, { ...decoder, v: 2 }, { ...decoder, source: '' }, { ...decoder, kind: 'otro' }, { ...decoder, width: 5 }, { ...decoder, divisor: 7 }, { ...decoder, offset: -1 }, { ...decoder, guard: [[0, 300]] }, { ...decoder, guard: 'x' }, { ...decoder, length: 0 }]) {
      expect(sanitizeDecoder(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('WeightStabilizer', () => {
  it('sin lecturas no hay nada; con una, solo es estable cuando pasa el tiempo sin que cambie', () => {
    const s = new WeightStabilizer();
    expect(s.read(0)).toBeNull();
    s.push(355, 1_000);
    expect(s.read(1_100)).toEqual({ grams: 355, stable: false, atMs: 1_000 });
    expect(s.read(1_800)?.stable).toBe(true); // sin tramas nuevas: la báscula calla porque no cambia
  });

  it('el baile de un gramo no la desestabiliza; un cambio mayor, sí, y vuelve a estabilizarse', () => {
    const s = new WeightStabilizer();
    for (let t = 0; t <= 1_000; t += 100) s.push(355 + (t % 200 === 0 ? 0 : 1), t);
    expect(s.read(1_000)?.stable).toBe(true);
    s.push(420, 1_100);
    expect(s.read(1_100)).toMatchObject({ grams: 420, stable: false });
    expect(s.read(1_900)?.stable).toBe(true);
  });

  it('subir poco a poco (añadiendo comida) no se da por estable hasta que se detiene', () => {
    const s = new WeightStabilizer();
    let grams = 0;
    for (let t = 0; t < 3_000; t += 100) {
      grams += 3; // 3 g cada 100 ms
      s.push(grams, t);
      expect(s.read(t)?.stable, `a los ${t} ms`).toBe(t < 700 ? false : s.read(t)?.stable);
    }
    expect(s.read(2_900)?.stable).toBe(false);
    expect(s.read(3_800)?.stable).toBe(true);
  });

  it('reset olvida lo leído', () => {
    const s = new WeightStabilizer();
    s.push(10, 0);
    s.reset();
    expect(s.read(5_000)).toBeNull();
  });
});

describe('formatGrams', () => {
  it('pone una décima solo si la lleva', () => {
    expect(formatGrams(355)).toBe('355 g');
    expect(formatGrams(0.5)).toBe('0,5 g');
    expect(formatGrams(1250)).toBe('1250 g'.replace('1250', (1250).toLocaleString('es-ES')));
  });
});
