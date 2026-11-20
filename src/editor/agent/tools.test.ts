import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TOOLS, agentResultText, agentToolDefinitions, callAgentTool, type AgentController, type AgentToolContext } from './tools'
import { EditorStore } from '../store/store'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import { buildPackage } from '../../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from '../parts/bundledExamples'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { defaultController } from '../../plc'

// the in-app test runner loads jolt-physics/wasm, which the node env cannot resolve: run_test's plumbing is what is
// tested here, and verify-agent-mcp-electron.mjs runs a real spec through the real runner
const runProjectTests = vi.fn()
vi.mock('../project/projectTestsRun', () => ({ runProjectTests: (...a: unknown[]) => runProjectTests(...a) }))

const BELT: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'agent.belt',
  name: 'Agent Belt', commsParam: 'enableComms', conveyor: { surface: 'roller', speedParam: 'speed' },
  category: 'Conveyors',
  params: {
    speed: { type: 'number', default: 0.5, min: 0, max: 3, label: 'Speed', unit: 'm/s' },
    standHeight: { type: 'number', default: 2, min: 0, rest: 'surfaceBelow' },
    enableComms: { type: 'boolean', default: false },
    runTag: { type: 'tag', default: '', dir: 'in', stType: 'BOOL' },
    mode: { type: 'enum', default: 'a', options: [{ value: 'a' }, { value: 'b' }] },
    secret: { type: 'number', default: 1, hidden: true },
  },
  behavior: 'definePart({ step() {} })',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 0.8] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 0.8, top: 0.05, bottom: -0.1 } },
}

function ctx(controller: AgentController | null = null): AgentToolContext {
  const store = new EditorStore()
  store.setBundledPackages([BELT])
  return { store, controller }
}

async function ok(c: AgentToolContext, name: string, args: unknown = {}): Promise<unknown> {
  const r = await callAgentTool(c, name, args)
  if (!r.ok) throw new Error(`${name} refused: ${r.error}`)
  return r.value
}

async function refused(c: AgentToolContext, name: string, args: unknown = {}): Promise<string> {
  const r = await callAgentTool(c, name, args)
  if (r.ok) throw new Error(`${name} was expected to refuse`)
  return r.error
}

beforeEach(() => registerPackage(BELT))
afterEach(() => {
  unregisterPackage(BELT.id)
  runProjectTests.mockReset()
})

describe('agent tools: a definition session on screen', () => {
  it('closes first, so a tool reads (and authors) the document, not the session’s throwaway scene', async () => {
    const c = ctx()
    const s0 = c.store.getState().scene
    c.store.loadScene({ ...s0, parts: [{ id: 'belt_1', type: 'part', packageId: BELT.id, position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart] }, { persist: false })
    expect(c.store.enterPackageEdit(BELT.id)).toBe(true)
    const value = (await ok(c, 'get_scene')) as { parts: { id: string }[] }
    expect(c.store.getState().packageEdit).toBeNull()
    expect(value.parts.map((p) => p.id)).toEqual(['belt_1'])
  })
})

describe('agent tools: the list', () => {
  it('every tool has a unique name, a description and an object input schema', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const d of agentToolDefinitions()) {
      expect(d.name).toMatch(/^[a-z_]+$/)
      expect(d.description.length).toBeGreaterThan(20)
      expect(d.inputSchema.type).toBe('object')
    }
  })

  it('an unknown tool and non-object arguments come back as errors, never a throw', async () => {
    const c = ctx()
    expect(await refused(c, 'no_such_tool')).toMatch(/no tool/)
    expect(await refused(c, 'get_scene', [1, 2])).toMatch(/must be an object/)
  })
})

describe('agent tools: authoring is ordinary editing', () => {
  it('add_part floors a legged stand at 0.1, like every other rest path', async () => {
    const c = ctx()
    const { id } = (await ok(c, 'add_part', { package: 'agent.belt', position: [3, 0.04, 0] })) as { id: string }
    expect((c.store.getState().scene.parts.find((p) => p.id === id) as SdkPart).params.standHeight).toBe(0.1)
  })

  it('add_part places the part, embeds its package, and is one labelled undo step', async () => {
    const c = ctx()
    const { id } = (await ok(c, 'add_part', { package: 'agent.belt', position: [1, 0.8, 0], name: 'Infeed', params: { speed: 1.2, runTag: 'Run' } })) as { id: string }
    const s = c.store.getState()
    const part = s.scene.parts.find((p) => p.id === id) as SdkPart
    expect(part).toMatchObject({ packageId: 'agent.belt', name: 'Infeed', position: [1, 0.8, 0] })
    expect(part.params).toMatchObject({ speed: 1.2, runTag: 'Run', enableComms: false })
    // a legged stand reaches the floor from the height the part was given
    expect(part.params.standHeight).toBe(0.8)
    expect(s.scene.packages?.map((p) => p.id)).toEqual(['agent.belt'])
    const history = c.store.getEditHistory()
    expect(history.events.at(-1)?.label).toBe('Agent: place Agent Belt')
    c.store.undo()
    expect(c.store.getState().scene.parts).toHaveLength(0)
  })

  it('refuses a param the package does not declare, a wrong type, and a value out of range', async () => {
    const c = ctx()
    const at = { package: 'agent.belt', position: [0, 0.8, 0] }
    expect(await refused(c, 'add_part', { ...at, params: { sped: 1 } })).toMatch(/no param 'sped'.*speed/)
    expect(await refused(c, 'add_part', { ...at, params: { speed: 'fast' } })).toMatch(/is a number/)
    expect(await refused(c, 'add_part', { ...at, params: { speed: 9 } })).toMatch(/<= 3/)
    expect(await refused(c, 'add_part', { ...at, params: { mode: 'c' } })).toMatch(/one of: "a", "b"/)
    expect(await refused(c, 'add_part', { package: 'agent.nope', position: [0, 0, 0] })).toMatch(/no package/)
    expect(await refused(c, 'add_part', { package: 'agent.belt', position: [0, 0] })).toMatch(/\[x, y, z\]/)
    expect(c.store.getState().scene.parts).toHaveLength(0)
  })

  it('update_part moves, re-params and renames through the store', async () => {
    const c = ctx()
    const { id } = (await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0] })) as { id: string }
    await ok(c, 'update_part', { id, position: [2, 0.8, 1], rotationY: Math.PI / 2, params: { runTag: 'Belt1Run' }, name: 'Belt 1' })
    const part = c.store.getState().scene.parts[0] as SdkPart
    expect(part.position).toEqual([2, 0.8, 1])
    expect(part.rotationY).toBeCloseTo(Math.PI / 2)
    expect(part.params.runTag).toBe('Belt1Run')
    expect(part.name).toBe('Belt 1')
    // one call, one agent step: a rename riding a step of its own read as the person's, and undo refused it
    expect(c.store.getEditHistory().events.map((e) => e.label)).toEqual([expect.stringMatching(/^Agent:/), expect.stringMatching(/^Agent:/)])
    await ok(c, 'update_part', { id, name: 'Belt 1' })
    expect(c.store.getEditHistory().events).toHaveLength(2)
    expect(await refused(c, 'update_part', { id: 'ghost' })).toMatch(/no part 'ghost'/)
  })

  it('update_part makes a name unique among siblings, and an empty one clears it', async () => {
    const c = ctx()
    await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0], name: 'Belt' })
    const { id } = (await ok(c, 'add_part', { package: 'agent.belt', position: [3, 0.8, 0] })) as { id: string }
    expect(((await ok(c, 'update_part', { id, name: 'Belt' })) as { name: string }).name).toBe('Belt 2')
    await ok(c, 'update_part', { id, name: '' })
    expect(c.store.getState().scene.parts.find((p) => p.id === id)?.name).toBeUndefined()
  })

  it('places one building, edits its params and dock doors, and lists the doors', async () => {
    const c = ctx()
    const rules = [{ wall: 'dock_door', run: 1, gap: 0, count: 1, start: 10, doorCount: 2, trailer: true }]
    const { id } = (await ok(c, 'add_part', { package: 'building', position: [0, 0, 0], params: { lengthSections: 5, widthSections: 4, rules } })) as { id: string }
    expect(await refused(c, 'add_part', { package: 'building', position: [0, 0, 0] })).toMatch(/already has a building/)
    const read = (await ok(c, 'get_part', { id })) as { dockDoors: { key: string; side: string }[] }
    expect(read.dockDoors.map((d) => `${d.key} ${d.side}`)).toEqual(['10:0 left', '10:1 left'])
    await ok(c, 'update_part', { id, params: { openDoors: ['10:1'] } })
    expect(c.store.getState().scene.parts.find((p) => p.id === id)?.params).toMatchObject({ lengthSections: 5, openDoors: ['10:1'] })
    expect(await refused(c, 'update_part', { id, params: { openDoors: ['2:0'] } })).toMatch(/do not cut/)
    const r = (await ok(c, 'update_part', { id, params: { rules: [] } })) as { notes: string[] }
    expect(r.notes).toEqual(['openDoors: 10:1 dropped, since the wall rules no longer cut that door'])
    expect(c.store.getState().scene.parts.find((p) => p.id === id)?.params).not.toHaveProperty('openDoors')
  })

  it('delete_parts takes a soft-parented child with it, as one step', async () => {
    const c = ctx()
    const { id: a } = (await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0] })) as { id: string }
    const { id: b } = (await ok(c, 'add_part', { package: 'agent.belt', position: [3, 0.8, 0], parent: a })) as { id: string }
    const r = (await ok(c, 'delete_parts', { ids: [a] })) as { deleted: string[] }
    expect(r.deleted.sort()).toEqual([a, b].sort())
    expect(c.store.getState().scene.parts).toHaveLength(0)
    c.store.undo()
    expect(c.store.getState().scene.parts).toHaveLength(2)
  })

  it('get_scene lists each part with its package, pose and wired tags; hidden params stay out of the catalog', async () => {
    const c = ctx()
    await ok(c, 'add_part', { package: 'agent.belt', position: [1.23456, 0.8, 0], params: { runTag: 'Run' } })
    const scene = (await ok(c, 'get_scene')) as { project: string; running: boolean; parts: Record<string, unknown>[] }
    expect(scene.running).toBe(false)
    // a project holds one scene, so the scene is named by its project
    expect(scene.project).toBe(c.store.getState().projectName)
    expect('scene' in scene).toBe(false)
    expect(scene.parts[0]).toMatchObject({ package: 'agent.belt', position: [1.235, 0.8, 0], tags: { runTag: 'Run' } })
    // the list is compact (a real catalog's every param is past what a client takes in one result): its tags only
    const catalog = (await ok(c, 'list_catalog', { query: 'conveyors' })) as Record<string, unknown>[]
    expect(catalog).toEqual([{ id: 'agent.belt', name: 'Agent Belt', category: 'Conveyors', tags: ['runTag (in BOOL)'] }])
    // ...and get_package has the rest
    const pkg = (await ok(c, 'get_package', { id: 'agent.belt' })) as { params: Record<string, Record<string, unknown>> }
    expect(pkg.params.runTag).toMatchObject({ type: 'tag', dir: 'in', stType: 'BOOL' })
    expect(pkg.params.mode).toMatchObject({ options: ['a', 'b'] })
    expect(pkg.params.speed).toMatchObject({ min: 0, max: 3, unit: 'm/s' })
    expect('secret' in pkg.params).toBe(false)
    expect(await refused(c, 'get_package', { id: 'agent.nope' })).toMatch(/no package/)
  })

  it('get_scene caps a large scene, counts it by package, and narrows by package, box and parent', async () => {
    const c = ctx()
    const belts = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, type: 'part', packageId: BELT.id, position: [i, 0, 0], rotationY: 0, params: {}, ...(i < 3 ? { parent: 'g' } : {}) }) as SdkPart)
    const group = { id: 'g', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} }
    c.store.loadScene({ ...c.store.getState().scene, parts: [group, ...belts] as SdkPart[] }, { persist: false })
    type Listed = { parts: { id: string }[]; omitted?: number; byPackage?: Record<string, number>; sceneParts?: number }
    const all = (await ok(c, 'get_scene')) as Listed
    expect(all.parts).toHaveLength(200)
    expect(all.omitted).toBe(51)
    expect(all.byPackage).toEqual({ group: 1, 'agent.belt': 250 })
    const groups = (await ok(c, 'get_scene', { package: 'group' })) as Listed
    expect(groups).toMatchObject({ parts: [{ id: 'g' }], sceneParts: 251 })
    expect('omitted' in groups).toBe(false)
    const boxed = (await ok(c, 'get_scene', { package: BELT.id, within: { min: [9.5, -1, -1], max: [12.5, 1, 1] } })) as Listed
    expect(boxed.parts.map((p) => p.id)).toEqual(['b10', 'b11', 'b12'])
    expect(((await ok(c, 'get_scene', { parent: 'g' })) as Listed).parts.map((p) => p.id)).toEqual(['b0', 'b1', 'b2'])
    expect(await refused(c, 'get_scene', { within: { min: [0, 0, 0] } })).toMatch(/needs min and max/)
  })

  it('a result is indented JSON with each array of plain values on one line', () => {
    const value = { parts: [{ id: 'a', position: [1, 2.5, -3], tags: ['x, y', 'z'] }], empty: [], nested: [[1, 2]], bracketed: ['[z]'] }
    const text = agentResultText(value)
    expect(text).toContain('"position": [1, 2.5, -3]')
    expect(text).toContain('"tags": ["x, y", "z"]')
    // a string holding a bracket keeps its array indented, and every result still parses back to the value
    expect(JSON.parse(text)).toEqual(value)
    expect(agentResultText('as it is')).toBe('as it is')
  })

  it('keeps the whole real catalog listing small enough for one result', async () => {
    const behaviors = bundledBehaviors()
    const store = new EditorStore()
    store.setBundledPackages(bundledManifests().map((m) => buildPackage(m, behaviors.get(m.id)!)))
    const text = JSON.stringify(await ok({ store, controller: null }, 'list_catalog'))
    // guards against a 126k-character listing, which an agent spends most of its run reading back from a file
    expect(text.length).toBeLessThan(20_000)
  })

  it("get_package says what a tag's numbers mean and gives the part's frame", async () => {
    const behaviors = bundledBehaviors()
    const store = new EditorStore()
    store.setBundledPackages(bundledManifests().map((m) => buildPackage(m, behaviors.get(m.id)!)))
    const pkg = (await ok({ store, controller: null }, 'get_package', { id: 'oip.color-sensor' })) as {
      params: Record<string, { values?: unknown }>
      frame?: { footprint?: unknown; origin?: unknown; beams?: unknown[] }
      frameError?: string
    }
    // the colour code a benchmark agent had to find by experiment: 0 is none, any other code a position in `colors`
    expect(pkg.params.colorTag!.values).toEqual([{ value: 0, label: 'none' }])
    expect(pkg.params.colors).toMatchObject({ type: 'color', default: '#ff0000,#00ff00,#0000ff' })
    expect(pkg.frameError).toBeUndefined()
    expect(pkg.frame).toMatchObject({ footprint: expect.anything(), origin: expect.anything() })
    expect(pkg.frame!.beams?.length).toBeGreaterThan(0)
  })

  it('offers the Spawner, not the Pallet Spawner it replaced, which a named lookup still finds', async () => {
    const behaviors = bundledBehaviors()
    const store = new EditorStore()
    store.setBundledPackages(bundledManifests().map((m) => buildPackage(m, behaviors.get(m.id)!)))
    const ids = ((await ok({ store, controller: null }, 'list_catalog')) as { id: string }[]).map((p) => p.id)
    expect(ids).toContain('oip.box-spawner')
    expect(ids).not.toContain('oip.pallet-spawner')
    expect(await ok({ store, controller: null }, 'get_package', { id: 'oip.pallet-spawner' })).toMatchObject({ id: 'oip.pallet-spawner' })
  })

  it('refuses to edit a view-only editor instead of silently dropping the edit', async () => {
    const c = ctx()
    c.store.setReadOnly(true)
    expect(await refused(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0] })).toMatch(/view-only/)
    expect(await refused(c, 'set_program', { source: 'VAR x : BOOL; END_VAR' })).toMatch(/view-only/)
  })
})

describe('agent tools: snap_part seats a part through the real snap engine', () => {
  // real catalog parts, built as the app builds its bundle (snapGolden.test.ts does the same)
  const behaviors = bundledBehaviors()
  const real = bundledManifests()
    .filter((m) => ['oip.belt-conveyor', 'oip.diffuse-sensor', 'oip.box'].includes(m.id))
    .map((m) => buildPackage(m, behaviors.get(m.id)!))
  beforeEach(() => real.forEach((p) => registerPackage(p)))
  afterEach(() => real.forEach((p) => unregisterPackage(p.id)))

  function lineCtx(): AgentToolContext {
    const store = new EditorStore()
    store.setBundledPackages(real)
    return { store, controller: null }
  }

  it('puts a photo eye on the belt guard, fits its range across the belt, as one undo step', async () => {
    const c = lineCtx()
    const belt = ((await ok(c, 'add_part', { package: 'oip.belt-conveyor', position: [0, 0.8, 0], params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8 } })) as { id: string }).id
    const eye = ((await ok(c, 'add_part', { package: 'oip.diffuse-sensor', position: [3, 2, 3] })) as { id: string }).id
    const steps = c.store.getEditHistory().events.length
    const r = (await ok(c, 'snap_part', { id: eye, onto: belt, near: [3, 0.8, -0.5] })) as { onto: string; position: number[]; fits?: Record<string, number> }
    expect(r.onto).toBe(belt)
    // the guard sits 57 mm off a 0.8 m belt's edge, 20 mm below belt height (the mount's yOffset, which keeps the
    // housing under the guard's top return; npm run snap-part reports the same seat)
    expect(r.position[0]).toBeCloseTo(3, 3)
    expect(r.position[1]).toBeCloseTo(0.78, 3)
    expect(r.position[2]).toBeCloseTo(-0.457, 2)
    expect(r.fits?.maxRange).toBeCloseTo(0.84, 2)
    const placed = c.store.getState().scene.parts.find((p) => p.id === eye) as SdkPart
    expect(placed.position[2]).toBeCloseTo(-0.457, 2)
    expect(placed.params.maxRange).toBeCloseTo(0.84, 2)
    expect(c.store.getEditHistory().events.length).toBe(steps + 1)
    expect(c.store.getEditHistory().events.at(-1)?.label).toMatch(/^Agent: snap /)
  })

  it('says why nothing seats, and changes nothing', async () => {
    const c = lineCtx()
    const box = ((await ok(c, 'add_part', { package: 'oip.box', position: [0, 0.15, 0] })) as { id: string }).id
    const eye = ((await ok(c, 'add_part', { package: 'oip.diffuse-sensor', position: [5, 1, 5] })) as { id: string }).id
    const before = c.store.getState().scene
    expect(await refused(c, 'snap_part', { id: eye, onto: box })).toMatch(new RegExp(`nothing on '${box}' engages '${eye}'`))
    expect(await refused(c, 'snap_part', { id: eye, onto: eye })).toMatch(/onto itself/)
    expect(c.store.getState().scene).toBe(before)
  })
})

describe('agent tools: the program', () => {
  it('set_program is one undo step and reports the compile problems at once', async () => {
    const c = ctx()
    const good = 'VAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n'
    expect(((await ok(c, 'set_program', { source: good })) as { problems: unknown[] }).problems).toEqual([])
    expect(((await ok(c, 'get_program')) as { source: string; dialect: string }).source).toBe(good)
    const bad = (await ok(c, 'set_program', { source: 'VAR\n  Run : BOOL;\nEND_VAR\nRun := ;\n' })) as { problems: { severity: string; line?: number }[] }
    expect(bad.problems.some((p) => p.severity === 'error' && p.line === 4)).toBe(true)
    c.store.undo()
    expect(c.store.getState().stProgram).toBe(good)
  })

  it('rename_tag renames the code and moves the wiring with it, as one undo step', async () => {
    const c = ctx()
    const src = 'VAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n'
    await ok(c, 'set_program', { source: src })
    const { id } = (await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0], params: { runTag: 'Run', enableComms: true } })) as { id: string }
    expect(await ok(c, 'rename_tag', { from: 'Run', to: 'BeltRun' })).toEqual({ from: 'Run', to: 'BeltRun', rewiredParts: [id] })
    const s = c.store.getState()
    expect(s.stProgram).toBe(src.replaceAll('Run', 'BeltRun'))
    expect((s.scene.parts[0] as SdkPart).params.runTag).toBe('BeltRun')
    expect(c.store.getEditHistory().events.at(-1)?.label).toBe('Agent: rename Run to BeltRun')
    c.store.undo()
    expect(c.store.getState().stProgram).toBe(src)
    expect((c.store.getState().scene.parts[0] as SdkPart).params.runTag).toBe('Run')
    // a kept test is not renamed: the result says which still name the old tag
    await ok(c, 'save_test', { spec: { name: 'belt runs', duration: 1, checks: [{ tag: 'Run', at: 1, equals: true }] } })
    const r = (await ok(c, 'rename_tag', { from: 'Run', to: 'Go' })) as { warnings?: string[] }
    expect(r.warnings).toEqual([expect.stringMatching(/still name Run .*: belt runs$/)])
    expect(await refused(c, 'rename_tag', { from: 'Nope', to: 'X' })).toMatch(/not a top-level variable/)
    expect(await refused(c, 'rename_tag', { from: 'Run', to: 'IF' })).toMatch(/reserved word/)
  })

  it('rename_tag follows a sole PROGRAM instance wired by bare name', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: 'PROGRAM Main\nVAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\nEND_PROGRAM\n' })
    await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0], params: { runTag: 'Run', enableComms: true } })
    await ok(c, 'rename_tag', { from: 'Run', to: 'Go', pou: 'Main' })
    expect((c.store.getState().scene.parts[0] as SdkPart).params.runTag).toBe('Go')
  })

  it('set_task retimes a task as one undo step and names the tasks when it cannot find one', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: 'VAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n' })
    const before = c.store.getState().stScanMs
    // a program with no task table still lists the one task it runs on, by the name set_task takes
    const task = ((await ok(c, 'get_program')) as { tasks: { name: string }[] }).tasks[0]!.name
    expect(task).toBe(defaultController(c.store.getState().stProgram, before).tasks[0]!.name)
    const r = (await ok(c, 'set_task', { task, intervalMs: before + 7 })) as { scanMs: number; tasks: { intervalMs: number }[] }
    expect(r.tasks[0]?.intervalMs).toBe(before + 7)
    expect(c.store.getEditHistory().events.at(-1)?.label).toMatch(/^Agent: edit task /)
    c.store.undo()
    expect(c.store.getState().stScanMs).toBe(before)
    expect(await refused(c, 'set_task', { task: 'Nope', priority: 1 })).toMatch(/no task 'Nope' \(the tasks are: /)
    expect(await refused(c, 'set_task', { task })).toMatch(/intervalMs/)
  })

  it('assign_io gives wired tags addresses and rewires the parts; get_io_list lists them and assign_io reads it back', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: 'VAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n' })
    await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0], params: { runTag: 'Run', enableComms: true } })
    expect(((await ok(c, 'get_io_list')) as { csv: string }).csv).toMatch(/no part is wired to an I\/O address yet/)
    const r = (await ok(c, 'assign_io')) as { assigned: { name: string; address: string; parts: number }[] }
    expect(r.assigned).toHaveLength(1)
    const { name, address, parts } = r.assigned[0]!
    expect([name, parts]).toEqual(['Run', 1])
    expect(c.store.getState().stProgram).toMatch(new RegExp(`Run AT ${address.replace(/[%.]/g, '\\$&')}`))
    expect((c.store.getState().scene.parts[0] as SdkPart).params.runTag).toBe(address)
    expect(c.store.getEditHistory().events.at(-1)?.label).toBe('Agent: assign I/O')
    const csv = ((await ok(c, 'get_io_list')) as { csv: string }).csv
    expect(csv).toContain(`Run,${address},BOOL`)
    // its own list back changes nothing
    const program = c.store.getState().stProgram
    await ok(c, 'assign_io', { list: csv })
    expect(c.store.getState().stProgram).toBe(program)
  })

  it('get_problems reports wiring the program does not satisfy', async () => {
    const c = ctx()
    await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0], params: { runTag: 'Run', enableComms: true } })
    const r = (await ok(c, 'get_problems')) as { problems: { group: string; subject: string }[] }
    expect(r.problems.some((p) => p.group === 'Wiring' && p.subject === 'Run')).toBe(true)
  })

  it("get_problems carries the run's flow facts as facts, never as problems", async () => {
    const fact = { id: 1, kind: 'dropped', t: 2.5, at: [4, 0, 0], part: 'belt', message: 'box 7 dropped to the floor off belt' }
    const controller = { plcFault: null, sim: { flowFacts: { all: () => [fact] } } } as unknown as AgentController
    const r = (await ok(ctx(controller), 'get_problems')) as { errors: number; warnings: number; flowFacts?: unknown[] }
    expect(r.flowFacts).toEqual([{ kind: 'dropped', t: 2.5, message: fact.message, part: 'belt' }])
    expect([r.errors, r.warnings]).toEqual([0, 0])
    // no run yet: no field at all
    expect('flowFacts' in ((await ok(ctx(), 'get_problems')) as object)).toBe(false)
  })

  it("get_problems carries the folder banner's error and note, outside the counts", async () => {
    const c = ctx()
    expect(Object.keys((await ok(c, 'get_problems')) as object)).not.toContain('folderNote')
    c.store.setFolderLink('Line', 'Lost access to the project folder: gone', 'Ignored 1 file this project does not reference: plc/Latch.st.')
    const r = (await ok(c, 'get_problems')) as { errors: number; warnings: number; folderError?: string; folderNote?: string }
    expect(r.folderError).toMatch(/Lost access/)
    expect(r.folderNote).toContain('plc/Latch.st')
    expect([r.errors, r.warnings]).toEqual([0, 0])
  })
})

describe('agent tools: operating', () => {
  function fakeController(watch: Record<string, number | boolean> | null): AgentController & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      run: () => void calls.push('run'),
      stop: () => void calls.push('stop'),
      get plcWatch() {
        return watch
      },
      writePlcValue: (key: string, text: string) => (watch && key in watch ? (calls.push(`${key}=${text}`), null) : `'${key}' is not a value of the running program`),
      plcFault: null,
    } as unknown as AgentController & { calls: string[] }
  }

  it('run, stop, get_tags and set_tag go to the controller and never write the document', async () => {
    const ctrl = fakeController({ Start: false, Count: 3 })
    const c = ctx(ctrl)
    const before = c.store.getState().scene
    await ok(c, 'run')
    expect(await ok(c, 'get_tags', { names: ['Count', 'Nope'] })).toEqual({ running: true, tags: { Count: 3 }, missing: ['Nope'] })
    await ok(c, 'set_tag', { name: 'Start', value: true })
    expect(await refused(c, 'set_tag', { name: 'Nope', value: 1 })).toMatch(/not a value/)
    await ok(c, 'stop')
    expect(ctrl.calls).toEqual(['run', 'Start=true', 'stop'])
    expect(c.store.getState().scene).toBe(before)
    expect(c.store.getEditHistory().events).toHaveLength(0)
  })

  it('force_tag holds a variable and get_tags reports it; release_forces lets it go; neither writes the document', async () => {
    const forces: Record<string, number | boolean> = {}
    // (defineProperty, not Object.assign: assign would copy the getter's value once)
    const ctrl = Object.defineProperty(fakeController({ Start: false, Count: 3 }), 'plcForces', { get: () => ({ ...forces }) })
    Object.assign(ctrl, {
      forcePlcValue: (key: string, text?: string) => {
        if (!(key in { Start: 0, Count: 0 })) return `'${key}' is not a value of the running program`
        forces[key] = text === undefined ? (key === 'Count' ? 3 : false) : text === 'true' ? true : Number(text)
        return null
      },
      releasePlcForces: (key?: string) => {
        for (const k of Object.keys(forces)) if (key === undefined || k === key) delete forces[k]
      },
    })
    const c = ctx(ctrl)
    const before = c.store.getState().scene
    await ok(c, 'run')
    expect(await ok(c, 'force_tag', { name: 'Start', value: true })).toEqual({ forces: { Start: true } })
    expect(await ok(c, 'force_tag', { name: 'Count' })).toEqual({ forces: { Start: true, Count: 3 } })
    expect(await refused(c, 'force_tag', { name: 'Nope', value: 1 })).toMatch(/not a value/)
    expect(((await ok(c, 'get_tags')) as { forces?: unknown }).forces).toEqual({ Start: true, Count: 3 })
    expect(await ok(c, 'release_forces', { name: 'Start' })).toEqual({ forces: { Count: 3 } })
    expect(await ok(c, 'release_forces')).toEqual({ forces: {} })
    expect('forces' in ((await ok(c, 'get_tags')) as object)).toBe(false)
    expect(c.store.getState().scene).toBe(before)
    expect(c.store.getEditHistory().events).toHaveLength(0)
  })

  it('get_tags without names returns at most 2000 variables and counts the rest', async () => {
    const many = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`V${i}`, i]))
    const c = ctx(fakeController(many))
    const all = (await ok(c, 'get_tags')) as { tags: Record<string, unknown>; tagsOmitted?: number }
    expect(Object.keys(all.tags)).toHaveLength(2000)
    expect(all.tagsOmitted).toBe(500)
    // a name asked for is answered wherever it stands in the table
    expect(await ok(c, 'get_tags', { names: ['V2499'] })).toEqual({ running: true, tags: { V2499: 2499 }, missing: [] })
  })

  it("get_tags carries each task's scan time, rounded to the microsecond", async () => {
    const ctrl = fakeController({ Count: 3 })
    const times = [{ task: 'Fast', kind: 'periodic', periodSec: 0.01, scans: 120, lastMs: 0.0123456, avgMs: 0.011, maxMs: 0.25 }]
    const c = ctx(Object.assign(ctrl, { plcScanTimes: times }))
    expect(await ok(c, 'get_tags')).toEqual({
      running: true,
      tags: { Count: 3 },
      scanTimes: [{ task: 'Fast', intervalMs: 10, scans: 120, lastMs: 0.012, avgMs: 0.011, maxMs: 0.25 }],
    })
  })

  it('says the viewport is loading rather than crashing when there is no controller yet', async () => {
    expect(await refused(ctx(null), 'run')).toMatch(/still loading/)
  })
})

describe('agent tools: run_test', () => {
  it('validates the spec, runs it against the open scene, and reports each check', async () => {
    const c = ctx()
    await ok(c, 'add_part', { package: 'agent.belt', position: [0, 0.8, 0] })
    runProjectTests.mockResolvedValue([{ name: 'test-1', ok: false, result: { ok: false, checks: [{ ok: false, detail: 'Run was FALSE', failedAt: 1.5 }] } }])
    const spec = { duration: 2, checks: [{ tag: 'Run', at: 1, equals: true }] }
    const r = await ok(c, 'run_test', { spec })
    expect(r).toEqual({ summary: '0/1 test pass, 0/1 checks', ok: false, checks: [{ ok: false, detail: 'Run was FALSE', failedAt: 1.5 }] })
    // the project it ran is the live one, carrying exactly this spec
    const project = runProjectTests.mock.calls[0]![0] as { tests: unknown[]; scene: { parts: unknown[] } }
    expect(project.tests).toEqual([spec])
    expect(project.scene.parts).toHaveLength(1)
  })

  it('warns when an input names a program variable the test cannot reach (a plain VAR, not an input)', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: 'VAR_INPUT\n  Go : BOOL;\nEND_VAR\nVAR\n  Start : BOOL;\n  Busy : BOOL;\nEND_VAR\nBusy := Start OR Go;\n' })
    runProjectTests.mockResolvedValue([{ name: 'test-1', ok: false, result: { ok: false, checks: [] } }])
    const inputs = [
      { at: 0, tag: 'Start', value: true },
      { at: 0, tag: 'Go', value: true },
      { at: 0, tag: 'SomePartTag', value: true },
    ]
    const r = (await ok(c, 'run_test', { spec: { duration: 1, inputs, checks: [{ tag: 'Busy', at: 1, equals: true }] } })) as { warnings?: string[] }
    // Start is the program's own variable: dropped. Go is an input, SomePartTag is not the program's: both fine
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings![0]).toMatch(/^'Start' is a variable of the program but not one of its inputs/)
  })

  it('save_test keeps a named spec in the project; run_test with no spec runs the kept ones', async () => {
    const c = ctx()
    const spec = { name: 'belt runs', duration: 1, checks: [{ tag: 'Run', at: 1, equals: true }] }
    expect(await refused(c, 'save_test', { spec: { duration: 1, checks: spec.checks } })).toMatch(/needs a `name`/)
    expect(await refused(c, 'run_test', {})).toMatch(/keeps no tests yet/)
    const saved = await ok(c, 'save_test', { spec })
    expect(saved).toEqual({ name: 'belt runs', tests: ['belt runs'] })
    // the same name replaces, it does not duplicate
    await ok(c, 'save_test', { spec: { ...spec, duration: 2 } })
    const kept = (await ok(c, 'list_tests')) as { name: string; duration: number }[]
    expect(kept).toEqual([{ ...spec, duration: 2 }])
    expect(c.store.getState().testCount).toBe(1)
    // a project has one scene: a spec naming one (written when projects held several) is kept without it
    await ok(c, 'save_test', { spec: { ...spec, scene: 'nowhere' } })
    expect(await ok(c, 'list_tests')).toEqual([spec])

    runProjectTests.mockResolvedValue([{ name: 'belt runs', ok: true, result: { ok: true, checks: [{ ok: true, detail: 'Run = true at t=1s' }] } }])
    expect(await ok(c, 'run_test', {})).toEqual({
      ok: true,
      summary: '1/1 test pass, 1/1 checks',
      tests: [{ name: 'belt runs', ok: true, checks: [{ ok: true, detail: 'Run = true at t=1s' }] }],
    })
    expect((runProjectTests.mock.calls[0]![0] as { tests: unknown[] }).tests).toHaveLength(1)
  })

  it('traces the tags asked for through the run, and names one the run never published', async () => {
    const c = ctx()
    const changes = Array.from({ length: 250 }, (_, i) => ({ t: i / 100, v: i }))
    runProjectTests.mockResolvedValue([
      {
        name: 'test-1',
        ok: true,
        result: { ok: true, checks: [{ ok: true, detail: 'Run = true at t=1s' }] },
        trace: [{ tag: 'Run', start: false, changes: [{ t: 0.51666, v: true }] }, { tag: 'Enc', start: 0, changes }],
      },
    ])
    const spec = { duration: 2, checks: [{ tag: 'Run', at: 1, equals: true }] }
    const r = (await ok(c, 'run_test', { spec, trace: ['Run', 'Enc', 'Nope'] })) as { trace: { tag: string; changes: unknown[] }[]; traceMissing: string }
    expect(runProjectTests.mock.calls[0]![2]).toEqual({ trace: ['Run', 'Enc', 'Nope'] })
    expect(r.trace[0]).toEqual({ tag: 'Run', start: false, changes: [{ t: 0.517, v: true }] })
    // an encoder keeps its first and last 100 changes, with the count between
    expect(r.trace[1]!.changes).toHaveLength(201)
    expect(r.trace[1]!.changes[100]).toEqual({ omitted: 50 })
    expect(r.traceMissing).toBe('never published in the run: Nope')
    expect(await refused(c, 'run_test', { spec, trace: [] })).toMatch(/'trace' must be a non-empty array/)
  })

  it('lists the cargo at the times asked for, capped per snapshot, and names the times the run ended before', async () => {
    const c = ctx()
    const row = (id: number) => ({ id, part: null, kind: 'box', color: '#ffffff', pos: [id, 0.5, 0], tiltDeg: 47, yawDeg: 0 })
    runProjectTests.mockResolvedValue([
      {
        name: 'test-1',
        ok: true,
        result: { ok: true, checks: [{ ok: true, detail: 'Run = true at t=1s' }] },
        cargo: [{ at: 1, t: 1.0000001, bodies: Array.from({ length: 250 }, (_, i) => row(i)) }],
        cargoMissed: [9],
      },
    ])
    const spec = { duration: 2, checks: [{ tag: 'Run', at: 1, equals: true }] }
    const r = (await ok(c, 'run_test', { spec, cargo: [1, 9] })) as { cargo: { at: number; t: number; count: number; bodies: unknown[]; omitted?: number }[]; cargoMissed: string }
    expect(runProjectTests.mock.calls[0]![2]).toEqual({ cargo: [1, 9] })
    expect(r.cargo[0]).toMatchObject({ at: 1, t: 1, count: 250, omitted: 50 })
    expect(r.cargo[0]!.bodies).toHaveLength(200)
    expect(r.cargo[0]!.bodies[3]).toEqual(row(3))
    expect(r.cargoMissed).toBe('the run ended before t=9')
    expect(await refused(c, 'run_test', { spec, cargo: [-1] })).toMatch(/'cargo' must be a non-empty array of sim times/)
    expect(await refused(c, 'run_test', { spec, cargo: Array.from({ length: 21 }, (_, i) => i) })).toMatch(/at most 20 times/)
  })

  it('refuses an invalid spec with the validator\'s reasons, and reports a run that threw', async () => {
    const c = ctx()
    expect(await refused(c, 'run_test', { spec: { checks: [] } })).toMatch(/invalid test spec/)
    // two predicates that are not a range say what a check takes
    const both = { duration: 1, checks: [{ tag: 'A', at: 1, min: 1, equals: 2 }] }
    expect(await refused(c, 'run_test', { spec: both })).toMatch(/or min and max together for a range/)
    runProjectTests.mockResolvedValue([{ name: 'test-1', ok: false, error: 'the run threw' }])
    expect(await refused(c, 'run_test', { spec: { duration: 1, checks: [{ tag: 'A', at: 0, equals: true }] } })).toBe('the run threw')
  })
})
