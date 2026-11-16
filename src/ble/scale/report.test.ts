import { describe, expect, it } from 'vitest';
import type { ScaleDecoder, ScaleFrame } from '../../domain/scale';
import { buildScaleReport, type ScaleReportInput } from './report';

const decoder: ScaleDecoder = { v: 1, source: 'n:ffe0/ffe1', length: 6, kind: 'uint', offset: 3, width: 2, little: false, divisor: 1, guard: [[0, 0xa5]], index: 0 };
const frame = (atMs: number, bytes: number[], source = 'n:ffe0/ffe1'): ScaleFrame => ({ source, bytes: Uint8Array.from(bytes), atMs });
const base = (over: Partial<ScaleReportInput> = {}): ScaleReportInput => ({
  appBuild: 'prueba',
  nowMs: Date.UTC(2026, 10, 1, 12, 0, 0),
  device: { id: 'AA:BB:CC:DD:EE:FF', name: 'RENPHO-SCALE' },
  advert: { id: 'AA:BB:CC:DD:EE:FF', name: 'RENPHO-SCALE', rssi: -51, services: ['ffe0'], manufacturer: { ffff: 'aa bb 01' }, serviceData: {}, raw: '02 01 06', atMs: 0 },
  details: { gatt: [{ service: '0000ffe0-0000-1000-8000-00805f9b34fb', characteristics: [{ uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', properties: ['notify'] }] }], mtu: 185, rssi: -50 },
  subscribed: ['ffe0/ffe1'],
  frames: [frame(1_000, [0xa5, 0x01, 0x04, 0x00, 0x00, 0x00]), frame(1_100, [0xa5, 0x01, 0x04, 0x01, 0x63, 0x01]), frame(1_200, [0xa5, 0x01, 0x04, 0x01, 0x63, 0x01])],
  decoder: null,
  candidates: [],
  labels: [],
  notes: [],
  ...over,
});

describe('buildScaleReport', () => {
  it('lleva el dispositivo, su anuncio, la tabla GATT y las tramas distintas con cuántas veces llegó cada una', () => {
    const text = buildScaleReport(base());
    expect(text).toContain('RENPHO-SCALE · AA:BB:CC:DD:EE:FF');
    expect(text).toContain('Datos de fabricante ffff: aa bb 01');
    expect(text).toContain('0000ffe1-0000-1000-8000-00805f9b34fb  notify');
    expect(text).toContain('Suscrito a: ffe0/ffe1');
    expect(text).toContain('# n:ffe0/ffe1 · 6 bytes: 3 tramas, 2 distintas');
    expect(text).toMatch(/\+\s+0 ms\s+×1\s+a5 01 04 00 00 00/);
    expect(text).toMatch(/\+\s+100 ms\s+×2\s+a5 01 04 01 63 01/);
    expect(text).toContain('Aún no hay decodificador.');
  });

  it('dice lo aprendido y lo que marcaba la pantalla; sin candidatos, el motivo', () => {
    const learned = buildScaleReport(
      base({ decoder, labels: [{ value: 355, atMs: 1_150 }], candidates: [{ decoder, matched: 1, distinct: 2, rank: 1010 }] }),
    );
    expect(learned).toContain('Decodificador guardado: n:ffe0/ffe1 · tramas de 6 bytes · bytes 3–4 (big-endian)');
    expect(learned).toContain('355 g (a los +150 ms)');
    expect(learned).toContain('1010 · n:ffe0/ffe1');
    expect(buildScaleReport(base({ problem: 'no cuadra ningún campo' }))).toContain('Sin candidatos: no cuadra ningún campo');
  });

  it('con muchísimas tramas distintas enseña las primeras y las últimas, y todo el informe tiene un tope', () => {
    const many = Array.from({ length: 500 }, (_, i) => frame(i * 10, [0xa5, i >> 8, i & 0xff, 0, 0, 0]));
    const text = buildScaleReport(base({ frames: many }));
    expect(text).toContain('500 tramas, 500 distintas');
    expect(text).toContain('  …');
    expect(text.split('\n').length).toBeLessThan(200);
    const huge = buildScaleReport(base({ frames: many, notes: Array.from({ length: 800 }, (_, i) => `nota ${i}`) }));
    expect(huge).toContain('líneas más recortadas');
    expect(huge.split('\n').length).toBeLessThanOrEqual(602);
  });

  it('sin conexión ni dispositivo no falla', () => {
    const text = buildScaleReport(base({ device: null, advert: null, details: null, subscribed: [], frames: [] }));
    expect(text).toContain('(ninguno elegido)');
    expect(text).toContain('(sin conexión: no se pudo leer)');
  });
});
