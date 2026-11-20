import { afterEach, describe, expect, it } from 'vitest'
import type { SdkPart } from '../types'
import { findSnap } from './snapFeatures'
import type { SnapPose } from './snapFeatures'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import { validatePartPackage } from '../parts/partValidate'
import type { PartPackage } from '../parts/partPackage'
import type { SnapSpec } from '../parts/partApi'
import { plugsOf } from './snapConnectors'

// The connector model (docs/part-snap-connectors.md): declarations compiled to plugs, kind gating, and the one
// ranking rule every kind shares. The kinds themselves are pinned against the real catalog by the golden table
// (src/editor/snapGolden.test.ts) and kind by kind in snapFeatures.test.ts.

const pose = (x: number, y: number, z: number, rot: number): SnapPose => ({ position: [x, y, z], rotationY: rot })

// a centre-origin SDK roller bed (ends at ±length/2), as in snapFeatures.test.ts
const rollerPkg = {
  format: PACKAGE_FORMAT,
  id: 'acme.roller',
  name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
  params: {
    length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
    speed: { type: 'number', default: 0.5 },
  },
  behavior: 'definePart({ step(){} })',
  geometry: {
    kind: 'rig',
    links: [
      { name: 'deck', shape: { kind: 'box', size: [3, 0.04, 0.6] }, offset: [0, -0.02, 0], conveys: true },
      { name: 'rollerGrid', shape: { kind: 'frame' }, offset: [0, -0.024, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.075, worldPhase: true } } },
    ],
    joints: [],
    bounds: { length: 3, width: 0.7, top: 1.2 },
  },
} as unknown as PartPackage
const roller = (id: string, x: number, z: number, rot = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'acme.roller', position: [x, 0.75, z], rotationY: rot, params: { length: 3, width: 0.6, speed: 0.5 } }) as unknown as SdkPart

/** a 1 x 1 x 1.2 box of a part carrying the given snap block */
function boxPkg(id: string, snap: SnapSpec, extraParams: Record<string, unknown> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: id,
    params: { ...extraParams },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1.2 } },
    snap,
  } as unknown as PartPackage
}
const box = (id: string, packageId: string, x: number, y: number, z: number, rot = 0, params: Record<string, unknown> = {}): SdkPart =>
  ({ id, type: 'part', packageId, position: [x, y, z], rotationY: rot, params }) as unknown as SdkPart

describe('plugsOf: a declaration compiled to connectors', () => {
  it('lists every mover-side kind once, labelled, in a fixed order, and caches per declaration', () => {
    const snap: SnapSpec = {
      flush: true,
      mounts: [{ at: [0, 0, 0], accepts: 'face' }, { at: [0, 0, 0], accepts: 'din' }],
      chain: { group: 'g', lengthParam: 'length', reach: 1 },
      surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width' }], // host-only: no plug
    }
    const plugs = plugsOf(snap)
    expect(plugs.map((p) => p.label)).toEqual(['chain', 'mounts[0]', 'mounts[1]', 'flush'])
    expect(plugsOf(snap)).toBe(plugs)
    expect(plugsOf(undefined)).toEqual([])
  })
})

describe('kind gating', () => {
  afterEach(() => clearPackages())

  it('a DIN relay ignores a conveyor, a guard sensor ignores a DIN surface', () => {
    const params = { length: { type: 'number', default: 0.8 }, width: { type: 'number', default: 0.4 } }
    registerPackage(rollerPkg)
    registerPackage(boxPkg('acme.cabinet', { surfaces: [{ kind: 'din', lengthParam: 'length', widthParam: 'width' }] }, params))
    registerPackage(boxPkg('acme.relay', { mounts: [{ at: [0, 0, -0.03], accepts: 'din', face: 'out' }] }))
    registerPackage(boxPkg('acme.eye', { mounts: [{ at: [0, 0, 0.03], accepts: 'conveyorGuard' }] }))
    const cabinet = box('c', 'acme.cabinet', 0, 0, 0, 0, { length: 0.8, width: 0.4 })
    expect(findSnap(box('r', 'acme.relay', 9, 0, 9), pose(0, 0.75, 0.4, 0), [roller('c', 0, 0)])).toBeNull()
    expect(findSnap(box('e', 'acme.eye', 9, 0, 9), pose(0, 0, 0.3, 0), [cabinet])).toBeNull()
    // and the relay does seat on the surface of its own kind
    expect(findSnap(box('r', 'acme.relay', 9, 0, 9), pose(0, 0, 0.3, 0), [cabinet])?.via).toBe('mounts[0] -> surfaces[0]')
  })
})

describe('one ranking rule across kinds', () => {
  afterEach(() => clearPackages())

  // A barrier that chains to its group and also seats along a deck edge, against a host that is both a chain
  // part and a deck. The cheaper candidate is chosen, whichever kind it is, not the kind declared first.
  it('takes the cheaper candidate, not the first-declared kind', () => {
    const params = { length: { type: 'number', default: 4 }, width: { type: 'number', default: 4 } }
    registerPackage(boxPkg('acme.deckrail', { chain: { group: 'g', lengthParam: 'length', reach: 3 }, surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width' }] }, params))
    registerPackage(boxPkg('acme.rail', { chain: { group: 'g', lengthParam: 'length', reach: 3 }, edgeMount: { accepts: 'deck', alongParam: 'length', reach: 3 } }, { length: { type: 'number', default: 1 } }))
    const host = box('h', 'acme.deckrail', 0, 0, 0, 0, { length: 4, width: 4 })
    const rail = box('m', 'acme.rail', 9, 0, 9, 0, { length: 1 })
    // just outside the deck's +Z edge, mid-span: the edge seat is ~0.1 m away, the nearest chain spot ~1.6 m
    const c = findSnap(rail, pose(0.3, 0, 2.1, 0.02), [host])
    expect(c?.via).toBe('edgeMount -> surfaces[0]')
    // collinear off the host's +X end: here the chain is the cheaper one
    const e = findSnap(rail, pose(2.6, 0, 0.05, 0.02), [host])
    expect(e?.via).toBe('chain -> chain')
  })
})

// `ports` and `rails` are retired snap kinds (docs/part-snap-connectors.md). An author is told why;
// a stored package loses them on load instead (packageUpgrade.test.ts).
describe('retired snap kinds', () => {
  const fields = (snap: unknown): string[] => validatePartPackage({ ...boxPkg('acme.v', {}), snap } as unknown as PartPackage).map((p) => p.field)

  it('refuses snap.ports and snap.rails in an authored manifest, by name', () => {
    expect(fields({ ports: [{ at: [0, 0, 0], dir: [1, 0], kind: 'x' }] })).toEqual(['snap.ports'])
    expect(fields({ rails: [{ kind: 'din', from: [0, 1, 0], to: [1, 1, 0], dir: [0, 1] }] })).toEqual(['snap.rails'])
  })
})
