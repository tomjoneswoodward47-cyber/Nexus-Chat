/* eslint-disable react/prop-types */
import { memo, useCallback, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Check, CheckCheck, Copy, Expand, File, FileText, Image as ImageIcon, Music, Reply, SmilePlus, Video } from 'lucide-react'
import ChatButton from './ChatButton'
import MediaPreviewModal from './MediaPreviewModal'
import { useMediaUrl } from '../../hooks/useMediaUrl'
import { REACTIONS, decodeContent } from '../../lib/chatProtocol'
import { formatBytes } from '../../lib/chatAttachments'

function formatTime(dateString) {
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) {
      return '...'
    }
    return format(date, 'h:mm a')
  } catch {
    return '...'
  }
}

function MessageBubble({ message, isOwn, userId, onReact, onReply, reacting, receiptsEnabled = true }) {
  const [showReactions, setShowReactions] = useState(false)
  const [showMediaPreview, setShowMediaPreview] = useState(false)
  const [mediaError, setMediaError] = useState('')
  const [copied, setCopied] = useState(false)
  const decoded = decodeContent(message.content)
  const groups = REACTIONS.map(emoji => ({ emoji, users: (message.reactions || []).filter(r => r.emoji === emoji).map(r => r.userId) })).filter(r => r.users.length)
  const copyText = async () => {
    try { await navigator.clipboard.writeText(decoded.text); setCopied(true) } catch { setCopied(false) }
  }
  const timeLabel = useMemo(() => formatTime(message.created_at), [message.created_at])
  const isSticker = message.type === 'sticker'
  // `r2://` attachments resolve to a short-lived signed URL; everything else
  // (Supabase signed URLs, same-origin paths) is returned unchanged.
  const handleMediaUrlError = useCallback((error) => {
    setMediaError(error?.message || 'The attachment could not be loaded.')
  }, [])
  const mediaUrl = useMediaUrl(message.file_url, handleMediaUrlError)
  const openMediaPreview = useCallback(() => setShowMediaPreview(true), [])
  const closeMediaPreview = useCallback(() => setShowMediaPreview(false), [])

  const renderContent = useMemo(() => {
    const sizeLabel = message.file_size ? formatBytes(message.file_size) : ''
    const tapLabel = sizeLabel ? `${sizeLabel} · Tap to preview` : 'Tap to preview'
    // Attachments render as a compact tile (type icon, file name, size) instead
    // of their full content; clicking the tile opens the dedicated preview modal.
    const tile = (icon, fallbackLabel, ariaLabel) => (
      <button
        type="button"
        onClick={openMediaPreview}
        aria-label={ariaLabel}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-background/10 p-2 text-left transition-colors hover:bg-background/20 sm:gap-3 sm:p-3"
      >
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-background/20 sm:h-10 sm:w-10">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium sm:text-sm">{message.file_name || fallbackLabel}</span>
          <span className="block text-xs opacity-75">{tapLabel}</span>
        </span>
        <Expand className="h-3.5 w-3.5 flex-shrink-0 opacity-60" aria-hidden="true" />
      </button>
    )

    switch (message.type) {
      case 'text':
        return <p className="text-xs sm:text-sm whitespace-pre-wrap break-words leading-relaxed">{decoded.text}</p>

      case 'image':
        return tile(
          <ImageIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
          'Shared image',
          `Preview ${message.file_name || 'shared image'}`,
        )

      case 'video':
        return tile(
          <Video className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
          'Shared video',
          `Preview ${message.file_name || 'shared video'}`,
        )

      case 'audio':
      case 'voice':
        // Audio stays playable inline and never opens the preview modal.
        return (
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <Music className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {mediaUrl && (
              <audio
                src={mediaUrl}
                controls
                onError={() => setMediaError('The audio could not be played.')}
                className="h-8 w-52 min-w-0 max-w-full"
              />
            )}
            {message.duration && <span className="shrink-0 text-xs opacity-75">{message.duration}s</span>}
          </div>
        )

      case 'sticker':
        return (
          <span className="text-4xl sm:text-5xl leading-none select-none" role="img">
            {message.content}
          </span>
        )

      case 'document':
        return tile(
          <FileText className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
          'Document',
          `Preview ${message.file_name || 'document'}`,
        )

      case 'file':
        return tile(
          <File className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
          'Attachment',
          `Preview ${message.file_name || 'attachment'}`,
        )

      default:
        return <p className="text-xs sm:text-sm">{decoded.text}</p>
    }
  }, [message.type, message.content, message.file_name, message.file_size, message.duration, decoded.text, mediaUrl, openMediaPreview])

  return (
    <div id={`message-${message.id}`} className={`chat-enter flex ${isOwn ? 'justify-end' : 'justify-start'} px-0`}>
      <div
        className={
          isSticker
            ? 'min-w-0 max-w-[85%] sm:max-w-[70%]'
            : `min-w-0 max-w-[85%] sm:max-w-[65%] px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl ${
                isOwn
                  ? 'bg-primary text-primary-foreground rounded-tr-none shadow-sm'
                  : 'bg-muted text-foreground rounded-tl-none shadow-sm'
              }`
        }
      >
        {decoded.reply && <a href={`#message-${decoded.reply.id}`} className="block border-l-2 border-current bg-background/10 px-2 py-1 mb-2 rounded text-xs opacity-80 max-w-full truncate">{decoded.reply.preview}</a>}
        {renderContent}
        {mediaError && <p role="alert" className="mt-1 text-xs text-destructive">{mediaError}</p>}
        {!isSticker && (
          <div className={`text-xs mt-1 opacity-70 ${isOwn ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
            <span>{timeLabel}</span>
            {isOwn && (() => {
              if (receiptsEnabled && message.read) {
                return <CheckCheck className="inline w-3.5 h-3.5 ml-1 text-sky-300" aria-label="Read" title="Read" />
              }
              if (receiptsEnabled && message.delivered) {
                return <CheckCheck className="inline w-3.5 h-3.5 ml-1" aria-label="Delivered" title="Delivered" />
              }
              return <Check className="inline w-3.5 h-3.5 ml-1" aria-label="Sent" title="Sent" />
            })()}
          </div>
        )}
        <div className="flex items-center gap-1 mt-1" aria-label="Message actions">
          <ChatButton title="React to message" aria-expanded={showReactions} onClick={() => setShowReactions(!showReactions)} className={`!min-h-7 w-7 ${isOwn && !isSticker ? '!text-primary-foreground hover:!bg-background/10' : ''}`}><SmilePlus className="w-3.5 h-3.5" /></ChatButton>
          <ChatButton title="Reply to message" onClick={() => onReply?.({ ...message, content: decoded.text })} className={`!min-h-7 w-7 ${isOwn && !isSticker ? '!text-primary-foreground hover:!bg-background/10' : ''}`}><Reply className="w-3.5 h-3.5" /></ChatButton>
          {message.type === 'text' && <ChatButton title={copied ? 'Copied' : 'Copy message'} onClick={copyText} className={`!min-h-7 w-7 ${isOwn ? '!text-primary-foreground hover:!bg-background/10' : ''}`}>{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}</ChatButton>}
        </div>
        {showReactions && <div className="flex flex-wrap gap-1 p-1 mt-1 bg-popover text-popover-foreground rounded-lg border border-border chat-enter" aria-label="Choose reaction">{REACTIONS.map(emoji => <ChatButton key={emoji} title={`React ${emoji}`} disabled={reacting} onClick={() => { onReact?.(message, emoji); setShowReactions(false) }} className="w-8 text-lg">{emoji}</ChatButton>)}</div>}
        {groups.length > 0 && <div className="flex flex-wrap gap-1 mt-2">{groups.map(({ emoji, users }) => <ChatButton key={emoji} title={`${emoji}: ${users.length} reaction${users.length > 1 ? 's' : ''}`} aria-pressed={users.includes(String(userId))} disabled={reacting} onClick={() => onReact?.(message, emoji)} className={`!min-h-7 px-2 text-xs border ${users.includes(String(userId)) ? 'bg-accent text-accent-foreground border-accent' : 'bg-card text-card-foreground border-border'}`}>{emoji} {users.length}</ChatButton>)}</div>}
      </div>
      <MediaPreviewModal
        open={showMediaPreview}
        onClose={closeMediaPreview}
        type={message.type}
        fileName={message.file_name}
        mediaUrl={mediaUrl}
        mediaError={mediaError}
        hasSource={Boolean(message.file_url)}
      />
    </div>
  )
}

export default memo(MessageBubble)
