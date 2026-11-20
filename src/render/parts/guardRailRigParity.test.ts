import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { arrayInstanceDeltas, linkHalfExtents } from '../../core/rig/rigPose'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: GUARD_RAIL_RIG } = examplePart<RigGeo>('oip.guard-rail')

// The Guard Rail, authored as a custom part (examples/parts/guardRail), exercises the array-links distribute
// form: posts auto-space evenly along the `length` param (N = ceil(length/maxSpacing)+1), while the two rails
// are length-parametric (C-paramgeo). This pins the post distribution + the rail sizing.

const geo = GUARD_RAIL_RIG
const MAX_SPACING = 2.4
const post = geo.links.find((l) => l.name === 'post')!

describe('Guard Rail custom-part rig - array-links (distribute) + C-paramgeo', () => {
  it('is a structurally valid package (rig + a no-op behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.guard-rail', name: 'Guard Rail', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('auto-spaces posts evenly along the length, centred, ≤ maxSpacing apart', () => {
    expect(post.array?.distribute?.spanParam).toBe('length')
    for (const length of [4, 8, 13]) {
      const deltas = arrayInstanceDeltas(post.array!, { length })
      const expectedN = Math.ceil(length / MAX_SPACING) + 1
      expect(deltas).toHaveLength(expectedN)
      expect(deltas[0]![0]).toBeCloseTo(-length / 2, 6) // first post at the start
      expect(deltas[expectedN - 1]![0]).toBeCloseTo(length / 2, 6) // last at the end
      const gap = deltas[1]![0] - deltas[0]![0]
      expect(gap).toBeLessThanOrEqual(MAX_SPACING + 1e-9) // never exceeds the max spacing
    }
  })

  it('both rails span the full length (C-paramgeo) at the guard-rail heights', () => {
    const rails = geo.links.filter((l) => l.name.startsWith('rail'))
    expect(rails).toHaveLength(2)
    for (const r of rails) expect(linkHalfExtents(r, { length: 8 })[0]).toBeCloseTo(4, 6)
    expect(rails.map((r) => r.offset[1]).sort()).toEqual([0.54, 1.07]) // mid + top rail heights
  })

  it('every steel link exposes the editable `color` param (built-in steel_color parity)', () => {
    for (const l of geo.links.filter((l) => !l.hidden)) expect(l.colorParam).toBe('color')
  })

  it('the collision is a hidden full-height wall, not the rails (platform-railing parity)', () => {
    // Two 0.032 m bars don't block anything that samples the world at points: the walking pilot's wall
    // rays (0.12 / 0.4 / 0.9 / 1.4 m above the feet) pass between a 0.54 m mid rail and a 1.07 m top rail,
    // so a rail whose only bodies are its bars can be walked straight through. The platform railing uses
    // a hidden solid wall for this; this pins the standalone rail to the same model.
    const wall = geo.links.find((l) => l.name === 'wall')!
    expect(wall.hidden).toBe(true) // collision-only, never rendered
    expect(wall.collision).toBeUndefined() // ...and still bodied
    expect(linkHalfExtents(wall, { length: 8 })).toEqual([4, 1.07 / 2, 0.03]) // full length, full rail height
    expect(wall.offset[1]).toBeCloseTo(1.07 / 2, 6) // spans the floor up to the top rail
    // the visible members are decoration, so they can't fight the wall for the contact
    for (const l of geo.links.filter((l) => l !== wall)) expect(l.collision).toBe('none')
  })

  it('omits an end post when omitPostStart/End is set (butt two rails flush - built-in parity)', () => {
    expect(post.array?.omitFirstParam).toBe('omitPostStart')
    expect(post.array?.omitLastParam).toBe('omitPostEnd')
    const full = arrayInstanceDeltas(post.array!, { length: 8 })
    const noStart = arrayInstanceDeltas(post.array!, { length: 8, omitPostStart: true })
    expect(noStart).toHaveLength(full.length - 1)
    expect(noStart[0]![0]).toBeGreaterThan(full[0]![0]) // the low-X post is gone
  })
})
