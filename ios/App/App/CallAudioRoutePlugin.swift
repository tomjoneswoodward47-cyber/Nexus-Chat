import AVFoundation
import Capacitor

@objc(CallAudioRoutePlugin)
public class CallAudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallAudioRoutePlugin"
    public let jsName = "CallAudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSpeakerphone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise)
    ]

    private var originalCategory: AVAudioSession.Category?
    private var originalMode: AVAudioSession.Mode?
    private var originalOptions: AVAudioSession.CategoryOptions?

    @objc func setSpeakerphone(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("The speakerphone state is required.")
            return
        }

        let session = AVAudioSession.sharedInstance()
        if originalCategory == nil {
            originalCategory = session.category
            originalMode = session.mode
            originalOptions = session.categoryOptions
        }

        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
            try session.overrideOutputAudioPort(enabled ? .speaker : .none)
            call.resolve(["enabled": enabled])
        } catch {
            call.reject("The audio route could not be changed.", nil, error)
        }
    }

    @objc func reset(_ call: CAPPluginCall) {
        guard originalCategory != nil else {
            call.resolve()
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.overrideOutputAudioPort(.none)
            if let category = originalCategory, let mode = originalMode, let options = originalOptions {
                try session.setCategory(category, mode: mode, options: options)
            }
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            originalCategory = nil
            originalMode = nil
            originalOptions = nil
            call.resolve()
        } catch {
            call.reject("The audio route could not be restored.", nil, error)
        }
    }
}
