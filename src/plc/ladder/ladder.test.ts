// Ladder Diagram (ladder.ts): the rung text, what it lowers to, and what it does when it runs. The expected
// behaviour below is IEC 61131-3's (8.2.3-8.2.4), derived by hand from the element definitions.

import { describe, expect, it } from 'vitest'
import { diagnostics } from '../checker'
import { exportProgram } from '../exchange/export'
import { compile } from '../interpreter'
import { ladderExportCaveats, expandLadder } from './ladder'
import { lex } from '../lexer'
import { parse } from '../parser'
import type { TagValue } from '../types'

/** Run `src` for one scan per entry of `inputs`, returning the listed variables after each scan. */
function trace(src: string, inputs: Record<string, TagValue>[], watch: string[], dt = 0.01): Record<string, TagValue | undefined>[] {
  const p = compile(src)
  return inputs.map((ins) => {
    for (const [k, v] of Object.entries(ins)) p.setInput(k, v)
    p.scan(dt)
    return Object.fromEntries(watch.map((w) => [w, p.get(w)]))
  })
}

/** The ST a program's ladder lowers to, as the text exporters write it. */
function lowered(src: string): string {
  return expandLadder(src, parse(lex(src)).ladder)
}

const BOOLS = (names: string): string => `VAR ${names.split(' ').join(', ')} : BOOL; END_VAR\n`

describe('a rung, read and run', () => {
  it('seals in: start latches the motor through its own contact, stop drops it', () => {
    const src = `${BOOLS('Start Stop Motor')}LADDER
  [|Start|, |Motor|] |/Stop| (Motor);
END_LADDER`
    expect(lowered(src)).toContain('Motor := (Start OR Motor) AND NOT Stop;')
    const t = trace(src, [{ Start: true }, { Start: false }, {}, { Stop: true }, { Stop: false }], ['Motor'])
    expect(t.map((r) => r['Motor'])).toEqual([true, true, true, false, false])
  })

  it('a coil passes its left link on: outputs stand in series, and an empty rung does nothing', () => {
    const src = `${BOOLS('A B C')}LADDER
  |A| (B) (C);
  ;
END_LADDER`
    expect(trace(src, [{ A: true }, { A: false }], ['B', 'C'])).toEqual([
      { B: true, C: true },
      { B: false, C: false },
    ])
  })

  it('an element sees what the elements before it wrote: a contact after a coil reads the new value', () => {
    // |A| (B) |B| (C): C's left link is A AND B, and B is A by then
    const src = `${BOOLS('A B C')}LADDER
  |A| (B) |B| (C);
END_LADDER`
    expect(trace(src, [{ A: true }, { A: false }], ['C'])).toEqual([{ C: true }, { C: false }])
  })

  it('a rung condition is what its element examined: a coil that rewrites it does not change what flows on', () => {
    // |A| (/A) (B): B gets the A that was examined, although (/A) has just flipped it
    const src = `${BOOLS('A B')}LADDER
  |A| (/A) (B);
END_LADDER`
    expect(lowered(src)).toMatch(/LD_C1 := A;\s*A := NOT LD_C1;\s*B := LD_C1;/)
    expect(trace(src, [{ A: true }], ['A', 'B'])).toEqual([{ A: false, B: true }])
  })

  it('a branch runs the paths holding a contact first, then the paths of coils, and ORs their right links', () => {
    // (X) is only a coil, so it runs after |X| (Y): the contact examines X as it was (branchOrder)
    const src = `${BOOLS('A X Y Z')}LADDER
  |A| [(X), |X| (Y), |/A|] (Z);
END_LADDER`
    expect(trace(src, [{ A: true }, { A: true }, { A: false }], ['X', 'Y', 'Z'])).toEqual([
      { X: true, Y: false, Z: true },
      { X: true, Y: true, Z: true },
      { X: false, Y: false, Z: false },
    ])
  })

  it('paths that both hold a contact run top to bottom, so the lower one sees what the upper one wrote', () => {
    const src = `${BOOLS('A X Y')}LADDER
  |A| [|A| (X), |X| (Y)];
END_LADDER`
    expect(trace(src, [{ A: true }, { A: false }], ['X', 'Y'])).toEqual([
      { X: true, Y: true },
      { X: false, Y: false },
    ])
  })

  it('an empty path is a wire', () => {
    const src = `${BOOLS('A B Q')}LADDER
  |A| [|B|, ] (Q);
END_LADDER`
    expect(trace(src, [{ A: true }, { A: false, B: true }], ['Q'])).toEqual([{ Q: true }, { Q: false }])
  })

  it('set and reset coils hold their variable between rungs that energize them', () => {
    const src = `${BOOLS('Go Halt Run')}LADDER
  |Go| (S Run);
  |Halt| (R Run);
END_LADDER`
    const t = trace(src, [{ Go: true }, { Go: false }, { Halt: true }, { Halt: false }], ['Run'])
    expect(t.map((r) => r['Run'])).toEqual([true, true, false, false])
  })

  it('a negated coil writes the inverse of its left link and passes the link itself on', () => {
    const src = `${BOOLS('A Off On')}LADDER
  |A| (/Off) (On);
END_LADDER`
    expect(trace(src, [{ A: true }, { A: false }], ['Off', 'On'])).toEqual([
      { Off: false, On: true },
      { Off: true, On: false },
    ])
  })
})

describe('transition-sensing contacts and coils', () => {
  it('a P contact passes power for one evaluation after its variable rises, and only while its left link is on', () => {
    const src = `${BOOLS('En Btn Pulse')}LADDER
  |En| |P Btn| (Pulse);
END_LADDER`
    const t = trace(
      src,
      [{ En: true, Btn: false }, { Btn: true }, {}, { Btn: false }, { En: false, Btn: true }, { En: true }, { Btn: false }, { Btn: true }],
      ['Pulse'],
    )
    // the rise with En off (scan 5) is sensed and lost: the contact remembers its variable whatever its left link does
    expect(t.map((r) => r['Pulse'])).toEqual([false, true, false, false, false, false, false, true])
  })

  it('an N contact passes power for one evaluation after its variable falls', () => {
    const src = `${BOOLS('Btn Pulse')}LADDER
  |N Btn| (Pulse);
END_LADDER`
    const t = trace(src, [{ Btn: true }, {}, { Btn: false }, {}], ['Pulse'])
    expect(t.map((r) => r['Pulse'])).toEqual([false, false, true, false])
  })

  it('P and N coils turn on for one evaluation after their left link changes, and pass it on', () => {
    const src = `${BOOLS('A Up Down Same')}LADDER
  |A| (P Up) (N Down) (Same);
END_LADDER`
    const t = trace(src, [{ A: false }, { A: true }, {}, { A: false }, {}], ['Up', 'Down', 'Same'])
    expect(t).toEqual([
      { Up: false, Down: false, Same: false },
      { Up: true, Down: false, Same: true },
      { Up: false, Down: false, Same: true },
      { Up: false, Down: true, Same: false },
      { Up: false, Down: false, Same: false },
    ])
  })

  it('a FUNCTION cannot hold an edge: it keeps nothing between calls', () => {
    const src = `FUNCTION F : BOOL
VAR_INPUT A : BOOL; END_VAR
LADDER
  |P A| (F);
END_LADDER
END_FUNCTION
VAR x : BOOL; END_VAR
x := F(TRUE);`
    expect(() => compile(src)).toThrow(/P contact remembers its previous state, and a FUNCTION keeps nothing/)
  })
})

describe('boxes', () => {
  it('a timer on the rung: the rung feeds IN, Q carries on', () => {
    const src = `VAR Run, Late : BOOL; T1 : TON; END_VAR
LADDER
  |Run| T1(IN, PT := T#30ms) (Late);
END_LADDER`
    expect(lowered(src)).toContain('T1(IN := Run, PT := T#30ms);')
    const t = trace(src, [{ Run: true }, {}, {}, {}, { Run: false }], ['Late'], 0.01)
    // ET counts from the scan IN rose on, so Q is on at the fourth 10 ms scan (the timing the MATIEC oracle holds)
    expect(t.map((r) => r['Late'])).toEqual([false, false, false, true, false])
  })

  it('names another pin bare to put that one on the rung', () => {
    // the counter's reset on the rung, and its count carried in by value
    const src = `VAR Clear, Pulse, Full : BOOL; C1 : CTU; END_VAR
LADDER
  |Clear| C1(R, CU := Pulse, PV := 2, Q);
  |C1.Q| (Full);
END_LADDER`
    const t = trace(src, [{ Pulse: true }, { Pulse: false }, { Pulse: true }, { Clear: true }], ['Full'])
    expect(t.map((r) => r['Full'])).toEqual([false, false, true, false])
  })

  it('a block with EN on the rung runs only while it is on, and ENO passes the rung on', () => {
    const src = `VAR Go, Done : BOOL; T1 : TON; END_VAR
LADDER
  |Go| T1(EN, IN := TRUE, PT := T#20ms) (Done);
END_LADDER`
    expect(lowered(src)).toContain('IF Go THEN T1(IN := TRUE, PT := T#20ms); END_IF;')
    const t = trace(src, [{ Go: true }, {}, { Go: false }, { Go: true }], ['Done', 'T1.ET'])
    // stopped at EN FALSE the timer holds, and ENO is off with the rung
    expect(t.map((r) => r['Done'])).toEqual([true, true, false, true])
  })

  it('a function runs while the rung is on (EN), its result goes where OUT => says, and ENO passes the rung on', () => {
    const src = `VAR Go, Seen : BOOL; Count : INT; END_VAR
LADDER
  |Go| ADD(IN1 := Count, IN2 := 1, OUT => Count) (Seen);
END_LADDER`
    expect(lowered(src)).toContain('IF Go THEN Count := ADD(Count, 1); END_IF;')
    const t = trace(src, [{ Go: true }, {}, { Go: false }, { Go: true }], ['Count', 'Seen'])
    expect(t).toEqual([
      { Count: 1, Seen: true },
      { Count: 2, Seen: true },
      { Count: 2, Seen: false },
      { Count: 3, Seen: true },
    ])
  })

  it('a user function block, its pins read off its declaration', () => {
    const src = `FUNCTION_BLOCK Latch
VAR_INPUT Set : BOOL; Clear : BOOL; END_VAR
VAR_OUTPUT On : BOOL; END_VAR
IF Set THEN On := TRUE; END_IF;
IF Clear THEN On := FALSE; END_IF;
END_FUNCTION_BLOCK
VAR A, B, Lamp : BOOL; L : Latch; END_VAR
LADDER
  |A| L(Set, Clear := B) (Lamp);
END_LADDER`
    const t = trace(src, [{ A: true }, { A: false }, { B: true }], ['Lamp'])
    expect(t.map((r) => r['Lamp'])).toEqual([true, true, false])
  })
})

describe('a function that starts the rung', () => {
  const VARS = 'VAR A, B, C, Q : BOOL; N : INT; END_VAR\n'
  const errors = (src: string): string[] => diagnostics(src).map((d) => d.message)

  it('its BOOL result, OUT written bare, is the rung from there on, and contacts after it are in series', () => {
    const src = `${VARS}LADDER
  EQ(IN1 := N, IN2 := 3, OUT) |A| (Q);
END_LADDER`
    const t = trace(src, [{ N: 3, A: true }, { N: 4 }, { N: 3, A: false }, { A: true }], ['Q'])
    expect(t.map((r) => r['Q'])).toEqual([true, false, false, true])
  })

  it('holds what it returned in a temporary, which the rung reads and a view draws', () => {
    const src = `${VARS}LADDER
  GT(IN1 := N, IN2 := 5, OUT) (Q);
END_LADDER`
    expect(lowered(src)).toContain('LD_R1 := GT(N, 5);')
    expect(lowered(src)).toContain('Q := LD_R1;')
    const box = parse(lex(src)).ladder[0]!.rungs[0]!.elements[0]!
    expect(box).toMatchObject({ kind: 'box', result: 'LD_R1', resolved: { type: 'GT', input: null, output: 'OUT' } })
    expect(compile(src).bindable).not.toContain('LD_R1')
  })

  it('what it examined is what flows on, though a later element writes an operand of it', () => {
    // the sequencer idiom: the state moves on in the rung that tests it, and the rung still acts on the old state
    const src = `${VARS}LADDER
  EQ(IN1 := N, IN2 := 0, OUT) |A| MOVE(IN := 10, OUT => N) (Q);
  EQ(IN1 := N, IN2 := 10, OUT) |B| MOVE(IN := 20, OUT => N) (C);
END_LADDER`
    // one scan with both enabled runs both steps, rung after rung, as a scan does
    const t = trace(src, [{ A: true, B: true }, { A: false, B: false }], ['N', 'Q', 'C'])
    expect(t).toEqual([
      { N: 20, Q: true, C: true },
      { N: 20, Q: false, C: false },
    ])
  })

  it('may start any path of a branch that stands at the left rail, nested or not', () => {
    const src = `${VARS}LADDER
  [GT(IN1 := N, IN2 := 5, OUT), |B|] (Q);
  [[LT(IN1 := N, IN2 := 2, OUT), |C|] |A|, |B|] (C);
END_LADDER`
    const t = trace(src, [{ N: 6 }, { N: 3 }, { B: true }, { B: false, N: 1, A: true }], ['Q', 'C'])
    expect(t).toEqual([
      { Q: true, C: false },
      { Q: false, C: false },
      { Q: true, C: true },
      { Q: false, C: true },
    ])
  })

  it('a user FUNCTION returning BOOL starts a rung too', () => {
    const src = `FUNCTION InRange : BOOL
VAR_INPUT X, Lo, Hi : INT; END_VAR
InRange := (X >= Lo) AND (X <= Hi);
END_FUNCTION
${VARS}LADDER
  InRange(X := N, Lo := 1, Hi := 5, OUT) (Q);
END_LADDER`
    expect(trace(src, [{ N: 3 }, { N: 7 }], ['Q']).map((r) => r['Q'])).toEqual([true, false])
  })

  it('stands only where the left rail does: anywhere later nothing would feed it', () => {
    for (const rung of ['|A| EQ(IN1 := N, IN2 := 3, OUT) (Q);', '[|A|, |B|] EQ(IN1 := N, IN2 := 3, OUT) (Q);', '|A| [EQ(IN1 := N, IN2 := 3, OUT), |B|] (Q);']) {
      expect(errors(`${VARS}LADDER\n  ${rung}\nEND_LADDER`)).toEqual([expect.stringMatching(/starts a rung: nothing feeds it, so it stands at the left rail/)])
    }
  })

  it('is no export caveat at the start of a rung, and one on a branch or with more than two operands', () => {
    const gaps = (rungs: string): string[] => ladderExportCaveats(parse(lex(`${VARS}LADDER\n${rungs}\nEND_LADDER`)).ladder[0]!)
    expect(gaps('  EQ(IN1 := N, IN2 := 3, OUT) |A| (Q);')).toEqual([])
    // a box a contact feeds on a branch is fine: only the one that starts a path is refused
    expect(gaps('  |A| [ADD(IN1 := N, IN2 := 1, OUT => N), |B|] (Q);')).toEqual([])
    expect(gaps('  [GT(IN1 := N, IN2 := 5, OUT), |B|] (Q);')).toEqual([expect.stringMatching(/only at the start of a rung, not on a branch/)])
    expect(gaps('  GT(IN1 := N, IN2 := 5, IN3 := 1, OUT) (Q);')).toEqual([expect.stringMatching(/some targets take exactly two/)])
  })

  it('takes no EN (nothing feeds it), carries a BOOL, and does not also write its result somewhere', () => {
    expect(errors(`${VARS}LADDER\n  EQ(EN, IN1 := N, IN2 := 3, OUT) (Q);\nEND_LADDER`)).toEqual([expect.stringMatching(/starts the rung by OUT, so nothing feeds it and it has no EN/)])
    expect(errors(`${VARS}LADDER\n  ADD(IN1 := N, IN2 := 3, OUT) (Q);\nEND_LADDER`)).toEqual([expect.stringMatching(/ADD's result is not a BOOL, so it cannot start a rung/)])
    expect(errors(`${VARS}LADDER\n  EQ(IN1 := N, IN2 := 3, OUT, OUT => A) (Q);\nEND_LADDER`)).toEqual([expect.stringMatching(/EQ's OUT carries the rung, so it cannot also be written to A/)])
  })
})

describe('diagnostics point at the rung, in ladder terms', () => {
  it('a contact on a number', () => {
    const src = `VAR Count : INT; Q : BOOL; END_VAR
LADDER
  |Count| (Q);
END_LADDER`
    const [d] = diagnostics(src)
    expect(d?.message).toBe("a contact examines a BOOL, and 'Count' is INT")
    expect(d?.pos).toMatchObject({ line: 3, col: 4 })
  })

  it('a coil on a number', () => {
    const src = `VAR A : BOOL; Level : REAL; END_VAR
LADDER
  |A| (Level);
END_LADDER`
    const [d] = diagnostics(src)
    expect(d?.message).toBe("a coil writes a BOOL, and 'Level' is REAL")
    expect(d?.pos).toMatchObject({ line: 3, col: 8 })
  })

  it('an unknown variable in a rung is named where it is written', () => {
    const src = `VAR A : BOOL; END_VAR
LADDER
  |A| |Mising| (A);
END_LADDER`
    const [d] = diagnostics(src)
    expect(d?.message).toMatch(/Mising/)
    expect(d?.pos).toMatchObject({ line: 3, col: 8 })
  })

  it('a rung that does not read is reported, and the rungs around it still run', () => {
    const src = `${BOOLS('A B C')}LADDER
  |A| (B);
  |A| (;
  |A| (C);
END_LADDER`
    expect(diagnostics(src).map((d) => d.pos.line)).toEqual([4])
    expect(() => compile(src)).toThrow()
  })

  it('a missing END_LADDER', () => {
    expect(diagnostics(`${BOOLS('A B')}LADDER\n  |A| (B);\n`)[0]?.message).toMatch(/END_LADDER/)
  })
})

describe('the word LADDER', () => {
  it('stays an ordinary variable name where a statement uses it', () => {
    const src = `VAR ladder : INT; copy : INT; END_VAR
ladder := 3;
copy := ladder;`
    expect(trace(src, [{}], ['ladder', 'copy'])).toEqual([{ ladder: 3, copy: 3 }])
  })
})

// (both backends, scan for scan: the ladder group of the conformance corpus)
describe('the ST the exporters write', () => {
  const PROGRAM = `VAR Start, Stop, Motor, Btn, Pulse, Late : BOOL; T1 : TON; Count : INT; END_VAR
LADDER
  [|Start|, |Motor|] |/Stop| (Motor);
  |Motor| |P Btn| ADD(IN1 := Count, IN2 := 1, OUT => Count) (Pulse);
  |Motor| T1(IN, PT := T#20ms) (Late);
END_LADDER`
  const STEPS: Record<string, TagValue>[] = [{ Start: true }, { Start: false, Btn: true }, { Btn: false }, { Btn: true }, { Stop: true }]

  it('the expanded ST runs exactly like the ladder it stands for', () => {
    const text = lowered(PROGRAM)
    expect(text).not.toMatch(/LADDER/)
    expect(text).toMatch(/VAR\n {2}LD_E1 : BOOL;\n {2}LD_M1 : BOOL;\nEND_VAR/)
    expect(trace(text, STEPS, ['Motor', 'Pulse', 'Late', 'Count'])).toEqual(trace(PROGRAM, STEPS, ['Motor', 'Pulse', 'Late', 'Count']))
  })

  it('is what both export targets carry, and the text export reads back as the same program', () => {
    const text = exportProgram(PROGRAM, 'iec-text')
    expect(text.content).not.toMatch(/LADDER|\|Start\|/)
    expect(text.content).toContain('Motor := (Start OR Motor) AND NOT Stop;')
    expect(text.warnings.join(' ')).toMatch(/goes out as the Structured Text it runs as/)
    expect(diagnostics(text.content)).toEqual([])
  })

  it('a POU that is one ladder section goes to PLCopen as an <LD> graph, without the temporaries its ST needs', () => {
    const xml = exportProgram(PROGRAM, 'plcopen-xml').content
    expect(xml).toContain('<LD>')
    expect(xml).not.toContain('<ST>')
    expect(xml).not.toMatch(/LD_M1|LD_E1/)
    expect(xml).toMatch(/<contact localId="\d+" negated="true" edge="none" storage="none"[^>]*>[\s\S]*?<variable>Stop<\/variable>/)
    expect(xml).toMatch(/<contact localId="\d+" negated="false" edge="rising"[\s\S]*?<variable>Btn<\/variable>/)
    expect(xml).toMatch(/<block localId="\d+" width="\d+" height="\d+" typeName="TON" instanceName="T1">/)
    expect(xml).toMatch(/<block localId="\d+" width="\d+" height="\d+" typeName="ADD">[\s\S]*?formalParameter="EN"[\s\S]*?formalParameter="ENO"/)
  })

  it('a POU whose ladder shares its body with ST goes out as that ST', () => {
    const mixed = `${PROGRAM}\nCount := Count + 0;`
    const xml = exportProgram(mixed, 'plcopen-xml').content
    expect(xml).not.toContain('<LD>')
    expect(xml).toContain('Motor := (Start OR Motor) AND NOT Stop;')
    expect(xml).toMatch(/<variable name="LD_M1">/)
  })

  it('keeps its temporaries out of what a scene can bind', () => {
    expect(compile(PROGRAM).bindable).not.toContain('LD_M1')
  })
})
