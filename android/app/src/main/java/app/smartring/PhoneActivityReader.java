package app.smartring;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Build;
import android.os.Process;
import java.util.ArrayList;
import java.util.List;

/**
 * Lee de Android cuándo se usó el móvil (pantalla encendida, desbloqueos, apps delante, apagados) y lo reduce a TRAMOS de horas con {@link PhoneActivity}. Nunca lee ni guarda el nombre de
 * ninguna app. Necesita el acceso a «datos de uso» que la persona da a mano en los ajustes de Android (permiso especial: no sale como un cuadro de permisos).
 */
final class PhoneActivityReader {

    // Los tipos de {@code UsageEvents.Event}, como números para no depender de la versión con que se compile (algunos existen desde Android 9).
    private static final int ACTIVITY_RESUMED = 1; // MOVE_TO_FOREGROUND hasta Android 9
    private static final int ACTIVITY_PAUSED = 2; // MOVE_TO_BACKGROUND hasta Android 9
    private static final int SCREEN_INTERACTIVE = 15;
    private static final int SCREEN_NON_INTERACTIVE = 16;
    private static final int KEYGUARD_HIDDEN = 18;
    private static final int DEVICE_SHUTDOWN = 26;
    private static final int DEVICE_STARTUP = 27;

    private PhoneActivityReader() {}

    /** Lo que se leyó. */
    static final class Result {
        boolean granted;
        long fromMs;
        long toMs;
        /** La hora del primer evento que el sistema aún conserva en lo pedido (0: ninguno). Antes de eso no se sabe qué pasó. */
        long firstMs;
        /** La hora del último evento leído (0: ninguno). */
        long lastEventMs;
        /** Cuántos eventos de pantalla (encendido y apagado), desbloqueo y de apps delante (se enciende o se apaga) había: sirve para saber qué da este móvil. */
        int screenEvents;
        int unlockEvents;
        int appEvents;
        List<long[]> uses = new ArrayList<>();
        List<long[]> offs = new ArrayList<>();
    }

    /** El sistema da los eventos de pantalla desde Android 9. */
    static boolean screenEvents() {
        return Build.VERSION.SDK_INT >= 28;
    }

    /** ¿Ha dado la persona el acceso a los datos de uso? */
    static boolean granted(Context context) {
        try {
            AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (appOps == null) {
                return false;
            }
            int mode;
            if (Build.VERSION.SDK_INT >= 29) {
                mode = appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
            } else {
                mode = appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
            }
            if (mode == AppOpsManager.MODE_DEFAULT) {
                if (context.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    return true;
                }
            } else if (mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_FOREGROUND) {
                return true;
            }
        } catch (RuntimeException e) {
            // se prueba la lectura de todos modos
        }
        return readsEvents(context);
    }

    /**
     * Plan B para saber si hay acceso: algunos móviles (otras capas de Android) dicen «no» en los ajustes internos aunque la persona haya dado el acceso. Si pedir los eventos de las últimas 24 h
     * devuelve alguno, el acceso funciona sea lo que sea lo que diga el sistema. Sin eventos (un móvil sin tocar) o sin acceso no se puede saber y se da por no dado.
     */
    private static boolean readsEvents(Context context) {
        try {
            UsageStatsManager manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
            if (manager == null) {
                return false;
            }
            long now = System.currentTimeMillis();
            UsageEvents events = manager.queryEvents(now - 24L * 3_600_000, now);
            return events != null && events.hasNextEvent();
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * La hora del primer evento que el sistema conserva (se mira hasta 30 días atrás), o 0 si no hay ninguno. De ahí en adelante se sabe qué pasó AUNQUE en un rato no hubiera ningún evento: una noche
     * con el móvil quieto no tiene eventos y es justo lo que se quiere ver. (Tomar como principio de lo leído el primer evento de lo pedido dejaba esa noche sin cubrir y sin estimar.)
     */
    static long earliestEvent(Context context, long nowMs) {
        try {
            if (!granted(context)) {
                return 0;
            }
            UsageStatsManager manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
            if (manager == null) {
                return 0;
            }
            UsageEvents events = manager.queryEvents(nowMs - 30L * 24 * 3_600_000, nowMs);
            UsageEvents.Event e = new UsageEvents.Event();
            long first = 0;
            while (events != null && events.hasNextEvent()) {
                events.getNextEvent(e);
                long at = e.getTimeStamp();
                if (at > 0 && (first == 0 || at < first)) {
                    first = at;
                }
            }
            return first;
        } catch (RuntimeException ex) {
            return 0;
        }
    }

    /** Lee de {@code fromMs} a {@code toMs}. Sin acceso (o si el sistema falla) devuelve {@code granted = false} y nada más. */
    static Result read(Context context, long fromMs, long toMs) {
        Result result = new Result();
        result.fromMs = fromMs;
        result.toMs = toMs;
        if (!granted(context)) {
            return result;
        }
        try {
            UsageStatsManager manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
            if (manager == null) {
                return result;
            }
            UsageEvents events = manager.queryEvents(fromMs, toMs);
            List<PhoneActivity.Event> list = new ArrayList<>();
            UsageEvents.Event e = new UsageEvents.Event();
            long first = 0;
            long lastAt = 0;
            while (events != null && events.hasNextEvent()) {
                events.getNextEvent(e);
                long at = e.getTimeStamp();
                if (first == 0 || at < first) {
                    first = at;
                }
                if (at > lastAt) {
                    lastAt = at;
                }
                switch (e.getEventType()) {
                    case SCREEN_INTERACTIVE:
                        result.screenEvents++;
                        list.add(new PhoneActivity.Event(PhoneActivity.SCREEN_ON, at));
                        break;
                    case SCREEN_NON_INTERACTIVE:
                        result.screenEvents++;
                        list.add(new PhoneActivity.Event(PhoneActivity.SCREEN_OFF, at));
                        break;
                    case KEYGUARD_HIDDEN:
                        result.unlockEvents++;
                        list.add(new PhoneActivity.Event(PhoneActivity.UNLOCK, at));
                        break;
                    case ACTIVITY_RESUMED:
                        result.appEvents++;
                        list.add(new PhoneActivity.Event(PhoneActivity.APP_ON, at));
                        break;
                    case ACTIVITY_PAUSED:
                        result.appEvents++;
                        list.add(new PhoneActivity.Event(PhoneActivity.APP_OFF, at));
                        break;
                    case DEVICE_SHUTDOWN:
                        list.add(new PhoneActivity.Event(PhoneActivity.SHUTDOWN, at));
                        break;
                    case DEVICE_STARTUP:
                        list.add(new PhoneActivity.Event(PhoneActivity.STARTUP, at));
                        break;
                    default:
                        break;
                }
            }
            result.granted = true;
            result.firstMs = first;
            result.lastEventMs = lastAt;
            // Si este móvil no da eventos de pantalla (aunque sea Android 9 o posterior), se usan las apps delante y los desbloqueos: mejor eso que nada.
            result.uses = PhoneActivity.uses(list, fromMs, toMs, screenEvents() && result.screenEvents > 0);
            result.offs = PhoneActivity.offs(list, toMs);
        } catch (RuntimeException ex) {
            result.granted = false;
        }
        return result;
    }
}
