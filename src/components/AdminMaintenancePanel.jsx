import { useState } from 'react'
import { CheckCircle2, LoaderCircle, Play, RefreshCw, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { isAppwriteAuthEnabled } from '../lib/appwrite'

async function adminAuthHeader() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-slate-200 py-1.5 text-sm first:border-t-0 dark:border-slate-800">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-900 dark:text-slate-100">{value}</span>
    </div>
  )
}

function ReportSummary({ report }) {
  const validation = report.validation
  const verification = report.verification
  const disabledChecks = (validation?.checks || []).filter((check) => !check.ok)
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
      <SummaryRow label="Transaction" value={report.committed ? 'Committed atomically' : 'Rolled back'} />
      <SummaryRow label="Validation" value={validation?.ok ? 'Passed' : `Failed${disabledChecks.length ? ` (${disabledChecks.map((c) => c.name).join(', ')})` : ''}`} />
      <SummaryRow label="Policies dropped" value={report.dropped?.length ?? 0} />
      <SummaryRow label="Policies recreated" value={`${report.created?.length ?? 0} / ${report.expectedPolicyCount}`} />
      <SummaryRow label="Verification" value={verification?.ok ? 'All policies present and correct' : 'Mismatch detected'} />
      <SummaryRow label="Audit log" value={report.auditLogged ? 'Recorded' : 'Not recorded'} />
      <SummaryRow label="Duration" value={report.startedAt && report.finishedAt ? `${Math.max(0, new Date(report.finishedAt) - new Date(report.startedAt))} ms` : '—'} />
    </div>
  )
}

export default function AdminMaintenancePanel() {
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [report, setReport] = useState(null)
  const appwrite = isAppwriteAuthEnabled()
  const busy = status === 'running'

  const runScript = async () => {
    setStatus('running')
    setMessage('')
    setReport(null)
    try {
      const response = await fetch('/api/admin/maintenance', {
        method: 'POST',
        headers: { ...(await adminAuthHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-rls-policies' }),
      })
      const body = await response.json().catch(() => null)
      setReport(body?.report || null)
      if (!response.ok || !body?.ok) {
        setStatus('error')
        setMessage(body?.error || `The maintenance script failed (HTTP ${response.status}).`)
        return
      }
      setStatus('success')
      setMessage('All Row Level Security policies were refreshed inside a single transaction.')
    } catch {
      setStatus('error')
      setMessage('The maintenance script could not reach the server. This is expected in a local preview.')
    }
  }

  return (
    <section className="mt-8 rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-xl font-semibold">Database maintenance</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Runs the RLS policy refresh script. It validates the expected schemas, then drops and recreates every Row Level
        Security policy inside one atomic transaction: either the whole refresh commits, or nothing changes. Concurrent
        sessions keep seeing the complete policy set and never a missing or half-applied policy.
      </p>
      <button
        type="button"
        onClick={runScript}
        disabled={busy || appwrite}
        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Run Script
      </button>
      {appwrite && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          This script runs against the Supabase project and is unavailable while the Appwrite identity provider is enabled.
        </p>
      )}
      {message && (
        <p className={`mt-4 flex items-start gap-2 text-sm ${status === 'success' ? 'text-primary' : 'text-destructive'}`}>
          {status === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          {message}
        </p>
      )}
      {report && <ReportSummary report={report} />}
      {status === 'error' && (
        <button
          type="button"
          onClick={runScript}
          disabled={busy}
          className="mt-3 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      )}
    </section>
  )
}
