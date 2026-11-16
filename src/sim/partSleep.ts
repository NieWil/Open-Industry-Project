// When a reactive part is called. A part that defines `react` in place of `step` (core/parts/partApi.ts) is called on
// its first step, on any step where something the host hands it differs from its last call, and on the step after a
// call in which it asked for one (ctx.again). On every other step it is not called and its last outputs stand: the
// tags it wrote, its surface speeds, joints, lamps and displays. A line is mostly parts with nothing to do, and
// calling 400 of them a step to hear that cost more than the physics.
//
// This is what the part is defined to do, in the app, in project tests and in bench-sim alike. It is not a faster
// path beside stepping that has to agree with it.
//
// "Differs" is decided here, per input. An input this cannot compare cheaply counts as changed, which only means a
// call the part did not need: react may be called on any step and must not take a call to mean something changed.
import type { FrameBeamHit } from '../core/frame'
import type { BehaviorInput, BehaviorOutput } from './embeddedBehavior'

export interface SleepState {
  /** the part's last call was a react that did not ask for another: it waits for an input to change */
  idle: boolean
  /** it read a conveyor's speed on its last call; one that did not is not called for a speed changing */
  usesSpeeds: boolean
  // what it was handed on its last call
  tags: unknown
  driven: unknown
  speeds: unknown
  position: unknown
  forward: unknown
  beams: Record<string, FrameBeamHit> | undefined
  zones: Record<string, number> | undefined
  zoneAges: Record<string, number> | undefined
  joints: Record<string, number> | undefined
  grips: Record<string, boolean> | undefined
  gripWidths: Record<string, number> | undefined
}

export function newSleepState(): SleepState {
  return { idle: false, usesSpeeds: true, tags: undefined, driven: undefined, speeds: undefined, position: undefined, forward: undefined, beams: undefined, zones: undefined, zoneAges: undefined, joints: undefined, grips: undefined, gripWidths: undefined }
}

function isEmpty(o: object): boolean {
  for (const _ in o) return false
  return true
}

function sameValues<T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined): boolean {
  if (a === b) return true
  // none yet and none: a rig's measured joints are absent on its first step and an empty table after it
  if (!a || !b) return isEmpty(a ?? b ?? {})
  let n = 0
  for (const k in a) {
    if (a[k] !== b[k]) return false
    n++
  }
  for (const _ in b) n--
  return n === 0
}

function sameBeams(a: Record<string, FrameBeamHit> | undefined, b: Record<string, FrameBeamHit> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  let n = 0
  for (const k in a) {
    const x = a[k]!
    const y = b[k]
    if (!y || x.hit !== y.hit || x.distance !== y.distance || x.marks !== y.marks) return false
    if (x.color[0] !== y.color[0] || x.color[1] !== y.color[1] || x.color[2] !== y.color[2]) return false
    n++
  }
  for (const _ in b) n--
  return n === 0
}

/** Is this step's input what the part was handed on its last call? */
function inputsSame(s: SleepState, inp: BehaviorInput): boolean {
  // a click, a load cell and a zone's marks are not compared
  if (inp.used === true || inp.weights !== undefined) return false
  if (inp.zoneMarks !== undefined || inp.zoneMix !== undefined) return false
  // the tag tables are replaced when a value changes and never written in place (SimWorld.setBehaviorInputTags)
  if (inp.tags !== s.tags || inp.driven !== s.driven) return false
  if (s.usesSpeeds && inp.conveyorSpeeds !== s.speeds) return false
  if (inp.position !== s.position || inp.forward !== s.forward) return false
  return sameBeams(inp.beams, s.beams) && sameValues(inp.zones, s.zones) && sameValues(inp.zoneAges, s.zoneAges) && sameValues(inp.joints, s.joints) && sameValues(inp.grips, s.grips) && sameValues(inp.gripWidths, s.gripWidths)
}

function rememberInputs(s: SleepState, inp: BehaviorInput): void {
  s.tags = inp.tags
  s.driven = inp.driven
  s.speeds = inp.conveyorSpeeds
  s.position = inp.position
  s.forward = inp.forward
  s.beams = inp.beams // a new object every step, so holding it is safe
  s.zones = inp.zones
  s.zoneAges = inp.zoneAges
  // the measured joints and grips are objects the rig driver rewrites, so copies
  s.joints = inp.joints ? { ...inp.joints } : undefined
  s.grips = inp.grips ? { ...inp.grips } : undefined
  s.gripWidths = inp.gripWidths ? { ...inp.gripWidths } : undefined
}

/** Is the part left out of this step? One that is not is about to be called, and is no longer waiting. */
export function waits(s: SleepState, inp: BehaviorInput, wakeAll: boolean): boolean {
  if (s.idle && !wakeAll && inputsSame(s, inp)) return true
  s.idle = false
  return false
}

/** After a call: a reactive part that asked for nothing more waits, on the inputs it was just handed. */
export function noteCall(s: SleepState, inp: BehaviorInput, out: BehaviorOutput): void {
  if (out.idle !== true) return
  s.idle = true
  s.usesSpeeds = out.readSpeeds === true
  rememberInputs(s, inp)
}
