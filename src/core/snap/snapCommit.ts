// What committing a snap writes to the scene, in one place: the editor's drop (controller/snapRest.ts
// withSnapOverrides), the agent door's snap_part and the headless `npm run snap-part --write` all apply a
// findSnap candidate through this, so the three cannot drift.
//
// A committed snap writes four things and only these: the mover's pose, the params the snap fits on the mover
// (`paramOverrides`, e.g. an eye's range across the belt), the params it fits on the host
// (`targetParamOverrides`, e.g. a barrier's corner-partner post), and, for an `attach` mount, the soft parent
// (skipped where it would make a hierarchy cycle). Everything else a snap "does" (a guard opening where a conveyor
// meets another's side, a railing gap, a deck notch, an edge-mounted guest's lift) is derived from the scene by
// the seam resolvers each time it resolves (core/scene/sceneResolve.ts), so it is never written.

import { wouldCreateCycle } from '../scene/hierarchy'
import type { SnapCandidate } from './snapFeatures'
import type { PartInstance } from '../types'

export interface CommitSnapOptions {
  /** also write the candidate's pose onto the mover (default true). The editor's live drag leaves it off: its
   *  gesture already moved the part to the pose it previews. */
  pose?: boolean
}

/** Whether committing `c` for `movingId` soft-parents it under the snap target (an `attach` mount, no cycle). */
export function snapAttaches(parts: readonly PartInstance[], movingId: string, c: SnapCandidate): boolean {
  return (c.attach ?? false) && !wouldCreateCycle(parts, movingId, c.targetId)
}

/**
 * `parts` with the snap `c` committed for the part `movingId`: a new array, the parts it does not touch kept by
 * identity. Returns `parts` itself when the candidate changes nothing beyond what `opts.pose: false` leaves out.
 */
export function commitSnap(parts: readonly PartInstance[], movingId: string, c: SnapCandidate, opts: CommitSnapOptions = {}): readonly PartInstance[] {
  const pose = opts.pose ?? true
  const attach = snapAttaches(parts, movingId, c)
  if (!pose && !c.paramOverrides && !c.targetParamOverrides && !attach) return parts
  return parts.map((p) => {
    if (p.id === movingId) {
      let next = p
      if (pose) next = { ...next, position: [...c.pose.position] as [number, number, number], rotationY: c.pose.rotationY } as PartInstance
      if (c.paramOverrides) next = { ...next, params: { ...(next as { params?: object }).params, ...c.paramOverrides } } as PartInstance
      if (attach && next.parent !== c.targetId) next = { ...next, parent: c.targetId } as PartInstance
      return next
    }
    if (p.id === c.targetId && c.targetParamOverrides) {
      return { ...p, params: { ...(p as { params?: object }).params, ...c.targetParamOverrides } } as PartInstance
    }
    return p
  })
}
