import { beforeAll, describe, expect, it } from 'vitest'
import { hostSurfaceY } from '../core/guards/guardExtents'
import { deriveGuardOpenings } from '../core/guards/guardOpenings'
import { junctionOpeningRows } from '../core/junctionOpeningRows'
import type { PartPackage } from '../core/parts/partPackage'
import { conveyorEndsOf } from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'

// Guard-openings mode must not offer a gap a neighbour already cut as solid guard (a sweep there would author a
// row on top of a cut that exists anyway). junctionOpeningRows gives those gaps in the authored rows' own space:
// tail-relative, so a centre-origin roller shifts by length/2, and the host's own authored rows are left out.

const byId = new Map<string, PartPackage>()
beforeAll(() => {
  clearPackages()
  const behaviors = bundledBehaviors()
  for (const m of bundledManifests()) {
    const p = buildPackage(m, behaviors.get(m.id)!)
    byId.set(p.id, p)
    registerPackage(p)
  }
})

function place(id: string, partId: string, position: [number, number, number], rotationY: number, params: Record<string, unknown> = {}): PartInstance {
  const inst = createSdkPart(byId.get(id)!, partId, position, rotationY)
  Object.assign(inst.params, params)
  return inst as unknown as PartInstance
}

/** a 2 m roller whose end butts the host's right (+Z) side at host-local x (as structureGolden.test.ts places one) */
function buttedRight(host: PartInstance, x: number): PartInstance {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const probe = place('oip.roller-conveyor', 'm1', [0, 0, 0], yaw, { length: 2 })
    const end = conveyorEndsOf(probe).find((e) => Math.abs(e.outX) < 1e-6 && Math.sign(e.outZ) === -1)
    if (!end) continue
    const z = ((host.params as Record<string, unknown>).width as number) / 2
    return place('oip.roller-conveyor', 'm1', [x - end.x, hostSurfaceY(host, x) - end.y, z - end.z], yaw, { length: 2 })
  }
  throw new Error('no end faces the host')
}

describe('junctionOpeningRows', () => {
  it('a roller T into a roller bed: the cut, shifted onto the tail, on that wall only', () => {
    const host = place('oip.roller-conveyor', 'host', [0, 0, 0], 0, { length: 6 })
    const mover = buttedRight(host, 1)
    const derived = deriveGuardOpenings(host, [host, mover]).right
    expect(derived.length).toBe(1) // else the case is vacuous
    const rows = junctionOpeningRows(host, [host, mover])
    expect(rows.left).toEqual([])
    expect(rows.right[0]![0]).toBeCloseTo(derived[0]![0] + 3)
    expect(rows.right[0]![1]).toBeCloseTo(derived[0]![1] + 3)
    expect((rows.right[0]![0] + rows.right[0]![1]) / 2).toBeCloseTo(4, 1) // x = 1 on a 6 m bed is 4 m from the tail
  })

  it("leaves out the host's own authored rows (those are the gizmo's to edit, not gaps to avoid)", () => {
    const host = place('oip.roller-conveyor', 'host', [0, 0, 0], 0, { length: 6, guardOpenings: [[0.5, 1.5, 0]] })
    expect(junctionOpeningRows(host, [host])).toEqual({ left: [], right: [] })
  })
})
