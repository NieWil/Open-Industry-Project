// Part picking and surface queries for the view: the raycast broadphase, part
// and rig-link picks, rest surfaces under the cursor or a part, and footprint band selection.

import { Vector3 } from 'three'
import type { Intersection, Object3D } from 'three'
import { isCargoPart } from '../../core/frame'
import { partFootprint, toWorldXZ } from '../../core/parts/partGeometry'
import { silhouetteOverlapsRect } from '../../core/selection'
import type { ScreenPoint } from '../../core/selection'
import type { PartInstance } from '../../core/types'
import type { BoxPick } from '../api'
import type { RenderView } from './view'

/** the part picks' own scratch (`view.pickScratch`), reused so a pick allocates nothing for these */
export class ViewPickScratch {
  readonly hitNormal = new Vector3()
  // scratch for raycastParts' ray-box entry point (reach-capped candidate cull)
  readonly rayBoxTmp = new Vector3()
}

/** what the part picks reach on the view beyond their own {@link ViewPickScratch} */
export type PickHost = Pick<
  RenderView,
  | 'boundsOf'
  | 'boxes'
  | 'camTmp'
  | 'camera'
  | 'entries'
  | 'hidden'
  | 'partsGroup'
  | 'pickScratch'
  | 'projTmp'
  | 'raycastParts'
  | 'raycaster'
  | 'renderer'
  | 'running'
  | 'setPointerRay'
  | 'stagingId'
>

const DOWN = new Vector3(0, -1, 0)
const DOWN_ORIGIN = new Vector3()

/** the footprint box's 4 XZ corners as (±hx, ±hz) multipliers - the band's screen-extent samples */
const FOOTPRINT_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/**
 * Broadphase for the part raycasts: the visuals whose cached world AABB the
 * current ray crosses, so the detailed intersect descends into the few parts
 * near the ray rather than every sub-mesh in the scene (the hot path while a
 * placement preview follows the cursor). Entries with no bounds yet (async
 * geometry still loading) stay candidates so they remain pickable.
 * `view.raycaster` must already be aimed (setPointerRay / set).
 * `maxDist` (the pilot crosshair's 3 m reach) additionally drops parts whose
 * bounds start beyond it (`intersectsBox` alone can't: it ignores `ray.far`).
 */
export function raycastParts(view: PickHost, maxDist = Infinity): Object3D[] {
  const ray = view.raycaster.ray
  const maxDistSq = maxDist * maxDist
  const out: Object3D[] = []
  const rayBoxTmp = view.pickScratch.rayBoxTmp
  for (const entry of view.entries.values()) {
    const bbox = view.boundsOf(entry)
    if (!bbox.isEmpty()) {
      const enter = ray.intersectBox(bbox, rayBoxTmp)
      if (enter === null) continue
      // when the origin is inside the box, intersectBox returns the exit point, whose
      // distance says nothing about reach (the building's bbox spans the scene), so an
      // enclosing box always stays a candidate
      if (
        maxDistSq !== Infinity &&
        !bbox.containsPoint(ray.origin) &&
        enter.distanceToSquared(ray.origin) > maxDistSq
      ) continue
    }
    if (isCargoPart(entry.part)) {
      // cargo's visual is an empty stub (it renders through the instanced batch). Idle, pick it
      // via its collision proxy so it depth-sorts against every other part through pickPart; while
      // running it's picked live via SimBoxes.pick (pickBox), so its stale authored-pose proxy
      // must not shadow that.
      if (!view.running && entry.proxy) out.push(entry.proxy)
    } else {
      out.push(entry.visual.object)
    }
  }
  return out
}

/**
 * Like raycastParts, but for surface/rest queries: a conveyor contributes its
 * collision proxy (flat deck) instead of its gappy visual, so a dropped part rests
 * on the true deck. The visual's cached AABB is a valid (superset) broadphase bound
 * for the proxy it wraps.
 */
export function raycastSurfaces(view: PickHost): Object3D[] {
  const ray = view.raycaster.ray
  const out: Object3D[] = []
  for (const entry of view.entries.values()) {
    const bbox = view.boundsOf(entry)
    if (bbox.isEmpty() || ray.intersectsBox(bbox)) out.push(entry.proxy ?? entry.visual.object)
  }
  return out
}

/**
 * The selectable parts under the pointer, nearest first and de-duplicated; `first` stops at the nearest. Stopped,
 * the cargo batch is raycast beside the part meshes: a unit load that stacks itself (core/frame unitPieces) has no
 * geometry of its own, so its pallet and cases, which exist only as batch rows carrying its id, are the only thing
 * a click can land on. Running, the batch is picked live through pickBox instead.
 */
function partsUnderPointer(view: PickHost, clientX: number, clientY: number, first: boolean): string[] {
  view.setPointerRay(clientX, clientY)
  const hits = view.raycaster.intersectObjects(view.raycastParts(), true)
  if (!view.running) {
    hits.push(...view.raycaster.intersectObjects([view.boxes.group], true))
    hits.sort((a, b) => a.distance - b.distance)
  }
  const ids: string[] = []
  for (const hit of hits) {
    const id = hitPartId(view, hit)
    if (id === null) continue
    // hidden parts are visually absent, locked parts aren't selectable, and the
    // placement-staging preview isn't committed yet: skip the hit, let the ray fall through
    const ep = view.entries.get(id)?.part
    if (view.hidden.has(id) || id === view.stagingId || ep?.locked === true) continue
    if (!ids.includes(id)) ids.push(id)
    if (first) break
  }
  return ids
}

/** the part a hit belongs to: a cargo batch row's owner, else the nearest `userData.partId` up the hit's chain */
function hitPartId(view: PickHost, hit: Intersection): string | null {
  const row = view.boxes.partIdOfHit(hit)
  if (row !== undefined) return row
  let obj: Object3D | null = hit.object
  while (obj && obj !== view.partsGroup) {
    const id = obj.userData.partId
    if (typeof id === 'string') return id
    obj = obj.parent
  }
  return null
}

export function pickPart(view: PickHost, clientX: number, clientY: number): string | null {
  return partsUnderPointer(view, clientX, clientY, true)[0] ?? null
}

/** every part under the cursor, nearest-first and de-duplicated: the candidate list for the Alt+RMB list-select */
export function pickPartsAt(view: PickHost, clientX: number, clientY: number): string[] {
  return partsUnderPointer(view, clientX, clientY, false)
}

/**
 * Author mode (a custom part opened in its own scene): resolve a click to the internal rig link it hit,
 * for read-only selection. Returns the nearest `linkName` on the hit's ancestor chain, but only when that
 * chain belongs to `partId` - so it never reaches into another part. Null = the hit isn't a link of that
 * part (e.g. empty space, or the part root with no link), and the caller falls back to normal part picking.
 */
export function pickRigLink(view: PickHost, clientX: number, clientY: number, partId: string): string | null {
  view.setPointerRay(clientX, clientY)
  const hits = view.raycaster.intersectObjects(view.raycastParts(), true)
  for (const hit of hits) {
    let obj: Object3D | null = hit.object
    // a lamp/link bank draws several links as one InstancedMesh (linkBank.ts): its instance names the link
    const bankLinks = hit.object.userData.bankLinks as string[] | undefined
    let linkName: string | null = bankLinks && hit.instanceId !== undefined ? (bankLinks[hit.instanceId] ?? null) : null
    while (obj && obj !== view.partsGroup) {
      if (linkName === null && typeof obj.userData.linkName === 'string') linkName = obj.userData.linkName
      const id = obj.userData.partId
      if (typeof id === 'string') {
        if (id === partId) return linkName
        break // this hit belongs to another part - try the next hit
      }
      obj = obj.parent
    }
  }
  return null
}

export function surfaceAt(
  view: PickHost,
  clientX: number,
  clientY: number,
  excludeIds?: ReadonlySet<string>,
): { point: [number, number, number]; normal: [number, number, number]; partId?: string } | null {
  view.setPointerRay(clientX, clientY)
  const hits = view.raycaster.intersectObjects(raycastSurfaces(view), true)
  for (const hit of hits) {
    if (!hit.face) continue
    let obj: Object3D | null = hit.object
    let id: string | undefined
    while (obj && obj !== view.partsGroup) {
      if (typeof obj.userData.partId === 'string') {
        id = obj.userData.partId
        break
      }
      obj = obj.parent
    }
    // skip the parts being repositioned (so the selection never rests on itself), the
    // building shell (it is the ground reference, not a rest surface), hidden parts (a part
    // you cannot see should not be a rest target), and the placement-staging preview (an
    // uncommitted part must never be a rest surface, including for itself)
    const ent = id ? view.entries.get(id) : undefined
    if (id && (excludeIds?.has(id) || id === view.stagingId || ent?.part.type === 'building' || view.hidden.has(id))) continue
    view.pickScratch.hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize()
    return {
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [view.pickScratch.hitNormal.x, view.pickScratch.hitNormal.y, view.pickScratch.hitNormal.z],
      ...(id !== undefined ? { partId: id } : {}),
    }
  }
  return null
}

export function surfaceBelow(
  view: PickHost,
  part: PartInstance,
  excludeIds: ReadonlySet<string>,
): { point: [number, number, number]; normal: [number, number, number] } | null {
  const fp = partFootprint(part)
  const bottom = part.position[1] + fp.y0
  // cast straight down from just above the part's top, over its footprint centre (cx ≠ 0
  // for tail-origin conveyors, cx/cz for an off-centre bounds box); the first non-excluded
  // surface at/below the part's underside is the floor to rest on (never raises it)
  const wc = toWorldXZ(part, fp.cx ?? 0, fp.cz ?? 0)
  DOWN_ORIGIN.set(wc.x, part.position[1] + fp.y1 + 0.02, wc.z)
  view.raycaster.set(DOWN_ORIGIN, DOWN)
  const hits = view.raycaster.intersectObjects(raycastSurfaces(view), true)
  for (const hit of hits) {
    if (!hit.face) continue
    let obj: Object3D | null = hit.object
    let id: string | undefined
    while (obj && obj !== view.partsGroup) {
      if (typeof obj.userData.partId === 'string') {
        id = obj.userData.partId
        break
      }
      obj = obj.parent
    }
    const ent = id ? view.entries.get(id) : undefined
    if (id && (excludeIds.has(id) || id === view.stagingId || ent?.part.type === 'building' || view.hidden.has(id))) continue
    if (hit.point.y > bottom + 1e-3) continue
    view.pickScratch.hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize()
    return {
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [view.pickScratch.hitNormal.x, view.pickScratch.hitNormal.y, view.pickScratch.hitNormal.z],
    }
  }
  return null
}

export function partsInRect(view: PickHost, x0: number, y0: number, x1: number, y1: number): string[] {
  const rect = view.renderer.domElement.getBoundingClientRect()
  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1)
  const maxY = Math.max(y0, y1)
  view.camera.updateMatrixWorld()
  const ids: string[] = []
  for (const [id, entry] of view.entries) {
    const part = entry.part
    // the building shell spans the whole layout - rubber-banding the parts
    // inside it must not grab the building itself (select it via tree/walls)
    if (part.type === 'building') continue
    if (view.hidden.has(id)) continue
    if (part.locked === true) continue // locked parts can't be band-selected
    // while running, a cargo part's transform is its authored spawn pose; its real pose is in
    // the sim batch (as in raycastParts/focusOn). The live sweep below bands it.
    if (view.running && isCargoPart(part)) continue
    const fp = partFootprint(part)
    // a container node (group) has no geometry: its footprint collapses to the bare anchor
    // point its members were filed under, which is an arbitrary point. A zero-area box still
    // "overlaps" a rect containing it, so the sweep below would select the whole group off empty
    // floor; a group is caught via its members instead (see core/selection.ts bandSelection).
    if (fp.hx === 0 && fp.hz === 0) continue
    // Footprint (floor-plan) selection: project only the base of the footprint box, so a part is
    // caught when the band overlaps the area it occupies on the floor. Touch semantics against that
    // rectangle, not its centre (a centre test misses a long conveyor three-quarters swept).
    // It doesn't test the corners' screen bounding box, which extends past an angled part's
    // silhouette and grabs nearby floor; hence the convex-hull overlap. It also ignores the part's
    // height: a 6.5 m rack's body leans over adjacent floor in screen space, and banding empty floor
    // beside it must not select it. A full 3D mesh test against a depth-spanning frustum would catch
    // the leaning body, so it isn't used: this is a floor layout tool, boxed on the plan.
    // Open/sparse parts still over-select their hollow interior (a rack between its posts); fixing
    // that needs per-collision-shape testing. See the verify-band-select-groups gate.
    const yBase = part.position[1] + fp.y0
    const pts: ScreenPoint[] = []
    for (const [kx, kz] of FOOTPRINT_CORNERS) {
      const w = toWorldXZ(part, (fp.cx ?? 0) + kx * fp.hx, (fp.cz ?? 0) + kz * fp.hz)
      view.projTmp.set(w.x, yBase, w.z)
      view.camTmp.copy(view.projTmp).applyMatrix4(view.camera.matrixWorldInverse)
      if (view.camTmp.z >= 0) continue // behind the camera - project() would mirror it in front
      view.projTmp.project(view.camera)
      pts.push({
        x: rect.left + ((view.projTmp.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - view.projTmp.y) / 2) * rect.height,
      })
    }
    if (silhouetteOverlapsRect(pts, minX, minY, maxX, maxY)) ids.push(id)
  }
  // running cargo, banded at its live pose (skipped above). Bodies that own no part yet
  // (spawner-born) are surfaced separately by cargoBodiesInRect, for the caller to promote.
  if (view.running) {
    for (const pick of cargoPicksInRect(view, minX, minY, maxX, maxY)) {
      const id = pick.partId
      if (id === null || view.hidden.has(id)) continue
      const entry = view.entries.get(id)
      if (!entry || entry.part.locked === true) continue
      ids.push(id)
    }
  }
  return ids
}

/**
 * Live cargo bodies inside the band that own no scene part (transient spawner boxes). Band
 * selection can't return them as ids (they have none); the caller promotes them into parts the
 * same way a click-select does (controller.promoteCargoBoxes) and selects the results.
 */
export function cargoBodiesInRect(view: PickHost, x0: number, y0: number, x1: number, y1: number): BoxPick[] {
  if (!view.running) return []
  return cargoPicksInRect(view, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1))
    .filter((p) => p.partId === null)
}

/**
 * Live cargo bodies whose world centre projects inside the (already ordered) screen rect. Unlike
 * the authored sweep above (which overlaps the footprint box), this stays a centre test: the bank
 * reports a body as a point, and cargo is small enough on screen that the two agree in practice.
 */
export function cargoPicksInRect(view: PickHost, minX: number, minY: number, maxX: number, maxY: number): BoxPick[] {
  const rect = view.renderer.domElement.getBoundingClientRect()
  view.camera.updateMatrixWorld()
  return view.boxes.picksInRect((x, y, z) => {
    view.projTmp.set(x, y, z)
    view.camTmp.copy(view.projTmp).applyMatrix4(view.camera.matrixWorldInverse)
    if (view.camTmp.z >= 0) return false // behind the camera - project() would mirror it in front
    view.projTmp.project(view.camera)
    const sx = rect.left + ((view.projTmp.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - view.projTmp.y) / 2) * rect.height
    return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY
  })
}
