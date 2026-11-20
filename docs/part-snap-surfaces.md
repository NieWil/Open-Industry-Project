# Part snap surfaces: the host half of declarative snapping

A part advertises a surface that other parts mount onto: the **host** half of declarative snapping. The
**mover** half is `snap.mounts`, where a device declares *"I land my lens face on a surface of kind `conveyorGuard`."*
A host is found by the surfaces it declares, not by `part.type`, so a custom stand, bracket or machine frame
can offer a surface for a sensor to mount on, as a conveyor does. The sibling *gizmo* model is
[part-gizmos.md](part-gizmos.md).

## The contract: a part describes a surface, and the host resolves

Snapping follows the same core rule as geometry, behavior and gizmos: **declare a binding from a fixed set of
kinds, and never touch the host.** A mount is data the part declares (*where on me the contact sits, which
kind I seek*), and the host does all neighbour-aware matching. A **surface** is the mirror: a pure description
of *what this part offers*, in its own local frame:

```js
// the manifest (rig.json): the part's connectors
snap: {
  surfaces: [{ kind: 'conveyorGuard', lengthParam: 'length', widthParam: 'width' }],
},
```

```js
// the behavior
definePart({
  params: {
    length: { type: 'number', default: 2,   min: 0.5, max: 6, handle: { kind: 'face', axis: 'x' } },
    width:  { type: 'number', default: 0.8, min: 0.2, max: 2, handle: { kind: 'face', axis: 'z' } },
  },
})
```

The host reads that declaration, projects a mounting device's contact onto the surface, and resolves the pose.
The surface part never sees the device. This is the same host-resolves contract as `SnapMount` and `rest:
'surfaceBelow'`.

## How a match happens

`SnapMount.accepts` is a **live dispatch key**. When a device is dragged near a target,
`railSocketsOf(target, accepts)` in [snapRails.ts](../src/core/snap/snapRails.ts) lists every rail socket of
that kind the target offers, and the mount is solved against each. The best-ranked one is taken, by the rule of
[part-snap-connectors.md](part-snap-connectors.md):

1. If `accepts === 'conveyorGuard'`, a conveyor advertises it automatically (every conveyor is an SDK part).
   The rails are inferred from the bed by `straightGuardHost`, at **that bed's own origin convention**
   (`isTailOriginConveyor`, the same predicate the side-merge segments use). A belt-like bed is tail-origin
   (`x 0..length`). Every other straight conveyor, such as the SDK roller bed or a spur, is centre-origin
   (`x −length/2..+length/2`). Assuming the tail form here would shift the mountable band half a bed forward on
   a centre-origin host. The rear half of a roller bed would then refuse a device, and a bed's length of empty
   air past its discharge end would accept one.
2. Each of the target's `snap.surfaces` whose `kind === accepts` is a rail pair. Its `lengthParam`/`widthParam`
   give the rail extent (centre-origin `x −L/2..+L/2`, matching a custom part's centred footprint). Every
   matching surface counts, alongside a conveyor's implicit guards.
3. No match → no socket → **no snap**, even over a conveyor. A device seeking an unknown kind snaps to nothing,
   and a conveyor takes only a device whose `accepts` names a kind it offers.

The point-to-segment mount math (nearer-rail pick, contact projection, outward normal, facing gate,
`fitRangeParam` auto-fit) is shared verbatim between the conveyor and the declared-surface paths. The host
descriptor is a rail X-range `[x0, x1]` at `z = ±width/2` either way.

## The surface kinds (a closed set)

There are two surface **kinds**:

| kind | models | rails | shape |
|---|---|---|---|
| `conveyorGuard` | a mountable side rail (a sensor / diverter seat) | two, at `z = ±width/2` | flat, centre-origin along X |
| `deck` | a rectangular walking surface whose four edges are mount targets (declared by `oip.platform`, [examples/parts/platform/rig.json](../examples/parts/platform/rig.json)) | none: read as a rectangle, with an optional `heightParam` | flat, centre-origin; read by `snapEdgeMount` / `snapEdgeMountInto` ([part-snap-edge-mount.md](part-snap-edge-mount.md), [part-snap-cuts.md](part-snap-cuts.md)), not by `mounts` |

Adding a kind is an **engine change**, made only when a real part needs it. The author picks one of the fixed
kinds and never supplies a raw callback. When a part needs something the kinds can't express, add a kind to the
engine, as with gizmo handle kinds ([part-gizmos.md](part-gizmos.md#non-goals)).

## Where it lives in the stack

- **`SnapSurface`** + `SnapSpec.surfaces` on the SDK ([partApi.ts](../src/core/parts/partApi.ts)); declared in the
  part's manifest (`rig.json`'s `snap`) like `mounts`/`track`, and lifted into the public
  `@oip/part-sdk` `index.d.ts` by `npm run build-part-sdk`.
- **Validation** in [partValidate.ts](../src/core/parts/partValidate.ts) (`validateSnap`), mirroring the `mounts`
  checks: `kind`/`lengthParam`/`widthParam` must be non-empty strings.
- **Dispatch** in [snapFeatures.ts](../src/core/snap/snapFeatures.ts) (`solvePlug`) and [snapRails.ts](../src/core/snap/snapRails.ts): `railSocketsOf(target, accepts)` resolves
  the rail sockets (`railPair`, for a conveyor's guards or a surface), and
  `seatOnRail` seats the mount on the one an approach picks.
- **Proof** in [snapFeatures.test.ts](../src/core/snap/snapFeatures.test.ts): an unmodified SDK sensor mounts on a
  non-conveyor rail purely via `accepts` matching, and an unknown `accepts` snaps to nothing.

## Non-goals

- **Inclined / non-flat surfaces** (`beltPath`): rails are flat, and the declaration has no height sampler
  for a ramped mount surface.
- **Explicit-segment surfaces**: surfaces reuse the conveyor's parallel-rail-pair model. Arbitrary mountable
  geometry needs an explicit segment list or a different kind. (The top-face case is the `deck` kind.)
- **`track` surfaces** (the roller-grid seat): the harder twin. It is coupled to `rollerStations` and
  neighbour-aware grid resolution, so a "roller-grid" surface kind is more than length + width.
- **Reverse initiation**: dragging the *host* toward a device does not snap (only device → host), as with
  conveyors. The mover initiates, and a surface-only part is a passive target.
- **A narrower kind name**: `conveyorGuard` means *"a mountable side rail at `z = ±w/2` along a bed"*, on any
  part, not only a conveyor. Reusing it lets the existing sensor mount on any such rail. `sideRail` is a
  different word: the rig-link field for a below-deck rail ([partPackage.ts](../src/core/parts/partPackage.ts)
  `RigLink.sideRail`).
