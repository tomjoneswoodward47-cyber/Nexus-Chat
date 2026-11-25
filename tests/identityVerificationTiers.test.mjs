import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20261017030000_identity_verification_tiers.sql', import.meta.url),
  'utf8',
)
const schema = fs.readFileSync(new URL('../docs/supabase-schema.sql', import.meta.url), 'utf8')

// Extract the last definition of a function body (later blocks override earlier).
function functionBody(sql, marker) {
  const start = sql.lastIndexOf(`function ${marker}`)
  if (start === -1) return ''
  const end = sql.indexOf('$$;', start)
  return end === -1 ? sql.slice(start) : sql.slice(start, end)
}

test('the canonical schema mirrors the identity verification tiers migration', () => {
  assert.match(schema, /-- 20261017030000_identity_verification_tiers\.sql/)
  assert.match(schema, /Client-trusted instant approval is intentionally not provisioned/)
})

test('identity verification carries the structured manual-submission fields', () => {
  for (const sql of [migration, schema]) {
    assert.match(sql, /add column if not exists tier text/)
    assert.match(sql, /add column if not exists full_legal_name text/)
    assert.match(sql, /add column if not exists date_of_birth date/)
    assert.match(sql, /add column if not exists document_type text/)
    assert.match(sql, /add column if not exists document_number text/)
    assert.match(sql, /add column if not exists issuing_country text/)
    assert.match(sql, /id_document_path drop not null/)
    assert.match(sql, /check \(tier in \('instant', 'manual'\)\)/)
  }
})

test('client-trusted instant self-approval is retired', () => {
  const retirement = fs.readFileSync(
    new URL('../supabase/migrations/20261123140000_retire_client_identity_approval.sql', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(schema, /submit_instant_identity_verification|approve_identity_from_kyc/)
  assert.match(retirement, /drop function if exists public\.submit_instant_identity_verification/)
  assert.match(retirement, /drop function if exists public\.approve_identity_from_kyc/)
  assert.match(retirement, /grant select on public\.kyc_sessions to authenticated/)
  assert.doesNotMatch(retirement, /grant (all|select, insert, update) on public\.kyc_sessions to authenticated/)
})

test('both identity tiers resolve to the same approved badge level', () => {
  const badge = functionBody(schema, 'private.get_verification_badge(_user_id')
  // The badge is decided by approval status only, so instant and manual rows
  // both surface 'authenticated'; the tier is not used to vary the badge.
  assert.match(badge, /identity_verifications where user_id = _user_id and status = 'approved'/)
  assert.doesNotMatch(badge, /tier/)
})
