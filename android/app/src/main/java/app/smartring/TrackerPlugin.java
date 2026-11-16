package app.smartring;

import android.Manifest;
import android.app.ActivityManager;
import android.app.AppOpsManager;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;

/**
 * El puente entre la web y {@link TrackingService}: arranca y para el servicio de un entreno (con ruta GPS o solo para mantenerlo vivo),
 * entrega las posiciones recogidas desde la última vez que se pidieron y deja pedir los permisos que hacen falta. También lleva el
 * {@link RingKeeper}: el reflejo nativo que mantiene medido el pulso del anillo cuando el WebView está parado.
 *
 * Las posiciones se piden con un número de secuencia («dame lo posterior a la N»): la web las recoge cuando vuelve a verse o cada
 * segundo si está a la vista, y no importa lo que haya tardado, porque cada una lleva su hora.
 */
@CapacitorPlugin(
    name = "Tracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class TrackerPlugin extends Plugin {

    /** Posiciones por respuesta si no se pide otra cosa (una hora a una por segundo cabe en dos respuestas). */
    private static final int DEFAULT_LIMIT = 2000;
    /** Las pistas que nadie recogió ni borró (la app se cerró a mitad de un entreno) se tiran pasados estos días. */
    private static final long STALE_TRACK_MS = 7L * 24L * 60L * 60L * 1000L;

    /** Cada cuánto avisa la grabación a la web mientras dura (ver {@link #tick}). */
    private static final long TICK_MS = 2000L;

    private final Handler ticker = new Handler(Looper.getMainLooper());

    /** El reflejo del pulso del entreno (ver {@link RingKeeper}) y el hilo desde el que escribe al anillo. */
    private RingKeeper keeper;
    private HandlerThread keeperThread;
    private Handler keeperHandler;
    /** El anillo con el que habla el reflejo: su dirección, el servicio y el canal de órdenes (los da la web al armarlo). */
    private volatile String ringId = "";
    private volatile String ringService = "";
    private volatile String ringCommandChannel = "";
    /** Los oyentes ya puestos en el plugin de Bluetooth (uno por canal): no se ponen dos veces. */
    private final Set<String> hooked = new HashSet<>();
    /** Cuándo vio este lado nativo caerse la conexión con el anillo durante el entreno (0: no se ha caído). La web lo lee para explicar un hueco de pulso con la pantalla apagada. */
    private volatile long ringDownAtMs = 0L;
    /** Número de cada aviso que este lado nativo manda a la web (1, 2, 3…): si la web recibe «10, 11, 40», se perdieron 28 por el camino (el WebView parado no los guardó); si recibe «10, 11, 12» con la hora saltando minutos, el que estuvo parado fue el móvil. */
    private long tickCount = 0L;

    /**
     * El pulso del entreno: con la pantalla apagada o la app oculta el WebView espacia sus temporizadores hasta un minuto, y lo que
     * dependía de uno (reabrir la medida de pulso del anillo, reintentar su conexión) tardaba lo mismo. Este aviso lo manda el proceso
     * nativo, que sigue vivo con el servicio en primer plano, y llega a la web como cualquier otro evento (no lo espacia nadie).
     */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!TrackingService.prefs(getContext()).getBoolean(TrackingService.KEY_ACTIVE, false)) {
                return; // ya no se graba: no se vuelve a programar
            }
            RingKeeper current = keeper;
            if (current != null) {
                current.tick();
            }
            if (hasListeners("tick")) {
                JSObject payload = new JSObject();
                // La hora de nativo y cómo va el reflejo: la web ve cuánto tarda en recibir el aviso (si el WebView estuvo parado) y cuánto hizo el reflejo.
                payload.put("now", System.currentTimeMillis());
                if (current != null) {
                    payload.put("seq", current.lastSeq());
                    payload.put("armed", current.isArmed());
                    payload.put("stalled", current.isStalled());
                    payload.put("stalls", current.stalls());
                    payload.put("writes", current.writes());
                    payload.put("failed", current.failedWrites());
                }
                // Cuántas órdenes de la notificación (pausa, reanudar, parar) esperan a que la web las recoja: si el timbre no llegó, este aviso se lo cuenta.
                payload.put("pending", WorkoutControl.count(TrackingService.prefs(getContext()).getString(TrackingService.KEY_ACTIONS, "")));
                payload.put("ringDownAt", ringDownAtMs);
                payload.put("n", ++tickCount);
                notifyListeners("tick", payload);
            }
            ticker.postDelayed(this, TICK_MS);
        }
    };

    @Override
    protected void handleOnDestroy() {
        TrackingService.setActionListener(null);
        ticker.removeCallbacks(tick);
        if (keeper != null) {
            keeper.disarm();
        }
        if (keeperThread != null) {
            keeperThread.quitSafely();
        }
        super.handleOnDestroy();
    }

    @Override
    public void load() {
        keeperThread = new HandlerThread("smartring-keeper");
        keeperThread.start();
        keeperHandler = new Handler(keeperThread.getLooper());
        keeper = new RingKeeper(System::currentTimeMillis, this::writeToRing, (task, delayMs) -> keeperHandler.postDelayed(task, delayMs));
        // Los botones de la notificación del entreno (pausa, reanudar, parar): el servicio avisa aquí en el acto.
        TrackingService.setActionListener(this::onNotificationAction);
        // Limpieza de pistas viejas: sin esto, un entreno cuyo borrador se perdió dejaría su fichero para siempre.
        TrackLog.deleteOlderThan(getContext().getFilesDir(), STALE_TRACK_MS, System.currentTimeMillis());
        watchRenderProcess();
    }

    /**
     * Si el motor web (el «renderizador» del WebView) muere —casi siempre porque el sistema lo mata por falta de memoria—, Android CIERRA LA APP ENTERA (el servicio del GPS y la conexión con el anillo
     * incluidos) salvo que la app lo atienda. Aquí NO se atiende (el comportamiento de siempre): solo se deja anotado, a la fuerza y antes de que muera el proceso, cuándo pasó y si fue un fallo del propio
     * motor o lo mató el sistema. La web lo cuenta al abrirse de nuevo, para saber si el fallo de un entreno con la pantalla apagada fue ese.
     */
    private void watchRenderProcess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getBridge() == null) {
            return;
        }
        try {
            getBridge().addWebViewListener(
                new WebViewListener() {
                    @Override
                    public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                        try {
                            TrackingService.prefs(getContext())
                                .edit()
                                .putLong(TrackingService.KEY_RENDER_GONE_AT, System.currentTimeMillis())
                                .putBoolean(TrackingService.KEY_RENDER_GONE_CRASHED, detail != null && detail.didCrash())
                                .commit();
                        } catch (RuntimeException e) {
                            // sin anotarlo: la app se cierra igual
                        }
                        return false;
                    }
                }
            );
        } catch (RuntimeException e) {
            // sin esta anotación todo funciona igual
        }
    }

    /**
     * Pide de una vez los permisos de la grabación: la ubicación (precisa junto con la aproximada, por lo mismo que en Bluetooth) y,
     * desde Android 13, los avisos (sin ellos el servicio graba igual, pero Android no enseña su aviso fijo en la barra). Si ya están
     * concedidos no vuelve a preguntar. Devuelve cómo quedan.
     */
    @PluginMethod
    public void askPermissions(PluginCall call) {
        // Sin GPS (`gps: false`) solo se piden los avisos: la ubicación no hace falta para mantener vivo un entreno.
        boolean gps = call.getBoolean("gps", true);
        String[] aliases;
        if (Build.VERSION.SDK_INT >= 33) {
            aliases = gps ? new String[] { "location", "notifications" } : new String[] { "notifications" };
        } else if (gps) {
            aliases = new String[] { "location" };
        } else {
            call.resolve(permissions());
            return;
        }
        requestPermissionForAliases(aliases, call, "permissionsResult");
    }

    @PermissionCallback
    private void permissionsResult(PluginCall call) {
        call.resolve(permissions());
    }

    /** Cómo están ahora los permisos, sin preguntar nada. */
    @PluginMethod
    public void permissionState(PluginCall call) {
        call.resolve(permissions());
    }

    private JSObject permissions() {
        JSObject out = new JSObject();
        out.put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        out.put("notifications", Build.VERSION.SDK_INT < 33 || granted("android.permission.POST_NOTIFICATIONS"));
        return out;
    }

    private boolean granted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Empieza el servicio del entreno {@code sessionId}: graba su ruta GPS (o, con {@code gps: false}, solo lo mantiene vivo con su aviso fijo).
     * Debe llamarse con la app a la vista.
     */
    @PluginMethod
    public void start(PluginCall call) {
        JSObject data = call.getData();
        String sessionId = data.optString("sessionId", "");
        if (sessionId.isEmpty()) {
            call.reject("Falta el identificador del entrenamiento.");
            return;
        }
        boolean gps = data.optBoolean("gps", true);
        // `resume`: el sistema paró el servicio con el entreno en marcha y la web lo vuelve a levantar; no se toca la pausa ni las órdenes de la notificación.
        boolean resume = data.optBoolean("resume", false);
        if (gps && !granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("Sin permiso de ubicación.", "PERMISSION");
            return;
        }
        Context context = getContext();
        // El estado se deja escrito AHORA (y sin el error de un entreno anterior): el servicio lo escribe también al arrancar, pero es
        // asíncrono, y la respuesta de abajo se lee antes de que lo haga.
        SharedPreferences.Editor editor = TrackingService.prefs(context)
            .edit()
            .putBoolean(TrackingService.KEY_ACTIVE, true)
            .putString(TrackingService.KEY_SESSION, sessionId)
            .putLong(TrackingService.KEY_STARTED, data.optLong("startedAtMs", System.currentTimeMillis()))
            .putString(TrackingService.KEY_TITLE, data.optString("title", ""))
            .putString(TrackingService.KEY_TEXT, data.optString("text", ""))
            .putBoolean(TrackingService.KEY_GPS, gps);
        if (!resume) {
            // Un entreno nuevo empieza sin pausas y sin órdenes de la notificación pendientes de otro, ni la muerte del motor web de uno anterior.
            editor
                .putLong(TrackingService.KEY_PAUSED_SINCE, 0L)
                .putLong(TrackingService.KEY_PAUSED_TOTAL, 0L)
                .remove(TrackingService.KEY_ACTIONS)
                .remove(TrackingService.KEY_RENDER_GONE_AT)
                .remove(TrackingService.KEY_RENDER_GONE_CRASHED);
            ringDownAtMs = 0L;
            tickCount = 0L;
        }
        editor.remove(TrackingService.KEY_ERROR).commit();
        try {
            Intent intent = new Intent(context, TrackingService.class)
                .setAction(TrackingService.ACTION_START)
                .putExtra(TrackingService.EXTRA_SESSION, sessionId)
                .putExtra(TrackingService.EXTRA_STARTED, data.optLong("startedAtMs", System.currentTimeMillis()))
                .putExtra(TrackingService.EXTRA_TITLE, data.optString("title", ""))
                .putExtra(TrackingService.EXTRA_TEXT, data.optString("text", ""))
                .putExtra(TrackingService.EXTRA_GPS, gps)
                .putExtra(TrackingService.EXTRA_RESUME, resume);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            ticker.removeCallbacks(tick);
            ticker.postDelayed(tick, TICK_MS);
            keepRendererAlive(true);
            call.resolve(state(sessionId));
        } catch (RuntimeException e) {
            call.reject("No se pudo arrancar la grabación de la ruta: " + e.getMessage(), e);
        }
    }

    /**
     * Las posiciones posteriores a {@code sinceSeq}, hasta {@code limit}. Cada una es
     * {@code [seq, hora (ms), latitud, longitud, precisión (m), velocidad (m/s) o null, altitud (m) o null, precisión vertical (m) o null,
     * presión (hPa) o null]}.
     */
    @PluginMethod
    public void fixes(PluginCall call) {
        JSObject data = call.getData();
        String sessionId = data.optString("sessionId", "");
        if (sessionId.isEmpty()) {
            sessionId = currentSession();
        }
        if (sessionId == null) {
            call.resolve(emptyState());
            return;
        }
        long since = Math.max(0L, data.optLong("sinceSeq", 0L));
        int limit = Math.max(1, Math.min(10_000, data.optInt("limit", DEFAULT_LIMIT)));
        TrackLog log = TrackLog.open(getContext().getFilesDir(), sessionId);
        try {
            JSArray rows = new JSArray();
            List<TrackLog.Fix> fixes = log.since(since, limit);
            for (TrackLog.Fix fix : fixes) {
                JSArray row = new JSArray();
                row.put(fix.seq);
                row.put(fix.tsMs);
                row.put(fix.lat);
                row.put(fix.lon);
                row.put(number(fix.accuracyM));
                row.put(number(fix.speedMs));
                row.put(number(fix.altM));
                row.put(number(fix.vAccM));
                row.put(number(fix.pressureHpa));
                rows.put(row);
            }
            JSObject out = state(sessionId);
            out.put("fixes", rows);
            call.resolve(out);
        } catch (JSONException e) {
            call.reject("No se pudieron leer las posiciones: " + e.getMessage(), e);
        }
    }

    /** NaN no cabe en JSON: lo que el móvil no dio va como null. */
    private static Object number(double value) {
        return Double.isNaN(value) || Double.isInfinite(value) ? org.json.JSONObject.NULL : (Object) Double.valueOf(value);
    }

    /**
     * Las órdenes que se tocaron en los botones de la notificación del entreno desde la última vez, en orden y con la hora de cada una ({@code {actions: [{action, atMs}]}}); la cola queda vacía.
     * La web las pide cuando suena el aviso {@code action}, con cada aviso {@code tick} que dice que hay alguna, al volver a verse la app y al arrancar (si la app estaba cerrada).
     */
    @PluginMethod
    public void takeActions(PluginCall call) {
        String queue = TrackingService.takeQueue(TrackingService.prefs(getContext()));
        JSArray actions = new JSArray();
        for (WorkoutControl.Entry entry : WorkoutControl.parse(queue)) {
            JSObject item = new JSObject();
            item.put("action", entry.action);
            item.put("atMs", entry.atMs);
            actions.put(item);
        }
        JSObject out = new JSObject();
        out.put("actions", actions);
        call.resolve(out);
    }

    /**
     * La web cuenta que el entreno se pausó o se reanudó desde la app: la notificación enseña «Reanudar» o «Pausa» y su cronómetro se para o sigue. Si ya estaba así (porque la pausa se tocó en la
     * propia notificación) no cambia nada.
     */
    @PluginMethod
    public void setPaused(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = TrackingService.prefs(context);
        JSObject data = call.getData();
        boolean paused = data.optBoolean("paused", false);
        long atMs = data.optLong("atMs", System.currentTimeMillis());
        if (prefs.getBoolean(TrackingService.KEY_ACTIVE, false) && TrackingService.applyPause(prefs, paused, atMs) && TrackingService.isRunning()) {
            TrackingService.refreshNotification(context);
        }
        call.resolve();
    }

    /**
     * Se tocó un botón de la notificación (lo avisa el servicio en el acto). Parar deja al reflejo del pulso sin nada que atender; a la web se le avisa con un «timbre»: lo que se tocó lo recoge después
     * con {@link #takeActions}, así que no importa que el aviso llegue tarde (WebView parado) ni que llegue dos veces.
     */
    private void onNotificationAction(String order, long atMs) {
        if (WorkoutControl.STOP.equals(order)) {
            ticker.removeCallbacks(tick);
            if (keeper != null) {
                keeper.disarm();
            }
        }
        if (hasListeners("action")) {
            JSObject payload = new JSObject();
            payload.put("action", order);
            payload.put("atMs", atMs);
            notifyListeners("action", payload);
        }
    }

    /** Deja de grabar (la pista se conserva hasta que se borre con {@code clear}). */
    @PluginMethod
    public void stop(PluginCall call) {
        ticker.removeCallbacks(tick);
        if (keeper != null) {
            keeper.disarm();
        }
        keepRendererAlive(false);
        Context context = getContext();
        TrackingService.prefs(context).edit().putBoolean(TrackingService.KEY_ACTIVE, false).apply();
        context.stopService(new Intent(context, TrackingService.class));
        call.resolve(state(currentSession()));
    }

    /** Borra la pista de un entreno (y la deja si es la que se está grabando: antes hay que parar). */
    @PluginMethod
    public void clear(PluginCall call) {
        String sessionId = call.getData().optString("sessionId", "");
        if (!sessionId.isEmpty()) {
            boolean recording = TrackingService.prefs(getContext()).getBoolean(TrackingService.KEY_ACTIVE, false) && sessionId.equals(currentSession());
            if (!recording) {
                TrackLog.delete(getContext().getFilesDir(), sessionId);
            }
        }
        call.resolve();
    }

    /** Qué está pasando ahora: si se graba, qué entreno, cuántas posiciones lleva, si el GPS está encendido… */
    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state(currentSession()));
    }

    /**
     * Pide a Android que no restrinja la app en segundo plano (el ahorro de batería de algunos fabricantes cierra los servicios).
     * Abre el cuadro del sistema una sola vez por llamada; no devuelve la respuesta (se vuelve a mirar con {@code status}).
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context context = getContext();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !batteryExempt()) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.getPackageName()));
                getActivity().startActivity(intent);
            }
            call.resolve(state(currentSession()));
        } catch (RuntimeException e) {
            // Sin pantalla de ajustes que lo atienda: no es un fallo de la grabación.
            call.resolve(state(currentSession()));
        }
    }

    private boolean batteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /**
     * Mientras dura un entreno, el proceso del WebView (el «renderizador» de Chromium) conserva la prioridad de la app aunque no se vea. Por
     * omisión, con la pantalla apagada o la app oculta Android lo trata como un proceso cualquiera de segundo plano y algunos móviles
     * (Xiaomi, Huawei, Oppo…) lo congelan o lo atienden con segundos de retraso aunque la app tenga su servicio en primer plano: el pulso
     * del anillo, que se lee en la web, se quedaba sin leer y al volver a verla llegaba todo de golpe.
     */
    private void keepRendererAlive(boolean keep) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getActivity() == null) {
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                WebView view = getBridge().getWebView();
                if (view != null) {
                    view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !keep);
                }
            } catch (RuntimeException e) {
                // sin esto la app funciona igual
            }
        });
    }

    // ───────────────────────────── el reflejo del pulso ─────────────────────────────

    /** El plugin de Bluetooth (otro plugin de Capacitor, que corre en este mismo proceso), o {@code null} si no está cargado. */
    private PluginHandle bluetooth() {
        return getBridge() == null ? null : getBridge().getPlugin("BluetoothLe");
    }

    /** La clave con la que el plugin de Bluetooth reparte los avisos de una característica (sus UUID, en minúsculas). */
    private static String notificationKey(String deviceId, String service, String characteristic) {
        return "notification|" + deviceId + "|" + UUID.fromString(service) + "|" + UUID.fromString(characteristic);
    }

    /**
     * Se pone a oír los avisos del anillo en el plugin de Bluetooth, como un oyente más pero nativo. Hay que llamarlo ANTES de que la web se
     * suscriba a los mismos avisos: los oyentes reciben el mismo objeto, por orden, y este le añade el número de orden y la hora de recepción
     * de cada aviso (la web, aunque lo procese tarde, sabrá cuándo llegó) y atiende al anillo si la web está parada. Si algo falla no pasa nada:
     * la web sigue recibiendo los avisos de siempre, sin esos datos.
     */
    @PluginMethod
    public void ringPrepare(PluginCall call) {
        PluginHandle handle = bluetooth();
        String deviceId = call.getString("deviceId", "");
        String service = call.getString("service", "");
        JSArray channels = call.getArray("characteristics");
        if (handle == null || keeper == null || deviceId.isEmpty() || service.isEmpty() || channels == null) {
            call.resolve(ringState(false));
            return;
        }
        boolean ok = true;
        try {
            for (int i = 0; i < channels.length(); i++) {
                ok &= hook(handle, notificationKey(deviceId, service, channels.getString(i)), this::onRingNotification);
            }
            ok &= hook(
                handle,
                "disconnected|" + deviceId,
                data -> {
                    ringDownAtMs = System.currentTimeMillis();
                    keeper.disarm();
                }
            );
        } catch (JSONException | IllegalArgumentException e) {
            ok = false;
        }
        call.resolve(ringState(ok));
    }

    /** Añade un oyente nativo a un evento del plugin de Bluetooth (una sola vez por evento). */
    private boolean hook(PluginHandle handle, String eventName, NativeCall.Listener listener) {
        synchronized (hooked) {
            if (hooked.contains(eventName)) {
                return true;
            }
            try {
                JSObject data = new JSObject();
                data.put("eventName", eventName);
                handle.invoke("addListener", new NativeCall("BluetoothLe", "addListener", data, listener));
                hooked.add(eventName);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    /** Un aviso del anillo: se numera, se le pone la hora y, si la web está parada, se atiende. Los datos que se añaden los verá la web. */
    private void onRingNotification(JSObject data) {
        RingKeeper current = keeper;
        if (current == null || data == null) {
            return;
        }
        byte[] bytes = RingKeeper.fromHex(data.optString("value", ""));
        if (bytes == null) {
            return;
        }
        RingKeeper.Meta meta = current.onNotification(bytes);
        try {
            data.put("seq", meta.seq);
            data.put("at", meta.atMs);
            data.put("restartAt", meta.restartAtMs);
            data.put("reflexed", meta.reflexed);
        } catch (RuntimeException e) {
            // sin esos datos la web hace lo de siempre
        }
    }

    /**
     * Arma el reflejo para el entreno: de ahora en adelante, si la web deja de contestar a los avisos nativos, él confirma los avisos del
     * anillo y le vuelve a pedir el pulso con {@code startHr} (la misma trama que mandaría la web).
     */
    @PluginMethod
    public void ringArm(PluginCall call) {
        byte[] start = RingKeeper.fromHex(call.getString("startHr", ""));
        String deviceId = call.getString("deviceId", "");
        String service = call.getString("service", "");
        String command = call.getString("command", "");
        if (keeper == null || start == null || start.length == 0 || deviceId.isEmpty() || service.isEmpty() || command.isEmpty()) {
            call.reject("Faltan datos para armar el reflejo del pulso.");
            return;
        }
        ringId = deviceId;
        ringService = service;
        ringCommandChannel = command;
        ringWithResponse = call.getBoolean("withResponse", true);
        keeper.arm(start);
        call.resolve(ringState(true));
    }

    @PluginMethod
    public void ringDisarm(PluginCall call) {
        if (keeper != null) {
            keeper.disarm();
        }
        call.resolve(ringState(true));
    }

    /** La web contesta a un aviso nativo: está viva. */
    @PluginMethod
    public void ack(PluginCall call) {
        if (keeper != null) {
            keeper.ack();
        }
        call.resolve();
    }

    /** Si la escritura al anillo debe ser con respuesta (como la hace la web) o sin ella. */
    private volatile boolean ringWithResponse = true;

    /** Escribe una trama al canal de órdenes del anillo por el plugin de Bluetooth. Devuelve {@code false} si no pudo ni empezar. */
    private boolean writeToRing(byte[] frame) {
        PluginHandle handle = bluetooth();
        String deviceId = ringId;
        if (handle == null || deviceId.isEmpty()) {
            return false;
        }
        String method = ringWithResponse ? "write" : "writeWithoutResponse";
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("service", ringService);
        data.put("characteristic", ringCommandChannel);
        data.put("value", RingKeeper.toHex(frame));
        data.put("timeout", 3000);
        NativeCall call = new NativeCall("BluetoothLe", method, data, null);
        try {
            handle.invoke(method, call);
        } catch (Exception e) {
            return false;
        }
        return call.error() == null;
    }

    private JSObject ringState(boolean ok) {
        JSObject out = new JSObject();
        out.put("ok", ok);
        out.put("armed", keeper != null && keeper.isArmed());
        return out;
    }

    private String currentSession() {
        return TrackingService.prefs(getContext()).getString(TrackingService.KEY_SESSION, null);
    }

    private JSObject emptyState() {
        JSObject out = state(null);
        out.put("fixes", new JSArray());
        return out;
    }

    private JSObject state(String sessionId) {
        Context context = getContext();
        SharedPreferences prefs = TrackingService.prefs(context);
        JSObject out = new JSObject();
        out.put("running", TrackingService.isRunning());
        out.put("active", prefs.getBoolean(TrackingService.KEY_ACTIVE, false));
        out.put("sessionId", sessionId == null ? org.json.JSONObject.NULL : sessionId);
        out.put("startedAtMs", prefs.getLong(TrackingService.KEY_STARTED, 0L));
        long lastSeq = 0L;
        long lastTsMs = 0L;
        if (sessionId != null) {
            File dir = context.getFilesDir();
            TrackLog log = TrackLog.open(dir, sessionId);
            lastSeq = log.lastSeq();
            lastTsMs = log.lastTsMs();
        }
        out.put("lastSeq", lastSeq);
        out.put("lastTsMs", lastTsMs);
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        boolean gpsOn = false;
        try {
            gpsOn = manager != null && manager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (RuntimeException e) {
            // sin proveedor: se queda en falso
        }
        out.put("gpsEnabled", gpsOn);
        out.put("batteryExempt", batteryExempt());
        out.put("error", prefs.getString(TrackingService.KEY_ERROR, null));
        putPhoneState(out);
        long renderGoneAt = prefs.getLong(TrackingService.KEY_RENDER_GONE_AT, 0L);
        if (renderGoneAt > 0L) {
            out.put("renderGoneAt", renderGoneAt);
            out.put("renderGoneCrashed", prefs.getBoolean(TrackingService.KEY_RENDER_GONE_CRASHED, false));
        }
        return out;
    }

    /**
     * Cómo está el móvil, para explicar por qué se interrumpió una grabación con la pantalla apagada: el ahorro de batería de Android, el reposo
     * profundo, las restricciones de segundo plano, el cubo de uso y si el permiso de ubicación es «Permitir siempre». Lo que el móvil no sepa
     * contestar queda sin poner; nada de esto puede tumbar la grabación.
     */
    private void putPhoneState(JSObject out) {
        Context context = getContext();
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                out.put("powerSave", power.isPowerSaveMode());
                out.put("idle", power.isDeviceIdleMode());
            }
        } catch (RuntimeException e) {
            // sin ese dato
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ActivityManager activities = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                if (activities != null) {
                    out.put("bgRestricted", activities.isBackgroundRestricted());
                }
                UsageStatsManager usage = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
                if (usage != null) {
                    out.put("bucket", usage.getAppStandbyBucket());
                }
            }
        } catch (RuntimeException e) {
            // sin ese dato
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                out.put("bgLocation", granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
            }
        } catch (RuntimeException e) {
            // sin ese dato
        }
        try {
            // En Xiaomi/Redmi/Poco el «Inicio automático» es un permiso aparte (la operación 10008 de MIUI/HyperOS) y viene apagado de serie en las apps instaladas fuera de la tienda: sin él, el sistema
            // cierra el proceso al apagarse la pantalla aunque tenga su servicio en primer plano. No hay API pública para leerlo; se pregunta por reflexión y, si el móvil no lo permite, queda sin poner.
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT);
            if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
                AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
                if (ops != null) {
                    java.lang.reflect.Method check = AppOpsManager.class.getMethod("checkOpNoThrow", int.class, int.class, String.class);
                    Object mode = check.invoke(ops, 10008, android.os.Process.myUid(), context.getPackageName());
                    if (mode instanceof Integer) {
                        out.put("autostart", ((Integer) mode).intValue() == AppOpsManager.MODE_ALLOWED);
                    }
                }
            }
        } catch (Exception e) {
            // sin ese dato
        }
    }
}
