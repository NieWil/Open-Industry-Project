// Expand a xacro robot description into URDF, as ROS's `xacro` tool does, so a robot published only as xacro (most
// vendor descriptions: one macro set for a family of arms) imports without ROS.
//
// Read in order, as ROS 2's xacro reads: properties (a value, a default, or a block), arguments, macros (parameters with
// defaults, `^` from the caller, `*block` and `**content`), includes, `if` / `unless`, `insert_block`, `element`,
// `attribute` and `call`. Text takes `${expression}` (core/xacroExpr.ts, a subset of Python) and the substitutions
// `$(arg)`, `$(find)`, `$(eval)`, `$(optenv)`, `$(dirname)` and `$(anon)`. `xacro.load_yaml` reads a YAML file in the
// folder. Not read: an include's `ns`, `$(env)`, and Python beyond the subset; each is refused with its reason.
//
// Files come from the picked folder through `XacroFiles`: no file system, no network, nothing run. A `$(find pkg)` is
// the folder whose package.xml names `pkg`, else a folder named `pkg`.

import { parseXml, xmlKid, type XmlNode } from './xml'
import { display, evalXacroExpr, pythonBuiltins, XacroExprError, type XacroDict, type XacroValue } from './xacroExpr'

export interface XacroFiles {
  /** every file the folder holds, by its path from the top of the pick (forward slashes) */
  paths: readonly string[]
  /** a file's text by its path, or undefined when the folder has none */
  read(path: string): string | undefined
  /** YAML text as a value; core carries no YAML reader, so the caller gives one */
  parseYaml(text: string): unknown
}

/**
 * Why a description could not be expanded. `missing-file` names the file in `path` (an include or YAML file the folder
 * lacks, often because an argument's default names a model that does not exist: see xacroArgChoices); `missing-arg`
 * names an argument with no value in `arg`.
 */
export class XacroError extends Error {
  /** the arguments' values when the expansion stopped, defaults included (expandXacro fills it in) */
  args: Record<string, string> = {}
  constructor(
    readonly code: 'missing-file' | 'missing-package' | 'missing-arg' | 'expression' | 'macro' | 'unsupported' | 'not-xml',
    message: string,
    readonly detail: { path?: string; arg?: string } = {},
  ) {
    super(message)
    this.name = 'XacroError'
  }
}

export interface XacroResult {
  /** the expanded `<robot>`, as plain URDF */
  robot: XmlNode
  /** every argument the description declared, with the value it was expanded with */
  args: Record<string, string>
}

/**
 * The YAML tags xacro's load_yaml reads: `!degrees 90` is the angle in radians, as xacro converts it, and `!radians`
 * is the number as written. Robot descriptions write joint limits and mesh rotations this way (Universal Robots' do
 * throughout). In the shape the `yaml` package takes as `customTags`, so the caller's YAML reader can be given them.
 */
export const XACRO_YAML_TAGS: { tag: string; resolve: (text: string) => number }[] = [
  { tag: '!degrees', resolve: (text) => (Number(text) * Math.PI) / 180 },
  { tag: '!radians', resolve: (text) => Number(text) },
]

/** how deep macros and includes may nest before the expansion is taken to be endless */
const MAX_DEPTH = 100

interface Macro {
  params: Param[]
  body: XmlNode[]
}
interface Param {
  name: string
  kind: 'value' | 'block' | 'content'
  /** the default as written, absent when the caller must give one */
  def?: string
  /** `^`: take the caller's property of the same name first */
  fromCaller?: boolean
}
interface Scope {
  vars: Map<string, XacroValue>
  blocks: Map<string, XmlNode[]>
  macros: Map<string, Macro>
  parent: Scope | null
}
const scopeUnder = (parent: Scope | null): Scope => ({ vars: new Map(), blocks: new Map(), macros: new Map(), parent })

/** Is this text a xacro document: one that declares the xacro namespace, uses its elements, or has `${...}`? */
export function isXacroText(text: string): boolean {
  return /<xacro:/.test(text) || /xmlns:xacro\s*=/.test(text) || /=\s*["'][^"']*\$\{/.test(text)
}

/**
 * Is a xacro document a robot to import, rather than a library of macros for one? An entry point builds something at
 * its top level (a link, a joint, or a macro call); a library only defines macros, properties and arguments.
 */
export function isXacroEntry(text: string): boolean {
  let root: XmlNode
  try {
    root = parseXml(text, 'xacro')
  } catch {
    return false
  }
  if (root.name !== 'robot') return false
  const DEFINES = new Set(['macro', 'property', 'arg', 'include'])
  const builds = (nodes: XmlNode[]): boolean =>
    nodes.some((n) => (n.prefix === 'xacro' ? (n.name === 'if' || n.name === 'unless' ? builds(n.children) : !DEFINES.has(n.name)) : n.name === 'link' || n.name === 'joint'))
  return builds(root.children)
}

/** The ROS packages in a folder: each package.xml's `<name>`, mapped to the folder holding it. */
export function xacroPackages(files: Pick<XacroFiles, 'paths' | 'read'>): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of files.paths) {
    if (!/(^|\/)package\.xml$/i.test(p)) continue
    const text = files.read(p)
    if (text === undefined) continue
    try {
      const name = xmlKid(parseXml(text, 'package.xml'), 'name')?.text.trim()
      if (name && !out.has(name)) out.set(name, dirOf(p))
    } catch {
      // not a package manifest after all
    }
  }
  return out
}

/** Expand the xacro document `root` (a path in `files`) with `args` set, into URDF. Throws XacroError. */
export function expandXacro(root: string, files: XacroFiles, args: Readonly<Record<string, string>> = {}): XacroResult {
  const packages = xacroPackages(files)
  const argValues: Record<string, string> = { ...args }
  const declared = new Set<string>()
  const global = scopeUnder(null)
  const dirs: string[] = [dirOf(root)]
  let depth = 0

  const read = (path: string): string => {
    const text = files.read(path)
    if (text === undefined) throw new XacroError('missing-file', `the file ${path} is not in the folder`, { path })
    return text
  }
  const parse = (path: string): XmlNode => {
    try {
      return parseXml(read(path), path)
    } catch (e) {
      if (e instanceof XacroError) throw e
      throw new XacroError('not-xml', (e as Error).message, { path })
    }
  }
  const findPackage = (name: string): string => {
    const dir = packages.get(name) ?? files.paths.map(dirOf).find((d) => d.split('/').pop() === name)
    if (dir === undefined) throw new XacroError('missing-package', `the package ${name} is not in the folder`, { path: name })
    return dir
  }
  const argValue = (name: string): string => {
    const v = argValues[name]
    if (v === undefined) throw new XacroError('missing-arg', `the argument ${name} has no value`, { arg: name })
    return v
  }
  /** a file named in the description: from the top of the folder when it starts with / ($(find)), else from the
   *  current file's folder */
  const resolve = (name: string): string => {
    const clean = name.replace(/^file:\/\//i, '')
    if (clean.startsWith('/')) return collapse(clean)
    return collapse(`${dirs[dirs.length - 1]}/${clean}`)
  }
  const loadYaml = (name: XacroValue): XacroValue => {
    const path = resolve(display(substitute(display(name), global)))
    try {
      return toValue(files.parseYaml(read(path)))
    } catch (e) {
      if (e instanceof XacroError) throw e
      throw new XacroError('expression', `could not read ${path} as YAML: ${(e as Error).message}`, { path })
    }
  }
  const builtins: XacroDict = {
    ...pythonBuiltins(),
    load_yaml: loadYaml,
    xacro: { load_yaml: loadYaml, arg: (n) => argValue(display(n)), print_location: () => null, message: () => null, warning: () => null, dotify: (x) => x },
  }

  const lookup = (scope: Scope, name: string): XacroValue | undefined => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const v = s.vars.get(name)
      // a property's value is text until an expression reads it: one that reads as a number is a number
      if (v !== undefined) return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v
    }
    return builtins[name]
  }
  const findIn = <T,>(scope: Scope, pick: (s: Scope) => Map<string, T>, name: string): T | undefined => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const v = pick(s).get(name)
      if (v !== undefined) return v
    }
    return undefined
  }

  const expr = (src: string, scope: Scope): XacroValue => {
    try {
      return evalXacroExpr(src, (n) => lookup(scope, n))
    } catch (e) {
      if (e instanceof XacroExprError) throw new XacroError('expression', `in \${${src}}: ${e.message}`)
      throw e
    }
  }

  /** `$(command args)`: its text */
  const extension = (inner: string, scope: Scope): string => {
    const text = display(substitute(inner, scope)).trim()
    const [cmd, ...rest] = text.split(/\s+/)
    switch (cmd) {
      case 'arg':
        return argValue(rest[0] ?? '')
      case 'find':
        // a leading / marks a path from the top of the folder, which resolve() keeps as it is
        return `/${findPackage(rest[0] ?? '')}`
      case 'eval': {
        const src = text.slice(4).trim()
        try {
          return display(evalXacroExpr(src, (n) => argValues[n] ?? lookup(scope, n)))
        } catch (e) {
          if (e instanceof XacroExprError) throw new XacroError('expression', `in $(eval ${src}): ${e.message}`)
          throw e
        }
      }
      case 'optenv':
        return rest.slice(1).join(' ')
      case 'dirname':
        return dirs[dirs.length - 1]!
      case 'anon':
        return rest[0] ?? ''
    }
    throw new XacroError('unsupported', `$(${cmd}) is not supported here (environment variables and commands are not read)`)
  }

  /** text with its `${...}` and `$(...)` worked out: the value itself when the text is one `${...}`, else text */
  function substitute(text: string, scope: Scope): XacroValue {
    if (!text.includes('$')) return text
    const parts: XacroValue[] = []
    let i = 0
    let literal = ''
    while (i < text.length) {
      if (text.startsWith('$${', i) || text.startsWith('$$(', i)) {
        literal += text.slice(i + 1, i + 3)
        i += 3
      } else if (text.startsWith('${', i)) {
        const end = text.indexOf('}', i + 2)
        if (end < 0) throw new XacroError('expression', `unclosed \${ in ${text}`)
        if (literal) parts.push(literal)
        literal = ''
        parts.push(expr(text.slice(i + 2, end), scope))
        i = end + 1
      } else if (text.startsWith('$(', i)) {
        let d = 0
        let end = -1
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === '(') d++
          else if (text[j] === ')' && --d === 0) {
            end = j
            break
          }
        }
        if (end < 0) throw new XacroError('expression', `unclosed $( in ${text}`)
        literal += extension(text.slice(i + 2, end), scope)
        i = end + 1
      } else literal += text[i++]
    }
    if (literal) parts.push(literal)
    if (parts.length === 1) return parts[0]!
    return parts.map(display).join('')
  }
  const textOf = (text: string, scope: Scope): string => display(substitute(text, scope))

  const condition = (node: XmlNode, scope: Scope): boolean => {
    const v = substitute(node.attrs.value ?? '', scope)
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    const s = display(v).trim()
    if (s === 'true' || s === 'True') return true
    if (s === 'false' || s === 'False') return false
    if (s !== '' && Number.isFinite(Number(s))) return Number(s) !== 0
    throw new XacroError('expression', `xacro:${node.name} needs true or false, not '${s}'`)
  }

  const nest = <T,>(what: string, run: () => T): T => {
    if (++depth > MAX_DEPTH) throw new XacroError('macro', `${what} nests more than ${MAX_DEPTH} deep: a macro or include calls itself`)
    try {
      return run()
    } finally {
      depth--
    }
  }

  const callMacro = (name: string, node: XmlNode, scope: Scope, out: XmlNode[], parent: XmlNode | null): void => {
    const macro = findIn(scope, (s) => s.macros, name)
    if (!macro) throw new XacroError('macro', `no macro named ${name}`)
    const inner = scopeUnder(scope)
    const elements = node.children
    let next = 0
    for (const p of macro.params) {
      if (p.kind === 'block') {
        const el = elements[next++]
        if (!el) throw new XacroError('macro', `${name} needs a block for *${p.name}`)
        inner.blocks.set(p.name, [el])
      } else if (p.kind === 'content') {
        inner.blocks.set(p.name, elements.slice(next))
        next = elements.length
      } else {
        const given = node.attrs[p.name]
        const fromCaller = p.fromCaller ? lookup(scope, p.name) : undefined
        if (given !== undefined) inner.vars.set(p.name, substitute(given, scope))
        else if (fromCaller !== undefined) inner.vars.set(p.name, fromCaller)
        else if (p.def !== undefined) inner.vars.set(p.name, substitute(p.def, scope))
        else throw new XacroError('macro', `${name} needs ${p.name}`)
      }
    }
    nest(`the macro ${name}`, () => run(macro.body, inner, out, parent))
  }

  function xacroElement(node: XmlNode, scope: Scope, out: XmlNode[], parent: XmlNode | null): void {
    const a = node.attrs
    switch (node.name) {
      case 'property': {
        const name = a.name ?? ''
        const target = a.scope === 'global' ? global : a.scope === 'parent' ? (scope.parent ?? scope) : scope
        if (a.value !== undefined) target.vars.set(name, substitute(a.value, scope))
        // a default only fills a property not set yet
        else if (a.default !== undefined) {
          if (findIn(scope, (s) => s.vars, name) === undefined) target.vars.set(name, substitute(a.default, scope))
        } else target.blocks.set(name, node.children)
        return
      }
      case 'arg': {
        const name = a.name ?? ''
        declared.add(name)
        if (argValues[name] === undefined && a.default !== undefined) argValues[name] = textOf(a.default, scope)
        return
      }
      case 'macro':
        scope.macros.set(a.name ?? '', { params: parseParams(a.params ?? ''), body: node.children })
        return
      case 'include': {
        if (a.ns !== undefined) throw new XacroError('unsupported', `xacro:include with a namespace (ns="${a.ns}") is not supported`)
        const path = resolve(textOf(a.filename ?? '', scope))
        const doc = parse(path)
        dirs.push(dirOf(path))
        try {
          nest(`the include of ${path}`, () => run(doc.children, scope, out, parent))
        } finally {
          dirs.pop()
        }
        return
      }
      case 'if':
      case 'unless':
        if (condition(node, scope) === (node.name === 'if')) run(node.children, scope, out, parent)
        return
      case 'insert_block': {
        const name = textOf(a.name ?? '', scope)
        const block = findIn(scope, (s) => s.blocks, name)
        if (!block) throw new XacroError('macro', `no block named ${name}`)
        nest(`the block ${name}`, () => run(block, scope, out, parent))
        return
      }
      case 'element': {
        const el: XmlNode = { name: textOf(a.name ?? '', scope), attrs: {}, children: [], text: '' }
        for (const [k, v] of Object.entries(a)) if (k !== 'name') el.attrs[k] = textOf(v, scope)
        run(node.children, scope, el.children, el)
        out.push(el)
        return
      }
      case 'attribute':
        if (parent) parent.attrs[textOf(a.name ?? '', scope)] = textOf(a.value ?? '', scope)
        return
      case 'call':
        callMacro(textOf(a.macro ?? '', scope), node, scope, out, parent)
        return
    }
    callMacro(node.name, node, scope, out, parent)
  }

  function run(nodes: readonly XmlNode[], scope: Scope, out: XmlNode[], parent: XmlNode | null): void {
    for (const node of nodes) {
      if (node.prefix === 'xacro') {
        xacroElement(node, scope, out, parent)
        continue
      }
      const el: XmlNode = { name: node.name, ...(node.prefix ? { prefix: node.prefix } : {}), attrs: {}, children: [], text: '' }
      for (const [k, v] of Object.entries(node.attrs)) el.attrs[k] = textOf(v, scope)
      el.text = node.text.trim() ? textOf(node.text, scope) : node.text
      run(node.children, scope, el.children, el)
      out.push(el)
    }
  }

  const robot: XmlNode = { name: 'robot', attrs: {}, children: [], text: '' }
  try {
    const doc = parse(root)
    if (doc.name !== 'robot') throw new XacroError('not-xml', `the root element of ${root} is <${doc.name}>, not <robot>`)
    run(doc.children, global, robot.children, robot)
    // the robot's own attributes last: they may read arguments its children declare (name="$(arg name)")
    for (const [k, v] of Object.entries(doc.attrs)) if (k !== 'xacro') robot.attrs[k] = textOf(v, global)
  } catch (e) {
    if (e instanceof XacroError) e.args = { ...argValues }
    throw e
  }
  const used: Record<string, string> = {}
  for (const name of declared) if (argValues[name] !== undefined) used[name] = argValues[name]!
  return { robot, args: used }
}

/**
 * When a description stops on a missing file because an argument names a model the folder does not have (UR's
 * `ur_type` defaults to `ur5x` on purpose, and its files live under `config/<ur_type>/`), the values that argument can
 * take: the folders or files beside the missing one that hold the rest of the path. Null when the error is not that.
 */
export function xacroArgChoices(error: XacroError, paths: readonly string[]): { arg: string; value: string; choices: string[] } | null {
  if (error.code !== 'missing-file' || !error.detail.path) return null
  const segs = error.detail.path.split('/')
  for (const [arg, value] of Object.entries(error.args)) {
    if (!value) continue
    const i = segs.findIndex((s) => s === value || s.replace(/\.[^.]+$/, '') === value)
    if (i < 0) continue
    const before = segs.slice(0, i).join('/')
    const after = segs.slice(i + 1).join('/')
    const ext = /\.[^.]+$/.exec(segs[i]!)?.[0] ?? ''
    const choices = new Set<string>()
    for (const p of paths) {
      const ps = p.split('/')
      if (ps.length !== segs.length || ps.slice(0, i).join('/') !== before || ps.slice(i + 1).join('/') !== after) continue
      const seg = ps[i]!
      if (ext && !seg.endsWith(ext)) continue
      choices.add(ext ? seg.slice(0, -ext.length) : seg)
    }
    if (choices.size > 0) return { arg, value, choices: [...choices].sort(naturalOrder) }
  }
  return null
}

/**
 * The on/off arguments that change what a description builds, with the value `result` used: each argument set to true
 * or false whose other value adds or removes a link or joint (Franka's `hand`). Those that change only what ROS reads
 * beside the robot (a controller, a simulator plugin) are left out, and so is one whose other value does not expand.
 * The description is expanded once more per true/false argument.
 */
export function xacroSwitches(root: string, files: XacroFiles, result: XacroResult): Record<string, boolean> {
  const shape = (robot: XmlNode): string =>
    robot.children
      .filter((c) => c.name === 'link' || c.name === 'joint')
      .map((c) => `${c.name} ${c.attrs.name ?? ''}`)
      .sort()
      .join('\n')
  const base = shape(result.robot)
  const out: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(result.args)) {
    // 0 and 1 are left out: as often a count or a voltage as a switch
    const on = /^true$/i.test(value) ? true : /^false$/i.test(value) ? false : null
    if (on === null) continue
    try {
      if (shape(expandXacro(root, files, { ...result.args, [name]: on ? 'false' : 'true' }).robot) !== base) out[name] = on
    } catch {
      // the other value does not build a robot from this folder, so it is no choice
    }
  }
  return out
}

/** ur3, ur5, ur10 rather than ur10, ur3, ur5 */
const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/** `a b:=1 c:=^ d:=^|2 *origin **content`, quoted defaults allowed, `=` for the old `:=` */
function parseParams(src: string): Param[] {
  const out: Param[] = []
  const re = /(\*{0,2})([A-Za-z_][\w]*)(?::?=(?:'([^']*)'|"([^"]*)"|(\S*)))?/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const stars = m[1]!
    const name = m[2]!
    if (stars) {
      out.push({ name, kind: stars === '**' ? 'content' : 'block' })
      continue
    }
    const raw = m[3] ?? m[4] ?? m[5]
    if (raw === undefined) out.push({ name, kind: 'value' })
    else if (raw.startsWith('^')) {
      const bar = raw.indexOf('|')
      out.push({ name, kind: 'value', fromCaller: true, ...(bar >= 0 ? { def: raw.slice(bar + 1) } : {}) })
    } else out.push({ name, kind: 'value', def: raw })
  }
  return out
}

/** a parsed YAML value as an expression value: numbers, text, booleans, null, lists and dicts */
function toValue(v: unknown): XacroValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(toValue)
  if (typeof v === 'object') {
    const d: XacroDict = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) d[k] = toValue(x)
    return d
  }
  return String(v)
}

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/')

function collapse(path: string): string {
  const out: string[] = []
  for (const s of path.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return out.join('/')
}
