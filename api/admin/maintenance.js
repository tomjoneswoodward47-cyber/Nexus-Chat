import { createClient } from '@supabase/supabase-js'
import { MaintenanceError, runRlsPolicyMaintenance } from '../../server/rlsPolicyMaintenance.js'

// Admin-only: runs the atomic RLS policy refresh (drop + recreate every policy
// inside one transaction). Mirrors the strongest admin checks used by
// /api/admin/session: a Supabase Bearer token, an aal2 (MFA) session and the
// admin role, all verified server-side with the service-role key.
function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(status).json(body)
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const databaseUrl = process.env.SUPABASE_DB_URL
  if (!url || !serviceKey) return send(res, 503, { error: 'Vercel is missing its Supabase server settings.' })
  if (!databaseUrl) return send(res, 503, { error: 'SUPABASE_DB_URL is not configured on the server.' })

  const token = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) return send(res, 401, { error: 'Sign in required.' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return send(res, 401, { error: 'Sign in required.' })

  const { data: claimsData, error: claimsError } = await admin.auth.getClaims(token)
  if (claimsError || claimsData?.claims?.sub !== data.user.id) return send(res, 401, { error: 'Sign in required.' })
  if (claimsData.claims.aal !== 'aal2') {
    return send(res, 403, { error: 'Administrator multi-factor authentication is required.' })
  }

  const { data: isAdmin, error: roleError } = await admin.rpc('has_role', { _user_id: data.user.id, _role: 'admin' })
  if (roleError) {
    console.error('Admin role check failed', roleError)
    return send(res, 503, { error: 'Admin access could not be verified.' })
  }
  if (isAdmin !== true) return send(res, 403, { error: 'Admins only.' })

  try {
    const report = await runRlsPolicyMaintenance({ connectionString: databaseUrl, actorId: data.user.id })
    return send(res, 200, { ok: true, report })
  } catch (runError) {
    if (runError instanceof MaintenanceError) {
      return send(res, runError.status, { ok: false, error: runError.message, report: runError.report })
    }
    console.error('RLS policy maintenance failed', runError)
    return send(res, 500, { ok: false, error: 'The maintenance script failed unexpectedly.' })
  }
}
