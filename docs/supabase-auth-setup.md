# Supabase Auth and Resend setup

The application uses Supabase Auth for credentials and recovery, Supabase `members` rows for Nexus profiles, and Appwrite for the existing chat data. A Vercel serverless function or the `email-code` Edge Function creates an unconfirmed Supabase user, generates a native Auth OTP, and sends signup, resend, and recovery codes directly through the Resend API. The browser verifies that six-digit code with `verifyOtp`; email verification links are not part of the flow. `RESEND_API_KEY` is server-only and must never be exposed through a `VITE_` variable or browser bundle.

## 1. Apply the database migration

Schema changes are versioned SQL files under `supabase/migrations/`. Builds and browser-facing code never apply SQL. An operator explicitly runs `npm run db:setup:dry` to review migration files, then `npm run db:setup` to apply pending migrations. The CLI applies each migration in a transaction, takes an advisory lock, records its version and SHA-256 checksum in `public.nexus_schema_migrations`, and verifies the required tables, functions, and Auth triggers. Editing an already-applied migration is rejected; create a new timestamped migration instead. The earliest remaining migration, `20261012110244_880a9c2a-16c5-4d14-8803-b9bf93c0faab.sql`, creates `public.members` for Supabase Auth users, applies RLS and the protected-field trigger, installs the `on_auth_user_created`/`on_auth_user_updated` Auth triggers and the `lookup_member_by_nexus_id` function, and backfills existing accounts; `20261012122632_31486d60-08f7-48ec-a6e7-0d32384bd185.sql` then installs the persistent email-code rate-limit RPC and its `public.auth_email_code_limits` table required by the Vercel email endpoint.

The superseded `20261006000000_initial_nexus_schema.sql` and `20261006010000_authenticated_member_lookup.sql` migrations were retired from this directory. They belonged to the abandoned `profiles`-based design (`public.profiles`, `verify_member_login`, `current_member_profile_id`, `current_member_is_admin`, `create_member_for_auth_user`, `sync_member_email_from_auth_user`, `auth_email_code_rate_limits`, and the `on_auth_user_created_nexus_member`/`on_auth_user_updated_nexus_email` triggers), and every object they created is re-created by the later migrations above. Do not re-add them. A project whose `public.nexus_schema_migrations` history still lists those versions will report them as "exists in source: false" in `npm run db:verify`; that is expected and does not apply to the live project, which tracks history in `supabase_migrations.schema_migrations`.

Set `SUPABASE_DB_URL` locally in ignored `.env.local` to a PostgreSQL connection string from Supabase (prefer the Session pooler connection string when the operator machine cannot connect directly). It is a highly privileged secret. The Supabase anon and service-role API keys cannot execute arbitrary DDL; the CLI checks them against Supabase Auth endpoints, but only the explicit migration command uses the database URL to apply checked-in migration files. It is also required on Vercel as a server-only variable for the admin RLS policy refresh endpoint (`/api/admin/maintenance`); set it there without a `VITE_` prefix. Never expose it to browser code, and do not run migrations from a browser bot or build hook.

Projects provisioned before the superseded migrations were retired may still carry the legacy nullable `members.password` column; no current migration creates it. New accounts never write to it. Existing browser/Appwrite accounts without verified email addresses cannot be automatically linked safely; have those users register with an email and follow a supervised recovery/relink process. After legacy account disposition, remove the old column with:

```sql
alter table public.members drop column if exists password;
```

Create admin identities through Supabase Auth, then promote only the intended account in the SQL Editor:

```sql
update public.members
set role = 'admin'
where auth_user_id = (
  select id from auth.users where lower(email) = lower('admin@your-domain.com')
);
```

## 2. Configure auth URLs

In Supabase Dashboard, open **Authentication → URL Configuration**:

- Site URL: `https://nexus-chat-world.com`
- Redirect URLs are not used to complete email verification. Users enter the Resend OTP on `/verify-email` and `/verify-email?purpose=recovery`.
- For local development, open `http://localhost:5173/verify-email` after registration or recovery.

Keep **Confirm email** enabled in **Authentication → Providers → Email**. App verification codes expire after 10 minutes, allow at most five guesses, and are rate-limited by the database RPC installed by the schema migration. Do not send Supabase's built-in confirmation or recovery links; Resend delivers the OTP instead.

## 3. Configure Resend API

`nexus-chat-world.com` is registered in Resend and reported as **verified** with sending **enabled** (confirmed against `GET https://api.resend.com/domains` on 2026-10-17; domain id `4346b5a9-7004-470b-95ca-047171b0673c`, region `us-east-1`). Create or reuse an API key with send-only permissions. The server function sends through `https://api.resend.com/emails` using these Vercel Production variables:

- `RESEND_API_KEY` (encrypted server variable)
- `RESEND_FROM=Nexus Chat <admin@nexus-chat-world.com>`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (encrypted server variable)

The Supabase service-role key is used only by the Vercel function to generate OTPs; never prefix it with `VITE_`.

The same Resend credentials are also stored as Supabase secrets so the deployed `email-code` Edge Function delivers the identical signup, sign-in, and password-reset codes when the `/api` route is unreachable:

- `RESEND_API_KEY`
- `RESEND_FROM=Nexus Chat <admin@nexus-chat-world.com>`
- `OTP_HASH_SECRET` — required, because the Edge Function fails closed without a dedicated OTP hash secret rather than reusing the service-role key

`supabase/functions/email-code` is deployed with `verify_jwt = false` (`supabase/config.toml`). Both runtimes resolve the same OTP hash secret, so a code issued by one verifies against the other.

### Resend domain DNS records

Outgoing mail is sent `From: Nexus Chat <admin@nexus-chat-world.com>`. Resend signs it with DKIM on the apex domain and uses the `send` subdomain as the envelope (bounce) domain, so relaxed SPF and DKIM alignment both pass once DMARC is published. `nexus-chat-world.com` is delegated to Vercel (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`), so records are added in **Vercel → Project → Settings → Domains → nexus-chat-world.com → DNS Records** (or at whichever provider holds the nameservers), using the exact values from **Resend → Domains → nexus-chat-world.com**.

Resend manages three records and reports all three as **verified**; DMARC is not part of Resend's record set and must be maintained separately:

| Host | Type | Value | Purpose | State (checked 2026-10-17) |
| --- | --- | --- | --- | --- |
| `send` | MX, priority 10 | `feedback-smtp.eu-west-1.amazonses.com` | Return-path/bounce handling | Published — Resend reports verified |
| `send` | TXT | `v=spf1 include:amazonses.com ~all` | SPF for the Resend envelope domain | Published — Resend reports verified |
| `resend._domainkey` | TXT | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCpCVO2OQMfD9agOu1Ir+6Kt4vEf5RU30z8qwLGCuD9VExXFfHIVh75N47/eOqB5hqorBoT2cquvEzfy3wfV4qmMsINJrvNmG20ccy/22USQEjlwI58xOoiNd0lXbMUVqh9lHjfpJuwh/dGI6g6QoOyjBwY08zzfWX0DuCAjVgaMQIDAQAB` | DKIM signing for `d=nexus-chat-world.com` | Published — Resend reports verified |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@nexus-chat-world.com` | DMARC policy and aggregate reports | **Missing — add this** |

Observations from the 2026-10-17 probe: the live `send` MX points at the `eu-west-1` SES feedback endpoint while the Resend domain record advertises the `us-east-1` endpoint (`feedback-smtp.us-east-1.amazonses.com`). Only `resend._domainkey.nexus-chat-world.com` and `_dmarc.nexus-chat-world.com` live on the apex; the apex itself intentionally has no SPF TXT, because only the `send` subdomain carries the envelope sender. DMARC sits outside Resend's verification, so adding it does not change the domain's verified status — it is still required to complete SPF/DKIM/DMARC alignment. Tighten `p=none` to `p=quarantine` and then `p=reject` once the aggregate reports show only your own senders.

## 4. Vercel environment

Set these in **Vercel → Project → Settings → Environment Variables** for Production, Preview, and Development as appropriate:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_SESSION_SECRET` (encrypted server variable — see §6)
- `SUPABASE_DB_URL` (server-only; required by the admin RLS policy refresh endpoint `/api/admin/maintenance` — see §1)

Do not add `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SESSION_SECRET`, `SUPABASE_DB_URL`, or `RESEND_API_KEY` to frontend `VITE_` variables. The database connection string is server-only: the local migration CLI uses it, and the admin RLS policy refresh endpoint (`/api/admin/maintenance`) requires it as a Vercel server variable too. It must never reach the browser bundle. Redeploy after environment changes.

### Browser-visible `VITE_SUPABASE_*` variables

`vite.config.js` injects this set through `define`, so the bundle never depends on which alias the environment happened to define. `src/env.d.ts` types them, and `npm run env:validate` (part of `prebuild`, so it gates `npm run build`) cross-checks them before every build.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Project REST/Auth endpoint, `https://<project-ref>.supabase.co`. The server-side `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` take precedence when set, so the browser always targets the same project as `/api`. |
| `VITE_SUPABASE_ANON_KEY` | yes | Browser-safe public key: the legacy `eyJ...` anon JWT or the current `sb_publishable_...` key. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | alias | The same public key under its newer name. Either one satisfies the client, and the build keeps both in sync. |
| `VITE_SUPABASE_PROJECT_ID` | derived | The project ref. Optional — the build derives it from the URL subdomain when it is unset. |

Validation: `scripts/validate-production-env.js` fails a production build when the URL, project ref and public key disagree, when the URL is not `https://<project-ref>.supabase.co`, or when the public key is a `service_role` / `sb_secret_` key. `scripts/generate-runtime-env.js` merges the environment into `.env.production` (and `.vercel-runtime-env.json`) before that check. `tests/supabaseEnv.test.mjs` locks the contract and fails if a Supabase URL or key is hardcoded in `src/`, `api/` or `server/`.

To configure Production and Preview from GitHub, add `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` (when using a team), `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and `RESEND_FROM` as repository Actions secrets. Then run **Actions → Set up production** and provide the Supabase project URL and anon/publishable key. The workflow creates or updates the corresponding browser and server variables in Vercel, so it can be rerun after an interrupted setup; it requires the server-side email secrets rather than silently skipping them.

The workflow's **Run database schema** option is only for an empty, fresh Supabase project. Leave it unchecked for any existing project; the baseline schema is not a repeatable migration and will fail on objects such as the existing `app_role` type. Use the versioned migration process above for schema updates.

## 5. Verify the flow

1. Register with an email address and an 8-character-minimum password; confirm the six-digit code is delivered by Resend.
2. Verify the code, then sign in; the profile row should be created by the database trigger.
3. Request password recovery; verify the recovery code is delivered by Resend.
4. Verify the code, set a new password, and sign in with it.
5. In Supabase SQL Editor, verify `members.password` is not selected by anon/authenticated roles and that a user can only select their own member row.

## 6. Admin access control

Admin surfaces live behind a small, fixed set of routes and a server-side gate:

| Route | Access | Notes |
| --- | --- | --- |
| `/admin` | Redirect | Sends the visitor to `/admin/dashboard`. |
| `/admin/login` | Public | Dedicated admin sign-in; never wrapped in `AdminGuard`. |
| `/admin/dashboard` | Admin only | Overview plus links to the other admin modules. |
| `/admin/users` | Admin only | Wraps `AdminMemberManager` (role and member administration). |
| `/admin/diagnostics` | Admin only | Runtime/config diagnostics. |

Client-side, every admin route except `/admin/login` renders inside `AdminGuard`, which verifies the signed-in user's role through `has_role` and redirects unauthenticated visitors to `/admin/login` with the original path in `location.state.from`. `public/robots.txt` disallows `/admin` so the paths are not indexed.

Because the browser Supabase client stores its session in `localStorage`, Vercel Edge Middleware cannot read it. The server-side gate therefore uses a second, server-readable credential: a signed HttpOnly cookie.

- `api/admin/session.js` (`POST`) reads the `Authorization: Bearer <access-token>` header, verifies it with `admin.auth.getUser(token)`, checks `has_role` via the service-role key, and — only for admins — sets the `nexus_admin_session` cookie. `DELETE` clears it. It returns `503` when `ADMIN_SESSION_SECRET` or the Supabase server settings are missing.
- `server/adminSession.js` signs the cookie (`${userId}.${expiresAt}` plus an HMAC-SHA256 signature) with Web Crypto so the same module runs in both the Node function and the Edge runtime. The cookie is `HttpOnly; SameSite=Lax; Path=/`, gains `Secure` in production, and expires after 8 hours.
- `middleware.js` (`matcher: ['/admin', '/admin/:path*']`) verifies the cookie for every `/admin*` request except `/admin/login`, redirecting (`307`) to `/admin/login?next=…` when it is absent or invalid. It fails closed: with no `ADMIN_SESSION_SECRET`, all admin paths redirect to the login page.
- The client refreshes the cookie from `AdminGuard` and `Login` via `src/lib/adminSession.js`; `AuthContext.logout()` and the password-reset flow clear it.

Generate `ADMIN_SESSION_SECRET` as 32 random bytes of hex and set it in the gitignored `.env.local` for local development and as a separate Production value in Vercel:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not reuse the local development value in production, and never expose the secret through a `VITE_` variable. `npm run env:validate` warns when it is unset because the gate fails closed, and `npm run vercel:env:sync` pushes it to Vercel as an encrypted Production variable.

## 7. Supabase tooling in the development environment

The Supabase integration here is code and CLI based. **No Supabase editor extension, IDE plugin, or MCP server is installed.** The editor's plugin registry contains only `trae-remote-official:lark`, and the installed extensions are GitLens, Kotlin, IntelliJ keybindings, and `ric-v.postgres-explorer` (a generic Postgres client, not Supabase-specific). Do not assume an editor-side Supabase extension exists, and do not look for one when troubleshooting the integration.

| Component | Version | Location | Notes |
| --- | --- | --- | --- |
| `@supabase/supabase-js` | 2.117.3 | `package.json` (declared `^2.117.3`) | Declares Node `>=22`; resolved against Node v24.19.0 / npm 12.2.0. |
| Supabase CLI | v3.2.0 | `C:\Users\User$\scoop\shims\supabase.exe` | Upgraded from v2.117.0 with `scoop update supabase`; v3.2.0 is the latest stable release (GitHub `releases/latest`, published 2026-11-16, not a prerelease). |
| Supabase agent skill | 0.1.2 | `.agents/skills/supabase/` | Its own `CHANGELOG.md` documents releases through 0.1.9, so this copy lags its changelog. |
| Postgres best-practices skill | — | `.agents/skills/supabase-postgres-best-practices/` | Reference material for the agent; no runtime effect. |

The client's five sub-packages (`auth-js`, `postgrest-js`, `realtime-js`, `storage-js`, `functions-js`) all resolve at the same 2.117.3, so there is no mixed-version hoisting. `src/lib/supabase.js` is the only initializer; it reads `import.meta.env` (see §4) and exports `null` when the URL or key is missing, so the app degrades instead of throwing.

### Configuration settings

- `supabase/config.toml` sets `project_id = "vitmhynebbaiahayylid"` — the live project (`supabase-nexus-world`, org `vercel_icfg_SiOMGrifY49NNtbPGoSpZbhc`, East US (North Virginia)) — and disables JWT verification for the `email-code` and `system-email` functions. The value previously named `woavhlkgylarngqyvphf` ("Nexus Next"), a project that has since been deleted: `woavhlkgylarngqyvphf.supabase.co` no longer resolves in DNS and the ref no longer appears in `supabase projects list`.
- `supabase/.temp/linked-project.json` is the CLI's persisted link and now records the same ref (`{"ref":"vitmhynebbaiahayylid","name":"supabase-nexus-world",...}`), written by `supabase link --project-ref vitmhynebbaiahayylid`.
- The CLI resolves its target ref from `SUPABASE_PROJECT_ID` first, then `supabase/.temp/linked-project.json`, then `supabase/.temp/project-ref`. `.env` exports `SUPABASE_PROJECT_ID="vitmhynebbaiahayylid"` and the CLI loads `.env` files, so all three agree; `supabase functions list` reports `Target: project supabase-nexus-world (vitmhynebbaiahayylid) · production`.
- The live project runs PostgreSQL 17.11.

### Postgres extensions on the live project

`select extname, extversion from pg_extension` returns five:

| Extension | Version | Relevance |
| --- | --- | --- |
| `plpgsql` | 1.0 | Default procedural language; the Auth triggers and RPCs are PL/pgSQL. |
| `pgcrypto` | 1.3 | Supplies `gen_random_uuid()`, which the schema uses as the primary-key default. |
| `uuid-ossp` | 1.1 | Present but not referenced by checked-in SQL. |
| `pg_stat_statements` | 1.11 | Query statistics. |
| `supabase_vault` | 0.3.1 | Supabase secret storage. |

No checked-in SQL runs `create extension`, so the schema relies only on what is already installed. Absent are `pg_graphql`, `pg_net`, `pg_cron`, `pgvector`, and `pgjwt`; do not reference them in SQL, and add the matching `create extension` migration before relying on one.

### Connectivity verification

Verified 2026-11-22 against `https://vitmhynebbaiahayylid.supabase.co` using the `.env.local` values, through the same `createClient` path the app uses:

| Surface | Call | Result |
| --- | --- | --- |
| Data (PostgREST) | `from('members').select('id').limit(1)` | ok — 0 rows |
| Auth | `auth.getSession()` | ok — `session: null` (anonymous, as expected) |
| Storage | `storage.listBuckets()` | ok — 0 buckets visible to `anon`; the app uses scoped upload tokens, not bucket listing |
| Realtime | `channel(...).subscribe()` | `SUBSCRIBED` |
| Pooler, session (5432) | `pg` client over `SUPABASE_DB_URL` | connects as `postgres` |
| Pooler, transaction (6543) | `pg` client over `SUPABASE_POOLER_URL` | connects as `postgres` |

With `pg` v8, the pooler URL's `?sslmode=require` is treated as `verify-full`, which fails against Supavisor's certificate chain (`SELF_SIGNED_CERT_IN_CHAIN`). Pass TLS options explicitly (`ssl: { rejectUnauthorized: false }`, or `uselibpqcompat=true&sslmode=require`) instead of relying on `sslmode=require` alone.

### Post-installation setup

1. `npm ci` — `@supabase/supabase-js` installs as a normal dependency; nothing platform-specific to build.
2. Populate `.env.local` from `.env.example`: the browser pair from §4, plus `SUPABASE_DB_URL` from §1. `tests/supabaseEnv.test.mjs` fails the build if a project URL or key is hardcoded under `src/`, `api/`, or `server/`.
3. Run `npm run env:validate` to cross-check the URL, project ref, and public key before a production build.
4. Nothing else to enable: there is no editor extension, plugin, or MCP registration step for this integration.

### Configuration changes applied 2026-11-22

| File | Change | Why |
| --- | --- | --- |
| `supabase/config.toml` | `project_id` `woavhlkgylarngqyvphf` → `vitmhynebbaiahayylid` | The old ref belonged to a deleted project; the CLI was configured against a project that no longer exists. |
| `supabase/.temp/linked-project.json` | `ref`/`name`/organization rewritten to `vitmhynebbaiahayylid` / `supabase-nexus-world` / `vercel_icfg_SiOMGrifY49NNtbPGoSpZbhc` | `supabase link --project-ref vitmhynebbaiahayylid` refreshed the CLI's persisted link. |
| `.env.local` | `X-API-Key=…` commented out (value kept verbatim) | Supabase CLI 3.2 parses `.env.local` itself and only accepts `[A-Za-z0-9_.]` in variable names. The hyphen made **every** `supabase` command abort with `failed to parse environment file: .env.local`, including `supabase login`. Nothing in this repository reads the key, so it is parked rather than deleted; rename it with underscores to re-enable. |

`supabase/config.toml` and `.env` are tracked, so the first two changes are reviewable in git; `.env.local` and `supabase/.temp/` are gitignored local state.

### CLI authentication

- `supabase login` stores its token in the **Windows Credential Manager** under `LegacyGeneric:target=Supabase CLI:supabase` (`cmdkey /list`), not in `~/.supabase/access-token`. A missing token file therefore does not mean the CLI is unauthenticated — check `supabase whoami` instead.
- Verified 2026-11-22: `supabase whoami` returns user `official.rm.kim@gmail.com` (`b7baa7df-0466-4bee-a9bf-5adc9d3a20ed`).
- `SUPABASE_ACCESS_TOKEN`, when set, takes precedence over the stored login (useful for scoped tokens in CI). For scoped tokens, grant at least `project_admin_read` to `supabase link`, plus `projects_read`/`orgs_read` for the list commands below.
- If the CLI aborts with `PermissionDenied … \.supabase\telemetry.json.tmp.<uuid>` in a sandboxed shell, point it at a writable CLI home with `SUPABASE_HOME` (for example `$env:SUPABASE_HOME="$env:TEMP\supabase-home"`). The credential-manager token is unaffected.

### CLI command verification

Run from the repository root against the corrected, relinked configuration:

| Command | Result |
| --- | --- |
| `supabase --version` | `3.2.0` |
| `supabase projects list` | exit 0 — `vitmhynebbaiahayylid` (`supabase-nexus-world`) marked `●` LINKED; `woavhlkgylarngqyvphf` absent |
| `supabase orgs list` | exit 0 — `vercel_icfg_SiOMGrifY49NNtbPGoSpZbhc` / "Nexus Chat World" |
| `supabase functions list` | exit 0 — targets `supabase-nexus-world (vitmhynebbaiahayylid) · production` |
| `supabase secrets list` | exit 0 — targets the same project |
| `supabase branches list` | exit 0 |
| `supabase migration list --linked` | exit 0 (the flag is deprecated in favor of `--remote` in v4) |
| `supabase link --project-ref vitmhynebbaiahayylid` | "Finished supabase link." |
| `supabase status` | exit 1 — **expected**: it is `[local only]` and this machine has no Docker/Podman. Not a configuration or authentication failure. |
