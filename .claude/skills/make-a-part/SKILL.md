---
name: make-a-part
description: Write or change a part definition in Open Industry Project (a conveyor, a sensor, a machine or a fixture authored against the Part SDK: a manifest with rig links and joints or procedural geometry, and a definePart behavior script) and prove it works. Use when a line needs a part the catalog lacks, when asked to model a machine from a spec or a CAD file, or to change how a built-in part looks or behaves, whether through the desktop app's MCP tools (oip) or the repo's part folders and CLIs.
---

# Making a part that is proven to work

A part is done when it loads, sits where it should, and a test in a scene shows it doing its job. A part that
bakes is only the first of those. Work in the order below; each step has a check.

The facts (the `ctx` surface, the manifest fields, the param kinds, how snapping is declared) are in the Part SDK:
`get_part_sdk` over MCP, `docs/part-authoring-guide.md` and `packages/part-sdk/*.d.ts` in the repo. This skill is
the procedure only.

## MCP or CLI: the same steps

| Step | MCP (desktop app open) | CLI (repo checkout, part folder) |
|---|---|---|
| Learn the SDK | `get_part_sdk` (sections), `get_part_sdk({ symbol })` | read `docs/part-authoring-guide.md`, `packages/part-sdk/index.d.ts` |
| Start from an example | `get_part_source` on the nearest built-in | `examples/parts/<name>/` |
| Check a draft | `check_part` (keeps nothing) | `npm run check-part -- <folder>` |
| Make it | `create_part` | write `manifest.json` + `behavior.js` in the project's `parts/<slug>/`, or one `part.js` there and `npm run build-parts -- <folder>` |
| Change it | `edit_part_definition` (one undo step) | edit the folder (its `part.js` if it has one, then build); the desktop app's folder sync reads it back, and `sync_folder` says when it has (a part change stops a running sim) |
| Bring a model | `import_model` (.glb, .step, .stp) | `npm run import-model`, `npm run inspect-glb` |
| Look at it | `add_part`, then `capture_view` | `npm run shot-part -- <folder>` |
| Prove it | `run_test` with a spec on a scene using it | `npm run test-project -- <project>` |
| Tune how it moves cargo | `run_test` with `cargo: [t, ...]`: every body's position, tilt, heading, velocity and what it touches at those sim times, the same each run | `npm run test-project -- <project> --cargo 3,4,5` |

The MCP tools take a manifest object and a behavior script. They never write a `part.js`: for a part the project
folder builds from one, `get_part_source` returns it as `partJs` with the build command, and `edit_part_definition`
warns that it changed only the build output. Build such a part in its own folder (`npm run build-parts --
<project>/parts/<slug>`), not in a copy, then `sync_folder`.

On the CLI side a part can be one `part.js`: a `definePart` holding `manifest`, the params, `rig(p)` computed from
the params, `geometry()` and `step()`, importing shared modules by relative path (a project keeps them in
`parts/_shared/`). `npm run build-parts -- <folder>` writes the folder's `manifest.json` and `behavior.js` from it,
and `npm run check-part -- <folder>` checks that build. Prefer it when the rig follows the params, since the build
works out the param refs. The guide's "Writing a part as one `part.js`" has the details.

## 1. Copy before you write

Find the built-in closest to what you need (`list_catalog`, then `get_part_source`) and start from its manifest
and script. Its params, snap features and conveyor declaration already follow the conventions the editor relies
on: a belt's origin is its tail, a roller conveyor's is its centre, and a part's footprint is what placement and
snapping see.

Decide early between a rig (links and joints, Tier 1) and procedural geometry (`geometry()`, Tier 2). A model
from CAD is a rig: each moving piece is its own link. The two mix: a rig's moving links can take their look from
`geometry()` (`MeshPart.link`). A row of identical moving solids (a sorter's slats or shoes, pushers, buckets) is
one posable array link, never numbered links: see "Rows of moving carriers" in docs/part-authoring-guide.md.
A machine with carriers publishes which carrier stands at each station as tags, so its program tracks cargo by
carrier number instead of repeating the part's geometry.

## 2. Check, then make

- Run `check_part` on every draft. It reports a misspelt manifest field that the bake would silently ignore, a
  script that breaks the determinism rules (no `Math.random`, `Date`, timers), and broken rig or snap references.
- Declare params in `definePart`, never in the manifest. A tag param needs its direction (`in` = the PLC drives
  the part) and its ST type, or the wiring check cannot help the line that uses it.
- `create_part` and `edit_part_definition` refuse a draft with problems and list them, so a part in the project's parts
  always bakes.

## 3. Look at it

Place one (`add_part`) and take a picture (`capture_view` with `parts` set, `from` iso, then top). Check what a
test cannot see:

- the model sits inside the footprint `get_part_source` reports; a rig's `bounds` are declared, not measured,
  so an imported model can float above or sink below them. Fix `geometry.bounds`, not the model;
- the part faces the way the line flows, and a sensor or a mount faces its host;
- moving links turn about the right point: drive a joint from the behavior and look again.

## 4. Prove it in a scene

Put the part where it works: a conveyor with a box on it, a sensor over a belt. Write a test that fails without
the part doing its job, and run it. Withhold the input the part reacts to, or set the param that disables it, and
confirm the test fails, so the pass is not vacuous. Keep the spec with `save_test`.

## When a built-in is the thing to change

`edit_part_definition` on a built-in makes this project's own version of it; other projects keep the app's.

In this repository, a shipped part under `examples/parts/` is different:

- If its folder has a `part.js`, that is the part's source, and its `rig.json` and `behavior.ts` are output.
  Edit the `part.js` (or the `examples/parts/_shared/` module it imports), then run
  `npm run build-parts -- <dir>`. An edit made to `rig.json` or `behavior.ts` is overwritten by the next build,
  and `npm run build-parts -- --check` fails CI on it. The guide's "Writing a part as one `part.js`" covers `rig(p)`
  and the shared modules.
- Then run `npm run parts:record`. The corpus under `test-corpus/` is append-only.

A project part with a `part.js` works the same way, with `manifest.json` and `behavior.js` as its output. An edit
made through the MCP tools or the Part Editor changes only those two files, so copy it into the `part.js` before the
next build: `npm run check-part -- <folder>` reports the files as `stale`, and `build-parts` refuses to overwrite
them until the change is in the `part.js` (or `--force` discards it).
