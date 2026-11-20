import { describe, expect, it } from 'vitest'
import { linkHalfExtents, resolvedOffset, rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: STACK_LIGHT_SDK_BEHAVIOR, geometry: STACK_LIGHT_SDK_RIG } = examplePart<RigGeo>('oip.stack-light')

// The parametric Stack Light, a custom part (examples/parts/stack-light), must assemble a parametric tower:
// a `segments` param (1-8, default 3) stacks lens tiers at LENS_BOTTOM + (i+0.5)·SEGMENT, the
// cap/core/rings/collision follow the tier count, and one integer bitmask lights the tiers (bit i = segment
// i+1), colours cycling bottom-up G→A→R→B→W. All 8 tier links are emitted (each needs its own emissive colour
// + lamp, which an array-link can't express). Unused tiers collapse via C-paramgeo clamps into a sliver
// parked at the top seam, inside the wider top ring. Collision is one hidden box link, 2·RING_R square × the
// tower height.

const geo = STACK_LIGHT_SDK_RIG
const STAND = 0.196, BASE = 0.025, SEG = 0.05, TOP = 0.014, R = 0.035, RING_R = R + 0.0015
const lensBottom = STAND + BASE
const towerH = (n: number) => lensBottom + n * SEG + TOP // tower height
const TIERS = ['seg1', 'seg2', 'seg3', 'seg4', 'seg5', 'seg6', 'seg7', 'seg8']
const link = (name: string) => geo.links.find((l) => l.name === name)!
const posesAt = (segments: number) => rigWorldPoses(geo, {}, undefined, 1, { segments })

describe('Stack Light custom-part rig', () => {
  it('is a structurally valid package (rig + a dummy behavior declaring the 8 tier lamps)', () => {
    expect(
      validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.stack-light', name: 'Stack Light', params: {}, behavior: `definePart({ lamps:${JSON.stringify(TIERS)}, step(){} })`, geometry: geo }),
    ).toEqual([])
  })

  it('has 8 emissive lens tiers cycling the bottom-up palette green → amber → red → blue → white', () => {
    const emissiveLinks = geo.links.filter((l) => l.lamps?.[0]?.emissive)
    expect(emissiveLinks.map((l) => l.name)).toEqual(TIERS)
    const [g, a, r, b, w] = [link('seg1').lamps![0]!.emissive, link('seg2').lamps![0]!.emissive, link('seg3').lamps![0]!.emissive, link('seg4').lamps![0]!.emissive, link('seg5').lamps![0]!.emissive]
    expect(g[1]).toBeGreaterThan(g[0]) // green channel dominant at the bottom (run state)
    expect(a[0]).toBeGreaterThan(a[2]) // amber = red+green
    expect(a[1]).toBeGreaterThan(a[2])
    expect(r[0]).toBeGreaterThan(r[1]) // red third
    expect(b[2]).toBeGreaterThan(b[0]) // blue fourth
    expect(w[0]).toBeCloseTo(w[1], 4) // white fifth (neutral)
    // authored linear (the renderer feeds components straight to three.js): #d62828's sRGB 0.839 red
    // channel converts to ≈0.672. Copying the sRGB value unconverted would read ≥0.8
    expect(r[0]).toBeCloseTo(0.6724, 3)
    // the palette repeats past 5: seg6..8 = green, amber, red again
    expect(link('seg6').lamps?.[0]?.emissive).toEqual(g)
    expect(link('seg7').lamps?.[0]?.emissive).toEqual(a)
    expect(link('seg8').lamps?.[0]?.emissive).toEqual(r)
  })

  it('stacks the used tiers at their heights and parks the unused ones at the top seam (inside the ring)', () => {
    for (const segments of [1, 3, 5, 8]) {
      const p = posesAt(segments)
      const topSeam = lensBottom + segments * SEG
      TIERS.forEach((name, i) => {
        expect(p.get(name)!.pos[1]).toBeCloseTo(i < segments ? lensBottom + (i + 0.5) * SEG : topSeam, 6)
      })
      // the parked tiers collapse to a sliver (C-paramgeo min-clamp) hidden by the wider top-seam ring
      TIERS.forEach((name, i) => {
        expect(linkHalfExtents(link(name), { segments })[1]).toBeCloseTo(i < segments ? SEG / 2 : 0.0001, 6)
      })
    }
  })

  it('each tier is a lens: a dim tint of its own hue unlit + a 235/255 lit opacity', () => {
    for (const name of TIERS) {
      const l = link(name)
      // unlit = tinted plastic, not a uniform grey: darker than the lit hue in every channel, and
      // its dominant channel is the hue's, so a dark tower still says which tier is which
      const off = l.lamps![0]!.offColor!, hue = l.lamps![0]!.emissive
      for (let k = 0; k < 3; k++) expect(off[k]).toBeLessThanOrEqual(Math.max(hue[k]!, 0.05))
      const top = (c: readonly number[]) => c.indexOf(Math.max(...c))
      if (hue[0] !== hue[1] || hue[1] !== hue[2]) expect(top(off)).toBe(top(hue))
      expect(l.lamps?.[0]?.opacity).toBeCloseTo(235 / 255, 4) // the lit lens alpha
      expect(l.collision).toBe('none') // the hidden shell is the collision body
    }
  })

  it('wears the black housing: foot/stem/base + segment-count seam rings + a floating cap that tracks the top', () => {
    const housingCol = link('foot').color!
    expect(housingCol[0]).toBeLessThan(0.02) // near-black (0x17181b, sRGB → linear)
    for (const name of ['stem', 'base', 'cap', 'ring', 'ringTop']) expect(link(name).color).toEqual(housingCol)
    // one ring per tier bottom - an array-link stepping SEG apart, counted by the `segments` param
    const ring = link('ring')
    expect(ring.array).toEqual({ count: 'segments', step: [0, SEG, 0] })
    expect(ring.offset[1]).toBeCloseTo(lensBottom, 4)
    expect(ring.shape.kind === 'cylinder' && ring.shape.radius).toBeCloseTo(RING_R, 4)
    expect(ring.collision).toBe('none')
    // ...plus the top-seam ring and the cap, both tracking segments·SEG
    for (const segments of [1, 4, 8]) {
      expect(resolvedOffset(link('ringTop').offset, link('ringTop').offsetParams, { segments })[1]).toBeCloseTo(lensBottom + segments * SEG, 6)
      expect(resolvedOffset(link('cap').offset, link('cap').offsetParams, { segments })[1]).toBeCloseTo(lensBottom + segments * SEG + TOP / 2, 6)
    }
  })

  it('a pale inner core spans the lens stack, growing with the segment count (render-only)', () => {
    const core = link('core')
    expect(core.shape.kind === 'cylinder' && core.shape.radius).toBeCloseTo(R - 0.006, 4)
    expect(core.collision).toBe('none')
    for (const segments of [1, 3, 8]) {
      expect(linkHalfExtents(core, { segments })[1]).toBeCloseTo((segments * SEG) / 2, 6)
      expect(resolvedOffset(core.offset, core.offsetParams, { segments })[1]).toBeCloseTo(lensBottom + (segments * SEG) / 2, 6)
    }
  })

  it('collision is one hidden box, 2·RING_R square × the tower height, centred at h/2', () => {
    const shell = link('shell')
    expect(shell.hidden).toBe(true) // renders nothing; the sim body is still built
    expect(shell.collision).toBeUndefined()
    for (const segments of [1, 3, 8]) {
      const he = linkHalfExtents(shell, { segments })
      expect(he[0]).toBeCloseTo(RING_R, 4)
      expect(he[2]).toBeCloseTo(RING_R, 4)
      expect(he[1]).toBeCloseTo(towerH(segments) / 2, 6) // collision box grows with the tower
      expect(resolvedOffset(shell.offset, shell.offsetParams, { segments })[1]).toBeCloseTo(towerH(segments) / 2, 6)
    }
  })

  it('the behavior reads one INT bitmask tag (comms) / value param (manual) and a use steps the value', () => {
    expect(STACK_LIGHT_SDK_BEHAVIOR).toContain('interactive: true')
    expect(STACK_LIGHT_SDK_BEHAVIOR).toContain('ctx.used()')
    expect(STACK_LIGHT_SDK_BEHAVIOR).toContain('readNumber') // an INT bitmask, not per-tier bool tags
    expect(STACK_LIGHT_SDK_BEHAVIOR).not.toContain('redTag') // the legacy per-tier tags are gone
  })
})
