# AGENTS.md

This is the guide for AI coding agents working in this repo. Claude Code reads it through `CLAUDE.md`, which only
imports it. Human contributors will find it useful too, but [CONTRIBUTING.md](CONTRIBUTING.md) is where they should
start. Keep it short: rules and pointers here,
background in `docs/`. Add a section only when a convention isn't obvious from the code.

Comments in code say what it does and why, briefly: keep the reason for a choice (a measurement, the bug a guard
prevents), and leave dates and "used to" history to the commit message. Don't restate the code, and capitalise a
word only where misreading it causes a bug. Write plain short sentences: no figures of speech ("pays for it", "for
free", "earns its place"), no code cast as a character, no chains of semicolons and dashes. Docs describe the
system as it is: no "Status: shipped" banners or build logs, and a finished plan becomes a description or is deleted.

oip-web is a browser-based industrial-automation simulator (conveyors, sensors,
PLCs) built in TypeScript / three.js / Jolt-physics. It also ships a native surface
(Electron); the TS core is the portable heart.

## Commands

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (vite, `/` = landing, `/app/` = editor) |
| Unit tests | `npm test` (vitest, `src/**/*.test.ts`, node env) |
| Typecheck | `npm run typecheck` (`tsc -b`) |
| Lint | `npm run lint` (`eslint src`) |
| All PR checks | `npm run check` (every no-browser check CI runs; `-- --quick` skips the build and the collab server) |
| Prod build | `npm run build` (checks models → tsc → vite build → optimize-assets) |
| Prod preview | `npm run preview:prod` (dist + the real host config) · `npm run preview:slow` (same, throttled) |
| E2E gates | `npm run build && npm run gates` (curated must-pass list) · `npm run gates -- --all` (triage the whole fleet) |
| Live smoke | `npm run smoke-prod` (the deployed site's headers + brotli wasm; runs in deploy-pages.yml) |
| Desktop package | `npm run desktop:pack` (→ `apps/desktop/release/win-unpacked`) · `npm run desktop:dist` (NSIS installer; refuses a dirty tree or a HEAD not on origin/main, because an installer's build stamp claims collab rooms) · `node scripts/desktop-smoke.mjs <executable>` (boots a packaged build over CDP; fuses block `--inspect`, so Playwright can't drive it). See [apps/desktop/README.md](apps/desktop/README.md). A release is the hand-started [desktop.yml](.github/workflows/desktop.yml) workflow with `upload` ticked |
| Edge speed | `npm run edge-bench` ([docs/cdn-runbook.md](docs/cdn-runbook.md)) |
| Eager-JS census | `npm run eager-census` (the first-frame JS graph by source module; `-- --no-build`, `-- --top 40`) |
| Step profile | `npm run profile` (where the time goes on reload, after the cover lifts, opening the PLC dock, the ladder face, Problems, Play and Stop, on an 800-part reference line; `-- play dock`, `-- --stations 1000`, `-- --project line.oip`, `-- --no-build`) |
| Dev on prod assets | `OIP_DEV_PROD_ASSETS=1 npm run dev` (serves `/models` + `/textures` from `dist/`) |
| ST oracles | `npm run st-oracle` (MATIEC) · `st-oracle:ed3` (STruC++) · `st-oracle:xml` · `st-oracle:openplc` · `st-oracle:dry`; on Windows `wsl -u root -- bash scripts/oracle-wsl.sh all` |
| PLC in the loop | `npm run openplc-loop` (OpenPLC over Modbus TCP) · `npm run openplc-loop:cells` (OpenPLC as a second controller beside the program) · `npm run s7-loop` (snap7 over S7) |
| Headless CLIs | `catalog`, `check-part`, `add-part`, `edit-part`, `duplicate-parts`, `rename-tag`, `assign-io`, `snap-part`, `shot-part`, `inspect-glb`, `import-model`, `validate-project`, `check-st`, `check-wiring`, `check-layout`, `test-project`, `check-flow`, `bench-sim`, `capabilities`, `build-part-sdk`, `build-parts`, `build-library`, `sign-library`, `library-key`, `check-submission`, `library-corpus`, `bake-walls`, `sdk-usage`, `retired-kinds` |

The headless CLIs, the oracles and the PLC loops are documented in [docs/cli.md](docs/cli.md): no browser, real exit
codes, the door an agent or a pre-commit hook uses. Never hand-edit a project's scene.json; use `add-part` /
`edit-part` / `snap-part --write`.

## Hosting

`www.openindustryproject.org` is the `oip-web` Cloudflare Pages project; a push to `main` deploys it
(`deploy-pages.yml`, which then runs `smoke-prod` and `edge-bench`). `public/_headers`, `public/_redirects` and
`public/404.html` are the production config, and [e2e/_edge-server.mjs](e2e/_edge-server.mjs) replays them locally.
**Keep a top-level `404.html`:** without one Pages goes into SPA mode and answers a not-yet-propagated chunk with the
landing at 200, which the `/assets/*` immutable header then pins for a year. DNS is on Cloudflare;
`collab.openindustryproject.org` is an unproxied A record to its own VM. There is one hosting target, so nothing in
the build is host-conditional. Measurements and hosting traps: [docs/cdn-runbook.md](docs/cdn-runbook.md).

## Measuring and budgets

Background for all of this: [docs/e2e-and-budgets.md](docs/e2e-and-budgets.md).

- **Never judge load or asset behaviour from `npm run dev` or `vite preview`.** Neither applies the host config, and
  dev serves unoptimised assets. Use `OIP_DEV_PROD_ASSETS=1 npm run dev`, `npm run preview:prod` / `preview:slow`, or
  the gate [e2e/verify-first-load.mjs](e2e/verify-first-load.mjs).
- **Never judge mobile performance from an emulated phone.** The MOBILE preset in
  [src/render/quality.ts](src/render/quality.ts) is unmeasured; `?bench` ([src/editor/bench.ts](src/editor/bench.ts))
  on a real device is the instrument.
- **`npm run build` fails on a budget** (asset sets in `optimize-assets.mjs`), and **`npm run gates` on a draw
  budget** ([e2e/verify-draw-budget.mjs](e2e/verify-draw-budget.mjs)). Raise one deliberately, in the commit that
  grew it. The eager JS ([scripts/lib/eager-js.mjs](scripts/lib/eager-js.mjs)) has a loose ceiling and a jump check:
  the build fails when the first-frame JS grew more than one change normally adds since the last local build. When it
  fails, run `npm run eager-census` to see which modules; accept intended growth with `npm run eager-check -- --accept`.
- **A budget that improves on its own is unearned until you can name the mechanism**: find what got merged, dropped
  or skipped.
- **A gate that counts the scene waits on `window.__oip.assetsBusy()`**, never a timed wait or a two-sample hold.
- **Typecheck cache:** `tsc -b` caches in `.types/*/tsconfig.tsbuildinfo`, and a stale cache can pass locally while
  CI fails. Near a deploy, delete `.types/` and re-run.

## Vendor boundary (copyright and EULA)

Project policy: minimize any chance of infringing copyright or breaking a vendor's licence. When
a choice is unclear, take the conservative one. Concretely:

- **Build from public standards and generic ideas only**: IEC 61131-3, the PLCopen motion blocks and PLCopen XML 2.01,
  described in our own words (never the standards' text, tables or figures). Project trees, Find, cross-reference and
  tag lists are generic; a vendor's instruction set, data types, language extensions, file format or UI layout is not.
  So the engine has no vendor dialect, no vendor language extensions (PROPERTY, VAR_INST, REFERENCE TO, THIS^,
  AND_THEN), no vendor-flavoured PLCopen export and no vendor motion library's names or ramp shapes; don't add them, or
  a renamed copy.
- **No commercial vendor software in development or testing**: no CODESYS, TwinCAT, Studio 5000 / Emulate, TIA Portal
  or Ignition as an oracle, a test target, a source of fixtures or screenshots, or a side-by-side reference. The oracles
  are open source (MATIEC, STruC++, OpenPLC, snap7, libplctag's ab_server), kept outside the app by the GPL boundary
  (THIRD_PARTY_NOTICES.md).
- **No vendor-derived data or behaviour**: nothing captured from a vendor's software, and no behaviour fitted to its
  output. Where IEC leaves a choice open, the engine's rule is ours and documented as ours.
- **Connecting is fine**: protocol clients talk to equipment the user owns (Modbus, OPC UA, S7, SLMP, ADS through the user's
  own TcAdsDll, EtherNet/IP through libplctag). Reading another tool's spellings on input and writing IEC is fine.
- **Claims**: "a subset of IEC 61131-3 ... not certified"; never "compliant", "certified" or a logo. Vendor names only
  to identify a product (THIRD_PARTY_NOTICES.md lists the marks), never as our specification ("as CODESYS does").

## Architecture: layered, with enforced import boundaries

`src/` is split into layers whose dependencies are **enforced by
[eslint.config.js](eslint.config.js)** (`no-restricted-imports`) - a lint error here
means you crossed a layer, not that you used the wrong path:

- **`src/core/`** - headless simulation/scene/PLC logic. **No** DOM, three, React, Jolt,
  or downstream (`sim`/`render`/`editor`) imports. Must stay portable & deterministic;
  this is the code shared with the native surface.
- **`src/sim/`** - physics stepping; may import only `core`, `jolt-physics`, and `plc`
  (the ST scan runs in-worker, interleaved with the physics steps -`sim/plcHost.ts`).
- **`src/render/`** - three.js scene; may import only `core` + `three` (no React/Jolt).
- **`src/editor/`** - React UI; may use every other layer.
- **`src/plc/`** - Structured-Text PLC engine.
- **`src/collab/`** - Yjs live editing. It drives the editor store, so it may import `editor` and `core`, but not
  three, Jolt, `sim`, `render` or `plc`.

When adding code, put it in the lowest layer that can hold it and respect the bans -
e.g. don't reach for `three` inside `core` to "just compute a matrix."

**The four big classes compose owned state; don't put fields back on them.** `RenderView`
([view.ts](src/render/viewport/view.ts)), `EditorController` ([controller.ts](src/editor/controller.ts)),
`SimWorld` ([world.ts](src/sim/world.ts)) and `EditorStore` ([store.ts](src/editor/store/store.ts)) are composition
roots: each area keeps its fields in an object it owns, in its own module, held as a `readonly` field (e.g.
`ViewWarmState` in viewWarm.ts, `CameraState` in controller/camera.ts, `CargoRegistry` in sim/cargoRegistry.ts,
`UndoHistory` in storeHistory.ts). An area's functions take their own state plus a narrow dependency type (a
`Pick<...>` of the class, or a small interface), never the whole object. New state goes into the owner of its area,
or a new owner, not onto the class; a member is public only because something outside the class needs it. A field an
e2e script reads or patches by name stays reachable as a forwarding accessor marked `/** @internal test hook */`;
keep those working, and don't add one for anything else. Fields many areas genuinely share (renderer, scene, store,
sim handles) stay on the class. `RenderView` is built only in App.tsx (everything else uses `IRenderView`,
render/api.ts), and `SimWorld` is imported only in `src/sim/` and the project-test runner (projectTestRunner.ts,
projectTestsRun.ts); eslint enforces both.

## Where things live

- **`packages/part-sdk/`** - the public Part SDK (`@oip/part-sdk`); custom parts are portable JS authored against it.
  `docs/part-authoring-guide.md` is the author-facing tour; keep it in step when the SDK gains a capability.
- **`docs/`** - design docs for the non-obvious systems. Read the matching doc before reworking an area:
  `architecture.md` (one core, two shells), `scene-composition.md`, `part-sandbox.md` (SES + Compartments, folder
  grants, network consent), `ladder.md`, `motion-control.md`, `plc-typed-storage.md`, `three-coupling.md` (every
  three.js internals patch; read before bumping three, update when you add or retire a patch), `cdn-runbook.md`
  (hosting measurements and texture-residency numbers; read before spending effort on load performance).
- **`apps/desktop/`** - the native (Electron) shell wrapping the same TS core.
- **Code review passes: [.claude/review-ledger.md](.claude/review-ledger.md)**, where the last pass stopped, the next
  area in the rotation, and findings left on purpose. A review reads it first, skips what it lists as accepted, and
  adds its own row last.
- **The agent door: [src/editor/agent/tools.ts](src/editor/agent/tools.ts)**, what an AI agent may do to the open
  editor, served by the desktop app over MCP at `http://127.0.0.1:5189/mcp`
  ([apps/desktop/mcpServer.cjs](apps/desktop/mcpServer.cjs) is only the transport). Off in an installed app until
  Settings > Agent connections allows it (Help > Agent Connections... opens it there), on in the dev shell. Agent edits go through the store's own paths, one
  "Agent: ..." undo step each; a new tool is one entry in `AGENT_TOOLS`. Read [docs/agent-tools.md](docs/agent-tools.md)
  first. Gated by `verify-agent-mcp-electron.mjs`.
- **The PLC panel is [PlcPanel.tsx](src/editor/components/plc/PlcPanel.tsx)**: it owns the program file and the window
  (text editor, status lines, file menu, the organizer column with `PlcOrganizer` / `LadderView` / `LadderVariables`,
  and the controller's faults). It pops out only from the pop-out button in its header, and a dialog opened from the
  popup mounts in that document ([dialogHost.ts](src/editor/dialogHost.ts)). Ladder chords are the keymap's `ladder`
  mode. The engine reads IEC 61131-3 only; a saved `stDialect` is a compatibility marker that refuses the program at
  run time and keeps its text (docs/projects.md).

## Dev / prod foot-guns

- **SES `lockdown()` runs in the page and the sim worker**, so part code can run sandboxed
  ([docs/part-sandbox.md](docs/part-sandbox.md)). Every intrinsic is frozen, so in any module: never assign a property
  an intrinsic prototype also has (`map.get = ...` throws; use `Object.defineProperty`), and never fill a
  `new Array(n)` hole by hole in a hot loop (~25x slower frozen; `.fill()` first). Unit specs run locked down too,
  except those that fake timers or say `@unlocked-realm`. Anything the host hands part code is a copy, and anything it
  keeps from part code is a `hostCopy`.
- **In a part folder with a `part.js`, `behavior.ts` and `rig.json` are output.** Edit the `part.js` (or the
  `examples/parts/_shared/` module it imports) and run `npm run build-parts -- <dir>`; `--check` fails CI on an edit
  to the output. They carry no header saying so, because the same text ships in every project's copy.
- **After changing a first-party part, re-record it: `npm run parts:record`.** It runs
  `scripts/shipped-behaviors.mjs` (older rooms recognise built-ins by their behavior copies), `scripts/part-corpus.mjs`
  (every shipped part version must still load and behave as recorded; `test-corpus/` is append-only) and, when a model
  or texture changed, `scripts/bake-part-assets.mjs` (`public/part-assets/<sha256>.<ext>`, append-only, never delete
  one). Their tests fail otherwise.
- **Edit `scripts/optimize-assets.mjs` only when the optimizer itself changes.** Asset versions hash its bytes, so any
  edit, even a comment, re-versions every model and texture for every visitor and needs a part-asset re-bake.
- **The PLC runs on the typed engine; the walker is its reference and fallback.** Read
  [docs/plc-typed-storage.md](docs/plc-typed-storage.md) first. A new AST node is generated in
  [scanCodegen.ts](src/plc/scanCodegen.ts) (there is no per-node fallback; an unsupported construct refuses the whole
  program onto the walker). `typedRefusals` and `codegenFallbacks` must stay empty. Never name a free global (`Math`,
  `Array`) in generated source: bind it in `helpersFor`. Program text from a room becomes code, so every name and
  literal enters the source through `JSON.stringify`. Measure with `npm run bench-sim -- <project> [--engine walker]`
  (fingerprint must not move), A/B in one process for anything under ~20%, and never lower a
  [scanSpeed.test.ts](src/plc/scanSpeed.test.ts) floor to make it pass.
- **A reader of the open program asks the program worker; it does not check or compile on the page.** Checking costs
  about 19 ms per thousand lines and compiling about 30, and readers run at every pause in typing and every scene
  edit. [programWorkerClient.ts](src/editor/program/programWorkerClient.ts) answers three questions off the main
  thread: `surfaceFor` (what the program declares, for the Inspector's tag fields), `checkFor` (its problems, for the
  text editor's lint) and `factsFor` (all the Problems panel asks, [programFacts.ts](src/editor/program/programFacts.ts)).
  Hand it the program as the store holds it (text, table, scan time): `controllerFor` reads the whole text too. A new
  question is a function of the ask in [programWorkerAsk.ts](src/editor/program/programWorkerAsk.ts), which the worker
  and the page's fallback both call. All three go to one worker ([programService.ts](src/editor/program/programService.ts)),
  one at a time with the lint first, so the program is read once for all of them; a new kind of question joins that
  queue. The worker runs the walker, so nothing from the program is evaluated there. Play
  still compiles on the page, once per attach.
- **A running program's value table (`plcWatch`) may be a Proxy over a copy of the controller's memory**
  ([core/watchTable.ts](src/core/watchTable.ts), docs/plc-typed-storage.md "The watch table"). `table[key]` and
  `key in table` are fine. Never `Object.keys`, `Object.entries`, spread or `for..in` one: a large program holds
  half a million values. Use `watchKeysOf` / `forEachWatchValue` / `watchKeyCount` / `overlayTable`, and
  `withWatchValue` to show a written value. Keep what you derive from the keys per key set (`keySetOf`,
  core/watchKeys.ts), since the table is a new object on every send. Gated by `largeWatchBudget.test.ts` and
  `watchPlan.test.ts`.
- **Two I/O binding rules are ours, not IEC's** ([src/plc/DEVICE-IO.md](src/plc/DEVICE-IO.md)): the first PLC scan
  follows the parts' first step (so a normally-closed input reads TRUE on scan 1; changing this moves every bench-sim
  fingerprint), and a controller running one program instance also answers to its variables by bare name. Add any
  by-name surface through `LocalPlcLink` (`aliases` / `tagView`), never by matching `Inst.` prefixes yourself.
- **App-level actions live in [src/editor/commands.ts](src/editor/commands.ts)**: label, enablement and behaviour, once.
  The toolbar, overflow, context menu, native menu and command palette all render that list. `core/keymap.ts` owns
  chords and joins by id. A command sets `accelerator` (the native menu binds it) or `keys` (the app binds it), never
  both, or the keystroke fires twice. Enablement goes in the command; the desktop main process can't see the
  selection, so it is pushed the answer (`menu:enabled`). [apps/desktop/main.cjs](apps/desktop/main.cjs) holds no app
  labels of its own.
- **Only authoring writes the document; operating never does.** The store's edit gate
  ([store.ts](src/editor/store/store.ts) `commit` → `documentChanged`) decides what is an edit: a change to the scene minus
  what the current run owns (`documentOf`). Only that gets undo, autosave, folder writes, room-feed lines or a demo
  fork. Use operates a device and never writes a param ([controller/pilot.ts](src/editor/controller/pilot.ts)
  `idleUsePart`). Run or session state never enters `scene.parts` except as run-owned cargo, marked run-owned before
  the commit that adds it; other session state is store state overlaid in `editTargetViewScene`.
  [docs/document-and-run.md](docs/document-and-run.md). Gated by `verify-run-cargo-not-edits.mjs`,
  `verify-walk-session.mjs` and the "edit gate" block in `store.test.ts`.
- **A reaction to a scene edit must cost what the edit touches, not the scene.** A drag streams ~60 scenes a second.
  In the view a reaction is a `SceneConsumer` ([viewSceneConsumers.ts](src/render/viewport/viewSceneConsumers.ts))
  declaring the parts it `reads` (checked against [SceneDelta](src/core/scene/sceneDelta.ts)) and an idle `audit()`; a pure
  derivation of parts is a `memoParts.ts` memo. [docs/scene-change-consumers.md](docs/scene-change-consumers.md).
  Gated by `verify-interaction-budget.mjs`.
- **Text an editor component shows goes through [src/core/i18n.ts](src/core/i18n.ts)**: one `defineMessages` table
  per file, `t()` while rendering (never at module scope: a locale installs at boot, after modules load), a count as
  a `{ one, other }` plural, a sentence with an element inside as `tNodes` ([i18nNodes.tsx](src/editor/i18nNodes.tsx)).
  Never build a sentence from fragments. What a program or file matches exactly (tags, IEC keywords, part ids,
  units, key names) stays literal, marked `i18n-ok`. `/app/` opts out of browser page translation on purpose; the
  browser's Translator API translates the messages instead ([autoTranslate.ts](src/editor/autoTranslate.ts)), with
  English as the fallback and a Settings choice. Gated by `i18nCoverage.test.ts` and `verify-auto-translate.mjs`;
  `node scripts/i18n-scan.mjs <file>` lists a file's strings.
- **Keyboard bindings live in [src/core/keymap.ts](src/core/keymap.ts); never compare `e.key` inline.** Spatial keys
  (tools, snapping, WASD) match `e.code` (position, so AZERTY works); the Ctrl family matches `e.key` (undo on the
  printed Z). Modifier matching is exact, so a key held through a modal gesture needs `anyModifiers`, or it goes dead
  under Shift and its keyup is swallowed. `Escape` is `fixed`: documented in the table, never routed through the
  resolver. Rebinding goes through `resolveKeymap(overrides)` ([keymapPrefs.ts](src/editor/keymapPrefs.ts)). Gated
  by [e2e/verify-keymap.mjs](e2e/verify-keymap.mjs).
- **Never `dispose()` a geometry, instanced mesh or texture in `src/render/`; use `retireGeometry()` /
  `retireInstancedMesh()` / `retireTexture()`** ([gpuRetire.ts](src/render/gpuRetire.ts)). A WebGPU render bundle
  bakes resource handles; freeing one a recording holds makes Dawn reject the submit, and the viewport goes black
  without a throw. [gpuErrorWatch.ts](src/render/gpuErrorWatch.ts) tallies these on `globalThis.__oipGpuErrors`.
  Materials are the exception (three routes their dispose through a path the stale-recording guard catches; pinned in
  [docs/three-coupling.md](docs/three-coupling.md)). The direct frees left are for things never in the bundled pass:
  `View.dispose`'s helpers, editor overlays, geometry never drawn.
- **A project's part definitions live in one place: its library** (`store.userPackages`; on the desktop,
  `<project>/parts/<slug>/`). The registry is derived from it (`adoptProjectLibrary` replaces, never merges); editing
  a built-in forks it into the library; the parts shelf ([docs/parts-shelf.md](docs/parts-shelf.md)) is copied from,
  never read live. Don't add a second home for parts: two homes whose winner is load order leak across projects.
  The library is complete (format 5): every part a project uses is its own copy, built-ins stamped `origin.app`, never
  updated by the app on its own. A project holds one scene (format 4), and its folder keeps the program one file
  per POU under `plc/`, in the order the manifest lists, which is the program's order (format 7; the program is one
  string everywhere else). Read [docs/part-sources.md](docs/part-sources.md) and [docs/projects.md](docs/projects.md)
  before changing how parts or projects are stored. In the Catalog ✎ session the document's scene is parked in
  `packageEdit.document`: code that means the document reads `documentSceneOf(state)`. A new project-reading CLI reads
  the folder through `scripts/lib/projectFolderFiles.mjs` and declares built-ins (`scripts/lib/builtIns.mjs`) before
  it validates.
- **A rig link's pose has one resolver**: core `rigWorldPosesInto` / `rigLinkLocalPoseInto`
  ([src/core/rig/rigPose.ts](src/core/rig/rigPose.ts)). Never bake a param-driven offset into a link at build time. Which
  fields a param, joint or script owns is `linkFieldOwnership`, and the Inspector and gizmo lock what it says.
- **Flow facts are facts, never problems** (core/flow/flowFacts.ts, core/flow/flowFactLog.ts). They reach `get_problems`'
  `flowFacts`, the Tests overlay, `test-project` and `check-flow`, never the Problems dock, an error or warning count, or
  a test verdict, since an accumulating line stalls on purpose. Gated by `verify-flow-facts.mjs`.
- **A CLI that starts vite in middleware mode passes `server: { middlewareMode: true, hmr: false, ws: false }`**, or it
  binds the HMR port 24678 and prints a misleading "already in use".
- **`src/render/` edits force a full page reload in dev** (`oip-render-full-reload` in [vite.config.ts](vite.config.ts)):
  partial HMR on a live WebGL/WebGPU context corrupts it. Don't re-enable HMR for render.
- **`/app/*` is cross-origin isolated (COOP/COEP), in dev and prod**, for SharedArrayBuffer (threaded Jolt). Anything
  cross-origin inside the app (iframes, CDN scripts, hot-linked images, fonts) is blocked unless it opts in via
  CORS+CORP; keep app assets same-origin. Vite dev strips headers on 304s (the `coiHeadersOn304` plugin works around
  it; Safari kills the worker otherwise). The app shell is `Cache-Control: no-store`; relaxing it needs a Safari
  re-test (`public/_headers`).
- **"Works in dev, broken in prod" with models or textures**: suspect the prod-only optimizer
  (`scripts/optimize-assets.mjs`) first; it can strip GLB data such as UVs on untextured prims.
- **A change that won't show**: a leftover PWA service worker from a prod visit, or a stale dev server, can serve old
  code on localhost. Unregister the SW / clear site data, or restart the server, before re-debugging.
- **`/app/`'s first frame is static markup** ([app/index.html](app/index.html)'s boot skeleton). styles.css hasn't
  loaded yet, so every rule there names its own `font-family` and `box-sizing`, and every value is a copy that
  `bootSkeleton.test.ts` checks against the app. [verify-boot-skeleton.mjs](e2e/verify-boot-skeleton.mjs) proves the
  handover moves nothing.
- **Pages:** `/` is the landing, `/app/` the editor (deep links like `/app/?scene=demo` must fall back to the app
  shell). `/plc/` is generated by [scripts/lib/plc-page.mjs](scripts/lib/plc-page.mjs) from
  `public/st-capabilities.json`: edit the generator, never `plc/index.html`.

## E2E tests (`e2e/*.mjs`)

Playwright scripts run directly with node (`node e2e/verify-<name>.mjs`); one-off probes are `e2e/_dbg-<name>.mjs`
(gitignored), kept ones move to `e2e/probes/`. Each calls `startServer()` from [e2e/_server.mjs](e2e/_server.mjs),
which handles the server, teardown, the WebGPU error guard and the machine-wide GPU lease. How all of that works:
[docs/e2e-and-budgets.md](docs/e2e-and-budgets.md).

- **Scene screenshots use `cleanShot(page, path)`** from [e2e/_shot.mjs](e2e/_shot.mjs), never `page.screenshot()`
  or a canvas-locator screenshot, which bake in the HUD and overlays. Raw screenshots are for checking UI chrome.
- **For a parallel batch, run `npm run e2e:server` once**; scripts attach to it. `npm run gates` owns its own.
- **A `FAIL` from the GPU guard** means a render bundle drew a freed resource: read
  [src/render/gpuRetire.ts](src/render/gpuRetire.ts).
- **Headless WebGL uses the real GPU on Windows; headless never runs WebGPU.** A WebGPU leg needs `--headed` or
  `channel: 'msedge'`. `OIP_E2E_SOFTWARE_GL=1` restores SwiftShader.
- **Check a run's conditions before trusting its timings**: `run-gates` prints CONTENDED RUN when the box was busy.
- **Don't trust a run taken while `src/` is being edited**: HMR (and a render edit's full reload) kills scripts
  mid-evaluate. Let the tree go quiet, or use `npm run preview:prod`.
- **Orphaned processes**: kill command lines matching `vite|e2e/|run dev|npx-cli`; spare `index.mjs` (the collab
  server).
