#!/usr/bin/env node
// Enforces the four architecture rules in AGENTS.md as a lint step, so a future
// change cannot silently reintroduce what those rules forbid:
//
//   Rule 1  The app is free: no payment processing, billing, checkout, in-app
//           purchase or purchasable storage tier.
//   Rule 2  User-generated content stays reportable and blockable (content_reports
//           / blocked_users, src/lib/moderation.js, feed controls, admin review).
//   Rule 3  VITE_AUTH_PROVIDER stays "supabase" until every enabled Appwrite
//           surface has been migrated and verified.
//   Rule 4  The service-role key never proxies user data; the Appwrite gateway
//           keeps its server-verified, RLS-scoped ("SET LOCAL ROLE authenticated")
//           transaction.
//
// Rule 1 is a content scan of the shipped surfaces (src, api, server,
// supabase/functions, supabase/migrations newer than the removal migration,
// scripts, root config files and workflows). Docs are exempt: the store-compliance
// copy intentionally states that no payment exists. Migrations up to and including
// 20261020090000_remove_payments_and_storage_upgrades.sql are the audit trail of
// the removal and are exempt by version; anything newer is scanned in full.
//
// Usage: npm run lint   (or: node scripts/check-project-rules.mjs)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- Rule 1: no payment, billing, checkout or purchases -------------------

const PAYMENT_TOKENS = new RegExp(
  '\\b(?:' + [
    'nowpayments',
    'storage_purchases',
    'payment_settings',
    'payment_webhook_events',
    'payment_webhook_log',
    'payment[-_]qr',
    'user_storage_quotas',
    'invoice_number_seq',
    'submit_usdt_payment',
    'review_usdt_payment',
    'create[-_]storage[-_]checkout',
    'checkout_session_id',
    'usdt',
    'stripe',
    'paypal',
    'revenuecat',
    'braintree',
    'razorpay',
    'adyen',
    'mollie',
    'flutterwave',
    'lemonsqueezy',
    'paddle',
  ].join('|') + ')\\b',
  'i',
)

const PAYMENT_WORDS = /\b(payments?|billing|checkout|paywalls?|in[-_ ]app[-_ ]purchases?|iap)\b/i
// Store policy requires stating the *absence* of payments, so copy such as
// "No payments or purchases" or "we do not sell in-app purchases" is not a
// violation. Only the bare words honour this cue; the exact tokens below (a
// gateway name, a retired table, an env var) always fail.
const PAYMENT_NEGATION = /\b(no|not|never|without)\b/i
// The GitHub checkout action is not a payment checkout.
const PAYMENT_WORD_ALLOW = /\bactions\/checkout\b/

const MIGRATION_DIR = 'supabase/migrations'
// Legacy history: every migration up to and including the payment removal.
const LAST_LEGACY_MIGRATION = '20261020090000'

// ---- File scanning --------------------------------------------------------

const SKIP_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', '.wrangler', 'welcome-hub',
  'android', 'ios', '.trae', '.agents', 'docs',
  // Gitignored local Chromium download used by the layout audits.
  '.playwright-browsers',
  // Gitignored database dumps predate the payment removal and still contain the
  // retired rows; they are not shipped code.
  'backups',
])

const SCAN_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.sql', '.yml', '.yaml', '.toml',
])

const EXTRA_FILES = new Set(['.env.example'])

const SKIP_FILES = new Set([
  'package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml',
])

// These two files enumerate the retired tokens as data (this checker's patterns
// and the live verifier's database assertions); they are the enforcement tooling
// itself, not application code.
const ALLOW_FILES = new Set([
  'scripts/check-project-rules.mjs',
  'scripts/live-verify.mjs',
])

function isLegacyMigration(relPath) {
  if (!relPath.startsWith(MIGRATION_DIR + '/')) return false
  const version = path.basename(relPath).match(/^(\d{14})/)?.[1]
  return Boolean(version) && version <= LAST_LEGACY_MIGRATION
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (SKIP_SEGMENTS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (SKIP_FILES.has(entry.name)) continue
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name)) && !EXTRA_FILES.has(entry.name)) continue
    out.push(rel)
  }
  return out
}

const failures = []
const passes = []
const fail = (rule, name, detail) => failures.push({ rule, name, detail })
const pass = (rule, name) => passes.push({ rule, name })

function readText(relPath) {
  const full = path.join(ROOT, relPath)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
}

// ---- Rule 1 ---------------------------------------------------------------

function checkRule1(files) {
  let hits = 0
  for (const rel of files) {
    if (ALLOW_FILES.has(rel)) continue
    if (rel.startsWith(MIGRATION_DIR + '/') && isLegacyMigration(rel)) continue
    const text = readText(rel)
    if (text == null || text.length > 2_000_000) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (PAYMENT_TOKENS.test(line) || (PAYMENT_WORDS.test(line)
        && !PAYMENT_NEGATION.test(line) && !PAYMENT_WORD_ALLOW.test(line))) {
        fail('1', 'payment surface', `${rel}:${i + 1}  ${line.trim().slice(0, 120)}`)
        hits += 1
      }
    }
  }
  if (!hits) pass('1', 'no payment/billing/checkout references in shipped code')
}

// ---- Rule 2 ---------------------------------------------------------------

const MODERATION_EXPORTS = ['reportContent', 'blockUser', 'unblockUser', 'getBlockedUserIds', 'listReports', 'resolveReport']

function checkRule2() {
  const moderation = readText('src/lib/moderation.js')
  if (!moderation) {
    fail('2', 'moderation module present', 'src/lib/moderation.js is missing')
  } else {
    const missingExports = MODERATION_EXPORTS
      .filter((name) => !new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(moderation))
    if (missingExports.length) fail('2', 'moderation exports', `missing: ${missingExports.join(', ')}`)
    if (!/content_reports/.test(moderation) || !/blocked_users/.test(moderation)) {
      fail('2', 'moderation tables', 'src/lib/moderation.js must use content_reports and blocked_users')
    }
  }

  const migrationsDir = path.join(ROOT, MIGRATION_DIR)
  const migrationSql = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
        .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n')
    : ''
  const schemaSql = readText(path.join('docs', 'supabase-schema.sql')) || ''
  for (const [table, source] of [['content_reports', migrationSql], ['blocked_users', migrationSql]]) {
    if (!new RegExp(`create table(?: if not exists)? public\\.${table}\\b`, 'i').test(source)) {
      fail('2', `migration creates ${table}`, 'no migration creates the table')
    }
    if (!new RegExp(`alter table public\\.${table} enable row level security`, 'i').test(source)) {
      fail('2', `RLS on ${table}`, 'no migration enables row level security')
    }
    if (!new RegExp(`public\\.${table}\\b`, 'i').test(schemaSql)) {
      fail('2', `${table} in canonical schema`, 'docs/supabase-schema.sql does not declare the table')
    }
  }

  const feed = readText('src/lib/feeds.js') || ''
  if (!/getBlockedUserIds/.test(feed)) fail('2', 'blocked authors filtered', 'src/lib/feeds.js no longer filters blocked authors')

  const feedPage = readText(path.join('src', 'pages', 'FeedsPage.jsx')) || ''
  if (!/blockUser/.test(feedPage)) fail('2', 'block control in feed', 'src/pages/FeedsPage.jsx no longer exposes blocking')

  const reportDialog = readText(path.join('src', 'components', 'ReportDialog.jsx')) || ''
  if (!/reportContent/.test(reportDialog)) fail('2', 'report action', 'src/components/ReportDialog.jsx no longer reports content')

  const adminReview = readText(path.join('src', 'components', 'AdminReportManager.jsx')) || ''
  if (!/resolveReport/.test(adminReview)) fail('2', 'admin report review', 'src/components/AdminReportManager.jsx no longer resolves reports')

  if (!failures.some((f) => f.rule === '2')) pass('2', 'UGC report + block surfaces intact (tables, RLS, feed, admin review)')
}

// ---- Rule 3 ---------------------------------------------------------------

function checkRule3(files) {
  const envExample = readText('.env.example') || ''
  if (!/^\s*VITE_AUTH_PROVIDER\s*=\s*supabase\s*$/m.test(envExample)) {
    fail('3', 'default provider', '.env.example must set VITE_AUTH_PROVIDER=supabase')
  }

  const runtimeEnv = readText(path.join('scripts', 'generate-runtime-env.js')) || ''
  if (!/VITE_AUTH_PROVIDER:\s*'supabase'/.test(runtimeEnv)) {
    fail('3', 'runtime default', 'scripts/generate-runtime-env.js must default VITE_AUTH_PROVIDER to supabase')
  }

  const viteConfig = readText('vite.config.js') || ''
  if (!/VITE_AUTH_PROVIDER\s*\|\|\s*['"]supabase['"]/.test(viteConfig)) {
    fail('3', 'build default', 'vite.config.js must fall back to supabase for VITE_AUTH_PROVIDER')
  }

  const appwriteLib = readText(path.join('src', 'lib', 'appwrite.js')) || ''
  if (!/VITE_AUTH_PROVIDER\s*\|\|\s*'supabase'/.test(appwriteLib)) {
    fail('3', 'client default', "src/lib/appwrite.js must fall back to 'supabase'")
  }

  const offender = /VITE_AUTH_PROVIDER\s*[:=]\s*['"]?appwrite/i
  for (const rel of files) {
    if (rel.endsWith('.md')) continue
    const text = readText(rel)
    if (text && offender.test(text)) {
      fail('3', 'provider override', `${rel} sets VITE_AUTH_PROVIDER to appwrite`)
    }
  }
  if (!failures.some((f) => f.rule === '3')) pass('3', 'VITE_AUTH_PROVIDER defaults to supabase everywhere')
}

// ---- Rule 4 ---------------------------------------------------------------

function checkRule4() {
  for (const rel of walk(path.join(ROOT, 'src'))) {
    const text = readText(rel) || ''
    if (/SERVICE_ROLE/.test(text)) {
      fail('4', 'service-role in browser code', `${rel} references the service-role key`)
    }
  }

  const database = readText(path.join('server', 'appwriteDatabase.js')) || ''
  if (!/SET LOCAL ROLE authenticated/i.test(database)) {
    fail('4', 'authenticated transaction', 'server/appwriteDatabase.js must SET LOCAL ROLE authenticated')
  }
  if (!/request\.jwt\.claim\.sub/.test(database)) {
    fail('4', 'RLS identity claim', 'server/appwriteDatabase.js must set request.jwt.claim.sub for RLS')
  }

  const gateway = readText(path.join('server', 'appwriteGateway.js')) || ''
  if (!/verifyAppwriteSession\(/.test(gateway)) {
    fail('4', 'Appwrite session verified', 'server/appwriteGateway.js must verify the Appwrite session server-side')
  }
  if (!/withAuthenticatedDatabaseTransaction\(/.test(gateway)) {
    fail('4', 'user data sandboxed', 'server/appwriteGateway.js must run user data through the authenticated transaction')
  }
  if (!failures.some((f) => f.rule === '4')) pass('4', 'service-role key stays out of the client; gateway keeps RLS-scoped execution')
}

// ---- Run ------------------------------------------------------------------

const files = walk(ROOT)

checkRule1(files)
checkRule2()
checkRule3(files)
checkRule4()

const RULE_TITLES = {
  1: 'no payment, billing, checkout or purchases',
  2: 'UGC stays reportable and blockable',
  3: 'VITE_AUTH_PROVIDER stays supabase',
  4: 'no service-role proxying of user data',
}

console.log('AGENTS.md project rules')
for (const rule of [1, 2, 3, 4]) {
  console.log(`\n  Rule ${rule} — ${RULE_TITLES[rule]}`)
  for (const p of passes.filter((x) => x.rule === String(rule))) {
    console.log(`    PASS  ${p.name}`)
  }
  for (const f of failures.filter((x) => x.rule === String(rule))) {
    console.log(`    FAIL  ${f.name}  ->  ${f.detail}`)
  }
}

if (failures.length) {
  console.error(`\n${failures.length} project rule violation(s). See AGENTS.md.`)
  process.exitCode = 1
} else {
  console.log('\nAll four project rules hold.')
}
