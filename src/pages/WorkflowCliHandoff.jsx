import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { createWorkflowCliHandoff } from '../lib/workflowSessions'

export default function WorkflowCliHandoff() {
  const [handoff, setHandoff] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!handoff) return undefined
    const remaining = Math.max(0, new Date(handoff.expiresAt).getTime() - Date.now())
    const timeout = setTimeout(() => setHandoff(null), remaining)
    return () => clearTimeout(timeout)
  }, [handoff])

  async function issueHandoff() {
    setBusy(true)
    setError('')
    setHandoff(null)
    setCopied(false)
    try {
      const result = await createWorkflowCliHandoff()
      setHandoff(result.handoff)
    } catch (issueError) {
      setError(issueError.message || 'Could not create the CLI authorization handoff.')
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(handoff.code)
      setCopied(true)
    } catch {
      setError('Clipboard access is unavailable. Select and copy the code manually.')
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <section className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm">
        <Link to="/app/settings" className="text-sm text-primary hover:underline">Back to settings</Link>
        <h1 className="mt-5 text-2xl font-semibold">Authorize the credential CLI</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This issues a single-use code for an active, approved vault session. The code expires in one minute.
          The CLI redeems it for a short-lived session held only in memory.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Never paste vault secrets or session tokens into a terminal command. Do not share the handoff code.
        </p>
        <button
          type="button"
          onClick={issueHandoff}
          disabled={busy}
          className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? 'Creating code…' : 'Create one-time code'}
        </button>
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        {handoff && (
          <div className="mt-5 rounded-xl border border-border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expires {new Date(handoff.expiresAt).toLocaleTimeString()}</p>
            <code className="mt-2 block break-all rounded bg-muted p-3 text-sm">{handoff.code}</code>
            <button type="button" onClick={copyCode} className="mt-3 text-sm font-medium text-primary hover:underline">
              {copied ? 'Copied' : 'Copy code'}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
