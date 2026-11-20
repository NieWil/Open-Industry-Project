// Lexical determinism guard for custom-part scripts. partApi.ts and the SDK README state the rule in prose
// ("NEVER use Date / Math.random"); this enforces it. Authors (and AI codegen tools) use Date.now() and
// Math.random() because most JS does. This scan rejects those primitives at load, so the most common
// determinism mistake becomes an immediate error with a location instead of a silently non-reproducible twin.
//
// Determinism is a hard invariant for every part (docs/custom-part-capability-surface.md), so this runs in
// embeddedBehavior.create(), the single eval chokepoint, which buildPackage also goes through.
//
// It is lexical, not a full parser: it blanks comments + string/template literals (preserving positions
// for accurate line/col) and scans the remaining code for banned global identifiers. A `window`, `document` or
// `process` the script declares itself (`let window = 0`) is its own and is not flagged. It is conservative - it can
// over-reject an unusual identifier (an object key literally named `fetch`) and it can't see fully dynamic reaches (`globalThis['Da'+'te']`, `Math['random']`). It catches the common
// accidental mistakes. The SES sandbox (docs/part-sandbox.md) defends against adversarial code.

export interface DeterminismViolation {
  /** the banned token as written, e.g. `Date` or `Math.random` */
  name: string
  /** why it breaks determinism, and the deterministic alternative */
  reason: string
  /** 1-based line in the source */
  line: number
  /** 1-based column in the source */
  column: number
}

// Bare global identifiers that are nondeterministic or escape the part. Flagged only when used as a bare
// reference (`fetch(...)`), never as a property access (`obj.fetch`) - a part may have its own members.
const BANNED_GLOBALS: Record<string, string> = {
  Date: 'wall-clock time is nondeterministic - use ctx.simTime',
  performance: 'wall-clock time is nondeterministic - use ctx.simTime',
  crypto: 'nondeterministic randomness - use ctx.rng()',
  fetch: 'network/IO is not allowed in a part - a part must be a pure function of its inputs',
  XMLHttpRequest: 'network/IO is not allowed in a part',
  WebSocket: 'network/IO is not allowed in a part',
  EventSource: 'network/IO is not allowed in a part',
  setTimeout: 'async scheduling breaks deterministic tick order - do all work synchronously in step()',
  setInterval: 'async scheduling breaks deterministic tick order - do all work synchronously in step()',
  setImmediate: 'async scheduling breaks deterministic tick order - do all work synchronously in step()',
  queueMicrotask: 'async scheduling breaks deterministic tick order - do all work synchronously in step()',
  requestAnimationFrame: 'async scheduling breaks deterministic tick order - drive motion from ctx.simTime',
  window: 'host globals are not reachable from a part',
  document: 'host globals are not reachable from a part',
  globalThis: 'host globals are not reachable from a part',
  process: 'host globals are not reachable from a part',
  require: 'module loading is not allowed in a part',
  import: 'module loading is not allowed in a part',
  eval: 'dynamic code evaluation is not allowed in a part',
  Function: 'dynamic code evaluation is not allowed in a part',
}

// `Math` is allowed (Math.sin/cos/PI are deterministic); only its `.random` is banned.
const RANDOM_REASON = 'nondeterministic randomness - use ctx.rng() (seeded per instance)'

// Replace every comment and string/template-literal character with a space (newlines kept, so positions
// and line numbers are preserved 1:1 with the source), leaving only executable code. Template
// substitutions (`${ ... }`) are kept as code, since banned tokens can appear there too. Also used by core/loopGuard.ts.
export function blankNonCode(src: string): string {
  const out = src.split('')
  const N = src.length
  const blank = (i: number): void => {
    if (src[i] !== '\n') out[i] = ' '
  }
  // Lexical container stack: a code frame (optionally a `${}` substitution, tracking brace depth) or a
  // template-text frame.
  type Frame = { kind: 'code'; sub: boolean; depth: number } | { kind: 'template' }
  const stack: Frame[] = [{ kind: 'code', sub: false, depth: 0 }]
  let i = 0
  while (i < N) {
    const top = stack[stack.length - 1]!
    const c = src[i]
    const c2 = src[i + 1]
    if (top.kind === 'code') {
      if (c === '/' && c2 === '/') {
        while (i < N && src[i] !== '\n') blank(i++)
        continue
      }
      if (c === '/' && c2 === '*') {
        blank(i++)
        blank(i++)
        while (i < N && !(src[i] === '*' && src[i + 1] === '/')) blank(i++)
        if (i < N) {
          blank(i++)
          blank(i++)
        }
        continue
      }
      if (c === "'" || c === '"') {
        const q = c
        blank(i++)
        while (i < N && src[i] !== q) {
          if (src[i] === '\\') blank(i++)
          if (i < N) blank(i++)
        }
        if (i < N) blank(i++)
        continue
      }
      if (c === '`') {
        stack.push({ kind: 'template' })
        blank(i++)
        continue
      }
      if (top.sub) {
        if (c === '{') {
          top.depth++
          i++
          continue
        }
        if (c === '}') {
          if (top.depth === 0) {
            stack.pop() // back to the enclosing template text
            blank(i++)
            continue
          }
          top.depth--
          i++
          continue
        }
      }
      i++ // ordinary code char - leave it
      continue
    }
    // template text
    if (c === '\\') {
      blank(i++)
      if (i < N) blank(i++)
      continue
    }
    if (c === '`') {
      stack.pop()
      blank(i++)
      continue
    }
    if (c === '$' && c2 === '{') {
      stack.push({ kind: 'code', sub: true, depth: 0 })
      blank(i++)
      blank(i++)
      continue
    }
    blank(i++)
  }
  return out.join('')
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g
/** a declaration's name: `let x`, `const x`, `var x`, `function x`, `class x` (also `for (let x of ...)`) */
const DECLARED = /\b(?:let|const|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g

// The host-reach names a part may declare for itself (`let window = 0`, a weighing window). Only these: the exemption
// covers the whole script, so a `let Date` in one function would let a real `Date.now()` elsewhere through. The
// names that make a part run differently each time (clock, randomness, timers, IO) stay banned even when declared.
const OWNABLE = new Set(['window', 'document', 'process'])

/** the ownable names a script declares for itself, in code with comments and strings blanked */
function declaredNames(code: string): Set<string> {
  const names = new Set<string>()
  DECLARED.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DECLARED.exec(code))) if (OWNABLE.has(m[1]!)) names.add(m[1]!)
  return names
}

// The non-space, non-newline char before `idx` (and its index), used to tell a bare reference from a
// `.member` access.
function prevNonSpace(code: string, idx: number): { char: string; index: number } {
  let i = idx
  while (i >= 0 && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r')) i--
  return { char: i >= 0 ? code[i]! : '', index: i }
}

// The identifier ending at `idx` (inclusive), or '' - used to confirm a `.random` is `Math.random`.
function identEndingAt(code: string, idx: number): string {
  const end = idx
  if (end < 0 || !/[A-Za-z0-9_$]/.test(code[end]!)) return ''
  let start = end
  while (start > 0 && /[A-Za-z0-9_$]/.test(code[start - 1]!)) start--
  return code.slice(start, end + 1)
}

function lineColOf(source: string, index: number): { line: number; column: number } {
  let line = 1
  let last = -1
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line++
      last = i
    }
  }
  return { line, column: index - last }
}

/** The host-reach names a part script declares for itself (`let window`): its own bindings, which neither the scan
 *  nor the runtime's shims (core/parts/partScript.ts) treat as the host's globals. */
export function declaredNamesOf(source: string): Set<string> {
  return declaredNames(blankNonCode(source))
}

/**
 * Scan a custom-part script source for nondeterministic / sandbox-escaping primitives. Returns one
 * violation per banned use (empty array = clean). Used by embeddedBehavior.create() to reject the part
 * before it ever runs.
 */
export function checkDeterminism(source: string): DeterminismViolation[] {
  const code = blankNonCode(source)
  const own = declaredNames(code)
  const violations: DeterminismViolation[] = []
  IDENTIFIER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDENTIFIER.exec(code))) {
    const name = m[0]
    const start = m.index
    const before = prevNonSpace(code, start - 1)
    const isMember = before.char === '.'
    if (!isMember && name in BANNED_GLOBALS && !own.has(name)) {
      violations.push({ name, reason: BANNED_GLOBALS[name]!, ...lineColOf(source, start) })
    } else if (name === 'random' && isMember) {
      // confirm the object of `.random` is `Math` (the char before the dot is the object's last char)
      const obj = prevNonSpace(code, before.index - 1)
      if (identEndingAt(code, obj.index) === 'Math') {
        violations.push({ name: 'Math.random', reason: RANDOM_REASON, ...lineColOf(source, start) })
      }
    }
  }
  return violations
}

/** One-line summary of violations for an error message; '' when clean. */
export function formatDeterminismViolations(violations: DeterminismViolation[]): string {
  if (violations.length === 0) return ''
  return violations.map((v) => `${v.name} (line ${v.line}:${v.column}) - ${v.reason}`).join('; ')
}
