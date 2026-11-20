import type { Object3D } from 'three'
import type { PartInstance, PartType } from '../../core/types'
import type { ResolvedContext } from '../../core/scene/sceneResolve'
import { isSpeculativeWarm } from '../gltf'
import { dressMetals } from '../metalEnvironment'
import { createBuildingVisual } from './building'
import { createGroupVisual } from './group'
import { createCustomVisual } from './sdkPart'
import { markWarmOnlyVisual } from './structureRev'

export interface PartVisual {
  object: Object3D
  /**
   * `ctx` is the part's bundle of host-computed, neighbour-derived geometry inputs
   * ({@link ResolvedContext}, produced by resolveScene): roller-grid continuity, side-guard
   * openings, spur snap extents, and the stair→platform structure cut. Every field is optional
   * and consumer-specific; a visual reads only the ones its geometry depends on and ignores the
   * rest. undefined = this part has no neighbour-derived inputs (the common case).
   */
  update(part: PartInstance, ctx?: ResolvedContext): void
  setSelected(on: boolean): void
  dispose(): void
}

export type PartVisualFactory = (part: PartInstance) => PartVisual

const factories = new Map<PartType, PartVisualFactory>([
  ['building', createBuildingVisual],
  ['group', createGroupVisual],
  ['part', createCustomVisual],
  // An annotation draws no geometry; its chip is a screen-space overlay (editor/AnnotationOverlay). What it
  // still needs from the renderer is a transform at its world position: that is what the transform gizmo
  // attaches to when it's selected, and what `worldToScreen` is asked about every frame. Same empty-Group
  // visual a container node uses, for the same reason.
  ['annotation', createGroupVisual],
])

export function createPartVisual(part: PartInstance): PartVisual {
  const factory = factories.get(part.type)
  if (!factory) throw new Error(`no visual factory for part type: ${part.type}`)
  const visual = factory(part)
  // A build inside a speculative warm (the idle catalog sweep, the offscreen thumbnail passes) is
  // never drawn by the view, so its structural churn must not advance the scene's epoch (see
  // structureRev.ts). Tagged here as well as inside the bump because a kind whose first structural
  // change is an async attach never bumps while the warm bracket is open.
  if (isSpeculativeWarm()) markWarmOnlyVisual(visual.object)
  // metals get the sky to reflect before their first compile (metalEnvironment.ts); rebuilds and async
  // attaches are covered by bumpStructureVersion
  dressMetals(visual.object)
  return visual
}
