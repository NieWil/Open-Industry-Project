import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewportState, moveViewportState, persistViewportState, readViewportState, VIEWPORT_KEY } from './storePrefs'

/** a real-enough localStorage: these helpers read-modify-write the same key, so a getItem-only stub can't test them */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  }
}

const POSE = { px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 }

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('viewport state', () => {
  it('round-trips a pose and the projection it was framed at', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'orthographic' })
    // no `auto` written = the explicit (O-key) kind of ortho
    expect(readViewportState('scene-1')).toEqual({ pose: POSE, projection: 'orthographic', auto: false })
  })

  // An axis-snap ortho has to come back as one. Restored as the explicit kind, orbiting off the axis
  // stops reverting to perspective.
  it('round-trips whether an orthographic view was an axis-snap auto-ortho', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'orthographic', auto: true })
    persistViewportState('scene-2', { pose: POSE, projection: 'orthographic', auto: false })
    expect(readViewportState('scene-1')).toEqual({ pose: POSE, projection: 'orthographic', auto: true })
    expect(readViewportState('scene-2')).toEqual({ pose: POSE, projection: 'orthographic', auto: false })
  })

  it('restores a slot written before the auto flag existed as the explicit kind', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [VIEWPORT_KEY]: JSON.stringify([{ key: 'a', pose: POSE, projection: 'orthographic' }]) }))
    expect(readViewportState('a')).toEqual({ pose: POSE, projection: 'orthographic', auto: false })
  })

  it('never reads a perspective view or a malformed flag as auto, and keeps the camera either way', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({
        [VIEWPORT_KEY]: JSON.stringify([
          { key: 'p', pose: POSE, projection: 'perspective', auto: true },
          { key: 'o', pose: POSE, projection: 'orthographic', auto: 'yes' },
        ]),
      }),
    )
    expect(readViewportState('p')).toEqual({ pose: POSE, projection: 'perspective', auto: false })
    expect(readViewportState('o')).toEqual({ pose: POSE, projection: 'orthographic', auto: false })
  })

  // the "this scene has never been framed" signal: the caller applies the opening view instead
  it('returns null for a slot that has never been framed', () => {
    expect(readViewportState('scene-9')).toBeNull()
  })

  it('keeps slots independent, so each scene tab reopens on its own framing', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    persistViewportState('scene-2', { pose: { ...POSE, px: 99 }, projection: 'perspective' })
    expect(readViewportState('scene-1')?.pose.px).toBe(1)
    expect(readViewportState('scene-2')?.pose.px).toBe(99)
  })

  it('overwrites a slot rather than appending a second entry for it', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    persistViewportState('scene-1', { pose: { ...POSE, py: 42 }, projection: 'perspective' })
    expect(readViewportState('scene-1')?.pose.py).toBe(42)
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)).toHaveLength(1)
  })

  it('caps the map, dropping the least recently framed scene', () => {
    for (let i = 0; i < 25; i++) persistViewportState(`scene-${i}`, { pose: POSE, projection: 'perspective' })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)).toHaveLength(20)
    expect(readViewportState('scene-24')).not.toBeNull() // newest kept
    expect(readViewportState('scene-0')).toBeNull() // oldest evicted
  })

  it('re-framing a scene refreshes its place in the cap', () => {
    persistViewportState('old', { pose: POSE, projection: 'perspective' })
    for (let i = 0; i < 19; i++) persistViewportState(`scene-${i}`, { pose: POSE, projection: 'perspective' })
    persistViewportState('old', { pose: POSE, projection: 'perspective' }) // touched again: now newest
    for (let i = 19; i < 38; i++) persistViewportState(`scene-${i}`, { pose: POSE, projection: 'perspective' })
    expect(readViewportState('old')).not.toBeNull()
  })

  it('clear forgets one scene and leaves the rest ("Reset View")', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    persistViewportState('scene-2', { pose: POSE, projection: 'perspective' })
    clearViewportState('scene-1')
    expect(readViewportState('scene-1')).toBeNull()
    expect(readViewportState('scene-2')).not.toBeNull()
  })

  // a corrupt preference must cost you a camera, never a scene - so every reader drops junk silently
  it('drops malformed entries instead of throwing', () => {
    for (const raw of ['not json', '{}', '"str"', '[1,2,3]', '[{"key":"a"}]', '[{"key":"a","pose":{"px":"x"},"projection":"perspective"}]']) {
      vi.stubGlobal('localStorage', fakeStorage({ [VIEWPORT_KEY]: raw }))
      expect(readViewportState('a')).toBeNull()
    }
  })

  it('rejects a pose carrying a non-finite component', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [VIEWPORT_KEY]: JSON.stringify([{ key: 'a', pose: { ...POSE, px: null }, projection: 'perspective' }]) }))
    expect(readViewportState('a')).toBeNull()
  })

  it('rejects an unknown projection', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [VIEWPORT_KEY]: JSON.stringify([{ key: 'a', pose: POSE, projection: 'isometric' }]) }))
    expect(readViewportState('a')).toBeNull()
  })

  it('a surviving entry is still readable alongside a malformed sibling', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [VIEWPORT_KEY]: JSON.stringify([{ key: 'bad' }, { key: 'good', pose: POSE, projection: 'perspective' }]) }))
    expect(readViewportState('good')?.pose).toEqual(POSE)
  })

  // the headless/native path (scripts, tests, the ST oracles) has no DOM storage at all
  it('no-ops without localStorage', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })).not.toThrow()
    expect(() => clearViewportState('scene-1')).not.toThrow()
    expect(readViewportState('scene-1')).toBeNull()
  })

  it('survives a storage that refuses to write (private mode / quota)', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota') } })
    expect(() => persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })).not.toThrow()
  })
})

// Slots are keyed by document + scene (documentStore.sceneSlotKey). An older slot is under the bare scene id,
// and every project has a `scene-1`, so it may be taken once, by the first document to ask.
describe('viewport state from before cameras were kept per document', () => {
  it('is taken by the first document to ask, and by no other', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'orthographic', auto: true })
    expect(readViewportState('doc-a/scene-1', 'scene-1')).toEqual({ pose: POSE, projection: 'orthographic', auto: true })
    // re-keyed, not copied: the bare slot is gone, the document's slot holds it
    expect(readViewportState('scene-1')).toBeNull()
    expect(readViewportState('doc-a/scene-1')?.pose).toEqual(POSE)
    expect(readViewportState('doc-b/scene-1', 'scene-1')).toBeNull()
  })

  it('never overrides a slot the document already has', () => {
    const own = { ...POSE, px: 42 }
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    persistViewportState('doc-a/scene-1', { pose: own, projection: 'perspective' })
    expect(readViewportState('doc-a/scene-1', 'scene-1')?.pose).toEqual(own)
    expect(readViewportState('scene-1')?.pose).toEqual(POSE) // left for whoever it belongs to
  })

  it('is a plain read where there is no document (the key is the bare id)', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    expect(readViewportState('scene-1', 'scene-1')?.pose).toEqual(POSE)
    expect(readViewportState('scene-1')?.pose).toEqual(POSE)
  })
})

// A document that has just been given its id takes the cameras it saved under bare scene ids before that.
describe('moving a camera slot to a document', () => {
  it('moves it when the document has none of its own', () => {
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    moveViewportState('scene-1', 'doc-a/scene-1')
    expect(readViewportState('scene-1')).toBeNull()
    expect(readViewportState('doc-a/scene-1')?.pose).toEqual(POSE)
  })

  it('leaves both alone when the document already has one', () => {
    const own = { ...POSE, px: 7 }
    persistViewportState('scene-1', { pose: POSE, projection: 'perspective' })
    persistViewportState('doc-a/scene-1', { pose: own, projection: 'perspective' })
    moveViewportState('scene-1', 'doc-a/scene-1')
    expect(readViewportState('scene-1')?.pose).toEqual(POSE)
    expect(readViewportState('doc-a/scene-1')?.pose).toEqual(own)
  })

  it('does nothing when there is nothing to move', () => {
    moveViewportState('scene-1', 'doc-a/scene-1')
    expect(readViewportState('doc-a/scene-1')).toBeNull()
  })
})
