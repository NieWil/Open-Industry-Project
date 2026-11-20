import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleRoomMessage, parseRoomMessage } from './roomOwners.mjs'

const TOKEN = 'o-11111111-2222-3333-4444-555555555555'
const OTHER = 'o-99999999-8888-7777-6666-555555555555'
const writer = { readOnly: false }

function memoryStore() {
  const owners = new Map()
  const closed = new Set()
  return {
    owners,
    closed,
    ownerOf: async (name) => owners.get(name) ?? null,
    setOwner: async (name, hash) => void owners.set(name, hash),
    close: async (name) => void closed.add(name),
  }
}

test('parseRoomMessage: claim, close and spotlight with a token, nothing else', () => {
  assert.deepEqual(parseRoomMessage(`room1|claim|${TOKEN}`), { kind: 'claim', token: TOKEN, client: null })
  assert.deepEqual(parseRoomMessage(`room1|claim|${TOKEN}|12345`), { kind: 'claim', token: TOKEN, client: '12345' })
  assert.equal(parseRoomMessage(`room1|claim|${TOKEN}|abc`), null)
  assert.deepEqual(parseRoomMessage(`room1|spotlight|${TOKEN}|1`), { kind: 'spotlight', token: TOKEN, on: true })
  assert.deepEqual(parseRoomMessage(`room1|spotlight|${TOKEN}|0`), { kind: 'spotlight', token: TOKEN, on: false })
  assert.equal(parseRoomMessage(`room1|spotlight|${TOKEN}`), null)
  assert.deepEqual(parseRoomMessage(`room1|close|${TOKEN}`), { kind: 'close', token: TOKEN })
  assert.equal(parseRoomMessage('room1|close|short'), null)
  assert.equal(parseRoomMessage(`room1|delete|${TOKEN}`), null)
  assert.equal(parseRoomMessage(`room1|close|${TOKEN}|extra`), null)
  assert.equal(parseRoomMessage(`live1|d|x|AA`), null)
})

test('the first claim makes the owner; a claim with another token is told the room is taken', async () => {
  const store = memoryStore()
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer), { reply: 'room1|claim|ok' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer), { reply: 'room1|claim|ok' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${OTHER}`, writer), { reply: 'room1|claim|taken' })
  assert.notEqual(store.owners.get('r-a'), TOKEN, 'only a hash of the token is kept')
  // a claim naming the tab's presence client id says who the owner is; a taken one says nothing
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}|42`, writer), { reply: 'room1|claim|ok', owner: '42' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${OTHER}|43`, writer), { reply: 'room1|claim|taken' })
})

test('only the owner turns the spotlight on or off', async () => {
  const store = memoryStore()
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|spotlight|${TOKEN}|1`, writer), { reply: 'room1|spotlight|refused' })
  await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer)
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|spotlight|${OTHER}|1`, writer), { reply: 'room1|spotlight|refused' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|spotlight|${TOKEN}|1`, writer), { reply: 'room1|spotlight|ok', spotlight: true })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|spotlight|${TOKEN}|0`, writer), { reply: 'room1|spotlight|ok', spotlight: false })
  await assert.rejects(handleRoomMessage(store, 'r-a', `room1|spotlight|${TOKEN}|1`, { readOnly: true }))
})

test('only the owner closes the room; an editor, or anyone in an unowned room, is refused', async () => {
  const store = memoryStore()
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, writer), { reply: 'room1|close|refused' })
  await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer)
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${OTHER}`, writer), { reply: 'room1|close|refused' })
  assert.equal(store.closed.size, 0)
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, writer), { reply: 'room1|close|ok', close: true })
  assert.ok(store.closed.has('r-a'))
})

test('a view-only connection can neither claim nor close', async () => {
  const store = memoryStore()
  await assert.rejects(handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, { readOnly: true }))
  await assert.rejects(handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, { readOnly: true }))
  await assert.rejects(handleRoomMessage(store, 'r-a', 'room1|nonsense', writer))
})
