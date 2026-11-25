import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  QUALITY,
  SSD_PASSES,
  frameStats,
  qualityHint,
  relightFrame,
  runDetectionPasses,
  eyeAspectRatio,
} from '../src/lib/faceDetection.js'

// ---- Synthetic frames -----------------------------------------------------

function frame(width, height, shade) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shade(x, y)
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  return { data, width, height }
}

const grey = (value) => [value, value, value]
const meanLuma = ({ data }) => {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  return sum / (data.length / 4)
}

function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A detailed, evenly lit frame: high spatial frequency, mid-grey mean.
const detailed = (() => {
  const random = mulberry32(7)
  return frame(64, 64, () => grey(random() * 255))
})()
// Mid-grey frame with only low-frequency detail -> soft, but not dark or flat.
const soft = frame(64, 64, (x) => grey(128 + 30 * Math.sin(x / 12)))
const dim = frame(64, 64, (x, y) => grey(5 + ((x + y) * 50) / 126))
const bright = frame(64, 64, (x, y) => grey((x + y) % 2 ? 250 : 180))
const flat = frame(64, 64, () => grey(128))

// ---- frameStats -----------------------------------------------------------

test('frameStats: a detailed, evenly lit frame is adequate', () => {
  const stats = frameStats(detailed)
  assert.equal(stats.issues.length, 0, `unexpected issues: ${stats.issues}`)
  assert.equal(stats.adequate, true)
  assert.ok(stats.sharpness > QUALITY.minSharpness, `sharpness ${stats.sharpness}`)
  assert.ok(stats.contrast > QUALITY.minContrast)
})

test('frameStats: an underexposed frame is flagged dark', () => {
  const stats = frameStats(dim)
  assert.ok(stats.issues.includes('dark'))
  assert.ok(stats.meanLuma < QUALITY.darkMean)
  assert.equal(stats.adequate, false)
})

test('frameStats: a washed-out frame is flagged bright', () => {
  const stats = frameStats(bright)
  assert.ok(stats.issues.includes('bright'))
  assert.ok(stats.meanLuma > QUALITY.brightMean)
  assert.equal(stats.adequate, false)
})

test('frameStats: a frame with no contrast is flagged flat', () => {
  const stats = frameStats(flat)
  assert.ok(stats.issues.includes('flat'))
  assert.ok(stats.contrast < QUALITY.minContrast)
})

test('frameStats: a soft frame is flagged blurry but still adequate to try', () => {
  const stats = frameStats(soft)
  assert.ok(stats.issues.includes('blurry'), `issues: ${stats.issues}`)
  assert.ok(stats.sharpness < QUALITY.minSharpness)
  // Blur cannot be fixed by re-lighting, so it must not force the relit pass.
  assert.equal(stats.adequate, true)
})

// ---- relightFrame ---------------------------------------------------------

test('relightFrame: lifts an underexposed frame toward mid-grey', () => {
  const before = meanLuma(dim)
  const after = meanLuma(relightFrame(dim))
  assert.ok(before < QUALITY.darkMean)
  assert.ok(after > before + 60, `mean went ${before} -> ${after}`)
  const stats = frameStats(relightFrame(dim))
  assert.ok(!stats.issues.includes('dark'), `still dark: ${stats.issues}`)
})

test('relightFrame: a uniformly dark frame is lifted, not crushed to black', () => {
  const uniform = frame(32, 32, () => grey(20))
  const after = relightFrame(uniform)
  assert.ok(meanLuma(after) > 25, `mean ${meanLuma(after)}`)
})

test('relightFrame: preserves dimensions, alpha and channel ordering', () => {
  // A dark colour ramp whose every pixel is [v, v/2, v/4], i.e. R > G > B.
  const ramp = frame(16, 16, (x) => {
    const v = 20 + x * 5
    return [v, v * 0.5, v * 0.25]
  })
  const out = relightFrame(ramp)
  assert.equal(out.width, ramp.width)
  assert.equal(out.height, ramp.height)
  assert.equal(out.data.length, ramp.data.length)

  // Because one gain is applied per pixel, channel ordering survives. The
  // stretch deliberately clips the extreme tails, where ordering is undefined.
  let checked = 0
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i + 3], 255)
    const [r, g, b] = [out.data[i], out.data[i + 1], out.data[i + 2]]
    if (r === 0 || r === 255) continue
    assert.ok(r > g && g > b, `pixel ${i / 4} -> ${r},${g},${b}`)
    checked += 1
  }
  assert.ok(checked > 4, `only ${checked} unclipped pixels checked`)
})

// ---- qualityHint ----------------------------------------------------------

test('qualityHint: returns actionable advice per issue and null when clean', () => {
  assert.equal(qualityHint(frameStats(detailed)), null)
  assert.match(qualityHint(frameStats(dim)), /dark/i)
  assert.match(qualityHint(frameStats(bright)), /overexposed/i)
  assert.match(qualityHint(frameStats(soft)), /soft|steady/i)
  assert.match(qualityHint(frameStats(flat)), /contrast/i)
  assert.equal(qualityHint(null), null)
})

// ---- Cascade invariants ---------------------------------------------------

test('SSD_PASSES: relaxes confidence monotonically, strictest first', () => {
  assert.ok(SSD_PASSES.length >= 2)
  for (let i = 1; i < SSD_PASSES.length; i += 1) {
    assert.ok(
      SSD_PASSES[i].minConfidence < SSD_PASSES[i - 1].minConfidence,
      'each pass must be more lenient than the previous',
    )
    assert.ok(SSD_PASSES[i].inputSize >= SSD_PASSES[i - 1].inputSize)
  }
  // The first pass must still be at the detector's conservative default.
  assert.equal(SSD_PASSES[0].minConfidence, 0.5)
})

// ---- runDetectionPasses ---------------------------------------------------

// Stands in for @vladmandic/face-api: records the options each attempt uses and
// resolves a face only where `hit` says so.
function stubFaceapi(hit) {
  const calls = []
  class SsdMobilenetv1Options {
    constructor(options) { Object.assign(this, options) }
  }
  return {
    calls,
    SsdMobilenetv1Options,
    detectSingleFace(input, options) {
      calls.push({ input, minConfidence: options.minConfidence, inputSize: options.inputSize })
      const score = hit(input, options)
      return {
        withFaceLandmarks() { return this },
        withFaceDescriptor() {
          return score ? { descriptor: new Float32Array(128), detection: { score } } : null
        },
      }
    },
  }
}

const orig = [{ label: 'original', input: 'original' }]
const withRelit = [...orig, { label: 'relit', input: 'relit' }]

test('runDetectionPasses: a clear frame resolves on the strict first pass', async () => {
  const faceapi = stubFaceapi(() => 0.94)
  const outcome = await runDetectionPasses(faceapi, orig)
  assert.equal(outcome.pass.label, 'strict')
  assert.equal(outcome.score, 0.94)
  assert.equal(outcome.attempts.length, 1)
  assert.equal(faceapi.calls.length, 1)
})

test('runDetectionPasses: a marginal frame falls back instead of rejecting', async () => {
  const faceapi = stubFaceapi((_input, options) => (options.minConfidence <= 0.25 ? 0.31 : 0))
  const outcome = await runDetectionPasses(faceapi, orig)
  assert.equal(outcome.pass.label, 'relaxed')
  assert.equal(outcome.score, 0.31)
  assert.equal(outcome.attempts.length, 2)
  assert.equal(outcome.attempts[0].found, false)
  assert.equal(outcome.attempts[1].found, true)
})

test('runDetectionPasses: reaches the re-lit frame when the original cannot be read', async () => {
  const faceapi = stubFaceapi((input) => (input === 'relit' ? 0.62 : 0))
  const outcome = await runDetectionPasses(faceapi, withRelit)
  assert.equal(outcome.input, 'relit')
  assert.equal(outcome.pass.label, 'strict')
  assert.equal(outcome.attempts.length, 4)
  assert.deepEqual(outcome.attempts.map((a) => a.found), [false, false, false, true])
})

test('runDetectionPasses: reports every attempt when no face is present', async () => {
  const faceapi = stubFaceapi(() => 0)
  const outcome = await runDetectionPasses(faceapi, withRelit)
  assert.equal(outcome.result, null)
  assert.equal(outcome.attempts.length, withRelit.length * SSD_PASSES.length)
  assert.ok(outcome.attempts.every((a) => a.found === false && a.score === null))
  assert.equal(faceapi.calls.length, withRelit.length * SSD_PASSES.length)
})

test('eyeAspectRatio: open eyes score higher than closed eyes', () => {
  const open = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }))
  for (const [index, x, y] of [
    [36, 0, 0], [37, 1, -2], [38, 3, -2], [39, 4, 0], [40, 3, 2], [41, 1, 2],
    [42, 6, 0], [43, 7, -2], [44, 9, -2], [45, 10, 0], [46, 9, 2], [47, 7, 2],
  ]) { open[index] = { x, y } }
  const closed = open.map((position, index) => ({
    x: position.x,
    y: index === 37 || index === 40 || index === 43 || index === 46 ? position.y * 0.15 : position.y,
  }))
  const openScore = eyeAspectRatio({ getPositions: () => open })
  const closedScore = eyeAspectRatio({ getPositions: () => closed })
  assert.ok(openScore > closedScore)
  assert.ok(openScore > 0.22)
})

// ---- Component wiring -----------------------------------------------------

const source = fs.readFileSync(new URL('../src/components/chat/settings/VerificationSettings.jsx', import.meta.url), 'utf8')

test('the component uses the shared detection pipeline', () => {
  assert.match(source, /from '\.\.\/\.\.\/\.\.\/lib\/faceDetection'/)
  // The old single-shot detector must not be re-implemented locally.
  assert.doesNotMatch(source, /detectSingleFace/)
  assert.match(source, /if \(!selfieProbe\.found\)/)
  // The ID document is probed through the same pipeline and only compared when
  // a face is present (its absence leaves the score for admin review).
  assert.match(source, /idProbe\.found/)
})

test('the generic message is only the last resort', () => {
  // The selfie rejection prefers the pipeline's specific, actionable hint.
  const rejections = source.match(/throw new Error\([^)]*No face found[^)]*\)/g) || []
  assert.equal(rejections.length, 1)
  for (const line of rejections) assert.match(line, /probe\.hint \|\|/i)
})

test('the camera asks for enough definition for the detector', () => {
  assert.match(source, /width: \{ ideal: 1280 \}/)
  assert.match(source, /height: \{ ideal: 720 \}/)
})

test('a quality pre-check runs before detection', () => {
  assert.match(source, /analyzeBlob\(selfie\)/)
  assert.match(source, /selfieHint/)
})
