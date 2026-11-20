import { describe, expect, it } from 'vitest'
import { Group, Mesh, MeshStandardMaterial } from 'three'
import type { RigLink } from '../../../core/parts/partPackage'
import type { GuardHoles } from '../../../core/guards/guardHoles'
import { unitBox } from '../common'
import { holePanelGeometryCount, layoutGuardSplit, releaseGuardSplit } from './rigLayout'
import type { GuardSplitLink } from './rigLayout'

// A guard's hole panels share one plate geometry per hole height. Moving a hole mints a new plate, so a plate no panel
// holds any more must leave the cache, or a sensor drag along a guard keeps one geometry per frame for the session.

function guard(): GuardSplitLink {
  const mat = new MeshStandardMaterial()
  const link = { name: 'guard', offset: [0, 0.2, 0.5], shape: { kind: 'box', size: [2, 0.2, 0.01] } } as unknown as RigLink
  return { group: new Group(), size: [2, 0.2, 0.01], sizeParams: [], mat, side: 'left', frame: false, offsetY: 0.2, link, children: [new Mesh(unitBox, mat)], panels: [], wedges: [] }
}
const holeAt = (y: number): GuardHoles => ({ left: [[0, y]], right: [] })
const lay = (gs: GuardSplitLink, holes: GuardHoles | undefined): boolean => layoutGuardSplit(gs, {}, new Map(), undefined, undefined, holes)

describe('guard hole-panel plates', () => {
  it('keeps one plate per hole height in use and evicts the rest', () => {
    const base = holePanelGeometryCount()
    const a = guard(), b = guard()
    lay(a, holeAt(0.2))
    lay(b, holeAt(0.2))
    expect(a.panels[0]!.geometry).toBe(b.panels[0]!.geometry) // shared
    expect(holePanelGeometryCount()).toBe(base + 1)
    // a drag along heights: each step drops the previous plate
    for (const y of [0.21, 0.22, 0.23]) lay(a, holeAt(y))
    expect(holePanelGeometryCount()).toBe(base + 2) // b's plate and a's current one
    lay(a, holeAt(0.23)) // an unchanged layout takes no new reference
    lay(a, undefined) // the hole goes: the panel and its plate go
    expect(a.panels.length).toBe(0)
    expect(holePanelGeometryCount()).toBe(base + 1)
    releaseGuardSplit(b)
    releaseGuardSplit(b) // a second dispose is a no-op
    expect(holePanelGeometryCount()).toBe(base)
  })
})
