import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { rackBoxes } from '../../core/parts/partGeometry'
import type { RigLink } from '../../core/parts/partPackage'
import { arrayInstanceDeltas, linkHalfExtents, resolvedOffset } from '../../core/rig/rigPose'
import { examplePart, type RigGeo } from './examplePart'

/** a link's instances as the host resolves them: its array (a single instance without one), none while its
 *  showParam is off */
const instances = (link: RigLink, params: Record<string, number | boolean>) => arrayInstanceDeltas(link.array ?? {}, params, undefined, link.showParam)
const { geometry: RACK_RIG } = examplePart<RigGeo>('oip.rack')

// The Rack, authored as a custom part (examples/parts/rack) to match the built-in (core/parts/partGeometry.rackBoxes
// + STRUCTURE_DEFS.rack). It exercises array-links (numShelves shelf/beam arrays + an X×Z pole grid) composed
// with C-paramgeo, including a mulParam product (frame height = numShelves × shelfSpacing, which neither param
// gives alone). This checks the array expansion + the param-driven geometry against the built-in rack.

const geo = RACK_RIG
const F = 0.08 // RACK_FRAME_THICKNESS
const link = (n: string): RigGeo['links'][number] => geo.links.find((l) => l.name === n)!
const CORNERS = ['postLF', 'postLR', 'postRF', 'postRR']

describe('Rack custom-part rig - built-in parity (array-links + C-paramgeo)', () => {
  it('is a structurally valid package (rig + a no-op behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.rack', name: 'Rack', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('the shelves are a numShelves array stacked by the shelfSpacing pitch (bottom floor left open)', () => {
    const shelf = link('shelf')
    expect(shelf.array?.count).toBe('numShelves')
    for (const [n, sp] of [[3, 1.6], [4, 2.0], [7, 1.6]] as const) {
      const deltas = arrayInstanceDeltas(shelf.array!, { numShelves: n, shelfSpacing: sp })
      expect(deltas).toHaveLength(n) // one shelf per count
      const base = resolvedOffset(shelf.offset, shelf.offsetParams, { shelfSpacing: sp })[1]
      expect(base).toBeCloseTo(sp, 6) // base sits one pitch above the floor (floor level open)
      expect(base + deltas[0]![1]).toBeCloseTo(sp, 6) // first shelf at 1·spacing
      expect(base + deltas[n - 1]![1]).toBeCloseTo(n * sp, 6) // top shelf at n·spacing (tracks both params)
    }
  })

  it('every link is flat non-metallic (matches the built-in material: metalness 0, roughness 0.8)', () => {
    // the aisle signs are canvas labels, which carry no material of their own
    for (const l of geo.links.filter((k) => k.shape.kind !== 'label')) {
      expect(l.metalness).toBe(0)
      expect(l.roughness).toBeCloseTo(0.8, 6)
    }
  })

  it('each shelf spans the full length × depth (C-paramgeo)', () => {
    const he = linkHalfExtents(link('shelf'), { length: 3.2, depth: 1.6 })
    expect(he[0]).toBeCloseTo(1.6, 6) // length/2
    expect(he[2]).toBeCloseTo(0.8, 6) // depth/2
  })

  it('the 4 corner posts sit at ±length/2, ±depth/2; height = numShelves × shelfSpacing + 0.15 over the top shelf (mulParam product)', () => {
    const posts = CORNERS.map(link)
    expect(posts).toHaveLength(4)
    const params = { length: 2.8, depth: 1.4, numShelves: 5, shelfSpacing: 1.6 }
    const corners = posts.map((p) => {
      const o = resolvedOffset(p.offset, p.offsetParams, params)
      return [o[0], o[2]]
    })
    expect(corners).toEqual(expect.arrayContaining([[-1.4, -0.7], [-1.4, 0.7], [1.4, -0.7], [1.4, 0.7]]))
    // frame height is the product, so changing either param regrows the posts
    expect(linkHalfExtents(posts[0]!, params)[1] * 2).toBeCloseTo(5 * 1.6 + 0.15, 6)
    expect(linkHalfExtents(posts[0]!, { ...params, shelfSpacing: 2.5 })[1] * 2).toBeCloseTo(5 * 2.5 + 0.15, 6)
    // ...and each post stands on the floor (centre y = height/2)
    expect(resolvedOffset(posts[0]!.offset, posts[0]!.offsetParams, params)[1]).toBeCloseTo((5 * 1.6 + 0.15) / 2, 6)
  })

  it('enableAutoPoles stands an end frame every poleInterval along X only (built-in pole count); off leaves only the corners', () => {
    const grid = link('poleGrid')
    expect(grid.collision).toBe('none') // decorative infill - the corner posts + shelves are the collidable frame
    const p = { length: 2.8, depth: 1.4, poleInterval: 1.4 }
    // off → empty (only the 4 always-on corner posts remain, = the built-in auto-poles-off layout)
    expect(instances(grid, { ...p, enableAutoPoles: false })).toHaveLength(0)
    // on → a full lattice matching the built-in rackBoxes pole count at a whole-interval footprint (3 × 2 = 6)
    const on = instances(grid, { ...p, enableAutoPoles: true })
    const builtIn = rackBoxes({ length: 2.8, width: 1.4, numShelves: 4, shelfSpacing: 1.6, enableAutoPoles: true, poleInterval: 1.4 })
    expect(on).toHaveLength(builtIn.posts.length)
    // grid spans the footprint edge-to-edge: X ∈ [−length/2, length/2], Z ∈ [−depth/2, depth/2]
    const xs = on.map((d) => d[0])
    const zs = on.map((d) => d[2])
    expect(Math.min(...xs)).toBeCloseTo(-1.4, 4)
    expect(Math.max(...xs)).toBeCloseTo(1.4, 4)
    expect(Math.min(...zs)).toBeCloseTo(-0.7, 4)
    expect(Math.max(...zs)).toBeCloseTo(0.7, 4)
    // the bay and the frame depth are independent: a frame deeper than a bay keeps just its front and back rows,
    // and a bay wider than the frame is deep still gets both
    for (const q of [{ length: 1.4, depth: 3, poleInterval: 1.4 }, { length: 5.4, depth: 1.1, poleInterval: 2.7 }]) {
      const got = instances(grid, { ...q, enableAutoPoles: true })
      const ref = rackBoxes({ length: q.length, width: q.depth, numShelves: 4, shelfSpacing: 1.6, enableAutoPoles: true, poleInterval: q.poleInterval })
      expect(got).toHaveLength(ref.posts.length)
      expect(new Set(got.map((d) => d[2].toFixed(4)))).toEqual(new Set([(-q.depth / 2).toFixed(4), (q.depth / 2).toFixed(4)]))
    }
  })

  it('front/back load beams sit under every shelf level (none at the floor), lipped 10 mm over the slab', () => {
    const front = link('beamFront')
    const back = link('beamBack')
    const shelf = link('shelf')
    expect(link('beamTopFront')).toBeUndefined() // the per-level and top beams are one array
    for (const [n, sp] of [[4, 1.6], [3, 2.0]] as const) {
      const params = { length: 2.8, depth: 1.4, numShelves: n, shelfSpacing: sp }
      const beamYs = arrayInstanceDeltas(front.array!, params).map((d) => resolvedOffset(front.offset, front.offsetParams, params)[1] + d[1])
      const shelfYs = arrayInstanceDeltas(shelf.array!, params).map((d) => resolvedOffset(shelf.offset, shelf.offsetParams, params)[1] + d[1])
      expect(beamYs).toHaveLength(n)
      const beamHalfH = linkHalfExtents(front, params)[1]
      const shelfHalfT = linkHalfExtents(shelf, params)[1]
      beamYs.forEach((y, i) => expect(y + beamHalfH - (shelfYs[i]! + shelfHalfT)).toBeCloseTo(0.01, 6))
    }
    const params = { length: 2.8, depth: 1.4, numShelves: 4, shelfSpacing: 1.6 }
    // the demo's truck threads its forks at 1.647 over the bottom level: the lip must stay under that
    const bottomTop = resolvedOffset(front.offset, front.offsetParams, params)[1] + linkHalfExtents(front, params)[1]
    expect(bottomTop).toBeCloseTo(1.63, 6)
    // a step beam: taller than deep, on the upright centreline and strictly inside the upright's depth, so no beam
    // face shares a plane with an upright face (a flush face z-fights where the beam passes an interior upright)
    const he = linkHalfExtents(front, params)
    expect(he[1]).toBeGreaterThan(he[2])
    expect(resolvedOffset(front.offset, front.offsetParams, params)[2]).toBeCloseTo(-0.7, 6)
    expect(resolvedOffset(back.offset, back.offsetParams, params)[2]).toBeCloseTo(0.7, 6)
    expect(F / 2 - he[2]).toBeGreaterThan(0.005)
    // span = length − frame thickness (matches the built-in support sx = L − F)
    expect(he[0] * 2).toBeCloseTo(2.8 - F, 6)
  })
})
