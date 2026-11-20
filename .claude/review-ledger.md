# Review ledger

What the review passes have covered, where the next one starts, and findings looked at and left on purpose. A review
reads this first and adds to it last.

## How a pass runs

1. Changes since the last pass: `/code-review high <last commit below>..HEAD`.
2. The next area in the rotation: `/code-review high <path>`.
3. Skip anything under "Accepted" unless the code around it changed.
4. Add a row to the log, move "Next area", and add anything left on purpose to "Accepted".

## Rotation

Order: `src/sim` (with `src/collab`) → `src/render` → `src/core` → `src/plc` → `src/editor` (not components) →
`src/editor/components` → back to `src/sim`.

**Next area: `src/render`**

## Log

| Date | Scope | Reviewed up to | Findings | Outcome |
|------|-------|----------------|----------|---------|
| 2026-11-02 | Full sweep, all six areas | `b9aa510f` | ~30 verified | Fixed in `4da3d619`..`820921d0`, gates in `e64ccf2f` `b5a8455e`, reveal race `85e76749`, IEC semantics `a7648fc8` |
| 2026-11-06 | `b9aa510f..7f0483a4`, then `src/sim` + `src/collab` | `7f0483a4` | 19 checked against the code (none run): 7 real, 8 partly, 4 not real | Reported, not fixed yet |
| 2026-11-09 | Uncommitted robot work on `05728680` (URDF import, robot controller and tools, ready pose, agent robot tools, Space on a button) | `05728680` + working tree | 10 checked against the code: 9 real, 1 deliberate | 9 fixed in the working tree with tests; 1 accepted below |

## Accepted

Findings looked at and left, with the reason. Remove an entry when its reason stops holding.

- **core/robot/robotController.ts:** a robot with no waypoints ignores a command, where the six-axis part's own script used to fall back to its default poses. Deliberate: with no waypoints there is nowhere to go, and the Inspector's grid cannot make a row of the wrong width.

- **render/viewport/boxes.ts:** empty SimBoxes batches stay visible. The box batch may be kept visible as a pipeline warm; changing it needs a draw-budget and warm-load check first.
- **sim/client.ts:** worker messages carry no run id, so a Stop then Play within a frame can accept one stale frame. Rare, and the fix touches the worker protocol.
- **core/live/liveFrameWire.ts:** a NaN or infinite watch value is re-sent every frame and decodes as removed. Only for non-finite REAL watch values.
- **plc/builtins.ts:** `ADD()` / `MUL()` with mixed REAL and LREAL inputs round each step to the result type, not each input's type. Exact rounding needs argument types passed into the builtin evaluator.
- **plc/arena.ts `strAt`:** builds a STRING one character at a time. Unmeasured; needs a bench-sim A/B before any change.
- **plc/typed/pou.ts:** a SUPER^() base body is generated on first call, not at compile. Not reproduced.
- **plc builtins:** SEL, MUX, shifts, trig and similar go through `callB` with an array per call. Low cost; measure first.
- **editor (41 warnings):** `react-hooks/exhaustive-deps` warnings left as warnings. Fixing them can change behaviour; take them file by file.
- **editor/components/UpdatePrompt.tsx:** its interval and visibility listener are never removed. It mounts once at the root.
- **plc/checkCalls.ts VAR_IN_OUT STRING capacity:** a STRING[n] argument must match the parameter's capacity exactly. Deliberate, documented in docs/st-conformance.md and tested.
- **apps/desktop/main.cjs setAgentDoor:** checks `agentDoor` before its dialog. `openAgentDoor` checks again after it, so two windows only collide if both Allow clicks land within one `listen()`.
- **sim/worker.ts step-loop catches:** they post 'error' without the full teardown. The client's onError calls stop, which tears down and resolves pending steps. A shared teardown helper would only tidy this.
- **sim/scenePatch.ts:** `applyScenePatch` drops non-part fields when there are no packages. Nothing in the worker reads them, and a patch never carries them fresh anyway.
- **sim/world.ts destroyPart → releaseRig:** a mid-run rebuild of a rig drops its load. Before, the load froze in the air and could not be gripped again. Carrying grips across a rebuild is a feature, not a fix.
- **render/viewport/createRenderer.ts:102:** refuses a software WebGPU adapter, so CI can't run a WebGPU leg on SwiftShader. Correct for users; a CI leg would need an opt-in (e.g. `?webgpu` accepting it).
