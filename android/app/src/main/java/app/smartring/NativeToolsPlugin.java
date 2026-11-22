package app.smartring;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.provider.MediaStore;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;
import java.nio.charset.StandardCharsets;

/**
 * Lo que la app necesita de Android y no existe en la web: guardar y compartir un fichero de la carpeta pública Descargas
 * (para la prueba guiada), mantener la pantalla encendida (entrenos y prueba) y pedir de una vez los permisos de Bluetooth.
 */
@CapacitorPlugin(
    name = "NativeTools",
    permissions = {
        @Permission(alias = "nearby", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT" }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class NativeToolsPlugin extends Plugin {

    /**
     * Pide los permisos para buscar y conectar por Bluetooth en una sola petición: «Dispositivos cercanos» (desde Android 12)
     * y la ubicación precisa JUNTO con la aproximada. El plugin de Bluetooth pide la precisa sola y, desde Android 12, el
     * sistema ignora una petición de ubicación precisa sin la aproximada (el cuadro de ubicación no llega a salir). Si ya
     * están concedidos no vuelve a preguntar. Devuelve cómo quedan.
     */
    @PluginMethod
    public void requestBlePermissions(PluginCall call) {
        String[] aliases = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new String[] { "nearby", "location" } : new String[] { "location" };
        requestPermissionForAliases(aliases, call, "blePermissionsResult");
    }

    @PermissionCallback
    private void blePermissionsResult(PluginCall call) {
        call.resolve(permissionState());
    }

    /** Cómo están ahora los permisos de Bluetooth y ubicación, para el diagnóstico. */
    @PluginMethod
    public void permissionStatus(PluginCall call) {
        call.resolve(permissionState());
    }

    private JSObject permissionState() {
        JSObject out = new JSObject();
        out.put("sdk", Build.VERSION.SDK_INT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            out.put("bluetoothScan", granted("android.permission.BLUETOOTH_SCAN"));
            out.put("bluetoothConnect", granted("android.permission.BLUETOOTH_CONNECT"));
        }
        out.put("fineLocation", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        out.put("coarseLocation", granted(Manifest.permission.ACCESS_COARSE_LOCATION));
        return out;
    }

    private boolean granted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ───────────────────────── el uso del móvil (para estimar el sueño sin anillo) ─────────────────────────

    /** ¿Ofrece este Android el acceso a los datos de uso y lo ha dado la persona? */
    @PluginMethod
    public void phoneActivityStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP);
        out.put("granted", PhoneActivityReader.granted(getContext()));
        out.put("screenEvents", PhoneActivityReader.screenEvents());
        call.resolve(out);
    }

    /** Abre los ajustes de Android donde se da a esta app el acceso a los datos de uso (en versiones nuevas, directamente en su fila). */
    @PluginMethod
    public void openPhoneActivitySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (RuntimeException second) {
                call.reject("No se pudieron abrir los ajustes de acceso a los datos de uso.", second);
            }
        }
    }

    /**
     * El uso del móvil desde «sinceMs» hasta ahora: lo que lee de Android en este momento junto con lo que guardó la lectura horaria de fondo. Solo horas: «uses» son los tramos con el móvil en uso,
     * «offs» los ratos apagado y «firstMs» desde cuándo se sabe todo (antes no se dice nada). Sin acceso, «granted: false».
     */
    @PluginMethod
    public void readPhoneActivity(PluginCall call) {
        long now = System.currentTimeMillis();
        long since = call.getLong("sinceMs", now - 24L * 3_600_000);
        if (since <= 0 || since > now) {
            since = now - 24L * 3_600_000;
        }
        PhoneActivityReader.Result live = PhoneActivityReader.read(getContext(), since, now);
        JSObject out = new JSObject();
        out.put("granted", live.granted);
        out.put("fromMs", since);
        out.put("toMs", now);
        if (!live.granted) {
            out.put("firstMs", 0);
            out.put("uses", "");
            out.put("offs", "");
            call.resolve(out);
            return;
        }
        PhoneActivityStore.Saved saved = PhoneActivityStore.saved(getContext());
        List<long[]> uses = PhoneActivityStore.union(PhoneActivity.clip(saved.uses, since, now), live.uses, PhoneActivity.MERGE_GAP_MS);
        List<long[]> offs = PhoneActivityStore.union(PhoneActivity.clip(saved.offs, since, now), live.offs, 0L);
        // Con lectura de fondo continua hasta ahora, se sabe desde que esta empezó; si no, desde el primer evento que Android aún conserva.
        long first = live.firstMs;
        if (saved.coverFromMs > 0 && saved.lastReadMs > 0 && saved.lastReadMs >= since - PhoneActivityStore.OVERLAP_MS) {
            first = first > 0 ? Math.min(first, saved.coverFromMs) : saved.coverFromMs;
        }
        out.put("firstMs", first);
        out.put("uses", PhoneActivity.format(uses));
        out.put("offs", PhoneActivity.format(offs));
        call.resolve(out);
    }

    /** Programa la lectura horaria en segundo plano (si no lo estaba ya). */
    @PluginMethod
    public void schedulePhoneActivity(PluginCall call) {
        try {
            PhoneActivityJob.schedule(getContext());
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("No se pudo programar la lectura del uso del móvil.", e);
        }
    }

    /**
     * Guarda un texto como fichero en Descargas. Desde Android 10 se hace con MediaStore, que no pide ningún permiso; en
     * versiones anteriores se rechaza con el código LEGACY_STORAGE y la app usa el menú de compartir.
     *
     * Si llega «uri» (la de un guardado anterior de este mismo fichero) se reescribe en el sitio: la prueba guiada va
     * guardando lo que lleva y deja un único fichero. Si ya no existe (la persona lo borró), se crea uno nuevo.
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = FileSafety.safeFileName(call.getString("filename"));
        String text = call.getString("text");
        String mime = FileSafety.safeMime(call.getString("mime", "text/plain"));
        if (filename == null || text == null) {
            call.reject("Faltan el nombre o el contenido del fichero.");
            return;
        }
        if (text.length() > FileSafety.MAX_FILE_CHARS) {
            call.reject("El fichero es demasiado grande.");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Esta versión de Android no permite guardar en Descargas sin permisos.", "LEGACY_STORAGE");
            return;
        }
        try {
            ContentResolver resolver = getContext().getContentResolver();
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            Uri uri = rewrite(resolver, call.getString("uri"), bytes);
            if (uri == null) {
                uri = create(resolver, filename, mime, bytes);
            }
            call.resolve(describe(resolver, uri, filename));
        } catch (Exception e) {
            call.reject("No se pudo guardar el fichero: " + e.getMessage(), e);
        }
    }

    private boolean isDownloadsUri(Uri uri) {
        return FileSafety.isDownloadsPath(uri.getAuthority(), uri.getPathSegments());
    }

    /** Reescribe un fichero de Descargas creado antes por la app. Devuelve null si no se puede (no existe, no es nuestro…). */
    private Uri rewrite(ContentResolver resolver, String previous, byte[] bytes) {
        if (previous == null) {
            return null;
        }
        try {
            Uri uri = Uri.parse(previous);
            // Solo se reescribe lo que es de Descargas: la dirección viene de la web y no debe apuntar a otro proveedor.
            if (!isDownloadsUri(uri)) {
                return null;
            }
            // «wt»: escribir y vaciar antes (si no, un texto más corto dejaría el final del anterior).
            try (OutputStream out = resolver.openOutputStream(uri, "wt")) {
                if (out == null) {
                    return null;
                }
                out.write(bytes);
            }
            return uri;
        } catch (Exception e) {
            return null;
        }
    }

    private Uri create(ContentResolver resolver, String filename, String mime, byte[] bytes) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("El sistema no ha creado el fichero.");
        }
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) {
                throw new IOException("No se pudo abrir el fichero para escribir.");
            }
            out.write(bytes);
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        return uri;
    }

    /** Dónde ha quedado: si ya había un fichero con ese nombre, el sistema le añade «(1)» y se devuelve el nombre real. */
    private JSObject describe(ContentResolver resolver, Uri uri, String fallbackName) {
        String name = fallbackName;
        try (Cursor cursor = resolver.query(uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                name = cursor.getString(0);
            }
        }
        JSObject result = new JSObject();
        result.put("uri", uri.toString());
        result.put("location", Environment.DIRECTORY_DOWNLOADS + "/" + name);
        return result;
    }

    /**
     * Abre el menú de compartir de Android con un fichero (por la «uri» que devolvió saveToDownloads) o con un texto. La
     * app elegida recibe permiso de lectura solo para ese fichero.
     */
    @PluginMethod
    public void share(PluginCall call) {
        String uriText = call.getString("uri");
        String text = call.getString("text");
        String title = call.getString("title", "Enviar");
        if (uriText == null && text == null) {
            call.reject("No hay nada que compartir.");
            return;
        }
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            if (uriText != null) {
                Uri uri = Uri.parse(uriText);
                if (!isDownloadsUri(uri)) {
                    call.reject("Solo se pueden compartir ficheros de Descargas.");
                    return;
                }
                send.setType(FileSafety.safeMime(call.getString("mime", "text/plain")));
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
            }
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            getActivity().startActivity(Intent.createChooser(send, title));
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir el menú de compartir: " + e.getMessage(), e);
        }
    }

    /** Mantiene la pantalla encendida mientras la app está delante (o deja de hacerlo). */
    @PluginMethod
    public void keepScreenOn(final PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        getActivity()
            .runOnUiThread(
                () -> {
                    if (enabled) {
                        getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                    call.resolve();
                }
            );
    }
}
