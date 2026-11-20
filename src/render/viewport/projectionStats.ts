import type { Camera } from 'three'
import type { StandardDrawingPipeline } from 'three/webgpu'
import { bundleViewCamera } from '../bundleGroups'
import { OVERLAY_LAYER } from '../env'

/**
 * Per-pass projection visit counters (WebGPU path), on `globalThis.__oipProjStats`: one per call of
 * the drawing pipeline's `project`, which visits one object and recurses through `this.project`.
 * The attribution probe for scene-graph traversal cost. Render bundles keep the main pass's
 * traversal off the bundled subtrees on replay frames (`project` skips a bundle group's
 * children unless it re-records), but every pass that renders with bundles inert (the
 * overlay sub-pass, the outline mask pass, shadow cameras on re-record) walks the full graph.
 * These counters say which pass does the traversal, per frame, at any scene scale: sample `visits`,
 * wait N animation frames, sample again, divide the delta.
 *
 * Keys: 'main' (view camera, default mask; also the mask pass, which reuses the view camera),
 * 'overlay' (the final sub-pass), 'view:<mask>' (unexpected view-camera mask), 'other'
 * (non-view cameras: shadow map passes, thumbnails). Costs ~one property increment per
 * visited node, the same cost class as the __oipBundleCam counters.
 */
export interface ProjectionStats {
  /** projection visits since reset, keyed by pass */
  visits: Record<string, number>
  reset(): void
}

interface Projector {
  project(object: unknown, camera: Camera, ...rest: unknown[]): void
}

const MAIN_MASK = 1
const OVERLAY_MASK = 1 << OVERLAY_LAYER

function passKey(camera: Camera): string {
  if (camera !== bundleViewCamera()) return 'other'
  const mask = camera.layers.mask
  if (mask === MAIN_MASK) return 'main'
  if (mask === OVERLAY_MASK) return 'overlay'
  return `view:${mask}`
}

export function installProjectionStats(renderer: unknown): void {
  const p = (renderer as { drawingPipeline?: StandardDrawingPipeline }).drawingPipeline as Partial<Projector> | undefined
  if (typeof p?.project !== 'function') return // three moved it - probe only, no fallback needed
  const orig = p.project
  const stats: ProjectionStats = {
    visits: {},
    reset() {
      this.visits = {}
    },
  }
  ;(globalThis as Record<string, unknown>).__oipProjStats = stats
  // forwards every argument, so a parameter three adds to project reaches it unchanged
  p.project = function (this: Projector, object, camera, ...rest) {
    const key = passKey(camera)
    stats.visits[key] = (stats.visits[key] ?? 0) + 1
    orig.call(this, object, camera, ...rest)
  }
}
