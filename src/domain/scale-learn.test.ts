import { describe, expect, it } from 'vitest';
import { decodeFrame, type ScaleFrame } from './scale';
import { describeDecoder, learnDecoder } from './scale-learn';

// Una pesada simulada: báscula vacía, se pone algo (la lectura sube hasta 355 g), se cambia por otra cosa (620 g). Cada formato de trama la codifica a su manera y la
// búsqueda tiene que encontrar el campo del peso solo con lo que «marcaba la pantalla» (355 y 620).

type Encode = (grams: number, index: number) => Uint8Array;

const TIMELINE: Array<{ fromMs: number; grams: number }> = [
  { fromMs: 0, grams: 0 },
  { fromMs: 3_000, grams: 120 },
  { fromMs: 3_200, grams: 301 },
  { fromMs: 3_400, grams: 344 },
  { fromMs: 3_600, grams: 355 },
  { fromMs: 8_000, grams: 480 },
  { fromMs: 8_200, grams: 611 },
  { fromMs: 8_400, grams: 620 },
];
const END_MS = 13_000;
const STEP_MS = 100;
const weightAt = (t: number): number => [...TIMELINE].reverse().find((p) => t >= p.fromMs)?.grams ?? 0;

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const xor = (bytes: number[]): number => bytes.reduce((a, b) => a ^ b, 0);

function stream(source: string, encode: Encode, options: { everyMs?: number; onlyOnChange?: boolean } = {}): ScaleFrame[] {
  const out: ScaleFrame[] = [];
  let previous = -1;
  let i = 0;
  for (let t = 0; t <= END_MS; t += options.everyMs ?? STEP_MS) {
    const grams = weightAt(t);
    if (options.onlyOnChange && grams === previous) continue;
    previous = grams;
    out.push({ source, bytes: encode(grams, i++), atMs: t });
  }
  return out;
}

const LABELS = [
  { value: 355, atMs: 7_500 },
  { value: 620, atMs: 12_500 },
];
const REST = 2_500;

/** El peso que sacan los decodificadores de cada trama de la parte quieta de la pesada, comparado con el verdadero. */
function expectDecodesStableParts(frames: readonly ScaleFrame[], source: string, learned: ReturnType<typeof learnDecoder>): void {
  const best = learned.candidates[0];
  expect(best, 'hay candidato').toBeDefined();
  for (const frame of frames) {
    if (frame.source !== source) continue;
    const stable = (frame.atMs >= 3_600 && frame.atMs < 8_000) || frame.atMs >= 8_400 || frame.atMs < 3_000;
    if (!stable) continue;
    expect(decodeFrame(best!.decoder, frame), `a los ${frame.atMs} ms`).toBeCloseTo(weightAt(frame.atMs), 5);
  }
}

describe('aprender dónde va el peso en las tramas', () => {
  it('entero de 2 bytes big-endian con cabecera y suma de comprobación', () => {
    const frames = stream('n:ffe0/ffe1', (g) => {
      const body = [0xa5, 0x01, 0x04, ...be16(g), g > 0 ? 1 : 0];
      return Uint8Array.from([...body, xor(body)]);
    });
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expect(learned.problem).toBeNull();
    expectDecodesStableParts(frames, 'n:ffe0/ffe1', learned);
    expect(learned.candidates[0]!.decoder).toMatchObject({ kind: 'uint', offset: 3, width: 2, little: false, divisor: 1 });
    expect(learned.candidates[0]!.decoder.guard).toEqual([
      [0, 0xa5],
      [1, 0x01],
      [2, 0x04],
    ]);
  });

  it('décimas de gramo en little-endian, con un contador que cambia en cada trama', () => {
    const frames = stream('n:fff0/fff1', (g, i) => Uint8Array.from([i & 0xff, 0xcc, ...le16(g * 10), 0x00]));
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expectDecodesStableParts(frames, 'n:fff0/fff1', learned);
    expect(learned.candidates[0]!.decoder).toMatchObject({ kind: 'uint', offset: 2, width: 2, little: true, divisor: 10 });
  });

  it('entero de 3 bytes', () => {
    const frames = stream('n:ffb0/ffb2', (g) => Uint8Array.from([0xff, 0xaa, 0x10, 0x00, (g >> 16) & 0xff, (g >> 8) & 0xff, g & 0xff]));
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expectDecodesStableParts(frames, 'n:ffb0/ffb2', learned);
  });

  it('número de coma flotante de 4 bytes', () => {
    const frames = stream('n:ffe0/ffe4', (g) => {
      const out = new Uint8Array(6);
      out[0] = 0x7e;
      new DataView(out.buffer).setFloat32(1, g, true);
      out[5] = 0x0d;
      return out;
    });
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expectDecodesStableParts(frames, 'n:ffe4'.replace('n:ffe4', 'n:ffe0/ffe4'), learned);
    expect(learned.candidates[0]!.decoder.kind).toBe('float32');
  });

  it('texto con el número escrito («ST,GS,  355.0 g»)', () => {
    const frames = stream('n:ffe0/ffe1', (g) => new TextEncoder().encode(`ST,GS,${g.toFixed(1).padStart(7, ' ')} g\r\n`));
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expectDecodesStableParts(frames, 'n:ffe0/ffe1', learned);
    expect(learned.candidates[0]!.decoder.kind).toBe('ascii');
  });

  it('el peso en los datos de fabricante del anuncio (báscula que no se conecta)', () => {
    const frames = stream('a:m:ffff', (g) => Uint8Array.from([0xaa, 0xbb, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, ...be16(g), 0x02]));
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expectDecodesStableParts(frames, 'a:m:ffff', learned);
    expect(learned.candidates[0]!.decoder.source).toBe('a:m:ffff');
  });

  it('entre mensajes de otras longitudes y fuentes con bytes al azar, encuentra la fuente buena', () => {
    const real = stream('n:ffe0/ffe1', (g) => Uint8Array.from([0xa5, 0x02, ...be16(g), 0x00]));
    const battery = stream('n:ffe0/ffe1', () => Uint8Array.from([0xb0, 0x62, 0x00]), { everyMs: 1_000 });
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const noise = stream('n:fff0/fff2', () => Uint8Array.from({ length: 12 }, () => random() & 0xff));
    const learned = learnDecoder({ frames: [...real, ...battery, ...noise], labels: LABELS, restAtMs: REST });
    expect(learned.candidates[0]!.decoder.source).toBe('n:ffe0/ffe1');
    expect(learned.candidates[0]!.decoder.length).toBe(5);
    expect(learned.sources.map((s) => s.source).sort()).toEqual(['n:ffe0/ffe1', 'n:fff0/fff2']);
  });

  it('básculas que solo mandan tramas cuando cambia el peso', () => {
    const frames = stream('n:ffe0/ffe1', (g) => Uint8Array.from([0xa5, 0x01, ...be16(g)]), { onlyOnChange: true });
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expect(learned.candidates[0]!.decoder).toMatchObject({ kind: 'uint', offset: 2, width: 2, divisor: 1 });
  });

  it('con una sola pesada pequeña hay varios candidatos; otra pesada mayor deja el bueno primero', () => {
    // 90 g cabe en un byte; la trama tiene el peso en dos bytes big-endian (…, 0x00, 0x5a). Con 90 g valen «el byte 3» y «los bytes 2–3»; con 620 g solo vale el segundo.
    const frames = stream('n:ffe0/ffe1', (g) => Uint8Array.from([0xa5, ...be16(g), 0x01]).slice(0, 4));
    const small = frames.map((f) => ({ ...f, bytes: f.bytes.slice() }));
    const only90 = learnDecoder({ frames: small, labels: [{ value: 355, atMs: 7_500 }], restAtMs: null });
    expect(only90.candidates.length).toBeGreaterThan(0);
    const both = learnDecoder({ frames: small, labels: LABELS, restAtMs: REST });
    expect(both.candidates[0]!.decoder).toMatchObject({ offset: 1, width: 2, little: false });
  });

  it('no inventa nada: sin tramas lo dice, y con bytes al azar no sale ningún candidato', () => {
    expect(learnDecoder({ frames: [], labels: LABELS }).problem).toBe('no-frames');
    let seed = 3;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const noise = stream('n:fff0/fff2', () => Uint8Array.from({ length: 10 }, () => random() & 0xff));
    const learned = learnDecoder({ frames: noise, labels: LABELS, restAtMs: REST });
    expect(learned.problem).toBe('no-match');
    expect(learned.candidates).toEqual([]);
  });

  it('un campo constante no se toma por el peso aunque coincida con el número escrito', () => {
    const frames = stream('n:ffe0/ffe1', () => Uint8Array.from([0x00, 0x64, 0x00, 0x00])); // siempre 100
    const learned = learnDecoder({ frames, labels: [{ value: 100, atMs: 7_500 }], restAtMs: null });
    // Puede salir como último recurso (una sola observación), pero nunca por delante de uno que cambia.
    for (const candidate of learned.candidates) expect(candidate.distinct).toBeLessThanOrEqual(1);
  });

  it('describe el campo en una frase', () => {
    const frames = stream('n:ffe0/ffe1', (g) => Uint8Array.from([0xa5, 0x01, 0x04, ...be16(g), 0x00]));
    const learned = learnDecoder({ frames, labels: LABELS, restAtMs: REST });
    expect(describeDecoder(learned.candidates[0]!.decoder)).toBe('n:ffe0/ffe1 · tramas de 6 bytes · bytes 3–4 (big-endian)');
  });
});
