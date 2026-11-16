import type { JSX } from 'preact';
import { cancelMeasure, measureHeartRateNow } from '../app/actions';
import { measureSheetOpen, measureUi, ringUse, ringUsedByOther } from '../app/state';
import { svc } from '../app/services';
import { Icon } from './icons';
import { Banner } from './primitives';
import { Sheet } from './Sheet';

/** Medida puntual de pulso con el anillo: conecta, mide unos 35 s, guarda y desconecta. */
export function MeasureSheet(): JSX.Element {
  const open = measureSheetOpen.value;
  const state = measureUi.value;
  const { transport } = svc();
  const busy = state.status === 'connecting' || state.status === 'measuring';
  // El anillo solo admite un uso a la vez (sincronizar, medir el pulso o entrenar).
  const other = ringUsedByOther('measure');
  // La medida ya no corre (terminó o se canceló) pero el anillo aún se está soltando: hasta entonces no se puede empezar otra
  // (la reserva sigue siendo suya y un nuevo intento solo recibiría un aviso).
  const releasing = ringUse.value === 'measure' && !busy;

  return (
    <Sheet
      open={open}
      onClose={() => {
        // Cerrar la hoja a mitad de una medida la cancela: así el sensor no se queda encendido ni la hoja a medias.
        if (busy) cancelMeasure();
        measureSheetOpen.value = false;
        if (state.status !== 'idle') measureUi.value = { status: 'idle' };
      }}
      title="Medir el pulso"
    >
      {!transport.available && <Banner tone="danger">{transport.unavailableReason}</Banner>}
      {other === 'workout' && <Banner tone="warn">Hay un entrenamiento en curso: el pulso ya se está midiendo.</Banner>}
      {other === 'sync' && <Banner tone="warn">Se está sincronizando. Espera a que termine para medir el pulso.</Banner>}
      <p class="sr-only" role="status">
        {state.status === 'done' ? `Lectura guardada: ${state.bpm} latidos por minuto.` : state.status === 'error' ? state.message : ''}
      </p>
      <div class="measure">
        {state.status === 'idle' && (
          <p class="measure__text">
            Coloca el anillo bien ajustado y quédate quieto. La medida dura unos 35 segundos (el sensor tarda ~28 s en dar valores válidos); al terminar, la app suelta la conexión.
          </p>
        )}
        {state.status === 'connecting' && <p class="measure__text">Conectando con el anillo…</p>}
        {state.status === 'cancelling' && <p class="measure__text">Cancelando… soltando el anillo.</p>}
        {state.status === 'measuring' && (
          <>
            <div class="measure__value" aria-live="polite">
              {state.live ?? '—'}
              <span>lpm</span>
            </div>
            <p class="measure__text">{state.live === null ? 'El sensor se está calentando… no te muevas.' : 'Midiendo… el anillo cerrará la medida en unos segundos.'}</p>
          </>
        )}
        {state.status === 'done' && (
          <>
            <div class="measure__value measure__value--done">
              {state.bpm}
              <span>lpm</span>
            </div>
            <p class="measure__text">
              <Icon name="Check" size={16} /> Lectura guardada en tu historial de hoy.
            </p>
          </>
        )}
        {state.status === 'error' && <Banner tone="danger">{state.message}</Banner>}
      </div>
      {busy ? (
        <button type="button" class="btn btn--block" onClick={cancelMeasure}>
          Cancelar medida
        </button>
      ) : (
        <button
          type="button"
          class="btn btn--primary btn--block"
          disabled={!transport.available || other !== null || releasing}
          onClick={() => void measureHeartRateNow()}
        >
          <Icon name="HeartPulse" size={18} />
          {releasing ? 'Soltando el anillo…' : state.status === 'done' ? 'Medir otra vez' : 'Empezar medida'}
        </button>
      )}
    </Sheet>
  );
}
