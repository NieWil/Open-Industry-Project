# PLC device-IO bus

How an ST program (or a real PLC) exchanges I/O with the running sim. This documents the design
behind `simController.ts` / `bindings.ts`.

## Where the program runs: inside the sim worker, interleaved with the steps

The Jolt physics runs in a Web Worker, and **so does the attached ST program**
([`src/sim/plcHost.ts`](../sim/plcHost.ts)): before every fixed physics step, the worker loop latches %I
from the tags behaviors wrote on the previous step, drains however many whole scan periods one step of
**sim time** covers, and applies %Q so the step about to run reads it. That is the same lockstep the
headless project-test runner uses ([`editor/project/projectTestRunner.ts`](../editor/project/projectTestRunner.ts)). The
live sim and the test harness share one interleave, which reproduces exactly at any render frame rate and under
main-thread jank, tab throttling or a changed timeScale.

The **editor** keeps the authoring half: it compile-validates the source (so `StError` lands on the panel
synchronously), computes the authoring warnings and the driven-keys mirror, then ships the source over the
protocol (`SimClient.runProgram` → the worker compiles its own copy). Watch table / IO monitor / scan
telemetry render from the PLC state each worker frame carries back (`frame.plc`); a runtime scan fault
drops the program to STOP worker-side and comes back as a `plcFault` message.

> **Why the worker.** In the render loop the scan would exchange tags at *frame* cadence: inputs sampled
> from the last frame the rAF loop happened to see, outputs landing a frame hop later. Timer cadence is
> frame-independent either way (the fixed-timestep `ScanEngine`), but input sampling and reaction latency
> would depend on the render frame rate, so timing-sensitive logic would behave differently at 30 vs 120 fps. In
> the step loop there is no main-thread hop on the latency path.

## The device-IO tag bridge (the whole bus)

An SDK part's behavior reads and writes PLC tags **by name**: `ctx.readTag`/`writeTag` (BOOL) and
`ctx.readNumber`/`writeNumber` (INT/REAL). `writeTag` also takes a number and writes it as `writeNumber` does. There is no per-type binding table: a part authored to read
`"Run"` and write `"AtEnd"` is wired as soon as a program declares those tags.

```
  each fixed step, in the worker (PlcHost.interleave, before world.step()):

  behaviors' last-step ctx.writeTag/writeNumber ─► world.behaviorTagWrites()
                                                          │
  plc.setExternalInputs(flattened tags) ─► ScanEngine.advance(1/hz) ─► PlcLink.step(%I, dt) ─► %Q
                                                          │
  world.setBehaviorInputTags(%Q) ◄────────────────────────┘  ─► ctx.readTag/readNumber, the step about to run
```

- **part → PLC.** A behavior's tag writes are flattened across parts (`SimWorld.behaviorTagWrites`, same
  last-wins order as `frame.tags`) and latched into the %I image via `SimController.setExternalInputs`.
- **PLC → part.** After the scans (outputs hold in between, like a real PLC), every program output value
  is written back to the world's tag table for each behavior's next `step`, which reads them by name.

### The first scan follows the parts' first step

A part publishes its tags from its `step`, so before a world's first step nothing has published: a scan then
would read every input at its zero value. That breaks any program with a normally-closed input: an E-stop wired
as `EStopOK` (TRUE = healthy) would read as struck on scan 1 and latch the line on every Play and in every
project test. So our rule (IEC leaves when field inputs are first valid to the implementation): **on a world that has
not stepped, `PlcHost.interleave` does nothing**: no scan, and no PLC time. The parts take step 0 on no PLC
output, as a line does at power-up; the first scan runs before step 1 and reads what step 0 published, through
the same path as every scan after it. A program attached to a world that is already running (a live re-attach)
scans at once. The project-test runner keeps the same rule (`world.stepCount > 0`), so a test and Play see the
same first scan. The PLC's clock therefore starts one step after the world's: a program output reaches the parts
one step after the first scan, and a timer started on scan 1 ends one step later in sim time.

External PLCs (Modbus, S7, SLMP, OPC UA, EtherNet/IP, ADS) are untouched by this: a real PLC scans on its own clock and
exchanges the image per frame on the main thread, and the Modbus server starts with the scene's tags in its
image so the PLC's first poll does not read zeros (`ExternalPlcSession.start` in `editor/links/externalPlc.ts`).

`SimController` is thin: `setExternalInputs(tags)` latches the part-written inputs,
`sampleInputs()` is just that image, `scan(%I, dt)` solves one cycle, `tick(dt)` composes them. It has no
`IoAdapter` and no output-actuator step. A part drives its own visuals and motion from the tags it reads, in its
behavior.

## Which variables cross: declared I/O, and the program's own tags by wiring

A program's **declared** I/O always crosses: a `VAR_INPUT` is written in before each scan, a `VAR_OUTPUT` handed
back after it, and a located variable is bound by its address (`%IX0.0`). Those are `CompiledProgram.inputs` /
`outputs`, and they keep their direction whatever the scene does.

The program's **own tags** cross too, when a part is wired to one by name: a plain `VAR` of the code outside
every PROGRAM, a `VAR_GLOBAL`, a top-level variable (the code outside every POU beside a CONFIGURATION), or a
PROGRAM instance's variable as `Instance.Name`. Those are `CompiledProgram.bindable`: one bit or number, not a
CONSTANT, not located. They carry no direction of their own, so
the **parts** give it (`wiredBindings` in [`wiring.ts`](wiring.ts)):

- a tag a part **publishes** (a sensor's `tag`) is the program's **input**, written in before each scan;
- a tag the parts only **read** (a belt's `runTag`) is its **output**, handed back after the scan and **owned**
  by it (next section);
- a tag parts both publish and read is an input: a part drives it, so the program must not.

That is the rule the OPC UA link follows on a real controller, where a variable is found by name and
the parts decide which way it goes. The editor computes the bindings where the scene is (`controller.ts`
`runProgram`), from the same `checkWiring` walk the Problems dock runs, and ships them with the source
(`runProgram`'s `wired`); `LocalPlcLink(source, wired)` adds them to its I/O lists, ignoring any name the
program cannot bind that way, so a scene saved against another version of the program is harmless. Play, the
Problems dock, `check-wiring` and the project-test runner all bind the same way, so a program that passes a
project test runs the same in the app.

What this does not catch: with no declared direction, a program that ASSIGNS a tag a part publishes is not an error
here; its write is overwritten by the input before every scan. Declaring the direction the program means
(`VAR_OUTPUT` for a tag it commands) turns that wiring into a `contested` error, and the agent guide
(`src/core/agentGuide.ts`) tells an agent the same. A check that flags an assignment to a wired input would need the
program's assigned-variable set, which the compiled program does not expose.

### A program wholly inside one PROGRAM: bare names too

A program pasted from a PLC or another tool is usually one `PROGRAM Line ... END_PROGRAM` and nothing else. It
runs as an instance (the default controller table makes one per PROGRAM type, named after it), so its variables
are `Line.EStopOK`, `Line.Run`. Without an alias, a part wired to `Run` would see nothing while everything
validated and ran.
Our rule ([`plcLink.ts`](plcLink.ts) `soleInstanceAliases`): **when the controller runs exactly one program
instance, each of its variables is also the scene tag of its bare name.** `Run` and `Line.Run` are one variable,
not a copy:

- a declared `VAR_INPUT` / `VAR_OUTPUT` is an input / output under both names, so the output image carries
  `Line.Run` and `Run` and a part wired to either is driven; a part wired to `Line.Run` keeps working;
- a plain `VAR` binds by wiring (above) under either name;
- a project test's checks (and its inputs to a declared `VAR_INPUT`), a write to the running program by name, and
  the Problems dock's unbound / wiring checks take the bare name as the variable; the watch table and the OPC UA
  server keep one row per variable, under its qualified name.

**Collisions:** an alias never shadows a name the program already has. A controller tag or a `VAR_GLOBAL` called
`Run` (IEC names ignore case, so `RUN` too) keeps the bare `Run`, and the instance's variable stays reachable only
as `Line.Run`. Parts that use `Run` among themselves (not a program variable) are bound to the program, the same as
a controller tag of that name would be, so `check-wiring` reports a second writer as `contested`. Wiring one part to
`Run` and another to `Line.Run` as writers is two writers of one variable, which no check sees: wire a variable by
one name.

**No bare names** with two or more program instances (whose `Run`?), or with code outside every PROGRAM (that
code's variables are the bare tags already). A program that is two or more PROGRAMs and nothing else gets a
warning from `validate-project` / `check-wiring` ([`sceneProgram.ts`](sceneProgram.ts)), because nothing a part
is wired to by a bare name can reach it. The rule follows the controller that RUNS, so a table with one instance
or a written CONFIGURATION with one instance answers to bare names as well, however the table came to exist.

## Output ownership (`ctx.tagDriven`)

Real panels distinguish RUN from PROGRAM mode: a controller in RUN owns the outputs it declares; any other time a
device is the operator's to hand-cycle. The bus models that as a **driven set**: the tag keys the attached program
declares as outputs, or is bound to as outputs by wiring. It is static per program, so the controller ships it
**once** on attach (`SimClient.setDrivenTags`, from `runProgram`) and clears it on detach (`stopProgram`); the
worker hands it to each behavior beside the value table, as `ctx.tagDriven(name)`. Interactive devices gate
their auto mode on it (`tagDriven(tag) ? readTag(tag) : manualLatch`), so a hand Use works whenever
nothing is scanning (stopped scene, no program, undriven tag), and the program takes the device over as soon as it
attaches. The controller mirrors the same set (`plcDrivenKeys`) for the pilot crosshair's "In auto - PLC controlled"
prompt. It shows only for `'tag'` params marked `autoWhenDriven` in the part's schema, the ones the script's auto
gate reads. A driven tag the device merely publishes (a button's press) or reads as an indicator (a button's
`lampTag`) never owns the interaction, so those stay a plain "Use". Declared program *inputs* are not driven:
reading a tag isn't owning it. `WsPlcLink` ([`wsPlcLink.ts`](wsPlcLink.ts), server half [`softPlc.ts`](softPlc.ts))
ships its output names at attach in the same way. The editor does not use it.

## Process image + fixed-timestep scan

A real PLC solves on a steady cycle time, not "once per whatever frame the GPU produced", and within a scan it
reads a *frozen* copy of its inputs and writes its outputs once at the end. Two pieces give us that:

- **Process image.** `SimController` splits the cycle into `sampleInputs()` (the frozen %I from the latched
  external inputs), `scan(pii, dt)` (solve against that image, moving the controller's clock on by `dt`,
  producing %Q), composed by `tick(dt)`. Timers read that clock, so a timer the scan does not call still
  measures the time that passed. `processImage` exposes the latest %I/%Q for a monitor view.
- **Fixed timestep.** `TaskScheduler` ([`scanEngine.ts`](scanEngine.ts)) wraps the controller, and `PlcHost` drives
  it with the **fixed step dt** once per physics step. Each `advance(1/hz)` (the world's step rate) accrues exactly
  one step of sim time and runs as many whole `period`-sized scans (default 10 ms / 100 Hz) as it covers. So the
  scan/step interleave is a pure function of the step count: deterministic, and correct under any timeScale without
  extra work (more steps per real second → proportionally more scans). Sim time cannot backlog the way wall-clock
  frames can, so the catch-up clamp (`overrun`) only trips if the cycle time is pushed below what one step can drain
  (`MAX_SCANS_PER_STEP`); cumulative `scansRun` / `overruns` travel in each frame's `plc` payload to
  `EditorController.plcScanStats` for the PLC panel. Beside them rides each task's measured execution time
  (`scanTimes`: last, average and max in ms of real time, `PlcHost.scanTimes`), which the Watch dock and
  the agent's `get_tags` show. It is telemetry only: the interleave runs on sim time, so a slow scan slows the whole
  sim and never makes a task late or moves a fingerprint. Because that limit is a pure function of the task interval and
  the step rate (`shortestHeldIntervalSec`), the Problems dock warns about a TASK too fast to hold before Run, on
  its `INTERVAL` line. Only a TASK written in the text can be that fast, since the scan-time field and the
  controller table both floor at 1 ms. When the whole *worker* can't hold real time (heavy scene + heavy program),
  the physics loop sheds wall-clock backlog and the sim slows down as one consistent unit, so control logic and
  physics cannot shed independently. The headless project-test runner uses the same scheduler, so a test scans on
  exactly the cadence Play does.
- **Writes and forces.** A write from the Watch dock, the ladder's Toggle Bit or `set_tag` goes into the running
  program once, between scans (`LocalPlcLink.force`), so a variable the program writes is overwritten by its next
  scan. A force holds it instead (`LocalPlcLink.setForces`): the held value is written before every scan, so the
  program reads it whatever the scene feeds, and again after the scan, so the output image and the parts see it
  whatever the program wrote. A force is set from the Watch dock, a part's tag field in the Inspector, a device's tags
  dialog (the PLC panel's Devices list), or the right-click menu on a rung's operand or a variable in the code; the
  agent has `force_tag` / `release_forces`. It shows in the warning colour wherever the variable or its part appears:
  the Watch dock, the rungs (an F beside the operand), the Inspector field, the Scene tree and Devices list rows, and
  the toolbar's count, which lists them with the parts they reach and releases them. A write to a forced variable
  changes the held value. The shared reading of it is `editor/program/plcForces.ts`. A force stays until
  released, as on a controller: through Stop, a fault or a reload, and into the next run from its first scan
  (`SimClient.forces`, resent with every attach). An attach drops a force whose variable its program no longer has
  with the same type and names it in a notice; the ones still held show on the toolbar's count. Loading another scene
  releases them all. Never saved, never an undo step. Gated by `e2e/verify-plc-force.mjs`.
- **Tasks.** A program that declares a `CONFIGURATION` brings its own tasks (`CompiledProgram.tasks`), and the
  scheduler keeps one accumulator per task instead of one for the program: each task comes due when its
  `INTERVAL` of sim time has elapsed, the scans a step makes due run in the order they came due, tasks due
  together run by `PRIORITY` (0 first, then declaration order), and a program instance with no task runs once
  per step after the periodic scans (IEC gives it the lowest priority). A scan takes no sim time, so no task
  interrupts another mid-scan: the interleaving is fixed by the periods, which keeps it reproducible, and it
  also means the sim does not reproduce a bug that depends on preemption landing between two statements. The
  scene's scan time is the interval of the default task a program with no controller table runs on. A `PROGRAM`
  instance's variables cross the bus as `Instance.Name` (`Line1.Motor`), and as the bare `Motor` too when it is
  the only instance (above); the top-level code's are the controller's tags and keep their bare names, whichever
  table runs them.

> **The interleave is a `LocalPlcLink` concern, not a `PlcLink`-wide one.** It works because the local
> interpreter scans on *our* clock. A remote PLC owns its **own** scan cadence, and you cannot drive it one
> `step()` per 10 ms scan over a socket. So `WsPlcLink`, which the editor does not use, is a **main-thread** link:
> it exchanges the process image at roughly frame rate through the direct-injection seam (`SimClient.setTags` +
> `frame.tags`), **not** through `PlcHost`. Sampling fidelity note: scans faster than the step period all see
> the same `%I` within a step (inputs only change when physics steps), so the scan samples at the sim
> rate (the world's true information rate). A shorter cycle time gives finer timer/edge resolution, not a
> higher sensor sampling rate.

## Authoring warnings (`bindings.ts`)

`bindings.ts` holds only authoring feedback over the bridge, for the ST editor:

- **`commsTags(parts)`**: every PLC tag a comms-enabled `part` wires (the values of its `tagRef`-kind params),
  offered as autocomplete so the program's VAR_INPUT/OUTPUT names match what the scene drives.
- **`unhandledProgramTags(parts, link)`** returns `{ unbound, unwired }`: a declared program tag that no part reads/
  writes (`unbound`), and a scene tag the program never declares (`unwired`), for a UI to flag. `unbound` is
  over-approximated (a part's string param equal to the tag name counts as handling it), so it works whether
  the tag is in a `tagRef` param or a plain text one (e.g. the robot's `commandTag`).

## Real PLCs

SDK sensors cast their beams in the sim worker ([`core/beamCast.ts`](../core/beamCast.ts)). The editor runs
external PLCs end to end
([`editor/links/externalPlc.ts`](../editor/links/externalPlc.ts), UI in `ExternalPlcSection.tsx`), and the I/O table is
derived from the parts' address tags (`modbusServerFromTags` / `modbusClientFromTags` in
[`core/io/externalIo.ts`](../core/io/externalIo.ts)) rather than stored in the document.

## External PLC: the simulator as a Modbus TCP server

A controller outside the simulator cannot read tags by name. It exchanges numbered points, so a table says
which point carries which tag ([`core/io/externalIo.ts`](../core/io/externalIo.ts)), and the direction comes from
the Modbus area: the PLC reads discrete inputs and input registers (sensors) and writes coils and holding
registers (actuators). The tags it writes are DRIVEN, exactly like an attached program's outputs.

The simulator is the **server** and the PLC polls it. That is how OpenPLC and most soft PLCs reach field I/O
as a Modbus master, and with a master PLC it is the only way round that works: Modbus has no function code
that writes a discrete input or an input register, so a sim acting as a client could never feed its inputs.
(A PLC that runs a Modbus SERVER instead is the other topology, below.) The protocol lives in
[`modbusServer.ts`](modbusServer.ts) with no socket (`ModbusServerIo` maps the table to an image,
`ModbusStream` reassembles one connection's frames); a host carries the bytes. This is also why this does not
reuse oip-comms: every backend there is a client.

As in the cadence note above, the external PLC is not interleaved with the steps. Tags cross the image once
per step, the PLC samples them on its own poll, and its outputs land a poll and a scan later.

`npm run openplc-loop` ([scripts/openplc-loop.mjs](../../scripts/openplc-loop.mjs)) is the end-to-end proof:

1. A program is built by OpenPLC's own editor code, with its variables bound to `%IX100.n` / `%QX100.n`.
2. It is uploaded to a real OpenPLC Runtime v4, which polls the headless simulator.
3. A box has to stop at a photo eye within 0.15 m of where it stops with the program attached in-process.

A program that ignores the eye fails two checks. CI runs the same script against
the runtime's container (`st-oracle.yml`, job `openplc-loop`).

## The other way round: the simulator as a Modbus TCP client

Some controllers are easier to set up as a Modbus SERVER than as a client polling the simulator. So there the PLC
serves and the simulator polls it, which also means the simulator, not the PLC, sets the link's pace.

This mode reads the server's registers as an image of the PLC's process image, byte-wise and low byte first. The
client WRITES holding registers to reach the PLC's inputs and READS input registers to see its outputs, so our fixed
rule ([`registerImagePointFor`](../core/io/externalIo.ts)) is: `%IXb.n` is holding register `b>>1`, bit `(b&1)*8 + n`;
`%IWn` is holding register `n`; `%IDn` is holding registers `2n, 2n+1`, low word first; `%Q` the same in the input
registers. Coils are never used. The protocol lives in
[`modbusClient.ts`](modbusClient.ts), again with no socket: `ModbusPoller` moves the whole holding block with one
FC16 and reads the whole input block with one FC4 per cycle (split past 123 / 125 registers), and
`ModbusClientStream` frames one connection. Its tests poll this repo's own server, so the two halves are checked
against each other byte for byte.

**The addresses are the PLC's own.** Which `%I`/`%Q` addresses the device's registers map to is set in the
PLC's configuration, and its I/O mapping page shows them; the ranges a device maps are that configuration's.

**In the app** (desktop only, like the server): Controller Properties' "The simulator polls the PLC" choice
(double-click the Controller node at the top of the PLC panel's organizer, or Simulation > External PLC...). You
give the PLC's address and port, and where its server device sits in the image: "Holding register 0 is %IW..." and
"Input register 0 is %QW...", the two addresses the device's own I/O mapping page shows, both 0 when it is the PLC's
only I/O. On Play the desktop shell connects out (`plcio:connect`, apps/desktop/plcIo.cjs) and
[`ExternalPlcClientSession`](../editor/links/externalPlc.ts) polls every 20 ms. Pressing Play before the PLC is up is
fine: it retries every second and the dock says what it is waiting for. The watchdog is the server's: no complete
cycle for 1 s, or the connection closed, and the PLC's outputs are handed to the scene OFF until it answers.

**Assign I/O follows the choice.** For a PLC that serves, a bit and the word that holds it are one place (the image
is byte-addressed: `%IX0.3` is a bit of `%IW0`), so addresses are packed from the device's first register up, every
size at the first free spot, and Import refuses a word on a register a bit already uses. A conveyor with an eye, a
run bit and a REAL each way lands on `%IX0.0`, `%QX0.0`, `%ID1`, `%QD1`. Export I/O List names each point's register
("holding register 0 bit 0"). `e2e/verify-external-plc-electron.mjs` drives the whole path in the real desktop
shell, with the test playing a PLC that serves its image and runs `Run := NOT Eye`.

## By name: OPC UA

Modbus carries numbered points, which is why the two modes above need addresses. OPC UA carries NAMES: a PLC's
OPC UA server publishes its program's variables as nodes, and the simulator reads and writes them as a client.
So in the dock's "OPC UA, tags by name" mode nothing is assigned. A part's PLC tag is the PLC's own name for
the signal (`Eye`, `Main.Eye`, `"Conveyor".Eye`), which is also how a scene wired to the
program here is already written.

**Finding the node** ([`core/io/opcUa.ts`](../core/io/opcUa.ts)). On Play the link browses the server's tree under
Objects (the standard namespace and properties left out) and matches each tag against the END of every
variable's browse path, so the same tag works whatever the server puts above it: OPC UA leaves that to each
server (a DI `DeviceSet` and a device object, a runtime object, a global-data folder, any depth), and the match
assumes none of it. Case is ignored as IEC ignores it (an exact spelling wins a tie); a name that fits
more than one variable is refused with the candidates listed; a NodeId written out is taken as it is. Each match
is checked before use: a bit on a Boolean, a number on a numeric type, and the user's access level allowing
the write or the read. The dock lists every tag against the node it found.

**Where the browse starts.** Objects, unless the link names start points in "Browse from": paths of browse names
from Objects (`DeviceSet.PLC.Programs`) or NodeIds, set per link on this computer like its address. A controller
that also runs a CNC or drives can hold tens of thousands of variables a program never uses, and reading them all
makes every connect slow and the tag list long. A path is followed one browse name at a time, matched as a tag is,
and its variables keep their whole path from Objects, so a tag binds the same with start points as without. A
NodeId's variables start at its own browse name. A start point the server does not hold, or a path that fits two
nodes, fails the read with that said, rather than showing up later as tags reported missing. When every tag a
link carries is a NodeId it does not browse at all.

**A large tree.** A browse request asks for at most 1000 references per node (the rest follow by continuation
point) and gets 30 s to answer, where a cycle's requests get 5 s. A batch that still times out goes again in
halves, each time on a new session, since the server may keep continuation points reserved for an answer the
client gave up on. A node that times out alone, twice, is left out, and the dock names it: `a branch of the
PLC's tags did not answer in time`. While the run's browse is under way the dock counts the variables found.

**Picking a name** ([`inspector/tagField.tsx`](../editor/components/inspector/tagField.tsx)). A tag field suggests
the scene's tags, the program's (of the field's type), and, in this mode, the PLC's: what the run's link last
browsed, kept after Stop (`controller.plcTagList`), or a one-shot connect-browse-close from the list's "Read the
PLC's tags" while stopped (`readOpcUaTagList`; the shell holds one link per window, so a run that starts meanwhile
takes it over and the read never closes it). Each variable is offered by the shortest end of its path that names
it ALONE (`opcUaTagNames`), so a pick always binds; array elements and structures are left out, since neither
binds. The PLC's names are listed only once something is typed, best 50 first, because a large program's tree
runs to thousands. A typed tag the PLC does not hold gets a "not on PLC" chip naming the closest names
(`closestOpcUaTagNames`), the verdict Play would give, before Play. Not filtered by type: the browse carries no
data types, and reading 20,000 of them for a suggestion list is not worth a connect's time. The list stays a
suggestion: a name typed by hand is taken as typed. Gated by `e2e/verify-tag-suggest.mjs` (a fake host).

**Direction** comes from the parts: a tag a part publishes is written to the PLC, one parts only read is read
from it. Writing is where OPC UA differs from Modbus in practice: most PLCs will not let a client write their
real inputs, which their I/O system overwrites every scan. The program needs variables for the simulator to
write, or the PLC must be a simulated one that accepts them; a node the server marks read-only is reported
by name, with that advice.

**The shell speaks the protocol.** OPC UA is too large to carry by hand the way Modbus is, so node-opcua (MIT)
runs in the desktop shell's main process ([`apps/desktop/opcUaIo.cjs`](../../apps/desktop/opcUaIo.cjs)):
connect, browse, describe, and one write-then-read per cycle. Everything that decides (which tag is which
node, what a value means, the retries, the watchdog) stays in the app
([`ExternalPlcOpcUaSession`](../editor/links/externalPlc.ts)).

**Unsecured.** Security policy None and an anonymous session: no certificates to trust on either
side. That is what a soft PLC on the same machine or a test bench allows; a plant network usually does not,
and the dock says the connection is unsecured. A server that only accepts secured clients is reported as
such. Certificates and logins other than anonymous are not supported.

**A discovery server is not a PLC.** Port 4840 is OPC UA's standard port, and on a machine where a vendor
install brought the OPC Foundation's Local Discovery Server, that is what answers
there: a directory of the machine's OPC UA servers, with no tags. The shell asks what kind of server answered
before it opens a session (every OPC UA server declares its application type), and for a discovery server it
asks for the list instead. The dock then says `<address> is an OPC UA discovery server, not a PLC` and names
the servers it lists, and the link stops retrying; without this, every tag would be reported missing, which
sends the user looking in the wrong place.

**What the watchdog cannot see here.** A Modbus server device goes quiet when its application stops. An OPC UA
server belongs to the runtime, not the program, and keeps answering with the last values, so a PLC whose
PROGRAM is stopped still looks alive; only a lost connection or a silent server trips the watchdog.

`e2e/verify-external-plc-electron.mjs` drives it in the real desktop shell against a node-opcua server holding a
`MAIN` object with `Eye` and `Run` under Objects, including the PLC going away mid-run and coming back, when the
tags are found anew.

**Connecting to a PLC runtime's OPC UA server:** publish the program's variables to its OPC UA server (how is the
vendor's to document), and wire the parts to the variables' names. If a discovery server already holds port 4840
on that machine, move the PLC's server to another port in its own configuration, and the endpoint is then
`opc.tcp://<host>:<port>`.

## By name: EtherNet/IP to a Logix or Micro800 controller

The dock's "EtherNet/IP, tags by name" mode talks CIP to a ControlLogix or CompactLogix, which holds its tags
symbolically, so it works like OPC UA without the browse: a part's PLC tag is the request (`Eye`,
`Program:MainProgram.Eye`, `Lane[3]`, `Status.3` for one bit of a DINT). Settings: the controller's address
(`host` or `host:port`, 44818 by default) and the path to its CPU (`1,0` = backplane, slot 0; empty when the
address is the controller's own port), and the controller family. A Micro800 (Micro820/850/870) is the same
CIP tag services reached at the controller's own port, so it takes no path (a path kept from a Logix setup is not
sent) and libplctag is told `plc=Micro800`; only its global variables answer over the network. On Play every tag is read once, which is how the controller says what
type it holds (`raw_tag_type_bytes`: 0xC1 BOOL ... 0xCA REAL); `core/io/eip.ts` refuses a bit on a number and the
reverse, structures, and LINT. Then one write+read cycle every 20 ms.

**The shell speaks the protocol** through libplctag (MPL-2.0 / LGPL, an unmodified release binary), loaded with
koffi in `apps/desktop/eipIo.cjs`. Every call is started with timeout 0 and finished by polling its status, so
a dead controller never blocks main; a request unanswered after 1 s is aborted. The library is fetched, pinned
and SHA-256-checked, by `scripts/fetch-libplctag.mjs` (the shell's `postinstall`) into
`apps/desktop/vendor/libplctag/`, together with `ab_server`, libplctag's Logix simulator, which only the tests
use (`apps/desktop/eipIo.test.cjs`, and the EtherNet/IP phase of `e2e/verify-external-plc-electron.mjs`).

**Watchdog:** libplctag holds the session and reconnects by itself, so "gone" means every request of a cycle
failing as unreachable (timeout, bad gateway ...): the outputs go off, and the tags are asked for again a second
later. Like OPC UA, a controller in Program mode still answers, so it is not detected.

**Which failures mean what is read off libplctag's own CIP error table** (`src/libplctag/protocols/ab/error_codes.c`
in v2.7.2), not guessed. Only statuses no answer can produce (timeout, socket, session) count as "nothing
answered"; REMOTE_ERR is that table's "Unknown error code" / "Miscellaneous", a reply, so it stays one tag's
problem. A wrong path does not time out on real hardware the way it does against ab_server: the Ethernet
module answers it itself ("Link Address Not Valid" -> BAD_PARAM, "Port Not Available" -> BAD_DEVICE), the same
statuses a missing tag gives. So when every tag fails that way the link reports one thing (check the path, then
the names; `eipNothingAnswered`) instead of calling each tag missing.

**ab_server is not a controller** in two ways the smoke test pins: a missing tag answers BAD_PARAM (a real one
answers NOT_FOUND; both read "the controller has no tag named ..."), and writing one bit (`Count.3`) is
UNSUPPORTED there, because it lacks the read-modify-write service a Logix controller has. The smoke test runs the
same checks against ab_server's Micro800 mode, which also refuses the tag listing. On a real Micro800, libplctag
2.7.2 sends the same `@tags` request as for Logix (ab_common.c gates it on Logix or Micro800) and normalises the
reply to the same entry layout, which libplctag's own `list_tags_micro8x0` tool reads; a Micro850 user reported it
listing reliably from libplctag 2.6.10, after a regression in earlier 2.6 releases. The listing leaves out BOOL
arrays, which the tag picker drops anyway. The link has not been run against real Logix or Micro800 hardware.

## By name: ADS to a TwinCAT runtime

The dock's "ADS, tags by name" mode reads and writes a TwinCAT 3 PLC's variables by their symbol paths
(`MAIN.Eye`, `GVL.Run`): ADS "symbol info by name" says each one's type and size, a handle by name is taken once,
and each 20 ms cycle is two ADS SUM commands, every write in one request and every read in another
(`apps/desktop/adsIo.cjs`). Rules in `src/core/io/ads.ts`: BOOL, SINT..UDINT, REAL, LREAL travel, an enum or TIME as
its base integer; structures, strings and 64-bit integers are refused. Settings: the PLC's AMS Net ID (empty = the
runtime on this PC) and AMS port (851). The session (`editor/links/adsLink.ts`) is a lazy chunk, loaded on Play.

**Through TwinCAT's own router, by Beckhoff's TcAdsDll, as oip-comms does (`tcads_loader.cpp`).** A client on a PC
with TwinCAT hands its ADS requests to that PC's AMS router through TcAdsDll, which is how a local client is meant
to reach a PLC. The router owns the routes, the Net IDs and the transport to each PLC, secured or not, so the app
carries no ADS transport of its own. So ADS is Windows-only and needs TwinCAT on this PC. Any install carries the
DLL. It is found at `OIP_TCADSDLL_PATH` when that is set, and then only there, else at the registry's install, then
the standard paths. The link needs no route of its own, because the engineering PC's router already reaches its
PLCs. Calls run on koffi's worker thread with a 500 ms router timeout, so a dead PLC never blocks main. Error codes
are worded after oip-comms' `ads_err_name`. Unreachable ones (no route, Config mode, no answer) trip the watchdog
and retry, and a PLC downloaded again under the link (symbol version changed, not active) is bound anew. Like OPC
UA, a PLC that is merely stopped still answers, so it is not detected.

Running a TwinCAT PLC needs a TwinCAT license on the user's system (TwinCAT's own documentation says how to get
one); without one the runtime stays in Config mode. No test here talks to a TwinCAT router, installed or not: the
Electron gate's ADS phase points `OIP_TCADSDLL_PATH` at a file that is not there and checks only the app's own side
(the dock, the lazy session, the IPC into adsIo.cjs, its argument checks and its missing-DLL answer reaching the
dock); `src/editor/links/adsLink.test.ts` covers the session against a fake. `guides/ads/` is the step-by-step page.

## By address: S7 PUT/GET to an S7-1200 / S7-1500

The dock's "S7 PUT/GET" mode reads and writes a CPU's I, Q and M memory, and its data blocks (below), over the S7
protocol (TCP port 102), which every S7-1200 and S7-1500 answers once PUT/GET is permitted in its properties (off by
default; Siemens' documentation shows where the setting is). No license, no OPC UA server, no table: S7 memory is
byte-addressed as IEC direct addresses are, so a part's address tag is its S7 address (`%IX80.4` is I80.4, `%QD84`
is QD84), and `core/io/s7Io.ts` only decides direction: I is written, Q read, and M goes the way the parts use it (a
part writes it: to the PLC). Values are big-endian; a double word is DINT or REAL by what the tag carries, as over
Modbus. Settings: the CPU's address, port (102), rack (0) and slot (1).

**The protocol is ours**, ported from the oip-comms driver (`S7Com.cpp`) into
`src/plc/link/s7Client.ts`, with no socket of its own: the desktop shell's plain TCP connection carries it, as it
does the Modbus client. Per connection: COTP connect (it names rack and slot), S7 setup (the PDU size: a 1200
usually agrees 240), then each 20 ms cycle one multi-item write job per batch of points (a bit is written as a
BIT, so the rest of its byte, a real input card's, is untouched) and one read of each area's byte run. Every
job is cut to the NEGOTIATED PDU and 20 items. The session (`editor/links/s7Link.ts`) and the protocol are a lazy
chunk, loaded on Play. Retries and the watchdog are the Modbus client's. A REFUSED job (PUT/GET off) keeps the
connection and is asked again once a second. Until a job goes through, the dock says it is still waiting for the
CPU, and where the checkbox is. `guides/s7/` is the step-by-step page, followed by `e2e/guide-s7.mjs` against the
fake CPU below (a curated gate).

**What has proved it, and what has not.** The unit tests pin our bytes to oip-comms' request templates (which talk
to real CPUs) and run the client against a strict fake CPU (`src/plc/link/s7FakeCpu.ts`: rack/slot, the PDU limit, bit
writes, PUT/GET off). `npm run s7-loop` runs the conveyor case against snap7's server (its C library, python-snap7
2.x), with the program on the far side transcribed into Python over the server's memory. It runs the same verdict as
`openplc-loop` (`behaviourChecks` in `scripts/lib/conveyor-loop.mjs`): the belt stops within 500 ms of the eye, the
box comes to rest within 0.15 m of where it does in-process, and the belt creeps once the laser measures a box
within 1 m. It also checks that the eye's byte keeps the bits planted beside it. snap7 is not a CPU: it enforces no
PUT/GET setting, rack, slot or protection level. So two things are believed, not measured: that PUT/GET off answers
header error 0x8104 (snap7's users report it; `s7Client.ts` HEADER_ERRORS is where to correct it), and that a wrong
slot is refused at the COTP connect.

**Data blocks** travel too, in the S7 data-block spelling but without a `%` (a `%` tag is an IEC address to the
whole scene, so `%DB10.DBW4` is refused with a hint): `DB10.DBX0.0`, `DB10.DBB2`, `DB10.DBW4`, `DB10.DBD6`. Area
0x84 with the DB number in each item's address; each block is read as its own byte run; direction follows the
wiring, as for M. The scene keeps a DB tag as the part spells it (it is not an IEC address, so nothing canonicalises
it), so `db10.dbw4` and `DB10.DBW4` in two parts are reported as one address spelled two ways. Only a standard DB
has byte offsets: a new DB on a 1200/1500 uses OPTIMIZED block access, and the link's error for a refused DB item
(0x05 or 0x0A) says to turn it off for that DB. Which of the two codes a real CPU answers an optimized DB with is,
again, what snap7's users report, not measured here. `npm run s7-loop -- --db` runs the case with the laser's
distance in DB10.DBD0 and the speed command in DB10.DBD4, against a DB10 snap7 holds. The same verdict applies, and
a client that sends DB 0 instead fails it.

## By address: SLMP to a MELSEC CPU

The dock's "SLMP" mode reads and writes a MELSEC CPU's X, Y, M and D devices over SLMP (the 3E frame, TCP port
5000 unless something forwards it), which every Q, L, iQ-R and iQ-F CPU answers on its Ethernet settings. No
license and no OPC UA server: a part's tag is the CPU's own device address (`M10`, `Y10`, `D100`, `B1A`, `W10`,
`TN5`), and `core/io/slmpIo.ts` decides direction and type: every device goes the way the parts use it (a part
writes it: to the PLC), and X is the CPU's inputs, so on a CPU with input modules at that address the input
refresh overwrites what the simulator wrote every scan (the S7 I rule).
The device set is SH-080008's list minus the long devices (LTS/LTC/LTN, LSTS/LSTC/LSTN, LCS/LCC/LCN, LZ), which
only the extended frame names. A bit device carries a BOOL; a register carries INT (one register) or DINT/REAL
(two, low word first). X, Y, B, W, SB, SW, DX and DY count in hexadecimal, the rest in decimal. Settings: the
CPU's address and its SLMP port.

**The protocol is ours**, from the SLMP reference (SH-080956), in
`src/plc/link/slmpClient.ts`, with no socket of its own: the desktop shell's plain TCP connection carries it, as it
does the Modbus client and S7. Each 20 ms cycle: one batch write (1401) per run of consecutive points and one
batch read (0401) per device run, cut to 960 word registers or 1024 bits per request. The device spec is the QnA
form (a 24-bit number and a one-byte code), which every family accepts; the iQ-R's extended form is out of scope.
SLMP answers in order and carries no request id, so `SlmpStream` matches answers to requests by their order, one
request in flight. Bits pack two points per byte, the even point in the high nibble - not LSB-first. The session
(`editor/links/slmpLink.ts`) and the protocol are a lazy chunk, loaded on Play. Retries and the watchdog are the
Modbus client's; a REFUSED request (an end code) keeps the connection and is asked again once a second.
`guides/slmp/` is the step-by-step page.

**What has proved it, and what has not.** The unit tests pin the bytes to the 3E frame layout of the SLMP
reference and run the client against a strict fake CPU (`src/plc/link/slmpFakeCpu.ts`: the route, subcommand per
device kind, the frame limits, the nibble packing).
`src/plc/link/slmpLive.test.ts` runs the same against a live PLC when `OIP_SLMP_ENDPOINT` names one: registers and
bits round-trip low word first, a span of 2001 words goes out as 3 frames and 2001 bits as 2, and a device number
past the CPU's range answers an end code. Which end codes a CPU answers with is the manual's table
(`slmpClient.ts` END_CODES, where to correct it), and the iQ-R device ranges are the manual's
(`core/io/slmpIo.ts` MAX_NUMBER).

## The simulated PLC's own OPC UA server: a SCADA beside the program

Everything above hands the scene to a REAL PLC. This is the other half of a real cell: the program in the PLC
panel keeps running here, and a SCADA or HMI (or a test client) connects to the simulator the
way it connects to a real PLC's own OPC UA server, to watch the line and press its buttons. It is a switch of
its own in Controller Properties ("OPC UA server"), a machine setting like the rest, and it does not change
where the program runs.

**What is published** ([`editor/links/opcUaServer.ts`](../editor/links/opcUaServer.ts) `publishedVariables`): every
variable of the program's watch table, under Objects / PLC, one folder per dot, so `Main.Start` is
PLC / Main / Start and a timer's outputs sit in a folder named after it. The NodeId is the name itself,
`ns=1;s=Main.Start`, so a SCADA tag reaches the same variable on every run and every machine. The type follows
the declaration (`CompiledProgram.varInfo`): BOOL a Boolean, INT an Int16, DINT an Int32, REAL a Float, LREAL a
Double, STRING a String, an enumeration an Int16, a TIME a Double of milliseconds (what the watch table shows).

**What a client may write**: what an operator would, a Start button or a setpoint. Read-only are a constant, a
function block's output (`T1.Q`), and a variable the SCENE feeds, by name or by the address it is located at,
since the next scan takes the part's value again. A write crosses to the worker as `writePlcVars` and lands
before the next scan (`LocalPlcLink.write`), so the program sees it exactly as it sees a part's tag.

**Out of service, not gone.** The server lives for as long as it is switched on, not for one run, because a
SCADA stays connected across Stop and Play. While nothing runs the program here (stopped, faulted, or an
external PLC running the scene) every variable reads `BadOutOfService` and a write is refused with
`BadInvalidState`: a SCADA must not show a motor running on a line that is not. The nodes stay, and a node
whose name and type are unchanged keeps its identity across a redefine, so a client's subscriptions survive
Stop, Play and a program reload. While stopped it publishes the document's program as it compiles, so a
SCADA can be built against it before the first Play; an edit made while stopped is published on the next Play.

**Values** are read from the same 10 Hz watch mirror as the watch table, and only what changed crosses to the
shell. The server serves them to a client's subscription at its sampling interval, 50 ms at the fastest.

**Unsecured, like the client**: security policy None and anonymous sessions, on this machine only unless
"Reachable from the network" is on. The default port is 4843, not 4840: on a machine with PLC software installed
the OPC Foundation's discovery server may hold 4840, and a PLC's own server moved off it may take the next port up.

node-opcua runs the server in the desktop shell's main process
([`apps/desktop/opcUaServer.cjs`](../../apps/desktop/opcUaServer.cjs)); a browser tab cannot listen on a port, and
Controller Properties says so. `e2e/verify-opcua-server-electron.mjs` plays the SCADA against the real desktop
shell: it browses, subscribes to the eye, presses Start, and the belt has to run and stop the box at the eye; Stop
and Play again must keep the same subscription.

A SCADA or HMI connects as to any OPC UA server: add an OPC UA connection to this endpoint (security None,
anonymous), browse PLC / Main, and subscribe.

## Watch only: a PLC that runs real equipment

A controller set to Watch only (`ScenePlc.watch`) reads every point from its PLC, the tags parts write included, and
writes none. Each point's direction becomes "read from the PLC" (`watchedPoints` in editor/links/externalPlc.ts), so a
sensor's tag is driven by the PLC and a part that checks `ctx.tagDriven(tag)` shows the PLC's value instead of what it
senses. It works by name (OPC UA, EtherNet/IP, ADS) and by address (S7, SLMP), and not over Modbus, where the simulator
cannot read the PLC's inputs. [docs/live-share.md](../../docs/live-share.md) has the rest.

## When the PLC goes away: the link's watchdog

A PLC that stops answering leaves its last outputs sitting in the image, and there is no packet that says
"I have stopped". Holding those values runs the line forever on outputs nobody is driving. The usual case
is ordinary: you stop the PLC to edit its program, and a real line's belt stops, so the simulated one must too.

So the link watches the traffic, not the connection. **No request for `POLL_TIMEOUT_MS` (1 s), or no master
connected, and every tag the PLC drives is handed to the scene in its OFF state** (a coil false, a
register 0) until it polls again. 1 s is about 50 missed polls at the 20 ms cadence the loop measures:
unambiguous, and far enough from a scan's jitter that a busy master is never called dead. Real remote I/O
faults to its safe state for the same reason, and OpenPLC's own device configuration makes you choose it
(`error_handling: keep-last-value` or `set-to-zero`).

Three things it does not do. It does not stop the run: the scene keeps stepping and the line
coasts to a halt, which is what you would watch happen. It does not clear the image, so the moment polling
resumes the PLC's real values come back without it having to rewrite them. And it does not hand the devices
back to hand control. The PLC still owns them (`ctx.tagDriven`), and they are de-energised.

It is also not armed until the PLC has polled at least once, because before that the image is zeros anyway and
"waiting for a PLC" is what the dock already says. Calling that a fault would show one on every run before anything
had gone wrong. The dock names the state either way ("The PLC stopped polling for 1.2 s: its outputs are held off
until it polls again"), so the user can see that the outputs are held off and why.

`e2e/verify-external-plc-electron.mjs` proves it with the connection still OPEN (a stopped program announces
nothing): the master drives the belt, stops polling, and the box has to stop, then run again the moment the master
polls.

## Several controllers: a tag names its PLC

A line often has more than one controller: one per cell, or a line PLC beside machine PLCs. The scene lists its
controllers ([`core/scene/scenePlcs.ts`](../core/scene/scenePlcs.ts), `SceneJSON.plcs`). The first is the default
controller, PLC1 unless renamed. A part reaches another one by writing that controller's name before its tag, with two
colons: [`core/io/controllerTag.ts`](../core/io/controllerTag.ts).

| Tag | Goes to |
|---|---|
| `%IX0.0`, `Eye` | the default controller: the program in this app, or the external PLC that runs instead of it |
| `Cell2::%IX0.0` | %IX0.0 on the controller named Cell2 |
| `Cell2::MAIN.Eye` | the tag MAIN.Eye on Cell2, over a protocol that reads tags by name |

The name is written in the tag, not taken from where the part sits in the scene, so a part says which PLC it talks to
wherever it is moved or copied, and every reader of the tag (the wiring check, each link, the CLIs, the agent tools) sees
the same thing. The separator is `::` because no spelling a link carries uses it: Logix tags have single colons
(`Local:1:I.Data.0`), OPC UA and ADS names use dots.

In the sim a prefixed tag is just another name. `Cell2::%IX0.0` and `%IX0.0` are two tags, so every PLC can start its
I/O at %IX0.0. A controller's name ignores case, as IEC names do, but the sim matches tags exactly, so every place
that writes a name writes it as the controller is known (`spelledAs`), and the wiring check reports one controller
spelled two ways. What the rule changes is who reads and drives each tag:

- **The default controller** carries the tags with no name. A tag that writes its name anyway is kept apart from them by
  the sim, so the Problems dock asks for the name to come off, and the editor writes one typed that way without it. The program here never binds a prefixed tag, and the wiring
  check does not report one as undriven or unread by the program (it still checks the address behind the name, two
  writers on one tag, and a type clash). Assign I/O leaves prefixed tags alone, since it rewrites this program.
- **Any controller runs in the simulator or on a PLC outside it**, the default one included. On a PLC, Play connects
  it beside the simulator's programs or beside the default external PLC (`controller/plcLinks.ts`). Its link is
  derived from the parts as it sees them (`partsForController`): its own tags with the name taken off, so the protocol
  sessions are the same code as the default link's. [`links/linkHosts.ts`](../editor/links/linkHosts.ts)
  `controllerLink` puts the name back on what the PLC writes.
- **In the simulator, a controller runs its own tasks and the program instances on them** (`ControllerTask.plc`,
  core/controller.ts; an instance on no task names its controller itself). This is IEC 61131-3's configuration with
  several resources, each owning its tasks:
  the POUs are one program every controller compiles, so a FUNCTION_BLOCK is shared the way a library is, and each
  controller runs its own instances on memory and I/O of its own. [`plc/controller.ts`](controller.ts)
  `controllerRuns` splits the program: the default controller runs the tasks and instances that name no controller,
  the code outside every POU among them, and another one runs its own from the program with that code blanked
  (`withoutControllerTags`), since those variables and statements are the default controller's alone. Blanked, not
  cut, so a fault on another controller points at the right line. The worker runs one `PlcHost` per controller
  ([`sim/plcGroup.ts`](../sim/plcGroup.ts)), each scan on the same step: another controller reads the tags that name
  it with the name taken off, so its program sees `%IX0.0`, and its outputs go back with the name on. Their
  variables are one watch table, an instance's by its own name (`LineB.Run`), which is unique across controllers, and a
  force or a write goes to the controller that runs the instance it names. A controller with one instance answers
  to its variables by bare name too (`Cell2::Run`), as the default one does. A fault in one stops all of them and
  names the controller. Project tests run the same split
  ([`editor/project/projectTestRunner.ts`](../editor/project/projectTestRunner.ts)), so a line of several PLCs is
  built and proved here before one of them is real, and later handed to its PLC by changing what runs it, with no
  tag touched.
- **What the parts read** has two layers in the worker (`sim/behaviorBus.ts`): the simulated controllers' outputs,
  one table replaced every scan, and the links' outputs, sent from the main thread whenever a PLC writes something new, every link's together
  (`exchangeLinks`). Neither replaces the other, so the program's belts and a named PLC's belts both run.
- **Ownership** is the union: every simulated controller's outputs and every named link's (`setDriven` + `setLinkDriven` in
  `controller/program.ts`). A named link whose port will not open gives its devices back, as the default one does.
- **Each simulated controller has an OPC UA server of its own**, set under its "This simulator" choice in Controller
  Properties, the default controller's like any other. It runs only while that controller runs in the simulator, since
  a PLC outside the app has no program here to publish. Each PLC on a line has its own: on a port of its own, publishing its own program, with a
  client's writes going to that controller ([`controller/plcLinks.ts`](../editor/controller/plcLinks.ts)
  `syncNamedUaServers`). An HMI built against the simulation reaches one endpoint per PLC, so moving to the real PLCs
  changes addresses, not the HMI's structure. The shell keys its servers by window and controller, as it keys links
  (`apps/desktop/opcUaServer.cjs`).
- **The desktop shell** keeps one link per controller in a window (`apps/desktop/linkKeys.cjs`): link 0 is the default
  controller's, a named one is its place in the list. Every call and push carries the number, and the
  renderer's host for a link adds it and filters the pushes (`linkHosts.ts`).

What a controller is belongs to the project, and where it is belongs to the bench
([`editor/store/storePlcs.ts`](../editor/store/storePlcs.ts)). The scene keeps each controller's name, whether the
program here runs it, its protocol and whether Play connects it, so they travel with the project and through a room,
and adding, renaming or removing one is an edit that undoes. Each computer keeps the addresses (an IP address, a port, a
slot) by controller name, and the store merges the two into `state.externalPlc`, which every link reads. A controller
a computer has no address for gets the defaults, on a serving port no other link uses. A scene saved before scenes had
a list derives one as the app did before: the default runs where this computer's settings say, and a named controller
its tags use is listed when this computer had it set up. The first edit of the list writes it into the scene.

When a tag names a controller the project does not list, or one that is switched off, the Problems dock says Play
leaves its tags unconnected, and Controller Properties offers to add it. It also says when a program instance names a
controller that does not run it here (one on a PLC, or one the project does not list), and when a simulated
controller runs no instance. A simulated controller's program is checked against its own tags, as the default one's
is. Project tests run the simulated controllers; a controller on a PLC is not run in a test, so its tags read as
nothing drives them.

Where a person meets it:

- **Simulation > PLC Controllers…** (Controller Properties) lists the controllers in one section, the default first
  with its name, each with what runs it: This simulator or An external PLC. A simulated one lists the program
  instances it runs. A new one gets the first port after the default link's that no link uses, since two links serving on
  one port cannot both listen, and a clash is said on both links. Each folds to its status line, with one
  controller's settings open at a time. **Rename** renames it and rewrites every tag on it as one undo step; the
  computer keeps the address under both names, so the undo finds it too.
- **The Inspector's Controller row** ([inspector/controllerRow.tsx](../editor/components/inspector/controllerRow.tsx))
  shows once the project has a named controller and the part has a tag. It sits above the part's first tag field and
  names the default controller by what runs it (Program, or External PLC). A pick moves every tag of the selection,
  since a device is wired to one PLC. The tag boxes hold the tags without the name. When the part's tags are on
  different controllers the row says Mixed, and each field shows a picker of its own. Typing `Cell2::` in a box works
  too. A named controller's tag gets no suggestions from the program, which does not run it.
- **The Scene tree** names the controller on the rows off the default one
  ([program/controllerBadges.ts](../editor/program/controllerBadges.ts)): a group whose tagged parts all share one is
  named once, and a part inside is named only where it differs from its group. Its filter matches controller names,
  so typing Cell2 lists Cell2's parts.
- **Assign to Controller…** (the Edit menu, the palette and the Scene tree's right-click menu,
  `program/assignController.ts`) rewrites the name on every tag of the selection as one undo step, so a copied cell
  goes to another PLC in one step. A name the project does not list is added in the same step. An agent has
  `assign_controller`, which does the same, `list_controllers`, `set_controller` (what runs one) and `run_instance_on`.
- **The PLC panel's organizer** has a node per controller, each owning its tasks and the instances on them, with "New
  Task on Cell2" ([plc/taskTree.ts](taskTree.ts) `groups`). The default controller's node also holds the code outside
  every POU and what concerns the whole table. The POUs follow, shared by every controller. A PLC outside the app is
  listed with no program. A controller a task names but the project does not list reads "not set up", since nothing
  runs it, and its Set up button opens Controller Properties, which offers to add it. With one controller there is one node, so adding another adds a sibling and moves nothing. **Task Properties** has a Controller choice, which moves the task with
  its instances. In **Program Properties** the Task list is grouped by controller, so picking a task picks the
  controller, with "Every step on Cell2" for an instance on no task.
- **The task that runs the code outside every POU stays on the default controller** (plc/controller.ts
  `plcOfTask`), whatever controller it names. That code is the default controller's own, so on another controller
  it would run nothing. The task tree, Play, Problems and export all follow this one rule, and the Problems dock says
  when a task's own controller is overruled. Task Properties does not offer the move.
- **Limits.**
  - Each controller keeps its own copy of the VAR_GLOBAL blocks. The watch table shows the default controller's
    copy, and a write or force to a global (an HMI's included) goes to the default controller only.
  - In a room, the controller list is one value, so two people adding or renaming controllers at the same moment
    keep only one of the two edits. The parts' tags merge part by part as always.
  - A rename keeps this computer's address for the controller under its new name. On a peer's computer, the
    address stays under the old name until it is entered again.
- **Export is per controller**, since each PLC takes a download of its own ([plc/controllerExport.ts](controllerExport.ts)).
  A controller's file holds its tasks and instances, the POUs they reach (by naming them, followed through calls),
  and every TYPE and VAR_GLOBAL block. The default controller's file also holds the code outside every POU. A POU no
  instance of that controller reaches is left out, and the receipt names it. Each controller node's menu has "Export
  Cell2's Program" as text and as PLCopen XML. Once a table names a second controller, the File menu exports the
  default controller's file and says where the others come from. Gated by `e2e/verify-st-export.mjs`.

Proved three ways. `npm run openplc-loop:cells` ([scripts/openplc-cells-loop.mjs](../../scripts/openplc-cells-loop.mjs))
runs a real OpenPLC as Cell2 beside the program here, one line each on the same addresses, through the link area, the
session and the shell's `plcIo.cjs`, and both lines must behave as the in-process run (CI: job `openplc-loop`).
`e2e/verify-named-plcs-electron.mjs` runs the whole desktop app with two named controllers beside the program, each
a Modbus master on its own port, and then with Cell3 in the simulator running line C with no PLC connected.
`editor/project/projectTestControllers.test.ts` proves two simulated controllers in a project test.

## Analog: a REAL over two registers

Modbus registers are 16 bits, so a REAL (or a DINT) takes two, and the protocol does not say in which order they go.
Each device declares its own. This one puts the **low word first**, because that is what OpenPLC's Modbus master
reads: its plugin converts every 32-bit point with `use_big_endian=False`. A one-off probe against the real runtime
confirmed it (recorded at `modbusPointFor` in `src/core/io/externalIo.ts`): served 12.5 as a float32 pair, `Speed AT
%ID100 : REAL` computed `Speed * 2.0` and wrote back 25.0. The check that runs each time is `openplc-loop`'s "the
speeds it commanded arrived as REALs" (below).

So a double word travels: `%IDn` is the register PAIR `2n, 2n+1`, which is exactly the two words the same
double word covers in IEC memory. An overlap between a word and a double word is therefore a real
conflict. The wiring check reports it as an error before any link runs (it shows in the Problems dock and
`npm run check-wiring`), and the link itself carries only the first of the two tags and lists the other as a
problem, rather than letting both fight over one register. When the simulator polls a register image
(a PLC that serves), a bit sits inside a register too, so a bit and a word on one register conflict the same way
there; the poll table reports that one. OpenPLC keeps bits and words in separate tables, so the wiring check
does not flag it everywhere. Bytes (`%IB`), 64-bit values (`%IL`) and memory (`%M`) do not travel.

`npm run openplc-loop` proves it end to end and BEHAVIOURALLY: a laser measures the box's distance into `%ID100`,
the PLC commands the belt's speed back through `%QD100`, and the belt has to creep from the moment the laser
measures a box within a metre (`CREEP_WITHIN_M` in `scripts/lib/conveyor-loop.mjs`). The PLC must stop the belt
within 500 ms of the eye (`MAX_REACTION_MS`), and the box must come to rest within 0.15 m of where it does
in-process (`MAX_POSITION_DIFF_M`). Every speed the PLC commands must be one of the two the program writes, which a
mangled float would not be.

**A point the PLC has not polled yet reads zero.** Its first scan runs before its master's first poll, so
an analog input is 0 for a scan or two after start, and 0 looks like a plausible measurement. A latch
fed straight from one fires on that first scan and stays latched. This does not happen in-process (the
image is loaded before the first scan), so only a real PLC shows it. The openplc-loop program guards for it with
`BoxRange > 0.0`.

## Getting a scene onto I/O points: Assign I/O

A part's PLC tag holds either a program name (`Eye`) or an I/O point (`%IX100.0`), and only the second travels
to a controller outside the simulator. **Assign I/O** (right-click Top-level code in the PLC panel's organizer, the
Simulation menu, or the command palette) moves a scene
from one to the other in a single edit ([`ioAssign.ts`](ioAssign.ts) plans and rewrites the program,
[`editor/program/ioAssign.ts`](../editor/program/ioAssign.ts) rewires the parts): each tag a part is wired to by name gets an
address, the program declares it there as a located variable (`Eye AT %IX100.0 : BOOL`), and every part wired
to that name is pointed at the address. It is **one undo step**, because a scene half-way through the change would
run a program driving names no part carries any more.

The addresses are deterministic, so the same scene assigns the same points on any machine: bits from `%IX0.0` /
`%QX0.0`, words from `%IW0` / `%QW0` and double words from `%ID50` / `%QD50`, skipping anything already taken, in
the program's declaration order and then the scene's. Bits and words start where OpenPLC's Editor (4.3) puts a new
remote device's first points (an IO group's points are numbered from `%IX0.0` / `%IW0` whatever its Modbus offset),
so a program assigned here runs on OpenPLC with the same addresses; the published guide at `/guides/modbus/` follows
exactly that, and `e2e/guide-modbus.mjs` clicks it through the real Editor. A scene already assigned under the
`%IX100.0` / `%IW100` / `%ID100` base (OpenPLC v3's slave-device base, which the v4 Editor does not use) keeps its
addresses, and Assign I/O fills in around them. A part publishes its value, so it is the PLC's **input** (`%I`); a
part driven by the PLC reads its **output** (`%Q`). A BOOL takes a bit, a whole number a word and a REAL a double
word; the double words start at register 100, so a hundred words fit below them without aliasing. (OpenPLC's Editor
cannot map a REAL across two registers at all; the guide says so.) That is for a PLC that polls; with "The simulator
polls the PLC" chosen, points are packed from the PLC's server device instead (the client section above).

**Export I/O List** writes the points this scene serves, as `Tag,Address,Type,Direction,Modbus
point,Device`. It is the document whoever wires the panel works from, with the part and parameter on each
point named in the last column. It lists POINTS, so a part still wired to a program NAME is not a row (Assign
I/O is what gives it one), and `Tag` is blank where the program declares nothing at that address: the address
is what travels, the name is a courtesy to the reader. **Import reads its own output unchanged**, which is
pinned by a test rather than assumed.

**Import I/O List** is the same edit with the addresses given rather than chosen: a CSV of tag names against
addresses (the list a controls engineer already has), in any column order, comma, semicolon or tab separated.
A row is refused, with its line number, rather than applied when its address is malformed, is memory (`%M`) or
64-bit, contradicts the part's direction, does not fit the declared type, collides with another row, or names
a tag neither the program nor the scene uses. The program keeps its names either way: the name stays the
point's symbol, which is what the Inspector shows beside the address and what the export carries.

What neither command touches: a PROGRAM's inputs and outputs (`Main.Run`: IEC cannot locate one), a constant,
and anything that cannot travel
(an array, a string, a byte or a 64-bit value). Each is reported by name with the reason instead of being
changed.
