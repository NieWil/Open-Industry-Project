// The way in, checked mostly by the way out.
//
// The strongest property available here is a round trip: the exporter wraps a program in the
// configuration layer the subset lacks, so importing that file must give the program back. It
// is a strong check precisely because neither side can cheat alone - the corpus is the widest
// spread of valid ST in the repo, and every case has to survive both directions. A file that
// came from this editor importing as a no-op is the same property stated at the other end.
//
// What a round trip cannot check is a file this project never wrote: a vendor's own export,
// with located variables, VAR_EXTERNAL and retention. Those have their own cases below, and
// the rule there is that nothing is silently swallowed - if the subset has no place for it,
// the importer says so.
import { describe, expect, it } from 'vitest'
import { importIecText } from './importText'
import { canonicalSyntax, controllerBody, renderIecText } from './exportText'
import { parseAndCheck } from '../checker'
import { CONFORMANCE_CASES } from '../conformanceCases'

/** compare ST ignoring only whitespace runs, so a real change of meaning cannot hide */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

describe('a program exported and imported again is the same program', () => {
  // code outside every POU beside a CONFIGURATION is an extension, so it comes back as the IEC it was
  // exported as, a PROGRAM of its own; that is checked below rather than text for text
  const valid = CONFORMANCE_CASES.filter((c) => !c.rejects && controllerBody(c.src) === null)

  it('round-trips every corpus case, text for text', () => {
    for (const c of valid) {
      const { source, notes } = importIecText(renderIecText(c.src, { banner: false }))
      // what went out is the program in the spelling every compiler reads (exportText.ts `canonicalSyntax`)
      expect(norm(source), c.name).toBe(norm(canonicalSyntax(c.src, { iecText: true })))
      expect(notes, c.name).toEqual([])
    }
  })

  it('round-trips through the banner the export writes too', () => {
    // the banner is a comment block, so it rides along; what matters is that it cannot be
    // mistaken for code on the way back in
    const { source } = importIecText(renderIecText('VAR a : INT; END_VAR\na := 1;'))
    expect(norm(source)).toContain('VAR a : INT; END_VAR a := 1;')
    expect(() => parseAndCheck(source)).not.toThrow()
  })

  it('recovers the task period, so the scan time can follow the file', () => {
    expect(importIecText(renderIecText('VAR a : INT; END_VAR\na := 1;', { scanMs: 25 })).scanMs).toBe(25)
    expect(importIecText(renderIecText('VAR a : INT; END_VAR\na := 1;')).scanMs).toBe(100)
  })

  it('leaves a program that is already in the implicit form alone', () => {
    // what this editor holds: no CONFIGURATION, no PROGRAM header
    const plain = 'VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR\nq := go;'
    const { source, notes, scanMs } = importIecText(plain)
    expect(norm(source)).toBe(norm(plain))
    expect(notes).toEqual([])
    expect(scanMs).toBeNull()
  })
})

describe('a file from somewhere else', () => {
  const VENDOR = `(* exported from a vendor toolchain *)
FUNCTION_BLOCK Seal
VAR_INPUT S : BOOL; R : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := (Q OR S) AND NOT R;
END_FUNCTION_BLOCK

PROGRAM Cell
VAR_EXTERNAL Level : INT; END_VAR
VAR Start AT %IX0.0 : BOOL; Motor AT %QX0.1 : BOOL; Flag AT %MX0.2 : BOOL; RETAIN hours : DINT; END_VAR
VAR seal : Seal; END_VAR
seal(S := Start, R := FALSE, Q => Motor);
END_PROGRAM

CONFIGURATION Plant
  VAR_GLOBAL Level : INT; END_VAR
  RESOURCE CPU ON PLC
    TASK Fast(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM P1 WITH Fast : Cell;
  END_RESOURCE
END_CONFIGURATION`

  const result = importIecText(VENDOR)

  it('keeps the POUs and the program body, and hoists the globals to the top', () => {
    expect(result.source).toContain('FUNCTION_BLOCK Seal')
    expect(result.source).toContain('seal(S := Start, R := FALSE, Q => Motor);')
    expect(result.source.indexOf('VAR_GLOBAL Level : INT; END_VAR')).toBeLessThan(result.source.indexOf('FUNCTION_BLOCK Seal'))
    expect(result.source).not.toContain('CONFIGURATION')
    expect(result.source).not.toContain('END_PROGRAM')
  })

  it('adopts the file\'s own task period', () => {
    expect(result.scanMs).toBe(20)
  })

  it('names everything the subset has no place for, instead of swallowing it', () => {
    expect(result.notes.join('\n')).toMatch(/RETAIN/)
  })

  it('keeps an input or output address as written: the scene binds the variable by it', () => {
    expect(result.source).toContain('Start AT %IX0.0 : BOOL; Motor AT %QX0.1 : BOOL;')
    expect(result.notes.join('\n')).not.toMatch(/%IX0\.0|%QX0\.1/)
  })

  it('keeps a memory address as written, with nothing to fix: the program keeps the variable', () => {
    expect(result.source).toContain('Flag AT %MX0.2 : BOOL;')
    expect(result.notes.join('\n')).not.toMatch(/%MX0\.2/)
  })

  it('keeps a VAR_EXTERNAL, which this engine checks against the global it names', () => {
    expect(result.source).toContain('VAR_EXTERNAL Level : INT; END_VAR')
    expect(result.notes.join(' ')).not.toMatch(/VAR_EXTERNAL/)
  })

  it('reports a second resource rather than pretending it ran', () => {
    const two = importIecText(`PROGRAM A
VAR x : INT; END_VAR
x := 1;
END_PROGRAM

CONFIGURATION Plant
  RESOURCE CPU1 ON PLC
    TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM P1 WITH T1 : A;
  END_RESOURCE
  RESOURCE CPU2 ON PLC
    TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM P2 WITH T2 : A;
  END_RESOURCE
END_CONFIGURATION`)
    expect(two.notes.join(' ')).toMatch(/2 RESOURCEs/)
  })

  it('is not fooled by a keyword inside a comment', () => {
    const { source } = importIecText(`(* the CONFIGURATION below is generated *)
VAR a : INT; END_VAR
a := 1; (* END_PROGRAM is not here *)`)
    expect(source).toContain('a := 1;')
    expect(source).toContain('(* END_PROGRAM is not here *)')
  })

  it('does not raise a note for a construct only mentioned in a comment', () => {
    // the same blindness the exporter had (a STRING[16] merely named in a comment invented a
    // type for itself), pointed at the notes channel: a note naming a variable the file never
    // declares sends someone hunting for I/O that is not there, and every spurious one makes
    // the real notes easier to skip past
    const { notes } = importIecText(`(* was: Flag AT %MX0.0, with RETAIN hours and a VAR_EXTERNAL *)
VAR a : INT; END_VAR
a := 1;`)
    expect(notes).toEqual([])
  })

  it('still reports the same constructs when they are really declared', () => {
    const { notes } = importIecText('VAR Flag AT %I* : BOOL; END_VAR\nFlag := FALSE;')
    expect(notes.join(' ')).toMatch(/AT %I\*: an incomplete address, which the target's I\/O configuration completes/)
  })
})

describe('code outside every POU beside a CONFIGURATION crosses as the IEC it is exported as', () => {
  it('comes back as a PROGRAM of its own on the same tasks, and compiles', () => {
    const cases = CONFORMANCE_CASES.filter((c) => !c.rejects && controllerBody(c.src) !== null)
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const { source, notes } = importIecText(renderIecText(c.src, { banner: false }))
      expect(notes, c.name).toEqual([])
      const back = parseAndCheck(source).ast
      expect(back.configuration?.tasks.map((t) => t.name), c.name).toEqual(parseAndCheck(c.src).ast.configuration?.tasks.map((t) => t.name))
      expect(back.configuration?.programs.every((p) => p.type !== null), c.name).toBe(true)
    }
  })
})

describe('a controller crosses as written', () => {
  // two PROGRAMs on two tasks: both must come in, not just the first with the second noted as dropped
  const CONTROLLER = `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM

PROGRAM Idle
VAR k : INT; END_VAR
k := 0;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Slow(INTERVAL := T#30ms, PRIORITY := 2);
    PROGRAM FastCount WITH Fast : Counter;
    PROGRAM Waiting WITH Slow : Idle;
  END_RESOURCE
END_CONFIGURATION`

  const result = importIecText(CONTROLLER)

  it('keeps every PROGRAM and the CONFIGURATION, and adopts no single scan time', () => {
    expect(norm(result.source)).toBe(norm(CONTROLLER))
    expect(result.scanMs).toBeNull()
    expect(result.notes).toEqual([])
  })

  it('compiles into the tasks it declares', () => {
    expect(parseAndCheck(result.source).ast.configuration?.tasks.map((t) => [t.name, t.periodMs])).toEqual([
      ['Fast', 10],
      ['Slow', 30],
    ])
  })

  it('names what will not run as written, without dropping it', () => {
    const event = importIecText(CONTROLLER.replace('TASK Slow(INTERVAL := T#30ms, PRIORITY := 2);', 'TASK Slow(SINGLE := go, PRIORITY := 2);'))
    expect(event.source).toContain('SINGLE := go')
    expect(event.notes.join(' ')).toMatch(/event task \(SINGLE\)/)
  })
})

describe('what the round trip does not preserve', () => {
  // The corpus round-trip above compares text for text, which is only as wide as the corpus:
  // every case there happens to declare its VAR_GLOBAL first, so nothing exercises the one
  // thing the trip genuinely moves. Export puts globals on the CONFIGURATION and import hoists
  // them back to the top of the file, so a global authored below a TYPE returns above it.
  // That is intended (see the vendor case, which asserts the hoist) and it is semantically
  // free - the parser takes those blocks in any order - but "text for text" is not true of it,
  // and an untested claim in that shape is what let the comment bugs through twice.
  const src = `TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE
VAR_GLOBAL Level : INT; END_VAR
VAR p : Pt; END_VAR
p.x := Level;`

  const { source, notes } = importIecText(renderIecText(src, { banner: false }))

  it('hoists a VAR_GLOBAL above a TYPE that was authored before it', () => {
    expect(notes).toEqual([])
    expect(source.indexOf('VAR_GLOBAL')).toBeLessThan(source.indexOf('TYPE Pt'))
    expect(norm(source)).not.toBe(norm(src)) // the text moved...
  })

  it('gives back the same program, and is stable on a second trip', () => {
    expect(() => parseAndCheck(source)).not.toThrow() // ...but the program is intact,
    const again = importIecText(renderIecText(source, { banner: false }))
    expect(norm(again.source)).toBe(norm(source)) // and the hoist is a fixpoint, not a drift
  })

  it('moves a file-level VAR_GLOBAL into a CONFIGURATION the file declares, where it then stays', () => {
    // the mirror of the hoist above: IEC puts globals on the CONFIGURATION, a controller crosses back in
    // as written, so a global authored at the top of such a file comes back inside the CONFIGURATION
    const controller = `VAR_GLOBAL total : INT; END_VAR

PROGRAM Add
VAR_EXTERNAL total : INT; END_VAR
total := total + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM A WITH Main : Add;
    PROGRAM B WITH Main : Add;
  END_RESOURCE
END_CONFIGURATION`
    const once = importIecText(renderIecText(controller, { banner: false }))
    expect(once.notes).toEqual([])
    expect(once.source.indexOf('CONFIGURATION Cell')).toBeLessThan(once.source.indexOf('VAR_GLOBAL'))
    expect(() => parseAndCheck(once.source)).not.toThrow()
    const twice = importIecText(renderIecText(once.source, { banner: false }))
    expect(norm(twice.source)).toBe(norm(once.source))
  })
})
