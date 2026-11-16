import { describe, expect, it } from 'vitest';
import { fromHex } from './bytes';
import { BASELINE_CAPABILITIES, parseSupportFunction, withBaseline } from './support';

// Respuesta 02 01 REAL de un R99 (firmware 2.32): primeros 24 bytes; el resto era relleno de ceros.
const R99_BITMAP = fromHex('f9 09 00 00 00 00 0c d8 10 04 01 b2 b6 00 40 0f 00 14 50 00 00 00 20 00');

describe('parseSupportFunction', () => {
  it('el bitmap real del R99 declara pasos, sueño, FC, presión, SpO2 y sus medidas manuales', () => {
    const caps = parseSupportFunction(R99_BITMAP);
    expect([...caps].sort()).toEqual(
      ['bloodPressure', 'heartRate', 'manualBloodPressure', 'manualHeartRate', 'manualSpo2', 'sleep', 'spo2', 'steps'].sort(),
    );
  });

  it('el R99 NO declara HRV, temperatura, estrés ni glucosa (lo confirman sus rechazos 0xFC)', () => {
    const caps = parseSupportFunction(R99_BITMAP);
    for (const absent of ['hrv', 'manualHrv', 'temperature', 'stress', 'bloodSugar'] as const) {
      expect(caps.has(absent)).toBe(false);
    }
  });

  it('una respuesta truncada no se interpreta como "el anillo lo niega"', () => {
    expect(parseSupportFunction(new Uint8Array([0xff, 0xff])).size).toBe(0);
  });
});

describe('withBaseline (funciones básicas de la familia)', () => {
  it('añade pasos, sueño, pulso y SpO2 aunque el bitmap no los marque, y conserva lo que sí declara', () => {
    const caps = withBaseline(parseSupportFunction(new Uint8Array([0x00, 0x00, 0, 0, 0, 0, 0, 0, 0x01, 0, 0, 0, 0, 0]))); // solo temperatura
    for (const basic of BASELINE_CAPABILITIES) expect(caps.has(basic)).toBe(true);
    expect(caps.has('temperature')).toBe(true);
    expect(caps.has('hrv')).toBe(false);
  });

  it('sin bitmap (el anillo no contestó) son solo las básicas', () => {
    expect([...withBaseline()].sort()).toEqual(['heartRate', 'sleep', 'spo2', 'steps']);
  });
});
