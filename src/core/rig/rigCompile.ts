// Compile a part's rig from code into the manifest's rig geometry.
//
// A part may describe its rig as a function of its params, `rig(params)`, returning plain links, joints and
// bounds computed with ordinary arithmetic. The manifest can only hold numbers plus param refs
// (`param [× mulParam] × scale + add`, clamped to an optional [min, max]), so the compiler runs `rig()` at the
// defaults and at many points across each param's range, and turns every number that moves into a ref. It fits:
//   - a straight line in one param, or a straight line between two flat ends (the flats become min / max);
//   - a product of two params plus a constant (`mulParam`);
//   - a sum of two such lines, one in each param (two refs, the second marked `plus`);
// on a link offset or rotation axis, a box size axis, a cylinder's radius or height, a grip zone's or a detection
// zone's size axis, an array's step axis, a leg row's frame depth, a joint's min or max (`minParam` / `maxParam`, the
// static limit set to the widest value over the param's range; one param or a product only), and a bounds field
// (`bounds.params`). It refuses anything else: a number
// that follows three params, isn't one of those shapes, sits in a field with no param ref, or a rig whose shape
// changes (a link appearing, a kind switching). The refusal names the field, so the author can move that shape into
// `geometry()`. The output is then resolved against `rig()` at every point it was probed at, and at points where
// every param has moved at once.
//
// Only the first-party build (scripts/build-parts.mjs) runs this today; the app loads the compiled manifest.

import type { ParamSchema, ParamSpec, ParamValue } from '../parts/partApi'
import type { BoundsParamRef, ParamRef, PartBounds, RigGeometry, RigJoint, RigLink, SizeParamRef } from '../parts/partPackage'
import { resolvedBounds } from '../parts/partGeometry'
import { resolvePartParams } from '../parts/partScript'
import { jointLimits, legFrameDepth, resolvedBoxSize, resolvedCylinder, resolvedMeshScale, resolvedOffset, type RigParams } from './rigPose'

/** What a part's `rig(params)` returns: a rig geometry without its `kind`. */
export type RigSource = Omit<RigGeometry, 'kind'>

export type RigSourceFn = (params: Record<string, ParamValue>) => RigSource

export type RigCompileResult = { geometry: RigGeometry; problems: [] } | { geometry: null; problems: string[] }

// 8 decimals, near-zero to 0, so manifests diff cleanly
const round = (n: number): number => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8))
// a slope 8 decimals can't carry to TOLERANCE over its param's range (degrees to radians over 45°) keeps 12
const roundFine = (n: number): number => (Math.abs(n) < 1e-13 ? 0 : +n.toFixed(12))
// a compiled ref must reproduce rig() to this tolerance at every probe
const TOLERANCE = 1e-7
// two numbers rig() returned are the same number (a flat end, a leaf that did not move)
const SAME = 1e-9
// points per number param across its range: enough to find a clamp's knees on any part shipped
const SAMPLES = 48

type Leaf = { path: string; value: number }
type Point = [number, number]
/** A fitted ref before it is written into a field: `param [× mulParam] × scale + add`, clamped to [min, max]. */
type Fit = { param: string; mulParam?: string; scale: number; add: number; min?: number; max?: number; plus?: boolean }

/** Where a number that follows a param lands in the manifest. */
type Target =
  | { kind: 'offset' | 'rotation' | 'box' | 'zone' | 'detectZone' | 'step'; link: number; axis: 0 | 1 | 2 }
  | { kind: 'cylinder'; link: number; axis: 0 | 1 }
  | { kind: 'frameDepth'; link: number }
  | { kind: 'joint'; joint: number; end: 'min' | 'max' }
  | { kind: 'bounds'; field: BoundsParamRef['field'] }

const BOUNDS_FIELDS = ['length', 'centerX', 'width', 'centerZ', 'top', 'bottom'] as const

/** The field a leaf's path names, when that field can carry a param ref. */
function targetOf(path: string, base: RigSource): Target | null {
  let m = /^\.links\[(\d+)\]\.offset\[([012])\]$/.exec(path)
  if (m) return { kind: 'offset', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.rotation\[([012])\]$/.exec(path)
  if (m && !base.links[+m[1]!]?.quat) return { kind: 'rotation', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.zone\.size\[([012])\]$/.exec(path)
  if (m) return { kind: 'detectZone', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.shape\.size\[([012])\]$/.exec(path)
  if (m && base.links[+m[1]!]?.shape.kind === 'box') return { kind: 'box', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.shape\.(radius|height)$/.exec(path)
  if (m && base.links[+m[1]!]?.shape.kind === 'cylinder') return { kind: 'cylinder', link: +m[1]!, axis: m[2] === 'height' ? 1 : 0 }
  m = /^\.links\[(\d+)\]\.grip\.zone\.size\[([012])\]$/.exec(path)
  if (m) return { kind: 'zone', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.array\.step\[([012])\]$/.exec(path)
  if (m) return { kind: 'step', link: +m[1]!, axis: +m[2]! as 0 | 1 | 2 }
  m = /^\.links\[(\d+)\]\.shape\.frameDepth$/.exec(path)
  if (m && base.links[+m[1]!]?.shape.kind === 'leg') return { kind: 'frameDepth', link: +m[1]! }
  m = /^\.joints\[(\d+)\]\.(min|max)$/.exec(path)
  if (m) return { kind: 'joint', joint: +m[1]!, end: m[2] as 'min' | 'max' }
  m = /^\.bounds\.(\w+)$/.exec(path)
  if (m && (BOUNDS_FIELDS as readonly string[]).includes(m[1]!)) return { kind: 'bounds', field: m[1] as BoundsParamRef['field'] }
  return null
}

/** A number param's probe range: its own [min, max], or one either side of the current value where it has none. */
function rangeOf(spec: ParamSpec, current: ParamValue): [number, number] | null {
  if (spec.type !== 'number' || typeof current !== 'number') return null
  const lo = spec.min ?? current - 1
  const hi = spec.max ?? current + 1
  return hi > lo ? [lo, hi] : null
}

/** The values a non-number param is probed at: the other state (booleans), every other option (enums). Strings
 *  and tags can't drive geometry the manifest holds, so they get none. */
function otherValues(spec: ParamSpec, current: ParamValue): ParamValue[] {
  if (spec.type === 'boolean') return [!current]
  if (spec.type === 'enum') return (spec.options ?? []).map((o) => o.value).filter((v) => v !== current)
  return []
}

/** Every number in `value` with its path, and the rest of its structure as a string, so two runs can be compared. */
function flatten(value: unknown, path: string, leaves: Leaf[], shape: string[]): void {
  if (typeof value === 'number') {
    leaves.push({ path, value })
    shape.push(`${path}:#`)
  } else if (Array.isArray(value)) {
    shape.push(`${path}:[${value.length}]`)
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, leaves, shape))
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) flatten((value as Record<string, unknown>)[k], `${path}.${k}`, leaves, shape)
  } else {
    shape.push(`${path}=${JSON.stringify(value)}`)
  }
}

/** Insert `key: value` into `obj` right after `after`, keeping the author's key order (manifests diff by line). */
function insertAfter<T extends object>(obj: T, after: string, key: string, value: unknown): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue
    out[k] = v
    if (k === after) out[key] = value
  }
  if (!(key in out)) out[key] = value
  return out as T
}

/** A plain-data copy of `value`, so editing the compiled rig never reaches what rig() returned. */
function copyData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyData) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = copyData(v)
    return out as T
  }
  return value
}

const clampTo = (x: number, min?: number, max?: number): number => (min !== undefined && x < min ? min : max !== undefined && x > max ? max : x)
const atFit = (f: Fit, v: number, m = 1): number => clampTo(v * m * f.scale + f.add, f.min, f.max)

type LineFit = { fit: Omit<Fit, 'param'> } | { refine: [number, number] } | { fail: true }

/**
 * Fit points (param value, number) to `scale × v + add`, clamped to [min, max]: a straight line, or a straight line
 * between flat ends. The flats are the min / max exactly as rig() returned them; scale and add are rounded. Asks
 * for more points in an interval when a knee could be anywhere in it.
 */
function fitClampedLine(points: readonly Point[]): LineFit {
  const p = [...points].sort((a, b) => a[0] - b[0])
  const n = p.length
  const xL = p[0]![1]
  const xR = p[n - 1]![1]
  let i0 = 1 // p[0 .. i0-1] equal xL
  while (i0 < n && Math.abs(p[i0]![1] - xL) <= SAME) i0++
  if (i0 >= n) return { fail: true }
  let i1 = 1 // p[n-i1 .. n-1] equal xR
  while (i1 < n && Math.abs(p[n - 1 - i1]![1] - xR) <= SAME) i1++
  // the sloped run between the flats; a one-point "flat" may be the line's own end, so it is tested below
  const s = i0
  const e = n - 1 - i1
  if (e - s < 1) return { refine: [p[s - 1]![0], p[e + 1]![0]] }
  const [va, xa] = p[s]!
  const [vb, xb] = p[e]!
  const scale = (xb - xa) / (vb - va)
  const add = xa - scale * va
  const line = (v: number): number => scale * v + add
  for (let i = s; i <= e; i++) if (Math.abs(line(p[i]![0]) - p[i]![1]) > TOLERANCE) return { fail: true }
  let lo: number | undefined // the left flat's value, when there is one
  let hi: number | undefined
  if (!(i0 === 1 && Math.abs(line(p[0]![0]) - xL) <= TOLERANCE)) {
    if (i0 === 1) return { refine: [p[0]![0], p[1]![0]] }
    lo = xL
  }
  if (!(i1 === 1 && Math.abs(line(p[n - 1]![0]) - xR) <= TOLERANCE)) {
    if (i1 === 1) return { refine: [p[n - 2]![0], p[n - 1]![0]] }
    hi = xR
  }
  // rising, the left flat is the floor; falling, it is the ceiling
  const [min, max] = scale > 0 ? [lo, hi] : [hi, lo]
  if (min !== undefined && max !== undefined && !(min < max)) return { fail: true }
  for (const r of [round, roundFine]) {
    const fit: Omit<Fit, 'param'> = { scale: r(scale), add: r(add) }
    if (min !== undefined) fit.min = min
    if (max !== undefined) fit.max = max
    const f = { param: '', ...fit }
    if (p.every(([v, x]) => Math.abs(atFit(f, v) - x) <= TOLERANCE)) return { fit }
  }
  return { fail: true }
}

/** The ref as the manifest writes it. A one-param ref on a box size, link offset or grip zone axis always carries
 *  its scale (the form every compiled manifest has); every other ref leaves a scale of 1 out. `add` is written
 *  when it isn't 0. */
function refFields(fit: Fit, alwaysScale: boolean): ParamRef {
  const ref: ParamRef = { param: fit.param }
  if (fit.mulParam !== undefined) ref.mulParam = fit.mulParam
  if (fit.scale !== 1 || (alwaysScale && fit.mulParam === undefined)) ref.scale = fit.scale
  if (fit.add !== 0) ref.add = fit.add
  if (fit.min !== undefined) ref.min = fit.min
  if (fit.max !== undefined) ref.max = fit.max
  if (fit.plus) ref.plus = true
  return ref
}

/** Every number a host reads from a rig at these params, each ref resolved and named: offsets, sizes, joint limits,
 *  bounds. */
function resolvedNumbers(g: RigSource, params: RigParams): [string, number][] {
  const out: [string, number][] = []
  const put = (name: string, values: readonly number[]): void => values.forEach((v, i) => out.push([values.length > 1 ? `${name}[${i}]` : name, v]))
  g.links.forEach((link, i) => {
    const at = `links[${i}] (${link.name})`
    put(`${at} offset`, resolvedOffset(link.offset, link.offsetParams, params))
    if (link.rotation) put(`${at} rotation`, resolvedOffset(link.rotation, link.rotationParams, params))
    const s = link.shape
    if (s.kind === 'box') put(`${at} size`, resolvedBoxSize(s.size, s.sizeParams, params))
    else if (s.kind === 'cylinder') {
      const c = resolvedCylinder(s, params)
      put(`${at} radius`, [c.radius])
      put(`${at} height`, [c.height])
    } else if (s.kind === 'mesh') put(`${at} stretch`, resolvedMeshScale(s.sizeParams, params))
    else if (s.kind === 'leg') put(`${at} frameDepth`, [legFrameDepth(s, params)])
    const zone = link.grip?.zone
    if (zone) put(`${at} grip zone size`, resolvedBoxSize(zone.size, zone.sizeParams, params))
    if (link.zone) put(`${at} zone size`, resolvedBoxSize(link.zone.size, link.zone.sizeParams, params))
    if (link.array?.step) put(`${at} array step`, resolvedOffset(link.array.step, link.array.stepParams, params))
  })
  ;(g.joints ?? []).forEach((j, i) => {
    const [lo, hi] = jointLimits(j, params)
    put(`joints[${i}] (${j.name}) min`, [lo])
    put(`joints[${i}] (${j.name}) max`, [hi])
  })
  if (g.bounds) {
    const b = resolvedBounds(g.bounds, params)
    for (const f of BOUNDS_FIELDS) put(`bounds.${f}`, [b[f]])
  }
  return out
}

/** The ref rig() already wrote on a target, if any: compiling a second one onto it would be ambiguous. */
function hasOwnRef(t: Target, g: RigSource): boolean {
  if (t.kind === 'joint') {
    const j = g.joints?.[t.joint]
    return !!(t.end === 'min' ? j?.minParam : j?.maxParam)
  }
  if (t.kind === 'bounds') return !!g.bounds?.params?.some((r) => r.field === t.field)
  const link = g.links[t.link]!
  if (t.kind === 'offset') return !!link.offsetParams?.some((r) => r.axis === t.axis)
  if (t.kind === 'rotation') return !!link.rotationParams?.some((r) => r.axis === t.axis)
  if (t.kind === 'frameDepth') return link.shape.kind === 'leg' && !!link.shape.frameDepthParam
  const own =
    t.kind === 'zone' ? link.grip?.zone?.sizeParams : t.kind === 'detectZone' ? link.zone?.sizeParams : t.kind === 'step' ? link.array?.stepParams : (link.shape as { sizeParams?: SizeParamRef[] }).sizeParams
  if (t.kind === 'cylinder') return !!own?.some((r) => (r.axis === 1) === (t.axis === 1))
  return !!own?.some((r) => r.axis === t.axis)
}

/**
 * Compile `rig` into the manifest's rig geometry: the numbers at the params' defaults, plus a param ref for every
 * number that follows a param.
 */
export function compileRig(rig: RigSourceFn, schema: ParamSchema): RigCompileResult {
  const problems: string[] = []
  const defaults = resolvePartParams(schema, {})
  const run = (overrides: Record<string, ParamValue>): RigSource | string => {
    try {
      const out = rig(resolvePartParams(schema, overrides))
      if (!out || !Array.isArray(out.links)) return 'rig() must return { links, joints, bounds }'
      // a plain-data copy: the numbers exactly as rig() computed them (the author rounds their own constants)
      return copyData(out)
    } catch (e) {
      return `rig() threw: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  const base = run({})
  if (typeof base === 'string') return { geometry: null, problems: [base] }
  const baseLeaves: Leaf[] = []
  const baseShape: string[] = []
  flatten(base, '', baseLeaves, baseShape)
  const baseShapeKey = baseShape.join('|')
  const describe = (o: Record<string, ParamValue>): string => Object.entries(o).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')

  // every run kept, keyed by its overrides: the fits read them and the final check resolves against them
  const runs = new Map<string, { overrides: Record<string, ParamValue>; out: RigSource; leaves: number[] }>()
  const sample = (overrides: Record<string, ParamValue>): number[] | null => {
    const key = JSON.stringify(overrides)
    const seen = runs.get(key)
    if (seen) return seen.leaves
    const out = run(overrides)
    if (typeof out === 'string') {
      problems.push(`with ${describe(overrides)}: ${out}`)
      return null
    }
    const leaves: Leaf[] = []
    const shape: string[] = []
    flatten(out, '', leaves, shape)
    if (shape.join('|') !== baseShapeKey) {
      problems.push(`the rig's structure changes with ${Object.keys(overrides).join(' and ')}: links, arrays and kinds must stay the same (draw that part in geometry())`)
      return null
    }
    const values = leaves.map((l) => l.value)
    runs.set(key, { overrides, out, leaves: values })
    return values
  }

  // per number param, the (value, leaves) pairs probed across its range
  const probes = new Map<string, { value: number; leaves: number[] }[]>()
  const probeAt = (param: string, value: number): void => {
    const leaves = sample({ [param]: value })
    if (leaves) probes.get(param)!.push({ value, leaves })
  }
  const ranges = new Map<string, [number, number]>()
  for (const [param, spec] of Object.entries(schema)) {
    const range = rangeOf(spec, defaults[param]!)
    if (range) {
      ranges.set(param, range)
      probes.set(param, [{ value: defaults[param] as number, leaves: baseLeaves.map((l) => l.value) }])
      const [lo, hi] = range
      for (let i = 0; i <= SAMPLES; i++) {
        const v = lo + ((hi - lo) * i) / SAMPLES
        if (Math.abs(v - (defaults[param] as number)) > SAME) probeAt(param, v)
      }
      continue
    }
    for (const value of otherValues(spec, defaults[param]!)) {
      const leaves = sample({ [param]: value })
      if (!leaves) continue
      leaves.forEach((x, k) => {
        if (Math.abs(x - baseLeaves[k]!.value) > SAME) problems.push(`${baseLeaves[k]!.path} changes with ${param}, which is not a number param`)
      })
    }
  }
  if (problems.length) return { geometry: null, problems: [...new Set(problems)] }

  const pointsOf = (param: string, k: number): Point[] => probes.get(param)!.map((s) => [s.value, s.leaves[k]!])
  const notLine = (path: string, param: string): string =>
    `${path} is not a straight line in ${param}, or a straight line between two flat ends; a manifest ref is param × scale + add, clamped to [min, max] (draw it in geometry())`

  /** The clamped line a leaf follows in one param, sampling more of the range where a knee hides. */
  const fitOne = (path: string, param: string, k: number): Fit | null => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = fitClampedLine(pointsOf(param, k))
      if ('fit' in r) return { param, ...r.fit }
      if ('fail' in r) break
      const [a, b] = r.refine
      for (let i = 1; i <= 12; i++) probeAt(param, a + ((b - a) * i) / 13)
    }
    problems.push(notLine(path, param))
    return null
  }

  /** Does `x(p, q)` land on what `at` says on a 3 × 3 grid over both params' ranges, and on every single-param probe?
   *  Undefined when a grid run failed (its problem is already listed). */
  const onGrid = (p: string, q: string, k: number, at: (pv: number, qv: number) => number): boolean | undefined => {
    const [pl, ph] = ranges.get(p)!
    const [ql, qh] = ranges.get(q)!
    for (const pv of [pl, (pl + ph) / 2, ph]) {
      for (const qv of [ql, (ql + qh) / 2, qh]) {
        const leaves = sample({ [p]: pv, [q]: qv })
        if (!leaves) return undefined
        if (Math.abs(at(pv, qv) - leaves[k]!) > TOLERANCE) return false
      }
    }
    const p0 = defaults[p] as number
    const q0 = defaults[q] as number
    for (const [v, x] of pointsOf(p, k)) if (Math.abs(at(v, q0) - x) > TOLERANCE) return false
    for (const [v, x] of pointsOf(q, k)) if (Math.abs(at(p0, v) - x) > TOLERANCE) return false
    return true
  }

  /** `p × q × scale + add`: each param alone must be a plain line, and the cross grid must land on the product.
   *  Null when it is not one, with nothing listed (fitTwo tries a sum next); undefined when a run failed. */
  const fitProduct = (p: string, q: string, k: number): Fit | null | undefined => {
    const refuse = (): null => null
    const lp = fitClampedLine(pointsOf(p, k))
    const lq = fitClampedLine(pointsOf(q, k))
    if (!('fit' in lp) || !('fit' in lq) || lp.fit.min !== undefined || lp.fit.max !== undefined || lq.fit.min !== undefined || lq.fit.max !== undefined) return refuse()
    const p0 = defaults[p] as number
    const q0 = defaults[q] as number
    if (Math.abs(q0) < SAME) return refuse()
    // the unrounded slope in p at q0 is scale × q0
    const pts = pointsOf(p, k)
    const [[va, xa], [vb, xb]] = [pts.reduce((m, x) => (x[0] < m[0] ? x : m)), pts.reduce((m, x) => (x[0] > m[0] ? x : m))]
    const scale = (xb - xa) / (vb - va) / q0
    const x0 = baseLeaves[k]!.value
    const fit: Fit = { param: p, mulParam: q, scale: round(scale), add: round(x0 - scale * p0 * q0) }
    const ok = onGrid(p, q, k, (pv, qv) => atFit(fit, pv, qv))
    return ok === undefined ? undefined : ok ? fit : refuse()
  }

  /** `line(p) + line(q)`, each a clamped line in its own param: the first ref replaces the field with its line at the
   *  other param's default, the second adds its own line less that shared value. Null when it is not one. */
  const fitSum = (p: string, q: string, k: number): Fit[] | null | undefined => {
    const lp = fitClampedLine(pointsOf(p, k))
    const lq = fitClampedLine(pointsOf(q, k))
    if (!('fit' in lp) || !('fit' in lq)) return null
    const x0 = baseLeaves[k]!.value
    const first: Fit = { param: p, ...lp.fit }
    const second: Fit = { param: q, scale: lq.fit.scale, add: round(lq.fit.add - x0), plus: true }
    if (lq.fit.min !== undefined) second.min = round(lq.fit.min - x0)
    if (lq.fit.max !== undefined) second.max = round(lq.fit.max - x0)
    const ok = onGrid(p, q, k, (pv, qv) => atFit(first, pv) + atFit(second, qv))
    return ok === undefined ? undefined : ok ? [first, second] : null
  }

  /** A leaf that follows two params: their product, else (where the field holds more than one ref) their sum. */
  const fitTwo = (path: string, p: string, q: string, k: number, single: boolean): Fit[] | null => {
    const product = fitProduct(p, q, k)
    if (product === undefined) return null
    if (product) return [product]
    const sum = single ? null : fitSum(p, q, k)
    if (sum === undefined) return null
    if (sum) return sum
    problems.push(
      single
        ? `${path} follows both ${p} and ${q} and isn't their product plus a constant; this field holds one ref, which follows one param or param × mulParam × scale + add`
        : `${path} follows both ${p} and ${q} and is neither their product plus a constant nor a line in each added together; a manifest ref follows one param, or param × mulParam × scale + add, and a plus ref adds a second`,
    )
    return null
  }

  const order = Object.keys(schema)
  const fits: { target: Target; fit: Fit }[] = [] // a sum is two, in order: the replacing ref, then the plus one
  baseLeaves.forEach((leaf, k) => {
    const movers = [...probes.keys()].filter((param) => probes.get(param)!.some((s) => Math.abs(s.leaves[k]! - leaf.value) > SAME))
    if (movers.length === 0) return
    const target = targetOf(leaf.path, base)
    if (!target) {
      problems.push(`${leaf.path} changes with ${movers.join(' and ')}, and that field can't follow a param in the manifest`)
      return
    }
    if (hasOwnRef(target, base)) {
      problems.push(`${leaf.path} changes with ${movers.join(' and ')} and also has its own ref; keep one`)
      return
    }
    if (movers.length > 2) {
      problems.push(`${leaf.path} follows ${movers.join(', ')}; a manifest ref follows one param, the product of two, or a sum of two refs`)
      return
    }
    const [p, q] = [...movers].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    // a joint limit and a leg's frame depth hold one ref, so no sum
    const single = target.kind === 'joint' || target.kind === 'frameDepth'
    const one = q === undefined ? fitOne(leaf.path, p!, k) : null
    const fitted = q === undefined ? (one ? [one] : null) : fitTwo(leaf.path, p!, q, k, single)
    if (!fitted) return
    const fit = fitted[0]!
    if (target.kind === 'joint') {
      // the static limit is the outer envelope: the widest the ref reaches over its params' ranges
      for (const param of [fit.param, fit.mulParam].filter((x): x is string => x !== undefined)) {
        const spec = schema[param]!
        if (spec.type !== 'number' || spec.min === undefined || spec.max === undefined) {
          problems.push(`${leaf.path} follows ${param}, which has no min and max, so the joint's outer limit can't be set`)
          return
        }
      }
    }
    for (const f of fitted) fits.push({ target, fit: f })
  })
  if (problems.length) return { geometry: null, problems: [...new Set(problems)] }

  // write the refs into a copy of the default rig
  const geometry: RigGeometry = { kind: 'rig', ...copyData(base), joints: copyData((base.joints ?? []) as RigJoint[]) }
  const links = geometry.links as (RigLink & Record<string, unknown>)[]
  const byAxis = (a: SizeParamRef, b: SizeParamRef): number => a.axis - b.axis
  const added = new Map<object, SizeParamRef[]>() // each sizeParams / offsetParams / rotationParams owner and its compiled refs
  const addAxisRef = (owner: object, ref: SizeParamRef): void => {
    added.set(owner, [...(added.get(owner) ?? []), ref])
  }
  const jointRefs = new Map<number, { min?: ParamRef; max?: ParamRef }>()
  const boundsRefs: BoundsParamRef[] = []
  const extreme = (fit: Fit, widest: (a: number, b: number) => number): number => {
    const ends = (param: string): number[] => ranges.get(param)!
    const ms = fit.mulParam !== undefined ? ends(fit.mulParam) : [1]
    let out = atFit(fit, ends(fit.param)[0]!, ms[0])
    for (const v of ends(fit.param)) for (const m of ms) out = widest(out, atFit(fit, v, m))
    return round(out)
  }
  for (const { target: t, fit } of fits) {
    if (t.kind === 'joint') {
      const j = geometry.joints[t.joint]!
      j[t.end] = extreme(fit, t.end === 'min' ? Math.min : Math.max)
      jointRefs.set(t.joint, { ...jointRefs.get(t.joint), [t.end]: refFields(fit, false) })
      continue
    }
    if (t.kind === 'bounds') {
      const b = geometry.bounds as PartBounds & Record<string, number>
      b[t.field] = round(b[t.field]!)
      boundsRefs.push({ field: t.field, ...refFields(fit, false) })
      continue
    }
    const link = links[t.link]!
    if (t.kind === 'frameDepth') {
      const shape = link.shape as Extract<RigLink['shape'], { kind: 'leg' }>
      shape.frameDepth = round(shape.frameDepth)
      link.shape = insertAfter(shape, 'frameDepth', 'frameDepthParam', refFields(fit, false))
      continue
    }
    const ref: SizeParamRef = { axis: t.axis, ...refFields(fit, t.kind !== 'cylinder' && t.kind !== 'step') }
    if (t.kind === 'offset') {
      link.offset[t.axis] = round(link.offset[t.axis]!)
      addAxisRef(link, ref)
    } else if (t.kind === 'rotation') {
      link.rotation![t.axis] = round(link.rotation![t.axis]!)
      addAxisRef(link.rotation!, ref)
    } else if (t.kind === 'detectZone') {
      const zone = link.zone!
      zone.size[t.axis] = round(zone.size[t.axis]!)
      addAxisRef(zone, ref)
    } else if (t.kind === 'box') {
      const size = (link.shape as { size: number[] }).size
      size[t.axis] = round(size[t.axis]!)
      addAxisRef(link.shape, ref)
    } else if (t.kind === 'cylinder') {
      const shape = link.shape as { radius: number; height: number }
      const key = t.axis === 1 ? 'height' : 'radius'
      shape[key] = round(shape[key])
      addAxisRef(link.shape, ref)
    } else if (t.kind === 'step') {
      const array = link.array!
      array.step![t.axis] = round(array.step![t.axis]!)
      addAxisRef(array, ref)
    } else {
      const zone = link.grip!.zone!
      zone.size[t.axis] = round(zone.size[t.axis]!)
      addAxisRef(zone, ref)
    }
  }
  links.forEach((link, i) => {
    const offset = added.get(link)
    let out = link
    if (offset) out = insertAfter(out, 'offset', 'offsetParams', [...(out.offsetParams ?? []), ...offset].sort(byAxis))
    const rotation = link.rotation && added.get(link.rotation)
    if (rotation) out = insertAfter(out, 'rotation', 'rotationParams', [...(out.rotationParams ?? []), ...rotation].sort(byAxis))
    const detect = link.zone && added.get(link.zone)
    if (link.zone && detect) out = { ...out, zone: insertAfter(link.zone, 'size', 'sizeParams', [...(link.zone.sizeParams ?? []), ...detect].sort(byAxis)) }
    const shapeRefs = added.get(link.shape)
    if (shapeRefs) {
      const shape = link.shape as RigLink['shape'] & { sizeParams?: SizeParamRef[] }
      out = { ...out, shape: insertAfter(shape, shape.kind === 'cylinder' ? 'height' : 'size', 'sizeParams', [...(shape.sizeParams ?? []), ...shapeRefs].sort(byAxis)) }
    }
    const zone = link.grip?.zone
    const zoneRefs = zone && added.get(zone)
    if (zone && zoneRefs) out = { ...out, grip: { ...link.grip, zone: insertAfter(zone, 'size', 'sizeParams', [...(zone.sizeParams ?? []), ...zoneRefs].sort(byAxis)) } }
    const array = link.array
    const stepRefs = array && added.get(array)
    if (array && stepRefs) out = { ...out, array: insertAfter(array, 'step', 'stepParams', [...(array.stepParams ?? []), ...stepRefs].sort(byAxis)) }
    links[i] = out
  })
  geometry.joints = geometry.joints.map((j, i) => {
    const refs = jointRefs.get(i)
    if (!refs) return j
    let out = j
    if (refs.min) out = insertAfter(out, 'max', 'minParam', refs.min)
    if (refs.max) out = insertAfter(out, refs.min ? 'minParam' : 'max', 'maxParam', refs.max)
    return out
  })
  if (boundsRefs.length) {
    const b = geometry.bounds!
    // each extent next to its centre, in the order the bounds list the extents
    const at = (r: BoundsParamRef): number => BOUNDS_FIELDS.indexOf(r.field)
    geometry.bounds = { ...b, params: [...(b.params ?? []), ...boundsRefs].sort((x, y) => at(x) - at(y)) }
  }

  // Resolve the compiled rig against rig() at every probe, and at two points where every number param has moved at
  // once (a dependence on two params together that no single-param probe sees). Refs read number params only, so
  // a numberList in the bag is never looked at.
  const mixedKeys = new Set<string>()
  for (const at of [0.37, 0.71]) {
    const mixed: Record<string, ParamValue> = {}
    for (const [param, [lo, hi]] of ranges) mixed[param] = lo + (hi - lo) * at
    if (Object.keys(mixed).length < 2) continue
    mixedKeys.add(JSON.stringify(mixed))
    sample(mixed)
  }
  if (problems.length) return { geometry: null, problems: [...new Set(problems)] }
  const untargeted = baseLeaves.map((l, k) => (targetOf(l.path, base) ? -1 : k)).filter((k) => k >= 0)
  const reported = new Set<string>() // each field once, at the first point it fails
  for (const [key, { overrides, out, leaves }] of runs) {
    const params = resolvePartParams(schema, overrides) as RigParams
    const want = resolvedNumbers(out, params)
    const mixed = mixedKeys.has(key)
    const where = mixed ? 'every param moved' : describe(overrides)
    resolvedNumbers(geometry, params).forEach(([name, x], k) => {
      if (Math.abs(x - want[k]![1]) <= TOLERANCE || reported.has(name)) return
      reported.add(name)
      problems.push(
        mixed
          ? `${name} doesn't match rig() with every param moved: a number depends on two params together`
          : `${name} doesn't match rig() with ${where}, where the host resolves the ref differently (a size must stay positive, a bounds top above its bottom, a joint limit inside its static range)`,
      )
    })
    // a number no ref can carry must not move here either
    for (const k of untargeted) {
      const path = baseLeaves[k]!.path
      if (Math.abs(leaves[k]! - baseLeaves[k]!.value) <= SAME || reported.has(path)) continue
      reported.add(path)
      problems.push(`${path} changes with ${where}, and that field can't follow a param in the manifest`)
    }
  }
  return problems.length ? { geometry: null, problems: [...new Set(problems)] } : { geometry, problems: [] }
}
