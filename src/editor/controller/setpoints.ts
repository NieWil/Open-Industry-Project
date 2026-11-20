// Live analog setpoints: what the running ST program is actually commanding into a part's number params.
//
// A conveyor's `speedTag` replaces its `speed` param in the behavior - `tag ? readNumber(tag) :
// params.speed` - so while the scene runs, the Inspector's authored `speed` is a number nothing obeys: a
// program commanding 0.5 leaves the field reading 1. This module is the host-visible half of that rule
// (the analog twin of pilot.ts's `partUseInAuto` for boolean command tags): it walks the package's `'tag'`
// params marked `setpointFor`, resolves each one against the same live table the worker feeds the
// behavior, and hands back the value per target param key for the Inspector to show in place of the
// authored one.
//
// Resolution mirrors sim/plcHost.interleave exactly, so what the field shows is what the part read: the
// program's variable image, looked up by the tag the part's param names.
//
// The gate is running, not program-attached: a bound setpoint is consulted whenever it names a tag (and,
// on a custom part with a comms switch, the switch is on), so with no program (or a program that never declares the tag) the behavior reads an unset
// tag, which is 0. The conveyor then sits still while the Inspector would show the authored speed. That is
// the same wrong readout, so an empty tag table resolves to 0 here rather than falling back.
// Stopped, nothing is commanding anything and the authored params rule again.

import { getPackage } from '../../core/parts/partRegistry'
import type { SdkPart, PartInstance } from '../../core/types'
import type { TagValue } from '../../plc'
import type { EditorController } from '../controller'

/** target param key → the value being commanded into it, the tag it came from, and whether a program
 *  actually drives that tag (an undriven analog setpoint still replaces the param - it just reads 0) */
export type LiveSetpoints = Record<string, { value: number | boolean | string; tag: string; driven: boolean; source?: 'product' | 'program' }>

/** an unattached program presents an empty tag table - every setpoint reads 0, exactly as the behavior sees it */
const NO_TAGS: Readonly<Record<string, TagValue>> = {}

/**
 * The live commanded values for one part's setpoint-bound number params, or null when nothing is
 * commanding it (sim stopped, comms off, or no `setpointFor` tag bound). Callers treat a null / missing
 * key as "the authored param rules".
 */
export function liveSetpoints(ec: EditorController, parts: readonly PartInstance[], partId: string): LiveSetpoints | null {
  if (!ec.store.getState().running) return null
  const globals = ec.plcGlobalTags ?? NO_TAGS
  const part = parts.find((p) => p.id === partId)
  if (part?.type !== 'part') return null
  const pkg = getPackage((part as SdkPart).packageId)
  if (!pkg) return null
  const params = ((part as SdkPart).params ?? {}) as Record<string, unknown>
  // Product attributes: a product's attribute params are its marks at run, and machines update them (a wrapper
  // marking `wrapped`), so the field shows what the product carries now, not what was authored
  let product: LiveSetpoints | null = null
  let liveMarks: Readonly<Record<string, number | boolean | string>> | null = null
  for (const [key, spec] of Object.entries(pkg.params ?? {})) {
    if (!spec.attribute) continue
    liveMarks ??= ec.marksOf(partId) // asked only for a part that has attributes
    const v = liveMarks[key]
    if (v !== undefined) (product ??= {})[key] = { value: v, tag: '', driven: true, source: 'product' }
  }
  // Programs: the row a program param's steps are being run from (ParamSpec.program), as the part reported it
  // (ctx.report) - the robot's job step, highlighted in its editor. Nothing reported is nothing running.
  for (const [key, spec] of Object.entries(pkg.params ?? {})) {
    if (spec.type !== 'numberList' || !spec.program) continue
    const row = ec.reportedValues?.[partId]?.[key]
    if (typeof row === 'number') (product ??= {})[key] = { value: row, tag: '', driven: true, source: 'program' }
  }
  const withProduct = (o: LiveSetpoints | null): LiveSetpoints | null => (product ? { ...(o ?? {}), ...product } : o)
  // the declared comms switch gates the tags (package.commsParam); a part without one keeps them always live
  const comms = pkg.commsParam === undefined || params[pkg.commsParam] === true
  if (!comms) return withProduct(null)
  let out: LiveSetpoints | null = null
  for (const [key, spec] of Object.entries(pkg.params ?? {})) {
    if (spec.type !== 'tag' || typeof spec.setpointFor !== 'string' || !spec.setpointFor) continue
    const tag = params[key]
    if (typeof tag !== 'string' || tag === '') continue // unbound → the authored param rules
    const driven = ec.plcDrivenKeys.has(tag)
    // Match the script's own gate, or the readout is wrong in the other direction. Scripts use two:
    // plain truthiness (`comms && tag ? readNumber(tag) : param` - a conveyor's speedTag) and
    // ownership (`comms && tagDriven(tag) ? readNumber(tag) : manual` - the stack light's bitmask).
    // `autoWhenDriven` is exactly the flag that already distinguishes them, so no new vocabulary:
    // flagged ⇒ the tag rules only while a program owns it, and an undriven one falls back to the
    // authored param - showing 0 there would invent a value the part never used.
    if (spec.autoWhenDriven === true && !driven) continue
    // Value: prefer what the behavior reported (ctx.report). It is published from the very expression the
    // part acted on, so it can't drift from the script and it carries everything the tag alone doesn't
    // explain: a runTag gating the setpoint to 0, a `reverse` flip, a ramp, a clamp. The tag read below is
    // the fallback for a part that hasn't adopted `report` (and for the first frames before one arrives).
    const reported = ec.reportedValues?.[partId]?.[spec.setpointFor]
    const v = reported !== undefined ? reported : globals[tag]
    // an unset tag reads 0 in the behavior (ctx.readNumber) - whether no program is attached or the
    // attached one never declares it - so show 0 rather than the authored value the part isn't using.
    // `driven` (the same output-ownership set as ctx.tagDriven) separates the two for the readout: a
    // commanded 0 and a nobody-home 0 look identical on the number but mean very different things.
    ;(out ??= {})[spec.setpointFor] = {
      value: typeof v === 'number' ? v : v === true ? 1 : 0,
      tag,
      driven,
    }
  }

  // Boolean command tags have the same problem in the other type. A hand-operable comms device declares the
  // boolean param that is its hand state (`useParam`: the blade stop's `active`, the diverter's `diverted`,
  // the chain transfer's `raised`) and flags the tag that commands it (`autoWhenDriven`), so the link the
  // Inspector needs is already in the schema, no second declaration. While a program owns that tag the
  // script overwrites the latch from it, and the checkbox showing the authored state is a readout of
  // something the running scene isn't obeying. Strictly ownership-gated: released, the device holds its
  // last commanded pose rather than reverting, so the authored param is the right thing to show again.
  const useParam = pkg.useParam
  if (useParam !== undefined && pkg.params?.[useParam]?.type === 'boolean') {
    for (const [key, spec] of Object.entries(pkg.params ?? {})) {
      if (spec.type !== 'tag' || spec.autoWhenDriven !== true) continue
      const tag = params[key]
      if (typeof tag !== 'string' || tag === '') continue
      if (!ec.plcDrivenKeys.has(tag)) continue // hand-operable → the authored param rules
      const reported = ec.reportedValues?.[partId]?.[useParam]
      ;(out ??= {})[useParam] = { value: reported !== undefined ? reported === true : globals[tag] === true, tag, driven: true }
      break // one hand state, one command tag
    }
  }
  return withProduct(out)
}

/** The running program's variable image, where a part's setpoint tag is looked up. Null when no program is attached. */
export function globalTags(ec: EditorController): Readonly<Record<string, TagValue>> | null {
  return ec.plcWatch
}
