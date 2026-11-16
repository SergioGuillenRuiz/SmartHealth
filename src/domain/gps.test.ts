import { describe, expect, it } from 'vitest';
import { GpsTracker, haversineM, type GpsFix } from './gps';

// 1° de latitud ≈ 111,195 km.
const lat = (meters: number): number => 40 + meters / 111_195;

describe('haversineM', () => {
  it('1 grado de latitud ≈ 111,2 km y la distancia es simétrica', () => {
    const a = { lat: 40, lon: -3 };
    const b = { lat: 41, lon: -3 };
    expect(haversineM(a, b)).toBeGreaterThan(111_000);
    expect(haversineM(a, b)).toBeLessThan(111_400);
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
    expect(haversineM(a, a)).toBe(0);
  });

  it('1 grado de longitud a 40° N ≈ 85 km', () => {
    const d = haversineM({ lat: 40, lon: -3 }, { lat: 40, lon: -2 });
    expect(d).toBeGreaterThan(84_000);
    expect(d).toBeLessThan(86_000);
  });
});

describe('GpsTracker', () => {
  const fix = (meters: number, tsSec: number, accuracyM = 6) => ({ lat: lat(meters), lon: -3, accuracyM, tsMs: tsSec * 1000 });

  it('suma un recorrido en línea recta', () => {
    const g = new GpsTracker();
    for (let i = 0; i <= 10; i++) g.add(fix(i * 20, i * 5)); // 20 m cada 5 s = 4 m/s
    expect(g.distanceM).toBeGreaterThan(195);
    expect(g.distanceM).toBeLessThan(205);
  });

  it('descarta lecturas imprecisas', () => {
    const g = new GpsTracker();
    g.add(fix(0, 0));
    expect(g.add(fix(500, 5, 80))).toBe(false);
    expect(g.rejected).toBe(1);
    expect(g.distanceM).toBe(0);
  });

  it('descarta saltos imposibles (teletransporte del GPS)', () => {
    const g = new GpsTracker();
    g.add(fix(0, 0));
    g.add(fix(15, 5));
    expect(g.add(fix(3000, 10))).toBe(false); // 600 m/s
    g.add(fix(30, 15));
    expect(g.distanceM).toBeLessThan(40);
  });

  it('el temblor en reposo no infla la distancia', () => {
    const g = new GpsTracker();
    // Parado, con jitter de ±3 m durante 10 minutos.
    for (let i = 0; i < 120; i++) g.add(fix((i % 2 === 0 ? 1 : -2) + 0, i * 5, 8));
    expect(g.distanceM).toBeLessThan(10);
  });

  it('calidad de señal: ninguna sin datos recientes, buena con buena precisión', () => {
    const g = new GpsTracker();
    expect(g.quality(0)).toBe('none');
    g.add(fix(0, 100, 8));
    expect(g.quality(105_000)).toBe('good');
    expect(g.quality(130_000)).toBe('none');
    const poor = new GpsTracker();
    poor.add(fix(0, 100, 25));
    expect(poor.quality(105_000)).toBe('poor');
  });
});

// ───────────────────────────── con la velocidad que mide el GPS ─────────────────────────────

/** Ruido reproducible: el mismo recorrido y el mismo temblor en cada ejecución. */
function noise(seed: number): () => number {
  let a = seed;
  const uniform = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

interface Walk {
  /** Metros por segundo del recorrido real. */
  speed: number;
  seconds: number;
  /** Desviación (m) del error de posición, que se arrastra de un segundo al siguiente como en un GPS real. */
  sigmaM: number;
  /** Segundos parado cada cierto tiempo (semáforos): [cada, duración]. */
  stops?: [number, number];
  /** Con `false` el dispositivo no da velocidad. */
  doppler?: boolean;
}

/** Recorrido con giros cada 120 m: el GPS lo ve con ruido y, si da velocidad, con la velocidad real. */
function simulate({ speed, seconds, sigmaM, stops, doppler = true }: Walk, seed: number): { fixes: GpsFix[]; truthM: number } {
  const gauss = noise(seed);
  const lat0 = 40.4168;
  const lon0 = -3.7038;
  const mPerDegLon = 111_195 * Math.cos((lat0 * Math.PI) / 180);
  let x = 0;
  let y = 0;
  let heading = 0;
  let ex = 0;
  let ey = 0;
  let truthM = 0;
  let sinceTurn = 0;
  let sinceStop = 0;
  let stopLeft = 0;
  const fixes: GpsFix[] = [];
  for (let t = 0; t < seconds; t++) {
    let v = speed;
    if (stops) {
      if (stopLeft > 0) {
        v = 0;
        stopLeft--;
      } else if (++sinceStop >= stops[0]) {
        stopLeft = stops[1];
        sinceStop = 0;
      }
    }
    x += Math.sin(heading) * v;
    y += Math.cos(heading) * v;
    truthM += v;
    sinceTurn += v;
    if (sinceTurn >= 120) {
      heading += Math.PI / 2;
      sinceTurn = 0;
    }
    ex = 0.95 * ex + Math.sqrt(1 - 0.95 ** 2) * gauss() * (sigmaM / Math.SQRT2);
    ey = 0.95 * ey + Math.sqrt(1 - 0.95 ** 2) * gauss() * (sigmaM / Math.SQRT2);
    fixes.push({
      lat: lat0 + (y + ey) / 111_195,
      lon: lon0 + (x + ex) / mPerDegLon,
      accuracyM: Math.max(3, sigmaM),
      tsMs: t * 1000,
      speedMs: doppler ? Math.max(0, v + gauss() * 0.15) : null,
    });
  }
  return { fixes, truthM };
}

const trackOf = (fixes: GpsFix[]): number => {
  const g = new GpsTracker();
  for (const f of fixes) g.add(f);
  return g.distanceM;
};

describe('GpsTracker con la velocidad que mide el GPS', () => {
  it('un paseo con el GPS muy flojo de ciudad mide la distancia real (con las posiciones salía hasta un 40 % más)', () => {
    const { fixes, truthM } = simulate({ speed: 1.4, seconds: 1800, sigmaM: 10 }, 7);
    expect(Math.abs(trackOf(fixes) - truthM) / truthM).toBeLessThan(0.015);
    // Sin velocidad, solo con posiciones, ya no se pasa de largo (la puerta de desplazamiento crece con la imprecisión de la lectura);
    // la velocidad sigue siendo lo más fino, pero el que no la da tampoco sale con un 30 % de más.
    const sinVelocidad = simulate({ speed: 1.4, seconds: 1800, sigmaM: 10, doppler: false }, 7);
    expect(Math.abs(trackOf(sinVelocidad.fixes) - sinVelocidad.truthM) / sinVelocidad.truthM).toBeLessThan(0.05);
  });

  it('sin velocidad del GPS, el ruido de las posiciones no infla andar, correr ni la bici (σ de 4, 8 y 15 m)', () => {
    const cases = [
      { speed: 1.3, sigmaM: 4, limit: 0.04 },
      { speed: 1.3, sigmaM: 8, limit: 0.06 },
      { speed: 1.3, sigmaM: 15, limit: 0.1 },
      { speed: 3, sigmaM: 8, limit: 0.04 },
      { speed: 3, sigmaM: 15, limit: 0.06 },
      { speed: 6, sigmaM: 8, limit: 0.05 }, // con giros de 90° cada 120 m (una cuadrícula de calles), la cuerda corta las esquinas
      { speed: 6, sigmaM: 15, limit: 0.08 },
    ];
    for (const c of cases) {
      let total = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const { fixes, truthM } = simulate({ speed: c.speed, seconds: 1800, sigmaM: c.sigmaM, doppler: false }, seed);
        total += (trackOf(fixes) - truthM) / truthM;
      }
      expect(Math.abs(total / 8), `v=${c.speed} σ=${c.sigmaM}`).toBeLessThan(c.limit);
    }
  });

  it('parado diez minutos sin velocidad del GPS y con el GPS vagando tampoco recorre nada que importe', () => {
    for (let seed = 1; seed <= 30; seed++) expect(trackOf(simulate({ speed: 0, seconds: 600, sigmaM: 8, doppler: false }, seed).fixes), `semilla ${seed}`).toBeLessThan(80);
  });

  it('una bajada rápida en bici (58, 65 y 80 km/h) se mide con la velocidad máxima de la bici: no se queda sin contar', () => {
    for (const speed of [16, 18, 22]) {
      const { fixes, truthM } = simulate({ speed, seconds: 600, sigmaM: 6 }, 2);
      const g = new GpsTracker({ maxSpeedMs: 30 });
      for (const f of fixes) g.add(f);
      expect(Math.abs(g.distanceM - truthM) / truthM, `${speed} m/s`).toBeLessThan(0.02);
    }
  });

  it('con la velocidad máxima de un paseo, un salto de posición de 80 m se rechaza aunque venga con buena precisión', () => {
    const g = new GpsTracker({ maxSpeedMs: 6 });
    for (let i = 0; i <= 20; i++) g.add({ lat: lat(i * 1.3), lon: -3, accuracyM: 8, tsMs: i * 1000, speedMs: null });
    const before = g.distanceM;
    expect(g.add({ lat: lat(26 + 80), lon: -3, accuracyM: 8, tsMs: 21_000, speedMs: null })).toBe(false);
    expect(g.distanceM).toBe(before);
    expect(g.rejected).toBe(1);
  });

  it('un pico suelto en la velocidad del GPS (un glitch del chip) no suma metros que no se anduvieron', () => {
    const g = new GpsTracker();
    for (let i = 0; i <= 120; i++) {
      // 1,3 m/s siempre, con un 8 m/s de golpe cada 10 s.
      g.add({ lat: lat(i * 1.3), lon: -3, accuracyM: 5, tsMs: i * 1000, speedMs: i % 10 === 5 ? 8 : 1.3 });
    }
    expect(Math.abs(g.distanceM - 120 * 1.3) / (120 * 1.3)).toBeLessThan(0.02);
    expect(g.rejected).toBeGreaterThanOrEqual(10);
  });

  it('una lectura con la hora adelantada una hora no deja el GPS muerto hasta que el reloj la alcance (se empieza un tramo nuevo)', () => {
    const { fixes, truthM } = simulate({ speed: 6, seconds: 1200, sigmaM: 5 }, 4);
    const skewed = fixes.map((f, i) => (i === 300 ? { ...f, tsMs: f.tsMs + 3_600_000 } : f));
    const g = new GpsTracker({ maxSpeedMs: 30 });
    for (const f of skewed) g.add(f);
    expect(Math.abs(g.distanceM - truthM) / truthM).toBeLessThan(0.02);
  });

  it('un cambio de la base de tiempo (30 s atrás) tampoco: no se pierden ni 30 s de recorrido', () => {
    const { fixes, truthM } = simulate({ speed: 6, seconds: 1200, sigmaM: 5 }, 5);
    const shifted = fixes.map((f, i) => (i >= 400 ? { ...f, tsMs: f.tsMs - 30_000 } : f));
    const g = new GpsTracker({ maxSpeedMs: 30 });
    for (const f of shifted) g.add(f);
    expect(Math.abs(g.distanceM - truthM) / truthM).toBeLessThan(0.03);
  });

  it('arranque en frío: una lectura de red (25 m, desviada 40 m, sin velocidad) seguida del GPS fijado no suma la corrección como recorrido', () => {
    const g = new GpsTracker();
    g.add({ lat: lat(40), lon: -3, accuracyM: 25, tsMs: 0, speedMs: null });
    for (let i = 1; i <= 600; i++) g.add({ lat: lat(i * 1.3), lon: -3, accuracyM: 5, tsMs: i * 1000, speedMs: 1.3 });
    expect(g.distanceM).toBeGreaterThan(599 * 1.3 - 5);
    expect(g.distanceM).toBeLessThan(600 * 1.3 + 5);
    // Sin velocidad tampoco.
    const noSpeed = new GpsTracker();
    noSpeed.add({ lat: lat(40), lon: -3, accuracyM: 25, tsMs: 0, speedMs: null });
    for (let i = 1; i <= 600; i++) noSpeed.add({ lat: lat(i * 1.3), lon: -3, accuracyM: 5, tsMs: i * 1000, speedMs: null });
    expect(Math.abs(noSpeed.distanceM - 600 * 1.3)).toBeLessThan(25);
  });

  it('arranque en frío: el error que se va corrigiendo (de 30 a 5 m en 20 s) mientras se está quieto no se cuenta como andar', () => {
    const g = new GpsTracker();
    // Quieto en el punto 0, con una lectura que empieza desviada 28 m y converge al punto real a medida que mejora la precisión.
    const accuracies = [30, 26, 22, 18, 15, 12, 10, 8, 7, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    accuracies.forEach((accuracyM, i) => g.add({ lat: lat(accuracyM * 0.9), lon: -3, accuracyM, tsMs: i * 1000, speedMs: null }));
    expect(g.distanceM).toBeLessThan(8);
  });

  it('andar despacio (0,8 y 0,9 m/s) con el ruido normal de la velocidad no se recorta: el umbral de «parado» se aplica al intervalo, no a cada extremo', () => {
    for (const [speed, limit] of [
      [0.8, 0.08],
      [0.9, 0.05],
    ] as const) {
      let total = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const { fixes, truthM } = simulate({ speed, seconds: 1800, sigmaM: 8 }, seed);
        total += (trackOf(fixes) - truthM) / truthM;
      }
      expect(Math.abs(total / 6), `v=${speed}`).toBeLessThan(limit);
    }
  });

  it('con la aceleración máxima de un paseo (2 m/s²), un pico de velocidad de 4–5 m/s al andar se descarta; la de la bici lo dejaba pasar', () => {
    const walk = (options: ConstructorParameters<typeof GpsTracker>[0]): number => {
      const g = new GpsTracker(options);
      for (let i = 0; i <= 600; i++) g.add({ lat: lat(i * 1.3), lon: -3, accuracyM: 5, tsMs: i * 1000, speedMs: i % 25 === 7 ? 5.4 : 1.3 });
      return g.distanceM;
    };
    const truth = 600 * 1.3;
    expect(Math.abs(walk({ maxSpeedMs: 6, maxAccelerationMs2: 2 }) - truth) / truth).toBeLessThan(0.01);
    expect(walk({ maxSpeedMs: 30 }) / truth).toBeGreaterThan(1.02); // con la de la bici (5 m/s² + 1) esos picos suman
  });

  it('un frenazo en bici (de 10 m/s a parado en 1,5 s) no se toma por un glitch: la lectura siguiente se acepta', () => {
    const g = new GpsTracker({ maxSpeedMs: 30 });
    g.add({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: 0, speedMs: 10 });
    g.add({ lat: lat(10), lon: -3, accuracyM: 4, tsMs: 1000, speedMs: 10 });
    g.add({ lat: lat(17), lon: -3, accuracyM: 4, tsMs: 2000, speedMs: 0 }); // 10 → 0 en un segundo: se descarta como glitch…
    g.add({ lat: lat(18), lon: -3, accuracyM: 4, tsMs: 3000, speedMs: 0 }); // …pero a los 2 s de la última buena ya es creíble
    expect(g.distanceM).toBeGreaterThan(14);
    expect(g.distanceM).toBeLessThan(21);
  });

  it('correr y la bici también, con curvas y paradas en semáforos', () => {
    for (const walk of [
      { speed: 3, seconds: 1800, sigmaM: 5 },
      { speed: 5.5, seconds: 1800, sigmaM: 8, stops: [60, 25] as [number, number] },
    ]) {
      for (const seed of [1, 2, 3]) {
        const { fixes, truthM } = simulate(walk, seed);
        expect(Math.abs(trackOf(fixes) - truthM) / truthM, `v=${walk.speed} seed=${seed}`).toBeLessThan(0.02);
      }
    }
  });

  it('un paseo de ciudad con paradas largas (semáforos de 90 s cada 4 min) y el GPS flojo mide bien: la velocidad no se da por atascada', () => {
    // Con el modelo de ruido de ciudad (σ = 10 m) las posiciones de alguien parado vagan decenas de metros: no es «andar».
    for (let seed = 1; seed <= 40; seed++) {
      const { fixes, truthM } = simulate({ speed: 1.4, seconds: 3600, sigmaM: 10, stops: [240, 90] }, seed);
      expect(Math.abs(trackOf(fixes) - truthM) / truthM, `semilla ${seed}`).toBeLessThan(0.03);
    }
  });

  it('parado 10 minutos con el GPS vagando (σ = 10 m) tampoco recorre nada, en ninguna de las semillas', () => {
    for (let seed = 1; seed <= 60; seed++) expect(trackOf(simulate({ speed: 0, seconds: 600, sigmaM: 10 }, seed).fixes), `semilla ${seed}`).toBeLessThan(25);
  });

  it('parado con un ruido de velocidad de 0,6 m/s (por debajo de lo que es andar) no suma distancia fantasma', () => {
    const g = new GpsTracker();
    for (let i = 0; i < 600; i++) g.add({ lat: lat(0), lon: -3, accuracyM: 6, tsMs: i * 1000, speedMs: 0.6 });
    expect(g.distanceM).toBeLessThan(10);
  });

  it('una persona quieta cuya posición deriva 36 m en 30 s no hace que la velocidad se dé por mala para el resto del entreno', () => {
    const g = new GpsTracker();
    for (let i = 0; i <= 30; i++) g.add({ lat: lat(i * 1.2), lon: -3, accuracyM: 8, tsMs: i * 1000, speedMs: 0 });
    expect(g.distanceM).toBeLessThan(5);
    // Después echa a andar de verdad (1,4 m/s con la velocidad bien): se sigue midiendo con la velocidad.
    for (let i = 1; i <= 120; i++) g.add({ lat: lat(36 + i * 1.4), lon: -3, accuracyM: 8, tsMs: (30 + i) * 1000, speedMs: 1.4 });
    expect(g.distanceM).toBeGreaterThan(160);
    expect(g.distanceM).toBeLessThan(176);
  });

  it('parado con el GPS temblando no recorre nada (con las posiciones, más de 300 m en 10 minutos)', () => {
    const { fixes } = simulate({ speed: 0, seconds: 600, sigmaM: 6 }, 3);
    expect(trackOf(fixes)).toBeLessThan(15);
  });

  it('si algunas lecturas no traen velocidad, esas se miden con las posiciones y el resto con la velocidad', () => {
    const { fixes, truthM } = simulate({ speed: 5, seconds: 600, sigmaM: 3 }, 5);
    const mixed = fixes.map((f, i) => (i >= 200 && i < 260 ? { ...f, speedMs: null } : f));
    const measured = trackOf(mixed);
    expect(measured).toBeGreaterThan(truthM * 0.93);
    expect(measured).toBeLessThan(truthM * 1.07);
  });

  it('una velocidad imposible no se integra: se mide con las posiciones', () => {
    const g = new GpsTracker();
    // 5 m/s reales (posiciones cada 5 s a 25 m) pero el dispositivo da 80 m/s: no es una velocidad creíble.
    for (let i = 0; i <= 10; i++) g.add({ lat: lat(i * 25), lon: -3, accuracyM: 4, tsMs: i * 5000, speedMs: 80 });
    expect(g.distanceM).toBeGreaterThan(240);
    expect(g.distanceM).toBeLessThan(260);
  });

  it('entre dos lecturas separadas por más de 10 s no se integra la velocidad: no se sabe qué pasó en medio', () => {
    const g = new GpsTracker();
    g.add({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: 0, speedMs: 10 });
    // 30 s después: la velocidad dice 10 m/s (300 m), las posiciones solo avanzaron 60 m.
    g.add({ lat: lat(60), lon: -3, accuracyM: 4, tsMs: 30_000, speedMs: 10 });
    expect(g.distanceM).toBeLessThan(70);
  });

  it('un dispositivo cuya velocidad es siempre 0 aunque se avance se detecta y se pasa a las posiciones', () => {
    const g = new GpsTracker();
    // 4 m/s durante 3 minutos con la velocidad clavada en 0.
    for (let i = 0; i <= 180; i++) g.add({ lat: lat(i * 4), lon: -3, accuracyM: 4, tsMs: i * 1000, speedMs: 0 });
    expect(g.distanceM).toBeGreaterThan(640);
    expect(g.distanceM).toBeLessThan(760);
  });

  it('tras cortar el tramo (una pausa) la siguiente lectura no se une con la anterior', () => {
    const g = new GpsTracker();
    g.add({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: 0, speedMs: 5 });
    g.add({ lat: lat(5), lon: -3, accuracyM: 4, tsMs: 1000, speedMs: 5 });
    g.breakSegment();
    g.add({ lat: lat(3000), lon: -3, accuracyM: 4, tsMs: 600_000, speedMs: 5 });
    g.add({ lat: lat(3005), lon: -3, accuracyM: 4, tsMs: 601_000, speedMs: 5 });
    expect(g.distanceM).toBeCloseTo(10, 0);
  });

  it('las lecturas imprecisas siguen descartándose, también con velocidad', () => {
    const g = new GpsTracker();
    g.add({ lat: lat(0), lon: -3, accuracyM: 4, tsMs: 0, speedMs: 5 });
    expect(g.add({ lat: lat(5), lon: -3, accuracyM: 80, tsMs: 1000, speedMs: 5 })).toBe(false);
    expect(g.distanceM).toBe(0);
  });

  it('tras un hueco largo (la app oculta) la cuerda se suma aunque la lectura al volver sea mucho más precisa: no se tira un tramo del recorrido', () => {
    // Bici en línea recta a 6 m/s durante 25 min, oculta del minuto 10 al 15; 10 m de precisión antes y 4 m al volver.
    const g = new GpsTracker({ maxSpeedMs: 30 });
    for (let t = 0; t < 1500; t++) {
      if (t >= 600 && t < 900) continue;
      g.add({ lat: lat(t * 6), lon: -3, accuracyM: t < 600 ? 10 : 4, tsMs: t * 1000, speedMs: 6 });
    }
    expect(Math.abs(g.distanceM - 1499 * 6) / (1499 * 6)).toBeLessThan(0.01);
  });

  it('sin velocidad y con la precisión cambiando por tramos (16 y 4 m), mejorar la precisión no tira lo andado desde el último punto', () => {
    // Renovar el punto de referencia cada vez que la precisión mejora al doble recortaba entre un 4 y un 16 % según el tamaño de los tramos.
    let total = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { fixes, truthM } = simulate({ speed: 1.3, seconds: 3600, sigmaM: 6, doppler: false }, seed);
      const blocky = fixes.map((f, i) => ({ ...f, accuracyM: Math.floor(i / 90) % 2 === 0 ? 16 : 4 }));
      total += (trackOf(blocky) - truthM) / truthM;
    }
    expect(Math.abs(total / 6)).toBeLessThan(0.05);
  });

  it('una lectura vieja que llega tarde (la posición y la hora de hace un minuto) se descarta y no se suma dos veces', () => {
    const at = (t: number): GpsFix => ({ lat: lat(t * 1.3), lon: -3, accuracyM: 5, tsMs: t * 1000, speedMs: 1.3 });
    const g = new GpsTracker();
    for (let t = 0; t <= 600; t++) g.add(at(t));
    expect(g.add(at(540))).toBe(false);
    for (let t = 601; t <= 1200; t++) g.add(at(t));
    expect(Math.abs(g.distanceM - 1200 * 1.3) / (1200 * 1.3)).toBeLessThan(0.005);
  });

  it('dos lecturas viejas seguidas, sin embargo, ya no pasan por una: la hora nueva se da por buena y se empieza otro tramo', () => {
    const g = new GpsTracker();
    g.add({ lat: lat(0), lon: -3, accuracyM: 5, tsMs: 100_000, speedMs: 1.3 });
    g.add({ lat: lat(1.3), lon: -3, accuracyM: 5, tsMs: 101_000, speedMs: 1.3 });
    // La base de tiempo cambia (el GPS pasa a dar su propia hora, 5 min atrás): la primera lectura queda a la espera…
    expect(g.add({ lat: lat(2.6), lon: -3, accuracyM: 5, tsMs: -200_000, speedMs: 1.3 })).toBe(false);
    // …y la segunda, que llega después de ella, la confirma: empieza un tramo nuevo y se vuelve a medir.
    expect(g.add({ lat: lat(3.9), lon: -3, accuracyM: 5, tsMs: -199_000, speedMs: 1.3 })).toBe(true);
    g.add({ lat: lat(5.2), lon: -3, accuracyM: 5, tsMs: -198_000, speedMs: 1.3 });
    expect(g.distanceM).toBeCloseTo(1.3 + 1.3, 0);
  });
});
