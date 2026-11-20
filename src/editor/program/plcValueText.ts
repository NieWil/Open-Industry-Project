// A running program's value as text: what the inline values beside the code (stLang.ts) and the Watch dock
// (components/plc/WatchPanel.tsx) both show. Kept apart from stLang.ts so the Watch dock does not load CodeMirror.

import type { TagValue } from '../../plc'
import { calendarToString, timeToString } from '../../plc/runtime'
import { listTags } from '../../plc/tags'

/** A value as its declared type writes it: a duration or a date is a number of milliseconds underneath, and shows as
 *  its literal (`T#1s500ms`, `D#2024-02-29`, `TOD#07:05:09.500`), the spelling the program itself uses. A STRING
 *  longer than `maxChars` is cut short. */
export function formatPlcValue(v: TagValue, type?: string, maxChars = Infinity): string {
  if (typeof v === 'number' && type === 'TIME') return timeToString(v)
  if (typeof v === 'number' && (type === 'DATE' || type === 'TOD' || type === 'DT')) return calendarToString(type, v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  // a STRING shows quoted, in the ST spelling, so an empty one still reads as a value
  if (typeof v === 'string') {
    const shown = v.length > maxChars ? `${v.slice(0, maxChars)}...` : v
    return `'${shown.replace(/\n/g, '$N')}'`
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(3)
}

/** Each declared name's type, upper-cased on both sides. Empty for text that is not a program yet. */
export function declaredTypes(source: string): Map<string, string> {
  const types = new Map<string, string>()
  try {
    for (const row of listTags(source)) types.set(row.name.toUpperCase(), row.type.trim().toUpperCase())
  } catch {
    // not a program yet: every value shows as it is
  }
  return types
}

/** The type a watched reference reads: its declaration's, or a standard timer's ET / PT, which are durations. */
export function refType(types: ReadonlyMap<string, string>, name: string): string | undefined {
  const dot = name.indexOf('.')
  if (dot < 0) return types.get(name.toUpperCase())
  const base = types.get(name.slice(0, dot).toUpperCase())
  const member = name.slice(dot + 1).toUpperCase()
  if ((base === 'TON' || base === 'TOF' || base === 'TP') && (member === 'ET' || member === 'PT')) return 'TIME'
  return undefined
}

/** Each declared name's types, upper-cased: a name declared in two POUs with two types has both. */
export type DeclaredTypes = ReadonlyMap<string, ReadonlySet<string>>

/** {@link DeclaredTypes} of a program text. Empty for text that is not a program yet. */
export function declaredTypeSets(source: string): DeclaredTypes {
  const types = new Map<string, Set<string>>()
  try {
    for (const row of listTags(source)) {
      const k = row.name.toUpperCase()
      const set = types.get(k) ?? new Set<string>()
      set.add(row.type.replace(/\s+/g, ' ').trim().toUpperCase())
      types.set(k, set)
    }
  } catch {
    // not a program yet: no types known
  }
  return types
}

// the standard timers' members, which a program's declarations do not spell out
const TIMER_MEMBERS: Readonly<Record<string, string>> = { IN: 'BOOL', Q: 'BOOL', PT: 'TIME', ET: 'TIME' }
const TIMERS = new Set(['TON', 'TOF', 'TP'])

function typeOfPath(types: DeclaredTypes, path: string): string | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(?:\.(.+))?$/.exec(path)
  if (!m) return undefined
  const found = types.get(m[1]!.toUpperCase())
  if (!found || found.size !== 1) return undefined // unknown, or two declarations that disagree
  let type: string = found.values().next().value!
  if (m[2]) {
    const of = /^ARRAY\s*\[.*\]\s*OF\s+(.+)$/.exec(type)
    if (!of) return undefined
    type = of[1]!.trim()
  }
  const member = m[3]?.toUpperCase()
  if (member === undefined) return type
  if (/^[0-9]+$/.test(member)) return 'BOOL' // one bit of a word
  return TIMERS.has(type) ? TIMER_MEMBERS[member] : undefined
}

/**
 * The declared type of a running program's value by its watch key: `Count`, `Fill.ET`, `Bins[2]`, `Status.3`, or the
 * same under a program instance (`Line.Count`), whose name the declarations do not hold. Undefined when the
 * declarations do not say (a structure's member, a name two POUs declare with different types).
 */
export function typeOfKey(types: DeclaredTypes, key: string): string | undefined {
  const own = typeOfPath(types, key)
  if (own !== undefined) return own
  const dot = key.indexOf('.')
  if (dot < 0) return undefined
  // under an instance only when the first name is not a variable itself: a member of one is not a variable of its own
  const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(key)?.[0] ?? ''
  if (types.has(head.toUpperCase())) return undefined
  return typeOfPath(types, key.slice(dot + 1))
}
