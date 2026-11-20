# Project tests: regression tests for factory logic

> Related: [projects.md](./projects.md) (the project folder these tests live in),
> [src/plc/DEVICE-IO.md](../src/plc/DEVICE-IO.md) (the tag table assertions read).

## Why

A project can be a git repo (folder layout + `npm run validate-project`), but validation only
proves a project *loads*, not that its control logic still *works*. Project tests add what this
stack can offer cheaply: **run the scene headless for N simulated seconds and assert on
PLC/behavior tags**. That is a regression suite for factory logic, runnable in CI on every PR to a
factory repo.

The runner is built from pieces the unit suite already covers:

- `SimWorld(Jolt, scene)` runs full physics + part behaviors headless in Node
  ([conveyorComms.test.ts](../src/sim/conveyorComms.test.ts) is the exact pattern: build
  world, `step()`, drive `setBehaviorInputTags`, read `frame().tags`).
- The ST engine runs headless (`src/plc/`), and the tag bridge connects the two
  ([tagBridge.test.ts](../src/sim/tagBridge.test.ts)).
- Determinism is a design invariant (fixed timestep, seeded rng, the `partScript` shims), so
  a passing run passes everywhere. Across machines this is checked only coarsely: CI on Linux
  reproduces the part-corpus digests recorded on Windows, rounded to the millimetre
  ([part-sources.md](part-sources.md#gates)). Bit-exact float determinism of the WASM Jolt build
  across machines is not verified.

The harness is *glue* over these, not new machinery.

## The spec format

Tests are **declarative JSON**, not scripts: agent-writable, schema-checkable, and safe to
run from an untrusted repo (no code execution beyond what loading the project already runs).
They live in the project folder:

```
my-factory/
  project.json
  scene.json
  plc/
    program.st
  tests/
    sortation.test.json
```

A project can also **carry** its tests rather than only sit next to them. `project.json` may list
them under `tests`, and a single-document `.oip` holds the specs inline (`ProjectJSON.tests`). So a
project states what "working" means wherever it travels (a share link, a folder an agent edits), not
only on the disk a CLI is pointed at. Both forms work. A manifest that lists its tests is the source
of truth, and a folder whose manifest lists none falls back to globbing `tests/`, so a project
without the field still runs its tests.

Carried tests are validated with the document. A project holds one scene (format 4), so a test runs that scene:
a spec from an older multi-scene project may still carry `scene`, which only routes it to the right project when
that document splits on load (docs/projects.md "Splitting an older project"), and is not kept.

```jsonc
{
  "name": "start latches",    // optional display name (the CLI defaults to the file name)
  "duration": 30,             // simulated seconds, fixed-step; wall-clock ≈ much less
  "scanMs": 10,               // optional PLC scan period; defaults to the project's scan time, as Play scans. Only
                              // a program with no controller table / CONFIGURATION uses it: a table's task interval wins
  "inputs": [                 // optional stimulus timeline (PLC/behavior input tags)
    { "at": 0,  "tag": "StartPB", "value": true },
    { "at": 0.5, "tag": "StartPB", "value": false }
  ],
  "checks": [
    { "at": 5,        "tag": "Conv1_Running", "equals": true },      // sampled at t=5
    { "always": true, "tag": "JamAlarm",      "equals": false },      // invariant, whole run
    { "eventually": true, "within": 25, "tag": "SortedCount", "min": 10 }, // liveness
    { "at": 30, "tag": "MotorSpeed", "near": 1.2, "tolerance": 0.05 }, // analog
    // and the world itself, not just what the program believes about it:
    { "eventually": true, "within": 25,
      "probe": { "count": { "zone": { "min": [2,0,-1], "max": [6,2,1] } } }, "min": 10 }
  ]
}
```

Every check has exactly one **source**, one **temporal** mode, and one **predicate**.

| source | reads |
|---|---|
| `tag: "Name"` | a PLC or behavior tag - what the control program says |
| `probe: {...}` | a number out of the simulation step - what physically happened |

| temporal | meaning |
|---|---|
| `at: t` | sample at simulated time `t`, apply the predicate once |
| `always: true` | predicate must hold at every step of its window (default: the whole run) |
| `eventually: true` | predicate must hold at some step of its window (default: the whole run) |
| `from: t1`, `until: t2` | the window of `always` / `eventually`, both ends inclusive; either may be left out. `within: t` is another spelling of `until` for `eventually` |

Predicates: `equals` / `notEquals` (BOOL/INT exact), `min` / `max` (numeric bounds), `near` + `tolerance`
(REAL), or `min` and `max` together for a range, both numbers (`"min": 9, "max": 11` holds from 9 to 11). The right-hand side is a literal, or **another tag or a probe**, read at the same step:
`"equals": {"tag": "Lane1Out"}`, `"min": {"probe": {...}}`. Tag names are the scene-level names, the same
namespace the scene's ST program sees.

An `eventually` over a window that starts with the run, and already holds on its first sample, passes with a
warning: nothing had to happen for it to pass. A fresh output reads false and a sensor starts clear, so
`"eventually": true, "tag": "Ready", "equals": false` is true before the line has done anything. Check the
transition with `at` after it has had time, or check the opposite first.

## Checks that survive a layout change

An exact count at an exact time (`{"at": 19.9, "tag": "Lane1Out", "equals": 8}`) is brittle: an unrelated change
that moves arrivals by a tenth of a second flips it. Four forms say what is actually meant:

```jsonc
// a state held over a stretch of the run, not at one instant: the line stays stopped while Stop is held
{ "always": true, "from": 12, "until": 19, "tag": "Running", "equals": false }

// one tag against another, at every step: the takeaway never counts more than the program sorted...
{ "always": true, "tag": "Lane1Out", "max": {"tag": "Sorted1"} }
// ...and catches up once the line has run a while
{ "eventually": true, "from": 15, "tag": "Lane1Out", "equals": {"tag": "Sorted1"} }

// what physically went where, by colour, counted cumulatively: no red box ever went down lane 2
{ "always": true, "max": 0,
  "probe": { "passed": { "zone": {"min": [5.5, 0.8, -1.2], "max": [6.5, 1.5, -1.0]}, "color": "red" } } }

// anything but zero
{ "eventually": true, "from": 1, "tag": "Color", "notEquals": 0 }
```

A colour sort tested this way needs no test-only colour sensors in the scene and no golden counts. Every count is
either "none of the wrong colour, ever" or "at least a few of the right one", plus the program's counters held
against the sinks'. A wrong divert fails a check that names the colour and the place.

## World probes

A tag check can only ever ask the control program about itself, and a program can be perfectly
correct about a line that doesn't work: the belt speed is wrong, the box tips, the diverter fires
late, the pallet sails past the rack. **A probe reads a number out of the simulation step instead**,
so a check can assert the physical outcome. It is a *source*, not a new kind of check. It
takes the place of `tag`, and the temporal modes and predicates above apply to it unchanged.

| probe | yields |
|---|---|
| `{ "count": { "zone": {"min":[x,y,z], "max":[x,y,z]}, "part": "id", "kind": "box"\|"pallet"\|"tote", "color": "red", "marked": "sealed" } }` | how many live cargo bodies match now - every filter optional and ANDed, `{}` counts all cargo |
| `{ "passed": { "zone": {...}, "part", "kind", "color" } }` | how many cargo bodies have entered `zone` since the run began: cumulative, each body once, despawned ones included. "Boxes that passed this point", whenever they arrived. The zone is required, the filters are `count`'s |
| `{ "square": { "zone": {...}, "heading": 30, "part", "kind", "color" } }` | how far the cargo in `zone` is turned off square to `heading`: the worst matching body inside it this step, in degrees from 0 to 45, to a tenth of a degree. Folded by 90, so any edge parallel to the heading is square. `heading` is degrees about +Y, as a part's `rotationY` (a spur's, in degrees). Absent while no matching body is inside. The zone and heading are required, the filters are `count`'s |
| `{ "pose": { "part": "id", "axis": "x"\|"y"\|"z"\|"yaw" } }` | where that part is - a mobile part's driven base (`ctx.drive`), else an authored cargo body |
| `{ "joint": { "part": "id", "joint": "name" } }` | a rig part's joint value (rad / m): the last one it commanded, latched; absent until it commands that joint |
| `{ "lamp": { "part": "id", "lamp": "name" } }` | whether a part's lamp is lit (`true` / `false`): the last value its behavior commanded, latched; absent until it commands that lamp. It reads the command, so a lamp lit at rest only by its `param` is absent |

`count` and `passed` also take `"marked"`: only the cargo carrying a mark, as a machine left it (`ctx.mark`,
`markHit`) or as a product attribute. A key alone counts the cargo whose mark is truthy (`"marked": "sealed"`), and
one key and a value counts the cargo with that value (`"marked": { "code": 2 }`). A `passed` probe judges it as the
cargo enters the zone, so a gate at the end of a line counts what reached it labelled.

Every probe's `part` is a placed part's id in the scene (`box1`), never a part type (`oip.box`, which is what a
part's own `ctx.zone(name, { part })` filter takes). A `count` or `passed` probe whose `part` is not a placed part is
refused before the run, since it would count nothing without saying so; to count every case of a type, leave `part`
out or filter by `kind`.

```jsonc
// throughput: 10 boxes reached the discharge zone within 25 s
{ "eventually": true, "within": 25, "min": 10,
  "probe": { "count": { "zone": { "min": [2,0,-1], "max": [6,2,1] } } } }

// the AGV stopped within 20 cm of the dock
{ "at": 30, "near": 12.5, "tolerance": 0.2, "probe": { "pose": { "part": "agv-1", "axis": "x" } } }

// the beacon's red lamp is lit once the fault tag is set
{ "at": 2, "equals": true, "probe": { "lamp": { "part": "beacon-1", "lamp": "red" } } }

// accumulation never backed the infeed up past 4
{ "always": true, "max": 4, "probe": { "count": { "zone": { "min": [-4,0,-1], "max": [0,2,1] } } } }

// at least 3 blue boxes went down lane 2 (a thin gate across the lane)
{ "eventually": true, "min": 3, "probe": { "passed": { "zone": { "min": [5.5,0.8,-1.2], "max": [6.5,1.5,-1.0] }, "color": "blue" } } }

// every case rides the 30-degree spur within 10 degrees of square
{ "always": true, "max": 10, "probe": { "square": { "zone": { "min": [4.4,0.7,-1.3], "max": [5.0,1.3,-0.9] }, "heading": 30 } } }
```

**`square` is for a place cargo rides through settled**, such as the middle of a spur, not the transfer onto it, where a
case turns on purpose. Its zone has the same witness rule as `passed`: absent until a matching body is inside, so a
zone beside the lane fails as never appeared instead of passing every `max`.

**Colour** is `red`, `green`, `blue` or `yellow` (a saturated tint whose channel dominates, or red and green together
over a low blue for yellow; white, grey, cyan, magenta and anything too dark are none of them), or an exact `#rrggbb`
as the scene authors it (a spawner's `boxColors`, a box's `color`). It replaces the extra colour sensors a test
otherwise adds to the scene just to see what went where.

**`passed` sees a body go through, not stand in.** Entry is tested on the segment its centre swept since the last
step, so a gate thinner than one step's travel (a box thrown off a diverter covers 5 cm a step) still counts it. A
thin slab across a lane is the idiom: a gate, not a pocket where boxes stand.

Things worth knowing:

- **Zone bounds are inclusive, and a reversed one is rejected** at validation. A `min > max` axis
  would match nothing and make every check over it pass or fail vacuously. That is the same silent
  success the "tag never appeared" guard exists to prevent.
- **`count` always answers (unless it filters on a colour); `pose` can be absent.** 0 is a legitimate count,
  so a `count` check never trips the never-appeared guard. A `pose` naming a part that isn't in the running
  scene *is* absent, and fails as `probe pose(agv-9.x) never appeared (no such part in the running scene)`.
  So a mistyped id can't read as a coordinate of 0 that quietly satisfies a `max` bound.
- **A colour, a `passed` gate and a right-hand side can be absent too, for the same reason.** A colour-filtered probe
  answers only once cargo of that colour has existed in the run, and a `passed` only once any cargo has entered its
  zone. A colour no box has (`#e01011` for `#e01010`) or a gate beside the lane would count 0 forever and pass every
  `max: 0` over it. Such a check fails as `probe passed(red, zone ...) never appeared (no cargo at all entered its
  zone in the whole run - is the zone on the cargo's path? ...)`. So to say "nothing ever gets here" (the floor), use
  `count` + `always`, which needs no witness. `passed` is for a place things do go. A right-hand tag that never
  appeared fails the check (`tag "Lane1Outt" (the right-hand side) never appeared (the run did publish: ...)`), and an
  `always` whose window never once had both sides present fails as having held over nothing.
- **A window must lie inside the run.** `from` at or past `duration`, `until` past it, or a window that ends before it
  starts is refused when the spec is read; `from` / `until` on an `at` check is refused too.
- **`always` is vacuous over a body that disappears.** Absence never violates an invariant (same
  semantics as a tag), so "the pallet must always stay above y=0.5" keeps passing after a despawner
  removes it. Assert existence separately: `{ "probe": {"count": {"part": "pallet-1"}}, "always": true,
  "equals": 1 }`.

Probes are pure over one step's `BoxFrame` ([core/project/projectProbe.ts](../src/core/project/projectProbe.ts)), so
they unit-test against a hand-built frame with no Jolt and no scene. The one piece of state is a
latch: `BoxFrame.basePoses` only carries a mobile part that *drove* that step, so an AGV that
arrives and stops would fall out of the frame exactly when an `at`-mode arrival check reads it.

**Worked example: the demo cell itself.**
[demoAcceptance.ts](../src/editor/demo/demoAcceptance.ts) runs the palletizing demo headless for
90 simulated seconds (one `demoScenesSim.<rate>hz.test.ts` per step rate) and asserts a ladder of stages (feed → transport → row → layer →
putaway), plus the invariant that nothing ever falls through the floor. A failure names the rung, so a
regression says how far down the line it is. Nothing is hand-authored: the scene is built by code,
part ids are resolved by package, and the zones come from the demo's own exported constants, so a
layout re-tune moves the test with it. A second case (demoScenesSim.test.ts) holds the safety gate open and asserts the
run goes red on the row rung *while the floor invariant still passes*. That proves the ladder
reads the world rather than passing vacuously.

Two rules from that example, both worth copying:

- **Scan at the rate the cell really scans.** The demo's controller table runs MainTask every 10 ms,
  and a stored table's interval overrides `scanMs` (which only applies to a program with no controller
  table or `CONFIGURATION`). Scanning every 16.7 ms sim step instead breaks its edge-triggered
  handshakes, so the AGVs never move. That looks like a physics regression and is not one.
- **Pick a stimulus that actually gates the thing you are testing.** The demo program latches
  `running` on its first scan whenever `Stop` is closed, so withholding the `Start` press changes
  nothing. A negative case built on it would pass and prove nothing. `Guard` is the real interlock.

**Static parts are not probeable.** A conveyor doesn't move, so its pose is just scene JSON, which
you can already assert by reading the file. Probes are for what the *simulation* decides.

## Faults

A line is commissioned as much on what it does when something breaks as on what it does when
everything works. Nobody can rehearse that half on site without breaking real equipment.
`faults` sits beside `inputs` and fails a device partway through a run:

```jsonc
"faults": [
  // the motor stops receiving Run from 1 s, and gets it again from 2.5 s
  { "at": 1, "until": 2.5, "part": "m1", "kind": "actuatorDead" },
  // the photo eye reads clear to the program from 4 s to the end, whatever it sees
  { "at": 4, "part": "pe1", "kind": "sensorStuck", "value": false },
  // the I/O network drops from 6 s to 7 s; the program's IoFault input reads true meanwhile
  { "at": 6, "until": 7, "kind": "commsLoss", "statusTag": "IoFault" },
  // the first box to reach the eye from 8 s stops dead there until 12 s
  { "at": 8, "until": 12, "kind": "jam", "zone": { "min": [2.4, 0.8, -0.7], "max": [2.8, 1.4, 0.7] } }
]
```

A fault is in effect from `at` (inclusive) to `until` (exclusive) or the end of the run, the same window
an input uses. The checks are the ordinary ones: a fault is a stimulus, not a new kind of assertion.

| kind | the real failure | where it acts | what the program sees |
|---|---|---|---|
| `actuatorDead` | a tripped motor, a failed valve | PLC → part: the device's `dir: 'in'` tag params read false (BOOL) / 0 (numbers) | nothing - its outputs are what it wrote; only the missing feedback can tell it |
| `sensorStuck` + `value` | a failed photo eye, a broken wire | part → PLC: the device's BOOL `dir: 'out'` tag params read `value` | the stuck value |
| `jam` + `zone` | a box caught at a merge, a transfer, a guide | the world: the first loose body whose centre is in `zone` stops dead where it stands; at `until` it is let go and moves on | nothing directly - only what its sensors see, as on a real line |
| `commsLoss` | a remote I/O node or the network dropping | both ways, for one device (`part`) or every device (no `part`): what the PLC reads per `inputs`, what the devices receive per `outputs` | its inputs per `inputs`, and the `statusTag` bit if one is named |

**A jam is physical.** It touches no tag: the runner pins the body (`SimWorld.pinBody`, the same `pin` holder
the Use key puts on a box) and lets the conveyor and everything behind it do the rest, so boxes back up and
sensors block for real. It catches one body, the first loose one in its zone (in frame order) from `at` on.
Cargo something already holds (a gripper, the pilot, a pin) is not loose and is passed over. A unit load is
caught whole. Clearing the jam is the operator's half: at `until` the body is released where it stands,
on whatever it stands on, so a stopped belt keeps it in front of the eye until the line runs again. A jam
whose zone no cargo reached while it was in effect refuses the run (`... so it jammed nothing`). Only the
run can tell, so this is the one fault checked at the end rather than up front. Size the zone to the box
centre's path. A box is caught the step its centre enters, so a zone that starts at a sensor's beam catches the
box with its front face only just reaching it.

**Comms loss models a configuration, so it says which.** Real platforms differ on what a lost signal reads.
`outputs` is what the devices receive: `off` (the default, and the fault state remote outputs are usually
configured to) or `hold` (the last command, which keeps a motor running through a Stop nobody can hear).
`inputs` is what the program reads: `off` (the default; one controller family zeroes a lost node's inputs) or
`hold` (the last values; another family keeps them). `statusTag` names a program input that reads true while
the link is down and false otherwise. It is the connection-fault bit a real controller gives the program, and the
only way it can tell a lost device from a quiet one when inputs hold. A status tag the program does not read
is refused like any other fault that would touch nothing. A network loss with no `part` acts on every device
whose tags it can find; a scene with none is refused.

**A fault names the device, not its tags.** The runner (`resolveFaults` in editor/project/projectTestRunner.ts)
finds the tags through what the package declares: its `'tag'` params with a `dir`, read the way the sim
reads them (the param's default when the scene leaves it unset). Renaming a tag in the Inspector does not break the test. The flip side:
a part that speaks tags through anything else (a plain string param, a fixed name) cannot be faulted, and
the run refuses the fault rather than letting it touch nothing. A fault that silently did nothing would make
every check after it pass for the wrong reason. The same holds for an unknown part id, a tag param left blank, or a part whose declared comms switch is off.

**Faults apply last on their side of the PLC.** A fault is the wire itself failing, so it outranks both what
the device does and what a test `input` writes to the same tag.

**What a check reads during a fault.** A faulted input (stuck, or lost to comms) reads what the PLC reads. What
the device really sensed is a probe's to say (`count` in its zone). A dead actuator's command tag reads what
the program commanded, from the program's own watch: the PLC believes it is driving the motor, which is
exactly what a feedback check has to catch.

**The trace shows the fault.** Every failed check's lead-up (and `--trace`) carries one row per fault,
`actuatorDead(m1)  FALSE -> 1.017s TRUE` (a network loss is `commsLoss(all)`; a jam's row turns true when a box
actually sticks, not when the jam arms), so the cause is printed beside its effects. Trace only: no check
can name it.

**Pair every fault with a recovery check.** Fault handling that latches forever passes every "it stops"
check. Assert what happens after `until` too: the line restarts, or it deliberately stays down until a reset.

Worked example: [`examples/projects/start-stop-motor/`](../examples/projects/start-stop-motor/). Its
`plc/program.st` monitors the motor's Running feedback and latches `MotorFault` when Run gets no answer for
500 ms, or at once when the `IoFault` connection bit is set; Reset is evaluated before the fault conditions,
so it cannot clear a fault that is still present. `tests/motor-fault.test.json` kills the motor (and checks
it does not restart by itself when the fault clears, only after Reset); `tests/feedback-lost.test.json`
breaks the feedback wire while the motor really runs; `tests/comms-loss.test.json` drops the network and
presses Reset mid-loss. Remove the monitor and the first two fail. Ignore `IoFault`, or evaluate Reset after the
fault conditions, and the third fails.

Jam worked example: [`examples/projects/jam-detect/`](../examples/projects/jam-detect/) has a belt, an infeed
and a photo eye. `plc/program.st` latches `JamAlarm` when the eye stays blocked for 2 s while the belt runs, and stops
the belt and the infeed. `tests/flow.test.json` proves ordinary traffic (each box blocks the eye for well under 2 s)
never trips it. `tests/jam.test.json` jams a box at the eye, restarts too soon (it re-trips), clears the jam and
restarts for good. Remove the detection, drop the "while the belt runs" gate (the alarm can then never be
reset with a box standing at the eye), or delete the fault from the test, and it fails.

## The runner

```
npm run test-project -- <project-folder> [--only <file-or-name>] [--trace <tag,tag,...|all>] [--cargo <t,t,...>] [--context <seconds>] [--json]
```

| exit | meaning |
|---|---|
| 0 | every check of every test passed (or the folder has no tests) |
| 1 | a check failed: a verdict on the program |
| 2 | usage / IO: bad arguments, no such folder, `--only` matching no test (it lists the tests there) |
| 3 | the project failed to load (a missing program file, a broken part) or a test could not run (an invalid spec, a fault the scene cannot apply, a jam that caught nothing): not a verdict on the program. It outranks 1, so a mutation script that reads 1 as "caught" is never fooled by a broken copy |

`--only` picks by name, exact first: the test's file name with or without `.test.json` (`--only sort` or
`--only sort.test.json`), or its exact `name`. Only when nothing matches exactly does it fall back to a substring of
either, and when that picks several it lists them before running them all, so `--only lane2-full` runs that test and
not `lane2-full-logic` too. A report leads with the file name. A manifest that lists its tests is what the app runs, and a `tests/*.test.json` it does not list is run
too, with a note that the app will not run it until it is listed.

**`--cargo 5,10.5` lists every live cargo body at those times**: id, part (or `-` for a spawned box), kind, tint
(`#e01010 (red)`), centre in world metres, tilt from upright and heading about +Y (`yawDeg`), in whole degrees. The heading is the plan
direction of the body's more nearly level edge: a part's `rotationY` for an upright body, and the way its edges run
for one tilted on a cross slope, such as a chute falling away from a sorter. A spawned box has no part id, so a `pose` probe's `yaw` cannot follow it, and its heading here is how
to see a case turn through a divert. It is the headless answer to "where
are the boxes", which is what you need to place a `count` zone or a `passed` gate, and close-together times follow a
box that tips or falls. `--json` carries it as `cargo` per test, and the agent's `run_test` takes the same times as
`cargo` (core/project/projectProbe.ts `CargoSnapshots` serves both).

**Why a check failed is printed with it.** A failed check says what was wrong; the cause is in the other tags
just before (a stop went on, an eye saw a box). The run is deterministic, so a failed test is run a second time
with a `TraceRecorder` (core/project/projectTest.ts) recording every tag that changes in the `--context` seconds (default
3; 0 turns it off) before each check's `failedAt`, and those are listed under the check: each tag's value coming
in, then each change with its time. Changes, not samples, because an encoder changes every step and a button once;
a tag that changes too often to read is cut to its first and last changes. `--trace` follows chosen tags (or
`all`) through the whole run instead, and names any it never saw published. `--json` prints the verdicts, the
lead-up of each failed check and the trace as one object, for an agent to read rather than scrape. This is how an
agent that cannot look at a running scene sees what the program did.

`test-project` runs the project's tests: the specs `project.json` lists under `tests`, plus every `tests/*.test.json`
it does not list (all of them, when it lists none). Per test: load the project (same codec + part baking
as `validate-project`), then `runProjectTest(Jolt, project, spec)` builds a `SimWorld`, compiles the
scene's ST program (`LocalPlcLink`), and steps both forward at that scene's fixed step rate
(`simHz`: 60 Hz unless the scene names another, up to 1000; the same rate the editor's Play uses), evaluating
the checks. Exit codes as in the table above. Same vite-`ssrLoadModule` shape as `validate-project.mjs`.

**The PLC↔sim seam is the part tag bus**, and nothing else. There is no declarative binding table (see
[DEVICE-IO.md](../src/plc/DEVICE-IO.md) and the header of `plc/bindings.ts`).
`SimWorld` itself casts sensor beams (`world.ts` tickBehaviors) and lets each part write its
detections/state as tags, so it runs headless, and the runner wires:

- **part → PLC:** `world.frame().tags` (every part's writes) flattened into the ST program's inputs;
- **PLC → part:** the ST outputs (plus scheduled test `inputs`) pushed via `setBehaviorInputTags`;
- **checks** sample the union of part tags + the PLC's own variables (`link.watch`) + the test
  stimulus, so a check can assert on a sensor detection, a conveyor's running flag, or an ST coil
  by name.

**What a test input reaches.** An input is written into the tag table both sides read: the program sees it as an
input, and the parts get it with the program's outputs (on a clash the input wins). But a part's command tag does not
follow just any value on the bus. The first-party parts read a tag that takes the device out of hand mode (a
conveyor's or a box spawner's `runTag`; a diverter's, blade stop's or chain transfer's command; the params marked
`autoWhenDriven`) only while the part's comms are on and the tag is driven, meaning it is an output of the attached
program (`ctx.tagDriven`). The runner marks driven exactly the program's outputs (`setBehaviorDrivenTags(plc.outputs)`
in projectTestRunner.ts), as Play does. A test input is not a driver. So the part ignores an input on a command tag
that no program output drives, and stays in hand mode: a belt keeps running at its authored speed, a diverter
keeps its `diverted` param. To command a device from a test, drive a program input that the program turns into that
output. Tags that are not commands are read whenever the param names one and comms are on, driven or not: an analog
setpoint (`setpointFor`, a conveyor's `speedTag`) or a despawner's `blockTag`, which is why a test can block a
despawner directly. A blank tag param un-wires the part: it reads and writes nothing, the wiring check leaves it out,
and a blank command tag is never driven, so that part runs on its own params whatever the program does.

**`check-wiring` and the Problems dock count the tests as wiring.** The CLI finds a project's specs the way this runner does (listed, and
unlisted `tests/*.test.json`), and a tag a check reads (as its `tag` or a right-hand `{ "tag": ... }` operand)
counts as read, while a tag an input drives (or a `commsLoss` fault's `statusTag`) counts as written. So a feedback
tag only a test reads, or a despawner's block tag only a test drives, is not an "unread" / "undriven" warning, and
the report says who covers it (`Lane1Blocked: nothing in the scene writes it; written by tests/lane-full.test.json`).
The dock applies the same rule (`coverByTests`, core/project/projectTestTags.ts) to the tests the project keeps, and
drops the covered row.

This is the same path every part uses (the whole catalog is authored on the SDK,
[architecture.md](architecture.md)), so the runner needs no special path for tests. Layering: the pure evaluator
is `core/project/projectTest.ts` (temporal/predicate logic, unit-tested); the runner is `editor/project/projectTestRunner.ts`
(the only layer that may import both `sim` and `plc`, same as `controller.ts`).

Worked example: [`examples/projects/start-stop-motor/`](../examples/projects/start-stop-motor/) is a
start/stop seal-in circuit with `tests/start-stop.test.json` asserting the momentary Start latches
the motor, the seal-in holds after the button releases, and Stop drops it. `npm run test-project --
examples/projects/start-stop-motor` passes; break the latch in `plc/program.st` and the "still running after
release" check fails with the observed value.

## Flow facts

Most of the time lost building a line goes on physical problems no check names: a box falls off a belt, a pusher tips
a box that is coasting to a stop, a tumbling box flickers an eye into a second edge (and a tracking queue slips one
box), a box sits still while the belt under it runs. The sim reports these as **flow facts**: what happened, when,
where and to which part. Facts, never verdicts. An accumulating line holds boxes still on purpose, and that is
listed too, for the reader to weigh; a fact never fails a test and never changes an exit code.

| kind | when | names |
|---|---|---|
| `dropped` | a box (not a pallet) that was clear of the floor for 0.2 s reaches it (bottom below 0.03 m) and is still there 0.25 s later. Not a box that starts on the floor, one a holder sets down, or one a sink on the floor takes as it lands | the conveyor it was last over (else the part that spawned it), and the height it fell from |
| `lost` | a body is culled below the world (it fell off the edge of the ground) | the same |
| `tipped` | a body's up axis passes 40 degrees from vertical; again only after it has righted itself (under 20) | the conveyor under it, the angle |
| `flicker` | a sensor beam's raw hit (before any normally-closed inversion) reads clear for under 100 ms between two blocked periods by the same body. A short gap between two different boxes is not one; repeats within 1 s are one record with a `count` | the sensor part and beam link, the gap, and the part's BOOL tags that toggled during it (what the program saw) |
| `stalled` | a box sits still (within 1 cm) for 1 s on a conveyor whose live commanded speed is not zero. One fact per conveyor per stall: boxes backing up one after another are one record (`boxes` = the most at once) until the conveyor has held none for 2 s; reported when it starts and again, same `id`, with its `duration` when it ends (`ongoing` when the run ended first) | the conveyor, its speed |

Each record is `{ id, kind, t, at: [x, y, z], cargo?, cargoPart?, part?, ...detail, message }` (`FlowFact` in
`src/core/flow/flowFacts.ts`, where every threshold is a named constant with its reason). The tracker is pure and
deterministic: the same run gives the same facts. It runs after every physics step inside `SimWorld`
(`src/sim/flowFacts.ts`), reading only what the step already computed (the batched pose snapshot, the beam hits the
behaviors were handed, the live conveyor speeds), so it moves nothing: a run's bench-sim fingerprint is the same with
it or without it (`new SimWorld(..., { flowFacts: false })` is the A/B lever). Memory is bounded: state per live
body and per beam, and at most 2000 facts, with a count of any past that.

Where they show up:

- **`test-project`** prints one line per test, `flow facts: 1 tipped, 1 flicker, 2 stalled` (or `none`), whether it
  passed or failed. A test that passes while tipping a box may still hide a physical problem. For a failing test, the facts
  up to its earliest failing check are listed right after that check's lead-up, under `physical facts before the
  failure`. `--json` carries `facts` per test.
- **`npm run check-flow -- <project-folder> [--seconds 30] [--input <tag>=<value>[@<t>]]... [--json]`** runs the
  scene and its own program with no test (an `--input` sets a program input the way a test's `inputs` do, e.g.
  `--input Start=true@0.5 --input Start=false@1`) and lists the facts grouped by kind. Exit 0 whatever the facts, 2
  usage, 3 the project does not load or cannot run.
- **The running app**: the sim worker ships the facts its steps collected on each posted frame (`flowFacts` on the
  `frame` message, `src/sim/protocol.ts`), and `SimClient.flowFacts` (`src/core/flow/flowFactLog.ts`) keeps the latest
  record per id for the run: kept after Stop, cleared by the next Run, and it notifies only when a frame carried a
  fact. The agent tool `get_problems` returns the newest 50 as `flowFacts`, apart from its problems and counts. The
  Problems dock does not list them: it lists what to fix.
- **The in-app Tests overlay** shows the same per-test summary line as `test-project`, and for a failing test the
  facts up to its earliest failing check (`src/editor/project/testFacts.ts`).

The demo cell gives a stall per row at the row former's blade stop, which is the accumulation it is built for, and
a flicker per row as a case settles against the stop. A box line that runs off the end of its belt gives a `dropped`
per box. Collecting facts costs a small fraction of a step even with a thousand cargo bodies in the scene.
`e2e/verify-flow-facts.mjs` gates the app side.

## Physical gotchas

A test runs real physics, so a program that is right on paper can still meet what a real line does:

- **A push on a coasting box can tip it.** A pusher or diverter that fires while the box is still coasting to a
  stop (the line stopped by a lane-full or a Stop mid-push) hits a box that is decelerating rather than riding at
  belt speed, and it can rotate or fall over instead of sliding off cleanly.
- **A tumbling box can flicker an eye.** A box that rocks or tips under a beam can clear and re-block it in a few
  milliseconds, which a program reads as a second rising edge: a second box counted, a second divert queued. A
  program that counts edges should debounce its eyes, for example count a new edge only after the beam has been
  clear for about 150 ms (a TON on the clear state), as a real one would. Both of these show up as flow facts (above): a `tipped` and a
  `flicker` naming the eye and the tag that toggled, listed before the failure they lead to.
- **Test it.** Write a test that stops the line mid-push (drive `Stop`, or block the lane's full eye, timed to happen
  while a box is under the diverter) and checks the counts and the alarm afterwards: `always` the sorted counts
  never exceed the spawned count, and, once restarted, each box still reaches its lane (a `passed` probe per lane).

## Getting started (scaffolding)

```
npm run scaffold-project -- <project-folder>
```

writes a starter `tests/example.test.json`, pre-filled with the project's real tag names
(pulled from its ST program's `VAR_INPUT`/`VAR_OUTPUT`) so you edit values, not structure, plus a
`tests/README.md` reference. It's **idempotent**: an existing file is never overwritten. On a latch/
seal-in style program the generated test passes as-is (press the first input, expect the first output
coil), giving a green baseline to build from.

**Scaffolding generates files on purpose, and stays out of the export path.** `Save Project to Folder`
(core/project/projectFolder.ts) is a faithful, byte-reproducible *mirror* of project data. Injecting template
files there would break the round-trip and the reproducible archive. So the starter lives in this
separate command: **export mirrors, scaffold generates.** It writes no CI workflow, because the OIP CLI
is not installable in a standalone repo.

## In the app

The editor runs a project's tests in place: run all, red/green per check (`sim.runTests`,
`TestResultsOverlay.tsx`).

## Not building

- **Scripted tests** (JS test files): JSON keeps tests declarative, diffable, and inert. If a
  case can't be expressed, grow the check table instead.
- **A full temporal logic** (until/release operators, nested quantifiers): three primitives
  cover start-up, invariant and liveness, the usual acceptance-test cases. A window (`from` / `until`) and a
  right-hand tag or probe are as far as it goes: no check refers to another check, and no window is bounded by an
  event ("until Start is pressed"); write the time the test's own input is scheduled at.
- **UI-driven tests** (click-through recording): out of scope; this tests control logic, not
  the editor.
