import type { PackageManifest } from '../core/parts/partPackage'
import { describe, expect, it } from 'vitest'
import type { PartInstance, SdkPart } from '../core/types'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { registerPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { computeSceneOpenings, deriveGuardOpenings } from '../core/guards/guardOpenings'
import { computeSceneExtents, deriveGuardExtents } from '../core/guards/guardExtents'
import { isConveyorLike } from '../core/parts/partGeometry'

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}
const ROLLER_PKG = loadPkg('roller-conveyor')
const BELT_PKG = loadPkg('belt-conveyor')
const SPUR_PKG = loadPkg('spur-conveyor')

function roller(id: string, x: number, z: number, length: number, rotationY = 0): SdkPart {
  const p = createSdkPart(ROLLER_PKG, id, [x, 0.75, z], rotationY)
  Object.assign(p.params, { length, width: 0.6, speed: 1, leftGuard: true, rightGuard: true })
  return p
}
function belt(id: string, x: number, z: number, length: number, rotationY = 0): SdkPart {
  const p = createSdkPart(BELT_PKG, id, [x, 0.75, z], rotationY)
  Object.assign(p.params, { segments: [[length, 0]], width: 0.6, height: 0.5, speed: 1, leftGuard: true, rightGuard: true, legs: false })
  return p
}
function spur(id: string, x: number, z: number, rotationY: number): SdkPart {
  return createSdkPart(SPUR_PKG, id, [x, 0.75, z], rotationY)
}

/**
 * A scene mixing every interaction the grid must not lose: a long butted host line, spurs and belts meeting
 * its sides at both ±Z, perpendicular T-merges, parts sharing a cell, parts straddling cell boundaries
 * (GRID_CELL is 4 m, so the 4/8/12 m positions sit exactly on seams), and far-away parts that must be culled.
 */
function mixedScene(): PartInstance[] {
  const out: PartInstance[] = []
  for (let i = 0; i < 8; i++) out.push(roller(`host${i}`, i * 3, 0, 3)) // butted line through the cell seams
  out.push(spur('spurA', 4, 1.2, Math.PI / 2))
  out.push(spur('spurB', 8, -1.2, -Math.PI / 2))
  out.push(spur('spurC', 12.01, 1.2, Math.PI / 2)) // just off a 4 m cell boundary
  out.push(belt('beltA', 6, 1.3, 2, Math.PI / 2))
  out.push(belt('beltB', 15, 0, 3)) // in line with the host run
  out.push(roller('perp', 9, -1.3, 2, Math.PI / 2))
  out.push(roller('far', 500, 500, 3)) // must be culled, must not appear
  out.push(belt('far2', -400, 300, 3))
  return out
}

describe('footprint grid is a pure speed optimization (grid == naive scan)', () => {
  // The grid is only sound if it can never drop a real contact. These compare each resolver's gridded output
  // against the exhaustive scan it replaced, on a scene built to stress cell boundaries and mixed families.
  const parts = mixedScene()
  const conveyors = parts.filter((p) => isConveyorLike(p))

  it('computeSceneOpenings matches an exhaustive host x opener scan', () => {
    const gridded = computeSceneOpenings(parts)
    for (const host of parts) {
      const naive = deriveGuardOpenings(host, parts)
      const hasNaive = naive.left.length > 0 || naive.right.length > 0
      if (!hasNaive) {
        expect(gridded.get(host.id)).toBeUndefined()
        continue
      }
      expect(gridded.get(host.id)).toEqual(naive)
    }
  })

  it('computeSceneExtents matches an exhaustive mover x host scan', () => {
    const gridded = computeSceneExtents(parts)
    for (const mover of conveyors) {
      const naive = deriveGuardExtents(mover, conveyors)
      const hasNaive = Object.keys(naive).length > 0
      if (!hasNaive) {
        expect(gridded.get(mover.id)).toBeUndefined()
        continue
      }
      expect(gridded.get(mover.id)).toEqual(naive)
    }
  })

  it('the scene actually exercises both resolvers (guards the guard)', () => {
    // a vacuous pass would be worthless - assert the fixture really produces openings and extents
    expect(computeSceneOpenings(parts).size).toBeGreaterThan(0)
    expect(computeSceneExtents(parts).size).toBeGreaterThan(0)
  })
})
