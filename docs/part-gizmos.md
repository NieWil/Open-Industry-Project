# Part gizmos: the part's third authoring facet

A param declares a `handle`, and the host renders the dot, runs the drag, and writes the param back. The handle
kinds are `face`, `path`, `arc`, `flexPath` and `rigSize` ([partGizmos.test.ts](../src/core/parts/partGizmos.test.ts)).
Built-ins are custom parts on the public SDK ([architecture.md](architecture.md)). So viewport editing affordances,
such as the resize dots and the belt's tail and segment handles, are declared by the part author like everything
else. They are never keyed on `part.type`.

## A part has three facets, not two

[procedural-geometry.md](procedural-geometry.md) splits a part into **geometry** and **behavior**: two scoped
callbacks that share one script. Editing affordances are the **third facet**. Like the other two, they are
declared, not drawn:

- **Geometry** = the shape. `geometry(g, p)` emits a description, and the host realizes it.
- **Behavior** = controls logic. `step(ctx)` emits commands, and the host applies them.
- **Gizmos** = how a param is edited in space. A param declares a `handle`, and the host renders the dot,
  runs the drag, and writes the param back.

The same rule keeps `ctx` and the `GeometryBuilder` small: **the author composes from a fixed set of primitives
and never gets a raw handle into the host.** A behavior emits commands, not three.js calls. A geometry function
emits a description, not a `BufferGeometry`. A gizmo declares a binding between a param and a place, not a draw
call.

## The core rule: declare a binding, never draw a gizmo

A gizmo is **not** author code. The author states *"this param is editable at this place in the part's
local frame,"* and the engine owns everything spatial: rendering the dot, hit-testing it, projecting the
pointer ray, computing the new value, **clamping it to the param's own `min`/`max`**, and committing it to
undo history. The author writes one declaration next to the param it edits:

```js
definePart({
  params: {
    width:  { type: 'number', min: 0.2, max: 3,   handle: { kind: 'face', axis: 'z' } },
    height: { type: 'number', min: 0.1, max: 0.6, handle: { kind: 'face', axis: 'y', sign: 1 } },
    // the belt's tail + per-run dots are just a numberList rendered as a polyline of handles:
    segments: { type: 'numberList', arity: 2, handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
  },
})
```

There is no imperative gizmo API, for the reasons a part script never calls three.js
([procedural-geometry.md](procedural-geometry.md#why-part-code-never-touches-the-renderer)): sandbox,
determinism, one definition for every consumer, and validation. For a gizmo, the drag-to-value math lives in
`core/`, so a handle behaves the same in the browser and in Electron. The param stays the single source of truth,
seen at once by the gizmo renderer, the Inspector, snapping and serialization. A declared handle is clamped to the
param schema and capped in count, which an opaque drag callback cannot be.

`src/render/`'s gizmo code uses three.js directly, because that is the render adapter's job. The ban applies
only to a portable, shareable part script.

## The handle kinds (a closed set)

The engine ships a fixed set of handle **kinds**. The author picks one and binds it to a param. Each kind
is a `{ render, drag→value }` pair the engine implements. Adding a kind is an engine change, made only when a
real part needs it, the same rule that governs param types and `ctx` commands.

| kind | binds to | renders | drag yields | used by |
|---|---|---|---|---|
| `face` | a `number` | ± dot on the named face | scalar along that axis (opposite face fixed) | the box X/Z/Y resize dots |
| `arc` | a `number` (the sweep, degrees) + sibling `innerRadiusParam` / `widthParam` | an angle dot on the arc end + a width dot on the outer rim | sweep degrees / width | the curved-conveyor arc handles ([curved-conveyor](../examples/parts/curved-conveyor/part.js)); declaring it marks the part a curved conveyor |
| `path` | `numberList` of `[length, tilt]` | tail dot + one node per row | per-segment length (tail shifts to hold the head) | the belt's tail + segment-end dots |
| `flexPath` | `numberList` of `[x, z]` control points + a length param | an infeed dot (the origin) + one dot per point on the deck plane | a point: that point and the bed length the new path implies (infeed holds). The infeed: the part's position and heading, every point re-expressed so the path holds in the world. A shape past the length range or hinge limit stops at the limit (core `flexPull`) | the flex conveyor, pulled into shape by its points |
| `rigSize` | a `number` + a rig `link` and its local `axis` (`'x'` / `'z'`) | a dot on the link's axis at `value/2`, following the posed link; an `'x'` and a `'z'` handle on one link also draw the outline between them | twice the pointer's distance along that axis | the six-axis robot's EOAT tool size; rig parts only |

**The belt's gizmo is a `path` handle**, not a special case. Its tail and segment dots come from
declaring `handle: { kind: 'path', … }` on the `segments` numberList, and `face` on `width`. The
layout and pick code composes several handles on one part. Any custom part that carries a `[length, tilt]` table
gets the same handles with no extra code.

A handle may also carry **snap facts**: static geometry the snap engine needs that the handle's param
already anchors.

- The `arc` handle's `endGap` names the tangent lead-in and lead-out its snap ends extend past the arc.
  `endGapParam` (`{ param, scale?, add? }`) makes it track a param instead. The curved belt's is
  `{ param: 'height', scale: 0.5 }`, its end-drum radius. That is the same reach a straight belt of that Frame
  height puts its ends at.
- The `face` handle (on a conveying part's length param) takes `angleFrontParam`/`angleBackParam`, naming the
  sibling params that splay each end face. Declaring either, together with the manifest's
  `conveyor: { bed: 'spur' }`, marks the part a **spur conveyor** (centre-origin parallelogram bed). Validation
  requires the two to match ([partValidate.ts](../src/core/parts/partValidate.ts)), and the spur bed in
  [conveyorBeds.ts](../src/core/conveyor/conveyorBeds.ts) reads both. The host then derives the angled snap ends, the
  splay-covering footprint and collision hull, the opening a merge cuts in the host's guard, and the rail and guard
  snap extents it folds into a declared `guardExtents` param. It also derives `sideGap`, the clearance kept off
  the host's bed edge at a side merge (default 2×flange; neither shipped spur overrides it). See the spur examples
  ([spur-conveyor](../examples/parts/spur-conveyor/part.js),
  [spur-roller-conveyor](../examples/parts/spur-roller-conveyor/part.js)).

The `face` handle also carries a **bay snap**. `bayParam` names a sibling `number` param holding a bay pitch,
and the drag then locks that face's extent to whole multiples of it (at least one bay). This is the storage rack's
per-cell resize: the rack grows a bay at a time along its width, while its depth (the frame) resizes freely.
`bayGateParam` names a boolean param that must be true for the snap to apply (omitted = always on). The extent stays
clamped to the param's min/max. See [rack](../examples/parts/rack/part.js) (`bayParam: 'poleInterval'`, gated
by `enableAutoPoles`). A face param whose name isn't the built-in `length`/`width` (the rack's `depth`) still
resizes correctly, because the host writes the handle's declared param, not a fixed key.

**The vertical face (`axis: 'y'`).** Declaring one gives a base-origin part a top/bottom resize dot. The +Y
dot drags the top with the base fixed. The −Y dot drags the bottom and drops the origin by the height
change. The dot sits on the footprint's top (`partFootprint().y1`), and the drag writes the handle's declared
param. Both must agree with the param, or the dot is drawn in the wrong place. So the footprint reflows its
height from that param, the same way the X/Z axes reflow length/width (the baked `bounds.top` is only the
authoring default). See [shape](../examples/parts/shape/behavior.ts), whose whole size is three face handles.

## Where it lives in the stack

`handle` is a field on the SDK `ParamSpec` ([partApi.ts](../src/core/parts/partApi.ts)). It is **baked into
`pkg.params` automatically**. `meta` (a separate export of [embeddedBehavior](../src/sim/embeddedBehavior.ts))
serializes the whole `def.params`, the same path that carries `min`/`max`/`arity`. So no build-script or
generated-file change is needed to carry a handle. The author just adds the field.

Three places read the package's declared handles, not the static `PART_DEFS` table and not `part.type`:

- **`effectiveResize(part)`** derives `{ x, y, z }` from a part's declared `face` handles (the static
  building keeps its `PART_DEFS[type].resize` flag). The resize-handle visibility check in
  [controller/gizmo.ts](../src/editor/controller/gizmo.ts) (`pushResizeHandles`) uses it.
- [handles.ts](../src/render/viewport/handles.ts) does a **kind dispatch** over the part's declared handles
  (a `path` handle lays out belt dots).
- `resizePart` in [partGeometry.ts](../src/core/parts/partGeometry.ts) is a **generic drag→param applier** driven
  by the handle descriptor (which param, which column, which clamp), not an `axis → 'length' | 'width'` map.

**There is no scale gizmo, and R is unbound.** A scale gizmo would be a second, weaker resize path: fixed
param keys, centre-symmetric (wrong for tail-origin conveyors), and none of `resizePart`'s rules (height,
belt last segment, incline, bay snap). Parts have no transform scale at all (position + rotation + params).
Size is a param the part rebuilds itself from, so a stretch gesture has nothing to act on. The face handles
show in every gizmo tool, and **Select (V)** shows them without the move/rotate gizmo. That covers what a
separate Resize tool would do, which would only be Select minus box-select. Every drag that changes a part's
size goes through `resizePart`, which holds the opposite face fixed. For a vertical face it reads the
origin's place in the height off the footprint before and after, so base-origin parts (fence, shape) and
centre-origin cargo (the box) both resize correctly. Don't add a gizmo that changes size params directly.

## Non-goals

- **An imperative gizmo API** (author-drawn meshes, custom hit-test and drag math, screen-space UI). That would
  make the SDK a general UI toolkit, which this project does not build. When something can't be expressed with
  the existing kinds, add a kind to the engine. Don't give the part a canvas.
- **Gizmos that read sim or tag state.** A handle binds to a *param*, the same side-effect-free contract as
  `geometry(g)`. Coupling between facets goes through shared params, never a back-channel.
- **A second source of truth.** The param is authoritative. The handle never stores geometry of its own.
- **Touch parity.** Coarse-pointer devices already skip the face-cube handles (`IS_COARSE_POINTER` in
  [controller/gizmo.ts](../src/editor/controller/gizmo.ts)). Declared handles inherit that and don't fix it.
