package app.smartring;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins propios se registran antes de que arranque el puente.
        registerPlugin(NativeToolsPlugin.class);
        registerPlugin(TrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
