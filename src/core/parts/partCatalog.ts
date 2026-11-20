// The part catalog as data: one entry per package, read from the baked package the app registers, never from its
// source. `npm run catalog` (scripts/catalog.mjs) prints these; an agent composing a line reads them to learn what
// each param means and where a part sits relative to its position, without opening the behavior or the rig.
//
// Every frame fact here is computed by the code the app itself uses: the footprint by partFootprint (snapping,
// placement), conveyor ends by conveyorLocalEnds (the snap engine), zones and beams the way sim/cargoSensing.ts
// resolves them. Nothing is written per part. The frame is at default params unless given others (`--params`), which
// are applied the way the CLI seams apply them (partParamArgs.ts withParamArgs: a belt's `length` goes through its
// resize path), so a non-default part's ends and zones come from the same code as the default's.

import type { ParamSpec } from './partApi'
import { conveyorLocalEnds, isConveyorLike, partFootprint } from './partGeometry'
import type { PartPackage } from './partPackage'
import { withParamArgs, type ParamArgs } from './partParamArgs'
import { qApply, resolvedBeamRange, resolvedBoxSize, rigWorldPoses, type RigParams } from '../rig/rigPose'
import { createSdkPart } from '../scene/scene'

/** A param as declared: its key plus every field of its spec (label, desc, group, unit, range, options...). */
export type CatalogParam = { key: string } & ParamSpec

export interface CatalogSignal {
  name: string
  /** the tag's NAME is chosen by whoever places the part (the param's value) */
  named: 'at-placement'
  dir: 'in' | 'out' | null
  type: string | null
  label?: string
  desc?: string
  setpointFor?: string
  commandsDevice?: true
  /** the part reads it only while a program drives it, and runs on its own setting the rest of the time (the SDK's
   *  `onlyWhenDriven`, implied by `autoWhenDriven`): a tag named and not driven does not stop the part */
  onlyWhenDriven?: true
  values?: { value: number; label: string }[]
}

type Range = [number, number]

export interface CatalogFrame {
  /** part-local extents (m) at the entry's params (default unless given), rotationY = 0: what snapping and placement see */
  footprint?: { x: Range; y: Range; z: Range }
  /** where the origin sits along each horizontal axis of the footprint */
  origin?: { x: string; z: string }
  /** conveying ends (part-local): 'back' feeds in and 'front' discharges while the speed is positive */
  ends?: { end: 'front' | 'back'; at: [number, number, number]; out: [number, number]; faceWidth: number }[]
  /** detection zones (ctx.zone): centre and size in the part frame, axis-aligned with it, and the same box as its
   *  min / max corners (part-local: add the part's position at rotationY = 0). The sim tests a box's centre against
   *  it (sim/cargoSensing.ts pointInZone), so a zone acts on a box wherever it is, on a belt or not. */
  zones?: { name: string; centre: [number, number, number]; size: [number, number, number]; min: [number, number, number]; max: [number, number, number] }[]
  /** sensor beams: origin, unit direction (part frame) and reach at the entry's params */
  beams?: { name: string; origin: [number, number, number]; dir: [number, number, number]; range: number }[]
}

export interface CatalogEntry {
  id: string
  name: string
  category?: string
  geometry: string
  /** the conveyor bed / surface kind it declares, if any */
  conveyor?: { bed?: string; surface: string; speedParam?: string; frictionParam?: string }
  signals: CatalogSignal[]
  params: CatalogParam[]
  interactive?: true
  useParam?: string
  /** connection kinds it snaps with: declared `snap` keys plus the inferred 'conveyor' end-mate tier */
  snap?: string[]
  frame: CatalogFrame
  /** the params the frame was computed at, as given (`--params`); absent = defaults */
  frameParams?: ParamArgs
  /** a frame fact that could not be computed */
  frameError?: string
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000 + 0

/** A plain-data copy of a value (specs are JSON data; this drops anything that is not). */
const dataCopy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export function catalogParams(pkg: Pick<PartPackage, 'params'>): CatalogParam[] {
  return Object.entries(pkg.params ?? {}).map(([key, spec]) => ({ key, ...dataCopy(spec) }))
}

export function catalogSignals(pkg: Pick<PartPackage, 'params'>): CatalogSignal[] {
  const out: CatalogSignal[] = []
  for (const [name, spec] of Object.entries(pkg.params ?? {})) {
    if (spec?.type !== 'tag') continue
    const sig: CatalogSignal = { name, named: 'at-placement', dir: spec.dir ?? null, type: spec.stType ?? null }
    if (spec.label !== undefined) sig.label = spec.label
    if (spec.desc !== undefined) sig.desc = spec.desc
    if (spec.setpointFor !== undefined) sig.setpointFor = spec.setpointFor
    if (spec.autoWhenDriven) sig.commandsDevice = true
    if (spec.onlyWhenDriven || spec.autoWhenDriven) sig.onlyWhenDriven = true
    if (Array.isArray(spec.values)) sig.values = dataCopy(spec.values)
    out.push(sig)
  }
  return out
}

/** Where 0 falls in [min, max], in words: the end it sits at, the centre, or a percentage along. */
export function originAlong(min: number, max: number, axis: 'X' | 'Z'): string {
  const span = max - min
  if (!(span > 1e-6)) return 'n/a'
  const f = -min / span
  if (f < -0.01 || f > 1.01) return `outside the footprint (${r3(min)}..${r3(max)})`
  if (f <= 0.1) return `-${axis} end`
  if (f >= 0.9) return `+${axis} end`
  if (Math.abs(f - 0.5) <= 0.05) return 'centre'
  return `${Math.round(f * 100)}% along ${axis}`
}

/** Frame facts at default params, or with `args` applied (partParamArgs.ts withParamArgs: throws on a key the part
 *  does not have). The package must be registered (partRegistry.registerPackage): the footprint and conveyor-end
 *  resolvers look a part's package up by id, as they do in the app. */
export function catalogFrame(pkg: PartPackage, args?: ParamArgs): CatalogFrame {
  let part = createSdkPart(pkg, 'catalog-probe', [0, 0, 0])
  if (args && Object.keys(args).length > 0) part = withParamArgs(part, args)
  const frame: CatalogFrame = {}
  const fp = partFootprint(part)
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  const x: Range = [r3(cx - fp.hx), r3(cx + fp.hx)]
  const z: Range = [r3(cz - fp.hz), r3(cz + fp.hz)]
  frame.footprint = { x, y: [r3(fp.y0), r3(fp.y1)], z }
  frame.origin = { x: originAlong(x[0], x[1], 'X'), z: originAlong(z[0], z[1], 'Z') }
  const ends = conveyorLocalEnds(part)
  if (ends.length > 0) {
    frame.ends = ends.map((e) => ({ end: e.end, at: [r3(e.x), r3(e.y ?? 0), r3(e.z)], out: [r3(e.outX), r3(e.outZ)], faceWidth: r3(e.faceWidth) }))
  }
  const geo = pkg.geometry
  if (geo.kind === 'rig' && geo.links.some((l) => l.zone || l.beam)) {
    // the rest pose at the instance's params, as sim/cargoSensing.ts rigZones / rigBeams take it
    const params = part.params as RigParams
    const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
    const rest = rigWorldPoses(geo, {}, undefined, scale, params)
    for (const link of geo.links) {
      const pose = rest.get(link.name)
      if (!pose) continue
      if (link.zone) {
        const s = resolvedBoxSize(link.zone.size, link.zone.sizeParams, params)
        const c = pose.pos
        ;(frame.zones ??= []).push({
          name: link.name,
          centre: [r3(c[0]), r3(c[1]), r3(c[2])],
          size: [r3(s[0]), r3(s[1]), r3(s[2])],
          min: [r3(c[0] - s[0] / 2), r3(c[1] - s[1] / 2), r3(c[2] - s[2] / 2)],
          max: [r3(c[0] + s[0] / 2), r3(c[1] + s[1] / 2), r3(c[2] + s[2] / 2)],
        })
      }
      if (link.beam) {
        const d = qApply(pose.quat, [...(link.beam.axis ?? [0, 0, 1])] as [number, number, number])
        const len = Math.hypot(d[0], d[1], d[2]) || 1
        ;(frame.beams ??= []).push({
          name: link.name,
          origin: [r3(pose.pos[0]), r3(pose.pos[1]), r3(pose.pos[2])],
          dir: [r3(d[0] / len), r3(d[1] / len), r3(d[2] / len)],
          range: r3(resolvedBeamRange(link.beam, part.params)),
        })
      }
    }
  }
  return frame
}

/** One catalog entry, its frame at `args` when given (see {@link catalogFrame}). The package must be registered. */
export function catalogEntry(pkg: PartPackage, args?: ParamArgs): CatalogEntry {
  const entry: CatalogEntry = {
    id: pkg.id,
    name: pkg.name,
    geometry: pkg.geometry?.kind,
    signals: catalogSignals(pkg),
    params: catalogParams(pkg),
    frame: {},
  }
  if (pkg.category !== undefined) entry.category = pkg.category
  if (pkg.conveyor) entry.conveyor = dataCopy(pkg.conveyor)
  if (pkg.interactive) entry.interactive = true
  if (pkg.useParam !== undefined) entry.useParam = pkg.useParam
  // Conveyor snapping is inferred, not declared: snapFeatures.ts routes anything isConveyorLike() into
  // snapConveyor() before it reads `pkg.snap`, so the conveyors that end-mate declare no `snap` block. Probe the
  // real predicate on a default-param instance instead of re-deriving the rule.
  const snap = pkg.snap ? Object.keys(pkg.snap).filter((k) => (pkg.snap as Record<string, unknown>)[k] !== undefined) : []
  try {
    if (isConveyorLike(createSdkPart(pkg, 'catalog-probe', [0, 0, 0]))) snap.push('conveyor')
    if (args && Object.keys(args).length > 0) entry.frameParams = dataCopy(args)
    entry.frame = catalogFrame(pkg, args)
  } catch (e) {
    entry.frameError = e instanceof Error ? e.message : String(e)
  }
  if (snap.length > 0) entry.snap = snap
  return entry
}

// --- text rendering ---

const UNGROUPED = ''

/** A param value, short: long lists are cut so one line stays one line. */
export function formatValue(v: unknown, max = 40): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === undefined) return '-'
  const s = JSON.stringify(v) ?? String(v)
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

/** The param's constraint in brief: range and unit, enum values, list shape. */
export function paramConstraint(p: CatalogParam): string {
  const bits: string[] = []
  if (p.min !== undefined || p.max !== undefined) bits.push(`${p.min ?? ''}..${p.max ?? ''}`)
  if (p.unit) bits.push(p.unit)
  if (p.options) bits.push(`one of ${p.options.map((o) => o.value).join(' | ')}`)
  if (p.values) bits.push(p.values.map((v) => `${v.value}=${v.label}`).join(', '))
  if (p.type === 'numberList') bits.push(`rows of ${p.arity ?? 1}${p.columns ? ` (${p.columns.join(', ')})` : ''}`)
  return bits.join(' ')
}

/** Params by Inspector group, in declaration order, ungrouped first (as the Inspector shows them). */
export function groupParams(params: readonly CatalogParam[]): [string, CatalogParam[]][] {
  const groups = new Map<string, CatalogParam[]>([[UNGROUPED, []]])
  for (const p of params) {
    const g = p.group ?? UNGROUPED
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(p)
  }
  return [...groups].filter(([, ps]) => ps.length > 0)
}

const box = (b: { x: Range; y: Range; z: Range }): string => `x ${b.x.join('..')}  y ${b.y.join('..')}  z ${b.z.join('..')}`
const v3 = (v: readonly number[]): string => `(${v.join(', ')})`

function signalLines(s: CatalogSignal, verbose: boolean): string[] {
  const extra = [
    s.setpointFor ? `setpoint for ${s.setpointFor}` : null,
    s.commandsDevice ? 'commands the device' : null,
    s.onlyWhenDriven ? 'only while a program drives it' : null,
    s.values ? s.values.map((v) => `${v.value} = ${v.label}`).join(', ') : null,
  ]
    .filter(Boolean)
    .join(', ')
  const line = `    ${(s.dir ?? '?').padEnd(3)} ${(s.type ?? '?').padEnd(4)} ${s.name.padEnd(14)} ${s.label ?? ''}${extra ? `  (${extra})` : ''}`
  return verbose && s.desc ? [line, `${' '.repeat(28)}${s.desc}`] : [line]
}

function paramLines(p: CatalogParam, verbose: boolean): string[] {
  const c = paramConstraint(p)
  const flags = [p.hidden ? 'hidden' : null, p.visibleWhen ? `shown when ${p.visibleWhen.param} = ${formatValue(p.visibleWhen.is)}` : null].filter(Boolean).join(', ')
  const line = `    ${p.key.padEnd(18)} ${String(p.type).padEnd(10)} = ${formatValue(p.default, verbose ? 80 : 24).padEnd(verbose ? 12 : 24)} ${c ? `[${c}] ` : ''}${p.label ?? ''}${flags ? `  (${flags})` : ''}`
  return verbose && p.desc ? [line, `${' '.repeat(6)}${p.desc}`] : [line]
}

/** A summary shows the first few of a long list (a flex conveyor's sixteen zone eyes) and says how many more. */
const SUMMARY_LIST = 3

function capped<T>(xs: readonly T[], verbose: boolean, line: (x: T) => string, what: string, id: string): string[] {
  if (verbose || xs.length <= SUMMARY_LIST + 1) return xs.map(line)
  return [...xs.slice(0, SUMMARY_LIST).map(line), `  (+${xs.length - SUMMARY_LIST} more ${what}: npm run catalog -- ${id})`]
}

function frameLines(e: CatalogEntry, verbose: boolean): string[] {
  const out: string[] = []
  const f = e.frame
  const at = e.frameParams ? `at ${Object.entries(e.frameParams).map(([k, v]) => `${k}=${formatValue(v)}`).join(', ')}` : 'default params'
  if (f.footprint) out.push(`  footprint (m, part-local, ${at}): ${box(f.footprint)}`)
  if (f.origin) out.push(`  origin: x ${f.origin.x}, z ${f.origin.z}`)
  for (const end of f.ends ?? []) out.push(`  end ${end.end.padEnd(5)} at ${v3(end.at)} facing ${v3(end.out)} (x, z), ${end.faceWidth} m wide`)
  const zones = f.zones ?? []
  out.push(...capped(zones, verbose, (z) => `  zone  ${z.name}: ${box({ x: [z.min[0], z.max[0]], y: [z.min[1], z.max[1]], z: [z.min[2], z.max[2]] })}  (centre ${v3(z.centre)}, size ${v3(z.size)})`, 'zones', e.id))
  if (zones.length > 0) out.push('        a zone acts on a box as soon as the box CENTRE is inside it, on a belt or not: add the part position (rotationY = 0) for world')
  out.push(...capped(f.beams ?? [], verbose, (b) => `  beam  ${b.name}: from ${v3(b.origin)} along ${v3(b.dir)}, ${b.range} m`, 'beams', e.id))
  if (e.frameError) out.push(`  frame: could not compute (${e.frameError})`)
  return out
}

function headerLine(e: CatalogEntry): string {
  const tags = [e.category, e.geometry, e.conveyor ? `${e.conveyor.surface} conveyor` : null, e.snap ? `snaps: ${e.snap.join(', ')}` : null].filter(Boolean)
  return `${e.id}  ${e.name}  [${tags.join('; ')}]`
}

/** One part, either briefly (the summary) or in full (descs, hidden params, every frame fact). */
export function formatEntry(e: CatalogEntry, verbose: boolean): string[] {
  const out = [headerLine(e), ...frameLines(e, verbose)]
  if (e.signals.length > 0) {
    out.push('  PLC signals (tag name chosen at placement):')
    for (const s of e.signals) out.push(...signalLines(s, verbose))
  }
  const shown = e.params.filter((p) => p.type !== 'tag' && (verbose || !p.hidden))
  const hidden = e.params.filter((p) => p.type !== 'tag' && p.hidden && !verbose).length
  for (const [group, ps] of groupParams(shown)) {
    out.push(`  ${group === UNGROUPED ? 'params' : group}:`)
    for (const p of ps) out.push(...paramLines(p, verbose))
  }
  if (hidden > 0) out.push(`  (+${hidden} hidden param(s): npm run catalog -- ${e.id})`)
  return out
}
