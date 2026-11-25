import { useEffect, useRef, useState } from 'react'
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, FlipHorizontal, Volume1, Volume2 } from 'lucide-react'
import Avatar from './Avatar'
import { useCall } from '../../lib/callContextState'
import { CALL_KINDS } from '../../lib/callSignaling'

// Calls can run past an hour, so unlike the voice-note timer this includes hours.
function formatDuration(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

function statusLabel(call) {
  if (call.state === 'ringing') {
    const kind = call.kind === CALL_KINDS.VIDEO ? 'video call' : 'voice call'
    return call.direction === 'incoming' ? `Incoming ${kind}` : 'Calling…'
  }
  if (call.state === 'connecting') return 'Connecting…'
  if (call.state === 'connected') return call.reconnecting ? 'Reconnecting…' : formatDuration(call.duration)
  return 'Call ended'
}

function cameraLabel(call) {
  if (call.kind !== CALL_KINDS.VIDEO) return 'Turn on camera'
  return call.localVideo ? 'Turn off camera' : 'Turn on camera'
}

// React cannot set `srcObject` as a prop, so the stream is attached imperatively.
// `muted` keeps the browser from opening a second audio path: remote audio always
// plays through the provider-owned <audio> element, and the local preview is the
// user's own microphone/camera.
function VideoSurface({ stream, muted = true, mirrored = false, className = '' }) {
  const ref = useRef(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (element.srcObject !== (stream || null)) element.srcObject = stream || null
    if (stream) element.play?.().catch(() => {})
  }, [stream])

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`${className} ${mirrored ? 'scale-x-[-1]' : ''}`}
    />
  )
}

function ControlButton({ onClick, label, className, disabled = false, pressed, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`rounded-full p-4 text-white transition-colors disabled:cursor-wait disabled:opacity-60 ${className}`}
    >
      {children}
    </button>
  )
}

export default function VoiceCallOverlay() {
  const {
    call,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    toggleCamera,
    switchCamera,
    toggleSpeakerphone,
    speakerphoneSupported,
    localStream,
    remoteStream,
  } = useCall()
  const [speakerphoneBusy, setSpeakerphoneBusy] = useState(false)
  const [speakerphoneError, setSpeakerphoneError] = useState('')

  useEffect(() => {
    setSpeakerphoneBusy(false)
    setSpeakerphoneError('')
  }, [call?.id])

  if (!call) return null

  const isIncomingRinging = call.direction === 'incoming' && call.state === 'ringing'
  const inCall = call.state === 'connecting' || call.state === 'connected'
  // The outgoing pre-connection screen (state `ringing`, direction `outgoing`)
  // must offer the same audio controls as an active call: the local microphone
  // and transport already exist while the callee's phone is ringing.
  const isOutgoingRinging = call.direction === 'outgoing' && call.state === 'ringing'
  const showMute = inCall || isOutgoingRinging
  const showVideo = call.kind === CALL_KINDS.VIDEO && inCall
  const showRemoteVideo = showVideo && call.remoteVideo
  const toggleSpeakerphoneFromUi = async () => {
    if (speakerphoneBusy) return
    setSpeakerphoneBusy(true)
    setSpeakerphoneError('')
    try {
      await toggleSpeakerphone()
    } catch (error) {
      setSpeakerphoneError(error?.message || 'The audio route could not be changed.')
    } finally {
      setSpeakerphoneBusy(false)
    }
  }

  const controls = call.state !== 'ended' && (
    <div className="flex items-center justify-center gap-3 sm:gap-6">
      {isIncomingRinging && (
        <ControlButton onClick={acceptCall} label="Accept call" className="bg-green-600 p-5 hover:bg-green-700">
          <Phone className="h-7 w-7" />
        </ControlButton>
      )}

      {speakerphoneSupported && (
        <ControlButton
          onClick={toggleSpeakerphoneFromUi}
          disabled={speakerphoneBusy}
          pressed={call.speakerphone === true}
          label={call.speakerphone ? 'Switch to earpiece' : 'Switch to loudspeaker'}
          className={`flex flex-col items-center gap-1 ${call.speakerphone ? 'bg-primary ring-2 ring-primary/50 hover:bg-primary/90' : 'bg-gray-700 hover:bg-gray-600'}`}
        >
          {call.speakerphone ? <Volume2 className="h-5 w-5" /> : <Volume1 className="h-5 w-5" />}
          <span className="text-[10px] leading-none">{call.speakerphone ? 'Loudspeaker' : 'Earpiece'}</span>
        </ControlButton>
      )}

      {showMute && (
        <ControlButton
          onClick={toggleMute}
          label={call.muted ? 'Unmute' : 'Mute'}
          pressed={call.muted === true}
          className={`flex flex-col items-center gap-1 ${call.muted ? 'bg-red-600 ring-2 ring-red-400/50 hover:bg-red-700' : 'bg-gray-700 hover:bg-gray-600'}`}
        >
          {call.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          <span className="text-[10px] leading-none">{call.muted ? 'Muted' : 'Mute'}</span>
        </ControlButton>
      )}

      {inCall && call.kind === CALL_KINDS.VIDEO && call.localVideo && (
        <ControlButton onClick={switchCamera} label="Switch camera" className="bg-gray-700 hover:bg-gray-600">
          <FlipHorizontal className="h-6 w-6" />
        </ControlButton>
      )}

      {inCall && (
        <ControlButton
          onClick={toggleCamera}
          label={cameraLabel(call)}
          className={call.localVideo ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-700 hover:bg-gray-600'}
        >
          {call.localVideo ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
        </ControlButton>
      )}

      <ControlButton
        onClick={isIncomingRinging ? declineCall : endCall}
        label={isIncomingRinging ? 'Decline call' : 'End call'}
        className="bg-red-600 p-5 hover:bg-red-700"
      >
        <PhoneOff className="h-7 w-7" />
      </ControlButton>
    </div>
  )

  const indicators = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {call.state === 'connected' && call.kind === CALL_KINDS.VIDEO && (
        <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs uppercase tracking-wide text-gray-200">
          {call.quality}
        </span>
      )}
      {call.engine === 'native' && (
        <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs uppercase tracking-wide text-gray-200">
          Native
        </span>
      )}
      {inCall && call.remoteMuted && (
        <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs text-gray-200">Peer muted</span>
      )}
    </div>
  )

  if (showVideo) {
    return (
      <div className="fixed inset-0 z-[60] bg-gray-950">
        <div className="absolute inset-0">
          {/* The native engine renders video into a platform surface on top of
              the WebView, so the placeholder stays behind it either way. */}
          <VideoSurface stream={remoteStream} className="h-full w-full object-cover" />
          {!showRemoteVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <Avatar src={call.peerAvatar} alt={call.peerName} size="2xl" />
              <p className="mt-4 text-sm text-gray-400">
                {call.kind === CALL_KINDS.VIDEO && !call.remoteVideo ? "Camera off" : 'Waiting for video…'}
              </p>
            </div>
          )}
        </div>

        <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-2 bg-gradient-to-b from-black/60 to-transparent px-6 pt-6 pb-10">
          <h2 className="text-lg font-semibold text-white">{call.peerName}</h2>
          <p className={`text-sm ${call.state === 'connected' && !call.reconnecting ? 'font-mono text-green-400' : 'text-gray-300'} ${call.reconnecting ? 'animate-pulse' : ''}`}>
            {statusLabel(call)}
          </p>
          {indicators}
          {call.error && <p className="text-sm text-red-400">{call.error}</p>}
          {speakerphoneError && <p role="alert" className="text-sm text-red-400">{speakerphoneError}</p>}
        </div>

        <div className="absolute right-4 top-4 h-40 w-28 overflow-hidden rounded-xl border border-white/20 bg-gray-800 shadow-lg sm:h-44 sm:w-32">
          {call.localVideo ? (
            <VideoSurface stream={localStream} mirrored className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-gray-400">Camera off</div>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-6 pt-10 pb-10">
          {controls}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-gray-900/95 px-6">
      <div className="text-center">
        <Avatar src={call.peerAvatar} alt={call.peerName} size="2xl" />
        <h2 className="mt-6 text-2xl font-semibold text-white">{call.peerName}</h2>
        <p
          className={`mt-2 ${
            call.state === 'connected' ? 'font-mono text-lg text-green-400' : 'text-gray-400'
          } ${call.state === 'ringing' || call.state === 'connecting' || call.reconnecting ? 'animate-pulse' : ''}`}
        >
          {statusLabel(call)}
        </p>
        <div className="mt-3">{indicators}</div>
        {call.error && <p className="mt-2 text-sm text-red-400">{call.error}</p>}
        {speakerphoneError && <p role="alert" className="mt-2 text-sm text-red-400">{speakerphoneError}</p>}
      </div>

      {controls && <div className="mt-12">{controls}</div>}
    </div>
  )
}
