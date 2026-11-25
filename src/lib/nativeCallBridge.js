// JS half of the `NexusNativeCall` Capacitor plugin (implemented in Kotlin at
// android/native-call-plugin/.../NexusNativeCallPlugin.kt).
//
// It is reached through the global Capacitor bridge instead of an npm import so
// the web bundle never gains a native-only dependency, and so the module is
// inert (available === false) on the web and in the test runner.

export const NATIVE_CALL_PLUGIN = 'NexusNativeCall'

function rawPlugin() {
  const plugin = globalThis.Capacitor?.Plugins?.[NATIVE_CALL_PLUGIN]
  if (!plugin || typeof plugin.createPeerConnection !== 'function') return null
  return plugin
}

export function isNativeCallAvailable() {
  return Boolean(rawPlugin())
}

const DELEGATED = [
  'createPeerConnection',
  'createOffer',
  'handleRemoteOffer',
  'handleRemoteAnswer',
  'addIceCandidate',
  'enableVideo',
  'setMuted',
  'setVideoEnabled',
  'switchCamera',
  'applyQuality',
  'getStats',
  'close',
  'addListener',
]

/**
 * A thin, uniform facade over the plugin. Every method delegates to the same
 * name on the native side, which is what lets the React layer treat the plugin
 * and the in-app WebRTC stack interchangeably.
 *
 * @returns {null | Record<string, (...args: unknown[]) => Promise<unknown>>}
 */
export function nativeCallBridge() {
  const plugin = rawPlugin()
  if (!plugin) return null
  const facade = {}
  for (const method of DELEGATED) {
    if (typeof plugin[method] === 'function') {
      facade[method] = (...args) => plugin[method](...args)
    }
  }
  return facade
}
