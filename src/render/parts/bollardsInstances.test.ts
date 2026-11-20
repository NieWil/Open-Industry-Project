import { describe, expect, it } from 'vitest'
import { MeshStandardMaterial } from 'three'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
import { realizeInstancedTemplate } from './instancedTemplate'
import { geometryContentKey } from './geometryKey'

const { behavior: BOLLARDS_BEHAVIOR, geometry: BOLLARDS_GEO, head } = examplePart<FuncGeo>('oip.bollards')

// Safety Bollards, an example part authored on the instanced-template path (MeshPart.instances,
// docs/part-authoring-guide.md Tier 2). geometry() builds one unit bollard from constants and returns a MeshPart
// whose `instances` place `count` scaled copies in a row. A base-plate bank and an anchor-bolt bank are built from
// constants the same way. The host draws each bank as one InstancedMesh and pools it across parts by the
// (param-independent) template's geometryContentKey. This test is the authored twin of the legPieces round-trip in
// instancedTemplate.test.ts. It runs the full geometry()→MeshPart path through the real committed source the app
// loads, not a hand-built bank.

const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(BOLLARDS_BEHAVIOR, params as never)
  if (!parts) throw new Error('bollards geometry() returned no parts')
  return parts
}
// the posts' bank (the first emitted); every bank the part emits is instanced
const only = (params: Record<string, unknown>): MeshPart => {
  const parts = realize(params)
  expect(parts).toHaveLength(3) // posts, base plates, anchor bolts
  for (const p of parts) expect(p.instances).toBeTruthy()
  return parts[0]!
}

describe('Safety Bollards (geometry-function tier - MeshPart.instances example part)', () => {
  it('is a valid render-only function-geometry package (no conveying)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: head.id, name: head.name, params: {}, behavior: BOLLARDS_BEHAVIOR, geometry: BOLLARDS_GEO })).toEqual([])
    expect(BOLLARDS_GEO.kind).toBe('drawn')
    expect((BOLLARDS_GEO as { conveys?: boolean }).conveys).toBeUndefined() // a visual guard prop, not a conveyor
    expect(BOLLARDS_BEHAVIOR).toContain('geometry(')
    expect(BOLLARDS_BEHAVIOR).toContain('instances')
  })

  it('emits a single MeshPart drawn as an instanced bank - a real template desc + one instance per post', () => {
    const part = only({})
    expect(part.instances).toBeTruthy()
    expect(part.instances).toHaveLength(5) // default count
    expect(part.desc.positions.length).toBeGreaterThan(0) // the template carries real geometry (a capped cylinder)
    expect(part.colorParam).toBe('color') // painted (safety yellow by default)
    for (const it of part.instances!) {
      expect(it.position).toHaveLength(3)
      expect(it.scale).toHaveLength(3)
    }
  })

  it('places count posts centred + evenly spaced along X, with size in each instance scale (unit template)', () => {
    const insts = only({ count: 5, spacing: 1.2, radius: 0.06, height: 0.9 }).instances!
    const xs = insts.map((i) => i.position[0]) as number[]
    ;[-2.4, -1.2, 0, 1.2, 2.4].forEach((x, i) => expect(xs[i]).toBeCloseTo(x, 6)) // centred on the origin, 1.2 m pitch
    for (const i of insts) {
      expect(i.position[1]).toBe(0) // base on the floor (part-local y=0)
      expect(i.scale).toEqual([0.06, 0.9, 0.06]) // the post radius/height live in the scale, never baked into desc
    }
  })

  it('count drives the instance count without touching the template geometry', () => {
    const five = only({ count: 5 })
    const nine = only({ count: 9 })
    expect(nine.instances).toHaveLength(9)
    expect(nine.desc.positions).toEqual(five.desc.positions) // same unit template regardless of how many posts
  })

  it('the template is param-independent - a thin short row and a fat tall row share the exact same desc', () => {
    // The pooling invariant: size lives only in the per-instance scale, so differently-sized bollard parts
    // realize byte-identical template geometry and therefore merge in the scene-global instance pool.
    const thin = only({ radius: 0.04, height: 0.6 })
    const fat = only({ radius: 0.18, height: 1.4 })
    expect(fat.desc.positions).toEqual(thin.desc.positions)
    expect(fat.desc.indices).toEqual(thin.desc.indices)
    expect(fat.instances![0]!.scale).toEqual([0.18, 1.4, 0.18]) // …but the transforms differ
    expect(thin.instances![0]!.scale).toEqual([0.04, 0.6, 0.04])
  })

  it('pools across parts: two differently-sized rows realize the same geometry content key', () => {
    const a = realizeInstancedTemplate(only({ radius: 0.06, height: 0.9 }).desc, [], new MeshStandardMaterial())
    const b = realizeInstancedTemplate(only({ radius: 0.15, height: 1.3 }).desc, [], new MeshStandardMaterial())
    expect(a.geometry).not.toBe(b.geometry) // each part realizes its own template geometry object
    expect(geometryContentKey(a.geometry)).toBe(geometryContentKey(b.geometry)) // → merge in the instance pool
  })

  it('stands each post on a painted base plate held down by four anchor bolts', () => {
    const [, plates, bolts] = realize({ count: 3, spacing: 1.2, radius: 0.06 })
    expect(plates!.colorParam).toBe('color') // painted with the post
    expect(plates!.instances).toHaveLength(3)
    expect(bolts!.finish).toBe('bolt')
    expect(bolts!.colorParam).toBeUndefined() // bare steel, whatever the paint
    expect(bolts!.instances).toHaveLength(12)
    for (const b of bolts!.instances!) {
      expect(b.scale).toEqual([1, 1, 1]) // a real anchor size, never scaled with the post
      const nearest = Math.min(...[-1.2, 0, 1.2].map((x) => Math.hypot(b.position[0] - x, b.position[2])))
      expect(nearest).toBeGreaterThan(0.06) // clear of the post...
      expect(nearest).toBeLessThan(0.06 * 2.25 * Math.SQRT2) // ...and on its plate
    }
    // size lives in the scale, so the plate and bolt templates pool across differently-sized rows too
    const [, fatPlates, fatBolts] = realize({ radius: 0.18 })
    expect(fatPlates!.desc.positions).toEqual(plates!.desc.positions)
    expect(fatBolts!.desc.positions).toEqual(bolts!.desc.positions)
  })

  it('is deterministic - identical params → identical instances', () => {
    expect(only({ count: 7, spacing: 1.0 }).instances).toEqual(only({ count: 7, spacing: 1.0 }).instances)
  })
})
