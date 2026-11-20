// Shrinks a program the fuzzer found the engines disagreeing on (stFuzz.test.ts), line by line, keeping a cut only
// while the program still disagrees. A cut that breaks the syntax compiles on neither engine, which the oracle reports
// as agreement, so such cuts are dropped on their own.
//
// Test support, not app code: nothing outside the specs imports it.

/** `src` with as many lines removed as `fails` allows: runs of lines from half the program down to one, repeated
 *  until no run can go (a run of two or three takes an empty VAR ... END_VAR, an IF with its END_IF). */
export function minimizeLines(src: string, fails: (src: string) => boolean, budget = 20_000): string {
  let lines = src.split('\n')
  let tries = 0
  const pass = (w: number): boolean => {
    let cut = false
    for (let start = 0; start + w <= lines.length && tries < budget; ) {
      const rest = [...lines.slice(0, start), ...lines.slice(start + w)]
      tries++
      if (rest.length > 0 && fails(rest.join('\n'))) {
        lines = rest
        cut = true
      } else start += w > 3 ? w : 1
    }
    return cut
  }
  for (let w = Math.floor(lines.length / 2); w > 3; w = Math.floor(w / 2)) pass(w)
  for (let again = true; again && tries < budget; ) {
    again = false
    for (const w of [8, 4, 3, 2, 1]) if (pass(w)) again = true
  }
  return lines.join('\n')
}
