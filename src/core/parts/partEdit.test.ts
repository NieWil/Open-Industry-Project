// edit-part and duplicate-parts (scripts/edit-part.mjs, scripts/duplicate-parts.mjs): their pure halves.

import { beforeEach, describe, expect, it } from 'vitest'
import { duplicateParts, parseRenameMap, tagUses } from './partDuplicate'
import { editPartParams, editPartPose } from './partEdit'
import { PACKAGE_FORMAT, type PartPackage } from './partPackage'
import { clearPackages, registerPackage } from './partRegistry'
import type { PartInstance, SdkPart } from '../types'

const pkg = (id: string, params: PartPackage['params']): PartPackage => ({
  format: PACKAGE_FORMAT,
  id,
  name: id,
  params,
  behavior: 'definePart(() => ({}))',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
})

const BELT = 'acme.belt'
const EYE = 'acme.eye'
const DIVERTER = 'acme.diverter'
const SPAWNER = 'acme.spawner'

beforeEach(() => {
  clearPackages()
  registerPackage(
    pkg(BELT, {
      speed: { type: 'number', default: 0.5, min: 0, max: 3, visibleWhen: { param: 'fpm', is: false } },
      speedFpm: { type: 'number', default: 100, min: 0, max: 600, visibleWhen: { param: 'fpm', is: true } },
      fpm: { type: 'boolean', default: false, whenAbsent: true },
      runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
    } as PartPackage['params']),
  )
  registerPackage(pkg(EYE, { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } } as PartPackage['params']))
  registerPackage(pkg(DIVERTER, { tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } } as PartPackage['params']))
  registerPackage(pkg(SPAWNER, { conveyorId: { type: 'partRef', default: '' }, countTag: { type: 'tag', dir: 'out', stType: 'DINT', default: '' } } as PartPackage['params']))
})

const paramOf = (p: PartInstance, key: string): unknown => (p.params as Record<string, unknown>)[key]

const part = (id: string, packageId: string, params: Record<string, unknown>, x = 0, extra: Partial<PartInstance> = {}): PartInstance =>
  ({ id, type: 'part', packageId, position: [x, 0, 0], rotationY: 0, params, ...extra }) as unknown as PartInstance

describe('editPartParams', () => {
  it('changes a param and stores only what changed, marking a return to the default', () => {
    const belt = part('b', BELT, { fpm: false, speed: 1 }) as SdkPart
    const r = editPartParams(belt, 'speed=0.5,runTag=Belt1')
    expect(r.params).toEqual({ fpm: false, speed: 0.5, runTag: 'Belt1' })
    expect(r.changes).toEqual([
      { key: 'speed', from: 1, to: 0.5, isDefault: true },
      { key: 'runTag', from: '', to: 'Belt1', isDefault: false },
    ])
    // the saved part is not touched
    expect(belt.params).toEqual({ fpm: false, speed: 1 })
  })

  it('reads an absent boolean as loading does (whenAbsent), so a hidden param is warned about', () => {
    const warnings: string[] = []
    // fpm absent loads as true (whenAbsent), which hides `speed`
    editPartParams(part('b', BELT, {}) as SdkPart, 'speed=2', warnings)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/speed is ignored.*fpm = true here. Add fpm=false/)
  })

  it('a value equal to the current one is no change', () => {
    expect(editPartParams(part('b', BELT, { fpm: false, speed: 1 }) as SdkPart, 'speed=1').changes).toEqual([])
  })

  it('refuses an unknown param and a value outside its range', () => {
    const belt = part('b', BELT, { fpm: false }) as SdkPart
    expect(() => editPartParams(belt, 'sped=1')).toThrow(/has no param "sped"/)
    expect(() => editPartParams(belt, 'speed=9')).toThrow(/does not fit.*from 0 to 3/)
    expect(() => editPartParams(belt, 'fpm=yes')).toThrow(/true or false/)
  })
})

describe('editPartPose', () => {
  it('moves a part and carries its soft-parented subtree rigidly', () => {
    const parts = [part('p', BELT, {}, 1), part('c', EYE, {}, 2, { parent: 'p' }), part('other', EYE, {}, 5)]
    const r = editPartPose(parts, 'p', { at: [1, 0, 3], rotationY: Math.PI / 2 })
    expect(r.moved).toEqual(['p', 'c'])
    const c = r.parts.find((p) => p.id === 'c')!
    // 1 m along +X from the parent, turned a quarter about +Y: local +X goes to world -Z (core/math.ts forwardXZ)
    expect(c.position[0]).toBeCloseTo(1)
    expect(c.position[2]).toBeCloseTo(2)
    expect(c.rotationY).toBeCloseTo(Math.PI / 2)
    expect(r.parts.find((p) => p.id === 'other')).toBe(parts[2])
  })

  it('refuses an unknown id', () => {
    expect(() => editPartPose([], 'nope', { at: [0, 0, 0] })).toThrow(/no part "nope"/)
  })
})

describe('parseRenameMap', () => {
  it('reads Old=New pairs', () => {
    expect([...parseRenameMap('A=B, C=D')]).toEqual([['A', 'B'], ['C', 'D']])
  })
  it('refuses a piece without both sides, and one name renamed two ways', () => {
    expect(() => parseRenameMap('A')).toThrow(/not Old=New/)
    expect(() => parseRenameMap('A=')).toThrow(/not Old=New/)
    expect(() => parseRenameMap('A=B,A=C')).toThrow(/renamed twice/)
  })
})

describe('duplicateParts', () => {
  const station = (): PartInstance[] => [
    part('main', BELT, { fpm: false, runTag: 'MainRun' }, 0),
    part('src', SPAWNER, { conveyorId: 'main', countTag: 'Count' }, 0),
    part('eye', EYE, { tag: 'DivertEye' }, 4),
    part('div', DIVERTER, { tag: 'Divert1' }, 4),
    part('lane', BELT, { fpm: false, runTag: 'MainRun' }, 4),
    part('lane-eye', EYE, { tag: 'Lane1Full' }, 4, { parent: 'lane', name: 'Lane eye' }),
  ]

  it('offsets the copies, gives fresh ids and remaps links inside the group only', () => {
    const parts = station()
    const r = duplicateParts(parts, ['src', 'lane'], { offset: [2, 0, -1] })
    // lane-eye comes with its parent
    expect(r.addedChildren).toEqual(['lane-eye'])
    expect(r.copies.map((p) => p.id)).toEqual(['src-2', 'lane-2', 'lane-eye-2'])
    expect(r.copies[1]!.position).toEqual([6, 0, -1])
    // parent inside the group follows the copy; the spawner's conveyor is outside the group and is kept
    expect(r.copies[2]!.parent).toBe('lane-2')
    expect(paramOf(r.copies[0]!, 'conveyorId')).toBe('main')
    expect(r.copies[2]!.name).toBe('Lane eye 2')
    // originals untouched
    expect(paramOf(parts[1]!, 'conveyorId')).toBe('main')
    expect(parts[5]!.parent).toBe('lane')
  })

  it('remaps a partRef to a part inside the group', () => {
    const r = duplicateParts(station(), ['main', 'src'], { offset: [0, 0, 3], idSuffix: 'B' })
    expect(r.copies.map((p) => p.id)).toEqual(['mainB', 'srcB'])
    expect(paramOf(r.copies[1]!, 'conveyorId')).toBe('mainB')
  })

  it('keeps a parent outside the group', () => {
    const r = duplicateParts(station(), ['lane-eye'], { offset: [1, 0, 0] })
    expect(r.copies[0]!.parent).toBe('lane')
  })

  it('renames tags by the map, reports a writer clash and a shared input', () => {
    const r = duplicateParts(station(), ['eye', 'div', 'lane'], { offset: [2, 0, 0], rename: parseRenameMap('DivertEye=DivertEye2,Divert1=Divert2') })
    expect(r.tags.map((t) => `${t.partId}.${t.key}=${t.tag}`)).toEqual(['eye-2.tag=DivertEye2', 'div-2.tag=Divert2', 'lane-2.runTag=MainRun', 'lane-eye-2.tag=Lane1Full'])
    // Lane1Full was not renamed: the copy and the original both write it
    expect(r.clashes).toHaveLength(1)
    expect(r.clashes[0]!.copy).toMatchObject({ partId: 'lane-eye-2', tag: 'Lane1Full' })
    expect(r.clashes[0]!.writers.map((w) => w.partId)).toEqual(['lane-eye'])
    expect(r.shared.map((s) => s.tag)).toEqual(['MainRun'])
    expect(r.warnings).toEqual([])
  })

  it('appends a suffix to every tag the map does not name, but never to a direct address', () => {
    const parts = [...station(), part('addr', EYE, { tag: '%IX0.3' }, 9)]
    const r = duplicateParts(parts, ['eye', 'lane', 'addr'], { offset: [1, 0, 0], tagSuffix: '_B', rename: parseRenameMap('DivertEye=Eye2') })
    expect(Object.fromEntries(r.tags.map((t) => [t.partId, t.tag]))).toEqual({ 'eye-2': 'Eye2', 'lane-2': 'MainRun_B', 'lane-eye-2': 'Lane1Full_B', 'addr-2': '%IX0.3' })
    // the unrenamed address is a second writer of %IX0.3
    expect(r.clashes.map((c) => c.copy.tag)).toEqual(['%IX0.3'])
  })

  it('reports two copies writing one tag as a clash', () => {
    const r = duplicateParts(station(), ['eye', 'lane-eye'], { offset: [1, 0, 0], rename: parseRenameMap('DivertEye=Same,Lane1Full=Same') })
    expect(r.clashes.map((c) => [c.copy.partId, c.writers.map((w) => w.partId)])).toEqual([['lane-eye-2', ['eye-2']]])
  })

  it('warns about a rename that matched no copied tag', () => {
    const r = duplicateParts(station(), ['eye'], { offset: [1, 0, 0], rename: parseRenameMap('DivertEye=E2,Lane1Ful=L2') })
    expect(r.warnings).toEqual(['--rename Lane1Ful=L2: no copied part has a tag "Lane1Ful"'])
  })

  it('refuses an unknown id, naming it', () => {
    expect(() => duplicateParts(station(), ['eye', 'nope'], { offset: [1, 0, 0] })).toThrow(/no part "nope"/)
  })

  it('refuses an id suffix whose id is taken, and otherwise numbers past taken ids', () => {
    const parts = [...station(), part('eye-2', EYE, {}, 7), part('eyeX', EYE, {}, 8)]
    expect(() => duplicateParts(parts, ['eye'], { offset: [1, 0, 0], idSuffix: 'X' })).toThrow(/"eyeX".*already/)
    expect(duplicateParts(parts, ['eye'], { offset: [1, 0, 0] }).copies[0]!.id).toBe('eye-3')
  })

  it('lists a part\'s tags with their direction', () => {
    expect(tagUses(station()[1]!)).toEqual([{ partId: 'src', key: 'countTag', tag: 'Count', dir: 'out' }])
  })
})
