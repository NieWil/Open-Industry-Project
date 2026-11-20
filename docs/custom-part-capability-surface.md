# Custom-part capability surface

What a custom part's `step(ctx)` may see and do, and why `ctx` is a curated surface instead of a scene
handle. How part code is *confined* is a separate question, answered in [part-sandbox.md](part-sandbox.md):
every part runs in the same SES sandbox, whoever wrote it. The simulation is a deterministic model of a real
material-handling system, and the rules below keep it one.

## Why the surface is curated

The browser and the Electron desktop app run the same V8 over the same TS SimCore, so nothing
*mechanically* forces the surface to stay thin. Two reasons keep it curated:

1. **Determinism.** A run must be reproducible, so its measurements can be trusted for virtual commissioning.
   A script calling `Date.now()` / `Math.random()`, doing I/O, or mutating arbitrary state mid-tick breaks that.
   `src/core/determinism.ts` enforces it with a load-time scan, and the `partScript.ts` shims make `Date`,
   `performance` and `Math.random` throwing globals. Time and randomness come only from `ctx.simTime` and
   `ctx.rng()`. This applies to every part, without exception.
2. **Confinement.** A collab room hands everyone its parts' code, so part code is untrusted input. `ctx` is
   the only thing it is handed, which makes `ctx` the interface the sandbox has to audit
   ([part-sandbox.md](part-sandbox.md) "What part code is handed, and what comes back"). **When the SDK gains
   a capability, review it against that list.**

Two things the surface does not promise:

- **API stability.** The capability surface may break across releases. There is no version negotiation or
  deprecation cycle in the API itself. Stored parts are carried forward by `upgradeStoredPackage`, not by keeping
  old API shapes alive. The capability shape is still preferred over reaching into the scene tree, because
  determinism and confinement need that boundary anyway, and it keeps internal refactors cheap.
- **Cross-engine portability.** There is one engine.

## The surface

Two method families, both deterministic. `src/core/parts/partApi.ts` is the reference (`PartContext` in
`packages/part-sdk/index.d.ts` is the copy parts are authored against). This section lists the shape.

### Query: read-only, no side effects

- `dt`, `simTime`, `params` (typed from the package schema, handed in as copies), `position`, `forward`,
  `heading()`, `rng()`, `readTag` / `readNumber`, edge reads `rising` / `falling`, `tagDriven(name)` (is the
  tag an attached program's output), `used()` (a pilot Use pulse), and the pure motion helpers (`approach`,
  `approachAngle`, `approachVec`, `angleDelta`, `clamp`, `steer`).
- **Discrete sensor reads**: `ctx.sense(beam)` (a photoeye or through-beam: nearest hit, distance and colour)
  and `ctx.zone(zone)` (an area sensor: cargo count in a volume). `zoneAge` is a zone's summed cargo age, and
  `marked(zone, key)` is how much of it carries a mark. There is also closed-loop device feedback:
  `ctx.measured.joints` (the applied joint position), a servo's own readouts on `ctx.servos.<name>`
  (`position`, `velocity`, `state`, `inPosition`), and `ctx.measured.grips` (gripper part-present). These are the
  **only** way a part observes cargo (see [Sensing must be discrete](#sensing-must-be-discrete)).
- `ctx.conveyorRunning(id)` reads whether the conveyor a `partRef` param names is running (the spawner
  interlock). It is a part-to-part reference, not cargo sensing, so the discrete-sensing rule does not apply.
  There is no general view of another part.

### Sensing must be discrete

There is no `ctx.queryNearby(radius)` that hands a part the *list* of nearby cargo with each item's
ground-truth `position` / `velocity` / `colour` / `id`, and none should be added.

- **Real sensing is discrete.** Real material-handling controls see photoeyes, proximity switches, area
  scanners and encoders, never a list of objects with true velocities. The controls read the *belt* speed
  (VFD or encoder) and **track** a box down the line by counting encoder pulses from a photoeye trigger
  (shift-register or tracking-window logic). The box's speed is the belt speed because it rides the belt.
- **The ST program must port.** The program written here must run on a real PLC. Logic written against
  ground-truth cargo positions cannot port, because real hardware has no such input.
- **The device and the program are already separate.** A custom part's `step()` models a **device**, and the
  ST program models the **control logic**. Sensing belongs to the device, and `sense`, `zone` and tags already
  cover photoeye, area-sensor and I/O. Velocity-aware sorting is done as on a real line: a photoeye part writes a
  tag, and the ST program tracks the box from belt speed and time.
- **Smart sensors are narrow devices.** A vision system that really outputs object pose or dimensions is a
  narrow part type, not a general primitive. Build it as a bounded device capability only when a concrete part
  needs it.

### Effect: writes, applied by the host in a fixed phase (never arbitrary mutation)

Available: `setSurfaceVelocity`, `setArcSurfaceVelocity`, `setSurfaceSpeed`, `writeTag` / `writeNumber`,
`joints` / `setJoint`, `servos` (commands to a servo axis the host profiles: src/core/motionAxis.ts),
`grips` / `setGrip`, `lamps` / `setEmissive`, `setSubPose` (move an authored link
within the part's own rig, bounded to the part), `spawn` / `despawn` (controlled cargo source and sink),
`mark` / `dress` / `join` (product state on the cargo in a zone), `drive` (a vehicle's forward/turn), and
the readouts `report` (a param's effective value) and `display` (a live label caption). A part spawns at most
8 cargo bodies per tick (`MAX_SPAWNS_PER_TICK` in `embeddedBehavior.ts`).

**Invariant:** effects are *collected* during `step()` and *applied* by the host in a fixed phase order, so
two parts can never race. No effect mutates another part's internals directly. It requests a controlled
operation instead. Values a part returns are read once and validated by the host (`embeddedBehavior.ts`).

## Non-goals

- **Scene-graph handles and lookups by path** (`getNode('../Sensor3')`). A path binds a part to internal scene
  structure, so a model refactor breaks every shared part. Mid-tick mutation through a handle makes results
  depend on evaluation order. A scene handle also leads to engine objects (Jolt, three.js, the store), which part
  code must never reach. A capability method is a contract, and a node handle is not.
- **Synchronous cross-part calls.** They break ordering and determinism. Parts exchange signals through tags.
- **Any non-deterministic capability.**
- **Ground-truth cargo queries** (enumerating object position, velocity or identity, such as `queryNearby`).
  See [Sensing must be discrete](#sensing-must-be-discrete).
- **Trust tiers.** One sandbox for every part's code. What a part may *call* does not depend on who wrote
  it. If a part needs more reach, that is a new curated capability for everyone.

Geometry is a separate facet on a ladder of tiers (params → manifest → a `geometry()` function), authored in
the same script as behavior. See [procedural-geometry.md](procedural-geometry.md).
