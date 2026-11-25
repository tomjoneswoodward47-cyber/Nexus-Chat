# Camera Device Test Report

**Review date:** 2026-11-23
**Status:** implementation and automated tests complete; physical device execution blocked
**Staging:** user reports an isolated staging project and test mailbox are ready;
no credentials were shared or stored in this repository.

## Device access observed

| Target | Known device | OS/browser | Connection | Result |
| --- | --- | --- | --- | --- |
| Android | Infinix NOTE 50 PRO / X6855 | Android 16 (API 36) | ADB authorized; camera service found | PARTIAL: metadata only |
| iPhone | Not provided | Not provided | No device session exposed | BLOCKED |
| Tablet | Not provided | Not provided | No device session exposed | BLOCKED |

Android platform-tools found the authorized Infinix X6855. Android reports the
camera service present and its static camera metadata lists both back and front
cameras; the back camera metadata advertises a flash unit and focus-distance
fields, while the front camera reports no flash unit. This is capability metadata
only: no app stream, photo, recording, focus change, torch operation, permission
prompt, or liveness scenario was executed. No iPhone/tablet model or session is
available. No runtime camera result is claimed.

## Implemented camera paths

- Feed composer can capture photos and record videos up to 45 seconds.
- Profile settings can take an avatar photo using the front camera or switch to
  the rear camera before capture.
- Video calls can switch between front and rear cameras when the WebRTC sender
  supports track replacement.
- Identity verification remains front-camera-only and runs a live blink/movement
  check before capturing a selfie.
- The camera UI reports actual track dimensions and facing mode.
- Torch and focus controls are displayed only when the camera reports support.
- Permission denial, missing APIs, capture failure, recording failure, and
  unsupported controls have explicit fallback/error messages.

Flash and manual focus are device/browser capabilities, not guaranteed by
`getUserMedia`. If unavailable, the app hides those controls and retains camera
auto-exposure/autofocus. The native-call bridge must expose `switchCamera` for
native-engine camera switching; the web engine uses `MediaStreamTrack.replaceTrack`.

The identity blink/movement check is a basic presence heuristic, not certified
presentation-attack detection. It can reject a static frame but must not be
represented as reliable protection against replayed video, animated displays, or
other spoof attempts. Physical spoof-resistance testing is outstanding.

## Automated results

| Test | Result |
| --- | --- |
| `npm run test:camera` | 45 passed, 0 failed |
| Complete Node test suite (`node --test tests/*.test.mjs`) | 333 passed, 0 failed |
| ESLint and project rules | Passed; 0 warnings |
| Production build | Passed; one face-detection chunk exceeds 1 MB minified |
| WebRTC camera switch track replacement and call media controls | Passed with mocked media streams |
| Camera constraint selection, capability reporting, supported torch/focus constraint application, and file metadata | Passed with mocked tracks |
| Screen capture | Not provided by `CameraCapture`; it captures a photo from the camera, not the device display |
| Camera permission prompts/revocation, photo and video capture lifecycle, recording timeout, and real-device focus/torch behavior | NOT RUN; no browser/device session |
| Physical camera resolution/focus/torch | NOT RUN |
| Android camera-service presence and static front/rear/flash metadata | Observed; not an app camera test |
| Front/rear lens selection on real hardware | NOT RUN |
| Photo/video capture on real hardware | NOT RUN |
| iOS permission prompts and Safari playback behavior | NOT RUN |
| Android permission prompts and native WebView behavior | NOT RUN |
| Liveness spoof/lighting trials on real users/devices | NOT RUN |
| Staging URL routing | NOT RUN; no staging URL or session was available to validate |
| Vault credential handoff | NOT RUN; no approved vault session was available, and no credentials were accessed or recorded |

`npm run test:camera`, `npm run lint`, and `npm run build` were run during this
validation. The initial bare `node --test` command also discovered the root
`test-npm.js` helper, which is not an ES module-compatible test and failed
before the test files ran. Restricting discovery to `tests/*.test.mjs` ran the
complete repository test suite successfully (333/333).

The automated camera tests exercise capability helpers and mocked WebRTC/media
tracks; they do not mount `CameraCapture` or verify browser permission prompts,
canvas photo capture, MediaRecorder behavior, stream cleanup, or a full call
workflow on actual hardware. The successful build emits a 1.315 MB minified
face-detection chunk; this is a build warning, not a build failure.

## Required physical test matrix

For each exact device and OS/browser version, run each scenario and attach a
redacted test-session identifier (never a password or access token):

1. Grant camera permission; verify preview starts and permission can be revoked.
2. Deny permission; verify no broken modal, stream leak, or silent success.
3. Switch front/rear cameras and confirm `getSettings().facingMode` when exposed.
4. Capture avatar/feed photo; verify dimensions, preview, upload, and persisted media.
5. Record a 5-second and 45-second feed video; verify playback and the 45-second cap.
6. Record resolution, frame rate, MIME type, and camera capture duration.
7. Test autofocus at near/far distances and manual focus where advertised.
8. Test torch on/off in a supported rear camera; confirm unsupported devices hide it.
9. Test video-call lens switching while connected; verify remote video continues.
10. Test identity selfie under front-lit, dim, backlit, partial-face, mask, glasses,
    no-face, still-photo, and screen-replay conditions.
11. Confirm camera tracks stop after closing the flow, route changes, and sign-out.

For each result, record device/model, OS, browser/app version, requested and
actual resolution, lighting/lux if available, control availability, pass/fail,
failure text, upload result, and elapsed time. Use staging accounts provisioned
by the operator and store credentials only in the approved password manager.

## Account and credential handling

No staging accounts were created during this run. Provision a least-privilege
member account for each required independent test profile through the staging
signup flow. Keep passwords in the operator-managed vault; this report must only
reference vault record IDs or redacted test-session IDs. Do not copy credentials,
magic codes, or tokens into source control, issue comments, screenshots, or
test logs.
