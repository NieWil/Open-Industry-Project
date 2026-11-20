import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { instantiatePartScript } from '../../core/parts/partScript'
import { linkHalfExtents } from '../../core/rig/rigPose'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: FENCE_BEHAVIOR, geometry: FENCE_RIG, materials: FENCE_MATS } = examplePart<RigGeo>('oip.fence')

// The Fence, matching the built-in exactly (render/parts/fence.ts): yellow posts (each with a cap) auto-spaced
// along the length, and a black wire-mesh grid (per-span frame rect + vertical/horizontal wires), not a solid
// slab. The behavior's geometry() emits the visible mesh procedurally and it is attached to the rig root. A
// single hidden full-span box (the 'barrier' link) is the collision (world.addBarrier).

const geo = FENCE_RIG
const barrier = geo.links.find((l) => l.name === 'barrier')!
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(FENCE_BEHAVIOR, params as never)
  if (!parts) throw new Error('fence geometry() returned no parts')
  return parts
}
const byMat = (parts: MeshPart[], id: string): MeshPart => {
  const p = parts.find((x) => x.material === id)
  if (!p) throw new Error(`missing fence submesh with material: ${id}`)
  return p
}
const axis = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
const tris = (p: MeshPart): number => p.desc.indices.length / 3
const verts = (p: MeshPart): number => p.desc.positions.length / 3
const DEF = { length: 4, height: 2, postColor: '#f2bd0f', meshColor: '#0d0d0d', omitPostStart: false, omitPostEnd: false }

describe('Fence custom-part rig - exact parity via procedural wire-mesh geometry', () => {
  it('is a structurally valid package (rig + a geometry()/no-op behavior + PBR materials)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.fence', name: 'Fence', params: {}, behavior: FENCE_BEHAVIOR, geometry: geo, materials: FENCE_MATS })).toEqual([])
  })

  it('collides with one hidden full-span barrier box (world.addBarrier), no per-post bodies', () => {
    expect(geo.links).toHaveLength(1)
    expect(barrier.hidden).toBe(true) // rendered as the wire mesh instead; the box is collision-only
    const he = linkHalfExtents(barrier, { length: 8, height: 2.4 })
    expect(he[0]).toBeCloseTo(4, 6) // length/2
    expect(he[1]).toBeCloseTo(1.2, 6) // height/2
    expect(he[2]).toBeCloseTo(0.03, 6) // FENCE_POST_SIZE/2 - the built-in barrier depth
  })

  it('emits two root submeshes - yellow posts + the dark mesh - each tinted by its colour param', () => {
    const parts = realize(DEF)
    expect(parts).toHaveLength(2)
    const posts = byMat(parts, 'postMetal')
    const mesh = byMat(parts, 'meshMetal')
    expect(posts.colorParam).toBe('postColor')
    expect(mesh.colorParam).toBe('meshColor')
    // untagged ⇒ the static rig root (only the gate leaf uses MeshPart.link)
    expect(posts.link).toBeUndefined()
    expect(mesh.link).toBeUndefined()
  })

  it('draws a real wire-mesh grid (hundreds of triangles), not a 12-triangle slab', () => {
    expect(tris(byMat(realize(DEF), 'meshMetal'))).toBeGreaterThan(80)
  })

  it('auto-spaces the posts along the length (more length → more posts)', () => {
    // numSpans = ceil(length / 1.5); posts = numSpans + 1 (each an identical box), so vertex count is monotonic
    expect(verts(byMat(realize({ ...DEF, length: 12 }), 'postMetal'))).toBeGreaterThan(verts(byMat(realize({ ...DEF, length: 4 }), 'postMetal')))
  })

  it('omits an end post when asked (a snapped corner neighbour supplies it) - dropping a post + its cap', () => {
    const full = realize(DEF)
    const noStart = realize({ ...DEF, omitPostStart: true })
    // one fewer post box (postMetal) and one fewer cap box (meshMetal)
    expect(verts(byMat(noStart, 'postMetal'))).toBeLessThan(verts(byMat(full, 'postMetal')))
    expect(verts(byMat(noStart, 'meshMetal'))).toBeLessThan(verts(byMat(full, 'meshMetal')))
    // the dropped post is the leftmost (−length/2): the remaining posts start further right
    expect(Math.min(...axis(byMat(noStart, 'postMetal').desc.positions, 0))).toBeGreaterThan(Math.min(...axis(byMat(full, 'postMetal').desc.positions, 0)))
  })

  it('spans the full length × height (mesh x ∈ [−L/2, L/2]; y from the floor to just above the top, with caps)', () => {
    const mesh = byMat(realize({ ...DEF, length: 6, height: 3 }), 'meshMetal').desc
    const xs = axis(mesh.positions, 0)
    const ys = axis(mesh.positions, 1)
    // ±L/2, plus the end post's cap and floor anchors, which stay on its 0.12 m foot plate
    expect(Math.min(...xs)).toBeLessThan(-3 + 0.001)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-3 - 0.06)
    expect(Math.max(...xs)).toBeGreaterThan(3 - 0.001)
    expect(Math.max(...xs)).toBeLessThanOrEqual(3 + 0.06)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.001) // never sinks below the floor
    expect(Math.max(...ys)).toBeCloseTo(3 + 0.03, 2) // the post caps top out at height + FENCE_CAP_HEIGHT
  })

  it('declares the X (length) + Y (height) face resize handles - the viewport resize dots', () => {
    const { def } = instantiatePartScript(FENCE_BEHAVIOR)
    if (!def?.params) throw new Error('behavior failed to instantiate')
    // without these the fence gets no resize gizmo at all (effectiveResize reads the declared handles,
    // docs/part-gizmos.md). It has no width param, so Z stays fixed at the barrier depth
    expect(def.params.length).toMatchObject({ type: 'number', handle: { kind: 'face', axis: 'x' } })
    expect(def.params.height).toMatchObject({ type: 'number', handle: { kind: 'face', axis: 'y' } })
    expect(def.params.width).toBeUndefined()
  })

  it('is deterministic - identical params → byte-identical geometry', () => {
    expect(byMat(realize(DEF), 'meshMetal').desc.positions).toEqual(byMat(realize(DEF), 'meshMetal').desc.positions)
  })
})
