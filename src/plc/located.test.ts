// Located variables (`Eye AT %IX100.0 : BOOL`): the address is how the variable meets the scene and any
// external controller, so these pin both halves: what the checker accepts, and that the tag surface
// (inputs, outputs, setInput, get) speaks addresses while the watch table keeps speaking names.

import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { toTypeScript } from './emit'
import { exportProgram, toPlcopenXml } from './exchange/export'
import { renderIecText } from './exchange/exportText'
import { importIecText } from './exchange/importText'
import { importPlcopenXml } from './exchange/importXml'
import { compile } from './interpreter'
import { LocalPlcLink } from './link/plcLink'

const CONVEYOR = `VAR
  Eye AT %IX100.0 : BOOL;
  Run AT %QX100.0 : BOOL;
  Count AT %IW3 : INT;
  Shown AT %QW0 : INT;
END_VAR
Run := NOT Eye;
Shown := Count * 2;`

describe('located variables: the tag surface', () => {
  it('lists an input address as an input and an output address as an output', () => {
    const p = compile(CONVEYOR)
    expect(p.inputs).toEqual(['%IX100.0', '%IW3'])
    expect(p.outputs).toEqual(['%QX100.0', '%QW0'])
  })

  it('takes inputs and gives outputs by address, in any spelling of it', () => {
    const p = compile(CONVEYOR)
    p.setInput('%IX100.0', true)
    p.setInput('%iw03', 21)
    p.scan(0.01)
    expect(p.get('%QX100.0')).toBe(false)
    expect(p.get('%qw0')).toBe(42)
    p.setInput('%I100.0', false)
    p.scan(0.01)
    expect(p.get('%QX100.0')).toBe(true)
  })

  it('still reads and writes by name, and the watch table is by name', () => {
    const p = compile(CONVEYOR)
    p.setInput('Eye', true)
    p.scan(0.01)
    expect(p.get('Run')).toBe(false)
    expect(p.watch).toMatchObject({ Eye: true, Run: false, Count: 0, Shown: 0 })
    expect(Object.keys(p.watch).some((k) => k.startsWith('%'))).toBe(false)
  })

  it('an unknown address reads as nothing and a write to it is ignored', () => {
    const p = compile(CONVEYOR)
    p.setInput('%IX9.9', true) // malformed and absent: ignored, not thrown
    p.setInput('%IX5.0', true)
    expect(p.get('%QX5.0')).toBeUndefined()
  })

  it('crosses the PlcLink seam by address, which is what the scene binds', () => {
    const link = new LocalPlcLink(CONVEYOR)
    expect(link.step({ '%IX100.0': true, '%IW3': 5 }, 0.01)).toEqual({ '%QX100.0': false, '%QW0': 10 })
    expect(link.step({ '%IX100.0': false }, 0.01)).toEqual({ '%QX100.0': true, '%QW0': 10 })
  })

  it('works beside the named tags of the same program', () => {
    const p = compile(`VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Lamp : BOOL; END_VAR
VAR Motor AT %QX0.0 : BOOL; END_VAR
Motor := Start;
Lamp := Motor;`)
    expect(p.inputs).toEqual(['Start'])
    expect(p.outputs).toEqual(['Lamp', '%QX0.0'])
  })

  it('a located VAR_GLOBAL is on the surface too', () => {
    const p = compile(`VAR_GLOBAL Horn AT %QX1.0 : BOOL; END_VAR
VAR_INPUT Alarm : BOOL; END_VAR
Horn := Alarm;`)
    expect(p.outputs).toEqual(['%QX1.0'])
    p.setInput('Alarm', true)
    p.scan(0.01)
    expect(p.get('%QX1.0')).toBe(true)
  })

  it('in a CONFIGURATION, an address is not qualified by the instance that holds it', () => {
    const p = compile(`PROGRAM Line
VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
  Scans : INT;
END_VAR
Run := NOT Eye;
Scans := Scans + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION`)
    expect(p.inputs).toEqual(['%IX0.0'])
    expect(p.outputs).toEqual(['%QX0.0'])
    p.setInput('%IX0.0', true)
    p.scanTask(0, 0.01)
    expect(p.get('%QX0.0')).toBe(false)
    expect(p.get('Line1.Run')).toBe(false)
    expect(p.watch).toMatchObject({ 'Line1.Eye': true, 'Line1.Run': false })
  })

  it('a controller tag can be located, beside a CONFIGURATION', () => {
    const p = compile(`VAR Eye AT %IX0.0 : BOOL; Run AT %QX0.0 : BOOL; END_VAR
Run := NOT Eye;

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Main WITH Fast;
  END_RESOURCE
END_CONFIGURATION`)
    expect(p.inputs).toEqual(['%IX0.0'])
    p.setInput('%IX0.0', false)
    p.scanTask(0, 0.01)
    expect(p.get('%QX0.0')).toBe(true)
  })

  it('the emitted TypeScript runs a located program the same way', () => {
    const ts = toTypeScript(CONVEYOR)
    expect(ts).toMatch(/Eye/)
    expect(ts).not.toMatch(/%IX/) // an address is binding, not code
  })
})

describe('located variables: what the checker refuses', () => {
  const refuses = (src: string, re: RegExp) => expect(() => compile(src)).toThrow(re)

  it('a type that does not fit the address size', () => {
    refuses('VAR a AT %IX0.0 : INT; END_VAR', /'a' is INT, which does not fit the bit address %IX0.0; a bit holds BOOL/)
    refuses('VAR a AT %IW0 : BOOL; END_VAR', /'a' is BOOL, which does not fit the word address %IW0; a word holds INT, UINT, WORD/)
    refuses('VAR a AT %QD1 : INT; END_VAR', /double-word holds DINT, UDINT, DWORD, REAL/)
    refuses('VAR a AT %IL0 : LREAL; END_VAR', /long-word \(64-bit\) address, and 64-bit types are not supported/)
    refuses('VAR a AT %IW0 : TIME; END_VAR', /'a' is TIME, which does not fit/)
  })

  it('a byte-sized type fits a byte, a REAL a double word, a subrange its base', () => {
    expect(() => compile('TYPE Pct : INT (0..100); END_TYPE\nVAR b AT %IB0 : USINT; r AT %ID1 : REAL; p AT %QW2 : Pct; END_VAR')).not.toThrow()
  })

  it('an aggregate or an instance at an address', () => {
    refuses('VAR a AT %IW0 : ARRAY [0..1] OF INT; END_VAR', /only an elementary type \(BOOL, INT, REAL, \.\.\.\) can be located/)
    refuses('VAR t AT %QX0.0 : TON; END_VAR', /only an elementary type/)
  })

  it('two memory variables that share bytes: targets disagree on what that means', () => {
    refuses('VAR w AT %MW0 : INT; b AT %MX1.2 : BOOL; END_VAR', /'b' at %MX1.2 shares memory with 'w' at %MW0; .*some overlay them/)
    refuses('VAR d AT %MD0 : DINT; w AT %MW1 : INT; END_VAR', /'w' at %MW1 shares memory with 'd' at %MD0/)
    refuses('VAR a AT %MW0 : INT; b AT %mw0 : INT; END_VAR', /%MW0 is already the address of 'a'; one address, one variable/)
  })

  it('a located VAR_INPUT or VAR_OUTPUT: the address says the direction', () => {
    refuses('VAR_INPUT a AT %IX0.0 : BOOL; END_VAR', /a located variable is declared in VAR.*\(not VAR_INPUT\)/)
    refuses('VAR_OUTPUT a AT %QX0.0 : BOOL; END_VAR', /\(not VAR_OUTPUT\)/)
  })

  it('a located variable in a function block or a function', () => {
    refuses(
      'FUNCTION_BLOCK Motor\nVAR run AT %QX0.0 : BOOL; END_VAR\nrun := TRUE;\nEND_FUNCTION_BLOCK\nVAR m : Motor; END_VAR\nm();',
      /a function block cannot declare a located variable/,
    )
    refuses('FUNCTION Probe : BOOL\nVAR x AT %IX0.0 : BOOL; END_VAR\nProbe := x;\nEND_FUNCTION', /a function cannot declare a located variable/)
  })

  it('CONSTANT at an address', () => {
    refuses('VAR CONSTANT a AT %IX0.0 : BOOL := TRUE; END_VAR', /'a' is CONSTANT, and a located variable cannot be/)
  })

  it('two variables at one address', () => {
    refuses('VAR a AT %QX0.0 : BOOL; b AT %qx0.0 : BOOL; END_VAR', /%QX0.0 is already the address of 'a'; one I\/O point, one variable/)
    refuses('VAR_GLOBAL g AT %IX1.0 : BOOL; END_VAR\nVAR a AT %IX1.0 : BOOL; END_VAR', /already the address of 'g'/)
  })

  it('one address for several names on one line', () => {
    refuses('VAR a, b AT %IX0.0 : BOOL; END_VAR', /one address locates one variable: declare 'a', 'b' on lines of their own/)
  })

  it('a PROGRAM that locates variables, run as two instances', () => {
    refuses(
      `PROGRAM Line
VAR run AT %QX0.0 : BOOL; END_VAR
run := TRUE;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH Fast : Line;
    PROGRAM B WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION`,
      /PROGRAM 'Line' locates 'run' at %QX0.0, so it can run as one instance only: 'A' and 'B' would both be that I\/O point/,
    )
  })

  it('address shapes the targets do not use, and malformed ones', () => {
    refuses('VAR a AT %IX3 : BOOL; END_VAR', /a bit address is byte.bit/)
    refuses('VAR a AT %IX0.9 : BOOL; END_VAR', /bit 9 does not exist in a byte/)
    refuses('VAR a AT %ZZ1 : BOOL; END_VAR', /'%ZZ1' is not a direct address/)
  })

  it("an incomplete address (AT %I*), which a vendor's I/O configuration completes, is a plain variable here", () => {
    // the scene's wiring is this program's I/O configuration, and it binds a variable by name
    const p = compile('VAR a AT %I* : BOOL; q AT %Q* : BOOL; END_VAR\nq := a;')
    expect(p.bindable).toEqual(expect.arrayContaining(['a', 'q']))
    expect(p.inputs).not.toContain('%I*')
  })

  it('a direct address in code, which has to be a declared variable here', () => {
    refuses('VAR q : BOOL; END_VAR\nq := %IX0.0;', /a direct address cannot be used in code here; declare a variable at it \(VAR name AT %IX0.0/)
  })

  it('reports every located mistake at the address, and keeps going', () => {
    const src = 'VAR a AT %IW0 : BOOL; b AT %MW1 : BOOL; END_VAR'
    const d = diagnostics(src)
    expect(d.map((x) => x.message)).toEqual([expect.stringMatching(/does not fit the word address %IW0/), expect.stringMatching(/does not fit the word address %MW1/)])
    expect(src.slice(d[0]!.pos.offset, d[0]!.pos.offset + d[0]!.length)).toBe('%IW0')
  })

  it('a memory address is storage the program keeps: read and written by name, never on the tag surface', () => {
    const p = compile(`VAR
  Eye AT %IX0.0 : BOOL;
  Count AT %MW0 : INT;
  Total AT %MD1 : DINT;
  Seen AT %MX8.0 : BOOL;
  Last AT %MX8.1 : BOOL;
  Rate AT %MD3 : REAL;
END_VAR
Seen := Eye AND NOT Last;
IF Seen THEN Count := Count + 1; Total := Total + 10; END_IF;
Last := Eye;
Rate := INT_TO_REAL(Count) / 2.0;`)
    // none of it is a scene input or output: only the eye is
    expect(p.inputs).toEqual(['%IX0.0'])
    expect(p.outputs).toEqual([])
    for (const eye of [true, false, true, true, false]) {
      p.setInput('%IX0.0', eye)
      p.scan(0.01)
    }
    expect(p.get('Count')).toBe(2)
    expect(p.get('Total')).toBe(20)
    expect(p.get('Rate')).toBe(1)
  })

  it('a memory address survives export and import, in text and in PLCopen XML', () => {
    const src = 'VAR Count AT %MW0 : INT; Flag AT %MX2.3 : BOOL; END_VAR\nCount := Count + 1;\nFlag := Count > 3;'
    const text = exportProgram(src, 'iec-text').content
    expect(text).toMatch(/Count AT %MW0 : INT;/)
    expect(text).toMatch(/Flag AT %MX2\.3 : BOOL;/)
    expect(importIecText(text).source).toMatch(/Count AT %MW0 : INT;/)
    const xml = toPlcopenXml(src)
    expect(xml).toContain('address="%MW0"')
    const back = importPlcopenXml(xml)
    expect(back.source).toMatch(/Count AT %MW0 : INT;/)
    expect(() => compile(back.source)).not.toThrow()
  })

  it('AT stays an ordinary name where no address follows it', () => {
    const p = compile('VAR at : INT; END_VAR\nat := 3;')
    p.scan(0.01)
    expect(p.get('at')).toBe(3)
  })
})

describe('located variables: export and import', () => {
  it('the .st export keeps each address as written, and imports back with nothing to note', () => {
    const text = renderIecText(CONVEYOR, { banner: false })
    expect(text).toContain('Eye AT %IX100.0 : BOOL;')
    expect(text).toContain('Shown AT %QW0 : INT;')
    const back = importIecText(text)
    expect(back.notes).toEqual([])
    expect(compile(back.source).inputs).toEqual(['%IX100.0', '%IW3'])
  })

  it('the PLCopen export writes TC6 address attributes, and imports back to the same surface', () => {
    const xml = toPlcopenXml(CONVEYOR, { timestamp: '2026-01-01T00:00:00' })
    expect(xml).toContain('<variable name="Eye" address="%IX100.0">')
    expect(xml).toContain('<variable name="Shown" address="%QW0">')
    const back = importPlcopenXml(xml)
    expect(back.notes).toEqual([])
    const p = compile(back.source)
    expect(p.inputs).toEqual(['%IX100.0', '%IW3'])
    expect(p.outputs).toEqual(['%QX100.0', '%QW0'])
  })

  it('an export of a located program reports no losses', () => {
    expect(exportProgram(CONVEYOR, 'iec-text').warnings).toEqual([])
    expect(exportProgram(CONVEYOR, 'plcopen-xml').warnings).toEqual([])
  })

  it('warns when one VAR block mixes located and ordinary variables, which MATIEC refuses', () => {
    const mixed = exportProgram('VAR Eye AT %IX0.0 : BOOL; Seen : BOOL; END_VAR\nSeen := Eye;', 'iec-text').warnings
    expect(mixed).toEqual([expect.stringMatching(/^Eye: a VAR block holds both located \(AT %\.\.\.\) and ordinary variables/)])
    const split = exportProgram('VAR Eye AT %IX0.0 : BOOL; END_VAR\nVAR Seen : BOOL; END_VAR\nSeen := Eye;', 'iec-text').warnings
    expect(split).toEqual([])
  })

  it('located controller tags that another POU shares go out as located VAR_GLOBALs', () => {
    // the POUs first: the exporter only finds the code outside every POU after them (splitLibrary)
    const src = `PROGRAM Watch
VAR_EXTERNAL Eye : BOOL; END_VAR
VAR seen : BOOL; END_VAR
seen := Eye;
END_PROGRAM

VAR Eye AT %IX0.0 : BOOL; END_VAR

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM W WITH Fast : Watch;
  END_RESOURCE
END_CONFIGURATION`
    const text = renderIecText(src, { banner: false })
    expect(text).toMatch(/VAR_GLOBAL Eye AT %IX0\.0 : BOOL; END_VAR/)
    expect(compile(text).inputs).toEqual(['%IX0.0'])
  })
})
