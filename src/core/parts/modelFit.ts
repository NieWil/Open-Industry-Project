// Fit a part to the model that was just imported into it, when the model is the whole part.
//
// An imported mesh is render-only and the part's footprint was the shape it replaced, so without this a new part
// made from a model floats where the old shape's offset left it, collides with nothing, and places, snaps and
// selects as the old shape's box. A part whose rig is just that model (its one node, unjointed and unturned) is
// refitted: the model stands on the origin, a hidden box link of its size is the collider (a mesh's own collision
// box is centred on its link origin, which here is the model's underside), and the bounds are the model's box. Any
// other rig is the author's arrangement and is left as it is.

import type { Box3Like } from '../glbBox'
import type { RigGeometry, RigLink } from './partPackage'

/** the hidden box link a fit adds, and refreshes on the next import into the same part */
export const MODEL_COLLIDER = 'collider'

/** the thinnest a collider is made: a flat model (a sign, a mat) still has something to stand on */
const MIN_THICKNESS = 0.01

/**
 * `geometry` with `linkName`'s model on the origin (centred in X and Z, underside on y = 0), a collider of the
 * model's size and bounds to match, or null when the rig is more than that one model. `box` is the model's extent
 * in the link's own frame (core/glbBox meshLinkBox).
 */
export function fitRigToModel(geometry: RigGeometry, linkName: string, box: Box3Like): RigGeometry | null {
  if (geometry.joints.length > 0 || geometry.bounds?.params?.length) return null
  const target = geometry.links.find((l) => l.name === linkName)
  if (!target || target.parent !== undefined || target.quat || (target.rotation ?? [0, 0, 0]).some((r) => r !== 0)) return null
  const others = geometry.links.filter((l) => l !== target)
  const earlierFit = others.length === 1 && isModelCollider(others[0]!)
  if (others.length > 0 && !earlierFit) return null

  const size = [0, 1, 2].map((k) => Math.max(MIN_THICKNESS, box.max[k]! - box.min[k]!)) as [number, number, number]
  const offset: [number, number, number] = [-(box.min[0]! + box.max[0]!) / 2, -box.min[1]!, -(box.min[2]! + box.max[2]!) / 2]
  const collider: RigLink = { name: MODEL_COLLIDER, shape: { kind: 'box', size }, offset: [0, size[1] / 2, 0], hidden: true }
  return {
    ...geometry,
    links: [{ ...target, offset }, collider],
    bounds: { length: size[0], width: size[2], top: size[1] },
  }
}

function isModelCollider(l: RigLink): boolean {
  return l.name === MODEL_COLLIDER && l.hidden === true && l.parent === undefined && l.shape.kind === 'box'
}
