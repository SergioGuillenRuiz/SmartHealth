import { describe, expect, it } from 'vitest';
import { clipSpans, coveredMs, mergeSpans, parseSpans } from './phone-activity';

describe('mergeSpans', () => {
  it('ordena y une lo que se toca o está a menos de la separación dada', () => {
    expect(mergeSpans([{ startMs: 50, endMs: 60 }, { startMs: 0, endMs: 10 }, { startMs: 8, endMs: 20 }])).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 50, endMs: 60 },
    ]);
    expect(mergeSpans([{ startMs: 0, endMs: 10 }, { startMs: 40, endMs: 50 }], 30)).toEqual([{ startMs: 0, endMs: 50 }]);
    expect(mergeSpans([{ startMs: 0, endMs: 10 }, { startMs: 41, endMs: 50 }], 30)).toHaveLength(2);
  });

  it('descarta los tramos rotos y no cambia lo que recibe', () => {
    const input = [{ startMs: 10, endMs: 5 }, { startMs: Number.NaN, endMs: 3 }, { startMs: 1, endMs: 2 }];
    expect(mergeSpans(input)).toEqual([{ startMs: 1, endMs: 2 }]);
    expect(input[0]).toEqual({ startMs: 10, endMs: 5 });
  });
});

describe('parseSpans', () => {
  it('lee «inicio:fin;inicio:fin» y se salta lo que no entiende', () => {
    expect(parseSpans('1000:2000;3000:3500')).toEqual([{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 3500 }]);
    expect(parseSpans('')).toEqual([]);
    expect(parseSpans('basura;5:;:7;100:50;abc:def;10:20')).toEqual([{ startMs: 10, endMs: 20 }]);
  });
});

describe('clipSpans y coveredMs', () => {
  const spans = [{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 300 }];

  it('recorta a un intervalo', () => {
    expect(clipSpans(spans, 50, 250)).toEqual([{ startMs: 50, endMs: 100 }, { startMs: 200, endMs: 250 }]);
    expect(clipSpans(spans, 400, 500)).toEqual([]);
  });

  it('cuenta cuánto de un intervalo cubren los tramos', () => {
    expect(coveredMs(spans, 50, 250)).toBe(100);
    expect(coveredMs(spans, 100, 200)).toBe(0);
    expect(coveredMs(spans, -50, 1000)).toBe(200);
  });
});
