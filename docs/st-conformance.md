# ST conformance: what this engine is, and what it is not

This document explains the subset. The published lists are generated: `npm run capabilities` probes the live
compiler and writes [public/st-capabilities.json](../public/st-capabilities.json) for agents and
[plc/index.html](../plc/index.html), served at `/plc/`, for visitors (it covers ladder too, see
[ladder.md](ladder.md)). Every verdict in them comes from `compile()`, and CI fails if either is stale
(`npm run capabilities -- --check`), so where they disagree with this file, they are right.

oip-web runs a **subset of IEC 61131-3 Structured Text**. It is not a compliant implementation and does not
claim to be: there is no compliance statement against the standard's feature tables and no PLCopen
certification, and the missing parts of the configuration layer (below) mean base-level ST is not complete.

The claim it makes is narrower and checkable: **within the subset, a program behaves the way a real IEC
runtime would**, so ST written against the simulator mostly or fully copy-pastes onto a physical PLC. This
document is the ledger behind that claim: the subset boundary, the divergences, and how each is checked.

## How the claim is checked

| Layer | What it proves | Where |
|-------|----------------|-------|
| Unit suite | Behaviour of each language feature | [src/plc/plc.test.ts](../src/plc/plc.test.ts) |
| Golden corpus | Expected values derived by hand from IEC 61131-3 and checked against the open-source oracles below, never taken from running our own engine | [src/plc/conformanceCases.ts](../src/plc/conformanceCases.ts) |
| Differential | The AST interpreter and the ST→TS emitter agree scan-for-scan, so "shown == executed" | [src/plc/conformance.test.ts](../src/plc/conformance.test.ts) |
| **External oracle (2nd ed.)** | The goldens themselves are right: the corpus is replayed through MATIEC (`iec2c`), a real IEC compiler | [scripts/oracle-matiec.mjs](../scripts/oracle-matiec.mjs), [.github/workflows/st-oracle.yml](../.github/workflows/st-oracle.yml) |
| **External oracle (3rd ed.)** | The edition boundary: a 3rd-edition compiler builds what MATIEC refuses only for being old; with `--execute`, every case it compiles is built with g++, run scan by scan and diffed against the goldens, its known gaps listed in `RUN_GAPS` | [scripts/oracle-strucpp.mjs](../scripts/oracle-strucpp.mjs), [src/plc/oracleStrucpp.ts](../src/plc/oracleStrucpp.ts) |
| **External oracle (interchange)** | Every exported document is valid against PLCopen's own TC6 schema | [scripts/oracle-plcopen.mjs](../scripts/oracle-plcopen.mjs) |
| **External oracle (import)** | Real files this project did not write go through both importers, and nothing may vanish in silence | [scripts/oracle-import.mjs](../scripts/oracle-import.mjs) |
| **External oracle (OpenPLC editor)** | OpenPLC's own editor reads each export, regenerates ST, builds it, and the result must replay to the goldens | [scripts/oracle-openplc.mjs](../scripts/oracle-openplc.mjs) |

The first three are internal consistency: necessary, but they cannot catch a golden that is confidently wrong.
The MATIEC oracle can, in two tiers, both blocking in CI:

- **Tier 1, compile gate.** Every case is rendered as a spec-legal IEC program (`PROGRAM` + `CONFIGURATION` +
  `RESOURCE` + `TASK`) and fed to `iec2c`. A program our engine accepts but a real compiler rejects is a
  portability defect. Cases marked `rejects` invert the verdict: MATIEC accepting one would mean our strictness
  invented a rule the standard lacks.
- **Tier 2, semantic diff.** The generated C is built and stepped with the corpus inputs, and the variable image
  is diffed against the goldens: a wrong answer rather than a wrong program. A case with a `divergence` note is
  reported against that note rather than failed.

Run it with `npm run st-oracle` (needs `iec2c` on PATH or `IEC2C=`), or `npm run st-oracle:dry` to render the
programs with no toolchain. On Windows, [scripts/oracle-wsl.sh](../scripts/oracle-wsl.sh) builds CI's pinned
compilers (MATIEC is `beremiz/matiec` at a commit) inside WSL and runs them against the working tree:
`wsl -u root -- bash scripts/oracle-wsl.sh all` (or `--execute` / `ed3 --execute` for one of them).

Tier 2 depends on the shape of `iec2c`'s output, pinned by [oracleShape.test.ts](../src/plc/oracleShape.test.ts)
against excerpts of real generated files: the instance type's `_data__` suffix, `POUS.c` textually included,
every variable in a `{value, flags}` record, a `TIME` as a `timespec`. The harness supplies the symbols MATIEC
leaves to the embedder (`iec_lib_*`, and `_____time_*`, emitted for `+`/`-`/`*` on `TIME` but declared nowhere),
and includes libc before MATIEC's `iec_std_functions.h`, whose macros (`__acos`, `__sqrt`, ...) clash with
glibc's `<math.h>`; MSVC cannot show that clash, so the unit test asserts the order.

A case the oracle cannot be fed carries an `oracle: { skip }` note saying why.

### Oracle coverage

`oracleCoverage` in [public/st-capabilities.json](../public/st-capabilities.json) (computed in
[scripts/capabilities.mjs](../scripts/capabilities.mjs) over the replayed, non-`rejects` cases) reports which of
the subset something other than us has agreed with, in two grades: executed by a real runtime, and
`compiledOnly` (`BCD_TO_INT` / `INT_TO_BCD`, see [BCD](#bcd-the-standard-disagrees-with-itself)). Cases where the
choice of input is the point:

- **`R_TRIG` / `F_TRIG` from a high cold start.** A cold `F_TRIG`'s scan 1 is divergence 3, so that case is
  withheld; a companion starting `CLK` high replays externally (IEC's `NOT CLK AND NOT M`, `M` FALSE, is FALSE on
  scan 1 there, and from scan 2 both reduce to `Q = NOT CLK AND CLK_prev`). `R_TRIG`'s scan 1 is a rising edge.
- **`SR` / `RS`** walk one sequence; the tie (both inputs true) is the scan under test.
- **`LREAL`**: `0.1 + 0.2` at both widths separates binary64 from binary32.
- **`DWORD`**: JS bitwise operators coerce to signed int32, and `BYTE` / `WORD` never reach the sign bit.
- **`SEL` / `MUX`** at both ends and the middle of the 0-based index.
- **Operator functions** (`ADD` `SUB` `MUL` `DIV`, the comparisons, `MOVE`) agree on both compilers;
  `GT(3, 1, 2)` is FALSE, pinning the chain rule.
- **Transcendentals** at known answers; `LOG` (base 10) and `LN` are tested at 100, where they give 2 and 4.6.

### Editions: MATIEC and STruC++

**MATIEC is a 2nd-edition compiler.** The 2nd edition has no implicit conversions, so MATIEC refuses `INT + DINT`
and every widening store, which the 3rd edition defines. Those cases carry `oracle: { editionReject }`, inverting
tier 1's verdict, so the gate does not report the oracle's age as a bug in the subject.

**STruC++** (the ST→C++ compiler OpenPLC's editor ships) is 3rd edition: `npm run st-oracle:ed3` (locally
`wsl -u root -- bash scripts/oracle-wsl.sh ed3`). Every `editionReject` case must build under it, so the verdict
is mechanical:

| | verdict |
|---|---|
| both reject | our defect |
| MATIEC rejects, STruC++ builds | an edition difference, recorded |
| MATIEC builds, STruC++ rejects | usually a gap in the younger compiler |

MATIEC is the strictness oracle. STruC++ is not: at v0.6.2 it accepts programs we refuse, including a missing
statement separator and an assignment to a `FOR` control variable. So the ed3 gate reports leniency rather than
failing on it. Its coverage gaps (no `CONTINUE`, no `n(x)` array repetition) are listed in the script with the
version observed, and the run says if one stops being seen.

**`--execute`** (`npm run st-oracle:ed3 -- --execute`, locally `oracle-wsl.sh ed3 --execute`) builds every case
STruC++ compiles with g++ against its release's runtime headers, steps it with the corpus inputs and diffs it
against the goldens ([src/plc/oracleStrucpp.ts](../src/plc/oracleStrucpp.ts)). Its scheduling is the driver's own
(ticks numbered as MATIEC's harness numbers them, tasks due together by IEC priority), so a task-order case checks
the generated code, not an OpenPLC runtime. STruC++ 0.6.2's gaps are in `RUN_GAPS`:

- reported compiled but the C++ does not build: BCD and calendar functions it never declares, string functions
  given a literal, string ordering, a type used before its declaration, some object-oriented forms;
- different answers: `REAL_TO_INT` rounding a tie away from zero (pinned at every integer width and from
  `LREAL`), `NOT` of an integer literal as a logical NOT, `CTD` / `CTUD` counting on the falling edge of `CD`, a
  PROGRAM's array and expression-valued `CONSTANT` losing their starting value (a function block's and a
  FUNCTION's keep theirs), `DATE - DATE` as days, a calendar value printed as its count, and a PROGRAM with no
  task put on the first task.

These are gaps in what OpenPLC's newer editor builds, not in this engine, so the engine keeps its answers and the
export warns where a program meets one (`export.ts` `strucppWarnings`, "OpenPLC v4 (its compiler, STruC++
0.6.2)"), with what to write instead. Each cause is pinned by a small variation beside a control that builds. Also
warned: `REF()` of a struct or block, `NULL` on the left of a comparison, a METHOD call leaving an output unbound,
and a METHOD called on an instance named like its block type. **Not warned**: a FUNCTION_BLOCK or STRUCT named like
a POU STruC++ bundles from OSCAT basic and its other libraries. Those are GPL, so the app ships no copy of their
names; the oracle reads them from the installed release each run into its gitignored
`.oracle-ed3/library-names.txt`. The OpenPLC editor oracle is a separate question: it checks the editor's rewrite,
not what STruC++ makes of it.

**Neither compiler takes a sized `STRING` variable**, a compiler limitation, not a portability defect.
`VAR s : STRING[16];` is the standard's spelling (`single_byte_string_var_declaration ::= var1_list ':'
single_byte_string_spec`), and MATIEC parses it, but its `search_base_type.cc` has no visitor for
`single_byte_string_spec_c`, so every use reports "Variable not declared in this scope". STruC++ 0.6.2 rejects the
spelling. A `TYPE Str16 : STRING[16]` hoist is no workaround (MATIEC's `simple_specification` does not admit a
string type name). So the renderer emits what the author wrote, the corpus uses unsized `STRING` wherever capacity
is not the subject, and the one capacity case is withheld from both oracles with the diagnosis.

### BCD: the standard disagrees with itself

This engine has the signed pair `BCD_TO_INT` / `INT_TO_BCD`. IEC's normative conversion table defines BCD over
unsigned integers only (`BCD_TO_USINT` / `_UINT` / `_UDINT` and reverses; packed BCD has no sign, which is why the
encoder returns 0 for a negative input), and MATIEC implements that set, rejecting `BCD_TO_INT` as a syntax error.
The informative Annex F uses the signed spelling (`WEIGH`: `INT_TO_BCD(BCD_TO_INT(gross_weight) - tare_weight)`;
`GRAVEL` likewise), which is the pairing [builtins.ts](../src/plc/builtins.ts) implements; the
[import oracle](../scripts/oracle-import.mjs) replays both files, and MATIEC fails on its own vendored copy.
STruC++ 0.6.2 builds the case. So it is an `editionReject`, checked both ways on every push. This engine does not
provide the unsigned names, so no single BCD spelling compiles both here and on a strict 2nd-edition toolchain:
**a program bound for such a toolchain needs its BCD calls changed to the unsigned names by hand.**

### Interpreter and emitted TypeScript

The differential layer holds the interpreter and the emitted TypeScript ([emit.ts](../src/plc/emit.ts)) to the
same answers, so the emitted module calls runtime helpers wherever JS would differ:

- BOOL `AND` / `OR` through `andB` / `orB`, which evaluate both operands (divergence 11); `XOR` stays an
  operator, and a bit-string `AND` / `OR` combines every bit.
- Subscripts through `elemAt` / `elemSet`, with the bounds and the interpreter's message. An indexed place is
  never a JS lvalue: the last index goes through `elemSet`, earlier ones through `elemAt`, in `assignPlace`'s
  order, covering all three store sites (assignment, `VAR_IN_OUT` copy-back, output binding).
- A subrange store through `inRange`, after the width coercion and before the store, mirroring `checkRange`.
- `WHILE` / `REPEAT` past `MAX_LOOP_ITERATIONS`, and `FOR ... BY 0`, fault. The cap lives in `runtime.ts` so both
  backends count to the same number; `loopGuard` and `forStep` carry it into the emitted module.

The emitted TypeScript is an export and teaching artifact, not the execution path. Checks that cannot go to an
external compiler (an out-of-range store is undefined behaviour in C; a runaway loop hangs the replay binary) are
pinned on the helpers in `builtins.test.ts` and on the emitter in `plc.test.ts`, as is the side effect of a call
on the decided side of an `AND` (it needs a FUNCTION reaching a global, permissiveness 1). A corpus case whose
golden is a fault reaches the external run by shape: `npm run st-oracle` reports "expected 0 scan lines, got 1"
against its `divergence` field and stays green.

### Object orientation and references: METHOD, EXTENDS, INTERFACE, REF_TO

IEC's 3rd edition put methods, interfaces and inheritance on function blocks, and added references (`REF_TO`).
They are implemented in the checker, both scan engines and the emitted TypeScript. MATIEC refuses all of it, so
every OOP case is an `editionReject`; STruC++ 0.6.2 builds each case but the interface variables and the gaps below,
and `--execute` runs what it builds. Interface variables are checked in-process only.

**The engine implements a subset of IEC 61131-3, a subset of the PLCopen motion function blocks and the PLCopen XML
2.01 exchange format. It is not certified. A vendor is a connection target, never the specification.** So vendor
extensions are refused by name, each message naming the IEC form:

| Refused | Message says |
|---|---|
| `PROPERTY` (GET / SET) | not part of IEC 61131-3; use a METHOD (or a pair of methods) |
| `VAR_INST` | not part of IEC 61131-3; declare the variable in the FUNCTION_BLOCK's VAR, where it keeps its value between calls |
| `REFERENCE TO`, `REF=`, `__ISVALIDREF` | not IEC 61131-3; declare `REF_TO`, give it `REF(place)`, dereference with `^`, compare with `NULL` |
| `THIS^` | IEC writes `THIS.x`, `THIS.Method()` |
| `POINTER TO` | not IEC 61131-3; use `REF_TO` |
| `AND_THEN`, `OR_ELSE` | not part of IEC 61131-3; use nested IF statements, or `AND` / `OR` (which evaluate both sides) |
| `TYPE B EXTENDS A : STRUCT` | a STRUCT cannot EXTEND another: IEC 61131-3 derives only function blocks and interfaces; declare the base's fields in the struct, or hold the base as one field |

**THIS and SUPER**: `THIS` with no `^` (`THIS.x`, `THIS.M()`), `SUPER` with one (`SUPER^.M()`, `SUPER^()`), the forms
STruC++ reads; it refuses `THIS^.x` and `SUPER.M()`.

**Semantics, as the goldens pin them:**

- A METHOD's own variables are temporary: they start from their declared values on every call, an omitted input at
  its initial value. The block's variables are in scope beneath them; `THIS.x` reaches one a method variable hides.
  A method may call itself; nesting past 64 calls faults the scan (`MAX_CALL_DEPTH`).
- A call on THIS, or by a method's bare name, runs the instance's class's implementation, so a base method calling
  `Gain()` runs the override. `SUPER^.M()` runs the base's; `SUPER^()` runs the base's body on this instance. A
  derived block runs its own body only (STruC++ generates the same).
- An interface variable refers to an instance or to nothing (`itf <> NULL`, or `<> 0`); a call through nothing
  faults the scan.
- A `REF_TO` starts `NULL` and is given `REF(place)`, another reference (`NULL` included) or `NULL`, by assignment
  or as a block's or method's input. `^` reaches the place: `r^ := r^ + 1`, `p^.id`, `a^[i]`, `drive^.Gain()`
  (dispatched on the referred instance's class). It compares with `NULL` (`r <> NULL`, `NULL = r`). `REF()` takes a
  place of exactly the referred type (or a derived block's instance): not a CONSTANT, an expression, a block's
  output, or a temporary of a method or function the reference outlives. Dereferencing `NULL` faults the scan ("a
  REF_TO that is NULL was dereferenced"); STruC++'s runtime stops the POU the same way.
- A method may return a whole structure or named array, by value; an ARRAY of an interface is allowed.

**Refused by name:** `CLASS`, `NAMESPACE` (PLC code instantiates function blocks, not classes), a reference or an
interface in a struct field, a FUNCTION declaring a reference, a method returning one, an `ARRAY OF REF_TO` (IEC
allows it; keep the references as variables of their own), and comparing two references (compare each with
`NULL`). ABSTRACT, FINAL, OVERRIDE and the access words are enforced. A method named after a standard function
(`ADD`, `MOVE`) is refused, since a target may read it as the function; export warns about `R` and `S` (the IL
set/reset operators) as names. Object orientation is not portable to
targets whose ST has none.

**STruC++ 0.6.2 limits, each warned on export:** interfaces only as signatures (it refuses assigning an instance to
an interface variable, "Cannot assign BELT to IDRIVE", and crashes when one is a block input), so interface cases
are withheld from it; no `REF()` of a whole struct or block ("no matching function for call to REF(S&)"), no
`NULL <> r`, no `r^.M()`. It builds `REF_TO` an elementary type, `REF()` of an array element or field, a `REF_TO`
input given `REF()`, a reference or `NULL`, and `r <> NULL`.

**In PLCopen XML**, methods, inheritance and interfaces travel in TC6's `addData`, declared in the file's
`addDataInfo`; each `<data>` holds one element in the namespace `http://www.openindustryproject.org/plcopenxml`,
with code carried as its ST:

| `<data name=...>` (under `http://www.openindustryproject.org/plcopenxml/`) | where | holds |
|---|---|---|
| `functionblock` | the POU's `addData` | `<functionBlock extends="Base" implements="IA,IB" abstract="true" final="true"/>`, each attribute only when it applies |
| `method` | the POU's `addData`, one per METHOD | `<method name="Run">METHOD ... END_METHOD</method>`: the method's ST, access words and all |
| `interface` | the project's `addData` | `<interface name="IA">INTERFACE IA ... END_INTERFACE</interface>` |

Exported documents still validate against TC6 (free-form `addData`). The importer also reads the addData form
other tools write (`http://www.3s-software.com/plcopenxml/` names, members as elements), which the export never
writes. A `REF_TO` is TC6's `<pointer><baseType>...</baseType></pointer>`. The export does not translate IEC into a
vendor dialect. A file's `PROPERTY` is left out on import with a note.

## The subset

**Supported.** `IF`/`ELSIF`/`ELSE`, `CASE` (single, list, `lo..hi` range and negative labels), `FOR`/`BY`, `WHILE`,
`REPEAT`, `EXIT`, `CONTINUE`, `RETURN`; user `FUNCTION_BLOCK`s, called with named inputs (`IN := x`) and output
bindings (`Q => y`), with METHODs, EXTENDS and IMPLEMENTS; INTERFACEs and variables of them; `REF_TO` with `REF()`,
`^` and `NULL`; stateless `FUNCTION`s (returning by assignment to the function's name); `TYPE`/`STRUCT`, a field
with a default (`Speed : REAL := 1.5;`, under whatever a variable's own `(field := ...)` names); multi-dimensional
`ARRAY [lo..hi]` with `:= [1, 2, 3(0)]` initialisers; `VAR`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_TEMP`, `VAR_GLOBAL`,
`VAR_IN_OUT`, any of them `CONSTANT`. Assigning to a `FOR` control variable is refused.

**A function-block instance is data.** It can be an array element (`delay : ARRAY [1..20] OF TON`), a struct
field, a `VAR_GLOBAL`, or any mix, called and read through the same paths as everything else
(`delay[i](IN := eye[i], PT := T#3s)`, `zone.gap.Q`, `zones[k](Run => lamp)`); each element keeps its own state,
and an array or struct of instances passes through `VAR_IN_OUT` by reference. A `FUNCTION` cannot hold one at any
depth, and an instance is never a value (not assigned, bound to an output, or initialised). MATIEC refuses arrays
of instances and instance fields; STruC++ 0.6.2 builds the field but cannot parse a call on an array element. So
the struct case is an `editionReject`, the array cases are withheld from both, and export warns.

**Arrays and structs are values.** A whole array or struct assigns (`b := a`, `track[i] := track[i - 1]`), passes
into a `FUNCTION` or `VAR_INPUT`, comes out of a `VAR_OUTPUT` (`reader.data.id`, `data => got`), and can be a
`FUNCTION` result (`FUNCTION MakePkg : Pkg`, or an enumeration). Each is a copy into the destination's own storage,
so later changes to the source do not reach the copy, and a place aliased through `VAR_IN_OUT` sees the copy rather
than a new object. Types must match exactly (same struct, or same bounds and element type, a `STRING` element's
capacity included). A value holding an instance never copies, and a block's outputs stay its own to write. MATIEC
agrees on struct copy, shift, by-value input, `=>` binding and return. It gives each in-place `ARRAY` a type of its
own, so a whole-array copy or a whole array passed to a `FUNCTION` is an `editionReject` (STruC++ builds both) and
export warns. A `FUNCTION` result must be a type name in both compilers, so a spelled-out `ARRAY` result is refused.

**Named types.** `TYPE Row : ARRAY [1..3] OF INT; END_TYPE` is one type: `Row`s copy into each other, pass by value,
are `FUNCTION` results, and start from a `[...]` list. Two names are two types however alike, and a `Row` never
matches an in-place array. A plain alias (`TYPE Count : INT;`, `TYPE Label : STRING[20];`, or a name for another
named type) names its base type and carries a `STRING` capacity through a chain of names. Export declares each once
as a TC6 `dataType`; a scalar alias travels in XML as its base type. MATIEC agrees on a named array copy and an
alias and refuses copies across names or against an in-place array; STruC++ builds the positive cases. A `FUNCTION`
taking or returning a named array is checked in-process only (MATIEC's C cannot pass an array by value).

**Constant array bounds.** A bound may be a named integer CONSTANT or an expression over them
(`ARRAY [0..ZONES - 1] OF BOOL`). A declaration sees the `VAR_GLOBAL CONSTANT`s and its own POU's earlier
constants; a `TYPE` or struct field sees only the global ones. A non-constant or backwards bound is refused.
MATIEC allows named-constant bounds only behind `-a` and takes only a literal as an initial value (so
`LAST : INT := ZONES - 1` too is an edition split); STruC++ builds both, so those cases are `editionReject`s and
export warns.

**Structured initial values.** `p : Pkg := (id := 7, dest := 3)`, unnamed fields at zero; field lists nest
(`(origin := (x := 5, y := 6))`), an array field takes `[...]`, an array of structs a list of field lists. Every name
must be a field, named once, with a value of its type. Export writes TC6 `structValue` / `arrayValue`, and import
reads both. MATIEC agrees on field lists and nested ones but refuses the two kinds of list mixed, so those run
in-process only and export warns. STruC++ 0.6.2 has none (a recorded gap).

**Standard spellings.** `**` is `EXPT`. `Mode#Idle` names an enumeration value anywhere a member can go. A formal
`FUNCTION` call names its arguments (`Clamp(hi := 100, v := raw, lo := 0)`) in any order. IEC's operator table puts
exponentiation above negation while its grammar puts a unary sign inside a power; this engine follows the grammar,
so `-2.0 ** 2.0` is 4.0 and `2.0 ** 3.0 ** 2.0` is 64.0, as MATIEC computes. STruC++ 0.6.2 has neither `**` nor
`Mode#Idle` (recorded gaps).

**One declaration line can name several variables** (`VAR x, y, z : INT := 3; END_VAR`, IEC's
`var1_list : simple_spec_init`): each is its own variable, instances retain separately, and the initialiser is
shared by value.

**Enumerations and subranges.** `TYPE Mode : (Idle, Running := 10, Fault); END_TYPE` is a type of its own: members
resolve unqualified, `CASE` selects on them by name, and it never silently becomes an integer. A variable starts at
its declared value (`m : Mode := Running`); a value from another enumeration is refused. `TYPE Percent : INT
(0..100); END_TYPE` is enforced on every store: out of range faults the scan (divergence 12).

**`VAR_IN_OUT` binds a place.** An aggregate passes by reference; a scalar is copied in and back out. The argument
must be a variable of exactly the declared type, since the block writes through it.

**Every statement ends in `;`**, as the standard and every real compiler require. A block terminator with no `;`
(`END_IF`) is read as a tolerated input form and written back with it on export
([Known permissiveness](#known-permissiveness) item 5).

**Types.** `BOOL`; signed (`SINT`/`INT`/`DINT`), unsigned (`USINT`/`UINT`/`UDINT`) and bit-string
(`BYTE`/`WORD`/`DWORD`) integers kept apart; `REAL`, `LREAL`, `TIME`, `DATE`, `TIME_OF_DAY`/`TOD`,
`DATE_AND_TIME`/`DT` (see [Dates and times of day](#dates-and-times-of-day)), `STRING`; with width-correct
two's-complement wrapping, IEC widening, ties-to-even narrowing, truncating integer division and `MOD` taking the
dividend's sign.

**`ANY_NUM` and `ANY_BIT` do not mix.** Arithmetic (`+ - * / MOD`) is on numbers; `AND`/`OR`/`XOR`/`NOT` and
shifts/rotates on bit strings. `aByte + 1`, `NOT anInt` and `SHR(anInt, 1)` are type errors naming the conversion
(`BYTE_TO_USINT`, `INT_TO_WORD`), as MATIEC refuses them. An untyped literal takes its type from context, so
`w AND 255` and `nw := NOT 0` are ordinary ST.

**`REAL` is single precision**, as on every target (MATIEC maps it to C `float`): it rounds to f32 after every
operation through the one `wrap()` both the interpreter and the emitter call, so `0.4` reads `0.4000000059604645`.

**`TIME` is a distinct type carrying milliseconds.** `PT` and `ET` are `TIME`, so `PT := 300` does not compile and
`T#1s + 1` is not 1001. Durations add, subtract, scale by a number and compare, and never mix with numbers
implicitly. Milliseconds is this engine's representation (IEC leaves resolution open); `TIME_TO_DINT(T#1500ms)` is
1500 here and on STruC++ 0.6.2 (built and run). **MATIEC converts in whole seconds**: `T#1500ms` is 1 (its
`__time_to_int` returns `tv_sec`), and `DINT_TO_TIME(1500)` / `REAL_TO_TIME(1500.0)` are `T#1500s`, where STruC++
and this engine read `T#1500ms`. So a MATIEC target such as OpenPLC v3 reads different numbers. The cases
"TIME_TO_DINT counts milliseconds" and "DINT_TO_TIME and REAL_TO_TIME read the number as milliseconds" hold the
divergence, re-checked by the MATIEC oracle on every run, and export warns wherever a `TIME` and a number are
converted (`export.ts` `exportWarnings`).

**`STRING` is bounded, and a store truncates.** `s : STRING[20]` holds 20 characters; unbounded is 80, IEC's
default. Capacity is not part of the type, so any `STRING` assigns to any other and the store cuts what does not
fit, as MATIEC does, on variables, struct fields, array elements and function results alike. A `VAR_IN_OUT` is the
exception: it stands for the caller's own variable, so the variable passed must have exactly the parameter's
capacity (an unbounded `STRING` counts as 80). Literals use IEC's
`$` escapes (`$$`, `$'`, `$L`/`$N`/`$P`/`$R`/`$T`, `$0D`). `STRING(20)` is accepted beside `STRING[20]`.

**`STRING` is ordered, not arithmetic.** The comparisons order by character code; `MIN`/`MAX`/`LIMIT` and
`SEL`/`MUX` accept strings. There is no string `+` (IEC defines none; the error names `CONCAT`). Nothing crosses
implicitly between `STRING` and a number; the `<src>_TO_<dst>` family includes `STRING` at both ends.
`STRING_TO_BOOL` reads by name (`'FALSE'` is false), and `STRING_TO_<number>` parses a leading numeric prefix,
yielding 0 for nonsense (this engine's rule).

**The string library.** `LEN`, `LEFT`, `RIGHT`, `MID`, `CONCAT`, `INSERT`, `DELETE`, `REPLACE`, `FIND`; positions
1-based, `MID` is `(IN, L, P)`. A `STRING` shows in the watch table and value overlay but does not drive the scene
(tag bindings stay numeric/boolean).

**`&` is `AND`**, both in IEC's operator table and used by Annex F; it lexes to `AND` everywhere, and export keeps
the author's spelling. **`0` and `1` are `BOOL` literals** beside `FALSE`/`TRUE` (the standard's examples write
`Q : BOOL := 0;`), bare literals only: `INT#1`, an integer variable or `2` still need a conversion.

**Literals.** Decimal, based (`16#FF`, `2#1010_1010`, `8#17`), typed (`INT#5`, `REAL#1.5`, `WORD#16#FF`), duration
(`T#1m30s`, `TIME#500ms`) and exponent (`1.0E-3`), `_` as a digit separator. An untyped literal takes its type from
context (`si : SINT := 127`, `rsi := si + 1`); a typed literal that does not fit (`INT#40000`) is rejected.

**Assignments and arguments are type-checked** (stores, initialisers, function arguments, block inputs). Only
IEC's safe widenings are implicit: up a signed chain, up a bit-string chain, any integer into a real, `REAL`→
`LREAL`. Narrowing, `BOOL`↔number, `TIME`↔number and signed↔bit-string need the conversion the error names
(`write REAL_TO_INT(...)`).

**Standard function blocks.** `TON`, `TOF`, `TP`, `R_TRIG`, `F_TRIG`, `CTU`, `CTD`, `CTUD`, `SR` (set-dominant),
`RS` (reset-dominant). None is reserved: a user `FUNCTION_BLOCK` of the same name shadows it, as in IEC. Each keeps
its inputs between calls, as a user block does: an input a call leaves out has the value the last call gave it
(`FALSE`, `0` or `T#0s` before any call gave one), so `t(IN := go, PT := T#2s);` then `t(IN := go);` still times
2 s. Timers: [Timers read the controller clock](#timers-read-the-controller-clock).

**Standard functions.** `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`, `MUX`, the REAL math set
(`SQRT`/`LN`/`LOG`/`EXP`/`EXPT`/trig), `TRUNC`, `SHL`/`SHR`/`ROL`/`ROR`, the `<src>_TO_<dst>` family,
`BCD_TO_INT` / `INT_TO_BCD`, and the functional operators (`ADD`, `SUB`, `MUL`, `DIV`, `MOVE`, and the comparison
chains `GT`/`GE`/`EQ`/`LE`/`LT`/`NE`, `GT(a, b, c)` meaning `a > b AND b > c`). On a duration or a date they take the
operators' rules (`ADD(t, 5)` refused like `t + 5`; `DIV` truncates like `/`). `ADD` and `MUL` with three or more
inputs work step by step, as `a + b + c` does: an integer result wraps and a `REAL` one rounds after each step. A
formal call uses IEC's parameter
names as MATIEC's library declares them (`LIMIT(MN := 0, IN := x, MX := 10)`, `MID(IN := s, L := 3, P := 2)`,
`IN1`..`INn`, `K` and `IN0`.. for `MUX`), in any order; MATIEC agrees. STruC++ binds standard-function arguments by
position (`LIMIT(MX := 9, IN := x, MN := 0)` becomes `LIMIT(9, x, 0)`), so export warns about any written out of
order; user functions it binds by name.

**A formal `FUNCTION` call may leave inputs out**: `Scale(v := 5)` gives each omitted input its declared initial
value, or its type's, fresh each call. MATIEC agrees. STruC++ refuses an omitted input with no declared initial
value (known gap `omitted-input-no-initial`). A positional call gives every input (MATIEC also takes one that stops
short).

**Identifiers are case-insensitive**: names colliding only in case are duplicates, and the declared spelling is
what the watch table, emitter and tag bindings see.

### Timers read the controller clock

The engine keeps a controller clock in whole nanoseconds (MATIEC's resolution), moved on each scan by its `dt`,
rounded the way the tier-2 harness steps `__CURRENT_TIME`; the emitted TypeScript keeps it on `S.__now`. `TON`,
`TOF` and `TP` follow IEC's bodies: the starting call notes the clock (`START_TIME`) and evaluates nothing else, so
`ET` is 0 on that scan, and later calls measure `CURRENT_TIME - START_TIME`. A `TON` with `PT := T#0.3s` at 0.1 s
fires on the fourth scan, and `TP`'s completion scan sets `Q := FALSE` and `ET := PT` together.

A timer called only on some scans (inside an `IF`, or behind `EN` on a rung) still measures all the elapsed time: a
`TON` started on scan 1 and next called on scan 4 of a 100 ms scan reads `ET = 300`. The ST cases ("a TON inside
an IF...", "a TOF and a TP inside an IF...") replay through MATIEC; the ladder case ("a timer with EN on the
rung...") is held in-process. In a `CONFIGURATION` each task reads the clock at its scans' release times, so a task
that sheds scans has its timers fall behind with it, as `shortestHeldIntervalSec` warns. `ET` is not truncated to
whole milliseconds (divergence 5).

### Dates and times of day

`DATE`, `TIME_OF_DAY` (`TOD`) and `DATE_AND_TIME` (`DT`), with literals in both spellings (`D#2024-02-29` /
`DATE#...`, `TOD#23:59:59.5` / `TIME_OF_DAY#...`, `DT#2024-02-29-12:00:00` / `DATE_AND_TIME#...`): milliseconds from
1970-01-01 UTC or from midnight, and not numbers.

- **Arithmetic is IEC's table only**: `TOD` or `DT` ± `TIME`, and the difference of two `DATE`s, `TOD`s or `DT`s (a
  `TIME`), as operators and as the 2nd-edition functions (`ADD_TIME`, `SUB_TIME`, `MULTIME`, `DIVTIME`,
  `ADD_TOD_TIME`, `ADD_DT_TIME`, `SUB_TOD_TIME`, `SUB_DT_TIME`, `SUB_DATE_DATE`, `SUB_TOD_TOD`, `SUB_DT_DT`,
  `CONCAT_DATE_TOD`), plus the 3rd edition's `MUL_TIME`/`DIV_TIME`. Like MATIEC, it refuses the rest (`DATE + TIME`,
  `TIME + TOD`, a `DATE` compared with a `DT`), naming the spelling that works.
- **Conversions**: a `DT` splits into `DATE` and `TOD` (`DT_TO_DATE`, `DT_TO_TOD`, and the long names), and each
  converts to and from `STRING` as its literal. Conversion to or from a number is refused, this engine's rule: both
  reference compilers build one and disagree. On `D#2024-02-29`, `DT#2024-02-29-13:45:30` and `TOD#13:45:30` (MATIEC
  by its execute oracle, STruC++ 0.6.2 built and run):

  | | MATIEC | STruC++ |
  |---|---|---|
  | `DATE_TO_UDINT` | 1709164800 (seconds since 1970) | 19782 (days since 1970) |
  | `DT_TO_UDINT` | 1709214330 (seconds since 1970) | 1709214330000 ms, wrapped to 32 bits |
  | `TOD_TO_UDINT` | 49530 (seconds since midnight) | 49530000 (milliseconds) |

  MATIEC's `UDINT_TO_DATE` also keeps the time of day, a `DATE` that is not midnight. A `TIME` from a fixed instant
  is no way round it (`TIME_TO_DINT` is seconds on MATIEC, see `TIME` above, and milliseconds since 1970 overflow a
  `DINT` after 24 days). So the message says to keep the value in its type: compare a `DATE` or `TOD` with a literal
  of its kind, and subtract two `DT`s for a `TIME`; each builds and runs on STruC++. `SUB_TOD_TOD` and a `DATE`
  difference are not offered, since they fail on STruC++ (no `SUB_TOD_TOD` in its runtime; a `DATE` difference
  stays days, compared against nanoseconds), which only `--execute` shows.
- **Not reserved words.** Calendar names are recognised where a type is expected (a user type of the same name
  wins), so a variable may be called `dt`. MATIEC refuses that name, and export warns.
- **Range.** A `TOD` is 00:00:00 up to 24:00:00; a `DATE` or `DT` 1970-01-01 to 2106-02-07-06:28:15 (this engine's
  range: 32-bit unsigned seconds from 1970). A literal outside it, or naming no instant (`D#2023-02-29`,
  `TOD#24:00:00`, which MATIEC builds), is refused; a result outside it faults the scan (divergence 9).
- **Checked.** MATIEC replays the literal, operator, function, split, ordering and `*_TO_STRING` cases and agrees;
  STruC++ builds them all except `SUB(DATE, DATE)`, which it types as a `DATE` (known gap `sub-date-date`).
- **Not here**: 64-bit `LDATE`/`LTOD`/`LDT`, and a function that reads the date: IEC has none, so a program that
  needs "now" cannot be portable.

### Tasks and programs

A file can declare `PROGRAM`s and a `CONFIGURATION` that runs them.

- **`PROGRAM ... END_PROGRAM` is a POU.** A `CONFIGURATION` (one `RESOURCE`, or tasks and instances directly inside)
  declares `TASK`s and instances, `PROGRAM Line1 WITH Fast : Merge;`; one type may run as several instances with
  their own state.
- **Each task scans on sim time, on its own `INTERVAL`**, one accumulator per task
  ([scanEngine.ts](../src/plc/scanEngine.ts)), shared by the live sim and the project-test runner. Scans one step
  makes due run in the order they came due; tasks due together run by `PRIORITY` (0 first), then declaration order.
  An instance with no task runs once per step after the periodic scans (IEC's lowest priority). A scan takes no sim
  time, so nothing preempts mid-scan: the interleaving is deterministic, and a bug that needs preemption between two
  statements does not show.
- **Names.** An instance's variables are `Instance.Name` in the watch table, on tags and in `get`/`setInput`; globals
  keep bare names. Without a `CONFIGURATION`, the implicit program or a lone `PROGRAM` runs on the scene's scan time
  with bare names.
- **Code outside every POU, beside a `CONFIGURATION`** (an extension) holds the program's top-level variables: one
  namespace with the `VAR_GLOBAL`s, visible to every POU by bare name, its `VAR_INPUT` / `VAR_OUTPUT` scene inputs
  and outputs. Its statements run from the one instance that names no type, `PROGRAM Main WITH MainTask;`, and are
  refused when none does. Export writes that code as a `PROGRAM` of its own (`MainProgram`); its variables stay that
  PROGRAM's unless another POU names one, and then they go out as `VAR_GLOBAL`s reached through `VAR_EXTERNAL`.
- **`VAR_EXTERNAL` is checked**: the named `VAR_GLOBAL` must exist with the same type (capacity and subrange
  included), a `CONSTANT` global needs `VAR_EXTERNAL CONSTANT`, which makes the global read-only in that POU even if
  it is not. It declares no storage.

**Checked against MATIEC** (tiers 1 and 2): a two-rate controller, tasks due together running by `PRIORITY`, a
continuous program after the periodic ones, a slow task's timer advancing by its period. It also refuses what this
engine refuses: a `VAR_EXTERNAL` of the wrong type, a non-`CONSTANT` external of a `CONSTANT` global, a write
through `VAR_EXTERNAL CONSTANT`, an instance of a `FUNCTION_BLOCK`, a `TASK` with no `PRIORITY` or arguments out of
order, two instances with one name. Recorded on the cases:

- **MATIEC ignores `PRIORITY`** and runs instances in `PROGRAM`-line order; that case is withheld, and export warns
  when the lines are not in priority order.
- **Phase**: MATIEC releases every task at tick 0, this engine one period in. IEC fixes neither, so the tier-2
  harness numbers ticks from 1 ([oracleShape.ts](../src/plc/oracleShape.ts)).
- **MATIEC does not check a `WITH` task name** (gcc refuses the C it emits, but tier 1 stops at iec2c), so that
  rejects case is withheld.
- **`limit` is reserved in MATIEC's ST**, like `lt`, `step` and `pid`.

STruC++ 0.6.2 builds all of it except `VAR_EXTERNAL CONSTANT` (it demands an initial value) and a call on an
instance kept as a `VAR_GLOBAL` ("scalar globals only for now"), which export writes when top-level code shares
variables with another POU; MATIEC compiles and agrees with that export.

**Not supported**, each refused by name: event tasks (`SINGLE`), instance wiring in the `CONFIGURATION`
(`PROGRAM A WITH T : P (start := go)`), more than one `RESOURCE`, `WITH` on a function-block instance.

**In a project, the tasks are data.** A scene's program can carry a controller table
([core/controller.ts](../src/core/controller.ts)): tasks (name, `intervalMs`, `priority`) and instances (name,
PROGRAM `type`, `task`), stored beside the program like the scan time, through the project file, folder manifest,
scene file and collaboration room. The ST keeps the `PROGRAM`s and top-level code and no `CONFIGURATION`; the engine
appends the one the table stands for ([plc/controller.ts](../src/plc/controller.ts)), so one checker serves both and
a table's problems are reported as the controller's. With no table, a single task at the scan time runs the
top-level code and each `PROGRAM`. Import .st turns a `CONFIGURATION` into the table when it can hold it; export
writes the table back as a `CONFIGURATION`.

### Located variables

**`name AT %IX100.0 : BOOL` binds a variable to an I/O point.** A part's PLC tag may be an address, as a device is
wired to a terminal, so the same program runs in the simulator and, exported as written, on a PLC with I/O there.

- **The address is the key on the tag surface.** `%I` is an input and `%Q` an output wherever declared, under its
  canonical address ([core/io/iecAddress.ts](../src/core/io/iecAddress.ts): upper case, bit size written, no leading
  zeros, so `%i100.0` and `%IX100.0` are one point). The watch table and code keep the name. An address is never
  qualified by an instance or scoped to a cell.
- **Where:** a plain `VAR` in a `PROGRAM` (including code outside every POU) and `VAR_GLOBAL`, as IEC's grammar
  puts them. Refused: a located `VAR_INPUT`/`VAR_OUTPUT` (the address says the direction), and one in a
  `FUNCTION_BLOCK` or `FUNCTION` (instantiated many times; an address is one point).
- **Shapes:** `%I`/`%Q` with `X` (`byte.bit`, bit 0-7, the default), `B`, `W` or `D`. Bit: `BOOL`; byte: `BYTE`,
  `SINT`, `USINT`; word: `INT`, `UINT`, `WORD`; double word: `DINT`, `UDINT`, `DWORD`, `REAL`. Deeper hierarchies
  (`%IX1.2.3`) are refused by name: OpenPLC's and MATIEC's runtimes use two levels.
- **One point, one variable.** Two variables at one address are refused (as both compilers do), and so is a
  `PROGRAM` with located variables run as more than one instance, which would make scan order decide the output
  (this engine's rule).
- **Memory (`%M`)** is storage the program keeps: same shapes, types and homes, by name, never on the tag surface
  (`pou.ts` `locatedBindings` leaves it out; no part or external controller reaches it). OpenPLC keeps a SCADA's
  values at `%MW` / `%MD`. **Two memory variables sharing bytes are refused** (`%MW0` and `%MX1.2`; `%MWn` is bytes
  2n and 2n+1, two bits of one byte two places): IEC leaves overlap to the implementation and targets differ, so this
  rule is this engine's.
- **`AT %I*` / `%Q*` is a plain variable.** The I/O configuration that completes it here is the scene's wiring,
  which binds by name, so the variable is ordinary wherever declared (`Decl.linked` keeps what was written); IEC's
  `VAR_CONFIG` is read by no target here, so export writes it plain. A full address on a struct field is refused.
- **Not supported**, refused by name: 64-bit (`L`) addresses and a direct address in code (`Q := %IX0.0;`).

**Checked against both compilers.** MATIEC compiles and agrees on the located cases, and both refuse what this engine
refuses: a located `VAR_INPUT`, one in a function block, a type that does not fit the address, two variables at one
address. Also: MATIEC refuses a `VAR` block mixing located and ordinary variables, STruC++ takes it, so this engine
does and export warns (permissiveness 4); an initial value on a located variable and a memory address compile in
both; the tier-2 harness backs each address with storage in `LOCATED_VARIABLES.h`
([oracleShape.ts](../src/plc/oracleShape.ts)).

### Not supported

| Area | Missing |
|------|---------|
| Types | `WSTRING` (a double-quoted literal is rejected by name, so the message says which type is missing rather than "unexpected character"); `LDATE`/`LTOD`/`LDT`; `LINT`, `ULINT`, `LWORD` (64-bit needs exact arithmetic a JS number cannot give; the checker says so by name rather than reporting "unknown type"); a default value on an alias, enumeration or array `TYPE` declaration (`TYPE Count : INT := 5;`; a `STRUCT` field's default is supported) |
| Declarations | `VAR_ACCESS`, `VAR_CONFIG`, `RETAIN`/`NON_RETAIN` (accepted, no effect), 64-bit (`L`) located variables, and a direct address used in code (see [Located variables](#located-variables)) |
| Configuration | event tasks (`SINGLE`), instance wiring in the `CONFIGURATION`, more than one `RESOURCE`, `WITH` on a function-block instance (see [Tasks and programs](#tasks-and-programs)) |
| Statements | FB calls as expressions; leaving an input out of a formal call to a standard function (MATIEC takes it; every input is asked for here) |
| Library | `SEMA`, a function that reads the date (IEC has none), and the case-mapping/trim string extensions vendors add on top of IEC's nine |
| 3rd edition | `CLASS`, `NAMESPACE`, an `ARRAY OF REF_TO`, a reference or an interface in a struct field, and a FUNCTION declaring a `REF_TO`. Each is rejected by name with a substitute where one exists, rather than as a syntax error. `METHOD`, `EXTENDS`/`IMPLEMENTS`, `INTERFACE`, `ABSTRACT`/`FINAL` and `REF_TO` are implemented: see [Object orientation](#object-orientation-and-references-method-extends-interface-ref_to) |
| Vendor extensions | `PROPERTY`, `VAR_INST`, `REFERENCE TO` / `REF=` / `__ISVALIDREF`, `POINTER TO`, `THIS^`, `AND_THEN`, `OR_ELSE` and `STRUCT EXTENDS`: refused by name, each message naming the IEC form (same section) |

## Deliberate divergences

Each is exercised by a corpus case carrying a `divergence` note.

1. **Signed/unsigned same-width ties resolve to the unsigned type**, in either operand order. IEC does not define
   mixing them; this keeps the result deterministic. (Arithmetic on `ANY_BIT` is rejected, so this is the only tie.)
2. **An out-of-range `MUX` selector yields 0.** IEC calls it an error.
3. **`F_TRIG` does not pulse at startup.** The literal IEC body fires when `CLK` starts false; we suppress it. Only
   scan 1 can differ, and the companion case starting `CLK` high is replayed externally, so the oracle checks that
   bound.
4. **`REAL` division by zero yields IEEE ±Infinity**, matching PLC float hardware, which flags but does not fault.
   Integer division and `MOD` by zero fault the scan, this engine's choice: stopping shows the mistake instead of
   letting a made-up value drive the scene. A fault stops the program; the others are a subscript outside its
   dimension, a `TON` with a negative preset, and a loop that does not end within the scan (the watchdog). The table
   is at the top of [src/plc/faults.ts](../src/plc/faults.ts); the PLC panel shows each fault on its instruction.
5. **A timer's `ET` is not truncated to whole milliseconds.** `TIME` has ms resolution on real hardware; this clock
   counts whole nanoseconds of sim time (MATIEC's `__CURRENT_TIME` resolution), and a step is rarely whole
   milliseconds (60 Hz is 16.67 ms). A timer reaches `PT` on the scan whose clock is at least `PT` past its start.
6. **An out-of-range length or position in the string library clamps.** IEC calls it an error; faulting a scan over
   a short string is not behaviour a controller survives.
7. **`REAL_TO_STRING` and `TIME_TO_STRING` formats are ours.** IEC fixes neither. A `REAL` prints its shortest
   round-trip form; a `TIME` an IEC literal (`T#1s500ms`) that reads back through `STRING_TO_TIME`. The value is
   portable, the spelling is not: don't parse it on the target.
8. **A `FOR` loop snapshots its bound at entry; other implementations re-read it.** `FOR i := 1 TO n DO n := 10; ...
   END_FOR;` runs 3 times here and 10 there: MATIEC's C tests `if (I <= N)` inside the loop, and RuSTy's lowering
   tests the user-written bound. IEC constrains `FOR` to a count "determined in advance", but no edition text
   reachable here says when the final value is evaluated, so this is the engine's own rule. Both compilers lower to a
   C/LLVM-style loop, where re-reading is the easy path, so their agreement is weak evidence. The snapshot makes the
   count knowable at entry, which is what `FOR` is for (`WHILE` re-tests), and a body that grows its bound would
   otherwise run up to the loop cap in one scan. **Export warns** about such a loop: a body that rewrites its own
   bound is non-portable.
9. **A calendar result outside its type's range faults the scan**: a `TOD` past midnight, a `DATE` or `DT` before
   1970 or past 2106. MATIEC neither wraps nor checks (past 86400 seconds its `TOD_TO_STRING` prints `TOD#ERROR`);
   this engine stops, as for a subscript or subrange (12).
10. **A calendar value's text is ours past the whole second.** `DATE_TO_STRING` and friends print the literal
    (`D#2024-02-29`, `TOD#07:05:09`) as MATIEC does (replayed); a fraction prints as three places of milliseconds
    (`TOD#07:05:09.500`), where MATIEC prints six. `STRING_TO_DATE` of text that is no date is 1970-01-01.
11. **BOOL `AND` and `OR` evaluate both operands.** IEC leaves evaluation order open; MATIEC (OpenPLC's 2nd-edition
    compiler) short-circuits with C `&&`, so `(d <> 0) AND (100 / d > 1)` with `d = 0` is FALSE there and faults
    here. The engine takes the side that surfaces a non-portable program: eager against a short-circuiting target
    faults on a program the target runs (visible, and a nested `IF` runs on both), while short-circuit against an
    eager target would hide a fault until the PLC. Case: "both operands of a BOOL AND are evaluated...".
12. **A subscript outside its dimension, or a store outside a subrange, faults the scan**, naming the value and range
    (`250 is outside Percent (0..100)`). IEC requires a subscript in range but says nothing of what a runtime does
    otherwise; MATIEC checks neither and reads past the array, which hides the bug until much later. The
    read and the subrange store are corpus cases; the out-of-range write is pinned in `builtins.test.ts` (undefined
    behaviour in C).

## Known permissiveness

Five things the engine accepts that a strict IEC compiler rejects, listed because a permissiveness is the same
portability failure as a divergence, pointed the other way.

1. **A POU reads a `VAR_GLOBAL` directly**, where IEC requires `VAR_EXTERNAL`. The semantics are the same, but a block
   that writes a global without the declaration will not build on the target. `VAR_EXTERNAL` is accepted and
   checked, and export names each POU that leaves one out.
2. **A variable may be named after a standard function** (`ADD`, `SUB`, `MUL`, `DIV`, `GT`, `GE`, `EQ`, `LE`, `LT`,
   `NE`). IEC does not reserve them, but they are Instruction List operators, and a compiler sharing one lexer
   between IL and ST (MATIEC) refuses `VAR_OUTPUT lt : BOOL;`. Export warns. (`AND`/`OR`/`XOR`/`NOT`/`MOD` are ST
   operators, so this engine rejects them as identifiers.) The SFC keywords (`STEP`, `TRANSITION`, `ACTION`, ...)
   are the same case: MATIEC refuses `step : INT`, and export warns.
3. **A variable may be spelled like a declared type, block or function** (`pkg : Pkg`); nothing here confuses the
   two. MATIEC's lexer reads the type's token, so `VAR_OUTPUT pkg : Pkg;` does not declare ("unknown error in output
   variable(s) declaration"). Export warns.
4. **A `VAR` block may mix located and ordinary variables** (`VAR Eye AT %IX0.0 : BOOL; Seen : BOOL; END_VAR`).
   STruC++ builds it; IEC's grammar and MATIEC give located declarations a block of their own ("invalid located
   variable declaration"). Export warns, naming the located variable.
5. **Tolerated input forms, which the export rewrites.** Code written elsewhere uses forms strict IEC lacks. The
   policy is *read the tolerated form, write what every compiler accepts*; each form is read by a rule of this
   engine's own:
   - no `;` after `END_IF`, `END_CASE`, `END_FOR`, `END_WHILE`, `END_REPEAT`, or after a `TYPE` block's last
     declaration (`END_STRUCT` or an enumeration's `)` straight before `END_TYPE`);
   - an enumeration member written `Mode.Idle` (IEC's `Mode#Idle`; where a variable is called `Mode`,
     `Mode.Idle` is that variable's member);
   - an argument named and given nothing, `Q => ,` / `IN := ,` (as if absent);
   - an interface base in the `__SYSTEM` namespace (`EXTENDS __SYSTEM.<name>`, a runtime's root interface no program
     declares) and `PUBLIC` / `ABSTRACT` on an interface's methods;
   - `AT %I*` / `%Q*` (see "Located variables"), written plain on export;
   - a library namespace on a TYPE (`JsonLib.Parser`, `EXTENDS MyLib.Base`), where a dotted name cannot be a place:
     dropped by the parser (`typeName`), kept by the export. The engine has no libraries, so a program declares
     every type it names;
   - `VAR PERSISTENT` (as retention; PLCopen `persistent`, IEC `RETAIN`), a STRING capacity as a constant or in
     parentheses (`STRING(MAX_LEN)`, `STRING(80)`: folded like an array bound, exported as `STRING[20]`), and an
     enumeration declared inline (`m : (Idle, Run)`, which is IEC; MATIEC parses but cannot generate it). A method
     called on a block call (`fb(a := 3).Get()`) is not taken;
   - an enumeration with a base type (`(Idle, Run) UINT`): values are held as INT, so one INT cannot hold is
     refused; export leaves the word out;

   and `canonicalSyntax` ([exportText.ts](../src/plc/exchange/exportText.ts)), a lexical pass both exports run first, writes
   each in the strict form. The corpus group "tolerated input forms" proves it: the oracles render each case through
   that pass, and MATIEC and STruC++ build the result and agree with the goldens.

`VAR s : STRING[16]` is not a permissiveness: it is the standard's spelling (see
[Editions](#editions-matiec-and-struc)).

## Getting a program out

[src/plc/exchange/export.ts](../src/plc/exchange/export.ts) has two targets, because there is no universal one:

| Target | What it is | Who takes it |
|--------|------------|--------------|
| `iec-text` (`.st`) | a spec-legal IEC source file | MATIEC / STruC++ / RuSTy, and any vendor's ST editor as paste |
| `plcopen-xml` (`.xml`) | PLCopen TC6 interchange XML | IEC toolchains that import PLCopen XML |

For a program with no `CONFIGURATION` (it runs on the scene's scan time), both targets generate the
`CONFIGURATION`/`RESOURCE`/`TASK` layer, so one body can be wrapped for several targets. A file with its own
`CONFIGURATION` crosses as written, except that a file-level `VAR_GLOBAL` moves onto the `CONFIGURATION`, where IEC
puts it. `iec-text` otherwise rewrites nothing beyond `canonicalSyntax`'s strict-form pass
([Known permissiveness](#known-permissiveness) item 5).

- **The exporter is what the oracle verifies**: `scripts/oracle-matiec.mjs` renders the corpus through
  `renderIecText`, the function the Export button calls, so CI compiles the artifact users receive.
- **A program that does not compile is refused.**
- **Both targets are checked by something that is not us**: the `.st` by MATIEC, the XML against PLCopen's TC6
  schema (`npm run st-oracle:xml`, pinned by commit from Beremiz, which OpenPLC's editor is built on). The namespace
  is the published schema's, `tc6_0201`. The schema holds element order (`resource` before the globals) and that
  standard function-block instances are derived types.
- **The syntactic pass respects comments**: the POU peeler skips trivia by the lexer's rules, and the corpus carries
  a commented case.

What a target may not carry comes back in `warnings`, never dropped silently: a POU using a `VAR_GLOBAL` without
`VAR_EXTERNAL` (named, with the globals), `PROGRAM` lines out of priority order, subrange bounds (not every runtime
enforces them), a name colliding with an IL operator, instances in arrays or struct fields, interface variables
(which do not build for OpenPLC), a `VAR` block mixing located and ordinary variables, a `FOR` loop writing its own
bound, a standard function's arguments out of order, and a variable named after an SFC keyword or `dt`.

### A compiler taking the file is not an editor taking it

OpenPLC's editor never hands an imported file to its compiler: it reads it into its own project model and compiles
ST it regenerates. `npm run st-oracle:openplc` ([scripts/oracle-openplc.mjs](../scripts/oracle-openplc.mjs)) runs
that editor's reader, transpiler and build, at a pinned commit, on every exported case through both ways in (File >
Import PLCopen XML, and a project folder of `.st`/`.dt` files, as `openplc-cli` reads), and replays the result
against the goldens. It runs natively on Windows.

The export writes ST bodies in `xhtml:p`, as OpenPLC and a current Beremiz do; OpenPLC reads no other element, and
an equally valid `<xhtml xmlns="…xhtml">` arrives empty without warning. The editor's other limits are recorded in
the script with their diagnosis:

- its XML reader takes a starting value only from `<simpleValue>` (so `[1, 2, 3]` and `(x := 1)` start at zero) and
  instances only from inside a `<task>` (a task-less instance never runs);
- its POU reader keeps a declaration only on a line of its own below `VAR` (`VAR a : INT; END_VAR` loses the
  section) and refuses a one-line struct type; the `.st` export is the author's text verbatim, so the project-folder
  door stops here;
- a plain alias type (`TYPE Count : INT; END_TYPE`) has no place in its model, and the XML reader throws on one.

Each loses data silently and is OpenPLC's to fix; the gate shows when they are. Our own importer reads the text of
whatever element holds the code, and the import oracle checks every body arrives from a project OpenPLC's editor
wrote.

## Getting a program in

[src/plc/exchange/importText.ts](../src/plc/exchange/importText.ts) (`Import .st` in the ST editor) is the exporter run backwards,
sharing its trivia mask so a keyword inside a comment is never mistaken for the real one:

| The file has | What happens |
|---|---|
| one `PROGRAM`, one task, one instance: a `CONFIGURATION` / `RESOURCE` / `PROGRAM` wrapper | peeled: the POUs and the program body are the program here, under bare names |
| its `TASK (INTERVAL := T#40ms)` | **adopted** as the editor's scan time; it is the cycle the author designed against |
| its `VAR_GLOBAL` on the configuration | hoisted to the top of the file |
| more than one `PROGRAM`, task, instance or `RESOURCE` | **kept as written**: this engine runs the controller, so nothing is peeled or dropped |
| `AT %IX0.0` / `AT %QW4` | **kept as written**: the scene binds the variable by its address |
| `AT %MW0` / `AT %MX0.0` | **kept as written**: memory the program keeps |
| `AT %I*`, `RETAIN`, an event task, instance wiring, several RESOURCEs | **named in `notes`**, never silently dropped |

Anything the subset cannot hold is reported: a program that quietly means something other than its author wrote is
worse than one that refuses.

**The round trip**: every corpus case is exported and imported again and must come back text for text with no notes
([importText.test.ts](../src/plc/exchange/importText.test.ts)); a file this editor wrote imports as a no-op.

**PLCopen XML** ([src/plc/exchange/importXml.ts](../src/plc/exchange/importXml.ts)), the format many IEC tools export: each `<pou>`
becomes a block, `<dataType>`s `TYPE` declarations, the configuration's `<globalVars>` a `VAR_GLOBAL` block; a
single program's task interval becomes the scan time, while a controller's programs keep their names and its tasks
and `<pouInstance>`s become a `CONFIGURATION`. Blocks are composed by `flattenDocument`
([document.ts](../src/plc/document.ts)), the one place a program is put together. The XML reader is hand-written,
like the ST lexer, so this layer has no runtime dependency.

**Order cannot survive**: PLCopen keeps data types and POUs in separate containers, so a `TYPE` between two blocks
loses its position (a forced loss, like the `VAR_GLOBAL` hoist). **The wrong file is refused**: XML that does not
parse, or has no `<project>` root, throws. What the subset has no answer for is named, never dropped: an `LD` body is
read as the LADDER section that draws it ([ladder.md](ladder.md)), but an `FBD`/`SFC`/`IL` body, or a ladder a rung
here cannot express, is left out with a note to rewrite it in ST or LD on the source toolchain. Tolerated input
forms come in as written ([Known permissiveness](#known-permissiveness) item 5).

### The import direction has its own oracle

`npm run st-oracle:import` ([scripts/oracle-import.mjs](../scripts/oracle-import.mjs)) feeds both importers files
nobody here wrote, from commit-pinned upstreams: Beremiz's PLCopen projects (ladder and FBD bodies, an older
`tc6.xsd` namespace, vendor extensions), MATIEC's `AnnexF/*_st.txt`, the worked examples in IEC 61131-3, and a
project OpenPLC's editor wrote (ST in `<xhtml:p>`). Compiling here is not required, since real files use more than
the subset (`ANY`-typed overloads, MATIEC's `{...}` pragmas). **The gate is silence**: every POU and data type a file
declares must reach the program or the notes, and a POU reaching the program must bring its body. Exempt by
construction: the loaded program POU, which this subset leaves implicit, and an instance such as
`PROGRAM G : GRAVEL` inside a `CONFIGURATION`, which is not a declaration.

## Related

- [src/plc/DEVICE-IO.md](../src/plc/DEVICE-IO.md) - the I/O bus, how scene tags bind to program
  variables ([Which variables cross](../src/plc/DEVICE-IO.md#which-variables-cross-declared-io-and-the-programs-own-tags-by-wiring)),
  and the links to a real PLC.
