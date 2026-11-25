// Two interchangeable media transports behind one interface:
//
//   * `createWebRtcTransport` — the in-app browser WebRTC stack (RTCPeerConnection
//     + getUserMedia), the production default, and
//   * `createNativeTransport` — the Kotlin Capacitor plugin, used when the
//     in-app stack is unavailable or has failed repeatedly on this device.
//
// CallContext only ever talks to the interface, which is what makes the
// fallback invisible to the rest of the app. Both transports are constructed
// from injected dependencies so the orchestration can be unit tested with fake
// peer connections and fake media.
//
// Shared interface:
//   start()                      -> Promise<void>
//   getKind()                    -> 'voice' | 'video'
//   getLocalStream()             -> MediaStream | null (null on the native engine)
//   createOffer({ iceRestart })  -> Promise<sdp>
//   handleRemoteOffer(sdp)       -> Promise<sdp>   (the local answer)
//   handleRemoteAnswer(sdp)      -> Promise<void>
//   addIceCandidate(candidate)   -> Promise<void>
//   enableVideo({ renegotiate }) -> Promise<sdp | null>
//   ensureVideoTrack()           -> Promise<void>
//   setMuted(muted)              -> void
//   setVideoEnabled(enabled)     -> void
//   applyQuality(tierName)       -> void
//   collectMetrics()             -> Promise<metrics>
//   close()                      -> void
//
// Emitted through `deps.events`:
//   candidate(candidate)              on a locally gathered ICE candidate
//   stream(stream, trackKind)         on a remote track (video arrives separately)
//   state(connectionState)            connecting | connected | disconnected | failed
//   local(stream)                     whenever the local stream changes

// Transports are imported with explicit extensions because the Node test runner
// resolves this module directly (Vite handles both forms).
import { ICE_SERVERS } from './callIce.js'
import { CALL_KINDS, normalizeCallKind } from './callSignaling.js'
import {
  DEFAULT_QUALITY,
  buildMediaConstraints,
  buildVideoConstraints,
  qualityEncodingParams,
  summarizeStats,
} from './callMedia.js'

function emit(events, name, ...args) {
  const handler = events?.[name]
  if (typeof handler === 'function') handler(...args)
}

function stopTracks(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop())
  } catch {
    // A partially released stream should not block the rest of the teardown.
  }
}

/**
 * In-app WebRTC transport.
 *
 * Voice and video differ only in the capture constraints and whether a video
 * sender exists, so a voice call upgrading to video reuses the same peer
 * connection (and therefore the same session) instead of tearing it down.
 */
export function createWebRtcTransport(deps = {}) {
  const {
    createPeerConnection = (config) => new globalThis.RTCPeerConnection(config),
    getUserMedia = (constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints),
    iceServers = ICE_SERVERS,
    kind: requestedKind = CALL_KINDS.VOICE,
    tier: requestedTier = DEFAULT_QUALITY,
    events = {},
  } = deps

  let pc = null
  let localStream = null
  let callKind = normalizeCallKind(requestedKind)
  let tier = requestedTier
  let videoSender = null
  let muted = false
  let closed = false

  function applyQualityToSender() {
    if (!videoSender?.getParameters || !videoSender?.setParameters) return
    try {
      const params = videoSender.getParameters()
      const current = params.encodings?.[0] || {}
      params.encodings = [{ ...current, ...qualityEncodingParams(tier) }]
      const applied = videoSender.setParameters(params)
      if (applied?.catch) applied.catch(() => {})
    } catch {
      // The sender is only briefly unparameterisable (mid-renegotiation).
    }
  }

  async function attachVideoTrack() {
    if (videoSender || !pc) return null
    let track = localStream?.getVideoTracks?.()[0]
    if (!track) {
      const camera = await getUserMedia({ video: buildVideoConstraints(tier) })
      track = camera.getVideoTracks()[0]
      if (!track) return null
      localStream?.addTrack?.(track)
      emit(events, 'local', localStream)
    }
    videoSender = pc.addTrack(track, localStream)
    return videoSender
  }

  return {
    engine: 'webrtc',

    getKind: () => callKind,
    getLocalStream: () => localStream,

    async start() {
      localStream = await getUserMedia(buildMediaConstraints({ kind: callKind, tier }))
      emit(events, 'local', localStream)
      pc = createPeerConnection(iceServers)
      pc.onicecandidate = (event) => {
        if (event?.candidate) emit(events, 'candidate', event.candidate)
      }
      pc.ontrack = (event) => {
        const stream = event?.streams?.[0]
        if (stream) emit(events, 'stream', stream, event?.track?.kind || 'audio')
      }
      pc.onconnectionstatechange = () => emit(events, 'state', pc.connectionState)
      for (const track of localStream.getTracks()) {
        const sender = pc.addTrack(track, localStream)
        if (track.kind === 'video') videoSender = sender
      }
      return localStream
    },

    async createOffer({ iceRestart = false } = {}) {
      if (!pc) return null
      const offer = await pc.createOffer({ iceRestart })
      await pc.setLocalDescription(offer)
      return pc.localDescription
    },

    async handleRemoteOffer(sdp) {
      if (!pc) return null
      await pc.setRemoteDescription(sdp)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      return pc.localDescription
    },

    async handleRemoteAnswer(sdp) {
      if (!pc) return
      await pc.setRemoteDescription(sdp)
    },

    async addIceCandidate(candidate) {
      if (!pc) return
      await pc.addIceCandidate(candidate)
    },

    // Seamless voice -> voice+video: reuse the live peer connection and only
    // renegotiate when asked, so the audio session is never interrupted.
    async enableVideo({ renegotiate = true } = {}) {
      if (closed) return null
      if (!pc) await this.start()
      await attachVideoTrack()
      callKind = CALL_KINDS.VIDEO
      applyQualityToSender()
      if (!renegotiate) return null
      return this.createOffer()
    },

    async ensureVideoTrack() {
      await attachVideoTrack()
      callKind = CALL_KINDS.VIDEO
      applyQualityToSender()
    },

    async switchCamera() {
      if (callKind !== CALL_KINDS.VIDEO) throw new Error('Turn on video before switching cameras.')
      const currentTrack = localStream?.getVideoTracks?.()[0]
      if (!currentTrack || typeof videoSender?.replaceTrack !== 'function') {
        throw new Error('Camera switching is not supported by this browser.')
      }
      const currentFacing = currentTrack.getSettings?.().facingMode
      const facingMode = currentFacing === 'environment' ? 'user' : 'environment'
      let nextStream
      try {
        nextStream = await getUserMedia({
          video: buildVideoConstraints(tier, { facingMode }),
          audio: false,
        })
        const nextTrack = nextStream.getVideoTracks?.()[0]
        if (!nextTrack) throw new Error('The selected camera did not provide a video track.')
        await videoSender.replaceTrack(nextTrack)
        localStream.removeTrack?.(currentTrack)
        localStream.addTrack?.(nextTrack)
        currentTrack.stop?.()
        emit(events, 'local', localStream)
        return facingMode
      } catch (error) {
        nextStream?.getTracks?.().forEach((track) => track.stop?.())
        throw error
      }
    },

    getVideoSender: () => videoSender,

    setMuted(next) {
      muted = Boolean(next)
      localStream?.getAudioTracks?.().forEach((track) => { track.enabled = !muted })
    },

    setVideoEnabled(enabled) {
      const on = Boolean(enabled)
      localStream?.getVideoTracks?.().forEach((track) => { track.enabled = on })
    },

    applyQuality(name) {
      tier = name || DEFAULT_QUALITY
      applyQualityToSender()
    },

    async collectMetrics() {
      if (!pc?.getStats) return summarizeStats(null)
      try {
        return summarizeStats(await pc.getStats())
      } catch {
        return summarizeStats(null)
      }
    },

    close() {
      closed = true
      if (pc) {
        pc.onicecandidate = null
        pc.ontrack = null
        pc.onconnectionstatechange = null
        try { pc.close() } catch { /* already closed */ }
      }
      stopTracks(localStream)
      localStream = null
      pc = null
      videoSender = null
    },
  }
}

/**
 * Native (Kotlin Capacitor plugin) transport. The plugin owns capture, the peer
 * connection and the video surfaces; JS keeps doing signalling, so this is a
 * drop-in replacement for the WebRTC transport rather than a second app.
 */
export function createNativeTransport(deps = {}) {
  const {
    bridge,
    kind: requestedKind = CALL_KINDS.VOICE,
    tier: requestedTier = DEFAULT_QUALITY,
    events = {},
  } = deps

  let callKind = normalizeCallKind(requestedKind)
  let tier = requestedTier
  let muted = false
  let videoEnabled = callKind === CALL_KINDS.VIDEO
  let handles = []

  function listen(event, handler) {
    try {
      const result = bridge.addListener(event, handler)
      if (result?.then) result.then((handle) => { if (handle?.remove) handles.push(handle) })
    } catch {
      // A missing listener must not stop the call from being placed.
    }
  }

  return {
    engine: 'native',

    getKind: () => callKind,
    getLocalStream: () => null,

    async start() {
      await bridge.createPeerConnection({ video: callKind === CALL_KINDS.VIDEO })
      listen('localCandidate', (event) => {
        if (event?.candidate) emit(events, 'candidate', event.candidate)
      })
      listen('remoteStream', (event) => emit(events, 'stream', null, event?.kind || 'video'))
      listen('connectionState', (event) => emit(events, 'state', event?.state))
      listen('localVideo', (event) => emit(events, 'local', null, event?.enabled !== false))
      await bridge.applyQuality({ tier })
    },

    async createOffer({ iceRestart = false } = {}) {
      const { sdp } = await bridge.createOffer({ iceRestart })
      return sdp
    },

    async handleRemoteOffer(sdp) {
      const { sdp: answer } = await bridge.handleRemoteOffer({ sdp })
      return answer
    },

    async handleRemoteAnswer(sdp) {
      await bridge.handleRemoteAnswer({ sdp })
    },

    async addIceCandidate(candidate) {
      await bridge.addIceCandidate({ candidate })
    },

    async enableVideo({ renegotiate = true } = {}) {
      const { sdp } = await bridge.enableVideo({ renegotiate })
      callKind = CALL_KINDS.VIDEO
      videoEnabled = true
      if (!renegotiate) return null
      return sdp || null
    },

    async ensureVideoTrack() {
      await bridge.enableVideo({ renegotiate: false })
      callKind = CALL_KINDS.VIDEO
      videoEnabled = true
    },

    async switchCamera() {
      if (typeof bridge.switchCamera !== 'function') {
        throw new Error('Camera switching is not supported by this native app version.')
      }
      await bridge.switchCamera()
    },

    setMuted(next) {
      muted = Boolean(next)
      try { bridge.setMuted({ muted }) } catch { /* best effort */ }
    },

    setVideoEnabled(enabled) {
      videoEnabled = Boolean(enabled)
      try { bridge.setVideoEnabled({ enabled: videoEnabled }) } catch { /* best effort */ }
    },

    applyQuality(name) {
      tier = name || DEFAULT_QUALITY
      try { bridge.applyQuality({ tier }) } catch { /* best effort */ }
    },

    async collectMetrics() {
      try {
        const { metrics } = await bridge.getStats()
        return summarizeStats(metrics)
      } catch {
        return summarizeStats(null)
      }
    },

    close() {
      try { bridge.close() } catch { /* already closed */ }
      for (const handle of handles) {
        try { handle.remove() } catch { /* already removed */ }
      }
      handles = []
    },
  }
}
