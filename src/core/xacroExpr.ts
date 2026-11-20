// The expressions inside xacro's `${...}`: a small subset of Python, the part robot descriptions use. Numbers,
// strings, True / False / None, lists, dicts; + - * / // % **; comparisons, `in`, `not in`, `and`, `or`, `not`;
// `a if c else b`; indexing, attribute access (a YAML dict's keys read as attributes, as xacro allows) and calls of
// the functions given by the caller and of a few string methods. It is evaluated by walking the parse, never by
// running text as code: a robot description comes from outside, so nothing in it can reach the host.

export type XacroValue = number | string | boolean | null | XacroValue[] | XacroDict | XacroFn
export interface XacroDict {
  [key: string]: XacroValue
}
export type XacroFn = (...args: XacroValue[]) => XacroValue

/** A wrapped function, told apart from a dict by this tag (a YAML file can hold any key, never a function). */
export const isFn = (v: XacroValue): v is XacroFn => typeof v === 'function'

export class XacroExprError extends Error {}

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'name'; v: string } | { k: 'op'; v: string } | { k: 'end' }

const OPS = ['**', '//', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '(', ')', '[', ']', '{', '}', ',', '.', ':']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let s = ''
      let j = i + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[++j]!
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e
        } else s += src[j]
      }
      if (j >= src.length) throw new XacroExprError(`unterminated string in ${src}`)
      out.push({ k: 'str', v: s })
      i = j + 1
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (name) {
      out.push({ k: 'name', v: name[0] })
      i += name[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new XacroExprError(`unexpected '${c}' in ${src}`)
    out.push({ k: 'op', v: op })
    i += op.length
  }
  out.push({ k: 'end' })
  return out
}

/** A parsed expression: a tree of thunks, each evaluating one node when called. */
type Node = () => XacroValue

/** What an expression's names resolve to; undefined for a name that is not defined. */
export type XacroLookup = (name: string) => XacroValue | undefined

/** Evaluate `src` with its names read through `lookup`. Throws XacroExprError with the reason. */
export function evalXacroExpr(src: string, lookup: XacroLookup): XacroValue {
  const toks = lex(src)
  let p = 0
  const peek = (): Tok => toks[p]!
  const isOp = (v: string): boolean => {
    const t = peek()
    return t.k === 'op' && t.v === v
  }
  const isWord = (v: string): boolean => {
    const t = peek()
    return t.k === 'name' && t.v === v
  }
  const expect = (v: string): void => {
    if (!isOp(v)) throw new XacroExprError(`expected '${v}' in ${src}`)
    p++
  }

  const ternary = (): Node => {
    const a = orExpr()
    if (!isWord('if')) return a
    p++
    const c = orExpr()
    if (!isWord('else')) throw new XacroExprError(`expected 'else' in ${src}`)
    p++
    const b = ternary()
    return () => (truthy(c()) ? a() : b())
  }
  const orExpr = (): Node => {
    let a = andExpr()
    while (isWord('or')) {
      p++
      const l = a
      const r = andExpr()
      a = () => {
        const v = l()
        return truthy(v) ? v : r()
      }
    }
    return a
  }
  const andExpr = (): Node => {
    let a = notExpr()
    while (isWord('and')) {
      p++
      const l = a
      const r = notExpr()
      a = () => {
        const v = l()
        return truthy(v) ? r() : v
      }
    }
    return a
  }
  const notExpr = (): Node => {
    if (isWord('not')) {
      p++
      const a = notExpr()
      return () => !truthy(a())
    }
    return comparison()
  }
  const comparison = (): Node => {
    const first = sum()
    const ops: string[] = []
    const rest: Node[] = []
    for (;;) {
      const t = peek()
      let op: string | null = null
      if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) op = t.v
      else if (t.k === 'name' && t.v === 'in') op = 'in'
      else if (t.k === 'name' && t.v === 'not' && toks[p + 1]?.k === 'name' && (toks[p + 1] as { v: string }).v === 'in') {
        op = 'not in'
        p++
      } else if (t.k === 'name' && t.v === 'is') {
        op = toks[p + 1]?.k === 'name' && (toks[p + 1] as { v: string }).v === 'not' ? 'is not' : 'is'
        if (op === 'is not') p++
      }
      if (!op) break
      p++
      ops.push(op)
      rest.push(sum())
    }
    if (ops.length === 0) return first
    // a < b < c is a < b and b < c
    return () => {
      let l = first()
      for (let i = 0; i < ops.length; i++) {
        const r = rest[i]!()
        if (!compare(ops[i]!, l, r)) return false
        l = r
      }
      return true
    }
  }
  const sum = (): Node => {
    let a = term()
    while (isOp('+') || isOp('-')) {
      const op = (peek() as { v: string }).v
      p++
      const l = a
      const r = term()
      a = () => arith(op, l(), r())
    }
    return a
  }
  const term = (): Node => {
    let a = factor()
    while (isOp('*') || isOp('/') || isOp('//') || isOp('%')) {
      const op = (peek() as { v: string }).v
      p++
      const l = a
      const r = factor()
      a = () => arith(op, l(), r())
    }
    return a
  }
  const factor = (): Node => {
    if (isOp('-') || isOp('+')) {
      const neg = isOp('-')
      p++
      const a = factor()
      return () => {
        const v = num(a())
        return neg ? -v : v
      }
    }
    return power()
  }
  const power = (): Node => {
    const a = postfix()
    if (!isOp('**')) return a
    p++
    const b = factor()
    return () => num(a()) ** num(b())
  }
  const postfix = (): Node => {
    let a = atom()
    for (;;) {
      if (isOp('[')) {
        p++
        const k = ternary()
        expect(']')
        const base = a
        a = () => index(base(), k())
      } else if (isOp('.')) {
        p++
        const t = peek()
        if (t.k !== 'name') throw new XacroExprError(`expected a name after '.' in ${src}`)
        p++
        const base = a
        const name = t.v
        a = () => attribute(base(), name)
      } else if (isOp('(')) {
        p++
        const args: Node[] = []
        while (!isOp(')')) {
          args.push(ternary())
          if (!isOp(')')) expect(',')
        }
        p++
        const fn = a
        a = () => {
          const f = fn()
          if (!isFn(f)) throw new XacroExprError(`${display(f)} is not a function`)
          return f(...args.map((x) => x()))
        }
      } else return a
    }
  }
  const atom = (): Node => {
    const t = peek()
    p++
    if (t.k === 'num' || t.k === 'str') return () => t.v
    if (t.k === 'name') {
      if (t.v === 'True') return () => true
      if (t.v === 'False') return () => false
      if (t.v === 'None') return () => null
      const name = t.v
      return () => {
        const v = lookup(name)
        if (v === undefined) throw new XacroExprError(`'${name}' is not defined`)
        return v
      }
    }
    if (t.k === 'op' && (t.v === '(' || t.v === '[')) {
      const close = t.v === '(' ? ')' : ']'
      const items: Node[] = []
      let comma = false
      while (!isOp(close)) {
        items.push(ternary())
        if (!isOp(close)) {
          expect(',')
          comma = true
        }
      }
      p++
      // (a) is a, (a,) and [a] are lists
      if (close === ')' && items.length === 1 && !comma) return items[0]!
      return () => items.map((x) => x())
    }
    if (t.k === 'op' && t.v === '{') {
      const entries: [Node, Node][] = []
      while (!isOp('}')) {
        const k = ternary()
        expect(':')
        entries.push([k, ternary()])
        if (!isOp('}')) expect(',')
      }
      p++
      return () => {
        const d: XacroDict = {}
        for (const [k, v] of entries) d[String(k())] = v()
        return d
      }
    }
    throw new XacroExprError(`unexpected ${t.k === 'end' ? 'end' : `'${(t as { v: unknown }).v}'`} in ${src}`)
  }

  const tree = ternary()
  if (peek().k !== 'end') throw new XacroExprError(`unexpected text after the expression in ${src}`)
  return tree()
}

/** Python's truth: 0, '', empty lists and dicts, None and False are false. */
export function truthy(v: XacroValue): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0
  return !!v
}

/** A value as text, as Python's str() writes it. */
export function display(v: XacroValue): string {
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null) return 'None'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (isFn(v)) return '<function>'
  if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`
  return `{${Object.entries(v).map(([k, x]) => `'${k}': ${repr(x)}`).join(', ')}}`
}
const repr = (v: XacroValue): string => (typeof v === 'string' ? `'${v}'` : display(v))

/** A number from a value: a number, a boolean, or text that reads as one (xacro keeps property values as text). */
export function num(v: XacroValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  throw new XacroExprError(`${repr(v)} is not a number`)
}

const numeric = (v: XacroValue): boolean => typeof v === 'number' || typeof v === 'boolean'

function arith(op: string, a: XacroValue, b: XacroValue): XacroValue {
  if (op === '+') {
    if (typeof a === 'string' && typeof b === 'string') return a + b
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  }
  if (op === '*') {
    if (typeof a === 'string' && numeric(b)) return a.repeat(Math.max(0, num(b)))
    if (Array.isArray(a) && numeric(b)) return Array.from({ length: Math.max(0, num(b)) }, () => a).flat()
  }
  const x = num(a)
  const y = num(b)
  switch (op) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      if (y === 0) throw new XacroExprError('division by zero')
      return x / y
    case '//':
      if (y === 0) throw new XacroExprError('division by zero')
      return Math.floor(x / y)
    case '%':
      if (y === 0) throw new XacroExprError('division by zero')
      return x - y * Math.floor(x / y)
  }
  throw new XacroExprError(`unknown operator ${op}`)
}

function equal(a: XacroValue, b: XacroValue): boolean {
  if (numeric(a) && numeric(b)) return num(a) === num(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]!))
  return a === b
}

function compare(op: string, a: XacroValue, b: XacroValue): boolean {
  switch (op) {
    case '==':
      return equal(a, b)
    case '!=':
      return !equal(a, b)
    case 'is':
      return a === b
    case 'is not':
      return a !== b
    case 'in':
    case 'not in': {
      let has: boolean
      if (typeof b === 'string') has = b.includes(String(a))
      else if (Array.isArray(b)) has = b.some((x) => equal(x, a))
      else if (b !== null && typeof b === 'object' && !isFn(b)) has = Object.prototype.hasOwnProperty.call(b, String(a))
      else throw new XacroExprError(`'in' needs a string, list or dict, not ${repr(b)}`)
      return op === 'in' ? has : !has
    }
  }
  const [x, y] = typeof a === 'string' && typeof b === 'string' ? [a, b] : [num(a), num(b)]
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y
}

function index(base: XacroValue, k: XacroValue): XacroValue {
  if (Array.isArray(base) || typeof base === 'string') {
    const i = num(k)
    const at = i < 0 ? base.length + i : i
    const v = base[at]
    if (v === undefined) throw new XacroExprError(`index ${i} is out of range`)
    return v
  }
  if (base !== null && typeof base === 'object' && !isFn(base)) {
    const key = String(k)
    if (!Object.prototype.hasOwnProperty.call(base, key)) throw new XacroExprError(`no key '${key}'`)
    return base[key]!
  }
  throw new XacroExprError(`${repr(base)} cannot be indexed`)
}

const STRING_METHODS: Record<string, (s: string, ...a: XacroValue[]) => XacroValue> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  strip: (s) => s.trim(),
  split: (s, sep) => (sep === undefined || sep === null ? s.trim().split(/\s+/).filter((x) => x !== '') : s.split(String(sep))),
  startswith: (s, x) => s.startsWith(String(x)),
  endswith: (s, x) => s.endsWith(String(x)),
  replace: (s, a, b) => s.split(String(a)).join(String(b)),
}

function attribute(base: XacroValue, name: string): XacroValue {
  if (typeof base === 'string') {
    const m = STRING_METHODS[name]
    if (m) return (...args: XacroValue[]) => m(base, ...args)
    throw new XacroExprError(`text has no method '${name}'`)
  }
  // a module (math, xacro) or a YAML dict, whose keys xacro lets an expression read as attributes
  if (base !== null && typeof base === 'object' && !Array.isArray(base) && !isFn(base)) {
    if (Object.prototype.hasOwnProperty.call(base, name)) return base[name]!
    throw new XacroExprError(`no attribute '${name}'`)
  }
  throw new XacroExprError(`${repr(base)} has no attribute '${name}'`)
}

/** The functions and constants Python gives an expression without an import, and its `math` module. */
export function pythonBuiltins(): XacroDict {
  const f1 = (fn: (x: number) => number): XacroFn => (x) => fn(num(x))
  const math: XacroDict = {
    pi: Math.PI,
    e: Math.E,
    tau: 2 * Math.PI,
    inf: Infinity,
    sin: f1(Math.sin),
    cos: f1(Math.cos),
    tan: f1(Math.tan),
    asin: f1(Math.asin),
    acos: f1(Math.acos),
    atan: f1(Math.atan),
    atan2: (y, x) => Math.atan2(num(y), num(x)),
    sqrt: f1(Math.sqrt),
    exp: f1(Math.exp),
    log: (x, b) => (b === undefined ? Math.log(num(x)) : Math.log(num(x)) / Math.log(num(b))),
    fabs: f1(Math.abs),
    floor: f1(Math.floor),
    ceil: f1(Math.ceil),
    pow: (x, y) => num(x) ** num(y),
    radians: f1((d) => (d * Math.PI) / 180),
    degrees: f1((r) => (r * 180) / Math.PI),
  }
  return {
    ...math,
    math,
    abs: f1(Math.abs),
    min: (...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(num)),
    max: (...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(num)),
    round: (x, n) => {
      const k = 10 ** (n === undefined || n === null ? 0 : num(n))
      return Math.round(num(x) * k) / k
    },
    float: (x) => num(x),
    int: (x) => Math.trunc(num(x)),
    str: (x) => display(x),
    bool: (x) => truthy(x),
    len: (x) => {
      if (typeof x === 'string' || Array.isArray(x)) return x.length
      if (x !== null && typeof x === 'object') return Object.keys(x).length
      throw new XacroExprError(`${repr(x)} has no length`)
    },
  }
}
