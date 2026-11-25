package com.nexus.chat.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CallAudioRoute")
public class CallAudioRoutePlugin extends Plugin {
    private Integer originalMode;
    private Boolean originalSpeakerphone;
    private AudioDeviceInfo originalCommunicationDevice;

    @PluginMethod
    public synchronized void setSpeakerphone(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("The speakerphone state is required.");
            return;
        }

        try {
            AudioManager audio = audioManager();
            if (originalMode == null) {
                originalMode = audio.getMode();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    originalCommunicationDevice = audio.getCommunicationDevice();
                } else {
                    originalSpeakerphone = audio.isSpeakerphoneOn();
                }
            }
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                int deviceType = enabled ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                AudioDeviceInfo device = null;
                for (AudioDeviceInfo output : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    if (output.getType() == deviceType) {
                        device = output;
                        break;
                    }
                }
                if (device == null || !audio.setCommunicationDevice(device)) {
                    throw new IllegalStateException("The selected audio route is unavailable.");
                }
            } else {
                audio.setSpeakerphoneOn(enabled);
            }
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        } catch (Exception error) {
            try {
                restoreAudioRoute();
            } catch (Exception restoreError) {
                error.addSuppressed(restoreError);
            }
            call.reject("The audio route could not be changed.", error);
        }
    }

    @PluginMethod
    public synchronized void reset(PluginCall call) {
        try {
            restoreAudioRoute();
            call.resolve();
        } catch (Exception error) {
            call.reject("The audio route could not be restored.", error);
        }
    }

    @Override
    protected synchronized void handleOnDestroy() {
        restoreAudioRoute();
        super.handleOnDestroy();
    }

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private void restoreAudioRoute() {
        if (originalMode == null) return;
        AudioManager audio = audioManager();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (originalCommunicationDevice != null) audio.setCommunicationDevice(originalCommunicationDevice);
            else audio.clearCommunicationDevice();
        } else if (originalSpeakerphone != null) {
            audio.setSpeakerphoneOn(originalSpeakerphone);
        }
        audio.setMode(originalMode);
        originalMode = null;
        originalSpeakerphone = null;
        originalCommunicationDevice = null;
    }
}
