// The per-refresh layout of a rig's reshaped links (buildRig in rig.ts calls these from refresh): a side guard or
// frame rail split around openings, sensor holes and mitred ends; a deck slab cut into strips around stair notches;
// a leg trestle's stations; an arrayed primitive's instances, including a railing cut. Each takes its entry and
// the refresh inputs. The two that can add or drop meshes return whether they did: a recorded WebGPU render
// bundle bakes the draw list, so the caller bumps the structure version for it.

import { BufferGeometry, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three'
import type { Material } from 'three'
import { arrayInstanceDeltas, legFrameDepth, MAX_DISTRIBUTE_INSTANCES, resolvedBoxSize, resolvedCylinder, resolvedOffset } from '../../../core/rig/rigPose'
import { reportPartDiagnostic } from '../../../core/parts/partDiagnostics'
import type { SeamContext } from '../../../core/rig/rigPose'
import type { RigParams } from '../../../core/rig/rigPose'
import type { GuardOpenings } from '../../../core/guards/guardOpenings'
import { keptSegments } from '../../../core/guards/guardOpenings'
import type { GuardExtents } from '../../../core/guards/guardExtents'
import { legRestDyAt } from '../../../core/legRests'
import type { LegRestRows } from '../../../core/legRests'
import { guardHolePanelDescription } from '../../../core/guards/guardHoles'
import { extrudeDescription } from '../../../core/geometry/geometryShapes'
import { cutAt, mitreAt, railFlangeOffset } from '../../../core/guards/guardExtents'
import type { GuardHoles } from '../../../core/guards/guardHoles'
import { GUARD_HOLE_PANEL, GUARD_HOLE_RADIUS } from '../../../core/types'
import { cutPostDeltas, deckStripRects } from '../../../core/structureCuts'
import type { PlatformCut } from '../../../core/structureCuts'
import type { RigLegShape, RigLink, RigShape, Vec3Tuple } from '../../../core/parts/partPackage'
import { realizeMeshDescription } from '../meshDescriptionGeometry'
import { createInstancePool, ensureInstanceCapacity, fillInstances, legStations, unitBox, writeLegs } from '../common'
import type { InstancePool } from '../common'
import type { LegPool } from '../common'
import type { DeckSurface, WalkFinish } from '../common'
import { syncBankEmptyVisibility } from '../instancedTemplate'
import { retireGeometry } from '../../gpuRetire'

// A guard's sensor-beam hole panel (core/guards/guardHoles.ts guardHolePanelDescription), one geometry per distinct plate
// shape (sheet height, hole height, thickness), shared by every rig guard in the scene. Each panel holds a reference
// to the shape it draws. Dragging a sensor along a guard or scrubbing its height mints a new shape per frame, so a
// shape no panel holds is evicted and retired (gpuRetire.ts: a recorded render bundle may still draw it).
const holePanelGeometries = new Map<string, { geom: BufferGeometry; refs: number }>()
/** the shape key each panel holds a reference to */
const panelHoleKeys = new WeakMap<Mesh, string>()
function holePanelKey(y0: number, y1: number, holeY: number, thickness: number): string {
  return [y0, y1, holeY, thickness].map((v) => v.toFixed(4)).join('|')
}
/** Point `panel` at the shared plate for `key`, taking a reference to it and dropping the one it held. */
function acquireHolePanelGeometry(panel: Mesh, key: string, y0: number, y1: number, holeY: number, thickness: number): BufferGeometry {
  if (panelHoleKeys.get(panel) === key) return holePanelGeometries.get(key)!.geom
  let entry = holePanelGeometries.get(key)
  if (!entry) {
    entry = { geom: realizeMeshDescription(guardHolePanelDescription(y0, y1, holeY, thickness)), refs: 0 }
    holePanelGeometries.set(key, entry)
  }
  entry.refs++
  releaseHolePanelGeometry(panel)
  panelHoleKeys.set(panel, key)
  return entry.geom
}
/** Drop the panel's reference. Safe to call twice: the second call finds no key. */
function releaseHolePanelGeometry(panel: Mesh): void {
  const key = panelHoleKeys.get(panel)
  if (key === undefined) return
  panelHoleKeys.delete(panel)
  const entry = holePanelGeometries.get(key)
  if (!entry || --entry.refs > 0) return
  holePanelGeometries.delete(key)
  retireGeometry(entry.geom)
}
/** Release every hole-panel shape the guard's panels hold (the rig's dispose). */
export function releaseGuardSplit(gs: GuardSplitLink): void {
  for (const panel of gs.panels) releaseHolePanelGeometry(panel)
}
/** live shape count, for tests */
export function holePanelGeometryCount(): number {
  return holePanelGeometries.size
}

// A mitred guard end (core/guards/guardExtents.ts GuardMitre) on a box link: the box stops square where the cut is deepest and
// this right-angle wedge carries the band on out to the cut. Unit legs along +x and +z, y centred, so one scale
// (c * thickness, height, thickness) and one of four proper rotations fits any end on either side. Shared scene-wide
// and never freed.
const unitMitreWedge = realizeMeshDescription(extrudeDescription([[0, 0], [1, 0], [0, 1]], -0.5, 0.5, { axis: 'y' }))
/** which end ('hi': the piece lies at lower x) and which way is outward in link-local z -> the turn that lays the
 *  wedge's legs along "out of the piece" and "outward". All proper rotations: a mirror scale would turn the faces
 *  inside out under DoubleSide lighting (the instanceMirror trap). */
const MITRE_WEDGE_TURN: Record<string, Quaternion> = {
  'hi,out+': new Quaternion(),
  'hi,out-': new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
  'lo,out+': new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI),
  'lo,out-': new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
}

export type ArrayShape = Exclude<RigShape, { kind: 'mesh' } | { kind: 'frame' } | { kind: 'label' } | { kind: 'leg' }>

export type GuardSplitLink = { group: Group; size: Vec3Tuple; sizeParams: NonNullable<Extract<RigShape, { kind: 'box' }>['sizeParams']>; mat: Material; side: 'left' | 'right'; frame: boolean; offsetY: number; link: RigLink; children: Mesh[]; panels: Mesh[]; wedges: Mesh[] }
export type DeckCutLink = { group: Group; size: Vec3Tuple; sizeParams?: Extract<RigShape, { kind: 'box' }>['sizeParams']; mat: Material; children: Mesh[]; walk?: WalkFinish; strips?: DeckSurface[] }
export type InstancedArrayLink = { group: Group; shape: ArrayShape; array: NonNullable<RigLink['array']>; showParam?: string; pool: InstancePool | null; mat: Material; geom: BufferGeometry; cast: boolean; railing?: { edge: keyof PlatformCut['openings']; axis: 0 | 2; segment: boolean }; /** per-copy size, from the last layout (a posed array re-places its copies at it) */ scale?: Vec3Tuple }
export type LegLink = { pool: LegPool; spanParam: string; widthParam: string; standParam: string; shape: RigLegShape; arc?: { radiusParam: string; sweepDeg: number } }

// Write an array of grid deltas into a pool's InstancedMesh at one uniform scale (per-copy position varies,
// scale doesn't - a post run, a shelf stack). Grows the buffer as needed and refreshes bounds for culling.
const _instQuat = new Quaternion() // identity - the link group already carries the shape's rotation
const _instPos = new Vector3()
const _instScale = new Vector3()
const _instMat = new Matrix4()
function writeInstances(pool: InstancePool, deltas: readonly Vec3Tuple[], sx: number, sy: number, sz: number): void {
  ensureInstanceCapacity(pool, deltas.length)
  const mesh = pool.mesh
  _instScale.set(sx, sy, sz)
  for (let i = 0; i < deltas.length; i++) {
    _instPos.set(deltas[i]![0], deltas[i]![1], deltas[i]![2])
    _instMat.compose(_instPos, _instQuat, _instScale)
    mesh.setMatrixAt(i, _instMat)
  }
  mesh.count = deltas.length
  mesh.instanceMatrix.needsUpdate = true
  if (deltas.length > 0) mesh.computeBoundingSphere()
  syncBankEmptyVisibility(mesh) // gate-empty array (showParam off) ⇒ invisible, not a codegen-paying no-op draw
}
// A `distribute` array that reaches the instance ceiling is silently truncated by arrayInstanceDeltas (a
// roller bed or post run just stops mid-span). The ceiling is high enough that no realistic bed hits it, so
// this fires only on a pathological spacing/span - surface it once (partDiagnostics dedups the stable
// message, so a live drag can't storm it) with a message the author can act on, instead of geometry that
// just vanishes. partId is best-effort (set on the group before buildRig; absent for a catalog/thumbnail).
function warnIfCapped(deltas: readonly Vec3Tuple[], root: Group, packageId: string): void {
  if (deltas.length < MAX_DISTRIBUTE_INSTANCES) return
  reportPartDiagnostic({
    source: 'geometry',
    partId: typeof root.userData.partId === 'string' ? root.userData.partId : '',
    packageId,
    message: `A repeating rig element reached the ${MAX_DISTRIBUTE_INSTANCES}-instance safety ceiling; further copies were omitted. Increase the element spacing or reduce the span.`,
  })
}

/** Lay a splittable side guard or frame rail out into the kept segments of its span. True when the draw list changed. */
export function layoutGuardSplit(gs: GuardSplitLink, params: RigParams, linkByName: ReadonlyMap<string, RigLink>, openings: GuardOpenings | undefined, extents: GuardExtents | undefined, holes: GuardHoles | undefined): boolean {
  const sz = resolvedBoxSize(gs.size, gs.sizeParams, params)
  const half = sz[0] / 2
  const backX = (gs.side === 'left' ? extents?.leftBack : extents?.rightBack) ?? -half
  const frontX = (gs.side === 'left' ? extents?.leftFront : extents?.rightFront) ?? half
  const open = gs.frame ? [] : ((gs.side === 'left' ? openings?.left : openings?.right) ?? [])
  // sensor-beam holes: only a guard sheet holds one - a link whose height spans the hole's disc (the thin
  // top return above it stays whole) - and only inside the span it keeps after openings and extents
  const y0 = gs.offsetY - sz[1] / 2, y1 = gs.offsetY + sz[1] / 2
  const sideHoles = gs.frame ? [] : ((gs.side === 'left' ? holes?.left : holes?.right) ?? [])
  const panelHoles = sideHoles.filter(([hx, hy]) => hy - GUARD_HOLE_RADIUS >= y0 && hy + GUARD_HOLE_RADIUS <= y1
    && keptSegments(backX, frontX, open).some(([lo, hi]) => hx - GUARD_HOLE_PANEL / 2 >= lo && hx + GUARD_HOLE_PANEL / 2 <= hi))
  const segs = keptSegments(backX, frontX, [...open, ...panelHoles.map(([hx]): [number, number] => [hx - GUARD_HOLE_PANEL / 2, hx + GUARD_HOLE_PANEL / 2])])
  const proto = gs.children[0]!
  const before = gs.children.length + gs.panels.length + gs.wedges.length
  while (gs.panels.length < panelHoles.length) {
    const panel = new Mesh(unitBox, gs.mat)
    panel.castShadow = proto.castShadow
    panel.receiveShadow = proto.receiveShadow
    panel.userData.guardHolePanel = true // gates count the holes a guard actually draws
    // pool like the sheet it replaces: every panel cut at one hole height, scene-wide, shares one geometry,
    // so the instance pool draws them all as one bank instead of a draw per hole
    if (proto.userData.poolUnit === true) panel.userData.poolUnit = true
    gs.group.add(panel)
    gs.panels.push(panel)
  }
  while (gs.panels.length > panelHoles.length) {
    const panel = gs.panels.pop()!
    gs.group.remove(panel)
    releaseHolePanelGeometry(panel)
  }
  let panelGeometryChanged = false
  for (let i = 0; i < panelHoles.length; i++) {
    const [hx, hy] = panelHoles[i]!
    const panel = gs.panels[i]!
    // the plate is built in the link's frame: y about its centre, z from 0 through its thickness
    const py0 = y0 - gs.offsetY, py1 = y1 - gs.offsetY, holeY = hy - gs.offsetY
    const geom = acquireHolePanelGeometry(panel, holePanelKey(py0, py1, holeY, sz[2]), py0, py1, holeY, sz[2])
    if (panel.geometry !== geom) { panel.geometry = geom; panelGeometryChanged = true }
    panel.position.set(hx, 0, -sz[2] / 2)
  }
  while (gs.children.length < segs.length) {
    const extra = new Mesh(unitBox, gs.mat)
    extra.castShadow = proto.castShadow
    extra.receiveShadow = proto.receiveShadow
    // a split piece is the same unit box as the first, so it pools with it (and every other guard in the scene);
    // untagged, each piece a hole or an opening split off would be a draw of its own
    if (proto.userData.poolUnit === true) extra.userData.poolUnit = true
    gs.group.add(extra)
    gs.children.push(extra)
  }
  for (let i = gs.children.length - 1; i >= Math.max(segs.length, 1); i--) {
    gs.group.remove(gs.children[i]!)
    gs.children.pop()
  }
  // a guard fully covered by openings (segs empty) collapses its one remaining child to nothing
  if (segs.length === 0) gs.children[0]!.scale.set(0, 0, 0)
  // Cut ends where this part meets another conveyor. A guard end is mitred on the plane the two guards share
  // (core/guards/guardExtents.ts GuardMitre: the host's mitres come with its openings, a mover's with its extents). A mover's
  // frame rail end is cut to fit against the host's frame, which stays whole (GuardExtents.railCuts): the wall on
  // the host's outer wall face, the top flange a flange width further out. Either way the cut is a line across
  // this link's band, d0..d1 out from the guard line, at `c` along the bed per metre out: the box stops square
  // where the cut is deepest, and a wedge carries it out to the cut from the face where it reaches furthest.
  const cuts = gs.frame ? extents?.railCuts : (openings?.mitres ?? extents?.mitres)
  const cutOf = (x: number): number | null => (gs.frame
    ? cutAt(extents?.railCuts, gs.side, x)
    : mitreAt(openings?.mitres, gs.side, x) || mitreAt(extents?.mitres, gs.side, x) || null)
  // the link as it is now (an author edit may have moved it since the build), not the build-time copy
  const nowLink = linkByName.get(gs.link.name) ?? gs.link
  const linkZ = cuts ? resolvedOffset(nowLink.offset, nowLink.offsetParams, params)[2] : 0
  const out = linkZ < 0 ? -1 : 1 // outward is away from the bed centreline
  const d0 = cuts ? Math.abs(linkZ) - sz[2] / 2 - cuts.inner : 0
  const d1 = d0 + sz[2]
  const flangeOffset = (c: number) => (gs.frame && d0 >= -1e-4 ? railFlangeOffset(c) : 0) // the top flange band
  const pull = (c: number | null) => (c === null ? 0 : Math.max(c * d0, c * d1) + flangeOffset(c))
  const wedgeAt: { x: number; hi: boolean; c: number }[] = []
  for (let i = 0; i < segs.length; i++) {
    let [lo, hi] = segs[i]!
    if (cuts) {
      const cLo = cutOf(lo), cHi = cutOf(hi)
      if ((cLo !== null || cHi !== null) && hi - lo > pull(cLo) + pull(cHi)) {
        if (cLo !== null) {
          lo += pull(cLo)
          if (Math.abs(cLo) > 1e-6) wedgeAt.push({ x: lo, hi: false, c: cLo })
        }
        if (cHi !== null) {
          hi -= pull(cHi)
          if (Math.abs(cHi) > 1e-6) wedgeAt.push({ x: hi, hi: true, c: cHi })
        }
      }
    }
    const c = gs.children[i]!
    c.scale.set(hi - lo, sz[1], sz[2])
    c.position.x = (lo + hi) / 2
  }
  while (gs.wedges.length < wedgeAt.length) {
    const w = new Mesh(unitMitreWedge, gs.mat)
    w.castShadow = proto.castShadow
    w.receiveShadow = proto.receiveShadow
    if (proto.userData.poolUnit === true) w.userData.poolUnit = true
    gs.group.add(w)
    gs.wedges.push(w)
  }
  while (gs.wedges.length > wedgeAt.length) gs.group.remove(gs.wedges.pop()!)
  for (let i = 0; i < wedgeAt.length; i++) {
    const { x, hi, c } = wedgeAt[i]!
    const w = gs.wedges[i]!
    // the right-angle corner sits at the square end on the face where the cut reaches furthest out of the piece:
    // the inner face when c > 0 (its leg runs outward), the outer one when c < 0 (its leg runs back in)
    const leg = c > 0 ? out : -out
    w.quaternion.copy(MITRE_WEDGE_TURN[`${hi ? 'hi' : 'lo'},out${leg > 0 ? '+' : '-'}`]!)
    w.scale.set(Math.abs(c) * sz[2], sz[1], sz[2])
    w.position.set(x, 0, (-leg * sz[2]) / 2)
  }
  // a segment-, panel- or wedge-count change (or a panel re-cut to a new hole height) alters the draw list - a
  // recorded WebGPU render bundle would keep replaying the old pieces; bump the structural counter the
  // bundle invalidation polls
  return gs.children.length + gs.panels.length + gs.wedges.length !== before || panelGeometryChanged
}

/** Lay a deck slab out as the strips around a snapped stair's notches. True when the draw list changed. */
export function layoutDeckCut(dc: DeckCutLink, params: RigParams, platformCut: PlatformCut | undefined, newDeckSurface: (kind: WalkFinish) => DeckSurface): boolean {
  const sz = dc.sizeParams ? resolvedBoxSize(dc.size, dc.sizeParams, params) : dc.size
  const rects = deckStripRects(sz[0] / 2, sz[2] / 2, platformCut?.notches ?? [])
  const proto = dc.children[0]!
  const before = dc.children.length
  while (dc.children.length < rects.length) {
    const i = dc.children.length
    if (dc.walk && dc.strips && !dc.strips[i]) dc.strips[i] = newDeckSurface(dc.walk)
    const extra = new Mesh(unitBox, dc.strips?.[i]?.material ?? dc.mat)
    extra.castShadow = proto.castShadow
    extra.receiveShadow = proto.receiveShadow
    dc.group.add(extra)
    dc.children.push(extra)
  }
  for (let i = dc.children.length - 1; i >= Math.max(rects.length, 1); i--) {
    dc.group.remove(dc.children[i]!)
    dc.children.pop()
  }
  // a deck fully covered by notches (rects empty) collapses its one remaining child to nothing
  if (rects.length === 0) proto.scale.set(0, 0, 0)
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!
    const c = dc.children[i]!
    c.scale.set(r.x1 - r.x0, sz[1], r.z1 - r.z0)
    c.position.set((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2)
    dc.strips?.[i]?.setExtent(r.x1 - r.x0, r.z1 - r.z0) // after deckSizeLinks: a strip tiles by its own size
  }
  // adding/removing strip meshes changes the draw list. Without a bump a recorded WebGPU render bundle keeps
  // replaying the old one (a removed strip keeps drawing, so the hole never closes), so a count change must bump the
  // structural counter the view's bundle invalidation polls
  return dc.children.length !== before
}

/** Write a leg trestle's instances at each station, regrown to the stand height and following the incline. */
export function layoutLegs(ll: LegLink, params: RigParams, legRests: LegRestRows | undefined, cosIncline: number, sinIncline: number): void {
  const width = typeof params[ll.widthParam] === 'number' ? (params[ll.widthParam] as number) : 1
  const frameDepth = legFrameDepth(ll.shape, params)
  const stand = typeof params[ll.standParam] === 'number' ? (params[ll.standParam] as number) : frameDepth
  const height = Math.max(0.05, stand - frameDepth)
  if (ll.arc) {
    // Curved conveyor: fan the trestles around the arc (centreline radius r, sweep) at the legStations
    // cadence, each yawed radially - the SDK curved's convention: point (r·cos t, −r·sin t), yaw t+π/2.
    const r = typeof params[ll.arc.radiusParam] === 'number' ? (params[ll.arc.radiusParam] as number) : 1.5
    const sweep = (ll.arc.sweepDeg * Math.PI) / 180
    const angles = legStations(r * sweep).map((s) => s / r) // arc-length stations → sweep angles
    writeLegs(ll.pool, width, angles.map((t) => ({ base: new Matrix4().makeRotationY(t + Math.PI / 2).setPosition(r * Math.cos(t), 0, -r * Math.sin(t)), height })), frameDepth)
  } else {
    const span = typeof params[ll.spanParam] === 'number' ? Math.max(0, params[ll.spanParam] as number) : 0
    const stations = legStations(span, -span / 2) // centre-origin: legs run −span/2 … +span/2
    // whole-bed incline: legs stay vertical but each foot slides to x·cos and the post grows/shrinks by
    // x·sin so it still reaches the tilted deck underside (head legs taller, tail legs shorter). Flat ⇒ x,height.
    // Per-leg footing (legRests rows, part-local X = this group's X): a station over a platform deck
    // lifts its foot by dy and shortens the post; one overhanging past the part's own deck drops to the
    // warehouse floor (dy < 0). A footed leg squeezed under 5 cm is dropped (the bed rests on the deck
    // there), while the row-less flat layout keeps the legacy 5 cm clamp.
    // Knee braces lean toward the middle of the bed, and only on a level one: a brace drawn along a tilted
    // bed would meet the frame a slope's rise away from where it was aimed.
    const specs: { base: Matrix4; height: number; dir: number }[] = []
    for (const x of stations) {
      const dy = legRestDyAt(legRests, x)
      const h = height + x * sinIncline - dy
      if (dy !== 0 && h <= 0.05) continue
      const dir = Math.abs(sinIncline) > 1e-3 ? 0 : x <= 0 ? 1 : -1
      specs.push({ base: new Matrix4().makeTranslation(x * cosIncline, dy, 0), height: Math.max(0.05, h), dir })
    }
    writeLegs(ll.pool, width, specs, frameDepth)
  }
}

/** Fill an arrayed primitive's InstancedMesh to the resolved count, applying a railing cut in place. */
export function layoutArrayLink(ial: InstancedArrayLink, params: RigParams, seam: SeamContext | undefined, platformCut: PlatformCut | undefined, root: Group, packageId: string): void {
  let deltas = arrayInstanceDeltas(ial.array, params, seam, ial.showParam)
  warnIfCapped(deltas, root, packageId)
  if (!ial.pool) ial.pool = createInstancePool(ial.group, ial.geom, ial.mat, Math.max(deltas.length, 16), ial.cast)
  let sx = 1, sy = 1, sz = 1
  if (ial.shape.kind === 'box') {
    const s = ial.shape.sizeParams ? resolvedBoxSize(ial.shape.size, ial.shape.sizeParams, params) : ial.shape.size
    sx = s[0]; sy = s[1]; sz = s[2]
  } else if (ial.shape.kind === 'cylinder' || ial.shape.kind === 'cone') {
    const c = ial.shape.kind === 'cylinder' && ial.shape.sizeParams ? resolvedCylinder(ial.shape, params) : { radius: ial.shape.radius, height: ial.shape.height }
    sx = c.radius; sy = c.height; sz = c.radius
  }
  ial.scale = [sx, sy, sz]
  // stair→platform railing cut, applied in place like the conveyor guard merge (no rig rebuild):
  // a rail/toe box (`segment`) becomes one instance per kept segment of its run, each scaled to the
  // segment length; a post run drops instances in the gap + gains a framing post at each gap edge
  // (cutPostDeltas - the same pure transform the sim rewrites its collider links with).
  const open = ial.railing ? (platformCut?.openings[ial.railing.edge] ?? []) : []
  if (ial.railing?.segment && deltas.length > 0) {
    const axis = ial.railing.axis
    const full = axis === 2 ? sz : sx
    const segs = open.length > 0 ? keptSegments(-full / 2, full / 2, open) : ([[-full / 2, full / 2]] as const)
    const base = deltas[0]!
    fillInstances(ial.pool, segs.map(([lo, hi]) => ({
      x: base[0] + (axis === 0 ? (lo + hi) / 2 : 0),
      y: base[1],
      z: base[2] + (axis === 2 ? (lo + hi) / 2 : 0),
      sx: axis === 0 ? hi - lo : sx,
      sy,
      sz: axis === 2 ? hi - lo : sz,
    })))
    return
  }
  if (ial.railing && !ial.railing.segment && open.length > 0) {
    const { kept, framing } = cutPostDeltas(deltas, ial.railing.axis, open)
    deltas = [...kept, ...framing] as Vec3Tuple[]
  }
  writeInstances(ial.pool, deltas, sx, sy, sz)
}
