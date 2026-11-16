import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { jointMetricOf, type JointMetricId } from '../../domain/joint-metrics';
import { Icon } from '../icons';
import { useArmed } from '../hooks';
import type { JointBand } from '../charts/JointChart';

// El modo de edición del gráfico de Salud: cada dato es un BLOQUE apilable que se mueve sutilmente (como los iconos de Android al reordenarlos), se arrastra para cambiar su
// orden y se quita con la cruz de su esquina (con un segundo toque, como el borrado de comidas). Debajo del último hay un bloque «+» para añadir otro. En un móvil se levanta un
// bloque con una pulsación larga (así deslizar para recorrer la lista sigue funcionando); con el ratón se arrastra directamente, y con el teclado el asa de cada bloque se mueve
// con las flechas.

/** Cuánto hay que mantener el dedo para levantar un bloque, y lo que se puede mover mientras tanto sin que cuente como deslizar la pantalla. */
const LONG_PRESS_MS = 320;
const TOUCH_SLOP = 10;
const MOUSE_SLOP = 5;
/** Cuánto dura el asentado de un bloque al soltarlo en su sitio. */
const SETTLE_MS = 140;
/** La franja junto al borde de la pantalla donde, arrastrando, la lista se desplaza sola. */
const EDGE = 88;
const MAX_SCROLL_STEP = 16;

/** Un dibujo pequeño de un dato (barras o línea) con los valores que ya tiene: la vista previa de un bloque. */
export function MiniBand({ band, height = 44 }: { band: Pick<JointBand, 'mode' | 'values' | 'color'>; height?: number }): JSX.Element {
  const values = band.values;
  const present = values.filter((v): v is number => v !== null);
  const n = Math.max(1, values.length);
  const hi = Math.max(1, ...present);
  const lo = band.mode === 'bars' ? 0 : Math.min(...present, hi);
  const span = Math.max(1e-6, hi - lo);
  const W = 200;
  const H = 40;
  const x = (i: number): number => (W / n) * (i + 0.5);
  const y = (v: number): number => H - 4 - ((v - lo) / span) * (H - 10);
  return (
    <svg class="mini-band" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true" focusable="false">
      <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} class="mini-band__base" />
      {present.length === 0 ? null : band.mode === 'bars' ? (
        values.map((v, i) => (v === null ? null : <rect key={i} x={x(i) - Math.max(0.6, (W / n) * 0.34)} width={Math.max(1.2, (W / n) * 0.68)} y={y(v)} height={H - y(v)} rx="1" fill={band.color} />))
      ) : (
        <polyline
          points={values.flatMap((v, i) => (v === null ? [] : [`${x(i)},${y(v)}`])).join(' ')}
          fill="none"
          stroke={band.color}
          stroke-width="2"
          vector-effect="non-scaling-stroke"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      )}
    </svg>
  );
}

/** La cruz de la esquina de un bloque: el primer toque la prepara («Quitar») y el segundo, que no vale al instante, quita el bloque. Igual que borrar una comida. */
export function RemoveCross({ title, onRemove }: { title: string; onRemove: () => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const armed = useArmed(asking, 450);
  return (
    <button
      type="button"
      class={`jb-cross${asking ? ' is-confirming' : ''}`}
      aria-label={asking ? `Confirmar: quitar ${title}` : `Quitar ${title}`}
      onClick={() => {
        if (!asking) setAsking(true);
        else if (armed) onRemove();
      }}
      onBlur={() => setAsking(false)}
    >
      <Icon name="X" size={asking ? 14 : 15} />
      {asking && 'Quitar'}
    </button>
  );
}

interface Drag {
  id: JointMetricId;
  index: number;
  pointerId: number;
  startY: number;
  startScroll: number;
  rects: Array<{ top: number; height: number }>;
  step: number;
  /** Cuánto se ha movido el bloque desde su sitio (px, incluido lo que se ha desplazado la lista). */
  offset: number;
  /** Se ha soltado: el bloque se asienta en su hueco antes de guardar el orden. */
  settling: boolean;
}

export interface JointBlocksProps {
  ids: readonly JointMetricId[];
  /** El dibujo de cada bloque (los valores del periodo). */
  bandOf: (id: JointMetricId) => Pick<JointBand, 'mode' | 'values' | 'color'>;
  onChange: (ids: JointMetricId[]) => void;
  /** Se pulsó el bloque «+». `null`: ya están todos los datos, no hay nada que añadir. */
  onAdd: (() => void) | null;
}

const moved = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
};

/** La lista de bloques arrastrables y el bloque «+» de debajo. */
export function JointBlocks({ ids, bandOf, onChange, onAdd }: JointBlocksProps): JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const list = useRef<HTMLOListElement>(null);
  const pending = useRef<{ id: JointMetricId; pointerId: number; x: number; y: number; startX: number; startY: number; touch: boolean; timer: ReturnType<typeof setTimeout> | undefined; grip: boolean } | null>(null);
  const lastY = useRef(0);
  const raf = useRef(0);
  const focusNext = useRef<JointMetricId | null>(null);
  const [announce, setAnnounce] = useState('');

  const scroller = (): HTMLElement | null => list.current?.closest<HTMLElement>('.page') ?? null;

  // Con un bloque levantado, la pantalla no debe deslizarse con el dedo: el deslizamiento ya está decidido (no se movió durante la pulsación larga).
  useEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const block = (event: TouchEvent): void => {
      if (dragRef.current !== null || pending.current?.touch === true) {
        if (dragRef.current !== null && event.cancelable) event.preventDefault();
      }
    };
    element.addEventListener('touchmove', block, { passive: false });
    return () => element.removeEventListener('touchmove', block);
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Tras mover un bloque con el teclado, el foco sigue en su asa.
  useEffect(() => {
    const wanted = focusNext.current;
    if (wanted === null) return;
    focusNext.current = null;
    list.current?.querySelector<HTMLElement>(`[data-grip="${wanted}"]`)?.focus();
  }, [ids]);

  const targetIndex = (state: Drag): number => {
    const center = state.rects[state.index]!.top + state.rects[state.index]!.height / 2 + state.offset;
    let target = 0;
    state.rects.forEach((rect, j) => {
      if (j !== state.index && rect.top + rect.height / 2 < center) target++;
    });
    return target;
  };

  const lift = (id: JointMetricId, pointerId: number, y: number): void => {
    const element = list.current;
    const scrolled = scroller();
    if (!element) return;
    const items = [...element.querySelectorAll<HTMLElement>(':scope > li')];
    const scroll = scrolled?.scrollTop ?? 0;
    const rects = items.map((item) => {
      const r = item.getBoundingClientRect();
      return { top: r.top + scroll, height: r.height };
    });
    const index = ids.indexOf(id);
    if (index < 0 || rects.length === 0) return;
    const gap = rects.length > 1 ? Math.max(0, (rects[1]?.top ?? 0) - (rects[0]?.top ?? 0) - (rects[0]?.height ?? 0)) : 0;
    items[index]?.setPointerCapture(pointerId);
    navigator.vibrate?.(12);
    lastY.current = y;
    setDrag({ id, index, pointerId, startY: y, startScroll: scroll, rects, step: (rects[index]?.height ?? 0) + gap, offset: 0, settling: false });
    // La lista se desplaza sola cuando se arrastra cerca del borde de la pantalla.
    const tick = (): void => {
      const current = dragRef.current;
      const box = scroller();
      if (current === null || current.settling) return;
      if (box) {
        const bounds = box.getBoundingClientRect();
        const y2 = lastY.current;
        let speed = 0;
        if (y2 < bounds.top + EDGE) speed = -Math.ceil(((bounds.top + EDGE - y2) / EDGE) * MAX_SCROLL_STEP);
        else if (y2 > bounds.bottom - EDGE) speed = Math.ceil(((y2 - (bounds.bottom - EDGE)) / EDGE) * MAX_SCROLL_STEP);
        if (speed !== 0) {
          box.scrollTop += speed;
          setDrag((d) => (d === null ? d : { ...d, offset: lastY.current - d.startY + (box.scrollTop - d.startScroll) }));
        }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const finish = (): void => {
    const current = dragRef.current;
    clearTimeout(pending.current?.timer);
    pending.current = null;
    cancelAnimationFrame(raf.current);
    if (current === null || current.settling) return;
    const target = targetIndex(current);
    // Se asienta en su hueco y, al terminar, se guarda el orden.
    setDrag({ ...current, settling: true, offset: (target - current.index) * current.step });
    setTimeout(() => {
      if (target !== current.index) {
        onChange(moved(ids, current.index, target));
        setAnnounce(`${jointMetricOf(current.id).title}, posición ${target + 1} de ${ids.length}`);
      }
      setDrag(null);
    }, SETTLE_MS);
  };

  const onPointerDown = (event: PointerEvent, id: JointMetricId): void => {
    if (event.button !== 0 || dragRef.current !== null) return;
    const target = event.target as Element;
    if (target.closest('button:not(.jb-grip)')) return; // la cruz es de la cruz
    const touch = event.pointerType === 'touch';
    const grip = target.closest('.jb-grip') !== null;
    const state = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, touch, grip, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    // Con el dedo, sobre el bloque se espera una pulsación larga; con el asa o con el ratón se arrastra en cuanto se mueve.
    if (touch && !grip) state.timer = setTimeout(() => lift(id, event.pointerId, state.y), LONG_PRESS_MS);
    pending.current = state;
  };

  const onPointerMove = (event: PointerEvent): void => {
    const current = dragRef.current;
    lastY.current = event.clientY;
    if (current !== null) {
      if (current.settling || event.pointerId !== current.pointerId) return;
      const box = scroller();
      setDrag({ ...current, offset: event.clientY - current.startY + ((box?.scrollTop ?? 0) - current.startScroll) });
      return;
    }
    const wait = pending.current;
    if (wait === null || event.pointerId !== wait.pointerId) return;
    wait.x = event.clientX;
    wait.y = event.clientY;
    const far = Math.hypot(wait.x - wait.startX, wait.y - wait.startY) > (wait.touch && !wait.grip ? TOUCH_SLOP : MOUSE_SLOP);
    if (!far) return;
    if (wait.touch && !wait.grip) {
      // Deslizar antes de que acabe la pulsación larga es recorrer la lista, no levantar un bloque.
      clearTimeout(wait.timer);
      pending.current = null;
      return;
    }
    clearTimeout(wait.timer);
    pending.current = null;
    lift(wait.id, wait.pointerId, event.clientY);
  };

  const onPointerUp = (): void => {
    if (dragRef.current !== null) finish();
    else {
      clearTimeout(pending.current?.timer);
      pending.current = null;
    }
  };

  const onKeyDown = (event: KeyboardEvent, index: number, id: JointMetricId): void => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= ids.length || to === index) return;
    focusNext.current = id;
    onChange(moved(ids, index, to));
    setAnnounce(`${jointMetricOf(id).title}, posición ${to + 1} de ${ids.length}`);
  };

  const targetNow = drag !== null ? targetIndex(drag) : -1;
  return (
    <div class="jb">
      <ol class={`jb-list${drag !== null ? ' is-dragging' : ''}`} aria-label="Gráficos que se ven, en este orden" ref={list}>
        {ids.map((id, index) => {
          const metric = jointMetricOf(id);
          const lifted = drag?.id === id;
          // Los bloques por los que pasa el que se arrastra se apartan para hacerle sitio.
          let shift = 0;
          if (drag !== null && !lifted) {
            if (index > drag.index && index <= targetNow) shift = -drag.step;
            else if (index < drag.index && index >= targetNow) shift = drag.step;
          }
          const style = lifted ? { transform: `translateY(${drag.offset}px) scale(${drag.settling ? 1 : 1.02})`, '--i': index } : { transform: shift === 0 ? undefined : `translateY(${shift}px)`, '--i': index };
          return (
            <li
              key={id}
              class={`jb-block${lifted ? ' is-lifted' : ''}${lifted && drag.settling ? ' is-settling' : ''}`}
              style={style}
              onPointerDown={(e) => onPointerDown(e, id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div class="jb-block__head">
                <button
                  type="button"
                  class="jb-grip"
                  data-grip={id}
                  aria-label={`Mover ${metric.title}: flechas arriba y abajo`}
                  onKeyDown={(e) => onKeyDown(e, index, id)}
                >
                  <Icon name="GripVertical" size={18} />
                </button>
                <span class="jb-block__title">
                  <strong>{metric.title}</strong>
                  <small>{metric.group}</small>
                </span>
              </div>
              <MiniBand band={bandOf(id)} />
              <RemoveCross title={metric.title} onRemove={() => onChange(ids.filter((other) => other !== id))} />
            </li>
          );
        })}
      </ol>
      {onAdd !== null && (
        <button type="button" class="jb-add" aria-label="Añadir un gráfico" onClick={onAdd}>
          <Icon name="Plus" size={30} strokeWidth={1.8} />
        </button>
      )}
      <p class="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
