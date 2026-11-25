// Native (Capacitor) half of the notification pipeline: system-tray notifications
// on Android and iOS through the official `@capacitor/local-notifications` plugin.
//
// Like `nativeCallBridge.js`, the plugin is reached through the global Capacitor
// bridge rather than an npm import, so the web bundle never gains a native-only
// dependency and every helper here is inert (`available === false`) on the web
// and in the Node test runner.

const PLUGIN_NAME = 'LocalNotifications'
const MAX_ANDROID_ID = 2147483647

// Android notification channel carrying all chat messages. Android 8+ ignores
// per-notification sound settings, so the channel owns the sound/vibration flags.
export const NATIVE_MESSAGE_CHANNEL = 'nexus-messages'
// Action type registered on both platforms so tray notifications expose the same
// "Open"/"Dismiss" buttons as the browser notifications.
export const NATIVE_MESSAGE_ACTION_TYPE = 'NEXUS_MESSAGE'

let cachedPlugin
let channelReady = false

function capacitorGlobal() {
  return globalThis.Capacitor
}

export function nativePlatform() {
  const cap = capacitorGlobal()
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
  return typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'native'
}

/**
 * Resolves the plugin proxy. Returns null anywhere the plugin is not installed,
 * which is what lets every caller fall back to the browser notification path.
 */
export function nativeNotificationsPlugin() {
  if (!nativePlatform()) return null
  if (cachedPlugin) return cachedPlugin
  const cap = capacitorGlobal()
  const existing = cap?.Plugins?.[PLUGIN_NAME]
  if (existing) {
    cachedPlugin = existing
    return cachedPlugin
  }
  if (typeof cap?.registerPlugin !== 'function') return null
  try {
    cachedPlugin = cap.registerPlugin(PLUGIN_NAME)
  } catch {
    return null
  }
  return cachedPlugin || null
}

export function isNativeNotificationsAvailable() {
  const plugin = nativeNotificationsPlugin()
  return Boolean(plugin && typeof plugin.schedule === 'function')
}

/**
 * Deterministic, non-negative 32-bit id (Android rejects larger values). Deriving
 * it from the chat id means a newer message from the same chat replaces the older
 * tray entry instead of stacking duplicates.
 */
export function toNotificationId(seed) {
  const value = String(seed ?? '')
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  const id = Math.abs(hash) % MAX_ANDROID_ID
  return id === 0 ? 1 : id
}

/** Normalizes a stored extra payload into the shape the action handler expects. */
export function parseNotificationExtra(extra) {
  if (!extra || typeof extra !== 'object') return { url: '/app' }
  const parsed = { url: typeof extra.url === 'string' && extra.url ? extra.url : '/app' }
  if (extra.chatId) parsed.chatId = String(extra.chatId)
  return parsed
}

export async function ensureNativeNotificationPermission() {
  const plugin = nativeNotificationsPlugin()
  if (!plugin || typeof plugin.checkPermissions !== 'function') {
    return { granted: false, status: 'unavailable' }
  }
  try {
    let status = await plugin.checkPermissions()
    if (status?.display !== 'granted') status = await plugin.requestPermissions()
    const display = status?.display || 'denied'
    return { granted: display === 'granted', status: display }
  } catch (error) {
    return { granted: false, status: 'error', error }
  }
}

/** Creates the Android message channel once, ignoring the already-exists error. */
export async function ensureNativeNotificationChannel() {
  const plugin = nativeNotificationsPlugin()
  if (!plugin || nativePlatform() !== 'android') return false
  if (channelReady) return true
  try {
    if (typeof plugin.listChannels === 'function') {
      const { channels } = await plugin.listChannels()
      if (channels?.some((channel) => channel.id === NATIVE_MESSAGE_CHANNEL)) {
        channelReady = true
        return true
      }
    }
    await plugin.createChannel({
      id: NATIVE_MESSAGE_CHANNEL,
      name: 'Messages',
      description: 'New chat messages',
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: '#0ea5e9',
    })
    channelReady = true
    return true
  } catch {
    return false
  }
}

/** Registers the iOS/Android action buttons used by tray notifications. */
export async function registerNativeNotificationActions() {
  const plugin = nativeNotificationsPlugin()
  if (!plugin || typeof plugin.registerActionTypes !== 'function') return false
  try {
    await plugin.registerActionTypes({
      types: [
        {
          id: NATIVE_MESSAGE_ACTION_TYPE,
          actions: [
            { id: 'open', title: 'Open', foreground: true },
            { id: 'dismiss', title: 'Dismiss', destructive: true },
          ],
          iosHiddenPreviewsBodyPlaceholder: 'New message',
          iosCustomDismissAction: true,
        },
      ],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Displays (or schedules) a system-tray notification.
 *
 * @returns {Promise<{delivered: boolean, reason?: string, error?: unknown}>}
 *   `reason` is `unavailable` when the plugin is missing (web/test), `denied`
 *   when the user refused the permission, and `error` when the native call threw.
 */
export async function showNativeNotification({ id, tag, chatId, title, body, url, scheduledAt, silent }) {
  if (!isNativeNotificationsAvailable()) return { delivered: false, reason: 'unavailable' }

  const permission = await ensureNativeNotificationPermission()
  if (!permission.granted) return { delivered: false, reason: 'denied' }

  const platform = nativePlatform()
  // Android drops notifications whose channel does not exist yet, so make sure
  // the channel is in place before the very first message arrives.
  if (platform === 'android') await ensureNativeNotificationChannel()

  const groupKey = chatId || tag
  const notification = {
    id: toNotificationId(groupKey || id || Date.now()),
    title: title || 'Nexus Chat',
    body: body || 'You received a new message.',
    largeBody: body || undefined,
    actionTypeId: NATIVE_MESSAGE_ACTION_TYPE,
    extra: { url: url || '/app', chatId: groupKey ? String(groupKey) : undefined },
    autoCancel: true,
  }

  if (platform === 'android') {
    notification.channelId = NATIVE_MESSAGE_CHANNEL
    if (groupKey) notification.group = String(groupKey)
  } else {
    if (groupKey) notification.threadIdentifier = String(groupKey)
    if (silent) notification.silent = true
  }

  if (scheduledAt) {
    notification.schedule = { at: new Date(scheduledAt), allowWhileIdle: true }
  }

  try {
    await nativeNotificationsPlugin().schedule({ notifications: [notification] })
    return { delivered: true }
  } catch (error) {
    return { delivered: false, reason: 'error', error }
  }
}

// Buffers the most recent tray interaction so a cold start (app launched by
// tapping a notification) is not lost before the React layer subscribes.
let pendingAction = null
let actionSubscriber = null
let listenersAttached = false

/** Subscribes to tray interactions; replays a buffered cold-start action. */
export function onNativeNotificationAction(handler) {
  actionSubscriber = handler
  if (pendingAction && handler) {
    const buffered = pendingAction
    pendingAction = null
    handler(buffered)
  }
  return () => {
    if (actionSubscriber === handler) actionSubscriber = null
  }
}

export function resetNativeNotificationState() {
  pendingAction = null
  actionSubscriber = null
  listenersAttached = false
  channelReady = false
  cachedPlugin = undefined
}

/**
 * Idempotent bootstrap: creates the Android channel, registers action buttons and
 * attaches the native event listeners. Call as early as possible (before render)
 * so notifications that launch the app are not missed.
 */
export async function initializeNativeNotifications() {
  if (!isNativeNotificationsAvailable() || listenersAttached) return false
  listenersAttached = true

  const plugin = nativeNotificationsPlugin()
  await ensureNativeNotificationChannel()
  await registerNativeNotificationActions()

  try {
    if (typeof plugin.addListener !== 'function') return false
    await plugin.addListener('localNotificationActionPerformed', (event) => {
      const actionId = event?.actionId
      // The user swiped/pressed Dismiss: nothing to open.
      if (actionId === 'dismiss') return
      const action = {
        actionId: actionId || 'tap',
        ...parseNotificationExtra(event?.notification?.extra),
      }
      if (actionSubscriber) actionSubscriber(action)
      else pendingAction = action
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nexus:notification-opened', { detail: action }))
      }
    })
    await plugin.addListener('localNotificationReceived', (notification) => {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent('nexus:local-notification-received', { detail: notification }))
    })
    return true
  } catch {
    listenersAttached = false
    return false
  }
}
