// The single compile chokepoint for custom-part scripts, shared by the sim runtime
// (src/sim/embeddedBehavior.ts) and the render/headless geometry evaluator (src/core/geometry/geometryEval.ts).
// Everything a host needs to turn a source string into a PartDefinition lives here, so the two layers
// cannot drift: with separate copies one could coerce a malformed `numberList` override to the schema
// default while the other didn't, and the same bad override would build different geometry per layer.
//
// Two determinism tiers guard the eval:
//  1. the lexical scan (core/determinism.ts) - rejects the accidental mistakes (`Date.now()`,
//     `Math.random()`) before the source ever parses, with line/column locations;
//  2. runtime shims (this module) - the compiled factory receives shadowed bindings for the banned
//     globals, so a reach the scan can't see (`const m = Math; m.random()`) throws a located,
//     explanatory error at run time instead of silently making the twin non-reproducible.
// `"use strict"` is prepended so sloppy-mode `this` can't reach globalThis.
//
// Neither tier is a security boundary. The sandbox is: once the realm is locked down
// (core/realmLockdown.ts, which the page and the sim worker run first), every script compiles inside an
// SES Compartment and can reach only the language's own globals and what its entry points are handed
// (docs/part-sandbox.md). Hosts that never lock down (CLIs, unlocked unit tests) compile with the plain
// Function constructor.

import { checkDeterminism, declaredNamesOf, formatDeterminismViolations } from '../determinism'
import { instrumentLoops, LOOP_BUDGET, LOOP_GUARD } from '../loopGuard'
import type { ParamSchema, ParamValue, PartDefinition } from './partApi'
import { partSandboxActive } from './partSandbox'

/** A parsed part script: `factory` re-runs the script top level (fresh closures per call); `error`
 *  explains a null factory (determinism violation / syntax error). */
export interface CompiledPartScript {
  factory: ((definePart: (d: PartDefinition) => void) => void) | null
  error: string
}

// --- runtime determinism shims -----------------------------------------------------------------

// Math with only `random` replaced - sin/cos/PI/imul/... are deterministic and heavily used.
const safeMath: typeof Math = (() => {
  const m = Object.create(null) as Record<string, unknown>
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = Math[k as keyof typeof Math]
  m.random = (): never => {
    throw new Error('Math.random is nondeterministic in a part - use ctx.rng() (seeded per instance)')
  }
  return Object.freeze(m) as unknown as typeof Math
})()

// A binding that throws an explanatory error on any use (call, construct, property read). These only
// fire when code evaded the lexical scan (a bare `Date` never loads), so they throw rather than tolerate the use.
function throwingGlobal(name: string, reason: string): unknown {
  const die = (): never => {
    throw new Error(`${name} is not available in a part - ${reason}`)
  }
  return new Proxy(function () {}, { apply: die, construct: die, get: die, set: die, has: die })
}

const TIME_REASON = 'wall-clock time is nondeterministic; use ctx.simTime'
const RAND_REASON = 'nondeterministic randomness; use ctx.rng()'
const IO_REASON = 'a part must be a pure function of its inputs (no network/host IO)'
const ASYNC_REASON = 'async scheduling breaks deterministic tick order; do all work synchronously in step()'
const HOST_REASON = 'host globals are not reachable from a part'

// Shadowed parameter names for the compiled factory. Must be valid strict-mode parameter identifiers:
// `eval`/`arguments` are forbidden there and `import` is a keyword, but all three are already rejected
// lexically; `globalThis` is left to the scan too (parameter-shadowing it is dubious across engines).
const SHIMS: Record<string, unknown> = {
  Math: safeMath,
  Date: throwingGlobal('Date', TIME_REASON),
  performance: throwingGlobal('performance', TIME_REASON),
  crypto: throwingGlobal('crypto', RAND_REASON),
  fetch: throwingGlobal('fetch', IO_REASON),
  XMLHttpRequest: throwingGlobal('XMLHttpRequest', IO_REASON),
  WebSocket: throwingGlobal('WebSocket', IO_REASON),
  EventSource: throwingGlobal('EventSource', IO_REASON),
  setTimeout: throwingGlobal('setTimeout', ASYNC_REASON),
  setInterval: throwingGlobal('setInterval', ASYNC_REASON),
  setImmediate: throwingGlobal('setImmediate', ASYNC_REASON),
  queueMicrotask: throwingGlobal('queueMicrotask', ASYNC_REASON),
  requestAnimationFrame: throwingGlobal('requestAnimationFrame', ASYNC_REASON),
  window: throwingGlobal('window', HOST_REASON),
  document: throwingGlobal('document', HOST_REASON),
  process: throwingGlobal('process', HOST_REASON),
  require: throwingGlobal('require', 'module loading is not allowed in a part'),
  Function: throwingGlobal('Function', 'dynamic code evaluation is not allowed in a part'),
}
// --- CPU budget (core/loopGuard.ts) -------------------------------------------------------------

// Iterations counted since the current outermost call into part code began. Part code runs synchronously
// on one thread, so one counter serves every instance: `enterPart` resets it on the way in.
let loopCount = 0
let partDepth = 0

// --- hang beacon (docs/part-sandbox.md, "Hangs in the simulation") -------------------------------------
//
// The loop budget stops loops, not deep recursion that stays under the stack limit, a pathological regex or a very
// slow call. The sim worker shares a small buffer with the page: on the way into part code the outermost call marks
// itself and names its part, and clears the mark on the way out. A page that sees no frame for long reads the buffer,
// so it can say which part the worker is stuck in before it ends the worker. Layout: Int32 [in part code, label byte
// length], then the label's UTF-8 bytes.
const BEACON_LABEL_BYTES = 120
/** The size of the buffer {@link setPartCallBeacon} takes. */
export const PART_CALL_BEACON_BYTES = 8 + BEACON_LABEL_BYTES
let beacon: { state: Int32Array; label: Uint8Array; labelOf: (source: string) => string; current: Uint8Array | null } | null = null

/** Share `buffer` (PART_CALL_BEACON_BYTES) as the beacon; `labelOf` names the part a script belongs to. Null stops it. */
export function setPartCallBeacon(buffer: SharedArrayBuffer | null, labelOf: (source: string) => string = () => ''): void {
  beacon = buffer ? { state: new Int32Array(buffer, 0, 2), label: new Uint8Array(buffer, 8, BEACON_LABEL_BYTES), labelOf, current: null } : null
}

/** Read a beacon: the part being run when it was read, or null when the worker was outside part code. */
export function readPartCallBeacon(buffer: SharedArrayBuffer): { label: string } | null {
  const state = new Int32Array(buffer, 0, 2)
  if (Atomics.load(state, 0) === 0) return null
  const len = Math.min(Atomics.load(state, 1), BEACON_LABEL_BYTES)
  return { label: new TextDecoder().decode(new Uint8Array(buffer, 8, len).slice()) }
}

function labelBytesOf(source: string): Uint8Array | null {
  if (!beacon) return null
  const bytes = new TextEncoder().encode(beacon.labelOf(source))
  return bytes.length > BEACON_LABEL_BYTES ? bytes.slice(0, BEACON_LABEL_BYTES) : bytes
}

function beaconEnter(bytes: Uint8Array | null): void {
  if (!beacon || !bytes) return
  if (beacon.current !== bytes) {
    beacon.label.fill(0)
    beacon.label.set(bytes)
    Atomics.store(beacon.state, 1, bytes.length)
    beacon.current = bytes
  }
  Atomics.store(beacon.state, 0, 1)
}

function beaconLeave(): void {
  if (beacon) Atomics.store(beacon.state, 0, 0)
}
function loopGuard(): true {
  if (++loopCount > LOOP_BUDGET) {
    loopCount = 0
    throw new Error(`a loop in this part ran more than ${LOOP_BUDGET.toLocaleString('en-US')} iterations in one call and was stopped - almost certainly a loop that never ends`)
  }
  return true
}
function enterPart<T>(run: () => T, label: Uint8Array | null = null): T {
  if (partDepth === 0) {
    loopCount = 0
    beaconEnter(label)
  }
  partDepth++
  try {
    return run()
  } finally {
    partDepth--
    if (partDepth === 0) beaconLeave()
  }
}
// Every entry point a host calls on a definition: wrapping them here budgets every host at once (the sim's
// step/init/dispose, the renderer's geometry) without each one having to remember a reset.
const ENTRY_POINTS = ['geometry', 'init', 'step', 'react', 'dispose'] as const
function budgeted(captured: PartDefinition, label: Uint8Array | null): PartDefinition {
  // a part may hand over a frozen definition (harden() exists in its sandbox); wrap a copy then
  const def = Object.isFrozen(captured) ? { ...captured } : captured
  const d = def as unknown as Record<string, unknown>
  for (const k of ENTRY_POINTS) {
    const fn = d[k]
    if (typeof fn !== 'function') continue
    const f = fn as (a?: unknown, b?: unknown, c?: unknown) => unknown
    // inlined enterPart, fixed arity (every entry point takes ≤ 3): step runs per part per tick, so no
    // closure or rest array per call
    d[k] = (a?: unknown, b?: unknown, c?: unknown): unknown => {
      if (partDepth === 0) {
        loopCount = 0
        if (beacon) beaconEnter(label)
      }
      partDepth++
      try {
        return f.call(def, a, b, c)
      } finally {
        partDepth--
        if (partDepth === 0 && beacon) beaconLeave()
      }
    }
  }
  return def
}

const SHIM_NAMES = [...Object.keys(SHIMS), LOOP_GUARD]
const SHIM_VALUES = [...Object.keys(SHIMS).map((n) => SHIMS[n]), loopGuard]

/** the shims for one source: a name the script declares itself is its own, and a shim parameter of the same name
 *  would make its `let window` a redeclaration */
function shimsFor(source: string): { names: string[]; values: unknown[] } {
  const own = declaredNamesOf(source)
  if (![...own].some((n) => n in SHIMS)) return { names: SHIM_NAMES, values: SHIM_VALUES }
  const names = Object.keys(SHIMS).filter((n) => !own.has(n))
  return { names: [...names, LOOP_GUARD], values: [...names.map((n) => SHIMS[n]), loopGuard] }
}

// --- the sandbox (docs/part-sandbox.md) ------------------------------------------------------------

// Once the realm is locked down (core/realmLockdown.ts), part code compiles inside an SES Compartment: it sees the
// language's own globals and the arguments its entry points are handed, and nothing of the page or the worker. The
// globals it uses most are bound as parameters of the wrapper, because a Compartment resolves every other free name
// through a scope proxy (~15-20x slower per lookup). `Math` and the banned names arrive the same way, as shims.
//
// `Error` is bound from the Compartment's global (SES's shared Error), never the host's. Under errorTaming 'unsafe'
// the host realm's Error carries a live `prepareStackTrace` setter: handed that one, a part could install a stack
// formatter that runs host-side whenever the app reads an error's `.stack`. The Compartment's Error ignores the
// write, and shares Error.prototype with the host, so `instanceof Error`, `.message` and `.stack` on a part's thrown
// error read the same as with the host's. TypeError / RangeError are already the same object in both, and inherit the
// Compartment's Error, so binding the host's is harmless.
const BOUND_GLOBALS = [
  'Array', 'Object', 'Number', 'String', 'Boolean', 'JSON', 'Error', 'TypeError', 'RangeError', 'Map', 'Set',
  'WeakMap', 'Symbol', 'Float32Array', 'Float64Array', 'Uint32Array', 'Uint16Array', 'Int32Array', 'Uint8Array',
  'Infinity', 'NaN', 'undefined', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
]
let shimsHardened = false

interface SesCompartment {
  evaluate(code: string): unknown
  readonly globalThis: Record<string, unknown>
}

/** the names bound from the Compartment's own global rather than the host's (see BOUND_GLOBALS) */
const COMPARTMENT_BOUND = new Set(['Error'])

/** compile `body` as a function of `params` inside a fresh Compartment (one per distinct part source) */
function compileSandboxed(params: readonly string[], body: string): (...args: unknown[]) => void {
  if (!shimsHardened) {
    // everything handed to part code is frozen, so no part can rewrite what the next one is given
    const hardenAll = (globalThis as unknown as { harden: (x: unknown) => unknown }).harden
    for (const v of SHIM_VALUES) hardenAll(v)
    shimsHardened = true
  }
  const Ctor = (globalThis as unknown as { Compartment: new (opts: object) => SesCompartment }).Compartment
  const compartment = new Ctor({ globals: {}, __options__: true })
  const outer = compartment.evaluate(`(function (${BOUND_GLOBALS.join(', ')}) { return function (${params.join(', ')}) {\n${body}\n} })`) as (
    ...g: unknown[]
  ) => (...args: unknown[]) => void
  return outer(...BOUND_GLOBALS.map((n) => (COMPARTMENT_BOUND.has(n) ? compartment.globalThis : (globalThis as Record<string, unknown>))[n]))
}

/** the compile every host uses: sandboxed once the realm is locked down, else the plain Function constructor */
function compileFactory(params: readonly string[], body: string): (...args: unknown[]) => void {
  return partSandboxActive() ? compileSandboxed(params, body) : (new Function(...params, body) as (...args: unknown[]) => void)
}

// --- compile ------------------------------------------------------------------------------------

// Scan + parse happen once per distinct source; the cached factory re-runs cheaply per instance.
// The behavior editor compiles on every typing pause, so the cache is bounded, evicting the least recently used
// entry: a hit moves to the newest end, so the scene's own scripts outlive a long run of editor drafts.
const COMPILED_MAX = 256
const compiled = new Map<string, CompiledPartScript>()

/**
 * Scan + parse a part script into a reusable factory. Cached per source string; a failed source is
 * negatively cached (`factory: null` + `error`) so a bad script isn't re-scanned. The factory itself
 * is not memoized per definition: each call re-runs the script's top level, so module-level state a
 * script closes over stays isolated per instance (two placed parts never share a `let counter`).
 */
export function compilePartScript(source: string): CompiledPartScript {
  const hit = compiled.get(source)
  if (hit) {
    compiled.delete(source)
    compiled.set(source, hit)
    return hit
  }
  let out: CompiledPartScript
  const violations = checkDeterminism(source)
  if (violations.length > 0) {
    out = { factory: null, error: `part is not deterministic: ${formatDeterminismViolations(violations)}` }
  } else {
    try {
      // The loop-instrumented source when it parses, else the author's own source (the lexical rewrite in
      // core/loopGuard.ts misread something). A misread drops the loop budget but never breaks the part.
      let fn: (...args: unknown[]) => void
      const shims = shimsFor(source)
      try {
        fn = compileFactory(['definePart', ...shims.names], `"use strict";\n${instrumentLoops(source)}`)
      } catch {
        fn = compileFactory(['definePart', ...shims.names], `"use strict";\n${source}`)
      }
      out = {
        factory: (definePart) => {
          fn(definePart, ...shims.values)
        },
        error: '',
      }
    } catch (e) {
      out = { factory: null, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (compiled.size >= COMPILED_MAX) compiled.delete(compiled.keys().next().value!)
  compiled.set(source, out)
  return out
}

/**
 * Run a compiled script's top level once and capture its `definePart(...)` definition, in a fresh
 * closure environment per call (the sim instantiates one per placed part). `def: null` + `error` on a
 * determinism violation, a syntax/eval error, a top-level throw, or a script that never calls definePart.
 */
export function instantiatePartScript(source: string): { def: PartDefinition | null; error: string } {
  const script = compilePartScript(source)
  if (!script.factory) return { def: null, error: script.error }
  const label = labelBytesOf(source)
  let def: PartDefinition | null = null
  try {
    // the top level is part code too: a loop there is budgeted like one in step()
    const factory = script.factory
    enterPart(
      () =>
        factory((d) => {
          def = d
        }),
      label,
    )
  } catch (e) {
    return { def: null, error: e instanceof Error ? e.message : String(e) }
  }
  const captured: PartDefinition | null = def
  if (!captured) return { def: null, error: 'part script did not call definePart(...)' }
  try {
    // inside the try: the definition is the part's own object, and one built to resist wrapping (a setter-only
    // entry point, a Proxy) must fail here, as a compile error, not in whichever host first calls it
    return { def: budgeted(captured, label), error: '' }
  } catch (e) {
    return { def: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- params -------------------------------------------------------------------------------------

// Validate a `numberList` override is a real number[][] - fulfilling the SDK promise that a numberList
// param "arrives already parsed and validated". Anything else (a stray string, a ragged/non-numeric
// array) is rejected to the schema default rather than crashing the tick. Strings are not parsed: the
// typed grid is the only valid override shape (callers pass real arrays - see src/editor/demo/demoScenes.ts).
function coerceNumberList(value: ParamValue, fallback: ParamValue): ParamValue {
  if (Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
    return value as number[][]
  }
  return fallback
}

/**
 * Resolve a part's param bag: schema default when an instance override is absent, `numberList`
 * overrides validated (malformed → the schema default), unknown override keys passed through. The one
 * resolution both the behavior runtime and the geometry evaluator use, so `geometry()` and `step()`
 * always see the same values whether the host is sim, render, or headless.
 *
 * Array and object values are copies: the bag goes straight to part code, and a numberList row or a schema
 * default is otherwise the store's own array or the package manifest's (the store only freezes in dev), which a
 * part could rewrite in place behind undo, autosave and the room (docs/part-sandbox.md).
 */
export function resolvePartParams(schema: ParamSchema | undefined, overrides: Record<string, ParamValue>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  if (schema) {
    for (const k of Object.keys(schema)) {
      if (!schema[k]) continue
      out[k] = ownCopy(resolvedParam(schema, overrides, k)!)
    }
  }
  for (const k of Object.keys(overrides)) {
    const ov = overrides[k]
    if (ov !== undefined && !(k in out)) out[k] = ownCopy(ov)
  }
  return out
}

/**
 * One param as {@link resolvePartParams} resolves it, uncopied: the instance's value, else the schema default (a
 * boolean that declares `whenAbsent` takes that instead), a malformed numberList reading as its default. For code that
 * needs one key on a hot path, and for the host's own reads of a part's size (the conveyor bed views), so the host sees
 * the same value the part's geometry() is handed. A key the schema doesn't declare reads the instance's value.
 */
export function resolvedParam(schema: ParamSchema | undefined, overrides: Readonly<Record<string, unknown>>, key: string): ParamValue | undefined {
  const spec = schema?.[key]
  const ov = overrides[key] as ParamValue | undefined
  if (!spec) return ov
  // (a key the saved part never carried is not a fresh part's default: see ParamSpec.whenAbsent)
  const resolved = ov === undefined ? (spec.type === 'boolean' && typeof spec.whenAbsent === 'boolean' ? spec.whenAbsent : spec.default) : ov
  return spec.type === 'numberList' ? coerceNumberList(resolved, spec.default) : resolved
}

/** a param value the receiver may mutate without touching the original: arrays and plain objects deep-copied */
function ownCopy(v: ParamValue): ParamValue {
  if (Array.isArray(v)) return (v as unknown[]).map((x) => ownCopy(x as ParamValue)) as unknown as ParamValue
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const key of Object.keys(v)) o[key] = ownCopy((v as Record<string, ParamValue>)[key]!)
    return o as unknown as ParamValue
  }
  return v
}
