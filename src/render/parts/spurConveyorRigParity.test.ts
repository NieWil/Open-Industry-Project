import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { InstanceTransform, MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: SPUR_BEHAVIOR, geometry: SPUR_GEO } = examplePart<FuncGeo>('oip.spur-conveyor')
const { behavior: BELT_BEHAVIOR } = examplePart('oip.belt-conveyor')

// The Spur Belt Conveyor, authored on the geometry-function tier (docs/procedural-geometry.md) to match the
// built-in Spur Belt Conveyor. A spur has a splayed (parallelogram) deck so it merges flush at an angle: the
// geometry() staircases `conveyorCount` conveying strips across the width, each clipped to independent front/back
// splay faces, wraps a rounded nose on each strip end, and frames it with straight L-rails + toggleable guards +
// a tail leg. Realized here through core/geometry/geometryEval (render's in-layer evaluator, the same parts the sim
// builds from).
//
// The bed and steel are emitted as instanced templates (MeshPart.instances, the unitBox discipline). The strip
// loops are per-instance stretched copies of a 1 m fabric band + a nose-wrap band (data [uMul, uAdd, vMul, vAdd]
// chains the weave around each loop and slices the cross-belt v per strip). The rails/legs/bolts are copies of the
// same unit templates the straight belt conveyor emits, so every spur in a scene shares a handful of pooled
// geometries, several with the belts'. Assertions about extents therefore bake the instances through the
// template. (The *RigParity filename is historical.)

const geo = SPUR_GEO
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(SPUR_BEHAVIOR, params as never)
  if (!parts) throw new Error('spur geometry() returned no parts')
  return parts
}
const role = (parts: MeshPart[], r: string): MeshPart => {
  const p = parts.find((x) => x.finish === r)
  if (!p) throw new Error(`missing spur part: ${r}`)
  return p
}

// a guard side is two parts: the wall (collision:'box', which the host AABBs into the guard collider) and the
// formed top return (no collision: it would widen that AABB off the shared guard cross-section)
const walls = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'guard' && p.collision === 'box')
const lips = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'guard' && p.collision === undefined)
// every template vertex baked through every instance transform (scale ∘ quaternion ∘ translate) → flat xyz
const baked = (part: MeshPart): number[] => {
  const insts: readonly InstanceTransform[] = part.instances ?? [{ position: [0, 0, 0] }]
  const out: number[] = []
  for (const it of insts) {
    const [sx, sy, sz] = it.scale ?? [1, 1, 1]
    const [qx, qy, qz, qw] = it.quaternion ?? [0, 0, 0, 1]
    const pos = part.desc.positions
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]! * sx, y = pos[i + 1]! * sy, z = pos[i + 2]! * sz
      // v' = q v q*  (expanded)
      const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z
      const iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z
      const rx = ix * qw + iw * -qx + iy * -qz - iz * -qy
      const ry = iy * qw + iw * -qy + iz * -qx - ix * -qz
      const rz = iz * qw + iw * -qz + ix * -qy - iy * -qx
      out.push(rx + it.position[0], ry + it.position[1], rz + it.position[2])
    }
  }
  return out
}
// baked positions of every part with the role (the bed is two 'belt' banks: band strips + nose wraps)
const bakedRole = (parts: MeshPart[], r: string): number[] => {
  const out: number[] = []
  for (const p of parts.filter((x) => x.finish === r)) out.push(...baked(p))
  return out
}
const axisOf = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
const SPUR = { length: 2, width: 1.524, speed: 2, angleFrontDeg: 30, angleBackDeg: 0, conveyorCount: 20 }

describe('Spur Belt Conveyor (geometry-function tier - splayed parallelogram deck, straight-belt convey)', () => {
  it('is a valid function-geometry package whose behavior conveys (surface velocity) and emits geometry', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.spur-conveyor', name: 'Spur Belt Conveyor', params: {}, behavior: SPUR_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBe(true)
    expect(SPUR_BEHAVIOR).toContain('geometry(')
    expect(SPUR_BEHAVIOR).toContain('ctx.setSurfaceVelocity(')
  })

  it('realizes the full spur as multi-material parts: fabric bed banks + steel frame + guards + trestle leg + bolts', () => {
    const parts = realize(SPUR)
    expect(parts.filter((p) => p.finish === 'belt')).toHaveLength(2) // band strips + nose wraps, both banks
    expect(parts.some((p) => p.finish === 'frame')).toBe(true)
    expect(walls(parts)).toHaveLength(2) // left + right, each its own static submesh
    expect(lips(parts)).toHaveLength(2) // ...each with its top return
    expect(parts.some((p) => p.finish === 'leg')).toBe(true)
    expect(parts.some((p) => p.finish === 'bolt')).toBe(true)
    for (const p of parts) expect(p.desc.positions.length).toBeGreaterThan(0)
  })

  it('bed + steel are instance banks; only the gap-fill prism (+ caps) and the collision guards stay plain', () => {
    const parts = realize(SPUR)
    for (const p of parts) {
      if (p.finish === 'gapfill' || p.finish === 'guard') expect(p.instances).toBeUndefined()
      else expect((p.instances ?? []).length).toBeGreaterThan(0)
    }
    // 4 loop pieces per strip: 2 band runs + 2 nose wraps (20 strips at the default splay all survive)
    const [bands, wraps] = parts.filter((p) => p.finish === 'belt')
    expect(bands!.instances!.length).toBe(wraps!.instances!.length)
    expect(bands!.instances!.length).toBe(2 * 20)
    expect(role(parts, 'frame').instances!.length).toBe(2) // one rail piece per side
  })

  it('band/rail/leg/bolt templates are byte-identical to the belt conveyor’s (the cross-part pooling contract)', () => {
    const spur = realize(SPUR)
    const belt = evalPartGeometry(BELT_BEHAVIOR, { segments: [[3, 0]], width: 1.0, height: 0.17 } as never) // the belt's default height = the spur's fixed frame depth
    if (!belt) throw new Error('belt geometry() returned no parts')
    // belt emits its bed as [band, wraps] in that order; the spur mirrors it
    expect(role(spur, 'belt').desc.positions).toEqual(role(belt, 'belt').desc.positions)
    for (const r of ['frame', 'leg', 'bolt'] as const) {
      expect(role(spur, r).desc.positions).toEqual(role(belt, r).desc.positions)
    }
    // the nose wrap is the spur's own (16-segment, PR 0.085) - pooled across spurs, not with belts
    const spurWrap = spur.filter((p) => p.finish === 'belt')[1]!
    expect(spurWrap.desc.positions.length).toBe((16 + 1) * 2 * 3)
  })

  it('templates are param-independent - byte-identical across length/width/angles (the pooling contract)', () => {
    const a = realize(SPUR)
    const b = realize({ ...SPUR, length: 5, width: 2.2, angleFrontDeg: 45, angleBackDeg: -20, conveyorCount: 12 })
    const beltsA = a.filter((p) => p.finish === 'belt'), beltsB = b.filter((p) => p.finish === 'belt')
    expect(beltsA[0]!.desc.positions).toEqual(beltsB[0]!.desc.positions)
    expect(beltsA[1]!.desc.positions).toEqual(beltsB[1]!.desc.positions)
    for (const r of ['frame', 'leg', 'bolt'] as const) {
      expect(role(a, r).desc.positions).toEqual(role(b, r).desc.positions)
    }
  })

  it('belt-bank instances carry data [uMul, uAdd, vMul, vAdd] - u chains the loop, v slices the width', () => {
    const parts = realize(SPUR)
    const [bands, wraps] = parts.filter((p) => p.finish === 'belt')
    const wrapU = Math.PI * 0.085
    // first strip: back nose (seam, uAdd 0) → top run (uAdd wrapU) → front nose → bottom return
    const w0 = wraps!.instances![0]!, b0 = bands!.instances![0]!, w1 = wraps!.instances![1]!, b1 = bands!.instances![1]!
    const run = b0.data![0]!
    expect(w0.data!.slice(0, 2)).toEqual([1, 0])
    expect(b0.data![1]).toBeCloseTo(wrapU, 9)
    expect(w1.data![1]).toBeCloseTo(wrapU + run, 9)
    expect(b1.data![1]).toBeCloseTo(2 * wrapU + run, 9)
    // all four pieces of one strip share the same v slice, and the slices step across the width
    for (const piece of [b0, w0, w1, b1]) {
      expect(piece.data![2]).toBeCloseTo(b0.data![2]!, 9)
      expect(piece.data![3]).toBeCloseTo(b0.data![3]!, 9)
    }
    const nextStrip = bands!.instances![2]!
    expect(nextStrip.data![3]!).toBeGreaterThan(b0.data![3]!)
    expect(nextStrip.data![2]!).toBeGreaterThan(0)
    expect(nextStrip.data![3]! + nextStrip.data![2]!).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('the deck is centred on the origin with the conveying surface at y=0 (host flat deck lines up under it)', () => {
    const bed = bakedRole(realize(SPUR), 'belt')
    expect(Math.min(...axisOf(bed, 0))).toBeLessThan(0) // spans both sides of the origin (x ∈ [−L/2, …])
    expect(Math.max(...axisOf(bed, 1))).toBeCloseTo(0, 4) // top conveying surface at y=0
    expect(Math.min(...axisOf(bed, 1))).toBeLessThan(-0.15) // the loop wraps below (the 0.17 frame height)
  })

  it('the deck splays: the front (+X) end reaches further +X on the +Z side than the −Z side (parallelogram)', () => {
    const bed = bakedRole(realize(SPUR), 'belt')
    // the belt vertex furthest in +X is on the +Z (front-right) corner; the −Z corner of the front face is nearer
    let maxX = -Infinity, zAtMaxX = 0
    for (let i = 0; i < bed.length; i += 3) if (bed[i]! > maxX) { maxX = bed[i]!; zAtMaxX = bed[i + 2]! }
    expect(zAtMaxX).toBeGreaterThan(0) // the +30° front splay pushes the +Z edge out ahead of the −Z edge
    expect(maxX).toBeGreaterThan(1.0) // past the centred half-length (L/2 = 1.0) by the splay reach
  })

  it('angleFrontDeg drives the splay - a larger front angle reaches further +X', () => {
    const frontReach = (a: number): number => Math.max(...axisOf(bakedRole(realize({ ...SPUR, angleFrontDeg: a }), 'belt'), 0))
    expect(frontReach(45)).toBeGreaterThan(frontReach(30) + 0.1)
    expect(frontReach(0)).toBeLessThan(frontReach(30)) // a square front (0°) doesn't splay
  })

  it('front and back angles are independent - angleBackDeg shears the −X end while the front reach is unchanged', () => {
    const back = (a: number): number => Math.min(...axisOf(bakedRole(realize({ ...SPUR, angleBackDeg: a }), 'belt'), 0))
    const front = (a: number): number => Math.max(...axisOf(bakedRole(realize({ ...SPUR, angleBackDeg: a }), 'belt'), 0))
    expect(back(40)).toBeLessThan(back(0) - 0.3) // a back splay pushes the −X end out (independent of the front)
    expect(front(40)).toBeCloseTo(front(0), 5) // …and leaves the front (+X) reach exactly where it was
  })

  it('per-side guard toggles - leftGuard:false drops the −Z guard; both off ⇒ no guard parts', () => {
    const one = realize({ ...SPUR, leftGuard: false })
    expect(walls(one)).toHaveLength(1)
    expect(lips(one)).toHaveLength(1)
    expect(realize({ ...SPUR, leftGuard: false, rightGuard: false }).filter((p) => p.finish === 'guard')).toHaveLength(0)
  })

  it('guard walls are declared collision:"static" and stay plain meshes (the AABB channel the host realizes as walls)', () => {
    const parts = realize(SPUR)
    // every guard part is a wall or its return, and a return never collides
    expect(walls(parts).length + lips(parts).length).toBe(parts.filter((p) => p.finish === 'guard').length)
    for (const gpart of walls(parts)) {
      // the host's addFunctionStaticBoxes takes the AABB of desc.positions directly, so an instanced guard
      // would collide as its unit template. Keep guards plain until the sim bakes instances.
      expect(gpart.instances).toBeUndefined()
    }
  })

  it('is deterministic - identical params → byte-identical bed templates and instances', () => {
    const beltsOf = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'belt')
    const a = beltsOf(realize(SPUR)), b = beltsOf(realize(SPUR))
    expect(a.map((p) => p.desc.positions)).toEqual(b.map((p) => p.desc.positions))
    expect(a.map((p) => p.instances)).toEqual(b.map((p) => p.instances))
  })

  it('each strip is a full belt loop - the fabric wraps a rounded nose at the strip end', () => {
    // the quarter-arc point of the first strip's front nose exists on a rounded wrap. A slab+drum bed
    // has only 36°-grid drum facets (10 segments), nothing within 6 mm of the 45° point.
    const p = SPUR
    const hw = p.width / 2
    const cw = p.width / p.conveyorCount
    const zc = -hw + cw / 2
    const fX = p.length / 2 + Math.tan((p.angleFrontDeg * Math.PI) / 180) * zc
    const r = 0.085 // nose wrap radius: half the 0.17 frame height
    const target = { x: fX - r + r * Math.sin(Math.PI / 4), y: -r + r * Math.cos(Math.PI / 4) }
    const pos = bakedRole(realize(p), 'belt')
    let best = Infinity
    for (let i = 0; i < pos.length; i += 3) best = Math.min(best, Math.hypot(pos[i]! - target.x, pos[i + 1]! - target.y))
    expect(best).toBeLessThan(0.006)
  })

  it('strip sides are white-metal caps in the gapfill part - outer walls embed mid-rail', () => {
    const hw = SPUR.width / 2
    const gf = role(realize(SPUR), 'gapfill').desc.positions
    // the first strip's flat outer wall sits on the mid-rail plane z = −(width/2 + wall/2), inside the
    // rail (an inset), never coplanar with its faces. The gap-fill prism alone only reaches
    // ±(hw − 0.002), so this vertex proves the caps merged in.
    let found = false
    for (let i = 0; i < gf.length; i += 3) if (Math.abs(gf[i + 2]! + (hw + 0.005)) < 1e-6) { found = true; break }
    expect(found).toBe(true)
    expect(gf.length / 3).toBeGreaterThan(100) // prism (24 per-face verts) + per-strip capsule fans + outer walls
  })

  it('the length face handle declares the spur (angleFrontParam/angleBackParam) - the host-recognition marker', () => {
    // the marker the spur bed's view keys on: without it the host would treat the part as a plain straight
    // conveyor (square ends, rectangular footprint, no host guard opening, no snap extents).
    expect(SPUR_BEHAVIOR).toMatch(/angleFrontParam:\s*'angleFrontDeg'/)
    expect(SPUR_BEHAVIOR).toMatch(/angleBackParam:\s*'angleBackDeg'/)
  })

  it('host-fed guardExtents rows extend that side’s rail + guard to the given ends (merge-junction reach)', () => {
    const hw = SPUR.width / 2
    // furthest +X point of a role's baked geometry on one side of the bed (sign of local z). Guards are one
    // part per side; the 'frame' part is one instanced bank, so baked vertices are split by their z sign.
    const sideMaxX = (parts: MeshPart[], r: string, sign: 1 | -1): number => {
      let max = -Infinity
      const pos = bakedRole(parts, r)
      for (let i = 0; i < pos.length; i += 3) if (Math.sign(pos[i + 2]!) === sign && pos[i]! > max) max = pos[i]!
      return max
    }
    // default: the +Z rail/guard front ends at the splayed face x = L/2 + tan30°·hw ≈ 1.44
    const plain = realize(SPUR)
    const defFront = 1 + Math.tan(Math.PI / 6) * hw
    expect(sideMaxX(plain, 'guard', 1)).toBeCloseTo(defFront, 2)
    // a host-fed row [side +1, back −1, front 2.0] extends only the +Z side out to x = 2.0
    const extended = realize({ ...SPUR, guardExtents: [[1, -1, 2.0]] })
    expect(sideMaxX(extended, 'guard', 1)).toBeCloseTo(2.0, 3)
    expect(sideMaxX(extended, 'frame', 1)).toBeCloseTo(2.0, 3)
    // the −Z side keeps its own splayed face (the 30° shear reaches shorter on −Z: x = L/2 − tan30°·hw)
    expect(sideMaxX(extended, 'guard', -1)).toBeCloseTo(1 - Math.tan(Math.PI / 6) * hw, 2)
  })
})
