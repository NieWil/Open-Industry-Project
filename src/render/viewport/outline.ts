import { Color } from 'three'
import type { Camera, Object3D, Scene, WebGLRenderTarget } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { webgpuNodeFactory } from '../renderMode'
import type { OutlineMaskMergeSurface } from './outlineMaskMerge'

/**
 * The selection-outline surface the view drives, plus the colour constants both twins composite
 * from. ConsolidatedSelectionOutline (consolidatedOutline.ts) is the WebGL EffectComposer
 * implementation; the WebGPU path swaps in the node-based twin (consolidatedOutlineNode.ts)
 * registered via setWebGPUOutlineFactory, with the same orange selection look.
 */
export interface ISelectionOutline {
  select(objects: readonly Object3D[], activeObjects?: readonly Object3D[]): void
  setSize(width: number, height: number): void
  /** match the composer's internal targets to a new renderer pixel ratio (DRS); optional on the WebGPU outline */
  setPixelRatio?(value: number): void
  /**
   * One-time load warm of the selection mask pass (WebGPU outline only). Its
   * materials are substituted at renderObject time (setRenderObjectFunction), so compileAsync /
   * drawingPipeline.project can never reach them. Without this they codegen + pipeline-compile on the
   * first selection of the session (measured: ~180ms main-thread + ~550ms GPU queue stall on the
   * demo). The view calls it once from compileStaged's held-loop bracket with a synthetic
   * everything-selected membership staged. The implementation renders one off-screen mask pass.
   */
  warmSelection?(): void
  /**
   * The target the scene draws into (WebGL outline only). three keys a WebGL program on the output colour
   * space, which is linear into a render target and sRGB onto the canvas, so a warm compile must bind this
   * target or it links a variant no frame draws.
   */
  sceneTarget?(): WebGLRenderTarget
  render(): void
  dispose(): void
}

// the WebGPU node-based outline, injected by createRenderer once three/webgpu is loaded
// (kept out of the default bundle). null on the WebGL path. Takes the overlay collector its
// final sub-pass draws (the WebGL twin draws overlays inline and needs none).
// getMaskMerge hands it the palette-merged mask (outlineMaskMerge.ts). It is null under
// `?nomaskmerge`, and then the WebGPU outline masks each selected mesh separately.
type WebGPUOutlineFactory = (renderer: WebGPURenderer, scene: Scene, camera: Camera, getOverlays: () => readonly Object3D[], getMaskMerge: () => OutlineMaskMergeSurface | null) => ISelectionOutline
let webgpuOutlineFactory: WebGPUOutlineFactory | null = null
export function setWebGPUOutlineFactory(factory: WebGPUOutlineFactory | null): void {
  webgpuOutlineFactory = factory
}
/** build the WebGPU outline if its factory has been registered, else null (no outline) */
export function createWebGPUOutline(renderer: WebGPURenderer, scene: Scene, camera: Camera, getOverlays: () => readonly Object3D[], getMaskMerge: () => OutlineMaskMergeSurface | null = () => null): ISelectionOutline | null {
  const factory = webgpuNodeFactory(webgpuOutlineFactory, 'selection outline')
  return factory ? factory(renderer, scene, camera, getOverlays, getMaskMerge) : null
}

// 3D selection look: orange screen-space edge outline,
// occluded segments dimmed rather than hidden. (selection box color = 1.0,0.5,0)
// Exported (with the actives + EDGE_STRENGTH below) so both twins composite the exact same
// selection look from one set of constants.
export const VISIBLE_EDGE = new Color(0xff8000)
// occluded segments are dimmed, not hidden (an xray box at ~15% alpha); ~0.48x the visible
const OCCLUDED_DIM = 0.48
export const HIDDEN_EDGE = VISIBLE_EDGE.clone().multiplyScalar(OCCLUDED_DIM)

// The active node (the last-selected, the one a Shift+G reposition steers) gets a brighter
// outline so it stands out in a multi-selection. Both use the same orange hue, with
// the active box at 1.5x the non-active (1.5,0.75,0). Values past 1.0 let an HDR
// pipeline + glow bloom it into a clearly distinct edge. It is not a separate, yellower colour
// (such as 0xffc400); only the brightness differs.
//
// The "same hue, brighter" look comes from scaling the orange into HDR and letting AgX
// (view.ts toneMapping) compress it. A plain LDR "brighter orange" is impossible since the base
// already maxes red at 1.0. AgX has no bloom and heavily compresses highlights, so the
// literal 1.5x is nearly invisible here, and the scale is raised until the perceived difference matches.
// ~4x was chosen from a screenshot sweep (e2e/outline-shot.mjs): clearly brighter than the non-active edge,
// yet still orange (at ≳7x the brightest corners blow out toward white).
const ACTIVE_BOOST = 4
export const ACTIVE_VISIBLE_EDGE = VISIBLE_EDGE.clone().multiplyScalar(ACTIVE_BOOST)
export const ACTIVE_HIDDEN_EDGE = HIDDEN_EDGE.clone().multiplyScalar(ACTIVE_BOOST)
// edge intensity multiplier shared by every pass (and the WebGPU composite)
export const EDGE_STRENGTH = 3

// Feathered-band AA. The detect step centres a solid band on the silhouette. A hard
// cut at the band's rim looks heavy and aliased, so the outer & inner
// extremes of the band ramp from transparent to solid. This value is the ramp width as a fraction of the
// band half: 0 = hard edge (no AA), 0.5 = maximally soft (full intensity only exactly at
// the silhouette, feathering across the whole band). Shared so both consolidated twins
// (consolidatedOutline.ts WebGL + consolidatedOutlineNode.ts WebGPU) feather identically.
export const EDGE_FEATHER = 0.5
