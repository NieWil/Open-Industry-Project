# PLC typed storage - a controller's memory as one typed arena

> Every program runs on the `typed` engine. The AST walker is its reference and its fallback.
> Related: [typed/](../src/plc/typed/) (layout, arena, POU, blocks, compiler), [scanCodegen.ts](../src/plc/scanCodegen.ts)
> (the generator), [interpreter.ts](../src/plc/interpreter.ts) (the walker, `compile`), [pou.ts](../src/plc/pou.ts)
> (the `Pou` interface both engines implement), [scanEngineOracle.ts](../src/plc/scanEngineOracle.ts) (the oracle).

## Why

A real controller's memory is a fixed, typed tag image: every tag at an offset decided when the program is built, a
DINT four bytes that cannot hold anything but a DINT. Values stored as JS records keep their declared form only by a
rule: every writer coerces on the way in, and generated code trusts the rule (it reads a BOOL without `bool()`, and
stores a DINT read into a DINT without a coercion). A typed arena makes it a property. An `Int32Array` slot cannot hold
3.7, 2^40 or `true`, and a `Float32Array` slot is single precision by construction.

It also gives a controller's state as one buffer (cheap to copy, transfer, compare), and the shape a native port or a
WASM backend would read and write directly.

The arena is also faster than the same generated code over JS records, because typed views skip boxing and
the generator leaves out coercions a type already proves. `npm run bench-sim` measures it on a real line (the
fingerprint must not move), and [scanSpeed.test.ts](../src/plc/scanSpeed.test.ts) holds floors for the
typed:walker ratio.

## The engines

| engine | storage | role |
|---|---|---|
| `typed` | the arena | every program, by default (`compile`) |
| `walker` | JS records (`buildPou`) | the reference and the fallback, with no expiry |

**The walker stays on JS records on purpose.** The danger particular to an arena is silent corruption: a wrong offset
or a wrong stride writes a neighbour, and nothing throws. If both engines read one layout, a layout bug corrupts both
alike and the oracle sees nothing. Kept on records, the walker is an independent implementation, so the oracle turns a
layout bug into a difference on the first scan that touches it.

- Both engines implement `Pou` ([pou.ts](../src/plc/pou.ts)); the program builders (`implicitProgram`,
  `configuredProgram`) speak only to a `Pou`, so they are shared.
- The typed engine has no per-node fallback (the walker reads records). A construct its generator cannot write refuses
  the whole program (`TypedUnsupported`), never runs part of it. `compile` then builds it on the walker, says so once,
  and records why (`typedRefusals`). A host that will not evaluate generated code also gets the walker. No program this
  repository compiles is refused (the engine tests assert both lists stay empty).

## The arena

One `ArrayBuffer` per compiled program, sized when it is compiled (a program's shape never changes after; an edit is a
new compile, and values cross by name). Eight views over it: `I8 U8 I16 U16 I32 U32 F32 F64`. Addresses are byte
addresses, and an access is `I32[(addr) >> 2]`. **The first 8 bytes are a guard no place occupies**, so an address that
lost its base reads and writes the guard, not a variable. Without the guard, with the globals at address 0, a bug of
exactly that kind, planted on purpose, passes silently.

| declared type | view | size / align |
|---|---|---|
| BOOL | U8, 0 or 1 | 1 |
| SINT | I8 | 1 |
| USINT, BYTE | U8 | 1 |
| INT, enumerations (an INT at run time) | I16 | 2 |
| UINT, WORD | U16 | 2 |
| DINT | I32 | 4 |
| UDINT, DWORD | U32 | 4 |
| REAL | F32 | 4 |
| LREAL, TIME, DATE, TOD, DT | F64 | 8 |
| STRING[n] | U16: the length, then n UTF-16 code units | 2 + 2n, align 2 |

- **Strings live in the arena.** A side table of JS strings would read faster, but an aggregate holding a string would
  span two address spaces, and a copy, a clear and a field address would each need both. In the arena a STRING is its
  length (the U16 at its address) and its code units (the one at `+2+2i`).
- **BOOL is a byte**, read `!== 0` and written `? 1 : 0` in generated code. Every surface outside the scan (watch,
  memory, get, ports) answers `true` / `false`, as `TagValue` promises.
- **The coercions do not disappear.** An integer view stores modulo its width, but IEC narrows a REAL by
  round-half-even, and refuses a value that does not fit: the store rules ([pou.ts](../src/plc/pou.ts)
  `coerceScalar`, `fits`) still run before a value reaches a slot. What the arena removes is the possibility of a slot
  holding something its type cannot, which is what lets the generator leave out every coercion a type already proves.

## Layout

Computed once per definition ([typed/layout.ts](../src/plc/typed/layout.ts)), from the checked program:

- **A struct**: its fields in declaration order, each at the next offset aligned to its own alignment; the struct's
  alignment is its largest field's, and its size is rounded up to it (so an array of them strides cleanly).
- **An array**: elements contiguous, row-major, stride = the element's size. Multi-dimensional arrays are one block.
- **A POU** (PROGRAM, FUNCTION_BLOCK, FUNCTION): laid out as a struct of its declared variables (a VAR_EXTERNAL owns
  no storage). A user function-block instance is a region of its holder of the block's size; its body is generated
  once per definition (`TypedFb`) and handed the instance's base address. Every body any POU can reach is generated
  when the program is compiled, so a refusal is the program's, never a scan's.
- **The globals**: one region, first after the guard. **A CONFIGURATION**: each program instance a region.
- **A standard block** (TON, TOF, TP, R_TRIG, F_TRIG, CTU, CTD, CTUD, SR, RS): a record of its outputs, in the order the
  walker's objects list them, then its private state, hidden (a TON's `Q`, `ET`, then whether it runs and when it
  started), then the inputs it keeps for a call that leaves them out, hidden too (a TON's `IN` and `PT`). An input
  the block already keeps as an edge's previous value (a trigger's `CLK`, a counter's `CU`) has no field of its own.
  The ten blocks are re-implemented over the arena ([typed/blocks.ts](../src/plc/typed/blocks.ts)); runtime.ts's
  objects remain the walker's, so the oracle compares two implementations of each.
- **A FUNCTION**: one region per definition, reused by every call (never live twice: recursion is refused when
  compiled). When every initial value is a literal, the region's starting bytes are kept after the first call and
  copied back on each (one `U8.set`, because resetting through the initialisers makes function-heavy code slower than
  generated code on records). A positional call whose inputs and result all hold their values is written out at the
  call site: the arguments evaluated, `enter()` (the reset), each one stored into its input's slot, `exec()`, the
  result read. A formal call, or one with a whole array or struct input, goes through the runner's argument list. A whole array or struct result is copied into a region of the call site's own, found by a walk of the program
  before the arena is made ([typed/calls.ts](../src/plc/typed/calls.ts)), so `Total(MakePt(1), MakePt(2))` holds two
  results at once. A call site that walk missed is refused, not run wrong.
- **VAR_IN_OUT** (a function block's): a scalar is copied in and back out, as the walker does. A whole array or struct
  is bound by reference: its slot holds the caller's address (U32), with a hidden zeroed copy of its own that it starts
  pointing at, as the walker's starts at a zeroed value of its own, so an unbound one reads zeros.

### Object orientation

METHOD, EXTENDS, INTERFACE and REF_TO (docs/st-conformance.md, "Object orientation and references") add four rules to
the layout, each chosen so that nothing else in it moves:

- **A derived block is its base's layout with more after it.** Its variables are the inherited ones first (the root
  class's, then each class down; program.ts `fbDecls`), so every inherited variable sits at the offset the base class's
  own code addresses it at. A method a class inherits is generated again for each class that has it (`TypedFb.method`).
  Its THIS, and every method it calls on THIS, resolve against the instance's own class, so an override applies with
  no table at run time.
- **An object-oriented instance carries its class's number first** (`#class`, a hidden U32; program.ts `classIds`):
  every block that derives, is derived from, implements an interface or has a method, and so a whole
  hierarchy alike. A call through an interface or a dereferenced REF_TO (`r^.M()`) reads it and indexes a table of the implementations
  (`TypedScope.dispatch`). A block that takes no part in object orientation has no such field, and its layout is
  unchanged.
- **A REF_TO and an interface are a U32 address.** A reference holds the address of the place it refers to (0: NULL,
  which faults where it is dereferenced: `refAt`), an interface the address of its instance (0: none: `ifaceAt`). `r :=
  REF(place)` stores the place's address, `r := r2` copies r2's slot as it is (0 too), `r <> NULL` reads the slot. Both
  start at 0, are not tags, and are left out of the watch, the memory and `deepMemory`.
- **A method's own variables are a frame on a method stack**, not a region of their own. One call is one frame, so a
  method may call itself (each call keeps its temporaries apart, as on a controller). The stack is a region of the arena
  sized for `MAX_CALL_DEPTH` frames of the largest method (runtime.ts; deeper nesting faults the scan, the walker
  counting the same calls). A frame lays out its parameters first, then its result, then the rest (program.ts
  `methodDecls`). Every implementation of one signature has them at the same offsets, so a call through an interface
  stores its arguments without knowing which implementation will run. Its body is generated as `(b, now, m)`: the
  instance at `b`, the frame at `m`. The stack is emptied at the start of every scan, since a fault leaves a scan where
  it stood. A method's whole array or struct result is copied, before its frame is given back, into a region of the
  call site's own, as a FUNCTION's is (typed/calls.ts).
- **An ARRAY of an interface** is an array of those U32 addresses (`ScalarLayout.pointer`).

The walker keeps its own model of each (interpreter.ts): an instance records its class (`UserFb.def`), a method runs as a
POU of its own over the instance's variables (`instanceStore`), a re-entrant call gets a POU of its own, and a reference
is a `RefCell` (the record holding the place and its key, or 0 for NULL). So the oracle compares two
implementations of each rule, not one read twice.

## The watch table

The editor reads a running program's values from a copy of the arena, not from a table built out of it
([core/watchTable.ts](../src/core/watchTable.ts)).

- **The plan.** `CompiledProgram.watchPlan()` lists where each value of `watch` is: its key, its byte address and the
  view it is read through, in the order `watch` lists them. It is made once per compiled program from the same walk
  `watch` takes (`placesInto`), so the two cannot list different keys. The walker has no plan.
- **The frame.** The sim worker sends the plan's layout once per attached program and a copy of the arena at
  `WATCH_HZ` (sim/worker.ts `plcFrame`). The copy is handed over, not cloned. On a program of 577,725 values the
  arena is 8.8 MB and copies in 0.4 ms. Its table took 215 ms to build and 100-250 ms to receive.
- **The table.** The sim client wraps layout and bytes in a Proxy (`memoryTable`) that reads a value from its
  address when asked. A reader sees the `Readonly<Record<string, TagValue>>` it always did, and each table is the
  moment its bytes were copied.
- **Arrays too long to list.** An array of more than `WATCH_ARRAY_MAX` elements is not among the keys. The layout
  carries it as a range: its key, its address and its shape (`WatchLayout.ranges`). The table answers one of its
  elements by name (`table['Big[700]']`, `'Recs[900].Ok' in table`), in any case, from the shape. A reader that
  looks names up in its own index of the keys asks `watchElementKey` when the index misses. The elements are never
  listed, so nothing that walks the keys pays for them. A table that travels as an object does not hold them.
- **Where a table still travels.** A program on the walker, and several simulated controllers in one run (their
  tables are merged by name).

Listing a Proxy's keys with `Object.keys` or a spread is slow at that size, since the engine checks the list. Code
that lists a table's keys, copies it or counts it uses the helpers in core/watchTable.ts (`watchKeysOf`,
`forEachWatchValue`, `watchKeyCount`, `overlayTable`, and `withWatchValue` in core/watchKeys.ts). What is derived
from the keys alone is kept per key set (core/watchKeys.ts), not per table.

## Verification

1. `npm test`: the oracle compares the walker against the typed engine on the conformance corpus,
   the demo and targeted programs. It compares every scan and everything each engine holds, including the inside of
   every function block instance (`deepMemory`, which catches a stray write into an array of block instances), with
   random writes between scans. Every value must be in its declared type's form (`inForm`, against `memoryTypes`). A
   refusal is a failure there.
2. The layout validator ([typed/typedEngine.test.ts](../src/plc/typed/typedEngine.test.ts)): every place of every
   layout the corpus produces lies inside its holder, aligned, overlapping nothing.
3. The speed gate ([scanSpeed.test.ts](../src/plc/scanSpeed.test.ts)): the typed:walker ratio on four program shapes,
   each floor measured to fail with the optimisation it guards switched off.
4. The shape gate ([scanShape.test.ts](../src/plc/scanShape.test.ts)): what the speed gate cannot separate from noise.
   V8 inlines helper calls only up to a budget per function, so in a long body a helper call can stay a real call. The
   generated source is checked for a subscript read from storage being checked in place (not through `ix()`), a
   positional FUNCTION call having no argument array, and a block input that its type already proves going in
   uncoerced.
5. `npm run bench-sim` on a real line: the fingerprint must not move across an engine change.
6. The watch plan ([watchPlan.test.ts](../src/plc/watchPlan.test.ts)): for every program of the corpus, after every
   scan, the table read from a copy of the arena through the plan is the table `watch` builds, key for key in order.
7. The size budget ([largeWatchBudget.test.ts](../src/editor/program/largeWatchBudget.test.ts)): on half a million
   values, the readers index a program's table once and the wiring check reads it once.

These checks fail on each layout bug they exist for: wrong strides, addresses without their base, an in-out read
without its dereference, an unbound in-out at address 0, aggregate inputs copied the wrong way, results sharing the
function's region, and a standard block's edge or end a scan off. For object orientation they fail on dispatch
through an interface fixed to one class, instances without their class number, an unbound reference that does not
fault, a method keeping its temporaries, and THIS ignoring an override. Frames never given back to the method stack
are caught by the "the method stack" case in typedEngine.test.ts, which makes more calls in a scan than the stack
holds frames.
