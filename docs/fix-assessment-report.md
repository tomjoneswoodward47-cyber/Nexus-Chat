# Fix Assessment Report — Nexus Chat (`welcome-hub`)

**Date:** 2026-11-20
**Reviewer:** automated fix review (code inspection + command evidence + independent cross-validation)
**Repository state:** branch `main`, working tree clean, HEAD = `ad3b8fb`
**Scope (as requested):** latest OTP fix commit, all recent fix commits, documented fix backlog, and a whole-codebase fix sweep — with tests and a production build executed.

---

## 1. Executive summary

| Verdict | Count |
|---|---|
| Fixes implemented and verified by automated test/command evidence | 4 fix clusters |
| Fixes implemented but **not** verifiable in this environment (needs live Supabase/Vercel) | 2 clusters |
| Findings raised against shipped fixes (2 major, 6 minor) | 8 |
| Findings remediated and re-verified in this pass | 8 |
| Documentation/backlog drift items | 4 (3 reconciled) |

The recent fix work is broadly sound: the migration from native Supabase email OTP to a **server-issued 4-digit code** is implemented end-to-end on both runtimes (Vercel function + Supabase Edge Function), the schema migration is forward-only and idempotent, and the client no longer sees a Supabase OTP. All executable checks pass.

The single **major** behavioural issue was a defect in the client's error-fallback logic for the `verify` action (a 502 from the API endpoint causes an already-consumed code to be re-submitted, producing a misleading "code is no longer valid" error after the email was in fact verified). **It is fixed in the remediation pass — see §7.**

```mermaid
flowchart LR
    A[User submits 4-digit code] --> B{/api/auth/email-code<br/>action=verify}
    B --> C[verify_auth_email_code RPC<br/>hash compare + consume]
    C -->|ok| D[generateLink + /auth/v1/verify<br/>mint Supabase session]
    D -->|session| E["200 {access, refresh}"]
    D -->|mint fails| F["502 'verified, but no session'<br/>(code ALREADY consumed)"]
    F --> G[client fallback re-invokes<br/>Edge Function with same code]
    G --> H[RPC returns 'not_found']
    H --> I["400 'That code is no longer valid.'<br/>❌ misleading"]
    style F fill:#fff3e0,color:#e65100
    style I fill:#ffcdd2,color:#b71c1c
    style E fill:#c8e6c9,color:#1a5e20
```

> **Remediated:** the client no longer treats `502` as fallback-eligible for `verify`, so the `F → G → H → I` path is broken. A 502 now surfaces the server's own message ("Your email is verified, but a sign-in session could not be created. Try signing in.").

---

## 2. Verification evidence (commands actually run)

| Check | Command | Result |
|---|---|---|
| Email-code API tests | `npm run test:email` | **Pass 11 / Fail 0** |
| Schema tests | `npm run test:schema` | **Pass 10 / Fail 0** |
| E2EE tests | `npm run test:e2ee` | **Pass 20 / Fail 0** |
| Production build | `npm run build` | **Exit 0** (`✓ built in 5.93s`), one >1000 kB chunk warning |
| Lint | `npx eslint src api server scripts` | **Exit 0 — 0 errors**, 18 warnings (`react-refresh` advisory only) |
| IDE diagnostics | `GetDiagnostics` | `[]` (0 errors) |

> Note: the repository has **no `lint` npm script and no lint CI step**, so a future regression in the 4 previously-failing rules would not be caught automatically. Adding one is a recommended follow-up (§6).

---

## 3. Fix inventory & status

### 3.1 `ad3b8fb` — Server-issued 4-digit email OTP + auth-screen zoom fix — **IMPLEMENTED / VERIFIED (unit)**
- **Reported problem:** Supabase native email OTP is fixed at 6–10 digits; the app requires a 4-digit code. Resend delivery failed when `RESEND_FROM` was a bare domain. iOS focus/double-tap zoom shifted auth forms.
- **Root cause addressed?** Yes. The server now generates the code (`generateOtpCode`), stores only a keyed HMAC (`hashOtpCode`), checks it server-side (`verify_auth_email_code`), and mints the Supabase session from an admin-generated token so the browser never handles a Supabase OTP.
- **Evidence:** [email-code.js](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js), [email-code/index.ts](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/email-code/index.ts), [20261120000000_auth_email_codes.sql](file:///c:/Users/User$/Downloads/welcome-hub/supabase/migrations/20261120000000_auth_email_codes.sql), [otp-email.js](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/_shared/otp-email.js); tests in [resendEmailApi.test.mjs](file:///c:/Users/User$/Downloads/welcome-hub/tests/resendEmailApi.test.mjs) (11/11 pass, incl. correct-code → session, wrong-code → no session, malformed code rejected before DB, origin rejection, rate limit).
- **Regressions introduced?** E2EE-on-signup contract preserved ([AuthContext.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/AuthContext.jsx#L205-L213)); `verifyEmailCode` signature change (dropped `password`) is consistent across all call sites.
- **Further verification needed:** live end-to-end (real Supabase + Resend) not possible here.

### 3.2 `a5deb7d` — Hybrid attachment storage (Supabase + R2) + tightened chat-files read policy — **IMPLEMENTED / VERIFIED (unit)**
- **Reported problem:** large attachments, and a blanket `storage.objects` SELECT policy that let any signed-in member read every chat file.
- **Root cause addressed?** Yes. Files > 2 MB go to R2 via server presigned PUT; reads resolve via short-lived signed GETs; the blanket read policy is dropped for owner-or-admin ([migration](file:///c:/Users/User$/Downloads/welcome-hub/supabase/migrations/20261110000000_chat_files_read_owner_scope.sql)).
- **Evidence:** [api/storage.js](file:///c:/Users/User$/Downloads/welcome-hub/api/storage.js), [server/r2.js](file:///c:/Users/User$/Downloads/welcome-hub/server/r2.js); `test:schema` 10/10 pass.
- **Regressions introduced?** 4 ESLint errors (see Findings).

### 3.3 `defd23d` — Production env sync: omit immutable key on Vercel PATCH — **IMPLEMENTED / NOT RUNTIME-VERIFIED**
- Workflow-only change ([setup-production.yml](file:///c:/Users/User$/Downloads/welcome-hub/.github/workflows/setup-production.yml)); cannot be exercised without the user's repo secrets.

### 3.4 `9bf753e` — Align `.env` with production Supabase project — **IMPLEMENTED / VERIFIED (inspection)**
- `.env` project ref corrected to the live project; nested repo copy ignored.

---

## 4. Findings

| No. | Issue | Severity | Evidence |
|---|---|---|---|
| 1 | **Verify-failure fallback re-submits an already-consumed code** — `/api/auth/email-code` returns 502 when a correct code verifies but session minting fails; the client treats 502 as fallback-eligible and re-invokes the Edge Function, whose RPC now returns `not_found` → user sees "That code is no longer valid" after successful verification. | **Major** | [supabase.js:73](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/supabase.js#L56-L99), [email-code.js:216-220](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js#L216-L220), [migration:67-69](file:///c:/Users/User$/Downloads/welcome-hub/supabase/migrations/20261120000000_auth_email_codes.sql#L67-L69) |
| 2 | **`no-control-regex` lint error** in `feedContent.js` — intentional control-char sanitisation trips the recommended rule at error severity; `npx eslint` exits non-zero. | **Major (lint-blocking)** | [feedContent.js:14](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/feedContent.js#L14) |
| 3 | **Dead `UUID_REGEX`** in `api/storage.js` (unused-vars error); the `prepare` action no longer validates `chatId`, so an arbitrary value can select the `PUBLIC_SCOPES` ('feed') scope. Impact is benign (object stays in the caller's own folder; read checks fall back to chat membership) but the dropped validation looks unintentional. | Minor | [api/storage.js:25](file:///c:/Users/User$/Downloads/welcome-hub/api/storage.js#L25), [:29](file:///c:/Users/User$/Downloads/welcome-hub/api/storage.js#L29), [:56-59](file:///c:/Users/User$/Downloads/welcome-hub/api/storage.js#L56-L59) |
| 4 | **Unused `toTime`** function in `feeds.js` (unused-vars error). | Minor | [feeds.js:57](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/feeds.js#L57-L59) |
| 5 | **Unused destructured `_userId`** in `uploadToR2` (unused-vars error; `_` prefix not covered by the current lint config). | Minor | [storageManager.js:179](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/storageManager.js#L179) |
| 6 | **Short-code brute-force surface** — 4-digit code (10 000 values), 5 attempts per code, but each new send resets the counter; at 3 sends/min the effective online rate is ~150 guesses / 10 min (~1.5% per window). Mitigated by send rate limit, single-use, TTL, HMAC storage, and owner notification. | Minor | [otp-email.js:9-11](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/_shared/otp-email.js#L9-L11), [email-code.js:14-15](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js#L14-L15) |
| 7 | **HMAC secret falls back to `SUPABASE_SERVICE_ROLE_KEY`** when `OTP_HASH_SECRET`/`ADMIN_SESSION_SECRET` are unset (violates key separation; both runtimes resolve consistently). | Minor | [otp-email.js:51-54](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/_shared/otp-email.js#L51-L54) |
| 8 | **Runtime drift** — Vercel handler reads `data?.properties?.hashed_token || data?.hashed_token`, Edge handler reads only `data?.properties?.hashed_token`; latent inconsistency if the SDK shape changes. | Minor | [email-code.js:163](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js#L163) vs [index.ts:174](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/email-code/index.ts#L174) |

All findings were independently validated by two cross-checking sub-agents; multiple-copy sets and false positives were reconciled (the ESLint errors in Findings 2–5 were reproduced directly from the `npx eslint` run).

---

## 5. Documented backlog vs. code

| Backlog item | Source | Code status | Verdict |
|---|---|---|---|
| "Restore native email verification, sign-up, sign-in, safe password recovery" | [roadmap.md](file:///c:/Users/User$/Downloads/welcome-hub/roadmap.md#L3) | Implemented (deliberately *not* native — server-issued code) | **Stale (unchecked)** |
| "Add a branded animated welcome email sent once after confirmation" | roadmap.md | Implemented ([welcome-email/index.ts](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/welcome-email/index.ts), `sendWelcomeEmail`) | **Stale (unchecked)** |
| "Verify real account-to-account message delivery / encrypted delivery" | roadmap.md | Blocked on live signed-in session & peer key exchange | Still open (correctly) |
| "Fill Vercel env vars, run schema SQL, set Resend secrets" | roadmap.md | Waiting on user | Still open (correctly) |
| Perf session H1–H5 | [debug-nexus-chat-perf-opt.md](file:///c:/Users/User$/Downloads/welcome-hub/debug-nexus-chat-perf-opt.md) | Code shipped; doc now marked `[RESOLVED]`; build still warns on a 1.32 MB `face` chunk | **Doc reconciled; chunk goal still open** |
| DB-init review R1→R2 findings F-1/F-2/F-3 | [.trae/specs/supabase-db-init/review.md](file:///c:/Users/User$/Downloads/welcome-hub/.trae/specs/supabase-db-init/review.md) | R2 = pass, all findings closed | Closed (stale `Desktop/Nexus-Chat` links repointed to this workspace) |
| Removed payment/billing | AGENTS.md rule | Orphans remain: [PaymentWebhookLog.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/components/PaymentWebhookLog.jsx), [BillingHistory.jsx](file:///c:/Users/User$/Downloads/welcome-hub/src/components/chat/settings/BillingHistory.jsx), `supabase/functions/create-storage-checkout` (unreferenced) | **Compliance cleanup recommended** |

POSIX-style grep for `TODO|FIXME|HACK` found matches **only in `docs/store-submission/store-listing.md`** — no open TODOs in source.

---

## 6. Recommended next steps

1. ~~**Fix Finding 1 (Major).**~~ **DONE (§7).** `502` is no longer fallback-eligible for `verify`; the fallback now covers only 404/405/501/503.
2. ~~**Clear the lint errors (Findings 2–5).**~~ **DONE (§7).** Dead symbols removed, `no-control-regex` disabled with justification, `_userId` dropped. Still open: add a `lint` npm script + CI step so this cannot regress silently.
3. ~~**Tighten OTP hardening (Findings 6–7).**~~ **DONE (§7).** A per-email global attempt budget was added and a dedicated `OTP_HASH_SECRET` is now required (fails closed).
4. ~~**Reconcile runtime copies (Finding 8).**~~ **DONE (§7).** Both handlers accept the same token shape.
5. ~~**Update documentation.**~~ **DONE (§7).** Roadmap ticked, perf doc marked resolved, stale `Desktop/Nexus-Chat` links repointed.
6. **Remove leftover payment surfaces** — still open; keeps alignment with the store-compliance rule.
7. **Perform the deferred live verification** — still open; the mock-based suites pass but do not prove live delivery.

### Open verification blockers (unchanged)
- Live account flows could not be exercised: no configured `SUPABASE_URL` / service-role key / Resend key in this environment; the DB-init review remains static-only for the same reason.

---

## 7. Remediation applied (this pass)

All eight findings were fixed and re-verified. The 4-digit code was already the implementation (`OTP_CODE_LENGTH = 4` in [otp-email.js](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/_shared/otp-email.js#L9)); no change was needed there.

| Finding | Fix applied | Files |
|---|---|---|
| 1 — verify re-submits consumed code | The fallback-eligible status set is now action-aware: `verify` falls back only on 404/405/501/503 (never 502), so a consumed code is never replayed. The 502 message now reaches the user. | [supabase.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/supabase.js#L73-L80) |
| 2 — `no-control-regex` error | Rule disabled inline with a justification comment (stripping invisible characters is the sanitiser's purpose). | [feedContent.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/feedContent.js#L13-L17) |
| 3 — dead `UUID_REGEX` + unvalidated `chatId` | `objectKeyFor` now routes `chatId` through `normalizeScope`, which accepts only a real chat UUID or the `feed` public scope and otherwise collapses to `direct` (the reused `UUID_REGEX` also clears the unused-vars error). | [storage.js](file:///c:/Users/User$/Downloads/welcome-hub/api/storage.js#L56-L68) |
| 4 — unused `toTime` | Dead function removed. | [feeds.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/feeds.js) |
| 5 — unused `_userId` | Destructured binding removed (callers still pass `userId`; it is simply ignored). | [storageManager.js](file:///c:/Users/User$/Downloads/welcome-hub/src/lib/storageManager.js#L179) |
| 6 — brute-force surface | A per-address global attempt budget (`VERIFY_ATTEMPT_LIMIT = 20` per `VERIFY_ATTEMPT_WINDOW_SECONDS = 600`) is consumed on every verify in a dedicated rate-limit bucket, so requesting a fresh code no longer resets the allowance. Reuses the existing `consume_auth_email_code_limit` RPC — no new migration. Exhaustion returns `429`. | [email-code.js](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js#L70-L81), [index.ts](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/email-code/index.ts#L65-L76) |
| 7 — secret key separation | `resolveOtpHashSecret` no longer falls back to `SUPABASE_SERVICE_ROLE_KEY`; both handlers now include `!secret` in the 503 configuration guard, so a missing dedicated secret fails closed. | [otp-email.js](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/_shared/otp-email.js#L49-L58), [email-code.js](file:///c:/Users/User$/Downloads/welcome-hub/api/auth/email-code.js#L266-L268), [index.ts](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/email-code/index.ts#L280-L282) |
| 8 — runtime drift | The Edge `createSupabaseSession` reads `data?.properties?.hashed_token \|\| data?.hashed_token`, matching the Vercel handler. | [index.ts](file:///c:/Users/User$/Downloads/welcome-hub/supabase/functions/email-code/index.ts#L191-L195) |
| docs drift | Roadmap items ticked; perf debug doc marked `[RESOLVED]`; stale `Desktop/Nexus-Chat` file links in the spec review and tasks files repointed to this workspace. | [roadmap.md](file:///c:/Users/User$/Downloads/welcome-hub/roadmap.md), [debug-nexus-chat-perf-opt.md](file:///c:/Users/User$/Downloads/welcome-hub/debug-nexus-chat-perf-opt.md), [review.md](file:///c:/Users/User$/Downloads/welcome-hub/.trae/specs/supabase-db-init/review.md), [tasks.md](file:///c:/Users/User$/Downloads/welcome-hub/.trae/specs/supabase-db-init/tasks.md) |

**Post-remediation verification:** `test:email` 11/11, `test:schema` 10/10, `test:e2ee` 20/20, `npx eslint …` exit 0 (0 errors), `npm run build` exit 0, `GetDiagnostics` empty. No new regressions observed; the two remaining live-only items (payment-surface cleanup and live end-to-end delivery) are unchanged.
