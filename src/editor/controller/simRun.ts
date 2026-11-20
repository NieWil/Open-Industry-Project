// Play / Pause / Stop of the EditorController (../controller.ts): the run edges, which
// build and tear down the sim world, attach the program and drop run-owned cargo. A run edge resets every
// area (drags, reposition, vertex snap, placement, the program and links, cargo, the pilot's carry), so every
// function takes the owning controller (`ec`).

import { isCargoPart } from '../../core/frame'
import type { PartInstance } from '../../core/types'
import type { StepDone } from '../../sim/client'
import * as dragOps from './drag'
import { anyLinkOn } from './plcLinks'
import { liveChannel } from '../live/liveChannel'
import type { EditorController } from '../controller'

export function run(ec: EditorController): void {
  const s = ec.store.getState()
  if (s.running) return
  if (ec.drag) dragOps.cancelActiveDrag(ec)
  if (ec.reposition) ec.cancelReposition()
  if (ec.vsnap) ec.disarmVertexSnap()
  if (s.mode === 'placing') ec.store.cancelPlacing()
  ec.runPromotedBoxes.clear()
  ec.frozenCargo.clear()
  // a run of this client's own replaces a shared run it was drawing (controller/liveView.ts), from a view back at rest
  liveChannel.in?.end()
  ec.lastFrame = null
  ec.store.setRunning(true)
  // comms-controlled conveyors start stopped (the PLC owns them); manual belts are untouched.
  // commsScene narrows this to the isolated part scene when one is open (forSim), so a part runs on its own.
  // ...at the scene's step rate, which a world keeps for its lifetime (a change applies next run)
  // deferStepping: the world is built here but held before its first step, because what follows
  // (output ownership and the program itself) travels as its own messages. A world that stepped on
  // arrival would run frame 1 with nothing attached, and every part gated on `tagDriven(tag) ? readTag(tag)
  // : manual` would read its authored state for that frame. On the demo, the pallet magazine undriven for
  // one tick would read "not held", then arm and drop a pallet into the load standing on the build deck.
  // Released in the `finally` below.
  ec.sim.start(ec.commsScene(ec.store.getState().scene), ec.store.getState().simHz, { deferStepping: true })
  ec.runSerial++
  // true when an attach still on its way owns the release (startExternalPlc)
  let held = false
  try {
    // sync the worker with a speed chosen while stopped (the worker keeps its last value,
    // but the SimClient guard drops a setTimeScale sent while not running)
    ec.sim.setTimeScale(ec.store.getState().timeScale)
    // attach the authored ST program so its logic drives the sim. This lives here (not in the
    // ST editor panel) so it runs on Play in every layout - that panel is desktop-only and is
    // dropped on phones, where pressing Play would otherwise run physics with no logic. Skipped while
    // a part scene is open: the factory program targets parts that aren't in the isolated scene, and the
    // part's own behavior already runs per-part in the sim.
    if (s.focusedPartId === null) {
      // the named controllers' links run beside the simulator's programs; the attach runs every controller the
      // simulator runs, the default one unless an external PLC runs it in its place
      if (ec.externalPlcAvailable && anyLinkOn(s.externalPlc)) held = ec.startExternalPlc()
      ec.attachProgram()
    }
  } finally {
    // in a finally because a world that never steps is a far worse failure than one that steps
    // un-attached: an attach that throws past its own handler must not leave a frozen Play.
    if (!held) ec.sim.beginStepping()
  }
}

export function togglePause(ec: EditorController): void {
  setPaused(ec, !ec.store.getState().paused)
}

export function setPaused(ec: EditorController, paused: boolean): void {
  const s = ec.store.getState()
  if (!s.running || s.paused === paused) return
  ec.store.setPaused(paused)
  ec.sim.setPaused(paused)
}

/** advance a paused run by one physics step, with the PLC scans that fall due in it */
export function step(ec: EditorController): void {
  const s = ec.store.getState()
  if (!s.running || !s.paused) return
  ec.sim.step()
}

/** advance a paused run by `steps` physics steps, or to the sim time `until`; resolves when the view has the last
 *  step's frame (null when the run is not paused, or ends first) */
export function stepBy(ec: EditorController, opts: { steps?: number; until?: number }): Promise<StepDone | null> {
  const s = ec.store.getState()
  if (!s.running || !s.paused) return Promise.resolve(null)
  return ec.sim.stepBy(opts)
}

export function stop(ec: EditorController): void {
  ec.sim.stop()
  // The live poses go with the bodies. Clear them before setRunning(false): that store change re-pushes the
  // gizmo synchronously, and pushGizmo / dragStartScene prefer a cached live pose over the authored one. Left
  // in place, a stopped box would snap back to its authored pose while its gizmo stays where the body last was
  // (and the next drag would start from that stale spot, teleporting the box there).
  ec.liveCargo.clear()
  // setRunning(false) flows synchronously to view.setRunning(false), which clears the live
  // bodies, repaints the authored cargo through the instanced batch, and returns run-driven rigs /
  // mobile roots to their authored pose (resetRunPoses) - so no clearBoxes() here (it would wipe
  // that freshly-applied idle frame).
  ec.store.setRunning(false)
  ec.detachExternalPlc()
  ec.stopProgram() // detach the PLC + clear its render overlays (mirror of run()'s attach)
  ec.boxCount = 0
  // the live bodies are gone: nothing left to carry or keep frozen
  ec.pilot.carry = null
  ec.frozenCargo.clear()
  ec.lastFrame = null
  ec.store.setPilotPrompt(null)
  let scene = ec.store.getState().scene
  let changed = false
  // Drop the run's own cargo: boxes promoted from spawner bodies (selecting/following a spawned
  // box promotes it so it can be tracked), cargo dropped onto the running line, and cargo copied
  // mid-run - all live sim content, never authored, so a Stop that "returns the line to how it was
  // authored" must not leave them frozen in the scene. The isCargoPart half is a safety net: an id
  // freed mid-run (a cancelled Shift+drag duplicate, an undone paste) can be re-minted for any part
  // type, and dropping a conveyor because it inherited a dead box's id would be silent data loss.
  const dropped = (p: PartInstance): boolean => ec.runPromotedBoxes.has(p.id) && isCargoPart(p)
  if (ec.runPromotedBoxes.size > 0) {
    const parts = scene.parts.filter((p) => !dropped(p))
    if (parts.length !== scene.parts.length) {
      scene = { ...scene, parts }
      changed = true
    }
  }
  if (changed) {
    // a removed box can't stay selected (its gizmo/visual would dangle); prune the selection
    const kept = new Set(scene.parts.map((p) => p.id))
    const sel = ec.store.getState().selectedIds.filter((id) => kept.has(id))
    if (sel.length !== ec.store.getState().selectedIds.length) ec.store.selectMany(sel)
    ec.store.setAuthored(scene)
  }
  ec.runPromotedBoxes.clear()
}
