import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_QUALITY,
  buildMediaConstraints,
  buildVideoConstraints,
  qualityEncodingParams,
  selectQuality,
  stepTier,
  summarizeStats,
  tierByName,
} from '../src/lib/callMedia.js'
import {
  CALL_ENGINES,
  NATIVE_FAILURE_THRESHOLD,
  isWebRtcSupported,
  nextEngineAfterFailure,
  pickEngine,
} from '../src/lib/callEngine.js'
import { createNativeTransport, createWebRtcTransport } from '../src/lib/callTransport.js'
import { isNativeCallAvailable, nativeCallBridge } from '../src/lib/nativeCallBridge.js'

function sourceOf(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

// ---------------------------------------------------------------- test doubles

function fakeTrack(kind) {
  return {
    kind,
    enabled: true,
    stopped: false,
    getSettings: () => ({ facingMode: 'user' }),
    stop() { this.stopped = true },
  }
}

function fakeStream(tracks = []) {
  const list = [...tracks]
  return {
    getTracks: () => list,
    getAudioTracks: () => list.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => list.filter((track) => track.kind === 'video'),
    addTrack: (track) => { list.push(track) },
    removeTrack: (track) => { const index = list.indexOf(track); if (index >= 0) list.splice(index, 1) },
  }
}

const FAKE_STATS = [
  { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.02, availableOutgoingBitrate: 2000000 },
  { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 400 },
  { type: 'inbound-rtp', kind: 'video', packetsLost: 0, packetsReceived: 600, framesPerSecond: 29 },
  { type: 'outbound-rtp', kind: 'video', bytesSent: 4096, qualityLimitationReason: 'none' },
]

function makePeerConnectionFactory() {
  const created = []
  const factory = (config) => {
    const pc = {
      config,
      added: [],
      candidates: [],
      remoteDescriptions: [],
      localDescription: null,
      lastParameters: null,
      offerOptions: null,
      closed: false,
      addTrack(track, stream) {
        pc.added.push({ track, stream })
        return {
          getParameters: () => ({ encodings: [{}] }),
          setParameters: async (params) => { pc.lastParameters = params },
          replaceTrack: async (track) => { pc.replacedTrack = track },
        }
      },
      createOffer: async (options) => {
        pc.offerOptions = options || {}
        return { type: 'offer', sdp: 'offer-sdp' }
      },
      createAnswer: async () => ({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: async (desc) => { pc.localDescription = desc },
      setRemoteDescription: async (desc) => { pc.remoteDescriptions.push(desc) },
      addIceCandidate: async (candidate) => { pc.candidates.push(candidate) },
      getStats: async () => FAKE_STATS,
      close: () => { pc.closed = true },
    }
    created.push(pc)
    return pc
  }
  return { factory, created }
}

function makeGetUserMedia() {
  const calls = []
  const fn = async (constraints) => {
    calls.push(constraints)
    const tracks = [fakeTrack('audio')]
    if (constraints?.video) tracks.push(fakeTrack('video'))
    return fakeStream(tracks)
  }
  fn.calls = calls
  return fn
}

function makeNativeBridge() {
  const calls = { methods: [], listeners: {}, removed: 0 }
  const bridge = {}
  const methodNames = [
    'createPeerConnection', 'createOffer', 'handleRemoteOffer', 'handleRemoteAnswer',
    'addIceCandidate', 'enableVideo', 'setMuted', 'setVideoEnabled', 'switchCamera',
    'applyQuality', 'getStats', 'close',
  ]
  for (const name of methodNames) {
    bridge[name] = async (args) => {
      calls.methods.push([name, args])
      if (name === 'createOffer') return { sdp: 'native-offer' }
      if (name === 'handleRemoteOffer') return { sdp: 'native-answer' }
      if (name === 'enableVideo') return { sdp: 'native-upgrade-offer' }
      if (name === 'getStats') return { metrics: FAKE_STATS }
      return {}
    }
  }
  bridge.addListener = async (event, handler) => {
    calls.listeners[event] = handler
    return { remove: () => { calls.removed += 1 } }
  }
  bridge.calls = calls
  return bridge
}

function called(bridge, name) {
  return bridge.calls.methods.filter(([method]) => method === name)
}

// ------------------------------------------------------- capture constraints

test('a voice call never asks for the camera', () => {
  const constraints = buildMediaConstraints({ kind: 'voice' })
  assert.equal(constraints.video, false)
  assert.equal(constraints.audio.echoCancellation, true)
  assert.equal(constraints.audio.noiseSuppression, true)
})

test('a video call requests the resolution and frame rate of its tier', () => {
  const low = buildMediaConstraints({ kind: 'video', tier: 'low' })
  assert.equal(low.video.width.ideal, 320)
  assert.equal(low.video.frameRate.max, 15)
  assert.equal(low.video.facingMode, 'user')

  const high = buildVideoConstraints('high')
  assert.equal(high.width.ideal, 1280)
  assert.equal(high.height.ideal, 720)

  // An unknown tier falls back to the documented default rather than failing.
  assert.equal(tierByName('nonsense').name, DEFAULT_QUALITY)
})

test('every tier maps to sender encoding parameters', () => {
  assert.deepEqual(qualityEncodingParams('low'), { maxBitrate: 150000, maxFramerate: 15 })
  assert.deepEqual(qualityEncodingParams(tierByName('high')), { maxBitrate: 1500000, maxFramerate: 30 })
})

// ------------------------------------------------------------------- quality

test('stats are reduced to the numbers the adaptation loop uses', () => {
  const metrics = summarizeStats(FAKE_STATS)
  assert.equal(metrics.rttMs, 20)
  assert.equal(metrics.availableOutgoingBitrate, 2000000)
  assert.equal(metrics.framesPerSecond, 29)
  assert.equal(metrics.lossPct, 0)
  assert.equal(metrics.qualityLimitationReason, 'none')

  // A Map-shaped report (what the browser returns) behaves the same.
  const asMap = new Map(FAKE_STATS.map((stat, index) => [String(index), stat]))
  assert.equal(summarizeStats(asMap).rttMs, 20)

  const lossy = summarizeStats([
    { type: 'inbound-rtp', kind: 'video', packetsLost: 25, packetsReceived: 75 },
  ])
  assert.equal(lossy.lossPct, 25)
  assert.equal(lossy.rttMs, null)

  // No packets yet means no signal at all, not a perfect link.
  assert.equal(summarizeStats([]).lossPct, null)
  assert.equal(summarizeStats(null).lossPct, null)
})

test('quality degrades on congestion and recovers when the link is healthy', () => {
  assert.equal(selectQuality('medium', { lossPct: 12 }), 'low')
  assert.equal(selectQuality('high', { rttMs: 900, lossPct: 0 }), 'medium')
  assert.equal(selectQuality('high', { availableOutgoingBitrate: 90000 }), 'medium')
  assert.equal(selectQuality('high', { qualityLimitationReason: 'bandwidth' }), 'medium')
  assert.equal(selectQuality('high', { qualityLimitationReason: 'cpu' }), 'medium')

  assert.equal(selectQuality('low', { lossPct: 0, rttMs: 40, availableOutgoingBitrate: 3000000 }), 'medium')
  assert.equal(selectQuality('medium', { lossPct: 0, rttMs: 40, availableOutgoingBitrate: 3000000 }), 'high')
})

test('quality holds steady between the degrade and recover thresholds', () => {
  // 5% loss sits in the hysteresis band, so the tier must not move.
  assert.equal(selectQuality('medium', { lossPct: 5, rttMs: 220, availableOutgoingBitrate: 800000 }), 'medium')
  assert.equal(selectQuality('medium', {}), 'medium')
})

test('quality never walks off either end of the ladder', () => {
  assert.equal(stepTier('low', -1), 'low')
  assert.equal(stepTier('high', 1), 'high')
  assert.equal(selectQuality('low', { lossPct: 50 }), 'low')
  assert.equal(selectQuality('high', { lossPct: 0, rttMs: 10, availableOutgoingBitrate: 9000000 }), 'high')
})

// -------------------------------------------------------------------- engine

test('the in-app WebRTC stack is preferred whenever it is supported', () => {
  assert.equal(pickEngine({ webRtcSupported: true, nativeAvailable: true }), CALL_ENGINES.WEBRTC)
  assert.equal(pickEngine({ preference: 'webrtc', webRtcSupported: true, nativeAvailable: true }), CALL_ENGINES.WEBRTC)
})

test('an explicit native preference or repeated failures select the plugin', () => {
  assert.equal(pickEngine({ preference: 'native', webRtcSupported: true, nativeAvailable: true }), CALL_ENGINES.NATIVE)
  // A preference for native without the plugin present must not break calling.
  assert.equal(pickEngine({ preference: 'native', webRtcSupported: true, nativeAvailable: false }), CALL_ENGINES.WEBRTC)
  assert.equal(
    pickEngine({ webRtcSupported: true, nativeAvailable: true, failures: NATIVE_FAILURE_THRESHOLD }),
    CALL_ENGINES.NATIVE,
  )
  assert.equal(
    pickEngine({ webRtcSupported: true, nativeAvailable: true, failures: NATIVE_FAILURE_THRESHOLD - 1 }),
    CALL_ENGINES.WEBRTC,
  )
})

test('a WebView without WebRTC falls back to the plugin instead of failing', () => {
  assert.equal(pickEngine({ webRtcSupported: false, nativeAvailable: true }), CALL_ENGINES.NATIVE)
  assert.equal(pickEngine({ webRtcSupported: false, nativeAvailable: false }), CALL_ENGINES.WEBRTC)
  assert.equal(isWebRtcSupported({}, undefined), false)
  assert.equal(isWebRtcSupported({ mediaDevices: { getUserMedia: () => {} } }, function Peer() {}), true)
})

test('the failure counter only trips the fallback after the threshold', () => {
  const first = nextEngineAfterFailure({ engine: 'webrtc', failures: 0, nativeAvailable: true })
  assert.deepEqual(first, { engine: 'webrtc', failures: 1, fallback: false })

  const second = nextEngineAfterFailure({ engine: 'webrtc', failures: 1, nativeAvailable: true })
  assert.deepEqual(second, { engine: 'native', failures: 2, fallback: true })

  // Without the plugin nothing changes, and a native failure never re-falls back.
  assert.equal(nextEngineAfterFailure({ engine: 'webrtc', failures: 5, nativeAvailable: false }).engine, 'webrtc')
  assert.equal(nextEngineAfterFailure({ engine: 'native', failures: 5, nativeAvailable: true }).engine, 'native')
})

// --------------------------------------------------- WebRTC transport engine

test('a voice transport publishes one track and a video transport two', async () => {
  const { factory, created } = makePeerConnectionFactory()
  const getUserMedia = makeGetUserMedia()

  const voiceEvents = []
  const voice = createWebRtcTransport({
    createPeerConnection: factory, getUserMedia, kind: 'voice', events: { local: (s) => voiceEvents.push(s) },
  })
  await voice.start()
  assert.equal(voice.getKind(), 'voice')
  assert.equal(voice.getLocalStream().getTracks().length, 1)
  assert.equal(created[0].added.length, 1)
  assert.equal(getUserMedia.calls[0].video, false)

  const video = createWebRtcTransport({ createPeerConnection: factory, getUserMedia, kind: 'video' })
  await video.start()
  assert.equal(video.getKind(), 'video')
  assert.equal(video.getLocalStream().getTracks().length, 2)
  assert.equal(created[1].added.length, 2)
  assert.equal(getUserMedia.calls[1].video.width.ideal, 640)
})

test('the handshake and ICE candidates are routed through the transport', async () => {
  const { factory, created } = makePeerConnectionFactory()
  const candidates = []
  const streams = []
  const transport = createWebRtcTransport({
    createPeerConnection: factory,
    getUserMedia: makeGetUserMedia(),
    kind: 'voice',
    events: { candidate: (c) => candidates.push(c), stream: (...args) => streams.push(args) },
  })
  await transport.start()
  const pc = created[0]

  const offer = await transport.createOffer()
  assert.deepEqual(offer, { type: 'offer', sdp: 'offer-sdp' })
  assert.equal(pc.localDescription, offer)

  const restart = await transport.createOffer({ iceRestart: true })
  assert.equal(restart.sdp, 'offer-sdp')
  assert.deepEqual(pc.offerOptions, { iceRestart: true })

  const answer = await transport.handleRemoteOffer({ type: 'offer', sdp: 'remote' })
  assert.deepEqual(answer, { type: 'answer', sdp: 'answer-sdp' })
  assert.deepEqual(pc.remoteDescriptions, [{ type: 'offer', sdp: 'remote' }])
  assert.equal(pc.localDescription, answer)

  await transport.handleRemoteAnswer({ type: 'answer', sdp: 'remote-answer' })
  assert.equal(pc.remoteDescriptions.length, 2)

  await transport.addIceCandidate({ candidate: 'abc' })
  assert.deepEqual(pc.candidates, [{ candidate: 'abc' }])

  pc.onicecandidate({ candidate: { candidate: 'local' } })
  pc.onicecandidate({ candidate: null })
  assert.deepEqual(candidates, [{ candidate: 'local' }])

  const remoteStream = fakeStream([fakeTrack('audio')])
  pc.ontrack({ streams: [remoteStream], track: { kind: 'audio' } })
  assert.deepEqual(streams, [[remoteStream, 'audio']])
})

test('enabling video reuses the live peer connection instead of replacing it', async () => {
  const { factory, created } = makePeerConnectionFactory()
  const getUserMedia = makeGetUserMedia()
  const transport = createWebRtcTransport({ createPeerConnection: factory, getUserMedia, kind: 'voice' })
  await transport.start()
  const pc = created[0]
  assert.equal(transport.getKind(), 'voice')

  const offer = await transport.enableVideo()
  assert.equal(created.length, 1, 'the upgrade must not build a second peer connection')
  assert.equal(pc.closed, false)
  assert.equal(transport.getKind(), 'video')
  assert.equal(pc.added.length, 2)
  assert.equal(getUserMedia.calls.length, 2)
  assert.equal(offer.sdp, 'offer-sdp')
  assert.equal(pc.added[1].track.kind, 'video')

  // Answering the caller's upgrade offer only adds the track, no new offer.
  const alt = createWebRtcTransport({ createPeerConnection: factory, getUserMedia, kind: 'voice' })
  await alt.start()
  assert.equal(await alt.enableVideo({ renegotiate: false }), null)
  assert.equal(alt.getKind(), 'video')
  await alt.ensureVideoTrack()
  assert.equal(alt.getKind(), 'video')
})

test('mute, camera toggle and quality adaptation act on the local tracks', async () => {
  const { factory, created } = makePeerConnectionFactory()
  const transport = createWebRtcTransport({
    createPeerConnection: factory, getUserMedia: makeGetUserMedia(), kind: 'video',
  })

  test('switching a video camera replaces and stops the previous local track', async () => {
    const { factory, created } = makePeerConnectionFactory()
    const getUserMedia = makeGetUserMedia()
    const transport = createWebRtcTransport({ createPeerConnection: factory, getUserMedia, kind: 'video' })
    await transport.start()
    const oldTrack = transport.getLocalStream().getVideoTracks()[0]
    const facing = await transport.switchCamera()
    assert.equal(facing, 'environment')
    assert.equal(getUserMedia.calls[1].video.facingMode, 'environment')
    assert.equal(oldTrack.stopped, true)
    assert.equal(created[0].replacedTrack.kind, 'video')
    assert.equal(transport.getLocalStream().getVideoTracks().length, 1)
  })
  await transport.start()
  const pc = created[0]
  const stream = transport.getLocalStream()

  transport.setMuted(true)
  assert.equal(stream.getAudioTracks()[0].enabled, false)
  transport.setMuted(false)
  assert.equal(stream.getAudioTracks()[0].enabled, true)

  transport.setVideoEnabled(false)
  assert.equal(stream.getVideoTracks()[0].enabled, false)
  transport.setVideoEnabled(true)
  assert.equal(stream.getVideoTracks()[0].enabled, true)

  transport.applyQuality('low')
  assert.deepEqual(pc.lastParameters.encodings[0], { maxBitrate: 150000, maxFramerate: 15 })
  transport.applyQuality('high')
  assert.equal(pc.lastParameters.encodings[0].maxBitrate, 1500000)
})

test('closing a transport stops the media and detaches the peer connection', async () => {
  const { factory, created } = makePeerConnectionFactory()
  const transport = createWebRtcTransport({
    createPeerConnection: factory, getUserMedia: makeGetUserMedia(), kind: 'video',
  })
  await transport.start()
  const pc = created[0]
  const stream = transport.getLocalStream()

  const metrics = await transport.collectMetrics()
  assert.equal(metrics.rttMs, 20)
  assert.equal(metrics.framesPerSecond, 29)

  transport.close()
  assert.equal(pc.closed, true)
  assert.equal(pc.onicecandidate, null)
  assert.equal(pc.ontrack, null)
  assert.equal(transport.getLocalStream(), null)
  for (const track of stream.getTracks()) assert.equal(track.stopped, true)
})

// -------------------------------------------------------- native transport

test('the native transport delegates to the plugin behind the same interface', async () => {
  const bridge = makeNativeBridge()
  const events = { state: [], stream: [], candidate: [] }
  const transport = createNativeTransport({
    bridge,
    kind: 'video',
    events: {
      state: (s) => events.state.push(s),
      stream: (...args) => events.stream.push(args),
      candidate: (c) => events.candidate.push(c),
    },
  })

  assert.equal(transport.engine, 'native')
  assert.equal(transport.getLocalStream(), null)

  await transport.start()
  assert.deepEqual(called(bridge, 'createPeerConnection')[0][1], { video: true })
  assert.deepEqual(called(bridge, 'applyQuality')[0][1], { tier: DEFAULT_QUALITY })

  // Listener registration resolves asynchronously, as the Capacitor bridge does.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.ok(bridge.calls.listeners.connectionState)
  bridge.calls.listeners.localCandidate({ candidate: { candidate: 'c1' } })
  bridge.calls.listeners.connectionState({ state: 'connected' })
  bridge.calls.listeners.remoteStream({ kind: 'video' })
  assert.deepEqual(events.candidate, [{ candidate: 'c1' }])
  assert.deepEqual(events.state, ['connected'])
  assert.deepEqual(events.stream, [[null, 'video']])

  assert.equal(await transport.createOffer(), 'native-offer')
  assert.equal(await transport.createOffer({ iceRestart: true }), 'native-offer')
  assert.equal(await transport.handleRemoteOffer('remote'), 'native-answer')
  await transport.handleRemoteAnswer('answer')
  await transport.addIceCandidate({ candidate: 'c2' })
  assert.ok(called(bridge, 'handleRemoteAnswer').length === 1)
  assert.ok(called(bridge, 'addIceCandidate').length === 1)

  assert.equal(await transport.enableVideo(), 'native-upgrade-offer')
  assert.equal(await transport.enableVideo({ renegotiate: false }), null)

  transport.setMuted(true)
  transport.setVideoEnabled(false)
  transport.applyQuality('low')
  assert.deepEqual(called(bridge, 'setMuted')[0][1], { muted: true })
  assert.deepEqual(called(bridge, 'setVideoEnabled')[0][1], { enabled: false })
  assert.deepEqual(called(bridge, 'applyQuality').at(-1)[1], { tier: 'low' })

  const metrics = await transport.collectMetrics()
  assert.equal(metrics.rttMs, 20)

  transport.close()
  assert.equal(called(bridge, 'close').length, 1)
  assert.equal(bridge.calls.removed, 4)
})

test('a voice-only native transport never asks the plugin for video', async () => {
  const bridge = makeNativeBridge()
  const transport = createNativeTransport({ bridge, kind: 'voice' })
  await transport.start()
  assert.deepEqual(called(bridge, 'createPeerConnection')[0][1], { video: false })
})

// ------------------------------------------------------------ plugin bridge

test('the native bridge is inert until the Capacitor plugin is present', () => {
  const previous = globalThis.Capacitor
  try {
    delete globalThis.Capacitor
    assert.equal(isNativeCallAvailable(), false)
    assert.equal(nativeCallBridge(), null)

    const received = []
    globalThis.Capacitor = {
      Plugins: {
        NexusNativeCall: {
          createPeerConnection: async (args) => { received.push(['createPeerConnection', args]) },
          close: async () => { received.push(['close', undefined]) },
        },
      },
    }
    assert.equal(isNativeCallAvailable(), true)
    const facade = nativeCallBridge()
    assert.equal(typeof facade.createPeerConnection, 'function')
    assert.equal(typeof facade.close, 'function')
    assert.equal(facade.enableVideo, undefined)
    assert.equal(facade.switchCamera, undefined)
    return Promise.all([
      facade.createPeerConnection({ video: true }),
      facade.close(),
    ]).then(() => {
      assert.deepEqual(received, [['createPeerConnection', { video: true }], ['close', undefined]])
    })
  } finally {
    if (previous === undefined) delete globalThis.Capacitor
    else globalThis.Capacitor = previous
  }
})

// ------------------------------------------------------------ app wiring

test('the call provider drives video through the shared transport interface', () => {
  const source = sourceOf('../src/lib/CallContext.jsx')
  for (const marker of [
    'createWebRtcTransport',
    'createNativeTransport',
    'pickEngine',
    'selectQuality',
    'toggleCamera',
    'startVideo',
    'ensureVideoTrack',
    'reconnecting: true',
    'iceRestart: true',
    'CALL_EVENTS.MEDIA',
    'localStream',
    'remoteStream',
  ]) {
    assert.ok(source.includes(marker), `CallContext.jsx must reference ${marker}`)
  }
  // The remote audio element must stay provider-owned so audio survives navigation.
  assert.ok(source.includes('id={AUDIO_ELEMENT_ID}'))
})

test('the call UI renders both video surfaces and the camera control', () => {
  const overlay = sourceOf('../src/components/chat/VoiceCallOverlay.jsx')
  assert.ok(overlay.includes('remoteStream'))
  assert.ok(overlay.includes('localStream'))
  assert.ok(overlay.includes('toggleCamera'))
  assert.ok(overlay.includes('playsInline'))
  assert.ok(overlay.includes('Call ended'))

  const chatView = sourceOf('../src/components/chat/ChatView.jsx')
  assert.ok(chatView.includes('videoSupported'))
  assert.ok(chatView.includes('startCall(true)'))
  assert.ok(chatView.includes('Start video call'))
})

test('speakerphone routing is available before acceptance and registered on both native platforms', () => {
  const overlay = sourceOf('../src/components/chat/VoiceCallOverlay.jsx')
  const speakerControl = overlay.indexOf('{speakerphoneSupported && (')
  const connectedControls = overlay.indexOf('{inCall && (')
  assert.ok(speakerControl >= 0 && speakerControl < connectedControls)
  assert.ok(overlay.includes('Switch to loudspeaker'))
  assert.ok(overlay.includes('Switch to earpiece'))
  // The control announces its state and reflects the current route visually.
  assert.ok(overlay.includes('aria-pressed={pressed}'))
  assert.ok(overlay.includes('pressed={call.speakerphone === true}'))

  const context = sourceOf('../src/lib/CallContext.jsx')
  // Every new call (outgoing and incoming) starts on the persisted route, so the
  // toggle on the connecting screen reflects what the user chose last time.
  assert.ok((context.match(/speakerphone: readCallSpeakerPreference\(\)/g) || []).length >= 2)
  assert.ok(context.includes('writeCallSpeakerPreference'))

  const android = sourceOf('../android/app/src/main/java/com/nexus/chat/app/MainActivity.java')
  assert.ok(android.includes('registerPlugin(CallAudioRoutePlugin.class)'))
  assert.ok(sourceOf('../android/app/src/main/java/com/nexus/chat/app/CallAudioRoutePlugin.java').includes('setSpeakerphoneOn'))

  const iosController = sourceOf('../ios/App/App/BridgeViewController.swift')
  assert.ok(iosController.includes('registerPluginInstance(CallAudioRoutePlugin())'))
  assert.ok(sourceOf('../ios/App/App/CallAudioRoutePlugin.swift').includes('overrideOutputAudioPort'))
  assert.ok(sourceOf('../ios/App/App.xcodeproj/project.pbxproj').includes('CallAudioRoutePlugin.swift in Sources'))
})

test('the speaker control renders on the connecting screen for voice and video calls', () => {
  const overlay = sourceOf('../src/components/chat/VoiceCallOverlay.jsx')
  // Controls render for every non-ended state, so the toggle is available while
  // the outgoing call is still ringing and before the peer accepts.
  assert.ok(overlay.includes("const controls = call.state !== 'ended' && ("))
  // The toggle is shown regardless of the call kind, so both voice and video
  // connecting screens have it.
  assert.ok(overlay.includes('{speakerphoneSupported && ('))
  assert.ok(!/speakerphoneSupported &&\s*call\.kind === CALL_KINDS\.VIDEO/.test(overlay))
  // Visual feedback differs between the two routes.
  assert.ok(overlay.includes('<Volume2 className="h-5 w-5" />'))
  assert.ok(overlay.includes('<Volume1 className="h-5 w-5" />'))
})

test('the outgoing pre-connection screen exposes the audio route and mute controls', () => {
  const overlay = sourceOf('../src/components/chat/VoiceCallOverlay.jsx')
  // While the callee's phone is ringing the transport and microphone already
  // exist, so mute is available before the call connects.
  assert.ok(overlay.includes("const isOutgoingRinging = call.direction === 'outgoing' && call.state === 'ringing'"))
  assert.ok(overlay.includes('const showMute = inCall || isOutgoingRinging'))
  assert.ok(overlay.includes('{showMute && ('))
  // The speaker/earpiece toggle comes first, then mute, on the same control bar.
  const speakerControl = overlay.indexOf('{speakerphoneSupported && (')
  const muteControl = overlay.indexOf('{showMute && (')
  assert.ok(speakerControl >= 0 && muteControl > speakerControl)
  // Both controls reflect their toggled state visually and to assistive tech.
  assert.ok(overlay.includes("pressed={call.muted === true}"))
  assert.ok(overlay.includes('<MicOff className="h-5 w-5" />'))
  assert.ok(overlay.includes('<Mic className="h-5 w-5" />'))
})

test('the inactive call API exposes every control the overlay reads', () => {
  const api = sourceOf('../src/lib/callContextState.jsx')
  for (const method of [
    'toggleSpeakerphone',
    'switchCamera',
    'toggleMute',
    'toggleCamera',
    'startVideo',
  ]) {
    assert.ok(api.includes(`${method}:`), `the inactive API must expose ${method}`)
  }
})
