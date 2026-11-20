# Part snap edges: declarative edge-to-edge tiling

A part tiles edge-to-edge with a neighbour through one declaration, covering two families: floor markings
(`cornerFlush: true`) and platform decks (`cornerFlush` omitted). Every part is a package on the public SDK
([architecture.md](architecture.md)), so a part snaps only through *declared* features.
[Mounts](part-authoring-guide.md) and [surfaces](part-snap-surfaces.md) cover the *device ↔ host* families;
this covers the first **structural** family.

## The behavior

Floor markings and platform decks tile with the **same algorithm**: the moving part's footprint rectangle
meets a target part's edge flush, orientation snapped to 90-degree steps of the target's yaw (the outward
anti-parallel step is chosen), sliding freely along the edge. Floor markings add one thing platforms don't:
**corner-flush** candidates, so a marking overhanging a smaller target can align a shared corner instead of only
centring on the edge. That single flag is the only difference between the two, so one kind covers both.

## The declaration

A part declares `snap.tile` (a stored package's format 3 `edges` is read as `tile`): a group tag, the two params that give its rectangle, and the corner-flush flag:

```js
// the manifest (rig.json): the part's connectors
snap: {
  tile: { group: 'floorMarking', lengthParam: 'length', widthParam: 'width', cornerFlush: true },
},
```

```js
// the behavior
definePart({
  params: {
    length: { type: 'number', default: 2, min: 0.2, max: 12, handle: { kind: 'face', axis: 'x' } },
    width:  { type: 'number', default: 1, min: 0.2, max: 12, handle: { kind: 'face', axis: 'z' } },
  },
})
```

- **`group`**: parts snap edge-to-edge only with **same-group** parts. A floor marking (`'floorMarking'`) never
  tiles onto a deck (`'deck'`). The engine compares group strings and never checks a part type, so a new group
  is a new string, with no engine change. The shipped parts use `'floorMarking'`
  (`oip.floor-marking`) and `'platformDeck'` (`oip.platform`).
- **`lengthParam` / `widthParam`**: the rectangle half-extents are `length/2` (local X) and `width/2` (local Z),
  read from the **instance** params (not baked bounds), so a resized marking matches. This matches how
  [surfaces](part-snap-surfaces.md) name their extent params.
- **`cornerFlush`**: opt into the shared-corner candidates (floor markings). Omit for a plain centre-slide
  edge (the platform-deck behaviour).

The part never sees its neighbour. The host reads both rectangles and resolves the pose, the same contract as
`SnapMount` / `SnapSurface` / `rest`: the part declares data, and the host resolves. Decks sit coplanar:
`y := target y`.

## How a match happens

A `tile` declaration compiles to a `rect` plug ([part-snap-connectors.md](part-snap-connectors.md)); the mates
table (`solvePlug` in [snapFeatures.ts](../src/core/snap/snapFeatures.ts)) solves it against the target's own
`tile` through `snapTile`, whose candidate loop (`flushOnEdges`) it shares with ambient `flush`:

1. Both parts must declare `tile` in the same `group`, else `null`.
2. Read half-extents from each part's named length/width params.
3. For every (target edge × moving edge) pair, pick the 90-degree-step yaw whose moving-outward is most
   anti-parallel to the target-outward; clamp the moving-edge centre onto the target edge (slide); if
   `cornerFlush`, also try the two shared-corner spots.
4. The lowest cost (`move + SNAP_ROTATION_COST_WEIGHT·Δrot`) is chosen, gated by the visible threshold and height
   tolerance.

**Broadphase sizing.** `snapTile` reads its rectangle from params, and the pre-filter (`xzDistToTargetBox`)
uses the part's footprint, which reflows from the instance's `face`-handle params (`reflowFaceDims` in
[partGeometry.ts](../src/core/parts/partGeometry.ts), via `effectiveResize`), so a resized tile passes the pre-filter at
its real size.

## Proof

[snapFeatures.test.ts](../src/core/snap/snapFeatures.test.ts) drives SDK markings (synthetic packages,
`customMarkingPkg`) and asserts pinned poses + junctions (to 9 decimals) across three scenarios
(edge slide, corner-flush overhang and 90-degree-step orientation), plus a group-isolation case (a `'deck'`-group
part is inert to a `'floorMarking'` mover).

## Platform decks: the second family

A platform deck is the marking algorithm **minus the corner spots**. The edge construction, the 90-degree-step
selection, and the cost and junction are identical, so it is the same kind with `cornerFlush` omitted and nothing
else added (deck-coplanarity, `y := target y`, is in `snapTile`). A custom deck (`group: 'platformDeck'`) is
pinned across an edge slide and a rotated-target 90-step.

The shipped `oip.platform` declares it (`group: 'platformDeck'`), so two decks of the **same height** tile.
Every test here uses synthetic packages, so `bundledPackageData.test.ts` carries the `SNAP_KIND_OWNER` ledger,
which fails the build when any snap kind loses its last shipped declarer, plus a live two-platform tiling spec.
A deck that keeps its host-side `surfaces` block but loses its mover-side `tile` block snaps to nothing while
every synthetic test stays green. Decks of different height refuse, on the height gate. That is the
stepping-mezzanine non-goal below.

The other platform-adjacent snaps are *different* kinds: **barrier → deck edge** and **stairs → deck edge** are
both `snap.edgeMount` (`snapEdgeMount` for the `'along'` facing, `snapEdgeMountInto` for `'into'`, in
[snapEdges.ts](../src/core/snap/snapEdges.ts)): see [part-snap-edge-mount.md](part-snap-edge-mount.md) and
[part-snap-stairs.md](part-snap-stairs.md).

## Non-goals

- **Height / stacking** beyond coplanar decks (a mezzanine stepping up). The snap has no Y rule for it.
- **Tail-origin rectangles.** The snap assumes centre-origin (like the shipped marking), so an off-centre
  footprint does not seat correctly.
