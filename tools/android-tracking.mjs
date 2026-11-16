// Comprobación del servicio que graba la ruta de un entreno, en un emulador de Android (la lanza el CI después de android-smoke.mjs,
// ver .github/workflows/android.yml).
//
// Lo que no se puede ver con pruebas unitarias ni en el navegador: que el servicio de ubicación en primer plano arranca de verdad en
// Android 14, que graba la ruta con la PANTALLA APAGADA (la queja de origen: el GPS del WebView se perdía) y que lo grabado queda en
// el fichero de la pista. Se arranca el servicio como lo haría el plugin y se le dan posiciones con `adb emu geo fix`.
//
// Uso: node tools/android-tracking.mjs <carpeta con el .apk>
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const apkDir = process.argv[2];
if (!apkDir) throw new Error('Uso: node tools/android-tracking.mjs <carpeta con el .apk>');
const apkFile = readdirSync(apkDir).find((name) => name.endsWith('.apk'));
if (!apkFile) throw new Error(`No hay ningún .apk en ${apkDir}`);

const PKG = 'app.smartring';
const SESSION = 'ci-track';
const TRACK_FILE = `files/track-${SESSION}.csv`;
const problems = [];
const check = (ok, text) => {
  console.log(`${ok ? 'OK    ' : 'FALLO '} ${text}`);
  if (!ok) problems.push(text);
};
const note = (text) => console.log(`       ${text}`);
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
const shell = (command) => adb('shell', command);
/** Como `shell`, pero un fallo no corta: devuelve el texto del error (para lo que solo es diagnóstico o puede no existir). */
const tryShell = (command) => {
  try {
    return shell(command);
  } catch (error) {
    return `(${command}: ${String(error.message).split('\n')[0]})`;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => {
  console.log('\nFALLO  La comprobación superó los 8 minutos y se corta.');
  process.exit(2);
}, 8 * 60_000).unref();

/** Las filas de la pista: [{ seq, tsMs, lat, lon }] (vacío si el fichero no existe aún). */
function track() {
  let text = '';
  try {
    text = shell(`run-as ${PKG} cat ${TRACK_FILE}`);
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.trim().split(','))
    .filter((parts) => parts.length >= 8)
    .map((parts, i) => ({ seq: i + 1, tsMs: Number(parts[1]), lat: Number(parts[2]), lon: Number(parts[3]) }));
}

/**
 * Lo que dice Android del servicio: si está en primer plano y de qué tipo (ubicación = 0x8, dispositivo conectado = 0x10). `dumpsys` imprime
 * los registros de todos los servicios de la app (también los del WebView, que van primero): solo cuenta el de `TrackingService`, y su tipo
 * sale como hexadecimal con o sin `0x` (`types=00000008` en Android 14).
 */
function parseServiceState(text) {
  const record = text.split(/^\s*\* ServiceRecord/m).find((part) => /\.TrackingService\b/.test(part.split('\n')[0] ?? '')) ?? '';
  const hex = /\b(?:foregroundServiceType|types?)=(?:0x)?([0-9a-f]+)\b/i.exec(record);
  const bits = hex ? parseInt(hex[1], 16) : 0;
  return {
    foreground: /isForeground=true/.test(record),
    location: (bits & 0x8) !== 0 || /FOREGROUND_SERVICE_TYPE_LOCATION/i.test(record),
    connectedDevice: (bits & 0x10) !== 0 || /FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/i.test(record),
    text: record,
  };
}

function serviceState() {
  return parseServiceState(tryShell(`dumpsys activity services ${PKG}`));
}

/** Las preferencias del servicio (`smartring_tracker`): la cola de órdenes de la notificación, la pausa y si hay entreno activo. */
const prefsXml = () => tryShell(`run-as ${PKG} cat shared_prefs/smartring_tracker.xml`);
const prefLong = (xml, name) => Number(new RegExp(`<long name="${name}" value="(-?\\d+)"`).exec(xml)?.[1] ?? 0);
const prefString = (xml, name) => new RegExp(`<string name="${name}">([^<]*)</string>`).exec(xml)?.[1] ?? '';
/** Manda al servicio la misma orden que mandaría un botón de su notificación (la acción del `PendingIntent`). */
const press = (order) => tryShell(`am startservice -n ${PKG}/.TrackingService -a app.smartring.tracking.${order}`);

let latitude = 40.4168;
const LONGITUDE = -3.7038;
/** Da `count` posiciones al GPS del emulador, una por segundo, avanzando hacia el norte (≈ 5,5 m cada una). */
async function drive(count) {
  for (let i = 0; i < count; i++) {
    latitude += 0.00005;
    try {
      adb('emu', 'geo', 'fix', String(LONGITUDE), String(latitude), '650');
    } catch (error) {
      note(`(geo fix: ${String(error.message).split('\n')[0]})`);
    }
    await sleep(1000);
  }
}

console.log(`Android ${tryShell('getprop ro.build.version.release').trim()} (API ${tryShell('getprop ro.build.version.sdk').trim()})`);
adb('install', '-r', join(apkDir, apkFile));
for (const permission of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'POST_NOTIFICATIONS']) {
  note(tryShell(`pm grant ${PKG} android.permission.${permission}`).trim() || `permiso ${permission} concedido`);
}
tryShell('settings put secure location_mode 3');
tryShell('svc power stayon true');
tryShell('input keyevent KEYCODE_WAKEUP');
tryShell('wm dismiss-keyguard');
tryShell('am force-stop app.smartring');
tryShell(`run-as ${PKG} rm -f ${TRACK_FILE}`);
shell(`am start -W -n ${PKG}/.MainActivity`);
await sleep(6000);

// 1) El servicio arranca como lo arrancaría el plugin, con la app a la vista.
const start = tryShell(
  `am start-foreground-service -n ${PKG}/.TrackingService -a app.smartring.tracking.START --es session ${SESSION} --el startedAtMs ${Date.now()} --es title SmartHealth --es text "Prueba del CI"`,
);
note(start.trim());
await sleep(3000);
let state = serviceState();
check(state.foreground, 'el servicio está en primer plano');
check(state.location, 'y es de tipo ubicación');
if (!state.foreground || !state.location) note(state.text.split('\n').slice(0, 40).join('\n       '));
const notifications = tryShell('dumpsys notification --noredact');
check(/Prueba del CI|SmartHealth/.test(notifications) && /ic_stat_tracking|app\.smartring/.test(notifications), 'su aviso fijo está en la barra de notificaciones');

// 1b) Los botones de la notificación (ronda 41): «Pausa»/«Reanudar» y «Parar». Se manda al servicio lo mismo que mandarían al pulsarlos y se mira lo que queda anotado y lo que enseña la notificación.
const record = notifications.split(/\n(?=\s*NotificationRecord)/).find((block) => /pkg=app\.smartring/.test(block) && /ic_stat_tracking|Prueba del CI/.test(block)) ?? notifications;
note(`acciones de la notificación: ${(record.match(/actions=\d+|\[\d\] "[^"]+"/g) ?? []).join(' ') || '(no se ven)'}`);
check(/Pausa/.test(record) && /Parar/.test(record), 'su notificación lleva los botones «Pausa» y «Parar»');
press('PAUSE');
await sleep(2500);
let xml = prefsXml();
check(/^pause:\d+$/.test(prefString(xml, 'actions')), `tocar «Pausa» anota la orden con su hora (${prefString(xml, 'actions') || 'cola vacía'})`);
check(prefLong(xml, 'pausedSinceMs') > 0, 'y el servicio pasa a «en pausa»');
const pausedRecord = tryShell('dumpsys notification --noredact');
check(/Reanudar/.test(pausedRecord) && /en pausa/.test(pausedRecord), 'y su notificación enseña «Reanudar» y «en pausa»');
check(serviceState().foreground, 'pausar no para el servicio: sigue en primer plano');
press('PAUSE'); // un segundo toque no cuenta dos veces
await sleep(1500);
check(prefString(prefsXml(), 'actions') === prefString(xml, 'actions'), 'pausar lo ya pausado no anota nada más');
press('RESUME');
await sleep(2500);
xml = prefsXml();
check(/^pause:\d+;resume:\d+$/.test(prefString(xml, 'actions')), `tocar «Reanudar» lo anota detrás de la pausa (${prefString(xml, 'actions')})`);
check(prefLong(xml, 'pausedSinceMs') === 0 && prefLong(xml, 'pausedTotalMs') > 0, 'y cierra la pausa sumando el tiempo pausado');
const resumedRecord = tryShell('dumpsys notification --noredact');
check(/Pausa/.test(resumedRecord) && !/en pausa/.test(resumedRecord), 'y su notificación vuelve a enseñar «Pausa»');

// 1c) Levantar de nuevo un servicio que el sistema paró con el entreno en marcha (ronda 52): la orden de arranque con `resume` NO toca la pausa ni las órdenes pendientes de la notificación.
press('PAUSE');
await sleep(2000);
const pausedBefore = prefLong(prefsXml(), 'pausedSinceMs');
const queueBefore = prefString(prefsXml(), 'actions');
check(pausedBefore > 0, 'para probar «resume»: el entreno está en pausa');
tryShell(
  `am start-foreground-service -n ${PKG}/.TrackingService -a app.smartring.tracking.START --es session ${SESSION} --el startedAtMs ${Date.now()} --es title SmartHealth --es text "Prueba del CI" --ez resume true`,
);
await sleep(2500);
xml = prefsXml();
check(prefLong(xml, 'pausedSinceMs') === pausedBefore, 'volver a levantar el servicio con «resume» conserva la pausa');
check(prefString(xml, 'actions') === queueBefore && queueBefore !== '', `y las órdenes pendientes de la notificación (${queueBefore})`);
check(serviceState().foreground, 'y el servicio sigue en primer plano');
press('RESUME');
await sleep(1500);

// 2) Con la pantalla encendida graba lo que da el GPS.
await drive(8);
const withScreenOn = track();
note(`${withScreenOn.length} posiciones con la pantalla encendida`);
check(withScreenOn.length >= 4, 'graba las posiciones con la pantalla encendida (fichero de la pista)');
check(withScreenOn.every((row, i) => i === 0 || (row.tsMs >= (withScreenOn[i - 1]?.tsMs ?? 0) && row.lat >= (withScreenOn[i - 1]?.lat ?? 0) - 1e-9)), 'en orden, con su hora y avanzando hacia el norte');

// 3) LA PANTALLA SE APAGA y la app queda oculta: antes, aquí se perdía el GPS.
tryShell('svc power stayon false');
tryShell('input keyevent KEYCODE_HOME');
await sleep(1500);
tryShell('input keyevent KEYCODE_SLEEP');
await sleep(2500);
const wakefulness = tryShell('dumpsys power | grep -m1 mWakefulness=').trim();
note(wakefulness);
check(/Asleep|Dozing/i.test(wakefulness), 'la pantalla está apagada');
const before = track().length;
await drive(10);
const after = track();
note(`${after.length - before} posiciones nuevas con la pantalla apagada`);
check(after.length - before >= 5, 'SIGUE grabando con la pantalla apagada y la app oculta');
check(serviceState().foreground, 'y el servicio sigue en primer plano');

// 4) Se enciende la pantalla otra vez y se para el servicio: lo grabado se conserva.
tryShell('input keyevent KEYCODE_WAKEUP');
tryShell('wm dismiss-keyguard');
tryShell(`am stopservice -n ${PKG}/.TrackingService`);
await sleep(2500);
state = serviceState();
check(!state.foreground, 'al pararlo deja de estar en primer plano');
const saved = track();
check(saved.length >= after.length, 'lo grabado sigue en el fichero tras parar el servicio');
const gaps = saved.slice(1).map((row, i) => (row.tsMs - (saved[i]?.tsMs ?? 0)) / 1000);
note(`huecos entre posiciones (s): máx ${Math.max(0, ...gaps).toFixed(1)}`);

// 4b) «Parar» en la notificación: el servicio deja de grabar en el acto, quita su notificación y deja anotada la parada con su hora para que la web guarde el entreno.
const stopStart = tryShell(
  `am start-foreground-service -n ${PKG}/.TrackingService -a app.smartring.tracking.START --es session ci-stop --el startedAtMs ${Date.now()} --es title SmartHealth --es text "Prueba de parar"`,
);
note(stopStart.trim());
await sleep(3000);
check(serviceState().foreground, 'para probar «Parar»: el servicio está en primer plano');
check(prefString(prefsXml(), 'actions') === '', 'un entreno nuevo empieza sin órdenes pendientes de otro');
press('STOP');
await sleep(3000);
check(!serviceState().foreground, 'tocar «Parar» detiene el servicio');
xml = prefsXml();
check(/^stop:\d+$/.test(prefString(xml, 'actions')), `y deja anotada la parada con su hora (${prefString(xml, 'actions') || 'cola vacía'})`);
check(/<boolean name="active" value="false"/.test(xml), 'y deja el entreno como no activo');
check(!/Prueba de parar/.test(tryShell('dumpsys notification --noredact')), 'y su notificación desaparece');

// 5) Un entreno SIN GPS (yoga, fuerza…) también mantiene vivo el proceso con el servicio, pero sin pedir ubicación: de tipo «dispositivo conectado»
// (el anillo) si la app tiene el permiso de Bluetooth, que se concede aquí como lo tendría una app que ya habló con el anillo.
tryShell(`pm grant ${PKG} android.permission.BLUETOOTH_CONNECT`);
tryShell(`run-as ${PKG} rm -f files/track-ci-keep.csv`);
const keep = tryShell(
  `am start-foreground-service -n ${PKG}/.TrackingService -a app.smartring.tracking.START --es session ci-keep --el startedAtMs ${Date.now()} --es title SmartHealth --es text "Prueba sin GPS" --ez gps false`,
);
note(keep.trim());
await sleep(3000);
state = serviceState();
check(state.foreground, 'sin GPS, el servicio también está en primer plano');
check(state.connectedDevice, 'y es de tipo «dispositivo conectado» (el anillo)');
check(!state.location, 'y no pide ubicación');
await drive(4);
const keepRows = (() => {
  try {
    return shell(`run-as ${PKG} cat files/track-ci-keep.csv`).split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0; // sin fichero: no grabó nada
  }
})();
check(keepRows === 0, `y no graba posiciones aunque el GPS dé (${keepRows} filas)`);
await sleep(1500);
tryShell(`am stopservice -n ${PKG}/.TrackingService`);
await sleep(2000);
check(!serviceState().foreground, 'se detiene al pararlo');

const crashes = tryShell('logcat -d -b crash').trim();
check(!/app\.smartring/.test(crashes), 'la app no se ha cerrado por un error');
// 6) Si muere el motor web (el «renderizador» del WebView) Android cierra la app entera: es el comportamiento de siempre y no se cambia. Lo único que hace la app (ronda 52) es dejar anotado, antes de que muera el
// proceso, cuándo pasó y si lo mató el sistema, para contarlo al abrirse de nuevo (el aviso de «entreno recuperado»). Se mata el renderizador y se mira lo anotado en las preferencias.
// Va después de la comprobación de cierres: la app SE cierra aquí, a propósito.
{
  shell(`am start -W -n ${PKG}/.MainActivity`);
  await sleep(6000);
  const rendererPids = tryShell('ps -A -o PID,NAME')
    .split('\n')
    .filter((line) => /sandboxed_process/.test(line) && line.includes(PKG))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  note(`procesos del motor web de la app: ${rendererPids.join(', ') || '(ninguno encontrado)'}`);
  if (rendererPids.length === 0) {
    note('(no se encontró el proceso del motor web: no se comprueba la anotación)');
  } else {
    for (const pid of rendererPids) tryShell(`kill -9 ${pid}`);
    await sleep(5000);
    const gone = prefsXml();
    check(prefLong(gone, 'renderGoneAtMs') > 0, `al morir el motor web queda anotado cuándo pasó (${prefLong(gone, 'renderGoneAtMs') || 'sin anotar'})`);
    check(/<boolean name="renderGoneCrashed" value="false"/.test(gone), 'y que lo mató el sistema, no que fallara por sí mismo');
  }
}

if (problems.length > 0) {
  console.log('\n--- registro de Android (servicio y ubicación) ---');
  const log = tryShell('logcat -d -t 3000');
  for (const line of log.split('\n').filter((l) => /TrackingService|smartring|ForegroundService|AndroidRuntime|LocationManager/i.test(l)).slice(-60)) note(line);
  console.log(`\n${problems.length} comprobación(es) fallida(s):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log('\nTodo bien: el servicio graba la ruta con la pantalla apagada.');
