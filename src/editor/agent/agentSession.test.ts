import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callAgentTool, type AgentToolContext } from './tools'
import { AgentSession } from './agentSession'
import { agentChanges } from './agentReview'
import { EditorStore } from '../store/store'
import { providePlcReading } from '../program/plcReading'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { PACKAGE_FORMAT, type PartPackage } from '../../core/parts/partPackage'
import type { SceneJSON, SdkPart } from '../../core/types'

// run_test's runner loads jolt-physics/wasm, which the node env cannot resolve; nothing here runs a test
vi.mock('../project/projectTestsRun', () => ({ runProjectTests: vi.fn() }))

const BELT: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'review.belt',
  name: 'Review Belt',
  category: 'Conveyors',
  params: { speed: { type: 'number', default: 0.5, min: 0, max: 3 } },
  behavior: 'definePart({ step() {} })',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 0.8] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 2, width: 0.8, top: 0.05, bottom: -0.1 } },
}

function setup(): AgentToolContext & { session: AgentSession } {
  const store = new EditorStore()
  store.setBundledPackages([BELT])
  return { store, controller: null, session: new AgentSession(store) }
}

async function call(c: AgentToolContext, name: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const r = await callAgentTool(c, name, args)
  if (!r.ok) throw new Error(`${name} refused: ${r.error}`)
  return r.value as Record<string, unknown>
}

const place = (c: AgentToolContext, x: number): Promise<Record<string, unknown>> => call(c, 'add_part', { package: BELT.id, position: [x, 0.8, 0] })

/** a person's edit: a move through the store's own commit, labelled as the editor labels it */
function personMoves(store: EditorStore, id: string): void {
  const scene = store.getState().scene
  store.commit('Move part', { ...scene, parts: scene.parts.map((p) => (p.id === id ? { ...p, position: [9, 0.8, 9] as [number, number, number] } : p)) })
}

beforeEach(() => registerPackage(BELT))
afterEach(() => unregisterPackage(BELT.id))

describe('agent session: activity', () => {
  it('names the tool while it runs and counts the calls', async () => {
    const c = setup()
    let busyDuring: string | null = null
    c.session.subscribe(() => {
      if (c.session.getSnapshot().busy) busyDuring = c.session.getSnapshot().busy
    })
    await call(c, 'get_scene')
    expect(busyDuring).toBe('get_scene')
    expect(c.session.getSnapshot()).toMatchObject({ busy: null, calls: 1, last: { tool: 'get_scene', ok: true } })
    await callAgentTool(c, 'get_part', { id: 'nope' })
    expect(c.session.getSnapshot().last).toMatchObject({ tool: 'get_part', ok: false })
  })
})

describe('agent session: the review', () => {
  it('opens at the first agent edit, not at a read', async () => {
    const c = setup()
    await call(c, 'get_scene')
    expect(c.session.getSnapshot().baseline).toBeNull()
    await place(c, 0)
    expect(c.session.getSnapshot().baseline).not.toBeNull()
    expect(c.session.pending().map((e) => e.label)).toEqual([expect.stringMatching(/^Agent:/)])
  })

  it('lists what changed against the document from before', async () => {
    const c = setup()
    const { id } = (await place(c, 0)) as { id: string }
    await call(c, 'update_part', { id, params: { speed: 2 } })
    const { review } = await call(c, 'get_context')
    const changes = (review as { changes: ReturnType<typeof agentChanges> }).changes
    // placed and then changed in one run: against the document before the run, it is one added part
    expect(changes.parts).toEqual([{ id, label: BELT.id, change: 'added' }])
    expect((review as { steps: string[] }).steps).toHaveLength(2)
  })

  it('reverts the whole run back to where it began, and tells the agent', async () => {
    const c = setup()
    const before = c.store.documentScene()
    await place(c, 0)
    await place(c, 3)
    expect(c.store.documentScene().parts).toHaveLength(2)
    expect(c.session.revertBlocker()).toBeNull()
    expect(c.session.revert()).toBe(true)
    expect(c.store.documentScene().parts).toEqual(before.parts)
    expect(c.session.getSnapshot().baseline).toBeNull()
    const ctx = await call(c, 'get_context')
    expect(ctx.review).toBeNull()
    expect(ctx.lastAnswer).toMatchObject({ kind: 'reverted', steps: 2 })
  })

  it("never reverts over the person's own edit", async () => {
    const c = setup()
    const { id } = (await place(c, 0)) as { id: string }
    personMoves(c.store, id)
    await place(c, 3)
    expect(c.session.userStepsInRun().map((e) => e.label)).toEqual(['Move part'])
    expect(c.session.revertBlocker()).toMatch(/You made an edit after the agent started/)
    expect(c.session.revert()).toBe(false)
    expect(c.store.documentScene().parts).toHaveLength(2)
  })

  it('keep closes it, and the next agent edit opens a review from there', async () => {
    const c = setup()
    await place(c, 0)
    c.session.keep()
    expect(c.session.pending()).toEqual([])
    expect(c.session.getSnapshot().answer).toMatchObject({ kind: 'kept', steps: 1 })
    await place(c, 3)
    expect(c.session.pending()).toHaveLength(1)
    c.session.revert()
    expect(c.store.documentScene().parts).toHaveLength(1)
  })

  it('lapses when the person undoes every agent step', async () => {
    const c = setup()
    await place(c, 0)
    c.store.undo()
    expect(c.session.pending()).toEqual([])
  })

  it('lapses when the history is replaced (another scene loaded)', async () => {
    const c = setup()
    await place(c, 0)
    c.store.loadScene({ ...c.store.getState().scene, parts: [] })
    expect(c.session.pending()).toEqual([])
  })
})

describe('agent tools: get_context', () => {
  it('reports the selection and where the PLC panel reader is', async () => {
    const c = setup()
    const { id } = (await place(c, 0)) as { id: string }
    c.store.select(id)
    expect((await call(c, 'get_context')).plcPanel).toBeNull()
    const release = providePlcReading(() => ({ face: 'text', pou: 'Main', line: 12, word: 'Run' }))
    try {
      const ctx = await call(c, 'get_context')
      expect(ctx.selection).toEqual([{ id, package: BELT.id, packageName: BELT.name, position: [0, 0.8, 0] }])
      expect(ctx.plcPanel).toEqual({ face: 'text', pou: 'Main', line: 12, word: 'Run' })
    } finally {
      release()
    }
  })
})

describe('agent review: the compare', () => {
  const part = (id: string, speed: number): SdkPart => ({ id, type: 'part', packageId: BELT.id, position: [0, 0, 0], rotationY: 0, params: { speed } })
  const doc = (parts: SdkPart[], source: string): Parameters<typeof agentChanges>[0] => ({
    scene: { version: 4, parts } as SceneJSON,
    program: { source, scanMs: 10, controller: null },
    packages: [],
    tests: [],
  })

  it('names the fields a changed part moved, and the lines a program edit spans', () => {
    const c = agentChanges(doc([part('a', 1), part('b', 1)], 'A\nB\nC\nD'), doc([part('a', 2), part('c', 1)], 'A\nX\nY\nD'))
    expect(c.parts).toEqual([
      { id: 'a', label: BELT.id, change: 'changed', fields: ['params.speed'] },
      { id: 'c', label: BELT.id, change: 'added' },
      { id: 'b', label: BELT.id, change: 'removed' },
    ])
    expect(c.program).toEqual({ fromLine: 2, toLine: 3, linesBefore: 4, linesAfter: 4 })
    expect(c.tasks).toBe(false)
  })
})
