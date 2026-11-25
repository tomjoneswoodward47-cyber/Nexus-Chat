const PLUGIN_NAME = 'CallAudioRoute'
// Device-level preference: the route the user last picked is reused as the
// starting state of the next call (voice or video) on this device.
const SPEAKER_PREFERENCE_KEY = 'nexus.call.speakerphone'
let cachedPlugin
let cachedCapacitor

function plugin() {
  const capacitor = globalThis.Capacitor
  if (!capacitor?.isNativePlatform?.() || !capacitor.isPluginAvailable?.(PLUGIN_NAME)) return null
  if (cachedPlugin && cachedCapacitor === capacitor) return cachedPlugin

  const existingPlugin = capacitor.Plugins?.[PLUGIN_NAME]
  if (existingPlugin) {
    cachedPlugin = existingPlugin
  } else if (typeof capacitor.registerPlugin === 'function') {
    cachedPlugin = capacitor.registerPlugin(PLUGIN_NAME)
  } else {
    return null
  }
  cachedCapacitor = capacitor
  return cachedPlugin || null
}

export function isCallAudioRouteAvailable() {
  return typeof plugin()?.setSpeakerphone === 'function'
}

export async function setCallSpeakerphone(enabled) {
  const audioRoute = plugin()
  if (typeof audioRoute?.setSpeakerphone !== 'function') {
    throw new Error('Speaker routing is not available on this device.')
  }
  await audioRoute.setSpeakerphone({ enabled: Boolean(enabled) })
}

export async function resetCallAudioRoute() {
  const audioRoute = plugin()
  if (typeof audioRoute?.reset === 'function') await audioRoute.reset()
}

// Persisted speaker routing preference. Read before a call is created so a new
// session starts on the route the user chose last time, and written whenever the
// in-call toggle succeeds. Kept free of browser imports so it is unit testable.
export function readCallSpeakerPreference() {
  try {
    return globalThis.localStorage?.getItem(SPEAKER_PREFERENCE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeCallSpeakerPreference(enabled) {
  const value = Boolean(enabled)
  try {
    globalThis.localStorage?.setItem(SPEAKER_PREFERENCE_KEY, value ? 'true' : 'false')
  } catch {
    /* storage unavailable: the in-memory call state still reflects the choice */
  }
  return value
}
