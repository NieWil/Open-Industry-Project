import { beforeEach, describe, expect, it } from 'vitest'
import { partParamSpecs, schemaToParamSpecs } from './packageParams'
import { clearPackages, getPackage, hasPackage, listPackages, onPackagesChanged, registerPackage, unregisterPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import { createSdkPart, createPart, normalizePart, serializeScene, validateScene } from './scene/scene'
import { SCENE_VERSION } from './types'
import type { SdkPart } from './types'
import { PACKAGE_FORMAT } from './parts/partPackage'

function pkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.deck',
    name: 'Acme Deck', conveyor: { surface: 'roller', speedParam: 'speed', reverseParam: 'reverse' },
    params: {
      speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Belt speed' },
      reverse: { type: 'boolean', default: false },
      tag: { type: 'string', default: 'X1' },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
    ...over,
  }
}

beforeEach(() => clearPackages())

describe('package param schema → editor specs', () => {
  it('maps number/boolean/string with bound fallbacks', () => {
    const specs = schemaToParamSpecs({
      a: { type: 'number', default: 1, min: 0, max: 10, step: 0.5, label: 'A' },
      b: { type: 'number', default: 2 }, // no bounds → wide fallback
      c: { type: 'boolean', default: true },
      d: { type: 'string', default: 'hi' },
    })
    expect(specs.map((s) => [s.key, s.kind])).toEqual([
      ['a', 'number'],
      ['b', 'number'],
      ['c', 'boolean'],
      ['d', 'text'],
    ])
    expect(specs[0]).toMatchObject({ kind: 'number', min: 0, max: 10, step: 0.5, label: 'A' })
    const b = specs[1]
    expect(b?.kind).toBe('number')
    if (b?.kind === 'number') expect(b.min < -1000 && b.max > 1000).toBe(true) // unbounded → wide
  })

  it("maps a 'tag' param to a tagRef spec (the PLC-tag picker), distinct from plain text", () => {
    const specs = schemaToParamSpecs({
      runTag: { type: 'tag', default: '', label: 'Run tag' },
      note: { type: 'string', default: 'hi' },
    })
    expect(specs.map((s) => [s.key, s.kind])).toEqual([
      ['runTag', 'tagRef'],
      ['note', 'text'],
    ])
    expect(specs[0]).toMatchObject({ kind: 'tagRef', key: 'runTag', label: 'Run tag', default: '' })
  })

  it("carries a setpoint tag's `setpointFor` target through to the spec (the Inspector's live-value link)", () => {
    const specs = schemaToParamSpecs({
      speed: { type: 'number', default: 1, label: 'Speed' },
      speedTag: { type: 'tag', setpointFor: 'speed', default: '', label: 'Speed tag' },
      runTag: { type: 'tag', default: '', label: 'Run tag' },
    })
    // the setpoint tag names the param it replaces; a plain command tag carries nothing
    expect(specs[1]).toMatchObject({ kind: 'tagRef', key: 'speedTag', setpointFor: 'speed' })
    expect(specs[2]).not.toHaveProperty('setpointFor')
  })
})

describe("'tag' param round-trip (SDK type → editor kind → runtime value)", () => {
  it('bakes the default and normalizes a tagRef value as a string, like the tag name it holds', () => {
    const tagPkg = pkg({
      id: 'acme.tagged',
      params: { wire: { type: 'tag', default: 'Belt1.run', label: 'Run tag' } },
    })
    registerPackage(tagPkg) // normalizePart resolves custom specs from the registry
    const part = createSdkPart(tagPkg, 'cp_1', [0, 0, 0])
    expect(part.params).toEqual({ wire: 'Belt1.run' }) // default baked from the schema

    // normalizePart keeps a string verbatim and falls back to the default for a non-string (mirrors text/partRef)
    const edited = normalizePart({ ...part, params: { wire: 'Belt2.run' } })
    expect((edited.params as Record<string, unknown>).wire).toBe('Belt2.run')
    const reset = normalizePart({ ...part, params: { wire: 123 as unknown as string } })
    expect((reset.params as Record<string, unknown>).wire).toBe('Belt1.run')
  })
})

describe("'numberList' param (typed waypoint/pose table → number[][], no JSON string)", () => {
  it('maps to a numberList editor spec carrying arity + clamp bounds, truncating the default to arity', () => {
    const specs = schemaToParamSpecs({
      waypoints: { type: 'numberList', arity: 3, default: [[1, 2, 3, 99]], min: -10, max: 10, label: 'WP' },
    })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ kind: 'numberList', key: 'waypoints', arity: 3, min: -10, max: 10 })
    // extra cell beyond arity is dropped when the schema default is lifted into the spec
    if (specs[0]?.kind === 'numberList') expect(specs[0].default).toEqual([[1, 2, 3]])
  })

  it('bakes a deep-copied default and coerces rows to arity (pad/truncate/clamp), replacing a bad value', () => {
    const wpPkg = pkg({
      id: 'acme.path',
      params: { path: { type: 'numberList', arity: 2, default: [[0, 0], [1, 1]], min: 0, max: 5 } },
    })
    registerPackage(wpPkg) // normalizePart resolves custom specs from the registry
    const part = createSdkPart(wpPkg, 'cp_1', [0, 0, 0])
    expect(part.params).toEqual({ path: [[0, 0], [1, 1]] })
    // the instance default must be a deep copy, not aliasing the spec's array
    ;(part.params.path as number[][])[0]![0] = 9
    expect((wpPkg.params.path!.default as number[][])[0]![0]).toBe(0)

    // each row coerced to exactly arity=2: extra cell dropped, missing padded 0, out-of-range clamped (9→5), non-number→0
    const cleaned = normalizePart({ ...part, params: { path: [[3, 4, 5], [9], ['x', 2]] as unknown as number[][] } })
    expect((cleaned.params as Record<string, unknown>).path).toEqual([[3, 4], [5, 0], [0, 2]])

    // a legacy JSON string is not an array → falls back to a deep copy of the default
    const legacy = normalizePart({ ...part, params: { path: '[[2,3]]' as unknown as number[][] } })
    expect((legacy.params as Record<string, unknown>).path).toEqual([[0, 0], [1, 1]])
  })
})

describe('partRegistry', () => {
  it('registers, looks up, lists and removes packages', () => {
    expect(hasPackage('acme.deck')).toBe(false)
    registerPackage(pkg())
    expect(hasPackage('acme.deck')).toBe(true)
    expect(getPackage('acme.deck')?.name).toBe('Acme Deck')
    expect(listPackages()).toHaveLength(1)
    expect(unregisterPackage('acme.deck')).toBe(true)
    expect(hasPackage('acme.deck')).toBe(false)
  })

  it('notifies subscribers on register and unregister', () => {
    const events: Array<[string, boolean]> = []
    const off = onPackagesChanged((id, p) => events.push([id, p !== undefined]))
    registerPackage(pkg())
    unregisterPackage('acme.deck')
    off()
    registerPackage(pkg({ id: 'acme.other' })) // after unsubscribe → not recorded
    expect(events).toEqual([
      ['acme.deck', true],
      ['acme.deck', false],
    ])
  })
})

// `hidden` is the SDK's stored-but-unshown param (the curve's snap-owned `reverse`). It is stored like any other
// param, so it must go through the normal bridge and only be dropped at the Inspector. Filtering it out any
// earlier loses its default and its clamp, and the value would vanish on the next load.
describe('hidden params (ParamSchema.hidden - stored, never an Inspector field)', () => {
  const hiddenPkg = (): PartPackage =>
    pkg({ conveyor: { surface: 'roller', speedParam: 'speed' }, params: { speed: { type: 'number', default: 2 }, flipped: { type: 'boolean', default: false, hidden: true } } })

  it('carries the flag through the schema→spec bridge instead of dropping the param', () => {
    const specs = schemaToParamSpecs(hiddenPkg().params)
    expect(specs.map((s) => [s.key, s.hidden ?? false])).toEqual([
      ['speed', false],
      ['flipped', true],
    ])
  })

  it('still gets a baked default from the package schema', () => {
    expect(createSdkPart(hiddenPkg(), 'cp_h', [0, 0, 0]).params).toEqual({ speed: 2, flipped: false })
  })

  it('survives a scene round-trip with its value, so snap-set state is kept', () => {
    const res = validateScene({
      version: 3,
      packages: [hiddenPkg()],
      parts: [{ id: 'cp_h', type: 'part', packageId: 'acme.deck', position: [0, 1, 0], rotationY: 0, params: { speed: 2, flipped: true } }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.scene.parts[0] as SdkPart).params.flipped).toBe(true)
  })
})

describe('partParamSpecs (runtime spec resolution - Inspector/render)', () => {
  it('resolves a custom part from the registered package', () => {
    registerPackage(pkg())
    const specs = partParamSpecs({ id: 'cp_1', type: 'part', packageId: 'acme.deck', position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart)
    expect(specs.map((s) => s.key)).toEqual(['speed', 'reverse', 'tag'])
  })

  it('returns [] for a custom part whose package is unregistered (no fields, no throw)', () => {
    const specs = partParamSpecs({ id: 'cp_1', type: 'part', packageId: 'ghost', position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart)
    expect(specs).toEqual([])
  })

  it('falls through to PART_DEFS for a built-in part', () => {
    const specs = partParamSpecs(createPart('building', 'bld_1', [0, 0, 0]))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.some((s) => s.key === 'lengthSections')).toBe(true)
  })
})

describe('createSdkPart', () => {
  it('bakes default params from the package schema', () => {
    const part = createSdkPart(pkg(), 'cp_1', [1, 2, 3])
    expect(part).toMatchObject({ id: 'cp_1', type: 'part', packageId: 'acme.deck' })
    expect(part.params).toEqual({ speed: 0.6, reverse: false, tag: 'X1' })
  })
})

describe('validateScene with embedded custom-part packages', () => {
  const sceneRaw = (parts: unknown[], packages: unknown[] = [pkg()]) => ({ version: 3, packages, parts })

  it('round-trips a custom part, clamping params to the package schema', () => {
    const res = validateScene(
      sceneRaw([{ id: 'cp_1', type: 'part', packageId: 'acme.deck', position: [0, 1, 0], rotationY: 0, params: { speed: 99, reverse: 'nope', tag: 7 } }]),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const part = res.scene.parts[0] as SdkPart
    expect(part.packageId).toBe('acme.deck')
    expect(part.params.speed).toBe(4) // clamped to max
    expect(part.params.reverse).toBe(false) // wrong type → default
    expect(part.params.tag).toBe('X1') // wrong type → default
    expect(res.scene.packages).toHaveLength(1)
  })

  it('fills missing custom params with their package defaults', () => {
    const res = validateScene(sceneRaw([{ id: 'cp_1', type: 'part', packageId: 'acme.deck', position: [0, 1, 0], rotationY: 0, params: {} }]))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.scene.parts[0] as SdkPart).params).toEqual({ speed: 0.6, reverse: false, tag: 'X1' })
  })

  it('rejects a custom part whose package is not embedded', () => {
    const res = validateScene(sceneRaw([{ id: 'cp_1', type: 'part', packageId: 'ghost', position: [0, 0, 0], rotationY: 0, params: {} }]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join(' ')).toMatch(/packageId/)
  })

  it('reports an invalid embedded package', () => {
    const bad = { format: PACKAGE_FORMAT, id: '', name: 'x', behavior: '', params: {}, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [0, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 0, width: 1, top: 0.05, bottom: -0.1 } } }
    const res = validateScene(sceneRaw([], [bad]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join(' ')).toMatch(/packages\[0\]/)
  })

  it('rejects duplicate package ids', () => {
    const res = validateScene(sceneRaw([], [pkg(), pkg()]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join(' ')).toMatch(/duplicate/)
  })

  it('omits the packages field for a scene with none', () => {
    const res = validateScene({ version: 3, parts: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.scene.packages).toBeUndefined()
  })
})

describe('serializeScene round-trips custom parts + embedded packages', () => {
  // serializeScene must keep the part's packageId and scene.packages: without them a persisted
  // custom-part scene (e.g. the SixAxis robot) fails validateScene on reload and silently falls back
  // to the default building, a grey, empty viewport.
  it('re-validates a serialized custom-part scene (no fallback)', () => {
    const built = validateScene({
      version: SCENE_VERSION,
      packages: [pkg()],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.deck', name: 'Loader', position: [1, 2, 3], rotationY: 0.5, params: { speed: 2, reverse: true, tag: 'Y9' } }],
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const json = serializeScene(built.scene)
    const parsed = JSON.parse(json) as { packages?: { id: string }[]; parts: { type: string; packageId?: string; params: Record<string, unknown> }[] }
    expect(parsed.packages?.map((p) => p.id)).toEqual(['acme.deck'])
    expect(parsed.parts[0]!.packageId).toBe('acme.deck')
    expect(parsed.parts[0]!.params).toEqual({ speed: 2, reverse: true, tag: 'Y9' }) // package-driven params survive

    const reloaded = validateScene(parsed)
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    expect(reloaded.scene.parts).toHaveLength(1)
    const part = reloaded.scene.parts[0] as SdkPart
    expect(part.packageId).toBe('acme.deck')
    expect(part.params).toEqual({ speed: 2, reverse: true, tag: 'Y9' })
  })
})

describe('normalizePart for custom parts (collab path, registry-driven)', () => {
  it('clamps params against the registered package', () => {
    registerPackage(pkg())
    const out = normalizePart({ id: 'cp_1', type: 'part', packageId: 'acme.deck', position: [0, 1, 0], rotationY: 0, params: { speed: 99 } } as SdkPart)
    expect(out.type).toBe('part')
    expect((out as SdkPart).packageId).toBe('acme.deck')
    expect((out as SdkPart).params.speed).toBe(4)
  })

  it('drops params when the package is not registered (no crash)', () => {
    const out = normalizePart({ id: 'cp_1', type: 'part', packageId: 'unregistered', position: [0, 1, 0], rotationY: 0, params: { speed: 99 } } as SdkPart)
    expect((out as SdkPart).packageId).toBe('unregistered')
    expect((out as SdkPart).params).toEqual({})
  })
})
