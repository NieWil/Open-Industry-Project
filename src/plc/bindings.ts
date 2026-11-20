// The PLC ⇄ scene contract is the device-IO tag bridge: a custom part's behavior reads/writes
// program tags by name (ctx.readTag/writeTag/readNumber/writeNumber), exchanged with the scan in-worker
// at step cadence (sim/plcHost.ts). What lives here is the
// authoring-warning walk over the bridge: which declared program tags does no comms-enabled custom part
// handle (unbound), and which scene tags does the program never declare (unwired) - surfaced by the ST
// editor. See src/plc/DEVICE-IO.md.

import { controllerOf } from '../core/io/controllerTag'
import { packageParamSpecs, switchValue, visibleWhenHolds } from '../core/packageParams'
import type { VisibleWhen } from '../core/types'
import { commsOn } from '../core/conveyor/conveyorDirection'
import { getPackage, registryRevision } from '../core/parts/partRegistry'
import type { PlcLink } from './link/plcLink'

/** A scene part with its params, for reading the per-part device-IO tag wiring. */
export interface TaggedPart {
  id: string
  type: string
  packageId?: string
  params: unknown
  name?: string
}

/**
 * One PLC tag a scene part speaks, with what the part declared about it: which way it flows and what it
 * carries. `section` is the program's side of the part's direction - a tag the part reads is the
 * program's VAR_OUTPUT, one it writes the program's VAR_INPUT - and is null when the part left the
 * direction undeclared. This is what lets an editor declare a scene tag the way the scene already has.
 */
export interface SceneTag {
  name: string
  section: 'VAR_INPUT' | 'VAR_OUTPUT' | null
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the part that speaks it (the first, when several do) and the field it is wired in */
  part: string
  field: string
  /** false when the part names the tag but has comms turned off - so nothing reads or writes it */
  enabled: boolean
}

function paramsOf(p: TaggedPart): Record<string, unknown> {
  return typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
}
/**
 * The params of a part that are in use: one that is one of two ways of saying the same thing (`visibleWhen` - a
 * conveyor's m/s speed tag beside its FPM one) counts only while its switch says so, the rule the Inspector shows
 * them by. The part does not read the other, so it is no tag field of the device and names no tag of the scene.
 */
function liveSpecs<T extends { key: string; kind: string; visibleWhen?: VisibleWhen; default?: unknown; whenAbsent?: unknown }>(specs: readonly T[], params: Record<string, unknown>): T[] {
  return specs.filter((x) => !x.visibleWhen || visibleWhenHolds(x.visibleWhen, switchValue(specs, params, x.visibleWhen.param)))
}

/** is this part's PLC link on (its declared comms switch; always, for a part that declares none) - core's one rule */
function isCommsEnabled(p: TaggedPart): boolean {
  return commsOn(p as { type: string; packageId?: string; params: unknown })
}

/**
 * Every PLC tag a comms-enabled custom part wires over the device-IO bridge, de-duplicated: the value of each
 * param whose package schema is a tag reference (the SDK `type: 'tag'` → `tagRef` spec). The ST editor offers
 * these as autocomplete so a program's VAR_INPUT/VAR_OUTPUT names match the tags the scene actually drives.
 */
export function commsTags(parts: readonly TaggedPart[]): string[] {
  return sceneTags(parts).map((t) => t.name)
}

/** One tag field of a device: the part's own view, a field with a name in it (or not yet). */
export interface DeviceTagField {
  key: string
  label: string
  section: 'VAR_INPUT' | 'VAR_OUTPUT' | null
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the unit of the value it carries (TagRefParamSpec.unit), absent when it has none */
  unit?: string
  /** the tag name wired in, `''` when unbound */
  value: string
}

/** A part that speaks tags, with every tag field its package declares - a device tree's row. */
export interface DeviceTags {
  id: string
  name: string
  /** the package's display name (`Belt Conveyor`), what a tree groups by */
  kind: string
  enabled: boolean
  /** the package declares a comms switch (`commsParam`), so `enabled` can be off; a part without one is connected
   *  whenever a field names a tag */
  switchable: boolean
  fields: DeviceTagField[]
}

/** Every part whose package declares tag fields, in scene order, comms on or off. */
export function deviceTags(parts: readonly TaggedPart[]): DeviceTags[] {
  const out: DeviceTags[] = []
  for (const p of parts) {
    if (p.type !== 'part') continue
    const pkg = getPackage(p.packageId ?? '')
    if (!pkg) continue
    const params = paramsOf(p)
    const fields: DeviceTagField[] = []
    for (const spec of liveSpecs(packageParamSpecs(pkg), params)) {
      if (spec.kind !== 'tagRef') continue
      const v = params[spec.key]
      fields.push({
        key: spec.key,
        label: spec.label,
        section: spec.dir === 'in' ? 'VAR_OUTPUT' : spec.dir === 'out' ? 'VAR_INPUT' : null,
        type: spec.stType ?? null,
        ...(spec.unit ? { unit: spec.unit } : {}),
        value: typeof v === 'string' ? v.trim() : '',
      })
    }
    if (fields.length === 0) continue
    out.push({ id: p.id, name: p.name ?? p.id, kind: pkg.name, enabled: isCommsEnabled(p), switchable: pkg.commsParam !== undefined, fields })
  }
  return out
}

/** Where a device's tag field is wired to the tag `name`: the part, and which of its fields speaks it. */
export interface DeviceTagUse {
  device: DeviceTags
  /** the field's label, as the Inspector reads it ("Run tag") */
  field: string
  section: 'VAR_INPUT' | 'VAR_OUTPUT' | null
}

/**
 * Every place the scene wires tag `name` (case-insensitively, as the runtime binds it), for a Cross Reference that
 * can say which part reads it and which writes it. A part with comms off is left out: its fields still hold names,
 * but nothing binds them, so listing it would claim a connection that does not exist.
 */
export function devicesForTag(devices: readonly DeviceTags[], name: string): DeviceTagUse[] {
  const want = name.trim().toUpperCase()
  if (want === '') return []
  const out: DeviceTagUse[] = []
  for (const device of devices) {
    if (!device.enabled) continue
    for (const f of device.fields) {
      if (f.value.trim().toUpperCase() === want) out.push({ device, field: f.label, section: f.section })
    }
  }
  return out
}

/** {@link commsTags}, with what each part declared about its tag; one entry per tag name (case-insensitive).
 *  `includeDisabled` lists tags on parts with comms off too (flagged `enabled: false`), for a message that can
 *  say "the part names it, but comms is off" instead of "undeclared". */
export function sceneTags(parts: readonly TaggedPart[], opts: { includeDisabled?: boolean } = {}): SceneTag[] {
  // Kept for the parts they were worked out from: a scene's parts are a new array whenever one changes, and a
  // ladder sheet asks once per rung on every redraw, which on a 420-part line was a quarter of a second each time.
  const rev = registryRevision()
  let kept = tagsOf.get(parts)
  if (!kept || kept.rev !== rev) tagsOf.set(parts, (kept = { rev }))
  const which = opts.includeDisabled ? 'all' : 'enabled'
  return (kept[which] ??= Object.freeze(sceneTagsOf(parts, opts)) as SceneTag[])
}
// (frozen above, so a caller that tried to change the shared list fails where it does so)
const tagsOf = new WeakMap<readonly TaggedPart[], { rev: number; enabled?: SceneTag[]; all?: SceneTag[] }>()

function sceneTagsOf(parts: readonly TaggedPart[], opts: { includeDisabled?: boolean }): SceneTag[] {
  const out = new Map<string, SceneTag>()
  for (const p of parts) {
    if (p.type !== 'part') continue
    const params = paramsOf(p)
    const enabled = isCommsEnabled(p)
    if (!enabled && !opts.includeDisabled) continue
    const pkg = getPackage(p.packageId ?? '')
    if (!pkg) continue
    for (const spec of liveSpecs(packageParamSpecs(pkg), params)) {
      if (spec.kind !== 'tagRef') continue
      const v = params[spec.key]
      if (typeof v !== 'string' || !v.trim()) continue
      const name = v.trim()
      const key = name.toUpperCase()
      // an enabled part's word outranks a disabled one's
      if (out.has(key) && (out.get(key)!.enabled || !enabled)) continue
      out.set(key, {
        name,
        section: spec.dir === 'in' ? 'VAR_OUTPUT' : spec.dir === 'out' ? 'VAR_INPUT' : null,
        type: spec.stType ?? null,
        part: p.name ?? p.id,
        field: spec.label,
        enabled,
      })
    }
  }
  return [...out.values()]
}

/**
 * The two authoring warnings a UI surfaces around the device-IO bridge:
 *  - `unbound`: a program tag (VAR_INPUT/OUTPUT) that no comms-enabled custom part reads/writes, and that no
 *    annotation displays. Detected by
 *    over-approximation - a part's STRING param equal to the tag name marks it handled (a colour/label param
 *    won't collide with a legal tag name, so this never false-negates) - which works whether the tag
 *    rides a `tagRef` param or a plain text one (e.g. the robot's `commandTag`).
 *  - `unwired`: the mirror - a scene tag the program declares in neither direction (usually a typo), from
 *    `commsTags`.
 */
export function unhandledProgramTags(
  parts: readonly TaggedPart[],
  link: Pick<PlcLink, 'inputs' | 'outputs' | 'aliases'>,
): { unbound: string[]; unwired: string[] } {
  const wantIn = new Set(link.inputs)
  const wantOut = new Set(link.outputs)
  const handled = new Set<string>()
  for (const p of parts) {
    // A display is a consumer too. An annotation reading a tag onto the layout handles it as surely as a
    // device driving one - so without this, every scene carrying a readout note reports that note's tag as
    // `unbound`, a false warning on the one feature whose entire job is to make a tag visible. It has no
    // comms switch (there is no device to switch on) and its tag is a plain param, so it needs its own arm
    // rather than falling through the comms-enabled walk below.
    if (p.type === 'annotation') {
      const t = typeof paramsOf(p)['tag'] === 'string' ? (paramsOf(p)['tag'] as string).trim() : ''
      if (t && (wantIn.has(t) || wantOut.has(t))) handled.add(t)
      continue
    }
    if (p.type !== 'part') continue
    const params = paramsOf(p)
    if (!isCommsEnabled(p)) continue
    for (const v of Object.values(params)) {
      if (typeof v !== 'string') continue
      const t = v.trim()
      if (t && (wantIn.has(t) || wantOut.has(t))) handled.add(t)
    }
  }
  // a bare alias and the variable it names (plcLink.ts soleInstanceAliases) are one tag: either spelling handles it,
  // and an unhandled one is reported once, by its own name
  const canon = (t: string): string => link.aliases?.get(t) ?? t
  const handledVars = new Set([...handled].map(canon))
  const reported = new Set<string>()
  const unbound = [...link.inputs, ...link.outputs].filter((t) => {
    const v = canon(t)
    if (handledVars.has(v) || reported.has(v)) return false
    reported.add(v)
    return true
  })
  const declared = new Set([...link.inputs, ...link.outputs])
  // a tag on another controller (`Cell2::Eye`, core/io/controllerTag.ts) is not this program's to declare
  const unwired = commsTags(parts).filter((t) => !declared.has(t) && controllerOf(t) === null)
  return { unbound, unwired }
}
