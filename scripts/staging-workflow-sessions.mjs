#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationFiles = [
  '20261123090121_workflow_session_management.sql',
  '20261123103000_workflow_cli_handoff_dispatch.sql',
]

function readEnvFile(fileName) {
  const filePath = path.join(root, fileName)
  if (!fs.existsSync(filePath)) return {}
  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return values
}

function configuredDatabaseUrl() {
  const values = Object.assign(
    {},
    readEnvFile('.env'),
    readEnvFile('.env.production'),
    readEnvFile('.env.local'),
    readEnvFile('.env.production.local'),
  )
  const value = process.env.SUPABASE_STAGING_DB_URL
    || values.SUPABASE_STAGING_DB_URL
    || process.env.SUPABASE_DB_URL
    || values.SUPABASE_DB_URL
    || ''
  if (!value) throw new Error('No staging database URL is configured.')
  const parsed = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('The configured staging database URL is not PostgreSQL.')
  }
  if (!parsed.hostname.endsWith('.supabase.co') && !parsed.hostname.endsWith('.pooler.supabase.com')) {
    throw new Error('The configured staging database URL does not identify a hosted Supabase database.')
  }
  if (!parsed.searchParams.has('sslmode')) parsed.searchParams.set('sslmode', 'require')
  return parsed.toString()
}

function createPool(databaseUrl) {
  const parsed = new URL(databaseUrl)
  const sslmode = parsed.searchParams.get('sslmode')
  parsed.searchParams.delete('sslmode')
  return new Pool({
    connectionString: parsed.toString(),
    max: 1,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 1000,
    application_name: 'workflow-session-staging-validation',
    ssl: { rejectUnauthorized: sslmode === 'verify-full' },
  })
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function recordApplicationHistory(client, migrationFile, migrationVersion, sql) {
  const { rows: ledger } = await client.query(
    "select to_regclass('public.nexus_schema_migrations') as table_name",
  )
  if (!ledger[0]?.table_name) return

  const checksum = digest(sql)
  const { rows } = await client.query(
    'select checksum from public.nexus_schema_migrations where version = $1',
    [migrationVersion],
  )
  if (rows.length) {
    if (rows[0].checksum !== checksum) {
      throw new Error(`Application migration checksum mismatch for ${migrationFile}.`)
    }
    return
  }
  await client.query(
    `insert into public.nexus_schema_migrations (version, name, checksum)
     values ($1, $2, $3)`,
    [migrationVersion, migrationFile.slice(15, -4), checksum],
  )
}

async function applyMigration(client) {
  const applied = []
  for (const migrationFile of migrationFiles) {
    const migrationVersion = migrationFile.slice(0, 14)
    const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', migrationFile), 'utf8').trim()
    await client.query('begin')
    try {
      await client.query("select pg_advisory_xact_lock(hashtext('nexus-chat-supabase-migrations'))")
      const { rows: historyTable } = await client.query(
        "select to_regclass('supabase_migrations.schema_migrations') as table_name",
      )
      if (!historyTable[0]?.table_name) {
        throw new Error('Supabase migration history is not initialized on the staging database.')
      }

      const { rows: existing } = await client.query(
        'select version from supabase_migrations.schema_migrations where version = $1',
        [migrationVersion],
      )
      if (existing.length) {
        const { rows } = await client.query(`
          select
            to_regclass('public.workflow_sessions') is not null as sessions,
            to_regprocedure('public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)') is not null as manager,
            to_regprocedure('public.issue_workflow_cli_handoff(uuid,uuid,text)') is not null as cli_handoff
        `)
        if (!rows[0]?.sessions || !rows[0]?.manager
          || (migrationFile === migrationFiles[1] && !rows[0]?.cli_handoff)) {
          throw new Error(`Migration history conflicts with installed objects for ${migrationFile}.`)
        }
        await recordApplicationHistory(client, migrationFile, migrationVersion, sql)
        await client.query('commit')
        continue
      }

      if (migrationFile === migrationFiles[0]) {
        const { rows: partial } = await client.query(`
          select
            to_regclass('public.workflow_sessions') as sessions,
            to_regclass('public.workflow_session_roles') as roles,
            to_regprocedure('public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)') as manager
        `)
        if (partial[0]?.sessions || partial[0]?.roles || partial[0]?.manager) {
          throw new Error('Workflow objects exist without a matching migration history record; refusing to reapply.')
        }
      } else {
        const { rows: dispatchState } = await client.query(`
          select
            to_regprocedure('public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)') as manager,
            to_regprocedure('public.manage_workflow_session_legacy(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)') as legacy,
            to_regprocedure('public.issue_workflow_cli_handoff(uuid,uuid,text)') as cli_handoff
        `)
        if (!dispatchState[0]?.manager || dispatchState[0]?.legacy || dispatchState[0]?.cli_handoff) {
          throw new Error('The staging workflow schema is not in the expected pre-fix state.')
        }
      }

      await client.query(sql)
      await client.query(
        `insert into supabase_migrations.schema_migrations (version, name, statements)
         values ($1, $2, $3::text[])`,
        [migrationVersion, migrationFile.slice(15, -4), [sql]],
      )
      await recordApplicationHistory(client, migrationFile, migrationVersion, sql)

      const { rows: checks } = await client.query(`
        select
          to_regclass('public.workflow_sessions') is not null as sessions,
          to_regclass('public.workflow_session_roles') is not null as roles,
          to_regclass('public.workflow_session_approvals') is not null as approvals,
          to_regclass('public.workflow_session_handoffs') is not null as handoffs,
          to_regclass('public.workflow_cli_sessions') is not null as cli_sessions,
          to_regclass('public.workflow_session_audit') is not null as audit,
          to_regprocedure('public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)') is not null as manager,
          to_regprocedure('public.issue_workflow_cli_handoff(uuid,uuid,text)') is not null as cli_handoff,
          coalesce((select relrowsecurity from pg_class where oid = 'public.workflow_sessions'::regclass), false) as rls
      `)
      const postConditions = Object.entries(checks[0])
        .filter(([name]) => migrationFile === migrationFiles[1] || name !== 'cli_handoff')
      assert.ok(postConditions.every(([, passed]) => passed), `Post-conditions failed for ${migrationFile}.`)
      await client.query('commit')
      applied.push(migrationFile)
    } catch (error) {
      try { await client.query('rollback') } catch { /* preserve the migration failure */ }
      throw error
    }
  }
  return applied
}

async function runDatabaseLifecycleTests(client) {
  const createdUsers = []
  await client.query('begin')
  try {
    for (const [label, id] of [['admin', randomUUID()], ['operator', randomUUID()], ['other', randomUUID()]]) {
      const email = `workflow-test-${randomUUID()}@example.invalid`
      await client.query(`
        insert into auth.users (
          id, aud, role, email, encrypted_password, email_confirmed_at,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at
        ) values ($1, 'authenticated', 'authenticated', $2, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
      `, [id, email])
      const authSessionId = randomUUID()
      await client.query(
        'insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), $3)',
        [authSessionId, id, 'aal2'],
      )
      createdUsers.push({ label, id, authSessionId })
    }

    const admin = createdUsers.find((item) => item.label === 'admin')
    const operator = createdUsers.find((item) => item.label === 'operator')
    const other = createdUsers.find((item) => item.label === 'other')
    await client.query("insert into public.user_roles (user_id, role) values ($1, 'admin')", [admin.id])

    async function action(actorId, name, values = {}) {
      const { rows } = await client.query(`
        select public.manage_workflow_session(
          $1::uuid, $2::text, $3::text, $4::uuid, $5::text,
          $6::uuid, $7::text, $8::uuid, $9::uuid, $10::text
        ) as result
      `, [
        actorId,
        name,
        values.kind || null,
        values.sessionId || null,
        values.tokenHash || null,
        values.targetUserId || null,
        values.role || null,
        values.approvalId || null,
        values.authSessionId || null,
        values.cliTokenHash || null,
      ])
      return rows[0].result
    }

    const granted = await action(admin.id, 'grant_role', {
      targetUserId: operator.id,
      role: 'qa',
    })
    assert.equal(granted.ok, true, 'admin grants QA role')

    const selfGrant = await action(operator.id, 'grant_role', {
      targetUserId: operator.id,
      role: 'vault_operator',
    })
    assert.equal(selfGrant.code, 'forbidden', 'operators cannot grant themselves roles')

    let stagingHash = digest(randomUUID())
    let staging = await action(operator.id, 'create', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: operator.authSessionId,
    })
    assert.equal(staging.ok, true, 'QA operator creates an isolated staging session')
    const stagingId = staging.sessionId
    assert.equal((await action(operator.id, 'validate', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: operator.authSessionId,
    })).ok, true, 'owner validates staging session')
    assert.equal((await action(other.id, 'validate', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: other.authSessionId,
    })).code, 'forbidden', 'other user cannot validate the session')
    assert.equal((await action(operator.id, 'validate', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: other.authSessionId,
    })).code, 'forbidden', 'a different Supabase session cannot validate it')

    await client.query(
      "update public.workflow_sessions set created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' where id = $1",
      [stagingId],
    )
    assert.equal((await action(operator.id, 'validate', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: operator.authSessionId,
    })).code, 'expired', 'expired sessions transition and reject access')

    stagingHash = digest(randomUUID())
    staging = await action(operator.id, 'create', {
      kind: 'staging',
      tokenHash: stagingHash,
      authSessionId: operator.authSessionId,
    })
    assert.equal(staging.ok, true, 'a new session can be created after expiry')
    assert.equal((await action(operator.id, 'terminate', {
      kind: 'staging',
      tokenHash: stagingHash,
    })).status, 'terminated', 'owner terminates the current session')

    const role = await action(admin.id, 'grant_role', {
      targetUserId: operator.id,
      role: 'vault_operator',
    })
    assert.equal(role.ok, true, 'admin grants vault-operator role')
    let approval = await action(admin.id, 'approve_vault', { targetUserId: operator.id })
    assert.equal(approval.ok, true, 'a different admin approves vault access')
    let vaultHash = digest(randomUUID())
    let vault = await action(operator.id, 'create', {
      kind: 'vault',
      approvalId: approval.approvalId,
      tokenHash: vaultHash,
      authSessionId: operator.authSessionId,
    })
    assert.equal(vault.ok, true, 'approved vault operator creates a vault session')
    const consumed = await client.query(
      'select consumed_at from public.workflow_session_approvals where id = $1',
      [approval.approvalId],
    )
    assert.ok(consumed.rows[0].consumed_at, 'vault approval is consumed once')

    assert.equal((await action(operator.id, 'terminate', {
      kind: 'vault',
      tokenHash: vaultHash,
    })).status, 'terminated', 'vault owner can terminate the session')
    assert.equal((await action(operator.id, 'create', {
      kind: 'vault',
      approvalId: approval.approvalId,
      tokenHash: digest(randomUUID()),
      authSessionId: operator.authSessionId,
    })).code, 'approval_invalid', 'a consumed approval cannot be reused')

    approval = await action(admin.id, 'approve_vault', { targetUserId: operator.id })
    vaultHash = digest(randomUUID())
    vault = await action(operator.id, 'create', {
      kind: 'vault',
      approvalId: approval.approvalId,
      tokenHash: vaultHash,
      authSessionId: operator.authSessionId,
    })
    assert.equal(vault.ok, true, 'fresh approval creates a new vault session')

    const handoffCodeHash = digest(randomUUID())
    const issued = await action(operator.id, 'issue_cli_handoff', {
      sessionId: vault.sessionId,
      tokenHash: handoffCodeHash,
    })
    assert.equal(issued.ok, true, 'active vault session issues a CLI handoff')
    const cliTokenHash = digest(randomUUID())
    const redeemed = await action(null, 'redeem_cli_handoff', {
      tokenHash: handoffCodeHash,
      cliTokenHash,
    })
    assert.equal(redeemed.ok, true, 'CLI redeems the handoff once')
    assert.equal((await action(null, 'redeem_cli_handoff', {
      tokenHash: handoffCodeHash,
      cliTokenHash: digest(randomUUID()),
    })).code, 'not_found', 'handoff cannot be redeemed twice')
    assert.equal((await action(null, 'validate_cli_session', {
      tokenHash: cliTokenHash,
    })).ok, true, 'CLI session validates while its parent vault session is active')

    await action(admin.id, 'revoke_role', {
      targetUserId: operator.id,
      role: 'vault_operator',
    })
    assert.equal((await action(null, 'validate_cli_session', {
      tokenHash: cliTokenHash,
    })).code, 'revoked', 'role revocation invalidates the CLI session')

    const audit = await action(admin.id, 'read_audit')
    assert.equal(audit.ok, true, 'admin reads persisted audit records')
    const actions = new Set((audit.events || []).map((event) => event.action))
    for (const required of [
      'session.created',
      'session.validated',
      'session.expired',
      'session.terminated',
      'role.granted',
      'role.revoked',
      'vault.approval.created',
      'cli.handoff.issued',
      'cli.handoff.consumed',
      'cli.session.validated',
      'cli.session.denied',
    ]) {
      assert.ok(actions.has(required), `audit trail includes ${required}`)
    }

    const { rows: privileges } = await client.query(`
      select
        has_table_privilege('authenticated', 'public.workflow_sessions', 'select') as authenticated_select,
        has_table_privilege('service_role', 'public.workflow_sessions', 'select') as service_select,
        has_function_privilege('anon', 'public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)', 'execute') as anon_execute,
        has_function_privilege('service_role', 'public.manage_workflow_session(uuid,text,text,uuid,text,uuid,text,uuid,uuid,text)', 'execute') as service_execute
    `)
    assert.deepEqual(privileges[0], {
      authenticated_select: false,
      service_select: false,
      anon_execute: false,
      service_execute: true,
    }, 'workflow tables and RPC remain restricted')

    console.log('PASS  staging/QA role, session isolation, expiry, and owner termination')
    console.log('PASS  separate vault approval, single-use consumption, and revocation')
    console.log('PASS  CLI handoff issuance, one-time redemption, validation, and parent-session isolation')
    console.log('PASS  audit persistence and database privilege boundaries')
  } finally {
    await client.query('rollback')
  }
}

async function main() {
  if (!process.argv.includes('--confirm-staging')) {
    throw new Error('Pass --confirm-staging to run against the configured isolated staging database.')
  }
  const databaseUrl = configuredDatabaseUrl()
  const pool = createPool(databaseUrl)
  try {
    const client = await pool.connect()
    try {
      const applied = await applyMigration(client)
      for (const migration of applied) console.log(`APPLIED  ${migration} (staging)`)
      for (const migration of migrationFiles.filter((file) => !applied.includes(file))) {
        console.log(`ALREADY APPLIED  ${migration} (staging)`)
      }
      await runDatabaseLifecycleTests(client)
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  const databaseUrl = (() => {
    try { return configuredDatabaseUrl() } catch { return '' }
  })()
  const message = String(error?.message || error).replaceAll(databaseUrl, '[STAGING_DB_URL]')
  console.error(`[workflow-session-staging] ${message}`)
  process.exitCode = 1
})
