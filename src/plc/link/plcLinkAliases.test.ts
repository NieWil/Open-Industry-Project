// A link's bare-name aliases, built on demand (plcLink.ts Aliases): every answer must be the one the whole table
// gives (soleInstanceAliases), and a read that binding makes must not build that table.
import { afterEach, describe, expect, it } from 'vitest'
import { compile, setScanEngine } from '../interpreter'
import { surfaceOf } from '../programSurface'
import type { CompiledProgram } from '../types'
import { Aliases, aliasesOfProgram, boundNames, declaredAliases, LocalPlcLink, soleInstanceAliases } from './plcLink'

const CONFIG = (programs: string): string => `
CONFIGURATION C
  TASK T(INTERVAL := T#10ms, PRIORITY := 0);
${programs}
END_CONFIGURATION
`
// one instance, with every kind of variable an alias can lead to, and globals that take some of the bare names
const SOLE = `
TYPE Zone : STRUCT
  Run : BOOL;
  Count : DINT;
END_STRUCT; END_TYPE

VAR_GLOBAL
  RUN : BOOL;            (* takes the bare name of Line.Run, in another case *)
  Label : STRING;        (* a global no part can wire still takes its name *)
  Limit : INT := 7;
  Shared : Zone;
END_VAR

PROGRAM Sorter
VAR_INPUT Eye : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
VAR
  Run : BOOL;
  Label : INT;
  Count : DINT;
  Name : STRING;
  Speed : REAL;
  Dwell : TON;
  Zones : ARRAY[0..3] OF Zone;
  One : Zone;
END_VAR
Dwell(IN := Eye, PT := T#1s);
Motor := Dwell.Q AND Run;
Count := Count + 1;
END_PROGRAM
${CONFIG('  PROGRAM Line WITH T : Sorter;')}`

const TWO = SOLE.replace('  PROGRAM Line WITH T : Sorter;', '  PROGRAM Line WITH T : Sorter;\n  PROGRAM Line2 WITH T : Sorter;')

/** a line of `n` stations in one instance: what a large program's table looks like */
function large(n: number): string {
  const decls: string[] = []
  const body: string[] = []
  for (let s = 0; s < n; s++) {
    decls.push(`  Eye${s}, Run${s} : BOOL;`, `  Z${s} : ARRAY[0..9] OF Zone;`, `  T${s} : TON;`)
    body.push(`T${s}(IN := Eye${s}, PT := T#1s);`, `Run${s} := T${s}.Q;`)
  }
  return `TYPE Zone : STRUCT Run : BOOL; Count : DINT; END_STRUCT; END_TYPE
PROGRAM Main
VAR
${decls.join('\n')}
END_VAR
${body.join('\n')}
END_PROGRAM
${CONFIG('  PROGRAM Main WITH T : Main;')}`
}

const PROGRAMS: [string, string][] = [
  ['one instance beside globals', SOLE],
  ['two instances', TWO],
  ['a large line', large(40)],
]
/** names that are no alias, of each kind a reader may ask about */
const NOT_ALIASES = ['Nothing', 'nothing.Q', 'Line.Run', 'RUN', 'Limit', 'Shared.Run', 'Zones[99].Run', 'Dwell.Nothing', '', '0', 'Zones', 'One']

afterEach(() => {
  setScanEngine('typed')
})

describe.each(['typed', 'walker'] as const)('bare-name aliases built on demand (%s engine)', (engine) => {
  const built = (src: string): CompiledProgram => {
    setScanEngine(engine)
    return compile(src)
  }

  it.each(PROGRAMS)('%s: every alias is the one the whole table has', (_name, src) => {
    const program = built(src)
    const whole = soleInstanceAliases(program)
    for (const [bare, variable] of whole) expect(aliasesOfProgram(program).get(bare), bare).toBe(variable)
    for (const name of NOT_ALIASES) expect(aliasesOfProgram(program).get(name), name).toBe(whole.get(name))
    const lazy = aliasesOfProgram(program)
    expect([...lazy]).toEqual([...whole])
    expect(lazy.size).toBe(whole.size)
    expect([...lazy.keys()]).toEqual([...whole.keys()])
    expect(lazy.has('Nothing')).toBe(false)
  })

  it.each(PROGRAMS)('%s: the names a scene binds by have the aliases the whole table gives them', (_name, src) => {
    const program = built(src)
    const whole = soleInstanceAliases(program)
    const listed = new Set([...program.inputs, ...program.outputs, ...program.bindable])
    const lazy = aliasesOfProgram(program)
    expect([...declaredAliases(lazy)]).toEqual([...whole].filter(([, variable]) => listed.has(variable)))
    // and so a scene binds exactly as it did
    const wired = { inputs: ['Run', 'Eye', 'Nothing'], outputs: ['Speed', 'Count', 'Line.Motor'] }
    expect(boundNames(program, lazy, wired)).toEqual(boundNames(program, whole, wired))
    expect(surfaceOf(program).aliases).toEqual([...whole].filter(([, variable]) => listed.has(variable)))
  })

  it('binding, and a name the instance has no variable for, do not build the whole table', () => {
    const program = built(SOLE)
    const lazy = aliasesOfProgram(program)
    expect(lazy).toBeInstanceOf(Aliases)
    const table = lazy as Aliases
    expect(table.get('Eye')).toBe('Line.Eye')
    expect(table.get('Motor')).toBe('Line.Motor')
    expect(table.get('Speed')).toBe('Line.Speed')
    expect(table.get('Run')).toBeUndefined() // the global RUN has the name
    expect(table.get('Nothing')).toBeUndefined()
    expect(table.get('nothing.Q')).toBeUndefined()
    expect(table.get('Line.Run')).toBeUndefined()
    new LocalPlcLink(program, { inputs: ['Eye'], outputs: ['Speed'] })
    surfaceOf(program)
    expect(table.built).toBe(false)
    // a path inside a variable is not a name a scene binds by: the table is built for it, once
    expect(table.get('Dwell.Q')).toBe('Line.Dwell.Q')
    expect(table.get('Zones[2].Count')).toBe('Line.Zones[2].Count')
    expect(table.built).toBe(true)
  })

  it('a link answers by bare name as it did', () => {
    const program = built(SOLE)
    const link = new LocalPlcLink(program, { inputs: ['Eye'], outputs: ['Speed'] })
    link.write({ Eye: true, Count: 5 })
    link.step({}, 0.01)
    expect(link.watch['Line.Count']).toBe(6)
    expect(link.tagView['Count']).toBe(6)
    expect(link.tagView['Dwell.Q']).toBe(link.watch['Line.Dwell.Q'])
    expect('Dwell.Q' in link.tagView).toBe(true)
    expect(link.varInfo('Speed')?.type).toBe('REAL')
    expect(link.inputs).toContain('Eye')
    expect(link.bindable).toContain('Speed')
  })
})
