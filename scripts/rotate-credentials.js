#!/usr/bin/env node
// Rotate the application's server-side credentials on a schedule.
//
//   npm run credentials:status                 # what is recorded, what is due
//   npm run credentials:rotate                 # dry run: generate + validate only
//   npm run credentials:rotate -- --apply      # rotate and persist to .env.local
//   npm run credentials:rotate -- --apply --due 30
//   npm run credentials:rotate -- --rollback OTP_HASH_SECRET --apply
//
// Every run reads and writes the encrypted vault (scripts/lib/credential-vault.js)
// so the superseded value survives and a failed rotation can be rolled back. The
// vault key comes from CREDENTIAL_VAULT_KEY in the shell or the gitignored
// .env.local and is never written to the store or to git.
//
// After `--apply`, regenerate and push the runtime environment:
//   npm run env:generate && npm run vercel:env:sync
// (OTP_HASH_SECRET is also a Supabase Edge Function secret; update it with
//  `supabase secrets set OTP_HASH_SECRET=...`.)

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createAdminSessionToken, verifyAdminSessionToken } from '../server/adminSession.js'
import { otpHashPayload } from '../supabase/functions/_shared/otp-email.js'
import {
  createEnvFilePersist,
  credentialStatus,
  readEnvValue,
  rollbackCredential,
  runRotationPlan,
} from './lib/credential-rotation.js'
import {
  loadVault,
  readLocalEnvValue,
  resolveVaultKey,
  saveVault,
  VAULT_KEY_ENV,
} from './lib/credential-vault.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LOCAL_HMAC_DAYS = 90

export function generateHexSecret() {
  return crypto.randomBytes(32).toString('hex')
}

// The new secret must actually sign and verify an admin session token, and a
// different secret must not — otherwise the value was not applied correctly.
export async function validateAdminSessionSecret(value) {
  if (String(value).length < 32) throw new Error('the signing secret must be at least 32 characters')
  const token = await createAdminSessionToken('rotation-probe', value, 60)
  const decoded = await verifyAdminSessionToken(token, value)
  if (!decoded || decoded.userId !== 'rotation-probe') {
    throw new Error('the new secret could not sign and verify a session token')
  }
  if (await verifyAdminSessionToken(token, `${value}-wrong`)) {
    throw new Error('a different secret verified the token; the new secret is not in effect')
  }
}

// The hash secret must be long and must be the one feeding the HMAC, so a code
// issued before the rotation cannot verify against a hash produced after it.
export function validateOtpHashSecret(value) {
  const secret = String(value)
  if (secret.length < 32) throw new Error('the OTP hash secret must be at least 32 characters')
  const payload = otpHashPayload({ code: '1234', email: 'rotation-probe@example.test', purpose: 'signup' })
  const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  if (hash.length !== 64) throw new Error('the OTP hash secret did not produce an HMAC-SHA256 digest')
  const other = crypto.createHmac('sha256', `${secret}-wrong`).update(payload).digest('hex')
  if (hash === other) throw new Error('the OTP hash secret is not being applied to the digest')
}

// The registry of credentials this project owns and can rotate without a
// provider API. Add an entry here to bring a new credential under the same
// validate/rollback guarantees; a provider-issued key or service-account
// password uses the same shape with `generate` calling the provider to mint a
// value, `persist` writing it locally, and `revoke` retiring the old one.
export function createCredentialProviders({ rootDir }) {
  const persist = createEnvFilePersist({ filePath: path.join(rootDir, '.env.local') })
  return [
    {
      key: 'ADMIN_SESSION_SECRET',
      provider: 'local-hmac',
      intervalDays: LOCAL_HMAC_DAYS,
      generate: generateHexSecret,
      validate: validateAdminSessionSecret,
      persist,
    },
    {
      key: 'OTP_HASH_SECRET',
      provider: 'local-hmac',
      intervalDays: LOCAL_HMAC_DAYS,
      generate: generateHexSecret,
      validate: validateOtpHashSecret,
      persist,
    },
  ]
}

function parseArgs(argv) {
  const all = (flag) => {
    const values = []
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === flag && argv[index + 1]) values.push(argv[index + 1])
    }
    return values
  }
  const single = (flag) => all(flag)[0] || ''
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    status: argv.includes('--status'),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    rollback: single('--rollback'),
    keys: all('--key'),
    due: single('--due') ? Number(single('--due')) : null,
  }
}

function promptHandoffCode() {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal to enter the one-time vault authorization code.')
  }

  return new Promise((resolve, reject) => {
    let code = ''
    const finish = (error) => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(code)
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Vault authorization was cancelled.'))
        if (character === '\r' || character === '\n') {
          if (code.length !== 43) return finish(new Error('The one-time vault authorization code is malformed.'))
          return finish()
        }
        if (character === '\u007f' || character === '\b') {
          code = code.slice(0, -1)
        } else if (/^[A-Za-z0-9_-]$/.test(character) && code.length < 43) {
          code += character
        }
      }
    }
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.resume()
    input.on('data', onData)
    process.stdout.write('One-time vault authorization code (input hidden): ')
  })
}

function resolveWorkflowApiUrl(rootDir) {
  const value = String(
    process.env.WORKFLOW_SESSION_API_URL
    || readLocalEnvValue(rootDir, 'WORKFLOW_SESSION_API_URL')
    || '',
  ).trim()
  if (!value) {
    throw new Error('Set WORKFLOW_SESSION_API_URL to the authorized app origin before using the credential CLI.')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('WORKFLOW_SESSION_API_URL must be an HTTPS app origin.')
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('WORKFLOW_SESSION_API_URL must use HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('WORKFLOW_SESSION_API_URL must not contain credentials, query parameters, or a fragment.')
  }
  return url.origin
}

export async function redeemWorkflowCliHandoff({ baseUrl, code, fetchImpl = fetch }) {
  const redemption = await fetchImpl(`${baseUrl}/api/workflow-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'redeem_cli_handoff', code }),
  })
  const redeemed = await redemption.json().catch(() => ({}))
  if (!redemption.ok || !/^[A-Za-z0-9_-]{43}$/.test(String(redeemed.token || ''))) {
    throw new Error(redeemed.error || 'The vault authorization handoff could not be redeemed.')
  }

  const token = redeemed.token
  const validation = await fetchImpl(`${baseUrl}/api/workflow-cli-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  redeemed.token = ''
  const validated = await validation.json().catch(() => ({}))
  if (!validation.ok || validated.session?.kind !== 'vault' || validated.session?.status !== 'active') {
    throw new Error(validated.error || 'The CLI vault session is not active.')
  }
  return { expiresAt: validated.session.expiresAt }
}

async function authorizeVaultCli(rootDir) {
  const baseUrl = resolveWorkflowApiUrl(rootDir)
  console.log(`[credentials] Open ${baseUrl}/workflow-cli-handoff in a signed-in browser and create a code.`)
  const code = await promptHandoffCode()
  return redeemWorkflowCliHandoff({ baseUrl, code })
}

function describe(result) {
  const from = result.previousFingerprint ? `sha256:${result.previousFingerprint}` : '(none)'
  const to = result.nextFingerprint ? `sha256:${result.nextFingerprint}` : '(none)'
  return `${result.key}  ${result.status}  ${from} -> ${to}${result.reason ? `  (${result.reason})` : ''}`
}

function printStatus(vault, providers, asJson) {
  const report = providers.map((descriptor) => credentialStatus(vault, descriptor.key, {
    intervalDays: descriptor.intervalDays,
  }))
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return report
  }
  console.log('[credentials] recorded state')
  for (const item of report) {
    const state = item.versions ? `${item.versions} version(s), updated ${item.updatedAt}` : 'no recorded version'
    console.log(`[credentials] ${item.key}  ${item.due ? 'DUE' : 'ok'}  ${item.activeFingerprint}  ${state}`)
    for (const superseded of item.superseded) {
      console.log(`[credentials]     superseded ${superseded.at}  ${superseded.reason}  sha256:${superseded.fingerprint}`)
    }
  }
  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node scripts/rotate-credentials.js [--status|--rollback KEY] [--key KEY] [--apply] [--due DAYS] [--json]')
    console.log('All vault operations require an approved browser session and a one-time code entered at the hidden prompt.')
    return
  }

  const rootDir = process.env.CREDENTIALS_ROOT || ROOT
  const authorization = await authorizeVaultCli(rootDir)
  console.log(`[credentials] Vault authorization verified until ${authorization.expiresAt}.`)
  const passphrase = resolveVaultKey(rootDir)
  const providers = createCredentialProviders({ rootDir })
  const selected = args.keys.length ? providers.filter((item) => args.keys.includes(item.key)) : providers
  if (args.keys.length && !selected.length) {
    throw new Error(`No rotatable credential matches ${args.keys.join(', ')}. Known keys: ${providers.map((p) => p.key).join(', ')}`)
  }
  if (args.rollback && !providers.some((item) => item.key === args.rollback)) {
    throw new Error(`Unknown rollback target "${args.rollback}". Known keys: ${providers.map((p) => p.key).join(', ')}`)
  }

  const needsVault = args.apply || Boolean(args.rollback) || fs.existsSync(path.join(rootDir, '.nexus-credentials', 'rotation-vault.json'))
  if (needsVault && !passphrase) {
    throw new Error(`${VAULT_KEY_ENV} is required. Add it to .env.local (gitignored) or export it before rotating.`)
  }

  const vault = loadVault({ rootDir, passphrase })
  const context = {
    vault,
    passphrase,
    readCurrent: (key) => process.env[key] || readEnvValue(path.join(rootDir, '.env.local'), key),
    saveVault: () => saveVault(vault, { rootDir, passphrase }),
    now: new Date(),
    dryRun: !args.apply,
    dueDays: args.due,
    logger: console,
  }

  if (args.status) {
    printStatus(vault, providers, args.json)
    return
  }

  const report = args.rollback
    ? [await rollbackCredential(providers.find((item) => item.key === args.rollback), context)]
    : await runRotationPlan(selected, context)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`[credentials] ${args.apply ? 'applied' : 'dry run'}`)
    for (const item of report) console.log(`[credentials] ${describe(item)}`)
    for (const descriptor of providers) {
      const status = credentialStatus(vault, descriptor.key, { intervalDays: descriptor.intervalDays })
      if (status.due) console.log(`[credentials] ${descriptor.key} is due for rotation.`)
    }
  }

  if (report.some((item) => item.status === 'failed' || item.status === 'rolled-back')) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[credentials] ${error.message}`)
    process.exitCode = 1
  })
}
