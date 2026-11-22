import { describe, expect, it } from 'vitest';
import { fmtTimer } from './format';
import { hudValueSize } from './live-hud';

describe('el tamaño de los indicadores del mapa', () => {
  it('lo normal (hasta 6 caracteres) se ve al tamaño grande de la hoja de estilos', () => {
    for (const value of ['—', '08:05', '59:59', '188', '1.234', '123,45', '12.345', '987']) expect(hudValueSize(value), value).toBeUndefined();
  });

  it('un cronómetro de una hora o más (7 caracteres) se pinta algo más pequeño, a 19 px, algo menos que el normal para que quepa también con una letra ancha', () => {
    for (const value of ['1:02:34', '9:59:59']) expect(hudValueSize(value), value).toBe(19);
  });

  it('un cronómetro de más de 9 horas se achica para que quepa en lugar de cortarse', () => {
    expect(hudValueSize('12:34:56')).toBe(16);
  });

  it('un cronómetro de hasta 9 h 59 min 59 s se pinta a 19 px, y de 10 h en adelante se achica a 16', () => {
    expect(hudValueSize(fmtTimer((9 * 3600 + 59 * 60 + 59) * 1000))).toBe(19);
    expect(hudValueSize(fmtTimer(10 * 3600 * 1000))).toBe(16);
  });
});
