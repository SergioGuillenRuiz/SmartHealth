import type { JSX } from 'preact';
import { svc } from '../../app/services';
import { bumpData, lastSync, nowMs, ring, ringCapabilities, ringSheetOpen, settings, syncUi } from '../../app/state';
import { fmtAgo, NBSP } from '../format';
import { useAsync } from '../hooks';
import { Icon } from '../icons';
import { LoadError } from '../primitives';
import { Sheet } from '../Sheet';
import { diagnoseRing } from './ring-diagnosis';

/**
 * «Diagnóstico del anillo»: cómo está de un vistazo (si todo va bien o qué conviene mirar, la batería, cuándo se sincronizó y
 * si está midiendo) y, si hace falta, el atajo a la hoja del anillo para vincularlo o sincronizar.
 */
export function RingDiagnosisSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Sheet open={open} onClose={onClose} title="Diagnóstico del anillo">
      {open && <DiagnosisBody />}
    </Sheet>
  );
}

/** «cada 30 min», «cada 2 h». */
const everyText = (minutes: number): string => (minutes >= 120 && minutes % 60 === 0 ? `cada ${minutes / 60}${NBSP}h` : `cada ${minutes}${NBSP}min`);

/** Lo que mide el anillo por su cuenta: «Pulso y oxígeno cada 60 min» (si los intervalos difieren, cada uno con el suyo: una copia puede traerlos distintos). */
const autoMeasureText = (heartMin: number, spo2Min: number): string =>
  heartMin === spo2Min ? `Pulso y oxígeno ${everyText(heartMin)}` : `Pulso ${everyText(heartMin)} · oxígeno ${everyText(spo2Min)}`;

function DiagnosisBody(): JSX.Element | null {
  const saved = ring.value;
  const last = lastSync.value;
  const now = nowMs.value;
  const sync = syncUi.value;
  const { heartIntervalMin, spo2IntervalMin } = settings.value;
  // Lo que sale de un intento nuevo (bien o mal) cambia el diagnóstico: se vuelve a leer al acabar la sincronización.
  const { data, error } = useAsync(async () => {
    const { store } = svc();
    return { attempt: (await store.listSyncs(1))[0] ?? null, latest: await store.latestData(), firstDataMs: (await store.stats()).firstDataMs };
  }, [sync.status, last?.tsMs]);
  if (error) return <LoadError error={error} onRetry={bumpData} />;
  if (!data) return null;

  const diagnosis = diagnoseRing({ nowMs: now, linked: saved !== null, lastSync: last, lastAttempt: data.attempt, latest: data.latest, capabilities: ringCapabilities.value, firstDataMs: data.firstDataMs });
  const { battery, findings } = diagnosis;
  const ago = (ms: number | null): string => (ms === null ? '—' : fmtAgo(ms, now));
  return (
    <div>
      <section class={`verdict verdict--${diagnosis.tone}`} aria-label="Estado del anillo">
        <h3 class="verdict__title">
          <Icon name={diagnosis.tone === 'ok' ? 'Check' : 'TriangleAlert'} size={20} />
          {diagnosis.headline}
        </h3>
        {findings.length > 0 && (
          <ul class="verdict__list">
            {findings.map((f) => (
              <li key={f.text}>{f.text}</li>
            ))}
          </ul>
        )}
      </section>

      {saved && (
        <dl class="data-grid">
          <div class="data-grid__wide">
            <dt>Anillo</dt>
            <dd>{saved.name}</dd>
          </div>
          <div>
            <dt>Batería</dt>
            <dd>
              {battery ? `${battery.percent}${NBSP}%` : '—'}
              {battery && <small>{fmtAgo(battery.tsMs, now)}</small>}
            </dd>
          </div>
          <div>
            <dt>Firmware</dt>
            <dd>{last?.firmware ?? '—'}</dd>
          </div>
          <div class="data-grid__wide">
            <dt>Última sincronización</dt>
            <dd>
              {last ? fmtAgo(last.tsMs, now) : 'Ninguna todavía'}
              {last && <small>en {Math.max(1, Math.round(last.durationMs / 1000))}{NBSP}s</small>}
            </dd>
          </div>
          <div class="data-grid__wide">
            <dt>Medición automática</dt>
            <dd>{autoMeasureText(heartIntervalMin, spo2IntervalMin)}</dd>
          </div>
        </dl>
      )}

      <h3 class="detail-title">Último dato guardado</h3>
      <dl class="data-grid">
        <div>
          <dt>Pulso</dt>
          <dd>{ago(data.latest.heartMs)}</dd>
        </div>
        <div>
          <dt>Oxígeno</dt>
          <dd>{ago(data.latest.spo2Ms)}</dd>
        </div>
        <div>
          <dt>Actividad</dt>
          <dd>{ago(data.latest.activityMs)}</dd>
        </div>
        <div>
          <dt>Sueño</dt>
          <dd>{ago(data.latest.sleepEndMs)}</dd>
        </div>
      </dl>

      {diagnosis.action && (
        <button type="button" class="btn btn--primary btn--block" onClick={() => (ringSheetOpen.value = true)}>
          <Icon name="Bluetooth" size={18} />
          {diagnosis.action === 'link' ? 'Ir a vincular el anillo' : 'Ir a sincronizar'}
        </button>
      )}
    </div>
  );
}
