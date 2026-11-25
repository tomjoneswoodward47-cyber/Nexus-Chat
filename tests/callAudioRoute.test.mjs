import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCallAudioRouteAvailable,
  readCallSpeakerPreference,
  resetCallAudioRoute,
  setCallSpeakerphone,
  writeCallSpeakerPreference,
} from '../src/lib/callAudioRoute.js'

test('speakerphone routing delegates to the native plugin', async () => {
  const previous = globalThis.Capacitor
  const calls = []
  const nativePlugin = {
    async setSpeakerphone(options) { calls.push(['setSpeakerphone', options]) },
    async reset() { calls.push(['reset']) },
  }
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: (name) => name === 'CallAudioRoute',
    registerPlugin: (name) => name === 'CallAudioRoute' ? nativePlugin : null,
  }

  try {
    assert.equal(isCallAudioRouteAvailable(), true)
    await setCallSpeakerphone(true)
    await resetCallAudioRoute()
    assert.deepEqual(calls, [
      ['setSpeakerphone', { enabled: true }],
      ['reset'],
    ])
  } finally {
    if (previous === undefined) delete globalThis.Capacitor
    else globalThis.Capacitor = previous
  }
})

test('unsupported platforms fail explicitly instead of pretending to change routes', async () => {
  const previous = globalThis.Capacitor
  globalThis.Capacitor = {
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  }
  try {
    assert.equal(isCallAudioRouteAvailable(), false)
    await assert.rejects(setCallSpeakerphone(true), /not available on this device/)
    await resetCallAudioRoute()
  } finally {
    if (previous !== undefined) globalThis.Capacitor = previous
  }
})

test('the speaker route preference is persisted and restored', () => {
  const previous = globalThis.localStorage
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
  }
  try {
    // No saved choice yet defaults to the earpiece.
    assert.equal(readCallSpeakerPreference(), false)

    assert.equal(writeCallSpeakerPreference(true), true)
    assert.equal(readCallSpeakerPreference(), true)

    assert.equal(writeCallSpeakerPreference(false), false)
    assert.equal(readCallSpeakerPreference(), false)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('a missing storage backend never throws or fabricates a preference', () => {
  const previous = globalThis.localStorage
  delete globalThis.localStorage
  try {
    assert.equal(readCallSpeakerPreference(), false)
    assert.equal(writeCallSpeakerPreference(true), true)
  } finally {
    if (previous !== undefined) globalThis.localStorage = previous
  }
})
