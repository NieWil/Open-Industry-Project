import { describe, expect, it } from 'vitest'
import type { PartInstance } from '../types'
import { translateParts, yawParts } from './offsetParts'

const part = (id: string, x: number, z: number, extra: Partial<PartInstance> = {}): PartInstance =>
  ({ id, type: 'group', position: [x, 0, z], rotationY: 0, ...extra }) as PartInstance

describe('translateParts', () => {
  it('moves the selection and its descendants, nothing else', () => {
    const parts = [part('a', 0, 0), part('child', 1, 0, { parent: 'a' }), part('b', 5, 5)]
    const out = translateParts(parts, ['a'], [1.2, 0, 0])
    expect(out.map((p) => p.position[0])).toEqual([1.2, 2.2, 5])
    expect(out[2]).toBe(parts[2])
  })
})

describe('yawParts', () => {
  it('turns the selection about its centre and carries a child', () => {
    const parts = [part('a', -1, 0), part('b', 1, 0), part('child', 1, 1, { parent: 'b' })]
    const out = yawParts(parts, ['a', 'b'], Math.PI / 2)
    // +X by +90deg maps to -Z (core/transforms convention), about the pivot (0, 0)
    expect(out[0]!.position[0]).toBeCloseTo(0, 12)
    expect(out[0]!.position[2]).toBeCloseTo(1, 12)
    expect(out[1]!.position[2]).toBeCloseTo(-1, 12)
    expect(out[2]!.position[0]).toBeCloseTo(1, 12)
    expect(out[2]!.position[2]).toBeCloseTo(-1, 12)
    for (const p of out) expect(p.rotationY).toBeCloseTo(Math.PI / 2, 12)
  })

  it('turns a lone part in place', () => {
    const out = yawParts([part('a', 3, 4)], ['a'], 1)
    expect(out[0]!.position).toEqual([3, 0, 4])
    expect(out[0]!.rotationY).toBeCloseTo(1, 12)
  })
})
