# Command-line tools

The headless CLIs: no browser, real exit codes. This is the door an agent or a pre-commit hook uses.
The everyday commands (dev, test, build, gates) are in [AGENTS.md](../AGENTS.md).

Scene conventions the tools assume (rotationY direction, +X downstream, left = -Z):
[technical-overview.md](technical-overview.md).

## Parts

- **`npm run catalog`** - every part: footprint / origin / conveyor ends / zones / beams at default params, PLC
  signals, params by group. `-- <partId>` shows one part in full with each param's range, unit and doc line;
  `-- <partId> --params length=4,...` its frame facts at those params; `--verbose`; `--json` carries every param's
  full spec.
- **`npm run check-part -- <part-folder...>`** - one part: manifest schema + the app's bake + its footprint, signals,
  joints, colliders. A folder with a `part.js` is built in memory the way `build-parts` builds it and the checks run
  on that build. A manifest or behavior beside it that differs from the build is a `stale` problem: the `part.js`
  changed and was not built, or the file was edited (by hand, the Part Editor or an agent tool) and the next build
  would undo that edit.
- **`npm run inspect-glb -- <file.glb>`** - a model's node tree: names, local TRS, materials, subtree boxes.
- **`npm run import-model -- <file.step|.stp> [--out <file.glb>]`** - STEP to GLB through the app's own conversion:
  `--up z|y` (default guessed from the exporting program), `--detail normal|coarse`, `--min-part-mm <n>` (default
  10), `--no-merge`, `--json`. Exit 1 = the file could not be converted.
- **`npm run shot-part -- <part-folder> [--pose j=v,...] [--focus x,y,z,r]`** - PNG views of one part at rest /
  posed, through the real renderer; `--focus` is a close-up of a part-local sphere.
- **`npm run build-part-sdk`** - regenerates `packages/part-sdk` from src/core, refusing output that doesn't compile;
  `-- --check` is the CI gate. It also fails when the SDK's surface changed without a raise of `PART_SDK_LEVEL`
  (src/core/partSdk.ts; the levels are recorded in `packages/part-sdk/levels.json`, docs/part-sources.md).
- **`npm run build-parts [-- <dir | path>...]`** - builds parts from their `part.js` sources
  (docs/part-authoring-guide.md "Writing a Part as One part.js"). A source is one `definePart` holding `manifest`,
  the params, `rig(params)` (or a static `manifest.geometry`), `geometry()` and `step()`, importing other modules by
  relative path. From it this writes the behavior (the imports joined in, comments kept, `manifest` / `rig()` and
  unused helpers left out: scripts/lib/bundlePart.mjs) and the manifest (src/core/rigCompile.ts turns each number that follows a param into a
  ref: a straight line in one param, a straight line between two flat ends (the ref's `min` / `max`), or a product of
  two params plus a constant (`mulParam`), on a link offset, a box, cylinder or grip zone size, an array step, a leg
  row's frame depth, a joint's limits (`minParam` / `maxParam`, the static limit the widest over the range) or a bounds
  field (`bounds.params`); it refuses one it can't express and passes through any ref `rig()` writes itself).
  - A bare name is `examples/parts/<dir>`, and no name means every one of those with a `part.js`. There the files are
    `behavior.ts` and `rig.json`, and shared code is in `examples/parts/_shared/`.
  - A path (anything with a slash) is any folder holding a `part.js`: a project's `parts/<slug>/`, a library's source
    folder. There the files are `manifest.json` and `behavior.js`, the names the app reads (docs/projects.md), and a
    project keeps shared modules in `parts/_shared/`, which the folder sync never writes or removes. The app edits
    such a part through those two files (the Part Editor, the agent tools), so the build refuses to overwrite a file
    that differs from the build and is newer than its sources: move the change into the `part.js` first, or pass
    `--force` to discard it.
  - In a folder with a `part.js` both files are output: edit `part.js`, never them. They carry no header saying so,
    because the same text ships in every project's copy, where it is the file to edit. `-- --check [<dir | path>...]`
    writes nothing and fails on a file that differs from the build. It is the CI gate, and names the `part.js` to
    edit. A folder with no `part.js` is hand-authored and edited in place.
- **`npm run build-library -- <out-dir> --id <library-id> --name <name> (--from <dir> | --category <c> | --part <id>...)`**
  - packs parts as a part library (docs/part-libraries.md): an `index.json` beside one `.oippart` per version, models
  and textures inside each file. `--from libraries/<name>` packs a library's own sources, one part folder each, with
  its `thumbnail.webp` and `description.txt`; `--category` and `--part` pack built-ins. A new version must already be
  in the old-parts corpus (`npm run parts:record`). Append-only: an unchanged part gets nothing new, a changed one a new version. Every
  version is read back the way the app installs it before anything is written. `--dry` writes nothing. `--listed
  --namespaces <file>` packs the parts repository's `parts/` as the listed library: the listing rules of
  `core/partSubmission.ts`, each part's publisher from its id, each new
  version's behaviour digest recorded in the index instead of a corpus entry, the realm locked down while parts run,
  and a part whose folder is gone dropped. The index it writes is unsigned.
- **`PART_LIBRARY_SIGNING_KEY=<pem> npm run sign-library -- <index.json> [--published <index.json>]`** - signs a
  library index with the project's key (core/librarySignature.ts), checks the signature, and says when the key is not
  one this build trusts. Runs no part code, so the CI step that holds the key never runs a part. With `--published`
  (the index the bucket serves now) it signs only an index that appends to it (`checkLibraryAppend`) and whose new
  files hash to the names they are listed under.
- **`npm run library-key -- --repo <owner/name>...`** - makes the project's signing key: the private key goes to each
  repository's `PART_LIBRARY_SIGNING_KEY` Actions secret through `gh secret set` and nowhere else, and the public key is
  added to `src/core/librarySigningKeys.ts`, to commit. Run again to add a key beside the old one.
- **`npm run check-submission -- <parts-dir> --namespaces <file> --author <login> [--orgs <a,b>] [--part <id>...]
  [--pr-body <file>]`** - the parts repository's pull-request check, and what an author can run first. Each part is
  built, checked against the listing rules and its namespace, and run alone at its defaults (twice) and at each
  setting's extremes, in a child process capped at 1.5 GB and 120 s, in the SES sandbox; this process runs no part
  code. `--pr-body` requires the rights line ticked. Exit 1 lists every problem.
- **`npm run library-corpus [-- --index <url>] [-- --no-run]`** - downloads every listed version from the official
  libraries (by hash, into `.cache/library-corpus/`), checks each index's signature, and runs
  `src/sim/libraryCorpus.test.ts` on them: each must install and behave as it did when listed. CI runs it.
- **`npm run sdk-usage [-- --all | --json]`** - how many first-party parts use each thing the Part SDK lets a part
  say, read from the schema + index.d.ts. Unused and one-user entries are the ones to review.
- **`npm run retired-kinds [-- --db <collab.sqlite>]`** - whether a `RETIRED_SHAPE_KINDS` entry may be deleted yet:
  grace period read from git, plus a scan of a collab-db backup for rooms still holding it.

## Editing a project from the command line

Never hand-edit scene.json; these go through the same checks the editor does.

- **`npm run add-part -- <project-folder> <built-in id | part-folder> [--params k=v,...] [--id <id>] [--at x,y,z] [--rot <deg>]... [--place | --scaffold]`**
  - The options after a part apply to that part.
  - `--params` values are checked against each param's declared type, and a given value is never written over. One
    that needs a switch setting turns the switch and says so (`speedFpm=200` sets `fpmUnits=true`). One equal to
    what the part already has is printed as not stored. A list is one comma-joined value:
    `--params 'boxColors=#e33,#3e3,width=1'`.
  - All or nothing: any bad part or value writes nothing and lists every error.
  - A built-in needs only its id (checked, then placed); an authored part is baked and added to the library. Creates
    the project if missing.
  - `--scaffold` lays out a straight line with the real snap engine (eyes on a guard across the belt, buttons on the
    frame, a spawner over the infeed). It wires only the tags its program and starter test use, uniquely named
    (`Belt1Run`, `DischargeEye`, `StartPB`, `SpawnerRun`) unless a tag is named in `--params`. Other tag params stay
    blank, i.e. unwired. It takes a guard device's `--at` x as its spot along the line and holds a spawner with the
    belt it drops onto. It writes a Start/Stop latch that starts stopped, plus a starter test that presses Start and
    whose box physically reaches the eye. It never overwrites a program or test. See src/core/lineScaffold.ts.
- **`npm run edit-part -- <project-folder> <partId> [--params k=v,...] [--at x,y,z] [--rot deg] [--name text]`** -
  change a placed part through add-part's param checks, carrying its soft-parented subtree; prints old -> new.
- **`npm run duplicate-parts -- <project-folder> <partId...> --offset dx,dy,dz [--rename Old=New,...] [--tag-suffix S] [--id-suffix S] [--strict]`**
  - copy a station. Its subtree comes along, parent and partRef links inside the group follow the copies, links
  outside are kept, and tags are renamed. A second writer of a tag is a warning that `--strict` fails. Seam geometry
  is re-derived on load by core/sceneResolve.ts, so there is nothing to copy.
- **`npm run snap-part -- <part> --onto <host> [--host-params k=v,...] [--host-at x,y,z] [--host-rot deg] [--at x,y,z [--local]]`**
  - where the editor's snap engine would seat a part on a host with the params and pose you give, in world
  coordinates plus the host's frame. `--at` is the mover's origin, which `npm run catalog -- <id>` locates (e.g. a
  belt's tail).
- **`npm run snap-part -- <part | placed id> --project <folder> [--host <id>] [--params k=v,...] --write [--id <id>]`**
  - seats it against that project's placed part and writes the edit through core/snapCommit.ts, the editor's own
  commit: pose, fitted params on both parts, attach parent. Guard openings, railing gaps and lifts are derived from
  the scene on load, never written.
- **`npm run rename-tag -- <project-folder> <from> <to> [--pou <name>]`** - rename a PLC tag in the program files and
  every part wired to it, the PLC panel's rename. `--pou` names the POU that declares it (none = a top-level tag). A
  name that would collide is refused with the reason. Tests are not changed; it warns about each one that still
  names the old tag.
- **`npm run assign-io -- <project-folder> [--list <io-list.csv>] [--poll <inputBase>,<outputBase>]`** - the PLC
  panel's Assign I/O: each tag a part is wired to by name is declared at an I/O address (`Eye AT %IX0.0 : BOOL`) and
  its parts are rewired to the address. `--list` takes the addresses from an I/O list; `--poll` addresses for a PLC
  the simulator polls. `-- <project-folder> --export [<file.csv>]` prints or writes the I/O list and changes nothing.

## Checking a project

- **`npm run validate-project -- <path>`** - the document loads; lists what loading repaired, `--strict` fails on it.
- **`npm run check-st -- <path...>`** - ST compiles. A project's program files are checked together, as the program
  they make, and each error is reported at its own file and line.
- **`npm run check-wiring -- <path>`** - tags connect. The project's tests count, so a tag a test checks is read and
  one a test input drives is written; `--strict` fails on warnings.
- **`npm run check-layout -- <path>`** - parts that declare they seat on something actually do. It reports
  disconnection, not collision: a naive overlap test flags 303 pairs on the correct demo scene (src/core/checkLayout.ts
  explains). Its one collision check is a part standing in an interior building column (src/core/buildingColumns.ts).
  It also warns, and `--strict` fails, when a box spawner drops onto a belt the program starts and stops without
  being held with it by `conveyorId` + `keepSpacing`: boxes stack on the stopped belt.
- **`npm run test-project -- <folder>`** - control logic behaves. Exit 1 = a check failed, 3 = the project or a test
  could not run. `--only` takes an exact file or test name and falls back to a substring only when nothing matches
  exactly; `--cargo 5,10` lists where every box is at those times. Prefer `passed` + `color` probes, tag-vs-tag
  checks and `from`/`until` windows over exact counts at exact times: [project-tests.md](project-tests.md).
- **`npm run check-flow -- <project-folder> [--seconds N] [--input Tag=v@t] [--json]`** - what physically happened on
  the line: boxes dropped or lost, tipped, eye flickers with the tags that toggled, boxes still on a running
  conveyor. These are facts, never verdicts: a row former's stall is normal accumulation. `test-project` prints the
  same facts before a failure ([project-tests.md](project-tests.md) "Flow facts"). The tracker (core/flowFacts.ts,
  run every step by sim/flowFacts.ts) only reads, so a bench-sim fingerprint must not move with it.
  `new SimWorld(..., { flowFacts: false })` turns it off for an A/B run.
- **`npm run bench-sim -- <project.oip | folder> [--label before]`** - where a sim step's time goes, in the stats
  overlay's rows (parts / plc / physics / upkeep), run headless and locked down like the worker, plus a fingerprint
  of what the line did. Before and after an engine change the timings compare and the fingerprint must match. Runs
  append to `.bench-sim/results.jsonl`.

## PLC engine

- **`npm run capabilities`** - what the ST engine accepts/refuses, probed, not transcribed. `-- --write` regenerates
  `public/st-capabilities.json` + the `/plc/` page, `-- --check` is the CI gate.
- **ST oracles** (all open source; see the vendor boundary in [AGENTS.md](../AGENTS.md)):
  - `npm run st-oracle` - MATIEC, IEC 2nd ed.
  - `npm run st-oracle:ed3` - STruC++, 3rd ed. `-- --execute` also builds each compiled case with g++, runs it and
    diffs it against the goldens; its known gaps are in `RUN_GAPS`.
  - `npm run st-oracle:xml` - PLCopen TC6 schema.
  - `npm run st-oracle:openplc` - OpenPLC's own editor reads each export, regenerates and builds it (pinned upstream,
    fetched, runs natively on Windows).
  - `npm run st-oracle:dry` - render only, no toolchain.
  - On Windows, `wsl -u root -- bash scripts/oracle-wsl.sh all` builds CI's pinned MATIEC + STruC++ in WSL and runs
    them against the working tree (`--execute` = MATIEC only, `ed3 [--execute]` = STruC++ only; `all` runs both run
    tiers). The `:xml` and `:import` jobs stay CI-only. They need vite, which would need a Linux node_modules and
    so a second checkout that drifts.
- **PLC in the loop** (see [src/plc/DEVICE-IO.md](../src/plc/DEVICE-IO.md)):
  - `npm run openplc-loop` - a real OpenPLC Runtime v4 polls the headless sim over Modbus TCP and must stop a box
    where the in-process program does, bits and analog (a REAL each way). Uses `OPENPLC_URL`, else the per-user
    Windows install of the runtime's `Setup.exe`, started and stopped for the run.
  - `npm run s7-loop` - the same case over S7 PUT/GET: the app's own S7 session against snap7's S7 server
    (python-snap7 2.x: `python -m pip install --target .s7-loop/snap7 python-snap7==2.0.2`), the program on the far
    side transcribed into Python over the server's memory. It tests the bytes, not a Siemens CPU. snap7 enforces no
    PUT/GET setting, rack/slot or protection level. `-- --db` puts the two REALs in a data block, DB10.DBD0 /
    DB10.DBD4.
  - `npm run plant -- --demo | <project-folder>` - the scene as a plant service: stepped at wall-clock speed behind a
    Modbus TCP server (default `127.0.0.1:5020`) until stopped, for a PLC outside the repo to commission it. `--demo`
    serves the palletizing cell with its tags given addresses as "Assign I/O" gives them; a folder must already be
    wired to addresses (`npm run assign-io -- <folder>`). `--io-list <file.csv>` writes the I/O list, `--status
    <file.json>` rewrites a status each second (sim time, lag, connections, requests by function code).
  - No script here drives commercial vendor software (a vendor IDE, runtime or SCADA): the PLC links to those are the
    app's own protocol clients, proven against open-source peers.

## Assets

- **`npm run bake-walls`** - bakes the building walls' light, self-shadows included, into lightmaps.
  [scripts/bake-wall-lighting.mjs](../scripts/bake-wall-lighting.mjs) is where the wall lights are defined, and its
  source models live in `assets/building-bake/`; re-run after changing either. `-- --check` is the CI gate.
