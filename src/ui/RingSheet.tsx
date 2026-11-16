import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { forgetRing, startSync } from '../app/actions';
import { svc } from '../app/services';
import { lastSync, nowMs, ring, ringUse, showToast, syncUi } from '../app/state';
import type { SyncReport } from '../sync/run-sync';
import { fmtAgo, fmtInt, NBSP, plural } from './format';
import { phaseText, SLOW_SYNC_MS } from './ring-report';
import { useArmed, useAsync } from './hooks';
import { Icon, RingIcon } from './icons';
import { Banner, ProgressBar } from './primitives';

/** Lo del anillo dentro del menú de dispositivos (`DevicesSheet.tsx`): vincular, sincronizar y ver cómo ha ido. */
export function RingPanel(): JSX.Element {
  const saved = ring.value;
  const sync = syncUi.value;
  const last = lastSync.value;
  const now = nowMs.value;
  const { transport } = svc();
  const [confirmForget, setConfirmForget] = useState(false);
  const forgetArmed = useArmed(confirmForget);
  const running = sync.status === 'running';
  // El anillo solo admite un uso a la vez (sincronizar, medir el pulso o entrenar).
  const busyWithOther = ringUse.value !== null && ringUse.value !== 'sync';
  // El último intento queda guardado: se avisa de cómo acabó aunque se haya cerrado y reabierto la app.
  const { data: lastAttempt } = useAsync(() => svc().store.listSyncs(1).then((rows) => rows[0] ?? null), [sync.status]);

  return (
    <div>
      <div class="ring-hero">
        <span class="ring-hero__icon">
          <RingIcon size={34} />
        </span>
        <div>
          <div class="ring-hero__name">{saved ? saved.name : 'Sin anillo vinculado'}</div>
          <div class="ring-hero__meta">
            {last
              ? `Última sincronización ${fmtAgo(last.tsMs, now)}${last.batteryPercent !== null ? ` · batería ${last.batteryPercent}${NBSP}%` : ''}`
              : saved
                ? 'Aún no se ha sincronizado'
                : 'Pulsa el botón para buscarlo'}
          </div>
          {last?.firmware && <div class="ring-hero__meta">Firmware {last.firmware}</div>}
        </div>
      </div>

      {!transport.available && (
        <Banner tone="danger">{transport.unavailableReason ?? 'Este navegador no puede usar Bluetooth.'}</Banner>
      )}
      {ringUse.value === 'workout' && <Banner tone="warn">Entrenamiento en curso: termínalo para poder sincronizar.</Banner>}
      {ringUse.value === 'measure' && <Banner tone="warn">Midiendo el pulso: espera a que termine para sincronizar.</Banner>}

      <p class="sr-only" role="status">
        {sync.status === 'done' ? (sync.report.interrupted ? 'Sincronización incompleta.' : 'Sincronización terminada.') : sync.status === 'error' ? `La sincronización ha fallado: ${sync.message}` : ''}
      </p>

      {running && sync.status === 'running' && (
        <div class="progress" aria-live="polite">
          <ProgressBar value={sync.progress.fraction} color="var(--brand)" label="Progreso de la sincronización" />
          <p class="progress__msg">{sync.progress.message}</p>
        </div>
      )}

      {sync.status === 'done' && <ReportView report={sync.report} />}
      {sync.status === 'error' && <Banner tone="danger">{sync.message}</Banner>}
      {sync.status === 'idle' && lastAttempt && (lastAttempt.error || lastAttempt.interrupted) && (
        <Banner tone="warn">
          Último intento {fmtAgo(lastAttempt.tsMs, now)}: {lastAttempt.error ? `falló — ${lastAttempt.error}` : 'incompleto'}.
        </Banner>
      )}

      <div class="btn-row" style={{ marginTop: '14px' }}>
        <button
          type="button"
          class="btn btn--primary btn--block"
          disabled={running || !transport.available || busyWithOther}
          onClick={() => void startSync()}
        >
          <Icon name={running ? 'RefreshCw' : 'Bluetooth'} size={18} />
          {running ? 'Sincronizando…' : saved ? 'Sincronizar ahora' : 'Vincular y sincronizar'}
        </button>
      </div>

      {saved && !running && (
        <div class="btn-row" style={{ marginTop: '10px' }}>
          <button type="button" class="btn btn--small" disabled={!transport.available || busyWithOther} onClick={() => void startSync({ forcePick: true })}>
            Elegir otro anillo
          </button>
          {confirmForget ? (
            <button
              type="button"
              class="btn btn--small btn--danger"
              disabled={!forgetArmed}
              onClick={() => {
                void forgetRing().then(() => showToast('Anillo olvidado. Tus datos guardados siguen aquí.'));
                setConfirmForget(false);
              }}
            >
              Confirmar: olvidar anillo
            </button>
          ) : (
            <button type="button" class="btn btn--small btn--ghost" onClick={() => setConfirmForget(true)}>
              <Icon name="Unlink" size={15} />
              Olvidar anillo
            </button>
          )}
        </div>
      )}

      {!running && (
        <div class="ring-more">
          <button type="button" class="linkish" disabled={!transport.available || busyWithOther} onClick={() => void startSync({ forcePick: true, showAll: true })}>
            Mostrar todos los dispositivos Bluetooth
          </button>
        </div>
      )}
    </div>
  );
}

function ReportView({ report }: { report: SyncReport }): JSX.Element {
  const nothingNew = report.added.buckets + report.added.sleep + report.added.heart + report.added.spo2 === 0;
  return (
    <div>
      {report.warnings.map((w) => (
        <Banner tone="warn" key={w}>
          {w}
        </Banner>
      ))}
      <ul class="report" aria-label="Resultado de la sincronización">
        <li>
          <Icon name="Check" size={18} />
          <span>
            {report.interrupted ? 'Sincronización incompleta' : 'Sincronizado'} en {Math.max(1, Math.round(report.durationMs / 1000))} s
            {report.liveSteps !== null ? ` · ${fmtInt(report.liveSteps)} pasos hoy` : ''}
            {report.durationMs > SLOW_SYNC_MS ? ` (${phaseText(report.phases)})` : ''}
          </span>
        </li>
        {nothingNew && !report.interrupted && (
          <li>
            <Icon name="Check" size={18} />
            <span>Ya estaba todo al día</span>
          </li>
        )}
        {Object.entries(report.dropped).map(([reason, n]) => (
          <li key={reason}>
            <Icon name="TriangleAlert" size={18} />
            <span>
              {plural(n, 'descartado', 'descartados')}: {reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
