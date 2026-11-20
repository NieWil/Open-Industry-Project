// Pilot-mode subsystem of the EditorController (../controller.ts). What the walking
// character holds (carried cargo, a pulled flex) and the auto/hand memo are this area's own state
// (PilotState, held by the controller as `pilot`); every function takes that plus the narrow slice of the
// controller it drives (PilotDeps). The editor's C press (useSelection) also pins live cargo, a drag-area
// rule, so it alone takes the whole controller.

import type { BoxFrame } from '../../core/frame'
import { commsOn } from '../../core/conveyor/conveyorDirection'
import { buildAuthoredCargoFrame, isCargoPart } from '../../core/frame'
import { authoredZoneCounts } from '../../core/zoneCounts'
import type { ParamValue } from '../../core/parts/partApi'
import { pilotUsable } from '../../core/scene/scene'
import { flexPathOf, flexPull, toWorldXZ, withFlexPose } from '../../core/parts/partGeometry'
import type { FlexGrip } from '../../core/parts/partGeometry'
import { getPackage } from '../../core/parts/partRegistry'
import { rigJointsJson } from '../../core/parts/partPackage'
import { posableArraysJson } from '../../core/rig/rigPose'
import type { PartInstance, SdkPart } from '../../core/types'
import type { BoxPick } from '../../render/api'
import { IdleUseSession, idleKey } from '../../sim/idlePose'
import type { EditorController } from '../controller'
import { toggleCargoPin } from './drag'

type EdState = ReturnType<EditorController['store']['getState']>

/** What the walking character holds, and the memo behind its "In auto" prompt: session state, never the document. */
export class PilotState {
  // pilot mode: the cargo part currently carried (frozen + teleported to the hold point each frame); null otherwise
  carry: { partId: string } | null = null
  // pilot mode: the flex conveyor end (or control point) the character is holding (pulled to the hold point each
  // rendered frame, a walk-session overlay: store.walkFlex); null otherwise
  flex: { partId: string; grip: FlexGrip; at: number; towing: boolean } | null = null
  // memo for a part's auto/hand answer (partUseInAuto - the pilot crosshair prompt and the editor
  // C press's "In auto" hint), cached on frame-stable keys (part, attach rev, scene).
  autoCache: { id: string; rev: number; scene: unknown; auto: boolean } | null = null
}

/** what walk mode reads and drives: the store, the view's crosshair and hold point, the sim's bodies, the Use-pinned
 *  cargo, cargo promotion, the stopped-Use sessions, the shown scene, and the program's output ownership */
export type PilotDeps = Pick<
  EditorController,
  'store' | 'view' | 'sim' | 'frozenCargo' | 'promoteCargoBox' | 'pressIdle' | 'editTargetViewScene' | 'plcDrivenKeys' | 'plcDrivenRev'
>

// --- pilot mode (first-person walk-around) -------------------------------

/** Esc / pointer-lock loss inside pilot mode: drop carried cargo and return to the editor */
export function pilotExit(p: PilotState, ec: PilotDeps): void {
  dropCarried(p, ec)
  ec.store.exitPilot()
}

/**
 * Interact button (E / F / click): a ray from the crosshair;
 * carriable cargo under the crosshair wins first, otherwise toggle the
 * hand-operable part there (push button, safety gate, interactive custom
 * part - narrower than the editor C-key set, see {@link pilotUsable}).
 *
 * Nothing the character does here is an edit. Walk mode is a session, like a run: carried cargo is
 * run-scoped, a running Use goes to the behavior (dropped on Stop), a stopped Use is the same live session the
 * editor's C drives (idleUsePart), and a dock door is walk-session state that leaving walk mode drops. So a
 * walk through the demo view never forks it (store.stashDemoSession). Use operates a device in every mode;
 * setting its starting state is the Inspector's job (see {@link useSelection}).
 */
export function pilotInteract(p: PilotState, ec: PilotDeps): void {
  const s = ec.store.getState()
  if (s.mode !== 'pilot') return
  if (p.carry) {
    dropCarried(p, ec)
    return
  }
  if (p.flex) {
    releaseFlex(p, ec)
    return
  }
  // cargo only exists as a live, grabbable body while the sim runs
  if (s.running) {
    const box = ec.view.pilotLookBox()
    if (box) {
      const partId = ensureCargoPart(ec, box)
      if (partId !== null) {
        // the carry takes the body from whoever holds it: a Use pin, a robot's gripper, an AGV's forks (the
        // sim's one-holder table, sim/bodyHolds.ts claim). So only the pin's bookkeeping is left to drop here.
        ec.frozenCargo.delete(partId)
        ec.sim.holdBody(partId, true)
        p.carry = { partId }
        ec.store.setPilotPrompt('Drop')
      }
      return
    }
  }
  // a dock-door leaf under the crosshair toggles on its own, ahead of the generic whole-part use action
  const leaf = ec.view.pilotLookDockLeaf()
  if (leaf) {
    ec.store.toggleWalkDoorLeaf(leaf.partId, leaf.leafKey)
    return
  }
  // either end of a flex conveyor (or any of its control points) within reach: take hold of it, and it follows the
  // hands until the next press (pullFlex)
  const flex = flexUnderCrosshair(ec)
  if (flex) {
    if (!flex.braked) holdFlex(p, ec, flex.partId, flex.grip)
    return
  }
  const usableId = pilotUsableUnderCrosshair(ec)
  if (!usableId) return
  // a custom interactive part's use goes to its worker behavior (ctx.used()) while the sim runs; stopped, to the
  // device's live session (idleUsePart), exactly as the editor's C does. Never a scene param change.
  if (ec.store.getState().running) ec.sim.usePart(usableId)
  else idleUsePart(ec, usableId)
}

/**
 * "Use" (C) for the current selection. Use operates a device and never edits the scene, in every mode:
 * the setting a device starts a run from (the gate's `open`, the blade stop's `active`) is the Inspector's
 * checkbox, and nothing else writes it.
 *
 * - Running: a selected interactive part's use is delivered to its worker behavior (ctx.used()), the same
 *   routing as {@link pilotInteract}. It belongs to the run, and Stop resets it.
 * - Stopped: the press goes to the device's live session (idleUsePart), the same as the walking character's E.
 *   The device does what a press makes it do and stays that way (a gate opens and stays open), as session
 *   state: never the document. The Inspector says the device is being operated and offers Reset, so the
 *   viewport never silently disagrees with it.
 *
 * Selected live cargo is different: cargo has no behavior to use, so Use freezes the box in place
 * (kinematic - conveyors and gravity let go) and a second press releases it. A live-sim action like the
 * gizmo-grab freeze, not a design edit - nothing commits, and Stop discards it with the bodies.
 */
export function useSelection(p: PilotState, ec: EditorController): void {
  const s = ec.store.getState()
  if (s.running) {
    // same surfacing rule as the pilot prompt: ownership is invisible, so a press swallowed by a
    // script's auto gate must say so. The press is still delivered (the gate owns the semantics:
    // auto overrides by overwriting, and scripts without the convention keep plain hand behavior);
    // the hint is feedback only. Counted across the selection so a mixed C still fires the rest.
    let owned = 0
    for (const id of s.selectedIds) {
      const part = s.scene.parts.find((p) => p.id === id)
      if (!part) continue
      if (isCargoPart(part)) {
        // pin flipped → the live body catches up on the spot (mid-drag presses are handled by the
        // keydown drag guard instead, where the body is already kinematic until release)
        if (toggleCargoPin(ec, [id])) ec.sim.freezeBody(id, ec.frozenCargo.has(id))
        continue
      }
      if (part.type === 'part') {
        // only a part whose Use would otherwise take effect can be "dead because owned" (pilotUsable =
        // the author's interactive flag; a plain PLC actuator's C is inert in hand mode too)
        if (pilotUsable(part) && partUseInAuto(p, ec, id, s)) owned++
        ec.sim.usePart(id)
      }
    }
    if (owned > 0) {
      ec.store.flashViewportHint(owned === 1 ? 'In auto - PLC controlled' : `${owned} in auto - PLC controlled`)
    }
  } else {
    // stopped: no running behavior to receive ctx.used() - the device's live session takes it (idleUsePart)
    for (const id of s.selectedIds) idleUsePart(ec, id)
  }
}

/**
 * A stopped-scene Use on one part, from the editor's C or the walking character's E - one model for both. The
 * press goes to the device's live session (controller/useSessions.ts UseSessions, sim/idlePose IdleUseSession): opened on
 * the first press at the state the design gives it, then stepped each frame, so the device moves and stays the way
 * a press leaves it, and a second press does what a second press does. Session state, never the document.
 * Not for a part that is not an interactive custom part, or for a posable manipulator (those own their idle pose
 * via the `pose` param + teach gizmo, see refreshIdlePoses).
 */
function idleUsePart(ec: PilotDeps, partId: string): void {
  const s = ec.store.getState()
  const part = s.scene.parts.find((p) => p.id === partId)
  if (part?.type !== 'part') return
  const pkg = getPackage((part as SdkPart).packageId)
  if (!pkg?.interactive) return
  if (pkg.geometry.kind === 'rig' && pkg.geometry.posable === true) return
  // what its zones hold in the stopped scene, as the static preview sees it (refreshIdlePoses), so the session
  // starts from the pose on screen: a dispenser holding its authored stack, not parked under it
  const zones = pkg.holds && pkg.geometry.kind === 'rig' ? authoredZoneCounts(part as SdkPart, pkg, buildAuthoredCargoFrame(ec.editTargetViewScene(s).parts)) : undefined
  const params = ((part as SdkPart).params ?? {}) as Record<string, ParamValue>
  ec.pressIdle(partId, idleKey(pkg.behavior, params, zones), () => IdleUseSession.open(pkg.behavior, params, zones, rigJointsJson(pkg.geometry), posableArraysJson(pkg.geometry)))
}

/** how far from the hands a flex conveyor's control point can be and still be taken hold of, metres */
const FLEX_REACH = 2.5
/** how fast the held end of a flex conveyor goes, m/s, and the character with it. Opening, closing or bending the bed
 *  is light work (the scissors run free and the far end stands), so a brisk walk. Moving the whole unit, the far end
 *  rolling too, is towing a unit of rollers and scissors on its casters: a slow haul. Either way the end never
 *  outruns the hands' pace, so a flick of the view cannot whip it round */
const FLEX_WALK_SPEED = 2
const FLEX_HAUL_SPEED = 1

/** a flex conveyor as the walk shows it: authored, with this walk's pulled shape and pose over it (store.walkFlex) */
function walkedFlex(ec: PilotDeps, partId: string): PartInstance | null {
  const s = ec.store.getState()
  const part = s.scene.parts.find((p) => p.id === partId)
  if (!part) return null
  const walked = s.walkFlex?.[partId]
  return walked ? withFlexPose(part, walked) : part
}

/** where a flex's grip sits in the world: its infeed (the part origin), its discharge end, or one of its path points */
function flexGripAt(part: PartInstance, points: readonly [number, number][], grip: FlexGrip): { x: number; z: number } | null {
  if (grip === 'infeed') return points.length ? { x: part.position[0], z: part.position[2] } : null
  const p = points[grip === 'discharge' ? points.length - 1 : grip]
  return p ? toWorldXZ(part, p[0], p[1]) : null
}

/** the flex conveyor under the crosshair and its grip (either end, or a path point) nearest the hands, if within
 *  reach; else null. `braked` when that grip is an end whose caster brakes are on: the hands cannot move it */
function flexUnderCrosshair(ec: PilotDeps): { partId: string; grip: FlexGrip; braked: boolean } | null {
  const hold = ec.view.pilotHoldPoint()
  if (!hold) return null
  for (const id of ec.view.pilotLookParts()) {
    const part = walkedFlex(ec, id)
    const g = part ? flexPathOf(part) : null
    if (!part || !g) continue
    let best: { partId: string; grip: FlexGrip; braked: boolean } | null = null
    let bestD = FLEX_REACH
    // the ends by name: dragging one re-lays the path through a point per hinge (core flexPull), so an index would
    // stop meaning the end after the first step
    const grips: FlexGrip[] = ['infeed', ...g.points.map((_, i) => i).slice(0, -1), 'discharge']
    for (const grip of grips) {
      const w = flexGripAt(part, g.points, grip)
      const d = w ? Math.hypot(w.x - hold.position[0], w.z - hold.position[2]) : Infinity
      if (d < bestD) {
        bestD = d
        best = { partId: id, grip, braked: grip === 'infeed' || grip === 'discharge' ? g.braked[grip] : false }
      }
    }
    return best
  }
  return null
}

/**
 * Each rendered frame while the character holds a flex conveyor: the end it holds follows the hands across the
 * floor, and the bed re-fits behind it, the other end staying put (core flexPull). Held by an end, a pull further
 * than the bed can stretch or bend draws the whole unit after the hands (flexPull's dragAlong), like a real flex on
 * casters, unless the far end's brakes are on; otherwise it stops at the limit. Walk-session state
 * (store.setWalkFlex), never an edit: leaving walk mode puts it back where it was authored.
 */
function pullFlex(p: PilotState, ec: PilotDeps): void {
  const held = p.flex
  if (!held) return
  const part = walkedFlex(ec, held.partId)
  const g = part ? flexPathOf(part) : null
  const cur = part && g ? flexGripAt(part, g.points, held.grip) : null
  const hold = ec.view.pilotHoldPoint()
  if (!part || !cur) {
    releaseFlex(p, ec)
    return
  }
  if (!hold) return
  // the end goes toward the hands no faster than the pace the load allows (FLEX_WALK_SPEED / FLEX_HAUL_SPEED): a flick
  // of the view cannot whip it round. Every hinge after the end only follows the one ahead of it, so this caps how fast
  // any part of the bed moves, and how fast a stretched one can swing. (dt is capped at 0.1 s so a long frame can't make it jump.)
  const now = performance.now()
  const dt = Math.min(0.1, Math.max(0, (now - held.at) / 1000))
  held.at = now
  const dx = hold.position[0] - cur.x, dz = hold.position[2] - cur.z
  const gap = Math.hypot(dx, dz)
  if (gap < 0.02) return
  const k = Math.min(1, ((held.towing ? FLEX_HAUL_SPEED : FLEX_WALK_SPEED) * dt) / gap)
  // every frame: the drawn bed follows the hands, and the controller hands the running sim the shape at a walking pace
  // (pushWalkFlexToSim), since each is a rebuild of the part there
  const next = flexPull(part, held.grip, cur.x + dx * k, cur.z + dz * k, { dragAlong: true })
  if (!next) return
  // towing = this pull moved the far end, so the whole unit is rolling: the character slows to hauling pace until a
  // pull leaves the far end standing again
  const farBefore = flexGripAt(part, g!.points, held.grip === 'infeed' ? 'discharge' : 'infeed')
  const moved = withFlexPose(part, next)
  const gNext = flexPathOf(moved)
  const farAfter = gNext ? flexGripAt(moved, gNext.points, held.grip === 'infeed' ? 'discharge' : 'infeed') : null
  const towing = !!farBefore && !!farAfter && Math.hypot(farAfter.x - farBefore.x, farAfter.z - farBefore.z) > 1e-4
  if (towing !== held.towing) {
    held.towing = towing
    ec.view.setPilotSpeedLimit(towing ? FLEX_HAUL_SPEED : FLEX_WALK_SPEED)
  }
  ec.store.setWalkFlex(held.partId, next)
}

/** take hold of a flex conveyor: its end follows the hands, and the character walks at the load's pace while it does */
function holdFlex(p: PilotState, ec: PilotDeps, partId: string, grip: FlexGrip): void {
  p.flex = { partId, grip, at: performance.now(), towing: false }
  ec.view.setPilotSpeedLimit(FLEX_WALK_SPEED)
}

/** let go of a held flex conveyor, and walk freely again */
export function releaseFlex(p: PilotState, ec: PilotDeps): void {
  p.flex = null
  ec.view.setPilotSpeedLimit(null)
}

/** nearest part under the pilot crosshair the pilot can use, or null */
function pilotUsableUnderCrosshair(ec: PilotDeps): string | null {
  const parts = ec.store.getState().scene.parts
  for (const id of ec.view.pilotLookParts()) {
    const part = parts.find((p) => p.id === id)
    if (part && pilotUsable(part)) return id
  }
  return null
}

export function dropCarried(p: PilotState, ec: PilotDeps): void {
  if (!p.carry) return
  ec.sim.holdBody(p.carry.partId, false)
  p.carry = null
  ec.store.setPilotPrompt(null)
}

/** a stable part id for a carried body, promoting a transient spawner box like selectBox does (null only
 *  if the oip.box cargo package isn't registered, so there's nothing to promote onto). */
function ensureCargoPart(ec: PilotDeps, box: BoxPick): string | null {
  return box.partId ?? ec.promoteCargoBox(box)
}

/** each sim frame while piloting: drive the body's push capsule + steer any carried cargo */
export function pilotFrameTick(p: PilotState, ec: PilotDeps, frame: BoxFrame): void {
  if (ec.store.getState().mode !== 'pilot') return
  // the pilot shoves cargo it walks into: track the walking feet with a kinematic
  // capsule in the sim. Independent of carry, so it works whether hands-free or carrying.
  ec.sim.setPilotBody(ec.view.pilotBodyPosition())
  const carry = p.carry
  if (!carry) return
  // the carried body left the sim (despawned): stop carrying it
  if (frame.partIds.indexOf(carry.partId) < 0) {
    p.carry = null
    ec.store.setPilotPrompt(null)
    return
  }
  const hold = ec.view.pilotHoldPoint()
  if (hold) ec.sim.setHoldTarget(carry.partId, hold.position, hold.rotationY)
}

/**
 * Crosshair prompt for the interactable under the pilot's gaze, refreshed
 * every rendered frame (so it works whether or not the sim runs). Carriable
 * cargo wins first (only while running), then a hand-operable part.
 */
export function updatePilotPrompt(p: PilotState, ec: PilotDeps): void {
  // inside a headset the DOM prompt can't be seen: the controller laser shows whether a press would act
  // (so not merely whether there is a prompt: "In auto" is a prompt precisely because the press does nothing)
  ec.view.setPilotAimLive(refreshPilotPrompt(p, ec))
}

/** refresh the prompt; true when a press right now would do something (pick up, drop, use) */
function refreshPilotPrompt(p: PilotState, ec: PilotDeps): boolean {
  const s = ec.store.getState()
  if (s.mode !== 'pilot') return false
  if (p.carry) return true // the prompt stays 'Drop', and the press drops
  if (p.flex) {
    pullFlex(p, ec)
    ec.store.setPilotPrompt('Let go')
    return true
  }
  if (s.running && ec.view.pilotLookBox()) {
    ec.store.setPilotPrompt('Pick up')
    return true
  }
  if (ec.view.pilotLookDockLeaf()) {
    ec.store.setPilotPrompt('Use')
    return true
  }
  const flex = flexUnderCrosshair(ec)
  if (flex) {
    // a braked end says why it won't move, rather than offering a Pull the press would ignore
    ec.store.setPilotPrompt(flex.braked ? 'Brakes on' : 'Pull')
    return !flex.braked
  }
  const usableId = pilotUsableUnderCrosshair(ec)
  if (!usableId) {
    ec.store.setPilotPrompt(null)
    return false
  }
  // ownership is invisible state, so it must be surfaced at the point of interaction: an owned device tells
  // the pilot who has it instead of offering a dead "Use" (the press would be ignored by the script's auto gate)
  const auto = partUseInAuto(p, ec, usableId, s)
  ec.store.setPilotPrompt(auto ? 'In auto - PLC controlled' : 'Use')
  return !auto
}

/**
 * Is the part's Use in auto: a comms device whose command tag the attached program
 * drives (declares as an output)? Mirrors the interactive family's script gate (`tagDriven(tag)`)
 * from the host-visible side: only the package's `'tag'` params marked `autoWhenDriven`
 * count (the ones the script's auto gate actually reads - a driven indicator tag like a button's `lampTag`
 * never owns the press), a declared comms switch (`commsParam`) gates them, and `ec.plcDrivenKeys` is the same output set
 * the worker's ctx.tagDriven reads. A script that doesn't declare the convention just keeps plain hand
 * behavior. Serves both surfaces of the same rule: the pilot crosshair prompt (per-frame - hence the memo
 * on frame-stable keys: part id, attach rev, scene identity; resolving the scoped tag walks the parts
 * list, too heavy for every frame) and the editor C press's "In auto" hint (one-shot, cache misses are
 * harmless there).
 */
function partUseInAuto(p: PilotState, ec: PilotDeps, partId: string, s: EdState): boolean {
  if (!s.running || ec.plcDrivenKeys.size === 0) return false
  const cache = p.autoCache
  if (cache && cache.id === partId && cache.rev === ec.plcDrivenRev && cache.scene === s.scene) return cache.auto
  let auto = false
  const part = s.scene.parts.find((p) => p.id === partId)
  if (part?.type === 'part') {
    const pkg = getPackage((part as SdkPart).packageId)
    const params = ((part as SdkPart).params ?? {}) as Record<string, unknown>
    // the declared comms switch gates the tag (package.commsParam); a part without one keeps its tags always live
    const comms = commsOn(part)
    if (pkg && comms) {
      for (const [name, spec] of Object.entries(pkg.params)) {
        if (spec.type !== 'tag' || spec.autoWhenDriven !== true) continue
        const tag = params[name]
        if (typeof tag !== 'string' || tag === '') continue
        if (ec.plcDrivenKeys.has(tag)) {
          auto = true
          break
        }
      }
    }
  }
  p.autoCache = { id: partId, rev: ec.plcDrivenRev, scene: s.scene, auto }
  return auto
}
