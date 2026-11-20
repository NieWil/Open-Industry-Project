# Seam resolvers: host-computed cross-part geometry for portable parts

## The problem

A custom part authored on the Part SDK sees only **itself**: its params, its rig and its behavior `ctx`. That
keeps parts portable and deterministic, and it is why a behavior can't read ground truth about the world
([custom-part-capability-surface.md](custom-part-capability-surface.md#sensing-must-be-discrete)). But some
conveyor geometry is **cross-part**: it depends on the part's *neighbours*. So the host resolves it at scene-edit
time, not the part in isolation. Every case has the same shape:

| System | Host resolver | What it computes per instance |
|--------|---------------|-------------------------------|
| Roller pitch grid | [`core/conveyor/rollerGrid.ts`](../src/core/conveyor/rollerGrid.ts) `resolveRollerGrids` | `{anchor, nudgeLo, nudgeHi}`: roller phase and edge nudges from butted neighbours and curves |
| Belt guard openings | [`core/guards/guardOpenings.ts`](../src/core/guards/guardOpenings.ts) | rectangular side-guard cutouts where a neighbour snaps in (guards only; the frame never opens) |
| Rail/guard snap extents | [`core/guards/guardExtents.ts`](../src/core/guards/guardExtents.ts) | per-end rail and guard overrides onto the host's outer wall plane. A spur extends its rails out to the host it joins. A flush-butting straight or belt retracts its rails back to it (retraction only: a gapped mover never grows). Rig movers consume it directly (`rig.ts`/`rigBuild.ts` span remap). Function movers get it through the `guardExtents` param fold (`withSnapExtents`) |
| Belt deck-merge cluster | [`core/deckClusters.ts`](../src/core/deckClusters.ts) `computeDeckClusters` | the end-to-end butted-belt group whose decks merge into one physics body |
| Deck-edge structure cut | [`core/structureConnections.ts`](../src/core/structureConnections.ts) → [`core/structureCuts.ts`](../src/core/structureCuts.ts) | a platform's railing gap and deck notch, and a lifted guest's rise flush to the deck, wherever a part whose `edgeMount` declares `opens` / `notch` / `lift` meets a deck edge ([part-snap-cuts.md](part-snap-cuts.md)). The resolver rewrites the rig link list, which both the `world.ts` colliders and the `rig.ts` visual apply ([part-snap-stairs.md](part-snap-stairs.md)) |
| Per-leg footing | [`core/legRests.ts`](../src/core/legRests.ts) `computeSceneLegRests` | `[x0, x1, dy]` rows (part-local X) where the surface under a legged bed differs from its own floor plane: a platform deck crossing under it (feet stand on the deck), or the warehouse floor past the deck it stands on (overhanging feet reach the ground). Render only, because legs have no colliders. Function belts get it through the `legRests` param fold (`withLegRests`), rig beds directly in `rig.ts`'s leg-station layout. Straight beds only: a curved bed's legs get no footing rows |
| Butted guard runs | [`core/guards/guardRuns.ts`](../src/core/guards/guardRuns.ts) `computeGuardRuns` | merged side-guard span overrides for butted collinear guards. Sim only: the merge is a collision concern, and two butted guards already draw as one continuous wall |
| Sensor-beam guard holes | [`core/guards/guardHoles.ts`](../src/core/guards/guardHoles.ts) `computeSceneGuardHoles` | holes through a bed's side guards where a sensor beam crosses them. Render only: beams aren't physical, so the collider stays whole |

Every one is: **read all parts → compute a small per-instance struct → feed it to the
geometry evaluator.** The resolvers act on SDK parts through what the packages declare (a
`worldPhase` array, `sideGuard` links, an `edgeMount`, a `face`/`path` handle, a
`guardExtents` / `legRests` param), so no part type is special-cased
(see [architecture.md](architecture.md)).

Parts only *author* themselves, and the host owns cross-part truth. Behaviors have no "query my
neighbours" hook. A seam is a host-computed **input**.

## One carrier

All of them flow through one per-part bundle and one change signature,
[`core/scene/sceneResolve.ts`](../src/core/scene/sceneResolve.ts). `resolveScene(parts, consumer)` runs the resolvers that
`consumer` reads and folds each part's outputs into a `ResolvedContext`. Render (`viewSync.ts` →
`PartVisual.update`) and sim (`world.ts` → `buildPart`) each thread it as a single value, keyed by
`renderResolvedKey` / `simResolvedKey`. Each key selects only the fields that consumer rebuilds on. Adding another
effect means adding a field, a resolver and a key contribution. Threading each effect separately takes edits in
five files, and missing one ships a fully implemented effect wired to nothing.

**The `consumer` argument is a performance contract.** Render reads grid, openings, extents, structConn,
legRests and holes. Sim reads openings, extents, cluster, structConn and guardRun. Under *streamed* motion (a gizmo
drag, a collab peer's drag, an Inspector scrub) every frame is a change, so every resolver wired to a consumer runs
60 times a second. Running the other side's resolvers would spend most of render's frame on deck clusters and
guard runs it never reads, which slows a peer's drag on every other client. Pinned by
[`sceneResolve.test.ts`](../src/core/scene/sceneResolve.test.ts) (the contract) and
[`verify-collab-presence-cost.mjs`](../e2e/verify-collab-presence-cost.mjs) (an observing client's per-frame cost
while a peer drags).
If a consumer starts reading a new field, add it to that consumer's branch **and** its `*ResolvedKey`. Don't
widen the test.

## Keeping a drag cheap

**Per-target memo.** `memoizeByParticipants` is all-or-nothing: one participant changing identity re-runs the
resolver over the whole scene. That is fine for a discrete edit and too slow at 60 Hz. `guardOpenings`,
`guardExtents` and `guardHoles` use [`memoizeLocalized`](../src/core/memoParts.ts) instead. Each target caches the
inputs its result came from: its own ref plus the **refs of the influencers the broad phase handed it**. It
re-derives only when those differ. The key is the exact input set, not a spatial guess, so a dependency cannot be
missed: anything `derive` was allowed to read is in the key. Parts away from the mover keep their near-set refs
and skip `derive` entirely. `guardRuns` calls both openings and extents internally, so it gets faster too.

**Incremental broad phase.** `createFootprintIndex` ([`footprintGrid.ts`](../src/core/footprintGrid.ts)) keeps
the buckets between calls. `sync` re-buckets only parts whose ref changed, and bumps a **version on every cell it
touches**. A target that hasn't moved reaches the same cells. If none of those cells changed version, nothing
it can see moved either, so it is reused without gathering neighbours at all. Versions only increase, so a stamp
cannot collide back to a stale value. `footprintDisc` is memoized per part identity (parts are immutable
snapshots).

With both, a drag frame's resolve cost stays flat in scene size: it is the real `derive` work around what moved.
A peer's drag holds close to full frame rate at 480 parts.

**Classification memo.** `isTarget`/`isInfluencer` are not cheap: they build geometry views
(`bedOf`, `moverShapeOf`, `hostGeom`) to decide what a part is. They are pure in (part, registry), and
parts are immutable, so the answers are cached on identity and dropped wholesale when the registry changes. That
invalidation is required. A package can arrive *after* the first resolve (async load, author edit, a peer's
part syncing in) under unchanged refs, and a stale `false` would exclude the part forever. The seam resolvers'
own `derive` re-checks the package, which masks a stale `true`, so the test below drives the memo directly to
cover the direction with no second line of defence.

[`memoLocalized.test.ts`](../src/core/memoLocalized.test.ts) covers the per-target memo, the incremental broad
phase and the classification memo. It runs a 60-step randomized
mutation sequence (moves, rotations, resizes, adds, removes) whose incremental stream must equal a full
recompute at *every* step.

**What stays O(n).** The resolver is handed a freshly built array every call, so it must look at every element
to learn what changed: an identity scan of two WeakMap hits and a Map lookup per part. Going below that needs the
caller to pass a change set, which is a scene-graph question, not a resolver one.

**Still on the whole-scene memo:** `deckClusters`, which is also **O(n²)**, and `guardRuns`. Both are sim-only, so
they are off the render drag path, but they set the sim's scene-edit cost.

## The roller grid

### Why world phase

`array.distribute` spreads copies **evenly and centred across the part's own local span**
([`rigPose.ts`](../src/core/rig/rigPose.ts) `arrayInstanceDeltas`). Spacing is even *within* a part but arbitrary
*across* a seam: butt two beds and each places its rollers without regard to the other's, so the seam gap doubles or
crowds. Placing rollers in **world space**, where a roller sits wherever `(W · axis)` is a multiple of the pitch,
makes two collinear beds share grid lines with no snap-time communication (`rollerGrid.ts` `rollerStations`).

### `SeamContext` and `array.distribute.worldPhase`

`arrayInstanceDeltas(array, params, seam?)` takes an optional, deterministic, `core`-only input carrying the
part's **world placement** and the **host-resolved anchor** ([`rigPose.ts`](../src/core/rig/rigPose.ts)):

```ts
interface SeamContext {
  worldPos: Vec3       // part world position (m)
  worldRotY: number    // part world yaw (rad)
  anchor?: readonly [number, number, number] | null  // resolved grid anchor; null = world origin
}
```

The host threads it at both consumers, the sim body build ([`rigBuild.ts`](../src/sim/rigBuild.ts)
`buildRigBodies`) and the render reflow ([`sdkPart.ts`](../src/render/parts/sdkPart.ts)), from the
`PartInstance`'s own `position`/`rotationY`. So render and collision stay in lockstep.

`worldPhase` is an opt-in flag on `distribute`. When it is set and a `seam` is supplied, copies sit on the **world
pitch grid** instead of centred on the local span, and `maxSpacing` becomes the exact world pitch. That alone
makes every collinear straight-to-straight butt read continuous. The default path (no flag or no seam) is the
centred one, so other array-links (fence posts, rack shelves, belt legs) are unaffected.

### The neighbour-aware part: `resolveRollerGrids`

Curve-anchored phase, edge-nudge suppression at a collinear seam, and seam-roller ownership need to see
neighbours, so `resolveRollerGrids` produces the per-instance `anchor` and nudges:

- A rig with a `worldPhase` array-link is a straight roller node (`isWorldPhaseRollerBed` + `gridNode`), so its
  phase inherits a butted curve's anchor and propagates down a collinear chain.
- A curved roller bed is an **anchor source** (`isCurveAnchor`: a curved bed whose snap `endExt` is below the
  belt half-pulley is a roller curve; a curved *belt* has no rollers and is excluded). A butted straight phases
  its rollers onto the curve seam, and `worldPhaseDeltas` drops the copy the anchoring curve owns, so the seam
  doesn't double a roller.
- `worldPhase` is a straight bed's distribution only. The spur (`oip.spur-conveyor`) is a *belt* spur with no
  roller array, and a curve has angular rollers, not a linear pitch grid, so it only *anchors* neighbours.

Gated by [`rollerConveyorRigParity.test.ts`](../src/render/parts/rollerConveyorRigParity.test.ts) and
[`e2e/verify-roller-grid-seam.mjs`](../e2e/verify-roller-grid-seam.mjs): two beds with differently phased origins
render every roller on one pitch lattice.

### The grid reaches `geometry()`

A part's `geometry()` takes a third argument, `GeometryContext` (`{ deltas, pitch, butt }`), carrying the same
resolved grid plus whether each end abuts a collinear neighbour. `sdkPart.ts` forwards the whole resolved
`RollerGrid`, not just `grid.anchor`, because `nudgeLo`/`nudgeHi` answer whether there is anything at that end to
meet, which end-of-bed geometry needs. The skewed roller bed's transfer plate uses it to finish where a roller
would have at a butt. Why it needs placement, and the re-emit-key trap, are in
[sdk-geometry-flexibility.md](sdk-geometry-flexibility.md#geometrycontext-the-placement-seam-geometry-needs).
Gated by `verify-skew-transfer-seam.mjs`.

## Resolvers belong to the host

The resolvers `resolveScene` runs are a hardcoded list. Every part reacts to neighbours through what it declares
(`sideGuard`, `edgeMount`, roller-bed and structure declarations), but only the host's own resolvers compute
cross-part geometry. A package cannot declare a resolver of its own. Resolvers stay in `core` (no three/DOM/Jolt)
to preserve portability and determinism.

## Non-goals

- **Per-frame resolution.** Seams resolve on scene *edit*, not on the sim tick.
- **A behavior hook.** Behaviors stay unaware of neighbours. Only geometry consumes seams.
- **A local-transform hierarchy.** This is world-space resolution. Part positions are world-space even under a
  soft parent ([scene-composition.md](scene-composition.md#the-data-model)).
