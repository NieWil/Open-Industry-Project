import { describe, expect, it } from 'vitest'
import { compiledOnce } from './compiledProgram'

describe('the open program, compiled once for its readers', () => {
  it('gives the same compiled program for the same text', () => {
    const src = 'VAR_OUTPUT\n  Run : BOOL;\nEND_VAR\nRun := TRUE;'
    const first = compiledOnce(src)
    expect(first.error).toBeNull()
    expect(first.program?.outputs).toEqual(['Run'])
    expect(compiledOnce(src).program).toBe(first.program)
  })

  it('compiles again when the text changes, and keeps only the newest', () => {
    const a = compiledOnce('VAR n : INT; END_VAR\nn := 1;').program
    const b = compiledOnce('VAR n : INT; END_VAR\nn := 2;').program
    expect(b).not.toBe(a)
    expect(compiledOnce('VAR n : INT; END_VAR\nn := 2;').program).toBe(b)
  })

  it('keeps why a program does not compile, and does not try again for the same text', () => {
    const broken = compiledOnce('n := ;')
    expect(broken.program).toBeNull()
    expect(broken.error).toBeTruthy()
    expect(compiledOnce('n := ;')).toBe(broken)
  })
})
