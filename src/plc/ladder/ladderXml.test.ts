// Ladder Diagram through PLCopen TC6 (ladderXml.ts): the <LD> graph a ladder POU exports as, and the rungs read back
// out of one written by hand from TC6's schema alone, and what the reader refuses rather than guesses.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from '../conformanceCases'
import { toPlcopenXml } from '../exchange/export'
import { importPlcopenXml, parseXml } from '../exchange/importXml'
import { compile } from '../interpreter'
import { readLdBody } from './ladderXml'
import type { TagValue } from '../types'

/** Run a program's case steps, returning every watched variable after each scan. */
function run(src: string, steps: { in?: Record<string, TagValue>; dt?: number }[], watch: string[]): Record<string, TagValue | undefined>[] {
  const p = compile(src)
  return steps.map((s) => {
    for (const [k, v] of Object.entries(s.in ?? {})) p.setInput(k, v)
    p.scan(s.dt ?? 0.1)
    return Object.fromEntries(watch.map((w) => [w, p.get(w)]))
  })
}

const ldCases = CONFORMANCE_CASES.filter((c) => /LADDER/.test(c.src) && !c.rejects)

describe('a ladder POU through PLCopen and back', () => {
  it('draws every corpus ladder as <LD> and reads back a program that runs the same, scan for scan', () => {
    expect(ldCases.length).toBeGreaterThan(8)
    for (const c of ldCases) {
      const xml = toPlcopenXml(c.src)
      expect(xml, c.name).toContain('<LD>')
      const back = importPlcopenXml(xml)
      expect(back.notes, c.name).toEqual([])
      expect(back.source, c.name).toMatch(/LADDER[\s\S]*END_LADDER/)
      const watch = [...new Set(c.steps.flatMap((s) => Object.keys(s.expect ?? {})))]
      expect(run(back.source, c.steps, watch), `${c.name}\n${back.source}`).toEqual(run(c.src, c.steps, watch))
    }
  })

  it('reads the rungs back as they were written, but for coils in series, which it draws in parallel', () => {
    const src = `VAR_INPUT A, B : BOOL; END_VAR VAR_OUTPUT X, Y, Z : BOOL; W : TIME; END_VAR VAR T1 : TON; END_VAR
LADDER
  [|A|, |X|] |/B| (X);
  |A| T1(IN, PT := T#2s, ET => W) (Y) (Z);
END_LADDER`
    const back = importPlcopenXml(toPlcopenXml(src)).source
    expect(back).toContain('[|A|, |X|] |/B| (X);')
    expect(back).toContain('|A| T1(IN, PT := T#2s, ET => W, Q) [(Y), (Z)];')
  })

  it('draws a comparison that starts a rung with nothing linked into it, and reads it back', () => {
    const src = `VAR_INPUT A, B : BOOL; N : INT; END_VAR VAR_OUTPUT X, Y : BOOL; END_VAR
LADDER
  EQ(IN1 := N, IN2 := 3, OUT) |A| (X);
  [GT(IN1 := N, IN2 := 5, OUT), |B|] (Y);
END_LADDER`
    const xml = toPlcopenXml(src)
    const eq = /<block localId="(\d+)"[^>]*typeName="EQ">[\s\S]*?<\/block>/.exec(xml)!
    // the rail feeds none of its pins: both come from inVariables
    const railId = /<leftPowerRail localId="(\d+)"/.exec(xml)![1]
    expect(eq[0]).not.toContain(`refLocalId="${railId}"`)
    expect(xml).toContain(`<connection refLocalId="${eq[1]}" formalParameter="OUT"/>`)
    const back = importPlcopenXml(xml).source
    expect(back).toContain('EQ(IN1 := N, IN2 := 3, OUT) |A| (X);')
    expect(back).toContain('[GT(IN1 := N, IN2 := 5, OUT), |B|] (Y);')
  })
})

// A ladder written from TC6's schema alone, in the plainest shape it allows: every position 0,0 (positions are
// required, their values are not, so order comes from the file), the rails shared by every network, and what TC6 lets
// a tool add for itself - a vendorElement, addData - under a namespace made up for this test, which nothing here knows.
const EXTENSION = 'http://example.org/made-up-tool/decoration'

/** A network's lead-in: a comment, then a vendorElement carrying addData under the made-up namespace. */
const network = (id: number, title: string): string => `
      <comment localId="${id}" height="0" width="0"><position x="0" y="0"/><content><xhtml xmlns="http://www.w3.org/1999/xhtml">${title}</xhtml></content></comment>
      <vendorElement localId="${id + 1}"><position x="0" y="0"/><alternativeText><xhtml xmlns="http://www.w3.org/1999/xhtml">banner</xhtml></alternativeText>
        <addData><data name="${EXTENSION}/banner" handleUnknown="discard"><Banner xmlns="" style="wide"/></data></addData></vendorElement>`

const pinIn = (name: string, from: number): string => `<variable formalParameter="${name}"><connectionPointIn><connection refLocalId="${from}"/></connectionPointIn></variable>`
const inVar = (id: number, expr: string): string => `<inVariable localId="${id}"><position x="0" y="0"/><connectionPointOut/><expression>${expr}</expression></inVariable>`

const SCHEMA_SHAPED = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types><dataTypes/><pous>
  <pou name="Cell" pouType="program">
    <interface><localVars>
      <variable name="Start"><type><BOOL/></type></variable><variable name="Stop"><type><BOOL/></type></variable>
      <variable name="Motor"><type><BOOL/></type></variable><variable name="Eye"><type><BOOL/></type></variable>
      <variable name="Late"><type><BOOL/></type></variable><variable name="Waited"><type><TIME/></type></variable>
      <variable name="Count"><type><INT/></type></variable><variable name="Counted"><type><BOOL/></type></variable>
      <variable name="T1"><type><derived name="TON"/></type></variable>
    </localVars></interface>
    <body><LD>
      <leftPowerRail localId="0"><position x="0" y="0"/><connectionPointOut formalParameter=""/></leftPowerRail>
      ${network(1, 'seal-in')}
      <contact localId="3"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Start</variable></contact>
      <contact localId="4"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Motor</variable></contact>
      <contact localId="5" negated="true"><position x="0" y="0"/><connectionPointIn><connection refLocalId="3"/><connection refLocalId="4"/></connectionPointIn><connectionPointOut/><variable>Stop</variable></contact>
      <coil localId="6"><position x="0" y="0"/><connectionPointIn><connection refLocalId="5"/></connectionPointIn><connectionPointOut/><variable>Motor</variable></coil>
      <addData><data name="${EXTENSION}/layout" handleUnknown="discard"><Layout xmlns="" grid="8"/></data></addData>
      ${network(8, '')}
      <contact localId="10"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Eye</variable></contact>
      ${inVar(11, 'T#50MS')}
      <block localId="12" typeName="TON" instanceName="T1"><position x="0" y="0"/>
        <inputVariables>${pinIn('IN', 10)}${pinIn('PT', 11)}</inputVariables><inOutVariables/>
        <outputVariables>
          <variable formalParameter="Q"><connectionPointOut/></variable>
          <variable formalParameter="ET"><connectionPointOut><expression>Waited</expression></connectionPointOut></variable>
        </outputVariables></block>
      <coil localId="13"><position x="0" y="0"/><connectionPointIn><connection refLocalId="12" formalParameter="Q"/></connectionPointIn><connectionPointOut/><variable>Late</variable></coil>
      ${network(14, '')}
      <contact localId="16" edge="rising"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Eye</variable></contact>
      ${inVar(17, 'Count')}${inVar(18, '1')}
      <block localId="19" typeName="ADD"><position x="0" y="0"/>
        <inputVariables>${pinIn('EN', 16)}${pinIn('IN1', 17)}${pinIn('IN2', 18)}</inputVariables><inOutVariables/>
        <outputVariables>
          <variable formalParameter="ENO"><connectionPointOut/></variable>
          <variable formalParameter="OUT"><connectionPointOut><expression>Count</expression></connectionPointOut></variable>
        </outputVariables></block>
      <coil localId="20"><position x="0" y="0"/><connectionPointIn><connection refLocalId="19" formalParameter="ENO"/></connectionPointIn><connectionPointOut/><variable>Counted</variable></coil>
      <rightPowerRail localId="21"><position x="0" y="0"/><connectionPointIn/></rightPowerRail>
    </LD></body>
  </pou>
  </pous></types>
  <instances><configurations/></instances>
</project>`

/** SCHEMA_SHAPED with its <LD> body swapped for `body` (the rails added around it). */
const withBody = (body: string): string => SCHEMA_SHAPED.replace(/<body><LD>[\s\S]*<\/LD><\/body>/, `<body><LD>
      <leftPowerRail localId="0"><position x="0" y="0"/><connectionPointOut formalParameter=""/></leftPowerRail>
      ${body}
      <rightPowerRail localId="2147483647"><position x="0" y="0"/><connectionPointIn/></rightPowerRail>
    </LD></body>`)

describe('reading a ladder written from the schema alone', () => {
  it('takes its networks in file order, keeps their comments, skips addData it does not know, and reads its pins', () => {
    const { source, notes } = importPlcopenXml(SCHEMA_SHAPED)
    expect(notes).toEqual([])
    expect(source).toContain(`LADDER
  (* seal-in *)
  [|Start|, |Motor|] |/Stop| (Motor);
  |Eye| T1(IN, PT := T#50MS, ET => Waited, Q) (Late);
  |P Eye| ADD(IN1 := Count, IN2 := 1, OUT => Count) (Counted);
END_LADDER`)
    expect(source).not.toContain('example.org')
    // and it is a program: the seal-in holds, the counter counts each rise once
    const t = run(source, [{ in: { Start: true } }, { in: { Start: false, Eye: true } }, {}, { in: { Eye: false } }, { in: { Eye: true } }], ['Motor', 'Count', 'Counted'])
    expect(t.map((r) => r['Motor'])).toEqual([true, true, true, true, true])
    expect(t.map((r) => r['Count'])).toEqual([0, 1, 1, 1, 2])
  })

  it('reads a comparison that starts a rung, with no EN drawn, alone or on a branch', () => {
    const compare = (id: number, type: string, a: number, b: number): string =>
      `<block localId="${id}" typeName="${type}"><position x="0" y="0"/><inputVariables>${pinIn('IN1', a)}${pinIn('IN2', b)}</inputVariables><inOutVariables/><outputVariables><variable formalParameter="OUT"><connectionPointOut/></variable></outputVariables></block>`
    const xml = withBody(`
      ${network(1, '')}
      ${inVar(5, 'Count')}${inVar(7, '5')}${compare(6, 'GT', 5, 7)}
      <contact localId="8"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Eye</variable></contact>
      <coil localId="9"><position x="0" y="0"/><connectionPointIn><connection refLocalId="6" formalParameter="OUT"/><connection refLocalId="8"/></connectionPointIn><connectionPointOut/><variable>Late</variable></coil>
      ${network(10, '')}
      ${inVar(12, 'Count')}${inVar(13, '3')}${compare(14, 'EQ', 12, 13)}
      <contact localId="15"><position x="0" y="0"/><connectionPointIn><connection refLocalId="14" formalParameter="OUT"/></connectionPointIn><connectionPointOut/><variable>Start</variable></contact>
      ${inVar(16, '7')}
      <block localId="17" typeName="MOVE"><position x="0" y="0"/><inputVariables>${pinIn('EN', 15)}${pinIn('IN', 16)}</inputVariables><inOutVariables/>
        <outputVariables><variable formalParameter="ENO"><connectionPointOut/></variable><variable formalParameter="OUT"><connectionPointOut><expression>Count</expression></connectionPointOut></variable></outputVariables></block>
      <coil localId="18"><position x="0" y="0"/><connectionPointIn><connection refLocalId="17" formalParameter="ENO"/></connectionPointIn><connectionPointOut/><variable>Counted</variable></coil>`)
    const { source, notes } = importPlcopenXml(xml)
    expect(notes).toEqual([])
    expect(source).toContain(`LADDER
  [GT(IN1 := Count, IN2 := 5, OUT), |Eye|] (Late);
  EQ(IN1 := Count, IN2 := 3, OUT) |Start| MOVE(IN := 7, OUT => Count) (Counted);
END_LADDER`)
  })
})

describe('a box pin the file does not name, or a box the rung reaches twice, is named and the POU left out', () => {
  const adder = (inputs: string, result: string): string => withBody(`
      <contact localId="1"><position x="0" y="0"/><connectionPointIn><connection refLocalId="0"/></connectionPointIn><connectionPointOut/><variable>Eye</variable></contact>
      ${inVar(2, 'Count')}${inVar(3, '1')}
      <block localId="4" typeName="ADD"><position x="0" y="0"/><inputVariables>${pinIn('EN', 1)}${inputs}</inputVariables><inOutVariables/>
        <outputVariables><variable formalParameter="ENO"><connectionPointOut/></variable><variable formalParameter="${result}"><connectionPointOut><expression>Count</expression></connectionPointOut></variable></outputVariables></block>
      <coil localId="5"><position x="0" y="0"/><connectionPointIn><connection refLocalId="4" formalParameter="ENO"/></connectionPointIn><connectionPointOut/><variable>Counted</variable></coil>`)

  it('reads the named shape (the control for the cases below)', () => {
    const r = importPlcopenXml(adder(`${pinIn('IN1', 2)}${pinIn('IN2', 3)}`, 'OUT'))
    expect(r.notes).toEqual([])
    expect(r.source).toContain('|Eye| ADD(IN1 := Count, IN2 := 1, OUT => Count) (Counted);')
  })

  it('an input pin with an empty formalParameter', () => {
    const r = importPlcopenXml(adder(`${pinIn('', 2)}${pinIn('', 3)}`, 'OUT'))
    expect(r.notes.join(' ')).toMatch(/input pin that has no name/)
    expect(r.source).not.toMatch(/LADDER/)
  })

  it('an output pin with an empty formalParameter', () => {
    const r = importPlcopenXml(adder(`${pinIn('IN1', 2)}${pinIn('IN2', 3)}`, ''))
    expect(r.notes.join(' ')).toMatch(/output pin that has no name/)
    expect(r.source).not.toMatch(/LADDER/)
  })

  it('a second input linked to the same place on the rung as the first', () => {
    const r = importPlcopenXml(adder(`${pinIn('IN1', 2)}${pinIn('IN2', 1)}`, 'OUT'))
    expect(r.notes.join(' ')).toMatch(/on the rung by two inputs, EN and IN2/)
    expect(r.source).not.toMatch(/LADDER/)
  })
})

describe('what a rung cannot express is named, and the POU left out', () => {
  const pou = (body: string): ReturnType<typeof importPlcopenXml> =>
    importPlcopenXml(
      `<project xmlns="http://www.plcopen.org/xml/tc6_0201"><types><pous><pou name="P" pouType="program"><interface><localVars><variable name="a"><type><BOOL/></type></variable><variable name="b"><type><BOOL/></type></variable><variable name="c"><type><BOOL/></type></variable><variable name="d"><type><BOOL/></type></variable><variable name="q"><type><BOOL/></type></variable></localVars></interface><body><LD><leftPowerRail localId="1"><position x="0" y="0"/><connectionPointOut formalParameter=""/></leftPowerRail>${body}</LD></body></pou></pous></types></project>`,
    )
  const contact = (id: number, v: string, ...from: number[]): string =>
    `<contact localId="${id}"><position x="0" y="0"/><connectionPointIn>${from.map((f) => `<connection refLocalId="${f}"/>`).join('')}</connectionPointIn><connectionPointOut/><variable>${v}</variable></contact>`

  it('reads a jump, the label it lands on and a return, one network each, in file order', () => {
    const coil = (id: number, v: string, from: number): string =>
      `<coil localId="${id}"><position x="0" y="0"/><connectionPointIn><connection refLocalId="${from}"/></connectionPointIn><connectionPointOut/><variable>${v}</variable></coil>`
    const r = pou(
      [
        contact(2, 'a', 1),
        '<jump localId="3" label="Past"><position x="0" y="0"/><connectionPointIn><connection refLocalId="2"/></connectionPointIn></jump>',
        contact(4, 'b', 1),
        coil(5, 'c', 4),
        '<label localId="6" label="Past"><position x="0" y="0"/></label>',
        contact(7, 'd', 1),
        '<return localId="8"><position x="0" y="0"/><connectionPointIn><connection refLocalId="7"/></connectionPointIn></return>',
        contact(9, 'b', 1),
        coil(10, 'q', 9),
      ].join(''),
    )
    expect(r.notes).toEqual([])
    expect(r.source).toContain('LADDER\n  |a| >>Past;\n  |b| (c);\n  Past: |d| RETURN;\n  |b| (q);\nEND_LADDER')
  })

  it('a connector, which a rung has no word for', () => {
    expect(pou('<connector localId="2" name="C1"><position x="0" y="0"/></connector>').notes.join(' ')).toMatch(/draws a connector in its ladder/)
  })

  it('a bridge, which has no series-parallel form', () => {
    // the Wheatstone shape: a and b from the rail, c across from a's output to b's, d after a, then one more contact
    // after b's output (which c joins) and d and it into the coil
    const bridge = [contact(2, 'a', 1), contact(3, 'b', 1), contact(4, 'c', 2), contact(5, 'd', 2), contact(6, 'c', 3, 4), `<coil localId="7"><position x="0" y="0"/><connectionPointIn><connection refLocalId="5"/><connection refLocalId="6"/></connectionPointIn><connectionPointOut/><variable>q</variable></coil>`].join('')
    const r = pou(bridge)
    expect(r.notes.join(' ')).toMatch(/not series-parallel \(a bridge\)/)
    expect(r.source).not.toMatch(/PROGRAM P|LADDER/)
  })

  it('an element nothing on the left rail reaches', () => {
    expect(pou(`<coil localId="2"><position x="0" y="0"/><connectionPointIn><connection refLocalId="9"/></connectionPointIn><connectionPointOut/><variable>q</variable></coil>`).notes.join(' ')).toMatch(/not connected to the left rail/)
  })
})

describe('the reader, on its own', () => {
  it('takes a document with no rungs as an empty section', () => {
    expect(readLdBody(parseXml('<LD/>'), 'P', () => {})).toBe('LADDER\nEND_LADDER')
  })
})
