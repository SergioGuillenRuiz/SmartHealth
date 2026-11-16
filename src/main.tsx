import { render } from 'preact';
import { reloadAll, startClock } from './app/actions';
import { startAutoSync } from './app/auto-sync';
import { betaMemory, isBeta, markBetaSeeded, shouldSeedBeta } from './app/beta';
import { installBackButton } from './app/back-button';
import { isNative, releaseNativeScreenLock } from './app/native';
import { loadScale } from './app/scale';
import { startPersonal } from './app/personal';
import { registerServiceWorker } from './app/pwa';
import { recoverWorkoutDraft } from './app/workout-actions';
import { installServices } from './app/services';
import type { ScaleTransport } from './ble/scale/transport';
import type { RingTransport } from './ble/transport';
import { WebBluetoothTransport } from './ble/webbluetooth';
import { openIdbStore } from './data/idb-store';
import { App } from './ui/App';
import { applySheetStyle } from './ui/sheet-style';
import { blockTextSelection } from './ui/text-selection';
import { bootSucceeded, ErrorBoundary, FatalScreen, retryBootOnce, storeNameFor } from './ui/FatalScreen';
import './ui/styles/tokens.css';
import './ui/styles/app.css';
import './ui/styles/charts.css';
import './ui/styles/sheets-v2.css';

async function boot(): Promise<void> {
  applySheetStyle();
  releaseNativeScreenLock();
  const params = new URLSearchParams(location.search);
  // La versión para betatesters (`vite build --mode beta`) arranca como la demostración (anillo y báscula simulados) pero es una app de verdad: ver `app/beta.ts`.
  const beta = isBeta();
  const demo = params.has('demo') || beta;
  const now = (): number => Date.now();

  const store = await openIdbStore(storeNameFor(location.search));
  let transport: RingTransport;
  /** El Bluetooth de la báscula de cocina: el simulado en la demostración, el nativo en el APK y ninguno en un navegador (necesita servicios que Web Bluetooth no deja descubrir). */
  let scale: ScaleTransport | undefined;
  if (demo) {
    // El modo demostración (anillo simulado y datos de ejemplo) se carga aparte: no pesa en el uso normal.
    const [{ demoRingBehavior, demoRingDataset, parseDemoRing, seedDemo }, { SIM_RING_ID, SimulatedTransport }, { parseDemoSchedule }] = await Promise.all([
      import('./app/demo'),
      import('./ble/sim/ring'),
      import('./ble/sim/dataset'),
    ]);
    const variant = parseDemoRing(params.get('ring')); // ?demo=1&ring=sin-pulso | sin-nada
    const schedule = parseDemoSchedule(params.get('horario')); // ?demo=1&horario=dia: quien duerme de día (turno de noche)
    if (beta) {
      // Los datos de ejemplo solo la primera vez: lo que la persona anota después se queda.
      const memory = betaMemory();
      if (await shouldSeedBeta(store, memory)) {
        await seedDemo(store, now(), variant, schedule);
        // El anillo simulado ya vinculado: así la actualización automática lo sincroniza sola y el Resumen de hoy trae datos desde el primer minuto (como con un anillo de verdad).
        await store.setRing({ id: SIM_RING_ID, name: demoRingDataset(now(), schedule).deviceName });
      }
      markBetaSeeded(memory);
    } else if (params.get('demo') !== 'keep') await seedDemo(store, now(), variant, schedule);
    transport = new SimulatedTransport(() => demoRingDataset(now(), schedule), { chunkSize: 20, latencyMs: 4, ...demoRingBehavior(variant) });
    // La báscula simulada: `?demo=1&scale=ascii|le10|advert|silent` cambia cómo manda el peso y `&scalepaired=1` la deja ya emparejada. Las pruebas le ponen peso con `window.__smartringScale`.
    const { parseSimScaleFormat, SimulatedScaleTransport, simScaleDecoder, SIM_SCALE_ID, SIM_SCALE_NAME } = await import('./ble/scale/sim');
    const format = parseSimScaleFormat(params.get('scale'));
    const sim = new SimulatedScaleTransport({ format });
    scale = sim;
    (window as unknown as { __smartringScale?: unknown }).__smartringScale = sim;
    // El lector de la tabla nutricional deja aquí lo que fue leyendo (el texto de cada pasada del OCR): lo usa el banco de medida (`tests/e2e/lector-banco.spec.ts`). Solo en la demostración.
    (window as unknown as { __smartringLabel?: unknown }).__smartringLabel = { reads: [] };
    if (params.has('scalepaired')) await store.setScale({ id: SIM_SCALE_ID, name: SIM_SCALE_NAME, decoder: simScaleDecoder(format), pairedMs: now() });
    // El navegador por audio de la demostración usa una ciudad de mentira; las pruebas leen su estado (la ruta y la fase) con `window.__smartringNav`.
    const nav = await import('./app/nav/navigator');
    (window as unknown as { __smartringNav?: unknown }).__smartringNav = { phase: () => nav.navState.value.phase, route: () => nav.navState.value.route?.points ?? null, state: () => nav.navState.value.guidance };
  } else if (isNative()) {
    // Dentro de la app de Android el Bluetooth es el nativo: un WebView no tiene Web Bluetooth.
    const [{ CapacitorBleTransport }, { CapacitorScaleTransport }] = await Promise.all([import('./ble/capacitor-ble'), import('./ble/scale/capacitor-scale')]);
    const native = new CapacitorBleTransport();
    transport = native;
    scale = new CapacitorScaleTransport(native); // comparte con el anillo los permisos y el plugin
  } else {
    transport = new WebBluetoothTransport();
  }

  // El anillo simulado no tiene calentamiento del sensor: en la demostración el pulso se entrega de inmediato.
  installServices({ store, transport, ...(scale ? { scale } : {}), now, demo, ...(demo ? { hrTiming: { hrWarmupMs: 0, hrStreamAfterMs: 0 } } : {}) });

  await reloadAll();
  await loadScale();
  await recoverWorkoutDraft();
  startClock();
  startPersonal();
  render(
    <ErrorBoundary dbName={storeNameFor(location.search)}>
      <App />
    </ErrorBoundary>,
    document.getElementById('app') as HTMLElement,
  );
  installBackButton();
  blockTextSelection();

  // Con la app a la vista, los datos del anillo se traen solos. En la demostración solo si se pide con `?auto=1`: las demás
  // pruebas cuentan lo que hace el anillo simulado y no esperan conexiones que no han pedido.
  if (transport.kind === 'native' || beta || (demo && params.has('auto'))) startAutoSync();

  registerServiceWorker();

  // Pide almacenamiento persistente: sin esto el navegador puede borrar los datos si falta espacio.
  void navigator.storage?.persist?.().catch(() => undefined);
}

boot().then(bootSucceeded, (error: unknown) => {
  // Un fallo al arrancar casi siempre es pasajero: se reintenta una vez sola, sin que la persona tenga que hacer nada.
  if (retryBootOnce()) return;
  const root = document.getElementById('app');
  if (!root) return;
  // Un contenedor nuevo: si el fallo ocurrió pintando, el árbol anterior puede haber quedado a medias.
  const holder = document.createElement('div');
  root.replaceChildren(holder);
  render(<FatalScreen error={error} dbName={storeNameFor(location.search)} />, holder);
});
