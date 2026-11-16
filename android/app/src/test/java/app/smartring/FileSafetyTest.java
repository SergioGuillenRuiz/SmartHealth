package app.smartring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

public class FileSafetyTest {

    @Test
    public void unNombreNormalSeQueda() {
        assertEquals("smarthealth-copia-2026-11-05.json", FileSafety.safeFileName("smarthealth-copia-2026-11-05.json"));
    }

    @Test
    public void lasRutasYLosPuntosDelPrincipioNoPasan() {
        assertEquals("_etc_passwd", FileSafety.safeFileName("../etc/passwd"));
        assertFalse(FileSafety.safeFileName("../../x.txt").contains("/"));
        assertFalse(FileSafety.safeFileName("../../x.txt").startsWith("."));
        assertEquals("oculto.txt", FileSafety.safeFileName(".oculto.txt"));
        assertEquals("a_b.txt", FileSafety.safeFileName("a\\b.txt"));
    }

    @Test
    public void controlYReservadosSeCambian() {
        assertEquals("a_b_c.txt", FileSafety.safeFileName("a\u0000b\nc.txt"));
        assertEquals("a_b_c_d.txt", FileSafety.safeFileName("a:b*c?d.txt"));
    }

    @Test
    public void sinNadaQueGuardarEsNulo() {
        assertNull(FileSafety.safeFileName(null));
        assertNull(FileSafety.safeFileName(""));
        assertNull(FileSafety.safeFileName("...."));
        assertNull(FileSafety.safeFileName("   "));
    }

    @Test
    public void laLongitudTieneTope() {
        StringBuilder long200 = new StringBuilder();
        for (int i = 0; i < 200; i++) {
            long200.append('a');
        }
        assertEquals(100, FileSafety.safeFileName(long200.toString()).length());
    }

    @Test
    public void soloSeGuardaTextoOJson() {
        assertEquals("application/json", FileSafety.safeMime("application/json"));
        assertEquals("text/plain", FileSafety.safeMime("text/plain"));
        assertEquals("text/plain", FileSafety.safeMime("application/vnd.android.package-archive"));
        assertEquals("text/plain", FileSafety.safeMime(null));
    }

    @Test
    public void soloLaFormaExactaDeDescargasVale() {
        assertTrue(FileSafety.isDownloadsPath("media", Arrays.asList("external", "downloads", "123")));
        assertTrue(FileSafety.isDownloadsPath("media", Arrays.asList("external_primary", "downloads", "9")));
        // La palabra «downloads» en otro sitio de la ruta, otro proveedor, ids raros o rutas más largas no valen.
        assertFalse(FileSafety.isDownloadsPath("media", Arrays.asList("external", "images", "downloads")));
        assertFalse(FileSafety.isDownloadsPath("media", Arrays.asList("external", "downloads")));
        assertFalse(FileSafety.isDownloadsPath("media", Arrays.asList("external", "downloads", "1", "extra")));
        assertFalse(FileSafety.isDownloadsPath("media", Arrays.asList("external", "downloads", "abc")));
        assertFalse(FileSafety.isDownloadsPath("media", Arrays.asList("external", "downloads", "../1")));
        assertFalse(FileSafety.isDownloadsPath("com.otra.app.provider", Arrays.asList("external", "downloads", "1")));
        assertFalse(FileSafety.isDownloadsPath(null, Arrays.asList("external", "downloads", "1")));
        assertFalse(FileSafety.isDownloadsPath("media", null));
    }
}
