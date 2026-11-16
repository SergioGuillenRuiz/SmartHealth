import { describe, expect, it } from 'vitest';
import { isExpectedSilence, type OutcomeLike } from './outcomes';

const o = (type: string, status: string, detail?: string): OutcomeLike => ({ type, status, ...(detail !== undefined ? { detail } : {}) });

/** Lo que devolvió el R99 real en la sincronización de la segunda ronda de pruebas. */
const R99 = [o('sport', 'ok'), o('sleep', 'empty'), o('heart', 'ok'), o('all', 'ok'), o('spo2', 'timeout', 'sin cabecera')];

describe('isExpectedSilence', () => {
  it('el oxígeno que el R99 nunca contesta no es un fallo si las constantes se leyeron', () => {
    expect(isExpectedSilence(o('spo2', 'timeout', 'sin cabecera'), R99)).toBe(true);
  });

  it('sin las constantes leídas, sí lo es: el oxígeno no ha llegado por ningún lado', () => {
    const noConstants = R99.map((x) => (x.type === 'all' ? o('all', 'timeout', 'sin cabecera') : x));
    expect(isExpectedSilence(o('spo2', 'timeout', 'sin cabecera'), noConstants)).toBe(false);
    expect(isExpectedSilence(o('spo2', 'timeout', 'sin cabecera'), [o('spo2', 'timeout', 'sin cabecera')])).toBe(false);
  });

  it('un silencio a mitad de transferencia, un error o datos dañados de oxígeno sí lo son', () => {
    expect(isExpectedSilence(o('spo2', 'timeout', 'silencio con 12/100 B'), R99)).toBe(false);
    expect(isExpectedSilence(o('spo2', 'error', 'conexión perdida'), R99)).toBe(false);
    expect(isExpectedSilence(o('spo2', 'corrupt'), R99)).toBe(false);
  });

  it('solo vale para el oxígeno: cualquier otro tipo que no conteste es un fallo', () => {
    expect(isExpectedSilence(o('sleep', 'timeout', 'sin cabecera'), R99)).toBe(false);
    expect(isExpectedSilence(o('heart', 'timeout', 'sin cabecera'), R99)).toBe(false);
  });
});
