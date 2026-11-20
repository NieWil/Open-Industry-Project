# Ladder Diagram (IEC 61131-3 LD)

Ladder is a second front end on the Structured Text engine, not a second runtime. A rung lowers to the ST that
means it, and everything downstream (checker, interpreter, TypeScript emitter, text exporters, the sim worker)
sees ordinary statements. The code is [src/plc/ladder/ladder.ts](../src/plc/ladder/ladder.ts) (model, lowering, export caveats),
[src/plc/parserLadder.ts](../src/plc/parserLadder.ts) (`ladderSection`) and [src/plc/ladder/ladderXml.ts](../src/plc/ladder/ladderXml.ts)
(PLCopen `<LD>` in and out).

**Its words are data, not branches in the checker.** A lowered place that an element requires to be BOOL carries a
role, held in a side table keyed by the AST node (`ladderRole`, filled by `mapBack`) rather than as a field on
`Expr`, so the ST AST stays free of ladder vocabulary. `LD_ROLES` says
which side of a statement each role stands on and how to word its diagnostic, and the checker (`checkExpr.ts` `elementRule`) asks: one lookup on
a read, one on a write. The identity key is safe because nothing clones a statement
between the lowering and the check. A `structuredClone` introduced on that path would drop roles, which
`ladder.test.ts` catches by asserting both messages exactly.

## The text

IEC gives LD no text form, so this one is ours. It draws the standard's symbols:

```
LADDER
  [|Start|, |Motor|] |/Stop| (Motor);   (* seal-in *)
  |Eye| |P Button| (S Jam);             (* an edge, a set coil *)
  |Run| T1(IN, PT := T#2s) (Late);      (* a timer on the rung *)
  |Go| ADD(IN1 := n, IN2 := 1, OUT => n);
  EQ(IN1 := Step, IN2 := 10, OUT) |/Busy| MOVE(IN := 20, OUT => Step);
END_LADDER
```

| Text | Element (IEC 61131-3 ed. 3, 8.2) |
|---|---|
| `\|x\|` `\|/x\|` | normally open / closed contact |
| `\|P x\|` `\|N x\|` | positive / negative transition-sensing contact |
| `(x)` `(/x)` | coil / negated coil |
| `(S x)` `(R x)` | set / reset coil |
| `(P x)` `(N x)` | positive / negative transition-sensing coil |
| `a b` | series |
| `[p1, p2]` | branch (an empty path is a wire) |
| `T1(IN, PT := t, ET => e)` | a function-block box: the bare pin sits on the rung |
| `ADD(IN1 := a, IN2 := b, OUT => c)` | a function box, on the rung by EN / ENO |
| `EQ(IN1 := a, IN2 := b, OUT)` | a function whose BOOL result starts the rung (`OUT` bare) |
| `AND(IN1 := a, IN2 := b, OUT => c)` | AND, OR, XOR, NOT, MOD: a function ST spells as an operator, as a box (lowers to `(a AND b)`) |
| `Next: ...;` | a rung's label, where a jump goes to (8.2.6) |
| `... >>Next;` | a jump, ending the rung: while what reaches it is ON, the rungs down to `Next` are skipped |
| `... RETURN;` | a return, ending the rung: while what reaches it is ON, the rest of the POU is skipped |
| `(* ... *)` above a rung | the rung's comment (the view shows and edits it; PLCopen carries it as a `<comment>`) |

A box's rung pins default to the block's first BOOL input and output (TON: IN and Q; CTU: CU and Q). Name another
bare to move it: `C1(R, CU := Pulse, PV := 2, Q)` puts the reset on the rung. `EN` bare runs the block only while the
rung is on and passes ENO on. `OUT` bare makes a function's result the rung: nothing feeds it, so it stands at the
left rail (first on the rung, or first on a path of a branch that is), takes no EN, and must return a BOOL (the
comparisons, a `*_TO_BOOL`, a user FUNCTION declared `: BOOL`). It is how a rung tests a number, the sequencer's
`EQ(IN1 := Step, IN2 := 10, OUT)`. A section can stand anywhere statements can, and a POU whose whole body is one section
is a ladder POU (`LdSection.whole`), which is what exports as `<LD>`.

The word `LADDER` is not reserved: `ladder := 3;` is still a statement.

AND, OR, XOR, NOT and MOD are keywords of ST, not functions it can call, but LD draws them as boxes (IEC
Tables 28-29). A box can be one (`OPERATOR_FUNCTIONS` in ladder.ts). It reads where a box can stand
when the word is followed by `(`, and lowers to the operator, parenthesised (`(a AND b AND c)`, `(NOT a)`,
`(a MOD b)`), so the checker, the interpreter and every text exporter see only ST they already knew. PLCopen writes it
as a `<block typeName="AND">`, like any function.

## Semantics

From the standard's element definitions, and where IEC leaves a choice open, this engine's own rule, stated below:

- A contact passes its left link when its variable is ON (normally open) or OFF (closed).
- A P/N contact passes power for one evaluation after its variable rose/fell since its previous evaluation. Its
  memory is updated every evaluation, whatever its left link is doing, and starts FALSE, so a variable already TRUE
  on the first scan is an edge.
- A coil copies its left link to its variable and passes it on; negated, set, reset as IEC says. A P/N coil senses its
  left link.
- A network runs left to right, each element once, and an element sees what the elements before it wrote.
- **Branch order** is left open by IEC. This engine runs the paths that hold a contact or a block first, then the
  paths that are only coils, each group top to bottom (`branchOrder`). So in `|A| [(X), |X| (Y)]` the contact reads X as
  it was before, and in `|A| [|A| (X), |X| (Y)]` it reads the new X.
- What flows past a coil is its left link as computed, not a re-read of the variable: `|A| (/A) (B)` gives B the A
  that was examined. The lowering captures a condition in a temporary only when something later on the rung writes
  a variable it reads (`beforeWrite`), and not at all when nothing reads it afterwards.
- A block behind EN is not called while the rung is off: its outputs hold and ENO is off.
- A function that starts the rung runs every scan the rung reaches it, and what it returned is what flows on, even if
  a later element writes one of its operands: `EQ(IN1 := Step, IN2 := 0, OUT) MOVE(IN := 10, OUT => Step) (Q)` sets
  Q. Rungs run in order, so the next rung's `EQ(IN1 := Step, IN2 := 10, OUT)` sees the 10 in the same scan (the corpus's step sequencer).

- A jump or a RETURN stands at the end of a rung and acts on what reaches it. What stands before it on its rung runs
  first. While a jump's rung is on, every rung after it down to its label is not evaluated at all, so its coils hold
  what they last wrote. The labelled rung runs. ST has no GOTO, so a jump lowers to a flag (`LD_J`, cleared at the top
  of the section, set by the jump rung), and each rung it spans is wrapped `IF NOT (flags) THEN ... END_IF`. Overlapping
  jumps compose. Jumps go down the section only. One back up is a loop, and is refused by name. A jump names a label in its own section,
  and a label names one rung. RETURN lowers to `IF cond THEN RETURN; END_IF;`.

Temporaries (`LD_C` a held condition, `LD_E`/`LD_M` an edge and its memory, `LD_R` the result of a function that
starts a rung, which the view reads to light it) are declared `hidden` in the POU. They are kept
out of what a scene binds by wiring, and written out as their own VAR block when the text exporters convert the
ladder to ST. A FUNCTION cannot hold an edge (it keeps nothing between calls), and says so.

In IEC 61131-3 a POU is written in one language: its body is Structured Text, or it is a ladder. This
engine also reads a POU that mixes the two (statements with a `LADDER` section among them; the organizer marks it
`ST+LD`), because saved programs have that. Nothing here creates one: the organizer makes a PROGRAM in one
language or the other ("Structured Text program", "Ladder program"). PLCopen XML has no form for the mix, so the export
writes such a POU as Structured Text and says so by name (export.ts `exportProgram`). Keep a POU all ladder or
all Structured Text to export it as drawn.

## PLCopen

`toPlcopenXml` writes a ladder POU as an `<LD>` graph (each rung between its own rails, elements linked by
`localId`, a branch as fan-out plus wired OR) and `importPlcopenXml` reads one back by reducing the graph
electrically: union-find over connection points, then series/parallel reduction to one rail-to-rail edge per network.
What has no rung form is named and the POU left out, never half read: a bridge, a value wired box to box, a box with
two rung pins, connectors, a rung wired straight into a variable. A `<jump>` or `<return>` is the end of its
network, read as the rung's last word. A `<label>` and a `<comment>` belong to the network after them in the file
(network comments become rung comments). On write, a rung's comment and label stand ahead of its rails, and
a jump that follows coils is drawn beside them, fed from what feeds them. A coil passes its link on unchanged, so this
means the same, and editors that draw outputs only at the right end can accept it. The reader folds that shape back. A
function that starts a rung is a block the rail links to none of the pins of, with its operands from `inVariable`s
(an edge from the rail's node: EN is optional, and a function without it runs every scan). A box pin with an empty
`formalParameter` names no pin, and two input pins linked into the rung (even from the same place) are two rung
pins. Both cases are named and the POU left out, never guessed. A `vendorElement`, an `addData` or a `documentation` element
in the body carries nothing a rung runs and is skipped, whatever namespace it is under.

The writer uses the tc6_0201 namespace PLCopen publishes a schema for, and IEC's pin names. Its output is schema-valid
(the corpus LD bodies validate against TC6's XSD). The reader also takes the names some tools give the pins of standard blocks
(a counter's R as RESET, LD as LOAD; SR's as SET1/RESET, RS's as SET/RESET1) and maps them back to IEC's
(`IMPORT_PIN_ALIASES` in ladderXml.ts).

To keep the graph plain for any reader, the writer always does three things. Input values come from `inVariable`s
(not an `<expression>` inside an input pin). An output bound to a place is an `<expression>` on the pin (not an
`outVariable` wired to it). Trailing series coils are drawn in parallel (same meaning). The reader orders networks
by document order, not by position, since an exporter may write every position as 0,0.

## Export caveats

`ladderExportCaveats(section)` names what is valid IEC and runs here but that a target's importer may not accept: a
P/N coil, anything after a coil on a rung, a function that starts a path of a branch (a box a contact feeds is fine
on a branch, since its operands hang off its pins), and a comparison of more than two values (IEC chains `GT(a, b, c)`).
All become export warnings.

## Oracles

- The conformance corpus has a `ladder diagram` group: hand-derived goldens, run through both backends in-process.
  The ST oracles (MATIEC, STruC++, OpenPLC) skip them, since they read text and the LADDER text form is only ours.
- `ladderXml.test.ts` round-trips every corpus ladder through `<LD>` and back and checks behaviour is unchanged. It
  reads a file hand-written from TC6's schema alone (every position 0,0, network comments, `addData` under a made-up
  namespace), and checks the refusals (an unnamed pin, a box on the rung by two inputs).
- A timer behind EN reads the clock: skipped scans still count toward its PT (see [Timers read the controller
  clock](st-conformance.md#timers-read-the-controller-clock)).
- **S and R** may be reserved by a target that has S= and R= set / reset assignments. IEC reserves neither, so this
  engine runs them, and every export warns of each (export.ts `setResetNames`).

## The view

A POU is written in one language, and the PLC panel opens it in that language. A POU whose whole body is one LADDER
section opens as rungs, anything else as text, and a program opens on the PROGRAM its controller runs first (StEditor
`openingFace`). "+ New > Ladder program" in the organizer beside the code adds a
PROGRAM with a ladder for its body. A ladder POU's rung text is behind its organizer row's "Show as text". Each ladder
section's header has a Variables pane ([LadderVariables.tsx](../src/editor/components/plc/LadderVariables.tsx) over
[plc/tags.ts](../src/plc/tags.ts)): the POU's
declarations as rows to read, add, retype and delete, a declaration part above the ladder. It
does not rename. A rename follows scope (`renameTag`), but it also moves the scene's wiring in the same commit
(`tagRenamesForScene`), and a pane whose only output is `onEdit(next)` cannot make that commit. A Text | Ladder
switch shows only while some POU holds a section among statements (`mixesLanguages`), the one POU with two faces.
Nothing is remembered per browser. The Ladder face ([LadderView.tsx](../src/editor/components/plc/LadderView.tsx)) draws
every LADDER section of the program as rungs and edits them. It is a view over the text, not a second model.

The sheet draws every element as one of three shapes (a contact, a coil, a box with a row per pin). The elements, how
power passes them, the element bar and how a field is written are in
[ladderLeaf.tsx](../src/editor/components/plc/ladderLeaf.tsx). It shows the problem lines (each error links to its element,
warnings amber), marks the element a problem is about, notes double coils (`duplicateDestructive`), and redraws values
only on the rungs in view. Live values are read by [ladderWatch.ts](../src/editor/components/plc/ladderWatch.ts): the image
indexed once per key set, a bit of a word (`Status.%X3`), and an index that is itself a variable (`A[i]`).

- [plc/ladder/ladderRungs.ts](../src/plc/ladder/ladderRungs.ts) reads rungs out of the source as plain data (operands as written, a
  rung's comment from the comment above it) and prints them back into the same string (`writeLadder`).
- [plc/ladder/ladderEdit.ts](../src/plc/ladder/ladderEdit.ts) is every gesture as a pure transform on rungs: insert, move, delete,
  branch, branch level, stretch a branch end, move a rung, paste. Nothing in it depends on what an element is: it is
  generic over the leaf (`RungOf<L>`). The tools built on it work the same way: Find and Replace
  ([plc/ladder/ladderFind.ts](../src/plc/ladder/ladderFind.ts)) and Cross Reference with its double-coil check
  ([plc/crossRef.ts](../src/plc/crossRef.ts)) read a leaf only through
  [plc/ladder/ladderLeaves.ts](../src/plc/ladder/ladderLeaves.ts), a lazy module the view brings, beside `fieldsOf` / `setField`.
  So is type-ahead ([plc/ladder/ladderComplete.ts](../src/plc/ladder/ladderComplete.ts)). The rest of the first name that continues
  what was typed appears after the caret, selected, and only Enter or Tab accepts it. The field says what it takes
  (`fieldWants`: a contact a BOOL, a TON's PT a TIME), so names of that type are offered first, and after a dot the
  members of what stands before it (`T1.` -> `T1.IN`).
  The view offers them as Find (Ctrl+F, Ctrl+H) and Cross Ref (Ctrl+E). Gated by `e2e/verify-ladder-view-tools.mjs`.
- While the program runs, Toggle Bit (Ctrl+T, or the toolbar) flips the BOOL under the selection once, and a pin's live
  number takes a value on double-click. Both write into the running program between scans
  (`EditorController.togglePlcBit` / `writePlcValue`), never into its text, so a variable the program writes itself is
  overwritten by its next scan. A variable forced in the Watch dock is held instead, and either write changes the held
  value (src/plc/DEVICE-IO.md, "Writes and forces").
- An edit goes into the text editor as one ordinary edit (`StCodeEditorHandle.edit`), so the view's Ctrl+Z is that
  editor's history (and a room's shared one), a save is a save, and a peer sees it as typing. The text editor stays
  mounted under the view for that reason.
- A new element holds a blank, `?` (`|?|`, `T1(IN, PT := ?)`), which parses but does not lower. The rung stays drawable
  and editable and says what is missing. A block from the palette comes with its instance declared in its POU
  (`TON_1 : TON`); a contact or coil naming an undeclared variable offers
  "Declare X : BOOL" on its rung.
- Live, a wire that carries power is lit, and a contact that is closed and a coil that is set are
  drawn on. Power flow is recomputed in the view from the watch image. An edge contact reads the temporary the lowering
  names for it (`LdContact.edge`), and a function that starts the rung reads its result's (`LdBox.result`), both exact.
  That box is drawn with no wire into it, and lit by what it returned.
- The palette's comparisons (GT ... LT) make a function that starts the rung and put it at the front of the selected
  rung, the one place it can stand. MOVE and the arithmetic sit on the rung by EN / ENO where the selection is.
- **What a box can be is one derived list** ([plc/ladder/ladderCatalog.ts](../src/plc/ladder/ladderCatalog.ts) `ladderCatalog`): the
  program's own FUNCTION_BLOCKs and FUNCTIONs (read off its text, the POU being edited left out), then the standard
  library. The standard library is the engine's own blocks and functions (`BUILTIN_FUNCTIONS`, `OPERATOR_FUNCTIONS`,
  every generated `<src>_TO_<dst>`), with pins from the one table they are called by (builtins.ts `standardInputs`).
  The only thing written by hand is a group and a summary per standard name. `ladderCatalog.test.ts` checks it. Every
  entry is inserted as the view inserts it, its blanks named with variables of types the checker accepts, then
  compiled, run, and sent through PLCopen `<LD>` and back, and must run the same. A standard name with no summary
  fails it. A second pin table kept by the ladder would miss functions such as ADD_TIME and the other time functions
  and draw them with one `IN` pin, and this test catches that. The shape it inserts a program's own block in is a
  corpus case: fed by its first BOOL input, carried on by its first BOOL output, a block with no BOOL pair behind EN.
- **Insert Box** (`Block…` on the bar, and Ctrl+B, [BoxPicker.tsx](../src/editor/components/plc/BoxPicker.tsx)) opens
  that list. Type to find (a name that is the query, then starts with it, then holds it, then a summary that does),
  Enter to insert. The bar keeps the few elements most rungs use. Everything else is reached through the picker.
  Everything a box can be goes on the rung through one path (`insertCatalogEntry`), the bar's blocks and functions
  included. A standard block is drawn as the bar draws it (a timer's PT, a counter's PV). A program's own block is
  drawn with every pin blank, for the author to fill, on the rung by its first BOOL input and output (by EN /
  ENO when it lacks either). Emptying a block's pin removes it (IEC leaves every block pin optional), while a
  function's goes back to `?` (`setField`), so unwanted pins are cleared rather than filled. A rung holding a blank
  does not lower, but its blocks are still sketched (ladder.ts `sketch`: their type and declared outputs), so a box
  just inserted is titled and shows what comes out of it.
- **A block's box draws every pin its type declares** (lowering records them: `resolved.inputs` / `outputs`). The ones
  nothing connects are dimmer and in italics: inputs after the inputs written, outputs last. Double-clicking one
  connects it (plc/ladder/ladderLeaves.ts `connectPin`: the pin written blank where IEC draws it) and opens its field, the
  same field every other is typed in. Escape, or leaving it empty, removes it again, and clearing a connected pin's
  field disconnects it. So a block is wired on the sheet alone (a TON's ET, a counter's R and CV, a program's own
  block's outputs) without editing the rung's text.
- **Jump, Label and Return** are on the bar. Return is set directly. Jump and Label open the rung as text with the
  name selected to type over. Jump offers the next label below (a jump only goes down) and Label the first free `L<n>`.
- A PROGRAM drawn here that no task runs says so above its rungs, and is not drawn live. Otherwise its variables
  would show values from the program that is running whenever they share names. That is the main case for this, a
  second version of one program, and a half-lit ladder of a program that is not running is worse than an unlit one.
  `LadderView`'s `idle` prop, filled by the PLC panel.
- Keys are the keymap's (`ladder` mode: arrows walk elements and rungs, Enter edits; Delete and the Ctrl chords are
  the Edit group's).

It is laid out, selected, dragged and cached per rung.

Gated by [e2e/verify-ladder-view.mjs](../e2e/verify-ladder-view.mjs).

## The demo

`createPlcDemoScene`'s program (editor/demo/demoScenes.ts) is one program, each POU in the language that suits it, the way
a real project mixes them: `Palletizer`, the cell's program, in ladder (contacts, coils and steps), calling
`PalletTruck`, the block each pallet truck runs, in Structured Text (arithmetic on route rows), as a box on its rungs.
`DEMO_CONTROLLER` runs `Palletizer` as `Main`, over one set of top-level variables, which is what the scene is wired to. No
POU mixes the two languages, so the PLC panel shows no Text | Ladder switch for it. Each organizer row opens its POU in
its own language, and the panel opens on the rungs of the program `Main` runs.

Each POU has a twin in the other language, and the twins live in `editor/demo/demoReference.ts`, for the tests only:
`PalletizerST` (the cell's program in ST), `PalletTruckLD` (the truck block in ladder) and `PalletizerLD` (the shipped
`Palletizer`, renamed and driving `PalletTruckLD`, derived from the shipped text so there is one ladder palletizer to
maintain). They check that the shipped program is the same machine as the demo all in ST and all in ladder, not three
that look alike:

- `demoScenes.test.ts` runs all three on the same inputs, chosen at random for 12,000 scans. It requires every variable
  they share (the steps, the counts, each truck as its block reports it, the timers, every output) to be equal after
  every scan, and the walk must reach every step of all three state machines.
- `demoScenesSim.test.ts` does the same through the cell. The all-ST twin runs alongside the running shipped program
  (`runProjectTest`'s `lockstep`), fed what the scene feeds it on the same clock, never driving anything.
- `verify-demo-ladder.mjs` presses the buttons.

Three rules make a rung-for-statement translation exact, and they are what to follow when writing another:

- **A `CASE` tests its selector once.** Each state machine copies its step into a snapshot (`MOVE(IN := Step, OUT =>
  armNow)`) and every state rung tests the snapshot. Otherwise a rung that moves the step on would let a later rung run
  in the same scan, which a CASE never does and rungs otherwise do (the corpus's step sequencer).
- **A test that has to see a write gets its own rung**, gated by a coil the writing rung sets (`layerStep`), since the
  rung that wrote it holds the condition it examined.
- **The same variable names as the Structured Text**, which is what lets the comparison cover the machine instead of
  its outputs.

## Not supported

- A comparison in series (`|A| GT(...)`, a box that ANDs its left link). IEC's graphics give
  a box no such element: in a graph, a rung that feeds a comparison feeds its first operand, so a contact before GT
  would compare a BOOL with the other operand. The rung core accepts it only where the rail is the left link.
- A jump back up a section (a loop), and PLCopen connectors / continuations. Bridges (an editor can expand them by
  duplicating contacts).
