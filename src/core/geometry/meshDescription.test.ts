import { describe, expect, it } from 'vitest'
import type { Vec3 } from './meshDescription'
import { GeometryBudgetError, MAX_DESCRIPTION_VERTICES, sweepBedPath, sweepProfileAlongPath, sweepProfileAlongX, triangulatePolygon } from './meshDescription'

// The geometry tier's core sweep (docs/procedural-geometry.md): a deterministic, budget-capped sweep that
// reproduces a conveyor bed as a portable description, with no three.js. The belt bed is the target.

// the belt deck's cross-section in the Y/Z plane: a width×thickness rectangle centred on Z, its top face
// at y=0 (like the sim conveyor body), CCW. Matches the SDK belt deck (thickness 0.1, width param).
function deckSection(width: number, thickness: number): Array<[number, number]> {
  const hw = width / 2
  return [
    [-thickness, -hw], // bottom-left
    [-thickness, hw], //  bottom-right
    [0, hw], //           top-right
    [0, -hw], //          top-left
  ]
}

describe('meshDescription - sweepProfileAlongX (geometry-tier spine)', () => {
  it("reproduces the belt deck's footprint as a swept description (length × thickness × width)", () => {
    const length = 3,
      width = 1.0,
      thickness = 0.1
    const mesh = sweepProfileAlongX(deckSection(width, thickness), [0, length])

    // 2 stations × 4 corners × 2 (a hard edge has a vertex per face) = 16 verts; 1 segment × 4 quads × 6 = 24 indices
    expect(mesh.positions).toHaveLength(16 * 3)
    expect(mesh.indices).toHaveLength(24)
    expect(mesh.uvs).toHaveLength(16 * 2)

    // bounding box matches the deck slab: X∈[0,length], Y∈[-thickness,0], Z∈[-width/2,width/2]
    const xs = mesh.positions.filter((_, i) => i % 3 === 0)
    const ys = mesh.positions.filter((_, i) => i % 3 === 1)
    const zs = mesh.positions.filter((_, i) => i % 3 === 2)
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, length])
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-thickness, 0])
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([-width / 2, width / 2])
  })

  it('is deterministic - identical inputs give an identical description', () => {
    const a = sweepProfileAlongX(deckSection(1, 0.1), [0, 1, 2, 3])
    const b = sweepProfileAlongX(deckSection(1, 0.1), [0, 1, 2, 3])
    expect(a).toEqual(b)
  })

  it('places one ring of the profile per station (a multi-segment sweep)', () => {
    const mesh = sweepProfileAlongX(deckSection(1, 0.1), [0, 1, 2]) // 3 stations
    expect(mesh.positions).toHaveLength(3 * 8 * 3) // 3 rings × 4 hard corners × 2 × xyz
    expect(mesh.indices).toHaveLength(2 * 4 * 6) // 2 segments × 4 quads × 6
  })

  it('splits a section corner sharper than 40 degrees into a hard edge and keeps a round section smooth', () => {
    const round = Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * 2 * Math.PI), Math.sin((i / 16) * 2 * Math.PI)] as [number, number])
    expect(sweepProfileAlongX(round, [0, 1]).positions).toHaveLength(2 * 16 * 3)
    // a guard's L section: every corner turns 90 degrees, so each face of the sheet has vertices of its own
    const L: Array<[number, number]> = [[-0.005, 0], [-0.005, 0.005], [0.145, 0.005], [0.145, 0.025], [0.15, 0.025], [0.15, 0]]
    const mesh = sweepProfileAlongX(L, [0, 1])
    expect(mesh.positions).toHaveLength(2 * 12 * 3)
    // no vertex is shared by two faces, so averaged normals can't blend them: every triangle on a vertex has the
    // same facing (the sweep runs along +X, so a face's normal is ±Y or ±Z)
    const facing = new Map<number, string>()
    const p = (v: number): number[] => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => p(mesh.indices[t + k]!)) as [number[], number[], number[]]
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
      const ny = u[2]! * w[0]! - u[0]! * w[2]!, nz = u[0]! * w[1]! - u[1]! * w[0]!
      const face = Math.abs(ny) > Math.abs(nz) ? (ny > 0 ? '+y' : '-y') : nz > 0 ? '+z' : '-z'
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t + k]!
        expect(facing.get(v) ?? face).toBe(face)
        facing.set(v, face)
      }
    }
  })

  it('caps runaway geometry at the vertex budget', () => {
    const profile = deckSection(1, 0.1) // 4 points
    const tooMany = Array.from({ length: MAX_DESCRIPTION_VERTICES / 4 + 1 }, (_, i) => i)
    expect(() => sweepProfileAlongX(profile, tooMany)).toThrow(GeometryBudgetError)
  })

  it('rejects a degenerate profile or a single station', () => {
    expect(() => sweepProfileAlongX([[0, 0], [0, 1]], [0, 1])).toThrow(/≥3 points/)
    expect(() => sweepProfileAlongX(deckSection(1, 0.1), [0])).toThrow(/≥2 stations/)
  })

  // ---- the manifest can't do these: incline + arc (the real belt path) ----
  it('an inclined path tilts the deck up without banking it (the inclined belt)', () => {
    const theta = Math.PI / 6 // 30°
    const L = 2
    const far: Vec3 = [L * Math.cos(theta), L * Math.sin(theta), 0]
    const mesh = sweepProfileAlongPath(deckSection(1, 0.1), [[0, 0, 0], far])
    const ys = mesh.positions.filter((_, i) => i % 3 === 1)
    // the far end's top face rose by L·sinθ - the bed climbs
    expect(Math.max(...ys)).toBeCloseTo(L * Math.sin(theta), 6) // 1.0
    // …and it never banks: the width axis stays horizontal, so Z extent is exactly ±width/2
    const zs = mesh.positions.filter((_, i) => i % 3 === 2)
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([-0.5, 0.5])
  })

  it('a curved (planar arc) path keeps the deck level - not banked into the turn (the curved belt)', () => {
    const R = 2
    const ring = (a: number): Vec3 => [R * Math.cos(a), 0, R * Math.sin(a)]
    const path = [ring(0), ring(Math.PI / 4), ring(Math.PI / 2)] // a quarter turn
    const mesh = sweepProfileAlongPath(deckSection(1, 0.1), path)
    // the deck top (profile points 2,3 have up-offset 0, vertices 4..7 of each 8-vertex ring) stays at y = 0
    const M = 8
    for (let i = 0; i < path.length; i++) {
      for (const j of [4, 5, 6, 7]) {
        expect(mesh.positions[(i * M + j) * 3 + 1]).toBeCloseTo(0, 6)
      }
    }
  })

  it('sweepBedPath, straight and flat, spans a centred bed along +X (segments+1 stations)', () => {
    expect(sweepBedPath({ length: 3, segments: 1 }).map((s) => s[0])).toEqual([-1.5, 1.5])
    expect(sweepBedPath({ length: 3, segments: 3 }).map((s) => s[0])).toEqual([-1.5, -0.5, 0.5, 1.5])
  })

  it('sweepBedPath inclines the bed by tiltDeg (a climbing belt - the manifest can\'t)', () => {
    const p = sweepBedPath({ length: 2, tiltDeg: 30 }) // centred -1..+1 along the tilted direction
    expect(p[0]).toEqual([-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6), 0]) // near end, lowered
    expect(p[1]![1]).toBeCloseTo(Math.sin(Math.PI / 6), 6) // far end rose by sin30
  })

  it('sweepBedPath curves the bed around arcRadius, level + through the origin (a curved belt)', () => {
    const p = sweepBedPath({ length: Math.PI, arcRadius: 2, segments: 4 }) // quarter-ish arc
    expect(p).toHaveLength(5)
    expect(p[2]).toEqual([0, 0, 0]) // centre station sits at the origin (a=0)
    expect(p.every((s) => s[1] === 0)).toBe(true) // horizontal: stays level (y=0)
    expect(p[0]![2]).toBeLessThan(0) // bows toward −Z
    expect(p[4]![2]).toBeLessThan(0)
  })
})

describe('sweep end caps', () => {
  // an L section: a 5 mm x 300 mm guard sheet with a 20 mm outward return along its top. It is concave, the shape
  // the guard lip gives every swept guard, so a fan from one corner would draw a triangle across the notch
  const L: Array<[number, number]> = [[-0.005, 0], [-0.005, 0.005], [0.295, 0.005], [0.295, 0.025], [0.3, 0.025], [0.3, 0]]
  const areaOf = (poly: ReadonlyArray<readonly [number, number]>): number => {
    let a = 0
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!
      a += p[0] * q[1] - q[0] * p[1]
    }
    return Math.abs(a) / 2
  }

  it('ear clipping covers a concave section exactly (n - 2 triangles, same area, none across the notch)', () => {
    const tris = triangulatePolygon(L)
    expect(tris).toHaveLength(L.length - 2)
    const sum = tris.reduce((acc, [a, b, c]) => acc + areaOf([L[a]!, L[b]!, L[c]!]), 0)
    expect(sum).toBeCloseTo(areaOf(L), 12)
    // and the same for the section wound the other way round
    const rev = [...L].reverse()
    const sumRev = triangulatePolygon(rev).reduce((acc, [a, b, c]) => acc + areaOf([rev[a]!, rev[b]!, rev[c]!]), 0)
    expect(sumRev).toBeCloseTo(areaOf(L), 12)
  })

  it('caps are off by default, and on they close each end facing out of the solid', () => {
    const path: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0.5, 0]]
    const open = sweepProfileAlongPath(L, path)
    const capped = sweepProfileAlongPath(L, path, { caps: true })
    expect(capped.positions.length - open.positions.length).toBe(2 * L.length * 3)
    const extra = capped.indices.slice(open.indices.length)
    expect(extra.length).toBe(2 * (L.length - 2) * 3)
    const v = (i: number): Vec3 => [capped.positions[i * 3]!, capped.positions[i * 3 + 1]!, capped.positions[i * 3 + 2]!]
    const normalOf = (t: number): Vec3 => {
      const a = v(extra[t * 3]!), b = v(extra[t * 3 + 1]!), c = v(extra[t * 3 + 2]!)
      const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    }
    const per = L.length - 2
    // start cap faces back down the path (-X), end cap on along the last segment (+X, +Y)
    for (let t = 0; t < per; t++) expect(normalOf(t)[0]).toBeLessThan(0)
    for (let t = per; t < 2 * per; t++) {
      const nrm = normalOf(t)
      expect(nrm[0] + nrm[1] * 0.5).toBeGreaterThan(0)
    }
  })
})
