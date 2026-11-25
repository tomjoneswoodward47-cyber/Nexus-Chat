// On-device selfie face detection for instant identity verification.
//
// The instant tier is a *presence* check that runs entirely in the browser, so a
// false "no face" rejection blocks a real user for the wrong reason. The old
// one-shot `detectSingleFace(img)` used SSD MobileNet's default 0.5 confidence
// on the raw capture, which fails on dim, flat or low-contrast selfies.
//
// Three mitigations are layered on top of the detector:
//   1. frameStats()  — advisory quality analysis, so a failure can be explained
//   2. relightFrame() — luminance stretch + shadow lift before detection
//   3. SSD_PASSES     — a confidence cascade that relaxes the 0.5 default
//
// Relaxing the *box* threshold does not admit non-faces: the landmark and
// descriptor stages still have to succeed, and the strictest pass always runs
// first so a well-lit selfie still records its true, high confidence.

// ---- Tunables -------------------------------------------------------------

export const QUALITY = {
  darkMean: 62, // mean luma below this reads as underexposed
  brightMean: 205, // mean luma above this reads as washed out
  minContrast: 38, // p95-p05 luma spread below this reads as flat
  minSharpness: 55, // Laplacian variance below this reads as soft
  maxEdge: 1280, // longest analysed edge, to bound per-frame work
}

// Ordered strictest first. Each entry trades a little confidence for recall;
// the cascade short-circuits, so a good selfie only ever runs the first pass.
export const SSD_PASSES = [
  { label: 'strict', inputSize: 512, minConfidence: 0.5 },
  { label: 'relaxed', inputSize: 512, minConfidence: 0.25 },
  { label: 'rescue', inputSize: 608, minConfidence: 0.15 },
]

const HINTS = {
  dark: 'Your photo is very dark. Move somewhere brighter or face a window or lamp, then retake.',
  bright: 'Your photo is overexposed. Avoid aiming a bright light or the sun at the camera, then retake.',
  flat: 'Your photo has very little contrast. Put the light in front of you rather than behind you, then retake.',
  blurry: 'Your photo looks soft. Hold the camera steady and keep your face still, then retake.',
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

function percentile(histogram, total, fraction) {
  const target = fraction * total
  let seen = 0
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value]
    if (seen >= target) return value
  }
  return histogram.length - 1
}

// Mean of the squared Laplacian: a standard, cheap focus measure. A sharp selfie
// lands well above minSharpness; a smeared or motion-blurred one falls below.
function laplacianVariance(lumaPlane, width, height) {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const value = 4 * lumaPlane[i] - lumaPlane[i - 1] - lumaPlane[i + 1]
        - lumaPlane[i - width] - lumaPlane[i + width]
      sum += value
      sumSquares += value * value
      count += 1
    }
  }
  if (!count) return 0
  const mean = sum / count
  return sumSquares / count - mean * mean
}

// ---- Frame quality --------------------------------------------------------

/**
 * Describe a decoded frame so the caller can warn about the actual problem
 * instead of a generic "no face" message. Pure: takes raw RGBA pixels.
 */
export function frameStats({ data, width, height }) {
  const pixels = width * height
  const histogram = new Uint32Array(256)
  const plane = new Float32Array(pixels)
  let sum = 0

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4
    const value = luma(data[offset], data[offset + 1], data[offset + 2])
    plane[i] = value
    sum += value
    histogram[Math.min(255, Math.max(0, Math.round(value)))] += 1
  }

  const meanLuma = pixels ? sum / pixels : 0
  const p05 = percentile(histogram, pixels, 0.05)
  const p95 = percentile(histogram, pixels, 0.95)
  const contrast = p95 - p05
  const sharpness = laplacianVariance(plane, width, height)

  const issues = []
  if (meanLuma < QUALITY.darkMean) issues.push('dark')
  if (meanLuma > QUALITY.brightMean) issues.push('bright')
  if (contrast < QUALITY.minContrast) issues.push('flat')
  if (sharpness < QUALITY.minSharpness) issues.push('blurry')

  // Blur is not fixable by re-lighting, so it does not trigger the relit pass.
  const adequate = !issues.some((issue) => ['dark', 'bright', 'flat'].includes(issue))

  return { meanLuma, p05, p95, contrast, sharpness, issues, adequate }
}

/** Human, actionable guidance for the first problem a frame has, or null. */
export function qualityHint(stats) {
  for (const issue of ['dark', 'flat', 'bright', 'blurry']) {
    if (stats?.issues?.includes(issue)) return HINTS[issue]
  }
  return null
}

// ---- Re-lighting ----------------------------------------------------------

/**
 * Contrast-stretch and shadow-lift an RGBA frame so a dim, low-contrast selfie
 * gives SSD MobileNet the structure it needs. Pure and hue-preserving: a single
 * gain is applied to R/G/B so colours do not shift.
 */
export function relightFrame({ data, width, height }) {
  const pixels = width * height
  const histogram = new Uint32Array(256)
  const plane = new Float32Array(pixels)
  let sum = 0

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4
    const value = luma(data[offset], data[offset + 1], data[offset + 2])
    plane[i] = value
    sum += value
    histogram[Math.min(255, Math.max(0, Math.round(value)))] += 1
  }

  const mean = pixels ? sum / pixels : 0
  const low = percentile(histogram, pixels, 0.02)
  const high = percentile(histogram, pixels, 0.98)
  const span = high - low
  // A near-flat histogram has no range to stretch: dividing by it would crush a
  // uniformly dark frame to black, so only the shadow lift applies.
  const stretchable = span >= 16
  const gamma = mean < QUALITY.darkMean ? 0.78 : 1

  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4
    const source = plane[i]
    const stretched = stretchable
      ? Math.min(255, Math.max(0, ((source - low) * 255) / span))
      : source
    const lifted = gamma === 1 ? stretched : Math.pow(stretched / 255, gamma) * 255
    const gain = source > 1 ? lifted / source : 0
    out[offset] = data[offset] * gain
    out[offset + 1] = data[offset + 1] * gain
    out[offset + 2] = data[offset + 2] * gain
    out[offset + 3] = data[offset + 3]
  }

  return { data: out, width, height }
}

// ---- Detection cascade ----------------------------------------------------

function ssdOptions(faceapi, pass) {
  return new faceapi.SsdMobilenetv1Options({
    inputSize: pass.inputSize,
    minConfidence: pass.minConfidence,
  })
}

/**
 * Try every face-bearing input against every pass, strictest first, stopping at
 * the first hit. `inputs` is `[{ label, input }]`. Exported so the cascade can
 * be exercised with a stub detector in tests.
 */
export async function runDetectionPasses(faceapi, inputs, passes = SSD_PASSES) {
  const attempts = []
  for (const { label, input } of inputs) {
    for (const pass of passes) {
      const result = await faceapi.detectSingleFace(input, ssdOptions(faceapi, pass))
        .withFaceLandmarks()
        .withFaceDescriptor()
      const score = result?.detection?.score ?? null
      attempts.push({
        input: label,
        pass: pass.label,
        inputSize: pass.inputSize,
        minConfidence: pass.minConfidence,
        found: Boolean(result),
        score,
      })
      if (result) return { result, input: label, pass, score, attempts }
    }
  }
  return { result: null, attempts }
}

export function eyeAspectRatio(landmarks) {
  const positions = landmarks?.getPositions?.()
  if (!positions || positions.length < 68) return null
  const eyeRatio = (points) => {
    const p = points.map((index) => positions[index])
    const verticalOne = Math.hypot(p[1].x - p[5].x, p[1].y - p[5].y)
    const verticalTwo = Math.hypot(p[2].x - p[4].x, p[2].y - p[4].y)
    const horizontal = Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y)
    return horizontal ? (verticalOne + verticalTwo) / (2 * horizontal) : 0
  }
  const left = eyeRatio([36, 37, 38, 39, 40, 41])
  const right = eyeRatio([42, 43, 44, 45, 46, 47])
  return (left + right) / 2
}

function sampleLiveFace(faceapi, video) {
  if (typeof document === 'undefined') return Promise.resolve(null)
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!canvas.width || !canvas.height) return Promise.resolve(null)
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return faceapi
    .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ inputSize: 512, minConfidence: 0.25 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
}

export async function runLivenessCheck(faceapi, video, options = {}) {
  const sampleCount = options.sampleCount || 7
  const intervalMs = options.intervalMs || 180
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const samples = []

  for (let index = 0; index < sampleCount; index += 1) {
    const result = await sampleLiveFace(faceapi, video)
    if (result) {
      const ear = eyeAspectRatio(result.landmarks)
      const box = result.detection?.box
      samples.push({
        ear,
        descriptor: result.descriptor,
        centerX: box ? box.x + box.width / 2 : null,
        centerY: box ? box.y + box.height / 2 : null,
      })
    }
    if (index < sampleCount - 1) await wait(intervalMs)
  }

  if (samples.length < 4) {
    return { passed: false, reason: 'Keep your whole face in frame and look directly at the camera, then try again.' }
  }

  const earValues = samples.map((sample) => sample.ear).filter((value) => Number.isFinite(value))
  const blinked = earValues.length >= 4 &&
    earValues.some((value) => value < 0.22) &&
    earValues.some((value) => value > 0.28)

  const centers = samples.filter((sample) => Number.isFinite(sample.centerX))
  let movement = 0
  if (centers.length >= 2) {
    const first = centers[0]
    const last = centers[centers.length - 1]
    movement = Math.hypot(last.centerX - first.centerX, last.centerY - first.centerY)
  }

  if (!blinked && movement < 12) {
    return {
      passed: false,
      reason: 'Blink naturally once or move your face slightly while the camera check is running.',
    }
  }

  return { passed: true, blinked, movement, samples: samples.length }
}

// ---- Browser adapters -----------------------------------------------------

function drawScaled(source, maxEdge) {
  const sourceWidth = source.width || source.videoWidth || 0
  const sourceHeight = source.height || source.videoHeight || 0
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight, 1))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(source, 0, 0, width, height)
  return { canvas, context, width, height }
}

/**
 * Quality-only pre-check for a captured selfie, used to warn the user before
 * they submit. Cheap: no model inference, just a downscale and pixel maths.
 */
export async function analyzeBlob(blob, maxEdge = QUALITY.maxEdge) {
  const bitmap = await createImageBitmap(blob)
  try {
    const { context, width, height } = drawScaled(bitmap, maxEdge)
    return frameStats(context.getImageData(0, 0, width, height))
  } finally {
    bitmap.close?.()
  }
}

/**
 * Full pipeline: decode, measure, re-light when the frame needs it, then run the
 * confidence cascade. Always resolves — callers branch on `found`.
 */
export async function detectFace(faceapi, blob) {
  const image = await faceapi.bufferToImage(blob)
  const { canvas, context, width, height } = drawScaled(image, QUALITY.maxEdge)
  const pixels = context.getImageData(0, 0, width, height)
  const stats = frameStats(pixels)

  const inputs = [{ label: 'original', input: canvas }]
  if (!stats.adequate) {
    const relit = relightFrame(pixels)
    const relitCanvas = document.createElement('canvas')
    relitCanvas.width = width
    relitCanvas.height = height
    relitCanvas.getContext('2d').putImageData(new ImageData(relit.data, width, height), 0, 0)
    inputs.push({ label: 'relit', input: relitCanvas })
  }

  const outcome = await runDetectionPasses(faceapi, inputs)
  if (!outcome.result) {
    return {
      found: false,
      stats,
      hint: qualityHint(stats) || 'No face detected. Centre your face, fill most of the frame, and retake.',
      attempts: outcome.attempts,
    }
  }

  return {
    found: true,
    descriptor: outcome.result.descriptor,
    landmarks: outcome.result.landmarks,
    score: outcome.score,
    stats,
    input: outcome.input,
    pass: outcome.pass.label,
    attempts: outcome.attempts,
  }
}
