// The render view's shared types: its options, the per-part Entry record, the tick-callback
// signatures, the merge-coherence report, and the surface the e2e fleet may reach (view.ts re-exports).

import type {
  Box3,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { PartInstance } from '../../core/types'
import type { SubPose } from '../../core/rig/rigPose'
import type { IRenderView } from '../api'
import type { EditorCamera } from './editorCamera'
import type { PartVisual } from '../parts/registry'

/** one merge mechanism's coherence verdict - see {@link RenderView.auditMergeCoherence} */
export interface MergeCoherenceCheck {
  /** the mechanism, e.g. `instancePool`, `staticFold:tiledWalls`, `cargoSelection` */
  name: string
  ok: boolean
  /** why it failed, or '' */
  reason: string
}

/** the AND over every merge mechanism, with the per-mechanism breakdown for triage */
export interface MergeCoherenceReport {
  ok: boolean
  /** `<name>: <reason>` of the first failure, or '' */
  reason: string
  checks: MergeCoherenceCheck[]
}

export interface RenderViewOptions {
  /** called once per rendered frame with the frame delta in seconds */
  onFrame?: (dt: number) => void
  /**
   * Pre-built renderer to draw with. Defaults to a WebGLRenderer. Pass an initialised WebGPURenderer for the experimental
   * ?webgpu mode - see createRenderer.ts. Under WebGPU the EffectComposer selection
   * outline and every onBeforeCompile GLSL effect are skipped/degraded (WebGL-only).
   */
  renderer?: WebGLRenderer | WebGPURenderer
}

/** one placed part's render-side record, exported for the viewport modules (vertexSnapPick.ts) */
export interface Entry {
  part: PartInstance
  visual: PartVisual
  /**
   * last applied neighbour-derived signature ({@link renderResolvedKey}): roller grid + guard openings +
   * spur extents + stair→platform cut, folded into one. A change re-applies the part (reflow, or rebuild
   * for the structure cut) even when its own pose/params didn't move.
   */
  resolvedSig: string
  /** last built flow-arrow geometry signature; skips instanced-bank rewrites on pose-only
   *  changes ('' = no arrow: non-conveyor). The arrow itself is in the view's shared
   *  FlowArrowBank (keyed by part id), not on the entry; see syncFlowArrow. */
  flowSig: string
  /**
   * invisible collision-raycast proxy (conveyor family only; null otherwise). Built
   * from collisionShapes.collisionProxy and raycast by surfaceAt/surfaceBelow in place
   * of the cosmetic visual, so drop placement targets the true deck, not the gaps
   * between rendered strips/rollers. Lives off-scene; matrix maintained on rebuild.
   */
  proxy: Group | null
  /**
   * cached world-space AABB, the broadphase bound for the part raycasts
   * (surfaceAt / pickPart / ...). Recomputed lazily via boundsOf(): a scene sync
   * only marks it stale (boundsDirty), and the first consumer that actually needs
   * it does the subtree traversal. Dragging N parts vertically re-syncs them every
   * frame but casts no part rays, so the per-frame Box3.setFromObject walk
   * (measured ~2 ms/frame at 60 conveyors) is off the drag hot path.
   * Empty until first computed.
   */
  bbox: Box3
  /** bbox + proxy are stale (part changed since last refreshBounds); see boundsOf() */
  boundsDirty: boolean
  /**
   * the visual's userData.poseRev last baked into this part's frozen matrices (see
   * syncMatrixFreeze / ensureFreshPose). The visual bumps poseRev whenever any content
   * update moves a link transform; a frozen part whose rev moved re-bakes before it's
   * read or rendered, so no mutation path has to know about the freeze to stay visible.
   */
  bakedPoseRev: number
  /**
   * structureVersion at the last matrix bake: the async-attach twin of bakedPoseRev.
   * Every late child arrival (GLB mesh, roller pool, chain lane) bumps the visual's
   * structureVersion; ensureFreshPose re-bakes (and re-clamps matrixAutoUpdate on) the
   * subtree so stragglers join the freeze instead of dangling live and never updating.
   */
  bakedStructRev: number
}

// the per-frame callback signatures part visuals publish on their root's userData
// (sdkPart.rebuild, building.ts); hoisted into the view's tick registries
export type PartTick = (dt: number, running: boolean) => boolean | void
export type PartViewTick = (camera: PerspectiveCamera, firstPerson: boolean) => boolean | void
export type PartProbeTick = (probe: (origin: Vector3, dir: Vector3, maxDist: number, linkName: string) => { distance: number; color: Color } | null) => boolean | void

export type SubPoseMap = Record<string, SubPose>

export interface Flash {
  mesh: Mesh
  material: MeshBasicMaterial
  age: number
}

export interface FocusAnim {
  t: number
  fromTarget: Vector3
  toTarget: Vector3
  fromPos: Vector3
  toPos: Vector3
}

/**
 * What the E2E fleet is allowed to reach for, over and above {@link IRenderView}.
 *
 * `IRenderView` is the app's contract: what the editor calls. The ~150 `e2e/verify-*.mjs` scripts
 * drive a wider surface than that through the `window.__oip` hook: `view.camera` is used by 57
 * scripts, `view.renderer` by 56, `view.scene` by 43, `view.entries` by 26. Untyped, renaming any of
 * them breaks dozens of gates with no compile error anywhere, and the breakage shows up hours later
 * as an unattributable timeout in a browser sweep. (Measured via `npm run check:e2e`, which
 * typechecks the fleet against this hook.)
 *
 * Everything listed here is already public on RenderView, so declaring it loses no encapsulation.
 * It makes the de-facto contract explicit, and because RenderView `implements` it, enforced: rename
 * a member and this file stops compiling in the same commit, instead of the gates breaking silently.
 *
 * That is also why it is short. The fleet also reaches ~20 `private` fields (`boxes`,
 * `instancePool`, `outline`, `warmQueue`, …). Listing those would widen real encapsulation and let
 * app code reach in too, so each needs its own decision: expose a purpose-built observation accessor
 * (the `getStats()` / `auditMergeCoherence()` pattern), or change the script. Add to this interface
 * deliberately, not just to make a test compile.
 */
export interface IRenderViewTestSurface extends IRenderView {
  readonly renderer: WebGLRenderer | WebGPURenderer
  readonly scene: Scene
  readonly camera: EditorCamera
  /** read-only: a test observes the entry table, it does not edit it */
  readonly entries: ReadonlyMap<string, Entry>
  robotGizmoId: string | null
  /** the shared sim-animation clock (animClock.ts): the one CPU-visible sign that shader-integrated
   *  animations (belt scroll, roller spin) are advancing; it holds while the sim is paused */
  readonly animClock: number
  /** VR, observed: where the walk put the floor rig and what the laser shows (null when not presenting) */
  vrState(): VRState | null
}

/** what a headset is showing that the DOM can't: the rig pose the walk placed, and the Use laser */
export interface VRState {
  rig: { position: [number, number, number]; yaw: number }
  laser: { hand: string | null; length: number; live: boolean }
}
