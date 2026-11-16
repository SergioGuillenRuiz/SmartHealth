// Comprobación del APK en un emulador de Android (la lanza el CI, ver .github/workflows/android.yml).
//
// Instala el APK, lo abre y maneja su WebView con Playwright (por el depurador remoto del WebView) para ver lo que solo se
// ve dentro de Android y que las pruebas del navegador no pueden: que la app arranca con el contenedor nativo, que los
// plugins están cargados, que el Bluetooth real falla con gracia donde no hay Bluetooth y, con el anillo simulado
// (`?demo=1`), que la prueba guiada guarda su informe en Descargas con el plugin propio (MediaStore), reescribiéndolo en
// el mismo fichero, y que el menú de compartir se abre.
//
// Uso: node tools/android-smoke.mjs <carpeta con el .apk>
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _android as android } from 'playwright-core';

const apkDir = process.argv[2];
if (!apkDir) throw new Error('Uso: node tools/android-smoke.mjs <carpeta con el .apk>');
const apkFile = readdirSync(apkDir).find((name) => name.endsWith('.apk'));
if (!apkFile) throw new Error(`No hay ningún .apk en ${apkDir}`);

const PKG = 'app.smartring';
const problems = [];
const check = (ok, text) => {
  console.log(`${ok ? 'OK    ' : 'FALLO '} ${text}`);
  if (!ok) problems.push(text);
};
const note = (text) => console.log(`       ${text}`);
// Una orden de adb que se cuelga no debe colgar el CI entero: se corta a los 90 s.
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });
const shell = (command) => adb('shell', command);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Si algo se atasca del todo, que el CI lo diga en vez de agotar sus 40 minutos.
setTimeout(() => {
  console.log('\nFALLO  La comprobación superó los 15 minutos y se corta.');
  process.exit(2);
}, 15 * 60_000).unref();

/** Las copias de seguridad que la app ha dejado en Descargas: [{ name, text }]. */
function backups() {
  const names = shell('ls /sdcard/Download').split('\n').map((l) => l.trim()).filter((name) => /^smarthealth-copia-.*\.json$/.test(name));
  return names.map((name) => ({ name, text: shell(`cat '/sdcard/Download/${name}'`) }));
}

/** Los ficheros que la prueba guiada ha dejado en Descargas: [{ name, text }]. */
function reports() {
  const names = shell('ls /sdcard/Download').split('\n').map((l) => l.trim()).filter((name) => /^SmartHealth-prueba-.*\.txt$/.test(name));
  return names.map((name) => ({ name, text: shell(`cat '/sdcard/Download/${name}'`) }));
}

/** Despierta la pantalla, quita el bloqueo y la mantiene encendida: sin pantalla activa el WebView no llega a tener tamaño. */
function wakeScreen() {
  for (const command of ['input keyevent KEYCODE_WAKEUP', 'wm dismiss-keyguard', 'svc power stayon true']) {
    try {
      shell(command);
    } catch (error) {
      note(`(${command}: ${String(error.message).split('\n')[0]})`);
    }
  }
}

/**
 * Cierra el aviso «… no responde» del sistema si está en pantalla (pulsa «Esperar»). En un emulador lento aparece solo, tapa la
 * app y deja el WebView sin tamaño. Devuelve `true` si había uno.
 */
function dismissErrorDialogs(nodes = uiNodes()) {
  const wait = nodes.find((n) => n.id.endsWith(':id/aerr_wait'));
  if (!wait) return false;
  note(`aviso del sistema («${nodes.find((n) => n.id.endsWith(':id/alertTitle'))?.text ?? 'no responde'}»): se pulsa «Esperar»`);
  shell(`input tap ${wait.x} ${wait.y}`);
  return true;
}

/** Espera a que el sistema esté tranquilo tras arrancar (sin avisos de «no responde») y a que se vea el lanzador. */
async function settleSystem() {
  system('settings put global hide_error_dialogs 1'); // sin avisos de «no responde» ni de cierres: el sistema sigue sin preguntar
  const limit = Date.now() + 60_000;
  while (Date.now() < limit) {
    let focus = '';
    try {
      focus = shell('dumpsys window | grep mCurrentFocus').trim();
    } catch {
      /* sin dato */
    }
    if (/Not Responding/i.test(focus)) {
      dismissErrorDialogs();
      await sleep(2_000);
    } else if (/[Ll]auncher|Quickstep/.test(focus)) {
      break;
    } else {
      await sleep(2_000);
    }
  }
  await sleep(5_000);
}

/** Lo que Android sabe de la pantalla y de la ventana de la app: explica un WebView sin tamaño. */
function androidState() {
  const grab = (command) => {
    try {
      return shell(command);
    } catch (error) {
      return String(error.stdout ?? '');
    }
  };
  const pick = (text, pattern, max = 12) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => pattern.test(line))
      .slice(0, max);
  const mine = grab('dumpsys window windows')
    .split(/\n\s*Window #\d+ /)
    .find((block) => block.includes(`${PKG}/${PKG}.MainActivity`));
  return [
    ...pick(grab('dumpsys power'), /mWakefulness=|Display Power/),
    ...pick(grab('dumpsys window policy'), /showing=|isShowing/i),
    ...pick(grab('dumpsys window'), /mCurrentFocus|mFocusedApp/),
    ...pick(grab('dumpsys activity activities'), /topResumedActivity|ResumedActivity/),
    ...pick(mine ?? '', /isReadyForDisplay|Frames:|mViewVisibility|mHasSurface|Requested w=/, 8),
    ...(mine ? [] : [`(sin ventana de ${PKG} en «dumpsys window windows»)`]),
    ...pick(grab('dumpsys activity top'), /android\.webkit\.WebView|CapacitorWebView|DecorView@|CoordinatorLayout\{/, 8),
  ];
}

/** La pantalla del móvil en ASCII (claro = hueco, oscuro = tinta): sin ver una captura, sirve para saber dónde queda cada cosa. */
function screenAscii(cols = 44, rows = 72) {
  const raw = execFileSync('adb', ['exec-out', 'screencap'], { maxBuffer: 128 * 1024 * 1024 });
  const width = raw.readUInt32LE(0);
  const height = raw.readUInt32LE(4);
  const header = raw.length - width * height * 4; // 12 o 16 bytes según la versión de Android
  if (width === 0 || height === 0 || header < 12 || header > 32) return [`(captura ilegible: ${width}×${height}, ${raw.length} bytes)`];
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const x = Math.min(width - 1, Math.floor(((col + (dx + 0.5) / 4) * width) / cols));
          const y = Math.min(height - 1, Math.floor(((row + (dy + 0.5) / 4) * height) / rows));
          const at = header + (y * width + x) * 4;
          sum += 0.299 * raw[at] + 0.587 * raw[at + 1] + 0.114 * raw[at + 2];
          count++;
        }
      }
      line += ramp[Math.min(ramp.length - 1, Math.floor(((255 - sum / count) / 256) * ramp.length))];
    }
    lines.push(`|${line}|`);
  }
  return lines;
}
const showScreen = (title) => {
  try {
    note(`--- pantalla: ${title} ---`);
    for (const line of screenAscii()) note(line);
  } catch (error) {
    note(`(sin captura: ${String(error.message).split('\n')[0]})`);
  }
};

console.log(`APK: ${apkFile}`);
console.log(`Android: ${shell('getprop ro.build.version.release').trim()} (API ${shell('getprop ro.build.version.sdk').trim()}), ${shell('getprop ro.product.model').trim()}`);
shell('rm -f /sdcard/Download/SmartHealth-prueba-* /sdcard/Download/smarthealth-copia-*');
shell('logcat -c');
wakeScreen();
await settleSystem();
// Sin -g: la app se instala sin permisos de ejecución, como en el móvil de verdad, y es la prueba la que los pide.
adb('install', '-r', join(apkDir, apkFile));
shell(`am start -W -n ${PKG}/.MainActivity`);

const [device] = await android.devices({ omitDriverInstall: true });
if (!device) throw new Error('No hay ningún dispositivo Android conectado.');
const webView = await device.webView({ pkg: PKG }, { timeout: 120_000 });
let page = await webView.page();
const consoleErrors = [];
const watched = new WeakSet();
function adopt(next) {
  page = next;
  page.setDefaultTimeout(60_000);
  if (watched.has(page)) return;
  watched.add(page);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`excepción: ${error.message}`));
}
adopt(page);

let forcedClicks = 0;
/** Pulsa un elemento. Si Playwright no lo da por «a la vista» (un WebView sin tamaño), lanza el clic por el DOM y lo apunta. */
async function press(locator) {
  try {
    await locator.click({ timeout: 8_000 });
  } catch (error) {
    forcedClicks++;
    note(`clic forzado por el DOM (${String(error.message).split('\n')[0]})`);
    await locator.dispatchEvent('click');
  }
}

async function openSheet() {
  await press(page.getByRole('region', { name: 'Prueba guiada del anillo' }).getByRole('button', { name: 'Empezar la prueba' }));
  const sheet = page.getByRole('dialog', { name: 'Prueba guiada del anillo' });
  await sheet.getByText('Antes de empezar').waitFor();
  return sheet;
}

const viewport = () => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

/**
 * Las páginas que el depurador ve en el WebView, con su tamaño. Si hay más de una (p. ej. la de una actividad anterior ya
 * destruida, que no tiene tamaño), se pasa a la que se ve: era lo que dejaba medidas de 0×0 con la app bien pintada.
 */
async function adoptVisiblePage() {
  const all = [];
  for (const candidate of page.context().pages()) {
    const info = await candidate
      .evaluate(() => ({ w: innerWidth, h: innerHeight, visibility: document.visibilityState, focus: document.hasFocus(), href: location.href }))
      .catch((error) => ({ error: String(error.message).split('\n')[0] }));
    all.push({ candidate, info });
  }
  const best = all.find(({ info }) => info.w > 0 && info.h > 0);
  if (best && best.candidate !== page) {
    note(`se cambia a la página con tamaño: ${JSON.stringify(best.info)}`);
    adopt(best.candidate);
  }
  return all.map(({ info }) => info);
}

/**
 * Espera a que alguna página del WebView enseñe la tarjeta de actividad. Al arrancar, Android relanza la actividad y el depurador
 * puede ver dos documentos: el primero (ya destruido, vacío) y el vivo. Mirar solo el primero dejaba la comprobación esperando dos
 * minutos con la página en blanco aunque la app estuviera bien pintada (se vio con la app arrancando y haciendo sus llamadas a los
 * plugins en el registro de Android). Se mira en todas y se pasa a la que la tiene.
 */
async function waitForApp(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const candidate of page.context().pages()) {
      const shown = await candidate
        .getByRole('region', { name: 'Actividad diaria' })
        .first()
        .isVisible()
        .catch(() => false);
      if (!shown) continue;
      if (candidate !== page) {
        note('se cambia a la página que tiene la app (la primera estaba vacía)');
        adopt(candidate);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  // Sin suerte: el error de siempre, con su llamada.
  await page.getByRole('region', { name: 'Actividad diaria' }).waitFor({ timeout: 1_000 });
}

/** Espera a que el WebView tenga tamaño (con 0×0 nada «está a la vista» y las medidas no significan nada). */
async function waitForViewport(ms) {
  const limit = Date.now() + ms;
  let size = await viewport();
  while ((size.w === 0 || size.h === 0) && Date.now() < limit) {
    dismissErrorDialogs();
    await sleep(1_000);
    await adoptVisiblePage();
    size = await viewport();
  }
  return size;
}

/** Lo que registran la app y el WebView (Capacitor, Chromium) desde el arranque: el principio y el final. */
function appLog(head = 40, tail = 25) {
  try {
    const lines = adb('logcat', '-d', '-v', 'time')
      .split('\n')
      .filter((line) => /Capacitor|chromium|cr_|WebView|MainActivity|SystemBars|smartring/i.test(line) && !/AndroidRuntime|nativeloader/.test(line));
    return [...lines.slice(0, head), ...(lines.length > head + tail ? [`… (${lines.length - head - tail} líneas más)`] : []), ...lines.slice(-tail)];
  } catch (error) {
    return [`(sin registro: ${String(error.message).split('\n')[0]})`];
  }
}

/**
 * Un WebView que sigue sin tamaño tras esperar: se prueban, de menos a más drásticas, unas maneras de que lo recupere y se anota
 * cuál funcionó. Devuelve qué lo arregló, o `null`.
 */
async function recoverViewport() {
  const tries = [
    ['recargar la página', async () => {
      await page.reload();
      await page.getByRole('region', { name: 'Actividad diaria' }).waitFor({ timeout: 60_000 });
    }],
    ['cambiar el tamaño de la pantalla un instante', async () => {
      system('wm size 1079x2400');
      await sleep(3_000);
      system('wm size reset');
      await sleep(3_000);
    }],
    ['mandar la app a segundo plano y volver', async () => {
      system('input keyevent KEYCODE_HOME');
      await sleep(3_000);
      system(`am start -n ${PKG}/.MainActivity`);
      await sleep(3_000);
    }],
  ];
  for (const [what, action] of tries) {
    try {
      await action();
    } catch (error) {
      note(`(${what}: ${String(error.message).split('\n')[0]})`);
    }
    const size = await waitForViewport(8_000);
    note(`tras ${what}: ${size.w}×${size.h}`);
    if (size.w > 0 && size.h > 0) return what;
  }
  return null;
}

const retryVisible = async (sheet) => (await sheet.getByRole('button', { name: 'Reintentar' }).count()) > 0;
const promptOf = async (sheet) => ({
  title: ((await sheet.locator('.stest__title').first().textContent().catch(() => null)) ?? '').trim(),
  text: ((await sheet.locator('.stest__text').first().textContent().catch(() => null)) ?? '').trim(),
});
/** ¿La prueba ya ha pasado del paso «Móvil y Bluetooth» (busca el anillo o dice por qué no puede buscarlo)? */
const pastEnvironment = async (sheet) => /Buscando el anillo|Todav[ií]a no lo veo|No se puede buscar/.test((await promptOf(sheet)).title);
const startTest = (sheet) => press(sheet.getByRole('button', { name: 'Empezar la prueba' }));
async function cancelRun(sheet) {
  await press(sheet.getByRole('button', { name: 'Cancelar la prueba' }));
  await press(sheet.getByRole('button', { name: 'Sí, cancelar' }));
  await sheet.getByRole('heading', { name: 'Prueba cancelada' }).waitFor({ timeout: 180_000 });
  await press(sheet.getByRole('button', { name: 'Hecho' }));
}
async function waitUntil(condition, ms) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    if (await condition()) return true;
    await sleep(500);
  }
  return Boolean(await condition());
}

/** Los elementos de la pantalla según uiautomator: [{ id, text, x, y }], con el centro de cada uno. */
function uiNodes() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      shell('uiautomator dump /sdcard/smoke-ui.xml');
      const xml = shell('cat /sdcard/smoke-ui.xml');
      return [...xml.matchAll(/<node\s[^>]*>/g)].map(([tag]) => {
        const attr = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
        const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr.bounds ?? '');
        return {
          id: attr['resource-id'] ?? '',
          text: (attr.text ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
          x: box ? Math.round((Number(box[1]) + Number(box[3])) / 2) : 0,
          y: box ? Math.round((Number(box[2]) + Number(box[4])) / 2) : 0,
        };
      });
    } catch {
      /* uiautomator no logra el «reposo» si algo se mueve en pantalla: se repite */
    }
  }
  return [];
}

const ALLOW_BUTTONS = ['permission_allow_foreground_only_button', 'permission_allow_button', 'permission_allow_one_time_button'];
const DENY_BUTTONS = ['permission_deny_button', 'permission_deny_and_dont_ask_again_button'];
/** Contesta el cuadro de permisos de Android que haya en pantalla, si hay alguno: devuelve lo que ha hecho, o null. */
function answerPermissionDialog(allow, nodes = uiNodes()) {
  const message = nodes.find((n) => n.id.endsWith(':id/permission_message'))?.text;
  if (message === undefined) return null;
  const button = (allow ? ALLOW_BUTTONS : DENY_BUTTONS).map((id) => nodes.find((n) => n.id.endsWith(`:id/${id}`))).find(Boolean);
  if (!button) return `«${message}» (sin botón reconocible; ids: ${nodes.map((n) => n.id.split('/').pop()).filter((id) => id.startsWith('permission')).join(', ')})`;
  shell(`input tap ${button.x} ${button.y}`);
  return `«${message}» → ${allow ? 'permitir' : 'denegar'} («${button.text}»)`;
}
/** La ventana en primer plano según el sistema (barato: no recorre la interfaz, a diferencia de uiautomator). */
function focusNow() {
  try {
    return shell('dumpsys window | grep mCurrentFocus').trim();
  } catch {
    return '';
  }
}

/**
 * Espera a que se cumpla `done`, contestando mientras tanto a los cuadros de permisos del sistema. Mira primero qué ventana tiene
 * el foco (rápido) y solo recorre la interfaz con uiautomator (lento) cuando es el cuadro de permisos; deja anotado a qué hora
 * cambió el foco, para ver si un cuadro tardó en salir o en ser contestado.
 */
async function answerPermissions(allow, done, ms = 90_000) {
  const answered = [];
  const trail = [];
  const began = Date.now();
  const at = () => `${Math.round((Date.now() - began) / 1000)} s`;
  let lastFocus = '';
  while (Date.now() < began + ms && !(await done())) {
    const focus = focusNow();
    if (focus !== lastFocus) {
      trail.push(`${at()}: ${focus.replace(/^.*u0 /, '').replace(/\}$/, '') || '(sin dato)'}`);
      lastFocus = focus;
    }
    if (/GrantPermissionsActivity|permissioncontroller/i.test(focus)) {
      const nodes = uiNodes();
      const answer = answerPermissionDialog(allow, nodes);
      if (answer) answered.push(`(a los ${at()}) ${answer}`);
      else trail.push(`${at()}: el cuadro tiene el foco pero no se reconoce (${nodes.length} elementos)`);
      await sleep(600);
    } else if (/Not Responding/i.test(focus)) {
      dismissErrorDialogs();
      await sleep(1_000);
    } else {
      await sleep(400);
    }
  }
  note(`foco durante la espera: ${trail.join(' → ') || '(sin cambios)'}`);
  return answered;
}

/** Llama a un plugin desde la página con un tiempo máximo: sirve para ver cuál se queda sin responder. */
async function probe(kind, ms = 15_000) {
  try {
    return await page.evaluate(
      async ({ kind: which, ms: limit }) => {
        const plugins = window.Capacitor.Plugins;
        const calls = {
          permissionStatus: () => plugins.NativeTools.permissionStatus(),
          requestBlePermissions: () => plugins.NativeTools.requestBlePermissions(),
          initializeSinUbicacion: () => plugins.BluetoothLe.initialize({ androidNeverForLocation: true }),
          initializeConUbicacion: () => plugins.BluetoothLe.initialize({ androidNeverForLocation: false }),
        };
        const started = Date.now();
        const timeout = new Promise((resolve) => setTimeout(() => resolve(`SIN RESPUESTA tras ${limit} ms`), limit));
        const run = Promise.resolve()
          .then(() => calls[which]())
          .then(
            (value) => `ok ${JSON.stringify(value ?? null)}`,
            (error) => `error: ${error?.message ?? error}`,
          );
        return `${await Promise.race([run, timeout])} (${Date.now() - started} ms)`;
      },
      { kind, ms },
    );
  } catch (error) {
    return `no se pudo probar: ${String(error.message).split('\n')[0]}`;
  }
}

/** Lo que el registro de Android dice de permisos y de los plugins de Bluetooth y propio (las últimas líneas). */
function permissionLog(max = 30) {
  try {
    return adb('logcat', '-d', '-v', 'time')
      .split('\n')
      .filter((line) => /[Pp]ermission|NativeTools|BluetoothLe|Capacitor\/Plugin|ACCESS_(FINE|COARSE)/.test(line) && !/AndroidRuntime|nativeloader|uiautomator|ImeTracker/.test(line))
      .slice(-max);
  } catch (error) {
    return [`(sin registro: ${String(error.message).split('\n')[0]})`];
  }
}

const grantedPermissions = () =>
  shell(`dumpsys package ${PKG}`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^android\.permission\.(BLUETOOTH\w*|ACCESS_(FINE|COARSE)_LOCATION): granted=/.test(line))
    .map((line) => line.replace(/, flags=.*$/, ''));
const setting = (name) => shell(`settings get global ${name}`).trim();
/** Cambia un ajuste del sistema; si el emulador no deja, lo apunta y sigue (la comprobación siguiente lo dirá). */
function system(command) {
  try {
    shell(command);
  } catch (error) {
    note(`(${command}: ${String(error.message).split('\n')[0]})`);
  }
}

try {
  // ───── 1) La app arranca dentro del contenedor nativo ─────
  await waitForApp(120_000);
  const native = await page.evaluate(() => ({
    url: location.href,
    native: window.Capacitor?.isNativePlatform?.() ?? null,
    plugins: Object.fromEntries(['NativeTools', 'BluetoothLe', 'Device', 'Haptics', 'App'].map((name) => [name, window.Capacitor?.isPluginAvailable?.(name) ?? null])),
  }));
  note(`${native.url} · plataforma nativa: ${native.native}`);
  check(native.native === true, 'La app se ejecuta como app nativa de Capacitor');
  for (const [name, available] of Object.entries(native.plugins)) check(available === true, `Plugin ${name} cargado`);

  // El WebView tiene que tener tamaño antes de medir nada; si no lo tiene, se despierta la pantalla y se reabre la app.
  let size = await waitForViewport(20_000);
  if (size.w === 0 || size.h === 0) {
    note('El WebView mide 0×0: se anota qué ve cada página y se intenta recuperar');
    for (const line of androidState()) note(line);
    note(`páginas del WebView: ${JSON.stringify(await adoptVisiblePage())}`);
    try {
      const cdp = await page.context().newCDPSession(page);
      const metrics = await cdp.send('Page.getLayoutMetrics');
      note(`CDP: ${JSON.stringify({ layout: metrics.cssLayoutViewport, visual: metrics.cssVisualViewport })}`);
      note(
        `página: ${JSON.stringify(
          await page.evaluate(() => ({
            readyState: document.readyState,
            viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
            screen: [screen.width, screen.height],
            dpr: devicePixelRatio,
            visibility: document.visibilityState,
            focus: document.hasFocus(),
          })),
        )}`,
      );
    } catch (error) {
      note(`(sin métricas de CDP: ${String(error.message).split('\n')[0]})`);
    }
    for (const line of appLog()) note(line);
    const recovered = await recoverViewport();
    size = await viewport();
    check(false, `El WebView arrancó sin tamaño${recovered ? ` y se recuperó al «${recovered}»` : ' y no se recuperó'}`);
  }
  check(size.w > 0 && size.h > 0, `El WebView tiene tamaño (${size.w}×${size.h})`);
  for (const line of androidState()) note(line);
  // Sin tamaño ningún botón «está a la vista»: seguir solo gastaría minutos. Se corta con el diagnóstico a la vista.
  if (size.w === 0 || size.h === 0) throw new Error('El WebView sigue sin tamaño (mira «mCurrentFocus» y las páginas arriba)');
  showScreen('resumen al abrir la app');

  // Medidas de la pantalla dentro de Android (bordes del sistema, zonas seguras): sin una captura a la vista, los números
  // dicen si algo queda tapado por la barra de estado o la de navegación.
  const layout = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const safe = { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
    probe.remove();
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    return {
      inner: [innerWidth, innerHeight],
      outer: [outerWidth, outerHeight],
      client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      visual: [visualViewport?.width ?? null, visualViewport?.height ?? null],
      screen: [screen.width, screen.height],
      visibility: document.visibilityState,
      dpr: devicePixelRatio,
      safe,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      topbar: rect('header.topbar'),
      nav: rect('nav.nav'),
      pager: rect('main.pager'),
    };
  });
  note(`pantalla: ${shell('wm size').trim().replace(/\n/g, ' · ')} · ${shell('wm density').trim().replace(/\n/g, ' · ')}`);
  note(`WebView: ${JSON.stringify(layout)}`);
  check(layout.overflowX <= 1, 'La página no desborda en horizontal');
  check(layout.topbar !== null && layout.topbar.top >= 0, 'La barra superior está a la vista');
  check(layout.nav !== null && layout.nav.bottom <= layout.inner[1] + 1, 'La barra inferior no se sale de la pantalla');

  // La prueba guiada está oculta de la interfaz: sin el interruptor oculto no aparece.
  check((await page.getByRole('region', { name: 'Prueba guiada del anillo' }).count()) === 0, 'La prueba guiada no se ve en la interfaz normal');

  // ───── 2) Primer arranque con el Bluetooth real (sin hardware Bluetooth y con el APK instalado SIN permisos) ─────
  await page.goto('https://localhost/?prueba=1'); // el interruptor oculto que muestra la prueba guiada
  await waitForApp(120_000);
  {
    const sheet = await openSheet();
    showScreen('hoja de la prueba guiada');
    await startTest(sheet);

    // 2a) Android pide permisos: se deniegan y la prueba tiene que explicarlo y dejar reintentar.
    const denied = await answerPermissions(false, () => retryVisible(sheet));
    for (const line of denied) note(`cuadro de permisos: ${line}`);
    check(denied.length > 0, 'Android muestra cuadros de permisos al empezar la prueba');
    const afterDenied = await promptOf(sheet);
    note(`aviso al denegar: «${afterDenied.title}» — ${afterDenied.text}`);
    note(`permisos concedidos: ${grantedPermissions().join(' · ') || 'ninguno'}`);
    check(await retryVisible(sheet), 'Con los permisos denegados la prueba lo explica y deja reintentar');

    // 2b) Reintentar y conceder: la prueba sigue hasta buscar el anillo.
    if (await retryVisible(sheet)) await press(sheet.getByRole('button', { name: 'Reintentar' }));
    const allowed = await answerPermissions(true, () => pastEnvironment(sheet));
    for (const line of allowed) note(`cuadro de permisos: ${line}`);
    check(allowed.length > 0, 'Al reintentar Android vuelve a pedir los permisos');
    const granted = grantedPermissions();
    note(`permisos concedidos: ${granted.join(' · ') || 'ninguno'}`);
    check(
      ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_FINE_LOCATION'].every((name) => granted.some((line) => line.startsWith(`android.permission.${name}: granted=true`))),
      'Tras aceptar los cuadros, la app tiene los permisos de Bluetooth y la ubicación precisa',
    );
    let moved = await pastEnvironment(sheet);
    if (!moved && (await retryVisible(sheet))) {
      // Si los cuadros salieron tan tarde que la prueba ya había dado la espera por perdida, al reintentar la petición ya resuelta basta.
      note('la prueba dio los permisos por no respondidos; se reintenta una vez más');
      await press(sheet.getByRole('button', { name: 'Reintentar' }));
      moved = await waitUntil(() => pastEnvironment(sheet), 30_000);
    }
    check(moved, 'Con los permisos concedidos la prueba pasa a buscar el anillo');
    // Con todo concedido, qué llamadas responden y cuáles se quedan colgadas (y cuánto tardan): así se ve dónde se atasca.
    for (const kind of ['permissionStatus', 'requestBlePermissions', 'initializeSinUbicacion', 'initializeConUbicacion']) note(`prueba directa de ${kind}: ${await probe(kind)}`);
    if (!moved) for (const line of permissionLog()) note(`registro: ${line.trim()}`);

    // El botón «atrás» (o el gesto) no debe sacar de la app ni cerrar la hoja a mitad de la prueba.
    shell('input keyevent KEYCODE_BACK');
    await sleep(1_500);
    const top = shell('dumpsys activity activities | grep -E "topResumedActivity"').trim();
    check(top.includes(PKG) && (await sheet.isVisible()), `El botón «atrás» no saca de la app ni cierra la hoja a mitad de la prueba (${top.split('\n')[0] ?? ''})`);
    try {
      const interesting = adb('logcat', '-d')
        .split('\n')
        .filter((line) => /must be requested|ACCESS_FINE_LOCATION.*COARSE|GrantPermissionsActivity.*(ignor|invalid)/i.test(line))
        .slice(-6);
      for (const line of interesting) note(`registro de permisos: ${line.trim()}`);
    } catch {
      /* sin registro */
    }

    // La búsqueda sin hardware: avisos de la prueba.
    const seen = [];
    for (let i = 0; i < 30; i++) {
      const prompt = await promptOf(sheet);
      if (prompt.title && seen.at(-1)?.title !== prompt.title) {
        seen.push(prompt);
        note(`aviso: «${prompt.title}» — ${prompt.text}`);
      }
      if (await retryVisible(sheet)) break;
      await sleep(500);
    }
    check(seen.length > 0, 'La prueba muestra avisos con el Bluetooth real');
    await cancelRun(sheet);
    check(true, 'Cancelar la prueba funciona con el Bluetooth real');
  }

  // 2c) Ubicación apagada: la prueba lo dice y, al encenderla y reintentar, sigue.
  system('cmd location set-location-enabled false');
  {
    const sheet = await openSheet();
    await startTest(sheet);
    const stopped = await waitUntil(() => retryVisible(sheet), 60_000);
    const gate = await promptOf(sheet);
    note(`aviso con la ubicación apagada: «${gate.title}» — ${gate.text}`);
    check(stopped && /ubicaci/i.test(gate.text), 'Con la ubicación apagada la prueba lo dice y deja reintentar');
    system('cmd location set-location-enabled true');
    await sleep(1_500);
    if (await retryVisible(sheet)) await press(sheet.getByRole('button', { name: 'Reintentar' }));
    check(await waitUntil(() => pastEnvironment(sheet), 60_000), 'Al encender la ubicación y reintentar, la prueba sigue');
    await cancelRun(sheet);
  }

  // 2d) Bluetooth apagado: igual.
  system('svc bluetooth disable');
  note(`Bluetooth apagado: ${(await waitUntil(() => setting('bluetooth_on') === '0', 30_000)) ? 'sí' : 'no'}`);
  {
    const sheet = await openSheet();
    await startTest(sheet);
    const stopped = await waitUntil(() => retryVisible(sheet), 60_000);
    const gate = await promptOf(sheet);
    note(`aviso con el Bluetooth apagado: «${gate.title}» — ${gate.text}`);
    check(stopped && /bluetooth/i.test(gate.text), 'Con el Bluetooth apagado la prueba lo dice y deja reintentar');
    system('svc bluetooth enable');
    note(`Bluetooth encendido: ${(await waitUntil(() => setting('bluetooth_on') === '1', 30_000)) ? 'sí' : 'no'}`);
    let moved = false;
    for (let attempt = 1; attempt <= 4 && !moved; attempt++) {
      await sleep(3_000); // el adaptador tarda unos segundos en estar listo
      if (await retryVisible(sheet)) await press(sheet.getByRole('button', { name: 'Reintentar' }));
      moved = await waitUntil(() => pastEnvironment(sheet), 15_000);
    }
    check(moved, 'Al encender el Bluetooth y reintentar, la prueba sigue');
    await cancelRun(sheet);
  }

  const afterCancel = reports();
  check(afterCancel.length === 3, `Cada prueba cancelada deja su fichero en Descargas (${afterCancel.length} de 3)`);
  check(afterCancel.every((r) => r.text.includes('Prueba CANCELADA')), 'Los informes dicen que se cancelaron');
  check(afterCancel.every((r) => /Móvil: .*Android 1\d/.test(r.text)), 'Los informes llevan los datos del móvil');
  const first = afterCancel[0];
  if (first) {
    note('--- principio del primer informe (Bluetooth real sin hardware) ---');
    for (const line of first.text.split('\n').slice(0, 14)) note(line);
    const envStart = first.text.indexOf('"id": "env"');
    if (envStart >= 0) for (const line of first.text.slice(envStart, envStart + 900).split('\n')) note(line);
  }

  // ───── 3) Prueba completa con el anillo simulado: guardado en Descargas con el plugin propio ─────
  await page.goto('https://localhost/?demo=1&prueba=1');
  await waitForApp(120_000);
  {
    const sheet = await openSheet();
    await press(sheet.getByRole('button', { name: 'Empezar la prueba' }));
    await sheet.getByRole('heading', { name: 'Pasos: prepárate' }).waitFor({ timeout: 180_000 });
    await press(sheet.getByRole('button', { name: 'Estoy listo' }));
    await sheet.getByRole('heading', { name: 'Entreno: prepárate' }).waitFor({ timeout: 180_000 });
    await press(sheet.getByRole('button', { name: 'Estoy listo' }));
    await sheet.getByRole('heading', { name: 'Prueba terminada' }).waitFor({ timeout: 240_000 });
    check(true, 'La prueba guiada con el anillo simulado termina');
    const banner = (await sheet.getByText(/Informe guardado en/).textContent()) ?? '';
    note(banner.trim());
    check(/Download\/SmartHealth-prueba-/.test(banner), 'La hoja dice que el informe está en Download/');

    const all = reports();
    const demo = all.find((r) => r.text.includes('MODO DEMOSTRACIÓN'));
    check(all.length === 4, `Quedan cuatro ficheros (tres cancelaciones y la completa), no uno por cada guardado de seguridad (${all.length})`);
    check(Boolean(demo), 'El informe completo está en Descargas');
    if (demo) {
      check(/Prueba (completa|terminada)/.test(demo.text), 'El informe completo dice «Prueba completa» o «terminada» (el último guardado reescribió al anterior)');
      check(demo.text.trimEnd().endsWith('===== FIN DEL INFORME ====='), 'El informe no quedó truncado (la reescritura vació el contenido anterior)');
      check(/Móvil: .*Android 1\d/.test(demo.text), 'El informe lleva los datos del móvil');
      check(demo.text.includes('===== TRAZA «sync»') && demo.text.includes('===== TRAZA «workout»'), 'El informe lleva las trazas');
      note(`${demo.name}: ${demo.text.length} caracteres`);
    }

    // El menú de compartir de Android se abre con el fichero guardado.
    await press(sheet.getByRole('button', { name: 'Enviar el fichero' }));
    await sleep(3000);
    const focus = shell('dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"').trim();
    note(`actividad al compartir: ${focus.split('\n')[0] ?? ''}`);
    check((await page.getByText('No se pudo abrir el menú de compartir').count()) === 0, 'El menú de compartir se abre sin error');
    shell('input keyevent KEYCODE_BACK');
    await sleep(1000);

    // «Exportar copia»: el WebView ignora en silencio las descargas de un enlace, así que la copia solo existe si la app la
    // guarda ella en Descargas. (Con el fallo antiguo la app decía «Copia exportada» sin que existiera ningún fichero.)
    await press(sheet.getByRole('button', { name: 'Hecho' }));
    // Los datos y las copias están en el menú de perfil (el icono de usuario, arriba a la izquierda).
    await press(page.getByRole('button', { name: 'Mi perfil' }));
    await press(page.getByRole('dialog', { name: 'Mi perfil', exact: true }).getByRole('button', { name: /^Datos y copias de seguridad/ }));
    const dataCard = page.getByRole('dialog', { name: 'Datos y copias de seguridad', exact: true });
    await dataCard.waitFor({ timeout: 60_000 });
    await press(dataCard.getByRole('button', { name: 'Exportar copia' }));
    const saved = await waitUntil(() => backups().length > 0, 30_000);
    check(saved, 'Exportar copia deja el fichero en Descargas (el WebView no descarga enlaces)');
    const [backup] = backups();
    if (backup) {
      let parsed = null;
      try {
        parsed = JSON.parse(backup.text);
      } catch {
        /* se comprueba abajo */
      }
      check(parsed?.format === 'smartring-backup', 'El fichero es una copia de SmartHealth válida (JSON completo, no truncado)');
      check(Array.isArray(parsed?.data?.sleep) && parsed.data.sleep.length > 0, 'La copia lleva los datos (noches de sueño de la demostración)');
      note(`${backup.name}: ${backup.text.length} caracteres`);
    }
    const toast = await page
      .getByRole('status')
      .filter({ hasText: /Copia guardada en Download\/smarthealth-copia-/ })
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true, () => false);
    check(toast, 'La app dice dónde ha quedado la copia («Copia guardada en Download/…»)');
  }

  // ───── 3b) Alimentación: el escáner de códigos de barras dentro del WebView de Android (lo que el navegador no puede ver) ─────
  // La cámara (con el permiso ya concedido, sin cuadro), el WebAssembly del lector bajo la política de contenido de la app y la
  // consulta a internet. El emulador puede no tener cámara o salida a internet: eso se anota, no se da por fallo de la app.
  system(`pm grant ${PKG} android.permission.CAMERA`);
  // Se cierran la tarjeta de datos y el menú de perfil que quedaron abiertos (una hoja encima de otra).
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(700);
  }
  await press(page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: 'Salud' }));
  await press(page.getByRole('button', { name: 'He comido algo' }));
  await press(page.getByRole('button', { name: /Escanear un código de barras/ }));
  const scanner = page.locator('dialog.sheet[open]');
  const cameraState = await waitUntil(async () => (await scanner.getByText(/No hay permiso|no tiene una cámara|no está disponible|No se pudo abrir la cámara/).count()) > 0 || (await scanner.locator('video.scan__video').evaluate((v) => v.videoWidth > 0).catch(() => false)), 30_000);
  const cameraProblem = await scanner.locator('.banner').innerText().catch(() => '');
  const streaming = await scanner.locator('video.scan__video').evaluate((v) => v.videoWidth > 0).catch(() => false);
  if (streaming) {
    check(true, 'El escáner abre la cámara del móvil dentro de la app');
    await sleep(4000); // el lector (WebAssembly) se carga al abrir el escáner
    const wasm = await page.evaluate(() => ({ module: typeof WebAssembly, loaded: performance.getEntriesByType('resource').some((e) => e.name.includes('.wasm')) }));
    check(wasm.module === 'object' && wasm.loaded, 'El lector de códigos (WebAssembly) se carga dentro de la app con su política de contenido');
  } else {
    note(`La cámara no está disponible en este emulador: ${cameraProblem.replace(/\s+/g, ' ') || (cameraState ? 'sin detalle' : 'sin respuesta')}. No se puede probar el escáner aquí.`);
    check(!/No hay permiso/.test(cameraProblem), 'Con el permiso de cámara concedido, la app no dice que falta el permiso');
  }
  // Un código tecleado se busca en la base de productos que lleva el APK (la base va dentro del APK: no hace falta internet). El código es el
  // de una lata de Coca-Cola, que está en la base de Open Food Facts de España; uno inventado no debe encontrarse.
  await scanner.getByLabel('O teclea el código').fill('5449000000996');
  await press(scanner.getByRole('button', { name: 'Buscar' }));
  const found = await waitUntil(async () => (await scanner.getByLabel('Cantidad que has comido (g o ml)').count()) > 0, 30_000);
  const product = (await scanner.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(found && /Coca-Cola|Coke/i.test(product), 'Un código de barras se busca en la base de productos del APK, sin internet');
  note(`producto encontrado en el APK: ${product.slice(0, 160)}`);
  // Internet solo para la foto de los productos (Open Food Facts): el permiso está y el escáner sigue encontrando el producto con la base del APK aunque la red falle.
  check((await shell(`dumpsys package ${PKG}`)).indexOf('android.permission.INTERNET') >= 0, 'El APK instalado declara el permiso de internet (foto de los productos)');
  await page.keyboard.press('Escape').catch(() => undefined);
  await sleep(500);
  await press(page.getByRole('button', { name: 'He comido algo' })).catch(() => undefined);
  await press(page.getByRole('button', { name: /Contarlo con tus palabras/ })).catch(() => undefined);
  const wordsSheet = page.locator('dialog.sheet[open]');
  await wordsSheet.getByLabel('¿Qué has comido?').fill('dos huevos y un café con leche').catch(() => undefined);
  await press(wordsSheet.getByRole('button', { name: 'Calcular calorías' })).catch(() => undefined);
  const calculated = await waitUntil(async () => (await wordsSheet.getByRole('list', { name: 'Lo que se ha calculado' }).count()) > 0, 15_000);
  check(calculated, 'Lo escrito con palabras se calcula dentro del APK, sin internet');
  await page.keyboard.press('Escape').catch(() => undefined);
  await sleep(500);

  // ───── 3b') La foto de la tabla nutricional: el lector (Tesseract en WebAssembly) dentro del WebView ─────
  // Es la función que más se quejó de «no funciona o tarda una barbaridad» y nunca se había visto leer una foto dentro del APK (en el navegador sí). Se le enseña a la app un
  // producto nuevo con una etiqueta dibujada y se mide cuánto tarda desde que se elige la foto hasta tener las cifras; el emulador no es un móvil, pero dice si el
  // trabajador, el núcleo y el idioma del APK se cargan y leen bajo su política de contenido.
  try {
    const ean13 = (body) => body + ((10 - ([...body].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10)) % 10);
    // Qué archivos del lector lleva el APK y cuáles sirve la app. La ronda 38 descubrió aquí que `ocr/spa.traineddata.gz` daba 404 dentro del APK (en el navegador no): la lectura de la
    // foto no había funcionado nunca en el móvil. El idioma va ahora dentro de `ocr/spa-data.js`; esto lo vigila.
    const inApk = execFileSync('unzip', ['-l', join(apkDir, apkFile)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((line) => /assets\/public\/ocr\//.test(line))
      .map((line) => line.trim().replace(/\s+/g, ' '));
    note(`archivos del lector en el APK: ${inApk.join(' | ') || '(ninguno)'}`);
    const served = await page.evaluate(async () => {
      const out = {};
      for (const name of ['worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'spa-data.js', 'spa.traineddata.gz']) {
        try {
          const response = await fetch(`ocr/${name}`);
          const bytes = await response.arrayBuffer();
          out[name] = `${response.status} · ${bytes.byteLength} B`;
        } catch (error) {
          out[name] = String(error);
        }
      }
      return out;
    });
    note(`lo que sirve la app: ${JSON.stringify(served)}`);
    check(['worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'spa-data.js'].every((name) => String(served[name]).startsWith('200 ')), 'La app sirve el trabajador, el núcleo y el idioma del lector de fotos (200 cada uno)');
    // Que no quede ninguna hoja abierta de antes (la de «contarlo con palabras» no siempre se cierra con una sola vez Escape): una hoja abierta tapa el botón y el clic no llega.
    for (let i = 0; i < 4 && (await page.locator('dialog.sheet[open]').count()) > 0; i++) {
      await page.keyboard.press('Escape').catch(() => undefined);
      await sleep(700);
    }
    const stillOpen = await page.locator('dialog.sheet[open]').count();
    if (stillOpen > 0) note(`queda una hoja abierta antes de empezar: ${(await page.locator('dialog.sheet[open]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`);
    await press(page.getByRole('button', { name: 'He comido algo' }));
    await press(page.getByRole('button', { name: /Escanear un código de barras/ }));
    const teach = page.locator('dialog.sheet[open]');
    // Un código que NO esté en la base de ~240 000 productos del APK (la de verdad, no la de prueba del navegador): se prueban varios hasta que la app ofrezca enseñarlo.
    let offered = false;
    for (const body of ['849987654321', '849912345678', '849900000007', '849955555559']) {
      await teach.getByLabel('O teclea el código').fill(ean13(body));
      await press(teach.getByRole('button', { name: 'Buscar' }));
      offered = await waitUntil(async () => (await teach.getByRole('button', { name: 'Enseñarle este producto' }).count()) > 0, 8_000);
      if (offered) break;
      note(`el código ${ean13(body)} no ofrece «Enseñarle este producto»: ${(await teach.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    await press(teach.getByRole('button', { name: 'Enseñarle este producto' }));
    await press(teach.getByRole('button', { name: /Hacer una foto a la tabla/ }));
    const warmedAt = Date.now();
    const rows = ['INFORMACIÓN NUTRICIONAL', 'Valores medios por 100 g', 'Valor energético 1046 kJ / 250 kcal', 'Grasas 12 g', 'de las cuales saturadas 3,1 g', 'Hidratos de carbono 28 g', 'de los cuales azúcares 9,5 g', 'Fibra alimentaria 2,1 g', 'Proteínas 6,0 g', 'Sal 0,52 g'];
    const base64 = await page.evaluate(async (lines) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 120 + lines.length * 62;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000';
      context.font = '40px sans-serif';
      lines.forEach((line, index) => context.fillText(line, 40, 80 + index * 62));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    }, rows);
    // Unos segundos con la cámara abierta (lo que tarda una persona en encuadrar): el lector se va calentando mientras tanto.
    await sleep(Math.max(0, 5_000 - (Date.now() - warmedAt)));
    const startedAt = Date.now();
    await teach.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'etiqueta.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
    const outcome = await waitUntil(
      async () => (await teach.getByLabel('Calorías por 100 g (kcal)').count()) > 0 || (await teach.getByText(/No se pudo leer|tarda demasiado|no puede leer|No se pudo abrir esa foto|No se ha podido leer ninguna cifra/).count()) > 0,
      180_000,
    );
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const kcal = await teach.getByLabel('Calorías por 100 g (kcal)').inputValue().catch(() => '');
    const fat = await teach.getByLabel('Grasas (g)').inputValue().catch(() => '');
    note(`lectura de la foto de una tabla en el emulador: ${outcome ? `${seconds} s` : 'sin respuesta en 180 s'}, calorías «${kcal}», grasas «${fat}»; texto en pantalla: ${(await teach.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
    check(outcome && kcal === '250' && fat === '12', `El lector de fotos (Tesseract, dentro del APK) lee la tabla nutricional de una foto, sin internet (${outcome ? `${seconds} s tras elegir la foto` : 'no terminó'})`);
    check(Number(seconds) < 90, `y no tarda una barbaridad: ${seconds} s en el emulador (el límite del lector son 120 s)`);
  } catch (error) {
    check(false, `El lector de fotos de la tabla nutricional falló: ${String(error?.message ?? error).split('\n')[0]}`);
    note(`pantalla en ese momento: ${(await page.locator('dialog.sheet[open]').first().innerText().catch(() => '(sin hoja abierta)')).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(600);
  }

  // ───── 3b) El WebView con la pantalla apagada: ¿le siguen llegando los avisos del lado nativo? ─────
  // Lo que se quejó del pulso de un entreno: con la pantalla apagada algunos móviles dejan el WebView parado y las lecturas del anillo se
  // procesan tarde (o nunca). Aquí se mide en un Android de serie: el servicio del entreno (sin GPS) manda un aviso cada 2 s con su hora y
  // la web lo cuenta con la suya; si el WebView sigue vivo con la pantalla apagada, el retraso es de milisegundos.
  try {
    const started = await page.evaluate(async () => {
      const tracker = window.Capacitor?.Plugins?.Tracker;
      if (!tracker) return { error: 'sin plugin Tracker' };
      window.__ticks = [];
      await tracker.addListener('tick', (event) => window.__ticks.push([Date.now(), event?.now ?? 0, event?.n ?? 0]));
      try {
        return await tracker.start({ sessionId: 'ci-probe', startedAtMs: Date.now(), title: 'SmartHealth', text: 'Prueba del CI', gps: false });
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    });
    note(`servicio del entreno sin GPS: ${JSON.stringify(started).slice(0, 300)}`);
    if (started?.error) {
      note('no se pudo arrancar el servicio: no se mide el WebView con la pantalla apagada');
    } else {
      await sleep(8_000);
      const awake = await page.evaluate(() => window.__ticks.slice());
      const lagOf = (rows) => rows.filter(([, native]) => native > 0).map(([arrived, native]) => arrived - native);
      const awakeLags = lagOf(awake);
      note(`con la pantalla encendida: ${awake.length} avisos nativos en 8 s, retraso máximo ${Math.max(0, ...awakeLags)} ms`);
      check(awake.length >= 2, 'Con la pantalla encendida llegan los avisos del servicio nativo del entreno');
      // Cada aviso lleva su número de orden (1, 2, 3…): con la pantalla apagada, si la web recibe «10, 11, 40» los avisos se perdieron por el camino; con la numeración seguida y la hora saltando, el parado fue el móvil (ver `screen-off-report.ts`).
      const contiguous = (rows) => {
        const numbers = rows.map(([, , n]) => n).filter((n) => n > 0);
        return numbers.length >= 2 && numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
      };
      check(contiguous(awake), `Los avisos nativos van numerados sin saltos (${awake.slice(0, 5).map(([, , n]) => n).join(', ')}…)`);
      // Lo que el servicio cuenta de cómo está el móvil, para explicar por qué se interrumpiría una grabación (ronda 52).
      const phone = await page.evaluate(async () => {
        try {
          return await window.Capacitor.Plugins.Tracker.status();
        } catch (error) {
          return { error: String(error?.message ?? error) };
        }
      });
      note(`cómo está el móvil: ${JSON.stringify({ powerSave: phone.powerSave, idle: phone.idle, bgRestricted: phone.bgRestricted, bucket: phone.bucket, bgLocation: phone.bgLocation, autostart: phone.autostart })}`);
      check(typeof phone.powerSave === 'boolean' && typeof phone.idle === 'boolean' && typeof phone.bgLocation === 'boolean', 'El estado del servicio cuenta si el ahorro de batería y el reposo están activos y si la ubicación es «siempre»');
      check(typeof phone.bgRestricted === 'boolean' && typeof phone.bucket === 'number', `y si Android restringe la app en segundo plano y su cubo de uso (${phone.bucket})`);

      // Los botones de la notificación fija del entreno (ronda 41): «Pausa» (o «Reanudar») y «Parar», con un toque. Se mira lo que Android tiene anotado de esa notificación.
      try {
        const dump = shell('dumpsys notification --noredact');
        const block = dump.split(/\n(?=\s*NotificationRecord)/).find((chunk) => chunk.includes(PKG) && chunk.includes('Prueba del CI')) ?? '';
        if (block) {
          check(/Pausa/.test(block) && /Parar/.test(block), 'La notificación del entreno lleva los botones «Pausa» y «Parar»');
          note(`notificación del entreno: ${(block.match(/actions=\d+|\[\d\] "[^"]+"/g) ?? []).join(' ')}`);
        } else {
          note('(no se encontró la notificación del entreno en «dumpsys notification»: no se comprueban sus botones)');
        }
      } catch (error) {
        note(`(no se pudieron mirar los botones de la notificación: ${String(error?.message ?? error).split('\n')[0]})`);
      }

      system('svc power stayon false');
      system('input keyevent KEYCODE_HOME');
      await sleep(1_500);
      system('input keyevent KEYCODE_SLEEP');
      const offFrom = Date.now();
      await sleep(45_000);
      wakeScreen();
      const offTo = Date.now();
      await sleep(4_000);
      await adoptVisiblePage();
      const all = await page.evaluate(() => window.__ticks.slice());
      const off = all.filter(([, native]) => native >= offFrom + 3_000 && native <= offTo);
      const offLags = lagOf(off);
      const sorted = [...offLags].sort((x, y) => x - y);
      note(`con la pantalla apagada (45 s): ${off.length} avisos nativos (unos 20 esperados), retraso mediano ${sorted[Math.floor(sorted.length / 2)] ?? '—'} ms, máximo ${Math.max(0, ...offLags)} ms`);
      check(off.length >= 12, `Con la pantalla apagada el WebView sigue recibiendo los avisos del servicio nativo (${off.length} de unos 20)`);
      check(offLags.length > 0 && Math.max(...offLags) < 5_000, `y los recibe a tiempo: retraso máximo ${Math.max(0, ...offLags)} ms (con el WebView parado llegarían todos de golpe al encender la pantalla)`);
      check(contiguous(off), `y sin perder ninguno por el camino (numeración seguida: ${off.slice(0, 3).map(([, , n]) => n).join(', ')}… ${off.slice(-2).map(([, , n]) => n).join(', ')})`);
    }
    await page.evaluate(async () => {
      await window.Capacitor?.Plugins?.Tracker?.stop?.();
    }).catch(() => undefined);
  } catch (error) {
    note(`(la medida del WebView con la pantalla apagada falló: ${String(error?.message ?? error).split('\n')[0]})`);
  }

  check(forcedClicks === 0, `Todos los botones se pudieron pulsar como lo haría un dedo (${forcedClicks} clics forzados)`);

  // ───── 4) Que nada se haya roto por dentro ─────
  const crashes = adb('logcat', '-d', '-b', 'crash').trim();
  check(!crashes.includes(PKG), 'No hay cierres inesperados de la app en el registro de Android');
  if (crashes) note(crashes.slice(0, 1500));
  const csp = consoleErrors.filter((text) => /content security policy|refused to/i.test(text));
  check(csp.length === 0, 'La política de seguridad no bloquea nada');
  if (consoleErrors.length) note(`errores de consola (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);
} catch (error) {
  check(false, `La comprobación se interrumpió: ${error instanceof Error ? error.message : String(error)}`);
  try {
    for (const line of androidState()) note(line);
    showScreen('al interrumpirse la comprobación');
    try {
      const view = await page.evaluate(() => ({
        title: document.title,
        dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => (d.innerText || '').slice(0, 300)),
        regions: [...document.querySelectorAll('section[aria-label],[role=region]')].map((el) => el.getAttribute('aria-label')),
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 900),
      }));
      note(`página al interrumpirse: ${JSON.stringify(view)}`);
    } catch (viewError) {
      note(`(no se pudo leer la página: ${String(viewError.message).split('\n')[0]})`);
    }
    if (consoleErrors.length) note(`errores de consola (${consoleErrors.length}): ${consoleErrors.slice(0, 8).join(' | ')}`);
    note('--- registro de Android (Capacitor y errores) ---');
    for (const line of adb('logcat', '-d', '-t', '4000').split('\n').filter((l) => /Capacitor|chromium|AndroidRuntime|smartring|CONSOLE/i.test(l)).slice(-60)) note(line);
  } catch {
    /* sin registro */
  }
} finally {
  await device.close().catch(() => undefined);
}

console.log(problems.length === 0 ? '\nTodo correcto.' : `\n${problems.length} comprobación(es) con fallo:\n- ${problems.join('\n- ')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
