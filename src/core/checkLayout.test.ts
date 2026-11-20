// The seating check. Every case here corresponds to something that actually happened while building
// it against the real demo scene - the false positives it had to stop reporting, and the true
// positive it had to start.

import { describe, expect, it, beforeEach } from 'vitest'
import { checkLayout, formatLayoutFinding } from './checkLayout'
import { clearPackages, registerPackage } from './parts/partRegistry'
import { createPart } from './scene/scene'
import type { PartPackage } from './parts/partPackage'
import type { PartInstance } from './types'
import { PACKAGE_FORMAT } from './parts/partPackage'

/** A deck-shaped package, optionally declaring a snap block. Deck geometry gives a real footprint. */
function pkg(id: string, snap?: PartPackage['snap']): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: id,
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
    ...(snap ? { snap } : {}),
  }
}

const at = (id: string, packageId: string, x: number, y = 0, z = 0): PartInstance =>
  ({ id, type: 'part', packageId, position: [x, y, z], rotationY: 0, params: {} }) as unknown as PartInstance

// a guest (declares it mounts onto something), a plain part, and a host-declaring part
const GUEST = 'acme.sensor'
const PLAIN = 'acme.block'
const HOSTY = 'acme.platform'

beforeEach(() => {
  clearPackages()
  registerPackage(pkg(GUEST, { mounts: [{ accepts: 'rail' } as never] }))
  registerPackage(pkg(PLAIN))
  registerPackage(pkg(HOSTY, { surfaces: [{ kind: 'rail' } as never] }))
})

describe('what counts as seated', () => {
  it('passes a guest sitting on another part', () => {
    expect(checkLayout([at('g', GUEST, 0), at('h', PLAIN, 0)])).toEqual([])
  })

  it('reports a guest with nothing near it', () => {
    const found = checkLayout([at('g', GUEST, 0), at('h', PLAIN, 40)])
    expect(found).toHaveLength(1)
    expect(found[0]!.partId).toBe('g')
    expect(found[0]!.kind).toBe('unseated')
    expect(found[0]!.detail).toContain('mounts onto a host surface')
  })

  it('accepts a host that declares nothing - people mount things on structure they build', () => {
    // three demo sensors sit on posts made of `oip.shape`, which has no snap block; requiring the host to
    // declare `surfaces` would report them as false positives
    expect(checkLayout([at('g', GUEST, 0), at('post', PLAIN, 0)])).toEqual([])
  })
})

describe('what cannot be a host', () => {
  it('does not count the building - it encloses everything, so it would seat everything', () => {
    // the bug that made the first version useless: with the building eligible, a part displaced 20 m
    // from its conveyor still reported clean
    const building = createPart('building', 'bld', [0, 0, 0]) as PartInstance
    const found = checkLayout([at('g', GUEST, 0), building])
    expect(found).toHaveLength(1)
    expect(found[0]!.partId).toBe('g')
  })

  it('does not count cargo - a box sliding underneath is not a mounting', () => {
    // cargo is `geometry.kind: 'cargo'`, which is what cargoView keys off
    registerPackage({
      ...pkg('acme.crate'),
      geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, height: 0.3, width: 0.4 } } as never,
    })
    const found = checkLayout([at('g', GUEST, 0), at('crate', 'acme.crate', 0)])
    expect(found.map((f) => f.partId)).toEqual(['g'])
  })

  it('…but a real part at the same place does seat it - the exclusion is cargo, not proximity', () => {
    expect(checkLayout([at('g', GUEST, 0), at('h', PLAIN, 0)])).toEqual([])
  })
})

describe('what is deliberately never reported', () => {
  it('says nothing about a part that declares no snap at all', () => {
    expect(checkLayout([at('a', PLAIN, 0), at('b', PLAIN, 40)])).toEqual([])
  })

  it('says nothing about a lone CHAIN part - one fence is a fence, not an error', () => {
    registerPackage(pkg('acme.fence', { chain: { lengthParam: 'length' } as never }))
    expect(checkLayout([at('f', 'acme.fence', 0)])).toEqual([])
  })

  it('says nothing about a lone EDGES part - tiling is optional', () => {
    registerPackage(pkg('acme.tile', { tile: {} as never }))
    expect(checkLayout([at('t', 'acme.tile', 0)])).toEqual([])
  })

  it('says nothing about a lone SURFACES part - the host half owes nobody', () => {
    expect(checkLayout([at('p', HOSTY, 0)])).toEqual([])
  })

  it('says nothing about a part whose package will not resolve', () => {
    // an unregistered package measures as nothing; reporting it would blame the scene for a
    // registry problem, and a false accusation is worse than a missed one here
    expect(checkLayout([at('x', 'acme.not-registered', 0)])).toEqual([])
  })
})

describe('the report', () => {
  it('names the part the way a human labelled it', () => {
    const named = { ...(at('g', GUEST, 0) as object), name: 'Release eye' } as unknown as PartInstance
    const [f] = checkLayout([named])
    expect(formatLayoutFinding(f!)).toContain('Release eye (g)')
    expect(formatLayoutFinding(f!)).toContain(GUEST)
  })

  it('is deterministic in order', () => {
    const parts = [at('z', GUEST, 0), at('a', GUEST, 40)]
    expect(checkLayout(parts).map((f) => f.partId)).toEqual(['a', 'z'])
  })
})

describe('interior building columns', () => {
  // 4x4 sections, grid every 2: one column at the origin, faces at ±0.2
  const building = (columnSpacing: number, rotationY = 0): PartInstance => {
    const b = createPart('building', 'bld', [0, 0, 0])
    return { ...b, rotationY, params: { ...b.params, lengthSections: 4, widthSections: 4, columnSpacing } } as PartInstance
  }
  const turned = (p: PartInstance, rotationY: number): PartInstance => ({ ...p, rotationY }) as PartInstance

  it('reports a part standing in a column, naming where the column is', () => {
    const found = checkLayout([building(2), at('b', PLAIN, 0.3)])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ partId: 'b', kind: 'column', packageId: PLAIN })
    expect(formatLayoutFinding(found[0]!)).toContain('stands in the building column at (0.0, 0.0)')
  })

  it('is quiet with the grid off, and for a part merely touching a column face', () => {
    expect(checkLayout([building(0), at('b', PLAIN, 0)])).toEqual([])
    // the 1 m block's face at x = 0.2 meets the column's face
    expect(checkLayout([building(2), at('b', PLAIN, 0.7)])).toEqual([])
  })

  it('tests the part in its own frame, not by its world box', () => {
    // turned 45 degrees, the block's world box reaches 0.707 from its centre - past the column's corner at
    // (0.2, 0.2) from (0.9, 0.9) - but its nearest FACE reaches 0.5 along that diagonal and the column's
    // corner 0.283, which together fall short of the 1.27 between the centres
    expect(checkLayout([building(2), turned(at('b', PLAIN, 0.9, 0, 0.9), Math.PI / 4)])).toEqual([])
    // from (0.5, 0.5) the centres are 0.707 apart, inside that 0.783
    expect(checkLayout([building(2), turned(at('b', PLAIN, 0.5, 0, 0.5), Math.PI / 4)])).toHaveLength(1)
  })

  it('follows the building when it is turned', () => {
    // a block 0.45 off the column along X: clear of a square column, inside it once the building turns 45
    expect(checkLayout([building(2), at('b', PLAIN, 0.69)])).toEqual([])
    expect(checkLayout([building(2, Math.PI / 4), at('b', PLAIN, 0.69)])).toHaveLength(1)
  })

  it('never reports cargo, which is passing traffic', () => {
    registerPackage({
      ...pkg('acme.crate'),
      geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, height: 0.3, width: 0.4 } } as never,
    })
    expect(checkLayout([building(2), at('crate', 'acme.crate', 0)])).toEqual([])
  })
})
