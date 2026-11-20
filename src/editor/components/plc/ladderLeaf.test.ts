import { describe, expect, it } from 'vitest'
import { elementAt, isBranch, type RungElementOf } from '../../../plc/ladder/ladderEdit'
import { LADDER, type BoxShape, type SymbolShape, type ValueOf } from './ladderLeaf'
import type { TagValue } from '../../../plc/types'

// IEC ladder as the ladder sheet draws it (ladderLeaf.tsx): each leaf as one of the sheet's three shapes, power
// through it from a live image, and a field written back into the program's text. What only a browser can prove is in
// e2e/verify-ladder-view*.mjs.

const leaves = <L>(els: readonly RungElementOf<L>[]): L[] => els.flatMap((el) => (isBranch(el) ? el.paths.flatMap((p) => leaves(p)) : [el as L]))
const image = (values: Record<string, TagValue>): ValueOf => (text) => values[text.trim()]

describe('the ladder leaf', () => {
  const SRC = `VAR
  Go, Stop, Lamp : BOOL;
  T1 : TON;
  N : INT;
END_VAR
LADDER
  |Go| |/Stop| (Lamp);
  |Lamp| T1(IN, PT := T#2s) (Stop);
  GT(IN1 := N, IN2 := 3, OUT) (S Lamp);
  |Go| T1(IN, PT := T#2s, Q => Lamp);
END_LADDER
`
  const [r] = LADDER.read(SRC, [])
  const rung = (i: number) => leaves(r!.rungs[i]!.elements)

  it("type-ahead offers what the POU can see: not a name declared only inside another POU", () => {
    const two = `FUNCTION_BLOCK Mover
VAR_INPUT Enable : BOOL; END_VAR
VAR_OUTPUT Pos : INT; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL Plant : BOOL; END_VAR
PROGRAM Main
VAR Go, Q : BOOL; Here : INT; M : Mover; END_VAR
LADDER
  |Go| (Q);
END_LADDER
END_PROGRAM
`
    const [main] = LADDER.read(two, [])
    const el = elementAt(main!.rungs, { rung: 0, trail: [0] })!
    const names = LADDER.typeAhead(two, main!, el as never, 0, [...LADDER.declaredNames(two), 'SceneTag']).names
    expect(names).not.toContain('Pos')
    expect(names).not.toContain('Enable')
    for (const n of ['Go', 'Q', 'Here', 'M', 'Plant', 'SceneTag']) expect(names, n).toContain(n)
  })

  it('contacts and coils are symbols: the tag, the slash, the letter, what lights them', () => {
    const [go, stop, lamp] = rung(0).map((el) => LADDER.shape(el) as SymbolShape)
    expect([go!.kind, go!.tag, go!.slash]).toEqual(['contact', 'Go', false])
    expect([stop!.slash, stop!.lit]).toEqual([true, { text: 'Stop', when: false }])
    expect([lamp!.kind, lamp!.mark]).toEqual(['coil', ''])
    expect((LADDER.shape(rung(2)[1]!) as SymbolShape).mark).toBe('S')
  })

  it('a block is a box: its instance a field, its pins rows, its other outputs shown live', () => {
    const box = LADDER.shape(rung(1)[1]!) as BoxShape
    expect([box.kind, box.title, box.instance]).toEqual(['box', 'TON', { field: 0, text: 'T1' }])
    const pt = box.rows.find((row) => row.name === 'PT')!
    expect([pt.field, pt.text, pt.watch]).toEqual([1, 'T#2s', 'T#2s'])
    expect(box.rows.find((row) => row.name === 'ET')?.watch).toBe('T1.ET')
  })

  it('a written pin the rung also leaves by is drawn once: its variable, and the rung exit', () => {
    const box = LADDER.shape(rung(3)[1]!) as BoxShape
    const q = box.rows.filter((row) => row.name === 'Q')
    expect(q.map((row) => [row.text, row.rung, row.out, row.field >= 0])).toEqual([['Lamp', true, true, true]])
    expect(new Set(box.rows.map((row) => row.key)).size).toBe(box.rows.length)
  })

  it('a comparison starts the rung, lit by what it returned', () => {
    const gt = LADDER.shape(rung(2)[0]!) as BoxShape
    expect(gt.starts).toBe(true)
  })

  it('power flows through contacts from the image, and stops at an open one', () => {
    const [go, stop] = rung(0)
    const v = image({ Go: true, Stop: false })
    expect(LADDER.powerOut(go!, true, v)).toBe(true)
    expect(LADDER.powerOut(stop!, true, v)).toBe(true)
    expect(LADDER.powerOut(go!, true, image({ Go: false }))).toBe(false)
    expect(LADDER.powerOut(go!, null, v)).toBeNull()
  })

  it('a field written: the program text changes there, and text the language cannot read is refused', () => {
    const at = { rung: 0, trail: [0] }
    const wrote = LADDER.writeField(SRC, 0, at, 0, 'Stop')
    expect('source' in wrote && wrote.source.includes('|Stop| |/Stop| (Lamp);')).toBe(true)
    expect('error' in LADDER.writeField(SRC, 0, at, 0, 'a b c')).toBe(true)
  })

  it('a block from the bar comes declared, and asks for its first value', () => {
    const made = LADDER.insert(SRC, 0, { rung: 0, trail: [0] }, 'TON')!
    expect(made.source).toMatch(/TON_1 : TON;/)
    expect(made.field).toBe(1)
  })
})
