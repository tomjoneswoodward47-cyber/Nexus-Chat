# Workflow sessions

Workflow sessions are short-lived, server-validated authorization records for
controlled QA and local credential-vault workflows. They do not route traffic
to a staging deployment, expose credential values, or replace Supabase sign-in.

## Lifecycle and access policy

| Workflow | Who may start | Approval | Maximum lifetime |
| --- | --- | --- | --- |
| `staging` | Supabase admin or an operator with the `qa` workflow role | None | 1 hour |
| `vault` | Operator with the `vault_operator` workflow role | A different Supabase admin must issue a single-use approval; it expires in 5 minutes | 15 minutes |

All session creation, role changes, vault approvals, and audit-log reads require
Supabase AAL2 with a second-factor AMR timestamp no older than 5 minutes. Session
validation requires AAL2 and the same Supabase `session_id` used to create the
workflow session; the database also confirms that the Supabase session still
exists, so Supabase sign-out invalidates the workflow session. Owners can terminate their sessions without a fresh MFA
challenge; admins can terminate any session. Revoking a workflow role revokes
that operator's active sessions of the corresponding type. Account deletion
revokes and audits all active workflow sessions before removing the account.

The browser receives only an opaque, 256-bit random token in an HttpOnly,
SameSite=Strict cookie. The database stores only its SHA-256 hash. Staging and
vault tokens use different cookie names and independent records. Every successful
validation is audited. The server-only database function performs state changes
and audit inserts together; application roles cannot access the tables or call
the function directly.

Audit events contain actor/subject/session IDs, workflow type, fixed action
names, timestamps, and bounded server-generated reason codes. They never contain
session tokens, access tokens, passwords, vault keys, or credential values.
Only admins with recent AAL2 can read the latest 100 events through the API.

## API

All requests require a Supabase `Authorization: Bearer <access-token>` header.
The browser helper in `src/lib/workflowSessions.js` keeps the workflow token
HttpOnly and calls these routes:

- `POST /api/workflow-sessions` with `{ "action": "create", "kind": "staging" }`
  or `{ "action": "create", "kind": "vault", "approvalId": "..." }`
- `GET /api/workflow-sessions?kind=staging|vault` to validate the matching
  browser session
- `DELETE /api/workflow-sessions?kind=staging|vault` to terminate the current
  browser session
- `POST` with `action` equal to `approve_vault`, `grant_role`, `revoke_role`, or
  `terminate` for the corresponding admin/owner operation
- `GET /api/workflow-sessions?audit=1` for the admin audit view
- `POST /api/workflow-sessions` with `{ "action": "issue_cli_handoff" }` to
  issue a one-minute code from an active vault session. The unauthenticated
  redemption request is the only exception to the Supabase bearer requirement:
  `{ "action": "redeem_cli_handoff", "code": "..." }`. Its random, single-use
  code is the sole credential accepted for redemption.
- `POST /api/workflow-cli-session` with the returned CLI session token in an
  HTTPS `Authorization` header to validate the short-lived CLI session.

The `qa` and `vault_operator` roles are server-managed. An admin grants or
revokes them through the API helper; an operator cannot grant a role to themself.
The encrypted credential vault remains local. A vault operator can issue a
single-use, 256-bit CLI handoff from [`/workflow-cli-handoff`](../src/pages/WorkflowCliHandoff.jsx)
while an approved vault session and recent AAL2 proof are active. The code is
SHA-256 hashed in the database, expires after one minute, and can be redeemed
only once. Redemption returns a separate 15-minute CLI session token, also
stored only as a hash server-side. The CLI asks for the handoff code through a
hidden interactive prompt, sends it in an HTTPS request body, validates the
returned token through the server, and never saves or prints that token. No
vault key or credential value is sent to the server. CLI status and rotation
operations fail closed when no valid handoff is available.

## Staging validation and deployment

The workflow schema is introduced by
[`20261123090121_workflow_session_management.sql`](../supabase/migrations/20261123090121_workflow_session_management.sql)
and completed by
[`20261123103000_workflow_cli_handoff_dispatch.sql`](../supabase/migrations/20261123103000_workflow_cli_handoff_dispatch.sql).
Run `node scripts/staging-workflow-sessions.mjs --confirm-staging` to apply
only these workflow migrations to the configured isolated staging database,
record them in Supabase migration history, and run database-backed lifecycle
tests inside a rolled-back transaction. The command requires an explicit
staging flag and rejects non-Supabase database hosts.

Set `WORKFLOW_SESSION_API_URL` in the local environment to the authorized app
origin before using the credential CLI. To sync runtime values for staging,
use `npm run vercel:env:dry -- --target preview` first, then
`npm run vercel:env:sync -- --target preview`. Preview sync checks that the
browser, server, and configured database URLs identify the same Supabase
project. Production sync is separately gated and is not part of this staging
workflow.

The server uses the server-only `SUPABASE_SERVICE_ROLE_KEY` solely to verify
Supabase identities and call a restricted workflow-session RPC. Never put that
key, workflow tokens, or credential values in browser storage, command-line
arguments, Vercel logs, or audit details.

Appwrite-authenticated users cannot use these workflows: privileged session
operations require a verified Supabase token with AAL2, which Appwrite does not
provide.

## Validation record

On 2026-11-23, the two workflow migrations were applied to the confirmed
isolated staging database. Database-backed lifecycle checks passed for QA role
enforcement, session owner/auth-session isolation, expiry, owner termination,
separate-admin vault approval and one-time consumption, role revocation,
single-use CLI handoff/redeem/validation, audit persistence, and table/RPC
privileges. Test identities and lifecycle rows were rolled back.

`npm run test:workflow-sessions` passed all 25 tests; `npm run db:verify`,
`npm run lint`, and `npm run build` passed. The build reports the existing
large face-detection chunk warning. The Vercel Preview environment sync also
completed after its staging-project dry run; no Production environment or
database was changed. A new Preview deployment was not started.
