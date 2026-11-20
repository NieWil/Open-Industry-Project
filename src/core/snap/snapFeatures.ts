import { SNAP_CONVEYOR_SEARCH_RADIUS, SNAP_SEARCH_RADIUS } from '../types'
import type { PartInstance } from '../types'
import { angleDiff, clamp } from '../math'
import { isConveyorLike, partFootprint, toLocalXZ } from '../parts/partGeometry'
import { getPackage } from '../parts/partRegistry'
import { resolveRollerGrids } from '../conveyor/rollerGrid'
import type { RollerGrid } from '../conveyor/rollerGrid'
import { FACE_KIND, plugsOf } from './snapConnectors'
import type { Plug } from './snapConnectors'
import { snapOf } from './snapShared'
import { snapConveyor } from './snapConveyor'
import { snapTrack } from './snapTrack'
import { railSocketsOf, seatOnRail } from './snapRails'
import { snapFaceFlush, snapFaceMount } from './snapFace'
import { snapChain, snapEdgeMount, snapEdgeMountInto, snapTile } from './snapEdges'

export interface SnapPose {
  position: [number, number, number]
  rotationY: number
  /** full-orientation tilt (YXZ euler, see PartInstance.rotationX/Z) - set only by the explicit surface
   *  alignment ({@link surfaceAlignPose}); when present the pose applier writes them (0 clears a previous
   *  tilt), when absent the part keeps its own tilt. The ambient snap engine never emits them. */
  rotationX?: number
  rotationZ?: number
}

/** caller policy for one snap evaluation (the editor threads its user toggles through here) */
export interface SnapOptions {
  /** offer the generic face-flush fallback for movers with no declared snap (the editor's face-snap
   *  toggle, Shift+N). Default true. Declared families - including `'face'` mounts - are unaffected. */
  faceFlush?: boolean
  /**
   * Re-solve one join the caller is already showing (the live controller's stickiness): only a candidate with
   * this `via` and `join` is offered, and a conveyor join stays engaged out to SNAP_CONVEYOR_RELEASE instead of
   * the engage distance, so the preview holds through an overshoot or a nudge.
   */
  hold?: { via?: string; join?: string }
}

export interface SnapCandidate {
  pose: SnapPose
  targetId: string
  /** lower is better: horizontalDistance + 0.2*|dy| (+ 0.35*|dRot| where rotation matters) */
  cost: number
  /** world point for the snap cue */
  junction: { x: number; y: number; z: number }
  /**
   * param adjustments the snap implies, applied with the pose as one undo
   * entry. Semantics: chain transfer adopts its lane spacing rounded to
   * whole host roller pitches (laneDistance), blade stop adopts usable bed width (width), barriers set
   * omitPostStart/omitPostEnd at L-corners.
   */
  paramOverrides?: Record<string, number | boolean | string>
  /** param adjustments for the target part (barrier corner partner omit flag) */
  targetParamOverrides?: Record<string, number | boolean | string>
  /**
   * Conveyor only (the override-threshold rule): the mover's body
   * overlaps the target's bed, so this snap was gated on 3-D origin distance rather
   * than the snap interface. Override candidates outrank non-override ones.
   */
  override?: boolean
  /**
   * Committing this snap also soft-parents the mover under the target in the scene tree (a `'face'`-mounted
   * button on its cabinet). Set by a mount declaring `attach: true`; the editor applies it with the pose
   * as the same one undo entry, skipping it if it would create a hierarchy cycle.
   */
  attach?: boolean
  /**
   * Which connectors made this snap, as `<mover plug> -> <host socket>` (e.g. `mounts[1] -> face`,
   * `chain -> chain`, `conveyor`). Diagnostic only - the pose and the fits are
   * the whole contract - for tooling that has to say what matched (npm run snap-part).
   */
  via?: string
  /**
   * Conveyor only: which join within `via`, as `<mover end> -> <target socket>` (`back -> end:front`,
   * `front -> flank:left`). Two candidates with the same target, `via` and `join` are the same join at a new
   * pose, which is how the live controller tells "sliding along it" from "switched to another".
   */
  join?: string
}

/**
 * Top-level entry: evaluate `moving` at `proposed` against all `others`.
 *
 * Every target is solved through the connector model (snapConnectors.ts, docs/part-snap-connectors.md): the
 * mover's plugs (its compiled snap declaration, plus a conveyor's implicit ends) against the target's sockets,
 * one solver per (plug shape, socket shape) in the mates table ({@link solvePlug}), every candidate ranked by
 * one rule within a target and across targets. What each pairing does, by the parts that use it:
 * - conveyors (straight/spur/curved/turntable): every end-to-end and (on a straight) end-to-flank join is solved;
 *   the cheapest that engages is chosen (see snapConveyor). No height gate: the end-mate sets y to the target, so a
 *   floor-rested conveyor still snaps up to a neighbour.
 * - chain_transfer / blade_stop: anchor-to-roller-track. Roller stations at the world-grid phase (rollerStations)
 *   are the 'on' track, midpoints the 'gap' track. A blade anchors to a gap; a chain transfer anchors by lane
 *   parity so every lane sits in a gap, rounds laneDistance to whole host pitches, aligns its lanes along the
 *   track carrying on local -Z, y := host surface + targetLocalY (it rests below the bed), width-fit via
 *   paramOverrides.
 * - guard_rail / fence / safety_gate: same-family chaining (fence + safety_gate together), collinear or 90-degree
 *   L-corner; an L-corner sets the omit-post flags so the shared post is drawn once. The fence family uses
 *   SNAP_FENCE_VISIBLE_THRESHOLD. A barrier also mounts to a platform deck edge.
 * - platform: edge-to-edge against other platforms, 90-degree-step orientation, slide-along-edge, decks coplanar.
 * - stairs: top landing meets a platform edge, the flight resized (run/rise) to the deck and descending away.
 * - floor_marking: edge-to-edge, 90-degree-step orientation, slide-along-edge plus two corner-flush candidates,
 *   cost includes SNAP_ROTATION_COST_WEIGHT * |dRot|.
 * - box_spawner / despawner: never snap (null).
 * - `'face'` mounts (an SDK button / HMI): seat on the nearest vertical footprint face of any part, sliding along
 *   it and in height, clamped to the face rect.
 * - `snap.flush` declarers (crates / pallets / racks, parts that get tiled): footprint sits flush against a
 *   neighbour's footprint face, 90-degree steps, slide + corner-flush, Y kept (floor/leg resolvers own it).
 *   Declared only; the editor's hold-B Face mode ({@link faceMatePose}) covers any part explicitly.
 *
 * `others` excludes nothing - the engine must skip moving.id itself.
 */
export function findSnap(
  moving: PartInstance,
  proposed: SnapPose,
  others: readonly PartInstance[],
  opts?: SnapOptions,
): SnapCandidate | null {
  // blade-stop / chain-transfer (and a custom part with a declarative `track` block) anchor to a roller bed's
  // rendered stations, whose phase and edge nudges depend on each bed's neighbour-resolved grid (curve
  // anchors, butt seams). Resolve once so the snap uses the same rollers the
  // renderer draws; otherwise the part anchors to a phantom grid and sits on a roller.
  const grids = moverPlugs(moving).some((p) => p.shape === 'track') ? resolveRollerGrids(others) : undefined
  let best: SnapCandidate | null = null
  let bestRot = Infinity
  for (const target of others) {
    if (target.id === moving.id) continue
    const c = evalAgainst(moving, proposed, target, grids?.get(target.id), opts)
    if (c === null) continue
    const rot = Math.abs(angleDiff(c.pose.rotationY, proposed.rotationY))
    // override-first rule: a body-overlap conveyor snap outranks any non-override
    // candidate; within a tier, the lower cost is chosen, ties broken by the smaller rotation.
    const cOv = c.override ?? false
    const bOv = best?.override ?? false
    const better =
      best === null ||
      (cOv && !bOv) ||
      (cOv === bOv && (c.cost < best.cost - 1e-9 || (c.cost <= best.cost + 1e-9 && rot < bestRot)))
    if (better) {
      best = c
      bestRot = rot
    }
  }
  return best
}

/**
 * Same contract but restricted to one target (the live controller's sticky
 * target lock re-evaluates against the locked part only).
 */
export function findSnapToTarget(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid?: RollerGrid,
  opts?: SnapOptions,
): SnapCandidate | null {
  if (target.id === moving.id) return null
  return evalAgainst(moving, proposed, target, grid, opts)
}

function evalAgainst(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid?: RollerGrid,
  opts?: SnapOptions,
): SnapCandidate | null {
  // Every (plug, socket) pair this mover has against this target is solved and ranked by one rule - the rule
  // findSnap applies between targets: a body-overlap snap outranks a non-overlap one, then the lower cost.
  // Strictly lower, so an exact tie keeps the earlier pair (the conveyor engine, then plugsOf order). A part that
  // declares several kinds therefore uses whichever fits this drop best (docs/part-snap-connectors.md).
  let best: SnapCandidate | null = null
  const hold = opts?.hold
  const offer = (c: SnapCandidate | null, via: string): void => {
    if (c === null) return
    if (hold !== undefined && (via !== hold.via || c.join !== hold.join)) return
    c.via = via
    const cOv = c.override ?? false
    const bOv = best?.override ?? false
    if (best === null || (cOv && !bOv) || (cOv === bOv && c.cost < best.cost)) best = c
  }

  // Conveyor ends: the implicit connector every conveyor carries, mated conveyor-to-conveyor by the conveyor
  // engine (end-to-end, side merge, curve pairing, spur splay). Belt-like custom/SDK parts (a `path` handle)
  // expose the same ends (conveyorEndsOf) + footprint, so they snap like a built-in belt.
  const conveyor = isConveyorLike(moving)
  if (
    conveyor &&
    isConveyorLike(target) &&
    // broadphase: XZ distance to the target's box, allowing for the mover's reach
    xzDistToTargetBox(target, proposed.position[0], proposed.position[2]) <= SNAP_CONVEYOR_SEARCH_RADIUS + partReach(moving)
  ) {
    offer(snapConveyor(moving, proposed, target, hold?.via === 'conveyor' ? hold.join : undefined), 'conveyor')
  }

  // Structural broadphase: distance from the proposed origin to the target's footprint
  // box, allowing for the mover's reach - same shape as the conveyor branch above.
  // Origin-to-origin distance would wrongly cull large parts (e.g. a wide floor marking
  // or platform) whose edges already touch but whose centres sit > SNAP_SEARCH_RADIUS
  // apart: a default 8 m-wide marking tiled along its wide edge has its origins 8 m
  // apart, and a 12 m one 12 m apart. The per-snap SNAP_VISIBLE_THRESHOLD move gate
  // (and each snap's own engage checks) still bound how far a part actually snaps, so
  // widening this pre-filter only admits candidates that would otherwise be dropped too early.
  if (xzDistToTargetBox(target, proposed.position[0], proposed.position[2]) > SNAP_SEARCH_RADIUS + partReach(moving)) {
    return best
  }
  if (moving.type !== 'part') return best
  for (const plug of moverPlugs(moving)) solvePlug(plug, moving, proposed, target, grid, opts, offer)
  return best
}

/** the mover-side connectors of a part - its compiled snap declaration (snapConnectors.ts) */
function moverPlugs(part: PartInstance): readonly Plug[] {
  return part.type === 'part' ? plugsOf(getPackage(part.packageId)?.snap) : []
}

/**
 * The mates table: for each plug shape, the sockets it seeks on a target and the solver that seats it. A new
 * pairing is a new case here plus a solver; a new declaration of an existing shape needs neither (it compiles to
 * plugs in snapConnectors.ts). `offer` receives every candidate with its `<plug> -> <socket>` label.
 */
function solvePlug(
  plug: Plug,
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid: RollerGrid | undefined,
  opts: SnapOptions | undefined,
  offer: (c: SnapCandidate | null, via: string) => void,
): void {
  switch (plug.shape) {
    case 'track':
      // a seat on a roller bed's rendered stations (the SDK blade stop; the SDK chain transfer via track.lanes)
      offer(snapTrack(moving, proposed, target, plug.track, grid), 'track -> rollerBed')
      return
    case 'rect': {
      // peer: tiles edge-to-edge onto a same-group tile part (floor markings, decks)
      const theirs = snapOf(target)?.tile
      if (theirs) offer(snapTile(moving, proposed, target, plug.tile, theirs), 'tile -> tile')
      return
    }
    case 'line': {
      // peer: chains end-to-end / at an L-corner with a same-group chain part (barriers)
      const theirs = snapOf(target)?.chain
      if (theirs) offer(snapChain(moving, proposed, target, plug.chain, theirs), 'chain -> chain')
      return
    }
    case 'edgeSeat':
      // on a host deck edge: every declared surface of the accepted kind (a platform's deck). Facing along it, a
      // barrier on the rim; facing into it, a flight/ramp/ladder whose contact point is placed on the edge.
      snapOf(target)?.surfaces?.forEach((deck, i) => {
        if (deck.kind !== plug.edgeMount.accepts) return
        const seat = plug.edgeMount.facing === 'into' ? snapEdgeMountInto(moving, proposed, target, plug.edgeMount, deck) : snapEdgeMount(moving, proposed, target, plug.edgeMount, deck)
        offer(seat, `edgeMount -> surfaces[${i}]`)
      })
      return
    case 'mount':
      // a device: a `'face'` mount seats on any part's implicit footprint faces; any other kind on each rail
      // socket of that kind the target has (a conveyor's guard pair, a declared surface's pair)
      if (plug.mount.accepts === FACE_KIND) {
        offer(snapFaceMount(moving, proposed, target, plug.mount), `${plug.label} -> face`)
        return
      }
      for (const rail of railSocketsOf(target, plug.mount.accepts)) {
        offer(seatOnRail(moving, proposed, target, plug.mount, rail), `${plug.label} -> ${rail.label}`)
      }
      return
    case 'footprint':
      // Ambient face-flush, declared and never inferred: only a part whose package states `snap: { flush: true }`
      // flushes its footprint box against a neighbour's face. It engages within SNAP_FACE_THRESHOLD (0.75 m), so
      // it suits only parts bigger than that gate. The rack (2.8 × 1.4) declares it, so a row of racking builds by
      // dropping one beside the last. Cargo must not: a box (0.6 × 0.4) dropped 0.7 m clear of another is still
      // inside the gate and would be pulled flush; the same goes for a pallet (1.22 × 1.02). The SNAP_KIND_OWNER
      // ledger in bundledPackageData.test.ts pins both halves: the rack declares it, cargo must not.
      // A part that declares nothing does not flush, so no per-type exceptions (spawners, conveyors, …) are
      // needed. The editor's hold-B Face mode (faceMatePose) is the explicit path for any undeclared part. The
      // caller can still switch the whole ambient tier off (opts.faceFlush - the editor's Shift+N face-snap toggle).
      if (opts?.faceFlush !== false) offer(snapFaceFlush(moving, proposed, target), 'flush -> face')
      return
  }
}

/** max XZ reach of the part's footprint from its origin (the broadphase reach) */
function partReach(part: PartInstance): number {
  const fp = partFootprint(part)
  // an off-centre footprint (a tail-origin conveyor, an off-centre bounds box) reaches (c + h) from the origin
  return Math.max(Math.abs(fp.cx ?? 0) + fp.hx, Math.abs(fp.cz ?? 0) + fp.hz)
}

/** XZ distance from a world point to the target's footprint box (0 when inside) */
function xzDistToTargetBox(target: PartInstance, px: number, pz: number): number {
  const fp = partFootprint(target)
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  const l = toLocalXZ(target, px, pz)
  const cx = clamp(l.x, fcx - fp.hx, fcx + fp.hx)
  const cz = clamp(l.z, fcz - fp.hz, fcz + fp.hz)
  return Math.hypot(l.x - cx, l.z - cz)
}
