// Which media engine handles the call: the in-app browser WebRTC stack, or the
// native Kotlin Capacitor plugin that wraps the platform WebRTC implementation.
// The policy lives here, dependency free, so the fallback rules are unit
// tested rather than buried in the React provider.

export const CALL_ENGINES = {
  WEBRTC: 'webrtc',
  NATIVE: 'native',
}

// Two consecutive in-app failures are enough to prefer the native path for the
// rest of the session; a single hiccup should not cost the user a restart.
export const NATIVE_FAILURE_THRESHOLD = 2

export function normalizeEngine(value) {
  return String(value ?? '').trim().toLowerCase() === CALL_ENGINES.NATIVE
    ? CALL_ENGINES.NATIVE
    : CALL_ENGINES.WEBRTC
}

// `isAvailable` on the native bridge already means "the plugin is present and
// the device can run it", so support detection here only covers the browser.
export function isWebRtcSupported(nav = globalThis.navigator, PeerConnection = globalThis.RTCPeerConnection) {
  return typeof PeerConnection === 'function' && Boolean(nav?.mediaDevices?.getUserMedia)
}

/**
 * @param {{ preference?: string, webRtcSupported?: boolean, nativeAvailable?: boolean, failures?: number }} input
 * @returns {'webrtc' | 'native'}
 */
export function pickEngine({
  preference,
  webRtcSupported = isWebRtcSupported(),
  nativeAvailable = false,
  failures = 0,
} = {}) {
  const preferred = normalizeEngine(preference)

  // The browser stack is gone (old WebView, no camera API): the plugin is the
  // only way to make a call at all.
  if (!webRtcSupported) return nativeAvailable ? CALL_ENGINES.NATIVE : CALL_ENGINES.WEBRTC

  if (preferred === CALL_ENGINES.NATIVE && nativeAvailable) return CALL_ENGINES.NATIVE
  if (failures >= NATIVE_FAILURE_THRESHOLD && nativeAvailable) return CALL_ENGINES.NATIVE

  return CALL_ENGINES.WEBRTC
}

// Pure reducer over the failure counter, so the provider only has to apply the
// returned engine and count.
export function nextEngineAfterFailure({ engine, failures = 0, nativeAvailable = false } = {}) {
  const current = normalizeEngine(engine)
  const nextFailures = failures + 1
  const shouldFallBack =
    current === CALL_ENGINES.WEBRTC &&
    nativeAvailable &&
    nextFailures >= NATIVE_FAILURE_THRESHOLD

  return {
    engine: shouldFallBack ? CALL_ENGINES.NATIVE : current,
    failures: nextFailures,
    fallback: shouldFallBack,
  }
}

export function engineSucceeded() {
  return { failures: 0 }
}
