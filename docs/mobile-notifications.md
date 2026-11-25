# Native System-Tray Notifications — Implementation & Maintenance Guide

Scope: Android + iOS system-tray notifications for Nexus Chat, delivered through
the official Capacitor local-notifications plugin, with the web/PWA browser
notification path kept intact.

---

## 1. Architecture

A single delivery choke point decides which surface shows a notification, so the
in-app popup, the sound and the OS notification never drift apart.

```
incoming message (Supabase realtime | Appwrite polling)
        │
        ▼
showIncomingNotification()            src/lib/notifications.js
   ├── dispatch  'nexus:incoming-notification'  → NotificationStack (in-app, all platforms)
   ├── playNotificationSound()                  → WebAudio tone, honours mute/volume
   └── createSystemNotification()
         ├── native?  → showNativeNotification()      src/lib/nativeNotifications.js  (Android/iOS tray)
         └── web?     → registration.showNotification()  → new Notification()  (browser)
```

| Layer | File | Responsibility |
|-------|------|----------------|
| Orchestration | [src/lib/notifications.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/notifications.js) | Builds copy, dispatches the in-app event, plays sound, picks native vs web |
| Native bridge | [src/lib/nativeNotifications.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/nativeNotifications.js) | Channel, permission, action types, scheduling, tap routing |
| In-app UI | [src/components/chat/NotificationStack.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/components/chat/NotificationStack.jsx) | Popup stack with manual + auto dismiss |
| Web fallback | [public/sw.js](file:///c:/Users/User$/Downloads/welcome-hub/public/sw.js) | `showNotification`, `notificationclick`, `push` |
| Bootstrap | [src/main.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/main.jsx) | Initializes the native bridge **before** React renders |
| Tap routing | [src/layouts/ChatLayout.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/layouts/ChatLayout.jsx) | Navigates to `/app/chat/:chatId` when a tray notification is opened |

`nativeNotifications.js` reaches the plugin through the global Capacitor bridge
(`globalThis.Capacitor`) rather than an npm import — the same convention as
`nativeCallBridge.js` — so the web bundle gains no native-only dependency and the
module is inert (`isNativeNotificationsAvailable() === false`) on the web and in
the Node test runner.

---

## 2. Plugins installed

| Package | Version | Why |
|---------|---------|-----|
| `@capacitor/local-notifications` | `^6.1.3` | System-tray notifications, scheduling, channels, action buttons |
| `@capacitor/splash-screen` | `^6.0.4` | Already referenced by `capacitor.config.json` but the package was missing, so the config was inert |

Install / re-install:

```bash
npm install @capacitor/local-notifications@^6.1.3 @capacitor/splash-screen@^6.0.4
npm run build          # webDir ("dist") must exist before syncing
npx cap sync           # registers the plugins in android/ and ios/
```

`npx cap sync` regenerates these files — never hand-edit them:

- `android/capacitor.settings.gradle` — Gradle includes for `:capacitor-local-notifications`, `:capacitor-splash-screen`
- `android/app/capacitor.build.gradle` — `implementation project(...)` entries
- `android/app/src/main/assets/capacitor.plugins.json` — plugin classpath registry
- `ios/App/Podfile` — `pod 'CapacitorLocalNotifications'`, `pod 'CapacitorSplashScreen'`

---

## 3. Platform configuration

### 3.1 Shared — `capacitor.config.json`

```jsonc
{
  "plugins": {
    "LocalNotifications": {
      "smallIcon": "ic_stat_nexus",   // res/drawable resource name (no extension)
      "iconColor": "#0ea5e9"           // Android status-bar icon tint
    }
  }
}
```

### 3.2 Android

[android/app/src/main/AndroidManifest.xml](file:///c:/Users/User$/Downloads/welcome-hub/android/app/src/main/AndroidManifest.xml)

| Permission | Source | Purpose |
|------------|--------|---------|
| `POST_NOTIFICATIONS` | app + plugin manifest | Android 13+ runtime permission for the tray |
| `SCHEDULE_EXACT_ALARM` | app manifest | Exact-time delivery of scheduled notifications on Android 12+; user-revocable |
| `VIBRATE` | app manifest | Channel vibration |
| `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` | plugin manifest | Survive doze and device restarts |

The plugin manifest also registers `TimedNotificationPublisher`,
`NotificationDismissReceiver` and `LocalNotificationRestoreReceiver`; Android
manifest merging handles them automatically.

- **Status-bar icon:** [android/app/src/main/res/drawable/ic_stat_nexus.xml](file:///c:/Users/User$/Downloads/welcome-hub/android/app/src/main/res/drawable/ic_stat_nexus.xml) — a flat white silhouette vector (Android renders only the alpha channel).
- **Notification channel:** created at runtime, see §4.2. Android 8+ ignores per-notification sound flags, so the channel owns sound/vibration/importance.

### 3.3 iOS

No `Info.plist` key is required for local notifications — iOS asks for permission
at runtime and the code owns the category definition.

- **Categories / actions:** registered at runtime via `registerActionTypes()` → `UNNotificationCategory` with an `Open` (foreground) and a `Dismiss` (destructive) `UNNotificationAction`.
- **Grouping:** notifications for the same chat set `threadIdentifier` so iOS stacks them per conversation.
- Deployment target stays `platform :ios, '13.0'` in `ios/App/Podfile`.

---

## 4. Integration API

All helpers live in [src/lib/nativeNotifications.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/nativeNotifications.js) and are safe to call on any platform.

### 4.1 Permission flow

```js
import { ensureNativeNotificationPermission } from './lib/nativeNotifications.js'

const { granted, status } = await ensureNativeNotificationPermission()
// status: 'granted' | 'denied' | 'prompt' | 'unavailable' | 'error'
```

`checkPermissions()` runs first; `requestPermissions()` is only called when the
state is not already `granted`. Any thrown bridge error resolves to
`{ granted: false, status: 'error' }` instead of rejecting.

### 4.2 Android channel

```js
import { ensureNativeNotificationChannel, NATIVE_MESSAGE_CHANNEL } from './lib/nativeNotifications.js'

await ensureNativeNotificationChannel() // no-op on iOS; cached after the first success
```

Creates `nexus-messages` (importance 4, vibration, lights, `#0ea5e9`). A channel
that does not exist yet causes Android to **drop** the notification, so
`showNativeNotification` creates it on demand before the first send.

### 4.3 Action buttons

```js
import { registerNativeNotificationActions } from './lib/nativeNotifications.js'

await registerNativeNotificationActions() // registers the NEXUS_MESSAGE action type
```

### 4.4 Displaying / scheduling

```js
import { showNativeNotification } from './lib/nativeNotifications.js'

// immediately
await showNativeNotification({
  title: 'Ada Lovelace',
  body: 'Are we still on for 15:00?',
  chatId: '9f1c…',                    // groups + replaces the existing tray entry
  url: '/app/chat/9f1c…',             // where a tap navigates
})

// 10 minutes from now
await showNativeNotification({
  title: 'Nexus Chat',
  body: 'Reminder: unread messages',
  chatId: '9f1c…',
  scheduledAt: Date.now() + 10 * 60 * 1000,
})
```

Return value: `{ delivered: true }` or `{ delivered: false, reason }` where
`reason` is `unavailable` (plugin missing → web path takes over), `denied`
(permission refused) or `error` (the native call threw — e.g. the exact-alarm
setting was revoked).

Notification ids are derived from the chat id (`toNotificationId`) and clamped to
a positive 32-bit integer, so a newer message from the same chat updates the
existing tray entry instead of stacking duplicates.

### 4.5 Handling taps

```js
import { onNativeNotificationAction } from './lib/nativeNotifications.js'

const detach = onNativeNotificationAction(({ actionId, url, chatId }) => {
  // actionId: 'tap' | 'open' | 'dismiss'
  if (url) navigate(url)
})
```

- The `dismiss` action is filtered out internally.
- A tap that **launched** the app (cold start) is buffered and replayed to the
  first subscriber, so nothing is lost while React is still mounting.
- `window` also receives a `nexus:notification-opened` event with the same detail
  for non-React consumers.

### 4.6 Bootstrap

`initializeNativeNotifications()` is idempotent and performs channel creation,
action registration and listener attachment. It is invoked once in
[src/main.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/main.jsx) before
render (so a launching notification is not missed) and again from
[ChatLayout](file:///c:/Users/User$/Downloads/welcome-hub/src/layouts/ChatLayout.jsx).

---

## 5. Error handling & fallbacks

| Scenario | Behaviour |
|----------|-----------|
| Running on the web / SSR / Node tests | `isNativeNotificationsAvailable() === false`; every helper is inert and the service-worker + `Notification` path is used |
| Plugin missing on a native build | `showNativeNotification` → `{ delivered: false, reason: 'unavailable' }`, delivery falls through to the web path |
| Permission denied | `{ delivered: false, reason: 'denied' }`; the in-app popup and sound still fire; `requestNotificationPermission()` returns `denied` |
| Native call throws | Caught and reported as `reason: 'error'`; the web path is still attempted |
| Android exact-alarm permission revoked | The plugin drops exact schedules; `checkExactNotificationSetting()` / `changeExactNotificationSetting()` are available if the app later needs to prompt |
| Sound muted in settings | The tone is skipped; the popup and tray notification are still delivered |

---

## 6. Verification

### 6.1 Automated (runs in this repo)

```bash
npm run test:native-notifications   # 17 tests
npm run test:notifications          # web path
node --test tests/*.mjs             # full suite
npm run lint                        # AGENTS.md project rules
npx eslint src/lib/nativeNotifications.js src/lib/notifications.js
```

`tests/nativeNotifications.test.mjs` covers: inert web behaviour, plugin
resolution order, 32-bit id derivation, payload normalization, check→request
permission flow, bridge-error fail-closed, channel create/skip, action
registration, Android vs iOS options, denied delivery, scheduling errors,
cold-start buffering, dismiss filtering, bootstrap idempotence, and that native
delivery suppresses the web notification.

### 6.2 Android device / emulator

Requires a JDK 17 and the Android SDK (`android/local.properties` → `sdk.dir`).

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug          # or: ./gradlew assembleRelease (needs key.properties)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Build verified in this workspace:** `./gradlew assembleDebug` → **BUILD
SUCCESSFUL** (Gradle 9.7.1, AGP 8.9.1, Temurin JDK 17, Android SDK at
`android-sdk/`), producing `android/app/build/outputs/apk/debug/app-debug.apk`
(8.06 MB). `aapt2 dump badging` on the APK confirms `compileSdk 36`,
`targetSdk 36`, `minSdk 22` and the declared `POST_NOTIFICATIONS`,
`SCHEDULE_EXACT_ALARM`, `VIBRATE`, `RECEIVE_BOOT_COMPLETED` and `WAKE_LOCK`
permissions. A full JDK (one that ships `jlink`) is required — an Android build
fails at `JdkImageTransform` on a `jlink`-less JRE.

**Emulator run (Windows host, API 36):** an API 36 `google_apis` x86_64 AVD
(`nexus36`, `pixel_7`) was provisioned under the git-ignored `android-sdk/`, and
the debug APK was installed and launched on it. Provisioning is not fully
scriptable here — `sdkmanager`'s system-image download is unreliable and the
~4 GB `system.img` exceeds the sandbox write limit — so the image is fetched
directly and unpacked by hand:

```bash
sdkmanager "emulator" "platform-tools"
# Download the image zip directly, then unpack so the archive's top-level
# x86_64/ folder lands in system-images/android-36/google_apis/
curl -L -C - -o "$SDK/.temp/sysimg.zip" \
  https://dl.google.com/android/repository/sys-img/google_apis/x86_64-36_r07.zip
tar -xf "$SDK/.temp/sysimg.zip" -C "$SDK/system-images/android-36/google_apis"
# A hand-unpacked image also needs a package.xml in .../google_apis/x86_64/,
# otherwise avdmanager reports "Package path is not valid".
avdmanager create avd -n nexus36 -k "system-images;android-36;google_apis;x86_64" -d pixel_7
emulator -avd nexus36 -no-window -no-audio -gpu host -memory 2048 -cores 2
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Checks 1–7, with the on-emulator result:

1. ✅ **Not** a first-launch prompt. `POST_NOTIFICATIONS` is requested lazily by
   `showNativeNotification` → `ensureNativeNotificationPermission()` on the first
   message, so the prompt is shown in context. On the emulator the request
   resolves against the system dialog; granting flips the app's notification
   importance from `NONE` to `DEFAULT` (`dumpsys notification --noredact`), and
   `checkPermissions()` reports `prompt` while it is ungranted.
2. ✅ `adb shell dumpsys notification --noredact | findstr nexus-messages` lists
   `NotificationChannel{mId='nexus-messages', mImportance=4, mLights=true,
   mVibrationEnabled=true}` — created by `initializeNativeNotifications()` at
   startup, before any message arrives.
3. ✅ A message-shaped notification posted through the plugin yields exactly one
   `NotificationRecord` for the package with `channel=nexus-messages`,
   `groupKey=…demo-chat-1`, `android.title`/`android.text` carrying the sender and
   preview, and `actions=2`. A second message for the same chat **replaces** the
   record (same derived id) rather than stacking — the count stays at 1.
4. ⏳ Tap the notification → app opens on `/app/chat/<chatId>`. The record carries
   a `contentIntent` into `MainActivity`; confirming the landing route needs a
   responsive SystemUI and a signed-in session.
5. ✅ The record exposes the two registered actions, `[0] "Open"` and
   `[1] "Dismiss"`, with `autoCancel` set so dismissing clears the entry.
6. ⏳ Force-stop the app (`adb shell am force-stop com.nexus.chat.app`), then tap
   a delivered notification → cold-start into the chat (cold-start buffering).
   Needs a responsive SystemUI.
7. ✅ `adb shell pm revoke com.nexus.chat.app android.permission.POST_NOTIFICATIONS`
   returns the app to importance `NONE` and nothing is delivered while ungranted.
   Note `pm revoke` makes `checkPermissions()` report `prompt` (a dialog denial
   reports `denied`), so the `reason: 'denied'` path is reached after a denial,
   not after a shell revoke. Either way the in-app popup is unaffected — it is
   dispatched independently of the native call.

Checks 4 and 6 could not be completed on this host: the emulator runs on 4 cores
/ 8 GB with ~1 GB free, and SystemUI ANRs under the load, so the notification
shade cannot be driven reliably. They still need a physical device or a machine
with more headroom.

### 6.3 iOS device / simulator (macOS required)

```bash
npm run build
npx cap sync ios                # runs pod install
npx cap open ios                # builds and runs from Xcode
```

Checks:

1. Permission prompt on first launch; denial path leaves the in-app popup working.
2. Notification appears in Notification Center; a second message from the same chat threads underneath the first.
3. Pull down / long-press the notification → **Open** and **Dismiss** buttons appear.
4. Tap → app opens on the matching chat.
5. Background the app (`Cmd+Shift+H`), receive a message → banner/lock-screen entry shows the sender and preview.
6. Terminate the app from the app switcher (scheduled notification path) → the scheduled notification still fires and opens the chat.

> The Android **compile** and the checks marked ✅ in §6.2 are verified in this
> workspace. The checks marked ⏳ in §6.2 need a responsive SystemUI (physical
> device or a host with more headroom). For iOS, `.github/workflows/ios-simulator.yml`
> builds the app on a `macos-latest` runner, embeds the notification pods and
> asserts `CapacitorLocalNotifications` / `CapacitorSplashScreen` are linked into
> `App.app` — the checks above still need a Mac or a real device to run.

---

## 7. Maintenance notes

- **Do not hand-edit** `capacitor.settings.gradle`, `capacitor.build.gradle`,
  `capacitor.plugins.json` or `ios/App/Podfile`; re-run `npx cap sync` after any
  plugin or web-asset change.
- **Bump the plugins together** with `@capacitor/core`, `@capacitor/android` and
  `@capacitor/ios` (currently 6.x). `npx cap doctor` reports mismatches.
- **Changing the channel** (sound, importance, vibration) cannot be applied to an
  already-created channel — Android caches channels per install. Bump
  `NATIVE_MESSAGE_CHANNEL` (e.g. `nexus-messages-v2`) to roll out new settings.
- **Custom sound:** place `*.wav` in `android/app/src/main/res/raw/` and add it to
  the `createChannel` call (`sound: 'filename_without_extension'`). iOS needs the
  same file in the app bundle.
- **Closed-app push** (server-initiated, app not running) is *not* covered by this
  integration — it needs Web Push/FCM and a sender. `showIncomingNotification` is
  the single place a push-driven delivery would plug in, and `public/sw.js`
  already handles `push` and `notificationclick`.
- **Tests:** keep `tests/nativeNotifications.test.mjs` green — it is the guard
  against accidentally importing a `@capacitor/*` package into the web bundle or
  bypassing the shared delivery path.
