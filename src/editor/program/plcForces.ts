// The running program's forced variables, as the surfaces that show or set a force read them (the Watch dock, the
// toolbar's count, the rungs, a device's tags, the Inspector, the Scene tree): which variable a part's tag field
// forces, and which parts have a forced signal. A force is held by the controller (EditorController.forcePlcValue);
// this only reads it.

import { useEffect, useState } from 'react'
import { keySetOf } from '../../core/watchKeys'
import { watchElementKey, watchKeysOf } from '../../core/watchTable'
import type { TagValue } from '../../plc'
import { deviceTags, devicesForTag, type DeviceTags, type DeviceTagUse, type TaggedPart } from '../../plc/bindings'

export type Forces = Readonly<Record<string, number | boolean>>
/** bare scene tag -> the sole program instance's variable: the attached link's own aliases (LocalPlcLink.aliases,
 *  EditorController.plcAliases). The only bare-name rule a part's tag binds by (plc/DEVICE-IO.md). */
export type Aliases = ReadonlyMap<string, string>

/** What a surface needs of the controller to follow the forces. */
export interface ForceSource {
  readonly plcForces: Forces
  onPlcForces(cb: () => void): () => void
}

/** The forces, re-read whenever one is set or released (empty with no controller yet). */
export function usePlcForces(controller: ForceSource | null | undefined): Forces {
  const [forces, setForces] = useState<Forces>(() => controller?.plcForces ?? {})
  useEffect(() => {
    if (!controller) return
    const sync = (): void => setForces(controller.plcForces)
    sync()
    return controller.onPlcForces(sync)
  }, [controller])
  return forces
}

// the image's keys by their upper-case spelling: IEC names are case-insensitive. One per key set (core/watchKeys.ts):
// a running program's image is a new object on every send, with the same keys.
const byUpper = new WeakMap<object, Map<string, string>>()
function upperKey(watch: Readonly<Record<string, TagValue>>, name: string): string | undefined {
  const set = keySetOf(watch)
  let m = byUpper.get(set)
  if (!m) {
    m = new Map(watchKeysOf(watch).map((k) => [k.toUpperCase(), k]))
    byUpper.set(set, m)
  }
  const listed = m.get(name.toUpperCase())
  if (listed !== undefined) return listed
  // an element of an array too long to be among the keys is asked of the table (core/watchTable.ts), and taken only
  // under the name as written: a force never binds by a suffix
  const element = watchElementKey(watch, name)
  return element !== null && element.toUpperCase() === name.toUpperCase() ? element : undefined
}

/** The variable a tag name means: its alias's target (case-insensitive, as IEC names are), or the name itself. */
function aliasTarget(tag: string, aliases: Aliases | undefined): string {
  if (!aliases || aliases.size === 0) return tag
  const u = tag.toUpperCase()
  for (const [bare, target] of aliases) if (bare.toUpperCase() === u) return target
  return tag
}

/**
 * The running program's watch key for a tag a part names: the variable a force on that field holds. The tag binds as
 * the link binds it, by its exact name or the link's own alias for it (never by a suffix guess: a struct field or one
 * of two instances that happens to end in the name is not what the part reads). One bit of a word (`Status.3`) is its
 * word's key and the bit. Null when there is none to force: stopped, an empty field, a direct address such as %IX0.0
 * (no program variable), a name the program does not bind, or a STRING (which cannot be forced).
 */
export function forceKeyOf(tag: string, watch: Readonly<Record<string, TagValue>> | null | undefined, aliases?: Aliases): string | null {
  const t = tag.trim()
  if (!watch || t === '' || t.startsWith('%')) return null
  const name = aliasTarget(t, aliases)
  const key = upperKey(watch, name)
  if (key !== undefined) return typeof watch[key] === 'string' ? null : key
  const bit = /^(.+)\.([0-9]+)$/.exec(name)
  const word = bit ? upperKey(watch, bit[1]!) : undefined
  return word !== undefined && typeof watch[word] === 'number' && Number(bit![2]) < 32 ? `${word}.${bit![2]}` : null
}

/**
 * The ids of the devices with a tag field on a forced variable. `keyOf` maps a field's tag to the watch key a force
 * holds (forceKeyOf against the running image). A device whose declared comms switch is off reads none of its tags,
 * so no force reaches it.
 */
export function forcedDeviceIds(devices: readonly DeviceTags[], forces: Forces, keyOf: (tag: string) => string | null): Set<string> {
  const out = new Set<string>()
  if (Object.keys(forces).length === 0) return out
  for (const d of devices) {
    if (!d.enabled) continue
    if (d.fields.some((f) => {
      const key = keyOf(f.value)
      return key !== null && key in forces
    })) out.add(d.id)
  }
  return out
}

/** {@link forcedDeviceIds} for a scene's parts, against the running image and the link's aliases. */
export function partsWithForces(parts: readonly TaggedPart[], forces: Forces, watch: Readonly<Record<string, TagValue>> | null | undefined, aliases?: Aliases): Set<string> {
  if (!watch || Object.keys(forces).length === 0) return new Set()
  return forcedDeviceIds(deviceTags(parts), forces, (tag) => forceKeyOf(tag, watch, aliases))
}

/**
 * Every part field wired to a value of the running program: by the name as written, by the image's key, by a bare name
 * the link aliases to that variable (a part may name `Run` for `Line.Run` when `Line` is the sole program instance:
 * `aliases`, the link's own rule, never a prefix guess), and, for one bit of a word (`Status.3`), by the word it is a
 * bit of.
 */
export function devicesWiredTo(devices: readonly DeviceTags[], name: string, key: string | null, aliases?: Aliases): DeviceTagUse[] {
  const names = new Set<string>()
  const add = (n: string): void => {
    names.add(n.toUpperCase())
    const bit = /^(.+)\.[0-9]+$/.exec(n)
    if (bit) names.add(bit[1]!.toUpperCase())
  }
  add(name)
  if (key !== null) add(key)
  // the bare names the link binds to the same variable (or to the word a bit belongs to)
  for (const [bare, target] of aliases ?? []) {
    const t = target.toUpperCase()
    if ([...names].includes(t)) names.add(bare.toUpperCase())
  }
  const seen = new Set<string>()
  const out: DeviceTagUse[] = []
  for (const n of names)
    for (const u of devicesForTag(devices, n)) {
      const id = `${u.device.id}:${u.field}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push(u)
    }
  return out
}
