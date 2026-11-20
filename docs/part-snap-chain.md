# Part snap chain: declarative end-to-end chaining

A linear part (guard rail, fence, safety gate) chains end-to-end through a declaration, including the
corner-post handshake. Every part is a package on the public SDK ([architecture.md](architecture.md)), so a
part snaps only through what it declares. [Edges](part-snap-edges.md) covers the *rectangle-to-rectangle*
structural family. This doc covers the *linear* one, the barrier chaining `snapChain` implements.

## The behavior

A barrier is a **linear** part (extent along its local +X/forward, half = `length/2`). Dropped near a
same-family barrier it does one of two things:

- **Collinear extend**: when the facings are roughly parallel (`|forward·forward| ≥ 0.5`), it butts end-to-end
  off the nearer end, keeping its facing (aligned or flipped, whichever is closer).
- **L-corner**: when perpendicular, its nearer end meets the target's nearer end at 90°.

At an **L-corner the two parts share one post**, so the snap must draw it once. That takes a **two-part
handshake**. The mover omits the post on its mating end, and the *target* un-omits the post on its shared end. The host applies both as a single undo entry (`paramOverrides` + `targetParamOverrides`).

## The declaration

```js
// the manifest (rig.json): the part's connectors
snap: {
  chain: {
    group: 'guardRail',            // chains only with same-group parts
    lengthParam: 'length',         // extent along local +X, half = length/2
    reach: 3,                      // engage distance (a fence declares ~1)
    omitStartParam: 'omitPostStart', // boolean params the corner handshake toggles
    omitEndParam: 'omitPostEnd',
  },
},
```

```js
// the behavior
definePart({
  params: {
    length: { type: 'number', default: 2, min: 0.5, max: 12, handle: { kind: 'face', axis: 'x' } },
    omitPostStart: { type: 'boolean', default: false },
    omitPostEnd: { type: 'boolean', default: false },
  },
})
```

- **`group`**: the barrier family. Guard rails declare one group, a **fence and a safety gate share another**
  (they chain together), and the two never mix. A new group is a new string, with no engine change.
- **`lengthParam`**: the linear extent, read from the **instance** param so a resized barrier matches, consistent
  with [edges](part-snap-edges.md) / [surfaces](part-snap-surfaces.md).
- **`reach`**: engage distance in metres. The shipped barriers declare two values (a guard rail's loose ~3 m, a
  fence's tight ~1 m). A custom part names its own, so the tighter or looser feel is authored, not hardcoded.
- **`omitStartParam` / `omitEndParam`**: the boolean params for the two end posts. Omit both for a linear part
  with no shared-post concept (then the snap sets no overrides).

The part never sees its neighbour. The host reads both parts' `chain` blocks and resolves the pose and the
handshake, the same contract as the other snap kinds: the part declares data, and the host resolves.

## How a match happens

A `chain` declaration compiles to a `line` plug ([part-snap-connectors.md](part-snap-connectors.md)); the mates
table (`solvePlug` in [snapFeatures.ts](../src/core/snap/snapFeatures.ts)) solves it against the target's own
`chain` through `snapChain`:

1. Both parts must advertise `chain` in the same `group`, else `null`. Height gate: `|Δy| ≤ tolerance`.
2. `|forward·forward| ≥ 0.5` → **collinear**: butt off the nearer target end, `nearerYaw` picks aligned vs
   flipped, both omit params reset to `false` (a straight run has no shared corner).
3. else → **L-corner**: the nearer (moving end, target end) pair meets at 90°; the mover omits its mating post
   (`omitEnd` if its +X end mates, else `omitStart`), and the target un-omits the post on the end it shares.
4. Gated by the mover's `reach`.

## Who declares it

| part | `group` | `reach` |
|------|---------|---------|
| `oip.fence` | `barrierFence` | 1.0 (`SNAP_FENCE_VISIBLE_THRESHOLD`) |
| `oip.safety-gate` | `barrierFence` | 1.0 (a gate is a door **in** a fence line, so it shares the fence group) |
| `oip.guard-rail` | `guardRail` | 3.0 (`SNAP_VISIBLE_THRESHOLD`; never joins the fence family) |

All three name `length` / `omitPostStart` / `omitPostEnd`. **The declaration is the whole feature**: a barrier
without `snap.chain` snaps to nothing, and every chain test registers a *synthetic* package, so the shipped parts
are guarded separately (see Proof).

## Proof

[snapFeatures.test.ts](../src/core/snap/snapFeatures.test.ts) drives an SDK barrier through the pinned drops and
asserts pose, junction, **and** `paramOverrides` / `targetParamOverrides` across collinear extension and both
L-corner orientations, plus reach honouring (a fence-tight reach refuses a drop a guard-rail reach takes) and
cross-group isolation (a guard rail never chains to a fence).

Those all pass on synthetic packages, so two checks cover the **shipped** parts:
[bundledPackageData.test.ts](../src/editor/parts/bundledPackageData.test.ts) asserts the bundled fence / gate / rail
carry the block and then chains a real gate onto a real fence; [e2e/verify-barrier-chain-snap.mjs](../e2e/verify-barrier-chain-snap.mjs)
does the same against the registry the **running app** loaded.

## Non-goals

- **The barrier → deck-edge mount** (a rail landing along a platform edge) and the **guard-rail half-post outward
  nudge** are a *different* kind ([edge mount](part-snap-edge-mount.md), closer to
  [surfaces](part-snap-surfaces.md)), not this one.
- **Reach is a literal.** `reach` is a raw metre value on the declaration, not a shared tier. The shipped barriers'
  values match core constants (`SNAP_FENCE_VISIBLE_THRESHOLD`, `SNAP_VISIBLE_THRESHOLD`).
- **Tail-origin linear parts.** The snap assumes centre-origin ends at `±length/2`, matching the shipped barriers.
