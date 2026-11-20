import type { PartInstance } from '../types'
import { collisionProxy, shapeCornersLocal } from './collisionShapes'
import type { Vec3 } from './collisionShapes'

export type { Vec3 }

/**
 * Local-frame collision vertices for a part - the corner points of its editor
 * collision proxy ({@link collisionProxy}), the default vertex-snap source.
 * Points are in the part root's local
 * frame; the caller transforms them by the part's world matrix, so they follow
 * position + rotation.
 *
 * The proxy is the single source of truth shared with the physics deck geometry
 * and the drop-raycast layer, so a part can never snap to geometry it does not
 * actually collide with.
 */
export function collisionVerticesLocal(part: PartInstance): Vec3[] {
  return collisionProxy(part).flatMap(shapeCornersLocal)
}
