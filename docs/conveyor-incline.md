# Conveyor incline (roller) + yaw-only gizmo

Incline is a declarative SDK capability of the roller-conveyor part. One `inclineParam` marker on the rig
geometry drives render, collision and legs from a single param. There is no type-keyed built-in branch for it
([part-gizmos.md](part-gizmos.md)).

**Authoring is Inspector-only.** Incline is typed as a bounded number, not dragged: a precise bounded angle is
easier to type than to drag, and it keeps the engine patch simple. There is no viewport head-lift handle, and
none should be added. The ruler tool reads incline/plan angles as an inspection aid
(viewOverlays.ts `updateRulerLabel`).

## The invariant

A conveyor's **authored transform stores only position + yaw**. Tilt is a part
parameter (`tiltDeg`), never transform `rotationX/Z`. That keeps:

- **structural snapping** working (guard/frame merge, openings are yaw-based),
- **belt-height resting** correct (the origin stays at belt height: a roller's origin is its bed centre, which is
  the incline pivot, below; a belt's is its tail, where its path starts),
- **surface-velocity carry** correct (the deck tilts internally, the part stays
  yaw-aligned).

A roller bed is rigid, so incline is **one whole-run angle**, not a belt-style
per-segment path. Flat-then-incline (a nose-over) is two roller conveyors snapped
together, which the junction-merge handles.

## Data model

- `tiltDeg` (degrees, optional; absent/0 = flat). Clamped to `±maxInclineDeg` (30° by default; `rigInclineRad` in core/conveyor/conveyorBeds.ts). Rollers shed
  product on a steep slope (no cross-roller grip), unlike belts, which hold product (`BELT_MAX_TILT_DEG` = 89°).
- **The marker.** The roller-conveyor rig geometry declares `inclineParam: 'tiltDeg'` (+ `maxInclineDeg: 30`),
  the incline analogue of the belt's `path` handle and the curve's `arc`. `rigInclineRad(geo, params)`
  ([core/conveyor/conveyorBeds.ts](../src/core/conveyor/conveyorBeds.ts)) resolves it to clamped radians. The part just adds a
  plain `tiltDeg` number param (Inspector-authored, no `ParamHandle`, since incline is never dragged).

**Pivot: the deck centre, not the tail.** The SDK roller is centre-origin (deck offset `[0,…]`), and the
transform model keeps the origin fixed, so incline pivots at the bed centre. The centre stays at belt
height, the head lifts by `(L/2)·sin` and the tail drops the same.

## Mechanism

**One seam carries it: `rigWorldPoses` `inclineRad`** ([core/rig/rigPose.ts](../src/core/rig/rigPose.ts)).
An opt-in outer rotation (like `scale`, default 0 = no-op) tilts every **non-leg** link's
world pose (position **and** quaternion) about the rig root, local +Z. Render and both sim collision paths
read this FK, so they tilt from one source and can't drift:
- **Render** ([render/parts/sdk/rig.ts](../src/render/parts/sdk/rig.ts)): each parentless, non-leg link
  group is re-posed each refresh with the same `Rz(θ)` about the root. Children follow their tilted parent via
  the scene graph. Legs are rewritten by the trestle pool at `x·cos` / height `+ x·sin` (vertical, regrown).
  `computeLegPlacements` compresses each station to `x·cos(tilt)` and grows it by `x·sin(tilt)`, so
  every foot stays on the floor under the raised deck.
- **Sim collision** ([sim/rigBuild.ts](../src/sim/rigBuild.ts)): `buildRigBodies` tilts the wall/guard kinematic
  bodies with no extra code, since they are built from the link quat. `attachRigConveyors` builds the deck as a
  tilted **static** body (`addStaticBoxQuat`) and tags its conveyor entry with `tan: { x: cos, y: sin }`. So
  `tickBehaviors` carries cargo up the grade at the commanded speed (the same mechanism as a per-segment belt).
  The part's `step()` needs **no** incline math.

The SDK render path is an FK group-tree, not a single group rotation.

**Tests.** `rigWorldPoses` incline unit test (`src/core/rig/rigPose.test.ts`).
[verify-incline-drop-surface.mjs](../e2e/verify-incline-drop-surface.mjs) checks that the editor's drop raycast hits
the tilted surface under the cursor.

The physics deck matches the render. In a one-off headless measurement, not a test, a box dropped on the head of a
20° roller of length 3 m at belt height 2 m came to rest at y ≈ 2.72, the tilted-surface prediction `2.0 + 1.5·sin
20° + boxHalf`, not on the floor or a flat deck.

**Footprint** ([partFootprint](../src/core/parts/partGeometry.ts)) grows its vertical extent by `hx·|sin θ|` both
ways (raised head + lowered tail), so the selection AABB and focus framing cover the tilted bed. The XZ plan
extent is `(L/2)·cos θ` (see "The footprint is the plan extent" below). Test in `partGizmos.test.ts`.

**Editor drop-raycast + vertex-snap proxy** ([collisionShapes.ts](../src/core/geometry/collisionShapes.ts) `footprintHull`).
For an inclined roller, the proxy that `surfaceAt`/`surfaceBelow`/vertex-snap raycast is not the rise-expanded
footprint AABB. That AABB would be a phantom flat top at head height across the whole bed. A box dropped or
Shift+G collision-repositioned over the tail would float up to head height and, cast down an angled camera ray,
end up displaced to the side. Instead `footprintHull` un-expands the AABB back to the flat deck slab and tilts
its corners by `Rz(θ)` about the local origin, the same tilt `rigWorldPoses` `inclineRad` applies to render and
sim. So drops rest on the real tilted deck. Test in `collisionProxyMesh.test.ts`.

**Legs vs. resize.** The slope-slide in `resizePart` moves the origin `(ΔL/2)·sin` vertically to hold the far
end fixed. The feet plane is `origin.y − standHeight`, so without a re-rest the trestle feet would float. Two
layers prevent it. (1) `resizePart` carries its own vertical shift into the `rest:'surfaceBelow'` param
analytically, so every caller (live preview included) keeps the feet planted with no raycast. (2) The
commit-time `reRestSurfaceParams` in `controller.endDrag` runs for **every** part-mutating drag kind, not just
translate. The rest invariant is enforced at the commit seam, not per gesture, because gating it per gesture
lets a drag kind skip it. Unit test in `partGizmos.test.ts`. e2e `verify-incline-resize-legs.mjs` drives the
real handle drags.

**Snapping across an inclined junction.** With a centre pivot, neither end stays at a fixed belt height, so an
inclined straight reports its ends where they are. `conveyorLocalEnds` puts them `(L/2)·cos` out in plan and
`(L/2)·sin` above / below the origin (the `y` a belt's inclined ends also carry). The end-mate seats a
neighbour at `targetEndY − e.y`, so a flat run snaps onto an incline's head or tail, an incline onto a flat
run, and a nose-over chain (flat, incline, flat) comes out at the right heights with nothing set by hand.
Related rules:
- **Nothing side-merges onto an inclined bed** (`straightFlanks` in [snapConveyor.ts](../src/core/snap/snapConveyor.ts)
  offers no flank on one). A side merge seats the mover flat at one height, and a sloping flank disagrees with
  it across the whole mouth. An inclined mover still side-merges onto a flat bed, its raised end seated on the bed.
- **The footprint is the plan extent** (`partFootprint`): `hx = (L/2)·cos`, matching the ends. At `L/2` it
  would overhang each end by `(L/2)(1 − cos)`, so a correctly butted neighbour would read as overlapping and
  snap in the distance-blind override tier. The drop-raycast proxy (`collisionShapes.ts` `footprintHull`) still
  builds the tilted slab from the bed's slope length, not the footprint's `hx`.
- **Guard-mounted devices seat on the slope** (`snapRails.ts` `straightGuardHost`). A sensor or diverter
  seats on the guard at the height it has at that point (`x·tan`, as a belt's path also gives), along a rail
  that ends where the bed does in plan. A pop-up diverter seated there still opens the guard (the opening's
  height check reads the same slope). **Track devices (blade stop, chain transfer) refuse an inclined bed**,
  because stopped product runs back down a roller incline and their stations assume a level bed.
- **A change of grade doesn't share one roller pitch** (`rollerGrid.ts`). Beds count as collinear only on the
  same slope, so the seam of a flat run and an incline keeps each bank's edge-roller inset.

**Riding across the joint.** The decks at a roller grade change stay separate bodies
meeting at an angle. A carton at 1 m/s crosses both joints cleanly up to 20 degrees. At the foot it slows while
pivoting onto the slope but is never kicked up or stopped. At the crest it tips over, lurches, sometimes bounces
a few mm, then settles at belt speed, as a real carton over a sharp crest does (belts avoid this with their
filleted nose-over). From about 25 degrees it slips back on the rollers, which is correct friction behaviour.
Numbers and gate: `src/sim/inclineJunctionRide.test.ts`.

The side-guard junction resolvers (guardOpenings.ts / guardExtents.ts) read the same ends, measure in plan and
divide by the slope on the way out, since an inclined rig's guard spans run along it. Pinned by
`src/core/inclineSnap.test.ts` and `src/core/guards/guardJunctionIncline.test.ts`.

## Not supported

- **Spur roller incline.** A spur is a horizontal junction element: its splayed end faces exist to merge or
  divert lanes in the plane. A junction that also changes elevation is an unlikely combination, and elevation
  changes belong on straight runs.
- **Curved roller incline.** A tilted arc is a helical sweep, a separate and much harder geometry/physics job.

## Yaw-only gizmo for conveyors

[`render/viewport/gizmo.ts`](../src/render/viewport/gizmo.ts) + `editor/controller/gizmo.ts`:
`GizmoState.rotateYawOnly` shows and picks the **Y ring only** for any conveyor selection. The X/Z/view rings
and the trackball are hidden and unpickable. A backstop in `controller.moveRotate` drops any non-vertical
rotation for conveyors (covering the keyboard X/Z constraint). The lone yaw ring draws as a **full circle**
(`uFull` uniform), since the half-ring look only helps when three rings overlap.

## Gizmo center = footprint centre, not the tail

The transform gizmo sits at a part's **footprint centre**, not its data origin. A
yaw rotation orbits that centre, so a conveyor reorients in place instead of
swinging its head about the tail. Belts keep a tail origin because multi-segment belt
path math relies on it: the centroid moves as segments are added or tilted, and the
tail doesn't. It's a storage detail the user never grabs.

`controller.partGizmoCenter(part)` shifts the gizmo by `partFootprint.cx`, the local
origin→centroid offset. It is set only for path (belt-like, tail-origin) conveyors and
spurs (the splay's shear). The SDK straight roller is centre-origin, as are curved and
turntable, and everything else is 0, so it is a no-op for every centred part.
It is used for both the gizmo display (`pushGizmo`) and the yaw pivot (the rotate drag's
`cx/cy/cz`). The yaw branch in `moveRotate` always orbits the position about the
pivot. For a centred single part the pivot is its own position, so nothing moves. For a
conveyor the tail-origin position swings about the bed centre. Translation is unaffected
(it moves the origin directly; the centre is derived and follows).
