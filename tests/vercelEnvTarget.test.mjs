import test from 'node:test'
import assert from 'node:assert/strict'
import { getTargetMatch, validatePreviewSupabaseTarget } from '../scripts/sync-vercel-env.js'

test('Preview lookup never selects a Production-only variable', () => {
  const envs = [
    { id: 'prod-id', key: 'SUPABASE_URL', target: ['production'] },
    { id: 'preview-id', key: 'SUPABASE_URL', target: ['preview'] },
  ]
  assert.equal(getTargetMatch(envs, 'SUPABASE_URL', 'preview').id, 'preview-id')
  assert.equal(getTargetMatch(envs, 'SUPABASE_URL', 'production').id, 'prod-id')
})

test('shared target variables fail closed rather than modifying Production', () => {
  assert.throws(() => getTargetMatch([
    { id: 'shared-id', key: 'SUPABASE_URL', target: ['preview', 'production'] },
  ], 'SUPABASE_URL', 'preview'), /shared with other Vercel targets/)
})

test('Preview sync requires browser and server URLs to match the staging DB project', () => {
  const values = {
    SUPABASE_URL: 'https://stagingref.supabase.co',
    VITE_SUPABASE_URL: 'https://stagingref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'opaque-key',
  }
  validatePreviewSupabaseTarget(
    values,
    'postgres://postgres:test-only@db.stagingref.supabase.co:5432/postgres?sslmode=require',
  )

  assert.throws(() => validatePreviewSupabaseTarget(
    { ...values, VITE_SUPABASE_URL: 'https://productionref.supabase.co' },
    'postgres://postgres:test-only@db.stagingref.supabase.co:5432/postgres',
  ), /do not all identify/)
})
