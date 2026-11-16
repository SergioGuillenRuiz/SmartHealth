import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { svc } from '../app/services';
import { ringUsedByOther } from '../app/state';
import { Icon } from '../ui/icons';
import { useArmed } from '../ui/hooks';
import { Banner, Card, CardHeader } from '../ui/primitives';
import { Sheet } from '../ui/Sheet';
import {
  cancelSelfTest,
  canShareSelfTestReport,
  closeSelfTestSheet,
  copySelfTestSummary,
  readySelfTest,
  selfTestOpen,
  selfTestUi,
  shareSelfTestReport,
  skipSelfTestStep,
  startSelfTest,
} from './actions';
import { STEP_DEFS, type Prompt, type SelfTestUi, type UiStepStatus } from './runner';

// La prueba guiada, vista por la persona: una tarjeta temporal arriba del resumen y la hoja que la guía. Temporal, como
// toda la carpeta (ver `runner.ts`).

/**
 * La prueba guiada está oculta: el código, el informe y sus pruebas siguen ahí para volver a usarla, pero ni la tarjeta ni
 * la hoja se ofrecen salvo con el interruptor `?prueba=1` en la dirección de la app. Lo usan las pruebas automáticas del
 * navegador y del emulador; una persona que la necesite de nuevo la abre con `…/?prueba=1`.
 */
export function selfTestEnabled(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('prueba');
  } catch {
    return false;
  }
}

/** La tarjeta del resumen que abre la prueba (nada mientras la prueba esté oculta). */
export function SelfTestEntry(): JSX.Element | null {
  return selfTestEnabled() ? <SelfTestCard /> : null;
}

/** La hoja de la prueba (nada mientras la prueba esté oculta). */
export function SelfTestMount(): JSX.Element | null {
  return selfTestEnabled() ? <SelfTestSheet /> : null;
}

/** La tarjeta del resumen que abre la prueba. */
export function SelfTestCard(): JSX.Element {
  const ui = selfTestUi.value;
  const inProgress = ui !== null && ui.phase !== 'done';
  return (
    <Card label="Prueba guiada del anillo">
      <CardHeader icon="Activity" title="Prueba guiada del anillo" color="var(--brand)" right={<span class="chip">Temporal</span>} />
      <p class="card__lead">Recorre la app con tu anillo de principio a fin, te va diciendo qué hacer y guarda un fichero en Descargas para que me lo mandes.</p>
      <button type="button" class="btn btn--primary btn--block" onClick={() => (selfTestOpen.value = true)}>
        <Icon name={inProgress ? 'Timer' : 'Play'} size={18} />
        {inProgress ? 'Volver a la prueba en curso' : ui ? 'Ver el resultado de la prueba' : 'Empezar la prueba'}
      </button>
    </Card>
  );
}

export function SelfTestSheet(): JSX.Element {
  const ui = selfTestUi.value;
  const locked = ui !== null && ui.phase !== 'done';
  return (
    // Mientras corre no se cierra con «atrás» ni con el fondo: se sale con «Cancelar la prueba».
    <Sheet open={selfTestOpen.value} onClose={closeSelfTestSheet} title="Prueba guiada del anillo" tall dismissible={!locked}>
      {ui === null ? <Intro /> : ui.phase === 'done' ? <Done ui={ui} /> : <Running ui={ui} />}
    </Sheet>
  );
}

// ───────────────────────────── antes de empezar ─────────────────────────────

function Intro(): JSX.Element {
  const { transport } = svc();
  const other = ringUsedByOther('test');
  return (
    <div class="stest">
      {!transport.available && <Banner tone="danger">{transport.unavailableReason ?? 'Este dispositivo no puede usar Bluetooth desde la app.'}</Banner>}
      {other !== null && <Banner tone="warn">El anillo está en uso: espera a que termine para empezar la prueba.</Banner>}
      <p class="sheet__lead">Dura unos 9 minutos. Te dice qué hacer en cada momento y vibra cuando cambia la fase. Al terminar guarda un fichero en la carpeta Descargas.</p>
      <h3 class="stest__h">Antes de empezar</h3>
      <ul class="plain-list stest__list">
        <li>
          <strong>Smart Health, cerrada del todo</strong> (Ajustes → Aplicaciones → Smart Health → Forzar detención): el anillo solo admite una conexión a la vez. Si el informe dice que «otra app habló con el anillo», es que se despertó en segundo plano: quítale el inicio automático.
        </li>
        <li>
          <strong>Lo ideal es hacerla por la mañana, antes de abrir Smart Health:</strong> así el anillo aún guarda el sueño de anoche, que es lo más difícil de leer bien (si Smart Health ya lo descargó, puede que el anillo ya no lo tenga). Al terminar, abre Smart Health y apunta sus pasos de hoy, el sueño de anoche y el pulso: me sirven para comparar.
        </li>
        <li>Ponte el anillo en el dedo, con algo de batería, y ten el móvil cerca.</li>
        <li>
          Activa el Bluetooth y la ubicación del móvil. Android preguntará dos veces: permite «Dispositivos cercanos» y la ubicación <strong>precisa</strong>, solo mientras se usa la app (con la aproximada no encuentra el anillo).
        </li>
        <li>
          Necesitas sitio para caminar: 30 segundos seguidos en la prueba de pasos y 2 minutos en el entreno. <strong>Guarda el móvil en el bolsillo mientras andas</strong>: si la mano del anillo va quieta sujetándolo, el anillo no cuenta los pasos. No cierres la app ni apagues la pantalla.
        </li>
        <li>Recomendable: rellena antes Salud → Mis datos. La sincronización escribe tu perfil en el anillo (uno genérico si no hay datos).</li>
      </ul>
      <h3 class="stest__h">Qué vas a hacer</h3>
      <StepList steps={STEP_DEFS.map((def) => ({ ...def, status: 'pending' as const, summary: null }))} showHints />
      <button type="button" class="btn btn--primary btn--block btn--big" disabled={!transport.available || other !== null} onClick={() => void startSelfTest()}>
        <Icon name="Play" size={20} />
        Empezar la prueba
      </button>
      <p class="field__hint">
        Versión de la app: {__BUILD_ID__} · compilada el {new Date(__BUILD_TIME__).toLocaleString('es-ES')}
      </p>
    </div>
  );
}

// ───────────────────────────── en curso ─────────────────────────────

function Running({ ui }: { ui: SelfTestUi }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const armed = useArmed(confirming);
  // «Saltar» pide una segunda pulsación: con el móvil en la mano mientras se camina, un roce no debe tirar el paso.
  const [skipArmed, setSkipArmed] = useState(false);
  useEffect(() => {
    if (!skipArmed) return undefined;
    const timer = setTimeout(() => setSkipArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [skipArmed]);
  const phaseTitle = ui.prompt?.title;
  useEffect(() => setSkipArmed(false), [phaseTitle]);
  const saving = ui.phase === 'saving';
  return (
    <div class="stest">
      <PromptView prompt={ui.prompt} cancelling={ui.cancelling} skipping={ui.skipping} />
      <StepList steps={ui.steps} />
      {!saving && !ui.cancelling && (
        <div class="btn-row stest__actions">
          {confirming ? (
            <>
              <button type="button" class="btn" onClick={() => setConfirming(false)}>
                Seguir con la prueba
              </button>
              <button type="button" class="btn btn--danger" disabled={!armed} onClick={() => cancelSelfTest()}>
                Sí, cancelar
              </button>
            </>
          ) : (
            <>
              {!ui.skipping && (
                <button
                  type="button"
                  class="btn btn--small"
                  onClick={() => {
                    if (!skipArmed) return setSkipArmed(true);
                    setSkipArmed(false);
                    skipSelfTestStep();
                  }}
                >
                  {skipArmed ? 'Pulsa otra vez para saltar' : 'Saltar este paso'}
                </button>
              )}
              <button type="button" class="btn btn--small btn--ghost" onClick={() => setConfirming(true)}>
                Cancelar la prueba
              </button>
            </>
          )}
        </div>
      )}
      {confirming && <p class="field__hint">Si cancelas, se guarda lo hecho hasta ahora y el anillo se suelta.</p>}
    </div>
  );
}

/** Segundos que faltan hasta `endsAtMs`, que se refrescan solos. */
function Countdown({ endsAtMs }: { endsAtMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [endsAtMs]);
  const left = Math.max(0, Math.ceil((endsAtMs - now) / 1000));
  return (
    <span class="stest__count" aria-hidden="true">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

function PromptView({ prompt, cancelling, skipping }: { prompt: Prompt | null; cancelling: boolean; skipping: boolean }): JSX.Element {
  const leaving = cancelling || skipping;
  const current = cancelling
    ? { title: 'Cancelando…', text: 'Soltando el anillo y guardando lo hecho hasta ahora.' }
    : skipping
      ? { title: 'Saltando este paso…', text: 'Espero a que acabe lo que estaba haciendo con el anillo: puede tardar hasta un par de minutos.' }
      : prompt;
  return (
    <section class="stest__now" aria-label="Qué hacer ahora" aria-live="polite" aria-atomic="true">
      <h3 class="stest__title">{current?.title ?? 'Un momento…'}</h3>
      {current?.text && <p class="stest__text">{current.text}</p>}
      {prompt?.endsAtMs !== undefined && !leaving && <Countdown endsAtMs={prompt.endsAtMs} />}
      {prompt?.live && !leaving && <p class="stest__live">{prompt.live}</p>}
      {prompt?.button && !leaving && (
        <button type="button" class="btn btn--primary btn--block btn--big" onClick={() => readySelfTest()}>
          {prompt.button}
        </button>
      )}
    </section>
  );
}

// ───────────────────────────── resultado ─────────────────────────────

function Done({ ui }: { ui: SelfTestUi }): JSX.Element {
  const result = ui.result;
  const counts = result?.counts ?? { ok: 0, warn: 0, fail: 0, skipped: 0 };
  return (
    <div class="stest">
      <p class="sr-only" role="status">
        {result?.cancelled ? 'Prueba cancelada.' : 'Prueba terminada.'}
      </p>
      <h3 class="stest__title">{result?.cancelled ? 'Prueba cancelada' : 'Prueba terminada'}</h3>
      <p class="stest__text">
        {counts.ok} bien · {counts.warn} con aviso · {counts.fail} con fallo · {counts.skipped} saltados
      </p>
      {result?.file && !result.saveError && (
        <Banner tone="info" live="status">
          Informe guardado en <strong>{result.file.location}</strong>. Mándamelo y, si puedes, dime qué enseña Smart Health: pasos de hoy, sueño de anoche y pulso.
        </Banner>
      )}
      {result?.saveError && (
        <Banner tone="danger">
          No se pudo guardar el fichero ({result.saveError}).{result.file ? ` Queda un informe parcial en ${result.file.location}.` : ''} Usa «Enviar» o «Copiar resumen».
        </Banner>
      )}
      <div class="btn-row stest__actions">
        {canShareSelfTestReport() && (
          <button type="button" class="btn btn--primary" onClick={() => void shareSelfTestReport()}>
            <Icon name="Share2" size={18} />
            Enviar el fichero
          </button>
        )}
        <button type="button" class="btn" onClick={() => void copySelfTestSummary()}>
          <Icon name="Copy" size={18} />
          Copiar resumen
        </button>
        <button type="button" class="btn btn--ghost" onClick={closeSelfTestSheet}>
          Hecho
        </button>
      </div>
      <StepList steps={ui.steps} />
    </div>
  );
}

// ───────────────────────────── lista de pasos ─────────────────────────────

const MARK: Record<UiStepStatus, { glyph: string; label: string }> = {
  pending: { glyph: '·', label: 'Pendiente' },
  running: { glyph: '…', label: 'En curso' },
  ok: { glyph: '✓', label: 'Bien' },
  warn: { glyph: '!', label: 'Aviso' },
  fail: { glyph: '✕', label: 'Fallo' },
  skipped: { glyph: '–', label: 'Saltado' },
};

function StepList({ steps, showHints }: { steps: SelfTestUi['steps']; showHints?: boolean }): JSX.Element {
  return (
    <ol class="stest__steps" aria-label="Pasos de la prueba">
      {steps.map((step) => {
        const mark = MARK[step.status];
        return (
          <li key={step.id} class={`stest__step stest__step--${step.status}`} aria-current={step.status === 'running' ? 'step' : undefined}>
            <span class="stest__mark" aria-hidden="true">
              {mark.glyph}
            </span>
            <span class="stest__what">
              <strong>{step.title}</strong>
              <span class="sr-only"> — {mark.label}</span>
              {(step.summary ?? (showHints || step.status === 'running' ? step.hint : null)) && <small>{step.summary ?? step.hint}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
