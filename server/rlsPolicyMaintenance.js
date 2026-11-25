// Atomic RLS policy refresh behind the admin "Run Script" maintenance action.
//
// The whole refresh runs inside ONE database transaction. Every policy that
// currently exists on the managed tables is dropped and then recreated from the
// canonical definitions below, all before COMMIT. DROP POLICY / CREATE POLICY
// take an ACCESS EXCLUSIVE lock on the table, so an in-flight read blocks for
// the (sub-second) switch instead of observing a missing or half-applied
// policy; once the transaction commits every session sees the complete new set.
// A transaction-scoped advisory lock additionally serialises two admins running
// the refresh at the same time, and lock/statement timeouts make the refresh
// fail fast (and roll back) rather than queue behind a long-running query.

const ADVISORY_LOCK_KEY = 'nexus-chat-rls-policy-refresh'

export class MaintenanceError extends Error {
  constructor(message, { status = 500, report = null } = {}) {
    super(message)
    this.name = 'MaintenanceError'
    this.status = status
    this.report = report
  }
}

// Tables whose Row Level Security policies are owned by this maintenance run.
// storage.objects is included because the app defines its own Storage policies.
export const MANAGED_TABLES = [
  { schema: 'public', table: 'user_roles' },
  { schema: 'public', table: 'identity_verifications' },
  { schema: 'public', table: 'storage_files' },
  { schema: 'storage', table: 'objects' },
  { schema: 'public', table: 'members' },
  { schema: 'public', table: 'contacts' },
  { schema: 'public', table: 'chats' },
  { schema: 'public', table: 'chat_members' },
  { schema: 'public', table: 'messages' },
  { schema: 'public', table: 'auth_email_code_limits' },
  { schema: 'public', table: 'premium_members' },
  { schema: 'public', table: 'admin_audit_log' },
  { schema: 'public', table: 'feed_posts' },
  { schema: 'public', table: 'feed_comments' },
  { schema: 'public', table: 'feed_reactions' },
  { schema: 'public', table: 'feed_comment_reactions' },
  { schema: 'public', table: 'content_reports' },
  { schema: 'public', table: 'blocked_users' },
]

// The canonical, complete set of policies recreated on every refresh. Kept in
// step with docs/supabase-schema.sql by tests/rlsPolicyMaintenance.test.mjs,
// which fails the build if the two drift apart.
export const POLICY_DEFINITIONS = [
  { schema: 'public', table: 'user_roles', name: 'Users see own roles', sql: `create policy "Users see own roles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'))` },
  { schema: 'public', table: 'identity_verifications', name: 'Own or admin read', sql: `create policy "Own or admin read" on public.identity_verifications for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'))` },
  { schema: 'public', table: 'identity_verifications', name: 'Submit own pending', sql: `create policy "Submit own pending" on public.identity_verifications for insert to authenticated with check (user_id = auth.uid() and status = 'pending' and reviewed_by is null)` },
  { schema: 'public', table: 'identity_verifications', name: 'Resubmit own after rejection', sql: `create policy "Resubmit own after rejection" on public.identity_verifications for update to authenticated using (user_id = auth.uid() and status = 'rejected') with check (user_id = auth.uid() and status = 'pending' and reviewed_by is null)` },
  { schema: 'public', table: 'identity_verifications', name: 'Admins review', sql: `create policy "Admins review" on public.identity_verifications for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'))` },
  { schema: 'public', table: 'storage_files', name: 'Own files', sql: `create policy "Own files" on public.storage_files for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())` },
  { schema: 'storage', table: 'objects', name: 'ID docs own upload', sql: `create policy "ID docs own upload" on storage.objects for insert to authenticated with check (bucket_id='identity-docs' and (storage.foldername(name))[1] = auth.uid()::text)` },
  { schema: 'storage', table: 'objects', name: 'ID docs own or admin read', sql: `create policy "ID docs own or admin read" on storage.objects for select to authenticated using (bucket_id='identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')))` },
  { schema: 'storage', table: 'objects', name: 'Chat files own upload', sql: `create policy "Chat files own upload" on storage.objects for insert to authenticated with check (bucket_id='chat-files' and (storage.foldername(name))[1] = auth.uid()::text)` },
  { schema: 'storage', table: 'objects', name: 'Chat files own or admin read', sql: `create policy "Chat files own or admin read" on storage.objects for select to authenticated using (bucket_id='chat-files' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')))` },
  { schema: 'storage', table: 'objects', name: 'Chat files own delete', sql: `create policy "Chat files own delete" on storage.objects for delete to authenticated using (bucket_id='chat-files' and (storage.foldername(name))[1] = auth.uid()::text)` },
  { schema: 'storage', table: 'objects', name: 'Own ID docs upload', sql: `create policy "Own ID docs upload" on storage.objects for insert to authenticated with check (bucket_id='identity-docs' and (storage.foldername(name))[1] = auth.uid()::text)` },
  { schema: 'storage', table: 'objects', name: 'Own ID docs read or admin', sql: `create policy "Own ID docs read or admin" on storage.objects for select to authenticated using (bucket_id='identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')))` },
  { schema: 'storage', table: 'objects', name: 'Contacts read active profile photos', sql: `create policy "Contacts read active profile photos" on storage.objects for select to authenticated using ( bucket_id = 'chat-files' and public.can_read_contact_avatar((storage.foldername(name))[1], name) )` },
  { schema: 'public', table: 'members', name: 'Read own profile', sql: `create policy "Read own profile" on public.members for select to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'admin'))` },
  { schema: 'public', table: 'members', name: 'Edit own profile', sql: `create policy "Edit own profile" on public.members for update to authenticated using (id = auth.uid()) with check (id = auth.uid())` },
  { schema: 'public', table: 'contacts', name: 'Own contacts', sql: `create policy "Own contacts" on public.contacts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)` },
  { schema: 'public', table: 'chats', name: 'View own chats', sql: `create policy "View own chats" on public.chats for select to authenticated using (owner_id = auth.uid() or public.is_chat_member(id, auth.uid()))` },
  { schema: 'public', table: 'chats', name: 'Create owned chats', sql: `create policy "Create owned chats" on public.chats for insert to authenticated with check (owner_id = auth.uid())` },
  { schema: 'public', table: 'chats', name: 'Owners update chats', sql: `create policy "Owners update chats" on public.chats for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())` },
  { schema: 'public', table: 'chats', name: 'Owners delete chats', sql: `create policy "Owners delete chats" on public.chats for delete to authenticated using (owner_id = auth.uid())` },
  { schema: 'public', table: 'chat_members', name: 'View memberships of my chats', sql: `create policy "View memberships of my chats" on public.chat_members for select to authenticated using (public.is_chat_member(chat_id, auth.uid()))` },
  { schema: 'public', table: 'chat_members', name: 'Owners add members', sql: `create policy "Owners add members" on public.chat_members for insert to authenticated with check (exists (select 1 from public.chats c where c.id = chat_id and c.owner_id = auth.uid()))` },
  { schema: 'public', table: 'chat_members', name: 'Leave chats', sql: `create policy "Leave chats" on public.chat_members for delete to authenticated using (profile_id = auth.uid())` },
  { schema: 'public', table: 'messages', name: 'Members read messages', sql: `create policy "Members read messages" on public.messages for select to authenticated using (public.is_chat_member(chat_id, auth.uid()) or public.has_role(auth.uid(),'admin'))` },
  { schema: 'public', table: 'messages', name: 'Members send messages', sql: `create policy "Members send messages" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_chat_member(chat_id, auth.uid()))` },
  { schema: 'public', table: 'messages', name: 'Senders delete messages', sql: `create policy "Senders delete messages" on public.messages for delete to authenticated using (sender_id = auth.uid())` },
  { schema: 'public', table: 'auth_email_code_limits', name: 'No client access', sql: `create policy "No client access" on public.auth_email_code_limits for all to authenticated, anon using (false) with check (false)` },
  { schema: 'public', table: 'premium_members', name: 'Own or admin read premium', sql: `create policy "Own or admin read premium" on public.premium_members for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'admin_audit_log', name: 'Admins read audit log', sql: `create policy "Admins read audit log" on public.admin_audit_log for select to authenticated using (public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_posts', name: 'Read feed posts', sql: `create policy "Read feed posts" on public.feed_posts for select to authenticated using (status = 'active' or author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_posts', name: 'Create own feed posts', sql: `create policy "Create own feed posts" on public.feed_posts for insert to authenticated with check (author_id = auth.uid())` },
  { schema: 'public', table: 'feed_posts', name: 'Manage own feed posts', sql: `create policy "Manage own feed posts" on public.feed_posts for update to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin')) with check (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_posts', name: 'Delete own feed posts', sql: `create policy "Delete own feed posts" on public.feed_posts for delete to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_comments', name: 'Read feed comments', sql: `create policy "Read feed comments" on public.feed_comments for select to authenticated using (status = 'active' or author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_comments', name: 'Create own feed comments', sql: `create policy "Create own feed comments" on public.feed_comments for insert to authenticated with check (author_id = auth.uid())` },
  { schema: 'public', table: 'feed_comments', name: 'Manage own feed comments', sql: `create policy "Manage own feed comments" on public.feed_comments for update to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin')) with check (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_comments', name: 'Delete own feed comments', sql: `create policy "Delete own feed comments" on public.feed_comments for delete to authenticated using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'feed_reactions', name: 'Read post reactions', sql: `create policy "Read post reactions" on public.feed_reactions for select to authenticated using (true)` },
  { schema: 'public', table: 'feed_reactions', name: 'Manage own post reactions', sql: `create policy "Manage own post reactions" on public.feed_reactions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())` },
  { schema: 'public', table: 'feed_comment_reactions', name: 'Read comment reactions', sql: `create policy "Read comment reactions" on public.feed_comment_reactions for select to authenticated using (true)` },
  { schema: 'public', table: 'feed_comment_reactions', name: 'Manage own comment reactions', sql: `create policy "Manage own comment reactions" on public.feed_comment_reactions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())` },
  { schema: 'public', table: 'content_reports', name: 'Create own reports', sql: `create policy "Create own reports" on public.content_reports for insert to authenticated with check (reporter_id = auth.uid())` },
  { schema: 'public', table: 'content_reports', name: 'Read own or all reports', sql: `create policy "Read own or all reports" on public.content_reports for select to authenticated using (reporter_id = auth.uid() or public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'content_reports', name: 'Admins review reports', sql: `create policy "Admins review reports" on public.content_reports for update to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'))` },
  { schema: 'public', table: 'blocked_users', name: 'Read own blocks', sql: `create policy "Read own blocks" on public.blocked_users for select to authenticated using (blocker_id = auth.uid())` },
  { schema: 'public', table: 'blocked_users', name: 'Create own blocks', sql: `create policy "Create own blocks" on public.blocked_users for insert to authenticated with check (blocker_id = auth.uid())` },
  { schema: 'public', table: 'blocked_users', name: 'Delete own blocks', sql: `create policy "Delete own blocks" on public.blocked_users for delete to authenticated using (blocker_id = auth.uid())` },
]

// Structural prerequisites a refresh relies on. Missing any of these means the
// database is not the schema this script was written for, so the refresh stops
// before touching a single policy.
export const REQUIRED_SCHEMAS = ['public', 'storage', 'auth', 'private']
export const REQUIRED_FUNCTIONS = ['has_role', 'is_chat_member']
export const REQUIRED_COLUMNS = {
  'public.user_roles': ['user_id', 'role'],
  'public.identity_verifications': ['user_id', 'status', 'reviewed_by'],
  'public.storage_files': ['user_id'],
  'storage.objects': ['bucket_id', 'name'],
  'public.members': ['id', 'email'],
  'public.contacts': ['user_id', 'nexus_id'],
  'public.chats': ['id', 'owner_id'],
  'public.chat_members': ['chat_id', 'profile_id'],
  'public.messages': ['chat_id', 'sender_id', 'type'],
  'public.auth_email_code_limits': ['bucket_key'],
  'public.premium_members': ['user_id'],
  'public.admin_audit_log': ['actor_id', 'action', 'details'],
  'public.feed_posts': ['id', 'author_id', 'status'],
  'public.feed_comments': ['post_id', 'author_id', 'status'],
  'public.feed_reactions': ['post_id', 'user_id'],
  'public.feed_comment_reactions': ['comment_id', 'user_id'],
  'public.content_reports': ['reporter_id', 'status'],
  'public.blocked_users': ['blocker_id', 'blocked_id'],
}

const MANAGED_KEYS = MANAGED_TABLES.map((table) => `${table.schema}.${table.table}`)

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

// Pre-execution validation (requirement 4): confirm every expected schema,
// table, column and helper function is present, accessible and structurally
// consistent before any policy is modified.
export async function validateSchema(client) {
  const checks = []

  const { rows: schemaRows } = await client.query(
    'select nspname from pg_namespace where nspname = any($1::text[])',
    [REQUIRED_SCHEMAS],
  )
  const presentSchemas = new Set(schemaRows.map((row) => row.nspname))
  const missingSchemas = REQUIRED_SCHEMAS.filter((name) => !presentSchemas.has(name))
  checks.push({
    name: 'Expected schemas present',
    ok: missingSchemas.length === 0,
    detail: missingSchemas.length ? `missing: ${missingSchemas.join(', ')}` : `${REQUIRED_SCHEMAS.length}/${REQUIRED_SCHEMAS.length} present`,
  })

  const { rows: tableRows } = await client.query(
    `select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as rls_enabled
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and (n.nspname || '.' || c.relname) = any($1::text[])`,
    [MANAGED_KEYS],
  )
  const foundTables = new Map(tableRows.map((row) => [`${row.schema_name}.${row.table_name}`, row.rls_enabled === true]))
  const missingTables = MANAGED_KEYS.filter((key) => !foundTables.has(key))
  const rlsDisabled = MANAGED_KEYS.filter((key) => foundTables.get(key) === false)
  checks.push({
    name: 'Expected tables present',
    ok: missingTables.length === 0,
    detail: missingTables.length ? `missing: ${missingTables.join(', ')}` : `${MANAGED_KEYS.length}/${MANAGED_KEYS.length} present`,
  })
  checks.push({
    name: 'Row level security enabled',
    ok: rlsDisabled.length === 0,
    detail: rlsDisabled.length ? `RLS off: ${rlsDisabled.join(', ')}` : `enabled on all ${MANAGED_KEYS.length} tables`,
  })

  const { rows: columnRows } = await client.query(
    `select table_schema, table_name, column_name
       from information_schema.columns
      where (table_schema || '.' || table_name) = any($1::text[])`,
    [Object.keys(REQUIRED_COLUMNS)],
  )
  const presentColumns = new Set(columnRows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`))
  const missingColumns = []
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      if (!presentColumns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`)
    }
  }
  checks.push({
    name: 'Expected columns present',
    ok: missingColumns.length === 0,
    detail: missingColumns.length ? `missing: ${missingColumns.join(', ')}` : 'all referenced columns present',
  })

  const { rows: functionRows } = await client.query(
    `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])`,
    [REQUIRED_FUNCTIONS],
  )
  const presentFunctions = new Set(functionRows.map((row) => row.proname))
  const missingFunctions = REQUIRED_FUNCTIONS.filter((name) => !presentFunctions.has(name))
  checks.push({
    name: 'Helper functions present',
    ok: missingFunctions.length === 0,
    detail: missingFunctions.length ? `missing: ${missingFunctions.join(', ')}` : `${REQUIRED_FUNCTIONS.length}/${REQUIRED_FUNCTIONS.length} present`,
  })

  return {
    ok: checks.every((check) => check.ok),
    checks,
    missingSchemas,
    missingTables,
    missingColumns,
    missingFunctions,
  }
}

// Drop every policy that currently exists on the managed tables, including any
// stray policy not in POLICY_DEFINITIONS, so the table returns to a clean slate
// inside the same transaction.
export async function dropAllPolicies(client) {
  const { rows } = await client.query(
    `select schemaname, tablename, policyname
       from pg_policies
      where (schemaname || '.' || tablename) = any($1::text[])
      order by schemaname, tablename, policyname`,
    [MANAGED_KEYS],
  )
  const dropped = []
  for (const row of rows) {
    await client.query(
      `drop policy if exists ${quoteIdent(row.policyname)} on ${quoteIdent(row.schemaname)}.${quoteIdent(row.tablename)}`,
    )
    dropped.push(`${row.schemaname}.${row.tablename}:${row.policyname}`)
  }
  return dropped
}

export async function recreatePolicies(client) {
  const created = []
  for (const definition of POLICY_DEFINITIONS) {
    await client.query(definition.sql)
    created.push(`${definition.schema}.${definition.table}:${definition.name}`)
  }
  return created
}

// Post-execution verification (requirement 7): confirm the recreated set
// matches the intended definitions exactly, with no missing or stray policies.
export async function verifyPolicies(client) {
  const { rows } = await client.query(
    `select schemaname, tablename, policyname
       from pg_policies
      where (schemaname || '.' || tablename) = any($1::text[])`,
    [MANAGED_KEYS],
  )
  const present = new Set(rows.map((row) => `${row.schemaname}.${row.tablename}:${row.policyname}`))
  const expected = POLICY_DEFINITIONS.map((definition) => `${definition.schema}.${definition.table}:${definition.name}`)
  const expectedSet = new Set(expected)
  const missing = expected.filter((key) => !present.has(key))
  const unexpected = [...present].filter((key) => !expectedSet.has(key))
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    policyCount: rows.length,
    expectedCount: expected.length,
    missing,
    unexpected,
  }
}

export function maintenanceClientConfig(connectionString) {
  if (!connectionString) throw new MaintenanceError('SUPABASE_DB_URL is not configured on the server.', { status: 503 })
  let parsed
  try {
    parsed = new URL(connectionString)
  } catch {
    throw new MaintenanceError('SUPABASE_DB_URL is not a valid connection URL.', { status: 503 })
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new MaintenanceError('SUPABASE_DB_URL must be a PostgreSQL connection URL.', { status: 503 })
  }
  const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase()
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  parsed.searchParams.delete('sslmode')
  const config = { connectionString: parsed.toString(), application_name: 'nexus-rls-policy-refresh' }
  if (!isLocal) config.ssl = { rejectUnauthorized: sslmode === 'verify-full' }
  return config
}

export async function createMaintenanceClient(connectionString) {
  const { Client } = await import('pg')
  return new Client(maintenanceClientConfig(connectionString))
}

async function writeAuditLog(client, { actorId, success, report, error }) {
  const details = {
    table_count: report.tableCount,
    expected_policy_count: report.expectedPolicyCount,
    dropped_count: report.dropped.length,
    created_count: report.created.length,
    committed: report.committed,
    validation_ok: report.validation?.ok ?? null,
    verification_ok: report.verification?.ok ?? null,
    failed_checks: (report.validation?.checks || []).filter((check) => !check.ok).map((check) => check.name),
    error: success ? null : (error?.message || 'unknown'),
    started_at: report.startedAt,
    finished_at: report.finishedAt,
  }
  await client.query(
    `insert into public.admin_audit_log (actor_id, action, target_user_id, details)
     values ($1, $2, null, $3::jsonb)`,
    [actorId, success ? 'rls_policy_refresh.succeeded' : 'rls_policy_refresh.failed', JSON.stringify(details)],
  )
}

// Orchestrates the refresh: one transaction that validates, drops, recreates
// and verifies, then commits atomically or rolls back on any failure.
export async function runRlsPolicyMaintenance({ connectionString, actorId, client: providedClient } = {}) {
  const startedAt = new Date().toISOString()
  const report = {
    startedAt,
    finishedAt: null,
    tableCount: MANAGED_TABLES.length,
    expectedPolicyCount: POLICY_DEFINITIONS.length,
    validation: null,
    dropped: [],
    created: [],
    verification: null,
    verificationAfterCommit: null,
    committed: false,
    auditLogged: false,
  }

  const ownsClient = !providedClient
  const client = providedClient || await createMaintenanceClient(connectionString)
  let failure = null

  try {
    if (ownsClient) await client.connect()
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [ADVISORY_LOCK_KEY])
    await client.query("set local lock_timeout = '5s'")
    await client.query("set local statement_timeout = '30s'")

    report.validation = await validateSchema(client)
    if (!report.validation.ok) {
      throw new MaintenanceError('Pre-execution validation failed; no policies were changed.', { status: 409, report })
    }

    report.dropped = await dropAllPolicies(client)
    report.created = await recreatePolicies(client)

    report.verification = await verifyPolicies(client)
    if (!report.verification.ok) {
      throw new MaintenanceError('Post-execution verification failed inside the transaction; the refresh was rolled back.', { status: 500, report })
    }

    await client.query('commit')
    report.committed = true
  } catch (error) {
    failure = error
    try {
      await client.query('rollback')
    } catch (rollbackError) {
      console.error('RLS policy refresh rollback failed', rollbackError)
    }
    report.committed = false
  }

  // Confirms the committed definition after the transaction has completed.
  if (!failure) {
    try {
      report.verificationAfterCommit = await verifyPolicies(client)
    } catch (verifyError) {
      report.verificationAfterCommit = { ok: false, error: verifyError.message }
    }
  }

  report.finishedAt = new Date().toISOString()

  // The audit row is written after the transaction so a rolled-back refresh is
  // still recorded. It is a separate statement, so it never shares the refresh's
  // rollback boundary.
  try {
    await writeAuditLog(client, { actorId, success: !failure, report, error: failure })
    report.auditLogged = true
  } catch (auditError) {
    report.auditError = auditError.message
    console.error('RLS policy refresh audit log failed', auditError)
  }

  if (ownsClient) {
    try {
      await client.end()
    } catch (endError) {
      console.error('RLS policy refresh connection close failed', endError)
    }
  }

  if (failure) {
    if (failure instanceof MaintenanceError) {
      failure.report = report
      throw failure
    }
    throw new MaintenanceError(failure.message || 'The RLS policy refresh failed.', { status: failure.status || 500, report })
  }

  return report
}
