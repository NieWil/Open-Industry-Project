import { afterEach, describe, expect, it } from 'vitest'
import { partFootprint, restOnSurface } from '../../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance } from '../../core/types'
import { examplePart, type RigGeo } from './examplePart'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// Regression: the blade stop, chain transfer and diverter are conveyor-mounted equipment whose rig origin sits
// at the belt/deck surface, so their real geometry (housing, deck, chain lanes - mostly GLB meshes core can't measure)
// hangs well below local y=0. Each committed rig.json bakes that true assembled underside as `bounds.floorY`
// (the build script computes it from the GLB). partFootprint folds floorY into the footprint's `y0` so a
// free-standing floor drop rests the true underside on the floor. With y0=0 the origin sits on the floor and
// the mechanism sinks through it ("blade stop / chain transfer snap below the floor"). A rig that declares no
// floorY keeps a bottom-origin footprint (y0=0), so a floor-standing rig (e.g. the stairs, whose sloped
// stringer corner merely clips below the origin) is never spuriously lifted off the floor.

const FLOOR = { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] }

// register the committed example geometry verbatim (its bounds carry the baked floorY)
function registerRig(id: string): void {
  const { geometry } = examplePart<RigGeo>(id)
  registerPackage({ format: PACKAGE_FORMAT, id, name: id, params: {}, behavior: 'definePart({ step(){} })', geometry } as unknown as PartPackage)
}

function part(packageId: string, params: Record<string, number | boolean | string>): PartInstance {
  return { id: 'p', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params } as unknown as PartInstance
}

describe('mounted-equipment rigs rest on the floor, not through it (bounds.floorY)', () => {
  afterEach(() => clearPackages())

  it('blade stop: floorY seats the housing underside on the floor', () => {
    registerRig('oip.blade-stop')
    const p = part('oip.blade-stop', { width: 1.524, active: false, raiseHeight: 0.06, airPressureHeight: 0.07 })
    const fp = partFootprint(p)
    expect(fp.y0).toBeCloseTo(-0.5295, 6) // the static housing (Base* GLB nodes) reach here, below the collider (−0.26)
    const rested = restOnSurface(p, FLOOR.point, FLOOR.normal)
    expect(rested[1]).toBeCloseTo(-fp.y0, 9) // origin lifted so the underside lands exactly on y=0
    expect(rested[1]).toBeGreaterThan(0) // nothing sinks below the floor
  })

  it('diverter: floorY seats the pusher housing underside on the floor', () => {
    registerRig('oip.diverter')
    const p = part('oip.diverter', { diverted: false, divertTime: 0.25, divertDistance: 0.75 })
    const fp = partFootprint(p)
    expect(fp.y0).toBeCloseTo(-0.3847, 6) // the static Pusher housing reaches here, below the arms (+0.25)
    const rested = restOnSurface(p, FLOOR.point, FLOOR.normal)
    expect(rested[1]).toBeCloseTo(-fp.y0, 9)
    expect(rested[1]).toBeGreaterThan(0)
  })

  it('box + pallet spawner: floorY seats the drop cone on the floor (origin = the spawn point)', () => {
    // not conveyor-mounted, same kind of bug: the origin is the spawn point, so the cue cube's lower half and
    // the whole drop cone hang below it, and without floorY cargo (spawn offset −0.2) would leave under the floor.
    for (const id of ['oip.box-spawner', 'oip.pallet-spawner']) {
      registerRig(id)
      const p = part(id, {})
      expect(partFootprint(p).y0).toBeCloseTo(-0.46, 6) // drop-cone base: −0.38 − 0.16/2
      const y = restOnSurface(p, FLOOR.point, FLOOR.normal)[1]
      expect(y).toBeCloseTo(0.46, 9)
      expect(y - 0.2).toBeGreaterThan(0) // the spawn point itself clears the floor
      clearPackages()
    }
  })

  it('chain transfer: floorY seats the chain-lane underside on the floor', () => {
    registerRig('oip.chain-transfer')
    const p = part('oip.chain-transfer', { chains: 5, distance: 0.33, laneLength: 2, speed: 2, raised: false })
    const fp = partFootprint(p)
    // NATIVE_LANE_BOTTOM (-0.3564, the ChainTransfer GLB's underside below its mount) + LANE_Y (-0.0058, the
    // mount that seats the strand crown on the conveying deck, so the chains are drawn where the load they carry
    // actually sits rather than 74 mm under the deck).
    expect(fp.y0).toBeCloseTo(-0.3622, 6)
    const rested = restOnSurface(p, FLOOR.point, FLOOR.normal)
    expect(rested[1]).toBeCloseTo(-fp.y0, 9)
    expect(rested[1]).toBeGreaterThan(0)
  })

  it('a rig without bounds.floorY keeps a bottom-origin footprint (no spurious lift off the floor)', () => {
    // the same blade-stop geometry but with floorY stripped: y0 falls back to 0, so a floor-standing rig whose
    // sloped/thin member merely clips below y=0 (the stairs stringer) stays put on the floor
    const { geometry } = examplePart<RigGeo>('oip.blade-stop')
    const noFloorY = { ...geometry, bounds: { length: geometry.bounds!.length, width: geometry.bounds!.width, top: geometry.bounds!.top } }
    registerPackage({ format: PACKAGE_FORMAT, id: 'oip.blade-stop', name: 'x', params: {}, behavior: 'definePart({ step(){} })', geometry: noFloorY } as unknown as PartPackage)
    const p = part('oip.blade-stop', { width: 1.524, active: false, raiseHeight: 0.06, airPressureHeight: 0.07 })
    expect(partFootprint(p).y0).toBe(0)
    expect(restOnSurface(p, FLOOR.point, FLOOR.normal)[1]).toBe(0)
  })
})
