import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { openNavigation, navState, warmNavigation } from '../app/nav/navigator';
import { discardWorkout, finishWorkout, pauseWorkout, reconnectWorkoutRing, resumeWorkout } from '../app/workout-actions';
import { liveWorkout } from '../app/state';
import { HR_ZONES } from '../domain/hrzones';
import { profileForSport } from '../domain/nav/profiles';
import { sportById } from '../domain/sports';
import type { LiveWorkoutState } from '../app/workout-controller';
import type { RecorderSnapshot } from '../sync/workout-recorder';
import { fmtDistance, fmtInt, fmtTimer } from './format';
import { Icon } from './icons';
import { pulseCaption } from './live-pulse';
import { useArmed } from './hooks';
import { recoverLostFocus } from './focus';
import { hudValueSize } from './live-hud';
import { mapLoadingText, NavMapTab } from './nav/NavSection';
import { Banner } from './primitives';
import { ToastView } from './ToastView';

/**
 * Pantalla de seguimiento. Es un `<dialog>` modal que no se puede cerrar con "atrás" o Esc (un gesto sin
 * querer no debe tirar un entreno): se sale con "Terminar" y su confirmación.
 */
export function LiveWorkout(): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  // Un paseo de calibración de la zancada tiene su propia hoja: este panel no se abre.
  const state = liveWorkout.value?.purpose === 'stride' ? null : liveWorkout.value;
  const panelRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // Las confirmaciones aparecen donde acaba de estar el botón que las pidió: un doble toque no las pulsa.
  const finishArmed = useArmed(confirming && !discarding);
  const discardArmed = useArmed(discarding);
  // Con navegación guiada el entreno tiene dos pestañas (datos y ruta / mapa) que se cambian deslizando.
  const pagerRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<0 | 1>(0);
  const autoOpened = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (state && !dialog.open) dialog.showModal();
    if (!state && dialog.open) {
      dialog.close();
      recoverLostFocus();
    }
    if (!state) {
      setConfirming(false);
      setDiscarding(false);
    }
  }, [state === null]);

  // «Conectando…» → «en marcha» quita el botón Cancelar, que tenía el foco: sin esto el foco cae a <body>.
  const running = state?.phase === 'live' && state.snapshot !== null;
  useEffect(() => {
    if (running) panelRef.current?.focus();
  }, [running]);

  // Cada paso de la confirmación sustituye los botones; el foco pasa a su opción segura (Seguir / Volver).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    footerRef.current?.querySelector('button')?.focus();
  }, [confirming, discarding]);

  const sport = state ? sportById(state.sport) : null;
  const snap = state?.snapshot ?? null;
  const guided = state?.guided === true && sport !== null && profileForSport(sport.id) !== null;

  // Elegida la navegación guiada, el mapa guardado se va leyendo ya, mientras el anillo se conecta y el GPS busca la primera posición (así está listo cuando se abre la pestaña del mapa).
  useEffect(() => {
    if (guided) warmNavigation();
  }, [guided]);

  // Elegida la navegación guiada, se abre sola en cuanto el entreno está en marcha (una vez por entreno): lo primero que hay que hacer es elegir a dónde.
  useEffect(() => {
    if (!guided || !running || !sport) {
      if (!state) autoOpened.current = false;
      return;
    }
    if (autoOpened.current) return;
    autoOpened.current = true;
    if (navState.value.phase === 'closed') void openNavigation(sport.id);
    // Elegir el destino se hace en el mapa: se empieza allí (la pestaña «Entreno» queda a un deslizamiento).
    goToTab(1, false);
  }, [guided, running, state === null]);
  useEffect(() => {
    if (!state) setTab(0);
  }, [state === null]);

  const goToTab = (next: 0 | 1, animate = true): void => {
    const el = pagerRef.current;
    if (!el) return;
    const smooth = animate && typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: next * el.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    setTab(next);
  };
  const onPagerScroll = (): void => {
    const el = pagerRef.current;
    if (el) setTab(el.scrollLeft > el.clientWidth / 2 ? 1 : 0);
  };

  /** Pausa y terminar (con sus confirmaciones): los mismos en la primera pestaña (abajo) y flotando sobre el mapa. */
  const controls = (forTab: 0 | 1): JSX.Element | null =>
    snap ? (
      <footer class={`live__controls${forTab === 1 ? ' live__controls--float' : ''}`} ref={tab === forTab ? footerRef : undefined}>
        {discarding ? (
          <>
            <p class="live__ask">¿Descartar sin guardar? Se perderán los datos de este entrenamiento.</p>
            <button type="button" class="btn" onClick={() => setDiscarding(false)}>
              Volver
            </button>
            <button type="button" class="btn btn--danger" disabled={!discardArmed} onClick={() => void discardWorkout()}>
              Sí, descartar
            </button>
          </>
        ) : confirming ? (
          <>
            <p class="live__ask">¿Terminar el entrenamiento?</p>
            <button type="button" class="btn" onClick={() => setConfirming(false)}>
              Seguir
            </button>
            <button type="button" class="btn btn--primary" disabled={!finishArmed} onClick={() => void finishWorkout()}>
              Terminar y revisar
            </button>
            <button type="button" class="linkish live__discard" onClick={() => setDiscarding(true)}>
              Descartar sin guardar
            </button>
          </>
        ) : (
          <>
            <button type="button" class="btn btn--big" onClick={() => (snap.status === 'paused' ? resumeWorkout() : pauseWorkout())}>
              <Icon name={snap.status === 'paused' ? 'Play' : 'Pause'} size={22} />
              {snap.status === 'paused' ? 'Reanudar' : 'Pausa'}
            </button>
            <button type="button" class="btn btn--big btn--primary" onClick={() => setConfirming(true)}>
              <Icon name="Square" size={20} />
              Terminar
            </button>
          </>
        )}
      </footer>
    ) : null;

  const warnings =
    state && snap ? (
      <>
        {state.ringLost && (
          <Banner
            tone="warn"
            live="alert"
            action={
              <button type="button" class="linkish" onClick={() => void reconnectWorkoutRing()}>
                Reconectar
              </button>
            }
          >
            Se perdió la conexión con el anillo. El cronómetro sigue; el pulso se retomará al reconectar.
          </Banner>
        )}
        {state.warnings.map((w) => (
          <Banner tone="warn" key={w}>
            {w}
          </Banner>
        ))}
      </>
    ) : null;

  return (
    <dialog
      ref={ref}
      class="live"
      aria-label="Entrenamiento en curso"
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        // Si el sistema lo cerró y el entreno sigue, se vuelve a abrir.
        if (liveWorkout.value && liveWorkout.value.purpose !== 'stride') ref.current?.showModal();
      }}
    >
      {state && sport && (
        <div class={`live__panel${guided && snap ? ' live__panel--guided' : ''}`} ref={panelRef} tabIndex={-1}>
          <header class="live__head">
            <span class="live__sport">
              <Icon name={sport.icon} size={20} />
              {sport.name}
            </span>
            <span class={`live__status${snap?.status === 'paused' ? ' is-paused' : ''}`}>
              {state.phase === 'connecting' ? 'Conectando…' : snap?.status === 'paused' ? 'En pausa' : 'En marcha'}
            </span>
          </header>

          {state.phase === 'connecting' || !snap ? (
            <div class="live__connecting">
              <ConnectingOrb />
              {state.ring === false ? (
                <>
                  <p>Preparando el GPS del móvil…</p>
                  <p class="field__hint">Si Android pide el permiso de ubicación, acéptalo.</p>
                </>
              ) : (
                <>
                  <p>Conectando con el anillo…</p>
                  <p class="field__hint">Si se abre el selector de Bluetooth, elige tu anillo.</p>
                </>
              )}
              {guided && <MapPrep />}
              <button type="button" class="btn btn--ghost" onClick={() => void discardWorkout()}>
                Cancelar
              </button>
            </div>
          ) : guided ? (
            <>
              <div class="live__pager" role="tablist" aria-label="Pantallas del entrenamiento">
                <button type="button" role="tab" id="live-tab-data" aria-selected={tab === 0} aria-controls="live-pane-data" class={tab === 0 ? 'is-on' : ''} onClick={() => goToTab(0)}>
                  Entreno
                </button>
                <button type="button" role="tab" id="live-tab-map" aria-selected={tab === 1} aria-controls="live-pane-map" class={tab === 1 ? 'is-on' : ''} onClick={() => goToTab(1)}>
                  Mapa
                </button>
              </div>
              <div class="live__tabs" ref={pagerRef} onScroll={onPagerScroll}>
                <div class="live__pane" role="tabpanel" id="live-pane-data" aria-labelledby="live-tab-data" {...inertWhen(tab !== 0)}>
                  <EntrenoBody state={state} snap={snap} kind={sport.kind} warnings={warnings} />
                  {controls(0)}
                </div>
                <div class="live__pane live__pane--map" role="tabpanel" id="live-pane-map" aria-labelledby="live-tab-map" {...inertWhen(tab !== 1)}>
                  <NavMapTab sportId={sport.id} hud={<LiveHud snap={snap} heartRate={state.features.heartRate} />} controls={controls(1) ?? <></>} />
                </div>
              </div>
            </>
          ) : (
            <>
              <EntrenoBody state={state} snap={snap} kind={sport.kind} warnings={warnings} />
              {controls(0)}
            </>
          )}
          <ToastView />
        </div>
      )}
    </dialog>
  );
}

/** La pestaña que no se ve queda `inert`: sin foco, sin lector de pantalla y sin duplicar los botones de pausa y terminar. */
const inertWhen = (inert: boolean): Record<string, unknown> => (inert ? { inert: true } : {});

/**
 * Lo que se ve de un entreno en la pestaña «Entreno»: cronómetro, avisos y las cifras. Es EXACTAMENTE lo mismo con y sin navegación guiada (el interruptor solo añade la pestaña del
 * mapa), así que lo pintan los dos caminos con este componente.
 */
function EntrenoBody({ state, snap, kind, warnings }: { state: LiveWorkoutState; snap: RecorderSnapshot; kind: string; warnings: JSX.Element | null }): JSX.Element {
  const showDistance = snap.distanceM !== null || kind !== 'other';
  const heartRate = state.features.heartRate;
  return (
    <>
      <div class="live__timer" aria-live="off">
        {fmtTimer(snap.activeMs)}
      </div>
      {warnings}

      <div class="live__grid">
        {heartRate && (
          <div class="metric metric--hero">
            <span class="metric__label">Pulso</span>
            <span class="metric__value" style={{ color: 'var(--heart)' }}>
              {snap.bpm ?? '—'}
              <small>lpm</small>
            </span>
            <span class="metric__sub">{pulseCaption(snap)}</span>
            <ZoneBar active={snap.zone?.index ?? 0} />
          </div>
        )}
        <Metric label="Calorías ≈" value={fmtInt(snap.kcal)} unit="kcal" color="var(--kcal)" />
        {showDistance && (
          <Metric
            label={snap.distanceSource === 'gps' ? 'Distancia (GPS)' : snap.distanceSource === 'steps' ? 'Distancia ≈' : 'Distancia'}
            value={snap.distanceM === null ? '—' : fmtDistance(snap.distanceM).value}
            unit={snap.distanceM === null ? undefined : fmtDistance(snap.distanceM).unit}
            color="var(--distance)"
           
          />
        )}
        {snap.steps !== null && <Metric label="Pasos" value={fmtInt(snap.steps)} color="var(--steps)" />}
        {heartRate && (
          <>
            <Metric label="Pulso medio" value={snap.avgBpm === null ? '—' : String(snap.avgBpm)} unit="lpm" />
            <Metric label="Pulso máx." value={snap.maxBpm === null ? '—' : String(snap.maxBpm)} unit="lpm" />
          </>
        )}
      </div>
    </>
  );
}

/** Los cuatro datos del entreno en una fila, cada uno con su color: flotan sobre el mapa y son los mismos que se ven en la pestaña «Entreno». */
function LiveHud({ snap, heartRate }: { snap: RecorderSnapshot; heartRate: boolean }): JSX.Element {
  const d = snap.distanceM === null ? null : fmtDistance(snap.distanceM);
  const chips: Array<{ label: string; icon: string; value: string; unit: string; color: string }> = [
    { label: 'Tiempo', icon: 'Timer', value: fmtTimer(snap.activeMs), unit: 'tiempo', color: 'var(--brand)' },
    ...(heartRate ? [{ label: 'Pulso', icon: 'HeartPulse', value: snap.bpm === null ? '—' : String(snap.bpm), unit: 'lpm', color: 'var(--heart)' }] : []),
    { label: 'Calorías', icon: 'flame', value: fmtInt(snap.kcal), unit: 'kcal', color: 'var(--kcal)' },
    { label: 'Distancia', icon: 'route', value: d ? d.value : '—', unit: d ? d.unit : 'km', color: 'var(--distance)' },
  ];
  return (
    <ul class="hud" aria-label="Resumen del entrenamiento">
      {chips.map((c) => (
        <li key={c.label} class="hud__chip" aria-label={`${c.label}: ${c.value} ${c.unit}`}>
          <strong style={{ color: c.color, ...(hudValueSize(c.value) !== undefined ? { fontSize: `${hudValueSize(c.value)}px` } : {}) }}>{c.value}</strong>
          <small>
            <span style={{ color: c.color, display: 'inline-flex' }}>
              <Icon name={c.icon} size={14} />
            </span>
            {c.unit}
          </small>
        </li>
      ))}
    </ul>
  );
}

function Metric({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }): JSX.Element {
  return (
    <div class="metric">
      <span class="metric__label">{label}</span>
      <span class="metric__value" style={color ? { color } : undefined}>
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

function ZoneBar({ active }: { active: number }): JSX.Element {
  return (
    <div class="zones" role="img" aria-label={active ? `Zona de pulso ${active} de 5` : 'Sin zona de pulso'}>
      {HR_ZONES.map((z) => (
        <span key={z.index} class={`zones__seg${z.index === active ? ' is-active' : ''}`} style={{ opacity: z.index === active ? 1 : 0.28 }} />
      ))}
    </div>
  );
}

/**
 * La animación de la espera, mínima: un punto que respira en el centro, dos ondas que salen de él (la señal buscando) y un arco que gira alrededor. Solo dibujo (`aria-hidden`: el texto de
 * debajo ya cuenta qué pasa) y, con «reducir movimiento», queda quieta. Sin imágenes ni dependencias: son tres formas SVG y su CSS (`.orb`).
 */
function ConnectingOrb(): JSX.Element {
  return (
    <svg class="orb" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" focusable="false">
      <circle class="orb__track" cx="48" cy="48" r="38" />
      <circle class="orb__wave" cx="48" cy="48" r="10" />
      <circle class="orb__wave orb__wave--late" cx="48" cy="48" r="10" />
      <circle class="orb__arc" cx="48" cy="48" r="38" pathLength="100" />
      <circle class="orb__core" cx="48" cy="48" r="9" />
    </svg>
  );
}

/**
 * Con la navegación guiada, la pantalla de «Conectando…» dice también lo del mapa: es lo que más tarda (la primera vez en cada zona se baja de internet) y sin esto parecería que lo lento es
 * el anillo. Si el mapa ya se está cargando enseña en qué punto va; si aún no (se abre en cuanto el entreno está en marcha), avisa de lo que viene.
 */
function MapPrep(): JSX.Element {
  const loading = mapLoadingText();
  return (
    <div class="live__map-prep">
      <p role="status">{loading !== null ? loading.line : 'Después se carga el mapa de tu zona.'}</p>
      <p class="field__hint">{loading !== null && loading.hint !== '' ? loading.hint : 'Si es la primera vez en esta zona, se baja de internet y tarda un rato; luego queda guardado en el móvil y abre al instante.'}</p>
    </div>
  );
}
