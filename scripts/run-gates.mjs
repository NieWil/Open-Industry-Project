// Run the e2e GATES - the scripts that must pass - as one command.
//
// e2e/ holds hundreds of scripts, many (e2e/probes/, local `_dbg-*` scratch) never meant to pass
// again, so the directory cannot say which must pass. This is the list.
//
//   npm run gates              curated gates (below), fails the build if any fails
//   npm run gates -- --all     TRIAGE: run every e2e/verify-*.mjs and print a table. Never gates
//                              anything; use it to find which of the fleet has gone stale.
//   npm run gates -- --list    print the curated list and exit
//   npm run gates -- --only=webgpu,draw-budget   run just the matching gates (SUBSET - see below)
//   npm run gates -- --all --json=gate-triage.json   also dump results for tracking rot over time
//
// Every result is CLASSIFIED (see `classify`), not just pass/fail: "could not test" (HARNESS/HUNG/
// SKIP) vs "tested and disagreed" (FAILED, the only class that can be a regression).
//
// Adding a gate: put it in GATES with a one-line reason; `build: true` if it needs dist/ (skipped
// loudly when missing). The runner boots one dev server for the batch (adopting a running
// `npm run e2e:server`, never tearing that one down); a gate needing a fresh server says so with
// `startServer({ isolated: true })`. OIP_GATE_NO_SHARED=1 goes back to a vite per gate.
/* global process, console */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { cpus } from 'node:os'
// Every result carries the conditions it was taken under, and the whole batch queues for the box.
// See e2e/_load.mjs (stamp: works on anyone's processes, needs no adoption) and e2e/_lease.mjs
// (lease: serialises PARTICIPANTS only, which is why the stamp is the one that cannot be skipped).
import { begin as loadBegin, end as loadEnd, formatLoad, looksContended } from '../e2e/_load.mjs'
import { acquireLease } from '../e2e/_lease.mjs'

const E2E = fileURLToPath(new URL('../e2e/', import.meta.url))
const DIST_APP = fileURLToPath(new URL('../dist/app/index.html', import.meta.url))

// Kept short: a gate list is only credible if every entry currently passes. These
// two are the prod-only ones, verified green; grow the list as you confirm
// others (start with `npm run gates -- --all`).
const GATES = [
  {
    script: 'verify-boot-skeleton.mjs',
    why: "first paint: the boot skeleton is on screen with the shell's shape before the app exists, and the handover to the real cover moves nothing",
  },
  {
    script: 'verify-first-load.mjs',
    build: true,
    why: 'first-load ordering: building complete at the reveal, catalog warm yields, renderer chunks parallel',
  },
  {
    script: 'verify-prod-draco-rigs.mjs',
    build: true,
    why: 'prod asset parity: the Draco-compressed rigs render identically to the raw dev GLBs (dev side is a recorded baseline - `npm run regen-rig-baseline` after a model change)',
  },
  {
    script: 'verify-retired-model-sources.mjs',
    why: "an old project still draws a part whose source model left public/: a pre-bake copy names its model by path, and is fetched from the baked file (shippedFetchUrl). Without it, deleting a converted part's model (which the orphan check demands) would blank those parts in every old project",
  },
  {
    script: 'verify-sw-navigation.mjs',
    build: true,
    why: "the service worker answers /app/ navigations ONLY: it is scoped to the whole origin, and its old denylist fallback served the editor for the landing footer's license links and every typo'd URL. The one gate that lets the worker install (the rest block it)",
  },
  {
    script: 'verify-webgpu-warm-completeness.mjs',
    why: 'the WebGPU pre-warm must compile the scene BEHIND the cover - a faster cover that just moves compiles past the reveal reads as a win everywhere else (cover-holds passes on both arms)',
  },
  {
    script: 'verify-scene-swap-cover.mjs',
    why: "a scene swap after the first load (Demo, a scene tab, Open) is covered while it assembles and ONLY then: guards against the demo building itself in front of the user under WebGPU, over ~6 s, one pipeline kind at a time. Guards both directions, since a cover on a swap that draws at once is a flash of the logo",
  },
  {
    script: 'verify-layout-check-ui.mjs',
    why: 'the layout check must stay REACHABLE: `npm run check-layout` needs a repo checkout, so this dialog is the only way the one seam that catches bad placement gets in front of the person who owns the project',
  },
  {
    script: 'verify-building-visibility.mjs',
    why: "building Floor/Walls/Roof params change pixels - the retained layers (bundle, sub-pass cache) bake visibility",
  },
  {
    script: 'verify-wall-autohide.mjs',
    why: 'the near-wall auto-hide drops perimeter runs PER SIDE, and the granularity is the whole point - at facing-half granularity (what the old wall lighting bucketed by) a corner view hid all four walls. Also audits the merge mechanisms across the flips, which is where the roof auto-hide shipped a permanent staleness',
  },
  {
    script: 'verify-wall-baked-shadows.mjs',
    why: 'the baked wall light fails SILENTLY - an unloaded lightmap, a stripped second UV set or the wrong world facing on a turned building costs no error, just flat or mis-lit walls. WebGL always, plus WebGPU where Edge is installed'
  },
  {
    script: 'verify-mobile-quality.mjs',
    why: 'the mobile tier is a whole second render path (single pass, no MSAA, clamped shadows) that no other gate exercises - a wall casting into the main sun there once striped the interior floor on phones only, invisible everywhere else',
  },
  {
    script: 'verify-webgpu-mobile-singlepass.mjs',
    why: "the mobile tier's single-pass field went unhonoured on the WebGPU path for months, and nothing else looks at it. Also holds that the baked walls draw on both tiers and never cast into the sun (casting framing stripes the interior floor)",
  },
  {
    script: 'verify-bench-mode.mjs',
    why: 'the device benchmark is how a real phone reports back (editor/bench.ts), and every way it breaks is SILENT: a camera it stops driving, a window it stops closing or an override it stops honouring all still produce a confident-looking blob. Cheap to run, and the numbers it collects decide the mobile defaults',
  },
  {
    script: 'verify-idle-pose-beam.mjs',
    why: "a beam on a link a stopped pose moves (the idle preview, Use while stopped) must be drawn from where the link now stands: the stopped beam probe reruns only on a scene, cargo or registry change, so a lift's deck eye stayed drawn at the lower level. Fails without the re-probe in view.applyIdlePose",
  },
  {
    script: 'verify-showparam-visibility.mjs',
    why: "a rig link's showParam toggle (conveyor side guards, stairs handrails) changes pixels BOTH ways - the on direction had no structural notify, so the bundle replayed the hidden list",
  },
  {
    script: 'verify-floor-grid.mjs',
    why: 'the floor-grid toggle changes pixels and matches ?nobundle - a depthWrite-off base-pass overlay is painted over by the bundles WebGPU executes last',
  },
  {
    script: 'verify-pool-glb-dressing.mjs',
    why: 'repeated GLB dressing merges in the instance pool, and a setSubPose-driven link never does (it would render stuck)',
  },
  {
    script: 'verify-pool-repaint.mjs',
    why: 'a repainted colorParam part regroups instead of dragging its pooled twins\' colour with it',
  },
  {
    script: 'verify-turntable-square-exit.mjs',
    why: "the turntable hands its load over at exactly the deck angle: the platter CARRIES what stands on it for the turn, because a surface-velocity drive commands a rate and integrates any slip into the final angle (4.35 deg worst measured without the carry, 0.34 with it)",
  },
  {
    script: 'verify-jointed-hardware-follows.mjs',
    why: "hardware FK moves is never merged: the pool bakes world matrices and re-bakes only on structural events, so a jointed link's pooled bank stands still on screen (the turntable's roller holders frozen while its rollers turned)",
  },
  {
    script: 'verify-draw-budget.mjs',
    why: 'draw budget: the demo stays under its ceiling, and duplicating a part stays flat (cross-part merging still works)',
  },
  {
    script: 'verify-texture-residency.mjs',
    build: true,
    why: "texture VRAM budget: the demo stays under its residency ceiling, no image is resident twice, and duplicating a part does not multiply texture memory. The VRAM twin of the draw budget - optimize-assets can only weigh textures on the WIRE, and a 1024² map is 5.3 MB resident whatever it compressed to, so a per-instance Texture (each platform minted its own, +10.7 MB a copy) was invisible to every other gate",
  },
  {
    script: 'verify-package-texture-fallback.mjs',
    why: "a PACKAGE texture that isn't there yet must not render the surface black. An image-less Texture is not 'no map' - three binds its empty default and the surface samples (0,0,0) - and a package material multiplies its albedo in, so a lost fetch drew the Diverter's pusher arms as a flat black cut-out for the whole session while its blade and housing looked perfect. The app's own textures got a retry and a neutral fallback after that class turned the warehouse floor black for a visitor; the package path went through a bare TextureLoader and got none of it. Scores only ROD pixels (the ones that move when the arms extend), because over the whole probe box a healthy rod and a broken one are 1 luma apart and over the rods 77",
  },
  {
    script: 'verify-interaction-budget.mjs',
    why: "interaction budget: a gesture's cost tracks what it touches, not the size of the document - selecting writes nothing and takes no undo entry, and neither selection path gets dearer when the scene doubles. The panel twin of the draw budget, for the four bugs that were all 'work proportional to the whole scene on an interaction path'",
  },
  {
    script: 'verify-assign-io.mjs',
    why: "handing a scene to a real PLC is one command, and it edits two documents at once: Assign I/O gives every named tag an I/O address, declares it there in the program and rewires the parts. A half-applied version is worse than none - the program would drive names no part carries any more - so the gate holds that one Ctrl+Z takes back BOTH halves, and that the command works in a browser tab, where no PLC can be served",
  },
  {
    script: 'verify-wiring-binds-program-tags.mjs',
    why: "a program's own tags bind by wiring, the direction coming from the parts when the program declares none: a plain-VAR program must stop a box at an eye in the running app, and an eye wired DURING the run must take effect then, as a declared VAR_INPUT always has. Before this only VAR_INPUT / VAR_OUTPUT crossed, so the program attached clean and the box rode past the eye; with the mid-run rebind switched off the box still rides past (x = 5.47 m), which is what keeps the second half from passing vacuously",
  },
  {
    script: 'verify-ladder-view.mjs',
    why: "the ladder view is a projection of the program TEXT, so every gesture must land in that text as one ordinary edit. A ladder program opens on its rungs with no Text | Ladder switch (a POU is ONE language; its chip's 'Show as text' reaches the rung text), and '+ > Ladder program' adds a PROGRAM that opens on the sheet. Then: the rungs of a real program drawn (a branch, a comment), a palette contact placed and named, a timer from the palette arriving with its instance declared, Ctrl+Z in the view stepping back through the text editor's own history a gesture at a time, and, while the program runs, only the contacts that are closed drawn on and power stopping at the first open one (Start and Motor off, the normally-closed Stop and Always on), which is what keeps the live half from passing by lighting everything",
  },
  {
    script: 'verify-ladder-box-picker.mjs',
    why: "Insert Box is the one door to everything a rung can call that the element bar does not hold - a program's own FUNCTION_BLOCKs above all, which nothing else offers - and every box reaches the rung through the catalogue's one insert path (plc/ladder/ladderCatalog.ts), the bar's included. The unit tests hold the catalogue to the engine; only the app can show the bar's 'Block…' and Ctrl+B opening it on the search field, a typed name picking the program's own block, Enter landing it declared with every pin to fill and titled with its outputs drawn before one is named, a library function landing the same way, and Escape changing nothing",
  },
  {
    script: 'verify-ladder-drag-zoom.mjs',
    why: "the ladder sheet's own gestures write to the DOM and the program without React seeing most of them: Ctrl+wheel paints the zoom straight onto the sheet and saves it once the wheel settles, a wrapped rung's rows are joined by wire drawn into a layer React never reads, a rung moves by its number and a branch end stretches over its neighbours through pointer capture. Nothing else drives any of them, so each is read back from the stored program or the sheet itself",
  },
  {
    script: 'verify-demo-ladder.mjs',
    why: "the demo ships ONE program in two languages, Palletizer in ladder calling PalletTruck in Structured Text, and only the app can show the PLC panel treating a POU's language as the POU's own: a panel open on text when the demo loads comes up on the rungs of the program the controller runs, with no Text | Ladder switch and no idle twin; Play lights the rungs and the ladder drives the cell; the ST chip opens the text, the ladder chip brings the rungs back, and its 'Show as text' shows the rung text without forking the demo. The unit tests hold the program to being the same machine as the demo all in ST and all in ladder",
  },
  {
    script: 'verify-ladder-live-freshness.mjs',
    why: "the Ladder view redraws a rung only when the values THAT rung shows move, which it decides from a list of operand texts (`textsOf`) written by hand beside the drawing - so the list can fall behind it, and when it does the rung silently keeps the numbers it last had, which is what a ladder looks like anyway. This reads the running demo over three seconds instead of once: every settled contact's lit state must agree with `controller.plcWatch`, and the numbers inside the blocks must still be moving at the end of the window. Both were confirmed to bite by dropping a text from that list (contacts: 22 drawn stale; blocks: 35 moving numbers -> 0), and it refuses to pass vacuously unless some contact changed state while it watched",
  },
  {
    script: 'verify-inspector-edit-semantics.mjs',
    why: "the Inspector writes only what the user asked for: clicking in and out of a field changes nothing (it never commits the ROUNDED display text), Escape cancels, arrow keys stick, a context menu never outlives its selection or reverts edits made while it was open, and a multi-selection never writes one package's params or one part's table into another. None of those threw; each just changed the document",
  },
  {
    script: 'verify-part-editing-ux.mjs',
    why: "the part-editing surfaces say what an edit will do and never drop one (found in a parts-editing review): the behavior editor asks before a stray backdrop click or ✕ discards unapplied work, and only then; a rig node edit names how many placed copies follow; the last node can't be 'deleted' by a button that does nothing; a joint is renamable only while its script never mentions it, because a rename doesn't rewrite the script and a joint commanded by its old name silently stops moving; the browser offers no Save that can only say it can't; ✎ and New part stay on in a shared project. None of those threw. Checked to bite: a backdrop that closes without asking fails it. The desktop half (a project's parts live in its folder, one library, nothing to save) is verify-part-library-electron.mjs, which needs the real shell",
  },
  {
    script: 'verify-parts-shelf-electron.mjs',
    why: "the parts shelf (docs/parts-shelf.md) moves custom parts between projects by COPY and says which side changed: a project's part put on the shelf lands as a part folder without the copy's record, another project places it (copied into it at the press, recorded as that version), a teammate's edit to the shelf file on disk reads as Update and updating takes it, and an edit in the project reads as Put on shelf and writes back. A new project never has the part until it places it: the shelf is never read live, which is the cross-project leak rule. Launches the dev Electron shell on a throwaway profile, whose shelf stays inside it",
  },
  {
    script: 'verify-project-format3.mjs',
    why: "older documents read and convert: a copy-free format-3 project opens, its live scene gets its copies back so the sim builds it (a spawner spawns), and a save writes no scene copies but the project's OWN stamped copy of every part it uses (format 5); a format-2 document's stale built-in snapshot gives way to the app's current version, never pinned (the v1 frozen-part bug). Checked to bite: without the live rebuild the spawner spawns nothing",
  },
  {
    script: 'verify-builtin-update.mjs',
    why: "a project's own version of a built-in records which built-in it was made from, so a later app's changed built-in is not silently hidden: the catalog card says Updated and the Inspector asks, Keep stops the question until the next change, and Use the app's new version puts the new built-in live. Before this, a project that had ever touched a built-in kept the old one forever and nothing said so",
  },
  {
    script: 'verify-oip-complete.mjs',
    why: "a project's copy of a built-in carries the model bytes the app ships (docs/part-sources.md): a placed Gantry draws from /part-assets/<sha256> and never the raw /models/ file (dev draws what production does), and an exported .oip holds its model as assets/<sha256>.glb, byte-identical to the shipped bytes, with no URL to fetch, and reads back as the same part",
  },
  {
    script: 'verify-part-updates.mjs',
    why: "the app never updates a project's parts by itself, and says when it could (docs/part-sources.md): a project holding older copies opens with a prompt counting them while it still runs its own, Review names the one the project also changed, Keep stops its question, Update all takes the app's version as the project's own stamped copy, and nothing is asked again after a reload",
  },
  {
    script: 'verify-collab-room-assets.mjs',
    why: "a part's embedded model travels through a room by hash (docs/part-sources.md \"Rooms\"): an editor's bytes land in the collab server's asset store named by their SHA-256, the stored room carries the hash and not the base64, a viewer joining cold gets the exact bytes back, and a viewer uploads nothing. Runs its own collab server (server/index.mjs) on a free port with its own db and asset folder",
  },
  {
    script: 'verify-live-share.mjs',
    why: "live share (docs/live-share.md): anyone running in a shared project can be watched, and the collab server sends each run only to its followers. With no Live switch, a view link waits for the owner's run and follows it (its cargo moves, its own store stays stopped, nothing reaches its document); an editor joining mid-run is offered the run and starts at the same point once it says Watch; the owner's Spotlight takes the editor to the owner's run, which it can dismiss; with two people running, the view link stays on the owner's run and can pick the other; the viewer's own Play takes the view and Stop gives it back; the owner's Stop ends the run for its followers. Runs its own collab server on a free port; the late tab gets a browser of its own, since two tabs drawing a run starve a third one's renderer start",
  },
  {
    script: 'verify-shared-part-editor.mjs',
    why: "the Part Editor and deleting parts work in a shared project without touching anyone's line (collab/bridge.ts parks it while the editor shows the part alone), proven with two people against a real collab server: New part and ✎ open the editor while the other person's line stays as it was, the new part and an edit to it reach them, their edit to the line made meanwhile lands in the parked line and is there after Back, both end with the same line, and a deleted part leaves their parts. Checked to bite: with the bridge diffing the store's scene while the editor is open, the other person's line is wiped. Runs its own collab server on a free port",
  },
  {
    script: 'verify-collab-offline.mjs',
    why: "a collab server that cannot be reached is explained (components/PresenceStack.tsx): a blip only says Connecting…, but past 10 s the people button says Offline and its list names the server, says the changes are kept and offers Retry, which reconnects once the server is back. Runs its own collab server on a free port and kills it",
  },
  {
    script: 'verify-present.mjs',
    why: "Present (components/PresentOverlay.tsx) is for a projector or a display: it hides the toolbar, the docks, the viewport toolbar and the orbit gizmo and the viewport fills the window; its bar fades when the mouse is still and comes back when it moves; Escape and Exit bring the editor back; a link with &present=1 opens straight into it, locked: no bar, and no key (Escape, the palette's) reaches the editor",
  },
  {
    script: 'verify-shared-project.mjs',
    why: "a shared project stays the user's project (project/sharedProject.ts), so it is proven against a real collab server: Share > Can edit shares a solo project in place and the project menu keeps its name, tagged Shared; an edit in the room, the owner's or a collaborator's, reaches the project in storage by itself, and Stop sharing is offered; opening the app again opens it in its room; Stop sharing makes it the user's alone with everything done while shared, and it stays solo; the room keeps the edits for its links. Runs its own collab server on a free port",
  },
  {
    script: 'verify-desktop-file-open-electron.mjs',
    why: "a .oip or .oippart opened from outside the app (what a double-click does once the installer registers them): launched with a .oip the app asks and opens it as a project of its own, and a second launch naming a .oippart hands it to the running window, which takes it into the open project's parts while the second process exits. Main reads the file and the renderer gets bytes, never a path. Launches the dev Electron shell on a throwaway profile",
  },
  {
    script: 'verify-step-import.mjs',
    why: "a STEP file imports through a rig node's Import model...: the CAD kernel (occt-import-js, 7.6 MB of wasm) loads in a worker of its own only when a STEP file is converted, the page keeps drawing while it reads, and the node becomes an embedded GLB with one mesh per colour. What it guards is the part nothing else exercises: a worker that imports a CommonJS emscripten loader and a ?url wasm, which a vite or dependency upgrade can break without a single unit test noticing (the kernel's own tests run it in node, not through the bundler)",
  },
  {
    script: 'verify-usd-import.mjs',
    why: "a USD model imports through a rig node's Import model..., as one file or as its folder: the USD reader (@huggingface/usd-web-viewer, 2.3 MB of wasm in its own worker) loads only when a model is converted, and the node becomes an embedded GLB with composition honoured (a payload, a reference, a variant, an override from the stronger layer, centimetres and Z up) and one mesh per material. A lone root layer whose payload is elsewhere imports nothing and says to pick the folder. The model is written by the gate itself, first-party.",
  },
  {
    script: 'verify-urdf-import.mjs',
    why: "a URDF robot folder imports through Import part > A robot (unzipped folder)... as a new posable part: a rig link per URDF link and a joint per moving joint with its limits, one GLB node per drawn link, meshes found by package:// and relative paths and read in their own units and up axis (a binary STL in millimetres, a COLLADA file in centimetres and Z up), and the rendered links standing where URDF puts them, Z up turned to Y up. A lone .urdf imports its primitives and names the meshes it lacks. A .zip of the folder picked as one file, and the folder dropped on the Parts dock, import the same robot. A xacro description is expanded first: one in two ROS packages, whose model argument names none by default, asks which model (from its YAML folders) and imports the picked one through its macro, its $(find) include and its YAML; a missing include is named. A mimicking joint becomes a joint `mimic`, each <collision> a hidden collider link, and a box dropped on the running robot's base rests on its collider. The robot is written by the gate itself",
  },
  {
    script: 'verify-urdf-robot-cell.mjs',
    why: "an imported URDF arm runs a pick-and-place cell from end to end, built the way an agent builds one: the import idles in a ready pose (tool straight down in front of the base, elbow up) that is also its Home, solve_robot_pose teaches the pick and the place by position from it with every pose reached tool down and elbow up, and one job run by the PLC ships the boxes, three in 70 s under run_test and in the live run. The arm is written by the gate itself",
  },
  {
    script: 'verify-split-pieces.mjs',
    why: "the Part Editor's Split into pieces (editor/rigSplit.ts): each node of an imported model is drawn by one link, the nearest that keeps it (core/glbBox.ts drawnElsewhere). Read from the rendered part: a split piece is drawn once and stays in place, a piece split from inside another is not drawn twice, a joint with a centred pivot moves nothing at rest, and deleting or merging a piece gives it back to the model. The model is written by the gate itself",
  },
  {
    script: 'verify-named-plcs-electron.mjs',
    why: "several PLCs in one run (src/plc/DEVICE-IO.md, \"Several controllers\"): the program here runs one line while two Modbus masters stand in for Cell2 and Cell3 on the same addresses, each on a port of its own, and each drives only its own belt. It caught the in-worker program wiping what the links wrote, which no unit test saw. Then the authoring side: Controller Properties' free ports and clash warning, the Inspector's Controller row, a name written in its set-up spelling, the Scene tree's badges, Assign to Controller and rename. Launches the dev Electron shell on a throwaway profile",
  },
  {
    script: 'verify-agent-mcp-electron.mjs',
    why: "the agent door end to end (docs/agent-tools.md): a real MCP client talks to the desktop shell's server and builds a line from nothing, proves it with run_test (and that the test fails without its stimulus), runs it live (set_tag, trace_tags, get_cargo), renames, retimes and assigns I/O, then makes a part, imports a GLB and a STEP model into it and adds a POU. What only the shell can show: capture_view's picture comes back as an MCP image and the user's camera and the editor around the view are put back, and import_model reads a model file by path and refuses one that is not a model. Every edit is one 'Agent: ...' undo step. The unit tests (src/editor/agent/*.test.ts) run the tools against a store; this runs them through IPC and a live viewport. Launches the dev Electron shell on a throwaway profile",
  },
  {
    script: 'verify-agent-review.mjs',
    why: "the person beside the agent (docs/agent-tools.md, \"Working beside a person\"): the agent's first edit raises a chip in the viewport's corner, Review lists the part it placed and Show selects it, get_context reports the person's selection, Revert is withheld while one of the person's edits sits among the agent's steps (and the chip counts only the agent's), and Revert then takes the whole run back and the next get_context says so. All of it is a click on chrome inside the viewport, which captures the pointer and swallowed these buttons until they were opted out (controller/pointer.ts), and over the model-loading cover, which hid them while models loaded. Stands in for the shell's bridge with a page script, so it needs no Electron",
  },
  {
    script: 'verify-author-node-move.mjs',
    why: "a node of a part opened in its own scene moves like a scene part, through the real mouse: its arrows and its body (re-grabbing the selected node, as with a part) move it, its rings turn it, the first press only selects it, the Rotate tool shows rings alone, and each gesture is one undo step. And what an edit writes must reach the SCREEN on every kind of rig: on a conveyor (the roller conveyor's 'roller' node) a pose resolved from a rest pose copied at build time (the whole-bed incline re-placing each parentless link, or joint posing) would move the data and nothing on screen - checked to bite. It also holds the freeze seam: a static single-box rig is matrix-frozen, and an offset edit (a drag, or a background commit) must still move the RENDERED box. Checked to bite: without the change the body drag and the rings fail",
  },
  {
    script: 'verify-panel-dom-budget.mjs',
    why: "panel DOM budget: the scene tree renders the viewport, not the scene - bounded rows, the selected row still reachable and on screen, and duplicating the scene leaves the tree's DOM flat",
  },
  {
    script: 'verify-merge-coherence.mjs',
    why: "merge coherence: every batching mechanism's output still matches its live sources after select / visibility toggles / run+stop / duplicate+undo - the 'data moved, pixels didn't' class the draw budget cannot see",
  },
  {
    script: 'verify-cue-over-bundles.mjs',
    why: "a translucent CUE (the spawner/despawner marker) must tint what is behind it, not be painted over by it. It is transparent + depthWrite:false on purpose, so it is the one draw that cannot defend itself against a LATER one - and three executes render bundles at the END of the pass in scene-child order, which makes the mount order of two bundle groups a DRAW order. The instance pool's merged hardware was mounted after view.partsGroup and punched straight through every marker, alternating with the frames a structural change rendered unbundled while the scene loaded. Parity against ?nobundle, shot only once the pool has actually merged (an earlier shot passes whatever the order is)",
  },
  {
    script: 'verify-bundle-camera-integrity.mjs',
    why: "a replayed render bundle must never render from a LIGHT camera. three's camera family are process-wide singleton uniform nodes fed from nodeFrame.camera, and _renderScene restores renderId but NOT the camera across a nested render (ShadowNode's shadow-map pass) - so the singletons come back holding the light camera and the shared-group upload ships it into every baked draw. The gate forces that nested render to fire INSIDE the bundle walk (three separate guards normally suppress it) and checks the cameraViewMatrix node after each view-camera bundle replays. When the scene's own draw order puts the shadow node in the camera-owner group, the gate moves it to a later group, so the repair pass is tested whatever three's render-list sort does. Checked to bite: with the repair disabled every check reads DIRTY",
  },
  {
    script: 'verify-static-fold-parity.mjs',
    why: 'the static fold (BatchedMesh) is pixel-faithful to ?nobatchfold, i.e. to drawing every building source live - the only pixel test on the path every static building mesh takes to the GPU',
  },
  {
    script: 'verify-sdk-sensor-snap.mjs',
    why: 'a sensor dropped beside a conveyor live-snaps onto its guard, slides along the rail, and auto-fits maxRange',
  },
  {
    script: 'verify-sim-speed-ladder.mjs',
    why: 'the speed ladder cycles 0.5x-8x both ways, and a boosted run either holds the requested rate or SAYS it cannot (the step loop sheds backlog silently)',
  },
  {
    script: 'verify-phone-shortfall.mjs',
    why: 'that same "cannot hold the rate" verdict reaches a PHONE, where the speed button carrying it is cut from the bar - and the badge saying so does not squeeze the scene picker off a 320px toolbar',
  },
  {
    script: 'verify-toolbar-affordances.mjs',
    why: 'the top bar tells the truth about its own controls: Open asks before it overwrites a scene there is no undo for, Pause names the paused state it alone can leave, a greyed file button says WHY, and the view-only badge does not wear button chrome',
  },
  {
    script: 'verify-toolbar-fit.mjs',
    why: 'the top bar FITS the window across the whole docked band (821-1440) in its heaviest state, with no control off-screen, none stacked on another, and the file actions always reachable - the two failure modes trade for each other, so a fit-only check passes while the run cluster sits on the scene picker',
  },
  {
    script: 'verify-rig-gizmo-selection.mjs',
    why: "a posable rig's pose gizmo is up exactly when the editor targets it - including a rig inside a grouped subtree, which a viewport click reaches only via the double-click drill-in",
  },
  {
    script: 'verify-shape-part.mjs',
    why: "the Shape primitives are solid as what they LOOK like: collision:'staticHull' colliders hull the mesh (cargo over a cylinder's AABB corner falls, a ramp carries at its wedge height), and the vertical resize dot drives height",
  },
  {
    script: 'verify-webgpu-resize-no-gpu-errors.mjs',
    why: 'WebGPU resource lifetime: dragging a procedural part\'s resize handle raises ZERO uncaptured GPU errors - a freed-under-a-recording buffer blanks the whole bundled main pass, and nothing throws (SKIPs where WebGPU is unavailable, e.g. a GPU-less CI runner)',
  },
  {
    script: 'verify-webgpu-spur-slide-no-gpu-errors.mjs',
    why: 'WebGPU resource lifetime, the MERGE gesture the resize gate cannot reach: butting a spur onto a conveyor and sliding it along re-emits the HOST\'s geometry per pointer-move while the mover is drag-ejected, then the draw list goes QUIET - so a buffer freed under a live recording has nothing left to replace it and the main + shadow passes are rejected on every frame from the end of the drag onward (a PERMANENT black viewport, outline and gizmo still drawing over it). Waiting for a landed re-record before freeing was not enough; gpuRetire also notifies AFTER the release (SKIPs without WebGPU)',
  },
  {
    script: 'verify-spur-diverter-gap.mjs',
    why: "a diverter snapped onto a spur opens the spur's guard where its arms cross, as DRAWN: a drawn part only gets that opening through its `guardGaps` param (core/parts/hostFacts.ts), and a part that leaves the param out still loads, so the arms would run into solid guard with no error anywhere. Carries its own control (the spur alone keeps a whole guard)",
  },
  {
    script: 'verify-warm-load-no-gpu-errors.mjs',
    why: 'the RELOAD path: on a persistent profile the second load has a WARM Dawn pipeline cache, so the cover lifts ~2.5s sooner and lands inside the load tail - zero uncaptured GPU errors and no black viewport there. Every other gate in this fleet runs a fresh profile and is therefore always COLD, which is how a freed shared geometry blanked ~73% of the canvas on every real reload with the whole fleet green (SKIPs without WebGPU)',
  },
  {
    script: 'verify-agv-lane-pick.mjs',
    why: 'a truck picks a staged load by putting its BLADES IN THE PALLET: no blade is ever under a staging lane\'s deck while inside its footprint, and the blade runs right THROUGH the fork pockets rather than reaching for the load from short of it. Both halves matter - a truck must never raise its forks from the floor to deck height with a metre of blade inside the roller bed, and a truck that lines up short still clears the conveyor and still gets the load, because the grab volume reaches',
  },
  {
    script: 'verify-agv-rack-putaway.mjs',
    why: 'the demo trucks PUT loads away on the rack rather than drop them: each load comes to rest on the bottom shelf slab, centred in a free bay, stack intact, with the racked stock and the first delivery untouched by the second, which goes in beside it (~5 min - it watches the rack truck through two real deliveries)',
  },
  {
    script: 'verify-no-spawn-before-attach.mjs',
    why: 'a spawner may only emit while the tag GATING it is open - which is really a claim about run(): setDrivenTags and runProgram are posted AFTER start, so a world that stepped on arrival ran frame 1 with an empty driven set, and every part gated on `tagDriven(tag) ? readTag(tag) : authored` took its authored state for that frame. Both demo spawners did: one un-commanded case, and a pallet dropped into the finished load standing on the build deck, which then went onto a rack shelf with a pallet through its middle on EVERY run. Invisible for its whole life - verify-agv-rack-putaway counted 17 bodies where a load has 16 and passed it on `>= 16`',
  },
  {
    script: 'verify-inspector-live-setpoint.mjs',
    why: "the Inspector reads out the speed the ENGINE is using, not the authored param a bound speedTag replaced - a program commanding 0.5 under an authored 1 showed 1, and a bound-but-undriven tag showed 1 on a dead-stopped conveyor",
  },
  {
    script: 'verify-annotations.mjs',
    why: 'a note is a scene object whose only representation is a DOM chip, so every way it can break is invisible to the rest of the fleet: the chip mounted but mis-projected, the projection right but the click swallowed (it was - the viewport captured the pointer and ate it), the toggle hiding nothing, or a note that keeps drawing at fifty metres and turns a layout into confetti',
  },
  {
    script: 'verify-tutorial-docked-plc.mjs',
    why: 'writing a PLC program reaches the program of record even with NO ST editor mounted - a DOCKED PLC panel is unmounted whenever it is not its slot’s front tab, so the tutorial’s interlock (and any imported scene’s bundled program) must not be a broadcast that goes nowhere',
  },
  {
    script: 'verify-tutorial-edit-reload.mjs',
    why: 'the tutorial’s one hands-on PLC step: every step before it writes the program for the user, and an edit to a RUNNING program does nothing until Reload, so the step waits for the edit to be what runs. Its gate reads the controller’s own attach record, so only the real controller proves it is not vacuous: the tour’s own program running, an edit typed but not reloaded, and a Reload that does not compile must each leave the card up, while the edit reloaded advances it without a Stop. Also pins that a program loaded while the lazy code editor was still arriving shows in it (it opened on the stale text, and the first keystroke wrote that back over the program)',
  },
  {
    script: 'verify-tutorial-scene-binding.mjs',
    why: 'the tutorial commits into a real scene and its progress outlives a reload, so a run that is not bound to the scene it is building in resumes over whatever tab happens to be active - reaching into the user’s own line to select a conveyor and turn its comms on before they have clicked anything, then offering to write the tour’s ST program over theirs. Pins the binding: parked in another tab the tour is inert and offers the way back, a deleted tutorial scene ends the run instead of stranding it, and a pre-binding saved run is dropped rather than landed somewhere it may not belong',
  },
  {
    script: 'verify-dock-popout.mjs',
    why: 'the popped-out PLC panel is a portal into a second OS window. Two of its properties are invisible to unit tests and fail silently: the popup must inherit the opener’s cross-origin isolation (it is opened as about:blank for this reason; without it the two documents can land in different agent clusters, where this one cannot touch the popup’s DOM), and the panel must stay live rather than becoming a second app instance, which this proves by typing in the popup and reading the change out of the main window’s store. Also pins the two ways a panel goes missing: closing the window has to hand it back to the dock it left, and a popout must never be restored from storage into a window that cannot be reopened without a user gesture',
  },
  {
    script: 'verify-scene-program-roundtrip.mjs',
    why: 'a scene SAVED from a live session re-opens and RUNS - guards against an exporter that reads the program from anywhere but its one store of record, which ships the layout with no logic, so a scene saved from the demo (or from a collab room) re-opens as a line that looks fine and never starts. Carries its own negative control, so it cannot pass vacuously',
  },
  {
    script: 'verify-sim-rate.mjs',
    why: 'the physics step rate is a project setting that crosses a thread, so it is only real if the WORKER steps at it - every headless test builds SimWorld directly and passes against a store that never hands the rate over. Sets it through Settings > Project (which must clamp it into 60-1000 Hz), runs the demo cell at 60, 144 and 500 Hz and requires each to step at exactly that rate (steps / simTime), hold real time (the catch-up cap must scale with the rate, or a fast rate silently runs slow), and still carry cargo with none through the floor; then pins that a change during a run applies on the next one, that the rate is the PROJECT\'s (kept on the project doc, not in a scene file, unchanged by a new scene), that it survives a reload, and that the demo preview cannot change it',
  },
  {
    script: 'verify-demo-scene-copy.mjs',
    why: 'peeking at /app/?scene=demo must never cost a returning user their project: the demo boot skipped loadStoredProject, so the first edit of a peek wrote a ONE-scene project over PROJECT_KEY and every other scene tab, its bound program and the project name were gone. The demo is now an ephemeral VIEW however it is reached - it occupies no scene slot, so pressing Demo is free and cannot ladder "Palletizing demo 2, 3, 4" into the switcher - and EDITING it is what forks it into a scene of their own beside their work, which is also how anyone gets a NEWER demo after a deploy (their copy is never rewritten). Covers the 320px phone the landing page links to, where the picker has to stay legible and clear of the run controls',
  },
  {
    script: 'verify-walk-session.mjs',
    why: 'walk mode is a SESSION, not authoring, so walking through the demo must never fork it: using the safety gate while stopped committed its `open` param, and a dock door committed `openDoors` even mid-run, so a visitor who only looked around got a "Palletizing demo" tab, the "is now your scene" notice and a retired ?scene=demo - their next reload opened a copy frozen at that build. Pins that both presses still act on screen, change nothing saved, and are dropped on leaving walk mode; carries its own negative control (an Inspector edit of the same gate DOES fork, while an editor C does not), so it cannot pass vacuously',
  },
  {
    script: 'verify-vr-walk.mjs',
    why: 'VR is walk mode in a headset, and a headset has to be able to REACH it: WebGPU became the default everywhere while VR only exists on the WebGL path, so a headset whose browser has WebGPU booted with no VR button at all - and the old smoke passed, because headless Chromium has no GPU adapter and fell back to WebGL by accident. This launches WITH a WebGPU adapter and proves both arms (no headset -> WebGPU, the control; an emulated Quest 3 -> WebGL, because the boot guard said so), then drives the controllers: the left stick walks where the head looks, a physical step moves the body, snap turn pivots about the head, the closed dock door stops the walk, and the trigger opens it along the controller laser with the gaze turned away - as walk-session state, never an edit. Exiting from the headset or from the page must hand back the editor camera AND its orbit target. Emulation proves the wiring, not frame rate or comfort on a real device',
  },
  {
    script: 'verify-run-cargo-not-edits.mjs',
    why: 'what the RUN owns is not the document, so changing it is no edit - decided once, by the store\'s edit gate, not by whichever write path a gesture calls. Probe-proven before the gate: clicking a moving box and pressing Stop forked the demo (the Stop cleanup saved), moving or deleting a promoted box mid-run was an undo step and a save, and after Stop an undo brought a run\'s box back as authored, saved content. Drives the real controller on the demo, where a miscounted edit is loud; its control (a conveyor moved mid-run DOES fork, and its undo/redo still works) keeps it from passing vacuously',
  },
  {
    script: 'verify-st-export.mjs',
    why: 'the portability promise is only real if a program can LEAVE: this drives the actual Export buttons and reads the downloaded bytes, checking the generated CONFIGURATION wrapper, the vendor-only STRING[n] spelling becoming a TYPE declaration, and TC6’s mixed-case type tags (a validator rejects <STRING> outright). It also pins the refusal path - a program that does not compile must not export half-formed onto someone’s controller',
  },
  {
    script: 'verify-st-pou-ops.mjs',
    why: 'the block strip is the POU LIST, not just an index: New/Rename/Delete/Reorder are text transforms on the one shared document, so the failure mode is silent corruption of someone’s program - a rename that misses a reference, a new POU written BELOW the program body (where the grammar says it is not a POU at all), a delete that takes the body with it. Unit tests pin the transforms; only a browser run proves the gestures reach them, that the STORE moved with the strip (the copy a reload restores and a room replicates), and that Ctrl-Z puts it back - a structural edit that is not undoable is a different feature to the one intended',
  },
  {
    script: 'verify-st-controller.mjs',
    why: 'the Controller Organizer edits a scene\'s tasks as DATA, and one of its edits renames tags: splitting a program into tasks turns Motor into Main.Motor, so the program text, the task table and the parts wired to those tags have to move together or the line silently stops. Unit tests pin each half (plc/controllerEdits, editor/program/controllerRewire); only a browser run proves the panel applies them together - Split into tasks swaps the scan field for the organizer, + Program lands a chip whose name field renames the instance too, a task\'s rows edit the table, a refused name says why, Run attaches the result, and the table is part of the saved project rather than panel state',
  },
  {
    script: 'verify-st-program-undo.mjs',
    why: 'a program edit (the organizer, a PROGRAM added or renamed, an import) changes the code, the task table and the wiring together, and one Ctrl+Z must take all of it back or none: this pins that the code lands in CodeMirror without a history step of its own, that Ctrl+Z inside the editor undoes typing first and then the program edit, and that an edit typed over since is refused with a notice rather than undone over that work',
  },
  {
    script: 'verify-plc-reload.mjs',
    why: 'the PLC dock has one command, Reload, and it is lit ONLY while the text on screen is not what runs - so its enablement IS the sign that edits have not reached the sim, and both failure modes are silent: lit when nothing changed invites a pointless restart, dim after an edit leaves the author watching old code. This drives the whole cycle in a browser (Ctrl/Cmd-Enter starts a stopped sim, an edit lights it while the old code keeps running, pressing it swaps the program without a Stop, a runtime fault lights it, a scan time baked into the default table lights it), pins that a reload which does not compile says the previous program is still driving the line (not "not attached" over a line plainly still under control), and pins the part-scene refusal: neither the button nor the key attaches the factory program to a part scene that Play deliberately keeps it out of',
  },
  {
    script: 'verify-keymap.mjs',
    why: 'the keyboard is the editor’s primary surface and every binding now resolves through ONE table (src/core/keymap.ts). Two failure modes are invisible to unit tests: spatial keys must match the PHYSICAL key (it drives a synthesized AZERTY/QWERTZ press, where the old e.key comparison put a French user’s Move tool on Z) while Ctrl+Z must keep following the PRINTED letter, and free fly must hold and RELEASE correctly under a held Shift - strict modifier matching once made W dead while boosting and swallowed the keyup of a key released under Shift, leaving the camera flying forever',
  },
  {
    script: 'verify-auto-translate.mjs',
    why: 'the editor is shown in the browser language by the browser\'s own on-device translator, fed only the declared messages, while the page stays translate="no". What breaks it is invisible in an English browser: a download the browser only allows from a click, a cache that has to reach the first render, and identifiers that must never be translated. It fakes a German browser and Translator and checks the question, the reload, part names and program text kept as written, and the English choice in Settings sticking',
  },
  {
    script: 'verify-transport-keys.mjs',
    why: 'Space plays and pauses, Shift+Space stops - the browser\'s transport keys, where the desktop menu\'s F5 is the page\'s reload. What can break is the BROWSER\'s half, so it runs in Chromium, Firefox and WebKit: a focused button (where a mouse click on Pause leaves the focus) is pressed by Space too, on keydown in some engines and keyup in others, and a miss reads as a key that does nothing (the button toggles the run straight back). Also pins that a held Space toggles once, that Space stays text in a field and the boost in free fly, and that Shift+Space never starts a run',
  },
  {
    script: 'verify-camera-persistence.mjs',
    why: 'where you left a scene is where it reopens: the camera is per-scene workspace state, like the dock sizes. It was session-only, and the demo made the gap visible - /app/?scene=demo frames the palletizing cell, but the first edit retires the demo session and the URL param, so the reload took the ordinary autosave boot and landed at world zero, arm cropped at the edge. Covers the reload, the peek-becomes-your-scene handover, per-tab framing across a scene switch, and Reset View as the way back out',
  },
  {
    script: 'verify-st-string.mjs',
    why: 'a STRING variable has to survive the whole SURFACE, not just the language: the unit suite proves the semantics and the interpreter/emitter agreement, but the value is computed in the sim WORKER and travels back as a tag, so this is the only check that TagValue carrying text holds across the structured-clone boundary, the watch table and the inline value overlay. It also pins the truncating store in the LIVE image',
  },
  {
    script: 'verify-param-tooltips.mjs',
    why: 'a property hover explains the field, and losing that explanation is SILENT - the tooltip just gets shorter. It already happened once: the descriptions were looked up as `${part.type}.${key}`, so when the built-ins became packages (every instance reports type "part") all 87 equipment keys went dead at once, with a green fleet. The unit suite pins the DATA (a package carries its `desc`, the host table has no unreachable keys); only this pins the string actually reaching a rendered `title` - for a package part, for the `_`-prefixed built-in rows, and for the rig joint fields (axis, limits) that carry the editor’s densest jargon',
  },
  {
    script: 'verify-crash-boundary.mjs',
    why: 'guards against a throw anywhere in the React tree unmounting the editor to a BLANK page - no message, no way to get the scene out, and nothing on screen to say the autosaved document still exists. It fails the way a gate cannot see: an empty #root is also what a browser shows when the app never booted, so the loss would ship silently. This forces a real render-phase throw and holds the dialog to its actual job, custody of the work: it appears at all, Export LEADS and produces a .oip off the store snapshot rather than the broken view layer, the pasteable report is on screen before Copy is ever pressed (clipboard access can be denied), and a reload comes back into a working editor',
  },
  {
    script: 'verify-problems-panel.mjs',
    why: 'the validate leg has to answer CONTINUOUSLY or it is not a validator: if checkWiring ran at one call site, on the run edge, a contested tag would be findable only by pressing Run with the PLC panel open. This drives the two mistakes an author actually makes - a semicolon typed into the program, two parts pointed at one OUT tag - and requires the panel to catch each with the sim never started, then to navigate (scroll the editor to the line, select both offending parts). Every claim is bracketed clean-to-broken-to-clean, because the failure mode is VACUITY: an empty list looks the same whether the document is fine or the checks never ran. It also pins the noise regression - undriven/unread count the program as a writer, so one syntax error must not manufacture dozens of warnings about a scene that has not changed',
  },
  {
    script: 'verify-command-palette.mjs',
    why: 'the palette is the ONLY path to several commands on the web (there is no menu bar), and since it learned to find things as well as actions it is also the keyboard route to a part in a 300-part scene and to placing one from the catalog. Ranking is the feature there, so this pins the parts of it that go wrong silently: an exact part name must outrank a command that merely shares its letters, a populous scene must not crowd the commands out of the list, same-named parts must be tellable apart (the demo has seven "Box 15", one per pallet stack - partDisplayName numbers unnamed parts among SIBLINGS, which is right in the tree and useless in a flat list), and a catalog hit must ENTER placing rather than drop geometry somewhere the user never looked',
  },
  {
    script: 'verify-settings.mjs',
    why: "a preference has exactly one job - survive a reload - and a settings dialog fails in two silent ways: a control that writes nothing, and a control that writes something nothing reads. So this drives a live switch (the Performance read-out) from the dialog and requires the overlay to actually reach the screen, then still be on after a reload. The graphics rows fail differently: both are resolved once at module load (a live shadow-map resize destroys a texture recorded WebGPU bundles hold by handle), so the dialog has to SAY it applies next load - which is exactly why the toolbar popover holding them was removed instead of kept",
  },
  {
    script: 'verify-project-identity.mjs',
    why: "the app opens straight onto the project autosave and, until the name reached the UI, never said WHICH document that was - no recents, no project manager, and `project.name` was reachable only as the ST export filename. The name deliberately is not in the toolbar row (verify-toolbar-fit measures its heaviest state at 1239px and the ladder already drops the wordmark at 1050 to keep the scene picker readable), so it lives in the window title and the picker's group header - two surfaces no unit test can see. Pins the whole loop, rename -> autosave -> boot -> identity, plus the trap underneath it: persistProject() opens with stashDemoSession(), so a rename accepted during the ?scene=demo preview would FORK the demo into a scene of the user's own, a mere LABEL minting a document",
  },
  {
    script: 'verify-project-shelf.mjs',
    why: "the browser can hold more than ONE project now (editor/project/documentStore.ts), and every way that goes wrong is invisible to a unit test: the library is IndexedDB, absent in the Node env. Isolation is the claim with teeth - a new project must carry none of the previous one's scenes - and the switch is write-then-RELOAD through the single tested boot path, so a scene tab that survives it survives everything. Also pins the split the design rests on: localStorage keeps the WORKING COPY (unchanged, quota-guarded, synchronous on every commit) while IndexedDB holds the library, which is what makes N projects safe on a store where one project with an embedded model can already exhaust the quota. The open document cannot be deleted, because it IS the working copy",
  },
  {
    script: 'verify-browser-working-copy.mjs',
    why: "the browser working copy is the open document's IndexedDB row, with models by hash in their own store (projectFile.ts, localAssets.ts), and nothing else in the browser holds a copy of it. Pins that a 6 MB model saves and reloads byte-exact, that a project whose stored bytes are gone is refused rather than opened without its model, that a .oip with the model imports into a browser that never stored it, that a project past the old 5 MB localStorage limit saves, that a page hidden with a row write in flight also leaves the text where a closing page can write it, and that the first boot moves an earlier build's localStorage working copy into the row (or keeps the row where a refused save left it newer). IndexedDB is absent in the Node env, so only a browser can check it",
  },
  {
    script: 'verify-folder-link-persist.mjs',
    why: "a linked project folder is the agent loop's whole input path, and it must survive a reload: a handle kept in module state dies on refresh, silently demoting the project to a plain document with the banner's ABSENCE as the only signal. The memory is IndexedDB, absent in the Node env, so none of it is unit-reachable. What this pins is the boot half - a row keyed by DOCUMENT id (not a global 'last folder', or reopening any project would inherit someone else's), consumed with no user action, and cleared by unlink so a dismissed folder stays dismissed. It also pins the two failures that are normal here rather than exotic: a handle the browser refuses to clone costs the memory but never the LINK, and a remembered folder that has since moved or been deleted has to arrive as the sticky banner - that read throws rather than returning, so the boot path has to catch it. A real FileSystemDirectoryHandle cannot appear in a test browser (showDirectoryPicker is a native dialog; the OPFS alternative kills the browser process when a handle of its own goes through IndexedDB and back - it reproduces with no app code at all, recipe in the gate's header), so the row is planted and what a handle DOES stays in projectFolderLink.test.ts",
  },
  // ─── promoted from the `--all` sweep: each failed from script rot, was fixed against the app and
  // verified green alone. They are curated because uncurated scripts break unnoticed: a script nobody
  // runs is not a test.
  {
    script: 'verify-matrix-freeze.mjs',
    why: "the matrix freeze is what keeps idle cost off the scene's size, and both halves fail SILENTLY: a part frozen when it should move renders stale (the freeze keys on the DRAG seam, not selection - selection alone cost ~2.5ms/frame), and one left live puts its whole subtree back in three's per-frame matrix walk",
  },
  {
    script: 'verify-soft-parenting.mjs',
    why: 'soft parenting end-to-end through the REAL gestures: reparent in the tree, then move/rotate the parent with the gizmo and confirm the child follows rigidly, and that duplicate/delete act on the whole subtree',
  },
  {
    script: 'verify-placement-staging.mjs',
    why: 'placement stages a REAL part (the ghost is gone), so the drop path is the thing the user sees; it also clicks the viewport during boot, which is the loading-cover trap the fleet keeps rediscovering',
  },
  {
    script: 'verify-reparent-new-node.mjs',
    why: 'Reparent to New Node is how a group of parts gets made: the group lands, carries both children by the same delta, and the sim still runs with it present',
  },
  {
    script: 'verify-mounted-part-floor-drop.mjs',
    why: "conveyor-mounted rigs seat their origin at the belt surface, so their mechanism hangs BELOW y=0 and each rig.json bakes the true underside as bounds.floorY - this measures the ASSEMBLED model's underside, so a model or a baked constant that drifts is caught rather than believed",
  },
  {
    script: 'verify-jolt-friction-carry.mjs',
    why: 'the carry contract: a running belt carries its load and a STOPPED one holds it, on the flat and up a 12 deg incline. It is also the gate that notices a units change (the FPM switch made `speed: 0` a 394 FPM belt)',
  },
  {
    script: 'verify-chain-bend-scroll.mjs',
    why: "the chain transfer's bends scroll with its run at ONE link rate around the turn, and only while the lane's joint is engaged - a frozen bend beside a moving run is the 'data moved, pixels didn't' family, in miniature",
  },
  {
    script: 'verify-platform-gizmos-floor.mjs',
    why: 'a resize gizmo the docks cover is a gizmo nobody can grab; this asserts the handles land over bare canvas, which no unit test can see',
  },
  {
    script: 'verify-isolated-run.mjs',
    why: "a part scene runs ISOLATED - the factory's spawner must not feed it, and leaving while running must stop the sim rather than drop the user back into a running factory",
  },
  {
    script: 'verify-outline-mask-merge.mjs',
    why: 'the palette-merged outline mask must be pixel-faithful to the per-mesh path AND flatten its draw growth (measured 665 vs 899 on select-all). Both sides are easy to lose quietly: frustum culling makes the count camera-dependent, so it pins a wide camera',
  },
  {
    script: 'verify-group-outline.mjs',
    why: 'selecting a group outlines the WHOLE subtree, and carried cargo is tiered from INSIDE the instanced batch rather than promoted to standalone meshes',
  },
  {
    script: 'verify-project-folder-link.mjs',
    why: "the linked folder is the agent loop's input path: a good read reloads the program with no user action, a rejected write raises the sticky banner instead of failing silently, and saving into a folder says so'",
  },
  {
    script: 'verify-project-cross-tab.mjs',
    why: "every tab on the origin shares ONE working copy and each save writes the whole document, so this guards against a second tab erasing the first one's work without a word (tab A adds a scene, tab B renames one of its own, A's scene is gone), and against one tab writing its project into the working copy the other has just filed away by switching projects on the shelf. Only real browsing contexts fire the storage event this rests on, so two pages in one context drive it: the tab that did not save yields (view-only, not saving, banner), its saves cannot land, Reload takes the document back and the other tab yields in turn, and a shelf switch in one tab is not undone by the other",
  },
  {
    script: 'verify-collab-code-trust.mjs',
    why: "the part sandbox end to end (docs/part-sandbox.md): a room hands everyone its custom parts' code, so a stranger's part must RUN (its display plate says so) while its classic escape stays inside, on the main thread AND the sim worker, for an editor and a view-link viewer alike; and Block must hold the code after a reload, Allow must undo it. Every unit test of the sandbox runs in node - this is the only proof the real page and worker lock down and that a real collab server's packages go through the gate. Stands up its own collab server",
  },
  {
    script: 'verify-plc-force.mjs',
    why: "a force is a run's state that changes what the line does without changing anything anyone saved, so a force that silently fails to hold, or outlives Stop, makes a commissioning session lie: this checks, in the real page and worker, that a forced variable holds against the program that writes it, that a write to it changes the held value, that the toolbar counts forces and releases them, that Stop releases them, that the rungs mark a forced contact (a badge drawn whole even beside the rail) and clear the mark on release, that the rungs' and the code's right-click menus force and release the operand under the pointer, that a device's tags, the Inspector's tag fields, the Scene tree and the Devices list force or mark the variable a part names, and that none of it is an edit of the project. plc.test.ts proves the hold; only a browser proves the path from the dock to the worker and back",
  },
  {
    script: 'guide-opcua.mjs',
    why: "a published guide (/guides/opcua/) is a promise made in the app's own words, and nothing else reads those words: every label, default and status line the page quotes is looked up on the page and then found in the running desktop shell, and a real OPC UA client (node-opcua) does what the page tells a SCADA to do until the PLC stops the box at the sensor. Rewording the dialog, an Inspector label or a status line fails on the sentence that stopped matching, which is the moment to fix the page AND retake its pictures (`node e2e/guide-opcua.mjs --images`); it also fails a picture the page shows but that is missing or no longer the size its tag says. One of three guides that can be a gate (with guide-s7 and guide-ads): the Modbus one needs a real OpenPLC. Launches the dev Electron shell and needs port 4843 free",
  },
  {
    script: 'guide-s7.mjs',
    why: "the S7 guide (/guides/s7/) followed the same way, against the unit tests' strict stand-in CPU (src/plc/link/s7FakeCpu.ts) on a real TCP socket, since no S7 CPU is at hand: the page's addresses, the dialog's defaults and PUT/GET reminder, nothing listening, a wrong slot refused, PUT/GET off named and then allowed mid-run without a second Play, the box stopped at the eye and the bits beside the eye's input left alone. Its quotes are the messages a reader stuck on PUT/GET actually sees, so rewording them in s7Client.ts or s7Link.ts fails here; retake its pictures with `node e2e/guide-s7.mjs --images`. Launches the dev Electron shell",
  },
  {
    script: 'guide-ads.mjs',
    why: "the ADS guide (/guides/ads/) as far as it can be followed without vendor software: step 1's scene, each row of its wiring table typed into the Inspector field the page names, and its picture the size its tag says. The connection itself needs the reader's TwinCAT router, which this project never runs. Retake its picture with `node e2e/guide-ads.mjs --images`. Launches the dev Electron shell",
  },
  {
    script: 'guide-part-model.mjs',
    why: "the first part guide (/guides/part-model/) followed the same way with the example model it offers for download (public/guides/blade-stop.glb, the built-in Blade Stop's model in metres): Import part > A model..., the Inspector's fit message, the body and collider nodes, the pieces and size the page names, Name and Category, ‹ Scene, a roller conveyor and the part dragged in and mounted from the page's table with the blade under the rollers, and a file that is not a model refused in the page's words. It also holds the view framed on the model after the import. Retake its pictures with `node e2e/guide-part-model.mjs --images`. Launches the dev Electron shell",
  },
  {
    script: 'guide-part-product.mjs',
    why: "the other three part guides, each starting where the one before ends, so this one script follows all four pages in turn (the first and the next two replayed against their own pages, e2e/_partGuide.mjs): the blade split out with Split into pieces, a prismatic joint driven by Two positions, Command wired and the page's program running the blade every 2 s at the stroke time; At A and At B reported to the program, with the ! and ✓ marks the page describes, and a stroke slower than the program allows latching BladeFault; then a hidden box under the blade that covers it as drawn, a box held against the raised blade for 3 s of simulated time by the page's program and photo eye, and released. Retake pictures with `node e2e/guide-part-<slug>.mjs --images`. Launches the dev Electron shell",
  },
  {
    script: 'verify-repo-self-contained.mjs',
    why: "the working tree is not the repo, and nothing else can tell the difference - tsc, eslint and vitest all read the filesystem, so they go green on a tree no clone can reproduce. Two shapes, both of which shipped: ~100 comments cite the probe that measured a constant, and a cited probe has to be a tracked file in e2e/probes/ (three were never committed and are gone, leaving numbers nobody can re-derive), and 16 modules including src/plc/ladder/ladder.ts and src/core/io/opcUa.ts were imported by 41 tracked files while untracked. Static, no browser",
  },
]

const args = process.argv.slice(2)
const all = args.includes('--all')
const list = args.includes('--list')

// `--only=<substr>[,<substr>]` - run only the gates whose FILENAME contains one of these. For the
// iteration loop: most edits can only be disagreed with by 3-4 of the 19 gates, and a full curated
// run is 15-25 min (concurrency 2 because there is one GPU, and verify-agv-rack-putaway alone is
// ~4 min). Without a filter the only options were "wait" or "run node e2e/verify-x.mjs by hand" -
// and the second one throws away the classify + confirm-serially machinery that exists precisely so
// a red line carries information.
//
// A subset run still FAILS on a red gate; what it must never do is REPORT like a full one. So every
// banner below says SUBSET and names how many gates did not run - same rule as SKIP: a green run
// that quietly covered less is how a gate list stops being believed. Use it while iterating, never
// as the run before a commit.
const only = args
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean)
const matchesOnly = (script) => only.length === 0 || only.some((s) => script.includes(s))
// Anything else is refused, not ignored. `npm run gates -- e2e/verify-x.mjs` reads like a subset run. Ignoring the
// argument would start the whole 20+ minute curated list, which an agent's time-limited shell then kills half way.
const stray = args.filter((a) => a !== '--all' && a !== '--list' && !a.startsWith('--only=') && !a.startsWith('--json='))
if (stray.length > 0) {
  const names = stray.map((a) => a.replace(/^.*[\\/]/, '').replace(/^verify-/, '').replace(/\.mjs$/, ''))
  console.error(`run-gates: unknown argument(s): ${stray.join(' ')}`)
  console.error('  flags: --all, --list, --only=<substr>[,<substr>], --json=<path>')
  if (stray.every((a) => !a.startsWith('-'))) console.error(`  to run those gates: npm run gates -- --only=${names.join(',')}`)
  process.exit(2)
}
// Sized by the GPU, not the CPU. These are headless Chromium pages doing real WebGL/WebGPU work,
// and a machine has one GPU however many cores it has, so cpus() measures the wrong resource.
// At 4 concurrent, a 150-script sweep produced 41 "harness" + 7 "hung" results that all passed when
// re-run alone (measured): the pages starve each other until the scripts' waitForFunction
// budgets expire, causing failures that look exactly like fleet rot. Two is the realistic ceiling
// on a single-GPU box; OIP_GATE_CONCURRENCY overrides where there is more GPU to go around.
const CONCURRENCY = Math.max(1, Number(process.env.OIP_GATE_CONCURRENCY ?? Math.min(2, cpus().length - 2)))

if (list) {
  const shown = GATES.filter((g) => matchesOnly(g.script))
  console.log(only.length ? `\ncurated gates matching --only=${only.join(',')}:` : '\ncurated gates:')
  for (const g of shown) console.log(`  ${g.script.padEnd(32)} ${g.why}`)
  if (only.length) console.log(`\n(${shown.length} of ${GATES.length} curated gates match)`)
  console.log('\n(--all also runs every other e2e/verify-*.mjs, as triage)')
  process.exit(0)
}

// Per-script wall-clock cap. Without it, one script that never settles holds the whole run
// forever: `pool()` awaits every worker, so a single hang blocks the report for all the others
// (observed: one hung script left a 129-script triage with no output for 2.5 h). A timeout turns
// that into one FAIL line plus 128 usable results, which is what triage mode is for.
const SCRIPT_TIMEOUT_MS = Number(process.env.OIP_GATE_TIMEOUT_MS ?? 8 * 60_000)

function run(script) {
  return new Promise((resolve) => {
    const started = Date.now()
    // Sampled across exactly this script's lifetime, so a slow row says whether it was slow or the
    // box was busy. Costs one tasklist/ps at each end; nothing here can fail the run.
    const load = loadBegin()
    const child = spawn(process.execPath, [join(E2E, script)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      timedOut = true
      // tree-kill: these scripts spawn vite + browsers, and killing only the node parent orphans
      // them (the ~90-orphan pile-up AGENTS.md warns about)
      if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    }, SCRIPT_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) out += `\n\n*** TIMED OUT after ${(SCRIPT_TIMEOUT_MS / 1000).toFixed(0)}s - killed by run-gates (raise OIP_GATE_TIMEOUT_MS if this script is legitimately slow) ***`
      resolve({ script, code: timedOut ? 124 : code, ms: Date.now() - started, out, timedOut, load: loadEnd(load) })
    })
  })
}

/**
 * Classify a finished script so triage sorts ITSELF.
 *
 * A bare FAIL costs a human investigation to attribute, so the split is **"could not test" vs
 * "tested and disagreed"**:
 *
 *   HARNESS  the script died on its OWN assumptions (a missing `__oip` method, a moved fixture, a
 *            navigation that never landed). Nothing was asserted, so it CANNOT be a regression.
 *   FAILED   an assertion disagreed: the only class that might be a real regression.
 *   SKIP     exited clean WITHOUT testing (no WebGPU adapter, no prod build); never counted as PASS.
 *   HUNG     never settled inside the cap.
 *
 * Whether a FAILED assertion is "really" fixture drift is semantic, so it is surfaced as a HINT for
 * a human, never as a verdict.
 */
const HARNESS_PATTERNS = [
  [/(\w[\w.]*) is not a function/, 'test calls an app API that no longer exists'],
  [/Cannot read properties of (?:null|undefined) \(reading '([^']+)'\)/, 'test reads a property off a missing app object'],
  [/ReferenceError: (\w+) is not defined/, 'script bug (undefined identifier)'],
  [/Execution context was destroyed/, 'page navigated mid-evaluate (HMR reload - see AGENTS.md)'],
  [/page\.goto: Timeout|net::ERR_|ERR_CONNECTION/, 'never reached the app'],
  [/Resulting promise was garbage collected/, 'in-page promise never settled (script bug)'],
  [/waitForFunction: Timeout .* exceeded/, 'app never reached the state the test waits on'],
  [/Target (?:page|browser) .*closed/, 'browser died mid-run'],
]

// A self-reported skip. Scripts print these when a capability is absent (no WebGPU adapter, no
// dist/) and then exit 0 - clean, but nothing was verified.
const SKIP_PATTERN = /^\s*(?:SKIP|SKIPPED|SKIPPING)\b/im

// The fleet's verdict convention: a leading FAIL token on its own line (check() helpers, ALL PASS
// banners). Matched anchored so the word inside prose doesn't count.
const VERDICT_FAIL = /^\s*(?:FAIL|✖)\b/m

function classify(r) {
  if (r.timedOut) return { cls: 'HUNG', hint: `no verdict within ${(SCRIPT_TIMEOUT_MS / 60000).toFixed(0)}m` }
  for (const [re, why] of HARNESS_PATTERNS) {
    const m = re.exec(r.out)
    if (m) return { cls: 'HARNESS', hint: `${why}${m[1] ? ` - ${m[1]}` : ''}` }
  }
  if (r.code !== 0) {
    if (VERDICT_FAIL.test(r.out)) {
      const line = r.out.split('\n').find((l) => VERDICT_FAIL.test(l)) ?? ''
      return { cls: 'FAILED', hint: line.trim().slice(0, 96) }
    }
    return { cls: 'HARNESS', hint: `exit ${r.code} with no verdict line - died before asserting` }
  }
  if (SKIP_PATTERN.test(r.out)) {
    const line = r.out.split('\n').find((l) => SKIP_PATTERN.test(l)) ?? ''
    return { cls: 'SKIP', hint: line.trim().slice(0, 96) }
  }
  return { cls: 'PASS', hint: '' }
}

/** run `items` through `fn`, at most `limit` at a time */
async function pool(items, limit, fn) {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

const hasDist = existsSync(DIST_APP)
const curated = GATES.filter((g) => {
  // --only is applied BEFORE the dist check so an excluded prod gate doesn't print a SKIP line for a
  // build it was never going to need
  if (!matchesOnly(g.script)) return false
  if (g.build && !hasDist) {
    console.log(`SKIP  ${g.script} - needs a prod build (run \`npm run build\`)`)
    return false
  }
  return true
})

let scripts = curated.map((g) => g.script)
let banner = `running ${scripts.length} curated gate(s), ${CONCURRENCY} at a time\n`
if (all) {
  const extra = readdirSync(E2E)
    .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs') && !scripts.includes(f) && matchesOnly(f))
    .sort()
  scripts = [...scripts, ...extra]
  banner = `triage mode: ${scripts.length} scripts (${curated.length} curated + ${extra.length} others)\n`
}

// A typo'd --only must not look like a clean run: exit non-zero BEFORE any "running 0 gates" banner.
if (!scripts.length) {
  console.log(`\n✖ --only=${only.join(',')} matched no ${all ? 'e2e/verify-*.mjs script' : 'curated gate'} - nothing ran (\`--list\` prints the names)`)
  process.exit(1)
}
console.log(banner)

// One lease for the whole batch, not one per gate: children inherit OIP_E2E_LEASE through their
// env, so CONCURRENCY stays whatever it is set to instead of deadlocking itself down to 1. Other
// e2e runs on this machine queue behind us; anything that never calls startServer (a dev server, a
// vitest run, another toolchain) cannot be made to, which is what the per-result stamp is for.
await acquireLease({ label: `run-gates (${scripts.length} gates)` })

/**
 * One dev server for the whole batch.
 *
 * A vite per gate costs 9-16 s each, 7-12 minutes of a 90-gate run.
 *
 * Published through the SENTINEL rather than OIP_SHARED_PORT: the sentinel is the
 * auto-attach channel that `startServer({ isolated: true })` correctly refuses, while OIP_SHARED_PORT
 * is the "explicit, trust it" channel that some scripts test to decide whether to isolate at all
 * (verify-collab-code-trust: `isolated: !process.env.OIP_SHARED_PORT`). Setting the env would flip
 * that gate onto a server booted without its VITE_COLLAB_URL, i.e. at the PRODUCTION collab server.
 *
 * Safe only because of the lease above: with one e2e run on the box at a time, nothing else is
 * attached to this server when we tear it down. OIP_GATE_NO_SHARED=1 goes back to a vite per gate.
 */
let sentinelOwned = false
if (!process.env.OIP_GATE_NO_SHARED) {
  const { startServer, SHARED_SENTINEL } = await import('../e2e/_server.mjs')
  const { writeFileSync, rmSync } = await import('node:fs')
  const shared = await startServer({ lease: false, quiet: true })
  if (shared.vite.pid) {
    // we cold-started it, so we publish it and we own its teardown
    writeFileSync(SHARED_SENTINEL, JSON.stringify({ port: shared.port, pid: process.pid }) + '\n')
    sentinelOwned = true
    process.on('exit', () => {
      if (!sentinelOwned) return
      sentinelOwned = false
      try { rmSync(SHARED_SENTINEL) } catch { /* already gone */ }
      shared.vite.kill()
    })
    console.log(`one shared dev server for this batch: ${shared.url}\n`)
  } else {
    // someone already has `npm run e2e:server` up - use it, never tear it down
    console.log(`attached to the shared dev server already on :${shared.port}\n`)
  }
}

// One line per gate as it finishes, ahead of the grouped table below. A full curated run is 40+ minutes and
// the table only prints at the end. A run can be killed (a CI step timeout, an agent's background task limit),
// and these lines keep every verdict reached before that. Provisional: a non-PASS is re-checked serially below and may end up FLAKY.
let finished = 0
const results = await pool(scripts, CONCURRENCY, async (script) => {
  const r = await run(script)
  r.verdict = classify(r)
  console.log(`  [${++finished}/${scripts.length}] ${r.verdict.cls.padEnd(7)} ${script}  ${(r.ms / 1000).toFixed(0)}s`)
  return r
})

/**
 * Confirm pass: re-run every non-PASS result one at a time before believing it.
 *
 * Measured: a 150-script triage at concurrency 4 on one dev server reported 41 HARNESS + 7 HUNG +
 * 26 FAILED, and every sampled one passed alone. Heavyweight WebGL/WebGPU pages starve each other
 * until waitForFunction budgets expire, causing failures that look like fleet rot.
 *
 * A failure that does not reproduce in isolation comes from the runner, so it gets its own class
 * (FLAKY). Serial, one retry; PASSes are never re-run.
 */
const suspects = results.filter((r) => r.verdict.cls !== 'PASS')
if (suspects.length) {
  console.log(`\nconfirming ${suspects.length} non-PASS result(s) serially (contention check)...`)
  for (const s of suspects) {
    const again = await run(s.script)
    const v = classify(again)
    const i = results.indexOf(s)
    if (v.cls === 'PASS') {
      results[i] = { ...again, verdict: { cls: 'FLAKY', hint: `passed alone; was ${s.verdict.cls} under load - runner contention, not code` } }
    } else {
      results[i] = { ...again, verdict: v }
    }
  }
}

const width = Math.max(...results.map((r) => r.script.length))
// Grouped by class, worst first: the point of the table is that the ACTIONABLE rows sit together
// instead of being scattered through 150 lines nobody reads to the end of.
const ORDER = ['FAILED', 'HUNG', 'HARNESS', 'FLAKY', 'SKIP', 'PASS']
console.log('')
for (const cls of ORDER) {
  const rows = results.filter((r) => r.verdict.cls === cls)
  if (!rows.length) continue
  for (const r of rows) {
    const load = formatLoad(r.load)
    const mark = looksContended(r.load) ? '  ⚠ ' : '  '
    console.log(
      `  ${cls.padEnd(7)} ${r.script.padEnd(width)}  ${(r.ms / 1000).toFixed(0)}s` +
        `${load ? `${mark}[${load}]` : ''}${r.verdict.hint ? `  · ${r.verdict.hint}` : ''}`,
    )
  }
  console.log('')
}

// Only FAILED bodies are worth dumping: a HARNESS death is fully described by its hint, and 25
// lines of stack per stale script make the triage output unreadable.
for (const r of results.filter((x) => x.verdict.cls === 'FAILED')) {
  console.log(`\n──── ${r.script} ────`)
  console.log(r.out.split('\n').slice(-25).join('\n')) // tail: these scripts print a verdict last
}

const count = (cls) => results.filter((r) => r.verdict.cls === cls).length
const failed = results.filter((r) => r.code !== 0)

// Machine-readable dump so fleet rot can be TRACKED rather than rediscovered each time.
const jsonArg = args.find((a) => a.startsWith('--json='))
if (jsonArg) {
  const { writeFileSync } = await import('node:fs')
  const path = jsonArg.slice('--json='.length)
  writeFileSync(
    path,
    JSON.stringify(
      { scripts: results.length, ...Object.fromEntries(ORDER.map((c) => [c.toLowerCase(), count(c)])),
        results: results.map((r) => ({ script: r.script, cls: r.verdict.cls, hint: r.verdict.hint, ms: r.ms, load: r.load, contended: looksContended(r.load), curated: scripts.indexOf(r.script) < curated.length })) },
      null,
      2,
    ),
  )
  console.log(`\nwrote ${path}`)
}

// Loud, above BOTH summaries, and for the same reason as the SUBSET banner below: a run whose
// numbers cannot be trusted must not be REMEMBERED as one whose numbers were fine. A verdict taken
// on a contended box is still a verdict (FAILED means it reproduced alone), but the TIMINGS are
// noise - measured: the same probe disagreed with itself 7x on one phase, and three
// conclusions were drawn off the first set before anyone looked at the process table.
const contended = results.filter((r) => looksContended(r.load))
if (contended.length) {
  const worst = contended.reduce((a, b) => ((b.load?.cpuPct ?? 0) > (a.load?.cpuPct ?? 0) ? b : a))
  console.log(
    `
⚠ CONTENDED RUN - ${contended.length} of ${results.length} gate(s) ran while this machine was busy ` +
      `(worst: ${formatLoad(worst.load)}). Treat the SECONDS as noise, not measurements. ` +
      `
  Other e2e runs queue behind this one automatically (e2e/_lease.mjs); a dev server, a vitest run or ` +
      `another toolchain does not - close those and re-run before trusting a timing.`,
  )
}

// Loud, above BOTH summaries: the one failure mode of --only is a green subset being remembered as a
// green gate run.
if (only.length) {
  console.log(
    `\n⚠ SUBSET RUN - --only=${only.join(',')} selected ${curated.length} of ${GATES.length} curated gates; ` +
      `the other ${GATES.length - curated.length} did not run. Run \`npm run gates\` unfiltered before committing.`,
  )
}

if (all) {
  // triage never gates: a stale _dbg-era verify script failing is information, not a build break
  const curatedFailed = failed.filter((r) => scripts.indexOf(r.script) < curated.length)
  console.log(
    `\n${results.length} scripts: ${count('PASS')} pass · ${count('FAILED')} failed · ` +
      `${count('HARNESS')} harness-rot · ${count('HUNG')} hung · ${count('FLAKY')} flaky-under-load · ${count('SKIP')} skipped`,
  )
  console.log(
    `\n  FAILED  (${count('FAILED')}) reproduced ALONE and disagreed - read these first; only these can be regressions.` +
      `\n  HARNESS (${count('HARNESS')}) reproduced alone but never asserted: the script's own assumptions broke. Fix or retire.` +
      `\n  FLAKY   (${count('FLAKY')}) failed under load, passed ALONE - the runner contending, not the code.` +
      `\n  SKIP    (${count('SKIP')}) exited clean without verifying - a green run that proves nothing.`,
  )
  console.log('\nTriage does not fail the build - promote passing scripts into GATES, retire the rest.')
  process.exit(curatedFailed.length ? 1 : 0)
}

// Curated mode: a SKIP is not a pass. It exits clean (the capability is genuinely absent on this
// machine) but is called out, so "all gates passed" never quietly means "half of them opted out".
if (count('SKIP')) console.log(`\n(${count('SKIP')} gate(s) SKIPPED - capability absent, nothing verified)`)
const passBanner = only.length
  ? `✓ ${results.length} of ${GATES.length} gates passed (SUBSET - not a gate run)`
  : `✓ all ${results.length} gates passed`
console.log(`\n${failed.length ? `✖ ${failed.length} gate(s) failed` : passBanner}`)
process.exit(failed.length ? 1 : 0)
