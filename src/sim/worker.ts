/// <reference lib="webworker" />

// First: part behaviors step in this worker, so it locks down before anything else runs (core/lockdownBoot.ts)
import '../core/lockdownBoot'
import { subscribePartDiagnostics } from '../core/parts/partDiagnostics'
import { clearPackages, listPackages } from '../core/parts/partRegistry'
import { setPartCallBeacon } from '../core/parts/partScript'
import { DEFAULT_SIM_HZ } from '../core/types'
import type { SceneJSON } from '../core/types'
import { StError } from '../plc'
import { catchUpSteps } from './catchUp'
import { WATCH_HZ } from './plcHost'
import { PlcGroup } from './plcGroup'
import type { PlcFrameSent, PlcFrameWire } from './plcHost'
import type { WatchPlan } from '../plc/types'
import type { MainToWorker, WorkerToMain } from './protocol'
import { FrameWireEncoder, RecordEncoder } from './frameWire'
import { applyScenePatch } from './scenePatch'
import { SimWorld } from './world'
import type { JoltModule } from './world'

// the page's loop-tick counter ('beacon'); null where memory cannot be shared, and a paused loop sends 'alive' instead
let progress: Int32Array | null = null
// how often a paused loop without the counter sends 'alive': well inside the page watchdog's SIM_HANG_MS
const ALIVE_MS = 1000

let joltPromise: Promise<JoltModule> | null = null
let world: SimWorld | null = null
// the attached ST program, scanning in lockstep with the step loop (null = none). Owned by the
// world lifecycle: 'start'/'stop' clear it, and the attach ('runProgram') always follows 'start'.
let plc: PlcGroup | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let paused = false
// sim-clock multiplier (a time-scale factor): the loop accrues scaled time so the
// world runs more/fewer fixed steps (at its own rate) per real second. Persists across start/stop;
// the controller re-pushes the authoritative value on each start.
let timeScale = 1
let queue: Promise<void> = Promise.resolve()
// cumulative physics step-cost counters for the current run (reset on each 'start'), shipped
// with every frame so perf probes can window-diff them (e2e/threaded-jolt-bench.mjs)
let stepMsTotal = 0
let stepMsMax = 0
let stepsDone = 0
// world.frame() cost (the per-body WASM-getter walk), timed separately from stepping
let frameMsTotal = 0
let framesDone = 0
// interleaved PLC scan cost (plc.interleave): the third consumer of this thread's step budget,
// kept out of stepMsTotal so the bench's step numbers stay Jolt-only
let plcMsTotal = 0

// Messages that change what a frame shows without a step: a teleported body, cargo added or removed by a
// live edit, a promotion adopting a body. While paused, the loop publishes their result unstepped.
const HELD_EDITS = new Set<MainToWorker['type']>(['update', 'updatePatch', 'adopt', 'moveBody', 'setGrabbedPose'])
// the scene the main thread last sent whole or patched - what an 'updatePatch' applies over
let liveScene: SceneJSON | null = null
// a held edit landed while paused and no frame has shown it yet
let heldDirty = false
// Step requests not yet done, oldest first. The paused loop runs them on its next tick, so a step queued behind an
// edit sees it. `left` counts down a request by steps; `until` ends one at a sim time instead.
interface StepRequest {
  left: number
  until?: number
  seq?: number
  done: number
}
let stepQueue: StepRequest[] = []
// how long one paused tick may spend stepping before it posts a frame and yields: a long request (seconds of sim
// time) then still feeds the view and the hang watchdog (sim/client.ts) while it runs
const STEP_TICK_BUDGET_MS = 40

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  if (e.data.type === 'beacon') {
    // at once, not queued: it must be in place before any part code runs. A script is named by the package whose
    // behavior it is, looked up when the script is instantiated (once per placed part, never per step).
    progress = new Int32Array(e.data.progress)
    setPartCallBeacon(e.data.buffer, (source) => {
      const pkg = listPackages().find((p) => p.behavior === source)
      return pkg ? `${pkg.name} (${pkg.id})` : ''
    })
    return
  }
  queue = queue.then(async () => {
    await handle(e.data)
    if (paused && HELD_EDITS.has(e.data.type)) heldDirty = true
  })
}

// Custom-part runtime diagnostics (a throwing step(), an unknown commanded joint, …) are raised in this
// worker's core/parts/partDiagnostics instance; mirror every event to the main thread so the editor's instance
// (the one the Inspector/console read) stays in sync. Already deduped + rate-limited at the source.
subscribePartDiagnostics((event) => post({ type: 'partDiagnostics', event }))

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

/** a PLC compile/runtime fault as a protocol message, with the ST source position when known */
// the variable table rides a frame WATCH_HZ times a second, not on every one (PlcHost.snapshot says why); a
// program just attached sends it at once, so nothing waits a tenth of a second for its first values
let watchSentAt = -Infinity
let watchSentFor: PlcGroup | null = null
// counts the programs whose table was sent. A program's keys never change, so the number names a key set.
let watchKeys = 0
// where the attached program's watch values are in its memory, when its memory is one buffer (PlcGroup.watchPlan)
let watchPlan: WatchPlan | null = null
/** The frame's PLC state. A copy of the program's memory it carries goes into `transfer`, to be handed over, not cloned. */
// The program's inputs and outputs are a value per tag, on every frame: 73 KB on an 800-part line, where a frame
// changes a few of them. They cross as far as they changed (frameWire.ts RecordEncoder), from whole for each program
// attached.
const plcIo = { inputs: new RecordEncoder(), outputs: new RecordEncoder() }
let plcIoSentFor: PlcGroup | null = null
function plcIoSent(host: PlcGroup, shot: PlcFrameWire): PlcFrameSent {
  if (plcIoSentFor !== host) {
    plcIoSentFor = host
    plcIo.inputs.reset()
    plcIo.outputs.reset()
  }
  const { inputs, outputs, ...rest } = shot
  const out: PlcFrameSent = rest
  for (const [field, record] of [['inputs', inputs], ['outputs', outputs]] as const) {
    const sent = plcIo[field].encode(record)
    if (sent === 'kept') (out.ioKept ??= []).push(field)
    else if (sent !== 'none' && 'patch' in sent) (out.ioPatches ??= {})[field] = sent.patch
    else if (sent !== 'none') out[field] = sent.whole
  }
  return out
}

function plcFrame(host: PlcGroup, force: boolean, transfer: Transferable[]): PlcFrameSent {
  return plcIoSent(host, plcFrameWhole(host, force, transfer))
}

function plcFrameWhole(host: PlcGroup, force: boolean, transfer: Transferable[]): PlcFrameWire {
  const now = performance.now()
  if (!force && watchSentFor === host && now - watchSentAt < 1000 / WATCH_HZ) return host.snapshot({ watch: false })
  const first = watchSentFor !== host
  if (first) {
    watchKeys++
    watchPlan = host.watchPlan()
  }
  watchSentAt = now
  watchSentFor = host
  if (watchPlan) {
    // the bytes, and the layout with the first of them: the main thread reads a value where it is (core/watchTable.ts)
    const watchBytes = watchPlan.memory.slice(0)
    transfer.push(watchBytes)
    return { ...host.snapshot({ watch: false }), watchBytes, watchKeys, ...(first ? { watchLayout: watchPlan.layout } : {}) }
  }
  return { ...host.snapshot(), watchKeys }
}

function plcFaultMsg(err: unknown): WorkerToMain {
  return err instanceof StError
    ? { type: 'plcFault', message: err.message, line: err.pos.line, col: err.pos.col, offset: err.pos.offset }
    : { type: 'plcFault', message: String(err instanceof Error ? err.message : err) }
}

// Which Jolt build to load. Default: '/wasm' = SIMD-enabled build with a separate .wasm file
// (vs the bare 'jolt-physics' = 'wasm-compat', which is SIMD-off and base64-embedded; SIMD
// ships in every target browser, Safari since 16.4). Opt-in via ?joltthreads (passed
// as the Worker's `name` by SimClient; a worker's own location.search is the script URL, not
// the page): '/wasm-multithread' = SIMD + pthreads, Jolt's job system fanned out over real
// threads. pthreads need SharedArrayBuffer, which only exists in a cross-origin isolated
// context (COOP/COEP), so a non-isolated context falls back to the single-thread build rather
// than failing init.
// name tokens (set by SimClient): 'jolt[-threads][-raw][-jsconv][-perfparts]'
const threadsRequested = self.name.includes('-threads')
const threaded = threadsRequested && globalThis.crossOriginIsolated === true
// ?joltraw - bench-only raw-solver mode: SimWorld skips the contact listener (which the
// multithreaded build cannot run in JS form at all: Jolt fires contact callbacks on its pthread
// job threads, and each pthread is an isolated JS realm where the listener object doesn't exist)
// and disables sleeping, so an A/B of identical scenes measures pure solver scaling.
const benchRaw = self.name.includes('-raw')
// ?jsconveyor - force the per-contact JS listener even when the forked build's native
// ConveyorContactListener is available (rollback hatch / A-B lever; see SimWorld ctor)
const forceJsListener = self.name.includes('-jsconv')
// ?perfparts - opt into the O(parts) profiling timers (per-part script/rig cost + the beams/zones
// sub-phases). Off by default: a worker performance.now() is ~350 ns and these fire per part per step,
// so with them on ~1.4 us of every part's reported script cost is the measurement itself.
const perfParts = self.name.includes('-perfparts')

function getJolt(): Promise<JoltModule> {
  if (!joltPromise) {
    joltPromise = (async () => {
      if (threadsRequested && !threaded)
        console.warn('[sim] ?joltthreads requested but this context is not cross-origin isolated (missing COOP/COEP headers?) - using the single-thread Jolt build')
      const initJolt = threaded
        ? (await import('jolt-physics/wasm-multithread')).default
        : (await import('jolt-physics/wasm')).default
      // the multithread entry ships its own (structurally identical) declaration of the API
      const jolt = (await initJolt()) as unknown as JoltModule
      post({
        type: 'ready',
        joltVariant: threaded ? 'wasm-multithread' : 'wasm',
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
        conveyorListener: benchRaw ? 'none' : forceJsListener || !('ConveyorContactListener' in jolt) ? 'js' : 'native',
      })
      return jolt
    })()
    // a failed init must not poison every later start
    joltPromise.catch(() => {
      joltPromise = null
    })
  }
  return joltPromise
}

async function handle(msg: MainToWorker): Promise<void> {
  try {
    const jolt = await getJolt()
    if (msg.type === 'warmup') {
      // getJolt() above compiled the Jolt WASM; nothing else to do - the next
      // Play skips the cold start
    } else if (msg.type === 'start') {
      stopLoop()
      world?.dispose()
      world = null // a throw from the constructor below leaves no reference to the world just disposed
      paused = false
      plc = null // fresh world, fresh program: the controller's attach message follows its 'start'
      stepMsTotal = stepMsMax = stepsDone = frameMsTotal = framesDone = plcMsTotal = 0
      resetFrameWire()
      stepQueue = [] // the client drops its waiters on start and stop: nothing to answer
      // This worker outlives its runs. A run knows only the packages its scene hands it (SimWorld registers them), so
      // a part whose package the scene lacks fails the same way on every run, not just when no earlier run had it.
      clearPackages()
      world = new SimWorld(jolt, msg.scene, { benchRaw, forceJsListener, perfParts, hz: msg.hz })
      liveScene = msg.scene
      // ...but don't step it yet when the caller says it has more to send. Ownership ('setDrivenTags') and
      // the program ('runProgram') are separate messages, and a behavior that ticks before they arrive reads
      // an unfurnished world (see 'beginStepping' in protocol.ts for what goes wrong).
      if (!msg.deferStepping) startLoop()
    } else if (msg.type === 'beginStepping') {
      // idempotent, and a no-op once the world is gone: a stop between 'start' and here must take precedence
      if (world && intervalId === null) startLoop()
    } else if (msg.type === 'update') {
      // live edit: reconcile the running world in place, keeping spawned boxes
      world?.updateScene(msg.scene, msg.syncPackages)
      liveScene = msg.scene
    } else if (msg.type === 'updatePatch') {
      if (liveScene) {
        liveScene = applyScenePatch(liveScene, msg)
        world?.updateScene(liveScene)
      }
    } else if (msg.type === 'adopt') {
      world?.adopt(msg.bodyId, msg.partId)
    } else if (msg.type === 'moveBody') {
      world?.moveBody(msg.partId, msg.position, msg.rotation)
    } else if (msg.type === 'freezeBody') {
      world?.freezeBody(msg.partId, msg.frozen)
    } else if (msg.type === 'holdBody') {
      world?.holdBody(msg.partId, msg.held)
    } else if (msg.type === 'setHoldTarget') {
      world?.setHoldTarget(msg.partId, msg.position, msg.rotationY)
    } else if (msg.type === 'setPilotBody') {
      world?.setPilotBody(msg.position)
    } else if (msg.type === 'grabBody') {
      world?.grabBody(msg.bodyId)
    } else if (msg.type === 'setGrabbedPose') {
      world?.setGrabbedPose(msg.bodyId, msg.position, msg.quat)
    } else if (msg.type === 'releaseBody') {
      world?.releaseBody(msg.bodyId)
    } else if (msg.type === 'setPaused') {
      // hold the world but stop stepping; the loop keeps running so resume is instant
      paused = msg.paused
      // a resume ends the steps still queued. Pausing again while paused (the page hiding) keeps them.
      if (!paused) endSteps(stepQueue.splice(0), true)
    } else if (msg.type === 'step') {
      const req: StepRequest = { left: msg.steps ?? 1, done: 0, ...(msg.until !== undefined ? { until: msg.until } : {}), ...(msg.seq !== undefined ? { seq: msg.seq } : {}) }
      if (paused && world) stepQueue.push(req)
      else endSteps([req], true)
    } else if (msg.type === 'inspectCargo') {
      if (world) {
        const { ids, velocities } = world.cargoVelocities()
        const touching = [...world.cargoContacts()]
        post({ type: 'cargoDetail', seq: msg.seq, simTime: world.stepCount / world.hz, ids, velocities, touching }, [ids.buffer, velocities.buffer])
      } else {
        post({ type: 'cargoDetail', seq: msg.seq, simTime: 0, ids: new Uint32Array(0), velocities: new Float32Array(0), touching: [] })
      }
    } else if (msg.type === 'setTimeScale') {
      // applied live by the running loop on its next tick
      timeScale = msg.scale
    } else if (msg.type === 'setTags') {
      // PLC→part from the external PLCs' links: held beside the in-worker program's outputs for behaviors to read next step
      world?.setBehaviorLinkTags(msg.tags)
    } else if (msg.type === 'forceTag') {
      plc?.force(msg.name, msg.value)
    } else if (msg.type === 'setForces') {
      plc?.setForces(msg.forces)
    } else if (msg.type === 'resetScanTimes') {
      plc?.resetScanTimes()
    } else if (msg.type === 'setDrivenTags') {
      // output ownership: which global tags the attached controller drives (ctx.tagDriven)
      world?.setBehaviorDrivenTags(msg.tags)
    } else if (msg.type === 'usePart') {
      world?.usePart(msg.partId) // C-interaction: pulse the part's ctx.used() next tick
    } else if (msg.type === 'runProgram') {
      // attach (or live re-attach): compile here and scan in the step loop. The main thread already
      // compiled this source for validation, so a failure is a backstop - report it and stay detached.
      try {
        plc = new PlcGroup(msg.runs)
      } catch (err) {
        plc = null
        post(plcFaultMsg(err))
      }
    } else if (msg.type === 'stopProgram') {
      plc = null
    } else if (msg.type === 'writePlcVars') {
      plc?.write(msg.values)
    } else if (msg.type === 'setScanPeriod') {
      plc?.setPeriod(msg.periodSec)
    } else if (msg.type === 'rebindProgram') {
      plc?.rebind(msg.wired, msg.controller ?? null)
    } else {
      stopLoop()
      paused = false
      stepQueue = []
      plc = null
      world?.dispose()
      world = null
      liveScene = null
      resetFrameWire()
    }
  } catch (err) {
    stopLoop()
    paused = false
    stepQueue = []
    plc = null
    // free the Jolt world and its behaviors; a throw from the teardown must not hide the error that got us here
    try {
      world?.dispose()
    } catch (disposeErr) {
      console.warn('[sim] dispose after a handler error threw', disposeErr)
    }
    world = null
    liveScene = null
    resetFrameWire()
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function startLoop(): void {
  // the world's own rate: startLoop only ever follows a fresh `new SimWorld` ('start'), which fixes it
  const hz = world?.hz ?? DEFAULT_SIM_HZ
  const stepMs = 1000 / hz
  const stepSec = 1 / hz
  let last = performance.now()
  let acc = 0
  // set while paused; consumed on the first step after a resume to resync the clock
  let wasPaused = false
  let aliveAt = 0
  intervalId = setInterval(() => {
    if (progress) Atomics.add(progress, 0, 1)
    const w = world
    if (!w) return
    // paused: keep the loop alive but don't step; bump `last` so time doesn't accrue
    if (paused) {
      last = performance.now()
      wasPaused = true
      if (!progress && last - aliveAt >= ALIVE_MS) {
        aliveAt = last
        post({ type: 'alive' })
      }
      if (stepQueue.length > 0) {
        heldDirty = false // the stepped frame shows any held edit too
        try {
          const ended: StepRequest[] = []
          const t0 = performance.now()
          while (stepQueue.length > 0) {
            const req = stepQueue[0]!
            if (req.until !== undefined ? w.stepCount / hz + 1e-9 >= req.until : req.left <= 0) {
              ended.push(stepQueue.shift()!)
              continue
            }
            if (performance.now() - t0 >= STEP_TICK_BUDGET_MS) break
            advance(w, stepSec)
            req.left--
            req.done++
          }
          postFrame(w, true, true)
          endSteps(ended, false)
        } catch (err) {
          stopLoop()
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      // Nothing steps, but a held edit still changed the world: a gizmo drag teleports a body, a live
      // edit adds or removes cargo, a promotion adopts one. Publish that unstepped, or the view, the
      // gizmo anchor and every live pick keep reading the pre-pause frame - the dragged box stays
      // put under a gizmo that won't follow, then jumps to where it was dropped the moment Play resumes.
      if (heldDirty) {
        heldDirty = false
        try {
          postFrame(w, true)
        } catch (err) {
          stopLoop()
          post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      }
      return
    }
    try {
      const now = performance.now()
      if (wasPaused) {
        // First step after a resume (typically a tab refocus). While the tab was hidden this
        // interval was throttled to ~1s, so (now - last) from the last paused tick would accrue
        // that whole gap here and lurch physics forward. Resync the clock so physics resumes
        // from the refocus instant with zero accrued backlog. The PLC scan interleaves on the
        // fixed step dt inside this loop (PlcHost), so it is co-timed by construction: no steps
        // accrued means no scans accrued. See controller.onVisibilityChange / docs/sim-clock.md.
        last = now
        acc = 0
        wasPaused = false
      }
      // scale real elapsed time by the speed multiplier: >1 accrues faster (more steps
      // per tick → fast-forward), <1 slower (fewer → slow-motion). Each step still feeds
      // Jolt the world's fixed dt, so the solver stays stable at any speed.
      acc += (now - last) * timeScale
      last = now
      // catch-up cap (anti death-spiral): ~50 ms of real-time headroom, scaled by the speed and the step
      // rate, so a sped-up or faster-stepping world can still run its extra steps but a machine that can't
      // keep up sheds backlog instead of spiralling (sim/catchUp.ts says why it must scale with the rate)
      const maxSteps = catchUpSteps(timeScale, hz)
      let steps = 0
      while (acc >= stepMs && steps < maxSteps) {
        advance(w, stepSec)
        acc -= stepMs
        steps++
      }
      if (acc >= stepMs) acc = 0
      if (steps === 0) return
      postFrame(w, false)
    } catch (err) {
      stopLoop()
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, 8)
}

/** answer the step requests that asked for an answer (a `seq`) */
function endSteps(reqs: readonly StepRequest[], interrupted: boolean): void {
  const simTime = world ? world.stepCount / world.hz : 0
  for (const r of reqs) {
    if (r.seq === undefined) continue
    post({ type: 'stepped', seq: r.seq, simTime, steps: r.done, ...(interrupted ? { interrupted: true as const } : {}) })
  }
}

/** one fixed step: the PLC scans that fall due, then physics. The running loop and a paused Step both come here. */
function advance(w: SimWorld, stepSec: number): void {
  // Interleave the PLC scan before each step, on the fixed step dt (sim time): the scan reads
  // the tags behaviors wrote last step and its outputs apply to the step about to run. The
  // same lockstep as the headless project-test runner, exactly reproducible at any frame
  // rate or timeScale (see PlcHost). A runtime scan fault drops the program to STOP (detach +
  // report) without touching the physics loop, like a faulted PLC leaving the machine powered.
  if (plc) {
    const tp = performance.now()
    try {
      plc.interleave(w, stepSec)
    } catch (err) {
      plc = null
      post(plcFaultMsg(err))
    }
    plcMsTotal += performance.now() - tp
  }
  const t0 = performance.now()
  w.step()
  const dt = performance.now() - t0
  stepMsTotal += dt
  if (dt > stepMsMax) stepMsMax = dt
  stepsDone++
}

// partIds + dressings go out only when they changed (frameWire.ts); reset whenever the world is rebuilt or
// dropped, so a new world's first frame carries both in full
const frameWire = new FrameWireEncoder()
function resetFrameWire(): void {
  frameWire.reset()
  plcIoSentFor = null
}

/**
 * snapshot the world and ship it to the main thread. `held` = published while paused (a held edit or a Step);
 * `fullWatch` = carry the variable table even inside its 1/WATCH_HZ window, so a Step shows the values it made.
 */
function postFrame(w: SimWorld, held: boolean, fullWatch = false): void {
  const plcTransfer: Transferable[] = []
  const tf = performance.now()
  const f = w.frame()
  const flowFacts = w.drainFlowFacts()
  frameMsTotal += performance.now() - tf
  framesDone++
  post(
    {
      type: 'frame',
      count: f.count,
      simTime: f.simTime,
      ids: f.ids,
      positions: f.positions,
      quats: f.quats,
      halfExtents: f.halfExtents,
      colors: f.colors,
      kinds: f.kinds,
      caps: f.caps!,
      ...frameWire.encode(f.partIds, f.dressings, f.shapes, f.shapeRefs),
      ...frameWire.encodeRecords(f),
      ...(held ? { paused: true as const } : {}),
      ...(plc ? { plc: plcFrame(plc, fullWatch, plcTransfer) } : {}),
      ...(flowFacts.length > 0 ? { flowFacts } : {}),
      stepStats: { totalMs: stepMsTotal, steps: stepsDone, maxMs: stepMsMax, frameTotalMs: frameMsTotal, frames: framesDone, plcTotalMs: plcMsTotal, ...(plc ? { plcSplit: { ...plc.perf } } : {}), worstStep: { ...w.worstStep }, overBudgetSteps: w.overBudgetSteps, ...(w.perfParts ? { worstScriptCall: { ...w.worstScriptCall } } : {}), phases: { ...w.phaseMs, ...w.scriptPerf() }, scriptMsByPart: Object.fromEntries(w.scriptMsByPart), rigMsByPart: Object.fromEntries(w.rigMsByPart), ...w.bodyStats() },
    },
    [
      f.ids.buffer as ArrayBuffer,
      f.positions.buffer as ArrayBuffer,
      f.quats.buffer as ArrayBuffer,
      f.halfExtents.buffer as ArrayBuffer,
      f.colors.buffer as ArrayBuffer,
      f.kinds.buffer as ArrayBuffer,
      f.caps!.buffer as ArrayBuffer,
      ...plcTransfer,
    ],
  )
}

function stopLoop(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

export {}
