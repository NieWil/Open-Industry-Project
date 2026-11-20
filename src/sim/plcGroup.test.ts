import { describe, expect, it } from 'vitest'
import { PlcGroup } from './plcGroup'
import type { PlcWorldPort } from './plcHost'

const LINE = `VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
Run := NOT Eye;
`

/** A world whose parts wrote `writes` on their last step, keeping what the PLCs hand back. */
function world(writes: Record<string, number | boolean>) {
  const got: { tags: Record<string, number | boolean> | null } = { tags: null }
  const port: PlcWorldPort = {
    behaviorTagWrites: () => writes,
    setBehaviorInputTags: (tags) => {
      got.tags = tags
    },
    stepCount: 1,
  }
  return { port, got }
}

describe('controllers the simulator runs side by side', () => {
  it('hands each its own tags without the name, and its outputs back with it, as one table', () => {
    const group = new PlcGroup([
      { controller: null, source: LINE, periodSec: 0.01 },
      { controller: 'Cell2', source: LINE, periodSec: 0.01 },
    ])
    const { port, got } = world({ Eye: true, 'Cell2::Eye': false })
    group.interleave(port, 0.02)
    expect(got.tags).toEqual({ Run: false, 'Cell2::Run': true })
    const shot = group.snapshot()
    expect(shot.outputs).toMatchObject({ Run: false, 'Cell2::Run': true })
    expect(shot.scanTimes.map((t) => t.task)).toEqual(['', 'Cell2::Main'])
  })

  it('is one PlcHost when the default controller runs alone', () => {
    const group = new PlcGroup([{ controller: null, source: LINE, periodSec: 0.01 }])
    const { port, got } = world({ Eye: false, 'Cell2::Eye': true })
    group.interleave(port, 0.02)
    expect(got.tags).toEqual({ Run: true })
  })

  it("sends a force to the controller that runs the instance it names, and says whose a fault is", () => {
    const group = new PlcGroup([
      { controller: null, source: LINE, periodSec: 0.01 },
      { controller: 'Cell2', source: `PROGRAM Line\nVAR_OUTPUT\n  Run : BOOL;\nEND_VAR\nEND_PROGRAM\nCONFIGURATION C\n  RESOURCE R ON PLC\n    TASK T(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM LineB WITH T : Line;\n  END_RESOURCE\nEND_CONFIGURATION\n`, instances: ['LineB'] },
    ])
    group.setForces({ 'LineB.Run': true, Run: true })
    const { port, got } = world({})
    group.interleave(port, 0.02)
    expect(got.tags).toMatchObject({ Run: true, 'Cell2::LineB.Run': true })
    expect(() => new PlcGroup([{ controller: null, source: LINE }, { controller: 'Cell2', source: 'Run := ;' }])).toThrow(/^Cell2: /)
  })

  // a PLC outside the app runs the default controller, so the group holds only the others
  it('with no default controller here, reads and drives only the named controllers\' own tags', () => {
    const one = new PlcGroup([{ controller: 'Cell2', source: LINE, periodSec: 0.01 }])
    const a = world({ Eye: true, 'Cell2::Eye': false })
    one.interleave(a.port, 0.02)
    expect(a.got.tags).toEqual({ 'Cell2::Run': true })
    expect(one.snapshot().outputs).toEqual({ 'Cell2::Run': true })

    const two = new PlcGroup([
      { controller: 'Cell2', source: LINE, periodSec: 0.01 },
      { controller: 'Cell3', source: LINE, periodSec: 0.01 },
    ])
    const b = world({ Eye: false, 'Cell2::Eye': true, 'Cell3::Eye': false })
    two.interleave(b.port, 0.02)
    expect(b.got.tags).toEqual({ 'Cell2::Run': false, 'Cell3::Run': true })
    const shot = two.snapshot()
    expect(shot.outputs).toEqual({ 'Cell2::Run': false, 'Cell3::Run': true })
    expect(shot.inputs).toMatchObject({ 'Cell2::Eye': true, 'Cell3::Eye': false })
  })
})
