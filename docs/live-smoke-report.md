# Live smoke test — Nexus Chat

**Run at:** 2026-11-24T23:43:55.072Z
**App origin:** https://www.nexus-chat-world.com
**Supabase project:** https://vitmhynebbaiahayylid.supabase.co
**Code source:** auth_email_codes store (mailbox-free)

**Result:** 2 failed · 24 passed · 0 skipped

| Status | Check | Detail |
| --- | --- | --- |
| PASS | Signup accepted | POST action=signup -> 200 |
| PASS | Signup created an account | member cb33c499… provisioned |
| PASS | Wrong code rejected | POST action=verify -> 400 invalid_code |
| PASS | Valid code accepted once | POST action=verify -> 200 (session issued) |
| PASS | Reused code rejected | POST action=verify -> 400 invalid_code |
| PASS | Session survives reload | getUser -> cb33c499… |
| PASS | Sign out clears the session | getSession -> null |
| PASS | Recovery code requested | POST action=recovery -> 200 |
| PASS | Recovery code accepted | POST action=verify -> 200 (session issued) |
| PASS | Password updated | updateUser -> 200 |
| PASS | New password signs in | signInWithPassword -> 200 |
| FAIL | Account deleted | POST /functions/v1/delete-account -> 404  |
| FAIL | Deleted account is gone | the auth record still resolves after deletion |
| PASS | Both accounts publish keys | publish_e2ee_public_key -> 200 x2 |
| PASS | Encrypted chat created | chat 9c4e257f… with two members |
| PASS | Peer keys resolved | list_chat_public_keys returned the other participant key |
| PASS | Encrypted text sent | message 57d641d2… stored as ciphertext |
| PASS | Encrypted reply sent | message a090389c… stored as ciphertext |
| PASS | Reaction sent | reaction on 57d641d2… |
| PASS | Attachment sent | object 225d6025… attached |
| PASS | Peer decrypts text and reply | both ciphertexts resolved to their plaintext on the peer device |
| PASS | Peer sees the reaction | reaction on 57d641d2… |
| PASS | Peer sees the attachment | file message present with its reference |
| PASS | Non-member cannot read messages | select -> 0 rows |
| PASS | Non-member cannot read peer keys | list_chat_public_keys -> 0 rows |
| PASS | Non-member cannot read the chat file | download -> blocked |

This run writes rows, uploads one object and sends real email codes, which
it reads back from the configured code source. Only provider status codes are
recorded — never codes,
tokens, passwords or full account ids. Accounts and objects created by the
run are removed before it exits. A SKIP means a required input was missing.
