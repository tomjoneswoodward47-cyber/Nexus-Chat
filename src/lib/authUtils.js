export function isAdminRole(role) {
  return role === 'admin' || role === 'supabase_admin'
}

export function formatNexusIdForDisplay(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length < 2) return digits
  if (digits.length < 6) return `${digits.slice(0, 2)}-${digits.slice(2)}`
  if (digits.length < 10) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`
}
