# Part snap stairs: seating a staircase onto a platform deck

The SDK stairs snap their top onto a platform deck, sizing the flight to the deck height. A staircase is an
[`edgeMount`](part-snap-edge-mount.md) facing **into** the deck. It seats along a deck edge like a barrier, but
it also (1) **resizes** the flight to reach the deck and (2) spans **floor→deck** (it resolves its own Y). The
general model of edges, guests and their effects is [part-snap-cuts.md](part-snap-cuts.md). This doc is the
stairs' use of it.

## The two halves

Like [surfaces](part-snap-surfaces.md) and [edge-mount](part-snap-edge-mount.md), this is a host ↔ mover pair:

- **Host** (the platform) advertises its deck as a {@link SnapSurface} of kind `'deck'`, carrying a
  **`heightParam`**: the deck's elevation above its own floor, which the stair reads to size the flight:
  ```js
  snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }] }
  ```
  `heightParam` is optional on a surface. A conveyor's `'conveyorGuard'` has no meaningful elevation and omits
  it. An `'along'` edge-mount ignores it (it sits coplanar), so one deck surface serves both facings.

- **Mover** (the staircase) declares where it seats
  ([examples/parts/stairs/rig.json](../examples/parts/stairs/rig.json), built by
  [examples/parts/stairs/part.js](../examples/parts/stairs/part.js)):
  ```js
  snap: {
    edgeMount: {
      accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into',
      at: [0, 0, 0],                                     // the top of the flight (the deck is its landing)
      atParams: [{ axis: 0, param: 'numSteps', scale: 0.28 }, { axis: 1, param: 'numSteps', scale: 0.178 }],
      fromFloor: { param: 'numSteps' },                  // fit the step count to the deck height
      opens: true, notch: true, lift: true,
    },
  }
  ```
  - **`accepts`**: the deck-surface kind it seeks (`'deck'`).
  - **`alongParam`**: the flight width. Half of it clamps the slide along the edge, so the flight can't overhang
    the deck corner. A flight wider than the edge has no valid slide range, so it centres on the edge and
    overhangs evenly rather than seating flush to one corner.
  - **`at` + `atParams`**: the contact point, in the part's frame: the flight's top, `numSteps · 0.28` along X
    (tread) and `numSteps · 0.178` up Y (rise).
  - **`fromFloor`**: the param the host **fits** so the contact reaches the deck: `numSteps` becomes
    `round(targetRise / rise)` (step 3 below). Applied with the pose as one undo entry (like the blade stop's
    width fit).
  - **`reach`**: engage distance (~3 m).
  - **`opens` / `notch` / `lift`**: what meeting the edge does to the platform and the flight (below).

A package declaring the format 2 `snap.stairMount` fails validation by name
([partValidate.ts](../src/core/parts/partValidate.ts)). A stored format 2 package is rewritten on load by
`upgradeCutsToFormat3`.

## How a match happens

`snapEdgeMountInto` (in [snapEdges.ts](../src/core/snap/snapEdges.ts)) works in the SDK stair's
**foot-origin, +X-up-slope** frame:

1. Read the target's `surfaces` entry whose `kind === accepts` and carries a `heightParam` → deck length/width
   and its elevation. No such surface → no snap.
2. `deckTop = target.y`, and `dHeight` is the deck's `heightParam` value. `floorY = deckTop − dHeight`.
   `targetRise = max(STAIRS_MIN_RISE, dHeight)`.
3. `steps = round(targetRise / rise)`, clamped to the mover's own `numSteps` range; `run = steps·tread`.
4. `nearestRectEdge` on the deck; `clampAlongEdge` by `width/2` (slide, bounded by the edge).
5. Pose so the flight's **top** (the contact `at`: `run` along X) is at the contact and its **foot** sits
   `run` outward from the edge. Local `+X` points into the deck (`−outward`), width runs along the edge, and
   origin Y = `floorY` (foot on the floor). The whole flight sits outside the deck, butting the edge, and the
   deck is its landing (below).
6. Gated by `reach` (horizontal) and a height-scaled tolerance `max(SNAP_HEIGHT_TOLERANCE, targetRise·0.5 +
   SNAP_STAIRS_HEIGHT_PADDING)`. Junction sits on the deck edge at the deck top.

## Top landing + deck connection

The SDK flight carries a **top landing** (a fixed-depth flat plate + a flat handrail continuation, `LANDING`
= 0.76 m, OSHA 1910.25(b)(4)'s 30 in minimum landing depth) for when it stands alone. Against a deck the deck is
the landing, as on a real mezzanine stair. The flight's top meets the edge and every landing link is
`dropWhenMounted`, so the connection leaves it out (render and colliders both). Seating the landing's far end
instead would cantilever a 5 mm plate 0.76 m off the deck on nothing, double the platform's gap-framing posts with
its own, and meet a 0.10 m toe board with a 0.25 m kick plate.

When the flight's top snaps against a deck, the geometry-derived **structure connection**
([structureConnections.ts](../src/core/structureConnections.ts) → [structureCuts.ts](../src/core/structureCuts.ts))
applies the declared effects:

- **Whole-flight lift** (`lift`): `applyStairLift` raises **every link** by `deckTop − steps·rise`
  (≤ half a step). The top plane (last tread) then sits **flush** with the deck, and the handrail runs
  **continuous** from the newel into the platform railing at exactly its heights (top 1.07 / mid 0.54 above the
  deck). Lifting only the top would leave the sloped rail arriving a residual below the flat one, a visible jog
  at the top post. A top-anchored flight that re-derived an exact per-step rise would have no jog, but
  the rig's constant-slope steel cannot express that. So the residual shows at the foot instead, where
  `anchor: 'floor'` links keep it seated. The newels + stringer foot plates stretch down by the lift, and a filler
  plate is minted under the first riser (floor → lift). The first step reads as one slightly taller riser,
  the least-visible place for the fixed-rise error.
- **Landing dropped**: `applyStairLift` leaves out the `dropWhenMounted` links whatever the lift: the landing
  plate, its rails, posts, kick plates and guard walls.
- **Railing opening + gap framing** (`opens`): the platform opens its perimeter railing over the stair width,
  keyed on the **flight top**, which butts the edge. The contact has to overlap the edge, not just its line.
  `applyPlatformCut` mints a **post at each gap edge** (each solid segment is rebuilt with end posts). So the
  platform rails end in a post, and the stair's sloped rails end in that same post. Their top ends are
  trimmed so the perpendicular cut stays inside it. The stringers end square at the deck edge: a level top cut
  and a plumb end over the platform's edge beam (the `stringerHead` boxes).
- **Deck notch** (`notch`): a rectangular hole where the stair's footprint (foot → flight top) overlaps the deck
  interior. The edge-flush snap leaves the flight entirely outside, so there is no hole. The notch cuts one
  when a stair is placed over the deck, so its stairwell isn't buried under solid deck.

### Known limits

- **Fixed rise per step.** The SDK flight's rise is a rig constant (0.178), so only the integer step *count* is
  tuned. The whole-flight lift absorbs the residual of up to **half a step** at the foot, as a slightly taller or
  shorter first riser bridged by the `anchor: 'floor'` extensions. The per-step rise is not re-derived.
- **Rectangular deck hole.** The rig deck is a box link, so the interior-overlap carve is an axis-aligned
  rectangle (the stair footprint's AABB). A convex hull would be exact, but the rectangle is enough for the box
  deck. The common edge-flush snap needs no hole at all.
- **Stairs seated by the landing are moved on load.** A document whose stair has the landing's far end at the
  deck edge holds that stair a landing's depth short of the edge, connected to nothing. Loading moves it in
  ([stairReseat.ts](../src/core/stairReseat.ts), listed among the load's repairs): a stair on the app's built-in
  that meets no deck edge but would one `STAIRS_LANDING_DEPTH` further along its +X. A project's own edited copy
  of the stairs keeps its seat, and so does its landing.
- **Top endpoint only.** Only the flight *top* opens a railing. A stair whose *foot* meets a lower deck (a run
  between two platforms) doesn't open that lower railing.

## Proof

[snapFeatures.test.ts](../src/core/snap/snapFeatures.test.ts) drops an SDK stair near a deck host advertising a
height and asserts: the top seats on the nearest edge with the foot `run` outward and on the deck's floor,
`+X` pointing into the deck, `numSteps` fitted to the deck, the slide clamps by half the width, a
shorter deck yields fewer steps, and the snap is inert against a deck advertising no height / a drop out of
reach. The cuts are pinned by [structureGolden.test.ts](../src/editor/structureGolden.test.ts).

## Non-goals

- **Exact-flush top** would need a run/rise-parametric flight. The SDK stair is fixed-slope by construction,
  so the lift absorbs the residual instead.
- **Bottom-endpoint connection and convex-hull deck holes** are not supported (see Known limits).
- **Multiple decks / non-rectangular decks.** The snap reads one rectangular deck from length/width params.
- **Barriers seated on a platform edge.** The platform's own railing does that job. See
  [part-snap-edge-mount.md](part-snap-edge-mount.md).
