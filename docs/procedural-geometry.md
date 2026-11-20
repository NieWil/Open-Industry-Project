# Procedural geometry: the part's second authoring facet

`geometry(g, p, ctx)` emits a part's shape, and most built-ins use it (the conveyor family, rack, platform,
stairs, fence, safety gate, blade stop, push button). Richer geometry lives in **both** the script and the
manifest, on one ladder of tiers. Built-ins are custom parts on the public SDK, and one three.js renderer
serves both shipping surfaces ([architecture.md](architecture.md)). For when a part should be drawn in code at all,
see [Code or model?](#code-or-model-when-a-part-uses-geometry-and-when-a-glb).

## A part has two facets, not one

A part is **geometry** + **behavior**. They are separate seams that share one script:

- **Behavior** = controls logic: the `step(ctx)` capability surface (tags, sense, joints, edges, slew).
  Described in [custom-part-capability-surface.md](custom-part-capability-surface.md).
- **Geometry** = the part's shape, described here.

Keep them apart even inside one file. The behavior `ctx` must **not** grow geometry methods, and a
geometry function must **not** read tags or sim state. The same rule keeps `ctx` small. One script,
**two scoped callbacks**:

```
definePart({
  params,
  geometry(g)  // author-time / on param change; deterministic; vertex-budget-capped; no tags
  step(ctx)    // every sim tick; no geometry
})
```

They share one script for correctness: geometry and behavior reference the *same* parameters and dimensions. The
belt's `width` drives the deck mesh **and** the conveying surface. The six-axis link offsets drive the rendered
mesh **and** the kinematics the behavior commands. Split across files or languages, they drift, and the visual
and the physics disagree.

## The authoring ladder

Start at the lowest tier that can express the part, and go up a tier only when it can't.

| Tier | Form | How authored | Covers |
|---|---|---|---|
| 0 | **params** | Inspector | reflow an existing topology (belt longer/wider) via paramgeo |
| 1 | **manifest links** | GUI + viewport gizmos, edits portable `rig.json` | box / cylinder / cone / frame / mesh / label / leg (a conveying deck is a box with `conveys: true`, and an older package's `deck` shape is upgraded to one on load; [manifest.d.ts](../packages/part-sdk/manifest.d.ts)) + `sizeParams` / `offsetParams` / `array` (distribute, count). The straight roller conveyor is built this way. The belt, curved and spur conveyors declare `geometry: { kind: 'drawn' }` and are Tier 2. |
| 2 | **geometry function** | code, in the same Monaco / eject-to-VS-Code flow as behavior | genuinely procedural shapes the manifest can't enumerate: swept/lofted/revolved profiles, the built-in belt's end-drum loop, runtime arc resize |

Tier 2 is for shapes that are truly procedural. Most built-ins use it to *dress* a Tier-1 rig (below). The
ladder mirrors the behavior ladder (declarative tags → `rising` → custom logic). **The manifest is the
declarative subset of the same description a Tier-2 function emits**: one underlying description format, two
ways to author it. Do **not** fork the model into "links vs function."

Because they are one model, Tiers 1 and 2 **compose**. A `MeshPart` a Tier-2 `geometry()` emits may
carry `link: '<rigLinkName>'`, attaching that procedural submesh to a Tier-1 rig link's group so it
follows the link's joint and rest pose (untagged means the rig root). Collision stays with the declarative link
(a `hidden` box is a collision-only barrier), so the tagged geometry is render-only dressing. The SDK
**Fence** and **Safety Gate** are the reference: a hidden collision box (a full-span barrier, or a
swinging leaf) dressed by a `geometry()` wire-mesh grid, with the leaf's mesh following its hinge joint.

## Code or model? (when a part uses `geometry()`, and when a GLB)

The rule lives in one place, the author-facing
[part-authoring-guide.md "Code or a model? Decide first"](part-authoring-guide.md#code-or-a-model-decide-first):
build engineered hardware in code, and keep a model only when its look is the asset (textures, detailed CAD-style
or organic shape, a vendor's model, scenery). It also lists the worked conversions and the two models kept
and why. Change the rule there, not here.

Two tempting arguments are **not** reasons either way:

- **Load time.** Part GLBs never gate the loading cover (only the building and dock bay do; see the budgets
  in [optimize-assets.mjs](../scripts/optimize-assets.mjs)), and together they are about 2 MB. Converting
  one saves bytes nobody waits on, and adds the CPU work of building it.
- **Draw cost, in the common case.** `geometry()` submeshes join the scene-global pool by geometry content,
  the same as a GLB's leaves ([rigProcedural.ts](../src/render/parts/sdk/rigProcedural.ts), "Pool opt-in, the function tier's
  rule"), so identical copies merge and an extra copy costs the same draws in code as from a GLB. The exceptions
  stay one draw per copy each: a `lamp` submesh, the belt fabric, and anything with `scroll` or `spin`.
  [verify-draw-budget.mjs](../e2e/verify-draw-budget.mjs) holds an extra copy to 3 draws, so count those before
  adding one.

## The core rule: emit a *description*, never host objects

A Tier-2 geometry function is code whose **output is data**: constructive ops that the host realizes. The ops on
the `GeometryBuilder` in [index.d.ts](../packages/part-sdk/index.d.ts) are `sweep` a profile along a path,
`fillet`, `arc`, `merge`, `box`, `bevelBox`, `lathe` (the revolve), `extrude`, `transform`, and `surface()` for raw
`vertex` / `triangle` / `quad` meshes. There is no boolean op. Constructive ops produce a buffer-shaped
`MeshDescription`, and a `geometry()` returns those (or `MeshPart`s that add a material and a rig link). The
function is handed a description *builder*, **never a `THREE` scene**. In the same way, behavior emits
*commands* on `ctx` rather than calling the engine.

### Why part code never touches the renderer

A part script never calls three.js directly. The reasons hold however many renderers there are, because this is
a boundary between core and render, not a portability concern. The same reasons keep gizmos declarative
([part-gizmos.md](part-gizmos.md)).

1. **Sandbox.** Shareable parts must not get a live handle into the renderer, scene graph, DOM or loaders.
   A description can only produce data. It can never touch the host.
2. **Determinism.** three.js is a stateful, GPU-bound renderer. Computing geometry stays pure JS in the
   deterministic core, and talking to the GPU stays downstream, so the simulation is reproducible.
3. **One definition for physics, collision, snapping and the editor.** Geometry as a description lives in
   `core/` (which bans `three`), so **one** definition feeds Jolt physics, the collider, drop-raycast,
   vertex-snap, the Inspector and gizmos, and serialization
   ([collisionShapes.ts](../src/core/geometry/collisionShapes.ts) is the single source of truth). A
   `THREE.BufferGeometry` feeds only the renderer, so the geometry would be kept twice and drift.
4. **Validation, caps, caching and editing.** A description can be capped in vertices and instances before it is
   realized, the same way the determinism guard and spawn caps bound behavior. A host that understands it can
   instance it and pick a level of detail, and a resize gizmo can drive it. An opaque draw call allows none of
   these.

The render adapter (`src/render/`) uses three.js directly, because that is its job. The ban applies only to a
portable, shareable part script.

## Descriptions are three.js-shaped data

There is one renderer on both surfaces, so the description is **not** an abstract cross-engine IR. It is a
**thin, three.js-shaped data schema**: `BufferGeometry`-style buffers, three.js coordinate and winding
conventions, three.js material params. The realizer is nearly a pass-through, and authoring feels close to
three.js.

The rule that stays: **three.js-shaped *data*, not live `THREE` objects.** Emit
`{ positions, indices, uvs, material: {...} }` (or constructive ops over those), and the host
instantiates the `BufferGeometry`. That keeps the sandbox, determinism, core visibility and editability, with a
cheap indirection. Don't add an abstract IR for a second renderer that doesn't exist.

Two more parts of the description:

- **Animated surfaces.** A `MeshPart` declares `scroll` (a scrolling surface, such as belt fabric) or `spin` (a
  turning roller), and the host animates it.
- **Guard merges.** A rig link declares `sideGuard: 'left' | 'right'` (package format 4), and `rigGuardSide` in
  [guardOpenings.ts](../src/core/guards/guardOpenings.ts) reads it for any part, so a custom part's guards join the host
  guard-merge system.

## The description is the canonical definition

A built-in is drawn *through* its geometry function. That description is the **canonical** definition of the
part, and there is no separate render path for it (the six-axis robot and the belt conveyor are examples). Each
host realizes the canonical description.

A description pins dimensions and function, which is what the parity tests check. It does not pin tessellation,
normals or filtering, so the realized mesh is not byte-identical to any hand-written three.js. Matching that
exactly would couple the part to three.js again. Don't ship a hand-written render path beside a built-in's
geometry function: it only adds a second definition to drift from the first.

## Non-goals

- **Raw `THREE` objects in a part script** (live handles). Three.js-shaped *data* only.
- **Geometry that reads sim or tag state.** The `geometry(g)` callback is param-driven and side-effect-free.
  Coupling between facets goes through shared params, not a back-channel.
- **An abstract cross-engine IR.** Unnecessary with a single renderer. Keep the description three.js-shaped.
- **Per-tick geometry rebuild.** Geometry re-runs on *param change*, not every sim tick.
