import { describe, expect, it } from 'vitest'
import type { ParamSchema } from '../parts/partApi'
import type { PartPackage, RigLink } from '../parts/partPackage'
import { linkFinish, linkFinishKey, resolveLinkFinishes } from './rigFinish'
import { checkGeometryRefs } from '../parts/partAuthoringChecks'

type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

const specs: ParamSchema = {
  deckSurface: { type: 'enum', default: 'tread', options: [{ value: 'tread', label: 'Tread plate' }, { value: 'deck', label: 'Solid deck' }] },
}
const deck: RigLink = { name: 'deck', shape: { kind: 'box', size: [2, 0.05, 2] }, offset: [0, 0, 0], finish: 'tread', finishParam: 'deckSurface' }
const frame: RigLink = { name: 'frame', shape: { kind: 'box', size: [2, 0.1, 0.1] }, offset: [0, 0, 0], finish: 'frame' }
const geo: RigGeo = { kind: 'rig', links: [deck, frame], joints: [] }

describe('linkFinish', () => {
  it("reads the param's value, else its default, else the link's own finish", () => {
    expect(linkFinish(deck, { deckSurface: 'deck' }, specs)).toBe('deck')
    expect(linkFinish(deck, {}, specs)).toBe('tread')
    expect(linkFinish(deck, { deckSurface: 'carpet' }, specs)).toBe('tread')
    expect(linkFinish(frame, { deckSurface: 'deck' }, specs)).toBe('frame')
  })
})

describe('resolveLinkFinishes', () => {
  it('returns the same geometry when no link chooses, or nothing changes', () => {
    const plain: RigGeo = { kind: 'rig', links: [frame], joints: [] }
    expect(resolveLinkFinishes(plain, { deckSurface: 'deck' }, specs)).toBe(plain)
    expect(resolveLinkFinishes(geo, {}, specs).links[0]).toBe(deck)
  })
  it("writes the chosen finish onto the link and leaves the others alone", () => {
    const out = resolveLinkFinishes(geo, { deckSurface: 'deck' }, specs)
    expect(out.links[0]!.finish).toBe('deck')
    expect(out.links[1]).toBe(frame)
    expect(geo.links[0]!.finish).toBe('tread') // the package's own geometry is untouched
  })
  it('keys the choice so a visual can see it change', () => {
    expect(linkFinishKey(geo, {}, specs)).not.toBe(linkFinishKey(geo, { deckSurface: 'deck' }, specs))
    expect(linkFinishKey({ kind: 'rig', links: [frame], joints: [] }, {}, specs)).toBe('')
  })
})

describe('finishParam authoring check', () => {
  it('flags a param that is not an enum, and options that are not finishes', () => {
    const bad: ParamSchema = { deckSurface: { type: 'enum', default: 'tread', options: [{ value: 'tread' }, { value: 'carpet' }] }, solid: { type: 'boolean', default: false } }
    const probs = checkGeometryRefs({ kind: 'rig', links: [deck, { ...frame, finishParam: 'solid' }], joints: [] }, bad)
    expect(probs.some((p) => p.field === 'geometry.links[0].finishParam' && p.message.includes("'carpet'"))).toBe(true)
    expect(probs.some((p) => p.field === 'geometry.links[1].finishParam' && p.message.includes("'enum'"))).toBe(true)
    expect(checkGeometryRefs(geo, specs)).toEqual([])
  })
})
