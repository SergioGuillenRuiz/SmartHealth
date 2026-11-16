package app.smartring;

import java.util.ArrayList;
import java.util.List;

/**
 * El «reflejo» nativo del pulso de un entreno: lo que mantiene medido el pulso del anillo cuando el WebView está parado.
 *
 * El pulso en vivo del R99 se pide con una orden y el anillo la cierra solo a los ~35 s (`04 0e`); la web la vuelve a pedir en el
 * mismo instante. Con la pantalla apagada o la app oculta, algunos móviles dejan el WebView parado (o lo atienden con segundos de
 * retraso) aunque el proceso siga vivo con su servicio en primer plano: el anillo se quedaba sin que lo confirmaran ni le volvieran
 * a pedir el pulso y la web, al volver a verse, tenía las lecturas con la hora de procesarlas y no con la de recibirlas.
 *
 * Esta clase vive en el proceso nativo, que no se para, y hace dos cosas con cada aviso del anillo:
 * <ul>
 *   <li>le pone el número de orden y la hora de recepción (para que la web, aunque los procese tarde, sepa cuándo llegó cada uno);</li>
 *   <li><b>solo si la web no responde</b> (ver {@link #ack}): confirma los avisos del anillo y, si cerró la medida de pulso, la
 *       vuelve a pedir —con las mismas órdenes que habría mandado la web— y marca el aviso como atendido para que la web, al
 *       despertar, no lo repita. Si el anillo calla más de {@link #SILENCE_MS}, también la vuelve a pedir.</li>
 * </ul>
 * Con la web viva no hace nada más que numerar: el camino de siempre sigue siendo el de la web.
 *
 * No depende de Android (la escritura al anillo, el reloj y el espaciado de las escrituras se le dan de fuera): se prueba con un JDK.
 */
final class RingKeeper {

    /** Cómo se escribe al anillo (por el plugin de Bluetooth). Devuelve `false` si no se pudo ni empezar. */
    interface Writer {
        boolean write(byte[] frame);
    }

    /** Ejecuta algo pasado un tiempo, fuera del hilo del aviso (las escrituras no se hacen desde el callback del Bluetooth). */
    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);
    }

    /** Lo que se añade a cada aviso del anillo para la web. */
    static final class Meta {
        /** Número de orden del aviso desde que se armó el reflejo (1, 2, 3…). */
        final long seq;
        /** Hora de recepción (ms, reloj de pared del móvil). */
        final long atMs;
        /** Cuándo pidió el reflejo la última medida de pulso (0: nunca). Si es posterior al inicio de ciclo de la web, el ciclo es nuevo. */
        final long restartAtMs;
        /** El reflejo ya atendió este aviso (lo confirmó y, si cerraba la medida de pulso, la volvió a pedir). */
        final boolean reflexed;

        Meta(long seq, long atMs, long restartAtMs, boolean reflexed) {
            this.seq = seq;
            this.atMs = atMs;
            this.restartAtMs = restartAtMs;
            this.reflexed = reflexed;
        }
    }

    /** Sin respuesta de la web durante tanto tiempo (ms) se entiende que está parada. Tres avisos de 2 s sin contestar. */
    static final long STALL_MS = 7_000L;
    /** Con la web parada, sin lecturas de pulso ni petición durante tanto tiempo, se vuelve a pedir la medida. */
    static final long SILENCE_MS = 20_000L;
    /** Espacio entre dos escrituras seguidas al anillo (Android admite una operación Bluetooth a la vez). */
    static final long WRITE_GAP_MS = 90L;
    /** Reintentos de una escritura que el Bluetooth rechaza por estar ocupado, y su espera. */
    private static final int WRITE_RETRIES = 3;
    private static final long RETRY_MS = 150L;

    private static final int GROUP_DEV_CONTROL = 0x04;
    private static final int GROUP_REAL = 0x06;
    private static final int KEY_MEASUREMENT_RESULT = 0x0e;
    private static final int KEY_MEASUREMENT_STATUS = 0x13;
    private static final int REAL_HEART_RATE = 0x01;
    private static final int REAL_VITALS = 0x03;
    private static final int MODE_HEART_RATE = 0x00;
    /** `0xFB..0xFF` en un payload de 1 byte es un estado de error, no un aviso (la web no los confirma). */
    private static final int FIRST_ERROR_STATUS = 0xFB;
    private static final int HEADER = 4;
    private static final int CRC_LEN = 2;
    private static final int MIN_FRAME = HEADER + CRC_LEN;
    /** Ninguna trama de aviso o de tiempo real se acerca a esto: más largo es otra cosa (un volcado de historial). */
    private static final int MAX_FRAME = 64;

    private final Clock clock;
    private final Writer writer;
    private final Scheduler scheduler;

    private boolean armed = false;
    private byte[] startFrame = new byte[0];
    private long armedAtMs = 0L;
    private volatile long lastAckMs = 0L;
    private long seq = 0L;
    private long lastHrMs = 0L;
    private long lastStartMs = 0L;
    private boolean wasStalled = false;
    private long stalls = 0L;
    private long writes = 0L;
    private long failedWrites = 0L;
    /** Las escrituras pendientes, en orden: se hacen una a una con su espacio. */
    private final List<byte[]> queue = new ArrayList<>();
    private boolean draining = false;

    /** El reloj, aparte para las pruebas. */
    interface Clock {
        long now();
    }

    RingKeeper(Clock clock, Writer writer, Scheduler scheduler) {
        this.clock = clock;
        this.writer = writer;
        this.scheduler = scheduler;
    }

    // ───────────────────────────── control ─────────────────────────────

    /** Arma el reflejo para el entreno que empieza. `startHr` es la trama con la que la web pide la medida de pulso. */
    synchronized void arm(byte[] startHr) {
        long now = clock.now();
        armed = true;
        startFrame = startHr.clone();
        armedAtMs = now;
        lastAckMs = now;
        seq = 0L;
        lastHrMs = now;
        lastStartMs = 0L;
        wasStalled = false;
        stalls = 0L;
        writes = 0L;
        failedWrites = 0L;
        queue.clear();
    }

    synchronized void disarm() {
        armed = false;
        queue.clear();
    }

    synchronized boolean isArmed() {
        return armed;
    }

    /** La web contestó a un aviso del servicio: está viva. */
    void ack() {
        lastAckMs = clock.now();
    }

    private boolean stalledAt(long now) {
        return armed && now - lastAckMs > STALL_MS;
    }

    synchronized boolean isStalled() {
        return stalledAt(clock.now());
    }

    synchronized long stalls() {
        return stalls;
    }

    synchronized long writes() {
        return writes;
    }

    synchronized long failedWrites() {
        return failedWrites;
    }

    synchronized long lastSeq() {
        return seq;
    }

    // ───────────────────────────── avisos del anillo ─────────────────────────────

    /**
     * Un aviso (una notificación Bluetooth) del anillo: lo numera y, si la web está parada, lo atiende. Se llama desde el hilo del
     * Bluetooth; las escrituras salen por el {@link Scheduler}.
     */
    synchronized Meta onNotification(byte[] chunk) {
        long now = clock.now();
        seq++;
        if (!armed) return new Meta(seq, now, 0L, false);
        boolean closesHr = false;
        List<Integer> pushes = new ArrayList<>();
        int offset = 0;
        while (chunk.length - offset >= MIN_FRAME) {
            int length = (chunk[offset + 2] & 0xFF) | ((chunk[offset + 3] & 0xFF) << 8);
            if (length < MIN_FRAME || length > MAX_FRAME || offset + length > chunk.length) break;
            int expected = crc16(chunk, offset, length - CRC_LEN);
            int given = (chunk[offset + length - 2] & 0xFF) | ((chunk[offset + length - 1] & 0xFF) << 8);
            if (expected != given) break;
            int group = chunk[offset] & 0xFF;
            int cmd = chunk[offset + 1] & 0xFF;
            int payloadLength = length - MIN_FRAME;
            int first = payloadLength > 0 ? chunk[offset + HEADER] & 0xFF : -1;
            boolean error = payloadLength == 1 && first >= FIRST_ERROR_STATUS;
            if (group == GROUP_DEV_CONTROL && !error) {
                pushes.add(cmd);
                if (cmd == KEY_MEASUREMENT_RESULT && payloadLength >= 2 && first == MODE_HEART_RATE) closesHr = true;
                if (cmd == KEY_MEASUREMENT_STATUS && payloadLength >= 3 && first == MODE_HEART_RATE && (chunk[offset + HEADER + 2] & 0xFF) > 0) lastHrMs = now;
            } else if (group == GROUP_REAL) {
                if (cmd == REAL_HEART_RATE && payloadLength >= 1 && first > 0) lastHrMs = now;
                if (cmd == REAL_VITALS && payloadLength >= 3 && (chunk[offset + HEADER + 2] & 0xFF) > 0) lastHrMs = now;
            }
            offset += length;
        }
        boolean stalled = stalledAt(now);
        noteStall(stalled);
        boolean reflexed = false;
        if (stalled && !pushes.isEmpty()) {
            // Los avisos se confirman SIEMPRE (el anillo los reenvía hasta que se confirman) y, tras cerrar la medida de pulso, se vuelve a pedir.
            for (int cmd : pushes) enqueue(buildFrame(GROUP_DEV_CONTROL, cmd, new byte[] { 0 }));
            if (closesHr && startFrame.length > 0) {
                enqueue(startFrame);
                lastStartMs = now;
            }
            reflexed = true;
        }
        return new Meta(seq, now, lastStartMs, reflexed);
    }

    /**
     * Lo que depende del tiempo y no de un aviso: con la web parada y el anillo en silencio, volver a pedir la medida. Se llama cada
     * pocos segundos (el mismo aviso nativo del entreno).
     */
    synchronized void tick() {
        long now = clock.now();
        boolean stalled = stalledAt(now);
        noteStall(stalled);
        if (!stalled || startFrame.length == 0) return;
        long quietSince = Math.max(Math.max(lastHrMs, lastStartMs), armedAtMs);
        if (now - quietSince > SILENCE_MS) {
            enqueue(startFrame);
            lastStartMs = now;
            lastHrMs = now; // no se repite hasta que pase otro silencio entero
        }
    }

    private void noteStall(boolean stalled) {
        if (stalled && !wasStalled) stalls++;
        wasStalled = stalled;
    }

    // ───────────────────────────── escrituras ─────────────────────────────

    private void enqueue(byte[] frame) {
        queue.add(frame);
        if (!draining) {
            draining = true;
            scheduler.postDelayed(this::drainOne, 0L);
        }
    }

    /** Escribe la primera trama pendiente; si el Bluetooth está ocupado la reintenta, y con la siguiente espera su espacio. */
    private void drainOne() {
        byte[] frame;
        synchronized (this) {
            if (!armed || queue.isEmpty()) {
                draining = false;
                queue.clear();
                return;
            }
            frame = queue.get(0);
        }
        boolean ok = writer.write(frame);
        boolean more;
        synchronized (this) {
            if (!ok && retry < WRITE_RETRIES) {
                retry++;
                scheduler.postDelayed(this::drainOne, RETRY_MS);
                return;
            }
            if (!queue.isEmpty()) queue.remove(0);
            retry = 0;
            if (ok) writes++;
            else failedWrites++;
            more = armed && !queue.isEmpty();
            if (!more) draining = false;
        }
        if (more) scheduler.postDelayed(this::drainOne, WRITE_GAP_MS);
    }

    /** Intentos fallidos seguidos de la trama que se está escribiendo. */
    private int retry = 0;

    // ───────────────────────────── tramas ─────────────────────────────

    /** `[grupo][clave][largo:2 LE][payload][crc16:2 LE]`; el largo es el total de la trama. */
    static byte[] buildFrame(int group, int cmd, byte[] payload) {
        int total = payload.length + MIN_FRAME;
        byte[] out = new byte[total];
        out[0] = (byte) group;
        out[1] = (byte) cmd;
        out[2] = (byte) (total & 0xFF);
        out[3] = (byte) ((total >> 8) & 0xFF);
        System.arraycopy(payload, 0, out, HEADER, payload.length);
        int crc = crc16(out, 0, total - CRC_LEN);
        out[total - 2] = (byte) (crc & 0xFF);
        out[total - 1] = (byte) ((crc >> 8) & 0xFF);
        return out;
    }

    /** CRC-16/CCITT-FALSE (polinomio 0x1021, inicio 0xFFFF): el de las tramas YCBT. */
    static int crc16(byte[] data, int offset, int length) {
        int crc = 0xFFFF;
        for (int i = offset; i < offset + length; i++) {
            crc ^= (data[i] & 0xFF) << 8;
            for (int bit = 0; bit < 8; bit++) {
                crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
            }
        }
        return crc;
    }

    /** Un texto hexadecimal (sin separadores, mayúsculas o minúsculas) como bytes; `null` si no lo es. */
    static byte[] fromHex(String hex) {
        if (hex == null || hex.length() % 2 != 0) return null;
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int high = Character.digit(hex.charAt(i * 2), 16);
            int low = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) return null;
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }

    static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16))).append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
        }
        return out.toString();
    }
}
