import { buildAuthoredCargoFrame, CARGO_KIND_BOX } from '../../core/frame'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import type { TestCheck, TestSpec } from '../../core/project/projectTest'
import { DEFAULT_SIM_HZ } from '../../core/types'
import type { PartInstance, SceneJSON, SimRate } from '../../core/types'
import { CELL, DEMO_CONTROLLER, DEMO_PROGRAM } from './demoScenes'

// The demo cell as an acceptance test: the palletizing line run headless for 90 simulated seconds,
// asserting that product actually moves through it. demoScenes.test.ts checks the scene's structure
// (geometry, wiring, what the program compiles to); the demoScenesSim specs check that it works when stepped.
//
// Nothing else measures motion: a Jolt bump, a friction re-tune, or a conveyor-surface change can leave
// every tag correct and every gate green while cases stop feeding, rows stop forming, or the load never
// leaves. The checks below are a ladder (feed → transport → row → layer → putaway), so a failure names
// how far down the line the regression is.
//
// The ladder runs at a spread of the physics step rates a project may choose (whole Hz, 60 to 1000), weighted
// toward the low end, where this cell breaks (low rates can sink a loaded pallet into its deck: docs/sim-clock.md).
// Every choosable rate must run the same cell, program and thresholds; only the I/O latency and the sampling
// resolution change. So a rate that cannot pass this ladder must not be choosable. Each rate is its own spec file,
// demoScenesSim.<rate>hz.test.ts, because vitest runs files in parallel and the tests in one file one after another:
// in one file the four runs were most of the unit suite's wall time.
//
// No JSON is authored here: the scene is built by code, part ids are resolved by package, and the
// zones come from the demo's own exported constants, so a layout re-tune moves the test with it.
//
// **The scan period matters**, and the demo sets it: its controller table runs MainTask every 10 ms
// (demoScenes.DEMO_CONTROLLER, the store's default scan). The runner scans on a stored table's own interval,
// so `scanMs` in the specs has no effect here; it is what a program with no table would get.
// Scanning every 16.7 ms sim step instead breaks the cell's edge-triggered handshakes (the AGVs never move and
// no layer completes), which reads like a physics bug and is not one.

/** what a spec asks for when a program has no table of its own; the demo's table (10 ms) overrides it */
export const DEMO_SCAN_MS = 100
const DURATION = 90
// The rates, one spec file each: the floor (MIN_SIM_HZ, 60), just above it (75), a rate that divides nothing evenly
// (144), and a fast one (500).
/**
 * The ladder's limit, set by its slowest rate: the run is 90 sim-s whatever the rate, so 500 Hz does ~8x the steps
 * of the floor. Measured under the unit project's lockdown: 60 Hz 14.5 s, 75 Hz 15.2 s, 144 Hz 29.0 s,
 * 500 Hz 84.5 s on a quiet machine, and past 120 s on a loaded one, so a 120 s limit fails this test. The limit is a
 * hang guard, not a speed check (this test asserts what the cell does), so it carries ~3.5x headroom over the quiet
 * time.
 */
export const LADDER_TIMEOUT_MS = 300_000

const pkgId = (p: PartInstance): string | undefined => (p as { packageId?: string }).packageId

export function demoProject(scene: SceneJSON, simHz: SimRate = DEFAULT_SIM_HZ): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'Demo acceptance',
    // the demo embeds every package it places in scene.packages, so it is self-contained
    packages: [],
    scene,
    stProgram: DEMO_PROGRAM,
    controller: DEMO_CONTROLLER,
    simHz,
  }
}

/** Cases the scene starts with, filed ones and the ones a unit load stacks itself: the rows the stopped view draws. */
export function authoredCaseCount(scene: SceneJSON): number {
  return buildAuthoredCargoFrame(scene.parts).kinds.filter((k) => k === CARGO_KIND_BOX).length
}

/** The rack-line fork truck - the one that puts finished loads away (the furthest out in +x). */
function putawayAgvId(scene: SceneJSON): string {
  const agvs = scene.parts.filter((p) => pkgId(p) === 'oip.agv')
  if (agvs.length === 0) throw new Error('the demo scene has no oip.agv')
  return agvs.reduce((a, b) => (b.position[0] > a.position[0] ? b : a)).id
}

/** The acceptance ladder for `scene`: feeds, forms, palletizes and puts away, and never drops a case through the floor. */
export function ladderSpec(scene: SceneJSON): TestSpec {
  // Cases, not all cargo: pallets come and go on their own account (the dispenser takes a truck's stack of
  // empties in, so eight real pallets leave the world at once), and this rung is about the case line
  const authoredCases = authoredCaseCount(scene)
  const agv = putawayAgvId(scene)

  // Thresholds sit well below what was measured (noted per check), because Jolt is
  // deterministic for a given binary but these are long causal chains, so a tight bound would add
  // nothing and flake. Tighten only if a regression ever slips under one.
  const checks: TestCheck[] = [
    // 1. Feed: the spawner runs and cases enter the world. (measured: +5 by t=20, +8 by t=30; the
    //    line forms one row at a time and holds a finished layer until the arm takes it)
    { probe: { count: { kind: 'box' } }, eventually: true, within: 30, min: authoredCases + 6 },

    // 2. Transport: cases actually reach the row-forming lane, not just the infeed.
    //    (measured: 5-6 in this zone by t=30)
    {
      probe: {
        count: {
          zone: { min: [CELL.loadX - 1.5, CELL.surface - 0.5, -3], max: [CELL.loadX + 1.5, CELL.surface + 1.5, 3] },
        },
      },
      eventually: true,
      within: 45,
      min: 2,
    },

    // 3. Row: the plow + blade stop accumulate a full row. (measured: true by t=30)
    { tag: 'RowReady', eventually: true, within: 45, equals: true },

    // 4. Layer: both rows shift across and a layer is ready for the robot. (measured: true by t=60)
    { tag: 'LayerReady', eventually: true, within: 85, equals: true },

    // 5. Putaway: the fork truck takes a finished load down the rack line.
    //    (measured: x 22.12 -> 7.60 by t=60, a 14.8 m run)
    { probe: { pose: { part: agv, axis: 'x' } }, eventually: true, within: 85, max: 15 },

    // 6. Invariant: nothing ever falls through the floor. Layout-independent, and the single
    //    cheapest guard against a collision/friction regression. (measured: min y stays ~0.07)
    { probe: { count: { zone: { min: [-100, -5, -100], max: [100, -0.25, 100] } } }, always: true, equals: 0 },

    // 7. Guarding: the cell's own product never trips a light curtain: each curtain's own output drops as a load
    //    breaks its beams, and the program's muting (MutingSeq, reading each opening's two photo-eyes) holds the
    //    opening clear for it. A trip drops `running`, so this also reads as a stalled ladder, but it names the
    //    opening. And each is muted in the run, or the check above could pass on a curtain nothing reached.
    ...['Main.caseClear', 'Main.feedClear', 'Main.outClear'].map((tag): TestCheck => ({ tag, always: true, equals: true })),
    ...['CaseMuted', 'FeedMuted', 'OutMuted'].map((tag): TestCheck => ({ tag, eventually: true, within: DURATION, equals: true })),
  ]

  return {
    name: 'demo cell acceptance',
    duration: DURATION,
    scanMs: DEMO_SCAN_MS,
    inputs: [
      // Stop + Guard are the actual enable: the program latches `running` on its first scan while
      // Stop is closed, so the Start press below is the operator's action, not what starts the
      // line (see the safety-gate case for why that distinction matters when picking a stimulus).
      { at: 0, tag: 'Stop', value: true }, // normally-closed: true = not stopped
      { at: 0, tag: 'Guard', value: true }, // safety gate closed
      { at: 0.5, tag: 'Start', value: true }, // momentary press...
      { at: 1.0, tag: 'Start', value: false }, // ...and release
    ],
    checks,
  }
}
