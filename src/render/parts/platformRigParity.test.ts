import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import type { RigLink } from '../../core/parts/partPackage'
import { arrayInstanceDeltas, linkHalfExtents, resolvedOffset } from '../../core/rig/rigPose'
import { instantiatePartScript } from '../../core/parts/partScript'
import { examplePart, type RigGeo } from './examplePart'
import { linkFinish } from '../../core/rig/rigFinish'
import { checkGeometryRefs } from '../../core/parts/partAuthoringChecks'
import type { ParamSchema } from '../../core/parts/partApi'

/** a link's instances as the host resolves them: its array (a single instance without one), none while its
 *  showParam is off */
const instances = (link: RigLink, params: Record<string, number | boolean>) => arrayInstanceDeltas(link.array ?? {}, params, undefined, link.showParam)
const { geometry: PLATFORM_RIG, behavior: PLATFORM_BEHAVIOR } = examplePart<RigGeo>('oip.platform')

// The Platform (examples/parts/platform) is a textured deck (tread plate or solid: deckSurface) on a steel
// column/beam frame with a toggleable perimeter railing, all length/width/height-parametric. This pins
// the geometry + the showSupports/showRailings gating + the collision model (deck + corner columns + hidden
// per-edge railing walls collide; the middle grid, beams, plates + visible railing are decorative).

const geo = PLATFORM_RIG
const PLATFORM_PARAMS: ParamSchema = instantiatePartScript(PLATFORM_BEHAVIOR).def?.params ?? {}
const byName = (n: string): RigLink => geo.links.find((l) => l.name === n)!
const deck = byName('deck')
const cornerCols = geo.links.filter((l) => /^col[LR][FR]$/.test(l.name))
const grid = byName('columnGrid')
const DECK_THICK = 0.006

describe('Platform custom-part rig', () => {
  it('is a structurally valid package (rig + a no-op behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.platform', name: 'Platform', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('the deck is a textured slab (no tint) spanning length × width, top at the origin', () => {
    expect(deck.finish).toBe('tread')
    expect(deck.colorParam).toBeUndefined() // textured, not a steel tint
    const he = linkHalfExtents(deck, { length: 6, width: 3 })
    expect(he[0]).toBeCloseTo(3, 6) // length/2
    expect(he[2]).toBeCloseTo(1.5, 6) // width/2
    expect(he[1]).toBeCloseTo(DECK_THICK / 2, 6) // thin 6 mm panel
    expect(deck.offset[1] + he[1]).toBeCloseTo(0, 6) // top face at y=0 (the part origin)
  })

  it('the deck surface is the instance\'s choice: tread plate by default, a solid deck for an equipment platform', () => {
    const spec = PLATFORM_PARAMS.deckSurface
    expect(deck.finishParam).toBe('deckSurface')
    expect(spec?.type).toBe('enum')
    expect(spec?.default).toBe('tread')
    expect(spec?.options?.map((o) => o.value)).toEqual(['tread', 'deck'])
    expect(linkFinish(deck, {}, PLATFORM_PARAMS)).toBe('tread')
    expect(linkFinish(deck, { deckSurface: 'deck' }, PLATFORM_PARAMS)).toBe('deck')
    expect(checkGeometryRefs(geo, PLATFORM_PARAMS)).toEqual([])
  })

  it('has 4 corner columns at ±length/2, ±width/2 reaching the floor (height-parametric), and they collide', () => {
    expect(cornerCols).toHaveLength(4)
    const params = { length: 4, width: 4, height: 2.5 }
    const xz = cornerCols.map((l) => { const o = resolvedOffset(l.offset, l.offsetParams, params); return [Math.sign(Math.round(o[0])), Math.sign(Math.round(o[2]))] })
    expect(xz).toEqual(expect.arrayContaining([[-1, -1], [-1, 1], [1, -1], [1, 1]]))
    const col = cornerCols[0]!
    const hy = linkHalfExtents(col, params)[1]
    expect(hy).toBeCloseTo((2.5 - DECK_THICK) / 2, 6) // column length = height − deck
    expect(resolvedOffset(col.offset, col.offsetParams, params)[1] - hy).toBeCloseTo(-2.5, 6) // bottom at −height
    expect(cornerCols.every((l) => (l.collision !== 'none'))).toBe(true) // the 4 corner colliders
    expect(cornerCols.every((l) => l.colorParam === 'color')).toBe(true) // steel tint
  })

  it('showSupports adds an OSHA middle-column grid (2.4 m max spacing, ceil) that is decorative (collision: none)', () => {
    expect(grid.collision).toBe('none')
    // default 4×4 → a 3×3 grid (a centre column, unlike a floor/pitch grid)
    expect(instances(grid, { length: 4, width: 4, showSupports: true })).toHaveLength(9)
    // a narrow 13.5×1.9 catwalk keeps columns at both width edges (never a lone centreline)
    const catwalk = instances(grid, { length: 13.5, width: 1.9, showSupports: true })
    const zs = [...new Set(catwalk.map((d) => d[2]))].sort((a, b) => a - b)
    expect(zs).toHaveLength(2)
    expect(zs[0]).toBeCloseTo(-0.95, 6)
    expect(zs[1]).toBeCloseTo(0.95, 6)
    // toggled off → the middle grid vanishes (bare 4-corner table)
    expect(instances(grid, { length: 4, width: 4, showSupports: false })).toHaveLength(0)
  })

  it('has under-deck beams: a perimeter (always) + a showSupports-gated interior grid, all decorative', () => {
    const perim = ['beamXN', 'beamXP', 'beamZN', 'beamZP'].map(byName)
    expect(perim.every((l) => (l.collision === 'none') && !l.array)).toBe(true) // always present (no gate), no collision
    const gridBeam = byName('beamGridX')
    expect(gridBeam.collision).toBe('none')
    expect(gridBeam.array!.distribute!.maxSpacing).toBe(2.4)
    expect(instances(gridBeam, { width: 5, showSupports: true }).length).toBeGreaterThan(2)
    expect(instances(gridBeam, { width: 5, showSupports: false })).toHaveLength(0)
  })

  it('showRailings toggles a full OSHA railing: distributed posts + top + mid rail + toe board (all decorative)', () => {
    const post = byName('postZN')
    expect(post.collision).toBe('none')
    expect(post.array!.distribute!.maxSpacing).toBe(2.4)
    // a 6 m edge → posts every ≤2.4 m (ceil(6/2.4)=3 spans → 4 posts)
    expect(instances(post, { length: 6, showRailings: true })).toHaveLength(4)
    expect(instances(post, { length: 6, showRailings: false })).toHaveLength(0)
    for (const n of ['railTopZN', 'railMidZN', 'toeZN']) {
      const l = byName(n)
      expect(l.collision).toBe('none')
      expect(instances(l, { showRailings: false })).toHaveLength(0) // gated off
      expect(instances(l, { showRailings: true })).toEqual([[0, 0, 0]]) // a single spanning bar
    }
    // the mid rail sits below the top rail
    expect(byName('railMidZN').offset[1]).toBeLessThan(byName('railTopZN').offset[1])
  })

  it('declares the X/Z face resize handles + a rest:surfaceBelow height (stands on its columns, never buried)', () => {
    const { def } = instantiatePartScript(PLATFORM_BEHAVIOR)
    if (!def?.params) throw new Error('behavior failed to instantiate')
    // ±X/±Z viewport resize dots (docs/part-gizmos.md) - the platform's resize {x,z}
    expect(def.params.length).toMatchObject({ type: 'number', handle: { kind: 'face', axis: 'x' } })
    expect(def.params.width).toMatchObject({ type: 'number', handle: { kind: 'face', axis: 'z' } })
    // deck-top origin: the host stands the origin `height` above the surface below at drop/snap (the conveyor
    // standHeight treatment), so placement rests the columns on the floor instead of burying them under it
    expect(def.params.height).toMatchObject({ type: 'number', rest: 'surfaceBelow' })
  })

  it('the railing collision is a hidden full-height wall per edge, gated by showRailings', () => {
    const walls = ['wallXN', 'wallXP', 'wallZN', 'wallZP'].map(byName)
    expect(walls).toHaveLength(4)
    expect(walls.every((l) => l.hidden === true && (l.collision !== 'none'))).toBe(true) // collision-only, not rendered
    const wall = byName('wallXN')
    expect(linkHalfExtents(wall, { width: 4 })[1]).toBeCloseTo(1.07 / 2, 6) // full railing height
    expect(instances(wall, { showRailings: false })).toHaveLength(0) // no rail → no wall
    expect(instances(wall, { showRailings: true })).toEqual([[0, 0, 0]])
  })
})
