/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { buildAuthoredCargoFrame, CARGO_KIND_PALLET } from '../core/frame'
import type { FrameDressing } from '../core/frame'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// The Stretch Wrapper (examples/parts/stretch-wrapper), driven headless in a real SimWorld: the committed behavior over
// the committed rig, standing over a stopped conveying deck with a two-course load on a pallet under its arm. What it
// has to get right: the film it lays (ctx.wrap, core/cargoWrap) grows up the load as the carriage climbs and stops at
// the top case, the carriage finds that top with an eye that rides it, the arm parks beside the column when it is
// done, and it wraps a load once. A pallet authored as already wrapped carries the same film before Run and after.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as {
    id: string
    name: string
    category?: string
    geometry: PackageManifest['geometry']
    assets?: PackageManifest['assets']
    materials?: PackageManifest['materials']
  }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: { id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry, assets: rig.assets, materials: rig.materials }, behavior }
}

const DECK_Y = 1
const PALLET_H = 0.135
const CASE_H = 0.4
/** the load: a pallet at `z` with two courses of four 0.6 x 0.4 x 0.4 cases on it */
function load(z: number, palletParams: Record<string, boolean> = {}): PartInstance[] {
  const parts: PartInstance[] = [{ id: 'pal', type: 'part', packageId: 'oip.pallet', position: [0, DECK_Y + PALLET_H / 2, z], rotationY: 0, params: palletParams }]
  let n = 0
  for (let course = 0; course < 2; course++) {
    for (const x of [-0.3, 0.3]) {
      for (const dz of [-0.25, 0.25]) {
        parts.push({ id: `c${n++}`, type: 'part', packageId: 'oip.box', position: [x, DECK_Y + PALLET_H + CASE_H * (course + 0.5), z + dz], rotationY: 0, params: {} })
      }
    }
  }
  return parts
}
/** the load's top above the pallet's centre, which is the film's frame (pallet-local y) */
const LOAD_TOP_LOCAL = PALLET_H / 2 + 2 * CASE_H

function wrapperScene(wrapperParams: Record<string, unknown>, cargo: PartInstance[]) {
  const wrapper = loadExample('stretch-wrapper')
  const pallet = loadExample('pallet')
  const box = loadExample('box')
  const unitLoad = loadExample('unit-load')
  const deck = buildPackage(
    {
      id: 'acme.deck',
      name: 'Deck',
      geometry: {
        kind: 'rig',
        links: [{ name: 'deck', shape: { kind: 'box', size: [1.4, 0.1, 5] }, offset: [0, -0.05, 0], conveys: true }],
        joints: [],
        bounds: { length: 1.4, width: 5, top: 0.1 },
      },
    },
    'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })',
  )
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [deck, buildPackage(wrapper.manifest, wrapper.behavior), buildPackage(pallet.manifest, pallet.behavior), buildPackage(box.manifest, box.behavior), buildPackage(unitLoad.manifest, unitLoad.behavior)],
    parts: [
      { id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'wrap', type: 'part', packageId: wrapper.manifest.id, position: [0, DECK_Y, 0], rotationY: 0, params: { standHeight: DECK_Y, ...wrapperParams } },
      ...cargo,
    ],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return res.scene
}

/** the pallet's film this frame, if it has one */
function palletWrap(w: SimWorld): FrameDressing | undefined {
  const f = w.frame()
  const i = f.partIds.indexOf('pal')
  return f.dressings?.find((x) => x.anchor === f.ids[i] && x.id === 'film')
}

/** the world's unit loads and the marks on the pallet, read off its internals (there is no public view of either) */
function productState(w: SimWorld): { units: number; bodiesPerUnit: number[]; palletMarks: Record<string, unknown> | null } {
  const inner = w as unknown as { units: Set<{ members: unknown[]; marks: Record<string, unknown> }>; boxes: { partId: string | null; marks: Record<string, unknown> | null; unit: { marks: Record<string, unknown> } | null }[] }
  const pal = inner.boxes.find((b) => b.partId === 'pal')
  const marks = pal ? { ...(pal.marks ?? {}), ...(pal.unit?.marks ?? {}) } : null
  return { units: inner.units.size, bodiesPerUnit: [...inner.units].map((u) => u.members.length), palletMarks: marks }
}

describe('stretch wrapper', () => {
  it('wraps the load in its station once: the film climbs with the carriage, stops at the top case, and the arm parks', () => {
    const w = new SimWorld(Jolt, wrapperScene({ autoWrap: true }, load(0)))
    let maxLift = 0
    let armTurned = 0
    let lastArm = 0
    const tops: number[] = []
    const webs: NonNullable<FrameDressing['web']>[] = []
    for (let s = 0; s < 45 * 60; s++) {
      w.step()
      const web = palletWrap(w)?.web
      if (web) webs.push(web)
      const j = w.frame().joints?.['wrap'] ?? {}
      maxLift = Math.max(maxLift, j['lift'] ?? 0)
      const arm = j['arm'] ?? 0
      armTurned += (arm - lastArm + 2 * Math.PI) % (2 * Math.PI)
      lastArm = arm
      if (s % 60 === 0) tops.push(palletWrap(w)?.max[1] ?? -1)
    }
    const film = palletWrap(w)
    expect(film).toBeDefined()
    // the film ends at the top case (plus its standoff), not at the carriage's reach
    expect(film!.max[1]).toBeCloseTo(LOAD_TOP_LOCAL + 0.006, 3)
    expect(film!.min[1]).toBeCloseTo(0, 5) // from the pallet's mid-height, run down over its top boards
    // ...and it grew there: partway up before it was all the way up, never shrinking
    const grown = tops.filter((t) => t > 0)
    expect(grown[0]!).toBeLessThan(LOAD_TOP_LOCAL - 0.1)
    for (let i = 1; i < grown.length; i++) expect(grown[i]!).toBeGreaterThanOrEqual(grown[i - 1]!)
    // The carriage stopped where its eye saw over the load: eye at lift + 0.5 over the deck, load top 0.935 over it.
    // An eye left at its rest pose would have seen the load the whole way and climbed the mast to its 1.5 m stop, and
    // one that called the top on the first miss would have stopped at the gap between the two rows of cases.
    expect(maxLift).toBeGreaterThan(0.4)
    expect(maxLift).toBeLessThan(0.55)
    // parked beside the column, carriage down, and it turned a whole cycle's worth (1.5 base + climb + 1.5 top)
    const j = w.frame().joints?.['wrap'] ?? {}
    expect(j['arm']).toBe(0)
    expect(j['lift']).toBe(0)
    // the web ran from the roll to the load the whole time the arm was wrapping, and is gone now it has parked. The
    // roll's inner face is 1.105 m out from the axis; the load end is a corner of the film (the load is centred on
    // the axis, so a corner is its half plan out on both axes)
    expect(webs.length).toBeGreaterThan(60 * 10)
    for (const web of webs) {
      expect(Math.hypot(web.from[0], web.from[1])).toBeCloseTo(1.105, 2)
      expect(Math.abs(web.to[0])).toBeCloseTo(film!.max[0], 1)
      expect(Math.abs(web.to[1])).toBeCloseTo(film!.max[2], 1)
      expect(web.y1 - web.y0).toBeCloseTo(0.5, 5)
    }
    expect(palletWrap(w)!.web).toBeUndefined()
    // in the wrapper's own 'film' material (LINEAR rgb from its rig.json), not a colour the host picked
    expect(film!.color).toEqual([0.716, 0.838, 0.888])
    // ...and what wrapping did to the load: one unit load of pallet + eight cases, marked wrapped
    const state = productState(w)
    expect(state.units).toBe(1)
    expect(state.bodiesPerUnit).toEqual([9])
    expect(state.palletMarks).toEqual({ wrapped: true })
    expect(armTurned / (2 * Math.PI)).toBeGreaterThan(4)
    // ...and a wrapped load is not wrapped again while it stands there
    const turnedBefore = armTurned
    for (let s = 0; s < 5 * 60; s++) {
      w.step()
      const a = w.frame().joints?.['wrap']?.['arm'] ?? 0
      armTurned += (a - lastArm + 2 * Math.PI) % (2 * Math.PI)
      lastArm = a
    }
    expect(armTurned).toBe(turnedBefore)
    w.dispose()
  }, 60000)

  it('runs one cycle per start edge while a program drives it, and says done until the load leaves', () => {
    // the load stands downstream of centre, far enough that its leading cases block the station eye (0.53 m out), as a
    // load stopped on that eye does
    const w = new SimWorld(Jolt, wrapperScene({ startTag: 'WrapStart', busyTag: 'WrapBusy', doneTag: 'WrapDone', inPositionTag: 'WrapInPos' }, load(-0.12)))
    w.setBehaviorDrivenTags(['WrapStart'])
    const tag = (name: string): unknown => w.frame().tags?.['wrap']?.[name]
    w.setBehaviorInputTags({ WrapStart: false })
    for (let s = 0; s < 60; s++) w.step()
    expect(tag('WrapInPos')).toBe(true) // the station eye sees the load
    expect(tag('WrapBusy')).toBe(false) // a driven start tag holds Auto wrap off: nothing starts on its own
    expect(palletWrap(w)).toBeUndefined()
    w.setBehaviorInputTags({ WrapStart: true })
    for (let s = 0; s < 30; s++) w.step()
    expect(tag('WrapBusy')).toBe(true)
    expect(tag('WrapDone')).toBe(false)
    for (let s = 0; s < 40 * 60 && tag('WrapBusy') === true; s++) w.step()
    expect(tag('WrapBusy')).toBe(false)
    expect(tag('WrapDone')).toBe(true)
    expect(palletWrap(w)!.max[1]).toBeCloseTo(LOAD_TOP_LOCAL + 0.006, 3)
    w.dispose()
  }, 60000)

  it('brakes the arm and holds the cycle while its enable is down, then finishes the wrap from there', () => {
    const w = new SimWorld(Jolt, wrapperScene({ startTag: 'WrapStart', enableTag: 'WrapEnable', busyTag: 'WrapBusy', doneTag: 'WrapDone' }, load(-0.12)))
    w.setBehaviorDrivenTags(['WrapStart', 'WrapEnable'])
    const tag = (name: string): unknown => w.frame().tags?.['wrap']?.[name]
    const joints = (): Record<string, number> => w.frame().joints?.['wrap'] ?? {}
    // a start while the enable is down is ignored
    w.setBehaviorInputTags({ WrapStart: false, WrapEnable: false })
    for (let s = 0; s < 10; s++) w.step()
    w.setBehaviorInputTags({ WrapStart: true, WrapEnable: false })
    for (let s = 0; s < 60; s++) w.step()
    expect(tag('WrapBusy')).toBe(false)
    expect(joints()['arm']).toBe(0)
    // a fresh edge with the enable up starts the cycle; drop the enable once the carriage is partway up the climb
    w.setBehaviorInputTags({ WrapStart: false, WrapEnable: true })
    w.step()
    w.setBehaviorInputTags({ WrapStart: true, WrapEnable: true })
    for (let s = 0; s < 40 * 60 && (joints()['lift'] ?? 0) < 0.2; s++) w.step()
    expect(joints()['lift']).toBeGreaterThanOrEqual(0.2)
    const armAtDrop = joints()['arm']!
    w.setBehaviorInputTags({ WrapStart: true, WrapEnable: false })
    for (let s = 0; s < 30; s++) w.step()
    // stopped inside half a second, about a tenth of a turn on from where the enable fell
    const held = { ...joints() }
    const braked = (held['arm']! - armAtDrop + 2 * Math.PI) % (2 * Math.PI)
    expect(braked).toBeGreaterThan(0)
    expect(braked).toBeLessThan(0.15 * 2 * Math.PI)
    // ...and holds there, carriage and all, busy and not done, for as long as the enable stays down
    for (let s = 0; s < 3 * 60; s++) w.step()
    expect(joints()['arm']).toBe(held['arm'])
    expect(joints()['lift']).toBe(held['lift'])
    expect(tag('WrapBusy')).toBe(true)
    expect(tag('WrapDone')).toBe(false)
    expect(productState(w).units).toBe(0)
    // enable back: it carries on up from where it held (never back down to the base) and finishes the one cycle
    w.setBehaviorInputTags({ WrapStart: true, WrapEnable: true })
    for (let s = 0; s < 2 * 60; s++) w.step()
    expect(joints()['arm']).not.toBe(held['arm'])
    expect(joints()['lift']).toBeGreaterThanOrEqual(held['lift']!)
    for (let s = 0; s < 40 * 60 && tag('WrapBusy') === true; s++) w.step()
    expect(tag('WrapDone')).toBe(true)
    expect(palletWrap(w)!.max[1]).toBeCloseTo(LOAD_TOP_LOCAL + 0.006, 3)
    expect(productState(w).bodiesPerUnit).toEqual([9])
    w.dispose()
  }, 60000)

  it('starts an authored wrapped unit load as one body, marked, in its film, the film the idle frame draws', () => {
    // the load is exactly the unit load's children (the pallet and eight cases), as the author parented them
    const ul: PartInstance = { id: 'ul', type: 'part', packageId: 'oip.unit-load', position: [0, DECK_Y, 0], rotationY: 0, params: { wrapped: true, loadId: 'SSCC-1' } }
    const scene = wrapperScene({ autoWrap: false }, [ul, ...load(0).map((p) => ({ ...p, parent: 'ul' }))])
    const idle = buildAuthoredCargoFrame(scene.parts).dressings
    expect(idle).toHaveLength(1)
    expect(idle![0]!.max[1]).toBeCloseTo(LOAD_TOP_LOCAL + 0.006, 5)
    const w = new SimWorld(Jolt, scene)
    w.step()
    const run = palletWrap(w)!
    for (const k of [0, 1, 2] as const) {
      expect(run.min[k]).toBeCloseTo(idle![0]!.min[k], 4)
      expect(run.max[k]).toBeCloseTo(idle![0]!.max[k], 4)
    }
    expect(productState(w).units).toBe(1)
    expect(productState(w).bodiesPerUnit).toEqual([9])
    // its product attributes are the load's marks, read out on the unit load itself (the Inspector's source)
    expect(w.frame().marks?.['ul']).toEqual({ wrapped: true, loadId: 'SSCC-1' })
    expect(productState(w).palletMarks).toEqual({ wrapped: true, loadId: 'SSCC-1' })
    // the film in the unit load's own colour param, #dcecf2, as linear rgb
    expect(run.color[0]).toBeCloseTo(0.716, 2)
    expect(run.color[1]).toBeCloseTo(0.839, 2)
    expect(run.color[2]).toBeCloseTo(0.888, 2)
    w.dispose()
  })

  it('stacks a unit load with courses and nothing filed under it itself: the same pieces idle and running, one body', () => {
    // turned a quarter, so the pieces' poses go through the load's own rotation
    const ul: PartInstance = { id: 'ul', type: 'part', packageId: 'oip.unit-load', position: [0, DECK_Y, 0], rotationY: Math.PI / 2, params: { wrapped: true, loadId: 'L-7', courses: 3, caseColor: '#c09060' } }
    const scene = wrapperScene({ autoWrap: false }, [ul])
    const idle = buildAuthoredCargoFrame(scene.parts)
    // a pallet and three courses of five, every row selecting the load
    expect(idle.count).toBe(16)
    expect(idle.partIds.every((id) => id === 'ul')).toBe(true)
    expect(idle.kinds.filter((k) => k === CARGO_KIND_PALLET)).toHaveLength(1)
    expect(idle.dressings).toHaveLength(1)
    // the film over the top course: pallet half + three cases above the pallet centre, plus the standoff
    expect(idle.dressings![0]!.max[1]).toBeCloseTo(PALLET_H / 2 + 3 * CASE_H + 0.006, 4)
    // turned a quarter: the 1.2 m side of the load runs along world z
    let zMin = Infinity
    let zMax = -Infinity
    for (let i = 0; i < idle.count; i++) {
      if (idle.kinds[i] === CARGO_KIND_PALLET) continue
      zMin = Math.min(zMin, idle.positions[i * 3 + 2]! - 0.3)
      zMax = Math.max(zMax, idle.positions[i * 3 + 2]! + 0.3)
    }
    expect(zMax - zMin).toBeGreaterThan(0.99)
    const w = new SimWorld(Jolt, scene)
    w.step()
    const f = w.frame()
    expect(f.count).toBe(16)
    expect(f.partIds.every((id) => id === 'ul')).toBe(true)
    // the same pieces where the stopped view drew them, in the same film
    const run = f.dressings!
    expect(run).toHaveLength(1)
    for (const k of [0, 1, 2] as const) {
      expect(run[0]!.min[k]).toBeCloseTo(idle.dressings![0]!.min[k], 3)
      expect(run[0]!.max[k]).toBeCloseTo(idle.dressings![0]!.max[k], 3)
    }
    expect(productState(w).units).toBe(1)
    expect(productState(w).bodiesPerUnit).toEqual([16])
    expect(f.marks?.['ul']).toEqual({ wrapped: true, loadId: 'L-7' })
    // the case tint is the load's param (#c09060 as sRGB 0..1)
    const c = f.kinds.findIndex((k) => k !== CARGO_KIND_PALLET)
    expect(f.colors[c * 3]).toBeCloseTo(0xc0 / 255, 3)
    // it stands where it was put: a second of physics later the pallet is still on the deck
    for (let i = 0; i < 60; i++) w.step()
    const g = w.frame()
    const pal = g.kinds.indexOf(CARGO_KIND_PALLET)
    expect(g.positions[pal * 3 + 1]).toBeCloseTo(DECK_Y + PALLET_H / 2, 2)
    w.dispose()
  })

  it('lets cargo filed under a unit load win over its courses', () => {
    const ul: PartInstance = { id: 'ul', type: 'part', packageId: 'oip.unit-load', position: [0, DECK_Y, 0], rotationY: 0, params: { wrapped: true, courses: 3 } }
    const scene = wrapperScene({ autoWrap: false }, [ul, ...load(0).map((p) => ({ ...p, parent: 'ul' }))])
    expect(buildAuthoredCargoFrame(scene.parts).count).toBe(9)
    const w = new SimWorld(Jolt, scene)
    w.step()
    expect(w.frame().count).toBe(9)
    expect(productState(w).bodiesPerUnit).toEqual([9])
    w.dispose()
  })
})
