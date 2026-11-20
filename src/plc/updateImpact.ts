// What a part update breaks in this project (docs/part-sources.md, "What an update changes").
//
// core/parts/partChanges.ts compares two versions of a part and calls a removed or retyped signal breaking. Whether it
// breaks anything here depends on the project: a signal no placed copy is wired to is harmless, one the program reads
// is the real break. This answers that, for each breaking signal change: which placed copies wire it, to which tag,
// and where else that tag is used - the program's rungs and lines (plc/crossRef.ts) and the other devices wired to it
// (plc/bindings.ts). It reads the scene through the live registry, so the part's spec is the project's own copy, the
// version the update would replace.

import type { PartChange } from '../core/parts/partChanges'
import { deviceTags, devicesForTag, type TaggedPart } from './bindings'
import { crossReference, type TagRef } from './crossRef'
import { IEC_REFS } from './ladder/ladderLeaves'
import { readLadder } from './ladder/ladderRungs'

/** One placed copy wired to a signal the update breaks. */
export interface SignalUse {
  partId: string
  partName: string
  /** the tag the copy is wired to */
  tag: string
  /** the other devices wired to the same tag, as "<part> (<field>)" */
  devices: string[]
  /** where the program uses the tag */
  program: TagRef[]
}

/**
 * For each signal (by param key) that `changes` call breaking: the placed copies of `packageId` wired to it, with
 * who else uses each tag. A key with no entry, or an empty one, is wired nowhere in this project.
 */
export function updateImpact(packageId: string, changes: readonly PartChange[], parts: readonly TaggedPart[], programSource: string): Map<string, SignalUse[]> {
  const keys = new Set(changes.filter((c) => c.impact === 'breaking' && c.subject === 'signal' && c.key !== undefined).map((c) => c.key!))
  const out = new Map<string, SignalUse[]>()
  if (keys.size === 0) return out
  const ids = new Set(parts.filter((p) => p.packageId === packageId).map((p) => p.id))
  const devices = deviceTags(parts)
  const routines = readLadder(programSource)
  const programRefs = new Map<string, TagRef[]>()
  const refsOf = (tag: string): TagRef[] => {
    const k = tag.toUpperCase()
    let refs = programRefs.get(k)
    if (!refs) programRefs.set(k, (refs = programSource.trim() === '' ? [] : crossReference(programSource, tag, routines, IEC_REFS)))
    return refs
  }
  for (const key of keys) {
    const uses: SignalUse[] = []
    for (const device of devices) {
      if (!ids.has(device.id)) continue
      for (const f of device.fields) {
        if (f.key !== key || f.value === '') continue
        uses.push({
          partId: device.id,
          partName: device.name,
          tag: f.value,
          devices: devicesForTag(devices, f.value)
            .filter((u) => u.device.id !== device.id)
            .map((u) => `${u.device.name} (${u.field})`),
          program: refsOf(f.value),
        })
      }
    }
    out.set(key, uses)
  }
  return out
}

/** where a program reference is, as a person finds it: a ladder section's rung, or a line of text */
function refPlace(r: TagRef): string {
  return r.kind === 'ladder' ? `${r.routineName ? `${r.routineName} ` : ''}rung ${r.rung + 1}` : `line ${r.line}`
}

/** how many places a sentence names before saying "and N more" */
const NAMED = 3

function places(list: readonly string[]): string {
  const unique = [...new Set(list)]
  return unique.length <= NAMED ? unique.join(', ') : `${unique.slice(0, NAMED).join(', ')} and ${unique.length - NAMED} more`
}

/** One plain sentence on what a breaking signal change means for this project. */
export function impactText(uses: readonly SignalUse[] | undefined): string {
  if (!uses || uses.length === 0) return 'Not wired on any placed copy in this project.'
  const used = uses.filter((u) => u.program.length > 0 || u.devices.length > 0)
  const tags = places(uses.map((u) => u.tag))
  if (used.length === 0) return `Wired to ${tags}, which nothing else in this project uses.`
  const parts: string[] = []
  const inProgram = used.flatMap((u) => u.program.map(refPlace))
  if (inProgram.length > 0) parts.push(`the program uses it (${places(inProgram)})`)
  const devices = used.flatMap((u) => u.devices)
  if (devices.length > 0) parts.push(`also wired to ${places(devices)}`)
  return `Wired to ${tags}: ${parts.join('; ')}.`
}
