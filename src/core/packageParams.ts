// Bridges a custom part's package param schema (the SDK shape in partApi.ts: {type, default, min, max,
// step, label}) into the editor's richer ParamSpec[] (the schema-driven shape that drives createPart,
// validateScene/normalizePart clamping, and the Inspector). Through this converter, custom parts use the
// same param pipeline as every built-in type, with no special cases downstream.

import type { ParamSchema } from './parts/partApi'
import { getPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import { PART_DEFS } from './types'
import type { SdkPart, ParamSpec, PartInstance, VisibleWhen } from './types'

// Wide fallback bounds for an unbounded numeric param (the SDK lets min/max be omitted, but the editor's
// NumberParamSpec - and its slider/clamp - require finite bounds).
const NUM_LO = -1_000_000
const NUM_HI = 1_000_000

/** Is [min, max] a range someone chose, rather than missing or the ±1e6 stand-in for a missing bound? Only a real
 *  range makes a number field a slider: across ±1e6 a pixel of drag is thousands of units, and the fill that
 *  shows where the value sits would never leave the middle. */
export function isRealRange(min: number | undefined, max: number | undefined): boolean {
  return isRealBound(min) && isRealBound(max) && max! > min!
}

/** a bound someone chose: finite, and not the ±1e6 stand-in for one the schema left out */
export function isRealBound(v: number | undefined): boolean {
  return v !== undefined && Number.isFinite(v) && v > NUM_LO && v < NUM_HI
}

// The unit tokens a label may end in, e.g. 'Width (m)'. A label that says more ('Speed (m/s, − reverses)') keeps it.
const UNIT_TOKENS = String.raw`m|mm|cm|in|ft|m\/s|m\/s²|kg|s|°|°\/s|°\/s²|deg|rad|FPM|Hz|per min`
const LABEL_UNIT = new RegExp(String.raw`^(.*\S)\s*\((${UNIT_TOKENS})\)$`)
const UNIT_ONLY = new RegExp(`^(?:${UNIT_TOKENS})$`)

/**
 * What a param's row shows of its label: the label without a trailing bracket that explains it ('Run tag (rollers
 * run while true)' -> 'Run tag'). A row has no room for the explanation: it would truncate the label and push the
 * READ / WRITE badge out of sight. The tooltip shows the whole label. A bracket that starts with a unit keeps that
 * unit ('Speed tag (m/s)'; 'Actual Z tag (m, down)' -> 'Actual Z tag (m)'), because the unit is what the label
 * most needs to say. A number param has already lost a bare unit to its field's suffix (numberLabelUnit).
 */
export function labelHead(label: string): string {
  const m = /^(.*\S)\s*\(([^()]*)\)$/.exec(label)
  if (!m) return label
  const first = m[2]!.split(',')[0]!.trim()
  return UNIT_ONLY.test(first) ? `${m[1]} (${first})` : m[1]!
}

/** A number param's field label and unit suffix: the declared `unit`, else one read off the end of the label (and
 *  cut from it, so the unit shows once, as the suffix). */
export function numberLabelUnit(label: string, unit: string | undefined): { label: string; unit: string } {
  const m = LABEL_UNIT.exec(label)
  if (unit) return m && m[2] === unit ? { label: m[1]!, unit } : { label, unit }
  return m ? { label: m[1]!, unit: m[2]! } : { label, unit: '' }
}

/** Convert a baked package ParamSchema into editor ParamSpecs (stable order = schema key order). */
/** A `visibleWhen` as authored, normalized: a boolean, a string or a list of strings for `is`, else none. */
function visibleWhenOf(v: unknown): VisibleWhen | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const { param, is } = v as { param?: unknown; is?: unknown }
  if (typeof param !== 'string') return undefined
  if (typeof is === 'boolean' || typeof is === 'string') return { param, is }
  if (Array.isArray(is) && is.length > 0 && is.every((x) => typeof x === 'string')) return { param, is: [...(is as string[])] }
  return undefined
}

/** The value a switch param holds on a part - its saved value, else its `whenAbsent`, else its default - for a
 *  `visibleWhen` to test. Only a boolean, an enum or a product param switches; anything else reads undefined, which
 *  no `visibleWhen` matches. */
export function switchValue(
  specs: readonly { key: string; kind: string; default?: unknown; whenAbsent?: unknown; product?: boolean }[],
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean | string | undefined {
  const sw = specs.find((s) => s.key === key)
  const want = sw?.kind === 'boolean' ? 'boolean' : sw?.kind === 'enum' || (sw?.kind === 'text' && sw.product === true) ? 'string' : null
  if (!sw || !want) return undefined
  const v = params?.[key]
  if (typeof v === want) return v as boolean | string
  const fallback = sw.whenAbsent ?? sw.default
  return typeof fallback === want ? (fallback as boolean | string) : undefined
}

/** Whether a param with this `visibleWhen` is shown (and, for a tag, in use) while its switch reads `value`. The single
 *  rule the Inspector shows fields by and the PLC bindings count a part's tags by, so the two cannot disagree. */
export function visibleWhenHolds(vw: VisibleWhen | undefined, value: boolean | string | undefined): boolean {
  if (!vw) return true
  if (value === undefined) return false
  return Array.isArray(vw.is) ? typeof value === 'string' && vw.is.includes(value) : vw.is === value
}

export function schemaToParamSpecs(schema: ParamSchema): ParamSpec[] {
  const specs: ParamSpec[] = []
  for (const key of Object.keys(schema)) {
    const s = schema[key]
    if (!s) continue
    const label = s.label ?? key
    let spec: ParamSpec
    if (s.type === 'number') {
      const lu = numberLabelUnit(label, typeof s.unit === 'string' ? s.unit : undefined)
      spec = {
        kind: 'number',
        key,
        label: lu.label,
        min: s.min ?? NUM_LO,
        max: s.max ?? NUM_HI,
        step: s.step ?? 0.1,
        unit: lu.unit,
        default: typeof s.default === 'number' ? s.default : 0,
        // carry `rest` through so load-time validation (validateParam) treats a host-resolved fact
        // like standHeight as unbounded above its manual-slider max - else reload shrinks it and floats the legs.
        ...(s.rest ? { rest: s.rest } : {}),
        ...(typeof s.bits === 'number' || typeof s.bits === 'string' ? { bits: s.bits } : {}),
      }
    } else if (s.type === 'boolean') {
      spec = { kind: 'boolean', key, label, default: typeof s.default === 'boolean' ? s.default : false, ...(typeof s.whenAbsent === 'boolean' ? { whenAbsent: s.whenAbsent } : {}), ...(s.imperialUnits === true ? { imperialUnits: true } : {}) }
    } else if (s.type === 'tag') {
      // C-tagref: a PLC tag name → an Inspector tag picker, not a bare text box.
      spec = { kind: 'tagRef', key, label, default: typeof s.default === 'string' ? s.default : '' }
      // an analog setpoint tag names the number param it replaces, so the Inspector can show the live
      // commanded value on that field instead of the authored one the running scene isn't using
      if (typeof s.setpointFor === 'string' && s.setpointFor) spec.setpointFor = s.setpointFor
      // the declared signal: which way it flows and what it carries. The wiring check (plc/wiring.ts) reads it
      // to find undriven tags, contested ones, and type clashes.
      if (s.dir === 'in' || s.dir === 'out') spec.dir = s.dir
      if (s.stType === 'BOOL' || s.stType === 'INT' || s.stType === 'DINT' || s.stType === 'REAL') spec.stType = s.stType
      // the unit the value travels in, shown beside the type (a setpoint tag without one takes its param's, below)
      if (typeof s.unit === 'string' && s.unit) spec.unit = s.unit
      // read only while a program drives it: undriven, the part runs on its own setting rather than on a 0
      if (s.onlyWhenDriven === true || s.autoWhenDriven === true) spec.onlyWhenDriven = true
      // a code tag's meanings, for the field's listing
      if (Array.isArray(s.values)) spec.values = s.values.filter((v) => v && typeof v.value === 'number' && typeof v.label === 'string').map((v) => ({ value: v.value, label: v.label }))
    } else if (s.type === 'partRef') {
      // a reference to another scene part (its id) → the Inspector's part dropdown (no partTypes filter: with
      // conveyors authored as custom parts there's no core PartType to filter on, so it lists all scene parts).
      // The interlock behavior reads the live conveyor state via ctx.conveyorRunning(id) - a non-conveyor pick
      // reads as "running" (inert), matching a dangling ref.
      spec = { kind: 'partRef', key, label, default: typeof s.default === 'string' ? s.default : '' }
    } else if (s.type === 'color') {
      // an #rrggbb tint (e.g. a belt's fabric colour) → the Inspector's swatch picker. `alpha: true` opts into
      // the A slider + an 8-digit #rrggbbaa value (else the picker + scene normalizer stay opaque-only).
      spec = { kind: 'color', key, label, default: typeof s.default === 'string' ? s.default : '#000000' }
      if (s.alpha === true) spec.alpha = true
      // `list`: several colours joined by commas, edited as a swatch row (a spawner's colour cycle)
      if (s.list === true) {
        spec.list = true
        spec.default = typeof s.default === 'string' ? s.default : ''
      }
    } else if (s.type === 'enum') {
      // a fixed dropdown; options may carry `rows` (+ `stamps`) to make it a shape-preset template picker over
      // a numberList param - choosing an option stamps its rows, editing the list drifts back (Inspector side).
      const opts = Array.isArray(s.options) ? s.options : []
      const options = opts.map((o) => ({
        value: String(o.value),
        label: o.label ?? String(o.value),
        ...(Array.isArray(o.rows) ? { rows: o.rows.map((row) => row.slice()) } : {}),
      }))
      const def =
        typeof s.default === 'string' && options.some((o) => o.value === s.default)
          ? s.default
          : (options[0]?.value ?? '')
      spec = { kind: 'enum', key, label, options, default: def }
      if (typeof s.stamps === 'string') spec.stamps = s.stamps
    } else if (s.type === 'numberList') {
      // C-numberlist: a fixed-width numeric row table (waypoints/poses) → a grid editor, not a JSON string.
      const arity = Number.isFinite(s.arity) && (s.arity as number) >= 1 ? Math.floor(s.arity as number) : 1
      const def = Array.isArray(s.default) ? (s.default as number[][]).map((row) => row.slice(0, arity)) : []
      spec = { kind: 'numberList', key, label, arity, default: def }
      if (typeof s.min === 'number') spec.min = s.min
      if (typeof s.max === 'number') spec.max = s.max
      if (typeof s.step === 'number') spec.step = s.step
      // presentation: column headers, a fixed row count, and a row-index set over another table
      if (Array.isArray(s.columns)) spec.cellLabels = s.columns.map(String)
      if (typeof s.rows === 'number' && Number.isInteger(s.rows) && s.rows >= 1) spec.rows = s.rows
      if (typeof s.rowsOf === 'string' && s.rowsOf) spec.rowsOf = s.rowsOf
      if (typeof s.rowNames === 'string' && s.rowNames) spec.rowNames = s.rowNames
      if (s.program && Array.isArray(s.program.ops) && s.program.ops.length > 0) spec.program = s.program
    } else {
      spec = { kind: 'text', key, label, default: typeof s.default === 'string' ? s.default : '' }
      if (s.suggest === 'marks') spec.suggest = 'marks'
      if (s.product === true) spec.product = true
      if (s.product === true && typeof s.settings === 'string' && s.settings) spec.settings = s.settings
    }
    // Inspector grouping: the editor clusters fields by `group` ('A/B' nests). Carried
    // uniformly for every kind so any custom part can organize a long param list into collapsible sections.
    if (typeof s.group === 'string' && s.group) spec.group = s.group
    // `hidden` (stored, never shown) goes through the same bridge: the spec has to reach
    // createPart / normalizePart so the value defaults, clamps and persists - only the Inspector drops it.
    if (s.hidden === true) spec.hidden = true
    const vw = visibleWhenOf(s.visibleWhen)
    if (vw) spec.visibleWhen = vw
    // The param's own doc line - the Inspector joins it with the range + default in the field's hover.
    // Carried here (rather than looked up host-side by part type) so it can't go stale when a part is
    // renamed or repackaged, and so a user-authored part documents itself.
    if (typeof s.desc === 'string' && s.desc) spec.desc = s.desc
    specs.push(spec)
  }
  // a setpoint tag carries its param's value, so by contract (TagRefParamSpec.setpointFor) it is in that param's unit
  for (const spec of specs) {
    if (spec.kind !== 'tagRef' || spec.unit || !spec.setpointFor) continue
    const target = specs.find((t) => t.key === spec.setpointFor)
    if (target?.kind === 'number' && target.unit) spec.unit = target.unit
  }
  return specs
}

// A package's specs by its schema object. A registered package is never changed in place (an edit registers a new
// one), and every reader of a part's fields asks: the Inspector, the wiring check, and the ladder sheet once per
// part on every redraw, where working them out afresh for a 420-part line held the page for 0.3 s each time.
const specsOf = new WeakMap<object, { specs: readonly ParamSpec[]; lists: boolean }>()

const isList = (v: unknown): boolean => typeof v === 'object' && v !== null
/** a copy of a default that is a list (rows of numbers, wall rules, colours): nothing below it is shared */
function copyOfDefault<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => copyOfDefault(x)) as T
  if (isList(v)) return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, copyOfDefault(x)])) as T
  return v
}

/**
 * The editable ParamSpecs for a custom part backed by `pkg`. Kept per package, and shared between callers: read
 * them, never write. A default that is a list is the exception, and is a fresh copy on every call: a part is given
 * its default as it stands in the spec, and two parts must not come to share one list.
 */
export function packageParamSpecs(pkg: PartPackage): ParamSpec[] {
  const schema = pkg.params as object | undefined
  if (!schema) return schemaToParamSpecs(pkg.params)
  let kept = specsOf.get(schema)
  if (!kept) {
    // frozen, so a caller that tried to change a shared spec fails where it does so
    const specs = Object.freeze(schemaToParamSpecs(pkg.params).map((spec) => Object.freeze(spec)))
    kept = { specs, lists: specs.some((spec) => isList((spec as { default?: unknown }).default)) }
    specsOf.set(schema, kept)
  }
  if (!kept.lists) return kept.specs as ParamSpec[]
  return kept.specs.map((spec) => (isList((spec as { default?: unknown }).default) ? ({ ...spec, default: copyOfDefault((spec as { default?: unknown }).default) } as ParamSpec) : spec))
}

/**
 * The editable ParamSpecs for any part instance, for runtime consumers (Inspector, etc.): custom parts
 * resolve from the live package registry, built-ins from static PART_DEFS. An unregistered custom
 * package yields [] (no fields) rather than throwing. validateScene/normalizePart don't use this. They
 * resolve against the scene's embedded packages, not the registry, to stay self-contained.
 */
export function partParamSpecs(part: PartInstance): ParamSpec[] {
  if (part.type === 'part') {
    const pkg = getPackage((part as SdkPart).packageId)
    return pkg ? packageParamSpecs(pkg) : []
  }
  return PART_DEFS[part.type].params
}
