# Part snap connectors: one model under every snap kind

Every snap kind compiles to connectors. The per-kind docs ([surfaces](part-snap-surfaces.md),
[edges](part-snap-edges.md), [chain](part-snap-chain.md), [edge mount](part-snap-edge-mount.md),
[stairs](part-snap-stairs.md)) describe what each kind does. This doc describes what they all have in common, and
how to change any of them safely.

## The model

A part's `snap` block is a set of declarations in a closed vocabulary. The engine
([snapFeatures.ts](../src/core/snap/snapFeatures.ts)) never reads those kinds directly. It reads
**connectors** ([snapConnectors.ts](../src/core/snap/snapConnectors.ts)):

- A **plug** is a feature of the part being dragged. It seeks a socket of a kind, or, for a peer plug, a
  same-group plug on the other part. `plugsOf(snap)` compiles a declaration into plugs once and caches them.
- A **socket** is a feature of the host a plug seats on. Most are implicit, so they are resolved from the host
  at solve time: every part's footprint faces, every conveyor's guard rails, ends and roller bed. The rest
  are declared: `surfaces`, and the peer `tile` / `chain`.
- The **mates table** (`solvePlug`) says, for each plug shape, which sockets it seeks and which solver seats it.

| Declaration | Plug shape | Sockets it seeks | Solver |
|---|---|---|---|
| `mounts[i]`, accepts `'face'` | mount | every part's footprint faces | `snapFaceMount` |
| `mounts[i]`, any other kind | mount | a conveyor's guard pair, `surfaces` of that kind | `seatOnRail` |
| `track` | track | a roller bed's rendered roller grid | `snapTrack` |
| `tile` | rect (peer) | the target's `tile`, same group | `snapTile` via `flushOnEdges` |
| `flush` | footprint | every part's footprint faces | `snapFaceFlush` via `flushOnEdges` |
| `chain` | line (peer) | the target's `chain`, same group | `snapChain` |
| `edgeMount` | edge seat | `surfaces` of the accepted kind (all four edges); facing `'into'` + `fromFloor` also needs a `heightParam` | `snapEdgeMount` / `snapEdgeMountInto` |
| (a conveyor's ends, implicit) | - | another conveyor's ends | the conveyor engine (`snapConveyor`) |

Conveyor to conveyor stays a special-purpose engine (side merges, curve pairing, spur splay, flow reversal; see
"Conveyor to conveyor" below). It is the one pairing the connector primitives do not express, so it stays
separate.

The declared kinds are also more than mating syntax, so they are the public vocabulary rather than raw
connectors. Other readers use the declarations:

- a `conveyorGuard` mount that `opens` cuts the conveyor's guard (`isGuardPusher`);
- an `edgeMount` that `opens` / `notch`es / `lift`s fuses railings, holes the deck and raises the flight
  (`structureConnections.ts`, [part-snap-cuts.md](part-snap-cuts.md));
- `checkLayout` reports a part that declares a seat (`mounts`, `track`, `edgeMount`) but has none.

## One ranking rule

Every (plug, socket) pair the dragged part has against a target is solved, and one rule picks the best
candidate. A body-overlap snap outranks a non-overlap one, then the lower cost is taken. Exact ties keep the
earlier pair (the conveyor engine first, then `plugsOf` order). `findSnap` uses the same rule between
targets.

So a part declaring several kinds gets the cheapest candidate, not the first kind in a fixed order.
`snapConnectors.test.ts` pins this on a barrier that both chains and seats on a deck edge. No shipped part
declares more than one mover-side kind.

A mount sees every rail socket of its kind on a host, including a declared `surfaces` entry next to a
conveyor's implicit guards. A `stairMount` skips a matching surface that has no `heightParam` and tries the
next one.

## Refused kinds: ports and rails

`snap.ports` and `snap.rails` are not snap kinds. An authored manifest that declares either is refused by name
(`validateSnap`). A stored package (scene, project library, room) that holds them loses them on load, with a repair
line (`dropRetiredSnapKinds`, run by `upgradeStoredPackage`). A device seats on a host with `mounts`, and a host
offers a mount line with `surfaces`.

Every snap kind has an entry in `SNAP_KIND_OWNER` (bundledPackageData.test.ts): the shipped part that declares it,
or a deliberate SDK-only mark with its reason. A kind that only synthetic specimens would use has no place there.

## Conveyor to conveyor

The conveyor engine (`snapConveyor` in `src/core/snap/snapConveyor.ts`) follows the same idea inside itself. It
solves every join the mover could make: each of its ends onto each end of the target and, on a straight
target, onto each flank (a side merge). The cheapest one that engages is taken. There is no up-front "end or
side?" decision. Choosing a mode first, from the mover's origin and body axis, would send a spur held at a
merge angle to the target's far end, since its angled face merges with its body 60° off the host. It would
also leave dead zones where the chosen mode failed and the other was never tried.

- **Engage.** A join engages when the mover's mating end moves at most 0.3 m to reach it
  (`SNAP_CONVEYOR_VISIBLE_THRESHOLD`). It is measured at that end, never at the mover's origin or its nearest
  end. A conveyor dropped on top of another has an end at each of the target's ends, yet mating either one
  means moving the whole body its own length. A body-overlap gate would let that through, as jumps of
  several metres.
- **Pushed out, not carried.** An end that starts inside the target's footprint may also move as far as it is
  deep, measured to the nearest edge, as long as the join turns the mover at most 45°. It is pushed out through
  the nearest edge (a spur dropped onto a bed pops out to the flank), never carried along the bed to an end,
  and never swung round. A curved target has no depth: its footprint is the arc's bounds, mostly empty.
- **Turn limits.** An end join turns the mover at most a quarter turn. Past that, the mover's other end is the
  one facing the join. A flank join takes a face already within 45° of square to it, so a conveyor laid parallel
  beside another is never swung into a T. The test reads the mating face, so a spur's angled face counts as square
  when it is. A curve fixes its flow with its `reverse` flag, never by turning.
- **Where it seats.** A flank join puts the mating end straight across from where it is, and an end a little
  past the run goes to the corner. Cost = the mating end's move + `SNAP_CONVEYOR_TURN_COST` per radian turned.
- **Which join.** Each candidate names its join (`join`: `back -> end:front`, `front -> flank:left`), which is
  how the editor tells "sliding along the same join" from "switched to another".

**The live preview holds the join it shows** (`src/editor/controller/liveSnap.ts`). On each pointer-move the
controller re-solves the held join with `opts.hold`, which keeps a conveyor join engaged out to 0.6 m
(`SNAP_CONVEYOR_RELEASE`). It only switches to another join, on the same conveyor or another part, when that
one is clearly cheaper (`SNAP_SWITCH_MARGIN`, `SNAP_SWITCH_MIN_GAIN`) and the last switch is 140 ms old. Snapping
reads the conveyor's position and the rotation it had when picked up, never the direction it is moving. The
end of a drag is small corrections, and there the direction is noise. Gated in a real browser by
`e2e/verify-conveyor-flank-slide.mjs`.

## Changing the engine: the golden table

`src/editor/snapGolden.test.ts` pins what `findSnap` answers for the real shipped catalog, not synthetic
packages. This catches a real part losing its declaration while the engine still passes its own tests. The
spec runs in about 5 seconds and has three parts:

1. **Pairwise:** every part, plus variants that reach branches the defaults don't (an inclined bed, a
   reversed curve, an even-lane transfer, a tall deck, ...), is dragged to about 180 probe poses around every
   part as host. The host sits off-axis. The committed form (`__snapshots__/snapGolden.pairwise.txt`) is
   each pair's snapped-probe count plus a hash of its exact results. The full table is 40k lines, and
   `SNAP_GOLDEN_DETAIL=<file>` writes it out.
2. **Demo scene:** every snapping part of the shipped demo is nudged off its authored pose and re-snapped
   against all 205 parts (`__snapshots__/snapGolden.demo.txt`, in full).
3. The face-snap toggle off: an ambient `flush` part snaps to nothing.

Synthetic `golden.*` specimens cover the paths no shipped part owns (`edgeMount` along a rim, a declared
surface host, a two-mount device).

**The rule:** an engine refactor must leave both files unchanged. If a change is deliberate, regenerate with
`npx vitest run src/editor/snapGolden.test.ts -u`, and in the same commit say which pairs moved and why. A
failure names the pairs that moved and prints their current lines. It catches a dropped declaration, a 10 cm
change to a declaration's reach, and a 1 mm change inside the engine.

## Adding to the model

- **A new declaration of an existing shape** (another `surfaces` kind a mount accepts) needs no engine
  change. Declare it.
- **A new pairing** of existing shapes is a case in `solvePlug` plus a solver.
- **A new shape** is a `Plug` member in `snapConnectors.ts`, a socket resolver and a solver in
  its own `snap*.ts` module beside `snapFeatures.ts`, validation in `partValidate.ts` (`validateSnap`, plus `SNAP_PARAM_REFS` if it names
  params), an owner entry in `SNAP_KIND_OWNER` (bundledPackageData.test.ts, a compile error until you add
  one), a golden specimen, and this doc.
