import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownTrayIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ComputerDesktopIcon,
  DevicePhoneMobileIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
} from '@heroicons/react/24/solid'
import { Apple } from 'lucide-react'
import Header from '../components/Header'
import DownloadBottomNav from '../components/DownloadBottomNav'
import { useTheme } from '../hooks/useTheme'
import {
  ANDROID_APK_URL,
  APP_STORE_URL,
  detectCurrentPlatform,
  installGuidance,
  isStandalone,
  PLATFORM_LABELS,
  trackDownloadEvent,
} from '../lib/appDownloads'

const CARDS = [
  {
    key: 'android',
    title: PLATFORM_LABELS.android,
    icon: DevicePhoneMobileIcon,
    blurb: ANDROID_APK_URL
      ? 'Download the package and install it on your Android phone or tablet.'
      : 'Install Nexus Chat straight from your browser — no store download needed.',
  },
  {
    key: 'ios',
    title: PLATFORM_LABELS.ios,
    icon: Apple,
    blurb: APP_STORE_URL
      ? 'Get Nexus Chat from the App Store.'
      : 'Add Nexus Chat to your home screen from Safari in a couple of taps.',
  },
  {
    key: 'desktop',
    title: PLATFORM_LABELS.desktop,
    icon: ComputerDesktopIcon,
    blurb: 'Install Nexus Chat as a desktop app, or open it in any modern browser.',
  },
]

// Validates a download URL before handing it to the browser so a broken link
// surfaces as a message instead of a silent no-op. A 405/501 means the host
// simply rejects HEAD, and a thrown request (CORS/opaque) must not block a
// legitimate download, so both are treated as reachable.
async function isDownloadReachable(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (response.status === 405 || response.status === 501) return true
    return response.ok
  } catch {
    return true
  }
}

export default function DownloadPage() {
  useTheme()

  const [platform, setPlatform] = useState('desktop')
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState(null)

  useEffect(() => {
    setPlatform(detectCurrentPlatform())
    setInstalled(isStandalone())

    const onBeforeInstall = (event) => {
      // Suppress the browser's own mini-infobar so the page's button drives it.
      event.preventDefault()
      setDeferredPrompt(event)
      trackDownloadEvent('install_prompt_available', { platform: detectCurrentPlatform() })
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
      setStatus({ tone: 'success', text: 'Nexus Chat is installed. Launch it any time from your home screen or app list.' })
      trackDownloadEvent('installed', { platform: detectCurrentPlatform() })
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const primaryCard = useMemo(() => CARDS.find((card) => card.key === platform) || CARDS[2], [platform])

  async function install() {
    if (!deferredPrompt) {
      setStatus({ tone: 'info', text: installGuidance(platform) })
      trackDownloadEvent('install_guidance_shown', { platform })
      return
    }
    setBusy('install')
    setStatus(null)
    try {
      deferredPrompt.prompt()
      const choice = await deferredPrompt.userChoice
      trackDownloadEvent('install_choice', { platform, outcome: choice?.outcome || 'unknown' })
      if (choice?.outcome === 'accepted') {
        setInstalled(true)
        setStatus({ tone: 'success', text: 'Installing Nexus Chat… it will appear on your home screen shortly.' })
      } else {
        setStatus({ tone: 'info', text: 'Installation was dismissed. You can start it again whenever you like.' })
      }
    } catch {
      setStatus({ tone: 'error', text: installGuidance(platform) })
      trackDownloadEvent('install_failed', { platform })
    } finally {
      setDeferredPrompt(null)
      setBusy('')
    }
  }

  async function downloadApk() {
    setBusy('apk')
    setStatus(null)
    try {
      const reachable = await isDownloadReachable(ANDROID_APK_URL)
      if (!reachable) {
        trackDownloadEvent('download_failed', { platform: 'android', channel: 'apk' })
        setStatus({ tone: 'error', text: 'The Android package is temporarily unavailable. Please try again shortly.' })
        return
      }
      trackDownloadEvent('download_started', { platform: 'android', channel: 'apk' })
      const anchor = document.createElement('a')
      anchor.href = ANDROID_APK_URL
      anchor.rel = 'noopener'
      anchor.download = ''
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setStatus({ tone: 'success', text: 'Your download has started. Open the file to finish installing Nexus Chat.' })
    } catch {
      trackDownloadEvent('download_failed', { platform: 'android', channel: 'apk' })
      setStatus({ tone: 'error', text: 'Could not start the download. Check your connection and try again.' })
    } finally {
      setBusy('')
    }
  }

  function runPlatformAction(key) {
    trackDownloadEvent('download_click', { platform: key, channel: key === 'android' && ANDROID_APK_URL ? 'apk' : 'web-install' })
    if (key === 'android' && ANDROID_APK_URL) return downloadApk()
    if (key === 'ios' && APP_STORE_URL) {
      window.open(APP_STORE_URL, '_blank', 'noopener,noreferrer')
      return undefined
    }
    return install()
  }

  const busyLabel = busy === 'apk' ? 'Preparing download…' : 'Starting install…'

  function actionLabel(card) {
    if (busy && ((busy === 'apk' && card.key === 'android') || (busy === 'install' && card.key === platform))) return busyLabel
    if (installed && card.key === platform) return 'App installed'
    if (card.key === 'android' && ANDROID_APK_URL) return 'Download for Android'
    if (card.key === 'ios' && APP_STORE_URL) return 'Get it on the App Store'
    if (card.key === platform) return `Install for ${PLATFORM_LABELS[platform]}`
    return 'Install app'
  }

  return (
    <div className="min-h-screen bg-background pb-24 text-foreground sm:pb-20">
      <Header />

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 sm:px-6 lg:px-8">
        <Link to="/" className="text-sm font-medium text-primary hover:underline">
          Back to Nexus Chat
        </Link>

        <section className="mt-6 max-w-3xl chat-enter">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-primary/10 px-3 py-1 text-sm text-primary">
            <SparklesIcon className="h-4 w-4" />
            Free to use — no subscriptions or in-app purchases
          </span>
          <h1 className="mt-5 text-4xl font-bold leading-[1.05] sm:text-5xl">Get Nexus Chat on your device</h1>
          <p className="mt-4 text-lg leading-8 text-muted-foreground">
            Nexus Chat works on Android, iPhone, iPad, Windows, macOS and Linux. Install it for
            one-tap access, or open it instantly in your browser with your account.
          </p>
        </section>

        <section className="mt-8 rounded-[28px] border border-border bg-card p-6 shadow-xl backdrop-blur sm:p-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
                <primaryCard.icon className="h-7 w-7 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Recommended for your device</p>
                <h2 className="text-xl font-semibold">{primaryCard.title}</h2>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => runPlatformAction(primaryCard.key)}
                disabled={Boolean(busy) || (installed && primaryCard.key === platform)}
                aria-busy={Boolean(busy)}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {installed && primaryCard.key === platform ? (
                  <CheckCircleIcon className="h-5 w-5" />
                ) : (
                  <ArrowDownTrayIcon className="h-5 w-5" />
                )}
                {actionLabel(primaryCard)}
              </button>
              <Link
                to="/login"
                onClick={() => trackDownloadEvent('open_web_app', { platform })}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-muted px-5 py-3 font-semibold text-foreground transition hover:bg-muted/80"
              >
                Open web app <ArrowRightIcon className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {busy && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary"
              />
              {busyLabel}
            </p>
          )}

          {status && !busy && (
            <p
              role={status.tone === 'error' ? 'alert' : 'status'}
              className={`mt-4 flex items-start gap-2 text-sm ${
                status.tone === 'error'
                  ? 'text-destructive'
                  : status.tone === 'success'
                    ? 'text-primary'
                    : 'text-muted-foreground'
              }`}
            >
              {status.tone === 'error' ? (
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              ) : status.tone === 'success' ? (
                <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              ) : null}
              <span>{status.text}</span>
            </p>
          )}
        </section>

        <section className="mt-10" aria-labelledby="platforms-heading">
          <h2 id="platforms-heading" className="text-lg font-semibold">
            All supported platforms
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CARDS.map((card) => {
              const Icon = card.icon
              const isBusy = busy === 'apk' && card.key === 'android'
              const isDone = installed && card.key === platform
              return (
                <div
                  key={card.key}
                  className="float-card flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                      <Icon className="h-5 w-5 text-primary" />
                    </span>
                    <h3 className="font-semibold">{card.title}</h3>
                  </div>
                  <p className="mt-3 flex-1 text-sm leading-6 text-muted-foreground">{card.blurb}</p>
                  <button
                    type="button"
                    onClick={() => runPlatformAction(card.key)}
                    disabled={Boolean(busy) || isDone}
                    aria-busy={isBusy}
                    className="mt-4 inline-flex items-center justify-center gap-2 rounded-full border border-border bg-muted px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDone ? <CheckCircleIcon className="h-4 w-4 text-primary" /> : <ArrowDownTrayIcon className="h-4 w-4" />}
                    {actionLabel(card)}
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <section className="mt-10 rounded-2xl border border-border bg-muted p-6" aria-labelledby="ios-heading">
          <h2 id="ios-heading" className="text-lg font-semibold">
            Installing on iPhone or iPad
          </h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
            <li>Open Nexus Chat in Safari.</li>
            <li>
              Tap the <span className="font-medium text-foreground">Share</span> button in the toolbar.
            </li>
            <li>
              Choose <span className="font-medium text-foreground">Add to Home Screen</span>, then tap Add.
            </li>
            <li>Launch Nexus Chat from your home screen like any other app.</li>
          </ol>
        </section>

        <section className="mt-10" aria-labelledby="included-heading">
          <h2 id="included-heading" className="text-lg font-semibold">
            What you get
          </h2>
          <ul className="mt-4 grid grid-cols-1 gap-3 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
            <li>• Secure sign-in with your Nexus member number</li>
            <li>• Encrypted chats, media sharing and voice calls</li>
            <li>• Cross-device messaging that stays in sync</li>
            <li>• 5 GB of file storage included on every account</li>
            <li>• Wallpaper and appearance customization</li>
            <li>• Free forever — no payments and no paid tiers</li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-border py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 text-sm text-muted-foreground sm:px-6 lg:px-8">
          <Link to="/privacy" className="transition hover:text-foreground">Privacy Policy</Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms" className="transition hover:text-foreground">Terms of Service</Link>
          <span aria-hidden="true">·</span>
          <Link to="/delete-account" className="transition hover:text-foreground">Delete account</Link>
        </div>
      </footer>

      <DownloadBottomNav />
    </div>
  )
}
