package app.smartring;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Las órdenes que se tocan en los botones de la notificación del entreno (pausa, reanudar, parar) y la cuenta del cronómetro de la notificación. Sin nada de Android: se prueba con un JDK normal.
 *
 * Las órdenes no se entregan a la web una a una: se anotan en una cola (con la hora a la que se tocó cada una) que el servicio guarda en las preferencias, y la web las recoge cuando puede. Así una
 * web parada un rato (pantalla apagada) no pierde ninguna ni retrasa la hora de la pausa o de la parada, y si la app estaba cerrada, la parada sigue anotada al abrirla.
 */
final class WorkoutControl {

    static final String PAUSE = "pause";
    static final String RESUME = "resume";
    static final String STOP = "stop";

    /** Más órdenes que esto sin que la web las recoja no es un entreno normal: se tira la más antigua. */
    private static final int MAX_QUEUED = 32;

    private WorkoutControl() {}

    /** Una orden tocada: cuál y a qué hora (ms, reloj de pared del móvil). */
    static final class Entry {
        final String action;
        final long atMs;

        Entry(String action, long atMs) {
            this.action = action;
            this.atMs = atMs;
        }
    }

    private static boolean known(String action) {
        return PAUSE.equals(action) || RESUME.equals(action) || STOP.equals(action);
    }

    /**
     * La cola con una orden más al final. La cola es texto, «acción:hora;acción:hora». Tras una parada no se admite nada más (el entreno ya acabó), una orden desconocida se ignora y, si se llena, se
     * olvida la más antigua.
     */
    static String append(String queue, String action, long atMs) {
        List<Entry> entries = parse(queue);
        if (!known(action) || atMs <= 0) {
            return format(entries);
        }
        for (Entry entry : entries) {
            if (STOP.equals(entry.action)) {
                return format(entries);
            }
        }
        entries.add(new Entry(action, atMs));
        while (entries.size() > MAX_QUEUED) {
            entries.remove(0);
        }
        return format(entries);
    }

    /** Las órdenes de la cola, en el orden en que se tocaron. Lo que no se entiende se salta (una cola rota no tumba nada). */
    static List<Entry> parse(String queue) {
        List<Entry> entries = new ArrayList<>();
        if (queue == null || queue.isEmpty()) {
            return entries;
        }
        for (String part : queue.split(";")) {
            int colon = part.indexOf(':');
            if (colon <= 0 || colon == part.length() - 1) {
                continue;
            }
            String action = part.substring(0, colon);
            if (!known(action)) {
                continue;
            }
            try {
                long atMs = Long.parseLong(part.substring(colon + 1));
                if (atMs > 0) {
                    entries.add(new Entry(action, atMs));
                }
            } catch (NumberFormatException e) {
                // una hora ilegible: la orden se salta
            }
        }
        return entries;
    }

    static String format(List<Entry> entries) {
        StringBuilder out = new StringBuilder();
        for (Entry entry : entries) {
            if (out.length() > 0) {
                out.append(';');
            }
            out.append(entry.action).append(':').append(entry.atMs);
        }
        return out.toString();
    }

    /** Cuántas órdenes esperan. */
    static int count(String queue) {
        return parse(queue).size();
    }

    /** ¿Hay una parada esperando? */
    static boolean hasStop(String queue) {
        for (Entry entry : parse(queue)) {
            if (STOP.equals(entry.action)) {
                return true;
            }
        }
        return false;
    }

    /** Las órdenes sin modificar (para entregarlas): una copia que nadie más toca. */
    static List<Entry> snapshot(String queue) {
        return Collections.unmodifiableList(parse(queue));
    }

    /**
     * Desde cuándo cuenta el cronómetro de la notificación: el instante en que empezó el entreno más el tiempo que estuvo en pausa. El cronómetro del sistema enseña «ahora − esto», es decir, el
     * tiempo activo.
     */
    static long chronometerBase(long startedAtMs, long pausedTotalMs) {
        return startedAtMs + Math.max(0L, pausedTotalMs);
    }

    /** El resultado de pausar o reanudar: desde cuándo está en pausa (0 = no lo está) y cuánto tiempo suma ya de pausas. */
    static final class PauseState {
        final long since;
        final long total;
        final boolean changed;

        PauseState(long since, long total, boolean changed) {
            this.since = since;
            this.total = total;
            this.changed = changed;
        }
    }

    /**
     * Pausa o reanuda a la hora {@code atMs}. Pausar una pausa o reanudar lo que no está pausado no cambia nada (la orden de la notificación y el aviso de la web llegan los dos, y vale el primero).
     */
    static PauseState applyPause(long since, long total, boolean paused, long atMs) {
        long at = Math.max(1L, atMs);
        if (paused) {
            return since > 0L ? new PauseState(since, total, false) : new PauseState(at, total, true);
        }
        if (since <= 0L) {
            return new PauseState(0L, total, false);
        }
        return new PauseState(0L, total + Math.max(0L, at - since), true);
    }
}
