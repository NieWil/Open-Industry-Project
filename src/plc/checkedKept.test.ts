// One reading of a program for its problems and its compile (checker.ts keepCheckedPrograms).
import { afterEach, describe, expect, it } from 'vitest'
import { diagnostics, keepCheckedPrograms, parseAndCheck } from './checker'
import { compile } from './interpreter'

const IEC = `
PROGRAM Main
VAR
  Count : INT;
  Run : BOOL;
  Speed : REAL := 1.5;
END_VAR
IF Run THEN Count := Count + 1; END_IF;
Speed := Speed * 2.0;
END_PROGRAM
`
const tree = (v: unknown): string => JSON.stringify(v)

afterEach(() => keepCheckedPrograms(false))

describe('a program checked for its problems, kept for the compile', () => {
  it('is the tree a compile checks for itself', () => {
    const fresh = tree(parseAndCheck(IEC).ast)
    keepCheckedPrograms(true)
    expect(diagnostics(IEC + ' ')).toEqual([]) // (a text the diagnostics memo has not seen)
    diagnostics(IEC)
    expect(tree(parseAndCheck(IEC).ast)).toBe(fresh)
  })

  it('is handed out once, and only for the same text', () => {
    keepCheckedPrograms(true)
    const text = IEC + '\n(* once *)'
    diagnostics(text)
    expect(parseAndCheck(IEC)).not.toBe(parseAndCheck(IEC)) // another text: checked afresh each time
    const first = parseAndCheck(text)
    expect(parseAndCheck(text)).not.toBe(first)
  })

  it('keeps nothing of a program with an error, which still refuses to compile', () => {
    keepCheckedPrograms(true)
    const bad = IEC.replace('Count + 1', 'Count + Missing')
    expect(diagnostics(bad).some((d) => d.severity !== 'warning')).toBe(true)
    expect(() => compile(bad)).toThrow(/Missing/)
  })

  it('runs as a program compiled on its own does', () => {
    const scan = (p: ReturnType<typeof compile>): unknown => {
      p.setInput('Main.Run', true)
      p.scan(0.01)
      p.scan(0.01)
      return p.watch
    }
    const alone = scan(compile(IEC))
    keepCheckedPrograms(true)
    const text = IEC + '\n'
    diagnostics(text)
    expect(scan(compile(text))).toEqual(alone)
  })
})
