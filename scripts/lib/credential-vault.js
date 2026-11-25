// Encrypted-at-rest store for rotated credentials.
//
// A rotation must be reversible, so both the previous and the new value have to
// survive the operation. Keeping them in a plaintext file next to the repo would
// defeat the point of rotating, so the whole store is sealed with AES-256-GCM
// under a key derived (scrypt) from a passphrase that lives only in the
// environment (CREDENTIAL_VAULT_KEY, fallback .env.local) — never in the store,
// never in git.
//
// The GCM auth tag doubles as tamper detection: editing the ciphertext makes
// decryption fail closed instead of silently yielding a corrupted credential.
//
// Usage:
//   const vault = loadVault({ rootDir, passphrase })
//   recordCredential(vault, 'ADMIN_SESSION_SECRET', nextValue, { provider, rotationId })
//   saveVault(vault, { rootDir, passphrase })

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const VAULT_KEY_ENV = 'CREDENTIAL_VAULT_KEY'
export const VAULT_DIR_NAME = '.nexus-credentials'
export const VAULT_FILE_NAME = 'rotation-vault.json'
export const VAULT_VERSION = 1

const ENVELOPE_ALGORITHM = 'aes-256-gcm'
const ENVELOPE_KDF = 'scrypt'
const KEY_BYTES = 32
const SCRYPT_SALT_BYTES = 16
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function vaultPaths(rootDir) {
  const dir = path.join(rootDir, VAULT_DIR_NAME)
  return { dir, file: path.join(dir, VAULT_FILE_NAME) }
}

// Reads a single key from .env.local, stripping the surrounding quotes that
// .env files use. Mirrors the loader in scripts/sync-vercel-env.js so the vault
// key can live alongside the other local-only settings.
export function readLocalEnvValue(rootDir, key) {
  const localEnvPath = path.join(rootDir, '.env.local')
  if (!fs.existsSync(localEnvPath)) return ''
  for (const line of fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, '')
  }
  return ''
}

// An exported shell variable wins over .env.local, so CI can inject the vault
// key without writing it to disk.
export function resolveVaultKey(rootDir, env = process.env) {
  const fromShell = String(env[VAULT_KEY_ENV] || '').trim()
  return fromShell || readLocalEnvValue(rootDir, VAULT_KEY_ENV).trim()
}

export function createEmptyVault() {
  return { version: VAULT_VERSION, updatedAt: new Date().toISOString(), credentials: {}, rotations: [] }
}

function deriveKey(passphrase, salt) {
  if (!passphrase) {
    throw new Error(`${VAULT_KEY_ENV} is required to read or write the credential vault.`)
  }
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES, SCRYPT_PARAMS)
}

export function encryptVault(vault, passphrase) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ENVELOPE_ALGORITHM, deriveKey(passphrase, salt), iv)
  const plaintext = Buffer.from(JSON.stringify(vault), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: VAULT_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    kdf: ENVELOPE_KDF,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptVault(envelope, passphrase) {
  if (!envelope || typeof envelope !== 'object') throw new Error('The credential vault envelope is malformed.')
  if (envelope.algorithm !== ENVELOPE_ALGORITHM || envelope.kdf !== ENVELOPE_KDF) {
    throw new Error(`Unsupported credential vault envelope (${envelope.algorithm || 'unknown'}).`)
  }
  const decipher = crypto.createDecipheriv(
    ENVELOPE_ALGORITHM,
    deriveKey(passphrase, Buffer.from(String(envelope.salt), 'hex')),
    Buffer.from(String(envelope.iv), 'hex'),
  )
  decipher.setAuthTag(Buffer.from(String(envelope.tag), 'hex'))
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.ciphertext), 'base64')),
      decipher.final(),
    ])
    const vault = JSON.parse(plaintext.toString('utf8'))
    return { version: VAULT_VERSION, ...createEmptyVault(), ...vault }
  } catch {
    throw new Error('Could not decrypt the credential vault. The key is wrong or the store was tampered with.')
  }
}

export function loadVault({ rootDir, passphrase }) {
  const { file } = vaultPaths(rootDir)
  if (!fs.existsSync(file)) return createEmptyVault()
  let envelope
  try {
    envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`The credential vault is not valid JSON: ${path.relative(rootDir, file)}`)
  }
  return decryptVault(envelope, passphrase)
}

export function saveVault(vault, { rootDir, passphrase }) {
  const { dir, file } = vaultPaths(rootDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const envelope = encryptVault({ ...vault, updatedAt: new Date().toISOString() }, passphrase)
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

// Records a successful rotation: the outgoing value moves into history (so a
// later rollback can restore it) and the incoming value becomes active. `reason`
// labels the outgoing entry so history distinguishes a normal rotation from a
// rollback or a value observed in the environment before the first rotation.
export function recordCredential(vault, key, value, { provider, rotationId, at = new Date().toISOString(), reason = 'rotated-out' } = {}) {
  const entry = vault.credentials[key] || { provider, active: null, history: [] }
  if (entry.active !== null && entry.active !== undefined) {
    entry.history.unshift({ value: entry.active, at, rotationId, reason })
  }
  entry.provider = provider || entry.provider
  entry.active = value
  entry.updatedAt = at
  vault.credentials[key] = entry
  return entry
}

export function credentialHistory(vault, key) {
  const entry = vault.credentials[key]
  if (!entry) return []
  return [
    ...(entry.active !== null && entry.active !== undefined
      ? [{ value: entry.active, at: entry.updatedAt, reason: 'active' }]
      : []),
    ...(entry.history || []),
  ]
}

// Never print a secret. Redaction exposes only a short digest and the length, so
// logs stay comparable across runs without leaking any character of the value.
export function fingerprint(value) {
  if (value === null || value === undefined || value === '') return '(empty)'
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

export function redact(value) {
  if (value === null || value === undefined || value === '') return '(empty)'
  return `sha256:${fingerprint(value)} (len ${String(value).length})`
}
