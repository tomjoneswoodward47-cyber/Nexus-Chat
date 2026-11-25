import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from './authContextState'
import {
  CALL_EVENTS,
  CALL_KINDS,
  buildMediaPayload,
  buildRingPayload,
  callChannelName,
  createCallId,
  inboxChannelName,
  matchesCall,
  normalizeCallKind,
} from './callSignaling'
import { DEFAULT_QUALITY, selectQuality } from './callMedia'
import {
  CALL_ENGINES,
  engineSucceeded,
  isWebRtcSupported,
  nextEngineAfterFailure,
  pickEngine,
} from './callEngine'
import { createNativeTransport, createWebRtcTransport } from './callTransport'
import { isNativeCallAvailable, nativeCallBridge } from './nativeCallBridge'
import {
  isCallAudioRouteAvailable,
  readCallSpeakerPreference,
  resetCallAudioRoute,
  setCallSpeakerphone,
  writeCallSpeakerPreference,
} from './callAudioRoute'
import { CallContext } from './callContextState'

const RING_TIMEOUT_MS = 45000
const ENDED_DISMISS_MS = 2500
const SUBSCRIBE_TIMEOUT_MS = 8000
const SEND_LINGER_MS = 1500
const AUDIO_ELEMENT_ID = 'nexus-remote-audio'
// How often the video quality ladder is re-evaluated from RTCP stats.
const QUALITY_INTERVAL_MS = 5000
// A brief drop is normal on mobile; only escalate once it persists.
const RECONNECT_GRACE_MS = 6000
const RECONNECT_GIVE_UP_MS = 15000

const ENGINE_PREFERENCE = import.meta.env?.VITE_CALL_ENGINE || ''


function deniedMessage(kind) {
  return kind === CALL_KINDS.VIDEO
    ? 'Camera and microphone access are required for a video call'
    : 'Microphone access is required to take the call'
}

function subscribeChannel(channel) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      resolve(status)
    }
    try {
      channel.subscribe((status) => {
        if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(status)
      })
    } catch {
      finish('CHANNEL_ERROR')
    }
    if (typeof window !== 'undefined') window.setTimeout(() => finish('TIMED_OUT'), SUBSCRIBE_TIMEOUT_MS)
  })
}

// A short-lived channel pointed at one user's inbox. Realtime broadcast is not
// replayed, so the channel must be fully subscribed before the message is sent
// and kept alive briefly afterwards for it to flush.
async function sendInbox(peerId, event, payload) {
  const name = inboxChannelName(peerId)
  if (!supabase || !name || typeof window === 'undefined') return false
  const channel = supabase.channel(name, { config: { broadcast: { self: false } } })
  const status = await subscribeChannel(channel)
  let delivered = false
  if (status === 'SUBSCRIBED') {
    try {
      await channel.send({ type: 'broadcast', event, payload })
      delivered = true
    } catch {
      delivered = false
    }
  }
  window.setTimeout(() => {
    try { supabase.removeChannel(channel) } catch { /* channel already gone */ }
  }, SEND_LINGER_MS)
  return delivered
}

// iOS only unlocks media playback from inside a user gesture; a no-op play on
// the (still empty) audio element unlocks it for the remote stream arriving later.
function primeAudio() {
  const audio = document.getElementById(AUDIO_ELEMENT_ID)
  audio?.play?.().catch(() => {})
}

/**
 * App-wide voice and video calling.
 *
 * Signalling rides on Supabase Realtime broadcast channels (no third-party
 * service and no per-minute cap): a per-user inbox carries call control so the
 * app can ring anywhere, and a per-call channel carries the WebRTC handshake and
 * media-state updates. Media flows peer-to-peer, relayed through TURN when one is
 * configured, and is handled by either the in-app WebRTC stack or the native
 * Kotlin Capacitor plugin — CallContext only sees the transport interface.
 *
 * A video call is a voice call plus a video track: enabling video mid-call
 * renegotiates the live peer connection instead of replacing it, so the audio
 * session and the call timer are never interrupted.
 */
export function CallProvider({ children }) {
  const { user } = useAuth()
  const userId = user?.id ? String(user.id) : null

  const [call, setCall] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)

  const callRef = useRef(null)
  const userIdRef = useRef(userId)
  const transportRef = useRef(null)
  const callChannelRef = useRef(null)
  const pendingIceRef = useRef([])
  const remoteSetRef = useRef(false)
  const durationTimerRef = useRef(null)
  const ringTimerRef = useRef(null)
  const dismissTimerRef = useRef(null)
  const qualityTimerRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const giveUpTimerRef = useRef(null)
  const engineFailuresRef = useRef(0)

  userIdRef.current = userId
  const videoSupported = useMemo(() => isWebRtcSupported() || isNativeCallAvailable(), [])
  const speakerphoneSupported = useMemo(() => isCallAudioRouteAvailable(), [])

  const setCallState = useCallback((next) => {
    callRef.current = next
    setCall(next)
  }, [])

  const patchCall = useCallback((patch) => {
    const current = callRef.current
    if (!current) return
    callRef.current = { ...current, ...patch }
    setCall(callRef.current)
  }, [])

  const toggleSpeakerphone = useCallback(async () => {
    const current = callRef.current
    if (!current || current.state === 'ended') return
    const speakerphone = !current.speakerphone
    await setCallSpeakerphone(speakerphone)
    if (callRef.current?.id !== current.id || callRef.current.state === 'ended') {
      await resetCallAudioRoute()
      return
    }
    // Remember the choice so the next call starts on the same route.
    writeCallSpeakerPreference(speakerphone)
    patchCall({ speakerphone })
  }, [patchCall])

  const clearRemoteMedia = useCallback(() => {
    setRemoteStream(null)
    if (typeof document !== 'undefined') {
      const audio = document.getElementById(AUDIO_ELEMENT_ID)
      if (audio) audio.srcObject = null
    }
  }, [])

  const cleanupMedia = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.clearTimeout(ringTimerRef.current)
      window.clearTimeout(dismissTimerRef.current)
      window.clearInterval(durationTimerRef.current)
      window.clearInterval(qualityTimerRef.current)
      window.clearTimeout(reconnectTimerRef.current)
      window.clearTimeout(giveUpTimerRef.current)
    }
    ringTimerRef.current = null
    dismissTimerRef.current = null
    durationTimerRef.current = null
    qualityTimerRef.current = null
    reconnectTimerRef.current = null
    giveUpTimerRef.current = null

    transportRef.current?.close?.()
    transportRef.current = null
    resetCallAudioRoute().catch((error) => console.error('Could not restore the call audio route.', error))
    setLocalStream(null)
    clearRemoteMedia()
    pendingIceRef.current = []
    remoteSetRef.current = false

    const channel = callChannelRef.current
    if (channel) {
      try { supabase?.removeChannel(channel) } catch { /* already removed */ }
      callChannelRef.current = null
    }
  }, [clearRemoteMedia])

  // Ends the local call. `notify` tells the other side; remote-initiated endings
  // pass false so two clients cannot bounce a hangup back and forth.
  const endCallInternal = useCallback((patch = {}, notify = true) => {
    const current = callRef.current
    if (!current) return
    if (notify) sendInbox(current.peerId, CALL_EVENTS.HANGUP, { callId: current.id })
    cleanupMedia()
    setCallState({ ...current, state: 'ended', reconnecting: false, ...patch })
    if (typeof window !== 'undefined') {
      dismissTimerRef.current = window.setTimeout(() => {
        if (callRef.current?.state === 'ended') setCallState(null)
      }, ENDED_DISMISS_MS)
    }
  }, [cleanupMedia, setCallState])

  const sendCall = useCallback((event, payload) => {
    const channel = callChannelRef.current
    if (!channel?.send) return Promise.resolve(false)
    try {
      return Promise.resolve(channel.send({ type: 'broadcast', event, payload })).then(() => true, () => false)
    } catch {
      return Promise.resolve(false)
    }
  }, [])

  // Video adaptation loop. Only runs for video calls, reads RTCP stats and walks
  // one rung of the ladder at a time so the picture does not oscillate.
  const startQualityLoop = useCallback(() => {
    if (typeof window === 'undefined') return
    window.clearInterval(qualityTimerRef.current)
    qualityTimerRef.current = window.setInterval(async () => {
      const active = callRef.current
      const transport = transportRef.current
      if (!active || active.state !== 'connected' || !transport) return
      if (active.kind !== CALL_KINDS.VIDEO) return
      const metrics = await transport.collectMetrics()
      const next = selectQuality(active.quality, metrics)
      if (next !== active.quality) {
        transport.applyQuality(next)
        patchCall({ quality: next })
      }
    }, QUALITY_INTERVAL_MS)
  }, [patchCall])

  // Ice restart keeps an established call alive across a network change (Wi-Fi
  // to mobile data, a tunnel, a brief dead zone) instead of dropping it.
  const restartIce = useCallback(async () => {
    const current = callRef.current
    const transport = transportRef.current
    if (!current || !transport || current.state === 'ended') return
    patchCall({ reconnecting: true })
    let offer = null
    try {
      offer = await transport.createOffer({ iceRestart: true })
    } catch {
      endCallInternal({ error: 'The call connection was lost' })
      return
    }
    if (offer) await sendCall(CALL_EVENTS.OFFER, { callId: current.id, sdp: offer, kind: current.kind })
    if (typeof window === 'undefined') return
    window.clearTimeout(giveUpTimerRef.current)
    giveUpTimerRef.current = window.setTimeout(() => {
      const active = callRef.current
      if (active?.id === current.id && active.state === 'connected' && active.reconnecting) {
        endCallInternal({ error: 'The call connection was lost' })
      }
    }, RECONNECT_GIVE_UP_MS)
  }, [endCallInternal, patchCall, sendCall])

  const markConnected = useCallback(() => {
    const current = callRef.current
    if (!current || current.state === 'connected') return
    if (typeof window !== 'undefined') {
      window.clearTimeout(ringTimerRef.current)
      window.clearInterval(durationTimerRef.current)
    }
    ringTimerRef.current = null
    const startedAt = current.startedAt || Date.now()
    callRef.current = { ...current, state: 'connected', error: '', reconnecting: false, startedAt, duration: 0 }
    setCall(callRef.current)
    engineFailuresRef.current = engineSucceeded().failures
    startQualityLoop()
    if (typeof window === 'undefined') return
    durationTimerRef.current = window.setInterval(() => {
      const active = callRef.current
      if (!active || active.state !== 'connected') return
      patchCall({ duration: Math.floor((Date.now() - active.startedAt) / 1000) })
    }, 1000)
  }, [patchCall, startQualityLoop])

  const handleConnectionState = useCallback((state) => {
    const current = callRef.current
    if (!current || current.state === 'ended') return
    if (state === 'connected') {
      if (typeof window !== 'undefined') {
        window.clearTimeout(reconnectTimerRef.current)
        window.clearTimeout(giveUpTimerRef.current)
      }
      reconnectTimerRef.current = null
      giveUpTimerRef.current = null
      markConnected()
      return
    }
    if (state === 'disconnected') {
      patchCall({ reconnecting: true })
      if (typeof window === 'undefined') return
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = window.setTimeout(() => { restartIce() }, RECONNECT_GRACE_MS)
      return
    }
    if (state === 'failed') restartIce()
  }, [markConnected, patchCall, restartIce])

  // Remote audio always goes to the provider-owned <audio> element so it keeps
  // playing while the user navigates; video is handed to the overlay instead.
  const handleRemoteStream = useCallback((stream, trackKind) => {
    if (trackKind === 'video') {
      if (stream) setRemoteStream(stream)
      patchCall({ remoteVideo: true })
      return
    }
    if (!stream) return
    const activeCall = callRef.current
    if (speakerphoneSupported && activeCall && activeCall.state !== 'ended') {
      setCallSpeakerphone(activeCall.speakerphone === true)
        .catch((error) => console.error('Could not apply the selected call audio route.', error))
    }
    if (typeof document !== 'undefined') {
      const audio = document.getElementById(AUDIO_ELEMENT_ID)
      if (audio) {
        audio.srcObject = stream
        audio.play?.().catch(() => {})
      }
    }
    if (stream.getVideoTracks?.().length) setRemoteStream(stream)
  }, [patchCall, speakerphoneSupported])

  // Picks the engine (in-app WebRTC, or the native plugin when the in-app stack
  // is unsupported or has failed twice) and builds the transport. Reused for the
  // whole call so an upgrade never replaces the session.
  const ensureTransport = useCallback(async (callId, kind) => {
    if (transportRef.current) return transportRef.current
    const nativeAvailable = isNativeCallAvailable()
    const engine = pickEngine({
      preference: ENGINE_PREFERENCE,
      nativeAvailable,
      failures: engineFailuresRef.current,
    })
    const events = {
      candidate: (candidate) => { sendCall(CALL_EVENTS.ICE, { callId, candidate }) },
      stream: (stream, trackKind) => handleRemoteStream(stream, trackKind),
      state: (state) => handleConnectionState(state),
      local: (stream) => setLocalStream(stream),
    }
    const transport = engine === CALL_ENGINES.NATIVE && nativeAvailable
      ? createNativeTransport({ bridge: nativeCallBridge(), kind, events })
      : createWebRtcTransport({ kind, tier: DEFAULT_QUALITY, events })
    transportRef.current = transport
    await transport.start()
    const activeCall = callRef.current
    if (speakerphoneSupported && activeCall?.id === callId && activeCall.state !== 'ended') {
      try {
        await setCallSpeakerphone(activeCall.speakerphone === true)
      } catch (error) {
        console.error('Could not apply the selected call audio route.', error)
      }
    }
    patchCall({ engine: transport.engine })
    return transport
  }, [handleConnectionState, handleRemoteStream, patchCall, sendCall, speakerphoneSupported])

  const noteTransportFailure = useCallback(() => {
    const next = nextEngineAfterFailure({
      engine: transportRef.current?.engine || CALL_ENGINES.WEBRTC,
      failures: engineFailuresRef.current,
      nativeAvailable: isNativeCallAvailable(),
    })
    engineFailuresRef.current = next.failures
    return next
  }, [])

  const flushIce = useCallback(async () => {
    const transport = transportRef.current
    if (!transport || !remoteSetRef.current) return
    const queued = pendingIceRef.current
    pendingIceRef.current = []
    for (const candidate of queued) {
      try { await transport.addIceCandidate(candidate) } catch { /* stale candidate */ }
    }
  }, [])

  // Callee side of the handshake. Also handles the caller's mid-call video
  // upgrade, which arrives as a fresh offer on the same peer connection.
  const handleOffer = useCallback(async (payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current)) return
    const remoteKind = normalizeCallKind(payload.kind || current.kind)
    try {
      const transport = await ensureTransport(current.id, remoteKind)
      if (remoteKind === CALL_KINDS.VIDEO && transport.getKind() !== CALL_KINDS.VIDEO) {
        await transport.ensureVideoTrack()
        setLocalStream(transport.getLocalStream())
        patchCall({ kind: CALL_KINDS.VIDEO, localVideo: true })
      }
      const answer = await transport.handleRemoteOffer(payload.sdp)
      remoteSetRef.current = true
      await flushIce()
      await sendCall(CALL_EVENTS.ANSWER, { callId: current.id, sdp: answer, kind: transport.getKind() })
    } catch {
      noteTransportFailure()
      endCallInternal({ error: 'The call could not be answered' })
    }
  }, [endCallInternal, ensureTransport, flushIce, noteTransportFailure, patchCall, sendCall])

  // Caller side. The same path answers an ICE restart, since the answerer just
  // re-applies the remote description and returns a new answer.
  const handleAnswer = useCallback(async (payload) => {
    const current = callRef.current
    const transport = transportRef.current
    if (!current || !matchesCall(payload, current) || !transport) return
    try {
      await transport.handleRemoteAnswer(payload.sdp)
      remoteSetRef.current = true
      await flushIce()
    } catch {
      noteTransportFailure()
      endCallInternal({ error: 'The call could not be established' })
    }
  }, [endCallInternal, flushIce, noteTransportFailure])

  const handleIce = useCallback((payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current) || !payload.candidate) return
    const transport = transportRef.current
    if (!transport || !remoteSetRef.current) {
      pendingIceRef.current.push(payload.candidate)
      return
    }
    transport.addIceCandidate(payload.candidate).catch(() => {})
  }, [])

  // Mute / camera state of the peer. Never triggers a renegotiation.
  const handleMedia = useCallback((payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current)) return
    patchCall({
      remoteMuted: Boolean(payload.muted),
      remoteVideo: typeof payload.video === 'boolean' ? payload.video : current.remoteVideo,
      kind: payload.kind === CALL_KINDS.VIDEO ? CALL_KINDS.VIDEO : current.kind,
    })
  }, [patchCall])

  const bindCallChannel = useCallback((channel) => {
    channel
      .on('broadcast', { event: CALL_EVENTS.OFFER }, ({ payload }) => { handleOffer(payload) })
      .on('broadcast', { event: CALL_EVENTS.ANSWER }, ({ payload }) => { handleAnswer(payload) })
      .on('broadcast', { event: CALL_EVENTS.ICE }, ({ payload }) => { handleIce(payload) })
      .on('broadcast', { event: CALL_EVENTS.MEDIA }, ({ payload }) => { handleMedia(payload) })
  }, [handleOffer, handleAnswer, handleIce, handleMedia])

  const openCallChannel = useCallback(async (callId) => {
    if (!supabase) return null
    const channel = supabase.channel(callChannelName(callId), { config: { broadcast: { self: false } } })
    bindCallChannel(channel)
    const status = await subscribeChannel(channel)
    if (status !== 'SUBSCRIBED') {
      try { supabase.removeChannel(channel) } catch { /* already removed */ }
      return null
    }
    callChannelRef.current = channel
    return channel
  }, [bindCallChannel])

  const startOffer = useCallback(async (callId, kind) => {
    try {
      const transport = await ensureTransport(callId, kind)
      const offer = await transport.createOffer()
      await sendCall(CALL_EVENTS.OFFER, { callId, sdp: offer, kind: transport.getKind() })
    } catch {
      noteTransportFailure()
      endCallInternal({ error: deniedMessage(kind) })
    }
  }, [endCallInternal, ensureTransport, noteTransportFailure, sendCall])

  // ---- Caller (outgoing) ----

  const initiateCall = useCallback(async (target = {}) => {
    const peerId = String(target.peerId || '').trim()
    if (!supabase || !userIdRef.current || callRef.current || !peerId) return

    const kind = target.video ? CALL_KINDS.VIDEO : CALL_KINDS.VOICE
    const id = createCallId()
    setCallState({
      id,
      chatId: String(target.chatId || ''),
      direction: 'outgoing',
      peerId,
      peerName: target.peerName || 'Contact',
      peerAvatar: target.peerAvatar || null,
      kind,
      state: 'ringing',
      error: '',
      muted: false,
      // Start on the route the user last chose on this device.
      speakerphone: readCallSpeakerPreference(),
      localVideo: kind === CALL_KINDS.VIDEO,
      remoteVideo: false,
      remoteMuted: false,
      quality: DEFAULT_QUALITY,
      engine: CALL_ENGINES.WEBRTC,
      reconnecting: false,
      startedAt: null,
      duration: 0,
    })
    primeAudio()

    const channel = await openCallChannel(id)
    if (!channel) {
      setCallState(null)
      return
    }

    const delivered = await sendInbox(peerId, CALL_EVENTS.RING, buildRingPayload({
      callId: id,
      chatId: target.chatId,
      kind,
      caller: {
        id: userIdRef.current,
        name: user?.fullName || user?.firstName || user?.email,
        avatar: user?.avatarUrl,
      },
    }))
    if (!delivered) {
      endCallInternal({ error: 'That contact could not be reached' })
      return
    }

    if (typeof window !== 'undefined') {
      ringTimerRef.current = window.setTimeout(() => {
        if (callRef.current?.id === id && callRef.current.state === 'ringing') endCallInternal({ error: 'No answer' })
      }, RING_TIMEOUT_MS)
    }
  }, [endCallInternal, openCallChannel, setCallState, user])

  // ---- Callee (incoming) ----

  const handleRing = useCallback(async (payload) => {
    if (!payload?.callId || !payload.fromUserId) return
    if (callRef.current) {
      sendInbox(payload.fromUserId, CALL_EVENTS.BUSY, { callId: payload.callId })
      return
    }
    const channel = await openCallChannel(payload.callId)
    if (!channel) {
      sendInbox(payload.fromUserId, CALL_EVENTS.DECLINE, { callId: payload.callId })
      return
    }
    const kind = normalizeCallKind(payload.kind)
    setCallState({
      id: String(payload.callId),
      chatId: String(payload.chatId || ''),
      direction: 'incoming',
      peerId: String(payload.fromUserId),
      peerName: payload.fromName || 'Contact',
      peerAvatar: payload.fromAvatar || null,
      kind,
      state: 'ringing',
      error: '',
      muted: false,
      // Start on the route the user last chose on this device.
      speakerphone: readCallSpeakerPreference(),
      // The camera is only switched on when the call is accepted.
      localVideo: false,
      remoteVideo: kind === CALL_KINDS.VIDEO,
      remoteMuted: false,
      quality: DEFAULT_QUALITY,
      engine: CALL_ENGINES.WEBRTC,
      reconnecting: false,
      startedAt: null,
      duration: 0,
    })
    if (typeof window !== 'undefined') {
      ringTimerRef.current = window.setTimeout(() => {
        if (callRef.current?.id === payload.callId && callRef.current.state === 'ringing') {
          endCallInternal({ error: 'Missed call' })
        }
      }, RING_TIMEOUT_MS)
    }
  }, [endCallInternal, openCallChannel, setCallState])

  const handleReady = useCallback(async (payload) => {
    const current = callRef.current
    if (!current || current.direction !== 'outgoing' || !matchesCall(payload, current)) return
    if (typeof window !== 'undefined') window.clearTimeout(ringTimerRef.current)
    ringTimerRef.current = null
    patchCall({ state: 'connecting', error: '' })
    await startOffer(current.id, current.kind)
  }, [patchCall, startOffer])

  const handleDecline = useCallback((payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current)) return
    endCallInternal({ error: 'Call declined' })
  }, [endCallInternal])

  const handleBusy = useCallback((payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current)) return
    endCallInternal({ error: 'That contact is already on a call' })
  }, [endCallInternal])

  const handleHangup = useCallback((payload) => {
    const current = callRef.current
    if (!current || !matchesCall(payload, current)) return
    endCallInternal({ error: '' }, false)
  }, [endCallInternal])

  // Always-on inbox so a call can ring on any page while signed in.
  useEffect(() => {
    if (!supabase || !userId) return undefined
    const channel = supabase.channel(inboxChannelName(userId), { config: { broadcast: { self: false } } })
    channel
      .on('broadcast', { event: CALL_EVENTS.RING }, ({ payload }) => { handleRing(payload) })
      .on('broadcast', { event: CALL_EVENTS.READY }, ({ payload }) => { handleReady(payload) })
      .on('broadcast', { event: CALL_EVENTS.DECLINE }, ({ payload }) => { handleDecline(payload) })
      .on('broadcast', { event: CALL_EVENTS.BUSY }, ({ payload }) => { handleBusy(payload) })
      .on('broadcast', { event: CALL_EVENTS.HANGUP }, ({ payload }) => { handleHangup(payload) })
      .subscribe()

    return () => {
      try { supabase.removeChannel(channel) } catch { /* already removed */ }
      cleanupMedia()
      setCallState(null)
    }
  }, [userId, handleRing, handleReady, handleDecline, handleBusy, handleHangup, cleanupMedia, setCallState])

  // ---- Public API ----

  const acceptCall = useCallback(async () => {
    const current = callRef.current
    if (!current || current.direction !== 'incoming' || current.state !== 'ringing') return
    if (typeof window !== 'undefined') window.clearTimeout(ringTimerRef.current)
    ringTimerRef.current = null
    patchCall({ state: 'connecting', error: '' })
    primeAudio()
    try {
      const transport = await ensureTransport(current.id, current.kind)
      setLocalStream(transport.getLocalStream())
    } catch {
      noteTransportFailure()
      sendInbox(current.peerId, CALL_EVENTS.DECLINE, { callId: current.id })
      endCallInternal({ error: deniedMessage(current.kind) })
      return
    }
    patchCall({ localVideo: current.kind === CALL_KINDS.VIDEO })
    await sendInbox(current.peerId, CALL_EVENTS.READY, { callId: current.id })
  }, [endCallInternal, ensureTransport, noteTransportFailure, patchCall])

  const declineCall = useCallback(() => {
    const current = callRef.current
    if (current) sendInbox(current.peerId, CALL_EVENTS.DECLINE, { callId: current.id })
    cleanupMedia()
    setCallState(null)
  }, [cleanupMedia, setCallState])

  const endCall = useCallback(() => {
    endCallInternal({ error: '' })
  }, [endCallInternal])

  const toggleMute = useCallback(() => {
    const current = callRef.current
    const transport = transportRef.current
    if (!current || !transport) return
    const muted = !current.muted
    transport.setMuted(muted)
    patchCall({ muted })
    sendCall(CALL_EVENTS.MEDIA, buildMediaPayload({
      callId: current.id,
      kind: current.kind,
      muted,
      video: current.localVideo,
    }))
  }, [patchCall, sendCall])

  // Upgrades an active voice call to video on the live peer connection, so the
  // audio session and the timer keep running through the switch.
  const startVideo = useCallback(async () => {
    const current = callRef.current
    const transport = transportRef.current
    if (!current || !transport || current.kind === CALL_KINDS.VIDEO) return
    let offer = null
    try {
      offer = await transport.enableVideo()
    } catch {
      patchCall({ error: 'Camera access is required to turn on video' })
      return
    }
    setLocalStream(transport.getLocalStream())
    patchCall({ kind: CALL_KINDS.VIDEO, localVideo: true })
    if (offer) await sendCall(CALL_EVENTS.OFFER, { callId: current.id, sdp: offer, kind: CALL_KINDS.VIDEO })
    await sendCall(CALL_EVENTS.MEDIA, buildMediaPayload({
      callId: current.id,
      kind: CALL_KINDS.VIDEO,
      muted: current.muted,
      video: true,
    }))
  }, [patchCall, sendCall])

  const toggleCamera = useCallback(() => {
    const current = callRef.current
    const transport = transportRef.current
    if (!current || !transport) return
    if (current.kind !== CALL_KINDS.VIDEO) {
      startVideo()
      return
    }
    const localVideo = !current.localVideo
    transport.setVideoEnabled(localVideo)
    patchCall({ localVideo })
    sendCall(CALL_EVENTS.MEDIA, buildMediaPayload({
      callId: current.id,
      kind: current.kind,
      muted: current.muted,
      video: localVideo,
    }))
  }, [patchCall, sendCall, startVideo])

  const switchCamera = useCallback(async () => {
    const transport = transportRef.current
    const current = callRef.current
    if (!transport || current?.kind !== CALL_KINDS.VIDEO || !current.localVideo) return
    try {
      await transport.switchCamera()
      patchCall({ error: '' })
    } catch (error) {
      patchCall({ error: error?.message || 'The camera could not be switched.' })
    }
  }, [patchCall])

  const value = useMemo(() => ({
    call,
    isAvailable: Boolean(supabase),
    videoSupported,
    localStream,
    remoteStream,
    initiateCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleSpeakerphone,
    speakerphoneSupported,
    switchCamera,
    startVideo,
  }), [
    call,
    videoSupported,
    localStream,
    remoteStream,
    initiateCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleSpeakerphone,
    speakerphoneSupported,
    switchCamera,
    startVideo,
  ])

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Remote audio output for the active call. Rendered here (not in a chat
          view) so the call keeps playing while the user navigates the app. */}
      <audio id={AUDIO_ELEMENT_ID} autoPlay />
    </CallContext.Provider>
  )
}
