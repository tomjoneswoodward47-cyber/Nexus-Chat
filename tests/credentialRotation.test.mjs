import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createEnvFilePersist,
  credentialStatus,
  readEnvValue,
  rollbackCredential,
  rotateCredential,
  rotationDue,
  runRotationPlan,
  upsertEnvValue,
} from '../scripts/lib/credential-rotation.js'
import {
  createEmptyVault,
  credentialHistory,
  decryptVault,
  encryptVault,
  fingerprint,
  loadVault,
  recordCredential,
  redact,
  saveVault,
} from '../scripts/lib/credential-vault.js'
import {
  createCredentialProviders,
  generateHexSecret,
  validateAdminSessionSecret,
  validateOtpHashSecret,
} from '../scripts/rotate-credentials.js'

const PASSPHRASE = 'unit-test-passphrase'
const NOW = new Date('2026-11-22T08:00:00.000Z')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rotation-'))
}

// A descriptor whose only target is an in-memory store, so the engine can be
// exercised without touching a real env file, provider or database.
function fakeDescriptor(overrides = {}) {
  const store = { value: 'old-value' }
  const descriptor = {
    key: 'TEST_SECRET',
    provider: 'unit-test',
    intervalDays: 30,
    generate: async () => 'new-value',
    validate: async () => true,
    persist: async (value) => {
      store.value = value
    },
    ...overrides,
  }
  return { descriptor, store }
}

function contextFor(store, vault = createEmptyVault(), extra = {}) {
  const saved = []
  return {
    context: {
      vault,
      readCurrent: () => store.value,
      saveVault: () => saved.push(vault.updatedAt),
      now: NOW,
      logger: { warn: () => {} },
      ...extra,
    },
    saved,
  }
}

test('vault seals credentials so only the passphrase opens them', () => {
  const vault = createEmptyVault()
  recordCredential(vault, 'ADMIN_SESSION_SECRET', 'first-value', { provider: 'local-hmac' })
  const envelope = encryptVault(vault, PASSPHRASE)

  const reopened = decryptVault(envelope, PASSPHRASE)
  assert.equal(reopened.credentials.ADMIN_SESSION_SECRET.active, 'first-value')

  assert.throws(() => decryptVault(envelope, 'wrong-passphrase'), /Could not decrypt/)
  assert.doesNotMatch(JSON.stringify(envelope), /first-value/)
})

test('tampering with the vault ciphertext fails closed', () => {
  const envelope = encryptVault(createEmptyVault(), PASSPHRASE)
  const bytes = Buffer.from(envelope.ciphertext, 'base64')
  bytes[0] ^= 0xff
  assert.throws(() => decryptVault({ ...envelope, ciphertext: bytes.toString('base64') }, PASSPHRASE), /tampered/)
})

test('a rotation keeps both the outgoing and the incoming value', () => {
  const vault = createEmptyVault()
  recordCredential(vault, 'KEY', 'v1', { provider: 'x' })
  recordCredential(vault, 'KEY', 'v2', { provider: 'x' })
  assert.equal(vault.credentials.KEY.active, 'v2')
  assert.equal(vault.credentials.KEY.history[0].value, 'v1')
  assert.deepEqual(credentialHistory(vault, 'KEY').map((item) => item.value), ['v2', 'v1'])
})

test('the vault round-trips through disk and the key never lands in the store', () => {
  const rootDir = tempDir()
  const vault = createEmptyVault()
  recordCredential(vault, 'OTP_HASH_SECRET', 'secret-value', { provider: 'local-hmac' })
  saveVault(vault, { rootDir, passphrase: PASSPHRASE })

  assert.equal(loadVault({ rootDir, passphrase: PASSPHRASE }).credentials.OTP_HASH_SECRET.active, 'secret-value')
  assert.throws(() => loadVault({ rootDir, passphrase: 'nope' }), /Could not decrypt/)
  assert.doesNotMatch(fs.readFileSync(path.join(rootDir, '.nexus-credentials', 'rotation-vault.json'), 'utf8'), /secret-value/)
})

test('a successful rotation records the new value and preserves the previous one', async () => {
  const { descriptor, store } = fakeDescriptor()
  const { context } = contextFor(store)
  const result = await rotateCredential(descriptor, context)

  assert.equal(result.status, 'rotated')
  assert.equal(store.value, 'new-value')
  const entry = context.vault.credentials.TEST_SECRET
  assert.equal(entry.active, 'new-value')
  assert.equal(entry.history[0].value, 'old-value')
  assert.equal(entry.history[0].reason, 'observed-before-rotation')
  assert.equal(context.vault.rotations[0].status, 'rotated')
  assert.equal(result.previousFingerprint, fingerprint('old-value'))
  assert.equal(result.nextFingerprint, fingerprint('new-value'))
})

test('a credential that fails validation is never written', async () => {
  const { descriptor, store } = fakeDescriptor({
    validate: async () => {
      throw new Error('probe rejected the value')
    },
  })
  const { context } = contextFor(store)
  const result = await rotateCredential(descriptor, context)

  assert.equal(result.status, 'failed')
  assert.match(result.reason, /probe rejected the value/)
  assert.equal(store.value, 'old-value')
  assert.equal(context.vault.credentials.TEST_SECRET, undefined)
})

test('a failed write rolls back to the previous value', async () => {
  const applied = []
  const { descriptor, store } = fakeDescriptor({
    persist: async (value) => {
      applied.push(value)
      if (value === 'new-value') throw new Error('write rejected')
      store.value = value
    },
  })
  const { context } = contextFor(store)
  const result = await rotateCredential(descriptor, context)

  assert.equal(result.status, 'rolled-back')
  assert.match(result.reason, /write rejected; previous credential restored/)
  assert.deepEqual(applied, ['new-value', 'old-value'])
  assert.equal(store.value, 'old-value')
  assert.equal(context.vault.credentials.TEST_SECRET, undefined)
  assert.equal(context.vault.rotations[0].status, 'rolled-back')
})

test('a post-write verification failure rolls back to the previous value', async () => {
  const { descriptor, store } = fakeDescriptor({
    verify: async (value) => {
      if (value === 'new-value') throw new Error('the new value does not work')
    },
  })
  const { context } = contextFor(store)
  const result = await rotateCredential(descriptor, context)

  assert.equal(result.status, 'rolled-back')
  assert.match(result.reason, /does not work; previous credential restored/)
  assert.equal(store.value, 'old-value')
})

test('a manual rollback restores the superseded value and records it', async () => {
  const vault = createEmptyVault()
  recordCredential(vault, 'TEST_SECRET', 'v1', { provider: 'unit-test' })
  recordCredential(vault, 'TEST_SECRET', 'v2', { provider: 'unit-test' })
  const { descriptor, store } = fakeDescriptor()
  store.value = 'v2'

  const result = await rollbackCredential(descriptor, contextFor(store, vault).context)

  assert.equal(result.status, 'rolled-back')
  assert.equal(store.value, 'v1')
  assert.equal(vault.credentials.TEST_SECRET.active, 'v1')
  assert.equal(vault.credentials.TEST_SECRET.history[0].value, 'v2')
  assert.equal(vault.credentials.TEST_SECRET.history[0].reason, 'rolled-back')
})

test('a rollback without a recorded superseded value is skipped', async () => {
  const { descriptor, store } = fakeDescriptor()
  const result = await rollbackCredential(descriptor, contextFor(store).context)
  assert.equal(result.status, 'skipped')
  assert.match(result.reason, /no superseded value/)
})

test('rotationDue respects the interval and treats a missing date as due', () => {
  assert.equal(rotationDue('', 30, NOW), true)
  assert.equal(rotationDue('2026-11-20T08:00:00.000Z', 30, NOW), false)
  assert.equal(rotationDue('2026-09-01T00:00:00.000Z', 30, NOW), true)
  assert.equal(rotationDue('not-a-date', 30, NOW), true)
})

test('the plan skips a credential that is not yet due', async () => {
  const vault = createEmptyVault()
  recordCredential(vault, 'TEST_SECRET', 'v1', { provider: 'unit-test', at: '2026-11-21T00:00:00.000Z' })
  const { descriptor, store } = fakeDescriptor()
  const report = await runRotationPlan([descriptor], contextFor(store, vault, { dueDays: 30 }).context)

  assert.equal(report[0].status, 'skipped')
  assert.equal(store.value, 'old-value')
  assert.equal(credentialStatus(vault, 'TEST_SECRET', { now: NOW }).due, false)
})

test('env files are updated in place without duplicating a key', () => {
  const file = path.join(tempDir(), '.env.local')
  upsertEnvValue(file, 'ALPHA', 'one')
  upsertEnvValue(file, 'BETA', 'two')
  upsertEnvValue(file, 'ALPHA', 'changed')

  const text = fs.readFileSync(file, 'utf8')
  assert.equal((text.match(/^ALPHA=/gm) || []).length, 1)
  assert.equal(readEnvValue(file, 'ALPHA'), 'changed')
  assert.equal(readEnvValue(file, 'BETA'), 'two')
  assert.throws(() => upsertEnvValue(file, 'GAMMA', 'a"b'), /cannot be written/)
  assert.throws(() => upsertEnvValue(file, 'GAMMA', 'a\nb'), /cannot be written/)
})

test('the env-file persist writes the rotated value to disk', async () => {
  const file = path.join(tempDir(), '.env.local')
  await createEnvFilePersist({ filePath: file })('persisted', { key: 'ADMIN_SESSION_SECRET' })
  assert.equal(readEnvValue(file, 'ADMIN_SESSION_SECRET'), 'persisted')
})

test('fingerprints redact a credential without losing comparability', () => {
  const value = 'super-secret-value'
  assert.notEqual(fingerprint(value), value)
  assert.equal(fingerprint(value), fingerprint(value))
  assert.equal(fingerprint(value).length, 12)
  assert.match(redact(value), /^sha256:[0-9a-f]{12} \(len 18\)$/)
})

test('the built-in providers generate secrets that pass their own validators', async () => {
  const providers = createCredentialProviders({ rootDir: tempDir() })
  assert.deepEqual(providers.map((provider) => provider.key).sort(), ['ADMIN_SESSION_SECRET', 'OTP_HASH_SECRET'])

  const admin = providers.find((provider) => provider.key === 'ADMIN_SESSION_SECRET')
  const otp = providers.find((provider) => provider.key === 'OTP_HASH_SECRET')
  const generated = generateHexSecret()

  assert.equal(generated.length, 64)
  assert.equal(generateHexSecret() === generateHexSecret(), false)

  await admin.validate(generated)
  await otp.validate(generated)
  await assert.rejects(() => admin.validate('short-secret'), /at least 32 characters/)
  await assert.rejects(async () => otp.validate('short-secret'), /at least 32 characters/)

  assert.equal(await validateAdminSessionSecret(generated), undefined)
  assert.equal(validateOtpHashSecret(generated), undefined)
})
