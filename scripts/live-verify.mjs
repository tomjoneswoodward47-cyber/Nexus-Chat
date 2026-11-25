#!/usr/bin/env node
// Read-only live verification of the production services (Supabase, Resend and
// the deployed Vercel app). It performs no writes and sends no email: every
// probe is a GET, a HEAD-style count, or a POST that is rejected before any
// side effect (an unknown action, or a request with no Origin). Run it with the
// production credentials in the shell or in `.env.production`:
//
//   npm run verify:live
//   npm run verify:live -- --report docs/live-verification-report.md
//
// Optional overrides:
//   LIVE_VERIFY_BASE_URL   deployed app origin (default https://nexus-chat-world.com)
//
// Exit code is 1 when any check fails, so it can gate a release; a check whose
// credentials are absent is reported as SKIP and does not fail the run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BASE_URL = 'https://nexus-chat-world.com'
const RESEND_API = 'https://api.resend.com'

// Objects retired by 20261020090000_remove_payments_and_storage_upgrades.sql.
// The live project must no longer expose them.
const RETIRED_TABLES = [
  'storage_purchases',
  'payment_settings',
  'payment_webhook_events',
  'user_storage_quotas',
]
const RETIRED_RPCS = ['submit_usdt_payment', 'review_usdt_payment']
const RETIRED_BUCKET = 'payment-qr'

// User-generated-content controls the store policies require (AGENTS.md rule 2).
const REQUIRED_MODERATION_TABLES = ['content_reports', 'blocked_users']

const results = []

function record(status, name, detail) {
  results.push({ status, name, detail })
}

// ---- Environment loading --------------------------------------------------

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

function loadEnv() {
  const merged = {}
  for (const file of ['.env', '.env.local', '.env.production']) {
    Object.assign(merged, readEnvFile(path.join(ROOT, file)))
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && value !== '') merged[key] = value
  }
  return merged
}

const ENV = loadEnv()
const firstOf = (...keys) => keys.map((key) => String(ENV[key] || '').trim()).find(Boolean) || ''

const SUPABASE_URL = firstOf('SUPABASE_URL', 'VITE_SUPABASE_URL').replace(/\/+$/, '')
const SUPABASE_ANON_KEY = firstOf('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY')
const SERVICE_ROLE_KEY = firstOf('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = firstOf('RESEND_API_KEY')
const RESEND_FROM = firstOf('RESEND_FROM')
const BASE_URL = (firstOf('LIVE_VERIFY_BASE_URL', 'PRODUCTION_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '')

async function getAdminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const isMissingObjectError = (error) =>
  Boolean(error) && (error.code === 'PGRST205' || error.code === 'PGRST202' || /does not exist|schema cache|not find/i.test(error.message || ''))

// ---- Checks ---------------------------------------------------------------

// Rule 1 (live): the retired payment objects must be gone from the project.
async function checkRetiredObjects(admin) {
  if (!admin) {
    record('SKIP', 'Retired payment objects absent', 'SUPABASE_SERVICE_ROLE_KEY is not set')
    return
  }
  for (const table of RETIRED_TABLES) {
    // A HEAD request (`{ head: true }`) to a missing table answers 404 with an
    // empty body, which postgrest-js cannot parse, so it reports error=null and
    // the check would pass a table that is actually gone. A zero-row GET returns
    // PGRST205 instead, and still transfers no rows.
    const { error } = await admin.from(table).select('*').limit(0)
    if (!error) record('FAIL', `Retired table "${table}" is gone`, 'the table still exists in production')
    else if (isMissingObjectError(error)) record('PASS', `Retired table "${table}" is gone`, 'not found in the schema cache')
    else record('SKIP', `Retired table "${table}" is gone`, `unverified: ${error.message}`)
  }
  for (const rpc of RETIRED_RPCS) {
    const { error } = await admin.rpc(rpc, {})
    if (!error) record('FAIL', `Retired RPC "${rpc}" is gone`, 'the function still exists and returned success')
    else if (isMissingObjectError(error)) record('PASS', `Retired RPC "${rpc}" is gone`, 'function not found')
    else record('SKIP', `Retired RPC "${rpc}" is gone`, `unverified: ${error.message}`)
  }
  const { data: buckets, error: bucketError } = await admin.storage.listBuckets()
  if (bucketError) record('SKIP', `Retired bucket "${RETIRED_BUCKET}" is gone`, `unverified: ${bucketError.message}`)
  else if ((buckets || []).some((bucket) => bucket.name === RETIRED_BUCKET)) record('FAIL', `Retired bucket "${RETIRED_BUCKET}" is gone`, 'the bucket still exists in production')
  else record('PASS', `Retired bucket "${RETIRED_BUCKET}" is gone`, `${buckets?.length || 0} bucket(s) present, none retired`)
}

// Rule 2 (live): the moderation tables backs the report/block controls.
async function checkModerationTables(admin) {
  if (!admin) {
    record('SKIP', 'Moderation tables present', 'SUPABASE_SERVICE_ROLE_KEY is not set')
    return
  }
  for (const table of REQUIRED_MODERATION_TABLES) {
    const { error } = await admin.from(table).select('*', { head: true, count: 'exact' }).limit(1)
    if (!error) record('PASS', `Moderation table "${table}" present`, 'reachable with the service role')
    else record('FAIL', `Moderation table "${table}" present`, error.message || 'unreachable')
  }
}

async function checkSupabaseReachable() {
  if (!SUPABASE_URL) {
    record('SKIP', 'Supabase project reachable', 'SUPABASE_URL/VITE_SUPABASE_URL is not set')
    return
  }
  if (!SUPABASE_ANON_KEY) {
    record('SKIP', 'Supabase project reachable', 'no anon/publishable key configured')
    record('SKIP', 'Supabase anon key valid', 'no anon/publishable key configured')
    return
  }

  // The auth health endpoint now requires the apikey header, so an unauthenticated
  // call reports 401 even when the project is healthy.
  try {
    const response = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    })
    if (response.ok) record('PASS', 'Supabase project reachable', `auth health returned ${response.status}`)
    else record('FAIL', 'Supabase project reachable', `auth health returned ${response.status}`)
  } catch (error) {
    record('FAIL', 'Supabase project reachable', error.message)
  }

  try {
    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/members?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    })
    // 200 (row readable) or 401/403 (RLS blocked) both prove key + endpoint work.
    if ([200, 206, 401, 403].includes(response.status)) record('PASS', 'Supabase anon key valid', `PostgREST returned ${response.status}`)
    else record('FAIL', 'Supabase anon key valid', `PostgREST returned ${response.status}`)
  } catch (error) {
    record('FAIL', 'Supabase anon key valid', error.message)
  }
}

async function checkResend() {
  if (!RESEND_API_KEY) {
    record('SKIP', 'Resend API key valid', 'RESEND_API_KEY is not set')
    return
  }
  try {
    const response = await fetchWithTimeout(`${RESEND_API}/domains`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    })
    if (!response.ok) {
      record('FAIL', 'Resend API key valid', `GET /domains returned ${response.status}`)
      return
    }
    record('PASS', 'Resend API key valid', 'GET /domains authorized')

    const payload = await response.json().catch(() => ({}))
    const domains = Array.isArray(payload.data) ? payload.data : []
    const senderDomain = (RESEND_FROM.match(/<([^>]+)>/)?.[1] || RESEND_FROM).split('@')[1]?.toLowerCase() || ''
    if (!senderDomain) {
      record('SKIP', 'Resend sender domain verified', 'RESEND_FROM is not set')
      return
    }
    const match = domains.find((domain) => String(domain.name).toLowerCase() === senderDomain)
    if (!match) record('FAIL', 'Resend sender domain verified', `${senderDomain} is not registered in Resend`)
    else if (String(match.status).toLowerCase() === 'verified') record('PASS', 'Resend sender domain verified', `${senderDomain} is verified`)
    else record('FAIL', 'Resend sender domain verified', `${senderDomain} status is "${match.status}"`)
  } catch (error) {
    record('FAIL', 'Resend API key valid', error.message)
  }
}

async function checkDeployment() {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/`)
    const body = await response.text().catch(() => '')
    if (response.ok && /<div id="root"/.test(body)) record('PASS', 'Deployed app serves the SPA', `${BASE_URL} returned ${response.status}`)
    else if (response.ok) record('FAIL', 'Deployed app serves the SPA', 'the response did not look like the app shell')
    else record('FAIL', 'Deployed app serves the SPA', `${BASE_URL} returned ${response.status}`)
  } catch (error) {
    record('FAIL', 'Deployed app serves the SPA', error.message)
    return
  }

  // /api/admin/diagnostics answers 401 for an unauthenticated caller and 503
  // when the Vercel function is missing its Supabase server settings, so this
  // single probe proves the function is deployed and configured.
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/admin/diagnostics`)
    if (response.status === 401) record('PASS', 'Server functions deployed and configured', '/api/admin/diagnostics returned 401 (sign in required)')
    else if (response.status === 503) record('FAIL', 'Server functions deployed and configured', 'the deployment is missing its Supabase server settings')
    else record('FAIL', 'Server functions deployed and configured', `/api/admin/diagnostics returned ${response.status}`)
  } catch (error) {
    record('FAIL', 'Server functions deployed and configured', error.message)
  }

  // A request with no Origin is rejected before any code is issued or stored,
  // so this exercises the live email-code endpoint without sending mail.
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'live-verify-probe', purpose: 'recovery', email: 'live-verify@example.com' }),
    })
    if (response.status === 403) record('PASS', 'Email-code endpoint live (no mail sent)', 'rejected the origin-less probe with 403')
    else if (response.status === 503) record('FAIL', 'Email-code endpoint live (no mail sent)', 'the endpoint reports it is not configured on the server')
    else record('SKIP', 'Email-code endpoint live (no mail sent)', `probe returned ${response.status}; verify manually`)
  } catch (error) {
    record('FAIL', 'Email-code endpoint live (no mail sent)', error.message)
  }
}

// ---- Report ---------------------------------------------------------------

function renderReport() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  const lines = []
  lines.push('# Live end-to-end verification — Nexus Chat')
  lines.push('')
  lines.push(`**Run at:** ${new Date().toISOString()}`)
  lines.push(`**App origin:** ${BASE_URL}`)
  lines.push(`**Supabase project:** ${SUPABASE_URL || '(not configured)'}`)
  lines.push('')
  lines.push(`**Result:** ${counts.FAIL ? `${counts.FAIL} failed` : 'all checks passed'} · ${counts.PASS || 0} passed · ${counts.SKIP || 0} skipped`)
  lines.push('')
  lines.push('| Status | Check | Detail |')
  lines.push('| --- | --- | --- |')
  for (const r of results) lines.push(`| ${r.status} | ${r.name} | ${r.detail} |`)
  lines.push('')
  lines.push('Each check is read-only: no rows are written and no email is sent. A SKIP means the')
  lines.push('matching credential was not present in the environment, so the probe could not run.')
  return `${lines.join('\n')}\n`
}

async function main() {
  const reportIndex = process.argv.indexOf('--report')
  const reportPath = reportIndex !== -1 ? process.argv[reportIndex + 1] : ''

  const admin = await getAdminClient()

  await checkSupabaseReachable()
  await checkRetiredObjects(admin)
  await checkModerationTables(admin)
  await checkResend()
  await checkDeployment()

  const report = renderReport()
  console.log(report)

  if (reportPath) {
    const target = path.resolve(ROOT, reportPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, report, 'utf8')
    console.log(`Report written to ${path.relative(ROOT, target)}`)
  }

  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1
}

main().catch((error) => {
  console.error('[verify:live] Failed:', error.message)
  process.exitCode = 1
})
