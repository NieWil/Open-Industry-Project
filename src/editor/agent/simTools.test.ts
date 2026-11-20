// The agent tools that hold and step the live sim (simTools.ts), and get_cargo's paused detail, against a stand-in
// controller: what each sends the sim, and how it reads the answer. The worker's side is sim/worker.ts.
import { describe, expect, it } from 'vitest'
import { callAgentTool, type AgentController, type AgentToolContext } from './tools'
import { EditorStore } from '../store/store'
import { CARGO_KIND_BOX } from '../../core/frame'
import type { BoxFrame } from '../../core/frame'
import type { CargoDetail, StepDone } from '../../sim/client'

/** A controller whose sim stands at `simTime` and steps at `hz`; records every stepBy it is asked for. */
function standIn(store: EditorStore, simTime = 0, hz = 60) {
  const asked: { steps?: number; until?: number }[] = []
  let t = simTime
  const frame = (): BoxFrame =>
    ({
      count: 1,
      ids: new Uint32Array([4]),
      positions: new Float32Array([1, 0.5, 0]),
      quats: new Float32Array([0, 0, 0, 1]),
      halfExtents: new Float32Array([0.2, 0.2, 0.2]),
      colors: new Float32Array([1, 1, 1]),
      kinds: new Uint8Array([CARGO_KIND_BOX]),
      partIds: [null],
      simTime: t,
    }) as unknown as BoxFrame
  const c = {
    plcFault: null,
    lastFrame: frame(),
    sim: {
      runHz: hz,
      inspectCargo: (): Promise<CargoDetail> =>
        Promise.resolve({ simTime: t, ids: new Uint32Array([4]), velocities: new Float32Array([0.6, 0, -0.0004]), touching: [[4, ['belt_1', 'floor']]] }),
    },
    setPaused: (p: boolean) => store.setPaused(p),
    stepBy: (opts: { steps?: number; until?: number }): Promise<StepDone> => {
      asked.push(opts)
      const n = opts.until !== undefined ? Math.ceil((opts.until - t) * hz - 1e-9) : opts.steps!
      t += n / hz
      c.lastFrame = frame()
      return Promise.resolve({ simTime: t, steps: n })
    },
  }
  return { c: c as unknown as AgentController, asked }
}

function running(simTime = 0): { ctx: AgentToolContext; asked: { steps?: number; until?: number }[] } {
  const store = new EditorStore()
  store.setState({ running: true })
  const { c, asked } = standIn(store, simTime)
  return { ctx: { store, controller: c }, asked }
}

async function ok(c: AgentToolContext, name: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const r = await callAgentTool(c, name, args)
  if (!r.ok) throw new Error(`${name} refused: ${r.error}`)
  return r.value as Record<string, unknown>
}

async function refused(c: AgentToolContext, name: string, args: unknown = {}): Promise<string> {
  const r = await callAgentTool(c, name, args)
  if (r.ok) throw new Error(`${name} was expected to refuse`)
  return r.error
}

describe('agent tools: holding the live sim', () => {
  it('pause holds the run where it is and says the sim time; resume lets it go', async () => {
    const { ctx, asked } = running(3.5)
    expect(await ok(ctx, 'pause')).toEqual({ paused: true, simTime: 3.5, steps: 0 })
    // the zero-step request is what waits for the frame showing the paused world
    expect(asked).toEqual([{ steps: 0 }])
    expect(await ok(ctx, 'resume')).toEqual({ running: true, paused: false })
  })

  it('refuses while stopped', async () => {
    const store = new EditorStore()
    const { c } = standIn(store)
    const ctx = { store, controller: c }
    expect(await refused(ctx, 'pause')).toMatch(/not running/)
    expect(await refused(ctx, 'step')).toMatch(/not running/)
  })

  it('step pauses a running sim first, then takes one step by default', async () => {
    const { ctx, asked } = running(1)
    const r = await ok(ctx, 'step')
    expect(ctx.store.getState().paused).toBe(true)
    expect(asked).toEqual([{ steps: 0 }, { steps: 1 }])
    expect(r).toMatchObject({ paused: true, steps: 1 })
  })

  it('step turns seconds into whole steps at the run rate, and runs until a sim time', async () => {
    const { ctx, asked } = running(2)
    await ok(ctx, 'pause')
    await ok(ctx, 'step', { seconds: 0.5 })
    expect(asked.at(-1)).toEqual({ steps: 30 })
    const r = await ok(ctx, 'step', { until: 4 })
    expect(asked.at(-1)).toEqual({ until: 4 })
    expect(r.simTime).toBe(4)
  })

  it('step refuses going back, more than the cap, and more than one way to say how far', async () => {
    const { ctx } = running(10)
    await ok(ctx, 'pause')
    expect(await refused(ctx, 'step', { until: 5 })).toMatch(/already at 10 s/)
    expect(await refused(ctx, 'step', { seconds: 500 })).toMatch(/at most 120 s/)
    expect(await refused(ctx, 'step', { until: 200 })).toMatch(/at most 120 s/)
    expect(await refused(ctx, 'step', { steps: 2, seconds: 1 })).toMatch(/one of/)
    expect(await refused(ctx, 'step', { steps: 1.5 })).toMatch(/whole number/)
  })

  it('get_cargo adds velocity and contacts while paused, and not while running', async () => {
    const { ctx } = running(1)
    const live = await ok(ctx, 'get_cargo')
    expect(live.paused).toBeUndefined()
    expect((live.cargo as Record<string, unknown>[])[0]!.vel).toBeUndefined()
    await ok(ctx, 'pause')
    const held = await ok(ctx, 'get_cargo')
    expect(held.paused).toBe(true)
    expect((held.cargo as Record<string, unknown>[])[0]).toMatchObject({ id: 4, vel: [0.6, 0, -0], touching: ['belt_1', 'floor'] })
  })
})
