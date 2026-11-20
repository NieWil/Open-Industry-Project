# Part snap edge mount: seating along a host deck edge

A part seats on a **deck edge** through a declaration. Every part is a package on the public SDK
([architecture.md](architecture.md)), so a part snaps only through what it declares. `edgeMount` has two facings.
`'along'` (the default) lies on the rim, coplanar, like a barrier or a gate. `'into'` climbs into the deck from the
floor, like a flight, a ramp or a ladder ([part-snap-stairs.md](part-snap-stairs.md)). This doc covers `'along'`.
What meeting an edge does to the host is in [part-snap-cuts.md](part-snap-cuts.md). The other docs in the
structural family are [chain](part-snap-chain.md) (barrier ↔ barrier) and [edges](part-snap-edges.md) (deck ↔ deck).

## The two halves

Like [surfaces](part-snap-surfaces.md), this is a host ↔ mover pair:

- **Host** (the platform) advertises its deck as a {@link SnapSurface}: a rectangle whose four edges are mount
  targets:
  ```js
  snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width' }] }
  ```
  This reuses `surfaces`, the surfaces other parts mount onto. The `kind` string tells the consumer how to read
  it. A device's `mounts.accepts: 'conveyorGuard'` reads a surface as a *rail pair*, and an
  `edgeMount.accepts: 'deck'` reads one as a *rectangle*. The kinds differ, so neither reads the other's surface.

- **Mover** declares where it seats:
  ```js
  snap: { edgeMount: { accepts: 'deck', alongParam: 'length', reach: 3, outwardOffset: 0.05 } }
  ```
  - **`accepts`**: the deck-surface kind it seeks.
  - **`alongParam`**: the param whose extent runs along the edge. The seat slides along and clamps within the
    edge by `alongParam/2`. A mover wider than the edge has no valid slide range, so it centres on the edge
    and overhangs evenly rather than pinning its centre on the far corner.
  - **`reach`**: engage distance (a guard rail's loose ~3 m, a fence's tight ~1 m).
  - **`outwardOffset`**: push the origin out from the edge (a guard rail's half-post standoff). A fence omits it
    and seats flush.

A barrier can declare **both** `chain` (to other barriers) and `edgeMount` (onto decks). The dispatch tries
each and takes whichever the *target* matches. A chain sees no `chain` block on a platform, and an edge-mount
sees no deck surface on a barrier, so exactly one fires. A guard rail declaring both seats on a deck rim and
still chains rail to rail.

**No shipped part declares the `'along'` facing.** The platform's own railing does a seated guard rail's job.
It is parametric, reflows when the deck is resized, and takes per-side openings (`structureCuts.ts`). A
hand-seated guard rail would duplicate it and conflict with it whenever `showRailings` is on. The facing is a
general capability for a custom part seating along any declared rectangular surface edge. `SNAP_KIND_OWNER`
(`src/editor/parts/bundledPackageData.test.ts`) records `oip.stairs` as `edgeMount`'s shipped declarer, through the
`'into'` facing.

## How a match happens

`snapEdgeMount` (in [snapEdges.ts](../src/core/snap/snapEdges.ts)):

1. Read the target's `surfaces` entry whose `kind === accepts` → the deck rectangle (its length/width params).
2. Height gate `|Δy| ≤ tolerance`, decks coplanar.
3. `nearestRectEdge` on the deck; `clampAlongEdge` by the mover's `alongParam/2` (slide, bounded by the edge).
4. Pose at the contact, `+X` along the edge / `+Z` outward, pushed out by `outwardOffset`.
5. Gated by `reach`. Junction stays on the edge contact (not the offset origin).

## Proof

[snapFeatures.test.ts](../src/core/snap/snapFeatures.test.ts) (`customEdgeMountPkg`, `customDeckHostPkg`) drives
synthetic custom barriers onto a synthetic custom deck host and asserts pinned poses: a guard-rail-style mount
nudged out the half-post, a fence-style mount seated flush and sliding along the edge, a mover wider than the
edge centred on it, and an edge-mount inert against a host advertising no matching deck kind.

## Non-goals

- **Multiple decks / non-rectangular decks.** The snap reads one rectangular deck from length/width params.
- **Self-describing surfaces.** `surfaces` kinds (`'conveyorGuard'`, `'deck'`) share one namespace across
  consumers, and the consuming matcher determines geometry. A surface does not describe its own shape.
