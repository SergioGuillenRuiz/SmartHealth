import { describe, expect, it } from 'vitest';
import { hrMaxForAge, personalHrMax, workoutPeakBpm, zoneOf } from './hrzones';

describe('zonas de pulso', () => {
  it('FC máxima de Tanaka', () => {
    expect(hrMaxForAge(40)).toBe(180);
    expect(hrMaxForAge(20)).toBe(194);
    expect(hrMaxForAge(60)).toBe(166);
  });

  it('asigna zona por porcentaje de la FC máxima y devuelve null en reposo', () => {
    const max = 180;
    expect(zoneOf(80, max)).toBeNull(); // 44 %
    expect(zoneOf(95, max)?.index).toBe(1); // 53 %
    expect(zoneOf(115, max)?.index).toBe(2); // 64 %
    expect(zoneOf(135, max)?.index).toBe(3); // 75 %
    expect(zoneOf(150, max)?.index).toBe(4); // 83 %
    expect(zoneOf(170, max)?.index).toBe(5); // 94 %
    expect(zoneOf(190, max)?.index).toBe(5); // por encima de la teórica sigue siendo la zona máxima
  });
});

describe('la zona de un pulso moderado nunca sale «sin zona» (el fallo de la ronda 40: con reserva cardiaca, 110 lpm quedaba bajo la zona 1)', () => {
  it('el caso del deportista de 27 años con máximo 195: 110 lpm es zona 1 y de ahí hacia arriba', () => {
    expect(zoneOf(110, 195)?.index).toBe(1); // 56 %
    expect(zoneOf(125, 195)?.index).toBe(2); // 64 %
    expect(zoneOf(145, 195)?.index).toBe(3); // 74 %
    expect(zoneOf(160, 195)?.index).toBe(4); // 82 %
    expect(zoneOf(180, 195)?.index).toBe(5); // 92 %
  });

  it('110 lpm tiene zona con cualquier pulso máximo posible (hasta 220), sea cual sea la edad', () => {
    for (let age = 5; age <= 100; age++) {
      const max = hrMaxForAge(age);
      expect(zoneOf(110, max), `edad ${age}, máximo ${max}`).not.toBeNull();
    }
    for (let max = 110; max <= 220; max++) expect(zoneOf(110, max)).not.toBeNull();
  });

  it('por debajo de la mitad del máximo es reposo (sin zona) y la zona sube con el pulso, sin saltos hacia atrás', () => {
    expect(zoneOf(94, 190)).toBeNull(); // 49 %
    expect(zoneOf(95, 190)?.index).toBe(1);
    let last = 0;
    for (let bpm = 30; bpm <= 230; bpm++) {
      const index = zoneOf(bpm, 190)?.index ?? 0;
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
    expect(last).toBe(5);
  });
});

describe('pulso máximo personal', () => {
  const longHr = (bpms: number[]): Array<[number, number]> => bpms.map((bpm, i) => [i * 30_000, bpm]);
  const hour = 3_600_000;

  it('el pico de un entreno es el segundo valor más alto (un pico suelto del sensor no cuenta) y pide un rato de verdad', () => {
    const bpms = [...Array.from({ length: 30 }, () => 150), 199, 171];
    expect(workoutPeakBpm(longHr(bpms), hour)).toBe(171);
    expect(workoutPeakBpm(longHr(bpms), 9 * 60_000)).toBeNull(); // menos de 10 min
    expect(workoutPeakBpm(longHr(bpms.slice(0, 15)), hour)).toBeNull(); // menos de 20 lecturas
    expect(workoutPeakBpm(longHr([...bpms, 250, 9]), hour)).toBe(171); // lecturas imposibles fuera
  });

  it('con tres entrenos que llegan a la fórmula o más, manda el máximo observado (el segundo pico más alto)', () => {
    const age = 27; // Tanaka: 189
    expect(personalHrMax(age, [199, 196, 190])).toEqual({ hrMax: 196, source: 'observed' });
    expect(personalHrMax(age, [186, 150, 120])).toEqual({ hrMax: 189, source: 'age' }); // el segundo más alto (150) queda lejos de la fórmula
    expect(personalHrMax(age, [190, 188, 185])).toEqual({ hrMax: 188, source: 'observed' });
  });

  it('sin esfuerzos cerca del máximo, o sin entrenos suficientes, se queda la fórmula por edad', () => {
    expect(personalHrMax(27, [])).toEqual({ hrMax: 189, source: 'age' });
    expect(personalHrMax(27, [199, 196])).toEqual({ hrMax: 189, source: 'age' }); // solo dos entrenos
    expect(personalHrMax(27, [160, 158, 150, 148])).toEqual({ hrMax: 189, source: 'age' }); // nunca apretó
  });

  it('un máximo observado no pasa de la fórmula + 25 ni de 220', () => {
    expect(personalHrMax(27, [215, 214, 213]).hrMax).toBe(189 + 25);
    expect(personalHrMax(20, [230, 229, 228]).hrMax).toBe(194 + 25);
    expect(personalHrMax(10, [225, 224, 223]).hrMax).toBe(220);
  });
});
