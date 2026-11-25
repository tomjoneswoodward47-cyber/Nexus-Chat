// Provider-agnostic credential rotation engine.
//
// A "descriptor" describes one rotatable credential and the four operations the
// engine needs. Every operation is injected, which keeps the engine free of any
// particular vendor and makes it unit-testable without network or real secrets:
//
//   {
//     key,                    // the env/secret name, e.g. "ADMIN_SESSION_SECRET"
//     provider,               // short label for the origin, e.g. "local-hmac"
//     intervalDays,           // how long a value stays valid before rotation is due
//     available(context),     // optional: false when the credential is not configured
//     generate({ previous }), // produce the next value (a password, token or key)
//     validate(value, ctx),   // pre-flight check; throw (or return false) to reject
//     persist(value, ctx),    // write the value to every target (env file, API, ...)
//     verify(value, ctx),     // optional post-write check; defaults to re-reading
//     revoke({ previous }),   // optional: retire the superseded value at the provider
//   }
//
// The engine guarantees the safety properties a rotation needs:
//   * the previous value is captured before anything changes;
//   * the new value must validate before it is written;
//   * a write or post-write verification failure restores the previous value
//     (rollback) instead of leaving the system pointing at a value that does
//     not work;
//   * success is recorded in the encrypted vault so `previous` survives and a
//     later manual rollback is possible.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { credentialHistory, fingerprint, recordCredential } from './credential-vault.js'

export const DEFAULT_ROTATION_INTERVAL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const ENV_LINE = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/

// True when `lastRotatedAt` is missing or older than `intervalDays`.
export function rotationDue(lastRotatedAt, intervalDays = DEFAULT_ROTATION_INTERVAL_DAYS, now = new Date()) {
  if (!lastRotatedAt) return true
  const elapsed = now.getTime() - Date.parse(lastRotatedAt)
  if (!Number.isFinite(elapsed)) return true
  return elapsed >= intervalDays * DAY_MS
}

// ---- .env file persistence ------------------------------------------------

export function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return ''
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(ENV_LINE)
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, '')
  }
  return ''
}

// In-place update of a single key, creating the file (and its directory) when
// absent. Values are double-quoted; a value containing a quote or a newline is
// rejected rather than written in a form that would corrupt the file.
export function upsertEnvValue(filePath, key, value) {
  const text = String(value)
  if (/[\r\n"]/.test(text)) {
    throw new Error(`${key} contains characters that cannot be written to an env file.`)
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  const lines = existing ? existing.split(/\r?\n/) : []
  let replaced = false

  const updated = lines.map((line) => {
    const match = line.match(ENV_LINE)
    if (!match || match[1] !== key) return line
    replaced = true
    return `${key}="${text}"`
  })

  if (!replaced) {
    const trimmed = updated.join('\n').replace(/\s*$/, '')
    updated.splice(0, updated.length, ...(trimmed ? [trimmed, `${key}="${text}"`] : [`${key}="${text}"`]))
  }

  fs.writeFileSync(filePath, `${updated.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8')
  return filePath
}

export function createEnvFilePersist({ filePath }) {
  return async (value, { key }) => {
    upsertEnvValue(filePath, key, value)
  }
}

// ---- Engine ---------------------------------------------------------------

function rotationsOf(context) {
  if (!Array.isArray(context.vault.rotations)) context.vault.rotations = []
  return context.vault.rotations
}

function resolvePrevious(descriptor, context) {
  const recorded = context.vault.credentials?.[descriptor.key]?.active
  if (recorded) return String(recorded)
  const observed = context.readCurrent ? context.readCurrent(descriptor.key) : ''
  return observed ? String(observed) : ''
}

async function applyAndConfirm(descriptor, value, context) {
  await descriptor.persist(value, { key: descriptor.key, ...context })
  const verify = descriptor.verify || (async (candidate, ctx) => {
    if (!ctx.readCurrent) return
    const observed = ctx.readCurrent(descriptor.key)
    if (observed && observed !== candidate) {
      throw new Error('the value read back after writing does not match the rotated value')
    }
  })
  await verify(value, { key: descriptor.key, ...context })
}

async function restorePersisted(descriptor, value, context) {
  if (!value) return { ok: false, error: new Error('no previous value is available to restore') }
  try {
    await applyAndConfirm(descriptor, value, context)
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

export async function rotateCredential(descriptor, context) {
  const now = context.now || new Date()
  const at = now.toISOString()
  const logger = context.logger || console
  const rotationId = context.rotationId || `${descriptor.key}@${at}`
  const result = {
    key: descriptor.key,
    provider: descriptor.provider || 'unknown',
    status: 'skipped',
    reason: '',
    previousFingerprint: '',
    nextFingerprint: '',
  }

  if (descriptor.available && !descriptor.available(context)) {
    result.reason = 'not configured in this environment'
    return result
  }

  const previous = resolvePrevious(descriptor, context)
  result.previousFingerprint = fingerprint(previous)

  let candidate
  try {
    candidate = await descriptor.generate({ previous, now })
  } catch (error) {
    result.status = 'failed'
    result.reason = `generate failed: ${error.message}`
    return result
  }
  const value = candidate === null || candidate === undefined ? '' : String(candidate)
  if (!value || value === previous) {
    result.status = 'failed'
    result.reason = 'generate did not produce a new credential'
    return result
  }
  result.nextFingerprint = fingerprint(value)

  // Pre-flight validation: reject a bad value before it replaces a working one.
  try {
    const verdict = descriptor.validate ? await descriptor.validate(value, { key: descriptor.key, ...context }) : true
    if (verdict === false) throw new Error('the credential failed validation')
  } catch (error) {
    result.status = 'failed'
    result.reason = `validation rejected the new credential: ${error.message}`
    return result
  }

  if (context.dryRun) {
    result.status = 'validated'
    return result
  }

  // Write the new value; on any failure, put the previous value back.
  try {
    await applyAndConfirm(descriptor, value, context)
  } catch (error) {
    const restored = await restorePersisted(descriptor, previous, context)
    result.status = 'rolled-back'
    result.reason = `${error.message}; ${restored.ok ? 'previous credential restored' : `restore failed: ${restored.error.message}`}`
    rotationsOf(context).unshift({ key: descriptor.key, rotationId, at, status: 'rolled-back', detail: result.reason })
    context.saveVault?.()
    return result
  }

  // First rotation for a key: seed history with the value that was live before,
  // so a later rollback has something to restore. The outgoing entry is then
  // labelled as observed rather than rotated, because this project never minted it.
  const seeded = Boolean(previous) && !context.vault.credentials?.[descriptor.key]?.active
  if (seeded) {
    recordCredential(context.vault, descriptor.key, previous, { provider: descriptor.provider, rotationId, at })
  }
  recordCredential(context.vault, descriptor.key, value, {
    provider: descriptor.provider,
    rotationId,
    at,
    reason: seeded ? 'observed-before-rotation' : 'rotated-out',
  })
  rotationsOf(context).unshift({
    key: descriptor.key,
    rotationId,
    at,
    status: 'rotated',
    previous: result.previousFingerprint,
    next: result.nextFingerprint,
  })
  context.saveVault?.()
  result.status = 'rotated'

  // Retire the superseded value at the provider once the new one is confirmed.
  // A failure here is logged, not fatal: the rotation already succeeded.
  if (descriptor.revoke) {
    try {
      await descriptor.revoke({ previous, next: value, rotationId, ...context })
    } catch (error) {
      logger.warn(`[credentials] could not revoke the superseded ${descriptor.key} at the provider: ${error.message}`)
    }
  }

  return result
}

// Restores the most recently superseded value for a key and records the change,
// so the value the system was rolled back to becomes active again.
export async function rollbackCredential(descriptor, context) {
  const now = context.now || new Date()
  const result = { key: descriptor.key, provider: descriptor.provider || 'unknown', status: 'skipped', reason: '' }
  const superseded = (context.vault.credentials?.[descriptor.key]?.history || [])[0]
  if (!superseded?.value) {
    result.reason = 'no superseded value is recorded for this credential'
    return result
  }
  if (context.dryRun) {
    result.status = 'validated'
    result.reason = 'would restore the recorded previous value'
    return result
  }

  const restored = await restorePersisted(descriptor, superseded.value, context)
  if (!restored.ok) {
    result.status = 'failed'
    result.reason = restored.error.message
    return result
  }

  const at = now.toISOString()
  const rotationId = context.rotationId || `${descriptor.key}@rollback:${at}`
  recordCredential(context.vault, descriptor.key, superseded.value, {
    provider: descriptor.provider,
    rotationId,
    at,
    reason: 'rolled-back',
  })
  rotationsOf(context).unshift({ key: descriptor.key, rotationId, at, status: 'rolled-back' })
  context.saveVault?.()
  result.status = 'rolled-back'
  return result
}

// Rotates a list of descriptors in order, skipping any that are not yet due.
// `dueDays` overrides every descriptor's own interval; otherwise each credential
// keeps its declared cadence. Without a due check the plan would mint a new
// value on every run, so a scheduled job is idempotent only because of this.
export async function runRotationPlan(descriptors, context) {
  const report = []
  for (const descriptor of descriptors) {
    const interval = context.dueDays ?? descriptor.intervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS
    const last = context.vault.credentials?.[descriptor.key]?.updatedAt
    if (!rotationDue(last, interval, context.now)) {
      report.push({
        key: descriptor.key,
        provider: descriptor.provider || 'unknown',
        status: 'skipped',
        reason: `not due (interval ${interval} days)`,
        previousFingerprint: '',
        nextFingerprint: '',
      })
      continue
    }
    report.push(await rotateCredential(descriptor, context))
  }
  return report
}

// Redacted view of a credential's recorded history for `--status` output.
export function credentialStatus(vault, key, { intervalDays = DEFAULT_ROTATION_INTERVAL_DAYS, now = new Date() } = {}) {
  const entry = vault.credentials?.[key]
  const history = credentialHistory(vault, key)
  return {
    key,
    provider: entry?.provider || '',
    updatedAt: entry?.updatedAt || '',
    activeFingerprint: fingerprint(entry?.active),
    versions: history.length,
    due: rotationDue(entry?.updatedAt, intervalDays, now),
    superseded: history
      .filter((item) => item.reason !== 'active')
      .map((item) => ({ at: item.at, reason: item.reason, fingerprint: fingerprint(item.value) })),
  }
}

// Deterministic, non-reversible digest of a credential for logging.
export function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}
