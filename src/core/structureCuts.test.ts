import { describe, expect, it } from 'vitest'
import { applyPlatformCut, applyStairLift } from './structureCuts'
import type { PartPackage } from './parts/partPackage'

type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

// a minimal platform-shaped rig: a deck + one rail/post pair on the +X edge (opened) and the +Z edge
// (untouched), each tagged with the declarative `onEdge` marker the cut keys on
function platformGeo(): RigGeo {
  return {
    kind: 'rig',
    joints: [],
    links: [
      { name: 'deck', shape: { kind: 'box', size: [4, 0.006, 4], sizeParams: [{ axis: 0, param: 'length' }, { axis: 2, param: 'width' }] }, offset: [0, -0.003, 0], finish: 'deck', notchable: true },
      { name: 'railTopXP', onEdge: 'posX', shape: { kind: 'box', size: [0.032, 0.032, 4], sizeParams: [{ axis: 2, param: 'width' }] }, offset: [2, 1.07, 0] },
      { name: 'postXP', onEdge: 'posX', shape: { kind: 'box', size: [0.04, 1.07, 0.04] }, offset: [2, 0.535, 0], array: { distribute: { axis: 2, spanParam: 'width', maxSpacing: 2.4 } } },
      // the collision wall carries a visibility toggle (showRailings), like the shipped platform's rails/toe/
      // wall - a single box, which must split (never skip-drop, or the whole side vanishes)
      { name: 'wallXP', onEdge: 'posX', shape: { kind: 'box', size: [0.06, 1.07, 4], sizeParams: [{ axis: 2, param: 'width' }] }, offset: [2, 0.535, 0], showParam: 'showRailings' },
      { name: 'railTopZP', onEdge: 'posZ', shape: { kind: 'box', size: [4, 0.032, 0.032], sizeParams: [{ axis: 0, param: 'length' }] }, offset: [0, 1.07, 2] },
    ],
  } as unknown as RigGeo
}

describe('applyPlatformCut - railing gap + deck notch', () => {
  const params = { length: 4, width: 4 }

  it('splits the opened edge rail into the solid segments left by the gap', () => {
    const cut = { openings: { posX: [[-0.6, 0.6] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const out = applyPlatformCut(platformGeo(), cut, params)
    const segs = out.links.filter((l) => l.name.startsWith('railTopXP_seg'))
    expect(segs).toHaveLength(2) // [-2,-0.6] and [0.6,2]
    const s0 = segs.find((l) => (l.shape as { size: number[] }).size)!
    // each segment is 1.4 long along Z, centred at ±1.3
    for (const s of segs) {
      const sh = s.shape as { size: number[] }
      expect(sh.size[2]).toBeCloseTo(1.4, 6)
      expect(Math.abs(s.offset[2])).toBeCloseTo(1.3, 6)
    }
    void s0
  })

  it('drops the perimeter post standing in the gap and frames the gap with a post at each opening edge', () => {
    const cut = { openings: { posX: [[-0.6, 0.6] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const out = applyPlatformCut(platformGeo(), cut, params)
    const posts = out.links.filter((l) => l.name.startsWith('postXP_i'))
    // distribute over width 4 @ maxSpacing 2.4 → 3 posts at z = -2, 0, +2; the z=0 one falls in the gap → dropped
    expect(posts).toHaveLength(2)
    expect(posts.every((p) => Math.abs(p.offset[2]) > 1)).toBe(true)
    expect(out.links.find((l) => l.name === 'postXP')).toBeUndefined() // array replaced by explicit links
    // gap framing posts at the opening edges (±0.6): each solid segment is rebuilt with end posts,
    // which the arriving stair handrail meets visually
    const framing = out.links.filter((l) => l.name.startsWith('postXP_b'))
    expect(framing.map((p) => p.offset[2]).sort((a, b) => a - b)).toEqual([-0.6, 0.6])
  })

  it('adds no framing post where a kept grid post already stands, nor past the array span', () => {
    // opening [-0.6, 1.96]: drops the z=0 post; edge 1.96 sits within 0.06 of the kept z=2 grid post → merged.
    const merge = { openings: { posX: [[-0.6, 1.96] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const outM = applyPlatformCut(platformGeo(), merge, params)
    expect(outM.links.filter((l) => l.name.startsWith('postXP_b')).map((p) => p.offset[2])).toEqual([-0.6])
    // opening [1.5, 2.5] runs past the deck corner: drops z=2; edge 2.5 is past the array span → no post there.
    const span = { openings: { posX: [[1.5, 2.5] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const outS = applyPlatformCut(platformGeo(), span, params)
    expect(outS.links.filter((l) => l.name.startsWith('postXP_b')).map((p) => p.offset[2])).toEqual([1.5])
  })

  it('leaves an un-opened edge and (with no notch) the deck untouched', () => {
    const cut = { openings: { posX: [[-0.6, 0.6] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const out = applyPlatformCut(platformGeo(), cut, params)
    expect(out.links.find((l) => l.name === 'railTopZP')).toBeTruthy() // +Z edge intact
    expect(out.links.find((l) => l.name === 'deck')).toBeTruthy()
  })

  it('carves the deck into complement strips around a notch', () => {
    const cut = { openings: { posX: [], negX: [], posZ: [], negZ: [] }, notches: [{ x0: -1, x1: 1, z0: -0.6, z1: 0.6 }] }
    const out = applyPlatformCut(platformGeo(), cut, params)
    const strips = out.links.filter((l) => l.name.startsWith('deck_strip'))
    expect(strips).toHaveLength(4) // left/right/front/back
    expect(out.links.find((l) => l.name === 'deck')).toBeUndefined()
    // no strip covers the notch interior
    for (const s of strips) {
      const sh = s.shape as { size: number[] }
      const coversHole = Math.abs(s.offset[0]) < 1 - 1e-3 && Math.abs(s.offset[2]) < 0.6 - 1e-3 && (sh.size[0] ?? 0) > 0 && (sh.size[2] ?? 0) > 0
      expect(coversHole).toBe(false)
    }
  })

  it('splits a toggleable (showRailings) rail/wall link into segments - never skip-drops the whole side', () => {
    const cut = { openings: { posX: [[-0.6, 0.6] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const out = applyPlatformCut(platformGeo(), cut, params)
    const segs = out.links.filter((l) => l.name.startsWith('wallXP_seg'))
    expect(segs).toHaveLength(2) // the whole-side deletion bug: one origin "instance" fell inside the gap
    for (const s of segs) {
      expect((s.shape as { size: number[] }).size[2]).toBeCloseTo(1.4, 6)
      expect(s.showParam).toBe('showRailings') // the visibility toggle survives the split
      expect(s.array).toBeUndefined()
    }
    expect(out.links.find((l) => l.name === 'wallXP')).toBeUndefined()
  })

  it('is a no-op when there are no openings or notches', () => {
    const out = applyPlatformCut(platformGeo(), { openings: { posX: [], negX: [], posZ: [], negZ: [] }, notches: [] }, params)
    expect(out.links.map((l) => l.name).sort()).toEqual(['deck', 'postXP', 'railTopXP', 'railTopZP', 'wallXP'])
  })

  it('never cuts an untagged link, whatever its name - the cut keys on the onEdge marker only', () => {
    const geo = platformGeo()
    for (const l of geo.links) delete (l as { onEdge?: string }).onEdge
    const cut = { openings: { posX: [[-0.6, 0.6] as [number, number]], negX: [], posZ: [], negZ: [] }, notches: [] }
    const out = applyPlatformCut(geo, cut, params)
    expect(out.links.map((l) => l.name).sort()).toEqual(['deck', 'postXP', 'railTopXP', 'railTopZP', 'wallXP'])
  })
})

// a minimal stairs-shaped rig: a landing plate (param-driven Y), a static-Y post, floor-anchored (`anchor: 'floor'`)
// links (a newel box + a riser array), and the tread array. The whole flight lifts; the foot stays on the floor
function stairGeo(): RigGeo {
  return {
    kind: 'rig',
    joints: [],
    links: [
      // landing plate - Y rides an axis-1 offset param (the lift bumps its `add`)
      { name: 'landing', shape: { kind: 'box', size: [0.6, 0.05, 1.2] }, offset: [3.5, 1.958, 0], offsetParams: [{ axis: 0, param: 'numSteps', scale: 0.28, add: 0.3 }, { axis: 1, param: 'numSteps', scale: 0.178, add: 0 }] },
      // a link without a y param - the lift bumps its static offset[1] instead
      { name: 'post', shape: { kind: 'box', size: [0.04, 1.07, 0.04] }, offset: [3.5, 2.5, 0] },
      // the stepped flight lifts like everything else (the whole top plane must end up flush)
      { name: 'tread', shape: { kind: 'box', size: [0.3, 0.05, 1.2] }, offset: [0.14, 0.178, 0], array: { count: 'numSteps', step: [0.28, 0.178, 0] } },
      // floor-seated foot links: the newel stretches down; the riser array also mints a foot filler plate
      { name: 'newelL', anchor: 'floor', shape: { kind: 'box', size: [0.05, 1.2, 0.05] }, offset: [0, 0.6, -0.62] },
      { name: 'riser', anchor: 'floor', collision: 'none', shape: { kind: 'box', size: [0.03, 0.178, 1.2] }, offset: [0.015, 0.089, 0], array: { count: 'numSteps', step: [0.28, 0.178, 0] } },
    ],
  } as unknown as RigGeo
}

describe('applyStairLift - raise the whole flight flush to the deck, keep the foot floor-seated', () => {
  const LIFT = 0.086

  it('lifts every link: param-driven Y via the axis-1 add, static Y via the offset', () => {
    const out = applyStairLift(stairGeo(), LIFT)
    const landing = out.links.find((l) => l.name === 'landing')!
    expect(landing.offsetParams!.find((o) => o.axis === 1)!.add).toBeCloseTo(LIFT, 6)
    expect(landing.offsetParams!.find((o) => o.axis === 0)!.add).toBeCloseTo(0.3, 6) // X unchanged
    expect(out.links.find((l) => l.name === 'post')!.offset[1]).toBeCloseTo(2.5 + LIFT, 6)
    // the treads lift too, so the whole top plane ends up flush and the handrail stays continuous
    expect(out.links.find((l) => l.name === 'tread')!.offset[1]).toBeCloseTo(0.178 + LIFT, 6)
    expect(out.links.find((l) => l.name === 'tread')!.array).toBeTruthy()
  })

  it('a floor-anchored box stretches down by the lift - top rides, bottom stays on the floor', () => {
    const out = applyStairLift(stairGeo(), LIFT)
    const newel = out.links.find((l) => l.name === 'newelL')!
    expect((newel.shape as { size: number[] }).size[1]).toBeCloseTo(1.2 + LIFT, 6)
    expect(newel.offset[1]).toBeCloseTo(0.6 + LIFT / 2, 6) // bottom still at 0, top at 1.2+LIFT
  })

  it('a floor-anchored array rides the lift and mints a filler plate under its first instance', () => {
    const out = applyStairLift(stairGeo(), LIFT)
    const riser = out.links.find((l) => l.name === 'riser')!
    expect(riser.offset[1]).toBeCloseTo(0.089 + LIFT, 6) // the array itself lifts with the flight
    const foot = out.links.find((l) => l.name === 'riser_foot')!
    expect((foot.shape as { size: number[] }).size[1]).toBeCloseTo(LIFT, 6) // spans floor → lift
    expect(foot.offset[1]).toBeCloseTo(LIFT / 2, 6)
    expect(foot.array).toBeUndefined()
    expect(foot.collision).toBe('none')
  })

  it('a sinking lift (negative residual) shrinks the foot boxes and mints no filler', () => {
    const out = applyStairLift(stairGeo(), -0.05)
    expect((out.links.find((l) => l.name === 'newelL')!.shape as { size: number[] }).size[1]).toBeCloseTo(1.15, 6)
    expect(out.links.find((l) => l.name === 'riser_foot')).toBeUndefined()
  })

  it('is a no-op (same geo) for a ~0 lift - already flush', () => {
    const g = stairGeo()
    expect(applyStairLift(g, 0)).toBe(g)
  })

  it('drops the dropWhenMounted links (the deck replaces them), at any lift, and lifts the rest', () => {
    const g = stairGeo()
    g.links = g.links.map((l) => (l.name === 'landing' || l.name === 'post' ? { ...l, dropWhenMounted: true } : l))
    for (const lift of [0, LIFT]) {
      const names = applyStairLift(g, lift).links.map((l) => l.name)
      expect(names).not.toContain('landing')
      expect(names).not.toContain('post')
      expect(names).toContain('tread')
    }
    expect(applyStairLift(g, LIFT).links.find((l) => l.name === 'tread')!.offset[1]).toBeCloseTo(0.178 + LIFT, 6)
    // the package's own geometry is untouched: freestanding, the landing is still there
    expect(g.links.map((l) => l.name)).toContain('landing')
  })
})
