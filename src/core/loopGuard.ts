// A CPU budget for part scripts. Part code runs in-process (core/parts/partScript.ts), so without it a `for (;;)` in
// step() hangs the sim worker forever and one in geometry() freezes the UI. There is no preemption, and a
// wall-clock timeout would make the sim nondeterministic. So loops are counted instead: every loop test is
// rewritten to call a guard first, the guard counts iterations across one call into part code, and past the
// budget it throws. The throw goes to the host's existing per-call error handling (a behavior error,
// a geometry error), deterministically: the same script fails at the same iteration on every machine.
//
// What is instrumented: `while (test)` (so `do … while (test)` too, since its tail is a `while`) and the test of a
// C-style `for (init; test; update)`, empty test included. Not `for … of` / `for … in` (bounded by the
// collection) and not recursion (the engine's own stack limit already turns that into a RangeError).
//
// Lexical, like the determinism scan it builds on: comments and strings are blanked first, so a `while (` in
// a string is left alone. Inserted text never contains a newline, so error line numbers are unchanged. It
// can misread a regex literal holding a paren or an object method named `while`/`for`. partScript compiles
// the untouched source when the instrumented one fails to parse, so a misread loses the guard, not the part.

import { blankNonCode } from './determinism'

/** The guard's binding name inside a compiled part script. */
export const LOOP_GUARD = '__oipLoop'

/** Loop iterations one call into part code (a step, a geometry build, init) may run before it is stopped.
 *  Generous: a real part iterates thousands of times per call; ten million is a hang, not a workload. */
export const LOOP_BUDGET = 10_000_000

const KEYWORD = /(?<![A-Za-z0-9_$.])(while|for)(?![A-Za-z0-9_$])/g

/** Return `source` with every loop test prefixed by a call to {@link LOOP_GUARD}. */
export function instrumentLoops(source: string): string {
  const code = blankNonCode(source)
  const inserts: { at: number; text: string }[] = []
  KEYWORD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KEYWORD.exec(code))) {
    let j = m.index + m[0].length
    while (j < code.length && /\s/.test(code[j]!)) j++
    if (code[j] !== '(') continue // `for await`, a property key, …
    const close = matchingParen(code, j)
    if (close < 0) continue
    if (m[1] === 'while') {
      inserts.push({ at: j + 1, text: `${LOOP_GUARD}() && (` }, { at: close, text: ')' })
      continue
    }
    const semis = topLevelSemicolons(code, j + 1, close)
    if (semis.length !== 2) continue // for … of / for … in
    const [a, b] = semis as [number, number]
    if (code.slice(a + 1, b).trim() === '') inserts.push({ at: a + 1, text: ` ${LOOP_GUARD}()` })
    else inserts.push({ at: a + 1, text: ` ${LOOP_GUARD}() && (` }, { at: b, text: ')' })
  }
  if (inserts.length === 0) return source
  inserts.sort((x, y) => y.at - x.at)
  let out = source
  for (const { at, text } of inserts) out = out.slice(0, at) + text + out.slice(at)
  return out
}

function matchingParen(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return c === ')' ? i : -1
    }
  }
  return -1
}

function topLevelSemicolons(code: string, from: number, to: number): number[] {
  const out: number[] = []
  let depth = 0
  for (let i = from; i < to; i++) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ';' && depth === 0) out.push(i)
  }
  return out
}
