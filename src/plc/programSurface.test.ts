import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from './conformanceCases'
import { controllerFor, runnableSource } from './controller'
import { compile, setScanEngine } from './interpreter'
import { boundNames, LocalPlcLink } from './link/plcLink'
import { surfaceOf } from './programSurface'

const WRAPPED = `PROGRAM Line
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
VAR
  Speed : REAL;
  Hold : TON;
  LIMIT : INT := 3;
END_VAR
Run := NOT Eye;
END_PROGRAM`
// as the editor compiles it: under its controller table, where the PROGRAM runs as one instance
const RUNNABLE = runnableSource(WRAPPED, controllerFor(WRAPPED, null, 10))

describe('what a compiled program offers the scene, as data', () => {
  it('lists the names, their aliases and what each is', () => {
    const surface = surfaceOf(compile(RUNNABLE))
    // the instance's variables are qualified by its name, whatever the table calls it
    const run = surface.outputs[0]!
    expect(run.endsWith('.Run')).toBe(true)
    const inst = run.slice(0, -'.Run'.length)
    expect(surface.inputs).toEqual([`${inst}.Eye`])
    expect(surface.outputs).toEqual([run])
    expect(surface.bindable).toContain(`${inst}.Speed`)
    // a sole instance's variables go by their bare names too
    expect(new Map(surface.aliases).get('Run')).toBe(run)
    expect(surface.vars[run]).toEqual({ type: 'BOOL', constant: false })
    expect(surface.vars[`${inst}.Speed`]?.type).toBe('REAL')
    // only names something can bind carry an alias: a timer's output is watched, not wired
    expect(surface.aliases.every(([, name]) => name in surface.vars)).toBe(true)
  })

  it('crosses a thread boundary whole', () => {
    const surface = surfaceOf(compile(RUNNABLE))
    expect(structuredClone(surface)).toEqual(surface)
  })

  it('binds as the link binds', () => {
    const program = compile(RUNNABLE)
    const surface = surfaceOf(program)
    const wired = { inputs: ['Speed'], outputs: ['LIMIT', 'Eye', 'Nope'] }
    const link = new LocalPlcLink(program, wired)
    const bound = boundNames(surface, new Map(surface.aliases), wired)
    expect(bound.inputs).toEqual(link.inputs)
    expect(bound.outputs).toEqual(link.outputs)
    expect(bound.bindable).toEqual(link.bindable)
  })

  // the worker that compiles for the Inspector runs the walker (editor/program/program.worker.ts)
  it('is the same from either scan engine, for every case of the conformance corpus', () => {
    const differing: string[] = []
    let compared = 0
    for (const c of CONFORMANCE_CASES.filter((x) => !x.rejects)) {
      const typed = surfaceOf(compile(c.src))
      const was = setScanEngine('walker')
      let walker
      try {
        walker = surfaceOf(compile(c.src))
      } finally {
        setScanEngine(was)
      }
      compared++
      if (JSON.stringify(typed) !== JSON.stringify(walker)) differing.push(c.name)
    }
    expect(differing).toEqual([])
    expect(compared).toBeGreaterThan(50)
  })
})
