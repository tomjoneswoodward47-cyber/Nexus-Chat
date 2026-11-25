import { createContext, useContext } from 'react'

export const DEFAULT_AUTH = {
  user: null,
  loading: true,
  login: async () => { throw new Error('Account services are still loading. Please try again.') },
  logout: async () => {},
  register: async () => { throw new Error('Account services are still loading. Please try again.') },
  verifyEmailCode: async () => { throw new Error('Account services are still loading. Please try again.') },
  resendVerificationCode: async () => { throw new Error('Account services are still loading. Please try again.') },
  updateProfile: async () => {},
  requestPasswordReset: async () => { throw new Error('Account services are still loading. Please try again.') },
  resetPassword: async () => { throw new Error('Account services are still loading. Please try again.') },
  deleteAccount: async () => {},
}

export const AuthContext = globalThis.__nexusAuthContext ||
  (globalThis.__nexusAuthContext = createContext(DEFAULT_AUTH))

export function useAuth() {
  return useContext(AuthContext) || DEFAULT_AUTH
}
