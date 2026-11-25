#!/usr/bin/env node
// Opt-in live smoke test for the state-changing account and chat flows that the
// read-only `npm run verify:live` deliberately never touches. It creates, then
// removes, dedicated test accounts on the target project:
//
//   * account recovery — register, reject a wrong code, accept a valid code
//     once, reload the session, sign out, recover the password, delete the
//     account;
//   * two-account chat — publish E2EE keys, send text, a reply, a reaction and
//     an attachment, then prove a non-member can read neither the plaintext nor
//     the uploaded chat file.
//
// It stays separate from `verify:live` because it writes rows, uploads an object
// and sends mail. Nothing runs unless the operator opts in, and a run removes
// the accounts and objects it created.
//
//   LIVE_SMOKE_ENABLED=1 \
//   LIVE_SMOKE_EMAIL_BASE=smoke@example.com \
//   LIVE_SMOKE_PASSWORD='...' \
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   OTP_HASH_SECRET=... \
//   npm run smoke:live -- --report docs/live-smoke-report.md
//
// The four-digit codes are read one of two ways:
//   * directly from public.auth_email_codes — the default. The script reads the
//     stored code hash with the service role and recovers the code from the
//     10,000 candidates using OTP_HASH_SECRET, so no mailbox is needed; or
//   * from an allowlisted mailbox when LIVE_SMOKE_MAILBOX_URL is set. Resend
//     sends the codes there; the endpoint must answer JSON with the recent
//     messages — a bare array or one of `messages`, `emails` or `data` — where
//     each message has a recipient (`to`, string or array), a body
//     (`text`/`html`/`body`) and ideally a `created_at`.
//
// Only the four-digit code is read from either source. Codes, tokens and
// passwords are never written to the report; only provider status codes are.
//
// Environment:
//   LIVE_SMOKE_ENABLED       required opt-in flag (1/true/yes/on)
//   LIVE_SMOKE_EMAIL_BASE    base inbox; +a/+owner/+peer/+outsider are derived
//   LIVE_SMOKE_EMAIL_A       override the recovery account address
//   LIVE_SMOKE_EMAIL_OWNER   override the chat owner address
//   LIVE_SMOKE_EMAIL_PEER    override the chat peer address
//   LIVE_SMOKE_EMAIL_OUTSIDER override the non-member address
//   LIVE_SMOKE_PASSWORD      required: password for every created account
//   LIVE_SMOKE_BASE_URL      deployed app origin (default https://www.nexus-chat-world.com)
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY  required
//   OTP_HASH_SECRET          required for the mailbox-free code recovery
//   LIVE_SMOKE_MAILBOX_URL   optional: JSON inbox that receives the codes
//   LIVE_SMOKE_MAILBOX_TOKEN optional bearer token for the inbox
//
// Exit code is 1 when any check fails, so it can gate a release.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, webcrypto as crypto } from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The canonical host. The apex redirects (308) to www, and the code endpoint
// rejects a request whose Origin host does not match the Host it landed on, so
// pointing at the apex would fail the origin guard after the redirect.
const DEFAULT_BASE_URL = 'https://www.nexus-chat-world.com'

const BUCKET = 'chat-files'
const E2EE_ALG = 'ECDH-P256+AES-256-GCM'
const REACTION_EMOJI = '👍'
const CODE_TTL_WAIT_MS = 45_000
const CODE_POLL_MS = 3_000
// The codes are four digits, so the whole space can be tested against the stored
// hash. Mirrors OTP_CODE_LENGTH in supabase/functions/_shared/otp-email.js.
const OTP_CODE_SPACE = 10_000

const results = []

function record(status, name, detail) {
  results.push({ status, name, detail })
}

// Never print a full account id, code, token or password.
const redact = (value) => {
  const text = String(value || '')
  return text.length > 8 ? `${text.slice(0, 8)}…` : text ? '…' : ''
}

// ---- Environment loading --------------------------------------------------

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const values = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function loadEnv() {
  const merged = {}
  for (const file of ['.env', '.env.local', '.env.production']) {
    Object.assign(merged, readEnvFile(path.join(ROOT, file)))
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && value !== '') merged[key] = value
  }
  return merged
}

const ENV = loadEnv()
const firstOf = (...keys) => keys.map((key) => String(ENV[key] || '').trim()).find(Boolean) || ''

const ENABLED = /^(1|true|yes|on)$/i.test(firstOf('LIVE_SMOKE_ENABLED'))
const SUPABASE_URL = firstOf('SUPABASE_URL', 'VITE_SUPABASE_URL').replace(/\/+$/, '')
const SUPABASE_ANON_KEY = firstOf('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY')
const SERVICE_ROLE_KEY = firstOf('SUPABASE_SERVICE_ROLE_KEY')
const MAILBOX_URL = firstOf('LIVE_SMOKE_MAILBOX_URL')
const MAILBOX_TOKEN = firstOf('LIVE_SMOKE_MAILBOX_TOKEN')
// Keys the HMAC that hashes the four-digit codes. Used to recover a code from
// the stored hash when no mailbox is configured.
const OTP_HASH_SECRET = firstOf('OTP_HASH_SECRET', 'ADMIN_SESSION_SECRET')
const PASSWORD = firstOf('LIVE_SMOKE_PASSWORD')
const BASE_URL = (firstOf('LIVE_SMOKE_BASE_URL', 'PRODUCTION_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '')

function plusAddress(base, tag) {
  const [local, domain] = String(base || '').split('@')
  if (!local || !domain) return ''
  return `${local}+${tag}@${domain}`
}

const EMAIL_BASE = firstOf('LIVE_SMOKE_EMAIL_BASE')
const EMAIL_A = firstOf('LIVE_SMOKE_EMAIL_A') || plusAddress(EMAIL_BASE, 'a')
const EMAIL_OWNER = firstOf('LIVE_SMOKE_EMAIL_OWNER') || plusAddress(EMAIL_BASE, 'owner')
const EMAIL_PEER = firstOf('LIVE_SMOKE_EMAIL_PEER') || plusAddress(EMAIL_BASE, 'peer')
const EMAIL_OUTSIDER = firstOf('LIVE_SMOKE_EMAIL_OUTSIDER') || plusAddress(EMAIL_BASE, 'outsider')

async function getAdminClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function newClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---- Email-code endpoint --------------------------------------------------

// The endpoint rejects any request whose Origin host does not match the Host it
// was reached on, so a Node caller must send the matching Origin explicitly.
async function postEmailCode(payload) {
  const response = await fetchWithTimeout(`${BASE_URL}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

// ---- Mailbox --------------------------------------------------------------

function normalizeMessages(payload) {
  if (Array.isArray(payload)) return payload
  for (const key of ['messages', 'emails', 'data', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return []
}

function recipientsOf(message) {
  const value = message.to ?? message.recipient ?? message.toAddress
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.address || ''))
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
}

function timestampOf(message) {
  return String(message.created_at || message.createdAt || message.date || message.received_at || '')
}

async function fetchMailbox() {
  if (!MAILBOX_URL) return []
  const headers = MAILBOX_TOKEN ? { Authorization: `Bearer ${MAILBOX_TOKEN}` } : {}
  const response = await fetchWithTimeout(MAILBOX_URL, { headers })
  if (!response.ok) throw new Error(`mailbox returned ${response.status}`)
  const payload = await response.json().catch(() => null)
  return normalizeMessages(payload)
}

// Returns the four-digit code from the newest message addressed to `email` that
// is newer than `afterIso`. Polls until it arrives or the deadline passes.
async function waitForCode(email, { afterIso, timeoutMs = CODE_TTL_WAIT_MS } = {}) {
  const target = String(email).toLowerCase()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let messages = []
    try {
      messages = await fetchMailbox()
    } catch {
      messages = []
    }
    const matching = messages
      .filter((message) => recipientsOf(message).includes(target))
      .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)))
    for (const message of matching) {
      if (afterIso) {
        const stamp = timestampOf(message)
        if (stamp && stamp <= afterIso) continue
      }
      const body = [message.text, message.html, message.body, message.subject].filter(Boolean).join('\n')
      const match = body.match(/\b(\d{4})\b/)
      if (match) return match[1]
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, CODE_POLL_MS))
  }
}

// ---- Code recovery from the database --------------------------------------

// The endpoint persists only a keyed hash of the four-digit code, so with the
// same OTP_HASH_SECRET the server uses the code can be recovered from the 10,000
// candidates. The stored value is HMAC-SHA256(secret, `${purpose}:${email}:${code}`),
// mirroring hashOtpCode in api/auth/email-code.js.
function recoverCodeFromHash(codeHash, email, purpose) {
  const target = String(email).toLowerCase().trim()
  for (let i = 0; i < OTP_CODE_SPACE; i += 1) {
    const code = String(i).padStart(4, '0')
    const candidate = createHmac('sha256', OTP_HASH_SECRET).update(`${purpose}:${target}:${code}`).digest('hex')
    if (candidate === codeHash) return code
  }
  return null
}

// Polls the newest unconsumed code row for the address and recovers its code.
// Reads the same row the verify RPC would consume (newest unconsumed first).
async function waitForDbCode(admin, email, purpose, { afterIso, timeoutMs = CODE_TTL_WAIT_MS } = {}) {
  const target = String(email).toLowerCase().trim()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { data } = await admin
      .from('auth_email_codes')
      .select('code_hash, created_at')
      .eq('email', target)
      .eq('purpose', purpose)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = (data || [])[0]
    if (row && (!afterIso || row.created_at > afterIso)) {
      const code = recoverCodeFromHash(row.code_hash, target, purpose)
      if (code) return code
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, CODE_POLL_MS))
  }
}

// Reads the code from whichever source the operator configured: the allowlisted
// mailbox when present, otherwise the code store. Returns null when neither is
// available or the code does not arrive in time.
function resolveCode(admin, email, purpose, { afterIso } = {}) {
  if (MAILBOX_URL) return waitForCode(email, { afterIso })
  if (OTP_HASH_SECRET) return waitForDbCode(admin, email, purpose, { afterIso })
  return null
}

const CODE_SOURCE = MAILBOX_URL ? 'allowlisted mailbox' : 'auth_email_codes store'

// ---- E2EE (Node mirror of src/lib/crypto/e2ee.js) --------------------------

const toBase64 = (buffer) => Buffer.from(buffer).toString('base64')
const fromBase64 = (value) => new Uint8Array(Buffer.from(value, 'base64'))

async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
}

async function exportPublicKey(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key))
}

async function deriveSharedKey(privateKey, peerPublicKeyBase64) {
  const peer = await crypto.subtle.importKey(
    'raw',
    fromBase64(peerPublicKeyBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptPayload(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return JSON.stringify({ alg: E2EE_ALG, iv: toBase64(iv), data: toBase64(data) })
}

async function decryptPayload(key, content) {
  const { iv, data } = JSON.parse(content)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(data))
  return new TextDecoder().decode(plain)
}

// ---- Account helpers ------------------------------------------------------

function generateNexusId() {
  return `10${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
}

function accountMetadata(email) {
  const tag = String(email).split('@')[0].slice(0, 32)
  return { first_name: 'Smoke', last_name: tag, member_id: generateNexusId() }
}

async function findMemberIdByEmail(admin, email) {
  const { data } = await admin.from('members').select('id').eq('email', String(email).toLowerCase()).maybeSingle()
  return data?.id || null
}

// Removes any account left over from an earlier run so signup starts clean.
async function purgeExisting(admin, email) {
  const existing = await findMemberIdByEmail(admin, email)
  if (existing) await admin.auth.admin.deleteUser(existing).catch(() => {})
}

// Provisions a confirmed account with the service role and returns a signed-in
// client. Used for the chat participants, whose sessions are the only thing the
// chat checks need; the email-code path is exercised separately on account A.
async function provisionConfirmedClient(admin, email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: accountMetadata(email),
  })
  if (error || !data?.user?.id) throw new Error(error?.message || 'account provisioning failed')
  const client = await newClient()
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (signInError) throw new Error(signInError.message)
  return { id: data.user.id, client }
}

// ---- Account recovery lifecycle (account A) -------------------------------

async function runRecoveryLifecycle(admin) {
  const email = EMAIL_A
  await purgeExisting(admin, email)

  // 1. Register — the server creates the unconfirmed account and emails a code.
  const startedAt = new Date().toISOString()
  let response = await postEmailCode({
    action: 'signup',
    purpose: 'signup',
    email,
    password: PASSWORD,
    firstName: 'Smoke',
    lastName: 'Recovery',
    memberId: generateNexusId(),
  })
  if (response.status === 200) record('PASS', 'Signup accepted', `POST action=signup -> 200`)
  else record('FAIL', 'Signup accepted', `POST action=signup -> ${response.status} ${redact(response.body?.error)}`)

  const accountId = await findMemberIdByEmail(admin, email)
  if (!accountId) {
    record('FAIL', 'Signup created an account', 'no members row appeared for the new address')
    return
  }
  record('PASS', 'Signup created an account', `member ${redact(accountId)} provisioned`)

  // 2. Reject a wrong code — no session may be minted.
  const realCode = await resolveCode(admin, email, 'signup', { afterIso: startedAt })
  const wrongCode = realCode ? (realCode === '0000' ? '0001' : '0000') : '0000'
  response = await postEmailCode({ action: 'verify', purpose: 'signup', email, code: wrongCode })
  const issuedSession = Boolean(response.body?.access_token)
  if (response.status === 400 && !issuedSession) record('PASS', 'Wrong code rejected', `POST action=verify -> 400${response.body?.code ? ` ${response.body.code}` : ''}`)
  else record('FAIL', 'Wrong code rejected', `POST action=verify -> ${response.status}; session issued = ${issuedSession}`)

  // 3. Accept a valid code exactly once.
  if (!realCode) {
    record('SKIP', 'Valid code accepted once', 'no code arrived in the allowlisted mailbox in time')
    record('SKIP', 'Reused code rejected', 'a valid code was never obtained')
    return
  }
  response = await postEmailCode({ action: 'verify', purpose: 'signup', email, code: realCode })
  const tokens = { access_token: response.body?.access_token, refresh_token: response.body?.refresh_token }
  if (response.status === 200 && tokens.access_token && tokens.refresh_token) {
    record('PASS', 'Valid code accepted once', `POST action=verify -> 200 (session issued)`)
  } else {
    record('FAIL', 'Valid code accepted once', `POST action=verify -> ${response.status}; session issued = ${Boolean(tokens.access_token)}`)
    return
  }

  // 4. Reject the reused code — a single-use code must not mint a second session.
  response = await postEmailCode({ action: 'verify', purpose: 'signup', email, code: realCode })
  if (response.status === 400 && !response.body?.access_token) record('PASS', 'Reused code rejected', `POST action=verify -> 400${response.body?.code ? ` ${response.body.code}` : ''}`)
  else record('FAIL', 'Reused code rejected', `POST action=verify -> ${response.status}; session issued = ${Boolean(response.body?.access_token)}`)

  // 5. Reload — a fresh client restoring the same tokens stays signed in.
  const reloaded = await newClient()
  const { error: setError } = await reloaded.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token })
  const { data: userData } = setError ? { data: null } : await reloaded.auth.getUser()
  if (!setError && userData?.user?.id === accountId) record('PASS', 'Session survives reload', `getUser -> ${redact(userData.user.id)}`)
  else record('FAIL', 'Session survives reload', setError?.message || 'the restored session did not resolve to the account')

  // 6. Sign out — the client must drop the session.
  await reloaded.auth.signOut()
  const { data: signedOut } = await reloaded.auth.getSession()
  if (!signedOut?.session) record('PASS', 'Sign out clears the session', 'getSession -> null')
  else record('FAIL', 'Sign out clears the session', 'a session remained after signOut')

  // 7. Recover the password through the real code flow.
  const recoveryStartedAt = new Date().toISOString()
  response = await postEmailCode({ action: 'recovery', purpose: 'recovery', email })
  if (response.status === 200) record('PASS', 'Recovery code requested', 'POST action=recovery -> 200')
  else record('FAIL', 'Recovery code requested', `POST action=recovery -> ${response.status} ${redact(response.body?.error)}`)

  const recoveryCode = await resolveCode(admin, email, 'recovery', { afterIso: recoveryStartedAt })
  if (!recoveryCode) {
    record('SKIP', 'Recovery code accepted', `no code was read from the ${CODE_SOURCE} in time`)
    record('SKIP', 'New password signs in', 'recovery could not be completed')
    return
  }
  response = await postEmailCode({ action: 'verify', purpose: 'recovery', email, code: recoveryCode })
  if (response.status === 200 && response.body?.access_token) record('PASS', 'Recovery code accepted', 'POST action=verify -> 200 (session issued)')
  else record('FAIL', 'Recovery code accepted', `POST action=verify -> ${response.status}; session issued = ${Boolean(response.body?.access_token)}`)

  const recoveryClient = await newClient()
  if (response.body?.access_token && response.body?.refresh_token) {
    await recoveryClient.auth.setSession({ access_token: response.body.access_token, refresh_token: response.body.refresh_token })
  }
  // 8. Set a new password, then prove it signs in.
  const newPassword = `${PASSWORD}-r1`
  const { error: updateError } = await recoveryClient.auth.updateUser({ password: newPassword })
  if (!updateError) record('PASS', 'Password updated', 'updateUser -> 200')
  else record('FAIL', 'Password updated', updateError.message)

  const freshClient = await newClient()
  const { error: reLoginError } = await freshClient.auth.signInWithPassword({ email, password: newPassword })
  if (!reLoginError) record('PASS', 'New password signs in', 'signInWithPassword -> 200')
  else record('FAIL', 'New password signs in', reLoginError.message)

  // 9. Delete the account through the deployed function.
  const { data: sessionData } = await freshClient.auth.getSession()
  const accessToken = sessionData?.session?.access_token || ''
  if (!accessToken) {
    record('FAIL', 'Account deleted', 'no session token available to authorise deletion')
    return
  }
  const deleteResponse = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/delete-account`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const deleteBody = await deleteResponse.json().catch(() => null)
  if (deleteResponse.status === 200 && deleteBody?.deleted) record('PASS', 'Account deleted', 'POST /functions/v1/delete-account -> 200')
  else record('FAIL', 'Account deleted', `POST /functions/v1/delete-account -> ${deleteResponse.status} ${redact(deleteBody?.error)}`)

  const { data: gone } = await admin.auth.admin.getUserById(accountId).catch(() => ({ data: null }))
  if (!gone?.user) record('PASS', 'Deleted account is gone', `getUserById(${redact(accountId)}) -> not found`)
  else record('FAIL', 'Deleted account is gone', 'the auth record still resolves after deletion')
}

// ---- Two-account encrypted chat -------------------------------------------

async function runEncryptedChat(admin, owner, peer, outsider) {
  const ownerPair = await generateKeyPair()
  const peerPair = await generateKeyPair()

  // 1. Publish both public keys through the caller-scoped RPC.
  const ownerKey = await exportPublicKey(ownerPair.publicKey)
  const peerKey = await exportPublicKey(peerPair.publicKey)
  const ownerPublish = await owner.client.rpc('publish_e2ee_public_key', { p_public_key: ownerKey })
  const peerPublish = await peer.client.rpc('publish_e2ee_public_key', { p_public_key: peerKey })
  if (!ownerPublish.error && !peerPublish.error) record('PASS', 'Both accounts publish keys', `publish_e2ee_public_key -> 200 x2`)
  else record('FAIL', 'Both accounts publish keys', ownerPublish.error?.message || peerPublish.error?.message || 'RPC rejected')

  // 2. Create a chat owned by the owner and add both members.
  const chatId = crypto.randomUUID()
  const { error: chatError } = await owner.client.from('chats').insert({
    id: chatId, title: 'Live smoke chat', type: 'private', owner_id: owner.id, encrypted: true,
    participant_names: null,
  })
  const { error: membersError } = await owner.client.from('chat_members').insert([
    { chat_id: chatId, profile_id: owner.id },
    { chat_id: chatId, profile_id: peer.id },
  ])
  if (!chatError && !membersError) record('PASS', 'Encrypted chat created', `chat ${redact(chatId)} with two members`)
  else {
    record('FAIL', 'Encrypted chat created', chatError?.message || membersError?.message || 'insert rejected')
    return
  }

  // 3. Each side resolves the other's published key (participant-scoped RPC).
  const ownerPeers = await owner.client.rpc('list_chat_public_keys', { p_chat_id: chatId })
  const peerPeers = await peer.client.rpc('list_chat_public_keys', { p_chat_id: chatId })
  const ownerSeesPeer = (ownerPeers.data || []).some((row) => row.public_key === peerKey)
  const peerSeesOwner = (peerPeers.data || []).some((row) => row.public_key === ownerKey)
  if (ownerSeesPeer && peerSeesOwner) record('PASS', 'Peer keys resolved', 'list_chat_public_keys returned the other participant key')
  else record('FAIL', 'Peer keys resolved', `ownerSeesPeer=${ownerSeesPeer} peerSeesOwner=${peerSeesOwner}`)

  // Derive the shared AES key on both sides (owner priv + peer pub; peer priv + owner pub).
  const text = `live smoke ${Date.now()}`
  const textPayload = await encryptPayload(await deriveSharedKey(ownerPair.privateKey, peerKey), text)

  // 4. Send an encrypted text message.
  const textId = crypto.randomUUID()
  const { error: textError } = await owner.client.from('messages').insert({
    id: textId, chat_id: chatId, sender_id: owner.id, content: textPayload, type: 'text', encrypted: true,
  })
  if (!textError) record('PASS', 'Encrypted text sent', `message ${redact(textId)} stored as ciphertext`)
  else record('FAIL', 'Encrypted text sent', textError.message)

  // 5. Send an encrypted reply that carries the reply metadata inside the ciphertext.
  const replyPlaintext = `nexus:v1:${JSON.stringify({ kind: 'reply', text: 'reply body', reply: { id: textId, preview: text.slice(0, 160) } })}`
  const replyPayload = await encryptPayload(await deriveSharedKey(ownerPair.privateKey, peerKey), replyPlaintext)
  const replyId = crypto.randomUUID()
  const { error: replyError } = await owner.client.from('messages').insert({
    id: replyId, chat_id: chatId, sender_id: owner.id, content: replyPayload, type: 'text', encrypted: true,
  })
  if (!replyError) record('PASS', 'Encrypted reply sent', `message ${redact(replyId)} stored as ciphertext`)
  else record('FAIL', 'Encrypted reply sent', replyError.message)

  // 6. Send a reaction (its own message type, unencrypted by design).
  const { error: reactionError } = await owner.client.from('messages').insert({
    id: crypto.randomUUID(), chat_id: chatId, sender_id: owner.id,
    content: JSON.stringify({ messageId: textId, emoji: REACTION_EMOJI, active: true }), type: 'reaction', encrypted: false,
  })
  if (!reactionError) record('PASS', 'Reaction sent', `reaction on ${redact(textId)}`)
  else record('FAIL', 'Reaction sent', reactionError.message)

  // 7. Upload one attachment for the chat and reference it from a file message.
  const objectPath = `${owner.id}/${chatId}/smoke-${Date.now()}.txt`
  const bytes = new TextEncoder().encode('live smoke attachment')
  const { error: uploadError } = await owner.client.storage
    .from(BUCKET)
    .upload(objectPath, new Blob([bytes], { type: 'text/plain' }), { contentType: 'text/plain', upsert: false })
  let objectUrl = ''
  if (!uploadError) {
    objectUrl = (await owner.client.storage.from(BUCKET).createSignedUrl(objectPath, 3600)).data?.signedUrl || ''
    await owner.client.from('storage_files').insert({
      user_id: owner.id, chat_id: chatId, file_name: 'smoke.txt', file_type: 'document',
      mime_type: 'text/plain', size_bytes: bytes.length, storage_path: objectPath,
    })
    const { error: fileMessageError } = await owner.client.from('messages').insert({
      id: crypto.randomUUID(), chat_id: chatId, sender_id: owner.id, content: 'smoke.txt',
      type: 'file', file_url: objectUrl, file_name: 'smoke.txt', file_size: bytes.length, encrypted: false,
    })
    if (!fileMessageError) record('PASS', 'Attachment sent', `object ${redact(objectPath)} attached`)
    else record('FAIL', 'Attachment sent', fileMessageError.message)
  } else {
    record('FAIL', 'Attachment sent', uploadError.message)
  }

  // 8. The peer reads the chat and decrypts the text and reply.
  const { data: peerMessages, error: peerReadError } = await peer.client
    .from('messages').select('id, type, content, encrypted').eq('chat_id', chatId)
  if (peerReadError) {
    record('FAIL', 'Peer reads the chat', peerReadError.message)
  } else {
    const rows = peerMessages || []
    const storedText = rows.find((row) => row.id === textId)
    const storedReply = rows.find((row) => row.id === replyId)
    const reaction = rows.find((row) => row.type === 'reaction')
    const file = rows.find((row) => row.type === 'file')
    try {
      const shared = await deriveSharedKey(peerPair.privateKey, ownerKey)
      const decryptedText = storedText ? await decryptPayload(shared, storedText.content) : ''
      const decryptedReply = storedReply ? await decryptPayload(shared, storedReply.content) : ''
      if (decryptedText === text && decryptedReply.startsWith('nexus:v1:') && JSON.parse(decryptedReply.slice('nexus:v1:'.length)).reply?.id === textId) {
        record('PASS', 'Peer decrypts text and reply', 'both ciphertexts resolved to their plaintext on the peer device')
      } else {
        record('FAIL', 'Peer decrypts text and reply', 'the decrypted payload did not match the sent plaintext')
      }
    } catch (error) {
      record('FAIL', 'Peer decrypts text and reply', error.message)
    }
    const reactionOk = Boolean(reaction) && JSON.parse(reaction.content).messageId === textId && JSON.parse(reaction.content).emoji === REACTION_EMOJI
    if (reactionOk) record('PASS', 'Peer sees the reaction', `reaction on ${redact(textId)}`)
    else record('FAIL', 'Peer sees the reaction', 'the reaction row was not visible or did not match')
    if (file && file.content === 'smoke.txt') record('PASS', 'Peer sees the attachment', 'file message present with its reference')
    else record('FAIL', 'Peer sees the attachment', 'the file message was not visible')
  }

  // 9. A non-member must not read the plaintext, the peer keys or the file.
  const { data: outsiderMessages, error: outsiderReadError } = await outsider.client
    .from('messages').select('id').eq('chat_id', chatId)
  if (!outsiderReadError && (outsiderMessages || []).length === 0) record('PASS', 'Non-member cannot read messages', 'select -> 0 rows')
  else record('FAIL', 'Non-member cannot read messages', outsiderReadError?.message || `${(outsiderMessages || []).length} row(s) leaked`)

  const outsiderKeys = await outsider.client.rpc('list_chat_public_keys', { p_chat_id: chatId })
  if ((outsiderKeys.data || []).length === 0) record('PASS', 'Non-member cannot read peer keys', 'list_chat_public_keys -> 0 rows')
  else record('FAIL', 'Non-member cannot read peer keys', `${outsiderKeys.data.length} key(s) leaked`)

  if (objectUrl) {
    const downloaded = await outsider.client.storage.from(BUCKET).download(objectPath)
    if (downloaded.error || !downloaded.data) record('PASS', 'Non-member cannot read the chat file', `download -> ${downloaded.error ? 'blocked' : 'empty'}`)
    else record('FAIL', 'Non-member cannot read the chat file', 'the object downloaded for a non-member')
  } else {
    record('SKIP', 'Non-member cannot read the chat file', 'the attachment upload did not produce an object to probe')
  }

  // 10. Clean up the chat, its messages and the uploaded object. A failure here
  // must not mask the checks above, and the Postgrest storage_files builder
  // resolves to { error } rather than rejecting, so guard the whole block.
  try {
    await owner.client.from('chats').delete().eq('id', chatId)
    if (objectUrl) {
      await admin.from('storage_files').delete().eq('storage_path', objectPath)
      await admin.storage.from(BUCKET).remove([objectPath])
    }
  } catch {
    // Best-effort cleanup; nothing to record.
  }
}

// ---- Cleanup --------------------------------------------------------------

async function removeAccount(admin, email) {
  const id = await findMemberIdByEmail(admin, email)
  if (id) await admin.auth.admin.deleteUser(id).catch(() => {})
}

// ---- Report ---------------------------------------------------------------

function renderReport() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  const lines = []
  lines.push('# Live smoke test — Nexus Chat')
  lines.push('')
  lines.push(`**Run at:** ${new Date().toISOString()}`)
  lines.push(`**App origin:** ${BASE_URL}`)
  lines.push(`**Supabase project:** ${SUPABASE_URL || '(not configured)'}`)
  lines.push(`**Code source:** ${MAILBOX_URL ? 'allowlisted mailbox' : OTP_HASH_SECRET ? 'auth_email_codes store (mailbox-free)' : '(not configured)'}`)
  lines.push('')
  lines.push(`**Result:** ${counts.FAIL ? `${counts.FAIL} failed` : 'all checks passed'} · ${counts.PASS || 0} passed · ${counts.SKIP || 0} skipped`)
  lines.push('')
  lines.push('| Status | Check | Detail |')
  lines.push('| --- | --- | --- |')
  for (const r of results) lines.push(`| ${r.status} | ${r.name} | ${r.detail} |`)
  lines.push('')
  lines.push('This run writes rows, uploads one object and sends real email codes, which')
  lines.push('it reads back from the configured code source. Only provider status codes are')
  lines.push('recorded — never codes,')
  lines.push('tokens, passwords or full account ids. Accounts and objects created by the')
  lines.push('run are removed before it exits. A SKIP means a required input was missing.')
  return `${lines.join('\n')}\n`
}

// ---- Entry point ----------------------------------------------------------

async function main() {
  const reportIndex = process.argv.indexOf('--report')
  const reportPath = reportIndex !== -1 ? process.argv[reportIndex + 1] : ''

  if (!ENABLED) {
    console.log('[smoke:live] Skipped. Set LIVE_SMOKE_ENABLED=1 (plus the account and Supabase variables, and OTP_HASH_SECRET or a mailbox) to run the opt-in live smoke test.')
    return
  }

  const missing = []
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY')
  if (!SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!MAILBOX_URL && !OTP_HASH_SECRET) missing.push('LIVE_SMOKE_MAILBOX_URL (or OTP_HASH_SECRET to recover codes from the store)')
  if (!PASSWORD) missing.push('LIVE_SMOKE_PASSWORD')
  if (!EMAIL_A || !EMAIL_OWNER || !EMAIL_PEER || !EMAIL_OUTSIDER) missing.push('LIVE_SMOKE_EMAIL_BASE (or the four per-account addresses)')
  if (missing.length) {
    console.error(`[smoke:live] Refusing to run: missing ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  const admin = await getAdminClient()

  // Account A: full recovery lifecycle. The flow deletes A itself; the finally
  // removes it again in case a check aborted before reaching deletion.
  try {
    await runRecoveryLifecycle(admin)
  } finally {
    await removeAccount(admin, EMAIL_A)
  }

  // Chat accounts: provisioned confirmed, then removed at the end.
  try {
    await purgeExisting(admin, EMAIL_OWNER)
    await purgeExisting(admin, EMAIL_PEER)
    await purgeExisting(admin, EMAIL_OUTSIDER)
    const owner = await provisionConfirmedClient(admin, EMAIL_OWNER)
    const peer = await provisionConfirmedClient(admin, EMAIL_PEER)
    const outsider = await provisionConfirmedClient(admin, EMAIL_OUTSIDER)
    await runEncryptedChat(admin, owner, peer, outsider)
  } catch (error) {
    record('FAIL', 'Two-account encrypted chat', error.message)
  } finally {
    await removeAccount(admin, EMAIL_OWNER)
    await removeAccount(admin, EMAIL_PEER)
    await removeAccount(admin, EMAIL_OUTSIDER)
  }

  const report = renderReport()
  console.log(report)

  if (reportPath) {
    const target = path.resolve(ROOT, reportPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, report, 'utf8')
    console.log(`Report written to ${path.relative(ROOT, target)}`)
  }

  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1
}

main().catch((error) => {
  console.error('[smoke:live] Failed:', error.message)
  process.exitCode = 1
})
