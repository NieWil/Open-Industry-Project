import type { PartInstance, SceneJSON, SimRate } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'
import type { CargoShapeRef, FrameBeamHit, FrameDressing } from '../core/frame'
import type { FlowFact } from '../core/flow/flowFacts'
import type { SubPose } from '../core/rig/rigPose'
import type { PartDiagnosticsEvent } from '../core/parts/partDiagnostics'
import type { FrameRecordField, RecordPatch } from './frameWire'
import type { PlcFrameSent } from './plcHost'
import type { WiredBindings } from '../plc/link/plcLink'
import type { PlcRun } from './plcGroup'
import type { TagValue } from '../plc/types'

export type MainToWorker =
  | { type: 'warmup' }
  // the page's hang beacon (core/parts/partScript.ts setPartCallBeacon): part code marks itself in it, so a page that
  // stops getting frames can name the part the worker is stuck in. `progress` counts the step loop's ticks, which the
  // page's watchdog (sim/client.ts) reads as a sign of life while a paused loop sends no frames. Sent once, before
  // anything else.
  | { type: 'beacon'; buffer: SharedArrayBuffer; progress: SharedArrayBuffer }
  // hz: the scene's physics step rate (EditorState.simHz). Fixed for the world's lifetime, so a rate
  // change applies on the next start; a mid-run change would make one run two different machines.
  // deferStepping: build the world but don't start the loop; the caller sends 'beginStepping' once it has
  // finished furnishing it (see that message).
  | { type: 'start'; scene: SceneJSON; hz: SimRate; deferStepping?: boolean }
  // Release a world started with `deferStepping`. The frame-1 problem it exists for: 'setDrivenTags' and
  // 'runProgram' are posted after 'start', so a world that began stepping on arrival would run its first
  // behavior tick with an empty driven set, and every comms part reading `tagDriven(tag) ? readTag(tag) :
  // manual` would take its authored state for that frame. Harmless for a conveyor; for a spawner that frame
  // is a body. Without the hold, the demo's pallet magazine drops a pallet into the load standing on the build
  // deck on every run.
  | { type: 'beginStepping' }
  // syncPackages: this update's embedded packages are fresh registry copies (a hot-reload push); re-register
  // them worker-side; registerPackage bumps a rev only on real content change, and partSignature folds the rev
  // in, so exactly the changed packages' parts rebuild (the running-sim half of the part hot-reload; the render
  // half is onPackagesChanged → refreshPackage). Omitted for an ordinary live scene edit, whose embedded
  // packages are stale snapshots that must not overwrite a previously hot-reloaded one.
  | { type: 'update'; scene: SceneJSON; syncPackages?: boolean }
  // An ordinary live edit that kept the part list's ids and order (a drag, an Inspector scrub): only the
  // parts whose object changed, by index, applied over the scene the worker last received ('start',
  // 'update' or a previous patch). `packages` rides only when the embedded set changed. The worker
  // reassembles the whole scene and reconciles it exactly like 'update'. This only saves cloning the
  // untouched parts and packages, which a drag would otherwise do per pointer move (SimClient.update).
  | { type: 'updatePatch'; changes: [index: number, part: PartInstance][]; packages?: PartPackage[] }
  | { type: 'adopt'; bodyId: number; partId: string }
  | { type: 'moveBody'; partId: string; position: [number, number, number]; rotation: [number, number, number, number] | null }
  | { type: 'freezeBody'; partId: string; frozen: boolean }
  | { type: 'holdBody'; partId: string; held: boolean }
  | { type: 'setHoldTarget'; partId: string; position: [number, number, number]; rotationY: number }
  | { type: 'setPilotBody'; position: [number, number, number] | null }
  | { type: 'grabBody'; bodyId: number }
  | { type: 'setGrabbedPose'; bodyId: number; position: [number, number, number]; quat: [number, number, number, number] }
  | { type: 'releaseBody'; bodyId: number }
  | { type: 'setPaused'; paused: boolean }
  // while paused: advance fixed physics steps, with the PLC scans that fall due in them. `steps` (default 1), or
  // `until`: step until the sim time reaches it. A long request runs over several loop ticks, posting a frame
  // after each. With `seq`, the worker answers 'stepped' when the request ends: done, refused because the world
  // was running, or cut short by a resume. Ignored while running.
  | { type: 'step'; steps?: number; until?: number; seq?: number }
  // what the frame cannot carry about each cargo body: its velocity and what it touches. Answered with 'cargoDetail'.
  | { type: 'inspectCargo'; seq: number }
  | { type: 'setTimeScale'; scale: number }
  // the PLC→part half of the device-IO bus, injected from the main thread: tag values fed to custom-part
  // behaviors as the tags they read (ctx.readTag/readNumber). The local program's scans do not route
  // through here (they interleave in-worker: 'runProgram'); this is the direct-injection seam for test
  // hooks and a future remote-PLC (WsPlcLink) per-frame process-image exchange.
  | { type: 'setTags'; tags: Record<string, number | boolean> }
  // one variable of the running program written between scans: the ladder's toggle bit (Ctrl+T)
  | { type: 'forceTag'; name: string; value: number | boolean }
  // the running program's held forces, the whole table each time ({} releases them all; PlcHost.setForces)
  | { type: 'setForces'; forces: Record<string, number | boolean> }
  // start the running program's scan-time averages and maxima over (the Watch dock's Reset; PlcHost.resetScanTimes)
  | { type: 'resetScanTimes' }
  // Output-ownership half of the bus: the global tag keys the attached controller drives (its declared program
  // outputs, alias-lifted). Static per program, so it's pushed once on attach and cleared ([]) on detach.
  // Behaviors read it as ctx.tagDriven to decide auto (tag-commanded) vs hand-operated mode.
  | { type: 'setDrivenTags'; tags: string[] }
  // C-interaction: a pilot-mode "use" on a custom interactive part; the worker pulses ctx.used() next tick.
  | { type: 'usePart'; partId: string }
  // Attach a compiled-on-arrival ST program to the running world: the worker compiles the source and
  // interleaves its fixed-period scans between physics steps (PlcHost). The main thread validated the
  // same source first (it throws StError at the caller), so a worker-side compile error is a backstop.
  // `wired`: the scene's bindings by wiring (plc/wiring.ts wiredBindings), which the main thread works out,
  // since the scene's parts are there
  // `runs`: one for each controller the simulator runs, each its own program (sim/plcGroup.ts)
  | { type: 'runProgram'; runs: PlcRun[] }
  // the scene was rewired while the program runs: bind one controller's anew in place, keeping its state (PlcHost.rebind)
  | { type: 'rebindProgram'; wired: WiredBindings; controller?: string }
  // detach the ST program (Stop / program panel Detach); behaviors idle on their next step
  | { type: 'stopProgram' }
  // write the attached program's variables by name before its next scan: an HMI or SCADA writing a PLC's
  // tags (a Start button, a setpoint), through the simulator's OPC UA server (editor/links/opcUaServer.ts)
  | { type: 'writePlcVars'; values: Record<string, TagValue> }
  // retune the attached program's scan (cycle) time live, from the ST editor's scan-ms field
  | { type: 'setScanPeriod'; periodSec: number }
  | { type: 'stop' }

/** cumulative physics step-cost counters since run start - window-diff two frames' values to
 *  get avg step cost over the window (e2e/threaded-jolt-bench.mjs, StatsOverlay's `phys` line).
 *  bodies includes statics; active = awake rigid bodies (validates that a bench's cargo hasn't
 *  gone to sleep). frameTotalMs/frames time world.frame() - the per-body WASM-getter walk that
 *  builds the frame arrays - measured separately from stepping to size a native batch-snapshot
 *  candidate. plcTotalMs times the interleaved ST scans (PlcHost) - also separate, so the
 *  bench's step numbers stay Jolt-only. */
export type StepStats = {
  totalMs: number
  steps: number
  maxMs: number
  bodies: number
  active: number
  /** how many behavior scripts / rigs the per-step loops iterate (fixed per scene) */
  behaviorCount: number
  rigCount: number
  /** cumulative per-part cost maps (ms), keyed by part id ('#anon' for keyless attaches): script =
   *  that part's stepDirect body (subset of phases.script), rig = its RigDriver.drive iteration
   *  (subset of phases.drives). Window-diff to rank which parts the step budget goes to. */
  scriptMsByPart: Record<string, number>
  rigMsByPart: Record<string, number>
  frameTotalMs: number
  frames: number
  plcTotalMs: number
  /** cumulative split of plcTotalMs (PlcHost.perf): tag writes latched in / the scans / the image handed back.
   *  Absent while no program is attached. */
  plcSplit?: { inputsMs: number; scanMs: number; imageMs: number; scans: number }
  /** the slowest single step() since the world was built, split by phase (SimWorld.worstStep), and how many
   *  steps overran one 60 Hz frame. What averages hide: one long step is a freeze however low the mean. */
  worstStep?: { ms: number; step: number; boxes: number; cull: number; behaviors: number; drives: number; facets: number; solver: number }
  overBudgetSteps?: number
  /** the slowest single part script call since build (?perfparts only; SimWorld.worstScriptCall) */
  worstScriptCall?: { ms: number; partId: string; step: number }
  /** cumulative per-phase split of the step cost (all ms). beams/zones/script are subsets of
   *  behaviors (sensing casts + the behavior.stepDirect body both run inside tickBehaviors); the
   *  other phases partition step() end to end, so cull+behaviors+drives+facets+solver ≈ totalMs
   *  (minus timer overhead). behaviors − beams − zones − script = the host loop's own overhead. */
  phases: {
    cull: number
    behaviors: number
    beams: number
    zones: number
    script: number
    /** split of `script` from the behavior runtime: input-refresh churn (prevTags/inTags/driven/beams/
     *  zones), remaining pre-step setup, and the script body's own step() */
    scriptTags: number
    scriptSetup: number
    scriptBody: number
    drives: number
    facets: number
    solver: number
    /** collecting the flow facts (sim/flowFacts.ts), between behaviors and drives */
    flow: number
  }
}

export type WorkerToMain =
  | {
      type: 'ready'
      /** which Jolt build initialized: 'wasm' (single-thread) or 'wasm-multithread' (?joltthreads + isolation) */
      joltVariant: 'wasm' | 'wasm-multithread'
      crossOriginIsolated: boolean
      hardwareConcurrency: number
      /** which contact-listener path worlds will use: 'native' (forked build's C++ ConveyorContactListener),
       *  'js' (per-contact ContactListenerJS - stock build or ?jsconveyor), 'none' (?joltraw bench mode) */
      conveyorListener: 'native' | 'js' | 'none'
    }
  | {
      type: 'frame'
      count: number
      simTime: number
      ids: Uint32Array
      positions: Float32Array
      quats: Float32Array
      halfExtents: Float32Array
      colors: Float32Array
      kinds: Uint8Array
      caps: Uint8Array
      // sent only as far as they changed: see frameWire.ts. One of `partIds` / `partIdsKept` is always
      // present; neither `dressings` nor `dressingsPatch` = nothing is dressed.
      partIds?: readonly (string | null)[]
      partIdsKept?: true
      // The records by part cross only as far as they changed too (frameWire.ts FRAME_RECORDS): each is here whole,
      // or patched in `recordPatches`, or named in `recordsKept`; none of the three = the frame has no such record.
      joints?: Record<string, Record<string, number>>
      subPoses?: Record<string, Record<string, SubPose>>
      copySpeeds?: Record<string, Record<string, number[]>>
      lamps?: Record<string, Record<string, boolean>>
      values?: Record<string, Record<string, number | boolean>>
      displays?: Record<string, Record<string, number | boolean | string>>
      tags?: Record<string, Record<string, number | boolean>>
      basePoses?: Record<string, { pos: [number, number, number]; yaw: number }>
      conveyorSpeeds?: Record<string, number>
      beamHits?: Record<string, Record<string, FrameBeamHit>>
      recordsKept?: readonly FrameRecordField[]
      recordPatches?: Partial<Record<FrameRecordField, RecordPatch>>
      dressings?: readonly Readonly<FrameDressing>[]
      dressingsPatch?: { length: number; changed: [number, Readonly<FrameDressing>][] }
      // each body's own shape key, and the shapes the client has not had yet (frameWire.ts); none = no body has one
      shapes?: readonly (string | null)[]
      shapesKept?: true
      shapeRefsNew?: Record<string, CargoShapeRef>
      marks?: Record<string, Record<string, number | boolean | string>>
      // published while paused: a held edit (a gizmo drag teleporting a body, a live scene edit) changed the
      // world and the view has to catch up, or a Step advanced it by one step. Neither says anything about how
      // fast the sim runs, so SimClient keeps it out of the rate clock, where it would read as a stalled sim.
      paused?: true
      // in-worker PLC state (watch / %I / %Q / scan telemetry), present while a program is attached -
      // the main thread's watch table and IO monitor render from this, at frame cadence
      plc?: PlcFrameSent
      // Flow facts (core/flow/flowFacts.ts) collected by the steps since the last posted frame: what physically happened to
      // the cargo (dropped, lost, tipped, a sensor flicker, a stall). The sim computes them every step and ships them
      // batched here, so none is lost to the frame cadence. A fact that unfolds (a stall) is sent when it starts and
      // again, same `id`, when it ends: keep the latest record per id (SimClient.flowFacts). Absent = none new.
      flowFacts?: FlowFact[]
      stepStats: StepStats
    }
  // a paused loop's sign of life, about once a second, sent only where memory cannot be shared (no 'beacon' progress
  // counter): a paused world sends no frames, and the page's watchdog would take its silence for a hang
  | { type: 'alive' }
  // the end of a 'step' that carried a `seq`: the sim time reached and the steps taken. `interrupted`: a resume (or a
  // world that was running) ended it before it was done. Posted after the frame that shows the last step.
  | { type: 'stepped'; seq: number; simTime: number; steps: number; interrupted?: true }
  // the answer to 'inspectCargo', index-aligned with the frame the world would post now: `ids` names each row,
  // `velocities` is m/s (x, y, z per row; a unit load's pieces share the load's body), and `touching` lists what
  // each body touches, by id (sim/cargoContacts.ts)
  | { type: 'cargoDetail'; seq: number; simTime: number; ids: Uint32Array; velocities: Float32Array; touching: [id: number, touching: string[]][] }
  | { type: 'error'; message: string }
  // a custom-part runtime diagnostic (core/parts/partDiagnostics) raised inside the worker; the sim's module
  // instance is separate from the main thread's, so events are mirrored across for the editor to surface
  | { type: 'partDiagnostics'; event: PartDiagnosticsEvent }
  // the attached ST program faulted (a runtime scan fault, or a backstop compile failure) - the worker
  // already dropped to STOP (program detached); the editor mirrors the detach and surfaces the message
  | { type: 'plcFault'; message: string; line?: number; col?: number; offset?: number }
