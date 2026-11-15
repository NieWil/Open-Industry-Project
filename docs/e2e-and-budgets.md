# E2E gates, budgets and measuring

Background for the rules in [AGENTS.md](../AGENTS.md): why dev numbers mislead, what the build and gate budgets
guard, and how the Playwright harness (`e2e/*.mjs`) runs.

## Dev is not prod

Dev serves `public/` raw: no Draco, no host config, no latency. `vite preview` ignores `public/_headers` and
`public/_redirects` entirely (so no COOP/COEP, no immutable caching, no SPA rewrite). That gap is the source of most
"works in dev, broken in prod" bugs here (stripped UVs, dark walls, the Diverter stuck extended, dock doors
texturing themselves after the loading cover). Three tools close it, cheapest first:

- **`OIP_DEV_PROD_ASSETS=1 npm run dev`**: ordinary dev, but `/models` + `/textures` come from `dist/`. Needs a prior
  build. Source-asset edits need a rebuild to show up.
- **`npm run preview:prod` / `preview:slow`**: `dist/` through the real config
  ([e2e/_edge-server.mjs](../e2e/_edge-server.mjs)). `--slow` throttles to ~550 KB/s + 60 ms RTT in a real browser
  window. That profile is slower than Cloudflare usually serves, on purpose: a slow link keeps ordering bugs
  visible.
- **[e2e/verify-first-load.mjs](../e2e/verify-first-load.mjs)**: the gate. Its structural checks (renderer chunks
  loading in parallel, the building complete when the cover lifts, the catalog warm yielding to the scene) are the
  assertions. Cover time is reported, not enforced, because it is CPU-bound and machine-dependent (a GitHub runner with
  software WebGL is several times slower than a dev machine). Set `OIP_COVER_BUDGET_MS` on a
  known-quiet machine to enforce it.

Anything that depends on the host honouring the config (COOP/COEP, the no-store shell, wasm arriving compressed) can
only be proven on a real deployment, so `scripts/smoke-prod.mjs` runs against every Pages deployment, previews
included. It also reads the `wss://` collab URL out of the built bundle, so a DNS change that loses that record fails
the deploy instead of silently breaking live editing.

## Mobile performance

No performance number in this repo comes from a real phone. The mobile numbers came from a desktop GPU in a
phone-shaped viewport (`devices['iPhone 13']`, `?gfx=low`), which says nothing about a tile-based GPU, a shared memory
bus or thermal decay. The MOBILE preset in [src/render/quality.ts](../src/render/quality.ts) is an untested guess.

The instrument is `?bench` ([src/editor/bench.ts](../src/editor/bench.ts)): a deterministic orbit, frame quantiles
per time window, each window checkpointed to localStorage (a tab the OS kills is a result; `events.complete: false`
reports one), and a JSON blob to paste. Its overrides are per field: `?dpr=<n>` and `?msaa=<0|2|4|8>` each move one
preset field. DPR costs memory and thermal headroom while MSAA may cost almost nothing on a tiler, and changed together
they mask each other. The blob reports resolved values, so an ignored override shows as the unchanged number.
`?bench=<sec>` shortens a run and `?benchwin=2,5,8` names the windows. Gated by
[e2e/verify-bench-mode.mjs](../e2e/verify-bench-mode.mjs).

## Input latency

`?bench` measures frames with nobody touching the page. For the time from an input to the screen answering, run
`node e2e/perf-input-latency.mjs` against a build. It types into the PLC editor with the Problems panel mounted and
unmounted, opens and types into the command palette, clicks scene-tree rows and clicks parts in the 3D view. For each arm it prints two
readings: the time until the main thread finishes the next frame (an `idle` arm gives the frame-wait floor), and the
browser's Event Timing duration, which runs on until the frame is presented. A CPU-profile pass then splits each
input's main-thread time by source file (`OIP_FUNCTIONS=1` adds a table by function). React is bundled into the
`app` chunk, so that split needs source maps: build with
`npx vite build --sourcemap hidden && node scripts/optimize-assets.mjs`, measure, then run `npm run build` again.
Without maps it splits by chunk. `OIP_BACKEND=webgl|webgpu` forces a renderer. It prints numbers and never fails.

Compare arms within one run, because readings move a lot between runs on the same build. The Event Timing column
sits well above the next-paint one on both renderers, and a bare page with a WebGL canvas that redraws every frame
shows the same gap (`node e2e/probes/blank-input-latency.mjs`). The viewport redraws every frame, so that gap is the
browser's frame pipeline, not any one handler.

## Where the time goes at size

The demo scene is a few dozen parts and a short program, and it hides whatever costs in proportion to a project's
size. A lookup done once per rung operand, a compile done once per pooled mesh and an index of every value built
once per image were each invisible on the demo and took seconds on a 420-part line with a 25,000-line program.

`npm run profile` ([e2e/probes/profile-steps.mjs](../e2e/probes/profile-steps.mjs)) measures the editor at that
size. It builds the reference line ([e2e/_reference.mjs](../e2e/_reference.mjs)) from the built-in parts: belt
conveyors in rows with a sensor over each, every tag wired to a program that has a function block instance, an
array of structures and two rungs per station. 400 stations by default: 800 parts and a 7,625-line program whose
run holds about 210,000 values. `--stations 1000` reaches half a million values, and `--project line.oip` measures
a real project.

It then performs each step someone working in the editor does (reload, the seconds after the cover lifts, opening
the PLC dock, the ladder face, the Problems panel, Play, Stop) and prints for each: how long until its result was
on screen, the page's stalls, time working against time idle, and the functions that account for it. It runs
headed, since headless has no WebGPU, on an unminified build of its own (`.profile-build/`), so the functions
carry their names and `dist/` is left alone.

Read it this way:

- **Working against idle first.** A step that is mostly idle is waiting on something (the GPU, a worker, a frame),
  and no amount of faster script will shorten it.
- **Inclusive time says where to look, self time says what is slow.** A function high in both is the cost itself.
- **Compare runs taken one after the other.** The same step moved by 40% across an afternoon on one machine. A
  before and an after taken minutes apart can be compared; two taken an hour apart cannot.
- **A step that grows faster than the line does is a defect.** Run it at 100 and at 400 stations: four times the
  line should cost about four times as much. `largeProgramBudget.test.ts` holds the program's own stages to that.

The helper it is built on ([e2e/_profile.mjs](../e2e/_profile.mjs)) records a CPU profile around any drive of the
page and attributes a window of it by function, for a probe that asks a narrower question.

## Build budgets

`npm run build` fails on two asset budgets, the cover-gating asset set (building + dock bay) and total
models+textures, both in `optimize-assets.mjs`, and on two eager-JS checks (entry + modulepreloads, raw and brotli'd)
in [scripts/lib/eager-js.mjs](../scripts/lib/eager-js.mjs). vite's `chunkSizeWarningLimit: 6000` silences every chunk
warning, so the eager checks are the only guard on what the first frame waits for.

The two eager axes guard different costs. Brotli is wire time. Near a Cloudflare edge
([cdn-runbook.md](cdn-runbook.md)) the whole eager graph takes a fraction of a second, and the ceiling is for everyone
who isn't near one. Raw is CPU: the main thread parses and runs the uncompressed bytes before the editor exists
(`node e2e/probes/eager-boot-cpu.mjs` measures it, with a `--cpu` option). That probe is too noisy to resolve a 10%
change. Only `npm run eager-census` can.

At that rate a few KB costs well under a millisecond, so a tight ceiling would only make every feature raise a number.
What the eager check is for is catching code that reaches the first frame by accident (a barrel re-export, or the
CodeMirror stack behind one static import in `StEditor.tsx`). So the ceilings are loose, and
[scripts/eager-check.mjs](../scripts/eager-check.mjs), the last step of `npm run build`, fails a build whose eager graph
grew more than the jump limits (25 KB raw, 8 KB brotli) since the last build on the same machine, naming the chunks
that grew. A passing build becomes the new record (`.eager-js/`, gitignored). A fresh checkout has no record, so CI
applies only the ceilings. `npm run eager-census` lists the modules that moved since its last run, and
`npm run eager-check -- --accept` records intended growth.

## Draw budget

`npm run gates` enforces a draw budget ([e2e/verify-draw-budget.mjs](../e2e/verify-draw-budget.mjs)): a ceiling on
the demo scene, plus the invariant that duplicating a part must not duplicate its draws, which guards cross-part
merging (`instancePool`, `staticFold`, the instanced banks). To find what to merge next,
`node e2e/probes/draw-census.mjs` buckets every drawable by owner; `e2e/probes/poolunit-why.mjs` says why something
isn't pooled. Don't budget `renderer.info.drawCalls`: under render bundles it is replay-dependent.

**A number that improves on its own is suspect.** A regression in the merge code can make instruments look
better. A per-instance value that `instancePool` cannot see, such as a material uniform, lets parts that differ merge
onto one bank that draws them all one way. Draws and residency both go down, and unit tests stay green.
`renderIdentityKey` handles that case generically (a material's `userData` is its
per-instance render identity, hashed automatically, with `auditGrouping()` as the backstop). Still, find what got
merged, dropped or skipped before believing an improvement.

**A gate that counts the scene must wait for it to settle.** Part GLBs load async, so a count taken while whole
parts are still absent reads low, and "the count stopped changing" can accept the first plateau of a staircase. Wait
on `window.__oip.assetsBusy()`, never a timed wait or a two-sample hold (curve:
`node e2e/probes/draw-settle-curve.mjs`).

## The e2e harness

About 400 Playwright scripts run directly with node: ~300 `verify-*` gates, a few other runnable scripts, ~70
measurement probes in `e2e/probes/` (each cited by a comment as the instrument behind a number), and underscore-
prefixed shared helpers. A one-off probe is `e2e/_dbg-<name>.mjs` (gitignored); one worth keeping moves to
`e2e/probes/`.

Each script calls `startServer()` from [e2e/_server.mjs](../e2e/_server.mjs):

- **Attach or cold-start.** It resolves `OIP_SHARED_PORT` env, then a live shared server in `.e2e-server.json`, else
  cold-starts a private vite on a free port.
- **Teardown.** `vite.kill()` is a Windows tree-kill (`taskkill /T /F`), and an exit/signal net kills every server
  the process started, even on a crash.
- **WebGPU device guard.** [e2e/_gpuGuard.mjs](../e2e/_gpuGuard.mjs) watches every page for uncaptured device errors.
  Such an error means the frame just judged is not what the scene says (a recorded render bundle drew a freed
  resource), and it does not throw. Errors after the scene settles print `FAIL` and set a non-zero exit; errors during
  load print a `note`, because three's own bind-group load race sometimes raises a couple. If you see the FAIL,
  read [src/render/gpuRetire.ts](../src/render/gpuRetire.ts) and
  [src/render/geometryRecycle.ts](../src/render/geometryRecycle.ts).

### Screenshots

Use `cleanShot(page, path)` from [e2e/_shot.mjs](../e2e/_shot.mjs) for scene shots, never `page.screenshot()` or
`locator('canvas').screenshot()`. Element screenshots capture the composited page clipped to the element, so any
overlay (HUD, docks, the tour modal) is baked in, and distraction-free mode only drops the docks. `cleanShot()`
deselects (no gizmo or outline), hides every DOM node that isn't the canvas or an ancestor with `visibility:hidden`
(no reflow, so framing is untouched), shoots the canvas and restores. Raw screenshots are for verifying UI chrome.

### Batches and the shared server

For a parallel batch, run `npm run e2e:server` once in its own terminal; every `startServer()` then attaches to it.
Don't start one per terminal. Without it, each script cold-starts and cleans up after itself.

`npm run gates` owns one dev server for the batch (a vite per gate costs seconds each cold; `server.watch.ignored` in
vite.config.ts keeps the watcher out of local tool output, so a new big untracked dir belongs on that list). It
publishes through `.e2e-server.json`, adopts an already-running `e2e:server` without tearing it down, and
`OIP_GATE_NO_SHARED=1` goes back to a vite per gate. It uses the sentinel rather than `OIP_SHARED_PORT` because that
env means "explicit, trust it", and `verify-collab-code-trust` reads it to decide whether to isolate. Setting it would
point that gate at the production collab server. A gate that needs a fresh server says so with
`startServer({ isolated: true })`, e.g. `verify-boot-skeleton` (its logo jump only shows before vite has the SVG
warm) and `verify-texture-residency` (`OIP_DEV_PROD_ASSETS` is read by the vite config, so on a shared server it
silently stops enforcing its ceiling).

### GPU

On Windows, headless WebGL uses the real GPU: `--use-angle=d3d11`, applied to every launch by
[e2e/_gpuArgs.mjs](../e2e/_gpuArgs.mjs) through `_gpuGuard`'s patch point. It runs the demo many times faster
than SwiftShader, cuts the batch time, and avoids a set of failures caused by contention. CI and WebGPU stay on
software. Playwright's headless shell exposes a WebGPU adapter but ships no `dxil.dll`, so `requestDevice`
fails and three falls back to its WebGL2 backend under a `WebGPURenderer`, a pairing no user runs where the Dawn
pre-warms compile synchronously. [createRenderer.ts](../src/render/viewport/createRenderer.ts) refuses it and uses
`WebGLRenderer`, so a headless gate's `isWebGPURenderer` is false. A WebGPU leg needs `--headed` or installed Edge
(`channel: 'msedge'`). `OIP_E2E_SOFTWARE_GL=1` restores SwiftShader. A caller that picked a backend itself
(`perf-webgpu-*.mjs`, `verify-browser-authoring-persistence.mjs`) is left alone. With a real GPU, locator actions
don't stall on frames, so the `page.mouse` workarounds in some scripts are redundant.

### The machine lease and contention stamps

A machine has one GPU, so several independent runs stacking pages on it cause HARNESS/HUNG failures.
`startServer()` takes a machine-wide lease ([e2e/_lease.mjs](../e2e/_lease.mjs), in `LOCALAPPDATA`, so it spans
checkouts) and a second run queues. `run-gates` takes one lease for the batch and its children see it through
`OIP_E2E_LEASE`. It is advisory: after 20 min it warns and runs anyway. `OIP_E2E_LEASE_OFF=1` opts out.
`npm run e2e:server` must not lease (`startServer({ lease: false })`), because it holds a server for hours and owns
no browser. This lease is also what makes it safe for the gates runner to tear its server down.

The lease only serialises scripts that use it, so `run-gates` stamps each row with CPU load and node/chromium process
counts ([e2e/_load.mjs](../e2e/_load.mjs)) and prints a **CONTENDED RUN** banner when the box was busy. Verdicts still
hold, but the timings are noise.

### Gates that pass on timing

A busy machine makes a gate fail, not pass, so contention never hides a regression. What does is a gate that waits
on the clock, or on one event landing before another, instead of on the state it checks: it passes while the machine
is fast enough. [e2e/_throttle.mjs](../e2e/_throttle.mjs) slows every Chromium page and Electron window a gate opens
by the given factor:

```
OIP_E2E_CPU_THROTTLE=4 NODE_OPTIONS=--import=file:///<repo>/e2e/_throttle.mjs npm run gates
```

A gate that fails only slowed is a lead. Read why: either the app has a race (a desktop file opened while the
editor was still starting was dropped, and its gate passed at full speed), or the gate's wait is the wrong thing to
wait on. A timeout that is merely too short for a 4x slower page is neither.

### Editing while a gate runs

These scripts drive a dev server, so a save fires HMR, and a `src/render/` edit forces a full page reload. A reload
during a `page.evaluate` gives `Execution context was destroyed`, or a half-booted app (`__oip` undefined, `Failed to
fetch` on assets). Let the tree go quiet before believing a result, or run against `npm run preview:prod`.

### Orphans

If node processes pile up, kill those whose command line matches `vite|e2e/|run dev|npx-cli`. Spare `index.mjs`:
that's the collab server.
