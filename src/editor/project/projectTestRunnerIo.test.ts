import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { unregisterPackage } from '../../core/parts/partRegistry'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import type { TestSpec } from '../../core/project/projectTest'
import { SCENE_VERSION } from '../../core/types'
import type { SdkPart } from '../../core/types'
import { buildPackage } from '../../sim/buildPackage'
import { runProjectTest } from './projectTestRunner'

// Two of our I/O binding rules, held end to end through the headless runner (a real SimWorld, a real program, the tag
// bus between them), which keeps Play's rules (sim/plcHost.ts, plc/link/plcLink.ts):
//   - the first scan follows the parts' first step, so it reads what they published, never all-FALSE inputs;
//   - a program wholly inside one PROGRAM answers to its variables' bare names as well as `Line.Var`.

const Jolt = await initJolt()

const RIG = {
  kind: 'rig' as const,
  links: [
    { name: 'base', shape: { kind: 'frame' as const }, offset: [0, 0, 0] as [number, number, number] },
    { name: 'arm', parent: 'base', shape: { kind: 'box' as const, size: [0.1, 0.1, 0.1] as [number, number, number] }, offset: [0, 0.2, 0] as [number, number, number] },
  ],
  joints: [{ name: 'j1', link: 'arm', type: 'revolute' as const, axis: [0, 1, 0] as [number, number, number], min: -1, max: 1 }],
}

// a normally-closed contact at rest: publishes TRUE on every step, from its first
const CLOSED = `
definePart({
  joints: ['j1'],
  params: { tag: { type: 'string', default: 'EStopOK' } },
  step(ctx) { ctx.writeTag(ctx.params.tag, true) },
})
`

// reads one tag, writes it straight back out
const ECHO = `
definePart({
  joints: ['j1'],
  params: { inTag: { type: 'string', default: 'Cmd' }, outTag: { type: 'string', default: 'Echoed' } },
  step(ctx) { ctx.writeTag(ctx.params.outTag, ctx.readTag(ctx.params.inTag)) },
})
`

function part(id: string, packageId: string, params: Record<string, unknown>): SdkPart {
  return { id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params } as SdkPart
}

function project(stProgram: string, parts: SdkPart[]): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'IO rules',
    packages: [buildPackage({ id: 'test.closed', name: 'Closed', geometry: RIG }, CLOSED), buildPackage({ id: 'test.echo', name: 'Echo', geometry: RIG }, ECHO)],
    scene: { version: SCENE_VERSION, parts },
    stProgram,
  }
}

afterEach(() => {
  unregisterPackage('test.closed')
  unregisterPackage('test.echo')
})

describe('the first scan', () => {
  // a trip that latches on the first FALSE it reads, and never clears
  const ESTOP = 'VAR_INPUT EStopOK : BOOL; END_VAR\nVAR_OUTPUT Tripped : BOOL; END_VAR\nIF NOT EStopOK THEN Tripped := TRUE; END_IF;\n'

  it('reads a normally-closed input TRUE: the E-stop does not latch at t=0', () => {
    const spec: TestSpec = { duration: 0.5, checks: [{ always: true, tag: 'Tripped', equals: false }] }
    // at the scene's own step and with a scan faster than it, where scan 1 could otherwise run before any part has stepped
    for (const scanMs of [undefined, 1]) {
      const result = runProjectTest(Jolt, project(ESTOP, [part('stop', 'test.closed', { tag: 'EStopOK' })]), { ...spec, ...(scanMs !== undefined ? { scanMs } : {}) })
      expect(result.checks[0]!.ok, JSON.stringify(result.checks[0])).toBe(true)
    }
  })
})

describe('a program wholly inside one PROGRAM', () => {
  const LINE = 'PROGRAM Line\nVAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Cmd : BOOL; END_VAR\nCmd := Start;\nEND_PROGRAM\n'

  it('drives a part wired to the bare name, and still one wired to Line.Cmd', () => {
    const parts = [
      part('bare', 'test.echo', { inTag: 'Cmd', outTag: 'EchoBare' }),
      part('qualified', 'test.echo', { inTag: 'Line.Cmd', outTag: 'EchoQualified' }),
      part('start', 'test.closed', { tag: 'Start' }), // the bare input, published by a part
    ]
    const spec: TestSpec = {
      duration: 0.5,
      checks: [
        { eventually: true, within: 0.5, tag: 'EchoBare', equals: true },
        { eventually: true, within: 0.5, tag: 'EchoQualified', equals: true },
        // a check reads the program by either spelling too
        { eventually: true, within: 0.5, tag: 'Cmd', equals: true },
        { eventually: true, within: 0.5, tag: 'Line.Cmd', equals: true },
      ],
    }
    const result = runProjectTest(Jolt, project(LINE, parts), spec)
    expect(result.checks.map((c) => [(c.check as { tag: string }).tag, c.ok])).toEqual([
      ['EchoBare', true],
      ['EchoQualified', true],
      ['Cmd', true],
      ['Line.Cmd', true],
    ])
  })

  it('takes a test input by the bare name', () => {
    const spec: TestSpec = {
      duration: 1,
      inputs: [{ at: 0.5, tag: 'Start', value: true }],
      checks: [
        { at: 0.25, tag: 'EchoBare', equals: false },
        { eventually: true, within: 1, tag: 'EchoBare', equals: true },
      ],
    }
    const result = runProjectTest(Jolt, project(LINE, [part('bare', 'test.echo', { inTag: 'Cmd', outTag: 'EchoBare' })]), spec)
    expect(result.checks.map((c) => c.ok)).toEqual([true, true])
  })
})
