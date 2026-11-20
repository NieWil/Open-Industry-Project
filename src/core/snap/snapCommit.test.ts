import { describe, expect, it } from 'vitest'
import { commitSnap, snapAttaches } from './snapCommit'
import type { SnapCandidate } from './snapFeatures'
import type { PartInstance } from '../types'

const part = (id: string, params: Record<string, unknown> = {}, parent?: string): PartInstance =>
  ({ id, type: 'part', packageId: 'x', position: [0, 0, 0], rotationY: 0, params, ...(parent ? { parent } : {}) }) as unknown as PartInstance

const cand = (over: Partial<SnapCandidate> = {}): SnapCandidate => ({
  pose: { position: [1, 2, 3], rotationY: 0.5 },
  targetId: 'host',
  cost: 0,
  junction: { x: 0, y: 0, z: 0 },
  ...over,
})

describe('commitSnap', () => {
  it('writes the pose, the mover fits and the host fits, and keeps other parts by identity', () => {
    const other = part('other')
    const parts = [part('host', { a: 1 }), part('m', { r: 2, keep: true }), other]
    const out = commitSnap(parts, 'm', cand({ paramOverrides: { r: 0.84 }, targetParamOverrides: { a: 3 } }))
    const m = out.find((p) => p.id === 'm') as unknown as { position: number[]; rotationY: number; params: Record<string, unknown> }
    expect(m.position).toEqual([1, 2, 3])
    expect(m.rotationY).toBe(0.5)
    expect(m.params).toEqual({ r: 0.84, keep: true })
    expect((out.find((p) => p.id === 'host') as unknown as { params: Record<string, unknown> }).params).toEqual({ a: 3 })
    expect(out[2]).toBe(other)
    expect(parts[1]!.position).toEqual([0, 0, 0]) // the input is not mutated
  })

  it('parents an attach mount under its host, unless that would make a cycle', () => {
    const parts = [part('host'), part('m')]
    expect(commitSnap(parts, 'm', cand({ attach: true })).find((p) => p.id === 'm')!.parent).toBe('host')
    const cyclic = [part('host', {}, 'm'), part('m')]
    expect(snapAttaches(cyclic, 'm', cand({ attach: true }))).toBe(false)
    expect(commitSnap(cyclic, 'm', cand({ attach: true })).find((p) => p.id === 'm')!.parent).toBeUndefined()
  })

  it('without the pose, a candidate that fits nothing changes nothing (the live drag commit)', () => {
    const parts = [part('host'), part('m')]
    expect(commitSnap(parts, 'm', cand(), { pose: false })).toBe(parts)
    const moved = commitSnap(parts, 'm', cand({ paramOverrides: { r: 1 } }), { pose: false })
    expect(moved.find((p) => p.id === 'm')!.position).toEqual([0, 0, 0])
  })
})
