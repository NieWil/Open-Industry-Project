// The ladder catalogue (ladderCatalog.ts) against the engine: every entry, inserted the way the view's Insert Box
// does it, with each of its blanks named, has to compile, run, and go out through PLCopen <LD> and back running the
// same. That is what keeps a list of "what a box can be" from drifting from what a box lowers to, as a hand-kept
// list would.

import { describe, expect, it } from 'vitest'
import { builtinResultType, BUILTIN_FUNCTIONS } from '../builtins'
import { OPERATOR_FUNCTIONS } from './ladder'
import { toPlcopenXml } from '../exchange/export'
import { importPlcopenXml } from '../exchange/importXml'
import { compile } from '../interpreter'
import { CATALOG_GROUPS, catalogSignature, insertCatalogEntry, ladderCatalog, unsummarised, type CatalogEntry } from './ladderCatalog'
import { connectPin, setField } from './ladderLeaves'
import { declareInstance, readLadder, writeLadder, type RungItem } from './ladderRungs'
import { SCALAR_TYPES, type ScalarType } from '../types'

const OWN = `FUNCTION_BLOCK Mover
VAR_INPUT Enable : BOOL; Speed : INT; END_VAR
VAR_OUTPUT Done : BOOL; Pos : INT; END_VAR
Pos := Pos + Speed;
Done := Enable AND Pos > 3;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Tally
VAR_INPUT N : INT; END_VAR
VAR_OUTPUT Total : INT; END_VAR
Total := Total + N;
END_FUNCTION_BLOCK

FUNCTION InRange : BOOL
VAR_INPUT X, Lo, Hi : INT; END_VAR
InRange := X >= Lo AND X <= Hi;
END_FUNCTION

FUNCTION Twice : INT
VAR_INPUT X : INT; END_VAR
Twice := X * 2;
END_FUNCTION
`

const PROGRAM = `${OWN}
VAR Go : BOOL := TRUE; Q : BOOL; END_VAR
LADDER
  |Go| (Q);
END_LADDER
`

/** A value of each type to start a variable at: not zero, so a DIV or a LN has something to work on. */
const START: Record<ScalarType, string> = {
  BOOL: 'TRUE', SINT: '3', INT: '3', DINT: '3', USINT: '3', UINT: '3', UDINT: '3', BYTE: '3', WORD: '3', DWORD: '3',
  REAL: '0.5', LREAL: '0.5', TIME: 'T#3s', DATE: 'D#2020-01-02', TOD: 'TOD#01:02:03', DT: 'DT#2020-01-02-01:02:03', STRING: "'abc'",
}

/** The types to try an operand at, commonest first, so the search below ends early. */
const TRY: readonly ScalarType[] = ['INT', 'BOOL', 'REAL', 'STRING', 'TIME', 'WORD', ...SCALAR_TYPES.filter((t) => !['INT', 'BOOL', 'REAL', 'STRING', 'TIME', 'WORD'].includes(t))]

/** Operand types a standard function accepts, and what it returns: found by asking the checker's own rule. A function
 *  ST spells as an operator has no entry there, so it is asked of the checker by compiling the operator, on operands of
 *  one type (which is what AND, OR, XOR, NOT and MOD take, and give back). */
function operandTypes(name: string, arity: number): { args: ScalarType[]; ret: ScalarType } | null {
  const op = OPERATOR_FUNCTIONS[name]
  if (op) {
    for (const t of TRY) {
      const expr = op.unary ? `${name} a` : Array.from({ length: arity }, (_, i) => `a${i}`).join(` ${name} `)
      const vars = op.unary ? 'a' : Array.from({ length: arity }, (_, i) => `a${i}`).join(', ')
      try {
        compile(`VAR ${vars}, r : ${t}; END_VAR
r := ${expr};
`)
        return { args: Array.from({ length: arity }, () => t), ret: t }
      } catch {
        // not this type
      }
    }
    return null
  }
  const pos = { line: 1, col: 1, offset: 0 }
  const tuple: ScalarType[] = []
  const search = (i: number): ScalarType | null => {
    if (i === arity) {
      try {
        return builtinResultType(name, tuple, pos)
      } catch {
        return null
      }
    }
    for (const t of TRY) {
      tuple[i] = t
      const r = search(i + 1)
      if (r) return r
    }
    return null
  }
  const ret = search(0)
  return ret ? { args: [...tuple], ret } : null
}

/** Each blank pin of the inserted box, with the type to name it with. */
function pinTypes(e: CatalogEntry, box: Extract<RungItem, { type: 'box' }>): Map<string, string> | null {
  const typed = new Map<string, string>()
  if (e.own || e.kind === 'block') {
    for (const p of [...e.inputs, ...e.outputs]) typed.set(p.name.toUpperCase(), p.type)
    return typed
  }
  const ins = box.pins.filter((p) => !p.out && p.value !== null)
  const found = operandTypes(e.name, ins.length)
  if (!found) return null
  ins.forEach((p, i) => typed.set(p.name.toUpperCase(), found.args[i]!))
  typed.set('OUT', found.ret)
  return typed
}

/** `e` inserted into PROGRAM's rung and every blank named by a variable of its type: the program, and what to watch. */
function filled(e: CatalogEntry): { src: string; watch: string[] } {
  const made = insertCatalogEntry(PROGRAM, 0, { rung: 0, trail: [0] }, e)
  if (!made) throw new Error(`${e.name}: did not insert`)
  let src = made.source
  const r = readLadder(src)[0]!
  const at = made.sel!
  const box = r.rungs[at.rung]!.elements.find((el): el is Extract<RungItem, { type: 'box' }> => el.type === 'box')
  if (!box) throw new Error(`${e.name}: no box on the rung\n${src}`)
  const types = pinTypes(e, box)
  if (!types) throw new Error(`${e.name}: no operand types the checker accepts`)
  let rungs = r.rungs
  const watch = ['Q']
  box.pins
    .filter((p) => p.value !== null)
    .forEach((p, i) => {
      const type = types.get(p.name.toUpperCase())
      if (!type) throw new Error(`${e.name}: no type for pin ${p.name}`)
      const v = `v_${p.name}`
      src = declareInstance(src, 0, v, p.out ? type : `${type} := ${START[type as ScalarType] ?? '0'}`)
      if (p.out) watch.push(v)
      rungs = setField(rungs, at, i + 1, v)
    })
  return { src: writeLadder(src, 0, rungs), watch }
}

function run(src: string, watch: readonly string[]): unknown[] {
  const p = compile(src)
  const out: unknown[] = []
  for (let i = 0; i < 3; i++) {
    p.scan(0.1)
    out.push(watch.map((w) => p.get(w)))
  }
  return out
}

describe('the ladder catalogue', () => {
  it('gives every standard function a group and a summary, or it is not offered', () => {
    expect(unsummarised()).toEqual([])
  })

  it("lists the program's own blocks and functions first, and not the POU being edited", () => {
    const names = ladderCatalog(PROGRAM).map((e) => e.name)
    expect(names.slice(0, 4)).toEqual(['Mover', 'Tally', 'InRange', 'Twice'])
    expect(ladderCatalog(PROGRAM, 'Mover').some((e) => e.name === 'Mover')).toBe(false)
    const groups = ladderCatalog(PROGRAM).map((e) => CATALOG_GROUPS.indexOf(e.group))
    expect(groups).toEqual([...groups].sort((a, b) => a - b))
  })

  it('offers every IEC standard function the engine has', () => {
    const offered = new Set(ladderCatalog('').map((e) => e.name))
    for (const n of Object.keys(OPERATOR_FUNCTIONS)) expect(offered.has(n), n).toBe(true)
    const missing = BUILTIN_FUNCTIONS.filter((n) => n !== 'MULTIME' && n !== 'DIVTIME' && !offered.has(n))
    expect(missing).toEqual([])
  })

  it("draws a program's own block with every pin, and on the rung by EN / ENO when it has no BOOL pair", () => {
    const cat = ladderCatalog(PROGRAM)
    const mover = cat.find((e) => e.name === 'Mover')!
    expect(catalogSignature(mover)).toBe('(Enable, Speed) -> Done, Pos')
    const one = insertCatalogEntry(PROGRAM, 0, { rung: 0, trail: [0] }, mover)!
    expect(one.source).toContain('Mover_1 : Mover;')
    expect(one.source).toContain('|Go| Mover_1(Enable, Speed := ?, Pos => ?) (Q);')
    const tally = insertCatalogEntry(PROGRAM, 0, { rung: 0, trail: [0] }, cat.find((e) => e.name === 'Tally')!)!
    expect(tally.source).toContain('|Go| Tally_1(EN, N := ?, Total => ?) (Q);')
    const cond = insertCatalogEntry(PROGRAM, 0, { rung: 0, trail: [1] }, cat.find((e) => e.name === 'InRange')!)!
    expect(cond.source).toContain('InRange(X := ?, Lo := ?, Hi := ?, OUT) |Go| (Q);')
  })

  it("drops a block's pin that is cleared, where a function's goes back to a blank", () => {
    const src = `${OWN}VAR Go, Q : BOOL; M : Mover; END_VAR\nLADDER\n  |Go| M(Enable, Speed := ?, Pos => ?) ADD(IN1 := 1, IN2 := 2, OUT => ?) (Q);\nEND_LADDER\n`
    const r = readLadder(src)[0]!
    let rungs = setField(r.rungs, { rung: 0, trail: [1] }, 2, '')
    rungs = setField(rungs, { rung: 0, trail: [2] }, 3, ' ')
    expect(writeLadder(src, 0, rungs)).toContain('|Go| M(Enable, Speed := ?) ADD(IN1 := 1, IN2 := 2, OUT => ?) (Q);')
  })

  // The tripwire. ~300 entries (most of them conversions), each compiled, run and round-tripped twice.
  it('inserts every entry, named, as a program that compiles, runs, and comes back from PLCopen <LD> running the same', { timeout: 120_000 }, () => {
    const failures: string[] = []
    const all = ladderCatalog(PROGRAM)
    expect(all.length).toBeGreaterThan(250)
    // the box really runs: not a program that compiles because the rung was dropped
    const twice = filled(all.find((e) => e.name === 'Twice')!)
    expect(twice.src).toContain('|Go| Twice(X := v_X, OUT => v_OUT) (Q);')
    expect(run(twice.src, twice.watch).at(-1)).toEqual([true, 6])
    const mover = filled(all.find((e) => e.name === 'Mover')!)
    expect(run(mover.src, mover.watch)).toEqual([[false, 3], [true, 6], [true, 9]])
    for (const e of all) {
      try {
        const { src, watch } = filled(e)
        const here = run(src, watch)
        const back = importPlcopenXml(toPlcopenXml(src))
        if (back.notes.length > 0) throw new Error(`PLCopen import notes: ${back.notes.join('; ')}`)
        expect(run(back.source, watch), `${e.name}: through PLCopen\n${back.source}`).toEqual(here)
      } catch (err) {
        failures.push(`${e.name}: ${(err as Error).message.split('\n')[0]}`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe('a block inserted with every pin blank', () => {
  it('is drawn with its type and its outputs, though its rung cannot run yet', () => {
    const mover = ladderCatalog(PROGRAM).find((e) => e.name === 'Mover')!
    const made = insertCatalogEntry(PROGRAM, 0, { rung: 0, trail: [0] }, mover)!
    const r = readLadder(made.source)[0]!
    expect(r.rungProblems[0]!.map((d) => d.message).join()).toMatch(/the \? on this rung/)
    const box = r.rungs[0]!.elements[1]!
    expect(box).toMatchObject({ type: 'box', resolved: { type: 'Mover', input: 'Enable', output: 'Done', outputs: ['Done', 'Pos'] } })
  })
})

describe('the functions ST spells as operators, as boxes', () => {
  const SRC = `VAR Go : BOOL := TRUE; A : BOOL := TRUE; B : BOOL; N : INT := 17; W : WORD := 16#00F0;
  And3, Or2, Xor2, Inv : BOOL; Rem : INT; Bits : WORD; Q : BOOL; END_VAR
LADDER
  |Go| AND(IN1 := A, IN2 := TRUE, IN3 := Go, OUT => And3) OR(IN1 := A, IN2 := B, OUT => Or2) (Q);
  |Go| XOR(IN1 := A, IN2 := B, OUT => Xor2) NOT(IN := A, OUT => Inv);
  |Go| MOD(IN1 := N, IN2 := 5, OUT => Rem) NOT(IN := W, OUT => Bits);
END_LADDER
`
  it('compute what the operators do, and lower to them', () => {
    const p = compile(SRC)
    p.scan(0.1)
    expect([p.get('And3'), p.get('Or2'), p.get('Xor2'), p.get('Inv'), p.get('Rem'), p.get('Bits'), p.get('Q')]).toEqual([true, true, true, false, 2, 0xff0f, true])
  })

  it('go out through PLCopen as <block>s and come back the same', () => {
    const xml = toPlcopenXml(SRC)
    for (const t of ['AND', 'OR', 'XOR', 'NOT', 'MOD']) expect(xml).toContain(`typeName="${t}"`)
    const back = importPlcopenXml(xml)
    expect(back.notes).toEqual([])
    expect(back.source).toContain('MOD(IN1 := N, IN2 := 5, OUT => Rem)')
    const p = compile(back.source)
    p.scan(0.1)
    expect([p.get('And3'), p.get('Rem'), p.get('Bits')]).toEqual([true, 2, 0xff0f])
  })

  it('reads `&` as nothing of the kind: only the word names the box', () => {
    expect(readLadder('VAR a, b : BOOL; END_VAR\nLADDER\n  &(IN1 := a, IN2 := b, OUT => a);\nEND_LADDER\n')[0]?.unreadable.length ?? 1).toBeGreaterThan(0)
  })
})

describe('connecting a block pin from its box', () => {
  const SRC = `VAR Go, Q : BOOL; T1 : TON; Elapsed : TIME; END_VAR
LADDER
  |Go| T1(IN, PT := T#2s) (Q);
END_LADDER
`
  it('draws every pin the block declares, written or not', () => {
    const box = readLadder(SRC)[0]!.rungs[0]!.elements[1]!
    expect(box).toMatchObject({ resolved: { inputs: ['IN', 'PT'], outputs: ['Q', 'ET'] } })
  })

  it('writes an output last and an input after the inputs, blank, and says which field to name it in', () => {
    const r = readLadder(SRC)[0]!
    const at = { rung: 0, trail: [1] }
    const et = connectPin(r.rungs, at, 'ET', true)!
    expect(et.field).toBe(2)
    expect(writeLadder(SRC, 0, et.rungs)).toContain('|Go| T1(IN, PT := T#2s, ET => ?) (Q);')
    const named = setField(et.rungs, at, et.field, 'Elapsed')
    expect(writeLadder(SRC, 0, named)).toContain('T1(IN, PT := T#2s, ET => Elapsed)')
    const c = `VAR Go : BOOL; C1 : CTU; N : INT; END_VAR\nLADDER\n  |Go| C1(CU, PV := 3, CV => N);\nEND_LADDER\n`
    const rc = readLadder(c)[0]!
    const reset = connectPin(rc.rungs, at, 'R', false)!
    expect(writeLadder(c, 0, reset.rungs)).toContain('C1(CU, PV := 3, R := ?, CV => N)')
    expect(reset.field).toBe(2)
    // a pin already written is not connected twice
    expect(connectPin(r.rungs, at, 'PT', false)).toBeNull()
  })
})
