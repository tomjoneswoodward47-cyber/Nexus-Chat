import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWorkflowCliSessionHandler } from '../server/workflowCliSession.js'
import { redeemWorkflowCliHandoff } from '../scripts/rotate-credentials.js'

const TOKEN = Buffer.alloc(32, 9).toString('base64url')

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

test('CLI session validation accepts only an opaque token and hashes it before the RPC', async () => {
  const calls = []
  const client = {
    async rpc(name, args) {
      calls.push({ name, args })
      return {
        data: { ok: true, kind: 'vault', status: 'active', expiresAt: '2026-11-23T09:15:00.000Z' },
        error: null,
      }
    },
  }
  const handler = createWorkflowCliSessionHandler({
    createSupabaseClient: () => client,
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-key' },
  })
  const res = response()
  await handler({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(calls[0].name, 'manage_workflow_session')
  assert.equal(calls[0].args.p_action, 'validate_cli_session')
  assert.equal(calls[0].args.p_actor_id, null)
  assert.equal(calls[0].args.p_token_hash, createHash('sha256').update(TOKEN).digest('hex'))
  assert.notEqual(calls[0].args.p_token_hash, TOKEN)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('CLI session validation fails closed for malformed tokens and inactive sessions', async () => {
  let rpcCalls = 0
  const handler = createWorkflowCliSessionHandler({
    createSupabaseClient: () => ({
      async rpc() {
        rpcCalls += 1
        return { data: { ok: false, code: 'revoked' }, error: null }
      },
    }),
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-key' },
  })

  const malformed = response()
  await handler({ method: 'POST', headers: { authorization: 'Bearer short' } }, malformed)
  assert.equal(malformed.statusCode, 401)
  assert.equal(rpcCalls, 0)

  const revoked = response()
  await handler({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, revoked)
  assert.equal(revoked.statusCode, 410)
  assert.equal(JSON.stringify(revoked.body).includes('server-only-key'), false)
  assert.equal(JSON.stringify(revoked.body).includes(TOKEN), false)
  assert.equal(rpcCalls, 1)
})

test('CLI redeems the code in a request body and holds the returned token only in memory', async () => {
  const code = Buffer.alloc(32, 3).toString('base64url')
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/api/workflow-sessions')) {
      return {
        ok: true,
        async json() { return { token: TOKEN } },
      }
    }
    return {
      ok: true,
      async json() { return { session: { kind: 'vault', status: 'active', expiresAt: 'soon' } } },
    }
  }

  const result = await redeemWorkflowCliHandoff({
    baseUrl: 'https://staging.example.test',
    code,
    fetchImpl,
  })
  assert.equal(result.expiresAt, 'soon')
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[0].url).search, '')
  assert.equal(JSON.parse(calls[0].options.body).code, code)
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('CLI redemption errors do not fall back to unauthenticated vault operations', async () => {
  await assert.rejects(redeemWorkflowCliHandoff({
    baseUrl: 'https://staging.example.test',
    code: Buffer.alloc(32, 3).toString('base64url'),
    fetchImpl: async () => ({
      ok: false,
      async json() { return { error: 'The handoff is expired.' } },
    }),
  }), /handoff is expired/)
})
