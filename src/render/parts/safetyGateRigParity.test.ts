import { describe, expect, it } from 'vitest'
import { linkHalfExtents, rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: GATE_BEHAVIOR, geometry: SAFETY_GATE_RIG, materials: GATE_MATS } = examplePart<RigGeo>('oip.safety-gate')

// The Safety Gate, authored for exact parity with the built-in (render/parts/safetyGate.ts +
// world.addSafetyGate): posts + caps flanking a swinging wire-mesh leaf with a red e-stop handle, hinged at the
// −X post. It proves procedural rig-link geometry on a moving link: geometry() emits the leaf wire mesh + e-stop
// tagged MeshPart.link:'hinge', so they follow the revolute joint; the leaf's hidden box is the (only) collision.
// Posts/caps are geometry() on the rig root (static). The rig itself is just hinge + leaf + the swing joint.

const geo = SAFETY_GATE_RIG
const GAP = 0.06 * 0.5 + 0.01 // SAFETY_GATE_LEAF_GAP
const poses = (length: number, swing: number) => rigWorldPoses(geo, { swing }, undefined, 1, { length })
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(GATE_BEHAVIOR, params as never)
  if (!parts) throw new Error('safety-gate geometry() returned no parts')
  return parts
}
const find = (parts: MeshPart[], material: string, link?: string): MeshPart => {
  const p = parts.find((x) => x.material === material && x.link === link)
  if (!p) throw new Error(`missing gate submesh material=${material} link=${link}`)
  return p
}
const axis = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
const verts = (p: MeshPart): number => p.desc.positions.length / 3
const DEF = { length: 1, open: false, postColor: '#f2bd0f', meshColor: '#0d0d0d', handleColor: '#c91717', omitPostStart: false, omitPostEnd: false }

describe('Safety Gate custom-part rig - exact parity via procedural geometry on a swinging link', () => {
  it('is a structurally valid package (rig + a jointed geometry() behavior + PBR materials)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.safety-gate', name: 'Safety Gate', params: {}, behavior: GATE_BEHAVIOR, geometry: geo, materials: GATE_MATS })).toEqual([])
  })

  it('is a hinge + a hidden collision leaf + a full-span interact volume, swung by a revolute joint', () => {
    expect(geo.links.map((l) => l.name).sort()).toEqual(['hinge', 'interact', 'leaf'])
    expect(geo.links.find((l) => l.name === 'leaf')!.hidden).toBe(true) // collision-only; the wire mesh dresses it
    // the full-span Use/pick volume: hidden (invisible but still raycast) + collision: 'none', on the root so it never
    // swings. You can aim at the opening to toggle the gate when the leaf has swung away, and cargo still
    // passes the open gap.
    const interact = geo.links.find((l) => l.name === 'interact')!
    expect(interact.hidden).toBe(true)
    expect(interact.collision).toBe('none')
    expect(interact.parent).toBeUndefined() // on the root - never swings with the leaf
    expect(linkHalfExtents(interact, { length: 3 })[0]).toBeCloseTo(1.5, 6) // full length (spans the whole opening)
    expect(geo.joints).toHaveLength(1)
    expect(geo.joints[0]).toMatchObject({ name: 'swing', link: 'hinge', type: 'revolute', axis: [0, 1, 0] })
  })

  it('positions the hinge at −length/2 and the closed leaf at the part origin; spans length − 2·GAP', () => {
    for (const length of [1, 2, 3.5]) {
      const p = poses(length, 0)
      expect(p.get('hinge')!.pos[0]).toBeCloseTo(-length / 2, 6)
      expect(p.get('leaf')!.pos[0]).toBeCloseTo(0, 6) // hinge −L/2 + leaf +L/2 = centred when closed
      expect(linkHalfExtents(geo.links.find((l) => l.name === 'leaf')!, { length })[0]).toBeCloseTo((length - 2 * GAP) / 2, 6)
    }
  })

  it('swings the leaf about the −X hinge when opened (revolute joint)', () => {
    // open 90° about +Y: the leaf (closed at the origin, +length/2 from the hinge) swings to x=−length/2, z=−length/2
    const open = poses(2, Math.PI / 2)
    expect(open.get('leaf')!.pos[0]).toBeCloseTo(-1, 5)
    expect(open.get('leaf')!.pos[2]).toBeCloseTo(-1, 5)
  })

  it('emits the leaf wire mesh + e-stop handle tagged to the swinging hinge frame (MeshPart.link)', () => {
    const parts = realize(DEF)
    // posts + caps sit on the root (static); the leaf panel + e-stop hang off the visible 'hinge' frame (the hidden
    // 'leaf' box is collision-only, so a mesh attached there would inherit its invisibility)
    expect(find(parts, 'postMetal', undefined).colorParam).toBe('postColor')
    expect(find(parts, 'meshMetal', undefined).colorParam).toBe('meshColor') // caps
    const leaf = find(parts, 'meshMetal', 'hinge')
    const handle = find(parts, 'handleMetal', 'hinge')
    expect(leaf.link).toBe('hinge')
    expect(handle.link).toBe('hinge')
    expect(handle.colorParam).toBe('handleColor')
    // the leaf is a real wire-mesh grid, not a slab
    expect(leaf.desc.indices.length / 3).toBeGreaterThan(60)
  })

  it('emits the leaf mesh in the hinge local frame (x ∈ [GAP, length−GAP], y ∈ [INSET, H−INSET]) so it swings', () => {
    // the hinge sits at the −X post; its local coords are the built-in leaf frame, so the panel runs from GAP to
    // length−GAP (swinging about the hinge origin gives the built-in's leaf pivot)
    const leaf = find(realize({ ...DEF, length: 2 }), 'meshMetal', 'hinge').desc
    const xs = axis(leaf.positions, 0)
    const ys = axis(leaf.positions, 1)
    // the leaf's hinge knuckles wrap the swing axis itself (x = 0 in this frame): a hex 0.09 across flats, flats
    // facing X. The panel's own frame starts at the hinge + GAP
    expect(Math.min(...xs)).toBeCloseTo(-0.09 / 2, 3)
    expect(xs.some((x) => Math.abs(x - (GAP - 0.015)) < 1e-6)).toBe(true) // the frame bar's hinge-side face
    expect(Math.max(...xs)).toBeCloseTo(2 - GAP, 1) // ends at length − GAP
    expect(Math.min(...ys)).toBeCloseTo(0.08, 1) // INSET
    expect(Math.max(...ys)).toBeCloseTo(2 - 0.08, 1) // H − INSET
  })

  it('omits an end post + its cap when asked (a snapped corner neighbour supplies it)', () => {
    expect(verts(find(realize({ ...DEF, omitPostStart: true }), 'postMetal', undefined))).toBeLessThan(verts(find(realize(DEF), 'postMetal', undefined)))
    expect(verts(find(realize({ ...DEF, omitPostStart: true }), 'meshMetal', undefined))).toBeLessThan(verts(find(realize(DEF), 'meshMetal', undefined)))
  })

  it('is deterministic - identical params → byte-identical leaf geometry', () => {
    expect(find(realize(DEF), 'meshMetal', 'hinge').desc.positions).toEqual(find(realize(DEF), 'meshMetal', 'hinge').desc.positions)
  })
})
