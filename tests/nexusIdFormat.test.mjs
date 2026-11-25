import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  NEXUS_ID_PATTERN,
  nexusIdDigits,
  groupNexusIdDigits,
  isCompleteNexusId,
  applyNexusIdFormat,
} from '../src/lib/nexusIdFormat.js'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const contacts = read('../src/components/chat/ContactsPanel.jsx')
const sidebar = read('../src/components/chat/ChatSidebar.jsx')

// Replays a keystroke at the current caret so the tests exercise the same path
// the input handler uses: insert the character, then reformat from that caret.
function type(digits) {
  let state = { value: '', caret: 0 }
  for (const ch of digits) {
    const raw = state.value.slice(0, state.caret) + ch + state.value.slice(state.caret)
    state = applyNexusIdFormat(raw, state.caret + 1)
  }
  return state
}

test('dashes are inserted at the fixed positions while typing the ID', () => {
  const expected = {
    '1': '1',
    '10': '10',
    '101': '10-1',
    '1012': '10-12',
    '10123': '10-123',
    '101234': '10-1234',
    '1012345': '10-1234-5',
    '101234567': '10-1234-567',
    '1012345678': '10-1234-5678',
  }
  for (const [typed, formatted] of Object.entries(expected)) {
    assert.equal(type(typed).value, formatted, `typing ${typed}`)
  }
})

test('a complete ID is always 10-XXXX-XXXX and the caret trails the last digit', () => {
  const result = type('1012345678')
  assert.equal(result.value, '10-1234-5678')
  assert.equal(result.caret, result.value.length)
})

test('mistyped or partial separators are corrected to the standard grouping', () => {
  assert.equal(applyNexusIdFormat('10-12-345678').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('1-0-1-2-3-4-5-6-7-8').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('1012--345678').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('10-1').value, '10-1')
})

test('non-numeric characters are stripped and the value is capped at ten digits', () => {
  assert.equal(applyNexusIdFormat('10abc1234def5678').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('101234567899').value, '10-1234-5678')
  assert.equal(nexusIdDigits('(10) 1234 5678').length, 10)
})

test('pasted values are formatted immediately, with or without separators', () => {
  assert.equal(applyNexusIdFormat('1012345678').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('10-1234-5678').value, '10-1234-5678')
  assert.equal(applyNexusIdFormat('10 1234 5678').value, '10-1234-5678')
  // A paste places the caret at the end of the pasted value.
  const pasted = applyNexusIdFormat('1012345678', 10)
  assert.equal(pasted.value, '10-1234-5678')
  assert.equal(pasted.caret, pasted.value.length)
})

test('the caret stays next to the edited digit during middle-of-value edits', () => {
  // Insert "9" after the third digit of a full ID.
  const inserted = applyNexusIdFormat('10-19234-5678', 5)
  assert.equal(inserted.value, '10-1923-4567')
  assert.equal(inserted.caret, 5)
  assert.equal(inserted.value.slice(0, inserted.caret), '10-19')

  // A caret in the middle of an already-correct value does not move.
  assert.equal(applyNexusIdFormat('10-1234-5678', 4).caret, 4)
})

test('deleting a digit or a separator keeps the value consistent', () => {
  // Backspace the final digit.
  const trimmed = applyNexusIdFormat('10-1234-567', 11)
  assert.equal(trimmed.value, '10-1234-567')

  // Backspacing over a separator restores it instead of leaving a gap.
  const restored = applyNexusIdFormat('101234-5678', 2)
  assert.equal(restored.value, '10-1234-5678')
})

test('partial values keep the separators they have already earned', () => {
  assert.deepEqual(applyNexusIdFormat('10'), { value: '10', caret: 2 })
  assert.deepEqual(applyNexusIdFormat(''), { value: '', caret: 0 })
  assert.equal(groupNexusIdDigits('101234'), '10-1234')
})

test('the submitted value strips separators to the digits-only backend form', () => {
  const formatted = applyNexusIdFormat('10-1234-5678').value
  const submitted = nexusIdDigits(formatted)
  assert.equal(submitted, '1012345678')
  assert.match(submitted, NEXUS_ID_PATTERN)
  assert.equal(isCompleteNexusId(formatted), true)
  assert.equal(isCompleteNexusId('10-1234-567'), false)
  // Unformatted input normalizes to the same submission value.
  assert.equal(nexusIdDigits('1012345678'), submitted)
})

test('both contact input surfaces wire the shared formatter and restore the caret', () => {
  for (const source of [contacts, sidebar]) {
    assert.match(source, /import \{ applyNexusIdFormat \} from '\.\.\/\.\.\/lib\/nexusIdFormat'/)
    assert.match(source, /setSelectionRange\(caret, caret\)/)
  }
  assert.match(contacts, /onChange=\{handleNexusIdChange\}/)
  assert.match(contacts, /ref=\{nexusInputRef\}/)
  assert.match(sidebar, /ref=\{searchInputRef\}/)
  // The chats search must leave a name query untouched.
  assert.match(sidebar, /applyNexusIdFormat\(raw, input\.selectionStart\)/)
})
