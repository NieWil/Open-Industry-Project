# Architecture: one engine, two shells

oip-web is built around a single portable **TypeScript simulation core** that runs on two
shipping surfaces, the **browser tab** and an **Electron desktop shell**, over the same
Chromium/V8 + three.js + Jolt-WASM stack. There is one engine. The surfaces differ only in
what the shell around it can do.

The browser is the primary surface: it needs no install, a link opens it, and it runs on phones.
The desktop shell adds what a tab can't do: hardware I/O, filesystem access (watched
custom-part folders, project files) and OS-level packaging. It adds capabilities, not
performance. Both shells run the same physics and renderer.

## Layers

`src/` is split into layers whose dependency directions are enforced by lint
(`eslint.config.js`, `no-restricted-imports`):

| Layer | May import | Job |
|---|---|---|
| `src/core/` | nothing downstream - no DOM, three, React, Jolt | headless scene/simulation/PLC model; portable and deterministic |
| `src/sim/` | `core` + `jolt-physics` + `plc` | physics stepping, with the PLC scan interleaved in-worker |
| `src/render/` | `core` + `three` | the three.js view of the scene |
| `src/plc/` | `core` | the PLC engine (IEC 61131-3: Structured Text, IEC ladder) |
| `src/editor/` | every layer | the React UI |
| `src/collab/` | `core` + `editor` + its yjs/codemirror stack (not `plc`, `sim`, `render`, three or Jolt) | Yjs live editing; it drives the editor store, and `editor` imports it in turn |

The flat, engine-neutral scene model in `core` is the source of truth. The renderer's scene
graph and the editor's tree view are materialized views rebuilt from it. Nothing binds
project content to a renderer object.

## The `PartContext` seam

Part behavior never touches an engine API directly. It calls an abstract interface,
`PartContext` (`src/core/parts/partApi.ts`), with methods such as `setSurfaceVelocity`, `drive`,
`setJoint`, `setGrip`, `sense`, `readTag`/`writeTag`, `spawn`/`despawn` and `zone`. The sim host
implements it over Jolt-WASM on both shells. A part never raycasts or queries the scene. What it
may know arrives through `sense` and the context's other readings. Two things follow:

1. **The engines can change under the parts.** The renderer and physics change behind the seam
   (the WebGPU and WebGL renderer paths, a Jolt upgrade) without touching any part's behavior.
2. **A part can be reloaded during a run.** An edited package is swapped into the running sim, and
   the worker rebuilds only the parts that use it (`reloadSimPackage` in `src/editor/controller.ts`).

## Determinism

The simulation core is deterministic by construction. The physics worker owns the clock, and
everything else (PLC scans, motions, view animations) follows sim time, never wall-clock.
Randomness goes through a seeded `Rng` (`src/core/rng.ts`), never `Math.random`. Identical inputs
replay to identical states on both surfaces.

## Parts: the catalog is built on the public SDK

Every first-party part ships as an ordinary **Part SDK** package. The built-in catalog is
authored against the same public surface (`packages/part-sdk/`) that user-created parts
use, so the catalog doubles as a set of worked examples (`examples/parts/`).

A part is a set of portable artifacts: a manifest/rig (`rig.json`), a GLB, declarative
collision, and a behavior module (`behavior.ts`). Packages load through one registry seam
from committed data and hot-reload in dev. There is no runtime code-generation layer (the
bundled parts are built offline from their `part.js` sources and committed). Because
the artifacts are engine-neutral and behavior is sandboxed to the SDK's `PartContext`, a
part opens on web and desktop alike and can be shared across users and installs.

See `docs/part-authoring-guide.md` for the author-facing tour of the SDK.

## The PLC engine: one model, IEC front ends

The PLC engine in `src/plc/` is one model and one runtime: the IEC 61131-3 software model
(configuration, task, program instance; program TYPE kept apart from instance), a checker, an
interpreter and a TypeScript emitter, the task scheduler on sim time, and the sim link. It
implements a subset of IEC 61131-3, a subset of the PLCopen motion function blocks and the PLCopen
XML 2.01 exchange format. It is not certified. Open-source implementations (OpenPLC, MATIEC,
STruC++) are test oracles. Vendor controllers are connection targets. None is the specification.
Each language it reads is a **front end** that produces a checked program in that model's terms
(`src/plc/program.ts`): Structured Text, and IEC ladder (`docs/ladder.md`), which lowers to ST. The
runtime consumes it unchanged, so one set of oracles tests the runtime whichever language the
program was written in. Differences between IEC toolchains' file formats are held as data (the
PLCopen reader's pin aliases, `ladderExportCaveats`), not separate engines.

The rules:

- **One declaration layer, `src/plc/tags.ts`.** A variable is one declaration in the program
  text. So declare, retype, move and delete exist once, whichever surface asks (the ladder's
  declaration pane `components/plc/LadderVariables.tsx`, the organizer). So does rename, which follows
  scope and carries the scene's wiring with it.
- **Never a second copy of an edit.** Two surfaces may differ in what they show and where a
  thing is reached, but the change they make to the program is the same change. Two copies drift
  apart as each gains features the other lacks. So a fork made on purpose states what would have
  to be true to retire it, not only why it exists.
- **Checker rules for a front end sit beside the checker (`checker.ts` and its `check*.ts`
  modules), never as branches inside it**
  (ladder's `LD_ROLES` is the pattern).
- **A saved program may name a dialect this build does not have.** The program document's
  `stDialect` (`src/core/dialect.ts`) is a forward-compatibility marker. Absent means IEC. Any
  other value is refused at run time with a plain message, and the text is kept byte for byte
  through every load and save (`docs/projects.md`).
