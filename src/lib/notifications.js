import { playNotificationTone } from './notification-tones.js'
import { readFromStorageQuick } from './settings-store.js'
import {
  ensureNativeNotificationPermission,
  isNativeNotificationsAvailable,
  showNativeNotification,
} from './nativeNotifications.js'

// Buttons offered on system/Browser notifications that support them. The
// service worker (`public/sw.js`) handles `notificationclick` for these.
export const NOTIFICATION_ACTIONS = [
  { action: 'open', title: 'Open' },
  { action: 'dismiss', title: 'Dismiss' },
]

// Reads the sound preferences once so in-app and system notifications stay in
// sync with the settings panel: silence is respected and the chosen tone plays
// at the configured volume.
export function resolveNotificationPreferences() {
  return {
    sound: readFromStorageQuick('notificationSound', true) !== false,
    tone: readFromStorageQuick('notificationTone', 'chime'),
    volume: readFromStorageQuick('notificationVolume', 0.5),
  }
}

// Builds the title/preview pair shown in every notification surface (in-app
// stack, browser notification, mobile system tray) so the copy is identical
// everywhere. Attachments name their file when one is available.
export function buildMessageNotification(row, senderName) {
  const type = row?.type || 'text'
  let preview
  if (row?.encrypted) preview = 'Encrypted message'
  else if (type === 'text') preview = row?.content || 'New message'
  else if (type === 'voice') preview = 'Voice message'
  else if (type === 'image') preview = row?.file_name ? `Photo: ${row.file_name}` : 'Photo'
  else if (row?.file_name) preview = `Attachment: ${row.file_name}`
  else preview = 'New attachment received'
  return { title: senderName || 'New message', preview, type: 'message' }
}

export function isSystemNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

async function getServiceWorkerRegistration() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null
  try {
    return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready)
  } catch {
    return null
  }
}

// Delivers the notification through the native tray on Android/iOS, and through
// the service worker (falling back to the constructor) on the web. A failed
// native delivery falls through so the user still sees something.
async function createSystemNotification(detail) {
  if (isNativeNotificationsAvailable()) {
    const result = await showNativeNotification({
      id: detail.id,
      tag: detail.tag,
      chatId: detail.chatId,
      title: detail.title,
      body: detail.preview,
      url: detail.url,
    })
    if (result.delivered) return
  }

  if (!isSystemNotificationSupported() || Notification.permission !== 'granted') return

  const options = {
    body: detail.preview,
    icon: detail.avatarUrl || '/nexus-logo.svg',
    tag: detail.tag || undefined,
    data: { url: detail.url || '/app', notificationId: detail.id },
  }

  const registration = await getServiceWorkerRegistration()
  if (registration && typeof registration.showNotification === 'function') {
    try {
      await registration.showNotification(detail.title, { ...options, actions: NOTIFICATION_ACTIONS })
      return
    } catch {
      // Fall through to the constructor when the worker cannot show it.
    }
  }

  try {
    new Notification(detail.title, options)
  } catch {
    // Ignore OS notification failures (unsupported options, denied permission).
  }
}

function playNotificationSound() {
  if (typeof window === 'undefined') return
  const { sound, tone, volume } = resolveNotificationPreferences()
  if (!sound) return
  playNotificationTone(tone, volume)
}

export async function requestNotificationPermission() {
  // On Android/iOS the plugin owns the runtime permission prompt.
  if (isNativeNotificationsAvailable()) {
    const { granted, status } = await ensureNativeNotificationPermission()
    return granted ? 'granted' : status
  }
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      return Notification.permission
    }
  }
  return Notification.permission
}

function dispatch(detail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('nexus:incoming-notification', { detail }))
}

// In-app popup + sound + system notification for an incoming chat message.
// Routing every incoming message through here keeps the three surfaces in sync.
export function showIncomingNotification({ id, title, preview, avatarUrl, type = 'message', url, tag, chatId }) {
  const chatKey = chatId ? String(chatId) : undefined
  const detail = {
    id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    preview,
    avatarUrl: avatarUrl || '/nexus-logo.svg',
    type,
    url: url || (chatKey ? `/app/chat/${chatKey}` : '/app'),
    tag: tag || chatKey,
    chatId: chatKey,
  }

  dispatch(detail)
  void createSystemNotification(detail)
  playNotificationSound()
  return detail
}

export function showSystemNotification({ title, preview, avatarUrl, type = 'system' }) {
  const detail = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    preview,
    avatarUrl: avatarUrl || '/nexus-logo.svg',
    type,
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nexus:system-notification', { detail }))
  }
  void createSystemNotification(detail)
  playNotificationSound()
  return detail
}
