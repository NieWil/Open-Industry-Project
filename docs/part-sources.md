# Part sources: every part is the project's own

This extends the rules of [parts-shelf.md](parts-shelf.md) to every part. It covers package format 6 (`origin`),
the one status function, project format 5 (every part the project uses is its own copy, built-ins included),
project format 6 (asset files, with the shipped bytes of every first-party model baked and pinned by hash), the
open-time update prompt and the old-parts corpus test.

## The goal

**One app, always the latest, opens every project.** Nobody should keep an older install of the app because a
project needs older parts.

That is impossible if a project names a built-in by id (`oip.belt-conveyor`) and the app it is opened in supplies
the definition (`partRegistry.builtInPackage`). Then the app version is the part version. A line signed off with
last year's conveyor behaves like this year's conveyor the moment the app updates. Nothing in the project's folder
or its git history shows the change, and the only way to get the old conveyor back is the old app.

## The rule

**A built-in is a part that happens to ship with the app. Nothing else about it is special.**

1. **A project holds its own copy of every part it uses**: built-ins, shelf parts, imported parts, cargo, and the
   parts those parts name (below). The project's parts (`store.userPackages`) are complete; the registry is those parts.
2. **Each copy records where it came from**, per source: `origin: { app?, shelf? }`, each the fingerprint of the
   version that source had when the copy was made (`partFingerprint`, src/core/parts/partOrigin.ts). Keyed by source
   because one copy can have two: a project's version of a built-in that is also on the shelf was made from the
   built-in and copied from the shelf, and its maintainer needs to hear when either moves. A later source (a part
   library, below) is a new key, not a new field, and a build that does not know a key keeps it. `origin` is
   package format 6. A stored package with the older `basedOn` / `fromShelf` is upgraded, and an older part
   folder's manifest is read through `canonicalOrigin`.
   The fingerprint (`v2:<hash>`) covers what the author wrote: the manifest fields and the behavior source, but not
   `params`, `interactive`, `useParam` or `unit`, which the SDK works out by running the behavior. A build that
   derives those differently does not make every copy read as edited or updated. A record without the `v2:` prefix
   is an older stamp made by `storedPackageHash`. `matchesRecord` reads it with that hash, so older projects keep
   their statuses.
3. **The app is a source like the shelf.** The four statuses of [src/core/parts/partOrigin.ts](../src/core/parts/partOrigin.ts)
   (`sourceStatus`) apply to every part, whatever its source:

   | Project copy vs its origin | Source now vs its origin | Status |
   |---|---|---|
   | same | same | up to date |
   | same | changed | update available |
   | changed | same | edited here |
   | changed | changed | changed in both |

4. **Nothing changes until someone says so, and every source says so the same way.** A newer version never changes
   a project's parts. Wherever a part came from (the app, a part library, the parts shelf), a newer version there
   shows the same way (editor/parts/partUpdates.ts): an "Update" badge on the part's card, which opens one dialog
   listing what changes here (components/PartChangeDialog.tsx), and one notice above the cards ("4 parts in this
   project have updates") with **Update all** and **Review** (components/PartUpdatesNotice.tsx). An update is one
   part at a time or all at once, confirms when it would replace this project's own edits ("changed in both"), and
   is a library change, not an undo step, like Import part. Update all asks first, naming the parts whose project
   changes it discards. Review lists each update with where it comes from. The app's updates also offer "Keep this
   project's version", which records the answer so the app stops asking until it changes the part again (the
   Inspector asks the same). A declined library or shelf update keeps its badge. The prompt stays up until answered
   or dismissed, and a dismiss lasts this opening of the project. "Use the app's new version" is
   `store.updateFromApp`, a fresh stamped copy. A part library is read for this only when the project holds a part
   from one ([part-libraries.md](part-libraries.md)); the shelf is read as it always is
   ([parts-shelf.md](parts-shelf.md)). When one part has newer versions in two places, its card offers the most
   specific: the shelf, then a library, then the app.
5. **History is the folder's job.** The copies live in `<project>/parts/<slug>/`, so git, or a copy of the folder,
   keeps every version a project ever had. The app keeps no version store of its own.

Why a stamp at all: without it the app can only see that a copy and its source differ, not whether the source
improved (update), this project changed it (keep), or both (ask). Those need opposite answers. A copy with no
record of its source would also shadow the app's version forever with nothing to tell anyone. A copy with an
origin stamp is a pin the project chose, and the app says when the source has changed. So an unstamped snapshot is
never adopted as the project's own.

`origin` is part of a part's manifest, so it travels with the part by every route (`.part.json`, Import Parts from
Folder, a project folder or `.oip`). A part carried by hand from a shelf or a built-in says "update available"
against the same source like any copy. A part that came from no source has nothing to compare with, so no stamp
would help it. Pinned by `src/editor/parts/partFile.test.ts` "a part keeps its origin on every import route". A known
gap: an imported part with a built-in's id and no `origin.app` goes in unstamped (status "same id, different
part"), while reading a format-4 project stamps its built-in copies with the current version.

## What an update changes

The stamp says that a part has a newer version. Review also says what taking it changes. `partChanges(from, to)`
([src/core/parts/partChanges.ts](../src/core/parts/partChanges.ts)) compares the project's copy with the source's version and
lists the differences most severe first: **breaking** (a signal removed or its direction or type changed, a setting
removed or retyped), **placement** (snap features, shape or colliders, conveyor joins: placed copies may sit
differently), **behavior** (the script, defaults, ranges, new signals or settings), **appearance** (models, textures,
materials) and **wording** (labels and descriptions, counted rather than listed). It reads the params the SDK derives
from the script, which the fingerprint leaves out, because a removed signal is how a script change shows to the person
deciding; the fingerprint alone decides whether there is an update. One headless function, so Review, a CLI and the
agent door report the same thing. Gated by `e2e/verify-part-updates.mjs`.

**Whether a break matters here** depends on the project, not the part. A removed signal that nothing wires is
harmless, and one the program reads is the real break. So Review also says, under each breaking signal change, what it
breaks in this project: the tag each placed copy is wired to, the program's rungs and lines that use it
(`plc/crossRef.ts`), and the other devices wired to the same tag (`plc/bindings.ts`), or that no placed copy is
wired to it at all. That is [src/plc/updateImpact.ts](../src/plc/updateImpact.ts), loaded when Review opens rather
than with the notice, since it reads the program's ladder.

Comparing packages cannot say why a script changed or what the change does: "The part's script changed" is the
most common line and the least informative, and timing or sensing changes live there. Nor does Review say whether
the line still works with the new version. Run the project's tests (`test-project`) after taking an update for that.

## Variants: two versions side by side

Editing a part in place keeps its id and its origin (status "edited here"). A project that wants the original AND its
variant, e.g. a heavy-duty conveyor beside the standard one, uses **Save as New Part** (the
`part.saveAsNew` command, on a part's right-click menu and the Inspector header; `controller.saveAsNewPart`,
`asNewPartFrom` in core/builtInVersion.ts). It copies the part under its own `user.<stem>` id and a "(variant)" name
into the library; placed parts keep the part they are. Made from a built-in, directly or through the project's copy,
it records the built-in's id and the version it came from (`origin.appPart`, `origin.app`), and the Inspector says
"Made from the app's Belt Conveyor", adding "which the app has updated since" when the base changes
(`variantBase`). A variant is never an "update" of its base, so there is nothing to take, only to know. One id is one
definition in a project, always: the registry, the sim worker, rooms, the PLC signal catalog and the sandbox all key
by id.

## Parts that name other parts

Copying a part copies the parts it names, at their current versions, stamped the same way. Otherwise a copied part
could point at a part the project does not have (`packageDependencies`). The cases are:

- `pallet-dispenser`'s `holds.part` names `oip.pallet` (examples/parts/pallet-dispenser/rig.json).
- `unit-load` declares its pieces (`unit.pieces`: `oip.pallet` and `oip.box`, examples/parts/unit-load/behavior.ts),
  and [src/core/frame.ts](../src/core/frame.ts) `unitPieces` reads them through `unitPiecesOf`. A stored copy
  without the declaration falls back to the same pair (`UNDECLARED_UNIT_PIECES` in core/parts/partPackage.ts).
- A product param (`product: true`, a string naming a cargo part) names what a spawner makes or a sink counts. Its
  default is a dependency of the part (`packageDependencies`), and a value an instance sets is one of the project
  (`productRefsOf`, followed by `missingLibraryCopies`, the CLIs' `projectLibrary` and the editor's `forSim`, which
  hands the sim worker every product the scene's parts name). The Spawner (`oip.box-spawner`) defaults to `oip.box`
  and the Pallet Spawner to `oip.pallet`.
- The controller promotes a selected spawned body to the part of its kind by name (`promoteCargoBoxes`): `oip.tote`
  or `oip.pallet` at a standard size, else `oip.box`. That makes run state (dropped at Stop), not a document part,
  and the registry lookup resolves the project's copy. A body whose part the project does not hold (a tote in a project
  that never added the Tote from Containers) stays transient.

Updating a part offers to update the parts it names. Parts name each other by id, with no version ranges.

## Keeping old copies running

Copies alone do not keep people on one app. If a later app stops running something an old copy relies on (an SDK
capability, a shape kind, a param type), that project needs the old app again. So:

- **Nothing a part can use is removed without an automatic upgrade.** `upgradeStoredPackage`
  ([src/core/parts/partUpgrade.ts](../src/core/parts/partUpgrade.ts)) stays the one door a stored part comes through, and
  `RETIRED_SHAPE_KINDS` keeps its grace period (`npm run retired-kinds`).
- **A test proves it.** A corpus of old part versions (every built-in as shipped, plus representative authored
  parts) loads and runs against every build; one that stops loading or behaves differently fails it. Same family as
  `scripts/shipped-behaviors.mjs` and the snap goldens.

The other direction needs no promise: a part that needs a newer app asks for the update, and updating the app never
changes a project's parts.

### The Part SDK level

A part asks for the update through its SDK level ([src/core/parts/partSdk.ts](../src/core/parts/partSdk.ts)). The package format
moves only when a stored spelling must be translated, so most SDK growth (a new `ctx` member, a new manifest field)
leaves it alone. An older build would load a part that uses the new thing and then fail inside the part. The level
covers that gap:

- `PART_SDK_LEVEL` is one integer, raised whenever the SDK's surface changes. `npm run build-part-sdk` records a hash
  of each level's surface in `packages/part-sdk/levels.json` (declarations without comments, the schema without
  descriptions) and fails when the surface no longer matches the recorded level. The published package's version is
  `0.<level>.0`.
- `validatePart` stamps every part it builds with `sdk: { level, of }`: the level of the build that last changed the
  part and the part's fingerprint at that time. A stamp is kept while the fingerprint matches, so loading or copying
  a part keeps the level it was made under. A part changed since its stamp takes the current build's level the next
  time it is built. Until then its level is unknown and nothing is said.
- The stamp is left out of the fingerprint and the stored hash (`NOT_THE_PART` in core/parts/partOrigin.ts), so it never
  reads as an update, an edit or a new corpus version.
- A build older than a placed part's level shows a warning in the Problems dock (group Parts). It warns and never
  refuses: the stamp is cautious (a part made under a newer level usually uses nothing new), and an installed app
  updates itself, so the warning only reaches a stale tab, a desktop app not yet restarted, or a self-hosted build.

## Format 5

On read, a format-4 project gets a copy of every built-in its scene places (and what
those name), stamped with the current app's fingerprint (`keepDefinitionsOnce`, `missingLibraryCopies` in
core/project/project.ts). That is the best available choice, since nothing records which version it was actually built
against. A copy that already has a record (`origin.app` from an edit, `origin.shelf` from the shelf) keeps it. A
built-in copy a scene carries with no `origin.app` (a format-2 snapshot) gives way to the current built-in. One
with a record (a scene file from another project) joins the library as that project's version. Library entries are never
dropped, used or not: an unused untouched copy could be pruned, but that would delete the folder "Open in external
editor" has just made for a part not yet placed.

Where it is enforced:

- **Reading and writing a document**: every route through `keepDefinitionsOnce` (`validateProject`,
  `serializeProject`, `sceneToProject`, the editor's `assembleProject`) completes the library.
- **The editor**: every autosave completes `store.userPackages` first (`completeLibrary`), so a placed part, a pasted
  one and the demo fork all become the project's own at the next write. Not an undo step.
  Registering an untouched copy rebuilds nothing: `packagesEqual` ignores `origin`.
- **Checking a part's params**: `validateScene(data, runsAsEmbedded)` checks them against the project's copy, never
  against the app's newer version of the same id.
- **A copy identical to the app's built-in is the built-in for display**: its committed thumbnail, its bare name, no ✕
  (`sameAsBuiltIn`, core/builtInVersion.ts). ✕ on a project's own version of a built-in, and "Use the app's new
  version", replace it with a fresh copy of the app's version while anything places it (`store.removeUserPackage`).
- **The CLIs**: `add-part` copies a built-in into `parts/<id>/`, stamped, with the parts it names; the readers complete
  an older folder through `validateProject` (`scripts/lib/builtIns.mjs` must still be declared first).
- **Rooms**: a room seeded from a project marks every library entry as edited, so the creator's copies
  are what the room runs.

Cost: a build that reads only up to format 4 refuses these projects. A project's file grows by its built-in
definitions: all first-party definitions together are about 1 MB of JSON and behavior source. A format 5 copy
keeps its assets as URLs into the app (`/models/X.glb`), which the app serves for good (see the end of the next
section). Project format 6 holds the asset files themselves (next section), which adds about 2 MB for a project that
uses every heavy part.

## Assets

**A copy carries its models and textures, by content hash.** In a package, an asset is either embedded (`data`,
base64 inside `manifest.json`) or referenced (`url`, a path the app serves, e.g. `/models/Diverter.glb`, as several
first-party parts do). A bare reference would leave the copy incomplete. The project would pin
the definition but not the file, so a later app that changes `Diverter.glb` at the same path would change every old
project. A part that comes from a library has no app path at all.

So in project format 6 every asset is a real file in the part's folder, named by the hash of its bytes, and the
manifest names the file (`src/core/parts/partAssets.ts`). The folder codec, the `.oip` archive and Put on Shelf write
`assets/<sha256>.*`, and every reader joins the files back into `data`, so packages in memory and the fingerprint
are the same either way. The format number is its own so that an older build refuses such a folder by its version
rather than by a part with no bytes:

```
parts/<slug>/manifest.json
parts/<slug>/behavior.js
parts/<slug>/assets/<sha256>.glb     (or .webp, ...)
```

- **One layout everywhere a part is stored:** a project's `parts/`, the shelf, a library release, and the single-part
  file `.oippart` (that folder, zipped, as `.oip` is the project folder zipped; `src/core/parts/partArchive.ts`).
  `.part.json` imports forever, like the flat `.oip`. One reader, one validator, one fingerprint. The installer
  registers `.oip` and `.oippart` ([desktop-shell.md](desktop-shell.md#project-and-part-files)). Opening a `.oip` imports it as a
  new project and never edits the file in place: a `.oip` is a way in and out, never a place a project lives.
- **No exception for the app.** A copy holds the bytes even when the app ships the same file: "the app has this hash"
  is the built-in special case again, by way of the assets. A `.oip` is then complete by construction.
- **The bytes copied are the shipped ones.** `scripts/optimize-assets.mjs` runs only in `npm run build`, and a dev
  server serves `public/` raw. The raw first-party part assets are about ten times the size of the shipped ones
  (about 23 MB against 1.9 MB). So the bundle carries each shipped asset's hash and its optimized bytes, and placing
  a part copies those. A copy made in dev must equal one made in production.
- **The fingerprint covers the asset bytes**: `partFingerprint` hashes the in-memory package, base64 `data`
  included, and files are joined back into `data` on read. So the fingerprint needs no change for files (changing
  it would turn every stored `origin` stamp into "changed"). A changed model is "update available" like a changed
  script.
- `data` and `url` assets are read forever. In memory an asset stays `data`; only a folder and a `.oip` hold files.
- Size: a project that uses every heavy first-party part grows by about 2 MB. Fine for a folder, git and a `.oip`;
  rooms are the one place it matters (next section).

### Shipped asset bytes

`scripts/bake-part-assets.mjs` runs the build's own optimizer (scripts/optimize-assets.mjs) over each model and
texture a first-party part names. It commits the result as `public/part-assets/<sha256>.<ext>`, append-only and
byte-identical to `dist/`, with the table `src/core/shippedPartAssets.ts`. The table is generated:
source URL -> hash, plus the input version it was baked from, so `shippedAssets.test.ts` fails on a stale bake.

The package build points such an asset at its baked file with its `sha256` (`pinShippedAsset`,
core/shippedAssets.ts), so dev draws the same bytes production does. A re-exported model is a new hash: "update
available", never a silent change to old projects. An asset that carries its hash fingerprints by the hash alone
(`partFingerprint`), so the same part reads the same as bytes, as a folder file or as a reference.

The writers (folder, `.oip`, shelf) ask `editor/parts/shippedAssetCache.ts` for the bytes synchronously and write
`assets/<sha256>.*`. The cache fetches and hash-checks them when a part enters the library. An asset whose bytes
have not arrived yet is written as its reference until the next round. Read back, bytes the app ships are held as
a reference again (`referenceShippedAssets`), which keeps the autosave light.

The cargo assets the renderer loads by path (the box's and the pallet's textures) are not part assets.

**A source model is removed from `public/` once no current part names it, but its baked bytes are kept for good.**
An older copy may name an asset by source path (`/models/Diverter.glb`) rather than by baked file. The app
fetches that path from the baked file it last shipped for it (`shippedFetchUrl`, src/core/shippedAssets.ts), whose
entry in the baked table and file in `public/part-assets/` are kept for good. The copy itself is never rewritten:
its fingerprint reads the path, so a rewrite would report the part as edited. So when a part is redrawn in code,
its model and textures are deleted in the same change. `scripts/check-orphan-models.mjs` fails the build until the
model is deleted. It checks GLBs only, so textures must be deleted by hand. `e2e/verify-retired-model-sources.mjs`
proves the old copies still draw (the Diverter's model and the six-axis robot's suction tool are two such sources).

## Rooms

A room carries copies of the parts in it, built-ins included, so definitions agree across peers. Each package
travels in the Y.Doc as one JSON `blob`, re-sent whole when it changes (`src/collab/schema.ts` `packageFields`).
Embedded asset bytes in that blob would be re-sent with every change, and a reference with no hash would resolve
against each peer's own app, so two app versions could draw different models in one room.

**Embedded asset bytes do not enter the Y.Doc.** An editor writes an embedded asset into the package's `blob` as
`{ ..., room: <sha256> }` in place of `data` and uploads the bytes to the collab server's asset store. A peer
fetches each hash once and caches it, and reads the asset back exactly as written, so a package is equal on every
peer. Both directions stay synchronous for the schema. The upload is queued and retried, and a package whose bytes
have not arrived is left out of the read until they do (the bridge handles a part whose package comes later). A
first-party asset is a `url` with a `sha256` ([Shipped asset bytes](#shipped-asset-bytes)), which every app version
serving that hash has, so it travels as it is.

- Client: `src/collab/roomAssets.ts`, hooked into `schema.ts` `packageFields` / `packageFromMap`; configured in
  `main.tsx` when a room boots (viewers fetch, only editors upload).
- Server: `server/assets.mjs` on the collab VM's own disk (`/var/lib/oip-collab/assets`):
  `GET /assets/<sha256>` public and immutable, `PUT` only with a room's edit secret, capped per file and per IP per
  hour, CORS + CORP because `/app/` is cross-origin isolated, swept daily once no stored room or snapshot names an
  asset. `backup.sh` mirrors the folder (add-only). See `server/DEPLOY.md`.
- Deploy order does not matter. An editor writes hashes only after a probe finds the store (its answers carry an
  exposed `X-Oip-Asset-Store: 1`). Against a server without it, the editor keeps embedding.
- Mixed builds: a client without the asset store cannot read a hashed asset, but it goes view-only in a room a newer
  build has claimed (`claimRoomBuild`), until it reloads.
- Gate: `e2e/verify-collab-room-assets.mjs` (in the curated list).

An update in a room is a library change for everyone in it, which is right (explicit, one part), and it
is allowed: "Use the app's new version", Update all and Keep go out over the room like a part edit, each with its
line in the room's change feed ("Updated “Diverter” to the app's version") so the others know why their part changed
(`store.updateFromApp` / `keepProjectVersion` through `sharePackageChange`). The update prompt shows in a room too,
and Update all says that everyone there gets the change.

## Gates

- `verify-builtin-update`, `verify-project-format3` and `verify-solo-stale-builtin` cover format 5.
  `verify-part-updates` covers the prompt.
- **The old-parts corpus.** It is `test-corpus/parts/<id>/<storedPackageHash>.json`, append-only (`node
  scripts/part-corpus.mjs` after changing a first-party part). `src/sim/partCorpus.test.ts` fails when this build's
  version of a part is missing from it. It loads, validates and runs every version in it for two seconds alone in a
  scene, and what it did must match the digest recorded for that version (`test-corpus/behaviour.json`: cargo to the
  millimetre, joints, lamps, displays and values). Recording only adds a digest for a version new to the corpus (the
  script runs the test with OIP_RECORD_CORPUS=1). One already there is never rewritten. The corpus starts with the
  versions in the repository's initial commit. Digests are recorded on a developer's machine (Windows so far), and CI
  runs the same test on Linux (`npm test` in ci.yml). So CI fails when Linux does not reproduce a digest recorded on
  Windows. That is the one cross-platform check of the sim's results. It holds because the digest's units are coarse
  (cargo to the millimetre) and Jolt runs as the same WebAssembly build on both.
- `verify-oip-complete`: a placed Diverter draws from `/part-assets/` and never the raw `/models/` file, and an
  exported `.oip` holds its model as `assets/<sha256>.glb`, byte-identical to the shipped bytes, with no URL, and
  reads back as the same part.
- `verify-collab-room-assets`: a room's Y.Doc holds no asset bytes.

## Part libraries

A part library is a third source, with its own `origin` key (`library`). Because a project holds its own copies,
assets included, a part moving from the app into a library changes no project. Models a user imports go in
unoptimized, since the optimizer only sees `public/`. Design: [part-libraries.md](part-libraries.md).

## Rules in short

1. **Nothing is special about built-ins.** They are copied, stamped and updated like any other part, never supplied
   by the app by id.
2. **Updates are explicit only**, with an open-time prompt and Update all. There is no automatic mode: it would be a
   second policy, and the app cannot tell a delivered line from one still being built.
3. **A copy carries its assets**, as files named by content hash, with no exception for assets the app ships. One part
   layout is used everywhere a part is stored. Asset bytes never enter a room's Y.Doc.
