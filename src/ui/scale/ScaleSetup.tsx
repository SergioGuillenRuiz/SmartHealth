import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { saveTextFile } from '../../app/files';
import { cancelPairing, finishPairing, learnWeight, markScaleEmpty, scaleReport, scaleState, scaleSupport, scanScales, startPairing, type LearnOutcome } from '../../app/scale';
import { showToast } from '../../app/state';
import { LIKELY_SCALE_NAME, type ScaleAdvert } from '../../ble/scale/transport';
import { dayKeyOf } from '../../domain/dates';
import { MAX_SCALE_G } from '../../domain/scale';
import { svc } from '../../app/services';
import { Icon } from '../icons';
import { parseDecimal, UNITS } from '../parse';
import { Banner } from '../primitives';
import { LiveWeight, scaleStatusText } from './live';

// Conectar la báscula por primera vez. El protocolo de esta báscula no está documentado, así que la app lo APRENDE con la persona: elige la báscula entre los dispositivos
// cercanos, la deja vacía, pone algo y escribe lo que marca su pantalla, y comprueba en vivo con otro peso que lo que ve coincide. Ver docs/bascula.md.

type Phase =
  | { name: 'intro' }
  | { name: 'scanning'; seen: ScaleAdvert[] }
  | { name: 'pick'; devices: ScaleAdvert[]; problem: string | null }
  | { name: 'link'; device: ScaleAdvert }
  | { name: 'empty'; device: ScaleAdvert }
  | { name: 'weigh'; device: ScaleAdvert; notice: string | null; tries: number }
  | { name: 'verify'; device: ScaleAdvert; first: number; tries: number }
  | { name: 'done' }
  | { name: 'failed'; device: ScaleAdvert | null; message: string };

const SCAN_MS = 7_000;
/** Si en tantos ms tras conectar no llega ninguna trama, algo va mal (la báscula calla o hace falta un «saludo» que esta app no conoce). */
const NO_FRAMES_MS = 12_000;
/** A partir de cuántas tramas se da por hecho que la báscula habla. */
const FRAMES_OK = 4;

const nameOf = (device: ScaleAdvert): string => device.name ?? 'Dispositivo sin nombre';

/** La señal dicha con palabras (la báscula es la que está al lado). */
function nearness(rssi: number | null): string {
  if (rssi === null) return 'señal desconocida';
  return rssi >= -58 ? 'muy cerca' : rssi >= -72 ? 'cerca' : 'lejos';
}

/** Los dispositivos con pinta de báscula primero y, dentro de cada grupo, los más cercanos. */
function sortDevices(devices: readonly ScaleAdvert[]): ScaleAdvert[] {
  const likely = (d: ScaleAdvert): boolean => d.name !== null && LIKELY_SCALE_NAME.test(d.name);
  return [...devices].sort((a, b) => Number(likely(b)) - Number(likely(a)) || (b.rssi ?? -999) - (a.rssi ?? -999));
}

/** Guarda el informe de la báscula en Descargas (para enviarlo si no se entiende su protocolo). */
export async function saveScaleReport(): Promise<void> {
  try {
    const text = await scaleReport();
    const saved = await saveTextFile(`smarthealth-bascula-${dayKeyOf(svc().now())}.txt`, text, 'text/plain');
    showToast(`Informe guardado en ${saved.location}`);
  } catch (error) {
    showToast(`No se pudo guardar el informe${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
  }
}

export function ReportButton({ label = 'Guardar el informe de la báscula' }: { label?: string }): JSX.Element {
  return (
    <button type="button" class="btn btn--block" onClick={() => void saveScaleReport()}>
      <Icon name="Download" size={18} />
      {label}
    </button>
  );
}

/** `embedded`: va dentro de otra hoja (Dispositivos), que ya tiene el foco: al abrirse no se lleva el foco al título del asistente (solo al cambiar de paso). */
export function ScaleSetup({ onDone, embedded = false }: { onDone: () => void; embedded?: boolean }): JSX.Element {
  const support = scaleSupport();
  const [phase, setPhase] = useState<Phase>({ name: 'intro' });
  const title = useRef<HTMLHeadingElement>(null);
  const finished = useRef(false);
  const state = scaleState.value;

  // Al cambiar de paso, el foco va al título: quien usa un lector de pantalla oye en qué paso está.
  const mounted = useRef(false);
  useEffect(() => {
    if (embedded && !mounted.current) {
      mounted.current = true;
      return;
    }
    mounted.current = true;
    title.current?.focus();
  }, [phase.name]);
  // Si se sale a medias, la báscula se suelta y no se guarda nada.
  useEffect(
    () => () => {
      if (!finished.current) void cancelPairing();
    },
    [],
  );

  const search = async (): Promise<void> => {
    setPhase({ name: 'scanning', seen: [] });
    const seen = new Map<string, ScaleAdvert>();
    try {
      const found = await scanScales(SCAN_MS, (advert) => {
        seen.set(advert.id, advert);
        setPhase({ name: 'scanning', seen: [...seen.values()] });
      });
      setPhase({ name: 'pick', devices: sortDevices(found), problem: null });
    } catch (error) {
      setPhase({ name: 'pick', devices: [], problem: error instanceof Error ? error.message : 'No se pudo buscar dispositivos.' });
    }
  };

  const choose = (device: ScaleAdvert): void => {
    startPairing({ id: device.id, name: device.name });
    setPhase({ name: 'link', device });
  };

  // Conectando: en cuanto llegan tramas se pasa a pedir la báscula vacía; si no llega nada, se dice.
  const linking = phase.name === 'link' ? phase.device : null;
  useEffect(() => {
    if (!linking) return undefined;
    const timer = setTimeout(() => setPhase({ name: 'failed', device: linking, message: 'La báscula está conectada pero no manda nada. Puede que necesite un paso que esta app aún no conoce.' }), NO_FRAMES_MS);
    return () => clearTimeout(timer);
  }, [linking]);
  useEffect(() => {
    if (phase.name === 'link' && state.frames >= FRAMES_OK) setPhase({ name: 'empty', device: phase.device });
    if (phase.name === 'link' && state.status === 'error') setPhase({ name: 'failed', device: phase.device, message: state.message ?? 'No se pudo usar el Bluetooth.' });
  }, [phase, state.frames, state.status, state.message]);

  const outcomeProblem = (outcome: LearnOutcome): string =>
    outcome.problem === 'no-frames'
      ? 'La báscula no ha mandado nada todavía. Pulsa un botón de la báscula y vuelve a probar.'
      : 'No encuentro el peso en lo que manda la báscula. Comprueba que lo que escribes es lo que marca su pantalla, en gramos (pulsa UNIT en la báscula hasta ver g) y que estaba quieta, y prueba con otro peso.';

  return (
    <div class="sc-wiz">
      {phase.name === 'intro' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Conectar la báscula
          </h3>
          <p class="sc-wiz__text">Enciende la báscula (pulsa un botón) y acércala al móvil. Si tienes abierta la app de RENPHO, ciérrala: la báscula solo habla con una app a la vez.</p>
          {!support.available && <Banner tone="warn">{support.reason}</Banner>}
          <button type="button" class="btn btn--primary btn--block" disabled={!support.available} onClick={() => void search()}>
            <Icon name="Bluetooth" size={18} />
            Buscar la báscula
          </button>
        </>
      )}

      {phase.name === 'scanning' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Buscando…
          </h3>
          <p class="sc-wiz__text sc-wiz__text--busy" role="status">
            <span class="spinner" aria-hidden="true" /> Dispositivos Bluetooth vistos: {phase.seen.length}
          </p>
        </>
      )}

      {phase.name === 'pick' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Elige tu báscula
          </h3>
          {phase.problem !== null && <Banner tone="warn">{phase.problem}</Banner>}
          {phase.devices.length === 0 && phase.problem === null && <p class="sc-wiz__text">No he visto ningún dispositivo. ¿Está encendida la báscula? Pulsa un botón de la báscula y busca otra vez.</p>}
          {phase.devices.length > 0 && (
            <>
              <p class="sc-wiz__text">La báscula suele llamarse RENPHO… y ser la más cercana.</p>
              <ul class="menu sc-devices" aria-label="Dispositivos encontrados">
                {phase.devices.map((device) => (
                  <li key={device.id}>
                    <button type="button" class="menu-row" onClick={() => choose(device)}>
                      <span class="menu-row__icon" style={{ color: device.name !== null && LIKELY_SCALE_NAME.test(device.name) ? 'var(--brand)' : 'var(--text-3)' }}>
                        <Icon name={device.name !== null && LIKELY_SCALE_NAME.test(device.name) ? 'Scale' : 'Bluetooth'} size={20} />
                      </span>
                      <span class="menu-row__main">
                        <strong>{nameOf(device)}</strong>
                        <small>
                          {nearness(device.rssi)} · …{device.id.slice(-5)}
                        </small>
                      </span>
                      <Icon name="ChevronRight" size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" class="btn btn--block" onClick={() => void search()}>
            <Icon name="RefreshCw" size={18} />
            Buscar otra vez
          </button>
        </>
      )}

      {phase.name === 'link' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Conectando con {nameOf(phase.device)}…
          </h3>
          <p class="sc-wiz__text sc-wiz__text--busy" role="status">
            <span class="spinner" aria-hidden="true" /> {scaleStatusText(state)}
            {state.frames > 0 && ` · ${state.frames} datos recibidos`}
          </p>
        </>
      )}

      {phase.name === 'empty' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Quita todo de la báscula
          </h3>
          <p class="sc-wiz__text">Pulsa TARA si hace falta: su pantalla debe marcar 0.</p>
          <button
            type="button"
            class="btn btn--primary btn--block"
            onClick={() => {
              markScaleEmpty();
              setPhase({ name: 'weigh', device: phase.device, notice: null, tries: 1 });
            }}
          >
            <Icon name="Check" size={18} />
            Ya marca 0
          </button>
        </>
      )}

      {phase.name === 'weigh' && (
        <WeighStep
          device={phase.device}
          notice={phase.notice}
          title={title}
          onLearned={(outcome, first) => {
            if (outcome.best) setPhase({ name: 'verify', device: phase.device, first, tries: phase.tries });
            else setPhase({ name: 'weigh', device: phase.device, notice: outcomeProblem(outcome), tries: phase.tries });
          }}
        />
      )}

      {phase.name === 'verify' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            Comprueba que se lee bien
          </h3>
          <LiveWeight />
          <p class="sc-wiz__text">Ahora quita o añade algo en la báscula. ¿Lo que ves aquí es lo mismo que marca su pantalla?</p>
          <VerifyButtons
            first={phase.first}
            onYes={() => {
              // Guardada la báscula, soltarla al desmontarse sería deshacer el emparejado: se marca antes.
              finished.current = true;
              void finishPairing().then((saved) => {
                if (saved) setPhase({ name: 'done' });
                else finished.current = false;
              });
            }}
            onNo={() => {
              if (phase.tries >= 3) setPhase({ name: 'failed', device: phase.device, message: 'No consigo que lo que leo coincida con la pantalla de la báscula.' });
              else setPhase({ name: 'weigh', device: phase.device, notice: 'Escribe lo que marca ahora la pantalla (la báscula quieta) y lo vuelvo a buscar.', tries: phase.tries + 1 });
            }}
          />
        </>
      )}

      {phase.name === 'done' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            <Icon name="Check" size={20} strokeWidth={2.6} /> Báscula lista
          </h3>
          <p class="sc-wiz__text">Ya puedes pesar la comida desde «He comido algo»: la báscula se conecta sola.</p>
          <button type="button" class="btn btn--primary btn--block" onClick={onDone}>
            Listo
          </button>
        </>
      )}

      {phase.name === 'failed' && (
        <>
          <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
            No he podido leer la báscula
          </h3>
          <Banner tone="warn">{phase.message}</Banner>
          <p class="sc-wiz__text">Guarda el informe y envíamelo: trae lo que manda la báscula y con él se puede añadir su protocolo.</p>
          <ReportButton />
          <button type="button" class="btn btn--block" onClick={() => void search()}>
            <Icon name="RefreshCw" size={18} />
            Empezar de nuevo
          </button>
        </>
      )}
    </div>
  );
}

/** «Sí, coincide» solo cuando se ha cambiado el peso: con una pesada pequeña, varios campos valían lo mismo y el cambio los separa. */
function VerifyButtons({ first, onYes, onNo }: { first: number; onYes: () => void; onNo: () => void }): JSX.Element {
  const reading = scaleState.value.reading;
  const moved = reading !== null && reading.stable && reading.grams >= 5 && Math.abs(reading.grams - first) >= 5;
  const ready = first >= 256 ? reading !== null && reading.stable && reading.grams >= 5 : moved;
  return (
    <>
      {!ready && <p class="sc-wiz__hint">{first >= 256 ? 'Espera a que la báscula se quede quieta.' : 'Cambia el peso (más de 5 g de diferencia) y espera a que se quede quieta.'}</p>}
      <button type="button" class="btn btn--primary btn--block" disabled={!ready} onClick={onYes}>
        <Icon name="Check" size={18} />
        Sí, coincide
      </button>
      <button type="button" class="btn btn--block" onClick={onNo}>
        No coincide
      </button>
    </>
  );
}

function WeighStep({ device, notice, title, onLearned }: { device: ScaleAdvert; notice: string | null; title: { current: HTMLHeadingElement | null }; onLearned: (outcome: LearnOutcome, first: number) => void }): JSX.Element {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const value = parseDecimal(typed, UNITS.g);
  const submit = (): void => {
    if (value === null || value <= 0 || value > MAX_SCALE_G) {
      setError(`Escribe un número entre 1 y ${MAX_SCALE_G.toLocaleString('es-ES')}.`);
      return;
    }
    setError(null);
    onLearned(learnWeight(value), value);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3 class="sc-wiz__title" ref={title} tabIndex={-1}>
        Pon algo en la báscula
      </h3>
      <p class="sc-wiz__text">Espera a que se quede quieta y escribe lo que marca su pantalla, en gramos. Mejor algo de más de 100 g (una fruta, un vaso con agua).</p>
      {notice !== null && <Banner tone="warn">{notice}</Banner>}
      <div class="field">
        <label for="scale-typed">Lo que marca (g)</label>
        <input id="scale-typed" class="input" inputMode="decimal" autocomplete="off" value={typed} aria-invalid={error !== null ? 'true' : undefined} onInput={(e) => setTyped(e.currentTarget.value)} />
        {error !== null && (
          <span class="field__hint meal__error" role="alert">
            {error}
          </span>
        )}
        <p class="field__hint">Si marca oz, lb o ml, pulsa UNIT en la báscula hasta ver g. Ahora lee {scaleState.value.frames} datos de {nameOf(device)}.</p>
      </div>
      <button type="submit" class="btn btn--primary btn--block" disabled={typed.trim() === ''}>
        <Icon name="Check" size={18} />
        Aprender
      </button>
    </form>
  );
}
