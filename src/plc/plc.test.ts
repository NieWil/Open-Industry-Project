import { describe, expect, it } from 'vitest'
import { compile, diagnostics, SAMPLE_PROGRAM } from './index'
import { LocalPlcLink } from './link/plcLink'
import { toTypeScript } from './emit'
import { StError } from './types'
import { lex } from './lexer'
import { parse } from './parser'

/** run a program for one scan with the given inputs; return the full variable image */
function once(src: string, inputs: Record<string, boolean | number> = {}, dt = 0.1) {
  const p = compile(src)
  for (const [k, v] of Object.entries(inputs)) p.setInput(k, v)
  p.scan(dt)
  return p
}

describe('faithful integer semantics', () => {
  it('wraps INT overflow two\'s-complement', () => {
    const p = once('VAR a : INT := 32767; b : INT; END_VAR\nb := a + 1;')
    expect(p.get('b')).toBe(-32768)
  })

  it('types integer literals by magnitude, so large-literal arithmetic does not wrap at INT width', () => {
    const p = once('VAR x : DINT; y : DINT; END_VAR\nx := 40000 + 0;\ny := -40000;')
    expect(p.get('x')).toBe(40000) // was -25536 when literals were always INT
    expect(p.get('y')).toBe(-40000) // unary minus wraps at the literal's own width
  })

  it('truncates integer division toward zero', () => {
    const p = once('VAR c : INT := -7; d : INT; m : INT; END_VAR\nd := c / 2;\nm := 7 / 2;')
    expect(p.get('d')).toBe(-3)
    expect(p.get('m')).toBe(3)
  })

  it('rejects an implicit REAL->INT narrowing, and rounds the explicit one ties-to-even', () => {
    // no implicit narrowing: a real compiler makes the author choose the conversion, and
    // so do we: accepting it here would pass code the target will not build
    expect(() => compile('VAR r : REAL := 2.7; a : INT; END_VAR\na := r;')).toThrow(/cannot assign REAL to 'a' of type INT/)
    const p = once('VAR r : REAL := 2.7; b : INT; t : INT; END_VAR\nb := REAL_TO_INT(r);\nt := REAL_TO_INT(2.5);')
    expect(p.get('b')).toBe(3)
    expect(p.get('t')).toBe(2) // ties to even
  })

  it('resolves same-width signed/unsigned mixes to the unsigned type regardless of order', () => {
    // UDINT, not DWORD: a bit string does no arithmetic, so the only same-width
    // tie left to resolve is signed vs unsigned, which IEC also declines to define
    const p = once('VAR ud : UDINT := 4294967295; di : DINT := 0; END_VAR VAR_OUTPUT a : LREAL; b : LREAL; END_VAR\na := ud + di;\nb := di + ud;')
    expect(p.get('a')).toBe(4294967295)
    expect(p.get('b')).toBe(4294967295) // unsigned wins on either side
  })

  it('refuses arithmetic on a bit string, and bitwise ops on a number', () => {
    // IEC keeps ANY_NUM and ANY_BIT apart at the operator level, not just on assignment.
    // Both of these would build on no target, so they must not compile here.
    expect(() => compile('VAR b : BYTE := 255; r : BYTE; END_VAR\nr := b + 1;')).toThrow(/\+ is arithmetic; 'BYTE' is a bit string.*BYTE_TO_USINT/)
    expect(() => compile('VAR i : INT := 1; r : INT; END_VAR\nr := NOT i;')).toThrow(/NOT is a bit-string operation; 'INT' is a number/)
    expect(() => compile('VAR i : INT := 1; j : INT := 2; r : INT; END_VAR\nr := i AND j;')).toThrow(/AND is a bit-string operation; 'INT' is a number/)
  })

  it('still lets an untyped literal adopt a bit-string context, as IEC and MATIEC both do', () => {
    const p = once('VAR w : WORD := 12; END_VAR VAR_OUTPUT m : WORD; nw : WORD; END_VAR\nm := w AND 10;\nnw := NOT 0;')
    expect(p.get('m')).toBe(8)
    expect(p.get('nw')).toBe(65535)
  })

  it('treats AND on bit-strings as bitwise, not logical', () => {
    const p = once('VAR f : WORD := 12; m : WORD := 10; bw : WORD; END_VAR\nbw := f AND m;')
    expect(p.get('bw')).toBe(8) // 1100 & 1010 = 1000
  })

  it('treats AND on BOOLs as logical', () => {
    const p = once('VAR_INPUT x : BOOL; y : BOOL; END_VAR VAR_OUTPUT z : BOOL; END_VAR\nz := x AND y;', { x: true, y: true })
    expect(p.get('z')).toBe(true)
  })

  it('wraps DINT multiply mod 2^32 (exact via imul)', () => {
    const p = once('VAR big : DINT := 100000; prod : DINT; END_VAR\nprod := big * big;')
    expect(p.get('prod')).toBe(Math.imul(100000, 100000))
  })

  it('keeps REAL division exact', () => {
    const p = once('VAR r : REAL := 7.0; q : REAL; END_VAR\nq := r / 2.0;')
    expect(p.get('q')).toBeCloseTo(3.5, 9)
  })

  it('faults the scan on integer division or MOD by zero, with a source position', () => {
    let err: StError | null = null
    try {
      once('VAR_INPUT n : INT; END_VAR VAR x : INT; END_VAR\nx := 10 / n;', { n: 0 })
    } catch (e) {
      err = e as StError
    }
    expect(err).toBeInstanceOf(StError)
    expect(err?.message).toBe('division by zero')
    expect(err?.pos.line).toBe(2)
    expect(() => once('VAR_INPUT n : INT; END_VAR VAR x : INT; END_VAR\nx := 10 MOD n;', { n: 0 })).toThrow(/MOD by zero/)
  })

  it('keeps REAL division by zero IEEE (Infinity), matching PLC float hardware', () => {
    const p = once('VAR r : REAL := 1.0; q : REAL; END_VAR\nq := r / 0.0;')
    expect(p.get('q')).toBe(Infinity) // floats flag but do not fault on real hardware
  })
})

describe('control flow', () => {
  it('selects the matching IF / ELSIF / ELSE branch', () => {
    const src = `VAR_INPUT n : INT; END_VAR VAR_OUTPUT band : INT; END_VAR
IF n < 0 THEN band := -1; ELSIF n = 0 THEN band := 0; ELSE band := 1; END_IF;`
    expect(once(src, { n: -5 }).get('band')).toBe(-1)
    expect(once(src, { n: 0 }).get('band')).toBe(0)
    expect(once(src, { n: 42 }).get('band')).toBe(1)
  })

  it('CASE selects a single label, a list, and a range; falls through to ELSE', () => {
    const src = `VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : INT; END_VAR
CASE n OF
  0: out := 100;
  1, 2: out := 200;
  3..5: out := 300;
ELSE
  out := -1;
END_CASE;`
    expect(once(src, { n: 0 }).get('out')).toBe(100)
    expect(once(src, { n: 2 }).get('out')).toBe(200)
    expect(once(src, { n: 4 }).get('out')).toBe(300)
    expect(once(src, { n: 9 }).get('out')).toBe(-1)
  })

  it('CASE matches a negative label', () => {
    const src = `VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : INT; END_VAR
CASE n OF -1: out := 7; ELSE out := 0; END_CASE;`
    expect(once(src, { n: -1 }).get('out')).toBe(7)
  })

  it('rejects a non-integer CASE selector', () => {
    expect(() => compile('VAR_INPUT b : BOOL; END_VAR VAR_OUTPUT o : INT; END_VAR\nCASE b OF 0: o := 1; END_CASE;')).toThrow(/CASE selector/)
  })

  it('FOR sums 1..5 with the loop variable readable in the body', () => {
    const p = once('VAR i : INT; sum : INT; END_VAR\nsum := 0;\nFOR i := 1 TO 5 DO sum := sum + i; END_FOR;')
    expect(p.get('sum')).toBe(15)
  })

  it('FOR honours a descending BY step', () => {
    const p = once('VAR i : INT; n : INT; END_VAR\nn := 0;\nFOR i := 10 TO 0 BY -2 DO n := n + 1; END_FOR;')
    expect(p.get('n')).toBe(6) // 10, 8, 6, 4, 2, 0
  })

  it('WHILE iterates until its condition is false', () => {
    const p = once('VAR i : INT; END_VAR\ni := 0;\nWHILE i < 4 DO i := i + 1; END_WHILE;')
    expect(p.get('i')).toBe(4)
  })

  it('REPEAT runs the body once, then stops when UNTIL is true', () => {
    const p = once('VAR i : INT; END_VAR\ni := 0;\nREPEAT i := i + 1; UNTIL i >= 3 END_REPEAT;')
    expect(p.get('i')).toBe(3)
  })

  it('EXIT breaks the nearest loop', () => {
    const p = once('VAR i : INT; last : INT; END_VAR\nlast := 0;\nFOR i := 1 TO 100 DO last := i; IF i = 5 THEN EXIT; END_IF; END_FOR;')
    expect(p.get('last')).toBe(5)
  })

  it('rejects EXIT outside a loop', () => {
    expect(() => compile('VAR x : INT; END_VAR\nx := 1; EXIT;')).toThrow(/EXIT/)
  })

  it('guards a runaway WHILE so it throws instead of hanging', () => {
    expect(() => once('VAR i : INT; END_VAR\nWHILE TRUE DO i := i + 1; END_WHILE;')).toThrow(/iteration limit/)
  })
})

describe('lexer: range vs decimal point', () => {
  it('splits `1..5` into number, `..`, number', () => {
    const toks = lex('1..5').filter((tk) => tk.kind !== 'eof')
    expect(toks.map((tk) => [tk.kind, tk.value])).toEqual([['num', '1'], ['op', '..'], ['num', '5']])
  })

  it('still lexes `2.5` as one real number', () => {
    const toks = lex('2.5').filter((tk) => tk.kind !== 'eof')
    expect(toks.map((tk) => [tk.kind, tk.value])).toEqual([['num', '2.5']])
  })
})

describe('function blocks', () => {
  it('TON delays Q by PT across scans', () => {
    const p = compile('VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT done : BOOL; END_VAR VAR t : TON; END_VAR\nt(IN := go, PT := T#1s);\ndone := t.Q;')
    p.setInput('go', true)
    for (let k = 0; k < 9; k++) p.scan(0.1)
    expect(p.get('done')).toBe(false) // 0.9s < 1s
    p.scan(0.1)
    p.scan(0.1)
    expect(p.get('done')).toBe(true) // >= 1s
  })

  it('R_TRIG fires for exactly one scan', () => {
    const p = compile('VAR_INPUT clk : BOOL; END_VAR VAR_OUTPUT edge : BOOL; END_VAR VAR r : R_TRIG; END_VAR\nr(CLK := clk);\nedge := r.Q;')
    p.setInput('clk', false); p.scan(0.1); expect(p.get('edge')).toBe(false)
    p.setInput('clk', true); p.scan(0.1); expect(p.get('edge')).toBe(true)
    p.scan(0.1); expect(p.get('edge')).toBe(false) // held high -> no further edge
  })

  it('CTU counts rising edges and sets Q at PV', () => {
    const p = compile('VAR_INPUT cu : BOOL; END_VAR VAR_OUTPUT full : BOOL; END_VAR VAR c : CTU; END_VAR\nc(CU := cu, RESET := FALSE, PV := 2);\nfull := c.Q;')
    const pulse = () => { p.setInput('cu', true); p.scan(0.1); p.setInput('cu', false); p.scan(0.1) }
    pulse(); expect(p.get('full')).toBe(false)
    pulse(); expect(p.get('full')).toBe(true)
  })

  it('TP fires a fixed-width pulse on a rising edge, ignoring IN changes during it', () => {
    const p = compile('VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TP; END_VAR\nt(IN := go, PT := T#0.5s);\nq := t.Q;')
    p.setInput('go', true); p.scan(0.1)
    expect(p.get('q')).toBe(true) // pulse started
    p.setInput('go', false); p.scan(0.1) // IN drops mid-pulse - the pulse holds
    expect(p.get('q')).toBe(true)
    for (let k = 0; k < 4; k++) p.scan(0.1) // ~0.6s total - past PT
    expect(p.get('q')).toBe(false)
  })

  it('CTUD counts up and down, raising QU at PV and QD at zero', () => {
    const src = `VAR_INPUT up : BOOL; dn : BOOL; END_VAR
VAR_OUTPUT atTop : BOOL; atBottom : BOOL; n : INT; END_VAR
VAR c : CTUD; END_VAR
c(CU := up, CD := dn, RESET := FALSE, LD := FALSE, PV := 2);
atTop := c.QU; atBottom := c.QD; n := c.CV;`
    const p = compile(src)
    const pulseUp = () => { p.setInput('up', true); p.setInput('dn', false); p.scan(0.1); p.setInput('up', false); p.scan(0.1) }
    const pulseDn = () => { p.setInput('dn', true); p.setInput('up', false); p.scan(0.1); p.setInput('dn', false); p.scan(0.1) }
    p.scan(0.1)
    expect(p.get('atBottom')).toBe(true) // CV starts at 0
    expect(p.get('atTop')).toBe(false)
    pulseUp(); expect(p.get('n')).toBe(1)
    pulseUp(); expect(p.get('n')).toBe(2); expect(p.get('atTop')).toBe(true); expect(p.get('atBottom')).toBe(false)
    pulseDn(); pulseDn(); expect(p.get('n')).toBe(0); expect(p.get('atBottom')).toBe(true)
  })

  it('TOF holds Q for PT after IN falls', () => {
    const p = compile('VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TOF; END_VAR\nt(IN := go, PT := T#0.5s);\nq := t.Q;')
    p.setInput('go', true); p.scan(0.1)
    expect(p.get('q')).toBe(true) // Q follows IN immediately
    p.setInput('go', false)
    for (let k = 0; k < 4; k++) p.scan(0.1) // 0.4s < 0.5s
    expect(p.get('q')).toBe(true) // still held after IN fell
    p.scan(0.1); p.scan(0.1)
    expect(p.get('q')).toBe(false) // past PT
  })

  it('TOF stays false from cold start when IN was never true', () => {
    const p = compile('VAR_OUTPUT q : BOOL; END_VAR VAR t : TOF; END_VAR\nt(IN := FALSE, PT := T#1s);\nq := t.Q;')
    p.scan(0.1)
    expect(p.get('q')).toBe(false) // no spurious startup pulse
  })

  it('F_TRIG fires for exactly one scan on a falling edge, not at startup', () => {
    const p = compile('VAR_INPUT clk : BOOL; END_VAR VAR_OUTPUT edge : BOOL; END_VAR VAR f : F_TRIG; END_VAR\nf(CLK := clk);\nedge := f.Q;')
    p.scan(0.1); expect(p.get('edge')).toBe(false) // CLK never true -> no startup pulse
    p.setInput('clk', true); p.scan(0.1); expect(p.get('edge')).toBe(false)
    p.setInput('clk', false); p.scan(0.1); expect(p.get('edge')).toBe(true)
    p.scan(0.1); expect(p.get('edge')).toBe(false) // held low -> no further edge
  })

  it('CTD loads PV, counts down to zero, and clamps there', () => {
    const src = `VAR_INPUT cd : BOOL; ld : BOOL; END_VAR VAR_OUTPUT empty : BOOL; n : INT; END_VAR VAR c : CTD; END_VAR
c(CD := cd, LD := ld, PV := 2);
empty := c.Q; n := c.CV;`
    const p = compile(src)
    p.setInput('ld', true); p.scan(0.1)
    expect(p.get('n')).toBe(2); expect(p.get('empty')).toBe(false)
    p.setInput('ld', false)
    const pulse = () => { p.setInput('cd', true); p.scan(0.1); p.setInput('cd', false); p.scan(0.1) }
    pulse(); expect(p.get('n')).toBe(1); expect(p.get('empty')).toBe(false)
    pulse(); expect(p.get('n')).toBe(0); expect(p.get('empty')).toBe(true)
    pulse(); expect(p.get('n')).toBe(0) // clamped at zero
  })

  it('CTU clamps CV at the INT maximum instead of counting past it', () => {
    const p = compile('VAR_INPUT cu : BOOL; END_VAR VAR c : CTU; END_VAR\nc(CU := cu, PV := 5);')
    for (let k = 0; k < 2 * 32770; k++) {
      p.setInput('cu', k % 2 === 0)
      p.scan(0.001)
    }
    expect(p.watch['c.CV']).toBe(32767)
  })

  it('accepts R (the IEC spelling) as the counter reset alongside RESET', () => {
    const p = compile('VAR_INPUT cu : BOOL; rst : BOOL; END_VAR VAR_OUTPUT n : INT; END_VAR VAR c : CTU; END_VAR\nc(CU := cu, R := rst, PV := 5);\nn := c.CV;')
    p.setInput('cu', true); p.scan(0.1)
    expect(p.get('n')).toBe(1)
    p.setInput('rst', true); p.scan(0.1)
    expect(p.get('n')).toBe(0)
  })

  it('exposes FB output members in the watch image (inst.member), tracking the value', () => {
    const p = compile('VAR_INPUT go : BOOL; END_VAR VAR t : TON; END_VAR\nt(IN := go, PT := T#1s);')
    p.setInput('go', true)
    // 6 scans, not 5, for 500ms of elapsed time: the scan that sees the rising edge starts
    // the clock and elapses nothing, the way IEC's own TON body does
    for (let k = 0; k < 6; k++) p.scan(0.1)
    expect(p.watch['t.Q']).toBe(false) // 0.5s < 1s
    expect(p.watch['t.ET']).toBeCloseTo(500, 5) // ET is TIME, so milliseconds
    for (let k = 0; k < 6; k++) p.scan(0.1)
    expect(p.watch['t.Q']).toBe(true) // >= 1s
    expect('t.IN' in p.watch).toBe(false) // inputs aren't retained on the instance
  })
})

describe('user-defined function blocks', () => {
  it('an SR latch FB holds state across scans', () => {
    const src = `FUNCTION_BLOCK SR
VAR_INPUT S : BOOL; R : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
IF S THEN Q := TRUE; ELSIF R THEN Q := FALSE; END_IF;
END_FUNCTION_BLOCK
VAR_INPUT setb : BOOL; rstb : BOOL; END_VAR
VAR_OUTPUT out : BOOL; END_VAR
VAR latch : SR; END_VAR
latch(S := setb, R := rstb);
out := latch.Q;`
    const p = compile(src)
    p.setInput('setb', true); p.setInput('rstb', false); p.scan(0.1)
    expect(p.get('out')).toBe(true)
    p.setInput('setb', false); p.scan(0.1)
    expect(p.get('out')).toBe(true) // latched - the FB's Q persists
    p.setInput('rstb', true); p.scan(0.1)
    expect(p.get('out')).toBe(false)
  })

  it('a counting FB accumulates in its own persistent VAR, and shows in the watch image', () => {
    const src = `FUNCTION_BLOCK Accum
VAR_INPUT add : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
total := total + add;
END_FUNCTION_BLOCK
VAR_INPUT n : INT; END_VAR VAR_OUTPUT sum : INT; END_VAR VAR acc : Accum; END_VAR
acc(add := n);
sum := acc.total;`
    const p = compile(src)
    p.setInput('n', 3); p.scan(0.1)
    expect(p.get('sum')).toBe(3)
    p.setInput('n', 4); p.scan(0.1)
    expect(p.get('sum')).toBe(7) // accumulated across scans
    expect(p.watch['acc.total']).toBe(7)
  })

  it('FBs nest: an FB instance inside another FB', () => {
    const src = `FUNCTION_BLOCK Inner
VAR_INPUT a : INT; END_VAR VAR_OUTPUT b : INT; END_VAR
b := a + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Outer
VAR_INPUT x : INT; END_VAR VAR_OUTPUT y : INT; END_VAR VAR i : Inner; END_VAR
i(a := x);
y := i.b + 10;
END_FUNCTION_BLOCK
VAR_INPUT n : INT; END_VAR VAR_OUTPUT r : INT; END_VAR VAR o : Outer; END_VAR
o(x := n);
r := o.y;`
    const p = compile(src)
    p.setInput('n', 5); p.scan(0.1)
    expect(p.get('r')).toBe(16) // inner 5+1=6, outer 6+10=16
  })

  it('rejects an unknown instance type', () => {
    expect(() => compile('VAR x : Nope; END_VAR\n')).toThrow(/unknown type 'Nope'/)
  })

  it('rejects a call with a parameter that is not an input', () => {
    const src = `FUNCTION_BLOCK F VAR_INPUT a : INT; END_VAR VAR_OUTPUT b : INT; END_VAR b := a; END_FUNCTION_BLOCK
VAR f : F; o : INT; END_VAR
f(z := 1);`
    expect(() => compile(src)).toThrow(/has no input 'z'/)
  })

  it('rejects reading a member that is not an output', () => {
    const src = `FUNCTION_BLOCK F VAR_INPUT a : INT; END_VAR VAR_OUTPUT b : INT; END_VAR b := a; END_FUNCTION_BLOCK
VAR f : F; o : INT; END_VAR
o := f.a;`
    expect(() => compile(src)).toThrow(/no readable output 'a'/)
  })

  it('rejects a recursive function block', () => {
    const src = `FUNCTION_BLOCK A VAR self : A; END_VAR END_FUNCTION_BLOCK
VAR x : A; END_VAR`
    expect(() => compile(src)).toThrow(/recursive function block 'A'/)
  })

  it('rejects a duplicate function block name', () => {
    const src = `FUNCTION_BLOCK A END_FUNCTION_BLOCK
FUNCTION_BLOCK A END_FUNCTION_BLOCK
VAR x : INT; END_VAR`
    expect(() => compile(src)).toThrow(/duplicate definition 'A'/)
  })

  it('emits a class per function block', () => {
    const src = `FUNCTION_BLOCK SR
VAR_INPUT S : BOOL; R : BOOL; END_VAR VAR_OUTPUT Q : BOOL; END_VAR
IF S THEN Q := TRUE; ELSIF R THEN Q := FALSE; END_IF;
END_FUNCTION_BLOCK
VAR latch : SR; END_VAR
latch(S := FALSE, R := FALSE);`
    const ts = toTypeScript(src)
    expect(ts).toContain('class SR')
    expect(ts).toContain('S.latch = new SR()')
    expect(ts).toContain('S.latch.call(')
  })
})

describe('user-defined functions', () => {
  it('calls a scalar function inline in an expression', () => {
    const src = `FUNCTION Clamp : INT
VAR_INPUT v : INT; lo : INT; hi : INT; END_VAR
IF v < lo THEN Clamp := lo; ELSIF v > hi THEN Clamp := hi; ELSE Clamp := v; END_IF;
END_FUNCTION
VAR_INPUT x : INT; END_VAR VAR_OUTPUT y : INT; END_VAR
y := Clamp(x, 0, 100) + 1;`
    expect(once(src, { x: 250 }).get('y')).toBe(101) // clamped to 100, then +1
    expect(once(src, { x: -7 }).get('y')).toBe(1)    // clamped to 0, then +1
    expect(once(src, { x: 42 }).get('y')).toBe(43)
  })

  it('is called on both sides of a BOOL AND / OR, even once the result is decided', () => {
    // The corpus case pins that a guard does not protect a divide; this pins the other half of the
    // same rule, which only a side effect can see: the call on the decided side still happens. A
    // function reaching a global directly is this engine's permissiveness (strict IEC routes it
    // through VAR_EXTERNAL, which a FUNCTION may not declare), so it is pinned here, not in the
    // corpus.
    const src = (expr: string): string => `VAR_GLOBAL calls : INT; END_VAR
FUNCTION Ping : BOOL
VAR_INPUT v : BOOL; END_VAR
calls := calls + 1;
Ping := v;
END_FUNCTION
VAR gate : BOOL; out : BOOL; END_VAR
out := ${expr};`
    expect(once(src('gate AND Ping(TRUE)')).get('calls')).toBe(1)      // FALSE decided the AND, and it ran anyway
    expect(once(src('NOT gate OR Ping(TRUE)')).get('calls')).toBe(1)   // TRUE decided the OR, same
    expect(once(src('NOT gate AND Ping(TRUE)')).get('calls')).toBe(1)  // undecided
    expect(once(src('gate XOR Ping(TRUE)')).get('calls')).toBe(1)      // XOR needs both sides
  })

  it('is stateless - locals reset on every call', () => {
    const src = `FUNCTION Inc : INT
VAR_INPUT v : INT; END_VAR VAR tmp : INT; END_VAR
tmp := tmp + v;
Inc := tmp;
END_FUNCTION
VAR_INPUT n : INT; END_VAR VAR_OUTPUT a : INT; b : INT; END_VAR
a := Inc(n);
b := Inc(n);`
    const p = once(src, { n: 5 })
    expect(p.get('a')).toBe(5)
    expect(p.get('b')).toBe(5) // tmp did not carry over between calls
  })

  it('functions call other functions', () => {
    const src = `FUNCTION Dbl : INT VAR_INPUT v : INT; END_VAR Dbl := v * 2; END_FUNCTION
FUNCTION Quad : INT VAR_INPUT v : INT; END_VAR Quad := Dbl(Dbl(v)); END_FUNCTION
VAR_INPUT n : INT; END_VAR VAR_OUTPUT r : INT; END_VAR
r := Quad(n);`
    expect(once(src, { n: 3 }).get('r')).toBe(12)
  })

  it('rejects a wrong argument count', () => {
    const src = `FUNCTION F : INT VAR_INPUT a : INT; b : INT; END_VAR F := a + b; END_FUNCTION
VAR_OUTPUT y : INT; END_VAR
y := F(1);`
    expect(() => compile(src)).toThrow(/expects 2 argument/)
  })

  it('rejects an unknown function', () => {
    expect(() => compile('VAR_OUTPUT y : INT; END_VAR\ny := Nope(1);')).toThrow(/unknown function 'Nope'/)
  })

  it('rejects a function-block instance inside a function', () => {
    const src = `FUNCTION F : INT VAR_INPUT a : INT; END_VAR VAR t : TON; END_VAR F := a; END_FUNCTION
VAR_OUTPUT y : INT; END_VAR
y := F(1);`
    expect(() => compile(src)).toThrow(/function cannot contain function-block/)
  })

  it('rejects a recursive function at compile time', () => {
    const src = `FUNCTION F : INT VAR_INPUT a : INT; END_VAR F := F(a); END_FUNCTION
VAR_OUTPUT y : INT; END_VAR
y := F(1);`
    expect(() => compile(src)).toThrow(/recursive function 'F'/)
  })

  it('emits a function definition and a call', () => {
    const src = `FUNCTION Dbl : INT VAR_INPUT v : INT; END_VAR Dbl := v * 2; END_FUNCTION
VAR_OUTPUT y : INT; END_VAR
y := Dbl(3);`
    const ts = toTypeScript(src)
    expect(ts).toContain('function Dbl(v)')
    expect(ts).toContain('Dbl(3)')
  })
})

describe('arrays', () => {
  it('writes and reads a 0-based array in loops', () => {
    const src = `VAR_INPUT n : INT; END_VAR VAR_OUTPUT total : INT; END_VAR
VAR a : ARRAY[0..4] OF INT; i : INT; END_VAR
FOR i := 0 TO 4 DO a[i] := i * n; END_FOR;
total := 0;
FOR i := 0 TO 4 DO total := total + a[i]; END_FOR;`
    expect(once(src, { n: 2 }).get('total')).toBe(20) // 0 + 2 + 4 + 6 + 8
  })

  it('supports a non-zero lower bound', () => {
    const src = `VAR_OUTPUT s : INT; END_VAR VAR a : ARRAY[1..3] OF INT; END_VAR
a[1] := 10; a[2] := 20; a[3] := 30;
s := a[1] + a[2] + a[3];`
    expect(once(src).get('s')).toBe(60)
  })

  it('supports BOOL element arrays', () => {
    const src = `VAR_INPUT on : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR b : ARRAY[0..1] OF BOOL; END_VAR
b[0] := on; b[1] := NOT on;
q := b[0] AND NOT b[1];`
    expect(once(src, { on: true }).get('q')).toBe(true)
  })

  it('throws on an out-of-bounds index at runtime', () => {
    expect(() => once('VAR a : ARRAY[0..2] OF INT; END_VAR\na[5] := 1;')).toThrow(/out of bounds/)
  })

  it('rejects a non-integer index', () => {
    expect(() => compile('VAR a : ARRAY[0..2] OF INT; END_VAR\na[1.5] := 1;')).toThrow(/index must be an integer/)
  })

  it('rejects using an array without an index', () => {
    expect(() => compile('VAR a : ARRAY[0..2] OF INT; x : INT; END_VAR\nx := a;')).toThrow(/is an array/)
  })

  it('rejects storing a scalar into a whole array (it only takes another array of its own type)', () => {
    expect(() => compile('VAR a : ARRAY[0..2] OF INT; END_VAR\na := 1;')).toThrow(/cannot assign INT to 'a' of type ARRAY\[0\.\.2\] OF INT/)
  })

  it('emits array init and indexing', () => {
    const src = `VAR_OUTPUT s : INT; END_VAR VAR a : ARRAY[0..2] OF INT; END_VAR
a[0] := 5;
s := a[0];`
    const ts = toTypeScript(src)
    expect(ts).toContain('Array.from({ length: 3 }')
    // both ends of an indexed place are bounds-checked, so neither is a raw JS subscript
    expect(ts).toContain('elemSet(S.a, 0, 0, 2, 5)')
    expect(ts).toContain('elemAt(S.a, 0, 0, 2)')
  })
})

describe('nested structures and N-D arrays', () => {
  it('reads and writes a 2-D array', () => {
    const src = `VAR_INPUT n : INT; END_VAR VAR_OUTPUT total : INT; END_VAR
VAR m : ARRAY[0..1, 0..2] OF INT; i : INT; j : INT; END_VAR
FOR i := 0 TO 1 DO FOR j := 0 TO 2 DO m[i, j] := (i * 3 + j) * n; END_FOR; END_FOR;
total := 0;
FOR i := 0 TO 1 DO FOR j := 0 TO 2 DO total := total + m[i, j]; END_FOR; END_FOR;`
    expect(once(src, { n: 2 }).get('total')).toBe(30) // (0+1+2+3+4+5) * 2
  })

  it('a struct can contain an array field', () => {
    const src = `TYPE Buf : STRUCT data : ARRAY[0..2] OF INT; count : INT; END_STRUCT; END_TYPE
VAR_INPUT n : INT; END_VAR VAR_OUTPUT sum : INT; END_VAR VAR b : Buf; i : INT; END_VAR
FOR i := 0 TO 2 DO b.data[i] := n + i; END_FOR;
b.count := 3;
sum := b.data[0] + b.data[1] + b.data[2] + b.count;`
    expect(once(src, { n: 10 }).get('sum')).toBe(36) // 10 + 11 + 12 + 3
  })

  it('structs nest (a struct field of struct type)', () => {
    const src = `TYPE Inner : STRUCT v : INT; END_STRUCT;
  Outer : STRUCT a : Inner; b : Inner; END_STRUCT;
END_TYPE
VAR_INPUT x : INT; y : INT; END_VAR VAR_OUTPUT s : INT; END_VAR VAR o : Outer; END_VAR
o.a.v := x;
o.b.v := y;
s := o.a.v + o.b.v;`
    expect(once(src, { x: 4, y: 5 }).get('s')).toBe(9)
  })

  it('supports arrays of structs', () => {
    const src = `TYPE Item : STRUCT id : INT; qty : INT; END_STRUCT; END_TYPE
VAR_OUTPUT total : INT; END_VAR VAR items : ARRAY[0..1] OF Item; END_VAR
items[0].qty := 10; items[1].qty := 20;
total := items[0].qty + items[1].qty;`
    expect(once(src).get('total')).toBe(30)
  })

  it('retains nested aggregate state across scans', () => {
    const src = `TYPE Acc : STRUCT vals : ARRAY[0..1] OF INT; END_STRUCT; END_TYPE
VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : INT; END_VAR VAR a : Acc; END_VAR
a.vals[0] := a.vals[0] + n;
out := a.vals[0];`
    const p = compile(src)
    p.setInput('n', 5); p.scan(0.1); expect(p.get('out')).toBe(5)
    p.setInput('n', 4); p.scan(0.1); expect(p.get('out')).toBe(9)
  })

  it('rejects the wrong number of array indices', () => {
    expect(() => compile('VAR a : ARRAY[0..1, 0..1] OF INT; END_VAR\na[0] := 1;')).toThrow(/expects 2 index/)
  })

  it('rejects a recursive struct', () => {
    const src = `TYPE Node : STRUCT next : Node; END_STRUCT; END_TYPE
VAR n : Node; END_VAR`
    expect(() => compile(src)).toThrow(/recursive struct 'Node'/)
  })

  it('rejects an unknown struct field type', () => {
    expect(() => compile('TYPE P : STRUCT q : Nope; END_STRUCT; END_TYPE\nVAR p : P; END_VAR')).toThrow(/unknown type 'Nope'/)
  })
})

describe('structs', () => {
  it('reads and writes struct fields', () => {
    const src = `TYPE Point : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE
VAR_INPUT a : INT; b : INT; END_VAR VAR_OUTPUT sum : INT; END_VAR VAR p : Point; END_VAR
p.x := a; p.y := b;
sum := p.x + p.y;`
    expect(once(src, { a: 3, b: 4 }).get('sum')).toBe(7)
  })

  it('retains struct state across scans', () => {
    const src = `TYPE Acc : STRUCT total : INT; END_STRUCT; END_TYPE
VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : INT; END_VAR VAR s : Acc; END_VAR
s.total := s.total + n;
out := s.total;`
    const p = compile(src)
    p.setInput('n', 5); p.scan(0.1); expect(p.get('out')).toBe(5)
    p.setInput('n', 3); p.scan(0.1); expect(p.get('out')).toBe(8)
  })

  it('supports multiple types in one TYPE block and BOOL fields', () => {
    const src = `TYPE
  Flags : STRUCT run : BOOL; fault : BOOL; END_STRUCT;
  Pair : STRUCT lo : INT; hi : INT; END_STRUCT;
END_TYPE
VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR f : Flags; END_VAR
f.run := go; f.fault := NOT go;
q := f.run AND NOT f.fault;`
    expect(once(src, { go: true }).get('q')).toBe(true)
  })

  it('rejects an unknown field', () => {
    const src = `TYPE P : STRUCT x : INT; END_STRUCT; END_TYPE
VAR p : P; o : INT; END_VAR
o := p.z;`
    expect(() => compile(src)).toThrow(/has no field 'z'/)
  })

  it('rejects using a struct without a field', () => {
    const src = `TYPE P : STRUCT x : INT; END_STRUCT; END_TYPE
VAR p : P; o : INT; END_VAR
o := p;`
    expect(() => compile(src)).toThrow(/is a struct/)
  })

  it('rejects an unknown type', () => {
    expect(() => compile('VAR p : Nope; END_VAR\np.x := 1;')).toThrow(/unknown type 'Nope'/)
  })

  it('emits struct init and field access', () => {
    const src = `TYPE P : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE
VAR_OUTPUT s : INT; END_VAR VAR p : P; END_VAR
p.x := 5;
s := p.x;`
    const ts = toTypeScript(src)
    expect(ts).toContain('S.p = { x: 0, y: 0 }')
    expect(ts).toContain('S.p.x = 5')
  })
})

describe('seal-in latch + on-delay lamp (SAMPLE_PROGRAM)', () => {
  it('latches, seals in, delays the lamp, and unlatches', () => {
    const p = compile(SAMPLE_PROGRAM)
    p.setInput('Start', true); p.setInput('Stop', false); p.scan(0.1)
    expect(p.get('Motor')).toBe(true)
    p.setInput('Start', false); p.scan(0.1)
    expect(p.get('Motor')).toBe(true) // seal-in holds
    expect(p.get('Lamp')).toBe(false) // before 2s
    for (let k = 0; k < 20; k++) p.scan(0.1)
    expect(p.get('Lamp')).toBe(true) // after 2s on-delay
    p.setInput('Stop', true); p.scan(0.1)
    expect(p.get('Motor')).toBe(false)
    expect(p.get('Lamp')).toBe(false)
  })
})

describe('PlcLink seam', () => {
  it('exposes inputs/outputs and steps with a tag map', () => {
    const link = new LocalPlcLink(SAMPLE_PROGRAM)
    expect(link.inputs).toEqual(['Start', 'Stop'])
    expect(link.outputs).toEqual(['Motor', 'Lamp'])
    const out = link.step({ Start: true, Stop: false }, 0.1)
    expect(out).toEqual({ Motor: true, Lamp: false })
    expect(link.watch.Motor).toBe(true)
  })

  it('holds a forced input against the scene and a forced output against the program until released', () => {
    const link = new LocalPlcLink(SAMPLE_PROGRAM)
    link.setForces({ Stop: true, Lamp: true })
    // the scene feeds Start and a released Stop, but the program reads the forced Stop, so the motor stays off
    expect(link.step({ Start: true, Stop: false }, 0.1)).toEqual({ Motor: false, Lamp: true })
    expect(link.step({ Start: true, Stop: false }, 0.1)).toEqual({ Motor: false, Lamp: true })
    expect(link.watch.Lamp).toBe(true)
    link.setForces({})
    expect(link.step({ Start: true, Stop: false }, 0.1)).toEqual({ Motor: true, Lamp: false })
  })

  it('holds one bit of a word and a struct field by name, as it holds a plain variable by its port', () => {
    const link = new LocalPlcLink(`TYPE Pair : STRUCT A : BOOL; B : BOOL; END_STRUCT; END_TYPE
VAR_OUTPUT
  W : WORD;
  P : Pair;
END_VAR
W := 0;
P.A := FALSE;
`)
    link.setForces({ 'W.2': true, 'P.A': true })
    link.step({}, 0.1)
    expect(link.watch.W).toBe(4)
    expect(link.watch['P.A']).toBe(true)
  })
})

describe('diagnostics carry source positions', () => {
  it('reports undeclared variables with a position', () => {
    let err: StError | null = null
    try {
      compile('VAR a : INT; END_VAR\na := b + 1;')
    } catch (e) {
      err = e as StError
    }
    expect(err).toBeInstanceOf(StError)
    expect(err?.message).toContain("undeclared variable 'b'")
    expect(err?.pos.line).toBe(2)
    expect(err?.pos.col).toBe(6) // 'b' sits at column 6 of line 2
  })

  it('rejects assigning to a function block', () => {
    expect(() => compile('VAR t : TON; END_VAR\nt := 1;')).toThrow(/cannot assign to function block/)
  })

  it('rejects arithmetic that mixes BOOL', () => {
    expect(() => compile('VAR a : BOOL; b : INT; c : INT; END_VAR\nc := a + b;')).toThrow(StError)
  })

  it('rejects a misspelled builtin-FB input name instead of silently ignoring it', () => {
    expect(() => compile('VAR t : TON; END_VAR\nt(INN := TRUE, PT := T#1s);')).toThrow(/TON has no input 'INN'/)
  })

  it('rejects MOD on REAL operands at compile time (IEC: integers only)', () => {
    expect(() => compile('VAR r : REAL; q : REAL; END_VAR\nq := r MOD 2.0;')).toThrow(/MOD is defined for integers only/)
  })
})

describe('lexer/parser positions', () => {
  it('tracks line and column through comments and newlines', () => {
    const toks = lex('VAR\n  x : INT; (* note *) y : INT;\nEND_VAR')
    const y = toks.find((t) => t.value === 'y')
    expect(y?.pos.line).toBe(2)
    const ast = parse(toks)
    expect(ast.decls.map((d) => d.name)).toEqual(['x', 'y'])
  })
})

describe('ST -> TypeScript emitter', () => {
  it('checks a subrange store, after the coercion and before the store', () => {
    const ts = toTypeScript(`TYPE Percent : INT (0..100); END_TYPE
VAR n : INT := 250; level : Percent; END_VAR
level := n;`)
    expect(ts).toContain("inRange(S.n, 'Percent', 0, 100)")
  })

  it('guards every emitted loop, so it faults where the interpreter faults instead of hanging', () => {
    const ts = toTypeScript(`VAR i : INT; n : INT; END_VAR
FOR i := 1 TO 3 BY 1 DO n := n + 1; END_FOR;
WHILE n < 10 DO n := n + 1; END_WHILE;
REPEAT n := n - 1; UNTIL n <= 0 END_REPEAT;`)
    expect(ts).toContain('__by = forStep(1)')       // a zero BY is refused at entry
    expect(ts).toContain("loopGuard(++__n, 'FOR')")
    expect(ts).toContain("loopGuard(++__n, 'WHILE')")
    expect(ts).toContain("loopGuard(++__n, 'REPEAT')")
  })

  it('combines BOOL AND / OR through helpers, never JS operators that would short-circuit', () => {
    const ts = toTypeScript(`VAR a : BOOL; b : BOOL; c : BOOL; END_VAR
c := a AND b;
c := a OR b;
c := a XOR b;`)
    expect(ts).toContain('andB(S.a, S.b)')
    expect(ts).toContain('orB(S.a, S.b)')
    expect(ts).toContain('(S.a !== S.b)') // XOR needs both sides, so it stays an operator
    expect(ts).toContain("import { wrap, idiv, imod, makeFb, andB, orB } from './runtime'")
  })

  it('emits width-wrapped integer arithmetic (semantics shown == executed)', () => {
    const ts = toTypeScript('VAR a : INT := 32767; b : INT; END_VAR\nb := a + 1;')
    expect(ts).toContain("wrap('INT'")
    expect(ts).toContain('S.b =')
  })

  it('emits CASE as an if/else chain with range checks', () => {
    const ts = toTypeScript('VAR n : INT; o : INT; END_VAR\nCASE n OF 1: o := 1; 2..4: o := 2; ELSE o := 0; END_CASE;')
    expect(ts).toContain('if (S.n === 1)')
    expect(ts).toContain('S.n >= 2 && S.n <= 4')
  })

  it('emits FOR / WHILE / REPEAT loops', () => {
    // `n := n` inside the FOR body, not `i := i`: assigning to the control variable is
    // rejected now (IEC forbids it), so the loop body writes an ordinary variable instead
    const ts = toTypeScript('VAR i : INT; n : INT; END_VAR\nFOR i := 1 TO 3 DO n := n; END_FOR;\nWHILE i < 1 DO i := i; END_WHILE;\nREPEAT i := i; UNTIL i > 0 END_REPEAT;')
    // FOR mirrors the interpreter: bounds hoisted (evaluated once), internal counter,
    // and the visible loop variable width-coerced each iteration
    expect(ts).toContain('const __to = 3')
    expect(ts).toContain('for (let __i = 1;')
    expect(ts).toContain("S.i = wrap('INT', __i);")
    expect(ts).toContain('while (')
    expect(ts).toContain('do {')
  })

  it('emits conversions and value-preserving widenings faithfully (shown == executed)', () => {
    const ts = toTypeScript('VAR r : REAL := 2.5; i : INT; END_VAR\ni := REAL_TO_INT(r);\nr := i;')
    expect(ts).toContain("S.i = conv('REAL', 'INT', S.r);")
    expect(ts).toContain('S.r = S.i;') // INT fits f32 exactly, so the widening stays bare
  })
})

// TIME is the type real conveyor logic is written in: `IF Gap.ET >= T#2s THEN`. It is a
// distinct type carrying milliseconds, so it never silently swaps with a number.
describe('TIME', () => {
  it('declares TIME variables and reads every literal unit as milliseconds', () => {
    const p = once('VAR a : TIME := T#1s; b : TIME; c : TIME; d : TIME; END_VAR\nb := T#500ms;\nc := T#1m30s;\nd := T#2h;')
    expect(p.get('a')).toBe(1000)
    expect(p.get('b')).toBe(500)
    expect(p.get('c')).toBe(90_000)
    expect(p.get('d')).toBe(7_200_000)
  })

  it('converts to and from numbers only when asked', () => {
    const p = once('VAR t : TIME := T#1s; ms : DINT; back : TIME; END_VAR\nms := TIME_TO_DINT(t);\nback := DINT_TO_TIME(ms + 500);')
    expect(p.get('ms')).toBe(1000)
    expect(p.get('back')).toBe(1500)
  })

  it('keeps durations and numbers apart', () => {
    expect(() => compile('VAR t : TIME := T#1s; r : REAL; END_VAR\nr := t;')).toThrow(/cannot assign TIME to 'r' of type REAL/)
    expect(() => compile('VAR t : TIME; END_VAR\nt := 500;')).toThrow(/cannot assign INT to 't' of type TIME/)
    expect(() => compile('VAR t : TIME := T#1s; b : BOOL; END_VAR\nb := t > 5;')).toThrow(/both sides must be TIME/)
    expect(() => compile('VAR t : TIME := T#1s; r : REAL; END_VAR\nr := SQRT(t);')).toThrow(/needs a numeric argument/)
  })

  it('drives a timer off a TIME expression, not a magic number', () => {
    const p = compile('VAR_INPUT go : BOOL; END_VAR VAR base : TIME := T#100ms; t : TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR\nt(IN := go, PT := base * 3);\nq := t.Q;')
    p.setInput('go', true)
    // one scan to start the timer, then two more for 200ms elapsed
    for (let k = 0; k < 3; k++) p.scan(0.1)
    expect(p.get('q')).toBe(false) // 200ms < 300ms
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })
})

// Based and typed literals. Bit masks (`16#FF`) are everywhere in real PLC code - status
// words, fault words, mode words - so a program that uses one has to load here, not just
// run somewhere else. Typed literals (`INT#5`) are how an author pins a literal's width
// instead of relying on the magnitude rule.
describe('literals', () => {
  it('reads base-16, base-8 and base-2 literals', () => {
    const p = once('VAR a : WORD; b : INT; c : BYTE; END_VAR\na := 16#FF;\nb := 2#1010;\nc := 8#17;')
    expect(p.get('a')).toBe(255)
    expect(p.get('b')).toBe(10)
    expect(p.get('c')).toBe(15)
  })

  it('allows _ as a digit separator, in both decimal and based literals', () => {
    const p = once('VAR a : DINT; b : DWORD; END_VAR\na := 1_000_000;\nb := 16#DEAD_BEEF;')
    expect(p.get('a')).toBe(1000000)
    expect(p.get('b')).toBe(0xdeadbeef)
  })

  it('reads exponent notation', () => {
    const p = once('VAR a : REAL; b : REAL; END_VAR\na := 1.5E3;\nb := 2.0E-3;')
    expect(p.get('a')).toBe(1500)
    expect(p.get('b')).toBeCloseTo(0.002, 6)
  })

  it('types a literal from its prefix, including a based value', () => {
    const p = once('VAR a : DINT; b : REAL; c : WORD; END_VAR\na := DINT#100000;\nb := REAL#1.5;\nc := WORD#16#FF;')
    expect(p.get('a')).toBe(100000)
    expect(p.get('b')).toBe(1.5)
    expect(p.get('c')).toBe(255)
  })

  it('pins single precision when a literal is spelled REAL#', () => {
    // an untyped literal keeps f64 so `x : LREAL := 0.1` is not silently degraded;
    // REAL# is how an author asks for the f32 value explicitly
    const p = once('VAR a : LREAL; b : LREAL; END_VAR\na := 0.1;\nb := REAL#0.1;')
    expect(p.get('a')).toBe(0.1)
    expect(p.get('b')).toBe(Math.fround(0.1))
  })

  it('rejects a typed literal that does not fit, and a digit its base cannot hold', () => {
    expect(() => compile('VAR a : INT; END_VAR\na := INT#40000;')).toThrow(/does not fit in INT/)
    expect(() => compile('VAR a : INT; END_VAR\na := 2#1012;')).toThrow(/not a base-2 digit/)
    expect(() => compile('VAR a : INT; END_VAR\na := 3#12;')).toThrow(/unsupported literal base/)
    expect(() => compile('VAR a : INT; END_VAR\na := FOO#12;')).toThrow(/unknown literal prefix/)
  })
})

// IEC 61131-3 identifiers are case-insensitive. This is a portability rule, not a
// convenience: when `Motor` and `motor` are two variables here and one variable on the
// target PLC, a program can pass in the simulator and misbehave on the hardware it was
// demoed for. Every reference resolves to its declaration, and the declared spelling is
// what the watch table, the emitter and the scene tag bindings see.
describe('case-insensitive identifiers', () => {
  it('resolves a variable written in any case, and keeps the declared spelling', () => {
    const p = once('VAR Motor : BOOL; Count : INT; END_VAR\nmotor := TRUE;\nCOUNT := count + 2;')
    expect(p.get('Motor')).toBe(true)
    expect(p.get('MOTOR')).toBe(true) // reads resolve case-insensitively too
    expect(p.get('motor')).toBe(true)
    expect(p.get('Count')).toBe(2)
    expect(Object.keys(p.watch)).toContain('Motor') // declared spelling, not the reference's
    expect(Object.keys(p.watch)).not.toContain('motor')
  })

  it('accepts lower-case keywords and type names', () => {
    const p = once('var a : int := 3; b : int; end_var\nif a > 2 then b := a; else b := 0; end_if;')
    expect(p.get('b')).toBe(3)
  })

  it('resolves inputs and outputs case-insensitively across the tag surface', () => {
    const p = compile('VAR_INPUT Run : BOOL; END_VAR VAR_OUTPUT Lamp : BOOL; END_VAR\nlamp := run;')
    p.setInput('RUN', true) // a binding hand-typed in the wrong case still lands
    p.scan(0.1)
    expect(p.get('Lamp')).toBe(true)
    expect(p.inputs).toEqual(['Run']) // the surface still advertises declared spellings
    expect(p.outputs).toEqual(['Lamp'])
  })

  it('resolves standard functions and builtin FB members in any case', () => {
    const p = once(
      'VAR_INPUT go : BOOL := TRUE; END_VAR VAR t : TON; a : INT; q : BOOL; e : TIME; END_VAR\n' +
        'a := abs(-3) + Max(1, 2);\nt(in := go, pt := t#1s);\nq := t.q;\ne := T.et;',
      { go: true },
      0.25,
    )
    expect(p.get('a')).toBe(5)
    // the first scan only starts the timer (IEC records the start on the edge scan and
    // measures from the next one), so the elapsed reading comes from the second
    p.scan(0.25)
    expect(p.get('q')).toBe(false) // 0.25s into a 1s on-delay
    expect(p.get('e')).toBeCloseTo(250) // TIME is milliseconds
    expect(p.watch['t.ET']).toBeCloseTo(250) // watch keys stay in the FB's own spelling
  })

  it('resolves user FB definitions, instances, inputs and outputs in any case', () => {
    const src = [
      'FUNCTION_BLOCK Latch',
      'VAR_INPUT Set : BOOL; Reset : BOOL; END_VAR VAR_OUTPUT Held : BOOL; END_VAR',
      'IF set THEN held := TRUE; ELSIF RESET THEN Held := FALSE; END_IF;',
      'END_FUNCTION_BLOCK',
      'VAR L1 : latch; out : BOOL; END_VAR',
      'l1(SET := TRUE, reset := FALSE);',
      'out := L1.held;',
    ].join('\n')
    const p = once(src)
    expect(p.get('out')).toBe(true)
    expect(p.watch['L1.Held']).toBe(true) // instance + member in their declared spellings
  })

  it('resolves user functions, structs and struct fields in any case', () => {
    const src = [
      'TYPE Point : STRUCT Xs : INT; Ys : INT; END_STRUCT; END_TYPE',
      'FUNCTION Double : INT VAR_INPUT n : INT; END_VAR double := n * 2; END_FUNCTION',
      'VAR p : point; total : INT; END_VAR',
      'P.xs := 4;',
      'p.YS := DOUBLE(p.Xs);',
      'total := p.xs + P.ys;',
    ].join('\n')
    const p = once(src)
    expect(p.get('total')).toBe(12)
  })

  it('resolves a FOR loop variable in any case', () => {
    const p = once('VAR Idx : INT; sum : INT; END_VAR\nFOR idx := 1 TO 4 DO sum := sum + IDX; END_FOR;')
    expect(p.get('sum')).toBe(10)
  })

  it('emits the declared spelling, so mixed-case source still emits valid TypeScript', () => {
    const ts = toTypeScript('VAR Motor : BOOL; END_VAR\nmotor := TRUE;')
    expect(ts).toContain('S.Motor = true;')
    expect(ts).not.toContain('S.motor')
  })

  it('rejects declarations that collide only in case, and says why', () => {
    expect(() => compile('VAR Motor : BOOL; motor : INT; END_VAR\n')).toThrow(StError)
    expect(() => compile('VAR Motor : BOOL; motor : INT; END_VAR\n')).toThrow(/case-insensitive/)
  })

  it('rejects definitions that collide only in case across the shared namespace', () => {
    const fbVsFunc = [
      'FUNCTION_BLOCK Widget VAR_INPUT a : INT; END_VAR END_FUNCTION_BLOCK',
      'FUNCTION widget : INT VAR_INPUT n : INT; END_VAR widget := n; END_FUNCTION',
      'VAR x : INT; END_VAR',
    ].join('\n')
    expect(() => compile(fbVsFunc)).toThrow(/duplicate definition/)
    const structVsFb = [
      'TYPE Pair : STRUCT a : INT; END_STRUCT; END_TYPE',
      'FUNCTION_BLOCK pair VAR_INPUT a : INT; END_VAR END_FUNCTION_BLOCK',
      'VAR x : INT; END_VAR',
    ].join('\n')
    expect(() => compile(structVsFb)).toThrow(/duplicate definition/)
  })

  it('rejects struct fields that collide only in case', () => {
    expect(() => compile('TYPE P : STRUCT Xs : INT; xs : INT; END_STRUCT; END_TYPE\nVAR a : INT; END_VAR\n')).toThrow(/duplicate field/)
  })
})

// The declaration and jump forms real ST is written in: each compiles on a target, so each
// must load here too.
describe('unsigned integer types', () => {
  it('wraps each unsigned width and keeps the family distinct from signed and bit-string', () => {
    const p = once(
      'VAR us : USINT := 255; ui : UINT := 65535; ud : UDINT := 4294967295; END_VAR' +
        ' VAR_OUTPUT a : USINT; b : UINT; c : UDINT; END_VAR\n' +
        'a := us + 1; b := ui + 1; c := ud + 1;',
    )
    expect(p.get('a')).toBe(0)
    expect(p.get('b')).toBe(0)
    expect(p.get('c')).toBe(0)
  })

  it('widens inside the unsigned family but not across families', () => {
    expect(() => compile('VAR s : USINT := 1; d : UDINT; END_VAR\nd := s;')).not.toThrow()
    // a negative has no unsigned counterpart, so signed -> unsigned needs the conversion
    expect(() => compile('VAR s : SINT := -1; d : UDINT; END_VAR\nd := s;')).toThrow(/SINT_TO_UDINT/)
    // and a bit string is a reinterpretation, not a widening
    expect(() => compile('VAR w : WORD := 1; u : UINT; END_VAR\nu := w;')).toThrow(/WORD_TO_UINT/)
  })

  it('converts explicitly between families', () => {
    const p = once('VAR s : SINT := -1; END_VAR VAR_OUTPUT u : USINT; END_VAR\nu := SINT_TO_USINT(s);')
    expect(p.get('u')).toBe(255) // the same bits, read unsigned
  })
})

describe('functional forms of the operators', () => {
  it('computes the variadic and binary arithmetic forms', () => {
    const p = once(
      'VAR_OUTPUT s : INT; m : INT; d : INT; q : INT; END_VAR\n' +
        's := ADD(1, 2, 3);\nm := MUL(2, 3, 4);\nd := SUB(10, 4);\nq := DIV(7, 2);',
    )
    expect(p.get('s')).toBe(6)
    expect(p.get('m')).toBe(24)
    expect(p.get('d')).toBe(6)
    expect(p.get('q')).toBe(3) // integer DIV truncates, exactly like `/`
  })

  it('treats the comparison forms as chains, per IEC', () => {
    const p = once(
      'VAR_OUTPUT a : BOOL; b : BOOL; c : BOOL; d : BOOL; END_VAR\n' +
        'a := GT(3, 2, 1);\nb := GT(3, 1, 2);\nc := EQ(5, 5, 5);\nd := LE(1, 2, 2);',
    )
    expect(p.get('a')).toBe(true) // 3 > 2 AND 2 > 1
    expect(p.get('b')).toBe(false) // 1 > 2 is false
    expect(p.get('c')).toBe(true)
    expect(p.get('d')).toBe(true)
  })

  it('MOVE passes its argument through with its type', () => {
    const p = once('VAR r : REAL := 1.5; END_VAR VAR_OUTPUT o : REAL; END_VAR\no := MOVE(r);')
    expect(p.get('o')).toBeCloseTo(1.5, 6)
  })

  it('faults on DIV by zero the same way the operator does', () => {
    const p = compile('VAR_INPUT n : INT; END_VAR VAR x : INT; END_VAR\nx := DIV(10, n);')
    p.setInput('n', 0)
    expect(() => p.scan(0.1)).toThrow(/division by zero/)
  })
})

describe('enumerated types', () => {
  const MODES = 'TYPE Mode : (Idle, Running := 10, Fault); END_TYPE\n'

  it('numbers members from zero, or on from an explicit value', () => {
    const p = once(`${MODES}VAR_OUTPUT a : Mode; b : Mode; c : Mode; END_VAR\na := Idle; b := Running; c := Fault;`)
    expect(p.get('a')).toBe(0)
    expect(p.get('b')).toBe(10)
    expect(p.get('c')).toBe(11) // continues from the explicit value
  })

  it('starts an enum variable at its first member, not at zero', () => {
    const p = once('TYPE Mode : (Warmup := 3, Run); END_TYPE\nVAR m : Mode; END_VAR\n')
    expect(p.watch['m']).toBe(3)
  })

  it('exposes enum-typed I/O on the tag surface, so it can drive the scene', () => {
    const p = compile(`${MODES}VAR_INPUT want : Mode; END_VAR VAR_OUTPUT got : Mode; END_VAR\ngot := want;`)
    expect(p.inputs).toEqual(['want'])
    expect(p.outputs).toEqual(['got'])
    p.setInput('want', 10)
    p.scan(0.1)
    expect(p.get('got')).toBe(10)
  })

  it('drives a CASE state machine on member names', () => {
    const src = [
      MODES,
      'VAR_INPUT trip : BOOL; END_VAR VAR m : Mode; END_VAR VAR_OUTPUT steps : INT; END_VAR',
      'CASE m OF',
      '  Idle: m := Running;',
      '  Running: steps := steps + 1; IF trip THEN m := Fault; END_IF;',
      '  Fault: steps := 0;',
      'END_CASE;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1)
    expect(p.watch['m']).toBe(10) // Idle -> Running
    p.scan(0.1)
    expect(p.get('steps')).toBe(1)
    p.setInput('trip', true)
    p.scan(0.1)
    expect(p.watch['m']).toBe(11) // -> Fault
    p.scan(0.1)
    expect(p.get('steps')).toBe(0)
  })

  it('keeps an enumeration a distinct type from a plain integer', () => {
    expect(() => compile(`${MODES}VAR m : Mode; END_VAR\nm := 1;`)).toThrow(/enumeration Mode/)
    expect(() => compile(`${MODES}VAR m : Mode; i : INT; END_VAR\ni := m;`)).toThrow(/enumeration Mode/)
  })

  it('rejects a member of a different enumeration', () => {
    const two = 'TYPE A : (Red, Green); B : (Up, Down); END_TYPE\n'
    expect(() => compile(`${two}VAR a : A; END_VAR\na := Up;`)).toThrow(/enumeration/)
    expect(() => compile(`${two}VAR a : A; END_VAR\nCASE a OF Up: ; END_CASE;`)).toThrow(/belongs to B/)
  })

  it('rejects two enumerations sharing a member name', () => {
    expect(() => compile('TYPE A : (Red); B : (Red); END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/already a member of A/)
  })

  it('works as a struct field and an array element', () => {
    const src = [
      MODES,
      'TYPE Cell : STRUCT m : Mode; END_STRUCT; END_TYPE',
      'VAR c : Cell; ms : ARRAY[1..2] OF Mode; END_VAR VAR_OUTPUT a : INT; END_VAR',
      'c.m := Running;',
      'ms[1] := Fault;',
      'IF c.m = Running THEN a := 1; END_IF;',
      'IF ms[1] = Fault THEN a := a + 1; END_IF;',
    ].join('\n')
    const p = once(src)
    expect(p.get('a')).toBe(2)
  })

  it('emits members as their values, so the emitted TypeScript still runs', () => {
    const ts = toTypeScript(`${MODES}VAR m : Mode; END_VAR\nm := Running;`)
    expect(ts).toContain('S.m = 10')
    expect(ts).toContain('Running')  // kept as a comment for readability
  })
})

describe('SR / RS latches, and builtin FB names being unreserved', () => {
  it('SR is set-dominant', () => {
    const p = compile('VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : SR; END_VAR\nl(SET1 := s, RESET := r);\nq := l.Q1;')
    p.setInput('s', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    p.setInput('s', false)
    p.scan(0.1)
    expect(p.get('q')).toBe(true) // latched
    p.setInput('r', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
    p.setInput('s', true) // both held: SET wins
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })

  it('RS is reset-dominant', () => {
    const p = compile('VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : RS; END_VAR\nl(SET := s, RESET1 := r);\nq := l.Q1;')
    p.setInput('s', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    p.setInput('r', true) // both held: RESET wins
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
  })

  // IEC Table 34 spells these S1/R and S/R1, and the standard's own Annex F examples call
  // them that way (`cmd_monitor` writes `ALRM_FF(S1 := ..., R := ACK)`). An engine that
  // took only the longer SET1/RESET/SET/RESET1 names would refuse a file written
  // against the standard.
  it('SR takes IEC\'s S1 / R', () => {
    const p = compile('VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : SR; END_VAR\nl(S1 := s, R := r);\nq := l.Q1;')
    p.setInput('s', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    p.setInput('s', false)
    p.scan(0.1)
    expect(p.get('q')).toBe(true) // latched
    p.setInput('r', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
    p.setInput('s', true) // both held: S1 wins
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })

  it('RS takes IEC\'s S / R1', () => {
    const p = compile('VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : RS; END_VAR\nl(S := s, R1 := r);\nq := l.Q1;')
    p.setInput('s', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    p.setInput('r', true) // both held: R1 wins
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
  })

  it('lets a user FUNCTION_BLOCK shadow a builtin name', () => {
    // this is why the builtin names are not reserved words: an author who already had an
    // `SR` block of their own keeps it
    const src = [
      'FUNCTION_BLOCK SR VAR_INPUT n : INT; END_VAR VAR_OUTPUT doubled : INT; END_VAR doubled := n * 2; END_FUNCTION_BLOCK',
      'VAR mine : SR; END_VAR VAR_OUTPUT o : INT; END_VAR',
      'mine(n := 21);',
      'o := mine.doubled;',
    ].join('\n')
    const p = once(src)
    expect(p.get('o')).toBe(42)
  })

  it('still resolves the builtin when nothing shadows it', () => {
    const p = once('VAR t : TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR\nt(IN := TRUE, PT := T#0s);\nq := t.Q;')
    // even a zero PT waits for the scan after the one that starts the timer, which is what
    // IEC's body does: the edge scan records the start and evaluates nothing else
    expect(p.get('q')).toBe(false)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })
})

describe('subrange types', () => {
  const PCT = 'TYPE Percent : INT (0..100); END_TYPE\n'

  it('behaves as its base type while inside the range', () => {
    const p = once(`${PCT}VAR_OUTPUT level : Percent; END_VAR\nlevel := level + 40;`)
    expect(p.get('level')).toBe(40)
  })

  it('faults the scan on a store outside the range, like an array bound does', () => {
    const p = compile(`${PCT}VAR_INPUT n : INT; END_VAR VAR level : Percent; END_VAR\nlevel := n;`)
    p.setInput('n', 100)
    expect(() => p.scan(0.1)).not.toThrow()
    p.setInput('n', 101)
    expect(() => p.scan(0.1)).toThrow(/101 is outside Percent \(0\.\.100\)/)
    p.setInput('n', -1)
    expect(() => p.scan(0.1)).toThrow(/-1 is outside Percent/)
  })

  it('rejects bounds the base type cannot hold, and a non-integer base', () => {
    expect(() => compile('TYPE Big : SINT (0..1000); END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/does not fit in SINT/)
    expect(() => compile('TYPE R : REAL (0..1); END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/base must be an integer type/)
  })

  it('collides with a struct or enumeration of the same name', () => {
    expect(() => compile('TYPE P : STRUCT a : INT; END_STRUCT; P : INT (0..5); END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/duplicate type/)
  })
})

describe('VAR_IN_OUT', () => {
  it('lets a block write back through a scalar parameter', () => {
    const src = [
      'FUNCTION_BLOCK Bump VAR_IN_OUT n : INT; END_VAR VAR_INPUT step : INT; END_VAR n := n + step; END_FUNCTION_BLOCK',
      'VAR b : Bump; END_VAR VAR_OUTPUT total : INT; END_VAR',
      'b(n := total, step := 5);',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1)
    expect(p.get('total')).toBe(5)
    p.scan(0.1)
    expect(p.get('total')).toBe(10) // the caller's variable is what accumulates
  })

  it('aliases an ARRAY, so the block mutates the caller\'s storage in place', () => {
    const src = [
      'FUNCTION_BLOCK Fill VAR_IN_OUT a : ARRAY[1..3] OF INT; END_VAR VAR_INPUT v : INT; END_VAR VAR i : INT; END_VAR',
      'FOR i := 1 TO 3 DO a[i] := v; END_FOR;',
      'END_FUNCTION_BLOCK',
      'VAR f : Fill; data : ARRAY[1..3] OF INT; END_VAR VAR_OUTPUT mid : INT; END_VAR',
      'f(a := data, v := 7);',
      'mid := data[2];',
    ].join('\n')
    const p = once(src)
    expect(p.get('mid')).toBe(7)
  })

  it('aliases a STRUCT the same way', () => {
    const src = [
      'TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE',
      'FUNCTION_BLOCK Move VAR_IN_OUT p : Pt; END_VAR p.x := p.x + 1; p.y := p.y + 2; END_FUNCTION_BLOCK',
      'VAR m : Move; here : Pt; END_VAR VAR_OUTPUT px : INT; py : INT; END_VAR',
      'm(p := here);',
      'px := here.x; py := here.y;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1)
    p.scan(0.1)
    expect(p.get('px')).toBe(2)
    expect(p.get('py')).toBe(4)
  })

  it('requires a variable, of exactly the declared type', () => {
    const fb = 'FUNCTION_BLOCK Bump VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK\n'
    expect(() => compile(`${fb}VAR b : Bump; x : INT; END_VAR\nb(n := x + 1);`)).toThrow(/needs a variable, not an expression/)
    // no widening: the block writes through, so a DINT place would receive INT-shaped writes
    expect(() => compile(`${fb}VAR b : Bump; d : DINT; END_VAR\nb(n := d);`)).toThrow(/needs exactly INT, got DINT/)
    expect(() => compile(`${fb}VAR b : Bump; END_VAR VAR CONSTANT k : INT := 1; END_VAR\nb(n := k);`)).toThrow(/cannot pass CONSTANT/)
  })

  it("requires a STRING of exactly the parameter's capacity, in a block call and a method call", () => {
    const fb = "FUNCTION_BLOCK Tag VAR_IN_OUT s : STRING[10]; END_VAR s := CONCAT(s, 'x'); END_FUNCTION_BLOCK\n"
    expect(() => compile(`${fb}VAR b : Tag; t : STRING[20]; END_VAR\nb(s := t);`)).toThrow(/VAR_IN_OUT 's' needs exactly STRING\[10\], got STRING\[20\]/)
    expect(() => compile(`${fb}VAR b : Tag; t : STRING; END_VAR\nb(s := t);`)).toThrow(/needs exactly STRING\[10\], got STRING\[80\]/)
    // an unbounded STRING is STRING[80], on either side
    const wide = 'FUNCTION_BLOCK Wide VAR_IN_OUT s : STRING; END_VAR s := CONCAT(s, \'x\'); END_FUNCTION_BLOCK\n'
    expect(() => compile(`${wide}VAR b : Wide; t : STRING[10]; END_VAR\nb(s := t);`)).toThrow(/needs exactly STRING\[80\], got STRING\[10\]/)
    const p = compile(`${wide}VAR b : Wide; t : STRING[80]; u : STRING; END_VAR\nb(s := t); b(s := u);`)
    p.scan(0.1)
    expect(p.get('t')).toBe('x')
    expect(p.get('u')).toBe('x')
    // a struct field and an array element carry their capacity too, and a named STRING type its own
    expect(() => compile(`TYPE R : STRUCT s : STRING[12]; END_STRUCT; END_TYPE\n${fb}VAR b : Tag; r : R; END_VAR\nb(s := r.s);`)).toThrow(/got STRING\[12\]/)
    expect(() => compile(`${fb}VAR b : Tag; a : ARRAY[1..2] OF STRING[4]; END_VAR\nb(s := a[1]);`)).toThrow(/got STRING\[4\]/)
    expect(() => compile(`TYPE Label : STRING[10]; END_TYPE\n${fb}VAR b : Tag; l : Label; END_VAR\nb(s := l);`)).not.toThrow()
    const m = "FUNCTION_BLOCK Box METHOD Put VAR_IN_OUT s : STRING[10]; END_VAR s := 'in'; END_METHOD END_FUNCTION_BLOCK\n"
    expect(() => compile(`${m}VAR b : Box; t : STRING[30]; END_VAR\nb.Put(s := t);`)).toThrow(/needs exactly STRING\[10\], got STRING\[30\]/)
    expect(() => compile(`${m}VAR b : Box; t : STRING[30]; END_VAR\nb.Put(t);`)).toThrow(/needs exactly STRING\[10\], got STRING\[30\]/)
    expect(() => compile(`${m}VAR b : Box; t : STRING[10]; END_VAR\nb.Put(s := t);`)).not.toThrow()
  })

  it('is rejected on a FUNCTION, which has nowhere to write back to', () => {
    expect(() => compile('FUNCTION F : INT VAR_IN_OUT n : INT; END_VAR F := n; END_FUNCTION\nVAR x : INT; END_VAR\n')).toThrow(/cannot take VAR_IN_OUT/)
  })
})

describe('STRING', () => {
  it('declares, initialises and assigns single-quoted literals', () => {
    const p = once("VAR s : STRING := 'hello'; t : STRING; END_VAR\nt := s;")
    expect(p.get('s')).toBe('hello')
    expect(p.get('t')).toBe('hello')
  })

  it('starts empty, not zero', () => {
    expect(once('VAR s : STRING; END_VAR\n').get('s')).toBe('')
  })

  it('unescapes IEC $ sequences, including $XX hex', () => {
    const p = once("VAR a : STRING; b : STRING; c : STRING; END_VAR\na := 'it$'s';\nb := 'a$$b';\nc := 'x$0Dy$T';")
    expect(p.get('a')).toBe("it's")
    expect(p.get('b')).toBe('a$b')
    expect(p.get('c')).toBe('x\ry\t')
  })

  it('rejects an unterminated literal at its opening quote', () => {
    expect(() => compile("VAR s : STRING; END_VAR\ns := 'oops;\n")).toThrow(/unterminated string literal/)
  })

  it('names WSTRING when a double-quoted literal appears, instead of "unexpected character"', () => {
    expect(() => compile('VAR s : STRING; END_VAR\ns := "wide";\n')).toThrow(/WSTRING, which is not implemented/)
  })

  it('truncates a store to the declared capacity, silently, like every target', () => {
    const p = once("VAR s : STRING[3]; END_VAR\ns := 'abcdef';")
    expect(p.get('s')).toBe('abc')
  })

  it('accepts the vendor STRING(n) spelling as well as STRING[n]', () => {
    const p = once("VAR s : STRING(2); END_VAR\ns := 'xyz';")
    expect(p.get('s')).toBe('xy')
  })

  it('defaults to a capacity of 80 when none is declared', () => {
    const p = once(`VAR s : STRING; n : INT; END_VAR\ns := '${'z'.repeat(100)}';\nn := LEN(s);`)
    expect(p.get('n')).toBe(80)
  })

  it('rejects a positive-integer-less capacity', () => {
    expect(() => compile('VAR s : STRING[0]; END_VAR\n')).toThrow(/STRING capacity must be a positive integer/)
  })

  it('keeps STRING and numbers apart in both directions, naming the conversion', () => {
    expect(() => compile("VAR s : STRING; n : INT; END_VAR\nn := s;")).toThrow(/cannot assign STRING to 'n' of type INT \(write STRING_TO_INT/)
    expect(() => compile("VAR s : STRING; n : INT; END_VAR\ns := n;")).toThrow(/cannot assign INT to 's' of type STRING \(write INT_TO_STRING/)
  })

  it('has no string +, and says to use CONCAT', () => {
    expect(() => compile("VAR a : STRING; b : STRING; END_VAR\na := a + b;")).toThrow(/\+ is not defined on STRING operands; use CONCAT/)
  })

  it('refuses to compare a STRING with a number', () => {
    expect(() => compile("VAR s : STRING; b : BOOL; END_VAR\nb := s < 3;")).toThrow(/both sides must be STRING/)
  })

  it('compares lexicographically', () => {
    const p = once("VAR a : STRING := 'apple'; b : STRING := 'banana'; END_VAR VAR_OUTPUT lt : BOOL; eq : BOOL; ge : BOOL; END_VAR\nlt := a < b;\neq := a = 'apple';\nge := a >= b;")
    expect(p.get('lt')).toBe(true)
    expect(p.get('eq')).toBe(true)
    expect(p.get('ge')).toBe(false)
  })

  it('runs the standard string library with 1-based positions', () => {
    const p = once(
      "VAR s : STRING := 'Conveyor'; END_VAR\n" +
        'VAR_OUTPUT n : INT; l : STRING; r : STRING; m : STRING; f : INT; END_VAR\n' +
        // MID is (IN, L, P): length first, then the 1-based position - 2 characters from
        // the 4th, not the other way round
        'n := LEN(s);\nl := LEFT(s, 3);\nr := RIGHT(s, 3);\nm := MID(s, 2, 4);\nf := FIND(s, \'vey\');',
    )
    expect(p.get('n')).toBe(8)
    expect(p.get('l')).toBe('Con')
    expect(p.get('r')).toBe('yor')
    expect(p.get('m')).toBe('ve')
    expect(p.get('f')).toBe(4)
  })

  it('CONCAT joins, INSERT/DELETE/REPLACE edit in place', () => {
    const p = once(
      "VAR_OUTPUT c : STRING; i : STRING; d : STRING; r : STRING; END_VAR\n" +
        "c := CONCAT('LINE', '-', '01');\n" +
        "i := INSERT('ABEF', 'CD', 2);\n" +
        "d := DELETE('ABCDEF', 2, 3);\n" +
        "r := REPLACE('ABCDEF', 'xy', 2, 3);",
    )
    expect(p.get('c')).toBe('LINE-01')
    expect(p.get('i')).toBe('ABCDEF')
    expect(p.get('d')).toBe('ABEF')
    // REPLACE(IN1, IN2, L, P): 'CD' (2 chars from the 3rd) gives way to 'xy'
    expect(p.get('r')).toBe('ABxyEF')
  })

  it('clamps an out-of-range length or position rather than faulting the scan', () => {
    const p = once("VAR_OUTPUT a : STRING; b : STRING; f : INT; END_VAR\na := LEFT('ab', 99);\nb := MID('ab', 5, 9);\nf := FIND('ab', 'zz');")
    expect(p.get('a')).toBe('ab')
    expect(p.get('b')).toBe('')
    expect(p.get('f')).toBe(0)
  })

  it('rejects a non-STRING argument to the string library, naming the conversion', () => {
    expect(() => compile('VAR n : INT; x : INT; END_VAR\nx := LEN(n);')).toThrow(/'LEN' needs a STRING argument \(write INT_TO_STRING/)
  })

  it('converts to and from STRING', () => {
    const p = once(
      'VAR_OUTPUT a : STRING; b : STRING; c : STRING; n : INT; r : REAL; t : TIME; END_VAR\n' +
        'a := INT_TO_STRING(42);\n' +
        'b := BOOL_TO_STRING(TRUE);\n' +
        'c := TIME_TO_STRING(T#1s500ms);\n' +
        "n := STRING_TO_INT('42');\n" +
        "r := STRING_TO_REAL('1.5');\n" +
        "t := STRING_TO_TIME('T#2s');",
    )
    expect(p.get('a')).toBe('42')
    expect(p.get('b')).toBe('TRUE')
    expect(p.get('c')).toBe('T#1s500ms')
    expect(p.get('n')).toBe(42)
    expect(p.get('r')).toBe(1.5)
    expect(p.get('t')).toBe(2000)
  })

  it('parses a leading numeric prefix and yields 0 for nonsense, like the vendors', () => {
    const p = once("VAR_OUTPUT a : INT; b : INT; END_VAR\na := STRING_TO_INT('42abc');\nb := STRING_TO_INT('abc');")
    expect(p.get('a')).toBe(42)
    expect(p.get('b')).toBe(0)
  })

  it('reads STRING_TO_BOOL by name, so FALSE is false', () => {
    const p = once("VAR_OUTPUT a : BOOL; b : BOOL; END_VAR\na := STRING_TO_BOOL('TRUE');\nb := STRING_TO_BOOL('FALSE');")
    expect(p.get('a')).toBe(true)
    expect(p.get('b')).toBe(false)
  })

  it('orders MIN/MAX/LIMIT lexicographically, and refuses a mixed set', () => {
    const p = once("VAR_OUTPUT lo : STRING; hi : STRING; END_VAR\nlo := MIN('b', 'a', 'c');\nhi := MAX('b', 'a', 'c');")
    expect(p.get('lo')).toBe('a')
    expect(p.get('hi')).toBe('c')
    expect(() => compile("VAR s : STRING; x : STRING; END_VAR\nx := MIN(s, 3);")).toThrow(/mixes STRING and non-STRING/)
  })

  it('selects with SEL/MUX without stringifying anything', () => {
    const p = once("VAR_OUTPUT a : STRING; b : STRING; END_VAR\na := SEL(TRUE, 'no', 'yes');\nb := MUX(1, 'zero', 'one');")
    expect(p.get('a')).toBe('yes')
    expect(p.get('b')).toBe('one')
  })

  it('carries STRING through structs, arrays and user POUs, truncating at each declared bound', () => {
    const src =
      "TYPE Label : STRUCT tag : STRING[4]; n : INT; END_STRUCT; END_TYPE\n" +
      'FUNCTION Tail : STRING[2] VAR_INPUT s : STRING; END_VAR Tail := RIGHT(s, 2); END_FUNCTION\n' +
      "VAR l : Label; names : ARRAY [1..2] OF STRING[3]; END_VAR\n" +
      'VAR_OUTPUT f : STRING; g : STRING; h : STRING; END_VAR\n' +
      "l.tag := 'CONVEYOR';\nnames[1] := 'ABCDE';\nf := l.tag;\ng := names[1];\nh := Tail('abcdef');"
    const p = once(src)
    expect(p.get('f')).toBe('CONV')
    expect(p.get('g')).toBe('ABC')
    expect(p.get('h')).toBe('ef')
  })

  it('passes STRING into a user FUNCTION_BLOCK input and reads it back out', () => {
    const src =
      'FUNCTION_BLOCK Echo\nVAR_INPUT IN : STRING; END_VAR\nVAR_OUTPUT OUT : STRING; END_VAR\nOUT := IN;\nEND_FUNCTION_BLOCK\n' +
      "VAR e : Echo; END_VAR VAR_OUTPUT got : STRING; END_VAR\ne(IN := 'ping', OUT => got);"
    expect(once(src).get('got')).toBe('ping')
  })

  it('shows up in the watch table', () => {
    const p = once("VAR s : STRING := 'ready'; END_VAR\n")
    expect(p.watch['s']).toBe('ready')
  })

  it('stays out of the bindable tag surface, since nothing in the scene consumes text', () => {
    const p = compile('VAR_INPUT cmd : STRING; speed : REAL; END_VAR VAR_OUTPUT msg : STRING; run : BOOL; END_VAR\n')
    expect(p.inputs).toEqual(['speed'])
    expect(p.outputs).toEqual(['run'])
    // ...but it is still an ordinary variable
    expect(p.watch['msg']).toBe('')
  })

  it('emits TypeScript that mirrors the interpreter, truncation included', () => {
    const ts = toTypeScript("VAR s : STRING[3]; n : INT; END_VAR\ns := CONCAT('ab', 'cd');\nn := LEN(s);")
    expect(ts).toContain('strLimit(')
    expect(ts).toContain("from './runtime'")
  })
})

describe('standard types this subset does not implement', () => {
  it('says why rather than "unknown type"', () => {
    expect(() => compile('VAR n : LINT; END_VAR\n')).toThrow(/LINT is not supported: 64-bit integers/)
    expect(() => compile('VAR n : LWORD; END_VAR\n')).toThrow(/LWORD is not supported/)
    expect(() => compile('VAR s : WSTRING; END_VAR\n')).toThrow(/WSTRING is not supported: wide \(UTF-16\) strings/)
    expect(() => compile('VAR d : LDT; END_VAR\n')).toThrow(/LDT is not supported: the 64-bit calendar types/)
  })

  it('names the 3rd-edition construct it does not implement instead of failing as a syntax error', () => {
    // these arrive as ordinary identifiers (they are not reserved here), so without the
    // guard the parser blamed the next token: "expected ':='", which reads like a typo
    // (METHOD, INTERFACE, EXTENDS and REF_TO are implemented: oop.test.ts)
    expect(() => compile('CLASS Tank\nVAR level : INT; END_VAR\nEND_CLASS\n')).toThrow(/CLASS is not supported: a CLASS is not implemented; use a FUNCTION_BLOCK/)
    expect(() => compile('NAMESPACE Plant\nEND_NAMESPACE\n')).toThrow(/NAMESPACE is not supported/)
    // ...and the OOP words where they cannot stand say where they go
    expect(() => compile('VAR x : INT; END_VAR\nMETHOD Start : BOOL\nEND_METHOD\n')).toThrow(/METHOD cannot stand here: a METHOD is declared inside a FUNCTION_BLOCK/)
    // POINTER TO (not IEC), and a ^ on what is not a REF_TO
    expect(() => compile('VAR p : POINTER TO INT; END_VAR\n')).toThrow(/POINTER TO is not IEC 61131-3/)
    expect(() => compile('VAR n : INT; END_VAR\nn^ := 1;\n')).toThrow(/'n' is INT, not a REF_TO, so \^ cannot dereference it/)
  })

  it('leaves those words usable as ordinary names, since IEC 2nd-edition programs may have them', () => {
    // the guard fires where a statement may start, not on every occurrence - reserving the
    // words outright would reject a working 2nd-edition program that has a variable
    // called Method or a struct field called Class
    const p = once('VAR Method : INT := 3; Class : INT; END_VAR\nClass := Method + 1;')
    expect(p.get('Class')).toBe(4)
  })

  it('still reports a genuinely unknown name as unknown', () => {
    expect(() => compile('VAR n : Wibble; END_VAR\n')).toThrow(/unknown type 'Wibble'/)
  })

  it('names SFC instead of blaming the step header', () => {
    // Annex F's `gravel` example is an SFC program. A plain `expected ':='` at
    // `INITIAL_STEP START : END_STEP` would read like a broken file rather than a
    // different IEC language.
    expect(() => compile('INITIAL_STEP Idle : END_STEP\n')).toThrow(/INITIAL_STEP is not supported: Sequential Function Chart/)
    expect(() => compile('STEP Fill : Valve(N); END_STEP\n')).toThrow(/STEP is not supported: Sequential Function Chart/)
    expect(() => compile('TRANSITION FROM Idle TO Fill := go; END_TRANSITION\n')).toThrow(/TRANSITION is not supported: Sequential Function Chart/)
    expect(() => compile('ACTION Run : x := 1; END_ACTION\n')).toThrow(/ACTION is not supported: Sequential Function Chart/)
  })
})

describe('VAR RETAIN', () => {
  // Retention asks that a value survive a warm restart. This simulator has no restart to
  // survive, so accepting the word and ignoring it is the same behaviour as honouring it -
  // whereas refusing it made ordinary plant code, where RETAIN is everywhere, fail to load.
  it('accepts RETAIN and NON_RETAIN on a VAR section', () => {
    const p = once('VAR RETAIN n : INT := 7; END_VAR VAR NON_RETAIN m : INT := 2; END_VAR VAR_OUTPUT o : INT; END_VAR\no := n + m;')
    expect(p.get('o')).toBe(9)
  })

  it('accepts RETAIN on VAR_GLOBAL and alongside CONSTANT', () => {
    const p = once('VAR_GLOBAL RETAIN g : INT := 4; END_VAR VAR RETAIN CONSTANT k : INT := 5; END_VAR VAR_OUTPUT o : INT; END_VAR\no := g + k;')
    expect(p.get('o')).toBe(9)
  })

  it('starts a retentive variable from its initial value, since there is no restart here', () => {
    const p = compile('VAR RETAIN n : INT := 3; END_VAR VAR_OUTPUT o : INT; END_VAR\nn := n + 1;\no := n;')
    p.scan(0.1)
    expect(p.get('o')).toBe(4)
  })

  it('leaves `retain` usable as an ordinary variable name', () => {
    // RETAIN is not a reserved word here, so it is recognised by position: a qualifier is
    // followed by a declaration, while a variable of that name continues with `:` or `,`
    const p = once('VAR retain : INT := 6; non_retain : INT := 1; END_VAR VAR_OUTPUT o : INT; END_VAR\no := retain - non_retain;')
    expect(p.get('o')).toBe(5)
  })
})

describe('non-formal (positional) function-block calls', () => {
  // IEC allows a call to give its arguments in the block's declaration order rather than
  // naming each one. MATIEC's standard library is written this way (`CU_T(CU);`), as is a
  // great deal of vendor code; this engine once died on it with "expected ':='".
  it('fills a builtin FB\'s parameters in declaration order', () => {
    const p = compile('VAR_INPUT cu : BOOL; r : BOOL; END_VAR VAR_OUTPUT o : INT; END_VAR VAR c : CTU; END_VAR\nc(cu, r, 10);\no := c.CV;')
    p.setInput('cu', true)
    p.scan(0.1)
    expect(p.get('o')).toBe(1)
    p.setInput('cu', false)
    p.scan(0.1)
    p.setInput('cu', true)
    p.scan(0.1)
    expect(p.get('o')).toBe(2)
    p.setInput('r', true) // the second positional is R, not the RESET alias
    p.scan(0.1)
    expect(p.get('o')).toBe(0)
  })

  it('takes a single-parameter call, the shape MATIEC\'s library uses', () => {
    const p = compile('VAR_INPUT clk : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR e : R_TRIG; END_VAR\ne(clk);\nq := e.Q;')
    p.setInput('clk', true)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    p.scan(0.1)
    expect(p.get('q')).toBe(false) // edge, not level
  })

  it('fills a user block\'s parameters in declaration order', () => {
    const src = [
      'FUNCTION_BLOCK SCALE VAR_INPUT raw : INT; gain : INT; END_VAR VAR_OUTPUT out : INT; END_VAR out := raw * gain; END_FUNCTION_BLOCK',
      'VAR s : SCALE; END_VAR VAR_OUTPUT o : INT; END_VAR',
      's(6, 7);',
      'o := s.out;',
    ].join('\n')
    expect(once(src).get('o')).toBe(42)
  })

  it('accepts expressions, not just variables', () => {
    const p = compile('VAR_INPUT a : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TON; END_VAR\nt(a AND TRUE, T#0s);\nq := t.Q;')
    p.setInput('a', true)
    p.scan(0.1)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })

  it('still takes the named form, and does not confuse the two', () => {
    const p = compile('VAR_INPUT cu : BOOL; END_VAR VAR_OUTPUT o : INT; END_VAR VAR c : CTU; END_VAR\nc(CU := cu, PV := 5);\no := c.CV;')
    p.setInput('cu', true)
    p.scan(0.1)
    expect(p.get('o')).toBe(1)
  })

  it('rejects mixing the two forms, by name', () => {
    expect(() => compile('VAR c : CTU; END_VAR\nc(TRUE, PV := 5);\n')).toThrow(/all-positional or all-named/)
  })

  it('rejects more arguments than the block has parameters', () => {
    // there is no parameter left for the extra one to reach, so it would vanish silently
    expect(() => compile('VAR e : R_TRIG; END_VAR\ne(TRUE, FALSE);\n')).toThrow(/R_TRIG takes 1 argument/)
  })

  it('allows a short list, the same way a named call may omit a parameter', () => {
    const p = compile('VAR_INPUT cu : BOOL; END_VAR VAR_OUTPUT o : INT; END_VAR VAR c : CTU; END_VAR\nc(cu);\no := c.CV;')
    p.setInput('cu', true)
    p.scan(0.1)
    expect(p.get('o')).toBe(1)
  })

  it('emits the same TypeScript a named call would', () => {
    // the checker names the arguments before anything downstream runs, so the emitter,
    // the interpreter and both exporters need no case of their own
    const named = toTypeScript('VAR_INPUT clk : BOOL; END_VAR VAR e : R_TRIG; END_VAR\ne(CLK := clk);')
    const positional = toTypeScript('VAR_INPUT clk : BOOL; END_VAR VAR e : R_TRIG; END_VAR\ne(clk);')
    expect(positional).toBe(named)
  })
})

describe('BCD conversions', () => {
  // BCD is an encoding carried in a bit string, not an IEC data type, so these two cannot
  // go through the generic `<src>_TO_<dst>` machinery - there is no `BCD` scalar to name.
  // Annex F's `weigh` and `gravel` examples both use them: thumbwheels and weigh heads.
  it('BCD_TO_INT reads packed decimal digits', () => {
    const p = once('VAR w : WORD := 16#1234; END_VAR VAR_OUTPUT o : INT; END_VAR\no := BCD_TO_INT(w);')
    expect(p.get('o')).toBe(1234)
  })

  it('INT_TO_BCD packs them back', () => {
    const p = once('VAR_OUTPUT o : WORD; END_VAR\no := INT_TO_BCD(1234);')
    expect(p.get('o')).toBe(0x1234)
  })

  it('round-trips', () => {
    const p = once('VAR_OUTPUT o : INT; END_VAR\no := BCD_TO_INT(INT_TO_BCD(907));')
    expect(p.get('o')).toBe(907)
  })

  it('wants a bit string, not a number, the same way the shifts do', () => {
    expect(() => compile('VAR n : INT; END_VAR VAR_OUTPUT o : INT; END_VAR\no := BCD_TO_INT(n);')).toThrow(/BCD_TO_INT/)
  })
})

describe('RETURN and CONTINUE', () => {
  it('RETURN inside a FUNCTION still yields the value assigned so far', () => {
    const src = [
      'FUNCTION Clamp : INT VAR_INPUT v : INT; END_VAR',
      'Clamp := 0;',
      'IF v < 0 THEN RETURN; END_IF;',
      'Clamp := v;',
      'END_FUNCTION',
      'VAR_OUTPUT lo : INT; hi : INT; END_VAR',
      'lo := Clamp(-5);',
      'hi := Clamp(7);',
    ].join('\n')
    const p = once(src)
    expect(p.get('lo')).toBe(0) // returned early, keeping the 0 it had already assigned
    expect(p.get('hi')).toBe(7)
  })

  it('RETURN inside a FUNCTION_BLOCK ends only that instance call', () => {
    const src = [
      'FUNCTION_BLOCK Guard VAR_INPUT skip : BOOL; END_VAR VAR_OUTPUT n : INT; END_VAR',
      'IF skip THEN RETURN; END_IF;',
      'n := n + 1;',
      'END_FUNCTION_BLOCK',
      'VAR a : Guard; b : Guard; END_VAR VAR_OUTPUT na : INT; nb : INT; END_VAR',
      'a(skip := TRUE); b(skip := FALSE);',
      'na := a.n; nb := b.n;',
    ].join('\n')
    const p = once(src)
    expect(p.get('na')).toBe(0)
    expect(p.get('nb')).toBe(1) // the other instance still ran
  })

  it('CONTINUE works in WHILE and REPEAT, where it resumes at the test', () => {
    const w = once('VAR i : INT; n : INT; END_VAR\nWHILE i < 5 DO i := i + 1; IF i = 3 THEN CONTINUE; END_IF; n := n + 1; END_WHILE;')
    expect(w.get('i')).toBe(5)
    expect(w.get('n')).toBe(4) // every pass but i = 3
    const r = once('VAR i : INT; n : INT; END_VAR\nREPEAT i := i + 1; IF i = 2 THEN CONTINUE; END_IF; n := n + 1; UNTIL i >= 4 END_REPEAT;')
    expect(r.get('i')).toBe(4)
    expect(r.get('n')).toBe(3)
  })

  it('rejects CONTINUE outside a loop', () => {
    expect(() => compile('VAR a : INT; END_VAR\nCONTINUE;')).toThrow(/CONTINUE is only valid inside a loop/)
  })

  it('emits RETURN so the emitted function still hands back its result', () => {
    const ts = toTypeScript('FUNCTION F : INT VAR_INPUT v : INT; END_VAR F := v; RETURN; END_FUNCTION\nVAR_OUTPUT o : INT; END_VAR\no := F(3);')
    expect(ts).toContain('return F.F;') // not a bare `return;`, which would discard it
  })
})

describe('output bindings, CONSTANT, array initializers and VAR_GLOBAL', () => {
  it('binds several outputs in one call and still accepts inputs', () => {
    const p = once(
      'VAR_INPUT cu : BOOL; END_VAR VAR_OUTPUT n : INT; full : BOOL; END_VAR VAR c : CTU; END_VAR\nc(CU := cu, PV := 2, CV => n, Q => full);',
      { cu: true },
    )
    expect(p.get('n')).toBe(1)
    expect(p.get('full')).toBe(false)
  })

  it('binds an output into a struct field or array element', () => {
    const src = [
      'TYPE Rec : STRUCT hit : BOOL; END_STRUCT; END_TYPE',
      'VAR_INPUT clk : BOOL; END_VAR VAR r : R_TRIG; rec : Rec; a : ARRAY[1..2] OF BOOL; END_VAR',
      'VAR_OUTPUT seen : BOOL; slot : BOOL; END_VAR',
      'r(CLK := clk, Q => rec.hit);',
      'a[1] := rec.hit;',
      'seen := rec.hit; slot := a[1];',
    ].join('\n')
    const p = once(src, { clk: true })
    expect(p.get('seen')).toBe(true)
    expect(p.get('slot')).toBe(true)
  })

  it('rejects an output binding onto an unknown member or a CONSTANT', () => {
    expect(() => compile('VAR t : TON; x : BOOL; END_VAR\nt(IN := TRUE, PT := T#1s, Nope => x);')).toThrow(/has no output 'Nope'/)
    expect(() => compile('VAR CONSTANT k : BOOL := FALSE; END_VAR VAR t : TON; END_VAR\nt(IN := TRUE, PT := T#1s, Q => k);')).toThrow(/CONSTANT/)
  })

  it('rejects a CONSTANT without an initial value, and a CONSTANT as a loop variable', () => {
    expect(() => compile('VAR CONSTANT k : INT; END_VAR\n')).toThrow(/CONSTANT 'k' needs an initial value/)
    expect(() => compile('VAR CONSTANT k : INT := 1; END_VAR\nFOR k := 1 TO 3 DO ; END_FOR;')).toThrow(/CONSTANT/)
  })

  it('rejects writing through a CONSTANT aggregate', () => {
    expect(() => compile('VAR CONSTANT a : ARRAY[1..2] OF INT := [1, 2]; END_VAR\na[1] := 9;')).toThrow(/CONSTANT/)
  })

  it('initializes a multi-dimensional array row-major', () => {
    const p = once('VAR g : ARRAY[1..2, 1..2] OF INT := [1, 2, 3, 4]; END_VAR VAR_OUTPUT a : INT; b : INT; END_VAR\na := g[1, 2];\nb := g[2, 1];')
    expect(p.get('a')).toBe(2) // row-major: [1,2] is the first row's second cell
    expect(p.get('b')).toBe(3)
  })

  it('rejects an array initializer whose length does not match the bounds', () => {
    expect(() => compile('VAR a : ARRAY[1..3] OF INT := [1, 2]; END_VAR\n')).toThrow(/needs 3 initial value\(s\), got 2/)
  })

  it('lets a POU local shadow a VAR_GLOBAL of the same name', () => {
    const src = [
      'VAR_GLOBAL Level : INT := 100; END_VAR',
      'FUNCTION_BLOCK Peek VAR_OUTPUT saw : INT; END_VAR saw := Level; END_FUNCTION_BLOCK',
      'VAR Level : INT := 7; p : Peek; END_VAR VAR_OUTPUT localSaw : INT; fbSaw : INT; END_VAR',
      'p();',
      'localSaw := Level;',
      'fbSaw := p.saw;',
    ].join('\n')
    const p = once(src)
    expect(p.get('localSaw')).toBe(7) // the program's own declaration wins here
    expect(p.get('fbSaw')).toBe(100) // the FB has no local, so it sees the global
  })

  it('holds a function-block instance in VAR_GLOBAL: one instance, shared by every POU', () => {
    const src = [
      'VAR_GLOBAL Gap : TON; END_VAR',
      'FUNCTION_BLOCK Watch VAR_OUTPUT open : BOOL; END_VAR open := Gap.Q; END_FUNCTION_BLOCK',
      'VAR w : Watch; END_VAR VAR_OUTPUT q : BOOL; fromFb : BOOL; END_VAR',
      'Gap(IN := TRUE, PT := T#200ms);',
      'w();',
      'q := Gap.Q; fromFb := w.open;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1) // the edge scan starts the clock
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
    expect(p.get('fromFb')).toBe(true) // the block reads the same instance the program called
    expect(p.watch['Gap.Q']).toBe(true) // and a global instance's outputs are watchable like a local's
  })

  it('surfaces globals in the watch table and resolves them through get/setInput', () => {
    const p = compile('VAR_GLOBAL Level : INT := 3; END_VAR VAR_OUTPUT seen : INT; END_VAR\nseen := Level;')
    p.setInput('level', 9) // case-insensitive, like any other name
    p.scan(0.1)
    expect(p.get('Level')).toBe(9)
    expect(p.watch['Level']).toBe(9)
    expect(p.get('seen')).toBe(9)
  })
})

// A function-block instance is data (see DataType in types.ts): it lives in arrays, struct fields
// and VAR_GLOBALs, and is called and read through the same access paths as any other value. The
// corpus (conformanceCases.ts) carries the goldens for the main shapes through both backends; these
// are the edges around them.
describe('function-block instances as data', () => {
  it('gives every element of a 2-D timer array its own clock', () => {
    const src = [
      'VAR t : ARRAY [1..2, 1..2] OF TON; END_VAR VAR_OUTPUT a : BOOL; b : BOOL; END_VAR',
      't[1, 2](IN := TRUE, PT := T#100ms);',
      't[2, 1](IN := FALSE, PT := T#100ms);',
      'a := t[1, 2].Q; b := t[2, 1].Q;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1) // the edge scan
    p.scan(0.1)
    expect(p.get('a')).toBe(true)
    expect(p.get('b')).toBe(false)
  })

  it('calls a timer that sits inside an array of structs', () => {
    const src = [
      'TYPE Line : STRUCT gap : TON; jam : BOOL; END_STRUCT; END_TYPE',
      'VAR lines : ARRAY [0..2] OF Line; i : INT; END_VAR VAR_OUTPUT jam1 : BOOL; jam2 : BOOL; END_VAR',
      'FOR i := 0 TO 2 DO',
      '  lines[i].gap(IN := i = 1, PT := T#100ms);',
      '  lines[i].jam := lines[i].gap.Q;',
      'END_FOR;',
      'jam1 := lines[1].jam; jam2 := lines[2].jam;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1)
    p.scan(0.1)
    expect(p.get('jam1')).toBe(true)
    expect(p.get('jam2')).toBe(false)
  })

  it('calls a user block held in a struct field, binding its output into a sibling field', () => {
    const src = [
      'FUNCTION_BLOCK Motor VAR_INPUT run : BOOL; END_VAR VAR_OUTPUT spinning : BOOL; END_VAR spinning := run; END_FUNCTION_BLOCK',
      'TYPE Cell : STRUCT m : Motor; lamp : BOOL; END_STRUCT; END_TYPE',
      'VAR c : Cell; END_VAR VAR_OUTPUT lit : BOOL; direct : BOOL; END_VAR',
      'c.m(run := TRUE, spinning => c.lamp);',
      'lit := c.lamp; direct := c.m.spinning;',
    ].join('\n')
    const p = once(src)
    expect(p.get('lit')).toBe(true)
    expect(p.get('direct')).toBe(true)
  })

  it('takes positional arguments on an element call, like any other call', () => {
    const p = compile('VAR d : ARRAY [1..2] OF TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR\nd[2](TRUE, T#100ms);\nq := d[2].Q;')
    p.scan(0.1)
    p.scan(0.1)
    expect(p.get('q')).toBe(true)
  })

  it('faults the scan when a call indexes past the array, like any other out-of-range access', () => {
    const p = compile('VAR d : ARRAY [1..2] OF TON; END_VAR VAR_INPUT i : INT; END_VAR\nd[i](IN := TRUE, PT := T#1s);')
    p.setInput('i', 3)
    expect(() => p.scan(0.1)).toThrow(/array index 3 out of bounds \[1\.\.2\]/)
  })

  it("shares the caller's instances through VAR_IN_OUT, so their state advances in one place", () => {
    const src = [
      'FUNCTION_BLOCK Tick VAR_IN_OUT ts : ARRAY [1..2] OF TON; END_VAR ts[1](IN := TRUE, PT := T#100ms); END_FUNCTION_BLOCK',
      'VAR k : Tick; mine : ARRAY [1..2] OF TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR',
      'k(ts := mine);',
      'q := mine[1].Q;',
    ].join('\n')
    const p = compile(src)
    p.scan(0.1)
    expect(p.get('q')).toBe(false)
    p.scan(0.1)
    expect(p.get('q')).toBe(true) // the block ran the caller's timer, not a copy of it
  })

  it("lets a user block named like a standard one shadow it inside an array too", () => {
    const src = [
      'FUNCTION_BLOCK TON VAR_INPUT IN : BOOL; END_VAR VAR_OUTPUT Q : BOOL; END_VAR Q := IN; END_FUNCTION_BLOCK',
      'VAR d : ARRAY [1..2] OF TON; END_VAR VAR_OUTPUT q : BOOL; END_VAR',
      'd[1](IN := TRUE);',
      'q := d[1].Q;',
    ].join('\n')
    expect(once(src).get('q')).toBe(true) // the user block passes IN straight through, with no delay
  })

  it('refuses what an instance is not: a value, a place to write, or something to initialise', () => {
    const decl = 'VAR d : ARRAY [1..2] OF TON; a : ARRAY [1..2] OF INT; q : BOOL; other : TON; END_VAR\n'
    expect(() => compile(`${decl}q := d[1];`)).toThrow(/'d\[1\]' is a function block; read one of its outputs/)
    expect(() => compile(`${decl}a[1](IN := TRUE);`)).toThrow(/'a\[1\]' is not a function block/)
    expect(() => compile(`${decl}q := d[1].X;`)).toThrow(/TON has no output 'X'/)
    expect(() => compile(`${decl}d[1](IN := TRUE, Q => other);`)).toThrow(/into a function-block instance/)
    expect(() => compile(`${decl}nope(IN := TRUE);`)).toThrow(/call to undeclared instance 'nope'/)
    expect(() => compile('VAR d : ARRAY [1..2] OF TON := [1, 2]; END_VAR\n')).toThrow(/'d' element is a function-block instance, which cannot take an initial value/)
    expect(() => compile('VAR t : TON := 5; END_VAR\n')).toThrow(/cannot take an initial value/)
  })

  it('keeps function-block instances out of a FUNCTION, however deep they sit', () => {
    const src = [
      'TYPE Z : STRUCT t : TON; END_STRUCT; END_TYPE',
      'FUNCTION F : BOOL VAR_INPUT x : BOOL; END_VAR VAR z : Z; END_VAR F := x; END_FUNCTION',
      'VAR q : BOOL; END_VAR',
      'q := F(TRUE);',
    ].join('\n')
    expect(() => compile(src)).toThrow(/a function cannot contain function-block instances/)
  })

  it('still catches a block that contains itself, even by way of a struct', () => {
    const src = [
      'TYPE Holder : STRUCT inner : Loop; END_STRUCT; END_TYPE',
      'FUNCTION_BLOCK Loop VAR h : Holder; END_VAR END_FUNCTION_BLOCK',
      'VAR x : Loop; END_VAR',
    ].join('\n')
    expect(() => compile(src)).toThrow(/recursive function block 'Loop'/)
  })

  it('reports a block that holds itself in the editor too, at the declaration that closes the loop', () => {
    // if only the interpreter found these, while building the instance, the gutter and the Problems
    // dock would read clean for a program compile() refuses
    const cases: [string, RegExp, string][] = [
      ['FUNCTION_BLOCK A VAR self : A; END_VAR END_FUNCTION_BLOCK\nVAR x : A; END_VAR', /recursive function block 'A': 'self' in 'A'/, 'self'],
      // through another block, an array, and a struct
      ['FUNCTION_BLOCK A VAR b : B; END_VAR END_FUNCTION_BLOCK\nFUNCTION_BLOCK B VAR a : A; END_VAR END_FUNCTION_BLOCK\nVAR x : A; END_VAR', /recursive function block 'A': 'a' in 'B'/, 'a'],
      ['FUNCTION_BLOCK A VAR row : ARRAY[1..3] OF A; END_VAR END_FUNCTION_BLOCK\nVAR x : A; END_VAR', /recursive function block 'A'/, 'row'],
      ['TYPE Holder : STRUCT inner : Loop; END_STRUCT; END_TYPE\nFUNCTION_BLOCK Loop VAR h : Holder; END_VAR END_FUNCTION_BLOCK\nVAR x : Loop; END_VAR', /recursive function block 'Loop'/, 'h'],
      // one nothing instantiates yet is still a block that can never be built
      ['FUNCTION_BLOCK A VAR self : A; END_VAR END_FUNCTION_BLOCK\nVAR q : BOOL; END_VAR\nq := TRUE;', /recursive function block 'A'/, 'self'],
    ]
    for (const [src, message, at] of cases) {
      const found = diagnostics(src)
      expect(found).toHaveLength(1)
      expect(found[0]!.message).toMatch(message)
      expect(src.slice(found[0]!.pos.offset)).toMatch(new RegExp(`^${at}\\b`))
    }
    // a chain that ends is fine, however deep, and so is one block held twice
    const chain = 'FUNCTION_BLOCK C VAR t : TON; END_VAR END_FUNCTION_BLOCK\nFUNCTION_BLOCK B VAR c1 : C; c2 : C; END_VAR END_FUNCTION_BLOCK\nFUNCTION_BLOCK A VAR b : B; row : ARRAY[1..2] OF C; END_VAR END_FUNCTION_BLOCK\nVAR x : A; END_VAR'
    expect(diagnostics(chain)).toEqual([])
    expect(() => compile(chain)).not.toThrow()
  })

  it('reports nothing in the editor for these shapes, and the real error when there is one', () => {
    const ok = [
      'TYPE Zone : STRUCT gap : TON; END_STRUCT; END_TYPE',
      'VAR z : ARRAY [1..3] OF Zone; i : INT; q : BOOL; END_VAR',
      'FOR i := 1 TO 3 DO z[i].gap(IN := TRUE, PT := T#1s); END_FOR;',
      'q := z[2].gap.Q;',
    ].join('\n')
    expect(diagnostics(ok)).toEqual([])
    const bad = diagnostics('VAR d : ARRAY [1..2] OF TON; q : BOOL; END_VAR\nq := d[1].QQ;')
    expect(bad.map((x) => x.message)).toEqual(["TON has no output 'QQ'"])
  })

  it('emits an indexed call against a single evaluation of the element', () => {
    const ts = toTypeScript('VAR d : ARRAY [1..2] OF TON; i : INT := 1; q : BOOL; END_VAR\nd[i](IN := TRUE, PT := T#1s, Q => q);')
    expect(ts).toContain("S.d = Array.from({ length: 2 }, () => (makeFb('TON')));")
    expect(ts).toContain('const __fb = elemAt(S.d, S.i, 1, 2);')
    expect(ts).toContain('__fb.call({ IN: true, PT: 1000 }, now);')
    expect(ts).toContain('S.q = __fb.Q;')
  })

  it('fills an emitted global instance below the class it is an instance of', () => {
    const ts = toTypeScript('FUNCTION_BLOCK Cnt VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK\nVAR_GLOBAL c : Cnt; END_VAR\nVAR total : INT; END_VAR\nc();\ntotal := c.n;')
    expect(ts.indexOf('G.c = new Cnt();')).toBeGreaterThan(ts.indexOf('class Cnt'))
    expect(ts).toContain('G.c.call({  }, now);')
  })
})

// A whole array or struct is a value (see copyData in runtime.ts): it assigns, passes by value,
// reads out of a block and returns from a function, always as a copy made into the destination's
// own storage. The corpus carries the goldens for the main shapes through both backends; these are
// the edges around them.
describe('arrays and structs as whole values', () => {
  it('copies into an aliased target, so the VAR_IN_OUT caller sees the copy', () => {
    const src = [
      'FUNCTION_BLOCK Load VAR_IN_OUT buf : ARRAY [1..3] OF INT; END_VAR VAR fresh : ARRAY [1..3] OF INT := [7, 8, 9]; END_VAR',
      'buf := fresh;',
      'END_FUNCTION_BLOCK',
      'VAR l : Load; data : ARRAY [1..3] OF INT; END_VAR VAR_OUTPUT mid : INT; END_VAR',
      'l(buf := data);',
      'mid := data[2];',
    ].join('\n')
    expect(once(src).get('mid')).toBe(8) // rebinding buf to a new array would have left data at 0
  })

  it('gives a FUNCTION its own copy of a struct argument, so writing it never reaches the caller', () => {
    const src = [
      'TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE',
      'FUNCTION Bumped : DINT VAR_INPUT p : Pkg; END_VAR p.id := p.id + 100; Bumped := p.id; END_FUNCTION',
      'VAR box : Pkg; END_VAR VAR_OUTPUT got : DINT; kept : DINT; END_VAR',
      'box.id := 1;',
      'got := Bumped(box);',
      'kept := box.id;',
    ].join('\n')
    const p = once(src)
    expect(p.get('got')).toBe(101)
    expect(p.get('kept')).toBe(1)
  })

  it('keeps two results of one struct-returning function apart within a single expression', () => {
    const src = [
      'TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE',
      'FUNCTION MakePt : Pt VAR_INPUT a : INT; END_VAR MakePt.x := a; MakePt.y := a * 10; END_FUNCTION',
      'FUNCTION Total : INT VAR_INPUT p : Pt; q : Pt; END_VAR Total := p.x + p.y + q.x + q.y; END_FUNCTION',
      'VAR_OUTPUT sum : INT; END_VAR',
      'sum := Total(MakePt(1), MakePt(2));',
    ].join('\n')
    expect(once(src).get('sum')).toBe(33) // 1 + 10 + 2 + 20: the second call did not overwrite the first result
  })

  it('refuses an ARRAY written out as a FUNCTION result, as both external compilers do', () => {
    const src = 'FUNCTION Pair : ARRAY [1..2] OF INT VAR_INPUT a : INT; END_VAR Pair[1] := a; END_FUNCTION\nVAR q : BOOL; END_VAR\n'
    expect(() => compile(src)).toThrow(/a FUNCTION result must be a type name/)
  })

  it('returns an enumeration from a FUNCTION as that enumeration', () => {
    const src = [
      'TYPE Mode : (Idle, Running, Fault); END_TYPE',
      'FUNCTION Pick : Mode VAR_INPUT go : BOOL; END_VAR IF go THEN Pick := Running; ELSE Pick := Idle; END_IF; END_FUNCTION',
      'VAR m : Mode; END_VAR VAR_OUTPUT isRunning : BOOL; END_VAR',
      'm := Pick(TRUE);',
      'isRunning := m = Running;',
    ].join('\n')
    expect(once(src).get('isRunning')).toBe(true)
    const intoInt = 'TYPE Mode : (Idle, Running); END_TYPE\nFUNCTION Pick : Mode VAR_INPUT go : BOOL; END_VAR Pick := Idle; END_FUNCTION\nVAR n : INT; END_VAR\nn := Pick(TRUE);'
    expect(() => compile(intoInt)).toThrow(/cannot assign enumeration Mode/)
  })

  it('enforces a subrange result type on the store into the result', () => {
    const src = [
      'TYPE Pct : INT (0..100); END_TYPE',
      'FUNCTION Scale : Pct VAR_INPUT v : INT; END_VAR Scale := v; END_FUNCTION',
      'VAR_INPUT raw : INT; END_VAR VAR_OUTPUT out : INT; END_VAR',
      'out := Scale(raw);',
    ].join('\n')
    expect(once(src, { raw: 40 }).get('out')).toBe(40)
    expect(() => once(src, { raw: 150 })).toThrow(/150 is outside Pct \(0\.\.100\)/)
  })

  it('reads and binds an enumeration output of a user block', () => {
    const src = [
      'TYPE Mode : (Idle, Running); END_TYPE',
      'FUNCTION_BLOCK Motor VAR_INPUT run : BOOL; END_VAR VAR_OUTPUT state : Mode; END_VAR IF run THEN state := Running; ELSE state := Idle; END_IF; END_FUNCTION_BLOCK',
      'VAR m : Motor; seen : Mode; END_VAR VAR_OUTPUT isRunning : BOOL; bound : BOOL; END_VAR',
      'm(run := TRUE, state => seen);',
      'isRunning := m.state = Running; bound := seen = Running;',
    ].join('\n')
    const p = once(src)
    expect(p.get('isRunning')).toBe(true)
    expect(p.get('bound')).toBe(true)
  })

  it('refuses a copy between types that are not exactly equal, or of a value holding an instance', () => {
    const strs = 'VAR a : ARRAY [1..2] OF STRING[10]; b : ARRAY [1..2] OF STRING[20]; END_VAR\n'
    expect(() => compile(`${strs}a := b;`)).toThrow(/cannot assign ARRAY\[1\.\.2\] OF STRING\[20\] to 'a' of type ARRAY\[1\.\.2\] OF STRING\[10\]/)
    const zones = 'TYPE Zone : STRUCT gap : TON; END_STRUCT; END_TYPE\nVAR z1 : Zone; z2 : Zone; END_VAR\n'
    expect(() => compile(`${zones}z1 := z2;`)).toThrow(/holds function-block instances, which are not values to copy/)
    expect(() => compile('VAR a : ARRAY [1..2] OF INT; END_VAR\na := 5;')).toThrow(/cannot assign INT to 'a' of type ARRAY\[1\.\.2\] OF INT/)
  })

  it('keeps a block output its own: no alias or binding reaches into it', () => {
    const src = [
      'TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE',
      'FUNCTION_BLOCK Reader VAR_OUTPUT pkg : Pkg; n : DINT; END_VAR pkg.id := 1; END_FUNCTION_BLOCK',
      'FUNCTION_BLOCK Stamp VAR_IN_OUT p : Pkg; END_VAR p.id := 9; END_FUNCTION_BLOCK',
      'VAR r : Reader; s : Stamp; t : TON; END_VAR',
      'r();',
    ].join('\n')
    expect(() => compile(`${src}\ns(p := r.pkg);`)).toThrow(/cannot pass function-block output 'pkg' as VAR_IN_OUT 'p'/)
    expect(() => compile(`${src}\nt(IN := TRUE, PT := T#1s, ET => r.n);`)).toThrow(/into function-block output 'n'/)
  })

  it('refuses a by-value input that would carry an instance, and a FUNCTION result that is one', () => {
    const src = [
      'TYPE Zone : STRUCT gap : TON; END_STRUCT; END_TYPE',
      'FUNCTION_BLOCK Take VAR_INPUT z : Zone; END_VAR END_FUNCTION_BLOCK',
      'VAR k : Take; mine : Zone; END_VAR',
      'k(z := mine);',
    ].join('\n')
    expect(() => compile(src)).toThrow(/holds function-block instances, which cannot be passed by value/)
    expect(() => compile('FUNCTION F : TON VAR_INPUT x : BOOL; END_VAR END_FUNCTION\nVAR q : BOOL; END_VAR\n')).toThrow(/a function cannot return a function-block instance/)
  })

  it('says a struct result has to be stored before use', () => {
    const src = 'TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE\nFUNCTION Make : Pkg VAR_INPUT id : DINT; END_VAR Make.id := id; END_FUNCTION\nVAR n : DINT; END_VAR\nn := Make(1);'
    expect(() => compile(src)).toThrow(/'Make' returns a struct; store it in a variable of that type first/)
  })

  it('emits every copy through copyData, so the code shown copies exactly as the engine does', () => {
    const ts = toTypeScript(
      [
        'TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE',
        'FUNCTION_BLOCK Latch VAR_INPUT p : Pkg; END_VAR VAR_OUTPUT held : Pkg; END_VAR held := p; END_FUNCTION_BLOCK',
        'FUNCTION IdOf : DINT VAR_INPUT p : Pkg; END_VAR IdOf := p.id; END_FUNCTION',
        'VAR l : Latch; a : Pkg; b : Pkg; n : DINT; END_VAR',
        'b := a;',
        'l(p := a, held => b);',
        'n := IdOf(a);',
      ].join('\n'),
    )
    expect(ts).toContain('copyData(S.b, S.a);')
    expect(ts).toContain('if (I.p !== undefined) copyData(this.p, I.p);')
    expect(ts).toContain('copyData(S.b, S.l.held);')
    expect(ts).toContain('copyData(F.p, p);')
    expect(ts).toMatch(/^import \{[^}]*\bcopyData\b[^}]*\} from '\.\/runtime'/)
  })
})

// Three standard spellings: `**`, an enumeration value written with its type, and a formal
// FUNCTION call. The corpus carries their goldens through both backends; these are the edges.
describe('exponentiation, qualified enumeration values and formal function calls', () => {
  it('reads ** as EXPT, tighter than * and looser than a unary sign, left to right', () => {
    const p = once('VAR_OUTPUT a : REAL; b : REAL; c : REAL; END_VAR\na := 2.0 ** 3.0 * 2.0;\nb := -2.0 ** 2.0;\nc := 2.0 ** 3.0 ** 2.0;')
    expect(p.get('a')).toBe(16)
    expect(p.get('b')).toBe(4)
    expect(p.get('c')).toBe(64)
  })

  it('still reads (**) as an empty comment beside ** the operator', () => {
    expect(once('VAR_OUTPUT a : REAL; END_VAR\n(**) a := 3.0 ** 2.0; (* squared *)').get('a')).toBe(9)
  })

  it('resolves Mode#Member to that enumeration even where a variable shares the member name', () => {
    const src = [
      'TYPE Mode : (Idle, Running); END_TYPE',
      'VAR m : Mode; Running : BOOL; END_VAR VAR_OUTPUT isRun : BOOL; END_VAR',
      'Running := TRUE;',
      'm := Mode#Running;',
      'isRun := m = Mode#Running;',
    ].join('\n')
    expect(once(src).get('isRun')).toBe(true)
  })

  it('starts an enumeration at its declared value, qualified or not', () => {
    const src = [
      'TYPE Mode : (Idle, Running, Faulted); END_TYPE',
      'VAR a : Mode := Running; b : Mode := Mode#Faulted; c : Mode; END_VAR',
      'VAR_OUTPUT isA : BOOL; isB : BOOL; isC : BOOL; END_VAR',
      'isA := a = Running; isB := b = Faulted; isC := c = Idle;',
    ].join('\n')
    const p = once(src)
    expect(p.get('isA')).toBe(true) // once dropped: `a` began at Idle
    expect(p.get('isB')).toBe(true)
    expect(p.get('isC')).toBe(true) // no initial value: the first member, per IEC
  })

  it('refuses a Type#Member that names nothing, and a starting value from elsewhere', () => {
    const two = 'TYPE Mode : (Idle, Running); END_TYPE\nTYPE Door : (Open, Shut); END_TYPE\n'
    expect(() => compile(`${two}VAR m : Mode; END_VAR\nm := Door#Idle;`)).toThrow(/'Idle' is not a member of enumeration Door/)
    expect(() => compile(`${two}VAR n : INT; END_VAR\nn := Pump#On;`)).toThrow(/'Pump' is not an enumeration, so 'Pump#On' names nothing/)
    expect(() => compile(`${two}VAR m : Mode := Shut; END_VAR\n`)).toThrow(/cannot initialise 'm' of type enumeration Mode with enumeration Door/)
    expect(() => compile(`${two}VAR m : Mode := 1; END_VAR\n`)).toThrow(/cannot initialise 'm' of type enumeration Mode with INT/)
    expect(() => compile(`${two}VAR m : Mode; c : INT; END_VAR\nCASE m OF Door#Open: c := 1; END_CASE;`)).toThrow(/'Open' belongs to Door, but this CASE selects on Mode/)
  })

  it('refuses a single initial value for a whole struct, rather than dropping it', () => {
    expect(() => compile('TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\nVAR p : Pt := 5; END_VAR\n')).toThrow(/'p' is a struct, so it cannot take a single initial value/)
  })

  it('puts a formal function call back into declaration order', () => {
    const src = [
      'FUNCTION Span : INT VAR_INPUT lo : INT; hi : INT; END_VAR Span := hi - lo; END_FUNCTION',
      'VAR_OUTPUT a : INT; b : INT; END_VAR',
      'a := Span(hi := 10, lo := 3);',
      'b := Span(lo := 3, hi := 10);',
    ].join('\n')
    const p = once(src)
    expect(p.get('a')).toBe(7)
    expect(p.get('b')).toBe(7)
    expect(toTypeScript(src)).toContain('S.a = Span(3, 10);')
  })

  it('refuses a formal call that repeats, invents or mixes an argument', () => {
    const fn = 'FUNCTION Span : INT VAR_INPUT lo : INT; hi : INT; END_VAR Span := hi - lo; END_FUNCTION\nVAR n : INT; END_VAR\n'
    expect(() => compile(`${fn}n := Span(lo := 3, lo := 4);`)).toThrow(/'Span' input 'lo' is given twice/)
    expect(() => compile(`${fn}n := Span(lo := 3, top := 4);`)).toThrow(/'Span' has no input 'top'/)
    expect(() => compile(`${fn}n := Span(lo := 3, 10);`)).toThrow(/all-positional or all-named/)
    expect(() => compile(`${fn}n := Span(3, hi := 10);`)).toThrow(/all-positional or all-named/)
    expect(() => compile(`${fn}n := Span(lo => n, hi := 1);`)).toThrow(/a FUNCTION has no outputs/)
    // a standard function's own names: every input, IEC's spelling, an extensible one with no gap
    expect(() => compile('VAR n : INT; END_VAR\nn := LIMIT(MN := 0, IN := 5, MN := 9);')).toThrow(/'LIMIT' input 'MN' is given twice/)
    expect(() => compile('VAR n : INT; END_VAR\nn := LIMIT(LO := 0, IN := 5, MX := 9);')).toThrow(/'LIMIT' has no input 'LO' \(its inputs are MN, IN, MX\)/)
    expect(() => compile('VAR n : INT; END_VAR\nn := ADD(IN1 := 1, IN3 := 3);')).toThrow(/'ADD' input 'IN2' is not given/)
    expect(() => compile('VAR r : REAL; END_VAR\nr := SQRT(X := 4.0);')).toThrow(/'SQRT' has no input 'X' \(its inputs are IN\)/)
    expect(once('VAR n : INT; END_VAR\nn := LIMIT(MX := 9, IN := 50, MN := 0);', {}).get('n')).toBe(9)
  })

  it('emits an input a call leaves out as undefined, filled with its start value in the function', () => {
    const src = `FUNCTION Scale : INT
VAR_INPUT v : INT; gain : INT := 2; offset : INT := 10; END_VAR
Scale := v * gain + offset;
END_FUNCTION
FUNCTION Twice : INT
VAR_INPUT v : INT; END_VAR
Twice := v * 2;
END_FUNCTION
VAR n : INT; m : INT; END_VAR
n := Scale(offset := 0, v := 5);
m := Twice(v := 1);`
    const ts = toTypeScript(src)
    expect(ts).toContain('Scale(5, undefined, 0)')
    expect(ts).toMatch(/if \(F\.gain === undefined\) F\.gain = 2;/)
    // a function no call leaves an input out of carries no such line
    const twice = ts.slice(ts.indexOf('function Twice'), ts.indexOf('\n}', ts.indexOf('function Twice')))
    expect(twice).toContain('return F.Twice')
    expect(twice).not.toContain('=== undefined')
    expect(once(src, {}).get('n')).toBe(10)
  })
})

// DATE, TOD and DT. The corpus holds the goldens (both backends, replayed through MATIEC); these are the
// edges no external compiler is asked about: names, the lexer's refusals, the conversions that are refused.
describe('the calendar types', () => {
  it('leaves dt, tod and date usable as ordinary names, as programs before the types used them', () => {
    const src = 'VAR dt : REAL := 0.5; tod : INT := 3; date : BOOL; END_VAR\ndt := dt * 2.0; tod := tod + 1; date := TRUE;'
    const p = once(src, {})
    expect(p.get('dt')).toBe(1)
    expect(p.get('tod')).toBe(4)
  })

  it('lets a user type take one of the names', () => {
    expect(() => compile('TYPE Date : STRUCT day : INT; END_STRUCT; END_TYPE\nVAR d : Date; END_VAR\nd.day := 3;')).not.toThrow()
  })

  it('refuses a literal that names no instant, saying which part is wrong', () => {
    expect(() => compile('VAR d : DATE := D#2024-13-01; END_VAR')).toThrow(/2024-13-01 is not a date/)
    expect(() => compile('VAR t : TOD := TOD#12:60:00; END_VAR')).toThrow(/minute 60 is not 0 to 59/)
    expect(() => compile('VAR x : DT := DT#2024-01-01; END_VAR')).toThrow(/expected a date and time such as/)
    expect(() => compile('VAR d : DATE := D#1969-12-31; END_VAR')).toThrow(/before 1970-01-01/)
  })

  it('reads a subtraction straight after a date literal as a subtraction', () => {
    expect(once('VAR t : TIME; END_VAR\nt := D#2024-01-02-D#2024-01-01;', {}).get('t')).toBe(86_400_000)
  })

  it('starts a calendar variable at 1970-01-01 and midnight', () => {
    const p = once('VAR d : DATE; t : TOD; x : DT; sd : STRING; st : STRING; sx : STRING; END_VAR\nsd := DATE_TO_STRING(d); st := TOD_TO_STRING(t); sx := DT_TO_STRING(x);', {})
    expect([p.get('sd'), p.get('st'), p.get('sx')]).toEqual(['D#1970-01-01', 'TOD#00:00:00', 'DT#1970-01-01-00:00:00'])
  })

  it('refuses a conversion to or from a number, and names the portable spelling', () => {
    expect(() => compile('VAR t : TOD; n : DINT; END_VAR\nn := TOD_TO_DINT(t);')).toThrow(/STruC\+\+ in milliseconds\); keep it a TOD and compare it with a TOD literal/)
    expect(() => compile('VAR d : DATE; n : UDINT; END_VAR\nn := DATE_TO_UDINT(d);')).toThrow(/MATIEC in seconds since 1970, STruC\+\+ in days/)
    expect(() => compile('VAR x : DT; n : UDINT := 5; END_VAR\nx := UDINT_TO_DT(n);')).toThrow(/UDINT_TO_DT is not portable/)
    expect(() => compile('VAR d : DATE; x : DT; END_VAR\nx := DATE_TO_DT(d);')).toThrow(/join a DATE and a TOD with CONCAT_DATE_TOD/)
    expect(() => compile('VAR d : DATE; t : TOD; END_VAR\nt := DATE_TO_TOD(d);')).toThrow(/taken from a DT/)
  })

  it('keeps durations and dates apart in the ordered and selecting functions', () => {
    expect(() => compile('VAR t : TOD; d : TIME; r : TOD; END_VAR\nr := MAX(t, d);')).toThrow(/'MAX' mixes TOD with TIME/)
    expect(() => compile('VAR t : TIME; r : TIME; END_VAR\nr := SEL(TRUE, t, 5);')).toThrow(/'SEL' mixes TIME with INT/)
    expect(() => compile('VAR t : TOD; b : BOOL; END_VAR\nb := GT(t, 5);')).toThrow(/'GT' mixes TOD with INT/)
  })

  it('divides a duration the same way through /, DIV and DIVTIME', () => {
    const p = once('VAR a : TIME := T#1s; x : TIME; y : TIME; z : TIME; END_VAR\nx := a / 3; y := DIV(a, 3); z := DIVTIME(a, 3);', {})
    expect([p.get('x'), p.get('y'), p.get('z')]).toEqual([333, 333, 333])
  })
})

// Named types: `TYPE Row : ARRAY ...` is one type under its name, and a plain alias names its base
// type. The corpus carries the main goldens through both backends; these are the edges.
describe('named types', () => {
  it('gives a STRING alias its capacity wherever it is used: a variable, a field, an element, a result', () => {
    const src = [
      'TYPE Label : STRING[5]; END_TYPE',
      'TYPE Tag : Label; END_TYPE',
      'TYPE Box : STRUCT name : Label; END_STRUCT; END_TYPE',
      'FUNCTION Pad : Tag VAR_INPUT s : STRING; END_VAR Pad := s; END_FUNCTION',
      'VAR v : Label; b : Box; row : ARRAY [1..2] OF Tag; r : STRING; END_VAR',
      'VAR_OUTPUT nv : INT; nb : INT; nr : INT; nf : INT; END_VAR',
      "v := 'conveyor'; b.name := 'conveyor'; row[2] := 'conveyor'; r := Pad('conveyor');",
      'nv := LEN(v); nb := LEN(b.name); nr := LEN(row[2]); nf := LEN(r);',
    ].join('\n')
    const p = once(src)
    expect([p.get('nv'), p.get('nb'), p.get('nr'), p.get('nf')]).toEqual([5, 5, 5, 5])
  })

  it('follows a chain of names, and refuses a cycle of them or a name taken twice', () => {
    expect(once('TYPE A : INT; END_TYPE\nTYPE B : A; END_TYPE\nVAR b : B := 3; END_VAR VAR_OUTPUT n : INT; END_VAR\nn := b + 1;').get('n')).toBe(4)
    expect(() => compile('TYPE A : B; END_TYPE\nTYPE B : A; END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/recursive type/)
    expect(() => compile('TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\nTYPE Pt : INT; END_TYPE\nVAR x : INT; END_VAR\n')).toThrow(/duplicate type 'Pt'/)
  })

  it('binds a VAR_IN_OUT of a named array only to a place of that name', () => {
    const fb = 'TYPE Row : ARRAY [1..3] OF INT; END_TYPE\nFUNCTION_BLOCK Fill VAR_IN_OUT r : Row; END_VAR r[1] := 7; END_FUNCTION_BLOCK\n'
    expect(once(`${fb}VAR f : Fill; mine : Row; END_VAR VAR_OUTPUT first : INT; END_VAR\nf(r := mine);\nfirst := mine[1];`).get('first')).toBe(7)
    expect(() => compile(`${fb}VAR f : Fill; loose : ARRAY [1..3] OF INT; END_VAR\nf(r := loose);`)).toThrow(/VAR_IN_OUT 'r' needs exactly Row, got ARRAY\[1\.\.3\] OF INT/)
  })

  it('returns a named array from a FUNCTION', () => {
    const src = 'TYPE Row : ARRAY [1..2] OF INT; END_TYPE\nFUNCTION Pair : Row VAR_INPUT a : INT; END_VAR Pair[1] := a; Pair[2] := a * 10; END_FUNCTION\nVAR r : Row; END_VAR VAR_OUTPUT second : INT; END_VAR\nr := Pair(4);\nsecond := r[2];'
    expect(once(src).get('second')).toBe(40)
  })
})

describe('constant array bounds', () => {
  it('sizes arrays from global constants in a named type, a struct field and a declaration', () => {
    const src = [
      'VAR_GLOBAL CONSTANT N : INT := 3; END_VAR',
      'TYPE Row : ARRAY [1..N] OF INT; END_TYPE',
      'TYPE Rec : STRUCT cells : ARRAY [0..N - 1] OF BOOL; END_STRUCT; END_TYPE',
      // the output is `got`, not `n`: identifiers are case-insensitive, so a local `n` would shadow
      // the global `N` in `r[N]` (and correctly so) while the TYPE's bound still folds the global
      'VAR r : Row; rec : Rec; big : ARRAY [1..N * 2] OF INT; END_VAR VAR_OUTPUT got : INT; lit : BOOL; END_VAR',
      'r[N] := 5; rec.cells[N - 1] := TRUE; big[6] := r[3];',
      'got := big[6]; lit := rec.cells[2];',
    ].join('\n')
    const p = once(src)
    expect(p.get('got')).toBe(5)
    expect(p.get('lit')).toBe(true)
    expect(toTypeScript(src)).toContain('Array.from({ length: 6 }') // folded to a number for every backend
  })

  it('faults past a folded bound exactly as past a literal one', () => {
    const p = compile('VAR CONSTANT N : INT := 2; END_VAR VAR a : ARRAY [1..N] OF INT; END_VAR VAR_INPUT i : INT; END_VAR\na[i] := 1;')
    p.setInput('i', 3)
    expect(() => p.scan(0.1)).toThrow(/array index 3 out of bounds \[1\.\.2\]/)
  })

  it('refuses a bound that is not a constant, or that runs backwards once folded', () => {
    expect(() => compile('VAR k : INT := 3; a : ARRAY [1..k] OF INT; END_VAR\n')).toThrow(/'k' is not an integer CONSTANT declared before it/)
    expect(() => compile('VAR CONSTANT R : REAL := 2.0; END_VAR VAR a : ARRAY [1..R] OF INT; END_VAR\n')).toThrow(/'R' is not an integer CONSTANT/)
    expect(() => compile('VAR CONSTANT N : INT := 3; END_VAR VAR a : ARRAY [N..1] OF INT; END_VAR\n')).toThrow(/array bounds must be ascending \(3\.\.1\)/)
    expect(() => compile('VAR CONSTANT N : INT := 0; END_VAR VAR a : ARRAY [1..4 / N] OF INT; END_VAR\n')).toThrow(/divides by zero/)
    // a TYPE sees only the global constants, not those of whichever POU uses it first
    expect(() => compile('TYPE Row : ARRAY [1..M] OF INT; END_TYPE\nVAR CONSTANT M : INT := 2; END_VAR VAR r : Row; END_VAR\n')).toThrow(/'M' is not an integer CONSTANT/)
  })
})

// A struct's `(field := value)` starting value, nested and in arrays. The corpus carries the goldens
// through both backends; these are the edges.
describe('structured initial values', () => {
  it('starts an array of enumerations, and restarts a FUNCTION local struct on every call', () => {
    const src = [
      'TYPE Mode : (Idle, Running); END_TYPE',
      'TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE',
      'FUNCTION Bump : INT VAR_INPUT d : INT; END_VAR VAR p : Pt := (x := 10); END_VAR p.x := p.x + d; Bump := p.x; END_FUNCTION',
      'VAR modes : ARRAY [1..2] OF Mode := [Running, Idle]; END_VAR',
      'VAR_OUTPUT first : BOOL; a : INT; b : INT; END_VAR',
      'first := modes[1] = Running;',
      'a := Bump(1); b := Bump(1);',
    ].join('\n')
    const p = once(src)
    expect(p.get('first')).toBe(true)
    expect(p.get('a')).toBe(11)
    expect(p.get('b')).toBe(11) // the local starts from its initializer again, not from 11
  })

  it('gives each name in a declaration list its own copy of the starting value', () => {
    expect(once('TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\nVAR a, b : Pt := (x := 1); END_VAR VAR_OUTPUT bx : INT; END_VAR\na.x := 9;\nbx := b.x;').get('bx')).toBe(1)
  })

  it('starts a named array field from a [...] list inside a struct initializer', () => {
    expect(once('TYPE Row3 : ARRAY [1..3] OF BOOL; END_TYPE\nTYPE Zone : STRUCT eyes : Row3; END_STRUCT; END_TYPE\nVAR z : Zone := (eyes := [FALSE, TRUE, FALSE]); END_VAR VAR_OUTPUT e2 : BOOL; END_VAR\ne2 := z.eyes[2];').get('e2')).toBe(true)
  })

  it('starts the plain fields of a struct that also holds a timer', () => {
    expect(once('TYPE Zone : STRUCT gap : TON; limit : INT; END_STRUCT; END_TYPE\nVAR z : Zone := (limit := 5); END_VAR VAR_OUTPUT lim : INT; END_VAR\nlim := z.limit;').get('lim')).toBe(5)
  })

  it('refuses a field named twice, a list where a single value goes, and a list on the wrong kind of type', () => {
    const pt = 'TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE\n'
    expect(() => compile(`${pt}VAR p : Pt := (x := 1, x := 2); END_VAR\n`)).toThrow(/'p' gives field 'x' twice/)
    expect(() => compile(`${pt}VAR p : Pt := (x := [1, 2]); END_VAR\n`)).toThrow(/'p' field 'x' is a single value, so it cannot take a \[\.\.\.\] list/)
    expect(() => compile('VAR n : INT := (x := 1); END_VAR\n')).toThrow(/'n' is not a struct, so it cannot take a \(field := \.\.\.\) initializer/)
    expect(() => compile('TYPE Zone : STRUCT gap : TON; END_STRUCT; END_TYPE\nVAR z : Zone := (gap := 1); END_VAR\n')).toThrow(/'z' field 'gap' is a function-block instance/)
    expect(() => compile(`${pt}VAR ps : ARRAY [1..2] OF Pt := [1, 2]; END_VAR\n`)).toThrow(/'ps' element is a struct, so its initial value is a \(field := \.\.\.\) list/)
  })

  it('emits a starting struct as one literal with every field, the unnamed ones at zero', () => {
    expect(toTypeScript('TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE\nVAR p : Pt := (y := 4); END_VAR\np.x := 1;')).toContain('S.p = { x: 0, y: 4 };')
  })
})

describe('duration literals', () => {
  /** the milliseconds a literal lexes to */
  const ms = (literal: string): number => lex(`x := ${literal};`).find((t) => t.kind === 'num')!.num!
  /** the error a literal is refused with */
  const refusal = (literal: string): StError => {
    try {
      lex(`x := ${literal};`)
    } catch (e) {
      if (e instanceof StError) return e
    }
    throw new Error(`${literal} was not refused`)
  }

  it('reads every IEC unit, underscores, a sign and a fraction, in either case', () => {
    expect(ms('T#1m30s')).toBe(90_000)
    expect(ms('T#1d')).toBe(86_400_000) // was 0: days were not a unit
    expect(ms('T#1_000ms')).toBe(1000) // was 0: the regex skipped the "1_" and read "000ms"
    expect(ms('T#1s_500ms')).toBe(1500)
    expect(ms('T#1d2h3m4s5ms')).toBe(86_400_000 + 7_200_000 + 180_000 + 4000 + 5)
    expect(ms('T#-5s')).toBe(-5000)
    expect(ms('TIME#1.5s')).toBe(1500)
    expect(ms('t#0.5MS')).toBe(0.5)
  })

  it('refuses microseconds and nanoseconds, offering the same value in milliseconds', () => {
    // read as 0 ms, T#500us would fire a timer at once, with no error anywhere
    expect(refusal('T#500us').message).toBe('T#500us: microseconds (us) and nanoseconds (ns) are LTIME units, which TIME here does not take: write T#0.5ms instead')
    expect(refusal('T#1s500us').message).toMatch(/write T#1000\.5ms instead/)
    expect(refusal('T#250ns').message).toMatch(/write T#0\.00025ms instead/)
  })

  it('refuses a literal it cannot read whole, rather than reading part of it', () => {
    expect(refusal('T#5x').message).toMatch(/x is not a duration unit/)
    expect(refusal('T#500').message).toMatch(/500 needs a unit/)
    expect(refusal('T#1s_').message).toMatch(/cannot end in "_"/)
    expect(refusal('T# ').message).toMatch(/needs a value and a unit/)
  })

  it('a DIV() by zero faults at the call, with its line, as the / operator does', () => {
    // a plain Error would reach the editor as "runtime fault: division by zero" with no line
    const src = 'VAR_INPUT d : INT; END_VAR\nVAR_OUTPUT q : INT; END_VAR\nq := DIV(10, d);'
    const p = compile(src)
    p.setInput('d', 0)
    let err: unknown
    try {
      p.scan(0.01)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StError)
    expect((err as StError).message).toBe('division by zero')
    expect((err as StError).pos.line).toBe(3)
    expect(src.slice((err as StError).pos.offset)).toMatch(/^DIV\(/)
  })

  it('puts the error on the literal, the whole of it, so the editor underlines what is wrong', () => {
    const src = 'VAR t : TON; END_VAR\nt(IN := TRUE, PT := T#500us);'
    const found = diagnostics(src)
    expect(found).toHaveLength(1)
    expect(src.slice(found[0]!.pos.offset, found[0]!.pos.offset + found[0]!.length)).toBe('T#500us')
  })
})
