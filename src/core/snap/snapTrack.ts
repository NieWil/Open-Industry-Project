// Track snapping for findSnap (snapFeatures.ts): chain transfers, blade stops and custom track parts seated on a
// roller conveyor's tracks.

import { FRAME_WALL_THICKNESS, SNAP_HEIGHT_COST_WEIGHT, SNAP_VISIBLE_THRESHOLD } from '../types'
import type { PartInstance } from '../types'
import { clamp } from '../math'
import type { SnapTrack } from '../parts/partApi'
import { isWorldPhaseRollerBed, rectangleBedOf, resolveInclineRad, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { rollerBedPitch, rollerStations } from '../conveyor/rollerGrid'
import type { RollerGrid } from '../conveyor/rollerGrid'
import { clampToParamSpec, EPS, nearerYaw, numParamOf, paramRange } from './snapShared'
import type { SnapCandidate, SnapPose } from './snapFeatures'

// How far outside a roller bed's footprint a track part (blade stop / chain transfer) still engages the seat.
// These are on-top attachments whose snap feature carries a loose 2.0 m visible-move gate and
// skips the body-overlap gate, so the drop engages when it's roughly over or near the bed
// rather than requiring edge contact (a loose 2 m, not a tight 0.35 m). The move gate (SNAP_VISIBLE_THRESHOLD)
// still bounds how far the part is pulled to its anchor.
const TRACK_ENGAGE_DISTANCE = 2.0
// Vertical version of the same loose gate. A track part dropped on top of the rollers rests its deep underside
// (|bounds.bottom|, ~0.44 m for the chain transfer) on the roller tops, so its origin sits that far above the seat -
// well past the tight structural tolerance (SNAP_HEIGHT_TOLERANCE, 0.35). These on-top parts are gated on
// the same loose 2 m visible-move gate, then the snap pulls the part down so its deck seats level with the bed.
const TRACK_HEIGHT_TOLERANCE = 2.0

/**
 * The lane spacing a lane-parity track snap adopts: the part's authored spacing rounded to the nearest whole
 * multiple of the host roller pitch (at least one), clamped to the param's declared range in whole pitches.
 * Falls back to a single pitch when the part declares no spacing param or holds no usable value.
 *
 * Whole multiples are the entire constraint. A lane bank steps `spacing` apart, so every lane stays in a roller
 * gap only when `spacing` is an exact multiple of the pitch - an arbitrary authored value walks the lanes onto
 * the rollers a fraction at a time, which this snap exists to prevent. Rounding keeps the authored spacing as
 * closely as that allows, where overwriting it would not: a 5-lane transfer authored at 0.33 m keeps a ~1.2 m bank
 * instead of collapsing onto the 0.075 m roller pitch at 0.3 m wide.
 *
 * Rounding, not assigning the bare pitch, is deliberate. demoScenes' hand-authored 0.225 -
 * "a multiple of the host's 0.075 m roller spacing so lanes land in roller gaps" - is the rule this reproduces.
 */
function adoptedLaneSpacing(moving: PartInstance, pitchParam: string | undefined, pitch: number): number {
  const authored = pitchParam === undefined ? null : numParamOf(moving, pitchParam)
  if (authored === null || authored <= 0) return pitch
  const { lo, hi } = paramRange(moving, pitchParam!)
  const kMin = Math.max(1, Number.isFinite(lo) ? Math.ceil(lo / pitch - EPS) : 1)
  const kMax = Number.isFinite(hi) ? Math.floor(hi / pitch + EPS) : Infinity
  // A declared range narrower than one host pitch holds no whole multiple at all - min 0.10 / max 0.11 against
  // a 0.075 m pitch has its neighbouring multiples at 0.075 and 0.150 - so the two constraints cannot both
  // hold. The multiple takes precedence, because it is the functional requirement (it keeps every lane in a
  // roller gap); the only question is which way to miss. Undershoot gives a tighter bank, which the on-bed clamp
  // in snapTrack already handles; overshoot gives a wider one whose outer lanes can hang off the bed. So respect
  // the declared ceiling and fall back toward a single pitch rather than writing
  // a value above the param's max (as `Math.max(kMin, …)` would): out of range in the Inspector, and liable to
  // be silently re-clamped by any later edit.
  if (kMax < kMin) return Math.max(1, kMax) * pitch
  return clamp(Math.round(authored / pitch), kMin, kMax) * pitch
}

export function snapTrack(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  track: SnapTrack,
  grid?: RollerGrid,
): SnapCandidate | null {
  // host must be a straight SDK roller bed (the converged twin of the built-in roller conveyor); an SDK track
  // part (blade stop / chain transfer, declaring snap.track) seats onto its rendered roller stations.
  const hostView = isWorldPhaseRollerBed(target) ? rectangleBedOf(target) : null
  if (!hostView) return null
  // ...and a level one. A blade stop halts product and a chain transfer lifts it across; on a roller incline the
  // stopped product runs back down (rollers shed it past 30 degrees, and slip well before), so neither is fitted
  // there, and the stations below are laid out for a flat bed (plan X, seat at the origin height).
  if (resolveInclineRad(target) !== 0) return null
  const pitch = rollerBedPitch(target)
  if (pitch === null || pitch <= 0) return null
  const stations = rollerStations(target, grid)
  if (stations.length < 2) return null
  // a custom track part seats targetLocalY above the bed surface
  const ty = target.position[1] + (track.targetLocalY ?? 0)
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > TRACK_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const a = toLocalXZ(target, px, pz)

  // SDK roller bed is centre-origin: bed spans local x ±length/2
  const hw = hostView.width / 2
  const x1 = hostView.length / 2
  const x0 = -x1
  const ddx = Math.max(x0 - a.x, a.x - x1, 0)
  const ddz = Math.max(Math.abs(a.z) - hw, 0)
  if (Math.hypot(ddx, ddz) > TRACK_ENGAGE_DISTANCE) return null

  const usable = stations.filter((s) => s >= x0 && s <= x1)
  if (usable.length < 2) return null
  const first = usable[0]!
  const last = usable[usable.length - 1]!
  let anchorX: number
  let yaw: number
  let paramOverrides: Record<string, number | boolean | string> | undefined
  const lanes = track.lanes
  if (lanes) {
    // Lane-parity anchor (a custom part declaring track.lanes, e.g. the SDK chain transfer): N lanes stepped
    // one pitch apart along the track, so an odd count centres its middle lane in a roller gap and an even
    // count on a station, clamped so the outermost lanes stay on the bed.
    const chains = Math.max(1, Math.round(numParamOf(moving, lanes.countParam) ?? 1))
    // Adopt the authored spacing rounded to whole host pitches rather than overwriting it with the bare pitch
    // (see adoptedLaneSpacing): the bank keeps the size its author gave it, and every lane still sits in a gap.
    const spacing = adoptedLaneSpacing(moving, lanes.pitchParam, pitch)
    const steps = Math.round(spacing / pitch) // whole pitches per lane step (>= 1)
    // the bank's half-span is measured in the adopted spacing, so the on-bed clamp below keeps the outermost
    // lanes on the bed. Measured in `pitch`, it would under-measure the bank by `steps`x and let the end lanes
    // hang off the end of the conveyor.
    const extent = ((chains - 1) * spacing) / 2
    // Origin parity, generalized over the spacing multiple. Lanes sit at (i - (chains-1)/2)·spacing from the
    // origin: integer multiples of the spacing for an odd count, half-integer for an even one. So every lane
    // sits in a roller gap when - odd count: the origin is in a gap (any multiple keeps whole pitches between
    // lanes); even count: the origin is in a gap if `steps` is even (half-integer x even = whole pitches), and
    // on a station if `steps` is odd (half-integer x odd = half pitches, which puts the lanes in the gaps
    // either side). With a one-pitch step this reduces to odd->gap / even->station, the
    // two anchor kinds (gap / on).
    const base = chains % 2 === 0 && steps % 2 === 1 ? first : first + pitch / 2
    let n = Math.round((a.x - base) / pitch)
    const lo = first + pitch / 2 + extent
    const hi = last - pitch / 2 - extent
    const nMin = Math.ceil((lo - base - EPS) / pitch)
    const nMax = Math.floor((hi - base + EPS) / pitch)
    if (nMax >= nMin) n = clamp(n, nMin, nMax)
    anchorX = base + n * pitch
    // The lane bank spreads along the part's local X (its `chains` array is authored +Z but the chain link is
    // yawed 90°, so the bank ends up along local X) and each lane runs across it along local Z (the divert axis).
    // So to drop a lane in every roller gap along the host's flow (host local X), the part sits aligned with the
    // host - its local X on the host X - i.e. the same yaw as the host, its through-axis (local +X) carrying along
    // the main line and its lanes (local Z) reaching across the bed. This matches the native part's layout (bank
    // along local X + identity basis); a lane dropped aligned with the roller needs no rotation to seat. Pick the
    // nearer of 0/180° to respect the drop's facing.
    yaw = nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI)
    // the adopted lane spacing (authored, rounded to whole host pitches) goes into `pitchParam` and the bed
    // width × fitWidthScale into `fitWidthParam`, clamped to the params' declared ranges.
    const overrides: Record<string, number | boolean | string> = {}
    if (lanes.pitchParam) overrides[lanes.pitchParam] = spacing
    if (track.fitWidthParam) {
      overrides[track.fitWidthParam] = clampToParamSpec(moving, track.fitWidthParam, hostView.width * (track.fitWidthScale ?? 1))
    }
    if (Object.keys(overrides).length > 0) paramOverrides = overrides
  } else {
    // Blade-parity anchor (a custom part declaring `track` without lanes, e.g. the SDK blade stop): the blade
    // rises in the gap between two rollers, so anchor its centreline at the nearest station midpoint (true to
    // the gaps even when an edge roller is nudged inward).
    anchorX = (usable[0]! + usable[1]!) / 2
    let bestGap = Infinity
    for (let i = 0; i + 1 < usable.length; i++) {
      const mid = (usable[i]! + usable[i + 1]!) / 2
      const d = Math.abs(a.x - mid)
      if (d < bestGap) {
        bestGap = d
        anchorX = mid
      }
    }
    yaw = nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI)
    // adopt the usable bed width (frame walls sit outside the bed - the blade fits between them); the custom
    // track part names its own width param (fitWidthParam, clamped to the param's declared range).
    const usableWidth = hostView.width - 2 * FRAME_WALL_THICKNESS - 0.01
    if (track.fitWidthParam) {
      paramOverrides = { [track.fitWidthParam]: clampToParamSpec(moving, track.fitWidthParam, usableWidth * (track.fitWidthScale ?? 1)) }
    }
  }
  const w = toWorldXZ(target, anchorX, 0)
  const move = Math.hypot(w.x - px, w.z - pz)
  if (move > SNAP_VISIBLE_THRESHOLD) return null
  return {
    pose: { position: [w.x, ty, w.z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: w.x, y: ty, z: w.z },
    ...(paramOverrides ? { paramOverrides } : {}),
  }
}
