import { describe, expect, it } from 'vitest'
import { canonicalMeshParts } from './geometry/geometryEval'
import { PACKAGE_FORMAT, type PackageUpgrade } from './parts/partPackage'
import { validatePartPackage } from './parts/partValidate'
import { canonicalSnap, deckRig, PACKAGE_UPGRADES, upgradeStoredPackage } from './parts/partUpgrade'

// A valid stored package at the current format: the smallest thing validatePartPackage accepts.
const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: PACKAGE_FORMAT,
  id: 't.deck',
  name: 'Deck',
  params: {},
  behavior: 'definePart({ step() {} })',
  geometry: deckRig(1, 0.5),
  ...over,
})

describe('upgradeStoredPackage', () => {
  it('returns a current package itself, uncopied, with nothing to report', () => {
    const raw = stored()
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect(pkg).toBe(raw)
    expect(repairs).toEqual([])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('runs each step in order from the stored format, stamps the new one, and reports what changed', () => {
    // a pretend history: format 1 called it `len`, 2 renamed it `length`, 3 moved it under `size`
    const upgrades: Record<number, PackageUpgrade> = {
      1: (p) => {
        const { len, ...rest } = p as { len?: number }
        return { pkg: { ...rest, length: len }, notes: ['len -> length'] }
      },
      2: (p) => {
        const { length, ...rest } = p as { length?: number }
        return { pkg: { ...rest, size: { length } }, notes: [] }
      },
    }
    const raw = { format: 1, id: 't.old', len: 2 }
    const before = structuredClone(raw)
    const { pkg, repairs } = upgradeStoredPackage(raw, upgrades, 3)
    expect(pkg).toEqual({ format: 3, id: 't.old', size: { length: 2 } })
    expect(repairs).toEqual(['package format 1 -> 3: len -> length'])
    expect(raw).toEqual(before) // a room's copy is shared: never mutated
  })

  it('leaves a package it cannot carry forward unchanged, for the validator to name', () => {
    // a step is missing: nothing half-upgraded comes out
    const gap = { format: 1, id: 't.gap' }
    expect(upgradeStoredPackage(gap, { 2: (p) => ({ pkg: p, notes: [] }) }, 3)).toEqual({ pkg: gap, repairs: [] })
    // saved by a newer build: refused by name, not as a corrupt file
    const newer = stored({ format: PACKAGE_FORMAT + 1 })
    expect(upgradeStoredPackage(newer).pkg).toBe(newer)
    expect(validatePartPackage(newer)).toEqual([{ field: 'format', message: expect.stringContaining('saved by a newer version') }])
    for (const junk of [null, undefined, 'x', 3, {}, { format: 'one' }]) expect(upgradeStoredPackage(junk).pkg).toBe(junk)
  })

  // `exposes` (a scoped cell's public tags) retired with PLC tag scoping. A stored package keeps loading,
  // without it: the field described nothing that runs, and a package problem would delete the part on load.
  it('drops a retired exposes from a stored package, and reports it', () => {
    const raw = stored({ exposes: [{ tag: 'done', dir: 'out', type: 'BOOL' }] })
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect('exposes' in pkg).toBe(false)
    expect(repairs).toEqual(["retired exposes (a scoped cell's public tags) dropped"])
    expect(validatePartPackage(pkg)).toEqual([])
    expect('exposes' in raw).toBe(true) // a room's copy is shared: never mutated
  })

  // `snap.ports` / `snap.rails` retired with no declarer. A custom part saved with them
  // keeps loading, keeps its other snap kinds, and stops snapping by those two.
  it('drops retired snap ports and rails from a stored package, keeps the rest of its snap block, and reports it', () => {
    const mounts = [{ at: [0, 0, 0], accepts: 'face' }]
    const raw = stored({
      snap: { mounts, ports: [{ at: [0, 0, 0], dir: [1, 0], kind: 'x' }], rails: [{ kind: 'din', from: [0, 0, 0], to: [1, 0, 0], dir: [0, 1] }] },
    })
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect((pkg as { snap: unknown }).snap).toEqual({ mounts })
    expect(repairs).toEqual(['retired snap.ports and snap.rails dropped'])
    expect(validatePartPackage(pkg)).toEqual([])
    expect('ports' in (raw.snap as object)).toBe(true) // never mutated
  })

  // RETIRED_SHAPE_KINDS is empty, so a stored chain lane is not dropped. It reaches validation, which refuses it
  // as an unknown kind.
  it('keeps a chain link (RETIRED_SHAPE_KINDS is empty), so validation refuses it', () => {
    const raw = stored({
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0, 0] },
          { name: 'lane', parent: 'base', shape: { kind: 'chain' }, offset: [0, 0, 0] },
        ],
        joints: [],
      },
    })
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect((pkg.geometry as { links: { name: string }[] }).links.map((l) => l.name)).toEqual(['base', 'lane'])
    expect(repairs.some((r) => r.includes('retired rig link'))).toBe(false)
    expect(validatePartPackage(pkg).map((p) => p.field)).toContain('geometry.links[1].shape.kind')
  })
})

describe('the retired sweep geometry', () => {
  // the swept belt bed the old kind existed for: a 1 m wide section, 3 m long, its length reflowed by a param
  const sweep = (): Record<string, unknown> =>
    stored({
      id: 't.swept',
      params: { length: { type: 'number', default: 3 } },
      geometry: {
        kind: 'mesh',
        sweep: { profile: [[-0.1, -0.5], [-0.1, 0.5], [0, 0.5], [0, -0.5]], length: 3, lengthParam: 'length', arcRadius: 2 },
        bounds: { length: 3, width: 1, height: 0.1 },
        conveys: true,
      },
    })

  it('is refused to an author, by name and with what to do instead', () => {
    expect(validatePartPackage(sweep())).toEqual([{ field: 'geometry.kind', message: expect.stringContaining('was retired: draw the bed in the behavior') }])
  })

  it('loads from a stored document as the flat deck the sim already built for it', () => {
    const raw = sweep()
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect(pkg.geometry).toEqual(deckRig(3, 1))
    expect(repairs).toEqual(['retired sweep geometry replaced by a flat deck of the same footprint'])
    expect(validatePartPackage(pkg)).toEqual([])
    expect((raw.geometry as { kind: string }).kind).toBe('mesh') // the stored copy is not mutated
  })

  it('falls back to the bounds, then to 1 m, when the sweep itself is unreadable', () => {
    const junk = stored({ geometry: { kind: 'mesh', sweep: { profile: 'x' }, bounds: { length: 2, width: 0.6, height: 0.1 } } })
    expect(upgradeStoredPackage(junk).pkg.geometry).toEqual(deckRig(2, 0.6))
    expect(upgradeStoredPackage(stored({ geometry: { kind: 'mesh' } })).pkg.geometry).toEqual(deckRig(1, 1))
  })

  it('leaves a rig link whose shape is a mesh (a GLB model) alone', () => {
    const raw = stored({ geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'mesh', asset: 'a' }, offset: [0, 0, 0] }], joints: [] } })
    expect(upgradeStoredPackage(raw).pkg).toBe(raw)
  })
})

describe('format 1 -> 2: the lamp fields', () => {
  // a format-1 rig with every spelling the seven fields had, as the shipped parts wrote them
  const v1 = (links: Record<string, unknown>[]): Record<string, unknown> =>
    stored({
      format: 1,
      geometry: { kind: 'rig', joints: [], links },
      assets: [{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }],
      materials: [{ id: 'm', color: [0.2, 0.2, 0.2] }, { id: 'r', color: [0.2, 0, 0] }, { id: 'g', color: [0, 0.2, 0] }],
    })
  const box = { kind: 'box', size: [0.05, 0.05, 0.05] }
  const at = [0, 0, 0]
  const links = (raw: Record<string, unknown>): Record<string, unknown>[] => (upgradeStoredPackage(raw).pkg.geometry as { links: Record<string, unknown>[] }).links

  it('a primitive lamp (a stack-light tier): emissive + lampOpacity + lampParam become its one lamp', () => {
    const [tier] = links(v1([{ name: 'seg1', shape: box, offset: at, color: [0.3, 0, 0], emissive: [1, 0, 0], lampOpacity: 0.92, lampParam: 'on' }]))
    // (read through to the current format: format 4 then moves the link's unlit colour onto the lamp)
    expect(tier).toEqual({ name: 'seg1', shape: box, offset: at, lamps: [{ emissive: [1, 0, 0], param: 'on', opacity: 0.92, offColor: [0.3, 0, 0] }] })
  })

  it("a mesh link's single lamp (the gantry tool): shape.lamp becomes the lamp's material", () => {
    const [tool] = links(v1([{ name: 'tool', shape: { kind: 'mesh', asset: 'glb', materials: { Standard: 'm' }, lamp: 'Standard' }, offset: at, emissive: [0.4, 1, 0.4], lampParam: 'vacuumOn' }]))
    expect(tool).toEqual({ name: 'tool', shape: { kind: 'mesh', asset: 'glb', materials: { Standard: 'm' } }, offset: at, lamps: [{ emissive: [0.4, 1, 0.4], material: 'Standard', param: 'vacuumOn' }] })
  })

  it("a mesh link's multi-lamp panel (the diverter): shape.lamps move to the link as they are", () => {
    const specs = [{ material: 'LampRed', name: 'red', emissive: [1, 0, 0] }, { material: 'LampGreen', name: 'green', emissive: [0, 1, 0], opacity: 0.9 }]
    const [pusher] = links(v1([{ name: 'pusher', shape: { kind: 'mesh', asset: 'glb', materials: { LampRed: 'r', LampGreen: 'g' }, lamps: specs }, offset: at }]))
    expect(pusher).toEqual({ name: 'pusher', shape: { kind: 'mesh', asset: 'glb', materials: { LampRed: 'r', LampGreen: 'g' } }, offset: at, lamps: specs })
  })

  it('lampSquash + squashLamp (the EOAT cups) become squash, on a mesh link', () => {
    const [, cups] = links(v1([
      { name: 'led', shape: box, offset: at, emissive: [0, 1, 0] },
      { name: 'cups', shape: { kind: 'mesh', asset: 'glb' }, offset: at, lampSquash: 0.15, squashLamp: 'led' },
    ]))
    expect(cups).toEqual({ name: 'cups', shape: { kind: 'mesh', asset: 'glb' }, offset: at, squash: { amount: 0.15, lamp: 'led' } })
  })

  it('the whole package validates as format 2, and a plain respelling reports nothing', () => {
    const raw = v1([
      { name: 'seg1', shape: box, offset: at, emissive: [1, 0, 0], lampOpacity: 0.92 },
      { name: 'pusher', shape: { kind: 'mesh', asset: 'glb', materials: { LampRed: 'r' }, lamps: [{ material: 'LampRed', name: 'red', emissive: [1, 0, 0] }] }, offset: at },
      { name: 'cups', shape: { kind: 'mesh', asset: 'glb' }, offset: at, lampSquash: 0.15, squashLamp: 'seg1' },
    ])
    const { pkg, repairs } = upgradeStoredPackage(raw)
    expect(pkg.format).toBe(PACKAGE_FORMAT) // through every later step too
    expect(repairs).toEqual([])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('drops, with a note, what format 1 accepted and never drew', () => {
    const { pkg, repairs } = upgradeStoredPackage(v1([
      // an emissive on a mesh link with no `lamp` material had nothing to light
      { name: 'cap', shape: { kind: 'mesh', asset: 'glb' }, offset: at, emissive: [1, 0, 0] },
      // lampSquash only ever squashed a mesh link's clones
      { name: 'pad', shape: box, offset: at, lampSquash: 0.2 },
    ]))
    expect(links(pkg as Record<string, unknown>).map((l) => [l.lamps, l.squash])).toEqual([[undefined, undefined], [undefined, undefined]])
    expect(repairs).toEqual([`package format 1 -> ${PACKAGE_FORMAT}: link "cap": emissive on a mesh with no lamp material lit nothing; dropped; link "pad": lampSquash off a mesh link squashed nothing; dropped`])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('leaves a non-rig package alone apart from its format', () => {
    const { pkg } = upgradeStoredPackage(stored({ format: 1 }))
    expect(pkg).toEqual(stored())
  })
})

describe('format 2 -> 3: the stair-and-platform words', () => {
  const v2 = (over: Record<string, unknown>): Record<string, unknown> => stored({ format: 2, ...over })
  const box = { kind: 'box', size: [0.05, 0.05, 0.05] }
  const at = [0, 0, 0]

  it('railing becomes onEdge, stairFoot becomes anchor: floor', () => {
    const { pkg, repairs } = upgradeStoredPackage(v2({ geometry: { kind: 'rig', joints: [], links: [
      { name: 'post', shape: box, offset: at, railing: 'posX' },
      { name: 'newel', shape: box, offset: at, stairFoot: true },
      { name: 'plain', shape: box, offset: at },
    ] } }))
    expect((pkg.geometry as { links: unknown[] }).links).toEqual([
      { name: 'post', shape: box, offset: at, onEdge: 'posX' },
      { name: 'newel', shape: box, offset: at, anchor: 'floor' },
      { name: 'plain', shape: box, offset: at },
    ])
    expect(repairs).toEqual([])
  })

  it("a stairMount becomes the edge mount it always was, with format 2's defaults filled in", () => {
    const { pkg } = upgradeStoredPackage(v2({ snap: { stairMount: { accepts: 'deck', widthParam: 'width', stepsParam: 'numSteps', reach: 3, landingDepth: 0.6 } } }))
    expect(pkg.snap).toEqual({
      edgeMount: {
        accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into', at: [0.6, 0, 0],
        atParams: [{ axis: 0, param: 'numSteps', scale: 0.28 }, { axis: 1, param: 'numSteps', scale: 0.178 }],
        fromFloor: { param: 'numSteps' }, opens: true, notch: true, lift: true,
      },
    })
    // an authored rise, tread and top offset carry over instead of the defaults
    const custom = upgradeStoredPackage(v2({ snap: { stairMount: { accepts: 'deck', widthParam: 'w', stepsParam: 'n', reach: 2, risePerStep: 0.2, treadRun: 0.3, topOffset: 0.025 } } })).pkg.snap as { edgeMount: { at: number[]; atParams: unknown[] } }
    expect(custom.edgeMount.at).toEqual([0, 0.025, 0])
    expect(custom.edgeMount.atParams).toEqual([{ axis: 0, param: 'n', scale: 0.3 }, { axis: 1, param: 'n', scale: 0.2 }])
  })

  it("a mount facing out onto a conveyor guard says opens, because that is what format 2 read it as", () => {
    const { pkg } = upgradeStoredPackage(v2({ snap: { mounts: [
      { at, accepts: 'conveyorGuard', face: 'out' },
      { at, accepts: 'conveyorGuard' }, // a sensor: facing in, never opened anything
      { at, accepts: 'face', face: 'out' }, // a button on a cabinet face: not a guard
    ] } }))
    expect((pkg.snap as { mounts: { opens?: boolean }[] }).mounts.map((m) => m.opens)).toEqual([true, undefined, undefined])
  })

  it('a part with both keeps its edgeMount and says what it dropped', () => {
    const { pkg, repairs } = upgradeStoredPackage(v2({ snap: { edgeMount: { accepts: 'deck', alongParam: 'length', reach: 3 }, stairMount: { accepts: 'deck', widthParam: 'width', stepsParam: 'numSteps', reach: 3 } } }))
    expect(pkg.snap).toEqual({ edgeMount: { accepts: 'deck', alongParam: 'length', reach: 3 } })
    expect(repairs).toEqual([`package format 2 -> ${PACKAGE_FORMAT}: snap.stairMount dropped: the part also declares an edgeMount, and a package has one edge connector`])
  })

  it('an author still writing the old words is told the new ones, by name', () => {
    const problems = validatePartPackage(stored({ snap: { stairMount: { accepts: 'deck', widthParam: 'width', stepsParam: 'numSteps', reach: 3 } }, geometry: { kind: 'rig', joints: [], links: [{ name: 'a', shape: box, offset: at, railing: 'posX', stairFoot: true }] } }))
    expect(problems.map((p) => p.field).sort()).toEqual(['geometry.links[0].railing', 'geometry.links[0].stairFoot', 'snap.stairMount'])
  })
})

describe('format 3 -> 4: the vocabulary pass', () => {
  const v3 = (over: Record<string, unknown>): Record<string, unknown> => stored({ format: 3, ...over })
  const rig = (links: Record<string, unknown>[]) => ({ kind: 'rig', joints: [], links, bounds: { length: 1, width: 1, top: 1 } })
  const at = [0, 0, 0]
  const links = (raw: Record<string, unknown>): Record<string, unknown>[] => (upgradeStoredPackage(raw).pkg.geometry as { links: Record<string, unknown>[] }).links

  it('edges becomes outline; noCollision becomes collision: none; a mesh box moves to its link', () => {
    const [marker, cup, model] = links(v3({ geometry: rig([
      { name: 'marker', shape: { kind: 'box', size: [1, 1, 1] }, offset: at, edges: [0.3, 0.6, 0.9], noCollision: true },
      { name: 'cup', shape: { kind: 'box', size: [1, 1, 1] }, offset: at, noCollision: false },
      { name: 'arm', shape: { kind: 'mesh', asset: 'glb', collision: { size: [0.4, 0.4, 0.5] } }, offset: at },
    ]) }))
    expect(marker).toEqual({ name: 'marker', shape: { kind: 'box', size: [1, 1, 1] }, offset: at, outline: [0.3, 0.6, 0.9], collision: 'none' })
    expect(cup).toEqual({ name: 'cup', shape: { kind: 'box', size: [1, 1, 1] }, offset: at })
    expect(model).toEqual({ name: 'arm', shape: { kind: 'mesh', asset: 'glb' }, offset: at, collision: { box: [0.4, 0.4, 0.5] } })
  })

  it("geometry kind 'function' becomes 'drawn'", () => {
    const { pkg } = upgradeStoredPackage(v3({ geometry: { kind: 'function', bounds: { length: 1, width: 1, height: 1 }, conveys: true } }))
    expect(pkg.geometry).toEqual({ kind: 'drawn', bounds: { length: 1, width: 1, top: 1 }, conveys: true })
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it("a one-box 'deck' geometry becomes the same conveyor as a rig, and a 'deck' shape a conveying box", () => {
    const { pkg } = upgradeStoredPackage(v3({ geometry: { kind: 'deck', length: 6, width: 1 } }))
    expect(pkg.geometry).toEqual(deckRig(6, 1))
    expect(validatePartPackage(pkg)).toEqual([])
    const [slab] = links(v3({ geometry: rig([{ name: 'slab', shape: { kind: 'deck', length: 2, width: 0.8, height: 0.05 }, offset: at }]) }))
    expect(slab).toEqual({ name: 'slab', shape: { kind: 'box', size: [2, 0.05, 0.8] }, offset: at, conveys: true })
  })

  it('an author writing the format 3 words is told the new ones, by name', () => {
    const fields = (geometry: Record<string, unknown>): string[] => validatePartPackage(stored({ geometry })).map((p) => p.field).sort()
    expect(fields({ kind: 'function', bounds: { length: 1, width: 1, top: 1 } })).toEqual(['geometry.kind'])
    expect(fields({ kind: 'deck', length: 1, width: 1 })).toEqual(['geometry.kind'])
    expect(fields(rig([{ name: 'a', shape: { kind: 'box', size: [1, 1, 1] }, offset: at, edges: [1, 1, 1], noCollision: true }]))).toEqual(['geometry.links[0].edges', 'geometry.links[0].noCollision'])
  })

  it("a stored behavior's geometry() still returning format 3 collision words is read in the current ones", () => {
    const parts = canonicalMeshParts([{ desc: { positions: [0, 0, 0], indices: [], uvs: [] }, collision: 'static' as never }, { desc: { positions: [0, 0, 0], indices: [], uvs: [] }, collision: 'staticHull' as never }])
    expect(parts.map((p) => p.collision)).toEqual(['box', 'hull'])
  })

  it('role splits into finish plus the behaviors it switched on, each only where format 3 applied it', () => {
    const box = { kind: 'box', size: [1, 0.1, 0.01] }
    const zAt = (scale: number) => [{ axis: 2, param: 'width', scale }]
    const [bed, guardL, guardR, rail, disc, lip, deck, tread, leg] = links(v3({ geometry: rig([
      { name: 'bed', shape: box, offset: at, conveys: true },
      { name: 'guardL', shape: box, offset: [0, 0.1, -0.5], role: 'guard' },
      { name: 'guardR', shape: box, offset: at, offsetParams: zAt(0.5), role: 'guard' },
      { name: 'rail', shape: box, offset: [0, -0.1, 0.5], role: 'frame' },
      { name: 'disc', shape: { kind: 'cylinder', radius: 0.5, height: 0.1 }, offset: [0, -0.1, 0.4], role: 'frame' },
      { name: 'lip', shape: box, offset: at, role: 'guard' },
      { name: 'deck', shape: box, offset: at, role: 'deck' },
      { name: 'tread', shape: { kind: 'cylinder', radius: 0.1, height: 1 }, offset: at, role: 'deck' },
      { name: 'leg', shape: box, offset: [0, -0.5, 0.4], role: 'leg' },
    ]) }))
    expect(bed).not.toHaveProperty('finish')
    expect(guardL).toMatchObject({ finish: 'guard', sideGuard: 'left' })
    expect(guardR).toMatchObject({ finish: 'guard', sideGuard: 'right' }) // side from the width-scaled offset
    expect(rail).toMatchObject({ finish: 'frame', sideRail: 'right', bed: true })
    expect(disc).toMatchObject({ finish: 'frame', bed: true }) // a frame on a conveying rig joined the gates, sided or not
    expect(disc).not.toHaveProperty('sideRail') // only a box splits and retracts
    expect(lip).toEqual({ name: 'lip', shape: box, offset: at, finish: 'guard' }) // centred: never a side wall
    expect(deck).toMatchObject({ finish: 'deck', notchable: true })
    expect(tread).not.toHaveProperty('notchable')
    expect(leg).toEqual({ name: 'leg', shape: box, offset: [0, -0.5, 0.4], finish: 'leg' })
    for (const l of [bed, guardL, guardR, rail, disc, lip, deck, tread, leg]) expect(l).not.toHaveProperty('role')
    // a frame on a rig that conveys nothing never joined the conveyor gates
    const [still] = links(v3({ geometry: rig([{ name: 'rail', shape: box, offset: [0, 0, 0.5], role: 'frame' }]) }))
    expect(still).toEqual({ name: 'rail', shape: box, offset: [0, 0, 0.5], finish: 'frame', sideRail: 'right' })
  })

  it('an author writing role is told the new words; the behavior fields are checked', () => {
    const fields = (links: Record<string, unknown>[]): string[] => validatePartPackage(stored({ geometry: rig(links) })).map((p) => p.field).sort()
    const box = { kind: 'box', size: [1, 1, 1] }
    expect(fields([{ name: 'a', shape: box, offset: at, role: 'guard' }])).toEqual(['geometry.links[0].role'])
    expect(fields([{ name: 'a', shape: box, offset: at, finish: 'shiny' }])).toEqual(['geometry.links[0].finish'])
    expect(fields([{ name: 'a', shape: box, offset: at, sideGuard: 'up' }])).toEqual(['geometry.links[0].sideGuard'])
    expect(fields([{ name: 'a', shape: { kind: 'cylinder', radius: 1, height: 1 }, offset: at, sideRail: 'left' }])).toEqual(['geometry.links[0].sideRail'])
    expect(fields([{ name: 'a', shape: box, offset: at, sideGuard: 'left', sideRail: 'left' }])).toEqual(['geometry.links[0].sideRail'])
    expect(fields([{ name: 'a', shape: { kind: 'cylinder', radius: 1, height: 1 }, offset: at, notchable: true }])).toEqual(['geometry.links[0].notchable'])
    expect(fields([{ name: 'a', shape: box, offset: at, finish: 'guard', sideGuard: 'left', bed: true }, { name: 'b', shape: box, offset: at, finish: 'deck', notchable: true }])).toEqual([])
    // one finish vocabulary for a link and a drawn submesh (partApi Finish)
    expect(fields([{ name: 'a', shape: box, offset: at, finish: 'gapfill' }, { name: 'b', shape: box, offset: at, finish: 'mesh' }])).toEqual([])
  })

  it("an array's enabledParam becomes the link's showParam; an array that was only the gate goes", () => {
    const box = { kind: 'box', size: [1, 1, 1] }
    const grid = { x: { sizeParam: 'length', maxSpacing: 2 }, z: { sizeParam: 'width', maxSpacing: 2 } }
    const [rail, posts, cols, both] = links(v3({ geometry: rig([
      { name: 'rail', shape: box, offset: at, array: { enabledParam: 'showRailings' } },
      { name: 'posts', shape: box, offset: at, array: { distribute: { axis: 2, spanParam: 'width', maxSpacing: 2 }, enabledParam: 'showRailings' } },
      { name: 'cols', shape: box, offset: at, array: { grid: { ...grid, enabledParam: 'showSupports' } } },
      { name: 'both', shape: box, offset: at, showParam: 'a', array: { count: 'n', step: [1, 0, 0], enabledParam: 'b' } },
    ]) }))
    expect(rail).toEqual({ name: 'rail', shape: box, offset: at, showParam: 'showRailings' })
    expect(posts).toEqual({ name: 'posts', shape: box, offset: at, array: { distribute: { axis: 2, spanParam: 'width', maxSpacing: 2 } }, showParam: 'showRailings' })
    expect(cols).toEqual({ name: 'cols', shape: box, offset: at, array: { grid }, showParam: 'showSupports' })
    expect(both).toMatchObject({ showParam: 'a', array: { count: 'n', step: [1, 0, 0] } })
    // one link can't keep both switches, so the upgrade reports a lossy repair
    const { repairs: notes } = upgradeStoredPackage(v3({ geometry: rig([{ name: "both", shape: box, offset: at, showParam: "a", array: { count: "n", step: [1, 0, 0], enabledParam: "b" } }]) }))
    expect(notes.join(' ')).toMatch(/both showParam "a" and an array gate "b"/)
    // an author writing the old word is told the new one
    const fields = validatePartPackage(stored({ geometry: rig([{ name: 'r', shape: box, offset: at, array: { enabledParam: 'x' } }]) })).map((p) => p.field)
    expect(fields).toEqual(['geometry.links[0].array.enabledParam'])
  })

  it("a primitive lamp link's color becomes its lamp's offColor; a mesh link keeps its color", () => {
    const cyl = { kind: 'cylinder', radius: 0.1, height: 0.1 }
    const [lens, set, model] = links(v3({ geometry: rig([
      { name: 'lens', shape: cyl, offset: at, color: [0.2, 0.2, 0.2], lamps: [{ emissive: [1, 0, 0], opacity: 0.9 }] },
      { name: 'set', shape: cyl, offset: at, color: [0.2, 0.2, 0.2], lamps: [{ emissive: [0, 1, 0], offColor: [0.1, 0.1, 0.1] }] },
      { name: 'cap', shape: { kind: 'mesh', asset: 'glb', materials: { Lens: 'lens' } }, offset: at, color: [0.5, 0.5, 0.5], lamps: [{ emissive: [0, 0, 1], material: 'Lens' }] },
    ]) }))
    expect(lens).toEqual({ name: 'lens', shape: cyl, offset: at, lamps: [{ emissive: [1, 0, 0], opacity: 0.9, offColor: [0.2, 0.2, 0.2] }] })
    expect(set).toEqual({ name: 'set', shape: cyl, offset: at, lamps: [{ emissive: [0, 1, 0], offColor: [0.1, 0.1, 0.1] }] }) // an authored offColor is kept
    expect(model).toMatchObject({ color: [0.5, 0.5, 0.5] }) // ignored on a mesh link, and not a lamp colour there
    const fields = validatePartPackage(stored({ geometry: rig([{ name: 'l', shape: cyl, offset: at, color: [0.2, 0.2, 0.2], lamps: [{ emissive: [1, 0, 0], offColor: 'grey' }] }]) })).map((p) => p.field).sort()
    expect(fields).toEqual(['geometry.links[0].color', 'geometry.links[0].lamps[0].offColor'])
  })

  it("bounds say their own vertical extent: height / floorY become top / bottom, and a cargo box's bounds its size", () => {
    const geo = (g: Record<string, unknown>) => upgradeStoredPackage(v3({ geometry: g })).pkg.geometry
    expect(geo({ kind: 'rig', joints: [], links: [], bounds: { length: 1, width: 2, height: 0.5, floorY: -0.4 } })).toMatchObject({ bounds: { length: 1, width: 2, top: 0.5, bottom: -0.4 } })
    expect(geo({ kind: 'drawn', bounds: { length: 1, width: 2, height: 0.3 } })).toEqual({ kind: 'drawn', bounds: { length: 1, width: 2, top: 0.3 } })
    expect(geo({ kind: 'cargo', cargoKind: 'box', bounds: { length: 0.6, width: 0.4, height: 0.4 } })).toEqual({ kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } })
    const fields = (geometry: Record<string, unknown>): string[] => validatePartPackage(stored({ geometry })).map((p) => p.field).sort()
    expect(fields({ kind: 'drawn', bounds: { length: 1, width: 1, height: 1 } })).toEqual(['geometry.bounds', 'geometry.bounds.height'])
    expect(fields({ kind: 'drawn', bounds: { length: 1, width: 1, top: 1, bottom: 2 } })).toEqual(['geometry.bounds.bottom'])
    // an off-centre box and param-driven fields (PartBounds.centerX / centerZ / params)
    expect(fields({ kind: 'drawn', bounds: { length: 1, width: 1, top: 1, centerZ: -0.4, params: [{ field: 'width', param: 'stroke', add: 0.6 }] } })).toEqual([])
    expect(fields({ kind: 'drawn', bounds: { length: 1, width: 1, top: 1, centerX: 'a', params: [{ field: 'depth', param: 'stroke' }, { field: 'top', param: '' }] } })).toEqual(
      ['geometry.bounds.centerX', 'geometry.bounds.params[0].field', 'geometry.bounds.params[1].param'],
    )
    expect(fields({ kind: 'cargo', cargoKind: 'box', bounds: { length: 1, width: 1, height: 1 } })).toEqual(['geometry.bounds', 'geometry.size'])
  })

  it("a gripper's grabZone / grabRadius / grabParams become one grip block", () => {
    const frame = { kind: 'frame' }
    const zone = { size: [1, 2, 1], offset: [0.5, 0, 0], sizeParams: [{ axis: 0, param: 'w' }] }
    const radiusParams = [{ axis: 0, param: 'tool', scale: 0.5 }]
    const [fork, cup, plain] = links(v3({ geometry: rig([
      { name: 'fork', shape: frame, offset: at, grabZone: zone },
      { name: 'cup', shape: frame, offset: at, grabRadius: 0.45, grabParams: radiusParams },
      { name: 'plain', shape: frame, offset: at },
    ]) }))
    expect(fork).toEqual({ name: 'fork', shape: frame, offset: at, grip: { zone } })
    expect(cup).toEqual({ name: 'cup', shape: frame, offset: at, grip: { radius: 0.45, radiusParams } })
    expect(plain).toEqual({ name: 'plain', shape: frame, offset: at })
    const fields = validatePartPackage(stored({ geometry: rig([{ name: 'f', shape: frame, offset: at, grabZone: zone, grip: { radius: -1 } }]) })).map((p) => p.field).sort()
    expect(fields).toEqual(['geometry.links[0].grabZone', 'geometry.links[0].grip.radius'])
  })

  it('snap.edges becomes snap.tile, in a stored package and in a snap a stored script still declares', () => {
    const tile = { group: 'floorMarking', lengthParam: 'length', widthParam: 'width', cornerFlush: true }
    const { pkg } = upgradeStoredPackage(v3({ geometry: rig([]), snap: { edges: tile, flush: true } }))
    expect(pkg.snap).toEqual({ tile, flush: true })
    expect(canonicalSnap({ edges: tile })).toEqual({ tile })
    const current = { tile }
    expect(canonicalSnap(current)).toBe(current) // nothing to change: the same object
    const fields = validatePartPackage(stored({ snap: { edges: tile } })).map((p) => p.field)
    expect(fields).toEqual(['snap.edges'])
  })

  it("a stored behavior's geometry() still returning lamp + emissive is read as lamps", () => {
    const desc = { positions: [0, 0, 0], indices: [], uvs: [] }
    const [lit, white, current] = canonicalMeshParts([
      { desc, lamp: 'cap', emissive: [1, 0, 0], colorParam: 'c' } as never,
      { desc, lamp: 'led' } as never,
      { desc, lamps: [{ name: 'x', emissive: [0, 1, 0] }] },
    ])
    expect(lit).toEqual({ desc, lamps: [{ name: 'cap', emissive: [1, 0, 0] }], colorParam: 'c' })
    expect(white).toEqual({ desc, lamps: [{ name: 'led', emissive: [1, 1, 1] }] }) // format 3's default lit colour
    expect(current).toEqual({ desc, lamps: [{ name: 'x', emissive: [0, 1, 0] }] })
  })

  it("a stored behavior's geometry() still returning role is read as finish, and a guard wall as a side guard", () => {
    const wall = (z: number) => ({ positions: [0, 0, z - 0.01, 1, 1, z + 0.01], indices: [], uvs: [] })
    const [left, right, lip, bed] = canonicalMeshParts([
      { desc: wall(-0.5), role: 'guard', collision: 'static' } as never,
      { desc: wall(0.5), role: 'guard', collision: 'box' } as never,
      { desc: wall(0.5), role: 'guard' } as never,
      { desc: wall(0), role: 'belt' } as never,
    ])
    expect(left).toMatchObject({ finish: 'guard', collision: 'box', sideGuard: 'left' })
    expect(right).toMatchObject({ finish: 'guard', collision: 'box', sideGuard: 'right' })
    expect(lip).toEqual({ desc: wall(0.5), finish: 'guard' }) // no collider: nothing to merge
    expect(bed).toEqual({ desc: wall(0), finish: 'belt' })
  })
})

describe('format 4 -> 5: a beam names its params', () => {
  const v4 = (over: Record<string, unknown>): Record<string, unknown> => stored({ format: 4, ...over })
  const eye = (beam: Record<string, unknown>) => ({ kind: 'rig', joints: [], bounds: { length: 1, width: 1, top: 1 }, links: [
    { name: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
    { name: 'lens', shape: { kind: 'frame' }, offset: [0, 0, 0.05], beam },
  ] })
  const sensorParams = { maxRange: { type: 'number', default: 2 }, showBeam: { type: 'boolean', default: true } }
  const beamOf = (raw: Record<string, unknown>) => (upgradeStoredPackage(raw).pkg.geometry as { links: { beam?: unknown }[] }).links[1]!.beam

  it("a beam that relied on the maxRange / showBeam names says them; the part's other links are untouched", () => {
    const raw = v4({ params: sensorParams, geometry: eye({ range: 10, tint: 'hit' }) })
    const { pkg, repairs } = upgradeStoredPackage(raw)
    const links = (pkg.geometry as { links: unknown[] }).links
    expect(links[1]).toMatchObject({ beam: { range: 10, tint: 'hit', rangeParam: 'maxRange', showParam: 'showBeam' } })
    expect(links[0]).toBe((raw.geometry as { links: unknown[] }).links[0])
    expect(repairs.some((r) => r.includes('lens') && r.includes('maxRange'))).toBe(true)
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it("a beam that already names a range param keeps it (format 4's rangeParam outranked the name)", () => {
    expect(beamOf(v4({ params: { ...sensorParams, width: { type: 'number', default: 1 } }, geometry: eye({ range: 1, rangeParam: 'width' }) }))).toEqual({ range: 1, rangeParam: 'width', showParam: 'showBeam' })
  })

  it('names only what the part has, and only a param of the type the host read', () => {
    expect(beamOf(v4({ params: { showBeam: { type: 'boolean', default: false } }, geometry: eye({ range: 2 }) }))).toEqual({ range: 2, showParam: 'showBeam' })
    expect(beamOf(v4({ params: { maxRange: { type: 'string', default: 'far' } }, geometry: eye({ range: 2 }) }))).toEqual({ range: 2 })
  })

  it('a part with neither name comes through as the same object', () => {
    const raw = v4({ params: { reach: { type: 'number', default: 1 } }, geometry: eye({ range: 2 }) })
    expect(upgradeStoredPackage(raw).pkg.geometry).toBe(raw.geometry)
  })
})

describe('PACKAGE_UPGRADES', () => {
  // A bump without its step would make every document saved before it fail to load. This is the tripwire.
  it('has a step from every format below the current one, and none past it', () => {
    for (let f = 1; f < PACKAGE_FORMAT; f++) expect(PACKAGE_UPGRADES[f], `no upgrade from format ${f}`).toBeTypeOf('function')
    for (const k of Object.keys(PACKAGE_UPGRADES)) expect(Number(k)).toBeLessThan(PACKAGE_FORMAT)
  })
})
