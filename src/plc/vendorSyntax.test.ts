// Input forms strict IEC (and MATIEC) does not have, tolerated here so code written elsewhere pastes: a block
// statement or a data type without its closing `;`, STRUCT field defaults. Each is our own rule for reading; none is
// ever written out. The exporters write each back in the form every compiler
// reads (exportText.ts `canonicalSyntax`), which the last block here pins. Every program runs on both engines, and the
// engines' oracle compares everything each holds after every scan.

import { afterEach, describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { exportProgram } from './exchange/export'
import { canonicalSyntax } from './exchange/exportText'
import { importPlcopenXml } from './exchange/importXml'
import { compile, setScanEngine, type ScanEngine, typedRefusals } from './interpreter'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines } from './scanEngineOracle'
import type { CompiledProgram, TagValue } from './types'

afterEach(() => {
  setScanEngine('typed')
})

function build(src: string, on: ScanEngine): CompiledProgram {
  const was = setScanEngine(on)
  const refused = typedRefusals.length + codegenFallbacks.length
  try {
    return compile(src)
  } finally {
    setScanEngine(was)
    expect([...typedRefusals, ...codegenFallbacks].slice(refused), 'the typed engine refused it').toEqual([])
  }
}

function run(src: string, scans: number, want: Record<string, TagValue>): void {
  for (const on of ['walker', 'typed'] as const) {
    const p = build(src, on)
    for (let i = 0; i < scans; i++) p.scan(0.1)
    for (const [k, v] of Object.entries(want)) expect(p.get(k) ?? p.memory[k], `${on}: ${k}`).toBe(v)
  }
  const r = compareEngines(src, Array.from({ length: scans }, () => ({ in: {}, dt: 0.1 })))
  expect(r.refused).toBeUndefined()
  expect(r.diffs).toEqual([])
}

function refusal(src: string): string {
  return diagnostics(src).find((d) => d.severity === undefined)?.message ?? '(accepted)'
}

describe('a block statement or a data type without its closing semicolon', () => {
  it('reads END_IF, END_CASE, END_FOR, END_WHILE and END_REPEAT bare', () => {
    run(
      `VAR a : INT; b : INT; i : INT; n : INT; END_VAR
IF TRUE THEN a := 1; END_IF
CASE a OF 1: b := 2; END_CASE
FOR i := 1 TO 3 DO n := n + 1; END_FOR
WHILE n < 10 DO n := n + 1; END_WHILE
REPEAT n := n + 1; UNTIL n > 11 END_REPEAT
IF a = 1 THEN IF b = 2 THEN a := 5; END_IF END_IF`,
      1,
      { a: 5, b: 2, n: 12 },
    )
  })

  it('reads a data type with END_STRUCT and ) straight before END_TYPE, no closing ;', () => {
    run(
      `TYPE Pt :
STRUCT
  x : INT;
END_STRUCT
END_TYPE
TYPE Mode : (Idle, Run) END_TYPE
TYPE Pct : INT (0..100) END_TYPE
TYPE Speed : REAL END_TYPE
VAR p : Pt; m : Mode := Run; q : Pct := 7; s : Speed := 1.5; out : INT; END_VAR
p.x := q;
IF m = Run THEN out := p.x; END_IF`,
      1,
      { out: 7 },
    )
  })

  it('still needs one between two declarations of a TYPE block, and after every simple statement', () => {
    expect(refusal('TYPE A : INT\nB : INT; END_TYPE\nVAR a : A; END_VAR')).toContain("expected ';'")
    expect(refusal('VAR a : INT; b : INT; END_VAR\na := 1\nb := 2;')).toContain("expected ';'")
  })
})

describe('STRUCT field defaults', () => {
  const TYPES = `TYPE Axis :
STRUCT
  Speed : REAL := 1.5;
  Limit : INT := 100;
  Mode : Kind := Kind#Fast;
  Name : STRING := 'axis';
  Raw : INT;
END_STRUCT
END_TYPE
TYPE Kind : (Slow, Fast) END_TYPE
TYPE Cell :
STRUCT
  A : Axis;
  B : Axis := (Limit := 7);
  Arr : ARRAY [1..2] OF Axis;
END_STRUCT
END_TYPE
`

  it('starts every value of the struct at them: a variable, a field, an array element, an FB local, a function local', () => {
    run(
      `${TYPES}FUNCTION_BLOCK Fb
VAR_OUTPUT lim : INT; END_VAR
VAR a : Axis; END_VAR
lim := a.Limit;
a.Limit := a.Limit + 1;
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR a : Axis; END_VAR
F := a.Limit;
a.Limit := 0;
END_FUNCTION
VAR x : Axis; c : Cell; cs : ARRAY [0..2] OF Cell; fb : Fb;
  speed : REAL; lim : INT; fast : BOOL; name : STRING; raw : INT; cb : INT; ca : INT; arr : INT; csl : INT; fbl : INT; fl : INT;
END_VAR
speed := x.Speed; lim := x.Limit; fast := x.Mode = Kind#Fast; name := x.Name; raw := x.Raw;
cb := c.B.Limit; ca := c.A.Limit; arr := c.Arr[2].Limit; csl := cs[2].B.Limit;
fb(); fbl := fb.lim;
fl := F();`,
      2,
      { speed: 1.5, lim: 100, fast: true, name: 'axis', raw: 0, cb: 7, ca: 100, arr: 100, csl: 7, fbl: 101, fl: 100 },
    )
  })

  it("keeps what a declaration's own initializer names, the defaults filling the rest", () => {
    run(
      `${TYPES}VAR x : Axis := (Speed := 3.0); c : Cell := (B := (Speed := 2.0)); arr : ARRAY [1..2] OF Axis := [(Limit := 1), (Raw := 4)];
  s : REAL; l : INT; bs : REAL; bl : INT; a1 : INT; a2 : INT; r2 : INT;
END_VAR
s := x.Speed; l := x.Limit; bs := c.B.Speed; bl := c.B.Limit; a1 := arr[1].Limit; a2 := arr[2].Limit; r2 := arr[2].Raw;`,
      1,
      // c.B names only Speed: Limit comes from Cell's default for B (7), over Axis's own (100)
      { s: 3, l: 100, bs: 2, bl: 7, a1: 1, a2: 100, r2: 4 },
    )
  })

  it('reads a global CONSTANT or an enumeration member in a default', () => {
    run(
      `VAR_GLOBAL CONSTANT MaxLen : INT := 42; END_VAR
TYPE Kind : (Slow, Fast) END_TYPE
TYPE R : STRUCT n : INT := MaxLen * 2; k : Kind := Fast; END_STRUCT END_TYPE
VAR r : R; n : INT; isFast : BOOL; END_VAR
n := r.n; isFast := r.k = Fast;`,
      1,
      { n: 84, isFast: true },
    )
  })

  it('refuses a default that is not a constant, or that a POU would read differently', () => {
    expect(refusal('VAR_GLOBAL g : INT; END_VAR\nTYPE R : STRUCT n : INT := g; END_STRUCT END_TYPE\nVAR r : R; END_VAR')).toMatch(/must be a constant/)
    expect(refusal("TYPE R : STRUCT n : INT := 'x'; END_STRUCT END_TYPE\nVAR r : R; END_VAR")).not.toBe('(accepted)')
    expect(refusal('VAR_GLOBAL CONSTANT C : INT := 1; END_VAR\nTYPE R : STRUCT n : INT := C; END_STRUCT END_TYPE\nFUNCTION_BLOCK Fb\nVAR C : INT; r : R; END_VAR\nEND_FUNCTION_BLOCK\nVAR f : Fb; END_VAR')).toMatch(/reads 'C', which this POU declares too/)
  })
})

describe('an interface base in the __SYSTEM namespace, and PUBLIC on an interface method', () => {
  it('reads EXTENDS __SYSTEM.<name> and PUBLIC on a method as saying nothing', () => {
    run(
      `INTERFACE ICount EXTENDS __SYSTEM.IQueryInterface
METHOD PUBLIC Bump : INT
VAR_INPUT step : INT; END_VAR
END_METHOD
END_INTERFACE
INTERFACE INamed EXTENDS ICount, __System.IQueryInterface
END_INTERFACE
FUNCTION_BLOCK Counter IMPLEMENTS INamed
VAR n : INT; END_VAR
METHOD PUBLIC Bump : INT
VAR_INPUT step : INT; END_VAR
n := n + step;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR c : Counter; i : ICount; got : INT; END_VAR
i := c;
got := i.Bump(step := 2);`,
      2,
      { got: 4 },
    )
  })

  it('is left out of an export', () => {
    const out = canonicalSyntax(`INTERFACE A EXTENDS __SYSTEM.IQueryInterface
METHOD PUBLIC M : INT
END_METHOD
END_INTERFACE
INTERFACE B EXTENDS A, __SYSTEM.IQueryInterface
END_INTERFACE
INTERFACE C EXTENDS __SYSTEM.IQueryInterface, A, B
METHOD ABSTRACT PUBLIC N : INT
END_METHOD
END_INTERFACE
INTERFACE D EXTENDS A, __SYSTEM.IQueryInterface, B
END_INTERFACE
FUNCTION_BLOCK Fb
METHOD PUBLIC M : INT
END_METHOD
END_FUNCTION_BLOCK`)
    expect(out).toContain('INTERFACE A\nMETHOD M : INT')
    expect(out).toContain('INTERFACE B EXTENDS A\n')
    expect(out).toContain('INTERFACE C EXTENDS A, B\nMETHOD N : INT')
    expect(out).toContain('INTERFACE D EXTENDS A, B\n')
    expect(out).toContain('FUNCTION_BLOCK Fb\nMETHOD PUBLIC M : INT') // a block's method keeps what it says
    expect(out).not.toMatch(/__SYSTEM/i)
  })

  it('still refuses what an interface method cannot be', () => {
    expect(refusal('INTERFACE I\nMETHOD PRIVATE M : INT\nEND_METHOD\nEND_INTERFACE')).toMatch(/takes no PRIVATE/)
  })
})

describe('an argument named and given nothing', () => {
  it('reads Q => , and IN := , as not there', () => {
    run(
      `FUNCTION_BLOCK Fb
VAR_INPUT a : INT; b : INT; END_VAR
VAR_OUTPUT q : INT; r : INT; END_VAR
q := a + b; r := a;
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_INPUT x : INT; y : INT := 5; END_VAR
F := x + y;
END_FUNCTION
VAR fb : Fb; t : TON; got : INT; f : INT; et : TIME; END_VAR
fb(a := 3, b := , q => got, r => );
t(IN := TRUE, PT := T#1s, Q => , ET => et);
f := F(x := 1, y := );`,
      1,
      { got: 3, f: 6 },
    )
  })
})

describe('an enumeration member written Mode.Idle', () => {
  it('reads it in an expression, a CASE label, an initial value and a field default', () => {
    run(
      `TYPE Mode : (Idle, Run := 5, Stop) END_TYPE
TYPE Rec : STRUCT m : Mode := Mode.Stop; END_STRUCT END_TYPE
VAR m : Mode := Mode.Run; r : Rec; out : INT; isStop : BOOL; END_VAR
CASE m OF
  Mode.Idle: out := 1;
  Mode.Run, Mode.Stop: out := 2;
END_CASE
isStop := r.m = Mode.Stop;
IF m = Mode.Run THEN m := Mode.Idle; END_IF`,
      1,
      { out: 2, isStop: true },
    )
  })

  it('leaves a member of a variable of the same name alone, and names what an unknown member is', () => {
    expect(refusal('TYPE Mode : (Idle, Run) END_TYPE\nVAR m : Mode := Mode.Walk; END_VAR')).toMatch(/Walk/)
  })
})

describe('a namespace in front of a name outside a type position', () => {
  it('is no namespace: the engine knows no library by name', () => {
    expect(refusal("VAR s : STRING; END_VAR\ns := Lib.CONCAT('a', 'b');")).not.toBe('(accepted)')
  })

  it('is kept on export where a type stands, as written', () => {
    expect(canonicalSyntax('VAR t : Std.TON; END_VAR')).toBe('VAR t : Std.TON; END_VAR')
  })
})

describe('a variable linked in the I/O configuration: AT %I*, AT %Q*', () => {
  it('is a plain variable wherever one is declared: a program, a global, a block, a struct field', () => {
    run(
      `TYPE Io : STRUCT bIn AT %I* : BOOL; nOut AT %QW* : INT; END_STRUCT END_TYPE
VAR_GLOBAL gEye AT %IX* : BOOL; END_VAR
FUNCTION_BLOCK Cyl
VAR bExtended AT %I* : BOOL; bValve AT %Q* : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
bValve := NOT bExtended;
q := bValve;
END_FUNCTION_BLOCK
VAR io : Io; c : Cyl; start AT %I* : BOOL; out : INT; q : BOOL; END_VAR
io.nOut := 5; out := io.nOut;
c(); q := c.q AND NOT gEye AND NOT start;`,
      1,
      { out: 5, q: true },
    )
    expect(compile('VAR start AT %I* : BOOL; motor AT %Q* : BOOL; END_VAR\nmotor := start;').bindable).toEqual(['start', 'motor'])
  })

  it('still refuses a full address on a struct field', () => {
    expect(refusal('TYPE Io : STRUCT b AT %IX0.0 : BOOL; END_STRUCT END_TYPE')).toMatch(/a struct field cannot be located at %IX0.0/)
  })

  it('goes out as a plain variable, which every compiler builds', () => {
    expect(canonicalSyntax('VAR start AT %I* : BOOL; (* x AT %Q* *) END_VAR')).toBe('VAR start : BOOL; (* x AT %Q* *) END_VAR')
  })
})

describe('a type name the program does not declare', () => {
  it('is an unknown type, whatever another tool\'s library calls it', () => {
    expect(refusal('VAR s : T_MaxString; END_VAR')).toMatch(/unknown type 'T_MaxString'/)
    expect(refusal('VAR r : HRESULT; END_VAR')).toMatch(/unknown type 'HRESULT'/)
  })

  it('is the program\'s own when it declares it', () => {
    run('TYPE T_MaxString : STRING[255]; END_TYPE\nVAR s : T_MaxString; n : INT; END_VAR\ns := \'hello\'; n := LEN(s);', 1, { n: 5 })
  })

  it('declares nothing in front of an export', () => {
    expect(canonicalSyntax('VAR a : T_MaxString; END_VAR')).toBe('VAR a : T_MaxString; END_VAR')
  })
})

describe('AND_THEN and OR_ELSE, which are not IEC 61131-3', () => {
  it('are refused by name, with the IEC way to write a guard', () => {
    expect(refusal('VAR d : INT; a : BOOL; END_VAR\na := d <> 0 AND_THEN 10 / d > 1;')).toMatch(/AND_THEN is not part of IEC 61131-3; use nested IF statements, or AND \(which evaluates both sides\)/)
    expect(refusal('VAR d : INT; b : BOOL; END_VAR\nb := d = 0 OR_ELSE 10 / d > 1;')).toMatch(/OR_ELSE is not part of IEC 61131-3; .*OR \(which evaluates both sides\)/)
    expect(refusal('VAR d : INT; n : INT; END_VAR\nIF d <> 0 AND_THEN 100 / d > 0 THEN n := 1; END_IF')).toMatch(/AND_THEN is not part of IEC 61131-3/)
  })

  it('are still names a program may declare', () => {
    run('VAR and_then : BOOL; or_else : BOOL; END_VAR\nand_then := TRUE;\nor_else := and_then AND TRUE;', 1, { and_then: true, or_else: true })
  })
})

describe('a library type with its namespace, wherever only a type can stand', () => {
  it('reads JsonLib.Parser as Parser in a declaration, EXTENDS, IMPLEMENTS, ARRAY OF and a result', () => {
    run(
      `INTERFACE IThing
METHOD Get : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Parser IMPLEMENTS MyLib.IThing
VAR_OUTPUT n : INT; END_VAR
METHOD Get : INT
Get := 3;
END_METHOD
n := 2;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Better EXTENDS JsonLib.Parser
SUPER^();
END_FUNCTION_BLOCK
FUNCTION Make : OtherLib.INT_ALIAS
Make := 4;
END_FUNCTION
TYPE INT_ALIAS : INT; END_TYPE
VAR p : JsonLib.Parser; many : ARRAY [1..2] OF JsonLib.Better; got : INT; END_VAR
p(); many[1]();
got := p.n + many[1].n + p.Get() + Make();`,
      1,
      { got: 11 },
    )
  })
})

describe('an enumeration with a base type: (Idle, Run) UINT', () => {
  it('reads as the enumeration, its values what they always are', () => {
    run(
      `TYPE Mode :
(
  Idle := 0,
  Run := 10,
  Stop
) UINT;
END_TYPE
TYPE Small : (A, B) BYTE END_TYPE
VAR m : Mode := Mode.Stop; s : Small := B; stop : BOOL; isB : BOOL; END_VAR
stop := m = Mode.Stop; isB := s = Small#B;`,
      1,
      { stop: true, isB: true },
    )
  })

  it('refuses a value INT cannot hold, and a base that is not an integer', () => {
    expect(refusal('TYPE E : (A := 40000) UDINT; END_TYPE')).toMatch(/does not fit in INT/)
    expect(refusal('TYPE E : (A, B) REAL; END_TYPE')).toMatch(/base type is an integer type, not REAL/)
  })

  it('goes out without the base type, which IEC 2nd edition has no place for', () => {
    expect(canonicalSyntax('TYPE Mode : (Idle, Run) UINT; END_TYPE\nTYPE S : (A) INT END_TYPE')).toBe('TYPE Mode : (Idle, Run); END_TYPE\nTYPE S : (A); END_TYPE')
  })
})

describe('VAR PERSISTENT', () => {
  it('is read as retention, which a run with no restart starts at its initial value', () => {
    run('VAR_GLOBAL PERSISTENT g : INT := 3; END_VAR\nVAR PERSISTENT p : INT := 7; END_VAR\nVAR RETAIN PERSISTENT q : INT := 1; n : INT; END_VAR\nn := p + g + q;', 1, { n: 11 })
  })

  it('goes out as persistent in PLCopen, and as RETAIN in IEC text', () => {
    const src = 'VAR_GLOBAL PERSISTENT g : INT; END_VAR\nVAR PERSISTENT p : INT := 7; END_VAR\nVAR RETAIN PERSISTENT q : INT; END_VAR\np := q;'
    expect(exportProgram(src, 'plcopen-xml').content).toMatch(/<localVars retain="true" persistent="true">/)
    expect(canonicalSyntax(src, { iecText: true })).toBe('VAR_GLOBAL RETAIN g : INT; END_VAR\nVAR RETAIN p : INT := 7; END_VAR\nVAR RETAIN q : INT; END_VAR\np := q;')
  })
})

describe('a STRING capacity written as a constant: STRING(MAX_LEN)', () => {
  it('is folded against the global CONSTANTs, wherever a capacity can be written', () => {
    run(
      `VAR_GLOBAL CONSTANT MAX_LEN : INT := 5; END_VAR
TYPE Msg : STRUCT text : STRING(MAX_LEN); END_STRUCT END_TYPE
TYPE Short : STRING[MAX_LEN - 2]; END_TYPE
FUNCTION Cut : STRING(MAX_LEN)
VAR_INPUT s : STRING; END_VAR
Cut := s;
END_FUNCTION
VAR a : STRING(MAX_LEN); b : STRING[MAX_LEN * 2]; m : Msg; arr : ARRAY [1..2] OF STRING(MAX_LEN); sh : Short;
  la : INT; lb : INT; lm : INT; larr : INT; lsh : INT; lf : INT;
END_VAR
a := 'abcdefghijkl'; b := a; b := 'abcdefghijkl'; m.text := b; arr[1] := b; sh := b;
la := LEN(a); lb := LEN(b); lm := LEN(m.text); larr := LEN(arr[1]); lsh := LEN(sh); lf := LEN(Cut('abcdefgh'));`,
      1,
      { la: 5, lb: 10, lm: 5, larr: 5, lsh: 3, lf: 5 },
    )
  })

  it('goes out as the integer it folds to, IEC\'s form, and STRING(n) as STRING[n]', () => {
    const src = 'VAR_GLOBAL CONSTANT MAX_LEN : INT := 5; END_VAR\nVAR a : STRING(MAX_LEN); b : STRING[MAX_LEN * 2]; c : STRING(7); END_VAR\na := \'x\';'
    const out = exportProgram(src, 'iec-text').content
    expect(out).toContain('a : STRING[5];')
    expect(out).toContain('b : STRING[10];')
    expect(out).toContain('c : STRING[7];')
    expect(out).not.toMatch(/STRING\(|MAX_LEN \*/)
  })

  it('names a capacity that is not a constant', () => {
    expect(refusal('VAR n : INT := 5; s : STRING(n); END_VAR')).toMatch(/a STRING capacity must be a constant: 'n' is not an integer CONSTANT/)
    expect(refusal('VAR_GLOBAL CONSTANT Z : INT := 0; END_VAR\nVAR s : STRING(Z); END_VAR')).toMatch(/a STRING capacity must be a positive integer/)
  })
})

describe('an enumeration in a declaration: m : (Idle, Run, Stop)', () => {
  it('is an enumeration of the variable own, its members named bare', () => {
    run(
      `FUNCTION_BLOCK Seq
VAR state : (Wait, Go := 5, Done) := Go; END_VAR
VAR_OUTPUT atDone : BOOL; END_VAR
CASE state OF
  Wait: state := Go;
  Go: state := Done;
  Done: atDone := TRUE;
END_CASE
END_FUNCTION_BLOCK
VAR m, k : (Idle, Run, Stop) := Run; n : INT; s : Seq; fin : BOOL; END_VAR
IF m = Run THEN n := 1; END_IF;
m := Stop; k := m;
s(); fin := s.atDone;`,
      2,
      { n: 1, fin: true },
    )
  })

  it('is its own type: a member of another enumeration does not store into it', () => {
    expect(refusal('TYPE Other : (Up, Down) END_TYPE\nVAR m : (Idle, Run); END_VAR\nm := Up;')).toMatch(/enumeration \(Idle, Run\)/)
  })

  it('goes out as the variable type in PLCopen, and comes back as written', () => {
    const src = 'VAR m : (Idle, Run := 5, Stop) := Run; END_VAR\nm := Stop;'
    const xml = exportProgram(src, 'plcopen-xml').content
    expect(xml.replace(/>\s+</g, '><')).toContain('<type><enum><values><value name="Idle" value="0"/><value name="Run" value="5"/><value name="Stop" value="6"/></values></enum></type>')
    expect(xml).not.toContain('<dataType name="(')
    expect(importPlcopenXml(xml).source).toContain('m : (Idle, Run := 5, Stop) := Run;')
  })
})

describe('STRUCT EXTENDS, which is not IEC 61131-3', () => {
  it('is refused by name, with what to write instead', () => {
    expect(refusal('TYPE A : STRUCT x : INT; END_STRUCT END_TYPE\nTYPE B EXTENDS A : STRUCT y : INT; END_STRUCT END_TYPE')).toMatch(/a STRUCT cannot EXTEND another: IEC 61131-3 derives only function blocks and interfaces/)
    expect(refusal('TYPE B EXTENDS Lib.A : STRUCT y : INT; END_STRUCT END_TYPE')).toMatch(/a STRUCT cannot EXTEND another/)
  })
})

describe('export writes the canonical form', () => {
  it('writes Mode#Idle, and drops an empty argument with its comma', () => {
    const src = `TYPE Mode : (Idle, Run) END_TYPE
VAR m : Mode := Mode.Run; t : TON; x : INT; END_VAR
t(IN := TRUE, PT := T#1s, Q => , ET => );
t(Q => , IN := FALSE);
CASE m OF Mode.Idle: x := 1; END_CASE
x.0 := m = Mode.Idle; (* Mode.Idle in a comment stays *)`
    const out = canonicalSyntax(src)
    expect(out).toContain('m : Mode := Mode#Run;')
    expect(out).toContain('t(IN := TRUE, PT := T#1s);')
    expect(out).toContain('t(IN := FALSE);')
    expect(out).toContain('CASE m OF Mode#Idle: x := 1; END_CASE;')
    expect(out).toContain('(* Mode.Idle in a comment stays *)')
    expect(diagnostics(out).filter((d) => d.severity === undefined)).toEqual([])
    expect(canonicalSyntax(out)).toBe(out)
  })

  it('puts back every semicolon a vendor file left out', () => {
    const src = `TYPE Pt :
STRUCT
  x : INT := 3;
END_STRUCT
END_TYPE
TYPE Mode : (Idle, Run) END_TYPE
VAR a : INT; p : Pt; END_VAR
IF TRUE THEN a := 1; END_IF (* END_IF in a comment stays *)
FOR a := 1 TO 2 DO p.x := a; END_FOR;
CASE a OF 1: a := 2; END_CASE`
    const out = canonicalSyntax(src)
    expect(out).toContain('END_STRUCT;\nEND_TYPE')
    expect(out).toContain('(Idle, Run);')
    expect(out).toContain('END_IF; (* END_IF in a comment stays *)')
    expect(out).toContain('END_FOR;\n') // already there: not doubled
    expect(out).toMatch(/END_CASE;$/)
    // and it is still the same program
    expect(diagnostics(out).filter((d) => d.severity === undefined)).toEqual([])
    const text = exportProgram(src, 'iec-text').content
    expect(text).toContain('END_STRUCT;')
    expect(text).toContain('x : INT := 3;')
  })

  it('carries the defaults through PLCopen XML and back', () => {
    const src = `TYPE Axis : STRUCT Speed : REAL := 1.5; Limit : INT := 100; END_STRUCT END_TYPE
TYPE Cell : STRUCT B : Axis := (Limit := 7); END_STRUCT END_TYPE
VAR c : Cell; x : Axis := (Speed := 2.0); lim : INT; s : REAL; END_VAR
lim := c.B.Limit; s := x.Speed + c.B.Speed;`
    const back = importPlcopenXml(exportProgram(src, 'plcopen-xml').content).source
    expect(back).toMatch(/Limit : INT := 100;/)
    expect(back).toMatch(/B : Axis := \(Limit := 7\);/)
    run(back, 1, { lim: 7, s: 3.5 })
  })

  it('leaves the defaults on the type, not copied into every variable', () => {
    const xml = exportProgram('TYPE Pt : STRUCT x : INT := 3; y : INT; END_STRUCT END_TYPE\nVAR p : Pt; q : Pt := (y := 1); END_VAR', 'plcopen-xml').content
    expect(xml.match(/<simpleValue value="3"/g)?.length).toBe(1)
    expect(xml).toContain('member="y"')
    expect(xml).not.toContain('member="x"')
  })
})
