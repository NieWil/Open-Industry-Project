# Part author's guide

This guide covers building a custom part for OIP, from a blank box to a PLC-connected machine you can hand
to someone as a single file. Every built-in part is authored on this same SDK
([architecture.md](architecture.md)), so [`examples/parts/`](../examples/parts/) is a library of worked
examples: whatever you are building, a shipped part already does something like it.

The step-by-step part guides on the site start before this one. Four guides take one blade stop from a model to a part
that stops product, all through the app's own UI and with no code in the part: [a part from your own model](https://www.openindustryproject.org/guides/part-model/),
[a piece that moves on a PLC command](https://www.openindustryproject.org/guides/part-motion/) (Split into pieces, a
joint, PLC control Two positions), [its state back to the PLC](https://www.openindustryproject.org/guides/part-feedback/)
and [stopping product](https://www.openindustryproject.org/guides/part-product/) (a collider under the moving node).
Their pages are `guides/part-*/`, each followed by its `e2e/guide-part-*.mjs`.

The API reference is the generated SDK in [`packages/part-sdk/`](../packages/part-sdk/), the same types the
in-app editor uses for autocomplete. This guide is the overview; those files have the details:

- [`index.d.ts`](../packages/part-sdk/index.d.ts): the behavior (`definePart`, params, `ctx`).
- [`manifest.d.ts`](../packages/part-sdk/manifest.d.ts): the manifest (`PackageManifest`): geometry, rig
  links and joints, every shape kind and link capability (`beam`, `zone`, `conveys`, `array`, …), assets and
  materials. Each shape kind is its own documented interface (`RigMeshShape`, `RigBoxShape`, …).
- [`manifest.schema.json`](../packages/part-sdk/manifest.schema.json): the manifest as JSON Schema. Put
  `"$schema": "<path>/manifest.schema.json"` at the top of a `manifest.json` and VS Code completes and checks it.

A part on disk is a folder with `manifest.json` and `behavior.js`. Name yours that way. The loader also
reads `rig.json` and `behavior.ts`, the older names the built-ins in `examples/parts/` use (the `.ts` holds
plain JS); read a linked `rig.json` / `behavior.ts` as the `manifest.json` / `behavior.js` you would write.
In a folder that also has a `part.js`, those two files are built from it
([Writing a part as one `part.js`](#writing-a-part-as-one-partjs)), so read the `part.js`. The other examples are
hand-written and edited in place.

The SDK is pre-1.0 and can break between releases. See
[Stability](../packages/part-sdk/README.md#stability) in the SDK README.

## What a part is

A part is one portable, deterministic package:

- **Geometry**, in the manifest: a rig of links and joints, or shapes drawn by a `geometry(g, params)`
  function (`kind: 'drawn'`) for swept and lofted forms.
- **What it is to the host**, declared in the manifest:
  - `conveyor`: what kind of conveyor it is, what cargo rides on, which params are its speed and reverse flag.
  - `commsParam` (optional, and usually left out): a boolean that switches its PLC link. Without one, each tag
    field that names a tag is connected and an empty one is not, which is how the built-in parts work.
  - `snap`: how it connects to other parts.
  - `holds`: the cargo it stores, `{ part, positions, limitParam?, params? }`: a cargo package id and its
    gripper links bottom first. `params` hands the items some of the holder's own params
    (`{ size: 'palletSize' }`). The Inspector's Fill / Empty place real parts at those positions, parented to
    the part, and the behavior grips what it finds there when the run starts
    ([pallet-dispenser](../examples/parts/pallet-dispenser/)).

  A part that declares none of these is not a conveyor, is always connected, connects to nothing, and
  stores nothing.
- **Behavior**: one JS script calling `definePart({ params, step(ctx) { … } })`, run every fixed sim tick.
  No imports, no DOM, no network; everything comes in through `ctx`.
- **Params**: the schema you declare in `definePart` is baked into the package, so the Inspector renders your
  fields without running your code.

The same package loads in the browser, the desktop app and a shared scene. Behaviors must be deterministic. Use
`ctx.simTime`, `ctx.dt` and `ctx.rng()` (a seeded PRNG) where you would reach for `Date` or `Math.random`
([Ground rules](#ground-rules)).

## The authoring loops

### In the browser

In the Parts dock, click **＋ New part**. You get a box at the origin, open in the Part Editor. Select rig
nodes in the Inspector to reshape, add or move links (gizmo drags work and are undoable).

- **Shape → Kind** switches what a node is. The panel builds `box`, `cylinder`, `cone` and `frame` from
  nothing, and switching keeps the node's dimensions.
- **New node** picks the kind **＋ Add child node** drops in.
- A `mesh` link comes from **Import model…**, the only route that supplies the GLB.
- `leg` and `label` are authored in the manifest. The selector shows them but can't construct one.
- Select the part itself to set its **Name** and **Category**.

**Edit behavior** opens the in-app editor, with the full SDK types and live validation; Apply commits to the
running catalog. Browser-authored parts persist in your project. A structurally invalid rig edit is blocked
and never registered: the last working version stays live, and the diagnostics show as a toast, a ⚠ badge
on the catalog card, and a strip in the Inspector.

### On the desktop

A project keeps its parts in its folder as `parts/<part>/manifest.json` + `behavior.js`. Any part's *Open in
external editor* opens that `behavior.js` (a built-in first becomes this project's own copy; other projects
keep the built-in). Saves in your IDE come back into the app: placed instances rebuild, and a running sim
swaps the behavior live. Edits made in the app are written to the same files. *File > Import Parts from
Folder…* copies parts from another folder into the open project.

A project's copy of a built-in records the version it was copied from (`origin.app` in its `manifest.json`,
written by the app). When a later app ships a changed built-in, the catalog card says *Updated* and you
choose: the app's new version, or the project's.

### Writing a part as one `part.js`

A part folder can hold one more file, `part.js`, that the folder's `manifest.json` and `behavior.js` are built from.
Use it when the rig follows the params: you write the rig as code, and the build works out the manifest's param refs.
Most built-ins are written this way, so their `part.js` files are worked examples
([safety-gate](../examples/parts/safety-gate/part.js), [belt-conveyor](../examples/parts/belt-conveyor/part.js)).

One `definePart` holds the whole part:

- `manifest`: everything a `manifest.json` holds (`id`, `name`, `category`, `conveyor`, `snap`, `materials`, and so
  on), typed as `PartSourceManifest` in the SDK. Leave `geometry` out when `rig()` computes it. A part whose
  geometry is not a rig (`drawn`, `cargo`) puts it in `manifest.geometry` and has no `rig()`.
- `rig(p)`: the rig's links, joints and bounds, computed from the params with ordinary arithmetic:
  `size: [0.03, p.raiseHeight + 0.15, p.width]`. It returns a rig geometry without its `kind`
  ([Tier 1](#tier-1-rig-links-and-joints) describes the fields).
- the params, `geometry()`, `step()` and the rest, as in any behavior.

Only the build reads `manifest` and `rig()`. The app never runs a `part.js`, and the shipped `behavior.js` leaves both
out, along with any helper nothing else calls.

**What the build fits, and what you write.** A manifest holds numbers and param refs, not code. So the build runs
`rig()` at the defaults and again with each param moved. Where a number follows the params in a form a ref can hold
(`param × scale + add` on a box's `sizeParams` or a link's `offsetParams`, for example), the build writes that ref in
place of the number. The fields and forms it fits are listed under `build-parts` in [cli.md](cli.md). It refuses a
rig it cannot express and names the field, for example a link that appears or goes with a param. Move that shape into
`geometry()`, or write the ref in `rig()`'s output yourself, spelled as the manifest spells it. Round your own derived
constants to 8 decimals (`const r8 = (n) => +n.toFixed(8)`), or the float noise lands in the manifest. Round no
coarser: the build checks each fit to 1e-7, and a value rounded to 6 decimals reads as not following its param.

**Shared modules.** A `part.js` may import named exports from other files by relative path:
`import { legPieces } from '../_shared/legs.js'`. The build joins each imported module into `behavior.js`, so the
shipped part carries its own copy and stays complete. The joined subset is small: `import { a, b } from './x.js'`
(no `as`, no default import), and `export function` / `export const` (no `export {}` lists, no default export). A
top-level name must be unique across the joined files. In a project, keep shared modules in `parts/_shared/`. The app
reads and writes only a part folder's `manifest.json`, `behavior.js` and asset files, so it never changes or removes
a `part.js` or anything else under `parts/`.

**Building and checking it**, from an oip-web checkout:

- `npm run build-parts -- path/to/parts/my-part` writes `manifest.json` and `behavior.js` beside the `part.js`. A
  bare name (`belt-conveyor`) means a folder in this repo's `examples/parts/`, where the two files are named
  `rig.json` and `behavior.ts`.
- `npm run build-parts -- --check path/to/parts/my-part` writes nothing, and fails when either file differs from
  what the `part.js` builds.
- `npm run check-part -- path/to/parts/my-part` builds the part in memory and checks the build
  ([Does it load?](#1-does-it-load)). It also reports a `stale` problem when the files beside the `part.js` are not
  what it builds.

**What ships, and what to edit.** The `manifest.json` and `behavior.js` are what the app loads, and what a project's
copy, a `.oippart` file and a part library carry. The `part.js` stays in your folder. So edit the `part.js` and
build again: a change made to the output is undone by the next build. The app edits a part through its output only.
The Part Editor and the agent tools write `manifest.json` and `behavior.js` and leave `part.js` as it was (the MCP
tools take a manifest object and a behavior script, never a `part.js`). After such an edit, `check-part` and
`build-parts -- --check` name the files that no longer match. `build-parts` refuses to overwrite a file that is newer
than its sources: copy the change into the `part.js` and build again, or pass `--force` to discard it.

### Testing

Right-click a placed part → *Open Part Editor* to isolate it, then press Play. The sim runs just your part
(plus anything you drop on it). To test without the app, see [Verify it headless](#verify-it-headless).

### Sharing

Every custom-part card has a **⤓ download** button that saves the part as `<id>.oippart`; the Parts dock's
**⤒ Import part** loads one. The file is the part folder zipped (`manifest.json`, `behavior.js`, models in
`assets/`), so unzipping gives an editable folder and zipping a folder gives an importable file. It is
validated again on import. This is also how you move a part between the browser and desktop. Older
`.part.json` files still import.

### Deleting

A part you authored or imported has a **✕** on its card. Deletion is blocked while the scene still places
the part, and while it is open in the Part Editor. In a shared project the part leaves everyone's parts. Deleting an
edited built-in reverts the card to the app's version (your changes are discarded). On the desktop the project's parts are files in
`<project>/parts/<slug>/`, and ✕ works the same way: the folder sync then removes the part's files. Deleting a
part's folder by hand does not remove the part. The folder sync checks the project folder once a second, and while
`project.json` still lists the deleted folder the folder does not load: the sync holds and shows the error until
the folder reads as a project again ([projects.md](projects.md#the-folder-is-the-project-two-way-sync)).

## Verify it headless

These commands run from an oip-web checkout in seconds, with real exit codes.

### 1. Does it load?

`npm run check-part -- path/to/my-part`:

- checks the manifest against the schema, catching typos the app would ignore (`noColision` validates and
  does nothing);
- bakes the behavior as the app does (determinism, rig, params, snap refs; errors carry behavior line numbers);
- reports the footprint at default params, PLC signals, joints, colliders, conveying links, beams and zones.

A folder with a `part.js` is built in memory first, and the checks run on that build
([Writing a part as one `part.js`](#writing-a-part-as-one-partjs)).

For a rig the footprint is the `bounds` you declared, so the rig is also measured, with each mesh link's model
and each collider placed at rest. It warns when the model spills out of its bounds (an off-centre import,
stale bounds, a missing `bottom`), when a collider sits well outside the model, or when nothing collides. A rig
with no `bounds` takes the box its box, cylinder and cone links fill at rest. One with a model, label or leg link,
an array or an incline can't be measured that way and gets a 1 m box, so declare its bounds.

### 2. Put it in a test scene

```
npm run add-part -- my-test ./my-part oip.roller-conveyor oip.box --place
```

This creates `my-test/` if needed, bakes your part into the project, and checks that the built-ins
you name exist (`npm run catalog` lists the ids). `--place` rests one of each on the floor at the origin; give a
part `--at x,z` after it to rest it elsewhere, or `--at x,y,z` to put its origin exactly there.

`--scaffold` instead of `--place` lays out a straight line through the editor's snap engine (code:
[lineScaffold.ts](../src/core/lineScaffold.ts)):

- Conveyors end to end along +X from x = 0 at a 0.8 m stand height, in argument order.
- Guard devices (sensors) on the +Z guard facing across the belt, one 0.6 m before the discharge (several spread
  from the infeed to there); `--at` x picks a device's spot along the line.
- Buttons on the -Z frame near the infeed; a spawner above the infeed; a sink on the floor past the discharge;
  cargo on the first belt; anything else on the floor beside the line.

It wires only the tags its program and starter test use, with unique names (`Belt1Run`, `DischargeEye`,
`StartPB` / `StopPB`, `Spawner1Run`); a tag named in `--params` keeps its name, and other tag params stay blank.
If the project has no program, it writes `plc/program.st` (listed in the manifest's `program`): a Start/Stop latch that starts
stopped, running the conveyors while latched. It never overwrites an existing program; it prints the
declarations to add instead. With a conveyor and something on it (cargo or a source) it writes
`tests/starter.test.json`, which presses Start and checks the line was stopped before and that a box then
physically moves (reaches the discharge eye, rides the belt, or is fed on). Replace it with what your part must
do. Without a conveyor and cargo it writes no test and says why.

The project holds a copy of your part. After editing, rerun `npm run add-part -- my-test ./my-part` (no
`--place`) to refresh it, or edit `my-test/parts/<id>/` directly and treat that as the source. A part written
straight into `my-test/parts/` is added by its id (`npm run add-part -- my-test acme.my-part --at 2,0`). A part written as a
`part.js` is copied as its built files, so build it first: `add-part` refuses a folder whose built files are not what
its `part.js` builds.

Frame conventions to place parts by (confirm any part's with `check-part` on its example folder; the
footprint is part-local):

| Part | Origin | Flow |
|---|---|---|
| roller conveyor, turntable | centre of the conveying surface (bed top at y = 0) | +X |
| belt conveyor | tail end of the surface (spans x = 0 … length) | +X |
| blade stop, chain transfer | on the conveying surface it mounts to | spans Z, across the host's +X flow |
| box, pallet | centre of the load | none |

A conveyor's footprint reads y1 = 0.05: that is a selection pad above the surface, not geometry. Place a
conveyor at `[x, standHeight, z]`, a device on it at the same y, and a box on it at y + half its height.

### 3. Say what "works" means

Write a PLC program and a test in `tests/`. The program is the files under `plc/` that `project.json` lists in
`program`, joined in that order ([projects.md](projects.md#the-program-as-files-format-7)); `add-part --scaffold`
starts one in `plc/program.st`. The simplest form is bare declarations and statements, whose variables are the
scene's tags by name. A program that is one `PROGRAM … END_PROGRAM` also answers to bare names, but two or more
PROGRAMs and nothing else do not, and `check-wiring` warns that nothing reaches the parts' tags
([DEVICE-IO.md](../src/plc/DEVICE-IO.md#a-program-wholly-inside-one-program-bare-names-too)):

```
VAR_INPUT
  Release : BOOL;   (* a tag the test stimulates, or a part publishes *)
END_VAR
VAR_OUTPUT
  Extend : BOOL;    (* a tag the program drives: this is what makes an autoWhenDriven part obey *)
END_VAR

Extend := NOT Release;
```

```jsonc
// tests/blocks.test.json
{
  "name": "Extended blade stops the box",
  "duration": 8,
  "checks": [
    { "eventually": true, "within": 6, "tag": "AtStop", "equals": true },
    // nothing got past the blade: no cargo in the zone downstream of it, for the whole run
    { "always": true, "max": 0, "probe": { "count": { "zone": { "min": [0.52, 0, -1], "max": [5, 3, 1] } } } },
    { "at": 8, "near": 0.185, "tolerance": 0.05, "probe": { "pose": { "part": "box1", "axis": "x" } } }
  ]
}
```

The spec format is in [project-tests.md](project-tests.md). Four traps:

- An `autoWhenDriven` tag param only takes over the device when a **program output** drives it (that is what
  `ctx.tagDriven` means). A test `inputs` entry on it leaves the device on its hand state. Drive it from the
  program (`Extend := NOT Release;`) and stimulate the program's inputs.
- `eventually … equals false` passes at t = 0 when the tag starts false, and `test-project` marks that pass with a
  warning. Check a transition with `at:` after it has had time to happen, or check `true` first.
- Probe a joint directly: `"probe": { "joint": { "part": "stop", "joint": "lift" } }` reads the last value the
  part commanded (latched between commands, clamped to the joint's limits). It is absent until the part first
  commands it, so a mistyped name fails as "never appeared" instead of reading 0.
- List the tests in `project.json` `"tests"`: the app runs only the listed ones. `test-project` runs every
  `tests/*.test.json`, listed or not, and notes each one the app will not run. So keep a control you expect to fail
  out of `tests/` (a `controls/` folder), or it turns the run red.

### 4. Run it, and run a control

Run `npm run validate-project -- my-test`, then `npm run test-project -- my-test`. Then break the one thing
the test claims to prove (`"collision": "none"` on the blade, or a stroke of 0) and confirm the test fails. A
test that still passes with its cause removed measures something else. `check-wiring` and `check-layout` do
the same for tags and seating.

### 5. The two things tests can't see

**Snapping.** `npm run snap-part -- ./my-part --onto oip.roller-conveyor` asks the editor's snap engine where
your part seats on a host and which params the snap fits (a track's width, a sensor's range). It also reports
what the connection does once committed: a railing gap or deck notch, the lift that raises it flush, a guard
opening where a conveyor meets another's side. `--at x,y,z` and `--rot <deg>` set where and at what yaw the
drop is proposed; `--json` prints JSON.

**Looks.** `npm run shot-part -- ./my-part [--pose lift=0]` renders the part through the real renderer from
four sides, at rest and posed, as PNGs: use it for a texture, a carve or a lamp, which no probe reads.
`--sub-pose 'carriage={"position":[0,0.2,0]}'` poses a link the way `ctx.setSubPose` does (`slat[3]=...` for one
copy of a posable array), once per link.
`--params k=v,...` sets instance params first, `--focus x,y,z,r` frames a close-up of a part-local sphere, and
`--out <dir>` picks the folder (default `<part>/shots/`).

For maintainers: `npm run sdk-usage` counts how many first-party parts use each SDK field and `ctx` member.

## Geometry, tier by tier

### Code or a model? Decide first

Build engineered hardware in code (rig primitives and `geometry()`) when either holds:

- You could describe it: plates, rails, tubes, brackets, bolts, housings of boxes and cylinders. Code stays
  readable, diffable and testable, and anyone can change it, including an agent that can read a GLB but not
  edit one.
- Code needs its shape: a param changes it (a length, stroke, lane count), something depends on its dimensions
  (a snap, a mating part), or the rig would otherwise need the model's node names and scale factors.

Keep a model when its appearance is the asset: a photo texture, baked detail maps (a robot arm), a vendor's
CAD, building scenery.

Worked conversions from GLB to code: the conveyor roller (`rollerTemplate` in
[_shared/rollerBed.js](../examples/parts/_shared/rollerBed.js)), the Blade Stop
([blade-stop](../examples/parts/blade-stop/part.js)), the chain-transfer lane
([chain-transfer](../examples/parts/chain-transfer/part.js)), the Push Button
([push-button](../examples/parts/push-button/part.js): housing, bezel, slotted bolts, a lit cap on
the link the press moves), the six-axis robot's suction tool
([six-axis-robot](../examples/parts/six-axis-robot/part.js), built at the size the tool params ask for; the
arm keeps its model), and the diverter, built from `divertDistance`
([diverter](../examples/parts/diverter/behavior.ts)). The cargo box and pallet are drawn by the host:
[cargoBoxMesh.ts](../src/render/parts/cargoBoxMesh.ts) and [palletMesh.ts](../src/render/parts/palletMesh.ts),
textured by [build-box-textures.mjs](../scripts/build-box-textures.mjs) and
[build-pallet-textures.mjs](../scripts/build-pallet-textures.mjs).

To convert a model, take its numbers with `npm run inspect-glb`, prove the result renders the same
(`npm run shot-part` before and after, diffed pixel for pixel; match what renders, since a GLB can carry
geometry that never draws), and pin its dimensions in a test.

Don't copy a manufacturer's product. Design a generic housing of the same kind and keep only its interface,
the numbers the rest of the app is placed against. The sensor housings
([sensorPhotoeye.js](../examples/parts/_shared/sensorPhotoeye.js), and the laser's in
[its part.js](../examples/parts/laser-sensor/part.js)) keep the height, footprint, lens face and materials,
not the vendor's styling, and tests pin that interface against the drawn geometry
(`diffuseSensorRigParity.test.ts`).

Load time and draw cost are not reasons either way; see
[procedural-geometry.md](procedural-geometry.md#code-or-model-when-a-part-uses-geometry-and-when-a-glb).

### The smallest conveyor

A rig with one box link marked `conveys: true` is a powered conveying slab. With `ctx.setSurfaceVelocity`
it is a conveyor in about 10 lines. The manifest:

```json
{
  "id": "acme.powered-deck",
  "name": "Powered Deck",
  "category": "Equipment",
  "geometry": {
    "kind": "rig",
    "links": [{ "name": "deck", "shape": { "kind": "box", "size": [6, 0.1, 1] }, "offset": [0, -0.05, 0], "conveys": true }],
    "joints": [],
    "bounds": { "length": 6, "width": 1, "top": 0.05, "bottom": -0.1 }
  }
}
```

The behavior (`behavior.js`, no imports; the runtime injects `definePart`):

```js
definePart({
  params: {
    speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Speed', unit: 'm/s',
      desc: 'Surface speed along the flow arrow. 0 stops the deck; cargo on it stops with it.' },
    reverse: { type: 'boolean', default: false, label: 'Reverse',
      desc: 'Run against the flow arrow.' },
  },
  // every fixed sim tick; deterministic, so no Date or Math.random
  step(ctx) {
    const s = ctx.params.speed * (ctx.params.reverse ? -1 : 1)
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
```

Give every param a `desc` (see [Params](#params)); it is the Inspector's hover text.

To be a conveyor to its neighbours (guard openings where another conveyor butts it, end-to-end and
side-merge snapping, deck merging), declare it in the manifest:

```jsonc
"conveyor": { "surface": "roller", "speedParam": "speed" }
```

- `bed` is the shape neighbours meet. The fixed-size deck has none. Each kind names the handle or joint that
  gives its geometry, and a missing one is a validation error:
  - `'straight'`: sized by `face` handles on its length and width params;
  - `'spur'`: a straight bed whose length handle names splay angles;
  - `'path'`: a bent belt edited by a `path` handle;
  - `'arc'`: a curve swept by an `arc` handle;
  - `'turntable'`: a revolute joint turning a cylinder deck.

  To give the deck `"bed": "straight"`, add `length` and `width` params with
  `handle: { kind: 'face', axis: 'x' }` and `{ kind: 'face', axis: 'z' }`, and size the deck from them with
  `sizeParams`. Omit `bed` for any part that conveys but is not a conveyor to its neighbours.
- `surface` is the grip: `'belt'` when cargo rests on a surface that moves with it (belt, slats, mat-top
  chain), `'roller'` when it rides over rollers or wheels.
- `speedParam` names the number param the host reads outside your tick (belt scroll, roller spin, the flow
  arrow, the pilot riding the surface, the spawner-interlock seed before the first tick). Any name works.
- `reverseParam` names a hidden boolean the snap flips to turn a curve's flow around.
- `frictionParam` names the number param that is the surface's friction against a standard carton, the figure a
  belt datasheet quotes (a smooth PVC belt about 0.4, a rough-top about 0.9, a low-friction modular belt about
  0.2). Other cargo grips by its own friction against it. Without one the surface grips as its `surface` kind
  does: 0.59 against a carton for a belt, 0.42 for rollers. The shipped conveyors call theirs `friction`.

### Tier 1: `rig` (links and joints)

A rig is a flat list of links, each `{ name, parent?, shape, offset, rotation?|quat? }`, plus joints
(`revolute` | `prismatic`, with axis and limits) that behaviors command by name.

- `cosmetic: true` on a joint the behavior drives purely from its own state (rolling wheels, a piston
  tracking a lift). The rig gizmo skips it (no ring, never the IK end-effector), and the idle `pose` row
  indexes only the author-posable axes. The SDK AGV's wheels and piston are the reference.
- `mimic: { joint, multiplier?, offset? }` on a joint that follows another: the host poses it at the leader's
  value × `multiplier` (default 1) + `offset` (default 0), held to its own limits, everywhere the leader is posed.
  A gripper's second finger is the usual case: the behavior commands only the leader, and `ctx.setJoint` on the
  follower changes nothing. The leader must be another joint of the rig that follows none. The gizmo and the PLC
  panel leave a follower out.
- `rest: { param, scale?, add? }` on a joint the behavior slews to one param's value and holds, in the joint's
  native unit (the turntable's `{ param: 'deckAngleDeg', scale: π/180 }`). The host can then mirror the
  settled pose (the pilot's surface-carry direction on a held deck) without running the behavior.

`posable: true` on the rig geometry opts the part into the **teach-by-pose gizmo**: joint rings and an IK
end-effector handle, shown when the placed part is selected and the sim is stopped. Hovering a handle names
the joint and shows its angle; a joint with limits draws only the arc it can reach. Up to eight joints get rings.
The end-effector is the rig's `tool` link (a flange or TCP frame), else the last posable joint's link, and a drag
moves only the joints between the root and it, so a gripper's fingers beside the tool keep their place. On a chain
of six or more joints, three of them revolute, dragging the end-effector keeps the tool's orientation, whatever the
wrist's shape; hold Alt to let it turn. A dragged
pose is jogging, not an edit: the Inspector says the arm is jogged and offers Reset, and nothing is saved
until Inspector → **Capture Pose** records it (robot, gantry, AGV lift). Leave `posable` off when the sim or
PLC drives the joints (safety gate, diverter, blade stop, turntable); they articulate the same, without a pose
gizmo. Link-offset gizmos are separate and always available in the Part Editor.

Shape kinds:

| Shape | What it is |
|---|---|
| `box`, `cylinder` | primitives with collision; `sizeParams` makes axes track a param |
| `cone` | render-only (no collision, cargo passes through); apex +Y, rotate the link to point it down. A schematic cue like the spawner's drop marker; pair with the link's `opacity` |
| `frame` | transform-only pivot: a joint origin, no geometry |
| `mesh` | a GLB (embedded or url asset). See [Mesh links](#mesh-links) below |
| `label` | canvas text plane (`text`, `textParam`, or `textFrom` for a live caption the behavior publishes with `ctx.display`) |
| `leg` | the app's trestle leg row, host-built |

There is no chain or roller shape kind. Draw a chain lane in `geometry()` with a scrolling `MeshPart.scroll` (as
[chain-transfer](../examples/parts/chain-transfer/part.js) does) and a roller bed as an instanced bank with
`spin` (shared code in [_shared/rollerBed.js](../examples/parts/_shared/rollerBed.js)).

#### Mesh links

A `mesh` link takes per-node refs, `hideNodes` / `keepNode` carving, `fitHeight` normalising, `scale`
(uniform), `material` (one package material on every mesh) or `materials` (per GLB material), and lamps on
its remapped materials.

- A remapped package material (`materials: { "GlbMatName": "pkgMatId" }`) is PBR: `albedo` / `orm` / `normal`
  plus scalar `color` / `metalness` / `roughness`.
- `triplanar: { space, scale, boost? }` on a package material samples its `albedo` by `world` or
  `object`-space position instead of the mesh UVs. Use it when an imported GLB's UVs smear a texture along a
  long axis. `scale` is tiles per metre; `object` locks the grain to the geometry so a moving or telescoping
  part doesn't swim.
- `sizeParams` stretches the mesh along an axis by node scaling. When the model's texture repeats along that
  axis, add `tileUv: [{ axis, uv, materials }]` to re-tile instead of smear: the named UV channel of those GLB
  materials (by authored name, before the remap) is multiplied by the stretch factor. The Gantry's legs and
  rails do this on `Trim`, whose `u` runs 0..1 along the 4 m authored span, so the bolt holes keep their
  spacing on a 20 m frame. List only materials whose UVs repeat along the axis; an island sampling one spot
  of an atlas (an end cap) would wander off it.
- Its lamps are the link's `lamps`, each naming the remapped material it lights. A panel whose lenses share
  a node carries one lamp per lens: `hideNodes` / `keepNode` carve by node and cannot split one mesh's
  materials.

#### Link fields

Every field is data the host reads; no field changes what another means.

| Look | |
|---|---|
| `color` | flat tint, linear r,g,b (convert sRGB values first) |
| `colorParam` | a `type: 'color'` param whose `#rrggbb` tints the link live: a primitive's albedo; on a `mesh` link with one lamp, that lamp's material (unlit base and lit colour, the push button's `Button color`); else the link's single `material` override |
| `finish` | one of the host's textured materials, the set a drawn submesh also takes: `'frame'`, `'guard'`, `'leg'`, `'bolt'` (steel), `'gapfill'` (steel tinted white), `'roller'` (brushed roller metal, spun by the conveyor's speed), `'belt'` (scrolling fabric), `'tread'` (steel tread plate: stairs, access platforms), `'deck'` (solid concrete: an equipment platform), `'mesh'` (plain dark neutral). `tread` and `deck` tile per metre from the box's resolved size (in world space on a drawn submesh). A finish is only a look; it switches on no behavior |
| `finishParam` | an `'enum'` param whose option values are finishes; the instance's choice is the link's finish, and `finish` shows when the param holds none (the platform's "Deck surface"). `check-part` flags an option that is not a finish |
| `metalness`, `roughness` | render-only PBR (0..1) for a `color` / `colorParam` primitive |
| `opacity` | idle translucency `(0, 1]` for a `color` / `colorParam` primitive, so it reads as a schematic cue (the spawner's drop cone, a light-curtain plane). Not a lamp's `opacity`, which is a lit lens |
| `outline` | wireframe edges drawn over a primitive's fill, linear r,g,b (gives a translucent link definition) |
| `hidden` | not drawn, still solid |

| Body | |
|---|---|
| `collision` | omitted = the shape's default (`box` / `cylinder` collide as themselves; `mesh`, `cone`, `frame`, `label`, `leg` do not). `'none'` = drawn but never solid (a roller bed's rollers, where the conveying box is the real surface). `{ box: [x, y, z] }` on a `mesh` or `frame` link = collide as that box, centred on the link origin (on a `frame`, a solid whose look comes from `geometry()`) |
| `conveys` | this box is a conveying surface: cargo on its top rides at the velocity the behavior sets. Under a jointed parent it follows the joint and carries its cargo along, so a vertical lift is a `conveys` deck on a prismatic joint. Turned in the part, it is built at that turn and runs on its local +Y face: a side belt is a `conveys` box stood on its edge (it grips only on a firm squeeze, since a contact up to 2 mm deep on a sideways face is ignored as a seam snag) |

| On a conveyor (`'left'` is −Z; the bed runs along +X) | |
|---|---|
| `sideGuard: 'left' \| 'right'` | a side guard wall: a conveyor butting that side opens a gap in it, a flush side merge retracts it, it merges with a collinear neighbour's guard into one wall, and it is frictionless so cargo slides along it |
| `sideRail: 'left' \| 'right'` | a below-deck side rail: retracts at a flush side merge, but a butting neighbour never opens it |
| `bed: true` | part of the bed, so cargo sliding across it from the conveying surface (a diverter kick, a load leaving a turntable lane) does not snag on its edges |

| On a deck (the link half of [part-snap-cuts.md](part-snap-cuts.md)) | |
|---|---|
| `notchable: true` | the walking deck: its box sets the deck's extent, and a neighbour's `notch` cuts a stairwell through it |
| `onEdge: 'posX' \| 'negX' \| 'posZ' \| 'negZ'` | a perimeter link (post array, rail, toe board, infill wall) on that edge: a neighbour that meets the edge and `opens` it splits its boxes and skips its posts over the gap |
| `anchor: 'floor'` | when a connection lifts the part flush onto a deck, this link stretches back down to the floor (a flight's newels and risers) |
| `dropWhenMounted: true` | while that connection holds, this link (mesh and collider) is left out and the deck takes its place (a flight's own top landing) |

| Sensing and cargo | |
|---|---|
| `beam` | a sensor ray the behavior reads with `ctx.sense`. Cast from where its link stood at the end of the last step, so an eye on a moving link moves with it ([stretch-wrapper](../examples/parts/stretch-wrapper/)'s carriage eye). It sees cargo, the walking pilot, and a box the pilot carries. Length is the static `range`, or the `number` param named in `rangeParam` (what it senses and draws; a mount's `fitRangeParam` usually names the same one). `showParam` names a boolean that hides the drawn line. The host reads no param by its name: a param called `maxRange` does nothing until a beam names it. `axis` is the link-local direction (default +Z); `tint: 'hit'` colours a blocked beam with the cargo's tint instead of red (the colour sensor) |
| `zone` | a cargo volume for `ctx.zone` / `ctx.despawn`. Never counts the pilot or a box the pilot carries |
| `loadCell` | this box link is a weighing platform, read with `ctx.weight` in kg. The host measures the force from the physics: each body resting on the link and everything stacked on it, at its own mass and with its vertical acceleration, so a landing or a lift starting reads high for a moment. A load on the link alone counts in full, even hanging past its edge; one that also rests on something else (a case crossing onto it, a pallet bridging two scales) is shared by where its centre of gravity falls between the two. Works on a `conveys` deck (a weigh belt) or a plain solid box (a platform scale) |
| `grip` | a gripper link's pickup volume: `{ zone: { size, offset?, sizeParams? } }` (an oriented box in the link's frame) or `{ radius, radiusParams? }` (a reach past the link's extents; default 0.2 m). Any link can be commanded to grip; this sizes what it takes. Add `forks: { spread \| spreadParam, bladeWidth, bladeThickness }` for a fork gripper whose blades run along the link's +X; taking a pallet through a face its blades don't fit is reported on the part ([agv](../examples/parts/agv/)) |

| Lamps | |
|---|---|
| `lamps` | `[{ emissive, offColor?, name?, material?, opacity?, param? }]`, each a `ctx.lamps` entry. `emissive` is lit, `offColor` dark (default: the host's dark neutral on a primitive, the material's own colour on a mesh). `name` defaults to the link's and is unique across the rig. A primitive link carries at most one, as its own material, so it takes no `color`. On a mesh link each names the remapped GLB `material` it lights. `opacity` makes the lit state a translucent lens; `param` names a boolean that lights it at rest |
| `squash` | `{ amount, lamp? }`: a mesh link compresses along its local Y while `lamp` is lit, anchored at its rim (suction cups collapsing as the vacuum grips). A `geometry()` submesh uses `MeshPart.squash`, as the six-axis EOAT's cups do |

| Layout and motion | |
|---|---|
| `offsetParams` | param-driven placement (a hinge at `±length/2`) |
| `rotationParams` | param-driven turn, per Euler axis in radians (a splay of `angle` degrees is `scale: π/180`); not with `quat` |
| `showParam` | a boolean param; the link exists (mesh and body) only while true. Works on arrayed links (zero instances), as with the platform's railing and support toggles. `'param=value'` names an enum param instead: the link exists only while it is that value (an imported robot's own hand, `'tool=hand'`) |
| `array` | repeat the link: `count` (a param name) + `step` (optionally `centered`; `stepParams` makes a step axis track a param); or `distribute` along a span (`spanAdd` lengthens it past the param, so a railing just outside a deck reaches the corner; `worldPhase` pins copies to the world pitch grid so butted beds align); or a `grid` crossing two param-driven axes into an X×Z lattice (a pitch per axis, or a fixed `maxSpacing`). `grid` works on a `mesh` link too. `omitFirstParam` / `omitLastParam` name booleans that drop the end copy of a 1-D array, so butted barriers don't double a post. `pitch` fits round(span ÷ pitch) copies exactly `pitch` apart (span = `spanParam × spanScale + spanAdd`, plus `param × scale` for each of `spanTerms`; at most 1024 copies), the count for carriers on a loop. `posable: true` lets the behavior move each copy ([Rows of moving carriers](#rows-of-moving-carriers-posable-arrays)) |
| `aim` | a two-point look-at (hydraulics that stay connected as a parent moves) |

More fields, each documented in [`manifest.d.ts`](../packages/part-sdk/manifest.d.ts):

- A `sizeParams` / `offsetParams` entry (and a joint's `minParam` / `maxParam`) is `param * scale + add`, with
  optional `min` / `max` clamps for a floor or ceiling the linear map can't express (a corner section that must
  stop at the centreline on a narrow lane). `mulParam` multiplies by a second param first (the chain transfer's
  deck width = `chains` × `distance`). Entries for one axis apply in order, each replacing it, unless it says
  `plus: true`, which adds its value instead: an offset at `length/2 + gap` is a `length` entry, then a `gap` entry
  with `plus`. A joint limit and a leg's `frameDepthParam` hold one ref, so they take no sum.
- `leg` is `{ spanParam, widthParam, standParam, frameDepth, frameDepthParam?, arc? }`: a trestle row along the
  span, its height tracking the stand param; `arc: { radiusParam, sweepDeg }` fans it round a curve.
- `label` takes `size: [w, h]` (m, default 0.05 × 0.05) and `color` (the text, r,g,b 0..1, default black).
- The rig takes `inclineParam` (a degrees param that tilts the whole bed, legs regrown to the floor) and
  `maxInclineDeg` (its clamp, default 30).
- `geometry: { kind: 'cargo', cargoKind: 'box' | 'pallet' | 'tote', size }` makes the part cargo (one dynamic body
  on the built-in cargo pipeline), as [box](../examples/parts/box/) and the Containers library's
  [tote](../libraries/containers/tote/) do.
- **Cargo with its own shape:** a top-level `cargo: { friction?, massParam?, colorParam? }` on a `rig` makes the rig
  one dynamic body, as the [drum](../libraries/containers/drum/) does ([cargo-bodies.md](cargo-bodies.md)). Its collider is
  the rig's colliding links at rest: a box link is a box, and a cylinder link stays round, so a drum on its side
  rolls. Links with `collision: 'none'` are drawn only (the drum's hoops and rim). It draws as its own rig, one
  instanced batch per material for every body of the same shape. The colour param (`colorParam`, default `color`)
  tints the links that use it per body; other links keep their own colour. The rig has no joints, and its colliding
  links' bounds are centred on the origin, as every cargo is. Mass comes from `massParam` (default `mass`, else
  10 kg). A Spawner whose Product is the part spawns it as its shape.
- **What cargo is to the machines around it:** `cargo` also takes `forkPockets` (forks are checked against a block
  pallet's channels at its footprint), `heavy` (it bears loads: a firmer solver, and never counted as dropped),
  `loadBase` (a wrap starts from it and it anchors a unit load), `separateContacts` (a hollow body standing on a foot)
  and `nestDepth` (another of its shape set on it sits this many metres lower). A plastic pallet is a rig with
  `cargo: { forkPockets: true, heavy: true, loadBase: true }`. The built-in pallet and tote have these by kind
  ([cargo-bodies.md](cargo-bodies.md)).
- A top-level `thumbnail` (a data URL) is the catalog card's picture.
- A top-level `category` is the catalog tab the part is listed under. `Equipment`, `Devices`, `Products` and
  `Structure` match in any case. Any other name (up to 64 characters) gets a tab of its own after those four, and
  names that differ only in case share one. A part with no category is Equipment. `check-part` warns when a name is
  a letter or two off a standard one (`Device`), since that makes a separate tab.

A roller bed draws its rollers in `geometry()` on the grid `ctx.deltas` hands it; that is how
[roller-conveyor](../examples/parts/roller-conveyor/part.js) skews its bank so cargo tracks across the bed
and squares against a side guard. See [sdk-geometry-flexibility.md](sdk-geometry-flexibility.md).

**A gripper lifts every cargo body inside its volume**, each held at its own captured offset, so the group
moves rigidly (a palletizer head taking a formed layer, a fork carrying a pallet and its stack). There is no
single/multi-pick switch: `grip.zone` is how you say how much the tool holds. Declare a zone on any gripper
wider than what it grips. The `radius` sphere (measured to the box surface, so a cup that brushes a case
still seals) suits a tool no bigger than one load; on a plate it would lift whatever stands beside the target.
Use the zone's `offset` when the tool engages away from its frame: the AGV's volume sits 1.1 m out on the
tines. A pallet's collider is solid, so the tines never enter it. `forkPockets` only checks that the fork spread
fits the face.

### Tier 2: `geometry(g, params, ctx)` (procedural)

Use this for shapes a rig can't express (a belt lofted along a bent path, an arc bed). It is a pure function
from params to meshes, rerun on a param edit and never per tick.

Basic ops: `g.sweep(profile, path)`, `g.fillet`, `g.arc`, `g.box`, `g.merge`, and raw `g.surface()` as the
escape hatch.

Solid-shape ops for engineered hardware (the [push-button](../examples/parts/push-button/part.js) and
[blade-stop](../examples/parts/blade-stop/part.js) are built from them):

- `g.bevelBox(size, center, bevel, square?)`: a machined block, edges chamfered except where it sits flush.
- `g.lathe(profile, { axis, segments, smooth })`: anything turned (a knob, bezel, roller, or a hex bolt with
  `smooth: false`), from `[radius, height]` pairs walked with the outside on your right. `center` moves the
  axis; `startAngle` turns the facets.
- `g.extrude(outline, from, to, { axis, holes, bevel, square })`: a plate from any outline, with holes;
  `square` lists edges left unchamfered.
- `g.transform(desc, { scale, rotate, translate })`: author in a drawing's units and orientation, map once.
  `rotate` is a unit quaternion `[x, y, z, w]`.
- `g.loft(sections, path, { caps, frame })`: a sweep whose section changes (a hopper, funnel, tapered arm,
  round-to-square duct). Give one section per path point, or two (start and end, blended). Every section has
  the same point count, and point j joins point j of the next, so a round-to-square transition samples its
  square at the circle's point count, starting at matching corners. A section shrunk to one repeated point is
  a cone tip.
- `g.subtract(solid, ...cutters)`: cuts closed solids out of a closed solid (a bore, keyway, bolt holes, a
  slot, a pocket). The cut is lined in the solid's material, a lathed surface stays round, and a cut solid can
  be cut again. Every input must be closed and outward-facing (a sweep or loft needs `caps` and a
  counter-clockwise section), or it throws. Make a through-cut a little longer than the wall.
- `g.cylinder(radius, height, center?, { axis, segments })`: the closed cylinder a bore needs.

These ops always produce closed, outward-facing solids, flat where faces meet and round around a lathe.

Sweep options: ends are open unless you pass `{ caps: true }`, which closes each with the section (concave
too). Cap anything that visibly stops (a guard, a frame rail), or its end shows as a hollow tube. A sweep holds
its section level, which suits a deck or a spiral chute; for a path that turns vertical (a pipe bending into a
riser), pass `frame: 'transport'` so the section is carried round the bend.

A hub with a 20 mm bore and a keyway:

```js
g.subtract(
  g.lathe([[0, 0], [0.09, 0], [0.09, 0.03], [0.06, 0.05], [0.06, 0.12], [0, 0.12]], { segments: 40 }),
  g.cylinder(0.01, 0.3, [0, 0.06, 0]),
  g.box([0.006, 0.3, 0.015], [0, 0.06, 0.0125]),
)
```

For a painted look with no texture file, give a package material a `pattern` instead of an `albedo`:

```json
{ "id": "hazard", "pattern": { "kind": "stripes", "colors": [[1, 0.55, 0], [0.015, 0.015, 0.015]], "angle": 45 },
  "triplanar": { "space": "object", "scale": 4 } }
```

paints hazard stripes, four repeats per metre. `kind` is `'stripes'` (with `ratio`, the first colour's share,
and `angle`: 0, 45, 90 or 135) or `'checker'`; colours are linear r,g,b. Pair it with `triplanar` unless the
pattern should follow the mesh's UVs (one repeat per UV unit); the builder ops' UVs are not in metres.

Return `MeshPart`s with a `finish` (host material) or a package `material` id, `colorParam`, a `collision`
channel, `instances`, and `lamps: [{ name, emissive, offColor?, opacity? }]` (spelled like a link's, at most
one, since a submesh is one material). A lamp lights when the behavior sets `ctx.lamps[<name>]`; with a
`colorParam`, that param sets both the unlit colour and the glow (the
[push-button](../examples/parts/push-button/part.js)'s cap).

#### Things that move at a drive speed

Two animation channels work on any rig `geometry()` submesh. They run while the sim runs, at the speed the
behavior reports (`ctx.report`, so a program-commanded speed drives them; else the param of that name), and
hold still when it stops. Leave `speed` out on a conveyor and it is the conveyor's `speedParam`; a part that
is not a conveyor must name it (`speed: 'fanSpeed'`) or it is refused when built.

- `scroll: { tilesPerMeter, speed? }`: the submesh's copy of its material's `albedo` moves along U. Lay U out
  in texture tiles along the direction of travel (`u = metres × tilesPerMeter`); the pattern travels at
  `speed` m/s toward +U. For a chain's links, a belt's weave, a cable carrier.
- `spin: { axis, radius, center?, speed? }`: the submesh turns about `axis` through `center` at
  `speed ÷ radius` rad/s, right-handed for a positive speed. For a pulley, fan, sprocket: the mesh itself turns,
  teeth and all. On an `instances` bank, every instance turns about its own axis (a roller bed). The host turns
  the material's grain rather than the geometry, which adds no per-frame work, so a bank's shape never turns
  (draw toothed wheels as submeshes of their own), and sets two rules:
  - lay the template's axle along local Z through its origin (`axis` must be `[0, 0, 1]` or `[0, 0, -1]`;
    `check-part` reports anything else);
  - draw it in a material whose grain can turn: finish `'roller'`, or a package material with
    `triplanar: { space: 'object' }` (`check-part` reports a bank in anything else, which holds still). The
    grain is sampled in the template's own units, so a template at another scale shows a coarser or finer grain.

  A roller bed carrying cargo toward +X turns about `[0, 0, -1]`.

A third channel follows a lamp: `squash: { amount, lamp }` compresses the submesh along its link's Y by
`amount` (0..1] while the lamp is lit, anchored at its lowest point, and eases back when the lamp goes dark or
the sim stops. On an `instances` bank of suction cups the whole bank collapses about the rims, so the lips stay
on the load ([six-axis-robot](../examples/parts/six-axis-robot/part.js)). Rig parts only, not with `spin`.

An animated submesh never merges with its twins across parts. Examples:
[chain-transfer](../examples/parts/chain-transfer/part.js) (scrolling chain) and the roller parts, whose
tubes, axle stubs and drive bands come from [_shared/rollerBed.js](../examples/parts/_shared/rollerBed.js), joined into
[roller-conveyor](../examples/parts/roller-conveyor/part.js),
[curved-roller](../examples/parts/curved-roller/part.js),
[spur-roller-conveyor](../examples/parts/spur-roller-conveyor/part.js) and
[turntable-conveyor](../examples/parts/turntable-conveyor/part.js).

#### Making a submesh solid: the two `collision` channels

A `geometry()` submesh is decorative until it declares a channel. You say what is solid; the host decides how:

| channel | collider | for |
|---------|----------|-----|
| `collision: 'box'` | the submesh's local AABB as a yaw-placed box | boxy structure (side guards, a machine housing). A guard wall also declares `sideGuard: 'left' \| 'right'`, which is what a cross-part guard merge spans; a conveying belt builds its guards path-aware instead (per-run walls split at openings) |
| `collision: 'hull'` | a convex hull of the submesh's vertices | anything an AABB misrepresents: a round pillar, a ramp, a chamfered plinth. The submesh must be convex (split a concave solid into several submeshes). Never merged, so don't use it for guards |

A hulled submesh past the host's hull-point cap falls back to its AABB box, so hull the simple shape, not a
dense visual mesh.

A solid's surface takes a `friction`, on the scale a conveyor's `frictionParam` uses (0 to 2; the cargo's own friction
combines with it): a slide chute's plate, a rubber stop pad. Without one, a `'box'` has none, so cargo slides along it
like a wall, and a `'hull'` has 0.5, which a standard carton only slides down past about 27 degrees. A rig link takes
the same field (its default is 0.6). A side guard never has friction, and a `conveys` deck takes its conveyor's
`frictionParam`, so `check_part` refuses `friction` on either.

```js
// a slide chute's plate: a carton starts sliding at about 10 degrees
parts.push({ desc: plate, collision: 'hull', friction: 0.06, material: 'steel' })
``` Example: [shape](../examples/parts/shape/behavior.ts), whose box/cylinder/cone/ramp
primitives are each one convex, hulled submesh.

#### Repeated hardware: `MeshPart.instances` (instanced templates)

When a submesh is many copies of one small shape (leg pieces, bolts, railing posts, rack uprights), give the
`MeshPart` `instances: InstanceTransform[]`. The host draws its `desc` as a unit template at each
`{ position, scale?, quaternion? }`: one draw call regardless of count. Instancing is keyed on geometry
content, so the same template across different parts merges into one pool. Keep `desc` a unit shape and put
each piece's size in its `scale` (as the built-in legs' `unitBox` does) so differently sized uses share it.
It is render-only, on the part root. (Tier 1's `array` repeats a primitive; `instances` is the Tier 2
equivalent for arbitrary geometry and transforms.) Example: [bollards](../examples/parts/bollards/behavior.ts),
one unit-cylinder template drawn as a row of scaled posts.

**Never mirror an instance with a negative `scale` component.** It reverses that copy's triangle winding, so
with the host's double-sided materials it is lit as if seen from inside, visibly a different colour from its
twin, and nothing warns. For the far side of a symmetric piece, anchor it at its far end with a 180° turn
instead; for a constant cross-section extrusion that is the identical solid and keeps one pooled template. The
belt conveyor's `steelPiece` does this, and
[instanceMirror.test.ts](../src/render/parts/instanceMirror.test.ts) checks the whole catalog.

An instance may carry `data: number[]`, per-instance values the host interprets per finish (never the
transform). Only `finish: 'belt'` banks read it: `[uMul, uAdd, vMul?, vAdd?]`.

- The u pair (metres) rebuilds belt-loop arc length from the template's local `u` (`u·uMul + uAdd`). The
  straight belt conveyor's scrolling bed is two pooled unit templates (a 1 m strip and a drum-wrap band) with
  the weave continuous across pieces; see the bed section of
  [belt-conveyor](../examples/parts/belt-conveyor/part.js).
- The v pair (default `[1, 0]`) remaps cross-belt `v` (`v·vMul + vAdd`) for an instance that is a slice of the
  belt width, as the spur conveyor's staircased strips do
  ([spur-conveyor](../examples/parts/spur-conveyor/part.js)).

#### Dressing a rig link: `MeshPart.link` (Tier 1 × Tier 2)

A `kind: 'rig'` part's `geometry()` may tag a `MeshPart` with `link: '<rigLinkName>'`; the host attaches it to
that link, so procedural geometry follows the link's joint and rest pose. Untagged submeshes sit on the rig root.
Rig links still own their colliders, so `geometry()` here is render-only. The usual pattern is a `hidden` box
link (collision only) dressed by a procedural mesh. The SDK **Fence** and **Safety Gate** do this: a hidden
collision box (a full-span barrier, or a swinging leaf) plus a wire-mesh grid and e-stop from `geometry()`,
with the leaf's mesh tagged `link: 'leaf'` so it swings with the hinge. See
[fence](../examples/parts/fence/part.js) and [safety-gate](../examples/parts/safety-gate/part.js).

`hidden` hides a link and everything attached to it, so the dressing can't go on the hidden box itself. For a
solid that moves and carries its own look, make the link a `frame` with `collision: { box: [x, y, z] }` and tag
the mesh with that link: one link, one pose, and the collider and the look move together.

#### Rows of moving carriers: posable arrays

A sorter's slats and shoes, a slat conveyor's pushers, a bucket elevator's buckets: many identical solids, each
moving on its own, as many as the machine's length holds. Declare them as one array link with `posable: true`,
counted by the `pitch` form, and pose each copy from `step()`:

```js
// rig(): one link per kind of carrier, whatever the length; the offset is where the row stands at rest
{ name: 'shoe', shape: { kind: 'frame' }, offset: [0, 0.025, 0.34], collision: { box: [0.06, 0.05, 0.14] },
  array: { pitch: { axis: 0, spanParam: 'length', spanAdd: -0.04, pitch: 0.076 }, posable: true } }

// geometry(): the shoe's look, drawn once per instance and moving with it
parts.push({ desc: shoeBody, material: 'shoe', link: 'shoe' })

// step(): place every carrier on the chain, in the part's frame (the link's parent), as setSubPose places a link
const n = ctx.arrayCount('shoe')
for (let i = 0; i < n; i++) ctx.setSubPose('shoe', { position: [x(i), y(i), z(i)], rotation: [0, 0, turn(i)] }, i)
```

Each copy is a kinematic body moved like any posed link, so it pushes cargo. A pose places a copy where the same
pose would place the link itself, so the link's offset and the array form only say how the row stands at rest: on
a stopped part, and for any copy not posed this tick. Put the rest row somewhere sensible (a sorter's shoes home
along the top run) and pose in the parent's frame. `ctx.arrayCount` reads the count the host built for this part's params, so the script
never repeats the count rule. Things that ride a carrier and move against it (a shoe sliding across its slat) are
a second posable array with the same count, posed with the same index; a link can't hang under a posable array,
because it would follow the row, not one copy. All copies of an array draw as one instanced mesh.

A carrier with its own belt (a cross-belt sorter, a vertical conveyor's powered platforms) is a posable array that
`conveys`: each copy is a deck of its own, posed like any copy, and run on its own with
`ctx.setSurfaceSpeed(speed, link, i)` along the copy's local +X (`ctx.setSurfaceSpeed(speed, link)` runs every
copy). Cargo on a copy moves with the copy and along its belt. A copy given no speed this tick stands still, and
the part-wide `setSurfaceVelocity` / `setSurfaceSpeed(speed)` never run the copies. A single deck the behavior moves
with `setSubPose` (a shuttle's roller top) is a plain `conveys` link: it follows its pose and carries its cargo.
A `finish: 'belt'` submesh attached to a conveying array is each copy's belt fabric, and it scrolls at that copy's
speed; draw it as a box with its length along +X, the direction the deck conveys, so the weave runs the right way.
A posable array with a `grip` is a gripper per copy (a magazine's positions, each holding the load it stands
under): `ctx.setGrip(link, on, i)` closes copy `i` from where it stands, and it reports under `link#i` in
`ctx.measured.grips`.

A row whose length follows more than one param counts with `spanTerms`: a racetrack loop of two straights and two
half turns is `{ spanParam: 'straightLength', spanScale: 2, spanTerms: [{ param: 'curveRadius', scale: 6.2832 }], pitch: 0.6 }`.
A pose that turns about more than one axis at once (a tray tilting toward its chute while it follows a curve) is
easiest as a quaternion: `setSubPose(link, { position, quat: [x, y, z, w] }, i)`, composed from the heading and the
tilt, in place of Euler `rotation`.

A part whose copies keep moving while the scene is stopped (a chain that runs on its own) never settles, so the
stopped editor can't show a settled pose. It shows where the copies stood after 5 s of settling instead of their
rest row; a whole link that never settles still goes back to rest.

Publish the carriers' positions as tags rather than leaving the program to work them out. A program that
repeats the part's count rule, pitch and loop length to track cargo breaks the moment the part's geometry changes
(a size param, a count rule merged into one array). A real sorter's controller reads a carrier-number count and a
home flag from the machine, so give the part outputs that say which carrier stands at each station, and let the
program track cargo by carrier number.

#### Geometry that has to meet a neighbour: the third argument, `ctx: GeometryContext`

Params can't see where the part was dropped. For end-of-bed geometry that must line up with whatever is
butted against it, the host passes what it resolved:

```js
geometry(g, p, ctx) {
  var c = ctx || {}
  // c.deltas - the world-phase roller grid this bed landed on (part-local +X); c.pitch - its spacing
  // c.butt   - { head, tail }: does that end abut a collinear neighbour at all?
}
```

`deltas` comes from any link whose `array.distribute` is `worldPhase`. On the roller conveyor that is a
`frame` link that exists only to declare the grid, so the host can resolve it across butted beds. Two butted
beds share one world pitch grid, so `deltas` also locates the neighbour's rollers: the next grid line past your
head is `deltas[last][0] + pitch`. `butt` says whether anything is there at all. The shipped case is the roller
conveyor's skew transfer plate: it replaces the rollers the skew clips away, laps across a butt seam to the
neighbour roller's face, and stays flush at a free end
([roller-conveyor](../examples/parts/roller-conveyor/part.js)).

Every field is optional and `ctx` may be empty (a headless call passes nothing), so write the placement-free
geometry first and let `ctx` refine it. Stay deterministic: same `(params, ctx)`, same mesh.

### Snapping (`snap` in the manifest)

The manifest's `snap` declares how the part connects to others:

- **`mounts`** seats a device on a host surface (a sensor or diverter onto a conveyor guard), with `yOffset` /
  `outwardOffset` standoffs and `fitRangeParam` auto-fitting a beam range across the belt.
  - `accepts: 'face'` seats on the nearest vertical face of any part's footprint box. Every part advertises its
    four side faces, and the seat is 2-D: it slides along the face and in height with the drag, clamped to the
    face (a push button or HMI panel on a cabinet's flank; see
    [push-button/part.js](../examples/parts/push-button/part.js)).
  - `attach: true` soft-parents the device under its host on commit, so moving the host carries it (detach is
    the tree's "Unparent").
  - `mounts` is a list and every entry is tried. The best fit is taken, whatever the declaration order. A device that seats
    on several kinds of host (a guard rail, or flat on a bracket face) declares one mount per `accepts`.
  - `opens: true` on a mount onto `conveyorGuard` cuts the guard where it mounts (the diverter).
  - `face: 'in' | 'out'`: local +Z faces toward the host (a sensor's beam, the default) or away (a diverter's
    body, a wall-mounted button).
- **`track`** seats the part on a roller conveyor's bed, anchored to the roller grid (a blade stop rising
  between rollers). `fitWidthParam` fits its width to the host bed (times `fitWidthScale`), `targetLocalY`
  seats it above (or, negative, recessed into) the bed surface, and `lanes: { countParam, pitchParam? }`
  anchors N parallel lanes, each in a roller gap (the chain transfer).
- **`surfaces`** is the host half: a non-conveyor part advertises a mountable rail
  (`{ kind: 'conveyorGuard', lengthParam, widthParam }`) that a device's `mounts.accepts` matches, so a sensor
  can mount on a stand or bracket. See [part-snap-surfaces.md](part-snap-surfaces.md).
- **`tile`** tiles a part edge-to-edge with same-`group` parts (`{ group, lengthParam, widthParam, cornerFlush? }`):
  floor markings, decks. See [part-snap-edges.md](part-snap-edges.md).
- **`chain`** chains a linear part end-to-end with same-`group` parts
  (`{ group, lengthParam, reach, omitStartParam?, omitEndParam? }`): barrier collinear-extend and L-corner with a
  shared post. See [part-snap-chain.md](part-snap-chain.md).
- **`edgeMount`** seats a part on a host deck edge, which the host advertises as a `surfaces` entry of that
  `kind` (`{ accepts, alongParam, reach, outwardOffset?, facing?, at?, atParams?, fromFloor?, opens?, notch?, lift? }`).
  Facing `'along'` (the default) is a barrier on the rim. Facing `'into'` is a flight, ramp or ladder whose `at`
  point sits on the edge, standing on the deck's floor with `fromFloor` (the host fits that param so the
  contact reaches the deck; the deck's `surfaces` entry adds the `heightParam` it reads). `opens` cuts the
  railing where it meets the edge, `notch` holes a deck it passes through, `lift` raises it flush. The shipped
  stairs work this way; see [part-snap-cuts.md](part-snap-cuts.md) and
  [part-snap-edge-mount.md](part-snap-edge-mount.md).

[part-snap-connectors.md](part-snap-connectors.md) shows every kind as the connector it compiles to, the one rule
that ranks them (a part declaring several uses whichever fits the drop best), and the golden table any engine
change must keep unchanged.

**`flush: true`** is ambient face-flush for parts that get tiled: dragged near another part, the footprint seats
flush against that part's nearest face (90°-stepped orientation, slide and corner-flush along the face, height
untouched). With Shift-drag duplicate it makes rows fast; see
[rack](../examples/parts/rack/part.js). Flush engages within 0.75 m, so it belongs only on parts
bigger than that (a 5.4 × 1.1 rack, not a 0.6 × 0.4 box, which would jump flush from 0.7 m away).

A part with no snap declarations never snaps on its own. Users can still place any part against any face: during
a Shift+G reposition, holding **Alt** face-snaps the part onto the surface under the cursor (walls, flanks,
inclined faces at the picked height; X/Y/Z pick the alignment axis, Shift for negative; scroll rotates). So
declare `flush` only when tiling is the part's everyday gesture.

## Bring your own model (GLB)

A model becomes a working part as a rig (Tier 1) whose visible links are `mesh` shapes. In the browser,
**Import model…** on a rig node embeds it. Headless, follow the steps below. The per-field rules are the
`RigMeshShape` docs in [`manifest.d.ts`](../packages/part-sdk/manifest.d.ts).

### Formats

The quickest way in is **Import part** in the Parts dock (or a drop on it) with a model file: it makes a new part
named after the file and opens it at the file's import options. When a model replaces the only node of a part (a
new part, or one made by New part), the part is fitted to it: the model stands on the origin, a hidden `collider`
box link of its size is added, and `bounds` are set to its box. A part with other nodes is the author's arrangement
and is left as it is.

The app reads **GLB** (Draco-compressed is fine) and **STEP** (`.step` / `.stp`). **Import model…** converts
STEP to GLB: it reads the file's units, turns its up axis into +Y, and sets the model on the node's origin
(base at 0, centred across). It offers four choices first:

- **Up axis**: STEP records none, so it is preselected from the exporting program in the header (Y for
  SolidWorks and Inventor; Z for CATIA, NX, Creo, Solid Edge, Onshape and FreeCAD; Z when the file went through
  a converter). If the model arrives on its side, pick the other axis.
- **Detail**: coarse has about half the triangles.
- **Skip parts under N mm**: screws and washers, often a third of an assembly's solids.
- **Merge by colour**: a handful of meshes instead of one per solid. Turn it off to keep each solid as a named
  node you can split out.

A large assembly takes about 2 s per MB of STEP. Headless, `npm run import-model -- model.step` runs the same
conversion to `model.glb`, with the same choices as options (`--up z|y`, `--detail coarse`, `--min-part-mm <n>`,
`--no-merge`) and the up axis guessed from the header when `--up` is not given.

It also reads **USD** (`.usd` / `.usda` / `.usdc` / `.usdz`). A USD model is often several files: a model file
that is only an index of layers and textures in folders beside it. A `.usdz` holds them all. On the desktop,
picking the model file reads its folder with it. In a browser, which can read only the files it is handed, the
model file is checked first, and one that pulls in files that are not there asks for its folder (**Pick its
folder…**) instead of converting. The folder's model file is the USD file nearest its top (a choice is offered when
there are several). The reader composes the model as USD does (references, payloads,
variants as selected, overrides, instancing), takes its units and up axis from the file, and the import writes
one mesh per material, on the node's origin like STEP. The choices:

- **Detail**: reduced simplifies each mesh to about a quarter of its triangles. Models made for rendering are
  often far heavier than a simulation needs: a 2 m roller conveyor came in at 290k triangles (72k reduced), a
  cardboard box at 15k. Cargo spawned by the hundred needs reduced.
- **Texture size**: the longest side of each texture, 512 to 2048 px (1024 by default).

What it leaves out: physics values (mass, friction, colliders: give the part its own), animation, lights, and
geometry other than meshes and the basic shapes (curves, points). A model's own licence travels with it and the
import does not record it: one that asks for credit (CC BY) still does. The reader runs only in the app (the
browser or the desktop app), not in `import-model`; an agent uses `import_model`, which reads a `.usd` model file
with the layers and images under its folder. Convert anything else first:

- `.gltf` + separate files → `npx gltf-transform copy model.gltf model.glb` (in this repo's devDependencies).
- OBJ → `npx gltfpack -i model.obj -o model.glb` (also in the devDependencies).
- FBX → Blender (`blender -b -P` with an import + `export_scene.gltf(export_format='GLB')`; on Windows the
  binary is usually `C:\Program Files\Blender Foundation\Blender <version>\blender.exe`, not on PATH), or FBX2glTF.
- STL → the same, but an STL is one mesh with no nodes and no units. Split the moving pieces into separate,
  named objects in Blender first (nothing can be rigged otherwise), and check the scale.
- IGES → tessellate in a CAD tool (FreeCAD, CAD Assistant) and export GLB with the assembly's named parts.

### A robot (URDF)

**Import part > A robot (unzipped folder)…** takes a robot description folder (its `.urdf` or `.xacro` file and the meshes it
names) and makes a posable part of it, with no options to set. A browser's folder dialog lists no files, so the
folder itself is what to select. A `.zip` of that folder works too, picked in **Import part > A robot (.zip or URDF file)…** or
dropped on the Parts dock or the 3D view, and so does the folder dropped there. A zip may unpack to 200 MB at most. Each URDF link becomes a rig link and each revolute, continuous
or prismatic joint becomes a joint with the file's limits. A continuous joint gets ±180°. A fixed joint joins its
links without one. Joint value 0 is the pose the robot was described in. The links keep their URDF frames, so
nothing is re-expressed per link. URDF's +Z up becomes +Y by one turn on the root link. Each link's visuals go into
one GLB, a node per link, drawn by that link (`node`).

- **Meshes**: STL, COLLADA (`.dae`) and OBJ. `package://<package>/<path>` is matched against the picked folder by
  its longest tail, so the folder can be the package, its parent or a workspace. A relative path is resolved
  against the URDF file. A COLLADA file keeps its own colours, units and up axis, and an OBJ the colours of the
  `.mtl` file it names. A material painted with an image keeps it as a texture (a UR20's grey and blue are one
  image), shrunk to 1024 px on its longest side and stored once in the part however many meshes use it. STL, an OBJ
  without its `.mtl`, and the primitives (box, cylinder, sphere) take the URDF material's colour, read as sRGB.
- **Size**: past 150k triangles in all, the meshes are simplified toward that. Robot CAD exports are usually far
  finer than a simulation needs. A mesh whose normals are stored per triangle corner (nothing to share) gets them
  recomputed, smooth across faces that meet within 30°, which keeps its vertex count near a welded mesh's.
- **Collision**: each `<collision>` becomes a hidden link under its URDF link: a box or cylinder as itself, a sphere
  as the box around it, and a mesh as the box that bounds it in its own frame. So cargo meets the robot's links,
  coarsely. A link without `<collision>` draws and does not collide, as in URDF.
- **Tool**: the link named `tool0` (ROS-Industrial's flange frame), else one with `tcp`, `flange` or `ee` in its
  name, becomes the rig's `tool`, the point the pose gizmo drags.
- **A robot**: the part is a robot (see "Robots: let the host run the controller"), driving the joints between the
  root and the tool, with waypoints, jobs and the PLC tags in its Inspector. It carries the app's tools (vacuum
  plate or clamp gripper, picked in its Inspector's Tool), mounted along the frame's +Z (the outward direction of
  `tool0` and of a TCP frame). An arm whose URDF has a hand (a single sliding joint beside the arm) grips with that
  hand, its finger opening and closing with the grip, and its Tool offers "Its own hand" first. Picking another tool
  takes the hand off: the hand's links are `showParam: 'tool=hand'` (`robot.hand` in the declaration), and the app's
  tool mounts on the link the hand was fixed to. A hand that is part of the arm's last moving link cannot come off,
  so that arm keeps only its hand.
- **Ready pose**: an arm of revolute joints idles in a ready pose, also its Home waypoint: the tool pointing down in
  front of the base (+X) at 40% of the arm's length out and 15% up, with the elbow as high as it goes. The pose an
  arm was described in is often not a working one (a UR lies flat), and teaching by position starts from the idle
  pose, so this keeps taught poses elbow up. An arm with a sliding joint, or one no ready pose reaches, idles at 0.
- **mimic** becomes a joint `mimic`, so a gripper's second finger follows the first. A follower of a fixed or
  missing joint, or of one that follows another itself, moves on its own and is listed.
- **Not imported**: inertia, floating and planar joints (the link stays put), and Gazebo tags. Each is
  listed in a message after the import.
- **xacro** is expanded to URDF first (core/xacro.ts), as ROS's `xacro` tool does, so a description published only
  as xacro imports without ROS. Properties, arguments, macros (defaults, `^`, `*block`, `**content`), includes, `if`
  and `unless`, `insert_block`, `element` and `attribute` are read, with `$(arg)`, `$(find)`, `$(eval)`,
  `$(optenv)`, `$(dirname)` and `$(anon)`. A `${...}` expression is the part of Python descriptions use (arithmetic,
  comparisons, `in`, `a if c else b`, indexing, a YAML dict's keys as attributes), and `xacro.load_yaml` reads a YAML
  file in the folder, an angle tagged `!degrees` in radians as xacro reads it (UR descriptions write joint limits and
  mesh turns that way). `$(find pkg)` is the folder whose `package.xml` names `pkg`, so pick a folder holding every
  package the robot uses (often the repository it came from). Arguments take their defaults. When one names a model
  the folder lacks (a UR description's `ur_type` names none on purpose), the import asks which, from the folders that
  hold the rest of the missing file's path, and names the part with it (`ur (ur5e)`). An on/off argument whose other
  value adds or removes a link (Franka's `hand`) is asked about before the import, as a checkbox at its default; one
  that changes only what ROS reads beside the robot (a controller, a simulator plugin) is not. A switch turned on
  names the part too (`panda (hand)`). Not read: an include's `ns`,
  `$(env)`, and Python beyond that part; each stops the import with its reason.

A lone `.urdf` (from Import part's file picker or a drop) imports its primitives and lists the meshes it could not
find. A folder with several robot descriptions at its top asks which one to import; a xacro file that only defines
macros for others is not offered. The new part's joints can be driven
from the PLC with no code: select a joint's node and use the Joint section's PLC control.

### 1. Read the model

`npm run inspect-glb -- model.glb` prints the node tree: each node's name (what `hideNodes` / `keepNode` /
`node` take), its local transform, its materials (keys for a `materials` remap or a lamp's `material`), and
the world-space box of its subtree. Use it to decide which nodes move, where their pivot or travel axis is, and
where the part's origin goes (see the frame conventions in [Verify it headless](#verify-it-headless); a device
on a conveyor has its origin on the conveying surface). glTF is metres and +Y up; the part's length runs along
local +X.

### 2. Embed it

Add the GLB to the manifest's `assets` as base64 so the part stays self-contained:

```js
// node -e "…" > asset.json, then paste into manifest.json "assets"
const data = require('fs').readFileSync('model.glb').toString('base64')
console.log(JSON.stringify([{ id: 'model', mime: 'model/gltf-binary', data }]))
```

(`url: "/models/Foo.glb"` instead of `data` is for first-party parts that reuse an app-served file.)

### 3. Carve it into links

Use whole-scene refs (no `node`) and carve with `hideNodes` / `keepNode`. Carved pieces keep identical scale
and placement, so they line up without transcribing any transform.

```jsonc
"links": [
  // the static body: everything except the moving nodes
  // offset -0.2 on x: inspect-glb says the model spans x 0..0.4, and `bounds` is centred on the origin
  { "name": "base", "shape": { "kind": "mesh", "asset": "model", "hideNodes": ["BladeMiddle", "BladeCornerL", "BladeCornerR"] }, "offset": [-0.2, 0, 0] },
  // the joint lives on a transform-only frame; the moving mesh hangs under it at offset 0
  { "name": "carriage", "shape": { "kind": "frame" }, "offset": [-0.2, 0, 0] },
  { "name": "blade", "parent": "carriage", "offset": [0, 0, 0],
    "shape": { "kind": "mesh", "asset": "model", "hideNodes": ["BaseMiddle", "BaseCornerL", "BaseCornerR", "AirPressureL", "AirPressureR"] } },
  // what cargo actually hits: hidden primitive boxes sized off the inspect-glb boxes
  { "name": "bladeCollider", "parent": "carriage", "shape": { "kind": "box", "size": [0.05, 0.25, 2] }, "offset": [0.104, 0.123, 0], "hidden": true }
],
"joints": [{ "name": "lift", "link": "carriage", "type": "prismatic", "axis": [0, 1, 0], "min": -0.25, "max": 0 }]
```

The joint's 0 is the pose the model was authored in. This model has its blade up, so the stroke runs down
(`min: -0.25`): the behavior sets `lift` to 0 to block and -0.25 to retract. Check which way yours was drawn
from the `inspect-glb` boxes before choosing the range.

- `keepNode` keeps one node's subtree. A moving piece made of several sibling nodes needs `hideNodes` listing
  everything else, as above.
- Each node is drawn by one link, the nearest that keeps it. A node a `keepNode` link keeps is left out of the
  other whole-scene links of that asset without a `hideNodes` entry, and a piece kept from inside another piece
  (a bit inside a motor head) is left out of that piece too. `hideNodes` is for nodes no link should draw.
- A `node` ref (one node's mesh in its mesh-local frame, its transform reset) is for re-assembling pieces
  yourself, like a robot's links. You then transcribe each node's transform into the link's `offset` /
  `rotation`, the work carving avoids.
- For a revolute pivot away from the origin, put the frame at the pivot and the mesh under it at the negated
  offset, so the mesh stays put at rest and swings about the pivot.
- `fitHeight` rescales and re-centres the model (height, XZ-centred, underside at y = 0) when the vendor's units
  or origin are wrong. Carving still lines up, because it applies to the whole scene first.
- **Collision:** a mesh link is visual-only. `collision: { box: [x, y, z] }` on it is centred on the link
  origin, not the mesh: right for a mesh centred on its link, wrong for an off-centre vendor mesh. The reliable
  form is the one above: hidden `box` links placed from the `inspect-glb` world boxes.
- `bounds` is the footprint box `{ length, width, top, bottom? }`, centred on the origin in X and Z, spanning y
  from `bottom` (default 0) to `top` in the part's frame. Put the origin at the model's XZ centre: offset the
  top-level links by minus the centre `inspect-glb` reports (as above), or use `fitHeight`. `check-part`'s
  footprint and the model's box should then agree. If the model hangs below the origin (a device whose origin
  is the belt surface), give a negative `bottom` so a floor drop rests the underside on the floor. (A cargo box
  states its centred `size` instead.)
- When the origin is a mount point, give the box's centre with `centerX` / `centerZ` (m from the origin). When
  the part's size is a param, tie the box to it with `bounds.params`: each entry sets one field (`length`,
  `width`, `top`, `bottom`, `centerX`, `centerZ`) to a linear map of a param, with the same rule as
  `sizeParams` (`param`, `scale`, `add`, `mulParam`, `min`, `max`, and `plus` to add a second param's term). Snapping, selection and drop-rest then see
  the part at every setting. The [diverter](../examples/parts/diverter/rig.json) does both: its origin sits
  toward the guard it mounts on, its length and centre follow its stroke, and its bottom follows its stand
  height.
- A `face` handle takes over its axis: a param with `handle: { kind: 'face', axis: 'x' }` IS the footprint's length
  (`'z'` its width, `'y'` its height), whatever `bounds` says. So hardware past the body the handle sizes (a ramp, an
  indicator head) is outside the footprint. Leave the handle off a param that is not the whole extent, and tie
  `bounds` to it with `bounds.params` instead.

#### Carving in the editor

The Part Editor writes the same carving for you. Import the model onto a node (**Import model…**), then:

1. **Split into pieces** on that node lists the model's nodes. Click one to give it its own node, which keeps only
   that node (`keepNode`) from the same asset, at the offset that keeps it in place. The model node stops drawing
   it because another node keeps it. Nothing is imported twice.
2. To make several pieces move together, select the first split piece and click the others under its own
   **Split into pieces**. They become its children and follow its joint. A node inside a split piece (a bit inside
   a motor head) can be split out too, and the piece stops drawing it.
3. **Add joint** on the piece and set its type, axis and limits.
4. For a revolute joint, **Pivot** sets the point it turns about, in part coordinates, and **Pivot at centre**
   puts it at the centre of everything the joint moves. A node that draws something gets a `frame` inserted
   above it to carry the joint, with the same joint name, so the rest pose and the behavior script are unchanged.

5. **Test motion** moves the joint from Min to Max and back twice, then returns it to rest, without running the
   simulation or writing anything to the part. **Position** poses it by hand: drag across the field between Min
   and Max (0 to 360° for a spinning joint), or type a value. Both go back to rest when another node is selected.
6. **Spins endlessly** on a revolute joint makes it a wrapping servo (`servo.modulo` 2π, limits 0 to 2π) with a
   **Speed** in rpm (`maxVelocity`) and a **Spin-up time** (`maxVelocity / maxAccel`). A servo is posed by the host,
   so the behavior runs it with `ctx.servos[name].moveVelocity(...)` instead of `setJoint`. The panel shows those
   lines with the speed filled in. Test motion then turns it at that speed.
7. **PLC control** sets how a PLC moves the joint without code. **None** (the default) leaves the behavior to you.
   **Two positions** writes the whole behavior script: per joint, a BOOL `Command (to B)` tag in, `At A` and `At B`
   BOOL tags out and a **Stroke time** (s). The joint moves from A (Min) to B (Max) at a constant speed while the
   command is TRUE and back while it is FALSE. A joint whose limits follow a param (`minParam` / `maxParam`) can't
   take it, since the script writes Min and Max as numbers. On each placed copy the Comms fields name the PLC variables (`ToB`
   for the built-in PLC, `MAIN.ToB` over ADS). On a joint that spins endlessly the mode is **Spin** instead: a BOOL
   `Run` tag in (TRUE spins), an optional REAL `Speed (rpm)` tag in (empty: the copy's own Speed, up to the joint's
   Speed), and a BOOL `At speed` tag out; the host runs the servo. The script keeps its settings on an `// oip-panel` line and is
   written again when a joint's PLC control or limits change or its node is deleted or merged back, so edits to it
   are lost. Each joint's param keys are kept on that line too, so a placed copy's tag names stay bound when other
   joints change. A script you wrote is replaced
   only after a confirm, and setting every joint back to None gives the empty template.

A piece split under the wrong node can be fixed two ways. **Merge back into model** removes the piece with its
joint, so the model draws it again, and the pieces under it move up. **Delete** does the same for the node and
everything under it. **Parent** moves any node under another one, changing its offset so it stays where it is.

Lengths show in the scene's Length. Setting **Length** to **Millimeters (mm)** in Scene Properties shows them in
millimetres, which suits a machine's dimensions. The part always stores metres.

Pieces are offered only where they still line up: the nodes between the model node and the selected node must
carry plain offsets (no rotation, no param-driven placement).

### 4. Behavior and verify

Drive the joint from a tag as a primitive rig does (`ctx.setJoint`, gated on `tagDriven`; see
[Behavior](#behavior-the-ctx-surface)). Then run `npm run check-part` (the footprint should match the
`inspect-glb` whole-model size) and the rest of [Verify it headless](#verify-it-headless).

## Params

Params are declared in `definePart({ params: { … } })`. The Inspector renders them, instances override them,
and `ctx.params.*` reads them typed. A `ctx.params.<name>` the script reads that it does not declare is refused at
its line (with the near name, for a typo), since it would read `undefined` with no error; a `.js` behavior has no
types to catch it. The check reads the source, so a read through a destructured or renamed `ctx.params` is not seen.

| Type | Renders as | Notes |
|---|---|---|
| `number` | slider/field | `min` / `max` / `step`, `unit`. With both `min` and `max` it is a slider; without them it is typed or stepped, so give an unbounded size a viewport handle instead. `unit: '%'` stores a fraction (0 to 1) and shows a percentage. See units below |
| `boolean` | toggle | |
| `string` | text field | |
| `tag` | PLC tag picker | autocompletes from the scene's tags. Use it for every tag-name param. `dir`, `stType` and `unit` say what the program declares; see units below |
| `numberList` | typed grid | fixed `arity` per row; arrives as `number[][]` (waypoints, poses). See below |
| `color` | swatch | `#rrggbb`. `list: true` makes a row of swatches with add / remove; the value stays a `string` of `#rrggbb` entries joined by commas (`''` = none). `alpha: true` adds an A slider and makes the value `#rrggbbaa` |
| `enum` | dropdown | options can carry `rows` + `stamps: '<numberList param>'` to stamp templates |
| `partRef` | dropdown of the scene's parts | another part's id (`''` = unset; a dangling id is inert). Read the conveyor it names with `ctx.conveyorRunning(id)` (the spawner's interlock) |

`numberList` options:

- On a jointed rig whose joint count matches the row width, the grid offers **Capture Pose**: pose the arm with
  the viewport gizmo and it appends the posed joint row (revolute °, prismatic m).
- `columns: ['x m', 'z m', '°']` heads the cells.
- `rows: 1` fixes the row count (no Add / Remove; Capture Pose sets the row), for one multi-number value such as
  an idle pose.
- An arity-1 list with `rowsOf: '<numberList param>'` is a set of that table's row indices, shown as a checkbox
  per row (the robot's `blendWaypoints`).
- `rowNames: '<string param>'` names the rows, one per line (declare that param `hidden`). The grid edits names
  in place and every param pointing at the table shows them. Removing a row renumbers what points past it and
  marks what pointed at it missing; it never re-points it at a neighbour.
- `program: { names, ops }` makes the rows the steps of numbered programs, `[program, op, ...args]`, edited as a
  card of readable steps per program (the robot's `jobs`). Each op has a `code`, a `label` and `args` of kind
  `row` (a row of another table, picked by name), `number` (`unit` / `min` / `max` / `step`) or `choice` (an
  option may name a `tag` param, shown beside it). `arity` must be 2 + the most args an op takes. Report the
  running row with `ctx.report(key, row)` (-1 idle) and the Inspector highlights it during a run.

**Units.** Give the unit with `unit`, not in the label: `label: 'Speed', unit: 'm/s'` shows an `m/s` suffix,
and a length or speed field converts typed units (`5ft`, `600mm`; `394 fpm` in an m/s field stores 2.0). A
trailing `(m)` in the label is also read as the unit, but only when it is exactly that: with
`'Speed (m/s, − reverses)'` the field has no unit, no suffix and no conversion (typed `394 fpm` becomes 394).
Put extra explanation in `desc`. `unit: 'rpm'`, `'°'` and `'°/s'` show as suffixes without converting. A
length field displays in the scene's Length and a speed field in its Speed (a metre field reads inches in an
imperial scene, an `'FPM'` one reads m/s in a metric one); `step()` always reads the unit you declared.

A `tag` param's `unit` is the unit of the value on the wire, shown after its type in the field's badge
(`READ REAL m/s`) and in Device Tags, so a program declares and scales it right. Put it there, not in the label.
The scene's Units never convert it. A `setpointFor` tag that declares none takes its param's unit.

**Hidden params.** `hidden: true` makes a param storage rather than a field: resolved, defaulted, clamped and
persisted, but never shown. Use it for engine-owned state the user must not hand-edit (compare `rest`, which the
host writes but still exposes for pinning). The curved conveyor's `reverse` is one: a curve can't be rotated
180° to turn its flow around (that would swap inner and outer radius), so the snap flips this flag when it butts
two ends that both discharge into the junction. Reversing by hand uses a negative `speed`. Fold the two together
in `step()`:

```js
const speed = (running ? commanded : 0) * (ctx.params.reverse ? -1 : 1)
```

These declarations change how a field is edited without changing the value the part reads:

| Field | On | Does |
|---|---|---|
| `bits: 3` or `bits: '<number param>'` | `number` | a bitmask, one checkbox per bit (the stack light's lit tiers, `bits: 'segments'`) |
| `suggest: 'marks'` | `string` | suggests the product marks the scene's parts declare (`attribute: true` params) while typing |
| `product: true` | `string` | the value is a cargo part's package id (`'oip.tote'`): a dropdown of the cargo parts, and the project holds a copy of the part named |
| `settings: 'key'` | `string` with `product` | names a hidden `string` param holding the chosen product's settings as JSON; the Inspector shows the product's own params under the dropdown |
| `values: [{ value: 1, label: 'red' }, ...]` | `INT` / `DINT` `tag` | what each code means, listed on the field and by `npm run catalog` |
| `imperialUnits: true` | `boolean` | the part's units switch (true = imperial). The scene's Speed (Scene Properties) writes it on every part and carry each pair of values it switches between (same-label `number` twins, and `tag` twins through `setpointFor`); the Inspector never shows it. Pair it with `whenAbsent` |

**Groups and labels.** Follow the Inspector's conventions so every part reads the same:

- Every `tag` param goes in `group: 'Comms'`. A part that declares a PLC switch (`commsParam`) puts it there
  too, and while the switch is off the Inspector hides the rest of that section.
- Detail a plant program reads back but few scenes set (a conveyor's drive feedback) goes in
  `'Comms/Feedback'`. A nested section starts folded.
- A param that is only the state the device starts in, which Use then operates (a diverter's `diverted`, a
  gate's `open`), goes in `'Start state'`.
- `'Size'` for dimensions (`standHeight` stays top level; the host fills it), ordered Length, Width, Height.
- `'Guards'` for side guards and frame rails (`'Left guard'` / `'Right guard'`).
- `'Motion'` for speeds, travel limits and a moving machine's waypoint table.
- `'Colors'` once a part has two or more colours (a single colour stays top level).

A tag's label says what the signal means (`'Run tag (belt runs while true)'`), not its type or direction: the
Inspector shows `dir` + `stType` beside the field. The row shows the label up to a trailing explanatory bracket
(`Run Tag`) and the hover shows all of it, so put the name first. A bracket that starts with a unit keeps the
unit on the row (`'Speed tag (m/s)'`; `'Actual Z tag (m, down)'` shows `Actual Z Tag (m)`).

**`visibleWhen`.** `visibleWhen: { param: 'fpmUnits', is: true }` shows a param only while the named boolean
has that value: for one setting offered two ways with a switch (the conveyors carry a speed in m/s and one in
feet per minute, a speed tag for each, and only the pair in use shows). The switch may be an `'enum'`:
`is: 'waypoints'` for one mode, `is: ['position', 'follow']` for several (the Gantry's command and X/Y/Z target
tags). Each value must be one of the enum's options; `check-part` reports one that is not. Like `hidden`, this is
presentation only: both params are stored and resolved, and `step()` reads the one the switch selects. One
effect beyond the screen: a hidden tag param is not one of the part's signals while hidden, so the wiring check
does not count it.

**`whenAbsent`** (boolean params) is the value a part takes when its saved params lack the key; `default` is
what a newly placed part gets. Use it only when a new switch changes what existing numbers mean. The conveyors'
`fpmUnits` has `whenAbsent: false`, so a belt saved before the switch existed stays in m/s instead of reading
its `speedTag := 2.0` as two feet per minute; a newly dropped belt takes the scene's Speed, as any
`imperialUnits` switch does. An ordinary new param needs only `default`.

**Tag params.** Every `'tag'` param declares `dir` and `stType`, or the part is refused.

- `dir` is the part's side: `'in'` when the part reads it (a program drives it, like a run command), `'out'`
  when the part writes it (a sensor's state). It lets the wiring check find a tag nothing drives, or two parts
  fighting over one.
- `stType` is `'BOOL'`, `'INT'`, `'DINT'` or `'REAL'`. `DINT` is for 32-bit whole numbers (a count, a step
  number); like a REAL it travels in a double-word address (`%QD0`).

**`desc`** is the param's doc line, shown in the hover under the label. The host adds the range and default,
so say what those can't: what the value means in the part's frame, what a toggle suppresses, which way a sign
runs, which other param it overrides. One sentence; don't restate the label, and leave it out when the label
says everything. It is user-facing copy: plain hyphens, no em dashes.

```js
randomSize: { type: 'boolean', default: false, label: 'Random size',
  desc: 'Give each box a random size and IGNORE the three dimensions above. The random range is fixed by the part, not derived from them.' },
```

Every first-party part documents every visible param, enforced by `bundledPackageData.test.ts` with no opt-out
(`hidden` params are exempt). Write the description from the code, not from what the label implies.

**Handles.** `label`, `group` (`'A/B'` nests) and `handle`, a spatial gizmo binding, add editor affordances:

- `{ kind: 'face', axis, sign? }` puts a drag dot on a face for resizing (`sign: 1 | -1` picks one face).
  `bayParam` (a sibling pitch param, optionally gated by `bayGateParam`) snaps it to whole bays, as in the
  storage rack's per-cell resize.
- `{ kind: 'path' }` is a multi-segment belt path editor; `{ kind: 'arc' }` the curved-conveyor sweep/width
  gizmo. Both also give the part real snap ends, and both name the sibling params the host derives the bed
  from:
  - `path`: `widthParam` / `heightParam` (cross-width / surface height; defaults `'width'` / `'height'`) and
    `leftGuardParam` / `rightGuardParam` (boolean guard toggles whose walls the host builds path-aware;
    defaults `'leftGuard'` / `'rightGuard'`);
  - `arc`: `innerRadiusParam` / `widthParam` (defaults `'innerRadius'` / `'width'`), `innerGuardParam` /
    `outerGuardParam` (defaults `'innerGuard'` / `'outerGuard'`), and `endGap` (the straight lead-in the snap
    ends extend past the arc, to match the stub you draw) or `endGapParam: { param, scale?, add? }`.
- `{ kind: 'rigSize', link, axis, frameY? }` puts an orange size dot on a rig link's frame. It follows the posed
  arm (unlike a `face` dot on the static footprint) and drags the param along that link axis, with a tool
  outline when an `'x'` and a `'z'` handle share the link (the six-axis EOAT resize).
- `{ kind: 'flexPath', lengthParam, sections, maxHingeDeg?, infeedBrakeParam?, dischargeBrakeParam?, scissor? }`
  on a `numberList` of `[x, z]` control points is the flex conveyor's bed of hinged sections, dragged point by
  point ([flex-conveyor](../examples/parts/flex-conveyor/part.js) and the type's docs in `index.d.ts`).

**Guard openings.** Authored side-guard openings live in the `guardOpenings` param, a param kind of its own
whose key is fixed. Rows are `[start m, end m, side ±1/0]`, measured from the tail, on either tier.
Declaring it is the opt-in, and it turns on **guard-openings mode** (G with the part selected, or "Edit in
viewport" under the table): drag along a guard to cut an opening, drag its edge dots to resize. Who consumes it
depends on the tier: a `drawn` belt cuts its own guard ribbon in `geometry()` (rows arrive in arc length along
its path), while on a `rig` part the host splits the `sideGuard` links, folding the rows in with the
neighbour-derived openings so mesh and collider cut together. See
[roller-conveyor](../examples/parts/roller-conveyor/part.js) (rig) and
[belt-conveyor](../examples/parts/belt-conveyor/part.js) (drawn).

**Leg footing.** `rest: 'surfaceBelow'` marks a param the host fills with the drop height (what auto-grows
conveyor legs). A legged part may also declare a `legRests` numberList (`[x0, x1, dy]` rows, arity 3, default
`[]`) for per-leg footing. Where a platform deck crosses under the bed (or the bed overhangs the deck it stands
on), the host fills in the intervals of local X whose surface below differs from the part's floor plane (`dy`
metres above it; negative = down to the warehouse floor). Your `geometry()` places each leg's foot at
`-standHeight + dy` for the row covering its station and drops a leg squeezed under ~5 cm. Copy the
consumption from [belt-conveyor/part.js](../examples/parts/belt-conveyor/part.js) (`restDyAt` /
`placeLeg`).

**Spur conveyors** (a splayed bed merging onto a line at an angle) are declared on the length `face` handle:
`{ kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg', sideGap? }` names
the params that splay each end face (degrees about +Y; centre origin: front face `x = +L/2 + tan(front)·z`). The
host then gives the part the built-in spur's merge behavior: angled snap ends (the splayed face mates flush on a
straight conveyor's side and opens its guard there), a parallelogram footprint and collision hull, and, if the
part declares a `guardExtents` numberList (`[side ±1, backX, frontX]` rows), host-fed rail/guard end overrides
so the frame reaches the host's wall across the junction (render and collision). `sideGap` is the clearance off
the host's bed edge at a side merge; the default (2 × the frame-flange gap) suits both shipped spurs. Override
it only for a bed with hardware past its mated face, and keep it well under the 0.15 m contact tolerance the
opening and extents resolvers use, since a large gap leaves a visible dead strip and brings the merge close to
dropping. Copy the shape from [spur-conveyor/part.js](../examples/parts/spur-conveyor/part.js).

`guardExtents` isn't spur-only. A straight or belt conveyor that declares it gets the same rows when its end
merges flush onto another conveyor's side; there the overrides retract its rails and guards to the host's outer
wall plane (the host's frame never opens), so the frames butt instead of interpenetrating. Copy the consumption
from [belt-conveyor/part.js](../examples/parts/belt-conveyor/part.js) (`sideArcSpan`).

At such a junction, a part that also declares a hidden `guardMitres` numberList (`[x, c, side ±1]` rows) is told
how to cut each guard end that meets the other conveyor's guard: at outward distance `d` from the guard's inner
face, the end at plan-local `x` sits `c·d` further back. Both guards cut on one shared plane, so the corner
closes like a picture frame. It is visual only (colliders keep square ends; cargo meets only the inner faces),
and rows arrive on opening ends and extents ends alike. Its twin `railCuts` (same rows, mover ends only) fits the
frame rails: since the host's frame never opens, a mover's rail is cut to stop against it (the wall on the host
frame's outer face, the top flange a flange width further out), with `c` the slope of that face across the rail
(0 at a square T, where only the flange steps back). Copy the helpers from
[_shared/guardMitre.js](../examples/parts/_shared/guardMitre.js). A rig guard or rail box needs neither: the host
cuts it.

**Facts the host fills in.** A part never sees the scene, so the host works out what its surroundings mean for it and
hands each fact to a `drawn` part as a numberList param of a fixed name. Your `geometry()` reads it, and the sim
builds the part's colliders from the same params, so the fact reaches collision as well as the mesh. Declaring the
param is how a part takes the fact. Leave one out and the part still loads, but that fact never reaches it: a
diverter's arms run into a solid guard, or a sensor beam passes through one. `npm run check-part` warns about each
fact your part's own declarations say it needs and it doesn't take
([src/core/parts/hostFacts.ts](../src/core/parts/hostFacts.ts)). Every row is arity 3, and every param but
`guardOpenings` is `hidden: true`, since the host overwrites it.

| Param | Rows | What the host puts there | Taken by |
|---|---|---|---|
| `guardOpenings` | `[start, end, side ±1/0]` | a belt's openings, in arc length: authored ones and those a neighbour's end or a diverter makes | a belt with guards |
| `guardGaps` | `[x0, x1, side ±1]` | where it opens a straight or spur bed's guards (a diverter mounted on one), in local X | a straight or spur with guards |
| `guardHoles` | `[x, y, side ±1]` | where a sensor beam crosses a guard (a curve's `x` is its arc angle) | any conveyor with guards |
| `guardExtents` | `[side ±1, backX, frontX]` | where rails and guards stop at a side merge: the host's wall plane | a straight, spur or belt |
| `guardMitres` | `[x, c, side ±1]` | how a guard end at a junction is cut | a conveyor whose guards meet another's |
| `railCuts` | `[x, c, side ±1]` | how a rail end is cut to stop against the host's frame | a straight, spur or belt with rails |
| `legRests` | `[x0, x1, dy]` | per-leg footing over a platform crossing under the part | a legged part |

A spur takes end joins only (it is itself the merge), so no conveyor end opens its guards. Only a device mounted on
one does, through `guardGaps`. Build each solid run of a gapped guard as its own `collision: 'box'` part, so the
collider stops at the gap as the mesh does: [_shared/guardGaps.js](../examples/parts/_shared/guardGaps.js)
(`guardGapsParam`, `guardGapRuns`), used by both spurs. A `rig` part takes none of these params: the host cuts its
guard and rail links itself.

## Behavior: the `ctx` surface

Besides `params` and the required `step(ctx)` (or `react(ctx)` in its place, below), `definePart` declares:

- `joints`, `grippers`, `lamps`, `servos`: typed name lists for `ctx.joints` / `ctx.grips` / `ctx.lamps` /
  `ctx.servos`;
- `interactive: true`: pilot-mode Use → `ctx.used()` (and `useParam`, below);
- `unit`: makes the part a unit load (see Product state in the table);
- optional `init(ctx)` / `dispose(ctx)`.

State a behavior keeps between ticks lives in variables at the top of the script (`let count = 0`), outside
`definePart`. They belong to one placed part: each instance runs the script's top level afresh, so two placed parts
never share one. There is no `ctx.state`.

### The `ctx` members

| Group | API |
|---|---|
| Time + pose | `dt`, `simTime`, `position`, `forward`, `heading()` |
| Motion math (pure) | `approach`, `approachAngle`, `approachVec`, `angleDelta`, `clamp`, `steer` |
| Conveying | `setSurfaceVelocity(v)`, `setArcSurfaceVelocity({ center, omega })`, `setSurfaceSpeed(s \| [s…])` (along each `conveys` link's own +X, re-read every tick for hinged beds; an array runs each deck at its own speed), `conveyorRunning(id)` (is the conveyor a `partRef` param names running?) |
| Articulation | `joints.name = rad\|m` (`setJoint(name, v)` for a computed name like `'h' + i`, which the typed bag refuses), `measured.joints` feedback, `setSubPose` (with an index, one copy of a posable array), `arrayCount(link)` |
| Servos | `servos.name` (a joint the manifest marks `servo`; `servo(name)` for a computed name): `power(on)`, `moveAbsolute(pos, { velocity, accel?, decel?, direction? })`, `moveRelative`, `moveVelocity(v)`, `follow(setpoint)`, `halt`, `stop` / `releaseStop`, `reset`, `home`; reads `position`, `velocity`, `state`, `inPosition`, `error`, `done(id)` / `aborted(id)`. See [Servos](#servos-let-the-host-run-the-motion) |
| Grippers | `grips.name = bool` (`setGrip(name, on)` for a computed name), `measured.grips` (true = actually carrying). If something takes the load out of a closed gripper (the walking pilot, a drag), it drops its whole load, reads false, and stays open until you command it false again |
| Mobility | `drive(forward, turn)` moves the live root; steer closed-loop off `position` / `forward` |
| Sensing | `sense(beam)` → `{ hit, distance, color }` (hits cargo and the walking pilot, whose `color` is a mid grey that reads as no colour), `zone(name, filter?)` → cargo count (never the pilot or a box it carries; `{ part }` counts one product, `{ kind }` one kind), `zoneAge(name, filter?)` → that cargo's summed age (s), `weight(link)` → kg on a `loadCell` link |
| Cargo | `spawn({ part, params, color, mass, offset, marks })` makes a product: the cargo part `part` names, as if placed, with `params` over its own and `marks` the facts it starts with (a label's code, a destination) ([spawner](../examples/parts/box-spawner/behavior.ts)). The other form, `spawn({ kind, size, ... })` (`kind` `'box'`, the default, `'pallet'` or `'tote'`), makes a bare body. At most 8 a tick, the rest dropped. `despawn(zone)`. See cargo conservation below |
| Product state | See below |
| Lamps | `lamps.name = bool` (`setEmissive(name, on)` for a computed name) |
| PLC tags | `readTag` / `writeTag` (BOOL), `readNumber` / `writeNumber` (INT/REAL), `rising` / `falling` edges |
| Ownership | `tagDriven(name)`: is the tag an attached program's output (a controller owns it)? |
| Interaction | `used()`: one-tick pulse on pilot Use |
| Reactive parts | `again()`: in `react`, call me on the next tick too |
| Readouts | `report(param, value)`: a param's effective value (the Inspector's live readout; see `setpointFor`); `display(name, value)`: a live caption for a `label` link's `textFrom` |
| Randomness | `rng()`: deterministic, seeded from the instance's params (identical params = identical stream; add a `seed` param to decorrelate) |

**Cargo is conserved.** A source spawns it and a sink despawns it (every despawned item counts as having left
the line). A machine that stores cargo and gives it back holds the real items with grippers, one per storage
position, and never despawns them to spawn stand-ins ([pallet-dispenser](../examples/parts/pallet-dispenser/)).

**Product state** acts on the cargo in a zone, applied after the tick. `mark` acts on every cargo body whose centre
is in the zone. `dress` and `join` act on "the load": the lowest pallet in the zone and everything resting on it
inside its footprint.

- `mark(zone, key, value)` leaves a fact on each of them (`scanned`, `wrapped`), read back by `marked(zone, key)` (a
  count) and by a beam hit's `marks`.
- `markHit(beam, key, value)` leaves the fact on the one body a beam hit this tick instead: the case a labeller's pad
  touched, the item a coder printed on. Put a short beam on the pad's face and only the case against it is marked.
- `dress(zone, { id, material, opacity?, upTo?, web? })` fits a see-through sleeve round the load in one of your
  package's materials (film, straps). `upTo` clips it at a height above your origin, and it only grows;
  `web: { link, offset, height }` draws the sheet paying out from a roll on that link.
- `join(zone)` makes the load one unit load: a single rigid body, every piece still drawn, counted and sensed
  where it stands; a gripper closing on any piece lifts the whole unit.
- **Product attributes**: a param flagged `attribute: true` on a cargo part (or a unit load) is authored and saved
  like any param, starts the run as that mark, is type-checked when a machine marks it, and reads out live in
  the Inspector.
- **Unit loads**: `definePart({ unit: { joinWhen?, dress? } })` makes the part a unit-load product type. Its scene
  children are the load (nothing inferred), it selects as one, and it starts a run joined and dressed as its
  params say ([unit-load](../examples/parts/unit-load/)). With nothing filed under it, a unit load with a
  `courses` param above 0 stacks the standard load itself (a 48 x 40 in pallet under courses of the
  0.6 x 0.4 x 0.4 case layer) as real cargo.

### `react`: a part that only answers its inputs

`step(ctx)` runs on every tick. A photo-eye, a lamp or a stop has nothing to do on most of them: it reads a beam or
a tag and writes the same answer as the tick before. Write such a part with `react(ctx)` in place of `step(ctx)`.
A part has one or the other.

The host calls `react`:

- on the part's first tick;
- on a tick where something it hands the part differs from the last call: a tag, a beam or zone reading, a click
  (`used()`), a measured joint, or a conveyor's speed if the part read one;
- on the tick after a call that asked for one with `ctx.again()`.

On every other tick it is not called, and what it last commanded stands: the tags it wrote, surface speeds, joints,
lamps, displays and outlines. A request made once (a spawn, a despawn, a mark, a log line) is made on the tick of
the call and not repeated.

```js
definePart({
  params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  react(ctx) {
    const present = ctx.sense('lens').hit
    ctx.lamps.led = present
    if (ctx.params.tag) ctx.writeTag(ctx.params.tag, present)
  },
})
```

Two rules:

- **While the part is timing or moving something of its own, it calls `ctx.again()` on every call.** A drive
  ramping to speed, a rack rising, an encoder counting travel: each needs the next tick, so it asks. `ctx.dt` is one
  tick's length, as in `step`. A part that forgets to ask stops moving, in the editor and in every test, which is
  easy to see.
- **A call does not mean something changed.** The host may call `react` on a tick where nothing the part reads is
  different (another part's tag changed the table it shares), so do not count calls as events. Detect an event the
  usual way, with `ctx.rising` / `ctx.falling` or by keeping the last value.

A part that reads a load cell (`ctx.weight`) or a zone's marks is called on every tick while it does. A part with
a servo is too: the host moves the servo.

A line of several hundred parts then costs what its busy parts cost. Measured on a 420-part sorter line, writing
the photo-eyes, chutes and sorter sections as reactive parts left out 77% of the part calls and took the step from
7.8 to 5.8 ms, with every value the parts and the PLC exchanged unchanged.

### A sensor on a watched PLC: show the PLC's value

A controller set to Watch only ([live-share.md](./live-share.md#watch-only)) reads the tags parts write from the real
PLC instead of writing them, so such a tag is driven too. A sensor or switch that shows its state (an LED, a pressed
cap, a swung gate) should then show what the real one reports, not what the simulator senses:

```js
const tag = ctx.params.tag
if (tag && ctx.tagDriven(tag)) ctx.lamps.led = ctx.readTag(tag) !== !!ctx.params.normallyClosed // the real eye
else ctx.lamps.led = present // what the beam sees
```

The first-party photo eye, push button, light curtain and safety gate do this.

### Auto vs hand: gate on `tagDriven`, not on the tag name

A device that is both PLC-commanded and hand-operated (a diverter, a blade stop) follows plant-floor
semantics: the tag is in control only while a controller drives it, meaning the tag is a declared output of the
attached, scanning program. The rest of the time (sim stopped, no program, tag not an output) the operator
controls it:

```js
if (ctx.used()) manual = !manual          // hand toggle (pilot E / editor C)
if (ctx.tagDriven(ctx.params.tag))        // auto wins while a program owns the tag…
  manual = ctx.readTag(ctx.params.tag)    // …by overwriting the latch (bumpless release)
const want = manual
```

Overwriting the latch gives bumpless transfer: a hand press while owned is undone the same tick, and when
ownership releases (program detach) the device holds its last commanded state instead of jumping to a stale
hand latch.

Mark the tag your auto gate reads with **`autoWhenDriven: true`**:

```js
tag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Extend tag (true extends the pusher)', group: 'Comms' }
```

That tells the host the tag commands the device. For a part with an `autoWhenDriven` tag, while a program
drives it the pilot crosshair prompt reads **"In auto - PLC controlled"** and a C press on the
selection flashes the same hint (the press is still delivered, so your gate still decides). Don't flag tags
the device only publishes (a button's press, a sensor's beam) or reads as an indicator (a button's `lampTag`):
a PLC driving those never takes the device out of hand control. Likewise a spawner whose hand Use is an
independent kill (AND-ed with the tag, not overridden by it) keeps the plain "Use" prompt.

Don't gate on the tag name alone (`tag ? readTag(tag) : manual`): that locks the device to an undriven tag,
ignoring hand presses and stuck at `false`, whenever no program is scanning. With the `tagDriven` gate, the
stopped-scene preview poses the device from hand presses and an attaching program still takes over instantly.

**The same applies to every boolean command tag**, not just hand-operable devices. A conveyor's or spawner's
`runTag`, or a machine's `enableTag`, gated on the tag name stops the part as soon as a tag is typed, until a program
attaches, while the Inspector shows a speed that does nothing. Gate it on `tagDriven` so the authored value applies
until a controller takes over (`!ctx.tagDriven(runTag) || ctx.readTag(runTag)`), and mark the param
**`onlyWhenDriven: true`**. That tells the wiring check the part runs on its own setting while nothing drives the
tag, so its warning says that instead of "stays at its zero value". `autoWhenDriven` implies it. Two kinds of tag are
not command tags and keep a plain truthiness check:

- Setpoints (`speedTag`, a REAL that replaces a param). It is read whenever it names a tag, so undriven it reads
  0 and the part sits still. Declare `setpointFor` (below) so the Inspector shows that.
- Publish-only and indicator tags (a button's press tag, a gate's state-out, a `lampTag`). A driven one must
  never flag the device as owned (`e2e/verify-tag-driven-auto.mjs` covers this).

### `useParam`: name the hand state

When the manual latch mirrors a boolean param (the gate's `open`, the blade stop's `active`), declare
`definePart({ interactive: true, useParam: 'open' })`. That names the param as the device's hand state: the state
a run starts from, set in the Inspector. While a program drives the command tag (`autoWhenDriven`), the Inspector
shows that checkbox as the program's live command, read-only and badged, and returns to the authored value on
release (which is accurate again, since release is bumpless).

It must name a `boolean` param your script adopts, and `step()` must `ctx.report` it with the state the device
is actually in (the param is only where it starts): the gate's `ctx.report('open', open)`, where `open` is the
authored value after any hand presses. Both are validated at package build; the report check looks for a literal
`report('open', …)` in your source.

**Use never writes the param.** Use operates a device in every mode, and none of it is an edit (nothing is saved
or undoable, and collab peers don't see it):

- While running, the press goes to `ctx.used()`. It belongs to the run, and Stop resets it.
- While stopped (C in the editor, or E while walking), the press goes to a live instance of your behavior,
  started from the params and stepped every frame. The device stays where a press leaves it (a gate opens and
  stays open; a second press closes it). The Inspector says it is being operated and offers Reset. Play starts
  from the params, and an edit to the part ends it. A spring-return device (a momentary button) comes back on
  its own.

Your script needs nothing extra: each case is `ctx.used()` delivered to your behavior.

### `setpointFor`: say which param an analog setpoint replaces

`speedTag` doesn't gate a conveyor; it substitutes for `speed`. Once it names a tag, the Inspector's `speed` field
would otherwise show a number nothing obeys. Name the param it replaces:

```js
speed:     { type: 'number', default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', unit: 'm/s' },
speedTag:  { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag (m/s)', group: 'Comms' },
```

While the setpoint is in force, that field shows the live commanded value, read-only, badged `plc`, with the
authored value in the hover; the editable field returns on Stop. The authored param is never written.

Rules:

- It must name a declared `'number'` param (validated at package build).
- The setpoint is in the same units as that param. A curved conveyor converts m/s to arc omega after the
  substitution, so its `speedTag` is still m/s.
- It requires a matching `ctx.report` (checked at package build). `report` supplies the number, straight from
  the expression your `step` acted on, in the param's own units:

```js
const s = running ? commanded : 0
ctx.report('speed', s)          // <- what the field shows while the tag owns it
ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
```

`report` shows the effective value, so a `runTag` holding the belt at 0 reads 0 instead of the commanded 2.5, a
snap-reversed curve reads negative, and a ramp or clamp reads where it is.

Whether the tag owns the param follows `autoWhenDriven`, so declare it the way you gate:

| your `step` gate | declare | live field shows |
|---|---|---|
| `tag ? readNumber(tag) : param` | `setpointFor` | the tag value whenever the tag is bound (0 if nothing drives it, and the part reads 0 too) |
| `tagDriven(tag) ? readNumber(tag) : param` | `setpointFor` + `autoWhenDriven` | the tag value only while a program owns it; undriven it falls back to the authored param, like your script |

Boolean command params need nothing extra: `useParam` plus `autoWhenDriven` is enough. Covered by
`e2e/verify-inspector-live-setpoint.mjs`.

### The motion utilities (use these, don't hand-roll)

```js
// slew a turret/heading the short way across the ±π wrap (a plain approach takes the long way):
yaw = ctx.approachAngle(yaw, targetYaw, turnRate * ctx.dt)

// coordinated multi-joint move: all six joints arrive together (no per-axis finish jitter):
cur = ctx.approachVec(cur, POSES[target], speed * ctx.dt)

// mobile base: drive commands that close on a waypoint (turn in place when facing away,
// full speed when aligned, never overshoots). Arrival/choreography stays yours:
const s = ctx.steer({ x: wp[0], z: wp[1] }, { speed: 1.2, turnRate: 1.6 })
ctx.drive(s.forward, s.turn)
if (s.distance < 0.06) nextWaypoint()
```

Also `ctx.angleDelta(from, to)` (wrap-safe signed difference), `ctx.clamp(v, lo, hi)` and `ctx.heading()` (the
part's yaw). The world convention is `atan2(−forward.z, forward.x)`, and a positive turn is to the left,
matching `drive`.

### Servos: let the host run the motion

A joint a real machine drives with a servo motor (a gantry carriage, an indexing table, a lift) should be a
**servo**, not a joint you pose every tick. Mark it in the manifest:

```json
{ "name": "x", "link": "carriage", "type": "prismatic", "axis": [1, 0, 0], "min": -2, "max": 2,
  "servo": { "maxVelocity": 2, "maxAccel": 8 } }
```

and command it from the script. The host runs the profile (acceleration-limited, velocity-capped, never past the
joint's limits) and poses the joint every tick; a write to `ctx.joints.x` is ignored:

```js
definePart({
  servos: ['x'],
  step(ctx) {
    const x = ctx.servos.x
    x.power(ctx.readTag(ctx.params.enableTag))         // a drive starts disabled, like a real one
    if (ctx.rising(ctx.params.goTag)) x.moveAbsolute(ctx.readNumber(ctx.params.targetTag), { velocity: 0.5 })
    ctx.writeNumber(ctx.params.actualTag, x.position)
    ctx.writeTag(ctx.params.inPositionTag, x.inPosition)
  },
})
```

- A servo follows the PLCopen axis state model that PLC motion blocks drive (Disabled, Standstill,
  DiscreteMotion, ContinuousMotion, Stopping, ErrorStop).
- A new command replaces the one before, blending from the current velocity. `done(id)` / `aborted(id)` say how
  a command ended. A command given `buffered: true` waits for the one ahead instead (`queued(id)` reads true
  until its turn), so you can hand a servo a sequence at once.
- Refused commands return a negative code (-1 not powered, -3 a stop is held; the full list is on `Servo` in the
  SDK).
- Joint limits are software limits: a target past one is accepted, and the servo brakes to rest at or short of
  the limit at its `maxDecel` and goes to ErrorStop (`reset()` once still).
- Every move is a trapezoid (constant acceleration, cruise, constant deceleration); see
  [motion-control.md](motion-control.md).
- Units are the joint's own: metres, or radians for a revolute joint.
- A revolute servo with `"modulo": 6.283185307179586` turns without end (a rotary table, a spindle), its position
  wrapping; its `min` / `max` must cover 0 to the modulo.

### Robots: let the host run the controller

An arm that picks and places (any number of joints) should be a **robot**: declare it, and the host runs the robot
controller for it, the one every robot part shares, so a fix to it reaches every robot in every project.

```js
definePart({
  robot: { gripper: 'gripper', lamp: 'vacuumLamp' },
  params: { /* waypoints, jobs, speed, accel, commandTag, executeTag, doneTag ... */ },
  step(ctx) { ctx.robot.step() },
})
```

- The controller owns the robot's **jobs**: programs of steps taught in the Inspector (Move to a waypoint, stopping
  or blending through it; Grip on or off; Wait; Wait for an input; Set an output). The PLC picks a job by number on
  the command tag, pulses Execute and waits for Done; an Enable input holds the arm while the cell is unsafe. A robot
  with no jobs takes a waypoint row as the command and holds its grip from the gripper tag.
- Motion is one coordinated trapezoidal profile per move over every joint, and blend points overlap two moves so
  each joint's speed changes smoothly.
- It reads the part's params by fixed names, declared like any other params (the list is on `RobotController` in
  the SDK). Waypoints are in degrees for a revolute joint and millimetres for a prismatic one.
- `robot: true` drives every joint that is not a servo, cosmetic or mimic, in rig order. An object names the `joints`
  (the waypoint columns), the `gripper` link a Grip step closes, a `lamp` lit while it holds, and a `gripJoint` (a
  finger) that opens and closes with the grip.
- **Tools**: `tool` in the declaration names the link the app draws the robot's tool on, the one its `tool` param
  picks (`vacuum`, `gripper` or `none`; core/robot/robotTools.ts). Both are sized by `toolSizeX` / `toolSizeZ`: the
  vacuum plate is that big (its adapter and bolt pattern shrink to fit a plate smaller than them), and the clamp
  gripper's paddles stand that far apart at the grip joint's 0 and are that deep. Closing, the paddles stop on the load
  the grip holds (the sim tells the controller how far it reaches across the gripper), within 50 mm either way of that
  width; holding nothing, they close fully. The tool
  frame has +Y toward the wrist with the tool hanging along -Y; the robot puts its gripper link (the grip zone) at the
  tools' grip point, and two finger links at the frame's origin on a `cosmetic` sliding joint (the `gripJoint`) and
  its `mimic`, which the clamp's paddles ride. The six-axis robot carries all of it.
- **A hand of its own**: `hand: { gripper, gripJoint }` is a second gripper and finger, the arm's own, used in place
  of `gripper` and `gripJoint` while the `tool` param is `'hand'` (which it must offer). The hand's links take
  `showParam: 'tool=hand'`, so picking a tool takes the hand off, and the grip point the pose gizmo's IK and the
  agent's teaching read follows the tool carried. The tool's lamp stays dark while the hand grips.
- The six-axis robot is the reference; a URDF import makes one of these for any arm.

### The PLC handshake pattern

The six-axis robot, gantry and AGV all use this pattern:

- an INT `command` tag selects what to run (on the six-axis robot, a job by number from its `jobs` table, or a
  waypoint row when it has no jobs);
- a **rising edge** on `execute` starts the move (`ctx.rising` diffs the begin-of-tick snapshot, so an edge
  can't be lost over the async bus);
- `done` reads true while idle;
- device tags (vacuum, forks) drive effectors.

Copy it from [six-axis-robot/part.js](../examples/parts/six-axis-robot/part.js). Parts write PLC inputs
and read PLC outputs; the scene's ST program owns the logic.

Put an effector's pose in the waypoint row, not a second tag, when the row decides it. The AGV's rows are
`[x, z, headingDeg, forkHeight]`, so picking off a 1 m deck and placing on a 1.6 m rack beam are the same command
at different heights, and sending one spot twice at two heights lifts or lowers in place. `done` then covers the
effector: the AGV reports idle only once its tines and wheels have arrived. The device tag then only grabs or
releases. **Latch a gripper on arrival, never on the tag alone** (`if (settled) held = tag`): a grip
captures the load's offset when it closes, so closing mid-stroke carries the load at that gap the whole trip,
and opening mid-stroke drops it in mid-air.

### Which example to copy

| Want | Copy from |
|---|---|
| Conveying (straight / arc / right-angle) | belt-conveyor, curved-conveyor, chain-transfer |
| A bed of hinged sections, pulled into any shape | flex-conveyor (`conveys` links on joints, a `flexPath` handle, side guides as `showParam` links, zero-pressure accumulation: a `beam` per section and `ctx.setSurfaceSpeed([...])` per zone) |
| Splayed merge conveyor (spur handle + guardExtents) | spur-conveyor, spur-roller-conveyor |
| Articulated arm + comms handshake | six-axis-robot, gantry (three coordinated servos, driven by a waypoint row, X/Y/Z position tags, or setpoints streamed every scan) |
| Mobile vehicle (root motion) | agv |
| Sensors (presence / colour / distance) | diffuse-sensor, color-sensor, laser-sensor |
| Safety device: several beams + a PLC-driven indicator | light-curtain (four `beam` links sized by `rangeParam`, one OSSD output, a muting lamp read from a tag. Muting is the safety program's job, not the part's; the demo's `MutingSeq` block is the example) |
| Identify cargo once | barcode-scanner (a scan line across the conveyor reads each case's code off its marks onto a code tag, and `markHit`s the case it read, so a case held under the arch is read once; a one-shot good-read pulse) |
| Cargo lifecycle | box-spawner (the Spawner: a product, released at a steady interval or on each enable, with a cycle of colours and of one attribute's values for a mixed stream), despawner; palletSpawner (not in the catalog, kept for projects that use it); pallet-dispenser (stores real cargo: a gripper per magazine position posed with `setSubPose`, so a dispense releases only the bottom pallet; a zone interlock; a set-down stack gripped where it stands; stock authored through `holds`); stretch-wrapper (`dress` as the carriage climbs, then `join` + `mark`; a carriage eye moving with its link; a start / busy / done handshake) |
| Param-driven structure, arrays | rack, fence, stairs, guardRail, platform |
| Interaction + lamps | push-button, stack-light |
| Simple joint devices | safety-gate, blade-stop, diverter |

## Ground rules

The sandbox enforces the first three. The rest keep a part correct and portable.

- Be deterministic. `Date`, `Math.random`, `fetch` and timers are rejected at load. The same inputs give the same
  sim on every run. A `window`, `document` or `process` you declare yourself (`let window = 0`) is your own variable and is not
  rejected; a variable named `Date`, `fetch` or a timer is.
- Loops are budgeted. One call into your part (a `step`, a `geometry` build, `init`) may run 10 million loop
  iterations; past that it is stopped with an error naming the cause. The limit is counted, not timed, so it
  fails at the same point on every machine.
- What `ctx` hands you is yours. `ctx.sense()` returns a fresh copy each call, and bad commands are ignored (a
  non-finite `setSurfaceVelocity`, a non-positive `spawn` size).
- Command, don't accumulate blindly. Drive joints and velocities every tick from params, tags and `simTime`, and
  use `measured.*` for closed-loop feedback.
- Sense what the real machine senses. A real machine has photo-eyes, encoders, position switches and load cells,
  not a volume that counts boxes. Build it from `beam`s, a conveyor's encoder tag, `measured.joints` and `loadCell`
  links, coordinated in the behavior or the PLC program as on the real machine, and act on the body a sensor sees
  (`markHit`). A `zone` suits what happens to whatever stands in a place: a sink, a wrapper's turntable.
- Parts see only themselves. There is no scene query: facts about other parts arrive as host-computed inputs
  (beams, zones, `rest` params, tag values), which keeps a part portable and the sim's inputs explicit
  ([seam-resolvers](seam-resolvers.md)).
- Geometry functions run at author time: `geometry(g, params, ctx)` runs on load, on param edits and when its
  placement `ctx` changes, never mid-sim. Stay within the vertex budget.
