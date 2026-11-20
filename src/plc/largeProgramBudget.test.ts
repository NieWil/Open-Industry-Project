// The budget for a large program: every stage between its text and a running program costs in proportion to its
// size. A lookup that scans the whole program for each statement is invisible at a few hundred lines and takes
// seconds at twenty thousand, which is what a site controller brought in from another tool has. Nothing else notices
// such work: every program in the other tests is short.
//
// Each gate is a ratio taken in one process, so the machine's speed divides out: the same program at four times the
// size may cost at most GROWTH times as much. Work in proportion reads about 4, and a scan per statement about 16.

import { afterEach, describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { controllerDiagnostics } from './controller'
import { compile, setScanEngine } from './interpreter'
import { LocalPlcLink } from './link/plcLink'
import { surfaceOf } from './programSurface'
import { parseStructure } from './structure'

/** stations in the smaller program, and how many times as many the larger one has */
const SMALL = 400
const TIMES = 4
/** what four times the program may cost; measured at 2 to 6 for every stage, and 16 to 20 with a scan per statement */
const GROWTH = 8

/** A program of `n` stations: each its own variables, a function block instance, an array of structures, a few
 *  statements and two rungs. `salt` makes the text one no memo has seen. */
function program(n: number, salt: string): string {
  const decls: string[] = []
  const body: string[] = []
  const rungs: string[] = []
  for (let s = 0; s < n; s++) {
    decls.push(`  Eye${s}, Start${s}, Stop${s}, Run${s}, Jam${s} : BOOL;`, `  St${s} : Station;`, `  Zone${s} : ARRAY[0..7] OF Zone;`, `  Speed${s} : REAL;`)
    body.push(
      `St${s}(Eye := Eye${s}, Enable := Run${s});`,
      `Jam${s} := St${s}.Held;`,
      `FOR i := 0 TO 7 DO Zone${s}[i].Run := St${s}.Motor; Zone${s}[i].Count := Zone${s}[i].Count + 1; END_FOR;`,
      `Speed${s} := Speed${s} * 0.5 + 1.0;`,
    )
    rungs.push(`  [|Start${s}|, |Run${s}|] |/Stop${s}| (Run${s});`, `  |Eye${s}| |/Jam${s}| (Stop${s});`)
  }
  return `(* ${salt} *)
TYPE Zone : STRUCT
  Run : BOOL;
  Count : DINT;
  Speed : REAL;
END_STRUCT; END_TYPE

FUNCTION_BLOCK Station
VAR_INPUT Eye, Enable : BOOL; END_VAR
VAR_OUTPUT Motor, Held : BOOL; END_VAR
VAR Dwell : TON; Seen : R_TRIG; Total : DINT; END_VAR
Seen(CLK := Eye);
IF Seen.Q THEN Total := Total + 1; END_IF;
Dwell(IN := Eye AND Enable, PT := T#500ms);
Held := Dwell.Q;
Motor := Enable AND NOT Held;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  i : INT;
${decls.join('\n')}
END_VAR
${body.join('\n')}
LADDER
${rungs.join('\n')}
END_LADDER
END_PROGRAM
`
}

const ms = (run: () => void): number => {
  const t = performance.now()
  run()
  return performance.now() - t
}

let salt = 0
/** How many times as long `stage` takes on the larger program as on the smaller one. Re-measured once when it reads
 *  over the limit: a real regression is high both times, a load spike or a collection almost never is. */
function growth(name: string, stage: (src: string) => void): number {
  const once = (): number => {
    const small = program(SMALL, `s${salt++}`)
    const large = program(SMALL * TIMES, `l${salt++}`)
    stage(program(20, `w${salt++}`)) // the stage's code is compiled before either is timed
    const a = ms(() => stage(small))
    const b = ms(() => stage(large))
    // (a stage under a few milliseconds is all noise: held to a floor so it cannot fail on a timer tick)
    return b / Math.max(a, 2)
  }
  const first = once()
  const ratio = first <= GROWTH ? first : Math.min(first, once())
  ;(globalThis as { process?: { stdout: { write(s: string): void } } }).process?.stdout.write(`[largeProgram] ${name} ${ratio.toFixed(1)}x for ${TIMES}x the program (limit ${GROWTH})\n`)
  return ratio
}

afterEach(() => {
  setScanEngine('typed')
})

describe('a large program costs in proportion to its size', () => {
  it('to read: its structure, for the organizer and the ladder sheet', { timeout: 120_000 }, () => {
    expect(growth('read', (src) => void parseStructure(src))).toBeLessThan(GROWTH)
  })

  it('to check: its problems, for the lint and the Problems panel', { timeout: 120_000 }, () => {
    expect(growth('check', (src) => expect(diagnostics(src)).toEqual([]))).toBeLessThan(GROWTH)
    expect(growth('check with its table', (src) => expect(controllerDiagnostics(src, null).source).toEqual([]))).toBeLessThan(GROWTH)
  })

  it('to compile, on each engine', { timeout: 240_000 }, () => {
    expect(growth('compile (typed)', (src) => void compile(src))).toBeLessThan(GROWTH)
    setScanEngine('walker')
    expect(growth('compile (walker)', (src) => void compile(src))).toBeLessThan(GROWTH)
  })

  it('to attach: its link, what it offers a scene, and a first scan', { timeout: 240_000 }, () => {
    const attach = (src: string): void => {
      const compiled = compile(src)
      const t0 = performance.now()
      const link = new LocalPlcLink(compiled)
      surfaceOf(compiled)
      link.step({}, 0.01)
      attached = performance.now() - t0
    }
    let attached = 0
    // (the compile is not this gate's: the stage reports the time after it)
    const once = (n: number): number => {
      attach(program(n, `a${salt++}`))
      return attached
    }
    once(20)
    const measure = (): number => {
      const small = once(SMALL)
      return once(SMALL * TIMES) / Math.max(small, 2)
    }
    // re-measured once when over the limit, as growth() does: this stage read 8.2 once on a loaded CI runner
    const first = measure()
    const ratio = first <= GROWTH ? first : Math.min(first, measure())
    ;(globalThis as { process?: { stdout: { write(s: string): void } } }).process?.stdout.write(`[largeProgram] attach ${ratio.toFixed(1)}x for ${TIMES}x the program (limit ${GROWTH})\n`)
    expect(ratio).toBeLessThan(GROWTH)
  })
})
