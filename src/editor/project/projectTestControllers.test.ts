// A line of two controllers, both in the simulator, proved by a project test with no PLC at hand: the default
// controller runs line A's program instance, and Cell2 runs line B's on a task of its own, the same PROGRAM on memory
// of its own, reached through the parts' `Cell2::` tags (plc/controller.ts controllerRuns, sim/plcGroup.ts).

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { Controller } from '../../core/controller'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { sceneToProject } from '../../core/project/project'
import type { ScenePlc } from '../../core/scene/scenePlcs'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { runProjectTest } from './projectTestRunner'

const Jolt = await initJolt()

const rig = { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0.1, 0] }], joints: [], bounds: { length: 0.2, width: 0.2, top: 0.2, bottom: 0 } } as const
/** a button held down: it publishes TRUE on its tag every step */
const BUTTON: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.button',
  name: 't.button',
  params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  behavior: 'definePart({ step(ctx) { if (ctx.params.tag) ctx.writeTag(ctx.params.tag, true) } })',
  geometry: rig as never,
}
/** a lamp: lit while its command tag is TRUE, which it publishes on `lit` for the test to read */
const LAMP: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.lamp',
  name: 't.lamp',
  params: { cmd: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' }, lit: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  behavior: 'definePart({ step(ctx) { if (ctx.params.lit) ctx.writeTag(ctx.params.lit, ctx.params.cmd ? ctx.readTag(ctx.params.cmd) : false) } })',
  geometry: rig as never,
}

const PROGRAM = `PROGRAM Line
VAR_INPUT
  Press : BOOL;
END_VAR
VAR_OUTPUT
  Lamp : BOOL;
END_VAR
Lamp := Press;
END_PROGRAM
`
const TABLE: Controller = {
  tasks: [
    { name: 'T', intervalMs: 10, priority: 1 },
    { name: 'T2', intervalMs: 10, priority: 1, plc: 'Cell2' },
  ],
  programs: [
    { name: 'LineA', type: 'Line', task: 'T' },
    { name: 'LineB', type: 'Line', task: 'T2' },
  ],
}

const part = (id: string, packageId: string, x: number, params: Record<string, string>) =>
  ({ id, type: 'part', packageId, position: [x, 0, 0], rotationY: 0, params }) as unknown as PartInstance

function project(cell2: ScenePlc['runsOn']) {
  const scene: SceneJSON = {
    version: SCENE_VERSION,
    packages: [BUTTON, LAMP],
    plcs: [
      { name: 'PLC1', runsOn: 'app', protocol: 'serve', connect: true },
      { name: 'Cell2', runsOn: cell2, protocol: 'serve', connect: true },
    ],
    parts: [
      part('buttonA', 't.button', 0, { tag: 'LineA.Press' }),
      part('lampA', 't.lamp', 1, { cmd: 'LineA.Lamp', lit: 'LitA' }),
      part('buttonB', 't.button', 2, { tag: 'Cell2::LineB.Press' }),
      part('lampB', 't.lamp', 3, { cmd: 'Cell2::LineB.Lamp', lit: 'LitB' }),
    ],
  }
  return sceneToProject(scene, PROGRAM, 'Two controllers', 10, TABLE)
}

const spec = { duration: 0.5, checks: [{ tag: 'LitA', at: 0.4, equals: true }, { tag: 'LitB', at: 0.4, equals: true }, { tag: 'Cell2::LineB.Lamp', at: 0.4, equals: true }] }

describe('a project test of a line on two simulated controllers', () => {
  it("runs each controller's program instance on its own tags", () => {
    const out = runProjectTest(Jolt, project('app'), spec as never)
    expect(out.checks.map((c) => [(c.check as { tag: string }).tag, c.ok])).toEqual([
      ['LitA', true],
      ['LitB', true],
      ['Cell2::LineB.Lamp', true],
    ])
  })

  it('leaves a controller on a PLC outside the app to that PLC, so its line stays dark in a test', () => {
    const out = runProjectTest(Jolt, project('plc'), spec as never)
    expect(out.checks.map((c) => [(c.check as { tag: string }).tag, c.ok])).toEqual([
      ['LitA', true],
      ['LitB', false],
      ['Cell2::LineB.Lamp', false],
    ])
  })
})
