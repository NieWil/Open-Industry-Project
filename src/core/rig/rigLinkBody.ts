// Which rig links become collision bodies (re-exported by core/rig/rigGuards.ts, which explains why the builder and the
// guard-merge resolver must agree). A module of its own, importing types only, so core/cargoBody.ts can use the same
// rule without importing the guard machinery (rigGuards -> guardOpenings -> partGeometry -> frame -> cargoBody would
// be an import cycle).

import type { RigLink } from '../parts/partPackage'

/**
 * Is a link with this `showParam` there under these params (RigLink.showParam)? A boolean param's name: unless it is
 * false. `'param=value'`: while that param is `value`. A missing param reads as shown either way. Every reader of
 * showParam (render, collision, arrays, bounds) asks here.
 */
export function showParamShows(showParam: string | undefined, params: Readonly<Record<string, unknown>>): boolean {
  if (!showParam) return true
  const eq = showParam.indexOf('=')
  if (eq < 0) return params[showParam] !== false
  const v = params[showParam.slice(0, eq)]
  return v === undefined || v === showParam.slice(eq + 1)
}

/**
 * Does this rig link get a collision body at all? The single source of truth for buildRigBodies' skip list.
 * `resolved` must be the package-resolved params (defaults folded in), not the raw instance params: a
 * default-true guard toggle keeps its body when the instance leaves the param unset, and a default-false one
 * must not be counted as a wall.
 */
export function rigLinkEmitsBody(link: RigLink, resolved: Record<string, unknown>): boolean {
  // 'label' is a render-only text plane; 'leg' is a render-only support trestle; 'cone' is a render-only schematic cue
  const kind = link.shape.kind
  if (kind === 'label' || kind === 'leg' || kind === 'cone') return false
  if (link.collision === 'none') return false // a decorative primitive renders but never collides
  if (!showParamShows(link.showParam, resolved)) return false // a structural toggle switched off
  // a visual-only mesh link, and a transform-only 'frame' pivot, have no body unless they declare a collision box
  if ((kind === 'mesh' || kind === 'frame') && typeof link.collision !== 'object') return false
  if (link.conveys) return false // built as a static conveyor body (attachRigConveyors), not a link body
  return true
}
