import { describe, expect, it } from 'vitest'
import { parseDocument } from '../../plc'
import { ladderMarks, NO_LADDER } from './ladderMarks'
import { blockLabel, organizerGroups, typeNamesOf, type OrganizerFacts } from './plcOrganizer'

const SRC = `TYPE
  Mode : (Idle, Run);
  Recipe : STRUCT a : INT; b : REAL; END_STRUCT;
END_TYPE

VAR_GLOBAL
  Shared : INT;
END_VAR

FUNCTION_BLOCK Truck
VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT busy : BOOL; END_VAR
busy := go;
END_FUNCTION_BLOCK

FUNCTION Twice : INT
VAR_INPUT x : INT; END_VAR
Twice := x * 2;
END_FUNCTION

PROGRAM Palletizer
VAR Start : BOOL; Run : BOOL; END_VAR
LADDER
  |Start| (Run);
END_LADDER
END_PROGRAM

PROGRAM Spare
VAR x : BOOL; END_VAR
x := TRUE;
END_PROGRAM

VAR_INPUT Sensor : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
`

const blocks = parseDocument(SRC).blocks
const facts = (over: Partial<OrganizerFacts> = {}): OrganizerFacts => ({
  marks: ladderMarks(SRC, blocks),
  bodyRuns: false,
  typeNames: typeNamesOf(blocks),
  scheduled: null,
  ...over,
})

describe('the organizer tree', () => {
  it('sorts the blocks into the IEC groups, each in the order the code declares it', () => {
    const g = organizerGroups(blocks, facts())
    expect(g.top?.label).toBe('Main')
    expect(g.programs.map((r) => r.label)).toEqual(['Palletizer', 'Spare'])
    expect(g.functionBlocks.map((r) => r.label)).toEqual(['Truck'])
    expect(g.functions.map((r) => r.label)).toEqual(['Twice'])
    expect(g.globals.map((r) => r.label)).toEqual(['Globals'])
    expect(g.configuration).toBeNull()
    // every row keeps its block index, which is what the block edits take
    for (const r of [...g.programs, ...g.functionBlocks, ...g.functions, ...g.dataTypes, ...g.globals]) expect(blocks[r.index]!.kind).toBe(r.kind)
  })

  it('names a TYPE block by the types it declares, in the order written', () => {
    expect(organizerGroups(blocks, facts()).dataTypes.map((r) => r.label)).toEqual(['Mode, Recipe'])
  })

  it('falls back to a numbered kind word for a TYPE block that does not parse yet', () => {
    const src = `TYPE\n  A : INT;\nEND_TYPE\n\nTYPE\n  B : STRUCT x : INT;\nEND_TYPE\n\nVAR_OUTPUT m : BOOL; END_VAR\n`
    const bs = parseDocument(src).blocks
    const names = typeNamesOf(bs)
    const labels = bs.map((b, i) => blockLabel(b, i, bs, names.get(i))).filter((_, i) => bs[i]!.kind === 'type')
    expect(labels).toEqual(['A', 'Types 2'])
  })

  it('marks each POU with its language: ladder when its whole body is one, else Structured Text', () => {
    const g = organizerGroups(blocks, facts())
    expect(g.programs.map((r) => r.language)).toEqual(['LD', 'ST'])
    expect(g.functionBlocks[0]!.language).toBe('ST')
    expect(g.dataTypes[0]!.language).toBeNull()
    expect(organizerGroups(blocks, facts({ marks: NO_LADDER })).programs[0]!.language).toBe('ST')
  })

  it('calls the top-level code Main, statements or not', () => {
    expect(organizerGroups(blocks, facts({ bodyRuns: true })).top?.label).toBe('Main')
    expect(organizerGroups(blocks, facts({ bodyRuns: false })).top?.label).toBe('Main')
  })

  it('marks a PROGRAM the stored table does not run, and marks nothing without a stored table', () => {
    expect(organizerGroups(blocks, facts({ scheduled: new Set(['PALLETIZER']) })).programs.map((r) => r.unscheduled)).toEqual([false, true])
    expect(organizerGroups(blocks, facts()).programs.every((r) => !r.unscheduled)).toBe(true)
  })

  it('lists a CONFIGURATION the code declares on its own', () => {
    const src = `PROGRAM P\nVAR x : BOOL; END_VAR\nx := TRUE;\nEND_PROGRAM\n\nCONFIGURATION C\n  RESOURCE R ON PLC\n    TASK T(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM I WITH T : P;\n  END_RESOURCE\nEND_CONFIGURATION\n`
    const bs = parseDocument(src).blocks
    const g = organizerGroups(bs, { marks: NO_LADDER, bodyRuns: false, typeNames: new Map(), scheduled: null })
    expect(g.configuration?.label).toBe('C')
    expect(g.programs.map((r) => r.label)).toEqual(['P'])
  })
})
