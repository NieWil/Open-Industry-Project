// core/parts/partCatalog.ts against the real first-party packages (only this layer can load the committed part folders),
// plus the scene conventions docs/technical-overview.md states, so the doc cannot drift from the code.

import { beforeAll, describe, expect, it } from 'vitest'
import { catalogEntry, formatEntry, formatValue, groupParams, originAlong, type CatalogEntry } from '../core/parts/partCatalog'
import { toWorldXZ } from '../core/parts/partGeometry'
import type { PartPackage } from '../core/parts/partPackage'
import { clearPackages, listPackages } from '../core/parts/partRegistry'
import { qApply, qFromAxisAngle } from '../core/rig/rigPose'
import { createSdkPart } from '../core/scene/scene'
import { registerBundledPackages } from './parts/bundledExamples'

let packages: PartPackage[]
const entries = new Map<string, CatalogEntry>()

beforeAll(() => {
  clearPackages()
  // every first-party part, as the app builds and registers them at boot
  registerBundledPackages()
  packages = listPackages().filter((p) => p.id.startsWith('oip.'))
  for (const pkg of packages) entries.set(pkg.id, catalogEntry(pkg))
})

const entry = (id: string): CatalogEntry => entries.get(id)!

describe('catalogEntry on every first-party part', () => {
  it('lists every part, signals or not, with every declared param and its metadata', () => {
    expect(packages.length).toBeGreaterThan(30)
    for (const pkg of packages) {
      const e = entry(pkg.id)
      expect(e.frameError, pkg.id).toBeUndefined()
      expect(e.params.map((p) => p.key)).toEqual(Object.keys(pkg.params))
      for (const p of e.params) {
        const spec = pkg.params[p.key]!
        expect(p.default, `${pkg.id}.${p.key}`).toEqual(spec.default)
        expect(p.desc).toBe(spec.desc)
        expect(p.group).toBe(spec.group)
      }
      expect(e.frame.footprint, pkg.id).toBeDefined()
    }
    // parts with no PLC surface are in the catalog too
    expect(entry('oip.box').signals).toEqual([])
    expect(entry('oip.box').params.map((p) => p.key)).toContain('length')
  })

  it('carries a param desc, which is where a rule like "the run tag needs a program driving it" lives', () => {
    const spawner = entry('oip.box-spawner')
    expect(spawner.params.find((p) => p.key === 'conveyorId')?.type).toBe('partRef')
    expect(spawner.signals.find((s) => s.name === 'runTag')?.desc).toMatch(/DRIVES/)
  })

  it('places a belt at its tail and a roller conveyor at its centre, flowing back -> front along +X', () => {
    const belt = entry('oip.belt-conveyor')
    expect(belt.frame.origin?.x).toBe('-X end')
    const beltFront = belt.frame.ends!.find((e) => e.end === 'front')!
    expect(beltFront.out).toEqual([1, 0])
    expect(beltFront.at[0]).toBeGreaterThan(3.9)
    const roller = entry('oip.roller-conveyor')
    expect(roller.frame.origin).toEqual({ x: 'centre', z: 'centre' })
    expect(roller.frame.ends!.find((e) => e.end === 'back')!.at[0]).toBeCloseTo(-2, 3)
    expect(roller.snap).toContain('conveyor')
  })

  it('reports zones and beams where the sim puts them', () => {
    const zone = entry('oip.despawner').frame.zones!.find((z) => z.name === 'mouth')!
    // the despawner's zone sits ON its position (bottom face at y = 0), sized by length / height / width
    expect(zone.centre).toEqual([0, 0.5, 0])
    expect(zone.size).toEqual([2, 1, 2])
    const beam = entry('oip.diffuse-sensor').frame.beams![0]!
    expect(beam.dir).toEqual([0, 0, 1])
    expect(beam.range).toBeGreaterThan(0)
  })

  it('formats a summary and a full entry', () => {
    const brief = formatEntry(entry('oip.box-spawner'), false).join('\n')
    expect(brief).toMatch(/^oip\.box-spawner {2}Spawner/)
    expect(brief).toContain('runTag')
    expect(brief).not.toMatch(/DRIVES/) // descs only in full
    const full = formatEntry(entry('oip.box-spawner'), true).join('\n')
    expect(full).toMatch(/DRIVES/)
  })
})

describe('frame facts at given params (npm run catalog -- <id> --params k=v)', () => {
  const pkg = (id: string): PartPackage => packages.find((p) => p.id === id)!

  it('moves a spur conveyor\'s ends with its length (the case an agent had to derive by hand)', () => {
    const atDefault = catalogEntry(pkg('oip.spur-conveyor'))
    const longer = catalogEntry(pkg('oip.spur-conveyor'), { length: 4 })
    expect(longer.frameError).toBeUndefined()
    expect(longer.frameParams).toEqual({ length: 4 })
    expect(atDefault.frameParams).toBeUndefined()
    const end = (e: CatalogEntry, which: 'front' | 'back') => e.frame.ends!.find((x) => x.end === which)!
    expect(end(longer, 'back').at[0]).toBeCloseTo(-2, 3)
    expect(end(longer, 'front').at[0]).toBeCloseTo(2, 3)
    expect(end(longer, 'front').at[0]).toBeGreaterThan(end(atDefault, 'front').at[0])
    expect(longer.frame.footprint!.x[1] - longer.frame.footprint!.x[0]).toBeGreaterThan(atDefault.frame.footprint!.x[1] - atDefault.frame.footprint!.x[0])
    expect(formatEntry(longer, true).join('\n')).toContain('footprint (m, part-local, at length=4)')
  })

  it('takes a belt\'s length as an extent, through its resize path', () => {
    const belt = catalogEntry(pkg('oip.belt-conveyor'), { length: 6 })
    expect(belt.frame.ends!.find((e) => e.end === 'front')!.at[0]).toBeCloseTo(6.085, 3)
    expect(belt.frame.origin?.x).toBe('-X end') // the tail stays put
  })

  it('resizes a zone and states its extent as min..max on each axis', () => {
    const z = catalogEntry(pkg('oip.despawner'), { length: 0.6, height: 0.5 }).frame.zones!.find((x) => x.name === 'mouth')!
    expect(z.min).toEqual([-0.3, 0, -1])
    expect(z.max).toEqual([0.3, 0.5, 1])
    const text = formatEntry(catalogEntry(pkg('oip.despawner')), true).join('\n')
    expect(text).toContain('zone  mouth: x -1..1  y 0..1  z -1..1')
    expect(text).toMatch(/box CENTRE is inside it, on a belt or not/)
  })

  it('reports a param the part does not have as a frame error, not silently', () => {
    expect(catalogEntry(pkg('oip.despawner'), { bogus: 1 }).frameError).toMatch(/no param "bogus"/)
  })
})

describe('catalog helpers', () => {
  it('originAlong names where 0 falls in a span', () => {
    expect(originAlong(-2, 2, 'X')).toBe('centre')
    expect(originAlong(-0.085, 4.085, 'X')).toBe('-X end')
    expect(originAlong(-4, 0, 'Z')).toBe('+Z end')
    expect(originAlong(-1, 3, 'X')).toBe('25% along X')
    expect(originAlong(1, 3, 'X')).toMatch(/outside/)
  })

  it('formatValue keeps one line one line', () => {
    expect(formatValue('a')).toBe('"a"')
    expect(formatValue(3)).toBe('3')
    expect(formatValue([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]], 20)).toHaveLength(20)
  })

  it('groupParams keeps declaration order, ungrouped first', () => {
    const g = groupParams([
      { key: 'a', type: 'number', default: 1, group: 'G' },
      { key: 'b', type: 'number', default: 1 },
      { key: 'c', type: 'number', default: 1, group: 'G' },
    ])
    expect(g.map(([name, ps]) => [name, ps.map((p) => p.key)])).toEqual([
      ['', ['b']],
      ['G', ['a', 'c']],
    ])
  })
})

describe('scene conventions (docs/technical-overview.md "Scene conventions")', () => {
  it('rotationY is radians about +Y: a quarter turn carries local +X to world -Z (counter-clockwise seen from above)', () => {
    const q = qFromAxisAngle([0, 1, 0], Math.PI / 2)
    const v = qApply(q, [1, 0, 0])
    expect(v[0]).toBeCloseTo(0, 9)
    expect(v[2]).toBeCloseTo(-1, 9)
    // the planar helper snapping and footprints use agrees
    const part = createSdkPart(packages.find((p) => p.id === 'oip.roller-conveyor')!, 'p', [10, 0, 5], Math.PI / 2)
    const w = toWorldXZ(part, 1, 0)
    expect(w.x).toBeCloseTo(10, 9)
    expect(w.z).toBeCloseTo(4, 9)
  })
})
