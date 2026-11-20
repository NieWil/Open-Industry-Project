import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerPackage, setBuiltInPackages, unregisterPackage } from '../parts/partRegistry'
import { partFingerprint } from '../parts/partOrigin'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../types'
import type { SceneJSON } from '../types'
import { createPart } from '../scene/scene'
import type { PartPackage } from '../parts/partPackage'
import {
  PROJECT_VERSION,
  emptyProject,
  missingLibraryCopies,
  projectToScene,
  sceneToProject,
  serializeProject,
  splitOffName,
  trimForExport,
  unusedLibraryParts,
  validateProject,
} from './project'
import type { ProjectJSON, ProjectValidationResult } from './project'
import { PACKAGE_FORMAT } from '../parts/partPackage'

function expectValid(res: ProjectValidationResult): ProjectJSON {
  if (!res.ok) throw new Error(`expected valid project: ${res.errors.join('; ')}`)
  return res.project
}

function expectOk(res: ProjectValidationResult): Extract<ProjectValidationResult, { ok: true }> {
  if (!res.ok) throw new Error(`expected valid project: ${res.errors.join('; ')}`)
  return res
}

function expectErrors(res: ProjectValidationResult): string[] {
  if (res.ok) throw new Error('expected validation errors')
  return res.errors
}

/** a minimal but real custom-part package (deck geometry, empty params) */
function samplePackage(id = 'acme.widget'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Widget',
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
}

function sampleScene(): SceneJSON {
  return {
    version: SCENE_VERSION,
    // generic scene occupants (group = always-valid, package-free); ids are rc_1/bst_1 for the
    // id-based assertions below
    parts: [createPart('group', 'rc_1', [0, 0, 0]), createPart('group', 'bst_1', [2, 0, 0])],
  }
}

/** a format-4 project around one scene */
function machine(over: Partial<ProjectJSON> = {}): ProjectJSON {
  return { version: PROJECT_VERSION, name: 'P', scene: sampleScene(), ...over }
}

describe('project container', () => {
  it('wraps a standalone scene into a project, the scene keeping its snapshots', () => {
    const scene: SceneJSON = { ...sampleScene(), packages: [samplePackage()] }
    const project = sceneToProject(scene, 'PROGRAM Main\nEND_PROGRAM', 'Factory A')
    expect(project.version).toBe(PROJECT_VERSION)
    expect(project.name).toBe('Factory A')
    // the scene's embedded packages are placement snapshots and stay on the scene. The project
    // library is authored parts only (hoisting a snapshot would adopt it as authoritative on load
    // and freeze the part at its placement-day content)
    expect(project.packages).toBeUndefined()
    expect(project.scene.packages).toHaveLength(1)
    expect(project.stProgram).toContain('PROGRAM Main')
  })

  it('round-trips through serialize + validate', () => {
    const project = sceneToProject({ ...sampleScene(), packages: [samplePackage()] }, 'PROGRAM P\nEND_PROGRAM')
    const text = serializeProject(project)
    const back = expectValid(validateProject(JSON.parse(text)))
    expect(back.packages).toBeUndefined()
    expect(back.scene.packages?.map((p) => p.id)).toEqual(['acme.widget'])
    expect(back.scene.parts.map((p) => p.id)).toEqual(['rc_1', 'bst_1'])
    expect(back.stProgram).toContain('PROGRAM P')
  })

  it('serializes to stable, human-readable JSON with a trailing newline', () => {
    const text = serializeProject(emptyProject('Demo'))
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text)
    expect(parsed.version).toBe(PROJECT_VERSION)
    expect(parsed.name).toBe('Demo')
    expect(parsed.scene.parts).toEqual([])
    expect(parsed).not.toHaveProperty('scenes')
    expect(parsed).not.toHaveProperty('activeScene')
  })

  it('stores the library once, at the top, not on the scene', () => {
    const project = machine({ name: 'One Line', packages: [samplePackage()], scene: { version: SCENE_VERSION, parts: [createPart('group', 'rc_1', [0, 0, 0])] } })
    const text = serializeProject(project)
    const back = expectValid(validateProject(JSON.parse(text)))
    expect(back.packages).toHaveLength(1)
    expect(JSON.parse(text).scene.packages).toBeUndefined()
  })

  it('projects the scene (with library injected) for the store seam', () => {
    const project = machine({ packages: [samplePackage()], stProgram: 'PROGRAM X\nEND_PROGRAM' })
    const { scene, stProgram } = projectToScene(project)
    expect(scene.parts.map((p) => p.id)).toEqual(['rc_1', 'bst_1'])
    expect(scene.packages).toHaveLength(1) // library re-injected so custom parts resolve
    expect(stProgram).toContain('PROGRAM X')
  })

  it('emptyProject is valid and has one empty scene', () => {
    const back = expectValid(validateProject(JSON.parse(serializeProject(emptyProject()))))
    expect(back.scene.parts).toEqual([])
  })

  it('keeps the physics step rate through serialize + validate, with or without a program', () => {
    for (const [over, hz] of [
      [{ stProgram: 'PROGRAM P\nEND_PROGRAM', simHz: 240 }, 240],
      [{ simHz: 120 }, 120], // a machine with no program still has a rate
      [{}, undefined],
    ] as const) {
      const doc = JSON.parse(serializeProject(machine(over as Partial<ProjectJSON>)))
      const back = expectValid(validateProject(doc))
      expect(back.simHz).toBe(hz)
      expect(projectToScene(back).simHz).toBe(hz ?? DEFAULT_SIM_HZ)
      // the default stays implicit, so a document from before the field is byte-identical to a 60 Hz one
      if (hz === undefined) expect(doc).not.toHaveProperty('simHz')
    }
  })

  it('hands a project-wide rate from an older document to every scene that names none', () => {
    const res = expectOk(
      validateProject({
        version: 3,
        name: 'Old',
        activeScene: 0,
        simHz: 240,
        scenes: [
          { id: 'a', name: 'A', scene: sampleScene() },
          { id: 'b', name: 'B', scene: sampleScene(), simHz: 500 },
        ],
      }),
    )
    expect(res.project.simHz).toBe(240)
    expect(res.splitOff?.map((p) => p.simHz)).toEqual([500])
  })

  it('clamps a rate out of range instead of rejecting the document', () => {
    const rate = (simHz: unknown): number | undefined => {
      const raw = JSON.parse(serializeProject(emptyProject()))
      raw.simHz = simHz
      return expectValid(validateProject(raw)).simHz
    }
    expect(rate(97)).toBe(97) // any whole rate in range is a rate
    expect(rate(5000)).toBe(1000)
    expect(rate(30)).toBeUndefined() // clamps up to the floor, which is the default, which stays implicit
    expect(rate('fast')).toBeUndefined()
  })
})

describe('project validation', () => {
  it('rejects a non-object', () => {
    expect(expectErrors(validateProject(42))).toContain('project must be a JSON object')
    expect(expectErrors(validateProject([]))).toContain('project must be a JSON object')
  })

  it('rejects a wrong version, and says when it is a newer one', () => {
    expect(expectErrors(validateProject({ version: 'x', scene: { version: SCENE_VERSION, parts: [] }, name: 'x' }))).toContain(`version must be ${PROJECT_VERSION}`)
    expect(expectErrors(validateProject({ version: 99, scene: { version: SCENE_VERSION, parts: [] }, name: 'x' }))[0]).toContain('saved by a newer version of the app (project format 99')
  })

  it('accepts a v1 doc, marking it migrated and copying referenced library packages onto each scene (no built-ins declared)', () => {
    const pkg = samplePackage()
    const res = expectOk(
      validateProject({
        version: 1,
        name: 'Old',
        activeScene: 0,
        packages: [pkg, samplePackage('acme.unplaced')],
        scenes: [
          {
            id: 's1',
            name: 'S1',
            scene: {
              version: SCENE_VERSION,
              parts: [{ id: 'cp_1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0 }],
            },
          },
          { id: 's2', name: 'S2', scene: { version: SCENE_VERSION, parts: [] } },
        ],
      }),
    )
    expect(res.migratedFromV1).toBe(true)
    // the scene that references the package embeds it (a host that declared no built-ins keeps copies, see
    // keepDefinitionsOnce). The empty scene, split off as its own project, embeds nothing
    expect(res.project.scene.packages?.map((p) => p.id)).toEqual([pkg.id])
    expect(res.splitOff).toHaveLength(1)
    expect(res.splitOff![0]!.name).toBe('Old - S2')
    expect(res.splitOff![0]!.scene.packages).toBeUndefined()
    // the (un-splittable) v1 library passes through to every project. The editor boot filters bundled ids from it
    expect(res.project.packages?.map((p) => p.id).sort()).toEqual(['acme.unplaced', 'acme.widget'])
    expect(res.splitOff![0]!.packages).toBeUndefined() // S2 places no library part, so it carries none
  })

  it("a v2 doc keeps the scene's own packages and does not mark migration", () => {
    const res = expectOk(
      validateProject({
        version: 2,
        name: 'New',
        activeScene: 0,
        scenes: [
          {
            id: 's1',
            name: 'S1',
            scene: {
              version: SCENE_VERSION,
              parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.widget', position: [0, 0, 0], rotationY: 0 }],
              packages: [samplePackage()],
            },
          },
        ],
      }),
    )
    expect(res.migratedFromV1).toBeUndefined()
    expect(res.splitOff).toBeUndefined()
    expect(res.project.version).toBe(PROJECT_VERSION)
    expect(res.project.name).toBe('New')
    expect(res.project.scene.packages?.map((p) => p.id)).toEqual(['acme.widget'])
    expect(res.project.packages).toBeUndefined()
  })

  it('rejects an older document with an empty scene list', () => {
    expect(expectErrors(validateProject({ version: 3, name: 'x', scenes: [] }))).toContain('scenes must be a non-empty array')
  })

  it('rejects duplicate scene ids in an older document', () => {
    const errs = expectErrors(
      validateProject({
        version: 3,
        name: 'x',
        scenes: [
          { id: 'dup', name: 'A', scene: { version: SCENE_VERSION, parts: [] } },
          { id: 'dup', name: 'B', scene: { version: SCENE_VERSION, parts: [] } },
        ],
      }),
    )
    expect(errs.some((e) => e.includes('duplicate'))).toBe(true)
  })

  it('opens the first scene of an older document whose activeScene is out of range', () => {
    const res = expectOk(
      validateProject({
        version: 3,
        name: 'x',
        activeScene: 7,
        scenes: [
          { id: 's1', name: 'S1', scene: sampleScene() },
          { id: 's2', name: 'S2', scene: { version: SCENE_VERSION, parts: [] } },
        ],
      }),
    )
    expect(res.project.scene.parts.map((p) => p.id)).toEqual(['rc_1', 'bst_1'])
    expect(res.splitOff?.map((p) => p.name)).toEqual(['x - S2'])
    expect(res.repairs).toContain('activeScene 7 is not a scene index (0 to 1), so the first scene opens')
  })

  it('propagates a part error with scene context', () => {
    const errs = expectErrors(validateProject({ version: PROJECT_VERSION, name: 'x', scene: { version: SCENE_VERSION, parts: [{ id: 'bad', type: 'nope' }] } }))
    expect(errs.some((e) => e.startsWith('scene:'))).toBe(true)
    const old = expectErrors(
      validateProject({ version: 3, name: 'x', scenes: [{ id: 's1', name: 'S1', scene: { version: SCENE_VERSION, parts: [{ id: 'bad', type: 'nope' }] } }] }),
    )
    expect(old.some((e) => e.startsWith('scenes[0] (S1):'))).toBe(true)
  })

  it('rejects a custom part whose package is not in the library', () => {
    const errs = expectErrors(
      validateProject({
        version: PROJECT_VERSION,
        name: 'x',
        // no packages at the project level, but the scene references a custom part
        scene: {
          version: SCENE_VERSION,
          parts: [{ id: 'cp_1', type: 'part', packageId: 'missing.pkg', position: [0, 0, 0], rotationY: 0 }],
        },
      }),
    )
    expect(errs.some((e) => e.includes('packageId'))).toBe(true)
  })
})

describe('reading an older multi-scene document: it splits', () => {
  const lib = [samplePackage('acme.widget'), samplePackage('acme.gadget')]
  const assemblies = [{ id: 'cell', name: 'Cell', parts: [createPart('group', 'g1', [0, 0, 0])] }]
  const spec = (name: string, scene?: string) => ({ name, duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }], ...(scene !== undefined ? { scene } : {}) })
  const three = (tests: unknown[] = []) => ({
    version: 3,
    name: 'Plant',
    activeScene: 1,
    packages: lib,
    assemblies,
    scenes: [
      {
        id: 'a',
        name: 'Line A',
        // Line A places one library part (acme.gadget); the others place none
        scene: {
          version: SCENE_VERSION,
          parts: [createPart('group', 'pa', [0, 0, 0]), { id: 'pg', type: 'part', packageId: 'acme.gadget', position: [1, 0, 0], rotationY: 0 }],
        },
        stProgram: 'PROGRAM A\nEND_PROGRAM',
      },
      { id: 'b', name: 'Line B', scene: { version: SCENE_VERSION, parts: [createPart('group', 'pb', [0, 0, 0])] }, stProgram: 'PROGRAM B\nEND_PROGRAM', simHz: 240 },
      { id: 'c', name: 'Line C', scene: { version: SCENE_VERSION, parts: [createPart('group', 'pc', [0, 0, 0])] } },
    ],
    ...(tests.length > 0 ? { tests } : {}),
  })

  it('the active scene becomes the project under its name; the others split off in order', () => {
    const res = expectOk(validateProject(three()))
    expect(res.project.version).toBe(PROJECT_VERSION)
    expect(res.project.name).toBe('Plant')
    expect(res.project.scene.parts.map((p) => p.id)).toEqual(['pb'])
    expect(res.project.stProgram).toContain('PROGRAM B')
    expect(res.project.simHz).toBe(240)
    expect(res.splitOff?.map((p) => p.name)).toEqual([splitOffName('Plant', 'Line A'), splitOffName('Plant', 'Line C')])
    expect(res.splitOff?.map((p) => p.name)).toEqual(['Plant - Line A', 'Plant - Line C'])
    expect(res.splitOff![0]!.scene.parts.map((p) => p.id)).toEqual(['pa', 'pg'])
    expect(res.splitOff![0]!.stProgram).toContain('PROGRAM A')
    expect(res.splitOff![1]!.scene.parts.map((p) => p.id)).toEqual(['pc'])
    expect(res.splitOff![1]!.stProgram).toBeUndefined()
    expect(res.repairs?.some((r) => r.includes('the project held 3 scenes'))).toBe(true)
  })

  // The project is the library's home and keeps it whole; a split-off project carries only what its own scene places,
  // so a part one scene never used does not travel with that scene's files and exports.
  it('the project keeps the whole library; a split-off one only the library parts it places', () => {
    const res = expectOk(validateProject(three()))
    expect(res.project.packages?.map((x) => x.id)).toEqual(['acme.widget', 'acme.gadget'])
    // the document's saved assemblies are retired: left out of every project, and the repairs say so
    expect(res.project).not.toHaveProperty('assemblies')
    expect(res.repairs?.some((r) => r.includes('1 saved assembly was left out'))).toBe(true)
    const [a, c] = res.splitOff!
    expect(a!.packages?.map((x) => x.id)).toEqual(['acme.gadget'])
    expect(c!.packages).toBeUndefined()
    for (const p of res.splitOff!) {
      expect(p.version).toBe(PROJECT_VERSION)
      expect(p).not.toHaveProperty('assemblies')
      // and what is kept still reads back whole
      expectOk(validateProject(p))
    }
  })

  it('tests go with the scene they named, and a test naming none stays with the kept project', () => {
    const res = expectOk(validateProject(three([spec('t-a', 'a'), spec('t-none'), spec('t-b', 'b'), spec('t-c', 'c')])))
    expect(res.project.tests?.map((t) => t.name)).toEqual(['t-none', 't-b'])
    expect(res.splitOff![0]!.tests?.map((t) => t.name)).toEqual(['t-a'])
    expect(res.splitOff![1]!.tests?.map((t) => t.name)).toEqual(['t-c'])
    // the routing field does not survive into a format-4 spec
    for (const p of [res.project, ...res.splitOff!]) for (const t of p.tests ?? []) expect(t).not.toHaveProperty('scene')
  })

  it('a test naming a scene the document does not have is still an error', () => {
    const errs = expectErrors(validateProject(three([spec('t', 'nope')])))
    expect(errs.some((e) => e.includes('tests[0].scene "nope"'))).toBe(true)
  })

  it('a one-scene older document flattens with no splitOff', () => {
    const res = expectOk(
      validateProject({ version: 3, name: 'Solo', activeScene: 0, scenes: [{ id: 's', name: 'Only', scene: sampleScene(), stProgram: 'PROGRAM S\nEND_PROGRAM' }] }),
    )
    expect(res.splitOff).toBeUndefined()
    expect(res.repairs).toBeUndefined()
    expect(res.project).toEqual({ version: PROJECT_VERSION, name: 'Solo', scene: { version: SCENE_VERSION, parts: sampleScene().parts }, stProgram: 'PROGRAM S\nEND_PROGRAM' })
  })
})

describe('format 4 round trip', () => {
  it('serializeProject -> validateProject gives back the same project, and the same text', () => {
    const project = machine({
      name: 'Line',
      packages: [samplePackage()],
      stProgram: 'PROGRAM P\nEND_PROGRAM',
      stScanMs: 20,
      stDialect: 'other',
      simHz: 240,
      tests: [{ name: 't', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }],
    })
    const text = serializeProject(project)
    const res = expectOk(validateProject(JSON.parse(text)))
    expect(res.splitOff).toBeUndefined()
    expect(res.repairs).toBeUndefined()
    expect(serializeProject(res.project)).toBe(text)
    expect(res.project.name).toBe('Line')
    expect(res.project.stScanMs).toBe(20)
    expect(res.project.stDialect).toBe('other')
    expect(res.project.simHz).toBe(240)
  })

  it('a format-4 test naming a scene gets a repair note and loses the field', () => {
    const raw = JSON.parse(serializeProject(machine()))
    raw.tests = [{ name: 't', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }], scene: 'whatever' }]
    const res = expectOk(validateProject(raw))
    expect(res.repairs).toContain('tests[0].scene is ignored: a project has one scene')
    expect(res.project.tests).toHaveLength(1)
    expect(res.project.tests![0]).not.toHaveProperty('scene')
  })
})

describe('project tests (the document carrying its own pass/fail criteria)', () => {
  /** a raw format-4 document, ready to have `tests` attached */
  const docWith = (tests: unknown): unknown => ({
    version: PROJECT_VERSION,
    name: 'Graded',
    scene: { version: SCENE_VERSION, parts: [] },
    tests,
  })

  const spec = { name: 'boxes arrive', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }

  it('validates tests and round-trips them through serializeProject', () => {
    const project = expectValid(validateProject(docWith([spec])))
    expect(project.tests).toHaveLength(1)
    expect(project.tests![0]!.name).toBe('boxes arrive')
    const back = expectValid(validateProject(JSON.parse(serializeProject(project))))
    expect(back.tests).toEqual(project.tests)
  })

  // the additive claim: a document that carries no tests must serialize with no `tests` key at all
  it('omits the key entirely when a project has no tests', () => {
    const project = expectValid(validateProject(docWith(undefined)))
    expect(project.tests).toBeUndefined()
    expect(JSON.parse(serializeProject(project))).not.toHaveProperty('tests')
  })

  it('reports an invalid spec against its index', () => {
    const errs = expectErrors(validateProject(docWith([spec, { duration: 0, checks: [] }])))
    expect(errs.some((e) => e.startsWith('tests[1]:'))).toBe(true)
  })

  it('rejects a non-array tests field', () => {
    expect(expectErrors(validateProject(docWith({}))).some((e) => e === 'tests must be an array')).toBe(true)
  })
})

describe('project validation repairs', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    version: PROJECT_VERSION,
    name: 'P',
    scene: sampleScene(),
    ...over,
  })
  const repairsOf = (data: unknown): string[] => {
    const r = validateProject(data)
    return r.ok ? (r.repairs ?? []) : [`invalid: ${r.errors.join('; ')}`]
  }

  it('is silent for a document loading exactly as written', () => {
    expect(repairsOf(doc({ simHz: 120 }))).toEqual([])
  })

  it("reports the machine's own clamps", () => {
    expect(repairsOf(doc({ simHz: 30 }))).toEqual(['scene.simHz 30 is not a whole number from 60 to 1000, so it steps at 60 Hz'])
  })

  it("reports an older document's project-wide clamps", () => {
    expect(repairsOf({ version: 3, name: 'P', activeScene: 3, simHz: 30, scenes: [{ id: 's1', name: 'Main', scene: sampleScene() }] })).toEqual([
      'simHz 30 is not a whole number from 60 to 1000, so its scenes step at 60 Hz',
      'activeScene 3 is not a scene index (0 to 0), so the first scene opens',
    ])
  })

  it("carries the scene's repairs up, located", () => {
    const withParent = sampleScene()
    withParent.parts[0] = { ...withParent.parts[0]!, parent: 'gone' }
    expect(repairsOf(doc({ scene: withParent }))).toEqual(['scene.parts[0].parent "gone" names no part, so it is dropped'])
    expect(repairsOf({ version: 3, name: 'P', scenes: [{ id: 's1', name: 'Main', scene: withParent }] })).toEqual([
      'scenes[0] (Main).parts[0].parent "gone" names no part, so it is dropped',
    ])
  })
})

describe('a scene\'s unit system survives every save path (SceneJSON.units)', () => {
  const metric: SceneJSON = { version: SCENE_VERSION, parts: [], units: 'metric' }
  it('scene -> project -> file -> project -> scene', () => {
    const project = sceneToProject(metric)
    expect(project.scene.units).toBe('metric')
    const back = validateProject(JSON.parse(serializeProject(project)))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.project.scene.units).toBe('metric')
    expect(projectToScene(back.project).scene.units).toBe('metric')
  })
  it('an imperial scene (absent) stays absent, and a bad value is dropped with a repair', () => {
    const project = sceneToProject({ version: SCENE_VERSION, parts: [] })
    expect('units' in project.scene).toBe(false)
    const raw = JSON.parse(serializeProject(project)) as { scene: Record<string, unknown> }
    raw.scene.units = 'cubits'
    const back = validateProject(raw)
    expect(back.ok && back.project.scene.units).toBe(undefined)
  })
})

describe('every part the project uses is its own copy (format 5, docs/part-sources.md)', () => {
  // the app declares its built-ins (partRegistry setBuiltInPackages); a project keeps its own copy of each it uses
  const builtIn = samplePackage('oip.thing')
  const custom = samplePackage('acme.only-in-a-scene')
  // what an older build saved alongside a placed built-in: a snapshot of that build's version, not a project's own
  const stale: PartPackage = { ...builtIn, name: 'Thing (as an older build had it)' }
  const placed = (id: string, packageId: string) => ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0 })
  const stamped = (pkg: PartPackage | undefined) => pkg?.origin?.app
  beforeEach(() => setBuiltInPackages([builtIn]))
  afterEach(() => setBuiltInPackages([]))

  const v2 = () => ({
    version: 2,
    name: 'Old',
    activeScene: 0,
    scenes: [
      { id: 's1', name: 'S1', scene: { version: SCENE_VERSION, parts: [placed('p1', builtIn.id), placed('p2', custom.id)], packages: [stale, custom] } },
      { id: 's2', name: 'S2', scene: { version: SCENE_VERSION, parts: [placed('p3', custom.id)], packages: [custom] } },
    ],
  })

  it('reads a format-2 document: a built-in snapshot gives way to the app\'s current version, copied in and stamped', () => {
    const res = expectOk(validateProject(v2()))
    expect(res.project.version).toBe(PROJECT_VERSION)
    expect(res.project.scene.packages).toBeUndefined()
    expect(res.project.packages?.map((x) => x.id)).toEqual([custom.id, builtIn.id])
    const copy = res.project.packages?.find((x) => x.id === builtIn.id)
    expect(copy?.name).toBe(builtIn.name) // the current built-in, never the snapshot
    expect(stamped(copy)).toBe(partFingerprint(builtIn))
    expect(res.splitOff).toHaveLength(1)
    expect(res.splitOff![0]!.scene.packages).toBeUndefined()
    expect(res.splitOff![0]!.packages?.map((x) => x.id)).toEqual([custom.id]) // it places only the custom part
  })

  it('a format-4 document is completed on read: a built-in it names by id becomes the project\'s own copy', () => {
    const p = expectValid(validateProject({ version: 4, name: 'x', scene: { version: SCENE_VERSION, parts: [placed('p', builtIn.id)] } }))
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.packages?.map((x) => x.id)).toEqual([builtIn.id])
    expect(stamped(p.packages?.[0])).toBe(partFingerprint(builtIn))
  })

  it('writes no scene copies, every definition once in the library, and reads back the same', () => {
    const text = serializeProject(expectValid(validateProject(v2())))
    const doc = JSON.parse(text)
    expect(doc.version).toBe(PROJECT_VERSION)
    expect(doc.scene.packages).toBeUndefined()
    expect(doc.packages.map((x: { id: string }) => x.id)).toEqual([custom.id, builtIn.id])
    const back = expectValid(validateProject(doc))
    expect(back.scene.parts.map((x) => x.id)).toEqual(['p1', 'p2'])
    expect(back.packages?.map((x) => x.id)).toEqual([custom.id, builtIn.id])
  })

  it('keeps the project\'s copy when the app has moved on: it is never replaced by the newer built-in', () => {
    const p = expectValid(validateProject(v2()))
    setBuiltInPackages([{ ...builtIn, name: 'Thing v2' }])
    const back = expectValid(validateProject(JSON.parse(serializeProject(p))))
    const copy = back.packages?.find((x) => x.id === builtIn.id)
    expect(copy?.name).toBe(builtIn.name)
    expect(stamped(copy)).toBe(partFingerprint(builtIn))
  })

  it('a built-in placed in a scene resolves against the app, and one the app does not have is refused by name', () => {
    expectValid(validateProject({ version: PROJECT_VERSION, name: 'x', scene: { version: SCENE_VERSION, parts: [placed('p', builtIn.id)] } }))
    expectValid(validateProject({ version: 3, name: 'x', scenes: [{ id: 's', name: 'S', scene: { version: SCENE_VERSION, parts: [placed('p', builtIn.id)] } }] }))
    const errs = expectErrors(validateProject({ version: PROJECT_VERSION, name: 'x', scene: { version: SCENE_VERSION, parts: [placed('p', 'oip.gone')] } }))
    expect(errs[0]).toContain('"oip.gone" is neither in the project\'s part library nor a built-in part of this app')
  })

  it('a standalone scene taken out of a project carries its copies again', () => {
    const p = expectValid(validateProject(v2()))
    expect(projectToScene(p).scene.packages?.map((x) => x.id).sort()).toEqual([custom.id, builtIn.id].sort())
  })

  it('a scene file made into a project: its copies join the library, a built-in snapshot gives way to the app\'s', () => {
    const p = sceneToProject({ version: SCENE_VERSION, parts: [placed('p1', builtIn.id), placed('p2', custom.id)] as SceneJSON['parts'], packages: [stale, custom] })
    expect(p.scene.packages).toBeUndefined()
    expect(p.packages?.map((x) => x.id)).toEqual([custom.id, builtIn.id])
    expect(p.packages?.find((x) => x.id === builtIn.id)?.name).toBe(builtIn.name)
  })

  it('a scene file from another project brings that project\'s OWN version of a built-in with it', () => {
    const theirs: PartPackage = { ...builtIn, name: 'Their thing', origin: { app: partFingerprint(builtIn) } }
    const p = sceneToProject({ version: SCENE_VERSION, parts: [placed('p1', builtIn.id)] as SceneJSON['parts'], packages: [theirs] })
    expect(p.packages?.map((x) => x.name)).toEqual(['Their thing'])
  })

  it('reads a v1 document: the copies v1 migration puts on a scene go again, the library keeps the part', () => {
    const p = expectValid(validateProject({ version: 1, name: 'Old', activeScene: 0, packages: [custom], scenes: [{ id: 's1', name: 'S1', scene: { version: SCENE_VERSION, parts: [placed('p2', custom.id)] } }] }))
    expect(p.scene.packages).toBeUndefined()
    expect(p.packages?.map((x) => x.id)).toEqual([custom.id])
  })

  it('reads past an older document\'s saved assemblies (retired), even a broken one, and says so', () => {
    const doc = { ...v2(), assemblies: [{ id: 'cell', name: 'Cell', parts: [placed('a1', builtIn.id)], packages: [stale] }, { parts: 'not a list' }] }
    const r = validateProject(doc)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.project).not.toHaveProperty('assemblies')
    expect(r.repairs).toContain('2 saved assemblies were left out: saved assemblies are retired (placed copies stay)')
    expect(JSON.parse(serializeProject(r.project))).not.toHaveProperty('assemblies')
  })

  it('the parts a part names come with it: a unit load brings its pallet and cases', () => {
    const pallet = samplePackage('oip.pallet')
    const box = samplePackage('oip.box')
    const load: PartPackage = { ...samplePackage('oip.unit-load'), unit: {} }
    setBuiltInPackages([load, pallet, box])
    const missing = missingLibraryCopies([], [[placed('u', load.id) as unknown as SceneJSON['parts'][number]]])
    expect(missing.map((x) => x.id).sort()).toEqual([box.id, pallet.id, load.id])
    // declared pieces are what it names, and a copy the project already has is kept
    const declared: PartPackage = { ...load, unit: { pieces: { pallet: pallet.id, case: 'acme.carton' } } }
    expect(missingLibraryCopies([declared], [[placed('u', load.id) as unknown as SceneJSON['parts'][number]]]).map((x) => x.id)).toEqual([pallet.id])
  })

  it('a project\'s copy is what runs, so its parts\' params are checked against it, not against the app\'s newer version', () => {
    const v1: PartPackage = { ...builtIn, params: { speed: { type: 'number', default: 1, min: 0, max: 5 } } }
    const v2pkg: PartPackage = { ...builtIn, params: { speed: { type: 'number', default: 1, min: 0, max: 2 } } }
    registerPackage(v2pkg, true) // the app's newer version, live in the registry
    try {
      const doc = { version: PROJECT_VERSION, name: 'x', packages: [{ ...v1, origin: { app: partFingerprint(v1) } }], scene: { version: SCENE_VERSION, parts: [{ ...placed('p', builtIn.id), params: { speed: 4 } }] } }
      const p = expectValid(validateProject(doc))
      expect((p.scene.parts[0] as { params: Record<string, unknown> }).params.speed).toBe(4)
    } finally {
      unregisterPackage(builtIn.id)
    }
  })

  it('a spawner brings the product it makes: its default, and whatever an instance sets instead', () => {
    const box = samplePackage('oip.box')
    const tote = samplePackage('oip.tote')
    const spawner: PartPackage = { ...samplePackage('oip.box-spawner'), params: { product: { type: 'string', product: true, default: box.id } } }
    setBuiltInPackages([spawner, box, tote])
    const at = (params: Record<string, unknown>) => [[{ ...placed('s', spawner.id), params } as unknown as SceneJSON['parts'][number]]]
    expect(missingLibraryCopies([], at({})).map((x) => x.id).sort()).toEqual([box.id, spawner.id])
    // set to totes it needs the tote too; the default stays a dependency of the part, so the box comes along
    expect(missingLibraryCopies([], at({ product: tote.id })).map((x) => x.id).sort()).toEqual([box.id, spawner.id, tote.id])
  })

  it('a host that declared no built-ins changes nothing: it cannot tell a built-in from a definition only the scene has', () => {
    setBuiltInPackages([])
    const p = expectValid(validateProject(v2()))
    expect(p.scene.packages?.map((x) => x.id)).toEqual([builtIn.id, custom.id])
    expect(p.packages).toBeUndefined()
  })
})

describe('a format-4 document is its scene', () => {
  it('refuses one with no scene, rather than open it as an empty project', () => {
    const r = validateProject({ version: 4, name: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toContain('scene must be an object')
    expect(validateProject({ version: 4, name: 'x', scene: [] }).ok).toBe(false)
  })
})

describe('what Export Project may leave out (unusedLibraryParts, trimForExport)', () => {
  const placedOf = (id: string, pkg: string) => ({ id, type: 'part', packageId: pkg, position: [0, 0, 0], rotationY: 0, params: {} }) as unknown as SceneJSON['parts'][number]
  const spec = (name: string) => ({ name, duration: 1, checks: [{ always: true, tag: 'Never', equals: false }] })
  // the scene places a widget; nothing uses the gadget or the spare
  const full = (): ProjectJSON => ({
    version: PROJECT_VERSION,
    name: 'Line',
    scene: { version: SCENE_VERSION, parts: [placedOf('p1', 'acme.widget')] },
    packages: [samplePackage('acme.widget'), samplePackage('acme.gadget'), samplePackage('acme.spare')],
    tests: [spec('runs')] as ProjectJSON['tests'],
  })

  it('a part the scene does not place is unused', () => {
    expect(unusedLibraryParts(full()).map((p) => p.id)).toEqual(['acme.gadget', 'acme.spare'])
  })

  it('leaving nothing out is the whole project', () => {
    expect(trimForExport(full(), {})).toEqual(full())
  })

  it('leaves out what it is told, and nothing the file still needs', () => {
    const noParts = trimForExport(full(), { unusedParts: true })
    expect(noParts.packages?.map((p) => p.id)).toEqual(['acme.widget'])
    expect(noParts.tests).toHaveLength(1)
    const bare = trimForExport(full(), { unusedParts: true, tests: true })
    expect(bare.packages?.map((p) => p.id)).toEqual(['acme.widget'])
    expect(bare.tests).toBeUndefined()
    expect(validateProject(bare).ok).toBe(true) // and what is left still opens
  })

  it('a part named by a placed part (a spawner’s product) is used', () => {
    const spawner = { ...samplePackage('acme.widget'), params: { product: { type: 'string', default: 'acme.gadget', product: true } } } as unknown as PartPackage
    const project = { ...full(), packages: [spawner, samplePackage('acme.gadget'), samplePackage('acme.spare')] }
    expect(unusedLibraryParts(project).map((p) => p.id)).toEqual(['acme.spare'])
  })

  it('leaves the project it was given untouched', () => {
    const project = full()
    trimForExport(project, { unusedParts: true, tests: true })
    expect(project).toEqual(full())
  })
})
