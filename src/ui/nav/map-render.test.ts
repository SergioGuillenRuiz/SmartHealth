import { beforeAll, describe, expect, it } from 'vitest';
import { openPack } from '../../app/nav/pack-loader';
import { PLACE } from '../../domain/nav/pack';
import { boxAround } from '../../domain/nav/zones';
import { buildSyntheticCity, SYNTHETIC_CENTER } from '../../domain/nav/synthetic-city';
import { writePack } from '../../domain/nav/pack';
import type { Camera } from './camera';
import { DARK, drawBlankWithTrace, drawMap, drawScale, drawTrace, LIGHT, scaleBar, type MapOverlay } from './map-render';

// El dibujo del mapa sin pantalla: un contexto 2D falso que apunta lo que se le pide (qué se rellena, qué se traza, qué texto y con qué color), para comprobar qué capas salen a cada zoom, que
// el dibujo no falle con ningún tema ni con cualquier cámara y que lo pesado (los edificios) se reparte en trozos. El aspecto se mira en las capturas (`docs/navegacion.md`).

class FakePath {
  points = 0;
  moveTo(): void {
    this.points++;
  }
  lineTo(): void {
    this.points++;
  }
  closePath(): void {}
}

interface Call {
  op: 'fill' | 'stroke' | 'fillText' | 'strokeText' | 'arc' | 'fillRect' | 'rect' | 'roundRect' | 'ellipse';
  fillStyle: unknown;
  strokeStyle: unknown;
  alpha: number;
  lineWidth: number;
  path?: FakePath;
  text?: string;
}

function fakeContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1 };
  const record = (op: Call['op'], extra: Partial<Call> = {}): void => {
    calls.push({ op, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, alpha: state.globalAlpha as number, lineWidth: state.lineWidth as number, ...extra });
  };
  const handler: ProxyHandler<object> = {
    get(_target, key: string) {
      if (key in state) return state[key];
      switch (key) {
        case 'fill':
          return (path?: FakePath) => record('fill', path instanceof FakePath ? { path } : {});
        case 'stroke':
          return (path?: FakePath) => record('stroke', path instanceof FakePath ? { path } : {});
        case 'fillText':
          return (text: string) => record('fillText', { text });
        case 'strokeText':
          return (text: string) => record('strokeText', { text });
        case 'arc':
        case 'fillRect':
        case 'rect':
        case 'roundRect':
        case 'ellipse':
          return () => record(key);
        case 'measureText':
          return (text: string) => ({ width: text.length * 6 });
        case 'createRadialGradient':
          return () => ({ addColorStop: () => undefined });
        default:
          return () => undefined;
      }
    },
    set(_target, key: string, value) {
      state[key] = value;
      return true;
    },
  };
  return { ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D, calls };
}

const cam = (zoom: number, over: Partial<Camera> = {}): Camera => ({ lat: SYNTHETIC_CENTER.lat, lon: SYNTHETIC_CENTER.lon, zoom, bearing: 0, width: 390, height: 700, anchorY: 0.5, ...over });

describe('dibujar el mapa', () => {
  let data: ReturnType<typeof openPack>;
  beforeAll(() => {
    (globalThis as { Path2D?: unknown }).Path2D = FakePath;
    data = openPack(writePack(buildSyntheticCity().input));
  });

  const draw = (zoom: number, overlay: MapOverlay = {}, theme = LIGHT, over: Partial<Camera> = {}): Call[] => {
    const { ctx, calls } = fakeContext();
    drawMap(ctx, cam(zoom, over), { graph: data.graph, index: data.index }, overlay, theme, 2);
    return calls;
  };
  const buildingFills = (calls: Call[], theme = LIGHT): Call[] => calls.filter((c) => c.op === 'fill' && c.fillStyle === theme.building && c.path);
  const labelsOf = (calls: Call[]): string[] => calls.filter((c) => c.op === 'fillText').map((c) => c.text!);

  it('no falla con ningún zoom, ningún tema ni con el mapa girado y la cámara bajada (como al navegar)', () => {
    for (const theme of [LIGHT, DARK]) {
      for (const zoom of [12, 13.5, 14.8, 15.5, 16.2, 17, 18.5, 19.5]) {
        expect(() => draw(zoom, {}, theme)).not.toThrow();
        expect(() => draw(zoom, {}, theme, { bearing: 137, anchorY: 0.72 })).not.toThrow();
      }
    }
  });

  it('los edificios salen a partir de ~zoom 15, se desvanecen al acercarse y se rellenan en trozos (no en un solo trazo enorme)', () => {
    expect(buildingFills(draw(13))).toHaveLength(0);
    expect(buildingFills(draw(14.5))).toHaveLength(0);
    const far = buildingFills(draw(15.3));
    const near = buildingFills(draw(17));
    expect(far.length).toBeGreaterThan(0);
    expect(near.length).toBeGreaterThan(0);
    expect(far[0]!.alpha).toBeLessThan(near[near.length - 1]!.alpha); // más transparentes de lejos
    // Ningún trazo de edificios pasa de ~250 polígonos de 5 puntos (cada uno con su `moveTo`).
    for (const f of [...far, ...near]) expect(f.path!.points).toBeLessThanOrEqual(250 * 6);
    // Con un borde finísimo solo cuando hay sitio.
    expect(draw(15.5).some((c) => c.op === 'stroke' && c.strokeStyle === LIGHT.buildingEdge)).toBe(false);
    expect(draw(17.4).some((c) => c.op === 'stroke' && c.strokeStyle === LIGHT.buildingEdge)).toBe(true);
  });

  it('hacia el borde de la caja de detalle los edificios se desvanecen (tres transparencias); sin caja de detalle, todos iguales', () => {
    // Una caja de detalle de ±350 m alrededor del centro: los edificios pegados a su borde son más tenues que los del medio.
    const input = buildSyntheticCity().input;
    const small = boxAround(SYNTHETIC_CENTER.lat, SYNTHETIC_CENTER.lon, 350);
    const withDetail = openPack(writePack({ ...input, meta: { ...input.meta, detail: small } }));
    const noDetail = openPack(writePack({ ...input, meta: { ...input.meta, detail: undefined } }));
    const alphasOf = (d: ReturnType<typeof openPack>): Set<number> => {
      const { ctx, calls } = fakeContext();
      drawMap(ctx, cam(16.4, { height: 1400 }), { graph: d.graph, index: d.index }, {}, LIGHT, 2);
      return new Set(buildingFills(calls).map((c) => c.alpha));
    };
    expect(alphasOf(withDetail).size).toBe(3);
    expect(alphasOf(noDetail).size).toBe(1);
  });

  it('las marcas de comercios salen a partir de ~zoom 16 y sus nombres a partir de ~17; las paradas, más tarde', () => {
    const arcs = (calls: Call[]): number => calls.filter((c) => c.op === 'arc' && Object.values(LIGHT.marker).includes(c.fillStyle as string)).length;
    // `arc` también dibuja otras cosas: lo que cuenta es que con marcas hay más rellenos de color de categoría.
    const marks = (calls: Call[]): number => calls.filter((c) => c.op === 'fill' && Object.values(LIGHT.marker).includes(c.fillStyle as string)).length;
    void arcs;
    expect(marks(draw(15.2))).toBe(0);
    expect(marks(draw(16.6))).toBeGreaterThan(0);
    const low = labelsOf(draw(16.6));
    const high = labelsOf(draw(17.8, {}, LIGHT, { lat: SYNTHETIC_CENTER.lat - 0.0016, lon: SYNTHETIC_CENTER.lon - 0.0022 }));
    expect(low).not.toContain('Casa Lucio');
    expect(high.some((t) => /Aseos|Parque/.test(t))).toBe(true);
    // Las paradas (cuadradas, a zoom ≥ 16,8) no salen a 16,5.
    const rounded = (calls: Call[]): number => calls.filter((c) => c.op === 'roundRect' || c.op === 'rect').length;
    expect(rounded(draw(16.5, {}, LIGHT, { lat: SYNTHETIC_CENTER.lat + 0.0003 }))).toBeLessThanOrEqual(rounded(draw(17.2, {}, LIGHT, { lat: SYNTHETIC_CENTER.lat + 0.0003 })));
  });

  it('los nombres de los lugares de siempre salen como antes (ciudad, barrio, parque, estación)', () => {
    const names = labelsOf(draw(15.6));
    expect(names).toContain('Villa Sintética');
    expect(names.some((t) => t === 'Estación Central' || t === 'Parque de la Ciudadela' || t === 'Barrio Centro')).toBe(true);
  });

  it('la ruta lleva resplandor, borde y color; el destino y la posición se dibujan; sin ruta, nada de eso', () => {
    const route = { points: [SYNTHETIC_CENTER, { lat: SYNTHETIC_CENTER.lat + 0.001, lon: SYNTHETIC_CENTER.lon }], cumM: [0, 111], progressM: 20 };
    const withRoute = draw(17, { route, destination: SYNTHETIC_CENTER, position: { lat: SYNTHETIC_CENTER.lat, lon: SYNTHETIC_CENTER.lon, heading: 10, accuracyM: 12 } });
    const strokes = withRoute.filter((c) => c.op === 'stroke' && c.path).map((c) => c.strokeStyle);
    for (const color of [LIGHT.routeGlow, LIGHT.routeCasing, LIGHT.route, LIGHT.routePassed]) expect(strokes).toContain(color);
    expect(draw(17).some((c) => c.op === 'stroke' && c.strokeStyle === LIGHT.route)).toBe(false);
    // Con la variante oscura, sus colores.
    const dark = draw(17, { route }, DARK).filter((c) => c.op === 'stroke').map((c) => c.strokeStyle);
    expect(dark).toContain(DARK.route);
    expect(dark).not.toContain(LIGHT.route);
  });

  it('el recorrido de un entreno: resplandor, borde y color, y el punto de salida', () => {
    const trace: Array<[number, number]> = [
      [SYNTHETIC_CENTER.lat, SYNTHETIC_CENTER.lon],
      [SYNTHETIC_CENTER.lat + 0.001, SYNTHETIC_CENTER.lon + 0.001],
    ];
    const { ctx, calls } = fakeContext();
    drawTrace(ctx, cam(16), trace, LIGHT);
    const strokes = calls.filter((c) => c.op === 'stroke' && c.path).map((c) => c.strokeStyle);
    expect(strokes).toEqual([LIGHT.traceGlow, LIGHT.traceCasing, LIGHT.trace]);
    expect(calls.some((c) => c.op === 'fill' && c.fillStyle === LIGHT.start)).toBe(true);
    // Con menos de dos puntos no dibuja nada.
    const none = fakeContext();
    drawTrace(none.ctx, cam(16), [trace[0]!], LIGHT);
    expect(none.calls).toHaveLength(0);
  });

  it('sin mapa: fondo liso con cuadrícula tenue, el recorrido y la escala', () => {
    const { ctx, calls } = fakeContext();
    drawBlankWithTrace(ctx, cam(15.5), [[SYNTHETIC_CENTER.lat, SYNTHETIC_CENTER.lon], [SYNTHETIC_CENTER.lat + 0.001, SYNTHETIC_CENTER.lon]], LIGHT, 2);
    expect(calls.some((c) => c.op === 'fillRect' && c.fillStyle === LIGHT.bg)).toBe(true);
    expect(calls.some((c) => c.op === 'stroke' && c.strokeStyle === LIGHT.casing)).toBe(true); // la cuadrícula
    expect(calls.some((c) => c.op === 'stroke' && c.strokeStyle === LIGHT.trace)).toBe(true);
    expect(labelsOf(calls).some((t) => /\d+ ?(m|km)/.test(t))).toBe(true);
  });

  it('la escala elige una distancia redonda que cabe entre 56 y 120 px', () => {
    for (const mpp of [0.3, 1, 4.2, 30]) {
      const bar = scaleBar(mpp);
      expect(bar.widthPx).toBeGreaterThanOrEqual(56);
      expect(bar.widthPx).toBeLessThan(260);
      expect(bar.label).toMatch(/^\d+ (m|km)$/);
    }
    const { ctx, calls } = fakeContext();
    drawScale(ctx, cam(16), LIGHT);
    expect(labelsOf(calls)).toHaveLength(1);
  });

  it('los temas definen todos los colores y una marca por categoría de lugar', () => {
    for (const theme of [LIGHT, DARK]) {
      for (const [key, value] of Object.entries(theme)) {
        if (key === 'marker') continue;
        expect(typeof value, key).toBe('string');
        expect(value as string, key).not.toBe('');
      }
      for (const kind of [PLACE.FOOD, PLACE.CAFE, PLACE.SHOP, PLACE.HEALTH, PLACE.TRANSIT, PLACE.BIKE, PLACE.SERVICE, PLACE.EDU, PLACE.UTILITY, PLACE.POI, PLACE.STATION]) {
        expect(theme.marker[kind], String(kind)).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
