import { describe, expect, it } from 'vitest'
import { BIT_TYPES, completeName, elementType, NUMERIC_TYPES, rankByWanted } from './ladderComplete'
import { fieldWants, iecTypes, typeAt } from './ladderLeaves'
import type { RungItem } from './ladderRungs'
import { listTags } from '../tags'
import { listUdts } from '../udt'

// The shared rung core's type-ahead (ladderComplete.ts) as the IEC ladder view drives it: what a field takes, from the
// program's own declarations (ladderLeaves.ts), and the names offered in that order.

const PROGRAM = `TYPE Drive :
STRUCT
  Run : BOOL;
  Speed : INT;
END_STRUCT;
END_TYPE

FUNCTION_BLOCK Station
VAR_INPUT
  Start : BOOL;
END_VAR
VAR_OUTPUT
  Busy : BOOL;
  Count : INT;
END_VAR
VAR
  Hidden : BOOL;
END_VAR
Busy := Start;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  Bench : INT;
  Belt1 : BOOL;
  Conv : Drive;
  T1 : TON;
  Delay : TIME;
  S1 : Station;
  Lines : ARRAY [1..2] OF Drive;
END_VAR
Belt1 := TRUE;
END_PROGRAM
`

const types = iecTypes(listTags(PROGRAM), listUdts(PROGRAM), 'Main')
const memberTypes = (t: string): string[] => types.members(t).map((m) => m.type)
const namesOf = (t: string): string[] => types.members(t).map((m) => m.name)

describe('completeName: the ending proposed after the caret', () => {
  const names = ['Bench', 'Belt1', 'Conv']
  const members = (base: string): string[] => (base.toUpperCase() === 'CONV' ? ['Run', 'Speed'] : [])

  it('the first name that continues what was typed, in the order given', () => {
    expect(completeName('Be', names, members)).toBe('Bench')
    expect(completeName('Bel', names, members)).toBe('Belt1')
    expect(completeName('be', names, members)).toBe('bench') // the case typed stays; commit corrects it
  })

  it("after a dot, the members of what stands before it - and an empty partial is enough there", () => {
    expect(completeName('Conv.', names, members)).toBe('Conv.Run')
    expect(completeName('Conv.S', names, members)).toBe('Conv.Speed')
  })

  it('a literal is not a name: nothing is completed inside a time, a based number or an exponent', () => {
    const lit = ['Start', 'Fault', 'east']
    expect(completeName('T#2s', lit, members)).toBeNull()
    expect(completeName('PT := T#2s', lit, members)).toBeNull()
    expect(completeName('16#F', lit, members)).toBeNull()
    expect(completeName('2e', lit, members)).toBeNull()
    expect(completeName('Level + St', lit, members)).toBe('Level + Start') // a name after an operator still is one
  })

  it('knows nothing of any dialect: `S:` is only a name that does not continue', () => {
    expect(completeName('S:', ['S1'], members)).toBeNull()
  })
})

describe("elementType: what a declared type holds", () => {
  it('an array its element, a string its family, anything else itself (upper case)', () => {
    expect(elementType('ARRAY [1..2] OF Drive')).toBe('DRIVE')
    expect(elementType('STRING[20]')).toBe('STRING')
    expect(elementType('dint')).toBe('DINT')
  })
})

describe("IEC's types for type-ahead (ladderLeaves.ts)", () => {
  it("a name's declared type, in the POU that sees it", () => {
    expect(types.typeOf('belt1')).toBe('BOOL')
    expect(types.typeOf('Conv')).toBe('Drive')
    expect(types.typeOf('Hidden')).toBeUndefined() // Station's own, not Main's
  })

  it("a structure's members, a standard block's pins, a FUNCTION_BLOCK's inputs and outputs (not its locals)", () => {
    expect(namesOf('Drive')).toEqual(['Run', 'Speed'])
    expect(namesOf('TON')).toEqual(['IN', 'PT', 'Q', 'ET'])
    expect(types.members('TON').find((m) => m.name === 'PT')?.type).toBe('TIME')
    expect(namesOf('Station')).toEqual(['Start', 'Busy', 'Count'])
    expect(namesOf('BOOL')).toEqual([])
  })

  it('a path walked member by member, through an array element', () => {
    expect(typeAt('Conv.Speed', types)).toBe('INT')
    expect(typeAt('Lines[1].Run', types)).toBe('BOOL')
    expect(typeAt('S1.Count', types)).toBe('INT')
    expect(typeAt('T1.ET', types)).toBe('TIME')
    expect(typeAt('Nobody.Run', types)).toBeUndefined()
    expect(typeAt('Conv.Nothing.Run', types)).toBeUndefined()
  })
})

describe('what a field takes (fieldWants), and the order that gives', () => {
  const contact: RungItem = { type: 'contact', mode: 'open', operand: '?' }
  const coil: RungItem = { type: 'coil', mode: 'normal', operand: '?' }
  const timer: RungItem = {
    type: 'box',
    head: 'T1',
    func: false,
    pins: [
      { name: 'IN', value: null, out: false },
      { name: 'PT', value: 'Delay', out: false },
      { name: 'Q', value: null, out: true },
      { name: 'ET', value: 'Bench', out: true },
    ],
    resolved: { type: 'TON', input: 'IN', output: 'Q' },
  }
  const add: RungItem = { type: 'box', head: 'ADD', func: true, pins: [{ name: 'IN1', value: 'Bench', out: false }], resolved: { type: 'ADD', input: null, output: 'OUT' } }

  it('a contact and a coil a BOOL; a block instance its own type; a pin its declared type, any number for a number', () => {
    expect(fieldWants(contact, 0, types)).toBe(BIT_TYPES)
    expect(fieldWants(coil, 0, types)).toBe(BIT_TYPES)
    expect([...fieldWants(timer, 0, types)!]).toEqual(['TON'])
    expect([...fieldWants(timer, 1, types)!]).toEqual(['TIME']) // PT
    expect([...fieldWants(timer, 2, types)!]).toEqual(['TIME']) // ET: field 2 is the second pin WITH a value
    const counter: RungItem = { type: 'box', head: 'C1', func: false, pins: [{ name: 'PV', value: 'Bench', out: false }], resolved: { type: 'CTU', input: 'CU', output: 'Q' } }
    expect(fieldWants(counter, 1, types)).toBe(NUMERIC_TYPES) // PV is an INT: any number
  })

  it("nothing said for a function's name or its pins (the call decides their types)", () => {
    expect(fieldWants(add, 0, types)).toBeNull()
    expect(fieldWants(add, 1, types)).toBeNull()
  })

  it('a contact is offered the BOOLs first, then structures that hold one, then the rest', () => {
    const ranked = rankByWanted(['Bench', 'Belt1', 'Conv', 'Delay'], BIT_TYPES, types.typeOf, memberTypes)
    expect(ranked).toEqual(['Belt1', 'Conv', 'Bench', 'Delay'])
    expect(completeName('Be', ranked, () => [])).toBe('Belt1') // not Bench, first alphabetically
  })

  it("a TON's PT is offered the TIMEs first", () => {
    const ranked = rankByWanted(['Bench', 'Belt1', 'Delay'], fieldWants(timer, 1, types), types.typeOf, memberTypes)
    expect(ranked[0]).toBe('Delay')
  })
})
