# Part SDK vocabulary

The words a part is described in, where each is declared, and why. The current package format is 6
(`PACKAGE_FORMAT` in [src/core/parts/partPackage.ts](../src/core/parts/partPackage.ts)). Older stored packages load through
`PACKAGE_UPGRADES` ([partUpgrade.ts](../src/core/parts/partUpgrade.ts)), which is the one record of what each format renamed. This page describes only the current words.

## The test

A user, or their agent, should be able to **predict where a thing is declared and what it is called** without having
seen an example.

## The model

A part is five things, and each lives in one place:

| | What it is | Where it lives |
|---|---|---|
| **Identity** | id, name, category, thumbnail | manifest |
| **Params** | the part's Inspector interface: sizes, speeds, colours, PLC tags | script, `definePart({ params })` (so `ctx.params` is typed from it) |
| **Body** | what it physically is: links (shape, place, look, physics), drawn submeshes, models, materials | manifest (links, assets, materials) + script `geometry()` (drawn submeshes) |
| **Connectors** | how it meets other parts, and what meeting does to each | manifest (`snap`) |
| **Behavior** | what it does each tick: tags, motion, sensing, cargo, lamps | script, `step(ctx)` |

**The one rule an author needs:** the manifest says what the part is (body and connectors). The script says what it
does (behavior), what the user can set (params), and anything it draws in code. Names the manifest already declares
(joints, grippers, lamps, servos) may be repeated in the script only to get typed `ctx` bags. The manifest stays the
source. A servo is a joint the manifest marks `servo`: the word is `servo` in both places, because a joint's `axis`
is already its direction.

## Principles

1. **One idea, one word. One word, one idea.**
2. **One place per declaration** (the rule above).
3. **The same spelling on a link and on a drawn submesh**, so moving a piece from the manifest into `geometry()` does
   not mean relearning it.
4. **Look is separate from behavior.** Choosing how something looks never silently changes what it does.
5. **General before specific.** Connectors are named by what they do, not by the part that first needed them
   ([part-snap-cuts.md](part-snap-cuts.md)).

## Geometry kinds

- **`'rig'`**: links and joints declared in the manifest. A rig's `geometry()` is render-only, and its solids are
  links.
- **`'drawn'`**: drawn by the script's `geometry()`, which returns submeshes (`MeshPart` in
  [partApi.ts](../src/core/parts/partApi.ts)).
- **`'cargo'`**: a box, pallet or tote the line carries. A rig with a `cargo` block is cargo too
  ([cargo-bodies.md](cargo-bodies.md)).

A one-box conveyor is a rig with one `conveys` box. There is no separate deck geometry or shape kind.

## Look: `finish`, `material`, `color`

- **`finish`** picks a host material: `'frame'`, `'guard'`, `'leg'`, `'bolt'`, `'gapfill'`, `'roller'`, `'belt'`,
  `'tread'`, `'deck'`, `'mesh'` (`Finish` in partApi). The same value set applies on a link and a submesh.
  On a link, `finishParam` names an enum param whose options are finishes, so the Inspector picks the look.
- **`material`** names a package material. **`color`** is a flat tint.
- Belt scroll and roller spin go with the finish: they are how that material looks when it moves. A drawn submesh
  can also declare `scroll` and `spin` itself (a chain's links, a pulley).
- **`outline`** is a primitive link's wireframe edge colour. **`opacity`** on a link is idle translucency. On a lamp
  it is the lit lens.

A finish is only a look. What the host does with a piece is declared on its own, below.

## What the host does with a piece

These are separate from `finish`, so a look never switches behaviour on:

| Field | On | Meaning |
|---|---|---|
| `sideGuard: 'left' \| 'right'` | box link, drawn submesh | a conveyor side guard wall: a butting neighbour opens it, a flush merge retracts it, collinear neighbours merge into one wall, and it has no friction |
| `sideRail: 'left' \| 'right'` | box link | a below-deck rail: a flush merge retracts it, a butting neighbour never opens it |
| `bed: true` | link on a conveying rig | the solid belongs to the conveyor bed, so cargo sliding across it does not snag |
| `notchable: true` | box link | the walking deck, which a neighbour's edge mount notches ([part-snap-stairs.md](part-snap-stairs.md)) |
| `conveys: true` | box link | a conveying surface, at the velocity the behavior sets |

`sideGuard` and the platform's railing cut are different words because the rules differ: a guard also thickens,
merges and has no friction, while a railing does none of that.

## Solidity: `collision`

- On a link, omitted means the shape's default: a `box` or `cylinder` collides as itself, and a `mesh`, `cone`,
  `frame`, `label` or `leg` does not. `collision: 'none'` renders the link with no body. On a `mesh` link,
  `collision: { box: [x, y, z] }` collides as a box centred on the link origin.
- On a drawn submesh, `collision: 'box' | 'hull'` makes it solid. Omitted means decorative.

## Showing and hiding: `showParam`

`showParam` names a boolean param that hides a link, arrayed or not, and it survives the railing cut. A sensor
beam's own `showParam` hides only the drawn line. Its `rangeParam` sets the beam's length, for sensing and drawing.

## Lamps

A link or submesh carries `lamps: [{ name, emissive, offColor?, opacity? }]`. `emissive` is the lit colour and
`offColor` the dark one. On a link `name` defaults to the link's name, and a mesh link's lamp also names the
`material` it lights. The behavior switches them through `ctx.lamps` / `ctx.setEmissive`.

## Grippers: `grip`

A link with `grip` is a gripper, and the block sizes what it takes: `zone`, or `radius` (the pickup sphere), and
`forks`. Any link can still be commanded to grip at the host's 0.2 m default reach. The script's `grippers` list is
only a typing aid, like `joints` and `lamps`.

## Footprint: `bounds`

`bounds: { length, width, top, bottom?, centerX?, centerZ?, params? }`. `length` runs along local X and `width` along
Z. The box is centred on the origin unless `centerX` / `centerZ` move it. `top` and `bottom` are heights in the part's
own frame, so no field means "height from where". `params` ties fields to the part's size params. A cargo box has a
centred `size` instead.

## Joints

A joint's `min` / `max` are its static limits. `minParam` / `maxParam` let an instance's params narrow them, the same
way sizes follow params.

## Declared roles instead of reserved names

The host reads no param by its name. A part declares what it means:

- **`conveyor: { bed?, surface, speedParam?, reverseParam?, frictionParam? }`** in the manifest says the part is a
  conveyor to its neighbours: its bed kind (`'straight'`, `'spur'`, `'path'`, `'arc'`, `'turntable'`), what cargo
  rides on, and which params are the speed, the flow reversal and the surface's friction against a carton. The viewport's drag handles only decorate it; they do not decide it.
- **`commsParam`** names an optional boolean param that connects the part's tags to the PLC. The wiring check reads
  it. A part without one is connected by each tag field that names a tag; no built-in declares one.

These are on the manifest, not the param spec, because params are baked from behavior code and the manifest is what
a stored part keeps.

## Connectors: `snap`

`snap` lives in the manifest. Its kinds ([part-snap-connectors.md](part-snap-connectors.md)):

- **`flush: true`**: seat against any part's nearest vertical face, at the part's own height.
- **`tile`**: edge-to-edge tiling with its own group, at the target's height ([part-snap-edges.md](part-snap-edges.md)).
  This is a separate word from `flush`, because the two pair with different targets at different heights.
- **`mounts`**, **`surfaces`**, **`track`**: a device seating on a host surface, and the host's half
  ([part-snap-surfaces.md](part-snap-surfaces.md)).
- **`chain`**: end-to-end chaining of a linear part ([part-snap-chain.md](part-snap-chain.md)).
- **`edgeMount`**: seating along a host deck edge ([part-snap-edge-mount.md](part-snap-edge-mount.md)).

## Behavior

`step(ctx)` runs each tick. The timestep is `ctx.dt`.

- **`setJoint` / `setGrip` / `setEmissive` next to the `joints` / `grips` / `lamps` bags** are not duplicates: with
  names declared, a computed name (`'h' + i`) is a type error on the bag, and the setter is its typed spelling.
- **The three conveying verbs** (`setSurfaceVelocity`, `setArcSurfaceVelocity`, `setSurfaceSpeed`) cover a line, an
  arc, and each hinged section along its own direction.

## How the vocabulary is held

[src/editor/partCensus.test.ts](../src/editor/partCensus.test.ts) records what every shipped part means to the host,
through the host's own classifiers. A rename that changes what a part does fails it.
