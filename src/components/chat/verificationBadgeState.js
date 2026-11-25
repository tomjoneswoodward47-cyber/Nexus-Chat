import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { appwriteData, isAppwriteAuthEnabled } from '../../lib/appwrite'

const cache = new Map()
export const BADGE_REFRESH_EVENT = 'nexus-verification:refresh'

export function clearVerificationBadgeCache(userId) {
  if (userId) cache.delete(String(userId))
  else cache.clear()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BADGE_REFRESH_EVENT))
}

export function useVerificationBadge(userId) {
  const [level, setLevel] = useState(() => cache.get(String(userId)) || 'none')
  useEffect(() => {
    if ((!supabase && !isAppwriteAuthEnabled()) || !userId) {
      setLevel('none')
      return undefined
    }
    const key = String(userId)
    let active = true
    setLevel(cache.get(key) || 'none')
    const load = async () => {
      if (cache.has(key)) {
        if (active) setLevel(cache.get(key))
        return
      }
      try {
        const badge = isAppwriteAuthEnabled()
          ? (await appwriteData('verification.badge', { userId: key })).badge
          : (await supabase.rpc('get_verification_badge', { _user_id: userId })).data
        const value = badge || 'none'
        cache.set(key, value)
        if (active) setLevel(value)
      } catch (error) {
        console.error('Could not load verification badge', error)
        if (active) setLevel('none')
      }
    }
    load()
    const onRefresh = () => { cache.delete(key); load() }
    window.addEventListener(BADGE_REFRESH_EVENT, onRefresh)
    return () => {
      active = false
      window.removeEventListener(BADGE_REFRESH_EVENT, onRefresh)
    }
  }, [userId])
  return level
}

export async function fetchVerificationBadges(memberIds) {
  const ids = [...new Set((memberIds || []).map(String).filter(Boolean))].slice(0, 500)
  const badges = new Map()
  if (!ids.length || (!supabase && !isAppwriteAuthEnabled())) return badges
  const rows = isAppwriteAuthEnabled()
    ? (await appwriteData('verification.badges', { memberIds: ids })).badges
    : (await supabase.rpc('get_verification_badges', { _member_ids: ids })).data
  for (const row of rows || []) badges.set(String(row.member_id), row.badge || 'none')
  return badges
}
