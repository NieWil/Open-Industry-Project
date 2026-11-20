# Technical overview

The technical tour of the codebase. For the layer rules and the core / shell
split, see [architecture.md](architecture.md); for keyboard shortcuts, press `?` in the editor
(the panel renders straight from [src/core/keymap.ts](../src/core/keymap.ts), so it is never
out of date).

## Scene format

Flat JSON, placement-as-truth: connectivity is derived from geometry, never stored. It diffs
cleanly, and a person, a script or an AI agent can read and write it directly:

```json
{
  "version": 4,
  "parts": [
    { "id": "pt_1", "type": "part", "packageId": "oip.roller-conveyor",
      "position": [0, 0.75, 0], "rotationY": 0,
      "params": { "length": 3, "width": 0.6, "speed": 0.5 } },
    { "id": "pt_2", "type": "part", "packageId": "oip.box-spawner",
      "position": [-1, 2.2, 0], "rotationY": 0,
      "params": { "boxesPerMinute": 8 } }
  ],
  "packages": [ ]
}
```

`packages` embeds every part package the instances reference, so a saved scene is
self-contained (elided above). Units: meters, radians, m/s, seconds. A conveyor's surface top
sits at origin y; local +X is the conveying direction (roller/straight beds keep their origin at
the bed centre, belts at the tail), `rotationY` rotates about world +Y. A scene with an older
`version` is upgraded on load.

### Scene conventions

What a script or an agent writing `position` / `rotationY` directly needs to know:

- **Axes and units.** Right-handed, **+Y up** (glTF's and three.js's frame; gravity pulls along -Y).
  Lengths and positions are metres, angles radians, speeds m/s, whatever Units the scene shows
  (imperial is display only). The floor is y = 0.
- **`position`** is where the part's origin sits in world space ([types/base.ts](../src/core/types/base.ts)
  `PartBase`). Where the origin is inside the part is per package, not a rule: a roller or straight
  conveyor's is the bed centre, a belt's is its tail, a conveyor's conveying-surface top is at the
  origin's y, and a despawner's zone stands on its origin. `npm run catalog -- <partId>` prints it
  for any part: the footprint in part-local coordinates at default params, which end the origin sits
  at, a conveyor's ends, and each zone's extent (min..max per axis); `--params length=4,...` gives
  the same at other params, so a resized part's ends need no hand derivation.
- **Zones act on contact, wherever the box is.** A detection or removal zone (a despawner's mouth)
  takes a box the moment the box's centre is inside its volume, on a belt or not. The
  despawner's default zone reaches 1 m up from its origin, so a sink that overlaps a belt's end
  removes boxes still on the belt: compare the zone's extent with the belt's `front` end in the catalog.
- **`rotationY`** is radians about world +Y, and 0 aligns the part's local +X with world +X.
  Positive turns **counter-clockwise seen from above**: local +X goes toward world **-Z**, so
  `rotationY = π/2` points it at -Z, `-π/2` at +Z and `π` at -X (`qFromAxisAngle([0, 1, 0], rotationY)`
  in [rigPose.ts](../src/core/rig/rigPose.ts), and `toWorldXZ` in [partGeometry.ts](../src/core/parts/partGeometry.ts),
  which snapping and footprints use). `rotationX` / `rotationZ` (pitch / roll, optional) are for the
  rare tilted part; planar tools read `rotationY` only.
- **Downstream is local +X.** A conveyor carries product toward its local +X while its speed is
  positive (a negative speed reverses it): it feeds in at its `back` end and discharges at its
  `front` end. Facing downstream, **left is -Z and right is +Z** (side guards, `sideGuard: 'left'`).
  So a line running along world +X uses `rotationY = 0` for every conveyor; one turning toward
  world -Z continues at `π/2`.

A **project** ([src/core/project/project.ts](../src/core/project/project.ts)) is the thin container above that:
one scene, the ST program that runs it, the project's part library (its own copy of every part the scene uses,
built-ins included), and JSON control-logic tests. It
saves as one document or as a linked folder on disk (File System Access in the browser, the real
filesystem under Electron). See [projects.md](projects.md) and
[scene-composition.md](scene-composition.md).

## Physics

Boxes are conveyed by physics, not animation: conveyor bodies are static boxes whose contact sets
a relative surface velocity (Jolt's conveyor-belt contact-listener pattern), so boxes accelerate
from rest by friction, transfer across snapped junctions, and tumble off ends under gravity. The
sim steps at a fixed rate in a worker: 60 Hz unless the project sets another (60 to 1000 Hz,
"Physics rate" in the Inspector with nothing selected; `ProjectMachine.simHz`), with the PLC scan
interleaved. Run/Stop hands the scene over and destroys
all spawned boxes on stop. [src/sim/world.test.ts](../src/sim/world.test.ts) exercises the full
conveying acceptance (acceleration to belt speed, seam transfer without snagging or sinking,
falling off the end, reverse belts) headlessly in Node against the real WASM build.

Rollers sit on a world-space pitch grid (75/100/130 mm by duty class): offsets derive from world
position, not the conveyor origin, so snapped neighbours read as one continuous bed.

## Parts

Every functional part is an SDK part: a portable JS package authored against `@oip/part-sdk`
([packages/part-sdk/](../packages/part-sdk/)), a declarative rig/geometry plus a deterministic
behavior script. The bundled `oip.*` set is authored in `examples/parts/`; user parts use the
same pipeline ([part-authoring-guide.md](part-authoring-guide.md)). `npm run catalog` prints the
live list: conveyors (roller, belt, flex, curved, spur, turntable, chain transfer), devices
(diverter, blade stop, sensors, push button, stack light, safety gate), products (box and pallet
spawners, despawner), machines (gantry, AGV, six-axis robot, pallet dispenser, stretch
wrapper), structure
(platform, stairs, rack, fence, guard rail, bollards, floor marking, primitive shapes) and cargo
(box, pallet, unit load).

The only static part types are the Group container, the Annotation (a screen-space note pinned
to a place; [annotations.md](annotations.md)) and the Building, a warehouse shell tiled from
real wall/roof/floor GLB modules. Part visuals all render through the generic SDK rig
renderer ([src/render/parts/sdkPart.ts](../src/render/parts/sdkPart.ts)); GLB-rigged parts load
their models from `public/models/`.

## Headless tools

These run from the CLI with real exit codes, so a script, a pre-commit hook or an AI agent can
use them without a browser:

```sh
npm run catalog                    # every part: footprint, PLC signals, params by group (--json, --verbose)
npm run catalog -- <partId>        # one part in full: each param's range, unit, default and doc line
npm run edit-part -- <folder> <id> # change a placed part: --params k=v,... (type-checked), --at, --rot, --name
npm run duplicate-parts -- <folder> <id...> --offset dx,dy,dz  # copy a station: links inside it follow the copies, tags renamed (--rename A=B, --tag-suffix)
npm run capabilities               # what the ST engine accepts/refuses (probed, not transcribed)
npm run check-st -- <path...>      # does this ST compile
npm run validate-project -- <path> # does this document load
npm run check-wiring -- <path>     # do the tags connect (--strict)
npm run check-layout -- <path>     # do parts that seat on something actually seat
npm run test-project -- <folder>   # does the control logic behave
```

A saved project folder also carries a generated `AGENTS.md` (the scene's tags, parts and test
format), so an agent editing it reads the names instead of guessing them.

## Tests

`npm test` runs the vitest units, including headless physics acceptance. End-to-end coverage is
about 300 standalone Playwright scripts run with node (`node e2e/box-shot.mjs`);
`npm run build && npm run gates` runs the curated must-pass list. [AGENTS.md](../AGENTS.md)
explains the harness conventions.
