// A part saved without some of its params (a hand-written scene, an older save, a script) is drawn at their
// defaults: geometry() gets its params through resolvePartParams. The host's own reads of its size must take the same
// values, or the footprint, snap ends and guard runs describe a different part from the one on screen. Before this
// rule a missing size fell back to the package's bounds: a spur came out 2.88 m long instead of its 2 m default, and
// a belt without its segments was not a conveyor at all.

import { beforeAll, describe, expect, it } from 'vitest'
import { bedOf, conveyorEndsOf, partFootprint } from '../core/parts/partGeometry'
import { clearPackages, listPackages } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { registerBundledPackages } from './parts/bundledExamples'

beforeAll(() => {
  clearPackages()
  registerBundledPackages()
})

/** numbers rounded off their last few bits, so a size computed two ways compares equal */
const rounded = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'number' ? Math.round(x * 1e9) / 1e9 : x)))

/** what the host reads of a part's size and shape */
function hostRead(part: PartInstance): unknown {
  const bed = bedOf(part)
  return rounded({
    footprint: partFootprint(part),
    ends: conveyorEndsOf(part).map((e) => [e.end, e.x, e.y, e.z, e.outX, e.outZ, e.faceWidth]),
    bed: bed && { kind: bed.kind, guards: bed.guardHost(part), flanks: bed.flanks() },
  })
}

describe('a part saved without its params', () => {
  it('reads at its defaults: the footprint, ends and guard runs of the part on screen', () => {
    const differ = listPackages().flatMap((pkg) => {
      const full = createSdkPart(pkg, 'full', [0, 0, 0]) as PartInstance
      const bare = { ...full, id: 'bare', params: {} } as PartInstance
      return JSON.stringify(hostRead(bare)) === JSON.stringify(hostRead(full)) ? [] : [pkg.id]
    })
    expect(differ).toEqual([])
  })
})
