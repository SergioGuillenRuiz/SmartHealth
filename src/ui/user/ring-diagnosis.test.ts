import { describe, expect, it } from 'vitest';
import { diagnoseRing, LOW_BATTERY_PERCENT, NO_HEART_HOURS, NO_SLEEP_DAYS, STALE_SYNC_HOURS, VERY_LOW_BATTERY_PERCENT, VERY_STALE_SYNC_DAYS, type DiagnosisInput, type DiagnosisSync } from './ring-diagnosis';

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const sync = (hoursAgo: number, o: Partial<DiagnosisSync> = {}): DiagnosisSync => ({ tsMs: NOW - hoursAgo * HOUR, batteryPercent: 80, interrupted: false, outcomes: [], ...o });

/** Un anillo en perfecto estado: sincronizado hace 2 h, con batería y con lecturas de pulso hasta hace una hora. */
const healthy = (o: Partial<DiagnosisInput> = {}): DiagnosisInput => {
  const last = sync(2);
  return {
    nowMs: NOW,
    linked: true,
    lastSync: last,
    lastAttempt: last,
    latest: { heartMs: NOW - HOUR, spo2Ms: NOW - HOUR, activityMs: NOW - HOUR / 2, sleepEndMs: NOW - 5 * HOUR },
    capabilities: null,
    ...o,
  };
};

const texts = (input: DiagnosisInput): string[] => diagnoseRing(input).findings.map((f) => f.text);

describe('diagnoseRing', () => {
  it('sin anillo vinculado solo hay que vincularlo', () => {
    expect(diagnoseRing(healthy({ linked: false }))).toEqual({ tone: 'bad', headline: 'Sin anillo vinculado', findings: [], action: 'link', battery: null });
  });

  it('con todo en orden no avisa de nada y da la batería que conoce', () => {
    const d = diagnoseRing(healthy());
    expect(d).toMatchObject({ tone: 'ok', headline: 'Todo en orden', findings: [], action: null });
    expect(d.battery).toEqual({ percent: 80, tsMs: NOW - 2 * HOUR });
  });

  describe('la última sincronización', () => {
    it('sin ninguna completa lo dice y manda a sincronizar', () => {
      const d = diagnoseRing(healthy({ lastSync: null, lastAttempt: null }));
      expect(d.tone).toBe('warn');
      expect(d.findings.map((f) => f.text)).toEqual(['Todavía no se ha completado ninguna sincronización.']);
      expect(d.action).toBe('sync');
    });

    it(`desde las ${STALE_SYNC_HOURS} h es un aviso (el mismo momento en que el botón del anillo pasa a naranja); antes, nada`, () => {
      const fresh = sync(STALE_SYNC_HOURS - 0.1);
      expect(diagnoseRing(healthy({ lastSync: fresh, lastAttempt: fresh })).findings).toEqual([]);
      const stale = sync(STALE_SYNC_HOURS);
      const d = diagnoseRing(healthy({ lastSync: stale, lastAttempt: stale }));
      expect(d.tone).toBe('warn');
      expect(d.findings.map((f) => f.text)).toEqual(['La última sincronización fue hace 6 h: lo de hoy puede estar incompleto.']);
      expect(d.action).toBe('sync');
    });

    it('con más de un día lo dice como lo dice el resto de la hoja («ayer a las 06:00»)', () => {
      const old = sync(30);
      expect(texts(healthy({ lastSync: old, lastAttempt: old }))).toEqual(['La última sincronización fue ayer a las 06:00: lo de hoy puede estar incompleto.']);
    });

    it(`a los ${VERY_STALE_SYNC_DAYS} días es grave y avisa de que el anillo guarda pocos días`, () => {
      const old = sync(VERY_STALE_SYNC_DAYS * 24 + 5);
      const d = diagnoseRing(healthy({ lastSync: old, lastAttempt: old }));
      expect(d.tone).toBe('bad');
      expect(d.findings[0]).toEqual({ tone: 'bad', text: 'La última sincronización fue hace 3 días: el anillo solo guarda unos días de datos.' });
      expect(d.action).toBe('sync');
    });

    it('con la sincronización vieja no se avisa además de que falten lecturas: lo que falta es traerlas', () => {
      const old = sync(30);
      const d = diagnoseRing(healthy({ lastSync: old, lastAttempt: old, latest: { heartMs: NOW - 40 * HOUR, spo2Ms: null, activityMs: null, sleepEndMs: null } }));
      expect(d.findings.map((f) => f.text)).toEqual(['La última sincronización fue ayer a las 06:00: lo de hoy puede estar incompleto.']);
    });
  });

  describe('el último intento', () => {
    it('uno que falló después de la última sincronización buena se cuenta, con su motivo (sin duplicar el punto)', () => {
      const failed = sync(0.5, { error: 'No se encontró el anillo.', batteryPercent: null });
      const d = diagnoseRing(healthy({ lastAttempt: failed }));
      expect(d.tone).toBe('warn');
      expect(d.findings.map((f) => f.text)).toEqual(['El último intento, hace 30 min, falló: No se encontró el anillo.']);
      expect(d.action).toBe('sync');
    });

    it('uno cortado a medias queda como incompleto', () => {
      expect(texts(healthy({ lastAttempt: sync(1, { interrupted: true }) }))).toEqual(['El último intento, hace 1 h, quedó incompleto.']);
    });

    it('un mensaje larguísimo se recorta', () => {
      const [text] = texts(healthy({ lastAttempt: sync(0.2, { error: 'x'.repeat(500) }) }));
      expect(text?.length).toBeLessThan(220);
      expect(text).toContain('…');
    });

    it('el intento que es la propia sincronización buena no es un aviso', () => {
      const same = sync(2);
      expect(texts(healthy({ lastSync: same, lastAttempt: same }))).toEqual([]);
    });

    it('lo que no se pudo leer en un intento que sí acabó se dice con nombres de persona', () => {
      const attempt = sync(1, { outcomes: [{ type: 'sleep', status: 'timeout' }, { type: 'heart', status: 'ok' }, { type: 'spo2', status: 'corrupt' }, { type: 'sport', status: 'empty' }, { type: 'all', status: 'unsupported' }] });
      const d = diagnoseRing(healthy({ lastSync: attempt, lastAttempt: attempt }));
      expect(d.findings.map((f) => f.text)).toEqual(['No se pudo leer: sueño y oxígeno.']);
      expect(d.action).toBe('sync');
    });

    it('el oxígeno que el R99 nunca contesta no es un fallo si las constantes se leyeron: con su resultado real, todo en orden', () => {
      const r99 = sync(1, { outcomes: [{ type: 'sport', status: 'ok' }, { type: 'sleep', status: 'empty' }, { type: 'heart', status: 'ok' }, { type: 'all', status: 'ok' }, { type: 'spo2', status: 'timeout', detail: 'sin cabecera' }] });
      const d = diagnoseRing(healthy({ lastSync: r99, lastAttempt: r99 }));
      expect(d.findings).toEqual([]);
      expect(d.tone).toBe('ok');
      expect(d.action).toBeNull();
    });

    it('pero un silencio del oxígeno a mitad de transferencia, o sin las constantes leídas, sí se cuenta', () => {
      const midway = sync(1, { outcomes: [{ type: 'all', status: 'ok' }, { type: 'spo2', status: 'timeout', detail: 'silencio con 12/100 B' }] });
      expect(texts(healthy({ lastSync: midway, lastAttempt: midway }))).toEqual(['No se pudo leer: oxígeno.']);
      const noConstants = sync(1, { outcomes: [{ type: 'all', status: 'timeout', detail: 'sin cabecera' }, { type: 'spo2', status: 'timeout', detail: 'sin cabecera' }] });
      expect(texts(healthy({ lastSync: noConstants, lastAttempt: noConstants }))).toEqual(['No se pudo leer: pasos y oxígeno.']);
    });

    it('si el intento entero falló no se repite lo que no se leyó', () => {
      const failed = sync(0.5, { error: 'Bluetooth apagado', outcomes: [{ type: 'sleep', status: 'error' }] });
      expect(texts(healthy({ lastAttempt: failed }))).toEqual(['El último intento, hace 30 min, falló: Bluetooth apagado.']);
    });
  });

  describe('la batería', () => {
    const withBattery = (percent: number | null): DiagnosisInput => healthy({ lastSync: sync(2, { batteryPercent: percent }), lastAttempt: sync(2, { batteryPercent: percent }) });

    it(`hasta el ${LOW_BATTERY_PERCENT} % es un aviso, y por encima nada`, () => {
      expect(texts(withBattery(LOW_BATTERY_PERCENT + 1))).toEqual([]);
      const d = diagnoseRing(withBattery(LOW_BATTERY_PERCENT));
      expect(d.tone).toBe('warn');
      expect(d.findings[0]?.text).toBe('Batería baja: 20 % (hace 2 h).');
      expect(d.action).toBeNull(); // sincronizar no la sube: hay que cargarlo
    });

    it(`hasta el ${VERY_LOW_BATTERY_PERCENT} % es grave y dice qué hacer`, () => {
      const d = diagnoseRing(withBattery(VERY_LOW_BATTERY_PERCENT));
      expect(d.tone).toBe('bad');
      expect(d.findings[0]).toEqual({ tone: 'bad', text: 'Batería muy baja: 10 % (hace 2 h). Ponlo a cargar.' });
      expect(texts(withBattery(VERY_LOW_BATTERY_PERCENT + 1))[0]).toMatch(/^Batería baja/);
    });

    it('sin lectura de batería no se avisa de nada ni se inventa una', () => {
      const d = diagnoseRing(withBattery(null));
      expect(d.findings).toEqual([]);
      expect(d.battery).toBeNull();
    });

    it('vale la lectura más reciente, aunque venga de un intento que falló después; y si ese no la leyó, la de la sincronización', () => {
      const good = sync(5, { batteryPercent: 60 });
      expect(diagnoseRing(healthy({ lastSync: good, lastAttempt: sync(1, { batteryPercent: 15, interrupted: true }) })).battery).toEqual({ percent: 15, tsMs: NOW - HOUR });
      expect(diagnoseRing(healthy({ lastSync: good, lastAttempt: sync(1, { batteryPercent: null, error: 'x' }) })).battery).toEqual({ percent: 60, tsMs: NOW - 5 * HOUR });
    });
  });

  describe('si mide', () => {
    it(`con la última lectura de más de ${NO_HEART_HOURS} h antes de sincronizar, pregunta si lo lleva puesto`, () => {
      const lastSync = sync(1);
      const stale = healthy({ lastSync, lastAttempt: lastSync, latest: { heartMs: lastSync.tsMs - (NO_HEART_HOURS + 1) * HOUR, spo2Ms: null, activityMs: null, sleepEndMs: null } });
      expect(texts(stale)).toEqual(['La última lectura de pulso fue hace 8 h: ¿llevas el anillo puesto?']);
      expect(diagnoseRing(stale).action).toBeNull();
      const fresh = healthy({ lastSync, lastAttempt: lastSync, latest: { heartMs: lastSync.tsMs - (NO_HEART_HOURS - 1) * HOUR, spo2Ms: null, activityMs: null, sleepEndMs: null } });
      expect(texts(fresh)).toEqual([]);
    });

    it('una lectura posterior a la sincronización (una medida a mano) cuenta como reciente', () => {
      const lastSync = sync(3);
      expect(texts(healthy({ lastSync, lastAttempt: lastSync, latest: { heartMs: NOW - 10 * 60_000, spo2Ms: null, activityMs: null, sleepEndMs: null } }))).toEqual([]);
    });

    it('sin ninguna lectura de pulso, también lo dice', () => {
      expect(texts(healthy({ latest: { heartMs: null, spo2Ms: null, activityMs: null, sleepEndMs: null } }))).toEqual(['Todavía no hay lecturas de pulso: ¿llevas el anillo puesto?']);
    });

    it('un anillo sin sensor de pulso no tiene por qué dar lecturas', () => {
      const noHeart = healthy({ capabilities: new Set(['steps', 'sleep']), latest: { heartMs: null, spo2Ms: null, activityMs: NOW - HOUR, sleepEndMs: null } });
      expect(texts(noHeart)).toEqual([]);
      expect(texts(healthy({ capabilities: new Set(['steps', 'heartRate']), latest: { heartMs: null, spo2Ms: null, activityMs: null, sleepEndMs: null } }))).toHaveLength(1);
    });
  });

  it('lo grave va primero, y el tono es el del peor aviso', () => {
    const old = sync(30, { batteryPercent: 8 });
    const d = diagnoseRing(healthy({ lastSync: old, lastAttempt: old }));
    expect(d.tone).toBe('bad');
    expect(d.headline).toBe('Necesita atención');
    expect(d.findings.map((f) => f.tone)).toEqual(['bad', 'warn']);
    expect(d.findings[0]?.text).toMatch(/^Batería muy baja/);
    expect(diagnoseRing(healthy({ lastSync: sync(30), lastAttempt: sync(30) })).headline).toBe('Hay algo que revisar');
  });
});

describe('el sueño: un anillo que mide y no guarda ninguna noche', () => {
  const measuring = { heartMs: NOW - HOUR, spo2Ms: NOW - HOUR, activityMs: NOW - HOUR / 2 };

  it('sin noches tras varios días de uso lo dice, con los días', () => {
    const d = diagnoseRing(healthy({ latest: { ...measuring, sleepEndMs: null }, firstDataMs: NOW - 5 * 24 * HOUR }));
    expect(d.tone).toBe('warn');
    expect(d.findings.map((f) => f.text)).toEqual(['No hay ninguna noche de sueño guardada tras 5 días de uso: el anillo lo registra al dormir con él puesto y bien ajustado (quizá solo en su franja nocturna); mientras, la app estima la noche con el pulso y los pasos.']);
    expect(d.action).toBeNull(); // sincronizar no lo arregla
  });

  it(`al principio (menos de ${NO_SLEEP_DAYS} días) o sin saber desde cuándo, no avisa`, () => {
    expect(texts(healthy({ latest: { ...measuring, sleepEndMs: null }, firstDataMs: NOW - 2 * 24 * HOUR }))).toEqual([]);
    expect(texts(healthy({ latest: { ...measuring, sleepEndMs: null } }))).toEqual([]);
    expect(texts(healthy({ latest: { ...measuring, sleepEndMs: null }, firstDataMs: null }))).toEqual([]);
  });

  it(`con la última noche de hace ${NO_SLEEP_DAYS} días o más avisa; con una reciente, no`, () => {
    expect(texts(healthy({ latest: { ...measuring, sleepEndMs: NOW - (NO_SLEEP_DAYS * 24 + 2) * HOUR } }))).toEqual([
      'La última noche de sueño guardada fue hace 3 días: el anillo lo registra al dormir con él puesto y bien ajustado (quizá solo en su franja nocturna); mientras, la app estima la noche con el pulso y los pasos.',
    ]);
    expect(texts(healthy({ latest: { ...measuring, sleepEndMs: NOW - 2 * 24 * HOUR } }))).toEqual([]);
  });

  it('si el anillo no mide (sin pulso reciente) no se opina del sueño: lo que falta es otra cosa', () => {
    const input = healthy({ latest: { heartMs: NOW - 30 * HOUR, spo2Ms: null, activityMs: null, sleepEndMs: null }, firstDataMs: NOW - 9 * 24 * HOUR });
    expect(texts(input).some((t) => /sueño/.test(t))).toBe(false);
  });

  it('un anillo que no declara sueño no se mide por él', () => {
    expect(texts(healthy({ capabilities: new Set(['heartRate', 'steps']), latest: { ...measuring, sleepEndMs: null }, firstDataMs: NOW - 9 * 24 * HOUR }))).toEqual([]);
  });
});
