package app.smartring;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginResult;

/**
 * Una llamada a otro plugin de Capacitor hecha desde el lado nativo, sin WebView: lo que el plugin «responde» no va a ninguna web sino a
 * este objeto. Sirve para pedirle al plugin de Bluetooth que escriba al anillo y para oír sus avisos sin pasar por el WebView.
 *
 * Como una llamada que viene de la web, pero sin mensajería: nada de lo que el plugin conteste intenta salir hacia un WebView.
 */
final class NativeCall extends PluginCall {

    /** Lo que se hace con un evento del plugin (la llamada de un oyente se «responde» una vez por evento). */
    interface Listener {
        void onEvent(JSObject data);
    }

    private final Listener listener;
    private volatile String error;
    private volatile boolean resolved;

    NativeCall(String pluginId, String method, JSObject data, Listener listener) {
        super(null, pluginId, "-1", method, data);
        this.listener = listener;
    }

    /** El motivo del rechazo, o {@code null} si no ha habido ninguno (hasta ahora). */
    String error() {
        return error;
    }

    boolean isResolved() {
        return resolved;
    }

    @Override
    public void resolve(JSObject data) {
        resolved = true;
        if (listener != null) {
            listener.onEvent(data);
        }
    }

    @Override
    public void resolve() {
        resolved = true;
    }

    @Override
    public void successCallback(PluginResult successResult) {
        resolved = true;
    }

    @Override
    public void errorCallback(String msg) {
        error = msg == null ? "error" : msg;
    }

    @Override
    public void reject(String msg, String code, Exception ex, JSObject data) {
        error = msg == null ? "error" : msg;
    }
}
