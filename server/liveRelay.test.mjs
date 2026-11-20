import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ASK_EVERY_MS, FRESH_MS, LiveRelay, MAX_BACKLOG_CHARS, REBASE_BACKLOG_CHARS, parseLive } from './liveRelay.mjs'

const runner = { readOnly: false, key: 'w1' }
const other = { readOnly: false, key: 'w2' }
const viewer = { readOnly: true, key: 'v1' }
const viewer2 = { readOnly: true, key: 'v2' }
const msg = (kind, stream, body = '') => `live2|${kind}|${stream}|${body}`
const sends = (out, key) => out.send?.get(key) ?? []

/** a relay with a runner on stream `a`, and a clock the test moves */
function running() {
  const clock = { t: 0 }
  const r = new LiveRelay(() => clock.t)
  r.handle('room', msg('a', 'a'), runner)
  return { r, clock }
}

test('parseLive: only well-formed live messages from a client', () => {
  assert.deepEqual(parseLive(msg('d', 'abc-1', 'AAAA')), { kind: 'd', stream: 'abc-1', bodyChars: 4 })
  for (const k of ['a', 's', 'e', 'f', 'u', 'r']) assert.ok(parseLive(msg(k, 'x')))
  // the server's own kinds are not a client's to send
  for (const k of ['w', 'q', 'o']) assert.equal(parseLive(msg(k, 'x')), null)
  assert.equal(parseLive('hello'), null)
  assert.equal(parseLive('live2|d|bad stream|AA'), null)
  assert.equal(parseLive('live2|d'), null)
  assert.equal(parseLive(42), null)
})

test("an old build's messages are ignored, not refused, so its editing keeps working", () => {
  const r = new LiveRelay()
  assert.deepEqual(r.handle('room', 'live1|s|a|SNAP', runner), {})
  assert.deepEqual(r.handle('room', 'live1|r|a|', viewer), {})
})

test('nothing is asked of a runner until someone follows; the first follower gets a snapshot asked for', () => {
  const { r } = running()
  // frames before anyone follows go nowhere and are not kept
  assert.deepEqual(r.handle('room', msg('d', 'a', 'D0'), runner), {})
  const f = r.handle('room', msg('f', 'a'), viewer)
  assert.deepEqual(sends(f, 'w1'), [msg('q', 'a'), msg('w', 'a', '1')])
  assert.equal(f.reply, undefined)
  // the runner sends the frame for anyone already drawing, then the snapshot: the follower waiting gets the snapshot
  assert.deepEqual(sends(r.handle('room', msg('d', 'a', 'D1'), runner), 'v1'), [])
  assert.deepEqual(sends(r.handle('room', msg('s', 'a', 'SNAP'), runner), 'v1'), [msg('s', 'a', 'SNAP')])
  assert.deepEqual(sends(r.handle('room', msg('d', 'a', 'D2'), runner), 'v1'), [msg('d', 'a', 'D2')])
})

test('a run goes only to its followers', () => {
  const { r } = running()
  r.handle('room', msg('a', 'b'), other)
  r.handle('room', msg('f', 'a'), viewer)
  r.handle('room', msg('s', 'a', 'SNAP'), runner)
  r.handle('room', msg('f', 'b'), viewer2)
  r.handle('room', msg('s', 'b', 'SNAPB'), other)
  const out = r.handle('room', msg('d', 'a', 'D'), runner)
  assert.deepEqual([...out.send.keys()], ['v1'])
  assert.deepEqual(sends(r.handle('room', msg('d', 'b', 'DB'), other), 'v2'), [msg('d', 'b', 'DB')])
})

test('a later follower starts from the kept snapshot and the deltas after it, without asking the runner', () => {
  const { r } = running()
  r.handle('room', msg('f', 'a'), viewer)
  r.handle('room', msg('s', 'a', 'SNAP'), runner)
  r.handle('room', msg('d', 'a', 'D1'), runner)
  const f = r.handle('room', msg('f', 'a'), viewer2)
  assert.deepEqual(f.reply, [msg('s', 'a', 'SNAP'), msg('d', 'a', 'D1')])
  assert.deepEqual(sends(f, 'w1'), [msg('w', 'a', '2')])
})

test('a kept snapshot is stale once the runner went quiet, so a returning follower asks again', () => {
  const { r, clock } = running()
  r.handle('room', msg('f', 'a'), viewer)
  r.handle('room', msg('s', 'a', 'SNAP'), runner)
  assert.deepEqual(sends(r.handle('room', msg('u', 'a'), viewer), 'w1'), [msg('w', 'a', '0')])
  clock.t += FRESH_MS + ASK_EVERY_MS + 1
  const f = r.handle('room', msg('f', 'a'), viewer)
  assert.equal(f.reply, undefined)
  assert.deepEqual(sends(f, 'w1'), [msg('q', 'a'), msg('w', 'a', '1')])
})

test('following and unfollowing cannot make a runner upload snapshots faster than the limit', () => {
  const { r, clock } = running()
  let asked = 0
  for (let i = 0; i < 10; i++) {
    clock.t += FRESH_MS + 1
    asked += sends(r.handle('room', msg('f', 'a'), viewer), 'w1').filter((p) => p === msg('q', 'a')).length
    r.handle('room', msg('u', 'a'), viewer)
  }
  assert.ok(asked <= Math.ceil((10 * (FRESH_MS + 1)) / ASK_EVERY_MS) + 1, `asked ${asked} times`)
  // a follower whose request was held back is asked for again with the runner's next frame
  clock.t += ASK_EVERY_MS
  r.handle('room', msg('f', 'a'), viewer2)
  clock.t += ASK_EVERY_MS
  assert.ok(r.handle('room', msg('d', 'a', 'D'), runner).reply?.includes(msg('q', 'a')))
})

test('a growing backlog asks for a fresh snapshot; one past its cap stops serving joiners from it', () => {
  const { r, clock } = running()
  r.handle('room', msg('f', 'a'), viewer)
  r.handle('room', msg('s', 'a', 'SNAP'), runner)
  clock.t += ASK_EVERY_MS
  const big = 'A'.repeat(256 * 1024)
  let asked = false
  for (let i = 0; i * big.length <= REBASE_BACKLOG_CHARS + big.length; i++) asked ||= !!r.handle('room', msg('d', 'a', big), runner).reply?.includes(msg('q', 'a'))
  assert.ok(asked, 'asked for a fresh snapshot')
  for (let i = 0; i * big.length <= MAX_BACKLOG_CHARS; i++) r.handle('room', msg('d', 'a', big), runner)
  const late = r.handle('room', msg('f', 'a'), viewer2)
  assert.equal(late.reply, undefined, 'not served from a backlog past its cap')
})

test('a resync is answered to that follower alone, rate-limited', () => {
  const { r, clock } = running()
  r.handle('room', msg('f', 'a'), viewer)
  r.handle('room', msg('s', 'a', 'SNAP'), runner)
  r.handle('room', msg('d', 'a', 'D1'), runner)
  assert.deepEqual(r.handle('room', msg('r', 'a'), viewer).reply, [msg('s', 'a', 'SNAP'), msg('d', 'a', 'D1')])
  clock.t += 200
  assert.deepEqual(r.handle('room', msg('r', 'a'), viewer), {})
  // someone not following it gets nothing
  clock.t += 2000
  assert.deepEqual(r.handle('room', msg('r', 'a'), viewer2), {})
})

test('a viewer cannot run; following a stream that is not there is told it ended', () => {
  const { r } = running()
  for (const kind of ['a', 's', 'd', 'e']) assert.throws(() => r.handle('room', msg(kind, 'a'), viewer))
  assert.throws(() => r.handle('room', 'anything else', viewer))
  assert.deepEqual(r.handle('room', msg('f', 'gone'), viewer).reply, [msg('e', 'gone')])
  // nor can a writer send another's run
  r.handle('room', msg('f', 'a'), viewer)
  assert.deepEqual(r.handle('room', msg('s', 'a', 'FAKE'), other), {})
  assert.deepEqual(r.handle('room', msg('d', 'a', 'FAKE'), other), {})
})

test("a run's end, a new run and the runner leaving tell its followers", () => {
  const { r } = running()
  r.handle('room', msg('f', 'a'), viewer)
  assert.deepEqual(sends(r.handle('room', msg('e', 'a'), runner), 'v1'), [msg('e', 'a')])
  r.handle('room', msg('a', 'b'), runner)
  r.handle('room', msg('f', 'b'), viewer)
  // announcing another run ends the last one
  assert.deepEqual(sends(r.handle('room', msg('a', 'c'), runner), 'v1'), [msg('e', 'b')])
  r.handle('room', msg('f', 'c'), viewer)
  assert.deepEqual(sends(r.disconnected('room', 'w1'), 'v1'), [msg('e', 'c')])
  // a follower leaving tells the runner
  r.handle('room', msg('a', 'd'), other)
  r.handle('room', msg('f', 'd'), viewer)
  assert.deepEqual(sends(r.disconnected('room', 'v1'), 'w2'), [msg('w', 'd', '0')])
})

test('a snapshot or delta over its size cap is refused', () => {
  const { r } = running()
  assert.throws(() => r.handle('room', msg('s', 'a', 'A'.repeat(8 * 1024 * 1024 + 1)), runner))
  assert.throws(() => r.handle('room', msg('d', 'a', 'A'.repeat(1024 * 1024 + 1)), runner))
})

test('the owner and the spotlight: told to everyone, kept for joiners, and only the owner turns it on', () => {
  const r = new LiveRelay()
  assert.deepEqual(r.joinMessages('room'), [])
  assert.equal(r.setOwner('room', 'w1', 'not-a-number'), null)
  assert.equal(r.setOwner('room', 'w1', '42'), msg('o', '42', '0'))
  assert.equal(r.setSpotlight('room', 'w2', true), null)
  assert.equal(r.setSpotlight('room', 'w1', true), msg('o', '42', '1'))
  assert.deepEqual(r.joinMessages('room'), [msg('o', '42', '1')])
  // the owner's tab reconnecting claims again: the spotlight survives under the same connection only
  assert.equal(r.setOwner('room', 'w1', '42'), msg('o', '42', '1'))
  assert.equal(r.setOwner('room', 'w3', '43'), msg('o', '43', '0'))
  // the owner leaving takes the spotlight with it
  r.setSpotlight('room', 'w3', true)
  assert.equal(r.disconnected('room', 'w3').broadcast, msg('o', '-', '0'))
  assert.deepEqual(r.joinMessages('room'), [])
})
