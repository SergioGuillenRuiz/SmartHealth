package app.smartring;

import java.util.List;

/**
 * Lo que se comprueba de lo que llega de la web antes de tocar ficheros (lógica pura, sin Android, para poder probarla con JUnit). La web es código propio y la política de contenido no deja
 * cargar nada de fuera, pero un fallo en otra parte no debería convertirse en escribir donde no toca.
 */
final class FileSafety {

    private FileSafety() {}

    /** Lo más que se guarda de una vez (en caracteres): una copia de un año con el anillo son unos pocos MB. */
    static final int MAX_FILE_CHARS = 80 * 1024 * 1024;

    /**
     * El nombre de un fichero que llega de la web, limpio: sin rutas ni caracteres de control o reservados, sin puntos al principio (nada de «..» ni de ficheros ocultos) y de longitud razonable.
     * {@code null} si no queda nada. Android también lo sanea, pero una operación de ficheros no se fía de lo que haga el sistema con un nombre que viene de fuera.
     */
    static String safeFileName(String name) {
        if (name == null) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < name.length() && out.length() < 100; i++) {
            char c = name.charAt(i);
            boolean bad = c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|';
            out.append(bad ? '_' : c);
        }
        String cleaned = out.toString().trim();
        while (cleaned.startsWith(".")) {
            cleaned = cleaned.substring(1);
        }
        return cleaned.isEmpty() ? null : cleaned;
    }

    /** Solo los tipos que la app guarda (texto y JSON); cualquier otro se guarda como texto plano. */
    static String safeMime(String mime) {
        return "application/json".equals(mime) ? "application/json" : "text/plain";
    }

    /**
     * ¿Es la dirección de un fichero de la colección Descargas de MediaStore? Con la forma exacta {@code content://media/<volumen>/downloads/<id>}: antes bastaba con que la palabra «downloads»
     * saliera en cualquier punto de la ruta.
     */
    static boolean isDownloadsPath(String authority, List<String> segments) {
        return "media".equals(authority) && segments != null && segments.size() == 3 && "downloads".equals(segments.get(1)) && segments.get(2).matches("[0-9]{1,18}");
    }
}
