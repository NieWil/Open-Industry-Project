import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { TestSpec } from '../../core/project/projectTest'
import { authoredCaseCount, DEMO_SCAN_MS, demoProject } from './demoAcceptance'
import { DEMO_REFERENCE_PROGRAM, ST_REFERENCE_CONTROLLER } from './demoReference'
import { createPlcDemoScene } from './demoScenes'
import { runProjectTest } from '../project/projectTestRunner'

// The demo cell run headless (demoAcceptance.ts). The acceptance ladder runs at each step rate in
// demoScenesSim.<rate>hz.test.ts; this file holds the cases that prove the ladder can fail, and the shipped program
// against its all-ST twin through the cell's own run.

const Jolt = await initJolt()

describe('demo cell - headless acceptance run', () => {
  // The ladder (demoScenesSim.<rate>hz.test.ts) is only useful if it can fail, so stage a real stoppage: hold the
  // safety gate open. That is also a useful assertion on its own: the gate is a live interlock, and "the guard no longer
  // stops the cell" is the one regression here with a real-world safety consequence. The row rung must
  // break while the floor invariant still holds, which proves these checks read the world instead of
  // passing vacuously.
  //
  // Note the stimulus is Stop/Guard, not Start: measured, the demo program latches
  // `running` on its first scan whenever Stop is closed, so a Start press changes nothing about the
  // run (sensible for a showcase that should be alive the moment the page loads). A negative case
  // built on withholding Start would therefore pass and prove nothing.
  it('goes red when the safety gate is held open, and says which rung broke', () => {
    const scene = createPlcDemoScene()
    const authoredCases = authoredCaseCount(scene)
    const spec: TestSpec = {
      duration: 35,
      scanMs: DEMO_SCAN_MS,
      inputs: [
        { at: 0, tag: 'Stop', value: true },
        { at: 0, tag: 'Guard', value: false }, // gate open the whole run
      ],
      checks: [
        { probe: { count: { kind: 'box' } }, eventually: true, within: 30, min: authoredCases + 6 },
        { tag: 'RowReady', eventually: true, within: 30, equals: true },
        { probe: { count: { zone: { min: [-100, -5, -100], max: [100, -0.25, 100] } } }, always: true, equals: 0 },
      ],
    }

    const result = runProjectTest(Jolt, demoProject(scene), spec)
    expect(result.ok).toBe(false)
    expect(result.checks[1]!.ok).toBe(false) // the interlock held: no row ever forms
    expect(result.checks[1]!.detail).toContain('RowReady never reached')
    expect(result.checks[2]!.ok).toBe(true) // ...and the floor invariant still holds: not a vacuous red
  }, 120000)

  // The demo ships Palletizer in ladder, calling PalletTruck in Structured Text. Its twin is the demo all in
  // Structured Text (demoReference.ts). Here the twin runs alongside the shipped program through the cell's own
  // run, fed what the scene feeds it on the same clock, and must agree on every variable the two share (state, trucks,
  // timers, outputs). The comparison is per physics step, which at the demo's 10 ms scan is one or two scans: a
  // difference in what the cell is told is what this is for, and that is what a step boundary shows.
  // demoScenes.test.ts compares after every scan, on inputs at random, which also reaches corners this run does not.
  it('runs the same as the demo all in Structured Text, in lockstep through the cell run, every variable', () => {
    const scene = createPlcDemoScene()
    let scans = 0
    let shared: string[] | null = null
    const mismatches: string[] = []
    const seen = { arm: new Set<unknown>(), out: new Set<unknown>(), truck: new Set<unknown>() }
    let pallets = 0
    const spec: TestSpec = {
      duration: 150,
      scanMs: DEMO_SCAN_MS,
      inputs: [
        { at: 0, tag: 'Stop', value: true },
        { at: 0, tag: 'Guard', value: true },
        { at: 0.5, tag: 'Start', value: true },
        { at: 1.0, tag: 'Start', value: false },
      ],
      checks: [{ probe: { count: { zone: { min: [-100, -5, -100], max: [100, -0.25, 100] } } }, always: true, equals: 0 }],
    }
    const result = runProjectTest(Jolt, demoProject(scene), spec, {
      lockstep: {
        stProgram: DEMO_REFERENCE_PROGRAM,
        controller: ST_REFERENCE_CONTROLLER,
        compare: (time, shipped, st) => {
          scans++
          shared ??= Object.keys(shipped).filter((k) => k in st)
          for (const k of shared) if (shipped[k] !== st[k] && mismatches.length < 10) mismatches.push(`t=${time.toFixed(2)} ${k}: shipped ${String(shipped[k])}, all-ST ${String(st[k])}`)
          seen.arm.add(shipped['Main.Step'])
          seen.out.add(shipped['Main.OutStep'])
          seen.truck.add(shipped['Main.Truck.Step'])
          pallets = Number(shipped['Pallets'])
        },
      },
    })
    expect(mismatches).toEqual([])
    expect(result.ok).toBe(true)
    expect(scans).toBeGreaterThan(1400)
    expect(shared!.length).toBeGreaterThan(90)
    // ...on a run that went right through the cycle: every arm step, the outfeed's, and a truck's whole trip out to the
    // lane and back. Held as "at least these" because a state the cell passes through inside one physics step is not
    // sampled here: at the demo's 10 ms scan a step runs one or two scans, and the outfeed's 100 and 140 and the
    // trucks' 5 go by in one. So can the outfeed's 120: it waits on TurnDone, which the turntable last wrote before
    // it read the new angle, so a scan that runs ahead of the next step reads the stale true and goes straight on
    // (the turntable holds its load and conveys only once settled, so nothing moves early). Measured with the wrap
    // station in, the one lane-B index inside this run does exactly that. demoScenes.test.ts, which compares after
    // every scan, covers all three machines entirely.
    expect([...seen.arm]).toEqual(expect.arrayContaining([0, 10, 20]))
    expect([...seen.out]).toEqual(expect.arrayContaining([0, 105, 106, 107, 110, 115, 130]))
    expect([...seen.truck]).toEqual(expect.arrayContaining([0, 6, 12, 14, 16, 20, 22, 24, 25, 30, 32, 40]))
    // the pallet count the demo's second note reads: the finished load the scene opens with, and loads the arm built
    // after it (this run sends out 3), so the count keeps moving past the opening minute
    expect(pallets).toBeGreaterThanOrEqual(2)
  }, 240000)
})
