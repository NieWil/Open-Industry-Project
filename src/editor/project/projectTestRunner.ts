// The headless project-test runner (docs/project-tests.md): step a scene's physics + its ST program
// forward in simulated time and feed the observed tags to the core evaluator. It lives in the editor
// layer for the same reason controller.ts does - this is the only layer allowed to import both the
// sim (SimWorld) and the PLC engine (LocalPlcLink); core/sim/plc each ban the others. It has no UI
// and no React; the CLI (scripts/test-project.mjs) and tests call it directly.
//
// The PLC↔sim seam is the custom-part tag bus, not the built-in binding adapter (which reads
// render-side sensor beams and is not headless): SimWorld itself casts sensor beams and lets each
// part write its detections/state as tags (world.frame().tags), while PLC outputs + scheduled test
// inputs flow back in via setBehaviorInputTags. That is the same path every first-party part uses -
// the whole catalog is authored on the SDK (docs/architecture.md).

import { dialectRefusal, isKnownDialect } from '../../core/dialect'
import { registerPackage } from '../../core/parts/partRegistry'
import { SCENE_VERSION, toSimRate } from '../../core/types'
import type { SceneJSON, SimRate } from '../../core/types'
import type { ProjectJSON } from '../../core/project/project'
import type { BoxFrame } from '../../core/frame'
import type { FlowFact } from '../../core/flow/flowFacts'
import { cargoInZone, ProbeSampler } from '../../core/project/projectProbe'
import type { FrameExtras } from '../../core/project/projectProbe'
import { describeFault, faultActive, FaultInjector, probePartErrors, TestEvaluator } from '../../core/project/projectTest'
import type { ResolvedFault, TestFault, TestResult, TestSpec, TestValue, TraceRecorder } from '../../core/project/projectTest'
import { packageParamSpecs } from '../../core/packageParams'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { deviceTags } from '../../plc/bindings'
import { canonicalAddress, looksLikeAddress } from '../../core/io/iecAddress'
import { SimWorld } from '../../sim/world'
import { MAX_SCANS_PER_STEP } from '../../sim/plcHost'
import { DEFAULT_SCAN_MS } from '../program/stProgram'
import { LocalPlcLink } from '../../plc/link/plcLink'
import { wiredBindings } from '../../plc/wiring'
import { controllerFor, controllerRuns, runnableSource } from '../../plc/controller'
import { controllerTag, partsForController, tagsForController } from '../../core/io/controllerTag'
import { sceneSettings } from '../../core/scene/scenePlcs'
import type { Controller } from '../../core/controller'
import { TaskScheduler } from '../../plc/scanEngine'
import { SimController } from '../../plc/simController'
type JoltModule = ConstructorParameters<typeof SimWorld>[0]

const EPS = 1e-9

/** Merge every part's tag map into one flat table. */
function flattenTags(tags: Readonly<Record<string, Record<string, unknown>>> | undefined): Record<string, TestValue> {
  const out: Record<string, TestValue> = {}
  if (!tags) return out
  for (const perPart of Object.values(tags)) {
    for (const [k, v] of Object.entries(perPart)) {
      if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    }
  }
  return out
}

/** The project's scene, with its packages registered so the world can build its custom parts. Mirrors the app's
 *  boot: authored library authoritative, the scene's own snapshots non-authoritative. */
function prepareScene(project: ProjectJSON): { scene: SceneJSON; stProgram: string; controller?: Controller; stScanMs?: number; hz: SimRate } {
  const ps = project
  // a program in a dialect this build does not have is refused, as Play refuses it, never stepped as IEC: a test
  // that "passed" on whatever part of it parsed would be a verdict about a program nobody wrote
  if (ps.stDialect !== undefined && !isKnownDialect(ps.stDialect)) throw new Error(dialectRefusal(ps.stDialect))
  for (const pkg of project.packages ?? []) registerPackage(pkg, true)
  for (const pkg of ps.scene.packages ?? []) registerPackage(pkg, false)
  return {
    // the scene's settings come along: its controllers say which ones the simulator runs
    scene: { version: SCENE_VERSION, parts: ps.scene.parts, ...sceneSettings(ps.scene) },
    stProgram: ps.stProgram ?? '',
    ...(ps.controller ? { controller: ps.controller } : {}),
    ...(ps.stScanMs !== undefined ? { stScanMs: ps.stScanMs } : {}),
    // the rate of the scene under test, which is the rate Play steps it at
    hz: toSimRate(ps.simHz),
  }
}

/** One device's wired tag fields with their keys, read the way the sim reads them: the package defaults under the
 *  scene's params, an address in its one spelling. Null for a part that is not a device or has comms off. */
function wiredFields(part: PartInstance): { key: string; section: 'VAR_INPUT' | 'VAR_OUTPUT' | null; type: string | null }[] | null {
  const packageId = part.type === 'part' ? part.packageId : undefined
  const pkg = packageId ? getPackage(packageId) : undefined
  if (!pkg) return null
  const defaults: Record<string, unknown> = {}
  for (const spec of packageParamSpecs(pkg)) defaults[spec.key] = spec.default
  const params = { ...defaults, ...((part.params as Record<string, unknown> | undefined) ?? {}) }
  const [device] = deviceTags([{ id: part.id, type: part.type, packageId, params }])
  if (device && !device.enabled) return null
  const keyOf = (v: string): string => (looksLikeAddress(v) ? (canonicalAddress(v) ?? v) : v)
  return (device?.fields ?? []).filter((f) => f.value !== '').map((f) => ({ key: keyOf(f.value), section: f.section, type: f.type }))
}

const offValue = (type: string | null): TestValue => (type === 'BOOL' ? false : 0)

/**
 * Resolve each fault against the scene: which tag keys it forces, and to what. A fault names a device, so
 * its tags come from what the device's package declares - its `'tag'` params with a direction - read the way the
 * sim reads them (the param's default when the scene leaves it unset).
 * Anything that would make the fault touch nothing is an error, not a quiet no-op: a fault that silently does
 * nothing makes every check after it pass for the wrong reason. `programInputs` (the attached program's inputs)
 * lets a comms loss's status bit be checked the same way: a bit the program never reads is a typo.
 */
export function resolveFaults(parts: readonly PartInstance[], faults: readonly TestFault[], programInputs?: readonly string[]): ResolvedFault[] {
  if (faults.length === 0) return []
  return faults.flatMap((fault, i): ResolvedFault[] => {
    // a jam is physical: it touches no tag, and the runner applies it to the world itself
    if (fault.kind === 'jam') return []
    const at = `faults[${i}] (${describeFault(fault)})`
    // the devices it acts on: the named one (which must exist and speak tags), or for a network loss every one that does
    let fields: NonNullable<ReturnType<typeof wiredFields>>
    if (fault.part !== undefined) {
      const part = parts.find((p) => p.id === fault.part)
      if (!part) throw new Error(`${at}: no part "${fault.part}" in the scene`)
      const own = wiredFields(part)
      if (own === null) {
        const device = part.type === 'part' && part.packageId && getPackage(part.packageId)
        throw new Error(device ? `${at}: the part's comms are off, so none of its tags reach the program` : `${at}: the part is not a device with a PLC interface`)
      }
      fields = own
    } else fields = parts.flatMap((p) => wiredFields(p) ?? [])

    const toPlc: Record<string, TestValue> = {}
    const toPart: Record<string, TestValue> = {}
    for (const f of fields) {
      if (f.section === 'VAR_INPUT' && (fault.kind === 'commsLoss' || (fault.kind === 'sensorStuck' && f.type === 'BOOL'))) {
        toPlc[f.key] = fault.kind === 'sensorStuck' ? fault.value : offValue(f.type)
      }
      if (f.section === 'VAR_OUTPUT' && fault.kind !== 'sensorStuck') toPart[f.key] = offValue(f.type)
    }
    if (Object.keys(toPlc).length + Object.keys(toPart).length === 0) {
      const what =
        fault.kind === 'sensorStuck' ? "a BOOL tag param with dir 'out'" : fault.kind === 'actuatorDead' ? "a tag param with dir 'in'" : 'a tag param with a dir'
      const who = fault.part !== undefined ? 'the part wires no tag' : 'no device in the scene wires a tag'
      throw new Error(`${at}: ${who} the ${fault.kind} fault can act on (it needs ${what}, set to a tag name)`)
    }

    if (fault.kind === 'sensorStuck') return [{ fault, side: 'toPlc', forced: toPlc }]
    if (fault.kind === 'actuatorDead') return [{ fault, side: 'toPart', forced: toPart }]
    // a comms loss fails both directions, each to its own fault state, and raises the status bit if one is named
    const out: ResolvedFault[] = []
    if (Object.keys(toPlc).length > 0) out.push({ fault, side: 'toPlc', forced: toPlc, ...(fault.inputs === 'hold' ? { hold: true } : {}) })
    if (Object.keys(toPart).length > 0) out.push({ fault, side: 'toPart', forced: toPart, ...(fault.outputs === 'hold' ? { hold: true } : {}) })
    if (fault.statusTag !== undefined) {
      const want = fault.statusTag.toUpperCase()
      const name = programInputs?.find((n) => n.toUpperCase() === want)
      if (programInputs && name === undefined) throw new Error(`${at}: statusTag "${fault.statusTag}" is not an input of the program, so it could never see it`)
      const key = name ?? fault.statusTag
      out.push({ fault, side: 'toPlc', forced: { [key]: true }, idle: { [key]: false } })
    }
    return out
  })
}

/**
 * A second program held against the scene's own through a run: attached the same way (the same wiring), given the
 * same inputs on the same clock, and never driving the scene. What proves a rewrite (the demo's ladder version of its
 * Structured Text, say) is the same machine on the run that matters, scan for scan.
 */
export interface Lockstep {
  stProgram: string
  controller?: Controller | null
  /** after every physics step that ran a scan: the watch tables of the scene's program and of this one */
  compare: (time: number, main: Readonly<Record<string, TestValue>>, other: Readonly<Record<string, TestValue>>) => void
}

/** A test's verdict, plus the flow facts of its run (core/flow/flowFacts.ts): what physically happened to the cargo
 *  (dropped, lost, tipped, a sensor flicker, a stall). Facts are never failures. On a failing run they show why;
 *  on a passing run they show what went wrong without failing a check. */
export interface ProjectTestOutcome extends TestResult {
  facts: FlowFact[]
  /** facts past the tracker's cap, counted and not kept */
  factsOverflow: number
}

/**
 * Run one test spec against a project and return the per-check verdict. `Jolt` is an initialized
 * jolt-physics module (the caller owns `await initJolt()` so the runner stays synchronous, like
 * `new SimWorld`). Deterministic: the project's fixed step rate, seeded parts, no wall-clock - the
 * same project + spec always produces the same result.
 */
/** `trace`: a recorder fed every sample the checks see (core/project/projectTest.ts `TraceRecorder`), for a caller that has to
 *  say why a check failed; the run is deterministic, so a failed test can be run again with one to see its lead-up.
 *  `onFrame`: handed every step's frame, read-only, after the checks have sampled it (where the cargo is: `--cargo`).
 *  `flowFacts: false` runs without collecting flow facts (the outcome's list is then empty). */
export function runProjectTest(
  Jolt: JoltModule,
  project: ProjectJSON,
  spec: TestSpec,
  opts?: { lockstep?: Lockstep; trace?: TraceRecorder; onFrame?: (frame: Readonly<BoxFrame>, extras: FrameExtras) => void; flowFacts?: boolean; wakeAllParts?: boolean },
): ProjectTestOutcome {
  const { scene, stProgram, controller, stScanMs, hz } = prepareScene(project)
  const badProbes = probePartErrors(scene.parts, spec.checks)
  if (badProbes.length > 0) throw new Error(badProbes.join('; '))
  // The scene's own step rate. It is the rate the editor's Play runs at, and a test
  // stepping at another one validates a different machine: sensors sampled coarser or finer, PLC
  // outputs landing a different number of milliseconds after the input that caused them.
  const world = new SimWorld(Jolt, scene, { hz, ...(opts?.flowFacts === false ? { flowFacts: false } : {}), ...(opts?.wakeAllParts ? { wakeAllParts: true } : {}) })
  // what onFrame may ask beyond the frame, each read only when asked (the cargo snapshots' contacts)
  const frameExtras: FrameExtras = { contacts: () => world.cargoContacts() }
  // The scan time Play uses: the project's own (what the editor loads, sceneFile.ts), or the editor's default when it
  // saved none. A spec's scanMs overrides it. The program runs from its own table if it has one, else a default
  // table at this time.
  const defaultMs = spec.scanMs ?? stScanMs ?? DEFAULT_SCAN_MS
  // bound as Play binds it: declared I/O, plus the program's own tags the scene's parts are wired to by name
  // Each controller the scene runs in the simulator runs its own share of the program (plc/controller.ts
  // controllerRuns), bound to its own tags, as Play runs it (sim/plcGroup.ts). The default one always runs here: a test
  // proves the program, whatever PLC a computer would hand the default controller's tags to.
  const plcs = scene.plcs ?? []
  const runs = stProgram !== '' ? controllerRuns(stProgram, controller, defaultMs, { defaultName: plcs[0]?.name, simulated: plcs.slice(1).filter((c) => c.runsOn === 'app' && c.connect).map((c) => c.name) }) : []
  const mainRun = runs.find((r) => r.controller === null)
  const declared = mainRun ? new LocalPlcLink(runnableSource(mainRun.source, mainRun.table), undefined) : null
  const plc = declared ? declared.withBindings(wiredBindings(scene.parts, declared)) : null
  const others = runs.flatMap((r) => {
    if (r.controller === null) return []
    const name = r.controller
    const own = new LocalPlcLink(runnableSource(r.source, r.table), undefined)
    const link = own.withBindings(wiredBindings(partsForController(scene.parts, name), own))
    const ctl = new SimController(link)
    return [{ name, link, ctl, scheduler: new TaskScheduler(ctl, { periodSec: defaultMs / 1000, maxCatchUp: MAX_SCANS_PER_STEP }), out: {} as Record<string, TestValue> }]
  })
  /** `tags` with `name` put on every key, as the parts spell another controller's tags */
  const named = (tags: Readonly<Record<string, unknown>>, name: string): Record<string, TestValue> =>
    Object.fromEntries(Object.entries(tags).map(([k, v]) => [controllerTag(name, k), v as TestValue]))
  // Output ownership: the other half of attaching a program, and required.
  //
  // Feeding tag values (setBehaviorInputTags, below) is only what the app's `setTags` does. Attaching also
  // ships the set of tags the controller drives (controller.ts `setDrivenTags`), which is what ctx.tagDriven
  // reads. A part whose auto mode is gated on ownership (every `autoWhenDriven` tag param) stays in hand
  // mode without it, however correct the program is.
  //
  // Without it, the demo cell's chain transfer is inert. The program pulses `Shift` for its full 2 s, and the
  // part reads the speed (that path needs only a non-empty tag) and reports speed 1. But `raised` never
  // follows, `lift` stays at 0, and the deck spins 0.03 m below the roller line under a row riding the
  // rollers. Nothing moves and no check names the transfer. The layer still forms eventually, by cases
  // shoving each other, so its timing depends on Jolt body order alone (first layer 38 s or 124 s).
  // With ownership the row lifts and crosses in 0.7 s, as authored.
  //
  // Aliases: controller.ts lifts its outputs through the scene's out-aliases first. This runner has no alias
  // bindings to apply, so the program's own output names are the global keys.
  if (plc || others.length > 0) world.setBehaviorDrivenTags([...(plc?.outputs ?? []), ...others.flatMap((o) => o.link.outputs.map((t) => controllerTag(o.name, t)))])
  const evaluator = new TestEvaluator(spec)
  const probes = new ProbeSampler(spec.checks)
  const needsMarks = probes.needsMarks
  const faults = resolveFaults(scene.parts, spec.faults ?? [], plc?.inputs)
  const injector = new FaultInjector(faults)
  // jams, each with the body it caught (null until it catches one, and again once released)
  const jams = (spec.faults ?? []).flatMap((fault, index) => (fault.kind === 'jam' ? [{ fault, index, body: null as number | null, caught: false }] : []))

  const dt = 1 / hz
  const scanPeriod = defaultMs / 1000
  // The scheduler the live sim runs (sim/plcHost.ts), so a test scans on the cadence Play does: one
  // program every `scanPeriod`, or a CONFIGURATION's tasks each on its own interval. A hand-rolled
  // accumulator that runs at most one scan per step would quietly slow every timer whenever a spec
  // asks for a scan time shorter than the step.
  const ctl = plc ? new SimController(plc) : null
  const scheduler = ctl ? new TaskScheduler(ctl, { periodSec: scanPeriod, maxCatchUp: MAX_SCANS_PER_STEP }) : null
  // the program held in lockstep, built exactly as the scene's own is
  const ls = opts?.lockstep
  const lsDeclared = ls ? new LocalPlcLink(runnableSource(ls.stProgram, controllerFor(ls.stProgram, ls.controller ?? undefined, defaultMs)), undefined) : null
  const lsPlc = lsDeclared ? lsDeclared.withBindings(wiredBindings(scene.parts, lsDeclared)) : null
  const lsCtl = lsPlc ? new SimController(lsPlc) : null
  const lsScheduler = lsCtl ? new TaskScheduler(lsCtl, { periodSec: scanPeriod, maxCatchUp: MAX_SCANS_PER_STEP }) : null
  const steps = Math.round(spec.duration * hz)
  // scheduled inputs become a persistent overlay: each fires at its time and its value sticks until
  // a later input for the same tag replaces it. Sorted so we can drain by time.
  const queue = [...(spec.inputs ?? [])].sort((a, b) => a.at - b.at)
  const overlay: Record<string, TestValue> = {}

  let lastFrame = world.frame()
  let worldTags = flattenTags(lastFrame.tags)
  let plcOut: Record<string, TestValue> = {}
  let flow: { facts: readonly FlowFact[]; overflow: number }

  try {
    for (let i = 0; i < steps; i++) {
      const time = i / hz
      while (queue.length > 0 && queue[0]!.at <= time + EPS) {
        const inp = queue.shift()!
        overlay[inp.tag] = inp.value
      }

      // faults in effect this step, each side handed what it would read without them (a `hold` fault keeps that).
      // They are applied last on their side: a fault is the wire itself failing, so it outranks both what the device does
      // and what the test pokes
      const faultToPlc = injector.overrides('toPlc', time, { ...worldTags, ...overlay })
      const faultToPart = injector.overrides('toPart', time, { ...plcOut, ...overlay })

      // PLC scan (part→PLC inputs = last frame's tags + the test overlay); outputs hold between scans. Not before
      // the parts' first step, which is when they first publish: Play's rule (sim/plcHost.ts interleave)
      if (ctl && scheduler && world.stepCount > 0) {
        const inputs = { ...worldTags, ...overlay, ...faultToPlc }
        ctl.setExternalInputs(inputs)
        const scanned = scheduler.advance(dt).scans > 0
        if (scanned) plcOut = { ...ctl.processImage.outputs } as Record<string, TestValue>
        for (const o of others) {
          o.ctl.setExternalInputs(tagsForController(inputs, o.name))
          if (o.scheduler.advance(dt).scans > 0) o.out = named(o.ctl.processImage.outputs, o.name)
        }
        if (ls && lsCtl && lsScheduler && plc && lsPlc) {
          lsCtl.setExternalInputs(inputs)
          lsScheduler.advance(dt)
          if (scanned) ls.compare(time, plc.watch as Record<string, TestValue>, lsPlc.watch as Record<string, TestValue>)
        }
      }

      // a jam in effect catches the first loose body in its zone (as the last frame placed it) and holds it there;
      // once it clears, the body is let go and rides on
      for (const j of jams) {
        const on = faultActive(j.fault, time)
        if (on && !j.caught) {
          for (const id of cargoInZone(j.fault.zone, lastFrame)) {
            if (!world.pinBody(id, true)) continue
            j.body = id
            j.caught = true
            break
          }
        } else if (!on && j.body !== null) {
          world.pinBody(j.body, false)
          j.body = null
        }
      }

      // PLC outputs + the test overlay drive the parts, then advance the physics one tick
      world.setBehaviorInputTags({ ...plcOut, ...Object.assign({}, ...others.map((o) => o.out)), ...overlay, ...faultToPart })
      world.step()

      // sample after the step: the unified table the checks see = part tags, then the PLC's own
      // variables (its view is authoritative on a name clash), then the test stimulus, then the
      // world probes read off the same frame. Probes are written last and under NUL-prefixed keys, so
      // nothing a scene or program can name is able to shadow them (core/project/projectTest probeKey).
      const frame = world.frame()
      lastFrame = frame
      worldTags = flattenTags(frame.tags)
      // A faulted input reads what the PLC reads (stuck, or lost to comms) - what the device really sensed is a probe's
      // to say. A dead actuator's command reads what the PLC commanded: the program's own view, from its watch.
      const sample: Record<string, TestValue> = {
        ...worldTags,
        ...(plc ? (plc.tagView as Record<string, TestValue>) : {}),
        ...Object.assign({}, ...others.map((o) => named(o.link.tagView, o.name))),
        ...overlay,
        ...faultToPlc,
        ...probes.values(frame, needsMarks ? world.cargoMarks() : undefined),
      }
      evaluator.sample(frame.simTime, sample)
      opts?.onFrame?.(frame, frameExtras)
      // the trace also shows each fault coming and going (`actuatorDead(m1)  FALSE -> 1.000s TRUE`), so a failure's
      // lead-up names its cause beside its effects. Trace only: no check can name a fault row
      if (opts?.trace) {
        const rows: Record<string, TestValue> = {}
        for (const r of faults) rows[describeFault(r.fault)] ||= faultActive(r.fault, time)
        // a jam's row is whether it is holding a body: it turns true when a box actually sticks, not when it arms
        for (const j of jams) rows[describeFault(j.fault)] ||= j.body !== null
        opts.trace.sample(frame.simTime, { ...sample, ...rows })
      }
    }
    // A jam that caught nothing tested nothing: every check after it held on a line that never jammed. Refused like
    // a fault that resolves to no tag, only here, because only the run can say whether cargo ever reached the zone.
    const idle = jams.find((j) => !j.caught)
    if (idle) {
      throw new Error(`faults[${idle.index}] (${describeFault(idle.fault)}): no loose cargo was in the zone while the jam was in effect, so it jammed nothing - move the zone onto the cargo's path, or start it later`)
    }
    // the run is over: a stall still going is closed with how long it lasted
    flow = world.flowFactsOf({ finish: true })
  } finally {
    world.dispose()
  }

  return { ...evaluator.finalize(), facts: [...flow.facts], factsOverflow: flow.overflow }
}
