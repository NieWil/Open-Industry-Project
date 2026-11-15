// The attached ST program of the EditorController (../controller.ts): validate it, ship
// it to the sim worker, re-bind, stop, and the online writes. What is attached, its status and faults and the
// output-ownership mirror are this area's own state (ProgramState, held by the controller); the store, the sim
// and the link-side hooks come in as narrow dependencies (ProgramDeps).

import { controllerOf, controllerTag, partsForController } from '../../core/io/controllerTag'
import { lazyTable } from '../../core/watchTable'
import type { SceneJSON } from '../../core/types'
import type { PlcFault, SimClient } from '../../sim/client'
import { commsTags, ControllerError, controllerRuns, LocalPlcLink, runnableSource, StError, unhandledProgramTags } from '../../plc'
import type { TagValue } from '../../plc'
// deep import: the wiring check is a checker, not part of the runtime PLC surface the barrel exposes
import { checkWiring, wiredBindings } from '../../plc/wiring'
import { withWatchValue } from '../../core/watchKeys'
import { attachedProgram, programRefusal } from '../program/programReload'
import type { AttachedProgram } from '../program/programReload'
import type { PublishedProgram } from '../links/opcUaServer'
import type { EditorController } from '../controller'

/** Snapshot of the attached ST program's bind/compile result, mirrored into the ST editor
 *  panel for display. `attached` is true while a program is driving the running sim. */
export interface ProgramStatus {
  attached: boolean
  unbound: string[]
  unwired: string[]
  warnings: string[]
  /** compile/attach error (formatted with line/col), else null */
  error: string | null
  /** the error is the controller table's, which has no line to point at: it is fixed in the organizer's tasks */
  errorInController?: boolean
}

/** What the controller faulted on, against the source it was running ({@link EditorController.plcFaults}). */
export interface PlcFaults {
  /** the program text the positions are in: a fault is drawn only while the editor still shows this */
  source: string
  /** the fault that stopped the program, if one did */
  fault: { message: string; line?: number; col?: number; offset?: number } | null
}

export const NO_PROGRAM: ProgramStatus = { attached: false, unbound: [], unwired: [], warnings: [], error: null }

/** The status line under an attach error when the program from before it is still running (attachProgram). */
const PREVIOUS_STILL_RUNNING = 'The program has an error, so the PLC is still running the previous one. Fix it, then Reload.'
/** The status line while an external PLC runs the default controller and the simulator runs other controllers: one
 *  owner (the attach) says it, so the default link's start and the attach cannot overwrite each other's line. */
export const DEFAULT_ON_PLC = 'An external PLC runs the default controller (Controller Properties), so its part of the program is not attached here.'

/** The attached ST program as the editor knows it: what is attached and running, its status and faults, and who it drives. */
export class ProgramState {
  // Whether an ST program is attached. The program itself runs in the sim worker (sim/plcHost.ts),
  // interleaving its scans between physics steps; the editor only validates the source, ships it
  // (SimClient.runProgram), and renders the worker's frame-borne PLC state (sim.plcState).
  plcAttached = false
  // What the last attach read from the document (program, table, a baked-in scan time), whether or not it compiled;
  // null when nothing is attached. Compared against the store: a program arriving after a slow room join gets adopted
  // (see adoptLateProgram), and any other difference is what the PLC dock's Reload offers (programOutOfDate).
  attached: AttachedProgram | null = null
  // The program text the worker is actually scanning, or null. Not always `attached.source`: an attach that fails
  // ships nothing, so the program from before it keeps running (see attachProgram).
  runningSource: string | null = null
  // the last attach failed to compile (or its controller table did), whatever still runs: see programAttachFailure
  attachFailed = false
  /** the attached program's last runtime fault, with the source it ran, until a program attaches again: the
   *  status line clears on Stop, and this is what the Problems dock keeps (see EditorController.plcFault) */
  fault: (PlcFault & { source: string }) | null = null
  attachedScanMs = 0
  // Each controller the simulator runs, kept so a scene edit mid-run can re-bind it (rebindProgram): its program as
  // declared, and the bindings last shipped. The default controller's has controller null; another one's binds to the
  // parts' tags that name it (core/io/controllerTag.ts partsForController).
  runs: { controller: string | null; declared: LocalPlcLink; shipped: string }[] = []
  // the validation compile's initial variable image, shown by the watch getters until the first
  // worker frame carries live state (or indefinitely for a program attached while not running)
  seedWatch: Readonly<Record<string, TagValue>> | null = null
  // Output ownership, mirrored for the editor's own UI (the pilot "In auto" prompt): the tag keys the
  // attached program drives (its outputs, declared or bound by wiring): the same set shipped to the worker as
  // setDrivenTags. Static per attach; drivenRev bumps on attach/detach so per-frame consumers can memoize.
  // Three parts make it, each set by its own owner so none overwrites another: what the default controller drives (the
  // program here, or the external PLC run instead of it), what the named controllers the simulator runs drive, and
  // what the named controllers' links drive (`Cell2::...`, controller/plcLinks.ts).
  drivenKeys: ReadonlySet<string> = new Set()
  drivenRev = 0
  ownDriven: readonly string[] = []
  simDriven: readonly string[] = []
  linkDriven: readonly string[] = []
  // last attach result (bindings + compile error), surfaced to the ST editor panel
  status: ProgramStatus = NO_PROGRAM
  // panels that want to re-render when the program status changes (the ST editor)
  readonly watchers = new Set<() => void>()
  // what shows the held forces (the Watch dock, the toolbar's count): told when one is set or released
  readonly forceWatchers = new Set<() => void>()
  /** see EditorController.plcFaults */
  lastFault: PlcFaults['fault'] = null
  /** the program those are about: `runningSource` is cleared when the program stops, and they outlive it */
  faultSource = ''
  // the program the OPC UA server publishes while it runs (the attach's compile), so a server started mid-run can publish it
  uaProgram: PublishedProgram | null = null
}

/** what attaching reads and drives: the document (store), the worker (sim), and the link side - an external PLC
 *  that owns the I/O, and the simulated PLC's OPC UA server that publishes the program */
export type ProgramDeps = Pick<EditorController, 'store' | 'sim' | 'commsScene' | 'publishToUaServer' | 'updateUaServers' | 'externalSession' | 'externalPlcAvailable'>

/** Another controller the simulator runs beside the default one: its share of the program (plc/controller.ts controllerRuns). */
export interface OtherRun {
  controller: string
  source: string
  instances: readonly string[]
}

/** One controller's program bound to the parts as it sees them: its own tags, without its name (partsForController). */
function bindRun(parts: SceneJSON['parts'], controller: string | null, source: string) {
  const declared = new LocalPlcLink(source)
  const seen = controller === null ? parts : partsForController(parts, controller)
  const wired = wiredBindings(seen, declared)
  const link = declared.withBindings(wired)
  return { controller, source, declared, wired, link, seen }
}

/** A name of `controller`'s, as the parts and the Problems dock spell it. */
const onController = (controller: string | null, name: string): string => controllerTag(controller, name)

/** Set the program status and tell its watchers (the ST editor panel). */
export function setProgramStatus(p: ProgramState, next: ProgramStatus): void {
  p.status = next
  for (const cb of p.watchers) cb()
}

/** Who the default controller drives now. With the named links' half, that is the mirror the editor's UI reads and the
 *  set shipped to the worker (ctx.tagDriven). */
export function setDriven(p: ProgramState, sim: SimClient, driven: readonly string[]): void {
  p.ownDriven = [...driven]
  shipAllDriven(p, sim)
}

/** Who the named controllers' links drive now (controller/plcLinks.ts). */
export function setLinkDriven(p: ProgramState, sim: SimClient, driven: readonly string[]): void {
  p.linkDriven = [...driven]
  shipAllDriven(p, sim)
}

function shipAllDriven(p: ProgramState, sim: SimClient): void {
  const all = [...p.ownDriven, ...p.simDriven, ...p.linkDriven]
  p.drivenKeys = new Set(all)
  p.drivenRev++
  sim.setDrivenTags(all)
}

export function runProgram(
  p: ProgramState,
  ec: ProgramDeps,
  source: string | null,
  opts?: { periodSec?: number },
  others: readonly OtherRun[] = [],
): { unbound: string[]; unwired: string[]; warnings: string[] } {
  // The program's own tags a part is wired to by name connect too, not only its VAR_INPUT / VAR_OUTPUT,
  // with the parts saying which way (plc/wiring.ts wiredBindings). Worked out here, where the scene is,
  // and shipped with the source so the worker's link binds exactly what these warnings describe. Each controller
  // binds to its own tags, and what is said about them names it.
  const parts = ec.store.getState().scene.parts
  const built = [...(source !== null ? [bindRun(parts, null, source)] : []), ...others.map((o) => bindRun(parts, o.controller, o.source))]
  const unbound: string[] = []
  const unwired: string[] = []
  const warnings: string[] = []
  for (const b of built) {
    const missing = unhandledProgramTags(b.seen, b.link)
    unbound.push(...missing.unbound.map((n) => onController(b.controller, n)))
    unwired.push(...missing.unwired.map((n) => onController(b.controller, n)))
    // The direction/type-aware half (plc/wiring.ts). unbound/unwired only ask whether a name is
    // mentioned somewhere, so the mistakes that survive them are exactly the ones that look fine and
    // behave wrong: two parts driving one tag (last writer wins, by part order), one tag declared as
    // two types, a BOOL wired to a numeric program var. Folded into `warnings` - the panel already
    // renders that list, and a wiring problem is the same kind of "this will not do what you meant".
    for (const w of checkWiring(b.seen, b.link).problems) {
      warnings.push(`${w.severity === 'error' ? 'Wiring error' : 'Wiring'} - ${onController(b.controller, w.tag)}: ${w.message}`)
    }
  }
  shipDriven(p, ec.sim, built)
  // Every controller's variables are one table, the default controller's own names winning over another's copy.
  // Built when it is read: it is every value the programs hold (a third of a second on an 800-part line), it stands
  // only until the first frame, and nothing reads it then unless a view of the program is open or a force is held.
  const watch = lazyTable(() => {
    const all: Record<string, TagValue> = {}
    for (const b of built) if (b.controller !== null) Object.assign(all, b.link.watch)
    for (const b of built) if (b.controller === null) Object.assign(all, b.link.watch)
    return all
  })
  // A force names a variable of the program it was set on, and outlives Stop. An attach keeps the ones this program
  // still has with the same kind of value, and drops the rest, so nothing reports a force that holds nothing (or holds
  // the wrong type). The ones still held show on the toolbar's count; a dropped one gets a notice, since it would
  // otherwise vanish from there unexplained.
  const before = ec.sim.forces
  const kept = keptForces(before, watch)
  if (kept !== before) {
    setForces(p, ec.sim, kept)
    announceDroppedForces(ec.store, Object.keys(before).filter((k) => !(k in kept)))
  }
  // hand the programs to the worker's scan hosts; the validation compile's initial variable image seeds
  // the watch table until the first frame carries live state
  ec.sim.runProgram(
    built.map((b) => ({
      controller: b.controller,
      source: b.source,
      ...(opts?.periodSec !== undefined ? { periodSec: opts.periodSec } : {}),
      wired: b.wired,
      instances: others.find((o) => o.controller === b.controller)?.instances ?? [],
    })),
  )
  p.runs = built.map((b) => ({ controller: b.controller, declared: b.declared, shipped: JSON.stringify(b.wired) }))
  p.seedWatch = watch
  p.plcAttached = true
  // the OPC UA server publishes the default controller's program
  const main = built.find((b) => b.controller === null)
  p.uaProgram = main?.link ?? null
  ec.publishToUaServer(main?.link ?? null)
  return { unbound, unwired, warnings }
}

/** What the programs of `built` drive: the default controller's outputs as they are, another's with its name on. */
function outputsOf(built: readonly { controller: string | null; link: LocalPlcLink }[]): string[] {
  return built.flatMap((b) => b.link.outputs.map((o) => onController(b.controller, o)))
}

/**
 * Output ownership: while a program is attached it drives its outputs, declared or bound by wiring;
 * everything else stays hand-operable. Ship the set to the
 * worker (ctx.tagDriven) and mirror it here for the pilot's "In auto" prompt. Once per attach, and again
 * when a scene edit re-binds the program ({@link rebindProgram}).
 */
export function shipDriven(p: ProgramState, sim: SimClient, built: readonly { controller: string | null; link: LocalPlcLink }[]): void {
  p.simDriven = outputsOf(built.filter((b) => b.controller !== null))
  // with no program here for the default controller, an external PLC runs it, and its link owns that part (plcLinks.ts)
  if (built.some((b) => b.controller === null)) setDriven(p, sim, outputsOf(built.filter((b) => b.controller === null)))
  else shipAllDriven(p, sim)
}

/**
 * A scene edit while the program runs can wire a part to one of its own tags, or unwire one. A declared
 * VAR_INPUT connects the moment a part is wired to it, so a tag bound by wiring must too, not at the next
 * Play: re-bind the running program in place (its variables and timers keep their state) and move
 * ownership with it. Nothing is sent unless the bindings actually changed.
 */
export function rebindProgram(p: ProgramState, sim: SimClient, parts: SceneJSON['parts']): void {
  if (!p.plcAttached || p.runs.length === 0) return
  let moved = false
  const links = p.runs.map((r) => {
    if (r.declared.bindable.length === 0) return { controller: r.controller, link: r.declared }
    const wired = wiredBindings(r.controller === null ? parts : partsForController(parts, r.controller), r.declared)
    const shipped = JSON.stringify(wired)
    if (shipped !== r.shipped) {
      r.shipped = shipped
      moved = true
      sim.rebindProgram(wired, r.controller ?? undefined)
    }
    return { controller: r.controller, link: r.declared.withBindings(wired) }
  })
  if (moved) shipDriven(p, sim, links)
}

/** Run `fn`, putting the controller's name before the message of a compile error it throws, so the error says whose. */
function compiledFor<T>(controller: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    // defineProperty, not assignment: under lockdown Error.prototype is frozen, and assigning a property it has throws
    if (e instanceof StError) Object.defineProperty(e, 'message', { value: `${controller}: ${e.message}` })
    throw e
  }
}

export function attachProgram(p: ProgramState, ec: ProgramDeps): void {
  // a part scene runs its part's own behavior, and the factory program targets parts that are not in it (run())
  if (ec.store.getState().focusedPartId !== null) return
  const { stProgram, stScanMs, controller, stDialect, externalPlc: setup } = ec.store.getState()
  // which controllers the simulator runs: the default one unless an external PLC runs it in its place (a second
  // controller writing its tags would fight that PLC), and every named one set to run here (core/scene/scenePlcs.ts)
  const defaultHere = !(ec.externalPlcAvailable && setup.enabled)
  const simulated = setup.controllers.filter((c) => c.runsOn === 'app' && c.enabled).map((c) => c.name)
  if (!defaultHere && simulated.length === 0) return
  // recorded whether or not it compiles: the same text is not offered for a reload again until it changes
  p.attached = attachedProgram({ stProgram, controller, stScanMs, stDialect })
  // A program written for a dialect this build does not have is refused before anything reads it (programRefusal).
  // Nothing ships, so exactly as with a compile error, a program from an earlier attach keeps running (and says so).
  const refusal = programRefusal({ stDialect })
  if (refusal !== null) {
    p.attachFailed = true
    setProgramStatus(p, 
      p.plcAttached ? { attached: true, unbound: [], unwired: [], warnings: [PREVIOUS_STILL_RUNNING], error: refusal } : { ...NO_PROGRAM, error: refusal },
    )
    return
  }
  p.lastFault = null // a new run clears the last fault
  p.faultSource = stProgram
  try {
    // the program runs from its controller table (plc/controller.ts): its own, or the default one at the scan
    // time; a program whose text runs as written (no table, no PROGRAM) scans on the scan time itself. Each
    // controller the simulator runs compiles its own share of it (controllerRuns), a problem in one naming it.
    const runs = controllerRuns(stProgram, controller, stScanMs, { defaultName: setup.mainName, simulated })
    const main = runs.find((r) => r.controller === null)
    const others = runs.flatMap((r) =>
      r.controller === null ? [] : [{ controller: r.controller, source: compiledFor(r.controller, () => runnableSource(r.source, r.table)), instances: r.table?.programs.map((q) => q.name) ?? [] }],
    )
    const res = runProgram(p, ec, defaultHere && main ? runnableSource(main.source, main.table) : null, { periodSec: stScanMs / 1000 }, others)
    p.fault = null // a new attach is a new run: the old fault is history (setProgramStatus below notifies)
    p.attachFailed = false
    p.runningSource = stProgram
    p.attachedScanMs = stScanMs
    // No program means every wired tag is unwritten and unread, and the wiring check says so tag by tag: dozens of
    // lines on the demo, burying the one below that says why. They describe a program that is not there, so they go.
    const warnings = stProgram.trim() === '' ? [] : [...res.warnings]
    // A program with no outputs, declared or bound by wiring, drives nothing: every comms device falls back to hand
    // control, so the line just sits there. That is indistinguishable from a healthy attach
    // unless we say so, and it is the shared symptom of every way a program can go missing
    // (an unseeded room, a scene file exported without its logic, a doc still syncing).
    // (with an external PLC running the default controller, its tags are that PLC's to drive, and it says so)
    if (!defaultHere) warnings.unshift(DEFAULT_ON_PLC)
    else if (p.ownDriven.length === 0 && commsTags(ec.store.getState().scene.parts).some((t) => controllerOf(t) === null)) {
      warnings.push(
        stProgram.trim() === ''
          ? 'No PLC program is attached, so every comms device is in hand control and the line will not start. Load or write a program, or operate devices by hand with C.'
          : 'This program drives no device, so every comms device stays in hand control. Wire a part to a tag the program assigns (a VAR_OUTPUT, or one of its own variables).',
      )
    }
    setProgramStatus(p, { attached: true, unbound: res.unbound, unwired: res.unwired, warnings, error: null })
  } catch (e) {
    p.attachFailed = true
    // a problem with the controller table has no line of its own to point at
    const error = e instanceof ControllerError ? `Controller: ${e.message}` : e instanceof StError ? `${e.message} (line ${e.pos.line}, col ${e.pos.col})` : String(e)
    const errorInController = e instanceof ControllerError
    // runProgram proves the program before it ships anything, so a failure reaches nothing: a program from an earlier
    // attach keeps scanning in the worker and keeps driving its devices, as a real PLC keeps running when a download
    // is refused. Say so: "not attached" over a line that is visibly still under control would be wrong.
    setProgramStatus(p, 
      p.plcAttached
        ? { attached: true, unbound: [], unwired: [], warnings: [PREVIOUS_STILL_RUNNING], error, errorInController }
        : { ...NO_PROGRAM, error, errorInController },
    )
  }
}

/**
 * A program arrived while one is already running. Re-attach only when what we attached was
 * driving nothing and the newcomer isn't: the room's shared text arriving after a slow join, or
 * a peer pasting the logic in. Anything narrower leaves that sim dead until a manual Stop/Play;
 * anything wider would reset a working program's timers on every keystroke a peer types.
 */
export function adoptLateProgram(p: ProgramState, ec: ProgramDeps): void {
  const s = ec.store.getState()
  if (!s.running || !p.plcAttached) return
  if (p.ownDriven.length > 0) return // already driving something: leave it alone
  if (s.stProgram === (p.attached?.source ?? '') || s.stProgram.trim() === '') return
  if (s.focusedPartId !== null) return // a part scene runs its own behavior, not the factory program
  attachProgram(p, ec)
}

/** Push a scan-time edit (state.stScanMs) to the attached program: takes effect on the worker's
 *  next step, no Stop/Run needed. Driven from the store change, not called by the panel - the
 *  field edits the document, and the document is what the engine follows. */
export function syncScanPeriod(p: ProgramState, ec: Pick<EditorController, 'store' | 'sim'>): void {
  const ms = ec.store.getState().stScanMs
  if (!p.plcAttached || ms === p.attachedScanMs) return
  p.attachedScanMs = ms
  ec.sim.setScanPeriod(ms / 1000)
}

export function stopProgram(p: ProgramState, ec: ProgramDeps): void {
  // the forces stay (SimClient.forces): the next attach checks them against its program (runProgram)
  p.plcAttached = false
  p.attached = null
  p.runningSource = null
  p.attachFailed = false
  p.attachedScanMs = 0
  p.seedWatch = null
  p.runs = []
  p.uaProgram = null
  ec.updateUaServers(null, false) // out of service until a program runs here again
  ec.sim.stopProgram()
  // ownership releases with the program (PROGRAM mode): every device is hand-operable again
  p.simDriven = []
  setDriven(p, ec.sim, []) // the worker drops it when already stopped - the next run starts with a fresh world
  // Custom parts read their PLC tags off the device-IO bridge and drive their own visuals from their
  // behavior; with no program left to feed those tags, the parts idle on their next step. Push the scene
  // once so an isolated part scene stays applied.
  if (ec.store.getState().running) ec.sim.update(ec.commsScene(ec.store.getState().scene)) // = forSim (viewScene.ts)
  setProgramStatus(p, NO_PROGRAM)
}

/** What a write to a running program goes through: its value image, the worker, and the held forces' watchers. */
export type PlcWriteDeps = { ec: Pick<EditorController, 'plcProgramWatch' | 'sim'>; p: ProgramState }

/** Replace the held forces and tell what shows them. */
function setForces(p: ProgramState, sim: Pick<EditorController['sim'], 'setForces'>, forces: Readonly<Record<string, number | boolean>>): void {
  sim.setForces(forces)
  for (const cb of p.forceWatchers) cb()
}

/**
 * A value for the running program: written once, or, when the variable is forced, held at it instead. One bit of a
 * forced word (`Status.3` with `Status` held) changes the bit in the held word: a one-time write would be undone by
 * the word's force before the next scan.
 */
function writeOrHold({ ec, p }: PlcWriteDeps, key: string, value: number | boolean): void {
  const forces = ec.sim.forces
  if (key in forces) {
    setForces(p, ec.sim, { ...forces, [key]: value })
    return
  }
  const bit = /^(.+)\.([0-9]+)$/.exec(key)
  const word = bit ? forces[bit[1]!] : undefined
  if (bit && typeof word === 'number' && typeof value === 'boolean') {
    const mask = 2 ** Number(bit[2])
    setForces(p, ec.sim, { ...forces, [bit[1]!]: value ? (word | mask) | 0 : (word & ~mask) | 0 })
    return
  }
  ec.sim.forceTag(key, value)
}

/** Variable names for a notice: the first few, then how many more. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(', ')
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown
}

/** Tell the user which forces an attach released because its program no longer has that variable (or not as that type). */
export function announceDroppedForces(store: Pick<ProgramDeps['store'], 'showSaveNotice'>, dropped: readonly string[]): void {
  if (dropped.length === 0) return
  store.showSaveNotice('Forces released', `Released ${nameList(dropped)}: the program no longer has ${dropped.length === 1 ? 'that variable' : 'those variables'} with the same type.`)
}

/** `forces` without the ones `watch` (a program's variable image) has no value of the same kind for; the same object
 *  when none goes. */
export function keptForces(forces: Readonly<Record<string, number | boolean>>, watch: Readonly<Record<string, TagValue>>): Readonly<Record<string, number | boolean>> {
  const keys = Object.keys(forces)
  const kept = keys.filter((k) => typeof currentValue(watch, k) === typeof forces[k])
  return kept.length === keys.length ? forces : Object.fromEntries(kept.map((k) => [k, forces[k]!]))
}

/** The current value of `key` in the running image: a variable, or one bit of a word (`Status.3`). */
function currentValue(watch: Readonly<Record<string, TagValue>> | null, key: string): TagValue | undefined {
  const bit = /^(.+)\.([0-9]+)$/.exec(key)
  const word = bit ? watch?.[bit[1]!] : undefined
  return watch?.[key] ?? (bit && typeof word === 'number' ? ((word >>> Number(bit[2])) & 1) === 1 : undefined)
}

export function togglePlcBit(deps: PlcWriteDeps, key: string): boolean {
  const { ec } = deps
  const watch = ec.plcProgramWatch
  const cur = watch?.[key]
  // `Status.3`: one bit of a word. The watch holds the word, so the bit is read out of it here and
  // the write goes by the bit's own name, which the program's setInput understands (interpreter.ts)
  const bit = /^(.+)\.([0-9]+)$/.exec(key)
  const word = bit ? watch?.[bit[1]!] : undefined
  if (cur === undefined && bit && typeof word === 'number') {
    const mask = 2 ** Number(bit[2])
    const on = ((word >>> Number(bit[2])) & 1) === 1
    writeOrHold(deps, key, !on)
    if (ec.sim.plcState) ec.sim.plcState = { ...ec.sim.plcState, watch: withWatchValue(ec.sim.plcState.watch, bit[1]!, on ? (word & ~mask) | 0 : (word | mask) | 0) }
    return true
  }
  if (typeof cur !== 'boolean') return false
  writeOrHold(deps, key, !cur)
  // the frame that carries the new value is a step away; show it now, so a second Ctrl+T reads the toggled state
  if (ec.sim.plcState) ec.sim.plcState = { ...ec.sim.plcState, watch: withWatchValue(ec.sim.plcState.watch, key, !cur) }
  return true
}

/** `text` as a value for `key` of the running program, or why it is not one. */
function parsePlcValue(watch: Readonly<Record<string, TagValue>> | null, key: string, text: string): { value: number | boolean } | { error: string } {
  if (!watch) return { error: 'The program is not running' }
  const cur = currentValue(watch, key)
  if (cur === undefined) return { error: `'${key}' is not a value of the running program` }
  const t = text.trim()
  if (typeof cur === 'boolean') {
    if (/^(1|true|on)$/i.test(t)) return { value: true }
    if (/^(0|false|off)$/i.test(t)) return { value: false }
    return { error: `'${t}' is not 0 or 1` }
  }
  if (typeof cur === 'number') {
    const based = /^(2|8|16)#([0-9A-F_]+)$/i.exec(t)
    const value = based ? parseInt(based[2]!.replace(/_/g, ''), Number(based[1])) : Number(t.replace(/_/g, ''))
    if (t === '' || !Number.isFinite(value)) return { error: `'${t}' is not a number` }
    return { value }
  }
  return { error: 'Text is set in the declaration, not while running' }
}

/** Show a written value now: the frame that carries it back is a step away (the worker coerces it to the tag's type). */
function showWritten(ec: PlcWriteDeps['ec'], key: string, value: number | boolean): void {
  if (ec.sim.plcState && key in ec.sim.plcState.watch) ec.sim.plcState = { ...ec.sim.plcState, watch: withWatchValue(ec.sim.plcState.watch, key, value) }
}

export function writePlcValue(deps: PlcWriteDeps, key: string, text: string): string | null {
  const parsed = parsePlcValue(deps.ec.plcProgramWatch, key, text)
  if ('error' in parsed) return parsed.error
  writeOrHold(deps, key, parsed.value)
  showWritten(deps.ec, key, parsed.value)
  return null
}

/**
 * Hold a variable of the running program at a value across scans until released: `text` when given, else the value it
 * has now. The reason it was refused, or null when held.
 */
export function forcePlcValue(deps: PlcWriteDeps, key: string, text?: string): string | null {
  const { ec, p } = deps
  const watch = ec.plcProgramWatch
  let value: number | boolean
  if (text === undefined) {
    if (!watch) return 'The program is not running'
    const cur = currentValue(watch, key)
    if (cur === undefined) return `'${key}' is not a value of the running program`
    if (typeof cur === 'string') return 'Text is set in the declaration, not while running'
    value = cur
  } else {
    const parsed = parsePlcValue(watch, key, text)
    if ('error' in parsed) return parsed.error
    value = parsed.value
  }
  setForces(p, ec.sim, { ...ec.sim.forces, [key]: value })
  showWritten(ec, key, value)
  return null
}

/** Release one held force (`key`), or every one (no key). The program writes the variable again from its next scan. */
export function releasePlcForces({ ec, p }: PlcWriteDeps, key?: string): void {
  if (key === undefined) {
    if (Object.keys(ec.sim.forces).length > 0) setForces(p, ec.sim, {})
    return
  }
  if (!(key in ec.sim.forces)) return
  const { [key]: _released, ...rest } = ec.sim.forces
  setForces(p, ec.sim, rest)
}
