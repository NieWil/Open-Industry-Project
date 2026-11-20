// A controller: PROGRAM POUs run as the instances a CONFIGURATION declares, grouped into tasks
// that each scan on their own interval. These pin the model directly (what compiles, what is
// refused and why, how instances are addressed) and the scheduler (which scan runs when). The
// conformance corpus checks the same behaviour against MATIEC.

import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { toTypeScript } from './emit'
import { exportProgram, toPlcopenXml } from './exchange/export'
import { renderIecText } from './exchange/exportText'
import { compile } from './interpreter'
import { TaskScheduler } from './scanEngine'
import type { TaskInfo } from './types'

const TWO_RATES = `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Slow(INTERVAL := T#30ms, PRIORITY := 2);
    PROGRAM FastCount WITH Fast : Counter;
    PROGRAM SlowCount WITH Slow : Counter;
  END_RESOURCE
END_CONFIGURATION
`

/** One PROGRAM type `P` and a CONFIGURATION around the given task and instance lines. */
const inConfig = (tasks: string, programs: string): string =>
  `PROGRAM P\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\nCONFIGURATION Cell\n  RESOURCE Res0 ON PLC\n${tasks}\n${programs}\n  END_RESOURCE\nEND_CONFIGURATION`
const TASK = '    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);'
const INSTANCE = '    PROGRAM I WITH Main : P;'

describe('a CONFIGURATION compiles into tasks and program instances', () => {
  it('lists its tasks with their periods, priorities and programs', () => {
    expect(compile(TWO_RATES).tasks).toEqual([
      { name: 'Fast', kind: 'periodic', periodSec: 0.01, priority: 1, programs: ['FastCount'] },
      { name: 'Slow', kind: 'periodic', periodSec: 0.03, priority: 2, programs: ['SlowCount'] },
    ])
  })

  it('addresses an instance variable as Instance.Name, each instance with its own state', () => {
    const p = compile(`PROGRAM Echo
VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT run : BOOL; END_VAR
run := go;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Line1 WITH Main : Echo;
    PROGRAM Line2 WITH Main : Echo;
  END_RESOURCE
END_CONFIGURATION`)
    expect(p.inputs).toEqual(['Line1.go', 'Line2.go'])
    expect(p.outputs).toEqual(['Line1.run', 'Line2.run'])
    p.setInput('line1.GO', true) // case-insensitive, like every name
    p.scanTask(0, 0.01)
    expect(p.get('Line1.run')).toBe(true)
    expect(p.get('Line2.run')).toBe(false)
    expect(p.watch).toMatchObject({ 'Line1.run': true, 'Line2.run': false })
  })

  it('shares globals across instances, under their bare names', () => {
    const p = compile(`VAR_GLOBAL total : INT; END_VAR
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
END_CONFIGURATION`)
    p.scan(0.01)
    expect(p.get('total')).toBe(2)
    expect(p.watch.total).toBe(2)
  })

  it('puts the instances with no task in a continuous task, listed last', () => {
    const p = compile(inConfig(TASK, '    PROGRAM Always : P;\n    PROGRAM Periodic WITH Main : P;'))
    expect(p.tasks.map((t) => [t.kind, t.programs])).toEqual([
      ['periodic', ['Periodic']],
      ['continuous', ['Always']],
    ])
    expect(p.tasks[1]!.priority).toBe(Infinity)
  })

  it('takes the single-resource form, with the tasks and instances directly inside', () => {
    const p = compile('PROGRAM P\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\nCONFIGURATION Cell\n  TASK Main(INTERVAL := T#5ms, PRIORITY := 0);\n  PROGRAM I WITH Main : P;\nEND_CONFIGURATION')
    expect(p.tasks[0]!.periodSec).toBe(0.005)
  })

  it('takes a VAR_GLOBAL declared inside the CONFIGURATION', () => {
    const p = compile(`PROGRAM Add
VAR_EXTERNAL total : INT; END_VAR
total := total + 2;
END_PROGRAM
CONFIGURATION Cell
  VAR_GLOBAL total : INT := 1; END_VAR
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM A WITH Main : Add;
  END_RESOURCE
END_CONFIGURATION`)
    p.scan(0.01)
    expect(p.get('total')).toBe(3)
  })

  it('runs a lone PROGRAM with no CONFIGURATION as the implicit program, under bare names', () => {
    const p = compile('PROGRAM Main\nVAR_INPUT go : BOOL; END_VAR\nVAR_OUTPUT run : BOOL; END_VAR\nrun := go;\nEND_PROGRAM')
    expect(p.tasks).toEqual([])
    expect(p.inputs).toEqual(['go'])
    p.setInput('go', true)
    p.scan(0.1)
    expect(p.get('run')).toBe(true)
  })

  it('still lets a variable be called task, program or resource', () => {
    const p = compile('VAR task : INT; program : INT; resource : INT; END_VAR\ntask := 1;\nprogram := task + 1;\nresource := program + 1;')
    p.scan(0.1)
    expect(p.get('resource')).toBe(3)
  })

  it('reaches the global itself through VAR_EXTERNAL, from a function block too', () => {
    const p = compile(`VAR_GLOBAL level : INT := 5; END_VAR
FUNCTION_BLOCK Bump
VAR_EXTERNAL level : INT; END_VAR
level := level + 1;
END_FUNCTION_BLOCK
VAR_EXTERNAL LEVEL : INT; END_VAR
VAR b : Bump; seen : INT; END_VAR
b();
seen := level;`)
    p.scan(0.1)
    expect(p.get('seen')).toBe(6)
    expect(p.watch.level).toBe(6)
  })
})

describe('what a controller refuses, and why', () => {
  const refuses = (src: string, why: RegExp): void => {
    expect(() => compile(src)).toThrow(why)
  }

  it('several PROGRAMs with no CONFIGURATION to say which task runs each', () => {
    refuses('PROGRAM A\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\nPROGRAM B\nVAR n : INT; END_VAR\nn := 2;\nEND_PROGRAM', /2 PROGRAMs are declared, and no CONFIGURATION/)
  })
  it('a variable or statement outside every POU, once a file has a PROGRAM', () => {
    refuses('PROGRAM A\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\nVAR x : INT; END_VAR\nx := 1;', /'VAR' is outside every POU/)
  })
  it("a PROGRAM after an implicit program's statements", () => {
    refuses('VAR x : INT; END_VAR\nx := 1;\nPROGRAM A\nEND_PROGRAM', /PROGRAM cannot stand here: a PROGRAM is declared at the top level/)
  })
  it('a TASK outside any CONFIGURATION', () => {
    refuses('VAR x : INT; END_VAR\nTASK Main(INTERVAL := T#10ms, PRIORITY := 0);', /TASK cannot stand here/)
  })
  it('an event task', () => {
    refuses(inConfig('    TASK Main(SINGLE := go, PRIORITY := 0);', INSTANCE), /event task \(SINGLE\) is not implemented/)
  })
  it('a task with no INTERVAL, or no PRIORITY', () => {
    refuses(inConfig('    TASK Main(PRIORITY := 0);', INSTANCE), /needs an INTERVAL/)
    refuses(inConfig('    TASK Main(INTERVAL := T#10ms);', INSTANCE), /needs a PRIORITY/)
  })
  it("a task's arguments out of IEC's order", () => {
    refuses(inConfig('    TASK Main(PRIORITY := 0, INTERVAL := T#10ms);', INSTANCE), /order SINGLE, INTERVAL, PRIORITY/)
  })
  it('an INTERVAL that is not a duration literal, or a PRIORITY that is not a whole number', () => {
    refuses(inConfig('    TASK Main(INTERVAL := 10, PRIORITY := 0);', INSTANCE), /duration literal/)
    refuses(inConfig('    TASK Main(INTERVAL := T#10ms, PRIORITY := -1);', INSTANCE), /whole number, 0 or more/)
  })
  it('a TASK after the PROGRAM instances', () => {
    refuses(inConfig('', `${INSTANCE}\n${TASK}`), /TASK is declared before the PROGRAM instances/)
  })
  it('a resource that runs no program', () => {
    refuses(inConfig(TASK, ''), /runs at least one PROGRAM instance/)
  })
  it('an instance on a task nobody declared', () => {
    refuses(inConfig(TASK, '    PROGRAM I WITH Other : P;'), /unknown TASK 'Other'/)
  })
  it('an instance of something that is not a PROGRAM', () => {
    refuses(`FUNCTION_BLOCK Fb\nVAR n : INT; END_VAR\nn := 1;\nEND_FUNCTION_BLOCK\n${inConfig(TASK, '    PROGRAM I WITH Main : Fb;')}`, /'Fb' is a FUNCTION_BLOCK, not a PROGRAM/)
  })
  it('two instances with one name', () => {
    refuses(inConfig(TASK, `${INSTANCE}\n    PROGRAM i WITH Main : P;`), /duplicate program instance 'i'/)
  })
  it('an instance named like a global, since both would be addressed by that name', () => {
    refuses(`VAR_GLOBAL I : INT; END_VAR\n${inConfig(TASK, INSTANCE)}`, /has the name of 'I', a VAR_GLOBAL or top-level variable/)
  })
  it('more than one RESOURCE', () => {
    refuses(
      'PROGRAM P\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\nCONFIGURATION Cell\n  RESOURCE A ON PLC\n    TASK T1(INTERVAL := T#10ms, PRIORITY := 0);\n    PROGRAM I1 WITH T1 : P;\n  END_RESOURCE\n  RESOURCE B ON PLC\n    TASK T2(INTERVAL := T#10ms, PRIORITY := 0);\n    PROGRAM I2 WITH T2 : P;\n  END_RESOURCE\nEND_CONFIGURATION',
      /2 RESOURCEs are declared/,
    )
  })
  it("wiring an instance's inputs and outputs in the CONFIGURATION", () => {
    refuses(inConfig(TASK, '    PROGRAM I WITH Main : P (n := 1);'), /wiring a PROGRAM instance's inputs and outputs/)
  })
  it('VAR_IN_OUT on a PROGRAM', () => {
    refuses('PROGRAM P\nVAR_IN_OUT x : INT; END_VAR\nx := 1;\nEND_PROGRAM', /a PROGRAM cannot take VAR_IN_OUT/)
  })
  it('a variable declared as a PROGRAM type', () => {
    refuses(inConfig(TASK, INSTANCE).replace('VAR n : INT; END_VAR', 'VAR n : INT; inner : P; END_VAR'), /'P' is a PROGRAM, and no variable can hold one/)
  })
  it('a VAR_EXTERNAL that names no global', () => {
    refuses('VAR_EXTERNAL g : INT; END_VAR\ng := 1;', /VAR_EXTERNAL 'g' names no VAR_GLOBAL/)
  })
  it("a VAR_EXTERNAL of another type than the global's", () => {
    refuses('VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL g : DINT; END_VAR\ng := 1;', /declared DINT, but the VAR_GLOBAL is INT/)
    refuses('VAR_GLOBAL s : STRING[10]; END_VAR\nVAR_EXTERNAL s : STRING; END_VAR\ns := \'a\';', /declared STRING\[80\], but the VAR_GLOBAL is STRING\[10\]/)
  })
  it('a non-CONSTANT VAR_EXTERNAL of a CONSTANT global', () => {
    refuses('VAR_GLOBAL CONSTANT k : INT := 1; END_VAR\nVAR_EXTERNAL k : INT; END_VAR\nVAR n : INT; END_VAR\nn := k;', /must be declared CONSTANT/)
  })
  it('a write through a VAR_EXTERNAL CONSTANT, even to a global that is not', () => {
    refuses('VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL CONSTANT g : INT; END_VAR\ng := 1;', /cannot assign to CONSTANT 'g'/)
  })
  it('an initial value on a VAR_EXTERNAL', () => {
    refuses('VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL g : INT := 1; END_VAR\ng := 1;', /has no initial value of its own/)
  })

  it('reports every configuration problem at once, each where it is written', () => {
    const src = inConfig('    TASK Main(INTERVAL := T#10ms);\n    TASK main(INTERVAL := T#10ms, PRIORITY := 0);', '    PROGRAM I WITH Nope : P;')
    const found = diagnostics(src)
    const messages = found.map((d) => d.message).join('\n')
    expect(messages).toMatch(/needs a PRIORITY/)
    expect(messages).toMatch(/duplicate task 'main'/)
    expect(messages).toMatch(/unknown TASK 'Nope'/)
    const unknown = found.find((d) => /unknown TASK/.test(d.message))!
    expect(src.slice(unknown.pos.offset, unknown.pos.offset + unknown.length)).toBe('Nope')
  })
})

/** A controller stub that records which task scanned, with what dt (ms). */
function recorder(tasks: TaskInfo[]): { log: string[]; target: { tasks: TaskInfo[]; tick: (dt: number) => void; tickTask: (i: number, dt: number) => void } } {
  const log: string[] = []
  return {
    log,
    target: {
      tasks,
      tick: (dt) => void log.push(`program ${Math.round(dt * 1000)}`),
      tickTask: (i, dt) => void log.push(`${tasks[i]!.name} ${Math.round(dt * 1000)}`),
    },
  }
}
const periodic = (name: string, periodMs: number, priority: number): TaskInfo => ({ name, kind: 'periodic', periodSec: periodMs / 1000, priority, programs: [] })

describe('TaskScheduler', () => {
  it('scans each task on its own interval, from one stream of steps', () => {
    const { log, target } = recorder([periodic('Fast', 10, 1), periodic('Slow', 30, 2)])
    const s = new TaskScheduler(target, { maxCatchUp: 64 })
    for (let i = 0; i < 6; i++) s.advance(0.01)
    expect(log.filter((l) => l.startsWith('Fast'))).toHaveLength(6)
    expect(log.filter((l) => l.startsWith('Slow'))).toEqual(['Slow 30', 'Slow 30'])
  })

  it("brings a task's first scan due one full period in, not at the start", () => {
    const { log, target } = recorder([periodic('Main', 30, 0)])
    const s = new TaskScheduler(target)
    s.advance(0.01)
    s.advance(0.01)
    expect(log).toEqual([])
    s.advance(0.01)
    expect(log).toEqual(['Main 30'])
  })

  it('runs the scans one step makes due in the order they came due, whatever their priorities', () => {
    // one 50 ms step: Fast (25 ms, priority 0) comes due at 25 and 50 ms, Slow (40 ms, priority 9) at 40
    const { log, target } = recorder([periodic('Fast', 25, 0), periodic('Slow', 40, 9)])
    new TaskScheduler(target, { maxCatchUp: 64 }).advance(0.05)
    expect(log).toEqual(['Fast 25', 'Slow 40', 'Fast 25'])
  })

  it('breaks a tie by priority, 0 first, then by declaration order', () => {
    const { log, target } = recorder([periodic('Low', 10, 5), periodic('High', 10, 0), periodic('AlsoLow', 10, 5)])
    new TaskScheduler(target, { maxCatchUp: 64 }).advance(0.01)
    expect(log).toEqual(['High 10', 'Low 10', 'AlsoLow 10'])
  })

  it("runs the continuous task once per step, after that step's periodic scans, with the step as its dt", () => {
    const { log, target } = recorder([{ name: 'Always', kind: 'continuous', periodSec: 0, priority: Infinity, programs: [] }, periodic('Main', 10, 0)])
    const s = new TaskScheduler(target, { maxCatchUp: 64 })
    s.advance(0.02)
    expect(log).toEqual(['Main 10', 'Main 10', 'Always 20'])
    expect(s.scansRun).toBe(3)
  })

  it("sheds one task's backlog past the catch-up cap, and counts only a sustained overrun", () => {
    const { target } = recorder([periodic('Main', 1, 0)])
    const s = new TaskScheduler(target, { maxCatchUp: 4 })
    expect(s.advance(0.01)).toEqual({ scans: 4, overrun: true })
    expect(s.advance(0.001).scans).toBe(1) // the backlog was dropped, not carried
    for (let i = 0; i < 3; i++) s.advance(0.01)
    expect(s.overruns).toBe(1)
  })
})

describe('the emitted TypeScript', () => {
  it('carries the task table, an instance per PROGRAM line and a scanTask per task', () => {
    const ts = toTypeScript(TWO_RATES)
    expect(ts).toContain(`  { name: "Fast", kind: 'periodic', periodSec: 0.01, priority: 1, programs: ["FastCount"] },`)
    expect(ts).toContain('class Counter {')
    expect(ts).toContain('  S.SlowCount = new Counter();')
    expect(ts).toContain('export function scanTask(S, i, dt) {')
  })
})

describe('exporting a controller', () => {
  it('writes the file as authored, with a file-level VAR_GLOBAL placed inside the CONFIGURATION', () => {
    const text = renderIecText(`VAR_GLOBAL total : INT; END_VAR\n\n${TWO_RATES}`, { banner: false })
    expect(text.indexOf('CONFIGURATION Cell')).toBeLessThan(text.indexOf('VAR_GLOBAL'))
    expect(text.indexOf('VAR_GLOBAL')).toBeLessThan(text.indexOf('RESOURCE Res0'))
    expect(text).toContain('    PROGRAM FastCount WITH Fast : Counter;')
    expect(text.match(/\bCONFIGURATION\b/g)).toHaveLength(1) // its own, not a second generated one
  })

  it('wraps a lone PROGRAM in a one-task CONFIGURATION, under its own name', () => {
    const text = renderIecText('PROGRAM Mixer\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM', { banner: false, scanMs: 20 })
    expect(text).toContain('TASK Tick(INTERVAL := T#20ms, PRIORITY := 0);')
    expect(text).toContain('PROGRAM Inst0 WITH Tick : Mixer;')
    expect(text).not.toContain('PROGRAM Main')
  })

  it('writes each task, and each instance inside its task, in PLCopen XML', () => {
    const xml = toPlcopenXml(TWO_RATES)
    expect(xml).toContain('<pou name="Counter" pouType="program">')
    expect(xml).toContain('<configuration name="Cell">')
    expect(xml).toContain('<task name="Slow" interval="T#30ms" priority="2">')
    expect(xml).toContain('<pouInstance name="SlowCount" typeName="Counter"/>')
    expect(xml).toContain('n := n + 1;')
    expect(xml).not.toContain('PROGRAM Counter') // the body, without its header
  })

  it('writes an instance with no task on the resource itself', () => {
    const xml = toPlcopenXml(inConfig(TASK, `${INSTANCE}\n    PROGRAM Always : P;`))
    expect(xml).toMatch(/<\/task>\n {10}<pouInstance name="Always" typeName="P"\/>\n {8}<\/resource>/)
  })

  it('warns when the PROGRAM lines are not in priority order, which MATIEC runs them in', () => {
    const swapped = TWO_RATES.replace(
      '    PROGRAM FastCount WITH Fast : Counter;\n    PROGRAM SlowCount WITH Slow : Counter;',
      '    PROGRAM SlowCount WITH Slow : Counter;\n    PROGRAM FastCount WITH Fast : Counter;',
    )
    expect(exportProgram(swapped, 'iec-text').warnings.join(' ')).toMatch(/not in priority order/)
    expect(exportProgram(TWO_RATES, 'iec-text').warnings.join(' ')).not.toMatch(/priority order/)
  })

  it('warns about a global used without VAR_EXTERNAL, and not once it is declared', () => {
    const bare = exportProgram('VAR_GLOBAL g : INT; END_VAR\nVAR n : INT; END_VAR\nn := g;', 'iec-text').warnings.join(' ')
    expect(bare).toMatch(/the program \(g\): a POU uses a VAR_GLOBAL or a top-level variable without declaring it in VAR_EXTERNAL/)
    const declared = exportProgram('VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL g : INT; END_VAR\nVAR n : INT; END_VAR\nn := g;', 'iec-text').warnings.join(' ')
    expect(declared).not.toMatch(/VAR_EXTERNAL/)
  })
})
