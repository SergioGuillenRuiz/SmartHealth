import { describe, expect, it } from 'vitest';
import { fromHex } from './bytes';
import { HISTORY } from './constants';
import { decodeAll, decodeHeart, decodeInto, decodeSleep, decodeSport, decodeSpo2, type HistoryRecords, type SleepSession } from './records';
import { encodeSleep, encodeSport } from './sim/encode';
import { sanitizeHistory } from '../domain/sanitize';
import { CAPTURED_ALL_RECORDS_HEX, CAPTURED_HEART_RECORDS_HEX, CAPTURED_NIGHT_HEX } from './fixtures';
import { ringSecondsToMs } from './time';

const night = fromHex(CAPTURED_NIGHT_HEX);

describe('decodeHeart', () => {
  it('decodifica los 8 registros reales de la noche', () => {
    const records = decodeHeart(fromHex(CAPTURED_HEART_RECORDS_HEX));
    expect(records.map((r) => r.bpm)).toEqual([71, 66, 63, 62, 66, 60, 65, 58]);
    expect(records[0]?.tsMs).toBe(ringSecondsToMs(836_694_044));
  });

  it('descarta fc = 0 (anillo sin puesto)', () => {
    expect(decodeHeart(fromHex('1cf0de310000 1afede310042'))).toHaveLength(1);
  });

  it('descarta una cola incompleta sin desalinear los registros previos', () => {
    expect(decodeHeart(fromHex('1cf0de310047 1afede3100'))).toHaveLength(1);
  });
});

describe('decodeAll', () => {
  const records = decodeAll(fromHex(CAPTURED_ALL_RECORDS_HEX));

  it('lee 8 registros con SpO2 y frecuencia respiratoria', () => {
    expect(records).toHaveLength(8);
    expect(records.map((r) => r.spo2)).toEqual([98, 97, 97, 96, 97, 96, 97, 95]);
    expect(records.map((r) => r.respiratoryRate)).toEqual([14, 13, 13, 12, 13, 12, 13, 12]);
  });

  it('el campo de pasos es un contador acumulado (no decrece dentro de la noche salvo reinicio)', () => {
    expect(records.every((r) => r.steps >= 0 && r.steps < 65536)).toBe(true);
    expect(records[0]?.steps).toBe(0x0d08);
  });
});

describe('decodeSpo2', () => {
  it('decodifica y descarta los registros sin lectura', () => {
    const out = decodeSpo2(fromHex('1cf0de3100611afede310100260cdf31005f'));
    expect(out.map((r) => r.percent)).toEqual([97, 95]);
  });
});

describe('decodeSport', () => {
  it('lee un tramo y descarta el vacío', () => {
    const out = decodeSport(fromHex('1cf0de31a0f3de318002e00119001afede319e01df31000000000000'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ steps: 640, distanceM: 480 });
    expect((out[0]?.endMs ?? 0) - (out[0]?.startMs ?? 0)).toBe(900_000);
  });
});

describe('decodeSleep', () => {
  it('decodifica la noche real: 93,8 min profundo / 249,4 ligero / 130,5 REM', () => {
    const sessions = decodeSleep(night);
    expect(sessions).toHaveLength(1);
    const total = (stage: string) =>
      (sessions[0]?.segments ?? []).filter((s) => s.stage === stage).reduce((a, s) => a + s.durationSec, 0);
    expect(total('deep')).toBe(5627);
    expect(total('light')).toBe(14963);
    expect(total('rem')).toBe(7831);
    expect(total('awake')).toBe(0);
  });

  it('la suma de tramos coincide con los totales que escribe el propio anillo en la cabecera', () => {
    const s = decodeSleep(night)[0];
    expect(s?.headerTotalsSec).toEqual({ rem: 7831, deep: 5627, light: 14963 });
  });

  it('el inicio y el fin son los de la cabecera (22:33 → 06:27)', () => {
    const s = decodeSleep(night)[0];
    const start = new Date(s?.startMs ?? 0);
    const end = new Date(s?.endMs ?? 0);
    expect([start.getHours(), start.getMinutes()]).toEqual([22, 33]);
    expect([end.getHours(), end.getMinutes()]).toEqual([6, 27]);
  });

  it('varias sesiones seguidas se leen todas', () => {
    expect(decodeSleep(new Uint8Array([...night, ...night]))).toHaveLength(2);
  });

  describe('entradas hostiles o raras', () => {
    const header = (segments: number, sessionStart = 0x31def01c): number[] => {
      const recLen = 20 + segments * 8;
      return [0xaf, 0xfa, recLen & 0xff, recLen >> 8, sessionStart & 0xff, (sessionStart >> 8) & 0xff, (sessionStart >> 16) & 0xff, (sessionStart >>> 24) & 0xff, ...new Array(12).fill(0)];
    };
    const seg = (tag: number, start: number, seconds: number): number[] => [
      tag, start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >>> 24) & 0xff, seconds & 0xff, (seconds >> 8) & 0xff, (seconds >> 16) & 0xff,
    ];

    it('una siesta (etiqueta 0xF5) no trunca el resto de la noche', () => {
      const buf = new Uint8Array([
        ...header(3),
        ...seg(0xf2, 0x31def01c, 3600),
        ...seg(0xf5, 0x31def01c + 3600, 1200),
        ...seg(0xf1, 0x31def01c + 4800, 1800),
      ]);
      const stages = decodeSleep(buf)[0]?.segments.map((s) => s.stage);
      expect(stages).toEqual(['light', 'nap', 'deep']);
    });

    it('una etiqueta desconocida se salta sin cortar la lectura', () => {
      const buf = new Uint8Array([
        ...header(3),
        ...seg(0xf2, 0x31def01c, 600),
        ...seg(0xf9, 0x31def01c + 600, 600),
        ...seg(0xf1, 0x31def01c + 1200, 600),
      ]);
      expect(decodeSleep(buf)[0]?.segments.map((s) => s.stage)).toEqual(['light', 'deep']);
    });

    it('la duración es de 24 bits: un tramo de 20 h no se trunca', () => {
      const buf = new Uint8Array([...header(1), ...seg(0xf2, 0x31def01c, 72_000)]);
      expect(decodeSleep(buf)[0]?.segments[0]?.durationSec).toBe(72_000);
    });

    it('limita a un día la duración de un tramo absurdo (0xFFFFFF s)', () => {
      const buf = new Uint8Array([...header(1), ...seg(0xf2, 0x31def01c, 0xffffff)]);
      expect(decodeSleep(buf)[0]?.segments[0]?.durationSec).toBe(86_400);
    });

    it('anota las etiquetas desconocidas que omite, para poder diagnosticarlas', () => {
      const buf = new Uint8Array([...header(3), ...seg(0xf2, 0x31def01c, 600), ...seg(0xf6, 0x31def01c + 600, 1200), ...seg(0xf6, 0x31def01c + 1800, 600)]);
      const notes: string[] = [];
      expect(decodeSleep(buf, notes)[0]?.segments).toHaveLength(1);
      expect(notes).toEqual(['sueño: 2 tramo(s) con etiqueta desconocida 0xf6 (30 min) omitidos']);
    });

    it('un tramo de duración 0 con la misma hora de inicio que uno real no lo tapa (en ningún orden)', () => {
      const start = 0x31def01c;
      const zeroFirst = new Uint8Array([...header(3), ...seg(0xf2, start, 1800), ...seg(0xf1, start + 1800, 0), ...seg(0xf3, start + 1800, 900)]);
      const realFirst = new Uint8Array([...header(3), ...seg(0xf2, start, 1800), ...seg(0xf3, start + 1800, 900), ...seg(0xf1, start + 1800, 0)]);
      for (const buf of [zeroFirst, realFirst]) {
        const segs = decodeSleep(buf)[0]?.segments ?? [];
        expect(segs.map((s) => [s.stage, s.durationSec])).toEqual([
          ['light', 1800],
          ['rem', 900],
        ]);
      }
    });

    it('un tramo repetido (misma hora de inicio) se cuenta una sola vez', () => {
      const buf = new Uint8Array([
        ...header(4),
        ...seg(0xf2, 0x31def01c, 1800),
        ...seg(0xf1, 0x31def01c + 1800, 1800),
        ...seg(0xf3, 0x31def01c + 3600, 1800),
        ...seg(0xf1, 0x31def01c + 1800, 1800),
      ]);
      const segments = decodeSleep(buf)[0]?.segments ?? [];
      expect(segments).toHaveLength(3);
      expect(segments.reduce((a, s) => a + s.durationSec, 0)).toBe(5400);
    });

    it('una transferencia truncada no lee más allá del final del buffer', () => {
      const buf = new Uint8Array([...header(2), ...seg(0xf2, 0x31def01c, 600)]); // la cabecera anuncia 2, solo hay 1
      expect(decodeSleep(buf)[0]?.segments).toHaveLength(1);
    });

    it('una longitud de registro absurda no provoca un bucle infinito', () => {
      const buf = new Uint8Array(40);
      buf[2] = 0;
      buf[3] = 0;
      expect(() => decodeSleep(buf)).not.toThrow();
      expect(decodeSleep(buf)).toEqual([]);
    });

    describe('una sesión sin ningún tramo legible', () => {
      const start = 0x31def01c; // 2026
      /** Pone el fin de la sesión y unos totales por fase distintos de cero (lo normal en una noche de verdad). */
      const withEnd = (hdr: number[], endSec: number, totals = true): number[] => {
        const out = [...hdr];
        out[8] = endSec & 0xff;
        out[9] = (endSec >> 8) & 0xff;
        out[10] = (endSec >> 16) & 0xff;
        out[11] = (endSec >>> 24) & 0xff;
        if (totals) out[16] = 120; // minutos o segundos de sueño profundo: basta con que no sea cero
        return out;
      };

      it('con la cabecera de fiar se conserva la duración (sin fases) y se deja dicho', () => {
        const buf = new Uint8Array(withEnd(header(0), start + 7 * 3600));
        const notes: string[] = [];
        const sessions = decodeSleep(buf, notes);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.segments).toEqual([]);
        expect((sessions[0]?.endMs ?? 0) - (sessions[0]?.startMs ?? 0)).toBe(7 * 3600_000);
        expect(notes.join(' ')).toMatch(/solo se conserva su duración/);
      });

      it('también cuando los tramos tienen todos una etiqueta que no se entiende', () => {
        const buf = new Uint8Array([...withEnd(header(2), start + 6 * 3600), ...seg(0xf9, start, 1800), ...seg(0xf9, start + 1800, 900)]);
        const sessions = decodeSleep(buf);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.segments).toEqual([]);
      });

      it('si los totales por fase de la cabecera son todo ceros, el anillo no vio sueño: no se inventa una noche', () => {
        expect(decodeSleep(new Uint8Array(withEnd(header(0), start + 7 * 3600, false)))).toEqual([]);
      });

      it('una cabecera dudosa no inventa una noche: sin fin, de menos de media hora o de antes de 2020', () => {
        expect(decodeSleep(new Uint8Array(header(0)))).toEqual([]); // fin 0
        expect(decodeSleep(new Uint8Array(withEnd(header(0), start + 20 * 60)))).toEqual([]); // 20 min
        const old = 0x1c000000; // 2015
        expect(decodeSleep(new Uint8Array(withEnd(header(0, old), old + 7 * 3600)))).toEqual([]);
        expect(decodeSleep(new Uint8Array(withEnd(header(0), start - 100)))).toEqual([]); // fin antes del inicio
      });
    });

    it('relleno o basura entre sesiones: se resincroniza con la firma af fa y no se pierde la siguiente', () => {
      const start = 0x31def01c;
      const first = [...header(1), ...seg(0xf2, start, 1800)];
      const second = [...header(1, start + 40_000), ...seg(0xf1, start + 40_000, 900)];
      const notes: string[] = [];
      const sessions = decodeSleep(new Uint8Array([...first, 0, 0, 0, 0, ...second]), notes);
      expect(sessions.map((s) => s.segments.map((g) => g.stage))).toEqual([['light'], ['deep']]);
      expect(notes).toEqual(['sueño: 4 byte(s) fuera de una sesión omitidos al resincronizar con la firma af fa']);
    });

    it('si el anillo no escribe la firma af fa (banderas distintas), la noche se decodifica por longitud en vez de perderse', () => {
      const start = 0x31def01c;
      const flagged = (hdr: number[]): number[] => [0x00, 0x00, ...hdr.slice(2)];
      const buf = new Uint8Array([
        ...flagged(header(2)),
        ...seg(0xf2, start, 1800),
        ...seg(0xf1, start + 1800, 900),
        ...flagged(header(1, start + 40_000)),
        ...seg(0xf3, start + 40_000, 600),
      ]);
      const notes: string[] = [];
      const sessions = decodeSleep(buf, notes);
      expect(sessions.map((s) => s.segments.map((g) => g.stage))).toEqual([['light', 'deep'], ['rem']]);
      expect(notes).toEqual(['sueño: el registro no trae la firma af fa de sesión: se ha decodificado por longitud']);
    });

    it('con firma, la resincronización sigue ahí (no se decodifica basura como si fuera una sesión)', () => {
      const start = 0x31def01c;
      const buf = new Uint8Array([0, 0, 0, 0, ...header(1), ...seg(0xf2, start, 1800)]);
      const notes: string[] = [];
      expect(decodeSleep(buf, notes)).toHaveLength(1);
      expect(notes.join(' ')).toMatch(/resincronizar/);
      expect(notes.join(' ')).not.toMatch(/por longitud/);
    });

    it('una longitud de registro que no cuadra no hace que la sesión siguiente salga con un inicio absurdo', () => {
      const start = 0x31def01c;
      const broken = header(1);
      broken[2] = 12; // anuncia 12 bytes en vez de 28: el cursor caería a mitad de registro
      broken[3] = 0;
      const buf = new Uint8Array([...broken, ...seg(0xf2, start, 1800), ...header(1, start + 40_000), ...seg(0xf1, start + 40_000, 900)]);
      const sessions = decodeSleep(buf);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.segments.map((g) => g.stage)).toEqual(['deep']);
      expect(sessions[0]?.startMs).toBeGreaterThan(Date.UTC(2020, 0, 1)); // nada del año 2000
    });

    it('una cabecera con inicio 0 no arrastra la sesión al año 2000: manda lo que dicen los tramos', () => {
      const start = 0x31def01c;
      const buf = new Uint8Array([...header(1, 0), ...seg(0xf2, start, 600)]);
      const s = decodeSleep(buf)[0];
      expect((s?.endMs ?? 0) - (s?.startMs ?? 0)).toBe(600_000);
    });

    it('una cabecera incoherente (fin ≤ inicio) usa los tramos para fijar la sesión', () => {
      const buf = new Uint8Array([...header(1), ...seg(0xf2, 0x31def01c, 600)]);
      const s = decodeSleep(buf)[0];
      expect((s?.endMs ?? 0) - (s?.startMs ?? 0)).toBe(600_000);
    });
  });
});

describe('decodeInto: una transferencia enorme no desborda la pila (un otro extremo hostil o roto puede mandarla)', () => {
  it('300 000 registros de pulso entran sin RangeError (antes, push(...lista) lo lanzaba con más de ~125 000)', () => {
    const count = 300_000;
    const buffer = new Uint8Array(count * 6);
    for (let i = 0; i < count; i++) {
      new DataView(buffer.buffer).setUint32(i * 6, 836_694_044 + i, true);
      buffer[i * 6 + 5] = 60 + (i % 40);
    }
    const into: HistoryRecords = { sport: [], sleep: [], heart: [], all: [], spo2: [] };
    const summary = decodeInto(HISTORY.heart, buffer, into);
    expect(summary.records).toBe(count);
    expect(into.heart).toHaveLength(count);
  });
});

describe('cambio de hora: el reloj del anillo no salta, así que lo que dura un registro es lo que dice el anillo', () => {
  /** Segundos del anillo de una hora de pared (el anillo cuenta en hora local, sin saber de horario de verano). */
  const wall = (y: number, m: number, d: number, h: number, min = 0): number => Date.UTC(y, m - 1, d, h, min) / 1000 - 946_684_800;
  const u32le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  /** Una sesión del anillo: cabecera de 20 B (inicio y fin) y un tramo de 8 B por cada fase, uno detrás de otro. */
  function night(startSec: number, endSec: number, stages: Array<[tag: number, hours: number]>): Uint8Array {
    const length = 20 + stages.length * 8;
    const out: number[] = [0xaf, 0xfa, length & 0xff, length >> 8, ...u32le(startSec), ...u32le(endSec), ...new Array(8).fill(0xff)];
    let at = startSec;
    for (const [tag, hours] of stages) {
      const seconds = hours * 3600;
      out.push(tag, ...u32le(at), seconds & 0xff, (seconds >> 8) & 0xff, (seconds >> 16) & 0xff);
      at += seconds;
    }
    return new Uint8Array(out);
  }
  const stages: Array<[number, number]> = [[0xf2, 4], [0xf1, 2], [0xf3, 2]]; // 4 h ligero, 2 h profundo, 2 h REM

  it('una noche de 23:00 a 07:00 que cruza el cambio de HORARIO DE VERANO (28-mar-2027) dura sus 8 h y las fases encajan', () => {
    const [session] = decodeSleep(night(wall(2027, 3, 27, 23), wall(2027, 3, 28, 7), stages));
    expect(session).toBeDefined();
    expect(((session?.endMs ?? 0) - (session?.startMs ?? 0)) / 3_600_000).toBe(8);
    // Los tramos van seguidos, sin solaparse ni dejar huecos.
    const segs = session?.segments ?? [];
    expect(segs.map((g) => g.durationSec / 3600)).toEqual([4, 2, 2]);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startMs).toBe(segs[i - 1]!.startMs + segs[i - 1]!.durationSec * 1000);
    // Y la noche llega entera al almacén (antes `sanitize` la descartaba: 8 h de fases frente a 7 h de tramo).
    const records = { sport: [], sleep: session ? [session] : [], heart: [], all: [], spo2: [] };
    const rows = sanitizeHistory(records, new Date(2027, 2, 28, 9, 0).getTime());
    expect(rows.sleep).toHaveLength(1);
    expect(rows.dropped).toEqual({});
  });

  it('y la que cruza el de INVIERNO (25-oct-2026) dura 8 h, no 9', () => {
    const [session] = decodeSleep(night(wall(2026, 10, 24, 23), wall(2026, 10, 25, 7), stages));
    expect(((session?.endMs ?? 0) - (session?.startMs ?? 0)) / 3_600_000).toBe(8);
    const records = { sport: [], sleep: session ? [session] : [], heart: [], all: [], spo2: [] };
    expect(sanitizeHistory(records, new Date(2026, 9, 25, 9, 0).getTime()).sleep).toHaveLength(1);
  });

  it('sin cambio de hora el resultado es el de siempre: 23:00 → 07:00 de pared', () => {
    const [session] = decodeSleep(night(wall(2026, 7, 8, 23), wall(2026, 7, 9, 7), stages));
    const start = new Date(session?.startMs ?? 0);
    const end = new Date(session?.endMs ?? 0);
    expect([start.getHours(), end.getHours()]).toEqual([23, 7]);
  });

  it('un tramo de actividad que cae a ambos lados del cambio de hora conserva su duración (15 min)', () => {
    const record = (startSec: number, endSec: number): Uint8Array => new Uint8Array([...u32le(startSec), ...u32le(endSec), 0x40, 0x01, 0x20, 0x00, 0x10, 0x00]);
    for (const [startSec, endSec] of [
      [wall(2027, 3, 28, 1, 50), wall(2027, 3, 28, 2, 5)], // primavera: las 02:xx no existen
      [wall(2026, 10, 25, 2, 50), wall(2026, 10, 25, 3, 5)], // invierno: las 02:xx existen dos veces
      [wall(2026, 10, 25, 2, 30), wall(2026, 10, 25, 3, 0)],
    ] as const) {
      const [r] = decodeSport(record(startSec, endSec));
      expect(((r?.endMs ?? 0) - (r?.startMs ?? 0)) / 1000, `${startSec}→${endSec}`).toBe(endSec - startSec);
    }
  });
});

describe('el simulador escribe lo que el decodificador lee, también el día del cambio de hora', () => {
  // El anillo simulado alimenta el modo demostración y toda la suite e2e: si escribiera cada extremo con la hora de pared por separado,
  // el día del cambio de hora la noche saldría con fases que suman más que su duración y se descartaría en cada sincronización.
  const nightOf = (start: Date, end: Date): SleepSession => {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const total = (endMs - startMs) / 1000;
    const light = Math.round(total * 0.5);
    const deep = Math.round(total * 0.25);
    return {
      startMs,
      endMs,
      segments: [
        { stage: 'light', startMs, durationSec: light },
        { stage: 'deep', startMs: startMs + light * 1000, durationSec: deep },
        { stage: 'rem', startMs: startMs + (light + deep) * 1000, durationSec: total - light - deep },
      ],
    };
  };

  it.each([
    ['de invierno (25-oct-2026): de las 23:00 a las 07:00 de pared hay 9 h reales', new Date(2026, 9, 24, 23), new Date(2026, 9, 25, 7), 9],
    ['de verano (28-mar-2027): de las 23:00 a las 07:00 de pared hay 7 h reales', new Date(2027, 2, 27, 23), new Date(2027, 2, 28, 7), 7],
    ['(ninguno): 8 h', new Date(2026, 6, 8, 23), new Date(2026, 6, 9, 7), 8],
  ])('una noche que cruza el cambio de hora %s hace el viaje completo y llega entera', (_name, start, end, hours) => {
    const session = nightOf(start, end);
    const [back] = decodeSleep(encodeSleep([session]));
    expect(back).toMatchObject(session);
    expect(((back?.endMs ?? 0) - (back?.startMs ?? 0)) / 3_600_000).toBe(hours);
    const rows = sanitizeHistory({ sport: [], sleep: back ? [back] : [], heart: [], all: [], spo2: [] }, end.getTime() + 2 * 3_600_000);
    expect(rows.sleep).toHaveLength(1);
    expect(rows.dropped).toEqual({});
  });

  it('un tramo de actividad entre la primera y la segunda vez que son las 02:xx (invierno) conserva sus 15 min', () => {
    const startMs = Date.UTC(2026, 9, 25, 0, 50); // 02:50 de verano
    const endMs = Date.UTC(2026, 9, 25, 1, 5); // 02:05 de invierno
    const [r] = decodeSport(encodeSport([{ startMs, endMs, steps: 300, distanceM: 200, calories: 16 }]));
    expect(((r?.endMs ?? 0) - (r?.startMs ?? 0)) / 1000).toBe(900);
  });
});
