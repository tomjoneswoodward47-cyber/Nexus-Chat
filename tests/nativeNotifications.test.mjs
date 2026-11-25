import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  NATIVE_MESSAGE_ACTION_TYPE,
  NATIVE_MESSAGE_CHANNEL,
  ensureNativeNotificationChannel,
  ensureNativeNotificationPermission,
  initializeNativeNotifications,
  isNativeNotificationsAvailable,
  nativeNotificationsPlugin,
  onNativeNotificationAction,
  parseNotificationExtra,
  registerNativeNotificationActions,
  resetNativeNotificationState,
  showNativeNotification,
  toNotificationId,
} from '../src/lib/nativeNotifications.js'
import { showIncomingNotification } from '../src/lib/notifications.js'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const capacitorConfig = read('../capacitor.config.json')
const androidManifest = read('../android/app/src/main/AndroidManifest.xml')
const main = read('../src/main.jsx')
const layout = read('../src/layouts/ChatLayout.jsx')

// Saves and restores a global so each test can stub browser/native APIs safely.
function setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}

// Minimal stand-in for the Capacitor global plus the LocalNotifications plugin
// proxy, mimicking the proxy Capacitor builds from the native plugin headers.
function stubCapacitor(platform = 'android', overrides = {}) {
  const calls = { registerPlugin: [], schedule: [], createChannel: [], registerActionTypes: [], listChannels: 0 }
  const listeners = {}

  const plugin = {
    schedule: async (options) => { calls.schedule.push(options); return { notifications: options.notifications } },
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    listChannels: async () => { calls.listChannels += 1; return { channels: [] } },
    createChannel: async (channel) => { calls.createChannel.push(channel) },
    registerActionTypes: async (options) => { calls.registerActionTypes.push(options) },
    addListener: async (eventName, handler) => { listeners[eventName] = handler; return { remove: async () => {} } },
    ...overrides,
  }

  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    registerPlugin: (name) => { calls.registerPlugin.push(name); return plugin },
    Plugins: {},
  }

  return { Capacitor, plugin, calls, listeners }
}

function stubWindow() {
  const events = []
  const restores = [
    setGlobal('CustomEvent', class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail }
    }),
    setGlobal('window', { dispatchEvent: (event) => { events.push(event); return true } }),
  ]
  return { events, restore: () => restores.reverse().forEach((restore) => restore()) }
}

test.afterEach(() => resetNativeNotificationState())

test('the integration is inert without a Capacitor native runtime', async () => {
  assert.equal(nativeNotificationsPlugin(), null)
  assert.equal(isNativeNotificationsAvailable(), false)
  assert.deepEqual(await showNativeNotification({ title: 'x' }), { delivered: false, reason: 'unavailable' })
  assert.deepEqual(await ensureNativeNotificationChannel(), false)
  assert.deepEqual(await ensureNativeNotificationPermission(), { granted: false, status: 'unavailable' })
  assert.equal(await initializeNativeNotifications(), false)
})

test('the plugin is resolved through the global Capacitor bridge, never an npm import', () => {
  const pluginSource = fs.readFileSync(new URL('../src/lib/nativeNotifications.js', import.meta.url), 'utf8')
  assert.doesNotMatch(pluginSource, /from '@capacitor\//)
  assert.match(pluginSource, /globalThis\.Capacitor/)
})

test('an existing Capacitor.Plugins entry is preferred over registerPlugin', async () => {
  const { Capacitor, plugin, calls } = stubCapacitor()
  Capacitor.Plugins.LocalNotifications = plugin
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.equal(isNativeNotificationsAvailable(), true)
    assert.equal(nativeNotificationsPlugin(), plugin)
    assert.deepEqual(calls.registerPlugin, [])
  } finally {
    restore()
  }
})

test('notification ids are deterministic, positive and 32-bit safe', () => {
  assert.equal(toNotificationId('chat-1'), toNotificationId('chat-1'))
  assert.notEqual(toNotificationId('chat-1'), toNotificationId('chat-2'))
  for (const seed of ['', 'chat-1', 'a-very-long-chat-identifier-that-keeps-going', '💬']) {
    const id = toNotificationId(seed)
    assert.ok(Number.isInteger(id) && id > 0 && id <= 2147483647, `id for ${seed} was ${id}`)
  }
  assert.equal(toNotificationId(''), 1)
})

test('notification payloads are normalized with a safe default route', () => {
  assert.deepEqual(parseNotificationExtra(undefined), { url: '/app' })
  assert.deepEqual(parseNotificationExtra({}), { url: '/app' })
  assert.deepEqual(parseNotificationExtra({ url: '/app/chat/9', chatId: 9 }), { url: '/app/chat/9', chatId: '9' })
})

test('permissions flow through check then request and fail closed on error', async () => {
  const { Capacitor } = stubCapacitor('android', {
    checkPermissions: async () => ({ display: 'prompt' }),
    requestPermissions: async () => ({ display: 'denied' }),
  })
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.deepEqual(await ensureNativeNotificationPermission(), { granted: false, status: 'denied' })
  } finally {
    restore()
  }

  resetNativeNotificationState()
  const failing = stubCapacitor('android', {
    checkPermissions: async () => { throw new Error('bridge down') },
  })
  const restoreFailing = setGlobal('Capacitor', failing.Capacitor)
  try {
    const result = await ensureNativeNotificationPermission()
    assert.equal(result.granted, false)
    assert.equal(result.status, 'error')
  } finally {
    restoreFailing()
  }
})

test('the Android channel is created once and skipped on iOS', async () => {
  const android = stubCapacitor('android')
  const restoreAndroid = setGlobal('Capacitor', android.Capacitor)
  try {
    assert.equal(await ensureNativeNotificationChannel(), true)
    assert.equal(android.calls.createChannel.length, 1)
    assert.equal(android.calls.createChannel[0].id, NATIVE_MESSAGE_CHANNEL)
    assert.equal(android.calls.createChannel[0].importance, 4)
    // Second call reuses the cached channel, so no extra bridge traffic.
    assert.equal(await ensureNativeNotificationChannel(), true)
    assert.equal(android.calls.listChannels, 1)
  } finally {
    restoreAndroid()
  }

  resetNativeNotificationState()
  const ios = stubCapacitor('ios')
  const restoreIos = setGlobal('Capacitor', ios.Capacitor)
  try {
    assert.equal(await ensureNativeNotificationChannel(), false)
    assert.equal(ios.calls.createChannel.length, 0)
  } finally {
    restoreIos()
  }
})

test('action buttons are registered with Open and Dismiss', async () => {
  const { Capacitor, calls } = stubCapacitor()
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.equal(await registerNativeNotificationActions(), true)
    const [types] = calls.registerActionTypes
    assert.equal(types.types[0].id, NATIVE_MESSAGE_ACTION_TYPE)
    assert.deepEqual(types.types[0].actions.map((action) => action.id), ['open', 'dismiss'])
  } finally {
    restore()
  }
})

test('Android notifications use the message channel and group by chat', async () => {
  const { Capacitor, calls } = stubCapacitor('android')
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    const result = await showNativeNotification({
      title: 'Ada', body: 'See you soon', chatId: 'chat-7', url: '/app/chat/chat-7',
    })
    assert.deepEqual(result, { delivered: true })
    const [notification] = calls.schedule[0].notifications
    assert.equal(notification.channelId, NATIVE_MESSAGE_CHANNEL)
    assert.equal(notification.group, 'chat-7')
    assert.equal(notification.actionTypeId, NATIVE_MESSAGE_ACTION_TYPE)
    assert.deepEqual(notification.extra, { url: '/app/chat/chat-7', chatId: 'chat-7' })
    assert.equal(notification.schedule, undefined)
  } finally {
    restore()
  }
})

test('iOS notifications thread by chat and support scheduling', async () => {
  const { Capacitor, calls } = stubCapacitor('ios')
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    const when = Date.now() + 60_000
    await showNativeNotification({ title: 'Ada', body: 'Reminder', chatId: 'chat-9', scheduledAt: when })
    const [notification] = calls.schedule[0].notifications
    assert.equal(notification.channelId, undefined)
    assert.equal(notification.threadIdentifier, 'chat-9')
    assert.equal(notification.schedule.at.getTime(), when)
    assert.equal(notification.schedule.allowWhileIdle, true)
  } finally {
    restore()
  }
})

test('a denied permission blocks delivery and reports the reason', async () => {
  const { Capacitor, calls } = stubCapacitor('android', {
    checkPermissions: async () => ({ display: 'denied' }),
    requestPermissions: async () => ({ display: 'denied' }),
  })
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.deepEqual(await showNativeNotification({ title: 'x', body: 'y' }), { delivered: false, reason: 'denied' })
    assert.equal(calls.schedule.length, 0)
  } finally {
    restore()
  }
})

test('a native scheduling error is caught instead of throwing', async () => {
  const { Capacitor } = stubCapacitor('android', {
    schedule: async () => { throw new Error('no exact alarm permission') },
  })
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    const result = await showNativeNotification({ title: 'x', body: 'y' })
    assert.equal(result.delivered, false)
    assert.equal(result.reason, 'error')
  } finally {
    restore()
  }
})

test('a cold start tap is buffered until the app subscribes', async () => {
  const { Capacitor, listeners } = stubCapacitor('android')
  const browser = stubWindow()
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.equal(await initializeNativeNotifications(), true)
    // The user tapped the tray notification before React mounted.
    listeners.localNotificationActionPerformed({ actionId: 'tap', notification: { extra: { url: '/app/chat/4', chatId: '4' } } })

    let received = null
    const detach = onNativeNotificationAction((action) => { received = action })
    assert.deepEqual(received, { actionId: 'tap', url: '/app/chat/4', chatId: '4' })
    assert.equal(browser.events.at(-1).type, 'nexus:notification-opened')
    detach()
  } finally {
    restore()
    browser.restore()
  }
})

test('dismiss actions never open a chat', async () => {
  const { Capacitor, listeners } = stubCapacitor('android')
  const browser = stubWindow()
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    await initializeNativeNotifications()
    let calls = 0
    const detach = onNativeNotificationAction(() => { calls += 1 })
    listeners.localNotificationActionPerformed({ actionId: 'dismiss', notification: { extra: { url: '/app/chat/4' } } })
    assert.equal(calls, 0)
    listeners.localNotificationActionPerformed({ actionId: 'open', notification: { extra: { url: '/app/chat/4' } } })
    assert.equal(calls, 1)
    detach()
  } finally {
    restore()
    browser.restore()
  }
})

test('bootstrap is idempotent so repeated mounts do not double-register listeners', async () => {
  const { Capacitor, calls } = stubCapacitor('android')
  const browser = stubWindow()
  const restore = setGlobal('Capacitor', Capacitor)
  try {
    assert.equal(await initializeNativeNotifications(), true)
    assert.equal(await initializeNativeNotifications(), false)
    assert.equal(calls.registerActionTypes.length, 1)
  } finally {
    restore()
    browser.restore()
  }
})

test('incoming messages prefer the native tray and skip the web notification', async () => {
  const { Capacitor, calls } = stubCapacitor('android')
  const shown = []
  const restores = [
    setGlobal('Capacitor', Capacitor),
    setGlobal('CustomEvent', class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail }
    }),
    setGlobal('window', {
      dispatchEvent: () => true,
      Notification: Object.assign(
        function Notification(title, options) { shown.push({ title, options }) },
        { permission: 'granted' },
      ),
    }),
  ]
  try {
    showIncomingNotification({ title: 'Ada', preview: 'Hi', chatId: 'chat-3' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(shown.length, 0)
    assert.equal(calls.schedule.length, 1)
    assert.equal(calls.schedule[0].notifications[0].extra.url, '/app/chat/chat-3')
  } finally {
    restores.reverse().forEach((restore) => restore())
  }
})

test('native configuration is committed for both platforms', () => {
  assert.match(capacitorConfig, /"LocalNotifications"/)
  assert.match(capacitorConfig, /"smallIcon": "ic_stat_nexus"/)
  assert.match(androidManifest, /android\.permission\.POST_NOTIFICATIONS/)
  assert.match(androidManifest, /android\.permission\.SCHEDULE_EXACT_ALARM/)
  assert.match(androidManifest, /android\.permission\.VIBRATE/)
  // Bootstrapped before render so a launching notification is never missed.
  assert.match(main, /void initializeNativeNotifications\(\)/)
  // Tray taps are routed into the matching chat route.
  assert.match(layout, /onNativeNotificationAction\(\(\{ url \}\) => \{/)
})
