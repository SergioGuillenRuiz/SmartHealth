package app.smartring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** De los eventos de uso de Android a los tramos en que el móvil estuvo en uso no depende de Android: se prueba aquí, con un JDK normal. */
public class PhoneActivityTest {

    private static final long MIN = 60_000L;
    private static final long T0 = 1_700_000_000_000L;

    private static PhoneActivity.Event e(int type, long atMs) {
        return new PhoneActivity.Event(type, atMs);
    }

    private static List<PhoneActivity.Event> events(PhoneActivity.Event... items) {
        return new ArrayList<>(Arrays.asList(items));
    }

    private static void assertSpans(String expected, List<long[]> spans) {
        assertEquals(expected, PhoneActivity.format(spans));
    }

    @Test
    public void unaPantallaEncendidaConDesbloqueoOConMuchoRatoEsUso() {
        List<PhoneActivity.Event> list = events(
            e(PhoneActivity.SCREEN_ON, T0 + 10 * MIN), e(PhoneActivity.UNLOCK, T0 + 10 * MIN + 2_000), e(PhoneActivity.SCREEN_OFF, T0 + 12 * MIN),
            e(PhoneActivity.SCREEN_ON, T0 + 30 * MIN), e(PhoneActivity.SCREEN_OFF, T0 + 30 * MIN + 40_000)
        );
        List<long[]> uses = PhoneActivity.uses(list, T0, T0 + 60 * MIN, true);
        assertSpans((T0 + 10 * MIN) + ":" + (T0 + 12 * MIN) + ";" + (T0 + 30 * MIN) + ":" + (T0 + 30 * MIN + 40_000), uses);
    }

    @Test
    public void unAvisoQueEnciendeLaPantallaUnosSegundosNoEsUso() {
        // Una notificación enciende la pantalla 8 s a las 06:30: no es estar despierta.
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SCREEN_ON, T0 + 5 * MIN), e(PhoneActivity.SCREEN_OFF, T0 + 5 * MIN + 8_000));
        assertTrue(PhoneActivity.uses(list, T0, T0 + 60 * MIN, true).isEmpty());
    }

    @Test
    public void tocarLaPantallaCuentaAunqueSeaBreve() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SCREEN_ON, T0 + 5 * MIN), e(PhoneActivity.TOUCH, T0 + 5 * MIN + 3_000), e(PhoneActivity.SCREEN_OFF, T0 + 5 * MIN + 10_000));
        assertEquals(1, PhoneActivity.uses(list, T0, T0 + 60 * MIN, true).size());
    }

    @Test
    public void unaAppQueSeReanudaSolaAlEncenderLaPantallaNoEsUso() {
        // En un móvil sin bloqueo de pantalla, un aviso que enciende la pantalla 8 s reanuda la app de antes: la prueba en un Android real lo vio y contaba como uso.
        List<PhoneActivity.Event> list = events(
            e(PhoneActivity.SCREEN_ON, T0 + 5 * MIN), e(PhoneActivity.APP_ON, T0 + 5 * MIN + 300), e(PhoneActivity.APP_OFF, T0 + 5 * MIN + 7_800), e(PhoneActivity.SCREEN_OFF, T0 + 5 * MIN + 8_000)
        );
        assertTrue(PhoneActivity.uses(list, T0, T0 + 60 * MIN, true).isEmpty());
    }

    @Test
    public void unDesbloqueoSueltoSinPantallaEsMedioMinutoDeUso() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.UNLOCK, T0 + 20 * MIN));
        assertSpans((T0 + 20 * MIN) + ":" + (T0 + 20 * MIN + 30_000), PhoneActivity.uses(list, T0, T0 + 60 * MIN, true));
    }

    @Test
    public void losTramosCercanosSeUnen() {
        List<PhoneActivity.Event> list = events(
            e(PhoneActivity.SCREEN_ON, T0 + 10 * MIN), e(PhoneActivity.UNLOCK, T0 + 10 * MIN + 1_000), e(PhoneActivity.SCREEN_OFF, T0 + 11 * MIN),
            e(PhoneActivity.SCREEN_ON, T0 + 11 * MIN + 20_000), e(PhoneActivity.UNLOCK, T0 + 11 * MIN + 21_000), e(PhoneActivity.SCREEN_OFF, T0 + 13 * MIN)
        );
        assertSpans((T0 + 10 * MIN) + ":" + (T0 + 13 * MIN), PhoneActivity.uses(list, T0, T0 + 60 * MIN, true));
    }

    @Test
    public void siLaLecturaEmpiezaConLaPantallaEncendidaSeSuponeQueLlevabaPoco() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SCREEN_OFF, T0 + 20 * MIN));
        assertSpans((T0 + 15 * MIN) + ":" + (T0 + 20 * MIN), PhoneActivity.uses(list, T0, T0 + 60 * MIN, true));
    }

    @Test
    public void unUsoEnMarchaAlFinalSeCierraEnLaHoraDeLectura() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SCREEN_ON, T0 + 50 * MIN), e(PhoneActivity.UNLOCK, T0 + 50 * MIN + 1_000));
        assertSpans((T0 + 50 * MIN) + ":" + (T0 + 60 * MIN), PhoneActivity.uses(list, T0, T0 + 60 * MIN, true));
    }

    @Test
    public void sinEventosDePantallaSeUsanLasAppsDelante() {
        List<PhoneActivity.Event> list = events(
            e(PhoneActivity.APP_ON, T0 + 10 * MIN), e(PhoneActivity.APP_ON, T0 + 11 * MIN), e(PhoneActivity.APP_OFF, T0 + 11 * MIN + 5_000), e(PhoneActivity.APP_OFF, T0 + 13 * MIN)
        );
        assertSpans((T0 + 10 * MIN) + ":" + (T0 + 13 * MIN), PhoneActivity.uses(list, T0, T0 + 60 * MIN, false));
    }

    @Test
    public void losEventosFueraDeLoPedidoNoCuentan() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SCREEN_ON, T0 - 5 * MIN), e(PhoneActivity.UNLOCK, T0 - 5 * MIN + 100), e(PhoneActivity.SCREEN_OFF, T0 - 3 * MIN));
        assertTrue(PhoneActivity.uses(list, T0, T0 + 60 * MIN, true).isEmpty());
    }

    @Test
    public void losApagadosVanDelApagadoAlSiguienteArranque() {
        List<PhoneActivity.Event> list = events(e(PhoneActivity.SHUTDOWN, T0 + 10 * MIN), e(PhoneActivity.STARTUP, T0 + 400 * MIN), e(PhoneActivity.SHUTDOWN, T0 + 500 * MIN));
        assertSpans((T0 + 10 * MIN) + ":" + (T0 + 400 * MIN) + ";" + (T0 + 500 * MIN) + ":" + (T0 + 600 * MIN), PhoneActivity.offs(list, T0 + 600 * MIN));
    }

    @Test
    public void elTextoDeTramosVaYViene() {
        List<long[]> spans = PhoneActivity.parse("1000:2000;5000:5500");
        assertEquals("1000:2000;5000:5500", PhoneActivity.format(spans));
        assertTrue(PhoneActivity.parse("").isEmpty());
        assertTrue(PhoneActivity.parse(null).isEmpty());
        assertEquals(1, PhoneActivity.parse("basura;5:;:7;100:50;abc:def;10:20").size());
    }

    @Test
    public void recortarYUnirTramos() {
        List<long[]> spans = new ArrayList<>();
        spans.add(new long[] { 100, 200 });
        spans.add(new long[] { 150, 400 });
        spans.add(new long[] { 1000, 1100 });
        assertEquals("100:400;1000:1100", PhoneActivity.format(PhoneActivity.merge(spans, 0L)));
        assertEquals("100:1100", PhoneActivity.format(PhoneActivity.merge(spans, 700L)));
        assertEquals("250:400;1000:1050", PhoneActivity.format(PhoneActivity.clip(PhoneActivity.merge(spans, 0L), 250L, 1050L)));
    }
}
