import type { JSX } from 'preact';
import { hasRing, hasScale, ringBusy, setHasRing, setHasScale } from '../app/devices';
import { scaleSupport } from '../app/scale';
import { ringSheetOpen } from '../app/state';
import { Icon, RingIcon } from './icons';
import { RingPanel } from './RingSheet';
import { Sheet } from './Sheet';
import { ScaleSection } from './user/ScaleSection';

// El menú de dispositivos (el botón de arriba a la derecha): el anillo y la báscula, cada uno con un interruptor de «lo tengo». El anillo ofrece aquí lo suyo (vincular, sincronizar…); la
// báscula se empareja y se gestiona aquí mismo (conectarla, ver su peso, guardar el informe, volver a emparejarla u olvidarla). Apagado, la app deja de usarlo y lo que depende de él no sale (o sale «no disponible» donde iría un dato), sin borrar nada de lo guardado.

export function DevicesSheet(): JSX.Element {
  return (
    <Sheet open={ringSheetOpen.value} onClose={() => (ringSheetOpen.value = false)} title="Dispositivos">
      <div class="devices">
        <RingDevice />
        <ScaleDevice />
      </div>
    </Sheet>
  );
}

function RingDevice(): JSX.Element {
  const on = hasRing.value;
  // Con el anillo en uso por algo que pidió la persona (sincronizando a mano, midiendo o entrenando) no se puede apagar: dejaría esa tarea a medias.
  const busy = ringBusy();
  return (
    <section class="device" aria-labelledby="device-ring">
      <h3 class="device__title" id="device-ring">
        <RingIcon size={20} />
        Anillo
      </h3>
      <label class="switch">
        <input type="checkbox" checked={on} disabled={busy && on} onChange={(e) => void setHasRing(e.currentTarget.checked)} />
        <span class="switch__track" aria-hidden="true" />
        <span class="switch__text">
          Tengo el anillo
          <small>{on ? 'Sincroniza sus datos y mide el pulso en los entrenos.' : 'Sin él no se sincroniza nada y sus gráficas salen «no disponibles».'}</small>
        </span>
      </label>
      {on ? (
        <RingPanel />
      ) : (
        <p class="device__off">
          Sin anillo solo se puede entrenar andando, medido con el móvil. Tus datos guardados del anillo siguen aquí y vuelven a verse al encenderlo.
        </p>
      )}
    </section>
  );
}

function ScaleDevice(): JSX.Element {
  const on = hasScale.value;
  return (
    <section class="device" aria-labelledby="device-scale">
      <h3 class="device__title" id="device-scale">
        <Icon name="kitchen-scale" size={20} />
        Báscula de cocina
      </h3>
      <label class="switch">
        <input type="checkbox" checked={on} onChange={(e) => void setHasScale(e.currentTarget.checked)} />
        <span class="switch__track" aria-hidden="true" />
        <span class="switch__text">
          Tengo la báscula
          <small>{on ? 'Pesa la comida sola al anotarla en «He comido algo».' : 'Sin ella, «Pesar con la báscula» no aparece al anotar una comida.'}</small>
        </span>
      </label>
      {on ? scaleSupport().available && <ScaleSection /> : <p class="device__off">La báscula emparejada se conserva: al encenderla otra vez no hay que volver a emparejarla.</p>}
    </section>
  );
}
