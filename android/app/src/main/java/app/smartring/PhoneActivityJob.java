package app.smartring;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;

/**
 * La lectura del uso del móvil en segundo plano, una vez por hora: un trabajo del sistema (sin servicio permanente ni notificación) que tarda milisegundos y deja el resultado en
 * {@link PhoneActivityStore}. Así lo del móvil no se pierde aunque pasen días sin abrir la app. Android decide cuándo lo ejecuta (con la batería baja lo aplaza).
 */
public class PhoneActivityJob extends JobService {

    private static final int JOB_ID = 5701;
    private static final long PERIOD_MS = 60L * 60_000;

    /** Programa el trabajo si aún no lo está (no se reinicia su reloj cada vez que se abre la app). */
    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) {
            return;
        }
        JobInfo.Builder builder = new JobInfo.Builder(JOB_ID, new ComponentName(context, PhoneActivityJob.class)).setPeriodic(PERIOD_MS).setPersisted(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // «Batería no baja» existe desde Android 8: antes, el trabajo corre con el criterio normal del sistema.
            builder.setRequiresBatteryNotLow(true);
        }
        scheduler.schedule(builder.build());
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context context = getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    PhoneActivityStore.sample(context, System.currentTimeMillis());
                } catch (RuntimeException e) {
                    // Sin acceso o con un fallo del sistema: la próxima lectura lo intenta de nuevo.
                } finally {
                    jobFinished(params, false);
                }
            }
        }, "phone-activity").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
