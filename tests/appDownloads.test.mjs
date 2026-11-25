import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPlatform,
  detectCurrentPlatform,
  isStandalone,
  installGuidance,
  trackDownloadEvent,
  PLATFORM_LABELS,
} from '../src/lib/appDownloads.js'

// The library reads the browser globals (navigator / window) lazily inside each
// function, so the tests swap them in and restore the originals afterwards.

function withGlobals(overrides, run) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    // `navigator` exists in modern Node as a getter-only accessor, so a plain
    // assignment throws; defineProperty replaces it either way.
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  }
  try {
    return run()
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// iPadOS 13+ hides the iPad in the user agent and reports Macintosh instead.
const IPADOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

test('detectPlatform maps the user agent to a platform family', () => {
  assert.equal(detectPlatform(IPHONE_UA), 'ios')
  assert.equal(detectPlatform(IPAD_UA), 'ios')
  assert.equal(detectPlatform(ANDROID_UA), 'android')
  assert.equal(detectPlatform(WINDOWS_UA), 'desktop')
  assert.equal(detectPlatform(''), 'desktop')
  assert.equal(detectPlatform(undefined), 'desktop')
})

test('detectCurrentPlatform falls back to the touch heuristic for iPadOS', () => {
  assert.equal(
    withGlobals({ navigator: { userAgent: IPADOS_UA, maxTouchPoints: 5 } }, detectCurrentPlatform),
    'ios',
  )
  assert.equal(
    withGlobals({ navigator: { userAgent: IPADOS_UA, maxTouchPoints: 0 } }, detectCurrentPlatform),
    'desktop',
  )
  assert.equal(
    withGlobals({ navigator: { userAgent: ANDROID_UA, maxTouchPoints: 5 } }, detectCurrentPlatform),
    'android',
  )
  assert.equal(
    withGlobals({ navigator: undefined }, detectCurrentPlatform),
    'desktop',
  )
})

test('isStandalone recognises an installed app on every platform', () => {
  assert.equal(withGlobals({ window: undefined }, isStandalone), false)
  assert.equal(
    withGlobals(
      { window: { matchMedia: () => ({ matches: true }), navigator: {} } },
      isStandalone,
    ),
    true,
  )
  // iOS Safari exposes navigator.standalone instead of the display-mode query.
  assert.equal(
    withGlobals(
      { window: { matchMedia: () => ({ matches: false }), navigator: { standalone: true } } },
      isStandalone,
    ),
    true,
  )
  assert.equal(
    withGlobals(
      { window: { matchMedia: () => ({ matches: false }), navigator: { standalone: false } } },
      isStandalone,
    ),
    false,
  )
})

test('installGuidance returns platform-specific steps', () => {
  assert.match(installGuidance('ios'), /Add to Home Screen/)
  assert.match(installGuidance('android'), /Install app|Add to Home screen/)
  assert.match(installGuidance('desktop'), /address bar/)
  assert.equal(PLATFORM_LABELS.ios, 'iPhone & iPad')
})

test('trackDownloadEvent returns a payload without touching the network', () => {
  const payload = withGlobals({ window: undefined }, () =>
    trackDownloadEvent('download_click', { platform: 'android' }),
  )
  assert.equal(payload.event, 'app_download')
  assert.equal(payload.action, 'download_click')
  assert.equal(payload.platform, 'android')
  assert.equal(typeof payload.at, 'string')
})

test('trackDownloadEvent forwards to whichever analytics global is present', () => {
  const calls = { gtag: [], plausible: [], events: [] }
  const dataLayer = []
  const window = {
    gtag: (...args) => calls.gtag.push(args),
    dataLayer,
    plausible: (...args) => calls.plausible.push(args),
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    dispatchEvent: (event) => {
      calls.events.push(event)
      return true
    },
  }

  const payload = withGlobals({ window }, () => trackDownloadEvent('install_choice', { outcome: 'accepted' }))

  assert.equal(calls.gtag.length, 1)
  assert.deepEqual(calls.gtag[0], ['event', 'app_download', { action: 'install_choice', outcome: 'accepted' }])
  assert.equal(dataLayer.length, 1)
  assert.equal(dataLayer[0].action, 'install_choice')
  assert.equal(calls.plausible.length, 1)
  assert.equal(calls.events.length, 1)
  assert.equal(calls.events[0].type, 'nexus:download')
  assert.equal(calls.events[0].detail, payload)
})

test('trackDownloadEvent never throws when an analytics global misbehaves', () => {
  const window = {
    gtag: () => {
      throw new Error('blocked by an extension')
    },
    dispatchEvent: () => true,
  }
  const payload = withGlobals({ window }, () => trackDownloadEvent('download_started'))
  assert.equal(payload.action, 'download_started')
})
