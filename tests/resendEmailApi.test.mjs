import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'

process.env.SUPABASE_URL = 'https://auth.example.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'
process.env.RESEND_API_KEY = 'test-resend-api-key'
process.env.RESEND_FROM = 'Nexus <admin@example.test>'
process.env.OTP_HASH_SECRET = 'test-otp-hash-secret'
process.env.NODE_ENV = 'production'

const originalFetch = globalThis.fetch
const originalNow = Date.now
const sentEmails = []
const authRequests = []
const codeRows = []
const verifyRequests = []
const testUserId = 'f9c2e2dd-f11f-43d4-ad07-c94269e5141d'
let rateLimitAllowed = true
let verifyOutcome = 'ok'

// Emails that already exist in the auth store, so createUser fails for them.
const ALREADY_REGISTERED_EMAILS = new Set(['taken-user@example.test', 'unverified-user@example.test'])

// email-code resolves accounts through the members mirror
// (.from('members').select('id, email_verified').eq('email', …).maybeSingle()),
// not by paging auth.users, so the mock has to mirror that table: which
// addresses resolve at all, and whether each one is verified.
const MEMBER_EMAILS = new Map([
  ['taken-user@example.test', true],
  ['unverified-user@example.test', false],
  ['verify-user@example.test', true],
  ['resend-user@example.test', true],
  ['recover-user@example.test', true],
  ['rate-limited@example.test', true],
  ['new-user@example.test', true],
  ['code-user@example.test', true],
])

function otpHashFor({ email, purpose, code }) {
  return createHmac('sha256', process.env.OTP_HASH_SECRET)
    .update(`${purpose}:${String(email).trim().toLowerCase()}:${code}`)
    .digest('hex')
}

globalThis.fetch = async (request, options = {}) => {
  const url = new URL(request instanceof Request ? request.url : request)

  if (url.hostname === 'api.resend.com') {
    sentEmails.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ id: `resend-${sentEmails.length}` }), { status: 201 })
  }

  if (url.pathname.endsWith('/auth/v1/admin/users') && options.method === 'POST') {
    const body = JSON.parse(options.body)
    authRequests.push({ action: 'createUser', body })
    if (ALREADY_REGISTERED_EMAILS.has(body.email)) {
      return new Response(JSON.stringify({
        code: 422,
        msg: 'A user with this email address has already been registered',
        message: 'A user with this email address has already been registered',
      }), { status: 422 })
    }
    return new Response(JSON.stringify({ id: testUserId, email: body.email, user_metadata: body.user_metadata }), { status: 200 })
  }

  if (url.pathname.endsWith('/rest/v1/members') && options.method === 'GET') {
    const email = (url.searchParams.get('email') || '').replace(/^eq\./, '')
    const verified = MEMBER_EMAILS.get(email)
    return new Response(
      JSON.stringify(verified === undefined ? [] : [{ id: testUserId, email_verified: verified }]),
      { status: 200 },
    )
  }

  if (url.pathname.endsWith('/rest/v1/rpc/consume_auth_email_code_limit')) {
    return new Response(String(rateLimitAllowed), { status: 200 })
  }

  if (url.pathname.endsWith('/rest/v1/auth_email_codes') && options.method === 'PATCH') {
    codeRows.push({ action: 'invalidate', query: url.search })
    return new Response(null, { status: 204 })
  }

  if (url.pathname.endsWith('/rest/v1/auth_email_codes') && options.method === 'POST') {
    codeRows.push({ action: 'insert', body: JSON.parse(options.body) })
    return new Response(null, { status: 201 })
  }

  if (url.pathname.endsWith('/rest/v1/rpc/verify_auth_email_code')) {
    verifyRequests.push(JSON.parse(options.body))
    return new Response(JSON.stringify(verifyOutcome), { status: 200 })
  }

  if (url.pathname.endsWith('/auth/v1/admin/generate_link')) {
    const body = JSON.parse(options.body)
    authRequests.push({ action: 'generateLink', body })
    // supabase-js's _generateLinkResponse transform expects the flat raw
    // GoTrue payload and nests it under data.properties for the caller.
    return new Response(JSON.stringify({
      action_link: `https://auth.example.test/verify?token=hash-${body.type}`,
      email_otp: '12345678',
      hashed_token: `hash-${body.type}`,
      verification_type: body.type,
      user: { id: testUserId, email: body.email },
    }), { status: 200 })
  }

  if (url.pathname.endsWith('/auth/v1/verify')) {
    const body = JSON.parse(options.body)
    authRequests.push({ action: 'exchangeSession', body })
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: testUserId, email: 'verify-user@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' },
    }), { status: 200 })
  }

  throw new Error(`Unexpected mocked request: ${options.method} ${url.pathname}`)
}

const { default: handler } = await import('../api/auth/email-code.js')

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}

function request(body, headers = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://app.example.test', host: 'app.example.test', ...headers },
    body,
  }
}

function lastInsert() {
  return [...codeRows].reverse().find((row) => row.action === 'insert')
}

function assertResendOtp(email, { purposeSubject } = {}) {
  const sent = sentEmails.at(-1)
  assert.equal(sent.to[0], email)
  assert.match(sent.from, /@nexus-chat-world\.com>?$/)
  assert.equal(sent.from.includes('example.test'), false)
  // The code is a fixed four digits, never the Supabase 6-10 digit OTP.
  assert.match(sent.text, /code is \d{4}\b/)
  assert.match(sent.html, />\d{4}</)
  assert.equal(/\d{5,}/.test(sent.text), false)
  assert.equal(/https?:\/\//i.test(sent.text), false)
  assert.equal(/https?:\/\//i.test(sent.html), false)
  assert.equal(/href=/i.test(sent.html), false)
  if (purposeSubject) assert.match(sent.subject, purposeSubject)
  assert.equal(JSON.stringify(sent).includes('action_link'), false)
  return sent.text.match(/code is (\d{4})\b/)[1]
}

// The plaintext code must never reach the database; only a keyed hash is stored.
function assertStoredHash({ email, purpose, code }) {
  const inserted = lastInsert()
  assert.ok(inserted, 'expected the code to be persisted')
  assert.equal(inserted.body.email, email)
  assert.equal(inserted.body.purpose, purpose)
  assert.notEqual(inserted.body.code_hash, code)
  assert.match(inserted.body.code_hash, /^[a-f0-9]{64}$/)
  assert.equal(inserted.body.code_hash, otpHashFor({ email, purpose, code }))
}

before(() => {
  Date.now = () => 1_000_000
})

after(() => {
  globalThis.fetch = originalFetch
  Date.now = originalNow
})

test('signup creates an unconfirmed user and emails a 4-digit code from nexus-chat-world.com', async () => {
  const res = responseRecorder()
  await handler(request({
    action: 'signup',
    purpose: 'signup',
    email: 'new-user@example.test',
    password: 'Secure-test-password-123',
    firstName: 'New',
    lastName: 'User',
    memberId: '1012345678',
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal('otpType' in res.body, false)
  assert.equal(res.headers['Set-Cookie'], undefined)
  const createUser = authRequests.find((item) => item.action === 'createUser')
  assert.equal(createUser.body.email_confirm, false)
  assert.equal(createUser.body.user_metadata.member_id, '1012345678')
  const code = assertResendOtp('new-user@example.test', { purposeSubject: /verification code/ })
  assertStoredHash({ email: 'new-user@example.test', purpose: 'signup', code })
  assert.equal(JSON.stringify(res.body).includes(code), false)
})

test('signup refuses to re-register a confirmed account', async () => {
  const resendCount = sentEmails.length
  const res = responseRecorder()
  await handler(request({
    action: 'signup',
    purpose: 'signup',
    email: 'taken-user@example.test',
    password: 'Secure-test-password-123',
    firstName: 'Taken',
    lastName: 'Account',
    memberId: '1011111111',
  }), res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'email_already_registered')
  assert.match(res.body.error, /already exists/)
  assert.equal(sentEmails.length, resendCount)
})

test('signup reuses an unconfirmed account and emails a fresh code', async () => {
  const res = responseRecorder()
  await handler(request({
    action: 'signup',
    purpose: 'signup',
    email: 'unverified-user@example.test',
    password: 'Secure-test-password-123',
    firstName: 'Unverified',
    lastName: 'Account',
    memberId: '1022222222',
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal('otpType' in res.body, false)
  const code = assertResendOtp('unverified-user@example.test', { purposeSubject: /verification code/ })
  assertStoredHash({ email: 'unverified-user@example.test', purpose: 'signup', code })
})

test('resend invalidates the previous code and emails a new one', async () => {
  const signupResponse = responseRecorder()
  await handler(request({
    action: 'signup',
    purpose: 'signup',
    email: 'resend-user@example.test',
    password: 'Secure-test-password-123',
    firstName: 'Resend',
    lastName: 'User',
    memberId: '1098765432',
  }), signupResponse)

  const originalCode = sentEmails.at(-1).text.match(/code is (\d{4})\b/)[1]
  const res = responseRecorder()
  await handler(request({ action: 'resend', purpose: 'signup', email: 'resend-user@example.test' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  const nextCode = assertResendOtp('resend-user@example.test')
  assert.notEqual(nextCode, originalCode)
  assert.equal(codeRows.filter((row) => row.action === 'invalidate').length >= 2, true)
  assert.equal(authRequests.some((item) => item.action === 'generateLink'), false)
  assertStoredHash({ email: 'resend-user@example.test', purpose: 'signup', code: nextCode })
})

test('password recovery sends a recovery code through Resend', async () => {
  const res = responseRecorder()
  await handler(request({
    action: 'recovery',
    purpose: 'recovery',
    email: 'recover-user@example.test',
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal('otpType' in res.body, false)
  const code = assertResendOtp('recover-user@example.test', { purposeSubject: /password reset code/ })
  assertStoredHash({ email: 'recover-user@example.test', purpose: 'recovery', code })
})

test('email sign-in sends a sign-in code from the verified domain', async () => {
  const res = responseRecorder()
  await handler(request({
    action: 'email',
    purpose: 'email',
    email: 'code-user@example.test',
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assertResendOtp('code-user@example.test', { purposeSubject: /sign-in code/ })
})

test('verify accepts the correct 4-digit code and returns a Supabase session', async () => {
  verifyOutcome = 'ok'
  const generateLinkCount = authRequests.filter((item) => item.action === 'generateLink').length
  const res = responseRecorder()
  await handler(request({
    action: 'verify',
    purpose: 'signup',
    email: 'verify-user@example.test',
    code: '1234',
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.access_token, 'access-token')
  assert.equal(res.body.refresh_token, 'refresh-token')
  assert.equal(JSON.stringify(res.body).includes('1234'), false)

  const submitted = verifyRequests.at(-1)
  assert.equal(submitted.p_email, 'verify-user@example.test')
  assert.equal(submitted.p_purpose, 'signup')
  assert.equal(submitted.p_code_hash, otpHashFor({ email: 'verify-user@example.test', purpose: 'signup', code: '1234' }))

  const links = authRequests.filter((item) => item.action === 'generateLink')
  assert.equal(links.length, generateLinkCount + 1)
  assert.equal(links.at(-1).body.type, 'signup')
  const exchange = authRequests.find((item) => item.action === 'exchangeSession')
  assert.equal(exchange.body.type, 'signup')
  assert.equal(exchange.body.token_hash, 'hash-signup')
})

test('verify rejects a wrong code without minting a Supabase session', async () => {
  verifyOutcome = 'invalid'
  const generateLinkCount = authRequests.filter((item) => item.action === 'generateLink').length
  const exchangeCount = authRequests.filter((item) => item.action === 'exchangeSession').length
  const res = responseRecorder()
  await handler(request({
    action: 'verify',
    purpose: 'signup',
    email: 'verify-user@example.test',
    code: '0000',
  }), res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'invalid_code')
  assert.match(res.body.error, /incorrect/)
  assert.equal(authRequests.filter((item) => item.action === 'generateLink').length, generateLinkCount)
  assert.equal(authRequests.filter((item) => item.action === 'exchangeSession').length, exchangeCount)
  verifyOutcome = 'ok'
})

test('verify rejects a malformed code before touching the database', async () => {
  const verifyCount = verifyRequests.length
  const res = responseRecorder()
  await handler(request({
    action: 'verify',
    purpose: 'signup',
    email: 'verify-user@example.test',
    code: '12',
  }), res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /4-digit/)
  assert.equal(verifyRequests.length, verifyCount)
})

test('rejects requests from a different origin before calling providers', async () => {
  const authCount = authRequests.length
  const resendCount = sentEmails.length
  const res = responseRecorder()
  await handler(request({ action: 'recovery', purpose: 'recovery', email: 'private@example.test' }, {
    origin: 'https://attacker.example',
  }), res)

  assert.equal(res.statusCode, 403)
  assert.equal(authRequests.length, authCount)
  assert.equal(sentEmails.length, resendCount)
})

test('denies code sends when the persistent Supabase rate limit is exhausted', async () => {
  rateLimitAllowed = false
  const authCount = authRequests.length
  const resendCount = sentEmails.length
  const res = responseRecorder()
  await handler(request({
    action: 'recovery',
    purpose: 'recovery',
    email: 'rate-limited@example.test',
  }), res)
  rateLimitAllowed = true

  assert.equal(res.statusCode, 429)
  assert.equal(authRequests.length, authCount)
  assert.equal(sentEmails.length, resendCount)
})
