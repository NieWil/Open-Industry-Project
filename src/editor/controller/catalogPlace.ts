// Catalog warming and press-drag placement of the EditorController (../controller.ts).
// The card press in flight is this area's own state (CatalogPress, held by the controller). The warm sweep takes
// only what it reads; the press gesture drives the placement session (./placement.ts), so it takes what that needs
// plus the pointer and viewport it tracks (CatalogPlaceDeps).

import { createSdkPart, createPart } from '../../core/scene/scene'
import { getPackage } from '../../core/parts/partRegistry'
import { PART_DEFS } from '../../core/types'
import type { PartInstance, PartType } from '../../core/types'
import { assetsBusy, runSpeculativeWarm, whenAssetsQuiet } from '../../render/gltf'
import { whenScenePainted } from '../../render/renderReady'
import { prefetchConveyorTextures } from '../../render/parts/common'
import * as placementOps from './placement'
import type { PlacementDeps } from './placement'
import type { EditorController } from '../controller'

/** what the card press drives: the placement session and its helpers, the shared pointer, the viewport rect */
export type CatalogPlaceDeps = PlacementDeps & Pick<EditorController, 'placement' | 'lastPointer' | 'container'>

// a catalog press that travels farther than this (px) is a drag-to-place, not a
// click-to-place; below it the press is treated as a click (see endCatalogPlace)
const CATALOG_DRAG_THRESHOLD_PX = 4

/** Resolve on the next browser idle slice (a short timeout cap so it still drains on a busy tab); a plain
 *  setTimeout where requestIdleCallback is absent (Safari/tests). Paces the idle catalog warm sweep. */
function nextIdleSlice(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 250 })
    else setTimeout(resolve, 16)
  })
}

/**
 * A press-drag from a catalog card: the card captures the pointer and forwards
 * move/up here, so the staged preview follows the cursor and the wheel can rotate it
 * (native HTML5 drag-and-drop suppresses wheel/key events, so it can't rotate the preview).
 */
export class CatalogPress {
  gesture: { type: PartType; moved: boolean; downX: number; downY: number; toggleOff: boolean } | null = null
}

export function warmCatalogPart(ec: Pick<EditorController, 'readOnly' | 'view'>, type: PartType, packageId?: string, warmPipeline = false): void {
  if (ec.readOnly) return
  let part: PartInstance
  if (type === 'part') {
    const pkg = packageId ? getPackage(packageId) : undefined
    if (!pkg) return
    part = createSdkPart(pkg, '__warm', [0, PART_DEFS.part.defaultY, 0], 0)
  } else {
    part = createPart(type, '__warm', [0, PART_DEFS[type].defaultY, 0], 0)
  }
  ec.view.warmPart(part, { pipeline: warmPipeline })
}

export async function warmCatalog(
  ec: Pick<EditorController, 'readOnly' | 'store' | 'warmCatalogPart'>,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  if (ec.readOnly) return
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (conn?.saveData) return
  // Wait for the user's own scene twice: don't speculate until it has actually painted (on
  // WebGPU that also means its pipelines are warm - the same signal the loading cover lifts on),
  // and then only once its models + textures have gone quiet. Both are capped internally, so a
  // stalled asset delays the sweep rather than cancelling it.
  await whenScenePainted()
  if (isCancelled()) return
  await whenAssetsQuiet()
  if (isCancelled()) return
  // belt fabric is tiny and the belt is a common first part; warming it here also guards the known
  // prod black-belt case (see prefetchConveyorTextures) ahead of the paced per-part sweep.
  // It runs under runSpeculativeWarm, like the per-part sweep below (which reaches it via view.warmPart):
  // these are the sweep's own first bytes, so they count as speculation too. Otherwise they read as the
  // user's own assets, and the quiet signal (and the first-load gate) would be waiting on the warm sweep
  // instead of the scene. See the speculative ledger in render/gltf.ts.
  runSpeculativeWarm(() => prefetchConveyorTextures())
  const s = ec.store.getState()
  const ids = [...new Set([...s.bundledPackages, ...s.userPackages].map((p) => p.id))]
  for (const id of ids) {
    if (isCancelled()) return
    // Re-yield mid-sweep: a scene switch, an undo, or the user dropping a part all start
    // non-speculative fetches, and those must go first. Cheap when nothing is in flight.
    if (assetsBusy()) {
      await whenAssetsQuiet()
      if (isCancelled()) return
    }
    ec.warmCatalogPart('part', id) // → view.warmPart (quiet, deduped, detached)
    await nextIdleSlice() // one detached build per idle slice: never janks the interactive frames
  }
}

export function beginCatalogPlace(press: CatalogPress, ec: CatalogPlaceDeps, type: PartType, clientX: number, clientY: number, packageId?: string): void {
  if (ec.readOnly) return
  const s = ec.store.getState()
  // pressing the already-active card is a toggle-off. For custom parts the identity is the package,
  // so a different package's card is not a toggle-off of the active one.
  const toggleOff = s.mode === 'placing' && s.placingType === type && (s.placingPackageId ?? undefined) === packageId
  // the package being placed is read by computePlacing's custom-part branch through the gesture
  ec.placement.pendingPackageId = packageId ?? null
  press.gesture = { type, moved: false, downX: clientX, downY: clientY, toggleOff }
  if (!toggleOff) {
    ec.surfaceAlignAxis = 1 // fresh placement starts on the default face-snap axis (+Y)
    ec.store.startPlacing(type, packageId ?? null)
  }
}

export function catalogPlaceMove(press: CatalogPress, ec: CatalogPlaceDeps, clientX: number, clientY: number, alt: boolean): void {
  const g = press.gesture
  if (!g) return
  if (!g.moved && Math.hypot(clientX - g.downX, clientY - g.downY) > CATALOG_DRAG_THRESHOLD_PX) g.moved = true
  // keep lastPointer current so a wheel-rotate re-previews under the cursor
  ec.lastPointer = { x: clientX, y: clientY }
  placementOps.previewPlacing(ec.placement, ec, clientX, clientY, alt)
}

export function endCatalogPlace(press: CatalogPress, ec: CatalogPlaceDeps, clientX: number, clientY: number, alt: boolean): void {
  const g = press.gesture
  press.gesture = null
  if (!g) return
  if (!g.moved) {
    // a plain click: toggle off if it re-pressed the active card, otherwise
    // beginCatalogPlace already entered placing mode for click-to-place
    if (g.toggleOff) ec.store.cancelPlacing()
    return
  }
  // a drag: drop one part if released over the viewport, else cancel
  const r = ec.container.getBoundingClientRect()
  const overViewport = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
  if (overViewport) {
    const cached = ec.placement.preview
    const fresh =
      cached && Math.hypot(cached.clientX - clientX, cached.clientY - clientY) < 2
        ? cached
        : placementOps.computePlacing(ec.placement, ec, g.type, clientX, clientY, alt)
    if (fresh) placementOps.placePart(ec.placement, ec, g.type, fresh)
  }
  ec.placement.preview = null
  ec.store.cancelPlacing() // a drag is one-shot, unlike click-to-place
}

/**
 * Place one copy of a package at a screen point, as a card dragged there and released does: a part file dropped on
 * the viewport lands where it was dropped. False when the point gives no placement.
 */
export function placePackageAt(ec: CatalogPlaceDeps, packageId: string, clientX: number, clientY: number): boolean {
  if (ec.readOnly) return false
  const r = ec.container.getBoundingClientRect()
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false
  ec.placement.pendingPackageId = packageId
  ec.surfaceAlignAxis = 1
  ec.store.startPlacing('part', packageId) // opens the placement session (controller onStoreChange)
  const spot = placementOps.computePlacing(ec.placement, ec, 'part', clientX, clientY, false)
  if (spot) placementOps.placePart(ec.placement, ec, 'part', spot)
  ec.placement.preview = null
  ec.store.cancelPlacing()
  return spot !== null
}

export function cancelCatalogPlace(press: CatalogPress, ec: CatalogPlaceDeps): void {
  const g = press.gesture
  press.gesture = null
  if (g?.moved) {
    ec.placement.preview = null
    ec.store.cancelPlacing()
  }
}
