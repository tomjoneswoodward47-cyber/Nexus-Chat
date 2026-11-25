# Next Issue Priority

**Review date:** 2026-11-23
**Repository:** `elonmuskite-sudo/welcome-hub`
**Branch:** `main` at `c98a75f`
**Working tree:** package and schema cleanup in progress
**Scope:** git history, in-repo issue tracking, Node tests, ESLint, project-rule lint, and code/schema inspection

GitHub issue lookup was not available: `gh` is not installed in this environment. Tracking used for this review is `roadmap.md`, `docs/fix-assessment-report.md`, `docs/camera-device-test-report.md`, `docs/identity-verification-validation.md`, `docs/workflow-sessions.md`, and this file.

## Baseline that is currently healthy

| Check | Result |
| --- | --- |
| `node --test tests/*.test.mjs` | **358 passed, 0 failed** (re-run 2026-11-23) |
| `npx eslint . --max-warnings 0` | **Passed, 0 warnings** |
| `node scripts/check-project-rules.mjs` | **All four AGENTS.md rules pass** |
| Payments, UGC report/block, Supabase auth default, service-role client proxy | **Pass** |

`roadmap.md` still says 328 tests. The 2026-11-23 camera report says 333. Both counts are behind the suite run for this review. Bare `node --test` still discovers root `test-npm.js`, which is CommonJS and fails discovery before the real suite runs.

Items closed since the 2026-11-22 ranking: React Hook dependency warnings, Fast Refresh mixed exports, emoji/face chunks on the initial route, and leftover payment surfaces. The face-detection chunk remains about 1.3 MB and is loaded only when identity verification runs. That size is accepted until a smaller detector is chosen. Workflow-session unit tests and the documented staging lifecycle checks are in place; they are not production-user defects.

## Priority ranking

### 1. Stop client-trusted instant identity approval

- **Severity:** Critical
- **User impact:** A signed-in member can receive the verified badge without a reviewed document. If the later KYC migration is applied as written, the same button fails because the approval function is removed and no replacement client exists.
- **Problem:** `VerificationSettings.submitInstant` detects a face in the browser and calls `submit_instant_identity_verification` with that score. The same score is accepted by `server/appwriteGateway.js` action `verification.instant`, which runs `SET LOCAL ROLE authenticated` as the caller and invokes the same function. The function, still defined in `docs/supabase-schema.sql` and `supabase/migrations/20261017030000_identity_verification_tiers.sql`, inserts the caller’s row as `approved`. Direct table policies do not allow a member to set `status = 'approved'`; the security-definer function is the hole. Production setup applies `docs/supabase-schema.sql` (`.github/workflows/setup-production.yml`). `tests/identityVerificationTiers.test.mjs` requires this function to stay. A later migration, `20261108090000_gate_instant_kyc_approval.sql`, drops it and approves only from `kyc_sessions.status = 'APPROVED'`, but there is no Idswyft webhook or `/api/kyc` in the app. `20261106195234_idswyft_kyc_sessions.sql` also lets the signed-in user insert and update their own session, including `status` and `session_token`, so applying that gate without locking the table would let a later service-role poll trust a forged `APPROVED` row.
- **Recommended fix:**
  1. Choose one authority: admin manual review, or a server-verified provider decision.
  2. Remove browser self-approval from the client, the canonical schema, and the tests.
  3. Do not apply the KYC gate until a server endpoint checks the provider and writes status with the service role.
  4. Change `kyc_sessions` so members can read their own row and cannot set `status`, tokens, or provider result fields.
- **Implementation steps:**
  1. Read the live database for `submit_instant_identity_verification` and `kyc_sessions` before changing production.
  2. Point instant UI at manual review, or at a server route that never accepts a client match score as approval.
  3. Add a forward migration that drops the self-approve function if it is still present, and replace the KYC write policy.
  4. Fold the chosen end state into `docs/supabase-schema.sql` so the production workflow and the migrations agree.
  5. Rewrite `tests/identityVerificationTiers.test.mjs` so it rejects client-supplied approval.
- **Testing requirements:**
  - Authenticated call to the old RPC is rejected or the function is absent.
  - A member cannot update `kyc_sessions.status` to `APPROVED`.
  - Manual submission still creates `pending` and only an admin review flips it to `approved`.
  - Badge RPC stays `authenticated` only for an approved row.
  - Schema test, email tests, and `npm run build`.
- **Expected outcome:** The verified badge is issued only after server-side review or a provider decision the member cannot forge. The instant button either explains the manual path or completes through that server decision.

### 2. Prove live account recovery and two-account encrypted chat

- **Severity:** High
- **User impact:** Sign-up, code delivery, session restore, password reset, account deletion, and message delivery can fail in production while every mock test stays green.
- **Problem:** `roadmap.md` still leaves state-changing account recovery and two live accounts unchecked. `npm run verify:live` is read-only. Peer key lookup is implemented (`publish_e2ee_public_key`, `list_chat_public_keys`); the roadmap line that says exchange is missing is stale. What is unproven is that two real accounts publish keys, exchange text and a file, and that a third account cannot read them. Private keys stay on one device, so a second device on the same account cannot decrypt. That limitation is documented and should be part of the smoke record.
- **Recommended fix:** Add an opt-in live smoke script that uses dedicated accounts and an allowlisted mailbox. Keep it separate from read-only `verify:live`.
- **Implementation steps:**
  1. Register, reject a wrong code, accept a valid code once, reload, sign out, recover the password, and delete the account.
  2. Sign in two accounts, publish keys, send text, a reply, a reaction, and an attachment.
  3. Confirm a non-member cannot read the chat file or plaintext.
  4. Record provider status codes without storing codes, tokens, or passwords.
- **Testing requirements:** Live Supabase, Resend, two browser profiles, cleanup of the test accounts.
- **Expected outcome:** Wrong, reused, and expired codes create no session. A valid code creates one session. Two accounts deliver encrypted text and an authorized file. The smoke log cites redacted session ids only.

### 3. Run the physical camera matrix and correct the safety-number display

- **Severity:** High for camera capture; Medium for the displayed security code
- **User impact:** Feed video, avatar capture, call camera switching, and identity selfies are implemented against mocked tracks. Permission denial, the 45-second cap, torch, focus, and iOS playback are untested on hardware. The Privacy screen tells people to compare a “Security Code” that is a 6-digit reduction of one public key (`generateSecurityCode`), so equal codes do not show that both devices share the same key.
- **Problem:** `docs/camera-device-test-report.md` records Android camera metadata for an Infinix NOTE 50 PRO and marks every app capture scenario NOT RUN. No iPhone session was available. The blink check is documented as a presence hint, not presentation-attack detection. `PrivacySettings.jsx` renders `generateSecurityCode(publicKey)` beside copy that says to compare the code with a contact. The function sums one string (the viewer’s own public key) into six digits. Each person therefore sees a code from a different input, and a match would not show that both devices hold the same key.
- **Recommended fix:**
  1. Execute the 11-step matrix already written in the camera report on the authorized Android device and an iPhone.
  2. Replace the displayed code with a safety number derived from both participants’ public keys, or remove the comparison claim until that exists.
- **Implementation steps:**
  1. Capture grant, deny, front/rear, photo, 5-second and 45-second video, torch/focus where advertised, in-call lens switch, and track stop on close and sign-out.
  2. For identity, record front-lit, dim, backlit, partial face, mask, sunglasses, no face, still photo, and screen replay. Treat replay success as a product limit until a real liveness vendor exists.
  3. Add a unit test that the safety number changes when either peer key changes and collides far less often than a character-sum.
- **Testing requirements:** The device matrix in `docs/camera-device-test-report.md`, plus `npm run test:camera` and a Privacy settings browser check.
- **Expected outcome:** Each device has a pass/fail row with actual resolution and failure text. The settings screen no longer asks users to trust a single-key checksum.

### 4. Make the production schema file match the migrations that are allowed to ship

- **Severity:** Medium
- **User impact:** Operators following the production workflow can miss workflow tables or re-apply an identity function the migrations folder later drops. Fresh databases built by running every migration file reach a different identity schema than databases built from `docs/supabase-schema.sql`.
- **Problem:** The canonical file is what `setup-production.yml` executes. It includes email codes, encrypted-message checks, and owner-scoped chat-file reads. It does not include the KYC gate. Workflow sessions are a comment telling the operator to apply two later files. Staging has applied those two files; production application of the same files is not recorded in this review.
- **Recommended fix:** After issue 1 chooses the identity end state, regenerate or patch `docs/supabase-schema.sql` from the migrations that production is supposed to have, including workflow sessions only if those tables are meant for the production project.
- **Implementation steps:**
  1. Diff migration objects against the canonical file.
  2. Add missing safe objects and remove the client-trusted instant function.
  3. Record which project received which versions.
- **Testing requirements:** `npm run test:schema`, a dry-run of `scripts/setup-supabase.js`, and a read-only object check against the target database.
- **Expected outcome:** One apply path produces the same identity, chat-file, email-code, and workflow objects as the migration set intended for that environment.

### 5. Clear local and tracker drift before the next release

- **Severity:** Low
- **User impact:** None for signed-in users. The dirty `package.json` version `ls` can leak into npm script banners and any release that reads `version`. Stale roadmap counts send the next pass toward work that already landed.
- **Problem:** Uncommitted `package.json` sets `"version": "ls"`. `roadmap.md` says 328 tests and that encrypted delivery is blocked on missing key exchange. `test-npm.js` breaks unqualified `node --test`.
- **Recommended fix:** Restore version `0.0.0` or set a real semver. Update the roadmap counts and the encryption line. Exclude `test-npm.js` from the test runner or move it out of the default discovery path.
- **Implementation steps:** Revert the version hunk, edit the two roadmap lines, and point the documented suite command at `tests/*.test.mjs`.
- **Testing requirements:** `git diff package.json` is empty or intentional; `node --test tests/*.test.mjs` still passes.
- **Expected outcome:** The branch version is valid, and the roadmap matches the 358-test suite and the existing peer-key lookup.

## Suggested execution order

1. Confirm the live identity function, then remove client-trusted approval and lock the KYC table down.
2. Run the opt-in live account and two-account encryption smoke.
3. Record the physical camera matrix and fix the security-code claim.
4. Reconcile `docs/supabase-schema.sql` with the migrations production should actually have.
5. Restore `package.json` version and refresh the roadmap counters.

## Explicitly not next

- ESLint warnings and payment leftovers: cleared; project-rule lint passes.
- Initial-route bundle split: emoji and face code are lazy. Further face-model shrinking is optional.
- Appwrite gateway completion: production default remains `VITE_AUTH_PROVIDER=supabase`. Privileged Appwrite admin and identity actions already fail closed. Finish that gateway only when a provider switch is actually planned.
