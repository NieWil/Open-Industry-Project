import { beforeEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from './partRegistry'
import type { PartPackage } from './partPackage'
import {
  bedView,
  conveyorLocalEnds,
  faceHandleOfPkg,
  partFootprint,
  pathHandleOfPkg,
} from './partGeometry'
import type { PartInstance, SdkPart } from '../types'
import { PACKAGE_FORMAT } from './partPackage'

// The derivation-memo contract (partGeometry.ts memoByParams/memoByPkg). Results are cached on
// params/package identity (the transient drag stream preserves both) and revalidated on
// type/packageId/registryRevision. Cached results are shared, so equal inputs must keep producing
// equal values, and a changed package or fresh params must recompute.

function beltPkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      height: { type: 'number', default: 0.28, min: 0.1, max: 0.6 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3, width: 1, top: 0.28 }, conveys: true },
    ...over,
  } as PartPackage
}

function rollerPkg(id = 'acme.roller'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller' },
    params: {
      length: { type: 'number', default: 3, min: 0.5, max: 12, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 1, min: 0.3, max: 3, handle: { kind: 'face', axis: 'z' } },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3, width: 1, top: 0.1 }, conveys: true },
  } as PartPackage
}

function beltPart(params: Record<string, unknown>): SdkPart {
  return { id: 'cp_1', type: 'part', packageId: 'acme.belt', position: [0, 0, 0], rotationY: 0, params } as unknown as SdkPart
}

beforeEach(() => clearPackages())

describe('partGeometry derivation memos', () => {
  it('returns the same view for a stable part object (cache hit)', () => {
    registerPackage(beltPkg())
    const part = beltPart({ segments: [[3, 0], [2, 15]] })
    expect(bedView(part, 'path')).toBe(bedView(part, 'path'))
    expect(conveyorLocalEnds(part)).toBe(conveyorLocalEnds(part))
    expect(partFootprint(part)).toBe(partFootprint(part))
  })

  it('a transient re-pose ({...p, position}) keeps the cached view - the drag-stream contract', () => {
    registerPackage(beltPkg())
    const part = beltPart({ segments: [[3, 0]] })
    const view = bedView(part, 'path')
    const moved = { ...part, position: [5, 0, 2] } as SdkPart // params identity preserved, like posedScene
    expect(bedView(moved, 'path')).toBe(view)
    expect(conveyorLocalEnds(moved)).toBe(conveyorLocalEnds(part))
  })

  it('fresh params recompute to an equal value (cached == uncached equivalence)', () => {
    registerPackage(beltPkg())
    const a = beltPart({ segments: [[3, 0], [2, 15]] })
    const b = beltPart({ segments: [[3, 0], [2, 15]] }) // structurally equal, new params object
    const va = bedView(a, 'path')!
    const vb = bedView(b, 'path')!
    expect(vb).not.toBe(va)
    expect(vb.segments).toEqual(va.segments)
    expect({ ...vb, writeSegments: null }).toEqual({ ...va, writeSegments: null })
    expect(conveyorLocalEnds(b)).toEqual(conveyorLocalEnds(a))
    expect(partFootprint(b)).toEqual(partFootprint(a))
  })

  it('re-registering the package invalidates cached views under an unchanged part object', () => {
    registerPackage(beltPkg())
    const part = beltPart({ segments: [[3, 0]] }) // no width param → view.width falls back to pkg bounds
    expect(bedView(part, 'path')!.width).toBe(1)
    registerPackage(beltPkg({ geometry: { kind: 'drawn', bounds: { length: 3, width: 2, top: 0.28 }, conveys: true } as PartPackage['geometry'] }))
    expect(bedView(part, 'path')!.width).toBe(2) // registryRevision moved → recompute against the live package
  })

  it('a params object reaching a different type/package revalidates (no cross-part bleed)', () => {
    registerPackage(rollerPkg('acme.roller'))
    registerPackage(rollerPkg('acme.roller2'))
    const params = { length: 4, width: 1 }
    const a = { id: 'cp_a', type: 'part', packageId: 'acme.roller', position: [0, 0, 0], rotationY: 0, params } as unknown as SdkPart
    const b = { ...a, id: 'cp_b', packageId: 'acme.roller2' } as SdkPart
    expect(bedView(a, 'straight')!.length).toBe(4)
    expect(bedView(b, 'straight')!.length).toBe(4) // same params identity, different package → recomputed, not a stale hit
    const box = { id: 'bx_1', type: 'box', position: [0, 0, 0], rotationY: 0, params } as unknown as PartInstance
    expect(bedView(box, 'straight')).toBeNull() // same params identity, different type
  })

  it('package-level lookups cache on the package object and refresh on re-register', () => {
    const pkg = beltPkg()
    registerPackage(pkg)
    expect(pathHandleOfPkg(pkg)).toBe(pathHandleOfPkg(pkg))
    expect(pathHandleOfPkg(undefined)).toBeNull()
    expect(faceHandleOfPkg(undefined)).toEqual({})
    const roller = rollerPkg()
    expect(faceHandleOfPkg(roller)).toBe(faceHandleOfPkg(roller))
    expect(faceHandleOfPkg(roller)).toEqual({ lengthKey: 'length', widthKey: 'width' })
    // registerPackage always installs a new object on content change, so identity keying is exact:
    const edited = beltPkg({ name: 'Edited' })
    registerPackage(edited)
    expect(pathHandleOfPkg(edited)).toEqual(pathHandleOfPkg(pkg)) // equal derivation…
    expect(pathHandleOfPkg(edited)).not.toBe(pathHandleOfPkg(pkg)) // …from a fresh cache entry
  })
})
