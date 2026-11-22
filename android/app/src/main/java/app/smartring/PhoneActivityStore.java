package app.smartring;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;

/**
 * Lo que la lectura periódica en segundo plano ({@link PhoneActivityJob}) va guardando del uso del móvil, para que no se pierda si Android olvida sus eventos (guarda unos días) y la app no
 * se abre. Solo tramos de horas, en las preferencias privadas de la app. La web lo recoge al abrirse ({@code readPhoneActivity}) y lo guarda en su propia base.
 */
final class PhoneActivityStore {

    private static final String PREFS = "phone_activity";
    private static final String KEY_USES = "uses";
    private static final String KEY_OFFS = "offs";
    private static final String KEY_LAST_READ = "lastReadMs";
    private static final String KEY_COVER_FROM = "coverFromMs";
    /** Los tramos guardados no pasan de aquí (la web ya guarda los suyos más tiempo). */
    static final long KEEP_MS = 14L * 24 * 3_600_000;
    /** Si la última lectura es de hace más que esto, el sistema ya habrá olvidado lo que hay entre medias: la cobertura empieza de nuevo. */
    static final long MAX_GAP_MS = 6L * 24 * 3_600_000;
    /** Lo que se vuelve a leer de lo ya leído (una lectura pudo cortar un uso en marcha). */
    static final long OVERLAP_MS = 15L * 60_000;

    private PhoneActivityStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Lee lo que falta desde la última lectura y lo suma a lo guardado. Sin acceso no hace nada. */
    static void sample(Context context, long nowMs) {
        SharedPreferences prefs = prefs(context);
        long last = prefs.getLong(KEY_LAST_READ, 0L);
        boolean contiguous = last > 0 && nowMs - last < MAX_GAP_MS;
        long from = contiguous ? last - OVERLAP_MS : nowMs - MAX_GAP_MS;
        PhoneActivityReader.Result result = PhoneActivityReader.read(context, from, nowMs);
        if (!result.granted) {
            return;
        }
        long cutoff = nowMs - KEEP_MS;
        List<long[]> uses = PhoneActivity.parse(prefs.getString(KEY_USES, ""));
        uses.addAll(result.uses);
        List<long[]> offs = PhoneActivity.parse(prefs.getString(KEY_OFFS, ""));
        offs.addAll(result.offs);
        long coverFrom = contiguous ? prefs.getLong(KEY_COVER_FROM, 0L) : 0L;
        if (coverFrom == 0L) {
            coverFrom = result.firstMs;
        }
        prefs
            .edit()
            .putString(KEY_USES, PhoneActivity.format(PhoneActivity.clip(PhoneActivity.merge(uses, PhoneActivity.MERGE_GAP_MS), cutoff, nowMs)))
            .putString(KEY_OFFS, PhoneActivity.format(PhoneActivity.clip(PhoneActivity.merge(offs, 0L), cutoff, nowMs)))
            .putLong(KEY_LAST_READ, nowMs)
            .putLong(KEY_COVER_FROM, coverFrom)
            .apply();
    }

    /** Lo guardado por la lectura de fondo: tramos de uso, apagados y desde cuándo hay lectura continua (0: nada). */
    static final class Saved {
        final List<long[]> uses;
        final List<long[]> offs;
        final long coverFromMs;
        final long lastReadMs;

        Saved(List<long[]> uses, List<long[]> offs, long coverFromMs, long lastReadMs) {
            this.uses = uses;
            this.offs = offs;
            this.coverFromMs = coverFromMs;
            this.lastReadMs = lastReadMs;
        }
    }

    static Saved saved(Context context) {
        SharedPreferences prefs = prefs(context);
        return new Saved(
            PhoneActivity.parse(prefs.getString(KEY_USES, "")),
            PhoneActivity.parse(prefs.getString(KEY_OFFS, "")),
            prefs.getLong(KEY_COVER_FROM, 0L),
            prefs.getLong(KEY_LAST_READ, 0L)
        );
    }

    /** Lo que se junta de lo guardado y de una lectura nueva, para devolver a la web. */
    static List<long[]> union(List<long[]> a, List<long[]> b, long gapMs) {
        List<long[]> all = new ArrayList<>(a);
        all.addAll(b);
        return PhoneActivity.merge(all, gapMs);
    }
}
