// The only place the engine folds a conveyor's snap-owned `reverse` flag into its authored `speed`.
//
// A curve can't be rotated 180° to turn its flow around, because that would swap its inner/outer radius.
// So the snap flips a hidden `reverse` flag instead when it mates two ends that both discharge into (or both
// feed from) the junction. Reversing by hand is a negative `speed`. `reverse` is engine storage the Inspector
// never shows (ParamSpec.hidden), so snapping a curve never rewrites the number the user typed.
//
// Which params those are is declared (partPackage.ts ConveyorDecl `speedParam` / `reverseParam`; package format 3
// read params named `speed` / `reverse`). Every engine-side consumer of a conveyor's direction goes through here:
// the flow arrow, the snap's output-end rule, the pilot's surface mirror, the render scroll. The part's own
// `step()` folds the same two fields itself (it runs sandboxed and can't import core), so keep the two in sync:
// effective speed is always `speed × (reverse ? −1 : 1)`.

import { getPackage } from '../parts/partRegistry'
import type { PartInstance } from '../types'

/** The params a conveyor declares for its speed and its snap-owned reverse flag (partPackage.ts ConveyorDecl), or
 *  nothing for a part that declares none (it has no speed the host can read outside its behavior's tick). */
export function conveyorSpeedParams(part: PartInstance): { speed?: string; reverse?: string } {
  const c = part.type === 'part' ? getPackage(part.packageId)?.conveyor : undefined
  return { ...(c?.speedParam ? { speed: c.speedParam } : {}), ...(c?.reverseParam ? { reverse: c.reverseParam } : {}) }
}

/**
 * A conveyor's signed conveying speed (m/s): its declared speed param folded with its declared, snap-owned
 * reverse flag. 0 for a part that declares no speed param.
 *
 * Note this is the authored direction, not the live one: comms gating / interlocks / a PLC speed tag can
 * override it at runtime (the frame handles that, see sim/world.ts). Same fidelity as the params
 * themselves, which is what the static consumers here want.
 */
export function conveyorSpeedOf(part: PartInstance): number {
  const keys = conveyorSpeedParams(part)
  const p = part.params as Record<string, unknown>
  const v = keys.speed ? p[keys.speed] : undefined
  const speed = typeof v === 'number' ? v : 0
  return keys.reverse && p[keys.reverse] === true ? -speed : speed
}

/** Is this part's flow reversed relative to its authored geometry (the snap-owned flag alone)? */
export function isConveyorReversed(part: PartInstance): boolean {
  const key = conveyorSpeedParams(part).reverse
  return key !== undefined && (part.params as Record<string, unknown>)[key] === true
}

/**
 * Is this part's PLC link switched on? A package declares the boolean param that switches it (`commsParam`); a
 * part whose package declares none is always connected. The one rule every consumer of "comms on" shares (the PLC
 * bindings, the wiring check, the pilot, the Inspector's setpoints, I/O assignment).
 */
export function commsOn(part: { type: string; packageId?: string; params: unknown }): boolean {
  if (part.type !== 'part' || !part.packageId) return false
  const pkg = getPackage(part.packageId)
  if (!pkg) return false // a package not loaded (yet): its signals are unknowable, so nothing of it is connected
  return pkg.commsParam === undefined || (part.params as Record<string, unknown>)[pkg.commsParam] === true
}

/** The param a part's comms switch lives in, if its package declares one (what the PLC panel's toggle writes). */
export function commsParamOf(part: { type: string; packageId?: string }): string | undefined {
  return part.type === 'part' && part.packageId ? getPackage(part.packageId)?.commsParam : undefined
}
