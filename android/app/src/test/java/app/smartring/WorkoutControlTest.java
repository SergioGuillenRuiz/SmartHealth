package app.smartring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

/** La cola de órdenes de la notificación del entreno y la cuenta de su cronómetro no dependen de Android: se prueban aquí, con un JDK normal. */
public class WorkoutControlTest {

    @Test
    public void lasOrdenesSeAnotanEnOrdenConSuHora() {
        String queue = WorkoutControl.append("", WorkoutControl.PAUSE, 1000L);
        queue = WorkoutControl.append(queue, WorkoutControl.RESUME, 2000L);
        assertEquals("pause:1000;resume:2000", queue);
        List<WorkoutControl.Entry> entries = WorkoutControl.parse(queue);
        assertEquals(2, entries.size());
        assertEquals("pause", entries.get(0).action);
        assertEquals(1000L, entries.get(0).atMs);
        assertEquals("resume", entries.get(1).action);
        assertEquals(2000L, entries.get(1).atMs);
        assertEquals(2, WorkoutControl.count(queue));
    }

    @Test
    public void tras_una_parada_no_se_admite_nada_mas() {
        String queue = WorkoutControl.append("", WorkoutControl.PAUSE, 1000L);
        queue = WorkoutControl.append(queue, WorkoutControl.STOP, 3000L);
        assertTrue(WorkoutControl.hasStop(queue));
        assertEquals(queue, WorkoutControl.append(queue, WorkoutControl.PAUSE, 4000L));
        assertEquals(queue, WorkoutControl.append(queue, WorkoutControl.STOP, 5000L));
    }

    @Test
    public void unaOrdenDesconocidaOSinHoraSeIgnora() {
        assertEquals("", WorkoutControl.append("", "otra", 5L));
        assertEquals("", WorkoutControl.append("", WorkoutControl.PAUSE, 0L));
        assertEquals("", WorkoutControl.append("", WorkoutControl.PAUSE, -4L));
        assertEquals("", WorkoutControl.append(null, null, 7L));
    }

    @Test
    public void unaColaRotaNoTumbaNada() {
        assertEquals(1, WorkoutControl.parse("pause:abc;resume:5;;x:1;stop;:9;resume:").size());
        assertEquals(0, WorkoutControl.parse(null).size());
        assertEquals(0, WorkoutControl.parse("").size());
        assertFalse(WorkoutControl.hasStop("pause:1"));
    }

    @Test
    public void conMasDe32OrdenesSeOlvidaLaMasAntigua() {
        String queue = "";
        for (int i = 1; i <= 40; i++) {
            queue = WorkoutControl.append(queue, i % 2 == 0 ? WorkoutControl.RESUME : WorkoutControl.PAUSE, i);
        }
        List<WorkoutControl.Entry> entries = WorkoutControl.parse(queue);
        assertEquals(32, entries.size());
        assertEquals(9L, entries.get(0).atMs);
        assertEquals(40L, entries.get(31).atMs);
    }

    @Test
    public void elCronometroDeLaNotificacionCuentaElTiempoActivo() {
        assertEquals(1500L, WorkoutControl.chronometerBase(1000L, 500L));
        assertEquals(1000L, WorkoutControl.chronometerBase(1000L, 0L));
        assertEquals(1000L, WorkoutControl.chronometerBase(1000L, -5L));
    }

    @Test
    public void pausarYReanudarSumanElTiempoPausado() {
        WorkoutControl.PauseState state = WorkoutControl.applyPause(0L, 0L, true, 100L);
        assertTrue(state.changed);
        assertEquals(100L, state.since);
        state = WorkoutControl.applyPause(state.since, state.total, false, 400L);
        assertTrue(state.changed);
        assertEquals(0L, state.since);
        assertEquals(300L, state.total);
        // Otra pausa suma a la anterior.
        state = WorkoutControl.applyPause(state.since, state.total, true, 1000L);
        state = WorkoutControl.applyPause(state.since, state.total, false, 1250L);
        assertEquals(550L, state.total);
    }

    @Test
    public void pausarDosVecesOReanudarSinPausaNoCambiaNada() {
        WorkoutControl.PauseState paused = WorkoutControl.applyPause(0L, 0L, true, 100L);
        WorkoutControl.PauseState again = WorkoutControl.applyPause(paused.since, paused.total, true, 150L);
        assertFalse(again.changed);
        assertEquals(100L, again.since);
        WorkoutControl.PauseState noPause = WorkoutControl.applyPause(0L, 300L, false, 500L);
        assertFalse(noPause.changed);
        assertEquals(300L, noPause.total);
    }

    @Test
    public void unaHoraAnteriorALaPausaNoRestaTiempo() {
        WorkoutControl.PauseState state = WorkoutControl.applyPause(0L, 300L, true, 600L);
        state = WorkoutControl.applyPause(state.since, state.total, false, 500L);
        assertEquals(300L, state.total);
    }
}
