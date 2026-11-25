import { createContext, useCallback, useContext } from 'react'

export const SettingsContext = createContext()

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings must be used within SettingsProvider')
  return context
}

export function useSetting(key, defaultValue) {
  const { settings, setSetting } = useSettings()
  const value = settings[key] !== undefined ? settings[key] : defaultValue
  const setValue = useCallback((next) => setSetting(key, next), [key, setSetting])
  return [value, setValue]
}
