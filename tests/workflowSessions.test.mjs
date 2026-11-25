import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createWorkflowSessionHandler, hashWorkflowSessionToken } from '../server/workflowSessions.js'

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const AUTH_SESSION_ID = '123e4567-e89b-42d3-a456-426614174001'
const SECOND_USER_ID = '123e4567-e89b-42d3-a456-426614174002'
const APPROVAL_ID = '123e4567-e89b-42d3-a456-426614174003'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174004'
const NOW = Date.parse('2026-11-23T09:00:00.000Z')

function createHarness({
  claims = {
    sub: USER_ID,
    session_id: AUTH_SESSION_ID,
    aal: 'aal2',
    amr: [{ method: 'totp', timestamp: Math.floor(NOW / 1000) }],
  },
  user = { id: USER_ID, is_anonymous: false },
  rpcResult = { ok: true, sessionId: SESSION_ID, kind: 'staging', status: 'active', expiresAt: '2026-11-23T10:00:00.000Z' },
  rpcError = null,
  randomBytes = Buffer.alloc(32, 7),
} = {}) {
  const calls = []
  const errors = []
  const client = {
    auth: {
      async getUser(token) {
        calls.push({ type: 'getUser', token })
        return { data: { user }, error: null }
      },
      async getClaims(token) {
        calls.push({ type: 'getClaims', token })
        return { data: { claims }, error: null }
      },
    },
    async rpc(name, args) {
      calls.push({ type: 'rpc', name, args })
      return { data: rpcResult, error: rpcError }
    },
  }
  const handler = createWorkflowSessionHandler({
    createSupabaseClient: () => client,
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
      NODE_ENV: 'production',
    },
    now: () => NOW,
    makeRandomBytes: () => randomBytes,
    logger: { error: (...args) => errors.push(args) },
  })
  return { handler, calls, errors }
}

function request(method, { headers = {}, query = {}, body } = {}) {
  return {
    method,
    headers: { host: 'app.example.test', authorization: 'Bearer test-access-token', ...headers },
    query,
    body,
  }
}

function response() {
  return {
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
  }
}

async function invoke(handler, req) {
  const res = response()
  await handler(req, res)
  return res
}

test('staging session creation requires a verified, recent AAL2 Supabase identity', async () => {
  const { handler, calls } = createHarness()
  const res = await invoke(handler, request('POST', { body: { action: 'create', kind: 'staging' } }))

  assert.equal(res.statusCode, 201)
  assert.equal(res.body.session.sessionId, SESSION_ID)
  assert.match(res.headers['Set-Cookie'], /^nexus_staging_workflow=/)
  assert.match(res.headers['Set-Cookie'], /HttpOnly/)
  assert.match(res.headers['Set-Cookie'], /SameSite=Strict/)
  assert.match(res.headers['Set-Cookie'], /Secure/)
  assert.doesNotMatch(JSON.stringify(res.body), /BwcHBwcHBwc/)
  const call = calls.find((item) => item.type === 'rpc')
  assert.equal(call.args.p_action, 'create')
  assert.equal(call.args.p_kind, 'staging')
  assert.equal(call.args.p_actor_id, USER_ID)
  assert.equal(call.args.p_auth_session_id, AUTH_SESSION_ID)
  assert.match(call.args.p_token_hash, /^[0-9a-f]{64}$/)
  assert.notEqual(call.args.p_token_hash, 'BwcHBwcHBwc')
})

test('vault creation uses an isolated cookie, a distinct scope, and an approval ID', async () => {
  const { handler, calls } = createHarness()
  const res = await invoke(handler, request('POST', {
    body: { action: 'create', kind: 'vault', approvalId: APPROVAL_ID },
  }))

  assert.equal(res.statusCode, 201)
  assert.match(res.headers['Set-Cookie'], /^nexus_vault_workflow=/)
  const call = calls.find((item) => item.type === 'rpc')
  assert.equal(call.args.p_kind, 'vault')
  assert.equal(call.args.p_approval_id, APPROVAL_ID)
})

test('a vault session without a valid approval is denied and the failed request is audited', async () => {
  const { handler, calls } = createHarness()
  const res = await invoke(handler, request('POST', {
    body: { action: 'create', kind: 'vault', approvalId: 'not-an-approval' },
  }))
  assert.equal(res.statusCode, 403)
  assert.equal(calls.find((item) => item.type === 'rpc').args.p_action, 'approval_denied')
  assert.equal(res.headers['Set-Cookie'], undefined)
})

test('stale or missing second-factor proof is denied and recorded without creating a session', async () => {
  const staleClaims = {
    sub: USER_ID,
    session_id: AUTH_SESSION_ID,
    aal: 'aal2',
    amr: [{ method: 'totp', timestamp: Math.floor(NOW / 1000) - 301 }],
  }
  const { handler, calls } = createHarness({ claims: staleClaims })
  const res = await invoke(handler, request('POST', { body: { action: 'create', kind: 'staging' } }))

  assert.equal(res.statusCode, 403)
  assert.match(res.body.error, /Recent multi-factor/)
  const rpcCalls = calls.filter((item) => item.type === 'rpc')
  assert.deepEqual(rpcCalls.map((item) => item.args.p_action), ['auth_denied'])
})

test('a mismatched token subject and a cross-origin request fail before session operations', async () => {
  const { handler: subjectHandler, calls: subjectCalls } = createHarness({
    claims: { sub: SECOND_USER_ID, session_id: AUTH_SESSION_ID, aal: 'aal2', amr: [{ method: 'totp', timestamp: NOW / 1000 }] },
  })
  const subjectResponse = await invoke(subjectHandler, request('POST', { body: { action: 'create', kind: 'staging' } }))
  assert.equal(subjectResponse.statusCode, 401)
  assert.equal(subjectCalls.some((item) => item.type === 'rpc'), false)

  const { handler: originHandler, calls: originCalls } = createHarness()
  const originResponse = await invoke(originHandler, request('POST', {
    headers: { origin: 'https://attacker.example' },
    body: { action: 'create', kind: 'staging' },
  }))
  assert.equal(originResponse.statusCode, 403)
  assert.equal(originCalls.length, 0)
})

test('unsupported methods and missing authentication fail closed', async () => {
  const { handler, calls } = createHarness()
  const methodResponse = await invoke(handler, request('PUT'))
  assert.equal(methodResponse.statusCode, 405)
  assert.equal(methodResponse.headers.Allow, 'GET, POST, DELETE')
  assert.equal(calls.length, 0)

  const authResponse = await invoke(handler, request('POST', {
    headers: { authorization: '' },
    body: { action: 'create', kind: 'staging' },
  }))
  assert.equal(authResponse.statusCode, 401)
  assert.equal(calls.length, 0)
})

test('validation binds the cookie to its workflow type, owner, and Supabase auth session', async () => {
  const { handler, calls } = createHarness({
    rpcResult: { ok: true, sessionId: SESSION_ID, kind: 'staging', status: 'active', expiresAt: '2026-11-23T10:00:00.000Z' },
  })
  const token = 'cookie-secret'
  const res = await invoke(handler, request('GET', {
    query: { kind: 'staging' },
    headers: { cookie: `nexus_vault_workflow=wrong; nexus_staging_workflow=${token}` },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.session.sessionId, SESSION_ID)
  const call = calls.find((item) => item.type === 'rpc')
  assert.equal(call.args.p_action, 'validate')
  assert.equal(call.args.p_kind, 'staging')
  assert.equal(call.args.p_auth_session_id, AUTH_SESSION_ID)
  assert.equal(call.args.p_token_hash, hashWorkflowSessionToken(token))
  assert.notEqual(call.args.p_token_hash, token)
})

test('expired or revoked validation clears only the matching workflow cookie', async () => {
  const { handler } = createHarness({ rpcResult: { ok: false, code: 'revoked' } })
  const res = await invoke(handler, request('GET', {
    query: { kind: 'vault' },
    headers: { cookie: 'nexus_vault_workflow=expired-secret' },
  }))

  assert.equal(res.statusCode, 410)
  assert.match(res.headers['Set-Cookie'], /^nexus_vault_workflow=/)
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/)
})

test('an AAL1 token cannot validate a workflow session and the cookie is cleared', async () => {
  const { handler, calls } = createHarness({
    claims: {
      sub: USER_ID,
      session_id: AUTH_SESSION_ID,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(NOW / 1000) }],
    },
  })
  const res = await invoke(handler, request('GET', {
    query: { kind: 'staging' },
    headers: { cookie: 'nexus_staging_workflow=staging-token' },
  }))
  assert.equal(res.statusCode, 403)
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/)
  assert.deepEqual(calls.filter((item) => item.type === 'rpc').map((item) => item.args.p_action), ['auth_denied'])
})

test('session owners can request termination without a fresh MFA challenge', async () => {
  const { handler, calls } = createHarness({
    claims: {
      sub: USER_ID,
      session_id: AUTH_SESSION_ID,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(NOW / 1000) }],
    },
    rpcResult: { ok: true, sessionId: SESSION_ID, status: 'terminated' },
  })
  const res = await invoke(handler, request('DELETE', {
    query: { kind: 'staging' },
    headers: { cookie: 'nexus_staging_workflow=staging-token' },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.session.status, 'terminated')
  assert.equal(calls.some((item) => item.type === 'rpc' && item.args.p_action === 'terminate'), true)
})

test('sign-out cleanup is idempotent when this browser has no workflow cookie', async () => {
  const { handler, calls } = createHarness()
  const res = await invoke(handler, request('DELETE', { query: { kind: 'vault' } }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { terminated: false })
  assert.equal(calls.some((item) => item.type === 'rpc'), false)
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/)
})

test('vault approvals and role changes are forwarded only after recent AAL2 verification', async () => {
  const { handler, calls } = createHarness({ rpcResult: { ok: true, approvalId: APPROVAL_ID } })
  const res = await invoke(handler, request('POST', {
    body: { action: 'approve_vault', targetUserId: SECOND_USER_ID },
  }))
  assert.equal(res.statusCode, 200)
  assert.equal(calls.find((item) => item.type === 'rpc').args.p_action, 'approve_vault')

  const { handler: roleHandler, calls: roleCalls } = createHarness({ rpcResult: { ok: true, role: 'vault_operator' } })
  const roleRes = await invoke(roleHandler, request('POST', {
    body: { action: 'grant_role', targetUserId: SECOND_USER_ID, role: 'vault_operator' },
  }))
  assert.equal(roleRes.statusCode, 200)
  assert.equal(roleCalls.find((item) => item.type === 'rpc').args.p_role, 'vault_operator')
})

test('CLI handoff issuance is bound to the active approved vault session and recent MFA', async () => {
  const { handler, calls } = createHarness()
  const res = await invoke(handler, request('POST', {
    headers: { cookie: 'nexus_vault_workflow=active-vault-token' },
    body: { action: 'issue_cli_handoff' },
  }))

  assert.equal(res.statusCode, 201)
  assert.match(res.body.handoff.code, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const rpcCalls = calls.filter((item) => item.type === 'rpc')
  assert.deepEqual(rpcCalls.map((item) => item.args.p_action), ['validate', 'issue_cli_handoff'])
  assert.equal(rpcCalls[0].args.p_kind, 'vault')
  assert.equal(rpcCalls[1].args.p_session_id, SESSION_ID)
  assert.equal(rpcCalls[1].args.p_token_hash, hashWorkflowSessionToken(res.body.handoff.code))
  assert.notEqual(rpcCalls[1].args.p_token_hash, res.body.handoff.code)
})

test('CLI handoff redemption is unauthenticated only with the one-time code and returns an opaque token', async () => {
  const { handler, calls } = createHarness()
  const code = Buffer.alloc(32, 7).toString('base64url')
  const res = await invoke(handler, request('POST', {
    headers: { authorization: '' },
    body: { action: 'redeem_cli_handoff', code },
  }))

  assert.equal(res.statusCode, 200)
  assert.match(res.body.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(res.body.token, Buffer.alloc(32, 7).toString('base64url'))
  const rpc = calls.find((item) => item.type === 'rpc')
  assert.equal(rpc.args.p_action, 'redeem_cli_handoff')
  assert.equal(rpc.args.p_actor_id, null)
  assert.equal(rpc.args.p_token_hash, hashWorkflowSessionToken(code))
  assert.equal(rpc.args.p_cli_token_hash, hashWorkflowSessionToken(res.body.token))
  assert.doesNotMatch(JSON.stringify(rpc.args), new RegExp(code))
})

test('CLI handoff redemption rejects malformed, expired, or cross-origin requests', async () => {
  const { handler, calls } = createHarness()
  const malformed = await invoke(handler, request('POST', {
    headers: { authorization: '' },
    body: { action: 'redeem_cli_handoff', code: 'not-a-code' },
  }))
  assert.equal(malformed.statusCode, 400)
  assert.equal(calls.length, 0)

  const crossOrigin = await invoke(handler, request('POST', {
    headers: { authorization: '', origin: 'https://attacker.example' },
    body: { action: 'redeem_cli_handoff', code: Buffer.alloc(32, 7).toString('base64url') },
  }))
  assert.equal(crossOrigin.statusCode, 403)
  assert.equal(calls.length, 0)
})

test('only an admin can read the audit trail and audit reads are themselves recorded', async () => {
  const events = [{ action: 'session.created', session_id: SESSION_ID }]
  const { handler, calls } = createHarness({ rpcResult: { ok: true, events } })
  const res = await invoke(handler, request('GET', { query: { audit: '1' } }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.events, events)
  assert.equal(calls.find((item) => item.type === 'rpc').args.p_action, 'read_audit')
})

test('session backend failures are surfaced as service errors without exposing credentials', async () => {
  const { handler, errors } = createHarness({ rpcError: { code: '08006', message: 'connection dropped' } })
  const res = await invoke(handler, request('POST', { body: { action: 'create', kind: 'staging' } }))
  assert.equal(res.statusCode, 503)
  assert.match(res.body.error, /temporarily unavailable/)
  assert.doesNotMatch(JSON.stringify(res.body), /server-only-test-key|test-access-token/)
  assert.equal(errors.length, 1)
})

test('database policy keeps workflow state server-only and protects lifecycle transitions', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20261123090121_workflow_session_management.sql', import.meta.url), 'utf8')
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /revoke all on public\.workflow_session_roles[\s\S]*from public, anon, authenticated/i)
  assert.match(migration, /grant execute on function public\.manage_workflow_session[\s\S]*to service_role/i)
  assert.match(migration, /where status = 'active'/i)
  assert.match(migration, /approved_by = p_actor_id/i)
  assert.match(migration, /auth_session_id <> p_auth_session_id/i)
  assert.match(migration, /from auth\.sessions/i)
  assert.match(migration, /workflow_sessions_one_active_per_kind_idx/i)
  assert.match(migration, /consumed_at = v_now/i)
  assert.match(migration, /interval '1 hour'/i)
  assert.match(migration, /interval '15 minutes'/i)
  assert.match(migration, /set status = 'revoked'/i)
  assert.match(migration, /'session\.validated'/i)
  assert.match(migration, /'session\.terminated'/i)
  assert.match(migration, /p_action = 'revoke_user_sessions'/i)
  assert.match(migration, /p_action = 'approval_denied'/i)

  const deletion = fs.readFileSync(new URL('../supabase/functions/delete-account/index.ts', import.meta.url), 'utf8')
  assert.match(deletion, /p_action: 'revoke_user_sessions'/)
  assert.ok(deletion.indexOf("p_action: 'revoke_user_sessions'") < deletion.indexOf('purgeMemberData(admin, user.id)'))
})
