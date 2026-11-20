import type { PartPackage, RigLink } from '../parts/partPackage'
import { rigGuardSide } from '../guards/guardOpenings'
import { rigLinkEmitsBody } from './rigLinkBody'

/**
 * The rule for which rig links become collision bodies, and which of those are mergeable side-guard walls.
 *
 * The guard merge is keyed by wall, so the builder (sim/rigBuild.ts buildRigBodies) and the merge resolver
 * (core/guards/guardRuns.ts wallSpansOf) must agree exactly on the set of walls a rig contributes. beltGuards.ts,
 * curvedGuards.ts and functionGuards.ts follow the same one-enumeration rule for the other three wall families.
 * Filtering on the guard role alone is not enough: the builder also drops `collision: 'none'` links, mesh links
 * with no collision box, and (through resolved params) a showParam that is off.
 *
 * A link the resolver counts but the builder never emits still forms a run, and the run suppresses every
 * non-owner member. A visual-only guard butted against a real one would then delete the real guard from the sim
 * (owner = the phantom) or extend it as an invisible wall across the neighbour's bed (owner = the real one).
 * Nothing in `examples/parts` authors such a link, but the SDK allows it.
 */

// the link rule lives in rigLinkBody.ts (types-only imports), so cargoBody.ts can share it without an import cycle
export { rigLinkEmitsBody } from './rigLinkBody'

/**
 * Is this link one of the rig's mergeable side-guard walls - a bodied `sideGuard` box sitting off the
 * centreline? The resolver's per-link gate; the builder reaches the same links through
 * {@link rigLinkEmitsBody} + its own `rigGuardSide` classification.
 *
 * Links with `array` are excluded. The builder makes N repeated boxes for one, which a single merged span cannot
 * stand in for, so it stays unmerged and keeps its per-copy bodies.
 */
export function rigGuardWallLink(link: RigLink, resolved: Record<string, unknown>): boolean {
  return !link.array && rigGuardSide(link) !== null && rigLinkEmitsBody(link, resolved)
}

/** Memo on the geometry object: packages are replaced wholesale on an author edit / hot reload, so entries
 *  age out with them (the repo's memoByPkg convention). */
const HAS_GUARD = new WeakMap<object, boolean>()

/**
 * Can this package's rig ever contribute a guard wall? Package-level and conservative. It ignores `showParam`
 * (a per-instance answer), so a togglable guard always says yes and the per-link gate decides.
 *
 * Two callers, and they must use the same predicate: `wallSpansOf` returns early on it before running the rig's
 * forward kinematics, and `participates()` uses it to decide whether a rig's move can change any run at all.
 * 21 of the 22 rigs in examples/parts declare no guard link (platform 37 links, robot 33, gantry 28). Without
 * this check each would run a full FK per scene edit and force a whole-scene re-resolve when moved.
 */
export function rigHasGuardWall(pkg: PartPackage): boolean {
  if (pkg.geometry.kind !== 'rig') return false
  const geo = pkg.geometry
  const hit = HAS_GUARD.get(geo)
  if (hit !== undefined) return hit
  // `{}` for the params: showParam is not resolved here (see above), and no other clause reads them
  const has = (geo.links as RigLink[]).some((l) => rigGuardWallLink(l, {}))
  HAS_GUARD.set(geo, has)
  return has
}
