import { fitLoad, wrapAnchor } from './cargoWrap'
import type { WrapBody } from './cargoWrap'
import { hexToRgb, quatFromYXZ, quatToYXZ } from './math'
import { getPackage, registryRevision } from './parts/partRegistry'
import type { PartInstance } from './types'
import { BOX_FRICTION, PALLET_FRICTION, PALLET_SIZE, TOTE_FRICTION, TOTE_MASS } from './types'
import { PALLET_STANDARDS, palletStandardSize } from './pallet'
import { TOTE_FOOT_H, TOTE_STANDARDS, toteStandardSize } from './tote'
import { rotateXZ } from './transforms'
import type { CargoMarkValue, PartPackage, RigGeometry } from './parts/partPackage'
import { isCargoPackage, unitPiecesOf } from './parts/partPackage'
import type { ParamValue } from './parts/partApi'
import { resolvePartParams } from './parts/partScript'
import { cargoPieces, cargoPiecesBounds, cargoShapeKey } from './cargoBody'
import type { CargoPiece } from './cargoBody'
import type { RigParams, SubPose } from './rig/rigPose'

export const CARGO_KIND_BOX = 0
export const CARGO_KIND_PALLET = 1
export const CARGO_KIND_TOTE = 2
/** cargo with its own body (docs/cargo-bodies.md): a rig part declaring `cargo`, its collider and visual its own */
export const CARGO_KIND_PART = 3

/** what a cargo kind is called where people read or write it (probes, flow facts, `test-project --cargo`) */
export type CargoKindName = 'box' | 'pallet' | 'tote' | 'part'
/** the friction a cargo body of `kind` gets (core/types: BOX_FRICTION, PALLET_FRICTION, TOTE_FRICTION); a part's
 *  own body declares its friction instead ({@link CargoView.friction}) */
export const cargoFriction = (kind: number): number => (kind === CARGO_KIND_PALLET ? PALLET_FRICTION : kind === CARGO_KIND_TOTE ? TOTE_FRICTION : BOX_FRICTION)
/** the built-in cargo part a body of `kind` is when nothing says otherwise (a spawn by kind, not by part) */
export const cargoKindProduct = (kind: number): string => `oip.${cargoKindName(kind)}`
export const cargoKindName = (kind: number): CargoKindName =>
  kind === CARGO_KIND_PALLET ? 'pallet' : kind === CARGO_KIND_TOTE ? 'tote' : kind === CARGO_KIND_PART ? 'part' : 'box'

/**
 * What a cargo body is to the machines around it, as bits (core/parts/partPackage.ts CargoDecl): fork pockets (a fork's fit
 * check), heavy (it bears loads: a firmer solver island, never a dropped/tipped fact), load base (where wrapping starts and what
 * anchors a unit load), separate contacts (no manifold reduction). The engine asks these, never which kind or part a
 * body is (docs/part-libraries.md, "App code names capabilities, not parts").
 */
export const CARGO_CAP_FORK_POCKETS = 1
export const CARGO_CAP_HEAVY = 2
export const CARGO_CAP_LOAD_BASE = 4
export const CARGO_CAP_SEPARATE_CONTACTS = 8

/** A stable key for what a body is: its product and the params it was made with (sorted, so the same params match). */
export function cargoRefKey(packageId: string, params: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined).sort()
  return `${packageId}|${JSON.stringify(keys.map((k) => [k, params[k]]))}`
}

/**
 * What a kind-only spawn is (ctx.spawn({ kind }), kept so stored part versions keep spawning): the built-in part of its
 * kind, a tote or pallet at the standard its size snapped to (core/tote.ts toteSizeOf, core/pallet.ts palletFootprint),
 * a box at its own size. Within 6 mm, the snap's tolerance; a size no standard has is a box of that size. Selecting the
 * body makes it this part (editor/controller/liveCargo.ts promotedAs).
 */
export function kindSpawnRef(kind: number, size: readonly [number, number, number]): CargoShapeRef {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.006
  const [l, h, w] = size
  if (kind === CARGO_KIND_TOTE) {
    const std = TOTE_STANDARDS.find((t) => near(t.length, l) && near(t.height, h) && near(t.width, w))
    if (std) return { packageId: cargoKindProduct(kind), params: { size: std.value } }
  } else if (kind === CARGO_KIND_PALLET) {
    const std = PALLET_STANDARDS.find((p) => near(p.length, l) && near(p.width, w))
    if (std) return { packageId: cargoKindProduct(kind), params: { size: std.value } }
  }
  return { packageId: cargoKindProduct(CARGO_KIND_BOX), params: { length: l, height: h, width: w } }
}

/** The capabilities a body of `kind` has when its part declares none: what a box, pallet or tote always had. */
export function capsOfKind(kind: number): number {
  if (kind === CARGO_KIND_PALLET) return CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE
  if (kind === CARGO_KIND_TOTE) return CARGO_CAP_SEPARATE_CONTACTS
  return 0
}

/** Has the body at row `i` of a frame this capability? A frame built without `caps` (a test's) reads its kind's. */
export const frameHasCap = (frame: Pick<BoxFrame, 'kinds' | 'caps'>, i: number, cap: number): boolean => ((frame.caps?.[i] ?? capsOfKind(frame.kinds[i]!)) & cap) !== 0

/**
 * A cargo package's capabilities and nest depth: what its `cargo` declaration says, else what its kind always had (a
 * stored box, pallet or tote, which declares nothing, keeps behaving as it always has).
 */
export function cargoCapsOf(pkg: Pick<PartPackage, 'geometry' | 'cargo'>): { caps: number; nestDepth?: number } {
  const d = pkg.cargo
  const declared = d !== undefined && (d.forkPockets !== undefined || d.heavy !== undefined || d.loadBase !== undefined || d.separateContacts !== undefined || d.nestDepth !== undefined)
  if (!declared) {
    const g = pkg.geometry
    const kind = g.kind === 'cargo' ? (g.cargoKind === 'pallet' ? CARGO_KIND_PALLET : g.cargoKind === 'tote' ? CARGO_KIND_TOTE : CARGO_KIND_BOX) : CARGO_KIND_PART
    return kind === CARGO_KIND_TOTE ? { caps: capsOfKind(kind), nestDepth: TOTE_FOOT_H } : { caps: capsOfKind(kind) }
  }
  const caps =
    (d.forkPockets ? CARGO_CAP_FORK_POCKETS : 0) | (d.heavy ? CARGO_CAP_HEAVY : 0) | (d.loadBase ? CARGO_CAP_LOAD_BASE : 0) | (d.separateContacts ? CARGO_CAP_SEPARATE_CONTACTS : 0)
  return d.nestDepth !== undefined ? { caps, nestDepth: d.nestDepth } : { caps }
}

/** The dynamic-cargo facts of a cargo part - see {@link cargoView}. */
export interface CargoView {
  /** CARGO_KIND_BOX | CARGO_KIND_PALLET | CARGO_KIND_TOTE - picks the batch geometry + the body friction */
  kind: number
  /** body half-extents, m (centre origin, like the built-in box/pallet) */
  halfExtents: [number, number, number]
  /** #rrggbb tint */
  color: string
  /** kg */
  mass: number
  /** its product attributes (params flagged `attribute`) as authored: the marks it starts a run with */
  attributes: Record<string, CargoMarkValue>
  /** each attribute's kind, which a machine's mark of it must match */
  attributeTypes: Record<string, 'boolean' | 'number' | 'string'>
  /** a part's own body (kind CARGO_KIND_PART): its collider pieces, the key one collider and one batch are shared by,
   *  and its declared friction (core/cargoBody.ts) */
  body?: { key: string; pieces: CargoPiece[]; friction: number; params: Record<string, ParamValue> }
  /** CARGO_CAP_* bits ({@link cargoCapsOf}) */
  caps: number
  /** how far a body of its shape set on it sits lower than its height (a stacking tote's foot), if it nests */
  nestDepth?: number
}

/** a package's product attributes as they stand on one instance (param flagged `attribute`, else its default) */
export function productAttributes(
  pkg: { params: Record<string, { type: string; default?: unknown; attribute?: boolean }> },
  params: Readonly<Record<string, unknown>>,
): { values: Record<string, CargoMarkValue>; types: Record<string, 'boolean' | 'number' | 'string'> } {
  const values: Record<string, CargoMarkValue> = {}
  const types: Record<string, 'boolean' | 'number' | 'string'> = {}
  for (const [key, spec] of Object.entries(pkg.params)) {
    if (!spec.attribute || (spec.type !== 'boolean' && spec.type !== 'number' && spec.type !== 'string')) continue
    const v = params[key] ?? spec.default
    types[key] = spec.type
    if (typeof v === spec.type) values[key] = v as CargoMarkValue
  }
  return { values, types }
}

/** How an authored unit load (a part whose package declares `unit`) starts a run, resolved from its params. */
export interface UnitStart {
  /** one rigid body from the first step */
  join: boolean
  /** its product attributes: the load's marks */
  marks: Record<string, CargoMarkValue>
  types: Record<string, 'boolean' | 'number' | 'string'>
  /** dressings round the whole load, colour resolved (linear rgb) */
  dress: { id: string; color: [number, number, number]; opacity: number }[]
}

/** an sRGB `#rrggbb` as linear rgb (what a material colour is) */
function srgbHexToLinear(hex: string): [number, number, number] {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = hexToRgb(hex)
  return [lin(r), lin(g), lin(b)]
}

/** A part's unit-load start state, or null when it is not a unit load (its package declares no `unit`). */
export function unitStart(part: PartInstance): UnitStart | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  const decl = pkg?.unit
  if (!pkg || !decl) return null
  const param = (k: string): unknown => part.params[k] ?? pkg.params[k]?.default
  const on = (k: string | undefined): boolean => k === undefined || param(k) === true
  const attrs = productAttributes(pkg, part.params)
  const dress: UnitStart['dress'] = []
  for (const d of decl.dress ?? []) {
    if (!on(d.when)) continue
    const hex = d.colorParam !== undefined ? param(d.colorParam) : undefined
    const mat = pkg.materials?.find((m) => m.id === d.material)
    const color: [number, number, number] = typeof hex === 'string' ? srgbHexToLinear(hex) : mat?.color ? [mat.color[0], mat.color[1], mat.color[2]] : [0.8, 0.8, 0.8]
    const op = d.opacityParam !== undefined ? param(d.opacityParam) : undefined
    const opacity = typeof op === 'number' ? Math.min(1, Math.max(0.05, op)) : DEFAULT_DRESS_OPACITY
    dress.push({ id: d.id, color, opacity })
  }
  return { join: on(decl.joinWhen), marks: attrs.values, types: attrs.types, dress }
}

/** parent id → its children in scene order, so several {@link unitMembers} walks over one part list share one index */
export type PartChildren = ReadonlyMap<string, readonly PartInstance[]>

export function partChildren(parts: readonly PartInstance[]): PartChildren {
  const kids = new Map<string, PartInstance[]>()
  for (const p of parts) {
    if (p.parent === undefined) continue
    let list = kids.get(p.parent)
    if (!list) kids.set(p.parent, (list = []))
    list.push(p)
  }
  return kids
}

/** The cargo parts an authored unit load holds: its descendants in the scene that are cargo. Membership is exactly
 *  that; nothing standing nearby joins. A caller walking many loads passes `kids` ({@link partChildren}) built once,
 *  or each walk re-indexes every part. */
export function unitMembers(parts: readonly PartInstance[], unitId: string, kids: PartChildren = partChildren(parts)): PartInstance[] {
  const out: PartInstance[] = []
  const seen = new Set<string>([unitId])
  const walk = (id: string): void => {
    for (const k of kids.get(id) ?? []) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      if (cargoView(k)) out.push(k)
      walk(k.id)
    }
  }
  walk(unitId)
  return out
}

/**
 * The standard layer a unit load stacks for itself: a 0.6 x 0.4 case on a 1.22 x 1.02 (48 x 40 in) pallet, a row of two laid
 * straight beside a row of three turned, 1.2 x 1.0 of case. Case centres relative to the load centre. It is the demo
 * line's LAYER_PATTERN (demoScenes.test.ts pins the two together), so a load the palletizer built and one a unit load
 * stacked read the same.
 */
export const UNIT_LAYER: readonly { dx: number; dz: number; turned: boolean }[] = [
  { dx: -0.3, dz: 0.3, turned: false }, { dx: 0.3, dz: 0.3, turned: false },
  { dx: -0.4, dz: -0.2, turned: true }, { dx: 0, dz: -0.2, turned: true }, { dx: 0.4, dz: -0.2, turned: true },
]
/** the case the standard layer is made of (length x height x width, m) */
export const UNIT_CASE: readonly [number, number, number] = [0.6, 0.4, 0.4]
/** 1.2 m of case on a 1.22 m pallet: the load stands 13 mm off the pallet centre in x */
const UNIT_LOAD_DX = 0.013

/**
 * The pieces of a unit load that stacks its own load: a pallet and `courses` courses of the standard layer, each course
 * turned a half-turn on the one below. Empty unless the part is a unit load (package `unit`) with a `courses` param
 * above 0 and NO cargo filed under it, because filed cargo is the load whenever there is any (unitMembers).
 *
 * The pieces are the load's own, authored by its params: nothing is inferred and nothing is saved per piece. Each is a
 * cargo instance at its world pose (id `<load>#<n>`, never a scene part), which is what lets the stopped view and the
 * sim build them through the one cargo recognizer (cargoView) exactly as they build a filed pallet and its cases.
 */
export function unitPieces(parts: readonly PartInstance[], unit: PartInstance, kids?: PartChildren): PartInstance[] {
  if (unit.type !== 'part') return []
  const pkg = getPackage(unit.packageId)
  const pieces = pkg ? unitPiecesOf(pkg) : undefined
  if (!pkg || !pieces) return []
  const cv = unit.params.courses ?? pkg.params.courses?.default
  const courses = typeof cv === 'number' ? Math.min(8, Math.max(0, Math.round(cv))) : 0
  if (courses === 0 || unitMembers(parts, unit.id, kids).length > 0) return []
  const col = unit.params.caseColor ?? pkg.params.caseColor?.default
  const caseColor = typeof col === 'string' ? col : '#ffffff'
  const uq = partQuat(unit)
  const out: PartInstance[] = []
  const add = (packageId: string, local: [number, number, number], yaw: number, params: Record<string, unknown>): void => {
    const [ox, oy, oz] = rotateByQuat(uq, local)
    const [rx, ry, rz] = quatToYXZ(...quatMul(uq, quatFromYXZ(0, yaw, 0)))
    out.push({
      id: `${unit.id}#${out.length}`,
      type: 'part',
      packageId,
      name: packageId === pieces.pallet ? 'Pallet' : 'Box',
      position: [unit.position[0] + ox, unit.position[1] + oy, unit.position[2] + oz],
      rotationX: rx,
      rotationY: ry,
      rotationZ: rz,
      params,
    } as PartInstance)
  }
  add(pieces.pallet, [0, PALLET_SIZE[1] / 2, 0], 0, {})
  for (let c = 0; c < courses; c++) {
    const flip = c % 2 === 1 ? -1 : 1
    for (const { dx, dz, turned } of UNIT_LAYER) {
      const turns = (turned ? -1 : 0) + (flip < 0 ? 2 : 0)
      add(pieces.case, [UNIT_LOAD_DX + flip * dx, PALLET_SIZE[1] + UNIT_CASE[1] * (c + 0.5), flip * dz], turns * (Math.PI / 2), {
        length: UNIT_CASE[0], height: UNIT_CASE[1], width: UNIT_CASE[2], color: caseColor,
      })
    }
  }
  return out
}

/** q1 * q2, (x, y, z, w) */
function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number]
  const [bx, by, bz, bw] = b as [number, number, number, number]
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/** v rotated by the unit quaternion q */
function rotateByQuat(q: readonly number[], v: readonly [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = q as [number, number, number, number]
  const [vx, vy, vz] = v
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)]
}

/** the see-through-ness a dressing gets when its spec names none: film */
export const DEFAULT_DRESS_OPACITY = 0.42

/**
 * Resolve a part's dynamic-cargo facts, or null when the part isn't cargo. One shared recognizer: the sim
 * (dynamic body), the idle frame (below), the view (batch render / hidden scene stub / proxy pick) and the
 * controller (live-cargo drag) must all agree on what is cargo. Cargo is a custom part whose package declares
 * `geometry.kind: 'cargo'`
 * (C-cargo, docs/architecture.md): it reads length/height/width for a box, the `size` footprint for a pallet and the
 * `size` standard for a tote (mass/color for all), falling back to the schema defaults, then the package's baked bounds / the default pallet.
 */
export function cargoView(part: PartInstance): CargoView | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (pkg?.cargo && pkg.geometry.kind === 'rig') return partCargoView(part.packageId, pkg, pkg.geometry, part.params)
  if (!pkg || pkg.geometry.kind !== 'cargo') return null
  const what = cargoCapsOf(pkg)
  // instance param → schema default → fallback (an instance may carry sparse overrides)
  const num = (key: string, fb: number): number => {
    const v = part.params[key] ?? pkg.params[key]?.default
    return typeof v === 'number' && v > 0 ? v : fb
  }
  const cv = part.params.color ?? pkg.params.color?.default
  const color = typeof cv === 'string' ? cv : '#ffffff'
  const attrs = productAttributes(pkg, part.params)
  if (pkg.geometry.cargoKind === 'pallet') {
    const size = palletStandardSize(part.params.size ?? pkg.params.size?.default)
    return { kind: CARGO_KIND_PALLET, halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2], color, mass: num('mass', 20), attributes: attrs.values, attributeTypes: attrs.types, ...what }
  }
  if (pkg.geometry.cargoKind === 'tote') {
    const size = toteStandardSize(part.params.size ?? pkg.params.size?.default)
    return { kind: CARGO_KIND_TOTE, halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2], color, mass: num('mass', TOTE_MASS), attributes: attrs.values, attributeTypes: attrs.types, ...what }
  }
  const b = pkg.geometry.size
  return { kind: CARGO_KIND_BOX, halfExtents: [num('length', b.length) / 2, num('height', b.height) / 2, num('width', b.width) / 2], color, mass: num('mass', 10), attributes: attrs.values, attributeTypes: attrs.types, ...what }
}

/**
 * The cargo facts of a part with its own body (a rig declaring `cargo`, docs/cargo-bodies.md): its collider pieces at
 * these params, their bounds as the half extents every box-shaped consumer reads (sensing, wrapping, placement), and
 * mass and colour from the params the declaration names. Null when the rig has no colliding link.
 */
export function partCargoView(packageId: string, pkg: PartPackage, geo: RigGeometry, params: Record<string, ParamValue | undefined>): CargoView | null {
  const decl = pkg.cargo ?? {}
  const resolved = resolvePartParams(pkg.params, params as Record<string, ParamValue>) as Record<string, unknown>
  const pieces = cargoPieces(geo, resolved as RigParams, resolved)
  const bounds = cargoPiecesBounds(pieces)
  if (!bounds) return null
  const half: [number, number, number] = [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2, (bounds.max[2] - bounds.min[2]) / 2]
  const mass = resolved[decl.massParam ?? 'mass']
  const color = resolved[decl.colorParam ?? 'color']
  const attrs = productAttributes(pkg, params)
  return {
    kind: CARGO_KIND_PART,
    halfExtents: half,
    color: typeof color === 'string' ? color : '#ffffff',
    mass: typeof mass === 'number' && mass > 0 ? mass : 10,
    attributes: attrs.values,
    attributeTypes: attrs.types,
    body: { key: cargoShapeKey(packageId, pieces), pieces, friction: decl.friction ?? BOX_FRICTION, params: resolved as Record<string, ParamValue> },
    ...cargoCapsOf(pkg),
  }
}

/** true when the part is dynamic cargo (built-in box/pallet or a C-cargo custom part) - see {@link cargoView} */
export const isCargoPart = (part: PartInstance): boolean => cargoView(part) !== null

/**
 * Where a nesting body set down on another of its shape comes to rest: its foot inside the lower one's rim, its ledge
 * on that rim, centred on it (a stacking tote, core/tote.ts; any cargo declaring `nestDepth`). Null unless both are
 * the same shape (the same kind and size, or the same part body), the host nests, the mover is square to the host
 * (its yaw within 5 degrees of the host's, either way round) and both level, which is when a real stack locates
 * itself. Placement uses it so a stacked body is placed where the sim will put it, not a foot's height above.
 */
export function cargoSeatOn(mover: PartInstance, host: PartInstance): [number, number, number] | null {
  const a = cargoView(mover)
  const b = cargoView(host)
  if (!a || !b || b.nestDepth === undefined || a.kind !== b.kind || a.body?.key !== b.body?.key) return null
  if (a.halfExtents.some((h, k) => Math.abs(h - b.halfExtents[k]!) > 0.0005)) return null
  const level = (p: PartInstance): boolean => Math.abs(p.rotationX ?? 0) < 1e-3 && Math.abs(p.rotationZ ?? 0) < 1e-3
  if (!level(host) || !level(mover)) return null
  const turn = Math.abs(((mover.rotationY - host.rotationY) % Math.PI) + Math.PI) % Math.PI
  if (Math.min(turn, Math.PI - turn) > (5 * Math.PI) / 180) return null
  return [host.position[0], host.position[1] + b.halfExtents[1] + a.halfExtents[1] - b.nestDepth, host.position[2]]
}

/**
 * The fields a cargo part's pose lives in. While the sim runs, physics owns them: moving, rotating or freezing
 * a box mid-run is operating the line, not authoring it, and Stop puts the box back where it was placed. The
 * box's other fields (its params, its parent, whether it exists) stay authoring. See docs/document-and-run.md;
 * the editor store and the collab bridge both draw the line here.
 */
export type CargoPose = Pick<PartInstance, 'position' | 'rotationY' | 'rotationX' | 'rotationZ'>
const POSE_KEYS: ReadonlySet<string> = new Set(['position', 'rotationY', 'rotationX', 'rotationZ'])

/** a part's pose fields (the optional tilts only when present) */
export function cargoPoseOf(p: PartInstance): CargoPose {
  const pose: CargoPose = { position: p.position, rotationY: p.rotationY }
  if (p.rotationX !== undefined) pose.rotationX = p.rotationX
  if (p.rotationZ !== undefined) pose.rotationZ = p.rotationZ
  return pose
}

/** the same pose, by value (an absent tilt only matches an absent tilt) */
export function sameCargoPose(a: CargoPose, b: CargoPose): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.rotationY === b.rotationY &&
    a.rotationX === b.rotationX &&
    a.rotationZ === b.rotationZ
  )
}

/** `p` wearing `pose` (an absent tilt removed); `p` itself when it already does, so unchanged parts keep their identity */
export function withCargoPose<T extends PartInstance>(p: T, pose: CargoPose): T {
  if (sameCargoPose(p, pose)) return p
  const next = { ...p, position: pose.position, rotationY: pose.rotationY }
  if (pose.rotationX === undefined) delete next.rotationX
  else next.rotationX = pose.rotationX
  if (pose.rotationZ === undefined) delete next.rotationZ
  else next.rotationZ = pose.rotationZ
  return next
}

/**
 * `pose` carried by the rigid planar motion that took an ancestor from `a0` to `a1` - how a placed box's designed
 * pose follows a group moved mid-run (the move is layout authoring; the box is carried, not operated). Translate +
 * yaw, like every soft-parent carry (core/transforms; the editor's group rotate is `yawAboutPivot` + `rotationY +
 * yaw`): for any rigid motion, x' = a1 + R(Δyaw)(x − a0). Tilt is not carried (planar authoring never tilts a group).
 */
export function carryCargoPose(pose: CargoPose, a0: PartInstance, a1: PartInstance): CargoPose {
  const d = a1.rotationY - a0.rotationY
  const r = rotateXZ(pose.position[0] - a0.position[0], pose.position[2] - a0.position[2], d)
  const yaw = pose.rotationY + d
  return {
    ...pose,
    position: [a1.position[0] + r.x, pose.position[1] + (a1.position[1] - a0.position[1]), a1.position[2] + r.z],
    rotationY: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
  }
}

/**
 * The nearest ancestor of `id` that moved between `before` and `after` and is not itself a placed box (a group, a
 * conveyor) - the part whose move carried it - or null when the part moved on its own. `skip` names ancestors whose
 * own moves don't count (other placed boxes, run-owned parts: moving those is operating).
 */
export function carryingAncestor(
  id: string,
  beforeById: ReadonlyMap<string, PartInstance>,
  afterById: ReadonlyMap<string, PartInstance>,
  skip: (id: string) => boolean,
): { before: PartInstance; after: PartInstance } | null {
  // the parent chain in `afterById`, nearest first as hierarchy's ancestorIds walks it, without rebuilding a
  // whole-scene map per moved box
  const seen = new Set<string>([id])
  for (let anc = afterById.get(id)?.parent; anc !== undefined && !seen.has(anc); anc = afterById.get(anc)?.parent) {
    seen.add(anc)
    if (skip(anc)) continue
    const a0 = beforeById.get(anc)
    const a1 = afterById.get(anc)
    if (a0 && a1 && !sameCargoPose(cargoPoseOf(a0), cargoPoseOf(a1))) return { before: a0, after: a1 }
  }
  return null
}

/** do `a` and `b` differ in nothing but their pose - every other field the same value by reference? */
export function differOnlyInPose(a: PartInstance, b: PartInstance): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (POSE_KEYS.has(k)) continue
    if ((a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false
  }
  return true
}

/** One sensor beam's nearest-cargo result for a step - the worker's castBeam output (the same query that
 *  feeds ctx.sense), carried per beam link in {@link BoxFrame.beamHits}. color is sRGB 0..1 (the hit body's
 *  tint), meaningful only when hit. */
export interface FrameBeamHit {
  hit: boolean
  distance: number
  color: [number, number, number]
  /** the marks machines left on what it hit (ctx.mark), when there are any */
  marks?: Readonly<Record<string, CargoMarkValue>>
}

/** A dressing on one load (ctx.dress, core/cargoWrap): an open-ended box in the frame of the anchor body (the
 *  pallet the load stands on), so it rides that body wherever it goes. `min`/`max` are anchor-local metres. */
export interface FrameDressing {
  /** the anchor's id in {@link BoxFrame.ids} */
  anchor: number
  /** the dressing's name on the load ('film', 'label', ...) */
  id: string
  min: [number, number, number]
  max: [number, number, number]
  /** Linear rgb, from the material of the package that dressed it */
  color: [number, number, number]
  opacity: number
  /** the film web this frame, in world metres: a vertical sheet from the roll (`from`, plan x/z) to the corner of the
   *  load it leaves from (`to`), between heights `y0` and `y1`. Present only while a wrapper is wrapping. */
  web?: { from: [number, number]; to: [number, number]; y0: number; y1: number }
}

/** how many bodies, and their summed age (sim s), a zone held of one product or kind */
export interface ZoneTally {
  n: number
  age: number
}
/** a zone's contents by product (package id) and by kind name ('box' | 'pallet' | 'tote'), for ctx.zone's filter */
export interface ZoneMix {
  products: Record<string, ZoneTally>
  kinds: Record<string, ZoneTally>
}

/** per-step snapshot of all live dynamic cargo, produced by sim, consumed by render */
export interface BoxFrame {
  count: number
  /** length count; stable per-body ids */
  ids: Uint32Array
  /** 3*count, world m */
  positions: Float32Array
  /** 4*count, (x, y, z, w) */
  quats: Float32Array
  /** 3*count, m */
  halfExtents: Float32Array
  /** 3*count, sRGB 0..1 tint per body (authored color, white for spawner boxes) */
  colors: Float32Array
  /** length count; CARGO_KIND_* per body */
  kinds: Uint8Array
  /** length count; CARGO_CAP_* bits per body ({@link cargoCapsOf}). Absent in a frame built without them (a test's):
   *  {@link frameHasCap} then reads each body's kind's. */
  caps?: Uint8Array
  /** length count; scene part id for authored/promoted cargo, null for transient spawner boxes. Read-only: the sim
   *  client hands the same array to consecutive frames while it is unchanged (sim/frameWire.ts), so an in-place
   *  edit would corrupt every later frame. Copy it if you need to change it. */
  partIds: readonly (string | null)[]
  /** s since Run */
  simTime: number
  /** per-part rig joint commands this step (partId → {jointName: value}); the view animates rig visuals. Absent when no rig part commanded a joint. */
  joints?: Record<string, Record<string, number>>
  /** per-part rig setSubPose overrides this step (partId → {linkName: {position?, rotation?}}). Absent when none. */
  subPoses?: Record<string, Record<string, SubPose>>
  /** per-part conveying-copy belt speeds this step (partId -> {link: speed per copy, m/s}), for the view to run each
   *  copy's belt; present for every part with conveying copies, an empty map when none ran. Absent when no part has any. */
  copySpeeds?: Record<string, Record<string, number[]>>
  /** per-part rig emissive lamp states this step (partId → {lampName: on}); the view lights rig visuals. Absent when no rig part lit a lamp. */
  lamps?: Record<string, Record<string, boolean>>
  /** Effective param values each behavior reported this step (ctx.report), keyed by part id then param
   *  name - what the part is actually using, as opposed to the authored param. The Inspector reads out
   *  this while a param is tag-owned. Absent when no behavior reported anything. */
  values?: Record<string, Record<string, number | boolean>>
  /** Named display values each behavior published this step (ctx.display), keyed by part id then display
   *  name - what this part's own screens/labels show. Distinct from `values` (which are effective param
   *  values the Inspector reads out) and from `tags` (signals on the PLC wire): a display is text on a face,
   *  so it may be a string, and a name that stops being published goes blank rather than stale. Absent when
   *  no behavior published anything. */
  displays?: Record<string, Record<string, number | boolean | string>>
  /** PLC tags a custom part wrote this step (partId → {tagName: value}); the controller feeds them to the ST
   *  program as inputs (the part→PLC half of the device-IO bus). Absent when no behavior wrote a tag. */
  tags?: Record<string, Record<string, number | boolean>>
  /** live root pose of any mobile part that drove its base this step (ctx.drive), partId → {pos, yaw}; the view
   *  moves the part visual's root so an AGV navigates. The saved scene pose is unchanged. Absent when none moved. */
  basePoses?: Record<string, { pos: [number, number, number]; yaw: number }>
  /** Effective speed each conveying custom-part behavior commanded this step (partId → the value recorded for
   *  the spawner interlock: linear m/s, or arc omega rad/s for a curved conveyor). The view routes it to the
   *  part visual so the belt-fabric scroll / roller spin follows the PLC-commanded speed (a tag-stopped belt
   *  stops scrolling), not the saved `speed` param. Absent when no conveying behavior ran. */
  conveyorSpeeds?: Record<string, number>
  /** sensor-beam results this step (partId → {beamLinkName: hit}) - the worker's castBeam output, the same
   *  query that fed each behavior's ctx.sense, so the view draws beams from sim truth instead of re-casting
   *  on the main thread (the visual can never disagree with the tag the PLC read). Absent when no sensing
   *  behavior ran. */
  beamHits?: Record<string, Record<string, FrameBeamHit>>
  /** dressings on loads, each riding its anchor body (see {@link FrameDressing}). Absent when nothing is dressed. */
  dressings?: readonly Readonly<FrameDressing>[] // read-only for the same reason as partIds: entries are shared across frames
  /** the live marks (product state) on each authored product, by scene part id: its attributes as machines have
   *  left them. The Inspector reads a product's attributes out of this while the scene runs. Absent when none. */
  marks?: Record<string, Record<string, CargoMarkValue>>
  /** length count; what each body is, as a key into `shapeRefs` ({@link cargoRefKey}; for a part with its own body,
   *  kind CARGO_KIND_PART, its shape key, core/cargoBody.ts cargoShapeKey), null for a body made as no product.
   *  Absent when no body has one. Read-only, shared across frames like partIds. */
  shapes?: readonly (string | null)[]
  /** what each key in `shapes` is: the product and params it was made from, so the view draws a part's own visual and
   *  the editor makes a selected spawned body that part. Every key this run has used, not only this frame's. */
  shapeRefs?: Readonly<Record<string, CargoShapeRef>>
}

/** A cargo body's own shape, as the view draws it: the part it is and the params it was made with. */
export interface CargoShapeRef {
  packageId: string
  params: Readonly<Record<string, ParamValue>>
}

// Stable per-partId numeric ids for the idle authored-cargo frame, so a cargo body keeps
// the same BoxFrame id across rebuilds (used by selection tracking + the pick frameId).
// Idle and the sim never feed SimBoxes at the same time, so overlap with sim body ids is moot.
const authoredCargoIds = new Map<string, number>()
let nextAuthoredCargoId = 1
function authoredCargoId(partId: string): number {
  let id = authoredCargoIds.get(partId)
  if (id === undefined) {
    id = nextAuthoredCargoId++
    authoredCargoIds.set(partId, id)
  }
  return id
}

// Quaternion (x,y,z,w) from a part's full (rotationX, rotationY, rotationZ) Euler in
// YXZ order - mirrors render/parts/common.ts applyPartRotation, so an authored (possibly
// tilted) cargo renders identically whether drawn per-part or through the instanced batch.
// (The running sim is yaw-only, as today; this matches the idle/authored render, not the sim.)
function writeCargoQuat(part: PartInstance, out: Float32Array, o: number): void {
  const q = partQuat(part)
  out[o] = q[0]
  out[o + 1] = q[1]
  out[o + 2] = q[2]
  out[o + 3] = q[3]
}

/** a part's full orientation quaternion (x, y, z, w) from its YXZ rotation fields */
export function partQuat(part: PartInstance): [number, number, number, number] {
  return quatFromYXZ(part.rotationX ?? 0, part.rotationY, part.rotationZ ?? 0)
}

/**
 * A BoxFrame built straight from the scene's authored box/pallet parts (no sim), so the
 * idle editor renders cargo through the same instanced SimBoxes batch the running sim feeds
 * - instead of one GLB mesh per part. Unclamped: every authored cargo part is
 * carried (the render batch grows its instance buffers on demand - SimBoxes.ensureCapacity -
 * and the sim does not cap cargo either).
 * simTime 0; every partId is set (there are no transient spawner boxes while idle).
 */
export function buildAuthoredCargoFrame(parts: readonly PartInstance[]): BoxFrame {
  // one recognizer for what IS cargo (built-in box/pallet + C-cargo custom parts) - see cargoView
  // `owner` is the unit load a self-stacked piece belongs to (unitPieces): its row is picked and selected as the load
  const cargo: { part: PartInstance; view: CargoView; owner?: string }[] = []
  // built on the first unit load, then shared by every load's member walk here and in unitDressings
  let kids: PartChildren | undefined
  for (const p of parts) {
    const view = cargoView(p)
    if (view) cargo.push({ part: p, view })
    else if (p.type === 'part' && getPackage(p.packageId)?.unit) {
      kids ??= partChildren(parts)
      for (const piece of unitPieces(parts, p, kids)) {
        const pv = cargoView(piece)
        if (pv) cargo.push({ part: piece, view: pv, owner: p.id })
      }
    }
  }
  const count = cargo.length
  const ids = new Uint32Array(count)
  const positions = new Float32Array(count * 3)
  const quats = new Float32Array(count * 4)
  const halfExtents = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const kinds = new Uint8Array(count)
  const caps = new Uint8Array(count)
  const partIds: (string | null)[] = new Array(count).fill(null) // filled, not holey (see geometryShapes transformDescription)
  // a body with its own shape (core/cargoBody.ts): its key, and what the key is, for the view's batch
  let shapes: (string | null)[] | undefined
  let shapeRefs: Record<string, CargoShapeRef> | undefined
  for (let i = 0; i < count; i++) {
    const { part, view, owner } = cargo[i]!
    if (part.type === 'part') {
      const key = view.body ? view.body.key : cargoRefKey(part.packageId, part.params)
      shapes ??= new Array<string | null>(count).fill(null)
      shapes[i] = key
      ;(shapeRefs ??= {})[key] ??= { packageId: part.packageId, params: view.body ? view.body.params : (part.params as Record<string, ParamValue>) }
    }
    const p3 = i * 3
    ids[i] = authoredCargoId(part.id)
    partIds[i] = owner ?? part.id
    positions[p3] = part.position[0]
    positions[p3 + 1] = part.position[1]
    positions[p3 + 2] = part.position[2]
    writeCargoQuat(part, quats, i * 4)
    kinds[i] = view.kind
    caps[i] = view.caps
    halfExtents[p3] = view.halfExtents[0]
    halfExtents[p3 + 1] = view.halfExtents[1]
    halfExtents[p3 + 2] = view.halfExtents[2]
    const [r, g, b] = hexToRgb(view.color)
    colors[p3] = r
    colors[p3 + 1] = g
    colors[p3 + 2] = b
  }
  const dressings = unitDressings(parts, { count, ids, positions, quats, halfExtents, kinds, caps, partIds }, kids)
  return { count, ids, positions, quats, halfExtents, colors, kinds, caps, partIds, simTime: 0, ...(dressings.length ? { dressings } : {}), ...(shapes && shapeRefs ? { shapes, shapeRefs } : {}) }
}

/**
 * {@link buildAuthoredCargoFrame} memoized on what it reads: the cargo parts and unit loads (by reference, in order, as
 * memoParts.ts keys a derivation), every other part's parent edge (unitMembers walks descendants through non-cargo
 * parts), and the package registry. A streamed edit of anything else (a robot's tool-size drag) reuses the frame: the
 * stopped editor builds it on every scene change, and on the demo two builds cost ~10 ms per pointer-move. One memo
 * per caller, since callers pass different part lists (the view drops hidden cargo). The frame is shared across
 * calls: treat it as immutable.
 */
export function memoizeAuthoredCargoFrame(): (parts: readonly PartInstance[]) => BoxFrame {
  let lastRefs: PartInstance[] | null = null
  let lastEdges = ''
  let lastRev = -1
  let last!: BoxFrame // assigned before any read: the hit branch requires lastRefs !== null
  return (parts) => {
    const refs: PartInstance[] = []
    let edges = ''
    for (const p of parts) {
      const pkg = p.type === 'part' ? getPackage(p.packageId) : undefined
      if (pkg && (isCargoPackage(pkg) || pkg.unit)) refs.push(p)
      else if (p.parent !== undefined) edges += `${p.id}>${p.parent}\n`
    }
    const rev = registryRevision()
    if (lastRefs !== null && rev === lastRev && edges === lastEdges && refs.length === lastRefs.length && refs.every((p, i) => p === lastRefs![i])) {
      return last
    }
    lastRefs = refs
    lastEdges = edges
    lastRev = rev
    last = buildAuthoredCargoFrame(parts)
    return last
  }
}

/** Whether two cargo frames carry the same rows and dressings (the idle-frame audit: a kept frame vs a fresh build). */
export function cargoFramesEqual(a: BoxFrame, b: BoxFrame): boolean {
  if (a.count !== b.count) return false
  const same = (x: ArrayLike<unknown>, y: ArrayLike<unknown>): boolean => {
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  return (
    same(a.ids, b.ids) && same(a.positions, b.positions) && same(a.quats, b.quats) && same(a.halfExtents, b.halfExtents) &&
    same(a.colors, b.colors) && same(a.kinds, b.kinds) && same(a.caps ?? [], b.caps ?? []) && same(a.partIds, b.partIds) && same(a.shapes ?? [], b.shapes ?? []) &&
    JSON.stringify(a.dressings ?? []) === JSON.stringify(b.dressings ?? [])
  )
}

/**
 * The dressings of every authored unit load (unitStart), fitted over exactly its members' rows as they stand now
 * (core/cargoWrap fitLoad) and anchored on its lowest pallet (else its lowest piece). The stopped view draws these,
 * and the sim fits the same load the same way at its first step, so Run does not move a dressing by a hair.
 */
export function unitDressings(
  parts: readonly PartInstance[],
  rows: Pick<BoxFrame, 'count' | 'ids' | 'positions' | 'quats' | 'halfExtents' | 'kinds' | 'caps' | 'partIds'>,
  kids?: PartChildren,
): FrameDressing[] {
  const out: FrameDressing[] = []
  let bodies: WrapBody[] | null = null
  let rowOf: Map<string, number> | null = null
  // the rows carrying each part id, for a load that stacks itself (its pieces' rows carry its id)
  let ownRows: Map<string, number[]> | null = null
  for (const part of parts) {
    const start = unitStart(part)
    if (!start || start.dress.length === 0) continue
    if (!bodies || !rowOf || !ownRows) {
      bodies = []
      rowOf = new Map()
      ownRows = new Map()
      kids ??= partChildren(parts)
      for (let i = 0; i < rows.count; i++) {
        const p = i * 3
        const q = i * 4
        bodies.push({
          pos: [rows.positions[p]!, rows.positions[p + 1]!, rows.positions[p + 2]!],
          quat: [rows.quats[q]!, rows.quats[q + 1]!, rows.quats[q + 2]!, rows.quats[q + 3]!],
          half: [rows.halfExtents[p]!, rows.halfExtents[p + 1]!, rows.halfExtents[p + 2]!],
        })
        const id = rows.partIds[i]
        if (id) {
          rowOf.set(id, i)
          let list = ownRows.get(id)
          if (!list) ownRows.set(id, (list = []))
          list.push(i)
        }
      }
    }
    let member = unitMembers(parts, part.id, kids).map((m) => rowOf!.get(m.id)).filter((i): i is number => i !== undefined)
    // a load that stacks itself: its pieces' rows carry its own id (buildAuthoredCargoFrame)
    if (member.length === 0) member = ownRows.get(part.id) ?? []
    if (member.length === 0) continue
    const b = bodies
    const a = wrapAnchor(member.map((i) => ({ index: i, y: b[i]!.pos[1], pallet: frameHasCap(rows, i, CARGO_CAP_LOAD_BASE) })))
    const box = fitLoad(a, member, b, frameHasCap(rows, a, CARGO_CAP_LOAD_BASE))
    for (const d of start.dress) out.push({ anchor: rows.ids[a]!, id: d.id, min: [...box.min], max: [...box.max], color: [...d.color], opacity: d.opacity })
  }
  return out
}
