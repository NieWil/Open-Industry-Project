// --- ParamField's pure logic (no React): modified/mixed state, tooltips, the scene tag index, the group
// tree, number normalisation and paste coercion. Kept apart from the .tsx so node-env unit tests reach it. ---

import { clamp, isHexColor, isHexColorA, normalizeHexColorList, splitHexAlpha } from '../../../core/math'
import { isRealBound, partParamSpecs } from '../../../core/packageParams'
import { locatedVariables } from '../../../plc/locatedIndex'
import { METRIC_DISPLAY, unitView, type DisplayUnits } from '../../../core/units'
import type { BuildingWallRule, NumberParamSpec, ParamSpec, ParamValue, PartInstance } from '../../../core/types'

export function isArrayKind(k: ParamSpec['kind']): boolean {
  return k === 'wallRules' || k === 'numberList'
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** whether a param value differs from the spec default (drives the revert affordance) */
export function isModified(spec: ParamSpec, v: ParamValue | undefined): boolean {
  switch (spec.kind) {
    case 'number':
      return typeof v === 'number' && Math.abs(v - spec.default) > 1e-9
    case 'boolean':
      return typeof v === 'boolean' && v !== spec.default
    case 'enum':
    case 'text':
    case 'partRef':
    case 'tagRef':
      return typeof v === 'string' && v !== spec.default
    case 'color':
      return typeof v === 'string' && v.toLowerCase() !== spec.default.toLowerCase()
    case 'wallRules':
    case 'numberList':
      return Array.isArray(v) && JSON.stringify(v) !== JSON.stringify(spec.default)
  }
}

/** a stored number as its field shows it under the viewer's display units, without the unit (tooltips) */
function shownQuantity(spec: NumberParamSpec, v: number, system: DisplayUnits): number {
  const view = unitView(spec.unit, system)
  return view.k === 1 ? shownNumber(spec, v) : Number((v * view.k).toFixed(view.decimals ?? 3))
}

/** a stored number with its unit, as the viewer's display units show it: '23.62 in', '2 m/s', '42 %' */
export function formatQuantity(spec: NumberParamSpec, v: number, system: DisplayUnits = METRIC_DISPLAY): string {
  const u = unitView(spec.unit, system).unit
  return `${shownQuantity(spec, v, system)}${u ? ` ${u}` : ''}`
}

/** a spec's default rendered in the units the field shows (for tooltips) */
function formatParamDefault(spec: ParamSpec, system: DisplayUnits): string {
  switch (spec.kind) {
    case 'number':
      return formatQuantity(spec, spec.default, system)
    case 'boolean':
      return spec.default ? 'On' : 'Off'
    case 'enum':
      return spec.options.find((o) => o.value === spec.default)?.label ?? String(spec.default)
    case 'color':
      if (spec.list) return spec.default ? spec.default.toUpperCase().split(',').join(', ') : '(none)'
      return spec.default.toUpperCase()
    case 'text':
      return spec.default ? spec.default : '(empty)'
    case 'partRef':
      return spec.default ? spec.default : '(none)'
    case 'tagRef':
      return spec.default ? spec.default : '(unbound)'
    default:
      return '' // tables have no single-line default
  }
}

/**
 * A property hover surfaces the name, doc comment, allowed range, and
 * default. Build that multi-line string (the native title attribute renders
 * the newlines) from the spec + its registered description.
 */
export function buildParamTooltip(spec: ParamSpec, label: string, desc: string | undefined, system: DisplayUnits = METRIC_DISPLAY): string {
  // a tag's first line says what it carries, as the row's badge does: `Speed tag · REAL, m/s`
  const carries = spec.kind === 'tagRef' ? [spec.stType, spec.unit].filter(Boolean).join(', ') : ''
  const lines: string[] = [carries ? `${label} · ${carries}` : label]
  if (desc) lines.push(desc)
  const meta: string[] = []
  if (spec.kind === 'number') {
    const shownUnit = unitView(spec.unit, system).unit
    const u = shownUnit ? ` ${shownUnit}` : ''
    const n = (v: number): number => shownQuantity(spec, v, system)
    // a bound the schema left out arrives as ±1e6 (packageParams): not a range to advertise
    const lo = isRealBound(spec.min)
    const hi = isRealBound(spec.max)
    if (lo && hi) meta.push(`Range: ${n(spec.min)} – ${n(spec.max)}${u}`)
    else if (lo) meta.push(`Min: ${n(spec.min)}${u}`)
    else if (hi) meta.push(`Max: ${n(spec.max)}${u}`)
  }
  // a CODE tag's declared meanings (ParamSpec.values)
  if (spec.kind === 'tagRef' && spec.values?.length) meta.push(`Codes: ${spec.values.map((v) => `${v.value} = ${v.label}`).join(', ')}`)
  const def = formatParamDefault(spec, system)
  if (def) meta.push(`Default: ${def}`)
  if (meta.length) lines.push('', ...meta)
  return lines.join('\n')
}

/** what the scene says about one bound tag: how many parts drive it, how many read it, which ST types they declare */
export interface TagSignal {
  writers: number
  readers: number
  /** the tag fields in the scene that hold it, whatever their direction */
  uses: number
  types: Set<string>
}

export interface SceneTagIndex {
  /** every distinct, non-empty tag bound on a `tagRef` param anywhere in the scene, sorted */
  suggestions: string[]
  signals: Map<string, TagSignal>
  /** the scene program's variable at each I/O address (plc/locatedIndex.ts), for a tag that is an address */
  located: Map<string, string>
}

/**
 * One walk over the scene's `tagRef` params: the autocomplete pool for a tag picker (once a tag is typed on one
 * part it suggests itself on every other, so parts wired to a shared signal converge on one spelling) and the
 * per-tag signal counts. Local to the Inspector: the full check (plc/wiring.ts) also weighs the
 * compiled ST program, which a param field has no business loading. Everything decided from this is
 * part-vs-part and provable from the scene alone, so it can never contradict the program-aware verdict the ST
 * panel shows.
 */
export function buildSceneTagIndex(allParts: readonly PartInstance[], program = ''): SceneTagIndex {
  const signals = new Map<string, TagSignal>()
  for (const p of allParts) {
    for (const s of partParamSpecs(p)) {
      if (s.kind !== 'tagRef') continue
      const v = (p.params as unknown as Record<string, ParamValue>)[s.key]
      if (typeof v !== 'string' || v === '') continue
      const entry = signals.get(v) ?? { writers: 0, readers: 0, uses: 0, types: new Set<string>() }
      entry.uses++
      if (s.dir === 'out') entry.writers++
      else if (s.dir === 'in') entry.readers++
      if (s.stType) entry.types.add(s.stType)
      signals.set(v, entry)
    }
  }
  return { suggestions: [...signals.keys()].sort(), signals, located: locatedVariables(program) }
}

/** multi-edit: the shared value across the selection, flagged `mixed` when they disagree */
export function sharedParam(parts: readonly PartInstance[], key: string): { value: ParamValue | undefined; mixed: boolean } {
  const read = (p: PartInstance) => (p.params as unknown as Record<string, ParamValue>)[key]
  const first = read(parts[0]!)
  for (let i = 1; i < parts.length; i++) {
    const v = read(parts[i]!)
    const eq = Array.isArray(first) || Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(first) : v === first
    if (!eq) return { value: first, mixed: true }
  }
  return { value: first, mixed: false }
}

/** two numberList tables equal within float epsilon (drift-matching a shape-preset enum against its rows) */
export function rowsEqual(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean {
  if (a.length !== b.length) return false
  return a.every((r, i) => r.length === b[i]!.length && r.every((v, j) => Math.abs(v - b[i]![j]!) < 1e-6))
}

/** nested inspector section built from "Group/Subgroup" param paths */
export interface GroupNode {
  name: string
  path: string
  specs: ParamSpec[]
  children: GroupNode[]
}

export function buildGroupTree(specs: readonly ParamSpec[]): { ungrouped: ParamSpec[]; groups: GroupNode[] } {
  const ungrouped: ParamSpec[] = []
  const groups: GroupNode[] = []
  for (const spec of specs) {
    if (spec.group === undefined) {
      ungrouped.push(spec)
      continue
    }
    let level = groups
    let path = ''
    let node: GroupNode | undefined
    for (const name of spec.group.split('/')) {
      path = path ? `${path}/${name}` : name
      node = level.find((g) => g.path === path)
      if (!node) {
        node = { name, path, specs: [], children: [] }
        level.push(node)
      }
      level = node.children
    }
    node!.specs.push(spec)
  }
  return { ungrouped, groups }
}

/** The first tag field in the order the Inspector draws them: the ungrouped fields, then each group's own before its
 *  subsections. The part's Controller row is drawn above it (controllerRow.tsx). */
export function firstTagKey(ungrouped: readonly ParamSpec[], groups: readonly GroupNode[]): string | undefined {
  const inGroup = (g: GroupNode): string | undefined => g.specs.find((s) => s.kind === 'tagRef')?.key ?? g.children.map(inGroup).find((k) => k !== undefined)
  return ungrouped.find((s) => s.kind === 'tagRef')?.key ?? groups.map(inGroup).find((k) => k !== undefined)
}

/**
 * The product marks a scene knows, for a field that suggests them (ParamSpec.suggest 'marks'): every param a package
 * declares a product attribute, which becomes the product's mark of the same name at Run. Sorted and deduplicated.
 */
export function knownMarks(packages: readonly { params?: Record<string, { attribute?: boolean } | undefined> }[]): string[] {
  const marks = new Set<string>()
  for (const pkg of packages) for (const [key, spec] of Object.entries(pkg.params ?? {})) if (spec?.attribute === true) marks.add(key)
  return [...marks].sort()
}

/** how many bits a bitmask param (ParamSpec.bits) shows on this part: its literal count, or the number param named */
export function bitCount(bits: number | string, params: Readonly<Record<string, unknown>>, fallback: number): number {
  const n = typeof bits === 'number' ? bits : typeof params[bits] === 'number' ? (params[bits] as number) : fallback
  return Math.max(1, Math.min(31, Math.round(n)))
}

/**
 * The factor between a number param's stored value and the one its field shows: 100 for a `'%'` param (stored as
 * a fraction, ParamSpec.unit), else 1. Everything the field shows (value, range, step) is multiplied by it and
 * every commit divided, so the part keeps reading the raw fraction.
 */
export function displayScale(spec: NumberParamSpec): number {
  return spec.unit === '%' ? 100 : 1
}

/** a stored number as its field shows it (no float dust from the percent scale: 0.42 reads 42, not 42.00000000000001) */
export function shownNumber(spec: NumberParamSpec, v: number): number {
  const k = displayScale(spec)
  return k === 1 ? v : Number((v * k).toPrecision(12))
}

/** a number param's value as the field commits it: integer-step params stay on the step grid, then clamped */
export function normalizeNumber(spec: NumberParamSpec, raw: number): number {
  const v = Number.isInteger(spec.step) && spec.step >= 1 ? Math.round(raw / spec.step) * spec.step : raw
  return clamp(v, spec.min, spec.max)
}

// --- property clipboard compatibility (Copy / Paste Property) ---

export type ClipKind = ParamSpec['kind'] | 'pos' | 'rot'
export type ClipValue = ParamValue | readonly number[]

const STRING_KINDS = new Set<ClipKind>(['enum', 'color', 'text', 'partRef', 'tagRef'])

/** a copied kind may paste into the same kind, or any string-like kind into another (the target still vets the value) */
export function pasteCompatible(clip: ClipKind, target: ClipKind): boolean {
  if (clip === target) return true
  return STRING_KINDS.has(clip) && STRING_KINDS.has(target)
}

export interface PasteContext {
  /** every scene part (a partRef paste must name one) */
  allParts: readonly PartInstance[]
  /** the parts being pasted into (a partRef may not point a part at itself) */
  targetIds: ReadonlySet<string>
}

/**
 * The value `spec` takes from a pasted clipboard value, normalised exactly as entering it in the field would
 * be (clamped, stepped, lower-cased), or null when the field can't hold it at all. Writing the raw value would put
 * a speed of 3 into a height capped at 0.6, or a free-text string into a dropdown.
 */
export function coercePaste(spec: ParamSpec, v: unknown, ctx: PasteContext): ParamValue | null {
  switch (spec.kind) {
    case 'number':
      return isFiniteNumber(v) ? normalizeNumber(spec, v) : null
    case 'boolean':
      return typeof v === 'boolean' ? v : null
    case 'enum':
      return typeof v === 'string' && spec.options.some((o) => o.value === v) ? v : null
    case 'color':
      // a list takes a list (or one colour) in its one spelling; a string with no colour in it is refused
      if (spec.list) {
        const list = normalizeHexColorList(v)
        return list || v === '' ? list : null
      }
      if (spec.alpha) return isHexColorA(v) ? v.toLowerCase() : null
      // an opaque field takes the colour of an #rrggbbaa value and drops its alpha
      return isHexColor(v) || isHexColorA(v) ? splitHexAlpha(v).rgb : null
    case 'text':
      return typeof v === 'string' ? v : null
    case 'partRef':
      if (typeof v !== 'string') return null
      return v === '' || ctx.allParts.some((p) => p.id === v && !ctx.targetIds.has(p.id)) ? v : null
    case 'tagRef':
      // a tag name never holds whitespace; a sentence copied from a text field is not a tag
      return typeof v === 'string' && !/\s/.test(v) ? v : null
    case 'numberList': {
      const rows = v as unknown[]
      if (!Array.isArray(rows)) return null
      const ok = rows.every((r) => Array.isArray(r) && r.length === spec.arity && r.every(isFiniteNumber))
      if (!ok) return null
      const lo = spec.min ?? -Infinity
      const hi = spec.max ?? Infinity
      return (rows as number[][]).map((r) => r.map((n) => clamp(n, lo, hi)))
    }
    case 'wallRules':
      return Array.isArray(v) ? (v as BuildingWallRule[]).map((r) => ({ ...r })) : null
  }
}

/** a Transform row's paste: exactly three finite numbers, or null */
export function coerceVec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) return null
  return [v[0]!, v[1]!, v[2]!]
}
