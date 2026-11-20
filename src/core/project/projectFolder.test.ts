import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../types'
import type { SceneJSON } from '../types'
import { createPart } from '../scene/scene'
import type { PartPackage } from '../parts/partPackage'
import { PROJECT_VERSION, serializeProject, validateProject } from './project'
import type { ProjectJSON, ProjectValidationResult } from './project'
import { AGENT_GUIDE, PROGRAM_FILE, PROJECT_MANIFEST, PROJECT_ROOT_FILES, PROJECT_SUBDIRS, SCENE_FILE, folderFilesToProject, isPartSourceFile, joinProgramFiles, programFileOffset, projectToFolderFiles, unreferencedProjectFiles } from './projectFolder'
import type { PartBaker, ProgramSplitter, ProjectFolderFile } from './projectFolder'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import { assetFileName, bytesToBase64 } from '../parts/partAssets'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Every script file under `dir`, recursively (node_modules has none here). */
function scriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? scriptFiles(resolve(dir, e.name)) : /\.(mjs|cjs|js|ts)$/.test(e.name) ? [resolve(dir, e.name)] : [],
  )
}

function expectValid(res: ProjectValidationResult): ProjectJSON {
  if (!res.ok) throw new Error(`expected valid project: ${res.errors.join('; ')}`)
  return res.project
}

function expectErrors(res: ProjectValidationResult): string[] {
  if (res.ok) throw new Error('expected validation errors')
  return res.errors
}

/** a minimal but real custom-part package (deck geometry, empty params) - mirrors project.test.ts */
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

/** A stand-in for the real baker (sim/validatePart, a layer core tests can't import): reassembles
 *  the package from the folder pair without running the behavior. Field order mirrors samplePackage
 *  so serializeProject output is comparable byte-for-byte. */
const testBaker: PartBaker = (manifestJson, behaviorJs) => {
  const m = JSON.parse(manifestJson) as { id: string; name: string; geometry: PartPackage['geometry'] }
  return { package: { format: PACKAGE_FORMAT, id: m.id, name: m.name, params: {}, behavior: behaviorJs, geometry: m.geometry } }
}

function sampleScene(): SceneJSON {
  return {
    version: SCENE_VERSION,
    // generic scene occupants (group = always-valid, package-free); ids are rc_1/bst_1 for the
    // id-based assertions below
    parts: [createPart('group', 'rc_1', [0, 0, 0]), createPart('group', 'bst_1', [2, 0, 0])],
  }
}

/** a project: a scene with a program + its own snapshot, plus an authored library package */
function sampleProject(): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'Line',
    packages: [samplePackage('acme.authored')],
    scene: { ...sampleScene(), packages: [samplePackage('acme.snapshot')] },
    stProgram: 'PROGRAM Main\nEND_PROGRAM\n',
  }
}

/** where the program goes when nothing splits it: one file (core/project/projectFolder.ts) */
const WHOLE_PROGRAM = 'plc/program.st'

/** a text file of the folder (every file but a part's asset files) */
function file(files: ProjectFolderFile[], path: string): { path: string; contents: string } {
  const f = files.find((x) => x.path === path)
  if (!f) throw new Error(`expected file ${path}; got ${files.map((x) => x.path).join(', ')}`)
  if (typeof f.contents !== 'string') throw new Error(`expected ${path} to be text`)
  return { path: f.path, contents: f.contents }
}

describe('projectToFolderFiles', () => {
  it('spills manifest + scene.json at the root, the program under plc/ + per-part workspace folders, with the manifest referencing them', () => {
    const files = projectToFolderFiles(sampleProject())
    expect(files.map((f) => f.path)).toEqual([
      PROJECT_MANIFEST,
      SCENE_FILE,
      WHOLE_PROGRAM,
      'parts/acme.authored/manifest.json',
      'parts/acme.authored/behavior.js',
      // the agent context file, written last so it can quote the paths above (core/agentGuide.ts)
      AGENT_GUIDE,
    ])
    expect(SCENE_FILE).toBe('scene.json')
    expect(files.some((f) => f.path.startsWith('scenes/') || f.path === PROGRAM_FILE)).toBe(false)
    const manifest = JSON.parse(file(files, PROJECT_MANIFEST).contents)
    expect(manifest).toEqual({ version: PROJECT_VERSION, name: 'Line', packages: ['parts/acme.authored'], scene: 'scene.json', program: [WHOLE_PROGRAM] })
    // the scene file is a plain SceneJSON with its own snapshots embedded (self-containment)
    const scene = JSON.parse(file(files, SCENE_FILE).contents)
    expect(scene.parts.map((p: { id: string }) => p.id)).toEqual(['rc_1', 'bst_1'])
    expect(scene.packages.map((p: { id: string }) => p.id)).toEqual(['acme.snapshot'])
  })

  it('writes no program file, and no manifest ref, for a project without a program', () => {
    const files = projectToFolderFiles({ ...sampleProject(), stProgram: undefined })
    expect(files.some((f) => f.path.startsWith('plc/'))).toBe(false)
    expect(JSON.parse(file(files, PROJECT_MANIFEST).contents)).not.toHaveProperty('program')
  })

  it('spills each part in the parts-workspace format: manifest sans baked fields + verbatim behavior.js', () => {
    const files = projectToFolderFiles(sampleProject())
    const partManifest = JSON.parse(file(files, 'parts/acme.authored/manifest.json').contents)
    expect(partManifest.id).toBe('acme.authored')
    expect(partManifest.geometry).toEqual({ kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } })
    // the behavior-baked fields are not in the manifest: the script is their source of truth
    expect(partManifest.behavior).toBeUndefined()
    expect(partManifest.params).toBeUndefined()
    expect(partManifest.format).toBeUndefined()
    expect(file(files, 'parts/acme.authored/behavior.js').contents).toBe('definePart(() => ({}))')
  })

  it('writes the ST program byte-verbatim (plain text, no JSON wrapping)', () => {
    const files = projectToFolderFiles(sampleProject())
    expect(file(files, WHOLE_PROGRAM).contents).toBe('PROGRAM Main\nEND_PROGRAM\n')
  })

  it('carries the physics step rate in the manifest, and reads it back', () => {
    const files = projectToFolderFiles({ ...sampleProject(), simHz: 120 })
    const manifest = JSON.parse(file(files, PROJECT_MANIFEST).contents)
    expect(manifest.simHz).toBe(120)
    expect(expectValid(folderFilesToProject(files, { bakePart: testBaker })).simHz).toBe(120)
    // the default stays implicit
    const plain = JSON.parse(file(projectToFolderFiles(sampleProject()), PROJECT_MANIFEST).contents)
    expect(plain).not.toHaveProperty('simHz')
  })

  it('sanitizes unsafe test names into safe paths and dedupes the collisions that creates', () => {
    const spec = (name: string) => ({ name, duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] })
    const project: ProjectJSON = { version: PROJECT_VERSION, name: 'P', scene: { version: SCENE_VERSION, parts: [] }, tests: [spec('a/b'), spec('a_b')] }
    const files = projectToFolderFiles(project)
    const manifest = JSON.parse(file(files, PROJECT_MANIFEST).contents)
    expect(manifest.tests).toEqual(['tests/a_b.test.json', 'tests/a_b-2.test.json'])
    // round-trips despite the slug rename: names live in the spec, not the filename
    const back = expectValid(folderFilesToProject(files))
    expect(back.tests?.map((t) => t.name)).toEqual(['a/b', 'a_b'])
  })
})

describe('folderFilesToProject', () => {
  it('round-trips to the same normalized document as the single-file form', () => {
    const project = sampleProject()
    const back = expectValid(folderFilesToProject(projectToFolderFiles(project), { bakePart: testBaker }))
    const normalized = expectValid(validateProject(JSON.parse(serializeProject(project))))
    expect(serializeProject(back)).toBe(serializeProject(normalized))
  })

  it('folder → project → folder is byte-stable', () => {
    const project: ProjectJSON = {
      ...sampleProject(),
      stScanMs: 20,
      stDialect: 'other',
      simHz: 240,
      tests: [{ name: 'boxes arrive', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }],
    }
    const first = projectToFolderFiles(project)
    const res = folderFilesToProject(first, { bakePart: testBaker })
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect(res.splitOff).toBeUndefined()
    expect(projectToFolderFiles(res.project)).toEqual(first)
  })

  it('ignores stray files the manifest does not reference (stale scene left by a rename, notes, …)', () => {
    const files = projectToFolderFiles(sampleProject())
    files.push({ path: 'scenes/old-line.scene.json', contents: 'not even json' })
    files.push({ path: 'parts/retired-part/behavior.js', contents: 'definePart(() => ({}))' })
    files.push({ path: 'README.md', contents: '# notes' })
    expect(folderFilesToProject(files, { bakePart: testBaker }).ok).toBe(true)
  })

  it('accepts Windows-separator paths from a native folder walk', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) => ({ ...f, path: f.path.replace(/\//g, '\\') }))
    expect(folderFilesToProject(files, { bakePart: testBaker }).ok).toBe(true)
  })

  it('reports a missing manifest as "not a project folder"', () => {
    const errs = expectErrors(folderFilesToProject([{ path: SCENE_FILE, contents: '{}' }]))
    expect(errs[0]).toContain('not a project folder')
  })

  it('reports an unparseable manifest', () => {
    const errs = expectErrors(folderFilesToProject([{ path: PROJECT_MANIFEST, contents: '{oops' }]))
    expect(errs[0]).toContain('not valid JSON')
  })

  it('reports a manifest that names no scene', () => {
    const errs = expectErrors(folderFilesToProject([{ path: PROJECT_MANIFEST, contents: JSON.stringify({ version: PROJECT_VERSION, name: 'x' }) }]))
    expect(errs.some((e) => e.includes('names no scene'))).toBe(true)
  })

  it('reports a dangling scene ref with its path', () => {
    const files = projectToFolderFiles(sampleProject()).filter((f) => f.path !== SCENE_FILE)
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.includes('"scene.json"') && e.includes('not found'))).toBe(true)
  })

  it('reports a dangling ST ref and an unparseable scene file', () => {
    const files = projectToFolderFiles(sampleProject())
      .filter((f) => f.path !== WHOLE_PROGRAM)
      .map((f) => (f.path === SCENE_FILE ? { ...f, contents: '{broken' } : f))
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.includes(WHOLE_PROGRAM) && e.includes('not found'))).toBe(true)
    expect(errs.some((e) => e.includes('scene.json') && e.includes('not valid JSON'))).toBe(true)
  })

  it('reports a part folder missing its behavior.js', () => {
    const files = projectToFolderFiles(sampleProject()).filter((f) => f.path !== 'parts/acme.authored/behavior.js')
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.includes('parts/acme.authored/behavior.js') && e.includes('not found'))).toBe(true)
  })

  it('surfaces a baker rejection (a broken script) with the part folder named', () => {
    const rejectingBaker: PartBaker = () => ({ error: '[load] behavior.js: unexpected token' })
    const errs = expectErrors(folderFilesToProject(projectToFolderFiles(sampleProject()), { bakePart: rejectingBaker }))
    expect(errs.some((e) => e.includes('parts/acme.authored') && e.includes('unexpected token'))).toBe(true)
  })

  it('errors clearly when the project has parts but the host provides no baker', () => {
    const errs = expectErrors(folderFilesToProject(projectToFolderFiles(sampleProject())))
    expect(errs.some((e) => e.includes('no part baker'))).toBe(true)
  })

  it('funnels an edited-but-invalid scene through validateProject (a bad part is caught)', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) =>
      f.path === SCENE_FILE ? { ...f, contents: JSON.stringify({ version: SCENE_VERSION, parts: [{ id: 'bad', type: 'nope' }] }) } : f,
    )
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.startsWith('scene:'))).toBe(true)
  })
})

describe('reading a folder written before format 4 (a manifest listing scenes)', () => {
  const spec = (name: string, scene?: string) => ({ name, duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }], ...(scene !== undefined ? { scene } : {}) })
  const sceneFile = (id: string) => JSON.stringify({ version: SCENE_VERSION, parts: [createPart('group', id, [0, 0, 0])] })
  const v3Folder = (over: Record<string, unknown> = {}): ProjectFolderFile[] => [
    {
      path: PROJECT_MANIFEST,
      contents: JSON.stringify({
        version: 3,
        name: 'Plant',
        activeScene: 1,
        scenes: [
          { id: 'line-1', name: 'Line 1', scene: 'scenes/line-1.scene.json', stProgram: 'scenes/line-1.st' },
          { id: 'line-2', name: 'Line 2', scene: 'scenes/line-2.scene.json', stProgram: 'scenes/line-2.st', stScanMs: 20 },
          { id: 'line-3', name: 'Line 3', scene: 'scenes/line-3.scene.json' },
        ],
        packages: ['parts/acme.authored'],
        tests: ['tests/one.test.json', 'tests/any.test.json'],
        ...over,
      }),
    },
    { path: 'scenes/line-1.scene.json', contents: sceneFile('p1') },
    { path: 'scenes/line-1.st', contents: 'PROGRAM One\nEND_PROGRAM\n' },
    { path: 'scenes/line-2.scene.json', contents: sceneFile('p2') },
    { path: 'scenes/line-2.st', contents: 'PROGRAM Two\nEND_PROGRAM\n' },
    { path: 'scenes/line-3.scene.json', contents: sceneFile('p3') },
    { path: 'parts/acme.authored/manifest.json', contents: JSON.stringify(samplePackage('acme.authored')) },
    { path: 'parts/acme.authored/behavior.js', contents: 'definePart(() => ({}))' },
    { path: 'tests/one.test.json', contents: JSON.stringify(spec('one', 'line-1')) },
    { path: 'tests/any.test.json', contents: JSON.stringify(spec('any')) },
  ]

  it('reads through folderFilesToProject and splits: the active scene is the project, the others split off', () => {
    const res = folderFilesToProject(v3Folder(), { bakePart: testBaker })
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect(res.project.version).toBe(PROJECT_VERSION)
    expect(res.project.name).toBe('Plant')
    expect(res.project.scene.parts.map((p) => p.id)).toEqual(['p2'])
    expect(res.project.stProgram).toBe('PROGRAM Two\nEND_PROGRAM\n')
    expect(res.project.stScanMs).toBe(20)
    expect(res.project.tests?.map((t) => t.name)).toEqual(['any'])
    expect(res.splitOff?.map((p) => p.name)).toEqual(['Plant - Line 1', 'Plant - Line 3'])
    expect(res.splitOff![0]!.stProgram).toBe('PROGRAM One\nEND_PROGRAM\n')
    expect(res.splitOff![0]!.tests?.map((t) => t.name)).toEqual(['one'])
    expect(res.splitOff![1]!.scene.parts.map((p) => p.id)).toEqual(['p3'])
    expect(res.project.packages?.map((x) => x.id)).toEqual(['acme.authored'])
    for (const p of res.splitOff!) expect(p.packages).toBeUndefined() // neither split-off scene places it
  })

  it('and the next write of the kept project is the current layout, with no scenes/ files', () => {
    const res = folderFilesToProject(v3Folder(), { bakePart: testBaker })
    if (!res.ok) throw new Error(res.errors.join('; '))
    const files = projectToFolderFiles(res.project)
    expect(files.some((f) => f.path.startsWith('scenes/'))).toBe(false)
    expect(file(files, WHOLE_PROGRAM).contents).toBe('PROGRAM Two\nEND_PROGRAM\n')
    expect(JSON.parse(file(files, PROJECT_MANIFEST).contents)).not.toHaveProperty('scenes')
  })

  it('hands a project-wide rate from when the rate was project-wide to every scene naming none', () => {
    const res = folderFilesToProject(v3Folder({ simHz: 240 }), { bakePart: testBaker })
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect([res.project, ...res.splitOff!].map((p) => p.simHz)).toEqual([240, 240, 240])
  })

  it('reports a dangling scene ref in an older manifest with its path', () => {
    const errs = expectErrors(folderFilesToProject(v3Folder().filter((f) => f.path !== 'scenes/line-3.scene.json'), { bakePart: testBaker }))
    expect(errs.some((e) => e.includes('scenes/line-3.scene.json') && e.includes('not found'))).toBe(true)
  })

  it('a one-scene older folder flattens with no splitOff', () => {
    const files: ProjectFolderFile[] = [
      { path: PROJECT_MANIFEST, contents: JSON.stringify({ version: 3, name: 'Solo', scenes: [{ id: 's', name: 'S', scene: 'scenes/s.scene.json' }] }) },
      { path: 'scenes/s.scene.json', contents: sceneFile('p') },
    ]
    const res = folderFilesToProject(files)
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect(res.splitOff).toBeUndefined()
    expect(res.project.name).toBe('Solo')
    expect(res.project.scene.parts.map((p) => p.id)).toEqual(['p'])
  })
})

describe('project folder - tests', () => {
  const spec = { name: 'boxes arrive', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }
  const gradedProject = (): ProjectJSON => ({ ...sampleProject(), tests: [spec] })

  it('spills each test to its own file, named from the spec, and lists it in the manifest', () => {
    const files = projectToFolderFiles(gradedProject())
    expect(files.find((f) => f.path.startsWith('tests/'))?.path).toBe('tests/boxes_arrive.test.json')
    const manifest = JSON.parse(files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string) as { tests?: string[] }
    expect(manifest.tests).toEqual(['tests/boxes_arrive.test.json'])
  })

  it('round-trips folder → project → folder with the tests intact', () => {
    const once = expectValid(folderFilesToProject(projectToFolderFiles(gradedProject()), { bakePart: testBaker }))
    expect(once.tests).toHaveLength(1)
    expect(once.tests![0]!.name).toBe('boxes arrive')
    const twice = expectValid(folderFilesToProject(projectToFolderFiles(once), { bakePart: testBaker }))
    expect(twice.tests).toEqual(once.tests)
  })

  // the backward-compat claim: every project folder authored before tests joined the document has a
  // tests/ directory the manifest knows nothing about. Loading must ignore it (manifest-driven), so
  // scripts/test-project.mjs still finds those files by its own glob.
  it('ignores test files the manifest does not reference', () => {
    const files = [
      ...projectToFolderFiles(sampleProject()),
      { path: 'tests/legacy.test.json', contents: JSON.stringify(spec) },
    ]
    expect(expectValid(folderFilesToProject(files, { bakePart: testBaker })).tests).toBeUndefined()
  })

  it('reports a dangling test ref against its index', () => {
    const files = projectToFolderFiles(gradedProject()).filter((f) => !f.path.startsWith('tests/'))
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.startsWith('tests[0]'))).toBe(true)
  })

  it('funnels an edited-but-invalid spec through validateProject', () => {
    const files = projectToFolderFiles(gradedProject()).map((f) =>
      f.path.startsWith('tests/') ? { ...f, contents: JSON.stringify({ duration: 0, checks: [] }) } : f,
    )
    const errs = expectErrors(folderFilesToProject(files, { bakePart: testBaker }))
    expect(errs.some((e) => e.startsWith('tests[0]:'))).toBe(true)
  })
})

describe('unreferencedProjectFiles', () => {
  // Loading is manifest-driven, so an unlisted file does nothing. That is deliberate, but it is silent,
  // and the downstream symptom names the wrong cause (an ST program that was never referenced surfaces
  // later as `tag "X" never appeared`, which reads as a typo). This lets a surface say what it ignored.
  // It does not change what loads.
  it('reports nothing for a folder the codec just wrote', () => {
    expect(unreferencedProjectFiles(projectToFolderFiles(sampleProject()))).toEqual([])
  })

  it('reports an ST program left in a format subdirectory but not referenced', () => {
    const files = [...projectToFolderFiles(sampleProject()), { path: 'scenes/line-2.st', contents: 'Run := TRUE;' }]
    expect(unreferencedProjectFiles(files)).toEqual(['scenes/line-2.st'])
  })

  it('reports a program.st at the root that the manifest never names (the commonest silent no-op)', () => {
    const noProgram = { ...sampleProject() }
    delete noProgram.stProgram
    const files = [...projectToFolderFiles(noProgram), { path: PROGRAM_FILE, contents: 'Run := TRUE;' }]
    expect(unreferencedProjectFiles(files)).toEqual([PROGRAM_FILE])
    // and any other root file stays inert by design
    expect(unreferencedProjectFiles([...projectToFolderFiles(noProgram), { path: 'README.md', contents: 'notes' }])).toEqual([])
  })

  it('counts the scene and program files of an older manifest as referenced', () => {
    const files: ProjectFolderFile[] = [
      { path: PROJECT_MANIFEST, contents: JSON.stringify({ version: 3, name: 'x', scenes: [{ id: 'a', scene: 'scenes/a.scene.json', stProgram: 'scenes/a.st' }] }) },
      { path: 'scenes/a.scene.json', contents: '{}' },
      { path: 'scenes/a.st', contents: '' },
      { path: 'scenes/b.st', contents: '' },
    ]
    expect(unreferencedProjectFiles(files)).toEqual(['scenes/b.st'])
  })

  it('reports a test dropped in tests/ that the manifest does not list', () => {
    const files = [...projectToFolderFiles(sampleProject()), { path: 'tests/smoke.test.json', contents: '{}' }]
    expect(unreferencedProjectFiles(files)).toEqual(['tests/smoke.test.json'])
  })

  it('counts a referenced part folder as referenced through both its files', () => {
    // packages[] names a directory; manifest.json + behavior.js under it are the reference
    expect(unreferencedProjectFiles(projectToFolderFiles(sampleProject()))).not.toContain('parts/acme.authored/behavior.js')
  })

  it("does not report a part's build sources, which the app never reads", () => {
    const files = [
      ...projectToFolderFiles(sampleProject()),
      { path: 'parts/acme.authored/part.js', contents: 'definePart({})' },
      { path: 'parts/_shared/legs.js', contents: 'export function legs() {}' },
    ]
    expect(unreferencedProjectFiles(files)).toEqual([])
  })

  it('tells a part folder file the app keeps from a build source', () => {
    expect(isPartSourceFile('parts/belt/manifest.json')).toBe(false)
    expect(isPartSourceFile('parts/belt/behavior.js')).toBe(false)
    expect(isPartSourceFile(`parts/belt/assets/${'a'.repeat(64)}.glb`)).toBe(false)
    expect(isPartSourceFile('parts/belt/part.js')).toBe(true)
    expect(isPartSourceFile('parts/_shared/legs.js')).toBe(true)
    expect(isPartSourceFile('parts/_shared/deep/x.js')).toBe(true)
    expect(isPartSourceFile('scene.json')).toBe(false)
    expect(isPartSourceFile('plc/Main.st')).toBe(false)
  })

  it('leaves root files alone - being inert is what AGENTS.md and a README are for', () => {
    const files = [
      ...projectToFolderFiles(sampleProject()),
      { path: 'README.md', contents: '# notes' },
      { path: 'notes.txt', contents: 'x' },
    ]
    expect(unreferencedProjectFiles(files)).toEqual([])
  })

  it('reports a stale scene left by a rename - the very thing manifest-driven loading protects against', () => {
    const files = [...projectToFolderFiles(sampleProject()), { path: 'scenes/old-line.scene.json', contents: '{}' }]
    // still ignored by the loader (that is the point), but reported as ignored
    expect(unreferencedProjectFiles(files)).toEqual(['scenes/old-line.scene.json'])
    expect(folderFilesToProject(files, { bakePart: testBaker }).ok).toBe(true)
  })

  it('is quiet rather than noisy when the manifest is missing or unparseable', () => {
    expect(unreferencedProjectFiles([{ path: 'scenes/a.scene.json', contents: '{}' }])).toEqual([])
    expect(unreferencedProjectFiles([{ path: PROJECT_MANIFEST, contents: 'not json' }])).toEqual([])
  })

  it('accepts Windows-separator paths from a native folder walk', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) => ({ ...f, path: f.path.split('/').join('\\') }))
    expect(unreferencedProjectFiles(files)).toEqual([])
  })
})

describe('project folder - retired saved assemblies', () => {
  it('reads a folder that still lists them, without opening their files, and says they were left out', () => {
    const files = projectToFolderFiles(sampleProject())
    const at = files.findIndex((f) => f.path === PROJECT_MANIFEST)
    const manifest = JSON.parse(files[at]!.contents as string) as Record<string, unknown>
    // one listed file is present, one is missing: neither may refuse the folder
    files[at] = { path: PROJECT_MANIFEST, contents: JSON.stringify({ ...manifest, assemblies: ['assemblies/cell.assembly.json', 'assemblies/gone.assembly.json'] }) }
    files.push({ path: 'assemblies/cell.assembly.json', contents: '{ not json' })
    const r = folderFilesToProject(files, { bakePart: testBaker })
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.project).not.toHaveProperty('assemblies')
    expect(r.repairs?.some((x) => x.includes('2 saved assemblies were left out'))).toBe(true)
    // and the next write lists none, so the old file is one the format no longer references
    const rewritten = projectToFolderFiles(r.project)
    expect(rewritten.some((f) => f.path.startsWith('assemblies/'))).toBe(false)
    expect(unreferencedProjectFiles([...rewritten, { path: 'assemblies/cell.assembly.json', contents: '{}' }])).toEqual(['assemblies/cell.assembly.json'])
  })

  it('names every format folder in the shell folder reader, so a referenced file is never "not found"', () => {
    // the desktop shell walks the folder itself (plain Node, so it cannot import this module) and keeps its own
    // list of the format's subdirectories and root files; a reader that misses one rejects a valid folder outright.
    // The CLIs read through that same walk (scripts/lib/projectFolderFiles.mjs), and the browser imports these lists.
    const text = readFileSync(resolve(repoRoot, 'apps/desktop/projectFolderIo.cjs'), 'utf8')
    for (const dir of PROJECT_SUBDIRS) expect(text, `the shell walks ${dir}/`).toContain(`'${dir}'`)
    for (const file of PROJECT_ROOT_FILES) expect(text, `the shell reads ${file}`).toContain(`'${file}'`)
    // and the program's files, which its text-extension filter would otherwise skip
    for (const ext of ['.st', '.ld']) expect(text, `the shell reads ${ext} files`).toContain(`'${ext}'`)
  })

  it('keeps one folder walk: no script reads a project folder by a copy of its own', () => {
    // a copy drifts: one that misses a directory or a file extension rejects a valid folder, or silently drops a
    // file. A CLI reads a folder through scripts/lib/projectFolderFiles.mjs
    const copies = scriptFiles(resolve(repoRoot, 'scripts')).filter((path) => /walk\(join\(root, sub\), sub, 1\)/.test(readFileSync(path, 'utf8')))
    expect(copies).toEqual([])
  })
})

describe('the program as files (format 7)', () => {
  // a stand-in for plc/programFiles.ts (core cannot import the engine): one file per blank-line-separated chunk, named
  // by its first word, so a test reads what the codec does with whatever names and order it is handed
  const byChunk: ProgramSplitter = (source) =>
    source
      .split(/\n\s*\n/)
      .filter((c) => c.trim() !== '')
      .map((c) => ({ name: `${c.trim().split(/\s+/)[1] ?? 'program'}.st`, text: `${c.trim()}\n` }))
  const program = 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n\nPROGRAM Main\nEND_PROGRAM\n\nPROGRAM Aux\nEND_PROGRAM\n'

  it('writes each file the splitter names under plc/, and the manifest lists them in the program order', () => {
    const files = projectToFolderFiles({ ...sampleProject(), stProgram: program }, { splitProgram: byChunk })
    const listed = JSON.parse(file(files, PROJECT_MANIFEST).contents).program
    expect(listed).toEqual(['plc/Latch.st', 'plc/Main.st', 'plc/Aux.st'])
    expect(file(files, 'plc/Aux.st').contents).toBe('PROGRAM Aux\nEND_PROGRAM\n')
    expect(unreferencedProjectFiles(files)).toEqual([])
  })

  it('reads the files back in the order the manifest lists them, not the order the folder was walked', () => {
    const files = projectToFolderFiles({ ...sampleProject(), stProgram: program }, { splitProgram: byChunk })
    const back = expectValid(folderFilesToProject([...files].reverse(), { bakePart: testBaker }))
    expect(back.stProgram).toBe(program)
    // and the manifest's order is the program's: reordering the list reorders the program
    const manifest = JSON.parse(file(files, PROJECT_MANIFEST).contents)
    manifest.program = ['plc/Aux.st', 'plc/Main.st', 'plc/Latch.st']
    const swapped = files.map((f) => (f.path === PROJECT_MANIFEST ? { ...f, contents: JSON.stringify(manifest) } : f))
    expect(expectValid(folderFilesToProject(swapped, { bakePart: testBaker })).stProgram).toBe(
      'PROGRAM Aux\nEND_PROGRAM\n\nPROGRAM Main\nEND_PROGRAM\n\nFUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n',
    )
  })

  it('folder -> project -> folder is byte-stable', () => {
    const files = projectToFolderFiles({ ...sampleProject(), stProgram: program }, { splitProgram: byChunk })
    const back = expectValid(folderFilesToProject(files, { bakePart: testBaker }))
    expect(projectToFolderFiles(back, { splitProgram: byChunk })).toEqual(files)
  })

  it('keeps a program in a dialect this build cannot read as one file, byte for byte, splitter or not', () => {
    const files = projectToFolderFiles({ ...sampleProject(), stProgram: program, stDialect: 'other' }, { splitProgram: byChunk })
    expect(files.filter((f) => f.path.startsWith('plc/')).map((f) => f.path)).toEqual([WHOLE_PROGRAM])
    expect(file(files, WHOLE_PROGRAM).contents).toBe(program)
  })

  it('writes one file when the split names files a folder cannot hold apart', () => {
    for (const names of [['Main.st', 'main.st'], ['../escape.st', 'Main.st'], ['Main.txt', 'Aux.st']]) {
      const split: ProgramSplitter = (source) => names.map((name, i) => ({ name, text: i === 0 ? source : '' }))
      const files = projectToFolderFiles({ ...sampleProject(), stProgram: program }, { splitProgram: split })
      expect(files.filter((f) => f.path.startsWith('plc/')).map((f) => f.path), names.join()).toEqual([WHOLE_PROGRAM])
    }
  })

  it('joins one file as it is, and several trimmed, a blank line apart, with a closing newline', () => {
    expect(joinProgramFiles(['  A;\n\n\n'])).toBe('  A;\n\n\n')
    expect(joinProgramFiles(['A;\n\n', '\n', '  B;'])).toBe('A;\n\nB;\n')
    expect(joinProgramFiles([])).toBe('')
  })

  it('finds the file, and the place in it, an offset into the joined program came from', () => {
    const texts = ['\nA;\n', 'BB;\n', '\n\n', '  C;']
    const joined = joinProgramFiles(texts)
    for (const [needle, at] of [['A', 0], ['BB', 1], ['C', 3]] as const) {
      const found = programFileOffset(texts, joined.indexOf(needle))
      expect(found.file, needle).toBe(at)
      expect(texts[at]!.slice(found.offset), needle).toMatch(new RegExp(`^${needle}`))
    }
    expect(programFileOffset(['x := 1;'], 5)).toEqual({ file: 0, offset: 5 })
  })

  it('reads a folder from formats 4-6, whose program is one program.st, and writes the current layout next', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) => {
      if (f.path === WHOLE_PROGRAM) return { path: PROGRAM_FILE, contents: f.contents }
      if (f.path !== PROJECT_MANIFEST) return f
      const m = JSON.parse(f.contents as string)
      delete m.program
      return { path: f.path, contents: JSON.stringify({ ...m, version: 6, stProgram: PROGRAM_FILE }) }
    })
    expect(unreferencedProjectFiles(files)).toEqual([])
    const back = expectValid(folderFilesToProject(files, { bakePart: testBaker }))
    expect(back.stProgram).toBe('PROGRAM Main\nEND_PROGRAM\n')
    const next = projectToFolderFiles(back)
    expect(next.some((f) => f.path === PROGRAM_FILE)).toBe(false)
    expect(JSON.parse(file(next, PROJECT_MANIFEST).contents)).toMatchObject({ version: PROJECT_VERSION, program: [WHOLE_PROGRAM] })
  })

  it('reports a program file written under plc/ that the manifest does not list', () => {
    const files = [...projectToFolderFiles(sampleProject()), { path: 'plc/Latch.st', contents: 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n' }]
    expect(unreferencedProjectFiles(files)).toEqual(['plc/Latch.st'])
  })
})

describe('part asset files (core/parts/partAssets.ts, project format 6)', () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 1, 2, 3])
  const embedded = (): PartPackage => ({ ...samplePackage('acme.modelled'), assets: [{ id: 'body', mime: 'model/gltf-binary', data: bytesToBase64(glb) }] })
  const project = (): ProjectJSON => ({ ...sampleProject(), packages: [embedded()] })
  /** what the baker was handed for the part: the manifest every reader must produce */
  const capture = (): { baker: PartBaker; seen: { assets?: unknown }[] } => {
    const seen: { assets?: unknown }[] = []
    const baker: PartBaker = (manifestJson, behaviorJs) => {
      seen.push(JSON.parse(manifestJson) as { assets?: unknown })
      return testBaker(manifestJson, behaviorJs)
    }
    return { baker, seen }
  }
  const withAssetFiles = (): ProjectFolderFile[] => projectToFolderFiles(project())

  it('the writer moves an embedded asset into a hash-named file the manifest names, and leaves url assets alone', () => {
    const shipped = { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' }
    const files = projectToFolderFiles({ ...sampleProject(), packages: [{ ...embedded(), assets: [...embedded().assets!, shipped] }] })
    const path = `parts/acme.modelled/assets/${assetFileName(glb, 'model/gltf-binary')}`
    expect(files.find((f) => f.path === path)?.contents).toEqual(glb)
    expect(JSON.parse(file(files, 'parts/acme.modelled/manifest.json').contents).assets).toEqual([
      { id: 'body', mime: 'model/gltf-binary', file: path.slice('parts/acme.modelled/'.length) },
      shipped,
    ])
    expect(JSON.parse(file(files, PROJECT_MANIFEST).contents).version).toBe(PROJECT_VERSION)
  })

  it('a folder round trip gives back the same document, byte for byte', () => {
    // testBaker rebuilds a package without its assets; this one keeps them, as the real baker does
    const keepAssets: PartBaker = (manifestJson, behaviorJs) => {
      const built = testBaker(manifestJson, behaviorJs).package as PartPackage
      const { assets } = JSON.parse(manifestJson) as Pick<PartPackage, 'assets'>
      return { package: { ...built, ...(assets ? { assets } : {}) } }
    }
    const original = project()
    const back = expectValid(folderFilesToProject(projectToFolderFiles(original), { bakePart: keepAssets }))
    expect(back.packages).toEqual(original.packages)
    expect(projectToFolderFiles(back)).toEqual(projectToFolderFiles(original))
  })

  it('base64 that would not read back exactly stays embedded, so a round trip never changes a package', () => {
    const odd: PartPackage = { ...samplePackage('acme.odd'), assets: [{ id: 'body', mime: 'model/gltf-binary', data: `${bytesToBase64(glb)}\n` }] }
    const files = projectToFolderFiles({ ...sampleProject(), packages: [odd] })
    expect(files.some((f) => f.path.includes('/assets/'))).toBe(false)
    expect(JSON.parse(file(files, 'parts/acme.odd/manifest.json').contents).assets[0].data).toBe(odd.assets![0]!.data)
  })

  it('a part whose manifest names asset files is baked from exactly the embedded form', () => {
    const files = withAssetFiles()
    expect(files.some((f) => f.path === `parts/acme.modelled/assets/${assetFileName(glb, 'model/gltf-binary')}`)).toBe(true)
    const { baker, seen } = capture()
    expectValid(folderFilesToProject(files, { bakePart: baker }))
    expect(seen[0]!.assets).toEqual(embedded().assets)
    // the asset file is the part's own, not an unreferenced stray
    expect(unreferencedProjectFiles(files)).toEqual([])
  })

  it('a missing or altered asset file fails the open, naming the part and the file', () => {
    const files = withAssetFiles()
    const asset = files.findIndex((f) => f.path.includes('/assets/'))
    const altered = [...files]
    altered[asset] = { path: files[asset]!.path, contents: new Uint8Array([0]) }
    expect(expectErrors(folderFilesToProject(altered, { bakePart: testBaker })).join('\n')).toMatch(/parts\/acme\.modelled.*does not match its contents/)
    const missing = files.filter((_, i) => i !== asset)
    expect(expectErrors(folderFilesToProject(missing, { bakePart: testBaker })).join('\n')).toMatch(/parts\/acme\.modelled.*not found in the part folder/)
  })

  it('a text file where the codec needs text is required to be text', () => {
    const files = projectToFolderFiles(project()).map((f) => (f.path === SCENE_FILE ? { path: f.path, contents: new Uint8Array([123]) } : f))
    expect(expectErrors(folderFilesToProject(files, { bakePart: testBaker })).join('\n')).toMatch(/is not a text file/)
  })
})
