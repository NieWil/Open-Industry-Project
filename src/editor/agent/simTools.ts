// Agent tools that hold and step the live sim (docs/agent-tools.md): pause it where something happens, look, step on,
// resume. They are the toolbar's Pause and Step, so the person sees the sim paused too. Operating, never an edit.

import type { StepDone } from '../../sim/client'
import { AgentToolError, needController, optNum, round, type AgentController, type AgentTool, type AgentToolContext } from './toolKit'

/** the most sim time one step call may cover: at a few ms a step, a minute or two answers well inside a client's
 *  timeout, and a longer look is a run_test */
export const STEP_MAX_SECONDS = 120

type Stepper = AgentController & Required<Pick<AgentController, 'setPaused' | 'stepBy'>>

function needRunning(ctx: AgentToolContext): Stepper {
  const c = needController(ctx)
  if (!c.setPaused || !c.stepBy) throw new AgentToolError('this editor cannot hold the sim')
  if (!ctx.store.getState().running) throw new AgentToolError('the sim is not running: call run first')
  return c as Stepper
}

/** Pause, and wait until the view shows where the sim stopped (a zero-step request comes back after that frame). */
async function pauseAndSettle(c: Stepper): Promise<StepDone | null> {
  c.setPaused(true)
  return c.stepBy({ steps: 0 })
}

function stepResult(ctx: AgentToolContext, done: StepDone | null): Record<string, unknown> {
  if (!done) throw new AgentToolError('the run ended before the step finished')
  return {
    paused: ctx.store.getState().paused,
    simTime: round(done.simTime),
    steps: done.steps,
    ...(done.interrupted ? { interrupted: true, note: 'the sim was resumed (by the person, or another call) before the step finished' } : {}),
  }
}

export const pauseTool: AgentTool = {
  name: 'pause',
  description:
    'Pause the running sim where it is (the toolbar Pause), so get_cargo, get_tags and capture_view all describe one ' +
    'moment. While paused, get_cargo also gives each body its velocity and what it touches. Returns the sim time it ' +
    'stopped at. Step on with `step`, carry on with `resume`.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (ctx) => stepResult(ctx, await pauseAndSettle(needRunning(ctx))),
}

export const resumeTool: AgentTool = {
  name: 'resume',
  description: 'Carry on running a paused sim at wall-clock pace (the toolbar Play).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (ctx) => {
    needRunning(ctx).setPaused(false)
    return { running: true, paused: ctx.store.getState().paused }
  },
}

export const stepTool: AgentTool = {
  name: 'step',
  description:
    'Advance the live sim and stay paused there: `steps` physics steps (the PLC scans that fall due run in between), ' +
    '`seconds` of sim time, or `until` a sim time in seconds. Give at most one; none = one step. A running sim pauses ' +
    `first, so \`until\` is "run to this time and stop". At most ${STEP_MAX_SECONDS} s of sim time per call. Returns ` +
    'the sim time reached. This is the live run, shaped by when you looked and by what the person did: for the same ' +
    'result every time, use run_test.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: { type: 'integer', minimum: 1, description: 'physics steps to take' },
      seconds: { type: 'number', exclusiveMinimum: 0, description: 'sim time to advance, s' },
      until: { type: 'number', minimum: 0, description: 'the sim time to stop at, s' },
    },
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const c = needRunning(ctx)
    const steps = optNum(args, 'steps')
    const seconds = optNum(args, 'seconds')
    const until = optNum(args, 'until')
    if ([steps, seconds, until].filter((v) => v !== undefined).length > 1) throw new AgentToolError("give one of 'steps', 'seconds' or 'until'")
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) throw new AgentToolError("'steps' must be a whole number of at least 1")
    if (seconds !== undefined && !(seconds > 0)) throw new AgentToolError("'seconds' must be more than 0")
    const at = ctx.store.getState().paused ? (c.lastFrame?.simTime ?? 0) : ((await pauseAndSettle(c))?.simTime ?? 0)
    const hz = c.sim?.runHz ?? ctx.store.getState().simHz
    if (until !== undefined && until < at - 1e-9) throw new AgentToolError(`the sim is already at ${round(at)} s; it only runs forward (stop and run again to start over)`)
    const span = until !== undefined ? until - at : seconds !== undefined ? seconds : (steps ?? 1) / hz
    if (span > STEP_MAX_SECONDS + 1e-9) throw new AgentToolError(`that is ${round(span)} s of sim time; one call covers at most ${STEP_MAX_SECONDS} s`)
    const opts = until !== undefined ? { until } : { steps: seconds !== undefined ? Math.max(1, Math.round(seconds * hz)) : (steps ?? 1) }
    return stepResult(ctx, await c.stepBy(opts))
  },
}
