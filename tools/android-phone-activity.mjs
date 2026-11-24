// Comprobación, en un emulador de Android, de que la lectura del uso del móvil (lo que alimenta el sueño estimado de quien deja el anillo de noche) funciona DE VERDAD con el sistema:
// la lanza el CI después de las otras (ver .github/workflows/android.yml).
//
// Lo que no se puede ver con pruebas unitarias ni en el navegador, y que es justo lo que decide si la estimación funciona en un móvil:
//   · que sin el acceso a «datos de uso» no se lee nada, y que con él (se da con `appops`, como lo haría la persona en los ajustes) el plugin lo detecta;
//   · que Android entrega de verdad los eventos de pantalla y de desbloqueo y que la app los convierte en tramos de uso: una pantalla encendida unos segundos (un aviso) no cuenta, y un rato con
//     la pantalla, el desbloqueo y una app delante, sí;
//   · que el trabajo de fondo (JobScheduler) está programado, se ejecuta y deja lo leído en las preferencias de la app;
//   · y que todo llega a la base de datos de la web (IndexedDB), de donde lo coge el estimador.
//
// Uso: node tools/android-phone-activity.mjs <carpeta con el .apk>
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _android as android } from 'playwright-core';

const apkDir = process.argv[2];
if (!apkDir) throw new Error('Uso: node tools/android-phone-activity.mjs <carpeta con el .apk>');
const apkFile = readdirSync(apkDir).find((name) => name.endsWith('.apk'));
if (!apkFile) throw new Error(`No hay ningún .apk en ${apkDir}`);

const PKG = 'app.smartring';
const JOB_ID = 5701;
const problems = [];
const check = (ok, text) => {
  console.log(`${ok ? 'OK    ' : 'FALLO '} ${text}`);
  if (!ok) problems.push(text);
};
const note = (text) => console.log(`       ${text}`);
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });
const shell = (command) => adb('shell', command);
/** Como `shell`, pero un fallo no corta: devuelve el texto del error. */
const tryShell = (command) => {
  try {
    return shell(command);
  } catch (error) {
    return `(${command}: ${String(error.message).split('\n')[0]})`;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => {
  console.log('\nFALLO  La comprobación superó los 12 minutos y se corta.');
  process.exit(2);
}, 12 * 60_000).unref();

/** La hora del MÓVIL en milisegundos (el reloj del emulador no tiene por qué coincidir con el del equipo). */
const deviceNow = () => Number(shell('date +%s').trim()) * 1000;
const key = (name) => tryShell(`input keyevent ${name}`);
/** Los tramos «inicio:fin;inicio:fin» como [[inicio, fin]]. */
const spansOf = (text) =>
  String(text ?? '')
    .split(';')
    .map((part) => part.split(':').map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

console.log(`APK: ${apkFile}`);
console.log(`Android: ${shell('getprop ro.build.version.release').trim()} (API ${shell('getprop ro.build.version.sdk').trim()}), ${shell('getprop ro.product.model').trim()}`);
tryShell('settings put global hide_error_dialogs 1');
tryShell('svc power stayon false');
key('KEYCODE_WAKEUP');
tryShell('wm dismiss-keyguard');
shell('logcat -c');
adb('install', '-r', join(apkDir, apkFile));
// Sin acceso, como la app recién instalada: lo que haya dejado otra comprobación se quita.
tryShell(`cmd appops reset ${PKG}`);
tryShell(`am force-stop ${PKG}`);
shell(`am start -W -n ${PKG}/.MainActivity`);

const [device] = await android.devices({ omitDriverInstall: true });
if (!device) throw new Error('No hay ningún dispositivo Android conectado.');
const webView = await device.webView({ pkg: PKG }, { timeout: 120_000 });
let page = await webView.page();
page.setDefaultTimeout(60_000);

/** Espera a que alguna página del WebView tenga la app (Android puede relanzar la actividad y dejar una página vacía delante). */
async function waitForApp(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const candidate of page.context().pages()) {
      const ready = await candidate
        .evaluate(() => Boolean(window.Capacitor?.Plugins?.NativeTools) && document.visibilityState === 'visible' && innerWidth > 0)
        .catch(() => false);
      if (ready) {
        page = candidate;
        page.setDefaultTimeout(60_000);
        return true;
      }
    }
    await sleep(1_500);
  }
  return false;
}

/** Llama al plugin propio desde la página. */
const plugin = (method, args) =>
  page.evaluate(
    async ({ method: name, args: payload }) => {
      try {
        return { ok: true, value: await window.Capacitor.Plugins.NativeTools[name](payload) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    { method, args },
  );

/** Lo que la web tiene guardado del uso del móvil (`phone:AAAA-MM-DD` en el almacén `kv` de IndexedDB). */
const storedPhone = () =>
  page.evaluate(async () => {
    const request = (r) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
    const out = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await request(indexedDB.open(info.name));
      try {
        if (!db.objectStoreNames.contains('kv')) continue;
        const store = db.transaction('kv', 'readonly').objectStore('kv');
        for (const k of await request(store.getAllKeys())) {
          if (typeof k === 'string' && k.startsWith('phone:')) out.push({ db: info.name, key: k, value: await request(store.get(k)) });
        }
      } finally {
        db.close();
      }
    }
    return out;
  });

try {
  check(await waitForApp(120_000), 'La app arranca y tiene el plugin propio');

  // ───── 1) Sin el acceso no se lee nada ─────
  const before = await plugin('phoneActivityStatus', {});
  note(`estado sin acceso: ${JSON.stringify(before)}`);
  check(before.ok && before.value.supported === true, 'Este Android ofrece el acceso a los datos de uso');
  check(before.ok && before.value.granted === false, 'Sin dar el acceso, la app lo ve como NO dado');
  const denied = await plugin('readPhoneActivity', { sinceMs: deviceNow() - 3_600_000 });
  check(denied.ok && denied.value.granted === false && denied.value.uses === '', 'Sin el acceso, la lectura no devuelve nada');

  // El trabajo de fondo se programa al abrir la app, tenga o no el acceso.
  const jobs = tryShell('dumpsys jobscheduler');
  check(new RegExp(`${PKG}/\\.PhoneActivityJob`).test(jobs) || jobs.includes(`${JOB_ID}`), 'La lectura horaria de fondo está programada (JobScheduler)');

  // ───── 2) Se da el acceso (como en los ajustes de Android) ─────
  note(tryShell(`cmd appops set ${PKG} GET_USAGE_STATS allow`) || 'appops set GET_USAGE_STATS allow');
  note(`appops get: ${tryShell(`cmd appops get ${PKG} GET_USAGE_STATS`).trim()}`);
  const after = await plugin('phoneActivityStatus', {});
  check(after.ok && after.value.granted === true, 'Con el acceso dado, la app lo detecta');
  check(after.ok && after.value.screenEvents === true, 'Este Android entrega los eventos de pantalla (Android 9 o posterior)');

  // ───── 3) Se hace lo que haría una persona y se mira lo que Android registra ─────
  // El Android del emulador empieza con la pantalla encendida de las otras pruebas: se apaga y se espera para que ese uso no se una (a menos de 60 s) con lo que sigue.
  key('KEYCODE_SLEEP');
  await sleep(5_000);
  const tNotifyStart = deviceNow();
  key('KEYCODE_WAKEUP'); // un aviso que enciende la pantalla sola unos segundos, sin tocarla
  await sleep(7_000);
  key('KEYCODE_SLEEP');
  const tNotifyEnd = deviceNow();
  note('quieto 75 s (para que un uso no se una al aviso de antes)…');
  await sleep(75_000);
  const tUseStart = deviceNow();
  key('KEYCODE_WAKEUP'); // coger el móvil: pantalla, desbloqueo y una app delante
  await sleep(2_500);
  tryShell('wm dismiss-keyguard');
  await sleep(2_500);
  tryShell('am start -a android.settings.SETTINGS');
  await sleep(40_000);
  key('KEYCODE_SLEEP');
  await sleep(3_000);
  const tUseEnd = deviceNow();
  // Se vuelve a la app para poder hablar con ella.
  key('KEYCODE_WAKEUP');
  tryShell('wm dismiss-keyguard');
  shell(`am start -W -n ${PKG}/.MainActivity`);
  await waitForApp(60_000);

  // Lo que Android tiene registrado (la verdad de lo que ha pasado), por si algo no cuadra: las pantallas y, del rato del aviso, TODOS los eventos (es lo que decide si cuenta como uso).
  const dump = tryShell('dumpsys usagestats').split('\n').filter((line) => /time="\d{4}-\d\d-\d\d \d\d:\d\d:\d\d"/.test(line));
  const clockOf = (line) => /time="\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)"/.exec(line)?.[1] ?? '';
  const screens = dump.filter((line) => /SCREEN_INTERACTIVE|SCREEN_NON_INTERACTIVE|KEYGUARD_(SHOWN|HIDDEN)|DEVICE_(STARTUP|SHUTDOWN)/.test(line)).slice(-14);
  note(`eventos de pantalla del sistema (últimos): ${screens.length === 0 ? '(ninguno visible en dumpsys)' : ''}`);
  for (const line of screens) note(`  ${line.trim().slice(0, 150)}`);
  const inNotify = dump.filter((line) => clockOf(line) >= clock(tNotifyStart - 1_000) && clockOf(line) <= clock(tNotifyEnd + 1_000));
  note(`TODOS los eventos durante el aviso (${clock(tNotifyStart)}–${clock(tNotifyEnd)}): ${inNotify.length === 0 ? '(ninguno)' : ''}`);
  for (const line of inNotify) note(`  ${line.trim().slice(0, 170)}`);

  // ───── 4) La lectura del plugin ─────
  const since = tNotifyStart - 120_000;
  const read = await plugin('readPhoneActivity', { sinceMs: since });
  check(read.ok && read.value.granted === true, 'La lectura con el acceso dado devuelve datos');
  if (read.ok) {
    const { uses, offs, firstMs, lastEventMs, screenEvents, unlockEvents, appEvents } = read.value;
    note(`firstMs=${clock(firstMs)} lastEventMs=${clock(lastEventMs ?? 0)} pantalla=${screenEvents} desbloqueo=${unlockEvents} apps=${appEvents}`);
    const spans = spansOf(uses);
    note(`tramos de uso: ${spans.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(' · ') || '(ninguno)'}`);
    note(`aviso de pantalla: ${clock(tNotifyStart)}–${clock(tNotifyEnd)} · uso de verdad: ${clock(tUseStart)}–${clock(tUseEnd)}`);
    // El sistema conserva eventos de antes de lo pedido: se sabe qué pasó desde ahí, también en los ratos sin ningún evento (una noche con el móvil quieto).
    check(firstMs > 0 && firstMs <= since, 'Lo leído empieza donde el sistema conserva eventos (no en el primer evento de lo pedido)');
    check(screenEvents >= 4, `Android da los eventos de pantalla (encendida y apagada): ${screenEvents}`);
    const use = spans.find(([a, b]) => a <= tUseStart + 8_000 && b >= tUseEnd - 6_000);
    check(Boolean(use), 'Coger el móvil un rato (pantalla, desbloqueo, una app delante) sale como UN tramo de uso del tamaño de ese rato');
    check(Boolean(use) && use[1] - use[0] >= 40_000, 'Ese tramo dura al menos lo que duró el uso');
    check(!spans.some(([, b]) => b > tNotifyStart + 3_000 && b < tUseStart - 10_000), 'Una pantalla que se enciende sola unos segundos (un aviso) NO cuenta como uso');
    check(offs === '', 'No hay apagados del móvil en ese rato');
  }

  // ───── 5) El trabajo de fondo ─────
  note(tryShell(`cmd jobscheduler run -f ${PKG} ${JOB_ID}`).trim());
  await sleep(6_000);
  const prefs = tryShell(`run-as ${PKG} cat shared_prefs/phone_activity.xml`);
  const savedUses = /<string name="uses">([^<]*)<\/string>/.exec(prefs)?.[1] ?? '';
  const lastRead = Number(/<long name="lastReadMs" value="(\d+)"/.exec(prefs)?.[1] ?? 0);
  note(`preferencias del trabajo de fondo: lastReadMs=${lastRead ? clock(lastRead) : '(nada)'} tramos=${savedUses.split(';').filter(Boolean).length}`);
  check(lastRead > 0, 'El trabajo de fondo se ejecutó y dejó la hora de su lectura');
  check(spansOf(savedUses).some(([a, b]) => a <= tUseStart + 8_000 && b >= tUseEnd - 6_000), 'El trabajo de fondo dejó guardado el uso del rato');

  // ───── 6) Hasta la base de datos de la web (de donde lo coge el estimador) ─────
  // La app arrancó sin el acceso: al «volver» con él dado (como al salir de los ajustes de Android) lo detecta y lee. Se simula con el aviso de visibilidad que ya escucha.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  let stored = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    stored = await storedPhone();
    if (stored.some((row) => (row.value?.u?.length ?? 0) > 0)) break;
    await sleep(1_500);
  }
  note(`guardado en la web: ${stored.map((row) => `${row.key} (usos ${row.value?.u?.length ?? 0}, leído ${row.value?.c?.length ?? 0} tramos)`).join(' · ') || '(nada)'}`);
  const webUses = stored.flatMap((row) => row.value?.u ?? []);
  const webCoverage = stored.flatMap((row) => row.value?.c ?? []);
  check(webUses.some(([a, b]) => a <= tUseStart + 8_000 && b >= tUseEnd - 6_000), 'La web guardó el uso del rato (al volver con el acceso ya dado)');
  check(webCoverage.some(([a, b]) => a <= tUseStart && b >= tUseEnd), 'La web guardó que ese rato está leído entero (cobertura)');
} catch (error) {
  check(false, `La comprobación se interrumpió: ${error instanceof Error ? error.message : String(error)}`);
  try {
    note('--- registro de Android (app y errores) ---');
    for (const line of adb('logcat', '-d', '-t', '4000').split('\n').filter((l) => /smartring|AndroidRuntime|PhoneActivity|UsageStats/i.test(l)).slice(-50)) note(line);
  } catch {
    /* sin registro */
  }
} finally {
  await device.close().catch(() => undefined);
}

console.log(problems.length === 0 ? '\nTodo correcto.' : `\n${problems.length} comprobación(es) con fallo:\n- ${problems.join('\n- ')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
