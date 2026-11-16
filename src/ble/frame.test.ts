import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './bytes';
import { buildFrame, FrameAssembler, frameErrorOf, parseFrame } from './frame';
import { msToRingSeconds, ringSecondsToMs } from './time';

// Vectores de docs/protocolo-ycbt.md (tomados de las referencias del SDK y de PulseLoop).
describe('buildFrame', () => {
  it('consulta de historial de FC: 05 06 06 00 83 20', () => {
    expect(toHex(buildFrame(0x05, 0x06), ' ')).toBe('05 06 06 00 83 20');
  });

  it('ACK de bloque aceptado y con CRC erróneo', () => {
    expect(toHex(buildFrame(0x05, 0x80, [0x00]), ' ')).toBe('05 80 07 00 00 f3 6a');
    expect(toHex(buildFrame(0x05, 0x80, [0x04]), ' ')).toBe('05 80 07 00 04 77 2a');
  });

  it('ACK de aviso del anillo: 04 13 07 00 00 e1 9d', () => {
    expect(toHex(buildFrame(0x04, 0x13, [0x00]), ' ')).toBe('04 13 07 00 00 e1 9d');
  });

  it('medidas en vivo: iniciar/parar FC y SpO2', () => {
    expect(toHex(buildFrame(0x03, 0x2f, [0x01, 0x00]), ' ')).toBe('03 2f 08 00 01 00 4f 1b');
    expect(toHex(buildFrame(0x03, 0x2f, [0x00, 0x00]), ' ')).toBe('03 2f 08 00 00 00 7e 28');
    expect(toHex(buildFrame(0x03, 0x2f, [0x01, 0x02]), ' ')).toBe('03 2f 08 00 01 02 0d 3b');
  });

  it('estado en vivo y buscar anillo', () => {
    expect(toHex(buildFrame(0x03, 0x09, [0x01, 0x00, 0x02]), ' ')).toBe('03 09 09 00 01 00 02 a0 de');
    expect(toHex(buildFrame(0x03, 0x00, [0x01, 0x05, 0x02]), ' ')).toBe('03 00 09 00 01 05 02 b7 69');
  });
});

describe('parseFrame', () => {
  it('ida y vuelta', () => {
    const frame = parseFrame(buildFrame(0x02, 0x00, [1, 2, 3]));
    expect(frame).toMatchObject({ group: 2, cmd: 0, crcOk: true });
    expect(Array.from(frame?.payload ?? [])).toEqual([1, 2, 3]);
  });

  it('rechaza una longitud declarada distinta de la real', () => {
    const bytes = buildFrame(0x02, 0x00, [1, 2, 3]);
    expect(parseFrame(bytes.slice(0, bytes.length - 1))).toBeNull();
  });

  it('conserva la trama pero marca el CRC erróneo', () => {
    const bytes = buildFrame(0x02, 0x00, [1, 2, 3]);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(parseFrame(bytes)?.crcOk).toBe(false);
  });

  it('detecta estados de error de 1 byte, y solo de 1 byte', () => {
    const err = parseFrame(buildFrame(0x05, 0x33, [0xfc]));
    expect(err && frameErrorOf(err)).toBe(0xfc);
    const data = parseFrame(buildFrame(0x05, 0x33, [0xfc, 0x00]));
    expect(data && frameErrorOf(data)).toBeNull();
    const normal = parseFrame(buildFrame(0x05, 0x33, [0x10]));
    expect(normal && frameErrorOf(normal)).toBeNull();
  });
});

describe('FrameAssembler', () => {
  const a = buildFrame(0x06, 0x01, [72]);
  const b = buildFrame(0x05, 0x15, Array.from({ length: 40 }, (_, i) => i));

  it('une una trama repartida en varias notificaciones', () => {
    const asm = new FrameAssembler();
    const out = [
      ...asm.push('stream', b.slice(0, 7)),
      ...asm.push('stream', b.slice(7, 30)),
      ...asm.push('stream', b.slice(30)),
    ];
    expect(out).toHaveLength(1);
    expect(toHex(out[0] ?? [])).toBe(toHex(b));
  });

  it('separa varias tramas que llegan en una sola notificación', () => {
    const asm = new FrameAssembler();
    const joined = new Uint8Array([...a, ...b, ...a]);
    expect(asm.push('stream', joined)).toHaveLength(3);
  });

  it('no mezcla fragmentos de canales distintos', () => {
    const asm = new FrameAssembler();
    expect(asm.push('stream', b.slice(0, 10))).toHaveLength(0);
    // Una trama completa por el otro canal no debe tocar el fragmento pendiente del primero.
    expect(asm.push('command', a)).toHaveLength(1);
    expect(asm.push('stream', b.slice(10))).toHaveLength(1);
  });

  it('se resincroniza tras basura al principio', () => {
    const asm = new FrameAssembler();
    const out = asm.push('command', new Uint8Array([0xde, 0xad, 0x99, ...a]));
    expect(out).toHaveLength(1);
    expect(toHex(out[0] ?? [])).toBe(toHex(a));
  });

  it('una longitud absurda no bloquea el canal', () => {
    const asm = new FrameAssembler();
    const bogus = fromHex('05 06 ff ff');
    const out = asm.push('command', new Uint8Array([...bogus, ...a]));
    expect(out).toHaveLength(1);
  });

  it('una cabecera falsa de longitud verosímil tampoco bloquea el canal', () => {
    // 05 06 ff 06 → longitud declarada 0x06ff = 1791: plausible en rango, pero imposible de cumplir.
    const asm = new FrameAssembler();
    const bogus = fromHex('05 06 ff 06');
    const out = asm.push('command', new Uint8Array([...bogus, ...a, ...a]));
    expect(out).toHaveLength(2);
    expect(asm.droppedBytes).toBeGreaterThan(0);
  });

  it('descarta una trama con CRC erróneo y sigue con la siguiente', () => {
    const asm = new FrameAssembler();
    const corrupt = a.slice();
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0x55;
    const out = asm.push('command', new Uint8Array([...corrupt, ...b]));
    expect(out).toHaveLength(1);
    expect(toHex(out[0] ?? [])).toBe(toHex(b));
  });

  it('espera a una trama genuina que aún no ha llegado entera', () => {
    const asm = new FrameAssembler();
    expect(asm.push('stream', b.slice(0, 20))).toHaveLength(0);
    expect(asm.droppedBytes).toBe(0);
    expect(asm.push('stream', b.slice(20))).toHaveLength(1);
  });
});

describe('tiempo del anillo', () => {
  it('ida y vuelta en hora local', () => {
    const ms = new Date(2026, 6, 6, 12, 34, 14).getTime();
    expect(ringSecondsToMs(msToRingSeconds(ms))).toBe(ms);
  });

  it('el sello 836 694 044 corresponde a 2026-07-06 23:00:44 hora local de pared', () => {
    // 836 694 044 s desde 2000-01-01 (hora de pared) — vector del historial de FC documentado.
    const d = new Date(ringSecondsToMs(836_694_044));
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 7, 6, 23, 0,
    ]);
  });

  it('mantiene la hora de pared a ambos lados del cambio de hora de marzo', () => {
    // 2026-03-29: en Madrid las 02:00 pasan a 03:00. Una hora de pared posterior no debe verse alterada.
    const after = new Date(2026, 2, 29, 10, 0, 0).getTime();
    const d = new Date(ringSecondsToMs(msToRingSeconds(after)));
    expect(d.getHours()).toBe(10);
    const before = new Date(2026, 2, 28, 10, 0, 0).getTime();
    expect(new Date(ringSecondsToMs(msToRingSeconds(before))).getHours()).toBe(10);
  });
});
