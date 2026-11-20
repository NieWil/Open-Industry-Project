// A controller that runs one program instance answers to that instance's variables by their bare names
// (plcLink.ts soleInstanceAliases): the rule that makes a program pasted in its PROGRAM ... END_PROGRAM wrapper drive
// the parts wired to `Run`, while the parts wired to `Line.Run` keep working.

import { describe, expect, it } from 'vitest'
import { unhandledProgramTags } from './bindings'
import { controllerFor, runnableSource } from './controller'
import { LocalPlcLink } from './link/plcLink'
import { wrappedProgramWarning } from './sceneProgram'

/** the link a scene builds for `source`, with its default table (what Play and the CLIs attach) */
const sceneLink = (source: string): LocalPlcLink => new LocalPlcLink(runnableSource(source, controllerFor(source, null, 10)))

const LINE = `PROGRAM Line
VAR_INPUT Go : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; END_VAR
VAR Count : INT; T1 : TON; END_VAR
Run := Go;
END_PROGRAM
`

describe('one PROGRAM, nothing else', () => {
  it('gives every variable its bare name, the declared I/O under both names', () => {
    const link = sceneLink(LINE)
    expect(Object.fromEntries(link.aliases)).toEqual({ Go: 'Line.Go', Run: 'Line.Run', Count: 'Line.Count', 'T1.Q': 'Line.T1.Q', 'T1.ET': 'Line.T1.ET' })
    expect(link.inputs).toEqual(['Line.Go', 'Go'])
    expect(link.outputs).toEqual(['Line.Run', 'Run'])
    expect(link.bindable).toEqual(['Line.Count', 'Count'])
    // one variable: a write by either name lands in the same place, and the step reports it under both
    expect(link.step({ Go: true }, 0.01)).toEqual({ 'Line.Run': true, Run: true })
    expect(link.step({ 'Line.Go': false }, 0.01)).toEqual({ 'Line.Run': false, Run: false })
    link.write({ Count: 7 })
    expect(link.watch['Line.Count']).toBe(7)
    expect(link.varInfo('Run')).toEqual(link.varInfo('Line.Run'))
    // the watch table stays one row per variable; the tag view adds the bare names for a reader by tag name
    expect(Object.keys(link.watch)).not.toContain('Run')
    expect(link.tagView['Run']).toBe(false)
    expect(link.tagView['T1.Q']).toBe(false)
  })

  it('binds a plain VAR by wiring under its bare name, and never a block member', () => {
    const link = sceneLink(LINE).withBindings({ inputs: ['Count', 'T1.Q'], outputs: [] })
    expect(link.inputs).toEqual(['Line.Go', 'Go', 'Count'])
    link.step({ Count: 3 }, 0.01)
    expect(link.watch['Line.Count']).toBe(3)
  })

  it('keeps a declared input an input under its bare name, whatever the parts say', () => {
    const link = sceneLink(LINE).withBindings({ inputs: [], outputs: ['Go'] })
    expect(link.outputs).toEqual(['Line.Run', 'Run'])
  })

  it('never shadows a name the program has: a controller tag keeps its bare name', () => {
    const source = `${LINE}\nVAR Run : BOOL; END_VAR\n`
    const link = sceneLink(source)
    expect(link.aliases.has('Run')).toBe(false)
    expect(link.aliases.get('Go')).toBe('Line.Go')
    // ...ignoring case, as IEC compares names
    expect(sceneLink(`${LINE}\nVAR RUN : BOOL; END_VAR\n`).aliases.has('Run')).toBe(false)
  })

  it('reports a variable wired by either name as bound, and an unwired one once', () => {
    const wired = (tag: string): Parameters<typeof unhandledProgramTags>[0] => [{ id: 'p', type: 'annotation', params: { tag } }] // a readout note: the simplest thing that handles a tag
    const link = sceneLink(LINE)
    expect(unhandledProgramTags(wired('Go'), link).unbound).toEqual(['Line.Run'])
    expect(unhandledProgramTags(wired('Line.Go'), link).unbound).toEqual(['Line.Run'])
  })

  it('needs no warning', () => {
    expect(wrappedProgramWarning('s', LINE, ['Go'])).toBeNull()
  })
})

describe('no bare names', () => {
  it('for two program instances: `Run` would be ambiguous', () => {
    const two = `${LINE}\nPROGRAM Other\nVAR_OUTPUT Run : BOOL; END_VAR\nRun := TRUE;\nEND_PROGRAM\n`
    expect(sceneLink(two).aliases.size).toBe(0)
    expect(wrappedProgramWarning('s', two, ['Run'])).toMatch(/only a program that runs as ONE instance/)
    expect(wrappedProgramWarning('s', two, ['Line.Run'])).toBeNull() // the scene meant the qualified names
  })

  it('beside code outside every PROGRAM, whose variables are the bare tags already', () => {
    const link = sceneLink(`${LINE}\nVAR_OUTPUT Lamp : BOOL; END_VAR\nLamp := TRUE;\n`)
    expect(link.aliases.size).toBe(0)
    expect(link.outputs).toEqual(['Lamp', 'Line.Run'])
  })

  it('for code with no PROGRAM at all', () => {
    expect(sceneLink('VAR_INPUT Go : BOOL; END_VAR\nVAR_OUTPUT Run : BOOL; END_VAR\nRun := Go;\n').aliases.size).toBe(0)
  })
})
