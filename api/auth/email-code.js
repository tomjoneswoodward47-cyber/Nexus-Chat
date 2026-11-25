import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  otpEmail,
  resolveResendFrom,
  OTP_CODE_LENGTH,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  otpCodePattern,
  otpHashPayload,
  resolveOtpHashSecret,
} from '../../supabase/functions/_shared/otp-email.js'

const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_PER_WINDOW = 3
// A code allows OTP_MAX_ATTEMPTS guesses, but requesting a fresh code resets
// that counter, so a per-address budget across the code lifetime stops an
// attacker from trading new codes for new guesses.
const VERIFY_ATTEMPT_WINDOW_SECONDS = 600
const VERIFY_ATTEMPT_LIMIT = 20
const PURPOSES = new Set(['signup', 'recovery', 'email'])
const SCHEMA_HINT = 'Email verification is temporarily unavailable. Apply the latest Supabase schema migration.'

function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body)
  return {}
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function secureOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return null
  try {
    const parsed = new URL(origin)
    if (parsed.host !== host) return null
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return null
    return parsed.origin
  } catch {
    return null
  }
}

function createAdminClient(url, serviceRoleKey) {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function checkSendLimit(admin, purpose, email) {
  const bucketKey = createHash('sha256').update(`${purpose}:${email}`).digest('hex')
  const { data, error } = await admin.rpc('consume_auth_email_code_limit', {
    p_bucket_key: bucketKey,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_limit: RATE_LIMIT_PER_WINDOW,
  })
  if (error) throw new Error('Email code rate limiting is unavailable. Apply the latest Supabase schema migration.')
  return data === true
}

// A separate bucket tracks guesses across every code the address requests, so a
// fresh code does not hand the attacker a fresh allowance.
async function checkVerifyAttemptLimit(admin, purpose, email) {
  const bucketKey = createHash('sha256').update(`verify:${purpose}:${email}`).digest('hex')
  const { data, error } = await admin.rpc('consume_auth_email_code_limit', {
    p_bucket_key: bucketKey,
    p_window_seconds: VERIFY_ATTEMPT_WINDOW_SECONDS,
    p_limit: VERIFY_ATTEMPT_LIMIT,
  })
  if (error) throw new Error('Email code rate limiting is unavailable. Apply the latest Supabase schema migration.')
  return data === true
}

function generateOtpCode() {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0')
}

function hashOtpCode({ code, email, purpose, secret }) {
  return createHmac('sha256', secret).update(otpHashPayload({ code, email, purpose })).digest('hex')
}

// Accounts are resolved through the members mirror (unique, indexed email) instead of
// paging auth.users, which only ever inspected the first 1000 accounts.
async function findAuthUserByEmail(admin, email) {
  try {
    const { data, error } = await admin
      .from('members')
      .select('id, email_verified')
      .eq('email', email)
      .maybeSingle()
    if (error || !data) return null
    return { id: data.id, emailVerified: Boolean(data.email_verified) }
  } catch {
    return null
  }
}

async function sendWithResend({ email, code, purpose, apiKey, from, idempotencyKey }) {
  const template = otpEmail({ code, purpose })
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: template.subject,
      text: template.text,
      html: template.html,
      // Gmail and Outlook thread messages that share headers and can bury a
      // fresh code under the previous one. A unique reference per send keeps
      // each verification email its own message so the newest code surfaces.
      headers: { 'X-Entity-Ref-ID': idempotencyKey.slice(0, 256) },
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('Resend delivery failed', response.status, detail)
    throw new Error('Email delivery failed. Check the Resend API key and verified sender domain nexus-chat-world.com.')
  }
}

// Stores a fresh single-use code and emails it. Only the keyed hash is
// persisted, so the plaintext code exists nowhere but the recipient's inbox.
async function issueEmailCode(admin, { email, purpose, userId, apiKey, from, secret }) {
  const code = generateOtpCode()
  const codeHash = hashOtpCode({ code, email, purpose, secret })
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString()

  const { error: invalidateError } = await admin
    .from('auth_email_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('email', email)
    .eq('purpose', purpose)
    .is('consumed_at', null)
  if (invalidateError) throw new Error(SCHEMA_HINT)

  const { error: insertError } = await admin
    .from('auth_email_codes')
    .insert({ email, purpose, code_hash: codeHash, expires_at: expiresAt })
  if (insertError) throw new Error(SCHEMA_HINT)

  await sendWithResend({
    email,
    code,
    purpose,
    apiKey,
    from,
    idempotencyKey: `auth-otp/${purpose}/${userId}/${randomUUID()}`,
  })
}

// Which Supabase link type confirms the address for each purpose. Signup needs
// a confirmation token, so it tries the signup link first and falls back to a
// magic link for accounts that were created earlier.
function linkAttempts({ email, purpose }) {
  if (purpose === 'recovery') return [{ type: 'recovery', email }]
  if (purpose === 'email') return [{ type: 'magiclink', email }]
  return [{ type: 'signup', email }, { type: 'magiclink', email }]
}

// The 4-digit code is the gate. Once it checks out, the server mints a Supabase
// session from an admin-generated token and returns only the finished session,
// so the native OTP never reaches the browser.
async function createSupabaseSession(admin, { email, purpose, supabaseUrl, anonKey }) {
  for (const params of linkAttempts({ email, purpose })) {
    const { data, error } = await admin.auth.admin.generateLink(params)
    const tokenHash = data?.properties?.hashed_token || data?.hashed_token || ''
    const type = data?.properties?.verification_type || params.type
    if (error || !tokenHash) continue

    const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, token_hash: tokenHash }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error('Supabase verify exchange failed', response.status, detail)
      continue
    }
    const session = await response.json().catch(() => null)
    if (session?.access_token && session?.refresh_token) {
      return { access_token: session.access_token, refresh_token: session.refresh_token }
    }
  }
  return null
}

async function handleVerify(res, admin, { email, purpose, code, secret, supabaseUrl, anonKey }) {
  const submitted = String(code || '').replace(/\D/g, '')
  if (!otpCodePattern().test(submitted)) {
    return json(res, 400, { error: `Enter the ${OTP_CODE_LENGTH}-digit code from your email.`, code: 'invalid_code' })
  }

  let allowed
  try {
    allowed = await checkVerifyAttemptLimit(admin, purpose, email)
  } catch (error) {
    return json(res, 503, { error: error.message })
  }
  if (!allowed) {
    return json(res, 429, { error: 'Too many verification attempts. Request a new code in a few minutes.' })
  }

  let outcome
  try {
    const { data, error } = await admin.rpc('verify_auth_email_code', {
      p_email: email,
      p_purpose: purpose,
      p_code_hash: hashOtpCode({ code: submitted, email, purpose, secret }),
      p_max_attempts: OTP_MAX_ATTEMPTS,
    })
    if (error) throw error
    outcome = data
  } catch {
    return json(res, 503, { error: SCHEMA_HINT })
  }

  if (outcome !== 'ok') {
    const error = outcome === 'expired'
      ? 'This code expired. Request a new one.'
      : outcome === 'too_many_attempts'
        ? 'Too many incorrect attempts. Request a new code.'
        : outcome === 'not_found'
          ? 'That code is no longer valid. Request a new one.'
          : 'That code is incorrect.'
    return json(res, 400, { error, code: 'invalid_code' })
  }

  const session = await createSupabaseSession(admin, { email, purpose, supabaseUrl, anonKey })
  if (!session) {
    return json(res, 502, { error: 'Your email is verified, but a sign-in session could not be created. Try signing in.' })
  }
  return json(res, 200, { ok: true, ...session })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method not allowed.' })
  }

  const origin = secureOrigin(req)
  if (!origin) return json(res, 403, { error: 'Invalid request origin.' })

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  const resendApiKey = process.env.RESEND_API_KEY
  const sender = resolveResendFrom(process.env.RESEND_FROM)
  const secret = resolveOtpHashSecret(process.env)
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !secret) {
    return json(res, 503, { error: 'Email verification is not configured on the server.' })
  }

  let body
  try {
    body = readBody(req)
  } catch {
    return json(res, 400, { error: 'Invalid request body.' })
  }

  const action = String(body.action || '')
  const purpose = String(body.purpose || (action === 'signup' ? 'signup' : ''))
  const email = normalizedEmail(body.email)
  if (!PURPOSES.has(purpose) || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, { error: 'Enter a valid email address.' })
  }

  const admin = createAdminClient(supabaseUrl, serviceRoleKey)

  if (action === 'verify') {
    if (!anonKey) return json(res, 503, { error: 'Email verification is not configured on the server.' })
    return handleVerify(res, admin, { email, purpose, code: body.code, secret, supabaseUrl, anonKey })
  }

  if (!['signup', 'recovery', 'email', 'resend'].includes(action)) {
    return json(res, 400, { error: 'Invalid email code action.' })
  }
  if (action !== 'resend' && action !== purpose) {
    return json(res, 400, { error: 'Invalid email code action.' })
  }

  let allowed
  try {
    allowed = await checkSendLimit(admin, purpose, email)
  } catch (error) {
    return json(res, 503, { error: error.message })
  }
  if (!allowed) return json(res, 429, { error: 'Please wait a minute before requesting another code.' })

  let user = null
  let password = ''
  if (action === 'signup') {
    password = String(body.password || '')
    const firstName = String(body.firstName || '').trim()
    const lastName = String(body.lastName || '').trim()
    const memberId = String(body.memberId || '')
    if (firstName.length > 128 || lastName.length > 128 || !/^10\d{8}$/.test(memberId)) {
      return json(res, 400, { error: 'Provide a valid name and member ID.' })
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: { first_name: firstName, last_name: lastName, member_id: memberId },
    })
    if (error) {
      const existing = await findAuthUserByEmail(admin, email)
      if (!existing) return json(res, 400, { error: error.message })
      if (existing.emailVerified) {
        // A confirmed account must never be re-registered with a new password.
        // The code lets the client point at the sign-in flow instead.
        return json(res, 400, {
          error: 'An account with this email address already exists.',
          code: 'email_already_registered',
        })
      }
      user = existing
    } else {
      user = data.user
    }
  } else {
    user = await findAuthUserByEmail(admin, email)
    if (!user) return json(res, 200, { ok: true })
  }
  if (!user?.id) return json(res, 502, { error: 'Could not prepare email verification. Please try again.' })

  try {
    await issueEmailCode(admin, {
      email,
      purpose,
      userId: user.id,
      apiKey: resendApiKey,
      from: sender,
      secret,
    })
    return json(res, 200, { ok: true })
  } catch (error) {
    return json(res, 502, {
      error: error.message,
      verificationPending: purpose === 'signup',
    })
  }
}
