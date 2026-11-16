import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { backToSearch, chooseDestination, chooseOnMap, closeNavigation, navData, navState, openNavigation, setQuery, startNavigation, toggleMute, type Destination } from '../../app/nav/navigator';
import { svc } from '../../app/services';
import { liveFix } from '../../app/state';
import type { LatLon } from '../../domain/nav/geo';
import type { TurnKind } from '../../domain/nav/maneuvers';
import { FAR_FINISH_M } from '../../domain/nav/maneuvers';
import { Banner } from '../primitives';
import { fmtClock, fmtDistance, fmtDuration } from '../format';
import { Icon } from '../icons';
import { MapView } from './MapView';

// La navegación del entreno vive entera en la pestaña del mapa (`NavMapTab`): el buscador de destino, la ruta propuesta, las indicaciones y lo que falta, todo flotando sobre el mapa. La
// pestaña «Entreno» no sabe nada de ella (es la misma con y sin navegación guiada). El estado vive en `app/nav/navigator.ts`: aquí solo se pinta y se pulsan botones. Los avisos son sonoros
// (zumbidos en el oído del lado del giro): en pantalla solo hay lo que ayuda a mirar.

const TURN_ICON: Record<TurnKind, string> = {
  left: 'CornerUpLeft',
  right: 'CornerUpRight',
  'slight-left': 'ArrowUpLeft',
  'slight-right': 'ArrowUpRight',
  'sharp-left': 'CornerUpLeft',
  'sharp-right': 'CornerUpRight',
  uturn: 'Undo2',
  'keep-left': 'ArrowUpLeft',
  'keep-right': 'ArrowUpRight',
  straight: 'ArrowUp',
};

/** Los bytes que van llegando, para no dejar la pantalla muda mientras baja el mapa. */
const mb = (bytes: number): string => (bytes < 100_000 ? '' : `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`);

const dist = (m: number): string => {
  const d = fmtDistance(m);
  return `${d.value} ${d.unit}`;
};

/** El zoom al seguir: a pie se ve la calle de cerca; en bici hace falta ver más por delante. */
const FOLLOW_ZOOM_ON_FOOT = 17.6;
const FOLLOW_ZOOM_BIKE = 16.8;

/** Cuántos resultados del buscador se enseñan sobre el mapa: más taparían el mapa entero. */
const RESULTS_SHOWN = 3;

/** El icono de la siguiente indicación. */
function maneuverIcon(next: NonNullable<ReturnType<typeof nextOf>>): string {
  return next.type === 'roundabout' ? 'RotateCw' : next.type === 'arrive' ? 'Flag' : next.type === 'steps' ? 'ArrowUp' : TURN_ICON[next.turn];
}
const nextOf = () => {
  const s = navState.value;
  return s.guidance?.nextStep ?? s.steps[1] ?? null;
};

// ───────────────────────────── trozos que se repiten en las dos pestañas ─────────────────────────────

/** La indicación siguiente en grande: distancia hasta ella y qué hacer. */
function ManeuverBanner({ compact = false, children }: { compact?: boolean; children?: JSX.Element | null }): JSX.Element {
  const state = navState.value;
  const g = state.guidance;
  const next = nextOf();
  return (
    <div class={`guide__banner${compact ? ' guide__banner--compact' : ''}`}>
      <Icon name={next ? maneuverIcon(next) : 'ArrowUp'} size={compact ? 30 : 40} />
      <span>
        <strong>{g && next ? dist(g.distToNextM) : '—'}</strong>
        <small>{next ? next.text : 'Calculando…'}</small>
      </span>
      {children}
    </div>
  );
}

function MuteButton(): JSX.Element {
  const muted = navState.value.muted;
  return (
    <button type="button" class="guide__tool" aria-pressed={muted} aria-label={muted ? 'Activar los avisos sonoros' : 'Silenciar los avisos sonoros'} onClick={toggleMute}>
      <Icon name={muted ? 'VolumeX' : 'Volume2'} size={22} />
    </button>
  );
}

/**
 * Lo que dice la carga del mapa de un entreno guiado, para que se vea QUÉ se está esperando (y no solo «conectando con el anillo»): el GPS, el mapa guardado o la bajada de uno nuevo. `null` si
 * no hay nada que esperar. Lo usan la pestaña del mapa y la pantalla de «Conectando…» de antes de empezar.
 */
export function mapLoadingText(): { line: string; hint: string } | null {
  const state = navState.value;
  const d = state.download;
  if (state.phase === 'locating') return { line: 'Esperando la posición del GPS para cargar el mapa…', hint: 'El mapa de tu zona se carga en cuanto el GPS sepa dónde estás: mejor al aire libre.' };
  if (state.phase === 'loading') return { line: 'Abriendo el mapa guardado de tu zona…', hint: '' };
  if (state.phase === 'downloading') {
    return d?.stage === 'build'
      ? { line: 'Preparando el mapa de tu zona…', hint: 'Falta poco: se está montando para poder calcular rutas.' }
      : { line: `Bajando el mapa de tu zona… ${d && d.stage === 'download' ? mb(d.bytes) : ''}`.trim(), hint: 'Por eso tarda: es la primera vez en esta zona. Se baja de internet una sola vez y queda guardado en el móvil.' };
  }
  return null;
}

/** Lo que dice la navegación mientras espera algo (el GPS, el mapa) o cuando no puede seguir. Devuelve `null` si ya hay mapa abierto. */
function StatusBlock({ sportId }: { sportId: string }): JSX.Element | null {
  const state = navState.value;
  const loading = mapLoadingText();
  if (loading !== null) {
    return (
      <div class="guide__status">
        <p class="guide__loading" role="status">
          <span class="spinner" aria-hidden="true" /> {loading.line}
        </p>
        {loading.hint !== '' && <p class="guide__hint">{loading.hint}</p>}
        <button type="button" class="btn btn--block" onClick={closeNavigation}>
          Cancelar
        </button>
      </div>
    );
  }
  if (state.phase === 'unavailable') {
    return (
      <div class="guide__status">
        <Banner tone="warn">{state.message}</Banner>
        <div class="btn-row">
          <button type="button" class="btn btn--primary" onClick={() => void openNavigation(sportId)}>
            Reintentar
          </button>
          <button type="button" class="btn" onClick={closeNavigation}>
            Cerrar
          </button>
        </div>
      </div>
    );
  }
  if (state.phase === 'closed') {
    return (
      <button type="button" class="guide__open" onClick={() => void openNavigation(sportId)}>
        <Icon name="Navigation" size={22} />
        <span>
          <strong>¿A dónde vamos?</strong>
          <small>Ruta con avisos sonoros</small>
        </span>
      </button>
    );
  }
  return null;
}

/** «Termina a 250 m del destino»: la ruta llega a la calle más cercana cuando el destino (un parque, un recinto) no tiene camino hasta él. */
function farEndNote(): string | null {
  const route = navState.value.route;
  if (!route || route.destination.distM <= FAR_FINISH_M) return null;
  return `El camino acaba a ${dist(route.destination.distM)} del destino: los últimos metros son por tu cuenta.`;
}

// ───────────────────────────── lo que flota sobre el mapa ─────────────────────────────

/** El buscador de destino: el campo, los primeros resultados y la explicación de cómo elegir un punto en el propio mapa. */
function SearchCard(): JSX.Element {
  const state = navState.value;
  return (
    <section class="guide guide--float" aria-label="Navegación">
      <header class="guide__head">
        <h3>Navegación · {state.profileLabel}</h3>
        <button type="button" class="guide__close" aria-label="Cerrar la navegación" onClick={closeNavigation}>
          <Icon name="X" size={18} />
        </button>
      </header>
      <div class="field">
        <label for="nav-query">Destino</label>
        <div class="guide__search">
          <Icon name="Search" size={18} />
          <input id="nav-query" class="input" type="search" autocomplete="off" enterkeyhint="search" placeholder="Un parque, una calle, una estación…" value={state.query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </div>
      {state.message && <Banner tone="warn">{state.message}</Banner>}
      {state.results.length > 0 ? (
        <ul class="guide__results" aria-label="Resultados">
          {state.results.slice(0, RESULTS_SHOWN).map((r) => (
            <li key={`${r.name}|${r.area}|${r.kind}|${r.lat}`}>
              <button type="button" onClick={() => chooseDestination({ name: r.name, subtitle: [r.kindLabel, r.area].filter(Boolean).join(' · '), lat: r.lat, lon: r.lon } satisfies Destination)}>
                <Icon name="MapPin" size={18} />
                <span>
                  <strong>{r.name}</strong>
                  <small>{[r.kindLabel, r.area, r.distanceM !== null ? dist(r.distanceM) : ''].filter(Boolean).join(' · ')}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : state.query.trim().length >= 2 ? (
        <p class="guide__none">No encuentro nada con ese nombre en el mapa de tu zona.</p>
      ) : (
        <p class="guide__hint">O mantén pulsado un punto del mapa para ir hasta él.</p>
      )}
    </section>
  );
}

/** Lo que falta para llegar y los botones de la ruta en marcha: silenciar los avisos y salir (con confirmación). */
function ProgressBar(): JSX.Element {
  const state = navState.value;
  const [confirming, setConfirming] = useState(false);
  const g = state.guidance;
  const remaining = g?.remainingM ?? state.route?.distanceM ?? 0;
  const remainingS = g?.remainingS ?? state.route?.durationS ?? 0;
  return (
    <section class="guide guide--float guide--bar" aria-label="Lo que falta">
      {g?.status === 'approaching' && <p class="guide__note">Ve hasta el inicio de la ruta.</p>}
      {g?.status === 'off-route' && <p class="guide__note">Recalculando la ruta…</p>}
      {state.message && <Banner tone="warn">{state.message}</Banner>}
      <div class="guide__bar">
        <div class="guide__bar-main">
          <strong>{fmtDuration(remainingS)}</strong>
          <span>
            {dist(remaining)} · {fmtClock(svc().now() + remainingS * 1000)}
          </span>
        </div>
        {confirming ? (
          <>
            <button type="button" class="btn" onClick={() => setConfirming(false)}>
              Seguir
            </button>
            <button type="button" class="btn btn--danger" onClick={() => backToSearch({ clear: true })}>
              Dejar la ruta
            </button>
          </>
        ) : (
          <button type="button" class="btn" onClick={() => setConfirming(true)}>
            Salir
          </button>
        )}
      </div>
    </section>
  );
}

// ───────────────────────────── la pestaña del mapa ─────────────────────────────

/**
 * El mapa entero con lo que hace falta encima: los indicadores del entreno (`hud`, arriba), el buscador, el resumen de la ruta o la indicación y lo que falta y, abajo, los botones del entreno (`controls`). Lo flotante
 * deja pasar los toques por donde no hay nada para que el mapa se pueda mover.
 */
export function NavMapTab({ sportId, hud, controls }: { sportId: string; hud: JSX.Element; controls: JSX.Element }): JSX.Element {
  const state = navState.value;
  const data = navData.value;
  const fix = liveFix.value;
  const [following, setFollowing] = useState(true);
  const position = useMemo(() => (fix ? { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM } : null), [fix?.lat, fix?.lon, fix?.accuracyM]);

  // Los puntos que encuadran la ruta entera en la vista previa.
  const fit = useMemo<LatLon[] | null>(() => {
    const r = state.route;
    if (!r || state.phase !== 'preview') return null;
    const step = Math.max(1, Math.floor(r.points.length / 12));
    const pts: LatLon[] = [];
    for (let i = 0; i < r.points.length; i += step) pts.push(r.points[i]!);
    pts.push(r.points[r.points.length - 1]!);
    return pts;
  }, [state.route, state.phase]);

  const showMap = data !== null && state.phase !== 'closed' && state.phase !== 'unavailable' && state.phase !== 'locating' && state.phase !== 'loading' && state.phase !== 'downloading';
  const heading = state.guidance?.heading ?? null;
  const here = state.guidance && state.phase !== 'search' && state.phase !== 'preview' ? { lat: state.guidance.position.lat, lon: state.guidance.position.lon, heading, accuracyM: fix?.accuracyM ?? null } : position ? { ...position, heading: null } : null;
  const bbox = data?.pack.meta.bbox;
  const fallback: LatLon = fix ? { lat: fix.lat, lon: fix.lon } : { lat: bbox ? (bbox.minLat + bbox.maxLat) / 2 : 40.4168, lon: bbox ? (bbox.minLon + bbox.maxLon) / 2 : -3.7038 };

  let overlay: JSX.Element | null = null;
  if (state.phase === 'search') {
    overlay = <SearchCard />;
  } else if (state.phase === 'navigating') {
    overlay = (
      <>
        <ManeuverBanner compact>
          <MuteButton />
        </ManeuverBanner>
        <ProgressBar />
      </>
    );
  } else if (state.phase === 'preview' && state.route) {
    const r = state.route;
    const far = farEndNote();
    overlay = (
      <div class="maptab__card">
        <span class="maptab__card-main">
          <span>
            <strong>{fmtDuration(r.durationS)}</strong> · {dist(r.distanceM)} · llegada {fmtClock(svc().now() + r.durationS * 1000)}
          </span>
          <small>{state.destination?.name ?? 'Destino'}</small>
        </span>
        <button type="button" class="guide__close" aria-label="Cambiar de destino" onClick={() => backToSearch()}>
          <Icon name="X" size={18} />
        </button>
        {far && <small>{far}</small>}
        {state.message && <small>{state.message}</small>}
        <small>Tres avisos: dos zumbidos unos 5 s antes de cada giro (con auriculares, en el oído del lado), uno largo y grave si te equivocas o hay que dar la vuelta, y un timbre de tres notas al llegar.</small>
        <button type="button" class="btn btn--primary btn--block" onClick={startNavigation}>
          <Icon name="Navigation" size={18} />
          Iniciar
        </button>
      </div>
    );
  } else if (state.phase === 'arrived') {
    overlay = (
      <div class="guide__banner guide__banner--done guide__banner--compact" role="status">
        <Icon name="Flag" size={28} />
        <span>
          <strong>Has llegado</strong>
          <small>{state.destination?.name ?? 'a tu destino'}</small>
        </span>
        <button type="button" class="btn" onClick={() => backToSearch({ clear: true })}>
          Cerrar la ruta
        </button>
      </div>
    );
  }

  return (
    <div class="maptab">
      {showMap && data ? (
        <MapView
          fill
          data={data}
          route={state.phase === 'search' ? null : state.route}
          progressM={state.guidance?.progressM ?? 0}
          destination={state.destination ? { lat: state.destination.lat, lon: state.destination.lon } : null}
          position={here}
          follow={state.phase === 'navigating' && following}
          followZoom={sportId === 'cycle' || sportId === 'bicimad' ? FOLLOW_ZOOM_BIKE : FOLLOW_ZOOM_ON_FOOT}
          fit={fit}
          fallbackCenter={fallback}
          label={state.phase === 'navigating' ? 'Mapa de la ruta que estás siguiendo' : state.phase === 'preview' ? 'Mapa con la ruta hasta el destino' : 'Mapa de tu zona'}
          {...(state.phase === 'search' || state.phase === 'preview' ? { onLongPress: (p: LatLon) => chooseOnMap(p.lat, p.lon) } : {})}
          onUserMove={() => setFollowing(false)}
          {...(state.phase === 'navigating' ? { onRecenter: () => setFollowing(true) } : {})}
        />
      ) : (
        <div class="maptab__empty">
          <StatusBlock sportId={sportId} />
        </div>
      )}
      <div class="maptab__edge" aria-hidden="true" />
      <div class="maptab__top">
        {hud}
        {overlay}
        {state.soundProblem && state.phase === 'navigating' && <Banner tone="warn">{state.soundProblem}</Banner>}
      </div>
      <div class="maptab__bottom">{controls}</div>
    </div>
  );
}
