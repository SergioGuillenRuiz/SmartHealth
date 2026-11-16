import { describe, expect, it } from 'vitest';
import type { GpsFix } from '../domain/gps';
import type { HrProfile } from '../domain/hrzones';
import type { ResolvedProfile } from '../domain/profile';
import { estimateWorkout } from '../domain/workout';
import { WorkoutRecorder } from './workout-recorder';

const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };
const T0 = new Date(2026, 6, 10, 18, 0, 0).getTime();
const lat = (meters: number): number => 40 + meters / 111_195;

function setup(sport: 'walk' | 'run' | 'hike' | 'cycle' | 'gym' = 'walk', extra: { useGps?: boolean; hr?: HrProfile | null } = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const rec = new WorkoutRecorder({ sport, profile, now: clock.now, useGps: extra.useGps ?? false, id: 'w1', ...(extra.hr === undefined ? {} : { hr: extra.hr }) });
  return { rec, clock };
}

describe('WorkoutRecorder: cronómetro y pausas', () => {
  it('el tiempo activo descuenta las pausas', () => {
    const { rec, clock } = setup('gym');
    clock.advance(10 * 60_000);
    rec.pause();
    clock.advance(4 * 60_000);
    rec.resume();
    clock.advance(6 * 60_000);
    const s = rec.snapshot();
    expect(s.activeMs).toBe(16 * 60_000);
    expect(s.pausedMs).toBe(4 * 60_000);
    expect(s.status).toBe('running');
  });

  it('finish() en pausa cierra la pausa y fija el final', () => {
    const { rec, clock } = setup('gym');
    clock.advance(5 * 60_000);
    rec.pause();
    clock.advance(2 * 60_000);
    const record = rec.finish();
    expect(record.endMs - record.startMs).toBe(7 * 60_000);
    expect(record.pausedMs).toBe(2 * 60_000);
    expect(rec.snapshot().status).toBe('finished');
  });
});

describe('WorkoutRecorder: pausar, reanudar y terminar a una hora dada (los botones de la notificación)', () => {
  it('la pausa cuenta desde la hora en que se pidió, no desde que la web se enteró', () => {
    const { rec, clock } = setup('gym');
    clock.advance(10 * 60_000);
    // Se tocó «Pausa» hace 3 minutos y la web (parada) lo recoge ahora.
    clock.advance(3 * 60_000);
    rec.pause(T0 + 10 * 60_000);
    clock.advance(2 * 60_000);
    rec.resume(T0 + 14 * 60_000);
    clock.advance(1 * 60_000);
    const s = rec.snapshot();
    expect(s.pausedMs).toBe(4 * 60_000); // de la hora 10 a la 14
    expect(s.activeMs).toBe(12 * 60_000); // 16 min de reloj − 4 de pausa
    expect(s.status).toBe('running');
  });

  it('una hora imposible se acota: nunca del futuro, ni antes de empezar, ni antes de lo último que pasó', () => {
    const { rec, clock } = setup('gym');
    clock.advance(5 * 60_000);
    rec.pause(T0 + 99 * 60_000); // del futuro: vale «ahora»
    clock.advance(60_000);
    rec.resume(T0 + 1); // antes de que empezara la pausa: la pausa queda en cero, no en negativo
    expect(rec.snapshot().pausedMs).toBe(0);
    clock.advance(60_000);
    rec.pause(T0 - 5_000); // antes de empezar el entreno: no puede ser antes de lo último que pasó (la reanudación de hace 2 min)
    clock.advance(60_000);
    rec.resume();
    expect(rec.snapshot().pausedMs).toBe(3 * 60_000); // desde la reanudación anterior (min 5) hasta ahora (min 8)
    const s = rec.snapshot();
    expect(s.pausedMs).toBeLessThanOrEqual(s.activeMs + s.pausedMs);
    expect(s.activeMs).toBeGreaterThanOrEqual(0);
  });

  it('una hora que no es un número se ignora (vale «ahora»)', () => {
    const { rec, clock } = setup('gym');
    clock.advance(60_000);
    rec.pause(Number.NaN);
    clock.advance(60_000);
    rec.resume(Number.POSITIVE_INFINITY);
    expect(rec.snapshot().pausedMs).toBe(60_000);
  });

  it('parar con la hora del toque acaba el entreno ahí aunque la web llegue tarde', () => {
    const { rec, clock } = setup('gym');
    clock.advance(20 * 60_000);
    clock.advance(3 * 60_000); // la web tardó 3 min en enterarse
    const record = rec.finish(T0 + 20 * 60_000);
    expect(record.endMs - record.startMs).toBe(20 * 60_000);
    expect(record.pausedMs).toBe(0);
  });

  it('parar estando en pausa cierra la pausa en la hora de la parada', () => {
    const { rec, clock } = setup('gym');
    clock.advance(10 * 60_000);
    rec.pause();
    clock.advance(10 * 60_000);
    clock.advance(5 * 60_000);
    const record = rec.finish(T0 + 18 * 60_000);
    expect(record.endMs - record.startMs).toBe(18 * 60_000);
    expect(record.pausedMs).toBe(8 * 60_000); // de la hora 10 a la 18
  });

  it('parar con una hora de antes de la pausa no la deja con duración negativa', () => {
    const { rec, clock } = setup('gym');
    clock.advance(10 * 60_000);
    rec.pause();
    clock.advance(5 * 60_000);
    const record = rec.finish(T0 + 2 * 60_000);
    expect(record.pausedMs).toBe(0);
    expect(record.endMs).toBeGreaterThanOrEqual(record.startMs);
  });
});

describe('WorkoutRecorder: pulso', () => {
  it('estadísticas, zona y muestreo espaciado de las muestras guardadas', () => {
    const { rec, clock } = setup('gym');
    for (let i = 0; i < 60; i++) {
      clock.advance(1000);
      rec.onHeartRate(100 + i, clock.now());
    }
    const s = rec.snapshot();
    expect(s.bpm).toBe(159);
    expect(s.maxBpm).toBe(159);
    expect(s.avgBpm).toBe(130);
    expect(s.zone?.index).toBe(4); // 159 / 180 = 88 %
    // 60 s de muestras a 1 Hz → una guardada cada ~5 s
    const record = rec.toRecord();
    expect(record.hr?.length).toBeGreaterThanOrEqual(10);
    expect(record.hr?.length).toBeLessThanOrEqual(14);
  });

  it('con el pulso máximo personal, la zona va por su porcentaje (110 lpm ya es zona 1)', () => {
    const { rec, clock } = setup('gym', { hr: { hrMax: 195, maxSource: 'observed' } });
    clock.advance(1000);
    rec.onHeartRate(110, clock.now());
    const s = rec.snapshot();
    expect(s.hrMax).toBe(195);
    expect(s.zone?.index).toBe(1); // 56 % del máximo (por reserva cardiaca, con reposo de 44, salía «sin zona»)
    rec.onHeartRate(145, clock.now() + 1000);
    expect(rec.snapshot().zone?.index).toBe(3); // 74 %
  });

  it('ignora el pulso en pausa y los valores imposibles', () => {
    const { rec, clock } = setup('gym');
    rec.onHeartRate(120, clock.now());
    rec.pause();
    rec.onHeartRate(180, clock.now());
    rec.resume();
    rec.onHeartRate(300, clock.now());
    rec.onHeartRate(10, clock.now());
    expect(rec.snapshot().maxBpm).toBe(120);
  });

  it('un pulso antiguo (>75 s) no se muestra como actual, pero sigue contando en la media', () => {
    const { rec, clock } = setup('gym');
    rec.onHeartRate(120, clock.now());
    clock.advance(40_000); // con estos anillos el pulso llega en ráfagas cada ~35 s: aún vale
    expect(rec.snapshot().bpm).toBe(120);
    clock.advance(40_000);
    expect(rec.snapshot().bpm).toBeNull();
    expect(rec.snapshot().avgBpm).toBe(120);
  });

  it('aunque el pulso ya no sea reciente, se sabe cuál fue la última lectura y cuánto hace de ella (la pantalla no vuelve a decir «esperando»)', () => {
    const { rec, clock } = setup('gym');
    expect(rec.snapshot().lastPulse, 'antes de la primera lectura no hay nada').toBeNull();
    clock.advance(30_000);
    rec.onHeartRate(120, clock.now() - 2000); // llegó hace 2 s
    clock.advance(100_000);
    const snap = rec.snapshot();
    expect(snap.bpm).toBeNull();
    expect(snap.lastPulse).toEqual({ bpm: 120, ageMs: 102_000 });
  });

  it('las lecturas que llegan tarde (la web estuvo parada) no hacen retroceder el último pulso: manda la más reciente por su hora, no la última en procesarse', () => {
    const { rec, clock } = setup('gym');
    clock.advance(60_000);
    rec.onHeartRate(130, clock.now() - 1000); // la más reciente
    rec.onHeartRate(90, clock.now() - 50_000); // y una antigua que se procesa después
    const snap = rec.snapshot();
    expect(snap.bpm).toBe(130);
    expect(snap.lastPulse).toEqual({ bpm: 130, ageMs: 1000 });
    expect(snap.maxBpm, 'las dos cuentan para el máximo y la media').toBe(130);
    expect(snap.avgBpm).toBe(110);
  });
});

describe('WorkoutRecorder: pasos', () => {
  it('cuenta solo los incrementos del contador diario desde la primera lectura', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(4000); // punto de partida
    clock.advance(60_000);
    rec.onSteps(4100);
    clock.advance(60_000);
    rec.onSteps(4350);
    expect(rec.snapshot().steps).toBe(350);
  });

  it('los pasos dados durante una pausa no cuentan', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(1000);
    clock.advance(60_000);
    rec.onSteps(1200);
    rec.pause();
    clock.advance(60_000);
    rec.onSteps(1500); // 300 pasos en pausa
    rec.resume();
    clock.advance(60_000);
    rec.onSteps(1600);
    expect(rec.snapshot().steps).toBe(300); // 200 + 100
  });

  it('si el contador se reinicia a medianoche, lo nuevo se suma', () => {
    let t = new Date(2026, 6, 10, 23, 58, 0).getTime();
    const rec = new WorkoutRecorder({ sport: 'walk', profile, now: () => t, useGps: false, id: 'w1' });
    rec.onSteps(9900);
    t += 60_000;
    rec.onSteps(9990); // 23:59
    t += 120_000;
    rec.onSteps(40); // 00:01 del día siguiente: reinicio
    t += 60_000;
    rec.onSteps(100);
    expect(rec.snapshot().steps).toBe(90 + 40 + 60);
  });

  it('un descenso del contador que NO es la medianoche es ruido: no suma el valor absoluto', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(5000);
    clock.advance(5000);
    rec.onSteps(4990); // el contador se corrige hacia abajo
    clock.advance(5000);
    rec.onSteps(5010);
    expect(rec.snapshot().steps).toBeLessThanOrEqual(30); // era 5010 con el reinicio mal interpretado
  });

  it('una primera lectura baja seguida del total real del día no cuenta el día entero como entreno', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(0); // lectura obsoleta al conectar
    clock.advance(3000);
    rec.onSteps(7421); // el anillo publica ya el total real
    clock.advance(30_000);
    rec.onSteps(7500);
    expect(rec.snapshot().steps).toBe(79);
  });

  it('tras perder el anillo un rato, los pasos dados mientras tanto sí cuentan (ritmo creíble)', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(2000);
    clock.advance(180_000); // 3 minutos sin conexión
    rec.onSteps(2300); // 300 pasos: 1,7 pasos/s
    expect(rec.snapshot().steps).toBe(300);
  });

  it('un contador que se queda plano con lecturas repetidas y luego sube de golpe no pierde esos pasos', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(3000);
    for (let i = 0; i < 60; i++) {
      clock.advance(1000);
      rec.onSteps(3000); // el anillo repite el mismo total cada segundo
    }
    clock.advance(1000);
    rec.onSteps(3120); // 120 pasos acumulados desde el último cambio, hace 61 s
    expect(rec.snapshot().steps).toBe(120);
  });

  it('una subida repartida en varias notificaciones casi simultáneas se cuenta entera', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(3000);
    clock.advance(20_000);
    rec.onSteps(3040);
    rec.onSteps(3080); // llegan juntas, con el mismo reloj
    rec.onSteps(3120);
    expect(rec.snapshot().steps).toBe(120);
  });

  it('seguir repitiendo un total que ya no cambia no vuelve creíble un salto imposible', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(0);
    clock.advance(1000);
    rec.onSteps(0);
    clock.advance(1000);
    rec.onSteps(7421); // el total real del día: 2 s después del último dato, miles de pasos
    expect(rec.snapshot().steps).toBe(0);
  });

  it('en deportes sin desplazamiento a pie no se muestran pasos ni se guardan', () => {
    const { rec } = setup('gym');
    rec.onSteps(100);
    rec.onSteps(900);
    expect(rec.snapshot().steps).toBeNull();
    expect(rec.toRecord().steps).toBeUndefined();
  });

  it('la distancia sale de los pasos (estimada) y no hay si no se ha movido', () => {
    const { rec, clock } = setup('walk');
    expect(rec.snapshot().distanceM).toBeNull();
    rec.onSteps(0);
    clock.advance(12 * 60_000);
    rec.onSteps(1350);
    const s = rec.snapshot();
    expect(s.distanceSource).toBe('steps');
    expect(s.distanceM).toBeGreaterThan(950);
    expect(s.distanceM).toBeLessThan(1050);
    expect(s.kcal).toBeGreaterThan(0);
  });
});

describe('WorkoutRecorder: entreno a pie quieto', () => {
  it('con el contador del anillo en marcha y sin pasos, se guarda el cero y las calorías son las de estar parado (no las de pasear)', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(4200); // primera lectura: el punto de partida
    for (let i = 0; i < 30; i++) {
      clock.advance(60_000);
      rec.onSteps(4200); // el anillo repite el mismo total: sentado
    }
    const s = rec.snapshot();
    expect(s.steps).toBe(0);
    expect(rec.toRecord().steps).toBe(0);
    // 30 min a 80 kg: ~12 kcal de estar parado, no ~100 de pasear.
    expect(s.kcal).toBeLessThan(15);
    expect(s.kcalMethod).toBe('speed-met');
  });

  it('sin ninguna lectura de pasos (anillo sin conectar) no se sabe si se anduvo: no se guarda el cero y sigue el cálculo de siempre', () => {
    const { rec, clock } = setup('walk');
    clock.advance(30 * 60_000);
    expect(rec.snapshot().steps).toBeNull();
    expect(rec.toRecord().steps).toBeUndefined();
    expect(rec.snapshot().kcalMethod).toBe('met');
  });

  it('en cuanto se camina, los pasos mandan', () => {
    const { rec, clock } = setup('walk');
    rec.onSteps(4200);
    clock.advance(10 * 60_000);
    rec.onSteps(4200 + 1100);
    const s = rec.snapshot();
    expect(s.steps).toBe(1100);
    expect(s.kcalMethod).toBe('speed-met');
    expect(s.kcal).toBeGreaterThan(30);
  });
});

describe('WorkoutRecorder: GPS', () => {
  it('en bici la distancia sale del GPS y las calorías de la velocidad media', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    for (let i = 0; i <= 60; i++) {
      rec.onGps({ lat: lat(i * 80), lon: -3, accuracyM: 5, tsMs: clock.now() });
      clock.advance(10_000); // 80 m cada 10 s = 8 m/s = 28,8 km/h
    }
    const s = rec.snapshot();
    expect(s.distanceSource).toBe('gps');
    expect(s.distanceM).toBeGreaterThan(4700);
    expect(s.distanceM).toBeLessThan(4900);
    expect(s.kcalMethod).toBe('speed-met');
    expect(s.gps).toBe('good');
    expect(rec.toRecord().distanceSource).toBe('gps');
  });

  it('tras una pausa el desplazamiento durante la pausa no se suma', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    rec.onGps({ lat: lat(0), lon: -3, accuracyM: 5, tsMs: clock.now() });
    clock.advance(10_000);
    rec.onGps({ lat: lat(40), lon: -3, accuracyM: 5, tsMs: clock.now() });
    rec.pause();
    clock.advance(120_000);
    rec.resume();
    // El usuario se desplazó 2 km en coche durante la pausa y reanuda desde allí.
    rec.onGps({ lat: lat(2000), lon: -3, accuracyM: 5, tsMs: clock.now() });
    clock.advance(10_000);
    rec.onGps({ lat: lat(2040), lon: -3, accuracyM: 5, tsMs: clock.now() });
    expect(rec.snapshot().distanceM).toBeLessThan(100);
  });

  it('sin GPS activado se ignoran las posiciones y no hay distancia en bici', () => {
    const { rec, clock } = setup('cycle', { useGps: false });
    rec.onGps({ lat: lat(0), lon: -3, accuracyM: 5, tsMs: clock.now() });
    rec.onGps({ lat: lat(500), lon: -3, accuracyM: 5, tsMs: clock.now() + 5000 });
    expect(rec.snapshot().distanceM).toBeNull();
    expect(rec.snapshot().gps).toBe('off');
  });
});

describe('WorkoutRecorder: sin anillo y sin moverse no se anotan calorías de pasear (el fallo de la ronda 24, ahora con el GPS del móvil)', () => {
  /** Diez minutos con el móvil quieto: una lectura cada 5 s con el temblor normal del GPS. */
  const sitStill = (rec: WorkoutRecorder, clock: { now: () => number; advance: (ms: number) => number }, minutes: number, jitterM = 2): void => {
    for (let i = 0; i < (minutes * 60) / 5; i++) {
      rec.onGps({ lat: lat(((i * 7) % 5) * (jitterM / 4)), lon: -3, accuracyM: 6, tsMs: clock.now() });
      clock.advance(5000);
    }
  };

  it('«Caminar» con el GPS quieto 10 min (sin pasos, sin pulso) no suma calorías de caminar', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    sitStill(rec, clock, 10);
    const s = rec.snapshot();
    expect(s.activeMs).toBeGreaterThanOrEqual(9.9 * 60_000);
    expect(s.kcal).toBeLessThan(6); // caminando serían ≈ 33 kcal (MET 3,5 a 80 kg); parado, ≈ 4
    const record = rec.toRecord();
    expect(record.distanceM).toBe(0);
    expect(record.distanceSource).toBe('gps');
    expect(estimateWorkout(record, profile).kcalMethod).toBe('speed-met');
  });

  it('lo mismo al correr y en senderismo (que no tiene velocidad-MET propia)', () => {
    for (const sport of ['run', 'hike'] as const) {
      const { rec, clock } = setup(sport, { useGps: true });
      sitStill(rec, clock, 10);
      expect(rec.snapshot().kcal, sport).toBeLessThan(6);
    }
  });

  it('en cuanto se echa a andar, vuelve la cuenta normal por la velocidad', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    sitStill(rec, clock, 5);
    for (let m = 0; m <= 420; m += 7) {
      rec.onGps({ lat: lat(m), lon: -3, accuracyM: 5, tsMs: clock.now(), speedMs: 1.4 });
      clock.advance(5000);
    }
    const s = rec.snapshot();
    expect(s.distanceM).toBeGreaterThan(350);
    expect(s.kcal).toBeGreaterThan(18); // 5 min parado (≈ 2) + 5 min a 5 km/h (≈ 22)
    expect(s.kcal).toBeLessThan(40);
    expect(rec.toRecord().distanceM).toBeGreaterThan(350);
  });

  it('con el GPS sin señal no hay pruebas de que no se moviera: sigue la estimación genérica del deporte', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    clock.advance(10 * 60_000);
    const record = rec.toRecord();
    expect(record.distanceM).toBeUndefined();
    expect(rec.snapshot().kcal).toBeGreaterThan(20);
  });

  it('con pasos del anillo (andar en una cinta, con el GPS quieto) manda la distancia por pasos, no el «no se movió» del GPS', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    for (let i = 0; i < 120; i++) {
      rec.onGps({ lat: lat(0), lon: -3, accuracyM: 6, tsMs: clock.now() });
      rec.onSteps(i * 9, clock.now());
      clock.advance(5000);
    }
    const record = rec.toRecord();
    expect(record.distanceM).toBeUndefined();
    expect(rec.snapshot().distanceSource).toBe('steps');
    expect(rec.snapshot().kcal).toBeGreaterThan(20);
  });
});

describe('WorkoutRecorder: las calorías no suben sin hacer el ejercicio (ronda 45: en bici y en fuerza subían parado)', () => {
  const sitStill = (rec: WorkoutRecorder, clock: { now: () => number; advance: (ms: number) => number }, minutes: number): void => {
    for (let i = 0; i < (minutes * 60) / 5; i++) {
      rec.onGps({ lat: lat(((i * 7) % 5) * 0.5), lon: -3, accuracyM: 6, tsMs: clock.now() });
      clock.advance(5000);
    }
  };
  /** Pulso en reposo, una lectura cada 5 s (el anillo lo da en ráfagas, aquí a un ritmo más cómodo). */
  const restingPulse = (rec: WorkoutRecorder, clock: { now: () => number; advance: (ms: number) => number }, minutes: number, bpm = 64): void => {
    for (let i = 0; i < (minutes * 60) / 5; i++) {
      rec.onHeartRate(bpm + (i % 3), clock.now());
      clock.advance(5000);
    }
  };

  it('«Ciclismo» con el GPS quieto 10 min (sin pulso) no suma las ~70 kcal de pedalear: queda en reposo', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    sitStill(rec, clock, 10);
    const s = rec.snapshot();
    expect(s.kcal).toBeLessThan(6); // pedaleando serían ≈ (6,8 − 1) × 80 / 6 = 77
    const record = rec.toRecord();
    expect(record.distanceM).toBe(0);
    expect(record.distanceSource).toBe('gps');
  });

  it('en bici, los pasos que cuenta el anillo (la muñeca se mueve con el manillar) no cuentan como moverse', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    rec.onSteps(1000, clock.now());
    for (let i = 0; i < 120; i++) {
      rec.onGps({ lat: lat(((i * 7) % 5) * 0.5), lon: -3, accuracyM: 6, tsMs: clock.now() });
      rec.onSteps(1000 + i * 3, clock.now());
      clock.advance(5000);
    }
    expect(rec.snapshot().kcal).toBeLessThan(6);
  });

  it('«Fuerza» con el pulso de reposo 20 min: las calorías no suben (antes, (4 − 1) × 80 / 3 = 80)', () => {
    const { rec, clock } = setup('gym');
    restingPulse(rec, clock, 20);
    const s = rec.snapshot();
    expect(s.kcal).toBeLessThan(10);
    expect(s.activeMs).toBeGreaterThanOrEqual(19.9 * 60_000); // el tiempo corre: lo que no suma es la energía
    expect(estimateWorkout(rec.toRecord(), profile).idleMs).toBeGreaterThanOrEqual(19 * 60_000);
  });

  it('se entrena, se olvida la pausa y se descansa: la parte entrenada suma y el sofá no', () => {
    const { rec, clock } = setup('gym');
    for (let i = 0; i < 20 * 12; i++) {
      rec.onHeartRate(125 + (i % 7), clock.now());
      clock.advance(5000);
    }
    const trained = rec.snapshot().kcal;
    expect(trained).toBeGreaterThan(80);
    restingPulse(rec, clock, 30);
    const later = rec.snapshot().kcal;
    expect(later - trained).toBeLessThan(10); // 30 min de sofá, ~1 kcal por minuto como mucho
  });

  it('sin pulso ni GPS (no hay con qué saberlo) se sigue suponiendo ejercicio: es lo que dijo la persona al empezar', () => {
    const { rec, clock } = setup('gym');
    clock.advance(20 * 60_000);
    expect(rec.snapshot().kcal).toBeGreaterThan(70);
  });
});

describe('WorkoutRecorder: el recorrido para dibujarlo al revisar el entreno', () => {
  const walkNorth = (rec: WorkoutRecorder, clock: { now: () => number; advance: (ms: number) => number }, meters: number): void => {
    for (let m = 0; m <= meters; m += 2) {
      rec.onGps({ lat: lat(m), lon: -3, accuracyM: 5, tsMs: clock.now(), speedMs: 1.4 });
      clock.advance(1430);
    }
  };

  it('con GPS guarda por dónde se fue, con la salida y la llegada en sus extremos', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    walkNorth(rec, clock, 600);
    const route = rec.toRecord().route!;
    expect(route).toBeDefined();
    expect(route[0]).toEqual([Math.round(lat(0) * 1e5) / 1e5, -3]);
    expect(route[route.length - 1]![0]).toBeCloseTo(lat(600), 4);
    expect(route.length).toBeLessThanOrEqual(600);
  });

  it('una recta no pesa más que sus extremos', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    walkNorth(rec, clock, 1500);
    expect(rec.toRecord().route).toHaveLength(2);
  });

  it('un entreno entero (2 h) no pasa del tope de puntos', () => {
    const { rec, clock } = setup('run', { useGps: true });
    for (let i = 0; i < 7200; i++) {
      rec.onGps({ lat: lat(i * 2.8 + 40 * Math.sin(i / 60)), lon: -3 + (35 * Math.cos(i / 90)) / 85_000, accuracyM: 5, tsMs: clock.now(), speedMs: 2.8 });
      clock.advance(1000);
    }
    const route = rec.toRecord().route!;
    expect(route.length).toBeLessThanOrEqual(600);
    expect(route.length).toBeGreaterThan(30);
  });

  it('las lecturas descartadas (mala precisión) no ensucian el recorrido', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    walkNorth(rec, clock, 100);
    rec.onGps({ lat: lat(5000), lon: -3, accuracyM: 900, tsMs: clock.now() }); // una lectura de 900 m de precisión, a 5 km
    clock.advance(1000);
    walkNorth(rec, clock, 100);
    const route = rec.toRecord().route!;
    expect(Math.max(...route.map((p) => p[0]))).toBeLessThan(lat(300));
  });

  it('sin GPS, o quieto (sin la distancia mínima), el registro no lleva recorrido', () => {
    const off = setup('walk', { useGps: false });
    walkNorth(off.rec, off.clock, 300);
    expect(off.rec.toRecord().route).toBeUndefined();
    const still = setup('walk', { useGps: true });
    for (let i = 0; i < 100; i++) {
      still.rec.onGps({ lat: lat(0) + (i % 3) * 1e-6, lon: -3, accuracyM: 5, tsMs: still.clock.now() });
      still.clock.advance(1000);
    }
    expect(still.rec.toRecord().route).toBeUndefined();
  });

  it('pedir el registro (como hace cada instantánea del cronómetro) no cambia el recorrido ni lo recalcula de más', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    walkNorth(rec, clock, 400);
    const a = rec.toRecord().route;
    rec.snapshot();
    expect(rec.toRecord().route).toEqual(a);
  });
});

describe('WorkoutRecorder: velocidad minuto a minuto', () => {
  /** 1 lectura por segundo, con la velocidad del GPS, durante `seconds` a `ms` m/s. */
  function ride(rec: WorkoutRecorder, clock: { now: () => number; advance: (ms: number) => number }, seconds: number, ms: number, from = 0): number {
    let meters = from;
    for (let i = 0; i < seconds; i++) {
      rec.onGps({ lat: lat(meters), lon: -3, accuracyM: 4, tsMs: clock.now(), speedMs: ms });
      meters += ms;
      clock.advance(1000);
    }
    return meters;
  }

  it('guarda los metros de cada minuto activo con la velocidad del GPS', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    ride(rec, clock, 180, 5); // 3 min a 18 km/h
    const record = rec.finish();
    expect(record.distanceSource).toBe('gps');
    expect(record.splitsM?.length).toBe(3);
    for (const m of record.splitsM ?? []) expect(m).toBeGreaterThan(280); // ≈ 300 m por minuto
    const total = (record.splitsM ?? []).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - (record.distanceM ?? 0))).toBeLessThan(3);
  });

  it('los minutos en pausa no cuentan: el reloj de los minutos es el del tiempo activo', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    let m = ride(rec, clock, 60, 5);
    rec.pause();
    clock.advance(10 * 60_000); // diez minutos parado
    rec.resume();
    m = ride(rec, clock, 60, 5, m);
    const record = rec.finish();
    expect(record.splitsM?.length).toBe(2); // 2 minutos activos, no 12
  });

  it('tras un hueco del GPS lo recorrido se reparte por todo el hueco, no cae en el minuto en que vuelve la señal', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    let m = ride(rec, clock, 60, 5); // 1 min a 18 km/h
    // Cinco minutos sin señal (una calle cubierta, la app en segundo plano) en los que se recorren 1 500 m más.
    clock.advance(300_000);
    m += 1500;
    ride(rec, clock, 60, 5, m);
    const splits = rec.finish().splitsM ?? [];
    expect(splits.length).toBe(7);
    for (const meters of splits) {
      expect(meters).toBeGreaterThan(250);
      expect(meters).toBeLessThan(400); // ≈ 300 m por minuto, nunca los 1 500 juntos
    }
  });

  it('un minuto de un hueco en el que no se avanzó cuenta como parado (la posición no cambió), no como desconocido', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    const m = ride(rec, clock, 60, 5);
    clock.advance(60_000); // un minuto sin señal en el que el ciclista siguió en el mismo sitio
    ride(rec, clock, 60, 5, m);
    const splits = rec.finish().splitsM ?? [];
    expect(splits.length).toBe(3);
    expect(splits[1]).toBeLessThan(10);
    expect(splits.every((x) => x >= 0)).toBe(true);
  });

  it('los minutos anteriores a la primera lectura del GPS (aún sin señal) quedan como -1', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    clock.advance(3 * 60_000); // el GPS tarda tres minutos en fijar
    ride(rec, clock, 120, 5);
    expect(rec.finish().splitsM).toEqual([-1, -1, -1, expect.any(Number), expect.any(Number)]);
  });

  it('parado en un semáforo el minuto cuenta 0 m', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    const m = ride(rec, clock, 60, 5);
    ride(rec, clock, 60, 0, m); // parado: el GPS sigue dando lecturas con velocidad 0
    const splits = rec.finish().splitsM ?? [];
    expect(splits[0]).toBeGreaterThan(280);
    expect(splits[1]).toBeLessThanOrEqual(3); // solo lo que frenó al entrar en el minuto
  });

  it('sin velocidad del GPS (solo posiciones), estar parado también es una lectura: el minuto cuenta ~0 m, no «sin señal»', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    // 1 min a 5 m/s con posiciones y sin velocidad, y 3 min parado (las posiciones tiemblan menos que el umbral).
    let meters = 0;
    for (let i = 0; i < 60; i++) {
      rec.onGps({ lat: lat(meters), lon: -3, accuracyM: 4, tsMs: clock.now() });
      meters += 5;
      clock.advance(1000);
    }
    for (let i = 0; i < 180; i++) {
      rec.onGps({ lat: lat(meters + (i % 2)), lon: -3, accuracyM: 4, tsMs: clock.now() });
      clock.advance(1000);
    }
    const splits = rec.finish().splitsM ?? [];
    expect(splits.length).toBe(4);
    expect(splits[0]).toBeGreaterThan(250);
    expect(splits.slice(1).every((x) => x >= 0 && x < 20)).toBe(true); // parado: ~0 m, y no -1
  });

  it('sin GPS no hay velocidad guardada', () => {
    const { rec, clock } = setup('gym');
    clock.advance(10 * 60_000);
    expect(rec.finish().splitsM).toBeUndefined();
  });

  it('con el reloj del GPS 50 s adelantado o atrasado los minutos siguen alineados con el cronómetro (no se pierde el primero)', () => {
    for (const skew of [50_000, -50_000]) {
      const { rec, clock } = setup('cycle', { useGps: true });
      let meters = 0;
      for (let i = 0; i < 180; i++) {
        rec.onGps({ lat: lat(meters), lon: -3, accuracyM: 4, tsMs: clock.now() + skew, speedMs: 5 });
        meters += 5;
        clock.advance(1000);
      }
      const splits = rec.finish().splitsM ?? [];
      expect(splits.length, `desfase ${skew}`).toBe(3);
      for (const m of splits) expect(m, `desfase ${skew}`).toBeGreaterThan(270);
    }
  });

  it('con un reloj del GPS descuadrado se usa el del móvil para repartir los minutos', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    // Lecturas fechadas un día antes: no pueden crear cientos de minutos.
    let meters = 0;
    for (let i = 0; i < 120; i++) {
      rec.onGps({ lat: lat(meters), lon: -3, accuracyM: 4, tsMs: clock.now() - 86_400_000, speedMs: 5 });
      meters += 5;
      clock.advance(1000);
    }
    expect(rec.finish().splitsM?.length).toBeLessThanOrEqual(3);
  });
});

describe('WorkoutRecorder: registro final', () => {
  it('toRecord reúne solo hechos: pasos, GPS y muestras de pulso', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    rec.onSteps(0);
    for (let i = 0; i < 40; i++) {
      clock.advance(5000);
      rec.onHeartRate(110, clock.now());
      rec.onGps({ lat: lat(i * 6), lon: -3, accuracyM: 5, tsMs: clock.now() });
    }
    rec.onSteps(260);
    const r = rec.finish();
    expect(r).toMatchObject({ id: 'w1', sport: 'walk', source: 'live', steps: 260, distanceSource: 'gps' });
    expect(r.distanceM).toBeGreaterThan(200);
    expect(r.hr?.length).toBe(40);
    expect(r.kcalManual).toBeUndefined();
  });

  it('estado de la conexión con el anillo', () => {
    const { rec } = setup('gym');
    expect(rec.snapshot().ringConnected).toBe(true);
    rec.setRingConnected(false);
    expect(rec.snapshot().ringConnected).toBe(false);
  });
});

describe('WorkoutRecorder: el GPS completado con los pasos (deportes a pie)', () => {
  const STRIDE = 0.74; // la zancada de este perfil (178 cm): 0,415 × altura

  /** Anda `seconds` s al norte a `ms` m/s: el GPS (si `gps`) da una lectura por segundo con velocidad y el anillo los pasos. */
  function walk(
    rec: WorkoutRecorder,
    clock: { now: () => number; advance: (ms: number) => number },
    state: { meters: number; steps: number },
    seconds: number,
    ms: number,
    options: { gps?: boolean; steps?: boolean; loop?: boolean } = {},
  ): void {
    const { gps = true, steps = true, loop = false } = options;
    for (let i = 0; i < seconds; i++) {
      state.meters += loop ? 0 : ms; // en un bucle se vuelve al punto de partida: la posición no avanza aunque se ande
      state.steps += ms / STRIDE;
      if (gps) rec.onGps({ lat: lat(state.meters), lon: -3, accuracyM: 4, tsMs: clock.now(), speedMs: ms });
      if (steps) rec.onSteps(Math.round(state.steps), clock.now());
      clock.advance(1000);
    }
  }

  const start = (sport: 'walk' | 'run' | 'cycle' = 'walk') => {
    const { rec, clock } = setup(sport, { useGps: true });
    rec.onSteps(1000, clock.now()); // la primera lectura fija el punto de partida
    return { rec, clock, state: { meters: 0, steps: 1000 } };
  };

  it('con el GPS bien, la distancia es la del GPS y los pasos no la tocan', () => {
    const { rec, clock, state } = start();
    walk(rec, clock, state, 600, 1.3);
    const record = rec.finish();
    expect(record.distanceSource).toBe('gps');
    expect(Math.abs((record.distanceM ?? 0) - 780) / 780).toBeLessThan(0.02);
    for (const m of record.splitsM ?? []) expect(Math.abs(m - 78)).toBeLessThan(6);
  });

  it('quince minutos andando con la app diez minutos en segundo plano (sin GPS) valen lo andado: los minutos sin GPS, por los pasos', () => {
    const { rec, clock, state } = start();
    walk(rec, clock, state, 300, 1.3); // 5 min con GPS: 390 m
    walk(rec, clock, state, 300, 1.3, { gps: false, loop: true }); // 5 min sin GPS dando una vuelta: se vuelve al sitio (la cuerda sale 0)
    walk(rec, clock, state, 300, 1.3); // 5 min más con GPS: 390 m
    // Lo andado en los 5 min sin GPS: 390 m (la posición no avanzó porque fue una vuelta, pero los pasos sí cuentan).
    const record = rec.finish();
    const truth = 390 * 3;
    expect(Math.abs((record.distanceM ?? 0) - truth) / truth).toBeLessThan(0.05);
    // Los minutos sin GPS salen con su distancia (no con -1), y suman lo mismo que el total.
    expect(record.splitsM?.every((m) => m >= 0)).toBe(true);
    const sum = (record.splitsM ?? []).reduce((a, m) => a + m, 0);
    expect(Math.abs(sum - (record.distanceM ?? 0))).toBeLessThan(10);
  });

  it('sin los pasos del anillo, un hueco del GPS sigue siendo solo la cuerda (no se inventa nada)', () => {
    const { rec, clock, state } = start();
    walk(rec, clock, state, 300, 1.3, { steps: false });
    walk(rec, clock, state, 300, 1.3, { gps: false, steps: false, loop: true });
    walk(rec, clock, state, 300, 1.3, { steps: false });
    const record = rec.finish();
    expect(record.distanceM).toBeLessThan(800); // 390 + 390: lo que el GPS vio
    expect(record.splitsM?.some((m) => m === -1)).toBe(false); // los minutos del hueco repartieron la cuerda (0 m), no «sin señal»
  });

  it('una marcha tan lenta que el GPS la toma por estar parado (0,5 m/s) se mide con los pasos', () => {
    const { rec, clock, state } = start();
    // A 0,5 m/s la velocidad que da el GPS cae por debajo del umbral de «parado»: el GPS sumaría 0 m.
    walk(rec, clock, state, 120, 1.3); // primero un tramo normal (156 m)
    walk(rec, clock, state, 600, 0.5); // diez minutos lentísimos: 300 m
    const record = rec.finish();
    const truth = 156 + 300;
    expect(Math.abs((record.distanceM ?? 0) - truth) / truth).toBeLessThan(0.05);
  });

  it('parado con el brazo moviéndose (pocos pasos por minuto) no se inventa distancia', () => {
    const { rec, clock, state } = start();
    for (let i = 0; i < 600; i++) {
      state.steps += 0.1; // ~6 pasos por minuto: gestos, no andar
      rec.onGps({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: clock.now(), speedMs: 0 });
      rec.onSteps(Math.floor(state.steps), clock.now());
      clock.advance(1000);
    }
    expect(rec.finish().distanceM).toBeUndefined();
  });

  it('en bici los pasos del anillo no se usan para nada: la distancia es la del GPS', () => {
    const { rec, clock, state } = start('cycle');
    walk(rec, clock, state, 120, 6);
    walk(rec, clock, state, 120, 6, { gps: false, loop: true }); // dos minutos sin GPS con «pasos» del manillar
    walk(rec, clock, state, 120, 6);
    const record = rec.finish();
    expect(record.steps).toBeUndefined();
    expect(record.distanceM).toBeLessThan(1500); // 720 + 720 (la cuerda del hueco es 0): sin completar con pasos
    expect(record.distanceM).toBeGreaterThan(1380);
  });

  it('si el GPS nunca llegó a dar posiciones, queda la estimación de siempre por pasos (no se etiqueta como GPS)', () => {
    const { rec, clock, state } = start();
    walk(rec, clock, state, 600, 1.3, { gps: false });
    const record = rec.finish();
    expect(record.distanceM).toBeUndefined();
    expect(rec.snapshot().distanceSource).toBe('steps');
    expect(Math.abs((rec.snapshot().distanceM ?? 0) - 780) / 780).toBeLessThan(0.05);
  });

  it('correr: la zancada de los minutos completados con pasos sale de su cadencia', () => {
    const { rec, clock, state } = start('run');
    // 3 m/s con la zancada de correr (más larga que la de andar): ~1,6 pasos por segundo… pero el GPS falla todo el rato.
    for (let i = 0; i < 300; i++) {
      state.steps += 2.8; // 168 pasos por minuto
      state.meters += 3;
      rec.onSteps(Math.round(state.steps), clock.now());
      clock.advance(1000);
    }
    rec.onGps({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: T0, speedMs: 3 }); // una lectura al empezar, para que cuente como entreno con GPS…
    rec.onGps({ lat: lat(15), lon: -3, accuracyM: 4, tsMs: T0 + 5000, speedMs: 3 });
    const record = rec.finish();
    // 300 s × 168 pasos/min × (0,74 m × factor de cadencia ≈ 1,35) ≈ 840 m: más que andando, como debe ser.
    expect(record.distanceM ?? 0).toBeGreaterThan(780);
    expect(record.distanceM ?? 0).toBeLessThan(900);
  });

  it('el desglose por minutos de un paseo completado con pasos se comporta como el de uno normal para la energía por velocidad', () => {
    const { rec, clock, state } = start();
    walk(rec, clock, state, 300, 1.3);
    walk(rec, clock, state, 300, 1.3, { gps: false, loop: true });
    const record = rec.finish();
    const estimate = estimateWorkout(record, profile);
    expect(estimate.kcalMethod).toBe('speed-met'); // el desglose cuadra con la distancia: se usa
    expect(estimate.avgSpeedKmh).toBeGreaterThan(4.3);
    expect(estimate.avgSpeedKmh).toBeLessThan(5);
  });

  describe('el hueco del GPS con curvas (la cuerda siempre se queda corta)', () => {
    const lon = (meters: number): number => -3 + meters / (111_195 * Math.cos((40 * Math.PI) / 180));

    /** Anda por una poligonal (al norte, al este…) a 1,3 m/s; el GPS (si `gps`) da una lectura por segundo y el anillo los pasos. */
    function leg(
      rec: WorkoutRecorder,
      clock: { now: () => number; advance: (ms: number) => number },
      state: { x: number; y: number; steps: number },
      seconds: number,
      direction: 'norte' | 'este',
      gps: boolean,
    ): void {
      for (let i = 0; i < seconds; i++) {
        if (direction === 'norte') state.y += 1.3;
        else state.x += 1.3;
        state.steps += 1.3 / STRIDE;
        if (gps) rec.onGps({ lat: lat(state.y), lon: lon(state.x), accuracyM: 4, tsMs: clock.now(), speedMs: 1.3 });
        rec.onSteps(Math.round(state.steps), clock.now());
        clock.advance(1000);
      }
    }

    it('con el hueco desalineado respecto a los minutos (los de los bordes tienen lecturas propias y parte de la cuerda) el error es de pocos por ciento, no del 10 %', () => {
      for (const [before, east, north, after] of [
        [270, 150, 210, 330],
        [250, 160, 190, 340],
        [330, 130, 170, 320],
      ] as const) {
        const { rec, clock } = setup('walk', { useGps: true });
        rec.onSteps(1000, clock.now());
        const state = { x: 0, y: 0, steps: 1000 };
        leg(rec, clock, state, before, 'norte', true);
        leg(rec, clock, state, east, 'este', false);
        leg(rec, clock, state, north, 'norte', false);
        leg(rec, clock, state, after, 'norte', true);
        const truth = (before + east + north + after) * 1.3;
        const record = rec.finish();
        expect(Math.abs((record.distanceM ?? 0) - truth) / truth, `${before}/${east}/${north}/${after}`).toBeLessThan(0.05);
        expect((record.distanceM ?? 0) / truth).toBeLessThan(1.01); // corta, nunca de más
      }
    });

    it('cinco minutos con la app oculta, alineados con los minutos, dando una vuelta con una esquina (la cuerda sale un 29 % corta) se completan con los pasos: −0,2 %, no −10 %', () => {
      const { rec, clock } = setup('walk', { useGps: true });
      rec.onSteps(1000, clock.now());
      const state = { x: 0, y: 0, steps: 1000 };
      leg(rec, clock, state, 300, 'norte', true); // 390 m con GPS
      leg(rec, clock, state, 150, 'este', false); // oculta: 195 m al este…
      leg(rec, clock, state, 150, 'norte', false); // …y 195 m al norte: la cuerda mide 276 m de 390
      leg(rec, clock, state, 300, 'norte', true); // vuelve el GPS: 390 m más
      const record = rec.finish();
      const truth = 390 * 3;
      expect(Math.abs((record.distanceM ?? 0) - truth) / truth).toBeLessThan(0.03);
      expect(record.splitsM?.every((m) => m >= 0)).toBe(true);
    });

    it('con el GPS bien un minuto con lecturas propias NO se sustituye por los pasos aunque la zancada esté un poco mal (solo cuenta si el GPS dice menos de la mitad)', () => {
      const { rec, clock } = setup('walk', { useGps: true });
      rec.onSteps(1000, clock.now());
      const state = { x: 0, y: 0, steps: 1000 };
      // El anillo cuenta de más (zancada corta de verdad: 0,6 m): los pasos dirían un 23 % más que el GPS, que manda.
      for (let i = 0; i < 600; i++) {
        state.y += 1.3;
        state.steps += 1.3 / 0.6;
        rec.onGps({ lat: lat(state.y), lon: -3, accuracyM: 4, tsMs: clock.now(), speedMs: 1.3 });
        rec.onSteps(Math.round(state.steps), clock.now());
        clock.advance(1000);
      }
      const record = rec.finish();
      expect(Math.abs((record.distanceM ?? 0) - 780) / 780).toBeLessThan(0.02);
    });
  });
});

describe('WorkoutRecorder: posiciones que recoge el servicio nativo con la app oculta (llegan tarde, con su hora)', () => {
  /** Una posición por segundo a `speed` m/s en línea recta, con la velocidad del GPS, para los segundos [fromS, toS) del entreno. */
  const fixesBetween = (fromS: number, toS: number, speed = 6): GpsFix[] =>
    Array.from({ length: toS - fromS }, (_, k) => ({ lat: lat((fromS + k) * speed), lon: -3, accuracyM: 5, tsMs: T0 + (fromS + k) * 1000, speedMs: speed }));

  it('diez minutos de bici recogidos de golpe al volver a verse la app reparten lo recorrido minuto a minuto, no lo apilan en el último', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    clock.advance(10 * 60_000); // la app estuvo oculta todo ese rato: ahora es T0 + 10 min
    for (const fix of fixesBetween(0, 600)) rec.onGps(fix, { trustTime: true });
    const record = rec.toRecord();
    expect(record.distanceM).toBeGreaterThan(3550); // 599 s a 6 m/s
    expect(record.distanceM).toBeLessThan(3650);
    expect(record.splitsM).toHaveLength(10);
    for (const meters of record.splitsM ?? []) {
      expect(meters).toBeGreaterThan(330);
      expect(meters).toBeLessThan(390);
    }
    // Sin fiarse de la hora de las posiciones (el GPS de la web, que llega al segundo) todo cae en el minuto de ahora.
    const web = setup('cycle', { useGps: true });
    web.clock.advance(10 * 60_000);
    for (const fix of fixesBetween(0, 600)) web.rec.onGps(fix);
    expect(Math.max(...(web.rec.toRecord().splitsM ?? [0]))).toBeGreaterThan(3000);
  });

  it('con una pausa en medio, las posiciones de dentro de la pausa no suman aunque lleguen después de reanudar, y no se une lo de antes con lo de después', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    clock.advance(60_000);
    rec.pause(); // en pausa de T0+60 s a T0+120 s
    clock.advance(60_000);
    rec.resume();
    clock.advance(60_000); // T0 + 180 s
    // La persona siguió moviéndose durante la pausa (la bici no se para): todas llegan ahora, en orden.
    for (const fix of fixesBetween(0, 180)) rec.onGps(fix, { trustTime: true });
    const record = rec.toRecord();
    // 59 s + 59 s a 6 m/s: ni los 60 s de la pausa ni el salto entre antes y después cuentan.
    expect(record.distanceM).toBeGreaterThan(690);
    expect(record.distanceM).toBeLessThan(740);
    // El reloj de los minutos es el del tiempo activo: dos minutos, de ~354 m cada uno.
    expect(record.splitsM).toHaveLength(2);
    for (const meters of record.splitsM ?? []) {
      expect(meters).toBeGreaterThan(330);
      expect(meters).toBeLessThan(380);
    }
  });

  it('una posición de justo antes de pausar que llega ya en pausa se acepta (se coloca por su hora); las de dentro de la pausa, no', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    clock.advance(20_000);
    for (const fix of fixesBetween(0, 20)) rec.onGps(fix, { trustTime: true }); // entregadas en directo
    clock.advance(20_000);
    rec.pause(); // en pausa desde T0+40 s
    for (const fix of fixesBetween(20, 60)) rec.onGps(fix, { trustTime: true }); // llegan tarde: 20–39 antes de la pausa, 40–59 dentro
    const distance = rec.toRecord().distanceM ?? 0;
    expect(distance).toBeGreaterThan(225); // 39 s a 6 m/s
    expect(distance).toBeLessThan(245);
  });

  it('las posiciones de antes de empezar el entreno o de después de terminarlo no cuentan', () => {
    const { rec, clock } = setup('cycle', { useGps: true });
    clock.advance(60_000);
    for (const fix of fixesBetween(-30, 0)) rec.onGps(fix, { trustTime: true });
    expect(rec.snapshot().distanceM).toBeNull();
    for (const fix of fixesBetween(0, 60)) rec.onGps(fix, { trustTime: true });
    const record = rec.finish();
    const before = record.distanceM ?? 0;
    for (const fix of fixesBetween(60, 120)) rec.onGps(fix, { trustTime: true });
    expect(rec.toRecord().distanceM).toBe(before);
  });
});

describe('WorkoutRecorder: desnivel con el barómetro (solo al andar)', () => {
  /** Presión a `heightM` metros sobre una referencia de 1013,25 hPa. */
  const pressureAt = (heightM: number): number => 1013.25 * Math.pow(1 - heightM / 44_330, 5.255);

  /** Una caminata de `seconds` con una posición por segundo; la altura sube `climbM` metros entre los segundos 60 y `seconds`-60. */
  function climbWalk(sport: 'walk' | 'cycle', climbM: number, seconds = 600) {
    const { rec, clock } = setup(sport, { useGps: true });
    for (let s = 0; s < seconds; s++) {
      const h = climbM * Math.min(1, Math.max(0, (s - 60) / (seconds - 120)));
      clock.advance(1000);
      rec.onGps({ lat: lat(s * 1.4), lon: -3, accuracyM: 5, tsMs: T0 + (s + 1) * 1000, speedMs: 1.4, pressureHpa: pressureAt(h) });
    }
    return rec;
  }

  it('anota los metros subidos en el registro', () => {
    const record = climbWalk('walk', 40).toRecord();
    expect(record.ascentM).toBeGreaterThanOrEqual(36);
    expect(record.ascentM).toBeLessThanOrEqual(41);
  });

  it('con las calorías por velocidad, la subida las aumenta en el estimado en directo', () => {
    const hill = climbWalk('walk', 40).snapshot();
    const flat = climbWalk('walk', 0).snapshot();
    expect(hill.kcal).toBeGreaterThan(flat.kcal + 0.009 * 80 * 30);
  });

  it('un paseo llano no anota desnivel', () => {
    expect(climbWalk('walk', 0).toRecord().ascentM).toBeUndefined();
  });

  it('en bici no se mide', () => {
    expect(climbWalk('cycle', 40).toRecord().ascentM).toBeUndefined();
  });

  it('sin barómetro (la posición no trae presión) no hay desnivel', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    for (let s = 0; s < 300; s++) {
      clock.advance(1000);
      rec.onGps({ lat: lat(s * 1.4), lon: -3, accuracyM: 5, tsMs: T0 + (s + 1) * 1000, speedMs: 1.4 });
    }
    expect(rec.toRecord().ascentM).toBeUndefined();
  });

  it('lo que cambie la altura durante una pausa no cuenta como subida', () => {
    const { rec, clock } = setup('walk', { useGps: true });
    const feed = (from: number, to: number, h: number): void => {
      for (let s = from; s < to; s++) {
        clock.advance(1000);
        rec.onGps({ lat: lat(s * 1.4), lon: -3, accuracyM: 5, tsMs: T0 + (s + 1) * 1000, speedMs: 1.4, pressureHpa: pressureAt(h) });
      }
    };
    feed(0, 120, 0);
    rec.pause();
    clock.advance(10 * 60_000); // en la pausa se sube a un piso de 30 m
    rec.resume();
    feed(120, 240, 30);
    expect(rec.toRecord().ascentM).toBeUndefined();
  });
});
