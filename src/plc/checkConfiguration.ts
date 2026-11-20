// Located variables (AT %I/%Q/%M) and the CONFIGURATION: overlapping addresses, tasks and program instances.

import { parseDirectAddress, sizeWord, TYPES_FOR_SIZE } from '../core/io/iecAddress'
import { collect, declTypeName } from './checkScope'
import { duplicateName } from './checkTypeDefs'
import { type Env, type FbDefMap, type FuncDefMap, identKey, isScalarType } from './program'
import type { ConfigurationDef, Decl, Diagnostic, ProgramDef, Stmt, TaskDef } from './types'
import { isEnum, StError } from './types'

/** Where a group of declarations sits, for the rules on located variables. */
type LocatedHome = 'block' | 'function' | 'program' | 'global'

/** The bytes a memory address covers, counted byte-addressed (%MWn is bytes 2n and 2n+1), and its bit. */
interface MemorySpan {
  from: number
  to: number
  bit: number | null
}
function memorySpan(size: 'X' | 'B' | 'W' | 'D' | 'L', fields: number[]): MemorySpan {
  const n = fields[0]!
  if (size === 'X') return { from: n, to: n, bit: fields[1]! }
  const bytes = size === 'B' ? 1 : size === 'W' ? 2 : size === 'D' ? 4 : 8
  return { from: n * bytes, to: n * bytes + bytes - 1, bit: null }
}
/** Two bits in one byte are two places; anything else that shares a byte is one. */
function spansOverlap(a: MemorySpan, b: MemorySpan): boolean {
  if (a.to < b.from || b.to < a.from) return false
  return !(a.bit !== null && b.bit !== null && a.bit !== b.bit)
}

/**
 * Located variables (`Eye AT %IX100.0 : BOOL`): a variable bound to a physical I/O point, or to the
 * controller's memory (`Count AT %MW0 : INT`).
 *
 * An I/O address is how the variable meets the world: the scene, and any external controller, reach it
 * by address rather than by name (interpreter.ts), so an %I variable is an input and a %Q one an
 * output wherever it is declared. A memory address (%M) is storage the program keeps: no part binds it
 * (pou.ts `locatedBindings` leaves it out), and it reads and writes like any variable. Real programs
 * carry them (OpenPLC keeps a SCADA's values at %MW / %MD), so refusing them refused those programs.
 * The rules keep all of it one-to-one:
 *
 *   - Only a PROGRAM (including the code outside every POU) and VAR_GLOBAL can locate a variable, and
 *     only in a plain VAR: IEC's grammar puts located declarations there, and the address already says
 *     which way the value goes. A function block is reused and a function is called, while an address
 *     is one point, so neither may declare one; IEC 2nd edition refuses it too.
 *   - Two memory variables may not share bytes (%MW0 and %MX1.2): one target may overlay them while OpenPLC
 *     keeps each size in an area of its own, so a program relying on either would mean different things.
 *   - The type has to fit the address: a bit holds a BOOL, a word an INT, UINT or WORD, and so on.
 *     64-bit addresses are out, because 64-bit types are.
 *   - One point, one variable, and a PROGRAM that locates variables runs as one instance: two
 *     variables on one output would each write it, and the scan order would pick the winner.
 */
export function checkLocated(groups: { decls: Decl[]; home: LocatedHome }[], config: ConfigurationDef | null, programs: Map<string, ProgramDef>, sink: Diagnostic[] | null): void {
  const byAddress = new Map<string, Decl>()
  const memory: { d: Decl; addr: string; span: MemorySpan }[] = []
  const fail = (d: Decl, message: string): void =>
    collect(sink, () => {
      throw new StError(message, d.locationPos ?? d.pos, d.locationLength ?? d.name.length)
    })
  for (const { decls, home } of groups) {
    for (const d of decls) {
      if (d.location === undefined) continue
      const addr = d.location
      if (home === 'block' || home === 'function') {
        fail(
          d,
          `'${d.name}' is located at ${addr}, and a ${home === 'block' ? 'function block' : 'function'} cannot declare a located variable: an address is one I/O point, while a ${home === 'block' ? 'block is instantiated' : 'function is called'} any number of times. Locate it in the PROGRAM and pass the value in`,
        )
        continue
      }
      if (home === 'program' && d.section !== 'VAR') {
        fail(d, `a located variable is declared in VAR, because its address already says which way it goes: VAR ${d.name} AT ${addr} : ${declTypeName(d)}; END_VAR (not ${d.section})`)
        continue
      }
      const parsed = parseDirectAddress(addr)
      if ('error' in parsed) {
        fail(d, parsed.error)
        continue
      }
      if (d.constant) {
        fail(d, `'${d.name}' is CONSTANT, and a located variable cannot be: its value is the I/O point's`)
        continue
      }
      if (parsed.size === 'L') {
        fail(d, `${addr} is a long-word (64-bit) address, and 64-bit types are not supported here`)
        continue
      }
      const t = typeof d.type === 'string' && isScalarType(d.type) ? d.type : null
      if (t === null || isEnum(d.type)) {
        fail(d, `'${d.name}' is ${declTypeName(d)}; only an elementary type (BOOL, INT, REAL, ...) can be located at an I/O point`)
        continue
      }
      const fits = TYPES_FOR_SIZE[parsed.size]
      if (!fits.includes(t)) {
        fail(d, `'${d.name}' is ${t}, which does not fit the ${sizeWord(parsed.size)} address ${addr}; a ${sizeWord(parsed.size)} holds ${fits.join(', ')}`)
        continue
      }
      const prev = byAddress.get(addr)
      if (prev) {
        fail(d, `${addr} is already the address of '${prev.name}'; one ${parsed.area === 'M' ? 'address' : 'I/O point'}, one variable`)
        continue
      }
      if (parsed.area === 'M') {
        const span = memorySpan(parsed.size, parsed.fields)
        const shared = memory.find((m) => spansOverlap(m.span, span))
        if (shared) {
          fail(
            d,
            `'${d.name}' at ${addr} shares memory with '${shared.d.name}' at ${shared.addr}; targets disagree on what overlapping memory addresses mean (some overlay them, OpenPLC keeps each size apart), so give each variable bytes of its own`,
          )
          continue
        }
        memory.push({ d, addr, span })
      }
      byAddress.set(addr, d)
    }
  }
  if (!config) return
  const instancesOf = new Map<string, string[]>()
  for (const p of config.programs) {
    if (p.type === null) continue
    const k = identKey(p.type)
    instancesOf.set(k, [...(instancesOf.get(k) ?? []), p.name])
  }
  for (const [k, names] of instancesOf) {
    const def = programs.get(k)
    const located = def?.decls.find((d) => d.location !== undefined)
    if (!def || !located || names.length < 2) continue
    const second = config.programs.find((p) => p.name === names[1])!
    collect(sink, () => {
      throw new StError(
        `PROGRAM '${def.name}' locates '${located.name}' at ${located.location}, so it can run as one instance only: '${names[0]}' and '${names[1]}' would both be that I/O point`,
        second.pos,
        second.name.length,
      )
    })
  }
}

/** IEC's order for a task's arguments, which MATIEC's grammar enforces. */
const TASK_ARGS = ['SINGLE', 'INTERVAL', 'PRIORITY']

/**
 * The CONFIGURATION: one resource, tasks this controller can schedule, and program instances of
 * declared PROGRAM types on declared tasks. Fills in each task's period and priority, and rewrites
 * every name to its declaration's spelling.
 */
export function checkConfiguration(config: ConfigurationDef, programs: Map<string, ProgramDef>, fbs: FbDefMap, funcs: FuncDefMap, globals: Env, body: Stmt[], sink: Diagnostic[] | null): void {
  const extra = config.resources[1]
  if (extra) {
    collect(sink, () => {
      throw new StError(
        `${config.resources.length} RESOURCEs are declared; a controller here is one RESOURCE, so declare every TASK and PROGRAM instance inside one`,
        extra.pos,
        extra.name.length,
      )
    })
  }
  const tasks = new Map<string, TaskDef>()
  for (const t of config.tasks) {
    collect(sink, () => {
      const prev = tasks.get(identKey(t.name))
      if (prev) throw duplicateName('task', t.name, prev.name, t.pos)
      tasks.set(identKey(t.name), t)
      const given = new Map<string, TaskDef['args'][number]>()
      let last = -1
      for (const a of t.args) {
        const at = TASK_ARGS.indexOf(a.name)
        if (at < 0) throw new StError(`a TASK takes SINGLE, INTERVAL and PRIORITY, not '${a.name}'`, a.pos, a.name.length)
        if (given.has(a.name)) throw new StError(`${a.name} is given twice`, a.pos, a.name.length)
        if (at < last) throw new StError("a TASK's arguments come in the order SINGLE, INTERVAL, PRIORITY", a.pos, a.name.length)
        last = at
        given.set(a.name, a)
      }
      const single = given.get('SINGLE')
      if (single) {
        throw new StError(
          'an event task (SINGLE) is not implemented; a TASK here runs on its INTERVAL, and a PROGRAM instance with no task runs continuously',
          single.pos,
          single.name.length,
        )
      }
      const interval = given.get('INTERVAL')
      if (!interval) throw new StError(`TASK '${t.name}' needs an INTERVAL, such as INTERVAL := T#10ms`, t.pos, t.name.length)
      const iv = interval.value
      if (iv.node !== 'num' || iv.declared !== 'TIME') throw new StError('a TASK INTERVAL must be a duration literal here, such as T#10ms', iv.pos)
      if (!(iv.value > 0)) throw new StError('a TASK INTERVAL must be longer than zero', iv.pos)
      const priority = given.get('PRIORITY')
      if (!priority) throw new StError(`TASK '${t.name}' needs a PRIORITY (0 is the highest)`, t.pos, t.name.length)
      const pv = priority.value
      if (pv.node !== 'num' || pv.real || pv.declared !== undefined) throw new StError('a TASK PRIORITY must be a whole number, 0 or more', pv.pos)
      t.periodMs = iv.value
      t.priority = pv.value
    })
  }
  const instances = new Map<string, string>()
  // the instances that name no type, each running the code outside every POU: there can be one
  const bodyRunners: string[] = []
  for (const p of config.programs) {
    // An instance's name, what it runs and its task are separate mistakes, so each is checked on its own: an instance of a
    // missing PROGRAM on a missing TASK has two problems, and reporting one hid the other until the first was fixed. The
    // execution path still throws the first of them, in this order.
    collect(sink, () => {
      const k = identKey(p.name)
      const prev = instances.get(k)
      if (prev) throw duplicateName('program instance', p.name, prev, p.pos)
      instances.set(k, p.name)
      const g = globals.get(k)
      if (g) {
        throw new StError(
          `program instance '${p.name}' has the name of '${g.name}', a VAR_GLOBAL or top-level variable; an instance's variables are addressed as ${p.name}.Name, so the two would collide`,
          p.pos,
          p.name.length,
        )
      }
    })
    collect(sink, () => {
      if (p.type === null) {
        const running = bodyRunners[0]
        bodyRunners.push(p.name)
        if (running !== undefined) throw new StError(`the code outside every POU runs from one PROGRAM instance, and '${running}' already runs it`, p.pos, p.name.length)
      } else {
        const def = programs.get(identKey(p.type))
        if (!def) {
          const other = fbs.has(identKey(p.type)) ? 'a FUNCTION_BLOCK' : funcs.has(identKey(p.type)) ? 'a FUNCTION' : null
          throw new StError(other ? `'${p.type}' is ${other}, not a PROGRAM` : `unknown PROGRAM '${p.type}'`, p.typePos ?? p.pos, p.type.length)
        }
        p.type = def.name
      }
    })
    collect(sink, () => {
      if (p.task !== null) {
        const t = tasks.get(identKey(p.task))
        if (!t) throw new StError(`unknown TASK '${p.task}'`, p.taskPos ?? p.pos, p.task.length)
        p.task = t.name
      }
    })
  }
  // statements outside every POU that nothing runs would sit in the program doing nothing, silently
  // (an empty ladder routine is where its rungs would go and nothing more - `IF TRUE THEN END_IF` - and a
  // routine with no rungs is not code nobody runs: it is what a new controller's MainRoutine looks like)
  const idle = (s: Stmt): boolean => s.node === 'if' && s.elseBody === null && s.branches.every((b) => b.cond.node === 'bool' && b.body.every(idle))
  const first = body.find((s) => !idle(s))
  if (first && bodyRunners.length === 0) {
    collect(sink, () => {
      throw new StError(
        'this is outside every POU, and no PROGRAM instance runs that code: run it from one that names no type (PROGRAM Main WITH <task>;), or move it into a PROGRAM',
        first.pos,
        1,
      )
    })
  }
}
