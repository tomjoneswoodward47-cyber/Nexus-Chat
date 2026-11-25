import { supabase } from './supabase'

const SESSION_KINDS = ['staging', 'vault']

async function getAccessToken() {
  if (!supabase) throw new Error('Workflow sessions require Supabase authentication.')
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(`The current sign-in could not be verified: ${error.message}`)
  const token = data?.session?.access_token
  if (!token) throw new Error('Sign in before using workflow sessions.')
  return token
}

async function requestWorkflowSession(path, options = {}) {
  const token = await getAccessToken()
  const response = await fetch(`/api/workflow-sessions${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The workflow session request failed.')
  return result
}

export function createWorkflowSession(kind, approvalId) {
  return requestWorkflowSession('', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', kind, approvalId }),
  })
}

export function createWorkflowCliHandoff() {
  return requestWorkflowSession('', {
    method: 'POST',
    body: JSON.stringify({ action: 'issue_cli_handoff' }),
  })
}

export function validateWorkflowSession(kind) {
  return requestWorkflowSession(`?kind=${encodeURIComponent(kind)}`)
}

export function terminateWorkflowSession(kind) {
  return requestWorkflowSession(`?kind=${encodeURIComponent(kind)}`, { method: 'DELETE' })
}

export function terminateWorkflowSessionById(sessionId) {
  return requestWorkflowSession('', {
    method: 'POST',
    body: JSON.stringify({ action: 'terminate', sessionId }),
  })
}

export function readWorkflowSessionAudit() {
  return requestWorkflowSession('?audit=1')
}

export function approveVaultSession(targetUserId) {
  return requestWorkflowSession('', {
    method: 'POST',
    body: JSON.stringify({ action: 'approve_vault', targetUserId }),
  })
}

export function setWorkflowSessionRole(userId, role, enabled) {
  return requestWorkflowSession('', {
    method: 'POST',
    body: JSON.stringify({
      action: enabled ? 'grant_role' : 'revoke_role',
      targetUserId: userId,
      role,
    }),
  })
}

export async function terminateWorkflowSessions() {
  if (!supabase) return
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(`The current sign-in could not be verified: ${error.message}`)
  const token = data?.session?.access_token
  if (!token) return

  const results = await Promise.all(SESSION_KINDS.map(async (kind) => {
    const response = await fetch(`/api/workflow-sessions?kind=${kind}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      throw new Error(result.error || `The ${kind} session could not be terminated.`)
    }
  }))
  return results
}
