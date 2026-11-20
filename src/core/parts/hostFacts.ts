// The facts the host hands a drawn part through its params.
//
// A part never sees the scene, so the host works out what its surroundings mean for it (a neighbour's end butting a
// guard, a sensor beam crossing one, the wall of the conveyor it merges onto) and passes each fact in as a hidden
// numberList param of a fixed name, which the part's geometry() reads. The sim builds a drawn part's colliders from
// the same params, so the fact reaches the collision as well as the mesh. A part takes a fact by declaring its param.
//
// One that leaves a param out loads and runs, and that fact never reaches it: no error, just a guard that stays shut
// where a diverter's arms cross it, or a beam that passes through solid steel. hostFactWarnings names each fact a
// part's own declarations say it needs and does not take (check-part prints them). A warning, never a refusal: a
// part may mean to leave one out.
//
// A rig part takes none of these: the host cuts and fits its guard and rail links itself.

import { bedOf, type BedKind } from '../conveyor/conveyorBeds'
import { evalPartGeometry, resolvePartParams } from '../geometry/geometryEval'
import type { PartPackage } from './partPackage'
import type { PartInstance } from '../types'

/** What a fact's "does this part need it" rule reads, worked out once from the default instance. */
interface FactSubject {
  /** its bed kind, null for a part that is not a conveyor to its neighbours */
  kind: BedKind | null
  /** draws a side guard (a `finish: 'guard'` or `sideGuard` submesh) */
  guards: boolean
  /** draws a frame rail (a `finish: 'frame'` submesh) */
  rails: boolean
  /** its guards open where a conveyor end or a diverter meets them (the bed's guardHost) */
  opens: boolean
  /** its rails and guards meet a host's wall when it side-merges (the bed's mergeFaces) */
  merges: boolean
  /** no conveyor merges onto its side (the bed's endJoinsOnly), so no junction cuts its guard ends */
  endJoinsOnly: boolean
}

export interface HostFact {
  /** the param's fixed name */
  param: string
  /** one row's columns */
  row: string
  /** what the host fills it with */
  what: string
  /** also written by the author (in guard-openings mode), so it is shown rather than hidden */
  authored?: true
  /** what goes wrong without it, for a part that needs it, else null */
  missing(s: FactSubject): string | null
}

export const HOST_FACTS: readonly HostFact[] = [
  {
    param: 'guardOpenings',
    row: '[start m, end m, side ±1/0]',
    what: "a belt's guard openings, in arc length from the tail: the ones authored in guard-openings mode and the ones a neighbour's end or a diverter makes",
    authored: true,
    missing: (s) => (s.guards && s.opens && s.kind === 'path' ? "a neighbour's end or a diverter will not open its guards" : null),
  },
  {
    param: 'guardGaps',
    row: '[x0 m, x1 m, side ±1]',
    what: "where the host opens a straight or spur bed's guards, in its local X (a diverter mounted on the guard)",
    missing: (s) => (s.guards && s.opens && s.kind !== 'path' ? 'a diverter mounted on its guard will not open it, so the arms run into solid guard' : null),
  },
  {
    param: 'guardHoles',
    row: '[x m, y m, side ±1]',
    what: "where a sensor beam crosses a guard: local X (a curve's arc angle), and the beam's height above the deck",
    missing: (s) => (s.guards && (s.opens || s.kind === 'arc') ? 'a sensor beam crossing its guards cuts no hole, so the beam passes through solid guard' : null),
  },
  {
    param: 'guardExtents',
    row: '[side ±1, backX m, frontX m]',
    what: "where its rails and guards stop when it side-merges onto another conveyor: the host's outer wall plane",
    missing: (s) => (s.merges && (s.guards || s.rails) ? 'its rails and guards will not reach (or pull back to) the wall of a conveyor it side-merges onto' : null),
  },
  {
    param: 'guardMitres',
    row: '[x m, c, side ±1]',
    what: 'how each guard end at a junction is cut to meet the other guard on one plane',
    missing: (s) => (s.guards && (s.merges || (s.opens && !s.endJoinsOnly)) ? 'its guard ends at a junction stay square and cross the other guard' : null),
  },
  {
    param: 'railCuts',
    row: '[x m, c, side ±1]',
    what: 'how each rail end is cut to stop against the frame of the conveyor it side-merges onto',
    missing: (s) => (s.merges && s.rails ? 'its rails run into the frame of a conveyor it side-merges onto' : null),
  },
  {
    param: 'legRests',
    row: '[x0 m, x1 m, dy m]',
    what: 'per-leg footing where the surface under the part is not its floor plane (a platform crossing under it)',
    // whether a part draws legs is not something its declarations say
    missing: () => null,
  },
]

/**
 * What a drawn part declares wrongly or leaves out among the host-fed params, as one sentence each. `part` is its
 * default instance (createSdkPart), with the package registered, since the bed is read through the registry.
 */
export function hostFactWarnings(pkg: PartPackage, part: PartInstance): string[] {
  const out: string[] = []
  for (const f of HOST_FACTS) {
    const spec = pkg.params[f.param]
    if (!spec) continue
    if (spec.type !== 'numberList' || spec.arity !== 3) out.push(`\`${f.param}\` is filled by the host with ${f.row} rows: declare it as a numberList of arity 3`)
    else if (spec.hidden !== true && !f.authored) out.push(`\`${f.param}\` is filled by the host: declare it \`hidden: true\`, since an edit in the Inspector is overwritten`)
  }
  if (pkg.geometry.kind !== 'drawn') return out
  const drawn = evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params, {})) ?? []
  const bed = bedOf(part)
  const subject: FactSubject = {
    kind: bed?.kind ?? null,
    guards: drawn.some((m) => m.finish === 'guard' || m.sideGuard !== undefined),
    rails: drawn.some((m) => m.finish === 'frame'),
    opens: bed !== null && bed.guardHost(part) !== null,
    merges: bed !== null && bed.mergeFaces(part) !== null,
    endJoinsOnly: bed?.endJoinsOnly ?? false,
  }
  for (const f of HOST_FACTS) {
    if (pkg.params[f.param]) continue
    const why = f.missing(subject)
    if (why) out.push(`no \`${f.param}\` param: ${why}. The host fills it with ${f.row} rows (${f.what}); see the part authoring guide`)
  }
  return out
}
