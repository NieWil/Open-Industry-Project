import { describe, expect, it } from 'vitest'
import { eipVariableGroups } from './eip'
import { opcUaVariableGroups } from './opcUa'
import { groupVariables, variableFits } from './plcVariables'

describe("a PLC's variables as the PLC connections window lists them", () => {
  it('fits a bit to a BOOL field and a number to a numeric one, and anything where a side has no type', () => {
    expect(variableFits({ kind: 'bool' }, 'BOOL')).toBe(true)
    expect(variableFits({ kind: 'bool' }, 'REAL')).toBe(false)
    expect(variableFits({ kind: 'number' }, 'DINT')).toBe(true)
    expect(variableFits({ kind: 'number' }, 'BOOL')).toBe(false)
    expect(variableFits({ kind: 'number' }, null)).toBe(true)
    expect(variableFits({ kind: null }, 'BOOL')).toBe(true)
  })

  it('groups by rank, then name, each group by short name', () => {
    const v = (name: string) => ({ name, short: name.split('.').pop()!, typeName: 'BOOL', kind: 'bool' as const })
    const groups = groupVariables([v('B.z'), v('A.y'), v('B.a'), v('top')], (x) => (x.name.includes('.') ? x.name.split('.')[0]! : ''), (g) => (g === 'B' ? 0 : 1))
    expect(groups.map((g) => [g.name, g.variables.map((x) => x.short)])).toEqual([
      ['B', ['a', 'z']],
      ['', ['top']],
      ['A', ['y']],
    ])
  })

  it("lists a Logix controller's own tags first, then each program's, with their types", () => {
    const groups = eipVariableGroups([
      { name: 'Program:MainProgram.Eye', type: 0xc1 },
      { name: 'Speed', type: 0xca },
      { name: 'Recipe', type: 0x8f21 },
      { name: 'Program:MainProgram.Count', type: 0xc4 },
    ])
    expect(groups).toEqual([
      { name: '', variables: [{ name: 'Speed', short: 'Speed', typeName: 'REAL', kind: 'number' }] },
      {
        name: 'Program:MainProgram',
        variables: [
          { name: 'Program:MainProgram.Count', short: 'Count', typeName: 'DINT', kind: 'number' },
          { name: 'Program:MainProgram.Eye', short: 'Eye', typeName: 'BOOL', kind: 'bool' },
        ],
      },
    ])
  })

  it('lists an OPC UA browse by the folder each variable sits in, with no types, under the names the tag picker offers', () => {
    const groups = opcUaVariableGroups([
      { path: ['PLC', 'Main', 'Eye'], nodeId: 'ns=4;s=a' },
      { path: ['PLC', 'Line2', 'Eye'], nodeId: 'ns=4;s=b' },
      { path: ['PLC', 'Main', 'Run'], nodeId: 'ns=4;s=c' },
    ])
    expect(groups).toEqual([
      { name: 'PLC/Line2', variables: [{ name: 'Line2.Eye', short: 'Eye', typeName: '', kind: null }] },
      {
        name: 'PLC/Main',
        variables: [
          { name: 'Main.Eye', short: 'Eye', typeName: '', kind: null },
          { name: 'Run', short: 'Run', typeName: '', kind: null },
        ],
      },
    ])
  })
})
