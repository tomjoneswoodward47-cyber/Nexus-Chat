import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCameraFocus,
  applyCameraFocusDistance,
  applyCameraTorch,
  cameraConstraints,
  cameraTrackFeatures,
  createCameraFile,
} from '../src/lib/cameraCapabilities.js'

test('camera constraints request a high-resolution stream with selected lens preference', () => {
  const constraints = cameraConstraints('user')
  assert.equal(constraints.audio, false)
  assert.deepEqual(constraints.video.facingMode, { ideal: 'user' })
  assert.deepEqual(constraints.video.width, { ideal: 1920 })
  assert.deepEqual(constraints.video.height, { ideal: 1080 })
  assert.deepEqual(constraints.video.frameRate, { ideal: 30, max: 30 })
})

test('camera feature discovery reports actual dimensions and only supported controls', () => {
  const track = {
    getCapabilities: () => ({ torch: true, focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10, step: 0.1 } }),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30, facingMode: 'environment', focusDistance: 3 }),
  }
  assert.deepEqual(cameraTrackFeatures(track), {
    width: 1280,
    height: 720,
    frameRate: 30,
    facingMode: 'environment',
    torch: true,
    torchEnabled: false,
    focusModes: ['continuous', 'manual'],
    focusDistanceRange: { min: 0, max: 10, step: 0.1 },
    focusDistance: 3,
    continuousFocus: true,
  })
})

test('torch and focus changes are applied only when the device advertises support', async () => {
  const applied = []
  const track = {
    getCapabilities: () => ({ torch: true, focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10, step: 1 } }),
    getSettings: () => ({}),
    applyConstraints: async (constraints) => { applied.push(constraints) },
  }
  assert.equal(await applyCameraTorch(track, true), true)
  assert.equal(await applyCameraFocus(track), true)
  assert.equal(await applyCameraFocusDistance(track, 20), true)
  assert.deepEqual(applied, [
    { advanced: [{ torch: true }] },
    { advanced: [{ focusMode: 'continuous' }] },
    { advanced: [{ focusMode: 'manual', focusDistance: 10 }] },
  ])
  assert.equal(await applyCameraTorch({ getCapabilities: () => ({}) }, true), false)
  assert.equal(await applyCameraFocusDistance({ getCapabilities: () => ({ focusMode: ['continuous'] }) }, 2), false)
})

test('camera capture files preserve their media type and requested filename', () => {
  const blob = new Blob(['sample'], { type: 'video/webm' })
  const file = createCameraFile(blob, 'capture.webm', 10)
  assert.equal(file.name, 'capture.webm')
  assert.equal(file.type, 'video/webm')
})
