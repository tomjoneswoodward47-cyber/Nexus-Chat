import { useMemo } from 'react'
import {
  ChatBubbleLeftRightIcon,
  RssIcon,
  UserGroupIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/solid'
import { useAuth } from '../../lib/authContextState'

export const BASE_TABS = [
  { id: 'chats', label: 'Chats', icon: ChatBubbleLeftRightIcon, path: '/app', roles: ['user', 'admin'] },
  { id: 'feeds', label: 'Feeds', icon: RssIcon, path: '/app/feeds', roles: ['user', 'admin'] },
  { id: 'contacts', label: 'Contacts', icon: UserGroupIcon, path: '/app/contacts', roles: ['user', 'admin'] },
  { id: 'settings', label: 'Settings', icon: Cog6ToothIcon, path: '/app/settings', roles: ['user', 'admin'] },
  { id: 'admin', label: 'Admin', icon: ShieldCheckIcon, path: '/admin', roles: ['admin'] },
]

export function useFilteredTabs() {
  const { user } = useAuth()
  const role = user?.role || 'user'
  return useMemo(() => BASE_TABS.filter((tab) => tab.roles.includes(role)), [role])
}

export function getActiveTabFromPath(pathname) {
  if (pathname.startsWith('/admin')) return 'admin'
  if (pathname.startsWith('/app/settings')) return 'settings'
  if (pathname.startsWith('/app/contacts')) return 'contacts'
  if (pathname.startsWith('/app/feeds')) return 'feeds'
  return 'chats'
}
