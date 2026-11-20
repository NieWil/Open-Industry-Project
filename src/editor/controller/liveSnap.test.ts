import { describe, expect, it } from 'vitest'
import type { SnapCandidate } from '../../core/snap/snapFeatures'
import { SNAP_MIN_SWITCH_MS } from '../../core/types'
import { chooseLiveSnap, joinKey } from './liveSnap'

const cand = (targetId: string, join: string | undefined, cost: number, x = 0): SnapCandidate => ({
  pose: { position: [x, 0, 0], rotationY: 0 },
  targetId,
  cost,
  junction: { x, y: 0, z: 0 },
  via: 'conveyor',
  ...(join !== undefined ? { join } : {}),
})

const LONG_AGO = -10_000

describe('live snap stickiness (chooseLiveSnap)', () => {
  it('with nothing held, shows the fresh search', () => {
    const best = cand('a', 'back -> end:front', 0.2)
    expect(chooseLiveSnap(null, best, 0, LONG_AGO)).toBe(best)
    expect(chooseLiveSnap(null, null, 0, LONG_AGO)).toBeNull()
  })

  it('keeps the held join while the search finds nothing (it is past the engage distance, inside the release one)', () => {
    const held = cand('a', 'back -> end:front', 0.45)
    expect(chooseLiveSnap(held, null, 0, LONG_AGO)).toBe(held)
  })

  it('does not trade the held join for a slightly cheaper one: not another conveyor, not another join on the same one', () => {
    const held = cand('a', 'front -> flank:left', 0.3)
    expect(chooseLiveSnap(held, cand('b', 'back -> end:front', 0.28), 0, LONG_AGO)).toBe(held)
    expect(chooseLiveSnap(held, cand('a', 'back -> end:back', 0.28), 0, LONG_AGO)).toBe(held)
  })

  it('switches to a clearly cheaper join, once the last switch has settled', () => {
    const held = cand('a', 'front -> flank:left', 0.3)
    const best = cand('a', 'back -> end:back', 0.1)
    expect(chooseLiveSnap(held, best, 1000, 1000 - SNAP_MIN_SWITCH_MS + 1)).toBe(held)
    expect(chooseLiveSnap(held, best, 1000, 1000 - SNAP_MIN_SWITCH_MS)).toBe(best)
  })

  it('two near-zero costs never trade places (the minimum gain)', () => {
    const held = cand('a', 'front -> flank:left', 0.04)
    expect(chooseLiveSnap(held, cand('b', 'back -> end:front', 0), 0, LONG_AGO)).toBe(held)
  })

  it('the same join at a new pose is the held one (sliding along a flank is not a switch)', () => {
    expect(joinKey(cand('a', 'front -> flank:left', 0.1, 1))).toBe(joinKey(cand('a', 'front -> flank:left', 0.2, 2)))
    expect(joinKey(cand('a', 'front -> flank:left', 0.1))).not.toBe(joinKey(cand('a', 'front -> flank:right', 0.1)))
    // a non-conveyor snap has no join: its target + connector are its identity
    expect(joinKey({ ...cand('a', undefined, 0.1), via: 'mounts[0] -> conveyorGuard' })).toBe('a|mounts[0] -> conveyorGuard|')
  })
})
