// Live snapping and resting of the EditorController (../controller.ts): the sticky snap
// wrapper, where a part rests under the cursor, and the leg re-rest on commit. The live snap of the gesture
// in flight is this area's own state (LiveSnapState, held by the controller as `snap`); the resting helpers
// are stateless and take only the store / view they read.

import { commitSnap } from '../../core/snap/snapCommit'
import { cargoSeatOn } from '../../core/frame'
import { getPackage } from '../../core/parts/partRegistry'
import { floorRestPose, restOnSurface, surfaceBelowParam } from '../../core/parts/partGeometry'
import { findSnap, findSnapToTarget } from '../../core/snap/snapFeatures'
import { surfaceRestPose } from '../../core/snap/snapSurfacePose'
import { conveyingSurfaceAt } from '../../core/conveyor/conveyorSurface'
import type { SnapCandidate, SnapPose } from '../../core/snap/snapFeatures'
import { resolveRollerGrids } from '../../core/conveyor/rollerGrid'
import { FLOOR_SURFACE_Y } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { chooseLiveSnap, joinKey } from './liveSnap'
import type { IRenderView } from '../../render/api'
import type { EditorStore } from '../store/store'
import type { EditorController } from '../controller'

/** The live snap of the gesture in flight: the candidate the preview shows, and the stickiness / flash bookkeeping. */
export interface LiveSnapState {
  candidate: SnapCandidate | null
  lastChange: number
  /** targets already announced by a ring this gesture, seeded with the mover's pre-drag join */
  flashed: Set<string>
  /** has this gesture seeded `flashed`? (applyLiveSnap) */
  seeded: boolean
}

export function createLiveSnapState(): LiveSnapState {
  return {
    candidate: null,
    lastChange: 0,
    flashed: new Set(),
    seeded: false,
  }
}

/** what the live snap reads: the snap toggles and scene (store), the ring (view), whether a placement is staging */
export type LiveSnapDeps = Pick<EditorController, 'store' | 'view' | 'placing'>

/** what resting under the cursor reads: the scene (store) and the surfaces under the cursor (view) */
export type RestDeps = Pick<EditorController, 'store' | 'view'>

export function resetSnap(snap: LiveSnapState): void {
  snap.candidate = null
  snap.flashed.clear()
  snap.seeded = false
}

export function applyLiveSnap(
  snap: LiveSnapState,
  ec: LiveSnapDeps,
  moving: PartInstance,
  proposed: SnapPose,
  alt: boolean,
  excludeIds?: ReadonlySet<string>,
): SnapCandidate | null {
  const s = ec.store.getState()
  if (!s.liveSnap || alt) {
    snap.candidate = null
    return null
  }
  const parts =
    excludeIds && excludeIds.size > 0 ? s.scene.parts.filter((p) => !excludeIds.has(p.id)) : s.scene.parts
  const now = Date.now()
  const prev = snap.candidate
  const locked = prev ? parts.find((p) => p.id === prev.targetId) : undefined
  // the sticky re-eval must read the locked roller bed's grid the same way findSnap
  // does, or a track part (blade stop / chain transfer) would jitter between the
  // resolved-grid and default-grid gap when held vs freshly searched.
  const lockedGrid =
    locked && moving.type === 'part' && getPackage(moving.packageId)?.snap?.track != null
      ? resolveRollerGrids(parts).get(locked.id)
      : undefined
  // the face-snap toggle (Shift+N) gates only the generic flush fallback; declared snaps always run
  const opts = { faceFlush: s.faceSnap }
  // Seed the flash gate with the join this part already had when the gesture began, on the
  // gesture's first evaluation (resetSnap, at each drag boundary, clears `seeded`). Picking up a
  // snapped part re-engages its own neighbour on the very first pointer-move, and announcing a
  // join the user never made would read as noise at the start of every move. `moving` is the drag-start
  // snapshot on both drag paths (gizmo filterSingle, Shift+G updateReposition), so its own pose is
  // the pre-drag one however far the gesture has since travelled. Skipped during a placement
  // session: the draft is a new part, so every join it makes is new, and its previous preview is
  // already staged in the scene (docs/placement-staging.md), so an id test would not see that.
  if (!snap.seeded) {
    snap.seeded = true
    if (!ec.placing && s.scene.parts.some((p) => p.id === moving.id)) {
      const own: SnapPose = { position: moving.position, rotationY: moving.rotationY }
      const already = findSnap(moving, own, parts, opts)
      if (already) snap.flashed.add(already.targetId)
    }
  }
  // the join showing last move, re-solved at this pose (a conveyor join held out to its release distance),
  // against a fresh search; the policy keeps the held one unless another is clearly cheaper (liveSnap.ts)
  const held =
    prev && locked
      ? findSnapToTarget(moving, proposed, locked, lockedGrid, { ...opts, hold: { via: prev.via, join: prev.join } })
      : null
  const best = findSnap(moving, proposed, parts, opts)
  const next = chooseLiveSnap(held, best, now, snap.lastChange)
  if (joinKey(next) !== joinKey(prev)) snap.lastChange = now
  // Flash once per target per gesture, and never for the join the mover already had (seeded
  // above): a join, end-to-end or side-merge, is announced the first time this drag makes it.
  // Sliding along the same target, a brief flicker, and the sticky-target oscillation between
  // two equally-good neighbours (which would re-fire the ring several times in one drag) are all
  // silent, because `flashed` remembers every target announced until the next drag boundary.
  if (next && !snap.flashed.has(next.targetId)) {
    snap.flashed.add(next.targetId)
    ec.view.flashSnap(next.junction.x, next.junction.z, next.junction.y)
  }
  snap.candidate = next
  return next
}

export function withSnapOverrides(snap: LiveSnapState, scene: SceneJSON, movingId: string | null): SceneJSON {
  const c = snap.candidate
  if (!c || movingId === null) return scene
  // the gesture already moved the part to the previewed pose; the fits and the attach are core/snap/snapCommit's
  const parts = commitSnap(scene.parts, movingId, c, { pose: false })
  return parts === scene.parts ? scene : { ...scene, parts: [...parts] }
}

/**
 * Resting pose for a part with nothing else under it. A collision-raycast drop puts the part's
 * underside on the floor (y=0), which restOnSurface mirrors. An SDK conveyor that stands at belt height on
 * legs uses the `rest: 'surfaceBelow'` restPose path (below), not this floor fallback.
 */
export function floorRest(part: PartInstance, x: number, z: number): [number, number, number] {
  return restOnSurface(part, [x, 0, z], [0, 1, 0])
}

export function restUnderCursor(
  ec: RestDeps,
  part: PartInstance,
  surface: { point: [number, number, number]; normal: [number, number, number]; partId?: string } | null,
  clientX: number,
  clientY: number,
): [number, number, number] | null {
  const restName = surfaceBelowParam(part)
  if (surface && restName) {
    const sh = (part.params as Record<string, unknown>)[restName]
    const standH = typeof sh === 'number' && sh > 0 ? sh : 0.75
    return [surface.point[0], surface.point[1] + standH, surface.point[2]]
  }
  if (surface) {
    // a tote set down on a tote of its size seats on its foot, centred, where the stack will settle
    if (surface.partId !== undefined && surface.normal[1] > 0.7) {
      const host = ec.store.getState().scene.parts.find((p) => p.id === surface.partId)
      const seat = host ? cargoSeatOn(part, host) : null
      if (seat) return seat
    }
    // A conveying part's rest proxy pads its top above the real rollers (partFootprint's +0.05 y1), so a
    // plain drop would hover and then drop when the sim starts. For a bed-top hit, seat the part's
    // lowest corner on the physics-true conveying plane instead, orientation untouched, so a level box
    // on an inclined bed touches corner-first (never buried into the slope, which would pop at Run) and
    // settles naturally. Everything else keeps the proxy rest (floors/platforms are exact).
    const plane = trueSurfaceOf(ec.store, surface)
    if (plane !== surface) return surfaceRestPose(part, plane.point, plane.normal)
    return restOnSurface(part, surface.point, surface.normal)
  }
  // Nothing under the cursor ⇒ the floor. Both floor branches live in core's floorRestPose: a legged deck
  // stands `standHeight` above it, everything else seats its (floorY-aware) underside on it. That one
  // helper is shared with the package-edit origin stamp, so "resting on the floor" can't mean two things
  // depending on which path placed the part.
  const ground = ec.view.groundPoint(clientX, clientY)
  return ground ? floorRestPose(part, ground.x, ground.z) : null
}

export function trueSurfaceOf(
  store: EditorStore,
  surface: { point: [number, number, number]; normal: [number, number, number]; partId?: string },
): {
  point: [number, number, number]
  normal: [number, number, number]
} {
  if (surface.normal[1] > 0.7 && surface.partId !== undefined) {
    const hit = store.getState().scene.parts.find((p) => p.id === surface.partId)
    const conv = hit ? conveyingSurfaceAt(hit, surface.point[0], surface.point[2]) : null
    if (conv) return { point: [surface.point[0], conv.y, surface.point[2]], normal: conv.normal }
  }
  return surface
}

export function reRestSurfaceParams(view: IRenderView, scene: SceneJSON, ids: readonly string[]): SceneJSON {
  const moved = new Set(ids)
  let changed = false
  const parts = scene.parts.map((p): PartInstance => {
    if (!moved.has(p.id)) return p
    const np = resurfaceRest(view, p, moved)
    if (np !== p) changed = true
    return np
  })
  return changed ? { ...scene, parts } : scene
}

export function resurfaceRest(view: IRenderView, part: PartInstance, exclude: ReadonlySet<string>): PartInstance {
  const name = surfaceBelowParam(part)
  if (!name) return part
  const surf = view.surfaceBelow(part, exclude)
  const surfaceY = surf ? surf.point[1] : FLOOR_SURFACE_Y
  const standH = Math.max(0.1, part.position[1] - surfaceY)
  const cur = (part.params as Record<string, unknown>)[name]
  if (typeof cur === 'number' && Math.abs(cur - standH) < 1e-4) return part
  return { ...part, params: { ...(part.params as Record<string, unknown>), [name]: standH } } as PartInstance
}

export function snapSelectedToFloor(ec: Pick<EditorController, 'store' | 'view' | 'drag' | 'reposition' | 'commitTransform'>): void {
  const s = ec.store.getState()
  if (s.mode === 'placing' || ec.drag || ec.reposition || s.selectedIds.length === 0) return
  const sel = new Set(s.selectedIds)
  let changed = false
  const parts = s.scene.parts.map((p) => {
    if (!sel.has(p.id)) return p
    // raycast straight down and rest the part's underside on the first
    // collider below; the floor is always that surface when nothing else is
    // beneath. Rest on it rather than teleporting to the type's spawn height, so
    // floor-standing parts (e.g. the diverter) actually reach the floor instead
    // of floating. Conveyors are the exception (they stand at belt height on
    // legs) - floorRest keeps them there.
    const surf = ec.view.surfaceBelow(p, sel)
    const y = surf
      ? restOnSurface(p, surf.point, surf.normal)[1]
      : floorRest(p, p.position[0], p.position[2])[1]
    // never raise a part - the downward ray only finds surfaces below it
    if (y > p.position[1] - 1e-6) return p
    changed = true
    return { ...p, position: [p.position[0], y, p.position[2]] as [number, number, number] } as PartInstance
  })
  if (changed) {
    ec.commitTransform(s.selectedIds.length > 1 ? 'Snap parts to floor' : 'Snap part to floor', { ...s.scene, parts })
  }
}
