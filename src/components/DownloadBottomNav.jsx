import { Link, useLocation } from 'react-router-dom'
import {
  ArrowDownTrayIcon,
  ArrowRightOnRectangleIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  HomeIcon,
  LockClosedIcon,
  RssIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from '@heroicons/react/24/solid'
import { useAuth } from '../lib/authContextState'

// Public entry points for visitors who are not signed in: branding home, the
// download surface itself, and the two account entry points.
const AUTH_TABS = [
  { id: 'home', label: 'Home', icon: HomeIcon, path: '/' },
  { id: 'download', label: 'Download', icon: ArrowDownTrayIcon, path: '/download' },
  { id: 'register', label: 'Register', icon: UserPlusIcon, path: '/register' },
  { id: 'login', label: 'Sign in', icon: LockClosedIcon, path: '/login' },
]

// Signed-in entry points: account navigation, download management, and the
// authenticated actions that live behind the app shell.
const ACCOUNT_TABS = [
  { id: 'chats', label: 'Chats', icon: ChatBubbleLeftRightIcon, path: '/app', roles: ['user', 'admin'] },
  { id: 'feeds', label: 'Feeds', icon: RssIcon, path: '/app/feeds', roles: ['user', 'admin'] },
  { id: 'download', label: 'Download', icon: ArrowDownTrayIcon, path: '/download', roles: ['user', 'admin'] },
  { id: 'settings', label: 'Account', icon: Cog6ToothIcon, path: '/app/settings/profile', roles: ['user', 'admin'] },
  { id: 'admin', label: 'Admin', icon: ShieldCheckIcon, path: '/admin', roles: ['admin'] },
]

function isTabActive(pathname, tab) {
  if (tab.id === 'download') return pathname === '/download'
  if (tab.id === 'chats') return pathname === '/app' || pathname.startsWith('/app/chat')
  if (tab.id === 'settings') return pathname.startsWith('/app/settings')
  if (tab.id === 'feeds') return pathname.startsWith('/app/feeds')
  if (tab.id === 'admin') return pathname.startsWith('/admin')
  return pathname === tab.path
}

function TabLink({ tab, active }) {
  const Icon = tab.icon
  return (
    <Link
      to={tab.path}
      aria-current={active ? 'page' : undefined}
      className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-2.5 text-[11px] font-medium transition-colors ${
        active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary transition-opacity ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span
        className={`flex h-8 w-12 items-center justify-center rounded-full transition-colors ${
          active ? 'bg-primary/10' : 'bg-transparent'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="max-w-full truncate">{tab.label}</span>
    </Link>
  )
}

export default function DownloadBottomNav() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const isAuthed = Boolean(user)
  const role = user?.role || 'user'

  const tabs = isAuthed
    ? ACCOUNT_TABS.filter((tab) => tab.roles.includes(role))
    : AUTH_TABS

  return (
    <nav
      role="navigation"
      aria-label={isAuthed ? 'Account navigation' : 'Public navigation'}
      data-download-bottom-nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] text-foreground shadow-[0_-6px_20px_rgba(15,23,42,0.12)] backdrop-blur-xl"
    >
      <div className="mx-auto flex w-full max-w-7xl items-stretch justify-around px-1 sm:px-2">
        {tabs.map((tab) => (
          <TabLink key={tab.id} tab={tab} active={isTabActive(location.pathname, tab)} />
        ))}

        {isAuthed && (
          <button
            type="button"
            onClick={() => { void logout() }}
            className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 border-l border-border/60 px-1 py-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive"
            title="Log out"
            aria-label="Log out"
          >
            <span className="flex h-8 w-12 items-center justify-center rounded-full">
              <ArrowRightOnRectangleIcon className="h-5 w-5" />
            </span>
            <span className="max-w-full truncate">Log out</span>
          </button>
        )}
      </div>
    </nav>
  )
}
