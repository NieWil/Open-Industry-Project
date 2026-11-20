# Simulation clock: keeping physics and control logic co-timed

The running editor sim steps in a Web Worker while the page renders on the main thread. This doc states the timing
guarantee the sim gives and how the code delivers it.

**There is one clock.** The PLC scan runs inside the sim worker, interleaved with the physics steps
([src/sim/plcHost.ts](../src/sim/plcHost.ts)). Before each fixed `1/hz` step (the project's step rate, see
*Step rate* below), the loop latches the program's inputs from the previous step's behavior tag writes, drains however
many whole scan periods one step of sim time covers, and applies the outputs to the step about to run. The scan
accumulator is fed the fixed step dt, never wall clock. So the scan and step interleave is a function of the step
count alone. It is the same at any render frame rate, under main-thread jank, tab throttling or a changed timeScale,
and it has the same shape as the headless project-test runner ([project-tests.md](./project-tests.md)).

A scan driven from the render loop would drift from the physics. The browser freezes `requestAnimationFrame` in a
hidden tab but keeps a worker timer running, so two separate clocks would advance by different amounts, and on
refocus the skew would lurch the world forward at once.

## Two kinds of determinism

1. **Reproducible validation**: "does my PLC logic work". This must repeat bit for bit. `npm run test-project` steps
   `SimWorld` and the ST engine together headlessly through the tag bus (see [project-tests.md](./project-tests.md)),
   with no rAF, no worker and no wall clock. The custom-part rules in
   [src/core/determinism.ts](../src/core/determinism.ts) protect this.
2. **Live co-timing**: the running editor sim must not drift or lurch relative to itself. It cannot be bit-exact
   across machines and frame rates (variable dt, GC pauses, display Hz), and it does not need to be. The rule is:

   > **Control logic advances by exactly as much sim time as physics stepped, and under load the sim slows down by
   > shedding backlog, never by lurching or desyncing.**

## Physics owns the clock

Physics is the single source of sim time. PlcHost's `ScanEngine` accumulator is fed exactly `1/hz` before each step,
so scans and steps interleave in one loop. `timeScale` needs no handling: a sped-up world runs more steps per real
second, and the scans follow the steps.

| Event | Result |
|---|---|
| Tab hidden | Worker paused, so no steps and no scans. |
| Slow render frame, GC pause, main-thread jank | Invisible to control logic: the worker never waits on the main thread. |
| 144 Hz display vs 60 Hz sim | Render cadence does not matter. The watch table re-renders whatever state the frames carry. |
| Refocus | The worker resyncs its step clock on unpause (`last = now; acc = 0`). There is no banked backlog, so no physics burst and no scan burst. |
| Step (while paused) | One `1/hz` step through the same scan-then-step path as the loop, so the scans due in it run too. A program scanning every 10 ms at 60 Hz runs one or two scans per Step; one scanning every 50 ms runs on every third Step. |
| Worker overload (heavy scene and heavy program) | The step loop sheds wall-clock backlog. Physics and control logic slow down as one unit. |

The visibility pause (`EditorController.onVisibilityChange`) saves CPU and stops a hidden tab spawning boxes. It is
not needed for correctness.

## The speed ladder: 0.5x to 8x

The toolbar's speed button cycles `0.5, 1, 2, 4, 8` (Shift+click steps back). The loop feeds Jolt the project's
fixed step dt and runs more steps, so fidelity is the same at every rung: no stretched timestep, no tunnelling, no
re-tuned friction, and the interleaved scan keeps pace. The ladder is bounded by throughput, not correctness. At
8x the worker must sustain 480 steps a second at 60 Hz, which on the demo scene takes most of a core, so 8x is the
last rung a normal machine can honour on a normal scene.

Past the machine's limit the loop sheds wall-clock backlog (the worker overload row above). The run stays exact in
its own time and only advances slower than the number on the button. The risk is that the shortfall goes unnoticed.

So `SimClient.clock` ([src/sim/simClockRate.ts](../src/sim/simClockRate.ts)) measures the achieved rate, sim seconds
per real second over 500 ms windows. When it stays short of the request, the speed button turns amber and shows the
measured value beside it (`state.speedActual`). Requesting more than a machine can step is allowed. Hiding the
shortfall is not.

Only the sustained verdict is shown, never the raw window. A single window swings a few percent on step quantisation
alone, and more on the loop's own burstiness (banked `acc` repaid in the next tick can read above the requested
scale). So the reading needs three consecutive short windows and is rounded to 0.1, and the stats overlay shows no
live rate. The HUD's `phys` is ms per step, and `hz * scale * phys` is the duty the request needs.

To simulate a whole shift and read the numbers, use the unclocked path instead of a bigger multiple:
`projectTestRunner` steps a bare loop with no wall clock, as fast as the CPU allows.

## Step rate: 60 to 1000 Hz, set per project

The step is also the I/O latency floor of the embedded PLC. Inputs change only when physics steps, and outputs reach
the world once per step, so a sensor edge on step N moves an actuator on step N+1: 16.7 ms at 60 Hz, however short
the scan time. A shorter scan gives finer timer and edge resolution, never faster I/O. The scans inside one step all
read the same inputs, and only the last one's outputs are applied. The same step quantises where cargo is when a
sensor sees it (3.3 cm per step at 2 m/s, at 60 Hz).

So the rate is a machine setting, `simHz` ([projects.md](./projects.md)): any whole number from 60 (the default) to
1000 Hz, set in the Inspector with nothing selected (the scene's own properties) and clamped into that range wherever
it arrives from (`toSimRate`). A project holds one machine, so the rate is a field of the project
(`ProjectMachine.simHz`, beside the program and its scan time), and a standalone scene file carries it at its top
level. It sets how soon an output can follow its input, so a project must step at the same rate wherever it is
opened, run or tested. Three things follow it:

- **The world** (`SimWorld.hz`): the Jolt step, every behavior's `ctx.dt`, kinematic moves, and
  `simTime = stepCount / hz`. A world keeps its rate for its lifetime, so a change applies on the next run (the
  Inspector says so when it changes during a run).
- **The worker loop's catch-up cap**, which is about 50 ms of real time (`3 * timeScale * hz / 60` steps), not a flat
  3. The loop ticks every 8 ms whatever the rate, so at 240 Hz one late tick already owes three steps. A flat cap
  would shed real time on every hitch and run the scene slow.
- **The project test runner**, which reads the project's `simHz` (`projectTestRunner.ts` `prepareScene`). A test
  stepping at another rate than Play would validate a different machine.

**60 Hz is the floor because of a correctness limit.** A pallet stands on nine 0.1 m blocks under a load many times
its own mass. With Jolt's default solver iterations (10 velocity, 2 position) on a running roller deck, the blocks
sink in until the pallet's top board rests on the deck, about 12 cm down, and the rollers can no longer drive it. With
the defaults the demo cell's 150 kg pallet stalls its line at every rate from 29 to 40 Hz, and a 1050 kg load sinks
even at 60 Hz. Only more velocity iterations hold it. So every pallet body runs its island at 40 velocity and 10
position iterations (`PALLET_VELOCITY_STEPS` in [bodyFactory.ts](../src/sim/bodyFactory.ts)), which holds 150 to 1500
kg from 60 to 1000 Hz. The floor stays at 60 Hz because even with the override, 600 kg still sinks at 30 Hz and 1500
kg at 45 Hz. [palletLoad.test.ts](../src/sim/palletLoad.test.ts) checks that a pallet carrying 1500 kg stays within 4
cm of the deck at rates from 60 to 1000 Hz (a sunk pallet reads about 13 cm), and that the load sinks without the
override. Light cargo is not affected by the rate. A heavy stack on something other than a pallet (box on box) is
untested.

**1000 Hz is the ceiling** because a 1 ms step matches the shortest scan (`MIN_SCAN_MS`). A faster step lowers no
I/O latency and only costs CPU. The cost grows linearly with the rate, so the speed ladder above applies at `60 / hz`
of the multiplier. A scene the worker cannot step in real time sheds backlog and runs slow, and the speed button's
shortfall readout reports it.

What guards the range: the physics invariants and the embedded PLC at a spread of rates
([simRate.test.ts](../src/sim/simRate.test.ts)), the demo cell's acceptance ladder at a spread weighted toward the
floor ([demoAcceptance.ts](../src/editor/demo/demoAcceptance.ts), one `demoScenesSim.<rate>hz.test.ts` per rate), and
[verify-sim-rate.mjs](../e2e/verify-sim-rate.mjs), which proves the Inspector clamps the rate and the live worker
steps at the chosen rate and keeps up with real time. Moving either bound means re-running that sweep.

## Why the scan lives in the worker

Everything the PLC's feedback depends on is in the worker: sensing (`castBeam` in
[src/sim/world.ts](../src/sim/world.ts)) and device motion (behavior-driven inside the sim). So the scan runs there
too, and the live path and the headless test path share one interleave. Input is sampled every step. Sampling at
render-frame cadence would let a 30 fps GPU halve the PLC's view of the world.

## Multi-user rooms

With Yjs live editing, each peer runs its own real-time sim, and those diverge however good the clocks are. The sims
are not kept in sync.
