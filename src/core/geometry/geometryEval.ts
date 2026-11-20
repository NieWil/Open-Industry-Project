// Core-side evaluator for the geometry-function tier (docs/procedural-geometry.md, Tier 2).
//
// The sim builds a part's `definePart({ geometry })` through src/sim/embeddedBehavior.ts, which reuses the
// behavior handle's already-captured `def` (no re-eval). Render may not import src/sim (an enforced layer
// boundary) and holds no behavior handle, but it must build the same procedural geometry. So must any headless
// caller (offscreen thumbnails, export, tests). This module is the home in `core/` that both can reach. It
// evaluates the part source once through the shared compile path in core/parts/partScript.ts (the same scan + shims +
// param resolution the sim uses), then runs the captured `geometry()` callback per resolved-param set with the
// shared GeometryBuilder. Same source, same compile path and the determinism guarantee give output byte-identical
// to the sim path.
//
// Geometry re-runs only on a param change, never per sim tick, so the eval cache keeps it cheap: the
// compile + determinism scan happen once per distinct script, and only `geometry()` (pure arithmetic over
// the params) re-runs when a length/segment/width param is edited.

import { createGeometryBuilder } from './geometryBuilder'
import { hostCopy } from '../hostCopy'
import type { GeometryContext, MeshDescription, MeshPart, ParamSchema, ParamValue, PartDefinition } from '../parts/partApi'
import { reportPartDiagnostic } from '../parts/partDiagnostics'
import { robotDeclOf } from '../robot/robotController'
import { robotToolParts } from '../robot/robotTools'
import { instantiatePartScript, resolvePartParams } from '../parts/partScript'

export { resolvePartParams } from '../parts/partScript'

/** Normalize a geometry() result to the MeshPart[] the host realizes: a bare description (a single-material
 *  part) becomes one role-less part; an array passes through. */
function toParts(out: MeshDescription | MeshPart[]): MeshPart[] {
  return canonicalMeshParts(Array.isArray(out) ? out : [{ desc: out }])
}

/**
 * The submeshes a `geometry()` returned, in the current spelling. Behavior code is stored verbatim in saved
 * documents and rooms, so a script written for an older package format keeps returning the old spelling forever;
 * no upgrade step can rewrite code safely. Every consumer of `geometry()` output passes through here (this
 * module and the portable boundary, sim/embeddedBehavior `geometry`), so the translation lives in one place and
 * the rest of the host reads one spelling. Format 4: `collision: 'static' | 'staticHull'` -> `'box' | 'hull'`, and
 * `role` -> `finish`, where a `role: 'guard'` collision box also becomes a `sideGuard` on the side its box sits
 * (the sign of its centre Z, the rule format 3 applied); `lamp` + `emissive` -> `lamps: [{ name, emissive }]` (the
 * emissive defaulted to white).
 */
export function canonicalMeshParts(parts: MeshPart[]): MeshPart[] {
  return parts.map((p) => {
    const c = (p as { collision?: unknown }).collision
    const role = (p as { role?: MeshPart['finish'] }).role
    const lamp = (p as { lamp?: unknown }).lamp
    if (c !== 'static' && c !== 'staticHull' && role === undefined && lamp === undefined) return p
    const next = { ...p } as MeshPart & { role?: unknown; lamp?: unknown; emissive?: unknown }
    delete next.role
    if (lamp !== undefined) {
      const e = next.emissive
      delete next.lamp
      delete next.emissive
      if (typeof lamp === 'string' && lamp !== '' && next.lamps === undefined) next.lamps = [{ name: lamp, emissive: Array.isArray(e) && e.length === 3 ? (e as [number, number, number]) : [1, 1, 1] }]
    }
    if (c === 'static') next.collision = 'box'
    if (c === 'staticHull') next.collision = 'hull'
    if (role !== undefined && next.finish === undefined) next.finish = role
    if (role === 'guard' && next.collision === 'box' && next.sideGuard === undefined) next.sideGuard = centreZ(p.desc.positions) < 0 ? 'left' : 'right'
    return next
  })
}

function centreZ(positions: ArrayLike<number>): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!
    if (z < lo) lo = z
    if (z > hi) hi = z
  }
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0
}

// Captured-def cache keyed by source string. Geometry defs are pure (no per-instance closure state), so one def
// per source serves every caller. A `null` entry caches a failure (non-deterministic / uncompilable / no
// definePart) so a bad source isn't re-evaluated. The behavior editor evaluates on every typing pause, so the
// cache is bounded, evicting the least recently used entry (a hit moves to the newest end), so the scene's own
// scripts outlive a long run of editor drafts.
const CAPTURED_MAX = 256
const captured = new Map<string, PartDefinition | null>()

function captureDef(source: string, ref?: PartDiagRef): PartDefinition | null {
  const hit = captured.get(source)
  if (hit !== undefined) {
    captured.delete(source)
    captured.set(source, hit)
    return hit
  }
  const { def, error } = instantiatePartScript(source)
  if (!def && ref) reportPartDiagnostic({ source: 'compile', message: error, ...ref })
  if (captured.size >= CAPTURED_MAX) captured.delete(captured.keys().next().value!)
  captured.set(source, def)
  return def
}

/** Who to attribute an eval failure to - threads the placed part / package identity into the runtime
 *  diagnostics channel (core/parts/partDiagnostics.ts). Omitted (tests, headless probes): failures stay silent. */
export interface PartDiagRef {
  partId?: string
  packageId?: string
}

/**
 * Realize a part's `geometry()` callback for the given resolved params (schema defaults already merged with
 * the instance overrides - see resolvePartParams) → a {@link MeshPart}[] (a bare {@link MeshDescription} is
 * normalized to one role-less part; empty parts are dropped), or `null` when the part declares no
 * `geometry()`, the source is non-deterministic / uncompilable, the call throws (a bad profile, or the vertex
 * budget - {@link GeometryBudgetError}), or it yields nothing. Pure + deterministic; safe to call on every
 * param change. Render realizes each part with its role's material; the sim builds collision from the same
 * data. Pass `ref` so a failure lands in the part-diagnostics channel instead of vanishing.
 *
 * `ctx` carries the host-resolved seam facts ({@link GeometryContext} - the resolved world-phase roller grid).
 * It is optional and defaults to empty. A caller with no placement to resolve (parity tests, headless probes, the
 * collision-side belt-role sniff) calls with three arguments and gets the placement-free geometry. Only the render
 * rig, which knows where the part sits, fills it in.
 */
export function evalPartGeometry(source: string, params: Record<string, ParamValue>, ref?: PartDiagRef, ctx?: GeometryContext): MeshPart[] | null {
  const def = captureDef(source, ref)
  if (!def) return null
  try {
    // a robot's tool is drawn by the host on the link its declaration names, after the part's own meshes
    const tool = robotDeclOf(def.robot)?.tool
    if (!def.geometry && !tool) return null
    // host-owned from here on: the render rig, collision walls and memos keep this, and the part must not be able
    // to change it after the fact or run code when it is read (hostCopy.ts, docs/part-sandbox.md)
    const out = def.geometry ? hostCopy(def.geometry(createGeometryBuilder(), params as Parameters<NonNullable<typeof def.geometry>>[1], ctx ?? {})) : []
    const toolParts = tool ? robotToolParts(createGeometryBuilder(), params, tool) : []
    // drop empty parts. That includes the retired render-only roller bank (`rollers` on an empty `desc`), so a
    // part that still returns one just draws no rollers
    const parts = [...toParts(out), ...toolParts].filter((p) => p?.desc && p.desc.positions.length > 0)
    return parts.length > 0 ? parts : null
  } catch (e) {
    // a runaway / malformed geometry function yields no mesh rather than crashing the host. The failure is
    // reported when attributed: the part renders its manifest fallback and the author sees why.
    if (ref) reportPartDiagnostic({ source: 'geometry', message: e instanceof Error ? e.message : String(e), ...ref })
    return null
  }
}

/** Does this part source draw procedural geometry at all: a `geometry()` callback, or a robot tool? (Cached compile - cheap.) Lets a host tell
 *  "no `geometry()` ever" (safe to latch the proc path off) from "`geometry()` emitted nothing for this param
 *  set" (a conditional emit - keep polling), which {@link evalPartGeometry} otherwise collapses to one `null`. */
export function partHasGeometry(source: string): boolean {
  const def = captureDef(source)
  if (!def) return false
  if (def.geometry != null) return true
  try {
    return robotDeclOf(def.robot)?.tool !== undefined
  } catch {
    return false
  }
}

/**
 * The meshes a part type can draw, for the questions asked of the type rather than of one placed part (its lamps,
 * whether it animates): at its default params, and for a robot under each tool its `tool` param offers, since an arm
 * with a hand of its own draws no tool at its defaults but carries the plate's lamp and cups once one is picked.
 */
function typeMeshParts(source: string, schema: ParamSchema | undefined): MeshPart[] {
  const defaults = resolvePartParams(schema, {})
  const out = [...(evalPartGeometry(source, defaults) ?? [])]
  const tool = schema?.tool
  let robotTool = false
  try {
    robotTool = robotDeclOf(captureDef(source)?.robot)?.tool !== undefined
  } catch {
    // an unreadable robot declaration draws no tool
  }
  if (robotTool && tool?.type === 'enum')
    for (const o of tool.options ?? []) if (o.value !== defaults.tool) out.push(...(evalPartGeometry(source, { ...defaults, tool: o.value }) ?? []))
  return out
}

/** the lamps a part's geometry() draws (MeshPart.lamps), at its default params and under each robot tool
 *  (typeMeshParts) - the code-built counterpart of a rig lamp link, so the name checks that ask "is this a lamp?"
 *  (rigLampNames) can count them. Empty without geometry(). */
export function geometryLampNames(source: string, schema?: ParamSchema): string[] {
  return [...new Set(typeMeshParts(source, schema).flatMap((p) => (p.lamps ?? []).map((l) => l.name)))]
}

/** does the part's geometry() animate - any submesh with a `scroll`, `spin` or `squash` channel, at its default
 *  params? The host builds its per-frame hook up front from this (the channels themselves arrive with the first
 *  refresh). */
export function geometryAnimates(source: string, schema?: ParamSchema): boolean {
  // A property of the part type (its script and schema), asked once per placed instance as each rig builds. Memoized
  // because evaluating geometry() is the costly part (re-showing the demo's 319 parts spent ~125 ms on it alone).
  // Keyed by the schema object, which a package keeps for its lifetime; an edited package brings a new one.
  let bySchema = animatesMemo.get(source)
  if (!bySchema) {
    if (animatesMemo.size >= ANIMATES_MEMO_MAX) animatesMemo.clear() // edited sources would otherwise pile up
    bySchema = new WeakMap()
    animatesMemo.set(source, bySchema)
  }
  const key = schema ?? NO_SCHEMA
  const hit = bySchema.get(key)
  if (hit !== undefined) return hit
  const animates = typeMeshParts(source, schema).some((p) => !!p.scroll || !!p.spin || !!p.squash)
  bySchema.set(key, animates)
  return animates
}
const animatesMemo = new Map<string, WeakMap<object, boolean>>()
const ANIMATES_MEMO_MAX = 256
const NO_SCHEMA = {}

/** the lamp names a part script declares (`definePart({ lamps })`) - empty if none or it will not compile */
export function partDeclaredLamps(source: string): readonly string[] {
  const lamps = hostCopy(captureDef(source)?.lamps)
  return Array.isArray(lamps) ? lamps.filter((l): l is string => typeof l === 'string') : []
}
