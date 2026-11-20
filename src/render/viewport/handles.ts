import {
  BoxGeometry,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import type { PerspectiveCamera, Ray, Raycaster } from 'three'
import { beltPathFromParams, beltSegmentFrames, defaultBeltSegments, sampleBeltPathExt } from '../../core/conveyor/beltPath'
import { guardArcRange, openingAt, openingsOnSide, rowsToOpeningSpecs } from '../../core/guards/guardOpeningEdit'
import type { GuardWall } from '../../core/guards/guardOpeningEdit'
import { OVERLAY_LAYER } from '../env'
import {
  bedView,
  curvedGizmoOf,
  flexPathOf,
  curvedHandleLocal,
  curvedHandleValue,
  effectiveResize,
  isBeltLike,
  isTailOriginConveyor,
  partFootprint,
  rectangleBedOf,
  resizeHandleMidY,
  resolveInclineRad,
  toLocalXZ,
  toWorldXZ,
} from '../../core/parts/partGeometry'
import type { CurvedGizmo } from '../../core/parts/partGeometry'
import { GUARD_HEIGHT } from '../../core/types'
import type { BeltGuardOpeningSpec, BeltSegmentSpec, PartInstance } from '../../core/types'
import type { BoxResizeHandle, CurveResizeHandle, FlexResizeHandle, GuardOpeningHandle, ResizeHandle, ScreenProjector } from '../api'
import { worldPerPixel } from './editorCamera'
import { rayLineParam } from './gizmo'

// Conveyor gizmo handles: round dots, orange normally,
// brighter amber-yellow on hover.
const HANDLE_COLOR = 0xff8000 // handle color (1, 0.5, 0)
const HANDLE_COLOR_HOVER = 0xffcc00 // handle hover color (1, 0.8, 0)
const HANDLE_SIZE = 0.09
const HANDLE_PX = 13
const proxyGeo = new BoxGeometry(HANDLE_SIZE * 2.4, HANDLE_SIZE * 2.4, HANDLE_SIZE * 2.4)
/** guard-wall polyline spacing along a belt (m): a bend's chord then stays within a few mm of the guard */
const WALL_STEP = 0.05
/** the guard sheet's offset outside the bed edge (the belt's rail wall), so the wall line lies ON the guard */
const GUARD_INSET = 0.01

/** a guard wall as a world-space polyline, with the tail-relative row value at each vertex */
interface WallLine {
  s: number[]
  p: Vector3[]
}

/**
 * Disc tinted by the sprite material (white core), with a dark rim that reads
 * against the project's safety-yellow parts and separates the dot from the
 * same-orange selection outline - like an editor handle icon.
 */
function makeDotTexture(): DataTexture {
  const N = 64
  const data = new Uint8Array(N * N * 4)
  const c = (N - 1) / 2
  const rCore = N * 0.32 // full-tint fill ends here
  const rEdge = N * 0.46 // outer edge (alpha fades over the last pixel)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c)
      const alpha = Math.max(0, Math.min(1, rEdge - d + 0.5))
      const rim = Math.max(0, Math.min(1, (d - rCore) / (rEdge - rCore)))
      const v = Math.round((1 - rim * 0.85) * 255) // white core → dark rim (× tint)
      const i = (y * N + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = Math.round(alpha * 255)
    }
  }
  const tex = new DataTexture(data, N, N, RGBAFormat)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

/** the handle dot: a tinted disc with a dark rim (shared by the rig gizmo overlay) */
export const dotTexture = makeDotTexture()

// only box + curve handles are fixed; belt handles are pooled in beltCubes
const ALL_HANDLES: readonly (BoxResizeHandle | CurveResizeHandle | FlexResizeHandle)[] = [
  { axis: 'x', sign: 1 },
  { axis: 'x', sign: -1 },
  { axis: 'y', sign: 1 },
  { axis: 'y', sign: -1 },
  { axis: 'z', sign: 1 },
  { axis: 'z', sign: -1 },
  // curved-conveyor arc handles (mutually exclusive with the box handles above)
  { curve: 'angle' },
  { curve: 'width' },
  // a flex conveyor's infeed end and path control points, up to six (mutually exclusive with all of the above)
  { flexPoint: 'infeed' },
  ...Array.from({ length: 6 }, (_, i): FlexResizeHandle => ({ flexPoint: i })),
]

function sameHandle(a: ResizeHandle, b: ResizeHandle): boolean {
  if ('guard' in a || 'guard' in b)
    return 'guard' in a && 'guard' in b && a.guard === b.guard && a.opening === b.opening && a.edge === b.edge
  if ('curve' in a || 'curve' in b) return 'curve' in a && 'curve' in b && a.curve === b.curve
  if ('flexPoint' in a || 'flexPoint' in b) return 'flexPoint' in a && 'flexPoint' in b && a.flexPoint === b.flexPoint
  if ('belt' in a || 'belt' in b) return 'belt' in a && 'belt' in b && a.belt === b.belt
  return 'axis' in a && 'axis' in b && a.axis === b.axis && a.sign === b.sign
}

/** normalized belt segments for any belt-like part (built-in or a declared-`path`-handle SDK part) */
function beltSegmentsOf(part: PartInstance): BeltSegmentSpec[] {
  return bedView(part, 'path')?.segments ?? defaultBeltSegments()
}

/** local +Y face the resize box presents for sign (top = y1, bottom = y0) */
function faceY(part: PartInstance, sign: 1 | -1): number {
  const fp = partFootprint(part)
  return sign > 0 ? fp.y1 : fp.y0
}

/**
 * half-extent in the resize param's frame (length/2, width/2) - not the
 * footprint, which includes spur splay overhang resizePart knows nothing about
 */
function paramHalf(part: PartInstance, axis: 'x' | 'z'): number {
  const params = part.params as unknown as Record<string, number>
  const v = axis === 'x' ? params.length : params.width
  if (typeof v === 'number') return v / 2
  const fp = partFootprint(part)
  return axis === 'x' ? fp.hx : fp.hz
}

/**
 * Local-X centre of the length-param frame. Tail-origin conveyors run 0..length
 * from the origin, so their length faces sit at x=0 and x=length (centre = half);
 * every other part is centred on its origin (0).
 */
function paramCenterX(part: PartInstance): number {
  return isTailOriginConveyor(part) ? paramHalf(part, 'x') : 0
}

/** resize-handle parity: round orange handle dots at the footprint face centers */
export class ResizeHandles {
  readonly root = new Group()
  private readonly material = new SpriteMaterial({
    map: dotTexture,
    color: HANDLE_COLOR,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly hoverMaterial = new SpriteMaterial({
    map: dotTexture,
    color: HANDLE_COLOR_HOVER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly ghostMaterial = new SpriteMaterial({
    map: dotTexture,
    color: HANDLE_COLOR_HOVER,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly proxyMaterial = new MeshBasicMaterial({ visible: false })
  private readonly cubes: { handle: BoxResizeHandle | CurveResizeHandle | FlexResizeHandle; group: Group; sprite: Sprite; proxy: Mesh }[] =
    []
  // belt tail + per-segment dots: count varies with the segment chain, so pooled
  // and (re)assigned in setPart rather than fixed like `cubes`.
  private readonly beltCubes: { handle: ResizeHandle | null; group: Group; sprite: Sprite; proxy: Mesh }[] = []
  // side-guard opening edge dots (guard-openings mode): two per opening per wall, so the count varies.
  private readonly openingCubes: { handle: GuardOpeningHandle | null; group: Group; sprite: Sprite; proxy: Mesh }[] =
    []
  private sideGuardMode = false
  /**
   * Each guard wall as a world-space polyline at the guard's mid-height, with the row value (`s`, tail-relative)
   * at every vertex. Picking, the hover ghost, the edge dots and every opening drag all read the pointer off
   * this line, the one the guard is drawn along: a dot sits on it, so grabbing a dot reads back its own value
   * from any viewpoint, on a bent belt as on a straight bed.
   */
  private walls: Record<GuardWall, WallLine> | null = null
  /** the opening the editor has selected (both its dots lit) */
  private selectedOpening: { index: number; guard: GuardWall } | null = null
  /** what the pointer hovers on a wall: a point on solid guard (ghost dot) or an opening (its dots lit) */
  private wallHover: { guard: GuardWall; s: number } | null = null
  private readonly ghost: { group: Group; sprite: Sprite }
  /** the dot the pointer is over (setHighlight): the other highlight inputs re-apply it rather than clear it */
  private hoverHandle: ResizeHandle | null = null
  /** neighbour-cut gaps per wall in row space: pickWall treats them as already open */
  private junctions: Record<GuardWall, [number, number][]> | null = null
  private part: PartInstance | null = null
  private drag:
    | { kind: 'line'; origin: Vector3; dir: Vector3 }
    | { kind: 'curve'; param: 'angle' | 'width' }
    | { kind: 'opening'; guard: GuardWall }
    | { kind: 'flex' }
    | null = null

  constructor() {
    this.root.visible = false
    for (const handle of ALL_HANDLES) {
      const group = new Group()
      const sprite = new Sprite(this.material)
      sprite.scale.setScalar(HANDLE_SIZE)
      sprite.renderOrder = 990
      const proxy = new Mesh(proxyGeo, this.proxyMaterial)
      proxy.userData.handle = handle
      group.add(sprite, proxy)
      this.root.add(group)
      this.cubes.push({ handle, group, sprite, proxy })
    }
    // the hover ghost: where a sweep would start. Not pickable (no proxy), so it never steals a press.
    const ghostGroup = new Group()
    const ghostSprite = new Sprite(this.ghostMaterial)
    ghostSprite.scale.setScalar(HANDLE_SIZE * 0.8)
    ghostSprite.renderOrder = 990
    ghostGroup.add(ghostSprite)
    ghostGroup.visible = false
    ghostGroup.traverse((o) => { o.layers.enable(OVERLAY_LAYER); o.frustumCulled = false })
    this.root.add(ghostGroup)
    this.ghost = { group: ghostGroup, sprite: ghostSprite }
  }

  /** lazily grow the belt-handle pool to at least `n` dots (reused across setPart) */
  private ensureBeltCubes(n: number): void {
    while (this.beltCubes.length < n) {
      const group = new Group()
      const sprite = new Sprite(this.material)
      sprite.scale.setScalar(HANDLE_SIZE)
      sprite.renderOrder = 990
      const proxy = new Mesh(proxyGeo, this.proxyMaterial)
      group.add(sprite, proxy)
      group.visible = false
      this.root.add(group)
      // view setup only layers the constructor-built cubes; these are created lazily, so opt
      // them into the always-on-top overlay pass here too (+ cull-off, matching that sweep -
      // the overlay projection cache needs a camera-independent visit set).
      group.traverse((o) => { o.layers.enable(OVERLAY_LAYER); o.frustumCulled = false })
      this.beltCubes.push({ handle: null, group, sprite, proxy })
    }
  }

  /** lay out the belt tail + segment-end dots; hides the box X handles (belt owns length) */
  private setBeltHandles(part: PartInstance): void {
    const segs = beltSegmentsOf(part)
    const { corners } = beltSegmentFrames(segs)
    const count = segs.length + 1 // tail + one end per segment
    this.ensureBeltCubes(count)
    for (let k = 0; k < this.beltCubes.length; k++) {
      const cube = this.beltCubes[k]!
      if (k >= count) {
        cube.group.visible = false
        cube.handle = null
        continue
      }
      const handle: ResizeHandle = k === 0 ? { belt: 'tail' } : { belt: k - 1 }
      const corner = corners[k]! // corners[0]=tail, corners[i+1]=end of segment i
      const w = toWorldXZ(part, corner.x, 0)
      cube.group.position.set(w.x, part.position[1] + corner.y, w.z)
      cube.group.visible = true
      cube.handle = handle
      cube.proxy.userData.handle = handle
    }
  }

  /** toggle guard-openings mode; a selected conveyor that authors openings then shows opening dots instead of size handles */
  setSideGuardMode(on: boolean): void {
    if (on === this.sideGuardMode) return
    this.sideGuardMode = on
    if (!on) {
      this.selectedOpening = null
      this.wallHover = null
    }
    this.setPart(this.part)
  }

  /** light both dots of the editor's selected opening (null clears) */
  setSelectedOpening(sel: { index: number; guard: GuardWall } | null): void {
    const same = sel === this.selectedOpening || (sel && this.selectedOpening && sel.index === this.selectedOpening.index && sel.guard === this.selectedOpening.guard)
    if (same) return
    this.selectedOpening = sel
    if (!this.drag) this.applyHighlight(this.hoverHandle)
  }

  /**
   * The pointer's point on a guard wall, or null. On solid guard it shows a ghost dot where a sweep would start;
   * inside an opening it lights that opening's dots instead (a press there selects or slides it).
   */
  setWallHover(hit: { guard: GuardWall; s: number } | null): void {
    this.wallHover = hit
    this.ghost.group.visible = false
    if (hit && this.walls && this.part && openingAt(this.specs(), hit.guard, hit.s) < 0) {
      this.ghost.group.position.copy(this.wallPoint(hit.guard, hit.s))
      this.ghost.group.visible = true
    }
    if (!this.drag) this.applyHighlight(this.hoverHandle)
  }

  private specs(): BeltGuardOpeningSpec[] {
    return rowsToOpeningSpecs((this.part?.params as { guardOpenings?: number[][] } | undefined)?.guardOpenings ?? [])
  }

  private hideOpeningCubes(): void {
    for (const cube of this.openingCubes) {
      cube.group.visible = false
      cube.handle = null
    }
    this.walls = null
    this.ghost.group.visible = false
  }

  /** a wall's point at row value `s`, interpolated along its polyline (exact on its vertices and straight runs) */
  private wallPoint(guard: GuardWall, s: number): Vector3 {
    const w = this.walls![guard]
    const n = w.s.length
    if (s <= w.s[0]!) return w.p[0]!.clone()
    for (let i = 1; i < n; i++) {
      if (s <= w.s[i]!) {
        const t = (s - w.s[i - 1]!) / Math.max(w.s[i]! - w.s[i - 1]!, 1e-9)
        return w.p[i - 1]!.clone().lerp(w.p[i]!, t)
      }
    }
    return w.p[n - 1]!.clone()
  }

  /**
   * The point on a guard wall nearest the pointer on screen: per polyline segment, the 3D point closest to the
   * pointer ray (clamped to the segment), then the one whose projection is nearest the pointer. Exact for a
   * pointer on the line, perspective included, since the ray then passes through the line itself.
   */
  private nearestOnWall(guard: GuardWall, ray: Ray, screen: ScreenProjector): { s: number; px: number } | null {
    const w = this.walls?.[guard]
    if (!w) return null
    let best: { s: number; px: number } | null = null
    const d1 = new Vector3()
    const r = new Vector3()
    const pt = new Vector3()
    for (let i = 1; i < w.p.length; i++) {
      const a = w.p[i - 1]!
      d1.subVectors(w.p[i]!, a)
      r.subVectors(a, ray.origin)
      const aa = d1.dot(d1)
      const b = d1.dot(ray.direction)
      const c = d1.dot(r)
      const f = ray.direction.dot(r)
      const denom = aa - b * b // |ray.direction| = 1
      let t = denom > 1e-12 ? (b * f - c) / denom : 0
      t = Math.min(Math.max(t, 0), 1)
      pt.copy(a).addScaledVector(d1, t)
      if (pt.clone().sub(ray.origin).dot(ray.direction) <= 0) continue // behind the camera
      const sp = screen.project(pt)
      if (!sp) continue
      const px = Math.hypot(sp.x - screen.x, sp.y - screen.y)
      if (!best || px < best.px) best = { s: w.s[i - 1]! + (w.s[i]! - w.s[i - 1]!) * t, px }
    }
    return best
  }

  /** the guard wall under the pointer (within `tolPx` on screen) and the row value there, or null */
  pickWall(ray: Ray, screen: ScreenProjector, tolPx: number): { guard: GuardWall; s: number } | null {
    if (!this.root.visible || !this.walls) return null
    let best: { guard: GuardWall; s: number; px: number } | null = null
    for (const guard of ['left', 'right'] as const) {
      const hit = this.nearestOnWall(guard, ray, screen)
      if (hit && hit.px <= tolPx && (!best || hit.px < best.px)) best = { guard, ...hit }
    }
    if (!best) return null
    // a gap a neighbour already cut is not solid guard: nothing to sweep there (an authored opening overlapping
    // it is still grabbable, so it can be slid or removed)
    const inJunction = this.junctions?.[best.guard].some(([a, b]) => best.s > a + 1e-4 && best.s < b - 1e-4) ?? false
    if (inJunction && openingAt(this.specs(), best.guard, best.s) < 0) return null
    return { guard: best.guard, s: best.s }
  }

  /** the gaps the selected conveyor's neighbours cut in its guards, in row space (core/junctionOpeningRows) */
  setJunctionOpenings(j: Record<GuardWall, [number, number][]> | null): void {
    this.junctions = j
  }

  /** begin an opening drag along `guard` (a sweep or a slide: no dot is grabbed) */
  beginWallDrag(guard: GuardWall): void {
    this.ghost.group.visible = false
    this.drag = { kind: 'opening', guard }
  }

  /** lazily grow the opening-handle pool to at least `n` dots (like ensureBeltCubes) */
  private ensureOpeningCubes(n: number): void {
    while (this.openingCubes.length < n) {
      const group = new Group()
      const sprite = new Sprite(this.material)
      sprite.scale.setScalar(HANDLE_SIZE)
      sprite.renderOrder = 990
      const proxy = new Mesh(proxyGeo, this.proxyMaterial)
      group.add(sprite, proxy)
      group.visible = false
      this.root.add(group)
      group.traverse((o) => { o.layers.enable(OVERLAY_LAYER); o.frustumCulled = false })
      this.openingCubes.push({ handle: null, group, sprite, proxy })
    }
  }

  /**
   * Lay out guard-openings mode: build both guard walls as polylines (see {@link walls}) and put a dot on each
   * edge of every opening, on the wall it cuts. There are no "create" dots: a new opening is swept along the
   * guard itself. Returns false when the part authors no guardOpenings, so setPart falls back to the size
   * handles.
   *
   * Both conveyor families are laid out here, differing only in how a row's value maps to a point on the bed:
   * a belt samples its (possibly bent) path at that arc-length, reaching the pulley-wrap stubs past each end; a
   * straight roller bed converts the tail-relative value to centre-origin local X and follows its rig incline.
   */
  private layoutOpeningCubes(part: PartInstance): boolean {
    const range = guardArcRange(part)
    if (!range) return false
    const view = bedView(part, 'path')
    const straight = view ? null : rectangleBedOf(part)
    if (!view && !straight) return false
    // local (plan-X, elevation, slope) of a row value, per family, and the values the wall polyline samples
    let sample: (s: number) => { x: number; y: number; angle: number }
    let knots: number[]
    if (view) {
      const path = beltPathFromParams({ segments: view.segments, height: view.height })
      sample = (s) => sampleBeltPathExt(path, s)
      // fine enough that the chord across a bend fillet stays within a few mm of the guard
      const n = Math.max(1, Math.ceil((range.hi - range.lo) / WALL_STEP))
      knots = Array.from({ length: n + 1 }, (_, i) => range.lo + ((range.hi - range.lo) * i) / n)
    } else {
      // straight bed: s is measured from the tail but the body is centre-origin, so shift by −length/2; a rig
      // incline (tiltDeg) rotates the bed about its centre, so the wall follows the slope like the length handles do
      const half = straight!.length / 2
      const tilt = resolveInclineRad(part)
      sample = (s) => ({ x: (s - half) * Math.cos(tilt), y: (s - half) * Math.sin(tilt), angle: tilt })
      knots = [range.lo, range.hi]
    }
    const halfW = (view ? view.width : straight!.width) / 2 + GUARD_INSET
    const lift = GUARD_HEIGHT / 2 // the guard's mid-height, along the bed normal: where a person aims at it
    const at = (guard: GuardWall, s: number): Vector3 => {
      const pose = sample(s)
      const lx = pose.x - Math.sin(pose.angle) * lift
      const ly = pose.y + Math.cos(pose.angle) * lift
      const w = toWorldXZ(part, lx, guard === 'left' ? -halfW : halfW)
      return new Vector3(w.x, part.position[1] + ly, w.z)
    }
    // a wall whose guard is switched off has nothing to cut: it gets no line, so it is neither picked nor swept
    const params = part.params as { leftGuard?: unknown; rightGuard?: unknown }
    const has = { left: view ? view.leftGuard : params.leftGuard !== false, right: view ? view.rightGuard : params.rightGuard !== false }
    const line = (guard: GuardWall): WallLine => (has[guard] ? { s: knots, p: knots.map((s) => at(guard, s)) } : { s: [], p: [] })
    this.walls = { left: line('left'), right: line('right') }
    const specs = rowsToOpeningSpecs((part.params as { guardOpenings?: number[][] }).guardOpenings ?? [])
    const dots: { handle: GuardOpeningHandle; s: number }[] = []
    for (const guard of ['left', 'right'] as const) {
      if (!has[guard]) continue
      for (const i of openingsOnSide(specs, guard)) {
        const o = specs[i]!
        dots.push({ handle: { guard, opening: i, edge: 'start' }, s: o.arcStart })
        dots.push({ handle: { guard, opening: i, edge: 'end' }, s: o.arcEnd })
      }
    }
    this.ensureOpeningCubes(dots.length)
    for (let k = 0; k < this.openingCubes.length; k++) {
      const cube = this.openingCubes[k]!
      if (k >= dots.length) {
        cube.group.visible = false
        cube.handle = null
        continue
      }
      const { handle, s } = dots[k]!
      // clamped onto the guard: a row left hanging past the end of a since-shortened bed shows its dot at the end
      cube.group.position.copy(this.wallPoint(handle.guard, Math.min(Math.max(s, range.lo), range.hi)))
      cube.group.visible = true
      cube.handle = handle
      cube.proxy.userData.handle = handle
    }
    if (this.wallHover) this.setWallHover(this.wallHover) // re-seat the ghost on the rebuilt wall
    return true
  }

  setPart(part: PartInstance | null): void {
    this.part = part
    if (!part) {
      this.root.visible = false
      return
    }
    // Side Guards mode: a conveyor that authors guardOpenings
    // - belt or straight roller bed - swaps its size handles for the opening / guard-end dots; drag to
    // add/resize an opening. Any other selection (or one without the param) falls through to the normal size
    // handles below.
    if (this.sideGuardMode && this.layoutOpeningCubes(part)) {
      for (const { group } of this.cubes) group.visible = false
      for (const cube of this.beltCubes) {
        cube.group.visible = false
        cube.handle = null
      }
      this.root.visible = true
      return
    }
    this.hideOpeningCubes()
    const resize = effectiveResize(part)
    // curved conveyors (built-in or an SDK curved bed with an `arc` handle) get the arc gizmo, not box handles
    const gizmo = curvedGizmoOf(part)
    const curved = gizmo !== null
    // a flex conveyor gets a dot on each path control point, and none of the box handles
    const flex = flexPathOf(part)
    // belts own their length via the tail/segment dots, so suppress the box X handles
    // and keep only the Z (width) faces; the belt dots come from setBeltHandles below.
    // belt-like = the built-in belt or an SDK part declaring a `path` handle (docs/part-gizmos.md).
    const belt = isBeltLike(part)
    const y = part.position[1] + resizeHandleMidY(part)
    // whole-bed incline (rig inclineParam): the bed rotates Rz(tilt) about the origin, so the length
    // dots must ride the raised head / lowered tail, not the flat plan positions (belts get this from
    // their segment corners in setBeltHandles).
    const tilt = resolveInclineRad(part)
    const cosT = Math.cos(tilt)
    const sinT = Math.sin(tilt)
    let any = false
    for (const { handle, group } of this.cubes) {
      if ('flexPoint' in handle) {
        // the infeed is the part origin; a flex with no path points has nothing to pull it against
        const pt: readonly [number, number] | undefined =
          handle.flexPoint === 'infeed' ? (flex?.points.length ? [0, 0] : undefined) : flex?.points[handle.flexPoint]
        group.visible = !!pt
        if (!pt) continue
        any = true
        const w = toWorldXZ(part, pt[0], pt[1])
        group.position.set(w.x, part.position[1], w.z)
        continue
      }
      if ('curve' in handle) {
        // arc handles only on curved conveyors; sit on the deck plane (local y=0)
        group.visible = curved
        if (!gizmo) continue
        any = true
        const l = curvedHandleLocal(gizmo, handle.curve)
        const w = toWorldXZ(part, l.x, l.z)
        group.position.set(w.x, part.position[1], w.z)
        continue
      }
      const enabled = curved || flex
        ? false
        : belt
          ? handle.axis === 'z' && !!resize.z
          : handle.axis === 'x'
            ? !!resize.x
            : handle.axis === 'y'
              ? !!resize.y
              : !!resize.z
      group.visible = enabled
      if (!enabled) continue
      any = true
      if (handle.axis === 'y') {
        // vertical handle: top/bottom face center, on the part's centerline
        group.position.set(part.position[0], part.position[1] + faceY(part, handle.sign), part.position[2])
        continue
      }
      const half = paramHalf(part, handle.axis)
      // width (z) handles sit at the bed midpoint along length, not the origin -
      // tail-origin conveyors would otherwise bunch them at the tail (x=0) while
      // native places them at mid_x (resize-handle 4/5).
      const cx = paramCenterX(part)
      const lx = handle.axis === 'x' ? cx + handle.sign * half : cx
      const lz = handle.axis === 'z' ? handle.sign * half : 0
      const w = toWorldXZ(part, lx * cosT, lz)
      group.position.set(w.x, y + lx * sinT, w.z)
    }
    if (belt) {
      this.setBeltHandles(part)
      any = true
    } else {
      for (const cube of this.beltCubes) {
        cube.group.visible = false
        cube.handle = null
      }
    }
    this.root.visible = any
  }

  pick(raycaster: Raycaster): ResizeHandle | null {
    if (!this.root.visible) return null
    this.root.updateMatrixWorld(true)
    const proxies = [...this.cubes, ...this.beltCubes, ...this.openingCubes]
      .filter((c) => c.group.visible)
      .map((c) => c.proxy)
    const hits = raycaster.intersectObjects(proxies, false)
    return hits.length ? (hits[0]!.object.userData.handle as ResizeHandle) : null
  }

  /** hover highlight; locked to the dragged handle while a drag is active */
  setHighlight(handle: ResizeHandle | null): void {
    if (this.drag) return
    this.hoverHandle = handle
    this.applyHighlight(handle)
  }

  private applyHighlight(handle: ResizeHandle | null): void {
    for (const { handle: h, sprite } of this.cubes) {
      const hot = handle !== null && sameHandle(h, handle)
      sprite.material = hot ? this.hoverMaterial : this.material
    }
    for (const { handle: h, sprite } of this.beltCubes) {
      const hot = handle !== null && h !== null && sameHandle(h, handle)
      sprite.material = hot ? this.hoverMaterial : this.material
    }
    // an opening's dots light together when it is selected or the pointer is inside it on the wall
    const sel = this.selectedOpening
    const hov = this.wallHover
    const hovered = hov && this.part ? openingAt(this.specs(), hov.guard, hov.s) : -1
    for (const { handle: h, sprite } of this.openingCubes) {
      const hot =
        h !== null &&
        ((handle !== null && sameHandle(h, handle)) ||
          (sel !== null && h.opening === sel.index && h.guard === sel.guard) ||
          (hov !== null && h.opening === hovered && h.guard === hov.guard))
      sprite.material = hot ? this.hoverMaterial : this.material
    }
  }

  /** cache the face axis line: anchored opposite face center + outward direction */
  beginDrag(handle: ResizeHandle): void {
    const part = this.part
    if (!part) return
    this.applyHighlight(handle)
    if ('guard' in handle) {
      // an edge dot reads the pointer off its own wall line (dragExtent), where the dot sits
      this.drag = { kind: 'opening', guard: handle.guard }
      return
    }
    if ('flexPoint' in handle) {
      // a flex path dot reads a whole deck-plane point (dragPoint), not an extent
      this.drag = { kind: 'flex' }
      return
    }
    if ('curve' in handle) {
      // arc handles read straight off the deck plane in dragExtent - no line to cache
      this.drag = { kind: 'curve', param: handle.curve }
      return
    }
    if ('belt' in handle) {
      this.drag = { kind: 'line', ...this.beltDragLine(part, handle.belt) }
      return
    }
    if (handle.axis === 'y') {
      // anchor the opposite face on the centerline; drag projects onto world +Y,
      // so dragExtent reads the new full height up/down from that fixed face
      this.drag = {
        kind: 'line',
        origin: new Vector3(part.position[0], part.position[1] + faceY(part, -handle.sign as 1 | -1), part.position[2]),
        dir: new Vector3(0, handle.sign, 0),
      }
      return
    }
    const half = paramHalf(part, handle.axis)
    // anchor the opposite face center on the bed midpoint (see setPart) so the
    // width drag line runs through the actual handle, not the tail.
    const cx = paramCenterX(part)
    const ax = handle.axis === 'x' ? cx - handle.sign * half : cx
    const az = handle.axis === 'z' ? -handle.sign * half : 0
    // inclined bed (rig inclineParam): anchor on the tilted opposite end and run the length drag line
    // up/down the slope (like beltDragLine's tilted tangent), so rayLineParam reads the along-bed length.
    const tilt = resolveInclineRad(part)
    const cosT = Math.cos(tilt)
    const sinT = Math.sin(tilt)
    const anchor = toWorldXZ(part, ax * cosT, az)
    const dl = handle.axis === 'x' ? { x: handle.sign, z: 0 } : { x: 0, z: handle.sign }
    const dw = toWorldXZ(part, dl.x * cosT, dl.z)
    const y = part.position[1] + resizeHandleMidY(part) + ax * sinT
    this.drag = {
      kind: 'line',
      origin: new Vector3(anchor.x, y, anchor.z),
      dir: new Vector3(dw.x - part.position[0], dl.x * sinT, dw.z - part.position[2]).normalize(),
    }
  }

  /**
   * Belt handle drag line (cached at the initial pose for the tail / length
   * drags). The tail slides along the part's local +X; a segment-end dot
   * slides along that segment's tilted tangent from its start corner. dragExtent's
   * rayLineParam then reads the tail's along-axis travel / the segment's new length.
   */
  private beltDragLine(part: PartInstance, belt: 'tail' | number): { origin: Vector3; dir: Vector3 } {
    const [px, py, pz] = part.position
    if (belt === 'tail') {
      const dw = toWorldXZ(part, 1, 0) // local +X in world (horizontal)
      return {
        origin: new Vector3(px, py, pz),
        dir: new Vector3(dw.x - px, 0, dw.z - pz).normalize(),
      }
    }
    const { corners, tangents } = beltSegmentFrames(beltSegmentsOf(part))
    const corner = corners[belt]! // start corner of segment `belt`
    const tan = tangents[belt]! // (along local X, along local Y=elevation)
    const cw = toWorldXZ(part, corner.x, 0)
    const tw = toWorldXZ(part, tan.x, 0) // horizontal part of the tangent
    return {
      origin: new Vector3(cw.x, py + corner.y, cw.z),
      dir: new Vector3(tw.x - px, tan.y, tw.z - pz).normalize(),
    }
  }

  /**
   * Box / belt line handles: new extent = distance from the cached origin along
   * the drag axis (rayLineParam). Curve handles: the dragged param value (sweep
   * degrees or radial width) read where the pointer ray meets the deck plane.
   */
  dragExtent(ray: Ray, screen?: ScreenProjector): number | null {
    if (!this.drag) return null
    if (this.drag.kind === 'opening') {
      // the row value on the dragged wall nearest the pointer, clamped to the guard by the line's own ends
      return screen ? (this.nearestOnWall(this.drag.guard, ray, screen)?.s ?? null) : null
    }
    if (this.drag.kind === 'line') return rayLineParam(this.drag.origin, this.drag.dir, ray)
    if (this.drag.kind === 'flex') return null
    return this.curveDragValue(ray, this.drag.param)
  }

  /** where the pointer ray meets the dragged part's deck plane, in world XZ */
  dragPoint(ray: Ray): { x: number; z: number } | null {
    const part = this.part
    if (!part || !this.drag) return null
    if (Math.abs(ray.direction.y) < 1e-6) return null
    const t = (part.position[1] - ray.origin.y) / ray.direction.y
    if (t < 0) return null
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t }
  }

  /** intersect the pointer ray with the deck plane and read the dragged arc param in local space */
  private curveDragValue(ray: Ray, param: 'angle' | 'width'): number | null {
    const part = this.part
    if (!part) return null
    const gizmo: CurvedGizmo | null = curvedGizmoOf(part)
    if (!gizmo) return null
    const planeY = part.position[1] // deck top sits at the part origin's height (local y=0)
    if (Math.abs(ray.direction.y) < 1e-6) return null
    const t = (planeY - ray.origin.y) / ray.direction.y
    if (t < 0) return null
    const wx = ray.origin.x + ray.direction.x * t
    const wz = ray.origin.z + ray.direction.z * t
    const l = toLocalXZ(part, wx, wz)
    // convention-aware inverse (built-in +Z→+X sweep vs SDK +X→−Z), shared with the handle placement
    return curvedHandleValue(gizmo, param, l.x, l.z)
  }

  endDrag(): void {
    this.drag = null
    this.applyHighlight(null)
  }

  updateScale(camera: PerspectiveCamera, viewportHeight: number): void {
    if (!this.root.visible) return
    const k = HANDLE_PX / HANDLE_SIZE
    for (const { group } of [...this.cubes, ...this.beltCubes, ...this.openingCubes, this.ghost]) {
      if (!group.visible) continue
      const d = camera.position.distanceTo(group.position)
      group.scale.setScalar(Math.max(worldPerPixel(camera, d, viewportHeight) * k, 1e-4))
    }
  }

  dispose(): void {
    this.material.dispose()
    this.hoverMaterial.dispose()
    this.ghostMaterial.dispose()
    this.proxyMaterial.dispose()
  }
}
