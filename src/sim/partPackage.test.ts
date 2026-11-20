import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import { validatePartPackage, validateSnapParamRefs } from '../core/parts/partValidate'
import { upgradeStoredPackage } from '../core/parts/partUpgrade'
import type { PartPackage } from '../core/parts/partPackage'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'
import { CARGO_KIND_PALLET } from '../core/frame'

const Jolt = await initJolt()

// The smallest conveyor from docs/part-authoring-guide.md: exactly what an external author writes
// against the SDK.
const behaviorSource = `
definePart({
  params: {
    speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Belt speed (m/s)' },
    reverse: { type: 'boolean', default: false, label: 'Reverse direction' },
  },
  step(ctx) {
    const dir = ctx.params.reverse ? -1 : 1
    const s = ctx.params.speed * dir
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
`
const manifest: PackageManifest = {
  id: 'oip.powered-deck',
  name: 'Powered Deck',
  category: 'Equipment',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
}

function emptyScene(): SceneJSON {
  return { version: SCENE_VERSION, parts: [] }
}

/** a scene holding one instance of `pkg` at (0, 1, 0): how the app builds a part, through the scene */
function sceneWith(pkg: PartPackage, params: Record<string, unknown> = {}): SceneJSON {
  const part = { id: 'p', type: 'part', packageId: pkg.id, position: [0, 1, 0], rotationY: 0, params }
  return { version: SCENE_VERSION, parts: [part], packages: [pkg] } as unknown as SceneJSON
}

describe('custom-part packages (External IDE + SDK model)', () => {
  it('builds a valid package from an authored part + bakes its exported params', () => {
    const pkg = buildPackage(manifest, behaviorSource)
    expect(validatePartPackage(pkg)).toEqual([])
    expect(pkg.id).toBe('oip.powered-deck')
    expect(pkg.params).toHaveProperty('speed')
    expect(pkg.params).toHaveProperty('reverse')
    expect(pkg.geometry).toEqual({ kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } })
  })

  it('bakes a declared snap block into the package (a device mount → host snap features)', () => {
    const src = `definePart({ snap: { mounts: [{ at: [0, 0, 0.037], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, fitRangeParam: 'maxRange' }] }, params: { maxRange: { type: 'number', default: 2 } }, step(){} })`
    const pkg = buildPackage({ id: 'oip.mount', name: 'Mount', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)
    expect(validatePartPackage(pkg)).toEqual([])
    expect(pkg.snap?.mounts?.[0]?.accepts).toBe('conveyorGuard')
    expect(pkg.snap?.mounts?.[0]?.at).toEqual([0, 0, 0.037])
    expect(pkg.snap?.mounts?.[0]?.fitRangeParam).toBe('maxRange')
  })

  it('rejects a snap mount missing its contact point / surface kind', () => {
    const bad = `definePart({ snap: { mounts: [{ accepts: '' }] }, step(){} })`
    expect(() => buildPackage({ id: 'oip.badmount', name: 'Bad', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, bad)).toThrow(/mount\.at|mount\.accepts/)
  })

  // A snap block that names a param it does not have is silent: the engine resolves every such name through
  // numParamOf, which yields null, and a null makes the snap return null - so the part just never snaps, with
  // nothing logged. validateSnapParamRefs is the check; the severity split is the point of these cases.
  it('refuses a snap param reference that names no such param - on the authoring path', () => {
    const src = `definePart({ snap: { tile: { group: 'g', lengthParam: 'lenght', widthParam: 'width' } }, params: { length: { type: 'number', default: 2 }, width: { type: 'number', default: 1 } }, step(){} })`
    expect(() => buildPackage({ id: 'oip.typo', name: 'Typo', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)).toThrow(/snap\.tile\.lengthParam/)
  })

  it('refuses a retired exposes on the authoring path, with the reason, where the author can remove it', () => {
    const manifest = { id: 'oip.cell', name: 'Cell', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } }, exposes: [{ tag: 'done', dir: 'out', type: 'BOOL' }] }
    expect(() => buildPackage(manifest as PackageManifest, 'definePart({ step(){} })')).toThrow(/exposes: retired with PLC tag scoping/)
  })

  it('refuses a spin or scroll that names no speed on a part that is no conveyor, which would sit frozen', () => {
    const geometry = { kind: 'rig', links: [{ name: 'hub', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0.1, 0] }], joints: [], bounds: { length: 0.2, width: 0.2, top: 0.2, bottom: 0 } }
    const src = (speed: string) => `definePart({ params: { fanSpeed: { type: 'number', default: 1 } }, geometry(g) { return [{ desc: g.box([0, 0.1, 0], [0.2, 0.02, 0.2]), spin: { axis: [0, 1, 0], radius: 0.1${speed} } }] }, step(){} })`
    expect(() => buildPackage({ id: 'oip.fan', name: 'Fan', geometry } as PackageManifest, src(''))).toThrow(/names no speed/)
    expect(() => buildPackage({ id: 'oip.fan', name: 'Fan', geometry } as PackageManifest, src(", speed: 'fanSpeed'"))).not.toThrow()
  })

  it('…but the load path tolerates it, because a package problem deletes the part', () => {
    // scene.ts / project.ts record an error and skip a package with any problem, so if a typo were fatal the
    // user would lose the part and every instance of it from a scene that opened fine yesterday - strictly
    // worse than the snap not firing. Build a good package, then plant the typo the way a saved file would.
    const src = `definePart({ snap: { tile: { group: 'g', lengthParam: 'length', widthParam: 'width' } }, params: { length: { type: 'number', default: 2 }, width: { type: 'number', default: 1 } }, step(){} })`
    const good = buildPackage({ id: 'oip.typo2', name: 'Typo2', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)
    const typo = { ...good, snap: { tile: { group: 'g', lengthParam: 'lenght', widthParam: 'width' } } } as PartPackage
    expect(validatePartPackage(typo), 'a snap typo must never cost the user their part').toEqual([])
    const refs = validateSnapParamRefs(typo)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.field).toBe('snap.tile.lengthParam')
    expect(refs[0]!.message).toMatch(/not a declared param/)
  })

  it('refuses a snap param reference that names the wrong type', () => {
    const src = `definePart({ snap: { chain: { group: 'g', lengthParam: 'length', reach: 3, omitStartParam: 'length' } }, params: { length: { type: 'number', default: 2 } }, step(){} })`
    expect(() => buildPackage({ id: 'oip.wrongtype', name: 'WrongType', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)).toThrow(/snap\.chain\.omitStartParam/)
  })

  it('a correct snap block reports nothing', () => {
    const src = `definePart({ snap: { edgeMount: { accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into', at: [0, 0, 0], atParams: [{ axis: 0, param: 'numSteps', scale: 0.28 }, { axis: 1, param: 'numSteps', scale: 0.178 }], fromFloor: { param: 'numSteps' }, opens: true, notch: true, lift: true } }, params: { width: { type: 'number', default: 1 }, numSteps: { type: 'number', default: 5 } }, step(){} })`
    const pkg = buildPackage({ id: 'oip.okrefs', name: 'OkRefs', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)
    expect(validateSnapParamRefs(pkg)).toEqual([])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  // The mount's own fields are validated like every sibling block's. `face` matters most: seatOnRail reads it
  // as `m.face !== 'out'`, so an unchecked misspelling would silently mean inward, a diverter that pushes the
  // wrong way rather than one that fails to build.
  it('rejects a malformed mount face / offset instead of degrading silently', () => {
    const badFace = `definePart({ snap: { mounts: [{ at: [0, 0, 0], accepts: 'conveyorGuard', face: 'outward' }] }, step(){} })`
    expect(() => buildPackage({ id: 'oip.badface', name: 'BadFace', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, badFace)).toThrow(/mount\.face/)
    const badOffset = `definePart({ snap: { mounts: [{ at: [0, 0, 0], accepts: 'conveyorGuard', outwardOffset: '0.02' }] }, step(){} })`
    expect(() => buildPackage({ id: 'oip.badoff', name: 'BadOff', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, badOffset)).toThrow(/mount\.outwardOffset/)
  })

  it("bakes a tag param's declared signal (dir + stType) - the part's machine-readable PLC interface", () => {
    const src = `definePart({ params: { speed: { type: 'number', default: 1 }, speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '' }, runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } }, step(ctx){ ctx.report('speed', ctx.params.speed) } })`
    const pkg = buildPackage({ id: 'oip.signals', name: 'Signals', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, src)
    expect(validatePartPackage(pkg)).toEqual([])
    expect(pkg.params.speedTag?.dir).toBe('in')
    expect(pkg.params.speedTag?.stType).toBe('REAL')
    expect(pkg.params.runningTag?.dir).toBe('out')
  })

  it('rejects a half-declared, misspelled or undeclared tag signal, and leaves a stored undeclared one alone', () => {
    const base = (params: string): string => `definePart({ params: ${params}, step(){} })`
    const head = { id: 'oip.sig', name: 'Sig', geometry: { kind: 'rig' as const, links: [{ name: 'deck', shape: { kind: 'box' as const, size: [1, 0.1, 1] as [number, number, number] }, offset: [0, -0.05, 0] as [number, number, number], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
    // a direction with no type can't be typed into ST; a type with no direction can't be wired
    expect(() => buildPackage(head, base(`{ t: { type: 'tag', dir: 'in', default: '' } }`))).toThrow(/stType/)
    expect(() => buildPackage(head, base(`{ t: { type: 'tag', dir: 'input', stType: 'REAL', default: '' } }`))).toThrow(/dir/)
    expect(() => buildPackage(head, base(`{ t: { type: 'tag', dir: 'in', stType: 'FLOAT', default: '' } }`))).toThrow(/stType/)
    expect(() => buildPackage(head, base(`{ n: { type: 'number', dir: 'in', stType: 'REAL', default: 1 } }`))).toThrow(/only valid on a tag param/)
    // an authored part must declare both (the wiring check can't see an undeclared signal)
    expect(() => buildPackage(head, base(`{ t: { type: 'tag', default: '' } }`))).toThrow(/dir/)
    // a stored package saved before that rule still loads (the wiring check reports it as undeclared instead)
    const stored = buildPackage(head, base(`{ t: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } }`))
    const { dir: _d, stType: _t, ...undeclared } = stored.params.t!
    expect(validatePartPackage({ ...stored, params: { t: undeclared } })).toEqual([])
  })

  it('rejects a malformed package', () => {
    const problems = validatePartPackage({ format: PACKAGE_FORMAT, id: '', name: 'x', behavior: '', params: {}, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [0, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 0, width: 1, top: 0.05, bottom: -0.1 } } })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.map((p) => p.field)).toContain('behavior')
  })

  it('validates a PartMaterial.triplanar remap (the Diverter arm-metal un-stretch fix)', () => {
    const pkg = (mat: Record<string, unknown>) => ({
      format: PACKAGE_FORMAT, id: 'oip.tp', name: 'TP', params: {},
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig' as const, links: [{ name: 'deck', shape: { kind: 'box' as const, size: [1, 0.1, 1] as [number, number, number] }, offset: [0, -0.05, 0] as [number, number, number], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
      assets: [{ id: 'tex', mime: 'image/png', data: 'AAAA' }],
      materials: [mat],
    })
    const fields = (mat: Record<string, unknown>): string[] => validatePartPackage(pkg(mat)).map((p) => p.field)
    // valid: object-space triplanar sampling the albedo texture (the un-stretched arm metal)
    expect(validatePartPackage(pkg({ id: 'arm', albedo: 'tex', metalness: 0.9, roughness: 0.35, triplanar: { space: 'object', scale: 2.2, boost: 1.25 } }))).toEqual([])
    // rejections: a bad space, a non-positive scale, and (world) omitting the albedo it must sample
    expect(fields({ id: 'arm', albedo: 'tex', triplanar: { space: 'diagonal', scale: 2 } })).toContain('materials[0].triplanar.space')
    expect(fields({ id: 'arm', albedo: 'tex', triplanar: { space: 'world', scale: 0 } })).toContain('materials[0].triplanar.scale')
    expect(fields({ id: 'arm', triplanar: { space: 'world', scale: 2 } })).toContain('materials[0].triplanar')
  })

  it('validates a mesh link\'s multi-lamp block (the Diverter\'s two panel lenses on ONE mesh)', () => {
    // the helper below builds the mesh shape and its lamps together; the lamps belong to the link
    const pkg = ({ lamps, ...shape }: Record<string, unknown>) => ({
      format: PACKAGE_FORMAT, id: 'oip.panel', name: 'Panel', params: {},
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig' as const, links: [{ name: 'housing', shape, lamps, offset: [0, 0, 0] }], joints: [] },
      assets: [{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }],
      materials: [{ id: 'lensA', color: [0.2, 0, 0] }, { id: 'lensB', color: [0, 0.2, 0] }],
    })
    const fields = (shape: Record<string, unknown>): string[] => validatePartPackage(pkg(shape)).map((p) => p.field)
    const remap = { LensA: 'lensA', LensB: 'lensB' }
    const mesh = (lamps: unknown) => ({ kind: 'mesh', asset: 'glb', materials: remap, lamps })
    const at = 'geometry.links[0].lamps'
    // valid: two lenses of one mesh, each a remapped material with its own name + lit colour
    expect(validatePartPackage(pkg(mesh([{ material: 'LensA', name: 'red', emissive: [1, 0, 0] }, { material: 'LensB', name: 'green', emissive: [0, 1, 0] }])))).toEqual([])
    // a lamp must light a material the link actually remaps; an un-remapped GLB material isn't this part's to repaint
    expect(fields(mesh([{ material: 'LensC', name: 'red', emissive: [1, 0, 0] }]))).toContain(`${at}[0].material`)
    // a lit colour is required (a lamp with nothing to light is a silent no-op - the bug this whole block fixes)
    expect(fields(mesh([{ material: 'LensA', name: 'red' }]))).toContain(`${at}[0].emissive`)
    // names must be present and unique - two lamps sharing one name would collide in ctx.lamps
    expect(fields(mesh([{ material: 'LensA', name: '', emissive: [1, 0, 0] }]))).toContain(`${at}[0].name`)
    expect(fields(mesh([{ material: 'LensA', name: 'red', emissive: [1, 0, 0] }, { material: 'LensB', name: 'red', emissive: [0, 1, 0] }]))).toContain(`${at}[1].name`)
    // lens opacity, when given, is a real (0, 1] fraction
    expect(fields(mesh([{ material: 'LensA', name: 'red', emissive: [1, 0, 0], opacity: 0 }]))).toContain(`${at}[0].opacity`)
    // on a mesh link a lamp must say which material it lights (there is no "own material" to fall back on)
    expect(fields(mesh([{ name: 'red', emissive: [1, 0, 0] }]))).toContain(`${at}[0].material`)
  })

  it('refuses to build from a broken behavior', () => {
    expect(() => buildPackage(manifest, 'var x = 1')).toThrow(/definePart|failed/)
  })

  it('rejects declared joints/grippers that are not in the rig geometry (typo-vs-geometry guard)', () => {
    const geo = {
      kind: 'rig' as const,
      links: [{ name: 'arm', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number] }],
      joints: [{ name: 'shoulder', link: 'arm', type: 'revolute' as const, axis: [0, 1, 0] as [number, number, number], min: -1, max: 1 }],
    }
    const rigManifest = (id: string): PackageManifest => ({ id, name: 'Arm', geometry: geo })
    expect(() => buildPackage(rigManifest('a'), 'definePart({ joints: ["sholder"], step(){} })')).toThrow(/not a rig joint/) // typo
    expect(() => buildPackage(rigManifest('b'), 'definePart({ grippers: ["claw"], step(){} })')).toThrow(/not a rig link/)
    // correct declarations build cleanly (a gripper is a link name)
    expect(buildPackage(rigManifest('c'), 'definePart({ joints: ["shoulder"], grippers: ["arm"], step(){} })').id).toBe('c')
  })

  it('accepts a boolean rig `posable` flag and rejects a non-boolean one', () => {
    const rig = (posable: unknown) => ({
      format: PACKAGE_FORMAT,
      id: 'oip.arm',
      name: 'Arm',
      params: {},
      behavior: 'definePart({ step(){} })',
      geometry: {
        kind: 'rig' as const,
        posable,
        links: [{ name: 'arm', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number] }],
        joints: [{ name: 'shoulder', link: 'arm', type: 'revolute' as const, axis: [0, 1, 0] as [number, number, number], min: -1, max: 1 }],
      },
    })
    expect(validatePartPackage(rig(true))).toEqual([]) // opted-in manipulator
    expect(validatePartPackage(rig(undefined))).toEqual([]) // omitted = default (no in-scene pose gizmo)
    expect(validatePartPackage(rig('yes')).map((p) => p.field)).toContain('geometry.posable')
  })

  it('an imported package instantiates and conveys cargo deterministically', () => {
    const pkg = buildPackage(manifest, behaviorSource)
    const run = (): number[] => {
      const w = new SimWorld(Jolt, sceneWith(pkg, { speed: 1.2 }))
      w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
      for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
      return Array.from(w.frame().positions)
    }
    const a = run()
    expect(a[0]).toBeGreaterThan(0.6) // conveyed +X by the imported part's behavior
    expect(run()).toEqual(a) // reproducible
  })

  it('a stored swept bed (the retired geometry.kind "mesh") still carries cargo once it loads', () => {
    // saved before the kind was retired: the sim built it a flat deck, and the load now makes it one
    const saved = {
      ...buildPackage({ id: 'oip.swept-belt', name: 'Swept Belt', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } } }, behaviorSource),
      geometry: {
        kind: 'mesh',
        conveys: true,
        sweep: { profile: [[-0.1, -0.5], [-0.1, 0.5], [0, 0.5], [0, -0.5]], length: 6 },
        bounds: { length: 6, width: 1, top: 0.1 },
      },
    }
    const pkg = upgradeStoredPackage(saved).pkg as unknown as PartPackage
    expect(validatePartPackage(pkg)).toEqual([])
    const w = new SimWorld(Jolt, sceneWith(pkg, { speed: 1.2 }))
    w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
    const x = w.frame().positions[0]
    w.dispose() // free the Jolt interface (the shared module OOMs if every test leaks one)
    expect(x).toBeGreaterThan(0.6) // conveyed +X, as the sweep was
  })

  it('a bent belt (function geometry, segments) carries cargo up its incline (per-segment, behavior-driven)', () => {
    // a flat run x∈[0,2] then a +25° incline: the per-segment deck carries cargo along each run's tangent, so
    // the box climbs the slope - what a single flat conveyor velocity could not do.
    const beltBehavior = `
definePart({
  params: {
    // the path handle is what marks this part belt-like: the host builds the bent per-segment deck from it
    segments: { type: 'numberList', arity: 2, default: [[2, 0], [2, 25]], handle: { kind: 'path' } },
    width: { type: 'number', default: 1 },
    height: { type: 'number', default: 0.28 },
    speed: { type: 'number', default: 1.5 },
  },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var corners = [[0, 0, 0]]
    var tilt = 0, x = 0, y = 0
    for (var i = 0; i < p.segments.length; i++) { tilt += p.segments[i][1] * DEG; x += Math.cos(tilt) * p.segments[i][0]; y += Math.sin(tilt) * p.segments[i][0]; corners.push([x, y, 0]) }
    return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], g.fillet(corners, p.height))
  },
  step(ctx) {
    var s = ctx.params.speed
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
`
    const beltManifest: PackageManifest = {
      id: 'oip.bent-belt',
      name: 'Bent Belt',
      geometry: { kind: 'drawn', conveys: true, bounds: { length: 4, width: 1, top: 0.5 } },
    }
    const pkg = buildPackage(beltManifest, beltBehavior)
    expect(validatePartPackage(pkg)).toEqual([])
    const w = new SimWorld(Jolt, emptyScene())
    expect(w.spawnFromPackage(pkg, [0, 1, 0], 0, '{}')).toBe(true) // default segments → the bent deck builds
    w.spawnBoxAt(0.4, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // dropped on the flat run
    // ~2 s: enough to convey across the flat run and partway up the incline, before it reaches the top + leaves
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) w.step()
    const f = w.frame()
    const bx = f.positions[0]
    const by = f.positions[1]
    w.dispose()
    expect(bx).toBeGreaterThan(2) // conveyed past the flat run (x∈[0,2]) onto the incline
    expect(bx).toBeLessThan(4) // still on the belt (incline top ≈ x 3.8), not flung off the end
    expect(by).toBeGreaterThan(1.3) // and climbed well above the y=1 deck - the per-segment tangent carried it up
  })

  it('a bent belt stops conveying when its commanded speed is 0 (behavior-driven, not param-baked)', () => {
    const stopBelt = `
definePart({
  params: { segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path' } }, height: { type: 'number', default: 0.28 } },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var corners = [[0, 0, 0]]
    var tilt = 0, x = 0, y = 0
    for (var i = 0; i < p.segments.length; i++) { tilt += p.segments[i][1] * DEG; x += Math.cos(tilt) * p.segments[i][0]; y += Math.sin(tilt) * p.segments[i][0]; corners.push([x, y, 0]) }
    return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], g.fillet(corners, p.height))
  },
  step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) }, // commanded stopped (e.g. a PLC run-gate is false)
})
`
    const pkg = buildPackage({ id: 'oip.stop-belt', name: 'Stop Belt', geometry: { kind: 'drawn', conveys: true, bounds: { length: 3, width: 1, top: 0.3 } } }, stopBelt)
    const w = new SimWorld(Jolt, emptyScene())
    expect(w.spawnFromPackage(pkg, [0, 1, 0], 0, '{}')).toBe(true)
    w.spawnBoxAt(0.5, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) w.step()
    const bx = w.frame().positions[0]
    w.dispose()
    expect(bx).toBeLessThan(0.8) // barely moved - the deck exists (cargo rests on it) but conveys 0
  })

  it("honors the part's own params (reverse drives cargo the other way)", () => {
    const pkg = buildPackage(manifest, behaviorSource)
    const w = new SimWorld(Jolt, sceneWith(pkg, { speed: 1.2, reverse: true }))
    w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
    expect(w.frame().positions[0]).toBeLessThan(-0.6) // reverse → −X
  })

  // A belt-like custom part (declares a `path` handle) merges its deck into a butted cluster like a built-in
  // belt - so two SDK belts end-to-end ride one compound body and cargo crosses the seam without snagging.
  const clusterBeltSrc = `
definePart({
  params: {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 1 },
    height: { type: 'number', default: 0.28 },
    speed: { type: 'number', default: 1.5 },
  },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var corners = [[0, 0, 0]]
    var tilt = 0, x = 0, y = 0
    for (var i = 0; i < p.segments.length; i++) { tilt += p.segments[i][1] * DEG; x += Math.cos(tilt) * p.segments[i][0]; y += Math.sin(tilt) * p.segments[i][0]; corners.push([x, y, 0]) }
    return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], g.fillet(corners, p.height))
  },
  step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
})
`

  it('two butted SDK belts merge their decks - a box conveys across the seam (both belts drive it)', () => {
    const pkg = buildPackage({ id: 'oip.cluster-belt', name: 'Cluster Belt', geometry: { kind: 'drawn', conveys: true, bounds: { length: 4, width: 1, top: 0.28 } } }, clusterBeltSrc)
    // length 4 + 2·pulley(0.14): centres 2.14 from the butt, so 'a'@−2.14 (front end at x=0) meets 'b'@+2.14.
    const part = (id: string, x: number): SdkPart => ({ id, type: 'part', packageId: pkg.id, position: [x, 1, 0], rotationY: 0, params: { segments: [[4, 0]], width: 1, height: 0.28, speed: 1.5 } } as unknown as SdkPart)
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [part('a', -2.14), part('b', 2.14)], packages: [pkg] } as unknown as SceneJSON
    expect(validateScene(scene).ok).toBe(true)
    const w = new SimWorld(Jolt, scene)
    w.spawnBoxAt(-1.5, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // dropped on belt 'a', before the seam
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
    const f = w.frame()
    const bx = f.positions[0]
    const by = f.positions[1]
    w.dispose()
    expect(bx).toBeGreaterThan(0.5) // conveyed across the x=0 seam onto belt 'b' - so belt 'b' (a non-owner cluster member) conveys too
    expect(by).toBeGreaterThan(0.9) // still riding the deck (didn't drop through a gap at the seam)
  })
})

describe('custom parts build from a scene (sim builder)', () => {
  it('a scene custom part conveys cargo on Play (full embed → validate → build → sim path)', () => {
    clearPackages() // SimWorld must register the scene's embedded packages itself
    const pkg = buildPackage(manifest, behaviorSource)
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [pkg],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'oip.powered-deck', position: [0, 1, 0], rotationY: 0, params: { speed: 1.2 } }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
    const x = w.frame().positions[0]
    w.dispose() // free the Jolt interface (the shared module OOMs if every test leaks one)
    expect(x).toBeGreaterThan(0.6) // conveyed +X by the scene custom part's behavior
  })

  it('a C-cargo custom part is dynamic cargo: it falls onto a conveyor, is carried, and rides the frame', () => {
    // The cargo geometry kind (docs/architecture.md): the package declares { kind: 'cargo' } and the host
    // builds the part as one dynamic body from its params - the same pipeline as the built-in box/pallet.
    clearPackages()
    const deckPkg = buildPackage(manifest, behaviorSource)
    const cargoPkg = buildPackage(
      { id: 'oip.box', name: 'Box', geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } } },
      'definePart({ params: { length: { type: "number", default: 0.6 }, height: { type: "number", default: 0.4 }, width: { type: "number", default: 0.4 }, mass: { type: "number", default: 10 }, color: { type: "color", default: "#ffffff" } }, step() {} })',
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [deckPkg, cargoPkg],
      parts: [
        { id: 'deck_1', type: 'part', packageId: 'oip.powered-deck', position: [0, 1, 0], rotationY: 0, params: { speed: 1.2 } },
        // Dropped above the deck TAIL: a dynamic body must fall ~0.1 m onto it, then be conveyed +X
        { id: 'cargo_1', type: 'part', packageId: 'oip.box', position: [-2, 1.3, 0], rotationY: 0, params: { length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#ff0000' } },
      ],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    for (let i = 0; i < DEFAULT_SIM_HZ * 1.5; i++) w.step()
    const f = w.frame()
    w.dispose()
    expect(f.count).toBe(1)
    expect(f.partIds[0]).toBe('cargo_1') // the authored cargo body carries its scene part id (gizmo/pilot key)
    expect(f.halfExtents[0]).toBeCloseTo(0.3, 5) // half-extents from the instance params
    expect(f.colors[0]).toBeCloseTo(1, 3) // #ff0000 tint rides the frame to the batch
    expect(f.positions[1]).toBeCloseTo(1.2, 1) // Fell from 1.3 and rests on the deck top (1.0) + half height (0.2)
    expect(f.positions[0]).toBeGreaterThan(-1) // and the deck conveys it +X (>1 m) - real cargo on the pipeline
  })

  it('a C-cargo pallet builds at the fixed EUR size regardless of instance size params', () => {
    clearPackages()
    const palletPkg = buildPackage(
      { id: 'oip.pallet', name: 'Pallet', geometry: { kind: 'cargo', cargoKind: 'pallet', size: { length: 1.22, width: 1.02, height: 0.135 } } },
      'definePart({ params: { mass: { type: "number", default: 20 }, color: { type: "color", default: "#ffffff" } }, step() {} })',
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [palletPkg],
      parts: [{ id: 'p_1', type: 'part', packageId: 'oip.pallet', position: [0, 1, 0], rotationY: 0, params: { mass: 30, length: 9 } }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.step()
    const f = w.frame()
    w.dispose()
    expect(f.count).toBe(1)
    expect(f.kinds[0]).toBe(CARGO_KIND_PALLET)
    expect(f.halfExtents[0]).toBeCloseTo(0.61, 5) // EUR 1.22/2 - the stray length param is ignored
    expect(f.halfExtents[1]).toBeCloseTo(0.0675, 5)
  })

  it('a rig custom part emits its commanded joints in the frame (live articulation)', () => {
    clearPackages()
    const rigPkg = buildPackage(
      {
        id: 'acme.arm',
        name: 'Arm',
        geometry: {
          kind: 'rig',
          links: [
            { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
            { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0] },
          ],
          joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -3.14, max: 3.14 }],
        },
      },
      'definePart({ step(ctx){ ctx.setJoint("shoulder", 0.75) } })',
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [rigPkg],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.arm', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    for (let i = 0; i < 5; i++) w.step()
    const joints = w.frame().joints
    w.dispose()
    expect(joints?.['cp_1']).toEqual({ shoulder: 0.75 }) // routed to the view by part id, animates the rig
  })

  it('a rig link physically pushes cargo (kinematic collision body driven by FK)', () => {
    clearPackages()
    const pusher = buildPackage(
      {
        id: 'acme.pusher',
        name: 'Pusher',
        geometry: {
          kind: 'rig',
          links: [{ name: 'pusher', shape: { kind: 'box', size: [0.4, 0.4, 0.4] }, offset: [0, 0.2, 0] }],
          joints: [{ name: 'ext', link: 'pusher', type: 'prismatic', axis: [1, 0, 0], min: 0, max: 5 }],
          bounds: { length: 5, width: 1, top: 0.5 },
        },
      },
      'definePart({ step(ctx){ ctx.setJoint("ext", ctx.simTime * 2) } })', // slide +X at 2 m/s
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [pusher],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.pusher', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(1, 0.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // a box ahead of the pusher's path
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 90; i++) w.step()
    const x1 = w.frame().positions[0] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // shoved +X by the sweeping kinematic link
  })

  it('a param-driven box link (C-paramgeo) builds its collision body at the resolved width', () => {
    // a blade on a prismatic joint sweeps +X; its z-extent = the `width` param. A box parked off-centre in z
    // is only caught (pushed) when width is large enough to span it, which shows the param resized the body.
    const bladePkg = (): ReturnType<typeof buildPackage> => {
      clearPackages()
      return buildPackage(
        {
          id: 'acme.blade',
          name: 'Blade',
          geometry: {
            kind: 'rig',
            links: [{ name: 'blade', shape: { kind: 'box', size: [0.4, 0.4, 0.4], sizeParams: [{ axis: 2, param: 'width' }] }, offset: [0, 0.2, 0] }],
            joints: [{ name: 'ext', link: 'blade', type: 'prismatic', axis: [1, 0, 0], min: 0, max: 5 }],
            bounds: { length: 5, width: 3, top: 0.5 },
          },
        },
        "definePart({ params: { width: { type:'number', default: 0.4, min: 0.1, max: 3 } }, step(ctx){ ctx.setJoint('ext', ctx.simTime * 2) } })",
      )
    }
    const sweep = (width: number): number => {
      const res = validateScene({
        version: SCENE_VERSION,
        packages: [bladePkg()],
        parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.blade', position: [0, 0, 0], rotationY: 0, params: { width } }],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return 0
      const w = new SimWorld(Jolt, res.scene)
      w.spawnBoxAt(1, 0.3, 0.6, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // a box parked off-centre at z = 0.6
      const x0 = w.frame().positions[0] ?? 0
      for (let i = 0; i < 90; i++) w.step()
      const dx = (w.frame().positions[0] ?? 0) - x0
      w.dispose()
      return dx
    }
    expect(sweep(0.4)).toBeLessThan(0.2) // narrow blade (half-z 0.2) misses the box at z 0.6
    expect(sweep(2.0)).toBeGreaterThan(0.3) // wide blade (half-z 1.0) spans it → shoves it +X
  })

  it('a param-offset revolute leaf (C-paramgeo offsets) swings as a kinematic body and sweeps cargo', () => {
    // the safety-gate shape: a hinge frame at -length/2 + a leaf child at +length/2 (centred when closed),
    // both positioned by the `length` param (offsetParams). A revolute joint swings the leaf; as a kinematic
    // body it sweeps a box parked in its arc, which shows the param-offset collision body is placed and moves correctly.
    clearPackages()
    const gate = buildPackage(
      {
        id: 'acme.gate',
        name: 'Gate',
        geometry: {
          kind: 'rig',
          links: [
            { name: 'hinge', shape: { kind: 'frame' }, offset: [-0.5, 0, 0], offsetParams: [{ axis: 0, param: 'length', scale: -0.5 }] },
            { name: 'leaf', parent: 'hinge', shape: { kind: 'box', size: [0.9, 2, 0.06], sizeParams: [{ axis: 0, param: 'length', scale: 1, add: -0.08 }] }, offset: [0.5, 1, 0], offsetParams: [{ axis: 0, param: 'length', scale: 0.5 }] },
          ],
          joints: [{ name: 'swing', link: 'hinge', type: 'revolute', axis: [0, 1, 0], min: -3.15, max: 3.15 }],
          bounds: { length: 2, width: 0.2, top: 2 },
        },
      },
      "definePart({ joints:['swing'], params: { length: { type:'number', default: 2, min: 0.5, max: 6 } }, step(ctx){ ctx.setJoint('swing', Math.min(ctx.simTime * 2, 1.4)) } })", // swing open
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [gate],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.gate', position: [0, 0, 0], rotationY: 0, params: { length: 2 } }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(-0.4, 0.2, -0.25, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box parked in the leaf's swing arc
    const start = w.frame().positions
    const [sx, sz] = [start[0] ?? 0, start[2] ?? 0]
    for (let i = 0; i < 120; i++) w.step()
    const end = w.frame().positions
    const moved = Math.hypot((end[0] ?? 0) - sx, (end[2] ?? 0) - sz)
    w.dispose()
    expect(moved).toBeGreaterThan(0.2) // the swinging leaf shoved the box out of its arc
  })

  it('a sensor beam (C-sensing) detects cargo crossing it and drives a PLC tag', () => {
    clearPackages()
    const sensor = buildPackage(
      {
        id: 'acme.eye',
        name: 'Eye',
        geometry: {
          kind: 'rig',
          // a lens link emitting a beam along local +Z for 2 m (a small box so the part still renders)
          links: [{ name: 'lens', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], beam: { range: 2 } }],
          joints: [],
          bounds: { length: 0.1, width: 0.1, top: 0.4 },
        },
      },
      "definePart({ step(ctx){ ctx.writeTag('blocked', ctx.sense('lens').hit) } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [sensor],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.eye', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.step()
    const clear = w.frame().tags?.cp_1?.blocked // no cargo yet → not blocked
    w.spawnBoxAt(0, 0.3, 1, 0.2, 0.2, 0.2, 0, 10, [1, 0, 0]) // a box directly ahead, at the lens height
    for (let i = 0; i < 3; i++) w.step()
    const blocked = w.frame().tags?.cp_1?.blocked
    w.dispose()
    expect(clear).toBe(false)
    expect(blocked).toBe(true) // the beam now crosses the box → the behavior set the tag
  })

  it('a custom interactive part receives a use pulse (C-interaction) and latches', () => {
    clearPackages()
    const btn = buildPackage(
      {
        id: 'acme.btn',
        name: 'Button',
        geometry: {
          kind: 'rig',
          links: [{ name: 'cap', shape: { kind: 'box', size: [0.04, 0.02, 0.04] }, offset: [0, 0.03, 0], lamps: [{ emissive: [1, 0, 0] }] }],
          joints: [],
          bounds: { length: 0.06, width: 0.06, top: 0.05 },
        },
      },
      "let on=false; definePart({ interactive:true, lamps:['cap'], step(ctx){ if(ctx.used()) on=!on; ctx.lamps.cap=on } })",
    )
    expect(btn.interactive).toBe(true) // baked from the behavior's declaration
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [btn],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.btn', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.step()
    const before = w.frame().lamps?.cp_1?.cap // untouched → off
    w.usePart('cp_1') // a pilot-mode click
    w.step()
    const after = w.frame().lamps?.cp_1?.cap // toggled on by the use
    w.step() // a further tick with no click - the pulse was one tick; the latch holds
    const held = w.frame().lamps?.cp_1?.cap
    w.dispose()
    expect(before).toBe(false)
    expect(after).toBe(true)
    expect(held).toBe(true)
  })

  it('a custom spawner (C-spawn) emits cargo boxes at its rate', () => {
    clearPackages()
    const spawner = buildPackage(
      {
        id: 'acme.spawner',
        name: 'Spawner',
        geometry: {
          kind: 'rig',
          links: [{ name: 'housing', shape: { kind: 'box', size: [0.3, 0.2, 0.3] }, offset: [0, 0.5, 0] }],
          joints: [],
          bounds: { length: 0.3, width: 0.3, top: 0.5 },
        },
      },
      // spawn one 0.2 m box below the housing every 0.1 s (rate 600/min)
      "let t=0; definePart({ params:{ rate:{ type:'number', default:600 } }, step(ctx){ t+=ctx.dt; const period=60/ctx.params.rate; if(t>=period){ t-=period; ctx.spawn({ offset:[0,-0.4,0], size:[0.2,0.2,0.2], color:[1,0,0] }) } } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [spawner],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.spawner', position: [0, 1, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    const before = w.frame().count // no cargo yet (the housing is a kinematic rig body, not counted)
    for (let i = 0; i < 30; i++) w.step() // 0.5 s → ~5 spawns at 10/s
    const after = w.frame().count
    w.dispose()
    expect(before).toBe(0)
    expect(after).toBeGreaterThanOrEqual(3) // the spawner produced cargo over time
  })

  it('a custom despawner (C-despawn) removes cargo in its zone and counts throughput', () => {
    clearPackages()
    const sink = buildPackage(
      {
        id: 'acme.sink',
        name: 'Sink',
        geometry: {
          kind: 'rig',
          // a frame 'mouth' (no collision body, so cargo isn't blocked) carrying a 1×1×1 detection/removal zone
          links: [{ name: 'mouth', shape: { kind: 'frame' }, offset: [0, 0.5, 0], zone: { size: [1, 1, 1] } }],
          joints: [],
          bounds: { length: 1, width: 1, top: 1 },
        },
      },
      "let total=0; definePart({ step(ctx){ const n=ctx.zone('mouth'); if(n>0){ total+=n; ctx.despawn('mouth') } ctx.writeNumber('total', total) } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [sink],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.sink', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 0.5, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1]) // three boxes inside the zone (centre y 0.5)
    w.spawnBoxAt(0.2, 0.5, 0.2, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    w.spawnBoxAt(-0.2, 0.5, -0.2, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    const before = w.frame().count
    w.step() // the despawner counts 3, then removes them
    const after = w.frame().count
    const total = w.frame().tags?.cp_1?.total
    w.dispose()
    expect(before).toBe(3)
    expect(after).toBe(0) // all cargo in the zone removed
    expect(total).toBe(3) // throughput tallied from ctx.zone()
  })

  it('a despawner zone resizes with a param (zone.sizeParams): a narrow one misses, a wide one catches', () => {
    clearPackages()
    // the 'mouth' zone's Z half-extent tracks a `width` param (C-paramgeo on a zone) - the built-in despawner's
    // resizable trigger volume. A box parked at z=0.6 sits outside a width-0.5 zone (half-extent 0.25) but inside
    // a width-2 zone (half-extent 1.0), which shows the param resized the detection box, not just the visible mesh.
    const sink = buildPackage(
      {
        id: 'acme.sink2',
        name: 'Sink2',
        geometry: {
          kind: 'rig',
          links: [{ name: 'mouth', shape: { kind: 'frame' }, offset: [0, 0.5, 0], zone: { size: [1, 1, 1], sizeParams: [{ axis: 2, param: 'width' }] } }],
          joints: [],
          bounds: { length: 1, width: 1, top: 1 },
        },
      },
      "definePart({ params:{ width:{ type:'number', default:1 } }, step(ctx){ const n=ctx.zone('mouth'); if(n>0){ ctx.despawn('mouth') } } })",
    )
    const runWithWidth = (width: number): { before: number; after: number } => {
      clearPackages()
      const res = validateScene({
        version: SCENE_VERSION,
        packages: [sink],
        parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.sink2', position: [0, 0, 0], rotationY: 0, params: { width } }],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return { before: 0, after: 0 }
      const w = new SimWorld(Jolt, res.scene)
      w.spawnBoxAt(0, 0.5, 0.6, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1]) // parked at z=0.6
      const before = w.frame().count
      w.step()
      const after = w.frame().count
      w.dispose()
      return { before, after }
    }
    const narrow = runWithWidth(0.5)
    expect(narrow.before).toBe(1)
    expect(narrow.after).toBe(1) // z=0.6 is beyond the narrow zone's 0.25 half-extent → not removed
    const wide = runWithWidth(2)
    expect(wide.before).toBe(1)
    expect(wide.after).toBe(0) // the same box is inside the wide zone's 1.0 half-extent → removed
  })

  it('a custom conveyor (C-convey) carries cargo on its deck surface', () => {
    clearPackages()
    const belt = buildPackage(
      {
        id: 'acme.belt',
        name: 'Belt',
        geometry: {
          kind: 'rig',
          // a 2×1 deck whose top (offset −0.05 + half-height 0.05) is at the part origin; `conveys` makes it a
          // static conveyor surface, not a kinematic body
          links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }],
          joints: [],
          bounds: { length: 2, width: 1, top: 0.1 },
        },
      },
      "definePart({ params:{ speed:{ type:'number', default:1.5 } }, step(ctx){ ctx.setSurfaceVelocity({ x: ctx.forward.x*ctx.params.speed, y:0, z: ctx.forward.z*ctx.params.speed }) } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [belt],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.belt', position: [0, 1, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 1.2, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // a box resting on the deck top (y = 1)
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 90; i++) w.step()
    const x1 = w.frame().positions[0] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // carried +X by the conveying deck surface
  })

  it('a spawner interlock (conveyorId → ctx.conveyorRunning) holds while the referenced conveyor is stopped', () => {
    // the built-in "pause when conveyor stopped": a spawner's partRef points at a conveyor; it spawns only while
    // that conveyor commands a non-zero surface speed. A real-but-stopped conveyor (speed 0) freezes the line.
    const build = () => {
      clearPackages()
      const belt = buildPackage(
        { id: 'acme.ibelt', name: 'IBelt', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.1 } } },
        "definePart({ params:{ speed:{ type:'number', default:0 } }, step(ctx){ ctx.setSurfaceVelocity({ x: ctx.forward.x*ctx.params.speed, y:0, z: ctx.forward.z*ctx.params.speed }) } })",
      )
      const spawner = buildPackage(
        { id: 'acme.ispawn', name: 'ISpawn', geometry: { kind: 'rig', links: [{ name: 'm', shape: { kind: 'frame' }, offset: [0, 0, 0] }], joints: [], bounds: { length: 0.5, width: 0.5, top: 0.5 } } },
        "definePart({ params:{ conveyorId:{ type:'partRef', default:'' } }, step(ctx){ if(ctx.conveyorRunning(ctx.params.conveyorId)) ctx.spawn({ offset:[0,2,0] }) } })",
      )
      return [belt, spawner]
    }
    const runWithBeltSpeed = (speed: number): number => {
      const packages = build()
      const res = validateScene({
        version: SCENE_VERSION,
        packages,
        parts: [
          { id: 'belt', type: 'part', packageId: 'acme.ibelt', position: [5, 1, 0], rotationY: 0, params: { speed } },
          { id: 'sp', type: 'part', packageId: 'acme.ispawn', position: [0, 0, 0], rotationY: 0, params: { conveyorId: 'belt' } },
        ],
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return -1
      const w = new SimWorld(Jolt, res.scene)
      for (let i = 0; i < 20; i++) w.step()
      const count = w.frame().count
      w.dispose()
      return count
    }
    expect(runWithBeltSpeed(0)).toBe(0) // belt stopped → interlock holds the spawner → no cargo produced
    expect(runWithBeltSpeed(1.5)).toBeGreaterThan(0) // belt running → the spawner produces cargo
  })

  it('a roller conveyor carries cargo on its deck; the noCollision rollers add no bodies (cylinder C-paramgeo)', () => {
    clearPackages()
    const roller = buildPackage(
      {
        id: 'acme.roller',
        name: 'Roller',
        geometry: {
          kind: 'rig',
          links: [
            // the conveying deck (top at the part origin) - the real surface
            { name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1], sizeParams: [{ axis: 2, param: 'width' }] }, offset: [0, -0.02, 0], conveys: true },
            // rollers: a noCollision distribute-array of width-parametric cylinders (must add no sim bodies)
            { name: 'roller', shape: { kind: 'cylinder', radius: 0.05, height: 1, sizeParams: [{ axis: 1, param: 'width' }] }, offset: [0, -0.05, 0], rotation: [Math.PI / 2, 0, 0], collision: 'none', array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.12 } } },
          ],
          joints: [],
          bounds: { length: 3, width: 1, top: 0.12 },
        },
      },
      "definePart({ params:{ speed:{ type:'number', default:1.5 }, length:{ type:'number', default:3 }, width:{ type:'number', default:1 } }, step(ctx){ ctx.setSurfaceVelocity({ x: ctx.forward.x*ctx.params.speed, y:0, z: ctx.forward.z*ctx.params.speed }) } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [roller],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.roller', position: [0, 1, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(-1, 1.2, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // a box on the deck top (y = 1), behind centre
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 45; i++) w.step() // ~0.75 s - far enough to convey, short enough to stay on the 3 m bed
    const f = w.frame()
    const x1 = f.positions[0] ?? 0
    const y1 = f.positions[1] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // carried +X by the conveying deck (the rollers didn't block/bounce it)
    expect(y1).toBeGreaterThan(0.9) // rode the deck at y≈1 (didn't fall through, wasn't launched by a roller body)
  })

  it('a curved conveyor carries cargo around the arc (C-convey arc surface velocity)', () => {
    clearPackages()
    // a quarter-arc bed: overlapping conveys segments around the part-origin arc centre, radius 1.2, width 1
    const R = 1.2, N = 8, SWEEP = Math.PI / 2, THIN = 0.06
    const segLen = ((R * SWEEP) / N) * 1.4
    const links: { name: string; shape: { kind: 'box'; size: [number, number, number] }; offset: [number, number, number]; rotation: [number, number, number]; conveys: true }[] = []
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * SWEEP
      links.push({ name: `seg${i}`, shape: { kind: 'box', size: [segLen, THIN, 1] }, offset: [R * Math.cos(t), -THIN / 2, -R * Math.sin(t)], rotation: [0, t + Math.PI / 2, 0], conveys: true })
    }
    const curve = buildPackage(
      { id: 'acme.curve', name: 'Curve', geometry: { kind: 'rig', links, joints: [], bounds: { length: 2 * R + 1, width: 2 * R + 1, top: 0.1 } } },
      // arc centre = the part origin; omega = speed/radius sweeps cargo +X → −Z
      "definePart({ params:{ speed:{ type:'number', default:1.2 }, radius:{ type:'number', default:1.2 } }, step(ctx){ ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: ctx.params.speed / ctx.params.radius }) } })",
    )
    const res = validateScene({ version: SCENE_VERSION, packages: [curve], parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.curve', position: [0, 1, 0], rotationY: 0, params: {} }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(R, 1.2, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box at the inlet (+X end of the arc), on the deck
    for (let i = 0; i < 75; i++) w.step() // ~1.25 s - sweeps part-way around the quarter turn
    const f = w.frame()
    const [x, y, z] = [f.positions[0] ?? 0, f.positions[1] ?? 0, f.positions[2] ?? 0]
    w.dispose()
    expect(y).toBeGreaterThan(0.9) // rode the bed at deck height (didn't fall through/off)
    expect(z).toBeLessThan(-0.3) // swept from the +X inlet toward the −Z outlet (carried around the arc)
    expect(Math.hypot(x, z)).toBeGreaterThan(0.7) // kept roughly its radius (a true arc carry, not a slide to centre)
  })

  it('a FUNCTION-geometry curved conveyor (arc handle, like the built-in SDK curve) builds an arc deck + conveys', () => {
    // Regression for the SDK CurvedBeltConveyor: a `function` + conveys part whose sweep param declares an `arc`
    // handle. Its collision deck must be the chord+stub arc facets (curvedDeckSubs), not the flat box the generic
    // conveying-function path would place at the origin, which would leave the visible arc with no body (cargo
    // falls through) and nothing to convey. The behavior drives the arc field via setArcSurfaceVelocity.
    clearPackages()
    const curvedFn = `
definePart({
  params: {
    innerRadius: { type: 'number', default: 0.5 },
    width: { type: 'number', default: 1.524 },
    sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
    speed: { type: 'number', default: 2 },
  },
  geometry(g) { return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], [[0, 0, 0], [1, 0, 0]]) },
  step(ctx) {
    var rc = ctx.params.innerRadius + ctx.params.width / 2
    ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: ctx.params.speed / rc })
  },
})
`
    const pkg = buildPackage({ id: 'oip.curve-fn', name: 'Curve Fn', conveyor: { bed: 'arc', surface: 'roller' }, geometry: { kind: 'drawn', conveys: true, bounds: { length: 2.274, width: 2.274, top: 0.5 } } }, curvedFn)
    expect(validatePartPackage(pkg)).toEqual([])
    const rc = 0.5 + 1.524 / 2 // centreline radius ≈ 1.262 (the inlet is at local +X, on the arc centreline)
    const res = validateScene({ version: SCENE_VERSION, packages: [pkg], parts: [{ id: 'cp_1', type: 'part', packageId: 'oip.curve-fn', position: [0, 1, 0], rotationY: 0, params: {} }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(rc, 1.2, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box at the +X inlet, on the arc deck
    for (let i = 0; i < 75; i++) w.step() // ~1.25 s - sweeps part-way around the quarter turn
    const f = w.frame()
    const [x, y, z] = [f.positions[0] ?? 0, f.positions[1] ?? 0, f.positions[2] ?? 0]
    w.dispose()
    expect(y).toBeGreaterThan(0.9) // rode the arc bed at deck height (the arc facets exist - didn't fall through)
    expect(z).toBeLessThan(-0.3) // carried from the +X inlet toward the −Z outlet (arc surface velocity)
    expect(Math.hypot(x, z)).toBeGreaterThan(0.7) // kept roughly its radius (a true arc carry, not a slide to centre)
  })

  it('a spur conveyor carries cargo +X on its sheared (parallelogram) strip bed (C-convey)', () => {
    clearPackages()
    // a sheared deck: conveying strips X-offset by tan(30°)·z across the width (the parallelogram splay)
    const TAN = Math.tan((30 * Math.PI) / 180)
    const W = 1, N = 10, THIN = 0.06
    const links: { name: string; shape: { kind: 'box'; size: [number, number, number] }; offset: [number, number, number]; conveys: true }[] = []
    for (let i = 0; i < N; i++) {
      const z = -W / 2 + (i + 0.5) * (W / N)
      links.push({ name: `strip${i}`, shape: { kind: 'box', size: [2, THIN, (W / N) * 1.4] }, offset: [TAN * z, -THIN / 2, z], conveys: true })
    }
    const spur = buildPackage(
      { id: 'acme.spur', name: 'Spur', geometry: { kind: 'rig', links, joints: [], bounds: { length: 2.6, width: 1, top: 0.1 } } },
      "definePart({ params:{ speed:{ type:'number', default:1.5 } }, step(ctx){ ctx.setSurfaceVelocity({ x: ctx.forward.x*ctx.params.speed, y:0, z: ctx.forward.z*ctx.params.speed }) } })",
    )
    const res = validateScene({ version: SCENE_VERSION, packages: [spur], parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.spur', position: [0, 1, 0], rotationY: 0, params: {} }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(-0.6, 1.2, 0.2, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box on the sheared bed (off-centre in z)
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 45; i++) w.step()
    const f = w.frame()
    const x1 = f.positions[0] ?? 0
    const y1 = f.positions[1] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // carried +X along the belt flow (the sheared strips still convey)
    expect(y1).toBeGreaterThan(0.9) // rode the bed (the overlapping strips form a continuous support surface)
  })

  it('a chain transfer switches the conveying direction on pop-up (through +X vs divert +Z)', () => {
    const chain = (raised: boolean): [number, number] => {
      clearPackages()
      const tt = buildPackage(
        {
          id: 'acme.chain',
          name: 'Chain',
          geometry: {
            kind: 'rig',
            links: [
              { name: 'deck', shape: { kind: 'box', size: [2, 0.06, 1.6] }, offset: [0, -0.03, 0], conveys: true },
              { name: 'chainBank', shape: { kind: 'frame' }, offset: [0, 0, 0] },
              { name: 'chain', parent: 'chainBank', shape: { kind: 'box', size: [2, 0.05, 0.05] }, offset: [0, -0.08, 0], collision: 'none', array: { count: 'chains', step: [0, 0, 0.33], centered: true } },
            ],
            joints: [{ name: 'lift', link: 'chainBank', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.12 }],
            bounds: { length: 2, width: 1.6, top: 0.2 },
          },
        },
        // through (lowered) → forward +X (the main line); raised → divert +Z (perpendicular, off the side)
        "definePart({ joints:['lift'], params:{ chains:{ type:'number', default:5 }, raised:{ type:'boolean', default:false } }, step(ctx){ const f=ctx.forward; if(ctx.params.raised){ ctx.setSurfaceVelocity({x:f.z*2,y:0,z:-f.x*2}); ctx.joints.lift=0.12 } else { ctx.setSurfaceVelocity({x:f.x*2,y:0,z:f.z*2}); ctx.joints.lift=0 } } })",
      )
      const res = validateScene({ version: SCENE_VERSION, packages: [tt], parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.chain', position: [0, 1, 0], rotationY: 0, params: { raised } }] })
      expect(res.ok).toBe(true)
      const w = new SimWorld(Jolt, res.ok ? res.scene : { version: SCENE_VERSION, parts: [] })
      w.spawnBoxAt(0, 1.2, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box centred on the deck
      const [x0, z0] = [w.frame().positions[0] ?? 0, w.frame().positions[2] ?? 0]
      for (let i = 0; i < 45; i++) w.step()
      const dx = (w.frame().positions[0] ?? 0) - x0
      const dz = (w.frame().positions[2] ?? 0) - z0
      w.dispose()
      return [dx, dz]
    }
    const [thruDx, thruDz] = chain(false) // through: should move along X (forward), not Z
    const [divDx, divDz] = chain(true) // divert: should move along Z (perpendicular), not X
    expect(Math.abs(thruDx)).toBeGreaterThan(0.3) // through conveys along forward (+X)
    expect(Math.abs(thruDz)).toBeLessThan(0.15) // not along Z
    expect(Math.abs(divDz)).toBeGreaterThan(0.3) // pop-up diverts perpendicular (−Z)
    expect(Math.abs(divDx)).toBeLessThan(0.15) // not along X
  })

  it('a turntable deck rotates and friction-carries cargo around (redirect, no new capability)', () => {
    clearPackages()
    const tt = buildPackage(
      {
        id: 'acme.tt',
        name: 'Turntable',
        geometry: {
          kind: 'rig',
          // a flat deck disc (top at the part origin) on a revolute Y joint - the kinematic friction-carry surface
          links: [{ name: 'deck', shape: { kind: 'cylinder', radius: 1, height: 0.1 }, offset: [0, -0.05, 0] }],
          joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -7, max: 7 }],
          bounds: { length: 2, width: 2, top: 0.1 },
        },
      },
      "definePart({ joints:['rotate'], step(ctx){ ctx.joints.rotate = Math.min(ctx.simTime * 1.5, 1.5) } })", // slew ~86° then hold
    )
    const res = validateScene({ version: SCENE_VERSION, packages: [tt], parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.tt', position: [0, 1, 0], rotationY: 0, params: {} }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0.5, 1.2, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box on the deck at radius 0.5 on +X
    for (let i = 0; i < 60; i++) w.step() // ~1 s → the deck turns ~1.5 rad
    const f = w.frame()
    const [x, y, z] = [f.positions[0] ?? 0, f.positions[1] ?? 0, f.positions[2] ?? 0]
    w.dispose()
    expect(y).toBeGreaterThan(1.0) // stayed on the deck (carried, not flung off)
    expect(Math.abs(z)).toBeGreaterThan(0.2) // swung off the +X axis toward −Z → carried around by the deck
    expect(Math.hypot(x, z)).toBeGreaterThan(0.35) // kept roughly its radius (a true arc carry, not a slide to centre)
  })

  it('a turntable lane conveys only when settled, along the deck\'s current yaw (rotate → align → convey)', () => {
    // The committed turntable (examples/parts/turntable-conveyor) layers a hidden `conveys` lane box over the
    // kinematic disc: the disc top sits 1 cm below the lane so the static lane owns the cargo contact. While the
    // deck slews the behavior spins cargo with the platter via the arc field (the linear velocity held at 0 -
    // hold-until-aligned); once settled it conveys along the deck's current forward, a world-space
    // velocity recomputed from the deck angle (the conveys body itself never rotates). This drives the same
    // structure end-to-end through Jolt: slew 90°, then convey - the box must swing around first, then run −Z.
    clearPackages()
    const tt = buildPackage(
      {
        id: 'acme.tt2',
        name: 'Turntable2',
        geometry: {
          kind: 'rig',
          links: [
            // disc top at −0.01 (below the lane surface, mirroring the committed part's layering)
            { name: 'deck', shape: { kind: 'cylinder', radius: 1, height: 0.1 }, offset: [0, -0.06, 0] },
            { name: 'lane', shape: { kind: 'box', size: [1.5, 0.06, 1.5] }, offset: [0, -0.03, 0], conveys: true, hidden: true },
          ],
          joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }],
          bounds: { length: 2, width: 2, top: 0.1 },
        },
      },
      // slew to +90° at 90°/s (arc-spinning the lane), then settle and convey −Z (= part +X rotated by +90°)
      "let angle = 0; definePart({ joints:['rotate'], params:{ speed:{ type:'number', default:1 } }, step(ctx){ const HALF = Math.PI/2; if (angle < HALF) { angle = Math.min(HALF, angle + HALF*ctx.dt); ctx.joints.rotate = angle; ctx.setArcSurfaceVelocity({ center:{ x:ctx.position.x, z:ctx.position.z }, omega: HALF }) } else { ctx.joints.rotate = angle; ctx.setSurfaceVelocity({ x: 0, y: 0, z: -ctx.params.speed }) } } })",
    )
    const res = validateScene({ version: SCENE_VERSION, packages: [tt], parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.tt2', position: [0, 1, 0], rotationY: 0, params: {} }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0.5, 1.2, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box on the lane at radius 0.5 on +X
    for (let i = 0; i < 60; i++) w.step() // ~1 s - the full 90° slew
    const f1 = w.frame()
    const [x1, , z1] = [f1.positions[0] ?? 0, f1.positions[1] ?? 0, f1.positions[2] ?? 0]
    // during the slew the box was carried around (arc), not conveyed off: it swung toward −Z keeping its radius
    expect(x1).toBeLessThan(0.4) // left the +X axis (a linear +X convey would have pushed it past 0.5)
    expect(z1).toBeLessThan(-0.25) // swung toward −Z with the deck
    expect(Math.hypot(x1, z1)).toBeGreaterThan(0.3) // kept roughly its radius (spun, not slid to centre)
    expect(Math.hypot(x1, z1)).toBeLessThan(0.7) // …and wasn't conveyed outward either
    for (let i = 0; i < 45; i++) w.step() // settled: the lane now conveys along the rotated forward (−Z)
    const f2 = w.frame()
    const [x2, y2, z2] = [f2.positions[0] ?? 0, f2.positions[1] ?? 0, f2.positions[2] ?? 0]
    w.dispose()
    expect(z2).toBeLessThan(z1 - 0.25) // conveyed onward along −Z once aligned
    expect(Math.abs(x2)).toBeLessThan(0.3) // not along X - the convey direction tracked the deck's 90° yaw
    expect(y2).toBeGreaterThan(0.9) // still riding the bed
  })

  it('an array-link rack builds N shelf bodies; cargo rests on a shelf, not the floor', () => {
    clearPackages()
    const rack = buildPackage(
      {
        id: 'acme.rack',
        name: 'Rack',
        geometry: {
          kind: 'rig',
          // 3 shelves stacked 1.6 m apart (array-links count form); each a 2×0.04×1 slab cargo rests on
          links: [{ name: 'shelf', shape: { kind: 'box', size: [2, 0.04, 1] }, offset: [0, 1.6, 0], array: { count: 'shelves', step: [0, 1.6, 0] } }],
          joints: [],
          bounds: { length: 2, width: 1, top: 5 },
        },
      },
      "definePart({ params:{ shelves:{ type:'number', default:3 } }, step(){} })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [rack],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.rack', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 2.4, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // dropped between shelf 0 (y 1.6) and shelf 1 (3.2)
    for (let i = 0; i < 120; i++) w.step()
    const y = w.frame().positions[1] ?? 0
    w.dispose()
    expect(y).toBeGreaterThan(1.6) // came to rest on the middle shelf (top ≈ 1.62 + box half), not the floor (0)
  })

  it('a platform deck (C-paramgeo) holds cargo at its elevated surface', () => {
    clearPackages()
    const platform = buildPackage(
      {
        id: 'acme.plat',
        name: 'Platform',
        geometry: {
          kind: 'rig',
          // a 4×4 deck whose top is at the part origin (offset −0.05 + half 0.05); cargo rests on it
          links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.1, 4], sizeParams: [{ axis: 0, param: 'length' }, { axis: 2, param: 'width' }] }, offset: [0, -0.05, 0] }],
          joints: [],
          bounds: { length: 4, width: 4, top: 1 },
        },
      },
      "definePart({ params:{ length:{ type:'number', default:4 }, width:{ type:'number', default:4 } }, step(){} })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [platform],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.plat', position: [0, 2, 0], rotationY: 0, params: {} }], // deck top at y=2
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 3.5, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // dropped above the elevated deck
    for (let i = 0; i < 120; i++) w.step()
    const y = w.frame().positions[1] ?? 0
    w.dispose()
    expect(y).toBeGreaterThan(1.9) // came to rest on the deck (top ≈ 2 + box half), not the floor
  })

  it('a pallet spawner (C-spawn kind) emits real pallet cargo, not boxes', () => {
    clearPackages()
    const spawner = buildPackage(
      { id: 'acme.pal', name: 'PalletSpawner', geometry: { kind: 'rig', links: [{ name: 'hopper', shape: { kind: 'box', size: [1.2, 0.2, 0.9] }, offset: [0, 1, 0] }], joints: [], bounds: { length: 1.2, width: 0.9, top: 1.1 } } },
      "let t=0; definePart({ step(ctx){ t+=ctx.dt; if(t>=0.1){ t-=0.1; ctx.spawn({ kind:'pallet', offset:[0,-0.5,0] }) } } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [spawner],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.pal', position: [0, 2, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    for (let i = 0; i < 20; i++) w.step()
    const f = w.frame()
    w.dispose()
    expect(f.count).toBeGreaterThanOrEqual(1) // a pallet spawned
    expect(f.kinds[0]).toBe(CARGO_KIND_PALLET) // it's a real pallet kind, not a box
  })

  it('a rig gripper grabs cargo, carries it, and drops it on release (grip/carry)', () => {
    clearPackages()
    const lifter = buildPackage(
      {
        id: 'acme.lifter',
        name: 'Lifter',
        geometry: {
          kind: 'rig',
          links: [{ name: 'gripper', shape: { kind: 'box', size: [0.3, 0.3, 0.3] }, offset: [0, 0.3, 0] }],
          joints: [{ name: 'lift', link: 'gripper', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 3 }],
          bounds: { length: 1, width: 1, top: 3 },
        },
      },
      // grip for the first 1.5 s while lifting at 1 m/s, then release
      'definePart({ step(ctx){ ctx.setGrip("gripper", ctx.simTime < 1.5); ctx.setJoint("lift", ctx.simTime) } })',
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [lifter],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.lifter', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(0, 0.3, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // a box sitting at the gripper
    for (let i = 0; i < 60; i++) w.step() // simTime ~1.0: gripped + lifted ~1 m
    const lifted = w.frame().positions[1] ?? 0
    for (let i = 0; i < 90; i++) w.step() // release at ~1.5 s, then it falls
    const dropped = w.frame().positions[1] ?? 0
    w.dispose()
    expect(lifted).toBeGreaterThan(0.9) // carried up with the gripper (from y≈0.3)
    expect(dropped).toBeLessThan(lifted) // released → fell back down
  })

  // One holder per body (world.ts `holders`): taking cargo out of a gripper transfers it, and the gripper lets go
  // of its whole load. A fork (a 1.2 m plate on a 'lift' joint) with a grab zone deep enough for a 2-box stack.
  // Every script keeps the lift creeping (0.01 m/s): an idle rig parks and stops posing its held cargo, which
  // would hide the conflict, and a driving AGV never parks.
  const fork = (script: string) =>
    buildPackage(
      {
        id: 'acme.fork',
        name: 'Fork',
        geometry: {
          kind: 'rig',
          links: [{ name: 'fork', shape: { kind: 'box', size: [1.2, 0.05, 1.2] }, offset: [0, 0.3, 0], grip: { zone: { size: [1.2, 0.8, 1.2], offset: [0, 0.35, 0] } } }],
          joints: [{ name: 'lift', link: 'fork', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 3 }],
          bounds: { length: 1.2, width: 1.2, top: 3 },
        },
      },
      script,
    )
  const forkWorld = (script: string): SimWorld => {
    clearPackages()
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [fork(script)],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.fork', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    if (!res.ok) throw new Error('fork scene invalid')
    return new SimWorld(Jolt, res.scene)
  }
  const yOf = (w: SimWorld, id: number): number => {
    const f = w.frame()
    return f.positions[f.ids.indexOf(id) * 3 + 1] ?? NaN
  }
  const xOf = (w: SimWorld, id: number): number => {
    const f = w.frame()
    return f.positions[f.ids.indexOf(id) * 3] ?? NaN
  }

  it('the pilot takes the bottom box of a gripped stack: the gripper lets go of the rest, which falls onto the fork', () => {
    // closed from the start and lifted 1 m; the program opens it for 0.1 s at t = 2.5 and closes it again
    const w = forkWorld('definePart({ step(ctx){ ctx.setGrip("fork", !(ctx.simTime > 2.5 && ctx.simTime < 2.6)); ctx.setJoint("lift", ctx.simTime < 1 ? ctx.simTime : ctx.simTime < 3 ? 1 + 0.01 * ctx.simTime : ctx.simTime - 1.97) } })')
    const lower = w.spawnBoxAt(0, 0.475, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // resting on the fork (top 0.325)
    const upper = w.spawnBoxAt(0, 0.775, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1]) // stacked on it
    w.adopt(lower, 'bx_low') // the pilot carries scene parts (a spawner box is promoted first)
    for (let i = 0; i < 90; i++) w.step() // t 1.5: both carried up 1 m in formation
    expect(yOf(w, lower)).toBeCloseTo(1.475, 1)
    expect(yOf(w, upper)).toBeCloseTo(1.775, 1)

    w.holdBody('bx_low', true)
    w.setHoldTarget('bx_low', [1.5, 1.475, 0], 0) // pulled out sideways
    for (let i = 0; i < 54; i++) w.step() // t 2.4, grip still commanded closed
    expect(xOf(w, lower)).toBeGreaterThan(1.3) // the pilot has it - the gripper no longer teleports it back
    const fallen = yOf(w, upper)
    expect(fallen).toBeLessThan(1.6) // not floating over the gap: released to physics...
    expect(fallen).toBeGreaterThan(1.35) // ...and caught by the fork (top 1.325), not the floor
    // the latch: the still-closed, now-empty gripper did not re-grab it where it hung - it fell. Once the
    // program cycles the grip (t 2.5-2.6) it takes the upper box again and carries it up the rising lift.
    for (let i = 0; i < 60; i++) w.step() // t 3.4: lift 1.4
    expect(yOf(w, upper) - fallen).toBeGreaterThan(0.3)
    w.dispose()
  })

  it('a closing gripper does not grab a box the pilot is holding in its reach', () => {
    const w = forkWorld('definePart({ step(ctx){ ctx.setGrip("fork", ctx.simTime > 0.5); ctx.setJoint("lift", 0.01 * ctx.simTime) } })')
    const box = w.spawnBoxAt(0, 0.6, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1])
    w.adopt(box, 'bx1')
    w.holdBody('bx1', true)
    w.setHoldTarget('bx1', [0, 0.6, 0], 0) // held inside the grab zone while the gripper closes
    for (let i = 0; i < 60; i++) w.step()
    w.setHoldTarget('bx1', [1.5, 0.6, 0], 0)
    for (let i = 0; i < 60; i++) w.step()
    expect(xOf(w, box)).toBeGreaterThan(1.3) // still the pilot's: it followed the hold point out
    w.dispose()
  })

  it('pinning a gripped box takes it from the gripper; unpinning an unpinned gripped box leaves it held', () => {
    const w = forkWorld('definePart({ step(ctx){ ctx.setGrip("fork", true); ctx.setJoint("lift", ctx.simTime < 1 ? ctx.simTime : 1 + 0.01 * ctx.simTime) } })')
    const a = w.spawnBoxAt(0, 0.475, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1])
    const b = w.spawnBoxAt(0.4, 0.475, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1])
    w.adopt(a, 'bx_a')
    w.adopt(b, 'bx_b')
    for (let i = 0; i < 30; i++) w.step() // both gripped, rising
    w.freezeBody('bx_b', false) // not pinned: must not turn a gripped body dynamic under the gripper
    for (let i = 0; i < 60; i++) w.step() // t 1.5: lift 1
    expect(yOf(w, b)).toBeCloseTo(1.475, 1) // still carried
    w.freezeBody('bx_a', true) // the gizmo grab / Use pin: takes it out of the gripper
    w.moveBody('bx_a', [2, 1, 0], null)
    for (let i = 0; i < 30; i++) w.step()
    expect(xOf(w, a)).toBeCloseTo(2, 2) // the pin holds it where the drag put it - the gripper no longer teleports it
    expect(yOf(w, a)).toBeCloseTo(1, 2)
    w.dispose()
  })

  it('a mobile part (C-drive) navigates its live root toward a waypoint and its rig body follows', () => {
    clearPackages()
    const agv = buildPackage(
      {
        id: 'acme.agv',
        name: 'AGV',
        geometry: {
          kind: 'rig',
          // a 0.8×0.4×0.5 chassis box (a kinematic collision body) that drives forward as one
          links: [{ name: 'chassis', shape: { kind: 'box', size: [0.8, 0.4, 0.5] }, offset: [0, 0.2, 0] }],
          joints: [],
          bounds: { length: 0.8, width: 0.5, top: 0.4 },
        },
      },
      // drive toward a waypoint at +X 3 m: full speed until within 0.1 m, then stop (open-loop P on heading omitted -
      // the part starts facing +X so it just drives straight). Reads its live pose back via ctx.position.
      "definePart({ params:{ goalX:{ type:'number', default:3 } }, step(ctx){ const dx = ctx.params.goalX - ctx.position.x; ctx.drive(dx > 0.1 ? 1.0 : 0, 0) } })",
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [agv],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.agv', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    // a box parked ahead in the AGV's path - the chassis kinematic body must follow the live root and shove it
    w.spawnBoxAt(1.5, 0.3, 0, 0.15, 0.15, 0.15, 0, 10, [1, 1, 1])
    const startBox = w.frame().positions[0] ?? 0
    let base = w.frame().basePoses?.cp_1
    expect(base).toBeUndefined() // not yet driven (basePose only after the first drive command)
    for (let i = 0; i < 60; i++) w.step() // ~1 s of driving
    base = w.frame().basePoses?.cp_1
    expect(base).toBeDefined()
    expect(base!.pos[0]).toBeGreaterThan(0.5) // the live root advanced +X
    for (let i = 0; i < 300; i++) w.step() // let it reach the goal, drive through the box, + settle
    const f2 = w.frame()
    const finalX = f2.basePoses?.cp_1?.pos[0] ?? 0
    const movedBox = (f2.positions[0] ?? 0) - startBox
    w.dispose()
    expect(movedBox).toBeGreaterThan(0.5) // the chassis body followed the root and shoved the box ahead as it drove through
    expect(finalX).toBeGreaterThan(2.5) // arrived near the waypoint at goalX = 3
    expect(finalX).toBeLessThan(3.3) // and stopped there (didn't overrun unboundedly)
  })

  it('a mesh link with an explicit collision box pushes cargo; a visual-only mesh link gets no body', () => {
    clearPackages()
    const mpush = buildPackage(
      {
        id: 'acme.mpush',
        name: 'MeshPush',
        geometry: {
          kind: 'rig',
          links: [
            // visual-only mesh (no collision) - no body, just decorative
            { name: 'shell', shape: { kind: 'mesh', asset: 'glb' }, offset: [0, 1, 0] },
            // mesh with a collision box - this one collides
            { name: 'pusher', shape: { kind: 'mesh', asset: 'glb' }, collision: { box: [0.4, 0.4, 0.4] }, offset: [0, 0.2, 0] },
          ],
          joints: [{ name: 'ext', link: 'pusher', type: 'prismatic', axis: [1, 0, 0], min: 0, max: 5 }],
          bounds: { length: 5, width: 1, top: 1 },
        },
        assets: [{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }], // dummy: the sim never parses it (collision is the explicit box)
      },
      'definePart({ joints: ["ext"], step(ctx){ ctx.joints.ext = ctx.simTime * 2 } })',
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [mpush],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.mpush', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(1, 0.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 90; i++) w.step()
    const x1 = w.frame().positions[0] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // the collision-boxed mesh link shoved it (the visual-only one was inert)
  })

  it('a setSubPose-driven link pushes cargo (free-form pose drives the kinematic body)', () => {
    clearPackages()
    const sp = buildPackage(
      {
        id: 'acme.sp',
        name: 'SubPusher',
        geometry: {
          kind: 'rig',
          links: [{ name: 'pusher', shape: { kind: 'box', size: [0.4, 0.4, 0.4] }, offset: [0, 0.2, 0] }],
          joints: [], // no joint - driven purely by setSubPose
          bounds: { length: 5, width: 1, top: 0.5 },
        },
      },
      'definePart({ step(ctx){ ctx.setSubPose("pusher", { position: [ctx.simTime * 2, 0.2, 0] }) } })', // slide +X
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [sp],
      parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.sp', position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const w = new SimWorld(Jolt, res.scene)
    w.spawnBoxAt(1, 0.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    const x0 = w.frame().positions[0] ?? 0
    for (let i = 0; i < 90; i++) w.step()
    const x1 = w.frame().positions[0] ?? 0
    w.dispose()
    expect(x1).toBeGreaterThan(x0 + 0.3) // shoved by the free-posed kinematic link
  })

  it('skips a custom part whose package is unresolved - no crash, no conveyance', () => {
    clearPackages()
    // bypass validateScene (which would reject a dangling packageId) to exercise the builder's guard
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [{ id: 'cp_1', type: 'part', packageId: 'ghost', position: [0, 1, 0], rotationY: 0, params: {} } as SdkPart],
    }
    const w = new SimWorld(Jolt, scene)
    w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) w.step()
    const x = w.frame().positions[0] ?? 0
    w.dispose()
    expect(Math.abs(x)).toBeLessThan(0.3) // fell, not conveyed
  })
})
