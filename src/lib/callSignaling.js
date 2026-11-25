// Signalling vocabulary shared by the caller and the callee. Kept dependency
// free so it can be unit tested (and reasoned about) without React or Supabase.
//
// Two channel kinds are used:
//   * the per-user inbox  (`nexus-call-inbox:<userId>`) carries call control —
//     ring / ready / decline / busy / hangup — so a call can reach a user on any
//     page of the app, and
//   * the per-call channel (`nexus-call:<callId>`) carries the WebRTC handshake —
//     offer / answer / ice — plus media-state updates (media), so only the two
//     ends of a call exchange SDP.

export const INBOX_PREFIX = 'nexus-call-inbox:'
export const CALL_PREFIX = 'nexus-call:'

// A call starts as voice or video; the kind can be upgraded mid-call (voice →
// voice+video) but never silently downgraded, so the callee always knows what
// it is answering and both ends agree on the SDP shape.
export const CALL_KINDS = {
  VOICE: 'voice',
  VIDEO: 'video',
}

export const CALL_EVENTS = {
  RING: 'ring',
  READY: 'ready',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE: 'ice',
  // Mute / camera state, sent on the per-call channel so a media toggle is not
  // a renegotiation. Renegotiation itself still rides on OFFER/ANSWER.
  MEDIA: 'media',
  DECLINE: 'decline',
  BUSY: 'busy',
  HANGUP: 'hangup',
}

export const INBOX_EVENTS = [
  CALL_EVENTS.RING,
  CALL_EVENTS.READY,
  CALL_EVENTS.DECLINE,
  CALL_EVENTS.BUSY,
  CALL_EVENTS.HANGUP,
]

export const CALL_CHANNEL_EVENTS = [
  CALL_EVENTS.OFFER,
  CALL_EVENTS.ANSWER,
  CALL_EVENTS.ICE,
  CALL_EVENTS.MEDIA,
]

function idOf(value) {
  return String(value ?? '').trim()
}

export function inboxChannelName(userId) {
  const id = idOf(userId)
  return id ? `${INBOX_PREFIX}${id}` : ''
}

export function callChannelName(callId) {
  const id = idOf(callId)
  return id ? `${CALL_PREFIX}${id}` : ''
}

// A fresh, unguessable id per call keeps the SDP exchange scoped to the two
// participants even though the channel is public.
export function createCallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `call-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// Anything that is not an explicit "video" is treated as a voice call, so an
// older client that never sends a kind still places a voice call.
export function normalizeCallKind(value) {
  return String(value ?? '').trim().toLowerCase() === CALL_KINDS.VIDEO ? CALL_KINDS.VIDEO : CALL_KINDS.VOICE
}

export function buildRingPayload({ callId, chatId, caller, kind }) {
  return {
    callId: idOf(callId),
    chatId: idOf(chatId),
    fromUserId: idOf(caller?.id),
    fromName: idOf(caller?.name) || 'Nexus user',
    fromAvatar: caller?.avatar || null,
    kind: normalizeCallKind(kind),
  }
}

// Mute / camera state. `video` reports whether the sender's camera is on, not
// whether the call is a video call, so a voice call can carry video:false.
export function buildMediaPayload({ callId, kind, muted, video }) {
  return {
    callId: idOf(callId),
    kind: normalizeCallKind(kind),
    muted: Boolean(muted),
    video: Boolean(video),
  }
}

// Only accept payloads that describe the call we are currently handling.
export function matchesCall(payload, call) {
  if (!payload || !call) return false
  return Boolean(payload.callId) && payload.callId === call.id
}
