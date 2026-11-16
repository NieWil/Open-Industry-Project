# Projects

A **project** is one machine: a scene and the PLC program that runs it, plus the project's parts and its tests.
This doc covers what a project is and how it is stored, as one document or as a folder. A folder is read through
its manifest, and the same data travels as one `.oip` file.

**A project holds one scene.** Nothing runs or refers across scenes, so several scenes in one project would be a
bundle of unrelated simulations. Two levels, project and scene, would also mean two "New" buttons with opposite
effects and two dropdowns. A format 1-3 document can hold several scenes. It still reads, and splits: see
[Splitting an older project](#splitting-an-older-project).

## What a project is

A `ProjectJSON` (`src/core/project/project.ts`) is a manifest over pieces that already exist:

```
ProjectJSON {
  version                    // 7 (1-6 accepted + migrated on load, splitting a multi-scene one; only 7 is written; 6 = asset files, 7 = program files)
  name
  scene: SceneJSON           // the layout; its parts name their packages by id, and it carries no copies;
                             //   also its Units and its controllers (plcs, src/plc/DEVICE-IO.md)
  stProgram?, stScanMs?,     // the PLC program and its cycle time
  controller?, stDialect?    //   its task table; stDialect is a compatibility marker (below)
  simHz?                     // the physics step rate (below)
  packages?: PartPackage[]   // the project's parts: every definition it uses, built-in copies included (format 5)
  tests?: TestSpec[]         // the project's pass/fail criteria (docs/project-tests.md)
}
```

The machine's fields (`scene` through `simHz`) are `ProjectMachine` in the code. A format 1-3 document holds a
`scenes` list of them, each with an `id` and a `name` of its own, and an `activeScene` index says which was open.

An older document may carry named groups of parts (`assemblies`, and `assemblies/<id>.assembly.json` in a folder).
It reads: they are left out and the load's repairs say so, and copies already placed are ordinary parts in the
scene. A folder's listed assembly files are never opened, and the next save stops listing them.

The main design choices:

1. **Each part definition is kept once, in the project's parts, which are complete (format 5).** The
   project's parts (`packages`, registered authoritatively when the project opens) holds the project's own copy of every
   part its scene places, built-ins included, and of the parts those name. A built-in's copy is stamped
   `origin.app` with the fingerprint of the app version it was copied from. The app can then say when its own
   version changes, and it never changes the project by itself ([part-sources.md](part-sources.md)).

   The project's scene carries no copies. Copies exist only where a scene leaves the project: a standalone scene
   file, a room, and the live scene the editor opens. `store.applyProject` rebuilds that scene from the project's
   parts (and, for an id the project lacks, the app's built-in), so the sim worker, a room and an export see a
   self-contained scene.

   `keepDefinitionsOnce` completes the project's parts on every read and write. `missingLibraryCopies` copies in a
   built-in the project's parts lack, stamped. It also moves an older document's scene copies out:
   - a copy whose id the project's parts have is dropped;
   - a built-in copy with no `origin.app` (a placement snapshot from format 2) gives way to the current built-in;
   - any other copy joins the project's parts.

   An unstamped snapshot is never adopted as the project's own, since it would shadow the app's version with
   nothing to say so ([part-sources.md](part-sources.md#the-rule)). A built-in is recognised by the host's
   declaration (`partRegistry.builtInPackage`: the editor's bundle, a CLI through `scripts/lib/builtIns.mjs`),
   never by its id, so a host that has declared none changes nothing. A build that reads only up to format 4
   refuses these projects.

2. **The PLC program is the project's.** It carries its `stProgram` and `stScanMs`, the cycle time it was
   authored at. The cycle time is part of the program, so it travels with it.

   **A project can run several programs on tasks.** Its `controller`
   ([core/controller.ts](../src/core/controller.ts)) is a table of tasks (`name`, `intervalMs`, `priority`) and
   program instances (`name`, the PROGRAM `type`, `task`). An instance with no `task` runs continuously. The
   instance with no `type` runs the code outside every `PROGRAM`, whose variables are the top-level variables.
   Every POU sees them and they keep their bare names, so a program that gains a `PROGRAM` beside it renames
   nothing. A `PROGRAM` instance's own variables are addressed `Instance.Name` on part tags and in tests. The
   engine appends the CONFIGURATION the table stands for ([plc/controller.ts](../src/plc/controller.ts)).

   The table is part of the program in the same way as the scan time. It is present only with a program, and it
   is carried by the project file, the folder manifest (inline, beside `stProgram`), the scene file and a room
   (the `meta` `stController` key). It is replaced when the program is. It is data rather than text because the
   organizer edits tasks as objects.

   **`stDialect` is a forward-compatibility marker** ([core/dialect.ts](../src/core/dialect.ts)). Absent means
   IEC 61131-3, the only language this build runs. IEC is never written, so no document written without the
   field changes a byte. It travels where the controller table does (project file, folder manifest, scene file,
   the room's `meta` `stDialect` key) and is replaced and undone with the program. Any other value names a
   dialect this build does not have. The document still loads, and the program text is kept unchanged through
   every load and save. The program is refused at run time and never read as IEC: Play reports it instead of
   compiling, Problems and the PLC panel show one plain message, and `check-st`, `check-wiring`, `test-project`
   and `validate-project` fail with the same message.

   **Every program runs from a controller.** A program with no table of its own runs from the default one
   (`defaultController`): `MainTask` every `stScanMs`, running the top-level code as `Main` and each `PROGRAM` as an
   instance named after it. Storing that table renames nothing. A program that is only top-level code runs as the
   implicit program on its scan time, which is the same thing, so its text is what runs. A program that also declares a
   `PROGRAM` runs the default table, so the organizer shows what runs.

   **The organizer** ([PlcOrganizer.tsx](../src/editor/components/plc/PlcOrganizer.tsx)) edits that table from a
   tree beside the code in the PLC panel ([editor/program/plcOrganizer.ts](../src/editor/program/plcOrganizer.ts),
   [plc/taskTree.ts](../src/plc/taskTree.ts)). The tree lists Main (the top-level code), the tasks and the
   program instances each runs, then the POUs by kind, the data types and the global variables. Double-clicking a
   task or a program opens a properties dialog
   ([ControllerPropertiesDialogs.tsx](../src/editor/components/plc/ControllerPropertiesDialogs.tsx)). While it runs, the
   code shows each name's live value as the POU it is written in reads it
   ([plc/watchScope.ts](../src/plc/watchScope.ts)). For a `PROGRAM` that runs as several instances, those are one
   instance's: the first, until another is picked by clicking its row or the chip on the `PROGRAM`'s header, which says
   which one is shown. The pick is a view, not part of the document.

   There is no separate Controller dock. The tree's first node, Controller, holds Main. Its properties are the
   scene's controllers ([ControllerDialog.tsx](../src/editor/components/plc/ControllerDialog.tsx)): which the program
   here runs, which are PLCs and how Play reaches them, saved in the scene (`SceneJSON.plcs`). Each PLC's address
   is a machine setting kept in the browser, never in the project ([src/plc/DEVICE-IO.md](../src/plc/DEVICE-IO.md),
   "Several controllers"). While Play connects a PLC, the toolbar shows the link's state beside Play and Stop
   ([PlcLinkStatus.tsx](../src/editor/components/plc/PlcLinkStatus.tsx)).

   A program with no table sees the default one, and its task interval is where the scan time is edited.
   Retiming the default table sets `stScanMs` and stores no table. "+ Program" asks for a name, then adds a
   `PROGRAM` and runs it on the first task (or the task it was asked on). It stores the default table first when
   there is none.

   Every edit is a pure function in [plc/controllerEdits.ts](../src/plc/controllerEdits.ts) that returns the
   next table and the tags it renames. Only renaming a `PROGRAM` instance, or the type it is named after,
   renames tags. [editor/program/controllerCommit.ts](../src/editor/program/controllerCommit.ts) applies the table, the program
   and the parts' tag parameters ([editor/program/controllerRewire.ts](../src/editor/program/controllerRewire.ts)) as one program
   edit (`store.commitProgram`). None of it goes through the code editor, which is a lazy chunk that may not have
   loaded yet. A mounted editor catches up. A program whose text declares its own CONFIGURATION runs from it, and
   the panel offers to move its tasks into the table. Gated by
   [e2e/verify-st-controller.mjs](../e2e/verify-st-controller.mjs).

   **Live, the program is store state** (`EditorState.stProgram` / `stScanMs` / `controller`). Everything reads
   it there: the run edge, the scene exporter, the room seeder, the project autosave and the ST panel. A sink
   decides where it is kept durably: the shared Y.Text in a room, or the working copy when solo
   (`store.setStProgramSink`). There is one owner because readers that consulted different stores could seed a
   room with a layout and no logic. See `EditorState.stProgram` and the eslint boundary on `stProgram.ts`.

3. **The physics step rate is the machine's.** `simHz` (whole Hz, 60 to 1000; absent = 60) is how often the
   world steps. It sets how often sensors sample and the soonest a PLC output can follow the input that caused
   it. It is part of the machine, like the scan time, and kept with or without a program. It is set in the
   Inspector with nothing selected, and a new project starts at 60. A standalone scene file carries it
   (top-level `simHz`), and opening one takes its rate, 60 when it names none. It is written only when it is not
   60. A format 1-3 document with a project-wide rate hands it to every scene that names none on load. Live it is
   `EditorState.simHz`, kept through `store.setSimHzSink` in a room (the `meta` `simHz` key) and in the project
   doc solo. The demo preview runs at 60 and cannot change it. The run edge and the project test runner read the
   same field, so a test steps the same machine Play does. The reason for the 60-1000 range is in
   [sim-clock.md](sim-clock.md).

## The seam (keeps the rest of the app project-unaware)

The store, render and PLC layers consume a standalone `SceneJSON` and a program string. Two functions bridge:

- `projectToScene(project)` → `{ scene, stProgram, stScanMs?, controller?, stDialect?, simHz }`: the scene's
  parts with copies of every package they use (the project's own and the built-ins') as `scene.packages`. The result
  is a self-contained standalone scene, plus its program.
- `sceneToProject(scene, stProgram, name)`: wraps a lone `scene.json` into a project. Its embedded packages are
  given up like an older project's (`keepDefinitionsOnce`). Import Project uses it too, so a scene file opens as
  a project of its own.

Validation reuses `validateScene` for the scene. A `SceneJSON` resolves against its own copies if an older
document has any, the project's parts over them, then the app's built-ins, and a part naming none of these is refused by
name. So projects inherit every per-part clamp, the one-building rule, and the v1/v2→v3 conveyor-origin migration
with no extra code.

## Serialization: one layout, two presentations

- **`.oip` file = the project folder, zipped** (the `.docx` model; `core/project/projectArchive.ts`). Unzip a shared
  `.oip` and you have the editable folder. Zip a folder by hand and it imports the same way. Encoding is
  byte-reproducible (fixed entry mtime). Import re-bakes part folders through the canonical validator, so a
  broken `behavior.js` fails the import with located diagnostics. Flat-JSON `.oip` documents (an older export
  format) still import, and the two forms are told apart by content. fflate loads lazily, so the archive path
  adds nothing to the main bundle.
- **Folder on disk:** the same layout unzipped, for git, VS Code, agents and editing the project's parts
  (see below).
- `serializeProject`'s flat JSON is the internal form of the browser working copy.

The same data model is used everywhere ([architecture.md](./architecture.md)). In project format 6 a part's
embedded assets are real files beside its manifest, `parts/<id>/assets/<sha256>.glb`, named by the hash of their
bytes (`core/parts/partAssets.ts`). The folder codec, the `.oip` and Put on Shelf write them. Every host that reads a
part folder joins them back into base64 `data` before baking: the codec, the `.oip`, the desktop folder IO and
sync, the browser folder link, the CLIs, the shelf and a folder import (Import part > A folder of parts…). Nothing else in the app sees the
difference. A missing file, or one that does not hash to its name, fails the open. In memory, and in the browser
autosave, a room and a scene file, assets stay base64. `url` assets (a built-in copy naming an app-served model)
are untouched ([part-sources.md](part-sources.md) "Assets").

### The project folder

`src/core/project/projectFolder.ts` is the folder codec, a pure split view of the `.oip` document. Files are
`{path, contents}` data with no filesystem access. The Electron shell, the validate CLI and the tests share it:

```
project.json                 thin manifest: name + file refs + the program's small settings (no content)
scene.json                   the project's SceneJSON (its parts; no package copies)
plc/<Name>.st | .ld          its PLC program as plain text, one file per POU, in the order `program` lists them
parts/<id>/manifest.json     each of the project's parts, built-in copies included, in the parts-workspace two-file
parts/<id>/behavior.js         layout (manifest without baked fields + the raw script)
parts/<id>/assets/<sha256>.* its embedded assets as files named by their hash (format 6; see above)
tests/<name>.test.json       each project test
```

A folder from before format 4 lists `scenes` (`scenes/<id>.scene.json` + `scenes/<id>.st`). It still reads, and
splits (below). The browser reader imports the root files (`PROJECT_ROOT_FILES`) and subdirectories
(`PROJECT_SUBDIRS`, `scenes/` only for reading an older folder). The desktop shell's walk
(`apps/desktop/projectFolderIo.cjs`, which every CLI reads through `scripts/lib/projectFolderFiles.mjs`) keeps a
copy that `projectFolder.test.ts` pins.

Under `parts/`, the app reads and writes only those three kinds of file. Anything else there belongs to the
author: a `part.js` that `npm run build-parts -- <folder>` turns into a part's `manifest.json` and `behavior.js`,
shared modules in `parts/_shared/`, notes (core/project/projectFolder.ts `isPartSourceFile`). The folder sync leaves them
out of every round, so it never writes, loads or removes one, and removing a part removes only its own files
([part-authoring-guide.md](part-authoring-guide.md#writing-a-part-as-one-partjs)). The parts themselves are
ordinary project content: the two-way folder sync below writes them and reads outside edits back, so a
`behavior.js` edit on disk is re-baked and reaches the running app like any other changed file. The shell keeps
no parts of its own and watches no parts folder (`apps/desktop/main.cjs`). `partsWorkspace.cjs` scans only a
folder picked for **Import part > A folder of parts…**.

#### The program as files (format 7)

The program is one string in memory, in a room and in a `.oip` document's JSON. Only the folder (and so the
zipped `.oip`) splits it, one file per top-level block under `plc/`. A diff, a merge or a folder conflict then
touches only the POU that changed, and a file's name says which grammar it is in. `plc/programFiles.ts` names the
files:

- A POU, an `INTERFACE` or a `CONFIGURATION` is named for what it declares (`plc/PalletTruck.st`). A block that
  declares no name is named for its keyword (`plc/type.st`, `plc/var_global.st`, and `plc/program.st` for the
  code outside every POU). A keyword is never an identifier, so these cannot collide with a POU. A name that
  differs from another only in case takes a `-2` suffix, since some file systems do not tell them apart.
- A block holding a `LADDER` section is `.ld` (our text form, [ladder.md](ladder.md)). The rest are `.st`, so a
  `.st` file is plain Structured Text an outside ST tool can read.

The manifest's `program` lists the files in order, and reading joins them in that order. The order is the
program's, for three reasons. Without a controller table, PROGRAMs run in the order written. A global CONSTANT
sizes an array only when written above it. The code outside every POU must come after every declaration.

Several files are written trimmed and joined by a blank line (`joinProgramFiles`). That is the document model's
normal form (`flattenDocument`) with a closing newline, so a program round-trips to that form, and folder →
project → folder is exact. One file holds the program byte for byte in three cases: a program of one block,
source the block split cannot read (a POU half typed), and a program in a dialect this build cannot read
(core/dialect.ts), which is never split.

The splitter is injected (`FolderOptions.splitProgram`, the editor's `FOLDER_OPTIONS`) because core cannot import
the PLC engine. A writer without it writes the program as `plc/program.st`, which every reader also takes.
`check-st` checks a project's files as the program they make and reports each error at its file and line
(`programFileOffset`).

A folder from formats 4-6 keeps the program in one `program.st` (the manifest's `stProgram`). It reads, and the
folder sync lays it out on its first round. A folder can name program files other than the ones the app writes:
that old file, or POUs an agent put in one file. When it does, the manifest and those files read as changed in
the app. The round writes the app's files and removes the folder's others, guarded like any write
(`layoutBaseline`). Treating the difference as a rendering difference would lose a later program edit,
because the app's per-POU files are not named by the folder's manifest. Tests get the same treatment: the app names
each test's file from the test's name, so a folder that lists `tests/sort.test.json` for a test called "Sort by
colour" is relaid as the app's file, and the old one removed. Otherwise an edit made in the app would go to a file
the manifest does not list, and the next open would read the stale test.

The ST program and every part behavior are real text files, so PLC and part logic can be reviewed. Loading is
manifest-driven, so stale or extra files are ignored rather than fatal. Reassembly goes through
`validateProject`, so a folder edited by hand or by an agent gets every clamp and migration an untrusted `.oip`
upload does.

A part folder is the parts-workspace format that **Import part > A folder of parts…** scans (`partsWorkspace.cjs`, which
can read a project's `parts/` directly). `manifest.json` omits the fields baked from the behavior (`params`,
`format`, `interactive`, `snap`; `core/parts/partPackage.manifestOfPackage`), so the script is the source of truth.
Rebuilding a part therefore runs the behavior once. Core's codec stays execution-free by taking an injected
`PartBaker`, and the app and the CLI inject `sim/validatePart`. So **an edited `behavior.js` is re-baked, and its
syntax, determinism or param errors fail the open with located diagnostics** instead of loading an inert part.

**Headless validation** (the CI, pre-commit and agent seam):

```
npm run validate-project -- <project-folder | project.oip | scene.json>
```

runs the real core validators via vite SSR (exit 0/1), so an externally edited project can be checked without
launching the app.

In the Electron shell, **File → Open Project Folder… / Save Project to Folder…** move raw files over IPC
(`apps/desktop/projectFolderIo.cjs` does the fs work, and `src/editor/desktop/desktopProjectBridge.ts` owns the flows).
The shell holds no rules of its own about the format. Open writes the folder's project as the working copy and
reloads into it, through the same boot path every launch uses. Swapping the project in place would have to repeat
that boot by hand: retire the old project's authoritative part registrations, replace `userPackages`, refresh the
catalog, and rebuild the scene and the sim. A missed step would leave a stale definition shadowing the one in the
project's parts. The reload reuses the one tested boot path. The web gets the same document as
**Export / Import Project (.oip)** in the project menu (the project folder, zipped;
`projectFile.downloadProject` / `importProjectData`, adopted through the same seam).

### The folder is the project (two-way sync)

A project that lives in a folder is kept in sync with it both ways. Every edit is written back a moment after it
is made. Anything else that changes the folder, such as an agent, an editor or a `git checkout`, is loaded in. So
git, backups and agents see the folder, not the app's private storage. One engine
(`editor/project/projectFolderSync.ts`) runs on two hosts:

- **Desktop**: every project lives in a folder. The Electron shell moves the files
  (`desktopProjectApi.ts` → `apps/desktop/projectFolderIo.cjs`).
- **Browser (Chrome/Edge)**: a project lives in a folder once it is linked (**Link Project Folder…**, which
  opens the folder's project as its own document) or saved to one (**Save Project to Folder…**).
  `projectFolderLink.ts` adapts the File System Access handle to the same `FolderApi`, with the same guarded
  writes. The handle is remembered per document. After a reload the browser may ask for edit permission again,
  and the banner offers **Reconnect**. A link remembered from an older one-way sync resumes once, taking the
  folder's version. A page cannot write synchronously as it unloads, so the last few hundred ms of edits reach
  the folder on the next visit (the working copy has them). A page being hidden writes what is pending. Safari
  and Firefox have no real-folder picker: their projects live in browser storage, and **Export Project (.oip)**
  is the way out.

How a round works:

- **Decisions are per file, against a baseline** (`core/project/folderSync.ts`, pure). A file changed only in the app is
  written. A file changed only on disk is loaded. A file changed in both, differently, is a **conflict**, and
  nothing moves until the user picks "Use folder version" or "Keep my version" (`FolderLinkBanner`). Loading and
  writing can happen in the same round when they touch different files.
- **There are two baselines**: what the disk held and what the app rendered, the last time they agreed. The
  store's rendering of a file is not always byte-identical to the file (defaults it fills in, an agent's JSON
  formatting). With one baseline that difference would read as an edit. Opening an agent's folder would rewrite
  every file, and every later sync would look like a conflict to the agent. Baselines are hashes (`hashText`,
  cyrb53), persisted per document.
- **Every write is guarded** (`apps/desktop/projectFolderIo.cjs` `applyFolderWrites`, and the browser twin in
  `projectFolderLink.ts`). A file is replaced only if it still hashes to what the app last read. An agent writing
  the same file at the same moment is reported back, never overwritten, and the next round calls it a conflict.
  Writes go through a temp file and a rename, so a reader never sees half a file (`createWritable` does the same
  in the browser). On the desktop they retry the brief locks OneDrive and antivirus take on Windows. The browser
  API has no compare-and-swap, so there the guard narrows the window to milliseconds rather than closing it.
- **A folder that does not reassemble holds everything.** This is usually an agent halfway through a multi-file
  write. The working copy keeps every edit meanwhile, and the round resumes when the folder changes again.
- **The scene on screen keeps its undo history** unless a load touched its own files (`scene.json`, any program
  file), the manifest's machine fields, or any part (`sceneUntouched`).
- **Timing**: the folder's fingerprint (paths, sizes, mtimes) is checked once a second. Writes go out 800 ms after
  edits pause (at most 4 s after the first), and synchronously as the window closes (`project:writeSync`). The
  working copy is still written on every commit and is what boot opens, so it is the crash buffer.
- **The shell keeps which document lives where** (`apps/desktop/folderRegistry.cjs`,
  `userData/project-folders.json`): folder path, fingerprint and baselines per document id. Main holds it for
  three reasons. Main builds the menu that lists it (**File → Open Recent**). A write from main is synchronous,
  so the last write before quitting is recorded. It survives a cleared renderer profile. Opening a folder the app
  already knows re-opens that document, so one folder never becomes two projects.
- **A project with no folder gets one on its first real edit**: an undoable edit, not the app's own boot-time and
  snapshot saves. The folder is `Documents/Open Industry Project/<name>`, made without asking, and a toast says
  where once. A profile launched with its own `--user-data-dir` (every e2e gate) keeps new projects inside that
  profile instead, and `OIP_PROJECTS_DIR` overrides both. **Unlink** detaches on purpose: the project stays open,
  app-only, and the shell remembers not to hand it a new folder.

A folder named on the command line (`electron . <folder>`) opens at launch. The app is one process per profile, and
a second launch naming a folder opens it in a window of its own, or brings forward the window that has it open
([desktop-shell.md](desktop-shell.md#several-windows)). Double-clicking a `.oip` (or a `.oippart`)
opens it in the desktop app: the installer registers both, and the file is imported as File > Import Project (or
Import part) would, never edited in place ([desktop-shell.md](desktop-shell.md#project-and-part-files)).

Gated in the Electron shell by `e2e/verify-project-folder-sync-electron.mjs` (first edit makes a folder, edits in
both directions, a real Ctrl+S, a conflict, Open Recent, a restart with the folder changed while closed, the projects
list, unlink) and `e2e/verify-project-folder-electron.mjs` (save, on-disk edits load, a live `behavior.js` reload).
In Chromium, `e2e/verify-browser-folder-sync.mjs` drives a real OPFS directory handle round by round,
`verify-browser-save.mjs` covers Save, and `verify-folder-link-persist.mjs` covers the reload half with a stand-in
handle, because an OPFS handle stored in IndexedDB crashes the browser on reload.

## Projects list, project menu and Save

**The projects list is the desktop's project manager** (`ProjectsOverlay`). Each row shows its folder and can reveal it.
Opening a row reads the folder, not the document library's copy, which can lag it by a few seconds. New project makes
its folder first. Removing a row leaves the folder on disk. There is no launcher window in front of the editor: the app
opens on your last work.

**The project menu is the top bar's one document control** (`ProjectMenu.tsx`). Its label is the project's name,
or "Palletizing demo" with an Example badge while the demo is open. It holds the project's actions: New Project
(Ctrl+N), the projects list, Save, Import / Export Project, Open Demo. A "Recent projects" block lists up to
four other projects, the ones changed last, and a click opens one as its row in the projects list does
(`openStoredDocument`). There are no scene actions in it, because a
project holds one scene (format 4), so project and scene actions never sit side by side. New
always means a new project, filed beside the one you leave. No action empties the current scene. New Project
starts over without destroying anything, and select + Delete starts over in the same project, keeping its parts
and tests.

**"Scene" in the UI means the 3D world inside a project, never a file.** There is one way in, Import Project…
(Ctrl+O), which opens an `.oip` or a scene `.json` alike as a project of its own. There is one way out, Export
Project (.oip)…. There is no Export Scene, because a trimmed project under that name would make a scene look like
a file of its own. Trimming is a choice inside Export Project (`ExportProjectDialog`). When the project carries
something the scene does not show (custom parts nothing uses, tests), it asks which to include, all ticked. A
backup is whole unless someone unticks something, and leaving them out sends a job without the rest of the
project's parts (`trimForExport`). With nothing to choose it downloads at once. Scene files still import, and the
CLIs and agents read them, but no menu writes one. The part editor is "Open Part Editor" / "Close Part Editor" for
the same reason: a workspace for one part is not a scene.

**Save (Ctrl+S, and Save in the project menu) is the project Save on every surface** (`file.save`,
`editor/project/saveProject.ts`). The project already saves itself, so Save writes what is pending and says where the work
is:
- with a folder, it writes at once and confirms "Saved" only once the folder has it (a conflict or a folder error
  answers with its banner instead);
- in the browser without a folder, it says "Saved in this browser" with a **Download a copy** button (the whole
  project as an `.oip`);
- in a live room, it says that the room saves as everyone works.

On the desktop a project with no folder gets its default one, and one unlinked on purpose gets the Save to Folder
picker. On the demo preview Save keeps a copy first. The app binds Ctrl+S (`core/keymap.ts` `file.save`,
`App.tsx`), from text fields too, because otherwise it would reach the browser's own "Save page as". Save never
downloads a file on its own. **Export Project (.oip)…** is the way to get a file.

## The demo and the tutorial

**The demo is a project of its own: the built-in example.** It is listed under Examples in the projects list.
Open Demo (or that row) opens it like any project: the one on screen is saved and filed, and the page reloads into
`/app/?scene=demo`, the boot that builds the demo from this build's source every time
(`sceneFile.openDemoScene`). It is read-only until edited, and nothing of it is saved before that. Leaving it means
opening another project (`sceneFile.leaveDemo` reloads into the one it was opened from). The boot keeps the
working copy's project as the store's, unloaded (`loadProject` adoptOnly). So the first edit can make the demo a
project of its own ("Palletizing demo", numbered past any already in the list) without a reload. The user's own
project stays filed and untouched, and its folder is released (`store.stashDemoSession` + `demoFork.ts`,
`documentStore.forkCurrentDocument`). Open Demo leaves a room, since the demo is the browser's own.

The tutorial runs in the open project when it is blank (no parts and no program). Otherwise it creates a
"Tutorial" project and reloads into it (`TutorialOverlay` `beginFreshRun`; a one-shot sessionStorage mark starts
the tour across the reload). Resuming a run parked in another project opens that project. Where no project can be
created (a room, a view link, a browser that keeps one project), the tour does not start and says why.

Gated by `verify-demo-scene-copy`, `verify-demo-fork-electron` and `verify-tutorial-scene-binding`.

## Splitting an older project

A format 1-3 document may hold several scenes. Every reader goes through `validateProject`: the working copy, a document
in the browser's document library, an `.oip`, a folder. `validateProject` keeps the scene that was active as the
project, under the project's name. It returns every other scene in `splitOff`, each a project of its own named
"<project> - <scene>" (`splitOffName`), with the tests that named it. A test naming no scene stays with the kept
project. The kept project keeps all of the project's parts. A split-off project carries copies of only the parts its own
scene places (`usedLibraryOnly`), so a part one scene never used does not travel with another's files and exports. The
one real loss is sharing: after the split, editing a custom part in one project does not change it in the others.

Nothing may save over the source until the others are safe, so whoever reads such a document parks them first
(`projectFile.parkSplitOff`, the `oip-web/split-off` key). Three readers do this: the boot parks them for the working
copy, an import or an opened folder parks them before its reload, and opening a document from the document library
parks them too. Opening such a document also rewrites its record as the one scene it keeps, so it does not split
twice. The next boot files what is parked
(`editor/project/projectSplit.ts`):

- **Desktop, the project lives in a folder:** one question, listing the folders it will make. Yes: each scene gets
  a folder of its own beside the project's (`createFolder(name, beside)`, only beside a granted folder). The
  project's folder is rewritten in the format-4 layout, and its moved `scenes/` files are removed (guarded writes).
  No: the session goes read-only, nothing is written, and the next launch asks again. The folder sync waits for
  this (`splitFiling()`), because its first round would otherwise remove the moved scenes' files before their
  folders exist.
- **Anywhere else:** each becomes a document in the projects list, and a notice names them.
- **A browser with no document library:** they stay parked, and the notice offers each as a `.oip` download
  (`file.exportSplitOff`).

Two places refuse rather than split. A folder that becomes a multi-scene project under the running app (a
`git checkout` of an old commit) is held by the folder sync, not loaded, with a banner saying to reopen it. A
browser folder link refuses a multi-scene folder outright, because a browser cannot make the sibling folders and
would otherwise move those scenes into its own storage. The CLI checks (`validate-project`, `check-wiring`,
`check-layout`, `test-project`) are read-only: they report the split, and check or run each part as the project it
will be. `add-part` writes into a folder, so it refuses an older one until the app has converted it.

## The browser working copy

In the browser the project's working copy is the open document's row in the document library: IndexedDB `oip-web`,
`docPayload` (`src/editor/project/projectFile.ts` and `libraryDb.ts`; store `persistProject` / `adoptProjectLibrary`).
It holds the scene, its ST program and the project's parts in one document, as compact text, and the `main.tsx` boot
opens it. There is no second copy of the open project in the browser: the projects list shows the same row.

**Each tab has its own open document.** The pointer to it is `oip-web/document-id` in the tab's sessionStorage, which
survives the reload a switch makes. localStorage keeps the document opened last, and a new tab starts on that one
(`libraryDb.pinTabDocument`). So two tabs can work on two projects at once. Each tab also holds a shared Web Lock
named for its document, which the browser releases when the tab closes. The projects list reads those locks to mark a
row "open in another tab", and it does not delete or rename that row, since the other tab's next save would undo it.

- **Saving.** `saveStoredProject` is synchronous for its caller, like every edit's commit. It keeps the text in memory
  and queues the row write, one at a time, the latest replacing any still waiting. A save of exactly what is stored
  writes nothing. A failed write raises the autosave banner (`onWorkingCopyWrite`, main.tsx), and every save after it
  reports the failure until a write succeeds.
- **A save lands a moment after the edit.** A page that is hidden or closed first writes what the store holds
  (`flushPersist`). An unloading page's IndexedDB transaction may be aborted, so when a row write is still in flight
  the latest text is also written to localStorage `oip-web/project-journal/<document>`, which is synchronous
  (`keepPendingWrite`). The next boot of that document moves it into the row, and a page that lives on removes it once
  the row commits. A tab that crashes within a few milliseconds of an edit can still lose that edit. A switch, a new
  project, an import and a folder open wait for the incoming project's row to commit before they reload
  (`flushWorkingCopy`).
- **Boot reads the row first** (`openWorkingCopy`), with the bytes of every model it names, and then opens it
  synchronously (`loadStoredProject`). A boot with no pointer, or a pointer with no row, opens what the single-scene
  keys hold, or a default scene, and its first save gives that a record of its own.
- **Moving in from localStorage.** Earlier builds kept the working copy in localStorage `oip-web/project`. The first
  boot with IndexedDB writes it into the open document's row and removes the key once the row has committed. If a
  save of it had been refused for quota (`oip-web/project-behind`) and the row was written after that, or it names
  models whose bytes are gone, the row is kept instead, since it holds what the key lacks. A key that does not open is
  left where it is and refused as below. A browser without IndexedDB keeps the working copy in localStorage, written
  synchronously.

**The single-scene keys are a fallback.** The store also writes `oip-web/autosave` and `oip-web/st-program` (the
scene one throttled). It does not write `oip-web/user-packages`, because a copy of all the project's parts, embedded
models included, on every change would duplicate what the project doc holds. That key is read only when boot
builds a project doc from the single-scene keys, and is dropped once the project doc is written. Boot prefers the
project doc. If it is absent, boot builds one from the single-scene keys, and if those are absent too it loads a
default scene. So a fault in the project path loses no data.

**A project doc that is present but refused is never replaced.** `validateProject` is all-or-nothing: one bad scene,
package or test refuses the document. Saving the fallback above over it at boot would lose it. So `loadStoredProject`
records the refusal (`projectFile.unopenedProject`). Every write of the working copy is refused while that text is
still there (`saveStoredProject` is the one chokepoint: autosave, import, projects-list switch, folder link), and
nothing is filed over its record. A banner offers Download (the stored text, to fix by hand) or Discard (what is on
screen is filed as a new document, and the old record is left untouched).

**Only one tab writes a document at a time.** Two tabs can have the same document open, and a save writes the whole
document, so without a guard they would erase each other's work silently. IndexedDB raises no event in other
tabs, so each save that changes a document also writes a new stamp to localStorage
`oip-web/project-stamp/<document>`. A session may only write while its document's stamp is the one it last read or
wrote (`saveStoredProject` compares). A `storage` event from another tab carrying any other stamp does the same
(main.tsx). Tabs on different documents never see each other's stamps. The tab that loses stops saving for good,
goes view-only (`store.yieldToOtherTab`), and shows a banner whose Reload makes it the writer again. A save of exactly what is stored keeps the stamp, so opening a second tab on the same
project locks nothing until one of them changes it. Every path that replaces the working copy also files the
outgoing project in the document library first and stops if that fails (`documentStore.fileOutgoingDocument`:
projects-list open/new, linked folder, `.oip` import, desktop folder open).

**Model files in the browser.** Every library row and the legacy scene key name each embedded model or texture by
the SHA-256 of its bytes, `{ ..., localAsset: <sha256> }` in place of `data`, and the bytes are kept in their own
IndexedDB database, `oip-web-assets` (`src/editor/project/localAssets.ts`). A save then carries a few dozen bytes
for a 6 MB model instead of 8 MB of base64. In memory, in a room and in every file that leaves the browser an asset
is still `data`. Rows written by earlier builds embed their models, and are read as they are.

- An asset is written by hash only once its bytes are known to be stored. A model added in the session is written
  embedded the first time, its bytes are queued, and the project is saved again when they land
  (`onLocalAssetsStored`, main.tsx). A tab that closes in between leaves an embedded model behind, never a hash with
  no bytes.
- The paths that replace the working copy and reload (a projects-list switch, a new project, a `.oip` import, a
  linked or desktop folder) store the incoming project's models first (`storeLocalAssets`).
- A row is read with the bytes of the models it names (`loadLocalAssets`). If some are gone the row does not open:
  the working copy is refused like any other document this build cannot open. The bytes and the rows are the same
  origin's IndexedDB, so a browser that evicts storage evicts both.
- Bytes no row names are deleted 30 s after boot, once nothing has touched them for seven days (`sweepLocalAssets`).
  The delay covers another tab that has stored bytes but not yet written their hash, or holds a deleted part in its
  undo history. Nothing is swept when the rows cannot be read.
- Without IndexedDB nothing is hashed, and assets stay embedded as before.

**Workspace state is kept per document.** A remembered camera and a half-finished tutorial run are keyed by
`documentStore.sceneSlotKey(SCENE_SLOT)`: the document id and the constant `scene-1`, the scene id format 1-3
documents use, so state saved for one of those still finds its project. Keyed without the document id, one
project's camera would open in every other project. A camera saved under the bare `scene-1` key is taken by the
first document that asks for it (`storePrefs.readViewportState`).

**A linked folder (browser) is its own document.** Linking opens the folder's project beside the one on screen
without a reload (`documentStore.adoptDocumentInPlace`). It first writes out and releases any folder the app was
already in, so the arriving document can never end up in the folder of the one leaving. From then on it is the
two-way sync above. The scene on screen is reloaded only when a load touched it or the project's parts (the sim is
stopped first). Otherwise it keeps its undo, selection and any in-app edit while the tests and the project's name
update (`store.refreshProject`).
