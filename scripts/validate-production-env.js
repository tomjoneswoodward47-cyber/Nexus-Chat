#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
// Only the browser keys are needed to build. Server keys are checked as warnings because Vercel
// functions read them at runtime.
const REQUIRED_GROUPS = [
  ['VITE_SUPABASE_URL', 'SUPABASE_URL'],
  ['VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'],
]
const RECOMMENDED_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'RESEND_FROM', 'OTP_HASH_SECRET']
const APPWRITE_SERVER_KEYS = [
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'SUPABASE_POOLER_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]
// Optional hybrid-storage config. When unset, >2 MB uploads fall back to
// Supabase Storage, so a partial config is a warning rather than a hard failure.
const R2_SERVER_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
]

const PLACEHOLDER_HINTS = [
  'your_',
  'example.com',
  'replace-me',
  'changeme',
  'your-project',
  'your_supabase',
  'your_domain',
]

// Supabase project refs appear as the `https://<ref>.supabase.co` subdomain.
function projectRefFromUrl(url) {
  const match = String(url || '').match(/^https?:\/\/([a-z0-9]+)\.supabase\.(?:co|in)/i)
  return match ? match[1] : ''
}

// The role a Supabase key grants, read from the new `sb_*` prefix or the `role`
// claim of a legacy JWT. A public key must never be a service-role or secret key:
// those carry full database access and must stay server-side.
function keyRole(value) {
  const token = String(value || '').trim().replace(/^Bearer\s+/i, '')
  if (/^sb_secret_/.test(token)) return 'secret'
  if (/^sb_publishable_/.test(token)) return 'publishable'
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      return String(payload.role || '').toLowerCase()
    } catch {
      return 'unparseable'
    }
  }
  return token ? 'unknown' : ''
}

function setValues(keys) {
  const entries = keys.map((key) => ({ key, value: getEnvValue(key) })).filter((entry) => !isPlaceholder(entry.value))
  return { entries, distinct: [...new Set(entries.map((entry) => entry.value))], value: entries[0]?.value || '' }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}

  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function getEnvValue(key) {
  const localValues = readEnvFile(path.join(rootDir, '.env'))
  const productionValues = readEnvFile(path.join(rootDir, '.env.production'))
  return process.env[key] ?? productionValues[key] ?? localValues[key] ?? ''
}

function isPlaceholder(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return true
  return PLACEHOLDER_HINTS.some((hint) => text.includes(hint))
}

async function main() {
  const isStrictDeploy = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.NODE_ENV === 'production')
  const provider = getEnvValue('VITE_AUTH_PROVIDER') || 'supabase'
  const missing = REQUIRED_GROUPS.filter((keys) => !keys.some((key) => !isPlaceholder(getEnvValue(key)))).map((keys) => keys.join(' or '))
  const missingRecommended = RECOMMENDED_KEYS.filter((key) => isPlaceholder(getEnvValue(key)))

  if (!['supabase', 'appwrite'].includes(provider)) {
    console.error('[env:validate] VITE_AUTH_PROVIDER must be either supabase or appwrite.')
    process.exit(1)
  }

  if (provider === 'appwrite') {
    const missingAppwrite = [
      ...['VITE_APPWRITE_ENDPOINT', 'VITE_APPWRITE_PROJECT_ID'],
      ...APPWRITE_SERVER_KEYS,
    ].filter((key) => isPlaceholder(getEnvValue(key)))
    if (isStrictDeploy && missingAppwrite.length) {
      console.error('[env:validate] Missing Appwrite production environment values:')
      for (const key of missingAppwrite) console.error(` - ${key}`)
      process.exit(1)
    }
  }

  if (missingRecommended.length) {
    console.warn(`[env:validate] Not set (sign-up emails will fail until added): ${missingRecommended.join(', ')}`)
  }
  // Without this secret Edge Middleware fails closed, so every /admin* request
  // would be redirected to the sign-in page.
  if (isPlaceholder(getEnvValue('ADMIN_SESSION_SECRET'))) {
    console.warn('[env:validate] ADMIN_SESSION_SECRET is not set: /admin* requests will be blocked in production until it is.')
  }
  // Required only by the admin RLS policy refresh endpoint
  // (/api/admin/maintenance). Missing it disables that admin action but does
  // not affect the app, so this is a warning rather than a hard failure.
  if (isPlaceholder(getEnvValue('SUPABASE_DB_URL'))) {
    console.warn('[env:validate] SUPABASE_DB_URL is not set: the admin RLS policy refresh (/api/admin/maintenance) is disabled.')
  }
  // Voice calls relay over TURN when NAT traversal via STUN alone fails.
  const hasTurnUrl = !isPlaceholder(getEnvValue('VITE_TURN_URL'))
  const hasTurnUser = !isPlaceholder(getEnvValue('VITE_TURN_USERNAME'))
  const hasTurnCredential = !isPlaceholder(getEnvValue('VITE_TURN_CREDENTIAL'))
  if (!hasTurnUrl) {
    console.warn('[env:validate] VITE_TURN_URL is not set: voice calls use STUN only and may fail behind strict NATs.')
  }
  if (hasTurnUser !== hasTurnCredential) {
    console.warn('[env:validate] TURN username and credential must be set together; relay credentials will be ignored.')
  }
  // Hybrid storage: R2 holds uploads above the 2 MB threshold, but a partial
  // config silently degrades every large upload to Supabase Storage.
  const missingR2 = R2_SERVER_KEYS.filter((key) => isPlaceholder(getEnvValue(key)))
  if (missingR2.length && missingR2.length !== R2_SERVER_KEYS.length) {
    console.warn(`[env:validate] Cloudflare R2 is partially configured; set all of ${R2_SERVER_KEYS.join(', ')} or none. Missing: ${missingR2.join(', ')}. Large uploads fall back to Supabase Storage.`)
  }
  // The URL, project ref and public key must all describe the same Supabase
  // project, and the browser key must be a public (anon/publishable) key.
  const urlSet = setValues(['VITE_SUPABASE_URL', 'SUPABASE_URL'])
  const keySet = setValues(['VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'])
  const projectId = getEnvValue('VITE_SUPABASE_PROJECT_ID') || getEnvValue('SUPABASE_PROJECT_ID')
  const ref = projectRefFromUrl(urlSet.value)
  const role = keyRole(keySet.value)
  const configErrors = []
  const configWarnings = []

  for (const [label, set] of [['URL', urlSet], ['public key', keySet]]) {
    if (set.distinct.length > 1) {
      configErrors.push(`Supabase ${label} values disagree across aliases: ${set.entries.map((e) => `${e.key}=${e.value}`).join(', ')}`)
    }
  }
  if (urlSet.value && !ref) {
    configErrors.push(`Supabase URL must look like https://<project-ref>.supabase.co (got ${urlSet.value})`)
  }
  if (ref && !isPlaceholder(projectId) && projectId !== ref) {
    configErrors.push(`VITE_SUPABASE_PROJECT_ID=${projectId} does not match the project ref in the URL (${ref})`)
  }
  if (['service_role', 'secret', 'authenticated'].includes(role)) {
    configErrors.push(`The public Supabase key must be an anon or publishable key, not a "${role}" key`)
  } else if (keySet.value && !['anon', 'publishable'].includes(role)) {
    configWarnings.push(`The public Supabase key format is not recognised (role "${role || 'unknown'}"); expected anon or sb_publishable_`)
  }
  const serviceRoleValue = getEnvValue('SUPABASE_SERVICE_ROLE_KEY')
  if (keySet.value && !isPlaceholder(serviceRoleValue) && keySet.value === serviceRoleValue) {
    configErrors.push('VITE_SUPABASE_ANON_KEY must not reuse the service-role key')
  }

  if (configWarnings.length) {
    console.warn(`[env:validate] Supabase configuration warnings: ${configWarnings.join('; ')}`)
  }
  if (configErrors.length && isStrictDeploy) {
    console.error('[env:validate] Inconsistent Supabase configuration before deploy:')
    for (const issue of configErrors) console.error(` - ${issue}`)
    process.exit(1)
  }
  if (configErrors.length) {
    console.warn(`[env:validate] Supabase configuration problems (not blocking a local build): ${configErrors.join('; ')}`)
  }

  if (isStrictDeploy && missing.length) {
    console.error('[env:validate] Missing production env values before deploy:')
    for (const key of missing) console.error(` - ${key}`)
    process.exit(1)
  }
  console.log('[env:validate] Environment validation passed.')
}

main().catch((error) => {
  console.error('[env:validate] Failed:', error.message)
  process.exit(1)
})
