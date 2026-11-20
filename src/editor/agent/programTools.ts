// Agent tools for the PLC program by POU, a check that keeps nothing, and a trace of tags over a running window
// (docs/agent-tools.md). The program stays one string in the store; a POU is the block plc/programFiles.ts splits it
// into, the same split a project folder writes as one file per POU, so `name` here is that file's name less its
// extension. A POU holding a LADDER section is ladder in our text form (docs/ladder.md).

import { joinProgramFiles } from '../../core/project/projectFolder'
import { isKnownDialect } from '../../core/dialect'
import { programFiles, type ProgramFile } from '../../plc/programFiles'
import {
  AGENT_LABEL,
  AgentToolError,
  assertEditable,
  needController,
  optNum,
  optStr,
  problems,
  str,
  strList,
  type AgentTool,
  type AgentToolContext,
} from './toolKit'

const stemOf = (f: ProgramFile): string => f.name.replace(/\.(st|ld)$/, '')

function findPou(files: readonly ProgramFile[], name: string): number {
  const want = name.replace(/\.(st|ld)$/i, '').toLowerCase()
  return files.findIndex((f) => stemOf(f).toLowerCase() === want)
}

/** The first line of each file in joinProgramFiles(texts): problems on the joined program say which POU they are in. */
function startLines(texts: readonly string[]): number[] {
  if (texts.length === 1) return [1]
  const out: number[] = []
  let line = 1
  for (const t of texts.map((x) => x.trim()).filter((x) => x !== '')) {
    out.push(line)
    line += t.split('\n').length + 1
  }
  return out
}

/** The program and wiring problems of `source`, each placed in its POU when it has a line. */
function programReport(ctx: AgentToolContext, source: string): Record<string, unknown>[] {
  const files = programFiles(source)
  const starts = startLines(files.map((f) => f.text))
  return problems(ctx, source)
    .problems.filter((p) => p.group === 'Program' || p.group === 'Wiring')
    .map((p) => {
      let at: { pou: string; pouLine: number } | null = null
      if (p.line !== undefined) {
        for (let i = starts.length - 1; i >= 0; i--) {
          if (p.line >= starts[i]!) {
            at = { pou: stemOf(files[i]!), pouLine: p.line - starts[i]! + 1 }
            break
          }
        }
      }
      return { severity: p.severity, group: p.group, message: p.message, ...(p.line !== undefined ? { line: p.line } : {}), ...(at ?? {}), ...(p.parts.length > 0 ? { parts: p.parts } : {}) }
    })
}

function iecOnly(ctx: AgentToolContext): void {
  if (!isKnownDialect(ctx.store.getState().stDialect)) throw new AgentToolError('this program is in a dialect this version does not run, so it is kept as written and cannot be edited by POU')
}

export const listPous: AgentTool = {
  name: 'list_pous',
  description:
    "List the program's POUs in program order (the order PROGRAMs without a task table run in, and the order a " +
    'constant must be declared before its use): name, language (st, or ld for a LADDER section) and length in ' +
    'lines. `program` is the code outside every POU, `type` a TYPE block, `var_global` a VAR_GLOBAL block. ' +
    'get_pou reads one, set_pou writes one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store }) =>
    programFiles(store.getState().stProgram).map((f) => ({ name: stemOf(f), language: f.name.endsWith('.ld') ? 'ld' : 'st', lines: f.text.trimEnd().split('\n').length })),
}

export const getPou: AgentTool = {
  name: 'get_pou',
  description: 'Read one POU of the program by the name list_pous gives it.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  run: ({ store }, args) => {
    const files = programFiles(store.getState().stProgram)
    const i = findPou(files, str(args, 'name'))
    if (i < 0) throw new AgentToolError(`no POU '${String(args.name)}' (the POUs are: ${files.map(stemOf).join(', ') || 'none'})`)
    return files[i]!.text
  },
}

export const setPou: AgentTool = {
  name: 'set_pou',
  description:
    'Replace one POU of the program, leaving the rest as written. `name` is a name from list_pous; a name the ' +
    'program has not got adds the source as a new POU after the others (above the code outside every POU), or ' +
    'before the POU named by `before`. An empty ' +
    '`source` deletes the POU. One undo step. Returns the program and wiring problems, each with the POU and the ' +
    'line in it. Use set_program to replace the whole program; rename_tag to rename a tag across POUs and wiring.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      source: { type: 'string', description: "the POU's text, e.g. FUNCTION_BLOCK Lane ... END_FUNCTION_BLOCK" },
      before: { type: 'string', description: 'for a new POU: the POU to insert it before' },
    },
    required: ['name', 'source'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    iecOnly(ctx)
    const name = str(args, 'name')
    const source = args.source
    if (typeof source !== 'string') throw new AgentToolError("'source' must be a string")
    const files = programFiles(ctx.store.getState().stProgram)
    const texts = files.map((f) => f.text)
    const i = findPou(files, name)
    let verb: string
    if (i >= 0) {
      texts[i] = source
      verb = source.trim() === '' ? 'delete' : 'edit'
    } else {
      if (source.trim() === '') throw new AgentToolError(`no POU '${name}' to delete (the POUs are: ${files.map(stemOf).join(', ') || 'none'})`)
      const before = optStr(args, 'before')
      // by default a new POU goes after the others, but above the code outside every POU: a declaration written
      // after that code's statements is read as more statements
      const bare = files.findIndex((f) => stemOf(f) === 'program')
      const at = before !== undefined ? findPou(files, before) : bare >= 0 ? bare : texts.length
      if (at < 0) throw new AgentToolError(`no POU '${before}' to insert before`)
      texts.splice(at, 0, source)
      verb = 'add'
    }
    // a lone POU is the whole program as written; several are joined in the folder's normal form
    const next = texts.length === 1 ? texts[0]! : joinProgramFiles(texts.length === 0 ? [''] : texts)
    ctx.store.commitProgram(`${AGENT_LABEL}: ${verb} ${name}`, { source: next })
    return { pous: programFiles(next).map(stemOf), problems: programReport(ctx, next) }
  },
}

export const checkProgram: AgentTool = {
  name: 'check_program',
  description:
    'Check program source without keeping it: compile errors and wiring against the parts of the open scene, as ' +
    'set_program would report them, each with the POU and the line in it. Nothing changes and no undo step is made.',
  inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'], additionalProperties: false },
  run: (ctx, args) => {
    iecOnly(ctx)
    const source = args.source
    if (typeof source !== 'string') throw new AgentToolError("'source' must be a string")
    const report = programReport(ctx, source)
    return { ok: !report.some((p) => p.severity === 'error'), problems: report }
  },
}

/** trace_tags samples the controller's mirror this often (ms); the mirror itself updates at ~10 Hz */
const TRACE_SAMPLE_MS = 50
const TRACE_MAX_CHANGES = 400

export const traceTags: AgentTool = {
  name: 'trace_tags',
  description:
    'Watch tags of the running program for `seconds` of wall time (at most 30) and return each change with the ' +
    'simulated time it was seen at. Reads the ~10 Hz mirror get_tags reads, so a pulse shorter than ~0.15 s can be ' +
    'missed: for exact timing, write a run_test check. Start the run first (run).',
  inputSchema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1 }, seconds: { type: 'number' } },
    required: ['names'],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const controller = needController(ctx)
    const names = strList(args, 'names')
    const seconds = Math.min(Math.max(optNum(args, 'seconds') ?? 5, 0.1), 30)
    if (!controller.plcWatch) throw new AgentToolError('the program is not running: start it with run')
    const simTime = (): number | null => {
      const t = controller.lastFrame?.simTime
      return typeof t === 'number' ? Math.round(t * 1000) / 1000 : null
    }
    const first = controller.plcWatch
    const missing = names.filter((n) => !(n in first))
    const watched = names.filter((n) => n in first)
    if (watched.length === 0) throw new AgentToolError(`none of these is a variable of the running program: ${missing.join(', ')}`)
    const last: Record<string, unknown> = Object.fromEntries(watched.map((n) => [n, first[n]]))
    const changes: { t: number | null; tag: string; value: unknown }[] = []
    let dropped = 0
    const from = simTime()
    const end = Date.now() + seconds * 1000
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, TRACE_SAMPLE_MS))
      const watch = controller.plcWatch
      if (!watch) break // the run stopped
      for (const n of watched) {
        if (watch[n] === last[n]) continue
        last[n] = watch[n]
        if (changes.length < TRACE_MAX_CHANGES) changes.push({ t: simTime(), tag: n, value: watch[n] })
        else dropped++
      }
    }
    return {
      from,
      to: simTime(),
      initial: Object.fromEntries(watched.map((n) => [n, first[n]])),
      changes,
      ...(dropped > 0 ? { changesOmitted: dropped } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      ...(controller.plcWatch ? {} : { stopped: 'the run stopped before the window ended' }),
    }
  },
}
