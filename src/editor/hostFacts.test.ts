// The host-fed params of drawn parts (core/parts/hostFacts.ts) against the real first-party parts: every shipped part
// takes the facts its own declarations say it needs, a part that leaves one out is told which and why, and the
// guard gaps the spurs now take reach both the mesh params and the sim's colliders.

import { beforeAll, describe, expect, it } from 'vitest'
import { hostFactWarnings } from '../core/parts/hostFacts'
import { clearPackages, getPackage, listPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { findSnap } from '../core/snap/snapFeatures'
import { computeSceneOpenings, withGuardGaps } from '../core/guards/guardOpenings'
import { functionStaticWalls } from '../core/guards/functionGuards'
import { resolvePartParams } from '../core/parts/partScript'
import type { PartInstance } from '../core/types'
import { registerBundledPackages } from './parts/bundledExamples'

beforeAll(() => {
  clearPackages()
  registerBundledPackages()
})

const warningsOf = (pkg: PartPackage): string[] => {
  registerPackage(pkg)
  return hostFactWarnings(pkg, createSdkPart(pkg, 'probe', [0, 0, 0]) as PartInstance)
}
/** a shipped package with one param taken away (or replaced), under its own id */
const variant = (id: string, newId: string, edit: (params: PartPackage['params']) => void): PartPackage => {
  const pkg = structuredClone(getPackage(id)!)
  edit(pkg.params)
  return { ...pkg, id: newId }
}

describe('host-fed params', () => {
  it('every shipped part takes the facts it needs, each declared as the host fills it', () => {
    const found = listPackages().flatMap((pkg) => warningsOf(pkg).map((w) => `${pkg.id}: ${w}`))
    expect(found).toEqual([])
  })

  it('names a fact a part leaves out, and what then goes wrong', () => {
    const noGaps = variant('oip.spur-conveyor', 'test.spur-no-gaps', (p) => void delete p.guardGaps)
    const [w, ...rest] = warningsOf(noGaps)
    expect(rest).toEqual([])
    expect(w).toContain('no `guardGaps` param')
    expect(w).toContain('a diverter mounted on its guard will not open it')
    const noHoles = variant('oip.curved-conveyor', 'test.curve-no-holes', (p) => void delete p.guardHoles)
    expect(warningsOf(noHoles)).toEqual([expect.stringContaining('no `guardHoles` param')])
  })

  it('says when a fact is declared in a shape the host does not fill', () => {
    const wrong = variant('oip.spur-conveyor', 'test.spur-wrong-gaps', (p) => {
      p.guardGaps = { type: 'numberList', arity: 2, default: [], hidden: true }
      p.guardHoles = { ...p.guardHoles!, hidden: false }
    })
    const found = warningsOf(wrong)
    expect(found).toContainEqual(expect.stringContaining('`guardGaps` is filled by the host with [x0 m, x1 m, side ±1] rows'))
    expect(found).toContainEqual(expect.stringContaining('`guardHoles` is filled by the host: declare it `hidden: true`'))
  })
})

describe('a diverter on a spur', () => {
  it("opens the spur's guard in the mesh params and in the sim's colliders", () => {
    const pkg = getPackage('oip.spur-conveyor')!
    const spur = createSdkPart(pkg, 'spur', [0, 0.8, 0]) as PartInstance
    // the diverter dropped by the spur's +Z guard, body outward; the snap seats its mount on the guard
    const dv = createSdkPart(getPackage('oip.diverter')!, 'dv', [0, 0.6, 2]) as PartInstance
    const snap = findSnap(dv, { position: dv.position, rotationY: 0 }, [spur])
    expect(snap).not.toBeNull()
    const seated = { ...dv, position: snap!.pose.position, rotationY: snap!.pose.rotationY } as PartInstance
    const openings = computeSceneOpenings([spur, seated]).get('spur')
    expect(openings?.right).toHaveLength(1)
    const [lo, hi] = openings!.right[0]!
    // the mesh: one guardGaps row on the +Z side
    const params = resolvePartParams(pkg.params, spur.params as never)
    expect(withGuardGaps(spur, params, openings).guardGaps).toEqual([[lo, hi, 1]])
    // the sim: that side's guard collider is two walls, ending at the gap
    const right = functionStaticWalls(spur, pkg, undefined, openings).filter((w) => w.sideGuard === 'right')
    expect(right).toHaveLength(2)
    const ends = right.map((w) => [w.localCx - w.hx, w.localCx + w.hx]).sort((a, b) => a[0]! - b[0]!)
    expect(ends[0]![1]).toBeCloseTo(lo, 4)
    expect(ends[1]![0]).toBeCloseTo(hi, 4)
    // with no diverter it is one wall again
    expect(functionStaticWalls(spur, pkg).filter((w) => w.sideGuard === 'right')).toHaveLength(1)
  })
})
