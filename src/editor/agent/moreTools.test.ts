// The agent tools for part definitions, the program by POU, seeing the scene, and the agent's own history
// (partTools.ts, programTools.ts, viewTools.ts). tools.test.ts covers the original list and the shared rules.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentImageResult, callAgentTool, type AgentController, type AgentToolContext } from './tools'
import { EditorStore } from '../store/store'
import { getPackage, registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { PACKAGE_FORMAT, type PartPackage } from '../../core/parts/partPackage'
import { CARGO_KIND_BOX } from '../../core/frame'
import type { BoxFrame } from '../../core/frame'
import type { SdkPart } from '../../core/types'

const LIFT_BEHAVIOR = "definePart({\n  params: { height: { type: 'number', default: 0.5, min: 0, max: 2 } },\n  step(ctx) {},\n})\n"

const LIFT: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'agent.lift',
  name: 'Agent Lift',
  category: 'Equipment',
  params: { height: { type: 'number', default: 0.5, min: 0, max: 2 } },
  behavior: LIFT_BEHAVIOR,
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 0.4, 1] }, offset: [0, 0.2, 0] }], joints: [] },
}

function ctx(controller: AgentController | null = null): AgentToolContext {
  const store = new EditorStore()
  store.setBundledPackages([LIFT])
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

const created: string[] = []
beforeEach(() => registerPackage(LIFT))
afterEach(() => {
  unregisterPackage(LIFT.id)
  for (const id of created.splice(0)) unregisterPackage(id)
})

describe('agent tools: the Part SDK', () => {
  it('lists the guide, reads a section and finds a declaration', async () => {
    const c = ctx()
    const toc = (await ok(c, 'get_part_sdk')) as { sections: string[] }
    expect(toc.sections).toContain('Params')
    const params = (await ok(c, 'get_part_sdk', { section: 'params' })) as string
    expect(params.startsWith('## Params')).toBe(true)
    expect(params).not.toMatch(/\n## Behavior/)
    expect(await ok(c, 'get_part_sdk', { symbol: 'definePart' })).toMatch(/definePart/)
    expect(await refused(c, 'get_part_sdk', { section: 'no such heading at all' })).toMatch(/no section matching/)
  })
})

describe('agent tools: part definitions', () => {
  it('get_part_source reads a definition as its folder holds it, with its footprint and where it is used', async () => {
    const c = ctx()
    const src = (await ok(c, 'get_part_source', { id: 'agent.lift' })) as Record<string, unknown>
    expect(src).toMatchObject({ id: 'agent.lift', behavior: LIFT_BEHAVIOR, placed: [] })
    expect(src.kind).toMatch(/^built-in/)
    expect(src.manifest).toMatchObject({ id: 'agent.lift', geometry: { kind: 'rig' } })
    expect(src.footprint).toMatchObject({ length: 1, width: 1, top: 0.4 })
  })

  it('check_part reports a misspelt manifest field and a script error, and keeps nothing', async () => {
    const c = ctx()
    const typo = (await ok(c, 'check_part', { id: 'agent.lift', manifest: { categry: 'Equipment' } })) as { ok: boolean; schema?: { path: string; message: string }[] }
    expect(typo.ok).toBe(false)
    expect(typo.schema?.[0]).toMatchObject({ path: 'manifest.categry', message: expect.stringMatching(/did you mean "category"/) })
    const broken = (await ok(c, 'check_part', { id: 'agent.lift', behavior: 'definePart({ step(ctx) { Math.random() } })' })) as { ok: boolean; diagnostics?: { kind: string }[] }
    expect(broken.ok).toBe(false)
    expect(broken.diagnostics?.[0]?.kind).toBe('determinism')
    const fine = (await ok(c, 'check_part', { id: 'agent.lift' })) as { ok: boolean; params: Record<string, unknown> }
    expect(fine.ok).toBe(true)
    expect(Object.keys(fine.params)).toEqual(['height'])
    expect(c.store.getEditHistory().events).toHaveLength(0)
  })

  it('create_part adds a checked definition to the library, then add_part places it', async () => {
    const c = ctx()
    const r = (await ok(c, 'create_part', { name: 'Lift Table', behavior: LIFT_BEHAVIOR })) as { id: string; footprint: Record<string, number> }
    created.push(r.id)
    expect(r.id).toBe('user.lift-table')
    expect(r.footprint).toMatchObject({ length: 0.6, top: 0.6 })
    expect(c.store.getState().userPackages.map((p) => p.id)).toContain('user.lift-table')
    await ok(c, 'add_part', { package: 'user.lift-table', position: [0, 0, 0] })
    expect(await refused(c, 'create_part', { name: 'Again', id: 'user.lift-table' })).toMatch(/already exists/)
    expect(await refused(c, 'create_part', { name: 'Bad', behavior: 'definePart({ step() { Date.now() } })' })).toMatch(/was not kept:\n- determinism/)
    expect(await refused(c, 'create_part', { name: 'Owned', manifest: { assets: [] } })).toMatch(/'assets' is the app's to write/)
  })

  it("edit_part_definition is one undo step, and a built-in becomes this project's own version", async () => {
    const c = ctx()
    const behavior = LIFT_BEHAVIOR.replace("height: { type: 'number', default: 0.5, min: 0, max: 2 }", "height: { type: 'number', default: 0.5, min: 0, max: 2 }, speed: { type: 'number', default: 1 }")
    const r = (await ok(c, 'edit_part_definition', { id: 'agent.lift', behavior, manifest: { name: 'Lift 2' } })) as { params: Record<string, unknown>; note?: string }
    expect(Object.keys(r.params)).toEqual(['height', 'speed'])
    expect(r.note).toMatch(/its own version/)
    expect(getPackage('agent.lift')?.name).toBe('Lift 2')
    expect(c.store.getState().userPackages.some((p) => p.id === 'agent.lift')).toBe(true)
    expect(c.store.getEditHistory().events.at(-1)?.label).toBe('Agent: edit part Lift 2')
    c.store.undo()
    expect(getPackage('agent.lift')?.behavior).toBe(LIFT_BEHAVIOR)
    expect(await refused(c, 'edit_part_definition', { id: 'agent.lift', behavior: 'definePart(' })).toMatch(/was not kept/)
    expect(await refused(c, 'edit_part_definition', { id: 'agent.lift' })).toMatch(/give 'behavior', 'manifest' or both/)
  })

  it('import_model fits a part that is just the model, and measures any other against its footprint', async () => {
    // a tracked part asset: 0.5 x 0.136 x 0.5 m, its underside at y -0.105 in its own frame
    const bytes = new Uint8Array(readFileSync(new URL('../../../public/part-assets/929d5eae36c065f460ac5bb80c287977bcf7c7d5596680a56ab2946d483cdb32.glb', import.meta.url)))
    const shell = { readModel: async () => ({ name: 'm.glb', bytes }) }
    const c = { ...ctx(), shell }
    // the default new part: one 0.6 m box node at y 0.3. The model replaces it whole, so the part is fitted to it:
    // it stands on the floor, with bounds and a collider of its size
    const single = (await ok(c, 'create_part', { name: 'Single' })) as { id: string }
    created.push(single.id)
    const r0 = (await ok(c, 'import_model', { id: single.id, link: 'body', path: 'C:/m.glb' })) as { fitted?: boolean; model: { min: number[] }; boundsHint?: string }
    expect(r0.fitted).toBe(true)
    expect(r0.model.min[1]).toBeCloseTo(0, 3)
    expect(r0.boundsHint).toBeUndefined()
    const geometry = getPackage(single.id)!.geometry as { links: { name: string; hidden?: boolean }[]; bounds?: { top: number } }
    expect(geometry.links.map((l) => l.name)).toEqual(['body', 'collider'])
    expect(geometry.bounds?.top).toBeCloseTo(0.136, 2)
    // a part with more than the model is the author's arrangement: left as it is, and measured against its footprint
    const loose = (await ok(c, 'create_part', {
      name: 'Loose',
      manifest: {
        geometry: {
          kind: 'rig',
          links: [
            { name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6] }, offset: [0, 0.3, 0] },
            { name: 'lamp', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.35, 0] },
          ],
          joints: [],
          // declared smaller than the model, which then sticks out of it
          bounds: { length: 0.2, width: 0.2, top: 0.2 },
        },
      },
    })) as { id: string }
    created.push(loose.id)
    const r1 = (await ok(c, 'import_model', { id: loose.id, link: 'body', path: 'C:/m.glb' })) as { fitted?: boolean; model: { min: number[]; max: number[] }; boundsHint?: string }
    expect(r1.fitted).toBeUndefined()
    expect(r1.model.min[1]).toBeCloseTo(0.195, 2)
    expect(r1.boundsHint).toMatch(/underside is at y 0\.195/)
    // a part whose link and bounds already fit the model gets no hint
    const fitted = (await ok(c, 'create_part', {
      name: 'Fitted',
      manifest: { geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.14, 0.5] }, offset: [0, 0.105, 0] }], joints: [], bounds: { length: 0.5, width: 0.5, top: 0.14 } } },
    })) as { id: string }
    created.push(fitted.id)
    const r2 = (await ok(c, 'import_model', { id: fitted.id, link: 'body', path: 'C:/m.glb' })) as { boundsHint?: string }
    expect(r2.boundsHint).toBeUndefined()
  })

  it('import_model needs the desktop shell, and names the links a part has', async () => {
    const c = ctx()
    expect(await refused(c, 'import_model', { id: 'agent.lift', link: 'body', path: 'C:/m.glb' })).toMatch(/needs the desktop app/)
    const shell = { readModel: async () => ({ error: 'unused' }) }
    expect(await refused({ ...c, shell }, 'import_model', { id: 'agent.lift', link: 'deck', path: 'C:/m.glb' })).toMatch(/no link 'deck' \(it has: body\)/)
    expect(await refused({ ...c, shell }, 'import_model', { id: 'agent.lift', link: 'body', path: 'C:/m.glb' })).toBe('unused')
  })

  it('import_model refuses a .glb that is not a model, and changes nothing', async () => {
    const shell = { readModel: async () => ({ name: 'm.glb', bytes: new TextEncoder().encode('a text file renamed to .glb') }) }
    const c = { ...ctx(), shell }
    const before = getPackage('agent.lift')
    const steps = c.store.getEditHistory().events.length
    expect(await refused(c, 'import_model', { id: 'agent.lift', link: 'body', path: 'C:/m.glb' })).toMatch(/m\.glb is not a model this importer can read/)
    expect(getPackage('agent.lift')).toBe(before)
    expect(c.store.getEditHistory().events.length).toBe(steps)
  })
})

describe('agent tools: the program by POU', () => {
  const PROGRAM = 'FUNCTION_BLOCK Lane\nVAR_INPUT\n  Go : BOOL;\nEND_VAR\nEND_FUNCTION_BLOCK\n\nPROGRAM Main\nVAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\nEND_PROGRAM\n'

  it('lists, reads, replaces, adds and deletes one POU, each as one undo step', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: PROGRAM })
    expect(await ok(c, 'list_pous')).toEqual([
      { name: 'Lane', language: 'st', lines: 5 },
      { name: 'Main', language: 'st', lines: 6 },
    ])
    expect(await ok(c, 'get_pou', { name: 'main' })).toMatch(/^PROGRAM Main/)
    const edited = (await ok(c, 'set_pou', { name: 'Main', source: 'PROGRAM Main\nVAR\n  Run : BOOL;\nEND_VAR\nRun := FALSE;\nEND_PROGRAM' })) as { pous: string[]; problems: unknown[] }
    expect(edited).toEqual({ pous: ['Lane', 'Main'], problems: [] })
    expect(c.store.getState().stProgram).toMatch(/END_FUNCTION_BLOCK\n\nPROGRAM Main[\s\S]*Run := FALSE;/)
    expect(c.store.getEditHistory().events.at(-1)?.label).toBe('Agent: edit Main')
    await ok(c, 'set_pou', { name: 'Limits', source: 'TYPE\n  Level : INT;\nEND_TYPE', before: 'Lane' })
    expect(((await ok(c, 'list_pous')) as { name: string }[]).map((p) => p.name)).toEqual(['type', 'Lane', 'Main'])
    await ok(c, 'set_pou', { name: 'type', source: '' })
    expect(((await ok(c, 'list_pous')) as { name: string }[]).map((p) => p.name)).toEqual(['Lane', 'Main'])
    c.store.undo()
    expect(((await ok(c, 'list_pous')) as { name: string }[]).map((p) => p.name)).toEqual(['type', 'Lane', 'Main'])
    expect(await refused(c, 'get_pou', { name: 'Nope' })).toMatch(/the POUs are: type, Lane, Main/)
  })

  it('adds a new POU above the code outside every POU, where a declaration can go', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: 'VAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n' })
    const r = (await ok(c, 'set_pou', { name: 'Debounce', source: 'FUNCTION_BLOCK Debounce\nVAR_INPUT\n  In : BOOL;\nEND_VAR\nEND_FUNCTION_BLOCK' })) as { pous: string[]; problems: unknown[] }
    expect(r).toEqual({ pous: ['Debounce', 'program'], problems: [] })
  })

  it('places a compile error in its POU, and check_program keeps nothing', async () => {
    const c = ctx()
    await ok(c, 'set_program', { source: PROGRAM })
    const bad = (await ok(c, 'set_pou', { name: 'Main', source: 'PROGRAM Main\nVAR\n  Run : BOOL;\nEND_VAR\nRun := ;\nEND_PROGRAM' })) as { problems: Record<string, unknown>[] }
    expect(bad.problems.find((p) => p.severity === 'error')).toMatchObject({ pou: 'Main', pouLine: 5 })
    c.store.undo()
    const program = c.store.getState().stProgram
    const checked = (await ok(c, 'check_program', { source: 'VAR\n  X : INT;\nEND_VAR\nX := ;\n' })) as { ok: boolean; problems: { line?: number }[] }
    expect(checked.ok).toBe(false)
    expect(checked.problems.some((p) => p.line === 4)).toBe(true)
    expect(c.store.getState().stProgram).toBe(program)
  })
})

describe('agent tools: scene groups, history and tests', () => {
  it('duplicate_parts copies a group by an offset, as one undo step', async () => {
    const c = ctx()
    const { id } = (await ok(c, 'add_part', { package: 'agent.lift', position: [0, 0, 0] })) as { id: string }
    const r = (await ok(c, 'duplicate_parts', { ids: [id], offset: [0, 0, 3] })) as { copies: Record<string, string> }
    const copy = c.store.getState().scene.parts.find((p) => p.id === r.copies[id]) as SdkPart
    expect(copy.position).toEqual([0, 0, 3])
    expect(c.store.getEditHistory().events.at(-1)?.label).toBe('Agent: duplicate part')
    expect(await refused(c, 'duplicate_parts', { ids: ['ghost'], offset: [1, 0, 0] })).toMatch(/no part "ghost"/)
  })

  it("undo takes back the agent's own step and refuses the user's", async () => {
    const c = ctx()
    await ok(c, 'add_part', { package: 'agent.lift', position: [0, 0, 0] })
    expect(await ok(c, 'undo')).toEqual({ undone: 'Agent: place Agent Lift' })
    expect(c.store.getState().scene.parts).toHaveLength(0)
    expect(await ok(c, 'undo', { redo: true })).toEqual({ redone: 'Agent: place Agent Lift' })
    const s = c.store.getState().scene
    c.store.commit('Move part', { ...s, parts: s.parts.map((p) => ({ ...p, position: [1, 0, 0] as [number, number, number] })) })
    expect(await refused(c, 'undo')).toMatch(/the user's \("Move part"\)/)
    expect(c.store.getState().scene.parts[0]?.position).toEqual([1, 0, 0])
  })

  it('delete_test drops a kept test by name', async () => {
    const c = ctx()
    await ok(c, 'save_test', { spec: { name: 'runs', duration: 1, checks: [{ tag: 'Run', at: 1, equals: true }] } })
    expect(await ok(c, 'delete_test', { name: 'runs' })).toEqual({ tests: [] })
    expect(await refused(c, 'delete_test', { name: 'runs' })).toMatch(/no test named 'runs'/)
  })
})

describe('agent tools: seeing the scene', () => {
  it('capture_view needs the desktop shell', async () => {
    expect(await refused(ctx(), 'capture_view')).toMatch(/needs the desktop app/)
  })

  it('capture_view refuses while the user walks the scene, which owns the camera', async () => {
    const view = { pilotPose: () => ({ position: [0, 0, 0], yaw: 0 }), isVRPresenting: () => false }
    const c = { ...ctx({ view, plcFault: null } as unknown as AgentController), shell: { capture: async () => null } }
    expect(await refused(c, 'capture_view')).toMatch(/walking the scene/)
  })

  it("capture_view from 'window' takes the whole window and leaves the camera alone", async () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 })
    try {
      const rects: unknown[] = []
      // walking owns the camera, but a window picture never touches it
      const view = { pilotPose: () => ({ position: [0, 0, 0], yaw: 0 }), isVRPresenting: () => false }
      const shell = { capture: async (rect: unknown) => (rects.push(rect), { data: 'AA==', mimeType: 'image/jpeg' }) }
      const c = { ...ctx({ view, plcFault: null } as unknown as AgentController), shell }
      const r = (await ok(c, 'capture_view', { from: 'window' })) as unknown as AgentImageResult
      expect(rects).toEqual([{ x: 0, y: 0, width: 1280, height: 720 }])
      expect(r.images).toHaveLength(1)
      expect(await refused(c, 'capture_view', { from: 'window', parts: ['belt'] })).toMatch(/does not go with/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('get_cargo lists the last frame’s bodies with their tilt and heading, filtered to a box', async () => {
    const tipped = Math.SQRT1_2 // 90° about X
    const s = Math.sin(Math.PI / 8) // 45° about Y
    const frame = {
      count: 2,
      ids: new Uint32Array([7, 8]),
      positions: new Float32Array([1, 0.9, 0, 5, 0.1, 0]),
      quats: new Float32Array([0, s, 0, Math.cos(Math.PI / 8), tipped, 0, 0, tipped]),
      halfExtents: new Float32Array([0.2, 0.15, 0.2, 0.2, 0.15, 0.2]),
      colors: new Float32Array([1, 0, 0, 1, 1, 1]),
      kinds: new Uint8Array([CARGO_KIND_BOX, CARGO_KIND_BOX]),
      partIds: [null, 'box_3'],
      simTime: 12.5,
    } as unknown as BoxFrame
    const c = ctx({ lastFrame: frame, plcFault: null } as unknown as AgentController)
    expect(await ok(c, 'get_cargo')).toEqual({ running: false, count: 0, cargo: [] })
    c.store.setState({ running: true })
    const all = (await ok(c, 'get_cargo')) as { count: number; cargo: Record<string, unknown>[] }
    expect(all.count).toBe(2)
    expect(all.cargo[0]).toEqual({ id: 7, kind: 'box', position: [1, 0.9, 0], size: [0.4, 0.3, 0.4], color: '#ff0000', tiltDeg: 0, yawDeg: 45 })
    expect(all.cargo[1]).toMatchObject({ id: 8, tiltDeg: 90, yawDeg: 0, part: 'box_3' })
    const near = (await ok(c, 'get_cargo', { within: { min: [0, 0, -1], max: [2, 2, 1] } })) as { count: number }
    expect(near.count).toBe(1)
  })

  it('an image result keeps its info apart from its images', () => {
    const r = new AgentImageResult({ from: 'iso' }, [{ data: 'AA==', mimeType: 'image/jpeg' }])
    expect(r.info).toEqual({ from: 'iso' })
    expect(r.images).toHaveLength(1)
  })
})
