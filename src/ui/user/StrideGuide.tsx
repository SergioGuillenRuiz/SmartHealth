import type { JSX } from 'preact';
import { cancelStrideCalibration, finishStrideCalibration, startStrideCalibration, strideActive, strideBlocked, strideOutcome, useMeasuredStride } from '../../app/stride-calibration';
import { calibrateOpen, liveWorkout, nowMs, profileHistory, showToast } from '../../app/state';
import { reconnectWorkoutRing } from '../../app/workout-actions';
import { dayKeyOf } from '../../domain/dates';
import { baseStride } from '../../domain/estimation';
import { profileAt } from '../../domain/profile';
import { CALIBRATION_MIN_M, CALIBRATION_TARGET_M, type StrideFlaw, type StrideMeasurement } from '../../domain/stride';
import { fmt1, fmtInt, fmtTimer } from '../format';
import { Icon } from '../icons';
import { Banner, ProgressBar } from '../primitives';

// La calibración de la zancada guiada: tres momentos —explicación, paseo y resultado— en la misma hoja. Lo único que la persona hace es pulsar «Empezar», caminar
// a su paso y, al final, «Usar esta zancada». El GPS y los pasos del anillo los pone la app (ver `app/stride-calibration.ts`).

const FLAW_TEXT: Readonly<Record<StrideFlaw, string>> = {
  short: 'El paseo fue corto.',
  'gps-gaps': 'El GPS perdió la señal a ratos.',
  cadence: 'Ibas más rápido que una marcha normal.',
  'far-from-height': 'Sale muy distinta de la que correspondería a tu altura.',
};

const FAILURE_TEXT = {
  'no-gps': 'No llegó la distancia del GPS. Prueba en un sitio abierto y con el permiso de ubicación concedido.',
  'no-steps': 'El anillo no contó pasos. Comprueba que lo llevas puesto y vuelve a intentarlo.',
  'too-short': 'El paseo fue demasiado corto para medir nada. Camina al menos 150 m sin parar.',
  implausible: 'Los datos no cuadran (la zancada sale fuera de lo posible). Repítelo en un tramo recto y a paso normal.',
} as const;

export function StrideGuide({ onManual }: { onManual: () => void }): JSX.Element {
  const today = dayKeyOf(nowMs.value);
  const current = profileAt(profileHistory.value, today);
  if (!current) return <Banner tone="warn">Primero introduce tus datos personales.</Banner>;
  const outcome = strideOutcome.value;
  if (outcome) return <Result onManual={onManual} />;
  if (strideActive.value) return <Walking onManual={onManual} />;
  return <Intro currentCm={baseStride(current).meters * 100} onManual={onManual} />;
}

function ManualLink({ onManual }: { onManual: () => void }): JSX.Element {
  return (
    <button type="button" class="linkish stride-guide__manual" onClick={onManual}>
      Prefiero escribir los datos a mano
    </button>
  );
}

function Intro({ currentCm, onManual }: { currentCm: number; onManual: () => void }): JSX.Element {
  const blocked = strideBlocked.value;
  return (
    <div class="stride-guide">
      <p class="stride-guide__lead">
        Camina unos <strong>{CALIBRATION_TARGET_M} m</strong> a tu paso de siempre. La app mide la distancia con el GPS, cuenta los pasos con el anillo y calcula tu zancada sola.
      </p>
      <ol class="stride-guide__steps">
        <li>Sal a un sitio abierto (una calle despejada, un parque) con el anillo puesto.</li>
        <li>Pulsa «Empezar» y espera a que el GPS esté listo.</li>
        <li>Camina sin parar ni correr. La app te avisa cuando llegues.</li>
      </ol>
      <p class="field__hint">Ahora la app usa una zancada de {fmt1(currentCm)} cm.</p>
      {blocked && <Banner tone="warn">{blocked}</Banner>}
      <button type="button" class="btn btn--primary btn--block" onClick={() => void startStrideCalibration()}>
        <Icon name="Footprints" size={18} />
        Empezar
      </button>
      <ManualLink onManual={onManual} />
    </div>
  );
}

function Walking({ onManual }: { onManual: () => void }): JSX.Element {
  const live = liveWorkout.value?.purpose === 'stride' ? liveWorkout.value : null;
  const snap = live?.snapshot ?? null;
  if (!live || !snap) {
    return (
      <div class="stride-guide">
        <p class="stride-guide__lead">Conectando con el anillo…</p>
        <p class="field__hint">Si se abre el selector de Bluetooth, elige tu anillo. Si Android pide el permiso de ubicación, acéptalo.</p>
        <button type="button" class="btn btn--ghost btn--block" onClick={() => void cancelStrideCalibration()}>
          Cancelar
        </button>
      </div>
    );
  }
  const distance = snap.distanceSource === 'gps' ? (snap.distanceM ?? 0) : 0;
  const ready = snap.gps === 'good';
  const walking = distance >= 10;
  const canFinish = distance >= CALIBRATION_MIN_M;
  return (
    <div class="stride-guide">
      {live.ringLost && (
        <Banner
          tone="warn"
          live="alert"
          action={
            <button type="button" class="linkish" onClick={() => void reconnectWorkoutRing()}>
              Reconectar
            </button>
          }
        >
          Se perdió la conexión con el anillo: sin él no hay pasos que contar.
        </Banner>
      )}
      {!live.features.steps && (
        <Banner tone="warn">
          Tu anillo no manda los pasos en directo, así que así no se puede medir. <button type="button" class="linkish" onClick={onManual}>Escribir los datos a mano</button>
        </Banner>
      )}
      {live.warnings.map((warning) => (
        <Banner tone="warn" key={warning}>
          {warning}
        </Banner>
      ))}
      <p class="stride-guide__lead" aria-live="polite">
        {!walking && !ready
          ? 'Buscando señal GPS… quédate quieto en un sitio abierto.'
          : !walking
            ? 'GPS listo. Empieza a caminar a tu paso normal.'
            : canFinish
              ? 'Sigue hasta el final, o termina cuando quieras.'
              : 'Sigue caminando sin parar.'}
      </p>
      <div class="metric metric--hero">
        <span class="metric__label">Distancia (GPS)</span>
        <span class="metric__value" style={{ color: 'var(--distance)' }}>
          {fmtInt(distance)}
          <small>m</small>
        </span>
        <span class="metric__sub">de {CALIBRATION_TARGET_M} m</span>
      </div>
      <ProgressBar value={distance / CALIBRATION_TARGET_M} color="var(--distance)" label="Avance del paseo de calibración" />
      <div class="live__grid" style={{ marginTop: '10px' }}>
        <div class="metric">
          <span class="metric__label">Pasos</span>
          <span class="metric__value" style={{ color: 'var(--steps)' }}>
            {snap.steps === null ? '—' : fmtInt(snap.steps)}
          </span>
        </div>
        <div class="metric">
          <span class="metric__label">Tiempo</span>
          <span class="metric__value">{fmtTimer(snap.activeMs)}</span>
        </div>
      </div>
      <div class="btn-row" style={{ marginTop: '14px' }}>
        <button type="button" class="btn btn--primary" disabled={!canFinish} onClick={() => void finishStrideCalibration()}>
          Terminar
        </button>
        <button type="button" class="btn btn--ghost" onClick={() => void cancelStrideCalibration()}>
          Cancelar
        </button>
      </div>
      {!canFinish && <p class="field__hint">Podrás terminar a partir de {CALIBRATION_MIN_M} m.</p>}
    </div>
  );
}

function verdictText(measurement: StrideMeasurement): string {
  if (measurement.verdict === 'good') return 'Medida fiable.';
  if (measurement.verdict === 'fair') return 'Medida aproximada: repítela para confirmarla.';
  return 'Medida poco fiable: repítela.';
}

function Result({ onManual }: { onManual: () => void }): JSX.Element {
  const outcome = strideOutcome.value;
  const current = profileAt(profileHistory.value, dayKeyOf(nowMs.value));
  const currentCm = current ? baseStride(current).meters * 100 : null;
  const again = (): void => {
    strideOutcome.value = null;
    strideActive.value = false;
  };
  if (!outcome) return <></>;
  if (!outcome.ok) {
    return (
      <div class="stride-guide">
        <Banner tone="warn">{FAILURE_TEXT[outcome.reason]}</Banner>
        <button type="button" class="btn btn--primary btn--block" onClick={again}>
          Repetir
        </button>
        <ManualLink onManual={onManual} />
      </div>
    );
  }
  const { measurement } = outcome;
  const far = currentCm !== null && Math.abs(measurement.cm - currentCm) / currentCm > 0.15;
  return (
    <div class="stride-guide">
      <div class="metric metric--hero">
        <span class="metric__label">Tu zancada</span>
        <span class="metric__value" style={{ color: 'var(--distance)' }}>
          {fmt1(measurement.cm)}
          <small>cm</small>
        </span>
        <span class="metric__sub">
          {fmtInt(measurement.distanceM)} m con {fmtInt(measurement.steps)} pasos
          {currentCm !== null ? ` · ahora usa ${fmt1(currentCm)} cm` : ''}
        </span>
      </div>
      <Banner tone={measurement.verdict === 'good' ? 'info' : 'warn'}>
        {verdictText(measurement)}
        {measurement.flaws.length > 0 && ` ${measurement.flaws.map((flaw) => FLAW_TEXT[flaw]).join(' ')}`}
        {measurement.verdict === 'good' && far ? ' Se aparta más de un 15 % de la actual: es lo esperable si la de antes salía de tu altura.' : ''}
      </Banner>
      <button
        type="button"
        class={`btn btn--block ${measurement.verdict === 'poor' ? '' : 'btn--primary'}`}
        onClick={() => {
          void useMeasuredStride(measurement.cm)
            .then(() => {
              calibrateOpen.value = false;
              showToast(`Zancada fijada en ${fmt1(measurement.cm)} cm`);
            })
            .catch(() => showToast('No se pudo guardar la zancada.', 'error'));
        }}
      >
        {measurement.verdict === 'poor' ? 'Usarla de todos modos' : 'Usar esta zancada desde hoy'}
      </button>
      <button type="button" class={`btn btn--block ${measurement.verdict === 'poor' ? 'btn--primary' : 'btn--ghost'}`} onClick={again}>
        Repetir
      </button>
    </div>
  );
}
