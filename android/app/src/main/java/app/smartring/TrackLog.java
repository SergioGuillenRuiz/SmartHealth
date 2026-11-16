package app.smartring;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * La pista de un entreno: las posiciones que da el GPS, numeradas (1, 2, 3…) y guardadas en memoria Y en un fichero. La web no
 * recibe nada con la pantalla apagada o la app oculta, así que es el servicio nativo quien las recoge aquí y la web las pide cuando
 * puede; y el fichero hace que no se pierdan si el sistema cierra la app a mitad de un entreno.
 *
 * Sin dependencias de Android: se prueba con un JDK normal.
 */
final class TrackLog {

    /** Una posición. Lo que el móvil no da va como NaN. */
    static final class Fix {
        final long seq;
        /** Hora de la posición según el reloj de pared del móvil (milisegundos desde 1970). */
        final long tsMs;
        final double lat;
        final double lon;
        final double accuracyM;
        final double speedMs;
        final double altM;
        final double vAccM;
        /** Presión atmosférica (hPa) que midió el barómetro del móvil en ese momento (NaN si no hay barómetro). */
        final double pressureHpa;

        Fix(long seq, long tsMs, double lat, double lon, double accuracyM, double speedMs, double altM, double vAccM, double pressureHpa) {
            this.seq = seq;
            this.tsMs = tsMs;
            this.lat = lat;
            this.lon = lon;
            this.accuracyM = accuracyM;
            this.speedMs = speedMs;
            this.altM = altM;
            this.vAccM = vAccM;
            this.pressureHpa = pressureHpa;
        }

        String toLine() {
            return seq + "," + tsMs + "," + lat + "," + lon + "," + accuracyM + "," + speedMs + "," + altM + "," + vAccM + "," + pressureHpa;
        }

        static Fix parse(String line, long seq) {
            String[] parts = line.split(",", -1);
            if (parts.length < 8) {
                return null;
            }
            try {
                return new Fix(
                    seq,
                    Long.parseLong(parts[1]),
                    Double.parseDouble(parts[2]),
                    Double.parseDouble(parts[3]),
                    Double.parseDouble(parts[4]),
                    Double.parseDouble(parts[5]),
                    Double.parseDouble(parts[6]),
                    Double.parseDouble(parts[7]),
                    // Las pistas de antes de que se midiera la presión traen 8 columnas.
                    parts.length > 8 ? Double.parseDouble(parts[8]) : Double.NaN
                );
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    /** Tope de posiciones en memoria (unas 110 h a una por segundo): un entreno no llega ni de lejos. */
    static final int MAX_FIXES = 400_000;

    private static final Map<String, TrackLog> OPEN = new HashMap<>();

    private final File file;
    private final List<Fix> fixes = new ArrayList<>();
    private BufferedWriter writer;

    private TrackLog(File file) {
        this.file = file;
        load();
    }

    /** La pista de esa sesión (la misma instancia para quien la pida mientras siga abierta en este proceso). */
    static synchronized TrackLog open(File dir, String sessionId) {
        String key = fileName(sessionId);
        TrackLog log = OPEN.get(key);
        if (log == null) {
            log = new TrackLog(new File(dir, key));
            OPEN.put(key, log);
        }
        return log;
    }

    /** Solo para las pruebas: olvida las pistas abiertas, como si el proceso hubiera muerto (el fichero queda). */
    static synchronized void forgetOpenInstancesForTests() {
        for (TrackLog log : OPEN.values()) {
            log.close();
        }
        OPEN.clear();
    }

    /** Borra la pista de una sesión (en memoria y en disco). */
    static synchronized void delete(File dir, String sessionId) {
        String key = fileName(sessionId);
        TrackLog log = OPEN.remove(key);
        if (log != null) {
            log.close();
        }
        // Se borra también el fichero si esta instancia no llegó a abrirse en este proceso (una pista de antes de que se cerrara la app).
        File file = new File(dir, key);
        if (file.exists() && !file.delete()) {
            file.deleteOnExit();
        }
    }

    /** Quita los ficheros de pistas de más de {@code maxAgeMs} (un entreno que se quedó sin recoger ni borrar). */
    static synchronized void deleteOlderThan(File dir, long maxAgeMs, long nowMs) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File f : files) {
            String name = f.getName();
            if (name.startsWith("track-") && name.endsWith(".csv") && nowMs - f.lastModified() > maxAgeMs && !OPEN.containsKey(name)) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    /** El nombre del fichero de una sesión: solo letras, cifras, guion y guion bajo (el identificador viene de la web). */
    static String fileName(String sessionId) {
        StringBuilder safe = new StringBuilder();
        for (int i = 0; i < sessionId.length() && safe.length() < 64; i++) {
            char c = sessionId.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            safe.append(ok ? c : '_');
        }
        return "track-" + safe + ".csv";
    }

    private void load() {
        if (!file.exists()) {
            return;
        }
        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = reader.readLine()) != null && fixes.size() < MAX_FIXES) {
                // Se renumera por orden: la numeración es la posición en la lista, y una línea rota no puede descuadrarla.
                Fix fix = Fix.parse(line, fixes.size() + 1L);
                if (fix != null) {
                    fixes.add(fix);
                }
            }
        } catch (IOException e) {
            // Lo que no se pudo leer se da por perdido: la pista sigue desde lo leído.
        }
    }

    /** Añade una posición y la deja en el fichero. Devuelve la que se guardó (con su número), o {@code null} si ya no cabe. */
    synchronized Fix append(long tsMs, double lat, double lon, double accuracyM, double speedMs, double altM, double vAccM, double pressureHpa) {
        if (fixes.size() >= MAX_FIXES) {
            return null;
        }
        Fix fix = new Fix(fixes.size() + 1L, tsMs, lat, lon, accuracyM, speedMs, altM, vAccM, pressureHpa);
        fixes.add(fix);
        try {
            if (writer == null) {
                writer = new BufferedWriter(new FileWriter(file, true));
            }
            writer.write(fix.toLine());
            writer.newLine();
            // Cada posición llega al sistema de ficheros al momento: si se cierra el proceso, lo escrito no se pierde.
            writer.flush();
        } catch (IOException e) {
            // Sin disco la pista sigue en memoria: se entrega igual mientras la app viva.
            closeWriter();
        }
        return fix;
    }

    /** Las posiciones con número mayor que {@code seq}, hasta {@code limit}. */
    synchronized List<Fix> since(long seq, int limit) {
        int from = (int) Math.max(0L, Math.min(seq, (long) fixes.size()));
        int to = (int) Math.min((long) fixes.size(), (long) from + Math.max(1, limit));
        return new ArrayList<>(fixes.subList(from, to));
    }

    synchronized long lastSeq() {
        return fixes.size();
    }

    /** Hora de la última posición (0 si no hay ninguna). */
    synchronized long lastTsMs() {
        return fixes.isEmpty() ? 0L : fixes.get(fixes.size() - 1).tsMs;
    }

    synchronized void close() {
        closeWriter();
    }

    private void closeWriter() {
        if (writer != null) {
            try {
                writer.close();
            } catch (IOException e) {
                // nada que hacer
            }
            writer = null;
        }
    }
}
