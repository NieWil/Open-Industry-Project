// A PLC tag that names its controller: `Cell2::%IX0.0` is %IX0.0 on the controller called Cell2, and `Cell2::Eye`
// is Cell2's tag Eye. A tag with no name in front belongs to the scene's default controller: the program in the PLC
// panel, or the external PLC that runs instead of it (src/plc/DEVICE-IO.md, "Several controllers").
//
// The controller is written in the tag itself, not taken from where the part sits in the scene, so a part says
// which PLC it talks to wherever it is moved or copied, and every reader of a tag (the wiring check, a link, a CLI,
// an agent) sees the same thing. In the sim a prefixed tag is just another name: `Cell2::%IX0.0` and `%IX0.0` are
// two tags, so two PLCs can each start their I/O at %IX0.0.
//
// The separator is `::` because none of the spellings a link carries uses it: IEC and S7 addresses, SLMP devices,
// OPC UA and ADS names (`MAIN.Eye`) and Logix tags (`Local:1:I.Data.0`, a single colon) all read unchanged.

import { packageParamSpecs } from '../packageParams'
import { getPackage } from '../parts/partRegistry'

export const CONTROLLER_SEP = '::'

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

/** A controller's name: a letter or underscore, then letters, digits and underscores, at most 32 characters. */
export function isControllerName(name: string): boolean {
  return NAME.test(name)
}

/**
 * The controller a tag names and the tag on it. `controller` is null for a tag of the default controller, and for one
 * whose prefix is not a controller name (`1x::Eye`); {@link badControllerPrefix} tells the two apart.
 */
export function splitControllerTag(tag: string): { controller: string | null; local: string } {
  const at = tag.indexOf(CONTROLLER_SEP)
  if (at <= 0) return { controller: null, local: tag }
  const name = tag.slice(0, at)
  // the tag on it as written, without spaces typed after the separator (`Cell2:: %IX0.0`), which no address has
  return isControllerName(name) ? { controller: name, local: tag.slice(at + CONTROLLER_SEP.length).trim() } : { controller: null, local: tag }
}

/**
 * The spelling of `name` among `known`: IEC names ignore case, so `cell2` is the controller set up as `Cell2`.
 * `name` itself when none matches. Tags are written in the known spelling, because the sim matches tags exactly.
 */
export function spelledAs(name: string, known: readonly string[]): string {
  const want = name.toLowerCase()
  return known.find((k) => k.toLowerCase() === want) ?? name
}

/** `tag` with the controller it names in its spelling among `known` ({@link spelledAs}). */
export function controllerSpelledAs(tag: string, known: readonly string[]): string {
  const { controller, local } = splitControllerTag(tag)
  return controller === null ? tag : controllerTag(spelledAs(controller, known), local)
}

/** The controller a tag names, or null for the default controller's. */
export function controllerOf(tag: string): string | null {
  return splitControllerTag(tag).controller
}

/** The prefix of a tag that has `::` in it but no controller name before it, or null. */
export function badControllerPrefix(tag: string): string | null {
  const at = tag.indexOf(CONTROLLER_SEP)
  if (at < 0) return null
  return splitControllerTag(tag).controller === null ? tag.slice(0, at) : null
}

/** `local` on `controller`, or on the default controller when that is null. */
export function controllerTag(controller: string | null, local: string): string {
  // an empty tag stays empty on any controller: `Cell2::` alone would be a tag that names nothing
  return controller === null || local.trim() === '' ? local : `${controller}${CONTROLLER_SEP}${local}`
}

/** The same tag on another controller (null: the main one). An empty tag stays empty. */
export function moveTagToController(tag: string, controller: string | null): string {
  if (tag.trim() === '') return tag
  return controllerTag(controller, splitControllerTag(tag.trim()).local)
}

interface TaggedPartLike {
  type: string
  packageId?: string
  params?: unknown
}

/** The keys of a part's tag params (`tagRef`), or none when its package is not loaded. */
export function tagParamKeys(p: TaggedPartLike): string[] {
  if (p.type !== 'part') return []
  const pkg = getPackage(p.packageId ?? '')
  return pkg ? packageParamSpecs(pkg).filter((s) => s.kind === 'tagRef').map((s) => s.key) : []
}

/**
 * The parts as one controller sees them: each tag param that names this controller holds the tag on it (the prefix
 * dropped), and every other tag param is empty. A link derives its table from this, so it carries its own
 * controller's tags under the names that controller knows them by. `controller` null is the default controller.
 * A part with no tag on this controller is returned as it was, so the result costs what the tags touch.
 */
export function partsForController<P extends TaggedPartLike>(parts: readonly P[], controller: string | null): P[] {
  return parts.map((p) => {
    const keys = tagParamKeys(p)
    if (keys.length === 0) return p
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    let next: Record<string, unknown> | null = null
    for (const key of keys) {
      const raw = params[key]
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const { controller: c, local } = splitControllerTag(raw.trim())
      const value = c === controller ? local : ''
      if (value === raw) continue
      next ??= { ...params }
      next[key] = value
    }
    return next ? { ...p, params: next } : p
  })
}

/** Every controller a part's tag names, sorted. The default controller is not listed. */
export function controllersUsed(parts: readonly TaggedPartLike[]): string[] {
  const out = new Set<string>()
  for (const p of parts) {
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    for (const key of tagParamKeys(p)) {
      const raw = params[key]
      const c = typeof raw === 'string' ? controllerOf(raw.trim()) : null
      if (c !== null) out.add(c)
    }
  }
  return [...out].sort()
}

/** A frame's tags as one controller sees them: its own, under the names it knows them by. */
export function tagsForController<V>(tags: Readonly<Record<string, V>>, controller: string): Record<string, V> {
  const prefix = controller + CONTROLLER_SEP
  const out: Record<string, V> = {}
  for (const key in tags) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = tags[key]!
  return out
}

/** The ids of the parts with a tag on `controller`, in scene order. */
export function partsNaming(parts: readonly (TaggedPartLike & { id: string })[], controller: string): string[] {
  return parts
    .filter((p) => {
      const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
      return tagParamKeys(p).some((key) => typeof params[key] === 'string' && controllerOf((params[key] as string).trim()) === controller)
    })
    .map((p) => p.id)
}
