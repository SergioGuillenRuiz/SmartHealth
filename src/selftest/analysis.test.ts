import { describe, expect, it } from 'vitest';
import { YCBT_SERVICE } from '../ble/constants';
import type { ScanEntry } from '../ble/transport';
import { analyzeHeartEvents, analyzeLiveSteps, analyzeStepsRun, androidVersion, describeDevice, fmtSeconds, foreignTraffic, gapStats, maskAddressIn, maskId, pickRing, plural, ringScore, toHeartEvent, type HeartEvent, type StepSample } from './analysis';

const entry = (over: Partial<ScanEntry> = {}): ScanEntry => ({ id: 'AA:BB:CC:DD:EE:01', name: null, rssi: -70, services: [], manufacturer: {}, raw: null, ...over });

describe('maskId', () => {
  it('abrevia las direcciones: en el informe no van MAC completas', () => {
    expect(maskId('AA:BB:CC:DD:EE:FF')).toBe('…EE:FF');
    expect(maskId('abc')).toBe('abc');
  });
});

describe('identificar el anillo entre lo que se ve', () => {
  it('el nombre «R99…» pesa más que el servicio, y este más que los datos de fabricante', () => {
    expect(ringScore(entry({ name: 'R99_F265' }))).toBeGreaterThan(ringScore(entry({ services: [YCBT_SERVICE] })));
    expect(ringScore(entry({ services: [YCBT_SERVICE] }))).toBeGreaterThan(ringScore(entry({ manufacturer: { '7810': '01' } })));
    expect(ringScore(entry({ name: 'Auriculares' }))).toBe(0);
    expect(ringScore(entry({ name: 'r99 f265' }))).toBeGreaterThan(0); // sin distinguir mayúsculas
    expect(ringScore(entry({ name: 'R9' }))).toBe(0);
  });

  it('reconoce el servicio en mayúsculas y elige el mejor candidato; con empate, la mejor señal', () => {
    const decoy = entry({ id: 'decoy', name: 'Auriculares', rssi: -30 });
    const weak = entry({ id: 'weak', services: [YCBT_SERVICE.toUpperCase()], rssi: -40 });
    const named = entry({ id: 'named', name: 'R99 F265', rssi: -85 });
    const namedNear = entry({ id: 'near', name: 'R99 F265', rssi: -50 });
    expect(pickRing([decoy, weak, named])?.id).toBe('named');
    expect(pickRing([named, namedNear])?.id).toBe('near');
    expect(pickRing([decoy])).toBeNull();
    expect(pickRing([])).toBeNull();
  });

  it('el informe lleva entero el anillo (sin su dirección) y de los demás solo lo justo', () => {
    const ring = entry({ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265', rssi: -55, manufacturer: { '7810': '01 02' }, raw: '02 01 06' });
    expect(describeDevice(ring, true)).toEqual({ id: '…EE:FF', name: 'R99 F265', rssi: -55, services: [], manufacturer: { '7810': '01 02' }, raw: '02 01 06' });
    expect(describeDevice(ring, false)).toEqual({ id: '…EE:FF', name: 'R99 F265', rssi: -55, services: [], companyIds: ['7810'] });
  });

  it('la dirección del anillo tampoco se cuela entera por los datos de fabricante ni por el anuncio en bruto', () => {
    const ring = entry({
      id: 'AA:BB:CC:DD:EE:FF',
      name: 'R99 F265',
      manufacturer: { '7810': '78 10 aa bb cc dd ee ff 01' },
      raw: '02 01 06 0b ff 10 78 ff ee dd cc bb aa 03 09 52',
    });
    const described = describeDevice(ring, true) as { manufacturer: Record<string, string>; raw: string };
    expect(described.manufacturer['7810']).toBe('78 10 xx xx xx xx ee ff 01'); // en orden directo
    expect(described.raw).toBe('02 01 06 0b ff 10 78 ff ee xx xx xx xx 03 09 52'); // en orden inverso
    expect(JSON.stringify(described)).not.toMatch(/aa bb cc dd ee ff|ff ee dd cc bb aa/i);
  });
});

describe('maskAddressIn', () => {
  it('tapa la dirección en los dos órdenes, deja a la vista los dos últimos bytes y no toca nada más', () => {
    const id = 'AA:BB:CC:DD:EE:FF';
    expect(maskAddressIn('aa bb cc dd ee ff', id)).toBe('xx xx xx xx ee ff');
    expect(maskAddressIn('ff ee dd cc bb aa', id)).toBe('ff ee xx xx xx xx');
    expect(maskAddressIn('01 02 03', id)).toBe('01 02 03');
    expect(maskAddressIn('aa bb cc dd ee ff 00 ff ee dd cc bb aa', id)).toBe('xx xx xx xx ee ff 00 ff ee xx xx xx xx'); // las dos a la vez
  });

  it('si el identificador no es una dirección (el anillo simulado, el navegador), no hay nada que tapar', () => {
    expect(maskAddressIn('aa bb cc', 'sim-r99-0001')).toBe('aa bb cc');
    expect(maskAddressIn('aa bb cc', 'AA:BB:CC')).toBe('aa bb cc');
    expect(maskAddressIn('aa bb cc', 'ZZ:BB:CC:DD:EE:FF')).toBe('aa bb cc');
  });
});

describe('gapStats', () => {
  it('mide cada cuánto llegan los datos', () => {
    expect(gapStats([0, 1000, 2000, 5000])).toEqual({ count: 3, minMs: 1000, medianMs: 1000, maxMs: 3000 });
    expect(gapStats([5000, 0, 1000, 2000])).toEqual({ count: 3, minMs: 1000, medianMs: 1000, maxMs: 3000 }); // desordenado
    expect(gapStats([0, 1000, 4000, 5000])).toEqual({ count: 3, minMs: 1000, medianMs: 1000, maxMs: 3000 });
    expect(gapStats([0, 2000, 3000])).toEqual({ count: 2, minMs: 1000, medianMs: 1500, maxMs: 2000 }); // mediana de dos
    expect(gapStats([42])).toEqual({ count: 0, minMs: null, medianMs: null, maxMs: null });
    expect(gapStats([])).toEqual({ count: 0, minMs: null, medianMs: null, maxMs: null });
  });
});

const sample = (t: number, steps: number): StepSample => ({ t, steps, distanceM: steps, calories: 0 });

describe('analyzeLiveSteps', () => {
  const walk = { startMs: 8000, endMs: 33_000 };

  it('con el contador quieto al principio, que sube al andar y se para al final', () => {
    const samples = [
      ...[1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000].map((t) => sample(t, 100)),
      sample(10_000, 105),
      sample(12_000, 110),
      sample(14_000, 115),
      sample(16_000, 120),
      sample(34_000, 120),
      sample(36_000, 120),
    ];
    const a = analyzeLiveSteps(samples, walk);
    expect(a).toMatchObject({
      updates: 14,
      changes: 4,
      delta: 20,
      changesAtRest: 0,
      changesWhileWalking: 4,
      firstChangeAfterWalkStartMs: 2000, // el primer cambio llega 2 s después de echar a andar
      lastChangeAfterWalkEndMs: -17_000, // y dejó de cambiar mucho antes del final
    });
    expect(a.first?.steps).toBe(100);
    expect(a.last?.steps).toBe(120);
    expect(a.gapsBetweenChanges).toEqual({ count: 3, minMs: 2000, medianMs: 2000, maxMs: 2000 });
  });

  it('distingue un contador que sube en reposo y uno que no cambia nunca', () => {
    const restless = analyzeLiveSteps([sample(1000, 5), sample(3000, 6), sample(9000, 7)], walk);
    expect(restless.changesAtRest).toBe(1);
    expect(restless.changesWhileWalking).toBe(1);

    const flat = analyzeLiveSteps([sample(1000, 5), sample(2000, 5), sample(9000, 5)], walk);
    expect(flat).toMatchObject({ updates: 3, changes: 0, delta: 0, firstChangeAfterWalkStartMs: null, lastChangeAfterWalkEndMs: null });
  });

  it('sin ninguna lectura no inventa nada', () => {
    expect(analyzeLiveSteps([], walk)).toMatchObject({ updates: 0, changes: 0, delta: null, first: null, last: null });
  });
});

describe('analyzeHeartEvents', () => {
  const events: HeartEvent[] = [
    { t: 1000, kind: 'heartRate', bpm: 0 },
    { t: 3000, kind: 'heartRate', bpm: 0 },
    { t: 5000, kind: 'heartRate', bpm: 250 }, // implausible
    { t: 27_000, kind: 'heartRate', bpm: 72 },
    { t: 28_000, kind: 'heartRate', bpm: 72 },
    { t: 30_000, kind: 'heartRate', bpm: 74 },
    { t: 35_000, kind: 'measurementEnd', mode: 0, success: true },
    { t: 35_500, kind: 'measurementEnd', mode: 0, success: false }, // un cierre repetido no cambia el veredicto
  ];

  it('resume cuándo llegó la primera lectura válida y cuándo cerró el anillo la medida', () => {
    expect(analyzeHeartEvents(events)).toEqual({
      readings: 6,
      nonZero: 4,
      firstNonZeroMs: 5000,
      firstPlausibleMs: 27_000,
      verdictMs: 35_000,
      verdictSuccess: true,
      distinctPlausible: 2,
      plateau: null,
      firstRealMs: 27_000,
    });
  });

  it('sin veredicto ni lecturas', () => {
    expect(analyzeHeartEvents([])).toEqual({ readings: 0, nonZero: 0, firstNonZeroMs: null, firstPlausibleMs: null, verdictMs: null, verdictSuccess: null, distinctPlausible: 0, plateau: null, firstRealMs: null });
  });

  it('reconoce la meseta del sensor en frío (46-47 lpm y de golpe 86, medida real del R99) y cuenta como primera lectura real la que viene después', () => {
    const real = [[23_720, 46], [24_719, 46], [25_716, 47], [26_760, 47], [27_798, 86], [28_800, 86], [29_796, 86], [32_835, 87]] as const;
    const analysis = analyzeHeartEvents(real.map(([t, bpm]) => ({ t, kind: 'heartRate' as const, bpm })));
    expect(analysis.firstPlausibleMs).toBe(23_720);
    expect(analysis.plateau).toEqual({ bpm: 47, count: 4, untilMs: 26_760 });
    expect(analysis.firstRealMs).toBe(27_798);
  });

  it('un pulso que sube de verdad (76 → 75 → 73 → 74, o 100 → 106) no es una meseta', () => {
    const rising = [[14_478, 76], [15_476, 76], [16_517, 76], [20_503, 75], [21_502, 73], [25_553, 74]] as const;
    expect(analyzeHeartEvents(rising.map(([t, bpm]) => ({ t, kind: 'heartRate' as const, bpm }))).plateau).toBeNull();
    const walking = [[7_000, 100], [8_000, 100], [9_000, 100], [20_000, 106]] as const;
    expect(analyzeHeartEvents(walking.map(([t, bpm]) => ({ t, kind: 'heartRate' as const, bpm }))).plateau).toBeNull();
  });

  it('traduce los avisos del anillo a eventos compactos', () => {
    expect(toHeartEvent({ kind: 'heartRate', bpm: 70 }, 5)).toEqual({ t: 5, kind: 'heartRate', bpm: 70 });
    expect(toHeartEvent({ kind: 'spo2', percent: 97 }, 6)).toEqual({ t: 6, kind: 'spo2', percent: 97 });
    expect(toHeartEvent({ kind: 'measurementEnd', mode: 0, success: true }, 7)).toEqual({ t: 7, kind: 'measurementEnd', mode: 0, success: true });
    expect(toHeartEvent({ kind: 'battery', percent: 80, charging: false }, 8)).toEqual({ t: 8, kind: 'battery', percent: 80, charging: false });
    expect(toHeartEvent({ kind: 'status', status: { steps: 12, distanceM: 9, calories: 1 } }, 9)).toEqual({ t: 9, kind: 'status', steps: 12 });
  });
});

describe('fmtSeconds', () => {
  it('muestra decimales por debajo de 10 s y después segundos o minutos', () => {
    expect(fmtSeconds(400)).toBe('0,4 s');
    expect(fmtSeconds(9_949)).toBe('9,9 s');
    expect(fmtSeconds(-5)).toBe('0,0 s');
    expect(fmtSeconds(10_000)).toBe('10 s');
    expect(fmtSeconds(42_400)).toBe('42 s');
    expect(fmtSeconds(65_000)).toBe('1 min 05 s');
  });
});

describe('textos del resumen', () => {
  it('plurales y versión de Android', () => {
    expect(plural(1, 'envío', 'envíos')).toBe('1 envío');
    expect(plural(0, 'envío', 'envíos')).toBe('0 envíos');
    expect(plural(14, 'envío', 'envíos')).toBe('14 envíos');
    expect(androidVersion('14')).toBe('14');
    expect(androidVersion('Android 14')).toBe('14');
    expect(androidVersion(undefined)).toBe('?');
  });
});

describe('analyzeStepsRun (contador al empezar, marcha y relectura al terminar)', () => {
  const sample = (t: number, steps: number): StepSample => ({ t, steps, distanceM: 0, calories: 0 });
  const walk = { startMs: 4_000, endMs: 34_000 };

  it('el anillo avisa mientras se anda: cuenta lo que subió y lo marca como «avisado»', () => {
    // Como en el entreno real: un envío al activar y luego solo cuando cambia, con los primeros pasos validados de golpe.
    const run = analyzeStepsRun([sample(2800, 0), sample(15_000, 11), sample(17_000, 15), sample(19_000, 18), sample(40_000, 18)], 4, walk);
    expect(run.baseline?.steps).toBe(0);
    expect(run.streamLast?.steps).toBe(18);
    expect(run.streamCounted).toBe(18);
    expect(run.rereadCounted).toBe(18);
    expect(run.counted).toBe(18);
    expect(run.pushed).toBe(true);
  });

  it('el anillo cuenta pero no avisa: solo la relectura revela los pasos', () => {
    const run = analyzeStepsRun([sample(2800, 0), sample(40_000, 37)], 1, walk);
    expect(run.pushed).toBe(false);
    expect(run.streamCounted).toBe(0);
    expect(run.rereadCounted).toBe(37);
    expect(run.counted).toBe(37);
  });

  it('el anillo no cuenta: ni el flujo ni la relectura cambian', () => {
    const run = analyzeStepsRun([sample(2800, 0), sample(40_000, 0)], 1, walk);
    expect(run.counted).toBe(0);
    expect(run.pushed).toBe(false);
    expect(run.reread?.steps).toBe(0);
  });

  it('sin relectura (se saltó el paso o cayó el enlace) se juzga con lo que avisó el anillo', () => {
    const run = analyzeStepsRun([sample(2800, 0), sample(15_000, 11)], 2, walk);
    expect(run.reread).toBeNull();
    expect(run.rereadCounted).toBeNull();
    expect(run.counted).toBe(11);
  });

  it('sin ningún envío al empezar no hay contador de partida (y un contador que baja no cuenta como negativo)', () => {
    expect(analyzeStepsRun([], 0, walk)).toMatchObject({ baseline: null, counted: 0, pushed: false });
    expect(analyzeStepsRun([sample(2800, 50), sample(40_000, 10)], 1, walk).counted).toBe(0);
  });
});

describe('foreignTraffic (otra app hablando con el anillo)', () => {
  const line = (ms: number, key: string): string => `   ${ms} ms info   respuesta sin petición pendiente: ${key}`;

  it('reconoce el apretón de manos de otra app: poner en hora y consultas de información', () => {
    // Lo que se vio en el entreno real a los 43 s, mientras Smart Health seguía viva en segundo plano.
    const trace = ['   42956 ms rx   06 00 0c 00 34 00 22 00 03 00 69 25', line(43041, '1:0'), line(43157, '2:1'), line(43271, '2:27'), line(43398, '2:0')].join('\n');
    expect(foreignTraffic(trace)).toEqual({ count: 4, firstMs: 43_041, keys: ['1:0', '2:1', '2:27', '2:0'] });
  });

  it('no confunde con tráfico ajeno la confirmación de una orden de medida ni las tramas normales', () => {
    expect(foreignTraffic([line(38_990, '3:47'), '   100 ms rx   01 00 07 00 00 cd 3e', '   101 ms info   nombre almacenado: R11M'].join('\n'))).toBeNull();
    expect(foreignTraffic('')).toBeNull();
  });
});
