#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeConfigPath = path.join(rootDir, '.vercel-runtime-env.json')
const linkedProjectPath = path.join(rootDir, '.vercel', 'project.json')
const dryRun = process.argv.includes('--dry-run')
const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
const confirmProduction = args.includes('--confirm-production')
const localEnvPath = path.join(rootDir, '.env.local')

// Vercel credentials may live in the gitignored .env.local so they survive
// across terminal sessions; an exported shell variable still takes precedence.
// These keys are never written to the generated runtime environment.
function readLocalEnv(key) {
  if (!fs.existsSync(localEnvPath)) return ''
  for (const line of fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, '')
  }
  return ''
}

function resolveSetting(key) {
  const fromShell = String(process.env[key] || '').trim()
  return fromShell || readLocalEnv(key)
}

const REQUIRED_ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'ADMIN_SESSION_SECRET',
  'OTP_HASH_SECRET',
]

const OPTIONAL_ENV_KEYS = [
  'VITE_APPWRITE_ENDPOINT',
  'VITE_APPWRITE_PROJECT_ID',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'SUPABASE_POOLER_URL',
]

// Voice-call ICE config. These are browser-safe (they ship in the bundle) and
// optional, so they are only synced when a real value is present.
const OPTIONAL_PUBLIC_KEYS = [
  'VITE_STUN_URL',
  'VITE_TURN_URL',
  'VITE_TURN_USERNAME',
  'VITE_TURN_CREDENTIAL',
  'VITE_R2_PUBLIC_BASE_URL',
]

// Cloudflare R2 credentials for the >2 MB presigned-upload path. These are
// server-only secrets and are synced as a group so a partial config can never
// reach production; when absent, large uploads fall back to Supabase Storage.
const R2_SERVER_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
]

const PUBLIC_KEYS = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_AUTH_PROVIDER',
  'VITE_APPWRITE_ENDPOINT',
  'VITE_APPWRITE_PROJECT_ID',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'RESEND_FROM',
  ...OPTIONAL_PUBLIC_KEYS,
])

const LEGACY_PUBLIC_SECRETS = ['VITE_ADMIN_PASSWORD']
const PLACEHOLDER_HINTS = [
  'your_',
  'your-real-project-id',
  'your-real-team-id',
  'actual_project_id',
  'actual_team_id',
  'example.com',
  'replace-me',
  'changeme',
  'your-project',
  'your_supabase',
  'your_domain',
]

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    throw new Error(`${label} is missing or invalid: ${path.relative(rootDir, filePath)}`)
  }
}

function getProjectConfig() {
  const linked = fs.existsSync(linkedProjectPath)
    ? loadJson(linkedProjectPath, 'Vercel project link')
    : {}
  const projectId = resolveSetting('VERCEL_PROJECT_ID') || linked.projectId || ''
  const linkedOrgId = String(linked.orgId || '')
  const teamId = resolveSetting('VERCEL_TEAM_ID') || (linkedOrgId.startsWith('team_') ? linkedOrgId : '')
  return { projectId, teamId }
}

function invalidValue(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return !normalized || PLACEHOLDER_HINTS.some((hint) => normalized.includes(hint))
}

function loadValues() {
  const config = loadJson(runtimeConfigPath, 'Generated runtime environment')
  const provider = String(config.VITE_AUTH_PROVIDER || 'supabase').trim().toLowerCase()
  if (!['supabase', 'appwrite'].includes(provider)) {
    throw new Error('VITE_AUTH_PROVIDER must be either supabase or appwrite.')
  }

  const requiredKeys = [
    ...REQUIRED_ENV_KEYS,
    'VITE_AUTH_PROVIDER',
    ...(provider === 'appwrite' ? OPTIONAL_ENV_KEYS : []),
  ]
  const missing = requiredKeys.filter((key) => invalidValue(config[key]))
  if (missing.length) {
    throw new Error(`Missing or placeholder values in generated environment: ${missing.join(', ')}`)
  }
  const optionalPublic = Object.fromEntries(
    OPTIONAL_PUBLIC_KEYS
      .filter((key) => !invalidValue(config[key]))
      .map((key) => [key, String(config[key])])
  )
  const presentR2Keys = R2_SERVER_KEYS.filter((key) => !invalidValue(config[key]))
  if (presentR2Keys.length && presentR2Keys.length !== R2_SERVER_KEYS.length) {
    const missingR2 = R2_SERVER_KEYS.filter((key) => !presentR2Keys.includes(key))
    throw new Error(`Incomplete Cloudflare R2 configuration; set all of ${R2_SERVER_KEYS.join(', ')} or none. Missing: ${missingR2.join(', ')}`)
  }
  const r2Server = Object.fromEntries(presentR2Keys.map((key) => [key, String(config[key])]))
  return {
    ...Object.fromEntries(requiredKeys.map((key) => [key, String(config[key])])),
    ...optionalPublic,
    ...r2Server,
    VITE_AUTH_PROVIDER: provider,
  }
}

async function request(pathname, { method = 'GET', body } = {}) {
  const url = new URL(pathname, 'https://api.vercel.com')
  if (teamId) url.searchParams.set('teamId', teamId)

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let result = {}
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    result = {}
  }

  if (!response.ok) {
    const code = result.error?.code ? `, ${result.error.code}` : ''
    if (response.status === 403) {
      throw new Error(`Vercel API request forbidden (${method} ${pathname}${code}). Check that the token is valid, scoped to the owning team, and authorized for this project.`)
    }
    throw new Error(`Vercel API request failed (${response.status}${code}).`)
  }
  return result
}

export function getTargetMatch(envs, key, targetName) {
  const matches = envs.filter((item) => item.key === key && item.target?.includes(targetName))
  const displayTarget = targetName[0].toUpperCase() + targetName.slice(1)
  if (matches.length > 1) throw new Error(`Multiple ${displayTarget} variables exist for ${key}; resolve duplicates in Vercel first.`)
  if (!matches.length) return null

  const targets = [...(matches[0].target || [])].sort()
  if (targets.length !== 1 || targets[0] !== targetName) {
    throw new Error(`${key} is shared with other Vercel targets; make it ${displayTarget}-only before syncing.`)
  }
  return matches[0]
}

function projectRefFromApiUrl(value) {
  try {
    const url = new URL(value)
    return url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] || ''
  } catch {
    return ''
  }
}

function projectRefFromDatabaseUrl(value) {
  try {
    const url = new URL(value)
    const direct = url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
    if (direct) return direct
    const username = decodeURIComponent(url.username)
    return username.match(/^postgres\.([a-z0-9-]+)$/i)?.[1] || ''
  } catch {
    return ''
  }
}

export function validatePreviewSupabaseTarget(values, databaseUrl) {
  const apiRef = projectRefFromApiUrl(values.SUPABASE_URL)
  const viteRef = projectRefFromApiUrl(values.VITE_SUPABASE_URL)
  const databaseRef = projectRefFromDatabaseUrl(databaseUrl)
  if (!apiRef || !viteRef || !databaseRef || apiRef !== viteRef || apiRef !== databaseRef) {
    throw new Error('Preview Supabase URLs do not all identify the configured staging database; no Vercel changes were made.')
  }
  const serviceKey = String(values.SUPABASE_SERVICE_ROLE_KEY || '')
  const jwtPayload = serviceKey.split('.')[1]
  if (jwtPayload) {
    try {
      const claims = JSON.parse(Buffer.from(jwtPayload, 'base64url').toString('utf8'))
      if (claims.ref && claims.ref !== apiRef) {
        throw new Error('The Preview service-role key belongs to a different Supabase project; no Vercel changes were made.')
      }
    } catch (error) {
      if (error.message.includes('different Supabase project')) throw error
    }
  }
}

async function upsertTargetVariables(values, projectId, envs, targetName) {
  const projectPath = `/v10/projects/${encodeURIComponent(projectId)}/env`
  for (const key of Object.keys(values)) {
    const variable = {
      value: values[key],
      type: PUBLIC_KEYS.has(key) ? 'plain' : 'encrypted',
      target: [targetName],
    }
    const existing = getTargetMatch(envs, key, targetName)

    if (existing) {
      try {
        await request(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          body: { value: values[key], target: [targetName] },
        })
      } catch (error) {
        throw new Error(`Failed to update ${key}: ${error.message}`)
      }
      console.log(`[vercel-env] Updated ${key} (${targetName})`)
    } else {
      let created
      try {
        created = await request(projectPath, {
          method: 'POST',
          body: { key, ...variable },
        })
      } catch (error) {
        throw new Error(`Failed to create ${key}: ${error.message}`)
      }
      if (created.id) envs.push({ key, ...variable, id: created.id })
      console.log(`[vercel-env] Added ${key} (${targetName})`)
    }
  }
}

async function removeLegacyPublicSecrets(projectId, envs, targetName) {
  const oldEntries = envs.filter((item) =>
    LEGACY_PUBLIC_SECRETS.includes(item.key) && item.target?.includes(targetName)
  )
  for (const entry of oldEntries) {
    getTargetMatch(envs, entry.key, targetName)
    await request(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE',
    })
    console.log(`[vercel-env] Removed obsolete ${entry.key} (${targetName})`)
  }
}

let token = ''
let teamId = ''

async function main() {
  if (!['preview', 'production', 'development'].includes(target)) {
    throw new Error('Specify --target preview, production, or development. Production also requires --confirm-production.')
  }
  if (target === 'production' && !confirmProduction) {
    throw new Error('Production sync requires the explicit --confirm-production flag.')
  }
  const values = loadValues()
  for (const key of Object.keys(values)) console.log(`[vercel-env] ${key}: ready`)
  if (target === 'preview') {
    const databaseUrl = resolveSetting('SUPABASE_STAGING_DB_URL') || resolveSetting('SUPABASE_DB_URL')
    validatePreviewSupabaseTarget(values, databaseUrl)
    console.log('[vercel-env] Preview Supabase values match the configured staging database.')
  }

  if (dryRun) {
    console.log(`[vercel-env] ${target} dry run complete; no Vercel changes were made.`)
    return
  }

  token = resolveSetting('VERCEL_TOKEN')
  if (!token) throw new Error('Set VERCEL_TOKEN in the shell or in .env.local before syncing.')

  const projectConfig = getProjectConfig()
  if (!projectConfig.projectId) {
    throw new Error('Set VERCEL_PROJECT_ID in the shell or in .env.local, or link the project with the Vercel CLI first.')
  }
  if (invalidValue(projectConfig.projectId)) {
    throw new Error('VERCEL_PROJECT_ID is still an example value; use the real ID from Vercel Project Settings > General.')
  }
  if (projectConfig.teamId && invalidValue(projectConfig.teamId)) {
    throw new Error('VERCEL_TEAM_ID is still an example value; use the real team ID from Vercel Team Settings or omit it for a personal project.')
  }
  teamId = projectConfig.teamId

  const projectId = encodeURIComponent(projectConfig.projectId)
  const response = await request(`/v9/projects/${projectId}/env?limit=100`)
  const envs = Array.isArray(response.envs) ? response.envs : []

  await upsertTargetVariables(values, projectConfig.projectId, envs, target)
  await removeLegacyPublicSecrets(projectConfig.projectId, envs, target)
  console.log(`[vercel-env] ${target[0].toUpperCase()}${target.slice(1)} environment sync complete.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[vercel-env] ${error.message}`)
    process.exitCode = 1
  })
}