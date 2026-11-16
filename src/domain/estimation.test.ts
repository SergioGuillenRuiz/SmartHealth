import { describe, expect, it } from 'vitest';
import {
  baseStride,
  bmrKcalPerDay,
  calibrateStrideCm,
  cadenceSpm,
  cyclingMet,
  keytelGrossKcalPerMin,
  locomotionMet,
  netCostKcalPerKgKm,
  netKcalFromMet,
  stepsToDistanceM,
  strideFactor,
  walkingFromSteps,
} from './estimation';

const man = { heightCm: 178, weightKg: 80, sex: 'male' as const, birthDate: '1985-06-15' };

describe('zancada y distancia', () => {
  it('se deriva de la altura con el coeficiente de cada sexo', () => {
    expect(baseStride({ heightCm: 178, sex: 'male' }).meters).toBeCloseTo(0.7387, 3);
    expect(baseStride({ heightCm: 165, sex: 'female' }).meters).toBeCloseTo(0.6815, 3);
    expect(baseStride({ heightCm: 178, sex: 'male' }).source).toBe('height');
  });

  it('una zancada fijada por el usuario manda sobre la altura', () => {
    expect(baseStride({ heightCm: 178, sex: 'male', strideCm: 80 })).toEqual({ meters: 0.8, source: 'manual' });
  });

  it('10 000 pasos de una persona de 178 cm son ≈ 7,4 km', () => {
    const stride = baseStride({ heightCm: 178, sex: 'male' });
    expect(stepsToDistanceM(10_000, stride) / 1000).toBeCloseTo(7.39, 1);
  });

  it('la cadencia solo alarga la zancada (correr), nunca la acorta', () => {
    expect(strideFactor(null)).toBe(1);
    expect(strideFactor(40)).toBe(1); // tramo con tiempo parado: no se penaliza
    expect(strideFactor(120)).toBe(1);
    expect(strideFactor(140)).toBeCloseTo(1.144, 3);
    expect(strideFactor(170)).toBeCloseTo(1.36, 2);
    expect(strideFactor(400)).toBe(1.4);
  });

  it('a 170 pasos/min la velocidad resultante es la de un trote creíble (~10 km/h)', () => {
    const stride = baseStride({ heightCm: 175, sex: 'male' });
    const speed = (170 * stepsToDistanceM(1, stride, 170) * 60) / 1000;
    expect(speed).toBeGreaterThan(9);
    expect(speed).toBeLessThan(11.5);
  });

  it('calibración: 1 km en 1 350 pasos → 74,1 cm; datos insuficientes o absurdos → null', () => {
    expect(calibrateStrideCm(1000, 1350)).toBe(74.1);
    expect(calibrateStrideCm(1000, 5)).toBeNull();
    expect(calibrateStrideCm(0, 1000)).toBeNull();
    expect(calibrateStrideCm(5000, 100)).toBeNull(); // 50 m por paso
  });

  it('cadencia: requiere al menos un minuto de datos', () => {
    expect(cadenceSpm(600, 5 * 60_000)).toBe(120);
    expect(cadenceSpm(50, 30_000)).toBeNull();
  });
});

describe('MET y coste energético', () => {
  it('MET de caminar/correr coincide con el Compendio en los puntos tabulados', () => {
    expect(locomotionMet(4.8)).toBeCloseTo(3.5, 5);
    expect(locomotionMet(8.0)).toBeCloseTo(8.3, 5);
    expect(locomotionMet(11.3)).toBeCloseTo(11.0, 5);
    expect(locomotionMet(0)).toBe(1.3); // parado
    expect(locomotionMet(1)).toBe(1.5);
    expect(locomotionMet(2)).toBe(2.0);
  });

  it('el MET crece de forma monótona con la velocidad', () => {
    let previous = 0;
    for (let v = 2; v <= 20; v += 0.5) {
      const met = locomotionMet(v);
      expect(met).toBeGreaterThanOrEqual(previous);
      previous = met;
    }
  });

  it('ciclismo: MET por velocidad', () => {
    expect(cyclingMet(12)).toBeCloseTo(4.0, 5);
    expect(cyclingMet(20.7)).toBeCloseTo(8.0, 5);
    // Con tope: a más de ~29 km/h la bici de ciudad es bajada o viento a favor, no esfuerzo (el Compendio da 15,8 a partir de 32 km/h).
    expect(cyclingMet(29)).toBeCloseTo(12.0, 5);
    expect(cyclingMet(40)).toBeCloseTo(12.0, 5);
    expect(cyclingMet(80)).toBeCloseTo(12.0, 5);
  });

  it('coste neto: caminar ≈ 0,55 y correr ≈ 0,9 kcal/kg/km, con transición gradual', () => {
    expect(netCostKcalPerKgKm(4.8)).toBe(0.55);
    expect(netCostKcalPerKgKm(10)).toBe(0.9);
    expect(netCostKcalPerKgKm(7.5)).toBeGreaterThan(0.55);
    expect(netCostKcalPerKgKm(7.5)).toBeLessThan(0.9);
    expect(netCostKcalPerKgKm(null)).toBe(0.55);
  });

  it('el coste neto es coherente con los METs del Compendio ((MET − 1) / velocidad)', () => {
    for (const v of [4.8, 5.6, 6.4]) {
      const fromMet = (locomotionMet(v) - 1) / v;
      expect(Math.abs(netCostKcalPerKgKm(v) - fromMet)).toBeLessThan(0.1);
    }
    for (const v of [9.7, 11.3, 12.9]) {
      const fromMet = (locomotionMet(v) - 1) / v;
      expect(Math.abs(netCostKcalPerKgKm(v) - fromMet)).toBeLessThan(0.12);
    }
  });

  it('10 000 pasos (7,4 km) de una persona de 80 kg: ~325 kcal netas', () => {
    const stride = baseStride(man);
    const result = walkingFromSteps(10_000, null, stride, 80);
    expect(result.distanceM / 1000).toBeCloseTo(7.39, 1);
    expect(result.kcal).toBeGreaterThan(300);
    expect(result.kcal).toBeLessThan(350);
  });

  it('un tramo corto a cadencia de carrera cuesta más por km que uno de paseo', () => {
    const stride = baseStride(man);
    const walk = walkingFromSteps(1100, 10 * 60_000, stride, 80); // 110 pasos/min
    const run = walkingFromSteps(1700, 10 * 60_000, stride, 80); // 170 pasos/min
    expect(run.kcal / run.distanceM).toBeGreaterThan(walk.kcal / walk.distanceM);
    expect(run.speedKmh ?? 0).toBeGreaterThan(9);
  });

  it('MET neto: 70 kg andando 1 h a 4,8 km/h ≈ 175 kcal', () => {
    expect(netKcalFromMet(locomotionMet(4.8), 70, 1)).toBeCloseTo(175, 0);
    expect(netKcalFromMet(0.5, 70, 1)).toBe(0); // por debajo del reposo no resta
  });
});

describe('metabolismo basal (Mifflin-St Jeor)', () => {
  it('hombre de 41 años, 178 cm, 80 kg → ~1 760 kcal/día', () => {
    expect(bmrKcalPerDay(man, '2026-07-10')).toBeCloseTo(10 * 80 + 6.25 * 178 - 5 * 41 + 5, 5);
  });

  it('mujer: 161 menos en lugar de 5 más', () => {
    const woman = { ...man, sex: 'female' as const };
    expect(bmrKcalPerDay(man, '2026-07-10') - bmrKcalPerDay(woman, '2026-07-10')).toBeCloseTo(166, 5);
  });

  it('con el peso vigente de cada fecha el basal cambia', () => {
    expect(bmrKcalPerDay({ ...man, weightKg: 90 }, '2026-07-10') - bmrKcalPerDay(man, '2026-07-10')).toBeCloseTo(100, 5);
  });
});

describe('Keytel (FC → gasto)', () => {
  it('hombre de 41 años, 80 kg, a 140 lpm: 13,7 kcal/min brutas, coherente con correr a ~10 km/h (MET 9,8 → 13,1)', () => {
    const v = keytelGrossKcalPerMin('male', 140, 80, 41);
    expect(v).toBeCloseTo((-55.0969 + 0.6309 * 140 + 0.1988 * 80 + 0.2017 * 41) / 4.184, 6);
    expect(v).toBeGreaterThan(13);
    expect(v).toBeLessThan(14.5);
  });

  it('crece con la frecuencia cardiaca y nunca es negativa', () => {
    expect(keytelGrossKcalPerMin('female', 150, 65, 35)).toBeGreaterThan(keytelGrossKcalPerMin('female', 110, 65, 35));
    expect(keytelGrossKcalPerMin('female', 40, 65, 35)).toBeGreaterThanOrEqual(0);
  });
});
