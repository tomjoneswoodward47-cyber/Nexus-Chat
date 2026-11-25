/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, X } from 'lucide-react'
import { attachmentPreviewKind } from '../../lib/chatAttachments'

const EXIT_ANIMATION_MS = 180

function isSafeMediaUrl(value) {
  if (!value) return false
  try {
    const url = new URL(value, window.location.origin)
    return ['http:', 'https:', 'blob:'].includes(url.protocol)
  } catch {
    return false
  }
}

export default function MediaPreviewModal({ open, onClose, type, fileName, mediaUrl, mediaError, hasSource }) {
  const closeButtonRef = useRef(null)
  const previousFocusRef = useRef(null)
  const [previewError, setPreviewError] = useState('')
  // The modal stays mounted briefly after `open` flips to false so the exit
  // animation can play before the node is removed.
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const previewKind = attachmentPreviewKind(type, fileName)
  const safeUrl = isSafeMediaUrl(mediaUrl) ? mediaUrl : null
  const title = fileName || 'Attachment preview'

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (!mounted) return undefined
    setClosing(true)
    const timer = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, EXIT_ANIMATION_MS)
    return () => clearTimeout(timer)
  }, [open, mounted])

  // The modal is portaled to <body> because message rows carry a retained
  // transform (the `chat-enter` animation keeps `translateY(0)` via
  // `animation-fill-mode: both`). A transformed ancestor becomes the containing
  // block for `position: fixed`, which would otherwise trap the overlay inside
  // the message bubble instead of covering the viewport.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    previousFocusRef.current = document.activeElement
    closeButtonRef.current?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    // Lock background scrolling while the preview is open so the page behind the
    // modal cannot drift on touch devices.
    const { body } = document
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      body.style.overflow = previousOverflow
      const previous = previousFocusRef.current
      if (previous && typeof previous.focus === 'function') previous.focus()
    }
  }, [open, onClose])

  useEffect(() => {
    if (open) setPreviewError('')
  }, [open, mediaUrl])

  if (!mounted || typeof document === 'undefined') return null

  const failed = mediaError
    || previewError
    || (mediaUrl && !safeUrl ? 'This attachment URL is invalid.' : '')
    || (!hasSource ? 'This message has no attachment to preview.' : '')

  const dialog = (
    <div
      className={`fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6 ${
        closing ? 'animate-out fade-out duration-150' : 'animate-in fade-in duration-200'
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="media-preview-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className={`flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl ${
          closing ? 'animate-out zoom-out-95 duration-150' : 'animate-in zoom-in-95 duration-200'
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id="media-preview-title" className="min-w-0 truncate text-sm font-semibold sm:text-base">{title}</h2>
          <div className="flex shrink-0 items-center gap-2">
            {safeUrl && (
              <a
                href={safeUrl}
                download={fileName || undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Download ${title}`}
                className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-border px-3 text-sm hover:bg-muted"
              >
                <Download className="h-4 w-4" />
                <span>Download</span>
              </a>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close attachment preview"
              className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-3 sm:p-5">
          {failed ? (
            <div className="max-w-md text-center">
              <p role="alert" className="text-sm text-destructive">{failed}</p>
              {safeUrl && <p className="mt-2 text-sm text-muted-foreground">You can still download the attachment.</p>}
            </div>
          ) : !safeUrl ? (
            <p role="status" className="text-sm text-muted-foreground">Loading attachment preview…</p>
          ) : previewKind === 'image' ? (
            <img
              src={safeUrl}
              alt={title}
              decoding="async"
              onError={() => setPreviewError('The image could not be loaded.')}
              className="max-h-[75dvh] max-w-full rounded object-contain"
            />
          ) : previewKind === 'video' ? (
            <video
              src={safeUrl}
              controls
              playsInline
              preload="metadata"
              onError={() => setPreviewError('The video could not be played.')}
              className="max-h-[75dvh] max-w-full rounded"
            />
          ) : previewKind === 'pdf' || previewKind === 'text' ? (
            <iframe
              src={safeUrl}
              title={`${title} preview`}
              referrerPolicy="no-referrer"
              className="h-[75dvh] w-full rounded border border-border bg-white"
            />
          ) : (
            <div className="max-w-md text-center">
              <p className="text-sm text-muted-foreground">
                This file format can’t be previewed in the browser. Download it to open it with a compatible app.
              </p>
              <a
                href={safeUrl}
                download={fileName || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                <ExternalLink className="h-4 w-4" />
                Download file
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
