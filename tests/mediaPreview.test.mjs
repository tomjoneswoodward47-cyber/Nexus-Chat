import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attachmentPreviewKind } from '../src/lib/chatAttachments.js'

function sourceOf(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const MODAL = sourceOf('../src/components/chat/MediaPreviewModal.jsx')
const BUBBLE = sourceOf('../src/components/chat/MessageBubble.jsx')

// The modal used to render inside each message row, whose `chat-enter` animation
// keeps a transform (fill-mode `both`) and therefore becomes the containing
// block for `position: fixed`. That trapped the overlay inside the message
// bubble. It must be portaled to the document body instead.
test('the preview modal is portaled to the document body', () => {
  assert.ok(MODAL.includes("import { createPortal } from 'react-dom'"))
  assert.ok(MODAL.includes('createPortal(dialog, document.body)'))
})

test('every previewable attachment type has a render branch', () => {
  // Preview kind resolution for the supported upload set.
  assert.equal(attachmentPreviewKind('image', 'photo.jpg'), 'image')
  assert.equal(attachmentPreviewKind('sticker', 'anim.gif'), 'image')
  assert.equal(attachmentPreviewKind('video', 'clip.mp4'), 'video')
  assert.equal(attachmentPreviewKind('audio', 'song.mp3'), 'audio')
  assert.equal(attachmentPreviewKind('voice', 'note.wav'), 'audio')
  assert.equal(attachmentPreviewKind('document', 'report.pdf'), 'pdf')
  assert.equal(attachmentPreviewKind('file', 'notes.txt'), 'text')
  assert.equal(attachmentPreviewKind('document', 'report.docx'), 'download')
  assert.equal(attachmentPreviewKind('file', 'unknown.bin'), 'download')

  // The modal renders each previewable kind with the right element.
  assert.ok(MODAL.includes("previewKind === 'image'"))
  assert.ok(MODAL.includes("previewKind === 'video'"))
  assert.ok(MODAL.includes("previewKind === 'pdf' || previewKind === 'text'"))
  assert.ok(MODAL.includes('<img'))
  assert.ok(MODAL.includes('<video'))
  assert.ok(MODAL.includes('<iframe'))
  // Audio is playable inline in the message list and must never open the modal.
  assert.ok(!MODAL.includes("previewKind === 'audio'"))
  assert.ok(!MODAL.includes('<audio'))
})

test('protected media playback is enabled for in-modal video', () => {
  assert.ok(MODAL.includes('playsInline'))
  assert.ok(MODAL.includes('preload="metadata"'))
  assert.ok(MODAL.includes('controls'))
})

test('each preview offers a download action, including unsupported formats', () => {
  assert.ok(MODAL.includes('download={fileName || undefined}'))
  // The generic fallback still exposes the file so it is never a dead end.
  assert.ok(MODAL.includes('Download file'))
  assert.ok(MODAL.includes('ExternalLink'))
})

test('the modal is dismissible and accessible', () => {
  assert.ok(MODAL.includes('aria-modal="true"'))
  assert.ok(MODAL.includes('role="dialog"'))
  assert.ok(MODAL.includes("event.key === 'Escape'"))
  assert.ok(MODAL.includes('if (event.target === event.currentTarget) onClose()'))
  assert.ok(MODAL.includes('aria-label="Close attachment preview"'))
  // Focus lands on the close control and returns to the trigger on dismissal.
  assert.ok(MODAL.includes('closeButtonRef.current?.focus()'))
  assert.ok(MODAL.includes('previousFocusRef.current'))
})

test('background scrolling is locked while the preview is open', () => {
  assert.ok(MODAL.includes("body.style.overflow = 'hidden'"))
  assert.ok(MODAL.includes('body.style.overflow = previousOverflow'))
})

test('unsafe or missing sources fail closed with a message and a download', () => {
  assert.ok(MODAL.includes("['http:', 'https:', 'blob:'].includes(url.protocol)"))
  assert.ok(MODAL.includes('This attachment URL is invalid.'))
  assert.ok(MODAL.includes('This message has no attachment to preview.'))
})

test('the modal animates open and closed without leaving a stuck overlay', () => {
  assert.ok(MODAL.includes('animate-in fade-in'))
  assert.ok(MODAL.includes('animate-out fade-out'))
  assert.ok(MODAL.includes('animate-in zoom-in-95'))
  assert.ok(MODAL.includes('animate-out zoom-out-95'))
  // The exit animation must complete before the node is removed.
  assert.ok(MODAL.includes('EXIT_ANIMATION_MS'))
  assert.ok(MODAL.includes('if (!mounted'))
})

// The message list used to render full image/video/audio content inline. Every
// media and file attachment now shows a compact tile (type icon, file name, and
// size) that opens the preview modal on click.
test('attachments render as compact tiles instead of full inline content', () => {
  assert.ok(BUBBLE.includes('message.file_size ? formatBytes(message.file_size)'))
  assert.ok(BUBBLE.includes('Tap to preview'))
  for (const type of ["case 'image':", "case 'video':", "case 'document':", "case 'file':"]) {
    assert.ok(BUBBLE.includes(type), `the bubble must handle ${type}`)
  }
  // Images and videos are no longer rendered inline in the list.
  assert.ok(!BUBBLE.includes('<img'), 'the list must not render a full inline image')
  assert.ok(!BUBBLE.includes('<video'), 'the list must not render a full inline video')
})

test('audio stays playable inline and never opens the preview modal', () => {
  // The inline <audio> element is still rendered for playback.
  assert.ok(BUBBLE.includes('<audio'))
  // Scoped to the audio/voice branch: it must not wire up the modal trigger.
  const start = BUBBLE.indexOf("case 'audio':")
  const end = BUBBLE.indexOf("case 'sticker':")
  assert.ok(start >= 0 && end > start, 'expected an audio branch before the sticker branch')
  const audioBranch = BUBBLE.slice(start, end)
  assert.ok(!audioBranch.includes('openMediaPreview'))
  assert.ok(!audioBranch.includes('MediaPreviewModal'))
})
