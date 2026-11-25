import test from 'node:test'
import assert from 'node:assert/strict'
import { getVisibleSyncKeys } from '../src/lib/syncStatus.js'

test('message fetch and realtime sync keys stay invisible while syncing', () => {
  assert.deepEqual(getVisibleSyncKeys(['chat', 'chats', 'realtime']), [])
})

test('non-message sync activity remains visible', () => {
  assert.deepEqual(getVisibleSyncKeys(['chat', 'contacts', 'realtime']), ['contacts'])
})
