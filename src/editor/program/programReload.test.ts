// When is the running program out of date? The PLC dock's Reload is lit exactly then, so a false positive is a button
// that invites a pointless restart and a false negative is edits that silently never run.

import { describe, expect, it } from 'vitest'
import { defaultController } from '../../plc'
import { attachedProgram, programOutOfDate, type ProgramInputs } from './programReload'

// the three shapes a program runs in: its text as written, the default table, and a table of its own
const TOP_LEVEL = 'VAR_OUTPUT Lamp : BOOL; END_VAR\nLamp := TRUE;\n'
const WITH_PROGRAM = 'PROGRAM Main\nVAR_OUTPUT Lamp : BOOL; END_VAR\nLamp := TRUE;\nEND_PROGRAM\n'

const doc = (stProgram: string, extra: Partial<ProgramInputs> = {}): ProgramInputs => ({ stProgram, controller: null, stScanMs: 20, ...extra })

describe('whether the running program is out of date', () => {
  it('is not, right after an attach, in any of the three shapes', () => {
    const own = defaultController(WITH_PROGRAM, 50)
    for (const d of [doc(TOP_LEVEL), doc(WITH_PROGRAM), doc(WITH_PROGRAM, { controller: own })]) {
      expect(programOutOfDate(attachedProgram(d), d)).toBe(false)
    }
  })

  it('is, once the text changes', () => {
    const at = attachedProgram(doc(TOP_LEVEL))
    expect(programOutOfDate(at, doc(TOP_LEVEL.replace('TRUE', 'FALSE')))).toBe(true)
  })

  // Task edits mid-run are not applied live either: only a scan time reaches a running program, and not always.
  it('is, once the controller table changes, but not for an equal table in a new object (a peer’s echo)', () => {
    const own = defaultController(WITH_PROGRAM, 50)
    const at = attachedProgram(doc(WITH_PROGRAM, { controller: own }))
    expect(programOutOfDate(at, doc(WITH_PROGRAM, { controller: structuredClone(own) }))).toBe(false)
    expect(programOutOfDate(at, doc(WITH_PROGRAM, { controller: defaultController(WITH_PROGRAM, 10) }))).toBe(true)
    expect(programOutOfDate(at, doc(WITH_PROGRAM))).toBe(true) // the table dropped
  })

  // The worker's live retune moves the period of a program with no tasks. The default table carries the scan time as
  // its task's INTERVAL, which that retune cannot reach, so there the edit waits for a reload like any other.
  it('counts a scan-time edit only where the attach baked the scan time in', () => {
    const retime = (d: ProgramInputs): ProgramInputs => ({ ...d, stScanMs: d.stScanMs * 2 })
    const top = doc(TOP_LEVEL)
    expect(programOutOfDate(attachedProgram(top), retime(top))).toBe(false)
    const def = doc(WITH_PROGRAM)
    expect(programOutOfDate(attachedProgram(def), retime(def))).toBe(true)
    const own = doc(WITH_PROGRAM, { controller: defaultController(WITH_PROGRAM, 50) })
    expect(programOutOfDate(attachedProgram(own), retime(own))).toBe(false) // its tasks carry their own intervals
  })

  it('is, when nothing is attached: a runtime fault dropped the program', () => {
    expect(programOutOfDate(null, doc(TOP_LEVEL))).toBe(true)
  })

  // The attempt is recorded whether or not it compiled, so a program that failed to attach is not offered again
  // until it changes: reloading the same text would fail the same way.
  it('is not, for the same text that just failed to attach', () => {
    const broken = doc('PROGRAM Main\nLamp := ;\n')
    expect(programOutOfDate(attachedProgram(broken), broken)).toBe(false)
    expect(programOutOfDate(attachedProgram(broken), doc('PROGRAM Main\nLamp := TRUE;\n'))).toBe(true)
  })
})
