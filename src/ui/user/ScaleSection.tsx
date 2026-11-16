import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { forgetScale, scaleSaved, scaleSupport, stopScaleNow } from '../../app/scale';
import { showToast } from '../../app/state';
import { useArmed } from '../hooks';
import { Icon } from '../icons';
import { Banner } from '../primitives';
import { LiveWeight, scaleStatusText } from '../scale/live';
import { ReportButton, ScaleSetup } from '../scale/ScaleSetup';
import { scaleState } from '../../app/scale';
import { fmtDateFull } from '../format';
import { dayKeyOf } from '../../domain/dates';

// «Báscula de cocina» (menú de dispositivos, dentro de su tarjeta): conectarla la primera vez, ver que funciona (el peso en vivo), guardar el informe para diagnosticarla, volver a emparejarla u olvidarla.
// Pesar comida se hace desde «He comido algo».

function ForgetScale({ onForget }: { onForget: () => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const armed = useArmed(asking);
  if (!asking) {
    return (
      <button type="button" class="btn btn--block" onClick={() => setAsking(true)}>
        Olvidar la báscula
      </button>
    );
  }
  return (
    <div class="meal__quick">
      <button type="button" class="btn btn--danger" disabled={!armed} onClick={onForget}>
        Sí, olvidarla
      </button>
      <button type="button" class="btn" onClick={() => setAsking(false)}>
        No
      </button>
    </div>
  );
}

export function ScaleSection(): JSX.Element {
  const support = scaleSupport();
  const saved = scaleSaved.value;
  // El asistente sigue en pantalla hasta que se pulsa «Listo», aunque la báscula ya esté guardada.
  const [wizard, setWizard] = useState(scaleSaved.peek() === null);

  // Esta hoja NO conecta la báscula: se abre para sincronizar el anillo y una búsqueda Bluetooth de la báscula a la vez lo dejaba hasta 2 minutos conectando y saludando. La báscula se conecta
  // cuando se pesa («He comido algo» → «Pesar con la báscula») y en el asistente de emparejado, que tiene su propia conexión.

  if (!support.available) return <Banner tone="warn">{support.reason}</Banner>;
  if (wizard || saved === null) return <ScaleSetup embedded onDone={() => setWizard(false)} />;
  return (
    <div class="sc-section">
      <div class="sc-card">
        <span class="sc-card__icon">
          <Icon name="Scale" size={22} />
        </span>
        <div>
          <strong>{saved.name}</strong>
          <small>{saved.pairedMs > 0 ? `Emparejada el ${fmtDateFull(dayKeyOf(saved.pairedMs))}` : 'Emparejada'}</small>
        </div>
      </div>
      {scaleState.value.status !== 'idle' && <LiveWeight />}
      <p class="sc-hint">{scaleState.value.status === 'idle' ? 'Se conecta al pesar.' : `${scaleStatusText(scaleState.value)}.`} Para pesar comida: «He comido algo» → «Pesar con la báscula».</p>
      <ReportButton />
      <button
        type="button"
        class="btn btn--block"
        onClick={() => {
          void stopScaleNow().then(() => setWizard(true));
        }}
      >
        <Icon name="RefreshCw" size={18} />
        Volver a emparejar
      </button>
      <ForgetScale
        onForget={() =>
          void forgetScale().then(() => {
            showToast('Báscula olvidada.');
          })
        }
      />
    </div>
  );
}
