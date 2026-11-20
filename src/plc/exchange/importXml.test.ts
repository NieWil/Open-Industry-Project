// The way in from PLCopen XML, checked mostly by the way out.
//
// Same strategy as the text importer: the exporter is already validated against PLCopen's own
// TC6 schema (scripts/oracle-plcopen.mjs), so running the whole corpus out through it and back
// in is a check neither side can satisfy alone.
//
// The property is not text-for-text, and that is inherent rather than a gap. PLCopen keeps data
// types and POUs in separate containers, so a `TYPE` written between two function blocks has
// nowhere to record that it sat there - the same forced loss as the VAR_GLOBAL hoist in the text
// target. What must hold is that the program still means the same thing, still compiles, and
// stops moving after one trip.
import { describe, expect, it } from 'vitest'
import { importPlcopenXml, parseXml } from './importXml'
import { toPlcopenXml } from './export'
import { parseAndCheck } from '../checker'
import { CONFORMANCE_CASES } from '../conformanceCases'

const roundTrip = (src: string): string => importPlcopenXml(toPlcopenXml(src)).source

describe('the XML reader', () => {
  it('reads elements, attributes, text and both quote styles', () => {
    const r = parseXml(`<project a="1" b='2'><pou name="Latch">body</pou></project>`)
    expect(r.name).toBe('project')
    expect(r.attrs).toEqual({ a: '1', b: '2' })
    expect(r.children[0]!.attrs.name).toBe('Latch')
    expect(r.children[0]!.text).toBe('body')
  })

  it('strips namespace prefixes, so a vendor file with them reads the same', () => {
    const r = parseXml('<tc6:project xmlns:tc6="urn:x"><tc6:types/></tc6:project>')
    expect(r.name).toBe('project')
    expect(r.children[0]!.name).toBe('types')
  })

  it('skips comments, declarations and doctypes', () => {
    const r = parseXml('<?xml version="1.0"?><!-- a note --><project><!--another--><types/></project>')
    expect(r.name).toBe('project')
    expect(r.children.map((c) => c.name)).toEqual(['types'])
  })

  it('decodes entities in text and attributes, and takes CDATA literally', () => {
    const r = parseXml('<a t="x &amp; y &#65;">1 &lt; 2</a>')
    expect(r.attrs.t).toBe('x & y A')
    expect(r.text).toBe('1 < 2')
    expect(parseXml('<a><![CDATA[raw & <stuff>]]></a>').text).toBe('raw & <stuff>')
  })

  it('is not confused by a > inside an attribute value', () => {
    const r = parseXml('<a cond="x > 1"><b/></a>')
    expect(r.attrs.cond).toBe('x > 1')
    expect(r.children.map((c) => c.name)).toEqual(['b'])
  })

  it('refuses a file that is not XML at all', () => {
    expect(() => parseXml('VAR x : INT; END_VAR')).toThrow(/no root element/)
  })
})

describe('a program exported to XML and read back is the same program', () => {
  const valid = CONFORMANCE_CASES.filter((c) => !c.rejects)

  it('gives every corpus program back, and it still compiles', () => {
    for (const c of valid) {
      const back = roundTrip(c.src)
      expect(() => parseAndCheck(back), `${c.name}\n${back}`).not.toThrow()
    }
  })

  it('is a fixpoint: a second trip moves nothing', () => {
    for (const c of valid) {
      const once = roundTrip(c.src)
      expect(roundTrip(once), c.name).toBe(once)
    }
  })

  it('recovers the task period, so the scan time can follow the file', () => {
    expect(importPlcopenXml(toPlcopenXml('VAR a : INT; END_VAR\na := 1;', { scanMs: 25 })).scanMs).toBe(25)
  })

  it('crosses without a single note when the whole program fits the subset', () => {
    const { notes } = importPlcopenXml(toPlcopenXml('VAR a : INT; END_VAR\na := 1;'))
    expect(notes).toEqual([])
  })

  it('brings structured and array starting values back as ST lists', () => {
    const back = roundTrip('TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE\nVAR p : Pt := (x := 1, y := 2); row : ARRAY [1..3] OF INT := [4, 5, 6]; END_VAR\np.x := 1;')
    expect(back).toContain('p : Pt := (x := 1, y := 2);')
    expect(back).toContain('row : ARRAY [1..3] OF INT := [4, 5, 6];')
    expect(() => parseAndCheck(back)).not.toThrow()
  })

  it('brings a named array type and a plain alias back as TYPE declarations', () => {
    const back = roundTrip('TYPE Row : ARRAY [1..3] OF INT; END_TYPE\nTYPE Count : INT; END_TYPE\nVAR a : Row; n : Count; END_VAR\na[1] := n;')
    expect(back).toContain('TYPE Row : ARRAY [1..3] OF INT; END_TYPE')
    expect(back).toContain('TYPE Count : INT; END_TYPE')
    expect(() => parseAndCheck(back)).not.toThrow()
  })
})

describe('declarations come back in their own sections', () => {
  const back = roundTrip(`TYPE Mode : (Idle, Running := 10, Fault); END_TYPE
TYPE Pct : INT (0..100); END_TYPE
TYPE Pt : STRUCT x : INT; y : REAL; END_STRUCT; END_TYPE
FUNCTION Dbl : INT VAR_INPUT v : INT; END_VAR Dbl := v * 2; END_FUNCTION
FUNCTION_BLOCK Cnt VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK
VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT out : INT; END_VAR
VAR c : Cnt; t : TON; p : Pt; m : Mode; pc : Pct; a : ARRAY [1..3] OF INT; s : STRING[12]; n : INT := 5; d : TIME := T#1s500ms; END_VAR
c(); t(IN := go, PT := T#1s);
out := Dbl(c.n) + a[1] + n;`)

  it('keeps the enumeration, the subrange and the struct', () => {
    expect(back).toContain('TYPE Mode : (Idle := 0, Running := 10, Fault := 11); END_TYPE')
    expect(back).toContain('TYPE Pct : INT (0..100); END_TYPE')
    expect(back).toContain('TYPE Pt : STRUCT x : INT; y : REAL; END_STRUCT; END_TYPE')
  })

  it('keeps the function with its return type, and the function block', () => {
    expect(back).toContain('FUNCTION Dbl : INT')
    expect(back).toContain('Dbl := v * 2;')
    expect(back).toContain('FUNCTION_BLOCK Cnt')
    expect(back).toContain('n := n + 1;')
  })

  it('keeps array bounds, string capacity and initial values as written', () => {
    expect(back).toContain('a : ARRAY [1..3] OF INT;')
    expect(back).toContain('s : STRING[12];')
    expect(back).toContain('n : INT := 5;')
    expect(back).toContain('d : TIME := T#1s500ms;') // not printed back as raw milliseconds
  })

  it('keeps a standard function-block instance as an instance, not a type name', () => {
    expect(back).toContain('t : TON;')
  })

  it('compiles, which is the only check that covers all of the above at once', () => {
    expect(() => parseAndCheck(back)).not.toThrow()
  })
})

describe('a file from a real toolchain', () => {
  /** the shapes a vendor export carries that this subset has no answer for */
  const VENDOR = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types>
    <dataTypes/>
    <pous>
      <pou name="Drawn" pouType="functionBlock">
        <interface><outputVars><variable name="q"><type><BOOL/></type></variable></outputVars></interface>
        <body><FBD/></body>
      </pou>
      <pou name="Cell" pouType="program">
        <interface>
          <externalVars><variable name="Level"><type><INT/></type></variable></externalVars>
          <localVars><variable name="Start" address="%IX0.0"><type><BOOL/></type></variable></localVars>
          <localVars retain="true"><variable name="hours"><type><DINT/></type></variable></localVars>
        </interface>
        <body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">hours := hours + 1;</xhtml></ST></body>
      </pou>
      <pou name="Spare" pouType="program">
        <interface/>
        <body><ST><xhtml>;</xhtml></ST></body>
      </pou>
    </pous>
  </types>
  <instances>
    <configurations>
      <configuration name="Plant">
        <globalVars><variable name="Level"><type><INT/></type></variable></globalVars>
        <resource name="CPU">
          <task name="Fast" interval="T#20ms" priority="1">
            <pouInstance name="P1" typeName="Cell"/>
          </task>
        </resource>
      </configuration>
    </configurations>
  </instances>
</project>`

  const result = importPlcopenXml(VENDOR)

  it('keeps both programs and the CONFIGURATION that runs them, instead of keeping one', () => {
    // this once loaded 'Cell' and named 'Spare' in a note as dropped
    expect(result.source).toContain('PROGRAM Cell')
    expect(result.source).toContain('hours := hours + 1;')
    expect(result.source).toContain('PROGRAM Spare')
    expect(result.source).toContain('PROGRAM P1 WITH Fast : Cell;')
  })

  it('crosses a single program as the implicit program, as before', () => {
    const single = importPlcopenXml(VENDOR.replace(/<pou name="Spare"[\s\S]*?<\/pou>/, ''))
    expect(single.source).not.toContain('PROGRAM Cell')
    expect(single.source).toContain('hours := hours + 1;')
    expect(single.scanMs).toBe(20)
  })

  it('hoists the configuration globals to the top, where this engine wants them', () => {
    expect(result.source.indexOf('VAR_GLOBAL')).toBeLessThan(result.source.indexOf('hours'))
    expect(result.source).toContain('Level : INT;')
  })

  it('leaves each task period on its task, which a controller keeps', () => {
    expect(result.scanMs).toBeNull()
    expect(result.source).toContain('TASK Fast(INTERVAL := T#20ms, PRIORITY := 1);')
  })

  it('keeps a VAR_EXTERNAL as the declaration it is', () => {
    expect(result.source).toContain('VAR_EXTERNAL\n  Level : INT;\nEND_VAR')
  })

  it('names everything the subset has no place for, instead of swallowing it', () => {
    const all = result.notes.join('\n')
    expect(all).toMatch(/FBD body/) // a POU drawn in a language nothing here reads
    expect(all).toMatch(/RETAIN/)
  })

  it('keeps an input address as the located declaration it is', () => {
    expect(result.source).toContain('Start AT %IX0.0 : BOOL;')
    expect(result.notes.join('\n')).not.toMatch(/%IX0\.0/)
  })

  it('keeps a memory address as the located declaration it is, with nothing to fix', () => {
    const memory = importPlcopenXml(
      VENDOR.replace('<variable name="Start" address="%IX0.0">', '<variable name="Flag" address="%MX0.2"><type><BOOL/></type></variable><variable name="Start" address="%IX0.0">'),
    )
    expect(memory.source).toContain('Flag AT %MX0.2 : BOOL;')
    expect(memory.notes.join('\n')).not.toMatch(/%MX0\.2/)
  })

  it('leaves the drawn POU out rather than emitting an empty one', () => {
    expect(result.source).not.toContain('FUNCTION_BLOCK Drawn')
  })

  it('still produces a program that compiles', () => {
    expect(() => parseAndCheck(result.source)).not.toThrow()
  })
})

describe('an ST body is read whatever XHTML element holds it', () => {
  // TC6 lets a writer put the code in any element of the XHTML namespace, and the writers differ.
  // A reader of `<xhtml>` alone would take a file OpenPLC wrote with empty bodies and no note,
  // and an import oracle checking only that names survive could not see it.
  const doc = (body: string): string =>
    `<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml"><types><pous><pou name="Main" pouType="program"><interface><localVars><variable name="n"><type><INT/></type></variable></localVars></interface><body><ST>${body}</ST></body></pou></pous></types></project>`
  const forms: [string, string][] = [
    ['an <xhtml> element (ours)', '<xhtml xmlns="http://www.w3.org/1999/xhtml">n := n + 1;</xhtml>'],
    ['<xhtml:p> with CDATA (OpenPLC, a current Beremiz)', '<xhtml:p><![CDATA[n := n + 1;]]></xhtml:p>'],
    ['a <p> in the default namespace', '<p xmlns="http://www.w3.org/1999/xhtml">n := n + 1;</p>'],
    ['bare CDATA in <ST> (an older Beremiz)', '<![CDATA[n := n + 1;]]>'],
  ]
  for (const [label, body] of forms) {
    it(label, () => {
      expect(importPlcopenXml(doc(body)).source).toContain('n := n + 1;')
    })
  }
})

describe('the wrong file is refused, not guessed at', () => {
  it('rejects XML that is not a PLCopen project', () => {
    expect(() => importPlcopenXml('<html><body>hi</body></html>')).toThrow(/expected a <project> root/)
  })

  it('rejects a file that is not XML', () => {
    expect(() => importPlcopenXml('VAR x : INT; END_VAR\nx := 1;')).toThrow()
  })

  it('says so when a project carries no PROGRAM at all', () => {
    const { notes } = importPlcopenXml(
      '<project><types><pous><pou name="F" pouType="functionBlock"><interface/><body><ST>;</ST></body></pou></pous></types></project>',
    )
    expect(notes.join(' ')).toMatch(/No PROGRAM was declared/)
  })
})

describe('object orientation crosses in addData', () => {
  const OOP = `INTERFACE IDrive
  METHOD Speed : INT
    VAR_INPUT pct : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK ABSTRACT Base
  VAR n : INT; END_VAR
  METHOD PROTECTED Bump : INT
    n := n + 1;
    Bump := n;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FINAL Belt EXTENDS Base IMPLEMENTS IDrive
  METHOD Speed : INT
    VAR_INPUT pct : INT; END_VAR
    Speed := pct * 2 + Bump();
  END_METHOD
END_FUNCTION_BLOCK
VAR b : Belt; d : IDrive; x : INT; END_VAR
d := b;
x := d.Speed(pct := 5);`

  it("is written under this project's own namespace, and declared in addDataInfo", () => {
    const xml = toPlcopenXml(OOP)
    expect(xml).not.toMatch(/3s-software/)
    for (const kind of ['functionblock', 'method', 'interface']) {
      expect(xml).toContain(`<data name="http://www.openindustryproject.org/plcopenxml/${kind}" handleUnknown="implementation">`)
      expect(xml).toContain(`<info name="http://www.openindustryproject.org/plcopenxml/${kind}" version="1.0" vendor="http://www.openindustryproject.org">`)
    }
    expect(xml).toContain('<functionBlock xmlns="http://www.openindustryproject.org/plcopenxml" extends="Base" implements="IDrive" final="true"/>')
    expect(xml).toContain('<functionBlock xmlns="http://www.openindustryproject.org/plcopenxml" abstract="true"/>')
    expect(xml).toMatch(/<method xmlns="http:\/\/www\.openindustryproject\.org\/plcopenxml" name="Bump">METHOD PROTECTED Bump : INT/)
    expect(xml).toMatch(/<interface xmlns="http:\/\/www\.openindustryproject\.org\/plcopenxml" name="IDrive">INTERFACE IDrive\n/)
  })

  it('comes back with its methods, modifiers, base and interfaces, and still compiles', () => {
    const { source, notes } = importPlcopenXml(toPlcopenXml(OOP))
    expect(notes).toEqual([])
    expect(source).toMatch(/INTERFACE IDrive\n\s*METHOD Speed : INT/)
    expect(source).toContain('FUNCTION_BLOCK ABSTRACT Base')
    expect(source).toContain('METHOD PROTECTED Bump : INT')
    expect(source).toContain('FUNCTION_BLOCK FINAL Belt EXTENDS Base IMPLEMENTS IDrive')
    expect(() => parseAndCheck(source)).not.toThrow()
    expect(roundTrip(source)).toBe(source)
  })

  it('leaves out, and names, a method of ours that is not METHOD ... END_METHOD text', () => {
    const xml = toPlcopenXml(OOP).replace(/>METHOD PROTECTED Bump[\s\S]*?END_METHOD</, '>n := 1;<')
    const { notes } = importPlcopenXml(xml)
    expect(notes.join(' ')).toMatch(/FUNCTION_BLOCK 'Base' carries a METHOD 'Bump' that is not METHOD \.\.\. END_METHOD text/)
  })

  it('reads the other addData form found in PLCopen files written by other tools', () => {
    const N = 'http://www.3s-software.com/plcopenxml/'
    const xml = `<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <types><dataTypes/><pous>
    <pou name="Counter" pouType="functionBlock">
      <interface>
        <localVars><variable name="n"><type><INT/></type></variable></localVars>
        <addData>
          <data name="${N}pouinheritance" handleUnknown="implementation"><Inheritance><Implements>ICount</Implements></Inheritance></data>
        </addData>
      </interface>
      <body><ST><xhtml:p></xhtml:p></ST></body>
      <addData>
        <data name="${N}method" handleUnknown="implementation">
          <Method name="Bump">
            <interface>
              <returnType><INT/></returnType>
              <inputVars><variable name="amount"><type><INT/></type></variable></inputVars>
            </interface>
            <body><ST><xhtml:p>n := n + amount; Bump := n;</xhtml:p></ST></body>
          </Method>
        </data>
        <data name="${N}method" handleUnknown="implementation">
          <Method name="Hidden">
            <interface>
              <addData><data name="${N}accessmodifiers" handleUnknown="implementation"><AccessModifiers Private="true"/></data></addData>
            </interface>
            <body><ST><xhtml:p>n := 0;</xhtml:p></ST></body>
          </Method>
        </data>
      </addData>
    </pou>
    <pou name="Main" pouType="program">
      <interface><localVars>
        <variable name="c"><type><derived name="Counter"/></type></variable>
        <variable name="x"><type><INT/></type></variable>
      </localVars></interface>
      <body><ST><xhtml:p>x := c.Bump(amount := 2);</xhtml:p></ST></body>
    </pou>
  </pous></types>
  <instances><configurations/></instances>
  <addData>
    <data name="${N}interface" handleUnknown="implementation">
      <Interface name="ICount">
        <Methods><Method name="Bump"><interface><returnType><INT/></returnType><inputVars><variable name="amount"><type><INT/></type></variable></inputVars></interface></Method></Methods>
        <Inheritance><Extends>__SYSTEM.IQueryInterface</Extends></Inheritance>
      </Interface>
    </data>
  </addData>
</project>`
    const { source } = importPlcopenXml(xml)
    expect(source).toMatch(/INTERFACE ICount\nMETHOD Bump : INT/)
    expect(source).toContain('FUNCTION_BLOCK Counter IMPLEMENTS ICount')
    expect(source).toContain('METHOD PRIVATE Hidden')
    expect(() => parseAndCheck(source)).not.toThrow()
    // and written back out, it is in this project's form
    expect(toPlcopenXml(source)).not.toMatch(/3s-software/)
  })
})
