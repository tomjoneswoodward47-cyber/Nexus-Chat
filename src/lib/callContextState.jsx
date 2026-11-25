import { createContext, useContext } from 'react'

export const INACTIVE_CALL_API = {
  call: null,
  isAvailable: false,
  videoSupported: false,
  localStream: null,
  remoteStream: null,
  initiateCall: async () => {},
  acceptCall: async () => {},
  declineCall: () => {},
  endCall: () => {},
  toggleMute: () => {},
  toggleCamera: () => {},
  toggleSpeakerphone: async () => {},
  speakerphoneSupported: false,
  switchCamera: async () => {},
  startVideo: async () => {},
}

export const CallContext = globalThis.__nexusCallContext ||
  (globalThis.__nexusCallContext = createContext(INACTIVE_CALL_API))

export function useCall() {
  return useContext(CallContext) || INACTIVE_CALL_API
}
