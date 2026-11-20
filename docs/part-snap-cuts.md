# Part snap cuts: what meeting a neighbour does to it

Pinned by
[structureGolden.test.ts](../src/editor/structureGolden.test.ts) (railing gaps, deck notches, lifts, and the cut rig
the sim and the walking pilot build from) and [snapGolden.test.ts](../src/editor/snapGolden.test.ts) (the seats).

## Why one model

Two parts that meet can change each other: a stair opens a platform's railing and notches its deck, a diverter opens a
conveyor's side guard. The words for this name the effect, not the part that has it. Words tied to one pairing
(a stair mount, a stair's foot) would let a custom part take part only if it were shaped like a stair or a diverter.
With effect words, a gate set into a railing, a ramp or a ladder onto a mezzanine, and a chute through a conveyor
guard are all declarations.

## The model

**A host has edges; a guest meets one; meeting it has declared effects; links react by declaration.**

- **Edges come from what the host already is.** A `deck` surface (`snap.surfaces`, with a `heightParam` for anything
  that climbs to it) has four edges, `posX`, `negX`, `posZ`, `negZ`. A conveyor bed has two guard edges, derived from
  its geometry.
- **A guest meets an edge through a connector it already declares.**
  - `snap.edgeMount` meets a deck edge. Facing `'along'` (the default) it lies on the rim, coplanar: a barrier, a gate.
    Facing `'into'` its `at` point (moved by `atParams`) sits on the edge and its `alongParam` width runs along it: a
    flight, a ramp, a ladder. With `fromFloor: { param }` it stands on the host's floor, and the host fits that param so
    the contact reaches the deck. The param must drive an axis-1 `atParams` entry. Its scale is the rise per unit, and
    the fit rounds to whole units.
  - `snap.mounts[i]` onto `conveyorGuard` meets a guard edge.
  - A conveyor's own ends meet guard edges implicitly (conveyor geometry, not vocabulary).
- **The guest declares the effects:**
  - `opens` (edgeMount or mount): cut the host's edge where the guest meets it, as wide as the guest.
  - `notch` (edgeMount `'into'`): where the guest's footprint (origin to `at`, `alongParam` wide) crosses the deck
    plane, cut the host's `notchable` box link (`RigLink.notchable` in [partPackage.ts](../src/core/parts/partPackage.ts),
    the cut in [structureCuts.ts](../src/core/structureCuts.ts)). A stairwell.
  - `lift` (edgeMount `'into'`): raise the whole guest so `at` sits flush on the deck top, absorbing the residual of a
    whole-unit `fromFloor` fit.
- **Links react by declaration:**
  - host link `onEdge: 'posX'`: this link runs on that edge, and an `opens` guest cuts it (boxes split into the kept
    spans, array posts in the gap drop out, framing posts appear at the gap edges).
  - guest link `anchor: 'floor'`: when `lift` raises the part, this link stretches back down to the floor.
  - guest link `dropWhenMounted: true`: while the mount holds (a `lift` guest meeting a deck edge), this link is left
    out, mesh and collider: the deck takes its place. The stairs' own top landing, which the deck replaces.

The shipped stairs declare `edgeMount` facing `'into'` with `fromFloor` on `numSteps` and all three effects
(`opens`, `notch`, `lift`). The full declaration is in [part-snap-stairs.md](part-snap-stairs.md#the-two-halves).

A gate in a platform railing is `edgeMount: { accepts: 'deck', alongParam: 'width', reach: 1, opens: true }`. A ramp is
the stairs' declaration with a length param in place of the step count, with one caveat. `fromFloor` fits its param in
whole units (rounded, at least 1; [snapEdges.ts](../src/core/snap/snapEdges.ts) `snapEdgeMountInto`). So a ramp gets a
continuous fit only by making its unit small (a fine `scale` on the axis-1 `atParams` entry), and `lift` absorbs the
residual. None of them needs a new word.

## Where it lives

| Piece | File |
|---|---|
| the words (`SnapEdgeMount`, `SnapParamOffset`, `SnapMount.opens`) | [partApi.ts](../src/core/parts/partApi.ts) |
| the link words (`onEdge`, `anchor`, `dropWhenMounted`), validation, the format 2 -> 3 upgrade | [partPackage.ts](../src/core/parts/partPackage.ts) (types), [partValidateRig.ts](../src/core/parts/partValidateRig.ts) (validation), [partUpgrade.ts](../src/core/parts/partUpgrade.ts) (upgrade) |
| the contact point, shared by the seat and the cut so they cannot disagree | [snapConnectors.ts](../src/core/snap/snapConnectors.ts) `edgeMountContact` |
| the seat (`'along'`: `snapEdgeMount`; `'into'`: `snapEdgeMountInto`) | [snapEdges.ts](../src/core/snap/snapEdges.ts) |
| which guests meet which edges, and the gaps, notches and lifts | [structureConnections.ts](../src/core/structureConnections.ts) |
| the cut rig render and sim both build from (`onEdge`, `anchor`, `dropWhenMounted`) | [structureCuts.ts](../src/core/structureCuts.ts) |
| a mount that opens a guard | [partGeometry.ts](../src/core/parts/partGeometry.ts) `isGuardPusher` / `guardPusherContacts` |

## Old documents

Saved scenes, project libraries and collab rooms embed their packages, so format 2 spellings keep arriving. The
format 2 -> 3 step in `PACKAGE_UPGRADES` rewrites them on load: `railing` -> `onEdge`, `stairFoot` -> `anchor:
'floor'`, a `stairMount` -> the `edgeMount` above with format 2's own defaults (rise 0.178, tread 0.28, frozen in the
step), and a face-out `conveyorGuard` mount gains `opens: true`, which is what format 2 read it as. The format 3 -> 4
step turns a box link's `role: 'deck'` into `notchable: true`. An author writing an old word is refused by name, with
the current spelling.

## Conveyor guard sides

A conveyor's guard link declares its side, `sideGuard: 'left' | 'right'` (or `sideRail` for a
below-deck rail) on `RigLink` in [partPackage.ts](../src/core/parts/partPackage.ts). `rigGuardSide` in
[guardOpenings.ts](../src/core/guards/guardOpenings.ts) reads it. Nothing is inferred from an offset.

## Limits

- **`chain` and `tile`** (barrier chaining, floor-marking tiling) are per-pairing words outside this model.
- **One rectangular deck per host.**
