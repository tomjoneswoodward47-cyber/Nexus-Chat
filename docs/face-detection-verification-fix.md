# Identity Verification: "No face found in your selfie" fix

Status: implemented and verified
Scope: instant and manual identity verification tiers in
`src/components/chat/settings/VerificationSettings.jsx`
Module: `src/lib/faceDetection.js` (new)
Tests: `tests/faceDetection.test.mjs` (new) — run with `npm run test:face`

## Symptom

Legitimate users were rejected with:

```
No face found in your selfie. Try again in a good light.
```

The message appeared for real, present faces whenever the capture was dim,
backlit, low-contrast or slightly soft, and it gave no clue which of those was
the actual problem.

## Root cause

The instant tier ran a single, one-shot detector on the raw capture:

```js
faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor()
```

Three independent causes combined:

1. **Overly strict threshold.** SSD MobileNet's default `minConfidence: 0.5` is
   tuned for well-lit, frontal faces. Partly shadowed, dim or backlit selfies
   scored just under it and returned `null`.
2. **No image preprocessing.** The raw frame went straight to the model, so a
   dim or flat capture gave the detector too little gradient structure to lock
   onto.
3. **Low capture resolution.** The unconstrained `getUserMedia` default (often
   640x480) left too few pixels on the face for a reliable detection.

Because every failure shared one generic message, users could not tell a
lighting problem from a framing problem, so retakes kept failing the same way.

## Changes

### 1. Detection thresholds — confidence cascade

`src/lib/faceDetection.js` replaces the single 0.5 gate with three ordered
passes, strictest first, short-circuiting on the first hit:

| Pass    | inputSize | minConfidence |
| ------- | --------- | ------------- |
| strict  | 512       | 0.50          |
| relaxed | 512       | 0.25          |
| rescue  | 608       | 0.15          |

Because the cascade stops at the first hit, a well-lit selfie still runs only
the strict pass and records its true high confidence. The stored `match_score`
is therefore not inflated for good captures.

### 2. Image preprocessing — re-lighting

`relightFrame()` applies a percentile contrast stretch (2%-98%) plus a gamma
0.78 shadow-lift to dark frames, using a single per-pixel gain so colours stay
hue-correct. It is generated only when the frame needs it (`!stats.adequate`),
and a degenerate-case guard (`span >= 16`) prevents a near-flat frame from being
crushed to black.

### 3. Image quality pre-checks

`frameStats()` measures mean luma, p05/p95 contrast and Laplacian-variance
sharpness, and flags `dark`, `bright`, `flat` and `blurry`. Thresholds are
centralised in one exported object:

| Setting       | Value | Meaning                                    |
| ------------- | ----- | ------------------------------------------ |
| `darkMean`    | 62    | mean luma below this reads as underexposed |
| `brightMean`  | 205   | mean luma above this reads as washed out   |
| `minContrast` | 38    | p95-p05 luma spread below this reads flat  |
| `minSharpness`| 55    | Laplacian variance below this reads soft   |
| `maxEdge`     | 1280  | longest analysed edge, bounds per-frame work |

`analyzeBlob()` runs this as a cheap pre-check (decode and downscale only, no
model inference) the moment a selfie is captured, so the user is warned before
submitting.

### 4. Camera capture parameters

`startCamera()` now requests higher definition so enough pixels land on the
face:

```js
navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
})
```

### 5. User interface improvements

- A quality-characterisation effect shows an actionable hint (for example,
  "Your photo is very dark. Move somewhere brighter or face a window or lamp,
  then retake.") instead of the generic message.
- The selfie card gained three capture tips: front lighting, fill the frame,
  and remove eyewear and hold the device steady.
- The generic "no face" text is now only the last-resort fallback used when no
  specific quality issue was detected.

## Security rationale

Relaxing the detector box threshold does not admit non-faces: the
`withFaceLandmarks()` and `withFaceDescriptor()` stages must still succeed for a
result to be returned, so a lower `minConfidence` can only recover true
positives, not fabricate faces. The strictest pass always runs first, so a good
selfie is still recorded at its true confidence. Quality analysis and
re-lighting are advisory and preprocessing-only; they do not bypass
verification, and the manual tier still holds submissions for admin review.

## Files changed

| File                                                          | Change                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/faceDetection.js`                                    | New shared pipeline: stats, hints, re-lighting, confidence cascade |
| `src/components/chat/settings/VerificationSettings.jsx`        | Consumes the pipeline, quality pre-check, camera, coaching UI      |
| `tests/faceDetection.test.mjs`                                | 18 unit and wiring tests                                          |
| `package.json`                                                | Added `test:face` script                                          |

## Verification

| Check                            | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| `npm run test:face`              | 18/18 pass                                         |
| `npx eslint` on changed files     | exit 0                                             |
| `npm run lint:rules`             | all four AGENTS.md rules PASS                      |
| `npx vite build`                 | exit 0 (only the pre-existing face-api chunk note) |

The tests assert the invariants that matter for correctness: strictest-first
ordering, fallback instead of rejection on marginal frames, the re-lit frame
being reached when the original cannot be read, every attempt being recorded
when no face truly exists, and the generic message being last-resort only. The
`face-*.js` bundle at about 1.3 MB is the expected model and runtime weight and
is unrelated to this change.
