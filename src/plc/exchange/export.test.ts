// Export targets: the IEC-text file and PLCopen TC6 XML.
//
// The assertions worth having here are structural, not snapshot-shaped. What matters is
// that the artifact carries the program's meaning into a form another toolchain reads:
// every POU present, every declaration in the right section, the body verbatim, and the
// vendor-only spellings translated. A golden-file diff would pass while quietly emitting
// something another toolchain refuses to open.
//
// The strongest check of all is not in this file: scripts/oracle-matiec.mjs renders the
// whole conformance corpus through `renderIecText` and feeds it to a real IEC compiler.

import { describe, expect, it } from 'vitest'
import { exportProgram, toPlcopenXml } from './export'
import { canonicalSyntax, renderIecText, splitProgram } from './exportText'
import { CONFORMANCE_CASES } from '../conformanceCases'

const PROGRAM = `TYPE Mode : (Idle, Running, Fault); END_TYPE
FUNCTION_BLOCK Latch
VAR_INPUT Set : BOOL; Reset : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := (Q OR Set) AND NOT Reset;
END_FUNCTION_BLOCK
VAR_INPUT Start : BOOL; Stop : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; Label : STRING[12]; END_VAR
VAR seal : Latch; state : Mode; count : INT := 5; period : TIME := T#1s500ms; END_VAR
seal(Set := Start, Reset := Stop, Q => Motor);
Label := 'LINE-01';
count := count + 1;`

describe('splitting a program into its POUs', () => {
  it('peels types, function blocks and the program body apart', () => {
    const s = splitProgram(PROGRAM)
    expect(s.types).toHaveLength(1)
    expect(s.pous.map((p) => p.kind)).toEqual(['fb'])
    expect(s.pous[0]!.text).toMatch(/^FUNCTION_BLOCK Latch/)
    expect(s.program).toMatch(/^VAR_INPUT Start/)
    expect(s.program).toContain("Label := 'LINE-01';")
  })

  it('peels VAR_GLOBAL out of the program, since IEC puts it on the CONFIGURATION', () => {
    const s = splitProgram('VAR_GLOBAL Level : INT; END_VAR\nVAR x : INT; END_VAR\nx := Level;')
    expect(s.globals).toHaveLength(1)
    expect(s.program).not.toContain('VAR_GLOBAL')
  })

  it('peels a POU a comment introduces, and keeps the comment with it', () => {
    // A peeler that looks for the keyword only at the front of what is left lets a comment
    // above the first POU hide it: everything becomes the program body and the export emits
    // a FUNCTION_BLOCK nested inside PROGRAM, which no compiler accepts. No corpus case has
    // a comment, so this is the case that covers it.
    const s = splitProgram(`(* the seal-in latch *)
FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := S;
END_FUNCTION_BLOCK
VAR seal : Latch; go : BOOL; END_VAR
seal(S := go);`)
    expect(s.pous).toHaveLength(1)
    expect(s.pous[0]!.text).toContain('(* the seal-in latch *)')
    expect(s.program).toMatch(/^VAR seal/)
  })

  it('peels past a // line comment too', () => {
    const s = splitProgram('// a counter\nFUNCTION_BLOCK Cnt\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_FUNCTION_BLOCK\nVAR c : Cnt; END_VAR\nc();')
    expect(s.pous.map((p) => p.kind)).toEqual(['fb'])
    expect(s.program).toMatch(/^VAR c/)
  })

  it('is not cut short by a terminator named in a comment', () => {
    const s = splitProgram(`FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
(* END_FUNCTION_BLOCK closes this, below *)
Q := S;
END_FUNCTION_BLOCK
VAR seal : Latch; END_VAR
seal(S := TRUE);`)
    expect(s.pous[0]!.text).toContain('Q := S;')
    expect(s.pous[0]!.text.endsWith('END_FUNCTION_BLOCK')).toBe(true)
    expect(s.program).toMatch(/^VAR seal/)
  })
})

describe('a sized STRING declaration is emitted as written', () => {
  // No translation layer: rewriting `VAR s : STRING[16];` into a
  // `TYPE Str16 : STRING[16]; END_TYPE` declaration would treat the sized spelling as a
  // vendor extension. It is not - IEC's grammar has single_byte_string_var_declaration,
  // which is why MATIEC's own parser accepts it - and the rewrite produces a form MATIEC
  // cannot parse at all. See the note above renderIecText.
  it('leaves the capacity on the variable, and declares no type for it', () => {
    const t = renderIecText(`VAR s : STRING[16] := 'Conveyor'; END_VAR
VAR_OUTPUT out : STRING[8]; END_VAR
out := LEFT(s, 3);`, { banner: false })
    expect(t).toContain("s : STRING[16] := 'Conveyor';")
    expect(t).toContain('out : STRING[8];')
    expect(t).not.toContain('Str16')
    expect(t).not.toContain('TYPE')
  })

  it('writes the STRING(n) spelling in IEC form, STRING[n]', () => {
    expect(renderIecText('VAR a : STRING(4); END_VAR', { banner: false })).toContain('a : STRING[4];')
  })
})

describe('IEC text export', () => {
  const text = renderIecText(PROGRAM, { programName: 'Main' })

  it('wraps the body in the configuration layer the subset does not have', () => {
    expect(text).toContain('PROGRAM Main')
    expect(text).toContain('END_PROGRAM')
    expect(text).toContain('CONFIGURATION Config0')
    expect(text).toContain('RESOURCE Res0 ON PLC')
    expect(text).toContain('TASK Tick(INTERVAL := T#100ms, PRIORITY := 0);')
    expect(text).toContain('PROGRAM Inst0 WITH Tick : Main;')
  })

  it('puts definitions before the program that uses them', () => {
    expect(text.indexOf('TYPE Mode')).toBeLessThan(text.indexOf('FUNCTION_BLOCK Latch'))
    expect(text.indexOf('FUNCTION_BLOCK Latch')).toBeLessThan(text.indexOf('PROGRAM Main'))
  })

  it('leaves a sized STRING field inside its STRUCT, where the author put it', () => {
    const t = renderIecText('TYPE Tag : STRUCT id : STRING[4]; END_STRUCT; END_TYPE\nVAR p : Tag; END_VAR\n')
    expect(t).toContain('TYPE Tag : STRUCT id : STRING[4]; END_STRUCT; END_TYPE')
  })

  it('keeps a commented POU outside the program, where IEC needs it', () => {
    // the commented-POU shape, checked end to end: a nested FUNCTION_BLOCK inside
    // PROGRAM ... END_PROGRAM builds here and on no target at all
    const t = renderIecText(`(* the seal-in latch *)
FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := S;
END_FUNCTION_BLOCK
VAR seal : Latch; go : BOOL; END_VAR
seal(S := go);`, { banner: false })
    expect(t.indexOf('FUNCTION_BLOCK Latch')).toBeLessThan(t.indexOf('PROGRAM Main'))
    expect(t.slice(t.indexOf('PROGRAM Main'))).not.toContain('FUNCTION_BLOCK')
  })

  it('moves VAR_GLOBAL onto the CONFIGURATION', () => {
    const t = renderIecText('VAR_GLOBAL Level : INT; END_VAR\nVAR x : INT; END_VAR\nx := Level;')
    expect(t.indexOf('VAR_GLOBAL')).toBeGreaterThan(t.indexOf('CONFIGURATION Config0'))
    expect(t.indexOf('VAR_GLOBAL')).toBeLessThan(t.indexOf('RESOURCE Res0'))
  })
})

describe('PLCopen XML export', () => {
  const xml = toPlcopenXml(PROGRAM, { projectName: 'Line 1', timestamp: '2026-01-01T00:00:00' })

  it('uses the TC6 namespace PLCopen publishes a schema for', () => {
    expect(xml).toMatch(/<project xmlns="http:\/\/www\.plcopen\.org\/xml\/tc6_0201"[ >]/)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
  })

  it('emits one pou per user POU plus the program', () => {
    expect(xml).toContain('<pou name="Latch" pouType="functionBlock">')
    expect(xml).toContain('<pou name="Main" pouType="program">')
  })

  it('sorts declarations into the PLCopen interface sections', () => {
    expect(xml).toContain('<inputVars>')
    expect(xml).toContain('<variable name="Start">')
    expect(xml).toContain('<outputVars>')
    expect(xml).toContain('<variable name="Motor">')
    expect(xml).toContain('<localVars>')
    expect(xml).toContain('<variable name="seal">')
  })

  it('spells elementary types the way TC6 requires: string lowercase, the rest upper', () => {
    // a schema validator rejects <STRING> outright, with an error that reads like the type
    // is unknown -- this is the trap OpenPLC documents in its own generator
    expect(xml).toContain('<BOOL/>')
    expect(xml).toContain('<INT/>')
    expect(xml).toContain('<string length="12"/>')
    expect(xml).not.toContain('<STRING')
  })

  it('carries a function-block instance as a derived type', () => {
    expect(xml).toContain('<derived name="Latch"/>')
  })

  it('keeps an initial value as the author wrote it', () => {
    // T#1s500ms must not come back as 1500: the spelling is the portable part
    expect(xml).toContain('<simpleValue value="T#1s500ms"/>')
    expect(xml).toContain('<simpleValue value="5"/>')
  })

  it('emits the ST body verbatim inside an xhtml:p, the prefix bound on the project', () => {
    // the spelling OpenPLC's reader requires; see pouXml
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xml).toContain('<xhtml:p>')
    expect(xml).not.toContain('<xhtml xmlns=')
    expect(xml).toContain('seal(Set := Start, Reset := Stop, Q =&gt; Motor);')
    // the declarations must not leak into the body
    expect(xml).not.toContain('VAR_INPUT Start')
  })

  it('emits an enumeration as a dataType with its members', () => {
    expect(xml).toContain('<dataType name="Mode">')
    expect(xml).toContain('<value name="Idle" value="0"/>')
    expect(xml).toContain('<value name="Fault" value="2"/>')
  })

  it('emits a struct and an array with their shapes', () => {
    const x = toPlcopenXml('TYPE Pt : STRUCT x : INT; y : REAL; END_STRUCT; END_TYPE\nVAR p : Pt; a : ARRAY [1..3] OF INT; END_VAR\n')
    expect(x).toContain('<dataType name="Pt">')
    expect(x).toContain('<struct>')
    expect(x).toContain('<variable name="y"><type><REAL/></type></variable>')
    expect(x).toContain('<array>')
    expect(x).toContain('<dimension lower="1" upper="3"/>')
  })

  it('emits a subrange with its bounds, split by signedness', () => {
    const x = toPlcopenXml('TYPE Pct : INT (0..100); END_TYPE\nVAR p : Pct; END_VAR\n')
    expect(x).toContain('<subrangeSigned>')
    expect(x).toContain('<range lower="0" upper="100"/>')
    const u = toPlcopenXml('TYPE Small : UINT (1..9); END_TYPE\nVAR s : Small; END_VAR\n')
    expect(u).toContain('<subrangeUnsigned>')
  })

  it('puts a subrange\'s range BEFORE its base type, as TC6 sequences them', () => {
    // the xsd refuses the other order ("Element baseType: This element is not expected. Expected is ( range )")
    for (const x of [toPlcopenXml('TYPE Pct : INT (0..100); END_TYPE\nVAR p : Pct; END_VAR\n'), toPlcopenXml('TYPE Small : UINT (1..9); END_TYPE\nVAR s : Small; END_VAR\n')]) {
      const sub = /<subrange(?:Signed|Unsigned)>([\s\S]*?)<\/subrange/.exec(x)?.[1] ?? ''
      expect(sub.indexOf('<range ')).toBeGreaterThanOrEqual(0)
      expect(sub.indexOf('<range ')).toBeLessThan(sub.indexOf('<baseType>'))
    }
  })

  it('puts the resource before the globals, as TC6 sequences them', () => {
    // `configuration` is an xsd:sequence of resource*, globalVars*, ... so the order is not
    // cosmetic: emitted the other way round, the file is schema-invalid however well it
    // reads. Found by validating against PLCopen's own XSD (npm run st-oracle:xml).
    const x = toPlcopenXml('VAR_GLOBAL Level : INT; END_VAR\nVAR x : INT; END_VAR\nx := Level;')
    expect(x.indexOf('<resource name="Res0">')).toBeLessThan(x.indexOf('<globalVars>'))
  })

  it('emits a standard function-block instance as a derived type too', () => {
    // `t : TON` must not come out as `<TON/>`, an elementary type: TC6 has no such element,
    // and a standard FB is derived there exactly like a user-defined one
    const x = toPlcopenXml('VAR t : TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR\nt(IN := TRUE, PT := T#1s); q := t.Q;')
    expect(x).toContain('<derived name="TON"/>')
    expect(x).not.toContain('<TON/>')
  })

  it('carries a function block held in an array or a struct as a derived type too', () => {
    const x = toPlcopenXml(
      'TYPE Merge : STRUCT gap : TON; END_STRUCT; END_TYPE\nVAR d : ARRAY [1..3] OF TON; m : Merge; q : BOOL; END_VAR\nd[1](IN := TRUE, PT := T#1s);\nm.gap(IN := d[1].Q, PT := T#1s);\nq := m.gap.Q;',
    )
    expect(x).toContain('<baseType><derived name="TON"/></baseType>') // the array's element
    expect(x).toContain('<variable name="gap"><type><derived name="TON"/></type></variable>') // the struct's field
    expect(x).not.toContain('<TON/>')
  })

  it('warns when a function block sits inside an array or a struct field, and not for a plain instance', () => {
    const inArray = exportProgram('VAR d : ARRAY [1..2] OF TON; END_VAR\nd[1](IN := TRUE, PT := T#1s);', 'iec-text')
    expect(inArray.warnings.join(' ')).toMatch(/2nd-edition compiler such as MATIEC/)
    const inField = exportProgram('TYPE Z : STRUCT t : TON; END_STRUCT; END_TYPE\nVAR z : Z; END_VAR\nz.t(IN := TRUE, PT := T#1s);', 'plcopen-xml')
    expect(inField.warnings.join(' ')).toMatch(/2nd-edition compiler such as MATIEC/)
    const plain = exportProgram('VAR t : TON; END_VAR\nt(IN := TRUE, PT := T#1s);', 'iec-text')
    expect(plain.warnings).toEqual([])
  })

  it('warns when a starting value mixes [...] and (field := ...) lists, and not for either alone', () => {
    const pt = 'TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\n'
    expect(exportProgram(`${pt}VAR ps : ARRAY [1..2] OF Pt := [(x := 1), (x := 2)]; END_VAR\nps[1].x := 3;`, 'iec-text').warnings.join(' ')).toMatch(/mixed in one starting value/)
    // (the array's [1, 2] has a warning of its own, for OpenPLC v4: not this one)
    expect(exportProgram(`${pt}VAR p : Pt := (x := 1); a : ARRAY [1..2] OF INT := [1, 2]; END_VAR\np.x := 3;`, 'iec-text').warnings.join(' ')).not.toMatch(/mixed in one starting value/)
  })

  it('warns when an array bound is a named CONSTANT, and not for literal bounds', () => {
    const named = exportProgram('VAR CONSTANT N : INT := 3; END_VAR VAR a : ARRAY [1..N] OF INT; END_VAR\na[1] := 1;', 'iec-text')
    expect(named.warnings.join(' ')).toMatch(/array bound is written as a named CONSTANT/)
    expect(exportProgram('VAR a : ARRAY [1..3] OF INT; END_VAR\na[1] := 1;', 'iec-text').warnings).toEqual([])
  })

  it('warns about a variable named like an SFC keyword, which MATIEC reserves in ST too', () => {
    const res = exportProgram('VAR step : INT; END_VAR\nstep := 1;', 'iec-text')
    expect(res.warnings.join(' ')).toMatch(/step: this name is a Sequential Function Chart keyword/)
  })

  it('warns about a standard function called with named arguments out of order, which STruC++ binds by position', () => {
    const res = exportProgram('VAR x : INT; n : INT; END_VAR\nn := LIMIT(MX := 9, IN := x, MN := 0);', 'iec-text')
    expect(res.warnings.join(' ')).toMatch(/LIMIT: a standard function is called with its arguments named out of IEC's order/)
    const inOrder = exportProgram('VAR x : INT; n : INT; END_VAR\nn := LIMIT(MN := 0, IN := x, MX := 9);', 'iec-text')
    expect(inOrder.warnings).toEqual([])
  })

  it('warns about a variable named like a calendar type, which is allowed here and reserved everywhere else', () => {
    const res = exportProgram('VAR dt : REAL; tod : INT; END_VAR\ndt := 0.5; tod := 1;', 'iec-text')
    expect(res.warnings.join(' ')).toMatch(/dt, tod: this name is an IEC elementary type/)
  })

  it('warns about a variable spelled like a declared type, which MATIEC refuses to declare', () => {
    const res = exportProgram('TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE\nVAR pkg : Pkg; END_VAR\npkg.id := 1;', 'iec-text')
    expect(res.warnings.join(' ')).toMatch(/pkg: a variable spelled like a declared type/)
    const fine = exportProgram('TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE\nVAR box : Pkg; END_VAR\nbox.id := 1;', 'iec-text')
    expect(fine.warnings).toEqual([])
  })

  it('warns about a whole-array copy, even one nested in a branch, and not about a struct copy', () => {
    const assign = exportProgram('VAR a : ARRAY [1..2] OF INT; b : ARRAY [1..2] OF INT; END_VAR\nIF TRUE THEN b := a; END_IF;', 'iec-text')
    expect(assign.warnings.join(' ')).toMatch(/A whole array is copied into another/)
    const byValue = exportProgram('FUNCTION Total : INT\nVAR_INPUT p : ARRAY [1..2] OF INT; END_VAR\nTotal := p[1] + p[2];\nEND_FUNCTION\nVAR row : ARRAY [1..2] OF INT; n : INT; END_VAR\nn := Total(row);', 'iec-text')
    expect(byValue.warnings.join(' ')).toMatch(/passed by value into a FUNCTION/)
    const struct = exportProgram('TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\nVAR a : Pt; b : Pt; END_VAR\nb := a;', 'iec-text')
    expect(struct.warnings).toEqual([])
  })

  it('carries a FUNCTION that returns a struct with a derived return type', () => {
    const x = toPlcopenXml('TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE\nFUNCTION Make : Pkg\nVAR_INPUT id : DINT; END_VAR\nMake.id := id;\nEND_FUNCTION\nVAR box : Pkg; END_VAR\nbox := Make(7);')
    expect(x).toContain('<returnType><derived name="Pkg"/></returnType>')
  })

  it('declares a named array type once and refers to every use of it by name', () => {
    const src = 'TYPE Row : ARRAY [1..3] OF INT; END_TYPE\nVAR a : Row; b : Row; END_VAR\na := b;'
    const x = toPlcopenXml(src)
    expect(x).toContain('<dataType name="Row">')
    expect(x.match(/<dimension /g)).toHaveLength(1) // spelled out once, in its own dataType
    expect(x).toMatch(/<variable name="a">\s*<type>\s*<derived name="Row"\/>\s*<\/type>/)
    expect(exportProgram(src, 'iec-text').warnings).toEqual([]) // a named array copies under its name
  })

  it('carries structured and array initial values as TC6 structValue and arrayValue', () => {
    const x = toPlcopenXml('TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE\nVAR p : Pt := (x := 1, y := -2); row : ARRAY [1..3] OF INT := [4, 2(0)]; END_VAR\np.x := 1;')
    expect(x).toContain('<initialValue><structValue><value member="x"><simpleValue value="1"/></value><value member="y"><simpleValue value="-2"/></value></structValue></initialValue>')
    expect(x).toContain('<initialValue><arrayValue><value><simpleValue value="4"/></value><value><simpleValue value="0"/></value><value><simpleValue value="0"/></value></arrayValue></initialValue>')
  })

  it('binds the program to a periodic task in the configuration', () => {
    expect(xml).toContain('<configuration name="Config0">')
    expect(xml).toContain('<task name="Tick" interval="T#100ms" priority="0">')
    expect(xml).toContain('<pouInstance name="Inst0" typeName="Main"/>')
  })

  it('escapes XML metacharacters in the body', () => {
    const x = toPlcopenXml("VAR a : INT; b : BOOL; END_VAR\nb := a < 3 AND a > 1;")
    expect(x).toContain('a &lt; 3')
    expect(x).toContain('a &gt; 1')
  })

  it('carries a commented function block as its own pou, not as program text', () => {
    const x = toPlcopenXml(`(* the seal-in latch *)
FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := S;
END_FUNCTION_BLOCK
VAR seal : Latch; go : BOOL; END_VAR
seal(S := go);`)
    expect(x).toContain('<pou name="Latch" pouType="functionBlock">')
    expect(x.slice(x.indexOf('<pou name="Main"'))).not.toContain('FUNCTION_BLOCK')
  })

  it('emits a function with its return type', () => {
    const x = toPlcopenXml('FUNCTION Dbl : INT VAR_INPUT v : INT; END_VAR Dbl := v * 2; END_FUNCTION\nVAR r : INT; END_VAR\nr := Dbl(2);')
    expect(x).toContain('<pou name="Dbl" pouType="function">')
    expect(x).toContain('<returnType><INT/></returnType>')
    expect(x).toContain('Dbl := v * 2;')
  })

  it('gives every POU its own body when the blocks are interleaved', () => {
    // The AST and the source peeler are two independent recoveries of the same file, paired by
    // name. FUNCTION_BLOCK / FUNCTION / FUNCTION_BLOCK is the shape a by-position pairing (filter
    // by kind, trust index order) gets wrong, emitting a POU with the right name and interface
    // and no code, which opens on a target and does nothing.
    const x = toPlcopenXml(`FUNCTION_BLOCK Accum
VAR_INPUT step : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
total := total + step;
END_FUNCTION_BLOCK
FUNCTION Half : INT
VAR_INPUT v : INT; END_VAR
Half := v / 2;
END_FUNCTION
FUNCTION_BLOCK Damped
VAR_INPUT raw : INT; END_VAR
VAR_OUTPUT out : INT; END_VAR
out := Half(raw);
END_FUNCTION_BLOCK
VAR a : Accum; d : Damped; END_VAR
a(step := 1); d(raw := 4);`)
    const pou = (name: string): string => {
      const from = x.indexOf(`<pou name="${name}"`)
      expect(from, `no pou element for ${name}`).toBeGreaterThan(-1)
      return x.slice(from, x.indexOf('</pou>', from))
    }
    expect(pou('Accum')).toContain('total := total + step;')
    expect(pou('Half')).toContain('Half := v / 2;')
    expect(pou('Damped')).toContain('out := Half(raw);')
    // and none of them picked up a neighbour's statements on the way past
    expect(pou('Accum')).not.toContain('Half :=')
    expect(pou('Damped')).not.toContain('total :=')
  })
})

// What OpenPLC v4's compiler, STruC++ 0.6.2, builds or runs differently: each measured by the run tier of the STruC++
// oracle (scripts/oracle-strucpp.mjs --execute, RUN_GAPS), each warned about only where the program does it
describe('warnings for OpenPLC v4', () => {
  const warn = (src: string): string => exportProgram(src, 'iec-text').warnings.join('\n')
  const v4 = /OpenPLC v4 \(its compiler, STruC\+\+ 0\.6\.2\)/

  it('a REAL converted to an integer: a tie rounds away from zero there', () => {
    expect(warn('VAR r : REAL := 2.5; i : INT; d : DINT; END_VAR\ni := REAL_TO_INT(r);\nd := real_to_dint(r);')).toMatch(/^REAL_TO_DINT, REAL_TO_INT: .*rounds it away from zero/m)
    expect(warn('VAR r : REAL := 2.5; d : DINT; END_VAR\nd := TRUNC(r);')).not.toMatch(v4) // TRUNC decides the tie itself
    expect(warn('VAR i : INT := 2; r : REAL; END_VAR\nr := INT_TO_REAL(i);')).not.toMatch(v4)
  })

  it('NOT of an integer literal is a logical NOT there; NOT of a variable is not', () => {
    expect(warn('VAR w : WORD; END_VAR\nw := NOT 0;')).toMatch(/NOT of an integer literal/)
    expect(warn('VAR w : WORD; m : WORD := 10; b : BOOL; END_VAR\nw := NOT m;\nb := NOT TRUE;')).not.toMatch(v4)
  })

  it('a CTD or CTUD counts down on the falling edge there; a CTU is right', () => {
    expect(warn('VAR down : CTD; both : CTUD; END_VAR\ndown(CD := TRUE, LD := FALSE, PV := 2);\nboth(CU := FALSE, CD := TRUE, PV := 2);')).toMatch(/^both, down: a CTD or CTUD counts down on the RISING edge/m)
    expect(warn('VAR up : CTU; END_VAR\nup(CU := TRUE, PV := 2);')).not.toMatch(v4)
  })

  it("starting values it drops: an array's, an expression-valued CONSTANT's", () => {
    expect(warn('VAR a : ARRAY [1..3] OF INT := [1, 2, 3]; b : ARRAY [1..3] OF INT; END_VAR\nb := a;')).toMatch(/^a: a PROGRAM's array with a \[\.\.\.\] starting value/m)
    expect(warn('VAR b : ARRAY [1..3] OF INT; END_VAR\nb[1] := 1;')).not.toMatch(v4)
    // measured: a block's array and a FUNCTION's local array keep their starting values there, and so does a block's
    // expression-valued CONSTANT (conformanceCases.ts, the two cases "... holds in/inside a function block")
    expect(
      warn('FUNCTION_BLOCK Shelf\nVAR CONSTANT ZONES : INT := 4; LAST : INT := ZONES - 1; END_VAR\nVAR slots : ARRAY [1..3] OF INT := [4, 5, 6]; END_VAR\nVAR_OUTPUT second : INT; END_VAR\nsecond := slots[2] + LAST;\nEND_FUNCTION_BLOCK\nFUNCTION Pick : INT\nVAR_INPUT i : INT; END_VAR\nVAR table : ARRAY [1..3] OF INT := [7, 8, 9]; END_VAR\nPick := table[i];\nEND_FUNCTION\nVAR s : Shelf; n : INT; END_VAR\ns();\nn := Pick(2) + s.second;'),
    ).not.toMatch(v4)
    expect(warn('VAR CONSTANT ZONES : INT := 4; LAST : INT := ZONES - 1; END_VAR\nVAR n : INT; END_VAR\nn := LAST;')).toMatch(/^LAST: a PROGRAM's CONSTANT whose value is an expression/m)
    expect(warn('VAR CONSTANT ZONES : INT := 4; LOW : INT := -1; END_VAR\nVAR n : INT; END_VAR\nn := ZONES + LOW;')).not.toMatch(v4)
  })

  it('a DATE minus a DATE is a count of days there; a DT difference is right', () => {
    expect(warn('VAR a : DATE := D#2024-03-02; b : DATE := D#2024-02-29; t : TIME; END_VAR\nt := a - b;')).toMatch(/A DATE is subtracted from a DATE/)
    expect(warn('VAR a : DT := DT#2024-03-02-00:00:00; b : DT := DT#2024-02-29-00:00:00; t : TIME; END_VAR\nt := a - b;')).not.toMatch(v4)
  })

  it('a calendar value converted to text prints its count there', () => {
    expect(warn("VAR d : DATE := D#2024-02-29; s : STRING; END_VAR\ns := DATE_TO_STRING(d);")).toMatch(/^DATE_TO_STRING: here a calendar value prints as its literal/m)
    expect(warn("VAR t : TIME := T#1s; s : STRING; END_VAR\ns := TIME_TO_STRING(t);")).not.toMatch(v4)
  })

  it('a PROGRAM with no task is put on the first task there', () => {
    const src = 'PROGRAM Count\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\nCONFIGURATION Cell\n  RESOURCE Res0 ON PLC\n    TASK Base(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM Fast WITH Base : Count;\n    PROGRAM Free : Count;\n  END_RESOURCE\nEND_CONFIGURATION'
    expect(warn(src)).toMatch(/^Free: a PROGRAM line with no WITH/m)
    expect(warn(src.replace('PROGRAM Free : Count;', 'PROGRAM Free WITH Base : Count;'))).not.toMatch(v4)
  })

  it('what STruC++ reports compiling and does not build: BCD, the named calendar functions, literal-only string calls, string ordering, a block inside a struct', () => {
    expect(warn('VAR i : INT := 42; w : WORD; END_VAR\nw := INT_TO_BCD(i);\ni := BCD_TO_INT(w);')).toMatch(/^BCD_TO_INT, INT_TO_BCD: .*declares no BCD conversion/m)
    expect(warn('VAR t : TOD := TOD#06:00:00; x : DT; y : TOD; END_VAR\nt := ADD_TOD_TIME(t, T#1h);\ny := DATE_AND_TIME_TO_TIME_OF_DAY(x);')).toMatch(/^ADD_TOD_TIME, DATE_AND_TIME_TO_TIME_OF_DAY: .*declares none of these/m)
    expect(warn('VAR t : TOD := TOD#06:00:00; x : DT; y : TOD; END_VAR\nt := t + T#1h;\ny := DT_TO_TOD(x);')).not.toMatch(v4)
    expect(warn("VAR s : STRING; n : INT; END_VAR\ns := CONCAT('ab', 'c');\nn := LEN('abc');")).toMatch(/^CONCAT, LEN: a standard function whose STRING arguments are all literals/m)
    expect(warn("VAR s : STRING := 'x'; n : INT; END_VAR\ns := CONCAT(s, 'c');\nn := LEN(s);")).not.toMatch(v4) // a literal beside a variable builds
    expect(warn("VAR a : STRING := 'a'; b : STRING := 'b'; up : BOOL; same : BOOL; END_VAR\nup := a >= b;\nsame := a = b;")).toMatch(/Two STRINGs are ordered/)
    expect(warn("VAR a : STRING := 'a'; b : STRING := 'b'; same : BOOL; END_VAR\nsame := a <> b;")).not.toMatch(v4)
    expect(warn('TYPE Zone : STRUCT gap : TON; n : INT; END_STRUCT; END_TYPE\nVAR z : Zone; END_VAR\nz.gap(IN := TRUE, PT := T#1s);')).toMatch(/^Zone: a STRUCT that holds a function-block instance/m)
  })

  it('REF() of a struct or a block does not build there, nor NULL on the left of a comparison; a REF_TO INT does', () => {
    expect(warn('TYPE Pkg : STRUCT id : INT; END_STRUCT; END_TYPE\nVAR p : Pkg; z : REF_TO Pkg; x : INT; END_VAR\nz := REF(p);\nx := z^.id;')).toMatch(/^z: a REF_TO a STRUCT or a function block/m)
    expect(warn('VAR a : INT; r : REF_TO INT; ok : BOOL; END_VAR\nr := REF(a);\nok := NULL <> r;')).toMatch(/^NULL is written on the left of a comparison/m)
    expect(warn('VAR a : ARRAY [1..3] OF INT; r : REF_TO INT; ok : BOOL; END_VAR\nr := REF(a[2]);\nr^ := 7;\nok := r <> NULL;')).not.toMatch(v4)
  })

  const ACC = 'FUNCTION_BLOCK Acc\n  VAR n : INT; END_VAR\n  METHOD Put : INT\n    VAR_INPUT v : INT; END_VAR\n    VAR_OUTPUT twice : INT; END_VAR\n    n := n + v; twice := v * 2; Put := n;\n  END_METHOD\nEND_FUNCTION_BLOCK\n'
  it('a METHOD call that leaves an output unbound does not build there; one binding every output does', () => {
    expect(warn(`${ACC}VAR a : Acc; r : INT; END_VAR\nr := a.Put(v := 3);`)).toMatch(/^Put: a METHOD called without binding every one of its outputs/m)
    expect(warn(`${ACC}VAR a : Acc; r : INT; w : INT; END_VAR\nr := a.Put(v := 3, twice => w);`)).not.toMatch(v4)
  })

  it('a METHOD on an instance named like its block does not build there; calling the block itself does', () => {
    expect(warn(`${ACC}VAR acc : Acc; r : INT; w : INT; END_VAR\nr := acc.Put(v := 3, twice => w);`)).toMatch(/^acc: a METHOD called on an instance named like its own block type/m)
    expect(warn('FUNCTION_BLOCK Acc\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_FUNCTION_BLOCK\nVAR acc : Acc; r : INT; END_VAR\nacc();\nr := acc.n;')).not.toMatch(v4)
  })

  it('says nothing about a program that uses none of it', () => {
    expect(warn('VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TON; c : CTU; n : INT; END_VAR\nt(IN := go, PT := T#1s);\nc(CU := t.Q, PV := 3);\nq := c.Q;\nn := c.CV;')).not.toMatch(v4)
  })
})

describe('IEC references (REF_TO) and THIS, in each target', () => {
  const src = 'TYPE Pkg : STRUCT id : INT; END_STRUCT; END_TYPE\nFUNCTION_BLOCK Box\n  VAR_INPUT p : REF_TO Pkg; END_VAR\n  VAR n : INT; END_VAR\n  METHOD Id : INT\n    IF p <> NULL THEN Id := THIS.n; END_IF;\n  END_METHOD\n  IF p <> NULL THEN n := p^.id; END_IF;\nEND_FUNCTION_BLOCK\nVAR pk : Pkg; b : Box; r : REF_TO INT; s : REF_TO STRING[8]; x : INT; END_VAR\nr := REF(pk.id);\nr^ := 4;\nb(p := REF(pk));\nx := b.Id();'
  it('the .st export writes them as IEC does', () => {
    const out = exportProgram(src, 'iec-text').content
    expect(out).toMatch(/p : REF_TO Pkg;/)
    expect(out).toMatch(/r := REF\(pk\.id\);/)
    expect(out).toMatch(/r\^ := 4;/)
    expect(out).not.toMatch(/REFERENCE TO|REF=|__ISVALIDREF|THIS\^/)
  })

  it("the PLCopen file carries a REF_TO as TC6's own <pointer>", () => {
    const xml = toPlcopenXml(src)
    expect(xml).toContain('<pointer><baseType><derived name="Pkg"/></baseType></pointer>')
    expect(xml).toContain('<pointer><baseType><INT/></baseType></pointer>')
    expect(xml).toContain('<pointer><baseType><string length="8"/></baseType></pointer>')
    expect(xml).not.toMatch(/REFERENCE TO/)
  })
})

describe('the export entry point', () => {
  it('refuses to export a program that does not compile', () => {
    // exporting something that was never valid is how a broken file reaches a real PLC
    expect(() => exportProgram('VAR a : INT; END_VAR\na := Missing;', 'iec-text')).toThrow(/undeclared variable/)
    expect(() => exportProgram('VAR a : INT; END_VAR\na := Missing;', 'plcopen-xml')).toThrow(/undeclared variable/)
  })

  it('carries the caller\'s scan time into both targets', () => {
    // the editor passes its own PLC scan time, so the exported TASK states the period the
    // program was actually simulated at rather than a fixed 100 ms
    expect(exportProgram(PROGRAM, 'iec-text', { scanMs: 25 }).content).toContain('TASK Tick(INTERVAL := T#25ms, PRIORITY := 0);')
    expect(exportProgram(PROGRAM, 'plcopen-xml', { scanMs: 25 }).content).toContain('<task name="Tick" interval="T#25ms" priority="0">')
  })

  it('names the file after the project, per target', () => {
    expect(exportProgram(PROGRAM, 'iec-text', { projectName: 'Line 1' }).filename).toBe('line-1.st')
    expect(exportProgram(PROGRAM, 'plcopen-xml', { projectName: 'Line 1' }).filename).toBe('line-1.xml')
    expect(exportProgram(PROGRAM, 'iec-text', { projectName: '   ' }).filename).toBe('program.st')
  })

  it('warns when a FOR body rewrites its own bound', () => {
    // the one construct measured to run a different number of times per toolchain: the bound
    // is fixed at entry here, while MATIEC and RuSTy re-read it each pass (3 iterations
    // against 10). Neither is provably wrong, so the author is told rather than overruled.
    const w = exportProgram('VAR n : INT := 3; c : INT; i : INT; END_VAR\nFOR i := 1 TO n DO n := 10; c := c + 1; END_FOR;', 'iec-text').warnings
    expect(w.join(' ')).toMatch(/rewrites N.*its own bound is read from/)
    expect(w.join(' ')).toMatch(/WHILE/) // and says what to write instead
  })

  it('warns that MATIEC converts between a TIME and a number in seconds, and says what to write instead', () => {
    // measured: T#1500ms converts to 1 on MATIEC and 1500 to T#1500s, where this engine and STruC++ count
    // milliseconds (conformanceCases.ts "TIME_TO_DINT counts milliseconds", "DINT_TO_TIME and REAL_TO_TIME read the
    // number as milliseconds"). The engine keeps milliseconds; the export names the target that differs.
    const w = exportProgram('VAR t : TIME := T#1s; n : DINT; r : REAL; END_VAR\nn := TIME_TO_DINT(t);\nr := time_to_real(t);\nt := DINT_TO_TIME(n);', 'iec-text').warnings
    expect(w.filter((x) => /^DINT_TO_TIME, TIME_TO_DINT, TIME_TO_REAL: .*MATIEC.*counts seconds, both ways/.test(x))).toHaveLength(1)
    expect(w.join(' ')).toMatch(/keep the value a TIME and compare it with a TIME literal/)
    expect(w.join(' ')).not.toMatch(/TIME_TO_MS/) // no target the warning is for has it
    // a field converted the same way is warned about once, whatever it is called
    const named = exportProgram(
      'TYPE Tb : STRUCT ET : TIME; END_STRUCT; END_TYPE\nTYPE Recipe : STRUCT PRE : DINT; Base : Tb; END_STRUCT; END_TYPE\nVAR rc : Recipe; t : TIME; n : DINT; END_VAR\nt := DINT_TO_TIME(rc.PRE);\nn := TIME_TO_DINT(rc.Base.ET);',
      'iec-text',
    ).warnings
    expect(named.filter((x) => /^DINT_TO_TIME, TIME_TO_DINT: /.test(x))).toHaveLength(1)
    // a TIME kept a TIME, or turned into text, is the same everywhere
    const same = exportProgram('VAR t : TIME := T#1s; ok : BOOL; txt : STRING; END_VAR\nok := t >= T#5s;\ntxt := TIME_TO_STRING(t);', 'plcopen-xml').warnings
    expect(same).toEqual([])
  })

  it('leaves an ordinary loop alone', () => {
    const plain = exportProgram('VAR n : INT := 3; c : INT; i : INT; END_VAR\nFOR i := 1 TO n DO c := c + 1; END_FOR;', 'iec-text')
    expect(plain.warnings).toEqual([])
    // writing an ARRAY the loop walks is not writing the bound
    const arr = exportProgram('VAR n : INT := 3; a : ARRAY [1..3] OF INT; i : INT; END_VAR\nFOR i := 1 TO n DO a[i] := i; END_FOR;', 'iec-text')
    expect(arr.warnings).toEqual([])
  })

  it('finds the clash nested in a branch, and inside a function block', () => {
    const nested = exportProgram('VAR n : INT := 3; c : INT; i : INT; END_VAR\nFOR i := 1 TO n DO IF c > 0 THEN n := 10; END_IF; END_FOR;', 'iec-text')
    expect(nested.warnings.join(' ')).toMatch(/rewrites N/)
    const inFb = exportProgram(
      'FUNCTION_BLOCK Walk\nVAR n : INT := 3; i : INT; END_VAR\nFOR i := 1 TO n DO n := 10; END_FOR;\nEND_FUNCTION_BLOCK\nVAR w : Walk; END_VAR\nw();',
      'iec-text',
    )
    expect(inFb.warnings.join(' ')).toMatch(/FUNCTION_BLOCK Walk/)
  })

  it('warns when a declared name is an Instruction List operator', () => {
    // MATIEC shares one lexer between IL and ST, so LT/GE/EQ/ADD/... are keywords in ST too
    // and a variable called `lt` will not build there. We keep accepting the name (IEC does
    // not reserve it) and warn on export instead.
    const w = exportProgram('VAR_OUTPUT lt : BOOL; ge : BOOL; ok : BOOL; END_VAR\nlt := TRUE; ge := FALSE; ok := TRUE;', 'iec-text').warnings
    expect(w.join(' ')).toMatch(/Instruction List operator/)
    expect(w.join(' ')).toContain('lt')
    expect(w.join(' ')).toContain('ge')
    expect(w.join(' ')).not.toContain('ok')
    expect(exportProgram(PROGRAM, 'iec-text').warnings).toEqual([])
  })

  it('says out loud what the target may not carry', () => {
    const clean = exportProgram(PROGRAM, 'iec-text')
    expect(clean.warnings).toEqual([])
    const globals = exportProgram('VAR_GLOBAL Level : INT; END_VAR\nVAR x : INT; END_VAR\nx := Level;', 'iec-text')
    expect(globals.warnings.join(' ')).toMatch(/VAR_EXTERNAL/)
    const sub = exportProgram('TYPE Pct : INT (0..100); END_TYPE\nVAR p : Pct; END_VAR\n', 'iec-text')
    expect(sub.warnings.join(' ')).toMatch(/Subrange bounds/)
  })

  it('is deterministic - the same program exports byte-for-byte the same file', () => {
    const a = exportProgram(PROGRAM, 'plcopen-xml', { timestamp: '2026-01-01T00:00:00' })
    const b = exportProgram(PROGRAM, 'plcopen-xml', { timestamp: '2026-01-01T00:00:00' })
    expect(a.content).toBe(b.content)
  })
})

describe('a variable a target may not declare', () => {
  // S and R: a target with S= / R= set and reset assignments may reserve the two letters
  it('warns of each variable named S or R, saying where, in every format', () => {
    const src = `FUNCTION_BLOCK Latch
VAR_INPUT S, r : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := S AND NOT r;
END_FUNCTION_BLOCK
VAR Go : BOOL; L : Latch; END_VAR
L(S := Go, r := FALSE);
`
    for (const format of ['iec-text', 'plcopen-xml'] as const) {
      const said = exportProgram(src, format).warnings.join(' ')
      expect(said, format).toMatch(/S in Latch, r in Latch: a variable named S or R\. Some targets reserve those two letters/)
    }
  })

  it('says nothing of the other SFC qualifiers, or of a longer name', () => {
    const said = exportProgram('VAR N, L, D, P, SD, Set, Reset : BOOL; END_VAR\nN := L;', 'iec-text').warnings.join(' ')
    expect(said).not.toMatch(/named S or R/)
  })
})

describe('every corpus program survives both targets', () => {
  // The corpus is the widest spread of valid ST in the repo, so exporting all of it is the
  // cheapest broad check that the exporter does not crash or silently drop a construct.
  // `rejects` cases are skipped: they are meant not to compile.
  const valid = CONFORMANCE_CASES.filter((c) => !c.rejects)

  it('renders every case as IEC text with a program and a configuration', () => {
    for (const c of valid) {
      const text = renderIecText(c.src)
      // `Main` for the implicit program; a case with its own PROGRAMs keeps their names
      expect(text, c.name).toMatch(/^PROGRAM [A-Za-z_]\w*$/m)
      expect(text, c.name).toContain('END_CONFIGURATION')
      // The body crosses verbatim - nothing is rewritten on the way out, which is the
      // property the removed STRING[n] translation violated - but for the punctuation a vendor's
      // spelling leaves out, which `canonicalSyntax` writes back (the corpus's "tolerated input forms")
      expect(text, c.name).toContain(canonicalSyntax(c.src, { iecText: true }).trimEnd().split('\n').at(-1)!.trim())
    }
  })

  it('renders every case as PLCopen XML with a program POU and a closed root', () => {
    for (const c of valid) {
      const xml = toPlcopenXml(c.src)
      expect(xml, c.name).toMatch(/<pou name="[A-Za-z_]\w*" pouType="program">/)
      expect(xml, c.name).toContain('</project>')
      expect(xml, c.name).not.toContain('<STRING')
    }
  })
})
