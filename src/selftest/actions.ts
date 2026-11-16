import { signal } from '@preact/signals';
import { reloadAll } from '../app/actions';
import { isNative } from '../app/native';
import { svc } from '../app/services';
import { autoHoldsRing, bumpData, claimRing, profileHistory, showToast, yieldRingToUser } from '../app/state';
import { browserPlatform } from '../app/workout-controller';
import { dayKeyOf } from '../domain/dates';
import { resolveProfile } from '../domain/summary';
import { vibrateCue } from './cues';
import { collectPhoneInfo } from './phone';
import { reportFilename } from './report';
import { SelfTest, type SelfTestUi } from './runner';
import { createReportSaver, type ReportSaver } from './save';

// Pegamento entre la prueba guiada y la interfaz: la hoja abierta, lo que se muestra y los botones. Temporal, como toda la
// carpeta (ver `runner.ts`).

export const selfTestOpen = signal(false);
/** Lo que muestra la hoja; `null` mientras no se haya empezado (se ve la explicación previa). */
export const selfTestUi = signal<SelfTestUi | null>(null);

/** En la demostración las esperas se reducen para recorrer la prueba entera en unos segundos. */
const DEMO_TIME_SCALE = 0.02;

let current: SelfTest | null = null;
let saver: ReportSaver | null = null;

export const selfTestRunning = (): boolean => current !== null;

/** Empieza la prueba. Debe llamarse desde un gesto de la persona (en web el selector de Bluetooth lo exige). */
export async function startSelfTest(): Promise<void> {
  if (current) return;
  // Si la actualización automática tiene el anillo, la prueba va antes: se le hace soltarlo.
  if (autoHoldsRing()) await yieldRingToUser();
  if (current) return;
  const release = claimRing('test');
  if (!release) return;
  const { store, transport, now, demo, hrTiming } = svc();
  saver = createReportSaver(reportFilename(new Date(now())));
  const test = new SelfTest({
    transport,
    store,
    now,
    saver,
    getProfile: () => resolveProfile(profileHistory.value, dayKeyOf(now())).profile,
    onUpdate: (ui) => {
      selfTestUi.value = ui;
    },
    phone: collectPhoneInfo,
    app: { build: __BUILD_ID__, builtAt: __BUILD_TIME__, native: isNative(), demo },
    cue: vibrateCue,
    platform: browserPlatform(),
    ...(demo ? { timeScale: DEMO_TIME_SCALE } : {}),
    ...(hrTiming ? { hrTiming } : {}),
  });
  current = test;
  try {
    await test.run();
  } catch (error) {
    // `run` no lanza: esto sería un fallo de la propia prueba.
    selfTestUi.value = null;
    showToast(`La prueba se detuvo por un error interno: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    current = null;
    release();
    // La prueba vincula el anillo y sincroniza de verdad: se actualiza lo que muestra la app.
    await reloadAll().catch(() => undefined);
    bumpData();
  }
}

export const readySelfTest = (): void => current?.ready();
export const skipSelfTestStep = (): void => current?.skip();
export const cancelSelfTest = (): void => current?.cancel();

/** Cierra la hoja. Una prueba terminada se olvida (la próxima vez se verá la explicación); una en curso sigue. */
export function closeSelfTestSheet(): void {
  selfTestOpen.value = false;
  if (!current) selfTestUi.value = null;
}

export const canShareSelfTestReport = (): boolean => saver?.canShare() ?? false;

/** Abre el menú de compartir con el informe guardado (o, si no se pudo guardar, con el resumen). */
export async function shareSelfTestReport(): Promise<void> {
  const result = selfTestUi.value?.result;
  if (!result || !saver) return;
  try {
    await saver.share(result.file ? result.report : result.summary);
  } catch (error) {
    // Cerrar el menú de compartir sin elegir nada también rechaza: no es un fallo.
    if (!(error instanceof Error) || error.name !== 'AbortError') showToast('No se pudo abrir el menú de compartir.', 'error');
  }
}

/** Copia el resumen de la prueba: un mensaje corto que se puede pegar si el fichero no se pudiera mandar. */
export async function copySelfTestSummary(): Promise<void> {
  const result = selfTestUi.value?.result;
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.summary);
    showToast('Resumen copiado');
  } catch {
    showToast('No se pudo copiar', 'error');
  }
}
