import { describe, expect, it } from 'vitest'
import { resolvedBoxSize } from '../../core/rig/rigPose'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: CHAIN_TRANSFER_RIG, behavior: CHAIN_TRANSFER_BEHAVIOR, head: CHAIN_TRANSFER_HEAD } = examplePart<RigGeo>('oip.chain-transfer')

// The Chain Transfer (right-angle transfer), authored as a custom part (examples/parts/chain-transfer). It
// redirects cargo 90° with no new capability: one `conveys` deck whose direction the behavior switches, + a
// bank of chain lanes on a prismatic `lift` joint that pop up when diverting. This checks the rig (the
// conveying deck, the lift joint) and the lanes its geometry() draws: SDK code on the chainBank link, the
// chain one scrolling loop (MeshPart.scroll) at 16 links a metre.

const geo = CHAIN_TRANSFER_RIG
const link = (name: string) => geo.links.find((l) => l.name === name)!
const lanes = (params: Record<string, number>): MeshPart[] => evalPartGeometry(CHAIN_TRANSFER_BEHAVIOR, params) ?? []
const part = (ps: MeshPart[], material: string): MeshPart => ps.find((p) => p.material === material)!
const pts = (p: MeshPart): [number, number, number][] => {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < p.desc.positions.length; i += 3) out.push([p.desc.positions[i]!, p.desc.positions[i + 1]!, p.desc.positions[i + 2]!])
  return out
}

describe('Chain Transfer custom-part rig - switchable deck + liftable chain lanes', () => {
  it('is a structurally valid package (rig + the switch/lift behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.chain-transfer', name: 'Chain Transfer', params: {}, behavior: "definePart({ joints:['lift'], step(ctx){ ctx.setSurfaceVelocity({x:1,y:0,z:0}); ctx.joints.lift = 0 } })", geometry: geo })).toEqual([])
  })

  it('has a single conveying deck (the cargo surface, switched between through/divert), hidden, riding the lift', () => {
    const deck = link('deck')
    expect(deck.conveys).toBe(true)
    expect(deck.shape.kind).toBe('box')
    expect(deck.hidden).toBe(true) // physics-only; the drawn lanes provide the frame
    // the deck is parented to the 'lift' bank so it physically pops up with the chains (the sim builds a
    // joint-driven conveying deck kinematic): a real lift onto the chains, not just a direction switch on a flat plane.
    expect(deck.parent).toBe('chainBank')
  })

  it('the chain lanes are drawn by geometry() on the lift bank: three submeshes, one lane per chain, spaced by `distance`', () => {
    expect(geo.joints).toHaveLength(1)
    expect(geo.joints[0]!.name).toBe('lift')
    expect(geo.joints[0]!.type).toBe('prismatic')
    expect(geo.joints[0]!.axis).toEqual([0, 1, 0]) // chains pop up
    expect(geo.joints[0]!.link).toBe('chainBank')
    // Stroke parity: the chain assembly raises 0.095 m
    expect(geo.joints[0]!.max).toBeCloseTo(0.095, 10)
    expect(geo.links.some((l) => (l.shape.kind as string) === 'chain')).toBe(false) // no engine-drawn chain lane
    const parts = lanes({ chains: 5, distance: 0.33 })
    // every lane merged per material - three draws however many chains - all riding the lift
    expect(parts.map((p) => p.material).sort()).toEqual(['chain', 'frame', 'support'])
    for (const p of parts) expect(p.link).toBe('chainBank')
    expect(parts.find((p) => p.material === 'chain')!.scroll).toEqual({ tilesPerMeter: 16 })
    // one lane per chain, centred, `distance` apart along the part's X (the through axis)
    const centres = (params: Record<string, number>): number[] => {
      // cluster the chain's vertices by lane (lanes are far apart, a chain is 14 mm wide) and take each midpoint
      const xs = pts(part(lanes(params), 'chain')).map((q) => q[0]).sort((a, b) => a - b)
      const out: number[] = []
      let lo = xs[0]!, prev = xs[0]!
      for (const x of xs.slice(1).concat(Infinity)) {
        if (x - prev > 0.05) { out.push(+((lo + prev) / 2).toFixed(4)); lo = x }
        prev = x
      }
      return out
    }
    expect(centres({ chains: 5, distance: 0.33 })).toEqual([-0.66, -0.33, 0, 0.33, 0.66])
    expect(centres({ chains: 3, distance: 0.5 })).toEqual([-0.5, 0, 0.5])
  })

  it('each lane measures laneLength overall, and its ends keep their own size: a round sprocket at any length', () => {
    for (const laneLength of [2, 1, 0.6]) {
      const ps = lanes({ chains: 1, laneLength })
      const frameZ = pts(part(ps, 'frame')).map((q) => q[2])
      expect(Math.max(...frameZ)).toBeCloseTo(laneLength / 2, 4) // the feet's flange is the lane's outer end
      expect(Math.min(...frameZ)).toBeCloseTo(-laneLength / 2, 4)
      // one sprocket: its extent along the lane (part Z) equals its extent in height - round, never squashed
      const sprocket = pts(part(ps, 'support')).filter((q) => q[2] > 0)
      const span = (k: 1 | 2) => Math.max(...sprocket.map((q) => q[k])) - Math.min(...sprocket.map((q) => q[k]))
      expect(span(2)).toBeCloseTo(span(1), 3)
      expect(span(1)).toBeCloseTo(2 * 0.07485, 3)
    }
  })

  it('the chain loop is laid out at 16 links a metre, and its top run carries toward −Z (the divert direction)', () => {
    for (const laneLength of [2, 0.6]) {
      const chain = part(lanes({ chains: 1, laneLength }), 'chain')
      const p = pts(chain)
      // the top run's crown: the vertices at the very top of the loop
      const topY = Math.max(...p.map((q) => q[1]))
      const top = p.map((q, i) => ({ z: q[2], u: chain.desc.uvs[i * 2]! })).filter((_, i) => p[i]![1] > topY - 1e-6)
      const a = top.reduce((m, q) => (q.z < m.z ? q : m)), b = top.reduce((m, q) => (q.z > m.z ? q : m))
      // U (texture tiles) grows toward −Z at 16 a metre: the pattern, which scrolls toward +U, runs with the cargo
      expect((a.u - b.u) / (b.z - a.z)).toBeCloseTo(16, 6)
    }
  })

  it('the conveying deck sizes X (through/main-line axis) = chains × distance and Z (divert axis) = laneLength', () => {
    const deck = link('deck')
    expect(deck.shape.kind).toBe('box')
    const size = (params: Record<string, number>) =>
      resolvedBoxSize((deck.shape as { size: [number, number, number] }).size, (deck.shape as { sizeParams?: Parameters<typeof resolvedBoxSize>[1] }).sizeParams, params)
    // X = the bank spread across the lanes (chains × distance); this is the forward/through axis of the part.
    expect(size({ chains: 5, distance: 0.33, laneLength: 2 })[0]).toBeCloseTo(1.65, 10) // the authored default
    expect(size({ chains: 4, distance: 0.5, laneLength: 2 })[0]).toBeCloseTo(2, 10) // spacing edits re-track the bed
    // Z = the lane length (divert axis), tracking laneLength
    expect(size({ chains: 5, distance: 0.33, laneLength: 2.4 })[2]).toBeCloseTo(2.4, 10)
  })

  it("declares placement (the manifest's track lanes snap) + interaction in the behavior (use() toggle, tween)", () => {
    // the declarative track snap: lane-parity anchor + adopt host pitch into `distance` + lane-length auto-fit
    expect(CHAIN_TRANSFER_HEAD.snap?.track).toMatchObject({ lanes: { countParam: 'chains', pitchParam: 'distance' }, fitWidthParam: 'laneLength' })
    // pilot Use/click toggles the pop-up; the lift tweens (0.095 m / 0.15 s)
    expect(CHAIN_TRANSFER_BEHAVIOR).toContain('interactive: true')
    expect(CHAIN_TRANSFER_BEHAVIOR).toContain('ctx.used()')
    expect(CHAIN_TRANSFER_BEHAVIOR).toContain('ctx.approach(lift')
  })
})
