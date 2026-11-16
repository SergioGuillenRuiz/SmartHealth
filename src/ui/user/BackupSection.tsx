import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { reloadAll, saveSettings, wipeAllData } from '../../app/actions';
import { saveTextFile } from '../../app/files';
import { isNative } from '../../app/native';
import { svc } from '../../app/services';
import { bumpData, nowMs, settings, showToast } from '../../app/state';
import { MAX_BACKUP_BYTES, BackupError, parseBackup, type ParsedBackup } from '../../data/backup';
import { backupOverdue, BACKUP_REMINDER_DAYS } from '../../domain/backup-reminder';
import { dayKeyOf } from '../../domain/dates';
import { fmtAgo, fmtInt } from '../format';
import { useAsync } from '../hooks';
import { Icon } from '../icons';
import { Banner } from '../primitives';
import { Sheet } from '../Sheet';
import { RingDiagnosisSheet } from './RingDiagnosis';

interface PendingImport {
  raw: unknown;
  parsed: ParsedBackup;
  fileName: string;
}

const COUNT_LABELS: ReadonlyArray<{ key: 'buckets' | 'heart' | 'spo2' | 'sleep' | 'workouts' | 'meals' | 'water' | 'profile'; one: string; many: string }> = [
  { key: 'buckets', one: 'franja de actividad', many: 'franjas de actividad' },
  { key: 'heart', one: 'lectura de pulso', many: 'lecturas de pulso' },
  { key: 'spo2', one: 'lectura de oxígeno', many: 'lecturas de oxígeno' },
  { key: 'sleep', one: 'noche de sueño', many: 'noches de sueño' },
  { key: 'workouts', one: 'entrenamiento', many: 'entrenamientos' },
  { key: 'meals', one: 'comida anotada', many: 'comidas anotadas' },
  { key: 'water', one: 'toma de agua', many: 'tomas de agua' },
  { key: 'profile', one: 'entrada de perfil', many: 'entradas de perfil' },
];

async function persistedState(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

/** «Datos y copias de seguridad»: lo guardado en este dispositivo, exportar e importar copias, el diagnóstico del anillo y borrarlo todo. */
export function BackupSection(): JSX.Element {
  const { data: stats } = useAsync(() => svc().store.stats(), []);
  const { data: persisted } = useAsync(persistedState, []);
  const [persistedNow, setPersistedNow] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  /** «Reemplazar todo» borra lo actual: pide una segunda confirmación antes de hacerlo. */
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const native = isNative();

  const isPersistent = persistedNow ?? persisted ?? null;

  const exportData = async (): Promise<void> => {
    setError(null);
    try {
      const backup = await svc().store.exportAll();
      // La copia lleva la fecha de ESTA copia (no la de la anterior): si se restaura, la app no debe creer que no hay ninguna.
      const exportedMs = svc().now();
      backup.data.settings = { ...backup.data.settings, lastBackupMs: exportedMs };
      // En el APK el fichero va a Descargas con el plugin propio (el WebView no descarga enlaces): solo se da por exportada si
      // de verdad se guardó.
      const saved = await saveTextFile(`smarthealth-copia-${dayKeyOf(exportedMs)}.json`, JSON.stringify(backup), 'application/json');
      await saveSettings({ lastBackupMs: exportedMs });
      showToast(native ? `Copia guardada en ${saved.location}` : 'Copia exportada');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo exportar la copia.');
    }
  };

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    try {
      // Antes de leerlo entero a memoria: un archivo enorme no es una copia (un año con el anillo son unos pocos MB).
      if (file.size > MAX_BACKUP_BYTES) throw new BackupError('Este archivo es demasiado grande para ser una copia de seguridad de SmartHealth.');
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        throw new BackupError('El archivo no es un JSON válido.');
      }
      setPending({ raw, parsed: parseBackup(raw), fileName: file.name });
    } catch (e) {
      setError(e instanceof BackupError ? e.message : 'No se pudo leer el archivo.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const runImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    try {
      await svc().store.importAll(pending.raw, mode);
      await reloadAll();
      bumpData();
      setPending(null);
      showToast(mode === 'replace' ? 'Copia restaurada' : 'Copia combinada con tus datos');
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : 'No se pudo importar la copia.');
    } finally {
      setBusy(false);
      setConfirmReplace(false);
    }
  };

  const wipe = async (): Promise<void> => {
    setBusy(true);
    try {
      await wipeAllData();
      setConfirmWipe(false);
      showToast('Datos borrados');
    } catch (e) {
      setConfirmWipe(false);
      setError(e instanceof Error ? e.message : 'No se pudo borrar.');
    } finally {
      setBusy(false);
    }
  };

  const protect = async (): Promise<void> => {
    try {
      setPersistedNow((await navigator.storage?.persist?.()) ?? false);
    } catch {
      setPersistedNow(false);
    }
  };

  const counts = stats?.counts ?? {};
  const lastBackupMs = settings.value.lastBackupMs;
  const hasData = (counts.heart ?? 0) + (counts.sleep ?? 0) + (counts.workouts ?? 0) + (counts.buckets ?? 0) + (counts.meals ?? 0) + (counts.water ?? 0) + (counts.dishes ?? 0) > 0;
  const backupStale = hasData && backupOverdue(lastBackupMs, nowMs.value);
  return (
    <div>
      <dl class="data-grid">
        <div class="data-grid__wide">
          <dt>Última copia</dt>
          <dd>{lastBackupMs === null ? 'Ninguna todavía' : fmtAgo(lastBackupMs, nowMs.value)}</dd>
        </div>
      </dl>
      {backupStale && (
        <Banner
          tone="warn"
          action={
            <button type="button" class="linkish" onClick={() => void exportData()}>
              Exportar ahora
            </button>
          }
        >
          {lastBackupMs === null ? 'No tienes ninguna copia de seguridad.' : `Hace más de ${BACKUP_REMINDER_DAYS} días que no exportas una copia.`}
        </Banner>
      )}
      {!native && isPersistent === false && (
        <Banner
          tone="warn"
          action={
            <button type="button" class="linkish" onClick={() => void protect()}>
              Proteger
            </button>
          }
        >
          El navegador podría borrar estos datos si necesita espacio. Pídele que los conserve o haz copias.
        </Banner>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      <div class="btn-row">
        <button type="button" class="btn" onClick={() => void exportData()}>
          <Icon name="Download" size={18} />
          Exportar copia
        </button>
        <button type="button" class="btn" onClick={() => fileInput.current?.click()}>
          <Icon name="Upload" size={18} />
          Importar copia
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        class="sr-only"
        tabIndex={-1}
        aria-label="Archivo de copia de seguridad"
        onChange={(e) => void pickFile(e.currentTarget.files?.[0])}
      />
      <div class="btn-row" style={{ marginTop: '10px' }}>
        <button type="button" class="btn btn--ghost" onClick={() => setDiagnosisOpen(true)}>
          <Icon name="Info" size={18} />
          Diagnóstico del anillo
        </button>
        <button type="button" class="btn btn--danger" onClick={() => setConfirmWipe(true)}>
          <Icon name="Trash2" size={18} />
          Borrar todo
        </button>
      </div>

      <RingDiagnosisSheet open={diagnosisOpen} onClose={() => setDiagnosisOpen(false)} />

      <Sheet
        open={pending !== null}
        onClose={() => {
          if (busy) return;
          setPending(null);
          setConfirmReplace(false);
        }}
        title="Importar copia"
        dismissible={!busy}
      >
        {pending && confirmReplace && (
          <div>
            <p class="sheet__lead">
              <strong>¿Reemplazar todo?</strong> Se borrarán los datos que tienes ahora (actividad, sueño, pulso, entrenamientos, comidas, perfil y ajustes) y se dejarán solo los de <strong>{pending.fileName}</strong>: si la copia es anterior a la alimentación o es de la app base, las comidas anotadas se pierden. No se puede deshacer.
            </p>
            <div class="btn-row">
              <button type="button" class="btn btn--danger" disabled={busy} onClick={() => void runImport('replace')}>
                Sí, reemplazar todo
              </button>
              <button type="button" class="btn" disabled={busy} onClick={() => setConfirmReplace(false)}>
                Volver
              </button>
            </div>
          </div>
        )}
        {pending && !confirmReplace && (
          <div>
            <p class="sheet__lead">
              <strong>{pending.fileName}</strong>
            </p>
            <ul class="plain-list">
              {COUNT_LABELS.map(({ key, one, many }) => (
                <li key={key}>
                  <strong>{fmtInt(pending.parsed[key].length)}</strong> {pending.parsed[key].length === 1 ? one : many}
                </li>
              ))}
            </ul>
            {pending.parsed.skipped > 0 && (
              <Banner tone="warn">
                {pending.parsed.skipped === 1
                  ? 'Un registro tiene una fecha imposible y no se importará.'
                  : `${fmtInt(pending.parsed.skipped)} registros tienen una fecha imposible y no se importarán.`}
              </Banner>
            )}
            <div class="btn-row" style={{ marginTop: '14px' }}>
              <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void runImport('merge')}>
                Combinar
              </button>
              <button type="button" class="btn btn--danger" disabled={busy} onClick={() => setConfirmReplace(true)}>
                Reemplazar todo
              </button>
            </div>
            <button type="button" class="btn btn--ghost btn--block" style={{ marginTop: '10px' }} disabled={busy} onClick={() => setPending(null)}>
              Cancelar
            </button>
          </div>
        )}
      </Sheet>

      <Sheet open={confirmWipe} onClose={() => !busy && setConfirmWipe(false)} title="¿Borrar todos los datos?" dismissible={!busy}>
        <p class="sheet__lead">
          Se eliminarán de este dispositivo los datos del anillo, tus entrenamientos, tus comidas, tu perfil y los ajustes, y se olvidará el anillo vinculado. <strong>No se puede deshacer.</strong>
        </p>
        <div class="btn-row">
          <button type="button" class="btn btn--danger" disabled={busy} onClick={() => void wipe()}>
            Sí, borrar todo
          </button>
          <button type="button" class="btn" disabled={busy} onClick={() => setConfirmWipe(false)}>
            Cancelar
          </button>
        </div>
      </Sheet>
    </div>
  );
}
