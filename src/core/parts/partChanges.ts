// What changed between two versions of one part (docs/part-sources.md).
//
// The update prompt can say that a part has a newer version (core/parts/partOrigin.ts compares fingerprints); this says
// what the newer version changes, computed from the two packages themselves so it can never disagree with them. One
// function, so the Review dialog, a CLI and the agent door all report the same thing.
//
// Each change carries an impact, ordered by what it can break on a working line:
//
//   breaking   a PLC signal removed, or its direction or type changed; a param removed or retyped. A program or
//              wiring that used it stops working.
//   placement  the snap features, the geometry or the conveyor declaration changed. Parts already placed may sit
//              differently or come apart from what they were seated on.
//   behavior   the script, a default, a range, an added signal or param: the part may act differently. "No breaking
//              changes" never means "safe": a script change can stop a line with every signal unchanged.
//   appearance a model, texture or material changed.
//   wording    names, labels, descriptions, groups: nothing a running line can see.
//
// Fields that are not the part (format, origin, thumbnail) are left out, as the fingerprint leaves them out. The
// fingerprint also leaves out what the SDK derives from the script (params and the like, core/parts/partOrigin.ts), and this
// reads them: a removed signal is how a script change shows to the person deciding. So two copies of one script built
// by different app versions can list param changes here while reading up to date, which only adds lines to an
// update that exists for another reason.

import type { ParamSpec } from './partApi'
import type { PartAsset, PartPackage } from './partPackage'

export type ChangeImpact = 'breaking' | 'placement' | 'behavior' | 'appearance' | 'wording'

/** Most severe first: the order a summary lists them in. */
export const CHANGE_IMPACTS: readonly ChangeImpact[] = ['breaking', 'placement', 'behavior', 'appearance', 'wording']

export interface PartChange {
  impact: ChangeImpact
  /** what changed: `signal`, `param`, `script`, `snap`, `geometry`, `asset`, ... */
  subject: string
  /** the signal, param or asset it concerns, when it concerns one */
  key?: string
  /** one plain sentence for the person deciding whether to take the update */
  text: string
}

/** The changes from `from` to `to`, most severe first. Empty when they are the same part. */
export function partChanges(from: PartPackage, to: PartPackage): PartChange[] {
  const out: PartChange[] = []
  const add = (impact: ChangeImpact, subject: string, text: string, key?: string): void => {
    out.push(key === undefined ? { impact, subject, text } : { impact, subject, key, text })
  }

  paramChanges(from.params ?? {}, to.params ?? {}, add)

  if (from.behavior !== to.behavior) add('behavior', 'script', 'The part\'s script changed.')
  for (const field of ['interactive', 'useParam', 'commsParam', 'holds', 'unit'] as const) {
    if (same(from[field], to[field])) continue
    // a switch dropped: every tag a placed copy names connects, including on a copy whose switch was off
    if (field === 'commsParam' && to.commsParam === undefined) add('breaking', field, 'The part has no comms switch now: each tag field that names a tag is connected. A placed copy whose switch was off connects the tags it names.')
    // ...and one added: a placed copy has no value for it, so it takes the switch's default, and off disconnects it
    else if (field === 'commsParam' && from.commsParam === undefined) add('breaking', field, 'The part has a comms switch now. A placed copy takes its default, and where that is off, its tags disconnect until the switch is turned on.')
    else add('behavior', field, `${FIELD_TEXT[field]} changed.`)
  }

  if (!same(from.snap, to.snap)) add('placement', 'snap', 'How the part snaps onto other parts changed. Placed copies may no longer be seated where they were.')
  if (!same(from.geometry, to.geometry)) add('placement', 'geometry', 'The part\'s shape or colliders changed.')
  if (!same(from.conveyor, to.conveyor)) add('placement', 'conveyor', 'How the part joins other conveyors changed.')

  assetChanges(from.assets ?? [], to.assets ?? [], add)
  if (!same(from.materials, to.materials)) add('appearance', 'materials', 'The part\'s materials changed.')

  if (from.name !== to.name) add('wording', 'name', `Renamed from "${from.name}" to "${to.name}".`)
  if (from.category !== to.category) add('wording', 'category', 'Moved to a different catalog group.')

  return out.sort((a, b) => CHANGE_IMPACTS.indexOf(a.impact) - CHANGE_IMPACTS.indexOf(b.impact))
}

/** The most severe impact among `changes`, or undefined when there are none. */
export function worstImpact(changes: readonly PartChange[]): ChangeImpact | undefined {
  return CHANGE_IMPACTS.find((i) => changes.some((c) => c.impact === i))
}

const FIELD_TEXT = {
  interactive: 'Whether the part can be operated with Use',
  useParam: 'Which setting Use operates',
  commsParam: 'Which setting switches the part\'s PLC link',
  holds: 'What the part stores',
  unit: 'The unit load the part makes',
} as const

type Add = (impact: ChangeImpact, subject: string, text: string, key?: string) => void

function paramChanges(from: Record<string, ParamSpec>, to: Record<string, ParamSpec>, add: Add): void {
  for (const key of Object.keys(from)) {
    const a = from[key]!
    const b = to[key]
    const what = a.type === 'tag' ? 'signal' : 'param'
    const name = `${what === 'signal' ? 'Signal' : 'Setting'} "${a.label ?? key}"`
    if (b === undefined) {
      add('breaking', what, `${name} was removed. A program or wiring that uses it stops working.`, key)
      continue
    }
    if (a.type !== b.type) {
      add('breaking', what, `${name} changed kind (${a.type} to ${b.type}).`, key)
      continue
    }
    if (a.type === 'tag') {
      if (a.dir !== b.dir) add('breaking', 'signal', `${name} changed direction (${a.dir ?? 'unset'} to ${b.dir ?? 'unset'}).`, key)
      if (a.stType !== b.stType) add('breaking', 'signal', `${name} changed type (${a.stType ?? 'unset'} to ${b.stType ?? 'unset'}).`, key)
      if (!same(a.values, b.values)) add('behavior', 'signal', `What the codes of ${name} mean changed.`, key)
      if (a.setpointFor !== b.setpointFor || !!a.autoWhenDriven !== !!b.autoWhenDriven || !!a.onlyWhenDriven !== !!b.onlyWhenDriven) {
        add('behavior', 'signal', `What ${name} commands changed.`, key)
      }
      if (!same(a.default, b.default)) add('behavior', 'signal', `${name}'s suggested tag name changed. Placed copies keep the tag they are wired to.`, key)
    } else {
      if (!same(a.default, b.default)) {
        add('behavior', 'param', `${name}'s default changed (${show(a.default)} to ${show(b.default)}). Placed copies left at the old default change with it.`, key)
      }
      if (a.min !== b.min || a.max !== b.max) add('behavior', 'param', `${name}'s allowed range changed.`, key)
      if (!same(a.options?.map((o) => o.value), b.options?.map((o) => o.value))) add('behavior', 'param', `${name}'s choices changed.`, key)
    }
    if (a.label !== b.label || a.desc !== b.desc || a.group !== b.group || !!a.hidden !== !!b.hidden) {
      add('wording', what, `${name}'s label, description or grouping changed.`, key)
    }
  }
  for (const key of Object.keys(to)) {
    if (from[key] !== undefined) continue
    const b = to[key]!
    const signal = b.type === 'tag'
    add('behavior', signal ? 'signal' : 'param', `New ${signal ? 'signal' : 'setting'} "${b.label ?? key}".`, key)
  }
}

function assetChanges(from: readonly PartAsset[], to: readonly PartAsset[], add: Add): void {
  const before = new Map(from.map((a) => [a.id, a]))
  const after = new Map(to.map((a) => [a.id, a]))
  for (const [id, a] of before) {
    const b = after.get(id)
    if (!b) add('appearance', 'asset', `Model or texture "${id}" was removed.`, id)
    else if (!same(assetBytes(a), assetBytes(b))) add('appearance', 'asset', `Model or texture "${id}" changed.`, id)
  }
  for (const id of after.keys()) if (!before.has(id)) add('appearance', 'asset', `New model or texture "${id}".`, id)
}

/** An asset as its bytes: the hash when it knows one (however it holds or names them), else what it holds. */
function assetBytes(a: PartAsset): unknown {
  return a.sha256 !== undefined ? { sha256: a.sha256 } : { data: a.data, url: a.url }
}

function show(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : JSON.stringify(v) ?? 'none'
}

/** Structural equality, key order ignored (a build may write keys in any order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => same(v, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)].filter((k) => ao[k] !== undefined || bo[k] !== undefined))
  for (const k of keys) if (!same(ao[k], bo[k])) return false
  return true
}
