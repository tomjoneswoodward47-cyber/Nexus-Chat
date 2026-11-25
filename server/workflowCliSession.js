import { createClient } from '@supabase/supabase-js'
import { hashWorkflowSessionToken } from './workflowSessions.js'

function respond(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(status).json(body)
}

export function createWorkflowCliSessionHandler({
  createSupabaseClient = createClient,
  env = process.env,
  logger = console,
} = {}) {
  return async function workflowCliSessionHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST') {
      return respond(res, 405, { error: 'Method not allowed.' })
    }

    const token = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1] || ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return respond(res, 401, { error: 'A valid CLI vault session is required.' })
    }

    const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim()
    const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
    if (!url || !serviceKey) {
      return respond(res, 503, { error: 'Workflow sessions are not configured on the server.' })
    }

    try {
      const admin = createSupabaseClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data, error } = await admin.rpc('manage_workflow_session', {
        p_actor_id: null,
        p_action: 'validate_cli_session',
        p_kind: null,
        p_session_id: null,
        p_token_hash: hashWorkflowSessionToken(token),
        p_target_user_id: null,
        p_role: null,
        p_approval_id: null,
        p_auth_session_id: null,
        p_cli_token_hash: null,
      })
      if (error || !data || typeof data !== 'object') {
        throw new Error('Workflow CLI session validation failed.')
      }
      if (!data.ok) {
        const status = ['expired', 'terminated', 'revoked'].includes(data.code) ? 410 : 401
        return respond(res, status, { error: 'The CLI vault session is invalid, expired, or revoked.' })
      }
      return respond(res, 200, { session: data })
    } catch (error) {
      logger.error('Workflow CLI session validation failed', {
        message: error?.message || 'Unknown error.',
        code: error?.code || 'unknown',
      })
      return respond(res, 503, { error: 'Workflow session service is temporarily unavailable.' })
    }
  }
}

export default createWorkflowCliSessionHandler()
