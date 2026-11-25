# Chat refresh
## Account verification and welcome email
- [x] Email verification, sign-up, sign-in, and safe password recovery (server-issued 4-digit code + server-minted Supabase session, deliberately not native Supabase OTP).
- [x] Branded welcome email sent once after email confirmation via Resend (`welcome-email` Edge Function).
- [x] Account flows, live deployment, Resend domain, moderation tables, and server endpoints verified read-only.
- [ ] Complete state-changing live account recovery and two-account chat smoke tests with dedicated accounts.

- [x] Repair message history, realtime cache updates, and sending errors; reject non-shareable attachments.
- [x] Add reaction event persistence, replies, copy, and conversation search.
- [x] Restore chat styling, transitions, and mobile chat access.
- [x] Run focused tests, lint, preview build checks, and isolated browser interaction/persistence checks.
- [ ] Verify real account-to-account message delivery and reactions with two live signed-in accounts.
- [x] Enable file and voice delivery via Supabase Storage (chat-files bucket, storage_files tracking).
- [x] Verify peer public-key exchange and reject unsafe self-key fallback; live cross-device delivery remains a separate smoke test.

# Spec: attachments, identity, sessions, sync
- [x] 5GB per-user storage quota with real-time upload validation (45s video cap, format checks, quota blocking).
- [x] Settings → Storage section: usage metrics, per-type breakdown, individual/bulk delete with instant stats refresh.
- [x] Persistent sessions (Supabase persistSession + autoRefreshToken) and logout only in Settings and header profile dropdown.
- [x] Contacts synced to Supabase per user with realtime updates across devices.
- [x] Removed paid storage upgrades and all payment processing; storage is a single fixed 5GB quota with no purchasable tiers.
- [x] Facial ID verification (on-device face match) + blue/gold badges + admin review RPC; apply new schema SQL to production.
- [x] Blink/movement liveness check, capture-resolution request, quality hints, and real-camera test procedure.
- [ ] Execute the physical-device selfie matrix and record PASS/FAIL device evidence.

# Backend credentials
- [x] Use own Supabase; strip Appwrite; schema SQL + admin bootstrap; build needs only Supabase keys
- [x] Live production verification confirms Supabase, Resend, moderation, and deployed endpoint configuration.
- [x] Admin diagnostics page (/admin/diagnostics)
- [x] Production setup workflow remains operator-triggered and secret-gated.

# GitHub sync
- [x] Project is connected to `elonmuskite-sudo/welcome-hub` on branch `main`.

# Quality and performance
- [x] ESLint and React Hook validation pass with zero warnings.
- [x] 328 Node tests pass.
- [x] Production build passes.
- [x] Emoji and face assets are split into independent feature chunks.
