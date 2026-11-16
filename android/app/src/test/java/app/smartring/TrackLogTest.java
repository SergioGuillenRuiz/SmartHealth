package app.smartring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** La pista de un entreno no depende de Android: se prueba aquí, con un JDK normal. */
public class TrackLogTest {

    private File dir;

    @Before
    public void setUp() throws IOException {
        dir = java.nio.file.Files.createTempDirectory("tracklog").toFile();
    }

    @After
    public void tearDown() {
        TrackLog.delete(dir, "w-1");
        TrackLog.delete(dir, "w-2");
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        //noinspection ResultOfMethodCallIgnored
        dir.delete();
    }

    private static void add(TrackLog log, int n) {
        log.append(1_000L * n, 40.0 + n / 1e5, -3.0, 5.0, 1.3, 650.0, 8.0, 1013.25 - n / 10.0);
    }

    @Test
    public void numbersFixesFromOneAndDeliversTheOnesAfterANumber() {
        TrackLog log = TrackLog.open(dir, "w-1");
        for (int n = 1; n <= 5; n++) add(log, n);
        assertEquals(5, log.lastSeq());
        assertEquals(5_000L, log.lastTsMs());
        List<TrackLog.Fix> after2 = log.since(2, 100);
        assertEquals(3, after2.size());
        assertEquals(3, after2.get(0).seq);
        assertEquals(5, after2.get(2).seq);
        assertEquals(1_000L * 3, after2.get(0).tsMs, 0);
        assertTrue(log.since(5, 100).isEmpty());
        assertTrue(log.since(99, 100).isEmpty());
        assertEquals(2, log.since(0, 2).size());
    }

    @Test
    public void theSameSessionIsTheSameInstanceAndOtherSessionsAreIndependent() {
        TrackLog a = TrackLog.open(dir, "w-1");
        assertSame(a, TrackLog.open(dir, "w-1"));
        TrackLog b = TrackLog.open(dir, "w-2");
        assertNotSame(a, b);
        add(a, 1);
        assertEquals(0, b.lastSeq());
    }

    @Test
    public void whatWasWrittenSurvivesTheProcessDyingAndIsRenumberedInOrder() throws IOException {
        TrackLog log = TrackLog.open(dir, "w-1");
        for (int n = 1; n <= 4; n++) add(log, n);
        log.close();
        // El proceso muere: la siguiente apertura (otra instancia, que lee el fichero) ve lo mismo.
        TrackLog.delete(dir, "w-other"); // no hace nada con lo ajeno
        File file = new File(dir, TrackLog.fileName("w-1"));
        assertTrue(file.exists());
        TrackLog.forgetOpenInstancesForTests();
        TrackLog reopened = TrackLog.open(dir, "w-1");
        assertEquals(4, reopened.lastSeq());
        assertEquals(4_000L, reopened.lastTsMs());
        assertEquals(40.0 + 3 / 1e5, reopened.since(2, 10).get(0).lat, 1e-12);
        // Y sigue donde se quedó.
        add(reopened, 5);
        assertEquals(5, reopened.lastSeq());
    }

    @Test
    public void aBrokenLineIsSkippedWithoutBreakingTheNumbering() throws IOException {
        File file = new File(dir, TrackLog.fileName("w-1"));
        try (FileWriter w = new FileWriter(file)) {
            w.write("1,1000,40.0,-3.0,5.0,1.3,650.0,8.0\n");
            w.write("esto no es una posición\n");
            w.write("3,3000,40.1,-3.0,5.0,NaN,NaN,NaN\n");
            w.write("4,4000,40.2\n"); // incompleta
        }
        TrackLog log = TrackLog.open(dir, "w-1");
        // Se renumera por orden: lo roto no deja un hueco ni descuadra «las posteriores a la N».
        assertEquals(2, log.lastSeq());
        TrackLog.Fix second = log.since(1, 10).get(0);
        assertEquals(2, second.seq);
        assertEquals(3_000L, second.tsMs);
        assertTrue(Double.isNaN(second.speedMs));
    }

    @Test
    public void sessionIdsCannotEscapeTheFolder() {
        String name = TrackLog.fileName("../../etc/passwd");
        assertFalse(name.contains("/"));
        assertFalse(name.contains(".."));
        assertTrue(name.startsWith("track-") && name.endsWith(".csv"));
        assertTrue(TrackLog.fileName("x".repeat(500)).length() < 100);
    }

    @Test
    public void deleteRemovesMemoryAndFile() {
        TrackLog log = TrackLog.open(dir, "w-1");
        add(log, 1);
        File file = new File(dir, TrackLog.fileName("w-1"));
        assertTrue(file.exists());
        TrackLog.delete(dir, "w-1");
        assertFalse(file.exists());
        assertEquals(0, TrackLog.open(dir, "w-1").lastSeq());
    }

    @Test
    public void staleTracksAreSweptButTheOpenOneAndRecentOnesStay() throws IOException {
        TrackLog open = TrackLog.open(dir, "w-1");
        add(open, 1);
        File stale = new File(dir, TrackLog.fileName("w-old"));
        File recent = new File(dir, TrackLog.fileName("w-recent"));
        File other = new File(dir, "otra-cosa.txt");
        for (File f : new File[] { stale, recent, other }) {
            assertTrue(f.createNewFile());
        }
        long now = System.currentTimeMillis();
        assertTrue(stale.setLastModified(now - 10L * 24 * 3600 * 1000));
        assertTrue(other.setLastModified(now - 10L * 24 * 3600 * 1000));
        TrackLog.deleteOlderThan(dir, 7L * 24 * 3600 * 1000, now);
        assertFalse(stale.exists());
        assertTrue(recent.exists());
        assertTrue(other.exists()); // solo toca las pistas
        assertTrue(new File(dir, TrackLog.fileName("w-1")).exists());
    }

    @Test
    public void aFixWithoutAltitudeOrSpeedRoundTrips() {
        TrackLog log = TrackLog.open(dir, "w-1");
        TrackLog.Fix fix = log.append(5_000L, 40.5, -3.5, 12.0, Double.NaN, Double.NaN, Double.NaN, Double.NaN);
        assertNotNull(fix);
        TrackLog.Fix parsed = TrackLog.Fix.parse(fix.toLine(), 1);
        assertNotNull(parsed);
        assertTrue(Double.isNaN(parsed.speedMs));
        assertTrue(Double.isNaN(parsed.pressureHpa));
        assertEquals(12.0, parsed.accuracyM, 0);
        assertNull(TrackLog.Fix.parse("1,2,3", 1));
    }

    @Test
    public void pressureRoundTripsAndOldEightColumnLinesStillLoad() throws IOException {
        TrackLog.Fix fix = new TrackLog.Fix(1, 1000L, 40.0, -3.0, 5.0, 1.3, 650.0, 8.0, 1008.5);
        TrackLog.Fix parsed = TrackLog.Fix.parse(fix.toLine(), 1);
        assertNotNull(parsed);
        assertEquals(1008.5, parsed.pressureHpa, 0);
        TrackLog.Fix old = TrackLog.Fix.parse("1,1000,40.0,-3.0,5.0,1.3,650.0,8.0", 1);
        assertNotNull(old);
        assertTrue(Double.isNaN(old.pressureHpa));
    }
}
