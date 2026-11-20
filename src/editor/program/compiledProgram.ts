// The open program, compiled once for everyone who only reads what it declares: the Problems panel
// (editor/problems.ts) and the Inspector's tag fields (tagVerdicts.ts). Compiling is the only way to learn a program's
// inputs, outputs and types, and each of them kept its own copy, so a click on a part compiled a program the panel
// had just compiled. One entry is enough: the source only changes one way at a time.
//
// The program is for reading. Nothing here scans it: a run compiles its own (sim/plcHost.ts).

import { compile, type CompiledProgram } from '../../plc'

let kept: { source: string; program: CompiledProgram | null; error: unknown } | null = null

/** `source` compiled, or why it does not compile. The same answer for the same text, without compiling again. */
export function compiledOnce(source: string): { program: CompiledProgram | null; error: unknown } {
  if (kept?.source !== source) {
    try {
      kept = { source, program: compile(source), error: null }
    } catch (error) {
      kept = { source, program: null, error }
    }
  }
  return kept
}
