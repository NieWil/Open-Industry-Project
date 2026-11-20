import { beforeEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import type { SdkPart } from './types'
import { functionStaticHulls, functionStaticWalls } from './guards/functionGuards'
import { PACKAGE_FORMAT } from './parts/partPackage'

// The `collision: 'hull'` channel: a `function`-geometry submesh realized as a convex hull of its own
// vertices instead of the AABB box the `'static'` channel gives. The two channels must stay disjoint (the
// guard-merge resolver walks the wall list, and a hull can't be a mergeable wall), and the hull points must be
// the deduped submesh verts, since that is what the sim hands Jolt.

function pkg(behavior: string, over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.solid',
    name: 'Acme Solid',
    params: { size: { type: 'number', default: 2 } },
    behavior,
    geometry: { kind: 'drawn', bounds: { length: 2, width: 2, top: 2 } },
    ...over,
  } as PartPackage
}

function part(params: Record<string, unknown> = {}): SdkPart {
  return { id: 'cp_1', type: 'part', packageId: 'acme.solid', position: [3, 0, -1], rotationY: 0.5, params: { size: 2, ...params } } as unknown as SdkPart
}

// a hulled box (base-origin, `size` on a side) + a decorative marker with no collision declared
const HULLED = `definePart({
  params: { size: { type: 'number', default: 2 } },
  geometry(g, p) {
    return [
      { desc: g.box([p.size, p.size, p.size], [0, p.size / 2, 0]), finish: 'mesh', collision: 'hull' },
      { desc: g.box([0.1, 0.1, 0.1], [1, 1, 0]), finish: 'mesh' },
    ]
  },
  step() {},
})`

const bounds = (points: readonly { x: number; y: number; z: number }[]): number[] => [
  Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)),
  Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y)),
  Math.min(...points.map((p) => p.z)), Math.max(...points.map((p) => p.z)),
]

beforeEach(() => clearPackages())

describe('functionStaticHulls', () => {
  it('dedupes a box submesh to its 8 corners, in part-local space, and skips undeclared submeshes', () => {
    const p = pkg(HULLED)
    registerPackage(p)
    const hulls = functionStaticHulls(part(), p)
    expect(hulls.length).toBe(1) // the decorative marker contributes nothing
    // g.box emits 24 verts (4 per face for flat shading); the hull only needs the 8 distinct corners
    expect(hulls[0]!.points.length).toBe(8)
    expect(bounds(hulls[0]!.points)).toEqual([-1, 1, 0, 2, -1, 1]) // base-origin 2 m cube, part-local (pose not applied)
    expect(hulls[0]!.finish).toBe('mesh')
  })

  it('reflows with the params and memoizes per (package, params)', () => {
    const p = pkg(HULLED)
    registerPackage(p)
    expect(bounds(functionStaticHulls(part({ size: 4 }), p)[0]!.points)).toEqual([-2, 2, 0, 4, -2, 2])
    // same params → the same cached array instance (the memo the spur path depends on for edit-time cost)
    expect(functionStaticHulls(part(), p)).toBe(functionStaticHulls(part(), p))
  })

  it('is disjoint from the wall channel: a hulled solid contributes no box, a static one no hull', () => {
    const p = pkg(HULLED)
    registerPackage(p)
    expect(functionStaticWalls(part(), p)).toEqual([])
    const boxed = pkg(HULLED.replace("'hull'", "'box'"), { id: 'acme.boxed' })
    registerPackage(boxed)
    const boxedPart = { ...part(), packageId: 'acme.boxed' } as unknown as SdkPart
    expect(functionStaticHulls(boxedPart, boxed)).toEqual([])
    expect(functionStaticWalls(boxedPart, boxed).length).toBe(1)
  })

  it("carries a submesh's surface friction to its hull and its wall, and leaves it off when undeclared", () => {
    const p = pkg(HULLED.replace("collision: 'hull' }", "collision: 'hull', friction: 0.06 }"), { id: 'acme.slick' })
    registerPackage(p)
    const slickPart = { ...part(), packageId: 'acme.slick' } as unknown as SdkPart
    expect(functionStaticHulls(slickPart, p)[0]!.friction).toBe(0.06)
    const plain = pkg(HULLED)
    registerPackage(plain)
    expect(functionStaticHulls(part(), plain)[0]!.friction).toBeUndefined()
    const boxed = pkg(HULLED.replace("collision: 'hull' }", "collision: 'box', friction: 0.9 }"), { id: 'acme.pad' })
    registerPackage(boxed)
    expect(functionStaticWalls({ ...part(), packageId: 'acme.pad' } as unknown as SdkPart, boxed)[0]!.friction).toBe(0.9)
  })

  it('ignores a submesh with too little volume to collide (under a tetrahedron)', () => {
    const flat = `definePart({
      geometry(g) {
        var s = g.surface()
        s.triangle(s.vertex(0, 0, 0), s.vertex(1, 0, 0), s.vertex(0, 0, 1))
        return [{ desc: s.build(), finish: 'mesh', collision: 'hull' }]
      },
      step() {},
    })`
    const p = pkg(flat, { id: 'acme.flat' })
    registerPackage(p)
    expect(functionStaticHulls({ ...part(), packageId: 'acme.flat' } as unknown as SdkPart, p)).toEqual([])
  })

  it('degrades a submesh past the hull-point cap to its 8 AABB corners rather than dropping its collider', () => {
    // 900 distinct verts (300 triangles) - a dense visual mesh someone declared hullable. Building a 900-point
    // hull per instance is what the cap exists to prevent; losing the collider entirely would be worse (cargo
    // would fall through a visible solid), so it falls back to the same box the 'static' channel gives.
    const dense = `definePart({
      geometry(g) {
        var s = g.surface()
        for (var i = 0; i < 300; i++) {
          var t = i / 300
          s.triangle(s.vertex(t, 0, 0), s.vertex(t, 2, 0.5), s.vertex(t, 0, 1))
        }
        return [{ desc: s.build(), finish: 'mesh', collision: 'hull' }]
      },
      step() {},
    })`
    const p = pkg(dense, { id: 'acme.dense' })
    registerPackage(p)
    const hulls = functionStaticHulls({ ...part(), packageId: 'acme.dense' } as unknown as SdkPart, p)
    expect(hulls.length).toBe(1)
    expect(hulls[0]!.points.length).toBe(8)
    expect(bounds(hulls[0]!.points)).toEqual([0, 299 / 300, 0, 2, 0, 1])
  })
})
