// Params given on a command line (`npm run snap-part -- ... --host-params width=0.8,length=3`): parsed, checked
// against each param's declared spec, and applied to a part the way the editor's handles would apply them.
//
// `k=v` pairs separated by commas; a value is read as JSON when it parses (`0.8`, `true`, `[[3,0]]`, `"a,b"`) and
// as a plain string otherwise (`runTag=Belt1Run`), and commas inside brackets or quotes belong to the value. A piece
// with no `=` after a bare-string value continues it, so a colour list needs no quotes (`boxColors=#e33,#3e3,width=1`
// is boxColors "#e33,#3e3" and width 1). A JSON object (`{"width":0.8}`) is accepted as is. A list spelled another
// way (`boxColors=["#e33","#3e3"]`, `boxColors="#e33","#3e3"`) is refused with the whole line rewritten in the form
// that parses, ready to paste (formatParamArgs), since commas inside comma-separated values are easy to quote wrong.
//
// A value must fit its param's declared type (paramArgValue): loading a scene repairs a bad value to the default,
// silently in the app, so a typo here would only surface later in validate-project. A number or boolean given to a
// string-valued param (text, tag, part ref, enum) is read as its text.
//
// `length` / `width` / `height` given to a part that has no param of that name are extents: they go through the
// resize handle's own path (partGeometry.ts resizePart), which is how a belt, whose length lives in its
// `segments`, takes `length=3` (its last segment stretches, the tail stays put).

import { canonicalAddress, looksLikeAddress } from '../io/iecAddress'
import { isHexColor, isHexColorA } from '../math'
import { packageParamSpecs, switchValue, visibleWhenHolds } from '../packageParams'
import { resizePart } from './partGeometry'
import { getPackage } from './partRegistry'
import { partInUnits } from '../scene/sceneUnits'
import { WALL_RULE_NUMBERS, WALL_VARIANTS } from '../types'
import type { BuildingWallRule, ParamSpec, PartInstance, SdkPart, SdkPartParams, WallVariant } from '../types'

export type ParamArgs = Record<string, unknown>

/** Parse `k=v,k2=v2` (or a JSON object) into values; throws an Error naming the bad piece. */
export function parseParamArgs(text: string): ParamArgs {
  const t = text.trim()
  if (t === '') return {}
  if (t.startsWith('{')) {
    const v: unknown = JSON.parse(t)
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`params: ${t} is not a JSON object`)
    return v as ParamArgs
  }
  return parsePairs(t, false)
}

/** The pairs of `t`. `lenient` also lets a `,piece` continue a quoted string value, unquoting a quoted piece: it
 *  reads a list whose entries were each quoted, so an error can show the form that parses. */
function parsePairs(t: string, lenient: boolean): ParamArgs {
  const out: ParamArgs = {}
  let lastBare: string | null = null // the key whose value is a bare (non-JSON) string, which a `,piece` continues
  let lastQuoted: string | null = null // the key whose value is a quoted JSON string (only `lenient` continues one)
  for (const piece of splitTopLevel(t)) {
    const eq = piece.indexOf('=')
    if (eq <= 0) {
      const into = lastBare ?? (lenient ? lastQuoted : null)
      if (into === null) {
        let fixed: ParamArgs | null = null
        if (!lenient && lastQuoted !== null) {
          try {
            fixed = parsePairs(t, true)
          } catch {
            /* no reading fits: say only what is wrong */
          }
        }
        throw new Error(
          `params: "${piece}" is not key=value` +
            (fixed ? `. Several values in one param are ONE comma-joined value, with no quotes around each entry: ${shellQuoted(formatParamArgs(fixed))}` : ''),
        )
      }
      let more = piece
      if (lenient && piece.startsWith('"')) {
        try {
          const v: unknown = JSON.parse(piece)
          if (typeof v === 'string') more = v
        } catch {
          /* kept as written */
        }
      }
      out[into] = `${out[into] as string},${more}`
      continue
    }
    const key = piece.slice(0, eq).trim()
    const raw = piece.slice(eq + 1).trim()
    let value: unknown = raw
    lastBare = null
    lastQuoted = null
    try {
      value = JSON.parse(raw)
      if (typeof value === 'string') lastQuoted = key
    } catch {
      // not JSON: a bare string (a tag name, a colour, an enum value)
      lastBare = key
    }
    out[key] = value
  }
  return out
}

/** a bare string `parseParamArgs` reads back as itself: no JSON reading of its first piece, and nothing that splits,
 *  nests or quotes */
const bareSafe = (s: string): boolean => {
  if (!/^[^"[\]{}=,\s]+(,[^"[\]{}=,\s]+)*$/.test(s)) return false
  try {
    JSON.parse(s.split(',')[0]!)
    return false
  } catch {
    return true
  }
}

/** `args` as `k=v,...` text that parseParamArgs reads back to the same values: a colour list stays bare
 *  (`boxColors=#e33,#3e3`), anything else that would not read back is JSON. */
export function formatParamArgs(args: ParamArgs): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' && bareSafe(v) ? v : JSON.stringify(v)}`)
    .join(',')
}

/** one shell argument, the same in bash and PowerShell: single-quoted unless it holds a quote of its own */
const shellQuoted = (s: string): string => (s.includes("'") ? s : `'${s}'`)

/** split on commas that are not inside [], {} or a double-quoted string */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

const NUM_STAND_IN = 1_000_000 // packageParams' stand-in for a bound the schema left out
const realBound = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < NUM_STAND_IN
const shown = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v))

/**
 * `value` as the param `spec` stores it, or an Error naming the form it expects. Stricter than loading
 * (scene.ts validateParam), which repairs a bad value to the default: given on a command line, a value that would be
 * repaired is a mistake to say now.
 */
export function paramArgValue(spec: ParamSpec, value: unknown): unknown {
  const key = spec.key
  const bad = (form: string): Error => new Error(`params: ${key}=${shown(value)} does not fit: ${key} is ${form}`)
  // a bare word read as JSON (a number, true) given to a param that holds text is that text
  const asText = (): string | null => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null)
  switch (spec.kind) {
    case 'number': {
      const unit = spec.unit ? ` ${spec.unit}` : ''
      const range = realBound(spec.min) && realBound(spec.max) ? ` from ${spec.min} to ${spec.max}${unit}` : realBound(spec.min) ? ` of at least ${spec.min}${unit}` : realBound(spec.max) ? ` up to ${spec.max}${unit}` : ''
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`a number${range} (e.g. ${key}=${spec.default})`)
      if ((realBound(spec.min) && value < spec.min) || (!spec.rest && realBound(spec.max) && value > spec.max)) throw bad(`a number${range}`)
      if (Number.isInteger(spec.step) && spec.step >= 1 && value % spec.step !== 0) throw bad(`a whole number${spec.step > 1 ? ` in steps of ${spec.step}` : ''}${range}`)
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw bad(`true or false`)
      return value
    case 'enum': {
      const t = asText()
      if (t === null || !spec.options.some((o) => o.value === t)) throw bad(`one of ${spec.options.map((o) => o.value).join(' | ')}`)
      return t
    }
    case 'color': {
      if (spec.list) {
        const form = `a list of #rrggbb colours joined by commas, as ONE string (e.g. ${key}=#e74c3c,#3498db; '' = none)`
        if (typeof value !== 'string') throw bad(form)
        const entries = value.split(',').map((c) => c.trim()).filter((c) => c !== '')
        const badEntry = entries.find((c) => !isHexColor(c.startsWith('#') ? c : `#${c}`))
        if (badEntry !== undefined) throw new Error(`params: ${key}: "${badEntry}" is not a colour; ${key} is ${form}`)
        return entries.map((c) => (c.startsWith('#') ? c : `#${c}`).toLowerCase()).join(',')
      }
      const form = spec.alpha ? 'a colour, #rrggbb or #rrggbbaa' : 'a colour, #rrggbb'
      if (!(spec.alpha ? isHexColorA(value) : isHexColor(value))) throw bad(`${form} (e.g. ${key}=${spec.default || '#3498db'})`)
      return (value as string).toLowerCase()
    }
    case 'text':
    case 'partRef': {
      const t = asText()
      if (t === null) throw bad(spec.kind === 'text' ? 'text' : 'the id of a part in the scene')
      return t
    }
    case 'tagRef': {
      if (typeof value !== 'string') throw bad(`a PLC tag name (e.g. ${key}=Belt1Run) or a direct address (%IX0.0); '' unbinds it`)
      if (looksLikeAddress(value) && canonicalAddress(value) === null) throw bad(`a PLC tag name, or a WELL-FORMED direct address (%IX0.0, %QW2, %MD10)`)
      return value
    }
    case 'numberList': {
      const cols = spec.cellLabels?.length ? ` (${spec.cellLabels.join(', ')})` : ''
      const lo = typeof spec.min === 'number' ? spec.min : -Infinity
      const hi = typeof spec.max === 'number' ? spec.max : Infinity
      const range = Number.isFinite(lo) || Number.isFinite(hi) ? `, each from ${Number.isFinite(lo) ? lo : '-inf'} to ${Number.isFinite(hi) ? hi : 'inf'}` : ''
      const example = JSON.stringify(spec.default.length ? spec.default : [Array.from({ length: spec.arity }, () => 0)])
      const form = `a list of rows of ${spec.arity} number${spec.arity === 1 ? '' : 's'}${cols}${range}, e.g. ${key}=${example}`
      const rowOk = (r: unknown): boolean => Array.isArray(r) && r.length === spec.arity && r.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi)
      if (!Array.isArray(value) || !value.every(rowOk)) throw bad(form)
      // loading reads an empty list as "not given" and fills the default back in
      if (value.length === 0 && spec.default.length > 0) throw bad(`${form}: an empty list loads as the default, give at least one row`)
      if (spec.rows !== undefined && value.length !== spec.rows) throw bad(`${form}, exactly ${spec.rows} rows`)
      return value
    }
    case 'wallRules':
      return wallRulesArg(key, value)
  }
}

const RULE_EXAMPLE = '[{"wall":"dock_door","run":1,"gap":0,"count":3,"start":2,"doorCount":2,"trailer":true}]'

/**
 * A building's wall rules given on a command line: a JSON list of rule objects. `wall`, `run`, `gap`, `count` and
 * `start` are required; `doorCount` and `trailer` matter only to a dock door and take the values loading gives a
 * missing one (1 and true). A field out of its range, a misspelt field or an unknown wall is refused, where loading
 * would clamp or replace it.
 */
function wallRulesArg(key: string, value: unknown): BuildingWallRule[] {
  const form = `a JSON list of rules, e.g. ${key}=${RULE_EXAMPLE} ([] = plain walls)`
  if (!Array.isArray(value)) throw new Error(`params: ${key} does not fit: ${key} is ${form}`)
  const fields = new Set(['wall', 'trailer', ...Object.keys(WALL_RULE_NUMBERS)])
  return value.map((raw, i) => {
    const at = `params: ${key}[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} is not a rule object; ${key} is ${form}`)
    const r = raw as Record<string, unknown>
    const stray = Object.keys(r).find((k) => !fields.has(k))
    if (stray !== undefined) throw new Error(`${at} has no field "${stray}" (a rule has ${[...fields].join(', ')})`)
    if (!WALL_VARIANTS.includes(r.wall as WallVariant)) throw new Error(`${at}.wall=${shown(r.wall)} is not one of ${WALL_VARIANTS.join(' | ')}`)
    const num = (k: keyof typeof WALL_RULE_NUMBERS, required: boolean): number => {
      const { min, max, absent } = WALL_RULE_NUMBERS[k]
      const v = r[k]
      if (v === undefined) {
        if (required) throw new Error(`${at} needs ${k} (a whole number from ${min} to ${max})`)
        return absent
      }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${at}.${k}=${shown(v)} is not a whole number from ${min} to ${max}`)
      return v
    }
    if (r.trailer !== undefined && typeof r.trailer !== 'boolean') throw new Error(`${at}.trailer=${shown(r.trailer)} is not true or false`)
    return {
      wall: r.wall as WallVariant,
      run: num('run', true),
      gap: num('gap', true),
      count: num('count', true),
      start: num('start', true),
      doorCount: num('doorCount', false),
      trailer: r.trailer === undefined ? true : (r.trailer as boolean),
    }
  })
}

/** `key: value` in words for a visibleWhen switch */
const switchWords = (is: boolean | string | readonly string[]): string => (Array.isArray(is) ? `is one of ${is.join(', ')}` : `= ${String(is)}`)

/**
 * The params in `args` that cannot take effect on `part` as resolved: each is shown (and read) only while its
 * `visibleWhen` switch holds a value it does not hold now. One warning per param, with the fix: set the switch, or
 * give the twin that is in use (a param on the same switch with the same label: a conveyor's `speed` vs `speedFpm`).
 */
export function hiddenParamArgs(part: SdkPart, args: ParamArgs): string[] {
  const pkg = getPackage(part.packageId)
  if (!pkg) return []
  const specs = packageParamSpecs(pkg)
  const out: string[] = []
  for (const key of Object.keys(args)) {
    const spec = specs.find((s) => s.key === key)
    const vw = spec?.visibleWhen
    if (!spec || !vw) continue
    const now = switchValue(specs, part.params, vw.param)
    if (visibleWhenHolds(vw, now)) continue
    const want = Array.isArray(vw.is) ? vw.is[0] : vw.is
    const twins = specs.filter((s) => s.key !== key && s.kind === spec.kind && s.label === spec.label && s.visibleWhen?.param === vw.param && visibleWhenHolds(s.visibleWhen, now)).map((s) => s.key)
    const sw = specs.find((s) => s.key === vw.param)
    const scene = sw?.kind === 'boolean' && sw.imperialUnits ? ` (${vw.param} is the part's units switch: a placed part takes it from the scene's Units)` : ''
    out.push(
      `${key} is ignored: it is used only while ${vw.param} ${switchWords(vw.is)}, and ${vw.param} = ${String(now)} here${scene}. ` +
        `Add ${vw.param}=${String(want)}${twins.length ? `, or give ${twins.join(' / ')} instead` : ''}`,
    )
  }
  return out
}

const EXTENT_AXIS: Record<string, 'x' | 'y' | 'z'> = { length: 'x', height: 'y', width: 'z' }

export interface WithParamArgsOptions {
  /**
   * A given param that only takes effect under a switch setting (its `visibleWhen`) turns that switch to it when the
   * args do not set the switch themselves: `speedFpm=200` on a metric belt sets `fpmUnits=true` rather than being
   * ignored. A units switch (`imperialUnits`) moves the way the scene's Units would (sceneUnits.ts partInUnits: each
   * twin carried to the other unit), and then the given values apply. Given params that want different settings of
   * one switch leave it alone (and are warned about). Off by default: what each switch was set to goes onto `notes`.
   */
  followSwitches?: boolean
  notes?: string[]
}

/** paramArgValue, with the whole args line rewritten in a form that parses when the fix is certain (a colour list
 *  given as a JSON array of colours: it is one comma-joined string) */
function fitted(spec: ParamSpec, value: unknown, args: ParamArgs): unknown {
  try {
    return paramArgValue(spec, value)
  } catch (e) {
    if (spec.kind === 'color' && spec.list && Array.isArray(value) && value.every((c) => typeof c === 'string')) {
      const joined = value.join(',')
      let fits = false
      try {
        paramArgValue(spec, joined)
        fits = true
      } catch {
        /* an entry is not a colour either way: the message names it */
      }
      if (fits) throw new Error(`${(e as Error).message}. The whole line, written so it parses: ${shellQuoted(formatParamArgs({ ...args, [spec.key]: joined }))}`, { cause: e })
    }
    throw e
  }
}

/** `part` with each switch the given args depend on (and do not set) turned to the setting that shows them */
function withSwitchesFollowed(part: SdkPart, args: ParamArgs, specs: readonly ParamSpec[], notes?: string[]): SdkPart {
  const specOf = (key: string): ParamSpec | undefined => specs.find((s) => s.key === key)
  const hiddenOn = new Map<string, string[]>() // switch key -> the given params it hides now
  for (const key of Object.keys(args)) {
    const vw = specOf(key)?.visibleWhen
    if (!vw || vw.param in args || visibleWhenHolds(vw, switchValue(specs, part.params, vw.param))) continue
    hiddenOn.set(vw.param, [...(hiddenOn.get(vw.param) ?? []), key])
  }
  let next = part
  for (const [sw, hidden] of hiddenOn) {
    const swSpec = specOf(sw)
    // one setting every given param on this switch is shown under, those in effect now included
    const onIt = Object.keys(args).filter((k) => specOf(k)?.visibleWhen?.param === sw)
    const settings: (boolean | string)[] = swSpec?.kind === 'enum' ? swSpec.options.map((o) => o.value) : [true, false]
    const want = settings.find((v) => onIt.every((k) => visibleWhenHolds(specOf(k)!.visibleWhen, v)))
    if (want === undefined) continue
    if (swSpec?.kind === 'boolean' && swSpec.imperialUnits && typeof want === 'boolean') {
      next = partInUnits(next as PartInstance, want ? 'imperial' : 'metric') as SdkPart
    } else next = { ...next, params: { ...next.params, [sw]: want } }
    notes?.push(
      `${sw} set to ${String(want)}: ${hidden.join(', ')} ${hidden.length === 1 ? 'is' : 'are'} used only while ${sw} = ${String(want)}` +
        (swSpec?.kind === 'boolean' && swSpec.imperialUnits ? ` (${sw} is the part's units switch, which the scene's Units otherwise set)` : ''),
    )
  }
  return next
}

/**
 * `part` with `args` applied: a declared param is checked against its spec (paramArgValue) and set; an undeclared
 * `length`/`width`/`height` is an extent through the resize path; any other undeclared key is an error (a typo
 * must not pass silently). The part keeps its position: the extents only change params here. A given param that
 * cannot take effect on the result (hiddenParamArgs) is pushed onto `warnings` when given.
 */
export function withParamArgs(part: SdkPart, args: ParamArgs, warnings?: string[], opts: WithParamArgsOptions = {}): SdkPart {
  const pkg = getPackage(part.packageId)
  if (!pkg) throw new Error(`params: ${part.packageId} is not registered`)
  const specs = packageParamSpecs(pkg)
  let next: SdkPart = { ...part, params: { ...part.params } }
  if (opts.followSwitches) next = withSwitchesFollowed(next, args, specs, opts.notes)
  // declared params first, so an extent resizes the part as those params leave it
  for (const [key, value] of Object.entries(args)) {
    if (!(key in pkg.params)) continue
    const spec = specs.find((s) => s.key === key)
    next.params[key] = (spec ? fitted(spec, value, args) : value) as SdkPartParams[string]
  }
  // naming a tag means wiring it: a part's tags are inert until its comms switch is on, so turn it on unless the
  // args say otherwise
  const namesTag = Object.entries(args).some(([k, v]) => (pkg.params[k] as { type?: string } | undefined)?.type === 'tag' && typeof v === 'string' && v !== '')
  if (namesTag && pkg.commsParam && !(pkg.commsParam in args)) next.params[pkg.commsParam] = true
  for (const [key, value] of Object.entries(args)) {
    if (key in pkg.params) continue
    const axis = EXTENT_AXIS[key]
    if (!axis || typeof value !== 'number' || !(value > 0)) {
      throw new Error(`params: ${pkg.id} has no param "${key}" (npm run catalog -- ${pkg.id} lists its params)`)
    }
    const r = resizePart(next, axis, 1, value)
    next = { ...next, params: r.params as SdkPartParams }
  }
  if (warnings) warnings.push(...hiddenParamArgs(next, args))
  return next
}
