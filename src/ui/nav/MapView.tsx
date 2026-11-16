import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LatLon } from '../../domain/nav/geo';
import type { NavData } from '../../app/nav/pack-loader';
import type { Route } from '../../domain/nav/router';
import { Icon } from '../icons';
import { clampZoom, fitPoints, toLatLon, type Camera } from './camera';
import { DARK, drawMap, LIGHT, type MapOverlay } from './map-render';

// El mapa en pantalla: un canvas con los gestos de siempre (arrastrar, pellizcar para acercar, pulsación larga para poner un destino) y dos formas de mirar: libre (se mueve con el dedo)
// y siguiendo (la cámara va detrás de la posición con el rumbo hacia arriba, como al navegar en Google Maps). Si se arrastra mientras sigue, pasa a libre y sale el botón de centrar.

export interface MapViewProps {
  data: NavData;
  /** Ocupa todo el alto de su contenedor (la pestaña del mapa) en vez de una altura fija. */
  fill?: boolean;
  route: Route | null;
  progressM: number;
  destination: LatLon | null;
  position: { lat: number; lon: number; heading: number | null; accuracyM: number | null } | null;
  /** Va detrás de la posición con el rumbo arriba. */
  follow: boolean;
  /** El zoom al seguir. */
  followZoom: number;
  /** Puntos que encuadrar en modo libre cada vez que cambia la lista (la vista previa de la ruta). */
  fit: readonly LatLon[] | null;
  /** Dónde está el mapa mientras no hay nada que encuadrar ni posición. */
  fallbackCenter: LatLon;
  label: string;
  onLongPress?: (point: LatLon) => void;
  /** Se arrastró el mapa: quien lo usa deja de seguir. */
  onUserMove?: () => void;
  onRecenter?: () => void;
}

const isDark = (): boolean => {
  if (typeof document === 'undefined') return false;
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
};

const angleDelta = (from: number, to: number): number => ((((to - from) % 360) + 540) % 360) - 180;

export function MapView(props: MapViewProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ lat: props.fallbackCenter.lat, lon: props.fallbackCenter.lon, zoom: 15, bearing: 0, width: 300, height: 300, anchorY: 0.5 });
  const latest = useRef(props);
  latest.current = props;
  const raf = useRef<number | null>(null);
  const [, setSize] = useState(0);

  // Pintar: se pide un cuadro y se repite mientras la cámara se esté moviendo hacia donde debe.
  const frame = (): void => {
    raf.current = null;
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const p = latest.current;
    const c = cam.current;
    let moving = false;
    if (p.follow && p.position) {
      const target = { lat: p.position.lat, lon: p.position.lon, bearing: p.position.heading ?? c.bearing };
      const k = 0.22;
      c.lat += (target.lat - c.lat) * k;
      c.lon += (target.lon - c.lon) * k;
      c.bearing = (c.bearing + angleDelta(c.bearing, target.bearing) * k + 360) % 360;
      c.zoom += (p.followZoom - c.zoom) * k;
      c.anchorY += (0.72 - c.anchorY) * k;
      moving = Math.abs(target.lat - c.lat) > 2e-7 || Math.abs(target.lon - c.lon) > 2e-7 || Math.abs(angleDelta(c.bearing, target.bearing)) > 0.3 || Math.abs(p.followZoom - c.zoom) > 0.01 || Math.abs(0.72 - c.anchorY) > 0.005;
    } else {
      c.bearing += angleDelta(c.bearing, 0) * 0.25;
      c.anchorY += (0.5 - c.anchorY) * 0.25;
      moving = Math.abs(angleDelta(c.bearing, 0)) > 0.3 || Math.abs(0.5 - c.anchorY) > 0.005;
      if (!moving) {
        c.bearing = 0;
        c.anchorY = 0.5;
      }
    }
    const overlay: MapOverlay = { route: p.route ? { points: p.route.points, cumM: p.route.cumM, progressM: p.progressM } : null, destination: p.destination, position: p.position };
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    drawMap(ctx, c, { graph: p.data.graph, index: p.data.index }, overlay, isDark() ? DARK : LIGHT, dpr);
    if (moving) schedule();
  };
  const schedule = (): void => {
    if (raf.current === null) raf.current = requestAnimationFrame(frame);
  };

  // Tamaño del lienzo.
  useEffect(() => {
    const el = canvas.current;
    const host = box.current;
    if (!el || !host) return undefined;
    const resize = (): void => {
      const w = Math.max(1, Math.round(host.clientWidth));
      const h = Math.max(1, Math.round(host.clientHeight));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      cam.current.width = w;
      cam.current.height = h;
      setSize(w * 10_000 + h);
      schedule();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, []);

  // Encuadrar lo que se pide (la ruta entera, o la posición) cuando cambia, y centrar en la posición la primera vez que se tiene.
  const hasPosition = props.position !== null;
  const fitKey = props.fit ? props.fit.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|') : '';
  useEffect(() => {
    if (props.follow) return;
    const c = cam.current;
    if (props.fit && props.fit.length > 0) Object.assign(c, fitPoints(props.fit, c.width, c.height, 36));
    else if (props.position) Object.assign(c, { lat: props.position.lat, lon: props.position.lon, zoom: 16.5 });
    schedule();
  }, [fitKey, props.follow, hasPosition]);

  // Todo lo demás que cambia el dibujo.
  useEffect(() => {
    schedule();
  }, [props.route, props.progressM, props.destination, props.position?.lat, props.position?.lon, props.position?.heading, props.follow, props.followZoom, props.data]);

  // Gestos.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ lastDist: number; pressTimer: ReturnType<typeof setTimeout> | null; startX: number; startY: number; moved: boolean }>({ lastDist: 0, pressTimer: null, startX: 0, startY: 0, moved: false });

  const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const r = (canvas.current as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const dragged = (): void => props.onUserMove?.();
  const down = (e: PointerEvent & { currentTarget: HTMLCanvasElement }): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.startX = p.x;
      g.startY = p.y;
      g.moved = false;
      if (g.pressTimer) clearTimeout(g.pressTimer);
      g.pressTimer = setTimeout(() => {
        g.pressTimer = null;
        if (!g.moved && pointers.current.size === 1 && latest.current.onLongPress) latest.current.onLongPress(toLatLon(cam.current, g.startX, g.startY));
      }, 550);
    } else if (pointers.current.size === 2) {
      if (g.pressTimer) clearTimeout(g.pressTimer);
      g.pressTimer = null;
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      g.lastDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const move = (e: PointerEvent & { currentTarget: HTMLCanvasElement }): void => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    const g = gesture.current;
    const c = cam.current;
    if (pointers.current.size === 1) {
      if (Math.hypot(p.x - g.startX, p.y - g.startY) > 8) {
        g.moved = true;
        if (g.pressTimer) clearTimeout(g.pressTimer);
        g.pressTimer = null;
      }
      if (!g.moved) return;
      dragged();
      // El punto que estaba bajo el dedo sigue bajo el dedo.
      const before = toLatLon(c, prev.x, prev.y);
      const after = toLatLon(c, p.x, p.y);
      c.lat += before.lat - after.lat;
      c.lon += before.lon - after.lon;
    } else if (pointers.current.size === 2) {
      pointers.current.set(e.pointerId, p);
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.lastDist > 0 && dist > 0) {
        dragged();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const before = toLatLon(c, mid.x, mid.y);
        c.zoom = clampZoom(c.zoom + Math.log2(dist / g.lastDist));
        const after = toLatLon(c, mid.x, mid.y);
        c.lat += before.lat - after.lat;
        c.lon += before.lon - after.lon;
      }
      g.lastDist = dist;
    }
    pointers.current.set(e.pointerId, p);
    schedule();
  };
  const up = (e: PointerEvent & { currentTarget: HTMLCanvasElement }): void => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.pressTimer) clearTimeout(g.pressTimer);
    g.pressTimer = null;
    g.lastDist = 0;
  };
  const wheel = (e: WheelEvent): void => {
    e.preventDefault();
    dragged();
    const c = cam.current;
    const p = local(e);
    const before = toLatLon(c, p.x, p.y);
    c.zoom = clampZoom(c.zoom - e.deltaY / 400);
    const after = toLatLon(c, p.x, p.y);
    c.lat += before.lat - after.lat;
    c.lon += before.lon - after.lon;
    schedule();
  };
  const zoomBy = (delta: number): void => {
    dragged();
    cam.current.zoom = clampZoom(cam.current.zoom + delta);
    schedule();
  };

  return (
    <div class={`navmap${props.fill ? ' navmap--fill' : ''}`} ref={box}>
      <canvas ref={canvas} class="navmap__canvas" role="img" aria-label={props.label} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} />
      <div class="navmap__tools">
        <button type="button" class="navmap__btn" aria-label="Acercar el mapa" onClick={() => zoomBy(0.8)}>
          <Icon name="Plus" size={18} />
        </button>
        <button type="button" class="navmap__btn" aria-label="Alejar el mapa" onClick={() => zoomBy(-0.8)}>
          <span aria-hidden="true" class="navmap__minus" />
        </button>
        {!props.follow && props.position && props.onRecenter && (
          <button type="button" class="navmap__btn navmap__btn--accent" aria-label="Centrar en mi posición" onClick={props.onRecenter}>
            <Icon name="LocateFixed" size={18} />
          </button>
        )}
      </div>
      <p class="navmap__credit">© OpenStreetMap</p>
    </div>
  );
}
