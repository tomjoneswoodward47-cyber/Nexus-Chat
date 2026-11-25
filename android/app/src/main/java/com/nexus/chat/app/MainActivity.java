package com.nexus.chat.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallAudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
