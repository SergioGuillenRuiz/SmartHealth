package app.smartring;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

/**
 * Mantiene vivo un entreno AUNQUE la pantalla esté apagada o la app oculta, y graba su ruta si lleva GPS.
 *
 * La web (el WebView) no recibe el GPS cuando la app no se ve, y Android congela o cierra las apps sin nada en primer plano. Este
 * servicio de ubicación en primer plano (con su aviso fijo en la barra de notificaciones, que Android exige) mantiene el proceso
 * vivo y recoge cada posición del GPS en una {@link TrackLog}; la web la pide cuando puede, con la hora real de cada posición.
 *
 * Sin GPS (yoga, fuerza…) el servicio no pide ubicación: solo mantiene vivo el proceso con su aviso fijo y la CPU despierta, que es lo que
 * necesita el anillo (que habla por Bluetooth con la app) para seguir midiendo el pulso con la pantalla apagada.
 *
 * El estado (qué entreno, desde cuándo) se guarda en las preferencias: si el sistema reinicia el servicio tras cerrarlo, sigue donde
 * estaba. Lo arranca y lo para la web a través de {@link TrackerPlugin}, siempre con la app a la vista (Android no deja pasar a
 * primer plano un servicio de ubicación desde el fondo).
 */
public class TrackingService extends Service implements LocationListener {

    static final String ACTION_START = "app.smartring.tracking.START";
    /** Los botones de la notificación: pausar, reanudar y parar (y guardar) el entreno con un solo toque. */
    static final String ACTION_PAUSE = "app.smartring.tracking.PAUSE";
    static final String ACTION_RESUME = "app.smartring.tracking.RESUME";
    static final String ACTION_STOP = "app.smartring.tracking.STOP";
    static final String EXTRA_SESSION = "session";
    static final String EXTRA_STARTED = "startedAtMs";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_GPS = "gps";
    /** Volver a levantar un servicio que el sistema paró con el entreno en marcha: no se toca la pausa ni las órdenes pendientes de la notificación. */
    static final String EXTRA_RESUME = "resume";

    private static final String PREFS = "smartring_tracker";
    static final String KEY_ACTIVE = "active";
    static final String KEY_SESSION = "session";
    static final String KEY_STARTED = "startedAtMs";
    static final String KEY_TITLE = "title";
    static final String KEY_TEXT = "text";
    /** El entreno graba ruta (pide la ubicación) o solo se mantiene vivo (sin GPS). */
    static final String KEY_GPS = "gps";
    static final String KEY_ERROR = "error";
    /** Desde cuándo está en pausa el entreno (ms; 0 = no lo está) y cuánto tiempo suman ya sus pausas: lo usa el cronómetro de la notificación. */
    static final String KEY_PAUSED_SINCE = "pausedSinceMs";
    static final String KEY_PAUSED_TOTAL = "pausedTotalMs";
    /** Las órdenes tocadas en la notificación que la web aún no ha recogido (ver {@link WorkoutControl}). */
    static final String KEY_ACTIONS = "actions";
    /** Cuándo murió el motor web (el «renderizador» del WebView) y si fue por un fallo suyo o lo mató el sistema (falta de memoria): Android cierra la app entera cuando pasa; la web lo cuenta al abrirse de nuevo. */
    static final String KEY_RENDER_GONE_AT = "renderGoneAtMs";
    static final String KEY_RENDER_GONE_CRASHED = "renderGoneCrashed";
    /** Protege la cola de órdenes y la cuenta de la pausa: las escribe el servicio (hilo principal) y las lee y borra el plugin (otro hilo). */
    private static final Object CONTROL_LOCK = new Object();

    private static final String CHANNEL_ID = "smartring_tracking";
    private static final int NOTIFICATION_ID = 4217;
    /** Tope del bloqueo de CPU: un olvido no deja el móvil despierto más que un día de entreno largo. */
    private static final long WAKE_LOCK_MS = 12L * 60L * 60L * 1000L;
    /** Una posición por segundo, sin distancia mínima: la velocidad del GPS (efecto Doppler) se integra con todas. */
    private static final long LOCATION_EVERY_MS = 1000L;
    /**
     * Topes para que un servicio al que ya no atiende nadie (la app se cerró a mitad de un entreno y no se volvió a abrir) no grabe
     * para siempre con el GPS encendido: se detiene a las 12 h, o tras 3 h sin moverse.
     */
    private static final long MAX_SESSION_MS = 12L * 60L * 60L * 1000L;
    private static final long MAX_STILL_MS = 3L * 60L * 60L * 1000L;
    /** Por encima de esta velocidad (m/s) se está en movimiento. */
    private static final float MOVING_SPEED_MS = 1.0f;
    /** Cada cuánto se miran los topes aunque el GPS no dé posiciones (en casa, en un túnel): sin esto un servicio sin fix no pararía nunca. */
    private static final long WATCHDOG_EVERY_MS = 60_000L;

    /** El servicio está vivo en este proceso. */
    private static volatile boolean running = false;

    /** Quien se entera en el acto de lo que se toca en la notificación (el plugin, que avisa a la web). Si no hay nadie, las órdenes quedan anotadas en la cola. */
    interface ActionListener {
        void onAction(String order, long atMs);
    }

    private static volatile ActionListener actionListener;

    static void setActionListener(ActionListener listener) {
        actionListener = listener;
    }

    private LocationManager locations;
    private HandlerThread thread;
    private PowerManager.WakeLock wakeLock;
    /** La leen el hilo del GPS y el principal (al cambiar de entreno). */
    private volatile TrackLog log;
    private String logSession;
    private boolean updating = false;
    private long lastMovementMs = 0L;
    private Location lastLocation;
    /** La última presión del barómetro (hPa) y cuándo se midió (reloj monótono): sirve para el desnivel de un paseo. Una lectura vieja no vale. */
    private volatile float lastPressureHpa = Float.NaN;
    private volatile long lastPressureAtMs = 0L;
    private SensorManager sensors;
    private final SensorEventListener barometerListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event.values.length > 0) {
                lastPressureHpa = event.values[0];
                lastPressureAtMs = SystemClock.elapsedRealtime();
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };
    private Handler handler;
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            if (!updating) {
                return;
            }
            if (capsExceeded(prefs(TrackingService.this), System.currentTimeMillis())) {
                return;
            }
            if (handler != null) {
                handler.postDelayed(this, WATCHDOG_EVERY_MS);
            }
        }
    };

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isRunning() {
        return running;
    }

    /**
     * Pausa o reanuda el entreno (para la notificación) a la hora {@code atMs}. Devuelve {@code true} si cambió algo: pausar lo ya pausado o reanudar lo que no lo está no hace nada, de modo que la
     * orden de la notificación y el aviso de la web (que llegan los dos) no cuentan dos veces.
     */
    static boolean applyPause(SharedPreferences prefs, boolean paused, long atMs) {
        synchronized (CONTROL_LOCK) {
            WorkoutControl.PauseState next = WorkoutControl.applyPause(prefs.getLong(KEY_PAUSED_SINCE, 0L), prefs.getLong(KEY_PAUSED_TOTAL, 0L), paused, atMs);
            if (next.changed) {
                prefs.edit().putLong(KEY_PAUSED_SINCE, next.since).putLong(KEY_PAUSED_TOTAL, next.total).apply();
            }
            return next.changed;
        }
    }

    /** Anota una orden de la notificación para que la web la recoja (con `commit`: no se pierde aunque el proceso muera justo después). */
    static void queueAction(SharedPreferences prefs, String order, long atMs) {
        synchronized (CONTROL_LOCK) {
            prefs.edit().putString(KEY_ACTIONS, WorkoutControl.append(prefs.getString(KEY_ACTIONS, ""), order, atMs)).commit();
        }
    }

    /** Las órdenes esperando, en orden; la cola queda vacía. */
    static String takeQueue(SharedPreferences prefs) {
        synchronized (CONTROL_LOCK) {
            String queue = prefs.getString(KEY_ACTIONS, "");
            if (queue != null && !queue.isEmpty()) {
                prefs.edit().remove(KEY_ACTIONS).commit();
            }
            return queue == null ? "" : queue;
        }
    }

    /** Vuelve a pintar la notificación con el estado de ahora (el botón «Pausa» o «Reanudar» y su cronómetro). */
    static void refreshNotification(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        manager.notify(NOTIFICATION_ID, buildNotification(context, prefs(context)));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = prefs(this);
        String intentAction = intent == null ? null : intent.getAction();
        if (ACTION_PAUSE.equals(intentAction) || ACTION_RESUME.equals(intentAction) || ACTION_STOP.equals(intentAction)) {
            return handleControl(prefs, intentAction);
        }
        if (ACTION_START.equals(intentAction)) {
            SharedPreferences.Editor editor = prefs
                .edit()
                .putBoolean(KEY_ACTIVE, true)
                .putString(KEY_SESSION, intent.getStringExtra(EXTRA_SESSION))
                .putLong(KEY_STARTED, intent.getLongExtra(EXTRA_STARTED, System.currentTimeMillis()))
                .putString(KEY_TITLE, intent.getStringExtra(EXTRA_TITLE))
                .putString(KEY_TEXT, intent.getStringExtra(EXTRA_TEXT))
                .putBoolean(KEY_GPS, intent.getBooleanExtra(EXTRA_GPS, true));
            if (!intent.getBooleanExtra(EXTRA_RESUME, false)) {
                // Un entreno nuevo empieza sin pausas ni órdenes de otro; al reanudar uno parado por el sistema se conservan.
                editor.putLong(KEY_PAUSED_SINCE, 0L).putLong(KEY_PAUSED_TOTAL, 0L).remove(KEY_ACTIONS);
            }
            editor.remove(KEY_ERROR).apply();
        }
        String session = prefs.getString(KEY_SESSION, null);
        if (!prefs.getBoolean(KEY_ACTIVE, false) || session == null || session.isEmpty()) {
            // El sistema reinició el servicio (o llegó una orden suelta) sin nada en marcha: no hay a qué volver.
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            startInForeground(prefs);
        } catch (RuntimeException e) {
            fail(prefs, "No se pudo mantener el GPS en segundo plano: " + e.getMessage());
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        beginUpdates(prefs, session);
        // Si Android cierra el proceso por falta de memoria, vuelve a arrancar el servicio y la grabación sigue.
        return START_STICKY;
    }

    /**
     * Un botón de la notificación: pausar, reanudar o parar. Se anota la orden con la hora a la que se tocó y se avisa a quien escucha (la web); parar, además, deja de grabar en el acto y quita la
     * notificación (la web guarda el entreno al enterarse, o al abrirse si estaba cerrada). Pausar o reanudar solo cambia lo que enseña la notificación: el pulso y el GPS siguen.
     */
    private int handleControl(SharedPreferences prefs, String intentAction) {
        if (!prefs.getBoolean(KEY_ACTIVE, false)) {
            // Un botón de una notificación que ya no es de ningún entreno.
            stopSelf();
            return START_NOT_STICKY;
        }
        long at = System.currentTimeMillis();
        boolean stop = ACTION_STOP.equals(intentAction);
        String order = stop ? WorkoutControl.STOP : ACTION_PAUSE.equals(intentAction) ? WorkoutControl.PAUSE : WorkoutControl.RESUME;
        if (stop) {
            queueAction(prefs, order, at);
            prefs.edit().putBoolean(KEY_ACTIVE, false).apply();
        } else {
            if (!applyPause(prefs, WorkoutControl.PAUSE.equals(order), at)) {
                refreshNotification(this); // ya estaba así: solo se repinta
                return START_STICKY;
            }
            queueAction(prefs, order, at);
            refreshNotification(this);
        }
        ActionListener listener = actionListener;
        if (listener != null) {
            listener.onAction(order, at);
        }
        if (stop) {
            stopUpdates();
            releaseWakeLock();
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private void startInForeground(SharedPreferences prefs) {
        createChannel(this);
        Notification notification = buildNotification(this, prefs);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, foregroundType(prefs.getBoolean(KEY_GPS, true)));
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /**
     * El tipo del servicio en primer plano: ubicación si graba ruta, y «dispositivo conectado» (el anillo, por Bluetooth) si la app tiene el
     * permiso de Bluetooth concedido (Android 14 lo exige para declararlo). Sin GPS y sin ese permiso no hay tipo válido y arrancar falla
     * (queda dicho en el estado), pero entonces tampoco hay anillo conectado que mantener.
     */
    private int foregroundType(boolean gps) {
        int type = 0;
        if (gps) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        if (bluetoothGranted()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        }
        return type;
    }

    private boolean bluetoothGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true; // antes de Android 12 el permiso de Bluetooth no se pide en ejecución
        }
        return checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Entrenamiento en curso", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Aviso fijo mientras la app graba la ruta de un entrenamiento.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /** Una acción de la notificación: un botón que manda su orden al servicio. */
    private static Notification.Action action(Context context, String label, String intentAction, int requestCode) {
        Intent intent = new Intent(context, TrackingService.class).setAction(intentAction);
        PendingIntent pending = PendingIntent.getService(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_stat_tracking), label, pending).build();
    }

    /**
     * La notificación fija del entreno: su título y su texto, el cronómetro del tiempo activo (se para en pausa) y dos botones, «Pausa»/«Reanudar» y «Parar», que actúan con un solo toque sin abrir
     * la app. Es estática para que quien cambie el estado (el plugin, cuando se pausa desde la app) pueda volver a pintarla sin pasar por el servicio.
     */
    static Notification buildNotification(Context context, SharedPreferences prefs) {
        String title = prefs.getString(KEY_TITLE, null);
        String text = prefs.getString(KEY_TEXT, null);
        long startedAt = prefs.getLong(KEY_STARTED, System.currentTimeMillis());
        boolean paused = prefs.getLong(KEY_PAUSED_SINCE, 0L) > 0L;
        String base = text == null || text.isEmpty() ? "Entrenamiento en curso: grabando la ruta" : text;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        builder
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setContentTitle(title == null || title.isEmpty() ? "SmartHealth" : title)
            .setContentText(paused ? base + " · en pausa" : base)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            // Lo que dice («Caminar: grabando la ruta») no es privado: con el móvil bloqueado se ve y los botones se pueden tocar sin desbloquearlo (un toque es parar o pausar a mitad de la carrera).
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_SERVICE);
        if (paused) {
            // En pausa el cronómetro no corre: se quita (con la hora de siempre seguiría contando).
            builder.setShowWhen(false).setUsesChronometer(false);
        } else {
            builder.setShowWhen(true).setWhen(WorkoutControl.chronometerBase(startedAt, prefs.getLong(KEY_PAUSED_TOTAL, 0L))).setUsesChronometer(true);
        }
        builder.addAction(paused ? action(context, "Reanudar", ACTION_RESUME, 2) : action(context, "Pausa", ACTION_PAUSE, 1));
        builder.addAction(action(context, "Parar", ACTION_STOP, 3));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_LOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            builder.setContentIntent(PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        return builder.build();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) {
            return;
        }
        // Sin esto la CPU duerme entre posiciones con la pantalla apagada y el anillo, que habla por Bluetooth, tampoco se atiende bien.
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "smartring:tracking");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(WAKE_LOCK_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void beginUpdates(SharedPreferences prefs, String session) {
        if (log == null || !session.equals(logSession)) {
            if (log != null) {
                log.close();
            }
            log = TrackLog.open(getFilesDir(), session);
            logSession = session;
        }
        if (updating) {
            return;
        }
        lastMovementMs = System.currentTimeMillis();
        if (thread == null) {
            thread = new HandlerThread("smartring-gps");
            thread.start();
        }
        try {
            boolean gps = prefs.getBoolean(KEY_GPS, true);
            if (gps) {
                locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, LOCATION_EVERY_MS, 0f, this, thread.getLooper());
            }
            updating = true;
            if (handler == null) {
                handler = new Handler(thread.getLooper());
            }
            handler.removeCallbacks(watchdog);
            handler.postDelayed(watchdog, WATCHDOG_EVERY_MS);
            if (gps) {
                startBarometer();
            }
        } catch (SecurityException e) {
            fail(prefs, "Sin permiso de ubicación.");
        } catch (RuntimeException e) {
            fail(prefs, "No se pudo pedir el GPS: " + e.getMessage());
        }
    }

    /** El barómetro, si el móvil lo tiene: una lectura por segundo basta para medir cuánto se sube (consume muy poco). */
    private void startBarometer() {
        try {
            Sensor barometer = sensors == null ? null : sensors.getDefaultSensor(Sensor.TYPE_PRESSURE);
            if (barometer != null && handler != null) {
                sensors.registerListener(barometerListener, barometer, 1_000_000, handler);
            }
        } catch (RuntimeException e) {
            // sin barómetro la ruta se graba igual
        }
    }

    private void stopUpdates() {
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
        if (sensors != null) {
            try {
                sensors.unregisterListener(barometerListener);
            } catch (RuntimeException e) {
                // ya estaba quitado
            }
        }
        if (updating && locations != null) {
            try {
                locations.removeUpdates(this); // sin GPS no había nada pedido: quitarlo no hace nada
            } catch (RuntimeException e) {
                // ya estaba quitado
            }
        }
        updating = false;
    }

    /** Pasó el tope de tiempo de grabación o de tiempo sin moverse: se detiene (y se deja dicho). Devuelve `true` si se detuvo. */
    private boolean capsExceeded(SharedPreferences prefs, long wall) {
        // Sin GPS no hay movimiento que medir: solo cuenta el tope de tiempo.
        boolean still = prefs.getBoolean(KEY_GPS, true) && wall - lastMovementMs > MAX_STILL_MS;
        if (wall - prefs.getLong(KEY_STARTED, wall) > MAX_SESSION_MS || still) {
            fail(prefs, "La grabación se detuvo sola: llevaba demasiado tiempo en marcha o sin moverse.");
            return true;
        }
        return false;
    }

    /** Algo impide grabar: se deja dicho (la web lo lee con el estado) y el servicio se detiene. */
    private void fail(SharedPreferences prefs, String message) {
        prefs.edit().putString(KEY_ERROR, message).putBoolean(KEY_ACTIVE, false).apply();
        stopUpdates();
        releaseWakeLock();
        stopSelf();
    }

    @Override
    public void onLocationChanged(Location location) {
        TrackLog current = log;
        if (current == null) {
            return;
        }
        long wall = System.currentTimeMillis();
        // En movimiento: por la velocidad que mide el GPS o, si el móvil no la da, por lo que se desplazó desde la posición anterior.
        Location before = lastLocation;
        lastLocation = location;
        boolean moving;
        if (location.hasSpeed()) {
            moving = location.getSpeed() >= MOVING_SPEED_MS;
        } else {
            long dtMs = before == null ? 0L : location.getTime() - before.getTime();
            moving = dtMs > 0 && before.distanceTo(location) / (dtMs / 1000f) >= MOVING_SPEED_MS;
        }
        if (moving) {
            lastMovementMs = wall;
        }
        if (capsExceeded(prefs(this), wall)) {
            return;
        }
        // La hora de la posición, con el reloj de pared del móvil: el instante en que el chip la fijó (no el de entregarla), medido con
        // el reloj monótono y llevado al de pared. Así una posición que tarda en llegar conserva su hora.
        long elapsedMs = location.getElapsedRealtimeNanos() / 1_000_000L;
        long tsMs = elapsedMs > 0 ? elapsedMs + (System.currentTimeMillis() - SystemClock.elapsedRealtime()) : location.getTime();
        double speed = location.hasSpeed() ? location.getSpeed() : Double.NaN;
        double accuracy = location.hasAccuracy() ? location.getAccuracy() : Double.NaN;
        double altitude = location.hasAltitude() ? location.getAltitude() : Double.NaN;
        double verticalAccuracy = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy() ? location.getVerticalAccuracyMeters() : Double.NaN;
        // La presión solo vale si es de hace poco (el barómetro da una lectura por segundo).
        double pressure = SystemClock.elapsedRealtime() - lastPressureAtMs <= 10_000L ? lastPressureHpa : Double.NaN;
        current.append(tsMs, location.getLatitude(), location.getLongitude(), accuracy, speed, altitude, verticalAccuracy, pressure);
    }

    // Estos tres no existen como métodos por defecto antes de Android 11: sin ellos, el sistema fallaría al llamarlos.
    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onDestroy() {
        running = false;
        stopUpdates();
        releaseWakeLock();
        if (thread != null) {
            thread.quitSafely();
            thread = null;
        }
        if (log != null) {
            log.close();
        }
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
