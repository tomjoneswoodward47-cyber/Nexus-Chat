import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readIfPresent = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? read(rel) : '')

// The browser-visible Supabase contract. `vite.config.js` injects this exact set,
// so `src/env.d.ts`, `.env.example` and the config must all agree on it.
const VITE_SUPABASE_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PROJECT_ID',
]

function parseEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) values[key] = value
  }
  return values
}

function projectRef(url) {
  return String(url || '').match(/^https?:\/\/([a-z0-9]+)\.supabase\.(?:co|in)/i)?.[1] || ''
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

// Runs the prebuild gate with a controlled environment so the assertions do not
// depend on whatever the developer happens to have in their shell.
function runValidator(overrides = {}) {
  const env = { ...process.env }
  delete env.VERCEL
  delete env.VERCEL_ENV
  delete env.NODE_ENV
  Object.assign(env, { VITE_AUTH_PROVIDER: 'supabase' }, overrides)
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-production-env.js')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
}

const CONSISTENT_ENV = {
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_test_public_key_value',
  SUPABASE_ANON_KEY: 'sb_publishable_test_public_key_value',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_public_key_value',
  VITE_SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_server_only_key_value',
}

test('.env.example declares every VITE_SUPABASE_* variable', () => {
  const example = read('.env.example')
  for (const key of VITE_SUPABASE_KEYS) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `.env.example must declare ${key}`)
  }
})

test('.env.example documents placeholders instead of live credentials', () => {
  const example = read('.env.example')
  const liveDbCredentials = /postgres(?:ql)?:\/\/[^\s:@]+:(?!your-)[^\s:@]{6,}@/i
  assert.equal(liveDbCredentials.test(example), false, '.env.example must not embed a real database password')
})

test('.env keeps the canonical Supabase values internally consistent', () => {
  const env = parseEnv(readIfPresent('.env'))
  const url = env.VITE_SUPABASE_URL
  if (url) {
    assert.equal(projectRef(url), env.VITE_SUPABASE_PROJECT_ID, 'VITE_SUPABASE_PROJECT_ID must match the URL project ref')
  }
  if (env.VITE_SUPABASE_ANON_KEY && env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    assert.equal(env.VITE_SUPABASE_ANON_KEY, env.VITE_SUPABASE_PUBLISHABLE_KEY, 'anon and publishable aliases must agree')
  }
  if (env.VITE_SUPABASE_URL && env.SUPABASE_URL) {
    assert.equal(env.VITE_SUPABASE_URL, env.SUPABASE_URL, 'browser and server URLs must point at the same project')
  }
})

test('src/env.d.ts types every VITE_SUPABASE_* variable', () => {
  const types = read('src/env.d.ts')
  for (const key of VITE_SUPABASE_KEYS) {
    assert.match(types, new RegExp(`${key}\\??:\\s*string`), `src/env.d.ts must type ${key} as a string`)
  }
})

test('vite.config.js injects the full VITE_SUPABASE_* set for the browser', () => {
  const config = read('vite.config.js')
  for (const key of VITE_SUPABASE_KEYS) {
    assert.match(config, new RegExp(`"import\\.meta\\.env\\.${key}"`), `vite.config.js must define ${key}`)
  }
  // The project id has to survive a deployment that only sets the URL.
  assert.match(config, /projectId:[^,\n]*projectRefFromUrl\(/, 'the project id must be derived from the URL')
})

test('the Supabase client is built from import.meta.env, never from literals', () => {
  const client = read('src/lib/supabase.js')
  assert.match(client, /import\.meta\.env/, 'the client must read configuration from import.meta.env')
  assert.match(client, /VITE_SUPABASE_URL/, 'the client must read VITE_SUPABASE_URL')
  assert.match(client, /VITE_SUPABASE_ANON_KEY|VITE_SUPABASE_PUBLISHABLE_KEY/, 'the client must read a public key variable')
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    assert.equal(new RegExp(`["']${key}["']`).test(client), false, `${key} must not be read as a literal key`)
  }
})

test('no Supabase configuration values are hardcoded in application code', () => {
  const patterns = [
    { name: 'project URL', re: /https?:\/\/[a-z0-9]+\.supabase\.(?:co|in)/i },
    { name: 'publishable key', re: /sb_publishable_[A-Za-z0-9_-]{8,}/ },
    { name: 'secret key', re: /sb_secret_[A-Za-z0-9_-]{8,}/ },
    { name: 'legacy JWT', re: /eyJhbGciOiJ[A-Za-z0-9_-]{10,}/ },
  ]
  const offenders = []
  for (const dir of ['src', 'api', 'server']) {
    for (const file of walk(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8')
      for (const { name, re } of patterns) {
        if (re.test(text)) offenders.push(`${path.relative(ROOT, file).split(path.sep).join('/')} (${name})`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'Supabase configuration must come from the environment')
})

test('the prebuild validator accepts a consistent Supabase configuration', () => {
  const result = runValidator({ ...CONSISTENT_ENV, VERCEL: '1' })
  assert.equal(result.status, 0, `expected a clean run, got:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /Environment validation passed/)
})

test('the prebuild validator rejects a project id that disagrees with the URL', () => {
  const result = runValidator({ ...CONSISTENT_ENV, VERCEL: '1', VITE_SUPABASE_PROJECT_ID: 'zzzzzzzzzzzzzzzzzzzz' })
  assert.notEqual(result.status, 0, 'a mismatched project ref must fail the build')
  assert.match(result.stderr, /does not match the project ref/)
})

test('the prebuild validator rejects a service-role key used as the public key', () => {
  const serviceRoleJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(
    JSON.stringify({ role: 'service_role' })
  ).toString('base64url')}.signature`
  const result = runValidator({
    ...CONSISTENT_ENV,
    VERCEL: '1',
    VITE_SUPABASE_ANON_KEY: serviceRoleJwt,
    SUPABASE_ANON_KEY: serviceRoleJwt,
    VITE_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt,
  })
  assert.notEqual(result.status, 0, 'a service-role key must never ship as the browser key')
  assert.match(result.stderr, /service_role/)
})
