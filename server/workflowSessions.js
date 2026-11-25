import { createHash, randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const WORKFLOW_SESSION_TTL_SECONDS = Object.freeze({
  staging: 60 * 60,
  vault: 15 * 60,
})

export const WORKFLOW_SESSION_COOKIE_NAMES = Object.freeze({
  staging: 'nexus_staging_workflow',
  vault: 'nexus_vault_workflow',
})

const SESSION_ACTIONS = new Set(['create', 'approve_vault', 'grant_role', 'revoke_role', 'terminate', 'issue_cli_handoff'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MFA_METHODS = new Set(['totp', 'phone', 'otp'])

export function hashWorkflowSessionToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function hasRecentAal2(claims, now = Date.now()) {
  if (claims?.aal !== 'aal2' || !Array.isArray(claims.amr)) return false
  const nowSeconds = Math.floor(now / 1000)
  return claims.amr.some((entry) => {
    const timestamp = Number(entry?.timestamp)
    return MFA_METHODS.has(entry?.method)
      && Number.isFinite(timestamp)
      && timestamp <= nowSeconds + 30
      && timestamp >= nowSeconds - 5 * 60
  })
}

export function hasAal2(claims) {
  return claims?.aal === 'aal2'
}

function sessionCookieName(kind) {
  return Object.hasOwn(WORKFLOW_SESSION_COOKIE_NAMES, kind) ? WORKFLOW_SESSION_COOKIE_NAMES[kind] : ''
}

function cookieOptions(kind, env) {
  return `Path=/api/workflow-sessions; HttpOnly; SameSite=Strict${env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

export function workflowSessionCookie(kind, token, maxAge, env = process.env) {
  const name = sessionCookieName(kind)
  if (!name) throw new Error('Unsupported workflow session type.')
  return `${name}=${token}; ${cookieOptions(kind, env)}; Max-Age=${Math.max(0, Math.floor(maxAge))}`
}

export function clearedWorkflowSessionCookie(kind, env = process.env) {
  const name = sessionCookieName(kind)
  if (!name) throw new Error('Unsupported workflow session type.')
  return `${name}=; ${cookieOptions(kind, env)}; Max-Age=0`
}

export function readWorkflowSessionCookie(cookieHeader, kind) {
  const name = sessionCookieName(kind)
  if (!name) return null
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null
    }
  }
  return null
}

function sameOriginRequest(req, env) {
  const origin = req.headers?.origin
  if (!origin) return true
  const host = String(req.headers?.host || '').toLowerCase()
  if (!host) return false
  try {
    const parsed = new URL(origin)
    const allowedProtocol = parsed.protocol === 'https:'
      || (env.NODE_ENV !== 'production' && parsed.protocol === 'http:')
    return allowedProtocol && parsed.host.toLowerCase() === host
  } catch {
    return false
  }
}

function send(res, status, body, headers = {}) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  return res.status(status).json(body)
}

function queryValue(value) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function resultStatus(result) {
  switch (result?.code) {
    case 'forbidden':
    case 'approval_required':
    case 'approval_invalid':
      return 403
    case 'not_found':
      return 404
    case 'conflict':
      return 409
    case 'expired':
    case 'terminated':
    case 'revoked':
      return 410
    case 'invalid':
      return 400
    default:
      return result?.ok ? 200 : 400
  }
}

function resultMessage(result) {
  const messages = {
    forbidden: 'You are not authorized for this workflow session.',
    approval_required: 'An unexpired vault approval is required.',
    approval_invalid: 'The vault approval is invalid, expired, or already used.',
    not_found: 'The workflow session was not found.',
    conflict: 'An active session of this type already exists.',
    expired: 'The workflow session has expired.',
    terminated: 'The workflow session has been terminated.',
    revoked: 'The workflow session has been revoked.',
    invalid: 'The workflow session request is invalid.',
  }
  return messages[result?.code] || 'The workflow session request could not be completed.'
}

export function createWorkflowSessionHandler({
  createSupabaseClient = createClient,
  env = process.env,
  now = () => Date.now(),
  makeRandomBytes = randomBytes,
  logger = console,
} = {}) {
  async function loadIdentity(req, res) {
    const bearer = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1]
    if (!bearer || bearer.length > 8192) {
      send(res, 401, { error: 'A valid Supabase session is required.' })
      return null
    }

    const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim()
    const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
    if (!url || !serviceKey) {
      send(res, 503, { error: 'Workflow sessions are not configured on the server.' })
      return null
    }

    const admin = createSupabaseClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: userData, error: userError } = await admin.auth.getUser(bearer)
    if (userError && [401, 403].includes(Number(userError.status))) {
      send(res, 401, { error: 'A valid Supabase session is required.' })
      return null
    }
    if (userError) throw new Error('Supabase user verification failed.')
    if (!userData?.user) {
      send(res, 401, { error: 'A valid Supabase session is required.' })
      return null
    }
    const { data: claimsData, error: claimsError } = await admin.auth.getClaims(bearer)
    const claims = claimsData?.claims
    if (claimsError && [401, 403].includes(Number(claimsError.status))) {
      send(res, 401, { error: 'A valid Supabase session is required.' })
      return null
    }
    if (claimsError) throw new Error('Supabase claim verification failed.')
    if (claims?.sub !== userData.user.id
      || claims?.is_anonymous === true
      || !UUID_PATTERN.test(String(claims?.session_id || ''))) {
      send(res, 401, { error: 'A valid Supabase session is required.' })
      return null
    }
    return { admin, user: userData.user, claims }
  }

  async function callAction(admin, actorId, action, values = {}) {
    const { data, error } = await admin.rpc('manage_workflow_session', {
      p_actor_id: actorId,
      p_action: action,
      p_kind: values.kind || null,
      p_session_id: values.sessionId || null,
      p_token_hash: values.tokenHash || null,
      p_target_user_id: values.targetUserId || null,
      p_role: values.role || null,
      p_approval_id: values.approvalId || null,
      p_auth_session_id: values.authSessionId || null,
      p_cli_token_hash: values.cliTokenHash || null,
    })
    if (error || !data || typeof data !== 'object') {
      const failure = new Error('Workflow session state is temporarily unavailable.')
      failure.code = error?.code || 'unknown'
      throw failure
    }
    return data
  }

  async function requireRecentMfa(identity, res) {
    if (hasRecentAal2(identity.claims, now())) return true
    try {
      await callAction(identity.admin, identity.user.id, 'auth_denied')
    } catch (error) {
      logger.error('Workflow session denial audit failed', { error: error.message })
    }
    send(res, 403, { error: 'Recent multi-factor authentication is required.' })
    return false
  }

  async function requireAal2(identity) {
    if (hasAal2(identity.claims)) return true
    try {
      await callAction(identity.admin, identity.user.id, 'auth_denied')
    } catch (error) {
      logger.error('Workflow session denial audit failed', { error: error.message })
    }
    return false
  }

  return async function workflowSessionHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST, DELETE' })
    }
    if (!sameOriginRequest(req, env)) {
      return send(res, 403, { error: 'Cross-origin workflow session requests are not allowed.' })
    }

    try {
      const requestBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
      if (req.method === 'POST' && requestBody.action === 'redeem_cli_handoff') {
        const code = String(requestBody.code || '')
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
          return send(res, 400, { error: 'The CLI authorization handoff is invalid or expired.' })
        }
        const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim()
        const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
        if (!url || !serviceKey) {
          return send(res, 503, { error: 'Workflow sessions are not configured on the server.' })
        }
        const admin = createSupabaseClient(url, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
        const cliToken = makeRandomBytes(32).toString('base64url')
        const result = await callAction(admin, null, 'redeem_cli_handoff', {
          tokenHash: hashWorkflowSessionToken(code),
          cliTokenHash: hashWorkflowSessionToken(cliToken),
        })
        if (!result.ok) return send(res, resultStatus(result), { error: resultMessage(result) })
        return send(res, 200, { token: cliToken, expiresAt: result.expiresAt })
      }

      const identity = await loadIdentity(req, res)
      if (!identity) return undefined

      if (req.method === 'GET') {
        if (queryValue(req.query?.audit) === '1') {
          if (!await requireRecentMfa(identity, res)) return undefined
          const result = await callAction(identity.admin, identity.user.id, 'read_audit')
          if (!result.ok) return send(res, resultStatus(result), { error: resultMessage(result) })
          return send(res, 200, { events: result.events || [] })
        }

        const kind = queryValue(req.query?.kind)
        if (!Object.hasOwn(WORKFLOW_SESSION_COOKIE_NAMES, kind)) {
          return send(res, 400, { error: 'The workflow session type is invalid.' })
        }
        const token = readWorkflowSessionCookie(req.headers?.cookie, kind)
        if (!token) return send(res, 401, { error: 'The workflow session is not active.' })
        if (!await requireAal2(identity)) {
          return send(res, 403, { error: 'Multi-factor authentication is required.' }, {
            'Set-Cookie': clearedWorkflowSessionCookie(kind, env),
          })
        }
        const result = await callAction(identity.admin, identity.user.id, 'validate', {
          kind,
          tokenHash: hashWorkflowSessionToken(token),
          authSessionId: identity.claims.session_id,
        })
        if (!result.ok) {
          const status = resultStatus(result)
          return send(res, status === 410 ? 410 : 401, { error: resultMessage(result) }, {
            'Set-Cookie': clearedWorkflowSessionCookie(kind, env),
          })
        }
        return send(res, 200, { session: result })
      }

      if (req.method === 'DELETE') {
        const kind = queryValue(req.query?.kind)
        if (!Object.hasOwn(WORKFLOW_SESSION_COOKIE_NAMES, kind)) {
          return send(res, 400, { error: 'The workflow session type is invalid.' })
        }
        const token = readWorkflowSessionCookie(req.headers?.cookie, kind)
        if (!token) {
          return send(res, 200, { terminated: false }, {
            'Set-Cookie': clearedWorkflowSessionCookie(kind, env),
          })
        }
        const result = await callAction(identity.admin, identity.user.id, 'terminate', {
          kind,
          tokenHash: hashWorkflowSessionToken(token),
        })
        const status = resultStatus(result)
        return send(res, status, result.ok ? { session: result } : { error: resultMessage(result) }, {
          'Set-Cookie': clearedWorkflowSessionCookie(kind, env),
        })
      }

      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
      const action = String(body.action || '')
      if (!SESSION_ACTIONS.has(action)) return send(res, 400, { error: 'The workflow session action is invalid.' })

      if (action === 'terminate') {
        if (!UUID_PATTERN.test(String(body.sessionId || ''))) {
          return send(res, 400, { error: 'A valid workflow session ID is required.' })
        }
        const result = await callAction(identity.admin, identity.user.id, action, { sessionId: body.sessionId })
        const status = resultStatus(result)
        return send(res, status, result.ok ? { session: result } : { error: resultMessage(result) })
      }

      if (!await requireRecentMfa(identity, res)) return undefined

      if (action === 'issue_cli_handoff') {
        const token = readWorkflowSessionCookie(req.headers?.cookie, 'vault')
        if (!token) return send(res, 401, { error: 'An active vault workflow session is required.' })
        const session = await callAction(identity.admin, identity.user.id, 'validate', {
          kind: 'vault',
          tokenHash: hashWorkflowSessionToken(token),
          authSessionId: identity.claims.session_id,
        })
        if (!session.ok) return send(res, resultStatus(session), { error: resultMessage(session) })
        const code = makeRandomBytes(32).toString('base64url')
        const result = await callAction(identity.admin, identity.user.id, action, {
          sessionId: session.sessionId,
          tokenHash: hashWorkflowSessionToken(code),
        })
        if (!result.ok) return send(res, resultStatus(result), { error: resultMessage(result) })
        return send(res, 201, { handoff: { code, expiresAt: result.expiresAt } })
      }

      if (action === 'create') {
        const kind = String(body.kind || '')
        if (!Object.hasOwn(WORKFLOW_SESSION_TTL_SECONDS, kind)) {
          return send(res, 400, { error: 'The workflow session type is invalid.' })
        }
        if (kind === 'vault' && !UUID_PATTERN.test(String(body.approvalId || ''))) {
          await callAction(identity.admin, identity.user.id, 'approval_denied', { kind })
          return send(res, 403, { error: 'An unexpired vault approval is required.' })
        }
        const token = makeRandomBytes(32).toString('base64url')
        const result = await callAction(identity.admin, identity.user.id, action, {
          kind,
          tokenHash: hashWorkflowSessionToken(token),
          approvalId: body.approvalId,
          authSessionId: identity.claims.session_id,
        })
        if (!result.ok) return send(res, resultStatus(result), { error: resultMessage(result) })
        return send(res, 201, { session: result }, {
          'Set-Cookie': workflowSessionCookie(kind, token, WORKFLOW_SESSION_TTL_SECONDS[kind], env),
        })
      }

      if (action === 'approve_vault' && !UUID_PATTERN.test(String(body.targetUserId || ''))) {
        return send(res, 400, { error: 'A valid vault operator ID is required.' })
      }
      if (['grant_role', 'revoke_role'].includes(action)) {
        if (!UUID_PATTERN.test(String(body.targetUserId || ''))
          || !['qa', 'vault_operator'].includes(String(body.role || ''))) {
          return send(res, 400, { error: 'A valid workflow role and user ID are required.' })
        }
      }
      const result = await callAction(identity.admin, identity.user.id, action, {
        targetUserId: body.targetUserId,
        role: body.role,
      })
      if (!result.ok) return send(res, resultStatus(result), { error: resultMessage(result) })
      return send(res, 200, { result })
    } catch (error) {
      logger.error('Workflow session request failed', {
        message: error?.message || 'Unknown error.',
        code: error?.code || 'unknown',
      })
      return send(res, 503, { error: 'Workflow session service is temporarily unavailable.' })
    }
  }
}

export default createWorkflowSessionHandler()
