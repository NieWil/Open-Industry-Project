/// <reference types="vite/client" />
// The built-in conveyors and sensors written as reactive parts (definePart's `react`), each through the real world.
// A reactive part may be called on any step, so each must run the same when it is called on every step: that is what
// it did as a `step` part. The conveyors are commanded through a start, a stop, a restart and a change of speed, so
// the run crosses every reason a drive has to ask for its next tick (conveyorDrive.js driveAgain).
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest, PartMaterial, PartPackageGeometry } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<string, { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[]; conveyor?: PackageManifest['conveyor'] }>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

function register(folder: string): string {
  const m = RIGS[`../../examples/parts/${folder}/rig.json`]!
  const behavior = BEHAVIORS[`../../examples/parts/${folder}/behavior.ts`]!.replace(/\r\n/g, '\n')
  expect(behavior, `${folder} is a reactive part`).toMatch(/\n {2}react\((ctx)?\) \{/)
  registerPackage(buildPackage({ id: m.id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...(m.conveyor ? { conveyor: m.conveyor } : {}) }, behavior))
  return m.id
}

interface Run {
  /** the tags the part wrote, step by step, and where the box ended */
  trace: string
  calls: number
}

/** One part and one box, stepped through `script` (step -> the tags a program hands it from then on). */
function run(folder: string, params: Record<string, unknown>, driven: string[], script: Record<number, Record<string, number | boolean>>, steps: number, box: [number, number, number], wakeAllParts: boolean): Run {
  clearPackages()
  const id = register(folder)
  const part = { id: 'p', type: 'part', packageId: id, position: [0, 1, 0], rotationY: 0, params }
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [part] } as unknown as SceneJSON, { wakeAllParts })
  w.setBehaviorDrivenTags(driven)
  w.spawnBoxAt(box[0], box[1], box[2], 0.2, 0.15, 0.2, 0, 5, [1, 0, 0])
  const lines: string[] = []
  let calls = 0
  const called = (w as unknown as { called: unknown[] }).called
  for (let i = 0; i < steps; i++) {
    if (script[i]) w.setBehaviorInputTags(script[i]!)
    w.step()
    calls += called.length
    lines.push(JSON.stringify(w.behaviorTagWrites()))
  }
  const f = w.frame()
  lines.push(JSON.stringify([f.count, f.positions[0], f.positions[1], f.positions[2], f.conveyorSpeeds]))
  w.dispose()
  return { trace: lines.join('\n'), calls }
}

const STEPS = 600
// stopped, started, stopped mid-run, restarted, then commanded faster and slower
const DRIVE_SCRIPT: Record<number, Record<string, number | boolean>> = {
  0: { Run: false, Speed: 0.5 },
  40: { Run: true, Speed: 0.5 },
  200: { Run: false, Speed: 0.5 },
  230: { Run: true, Speed: 0.5 },
  330: { Run: true, Speed: 1.2 },
  450: { Run: true, Speed: 0.3 },
}
const DRIVE = { fpmUnits: false, runTag: 'Run', speedTag: 'Speed', runningTag: 'Running', velocityTag: 'Vel', accelTime: 0.6, decelTime: 0.4 }

describe('built-in reactive parts run the same called on every step', () => {
  for (const folder of ['belt-conveyor', 'roller-conveyor', 'spur-conveyor', 'spur-roller-conveyor', 'curved-conveyor', 'curved-roller']) {
    const box: [number, number, number] = folder.startsWith('curved') ? [1.5, 1.3, 0] : [-0.5, 1.3, 0]
    it(`${folder}: ramps, stops and speed changes`, () => {
      const quiet = run(folder, DRIVE, ['Run', 'Speed'], DRIVE_SCRIPT, STEPS, box, false)
      const woken = run(folder, DRIVE, ['Run', 'Speed'], DRIVE_SCRIPT, STEPS, box, true)
      expect(quiet.trace).toBe(woken.trace)
      expect(woken.calls).toBe(STEPS)
      // it waited while stopped and while at its commanded speed, and ran while it ramped
      expect(quiet.calls).toBeGreaterThan(20)
      expect(quiet.calls).toBeLessThan(STEPS / 2)
      expect(quiet.trace).toContain('"Running":true')
    })
    it(`${folder}: with an encoder and a pulse to count`, () => {
      const params = { ...DRIVE, encoderTag: 'Enc', pulseTag: 'Pulse' }
      const quiet = run(folder, params, ['Run', 'Speed'], DRIVE_SCRIPT, STEPS, box, false)
      const woken = run(folder, params, ['Run', 'Speed'], DRIVE_SCRIPT, STEPS, box, true)
      expect(quiet.trace).toBe(woken.trace)
      // counting travel needs every tick the surface moves, so it waited only while stopped
      expect(quiet.calls).toBeGreaterThan(STEPS / 2)
      expect(quiet.calls).toBeLessThan(STEPS)
    })
  }

  it('a conveyor on its authored speed, with no program, is called once', () => {
    const quiet = run('belt-conveyor', { fpmUnits: false, speed: 0.8 }, [], {}, 300, [-0.5, 1.3, 0], false)
    const woken = run('belt-conveyor', { fpmUnits: false, speed: 0.8 }, [], {}, 300, [-0.5, 1.3, 0], true)
    expect(quiet.trace).toBe(woken.trace)
    expect(quiet.calls).toBe(1)
  })

  // scenery and cargo have nothing to do: an empty script, called once and then left alone
  for (const folder of ['fence', 'bollards', 'guardRail', 'platform', 'rack', 'stairs', 'floor-marking', 'shape']) {
    it(`${folder}: is called once`, () => {
      const quiet = run(folder, {}, [], {}, 60, [8, 3, 8], false)
      const woken = run(folder, {}, [], {}, 60, [8, 3, 8], true)
      expect(quiet.trace).toBe(woken.trace)
      // (the host runs no script at all for a part with no bodies to drive: never called, either way)
      expect([0, 60]).toContain(woken.calls)
      expect(quiet.calls).toBe(Math.min(1, woken.calls))
    })
  }

  for (const [folder, params] of [
    ['color-sensor', { colorTag: 'Seen', maxRange: 2 }],
    ['laser-sensor', { distanceTag: 'Seen', maxRange: 2 }],
  ] as const) {
    it(`${folder}: a box falling through its beam`, () => {
      // the lens looks along +Z from the part; the box drops through the beam a metre out
      const quiet = run(folder, params, [], {}, 240, [0, 2.2, 1], false)
      const woken = run(folder, params, [], {}, 240, [0, 2.2, 1], true)
      expect(quiet.trace).toBe(woken.trace)
      expect(quiet.calls).toBeLessThan(woken.calls)
      expect(new Set(quiet.trace.split('\n').slice(0, -1)).size).toBeGreaterThan(1) // it saw the box come and go
    })
  }
})
