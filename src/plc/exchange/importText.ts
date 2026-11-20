// Import: a spec-legal IEC 61131-3 source file becomes a program this engine can run, for someone who
// already has ST (the exporters only write a program out).
//
// Two shapes come in, and they are imported differently.
//
//  - One program (one PROGRAM POU, at most one task, one instance, one resource) is exportText.ts run backwards:
//    importing strips the CONFIGURATION / RESOURCE / TASK / instance layer the exporter synthesises. The POUs
//    and body come in unchanged. The wrapper is recovered (the task period becomes a suggested scan time) or
//    reported (`notes`). The program's variables keep their bare names.
//  - A controller (more than one of any of those) comes in as written: this engine runs a CONFIGURATION's tasks
//    and instances itself, and stripping the layer would drop programs.
//
// Both share the exporter's trivia mask, so a keyword inside a comment cannot be mistaken for the real one.
//
// This is not a vendor-dialect translator. An incomplete address or a construct outside the subset is named in
// `notes` and left to the checker to reject, never silently rewritten: a program that means something other
// than what its author wrote is worse than a refusal.

import { matchInCode, triviaMask } from './exportText'
import { lex } from '../lexer'

export interface ImportResult {
  /** the program, ready to load into the editor */
  source: string
  /**
   * What the file said that the subset has no place for, in the user's words. Empty means
   * the whole file crossed. A note is not a failure - the program still loads - it is the
   * list of things to look at before trusting the simulation.
   */
  notes: string[]
  /** the TASK period from a single-program CONFIGURATION, in ms, so the editor can offer to adopt
   *  it. Null for a controller, whose tasks keep their own intervals. */
  scanMs: number | null
}

/** A `<KEYWORD> ... <END_KEYWORD>` span found outside comments and strings. */
function blockSpan(src: string, mask: Uint8Array, open: RegExp, close: RegExp): { start: number; end: number; inner: string } | null {
  const o = matchInCode(src, mask, open)
  if (!o) return null
  const c = matchInCode(src, mask, close, o.end)
  if (!c) return null
  return { start: o.start, end: c.end, inner: src.slice(o.end, c.start) }
}

/** The milliseconds in an IEC duration literal, via the engine's own lexer rather than a
 *  second-guess at the grammar (`T#1s500ms`, `TIME#100ms`, `t#0.5s` all work). */
function durationMs(text: string): number | null {
  try {
    for (const t of lex(text)) if (t.type === 'TIME') return t.num
  } catch {
    /* not lexable - the caller reports it instead of guessing */
  }
  return null
}

/** Constructs the subset does not have. Each is reported rather than stripped in silence. */
const UNSUPPORTED: { re: RegExp; note: (m: string) => string }[] = [
  // A located variable crosses as written: an input or output address is how the scene binds it, and a
  // memory one (%M) is storage the program keeps. An incomplete one is linked in the vendor's I/O configuration,
  // which here is the scene's wiring (types.ts Decl.linked): it reads as a plain variable, and the note says so.
  {
    re: /\bAT\s+%[IQM][XBWDL]?\*/gi,
    note: (m) => `${m}: an incomplete address, which the target's I/O configuration completes. Here the variable is a plain one: wire a part to it by name.`,
  },
  {
    re: /\bVAR_ACCESS\b|\bVAR_CONFIG\b/gi,
    note: (m) => `${m}: configuration-level access paths and instance initial values are not part of the subset. Remove the section before running the program.`,
  },
  { re: /\b(RETAIN|NON_RETAIN)\b/gi, note: (m) => `${m}: retention is a target concern; this engine does not persist variables across a restart.` },
]

/** Count the code (not comment or string) matches of `re` inside [from, to). */
function countInCode(src: string, mask: Uint8Array, re: RegExp, from: number, to: number): number {
  let n = 0
  for (let at = from; ; ) {
    const m = matchInCode(src, mask, re, at)
    if (!m || m.start >= to) return n
    n++
    at = m.end
  }
}

/**
 * Does the file declare a controller - more than one PROGRAM POU, task, program instance or
 * resource - and what about it will not run as written?
 */
function controllerShape(src: string): { controller: boolean; notes: string[] } {
  const mask = triviaMask(src)
  const config = blockSpan(src, mask, /\bCONFIGURATION\b/i, /\bEND_CONFIGURATION\b/i)
  // outside the CONFIGURATION a `PROGRAM Name` is a POU; inside it, a `PROGRAM` line is an instance
  let pous = 0
  for (let at = 0; ; ) {
    const m = matchInCode(src, mask, /\bPROGRAM\s+[A-Za-z_]/i, at)
    if (!m) break
    if (!config || m.start < config.start || m.start >= config.end) pous++
    at = m.end
  }
  const within = (re: RegExp): number => (config ? countInCode(src, mask, re, config.start, config.end) : 0)
  const tasks = within(/\bTASK\b/i)
  const instances = within(/\bPROGRAM\b/i)
  const resources = within(/\bRESOURCE\s+[A-Za-z_]/i)
  const controller = pous > 1 || tasks > 1 || instances > 1 || resources > 1
  const notes: string[] = []
  if (controller) {
    if (!config && pous > 1) {
      notes.push(`${pous} PROGRAMs are declared and no CONFIGURATION says which task runs each. The file was loaded as written; add a CONFIGURATION before running it.`)
    }
    if (resources > 1) {
      notes.push(`${resources} RESOURCEs are declared; a controller here is one RESOURCE, so move every TASK and PROGRAM instance into one before running it.`)
    }
    if (within(/\bSINGLE\s*:=/i) > 0) {
      notes.push('An event task (SINGLE) is declared; this engine runs periodic tasks and continuous programs only, so give it an INTERVAL before running it.')
    }
    if (within(/\bPROGRAM\b[^;]*:\s*[A-Za-z_]\w*\s*\(/i) > 0) {
      notes.push("A PROGRAM instance wires its inputs and outputs in the CONFIGURATION, which is not implemented here; bind them in the scene as Instance.Variable instead.")
    }
  }
  return { controller, notes }
}

/** Notes for the constructs in UNSUPPORTED that the file actually declares. */
function unsupportedNotes(text: string): string[] {
  // Read through the trivia mask like every other scan here. A construct merely named in a
  // comment - `(* the old rung used AT %MX0.0 *)` - is not one the file declares, and a note
  // telling someone to rebind a variable that does not exist is a false alarm in the one
  // channel that has to stay trustworthy: notes are read as the list of things to check
  // before trusting the simulation, so a spurious one costs more than a missing feature.
  const notes: string[] = []
  const textMask = triviaMask(text)
  for (const { re, note } of UNSUPPORTED) {
    const seen = new Set<string>()
    for (let at = 0; ; ) {
      const m = matchInCode(text, textMask, re, at)
      if (!m) break
      seen.add(text.slice(m.start, m.end).replace(/\s+/g, ' '))
      at = m.end
    }
    for (const s of seen) notes.push(note(s))
  }
  return notes
}

/**
 * Bring a spec-legal IEC file in: a controller as written, a single program peeled down to the
 * implicit form.
 *
 * Anything that is already in the implicit form (no CONFIGURATION, no PROGRAM wrapper - what
 * this editor itself holds) passes through unchanged, so importing a file that came from here
 * is a no-op rather than a special case.
 */
export function importIecText(text: string): ImportResult {
  let src = text.replace(/\r\n/g, '\n')

  const shape = controllerShape(src)
  if (shape.controller) return { source: `${src.trim()}\n`, notes: [...shape.notes, ...unsupportedNotes(text)], scanMs: null }

  const notes: string[] = []
  let scanMs: number | null = null

  // ---- 1. the CONFIGURATION, if any ----
  // Taken first: it contains a `PROGRAM <inst> WITH <task> : <type>;` instance line, which
  // would otherwise be mistaken for the PROGRAM POU below.
  const config = blockSpan(src, triviaMask(src), /\bCONFIGURATION\b/i, /\bEND_CONFIGURATION\b/i)
  const globals: string[] = []
  if (config) {
    const inner = config.inner
    const innerMask = triviaMask(inner)

    // the task period is the one part of the wrapper worth keeping: it is the cycle the
    // author intended, and this editor has a scan time it can be applied to
    const task = matchInCode(inner, innerMask, /\bTASK\b[^;]*;/i)
    if (task) {
      const interval = /INTERVAL\s*:=\s*([^,)]+)/i.exec(inner.slice(task.start, task.end))
      const ms = interval ? durationMs(interval[1]!.trim()) : null
      if (ms !== null && ms > 0) scanMs = ms
      else if (interval) notes.push(`Could not read the TASK interval ${interval[1]!.trim()}; the scan time is unchanged.`)
      if (/\bSINGLE\s*:=/i.test(inner)) {
        notes.push('A SINGLE (event-driven) task was declared. This engine runs one periodic scan, so the program will be solved cyclically instead.')
      }
    }
    // VAR_GLOBALs live on the CONFIGURATION in IEC and at the top of the file here
    for (let at = 0; ; ) {
      const g = blockSpan(inner.slice(at), triviaMask(inner.slice(at)), /\bVAR_GLOBAL\b/i, /\bEND_VAR\b/i)
      if (!g) break
      globals.push(inner.slice(at + g.start, at + g.end).trim())
      at += g.end
    }
    src = `${src.slice(0, config.start)}${src.slice(config.end)}`
  }

  // ---- 2. the PROGRAM POU ----
  // Its contents (VAR sections + statements) are this engine's program: the POU header is the
  // part the implicit form leaves out.
  const program = blockSpan(src, triviaMask(src), /\bPROGRAM\b[^\n]*/i, /\bEND_PROGRAM\b/i)
  let body = ''
  if (program) {
    body = program.inner.trim()
    src = `${src.slice(0, program.start)}${src.slice(program.end)}`
  }

  // ---- 3. what is left is TYPE / FUNCTION / FUNCTION_BLOCK, which cross unchanged ----
  const defs = src.trim()
  notes.push(...unsupportedNotes(text))

  const parts = [...globals, defs, body].map((p) => p.trim()).filter(Boolean)
  return { source: `${parts.join('\n\n')}\n`, notes, scanMs }
}
