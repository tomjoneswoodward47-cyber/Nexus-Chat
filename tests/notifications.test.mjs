import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  NOTIFICATION_ACTIONS,
  buildMessageNotification,
  resolveNotificationPreferences,
  showIncomingNotification,
} from '../src/lib/notifications.js'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const persistence = read('../src/lib/persistence.js')
const sw = read('../public/sw.js')
const stack = read('../src/components/chat/NotificationStack.jsx')
const layout = read('../src/layouts/ChatLayout.jsx')

// Saves and restores a global so each test can stub browser APIs safely.
function setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}

// Builds a minimal browser-like environment: a window with a localStorage that
// backs the flat settings keys, plus a recorded event log.
function stubBrowser({ storage = {}, showNotification } = {}) {
  const store = new Map(Object.entries(storage).map(([key, value]) => [key, JSON.stringify(value)]))
  const events = []
  const shown = []

  const NotificationStub = Object.assign(
    function Notification(title, options) { shown.push({ title, options, via: 'constructor' }) },
    { permission: 'granted', requestPermission: async () => 'granted' },
  )

  const restores = [
    setGlobal('window', {
      dispatchEvent: (event) => { events.push(event); return true },
      localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null) },
      Notification: NotificationStub,
    }),
    setGlobal('CustomEvent', class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail }
    }),
    setGlobal('Notification', NotificationStub),
  ]

  if (showNotification) {
    restores.push(setGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => ({ showNotification: async (title, options) => shown.push({ title, options, via: 'worker' }) }),
        ready: Promise.resolve(null),
      },
    }))
  } else {
    restores.push(setGlobal('navigator', { serviceWorker: null }))
  }

  return {
    events,
    shown,
    restore: () => restores.reverse().forEach((restore) => restore()),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('preview copy matches the message type across every notification surface', () => {
  assert.deepEqual(buildMessageNotification({ type: 'text', content: 'Hello there' }), {
    title: 'New message', preview: 'Hello there', type: 'message',
  })
  assert.equal(buildMessageNotification({ type: 'text', encrypted: true, content: 'ciphertext' }).preview, 'Encrypted message')
  // An encrypted payload never leaks its content, even for attachments.
  assert.equal(buildMessageNotification({ type: 'image', encrypted: true, file_name: 'a.png' }).preview, 'Encrypted message')
  assert.equal(buildMessageNotification({ type: 'voice' }).preview, 'Voice message')
  assert.equal(buildMessageNotification({ type: 'image', file_name: 'holiday.png' }).preview, 'Photo: holiday.png')
  assert.equal(buildMessageNotification({ type: 'file', file_name: 'notes.pdf' }).preview, 'Attachment: notes.pdf')
  assert.equal(buildMessageNotification({ type: 'file' }).preview, 'New attachment received')
  assert.equal(buildMessageNotification({ type: 'text' }).preview, 'New message')
  assert.equal(buildMessageNotification({ type: 'text' }, 'Ada Lovelace').title, 'Ada Lovelace')
})

test('mute, tone and volume preferences are read from storage with sane defaults', () => {
  // Without a browser environment the defaults are used.
  assert.deepEqual(resolveNotificationPreferences(), { sound: true, tone: 'chime', volume: 0.5 })

  const browser = stubBrowser({ storage: { notificationSound: false, notificationTone: 'pop', notificationVolume: 0.2 } })
  try {
    assert.deepEqual(resolveNotificationPreferences(), { sound: false, tone: 'pop', volume: 0.2 })
  } finally {
    browser.restore()
  }
})

test('a muted user hears nothing but still sees the popup and system notification', async () => {
  const browser = stubBrowser({ storage: { notificationSound: false } })
  try {
    const detail = showIncomingNotification({ title: 'New message', preview: 'Hi', tag: 'chat-1' })
    assert.equal(browser.events.length, 1)
    assert.equal(browser.events[0].type, 'nexus:incoming-notification')
    assert.equal(browser.events[0].detail.preview, 'Hi')
    assert.equal(detail.tag, 'chat-1')
    await flush()
    // Delivery still happens; only the tone is suppressed.
    assert.equal(browser.shown.length, 1)
  } finally {
    browser.restore()
  }
})

test('incoming notifications dispatch the in-app popup event and carry defaults', () => {
  const browser = stubBrowser()
  try {
    const detail = showIncomingNotification({ preview: 'Pick up where you left off' })
    assert.equal(browser.events.length, 1)
    assert.equal(detail.type, 'message')
    assert.equal(detail.avatarUrl, '/nexus-logo.svg')
    assert.match(detail.id, /^\d+-[a-z0-9]+$/)
  } finally {
    browser.restore()
  }
})

test('system notifications go through the service worker with action buttons', async () => {
  const browser = stubBrowser({ showNotification: true })
  try {
    showIncomingNotification({ title: 'New message', preview: 'See you soon', tag: 'chat-9' })
    await flush()
    assert.equal(browser.shown.length, 1)
    const [{ title, options, via }] = browser.shown
    assert.equal(via, 'worker')
    assert.equal(title, 'New message')
    assert.equal(options.body, 'See you soon')
    assert.equal(options.tag, 'chat-9')
    assert.deepEqual(options.actions, NOTIFICATION_ACTIONS)
    assert.equal(options.data.url, '/app')
  } finally {
    browser.restore()
  }
})

test('system notifications fall back to the Notification constructor without a worker', async () => {
  const browser = stubBrowser()
  try {
    showIncomingNotification({ title: 'New message', preview: 'Fallback path' })
    await flush()
    assert.equal(browser.shown.length, 1)
    assert.equal(browser.shown[0].via, 'constructor')
    assert.equal(browser.shown[0].options.body, 'Fallback path')
  } finally {
    browser.restore()
  }
})

test('message polling and realtime both route through showIncomingNotification', () => {
  assert.match(persistence, /import \{ buildMessageNotification, showIncomingNotification \} from '\.\/notifications\.js'/)
  // Every incoming message notification goes through the shared helper so the
  // popup, the system notification and the sound stay in sync.
  assert.match(persistence, /for \(const notification of notifications\) showIncomingNotification\(notification\)/)
  assert.match(persistence, /showIncomingNotification\(\{ \.\.\.buildMessageNotification\(row\), tag: String\(row\.chat_id\), chatId: String\(row\.chat_id\) \}\)/)
  // The raw event must never be emitted directly, or the OS notification and
  // sound would be skipped.
  assert.doesNotMatch(persistence, /emit\('nexus:incoming-notification'/)
})

test('the service worker handles notification clicks and push delivery', () => {
  assert.match(sw, /addEventListener\('notificationclick'/)
  assert.match(sw, /event\.action === 'dismiss'/)
  assert.match(sw, /self\.clients\.openWindow/)
  assert.match(sw, /addEventListener\('push'/)
  assert.match(sw, /self\.registration\.showNotification/)
  assert.match(sw, /action: 'open'/)
})

test('the in-app stack renders in every layout with a manual dismiss control', () => {
  assert.match(layout, /<NotificationStack \/>/)
  assert.match(stack, /'nexus:incoming-notification'/)
  assert.match(stack, /'nexus:system-notification'/)
  assert.match(stack, /aria-label="Dismiss notification"/)
  assert.match(stack, /pointer-events-auto/)
  assert.match(stack, /role="status"/)
})
