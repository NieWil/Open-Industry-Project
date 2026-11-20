import {
  BELT_MIN_RUN_LENGTH,
  BUILDING_SECTION_SIZE,
  FLOOR_SURFACE_Y,
  PART_DEFS,
  buildingEaveHeight,
  type ParamValue,
  type PartInstance,
} from '../types'
import { beltHorizontalExtent, beltSegmentAngles } from '../conveyor/beltPath'
import { flexStations } from '../conveyor/flexPath'
import { cargoView } from '../frame'
import { getPackage } from './partRegistry'
import { resolvedParam } from './partScript'
import { foldedRef, rigRestExtent, type RigParams } from '../rig/rigPose'
import type { PartBounds } from './partPackage'
import { rotateXZ, toLocalXZ, toWorldXZ } from '../transforms'
import { memoByParams, memoByPkg } from './partMemo'
import { bedOf, bedView, faceHandleParams, isBeltLike, resolveInclineRad, type CurvedGizmo, type PartEnd } from '../conveyor/conveyorBeds'

// The conveyor beds and their ends live in conveyorBeds.ts, re-exported here for the callers that read every part's
// geometry from this module.
export {
  bedOf,
  bedView,
  conveyorEndsOf,
  conveyorLocalEnds,
  curvedGizmoOf,
  faceHandleOfPkg,
  isBeltLike,
  isConveyorLike,
  jointRestValue,
  pathHandleOfPkg,
  rectangleBedOf,
  resolveInclineRad,
  rigInclineRad,
  sdkCurvedLocalEnds,
  sdkSpurCorners,
  sdkSpurFaceX,
  type BedKind,
  type BeltLikeView,
  type CurvedConveyorView,
  type CurvedGizmo,
  type FaceHandleKeys,
  type LocalEnd,
  type PartEnd,
  type RotatingDeckView,
  type SpurConveyorView,
  type StraightConveyorView,
} from '../conveyor/conveyorBeds'
export { toLocalXZ, toWorldXZ } from '../transforms'

export const DEG = Math.PI / 180

/** True for a part that opens a conveyor's side guard where it mounts (the pop-up diverter, whose arms cross it):
 *  it declares a `conveyorGuard` mount that `opens`. A sensor's mount leaves `opens` unset: its beam crosses the
 *  guard without a hole. Cheap predicate for the opening broad-phase; {@link guardPusherContacts} + the geometry
 *  check gate the real opening. (Package format 2 read "opens" off a mount facing `out`; see docs/part-snap-cuts.md.) */
export function isGuardPusher(part: PartInstance): boolean {
  if (part.type !== 'part') return false
  const mounts = getPackage(part.packageId)?.snap?.mounts
  return !!mounts?.some((m) => m.opens === true && m.accepts === 'conveyorGuard')
}

/**
 * The push-side guard contacts of a mounted pusher device (the pop-up diverter) as synthetic {@link PartEnd}s -
 * one per `conveyorGuard` mount that `opens`. Each contact's `x`/`z` is the mount's push-side point in world XZ,
 * its `out` the device's outward normal (away from the belt: local +Z for a mount facing `out`, −Z for `in`), and its `faceWidth` the device's extent
 * along the host centreline (its footprint X - a perpendicular mount aligns local X with the host length). This
 * lets a diverter open a conveyor's side guard through the same geometry-derived path as a butting conveyor end
 * (the opening resolver treats a diverter's push-side port exactly like a conveyor end): the
 * guard opens on the side the diverter mounts, so its telescoping arms pass through it. [] for non-pushers. */
export function guardPusherContacts(part: PartInstance): PartEnd[] {
  if (part.type !== 'part') return []
  const mounts = getPackage(part.packageId)?.snap?.mounts
  if (!mounts?.length) return []
  const half = partFootprint(part).hx // half-extent along the device's local X = along the host length once mounted
  const out: PartEnd[] = []
  for (const m of mounts) {
    if (m.opens !== true || m.accepts !== 'conveyorGuard') continue
    const p = toWorldXZ(part, m.at[0], m.at[2])
    const o = rotateXZ(0, m.face === 'out' ? 1 : -1, part.rotationY) // away from the belt: +Z faces out, −Z faces in
    // y is the seat: the rail height the mount snapped against (seatOnRail drops the origin yOffset below it), so a
    // seated pusher meets its host's surface exactly, whatever height its arms work at. The raw mount point sits
    // yOffset (0.2) off the surface, which clears the junction height gate only while guards are 0.3 tall.
    out.push({ partId: part.id, end: 'front', x: p.x, y: part.position[1] + m.at[1] + (m.yOffset ?? 0), z: p.z, outX: o.x, outZ: o.z, faceWidth: half * 2 })
  }
  return out
}

/**
 * Instance length (local X) and width (local Z) for a custom part whose size is `face`-handle driven,
 * falling back to the package's static default for any axis it doesn't resize. The baked `deck`/`bounds`
 * dims are only the authoring default. A resizable part (floor-marking, fence, resized rack/platform)
 * carries its real size in its params, so selection/broadphase must read those, not the static box.
 */
function reflowFaceDims(part: PartInstance, defLength: number, defWidth: number): { length: number; width: number } {
  const resize = effectiveResize(part)
  const pkg = part.type === 'part' ? getPackage(part.packageId) : undefined
  const p = part.params as Record<string, unknown>
  const dim = (axis: 'x' | 'z', def: number): number => {
    if (!resize[axis]) return def // the part doesn't resize this axis - keep the baked default
    // the instance's value, else the param's default (what geometry() draws), and the baked size only past both
    const v = resolvedParam(pkg?.params, p, resizeParamKey(part, axis))
    return typeof v === 'number' && v > 0 ? v : def
  }
  return { length: dim('x', defLength), width: dim('z', defWidth) }
}

/**
 * {@link reflowFaceDims} for the vertical axis: the instance height of a part that declares a `face` handle on
 * axis 'y'. As with the XZ reflow, the baked `bounds.top` is only the authoring default. Without this, a part
 * whose height is a param (a primitive-shape block) would report a fixed-height footprint box. The top resize
 * dot (placed at `y1`) would sit at the wrong height and its drag would jump, and box-select / broadphase would
 * under-cover a tall one. Reads the handle's declared param, the same key {@link resizeParamKey} gives the drag,
 * so the dot and the value it writes stay in sync.
 */
function reflowFaceHeight(part: PartInstance, defHeight: number): number {
  if (!effectiveResize(part).y) return defHeight // no vertical handle - keep the baked default
  const pkg = part.type === 'part' ? getPackage(part.packageId) : undefined
  const v = resolvedParam(pkg?.params, part.params as Record<string, unknown>, resizeParamKey(part, 'y'))
  return typeof v === 'number' && v > 0 ? v : defHeight
}

/**
 * local XZ half-extents of the part's footprint (selection, rubber band, focus).
 * `cx` / `cz` are the footprint box's local-X / local-Z centre relative to the part origin (absent = 0). `cx` is
 * non-zero for the straight conveyors, whose origin sits at the tail (tail-origin convention) while the bed
 * extends toward +x, and for a part whose bounds declare `centerX`; `cz` only for a part whose bounds declare
 * `centerZ` (the diverter, whose origin sits toward its push face). Every consumer that builds the box from this
 * offsets it by both.
 */
export const partFootprint = memoByParams(function partFootprintUncached(part: PartInstance): { hx: number; hz: number; y0: number; y1: number; cx?: number; cz?: number } {
  switch (part.type) {
    case 'building':
      return {
        hx: (part.params.lengthSections * BUILDING_SECTION_SIZE) / 2,
        hz: (part.params.widthSections * BUILDING_SECTION_SIZE) / 2,
        y0: 0,
        y1: buildingEaveHeight(part.params.heightSections),
      }
    case 'group':
      // a container node has no geometry; a zero footprint keeps it out of band-select/snap
      return { hx: 0, hz: 0, y0: 0, y1: 0 }
    case 'annotation':
      // a note has no geometry either. It is picked by clicking its screen-space chip, never by hitting a
      // volume in the scene, so a zero footprint (out of band-select, snap and drop-rest) is correct
      return { hx: 0, hz: 0, y0: 0, y1: 0 }
    case 'part': {
      // A conveyor's footprint reflows with its bed's live params (a belt's segments, a straight's face handles, a
      // spur's splay, a curve's sweep), not the baked bounds, so selection, snap and drop-rest track a resized bed.
      const bed = bedOf(part)
      if (bed) return bed.footprint(part)
      // C-cargo (a dynamic-cargo package): a centre-origin box reflowing with the instance's size params,
      // like the built-in box/pallet, so floorRest seats the underside on the floor and
      // collision-vertex snap / the pick proxy see the true box.
      const cargo = cargoView(part)
      if (cargo) return { hx: cargo.halfExtents[0], hz: cargo.halfExtents[2], y0: -cargo.halfExtents[1], y1: cargo.halfExtents[1] }
      // Rig/drawn/cargo: their declared `bounds` box (a default until authored). An
      // unresolved package yields a zero footprint until it loads.
      const pkg = getPackage(part.packageId)
      if (!pkg) return { hx: 0, hz: 0, y0: 0, y1: 0 }
      // a flex conveyor (a `flexPath` handle): its bed runs from the origin along its fitted sections, so it may bend or
      // double back and the box is the plan of those sections, not the bounds centred on the origin (which put a
      // straight default bed half outside its own box). The bounds give the cross-section: `width` is the bed and frame
      // across, `length` minus the bed length is what the frame overhangs at the two ends, `top` / `bottom` its height.
      const flex = flexPathOf(part)
      if (flex && pkg.geometry.kind === 'rig' && pkg.geometry.bounds) {
        const rb = resolvedBounds(pkg.geometry.bounds, part.params as unknown as RigParams)
        const fit = flexStations(flex.points, flex.sections)
        const st = fit.stations
        const side = rb.width / 2
        const endPad = Math.min(Math.max((rb.length - fit.pitch * flex.sections) / 2, 0), side)
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
        for (let i = 0; i + 1 < st.length; i++) {
          const [ax, az] = st[i]!
          const [bx, bz] = st[i + 1]!
          const len = Math.hypot(bx - ax, bz - az)
          if (len < 1e-9) continue
          const ux = (bx - ax) / len, uz = (bz - az) / len
          const back = i === 0 ? endPad : 0
          const ahead = i + 2 === st.length ? endPad : 0
          for (const [px, pz] of [[ax - ux * back, az - uz * back], [bx + ux * ahead, bz + uz * ahead]] as const) {
            for (const s of [-1, 1]) {
              const x = px - uz * side * s, z = pz + ux * side * s
              x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z)
            }
          }
        }
        if (x0 <= x1) return { hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, y0: rb.bottom, y1: rb.top }
      }
      // a cargo box's footprint is its size, from the floor up (the placement convention for dropped cargo); a
      // pallet's or a tote's is the standard size its size param picks
      const sized = pkg.geometry.kind === 'cargo' && pkg.geometry.cargoKind !== 'box' ? cargoView(part) : null
      const bounds = sized
        ? { length: sized.halfExtents[0] * 2, width: sized.halfExtents[2] * 2, top: sized.halfExtents[1] * 2 }
        : pkg.geometry.kind === 'cargo' ? { length: pkg.geometry.size.length, width: pkg.geometry.size.width, top: pkg.geometry.size.height } : pkg.geometry.bounds
      if (bounds) {
        // A conveyor-mounted rig (blade stop, chain transfer) has its origin at the belt surface, so its
        // mechanism (housing, deck, chain lanes) hangs below y=0. Its true underside is the declared
        // `bounds.bottom` (≤ 0; baked by the build script from the assembled model, incl. the GLB meshes core
        // can't measure). Folding it into `y0` seats that underside on the floor when the part is dropped
        // free-standing, instead of seating the origin on y=0 and sinking the mechanism through it. Absent ⇒ 0
        // (a bottom-origin, floor-standing part). A stair whose sloped stringer corner clips below the origin is
        // not lifted, since it declares no bottom.
        // Fields the bounds tie to the part's own params (PartBounds.params) follow the instance: a pusher's
        // length and centre track its stroke, its bottom its stand height.
        const rb = resolvedBounds(bounds, part.params as unknown as RigParams)
        const y0 = rb.bottom
        // A resizable part (floor-marking, fence, resized rack…) drives its true length/width from its
        // `face`-handle params; the baked `bounds` are only the authoring default. Read statically, they give
        // every floor-marking a fixed 2x8 footprint regardless of size, and band-select / broadphase see a
        // phantom box far bigger than the part. Reflow each face-handle axis from the instance params.
        const d = reflowFaceDims(part, rb.length, rb.width)
        return {
          hx: d.length / 2,
          hz: d.width / 2,
          y0,
          y1: reflowFaceHeight(part, rb.top),
          ...(rb.centerX !== 0 ? { cx: rb.centerX } : {}),
          ...(rb.centerZ !== 0 ? { cz: rb.centerZ } : {}),
        }
      }
      // a rig without declared bounds: the box its links fill at rest (a part made in the app, or written without
      // bounds), else a default unit box when core can't measure it (a model link: the author declares bounds)
      if (pkg.geometry.kind === 'rig') {
        const e = rigRestExtent(pkg.geometry, part.params as unknown as RigParams)
        if (!e) return { hx: 0.5, hz: 0.5, y0: 0, y1: 1 }
        const cx = (e.min[0] + e.max[0]) / 2
        const cz = (e.min[2] + e.max[2]) / 2
        return { hx: (e.max[0] - e.min[0]) / 2, hz: (e.max[2] - e.min[2]) / 2, y0: e.min[1], y1: e.max[1], ...(Math.abs(cx) > 1e-9 ? { cx } : {}), ...(Math.abs(cz) > 1e-9 ? { cz } : {}) }
      }
      return { hx: 0, hz: 0, y0: 0, y1: 0 }
    }
  }
})

// the rack's frame/shelf thicknesses, shared by the visual + physics.
export const RACK_FRAME_THICKNESS = 0.08
export const RACK_SHELF_THICKNESS = 0.04

/** one axis-aligned box of the rack, centered at (x, y, z) with full sizes (sx, sy, sz). */
export interface RackBox {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
}

/**
 * Rack structure split by role so the renderer can draw every piece while the
 * physics collides only what cargo can actually touch (load beams sit flush under
 * the shelf slab, so they're visual-only). All boxes are in the part-local frame
 * centered on the origin: X ∈ [−length/2, length/2], Z ∈ [−width/2, width/2], Y up
 * from the floor - built at [0,size] with the body offset by −size/2.
 */
export interface RackGeometry {
  /** vertical uprights - a full pole grid, or four corners when auto-poles is off */
  posts: RackBox[]
  /** front/back horizontal beams at every level (incl. the open floor): the shelf-edge lip */
  supports: RackBox[]
  /** grid of beams just beneath each shelf (auto-poles only) - decorative, no collision */
  loadBeams: RackBox[]
  /** shelf slabs above the open floor */
  shelves: RackBox[]
}

/**
 * the rack's axis-position rule: posts at 0, interval, 2·interval, … then one
 * at the far end (the last bay may be shorter than `interval`).
 */
function rackAxisPositions(len: number, interval: number): number[] {
  const positions = [0]
  for (let pos = interval; pos < len - 0.001; pos += interval) positions.push(pos)
  if (len > 0.001) positions.push(len)
  return positions
}

/**
 * The geometry-relevant subset of the retired built-in Rack's params. With {@link rackBoxes}, this shape and
 * layout formula are the reference the SDK "Rack" custom part is pinned against (rackRigParity.test.ts).
 */
export interface RackGeometryParams {
  length: number
  width: number
  numShelves: number
  shelfSpacing: number
  enableAutoPoles: boolean
  poleInterval: number
}

/** Build the Rack box layout from its params. */
export function rackBoxes(p: RackGeometryParams): RackGeometry {
  const F = RACK_FRAME_THICKNESS
  const S = RACK_SHELF_THICKNESS
  const L = p.length // width  (local X)
  const D = p.width // depth  (local Z)
  const hl = L / 2
  const hd = D / 2
  const height = p.numShelves * p.shelfSpacing

  const posts: RackBox[] = []
  const supports: RackBox[] = []
  const loadBeams: RackBox[] = []
  const shelves: RackBox[] = []

  // local→centered: built at [0,L]×[0,D], body offset by (−L/2, 0, −D/2)
  const cx = (x: number): number => x - hl
  const cz = (z: number): number => z - hd

  // uprights - an end frame every poleInterval along X, or the four corners when auto-poles is off. Across Z a
  // pallet-rack frame is always two uprights, front and back, however deep it is.
  const xs = p.enableAutoPoles ? rackAxisPositions(L, p.poleInterval) : [0, L]
  const zs = [0, D]
  for (const x of xs)
    for (const z of zs) posts.push({ x: cx(x), y: height / 2, z: cz(z), sx: F, sy: height, sz: F })

  // shelves (bottom level left open), plus the load-distribution beam grid beneath each
  for (let i = 0; i < p.numShelves; i++) {
    const y = (i + 1) * p.shelfSpacing
    shelves.push({ x: 0, y, z: 0, sx: L, sy: S, sz: D })
    if (!p.enableAutoPoles) continue
    const beamY = y - S / 2 - F / 2
    for (const z of zs)
      for (let w = 0; w < xs.length - 1; w++) {
        const len = xs[w + 1]! - xs[w]!
        loadBeams.push({ x: cx(xs[w]! + len / 2), y: beamY, z: cz(z), sx: len, sy: F, sz: F })
      }
    for (const x of xs)
      for (let d = 0; d < zs.length - 1; d++) {
        const len = zs[d + 1]! - zs[d]!
        loadBeams.push({ x: cx(x), y: beamY, z: cz(zs[d]! + len / 2), sx: F, sy: F, sz: len })
      }
  }

  // front/back horizontal supports at every level, including the open floor
  for (let i = 0; i <= p.numShelves; i++) {
    const y = i * p.shelfSpacing
    for (const z of [0, D]) supports.push({ x: 0, y, z: cz(z), sx: L - F, sy: F, sz: F })
  }

  return { posts, supports, loadBeams, shelves }
}

/**
 * Vertical center of the resize-handle box: the logical size box, not
 * partFootprint. Resize handles anchor to the logical size box, so for conveyors
 * - whose footprint dips to the legs (y0 ≈ -0.4) - the dots sit on the conveyor
 * surface (mid_y = 0). Bottom-anchored parts (rails, despawner) already match the footprint.
 */
/** True when a custom part's rig lays out a world-phase roller grid (an array-link with
 *  `distribute.worldPhase`) - i.e. an SDK straight roller bed whose rollers snap to the shared world pitch
 *  grid. The seam resolver treats such a part as a straight roller node so its grid phase inherits a butted
 *  curve's anchor / propagates down a collinear chain (docs/seam-resolvers.md). */
export function isWorldPhaseRollerBed(part: PartInstance): boolean {
  if (part.type !== 'part') return false
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  return pkg.geometry.links.some((l) => l.array?.distribute?.worldPhase === true)
}

/**
 * Local deck point (XZ, part frame) of a curved conveyor's arc gizmo handle - the curved-conveyor
 * gizmo's redraw layout, made convention-aware. Angle 0 sits at the arc entry; the 'angle' dot sits at the arc end on the
 * centreline radius, the 'width' dot the arc midpoint at the outer radius. The two families mirror in X:
 * built-in point(t,r) = (r·sin t, r·cos t) sweeps +Z→+X; SDK point(t,r) = (r·cos t, −r·sin t) sweeps +X→−Z.
 */
export function curvedHandleLocal(g: CurvedGizmo, which: 'angle' | 'width'): { x: number; z: number } {
  const arcPoint = (t: number, r: number): { x: number; z: number } =>
    g.sdk ? { x: r * Math.cos(t), z: -r * Math.sin(t) } : { x: r * Math.sin(t), z: r * Math.cos(t) }
  const sweep = g.sweepDeg * DEG
  return which === 'angle'
    ? arcPoint(sweep, g.innerRadius + g.width / 2)
    : arcPoint(sweep / 2, g.innerRadius + g.width)
}

/**
 * Inverse of {@link curvedHandleLocal}: the dragged param value (sweep degrees for 'angle', belt width for
 * 'width') read from a local deck point the pointer projects to. Convention-aware, so an SDK curve drags the
 * same way the built-in does despite the mirrored arc.
 */
export function curvedHandleValue(g: CurvedGizmo, param: 'angle' | 'width', lx: number, lz: number): number {
  if (param === 'angle') {
    // inverse of arcPoint: built-in x=sin·r, z=cos·r → atan2(x, z); SDK x=cos·r, z=−sin·r → atan2(−z, x)
    return (g.sdk ? Math.atan2(-lz, lx) : Math.atan2(lx, lz)) / DEG
  }
  return Math.hypot(lx, lz) - g.innerRadius
}

/**
 * A flex conveyor's path handle (docs/part-gizmos.md, the `flexPath` kind): the [x, z] control points its bed runs
 * through (core/conveyor/flexPath.ts), the param keys holding them and the bed length they imply, and the section count.
 * Null for a part without the handle.
 */
export interface FlexPathGizmo {
  points: [number, number][]
  sections: number
  /** the sharpest hinge the part's sections can take, radians (the handle's maxHingeDeg; default 45 degrees) */
  maxHinge: number
  pointsKey: string
  lengthKey: string
  /** each end's caster brakes are on (the handle's infeedBrakeParam / dischargeBrakeParam; off when undeclared) */
  braked: { infeed: boolean; discharge: boolean }
  /** a scissor bed (the handle's `scissor`): its rollers a section and its width now; null for a plain hinged bed */
  scissor: { rollers: number; width: number } | null
}

interface FlexKeys {
  pointsKey: string
  lengthKey: string
  sections: number
  maxHinge: number
  infeedBrakeKey?: string
  dischargeBrakeKey?: string
  scissor?: { widthKey: string; rollers: number }
}

const flexKeysMemo = memoByPkg(function flexKeysUncached(pkg: NonNullable<ReturnType<typeof getPackage>>): FlexKeys | null {
  for (const [key, spec] of Object.entries(pkg.params)) {
    const h = (spec as {
      handle?: {
        kind?: string
        lengthParam?: string
        sections?: number
        maxHingeDeg?: number
        infeedBrakeParam?: string
        dischargeBrakeParam?: string
        scissor?: { widthParam?: string; rollers?: number }
      }
    }).handle
    if (h?.kind === 'flexPath' && typeof h.lengthParam === 'string') {
      const deg = typeof h.maxHingeDeg === 'number' && h.maxHingeDeg > 0 ? h.maxHingeDeg : 45
      const sc = h.scissor
      return {
        pointsKey: key,
        lengthKey: h.lengthParam,
        sections: Math.max(1, Math.round(h.sections ?? 1)),
        maxHinge: deg * DEG,
        infeedBrakeKey: typeof h.infeedBrakeParam === 'string' ? h.infeedBrakeParam : undefined,
        dischargeBrakeKey: typeof h.dischargeBrakeParam === 'string' ? h.dischargeBrakeParam : undefined,
        scissor: sc && typeof sc.widthParam === 'string' && typeof sc.rollers === 'number' && sc.rollers >= 1
          ? { widthKey: sc.widthParam, rollers: Math.round(sc.rollers) }
          : undefined,
      }
    }
  }
  return null
})

export function flexPathOf(part: PartInstance): FlexPathGizmo | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg) return null
  const keys = flexKeysMemo(pkg)
  if (!keys) return null
  // each read is the instance's value, else the param's default: the size the part's geometry() draws
  const own = part.params as unknown as Record<string, unknown>
  const param = (key: string): unknown => resolvedParam(pkg.params, own, key)
  const raw = param(keys.pointsKey)
  const points = Array.isArray(raw)
    ? raw.filter((r): r is number[] => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])).map((r): [number, number] => [r[0]!, r[1]!])
    : []
  const braked = {
    infeed: keys.infeedBrakeKey !== undefined && param(keys.infeedBrakeKey) === true,
    discharge: keys.dischargeBrakeKey !== undefined && param(keys.dischargeBrakeKey) === true,
  }
  const width = keys.scissor ? param(keys.scissor.widthKey) : undefined
  const scissor = keys.scissor && typeof width === 'number' && width > 0 ? { rollers: keys.scissor.rollers, width } : null
  return { points, sections: keys.sections, maxHinge: keys.maxHinge, pointsKey: keys.pointsKey, lengthKey: keys.lengthKey, braked, scissor }
}

/**
 * The sharpest hinge a flex can take at bed length `length`. A plain hinged bed: its handle's maxHingeDeg. A scissor
 * bed (the handle's `scissor`) also has to keep every roller gap in range. Its rollers are drawn fanned (each
 * section's turned from half its infeed hinge back to half its discharge hinge forward), so no gap turns more than
 * the sharpest hinge / rollers a section; a gap turned by phi at centre spacing s is s - 2(w/2)tan(phi/2) apart at
 * the inside ends of its rollers and s + that at the outside, and those must stay between the spacing fully
 * collapsed and fully extended (the length param's range, over every roller). So the room is the nearer of the two,
 * and a bed at either end of its range cannot bend at all.
 */
export function flexHingeLimit(part: PartInstance, g: FlexPathGizmo, length: number): number {
  const lr = partNumberRange(part, g.lengthKey)
  if (!g.scissor || !lr || !Number.isFinite(lr.min) || !Number.isFinite(lr.max)) return g.maxHinge
  const gaps = g.sections * g.scissor.rollers
  const room = Math.min(length - lr.min, lr.max - length) / gaps
  if (!(room > 0)) return 0
  return Math.min(g.maxHinge, g.scissor.rollers * 2 * Math.atan(room / g.scissor.width))
}

/** what a flex conveyor is pulled by: one of its path control points (an index into `points`), or one of its ends by
 *  name. Hold an end by name when the pull may re-lay the path: a walk's chain drag re-fits the bed through a
 *  control point per hinge, so the discharge end's index changes under the hands */
export type FlexGrip = number | 'infeed' | 'discharge'

/** a flex conveyor's pose and the params its shape writes (the points and the bed length they imply) */
export interface FlexPose {
  position: [number, number, number]
  rotationY: number
  params: Record<string, unknown>
}

/** `part` laid in `pose`: every place a pulled flex is shown (the editor's drag transient, the walk's overlay) */
export function withFlexPose(part: PartInstance, pose: FlexPose): PartInstance {
  return { ...part, position: pose.position, rotationY: pose.rotationY, params: { ...part.params, ...pose.params } } as unknown as PartInstance
}

/** yaw of the world direction a -> b (the rotateXZ convention: local +X at yaw y points along (cos y, -sin y)) */
const yawTo = (ax: number, az: number, bx: number, bz: number): number => Math.atan2(-(bz - az), bx - ax)

/** where `grip` sits in the world, or null when the part has no such grip */
function flexGripWorld(part: PartInstance, g: FlexPathGizmo, grip: number | 'infeed'): { x: number; z: number } | null {
  if (grip === 'infeed') return { x: part.position[0], z: part.position[2] }
  const p = g.points[grip]
  return p ? toWorldXZ(part, p[0], p[1]) : null
}

/**
 * The flex with `grip` moved to world (wx, wz) and everything else held where it is in the world, whether or not
 * the part can take that shape. A control point moves alone (the pose holds). The infeed moves the part's origin
 * there and swings its heading by the turn the infeed-to-first-point line makes, so the first section keeps the
 * set it had (a small pull is a small swing, never a snap onto a new heading); every control point is then
 * re-expressed in the new frame, so the discharge end and the middle of the path stay put.
 */
function flexCandidate(part: PartInstance, g: FlexPathGizmo, grip: number | 'infeed', wx: number, wz: number): FlexFit | null {
  let position = part.position
  let rotationY = part.rotationY
  let points: [number, number][]
  if (grip === 'infeed') {
    const first = g.points[0]
    if (!first) return null
    const w0 = toWorldXZ(part, first[0], first[1])
    if (Math.hypot(w0.x - wx, w0.z - wz) < 1e-6) return null
    rotationY = part.rotationY + yawTo(wx, wz, w0.x, w0.z) - yawTo(part.position[0], part.position[2], w0.x, w0.z)
    position = [wx, part.position[1], wz]
    const moved = { ...part, position, rotationY } as PartInstance
    points = g.points.map((q): [number, number] => {
      const w = toWorldXZ(part, q[0], q[1])
      const l = toLocalXZ(moved, w.x, w.z)
      return [l.x, l.z]
    })
  } else {
    const l = toLocalXZ(part, wx, wz)
    points = g.points.map((q, k): [number, number] => (k === grip ? [l.x, l.z] : q))
  }
  return flexFit(part, g, [position[0], position[1], position[2]], rotationY, points)
}

/** a candidate shape judged: its pose, whether the part can take it, and if not, whether it was for length */
interface FlexFit {
  pose: FlexPose
  tooLong: boolean
  tooShort: boolean
  ok: boolean
}

/** fit the sections through `points` (part-local in the pose given) and judge the result against the part's limits */
function flexFit(part: PartInstance, g: FlexPathGizmo, position: [number, number, number], rotationY: number, points: [number, number][]): FlexFit {
  const fit = flexStations(points, g.sections)
  const length = fit.pitch * g.sections
  const lr = partNumberRange(part, g.lengthKey)
  const tooLong = !!lr && length > lr.max
  const tooShort = !!lr && length < lr.min
  // a hair of slack: a straight bed fits with hinges of float noise, and a collapsed scissor bed may bend by nothing
  const ok = Number.isFinite(length) && !tooShort && !tooLong && fit.maxHinge <= flexHingeLimit(part, g, length) + 1e-9
  return { pose: { position, rotationY, params: { [g.pointsKey]: points, [g.lengthKey]: length } }, tooLong, tooShort, ok }
}

/** the hinge stations of `part`'s current fit, in the world, infeed first */
function flexWorldStations(part: PartInstance, g: FlexPathGizmo): { x: number; z: number }[] {
  return flexStations(g.points, g.sections).stations.map(([x, z]) => toWorldXZ(part, x, z))
}

/** how much of the hinge limit a chain drag may use: the curve the sections are refitted along bends a little more */
const CHAIN_HINGE_SHARE = 0.85

/**
 * The walk's hands dragging a flex by one of its ends further than it can stretch or bend: the whole unit follows
 * like a chain on casters, at `limitLength`. The held end goes to the hands; each hinge after it moves straight
 * toward the one ahead only as far as keeps its section at that pitch (follow-the-leader, the curve a dragged chain
 * or a trailer traces), so the bed swings in behind whoever pulls it, straightens out, and the far end moves last.
 * Pushed past fully collapsed, each section keeps its direction instead, so the stiff collapsed unit goes ahead of
 * the hands as a block. Each hinge is clamped short of the part's limit.
 *
 * The new path is a control point on every hinge, so the equal-chord fit through them reproduces the chain's own
 * hinges. A sparser curve through a tight bed would bend harder than the chain did and break the hinge limit it was
 * clamped to. So the point count changes, and an end is held by name (FlexGrip). The pitch is nudged until the fit
 * matches the length. Null when no fit the part can take comes out of it (the caller then stops instead).
 */
function flexChainDrag(part: PartInstance, g: FlexPathGizmo, infeedHeld: boolean, wx: number, wz: number, limitLength: number, push: boolean): FlexPose | null {
  const n = g.sections
  // the chain from the held end: world stations, reversed when the discharge end is held
  const old = flexWorldStations(part, g)
  if (!infeedHeld) old.reverse()
  const hinge = flexHingeLimit(part, g, limitLength) * CHAIN_HINGE_SHARE
  let pitch = limitLength / n
  for (let iter = 0; iter < 6; iter++) {
    const c: { x: number; z: number }[] = [{ x: wx, z: wz }]
    for (let j = 1; j <= n; j++) {
      const a = c[j - 1]!
      // pulled: toward where the next hinge stands (it swings in behind). Pushed: along the section as it lay, since
      // the hands have passed the hinges ahead and "toward" would fold the bed back over them; a collapsed unit is
      // stiff, and goes as a block
      let dx = push ? old[j]!.x - old[j - 1]!.x : old[j]!.x - a.x
      let dz = push ? old[j]!.z - old[j - 1]!.z : old[j]!.z - a.z
      const d = Math.hypot(dx, dz)
      if (d < 1e-9) {
        // standing right on the hinge ahead: carry on in the direction the chain was already going
        dx = j >= 2 ? a.x - c[j - 2]!.x : old[j]!.x - old[j - 1]!.x
        dz = j >= 2 ? a.z - c[j - 2]!.z : old[j]!.z - old[j - 1]!.z
      }
      let ux = dx / (Math.hypot(dx, dz) || 1), uz = dz / (Math.hypot(dx, dz) || 1)
      if (j >= 2) {
        // clamp the hinge between this section and the one ahead
        const p = c[j - 2]!
        const px = (a.x - p.x) / (Math.hypot(a.x - p.x, a.z - p.z) || 1), pz = (a.z - p.z) / (Math.hypot(a.x - p.x, a.z - p.z) || 1)
        const turn = Math.atan2(px * uz - pz * ux, px * ux + pz * uz)
        if (Math.abs(turn) > hinge) {
          const t = Math.sign(turn) * hinge, cs = Math.cos(t), sn = Math.sin(t)
          ux = px * cs - pz * sn
          uz = px * sn + pz * cs
        }
      }
      c.push({ x: a.x + ux * pitch, z: a.z + uz * pitch })
    }
    // back to the part's frame: infeed first, the origin on it, heading along the first section
    if (!infeedHeld) c.reverse()
    const position: [number, number, number] = [c[0]!.x, part.position[1], c[0]!.z]
    const rotationY = yawTo(c[0]!.x, c[0]!.z, c[1]!.x, c[1]!.z)
    const frame = { ...part, position, rotationY } as PartInstance
    const points = c.slice(1).map((s): [number, number] => {
      const l = toLocalXZ(frame, s.x, s.z)
      return [l.x, l.z]
    })
    const fit = flexFit(part, g, position, rotationY, points)
    if (fit.ok) return fit.pose
    // the curve through the hinges runs a little longer or shorter than the chain: scale the pitch to match the length
    const got = fit.pose.params[g.lengthKey] as number
    if (!Number.isFinite(got) || got <= 0) return null
    pitch *= limitLength / got
  }
  return null
}

/**
 * Pull a flex conveyor by `grip` toward world (wx, wz): the pose and params it takes, or null when it cannot move
 * at all. The one rule behind every way the bed is pulled: the editor's path dots (authoring) and the walking
 * character's hands (a walk-session overlay, controller/pilot.ts).
 *
 * The far end never moves: pulling a control point holds the infeed, pulling the infeed holds every control point.
 * A pull the part cannot take (a length outside its param's range, a hinge past its limit) goes as far as it can
 * along the straight line from where the grip is now toward the target, and stops at the limit there, like a real
 * bed at full stretch, rather than freezing wherever the last accepted pointer sample happened to be.
 *
 * `dragAlong` is the walk's hands. Held by an end, a pull the bed cannot take by stretching or bending moves the
 * whole unit instead, as a real flex on casters goes: past full length or round a bend it cannot make it trails
 * behind the hands hinge by hinge, and past fully collapsed it is shoved ahead of them (flexChainDrag). Until then
 * the far end holds. Held by a middle point, or with the far end's caster brakes on, a refused pull still just
 * stops; a braked end cannot be moved by hand at all (null). The editor never passes it: authoring holds the far end
 * where it was put, and sets where the ends stand whatever the brakes say.
 */
export function flexPull(part: PartInstance, held: FlexGrip, wx: number, wz: number, opts?: { dragAlong?: boolean }): FlexPose | null {
  const g = flexPathOf(part)
  if (!g || !Number.isFinite(wx) || !Number.isFinite(wz)) return null
  const grip = held === 'discharge' ? g.points.length - 1 : held
  const isEnd = grip === 'infeed' || grip === g.points.length - 1
  const heldEnd = grip === 'infeed' ? 'infeed' : 'discharge'
  // the walk's hands cannot move a braked end at all; the editor authors where the ends stand, brakes or not
  if (opts?.dragAlong && isEnd && g.braked[heldEnd]) return null
  const from = flexGripWorld(part, g, grip)
  if (!from) return null
  const at = (t: number) => flexCandidate(part, g, grip, from.x + (wx - from.x) * t, from.z + (wz - from.z) * t)
  const full = at(1)
  if (full?.ok) return full.pose
  // ...and a braked far end is never drawn after them: the pull stops at the limit
  const farBraked = g.braked[heldEnd === 'infeed' ? 'discharge' : 'infeed']
  if (opts?.dragAlong && isEnd && !farBraked && full) {
    // the bed at the length the pull leaves it: the limit it ran into, or where it is now when a hinge refused it
    // (just inside a limit, so the chain's resulting fit is one the part can take)
    const lr = partNumberRange(part, g.lengthKey) ?? { min: 0, max: Number.POSITIVE_INFINITY }
    const now = flexStations(g.points, g.sections).pitch * g.sections
    const length = full.tooLong ? lr.max - 1e-4 : full.tooShort ? lr.min + 1e-4 : Math.min(Math.max(now, lr.min + 1e-4), lr.max - 1e-4)
    const chained = flexChainDrag(part, g, grip === 'infeed', wx, wz, length, full.tooShort)
    if (chained) return chained
  }
  // the furthest along the line the part can take: bisect between here (a shape it has) and the refused target
  const here = at(0)
  if (!here?.ok) return null
  let lo = 0, hi = 1
  let best = here
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const c = at(mid)
    if (c?.ok) {
      lo = mid
      best = c
    } else hi = mid
  }
  return lo > 1e-9 ? best.pose : null
}

/**
 * The resize axes a part actually offers, package-driven for custom parts (docs/part-gizmos.md). Built-ins
 * keep their static {@link PART_DEFS} flag; a custom part derives `{ x, y, z }` from its declared `face`
 * handles (and a `path` handle, whose length runs along local X). Used by the resize-handle visibility check.
 */
export function effectiveResize(part: PartInstance): { x?: boolean; y?: boolean; z?: boolean } {
  if (part.type !== 'part') return PART_DEFS[part.type].resize
  const pkg = getPackage(part.packageId)
  if (!pkg) return {}
  const out: { x?: boolean; y?: boolean; z?: boolean } = {}
  for (const spec of Object.values(pkg.params)) {
    const h = (spec as { handle?: { kind?: string; axis?: 'x' | 'y' | 'z' } }).handle
    if (!h) continue
    if (h.kind === 'face') {
      if (h.axis === 'x') out.x = true
      else if (h.axis === 'y') out.y = true
      else if (h.axis === 'z') out.z = true
    } else if (h.kind === 'path') {
      out.x = true // a path handle owns length along local X
    }
  }
  return out
}

/** The min/max of a part's numeric param - from {@link PART_DEFS} for built-ins, the package schema for
 *  custom parts - so a face-handle drag clamps the same way regardless of part origin. Null if not numeric. */
export function partNumberRange(part: PartInstance, key: string): { min: number; max: number } | null {
  if (part.type === 'part') {
    const spec = getPackage(part.packageId)?.params[key]
    return spec && spec.type === 'number'
      ? { min: spec.min ?? Number.NEGATIVE_INFINITY, max: spec.max ?? Number.POSITIVE_INFINITY }
      : null
  }
  const s = PART_DEFS[part.type].params.find((sp) => sp.key === key)
  return s && s.kind === 'number' ? { min: s.min, max: s.max } : null
}

/** A footprint box ({@link PartBounds}) with its `params` applied against an instance's params: each entry replaces
 *  its field (the same linear rule as a link's sizeParams). A non-positive length or width, or a top that would not
 *  stay above the bottom, keeps the static value instead, so a mis-set param can't invert the box. */
export function resolvedBounds(
  bounds: Pick<PartBounds, 'length' | 'width' | 'top'> & Partial<PartBounds>,
  params: RigParams,
): { length: number; width: number; top: number; bottom: number; centerX: number; centerZ: number } {
  const out = { length: bounds.length, width: bounds.width, top: bounds.top, bottom: bounds.bottom ?? 0, centerX: bounds.centerX ?? 0, centerZ: bounds.centerZ ?? 0 }
  if (!bounds.params?.length) return out
  for (const ref of bounds.params) {
    const v = foldedRef(out[ref.field], ref, params)
    if (v === null) continue
    if ((ref.field === 'length' || ref.field === 'width') && !(v > 0)) continue
    out[ref.field] = v
  }
  if (!(out.top > out.bottom)) {
    out.top = bounds.top
    out.bottom = bounds.bottom ?? 0
  }
  return out
}

/** The name of a part's `rest: 'surfaceBelow'` param (a host-resolved placement fact - the host stands the
 *  part's deck `standHeight` above the surface beneath it at drop/snap so its legs reach the floor/platform,
 *  while geometry() stays a pure function of params), or null for any other part. */
export function surfaceBelowParam(part: PartInstance): string | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg) return null
  for (const name of Object.keys(pkg.params)) if (pkg.params[name]?.rest === 'surfaceBelow') return name
  return null
}

export function resizeHandleMidY(part: PartInstance): number {
  // a belt, straight or spur bed sits at local y=0, so its resize dots sit on the conveying surface rather than the
  // leg-dipped footprint mid-height
  if (bedOf(part)?.resizeOnDeck) return 0
  const fp = partFootprint(part)
  return (fp.y0 + fp.y1) / 2
}

/**
 * Drop-placement offset:
 * given a collision point + outward surface normal, return the part origin that
 * sits the part's footprint box flush against the surface while staying upright
 * (yaw only). For a floor (normal +Y) this rests the box bottom on the point;
 * for a vertical face it pushes the box out by its half-extent along the normal.
 *
 * Closed form of "offset the box so its face touches the surface": the offset
 * along the normal is the negated minimum projection of the (yaw-rotated)
 * footprint box onto that normal.
 */
export function restOnSurface(
  part: PartInstance,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
): [number, number, number] {
  const fp = partFootprint(part)
  // normal in the part's local frame (yaw only; world +Y is unaffected)
  const local = rotateXZ(normal[0], normal[2], -part.rotationY)
  const ny = normal[1]
  const cy = (fp.y0 + fp.y1) / 2
  const hy = (fp.y1 - fp.y0) / 2
  // -cx*local.x / -cz*local.z re-base off the box's local centre (tail-origin conveyors, an off-centre bounds box);
  // 0 for centred parts
  const offset =
    -cy * ny - (fp.cx ?? 0) * local.x - (fp.cz ?? 0) * local.z + fp.hx * Math.abs(local.x) + hy * Math.abs(ny) + fp.hz * Math.abs(local.z)
  return [point[0] + normal[0] * offset, point[1] + normal[1] * offset, point[2] + normal[2] * offset]
}

/**
 * Where a part stands free on the floor at (x, z): the pose it takes with nothing else under it. A legged
 * deck (`rest: 'surfaceBelow'`, e.g. the SDK belt conveyor) holds its deck `standHeight` above the floor so
 * its legs reach down to it. Everything else seats its footprint underside flush on the floor plane. That is
 * `bounds.bottom`-aware, so a conveyor-mounted rig whose origin is the belt surface puts its housing on the
 * floor rather than through it.
 *
 * Every "put this part on the floor" caller uses this: the placement drop / Shift+G reposition
 * (controller.restUnderCursor's no-surface branch) and the origin stamp that opens a package's definition as
 * its own scene (store.enterPackageEdit). If they used different rules, the Diverter would sit below the floor
 * in its own scene while a dropped one rests correctly.
 */
export function floorRestPose(part: PartInstance, x: number, z: number): [number, number, number] {
  const restName = surfaceBelowParam(part)
  if (restName) {
    const sh = (part.params as Record<string, unknown>)[restName]
    return [x, FLOOR_SURFACE_Y + (typeof sh === 'number' && sh > 0 ? sh : 0.75), z]
  }
  return restOnSurface(part, [x, 0, z], [0, 1, 0])
}

export interface ResizeResult {
  position: [number, number, number]
  params: Record<string, ParamValue>
}

/**
 * Face-handle resize semantics: dragging a face handle stretches the part
 * along that local axis while the opposite face stays fixed in world space
 * (geometry is center-origin, so the origin shifts by half the delta along
 * the handle's outward direction).
 *
 * axis: 'x' maps to the length param, 'z' to width (floor marking: x=length,
 * z=width; despawner likewise). sign: which face. newExtent: the new full
 * length/width after clamping by the caller (PART_DEFS min/max).
 */
/**
 * The param key a part's face handle drives. Built-ins use the fixed length/width/height naming; a custom part
 * uses its declared handle param - e.g. the SDK rack's z face writes `depth`, not `width` - so a resize/scale
 * drag targets the param that actually exists (falling back to the built-in name if the handle is absent).
 */
export function resizeParamKey(part: PartInstance, axis: 'x' | 'y' | 'z'): string {
  const builtin = axis === 'x' ? 'length' : axis === 'y' ? 'height' : 'width'
  if (part.type !== 'part') return builtin
  const { lengthKey, widthKey, heightKey } = faceHandleParams(part)
  const declared = axis === 'x' ? lengthKey : axis === 'y' ? heightKey : widthKey
  return declared ?? builtin
}

/** The bay-snap pitch + in-range clamp for a part's X/Z resize face, or null if this face resizes freely.
 *  Built-in rack: whole poleInterval cells while enableAutoPoles is on. Custom part: a face handle that declares
 *  `bayParam` (+ optional boolean `bayGateParam`), clamped to that param's schema min/max. */
function bayResizeSnap(part: PartInstance, axis: 'x' | 'z'): { pitch: number; min: number; max: number } | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg) return null
  const key = resizeParamKey(part, axis)
  const h = (pkg.params[key] as { handle?: { bayParam?: string; bayGateParam?: string } } | undefined)?.handle
  if (!h?.bayParam) return null
  const p = part.params as unknown as Record<string, ParamValue>
  if (h.bayGateParam && !p[h.bayGateParam]) return null
  const range = partNumberRange(part, key)
  return { pitch: Number(p[h.bayParam]), min: range?.min ?? 0, max: range?.max ?? Number.POSITIVE_INFINITY }
}

/**
 * Per-bay footprint snap for a part's X/Z handles (the rack's constrained resize): with the bay snap
 * active, the length/depth lock to whole bay-pitch multiples (≥ one bay), so dragging grows the part a bay at
 * a time, snapped to the nearest in-range multiple. Any part without a declared bay snap resizes freely.
 */
export function constrainResizeExtent(part: PartInstance, axis: 'x' | 'z', extent: number): number {
  const snap = bayResizeSnap(part, axis)
  if (!snap || !(snap.pitch > 0)) return extent
  let cells = Math.max(1, Math.round(extent / snap.pitch))
  while (cells > 1 && cells * snap.pitch > snap.max) cells--
  while (cells * snap.pitch < snap.min) cells++
  return cells * snap.pitch
}

export function resizePart(
  part: PartInstance,
  axis: 'x' | 'y' | 'z',
  sign: 1 | -1,
  newExtent: number,
): ResizeResult {
  // vertical (height) handle: the dragged face moves and the opposite face stays fixed in world. Where
  // the origin sits inside the height is read off the footprint before and after, never assumed: a
  // base-origin part (the fence, the shape) keeps its origin on a +Y drag and drops it by the whole
  // change on a -Y drag; a centre-origin part (cargo) moves it by half the change either way.
  if (axis === 'y') {
    const p = part.params as unknown as Record<string, number>
    const key = resizeParamKey(part, 'y')
    const params = { ...p, [key]: newExtent }
    const was = partFootprint(part)
    const now = partFootprint({ ...part, params } as unknown as PartInstance)
    const dy = sign > 0 ? was.y0 - now.y0 : was.y1 - now.y1
    return {
      position: [part.position[0], part.position[1] + dy, part.position[2]],
      params,
    }
  }
  // belt conveyor: the +X length handle stretches only the last segment;
  // the opposite (tail) face stays fixed in world, so the origin shifts by half
  // the change in horizontal extent. Belt-like SDK parts go through the same path.
  if (axis === 'x' && isBeltLike(part)) {
    return resizeBeltLength(part, sign, newExtent)
  }
  const params = part.params as unknown as Record<string, number>
  const key = resizeParamKey(part, axis)
  const target = constrainResizeExtent(part, axis, newExtent)
  const old = params[key] ?? 0
  const delta = target - old
  // tail-origin conveyors keep the tail (origin) fixed on a +X (front) drag, and move
  // the origin by -delta on a -X (back) drag so the front stays put. Centred parts (and
  // the width axis, which stays symmetric in Z) shift by half the delta either way.
  const tailX = isTailOriginConveyor(part) && axis === 'x'
  // an inclined straight bed (rig inclineParam) pivots about the centre origin, so holding the dragged
  // face's opposite end fixed means the origin slides along the slope: the plan shift shrinks by
  // cos(tilt) and the origin rises/drops by the sin part (the resize handles drag the same tilted line).
  const incline = axis === 'x' ? resolveInclineRad(part) : 0
  const local =
    axis === 'x'
      ? { x: tailX ? (sign > 0 ? 0 : -delta) : (sign * delta * Math.cos(incline)) / 2, z: 0 }
      : { x: 0, z: (sign * delta) / 2 }
  const shift = rotateXZ(local.x, local.z, part.rotationY)
  // the slope slide moves the origin vertically, and a `rest:'surfaceBelow'` param (standHeight - the legs'
  // reach, measured origin→surface) is pinned to that origin: carry the same dy into it, or the trestle feet
  // leave the floor by exactly dy. Analytic (the surface below hasn't changed mid-drag), so the live resize
  // preview stays planted without a raycast; the commit-time re-rest corrects any surface-change edge.
  const dy = (sign * delta * Math.sin(incline)) / 2
  const restKey = dy !== 0 ? surfaceBelowParam(part) : null
  const restFix =
    restKey && typeof params[restKey] === 'number' ? { [restKey]: Math.max(0.1, params[restKey] + dy) } : null
  return {
    position: [part.position[0] + shift.x, part.position[1] + dy, part.position[2] + shift.z],
    params: { ...params, [key]: target, ...restFix },
  }
}

/**
 * Belt length-handle resize: grow/shrink the last segment so the horizontal
 * extent matches the dragged face, keeping the tail face fixed in world. The
 * handle drag measures a horizontal delta; convert it to along-tangent length
 * via the last segment's cumulative tilt.
 */
function resizeBeltLength(part: PartInstance, sign: 1 | -1, newExtent: number): ResizeResult {
  const view = bedView(part, 'path')
  const keep = { position: [...part.position] as [number, number, number], params: { ...(part.params as unknown as Record<string, ParamValue>) } }
  if (!view) return keep
  const segments = view.segments.map((s) => ({ ...s }))
  if (segments.length === 0) return keep
  const oldExtent = beltHorizontalExtent(segments)
  const cumTilt = beltSegmentAngles(segments).angles.at(-1)!
  const horizDelta = newExtent - oldExtent
  const last = segments[segments.length - 1]!
  const cos = Math.max(Math.abs(Math.cos(cumTilt)), 0.1)
  last.length = Math.max(BELT_MIN_RUN_LENGTH, last.length + horizDelta / cos)
  const actualDelta = beltHorizontalExtent(segments) - oldExtent
  // tail-origin: a +X (front) drag keeps the tail/origin fixed; a -X drag moves the
  // origin by -delta so the front face stays put (see resizePart).
  const shift = rotateXZ(sign > 0 ? 0 : -actualDelta, 0, part.rotationY)
  return {
    position: [part.position[0] + shift.x, part.position[1], part.position[2] + shift.z],
    params: { ...(part.params as unknown as Record<string, ParamValue>), ...view.writeSegments(segments) },
  }
}

/**
 * Belt tail handle (the belt gizmo's tail drag): the tail slides along the
 * part's local +X by `dragAlongT`, shrinking/growing segment 0 while the head stays
 * put - so the origin shifts by the same amount. The slide is
 * horizontal (local X), independent of segment 0's tilt.
 */
export function resizeBeltTail(part: PartInstance, dragAlongT: number): ResizeResult {
  const view = bedView(part, 'path')
  const params = part.params as unknown as Record<string, ParamValue>
  if (!view) return { position: [...part.position], params: { ...params } }
  const segments = view.segments.map((s) => ({ ...s }))
  const seg0 = segments[0]
  if (!seg0) return { position: [...part.position], params: { ...params } }
  const t = Math.min(dragAlongT, seg0.length - BELT_MIN_RUN_LENGTH)
  seg0.length -= t
  const shift = rotateXZ(t, 0, part.rotationY)
  return {
    position: [part.position[0] + shift.x, part.position[1], part.position[2] + shift.z],
    params: { ...params, ...view.writeSegments(segments) },
  }
}

/**
 * Belt segment-end handle (the belt gizmo's length drag): set one segment's
 * length to `newLength`; the origin holds and every downstream segment follows.
 */
export function resizeBeltSegmentLength(part: PartInstance, segIndex: number, newLength: number): ResizeResult {
  const view = bedView(part, 'path')
  const params = part.params as unknown as Record<string, ParamValue>
  if (!view) return { position: [...part.position], params: { ...params } }
  const segments = view.segments.map((s) => ({ ...s }))
  const seg = segments[segIndex]
  if (!seg) return { position: [...part.position], params: { ...params } }
  seg.length = Math.max(BELT_MIN_RUN_LENGTH, newLength)
  return { position: [...part.position], params: { ...params, ...view.writeSegments(segments) } }
}

export function isTailOriginConveyor(part: PartInstance): boolean {
  // belt-like SDK parts share the belt's tail origin (bed runs 0..extent from the origin), so their width
  // handles centre at mid-length, not at the tail (docs/part-gizmos.md).
  return isBeltLike(part)
}

/**
 * Local +X distance from a tail-origin conveyor's origin (the tail) to the centre of
 * its bed along the length axis - i.e. where the pre-v3 centred origin sat. Used by the
 * scene migration and the (centre-authored) demo scenes to convert a centre position to
 * a tail position. 0 for curved/turntable (arc-/plate-centre origin) and non-conveyors.
 * NB: distinct from partFootprint().cx for spurs, whose footprint centre includes the
 * splay overhang; this is purely the length midpoint the old origin used.
 */
export function conveyorCenterOffsetX(part: PartInstance): number {
  // a custom belt-like part (SDK belt: a `segments` numberList with a path handle) shares the belt's tail
  // origin but has no `length` param - its length midpoint is half the horizontal plan extent instead.
  // Other custom conveyors (straight/spur/curved views) keep a centre origin, so their offset is 0.
  if (part.type === 'part') {
    const view = bedView(part, 'path')
    return view ? beltHorizontalExtent(view.segments) / 2 : 0
  }
  return 0
}
