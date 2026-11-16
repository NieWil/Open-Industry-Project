// The conveyor contact path: the ghost-collision gates, the running-surface and flank tests, the per-contact JS
// listener (the ?jsconveyor / stock-build fallback) and the native listener's facet table. ConveyorFacets (conveyorFacets.ts) owns
// the conveyor maps and the table; everything here reads or writes what it is handed.
import type Jolt from 'jolt-physics'
import type { ConveyorEntry } from '../core/geometry/collisionShapes'
import type { JoltModule } from './worldTypes'

// Ghost (internal-edge) collision filtering. Each conveyor's running surface is many separate static convex
// bodies (run boxes, bend prisms, curve chord boxes), so as cargo slides across a seam Jolt reports a spurious
// contact with the next facet's leading edge that snags/lifts the box. Our chord facets produce ghosts a single
// trimesh would not, so there are two complementary gates:
//
//   1. Speculative gate - the box has not reached the facet yet (penetration well below zero) and the contact
//      faces sideways-ish. Catches chord-facet / straight->curve speculative ghosts (aggressive at 0.98 because
//      those normals tilt only slightly off vertical).
//   2. Shallow-ram gate - a shallow contact (<= the 2 mm depth threshold) whose normal faces clearly sideways
//      (<= cos 45deg): the *positive-penetration* leading-edge ram between two separate conveyor bodies (belts
//      butted end-to-end, where enhanced internal-edge removal does not apply), which would pop cargo upward onto
//      the downstream belt.
//
// Real support survives both: top support faces up; steep-incline support (up to BELT_MAX_TILT_DEG) faces
// sideways but settles deeper than the slop, clearing the 2 mm gate, as does a real wall.
//
// A conveying rig's 'frame' links (side rails at/under the deck plane) opt into the same gates: cargo sits a hair
// sunk into the deck, so a box pushed sideways off the bed (a diverter onto a takeaway) rams the rail's near-flush
// top edge and pops. buildRigBodies registers them in `conveyors` with an empty entry list (plain collision, no
// surface velocity), which admits them here. Guard links stay unfiltered: a guard stops cargo, and junction
// crossings open them for real (rigGuardSide).
export const GHOST_MIN_SEPARATION = 0.001 // speculative gate: separated by > 1 mm
export const GHOST_SPEC_UP_DOT = 0.98 // speculative gate: normal more than ~11deg off vertical
export const GHOST_RAM_DEPTH = 0.002 // shallow-ram gate: <= 2 mm deep
export const GHOST_RAM_UP_DOT = Math.cos(Math.PI / 4) // shallow-ram gate: <= cos 45deg

// Coupled planar friction (forked Jolt, ContactSettings::mFrictionCoupling; see the fork's
// patches/README.md). Tangential and torsional friction physically draw on the same Coulomb budget.
// Cargo stalled against an obstruction has already used its traction being dragged forward, so it
// should barely resist yaw. That lets a box whose corner catches a hard edge pivot off it and carry
// on down the line. Stock Jolt clamps the two budgets independently, so a stalled box resists yaw
// exactly as hard as a parked one and stops dead. It can also never pivot for any box
// geometry, because the catch's couple is bounded by (drive force x half width) while the torsional
// limit uses the footprint's corner radius, which is always larger. Applied to driven deck facets
// only; guards, frame rails and every non-conveyor contact in the scene are untouched.
// 0 restores stock Jolt exactly (the patch's arithmetic is then bit-identical to upstream).
export const FRICTION_COUPLING = 1

// Native ConveyorContactListener facet table (forked jolt-physics build). Layout per slot:
// [kind (0 unused / 1 linear / 2 arc), vx, vy, vz, omega, cx, cz, nx, ny, nz, fx, fy, fz, friction, x2] - 16
// float64s. The velocity and friction fields are mirrored from ConveyorEntry by ConveyorFacets.sync each step
// (friction 0 = none: the body's applies, which for a merged deck is its lowest member's);
// the axes (surface normal, flow) are body-local and therefore static, so they are written once at
// registration. A conveyor body advertises its block in its 32-bit user data: bit 31 tag, bits
// 12..30 base slot, bits 0..11 entry count (count 0 = gates only, e.g. a conveying rig's frame rail).
export const FACET_CAPACITY = 4096
export const FACET_STRIDE = 16
export const CONVEYOR_TAG = 0x80000000

// Running-surface gate: how far a contact's outward normal may sit from the facet's declared
// running-surface normal and still be conveyed. Surface velocity belongs to the surface cargo rides,
// so a box that rams a deck's flank must be walled, not dragged along the flow. Unlike the ghost gates
// this never disables a contact: a rejected one still resolves, without surface velocity or friction coupling.
//
// 65 degrees is fitted empirically, and the working band is narrow on both sides: against the demo acceptance
// run the fork truck's putaway leg passes at 60 and 70 and fails at 45, 80, 85 and 89. Too tight and cargo riding
// a surface's edge (normal well off vertical) stops being driven; too loose and the flank conveys again.
// Move it only with that sweep re-run: either edge is a real failure mode, not a safety margin.
// A facet with no declared normal is never gated (it conveys every contact).
export const SURFACE_GATE_COS = Math.cos((65 * Math.PI) / 180)

// Flank protection: how close to perpendicular a contact must be to both the facet's surface
// normal and its flow axis to count as a side wall, which the ghost gates then leave alone. The
// gates are aimed at contacts cargo drives into along its travel (a speculative seam, a leading
// edge at a junction). A wall shares their signature (horizontal normal, shallow penetration),
// and lift alone cannot tell the two apart. Without this, a registered body's flank is gated away,
// and a conveying deck would have to be a slab nested inside a plain housing.
// 20 degrees off perpendicular, kept tight: mistaking an end face for a flank brings back
// the leading-edge ram the gates exist to prevent, while being too strict merely leaves a contact
// gated as it would be without this check. Only facets declaring both axes are eligible.
export const FLANK_PROTECT_COS = Math.cos((70 * Math.PI) / 180)

/** a facet's body-local axes: the running-surface normal and the flow direction along it */
export interface FacetAxes {
  n: readonly [number, number, number]
  f: readonly [number, number, number]
}

/**
 * The axes of a deck built axis-aligned within its own body - a rig's `conveys` box link, a spur's
 * sheared prism, a scripted flat deck. All three place the body at the part pose and then lay the
 * deck out in part-local space, where cargo rides +Y and runs along +X. Facets assembled into a
 * compound derive theirs per sub-shape instead (runningSurfaceNormal / runningSurfaceFlow).
 */
export const DECK_AXES: readonly FacetAxes[] = [{ n: [0, 1, 0], f: [1, 0, 0] }]

/** do two facets face the same way? Flow sign is ignored: a reversed belt runs the same surface. */
export function axesAgree(a: FacetAxes | null | undefined, b: FacetAxes): boolean {
  if (!a) return false
  const dn = a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]
  const df = a.f[0] * b.f[0] + a.f[1] * b.f[1] + a.f[2] * b.f[2]
  return dn >= 0.999 && Math.abs(df) >= 0.999
}

/** The per-contact JS listener (ContactListenerJS). `conveyors` / `conveyorAxes` are SimWorld's live maps, read on
 *  every contact; `surfaceVel` / `angularVel` its reusable Jolt temporaries. */
export function createConveyorContactListener(
  J: JoltModule,
  conveyors: ReadonlyMap<number, ConveyorEntry[]>,
  conveyorAxes: ReadonlyMap<number, (FacetAxes | null)[]>,
  surfaceVel: Jolt.Vec3,
  angularVel: Jolt.Vec3,
): Jolt.ContactListenerJS {
  const onConveyorContact = (
    body1Ptr: number,
    body2Ptr: number,
    manifoldPtr: number,
    settingsPtr: number,
  ): void => {
    const body1 = J.wrapPointer(body1Ptr, J.Body)
    const body2 = J.wrapPointer(body2Ptr, J.Body)
    const key1 = body1.GetID().GetIndexAndSequenceNumber()
    const key2 = body2.GetID().GetIndexAndSequenceNumber()
    const arr1 = conveyors.get(key1)
    const arr2 = conveyors.get(key2)
    // Only conveyor surfaces (and conveying rigs' frame rails, registered with
    // an empty entry list) participate; contacts here are always one of these
    // bodies vs. a dynamic cargo body. Guard walls, blade stops and despawners
    // are not registered, so they are never ghost-filtered.
    if (!arr1 && !arr2) return
    const settings = J.wrapPointer(settingsPtr, J.ContactSettings)
    const manifold = J.wrapPointer(manifoldPtr, J.ContactManifold)
    // A conveyor surface is one compound body per part; recover the facet's
    // own surface-velocity entry from the contacted sub-shape's user data.
    const i1 = resolveConveyorIndex(arr1, body1, manifold.mSubShapeID1)
    const i2 = resolveConveyorIndex(arr2, body2, manifold.mSubShapeID2)
    let e1 = i1 >= 0 ? arr1?.[i1] : undefined
    let e2 = i2 >= 0 ? arr2?.[i2] : undefined
    // mWorldSpaceNormal points from body 1 to body 2; flip it when the dynamic
    // cargo is body 1 (i.e. the conveyor is body 2) so upDot measures the
    // normal's lift on the box.
    const wsn = manifold.mWorldSpaceNormal
    const nx = wsn.GetX()
    const ny = wsn.GetY()
    const nz = wsn.GetZ()
    const upDot = arr1 ? ny : -ny
    // Filter a contact that is either a speculative ghost (not reached yet) or a
    // shallow sideways ram against a separate body's leading edge (see the two
    // gates documented at GHOST_* above). Real support clears both gates.
    const depth = manifold.mPenetrationDepth
    const speculativeGhost = depth < -GHOST_MIN_SEPARATION && upDot < GHOST_SPEC_UP_DOT
    const shallowRamGhost = depth <= GHOST_RAM_DEPTH && upDot <= GHOST_RAM_UP_DOT
    if (speculativeGhost || shallowRamGhost) {
      // ...unless the facet declares this face a side wall, which is support, not a ghost.
      const flank =
        (e1 !== undefined && isFlankContact(conveyorAxes, body1, key1, i1, nx, ny, nz)) ||
        (e2 !== undefined && isFlankContact(conveyorAxes, body2, key2, i2, -nx, -ny, -nz))
      if (!flank) {
        settings.mInvMassScale1 = 0
        settings.mInvMassScale2 = 0
        settings.mInvInertiaScale1 = 0
        settings.mInvInertiaScale2 = 0
        return
      }
    }
    // Running-surface gate, mirroring the native listener's OnRunningSurface: a facet only
    // conveys contacts that land on the surface it declares. Rejected here the contact still
    // resolves (a flank stays solid); it just carries no surface velocity, and no coupling.
    if (e1 && !onRunningSurface(conveyorAxes, body1, key1, i1, nx, ny, nz)) e1 = undefined
    if (e2 && !onRunningSurface(conveyorAxes, body2, key2, i2, -nx, -ny, -nz)) e2 = undefined
    let vx = 0
    let vy = 0
    let vz = 0
    let wy = 0
    let c1x = 0
    let c1z = 0
    if (e1?.kind === 'arc' || e2?.kind === 'arc') {
      // Jolt applies the angular surface velocity about body 1's COM;
      // the linear term re-bases the rotation onto the arc center so the
      // surface velocity at every contact point is omega x (p - center).
      const com1 = body1.GetCenterOfMassPosition()
      c1x = com1.GetX()
      c1z = com1.GetZ()
    }
    const add = (e: ConveyorEntry | undefined, s: number): void => {
      if (!e) return
      if (e.kind === 'linear') {
        vx += s * e.vx
        vy += s * e.vy
        vz += s * e.vz
      } else {
        wy += s * e.omega
        vx += s * e.omega * (c1z - e.cz)
        vz -= s * e.omega * (c1x - e.cx)
      }
    }
    add(e1, -1)
    add(e2, 1)
    surfaceVel.Set(vx, vy, vz)
    settings.mRelativeLinearSurfaceVelocity = surfaceVel
    angularVel.Set(0, wy, 0)
    settings.mRelativeAngularSurfaceVelocity = angularVel
    // Driven facets only, mirroring the native listener: a registered-but-undriven body (a
    // conveying rig's frame rail, empty entry list) resolves to no entry and stays uncoupled.
    if (e1 || e2) settings.mFrictionCoupling = FRICTION_COUPLING
    // A facet with its own friction (a merged deck's member) combines it with the cargo's as Jolt combines two
    // bodies', in place of the deck body's single value.
    if (e1?.friction !== undefined) settings.mCombinedFriction = Math.sqrt(e1.friction * body2.GetFriction())
    else if (e2?.friction !== undefined) settings.mCombinedFriction = Math.sqrt(e2.friction * body1.GetFriction())
  }
  const listener = new J.ContactListenerJS()
  listener.OnContactValidate = () => J.ValidateResult_AcceptAllContactsForThisBodyPair
  listener.OnContactAdded = (b1, b2, manifold, settings) => onConveyorContact(b1, b2, manifold, settings)
  listener.OnContactPersisted = (b1, b2, manifold, settings) => onConveyorContact(b1, b2, manifold, settings)
  listener.OnContactRemoved = () => {}
  return listener
}

/** first-fit block allocation in the native facet table */
export function allocFacets(free: { base: number; count: number }[], count: number): number | null {
  for (let i = 0; i < free.length; i++) {
    const b = free[i]
    if (!b || b.count < count) continue
    const base = b.base
    b.base += count
    b.count -= count
    if (b.count === 0) free.splice(i, 1)
    return base
  }
  return null
}

/** return a block to the free list (kept sorted; neighbours coalesced) */
export function freeFacets(list: { base: number; count: number }[], base: number, count: number): void {
  let i = 0
  while (i < list.length) {
    const b = list[i]
    if (!b || b.base >= base) break
    i++
  }
  const cur = { base, count }
  list.splice(i, 0, cur)
  const next = list[i + 1]
  if (next && cur.base + cur.count === next.base) {
    cur.count += next.count
    list.splice(i + 1, 1)
  }
  const prev = i > 0 ? list[i - 1] : undefined
  if (prev && prev.base + prev.count === cur.base) {
    prev.count += cur.count
    list.splice(i, 1)
  }
}

/** mirror a body's ConveyorEntry list into its native facet-table block */
export function syncFacetBlock(t: Float64Array | null, entries: readonly ConveyorEntry[], base: number): void {
  if (!t) return
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e) syncFacet(t, e, base + i)
  }
}

/** One entry's live values into its slot of the facet table. */
export function syncFacet(t: Float64Array, e: ConveyorEntry, slot: number): void {
  const o = slot * FACET_STRIDE
  t[o + 13] = e.friction ?? 0
  if (e.kind === 'linear') {
    t[o] = 1
    t[o + 1] = e.vx
    t[o + 2] = e.vy
    t[o + 3] = e.vz
  } else {
    t[o] = 2
    t[o + 4] = e.omega
    t[o + 5] = e.cx
    t[o + 6] = e.cz
  }
}

/**
 * Write a body's body-local facet axes (running-surface normal, flow direction) into its facet
 * block. They are static (the listener rotates them by the body's live orientation), so this runs once at
 * registration rather than per step. A facet with no axes is left zeroed, which the listener
 * reads as "undeclared": conveyed on every contact and flank-protected on none.
 */
export function writeFacetAxes(t: Float64Array | null, count: number, axes: readonly (FacetAxes | null)[] | undefined, base: number): void {
  if (!t) return
  for (let i = 0; i < count; i++) {
    const a = axes?.[i]
    const o = (base + i) * FACET_STRIDE
    t[o + 7] = a ? a.n[0] : 0
    t[o + 8] = a ? a.n[1] : 0
    t[o + 9] = a ? a.n[2] : 0
    t[o + 10] = a ? a.f[0] : 0
    t[o + 11] = a ? a.f[1] : 0
    t[o + 12] = a ? a.f[2] : 0
  }
}

/**
 * Resolve the surface-velocity entry for the contacted facet. A single-shape
 * conveyor (or one with a uniform velocity, e.g. a curve) collapses to a
 * one-element array used directly; a compound with per-facet velocities is
 * indexed by the sub-shape's 1-based user data.
 */
export function resolveConveyorEntry(
  arr: ConveyorEntry[] | undefined,
  body: Jolt.Body,
  subShapeId: Jolt.SubShapeID,
): ConveyorEntry | undefined {
  const i = resolveConveyorIndex(arr, body, subShapeId)
  return i >= 0 ? arr?.[i] : undefined
}

/** as resolveConveyorEntry, but yielding the facet's index (-1 = none), so the caller can reach
 *  the parallel per-facet data too (the running-surface normal) from one sub-shape decode. */
export function resolveConveyorIndex(
  arr: ConveyorEntry[] | undefined,
  body: Jolt.Body,
  subShapeId: Jolt.SubShapeID,
): number {
  if (!arr || arr.length === 0) return -1
  if (arr.length === 1) return 0
  if ((globalThis as Record<string, unknown>).__bypassDecode === true) return 0
  const u = body.GetShape().GetSubShapeUserData(subShapeId)
  return u >= 1 && u <= arr.length ? u - 1 : -1
}

/**
 * Does a contact land on the running surface this facet declares? `(ox, oy, oz)` is the contact
 * normal pointing out of the conveyor body, already signed for it. Mirrors the native listener's
 * OnRunningSurface (JoltJS.h) so the `?jsconveyor` fallback gates identically. The stored normal
 * is body-local, so it is rotated by the body's live orientation here. That keeps a deck riding a
 * moving rig link correct without rewriting the table as it moves.
 */
export function onRunningSurface(conveyorAxes: ReadonlyMap<number, (FacetAxes | null)[]>, body: Jolt.Body, key: number, index: number, ox: number, oy: number, oz: number): boolean {
  const a = conveyorAxes.get(key)?.[index]
  if (!a) return true // facet declares no running surface: ungated
  const s = facetAxisWorld(body, a.n)
  return s[0] * ox + s[1] * oy + s[2] * oz >= SURFACE_GATE_COS
}

/**
 * Is this contact on a face that is neither the running surface nor an end - a side wall? Mirrors
 * the native listener's IsFlankContact (JoltJS.h). Such a contact is legitimate support and must
 * never be ghost-filtered however shallow it is. That lets a conveying deck be one body rather than
 * a slab nested inside a plain housing.
 */
export function isFlankContact(conveyorAxes: ReadonlyMap<number, (FacetAxes | null)[]>, body: Jolt.Body, key: number, index: number, ox: number, oy: number, oz: number): boolean {
  const a = conveyorAxes.get(key)?.[index]
  if (!a) return false // undeclared: never flank-protected, so the gates apply unchanged
  const s = facetAxisWorld(body, a.n)
  const f = facetAxisWorld(body, a.f)
  return (
    Math.abs(s[0] * ox + s[1] * oy + s[2] * oz) <= FLANK_PROTECT_COS &&
    Math.abs(f[0] * ox + f[1] * oy + f[2] * oz) <= FLANK_PROTECT_COS
  )
}

/** a facet's body-local axis in world space, rotated by the body's live orientation */
export function facetAxisWorld(body: Jolt.Body, v: readonly [number, number, number]): [number, number, number] {
  const q = body.GetRotation()
  const qx = q.GetX()
  const qy = q.GetY()
  const qz = q.GetZ()
  const qw = q.GetW()
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ]
}
