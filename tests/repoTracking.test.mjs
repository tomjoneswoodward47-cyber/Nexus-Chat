import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Verifies the version-control fix: the shared HTML bundle under
// .trae-html-share-packages/ is committed while the directory's other exports
// stay ignored, and the credential vault / local env never enter the repository.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRACKED_BUNDLE = '.trae-html-share-packages/index.html.zip'

// `git check-ignore -q` exits 0 when the path is ignored and 1 when it is not.
// Returns null when git is unavailable so the test can skip instead of fail.
function gitIgnored(relPath) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', relPath], { cwd: ROOT, encoding: 'utf8' })
  if (result.error) return null
  return result.status === 0
}

test('the shared HTML bundle is tracked while the other exports stay ignored', (t) => {
  if (gitIgnored(TRACKED_BUNDLE) === null) {
    t.skip('git is not available in this environment')
    return
  }
  assert.ok(fs.existsSync(path.join(ROOT, TRACKED_BUNDLE)), `${TRACKED_BUNDLE} must exist in the working tree`)
  assert.equal(gitIgnored(TRACKED_BUNDLE), false, `${TRACKED_BUNDLE} must not be gitignored`)
  assert.equal(gitIgnored('.trae-html-share-packages/other-export.zip'), true, 'other exports must stay ignored')
})

test('the credential vault and local env stay out of version control', (t) => {
  if (gitIgnored('.env.local') === null) {
    t.skip('git is not available in this environment')
    return
  }
  assert.equal(gitIgnored('.nexus-credentials/rotation-vault.json'), true)
  assert.equal(gitIgnored('.env.local'), true)
})
