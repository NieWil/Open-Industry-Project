// Conveyor beds: the shape of a conveyor's conveying surface, as the host reads it.
//
// A conveyor part declares its bed kind (`conveyor.bed`: straight, spur, path, arc or turntable). Each kind has a
// view here that reads the bed's live dimensions from the part's params and handles, and an entry in BED_FAMILIES
// that answers the questions every kind must answer: its ends, footprint, surface and carry, and how it takes part
// in side merges and guard junctions. BED_FAMILIES is typed over every kind, so a new kind does not compile until
// each answer exists.
//
// Ask through bedOf(). Code that needs one kind's own dimensions asks bedView(part, kind), or switches on
// ConveyorBed.kind, which narrows `view`. The views themselves are private: a chain of "is it this view, else that
// one" outside this module is how a missed kind used to fail silently.
//
// Questions about two beds at once (snap mating, guard merges, the roller-grid seams) stay with their own engines,
// which read these answers.
import { ARC_END_EXT, BELT_MIN_RUN_LENGTH, FRAME_WALL_THICKNESS, SPUR_SIDE_GAP, type BeltSegmentSpec, type ParamValue, type PartInstance } from '../types'
import { beltEndPose, beltHorizontalExtent, beltPathFromParams, beltStartPose, beltXToS, buildBeltPath, sampleBeltPath } from './beltPath'
import type { ConveyingSurface, SurfaceVelocity } from './conveyorSurface'
import { forwardXZ } from '../math'
import type { ConveyorDecl } from '../parts/partPackage'
import { memoByParams, memoByPkg } from '../parts/partMemo'
import { getPackage } from '../parts/partRegistry'
import { resolvePartParams, resolvedParam } from '../parts/partScript'
import { resolvedBoxSize, resolvedCylinder } from '../rig/rigPose'
import { rotateXZ, toWorldXZ } from '../transforms'

const DEG = Math.PI / 180

/**
 * Conveying-end face of a conveyor: a world-space point on the surface plane
 * plus the outward direction (unit XZ) pointing away from the part. Ends mate
 * when their centers coincide and outwards are anti-parallel.
 */
export interface PartEnd {
  partId: string
  /** 'front' = downstream/+X-ish, 'back' = upstream */
  end: 'front' | 'back'
  x: number
  y: number
  z: number
  outX: number
  outZ: number
  /** face width, m (snap cue sizing; spur faces are longer than the belt width) */
  faceWidth: number
}

export interface LocalEnd {
  end: 'front' | 'back'
  x: number
  z: number
  outX: number
  outZ: number
  faceWidth: number
  /** surface-height offset above the part origin y (inclined belt ends); 0 for flat parts */
  y?: number
}

// --- the bed views ------------------------------------------------------------

/**
 * How a view reads the part's params: the instance's value, else the param's declared default (resolvedParam, the
 * rule geometry() gets its params by). A view falls back to the package's bounds only when neither is usable, so the
 * host sizes a bed exactly as the part draws it, even for a part saved without some of its params.
 */
function paramReader(pkg: ReturnType<typeof getPackage>, part: PartInstance): (key: string) => unknown {
  const own = part.params as unknown as Record<string, unknown>
  return (key) => resolvedParam(pkg?.params, own, key)
}

/**
 * A shape-agnostic view of any belt-like part's segment chain (docs/part-gizmos.md `path` handle). A part
 * stores it as a `numberList` (`[length, tilt]` rows) and declares a `handle: { kind: 'path' }` to mark it.
 * This reads it as one `BeltSegmentSpec[]` + a `writeSegments` that puts the data back in the part's native
 * shape, for the belt gizmo machinery (footprint, tail/segment dots, resize).
 * Returns null when the part isn't belt-like.
 */
export interface BeltLikeView {
  segments: BeltSegmentSpec[]
  /** belt height (fillet bend radius + end-drum radius); the path handle's `heightParam` (default `height`) */
  height: number
  /** cross-belt width; the path handle's `widthParam` (default `width`) */
  width: number
  /** side-guard toggles: the path handle's `leftGuardParam`/`rightGuardParam` booleans (a missing param
   *  reads as guarded, matching the built-in belt's default-on side guards) */
  leftGuard: boolean
  rightGuard: boolean
  /** a params patch writing the (possibly edited) segments back in the part's native shape */
  writeSegments(segs: readonly BeltSegmentSpec[]): Record<string, ParamValue>
}

/** Read a numberList value as `[length, tilt]` rows → BeltSegmentSpec[], or null if absent/malformed. */
function parseBeltRows(v: unknown, lenCol: number, tiltCol: number): BeltSegmentSpec[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: BeltSegmentSpec[] = []
  for (const row of v) {
    if (!Array.isArray(row)) return null
    const length = row[lenCol]
    const tiltDeg = row[tiltCol]
    if (typeof length !== 'number' || !(length > 0) || typeof tiltDeg !== 'number') return null
    out.push({ length, tiltDeg })
  }
  return out
}

/** The param keys a package's declared `path` handle binds: the segments param (which carries the handle),
 *  its length/tilt columns, and the sibling width/height/guard params it names (defaults `'width'`/`'height'`/
 *  `'leftGuard'`/`'rightGuard'`). Null if the package declares no `path` handle. */
const pathHandleOfPkgMemo = memoByPkg(function pathHandleOfPkgUncached(
  pkg: NonNullable<ReturnType<typeof getPackage>>,
): { key: string; lenCol: number; tiltCol: number; widthKey: string; heightKey: string; leftGuardKey: string; rightGuardKey: string } | null {
  for (const [key, spec] of Object.entries(pkg.params)) {
    const h = (spec as { handle?: { kind?: string; lengthCol?: number; tiltCol?: number; widthParam?: string; heightParam?: string; leftGuardParam?: string; rightGuardParam?: string } }).handle
    if (h && h.kind === 'path') {
      return {
        key,
        lenCol: h.lengthCol ?? 0,
        tiltCol: h.tiltCol ?? 1,
        widthKey: h.widthParam ?? 'width',
        heightKey: h.heightParam ?? 'height',
        leftGuardKey: h.leftGuardParam ?? 'leftGuard',
        rightGuardKey: h.rightGuardParam ?? 'rightGuard',
      }
    }
  }
  return null
})

export function pathHandleOfPkg(
  pkg: ReturnType<typeof getPackage>,
): { key: string; lenCol: number; tiltCol: number; widthKey: string; heightKey: string; leftGuardKey: string; rightGuardKey: string } | null {
  return pathHandleOfPkgMemo(pkg) ?? null
}

/** The custom part's declared `path` handle param keys and resolved package, or null. */
function pathHandleOf(
  part: PartInstance,
): (NonNullable<ReturnType<typeof pathHandleOfPkg>> & { pkg: ReturnType<typeof getPackage> }) | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  const keys = pathHandleOfPkg(pkg)
  return keys ? { ...keys, pkg } : null
}

const beltLikeView = memoByParams(function beltLikeViewUncached(part: PartInstance): BeltLikeView | null {
  const path = pathHandleOf(part)
  if (!path || path.pkg?.conveyor?.bed !== 'path') return null
  const param = paramReader(path.pkg, part)
  const segs = parseBeltRows(param(path.key), path.lenCol, path.tiltCol)
  if (!segs) return null
  const bounds = path.pkg && path.pkg.geometry.kind !== 'cargo' ? path.pkg.geometry.bounds : undefined
  const wv = param(path.widthKey)
  const hv = param(path.heightKey)
  return {
    segments: segs,
    width: typeof wv === 'number' && wv > 0 ? wv : (bounds?.width ?? 1),
    height: typeof hv === 'number' && hv > 0 ? hv : (bounds?.top ?? 0.28),
    leftGuard: param(path.leftGuardKey) !== false,
    rightGuard: param(path.rightGuardKey) !== false,
    writeSegments: (segs2) => {
      const rows = segs2.map((s) => {
        const row: number[] = []
        row[path.lenCol] = s.length
        row[path.tiltCol] = s.tiltDeg
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = 0
        return row
      })
      return { [path.key]: rows as unknown as ParamValue }
    },
  }
})

/** True for the built-in belt or an SDK part declaring a `path` handle: the parts with belt gizmos. */
export function isBeltLike(part: PartInstance): boolean {
  return beltLikeView(part) !== null
}

/** The face-handle param keys of a custom part: which `number` param drives the X (length), Z (width) and
 *  Y (height) faces. Used to make a non-belt SDK conveyor (the roller family) resizable + footprint-reflowing
 *  from its declared `face` handles, the same way `beltLikeView` does it from a `path` handle. */
export function faceHandleParams(part: PartInstance): FaceHandleKeys {
  if (part.type !== 'part') return {}
  return faceHandleOfPkg(getPackage(part.packageId))
}

/** Package-level {@link faceHandleParams}: which `number` params carry the X (length) / Z (width) / Y (height)
 *  `face` handles - for callers that hold a package but no placed instance (the sim's spawn-from-package path). */
const faceHandleOfPkgMemo = memoByPkg(function faceHandleOfPkgUncached(pkg: NonNullable<ReturnType<typeof getPackage>>): FaceHandleKeys {
  const out: { lengthKey?: string; widthKey?: string; heightKey?: string } = {}
  for (const [key, spec] of Object.entries(pkg.params)) {
    const h = (spec as { handle?: { kind?: string; axis?: 'x' | 'y' | 'z' } }).handle
    if (h?.kind !== 'face') continue
    if (h.axis === 'x') out.lengthKey = key
    else if (h.axis === 'z') out.widthKey = key
    else if (h.axis === 'y') out.heightKey = key
  }
  return out
})

export interface FaceHandleKeys {
  lengthKey?: string
  widthKey?: string
  heightKey?: string
}

export function faceHandleOfPkg(pkg: ReturnType<typeof getPackage>): FaceHandleKeys {
  return faceHandleOfPkgMemo(pkg) ?? {}
}

/** True if the package's geometry conveys cargo - a rig with a `conveys` deck link, or a function/deck
 *  surface. The "is this a conveyor?" test for custom parts (the analogue of `isConveyorType` for built-ins). */
const packageConveysMemo = memoByPkg(function packageConveysUncached(pkg: NonNullable<ReturnType<typeof getPackage>>): boolean {
  const g = pkg.geometry
  if (g.kind === 'drawn') return g.conveys === true
  if (g.kind === 'rig') return g.links.some((l) => (l as { conveys?: boolean }).conveys === true)
  return false
})

function packageConveys(pkg: ReturnType<typeof getPackage>): boolean {
  return packageConveysMemo(pkg) === true
}

/**
 * A straight SDK conveyor (the roller / powered-deck family), the non-belt analogue of {@link beltLikeView}.
 * A custom part that conveys and declares `face` handles on both a length (X) and a width (Z) `number` param is
 * a centre-origin straight conveyor: it resizes on both axes, its footprint reflows with the params, and it
 * butt-snaps end-to-end like any built-in straight conveyor. Returns its live length/width/height or null.
 * (The belt is excluded because it owns the bent `path` form; the spur/curved/turntable declare their own shapes.)
 */
export interface StraightConveyorView {
  length: number
  width: number
  height: number
}

const straightConveyorView = memoByParams(function straightConveyorViewUncached(part: PartInstance): StraightConveyorView | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  const bed = pkg?.conveyor?.bed
  if (!pkg || (bed !== 'straight' && bed !== 'spur')) return null
  const { lengthKey, widthKey } = faceHandleParams(part)
  if (!lengthKey || !widthKey) return null
  const param = paramReader(pkg, part)
  const bounds = pkg.geometry.kind !== 'cargo' ? pkg.geometry.bounds : undefined
  const lv = param(lengthKey)
  const wv = param(widthKey)
  return {
    length: typeof lv === 'number' && lv > 0 ? lv : (bounds?.length ?? 1),
    width: typeof wv === 'number' && wv > 0 ? wv : (bounds?.width ?? 1),
    height: bounds?.top ?? 0.1,
  }
})

/**
 * A spur SDK conveyor (the splayed-merge family): a {@link straightConveyorView} part whose length face
 * handle also declares `angleFrontParam`/`angleBackParam` (docs/part-gizmos.md). It is a centre-origin
 * parallelogram bed whose end faces splay about +Y so it merges flush onto a straight line at an angle
 * (front face x = +L/2 + tan(front)·z, back face x = −L/2 + tan(back)·z). Returns the live length/width +
 * splay angles + the declared side-merge clearance, or null. The non-rectangular sibling of the straight
 * view, so an SDK spur exposes the built-in spur's angled ends, splay-covering footprint, host guard
 * opening and rail/guard snap extents.
 */
export interface SpurConveyorView {
  length: number
  width: number
  angleFrontDeg: number
  angleBackDeg: number
  /** clearance kept off the host's bed edge when side-merging (m) - the handle's `sideGap`, default the
   *  2×frame-flange junction clearance (SPUR_SIDE_GAP) every spur family uses */
  sideGap: number
}

const spurConveyorView = memoByParams(function spurConveyorViewUncached(part: PartInstance): SpurConveyorView | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.conveyor?.bed !== 'spur') return null
  const { lengthKey, widthKey } = faceHandleParams(part)
  if (!lengthKey || !widthKey) return null
  const h = (pkg.params[lengthKey] as { handle?: { angleFrontParam?: string; angleBackParam?: string; sideGap?: number } }).handle
  if (!h || (h.angleFrontParam === undefined && h.angleBackParam === undefined)) return null
  const param = paramReader(pkg, part)
  const num = (key: string | undefined): number => {
    const v = key ? param(key) : undefined
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const bounds = pkg.geometry.kind !== 'cargo' ? pkg.geometry.bounds : undefined
  const lv = param(lengthKey)
  const wv = param(widthKey)
  return {
    length: typeof lv === 'number' && lv > 0 ? lv : (bounds?.length ?? 1),
    width: typeof wv === 'number' && wv > 0 ? wv : (bounds?.width ?? 1),
    angleFrontDeg: num(h.angleFrontParam),
    angleBackDeg: num(h.angleBackParam),
    sideGap: typeof h.sideGap === 'number' && h.sideGap >= 0 ? h.sideGap : SPUR_SIDE_GAP,
  }
})

/** SDK spur end-face X at a local z, for one end: the centre-origin twin of {@link spurFaceX} */
export function sdkSpurFaceX(v: SpurConveyorView, sign: 1 | -1, z: number): number {
  const a = sign > 0 ? v.angleFrontDeg : v.angleBackDeg
  return (sign * v.length) / 2 + Math.tan(a * DEG) * z
}

/** the four top-face corners of an SDK spur bed, local XZ - the centre-origin twin of {@link spurCorners} */
export function sdkSpurCorners(v: SpurConveyorView): { x: number; z: number }[] {
  const hw = v.width / 2
  return [
    { x: sdkSpurFaceX(v, 1, -hw), z: -hw },
    { x: sdkSpurFaceX(v, 1, hw), z: hw },
    { x: sdkSpurFaceX(v, -1, hw), z: hw },
    { x: sdkSpurFaceX(v, -1, -hw), z: -hw },
  ]
}

/**
 * A rotating-deck SDK conveyor (the turntable family): a custom rig whose revolute joint drives a cylinder
 * deck link (the disc that friction-carries cargo around). Returns the disc rim `radius` (where a neighbour
 * butts), the conveying lane `width` (the `conveys` box's resolved cross size: the part's own declaration,
 * not an assumed param name), and the deck's settled angle `restRad` (the joint's declared `rest` param
 * binding, 0 when undeclared), or null. The rim math matches the built-in turntable (radius = plate disc),
 * so a canonicalized SDK turntable exposes the same home-oriented ±X rim ends as the built-in.
 */
export interface RotatingDeckView {
  radius: number
  width: number
  restRad: number
}

const rotatingDeckView = memoByParams(function rotatingDeckViewUncached(part: PartInstance): RotatingDeckView | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig' || pkg.conveyor?.bed !== 'turntable') return null
  const joint = pkg.geometry.joints.find((j) => j.type === 'revolute')
  if (!joint) return null
  const deck = pkg.geometry.links.find((l) => l.name === joint.link)
  if (!deck || deck.shape.kind !== 'cylinder') return null
  const params = resolvePartParams(pkg.params, part.params as never) as unknown as Parameters<typeof resolvedCylinder>[1]
  const radius = resolvedCylinder(deck.shape, params).radius
  // the lane width is the conveys box's resolved cross (Z) size - declared by the part's own sizeParams
  const lane = pkg.geometry.links.find((l) => l.conveys === true && l.shape.kind === 'box')
  const laneW = lane && lane.shape.kind === 'box' ? resolvedBoxSize(lane.shape.size, lane.shape.sizeParams, params as Record<string, number>)[2] : undefined
  const restRad = jointRestValue(joint, params as unknown as Record<string, unknown>) ?? 0
  return { radius, width: typeof laneW === 'number' && laneW > 0 ? laneW : radius * 2, restRad }
})

/** A joint's settled value from its declared `rest` param binding (params[param]·scale + add, in the joint's
 *  units), or undefined when it declares none or the param isn't a number. The one reading of that binding,
 *  shared by the physics side (rotatingDeckView) and the stopped editor's idle pose, so the viewport and the
 *  conveying surface agree on where a stopped deck points. */
export function jointRestValue(joint: { rest?: { param: string; scale?: number; add?: number } }, params: Record<string, unknown>): number | undefined {
  if (!joint.rest) return undefined
  const v = params[joint.rest.param]
  return typeof v === 'number' ? v * (joint.rest.scale ?? 1) + (joint.rest.add ?? 0) : undefined
}

/** The param keys an SDK curved conveyor's `arc` handle binds: the sweep-degrees param (which carries the
 *  handle) + the sibling innerRadius / width / guard params it names (defaults `'innerRadius'`/`'width'`/
 *  `'innerGuard'`/`'outerGuard'`). Null if the package declares no `arc` handle. */
const sdkArcParamKeysMemo = memoByPkg(function sdkArcParamKeysUncached(
  pkg: NonNullable<ReturnType<typeof getPackage>>,
): { sweepKey: string; innerRadiusKey: string; widthKey: string; innerGuardKey: string; outerGuardKey: string; endGap?: number; endGapParam?: ArcEndGapParam } | null {
  for (const [key, spec] of Object.entries(pkg.params)) {
    const h = (spec as { handle?: { kind?: string; innerRadiusParam?: string; widthParam?: string; innerGuardParam?: string; outerGuardParam?: string; endGap?: number; endGapParam?: ArcEndGapParam } }).handle
    if (h?.kind === 'arc') {
      return {
        sweepKey: key,
        innerRadiusKey: h.innerRadiusParam ?? 'innerRadius',
        widthKey: h.widthParam ?? 'width',
        innerGuardKey: h.innerGuardParam ?? 'innerGuard',
        outerGuardKey: h.outerGuardParam ?? 'outerGuard',
        endGap: typeof h.endGap === 'number' ? h.endGap : undefined,
        endGapParam: h.endGapParam && typeof h.endGapParam.param === 'string' ? h.endGapParam : undefined,
      }
    }
  }
  return null
})

/** an arc handle's `endGapParam`: the snap-end lead-in tracking a param (`params[param] × scale + add`) */
type ArcEndGapParam = { param: string; scale?: number; add?: number }

function sdkArcParamKeys(
  pkg: ReturnType<typeof getPackage>,
): { sweepKey: string; innerRadiusKey: string; widthKey: string; innerGuardKey: string; outerGuardKey: string; endGap?: number; endGapParam?: ArcEndGapParam } | null {
  return sdkArcParamKeysMemo(pkg) ?? null
}

/**
 * The arc parameters + param keys of a curved conveyor, unified across the built-in curved types (fixed
 * `innerRadius`/`width`/`sweepDeg` keys) and an SDK curved bed (a custom part whose sweep param declares an
 * `arc` handle, docs/part-gizmos.md). `sdk` distinguishes the two arc conventions the gizmo must honour:
 * built-in sweeps from local +Z toward +X, the SDK from local +X toward −Z (see {@link curvedHandleLocal}).
 * Returns null for a non-curved part. One resolver so the arc resize gizmo drives either family identically.
 */
export interface CurvedGizmo {
  innerRadius: number
  width: number
  sweepDeg: number
  innerRadiusKey: string
  widthKey: string
  sweepKey: string
  /** straight tangent lead-in/out (m) the snap ends extend past the arc: the belt half-pulley (ARC_END_EXT) for
   *  a curved belt, the near-flush CURVED_ROLLER_END_EXT for a curved roller (an SDK arc bed names its own via
   *  the handle's `endGap`; default = ARC_END_EXT). Keeps a curved roller butting flush like the built-in.
   *  (Footprint + collision stubs stay a uniform ARC_END_EXT on both families, matching the built-in.) */
  endExt: number
  /** true = SDK arc convention (entry local +X, sweeping toward −Z); false = built-in (entry +Z, toward +X) */
  sdk: boolean
}

export function curvedGizmoOf(part: PartInstance): CurvedGizmo | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || !packageConveys(pkg)) return null
  const keys = sdkArcParamKeys(pkg)
  if (!keys) return null
  const param = paramReader(pkg, part)
  const bounds = pkg.geometry.kind !== 'cargo' ? pkg.geometry.bounds : undefined
  const sv = param(keys.sweepKey)
  const iv = param(keys.innerRadiusKey)
  const wv = param(keys.widthKey)
  // the lead-in tracking a param (a curved belt's drum radius = height / 2), when the param resolves to a length
  const gp = keys.endGapParam ? param(keys.endGapParam.param) : undefined
  const gapFromParam = typeof gp === 'number' && Number.isFinite(gp) ? gp * (keys.endGapParam!.scale ?? 1) + (keys.endGapParam!.add ?? 0) : undefined
  return {
    sweepDeg: typeof sv === 'number' ? sv : 90,
    innerRadius: typeof iv === 'number' && iv > 0 ? iv : 0.5,
    width: typeof wv === 'number' && wv > 0 ? wv : (bounds?.width ?? 1),
    innerRadiusKey: keys.innerRadiusKey,
    widthKey: keys.widthKey,
    sweepKey: keys.sweepKey,
    // an SDK curved bed declares its lead-in/out via the arc handle's `endGapParam` (tracking a param) or
    // `endGap`; a curve with neither gets the belt half-pulley.
    endExt: gapFromParam !== undefined && gapFromParam >= 0 ? gapFromParam : (keys.endGap ?? ARC_END_EXT),
    sdk: true,
  }
}

/**
 * A curved SDK conveyor (the curved-belt/roller family): a custom part whose sweep param declares an `arc`
 * handle (docs/part-gizmos.md). Returns the live innerRadius / width / sweepDeg (degrees), or null. The arc is
 * authored in the SDK convention: centreline radius rc = innerRadius + width/2, entry at local (rc, 0, 0) with
 * flow toward −Z, sweeping through sweepDeg - matching the curved-conveyor behavior + build script. This is the
 * non-belt/non-straight recognizer so an SDK curved bed is seen as a conveyor and exposes its two arc ends.
 */
export interface CurvedConveyorView {
  innerRadius: number
  width: number
  sweepDeg: number
  /** straight tangent lead-in/out (m) the snap ends extend past the arc (see {@link CurvedGizmo.endExt}) */
  endExt: number
  /** side-guard toggles: the arc handle's `innerGuardParam`/`outerGuardParam` booleans (a missing param
   *  reads as guarded, matching the built-in curve's default-on side guards) */
  innerGuard: boolean
  outerGuard: boolean
}

const curvedConveyorView = memoByParams(function curvedConveyorViewUncached(part: PartInstance): CurvedConveyorView | null {
  const g = curvedGizmoOf(part)
  if (!g || !g.sdk) return null
  const pkg = part.type === 'part' ? getPackage(part.packageId) : undefined
  if (pkg?.conveyor?.bed !== 'arc') return null
  const keys = sdkArcParamKeys(pkg)
  const param = paramReader(pkg, part)
  return {
    innerRadius: g.innerRadius,
    width: g.width,
    sweepDeg: g.sweepDeg,
    endExt: g.endExt,
    innerGuard: !keys || param(keys.innerGuardKey) !== false,
    outerGuard: !keys || param(keys.outerGuardKey) !== false,
  }
})

/**
 * Local snap ends for an SDK curved conveyor (arc convention P(t) = (rc·cos t, 0, −rc·sin t), entry t=0). The
 * ends sit at the straight tangent-stub tips (the part's `endExt` along the outward tangent) - the belt
 * half-pulley for a curved belt, or the near-flush CURVED_ROLLER_END_EXT for a curved roller - matching the
 * curved-conveyor build script's lead-in/out stubs, so the curve butt-mates flush like the built-in it mirrors.
 */
export function sdkCurvedLocalEnds(v: CurvedConveyorView): LocalEnd[] {
  const rc = v.innerRadius + v.width / 2
  const sweep = v.sweepDeg * DEG
  const ext = v.endExt
  const ex = rc * Math.cos(sweep)
  const ez = -rc * Math.sin(sweep)
  const tox = -Math.sin(sweep) // exit (flow-out) tangent
  const toz = -Math.cos(sweep)
  return [
    // entry (back, t=0): point (rc, 0), flow-in tangent (0,−1) → outward (upstream) (0,+1), stub pushed +Z
    { end: 'back', x: rc, z: ext, outX: 0, outZ: 1, faceWidth: v.width },
    // exit (front, t=sweep): point pushed out along the flow-out tangent
    { end: 'front', x: ex + tox * ext, z: ez + toz * ext, outX: tox, outZ: toz, faceWidth: v.width },
  ]
}

/** Pure geo+params → incline radians (clamped to ±`maxInclineDeg`, default 30°). 0 when the rig declares no
 *  `inclineParam` or the param is missing/non-numeric. Sim call sites hold `geo` already, so they use this
 *  directly (no package-registry lookup); {@link resolveInclineRad} is the by-part convenience over it. */
export function rigInclineRad(geo: { inclineParam?: string; maxInclineDeg?: number }, params: Record<string, unknown>): number {
  if (!geo.inclineParam) return 0
  const v = params[geo.inclineParam]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const maxDeg = geo.maxInclineDeg ?? 30
  return (Math.max(-maxDeg, Math.min(maxDeg, v)) * Math.PI) / 180
}

/** The whole-bed incline of a conveying rig part, in radians - 0 unless its rig geometry declares an
 *  `inclineParam` (docs/conveyor-incline.md) and that `number` param is set. One source of truth for the tilt,
 *  shared by render (sdkPart FK), the sim rig bodies + deck, and the footprint - so a tilted deck can't
 *  drift from its collision or its legs. */
export function resolveInclineRad(part: PartInstance): number {
  if (part.type !== 'part') return 0
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return 0
  const key = pkg.geometry.inclineParam
  if (!key) return 0
  return rigInclineRad(pkg.geometry, { [key]: resolvedParam(pkg.params, part.params as unknown as Record<string, unknown>, key) })
}

// --- the bed families ---------------------------------------------------------

export type BedKind = NonNullable<ConveyorDecl['bed']>

/** What each bed kind's answers read: its view. A spur carries its straight view too, since its surface, carry and
 *  reach are the straight bed's. */
export interface BedViews {
  straight: StraightConveyorView
  spur: { spur: SpurConveyorView; straight: StraightConveyorView }
  path: BeltLikeView
  arc: CurvedConveyorView
  turntable: RotatingDeckView
}

/** local XZ half-extents and height range of a bed's footprint box; `cx` is its centre's local X when not 0 */
export interface BedFootprint {
  hx: number
  hz: number
  y0: number
  y1: number
  cx?: number
}

/** A bed's end faces as a side-merging mover sees them: the bed width, the face X at (end sign, z), and whether
 *  its rails extend to a host's wall (a spur) or only retract to it (a straight or a belt). */
export interface BedMergeFaces {
  width: number
  spur: boolean
  /** a face's local X measured along the bed (what an extents row carries); times `slope` for its plan position */
  faceX: (sign: 1 | -1, z: number) => number
  /** along-the-bed to plan: cos of the bed's incline, 1 for a bed that does not incline */
  slope: number
}

/** The local-X span and half-width of a bed whose side guards open where a neighbour butts them. `slope` turns a
 *  plan local X into the guard's own along-the-bed X. */
export interface BedGuardHost {
  bedLo: number
  bedHi: number
  hw: number
  slope: number
  /** where each side's guard actually runs, in the same X: bedLo..bedHi on a rectangular bed, but a spur's angled
   *  ends make one side's guard reach past ±length/2 and the other's stop short of it */
  sides: { left: [number, number]; right: [number, number] }
}

/** How a bed side-merges onto another bed's flank as the mover: the clearance it keeps off the flank (a spur's
 *  declared gap), and whether its end is framed (stands on the host's wall face) or a bare plate (butts the edge). */
export interface BedSideMerge {
  gap?: number
  framedEnd: boolean
}

/** The flanks another bed can side-merge onto: both run local x0..x1 at z = ±hw, and `frameOut` is how far the
 *  bed's frame stands out past them. */
export interface BedFlanks {
  x0: number
  x1: number
  hw: number
  frameOut: number
}

/** The questions every bed kind answers. Everything but `surfaceAt` and `surfaceVelocity` reads the part's
 *  type, packageId and params only, never its pose, because bedOf and conveyorLocalEnds memoise on params. */
interface BedFamily<V> {
  /** the bed's live dimensions, or null when its declaration is incomplete */
  view(part: PartInstance): V | null
  /** the two conveying ends, in the part frame */
  localEnds(v: V, part: PartInstance): LocalEnd[]
  /** the conveying-surface plane over a part-local XZ point, in world terms, or null when the point is off the bed */
  surfaceAt(v: V, part: PartInstance, lx: number, lz: number): ConveyingSurface | null
  /** the world XZ velocity the surface imparts at world (x, z) while it runs at `speed` (never 0) */
  surfaceVelocity(v: V, part: PartInstance, speed: number, x: number, z: number): SurfaceVelocity
  /** how far the bed reaches from the part origin (m), for a quick "could this point be over it" test */
  reach(v: V): number
  /** the footprint box selection, broadphase and drop-rest read */
  footprint(v: V, part: PartInstance): BedFootprint
  /** true when the resize dots sit on the conveying surface (local y = 0), not at the footprint's mid-height */
  resizeOnDeck: boolean
  /** its end faces as a side-merging mover, or null for a bed whose rails never meet a host's wall */
  mergeFaces(v: V, part: PartInstance): BedMergeFaces | null
  /** its guard span as a host whose guards open, or null for a bed whose guards never open */
  guardHost(v: V, part: PartInstance): BedGuardHost | null
  /** how it side-merges as the mover, or null for a bed that takes end joins only */
  sideMerge(v: V): BedSideMerge | null
  /** its flanks as a side-merge target, or null for a bed nothing merges onto from the side */
  flanks(v: V): BedFlanks | null
  /**
   * True for a bed no conveyor may merge onto from the side, whatever its geometry. The one place that rule lives:
   * the snap engine offers no flank on it, no conveyor end opens its guards or takes extents off its wall, and
   * check-layout warns about an end placed against its side. A device mounted on its guard still opens it.
   */
  endJoinsOnly: boolean
}

/** a constant carry along the part's +X */
function forwardCarry(part: PartInstance, speed: number): SurfaceVelocity {
  const f = forwardXZ(part.rotationY)
  return { vx: f.x * speed, vz: f.z * speed }
}

/** cos of a bed's incline: an inclined bed's guards run along its slope, so a plan distance is this times the
 *  along-bed one */
function inclineSlope(part: PartInstance): number {
  return Math.cos(resolveInclineRad(part))
}

/** the guard host of a bed whose two guards both run its whole length */
function rectangleGuardHost(bedLo: number, bedHi: number, hw: number, slope: number): BedGuardHost {
  return { bedLo, bedHi, hw, slope, sides: { left: [bedLo, bedHi], right: [bedLo, bedHi] } }
}

/** the footprint of a tail-origin belt: its plan extent plus the end-drum overhang, and its path's height range */
function beltFootprintOf(segments: BeltSegmentSpec[], height: number, width: number): BedFootprint {
  const path = beltPathFromParams({ segments, height })
  const extent = Math.max(beltHorizontalExtent(segments), BELT_MIN_RUN_LENGTH)
  return {
    hx: extent / 2 + path.height / 2,
    cx: extent / 2,
    hz: width / 2,
    y0: path.bounds.minY - path.height,
    y1: path.bounds.maxY + 0.05,
  }
}

/** A centre-origin rectangle. A whole-bed incline pivots it about the origin. */
const straightBed: BedFamily<StraightConveyorView> = {
  view: (part) => straightConveyorView(part),
  localEnds(v, part) {
    // an inclined bed's ends sit (L/2)·cos out in plan and (L/2)·sin above and below the origin, so the end-mate
    // places a neighbour at that point and height (docs/conveyor-incline.md)
    const th = resolveInclineRad(part)
    const hx = (v.length / 2) * Math.cos(th)
    const hy = (v.length / 2) * Math.sin(th)
    return [
      { end: 'front', x: hx, z: 0, outX: 1, outZ: 0, faceWidth: v.width, ...(hy !== 0 ? { y: hy } : {}) },
      { end: 'back', x: -hx, z: 0, outX: -1, outZ: 0, faceWidth: v.width, ...(hy !== 0 ? { y: -hy } : {}) },
    ]
  },
  surfaceAt(v, part, lx, lz) {
    const th = resolveInclineRad(part)
    const planHalf = (v.length / 2) * Math.cos(th)
    if (Math.abs(lx) > planHalf + 1e-6 || Math.abs(lz) > v.width / 2 + 1e-6) return null
    const ln = rotateXZ(-Math.sin(th), 0, part.rotationY)
    return { y: part.position[1] + lx * Math.tan(th), normal: [ln.x, Math.cos(th), ln.z] }
  },
  surfaceVelocity: (_v, part, speed) => forwardCarry(part, speed),
  reach: (v) => Math.hypot(v.length / 2, v.width / 2),
  footprint(v, part) {
    // The ends of an inclined bed move in to (L/2)·cos in plan: the extent the snap overlap test, face-flush, leg
    // rests and the layout check read, and where localEnds puts them. The head lifts and the tail drops by
    // (L/2)·|sin|, so the vertical extent grows both ways to cover them. At L/2 the box would overhang each end by
    // (L/2)(1 - cos): 20 cm on a 3 m bed at 30 degrees, enough to count a correctly butted neighbour as overlapping.
    const th = resolveInclineRad(part)
    const half = v.length / 2
    const rise = half * Math.abs(Math.sin(th))
    return { hx: half * Math.cos(th), hz: v.width / 2, y0: -0.4 - rise, y1: 0.05 + rise }
  },
  resizeOnDeck: true,
  // flat ends at ±length/2; its rails retract to a host's wall plane, never extend to it
  mergeFaces: (v, part) => ({ width: v.width, spur: false, faceX: (sign) => (sign * v.length) / 2, slope: inclineSlope(part) }),
  guardHost: (v, part) => rectangleGuardHost(-v.length / 2, v.length / 2, v.width / 2, inclineSlope(part)),
  sideMerge: () => ({ framedEnd: true }),
  // the full bed length at z = ±width/2, with the L-frame outside the bed edge
  flanks: (v) => ({ x0: -v.length / 2, x1: v.length / 2, hw: v.width / 2, frameOut: FRAME_WALL_THICKNESS }),
  endJoinsOnly: false,
}

/** A straight bed whose end faces splay, so it merges flush onto a straight line at an angle. */
const spurBed: BedFamily<BedViews['spur']> = {
  view(part) {
    const spur = spurConveyorView(part)
    const straight = straightConveyorView(part)
    return spur && straight ? { spur, straight } : null
  },
  localEnds({ spur }) {
    // the ends sit on the splayed faces: outward is the face normal, faceWidth the sheared face's true width
    const fa = spur.angleFrontDeg * DEG
    const ba = spur.angleBackDeg * DEG
    return [
      { end: 'front', x: spur.length / 2, z: 0, outX: Math.cos(fa), outZ: -Math.sin(fa), faceWidth: spur.width / Math.cos(fa) },
      { end: 'back', x: -spur.length / 2, z: 0, outX: -Math.cos(ba), outZ: Math.sin(ba), faceWidth: spur.width / Math.cos(ba) },
    ]
  },
  surfaceAt: (v, part, lx, lz) => straightBed.surfaceAt(v.straight, part, lx, lz),
  surfaceVelocity: (_v, part, speed) => forwardCarry(part, speed),
  reach: (v) => straightBed.reach(v.straight),
  footprint({ spur }) {
    // the whole splayed parallelogram, including the shear overhang past ±length/2
    const xs = sdkSpurCorners(spur).map((c) => c.x)
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    return { hx: (hi - lo) / 2, cx: (hi + lo) / 2, hz: spur.width / 2, y0: -0.4, y1: 0.05 }
  },
  resizeOnDeck: true,
  // sheared faces; its rails extend to the host's wall plane to close the side gap
  mergeFaces: ({ spur }) => ({ width: spur.width, spur: true, faceX: (sign, z) => sdkSpurFaceX(spur, sign, z), slope: 1 }),
  guardHost(v, part) {
    // its guards take device openings and beam holes like a straight's, but each side's guard runs between that
    // edge's own end faces, offset from ±length/2 by the splay. No conveyor end opens them (guardOpenings.ts).
    const host = straightBed.guardHost(v.straight, part)!
    const hw = v.spur.width / 2
    const side = (z: number): [number, number] => [sdkSpurFaceX(v.spur, -1, z), sdkSpurFaceX(v.spur, 1, z)]
    return { ...host, sides: { left: side(-hw), right: side(hw) } }
  },
  sideMerge: ({ spur }) => ({ gap: spur.sideGap, framedEnd: true }),
  // never asked for: it takes end joins only
  flanks: () => null,
  // A spur is itself the merge: a line fed into its side would cross product entering at an angle, in a section too
  // short to sequence the two.
  endJoinsOnly: true,
}

/** A tail-origin bent belt: the surface follows its segment profile. */
const pathBed: BedFamily<BeltLikeView> = {
  view: (part) => beltLikeView(part),
  localEnds(v) {
    // drum-wrap ends: half the belt height past each end of the path, along its end tangent
    const path = buildBeltPath(v.segments, v.height)
    const start = beltStartPose(path)
    const end = beltEndPose(path)
    const pulley = path.height / 2
    return [
      { end: 'front', x: end.x + Math.cos(end.angle) * pulley, z: 0, outX: 1, outZ: 0, faceWidth: v.width, y: end.y + Math.sin(end.angle) * pulley },
      { end: 'back', x: start.x - Math.cos(start.angle) * pulley, z: 0, outX: -1, outZ: 0, faceWidth: v.width, y: start.y - Math.sin(start.angle) * pulley },
    ]
  },
  surfaceAt(v, part, lx, lz) {
    const extent = beltHorizontalExtent(v.segments)
    if (Math.abs(lz) > v.width / 2 + 1e-6 || lx < -1e-6 || lx > extent + 1e-6) return null
    const path = buildBeltPath(v.segments, v.height)
    const p = sampleBeltPath(path, beltXToS(path, lx))
    const ln = rotateXZ(-Math.sin(p.angle), 0, part.rotationY)
    return { y: part.position[1] + p.y, normal: [ln.x, Math.cos(p.angle), ln.z] }
  },
  surfaceVelocity: (_v, part, speed) => forwardCarry(part, speed),
  reach: (v) => Math.hypot(beltHorizontalExtent(v.segments), v.width / 2),
  footprint: (v) => beltFootprintOf(v.segments, v.height, v.width),
  resizeOnDeck: true,
  mergeFaces(v) {
    // the drum-overhang faces localEnds puts the ends on; its frame and guards retract to a flush-merged host's wall
    const path = buildBeltPath(v.segments, v.height)
    const start = beltStartPose(path)
    const end = beltEndPose(path)
    const pulley = path.height / 2
    const back = start.x - Math.cos(start.angle) * pulley
    const front = end.x + Math.cos(end.angle) * pulley
    return { width: v.width, spur: false, faceX: (sign) => (sign > 0 ? front : back), slope: 1 }
  },
  guardHost(v) {
    // openings are plan X over the bed, which the belt's geometry maps onto its path. Its guards run on past the bed
    // around each end drum, to the faces localEnds puts its ends on, so a beam can hole them there too.
    const host = rectangleGuardHost(0, Math.max(beltHorizontalExtent(v.segments), 1e-3), v.width / 2, 1)
    const path = buildBeltPath(v.segments, v.height)
    const start = beltStartPose(path)
    const end = beltEndPose(path)
    const pulley = path.height / 2
    const run: [number, number] = [start.x - Math.cos(start.angle) * pulley, end.x + Math.cos(end.angle) * pulley]
    return { ...host, sides: { left: run, right: [run[0], run[1]] } }
  },
  sideMerge: () => ({ framedEnd: true }),
  flanks(v) {
    // tail-origin: the bed and its guards run local x 0..extent
    const hl = Math.max(beltHorizontalExtent(v.segments), 1e-3) / 2
    return { x0: 0, x1: 2 * hl, hw: v.width / 2, frameOut: FRAME_WALL_THICKNESS }
  },
  endJoinsOnly: false,
}

/** A curve: a flat annulus about the part origin, swept from local +X toward -Z. */
const arcBed: BedFamily<CurvedConveyorView> = {
  view: (part) => curvedConveyorView(part),
  localEnds: (v) => sdkCurvedLocalEnds(v),
  surfaceAt(v, part, lx, lz) {
    const r = Math.hypot(lx, lz)
    if (r < v.innerRadius - 1e-6 || r > v.innerRadius + v.width + 1e-6) return null
    return { y: part.position[1], normal: [0, 1, 0] }
  },
  surfaceVelocity(v, part, speed, x, z) {
    // the curved-conveyor behavior's setArcSurfaceVelocity: a rigid rotation about the arc centre (the part
    // origin) with omega = speed / centreline radius, so v = omega × (p − centre) (as sim/conveyorContacts.ts bakes it)
    const rc = Math.max(v.innerRadius + v.width / 2, 1e-3)
    const omega = speed / rc
    return { vx: omega * (z - part.position[2]), vz: -omega * (x - part.position[0]) }
  },
  reach: (v) => v.innerRadius + v.width,
  footprint(v) {
    // a square out to the outer radius plus the tangent stub: at least the ARC_END_EXT reach on both families, not
    // the roller's flush snap `endExt`, so the box never under-covers the stub. A deep curved belt's longer stub
    // (its drum, endGapParam) widens it.
    const r = v.innerRadius + v.width + Math.max(ARC_END_EXT, v.endExt)
    return { hx: r, hz: r, y0: -0.4, y1: 0.05 }
  },
  resizeOnDeck: false,
  // a curve meets other beds end to end only, so its guards never open and nothing merges onto its side
  mergeFaces: () => null,
  guardHost: () => null,
  sideMerge: () => null,
  flanks: () => null,
  endJoinsOnly: false,
}

/** A round deck turning on a revolute joint. Its ends are home-oriented on the rim at ±radius along local X, since
 *  the slew is run state. */
const turntableBed: BedFamily<RotatingDeckView> = {
  view: (part) => rotatingDeckView(part),
  localEnds: (v) => [
    { end: 'front', x: v.radius, z: 0, outX: 1, outZ: 0, faceWidth: v.width },
    { end: 'back', x: -v.radius, z: 0, outX: -1, outZ: 0, faceWidth: v.width },
  ],
  surfaceAt: (v, part, lx, lz) => (Math.hypot(lx, lz) <= v.radius + 1e-6 ? { y: part.position[1], normal: [0, 1, 0] } : null),
  surfaceVelocity(v, part, speed) {
    // the settled carry: along the part forward turned by the deck's resting angle. The slew field is not mirrored.
    const f = forwardXZ(part.rotationY)
    const c = Math.cos(v.restRad)
    const s = Math.sin(v.restRad)
    return { vx: (f.x * c + f.z * s) * speed, vz: (f.z * c - f.x * s) * speed }
  },
  reach: (v) => v.radius,
  footprint: (v) => ({ hx: v.radius, hz: v.radius, y0: -0.4, y1: 0.05 }),
  resizeOnDeck: false,
  // its plate is no framed end: its rails never meet a host's wall, and its guards don't open
  mergeFaces: () => null,
  guardHost: () => null,
  sideMerge: () => ({ framedEnd: false }),
  // the guards span only the lane (±width/2 in X) on the bare plate rim at z = ±radius
  flanks: (v) => ({ x0: -v.width / 2, x1: v.width / 2, hw: v.radius, frameOut: 0 }),
  endJoinsOnly: false,
}

const BED_FAMILIES: { [K in BedKind]: BedFamily<BedViews[K]> } = {
  straight: straightBed,
  spur: spurBed,
  path: pathBed,
  arc: arcBed,
  turntable: turntableBed,
}

/** A conveyor's bed: its kind, its view, and its family's answers bound to that view. */
export type ConveyorBed = { [K in BedKind]: { readonly kind: K; readonly view: BedViews[K] } }[BedKind] & {
  localEnds(part: PartInstance): LocalEnd[]
  surfaceAt(part: PartInstance, lx: number, lz: number): ConveyingSurface | null
  surfaceVelocity(part: PartInstance, speed: number, x: number, z: number): SurfaceVelocity
  reach(): number
  footprint(part: PartInstance): BedFootprint
  readonly resizeOnDeck: boolean
  mergeFaces(part: PartInstance): BedMergeFaces | null
  guardHost(part: PartInstance): BedGuardHost | null
  sideMerge(): BedSideMerge | null
  flanks(): BedFlanks | null
  readonly endJoinsOnly: boolean
}

function resolveBed<K extends BedKind>(kind: K, part: PartInstance): ConveyorBed | null {
  const family: BedFamily<BedViews[K]> = BED_FAMILIES[kind]
  const view = family.view(part)
  if (view === null) return null
  return {
    kind,
    view,
    localEnds: (p) => family.localEnds(view, p),
    surfaceAt: (p, lx, lz) => family.surfaceAt(view, p, lx, lz),
    surfaceVelocity: (p, speed, x, z) => family.surfaceVelocity(view, p, speed, x, z),
    reach: () => family.reach(view),
    footprint: (p) => family.footprint(view, p),
    resizeOnDeck: family.resizeOnDeck,
    mergeFaces: (p) => family.mergeFaces(view, p),
    guardHost: (p) => family.guardHost(view, p),
    sideMerge: () => family.sideMerge(view),
    flanks: () => family.flanks(view),
    endJoinsOnly: family.endJoinsOnly,
  } as ConveyorBed
}

/** The part's conveyor bed, or null for a part that is not a conveyor to its neighbours (no declared bed, or a
 *  declaration missing what its kind needs). A spur without splay params is read as the straight bed it is. */
export const bedOf = memoByParams(function bedOfUncached(part: PartInstance): ConveyorBed | null {
  if (part.type !== 'part') return null
  const kind = getPackage(part.packageId)?.conveyor?.bed
  if (!kind) return null
  return resolveBed(kind, part) ?? (kind === 'spur' ? resolveBed('straight', part) : null)
})

/** The view of a part whose bed is of `kind`, or null for any other part. A spur is never a 'straight' here: ask
 *  {@link rectangleBedOf} for the rectangle both share. */
export function bedView<K extends BedKind>(part: PartInstance, kind: K): BedViews[K] | null {
  const bed = bedOf(part)
  return bed !== null && bed.kind === kind ? (bed.view as BedViews[K]) : null
}

/** The centre-origin length × width rectangle of a straight bed or a spur (a spur's unsplayed rectangle), or null
 *  for any other bed. For the code that treats both alike: roller stations, guard-mounted devices, the resize dots. */
export function rectangleBedOf(part: PartInstance): StraightConveyorView | null {
  const bed = bedOf(part)
  if (bed === null) return null
  if (bed.kind === 'straight') return bed.view
  if (bed.kind === 'spur') return bed.view.straight
  return null
}

/** local ends for any conveyor; [] for a part that is not one */
export const conveyorLocalEnds = memoByParams(function conveyorLocalEndsUncached(part: PartInstance): LocalEnd[] {
  return bedOf(part)?.localEnds(part) ?? []
})

/** world-space ends for any conveyor type; [] for non-conveyors */
export function conveyorEndsOf(part: PartInstance): PartEnd[] {
  return conveyorLocalEnds(part).map((e) => {
    const p = toWorldXZ(part, e.x, e.z)
    const o = rotateXZ(e.outX, e.outZ, part.rotationY)
    return {
      partId: part.id,
      end: e.end,
      x: p.x,
      y: part.position[1] + (e.y ?? 0),
      z: p.z,
      outX: o.x,
      outZ: o.z,
      faceWidth: e.faceWidth,
    }
  })
}

/** True for any conveyor the snap and guard machinery treats as one: a part with a resolvable bed. */
export function isConveyorLike(part: PartInstance): boolean {
  return bedOf(part) !== null
}
