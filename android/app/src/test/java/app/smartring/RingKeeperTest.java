package app.smartring;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Test;

/** El reflejo nativo del pulso no depende de Android: se prueba con un reloj, un anillo y un planificador de mentira. */
public class RingKeeperTest {

    private long now;
    private final List<byte[]> written = new ArrayList<>();
    /** Cuántas escrituras seguidas rechaza el «Bluetooth» antes de aceptar (para probar los reintentos). */
    private int busyFor = 0;
    private boolean alwaysBusy = false;
    private final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
    private RingKeeper keeper;

    private static final byte[] START_HR = RingKeeper.buildFrame(0x03, 0x2f, new byte[] { 1, 0 });

    @Before
    public void setUp() {
        now = 1_000_000L;
        keeper = new RingKeeper(
            () -> now,
            frame -> {
                if (alwaysBusy) return false;
                if (busyFor > 0) {
                    busyFor--;
                    return false;
                }
                written.add(frame);
                return true;
            },
            (task, delayMs) -> tasks.add(task)
        );
    }

    /** Ejecuta lo que esté pendiente en el planificador (las esperas no importan: solo el orden). */
    private void run() {
        int guard = 0;
        while (!tasks.isEmpty() && guard++ < 1000) tasks.poll().run();
    }

    private static byte[] frame(int group, int cmd, int... payload) {
        byte[] bytes = new byte[payload.length];
        for (int i = 0; i < payload.length; i++) bytes[i] = (byte) payload[i];
        return RingKeeper.buildFrame(group, cmd, bytes);
    }

    private static byte[] concat(byte[]... parts) {
        int total = 0;
        for (byte[] part : parts) total += part.length;
        byte[] out = new byte[total];
        int at = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, at, part.length);
            at += part.length;
        }
        return out;
    }

    /** La web lleva tanto tiempo sin contestar que se la da por parada. */
    private void stall() {
        now += RingKeeper.STALL_MS + 1_000L;
    }

    // ───────────────────────────── tramas ─────────────────────────────

    @Test
    public void crcEsElDeLasTramasYcbt() {
        byte[] check = "123456789".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        assertEquals(0x29B1, RingKeeper.crc16(check, 0, check.length));
    }

    @Test
    public void laConfirmacionDeUnAvisoEsLaTramaDe7Bytes() {
        byte[] ack = frame(0x04, 0x0e, 0);
        assertEquals(7, ack.length);
        assertEquals(0x04, ack[0]);
        assertEquals(0x0e, ack[1]);
        assertEquals(7, ack[2]);
        assertEquals(0, ack[3]);
        assertEquals(0, ack[4]);
        // El CRC cuadra con el que calcula la propia trama.
        int crc = (ack[5] & 0xFF) | ((ack[6] & 0xFF) << 8);
        assertEquals(RingKeeper.crc16(ack, 0, 5), crc);
    }

    @Test
    public void elHexadecimalDeIdaYVuelta() {
        byte[] bytes = new byte[] { 0x04, 0x0e, (byte) 0xff, 0x00 };
        assertEquals("040EFF00", RingKeeper.toHex(bytes));
        assertArrayEquals(bytes, RingKeeper.fromHex("040eFF00"));
        assertNull(RingKeeper.fromHex("040"));
        assertNull(RingKeeper.fromHex("04zz"));
    }

    // ───────────────────────────── sin armar y con la web viva ─────────────────────────────

    @Test
    public void sinArmarSoloNumeraYPoneLaHora() {
        RingKeeper.Meta first = keeper.onNotification(frame(0x04, 0x0e, 0, 1));
        now += 500;
        RingKeeper.Meta second = keeper.onNotification(frame(0x06, 0x01, 72));
        assertEquals(1, first.seq);
        assertEquals(2, second.seq);
        assertEquals(1_000_000L, first.atMs);
        assertEquals(1_000_500L, second.atMs);
        assertFalse(first.reflexed);
        run();
        assertTrue(written.isEmpty());
    }

    @Test
    public void conLaWebVivaNoHaceNadaMasQueNumerar() {
        keeper.arm(START_HR);
        for (int i = 0; i < 5; i++) {
            now += 2_000;
            keeper.ack();
            RingKeeper.Meta meta = keeper.onNotification(frame(0x04, 0x0e, 0, 1));
            assertFalse("la web viva se encarga ella", meta.reflexed);
        }
        run();
        assertTrue(written.isEmpty());
        assertEquals(0, keeper.stalls());
        assertFalse(keeper.isStalled());
    }

    // ───────────────────────────── con la web parada ─────────────────────────────

    @Test
    public void conLaWebParadaConfirmaElCierreYVuelveAPedirElPulso() {
        keeper.arm(START_HR);
        stall();
        RingKeeper.Meta meta = keeper.onNotification(frame(0x04, 0x0e, 0, 1));
        run();
        assertTrue(meta.reflexed);
        assertEquals(now, meta.restartAtMs);
        assertEquals(2, written.size());
        assertArrayEquals("primero la confirmación", frame(0x04, 0x0e, 0), written.get(0));
        assertArrayEquals("después la petición de pulso", START_HR, written.get(1));
        assertEquals(2, keeper.writes());
        assertTrue(keeper.isStalled());
        assertEquals(1, keeper.stalls());
    }

    @Test
    public void otroAvisoSeConfirmaPeroNoPideElPulso() {
        keeper.arm(START_HR);
        stall();
        RingKeeper.Meta meta = keeper.onNotification(frame(0x04, 0x13, 0, 1, 80));
        run();
        assertTrue(meta.reflexed);
        assertEquals(0L, meta.restartAtMs);
        assertEquals(1, written.size());
        assertArrayEquals(frame(0x04, 0x13, 0), written.get(0));
    }

    @Test
    public void elCierreDeOtraMedidaNoVuelveAPedirElPulso() {
        keeper.arm(START_HR);
        stall();
        // `04 0e [modo 2 = SpO₂][1]`: no es la medida de pulso.
        keeper.onNotification(frame(0x04, 0x0e, 2, 1));
        run();
        assertEquals(1, written.size());
        assertArrayEquals(frame(0x04, 0x0e, 0), written.get(0));
    }

    @Test
    public void losEstadosDeErrorNoSeConfirman() {
        keeper.arm(START_HR);
        stall();
        RingKeeper.Meta meta = keeper.onNotification(frame(0x04, 0x0e, 0xFC));
        run();
        assertFalse(meta.reflexed);
        assertTrue(written.isEmpty());
    }

    @Test
    public void lasLecturasEnTiempoRealNoSeConfirman() {
        keeper.arm(START_HR);
        stall();
        RingKeeper.Meta meta = keeper.onNotification(frame(0x06, 0x01, 91));
        run();
        assertFalse(meta.reflexed);
        assertTrue(written.isEmpty());
    }

    @Test
    public void variasTramasEnUnaNotificacionSeAtiendenTodas() {
        keeper.arm(START_HR);
        stall();
        byte[] chunk = concat(frame(0x06, 0x01, 90), frame(0x04, 0x0e, 0, 1), frame(0x04, 0x13, 0, 1, 90));
        RingKeeper.Meta meta = keeper.onNotification(chunk);
        run();
        assertTrue(meta.reflexed);
        // Dos avisos que confirmar y la petición de pulso por el cierre de la medida.
        assertEquals(3, written.size());
        assertArrayEquals(frame(0x04, 0x0e, 0), written.get(0));
        assertArrayEquals(frame(0x04, 0x13, 0), written.get(1));
        assertArrayEquals(START_HR, written.get(2));
    }

    @Test
    public void unaTramaConElCrcMaloNoSeAtiende() {
        keeper.arm(START_HR);
        stall();
        byte[] bad = frame(0x04, 0x0e, 0, 1);
        bad[bad.length - 1] ^= 0x55;
        RingKeeper.Meta meta = keeper.onNotification(bad);
        run();
        assertFalse(meta.reflexed);
        assertTrue(written.isEmpty());
    }

    @Test
    public void unaTramaLargaDeHistorialNoSeToca() {
        keeper.arm(START_HR);
        stall();
        byte[] payload = new byte[200];
        RingKeeper.Meta meta = keeper.onNotification(RingKeeper.buildFrame(0x05, 0x02, payload));
        run();
        assertFalse(meta.reflexed);
        assertTrue(written.isEmpty());
    }

    @Test
    public void cuandoLaWebVuelveElReflejoSeApagaSolo() {
        keeper.arm(START_HR);
        stall();
        assertTrue(keeper.onNotification(frame(0x04, 0x0e, 0, 1)).reflexed);
        run();
        written.clear();
        keeper.ack(); // la web contesta de nuevo
        assertFalse(keeper.isStalled());
        assertFalse(keeper.onNotification(frame(0x04, 0x0e, 0, 1)).reflexed);
        run();
        assertTrue(written.isEmpty());
        assertEquals(1, keeper.stalls());
        // Y si vuelve a pararse, cuenta otra parada.
        stall();
        keeper.onNotification(frame(0x06, 0x01, 80));
        assertEquals(2, keeper.stalls());
    }

    // ───────────────────────────── silencio ─────────────────────────────

    @Test
    public void conLaWebParadaYElAnilloEnSilencioVuelveAPedirElPulso() {
        keeper.arm(START_HR);
        stall();
        keeper.tick();
        run();
        assertTrue("aún no ha pasado el silencio", written.isEmpty());
        now += RingKeeper.SILENCE_MS;
        keeper.tick();
        run();
        assertEquals(1, written.size());
        assertArrayEquals(START_HR, written.get(0));
        // No se repite en cada aviso: hasta que pase otro silencio entero.
        now += 2_000;
        keeper.tick();
        run();
        assertEquals(1, written.size());
        now += RingKeeper.SILENCE_MS;
        keeper.tick();
        run();
        assertEquals(2, written.size());
    }

    @Test
    public void unaLecturaDePulsoEvitaElSilencio() {
        keeper.arm(START_HR);
        stall();
        for (int i = 0; i < 6; i++) {
            now += RingKeeper.SILENCE_MS / 2;
            keeper.onNotification(frame(0x06, 0x01, 100));
            keeper.tick();
        }
        run();
        assertTrue("con lecturas llegando el sensor sigue encendido", written.isEmpty());
    }

    @Test
    public void conLaWebVivaElSilencioNoHaceNada() {
        keeper.arm(START_HR);
        for (int i = 0; i < 20; i++) {
            now += 5_000;
            keeper.ack();
            keeper.tick();
        }
        run();
        assertTrue(written.isEmpty());
    }

    // ───────────────────────────── escrituras ─────────────────────────────

    @Test
    public void siElBluetoothEstaOcupadoSeReintenta() {
        keeper.arm(START_HR);
        stall();
        busyFor = 2;
        keeper.onNotification(frame(0x04, 0x13, 0, 1, 80));
        run();
        assertEquals(1, written.size());
        assertEquals(1, keeper.writes());
        assertEquals(0, keeper.failedWrites());
    }

    @Test
    public void siNuncaPuedeEscribirSigueConLaSiguienteYLoCuenta() {
        keeper.arm(START_HR);
        stall();
        alwaysBusy = true;
        keeper.onNotification(frame(0x04, 0x0e, 0, 1));
        run();
        assertTrue(written.isEmpty());
        assertEquals(2, keeper.failedWrites());
        assertEquals(0, keeper.writes());
    }

    @Test
    public void alDesarmarSeCancelaLoPendiente() {
        keeper.arm(START_HR);
        stall();
        keeper.onNotification(frame(0x04, 0x0e, 0, 1));
        keeper.disarm();
        run();
        assertTrue(written.isEmpty());
        assertFalse(keeper.isArmed());
        assertFalse(keeper.onNotification(frame(0x04, 0x0e, 0, 1)).reflexed);
    }

    @Test
    public void alArmarDeNuevoEmpiezaDeCero() {
        keeper.arm(START_HR);
        keeper.onNotification(frame(0x06, 0x01, 70));
        keeper.onNotification(frame(0x06, 0x01, 71));
        assertEquals(2, keeper.lastSeq());
        keeper.arm(START_HR);
        assertEquals(0, keeper.lastSeq());
        assertEquals(1, keeper.onNotification(frame(0x06, 0x01, 72)).seq);
    }
}
