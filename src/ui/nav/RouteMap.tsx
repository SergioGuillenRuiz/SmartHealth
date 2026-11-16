import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { loadMapForRoute } from '../../app/nav/navigator';
import type { NavData } from '../../app/nav/pack-loader';
import { routeBounds, type RoutePoint } from '../../domain/route-trace';
import { metersPerPixel } from '../../domain/nav/geo';
import { fitPoints, type Camera } from './camera';
import { DARK, drawBlankWithTrace, drawMap, drawScale, LIGHT } from './map-render';

// El recorrido de un entreno ya hecho, dibujado al revisarlo: sobre el mapa de la zona si ya está guardada en el móvil (la que se bajó al navegar por allí) y, si no, sobre un fondo liso con
// la escala. No baja nada. Es una imagen: no se arrastra ni se acerca (es un resumen, como la gráfica de pulso de al lado).

const isDark = (): boolean => {
  if (typeof document === 'undefined') return false;
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
};

export function RouteMap({ route, label }: { route: readonly RoutePoint[]; label: string }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<NavData | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // El mapa de fondo, si hay uno guardado que cubra el recorrido.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    void loadMapForRoute(route).then((found) => {
      if (!cancelled) setData(found);
    });
    return () => {
      cancelled = true;
    };
  }, [route]);

  useEffect(() => {
    const host = box.current;
    if (!host) return undefined;
    const measure = (): void => setSize({ w: Math.max(1, Math.round(host.clientWidth)), h: Math.max(1, Math.round(host.clientHeight)) });
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    const bounds = routeBounds(route);
    if (!el || !ctx || !bounds || size.w === 0) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const corners = [
      { lat: bounds.minLat, lon: bounds.minLon },
      { lat: bounds.maxLat, lon: bounds.maxLon },
    ];
    // La chincheta de la llegada sobresale ~36 px por encima de su punto: se deja ese margen arriba para que no se corte si es lo más al norte.
    const first = fitPoints(corners, size.w, size.h, 34);
    const headroomDeg = (38 * metersPerPixel(first.lat, first.zoom)) / 111_195;
    const fit = fitPoints([...corners, { lat: bounds.maxLat + headroomDeg, lon: first.lon }], size.w, size.h, 34);
    const cam: Camera = { ...fit, bearing: 0, width: size.w, height: size.h, anchorY: 0.5 };
    const theme = isDark() ? DARK : LIGHT;
    if (data) {
      drawMap(ctx, cam, { graph: data.graph, index: data.index }, { trace: route }, theme, dpr);
      drawScale(ctx, cam, theme);
    } else {
      drawBlankWithTrace(ctx, cam, route, theme, dpr);
    }
  }, [route, data, size.w, size.h]);

  return (
    <div class="routemap" ref={box}>
      <canvas ref={canvas} class="routemap__canvas" role="img" aria-label={label} />
      {data && <p class="navmap__credit">© OpenStreetMap</p>}
    </div>
  );
}
