import { useState, useEffect } from 'react'
import SettingsRow from './SettingsRow'
import { ShieldCheckIcon, KeyIcon, DocumentDuplicateIcon, CheckIcon, EyeIcon } from '@heroicons/react/24/solid'
import { useSetting } from '../../../hooks/useSetting'
import {
  getMyPublicKey,
  generateSafetyNumber,
  publishMyPublicKey,
} from '../../../lib/crypto/e2ee'

export default function PrivacySettings() {
  const [publicKey, setPublicKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [keySetupAttempt, setKeySetupAttempt] = useState(0)
  const [keySetupPending, setKeySetupPending] = useState(true)
  const [readReceipts, setReadReceipts] = useSetting('readReceipts', true)
  const [contactKey, setContactKey] = useState('')
  const [safetyNumber, setSafetyNumber] = useState('')

  useEffect(() => {
    let active = true
    const peer = contactKey.trim()
    if (!publicKey || !peer) {
      setSafetyNumber('')
      return undefined
    }
    generateSafetyNumber(publicKey, peer).then((number) => {
      if (active) setSafetyNumber(number)
    })
    return () => { active = false }
  }, [publicKey, contactKey])

  useEffect(() => {
    let active = true
    const prepareEncryption = async () => {
      setKeySetupPending(true)
      setKeyError('')
      try {
        const key = await getMyPublicKey()
        await publishMyPublicKey()
        if (active) {
          setPublicKey(key)
          setKeyError('')
        }
      } catch (error) {
        if (active) {
          setPublicKey('')
          setKeyError(error?.message || 'Could not prepare your encryption key.')
        }
      } finally {
        if (active) setKeySetupPending(false)
      }
    }
    void prepareEncryption()
    return () => { active = false }
  }, [keySetupAttempt])

  const copyPublicKey = () => {
    navigator.clipboard.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-green-500/10 rounded-xl border border-green-500/20">
        <ShieldCheckIcon className="w-6 h-6 text-green-500 mt-0.5 flex-shrink-0" />
        <div>
          <h3 className="font-semibold text-foreground">End-to-End Encryption</h3>
          <p className="text-sm text-muted-foreground mt-1">
            End-to-end encryption is required for every text and sticker message. Messages
            are blocked until your key and the recipient&apos;s key are available.
            Attachments and voice notes are not end-to-end encrypted.
          </p>
        </div>
      </div>

      <SettingsRow
        label="Text message encryption"
        description="Required. This protection cannot be turned off."
        icon={<ShieldCheckIcon className="w-4 h-4" />}
      >
        <span className="rounded-full bg-green-500/10 px-3 py-1 text-sm font-medium text-green-600">
          Required
        </span>
      </SettingsRow>

      <SettingsRow
        label="Read receipts"
        description={
          readReceipts
            ? 'People you message can see when you have read their messages.'
            : 'Read receipts are off: you will not send them, and you will not see when your messages are read.'
        }
        icon={<EyeIcon className="w-4 h-4" />}
      >
        <button
          type="button"
          role="switch"
          aria-checked={readReceipts}
          aria-label="Read receipts"
          onClick={() => setReadReceipts(!readReceipts)}
          className={`relative w-12 h-6 rounded-full transition-colors ${
            readReceipts ? 'bg-green-500' : 'bg-muted'
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              readReceipts ? 'translate-x-6' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SettingsRow>

          <div className="p-4 bg-muted/40 rounded-xl border border-border">
            <div className="flex items-center gap-2 mb-2">
              <KeyIcon className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">Your Public Key</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-muted-foreground break-all font-mono bg-muted p-2 rounded">
                {publicKey ? `${publicKey.slice(0, 32)}...` : 'Generating...'}
              </code>
              <button
                onClick={copyPublicKey}
                className="p-2 hover:bg-muted rounded-lg transition-colors"
              >
                {copied ? <CheckIcon className="w-4 h-4 text-green-500" /> : <DocumentDuplicateIcon className="w-4 h-4 text-muted-foreground" />}
              </button>
            </div>
          </div>

          <div className="p-4 bg-muted/40 rounded-xl border border-border space-y-3">
            <p className="text-sm font-medium text-foreground">Verify a contact</p>
            <p className="text-xs text-muted-foreground">
              Share your public key above, then paste your contact&apos;s public key here.
              If you both see the same safety number, your messages are protected by the
              same key pair and no one in between can read them.
            </p>
            <input
              type="text"
              value={contactKey}
              onChange={(event) => setContactKey(event.target.value)}
              placeholder="Paste your contact's public key"
              className="w-full text-xs font-mono bg-muted p-2 rounded border border-border text-foreground placeholder:text-muted-foreground"
            />
            {safetyNumber && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Safety number</p>
                <p className="text-2xl font-mono tracking-widest text-foreground">{safetyNumber}</p>
              </div>
            )}
          </div>

          {keyError && (
            <div className="space-y-2">
              <p className="text-sm text-destructive" role="alert">{keyError}</p>
              <button
                type="button"
                onClick={() => setKeySetupAttempt((attempt) => attempt + 1)}
                disabled={keySetupPending}
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {keySetupPending ? 'Retrying key setup...' : 'Retry key setup'}
              </button>
            </div>
          )}
    </div>
  )
}
