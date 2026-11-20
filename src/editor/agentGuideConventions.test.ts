// The agent guide's claims, checked against the real first-party packages.
//
// core/agentGuide.test.ts pins the derivation: that the tag table reads the document correctly. This
// checks that what the guide asserts about how parts work is still true of the parts we ship. It lives
// in editor/ rather than core/ because only this layer can load the committed package folders
// (examples/parts/<dir>) and get real geometry to probe.
//
// Each probe builds the part the way that part is actually sized. A probe that sizes a belt with
// `length`, which the belt does not have, gets an empty path and a degenerate centred footprint, and
// seems to refute the guide.

import { describe, expect, it, beforeAll } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { agentGuideMarkdown } from '../core/agentGuide'
import { partFootprint } from '../core/parts/partGeometry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import type { GuideDoc } from '../core/agentGuide'
import type { ParamSpec } from '../core/parts/partApi'
import type { PartPackage } from '../core/parts/partPackage'
import { bundledPackagesFromData } from './parts/bundledPackageData'

let byId: Map<string, PartPackage>

beforeAll(() => {
  clearPackages()
  byId = new Map()
  for (const pkg of bundledPackagesFromData()) {
    registerPackage(pkg)
    byId.set(pkg.id, pkg)
  }
})

/** The guide as it renders for a scene embedding the given packages. */
function guideFor(ids: readonly string[]): string {
  const packages = ids.map((id) => byId.get(id)!)
  const doc: GuideDoc = {
    name: 'Probe',
    scene: { id: 'scene', name: 'Probe', scenePath: 'scene.json', scene: { version: 4, parts: [], packages } },
  }
  return agentGuideMarkdown(doc)
}

const handleOf = (pkgId: string, param: string): ParamSpec['handle'] =>
  (byId.get(pkgId)?.params[param] as ParamSpec | undefined)?.handle

describe('the sizing claim', () => {
  // The claim that motivated the whole check: sizing is per-package, and the belt is the counterexample
  // an agent will otherwise get wrong, because `length` is the name everything else uses.
  it('a belt conveyor really has no `length` param, and is shaped by `segments`', () => {
    const belt = byId.get('oip.belt-conveyor')
    expect(belt, 'the first-party belt conveyor must exist').toBeDefined()
    expect(belt!.params.length, 'a belt with a `length` param would make the guide wrong').toBeUndefined()
    expect(handleOf('oip.belt-conveyor', 'segments')?.kind).toBe('path')
  })

  it('a roller conveyor really is sized by `length` on its x face', () => {
    const handle = handleOf('oip.roller-conveyor', 'length')
    expect(handle?.kind).toBe('face')
    expect(handle?.kind === 'face' && handle.axis).toBe('x')
  })

  it('the guide reports each of those from the package, not from prose', () => {
    const md = guideFor(['oip.belt-conveyor', 'oip.roller-conveyor'])
    // the belt row names segments and its row layout; the roller row names length
    expect(md).toMatch(/`oip\.belt-conveyor`.*`segments` \(rows of \[run, tilt\]\)/)
    expect(md).toMatch(/`oip\.roller-conveyor`.*`length` \(length\)/)
  })

  it('states that an undeclared parameter does nothing in the app, and names the check that reports it', () => {
    // the actual failure mode: setting `length` on a belt is not an error, it does nothing
    const md = guideFor(['oip.belt-conveyor'])
    expect(md).toContain('is dropped on load with no error in the app')
    expect(md).toContain('npm run validate-project')
  })

  it('and that check really does report it: a belt given a `length` loads without one, and says so', () => {
    const belt = byId.get('oip.belt-conveyor')!
    const loaded = validateScene({
      version: SCENE_VERSION,
      packages: [belt],
      parts: [{ id: 'b', type: 'part', packageId: belt.id, position: [0, 0, 0], rotationY: 0, params: { length: 4 } }],
    })
    expect(loaded.ok && loaded.repairs).toEqual(['parts[0].params.length is not a parameter of oip.belt-conveyor, so it is dropped'])
  })
})

describe('the origin-convention claim', () => {
  // partFootprint reports local extents as { hx, cx? }: the part spans cx±hx about its origin, and an
  // absent cx means 0. So cx≈0 IS "centre-origin" and cx≈half-the-run IS "tail-origin" - the guide's
  // claim reduces to arithmetic on this, with no prose in the middle.
  //
  // A belt takes its size from `segments`, so a probe that passes `length` (the name every other
  // conveyor uses) gets an empty path and a degenerate footprint that looks centred, which reads as
  // the opposite convention.
  const belt = (run: number): PartInstance =>
    ({ id: 'b', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { segments: [[run, 0]], width: 1.524 } }) as unknown as PartInstance
  const roller = (length: number): PartInstance =>
    ({ id: 'r', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 0], rotationY: 0, params: { length, width: 1.524 } }) as unknown as PartInstance

  it('a roller conveyor really is centred on its position', () => {
    const fp = partFootprint(roller(4))
    expect(fp.cx ?? 0).toBeCloseTo(0, 6) // spans -2 .. +2
    expect(fp.hx).toBeCloseTo(2, 6)
  })

  it('a belt conveyor really starts at its position and grows +X', () => {
    const fp = partFootprint(belt(4))
    expect(fp.cx ?? 0).toBeCloseTo(2, 6) // centre half a run downstream => origin at the tail
    expect((fp.cx ?? 0) - fp.hx).toBeLessThan(0.5) // its back edge sits at the origin, not behind it
  })

  it('a belt really overhangs its nominal run by ~0.085 m at each end', () => {
    // the guide says "about 0.085 m at each end" and "a 4 m run occupies roughly 4.17 m"
    for (const run of [4, 6]) {
      const overhangPerEnd = partFootprint(belt(run)).hx - run / 2
      expect(overhangPerEnd).toBeGreaterThan(0.06)
      expect(overhangPerEnd).toBeLessThan(0.11)
    }
  })

  it('the guide states both, in the direction the probe just confirmed', () => {
    const md = guideFor(['oip.belt-conveyor', 'oip.roller-conveyor'])
    expect(md).toMatch(/roller\/straight conveyor is \*\*centre\*\*-origin/)
    expect(md).toMatch(/belt\s+conveyor is \*\*tail\*\*-origin/)
    expect(md).toContain('0.085 m at each end')
  })
})

describe('the honesty claims still hold', () => {
  it('there is still no geometry check anywhere to point at', () => {
    // If a check-layout seam is added, this fails. The guide must then name it, because "nothing checks
    // geometry" would be stale.
    expect(guideFor(['oip.roller-conveyor'])).toContain('seating check')
  })

  it('every first-party package the guide can describe renders without throwing', () => {
    // a package with an unusual handle or an empty schema must not break the file for everyone else
    expect(() => guideFor([...byId.keys()])).not.toThrow()
    const md = guideFor([...byId.keys()])
    expect(md).toContain('Shape handles')
  })
})

describe('the extent column against real packages', () => {
  // The synthetic specs in core/agentGuide.test.ts prove the formatting. This proves the numbers are
  // real: the same partFootprint the editor places with, rendered for packages we actually ship.
  const placed = (packageId: string, params: Record<string, unknown>): unknown =>
    ({ id: 'p', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params })

  function guideWithExtents(entries: { packageId: string; params: Record<string, unknown> }[]): string {
    const parts = entries.map((e, i) => ({ ...(placed(e.packageId, e.params) as object), id: `p${i}` }))
    const doc: GuideDoc = {
      name: 'Probe',
      scene: { id: 'scene', name: 'Line', scenePath: 'scene.json', scene: { version: 4, parts, packages: entries.map((e) => byId.get(e.packageId)!) } },
    }
    return agentGuideMarkdown(doc, { measure: (p) => partFootprint(p as PartInstance) })
  }

  it('renders a roller conveyor as centred on its position, at its real length', () => {
    expect(guideWithExtents([{ packageId: 'oip.roller-conveyor', params: { length: 6, width: 1.524 } }])).toContain('x -3..3')
  })

  it('renders a belt conveyor as starting at its position - the origin split, as a number', () => {
    // the prose says tail-origin; this is the same fact where an agent will actually read it
    expect(guideWithExtents([{ packageId: 'oip.belt-conveyor', params: { segments: [[4, 0]], width: 1.524 } }])).toContain('x -0.085..4.085')
  })

  it('reveals that a despawner is a volume, which is what the trial got wrong', () => {
    const md = guideWithExtents([{ packageId: 'oip.despawner', params: {} }])
    expect(md).toMatch(/x -1\.\.1, y 0\.\.1, z -1\.\.1/)
  })

  it('reports a roller deck top above its position, so peripherals can be seated on it', () => {
    // y1 = +0.05: the surface is not level with `position`, which is why parts placed at the same y float
    expect(guideWithExtents([{ packageId: 'oip.roller-conveyor', params: { length: 4, width: 1.524 } }])).toContain('y -0.4..0.05')
  })
})
