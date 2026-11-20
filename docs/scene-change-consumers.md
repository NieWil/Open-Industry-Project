# Scene-change consumers: an edit costs what it touches

## Why

A stopped scene changes on every pointer-move of a drag, every step of an Inspector scrub and every step of a
collaborator's drag: the store hands the controller a new scene about 60 times a second, and the controller hands it
to the view (`syncScene`). Everything that reacts to an edit runs on that path. A reaction that re-derives from the
whole scene is correct but expensive: an edit's cost grows with the scene, not with what it changed. This model
makes each reaction declare what it reads, so the cost is scoped from the start.

For example, a robot's tool-size drag changes only the robot. A whole-scene reaction would still rebuild the cargo
frame twice per move (`unitDressings` is O(loads × rows)) and re-cast every sensor's beam against every box, none of
which read the robot.

## The model

**A delta per sync.** [`core/scene/sceneDelta.ts`](../src/core/scene/sceneDelta.ts): `syncScene` records every part it added,
removed or updated (a new object, or a changed neighbour-derived context), plus a part shown or hidden without an edit
of its own (a hidden parent), with the version before and after. The delta is `full` (fail open: everything changed)
on a load, on the first sync, and when the package registry moved since the last sync, because a package edit changes
parts under unchanged references. Positions are world-space even under a parent (soft parenting), so moving a group
rewrites every descendant: a part's pose changes only with its own object.

**Consumers that say what they read.** [`viewSceneConsumers.ts`](../src/render/viewport/viewSceneConsumers.ts):
each reaction the view runs after a sync is a `SceneConsumer` registered in `RenderView.createSceneConsumers`:

- `reads`: a predicate over parts, checked against each changed part's version before and after (a part that stops
  being read changed what was read). The consumer runs only when the delta touches it.
- `'self'` instead of a predicate, only for a consumer that memoizes on its own input at a cheap per-part compare, and
  only where no predicate can say what it reads. Say why at the registration.
- `audit()`: at idle, does the retained output equal a from-scratch derivation? A `reads` that misses a dependency
  then fails a gate instead of leaving stale pixels. The audits run inside
  `view.auditMergeCoherence()` as `sceneConsumer:<name>` checks, so every gate that already calls it covers them.

| Consumer | Reads | Audit |
|---|---|---|
| `idleCargoFrame` | `'self'`: `memoizeAuthoredCargoFrame` keys on the cargo and unit-load parts, every parent edge and the registry. Hiding a group changes which cargo it draws without touching a cargo part, which no part predicate could say | the kept frame equals `buildAuthoredCargoFrame` of the scene now |
| `sensorBeams` | parts whose package draws a beam (`drawsSensorBeam`). The cargo frame, the beams' other input, flags them itself when it is a new frame | re-probe every beam and diff `sensorBeamDebug()`: a beam that moves was stale |

## Adding one

Anything that reacts to a scene edit in the view goes in this list rather than straight into `syncScene` or
`onStoreChange`: declare `reads`, write the audit. A pure derivation of parts (a resolver, a frame) stays a
`memoizeByParticipants` / `memoizeLocalized` memo ([seam-resolvers.md](seam-resolvers.md)) and is called from a
consumer. Getting `reads` too narrow is the failure that matters, because it is silent: the cargo frame depends on the
parent edges of non-cargo parts (`unitMembers` walks descendants through them), which is easy to miss. Write the
audit first.

## Scoped elsewhere, with the same rule

These skip work an edit did not cause. They are listed so a change to them keeps doing so.

- The instance pool's dirty-scoped path (`tryUpdateParts`) rewrites only the changed parts' rows. It leaves a scoped
  poison, distinct from a drag's. No re-bake is guaranteed after it, so at idle `auditCoherence` checks each merged
  row against its source (`auditRows`) instead of failing on the sentinel. The row audit is what checks this path:
  a full pool rebuild would hide a wrong row, so the audit must not depend on one happening.
- `SimBoxes.apply` returns early for the frame it already holds, so a memoized idle frame is not repacked per edit.
- `flowArrowSignature` caches per part object and registry revision; `syncScene` asks it of every part on every sync.
- `refreshTickRegistries` bumps `probeRegistryRev`, which re-casts every beam, only when the set of probe callbacks
  changed, not on any part's structure bump (a robot's cup bank re-counting).
- The controller's idle-pose preview caches each part's `idleKey`, which carries the part's whole behavior source.

## The gate

[`e2e/verify-interaction-budget.mjs`](../e2e/verify-interaction-budget.mjs) streams three edits through
`store.setTransient`, one step per frame as a drag sends them (the robot's tool size, a conveyor's speed, a conveyor's
pose), at 1x, 2x, and 2x with twice the cargo. It asserts that the per-step cost does not grow with the scene, that a
stream of a beam-less part runs no beam probe pass, that streams write nothing, and that the consumers and the pool
audit clean afterwards. A whole-scene reaction, such as the cargo frame without its memo, fails the growth check
at every scale and runs a probe pass on every step.

## What is O(scene) per sync

These read the scene, not the delta: the `syncScene` entry loop itself (a reference compare per part),
`resolveScene`'s per-part classification and structure connections, and the controller's idle-pose loop over every
rig. Each is a cheap per-part step that stays well inside a frame on a large scene and passes the gate. Profile them
on a prod build under `setTransient` with `node e2e/probes/stream-edit-profile.mjs`.
