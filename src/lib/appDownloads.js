// Central source of truth for how the app reaches a device. Nexus Chat is an
// installable web app (a manifest and a service worker are registered in
// `src/main.jsx`), so "download" resolves to a real install on Android and
// desktop and to Add-to-Home-Screen on iOS. A native store listing or a direct
// APK is advertised only when a real URL is configured, so the page never links
// to a store page or package that does not exist yet.

// `import.meta.env` is injected by Vite at build time and is undefined under a
// plain Node import (the unit tests), so fall back to an empty object rather
// than throwing on the property access.
const env = import.meta.env || {}

const trimmed = (value) => String(value ?? '').trim()

// Optional direct-download channels. An empty string means "not published yet",
// and the page falls back to the browser install flow instead of a dead link.
export const ANDROID_APK_URL = trimmed(env.VITE_ANDROID_APK_URL)
export const PLAY_STORE_URL = trimmed(env.VITE_PLAY_STORE_URL)
export const APP_STORE_URL = trimmed(env.VITE_APP_STORE_URL)

export const PLATFORM_LABELS = {
  android: 'Android',
  ios: 'iPhone & iPad',
  desktop: 'Windows, macOS & Linux',
}

// Pure, testable detection from a user-agent string. Kept independent of the
// browser globals so the tests can drive it with fixtures.
export function detectPlatform(userAgent = '') {
  const ua = String(userAgent || '').toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  return 'desktop'
}

// iPadOS 13+ reports a desktop Safari user agent, so fall back to the touch
// heuristic when the string alone is ambiguous.
export function detectCurrentPlatform() {
  if (typeof navigator === 'undefined') return 'desktop'
  const platform = detectPlatform(navigator.userAgent || '')
  if (platform !== 'desktop') return platform
  const isIPadOS = /macintosh/.test((navigator.userAgent || '').toLowerCase()) && navigator.maxTouchPoints > 1
  return isIPadOS ? 'ios' : 'desktop'
}

// True when the app is already running as an installed PWA.
export function isStandalone() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS Safari exposes its own flag instead of the display-mode media query.
  return Boolean(window.navigator && window.navigator.standalone)
}

// Varies by platform, so the page can show accurate manual steps when the
// browser install prompt is unavailable (iOS Safari never fires it).
export function installGuidance(platform) {
  if (platform === 'ios') {
    return 'Open the Share menu in Safari, then choose "Add to Home Screen" to install Nexus Chat.'
  }
  if (platform === 'android') {
    return 'Open your browser menu and choose "Install app" or "Add to Home screen".'
  }
  return 'Use the install icon in your browser address bar (Chrome or Edge) to install Nexus Chat.'
}

// Vendor-agnostic download analytics. It forwards to whichever analytics global
// is present (gtag / dataLayer / Plausible) and always emits a DOM event, but
// makes no network request of its own — the app ships no third-party tracker.
// Returning the payload keeps the function usable from tests and callers.
export function trackDownloadEvent(action, detail = {}) {
  const payload = { event: 'app_download', action, ...detail, at: new Date().toISOString() }
  if (typeof window === 'undefined') return payload
  try {
    if (typeof window.gtag === 'function') window.gtag('event', 'app_download', { action, ...detail })
    if (Array.isArray(window.dataLayer)) window.dataLayer.push(payload)
    if (typeof window.plausible === 'function') window.plausible('App download', { props: { action, ...detail } })
    if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new window.CustomEvent('nexus:download', { detail: payload }))
    }
  } catch {
    // Analytics must never break the download flow.
  }
  return payload
}
