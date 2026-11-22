package app.smartring;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * De los eventos de uso que guarda Android a los TRAMOS en que el móvil estuvo en uso, para que la app estime el sueño de las noches en que no lleva el anillo. Sin nada de Android: se prueba con
 * un JDK normal.
 *
 * Solo salen HORAS (de cuándo a cuándo): ni qué apps ni qué se hizo. Un tramo es:
 * <ul>
 *   <li>un rato con la pantalla encendida en que la persona hizo algo: la desbloqueó, abrió una app o la tuvo encendida al menos {@link #MIN_SCREEN_MS}. Una pantalla que se enciende sola
 *       unos segundos (una notificación) NO cuenta: no es que esté despierta, y a las seis de la mañana movería la hora de despertar una hora;</li>
 *   <li>un desbloqueo suelto (si el sistema no da la pantalla), como una medio minuto de uso;</li>
 *   <li>sin eventos de pantalla (Android anterior a la 9): el tiempo con alguna app delante.</li>
 * </ul>
 */
final class PhoneActivity {

    /** Tipos de evento que la parte de Android traduce de los de {@code UsageEvents.Event} (nada de esto lleva nombre de app). */
    static final int SCREEN_ON = 1;
    static final int SCREEN_OFF = 2;
    static final int UNLOCK = 3;
    static final int APP_ON = 4;
    static final int APP_OFF = 5;
    static final int SHUTDOWN = 6;
    static final int STARTUP = 7;

    /** Una pantalla encendida menos tiempo que esto, sin desbloqueo ni app, es un aviso que la enciende sola y no cuenta. */
    static final long MIN_SCREEN_MS = 25_000L;
    /** Lo que se supone que dura un desbloqueo suelto o una app delante sin más datos. */
    static final long UNLOCK_MS = 30_000L;
    /** Dos tramos a menos de esto se unen. */
    static final long MERGE_GAP_MS = 60_000L;
    /** Si el primer evento de la lectura es un apagado de pantalla, la pantalla llevaba encendida a lo sumo esto (la lectura no ve lo anterior). */
    static final long CARRY_MS = 5 * 60_000L;

    private PhoneActivity() {}

    /** Un evento: de qué tipo y a qué hora (ms, reloj de pared). */
    static final class Event {
        final int type;
        final long atMs;

        Event(int type, long atMs) {
            this.type = type;
            this.atMs = atMs;
        }
    }

    private static List<Event> sorted(List<Event> events) {
        List<Event> copy = new ArrayList<>(events);
        Collections.sort(copy, new Comparator<Event>() {
            @Override
            public int compare(Event a, Event b) {
                return Long.compare(a.atMs, b.atMs);
            }
        });
        return copy;
    }

    /**
     * Los tramos de uso entre {@code fromMs} y {@code toMs}. {@code screenEvents}: el sistema da los eventos de pantalla (Android 9 o posterior); si no, se usan las apps delante.
     * Un tramo que sigue en marcha al final se cierra en {@code toMs}.
     */
    static List<long[]> uses(List<Event> events, long fromMs, long toMs, boolean screenEvents) {
        List<long[]> out = new ArrayList<>();
        List<Event> list = sorted(events);
        if (screenEvents) {
            long screenOnAt = -1;
            boolean acted = false;
            boolean first = true;
            for (Event e : list) {
                if (e.atMs < fromMs || e.atMs > toMs) {
                    continue;
                }
                if (e.type == SCREEN_ON) {
                    if (screenOnAt < 0) {
                        screenOnAt = e.atMs;
                        acted = false;
                    }
                } else if (e.type == SCREEN_OFF) {
                    long start = screenOnAt;
                    if (start < 0 && first) {
                        // La lectura empieza con la pantalla ya encendida: se supone que llevaba poco.
                        start = Math.max(fromMs, e.atMs - CARRY_MS);
                        acted = true;
                    }
                    if (start >= 0 && (acted || e.atMs - start >= MIN_SCREEN_MS)) {
                        out.add(new long[] { start, e.atMs });
                    }
                    screenOnAt = -1;
                    acted = false;
                } else if (e.type == UNLOCK) {
                    if (screenOnAt >= 0) {
                        acted = true;
                    } else {
                        out.add(new long[] { e.atMs, Math.min(toMs, e.atMs + UNLOCK_MS) });
                    }
                } else if (e.type == APP_ON) {
                    if (screenOnAt >= 0) {
                        acted = true;
                    }
                }
                if (e.type == SCREEN_ON || e.type == SCREEN_OFF) {
                    first = false;
                }
            }
            if (screenOnAt >= 0 && (acted || toMs - screenOnAt >= MIN_SCREEN_MS)) {
                out.add(new long[] { screenOnAt, toMs });
            }
        } else {
            // Sin eventos de pantalla: mientras haya alguna app delante.
            int depth = 0;
            long since = -1;
            for (Event e : list) {
                if (e.atMs < fromMs || e.atMs > toMs) {
                    continue;
                }
                if (e.type == APP_ON) {
                    if (depth == 0) {
                        since = e.atMs;
                    }
                    depth++;
                } else if (e.type == APP_OFF && depth > 0) {
                    depth--;
                    if (depth == 0 && since >= 0) {
                        out.add(new long[] { since, e.atMs });
                        since = -1;
                    }
                } else if (e.type == UNLOCK) {
                    out.add(new long[] { e.atMs, Math.min(toMs, e.atMs + UNLOCK_MS) });
                }
            }
            if (depth > 0 && since >= 0) {
                out.add(new long[] { since, toMs });
            }
        }
        return merge(out, MERGE_GAP_MS);
    }

    /** Los tramos con el móvil apagado: de cada apagado al siguiente arranque (o hasta {@code toMs}). */
    static List<long[]> offs(List<Event> events, long toMs) {
        List<long[]> out = new ArrayList<>();
        long since = -1;
        for (Event e : sorted(events)) {
            if (e.type == SHUTDOWN && since < 0) {
                since = e.atMs;
            } else if (e.type == STARTUP) {
                if (since >= 0 && e.atMs >= since) {
                    out.add(new long[] { since, e.atMs });
                }
                since = -1;
            }
        }
        if (since >= 0 && toMs >= since) {
            out.add(new long[] { since, toMs });
        }
        return out;
    }

    /** Ordena y une los tramos que se tocan o están a menos de {@code gapMs}. Descarta los vacíos al revés. */
    static List<long[]> merge(List<long[]> spans, long gapMs) {
        List<long[]> copy = new ArrayList<>();
        for (long[] s : spans) {
            if (s != null && s.length == 2 && s[1] >= s[0] && s[0] > 0) {
                copy.add(new long[] { s[0], s[1] });
            }
        }
        Collections.sort(copy, new Comparator<long[]>() {
            @Override
            public int compare(long[] a, long[] b) {
                int c = Long.compare(a[0], b[0]);
                return c != 0 ? c : Long.compare(a[1], b[1]);
            }
        });
        List<long[]> merged = new ArrayList<>();
        for (long[] s : copy) {
            long[] last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            if (last != null && s[0] - last[1] <= gapMs) {
                last[1] = Math.max(last[1], s[1]);
            } else {
                merged.add(s);
            }
        }
        return merged;
    }

    /** Los tramos como texto «inicio:fin;inicio:fin» (lo que entiende la web). */
    static String format(List<long[]> spans) {
        StringBuilder out = new StringBuilder();
        for (long[] s : spans) {
            if (out.length() > 0) {
                out.append(';');
            }
            out.append(s[0]).append(':').append(s[1]);
        }
        return out.toString();
    }

    /** Lo contrario de {@link #format}. Lo que no se entiende se salta (un texto roto no tumba nada). */
    static List<long[]> parse(String text) {
        List<long[]> out = new ArrayList<>();
        if (text == null || text.isEmpty()) {
            return out;
        }
        for (String part : text.split(";")) {
            int colon = part.indexOf(':');
            if (colon <= 0 || colon == part.length() - 1) {
                continue;
            }
            try {
                long a = Long.parseLong(part.substring(0, colon));
                long b = Long.parseLong(part.substring(colon + 1));
                if (a > 0 && b >= a) {
                    out.add(new long[] { a, b });
                }
            } catch (NumberFormatException e) {
                // se salta
            }
        }
        return out;
    }

    /** Lo que cae en {@code [fromMs, toMs]} (los tramos que lo cruzan se recortan). */
    static List<long[]> clip(List<long[]> spans, long fromMs, long toMs) {
        List<long[]> out = new ArrayList<>();
        for (long[] s : spans) {
            if (s[1] >= fromMs && s[0] <= toMs) {
                out.add(new long[] { Math.max(s[0], fromMs), Math.min(s[1], toMs) });
            }
        }
        return out;
    }
}
