import { describe, expect, it } from 'vitest';
import { fmtSpan, MIN_REPORT_MS, phoneRisk, recoveryCause, reportScreenOff, type ScreenOffFacts, type ServiceFacts } from './screen-off-report';

const FROM = 1_000_000;
const MIN = 60_000;

/** Una marca por cada `everyMs` entre dos instantes (ambos incluidos). */
const every = (everyMs: number, fromMs: number, toMs: number): number[] => {
  const out: number[] = [];
  for (let t = fromMs; t <= toMs; t += everyMs) out.push(t);
  return out;
};
const ticksOf = (stamps: number[], lagMs = 100) => stamps.map((nowMs) => ({ nowMs, arrivedMs: nowMs + lagMs }));
const service = (over: Partial<ServiceFacts> = {}): ServiceFacts => ({ running: true, batteryExempt: true, ...over });

/** Seis minutos con todo en orden: una posición por segundo, una lectura de pulso cada 35 s y un aviso nativo cada 2 s. */
function healthy(over: Partial<ScreenOffFacts> = {}): ScreenOffFacts {
  const toMs = FROM + 6 * MIN;
  return {
    fromMs: FROM,
    toMs,
    gpsMs: every(1000, FROM + 500, toMs),
    pulseMs: every(35_000, FROM + 10_000, toMs),
    ticks: ticksOf(every(2000, FROM + 1000, toMs)),
    service: service(),
    reflex: { stalls: 0, writes: 0, failed: 0 },
    ringDownAtMs: null,
    ...over,
  };
}

describe('reportScreenOff: qué se perdió con la pantalla apagada', () => {
  it('un tramo corto (un vistazo a otra app) no se comenta', () => {
    expect(reportScreenOff(healthy({ toMs: FROM + MIN_REPORT_MS - 1 }))).toBeNull();
    expect(reportScreenOff(healthy({ toMs: FROM + MIN_REPORT_MS }))).not.toBeNull();
  });

  it('con todo en orden no hay problema y las cifras quedan para la traza', () => {
    const report = reportScreenOff(healthy())!;
    expect(report.problem).toBe(false);
    expect(report.message).toBe('');
    expect(report.technical).toContain('apagada 6 min');
    expect(report.technical).toContain('GPS 360/360');
    expect(report.technical).toContain('servicio sí');
  });

  it('el GPS que se calla a los 90 s: dice cuántas posiciones llegaron, el mayor hueco y qué mirar', () => {
    const toMs = FROM + 6 * MIN;
    const report = reportScreenOff(healthy({ gpsMs: every(1000, FROM + 500, FROM + 90_000), service: service({ batteryExempt: false }) }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('el GPS dio 90 de 360 posiciones');
    expect(report.message).toContain(`el mayor hueco, ${fmtSpan(toMs - (FROM + 89_500))}`);
    expect(report.message).toContain('Sin restricciones');
    expect(report.technical).toContain('GPS 90/360');
  });

  it('un hueco de 90 s en medio cuenta aunque llegaran más de la mitad de las posiciones; uno de 20 s no', () => {
    const toMs = FROM + 6 * MIN;
    const withGap = (gapMs: number) => [...every(1000, FROM + 500, FROM + 3 * MIN), ...every(1000, FROM + 3 * MIN + gapMs, toMs)];
    const long = reportScreenOff(healthy({ gpsMs: withGap(90_000) }))!;
    expect(long.problem).toBe(true);
    expect(long.message).toMatch(/el GPS dio \d+ de 360 posiciones \(el mayor hueco, 1 min 3\d s\)/);
    expect(reportScreenOff(healthy({ gpsMs: withGap(20_000) }))!.problem).toBe(false);
  });

  it('ni una posición con el GPS esperado: «no dio ninguna»', () => {
    const report = reportScreenOff(healthy({ gpsMs: [] }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('el GPS no dio ninguna posición');
  });

  it('el pulso sin ninguna lectura, o con un hueco de más de dos minutos, es un problema; con una lectura cada 35 s no', () => {
    const none = reportScreenOff(healthy({ pulseMs: [] }))!;
    expect(none.problem).toBe(true);
    expect(none.message).toContain('no llegó ninguna lectura de pulso');
    const gap = reportScreenOff(healthy({ pulseMs: [...every(35_000, FROM + 10_000, FROM + 80_000), ...every(35_000, FROM + 5 * MIN, FROM + 6 * MIN)] }))!;
    expect(gap.problem).toBe(true);
    expect(gap.message).toMatch(/el pulso tuvo un hueco de 3 min/);
    expect(reportScreenOff(healthy())!.problem).toBe(false);
  });

  it('el móvil que congela la app entera se nota en el hueco entre los avisos nativos y se dice con el consejo de Xiaomi', () => {
    const toMs = FROM + 6 * MIN;
    const ticks = ticksOf([...every(2000, FROM + 1000, FROM + 60_000), ...every(2000, FROM + 5 * MIN, toMs)]);
    const report = reportScreenOff(healthy({ ticks, gpsMs: [], pulseMs: [] }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('el móvil dejó la app congelada 4 min');
    expect(report.message).toContain('Inicio automático');
    expect(report.message).toContain('Recientes');
  });

  it('con los avisos numerados: el hueco con la numeración seguida es el móvil congelado; con la numeración saltando, avisos perdidos por el camino', () => {
    const toMs = FROM + 6 * MIN;
    const early = every(2000, FROM + 1000, FROM + 60_000); // 30 avisos, del 1 al 30
    const late = every(2000, FROM + 5 * MIN, toMs); // 31 avisos
    const numbered = (from: number, stamps: number[]) => stamps.map((nowMs, i) => ({ nowMs, arrivedMs: nowMs + 100, n: from + i }));
    // El móvil no generó avisos entre medias: la numeración sigue (31, 32…).
    const frozen = reportScreenOff(healthy({ ticks: [...numbered(1, early), ...numbered(31, late)], gpsMs: [], pulseMs: [] }))!;
    expect(frozen.message).toContain('el móvil dejó la app congelada');
    expect(frozen.technical).not.toContain('avisos perdidos');
    // Los generó y la web no los recibió: la numeración salta (31 → 180).
    const lost = reportScreenOff(healthy({ ticks: [...numbered(1, early), ...numbered(180, late)], gpsMs: [], pulseMs: [] }))!;
    expect(lost.problem).toBe(true);
    expect(lost.message).toContain('no recibió 149 avisos del lado nativo');
    expect(lost.message).not.toContain('congelada');
    expect(lost.technical).toContain('149 avisos perdidos');
  });

  it('avisos perdidos son un problema aunque el GPS y el pulso se recuperaran (la web no es de fiar con la pantalla apagada)', () => {
    const toMs = FROM + 6 * MIN;
    const numbered = (from: number, stamps: number[]) => stamps.map((nowMs, i) => ({ nowMs, arrivedMs: nowMs + 100, n: from + i }));
    const ticks = [...numbered(1, every(2000, FROM + 1000, FROM + 60_000)), ...numbered(180, every(2000, FROM + 5 * MIN, toMs))];
    const report = reportScreenOff(healthy({ ticks }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('no recibió');
  });

  it('la web parada pero con todo grabado (los avisos llegan tarde y las posiciones y lecturas están) no es un problema', () => {
    const toMs = FROM + 6 * MIN;
    const report = reportScreenOff(healthy({ ticks: ticksOf(every(2000, FROM + 1000, toMs), 5 * MIN) }))!;
    expect(report.problem).toBe(false);
    expect(report.technical).toContain('web: 5 min de retraso');
  });

  it('si además falta GPS o pulso, dice que la web estuvo parada (y cuánto)', () => {
    const toMs = FROM + 6 * MIN;
    const report = reportScreenOff(healthy({ ticks: ticksOf(every(2000, FROM + 1000, toMs), 2 * MIN), pulseMs: [] }))!;
    expect(report.message).toContain('la parte web de la app estuvo parada 2 min');
    expect(report.message).not.toContain('congelada');
  });

  it('un servicio parado con el entreno en marcha es un problema aunque lo demás llegara', () => {
    const report = reportScreenOff(healthy({ service: service({ running: false }) }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('el servicio que graba el entreno se había parado');
    expect(report.message).toContain('Inicio automático');
  });

  it('el ahorro de batería activado y el permiso de ubicación «solo con la app abierta» se mencionan cuando importan', () => {
    const report = reportScreenOff(healthy({ gpsMs: [], service: service({ powerSave: true, bgLocation: false }) }))!;
    expect(report.message).toContain('ahorro de batería de Android');
    expect(report.message).toContain('Permitir siempre');
    // Sin pérdida de GPS, el consejo del permiso no sale.
    const pulseOnly = reportScreenOff(healthy({ pulseMs: [], service: service({ bgLocation: false }) }))!;
    expect(pulseOnly.message).not.toContain('Permitir siempre');
  });

  it('«Inicio automático» apagado (Xiaomi) es lo primero que se dice, aunque lo único perdido sea el GPS; encendido, solo queda el candado de Recientes', () => {
    const off = reportScreenOff(healthy({ gpsMs: [], service: service({ autostart: false }) }))!;
    expect(off.message).toContain('«Inicio automático» está DESACTIVADO');
    expect(off.technical).toContain('inicio automático no');
    const on = reportScreenOff(healthy({ ticks: ticksOf([...every(2000, FROM + 1000, FROM + 60_000), ...every(2000, FROM + 5 * MIN, FROM + 6 * MIN)]), gpsMs: [], service: service({ autostart: true }) }))!;
    expect(on.message).not.toContain('DESACTIVADO');
    expect(on.message).toContain('bloquea SmartHealth en Recientes');
    expect(on.technical).toContain('inicio automático sí');
  });

  it('el trabajo del mapa que había en marcha al apagarse la pantalla se dice (es lo más pesado que hace la app) y queda en las cifras', () => {
    const report = reportScreenOff(healthy({ gpsMs: [], mapBusy: 'completando el mapa con los edificios y comercios' }))!;
    expect(report.message).toContain('se estaba completando el mapa con los edificios y comercios al apagarse la pantalla');
    expect(report.technical).toContain('mapa: completando el mapa con los edificios y comercios');
    expect(reportScreenOff(healthy({ gpsMs: [], mapBusy: null }))!.message).not.toContain('al apagarse la pantalla');
    // Sin pérdida, el mapa no cambia que todo fuera bien.
    expect(reportScreenOff(healthy({ mapBusy: 'bajando el mapa' }))!.problem).toBe(false);
  });

  it('el anillo que el lado nativo vio caerse dentro del tramo se dice; el de antes del tramo no cuenta', () => {
    const inside = reportScreenOff(healthy({ pulseMs: [], ringDownAtMs: FROM + MIN }))!;
    expect(inside.message).toContain('el anillo se desconectó');
    expect(inside.technical).toContain('anillo caído');
    const before = reportScreenOff(healthy({ ringDownAtMs: FROM - 10 * MIN }))!;
    expect(before.problem).toBe(false);
  });

  it('sin GPS ni pulso esperados (un entreno de móvil solo, o el anillo sin pulso) solo cuenta el servicio', () => {
    expect(reportScreenOff(healthy({ gpsMs: null, pulseMs: null }))!.problem).toBe(false);
    expect(reportScreenOff(healthy({ gpsMs: null, pulseMs: null, service: service({ running: false }) }))!.problem).toBe(true);
  });

  it('lo que llegó fuera del tramo no cuenta como llegado dentro', () => {
    const toMs = FROM + 6 * MIN;
    const outside = [...every(1000, FROM - 120_000, FROM - 1), ...every(1000, toMs + 1, toMs + 120_000)];
    const report = reportScreenOff(healthy({ gpsMs: outside }))!;
    expect(report.problem).toBe(true);
    expect(report.message).toContain('el GPS no dio ninguna posición');
  });

  it('las cifras incluyen el reflejo nativo y cómo está el móvil', () => {
    const report = reportScreenOff(healthy({ reflex: { stalls: 2, writes: 5, failed: 1 }, service: service({ powerSave: false, idle: false, bgRestricted: false, bgLocation: true, bucket: 10 }) }))!;
    expect(report.technical).toContain('reflejo: 2 paradas, 5 órdenes, 1 fallos');
    expect(report.technical).toContain('ahorro no');
    expect(report.technical).toContain('siempre sí');
    expect(report.technical).toContain('cubo 10');
  });
});

describe('fmtSpan', () => {
  it('segundos, minutos y minutos con segundos', () => {
    expect([fmtSpan(45_000), fmtSpan(6 * MIN), fmtSpan(80_000), fmtSpan(0)]).toEqual(['45 s', '6 min', '1 min 20 s', '0 s']);
  });
});

describe('phoneRisk: avisar al empezar de los ajustes que cierran la app con la pantalla apagada', () => {
  it('con el móvil en orden (o sin saber contestar) no dice nada', () => {
    expect(phoneRisk(service())).toBeNull();
    expect(phoneRisk(service({ autostart: true, powerSave: false, bgRestricted: false }))).toBeNull();
  });

  it('el «Inicio automático» apagado, el ahorro de batería y la app restringida se avisan, juntos si hay varios', () => {
    expect(phoneRisk(service({ autostart: false }))).toMatch(/«Inicio automático» está desactivado/);
    expect(phoneRisk(service({ powerSave: true }))).toMatch(/ahorro de batería de Android está activado/);
    expect(phoneRisk(service({ batteryExempt: false }))).toMatch(/Sin restricciones/);
    expect(phoneRisk(service({ bgRestricted: true }))).toMatch(/Sin restricciones/);
    const all = phoneRisk(service({ autostart: false, powerSave: true, batteryExempt: false }))!;
    expect(all).toMatch(/Inicio automático/);
    expect(all).toMatch(/ahorro de batería/);
    expect(all).toMatch(/Sin restricciones/);
  });
});

describe('recoveryCause: por qué se cerró la app a mitad del entreno', () => {
  const start = new Date(2026, 10, 12, 10, 0, 0).getTime();
  const at = new Date(2026, 10, 12, 10, 40, 0).getTime();

  it('el motor web que el sistema mató durante el entreno: lo dice con la hora y la pista del mapa', () => {
    const text = recoveryCause({ renderGoneAt: at, renderGoneCrashed: false }, start)!;
    expect(text).toContain('a las 10:40');
    expect(text).toContain('Android cerró el motor web');
    expect(text).toContain('falta de memoria');
    expect(text).toContain('Navegación guiada');
  });

  it('el que se cayó por un fallo suyo: lo dice sin hablar de memoria', () => {
    const text = recoveryCause({ renderGoneAt: at, renderGoneCrashed: true }, start)!;
    expect(text).toContain('se cayó el motor web');
    expect(text).not.toContain('memoria');
  });

  it('sin anotación, o de antes de empezar el entreno, no dice nada', () => {
    expect(recoveryCause({}, start)).toBeNull();
    expect(recoveryCause({ renderGoneAt: start - 1 }, start)).toBeNull();
    expect(recoveryCause({ renderGoneAt: start }, start)).not.toBeNull();
  });
});
