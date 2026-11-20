// IEC's leaf - a contact, a coil or a box - as the shared rung core's editing tools read it: its fields (what a view
// edits, in order), and the adapters Find/Replace (ladderFind.ts) and Cross Reference (crossRef.ts) are handed.
//
// A module of its own rather than a part of ladderRungs.ts, which the PLC panel loads with the app's first frame: these
// are for the ladder view, a lazy chunk, and they bring the rung core's gestures (ladderEdit.ts) with them.

import { updateLeaf, type LadderSel } from './ladderEdit'
import type { LeafText } from './ladderFind'
import type { LeafRefs, LeafUse } from '../crossRef'
import { builtinFbInfo, type LdCoilMode, type LdContactMode } from './ladder'
import type { Rung, RungItem } from './ladderRungs'
import { BIT_TYPES, elementType, NUMERIC_TYPES } from './ladderComplete'
import { FB_INPUT_TYPES, fbMemberType } from '../runtime'
import type { TagRow } from '../tags'
import type { FbType } from '../types'
import type { Udt } from '../udt'

/**
 * The fields of an element a view edits, in order: a contact's or coil's variable; a box's instance (or function) name,
 * then the value of each of its pins that has one. `setField` writes field `index`.
 */
export function fieldsOf(el: RungItem): string[] {
  if (el.type === 'box') return [el.head, ...el.pins.filter((p) => p.value !== null).map((p) => p.value!)]
  return [el.operand]
}

/** Field `index` of `el` (as {@link fieldsOf} numbers them) written `value`, in place. */
function writeField(el: RungItem, index: number, value: string): void {
  if (el.type !== 'box') {
    if (index === 0) el.operand = value
    return
  }
  if (index === 0) {
    el.head = value
    return
  }
  const pin = el.pins.filter((p) => p.value !== null)[index - 1]
  if (pin) pin.value = value
}

/** Field `index` of the element at `sel` written `text`. Emptied, a field is a blank (`?`), except a function block's pin,
 *  which goes: every input and output of a block may be left unconnected (IEC: an input keeps its value, an output is
 *  read off the instance), and that is how the pins a program's own block is inserted with (ladderCatalog.ts
 *  `catalogItem`) are dropped. A function's are all needed, and a blank says so. */
export function setField(rungs: readonly Rung[], sel: LadderSel, index: number, text: string): Rung[] {
  const value = text.trim()
  return updateLeaf(rungs, sel, (el) => {
    if (value === '' && el.type === 'box' && !el.func && index > 0) {
      const pin = el.pins.filter((p) => p.value !== null)[index - 1]
      if (pin) el.pins.splice(el.pins.indexOf(pin), 1)
      return
    }
    writeField(el, index, value || '?')
  })
}

/**
 * Pin `name` of the block at `sel` connected, blank (`name := ?`, or `name => ?` for an output), for a view to name next:
 * an input goes after the block's other inputs, an output last, so the text reads as IEC draws the box. The pin's
 * field ({@link fieldsOf}'s numbering) comes back with the rungs; null when there is no block there, or the pin is
 * already written. Clearing the field takes it off again (`setField`).
 */
export function connectPin(rungs: readonly Rung[], sel: LadderSel, name: string, out: boolean): { rungs: Rung[]; field: number } | null {
  const made: { field: number | null } = { field: null }
  const next = updateLeaf(rungs, sel, (el) => {
    if (el.type !== 'box' || el.func || el.pins.some((p) => p.name.toUpperCase() === name.toUpperCase())) return
    const pin = { name, value: '?', out }
    const firstOut = el.pins.findIndex((p) => p.out)
    if (out || firstOut < 0) el.pins.push(pin)
    else el.pins.splice(firstOut, 0, pin)
    made.field = el.pins.filter((p) => p.value !== null).indexOf(pin) + 1
  })
  return made.field === null ? null : { rungs: next, field: made.field }
}

/** How Find/Replace reads IEC's leaf (ladderFind.ts): a FUNCTION's name is its word - found, never replaced,
 *  since what stands there must be a function - and everything else is a field, numbered as
 *  {@link fieldsOf} numbers them, so a match lands where the view edits. A field replaced to nothing is a blank (`?`). */
const CONTACT_WORD: Record<LdContactMode, string> = { open: '| |', closed: '|/|', rising: '|P|', falling: '|N|' }
const COIL_WORD: Record<LdCoilMode, string> = { normal: '( )', negated: '(/)', set: '(S)', reset: '(R)', rising: '(P)', falling: '(N)' }

/** How Cross Reference reads IEC's leaf (crossRef.ts): a contact reads its variable; a coil writes its variable - every
 *  scan, true or false, unless it latches (S) or unlatches (R), so two such coils fight over the bit (a double coil); a
 *  block's instance and its input pins read (a pin's value is an expression), its output pins write. Fields are
 *  numbered as {@link fieldsOf} numbers them. */
export const IEC_REFS: LeafRefs<RungItem> = {
  word: (el) => (el.type === 'contact' ? CONTACT_WORD[el.mode] : el.type === 'coil' ? COIL_WORD[el.mode] : el.func ? el.head : (el.resolved?.type ?? el.head)),
  uses: (el) => {
    if (el.type === 'contact') return [{ field: 0, text: el.operand, expression: false, write: false, destructive: false }]
    if (el.type === 'coil') return [{ field: 0, text: el.operand, expression: false, write: true, destructive: el.mode !== 'set' && el.mode !== 'reset' }]
    const out: LeafUse[] = el.func ? [] : [{ field: 0, text: el.head, expression: false, write: false, destructive: false }]
    el.pins.filter((p) => p.value !== null).forEach((p, j) => out.push({ field: j + 1, text: p.value!, expression: !p.out, write: p.out, destructive: false }))
    return out
  },
}

export const IEC_LEAVES: LeafText<RungItem> = {
  word: (el) => (el.type === 'box' && el.func ? el.head : ''),
  fields: (el) => (el.type === 'box' && el.func ? ['', ...fieldsOf(el).slice(1)] : fieldsOf(el)),
  setField: (el, index, text) => writeField(el, index, text.trim() || '?'),
}

// ---- type-ahead (ladderComplete.ts): what a field takes, and what a name's members are -------------------------

/** A member of a type, as type-ahead offers it after a dot. */
export interface TypeMember {
  name: string
  /** as declared: `BOOL`, `TIME`, `ARRAY [1..4] OF INT`, a structure's name */
  type: string
}

/** The types a program's text gives the names one POU can see, as type-ahead reads them. */
export interface IecTypes {
  /** a name's declared type: the POU's own declaration over the program's globals */
  typeOf(name: string): string | undefined
  /** a type's members: a structure's, a standard block's pins, a FUNCTION_BLOCK's inputs and outputs (what
   *  `Instance.` may read); none for anything else */
  members(type: string): readonly TypeMember[]
}

/** {@link IecTypes} for the POU named `pou` ('' for the code outside every POU), from the program's tag rows
 *  (tags.ts listTags) and its structures (udt.ts listUdts). */
export function iecTypes(rows: readonly TagRow[], udts: readonly Udt[], pou: string): IecTypes {
  const names = new Map<string, string>()
  for (const r of rows) if (r.scope.kind === 'controller') names.set(r.name.toUpperCase(), r.type)
  const own = pou.toUpperCase()
  for (const r of rows) if (r.scope.kind === 'pou' && r.scope.name.toUpperCase() === own) names.set(r.name.toUpperCase(), r.type)
  const members = (type: string): readonly TypeMember[] => {
    const t = elementType(type)
    const fb = builtinFbInfo(t)
    if (fb) {
      const k = fb.type as FbType
      return [...fb.inputs, ...fb.outputs].map((pin) => ({ name: pin.name, type: FB_INPUT_TYPES[k][pin.name] ?? fbMemberType(k, pin.name) ?? '' }))
    }
    const udt = udts.find((u) => u.name.toUpperCase() === t)
    if (udt) return udt.members.map((m) => ({ name: m.name, type: m.type }))
    return rows.filter((r) => r.scope.kind === 'pou' && r.scope.name.toUpperCase() === t && (r.section === 'VAR_INPUT' || r.section === 'VAR_OUTPUT')).map((r) => ({ name: r.name, type: r.type }))
  }
  return { typeOf: (name) => names.get(name.toUpperCase()), members }
}

/** The type `path` names (`Conv.Drive`, `Lines[2].Timer`), walked member by member; undefined where a step is unknown. */
export function typeAt(path: string, types: IecTypes): string | undefined {
  const steps = path.split('.').map((s) => s.replace(/\[.*$/, '').trim())
  let type = types.typeOf(steps[0]!)
  for (const step of steps.slice(1)) {
    if (type === undefined) return undefined
    const name = step.toUpperCase()
    type = types.members(type).find((m) => m.name.toUpperCase() === name)?.type
  }
  return type
}

/** What field `index` of `el` ({@link fieldsOf}'s numbering) takes, for the order type-ahead offers names in
 *  (ladderComplete.ts rankByWanted): a contact's or coil's variable a BOOL; a block's instance its own type; a pin its
 *  declared type, any number for a number. Null where nothing says: a function's name, or its pins, whose types the
 *  call decides. */
export function fieldWants(el: RungItem, index: number, types: IecTypes): ReadonlySet<string> | null {
  if (el.type !== 'box') return index === 0 ? BIT_TYPES : null
  if (el.func) return null
  const block = el.resolved?.type ?? types.typeOf(el.head)
  if (block === undefined) return null
  if (index === 0) return new Set([elementType(block)])
  const pin = el.pins.filter((p) => p.value !== null)[index - 1]
  const declared = pin && types.members(block).find((m) => m.name.toUpperCase() === pin.name.toUpperCase())?.type
  if (!declared) return null
  const t = elementType(declared)
  return BIT_TYPES.has(t) ? BIT_TYPES : NUMERIC_TYPES.has(t) ? NUMERIC_TYPES : new Set([t])
}
