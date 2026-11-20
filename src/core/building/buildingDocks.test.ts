import { describe, expect, it } from 'vitest'
import { dockOpeningBlocker, dockOpenings, openDockOpenings, PERSONNEL_DOOR_AT, personnelDoors } from './buildingDocks'
import { toWorldXZ } from '../parts/partGeometry'
import { registerPackage } from '../parts/partRegistry'
import { defaultBuilding } from '../scene/scene'
import type { PartInstance } from '../types'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// The default shell's loading dock: one dock_door rule on front-wall cell 2 with two openings, 4.5 m apart and
// centred on the building (render/parts/dockDoor.ts draws them there; the sim cuts its wall at the same points).
describe('building dock openings', () => {
  it('finds the default shell\'s two dock doors on the front (-z) wall, centred', () => {
    const b = defaultBuilding()
    const docks = dockOpenings(b)
    expect(docks.map((d) => d.key)).toEqual(['2:0', '2:1'])
    const halfW = (b.params.widthSections * 10) / 2
    expect(docks[0]!.x).toBeCloseTo(-2.25, 9)
    expect(docks[1]!.x).toBeCloseTo(2.25, 9)
    for (const d of docks) expect(d.z).toBeCloseTo(-halfW, 9)
  })

  // a personnel door is mid-cell on its run, and only where a rule paints one: it is not a dock opening
  it('finds personnel doors mid-cell on the cells their rule paints, and none on the default shell', () => {
    const b = defaultBuilding()
    expect(personnelDoors(b)).toEqual([])
    b.params.rules = [...(b.params.rules ?? []), { wall: 'personnel_door', run: 1, gap: 0, count: 1, start: 0, doorCount: 1, trailer: false }]
    const doors = personnelDoors(b)
    expect(doors.map((d) => d.idx)).toEqual([0])
    // front-wall cell 0 runs +x from the -x corner, so its door is PERSONNEL_DOOR_AT along from that corner
    const halfL = (b.params.lengthSections * 10) / 2
    const halfW = (b.params.widthSections * 10) / 2
    expect(doors[0]!.x).toBeCloseTo(-halfL + PERSONNEL_DOOR_AT, 9)
    expect(doors[0]!.z).toBeCloseTo(-halfW, 9)
    expect(dockOpenings(b).map((d) => d.key)).toEqual(['2:0', '2:1'])
  })

  it('reports only the doors the building holds open', () => {
    const b = defaultBuilding()
    expect(openDockOpenings(b)).toEqual([])
    b.params.openDoors = ['2:1']
    expect(openDockOpenings(b).map((d) => d.key)).toEqual(['2:1'])
  })

  // a leaf closes only onto a clear doorway: something standing in the opening (a conveyor run out through it) holds it
  it('finds what stands in a doorway, and nothing beside it or above it', () => {
    const b = defaultBuilding()
    const [left, right] = dockOpenings(b)
    // a 1 m deck: a real footprint, no bundled part needed
    registerPackage({ format: PACKAGE_FORMAT, id: 'acme.block', name: 'block', params: {}, behavior: 'definePart(() => ({}))', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } })
    const at = (o: typeof left, dx: number, y: number): PartInstance => {
      const w = toWorldXZ(b, o!.x + dx, o!.z)
      return { id: `blk${dx}:${y}`, type: 'part', packageId: 'acme.block', position: [w.x, y, w.z], rotationY: 0, params: {} } as unknown as PartInstance
    }
    const inDoor = at(left, 0, 0.5)
    expect(dockOpeningBlocker(b, left!.key, [b, inDoor])).toBe(inDoor)
    expect(dockOpeningBlocker(b, right!.key, [b, inDoor])).toBeNull()
    expect(dockOpeningBlocker(b, left!.key, [b, at(left, 3, 0.5)])).toBeNull()
    expect(dockOpeningBlocker(b, left!.key, [b, at(left, 0, 10)])).toBeNull()
    expect(dockOpeningBlocker(b, 'nope', [b, inDoor])).toBeNull()
  })
})
