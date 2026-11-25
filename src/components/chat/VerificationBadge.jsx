import VerificationBadgeIcon from './VerificationBadgeIcon'
import { useVerificationBadge } from './verificationBadgeState'

// eslint-disable-next-line react/prop-types
export default function VerificationBadge({ userId, className = 'w-4 h-4' }) {
  const level = useVerificationBadge(userId)
  return <VerificationBadgeIcon level={level} className={className} />
}
