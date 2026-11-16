import { describe, expect, it } from 'vitest';
import { DiagnosticLog } from './diag';

const filled = (frames: number): DiagnosticLog => {
  const log = new DiagnosticLog();
  log.info('inicio');
  for (let i = 0; i < frames; i++) log.add(i % 2 === 0 ? 'tx' : 'rx', undefined, [i & 0xff]);
  log.warn('aviso importante');
  return log;
};

describe('DiagnosticLog.toText', () => {
  it('sin límite devuelve toda la traza', () => {
    const lines = filled(10).toText().split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatch(/info\s+inicio$/);
  });

  it('con un límite de tramas conserva las primeras y las últimas, resume lo omitido y no pierde ni notas ni avisos', () => {
    const text = filled(100).toText({ maxFrames: 10 });
    const lines = text.split('\n');
    // 10 tramas (5 + 5) + «inicio» + «aviso» + la línea de resumen
    expect(lines).toHaveLength(13);
    expect(text).toContain('… 90 tramas omitidas');
    expect(text).toContain('inicio');
    expect(text).toContain('aviso importante');
    const hexes = lines.filter((l) => /\b(tx|rx)\b/.test(l)).map((l) => l.trim().split(/\s+/).at(-1));
    expect(hexes).toEqual(['00', '01', '02', '03', '04', '5f', '60', '61', '62', '63']);
  });

  it('por debajo del límite no omite nada ni añade el resumen', () => {
    const text = filled(6).toText({ maxFrames: 10 });
    expect(text).not.toContain('omitidas');
    expect(text.split('\n')).toHaveLength(8);
  });

  it('los datos en bruto fijados salen al final y no se pierden por el límite de entradas de la traza', () => {
    const log = new DiagnosticLog(5); // capacidad diminuta: la traza se recorta enseguida
    log.pin('sueño: buffer reensamblado (3 B)', ['0000: af fa 01']);
    for (let i = 0; i < 50; i++) log.add('rx', undefined, [i]);
    const text = log.toText();
    expect(text.split('\n').filter((l) => /\brx\b/.test(l))).toHaveLength(5);
    expect(text).toContain('--- datos en bruto');
    expect(text.endsWith('sueño: buffer reensamblado (3 B)\n0000: af fa 01')).toBe(true);
  });
});
