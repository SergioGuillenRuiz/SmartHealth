import { describe, expect, it } from 'vitest';
import { BackupError, parseBackup, requireCompleteBackup, type ParsedBackup } from './backup';

const at = (h: number): number => new Date(2026, 6, 9, h, 0, 0).getTime();

const valid = () => ({
  format: 'smartring-backup',
  version: 1,
  exportedAt: '2026-07-10T10:00:00.000Z',
  data: {
    profile: [{ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' }],
    settings: { stepGoal: 9000, sleepGoalH: 7.5, heartIntervalMin: 60, spo2IntervalMin: 60, lastBackupMs: null },
    workouts: [{ id: 'w', sport: 'run', startMs: at(7), endMs: at(8), pausedMs: 0, source: 'live', steps: 5000, distanceM: 8000, hr: [[at(7), 120]] }],
    buckets: [{ startMs: at(8), endMs: at(9), steps: 1200, ringDistanceM: 0, ringCalories: 0 }],
    counters: [{ tsMs: at(20), steps: 7000 }],
    heart: [{ tsMs: at(10), bpm: 64, source: 'ring-auto' }],
    spo2: [{ tsMs: at(10), percent: 97 }],
    sleep: [{ startMs: at(1), endMs: at(7), segments: [{ stage: 'deep', startMs: at(1), durationSec: 3600 }] }],
    syncs: [],
  },
});

/** Aplica un cambio a una copia válida y devuelve el error que provoca (o null si se acepta). */
function reject(change: (data: ReturnType<typeof valid>['data']) => void): string | null {
  const file = valid();
  change(file.data);
  try {
    parseBackup(file);
    return null;
  } catch (error) {
    if (error instanceof BackupError) return error.message;
    throw error;
  }
}

describe('parseBackup: una copia válida se acepta tal cual', () => {
  it('con todos sus apartados', () => {
    const parsed = parseBackup(valid());
    expect(parsed.sections).toEqual(['profile', 'workouts', 'buckets', 'counters', 'heart', 'spo2', 'sleep']);
    expect(parsed.hasSettings).toBe(true);
    expect(parsed.settings.stepGoal).toBe(9000);
  });
});

describe('parseBackup: datos imposibles se rechazan antes de escribir nada', () => {
  it.each([
    ['una altura de −50 cm', (d: ReturnType<typeof valid>['data']) => void (d.profile[0]!.heightCm = -50), /perfil/],
    ['un peso de 0 kg', (d: ReturnType<typeof valid>['data']) => void (d.profile[0]!.weightKg = 0), /perfil/],
    ['un contador de 10⁹ pasos', (d: ReturnType<typeof valid>['data']) => void (d.counters[0]!.steps = 1e9), /contador/],
    ['un tramo con pasos negativos', (d: ReturnType<typeof valid>['data']) => void (d.buckets[0]!.steps = -5), /actividad/],
    ['un tramo que acaba antes de empezar', (d: ReturnType<typeof valid>['data']) => void (d.buckets[0]!.endMs = at(7)), /actividad/],
    ['un pulso de 0 lpm', (d: ReturnType<typeof valid>['data']) => void (d.heart[0]!.bpm = 0), /cardiaca/],
    ['una fuente de pulso desconocida', (d: ReturnType<typeof valid>['data']) => void ((d.heart[0] as { source: string }).source = 'otra'), /cardiaca/],
    ['un oxígeno de 300 %', (d: ReturnType<typeof valid>['data']) => void (d.spo2[0]!.percent = 300), /oxígeno/],
    ['un entreno con pulso que no es una lista', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as { hr: unknown }).hr = 'texto'), /entrenamientos/],
    ['un entreno que acaba antes de empezar', (d: ReturnType<typeof valid>['data']) => void (d.workouts[0]!.endMs = at(6)), /entrenamientos/],
    ['una sesión de sueño con una fase desconocida', (d: ReturnType<typeof valid>['data']) => void ((d.sleep[0]!.segments[0] as { stage: string }).stage = 'rara'), /sueño/],
    ['un objetivo de pasos de 0', (d: ReturnType<typeof valid>['data']) => void (d.settings.stepGoal = 0), /objetivo de pasos/],
    ['un intervalo de medición de 1 minuto (gastaría la batería del anillo)', (d: ReturnType<typeof valid>['data']) => void (d.settings.heartIntervalMin = 1), /intervalo de pulso/],
    ['un objetivo de sueño de 0 h', (d: ReturnType<typeof valid>['data']) => void (d.settings.sleepGoalH = 0), /objetivo de sueño/],
  ])('%s', (_name, change, expected) => {
    expect(reject(change)).toMatch(expected);
  });
});

describe('parseBackup: una copia estropeada o hostil no puede dejar la app sin arrancar ni tumbarla', () => {
  it.each([
    ['un entreno con un id de 5 MB', (d: ReturnType<typeof valid>['data']) => void (d.workouts[0]!.id = 'x'.repeat(5_000_000)), /entrenamientos/],
    ['un entreno con una nota de 5 MB', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as { note?: string }).note = 'x'.repeat(5_000_000)), /entrenamientos/],
    ['un entreno con 200 000 muestras de pulso', (d: ReturnType<typeof valid>['data']) => void (d.workouts[0]!.hr = Array.from({ length: 200_000 }, () => [at(7), 120] as [number, number])), /entrenamientos/],
    ['un entreno con un origen desconocido', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as { source: string }).source = 'hacker'), /entrenamientos/],
    ['un entreno con un desnivel imposible', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as { ascentM?: number }).ascentM = 1e9), /entrenamientos/],
    ['un recorrido que no es una lista', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as unknown as { route: unknown }).route = 'texto'), /entrenamientos/],
    ['un recorrido con un punto de tres coordenadas', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as unknown as { route: unknown }).route = [[40, -3, 7]]), /entrenamientos/],
    ['un recorrido con una latitud de 95 grados', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as unknown as { route: unknown }).route = [[95, -3], [40, -3]]), /entrenamientos/],
    ['un recorrido de 100 000 puntos', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as unknown as { route: unknown }).route = Array.from({ length: 100_000 }, () => [40, -3])), /entrenamientos/],
    ['un entreno con un desnivel negativo', (d: ReturnType<typeof valid>['data']) => void ((d.workouts[0] as { ascentM?: number }).ascentM = -4), /entrenamientos/],
    ['una sesión de sueño con 10 000 tramos', (d: ReturnType<typeof valid>['data']) => void (d.sleep[0]!.segments = Array.from({ length: 10_000 }, () => ({ stage: 'deep', startMs: at(1), durationSec: 60 }))), /sueño/],
  ])('%s', (_name, change, expected) => {
    expect(reject(change)).toMatch(expected);
  });

  describe('una fecha imposible deja fuera SOLO ese registro (y se cuenta), no rechaza la copia: lo que la propia app exportó tiene que poder restaurarse', () => {
    const parse = (change: (data: ReturnType<typeof valid>['data']) => void): ParsedBackup => {
      const file = valid();
      change(file.data);
      return parseBackup(file);
    };

    it('el recorrido de un entreno viaja en la copia y se conserva al restaurarla', () => {
      const file = valid();
      (file.data.workouts[0] as { route?: Array<[number, number]> }).route = [[40.4, -3.7], [40.401, -3.699], [40.402, -3.7]];
      const parsed = parseBackup(file);
      expect(parsed.skipped).toBe(0);
      expect(parsed.workouts[0]!.route).toEqual([[40.4, -3.7], [40.401, -3.699], [40.402, -3.7]]);
    });

    it('una copia de antes del recorrido (sin el campo) se restaura igual y sin recorrido', () => {
      expect(parseBackup(valid()).workouts[0]!.route).toBeUndefined();
    });

    it('una copia normal no deja nada fuera', () => {
      expect(parseBackup(valid()).skipped).toBe(0);
    });

    type Data = ReturnType<typeof valid>['data'];
    type Section = 'heart' | 'counters' | 'spo2' | 'sleep' | 'buckets' | 'workouts';
    const cases: Array<[string, (d: Data) => void, Section]> = [
      ['un pulso del año 3000', (d) => void (d.heart[0]!.tsMs = Date.UTC(3000, 0, 1)), 'heart'],
      ['un pulso con la fecha 1e300 (desbordaría el formateo de fechas)', (d) => void (d.heart[0]!.tsMs = 1e300), 'heart'],
      ['un contador de 1970 (un móvil con el reloj roto)', (d) => void (d.counters[0]!.tsMs = 0), 'counters'],
      ['un oxígeno de dentro de una semana', (d) => void (d.spo2[0]!.tsMs = Date.now() + 7 * 86_400_000), 'spo2'],
      ['una noche anterior al año 2000', (d) => void (d.sleep[0]!.startMs = Date.UTC(1999, 0, 1)), 'sleep'],
      ['una noche de 3 días', (d) => void (d.sleep[0]!.endMs = d.sleep[0]!.startMs + 3 * 86_400_000), 'sleep'],
      ['un tramo de actividad de 5 días', (d) => void (d.buckets[0]!.endMs = d.buckets[0]!.startMs + 5 * 86_400_000), 'buckets'],
      ['un entreno de 1995', (d) => void ((d.workouts[0]!.startMs = Date.UTC(1995, 0, 1)), (d.workouts[0]!.endMs = Date.UTC(1995, 0, 1) + 3_600_000)), 'workouts'],
      ['un entreno con más pausa que duración', (d) => void (d.workouts[0]!.pausedMs = 10 * 86_400_000), 'workouts'],
    ];
    it.each(cases)('%s', (_name, change, section) => {
      const parsed = parse(change);
      expect(parsed.skipped).toBe(1);
      expect(parsed[section]).toHaveLength(0);
      // Lo demás entra.
      expect(parsed.profile).toHaveLength(1);
    });

    const thisYear = new Date().getFullYear();
    it.each([
      ['una vigencia del año 2099', { date: '2099-12-31' }],
      ['una vigencia del año 100 (estiraría el periodo «Todo» a 700 000 días)', { date: '0100-01-01' }],
      ['una vigencia anterior al año 2000', { date: '1999-12-31' }],
      ['una fecha de nacimiento del año 1700 (el pulso máximo saldría negativo)', { birthDate: '1700-01-01' }],
      ['una persona de 3 años', { birthDate: `${thisYear - 3}-01-01` }],
      ['una persona que aún no ha nacido', { birthDate: `${thisYear + 1}-01-01` }],
    ])('una entrada de perfil con %s se deja fuera y se cuenta', (_name, change) => {
      const parsed = parse((d) => void Object.assign(d.profile[0]!, change));
      expect(parsed.skipped).toBe(1);
      expect(parsed.profile).toHaveLength(0);
      expect(parsed.workouts).toHaveLength(1);
    });

    it('una entrada de perfil normal con una vigencia antigua (de 2018) se conserva', () => {
      const parsed = parse((d) => void (d.profile[0]!.date = '2018-03-04'));
      expect(parsed.skipped).toBe(0);
      expect(parsed.profile).toHaveLength(1);
    });

    it('la fecha de la última copia imposible se ignora sin rechazar la copia; una normal se conserva; un texto sí la rechaza', () => {
      for (const bad of [1e300, -1e300, 0, Date.now() + 30 * 86_400_000]) {
        const parsed = parse((d) => void ((d.settings as { lastBackupMs: unknown }).lastBackupMs = bad));
        expect(parsed.settings.lastBackupMs, String(bad)).toBeUndefined();
        expect(parsed.settings.stepGoal).toBe(9000);
      }
      const good = Date.now() - 86_400_000;
      expect(parse((d) => void ((d.settings as { lastBackupMs: unknown }).lastBackupMs = good)).settings.lastBackupMs).toBe(good);
      expect(reject((d) => void ((d.settings as { lastBackupMs: unknown }).lastBackupMs = 'ayer'))).toMatch(/última copia/);
    });

    it('un entreno manual de 2012 (la fecha del formulario no tiene mínimo) se conserva', () => {
      const parsed = parse((d) => {
        d.workouts[0]!.startMs = new Date(2012, 5, 1, 10).getTime();
        d.workouts[0]!.endMs = new Date(2012, 5, 1, 11).getTime();
        d.workouts[0]!.hr = [[new Date(2012, 5, 1, 10, 30).getTime(), 120]];
      });
      expect(parsed.skipped).toBe(0);
      expect(parsed.workouts).toHaveLength(1);
    });

    it('las muestras de pulso de fuera del entreno se descartan sin dejar fuera el entreno', () => {
      const parsed = parse((d) => {
        d.workouts[0]!.hr = [[at(7), 120], [Date.UTC(3000, 0, 1), 150], [at(7) + 60_000, 130]];
      });
      expect(parsed.skipped).toBe(0);
      expect(parsed.workouts[0]?.hr).toEqual([[at(7), 120], [at(7) + 60_000, 130]]);
    });

    it('una sincronización de 1970 se deja fuera y la copia se restaura', () => {
      const parsed = parse((d) => void (d.syncs = [{ tsMs: 0, ringName: 'R99' }] as never));
      expect(parsed.skipped).toBe(1);
      expect(parsed.syncs).toHaveLength(0);
    });

    it('un `1e300` NO entra (aunque la copia sí se acepte): el resto de la copia queda intacta', () => {
      const parsed = parse((d) => {
        d.heart.push({ tsMs: 1e300, bpm: 70, source: 'ring-auto' });
        d.heart.push({ tsMs: at(11), bpm: 66, source: 'ring-auto' });
      });
      expect(parsed.heart.map((h) => h.bpm)).toEqual([64, 66]);
      expect(parsed.skipped).toBe(1);
    });

    it('lo que sigue siendo estructura rota (un texto donde va una fecha) sí rechaza la copia', () => {
      expect(reject((d) => void ((d.heart[0] as { tsMs: unknown }).tsMs = 'ayer'))).toMatch(/cardiaca/);
      expect(reject((d) => void ((d.workouts[0] as { startMs: unknown }).startMs = null))).toMatch(/entrenamientos/);
    });
  });

  it('un apartado con demasiados registros se rechaza antes de recorrerlo', () => {
    const file = valid();
    file.data.heart = Array.from({ length: 600_001 }, () => file.data.heart[0]!);
    expect(() => parseBackup(file)).toThrow(/demasiados registros/);
  });

  it('lo que la copia trae de más no llega al almacén: cada registro se reconstruye con los campos conocidos', () => {
    const file = valid();
    (file.data.workouts[0] as Record<string, unknown>).extra = { grande: 'x'.repeat(1000) };
    (file.data.heart[0] as Record<string, unknown>).tambien = 1;
    (file.data.profile[0] as Record<string, unknown>).__proto__ = { admin: true };
    (file.data.sleep[0]!.segments[0] as Record<string, unknown>).basura = true;
    const parsed = parseBackup(file);
    expect(Object.keys(parsed.workouts[0]!).sort()).toEqual(['distanceM', 'endMs', 'hr', 'id', 'pausedMs', 'source', 'sport', 'startMs', 'steps']);
    expect(Object.keys(parsed.heart[0]!).sort()).toEqual(['bpm', 'source', 'tsMs']);
    expect(Object.keys(parsed.profile[0]!).sort()).toEqual(['birthDate', 'date', 'heightCm', 'sex', 'weightKg']);
    expect(Object.keys(parsed.sleep[0]!.segments[0]!).sort()).toEqual(['durationSec', 'stage', 'startMs']);
    // Y son copias: cambiar lo importado no toca el archivo leído.
    expect(parsed.workouts[0]).not.toBe(file.data.workouts[0]);
  });

  it('una copia antigua sin origen del entreno ni datos informativos del anillo se completa con valores neutros', () => {
    const file = valid();
    delete (file.data.workouts[0] as { source?: string }).source;
    delete (file.data.buckets[0] as { ringDistanceM?: number }).ringDistanceM;
    delete (file.data.buckets[0] as { ringCalories?: number }).ringCalories;
    const parsed = parseBackup(file);
    expect(parsed.workouts[0]?.source).toBe('manual');
    expect(parsed.buckets[0]).toMatchObject({ ringDistanceM: 0, ringCalories: 0 });
  });

  describe('las sincronizaciones pasadas (solo diagnóstico) se acotan en vez de rechazar la copia', () => {
    const syncOf = (over: Record<string, unknown>) => ({ tsMs: at(9), ringName: 'R99 F265', ...over });

    it('`capabilities` que no es una lista no llega: se recorre al arrancar y dejaría la app sin iniciar', () => {
      const file = valid();
      file.data.syncs = [syncOf({ capabilities: 5 }), syncOf({ capabilities: 'steps', tsMs: at(10) }), syncOf({ capabilities: null, tsMs: at(11) })] as never;
      const [a, b, c] = parseBackup(file).syncs;
      expect(a && 'capabilities' in a).toBe(false);
      expect(b && 'capabilities' in b).toBe(false);
      expect(c?.capabilities).toBeNull();
    });

    it('una lista de capacidades se limpia: solo textos cortos y como mucho 32', () => {
      const file = valid();
      file.data.syncs = [syncOf({ capabilities: ['steps', 7, { a: 1 }, 'x'.repeat(100), ...Array.from({ length: 100 }, (_, i) => `c${i}`)] })] as never;
      const caps = parseBackup(file).syncs[0]?.capabilities ?? [];
      expect(caps[0]).toBe('steps');
      expect(caps.length).toBeLessThanOrEqual(32);
      expect(caps.every((c) => typeof c === 'string' && c.length <= 40)).toBe(true);
    });

    it('lo demás se reconstruye con valores acotados y sin campos de más', () => {
      const file = valid();
      file.data.syncs = [
        syncOf({
          firmware: 5,
          batteryPercent: 900,
          durationMs: -3,
          interrupted: 'sí',
          liveSteps: 1e12,
          error: 'x'.repeat(10_000),
          outcomes: [{ type: 'sleep', status: 'ok', bytes: 120, ms: 80, detail: '1 registro(s)', extra: 1 }, 'basura', null],
          added: { heart: 3, sleep: 'mucho' },
          dropped: { 'pulso fuera de rango': 2, __proto__: 5, malo: 'x' },
          log: 'texto largo que no se importa',
          otraCosa: { enorme: true },
        }),
      ] as never;
      const sync = parseBackup(file).syncs[0]!;
      expect(sync).toEqual({
        tsMs: at(9),
        ringName: 'R99 F265',
        firmware: null,
        batteryPercent: null,
        durationMs: 0,
        interrupted: false,
        outcomes: [{ type: 'sleep', status: 'ok', bytes: 120, ms: 80, detail: '1 registro(s)' }],
        added: { buckets: 0, counters: 0, heart: 3, spo2: 0, sleep: 0 },
        dropped: { 'pulso fuera de rango': 2 },
        liveSteps: null,
      });
    });

    it('sin fecha (un texto) o con un nombre de anillo enorme, sí se rechaza (no es una sincronización)', () => {
      const file = valid();
      file.data.syncs = [syncOf({ tsMs: 'ayer' })] as never;
      expect(() => parseBackup(file)).toThrow(/sincronizaciones/);
      file.data.syncs = [syncOf({ ringName: 'x'.repeat(500) })] as never;
      expect(() => parseBackup(file)).toThrow(/sincronizaciones/);
    });
  });
});

describe('parseBackup: comidas y objetivo de salud', () => {
  const meal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'c1', tsMs: at(14), name: 'Arroz con pollo', kcal: 680, proteinG: 42, carbsG: 82, fatG: 17, source: 'ai', ...over });
  const withMeals = (meals: unknown): ReturnType<typeof valid> & { data: { meals: unknown } } => ({ ...valid(), data: { ...valid().data, meals } });

  it('una copia anterior a la alimentación (sin comidas) se acepta, con una lista vacía', () => {
    expect(parseBackup(valid()).meals).toEqual([]);
  });

  it('las comidas válidas se reconstruyen con los campos conocidos', () => {
    const parsed = parseBackup(withMeals([{ ...meal(), extra: 'x'.repeat(10_000), barcode: '8410000000016', grams: 125 }, meal({ id: 'c2', proteinG: undefined, carbsG: undefined, fatG: undefined, source: 'manual' })]));
    expect(parsed.meals).toEqual([
      { id: 'c1', tsMs: at(14), name: 'Arroz con pollo', kcal: 680, proteinG: 42, carbsG: 82, fatG: 17, source: 'ai', barcode: '8410000000016', grams: 125 },
      { id: 'c2', tsMs: at(14), name: 'Arroz con pollo', kcal: 680, source: 'manual' },
    ]);
  });

  it.each([
    ['calorías negativas', { kcal: -1 }],
    ['calorías de 10⁶', { kcal: 1e6 }],
    ['una proteína de 5 kg', { proteinG: 5000 }],
    ['una procedencia desconocida', { source: 'telepatia' }],
    ['un código de barras con letras', { barcode: 'ABCDEFGHIJ' }],
    ['un nombre enorme', { name: 'x'.repeat(500) }],
    ['sin identificador', { id: '' }],
    ['una hora que no es un número', { tsMs: 'ayer' }],
  ])('rechaza la copia con %s', (_, over) => {
    expect(() => parseBackup(withMeals([meal(over)]))).toThrow(BackupError);
  });

  it('una comida con una fecha imposible se deja fuera y se cuenta, sin rechazar la copia', () => {
    const parsed = parseBackup(withMeals([meal({ tsMs: 5 }), meal({ id: 'c2' })]));
    expect(parsed.meals.map((m) => m.id)).toEqual(['c2']);
    expect(parsed.skipped).toBe(1);
  });

  it('el día al que se pasó una comida se conserva si es válido y a lo sumo a unos días del real; si no, se descarta sin rechazar la copia', () => {
    const day = (over: Record<string, unknown>): Record<string, unknown> => ({ ...meal(), ...over });
    const parsed = parseBackup(withMeals([day({ id: 'a', day: '2026-07-08' }), day({ id: 'b', day: '2026-07-09' }), day({ id: 'c', day: '2026-07-30' }), day({ id: 'd', day: 'ayer' })]));
    expect(parsed.meals.map((m) => [m.id, m.day])).toEqual([['a', '2026-07-08'], ['b', undefined], ['c', undefined], ['d', undefined]]);
  });

  it('un apartado de comidas que no es una lista se rechaza', () => {
    expect(() => parseBackup(withMeals({ a: 1 }))).toThrow(/comidas/);
  });

  it('el objetivo de salud se valida como los demás ajustes', () => {
    expect(parseBackup({ ...valid(), data: { ...valid().data, settings: { ...valid().data.settings, healthGoal: 'muscle' } } }).settings.healthGoal).toBe('muscle');
    expect(() => parseBackup({ ...valid(), data: { ...valid().data, settings: { ...valid().data.settings, healthGoal: 'volar' } } })).toThrow(/objetivo de salud/);
  });

  it('el peso objetivo se valida: sin él (null), un peso razonable; fuera de rango o de otro tipo se rechaza', () => {
    const withTarget = (value: unknown) => parseBackup({ ...valid(), data: { ...valid().data, settings: { ...valid().data.settings, targetWeightKg: value } } });
    expect(withTarget(72.5).settings.targetWeightKg).toBe(72.5);
    expect(withTarget(null).settings.targetWeightKg).toBeNull();
    for (const bad of [10, 400, -70, '74', Number.NaN, {}]) expect(() => withTarget(bad), String(bad)).toThrow(/peso objetivo/);
    // Una copia anterior a este ajuste no lo trae: se importa igual (y queda el valor de serie al restaurar).
    expect(parseBackup(valid()).settings.targetWeightKg).toBeUndefined();
  });

  it('los datos del gráfico de Salud se validan: cualquier cantidad y orden de datos conocidos; uno desconocido, repetido o una cosa que no es una lista se rechaza', () => {
    const withMetrics = (value: unknown) => parseBackup({ ...valid(), data: { ...valid().data, settings: { ...valid().data.settings, jointMetrics: value } } });
    expect(withMetrics(['weight', 'distance', 'steps']).settings.jointMetrics).toEqual(['weight', 'distance', 'steps']);
    // Una copia de la versión que aún ofrecía sueño, pulso y oxígeno se importa igual, sin esos datos.
    expect(withMetrics(['sleep', 'weight', 'restingBpm', 'steps', 'spo2Avg']).settings.jointMetrics).toEqual(['weight', 'steps']);
    expect(withMetrics([]).settings.jointMetrics).toEqual([]);
    for (const bad of [['volar'], ['steps', 'steps'], 'steps', 3, {}, [1]]) expect(() => withMetrics(bad), JSON.stringify(bad)).toThrow(/datos del gráfico/);
    expect(parseBackup(valid()).settings.jointMetrics).toBeUndefined(); // una copia anterior no lo trae: se importa igual
  });

  it('reemplazar no exige el apartado de comidas (las copias antiguas no lo traen)', () => {
    expect(() => requireCompleteBackup(parseBackup(valid()))).not.toThrow();
  });
});

describe('parseBackup: agua', () => {
  const sip = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'w1', tsMs: at(14), ml: 250, ...over });
  const withWater = (water: unknown): ReturnType<typeof valid> & { data: { water: unknown } } => ({ ...valid(), data: { ...valid().data, water } });

  it('una copia anterior a la hidratación (sin agua) se acepta, con una lista vacía', () => {
    expect(parseBackup(valid()).water).toEqual([]);
  });

  it('las tomas válidas se reconstruyen con los campos conocidos', () => {
    expect(parseBackup(withWater([{ ...sip(), extra: 'x'.repeat(10_000) }, sip({ id: 'w2', ml: 330.4 })])).water).toEqual([
      { id: 'w1', tsMs: at(14), ml: 250 },
      { id: 'w2', tsMs: at(14), ml: 330 },
    ]);
  });

  it.each([
    ['0 ml', { ml: 0 }],
    ['un litro y medio por toma de más', { ml: 2001 }],
    ['una cantidad que no es un número', { ml: 'mucha' }],
    ['sin identificador', { id: '' }],
    ['una hora que no es un número', { tsMs: 'ayer' }],
  ])('rechaza la copia con %s', (_, over) => {
    expect(() => parseBackup(withWater([sip(over)]))).toThrow(BackupError);
  });

  it('una toma con una fecha imposible se deja fuera y se cuenta, sin rechazar la copia', () => {
    const parsed = parseBackup(withWater([sip({ tsMs: 5 }), sip({ id: 'w2' })]));
    expect(parsed.water.map((w) => w.id)).toEqual(['w2']);
    expect(parsed.skipped).toBe(1);
  });

  it('un apartado de agua que no es una lista se rechaza', () => {
    expect(() => parseBackup(withWater({ a: 1 }))).toThrow(/agua/);
  });
});

describe('parseBackup: platos guardados', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const plate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'p1',
    name: 'Lentejas',
    createdMs: at(10),
    updatedMs: at(11),
    ingredients: [{ name: 'Lentejas', kcal: 600, proteinG: 40, grams: 400 }, { name: 'Chorizo', kcal: 300, barcode: '8410000000017' }],
    ...over,
  });
  const withDishes = (dishes: unknown): ReturnType<typeof valid> & { data: { dishes: unknown } } => ({ ...valid(), data: { ...valid().data, dishes } });

  it('una copia anterior a los platos se acepta, con una lista vacía, y reemplazar no exige el apartado', () => {
    const parsed = parseBackup(valid());
    expect(parsed.dishes).toEqual([]);
    expect(() => requireCompleteBackup(parsed)).not.toThrow();
  });

  it('los platos válidos se reconstruyen con los campos conocidos (lo de más no llega al almacén)', () => {
    const parsed = parseBackup(withDishes([{ ...plate({ photo: PHOTO, lastUsedMs: at(12) }), extra: 'x'.repeat(5_000) }]));
    expect(parsed.dishes).toEqual([
      {
        id: 'p1',
        name: 'Lentejas',
        createdMs: at(10),
        updatedMs: at(11),
        lastUsedMs: at(12),
        ingredients: [{ name: 'Lentejas', kcal: 600, proteinG: 40, grams: 400 }, { name: 'Chorizo', kcal: 300, barcode: '8410000000017' }],
        photo: PHOTO,
      },
    ]);
  });

  it.each([
    ['sin nombre', { name: '' }],
    ['con 0 raciones (de la versión con raciones)', { servings: 0 }],
    ['con raciones que no son enteras', { servings: 2.5 }],
    ['con 101 raciones', { servings: 101 }],
    ['sin ingredientes', { ingredients: [] }],
    ['con un ingrediente de 20.000 kcal', { ingredients: [{ name: 'Olla', kcal: 20_000 }] }],
    ['con un ingrediente sin nombre válido', { ingredients: [{ name: 5, kcal: 10 }] }],
    ['con un código de barras raro', { ingredients: [{ name: 'X', kcal: 10, barcode: 'abc' }] }],
    ['con una foto que no es un JPEG en texto', { photo: 'data:image/png;base64,AAAA' }],
    ['con una foto que es una dirección de internet', { photo: 'https://x.test/a.jpg' }],
    ['con una foto con código dentro', { photo: 'data:image/jpeg;base64,"><script>' }],
    ['con una foto enorme', { photo: `data:image/jpeg;base64,${'A'.repeat(250_000)}` }],
  ])('rechaza la copia con un plato %s', (_, over) => {
    expect(() => parseBackup(withDishes([plate(over)]))).toThrow(BackupError);
  });

  it('un plato de una copia con raciones (la versión anterior) se pasa a una ración', () => {
    const parsed = parseBackup(withDishes([plate({ servings: 2, ingredients: [{ name: 'Lentejas', kcal: 600, proteinG: 40, grams: 400 }, { name: 'Pan', kcal: 80 }] })]));
    expect(parsed.dishes[0]).not.toHaveProperty('servings');
    expect(parsed.dishes[0]?.ingredients).toEqual([{ name: 'Lentejas', kcal: 300, proteinG: 20, grams: 200 }, { name: 'Pan', kcal: 40 }]);
  });

  it('un plato con una fecha imposible se deja fuera y se cuenta, sin rechazar la copia', () => {
    const parsed = parseBackup(withDishes([plate({ createdMs: 5 }), plate({ id: 'p2' })]));
    expect(parsed.dishes.map((d) => d.id)).toEqual(['p2']);
    expect(parsed.skipped).toBe(1);
  });

  it('un apartado de platos que no es una lista se rechaza', () => {
    expect(() => parseBackup(withDishes({ a: 1 }))).toThrow(/platos/);
  });

  it('una comida anotada desde un plato (`source: dish`) es válida', () => {
    const file = { ...valid(), data: { ...valid().data, meals: [{ id: 'm', tsMs: at(12), name: 'Lentejas', kcal: 390, source: 'dish' }] } };
    expect(parseBackup(file).meals[0]?.source).toBe('dish');
  });

  it('la comida lleva el id del plato con el que se anotó (su foto es la miniatura) y la copia lo conserva; un id raro se rechaza', () => {
    const meal = (dishId: unknown): unknown => ({ ...valid(), data: { ...valid().data, meals: [{ id: 'm', tsMs: at(12), name: 'Lentejas', kcal: 390, source: 'dish', dishId }] } });
    expect(parseBackup(meal('p1')).meals[0]).toMatchObject({ source: 'dish', dishId: 'p1' });
    expect(() => parseBackup(meal(''))).toThrow(/comidas/);
    expect(() => parseBackup(meal(7))).toThrow(/comidas/);
    expect(() => parseBackup(meal('x'.repeat(65)))).toThrow(/comidas/);
  });
});

describe('requireCompleteBackup: reemplazar exige una copia completa', () => {
  it('una copia con todos los apartados vale (aunque estén vacíos)', () => {
    const empty = valid();
    for (const key of ['profile', 'workouts', 'buckets', 'counters', 'heart', 'spo2', 'sleep'] as const) (empty.data[key] as unknown[]).length = 0;
    expect(() => requireCompleteBackup(parseBackup(empty))).not.toThrow();
  });

  it('data: {} o con un apartado ausente no vale', () => {
    expect(() => requireCompleteBackup(parseBackup({ format: 'smartring-backup', version: 1, data: {} }))).toThrow(/incompleta/);
    const file = valid() as { data: Record<string, unknown> };
    delete file.data.heart;
    expect(() => requireCompleteBackup(parseBackup(file))).toThrow(/falta: frecuencia cardiaca/);
  });

  it('la comida lleva lo que lleva, alimento a alimento con sus gramos (para cambiarlos después): la copia lo conserva, lo limpia y rechaza lo raro', () => {
    const meal = (items: unknown): unknown => ({ ...valid(), data: { ...valid().data, meals: [{ id: 'm', tsMs: at(12), name: 'Arroz + Pollo', kcal: 500, source: 'text', grams: 350, items }] } });
    const items = [
      { name: 'Arroz', kcal: 260, proteinG: 5.4, grams: 200, extra: 'se descarta' },
      { name: 'Pollo', kcal: 240, grams: 150 },
    ];
    expect(parseBackup(meal(items)).meals[0]?.items).toEqual([
      { name: 'Arroz', kcal: 260, proteinG: 5.4, grams: 200 },
      { name: 'Pollo', kcal: 240, grams: 150 },
    ]);
    expect(() => parseBackup(meal([]))).toThrow(/comidas/); // sin alimentos no es un desglose
    expect(() => parseBackup(meal('arroz'))).toThrow(/comidas/);
    expect(() => parseBackup(meal([{ name: 'Arroz', kcal: -5 }]))).toThrow(/comidas/);
    expect(() => parseBackup(meal(Array.from({ length: 21 }, (_, i) => ({ name: `a${i}`, kcal: 1 }))))).toThrow(/comidas/);
  });

});
