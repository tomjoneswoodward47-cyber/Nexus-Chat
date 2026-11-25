# Identity Verification Validation

**Review date:** 2026-11-23
**Scope:** on-device face detection, live blink/movement checks, quality coaching,
instant verification, manual review, and camera edge cases

## Implementation

The verification camera requests 1280x720 when supported, falls back to the browser
choice when constrained, and captures a live canvas frame. Before accepting the selfie,
the browser samples several live frames through the face landmark and descriptor pipeline.
The liveness check passes only when:

- enough samples contain a detected face and landmarks;
- eye aspect ratio drops and rises to indicate a natural blink; or
- the detected face moves enough across the video samples.

This is a challenge-presence check, not biometric identity proof. It does not replace
server authorization, document review, or manual approval. Supabase RLS and storage
authorization continue to govern document access.

## Automated validation

| Check | Result |
| --- | --- |
| Face-detection unit and wiring suite | 19/19 passed |
| Detailed frame, underexposure, washout, flatness, and blur | Passed |
| Strict/relaxed/rescue detection cascade | Passed |
| Re-lighted frame fallback | Passed |
| Open-eye versus closed-eye aspect ratio | Passed |
| Camera resolution constraints | Passed |
| ESLint | Zero warnings |
| Production build | Passed |
| Chromium, Chrome, and Edge responsive routes | 216/216 checks passed |

## Physical-device matrix

The current environment does not expose a physical camera, real ISP, or removable
test-device fleet. The following matrix is required before production acceptance.
It is a test procedure, not a claim that these hardware results have already been
executed.

| Device class | Resolution | Lighting | Required case |
| --- | --- | --- | --- |
| iPhone front camera | 1280x720 to native | Window/front, dim, backlit | Blink, partial face, mask, sunglasses, no-face |
| Android front camera | 1280x720 to native | Window/front, dim, backlit | Blink, head movement, portrait/landscape |
| Desktop webcam | 1280x720 | Front and low light | Blink, still photo spoof, monitor replay |
| Tablet front camera | 1280x720 | Window/front | Framing, distance, landscape |

Record for every run:

- device model and OS/browser version
- exact requested and actual resolution
- lighting description and measured lux when available
- pass/fail and failure reason
- liveness mode: blink or movement
- detector pass: strict, relaxed, rescue, or re-lit
- upload and verification status
- time-to-result and captured frame size

## Spoof and edge-case acceptance

The current blink/movement heuristic is not certified liveness or
presentation-attack detection. It may reject a static still frame, but a blink
or apparent motion alone cannot establish that the camera is seeing a live
person. Do not treat this check as robust protection against replayed video,
animated displays, or other spoof attempts. Physical-device trials and a
security-grade liveness assessment remain required before relying on it for
identity assurance. Never expose stored biometric descriptors or document files
through public URLs. Manual review remains the fallback for inconclusive identity
matches.

## Measured performance

- JavaScript face package production chunk: 1,315.35 KB (329.70 KB gzip)
- Emoji package production chunk: 512.10 KB (112.27 KB gzip)
- Both feature groups load independently from the core route bundles
- Initial route split: 211.99 KB entry chunk (58.77 KB gzip)
