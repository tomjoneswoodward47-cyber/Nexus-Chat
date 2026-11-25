import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  MANAGED_TABLES,
  POLICY_DEFINITIONS,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_SCHEMAS,
  maintenanceClientConfig,
  runRlsPolicyMaintenance,
} from '../server/rlsPolicyMaintenance.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userId = '123e4567-e89b-42d3-a456-426614174000'

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
}

// A fake pg client good enough to drive the full refresh. It answers each query
// the maintenance routine issues and keeps the exact call order so the tests can
// prove the whole refresh happens inside one transaction.
function makeClient({ validationOk = true, verifyOk = true } = {}) {
  const calls = []
  const defs = () => POLICY_DEFINITIONS.map((d) => ({ schemaname: d.schema, tablename: d.table, policyname: d.name }))
  return {
    calls,
    async connect() {},
    async end() {},
    async query(sql, values = []) {
      const text = String(sql)
      calls.push({ sql: text, values })
      const lower = text.toLowerCase().trim()
      if (lower === 'begin' || lower === 'commit' || lower === 'rollback') return { rows: [] }
      if (lower.includes('pg_advisory_xact_lock') || lower.startsWith('set local')) return { rows: [] }
      if (lower.includes('insert into public.admin_audit_log')) return { rows: [] }
      if (lower.includes('from pg_namespace')) {
        const names = validationOk ? REQUIRED_SCHEMAS : REQUIRED_SCHEMAS.slice(1)
        return { rows: names.map((nspname) => ({ nspname })) }
      }
      if (lower.includes('from pg_class')) {
        return { rows: MANAGED_TABLES.map((t) => ({ schema_name: t.schema, table_name: t.table, rls_enabled: true })) }
      }
      if (lower.includes('information_schema.columns')) {
        return {
          rows: Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) => {
            const [schema, name] = table.split('.')
            return columns.map((column_name) => ({ table_schema: schema, table_name: name, column_name }))
          }),
        }
      }
      if (lower.includes('from pg_proc')) {
        return { rows: REQUIRED_FUNCTIONS.map((proname) => ({ proname })) }
      }
      if (lower.includes('from pg_policies')) {
        return { rows: verifyOk ? defs() : defs().slice(1) }
      }
      if (lower.startsWith('drop policy if exists')) return { rows: [] }
      if (lower.startsWith('create policy')) return { rows: [] }
      throw new Error(`Unexpected query in test: ${text}`)
    },
  }
}

function indexOfCall(calls, predicate) {
  return calls.findIndex((call) => predicate(call.sql.toLowerCase().trim()))
}

test('maintenance policy definitions stay in step with the canonical schema', () => {
  const schema = fs.readFileSync(path.join(root, 'docs', 'supabase-schema.sql'), 'utf8')
  const managedKeys = new Set(MANAGED_TABLES.map((table) => `${table.schema}.${table.table}`))
  // Only the policies on MANAGED_TABLES are owned by the refresh; the schema
  // also declares policies on tables it never touches (e2ee keys, kyc sessions,
  // workflow sessions), so those are out of scope here. A policy the schema
  // drops and re-creates in a later block keeps a single final definition.
  const fromSchema = new Map()
  const pattern = /create policy\s+"([^"]+)"\s+on\s+([\w.]+)([^;]*);/gi
  let match
  while ((match = pattern.exec(schema))) {
    const [, name, target, rest] = match
    const [schemaName, table] = target.split('.')
    if (!managedKeys.has(`${schemaName}.${table}`)) continue
    const key = `${schemaName}.${table}::${name}`
    if (fromSchema.has(key)) continue
    fromSchema.set(key, {
      name,
      schema: schemaName,
      table,
      normalized: normalizeSql(`create policy "${name}" on ${target}${rest}`),
    })
  }

  const keyOf = (entry) => `${entry.schema}.${entry.table}::${entry.name}`
  const schemaPolicies = [...fromSchema.values()]
  assert.equal(schemaPolicies.length, POLICY_DEFINITIONS.length, 'schema policy count must equal the maintenance definitions')
  assert.deepEqual(
    POLICY_DEFINITIONS.map(keyOf).sort(),
    schemaPolicies.map(keyOf).sort(),
    'every managed schema policy must have a maintenance definition and vice versa',
  )
  for (const definition of POLICY_DEFINITIONS) {
    const source = fromSchema.get(keyOf(definition))
    assert.equal(
      normalizeSql(definition.sql),
      source.normalized,
      `${definition.name} must match the canonical schema definition exactly`,
    )
  }
})

test('the refresh drops and recreates every policy inside one atomic transaction', async () => {
  const client = makeClient()
  const report = await runRlsPolicyMaintenance({ actorId: userId, client })

  assert.equal(report.committed, true)
  assert.equal(report.validation.ok, true)
  assert.equal(report.dropped.length, POLICY_DEFINITIONS.length)
  assert.equal(report.created.length, POLICY_DEFINITIONS.length)
  assert.equal(report.verification.ok, true)
  assert.equal(report.verificationAfterCommit.ok, true)
  assert.equal(report.auditLogged, true)

  const begin = indexOfCall(client.calls, (sql) => sql === 'begin')
  const firstDrop = indexOfCall(client.calls, (sql) => sql.startsWith('drop policy if exists'))
  const firstCreate = indexOfCall(client.calls, (sql) => sql.startsWith('create policy'))
  const commit = indexOfCall(client.calls, (sql) => sql === 'commit')
  const audit = indexOfCall(client.calls, (sql) => sql.includes('insert into public.admin_audit_log'))

  assert.ok(begin !== -1 && commit !== -1, 'the refresh must open and close a transaction')
  assert.ok(begin < firstDrop, 'drops happen inside the transaction')
  assert.ok(firstDrop < firstCreate, 'all drops happen before the first create')
  assert.ok(firstCreate < commit, 'recreates happen before commit')
  assert.ok(commit < audit, 'the audit row is written after the transaction completes')

  // Exactly one transaction, committed once, never rolled back.
  assert.equal(client.calls.filter((call) => call.sql.toLowerCase().trim() === 'begin').length, 1)
  assert.equal(client.calls.filter((call) => call.sql.toLowerCase().trim() === 'commit').length, 1)
  assert.equal(client.calls.filter((call) => call.sql.toLowerCase().trim() === 'rollback').length, 0)

  // No create may run outside the transaction boundary.
  const createdOutside = client.calls.filter((call) => call.sql.toLowerCase().trim().startsWith('create policy'))
  assert.ok(createdOutside.every((call) => client.calls.indexOf(call) > begin && client.calls.indexOf(call) < commit))
})

test('the refresh never assumes RLS-protected user access (it runs as the maintenance role)', () => {
  const source = fs.readFileSync(path.join(root, 'server', 'rlsPolicyMaintenance.js'), 'utf8')
  assert.doesNotMatch(source, /set local role authenticated/i)
  assert.match(source, /pg_advisory_xact_lock/)
})

test('a failed validation rolls the transaction back without changing any policy', async () => {
  const client = makeClient({ validationOk: false })
  await assert.rejects(
    runRlsPolicyMaintenance({ actorId: userId, client }),
    (error) => {
      assert.equal(error.name, 'MaintenanceError')
      assert.equal(error.status, 409)
      assert.equal(error.report.committed, false)
      assert.equal(error.report.validation.ok, false)
      assert.equal(error.report.dropped.length, 0)
      assert.equal(error.report.created.length, 0)
      return true
    },
  )

  assert.equal(indexOfCall(client.calls, (sql) => sql.startsWith('create policy')), -1, 'no policy may be created')
  assert.equal(indexOfCall(client.calls, (sql) => sql.startsWith('drop policy if exists')), -1, 'no policy may be dropped')
  assert.notEqual(indexOfCall(client.calls, (sql) => sql === 'rollback'), -1, 'the transaction must roll back')
  // The failure is still recorded for audit even though the refresh rolled back.
  assert.notEqual(indexOfCall(client.calls, (sql) => sql.includes('insert into public.admin_audit_log')), -1)
})

test('a post-refresh verification mismatch rolls the transaction back', async () => {
  const client = makeClient({ verifyOk: false })
  await assert.rejects(
    runRlsPolicyMaintenance({ actorId: userId, client }),
    (error) => {
      assert.equal(error.status, 500)
      assert.equal(error.report.committed, false)
      assert.equal(error.report.verification.ok, false)
      return true
    },
  )

  assert.equal(indexOfCall(client.calls, (sql) => sql === 'commit'), -1, 'a mismatch must never commit')
  assert.notEqual(indexOfCall(client.calls, (sql) => sql === 'rollback'), -1)
})

test('the maintenance connection URL is validated before any connection is opened', () => {
  assert.throws(() => maintenanceClientConfig(''), { status: 503 })
  assert.throws(() => maintenanceClientConfig('not a url'), { status: 503 })
  assert.throws(() => maintenanceClientConfig('https://example.invalid/database'), { status: 503 })

  const remote = maintenanceClientConfig('postgresql://postgres.abcdef:pw@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=require')
  assert.equal(remote.ssl.rejectUnauthorized, false)
  assert.ok(!remote.connectionString.includes('sslmode'), 'sslmode is moved into the ssl option')

  const local = maintenanceClientConfig('postgresql://postgres:pw@localhost:5432/postgres')
  assert.equal(local.ssl, undefined)
})

test('the admin maintenance endpoint keeps its privileged guards', () => {
  const endpoint = fs.readFileSync(path.join(root, 'api', 'admin', 'maintenance.js'), 'utf8')
  assert.match(endpoint, /req\.method !== 'POST'/)
  assert.match(endpoint, /admin\.auth\.getUser\(/)
  assert.match(endpoint, /admin\.auth\.getClaims\(/)
  assert.match(endpoint, /aal2/)
  assert.match(endpoint, /has_role/)
  assert.match(endpoint, /runRlsPolicyMaintenance/)
  assert.match(endpoint, /SUPABASE_DB_URL/)
})
