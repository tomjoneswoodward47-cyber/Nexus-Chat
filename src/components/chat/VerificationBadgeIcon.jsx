import { BadgeCheck } from 'lucide-react'

// eslint-disable-next-line react/prop-types
export default function VerificationBadgeIcon({ level, className = 'w-4 h-4' }) {
  if (level === 'premium') {
    return <BadgeCheck aria-label="Premium Member" className={`${className} fill-badge-blue text-background`} />
  }
  if (level === 'authenticated') {
    return <BadgeCheck aria-label="Identity verified" className={`${className} fill-badge-blue text-background`} />
  }
  return null
}
