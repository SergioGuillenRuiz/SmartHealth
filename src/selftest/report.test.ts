import { describe, expect, it } from 'vitest';
import { countStatuses, renderReport, renderSummary, reportFilename, stringify, type SelfTestReport } from './report';

const report = (over: Partial<SelfTestReport> = {}): SelfTestReport => ({
  version: 1,
  app: { build: 'abc1234', builtAt: '2026-10-12T22:00:00.000Z', native: true, demo: false, transport: 'native' },
  startedAtIso: '2026-10-12T21:15:00.000Z',
  startedAtLocal: 'Mon Oct 12 2026 23:15:00 GMT+0200',
  finishedAtIso: '2026-10-12T21:23:00.000Z',
  complete: true,
  cancelled: false,
  phone: { device: { manufacturer: 'Google', model: 'Pixel 8', osVersion: '15', androidSDKVersion: 35, webViewVersion: '130.0.1' } },
  steps: [
    { id: 'env', title: 'Móvil y Bluetooth', status: 'ok', startMs: 0, durationMs: 1200, summary: 'todo activado', data: { platform: { bluetoothEnabled: true } } },
    { id: 'scan', title: 'Buscar el anillo', status: 'warn', startMs: 1300, durationMs: 10_000, summary: 'visto con poca señal', data: { devices: [[1, 2, 3], [4, 5, 6]] } },
    { id: 'connect', title: 'Conectar y saludar', status: 'fail', startMs: 12_000, durationMs: 15_000, summary: 'no conectó' },
    { id: 'sync', title: 'Sincronizar', status: 'skipped', startMs: 27_000, durationMs: 0, summary: 'sin conexión' },
  ],
  timeline: [
    { t: 0, text: 'Inicio de la prueba' },
    { t: 65_432, text: 'Paso «Sincronizar»' },
  ],
  traces: { connect: '   0 ms tx   01 02\n  10 ms rx   03 04', sync: 'una línea' },
  ...over,
});

describe('reportFilename', () => {
  it('lleva la fecha y la hora locales del móvil', () => {
    expect(reportFilename(new Date(2026, 9, 12, 23, 5))).toBe('SmartHealth-prueba-20261012-2305.txt');
    expect(reportFilename(new Date(2026, 0, 3, 7, 0))).toBe('SmartHealth-prueba-20260103-0700.txt');
  });
});

describe('stringify', () => {
  it('pone las listas de números en una sola línea y los objetos con sangría', () => {
    expect(stringify({ a: 1, b: [1, 2, 3], c: { d: 'x' }, e: [] })).toBe('{\n  "a": 1,\n  "b": [1, 2, 3],\n  "c": {\n    "d": "x"\n  },\n  "e": []\n}');
  });

  it('una serie de tuplas se escribe una por línea; una lista muy larga se parte', () => {
    expect(stringify([[1, 2], [3, 4]])).toBe('[[1, 2], [3, 4]]');
    const long = Array.from({ length: 60 }, (_, i) => i * 1000);
    const out = stringify(long);
    expect(out.startsWith('[\n')).toBe(true);
    expect(out.split('\n')).toHaveLength(62);
  });

  it('no escribe lo indefinido y trata null y las cadenas con saltos de línea', () => {
    expect(stringify({ a: undefined, b: null, c: 'a\nb' })).toBe('{\n  "b": null,\n  "c": "a\\nb"\n}');
    expect(stringify(undefined)).toBe('null');
  });
});

describe('resumen e informe', () => {
  it('cuenta los pasos por estado y dice si la prueba está completa, cancelada o incompleta', () => {
    expect(countStatuses(report().steps)).toEqual({ ok: 1, warn: 1, fail: 1, skipped: 1 });
    // Llegar al final con fallos no es «completa»: se dice con claridad.
    expect(renderSummary(report())).toContain('Prueba terminada CON FALLOS: 1 bien, 1 con aviso, 1 con fallo, 1 saltados.');
    const clean = report({ steps: report().steps.filter((step) => step.status === 'ok' || step.status === 'warn') });
    expect(renderSummary(clean)).toContain('Prueba completa: 1 bien, 1 con aviso, 0 con fallo, 0 saltados.');
    expect(renderSummary(report({ cancelled: true, complete: false }))).toContain('Prueba CANCELADA');
    expect(renderSummary(report({ complete: false }))).toContain('Prueba INCOMPLETA');
    expect(renderSummary(report())).toContain('[FALLO  ] Conectar y saludar: no conectó');
  });

  it('el informe lleva cabecera, resumen, datos estructurados, cronología y trazas, por ese orden', () => {
    const text = renderReport(report());
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('SmartHealth · informe de la prueba guiada')).toBe(0);
    expect(text).toContain('app abc1234 (compilada 2026-10-12T22:00:00.000Z) · Android nativo · transporte native');
    expect(text).toContain('Móvil: Google Pixel 8 · Android 15 (SDK 35) · WebView 130.0.1');
    expect(at('RESUMEN')).toBeGreaterThan(0);
    expect(at('DATOS ESTRUCTURADOS (JSON)')).toBeGreaterThan(at('RESUMEN'));
    expect(at('CRONOLOGÍA')).toBeGreaterThan(at('DATOS ESTRUCTURADOS'));
    expect(at('===== TRAZA «connect» (2 líneas) =====')).toBeGreaterThan(at('CRONOLOGÍA'));
    expect(at('===== TRAZA «sync» (1 líneas) =====')).toBeGreaterThan(at('TRAZA «connect»'));
    expect(text.trimEnd().endsWith('===== FIN DEL INFORME =====')).toBe(true);
    // La cronología se lee de arriba abajo con minutos y décimas.
    expect(text).toContain('1:05.4  Paso «Sincronizar»');
    // Los datos van en JSON (con las listas de números en una línea) y las trazas, en crudo, sin escapar.
    expect(text).toContain('"devices": [[1, 2, 3], [4, 5, 6]]');
    expect(text).toContain('   0 ms tx   01 02\n  10 ms rx   03 04');
  });

  it('el bloque JSON es válido y no repite las trazas', () => {
    const text = renderReport(report());
    const block = text.slice(text.indexOf('{\n  "app"'), text.indexOf('\n\nCRONOLOGÍA'));
    const parsed = JSON.parse(block) as { steps: Array<{ id: string; status: string }>; phone: unknown };
    expect(parsed.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['env:ok', 'scan:warn', 'connect:fail', 'sync:skipped']);
    expect(block).not.toContain('01 02');
  });

  it('sin datos del móvil o sin trazas no se rompe', () => {
    const text = renderReport(report({ phone: {}, traces: {} }));
    expect(text).toContain('Móvil: sin datos');
    expect(text).not.toContain('===== TRAZA');
  });
});
