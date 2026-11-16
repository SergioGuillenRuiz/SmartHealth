import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RingError } from '../ble/errors';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport, type SimBehavior } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import type { ResolvedProfile } from '../domain/profile';
import { SelfTest, STEP_DEFS, type SelfTestDeps, type SelfTestUi } from './runner';
import type { ReportSaver } from './save';

const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`selftest-${++counter}`);
  await store.putProfileEntry({ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' });
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Tiempo agotado esperando: ${what}`);
    await wait(5);
  }
}

interface Options {
  behavior?: SimBehavior;
  overrides?: Partial<SelfTestDeps>;
  /** El contador de pasos del anillo sube mientras se pide caminar (como al andar de verdad). */
  walking?: boolean;
  saver?: Partial<ReportSaver>;
}

function harness(options: Options = {}) {
  const dataset = buildDemoDataset({ nowMs: Date.now(), days: 7, seed: 5 });
  const transport = new SimulatedTransport(dataset, {
    chunkSize: 20,
    hrSamples: [0, 71, 72, 73, 72, 73],
    hrIntervalMs: 4,
    hrVerdict: 'success',
    liveIntervalMs: 15,
    // Como el R99 real: el contador se manda al activar el empuje y después solo cuando cambia.
    liveOnChange: true,
    liveFirstMs: 2,
    ...options.behavior,
  });
  const saves: Array<{ text: string; final: boolean }> = [];
  const saver: ReportSaver = {
    filename: 'SmartHealth-prueba-test.txt',
    save: async (text, { final }) => {
      saves.push({ text, final });
      return { uri: 'content://downloads/1', location: 'Download/SmartHealth-prueba-test.txt' };
    },
    canShare: () => true,
    share: async () => undefined,
    ...options.saver,
  };
  const updates: SelfTestUi[] = [];
  const cues: string[] = [];
  const lock = { release: vi.fn(async () => undefined), released: false };
  let walker: ReturnType<typeof setInterval> | null = null;
  const stopWalker = (): void => {
    if (walker) clearInterval(walker);
    walker = null;
  };
  const test = new SelfTest({
    transport,
    store,
    now: () => Date.now(),
    saver,
    getProfile: () => profile,
    onUpdate: (ui) => {
      updates.push(ui);
      if (!options.walking) return;
      const title = ui.prompt?.title ?? '';
      if (title.startsWith('Camina 30') && !walker) walker = setInterval(() => (dataset.live.steps += 5), 4);
      if (title === 'Quieto otra vez') stopWalker();
    },
    phone: async () => ({ device: { manufacturer: 'Prueba', model: 'P1', osVersion: '14', androidSDKVersion: 34, webViewVersion: '126.0' } }),
    app: { build: 'abc1234', builtAt: '2026-01-01T00:00:00.000Z', native: false, demo: true },
    cue: (cue) => cues.push(cue),
    platform: { wakeLock: { request: vi.fn(async () => lock) } },
    timeScale: 0.002,
    autoReady: true,
    hrTiming: { hrWarmupMs: 0, hrStreamAfterMs: 0 },
    sessionTimeouts: { reply: 300, header: 500, idle: 500, status: 300 },
    ...options.overrides,
  });
  return { test, transport, dataset, saves, updates, cues, lock, stopWalker };
}

const statusOf = (ui: SelfTestUi | undefined, id: string): string | undefined => ui?.steps.find((s) => s.id === id)?.status;
const last = (updates: SelfTestUi[]): SelfTestUi => updates.at(-1) as SelfTestUi;

describe('SelfTest · recorrido completo con el anillo simulado', () => {
  it('recorre los nueve pasos, guarda el informe tras cada uno y al final, y deja el anillo suelto', async () => {
    const { test, transport, saves, updates, cues, lock, stopWalker } = harness({ walking: true });
    const result = await test.run();
    stopWalker();

    expect(result.cancelled).toBe(false);
    expect(result.counts.fail).toBe(0);
    expect(last(updates).phase).toBe('done');
    expect(STEP_DEFS.map((d) => statusOf(last(updates), d.id))).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', expect.stringMatching(/^(ok|warn)$/), 'ok', 'ok']);

    // Un guardado de seguridad por paso y el final.
    expect(saves.filter((s) => !s.final)).toHaveLength(9);
    expect(saves.filter((s) => s.final)).toHaveLength(1);
    expect(result.file).toEqual({ uri: 'content://downloads/1', location: 'Download/SmartHealth-prueba-test.txt' });
    expect(result.saveError).toBeNull();
    expect(result.filename).toBe('SmartHealth-prueba-test.txt');
    expect(result.report).toBe(saves.at(-1)?.text);

    // El anillo queda suelto y la pantalla se libera.
    expect(transport.lastRing?.connected).toBe(false);
    expect(transport.lastRing?.state.measuring).toBeNull();
    expect(transport.lastRing?.state.liveStatus).toBe(false);
    expect(lock.release).toHaveBeenCalledTimes(1);
    // El anillo queda vinculado (como tras una sincronización) y la prueba no deja un entreno «recuperable».
    expect(await store.getRing()).toEqual({ id: 'sim-r99-0001', name: 'R99 F265' });
    expect(await store.getWorkoutDraft()).toBeNull();
    // Avisos al cuerpo: «ya» al empezar a andar y la señal de fin.
    expect(cues).toContain('go');
    expect(cues.at(-1)).toBe('done');
  });

  it('el informe lleva el resumen, los datos de cada paso y las trazas, sin direcciones completas', async () => {
    const { test, stopWalker } = harness({ walking: true });
    const { report, summary } = await test.run();
    stopWalker();

    expect(report).toContain('SmartHealth · informe de la prueba guiada');
    expect(report).toContain('Móvil: Prueba P1 · Android 14 (SDK 34) · WebView 126.0');
    for (const title of STEP_DEFS.map((d) => d.title)) expect(report).toContain(title);
    // Cada sincronización conserva su traza (la segunda no pisa a la primera) con los bytes en bruto de lo que descargó.
    for (const trace of ['connect', 'sync', 'steps', 'heart', 'workout', 'resync']) expect(report).toContain(`===== TRAZA «${trace}»`);
    expect(report.match(/--- datos en bruto \(para decodificar sin el anillo\) ---/g)).toHaveLength(2);
    // Lo decodificado de los últimos días (para comparar con Smart Health) y los datos en bruto del sueño.
    expect(report).toContain('"decoded"');
    expect(report).toContain('"asleepMin"');
    expect(report).toContain('datos en bruto');
    // El anillo se ve por su nombre, pero nunca con la dirección entera.
    expect(report).toContain('"name": "R99 F265"');
    expect(report).not.toContain('sim-r99-0001');
    expect(report).toContain('…-0001');
    // El resumen cabe en un mensaje.
    expect(summary).toContain('Prueba completa');
    expect(summary.split('\n').length).toBe(10);
    expect(summary.length).toBeLessThan(3000);
    // La cronología cuenta qué se le pidió a la persona.
    expect(report).toContain('Se indica: Camina 30 segundos');
    expect(report).toContain('Se indica: Midiendo el pulso');
  });

  it('pasos en directo: con el contador subiendo mide cuánto subió, el retraso y la cadencia', async () => {
    const { test, updates, stopWalker } = harness({ walking: true });
    await test.run();
    stopWalker();
    expect(statusOf(last(updates), 'steps')).toBe('ok');
    const summary = last(updates).steps.find((s) => s.id === 'steps')?.summary ?? '';
    expect(summary).toMatch(/^El contador subió \d+ \(de \d+ a \d+\) en 30 s de marcha; el anillo lo fue avisando solo: \d+ envíos?/);
    expect(summary).toContain('el primer cambio llegó');
  });

  it('pasos en directo: un contador que no cambia al caminar es un aviso, no un fallo, y dice qué mirar', async () => {
    const { test, updates } = harness({ walking: false });
    await test.run();
    expect(statusOf(last(updates), 'steps')).toBe('warn');
    const summary = last(updates).steps.find((s) => s.id === 'steps')?.summary ?? '';
    expect(summary).toMatch(/^El contador no subió en 30 s de marcha: \d+ envíos? del anillo, siempre con \d+ y la relectura tampoco\./);
    expect(summary).toContain('móvil en la mano del anillo');
  });

  it('pasos en directo: si el anillo cuenta pero no avisa mientras se anda, la relectura final lo demuestra', async () => {
    // Lo que se vio en el R99 real con solo el empuje de pasos activo: un único envío al activarlo y nada más.
    const { test, updates, stopWalker } = harness({ walking: true, behavior: { liveFirstOnly: true } });
    const result = await test.run();
    stopWalker();
    expect(statusOf(last(updates), 'steps')).toBe('warn');
    const summary = last(updates).steps.find((s) => s.id === 'steps')?.summary ?? '';
    expect(summary).toMatch(/^El contador subió \d+ \(de \d+ a \d+\) en 30 s de marcha, pero no lo avisó mientras andabas: solo lo dio al volver a pedirlo/);
    expect(result.report).toContain('"pushedWhileWalking": false');
  });

  it('la medida de pulso guarda los avisos del anillo con su instante y el veredicto', async () => {
    const { test } = harness({ walking: true });
    const { report } = await test.run();
    expect(report).toMatch(/\[OK\s+\] Medir el pulso: 73 lpm · 6 lecturas/);
    expect(report).toContain('"eventsFormat": "[ms, tipo, valor]"');
    expect(report).toMatch(/\[\d+, "fin de medida", "bien"\]/);
  });

  it('si otra app (Smart Health en segundo plano) habla con el anillo a la vez, el paso lo dice y pasa a aviso', async () => {
    const { test, transport, updates, stopWalker } = harness({ walking: true });
    let pushed = false;
    // Mientras se mide el pulso aparecen respuestas de poner en hora e información que esta app no pidió.
    const watcher = setInterval(() => {
      if (!pushed && last(updates)?.prompt?.title === 'Midiendo el pulso' && transport.lastRing) {
        pushed = true;
        transport.lastRing.pushStray(1, 0x00);
        transport.lastRing.pushStray(2, 0x01);
      }
    }, 2);
    const result = await test.run();
    clearInterval(watcher);
    stopWalker();
    expect(pushed).toBe(true);
    expect(statusOf(last(updates), 'heart')).toBe('warn');
    expect(last(updates).steps.find((s) => s.id === 'heart')?.summary).toMatch(/otra app habló con el anillo a los .+ \(¿Smart Health en segundo plano\?\)/);
    expect(result.report).toContain('"foreignTraffic"');
    expect(result.report).toContain('Paso con tráfico ajeno en la traza «heart»');
    // Lo demás no se ve afectado.
    expect(statusOf(last(updates), 'steps')).toBe('ok');
    expect(statusOf(last(updates), 'sync')).toBe('ok');
  });

  it('el entreno de prueba no deja nada guardado: ni entreno, ni borrador, ni pendiente de revisar', async () => {
    const { test, stopWalker } = harness({ walking: true });
    await test.run();
    stopWalker();
    expect(await store.getWorkoutDraft()).toBeNull();
    const range = await store.loadRange('2000-01-01', '2100-01-01');
    expect(range.workouts).toEqual([]);
  });
});

describe('SelfTest · control de la persona', () => {
  it('«Estoy listo» y «Saltar este paso»: lo saltado queda como saltado y la prueba sigue', async () => {
    const { test, updates, stopWalker } = harness({ overrides: { autoReady: false }, walking: true });
    const run = test.run();
    const gate = (title: string): boolean => last(updates).prompt?.title === title && last(updates).prompt?.button !== undefined;

    await waitFor(() => gate('Pasos: prepárate'), 'el aviso de los pasos');
    test.skip();
    await waitFor(() => gate('Entreno: prepárate'), 'el aviso del entreno');
    expect(statusOf(last(updates), 'steps')).toBe('skipped');
    test.ready();
    const result = await run;
    stopWalker();

    expect(statusOf(last(updates), 'steps')).toBe('skipped');
    expect(statusOf(last(updates), 'heart')).toBe('ok');
    expect(statusOf(last(updates), 'workout')).toMatch(/^(ok|warn)$/);
    expect(result.counts.skipped).toBe(1);
    expect(result.report).toContain('La persona salta este paso');
  });

  it('saltar durante la pausa previa a conectar no llega a conectar: el paso queda saltado, no como fallo', async () => {
    const { test, transport, updates } = harness({ overrides: { autoReady: false, settleMs: 500 } });
    let reconnects = 0;
    const reconnect = transport.reconnect.bind(transport);
    transport.reconnect = async (saved) => {
      reconnects++;
      return reconnect(saved);
    };
    const connecting = (id: string): boolean => last(updates).prompt?.title === 'Conectando con el anillo…' && statusOf(last(updates), id) === 'running';

    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    expect(reconnects).toBe(1); // la sincronización
    test.ready();
    await waitFor(() => connecting('steps'), 'la pausa antes de conectar los pasos');
    test.skip();
    await waitFor(() => connecting('heart'), 'la pausa antes de conectar el pulso');
    test.skip();
    await waitFor(() => last(updates).prompt?.title === 'Entreno: prepárate', 'el aviso del entreno');
    test.skip();
    const result = await run;

    expect(['steps', 'heart', 'workout'].map((id) => statusOf(last(updates), id))).toEqual(['skipped', 'skipped', 'skipped']);
    expect(reconnects).toBe(2); // la sincronización y la de después; ni los pasos ni el pulso llegaron a conectar
    expect(result.counts).toMatchObject({ fail: 0, skipped: 3 });
  });

  it('cancelar a mitad suelta el anillo, marca lo que falta como saltado y guarda lo hecho hasta entonces', async () => {
    const { test, transport, updates, saves } = harness({ overrides: { autoReady: false } });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    test.cancel();
    const result = await run;

    expect(result.cancelled).toBe(true);
    expect(statusOf(last(updates), 'sync')).toBe('ok');
    expect(['steps', 'heart', 'workout', 'resync', 'release'].map((id) => statusOf(last(updates), id))).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(result.summary).toContain('Prueba CANCELADA');
    expect(result.report).toContain('La persona cancela la prueba');
    expect(saves.at(-1)?.final).toBe(true);
    expect(transport.lastRing?.connected).toBe(false);
  });

  it('cancelar con el entreno en marcha lo descarta y suelta el anillo', async () => {
    const { test, transport, updates } = harness({ overrides: { timeScale: 0.05 }, walking: true });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Camina con normalidad', 'el entreno en marcha', 15_000);
    test.cancel();
    const result = await run;

    expect(result.cancelled).toBe(true);
    expect(statusOf(last(updates), 'workout')).toBe('skipped');
    expect(statusOf(last(updates), 'release')).toBe('skipped');
    expect(transport.lastRing?.connected).toBe(false);
    expect(await store.getWorkoutDraft()).toBeNull();
  });

  it('mientras se cancela, la interfaz lo dice', async () => {
    const { test, updates } = harness({ overrides: { autoReady: false } });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    test.cancel();
    expect(last(updates).cancelling).toBe(true);
    await run;
    expect(last(updates).cancelling).toBe(false);
  });
});

describe('SelfTest · cuando algo falla', () => {
  it('sin conexión con el anillo: reintenta, falla y deja lo demás como saltado, explicando por qué', async () => {
    const { test, transport, updates } = harness();
    transport.connectTo = async () => {
      throw new RingError('Anillo ocupado', 'connect-failed');
    };
    transport.pickAndConnect = async () => {
      throw new RingError('Sin anillo elegido', 'no-device');
    };
    const result = await test.run();

    expect(statusOf(last(updates), 'scan')).toBe('ok');
    expect(statusOf(last(updates), 'connect')).toBe('fail');
    expect(['sync', 'steps', 'heart', 'workout', 'resync', 'release'].map((id) => statusOf(last(updates), id))).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(result.counts).toMatchObject({ fail: 1, skipped: 6 });
    expect(result.report).toContain('No se pudo conectar con el anillo (3 intentos)');
    expect(result.report).toContain('Sin conexión con el anillo');
    expect(result.cancelled).toBe(false);
  });

  it('si no lo ve al buscar, lo avisa y conecta eligiéndolo en la lista', async () => {
    const { test, transport, updates } = harness({ walking: true });
    transport.scan = async () => [{ id: 'otro', name: 'Auriculares', rssi: -60, services: [], manufacturer: {}, raw: null }];
    const result = await test.run();

    expect(statusOf(last(updates), 'scan')).toBe('fail');
    expect(last(updates).steps.find((s) => s.id === 'scan')?.summary).toContain('No se ve el anillo entre 1 dispositivos');
    expect(statusOf(last(updates), 'connect')).toBe('ok');
    expect(result.report).toContain('"via": "picker"');
    // Como el anillo no sale al buscar tras terminar, el último paso lo avisa sin darlo por fallo.
    expect(statusOf(last(updates), 'release')).toBe('warn');
  });

  it('un Bluetooth o una ubicación apagados se piden antes de seguir, y si siguen así queda un aviso', async () => {
    const { test, transport, updates } = harness();
    let calls = 0;
    transport.environment = async () => {
      calls++;
      return { native: true, initialize: 'ok', bluetoothEnabled: false, locationEnabled: true };
    };
    await test.run();
    expect(calls).toBe(3);
    expect(statusOf(last(updates), 'env')).toBe('warn');
    expect(last(updates).steps.find((s) => s.id === 'env')?.summary).toContain('El Bluetooth del móvil está apagado');
  });

  it('si se arregla el ajuste al reintentar, el paso sale bien', async () => {
    const { test, transport, updates } = harness();
    let calls = 0;
    transport.environment = async () => ({ native: true, initialize: 'ok', bluetoothEnabled: true, locationEnabled: ++calls > 1 });
    await test.run();
    expect(calls).toBe(2);
    expect(statusOf(last(updates), 'env')).toBe('ok');
  });

  it('un Bluetooth que no se puede preparar es un fallo del primer paso, pero la prueba sigue', async () => {
    const { test, transport, updates } = harness();
    transport.environment = async () => ({ native: true, initialize: 'error: Falta un permiso', bluetoothEnabled: true, locationEnabled: true });
    await test.run();
    expect(statusOf(last(updates), 'env')).toBe('fail');
    expect(last(updates).steps.find((s) => s.id === 'env')?.summary).toContain('Dispositivos cercanos');
    expect(statusOf(last(updates), 'connect')).toBe('ok');
  });

  it('un anillo que rechaza el pulso: la medida falla, el entreno sigue sin pulso (aviso)', async () => {
    const { test, updates, stopWalker } = harness({ behavior: { refuseModes: [0] }, walking: true });
    await test.run();
    stopWalker();
    expect(statusOf(last(updates), 'heart')).toBe('fail');
    expect(last(updates).steps.find((s) => s.id === 'heart')?.summary).toContain('rechazado la medida');
    expect(statusOf(last(updates), 'workout')).toBe('warn');
    expect(statusOf(last(updates), 'release')).toBe('ok');
  });

  it('un tipo de historial que el anillo deja de enviar es un aviso de la sincronización, con su traza, y la prueba sigue', async () => {
    const { test, updates, stopWalker } = harness({ behavior: { dropTerminalOf: 'sleep' }, walking: true });
    const result = await test.run();
    stopWalker();
    expect(statusOf(last(updates), 'sync')).toBe('warn');
    const summary = last(updates).steps.find((s) => s.id === 'sync')?.summary ?? '';
    expect(summary).toContain('sleep timeout');
    // Sin la confirmación del bloque de sueño el anillo no libera los tipos siguientes: cada uno agota su espera.
    expect(summary).toMatch(/\d+ aviso\(s\)/);
    expect(result.report).toContain('TRAZA «sync»');
    expect(statusOf(last(updates), 'steps')).toBe('ok');
  });

  it('si el anillo no habla YCBT, el saludo falla con su traza y no se intenta nada más con él', async () => {
    const { test, updates } = harness({ behavior: { silentOn: ['02:03'] } });
    const result = await test.run();
    expect(statusOf(last(updates), 'connect')).toBe('fail');
    expect(last(updates).steps.find((s) => s.id === 'connect')?.summary).toContain('falló el saludo');
    expect(result.report).toContain('TRAZA «connect»');
    expect(statusOf(last(updates), 'sync')).toBe('skipped');
  });

  it('si no se puede guardar a mitad, no se insiste; si falla el guardado final, se dice y queda el último parcial', async () => {
    let calls = 0;
    const saved = { uri: 'content://x', location: 'Download/x.txt' };
    const { test, updates } = harness({
      saver: {
        save: async (_text, { final }) => {
          calls++;
          if (calls === 1) return saved; // el primer guardado de seguridad sale bien…
          throw new Error(final ? 'Sin espacio' : 'Se acabó el espacio'); // …y los siguientes no
        },
      },
    });
    const result = await test.run();
    expect(calls).toBe(3); // el primero, un intento fallido que corta los demás, y el final
    expect(result.saveError).toBe('Sin espacio');
    expect(result.file).toEqual(saved);
    expect(last(updates).result?.saveError).toBe('Sin espacio');
  });

  it('un guardado que se resuelve sin fichero (la descarga del navegador a mitad) no cuenta como guardado', async () => {
    const { test } = harness({ saver: { save: async (_text, { final }) => (final ? { uri: null, location: 'Descargas/x.txt' } : null) } });
    const result = await test.run();
    expect(result.file).toEqual({ uri: null, location: 'Descargas/x.txt' });
    expect(result.saveError).toBeNull();
  });
});

describe('SelfTest · robustez de la conexión con Android', () => {
  const promptsTitled = (updates: SelfTestUi[], title: string): string[] => [...new Set(updates.filter((u) => u.prompt?.title === title).map((u) => u.prompt?.text ?? ''))];

  it('un fallo puntual al reabrir el anillo (estado GATT 133) se reintenta y el paso sale bien, con el intento en la traza', async () => {
    const { test, transport, updates } = harness({ walking: true });
    const reconnect = transport.reconnect.bind(transport);
    let calls = 0;
    transport.reconnect = async (saved) => {
      // La primera es la de la sincronización; la segunda, el primer intento del paso de los pasos.
      if (++calls === 2) throw new RingError('Connection failed with status 133 (GATT_ERROR).', 'connect-failed');
      return reconnect(saved);
    };
    const result = await test.run();
    expect(statusOf(last(updates), 'steps')).toBe('ok');
    expect(result.report).toContain('Conexión, intento 1 de 2: Connection failed with status 133 (GATT_ERROR). (se reintenta)');
    expect(promptsTitled(updates, 'Reconectando…')).toHaveLength(1);
  });

  it('si el segundo intento también falla, el paso falla diciendo por qué y la prueba sigue', async () => {
    const { test, transport, updates } = harness({ walking: true });
    const reconnect = transport.reconnect.bind(transport);
    let calls = 0;
    transport.reconnect = async (saved) => {
      if (++calls === 2 || calls === 3) throw new RingError('Connection timeout.', 'connect-failed');
      return reconnect(saved);
    };
    await test.run();
    expect(statusOf(last(updates), 'steps')).toBe('fail');
    expect(last(updates).steps.find((s) => s.id === 'steps')?.summary).toContain('Connection timeout.');
    expect(statusOf(last(updates), 'heart')).toBe('ok'); // el siguiente paso abre de nuevo
  });

  it('con un permiso que falta o el Bluetooth apagado no se reintenta (no se arregla solo)', async () => {
    const { test, transport, updates } = harness({ walking: true });
    const reconnect = transport.reconnect.bind(transport);
    let calls = 0;
    transport.reconnect = async (saved) => {
      if (++calls >= 2) throw new RingError('El Bluetooth del móvil está apagado.', 'unsupported-platform');
      return reconnect(saved);
    };
    const result = await test.run();
    expect(statusOf(last(updates), 'steps')).toBe('fail');
    expect(statusOf(last(updates), 'heart')).toBe('fail');
    expect(result.report).toContain('Conexión, intento 1 de 2: El Bluetooth del móvil está apagado.');
    expect(result.report).not.toContain('intento 2 de 2');
  });

  it('un saludo sin respuesta a la primera se reintenta en el paso de conectar (antes dejaba todo lo demás sin hacer)', async () => {
    const { test, transport, updates } = harness({ walking: true });
    const behavior = (transport as unknown as { behavior: SimBehavior }).behavior;
    behavior.silentOn = ['02:03'];
    const connectTo = transport.connectTo?.bind(transport) as NonNullable<typeof transport.connectTo>;
    let connects = 0;
    transport.connectTo = async (device) => {
      if (++connects === 2) behavior.silentOn = undefined; // el anillo contesta al segundo intento
      return connectTo(device);
    };
    const result = await test.run();
    expect(connects).toBe(2);
    expect(statusOf(last(updates), 'connect')).toBe('ok');
    expect(statusOf(last(updates), 'sync')).toBe('ok');
    expect(result.report).toContain('"stage": "saludo"');
    expect(promptsTitled(updates, 'El anillo no contestó')[0]).toContain('tócalo para despertarlo');
  });

  it('el aviso de reintento por un permiso o un ajuste no manda cerrar Smart Health; el de una conexión fallida, sí', async () => {
    const permission = harness();
    permission.transport.connectTo = async () => {
      throw new RingError('Falta un permiso de Bluetooth o de ubicación.', 'unsupported-platform');
    };
    await permission.test.run();
    const text = promptsTitled(permission.updates, 'No se pudo conectar')[0] ?? '';
    expect(text).toContain('Falta un permiso de Bluetooth o de ubicación.');
    expect(text).not.toContain('Smart Health');

    const busy = harness();
    busy.transport.connectTo = async () => {
      throw new RingError('Connection timeout.', 'connect-failed');
    };
    await busy.test.run();
    expect(promptsTitled(busy.updates, 'No se pudo conectar')[0]).toContain('Cierra Smart Health del todo');
  });

  it('si el selector de Bluetooth se abre a mitad de la sincronización, la hoja lo dice y luego vuelve a su aviso', async () => {
    const { test, transport, updates } = harness({ walking: true });
    transport.reconnect = async () => null; // sin reconexión por identificador: la sincronización abre el selector
    const titlesAtPick: Array<string | undefined> = [];
    const pick = transport.pickAndConnect.bind(transport);
    transport.pickAndConnect = async (options) => {
      titlesAtPick.push(last(updates).prompt?.title);
      return pick(options);
    };
    await test.run();
    expect(titlesAtPick[0]).toBe('Elige tu anillo');
    const titles = updates.map((u) => u.prompt?.title);
    const at = titles.indexOf('Elige tu anillo');
    expect(titles.slice(0, at).includes('Sincronizando…')).toBe(true);
    expect(titles.slice(at + 1).includes('Sincronizando…')).toBe(true); // se restituye al conectar
  });

  it('lo que el transporte apunta de sus reconexiones (por qué falló cada intento) llega al informe', async () => {
    const { test, transport } = harness({ walking: true });
    transport.takeNotes = () => ['reconexión, intento 1 de 2: Connection failed with status 133 (GATT_ERROR).'];
    const { report } = await test.run();
    expect(report).toContain('· reconexión, intento 1 de 2: Connection failed with status 133 (GATT_ERROR).'); // en la lista de la sincronización
    expect(report).toContain('transporte: reconexión, intento 1 de 2'); // y en la traza de los pasos
  });

  it('una decodificación que falla no convierte una sincronización correcta en fallo ni pierde su traza', async () => {
    const { test, updates } = harness({ walking: true });
    const original = store.getProfileHistory.bind(store);
    let calls = 0;
    store.getProfileHistory = async () => {
      if (++calls >= 2) throw new Error('boom en decodificación'); // la 1.ª es la de la sincronización; la 2.ª, la de la prueba
      return original();
    };
    const { report } = await test.run();
    expect(statusOf(last(updates), 'sync')).toBe('ok');
    expect(report).toContain('No se pudieron decodificar los días: boom en decodificación');
    expect(report).toContain('TRAZA «sync»');
  });

  it('el entreno apunta en el informe los avisos del controlador y las funciones, no solo en la traza', async () => {
    const { test, stopWalker } = harness({ behavior: { refuseModes: [0] }, walking: true });
    const { report } = await test.run();
    stopWalker();
    const json = report.slice(report.indexOf('DATOS ESTRUCTURADOS'), report.indexOf('CRONOLOGÍA'));
    expect(json).toMatch(/"warnings": \[\s*"[^"]*rechazado la medida de pulso/);
    expect(json).not.toContain('"features": null');
  });

  it('si el anillo se desconecta a mitad de los pasos, el informe lo dice y el paso no sale «bien»', async () => {
    const { test, transport, updates, stopWalker } = harness({ overrides: { timeScale: 0.02 }, walking: true });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Camina 30 segundos', 'el tramo de caminar');
    transport.lastRing?.simulateLinkLoss();
    await waitFor(() => statusOf(last(updates), 'steps') === 'warn' || statusOf(last(updates), 'steps') === 'fail', 'el resultado de los pasos');
    test.cancel();
    const result = await run;
    stopWalker();
    expect(statusOf(last(updates), 'steps')).toBe('warn');
    expect(last(updates).steps.find((s) => s.id === 'steps')?.summary).toMatch(/el anillo se desconectó a los \d/);
    expect(result.report).toMatch(/"linkLostAtMs": \d+/);
    expect(result.report).toContain('Pasos en directo: el anillo se desconectó a los');
  });

  it('un cierre normal de la sesión al terminar los pasos no se apunta como pérdida del anillo', async () => {
    const { test, stopWalker } = harness({ walking: true });
    const { report } = await test.run();
    stopWalker();
    expect(report).toContain('"linkLostAtMs": null');
    expect(report).not.toContain('el anillo se desconectó a los');
  });

  describe('comprobar que lo suelta', () => {
    it('una conexión abierta con el anillo al terminar es un fallo, aunque se vea al buscar', async () => {
      const { test, transport, updates, stopWalker } = harness({ walking: true });
      transport.connectedDevices = async () => [{ id: 'sim-r99-0001', name: 'R99 F265' }];
      const { report } = await test.run();
      stopWalker();
      expect(statusOf(last(updates), 'release')).toBe('fail');
      expect(last(updates).steps.find((s) => s.id === 'release')?.summary).toContain('sigue conectado a alguna app');
      expect(report).toContain('"connectedDevices": [');
    });

    it('sin conexiones abiertas con el anillo, sale bien; si no se puede preguntar, se queda con lo que se ve al buscar', async () => {
      const none = harness({ walking: true });
      none.transport.connectedDevices = async () => [{ id: 'otro-dispositivo', name: 'Reloj' }];
      await none.test.run();
      none.stopWalker();
      expect(statusOf(last(none.updates), 'release')).toBe('ok');

      const broken = harness({ walking: true });
      broken.transport.connectedDevices = async () => {
        throw new Error('sin permiso');
      };
      await broken.test.run();
      broken.stopWalker();
      expect(statusOf(last(broken.updates), 'release')).toBe('ok');
    });
  });

  describe('el entorno', () => {
    it('si Android no responde a los permisos, el paso falla y deja en el informe lo que anotó el transporte', async () => {
      const { test, transport, updates } = harness({ overrides: { permissionWaitMs: 30 } });
      transport.environment = () => new Promise(() => undefined); // la petición de permisos se queda colgada
      transport.takeNotes = () => ['petición de permisos de la app: 31 ms, {"fineLocation":true}'];
      const { report } = await test.run();
      expect(statusOf(last(updates), 'env')).toBe('fail');
      expect(report).toContain('No se respondió a los permisos a tiempo.');
      expect(report).toContain('petición de permisos de la app: 31 ms');
    });

    it('un anillo que ya está conectado a otra app se avisa al empezar, y su dirección va abreviada', async () => {
      const { test, transport, updates } = harness();
      transport.environment = async () => ({
        native: true,
        initialize: 'ok',
        bluetoothEnabled: true,
        locationEnabled: true,
        connectedDevices: [{ id: 'AA:BB:CC:DD:EE:FF', name: 'R99 F265' }],
      });
      const { report } = await test.run();
      expect(statusOf(last(updates), 'env')).toBe('warn');
      expect(last(updates).steps.find((s) => s.id === 'env')?.summary).toContain('Smart Health');
      expect(report).toContain('…EE:FF');
      expect(report).not.toContain('AA:BB:CC:DD:EE:FF');
    });

    it('otros dispositivos conectados (unos auriculares, un reloj) no son un problema', async () => {
      const { test, transport, updates } = harness();
      transport.environment = async () => ({ native: true, initialize: 'ok', bluetoothEnabled: true, locationEnabled: true, connectedDevices: [{ id: '11:22:33:44:55:66', name: 'Reloj' }] });
      await test.run();
      expect(statusOf(last(updates), 'env')).toBe('ok');
    });
  });
});

describe('SelfTest · saltar un paso', () => {
  it('al pulsar «Saltar», la interfaz lo dice hasta que empieza el paso siguiente', async () => {
    const { test, updates } = harness({ overrides: { autoReady: false } });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    expect(last(updates).skipping).toBe(false);
    test.skip();
    expect(last(updates).skipping).toBe(true);
    await waitFor(() => last(updates).prompt?.title === 'Entreno: prepárate', 'el aviso del entreno');
    expect(last(updates).skipping).toBe(false); // el paso siguiente (pulso) y los demás empezaron limpios
    test.cancel();
    await run;
    expect(last(updates).skipping).toBe(false);
  });

  it('cancelar tiene su propio aviso, no el de saltar', async () => {
    const { test, updates } = harness({ overrides: { autoReady: false } });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    test.cancel();
    expect(last(updates).cancelling).toBe(true);
    expect(last(updates).skipping).toBe(false);
    await run;
  });
});

describe('SelfTest · el móvil', () => {
  it('apunta cuándo la app se oculta y vuelve a pedir la pantalla encendida al volver', async () => {
    let hidden: () => void = () => undefined;
    let visible: () => void = () => undefined;
    const lock = { release: vi.fn(async () => undefined), released: false };
    const request = vi.fn(async () => lock);
    const { test, updates } = harness({
      overrides: {
        platform: {
          wakeLock: { request },
          onHidden: (callback) => {
            hidden = callback;
            return () => undefined;
          },
          onVisible: (callback) => {
            visible = callback;
            return () => undefined;
          },
        },
        autoReady: false,
      },
    });
    const run = test.run();
    await waitFor(() => last(updates).prompt?.title === 'Pasos: prepárate', 'el aviso de los pasos');
    hidden();
    lock.released = true; // el sistema suelta el bloqueo al ocultar la app
    visible();
    await waitFor(() => request.mock.calls.length === 2, 'volver a pedir la pantalla');
    test.cancel();
    const result = await run;
    expect(result.report).toContain('La app ha pasado a segundo plano');
    expect(result.report).toContain('La app vuelve a verse');
  });

  it('apunta en la cronología los console.error de la página y deja la consola como estaba', async () => {
    const original = console.error;
    const quiet = vi.fn();
    console.error = quiet;
    try {
      let fired = false;
      const { test } = harness({
        overrides: {
          cue: () => {
            if (fired) return;
            fired = true;
            console.error('Native: tried calling NativeTools.share, but the plugin failed');
          },
        },
      });
      const { report } = await test.run();
      expect(report).toContain('console.error: Native: tried calling NativeTools.share, but the plugin failed');
      expect(quiet).toHaveBeenCalledWith('Native: tried calling NativeTools.share, but the plugin failed'); // sigue llegando a la consola real
      expect(console.error).toBe(quiet); // y al terminar se restituye
    } finally {
      console.error = original;
    }
  });

  it('que la vibración falle no estropea la prueba', async () => {
    const { test } = harness({
      overrides: {
        cue: () => {
          throw new Error('sin vibración');
        },
      },
    });
    const result = await test.run();
    expect(result.counts.fail).toBe(0);
  });
});
