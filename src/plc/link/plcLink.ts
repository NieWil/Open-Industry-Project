// The seam between the simulation and a controller. Everything the sim needs is a
// named-tag IO map (sensors in, actuators out) + one scan per tick. This decouples
// the sim from *what* runs the logic:
//   - LocalPlcLink  -> an ST program compiled + interpreted in this thread (training)
//   - (future) WsPlcLink -> a real PLC / FTEcho / soft-PLC reached over WebSocket (demos)
// When the sim grows a device-signal bus, it talks to this interface, not to either
// backend directly.

import { compile } from '../interpreter'
import type { CompiledProgram, TagPort, TagValue, TaskInfo, VarInfo, WatchPlan } from '../types'

export interface PlcLink {
  readonly inputs: string[]
  readonly outputs: string[]
  /** snapshot of all variables, for a watch/monitor table */
  readonly watch: Readonly<Record<string, TagValue>>
  /** everything the controller holds, large arrays included (CompiledProgram.memory); a remote link may not have it */
  readonly memory?: Readonly<Record<string, TagValue>>
  /**
   * One control cycle: write the given input tags, run a scan of `dt` seconds,
   * and return the resulting output tags. Inputs absent from the program are ignored.
   */
  step(inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue>
  /** A controller's tasks (CompiledProgram.tasks). Absent or empty when the link runs one program
   *  on its host's scan time - which is every remote link: a real PLC schedules its own tasks. */
  readonly tasks?: readonly TaskInfo[]
  /** {@link step}, for one task: write the inputs, scan task `index` by `dt`, return every output */
  stepTask?(index: number, inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue>
  /** bare scene tag -> the program variable it also names ({@link soleInstanceAliases}); absent or empty for most links */
  readonly aliases?: ReadonlyMap<string, string>
  /** What kind of value the program variable `name` holds, when its declaration says ({@link valueKinds}); undefined
   *  for a name it cannot answer for, which is then read off `watch`. Absent from a link that knows no declarations. */
  declaredKind?(name: string): ValueKind | undefined
}

/** What a value of a program is, as far as a part's declared type can be held against it. */
export type ValueKind = 'boolean' | 'number' | 'string'

/** The kind of value the watch table shows for a variable of each of these types (programFactsKinds.test.ts holds
 *  the two together). A type not listed is read off the table. */
const PLAIN_KIND: Readonly<Record<string, ValueKind>> = {
  BOOL: 'boolean',
  SINT: 'number',
  INT: 'number',
  DINT: 'number',
  USINT: 'number',
  UINT: 'number',
  UDINT: 'number',
  REAL: 'number',
  LREAL: 'number',
}

/**
 * A reader of the kind of value each scene tag holds in `link`'s program: `typeof` what the watch table has for it,
 * or undefined when the program holds no such value.
 *
 * A tag wired to a variable the program declares for a scene, by its own spelling, is answered from the declaration.
 * Anything else (a member, an element, a type not in PLAIN_KIND) is read off the table, which is built then and at
 * most once per reader: a large program's table holds hundreds of thousands of values and takes a third of a second
 * to build, and a check of the wiring asks about a few thousand tags.
 */
export function valueKinds(link: Pick<PlcLink, 'watch' | 'aliases' | 'declaredKind'>): (tag: string) => ValueKind | undefined {
  let table: Readonly<Record<string, TagValue>> | null = null
  return (tag) => {
    const name = link.aliases?.get(tag) ?? tag
    const declared = link.declaredKind?.(name)
    if (declared !== undefined) return declared
    table ??= link.watch
    const v = table[name]
    return v === undefined ? undefined : (typeof v as ValueKind)
  }
}

/**
 * The bare names a controller that runs one program instance answers to: each of that instance's variables
 * (`Line.Run`) is also the scene tag `Run`. Our own binding rule (IEC leaves how a program's variables meet the field
 * to the implementation): a program pasted in its PROGRAM ... END_PROGRAM wrapper, the form a PLC exports and most ST
 * is written in, runs as an instance whose variables are qualified, and a part wired to `Run` would otherwise never
 * see it. The qualified name keeps working; the bare one is the same variable, not a copy.
 *
 * None with two or more instances (where `Run` would be ambiguous), or with code outside every PROGRAM (that code runs
 * as an instance too, and its variables are the bare tags already). A bare name the program already has - a
 * controller tag, a global - stays that variable's: an alias never shadows a name the program declares. Keyed by the
 * declared spelling, as every other tag is. A watch path inside a block instance (`T1.Q`) is aliased too, for readers
 * that look a value up by name ({@link LocalPlcLink.tagView}), but binds nothing.
 */
export function soleInstanceAliases(prog: Pick<CompiledProgram, 'tasks' | 'inputs' | 'outputs' | 'bindable' | 'watch'>): ReadonlyMap<string, string> {
  const instances = prog.tasks.flatMap((t) => t.programs)
  if (instances.length !== 1) return NO_ALIASES
  const prefix = `${instances[0]!}.`
  const P = prefix.toUpperCase()
  const names = [...prog.inputs, ...prog.outputs, ...prog.bindable, ...Object.keys(prog.watch)]
  const own = (n: string): boolean => n.toUpperCase().startsWith(P)
  // IEC names are case-insensitive: a global `RUN` keeps the bare name from the instance's `Run`
  const taken = new Set(names.filter((n) => !own(n)).map((n) => n.toUpperCase()))
  const out = new Map<string, string>()
  for (const n of names) {
    if (!own(n)) continue
    const bare = n.slice(prefix.length)
    if (bare === '' || taken.has(bare.toUpperCase()) || out.has(bare)) continue
    out.set(bare, n)
  }
  return out.size > 0 ? out : NO_ALIASES
}

const NO_ALIASES: ReadonlyMap<string, string> = new Map()

/**
 * {@link soleInstanceAliases}, with the work a large program makes of it put off until it is asked for.
 *
 * A program's `watch` lists every value it holds, and each one under the sole instance has a bare alias: 210,000 of
 * them on an 800-part line, built on every attach (0.9 s of the stall at Play) and almost all never read. A scene
 * binds by the names the program declares for it (its inputs, its outputs, what a part may wire), which are a few
 * thousand, so those are worked out up front ({@link declared}) and are all that binding reads. Any other alias is a
 * path inside a variable (`T1.Q`, `Zone[3].Run`), read by name now and then: the whole table is built the first
 * time one is asked for that could exist, and never for a name the instance declares no variable for.
 *
 * It is a view of the same table, not a second rule: `get` answers what {@link soleInstanceAliases} would, and
 * walking it walks that table (plcLinkAliases.test.ts holds the two together).
 */
export class Aliases implements ReadonlyMap<string, string> {
  /** the aliases of the names a scene binds by: the program's inputs, outputs and bindable variables */
  readonly declared: ReadonlyMap<string, string>
  #all: ReadonlyMap<string, string> | null = null
  /** an alias the instance's own variables cannot account for exists (see the constructor): never refuse by them */
  readonly #anyRoot: boolean
  /** the names that are not this instance's, upper-cased: a bare name one of them has is no alias */
  readonly #taken: ReadonlySet<string>

  constructor(
    private readonly prog: AliasSource,
    private readonly prefix: string,
  ) {
    const P = prefix.toUpperCase()
    const own = (n: string): boolean => n.toUpperCase().startsWith(P)
    const names = [...prog.inputs, ...prog.outputs, ...prog.bindable]
    const shared = prog.sharedWatchKeys!()
    // (every other key of `watch` is an instance's, so these are all the names that are not this instance's)
    const taken = new Set([...names, ...shared].filter((n) => !own(n)).map((n) => n.toUpperCase()))
    const out = new Map<string, string>()
    for (const n of names) {
      if (!own(n)) continue
      const bare = n.slice(prefix.length)
      if (bare === '' || taken.has(bare.toUpperCase()) || out.has(bare)) continue
      out.set(bare, n)
    }
    this.declared = out
    this.#taken = taken
    // a tag or a global spelled like the instance (`Line`, with a member) lists keys that read as the instance's
    this.#anyRoot = shared.some(own)
  }

  /** whether the whole table has been built (for the test that it is not, by a read that does not need it) */
  get built(): boolean {
    return this.#all !== null
  }

  #whole(): ReadonlyMap<string, string> {
    return (this.#all ??= soleInstanceAliases(this.prog))
  }

  get(bare: string): string | undefined {
    const bound = this.declared.get(bare)
    if (bound !== undefined) return bound
    if (this.#all) return this.#all.get(bare)
    if (bare === '' || this.#taken.has(bare.toUpperCase())) return undefined
    // an alias names a variable of the instance, or a path inside one: there is none where it declares no such variable
    if (!this.#anyRoot && !this.prog.instanceDeclares!(this.prefix + bare)) return undefined
    return this.#whole().get(bare)
  }
  has(bare: string): boolean {
    return this.get(bare) !== undefined
  }
  get size(): number {
    return this.#whole().size
  }
  forEach(fn: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown): void {
    this.#whole().forEach((v, k) => fn.call(thisArg, v, k, this))
  }
  entries(): MapIterator<[string, string]> {
    return this.#whole().entries()
  }
  keys(): MapIterator<string> {
    return this.#whole().keys()
  }
  values(): MapIterator<string> {
    return this.#whole().values()
  }
  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.#whole()[Symbol.iterator]()
  }
}

type AliasSource = Pick<CompiledProgram, 'tasks' | 'inputs' | 'outputs' | 'bindable' | 'watch' | 'sharedWatchKeys' | 'instanceDeclares'>

/** A program's bare-name aliases ({@link soleInstanceAliases}), as a table that is built when it is needed. */
export function aliasesOfProgram(prog: AliasSource): ReadonlyMap<string, string> {
  const instances = prog.tasks.flatMap((t) => t.programs)
  if (instances.length !== 1) return NO_ALIASES
  // (a program that cannot say what its instances own is asked for everything, as before)
  if (!prog.sharedWatchKeys || !prog.instanceDeclares) return soleInstanceAliases(prog)
  return new Aliases(prog, `${instances[0]!}.`)
}

/** The aliases of the names a scene binds by (a program's inputs, outputs and bindable variables): all of them when
 *  the table was not built on demand. Every alias whose variable is one of those names is among them. */
export function declaredAliases(aliases: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return aliases instanceof Aliases ? aliases.declared : aliases
}

/** `names`, each followed by its bare alias when it has one. The names are ones a scene binds by. */
function withAliases(names: readonly string[], aliases: ReadonlyMap<string, string>): string[] {
  const bound = declaredAliases(aliases)
  if (bound.size === 0) return [...names]
  const bareOf = new Map([...bound].map(([bare, q]) => [q, bare]))
  return names.flatMap((n) => {
    const bare = bareOf.get(n)
    return bare === undefined ? [n] : [n, bare]
  })
}

/**
 * The names a program binds under `wired` ({@link LocalPlcLink.bind}'s rule, on names alone): its declared inputs and
 * outputs each with its bare alias, then what wiring adds of its bindable variables. Shared with a program known only
 * by its surface (programSurface.ts), which must bind as the link does.
 */
export function boundNames(
  program: { inputs: readonly string[]; outputs: readonly string[]; bindable: readonly string[] },
  aliases: ReadonlyMap<string, string>,
  wired: WiredBindings = { inputs: [], outputs: [] },
): { inputs: string[]; outputs: string[]; bindable: string[] } {
  const bindableNames = withAliases(program.bindable, aliases)
  const bindable = new Set(bindableNames)
  const declaredIn = withAliases(program.inputs, aliases)
  const declaredOut = withAliases(program.outputs, aliases)
  const declared = new Set([...declaredIn, ...declaredOut])
  const extra = (names: readonly string[]): string[] => [...new Set(names)].filter((n) => bindable.has(n) && !declared.has(n))
  const inputs = [...declaredIn, ...extra(wired.inputs)]
  const taken = new Set(inputs)
  return { inputs, outputs: [...declaredOut, ...extra(wired.outputs).filter((n) => !taken.has(n))], bindable: bindableNames }
}
// one alias table per compiled program: every link a program is re-bound through (withBindings) shares it
const aliasesOf = new WeakMap<CompiledProgram, ReadonlyMap<string, string>>()

/**
 * The variables a scene binds to a program by wiring (plc/wiring.ts `wiredBindings`), beyond what the
 * program declares as VAR_INPUT / VAR_OUTPUT: the parts decide which way each one goes.
 */
export interface WiredBindings {
  inputs: string[]
  outputs: string[]
}

export const NO_WIRED_BINDINGS: WiredBindings = Object.freeze({ inputs: [], outputs: [] }) as WiredBindings

/** In-process backend: compile an ST program and interpret it locally each tick. */
export class LocalPlcLink implements PlcLink {
  private readonly prog: CompiledProgram
  #inputs: string[] = []
  #outputs: string[] = []
  // each input's and output's handle, resolved once (CompiledProgram.port) - every scan moves every one of them, and by
  // name that was a regex and two case-insensitive lookups a tag, a scan. Rebuilt when bind() changes the lists.
  #inPorts: TagPort[] | null = null
  #outPorts: TagPort[] | null = null
  // held forces, each resolved once (see setForces): written before every scan and again after it
  #forces: { set: (v: TagValue) => void; value: TagValue }[] = []
  /** bare scene tag -> the sole program instance's variable ({@link soleInstanceAliases}) */
  readonly aliases: ReadonlyMap<string, string>

  /** `wired`: the scene's bindings by wiring (see {@link bind}). */
  constructor(source: string | CompiledProgram, wired: WiredBindings = NO_WIRED_BINDINGS) {
    this.prog = typeof source === 'string' ? compile(source) : source
    let aliases = aliasesOf.get(this.prog)
    if (!aliases) aliasesOf.set(this.prog, (aliases = aliasesOfProgram(this.prog)))
    this.aliases = aliases
    this.bind(wired)
  }

  get inputs(): string[] {
    return this.#inputs
  }
  get outputs(): string[] {
    return this.#outputs
  }

  /**
   * Bind the program to the scene's wiring (see {@link WiredBindings}): its declared I/O, plus these. In
   * place, so a running program keeps every variable's value when a part is wired to it mid-run. A name
   * the program cannot bind that way - undeclared, a constant, already an input or output - is ignored,
   * so the list may come from a scene written against another version of the program.
   *
   * A bare alias ({@link aliases}) is the variable it names: a declared VAR_INPUT / VAR_OUTPUT is an input / output
   * under both names (so an output reaches the scene under both), and any other variable binds by wiring under either.
   */
  bind(wired: WiredBindings): void {
    const bound = boundNames(this.prog, this.aliases, wired)
    this.#inputs = bound.inputs
    this.#outputs = bound.outputs
    this.#inPorts = this.#outPorts = null
  }

  /** The same compiled program (and so the same variables) with other bindings, for a caller that compiled it once already. */
  withBindings(wired: WiredBindings): LocalPlcLink {
    return new LocalPlcLink(this.prog, wired)
  }

  /** What a scene may bind by wiring (CompiledProgram.bindable), each with its bare {@link aliases alias} when it has one. */
  get bindable(): string[] {
    return withAliases(this.prog.bindable, this.aliases)
  }
  get watch(): Readonly<Record<string, TagValue>> {
    return this.prog.watch
  }
  /**
   * The watch table with each bare {@link aliases alias} beside the variable it names, for a reader that looks values
   * up by the scene's tag names (a project test's checks). The watch table itself keeps the program's own names: two
   * rows for one variable would read as two variables.
   */
  get tagView(): Readonly<Record<string, TagValue>> {
    const watch = this.prog.watch
    if (this.aliases.size === 0) return watch
    const out: Record<string, TagValue> = { ...watch }
    for (const [bare, q] of this.aliases) {
      const v = watch[q]
      if (v !== undefined && !(bare in out)) out[bare] = v
    }
    return out
  }
  /** the program variable a scene tag name means: its alias's target, or the name itself */
  #resolve(name: string): string {
    return this.aliases.get(name) ?? name
  }
  get memory(): Readonly<Record<string, TagValue>> {
    return this.prog.memory
  }
  /** Where {@link watch}'s values are in the program's memory (CompiledProgram.watchPlan), or null. */
  watchPlan(): WatchPlan | null {
    return this.prog.watchPlan?.() ?? null
  }
  // the names the program declares for a scene, as it spells them: the watch table has each under that spelling
  #declared: Set<string> | null = null
  declaredKind(name: string): ValueKind | undefined {
    this.#declared ??= new Set([...this.prog.inputs, ...this.prog.outputs, ...this.prog.bindable])
    return this.#declared.has(name) ? PLAIN_KIND[this.prog.varInfo(name)?.type ?? ''] : undefined
  }
  /** What a variable is, by its watch-table name (CompiledProgram.varInfo). */
  varInfo(name: string): VarInfo | undefined {
    return this.prog.varInfo(this.#resolve(name))
  }
  /**
   * Write variables by name between scans, as an HMI or SCADA writes a PLC's tags: a Start button, a
   * setpoint. The next scan reads them. A constant is left alone, and so is a name the program does not
   * have; an input the scene feeds takes the scene's value again at the next scan, as it would on a PLC.
   */
  write(values: Readonly<Record<string, TagValue>>): void {
    for (const [name, v] of Object.entries(values)) this.prog.setInput(this.#resolve(name), v)
  }
  get tasks(): readonly TaskInfo[] {
    return this.prog.tasks
  }

  /** Write one variable between scans - a toggled bit. The next scan keeps it, or, if the
   *  program drives that place, overwrites it, which is exactly what a toggle promises. */
  force(name: string, value: TagValue): void {
    this.prog.setInput(this.#resolve(name), value)
  }

  /**
   * Hold variables at a value until released: the whole table, replacing the last one ({} releases them all). A held
   * value is written before each scan, so the program reads it whatever the scene feeds, and again after the scan,
   * so the output image and the next scan see it whatever the program wrote. Commissioning's force, as distinct from
   * {@link force}'s one write. A name the program does not have is ignored, as {@link write} ignores it.
   */
  setForces(forces: Readonly<Record<string, TagValue>>): void {
    this.#forces = Object.entries(forces).map(([tag, value]) => {
      const name = this.#resolve(tag)
      // a plain variable takes its port, as the inputs and outputs do; a struct path or one bit of a word (`Status.3`)
      // goes by name, which only setInput walks
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        const port = this.prog.port(name)
        return { set: (v: TagValue) => port.set(v), value }
      }
      return { set: (v: TagValue) => this.prog.setInput(name, v), value }
    })
    this.#applyForces()
  }

  #applyForces(): void {
    for (const f of this.#forces) f.set(f.value)
  }

  step(inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue> {
    return this.cycle(inputs, () => this.prog.scan(dt))
  }

  stepTask(index: number, inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue> {
    return this.cycle(inputs, () => this.prog.scanTask(index, dt))
  }

  private cycle(inputs: Readonly<Record<string, TagValue>>, scan: () => void): Record<string, TagValue> {
    const names = this.#inputs
    const inPorts = (this.#inPorts ??= names.map((n) => this.prog.port(this.#resolve(n))))
    for (let i = 0; i < names.length; i++) {
      const v = inputs[names[i]!]
      if (v !== undefined) inPorts[i]!.set(v)
    }
    if (this.#forces.length > 0) this.#applyForces()
    scan()
    if (this.#forces.length > 0) this.#applyForces()
    const out: Record<string, TagValue> = {}
    const outs = this.#outputs
    const outPorts = (this.#outPorts ??= outs.map((n) => this.prog.port(this.#resolve(n))))
    for (let i = 0; i < outs.length; i++) {
      const v = outPorts[i]!.get()
      if (v !== undefined) out[outs[i]!] = v
    }
    return out
  }
}

/** Fetch a `.st` asset (e.g. a bundled exercise) and compile it into a link. */
export async function loadProgram(url: string): Promise<LocalPlcLink> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to load ST program '${url}' (${res.status})`)
  return new LocalPlcLink(await res.text())
}
