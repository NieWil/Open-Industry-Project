import { beforeEach, describe, expect, it } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import {
  PRESENCE_MAX_IDS,
  getCollabSnapshot,
  getPeers,
  initCollabSession,
  peersEditingPart,
  readPeer,
  setLocalDrag,
  setLocalEditingPart,
  setLocalSelection,
  subscribeCollab,
} from './session'
import { caretSafeAwareness } from './stBinding'

/**
 * A minimal stand-in for HocuspocusProvider exposing only what initCollabSession touches: an
 * awareness with a single 'change' subscriber, and setAwarenessField. clientID 1 is "us"; peers
 * use other ids. setPeer/dropPeer mutate the awareness state map and fire the change handler the
 * same way a real provider would when a remote peer updates or disconnects.
 */
function makeFakeProvider() {
  const states = new Map<number, Record<string, unknown>>()
  let changeCb: () => void = () => {}
  const calls: Array<[string, unknown]> = []
  const prov = {
    awareness: {
      clientID: 1,
      getStates: () => states,
      on: (_event: 'change', cb: () => void) => {
        changeCb = cb
      },
    },
    on: (_event: string, _cb: (e: unknown) => void) => {},
    setAwarenessField: (key: string, value: unknown) => {
      calls.push([key, value])
      states.set(1, { ...(states.get(1) ?? {}), [key]: value })
    },
  }
  return {
    prov: prov as unknown as HocuspocusProvider,
    calls,
    fireChange: () => changeCb(),
    /** add/replace a remote peer's awareness state, then notify listeners (as a real provider does) */
    setPeer: (id: number, st: Record<string, unknown>) => {
      states.set(id, st)
      changeCb()
    },
    /** a peer disconnecting drops its awareness state entirely */
    dropPeer: (id: number) => {
      states.delete(id)
      changeCb()
    },
  }
}

// The soft lock is just an ephemeral awareness field: the holder publishes the package it has open,
// and a second opener sees a non-empty peersEditingPart() and starts read-only. These cover the data
// layer (the BehaviorEditor component is thin glue over it; the test env is `node`, no DOM/Monaco).
describe('behavior-editor soft lock (awareness signal)', () => {
  let f: ReturnType<typeof makeFakeProvider>
  beforeEach(() => {
    f = makeFakeProvider()
    initCollabSession('room-1', f.prov)
  })

  it('setLocalEditingPart publishes the held package, and null releases it', () => {
    setLocalEditingPart('pkg_robot')
    expect(f.calls).toContainEqual(['editingPart', 'pkg_robot'])
    setLocalEditingPart(null)
    expect(f.calls.at(-1)).toEqual(['editingPart', null])
  })

  it('reports a peer holding the part (a second opener would open read-only), excluding self', () => {
    // our own claim must not count as a holder in our own view, or we could never edit
    setLocalEditingPart('pkg_robot')
    f.fireChange()
    expect(peersEditingPart('pkg_robot')).toHaveLength(0)
    // a peer opens the same part → there is now a holder
    f.setPeer(2, { user: { name: 'Otter', color: '#fff' }, editingPart: 'pkg_robot' })
    expect(peersEditingPart('pkg_robot').map((p) => p.name)).toEqual(['Otter'])
    // a different part is unaffected
    expect(peersEditingPart('pkg_other')).toHaveLength(0)
  })

  it('releases the lock when the holder switches parts or disconnects (so a waiter auto-claims)', () => {
    f.setPeer(2, { user: { name: 'Otter' }, editingPart: 'pkg_robot' })
    expect(peersEditingPart('pkg_robot')).toHaveLength(1)
    // holder closes the editor / opens another part
    f.setPeer(2, { user: { name: 'Otter' }, editingPart: null })
    expect(peersEditingPart('pkg_robot')).toHaveLength(0)
    // a disconnect (awareness state removed) likewise frees it - the soft-lock's key property
    f.setPeer(2, { user: { name: 'Otter' }, editingPart: 'pkg_robot' })
    expect(peersEditingPart('pkg_robot')).toHaveLength(1)
    f.dropPeer(2)
    expect(peersEditingPart('pkg_robot')).toHaveLength(0)
  })
})

// The toolbar's presence chip reads this snapshot through useSyncExternalStore, so a new object re-renders the
// whole toolbar. Awareness fires on every peer cursor move; only a change to what the chip shows may notify.
describe('collab status snapshot', () => {
  it('notifies on a change in people or who runs, never on a cursor move', () => {
    const f = makeFakeProvider()
    initCollabSession('room-1', f.prov)
    let notified = 0
    const unsub = subscribeCollab(() => notified++)
    try {
      f.setPeer(2, { user: { name: 'Otter' } })
      expect(getCollabSnapshot().peers).toBe(2)
      expect(notified).toBe(1)
      const before = getCollabSnapshot()
      for (let i = 0; i < 20; i++) f.setPeer(2, { user: { name: 'Otter' }, cursor: { x: i, y: 0, z: 0 } })
      expect(notified).toBe(1)
      expect(getCollabSnapshot()).toBe(before)
      f.setPeer(2, { user: { name: 'Otter' }, running: true, stream: 'run-1' })
      expect(getCollabSnapshot().runners).toEqual([{ id: 2, name: 'Otter', stream: 'run-1' }])
      expect(notified).toBe(2)
      // the same runners list rebuilt by a cursor move is the same snapshot
      const running = getCollabSnapshot()
      f.setPeer(2, { user: { name: 'Otter' }, running: true, stream: 'run-1', cursor: { x: 9, y: 0, z: 0 } })
      expect(getCollabSnapshot()).toBe(running)
    } finally {
      unsub()
    }
  })
})

// A peer's awareness state is written by another client (a view link included) and relayed by the
// server unread, so readPeer treats every field as hostile input: the shape this module publishes,
// or the field's "absent" value. The color matters most: it is written into inline styles and an
// SVG fill, where a `url(...)` would make every peer fetch an address of the sender's choosing.
describe('presence from a peer is validated on read', () => {
  it('keeps a well-formed state as published', () => {
    const peer = readPeer(7, {
      user: { name: 'Otter', color: '#3182BD' },
      selection: ['part-1', 'part-2'],
      cursor: { x: 1, y: 0, z: -2.5 },
      drag: [{ id: 'part-1', position: [1, 2, 3], rotationY: 0.5, rotationX: 0.1 }],
      running: true,
      pilot: { x: 1, y: 0, z: 2, yaw: 3.1 },
      editingPart: 'pkg_robot',
      stream: 'abc-123',
      watching: 4,
      view: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 },
    })
    expect(peer).toEqual({
      clientId: 7,
      name: 'Otter',
      color: '#3182BD',
      selection: ['part-1', 'part-2'],
      cursor: { x: 1, y: 0, z: -2.5 },
      drag: [{ id: 'part-1', position: [1, 2, 3], rotationY: 0.5, rotationX: 0.1 }],
      running: true,
      pilot: { x: 1, y: 0, z: 2, yaw: 3.1 },
      editingPart: 'pkg_robot',
      stream: 'abc-123',
      watching: 4,
      view: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0, ortho: false },
    })
  })

  it('accepts only a #rrggbb color', () => {
    for (const bad of [
      'url(https://evil.example/x)',
      'red; background-image: url(https://evil.example/x)',
      'red',
      '#fff',
      '#12345678',
      'rgb(1,2,3)',
      ' #123456',
      42,
      null,
    ]) {
      expect(readPeer(2, { user: { name: 'x', color: bad } }).color).toBe('#888888')
    }
  })

  it('caps the name and falls back to Guest for a missing or non-string one', () => {
    expect(readPeer(2, { user: { name: 'x'.repeat(10_000) } }).name).toHaveLength(40)
    expect(readPeer(2, { user: { name: { toString: 'boom' } } }).name).toBe('Guest')
    expect(readPeer(2, { user: { name: '   ' } }).name).toBe('Guest')
    expect(readPeer(2, { user: 'Otter' }).name).toBe('Guest')
    expect(readPeer(2, null).name).toBe('Guest')
  })

  it('reads a cursor or pilot pose only with finite numeric fields', () => {
    expect(readPeer(2, { cursor: { x: 1, y: NaN, z: 0 } }).cursor).toBeNull()
    expect(readPeer(2, { cursor: { x: '1', y: 0, z: 0 } }).cursor).toBeNull()
    expect(readPeer(2, { cursor: { x: 1, y: 0, z: Infinity } }).cursor).toBeNull()
    expect(readPeer(2, { cursor: [1, 2, 3] }).cursor).toBeNull()
    // the ST editor's text caret shares the `cursor` key; it is not a floor point
    expect(readPeer(2, { cursor: { anchor: {}, head: {} } }).cursor).toBeNull()
    // extra keys are not carried along
    expect(readPeer(2, { cursor: { x: 1, y: 2, z: 3, evil: 'x' } }).cursor).toEqual({ x: 1, y: 2, z: 3 })
    expect(readPeer(2, { pilot: { x: 1, y: 2, z: 3 } }).pilot).toBeNull()
    expect(readPeer(2, { pilot: { x: 1, y: 2, z: 3, yaw: null } }).pilot).toBeNull()
  })

  it('drops a drag stream with any malformed pose, or one past the cap', () => {
    const pose = { id: 'p', position: [0, 0, 0], rotationY: 0 }
    expect(readPeer(2, { drag: [pose, { ...pose, position: [0, 0] }] }).drag).toBeNull()
    expect(readPeer(2, { drag: [pose, { ...pose, rotationY: 'x' }] }).drag).toBeNull()
    expect(readPeer(2, { drag: [pose, { ...pose, rotationZ: NaN }] }).drag).toBeNull()
    expect(readPeer(2, { drag: [pose, { ...pose, id: 5 }] }).drag).toBeNull()
    expect(readPeer(2, { drag: 'nope' }).drag).toBeNull()
    expect(readPeer(2, { drag: Array(PRESENCE_MAX_IDS + 1).fill(pose) }).drag).toBeNull()
    expect(readPeer(2, { drag: Array(PRESENCE_MAX_IDS).fill(pose) }).drag).toHaveLength(PRESENCE_MAX_IDS)
  })

  it('keeps only string ids in a selection, at most PRESENCE_MAX_IDS of them', () => {
    expect(readPeer(2, { selection: ['a', 3, null, { id: 'b' }, 'c', 'x'.repeat(65)] }).selection).toEqual(['a', 'c'])
    expect(readPeer(2, { selection: Array(10_000).fill('a') }).selection).toHaveLength(PRESENCE_MAX_IDS)
    expect(readPeer(2, { selection: 'a' }).selection).toEqual([])
  })

  it('takes running only as true, a stream only as an id, watching only as a client id, and editingPart only as a bounded string', () => {
    expect(readPeer(2, { running: 'yes' }).running).toBe(false)
    expect(readPeer(2, { stream: 'has space' }).stream).toBeNull()
    expect(readPeer(2, { stream: 'x'.repeat(65) }).stream).toBeNull()
    expect(readPeer(2, { watching: true }).watching).toBeNull()
    expect(readPeer(2, { watching: -1 }).watching).toBeNull()
    expect(readPeer(2, { watching: 1.5 }).watching).toBeNull()
    // a camera only with every coordinate finite and within reach of a scene
    expect(readPeer(2, { view: { px: 1, py: 2, pz: 3, tx: 0, ty: 0 } }).view).toBeNull()
    expect(readPeer(2, { view: { px: 1e9, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 } }).view).toBeNull()
    expect(readPeer(2, { view: { px: NaN, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 } }).view).toBeNull()
    expect(readPeer(2, { editingPart: { id: 'pkg' } }).editingPart).toBeNull()
    expect(readPeer(2, { editingPart: 'x'.repeat(300) }).editingPart).toBeNull()
  })

  it('is what getPeers() serves, so no consumer sees the raw state', () => {
    const f = makeFakeProvider()
    initCollabSession('room-1', f.prov)
    f.setPeer(2, { user: { name: 'Otter', color: 'url(https://evil.example/x)' }, cursor: { x: 'a' } })
    const [peer] = getPeers()
    expect(peer?.color).toBe('#888888')
    expect(peer?.cursor).toBeNull()
  })
})

describe('presence this client publishes stays under the server awareness cap', () => {
  let f: ReturnType<typeof makeFakeProvider>
  beforeEach(() => {
    f = makeFakeProvider()
    initCollabSession('room-1', f.prov)
  })

  it('truncates a huge selection and leaves out ids too long to be part ids', () => {
    const ids = Array.from({ length: PRESENCE_MAX_IDS + 100 }, (_, i) => `part-${i}`)
    setLocalSelection(['x'.repeat(65), ...ids])
    const sent = f.calls.at(-1)?.[1] as string[]
    expect(sent).toHaveLength(PRESENCE_MAX_IDS)
    expect(sent[0]).toBe('part-0')
  })

  it('does not stream a drag past the cap, but still ends one with null', () => {
    const pose = { id: 'p', position: [0, 0, 0] as [number, number, number], rotationY: 0 }
    setLocalDrag([pose])
    expect(f.calls.at(-1)).toEqual(['drag', [pose]])
    setLocalDrag(Array(PRESENCE_MAX_IDS + 1).fill(pose))
    expect(f.calls.at(-1)).toEqual(['drag', null])
    setLocalDrag(null)
    expect(f.calls.at(-1)).toEqual(['drag', null])
  })

  it('a worst-case presence state serializes under the 256 KB the server allows', () => {
    const id = 'p'.repeat(64)
    const n = -12345.678901234567
    const pose = { id, position: [n, n, n], rotationY: n, rotationX: n, rotationZ: n }
    const state = {
      user: { name: 'n'.repeat(40), color: '#123456' },
      selection: Array(PRESENCE_MAX_IDS).fill(id),
      drag: Array(PRESENCE_MAX_IDS).fill(pose),
      cursor: { x: n, y: n, z: n },
      running: true,
      editingPart: 'pkg_'.repeat(16),
    }
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThan(256 * 1024)
  })
})

// y-codemirror.next writes a remote peer's user.color / user.colorLight into its carets' inline
// styles unchecked, so the ST binding hands it an awareness whose remote users are already checked.
describe('ST editor carets read checked peer state', () => {
  /** an awareness over a real doc (clientID 1 = us) holding a shared text, as the room's would */
  function setup(states: Map<number, Record<string, unknown>>) {
    const doc = new Y.Doc()
    doc.clientID = 1
    const text = doc.getText('st')
    text.insert(0, 'PROGRAM Main END_PROGRAM')
    const raw = {
      doc,
      getStates: () => states,
      getLocalState: () => states.get(1) ?? null,
      setLocalStateField: () => {},
      on: () => {},
      off: () => {},
    }
    return { doc, text, safe: () => caretSafeAwareness(raw).getStates() }
  }

  it('replaces a remote user with name + #rrggbb color, and leaves our own state alone', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: 'me', color: 'whatever-we-set' } }],
      [2, { user: { name: 'Otter', color: 'red; background: url(https://evil.example/x)', colorLight: 'url(x)' } }],
      [3, { user: { name: 'Lynx', color: '#17becf' } }],
    ])
    const safe = setup(states).safe()
    expect(safe.get(1)).toBe(states.get(1))
    expect(safe.get(2)).toEqual({ user: { name: 'Otter', color: '#888888' }, cursor: null })
    expect(safe.get(3)?.user).toEqual({ name: 'Lynx', color: '#17becf' })
    // the underlying states are not mutated
    expect((states.get(2)?.user as { color: string }).color).toContain('url(')
  })

  it('keeps a real caret and resolves it to the same place', () => {
    const states = new Map<number, Record<string, unknown>>()
    const { doc, text, safe } = setup(states)
    const at = (i: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i)) as Record<string, unknown>
    states.set(2, { user: { name: 'Otter', color: '#17becf' }, cursor: { anchor: at(3), head: at(8) } })
    const cursor = safe().get(2)?.cursor as { anchor: Record<string, unknown>; head: Record<string, unknown> }
    expect(cursor).not.toBeNull()
    const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc)
    expect(head?.index).toBe(8)
    expect(head?.type).toBe(text)
  })

  // Each of these, handed to y-codemirror raw, throws inside Yjs's createAbsolutePositionFromRelativePosition
  // (a string, negative or missing clock; a string type), and it resolves every peer's caret on every update.
  it('drops a malformed caret instead of letting it throw in every editor', () => {
    const states = new Map<number, Record<string, unknown>>()
    const { safe } = setup(states)
    const good = { item: { client: 1, clock: 2 }, assoc: 0 }
    for (const bad of [
      { anchor: { item: { client: 1, clock: 'x' } }, head: good },
      { anchor: { item: { client: -1, clock: 2 } }, head: good },
      { anchor: { item: { client: 1, clock: 2.5 } }, head: good },
      { anchor: { type: 'root' }, head: good },
      { anchor: { tname: 5 }, head: good },
      { anchor: good, head: { assoc: 'left' } },
      { anchor: good },
      { anchor: 1, head: 2 },
      'caret',
      { anchor: { item: { client: 1 } }, head: good },
    ]) {
      states.set(2, { user: { name: 'Otter', color: '#17becf' }, cursor: bad })
      expect(safe().get(2)?.cursor).toBeNull()
    }
  })
})
