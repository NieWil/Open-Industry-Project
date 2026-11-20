// Cross Reference (crossRef.ts) for the IEC dialect's leaf, through IEC_REFS - a contact reads, a coil writes (every scan unless it
// latches or unlatches), a block's instance and input pins read, its output pins write.

import { describe, expect, it } from 'vitest'
import { crossReference, duplicateDestructive, type LadderRef } from './crossRef'
import { readLadder } from './ladder/ladderRungs'
import { IEC_REFS } from './ladder/ladderLeaves'

const SRC = `VAR Go, Belt1, Late, Held : BOOL; T1 : TON; n, m : INT; END_VAR
LADDER
  |Go| (Belt1);
  |Belt1| T1(IN, PT := T#2s, Q => Late);
  [|Belt1|, |/Go|] (S Held);
  |Late| (Belt1);
  |Go| (R Held);
  ADD(EN, IN1 := n + m, IN2 := 1, OUT => n);
END_LADDER
`
const routines = readLadder(SRC)

describe('cross reference, IEC', () => {
  it('lists every rung a tag is on, how each element touches it, and what the element is', () => {
    const refs = crossReference(SRC, 'Belt1', routines, IEC_REFS).filter((r) => r.kind === 'ladder')
    expect(refs.map((r) => (r.kind === 'ladder' ? [r.rung, r.mnemonic, r.access, r.destructive] : null))).toEqual([
      [0, '( )', 'write', true],
      [1, '| |', 'read', false],
      [2, '| |', 'read', false],
      [3, '( )', 'write', true],
    ])
  })

  it("a block's instance and input pins read, its output pins write; a pin's value is an expression", () => {
    const t1 = crossReference(SRC, 'T1', routines, IEC_REFS).filter((r) => r.kind === 'ladder')
    expect(t1).toEqual([{ kind: 'ladder', routine: 0, routineName: '', rung: 1, mnemonic: 'TON', access: 'read', destructive: false }])
    const late = crossReference(SRC, 'Late', routines, IEC_REFS).filter((r): r is LadderRef => r.kind === 'ladder').map((r) => `${r.rung} ${r.mnemonic} ${r.access}`)
    expect(late).toEqual(['1 TON write', '3 | | read'])
    // `n + m` names both; OUT => n writes n
    const n = crossReference(SRC, 'n', routines, IEC_REFS).map((r) => (r.kind === 'ladder' ? `${r.rung} ${r.mnemonic} ${r.access}` : `text ${r.line}`))
    expect(n).toEqual(['5 ADD read', '5 ADD write', 'text 1'])
    expect(crossReference(SRC, 'm', routines, IEC_REFS).filter((r) => r.kind === 'ladder')).toHaveLength(1)
  })

  it('two coils that write a bit every scan are a double coil; a latch and an unlatch are not', () => {
    expect(duplicateDestructive(routines, IEC_REFS)).toEqual([{ name: 'Belt1', at: [{ routine: 0, rung: 0 }, { routine: 0, rung: 3 }] }])
  })
})
