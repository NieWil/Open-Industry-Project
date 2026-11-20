// Running a project's own tests in the browser: the in-app half of `npm run test-project`.
//
// The runner itself (projectTestRunner.ts) is portable: core + sim/world + plc, no Node. This module
// lets the app reach it. It is separate from the command because the jolt import must stay dynamic.
// A wasm module in the eager bundle would use up the build's eager-JS budget (scripts/optimize-assets.mjs)
// on a feature most sessions never invoke, so it loads only when someone actually runs the tests.
//
// `jolt-physics/wasm` matches sim/worker.ts's single-thread default, so a test run
// re-uses the .wasm the browser already fetched for the sim instead of pulling the base64-embedded
// 'wasm-compat' build in alongside it.

import type { ProjectJSON } from '../../core/project/project'
import type { CargoSnapshot } from '../../core/project/projectProbe'
import type { TagTrace, TestResult } from '../../core/project/projectTest'
import type { SimWorld } from '../../sim/world'
import type { TestFactsView } from './testFacts'

/** Mirrors projectTestRunner's local alias - the initialized module `new SimWorld` takes. */
type JoltModule = ConstructorParameters<typeof SimWorld>[0]

/** One spec's outcome: its verdict, or the reason it could not run at all. */
export interface ProjectTestRun {
  name: string
  ok: boolean
  result?: TestResult
  /** the run's flow facts (core/flow/flowFacts.ts), counted by kind, and for a failing test the ones before its first
   *  failure: what `npm run test-project` prints. Absent when the run threw */
  facts?: TestFactsView
  /** set when the run threw rather than failed - a dangling scene id, a program that won't compile */
  error?: string
  /** the tags `opts.trace` asked for, through the whole run: the value at the start and every change */
  trace?: TagTrace[]
  /** the live cargo at each time `opts.cargo` asked for */
  cargo?: CargoSnapshot[]
  /** the asked-for times the run ended before */
  cargoMissed?: number[]
}

/** The display name of the spec at `index`, matching what the CLI prints for a document-carried test. */
export function testName(spec: { name?: string }, index: number): string {
  return spec.name ?? `test-${index + 1}`
}

/**
 * Run every test the project carries, oldest-first, reporting each verdict as it finishes.
 *
 * Each spec steps a fresh SimWorld synchronously. That is deterministic, but it blocks: a 30 s spec is
 * ~1800 fixed steps on the main thread. Specs are separated by a macrotask so the browser can paint
 * the previous verdict, but within one spec the UI is frozen for its duration. Moving the loop into
 * the sim worker is the fix if that becomes a problem; until then it is not worth the plumbing.
 */
export async function runProjectTests(
  project: ProjectJSON,
  onVerdict?: (run: ProjectTestRun, done: number, total: number) => void,
  opts?: { trace?: readonly string[]; cargo?: readonly number[] },
): Promise<ProjectTestRun[]> {
  const specs = project.tests ?? []
  if (specs.length === 0) return []

  const [joltMod, runnerMod, factsMod, testMod, probeMod] = await Promise.all([
    import('jolt-physics/wasm'),
    import('./projectTestRunner'),
    import('./testFacts'),
    import('../../core/project/projectTest'),
    import('../../core/project/projectProbe'),
  ])
  const Jolt = (await joltMod.default()) as unknown as JoltModule

  const runs: ProjectTestRun[] = []
  for (const [i, spec] of specs.entries()) {
    // yield first, so the overlay paints "running" (and each finished row) before the next spec
    // blocks the thread
    await new Promise((resolve) => setTimeout(resolve, 0))
    let run: ProjectTestRun
    try {
      const trace = opts?.trace ? new testMod.TraceRecorder(opts.trace) : undefined
      const snaps = opts?.cargo ? new probeMod.CargoSnapshots(opts.cargo) : undefined
      const { facts, factsOverflow, ...result } = runnerMod.runProjectTest(Jolt, project, spec, { ...(trace ? { trace } : {}), ...(snaps ? { onFrame: snaps.onFrame } : {}) })
      run = {
        name: testName(spec, i),
        ok: result.ok,
        result,
        facts: factsMod.testFactsView(result.checks, facts, factsOverflow, spec.duration),
        ...(trace ? { trace: trace.result() } : {}),
        ...(snaps ? { cargo: snaps.snapshots, cargoMissed: snaps.missed() } : {}),
      }
    } catch (e) {
      run = { name: testName(spec, i), ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    runs.push(run)
    onVerdict?.(run, runs.length, specs.length)
  }
  return runs
}
