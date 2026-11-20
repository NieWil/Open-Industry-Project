// Assign I/O / Import I/O list, program side: which tags get an address, and what the text looks like after.
// The rewrite has to leave a program that still compiles and still means the same thing, so most of these
// check the result through the compiler rather than by eye.

import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { compile } from './interpreter'
import { locateTags, parseIoList, planIoAssignment, planIoImport, type IoTagUse, type IoTarget } from './ioAssign'
import { locatedVariables } from './locatedIndex'

const EYE: IoTagUse = { name: 'Eye', dir: 'out', stType: 'BOOL' }
const RUN: IoTagUse = { name: 'Run', dir: 'in', stType: 'BOOL' }

const CONVEYOR = `VAR
  Eye : BOOL;
  Run : BOOL;
END_VAR
Run := NOT Eye;`

/** The plan applied: the program after, and the addresses it declares. */
function assign(source: string, uses: IoTagUse[], addresses: string[] = []): { source: string; plan: ReturnType<typeof planIoAssignment> } {
  const plan = planIoAssignment(source, uses, addresses)
  return { source: locateTags(source, plan.assignments), plan }
}

describe('planIoAssignment: which address a tag gets', () => {
  it('gives a published bit an input address and a driven one an output address', () => {
    const { plan } = assign(CONVEYOR, [EYE, RUN])
    expect(plan.assignments).toEqual([
      { name: 'Eye', address: '%IX0.0', type: 'BOOL' },
      { name: 'Run', address: '%QX0.0', type: 'BOOL' },
    ])
    expect(plan.skipped).toEqual([])
  })

  it("starts where OpenPLC's Editor maps a remote device's first point, and counts bits on from there", () => {
    const uses = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((name): IoTagUse => ({ name, dir: 'out', stType: 'BOOL' }))
    const { plan } = assign('', uses)
    expect(plan.assignments.map((a) => a.address)).toEqual([
      '%IX0.0',
      '%IX0.1',
      '%IX0.2',
      '%IX0.3',
      '%IX0.4',
      '%IX0.5',
      '%IX0.6',
      '%IX0.7',
      '%IX1.0',
    ])
  })

  it('puts a number in a word, and a word address counts in words', () => {
    const { plan } = assign('', [
      { name: 'Count', dir: 'out', stType: 'INT' },
      { name: 'Speed', dir: 'in', stType: 'INT' },
      { name: 'Total', dir: 'out', stType: 'INT' },
    ])
    expect(plan.assignments).toEqual([
      { name: 'Count', address: '%IW0', type: 'INT' },
      { name: 'Speed', address: '%QW0', type: 'INT' },
      { name: 'Total', address: '%IW1', type: 'INT' },
    ])
  })

  it('skips an address a part already sits on, and one the program already declares', () => {
    const source = `VAR
  Other AT %IX0.1 : BOOL;
END_VAR`
    const { plan } = assign(source, [EYE], ['%IX0.0'])
    expect(plan.assignments).toEqual([{ name: 'Eye', address: '%IX0.2', type: 'BOOL' }])
  })

  it('keeps the address a tag is already declared at, and changes nothing in the program', () => {
    const source = `VAR
  Eye AT %IX7.1 : BOOL;
END_VAR`
    const { plan, source: after } = assign(source, [EYE])
    expect(plan.assignments).toEqual([{ name: 'Eye', address: '%IX7.1', type: 'BOOL' }])
    expect(after).toBe(source)
  })

  it('takes the type from the program when it declares one, and from the parts when it does not', () => {
    const source = `VAR
  Count : UINT;
END_VAR`
    const { plan } = assign(source, [{ name: 'Count', dir: 'out', stType: 'INT' }, { name: 'Fresh', dir: 'out', stType: 'INT' }])
    expect(plan.assignments).toEqual([
      { name: 'Count', address: '%IW0', type: 'UINT' },
      { name: 'Fresh', address: '%IW1', type: 'INT' },
    ])
  })

  it('reads the program for the spelling of a name a part wired in another case', () => {
    const { plan } = assign(CONVEYOR, [{ name: 'eye', dir: 'out', stType: 'BOOL' }])
    expect(plan.assignments[0]?.name).toBe('Eye')
  })
})

describe('planIoAssignment: what it refuses, and why', () => {
  const only = (source: string, uses: IoTagUse[]): string => planIoAssignment(source, uses, []).skipped[0]?.reason ?? ''

  it('refuses a tag that parts both publish and read', () => {
    expect(only('', [{ name: 'Eye', dir: 'out', stType: 'BOOL' }, { name: 'Eye', dir: 'in', stType: 'BOOL' }])).toMatch(/both publish and read Eye/)
  })

  it('refuses a PROGRAM instance tag, which IEC cannot locate', () => {
    expect(only('', [{ name: 'Main.Run', dir: 'in', stType: 'BOOL' }])).toMatch(/belongs to program Main/)
  })

  it('refuses a constant', () => {
    expect(only('VAR CONSTANT\n  Run : BOOL := TRUE;\nEND_VAR', [RUN])).toMatch(/is a constant/)
  })

  it('refuses a type that cannot sit at an address', () => {
    expect(only('VAR\n  Run : ARRAY[0..3] OF BOOL;\nEND_VAR', [RUN])).toMatch(/only a single bit or number/)
    expect(only('VAR\n  Run : STRING;\nEND_VAR', [RUN])).toMatch(/only a single bit or number/)
  })

  it('refuses what cannot travel over Modbus, naming what can', () => {
    expect(only('VAR\n  Level : SINT;\nEND_VAR', [{ name: 'Level', dir: 'out', stType: 'INT' }])).toMatch(/does not travel to an external PLC/)
    expect(only('VAR\n  Big : LINT;\nEND_VAR', [{ name: 'Big', dir: 'out', stType: 'INT' }])).toMatch(/does not travel to an external PLC/)
  })

  it('puts a REAL in a double word, at the register pair after the words', () => {
    // measured against a real OpenPLC: a REAL crosses as its IEEE754 pattern, low word first
    const plan = planIoAssignment('VAR\n  Speed : REAL;\nEND_VAR', [{ name: 'Speed', dir: 'in', stType: 'REAL' }], [])
    expect(plan.assignments).toEqual([{ name: 'Speed', address: '%QD50', type: 'REAL' }])
    const undeclared = planIoAssignment('', [{ name: 'Distance', dir: 'out', stType: 'REAL' }], [])
    expect(undeclared.assignments).toEqual([{ name: 'Distance', address: '%ID50', type: 'REAL' }])
    expect(locateTags('', undeclared.assignments)).toContain('Distance AT %ID50 : REAL;')
  })

  it('keeps a double word clear of the words it would alias', () => {
    // %ID50 is registers 100-101, so a word already sitting on 101 pushes the double word along
    const plan = planIoAssignment('', [{ name: 'Speed', dir: 'out', stType: 'REAL' }], ['%IW101'])
    expect(plan.assignments).toEqual([{ name: 'Speed', address: '%ID51', type: 'REAL' }])
  })

  it('counts words and double words in one register space', () => {
    const uses: IoTagUse[] = [
      { name: 'A', dir: 'out', stType: 'REAL' },
      { name: 'B', dir: 'out', stType: 'INT' },
      { name: 'C', dir: 'out', stType: 'REAL' },
    ]
    expect(planIoAssignment('', uses, []).assignments.map((a) => a.address)).toEqual(['%ID50', '%IW0', '%ID51'])
  })

  it('refuses an undeclared tag no part types, and one the parts disagree about', () => {
    expect(only('', [{ name: 'X', dir: 'in' }])).toMatch(/says what type it carries/)
    expect(only('', [{ name: 'X', dir: 'in', stType: 'BOOL' }, { name: 'X', dir: 'in', stType: 'INT' }])).toMatch(/disagree on its type \(BOOL, INT\)/)
  })

  it('refuses everything while the program cannot be read, rather than rewriting it', () => {
    const halfTyped = 'VAR\n  Run : BOOL;\n' // END_VAR not written yet
    const plan = planIoAssignment(halfTyped, [RUN], [])
    expect(plan.assignments).toEqual([])
    expect(plan.skipped[0]?.reason).toMatch(/could not be read/)
    expect(locateTags(halfTyped, [{ name: 'Run', address: '%QX0.0', type: 'BOOL' }])).toBe(halfTyped)
  })

  it('refuses a declared tag whose type does not fit the part', () => {
    expect(only('VAR\n  Run : INT;\nEND_VAR', [RUN])).toMatch(/does not travel in the word address/)
  })
})

describe('locateTags: what the program looks like afterwards', () => {
  it('locates a block that ends up all located, in place', () => {
    const { source } = assign(CONVEYOR, [EYE, RUN])
    expect(source).toBe(`VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Run := NOT Eye;`)
    expect(diagnostics(source)).toEqual([])
  })

  it('leaves ordinary variables in their block and gives the located ones one of their own', () => {
    const source = `VAR
  Eye : BOOL;
  Count : INT := 3; (* boxes so far *)
  Run : BOOL;
END_VAR
Run := NOT Eye;
IF Run THEN Count := Count + 1; END_IF;`
    const after = assign(source, [EYE, RUN]).source
    expect(after).toBe(`VAR
  Count : INT := 3; (* boxes so far *)
END_VAR
VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Run := NOT Eye;
IF Run THEN Count := Count + 1; END_IF;`)
    expect(diagnostics(after)).toEqual([])
  })

  it('carries a moved declaration\'s own comment with it', () => {
    const source = `VAR
  Eye : BOOL; (* the photo eye at the end *)
  Count : INT;
END_VAR
Count := Count + 1;`
    expect(assign(source, [EYE]).source).toContain('Eye AT %IX0.0 : BOOL; (* the photo eye at the end *)')
  })

  it('splits a declaration that names several variables, one address each', () => {
    const source = `VAR
  Eye, Run : BOOL;
END_VAR
Run := NOT Eye;`
    const after = assign(source, [EYE, RUN]).source
    expect(after).toBe(`VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Run := NOT Eye;`)
    expect(diagnostics(after)).toEqual([])
  })

  it('keeps the names that stay when it splits a shared declaration', () => {
    const source = `VAR
  Eye, Spare, Run : BOOL;
END_VAR
Run := NOT Eye;`
    const after = assign(source, [EYE, RUN]).source
    expect(after).toContain('Spare : BOOL;')
    expect(after).toContain('Eye AT %IX0.0 : BOOL;')
    expect(after).toContain('Run AT %QX0.0 : BOOL;')
    expect(diagnostics(after)).toEqual([])
  })

  it('declares a tag the program never had, keeping its name as the point\'s symbol', () => {
    const after = assign('', [EYE, RUN]).source
    expect(after).toBe(`VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
`)
    expect(locatedVariables(after).get('%IX0.0')).toBe('Eye')
    expect(diagnostics(after)).toEqual([])
  })

  it('puts a new tag above the code when the program is only code', () => {
    const after = assign('Run := NOT Eye;', [EYE, RUN]).source
    expect(after).toBe(`VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Run := NOT Eye;`)
    expect(diagnostics(after)).toEqual([])
  })

  it('declares a new tag in VAR_GLOBAL when the file declares PROGRAMs, which leave no code outside them', () => {
    const source = `PROGRAM Main
VAR
  n : INT;
END_VAR
n := n + 1;
END_PROGRAM`
    const after = assign(source, [EYE]).source
    expect(after).toBe(`VAR_GLOBAL
  Eye AT %IX0.0 : BOOL;
END_VAR

${source}`)
    expect(diagnostics(after)).toEqual([])
  })

  it('joins the located block it made last time instead of stacking a new one', () => {
    const first = assign(`VAR
  Count : INT;
  Eye : BOOL;
END_VAR
Count := Count + 1;`, [EYE]).source
    const second = assign(first, [EYE, RUN]).source
    expect(second).toBe(`VAR
  Count : INT;
END_VAR
VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Count := Count + 1;`)
    expect(diagnostics(second)).toEqual([])
  })

  it('leaves a VAR_GLOBAL block a global block, and keeps RETAIN', () => {
    const source = `VAR_GLOBAL RETAIN
  Eye : BOOL;
  Count : INT;
END_VAR

PROGRAM Main
VAR_EXTERNAL
  Eye : BOOL;
END_VAR
END_PROGRAM`
    const after = assign(source, [EYE]).source
    expect(after).toContain(`VAR_GLOBAL RETAIN
  Eye AT %IX0.0 : BOOL;
END_VAR`)
    expect(diagnostics(after)).toEqual([])
  })

  it('leaves every other block alone, function blocks included', () => {
    const source = `FUNCTION_BLOCK Latch
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR
  Run : BOOL;
END_VAR
Run := Eye;
END_FUNCTION_BLOCK

VAR
  Eye : BOOL;
END_VAR
Eye := FALSE;`
    const after = assign(source, [EYE]).source
    expect(after).toContain(`VAR_INPUT
  Eye : BOOL;
END_VAR`)
    expect(after).toContain('Eye AT %IX0.0 : BOOL;')
    expect(diagnostics(after)).toEqual([])
  })

  it('moves a top-level input or output to the located block, and drops a block it empties', () => {
    const source = `VAR_INPUT
  Start : BOOL;
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
Run := Start AND NOT Eye;`
    const after = assign(source, [EYE, RUN]).source
    expect(after).toContain(`VAR_INPUT
  Start : BOOL;
END_VAR`)
    expect(after).not.toContain('VAR_OUTPUT')
    // each declared once, at its address
    expect(after.match(/^ *(Eye|Run)\b.*: BOOL;$/gm)).toEqual(['  Eye AT %IX0.0 : BOOL;', '  Run AT %QX0.0 : BOOL;'])
    expect(diagnostics(after)).toEqual([])
  })

  it('drops an emptied input block that opens the program, where the located block goes', () => {
    // the new block is inserted at the line the input block is deleted from: one edit must not eat the other
    const source = `VAR_INPUT
  Eye : BOOL; (* the photo eye at the end *)
END_VAR

VAR_OUTPUT
  Run : BOOL;
END_VAR

Run := NOT Eye;`
    const after = assign(source, [EYE, RUN]).source
    expect(after).toBe(`VAR
  Eye AT %IX0.0 : BOOL; (* the photo eye at the end *)
  Run AT %QX0.0 : BOOL;
END_VAR


Run := NOT Eye;`)
    expect(diagnostics(after)).toEqual([])
  })

  it('keeps CRLF line endings', () => {
    const after = assign(CONVEYOR.replace(/\n/g, '\r\n'), [EYE, RUN]).source
    expect(after.includes('\r\n')).toBe(true)
    expect(after.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))).toBe(true)
  })

  it('leaves the program running the same way, by address and by name', () => {
    const p = compile(assign(CONVEYOR, [EYE, RUN]).source)
    expect(p.inputs).toEqual(['%IX0.0'])
    expect(p.outputs).toEqual(['%QX0.0'])
    p.setInput('%IX0.0', false)
    p.scan(0.01)
    expect(p.get('%QX0.0')).toBe(true)
    expect(p.watch).toMatchObject({ Eye: false, Run: true })
  })
})

describe('parseIoList: the file a controls engineer hands over', () => {
  it('reads tag and address columns under a header, in either order', () => {
    expect(parseIoList('Tag,Address\nEye,%IX100.0\nRun,%QX100.0\n').rows).toEqual([
      { name: 'Eye', address: '%IX100.0', line: 2 },
      { name: 'Run', address: '%QX100.0', line: 3 },
    ])
    expect(parseIoList('%IX100.0;Eye;photo eye\n%QX100.0;Run;belt motor').rows.map((r) => r.name)).toEqual(['Eye', 'Run'])
  })

  it('reads tabs, quoted cells and extra columns, and skips blank and # lines', () => {
    const list = parseIoList('Address\tTag\tDescription\n%IX100.0\tEye\t"eye, at the end"\n\n# added later\n%QX100.0\tRun\tmotor\n')
    expect(list.rows).toEqual([
      { name: 'Eye', address: '%IX100.0', line: 2 },
      { name: 'Run', address: '%QX100.0', line: 5 },
    ])
    expect(list.problems).toEqual([])
  })

  it('reports a row with no address and one with no name, by line', () => {
    const list = parseIoList('Tag,Address\nEye,%IX100.0\nRun,\n,%QX100.1\n')
    expect(list.rows).toHaveLength(1)
    expect(list.problems).toEqual(['line 3: no IEC address (like %IX100.0) on this row', 'line 4: no tag name beside %QX100.1'])
  })
})

describe('planIoImport: an address list checked against this scene', () => {
  const rows = (text: string) => parseIoList(text).rows

  it('takes the list\'s addresses for the tags the scene wires', () => {
    const plan = planIoImport(CONVEYOR, [EYE, RUN], rows('Eye,%IX7.3\nRun,%QX2.0'), [])
    expect(plan.assignments).toEqual([
      { name: 'Eye', address: '%IX7.3', type: 'BOOL' },
      { name: 'Run', address: '%QX2.0', type: 'BOOL' },
    ])
    expect(locateTags(CONVEYOR, plan.assignments)).toContain('Eye AT %IX7.3 : BOOL;')
  })

  it('moves a tag that is already located, address and all', () => {
    const source = 'VAR\n  Eye AT %IX100.0 : BOOL;\nEND_VAR'
    const plan = planIoImport(source, [EYE], rows('Eye,%IX7.3'), ['%IX100.0'])
    expect(plan.skipped).toEqual([])
    expect(locateTags(source, plan.assignments)).toBe('VAR\n  Eye AT %IX7.3 : BOOL;\nEND_VAR')
  })

  it('refuses a row whose direction contradicts the part', () => {
    const plan = planIoImport(CONVEYOR, [EYE], rows('Eye,%QX0.0'), [])
    expect(plan.assignments).toEqual([])
    expect(plan.skipped[0]?.reason).toMatch(/line 1:.*publishes the value/)
  })

  it('refuses a size the declared type does not fit, and an address that cannot travel', () => {
    expect(planIoImport(CONVEYOR, [EYE], rows('Eye,%IW3'), []).skipped[0]?.reason).toMatch(/BOOL, which does not fit the word address/)
    expect(planIoImport(CONVEYOR, [EYE], rows('Eye,%MX0.0'), []).skipped[0]?.reason).toMatch(/memory address/)
    expect(planIoImport(CONVEYOR, [EYE], rows('Eye,%IL0'), []).skipped[0]?.reason).toMatch(/long-word address/)
  })

  it('refuses two rows that collide, keeping the first', () => {
    const plan = planIoImport(CONVEYOR, [EYE, RUN], rows('Eye,%IX7.3\nEye,%IX7.4\nRun,%IX7.3'), [])
    expect(plan.assignments).toEqual([{ name: 'Eye', address: '%IX7.3', type: 'BOOL' }])
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'line 2: Eye is already given an address on line 1',
      'line 3: %IX7.3 is already given to Eye on line 1',
    ])
  })

  it('refuses an address the program or a part already holds', () => {
    const source = 'VAR\n  Other AT %IX7.3 : BOOL;\n  Eye : BOOL;\nEND_VAR'
    expect(planIoImport(source, [EYE], rows('Eye,%IX7.3'), []).skipped[0]?.reason).toMatch(/already declares Other there/)
    expect(planIoImport(CONVEYOR, [EYE], rows('Eye,%IX7.3'), ['%IX7.3']).skipped[0]?.reason).toMatch(/already wired to %IX7.3 directly/)
  })

  it('reports a row this scene knows nothing about instead of declaring it', () => {
    const plan = planIoImport(CONVEYOR, [EYE], rows('Eye,%IX7.3\nPump_7,%QX9.0'), [])
    expect(plan.assignments.map((a) => a.name)).toEqual(['Eye'])
    expect(plan.skipped[0]?.reason).toMatch(/neither the program nor any part in the scene uses Pump_7/)
  })

  it('declares a listed tag the program lacks but the scene wires', () => {
    const plan = planIoImport('', [EYE], rows('Eye,%IX7.3'), [])
    expect(locateTags('', plan.assignments)).toContain('Eye AT %IX7.3 : BOOL;')
  })
})

describe('a register-image target: a PLC that serves its process image', () => {
  const IMAGE: IoTarget = { kind: 'register-image', base: { input: 0, output: 0 } }
  const rows = (text: string) => parseIoList(text).rows

  it('packs from the device\'s first register, so a small scene takes few registers', () => {
    const plan = planIoAssignment(CONVEYOR, [EYE, RUN, { name: 'Range', dir: 'out', stType: 'REAL' }, { name: 'Speed', dir: 'in', stType: 'REAL' }], [], IMAGE)
    expect(plan.assignments).toEqual([
      { name: 'Eye', address: '%IX0.0', type: 'BOOL' },
      { name: 'Run', address: '%QX0.0', type: 'BOOL' },
      // bits hold register 0, so the first double word free to start on an even word is words 2-3
      { name: 'Range', address: '%ID1', type: 'REAL' },
      { name: 'Speed', address: '%QD1', type: 'REAL' },
    ])
  })

  it('treats a bit and the word that holds it as one place', () => {
    const uses: IoTagUse[] = [
      { name: 'Count', dir: 'out', stType: 'INT' },
      { name: 'A', dir: 'out', stType: 'BOOL' },
      { name: 'B', dir: 'out', stType: 'BOOL' },
    ]
    // a part already on %IX0.3 holds word 0, so the word goes to %IW1; the bits fill word 0 around it
    const plan = planIoAssignment('', uses, ['%IX0.3'], IMAGE)
    expect(plan.assignments.map((a) => `${a.name} ${a.address}`)).toEqual(['Count %IW1', 'A %IX0.0', 'B %IX0.1'])
    // and a list that puts a word on a register a bit already uses is refused
    const clash = planIoImport(CONVEYOR, [EYE, { name: 'Count', dir: 'out', stType: 'INT' }], rows('Eye,%IX1.0\nCount,%IW0'), [], IMAGE)
    expect(clash.skipped[0]?.reason).toMatch(/line 2: %IW0 is already given to Eye on line 1/)
  })

  it('counts from where the device sits, and refuses an address below it', () => {
    const at = (input: number, output: number): IoTarget => ({ kind: 'register-image', base: { input, output } })
    expect(planIoAssignment(CONVEYOR, [EYE, RUN], [], at(3, 5)).assignments.map((a) => a.address)).toEqual(['%IX6.0', '%QX10.0'])
    const range = planIoAssignment('', [{ name: 'Range', dir: 'out', stType: 'REAL' }], [], at(3, 0)).assignments[0]
    expect(range?.address).toBe('%ID2') // words 4-5: the first even word at or after the base
    expect(planIoImport(CONVEYOR, [EYE], rows('Eye,%IX0.0'), [], at(3, 0)).skipped[0]?.reason).toMatch(/below the server device's first register \(%IW3\)/)
  })

  it('leaves the server target as it was: bits and words are separate areas there', () => {
    const plan = planIoImport(CONVEYOR, [EYE, { name: 'Count', dir: 'out', stType: 'INT' }], rows('Eye,%IX1.0\nCount,%IW0'), [])
    expect(plan.skipped).toEqual([])
  })
})
