#!/usr/bin/env node
// The PLC languages as DATA - what this engine's Structured Text and ladder accept, what they refuse, and
// what the engine says when it refuses:
//
//   npm run capabilities              # human summary
//   npm run capabilities -- --json    # the whole manifest, machine-readable
//   npm run capabilities -- --write   # regenerate public/st-capabilities.json + plc/index.html
//   npm run capabilities -- --check   # fail if either artifact is stale (CI)
//
// `npm run catalog` answers "what parts are there"; this answers "what may I WRITE?", for an
// agent composing a program or an engineer checking whether their code will paste in.
//
// It cannot drift, because nothing here is transcribed. The supported surface is enumerated
// from the engine's own tables (SCALAR_TYPES, FB_TYPES, BUILTIN_FUNCTIONS, KEYWORDS), and every
// feature below is probed through the real `compile()`, recording whatever came back, including
// the rejection message. The questions are authored here; every answer comes from the engine.
//
// A verdict that contradicts a probe's `intent` is a hard error, not a quiet diff, so a feature
// landing (or regressing) shows up as "flip its intent" in the commit that did it.
//
// Exit 0 = manifest emitted / artifacts current, 1 = a probe contradicted its intent or an
// artifact is stale, 2 = usage/IO error.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

import { renderPlcPage } from './lib/plc-page.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(repo, 'public', 'st-capabilities.json')
const PAGE_PATH = join(repo, 'plc', 'index.html')

const argv = process.argv.slice(2)
const MODES = ['--json', '--write', '--check']
const unknown = argv.filter((a) => !MODES.includes(a))
if (unknown.length > 0) {
  console.error(`usage: npm run capabilities -- [--json|--write|--check]  (unexpected: ${unknown.join(' ')})`)
  process.exit(2)
}
const asJson = argv.includes('--json')
const write = argv.includes('--write')
const check = argv.includes('--check')

// ---- the probes ------------------------------------------------------------------------
//
// `intent` is what this repo believes the engine does, and the generator FAILS if the engine
// disagrees:
//
//   supported - ordinary ST inside the subset; must compile
//   unsupported - the subset stops here; must be refused, and the engine's reason is recorded
//   strict - refused because a real IEC compiler refuses it too: accepting it
//                 would build in the sim and fail on the target. Most were found by the oracle.
//   permissive - accepted here, but a strict compiler refuses it or the target's runtime does
//                 something this one cannot. Listed, not hidden: the same portability failure.
//
// `note` is only for the last two, where the engine's own message cannot say what a TARGET
// does with the same text.

const PROBES = [
  // ---- control flow ----
  { id: 'if', category: 'Control flow', intent: 'supported', title: 'IF / ELSIF / ELSE',
    st: 'VAR_INPUT n : INT; END_VAR VAR_OUTPUT q : INT; END_VAR\nIF n > 10 THEN q := 2; ELSIF n > 0 THEN q := 1; ELSE q := 0; END_IF;' },
  { id: 'case', category: 'Control flow', intent: 'supported', title: 'CASE with lists and lo..hi ranges',
    st: 'VAR_INPUT n : INT; END_VAR VAR_OUTPUT q : INT; END_VAR\nCASE n OF\n  1, 3: q := 1;\n  4..9: q := 2;\n  -1: q := 9;\nELSE q := 0;\nEND_CASE;' },
  { id: 'for', category: 'Control flow', intent: 'supported', title: 'FOR with BY',
    st: 'VAR i : INT; sum : INT; END_VAR\nFOR i := 10 TO 0 BY -2 DO sum := sum + i; END_FOR;' },
  { id: 'while-repeat', category: 'Control flow', intent: 'supported', title: 'WHILE and REPEAT ... UNTIL',
    st: 'VAR i : INT; j : INT; END_VAR\nWHILE i < 5 DO i := i + 1; END_WHILE;\nREPEAT j := j + 1; UNTIL j >= 5 END_REPEAT;' },
  { id: 'exit-continue-return', category: 'Control flow', intent: 'supported', title: 'EXIT, CONTINUE, RETURN',
    st: 'VAR i : INT; n : INT; END_VAR\nFOR i := 1 TO 10 DO\n  IF i = 3 THEN CONTINUE; END_IF;\n  IF i = 8 THEN EXIT; END_IF;\n  n := n + 1;\nEND_FOR;\nRETURN;' },

  // ---- POUs ----
  { id: 'function-block', category: 'POUs', intent: 'supported', title: 'User FUNCTION_BLOCK, named inputs and => output bindings',
    st: 'FUNCTION_BLOCK Motor\nVAR_INPUT Run : BOOL; END_VAR\nVAR_OUTPUT Spinning : BOOL; END_VAR\nSpinning := Run;\nEND_FUNCTION_BLOCK\n\nVAR M1 : Motor; lamp : BOOL; END_VAR\nM1(Run := TRUE, Spinning => lamp);' },
  { id: 'function', category: 'POUs', intent: 'supported', title: 'Stateless FUNCTION (returns by assigning its own name)',
    st: 'FUNCTION Double : INT\nVAR_INPUT x : INT; END_VAR\nDouble := x * 2;\nEND_FUNCTION\n\nVAR r : INT; END_VAR\nr := Double(21);' },
  { id: 'fb-shadow', category: 'POUs', intent: 'supported', title: 'A user block may shadow a standard one (TON is not reserved)',
    st: 'FUNCTION_BLOCK TON\nVAR_INPUT IN : BOOL; END_VAR\nVAR_OUTPUT Q : BOOL; END_VAR\nQ := IN;\nEND_FUNCTION_BLOCK\n\nVAR t : TON; q : BOOL; END_VAR\nt(IN := TRUE, Q => q);' },
  { id: 'positional-fb-args', category: 'POUs', intent: 'supported', title: 'Positional arguments, in the block’s own declaration order',
    st: 'VAR t : TON; END_VAR\nt(TRUE, T#1s);' },
  { id: 'var-in-out', category: 'POUs', intent: 'supported', title: 'VAR_IN_OUT binds a place, so the block writes the caller’s array',
    st: 'FUNCTION_BLOCK Fill\nVAR_IN_OUT buf : ARRAY [1..4] OF INT; END_VAR\nVAR i : INT; END_VAR\nFOR i := 1 TO 4 DO buf[i] := i; END_FOR;\nEND_FUNCTION_BLOCK\n\nVAR f : Fill; data : ARRAY [1..4] OF INT; END_VAR\nf(buf := data);' },
  { id: 'fb-array', category: 'POUs', intent: 'supported', title: 'An array of function-block instances, called by index',
    st: 'VAR eyes : ARRAY [1..4] OF BOOL; delay : ARRAY [1..4] OF TON; jam : ARRAY [1..4] OF BOOL; i : INT; END_VAR\nFOR i := 1 TO 4 DO\n  delay[i](IN := eyes[i], PT := T#3s);\n  jam[i] := delay[i].Q;\nEND_FOR;' },
  { id: 'fb-in-struct', category: 'POUs', intent: 'supported', title: 'A function-block instance as a struct field',
    st: 'TYPE Merge : STRUCT gap : TON; count : CTU; END_STRUCT; END_TYPE\nVAR m : Merge; eye : BOOL; open : BOOL; END_VAR\nm.gap(IN := NOT eye, PT := T#500ms);\nm.count(CU := eye, PV := 100);\nopen := m.gap.Q;' },
  { id: 'struct-copy', category: 'Declarations', intent: 'supported', title: 'Whole structs and arrays assign as values',
    st: 'TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE\nVAR a : Pkg; b : Pkg; track : ARRAY [0..3] OF Pkg; i : INT; END_VAR\nb := a;\nFOR i := 3 TO 1 BY -1 DO track[i] := track[i - 1]; END_FOR;' },
  { id: 'struct-io', category: 'POUs', intent: 'supported', title: 'Structs in and out: by-value inputs, readable outputs, struct results',
    st: 'TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE\nFUNCTION Make : Pkg\nVAR_INPUT id : DINT; END_VAR\nMake.id := id;\nEND_FUNCTION\n\nFUNCTION_BLOCK Latch\nVAR_INPUT p : Pkg; END_VAR\nVAR_OUTPUT held : Pkg; END_VAR\nheld := p;\nEND_FUNCTION_BLOCK\n\nVAR l : Latch; box : Pkg; copy : Pkg; n : DINT; END_VAR\nbox := Make(7);\nl(p := box, held => copy);\nn := l.held.id;' },
  { id: 'formal-function-call', category: 'POUs', intent: 'supported', title: 'A formal FUNCTION call, naming its arguments in any order',
    st: 'FUNCTION Span : INT\nVAR_INPUT lo : INT; hi : INT; END_VAR\nSpan := hi - lo;\nEND_FUNCTION\n\nVAR n : INT; END_VAR\nn := Span(hi := 10, lo := 3);' },
  { id: 'plcopen-motion', category: 'Library', intent: 'supported', title: 'The PLCopen motion blocks on an AXIS_REF (MC_Power, MC_MoveAbsolute, MC_MoveVelocity, MC_Halt, MC_Stop, MC_Home, ...)',
    st: 'VAR Ax : AXIS_REF; pwr : MC_Power; mv : MC_MoveAbsolute; END_VAR\npwr(Axis := Ax, Enable := TRUE);\nmv(Axis := Ax, Execute := pwr.Status, Position := 10, Velocity := 20, Acceleration := 100, Deceleration := 100);',
    note: 'A subset of the PLCopen Function Blocks for Motion Control (version 2.0, single axis; not certified), with this engine\'s choices where PLCopen leaves one written down in docs/motion-control.md: trapezoidal moves (a block\'s Jerk input is accepted and ignored), an abort, BufferMode Buffered (a queue of moves), the Busy / Done / Active / CommandAborted / Error handshake, software limits. On a real controller the blocks come from its own PLCopen motion library, so an export writes the calls and not the blocks; the Blending buffer modes (a block given one raises Error), gearing, cams and axis groups are not here.' },
  { id: 'standard-named-args', category: 'Library', intent: 'supported', title: 'A standard function called with IEC’s parameter names (LIMIT(MN := 0, IN := x, MX := 10))',
    st: 'VAR x : INT := 50; n : INT; s : STRING := \'conveyor\'; t : STRING; END_VAR\nn := LIMIT(MN := 0, IN := x, MX := 10);\nt := MID(IN := s, L := 3, P := 2);' },
  { id: 'omitted-input', category: 'POUs', intent: 'supported', title: 'A formal FUNCTION call that leaves an input at its initial value',
    st: 'FUNCTION Scale : INT\nVAR_INPUT v : INT; gain : INT := 2; END_VAR\nScale := v * gain;\nEND_FUNCTION\n\nVAR n : INT; END_VAR\nn := Scale(v := 21);' },
  { id: 'qualified-enum', category: 'Declarations', intent: 'supported', title: 'An enumeration value written with its type (Mode#Idle)',
    st: 'TYPE Mode : (Idle, Running); END_TYPE\nVAR m : Mode := Mode#Idle; END_VAR\nIF m = Mode#Idle THEN m := Mode#Running; END_IF;' },
  { id: 'power-operator', category: 'Library', intent: 'supported', title: '** exponentiation (EXPT)',
    st: 'VAR a : REAL; END_VAR\na := 2.0 ** 10.0;' },

  // ---- declarations ----
  { id: 'multi-name-decl', category: 'Declarations', intent: 'supported', title: 'Several names on one declaration line',
    st: 'VAR x, y, z : INT := 3; END_VAR\nx := y + z;' },
  { id: 'constant', category: 'Declarations', intent: 'supported', title: 'CONSTANT',
    st: 'VAR CONSTANT Limit : INT := 100; END_VAR VAR n : INT; END_VAR\nn := Limit;' },
  { id: 'var-global', category: 'Declarations', intent: 'supported', title: 'VAR_GLOBAL, shared by every POU',
    st: 'VAR_GLOBAL Shared : INT := 5; END_VAR\nVAR n : INT; END_VAR\nn := Shared;' },
  { id: 'global-fb', category: 'Declarations', intent: 'supported', title: 'A function-block instance in VAR_GLOBAL',
    st: 'VAR_GLOBAL t : TON; END_VAR\nVAR q : BOOL; END_VAR\nt(IN := TRUE, PT := T#1s);\nq := t.Q;' },
  { id: 'struct', category: 'Declarations', intent: 'supported', title: 'TYPE ... STRUCT, nested access paths',
    st: 'TYPE Inner : STRUCT a : INT; END_STRUCT; END_TYPE\nTYPE Outer : STRUCT\n  inner : Inner;\n  data : ARRAY [1..3] OF INT;\nEND_STRUCT; END_TYPE\nVAR p : Outer; n : INT; END_VAR\nn := p.inner.a + p.data[2];' },
  { id: 'array', category: 'Declarations', intent: 'supported', title: 'Multi-dimensional ARRAY with a repeated initialiser',
    st: 'VAR grid : ARRAY [1..2, 0..3] OF INT := [1, 2, 6(0)]; n : INT; END_VAR\nn := grid[2, 1];' },
  { id: 'enum', category: 'Declarations', intent: 'supported', title: 'Enumerations are their own type',
    st: 'TYPE Mode : (Idle, Running := 10, Fault); END_TYPE\nVAR m : Mode := Running; n : INT; END_VAR\nCASE m OF\n  Idle: n := 0;\n  Running: n := 1;\n  Fault: n := 2;\nEND_CASE;' },
  { id: 'subrange', category: 'Declarations', intent: 'supported', title: 'Subranges, enforced on every store',
    st: 'TYPE Percent : INT (0..100); END_TYPE\nVAR p : Percent := 50; END_VAR\np := 60;' },

  // ---- types and literals ----
  { id: 'integer-families', category: 'Types', intent: 'supported', title: 'Signed, unsigned and bit-string families, kept apart',
    st: 'VAR\n  si : SINT; i : INT; di : DINT;\n  usi : USINT; ui : UINT; udi : UDINT;\n  b : BYTE; w : WORD; dw : DWORD;\nEND_VAR\ni := i + 1;\nui := ui + 1;\nw := w AND 16#00FF;' },
  { id: 'real-lreal', category: 'Types', intent: 'supported', title: 'REAL (single precision) and LREAL',
    st: 'VAR r : REAL := 0.4; l : LREAL; END_VAR\nl := r;' },
  { id: 'time', category: 'Types', intent: 'supported', title: 'TIME is a duration, not a number',
    st: 'VAR t : TIME := T#1m30s; u : TIME; n : DINT; END_VAR\nu := t + T#500ms;\nn := TIME_TO_DINT(u);' },
  { id: 'calendar', category: 'Types', intent: 'supported', title: 'DATE, TIME_OF_DAY and DATE_AND_TIME, with IEC’s arithmetic table',
    st: 'VAR d : DATE := D#2024-02-29; t : TOD := TOD#08:00:00; x : DT; gap : TIME; END_VAR\nx := CONCAT_DATE_TOD(d, t) + T#90m;\ngap := x - DT#2024-02-29-00:00:00;' },
  { id: 'time-library', category: 'Library', intent: 'supported', title: 'The time and date functions (ADD_TIME, SUB_DT_DT, CONCAT_DATE_TOD, ...)',
    st: 'VAR a : TIME := T#1s; b : TIME; t : TOD := TOD#12:00:00; END_VAR\nb := ADD_TIME(a, T#500ms);\nt := ADD_TOD_TIME(t, MULTIME(b, 2));' },
  { id: 'string', category: 'Types', intent: 'supported', title: 'STRING with a capacity, and IEC $ escapes',
    st: "VAR s : STRING[20] := 'line$N'; n : INT; END_VAR\ns := CONCAT(s, 'more');\nn := LEN(s);" },
  { id: 'string-order', category: 'Types', intent: 'supported', title: 'STRING compares and sorts, but has no +',
    st: "VAR\n  a : STRING := 'abc';\n  b : STRING := 'abd';\n  lo : STRING; q : BOOL;\nEND_VAR\nq := a < b;\nlo := MIN(a, b);" },
  { id: 'literals', category: 'Types', intent: 'supported', title: 'Based, typed, exponent and separated literals',
    st: 'VAR\n  h : WORD := 16#FF;\n  bits : BYTE := 2#1010_1010;\n  oct : INT := 8#17;\n  typed : INT := INT#5;\n  r : REAL := 1.0E-3;\nEND_VAR\nh := h OR WORD#16#0F;' },
  { id: 'bool-0-1', category: 'Types', intent: 'supported', title: '0 and 1 are BOOL literals (the standard’s own examples use them)',
    st: 'VAR_OUTPUT Q : BOOL := 0; END_VAR\nQ := 1;' },
  { id: 'ampersand', category: 'Types', intent: 'supported', title: '& is AND',
    st: 'VAR a : BOOL; b : BOOL; q : BOOL; END_VAR\nq := a & b;' },
  { id: 'case-insensitive', category: 'Types', intent: 'supported', title: 'Identifiers are case-insensitive',
    st: 'VAR Motor : BOOL; END_VAR\nmotor := TRUE;' },
  { id: 'comments', category: 'Types', intent: 'supported', title: '(* ... *) comments, anywhere trivia may go',
    st: '(* a header comment *)\nVAR n : INT; END_VAR\nn := 1; (* trailing *)' },

  // ---- library ----
  { id: 'standard-fbs', category: 'Library', intent: 'supported', title: 'Timers, counters and edge detectors',
    st: 'VAR\n  t : TON; f : TOF; p : TP;\n  r : R_TRIG; ft : F_TRIG;\n  cu : CTU; cd : CTD; ud : CTUD;\n  s : SR; rs : RS;\nEND_VAR\nt(IN := TRUE, PT := T#1s);\ncu(CU := t.Q, PV := 10);' },
  { id: 'conversions', category: 'Library', intent: 'supported', title: 'The <SRC>_TO_<DST> conversion family',
    st: "VAR i : INT := 7; r : REAL; w : WORD; s : STRING; END_VAR\nr := INT_TO_REAL(i);\nw := INT_TO_WORD(i);\ns := INT_TO_STRING(i);\ni := STRING_TO_INT('42');" },
  { id: 'comparison-chain', category: 'Library', intent: 'supported', title: 'Functional operator forms, including comparison chains',
    st: 'VAR\n  a : INT := 3; b : INT := 2; c : INT := 1;\n  q : BOOL; n : INT;\nEND_VAR\nq := GT(a, b, c);\nn := ADD(a, b, c);' },
  { id: 'string-library', category: 'Library', intent: 'supported', title: 'The nine IEC string functions, 1-based',
    st: "VAR s : STRING := 'hello world'; part : STRING; at : INT; END_VAR\npart := MID(s, 5, 1);\nat := FIND(s, 'world');\npart := REPLACE(s, 'X', 1, 1);" },

  // ---- the subset boundary: types the standard has and this engine does not ----
  { id: 'lint', category: 'Types the subset lacks', intent: 'unsupported', title: 'LINT (64-bit signed)', st: 'VAR n : LINT; END_VAR' },
  { id: 'ulint', category: 'Types the subset lacks', intent: 'unsupported', title: 'ULINT (64-bit unsigned)', st: 'VAR n : ULINT; END_VAR' },
  { id: 'lword', category: 'Types the subset lacks', intent: 'unsupported', title: 'LWORD (64-bit bit string)', st: 'VAR n : LWORD; END_VAR' },
  { id: 'wstring', category: 'Types the subset lacks', intent: 'unsupported', title: 'WSTRING', st: 'VAR s : WSTRING; END_VAR' },
  { id: 'wstring-literal', category: 'Types the subset lacks', intent: 'unsupported', title: 'A double-quoted (WSTRING) literal',
    st: 'VAR s : STRING; END_VAR\ns := "wide";' },
  { id: 'ldt', category: 'Types the subset lacks', intent: 'unsupported', title: 'LDATE, LTOD, LDT (64-bit calendar types)', st: 'VAR x : LDT; END_VAR' },

  // ---- the subset boundary: declarations and configuration ----
  { id: 'var-external', category: 'Declarations', intent: 'supported', title: 'VAR_EXTERNAL, checked against the VAR_GLOBAL it names',
    st: 'VAR_GLOBAL Shared : INT; END_VAR\nVAR_EXTERNAL Shared : INT; END_VAR\nShared := 1;' },
  { id: 'located', category: 'Declarations', intent: 'supported', title: 'Located variables at inputs and outputs (AT %IX0.0, AT %QW4)',
    st: 'VAR\n  Eye AT %IX100.0 : BOOL;\n  Run AT %QX100.0 : BOOL;\n  Count AT %IW2 : INT;\nEND_VAR\nRun := NOT Eye;',
    note: 'The address is how the variable meets the world: a scene part whose PLC tag is %IX100.0 feeds it, and an external controller reaches it at that address. Declared in VAR (or VAR_GLOBAL), one variable per address, and the type has to fit the size (a bit holds BOOL, a word INT, UINT or WORD). A function block or function cannot locate a variable.' },
  { id: 'located-memory', category: 'Declarations', intent: 'supported', title: 'Located variables in memory (AT %MW0, %MD1, %MX8.0)',
    st: 'VAR\n  Count AT %MW0 : INT;\n  Total AT %MD1 : DINT;\n  Flag AT %MX8.0 : BOOL;\nEND_VAR\nCount := Count + 1;\nFlag := Count > 3;',
    note: 'Storage the program keeps, read and written by name: OpenPLC keeps a SCADA\u2019s values at %MW and %MD, so its programs carry these. No scene part binds a memory address; the OPC UA server publishes the variable by name.' },

  // ---- tasks and programs: a CONFIGURATION runs PROGRAM instances on tasks, on sim time ----
  { id: 'program-pou', category: 'Tasks and programs', intent: 'supported', title: 'A PROGRAM ... END_PROGRAM, which with no CONFIGURATION runs on the scan time',
    st: 'PROGRAM Main\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM' },
  { id: 'configuration', category: 'Tasks and programs', intent: 'supported', title: 'CONFIGURATION / RESOURCE / TASK, each task on its own INTERVAL',
    st: 'PROGRAM Main\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n\nCONFIGURATION Cfg\n  RESOURCE Res ON PLC\n    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);\n    TASK Slow(INTERVAL := T#100ms, PRIORITY := 2);\n    PROGRAM A WITH Fast : Main;\n    PROGRAM B WITH Slow : Main;\n  END_RESOURCE\nEND_CONFIGURATION',
    note: 'Tasks run on SIM time: each comes due when its INTERVAL elapses, and tasks due together run by PRIORITY (0 first). A scan takes no sim time, so no task interrupts another. An instance variable is addressed as Instance.Name in the watch table and by scene tags.' },
  { id: 'continuous-program', category: 'Tasks and programs', intent: 'supported', title: 'A PROGRAM instance with no task, which runs continuously',
    st: 'PROGRAM Main\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n\nCONFIGURATION Cfg\n  RESOURCE Res ON PLC\n    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM A WITH Fast : Main;\n    PROGRAM Always : Main;\n  END_RESOURCE\nEND_CONFIGURATION',
    note: 'IEC gives a program with no task the lowest priority and re-runs it as soon as it finishes; on a sim clock that is once per physics step, after that step\'s periodic scans.' },
  { id: 'configuration-body', category: 'Tasks and programs', intent: 'supported', title: 'Code outside every POU beside a CONFIGURATION, run by an instance that names no type',
    st: 'VAR n : INT; END_VAR\nn := n + 1;\n\nCONFIGURATION Cfg\n  RESOURCE Res ON PLC\n    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM Main WITH Fast;\n  END_RESOURCE\nEND_CONFIGURATION',
    note: "An extension: the variables are the program's top-level variables, seen by every POU under their bare names, and the statements run from the program instance with no type. Export writes that code as a PROGRAM of its own." },
  { id: 'event-task', category: 'Tasks and programs the subset lacks', intent: 'unsupported', title: 'An event task (SINGLE)',
    st: 'VAR_GLOBAL go : BOOL; END_VAR\nPROGRAM Main\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\n\nCONFIGURATION Cfg\n  RESOURCE Res ON PLC\n    TASK OnEdge(SINGLE := go, PRIORITY := 1);\n    PROGRAM A WITH OnEdge : Main;\n  END_RESOURCE\nEND_CONFIGURATION' },
  { id: 'program-wiring', category: 'Tasks and programs the subset lacks', intent: 'unsupported', title: "Wiring a PROGRAM instance's inputs and outputs in the CONFIGURATION",
    st: 'VAR_GLOBAL go : BOOL; END_VAR\nPROGRAM Main\nVAR_INPUT start : BOOL; END_VAR\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\n\nCONFIGURATION Cfg\n  RESOURCE Res ON PLC\n    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM A WITH Fast : Main (start := go);\n  END_RESOURCE\nEND_CONFIGURATION' },
  { id: 'multiple-resources', category: 'Tasks and programs the subset lacks', intent: 'unsupported', title: 'More than one RESOURCE in a CONFIGURATION',
    st: 'PROGRAM Main\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\n\nCONFIGURATION Cfg\n  RESOURCE A ON PLC\n    TASK T1(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM P1 WITH T1 : Main;\n  END_RESOURCE\n  RESOURCE B ON PLC\n    TASK T2(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM P2 WITH T2 : Main;\n  END_RESOURCE\nEND_CONFIGURATION' },
  { id: 'type-alias', category: 'Declarations', intent: 'supported', title: 'A plain type alias (TYPE Count : INT)',
    st: 'TYPE Count : INT; END_TYPE\nVAR n : Count; END_VAR' },
  { id: 'named-array-type', category: 'Declarations', intent: 'supported', title: 'A named array type, one type under its name',
    st: 'TYPE Row : ARRAY [1..3] OF INT; END_TYPE\nVAR a : Row; b : Row := [1, 2, 3]; END_VAR\na := b;' },
  { id: 'constant-bounds', category: 'Declarations', intent: 'supported', title: 'Array bounds written as named CONSTANTs',
    st: 'VAR CONSTANT ZONES : INT := 4; END_VAR\nVAR eyes : ARRAY [0..ZONES - 1] OF BOOL; END_VAR\neyes[ZONES - 1] := TRUE;' },
  { id: 'struct-init', category: 'Declarations', intent: 'supported', title: 'Structured initial values: (field := value), and arrays of them',
    st: 'TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE\nVAR p : Pkg := (id := 7, dest := 3); lane : ARRAY [1..2] OF Pkg := [(id := 1), (id := 2)]; END_VAR\np.dest := 4;' },

  // ---- the subset boundary: statements and library ----
  { id: 'fb-call-expression', category: 'Statements the subset lacks', intent: 'unsupported', title: 'A function-block call used as an expression',
    st: 'VAR t : TON; q : BOOL; END_VAR\nq := t(IN := TRUE, PT := T#1s);' },
  { id: 'string-case-extension', category: 'Statements the subset lacks', intent: 'unsupported', title: 'Vendor string extensions (TO_UPPER, TRIM, ...)',
    st: "VAR s : STRING := 'abc'; END_VAR\ns := TO_UPPER(s);" },

  // ---- the subset boundary: the other IEC languages ----
  { id: 'sfc-step', category: 'Other IEC languages', intent: 'unsupported', title: 'Sequential Function Chart (STEP / TRANSITION / ACTION)',
    st: 'INITIAL_STEP Idle:\nEND_STEP\nTRANSITION FROM Idle TO Running := start;\nEND_TRANSITION' },

  // ---- 3rd-edition object orientation, on function blocks ----
  { id: 'method', category: 'Object orientation', intent: 'supported', title: 'METHOD on a function block: a result, outputs, in-outs, temporaries that start over each call',
    st: 'FUNCTION_BLOCK Acc\nVAR n : INT; END_VAR\nMETHOD Put : INT\n  VAR_INPUT v : INT; END_VAR\n  n := n + v;\n  Put := n;\nEND_METHOD\nEND_FUNCTION_BLOCK\n\nVAR a : Acc; r1 : INT; END_VAR\nr1 := a.Put(v := 3) + a.Put(4);' },
  { id: 'extends', category: 'Object orientation', intent: 'supported', title: 'EXTENDS, overrides, SUPER^.M() and SUPER^(), ABSTRACT, FINAL, OVERRIDE',
    st: 'FUNCTION_BLOCK ABSTRACT Shape\nMETHOD ABSTRACT Area : REAL\nEND_METHOD\nMETHOD Twice : REAL\n  Twice := 2.0 * Area();\nEND_METHOD\nEND_FUNCTION_BLOCK\n\nFUNCTION_BLOCK Square EXTENDS Shape\nVAR_INPUT side : REAL; END_VAR\nMETHOD OVERRIDE Area : REAL\n  Area := side * side;\nEND_METHOD\nEND_FUNCTION_BLOCK\n\nVAR sq : Square; a : REAL; END_VAR\nsq(side := 3.0);\na := sq.Twice();',
    note: 'A method called on THIS (THIS.M(), or by its bare name) runs the override of the instance\'s own class. A derived block runs its own body, not its base\'s, unless it calls SUPER^(). IEC writes THIS with no ^ and SUPER with one; THIS^ is refused by name.' },
  { id: 'interface', category: 'Object orientation', intent: 'supported', title: 'INTERFACE, IMPLEMENTS, and variables of an interface type',
    st: 'INTERFACE IDrive\n  METHOD Travel : INT\n    VAR_INPUT dist : INT; END_VAR\n  END_METHOD\nEND_INTERFACE\n\nFUNCTION_BLOCK Belt IMPLEMENTS IDrive\nVAR p : INT; END_VAR\nMETHOD Travel : INT\n  VAR_INPUT dist : INT; END_VAR\n  p := p + dist;\n  Travel := p;\nEND_METHOD\nEND_FUNCTION_BLOCK\n\nVAR belt : Belt; d : IDrive; x : INT; END_VAR\nd := belt;\nIF d <> NULL THEN x := d.Travel(dist := 2); END_IF;',
    note: 'An interface variable that refers to no instance is NULL (compared with NULL, or 0); a call through it faults the scan. STruC++ 0.6.2, OpenPLC\'s compiler, has no interface variables yet, so a program that uses them does not build for OpenPLC.' },
  { id: 'ref-to', category: 'Object orientation', intent: 'supported', title: 'REF_TO, REF(), ^ and NULL: IEC references',
    st: 'TYPE Pkg : STRUCT id : INT; END_STRUCT; END_TYPE\nVAR zones : ARRAY [1..3] OF Pkg; z : REF_TO Pkg; z2 : REF_TO Pkg; ok : BOOL; END_VAR\nz := REF(zones[2]);\nz^.id := 9;\nz2 := z;\nok := z2 <> NULL;',
    note: 'A reference is a variable of a POU (or a block\'s or method\'s input, given by the call), never a struct field or an array element here. It is given REF(place), another REF_TO or NULL, compared with NULL, and dereferenced with ^; dereferencing one that is NULL faults the scan.' },
  { id: 'class', category: 'Object orientation the subset lacks', intent: 'unsupported', title: 'CLASS', st: 'CLASS Tank\nVAR level : INT; END_VAR\nEND_CLASS' },
  { id: 'namespace', category: 'Object orientation the subset lacks', intent: 'unsupported', title: 'NAMESPACE', st: 'NAMESPACE Plant\nEND_NAMESPACE' },
  { id: 'pointer', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'POINTER TO', st: 'VAR p : POINTER TO INT; END_VAR',
    note: 'Not IEC 61131-3. Declare REF_TO, take a reference with REF() and dereference it with ^.' },
  { id: 'property', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'PROPERTY with GET and SET',
    st: 'FUNCTION_BLOCK Motor\nVAR spd : INT; END_VAR\nPROPERTY Speed : INT\n  GET\n    Speed := spd;\n  END_GET\nEND_PROPERTY\nEND_FUNCTION_BLOCK',
    note: 'Not IEC 61131-3. Use a METHOD (or a pair of methods).' },
  { id: 'var-inst', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'VAR_INST in a METHOD',
    st: 'FUNCTION_BLOCK M\nMETHOD Count : INT\n  VAR_INST n : INT; END_VAR\n  n := n + 1;\n  Count := n;\nEND_METHOD\nEND_FUNCTION_BLOCK',
    note: 'Not IEC 61131-3. Declare the variable in the FUNCTION_BLOCK\'s VAR, where it keeps its value between calls.' },
  { id: 'reference-to', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'REFERENCE TO, REF= and __ISVALIDREF',
    st: 'VAR a : INT; r : REFERENCE TO INT; END_VAR\nr REF= a;',
    note: 'Not IEC 61131-3. Declare REF_TO, give it REF(place), dereference it with ^, and compare it with NULL.' },
  { id: 'this-caret', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'THIS^',
    st: 'FUNCTION_BLOCK M\nVAR n : INT; END_VAR\nMETHOD Get : INT\n  Get := THIS^.n;\nEND_METHOD\nEND_FUNCTION_BLOCK',
    note: 'IEC 61131-3 writes THIS with no ^: THIS.n, THIS.Method(). (SUPER keeps its ^: SUPER^.Method(), SUPER^().)' },
  { id: 'and-then', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'AND_THEN and OR_ELSE',
    st: 'VAR d : INT; ok : BOOL; END_VAR\nok := d <> 0 AND_THEN 10 / d > 1;',
    note: 'Not IEC 61131-3. Guard with nested IF statements (IF d <> 0 THEN IF 10 / d > 1 THEN ...), or write AND / OR, which evaluate both sides.' },
  { id: 'struct-extends', category: 'Vendor extensions, refused by name', intent: 'unsupported', title: 'STRUCT EXTENDS',
    st: 'TYPE ST_A : STRUCT x : INT; END_STRUCT; END_TYPE\nTYPE ST_B EXTENDS ST_A : STRUCT y : INT; END_STRUCT; END_TYPE',
    note: 'Not IEC 61131-3, which derives only function blocks and interfaces. Declare the base\'s fields in the struct, or hold the base as one field.' },
  { id: 'method-struct-result', category: 'Object orientation', intent: 'supported', title: 'A METHOD returning a whole structure or named array',
    st: 'TYPE Pkg : STRUCT id : INT; END_STRUCT; END_TYPE\nFUNCTION_BLOCK Sorter\nMETHOD Make : Pkg\n  VAR_INPUT id : INT; END_VAR\n  Make.id := id;\nEND_METHOD\nEND_FUNCTION_BLOCK\n\nVAR s1 : Sorter; box : Pkg; END_VAR\nbox := s1.Make(id := 7);' },
  { id: 'interface-array', category: 'Object orientation', intent: 'supported', title: 'An ARRAY OF an interface, each element pointed at an instance',
    st: 'INTERFACE IDrive\n  METHOD Travel : INT\n    VAR_INPUT dist : INT; END_VAR\n  END_METHOD\nEND_INTERFACE\n\nVAR drives : ARRAY [1..4] OF IDrive; i : INT; x : INT; END_VAR\nFOR i := 1 TO 4 DO\n  IF drives[i] <> NULL THEN x := x + drives[i].Travel(dist := 1); END_IF;\nEND_FOR;' },
  { id: 'reference-array', category: 'Object orientation the subset lacks', intent: 'unsupported', title: 'An ARRAY OF REF_TO',
    st: 'VAR refs : ARRAY [1..3] OF REF_TO INT; END_VAR',
    note: 'IEC allows it; this engine does not implement it yet. Keep the references as variables of their own.' },

  // ---- strictness: refused here because a real compiler refuses it ----
  { id: 'bitstring-arithmetic', category: 'Refused for portability', intent: 'strict', title: 'Arithmetic on a bit string',
    st: 'VAR b : BYTE := 255; r : BYTE; END_VAR\nr := b + 1;',
    note: 'Arithmetic is ANY_NUM; BYTE/WORD/DWORD are ANY_BIT. MATIEC refuses it, so a program that built here would build on no target.' },
  { id: 'bitwise-on-number', category: 'Refused for portability', intent: 'strict', title: 'A bitwise operation on a number',
    st: 'VAR i : INT := 1; j : INT := 2; r : INT; END_VAR\nr := i AND j;',
    note: 'The mirror of the rule above. Write INT_TO_WORD(...) and operate on the bit string.' },
  { id: 'not-on-number', category: 'Refused for portability', intent: 'strict', title: 'NOT on a number',
    st: 'VAR i : INT := 1; r : INT; END_VAR\nr := NOT i;',
    note: 'Complement is defined on ANY_BIT. MATIEC refuses it too.' },
  { id: 'shift-signed', category: 'Refused for portability', intent: 'strict', title: 'Shifting a signed integer',
    st: 'VAR i : INT := 8; r : INT; END_VAR\nr := SHR(i, 1);',
    note: 'SHL/SHR/ROL/ROR take a bit string, where the vacated bits are defined.' },
  { id: 'missing-separator', category: 'Refused for portability', intent: 'strict', title: 'A missing statement separator',
    st: 'VAR n : INT; END_VAR\nn := 1\nn := 2;',
    note: 'Between two statements. The one after END_IF, END_CASE, END_FOR, END_WHILE and END_REPEAT may be left out, a tolerated input form; see "Tolerated input forms".' },
  { id: 'narrowing-store', category: 'Refused for portability', intent: 'strict', title: 'A narrowing store without the conversion',
    st: 'VAR r : REAL := 1.5; i : INT; END_VAR\ni := r;',
    note: 'Only IEC’s safe widenings are implicit. The error names the conversion to write.' },
  { id: 'string-members', category: 'Refused for portability', intent: 'strict', title: 'A STRING taken apart by members (S.LEN, S.DATA[i])',
    st: 'VAR s : STRING; n : DINT; END_VAR\nn := s.LEN;',
    note: 'IEC gives a STRING no members: LEN() and MID() read it, and the error says so.' },
  { id: 'aggregate-clear', category: 'Refused for portability', intent: 'strict', title: 'A whole structure or array cleared with := 0',
    st: 'TYPE Pt : STRUCT a : INT; b : REAL; END_STRUCT; END_TYPE\nVAR p : Pt; END_VAR\np := 0;',
    note: 'IEC has no value for a structure of zeros: clear the fields or elements one by one.' },
  { id: 'bool-number-mix', category: 'Refused for portability', intent: 'strict', title: 'Mixing BOOL and a number',
    st: 'VAR b : BOOL; n : INT; END_VAR\nn := b;' },
  { id: 'for-control-write', category: 'Refused for portability', intent: 'strict', title: 'Assigning to a FOR control variable',
    st: 'VAR i : INT; END_VAR\nFOR i := 1 TO 10 DO i := 5; END_FOR;',
    note: 'IEC forbids it outright and MATIEC refuses it by name.' },
  { id: 'literal-out-of-range', category: 'Refused for portability', intent: 'strict', title: 'A typed literal that does not fit its type',
    st: 'VAR n : INT := INT#40000; END_VAR' },
  { id: 'case-duplicate', category: 'Refused for portability', intent: 'strict', title: 'Two names differing only in case',
    st: 'VAR Motor : BOOL; motor : BOOL; END_VAR',
    note: 'Identifiers are case-insensitive, so these are one name declared twice.' },
  { id: 'memory-overlap', category: 'Refused for portability', intent: 'strict', title: 'Two memory variables that share bytes (%MW0 and %MX1.2)',
    st: 'VAR w AT %MW0 : INT; b AT %MX1.2 : BOOL; END_VAR',
    note: 'IEC leaves overlapping memory to the implementation: one target may overlay the bytes, OpenPLC keeps each size in an area of its own. A program relying on either would mean something different on the other, so each memory variable needs bytes of its own.' },
  { id: 'time-microseconds', category: 'Refused for portability', intent: 'strict', title: 'A duration in microseconds or nanoseconds (T#500us)',
    st: 'VAR t : TIME := T#500us; END_VAR',
    note: 'us and ns are IEC 3rd-edition units, for LTIME; MATIEC, and so OpenPLC, read d, h, m, s and ms. TIME here takes fractions of a millisecond, so T#0.5ms says the same thing.' },
  { id: 'calendar-to-number', category: 'Refused for portability', intent: 'strict', title: 'A DATE, TOD or DT converted to a number',
    st: 'VAR d : DATE; n : DINT; END_VAR\nn := DATE_TO_DINT(d);',
    note: 'The two reference compilers build it and disagree on the number: MATIEC counts every calendar type in seconds, while STruC++ counts a DATE in days and a TOD or DT in milliseconds. No number is portable, TIME_TO_DINT included (MATIEC counts it in whole seconds), so keep the value in its own type: compare a DATE or TOD with a literal of its kind, and subtract two DTs for a TIME to compare with a TIME literal.' },

  // ---- accepted here, with a caveat on the target ----
  { id: 'retain', category: 'Accepted here, with a caveat on the target', intent: 'permissive', title: 'RETAIN / NON_RETAIN',
    st: 'VAR RETAIN count : INT; END_VAR',
    note: 'The qualifier is consumed and does not change what the simulator does: RETAIN asks a variable to survive a warm restart, and there is no restart here: every run starts from the declared initial value, which is what a retentive variable is given on a cold start. A real target does have a restart, so the word still matters there.' },
  { id: 'il-operator-name', category: 'Accepted here, with a caveat on the target', intent: 'permissive', title: 'A variable named after a standard function (ADD, GT, LT, ...)',
    st: 'VAR ADD : INT; lt : BOOL; END_VAR\nADD := 1;',
    note: 'IEC does not reserve these, so refusing them would invent a rule the standard lacks. But they are Instruction List OPERATORS, and a compiler sharing one lexer between the languages treats them as keywords in ST too. MATIEC refused VAR_OUTPUT lt : BOOL. Export warns about it.' },
  { id: 'implicit-global-read', category: 'Accepted here, with a caveat on the target', intent: 'permissive', title: 'A POU touching a VAR_GLOBAL without declaring VAR_EXTERNAL',
    st: 'VAR_GLOBAL Shared : INT; END_VAR\nFUNCTION_BLOCK Reader\nVAR_OUTPUT v : INT; END_VAR\nv := Shared;\nEND_FUNCTION_BLOCK\n\nVAR r : Reader; n : INT; END_VAR\nr(v => n);',
    note: 'Semantically identical (the global resolves to the same image either way), but a block that touches a global without the declaration will not build on the target. Export warns about it.' },

  // ---- input forms strict IEC does not have: read (our rule for each), and exported in IEC form ----
  { id: 'block-end-semicolon', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'END_IF, END_CASE, END_FOR, END_WHILE, END_REPEAT and END_STRUCT without their ;',
    st: 'TYPE Pt :\nSTRUCT\n  x : INT;\nEND_STRUCT\nEND_TYPE\nTYPE Mode : (Idle, Run) END_TYPE\n\nVAR n : INT; p : Pt; END_VAR\nIF n > 0 THEN n := 1; END_IF\nFOR n := 1 TO 3 DO p.x := n; END_FOR',
    note: 'Common in code written elsewhere. Strict IEC requires it and MATIEC refuses a program without, so an export writes each one back.' },
  { id: 'dotted-enum', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'An enumeration member written Mode.Idle',
    st: 'TYPE Mode : (Idle, Run) END_TYPE\n\nVAR m : Mode := Mode.Run; n : INT; END_VAR\nCASE m OF\n  Mode.Idle: n := 0;\n  Mode.Run: n := 1;\nEND_CASE;',
    note: 'Read as IEC\'s Mode#Idle, which is what an export writes. A variable called Mode keeps its meaning: then Mode.Idle is its member.' },
  { id: 'empty-argument', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'An argument named and given nothing: Q => , or IN := ,',
    st: 'VAR t : TON; et : TIME; END_VAR\nt(IN := TRUE, PT := T#1s, Q => , ET => et);',
    note: 'What generated call templates leave behind. It reads as not there at all: an input keeps its value, an output goes nowhere. An export drops it.' },
  { id: 'interface-boilerplate', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'An interface base in the __SYSTEM namespace, and PUBLIC on an interface\'s method',
    st: 'INTERFACE IDrive EXTENDS __SYSTEM.IRoot\n  METHOD PUBLIC Travel : INT\n    VAR_INPUT dist : INT; END_VAR\n  END_METHOD\nEND_INTERFACE',
    note: 'A base named in the __SYSTEM namespace is a runtime\'s own root interface, which no program declares. Neither it nor PUBLIC asks anything of an implementation (every method of an interface is public), so both are read as saying nothing, and an export leaves them out.' },
  { id: 'library-type', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'Any library\'s namespace on a TYPE: JsonLib.Parser, EXTENDS MyLib.Base',
    st: 'FUNCTION_BLOCK Parser\nEND_FUNCTION_BLOCK\n\nVAR p : JsonLib.Parser; many : ARRAY [1..2] OF JsonLib.Parser; END_VAR',
    note: 'Where only a type can stand (a declaration, EXTENDS, IMPLEMENTS, ARRAY OF, REF_TO, a result), a dotted name is a library\'s type, so its namespace is read as saying nothing, whatever the library. An export keeps it: the name exists where the library does. Anywhere else a namespace is no namespace: the engine knows no library by name.' },
  { id: 'enum-base-type', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'An enumeration with a base type: (Idle, Run) UINT',
    st: 'TYPE Mode :\n(\n  Idle := 0,\n  Run := 10\n) UINT;\nEND_TYPE\n\nVAR m : Mode; END_VAR',
    note: 'A type for an enumeration\'s values. The values are held as INT here whatever it says, so a value INT cannot hold is refused; an export leaves the word out, since IEC\'s 2nd edition has no place for it.' },
  { id: 'inline-enum', category: 'Tolerated input forms, exported in IEC form', intent: 'supported', title: 'An enumeration in a declaration: m : (Idle, Run, Stop)',
    st: 'VAR m : (Idle, Run, Stop) := Run; n : INT; END_VAR\nIF m = Run THEN n := 1; END_IF;',
    note: 'IEC. It is an enumeration of the variable\'s own, its members named bare; PLCopen carries it as the variable\'s type. MATIEC parses it but cannot generate it ("C code generator does not currently support anonymous enumerated data types").' },
  { id: 'persistent', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'VAR PERSISTENT',
    st: 'VAR PERSISTENT count : INT := 7; END_VAR',
    note: 'A value that survives a restart and a download; not an IEC word. Read here as retention: a run here has no restart, so it starts at its initial value. PLCopen carries persistent="true"; IEC text writes RETAIN, the nearest word.' },
  { id: 'string-capacity-constant', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'A STRING capacity written as a constant: STRING(MAX_LEN)',
    st: 'VAR_GLOBAL CONSTANT MAX_LEN : INT := 20; END_VAR\nVAR s : STRING(MAX_LEN); t : STRING[MAX_LEN * 2]; END_VAR',
    note: 'IEC writes a capacity as an integer. Folded here against the global integer CONSTANTs, the same rule as an array bound, wherever a capacity can be written, and an export writes the integer it folds to, in brackets (STRING(n) goes out as STRING[n] too).' },
  { id: 'incomplete-address', category: 'Tolerated input forms, exported in IEC form', intent: 'permissive', title: 'A variable linked in the I/O configuration: AT %I*, AT %Q*',
    st: 'TYPE Io : STRUCT bIn AT %I* : BOOL; END_STRUCT END_TYPE\nFUNCTION_BLOCK Cyl\nVAR bExtended AT %I* : BOOL; bValve AT %Q* : BOOL; END_VAR\nbValve := NOT bExtended;\nEND_FUNCTION_BLOCK\n\nVAR start AT %I* : BOOL; END_VAR',
    note: 'A PLC project completes the address in its I/O configuration, which here is the scene\'s wiring: the variable is a plain one, in a program, a global, a block or a struct field alike, and a part wired to it by name drives or reads it. IEC completes one in a VAR_CONFIG, which no target here reads, so an export writes the variable plain.' },
  { id: 'struct-field-default', category: 'Tolerated input forms, exported in IEC form', intent: 'supported', title: 'A STRUCT field with a default value',
    st: 'TYPE Axis :\nSTRUCT\n  Speed : REAL := 1.5;\n  Mode : INT := 2;\nEND_STRUCT\nEND_TYPE\n\nVAR a : Axis; b : Axis := (Speed := 3.0); s : REAL; END_VAR\ns := a.Speed + b.Speed;',
    note: 'IEC. Every value of the type starts there: a variable, a field, an array element, a block\'s or a function\'s local; a field a variable\'s own initializer names takes that value instead. A default is a constant (a literal, an enumeration member, a global CONSTANT). MATIEC refuses a NESTED (field := ...) value of a struct type that has defaults, a gap of its own.' },

  // ---- IEC ladder diagram ----
  // `language: 'ladder'`: a LADDER section, read by the IEC ladder front end (src/plc/ladder/ladder.ts, docs/ladder.md) and
  // lowered to the ST above, so it runs on the same engine. The text form is this project's (IEC gives LD none).
  { id: 'ld-seal-in', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'Contacts, a coil and a branch (a seal-in)',
    st: 'VAR_INPUT Start : BOOL; Stop : BOOL; END_VAR\nVAR_OUTPUT Motor : BOOL; END_VAR\nLADDER\n  [|Start|, |Motor|] |/Stop| (Motor);\nEND_LADDER' },
  { id: 'ld-edge-set-reset', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'An edge contact and set / reset coils',
    st: 'VAR_INPUT Eye : BOOL; Button : BOOL; Clear : BOOL; END_VAR\nVAR_OUTPUT Jam : BOOL; END_VAR\nLADDER\n  |Eye| |P Button| (S Jam);\n  |Clear| (R Jam);\nEND_LADDER' },
  { id: 'ld-fb-box', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'A function-block box on the rung (a timer)',
    st: 'VAR_INPUT Run : BOOL; END_VAR\nVAR_OUTPUT Late : BOOL; END_VAR\nVAR T1 : TON; END_VAR\nLADDER\n  |Run| T1(IN, PT := T#2s) (Late);\nEND_LADDER',
    note: 'The bare pin sits on the rung; it defaults to the block\'s first BOOL input and output (a TON\'s IN and Q).' },
  { id: 'ld-function-box', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'A function box that runs while the rung is on (EN / ENO)',
    st: 'VAR_INPUT Go : BOOL; END_VAR\nVAR n : INT; END_VAR\nLADDER\n  |Go| ADD(IN1 := n, IN2 := 1, OUT => n);\nEND_LADDER' },
  { id: 'ld-compare-starts-rung', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'A comparison that starts a rung (a step sequencer)',
    st: 'VAR Step : INT; Busy : BOOL; END_VAR\nLADDER\n  EQ(IN1 := Step, IN2 := 10, OUT) |/Busy| MOVE(IN := 20, OUT => Step);\nEND_LADDER' },
  { id: 'ld-operator-box', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'AND, OR, XOR, NOT and MOD as boxes',
    st: 'VAR_INPUT Go : BOOL; a : BOOL; b : BOOL; END_VAR\nVAR_OUTPUT c : BOOL; END_VAR\nLADDER\n  |Go| AND(IN1 := a, IN2 := b, OUT => c);\nEND_LADDER' },
  { id: 'ld-jump-return', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'Labels, forward jumps and RETURN',
    st: 'VAR_INPUT Skip : BOOL; Halt : BOOL; A : BOOL; END_VAR\nVAR_OUTPUT B : BOOL; C : BOOL; END_VAR\nLADDER\n  |Skip| >>Done;\n  |A| (B);\n  Done: |A| (C);\n  |Halt| RETURN;\nEND_LADDER' },
  { id: 'ld-program', language: 'ladder', category: 'Ladder Diagram', intent: 'supported', title: 'A ladder PROGRAM, with a rung comment',
    st: 'PROGRAM Main\nVAR Start : BOOL; Motor : BOOL; END_VAR\nLADDER\n  (* run while Start is held *)\n  |Start| (Motor);\nEND_LADDER\nEND_PROGRAM' },
  { id: 'ld-backward-jump', language: 'ladder', category: 'Ladder the engine lacks', intent: 'unsupported', title: 'A jump back up the section (a loop)',
    st: 'VAR A : BOOL; B : BOOL; END_VAR\nLADDER\n  Top: |A| (B);\n  |B| >>Top;\nEND_LADDER' },
  { id: 'ld-compare-in-series', language: 'ladder', category: 'Ladder the engine lacks', intent: 'unsupported', title: 'A comparison in series after a contact',
    st: 'VAR A : BOOL; n : INT; Q : BOOL; END_VAR\nLADDER\n  |A| GT(IN1 := n, IN2 := 5, OUT) (Q);\nEND_LADDER' },
  { id: 'ld-edge-coil', language: 'ladder', category: 'Ladder: valid IEC, with an export caveat', intent: 'permissive', title: 'A transition-sensing coil (P / N coil)',
    st: 'VAR A : BOOL; Q : BOOL; END_VAR\nLADDER\n  |A| (P Q);\nEND_LADDER',
    note: 'IEC has it, and it runs here. Some targets\' importers may not accept it, so the PLCopen export warns.' },
  { id: 'ld-after-coil', language: 'ladder', category: 'Ladder: valid IEC, with an export caveat', intent: 'permissive', title: 'A contact after a coil on the same rung',
    st: 'VAR A : BOOL; B : BOOL; X : BOOL; Y : BOOL; END_VAR\nLADDER\n  |A| (X) |B| (Y);\nEND_LADDER',
    note: 'A coil passes its power on, so IEC allows more elements after it. Some targets\' importers may not accept the rung, so the PLCopen export warns.' },

]

// The external checks, and where their pins live. The pins are READ from where they are set (the
// workflow, or the script that fetches the tool) rather than repeated here, so a bump cannot leave this
// manifest quoting a version that stopped running months ago. Every check must be run by st-oracle.yml.
const WORKFLOW_PIN = (name) => ({ file: '.github/workflows/st-oracle.yml', re: new RegExp(`^\\s*${name}:\\s*(\\S+)`, 'm'), name })
const ORACLE_DEFS = [
  {
    id: 'matiec',
    name: 'MATIEC (iec2c)',
    edition: 'IEC 61131-3, 2nd edition',
    proves: 'Every corpus program is written out by the app’s own exporter and compiled by a real IEC compiler. The generated C is built, run with the corpus inputs, and compared with the expected values scan for scan.',
    script: 'scripts/oracle-matiec.mjs',
    run: 'npm run st-oracle',
    where: 'ci',
    pin: WORKFLOW_PIN('MATIEC_REF'),
  },
  {
    id: 'strucpp',
    name: 'STruC++',
    edition: 'IEC 61131-3, 3rd edition',
    proves: 'The edition boundary. Every case MATIEC refuses only because it is a 2nd-edition compiler must build here, so "the standard allows this" is checked rather than assumed.',
    script: 'scripts/oracle-strucpp.mjs',
    run: 'npm run st-oracle:ed3',
    where: 'ci',
    pin: WORKFLOW_PIN('STRUCPP_VERSION'),
  },
  {
    id: 'plcopen',
    name: 'PLCopen TC6 schema',
    edition: 'PLCopen XML interchange',
    proves: 'Every exported PLCopen document is validated against PLCopen’s own published schema.',
    script: 'scripts/oracle-plcopen.mjs',
    run: 'npm run st-oracle:xml',
    where: 'ci',
  },
  {
    id: 'import',
    name: 'Real-world import corpus',
    edition: 'Beremiz projects + IEC’s own Annex F examples',
    proves: 'Import, checked with files this project did not write: every POU and data type they declare must reach either the program or the import notes, so nothing is dropped without a word.',
    script: 'scripts/oracle-import.mjs',
    run: 'npm run st-oracle:import',
    where: 'ci',
  },
  {
    id: 'openplc',
    name: 'OpenPLC Editor',
    edition: 'its own reader, regenerator and STruC++',
    proves: 'What a user who takes a program to OpenPLC meets: its editor reads each export (PLCopen XML, and a project folder of .st files) into its own model, writes Structured Text back out and builds it. A declaration or statement lost on the way in fails the check.',
    script: 'scripts/oracle-openplc.mjs',
    run: 'npm run st-oracle:openplc',
    where: 'ci',
    pin: { file: 'scripts/lib/openplc-editor.mjs', re: /sha: '([0-9a-f]{40})'/, name: 'EDITOR.sha' },
  },
]

/** The headless seams an agent (or a pre-commit hook) drives instead of the app. */
const SEAMS = [
  { run: 'npm run catalog', what: 'what parts exist, their parameters, and the PLC signals each expects' },
  { run: 'npm run capabilities', what: 'this manifest: what the engine accepts and refuses, in Structured Text and ladder' },
  { run: 'npm run check-st -- <path...>', what: 'an ST file compiles' },
  { run: 'npm run validate-project -- <path>', what: 'a project document loads' },
  { run: 'npm run check-wiring -- <path>', what: 'every scene tag connects to a program variable' },
  { run: 'npm run test-project -- <folder>', what: 'the control logic behaves (JSON tests, real exit codes)' },
]

// ---- probe the engine ---------------------------------------------------------------------

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let manifest
try {
  // Narrow module loads: the ST engine is the subject, and pulling in
  // src/plc/index.ts would drag the link/scan-engine graph in for nothing.
  const { compile } = await vite.ssrLoadModule('/src/plc/interpreter.ts')
  // the blocks a person writes: AXIS_KERNEL is the motion blocks' kernel, not one of them
  const { SCALAR_TYPES, USER_FB_TYPES: FB_TYPES } = await vite.ssrLoadModule('/src/plc/types.ts')
  const { BUILTIN_FUNCTIONS, isBuiltinFunc } = await vite.ssrLoadModule('/src/plc/builtins.ts')
  const { KEYWORDS, valueRefs } = await vite.ssrLoadModule('/src/plc/lexer.ts')
  const { exportProgram } = await vite.ssrLoadModule('/src/plc/exchange/export.ts')
  const { importIecText } = await vite.ssrLoadModule('/src/plc/exchange/importText.ts')
  const { importPlcopenXml } = await vite.ssrLoadModule('/src/plc/exchange/importXml.ts')
  const { CONFORMANCE_GROUPS } = await vite.ssrLoadModule('/src/plc/conformanceCases.ts')

  // --- the probes. The engine answers; a contradiction is fatal. ---
  const contradictions = []
  const features = []
  for (const p of PROBES) {
    let verdict, message
    try {
      compile(p.st)
      verdict = 'compiles'
    } catch (e) {
      verdict = 'refused'
      message = e instanceof Error ? e.message : String(e)
    }
    const wanted = p.intent === 'supported' || p.intent === 'permissive' ? 'compiles' : 'refused'
    if (verdict !== wanted) {
      contradictions.push({ id: p.id, intent: p.intent, verdict, message, st: p.st })
    }
    const entry = { id: p.id, category: p.category, intent: p.intent, title: p.title, st: p.st, verdict }
    if (p.language !== undefined) entry.language = p.language
    if (message !== undefined) entry.message = message
    if (p.note !== undefined) entry.note = p.note
    features.push(entry)
  }

  if (contradictions.length > 0) {
    console.error('✗ the engine disagreed with this script about what it supports:\n')
    for (const c of contradictions) {
      const expected = c.intent === 'supported' || c.intent === 'permissive' ? 'accept' : 'refuse'
      console.error(`  ${c.id} (intent: ${c.intent}) - expected the engine to ${expected} this, it did not`)
      console.error(`    ${c.st.split('\n').join('\n    ')}`)
      if (c.message) console.error(`    engine said: ${c.message}`)
      console.error('')
    }
    console.error('Either the engine regressed, or a capability landed and this probe’s `intent` should move with it.')
    process.exit(1)
  }

  // --- the corpus, as the ledger sees it ---
  const allCases = CONFORMANCE_GROUPS.flatMap((g) => g.cases)
  const divergences = allCases
    .filter((c) => c.divergence)
    .map((c) => ({ case: c.name, note: c.divergence }))
  const withheld = allCases
    .filter((c) => c.oracle?.skip)
    .map((c) => ({ case: c.name, why: c.oracle.skip }))
  const editionRejects = allCases
    .filter((c) => c.oracle?.editionReject)
    .map((c) => ({ case: c.name, why: c.oracle.editionReject }))
  const corpus = {
    groups: CONFORMANCE_GROUPS.length,
    cases: allCases.length,
    rejectionCases: allCases.filter((c) => c.rejects).length,
    replayedByOracle: allCases.filter((c) => !c.oracle?.skip).length,
    withheldFromOracle: withheld,
    editionRejects,
    source: 'src/plc/conformanceCases.ts',
    groupTitles: CONFORMANCE_GROUPS.map((g) => g.title),
  }

  // --- which parts of the subset a REAL compiler has actually agreed with -------------------
  //
  // The rest of the manifest answers "what does our engine accept"; this answers "which of that
  // has something OTHER than us confirmed", since the corpus samples the subset. An accepted
  // feature no replayed case exercises is not known wrong, just unwitnessed - and programs
  // generated at scale reach for whatever is legal, which is the shape of the defects tier 1
  // has caught (arithmetic on a bit string, NOT/SHR on a number, assigning a FOR variable).
  //
  // METHOD, stated because the two halves are not equally strong:
  //   - functions and function blocks are read with the engine's own lexer (`valueRefs`), so
  //     comments and strings are excluded and a name in prose cannot count as coverage
  //   - TYPES are keywords, which the lexer does not emit as references, so they are matched
  //     as whole words against source with comments and string literals removed
  // Cases the oracle SKIPS are excluded (they were never replayed). `rejects` cases are
  // excluded too: they prove the engine refuses what a target refuses, which is strictness,
  // not evidence that the feature behaves correctly.
  //
  // TWO GRADES of external evidence, kept apart because they are not the same claim:
  //   - EXECUTED - MATIEC compiled it, the generated C was stepped, and the variable image
  //                 was diffed against the golden scan for scan. This is the strong one.
  //   - COMPILED - an `editionReject` case: MATIEC is EXPECTED to refuse it, so the only
  //                 external witness is STruC++ building it. Well-formed, not proven correct.
  // One number would let coverage drift UPWARD on the weaker evidence: editionReject cases keep
  // accruing (MATIEC is 2nd edition), each adding names no runtime has ever run.
  const scalarsForCoverage = [...SCALAR_TYPES]
  const replayed = allCases.filter((c) => !c.oracle?.skip && !c.rejects)
  const executedCases = replayed.filter((c) => !c.oracle?.editionReject)
  const strip = (src) =>
    src
      .replace(/\(\*[\s\S]*?\*\)/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'[^'\n]*'/g, ' ')
      .replace(/"[^"\n]*"/g, ' ')
  /** Name-matchers over one set of cases: `word` for types (keywords), `ref` for callables. */
  const matcher = (cases) => {
    const stripped = cases.map((c) => strip(c.src))
    const lexed = new Set(cases.flatMap((c) => valueRefs(c.src).map((r) => r.name.split('.')[0].toUpperCase())))
    return {
      word: (name) => stripped.some((s) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`, 'i').test(s)),
      ref: (name) => lexed.has(name.toUpperCase()),
    }
  }
  const anyGrade = matcher(replayed)
  const strongGrade = matcher(executedCases)
  const split = (names, pick) => {
    const seen = pick(anyGrade)
    const ran = pick(strongGrade)
    const witnessed = names.filter(seen)
    return {
      executed: witnessed.filter(ran).sort(),
      compiledOnly: witnessed.filter((n) => !ran(n)).sort(),
      unverified: names.filter((n) => !seen(n)).sort(),
    }
  }
  const typeCov = split(scalarsForCoverage, (m) => m.word)
  const fbCov = split([...FB_TYPES], (m) => m.ref)
  const fnCov = split([...BUILTIN_FUNCTIONS], (m) => m.ref)
  const compiledOnly = [...typeCov.compiledOnly, ...fbCov.compiledOnly, ...fnCov.compiledOnly]
  const oracleCoverage = {
    what: 'which accepted features an external IEC compiler has witnessed, at either of two grades: EXECUTED (compiled, stepped, and the variable image diffed against the golden scan for scan) or COMPILED ONLY (built by the 3rd-edition compiler but never run, because the 2nd-edition one refuses it by design)',
    why: 'the corpus SAMPLES the subset rather than covering it. "unverified" means unwitnessed by a real compiler, not known-broken - prefer the executed list where a program has the choice.',
    method: {
      functionsAndBlocks: "the engine's own lexer (valueRefs), so comments and string literals cannot count as coverage",
      types: 'whole-word match against case source with comments and string literals stripped - types are keywords, which the lexer does not emit as references',
      excluded: 'cases the oracle skips (never replayed) and `rejects` cases (they prove refusal, not behaviour)',
      grades:
        'executed = replayed through MATIEC tier 2. compiledOnly = reached only by an `editionReject` case, which MATIEC is expected to refuse, so nothing ever ran it. Kept apart so the headline cannot drift upward on the weaker evidence as more editionReject cases accrue.',
    },
    casesConsidered: replayed.length,
    casesExecuted: executedCases.length,
    compiledOnly,
    types: typeCov,
    functionBlocks: fbCov,
    functions: fnCov,
    summary: {
      types: `${typeCov.executed.length}/${scalarsForCoverage.length}`,
      functionBlocks: `${fbCov.executed.length}/${FB_TYPES.length}`,
      functions: `${fnCov.executed.length}/${BUILTIN_FUNCTIONS.length}`,
    },
  }

  // --- the oracles, with their pins read out of the workflow that runs them ---
  const workflowPath = join(repo, '.github', 'workflows', 'st-oracle.yml')
  if (!existsSync(workflowPath)) {
    console.error(`✗ no ST oracle workflow at ${workflowPath} - the manifest would claim checks that no longer run`)
    process.exit(1)
  }
  const workflow = readFileSync(workflowPath, 'utf8')
  const oracles = ORACLE_DEFS.map((o) => {
    if (!existsSync(join(repo, o.script))) {
      console.error(`✗ ${o.id}: no such script ${o.script}`)
      process.exit(1)
    }
    const inCi = workflow.includes(o.script)
    if (o.where === 'ci' && !inCi) {
      console.error(`✗ ${o.id}: ${o.script} is not run by .github/workflows/st-oracle.yml`)
      process.exit(1)
    }
    const entry = { id: o.id, name: o.name, edition: o.edition, proves: o.proves, script: o.script, run: o.run }
    if (o.pin) {
      const m = readFileSync(join(repo, o.pin.file), 'utf8').match(o.pin.re)
      if (!m) {
        console.error(`✗ ${o.id}: ${o.pin.name} is not pinned in ${o.pin.file}`)
        process.exit(1)
      }
      entry.pinned = m[1]
    }
    return { where: o.where, entry }
  })

  // --- portability, verified by actually using the doors ---
  const sample = 'VAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Motor : BOOL; END_VAR\nVAR d : TON; END_VAR\nd(IN := Start, PT := T#2s);\nMotor := d.Q;'
  const targets = [
    { id: 'iec-text', name: 'IEC 61131-3 source (.st)', takenBy: 'MATIEC, STruC++, RuSTy, and any vendor ST editor as paste' },
    { id: 'plcopen-xml', name: 'PLCopen TC6 interchange XML', takenBy: 'IEC 61131-3 tools that import PLCopen XML' },
  ].map((t) => {
    const res = exportProgram(sample, t.id)
    return { ...t, extension: res.filename.slice(res.filename.lastIndexOf('.')), reportsWarnings: Array.isArray(res.warnings) }
  })

  // The import door, exercised the same way: a wrapped file whose TASK interval must be
  // adopted, and whose incomplete address (which only a VAR_CONFIG could complete) must be
  // REPORTED rather than dropped.
  const wrapped = `CONFIGURATION Cfg
  RESOURCE Res ON PLC
    TASK Cyclic(INTERVAL := T#40ms, PRIORITY := 1);
    PROGRAM Inst WITH Cyclic : Main;
  END_RESOURCE
END_CONFIGURATION

PROGRAM Main
VAR sensor AT %IX0.0 : BOOL; flag AT %I* : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := sensor;
END_PROGRAM
`
  const imported = importIecText(wrapped)
  const importedXml = importPlcopenXml(
    '<?xml version="1.0"?><project><types><pous><pou name="Main" pouType="program"><interface><localVars><variable name="n"><type><INT/></type></variable></localVars></interface><body><ST><![CDATA[n := 1;]]></ST></body></pou></pous></types><instances><configurations/></instances></project>',
  )
  const portability = {
    export: targets,
    import: [
      {
        id: 'iec-text',
        name: 'IEC 61131-3 source (.st)',
        adoptsScanTime: imported.scanMs !== null,
        scanMsFromSample: imported.scanMs,
        reportsWhatItCannotHold: imported.notes.length > 0,
        notesFromSample: imported.notes,
      },
      {
        id: 'plcopen-xml',
        name: 'PLCopen TC6 project',
        loadsPous: importedXml.source.length > 0,
        reportsWhatItCannotHold: true,
      },
    ],
    rule: 'Anything a target may not carry comes back as a warning or a note. A program that quietly means something other than what its author wrote is worse than one that refuses.',
  }

  const scalars = [...SCALAR_TYPES]
  manifest = {
    manifest: 'oip-web PLC language capabilities',
    version: 1,
    generatedBy: 'npm run capabilities -- --write',
    generatedFrom: 'the engine itself: every verdict below is the engine in src/plc (checker.ts and interpreter.ts) answering, not prose transcribed from a doc',
    language: {
      name: 'IEC 61131-3 Structured Text and Ladder Diagram',
      status: 'a subset, deliberately',
      claim: 'Within the subset, a program is meant to behave the way a real IEC runtime would, so code written here carries over to a physical PLC; where it knowingly behaves differently, the difference is listed. There is no compliance statement and no PLCopen certification.',
      ladder: 'Ladder is a second front end on the same engine: each rung is translated to the Structured Text that means it. A feature with language "ladder" is a LADDER section.',
      ledger: 'docs/st-conformance.md',
      ladderDoc: 'docs/ladder.md',
      page: 'https://www.openindustryproject.org/plc/',
    },
    types: {
      supported: scalars,
      defaultStringLength: 80,
      notes: [
        'REAL is single precision (f32 after every operation), LREAL is 64-bit, as on every target.',
        'TIME carries milliseconds and never mixes with numbers implicitly.',
        'The three integer families (signed, unsigned, bit string) are kept apart at the operator level.',
      ],
    },
    functionBlocks: [...FB_TYPES],
    functions: {
      named: [...BUILTIN_FUNCTIONS],
      conversions: {
        pattern: '<SRC>_TO_<DST>',
        over: scalars,
        verified: ['INT_TO_REAL', 'REAL_TO_INT', 'STRING_TO_TIME', 'TIME_TO_DINT'].filter((n) => isBuiltinFunc(n)),
      },
    },
    keywords: [...KEYWORDS].sort(),
    features,
    divergences: {
      rule: 'Each is exercised by a corpus case carrying a divergence note, and reported by the external oracle as known rather than failed.',
      entries: divergences,
    },
    corpus,
    oracleCoverage,
    externalChecks: {
      when: 'every push and pull request touching src/plc/ or an oracle script',
      workflow: '.github/workflows/st-oracle.yml',
      oracles: oracles.filter((o) => o.where === 'ci').map((o) => o.entry),
    },
    portability,
    seams: SEAMS,
  }
} finally {
  await vite.close()
}

// ---- emit ---------------------------------------------------------------------------------

const json = `${JSON.stringify(manifest, null, 2)}\n`
const page = renderPlcPage(manifest)

// Compare CONTENT, not line endings. The generator emits LF; git hands these back as CRLF on a
// Windows checkout (core.autocrlf), so a raw byte compare called both artifacts stale on every
// Windows machine while passing on Linux CI. That split is worse than no gate: the check that
// exists to catch real engine drift cries wolf locally until it stops being read, and the one
// time it means it, nobody looks. A missing file is still stale.
const sameContent = (have, want) =>
  have !== null && have.replace(/\r\n/g, '\n') === want.replace(/\r\n/g, '\n')

if (check) {
  const stale = []
  for (const [path, want] of [[MANIFEST_PATH, json], [PAGE_PATH, page]]) {
    const have = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (!sameContent(have, want)) stale.push(path)
  }
  if (stale.length > 0) {
    for (const p of stale) console.error(`✗ stale: ${p.replace(repo, '.').replace(/\\/g, '/')}`)
    console.error('\nThe PLC engine moved and its published capability surface did not. Regenerate:\n  npm run capabilities -- --write')
    process.exit(1)
  }
  console.log('✓ public/st-capabilities.json and plc/index.html match the engine')
} else if (write) {
  writeFileSync(MANIFEST_PATH, json)
  writeFileSync(PAGE_PATH, page)
  console.log(`✓ wrote public/st-capabilities.json (${manifest.features.length} probed features)`)
  console.log('✓ wrote plc/index.html')
} else if (asJson) {
  process.stdout.write(json)
} else {
  const { corpus, externalChecks } = manifest
  const features = manifest.features
  const byIntent = (i) => features.filter((f) => f.intent === i)
  console.log(`\n${manifest.language.name} - ${manifest.language.status}`)
  console.log(`  types      ${manifest.types.supported.join(' ')}`)
  console.log(`  blocks     ${manifest.functionBlocks.join(' ')}`)
  console.log(`  functions  ${manifest.functions.named.length} named, plus the ${manifest.functions.conversions.pattern} family`)
  for (const intent of ['supported', 'unsupported', 'strict', 'permissive']) {
    const rows = byIntent(intent)
    if (rows.length === 0) continue
    const label = { supported: 'SUPPORTED', unsupported: 'NOT IN THE SUBSET', strict: 'REFUSED FOR PORTABILITY', permissive: 'ACCEPTED HERE, WITH A CAVEAT ON THE TARGET' }[intent]
    console.log(`\n${label}`)
    for (const f of rows) {
      const first = f.message ? f.message.split('\n')[0] : ''
      console.log(`  ${f.verdict === 'compiles' ? '✓' : '✗'} ${f.title}${first ? `\n      ${first}` : ''}`)
    }
  }
  console.log(`\nCORPUS   ${corpus.cases} cases in ${corpus.groups} groups - ${corpus.rejectionCases} assert a rejection, ${corpus.replayedByOracle} are replayed through an external compiler, ${corpus.withheldFromOracle.length} withheld with reasons`)
  console.log(`CHECKED  ${externalChecks.oracles.length} external checks on ${externalChecks.when}`)
  for (const o of externalChecks.oracles) console.log(`  ${o.name}${o.pinned ? ` @ ${o.pinned.slice(0, 12)}` : ''} - ${o.run}`)
  console.log(`\nDIVERGENCES  ${manifest.divergences.entries.length} deliberate, each named:`)
  for (const d of manifest.divergences.entries) console.log(`  · ${d.case}`)
  console.log('\nnpm run capabilities -- --json    the whole manifest')
  console.log('npm run capabilities -- --write   regenerate public/st-capabilities.json + plc/index.html\n')
}
