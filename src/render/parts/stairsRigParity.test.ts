import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { arrayInstanceDeltas, linkHalfExtents, resolvedOffset, restQuatOf, IDENTITY_QUAT } from '../../core/rig/rigPose'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: STAIRS_RIG, behavior: STAIRS_BEHAVIOR } = examplePart<RigGeo>('oip.stairs')

// The Stairs is a custom Structure part (examples/parts/stairs) that matches the built-in. It combines array
// links (diagonal tread/riser arrays) with C-paramgeo and a constant-slope rotation (the sloped stringers +
// rails). This pins that structure: the diagonal distribution, the closed risers, the sloped steelwork, the
// showHandrails gating, and the two-tone materials.

const geo = STAIRS_RIG
const RISE = 0.178
const TREAD = 0.28
const DIAG = Math.hypot(TREAD, RISE)
const link = (name: string) => geo.links.find((l) => l.name === name)!
const tread = link('tread')

describe('Stairs custom-part rig - array-links (diagonal) + C-paramgeo + constant-slope steelwork', () => {
  it('is a structurally valid package (rig + a no-op behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.stairs', name: 'Stairs', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('the treads are a numSteps-driven array stepping up + forward', () => {
    expect(tread.array?.count).toBe('numSteps')
    for (const n of [5, 11, 20]) {
      const deltas = arrayInstanceDeltas(tread.array!, { numSteps: n })
      expect(deltas).toHaveLength(n) // one tread per step
      // each consecutive tread rises by RISE and advances by TREAD
      expect(deltas[n - 1]![0]).toBeCloseTo((n - 1) * TREAD, 6)
      expect(deltas[n - 1]![1]).toBeCloseTo((n - 1) * RISE, 6)
      expect(deltas[n - 1]![2]).toBe(0)
    }
  })

  it('each tread is width-parametric (C-paramgeo) and wears steel tread plate', () => {
    expect(linkHalfExtents(tread, { width: 1.6 })[2]).toBeCloseTo(0.8, 6) // width/2
    expect(tread.finish).toBe('tread') // a textured tread, not a flat tint
  })

  it('closed risers: a numSteps array of vertical plates, one RISE tall, width-parametric, visual-only', () => {
    const riser = link('riser')
    expect(riser.array?.count).toBe('numSteps')
    expect(arrayInstanceDeltas(riser.array!, { numSteps: 7 })).toHaveLength(7) // one riser per step
    const he = linkHalfExtents(riser, { width: 1.6 })
    expect(he[1]).toBeCloseTo(RISE / 2, 6) // spans one rise vertically (closes the step face)
    expect(he[2]).toBeCloseTo(0.8, 6) // WIDTH-parametric like the tread
    expect(riser.collision).toBe('none') // the treads are the collidable surface
  })

  it('two sloped side stringers whose length tracks numSteps (a constant-slope rotation)', () => {
    // the band's foot is trimmed by H·tan(ANG) along the slope so its perpendicular end cut ends at the newel
    // (top corner on the newel centreline). Its bottom edge stops at the flight top, where the head squares off
    // the leaning top cut: length = numSteps · per-step diagonal less that one trim
    const ang = Math.atan2(RISE, TREAD)
    for (const name of ['stringerL', 'stringerR']) {
      const s = link(name)
      const trim = (2 * linkHalfExtents(s, { numSteps: 11 })[1]!) * Math.tan(ang)
      expect(restQuatOf(s)).not.toEqual(IDENTITY_QUAT) // rotated onto the flight slope
      expect(linkHalfExtents(s, { numSteps: 11 })[0]).toBeCloseTo((11 * DIAG - trim) / 2, 5)
      expect(linkHalfExtents(s, { numSteps: 20 })[0]).toBeCloseTo((20 * DIAG - trim) / 2, 5)
      // the foot end's top corner on the newel centreline (x = 0); the top end's bottom corner on the flight top,
      // and the head filling from there back to the top corner, up to its height: a level cut, then plumb
      const head = link(name.replace('stringer', 'stringerHead'))
      for (const n of [5, 11, 20]) {
        const c = resolvedOffset(s.offset, s.offsetParams, { numSteps: n, width: 1.2 })
        const [hl, hh] = linkHalfExtents(s, { numSteps: n })
        const corner = (along: number, up: number): [number, number] => [
          c[0]! + along * Math.cos(ang) - up * hh! * Math.sin(ang),
          c[1]! + along * Math.sin(ang) + up * hh! * Math.cos(ang),
        ]
        expect(corner(-hl!, 1)[0]).toBeCloseTo(0, 3)
        expect(corner(hl!, -1)[0]).toBeCloseTo(n * TREAD, 3)
        const hc = resolvedOffset(head.offset, head.offsetParams, { numSteps: n, width: 1.2 })
        const [hx, hy] = linkHalfExtents(head, { numSteps: n })
        expect(hc[0]! + hx!).toBeCloseTo(n * TREAD, 3) // plumb end on the flight top
        expect(hc[0]! - hx!).toBeCloseTo(corner(hl!, 1)[0], 3) // back to the cut's top corner...
        expect(hc[1]! + hy!).toBeCloseTo(corner(hl!, 1)[1], 3) // ...at its height
        expect(hc[1]! - hy!).toBeCloseTo(corner(hl!, -1)[1], 3) // down to the bottom edge at the flight top
      }
    }
    // the two stringers straddle the width symmetrically (± the same z)
    expect(link('stringerL').offset[2]).toBeCloseTo(-link('stringerR').offset[2]!, 6)
  })

  it('every step hides inside the stringer band: no riser or tread corner pokes out under it', () => {
    // A band whose bottom edge rides the riser-base line exactly lets each step poke out beneath it: a riser's
    // back-bottom corner sits RISER_T·tan(slope) below that line, a tread's back-bottom corner THICK below.
    const RISER_T = 0.03, THICK = 0.005
    const ang = Math.atan2(RISE, TREAD)
    const nrm = [-Math.sin(ang), Math.cos(ang)] // the band's upward normal in (x, y)
    const s = link('stringerR')
    for (const n of [2, 11, 25]) {
      const c = resolvedOffset(s.offset, s.offsetParams, { numSteps: n, width: 1.2 })
      const half = linkHalfExtents(s, { numSteps: n })[1]
      const above = (x: number, y: number): number => (x - c[0]!) * nrm[0]! + (y - c[1]!) * nrm[1]! + half // height over the bottom edge
      for (let i = 0; i < n; i++) {
        expect(above(i * TREAD + RISER_T, i * RISE)).toBeGreaterThan(0.01) // riser back-bottom corner
        expect(above((i + 1) * TREAD, (i + 1) * RISE - THICK)).toBeGreaterThan(0.01) // tread back-bottom corner
      }
    }
  })

  it('invisible guard colliders line both open sides, gated with the rails', () => {
    for (const name of ['guardSlopeL', 'guardSlopeR', 'guardLandL', 'guardLandR']) {
      const g = link(name)
      expect(g.hidden).toBe(true) // physics-only - no rendered box
      expect(g.showParam).toBe('showHandrails') // rails off ⇒ guard body gone
      expect(g.collision).toBeUndefined() // the point: it collides
    }
    expect(restQuatOf(link('guardSlopeL'))).not.toEqual(IDENTITY_QUAT) // the slope guard rides the flight slope
    // guards straddle the width symmetrically, just outside the stringer plane
    expect(link('guardSlopeL').offset[2]).toBeCloseTo(-link('guardSlopeR').offset[2]!, 6)
  })

  it('intermediate handrail posts every ~1.4 m of run, both sides, riding the lifted railFrame', () => {
    // industrial stair rail, not a post per tread: geometry() divides the newel → landing-post run evenly
    expect(geo.links.some((l) => l.name === 'postL')).toBe(false)
    expect(link('railFrame').shape.kind).toBe('frame') // shifted by the deck-connection lift like every link
    const postXs = (n: number, showHandrails = true): number[] => {
      const parts = evalPartGeometry(STAIRS_BEHAVIOR, { numSteps: n, width: 1.2, showHandrails, color: '#f2bd0f' } as never) ?? []
      // everything rides the railFrame; the steel (posts, tread nosings) takes the colour, the hardware doesn't
      expect(parts.every((p) => p.link === 'railFrame')).toBe(true)
      // the box steel first, then (rails on) the swept handrail tubes
      const steel = parts.filter((p) => p.colorParam === 'color')
      expect(steel).toHaveLength(showHandrails ? 2 : 1)
      const pos = Array.from(steel[0]!.desc.positions)
      // one box = 24 verts; a post is the box standing taller than half a metre (a nosing is a few cm), and its
      // centre x counts once, far side only (z > 0)
      const xs: number[] = []
      for (let b = 0; b < pos.length / 72; b++) {
        let x = 0, z = 0, lo = Infinity, hi = -Infinity
        for (let v = 0; v < 24; v++) {
          const y = pos[(b * 24 + v) * 3 + 1]!
          x += pos[(b * 24 + v) * 3]!; z += pos[(b * 24 + v) * 3 + 2]!
          lo = Math.min(lo, y); hi = Math.max(hi, y)
        }
        if (z > 0 && hi - lo > 0.5) xs.push(x / 24)
      }
      return xs.sort((a, b) => a - b)
    }
    expect(postXs(2)).toEqual([]) // a two-step flight: the newel and the landing post are enough
    for (const n of [11, 25, 40]) {
      const xs = [0, ...postXs(n), n * TREAD] // newel, the posts, the landing post
      for (let k = 1; k < xs.length; k++) expect(xs[k]! - xs[k - 1]!).toBeLessThan(1.4 + TREAD) // never a long bay
      expect(xs.length - 2).toBeLessThan(n / 3) // far fewer than a post per tread
    }
    // rails off: no posts (the nosings stay; they're the treads' own)
    expect(postXs(11, false)).toEqual([])
  })

  it('sloped top + mid rails on both sides, length tracking numSteps', () => {
    const ang = Math.atan2(RISE, TREAD)
    for (const name of ['railTopL', 'railTopR', 'railMidL', 'railMidR']) {
      const rl = link(name)
      expect(restQuatOf(rl)).not.toEqual(IDENTITY_QUAT) // parallel to the flight
      // length tracks the flight, trimmed at the top so the end cut's lower corner stays inside the post it meets
      for (const n of [5, 11, 20]) {
        const c = resolvedOffset(rl.offset, rl.offsetParams, { numSteps: n, width: 1.2 })
        const [hl, hh] = linkHalfExtents(rl, { numSteps: n })
        expect(c[0]! - hl! * Math.cos(ang)).toBeCloseTo(0, 6) // the foot end on the newel centreline
        const lowerTop = c[0]! + hl! * Math.cos(ang) + hh! * Math.sin(ang)
        expect(lowerTop).toBeLessThan(n * TREAD)
        expect(lowerTop).toBeGreaterThan(n * TREAD - 0.002)
      }
    }
    // the mid rail sits below the top rail (lower y offset)
    expect(link('railMidL').offset[1]).toBeLessThan(link('railTopL').offset[1]!)
  })

  it('the handrail is a graspable tube inside the posts, clear of them, bent into the newel and the top post', () => {
    const HAND_H = 0.91 // its top above the nosing line: 36 in (OSHA 1910.29(f): 30-38 in)
    const POST = 0.04
    const NEWEL = 0.048
    const SIDE_Z = 0 // the post line: the tread edge, where a platform frames its railing gap
    expect(geo.links.some((l) => l.name.startsWith('railHand'))).toBe(false) // drawn, not a rig link
    for (const n of [5, 11, 20]) {
      for (const width of [0.9, 1.2, 2]) {
        const parts = evalPartGeometry(STAIRS_BEHAVIOR, { numSteps: n, width, showHandrails: true, color: '#f2bd0f' } as never) ?? []
        const tube = parts.filter((p) => p.colorParam === 'color')[1]!
        expect(tube.link).toBe('railFrame') // rides the deck-connection lift with the flight
        const pos = Array.from(tube.desc.positions)
        const postInner = width / 2 + SIDE_Z - POST / 2
        const xTop = n * TREAD - POST / 2 // the top post's centre: its deck-side face is the flight top
        const BEND = 0.05 + 0.019 + 0.002 // an end bend's reach along x: its radius + the tube's + a hair
        let top = -Infinity, maxAbsZ = 0, minX = Infinity, maxX = -Infinity
        let crowding = 0 // vertices nearer a post than 2.25 in, outside the end bends
        for (let v = 0; v < pos.length; v += 3) {
          const [x, y, z] = [pos[v]!, pos[v + 1]!, pos[v + 2]!]
          // the whole centreline rides a constant height over the nosing line (which passes (0, 0)), so the
          // highest vertex over it is the tube's top, measured plumb
          top = Math.max(top, y - (x * RISE) / TREAD)
          maxAbsZ = Math.max(maxAbsZ, Math.abs(z))
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          if (Math.abs(z) > postInner - 0.0572 && x > BEND && x < xTop - BEND) crowding++
        }
        // faces point out: a closed, outward-wound mesh has positive signed volume (an inside-out tube, negative,
        // shows its open shell from some angles), and about the tube's own volume: pi r^2 x its length
        const idx = Array.from(tube.desc.indices)
        let vol6 = 0
        for (let t = 0; t < idx.length; t += 3) {
          const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3]
          vol6 += pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!)
            - pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[b + 2]! * pos[c]!)
            + pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!)
        }
        const runLen = Math.hypot(xTop, (xTop * RISE) / TREAD)
        expect(vol6 / 6).toBeGreaterThan(2 * Math.PI * 0.019 ** 2 * runLen * 0.9) // two tubes, each at least its run
        expect(top).toBeCloseTo(HAND_H, 3) // its top at 36 in
        expect(crowding).toBe(0) // a hand on the run clears every post by OSHA's 2.25 in; only the end bends reach out
        // each end is welded to a post's inner face: the top post's (the farthest out the tube reaches); the newel's
        // is farther in, being thicker
        expect(maxAbsZ).toBeCloseTo(postInner, 4)
        expect(width / 2 + SIDE_Z - NEWEL / 2).toBeLessThan(postInner)
        // from the newel (x = 0) to the top post (xTop), the tube's radius either side of both
        expect(minX).toBeCloseTo(-0.019, 3)
        expect(maxX).toBeCloseTo(xTop + 0.019, 3)
      }
    }
  })

  it('the top landing, and only it, gives way to a deck: dropWhenMounted on every landing link', () => {
    const dropped = geo.links.filter((l) => l.dropWhenMounted).map((l) => l.name).sort()
    expect(dropped).toEqual(['guardLandL', 'guardLandR', 'landPost0L', 'landPost0R', 'landPost1L', 'landPost1R', 'landRailMidL', 'landRailMidR', 'landRailTopL', 'landRailTopR', 'landSkirtL', 'landSkirtR', 'landing'])
  })

  it('showHandrails gates every steel member; the tread-plate steps are always shown', () => {
    // treads + risers are tread plate (no colorParam) and not gated
    for (const name of ['tread', 'riser']) {
      expect(link(name).colorParam).toBeUndefined()
      expect(link(name).showParam).toBeUndefined()
    }
    // every steel member is gated by showHandrails and tints with the `color` param (the two-tone split)
    const steel = ['stringerL', 'stringerR', 'stringerFootL', 'stringerFootR', 'railTopL', 'railTopR', 'railMidL', 'railMidR', 'newelL', 'newelR']
    for (const name of steel) {
      expect(link(name).showParam).toBe('showHandrails')
      expect(link(name).colorParam).toBe('color')
      expect(link(name).collision).toBe('none') // structural, render-only (the treads carry the load)
    }
  })
})
