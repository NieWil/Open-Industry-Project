import { describe, expect, it } from 'vitest'
import { compile, setScanEngine } from './interpreter'
import { compareEngines } from './scanEngineOracle'
import { exportProgram } from './exchange/export'
import { MOTION_ERROR } from './motionPrelude'
import { AXIS_STATE_CODE, HOME_SCANS } from './motionChannel'
import { axisHalt, axisMoveAbsolute, axisMoveVelocity, axisPower, createAxis, stepAxis, type Axis, type AxisConfig } from '../core/motionAxis'

// The PLCopen motion blocks (plc/motionPrelude.ts over plc/motionChannel.ts), on both engines, against this engine's
// documented rules (docs/motion-control.md). The profile itself is the kernel's, which core/motionAxis.profile.test.ts
// holds to closed-form kinematics; here the questions are the blocks' own: the Busy / Done / Active / CommandAborted /
// Error handshake and when each output changes, the error ids, the axis's State, the scan timing, and that every
// AXIS_REF setting (limits, limit deceleration) reaches the kernel.
//
// Scan timing (docs/motion-control.md): MC_Power powers the axis in the scan Enable is TRUE and Status reads it that
// scan. The first scan has no time before it, so a move commanded in scan 0 shows its first motion in scan 1 and scan
// k shows the profile k*DT in; a command in a later scan N shows its first motion in scan N itself.

const DT = 0.004
const S = AXIS_STATE_CODE
const ENGINES = ['walker', 'typed'] as const

type Mem = Record<string, unknown>

/** A program over one axis AX, powered first every scan; `cyc` counts scans from 0. */
function program(decls: string[], calls: string, setup = '', enable = 'TRUE'): string {
  return `VAR
  AX : AXIS_REF;
  pwr : MC_Power;
  ${decls.map((d) => `${d};`).join('\n  ')}
  cyc : INT;
END_VAR
${setup}
pwr(Axis := AX, Enable := ${enable});
${calls}
cyc := cyc + 1;`
}

/** Every scan's memory, on one engine. */
function run(src: string, scans: number, engine: (typeof ENGINES)[number]): Mem[] {
  const was = setScanEngine(engine)
  try {
    const p = compile(src)
    const out: Mem[] = []
    for (let k = 0; k < scans; k++) {
      p.scan(DT)
      out.push({ ...(p.deepMemory as Mem) })
    }
    return out
  } finally {
    setScanEngine(was)
  }
}

/** The same commands on a bare kernel, on the channel's timing: scan k's commands, then (from scan 1) one step. */
function kernel(scans: number, cfg: Partial<AxisConfig>, at: (k: number, ax: Axis) => void): Array<{ x: number; v: number }> {
  const ax = createAxis({ min: -Infinity, max: Infinity, maxVelocity: Infinity, maxAccel: Infinity, homingTicks: HOME_SCANS, ...cfg })
  const out: Array<{ x: number; v: number }> = []
  for (let k = 0; k < scans; k++) {
    if (k === 0) axisPower(ax, true)
    at(k, ax)
    if (k > 0) stepAxis(ax, DT)
    out.push({ x: ax.x, v: ax.v })
  }
  return out
}

function sameMotion(m: Mem[], ref: Array<{ x: number; v: number }>, what: string): void {
  for (let k = 0; k < m.length; k++) {
    const at = `${what}, scan ${k}: kernel x=${ref[k]!.x} v=${ref[k]!.v}, blocks x=${m[k]!['AX.SetPosition']} v=${m[k]!['AX.SetVelocity']}`
    expect(Math.abs((m[k]!['AX.SetPosition'] as number) - ref[k]!.x), at).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(ref[k]!.x)))
    expect(Math.abs((m[k]!['AX.SetVelocity'] as number) - ref[k]!.v), at).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(ref[k]!.v)))
  }
}

/** The scans in which `key` reads TRUE. */
const on = (m: Mem[], key: string): number[] => m.flatMap((r, k) => (r[key] === true ? [k] : []))
const firstScan = (m: Mem[], pred: (r: Mem) => boolean, from = 0) => m.findIndex((r, k) => k >= from && pred(r))

const MV = 'Velocity := 20, Acceleration := 100, Deceleration := 100'
const MOVE = { velocity: 20, accel: 100, decel: 100 }

describe.each(ENGINES)('PLCopen motion blocks (%s engine)', (engine) => {
  it('MC_Power: Status and Valid in the scan Enable is TRUE; the axis Standstill; Enable FALSE disables it', () => {
    const m = run(program([], '', '', 'cyc < 5'), 8, engine)
    expect(on(m, 'pwr.Status')).toEqual([0, 1, 2, 3, 4])
    expect(on(m, 'pwr.Valid')).toEqual([0, 1, 2, 3, 4])
    expect(m.map((r) => r['AX.State'])).toEqual([1, 1, 1, 1, 1, 0, 0, 0].map((x) => (x ? S.standstill : S.disabled)))
    expect(on(m, 'pwr.Error')).toEqual([])
  })

  it('MC_Power: a direction enable FALSE (direction-restricted power, not modelled) is an Error, and the axis stays unpowered', () => {
    const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := TRUE, Position := 5, ${MV});`, '', 'TRUE, EnablePositive := FALSE'), 3, engine)
    expect([m[2]!['pwr.Error'], m[2]!['pwr.ErrorID'], m[2]!['pwr.Status'], m[2]!['pwr.Valid']]).toEqual([true, MOTION_ERROR.directionEnableNotSupported, false, false])
    expect([m[2]!['mv.Error'], m[2]!['mv.ErrorID'], m[2]!['AX.State']]).toEqual([true, MOTION_ERROR.axisNotPowered, S.disabled])
  })

  it('MC_MoveAbsolute: the trapezoid, Busy and Active until Done, Done held while Execute is, the axis State along the way', () => {
    const m = run(program(['mv : MC_MoveAbsolute', 'moving : BOOL'], `mv(Axis := AX, Execute := pwr.Status, Position := 10, ${MV});\nmoving := AX.State = AXIS_STATE.DiscreteMotion;`), 200, engine)
    // closed form: 0.2 s up at 100, 0.3 s at 20, 0.2 s down; scan k is k*DT in
    const x = (t: number) => (t <= 0.2 ? 50 * t * t : t <= 0.5 ? 2 + 20 * (t - 0.2) : t < 0.7 ? 10 - 50 * (0.7 - t) ** 2 : 10)
    for (let k = 0; k < m.length; k++) expect(m[k]!['AX.SetPosition'] as number, `scan ${k}`).toBeCloseTo(x(k * DT), 9)
    const done = firstScan(m, (r) => r['mv.Done'] === true)
    expect([175, 176]).toContain(done) // 0.7 s = 175 scans, the elapsed time a sum of scans
    expect(on(m, 'mv.Busy')).toEqual(Array.from({ length: done }, (_, k) => k))
    expect(on(m, 'mv.Active')).toEqual(Array.from({ length: done }, (_, k) => k))
    expect(on(m, 'mv.Done')).toEqual(Array.from({ length: 200 - done }, (_, k) => done + k)) // held: Execute is held
    expect(on(m, 'moving')).toEqual(Array.from({ length: done }, (_, k) => k))
    expect(m[done]!['AX.State']).toBe(S.standstill)
    expect([m[100]!['AX.ActualPosition'], m[100]!['AX.ActualVelocity']]).toEqual([m[100]!['AX.SetPosition'], m[100]!['AX.SetVelocity']])
  })

  it('a pulsed Execute: the move runs to the end, and Done shows for one scan', () => {
    const m = run(program(['mv : MC_MoveAbsolute', 'pulsed : BOOL'], `mv(Axis := AX, Execute := pwr.Status AND NOT pulsed, Position := 1, ${MV});\npulsed := TRUE;`), 70, engine)
    const done = on(m, 'mv.Done')
    expect(done).toHaveLength(1)
    expect([50, 51]).toContain(done[0]) // the 0.2 s triangle
    expect(m[69]!['AX.SetPosition']).toBe(1)
  })

  it('MC_MoveRelative goes by the distance from where the axis is', () => {
    const m = run(program(['mv : MC_MoveRelative'], `mv(Axis := AX, Execute := pwr.Status, Distance := 5, ${MV});`), 130, engine)
    expect(m[129]!['AX.SetPosition']).toBe(5)
    expect(m[129]!['mv.Done']).toBe(true)
  })

  it('an abort: the new block is Active in the scan it is called, the old one reads CommandAborted from the next', () => {
    const m = run(program(['mv : MC_MoveAbsolute', 'mv2 : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 10, ${MV});\nmv2(Axis := AX, Execute := cyc >= 40, Position := 2, ${MV});`), 130, engine)
    sameMotion(m, kernel(130, {}, (k, a) => {
      if (k === 0) axisMoveAbsolute(a, 10, MOVE)
      if (k === 40) axisMoveAbsolute(a, 2, MOVE)
    }), 'abort')
    expect(on(m, 'mv.CommandAborted')[0]).toBe(41)
    expect(m[40]!['mv.Active']).toBe(true) // called before mv2 in scan 40
    expect(m[41]!['mv.Busy']).toBe(false)
    expect(m[40]!['mv2.Active']).toBe(true)
    expect(m[129]!['mv2.Done']).toBe(true)
    expect(m[129]!['AX.SetPosition']).toBe(2)
  })

  it('MC_MoveVelocity: InVelocity once at speed and held, Busy stays; MC_Halt brakes it (Active, then Done) to Standstill', () => {
    const m = run(program(['mv : MC_MoveVelocity', 'h : MC_Halt'], 'mv(Axis := AX, Execute := pwr.Status AND cyc < 100, Velocity := 15, Acceleration := 100, Deceleration := 100, Direction := MC_DIRECTION.positive);\nh(Axis := AX, Execute := cyc >= 100, Deceleration := 50);'), 200, engine)
    sameMotion(m, kernel(200, {}, (k, a) => {
      if (k === 0) axisMoveVelocity(a, 15, { accel: 100, decel: 100 })
      if (k === 100) axisHalt(a, 50)
    }), 'velocity and halt')
    const inVel = firstScan(m, (r) => r['mv.InVelocity'] === true)
    expect([37, 38]).toContain(inVel) // 15 at 100: 0.15 s = 37.5 scans
    expect(on(m, 'mv.InVelocity')).toEqual(Array.from({ length: 101 - inVel }, (_, k) => inVel + k))
    expect(on(m, 'mv.Busy')).toEqual(Array.from({ length: 101 }, (_, k) => k))
    expect(m[50]!['AX.State']).toBe(S.continuous)
    // Execute fell at 100 and the halt took the axis that scan: CommandAborted shows for one scan
    expect(on(m, 'mv.CommandAborted')).toEqual([101])
    expect(m[120]!['h.Active']).toBe(true)
    const halted = firstScan(m, (r) => r['h.Done'] === true)
    expect([174, 175]).toContain(halted) // 15 at 50: 0.3 s = 75 samples, the first in scan 100 itself
    expect(m[halted]!['h.Active']).toBe(false)
    expect(m[halted]!['AX.State']).toBe(S.standstill)
  })

  it('MC_Stop: Stopping while held; a move then is refused (ErrorID axisStopping); released, Standstill, and a move runs', () => {
    const m = run(
      program(
        ['mv : MC_MoveVelocity', 's : MC_Stop', 'during : MC_MoveAbsolute', 'after : MC_MoveAbsolute'],
        `mv(Axis := AX, Execute := pwr.Status, Velocity := 15, Acceleration := 100, Deceleration := 100);
s(Axis := AX, Execute := cyc >= 60 AND cyc < 120, Deceleration := 100);
during(Axis := AX, Execute := cyc >= 90, Position := 0, ${MV});
after(Axis := AX, Execute := cyc >= 140, Position := 0, ${MV});`,
      ),
      260,
      engine,
    )
    expect(m.slice(60, 120).every((r) => r['AX.State'] === S.stopping)).toBe(true)
    expect(on(m, 'mv.CommandAborted')[0]).toBe(61)
    const stopped = firstScan(m, (r) => r['s.Done'] === true)
    expect([97, 98]).toContain(stopped) // 15 at 100: 0.15 s = 37.5 samples, the first in scan 60 itself
    expect(m[stopped]!['AX.SetVelocity']).toBe(0)
    expect([m[90]!['during.Error'], m[90]!['during.ErrorID'], m[119]!['during.Error']]).toEqual([true, MOTION_ERROR.axisStopping, true])
    expect(m[120]!['AX.State']).toBe(S.standstill)
    expect(m[140]!['after.Active']).toBe(true)
    expect(m[259]!['after.Done']).toBe(true)
    expect(m[259]!['AX.SetPosition']).toBe(0)
  })

  it('a move on an unpowered axis is refused (ErrorID axisNotPowered)', () => {
    const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := cyc >= 2, Position := 5, ${MV});`, '', 'FALSE'), 5, engine)
    expect([m[2]!['mv.Error'], m[2]!['mv.ErrorID'], m[2]!['mv.Busy'], m[4]!['AX.SetPosition'], m[4]!['AX.State']]).toEqual([true, MOTION_ERROR.axisNotPowered, false, 0, S.disabled])
  })

  it('powering off mid-move aborts the move', () => {
    const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := TRUE, Position := 10, ${MV});`, '', 'cyc < 20'), 25, engine)
    expect(on(m, 'mv.CommandAborted')).toEqual([20, 21, 22, 23, 24])
    expect(m[24]!['AX.State']).toBe(S.disabled)
  })

  it('MC_Home: Homing for a scan, then the position is set and Done; a move started off its Done moves from the next scan', () => {
    const m = run(program(['hm : MC_Home', 'mv : MC_MoveAbsolute'], `hm(Axis := AX, Execute := pwr.Status AND cyc >= 1, Position := 7);\nmv(Axis := AX, Execute := hm.Done, Position := 9, ${MV});`), 90, engine)
    expect([m[1]!['AX.State'], m[1]!['hm.Busy'], m[1]!['hm.Active'], m[1]!['AX.SetPosition']]).toEqual([S.homing, true, true, 0])
    expect([m[2]!['hm.Done'], m[2]!['AX.SetPosition'], m[2]!['AX.SetVelocity'], m[2]!['mv.Busy']]).toEqual([true, 7, 0, true])
    expect(m[3]!['AX.SetPosition'] as number).toBeCloseTo(7 + 50 * DT * DT, 12)
    expect(m[89]!['AX.SetPosition']).toBe(9) // 2 units: a triangle of 2*sqrt(2)/10 s, 71 scans
  })

  it('MC_ReadStatus, MC_ReadActualPosition and MC_ReadActualVelocity read the axis', () => {
    const m = run(
      program(
        ['mv : MC_MoveAbsolute', 'st : MC_ReadStatus', 'rp : MC_ReadActualPosition', 'rv : MC_ReadActualVelocity'],
        `mv(Axis := AX, Execute := pwr.Status, Position := 10, ${MV});
st(Axis := AX, Enable := TRUE);
rp(Axis := AX, Enable := TRUE);
rv(Axis := AX, Enable := TRUE);`,
      ),
      60,
      engine,
    )
    const r = m[50]!
    expect([r['st.Valid'], r['st.DiscreteMotion'], r['st.Standstill'], r['st.ErrorStop'], r['st.Disabled']]).toEqual([true, true, false, false, false])
    expect([r['rp.Valid'], r['rp.Position'], r['rv.Velocity']]).toEqual([true, r['AX.SetPosition'], r['AX.SetVelocity']])
  })

  describe('software limits', () => {
    const LIM = 'AX.LimitsEnabled := TRUE; AX.LimitPositive := 5; AX.LimitNegative := -5;'

    it('a target past the limit is accepted; the axis stops at or short of it in ErrorStop, and the block and the axis report SoftwareLimit', () => {
      const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 8, ${MV});`, LIM), 120, engine)
      sameMotion(m, kernel(120, { min: -5, max: 5 }, (k, a) => k === 0 && axisMoveAbsolute(a, 8, MOVE)), 'limit, default deceleration')
      // the default: the deceleration of the move in motion (its Deceleration, 100)
      sameMotion(m, kernel(120, { min: -5, max: 5, limitDecel: MOVE.decel }, (k, a) => k === 0 && axisMoveAbsolute(a, 8, MOVE)), "limit, the move's deceleration")
      const r = m[119]!
      expect([r['mv.Error'], r['mv.ErrorID'], r['mv.Busy'], r['AX.State'], r['AX.Error'], r['AX.ErrorID']]).toEqual([true, MOTION_ERROR.softwareLimit, false, S.errorStop, true, MOTION_ERROR.softwareLimit])
      expect(Math.max(...m.map((x) => x['AX.SetPosition'] as number))).toBeLessThanOrEqual(5)
    })

    it('LimitDeceleration sets how hard the limit stop brakes (not a positive number: the Deceleration of the move)', () => {
      const m = run(program(['mv : MC_MoveVelocity'], 'mv(Axis := AX, Execute := pwr.Status, Velocity := 15, Acceleration := 100, Deceleration := 100);', `${LIM} AX.LimitDeceleration := 200;`), 150, engine)
      sameMotion(m, kernel(150, { min: -5, max: 5, limitDecel: 200 }, (k, a) => k === 0 && axisMoveVelocity(a, 15, { accel: 100, decel: 100 })), 'limit, decel 200')
      const dflt = kernel(150, { min: -5, max: 5 }, (k, a) => k === 0 && axisMoveVelocity(a, 15, { accel: 100, decel: 100 }))
      expect(m[149]!['AX.SetPosition']).not.toBeCloseTo(dflt[149]!.x, 3)
      expect(m[149]!['mv.ErrorID']).toBe(MOTION_ERROR.softwareLimit)
    })

    it('MC_Reset clears the ErrorStop once the axis is still, and the axis moves again', () => {
      const m = run(
        program(['mv : MC_MoveAbsolute', 'rs : MC_Reset', 'back : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 8, ${MV});\nrs(Axis := AX, Execute := cyc >= 150);\nback(Axis := AX, Execute := cyc >= 160, Position := 0, ${MV});`, LIM),
        300,
        engine,
      )
      expect([m[150]!['rs.Done'], m[150]!['AX.State'], m[150]!['AX.Error'], m[150]!['AX.ErrorID']]).toEqual([true, S.standstill, false, 0])
      expect(m[299]!['back.Done']).toBe(true)
      expect(m[299]!['AX.SetPosition']).toBe(0)
    })
  })

  describe('BufferMode', () => {
    const BUF = 'BufferMode := MC_BUFFER_MODE.Buffered'

    it('Buffered behind a move: Busy and not Active while it waits, its first motion the scan after the one ahead is Done', () => {
      const m = run(program(['mv : MC_MoveAbsolute', 'mv2 : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 5, ${MV});\nmv2(Axis := AX, Execute := cyc >= 20, Position := 8, ${MV}, ${BUF});`), 230, engine)
      const done = firstScan(m, (r) => r['mv.Done'] === true)
      for (let k = 20; k < done; k++) expect([m[k]!['mv2.Busy'], m[k]!['mv2.Active']], `scan ${k}`).toEqual([true, false])
      expect([m[done]!['AX.SetPosition'], m[done]!['AX.SetVelocity']]).toEqual([5, 0])
      expect(m[done + 1]!['AX.SetPosition'] as number).toBeCloseTo(5 + 50 * DT * DT, 12)
      expect(m[done + 1]!['mv2.Active']).toBe(true)
      expect(m[229]!['mv2.Done']).toBe(true)
      expect(m[229]!['AX.SetPosition']).toBe(8)
    })

    it('Buffered on an idle axis starts at once', () => {
      const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 3, ${MV}, ${BUF});`), 3, engine)
      expect([m[0]!['mv.Active'], m[1]!['AX.SetPosition']]).toEqual([true, 50 * DT * DT])
    })

    it('a queue of two runs in order', () => {
      const m = run(
        program(['mv : MC_MoveAbsolute', 'mv2 : MC_MoveAbsolute', 'mv3 : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 3, ${MV});\nmv2(Axis := AX, Execute := cyc >= 10, Position := 6, ${MV}, ${BUF});\nmv3(Axis := AX, Execute := cyc >= 15, Position := 1, ${MV}, ${BUF});`),
        320,
        engine,
      )
      const d1 = firstScan(m, (r) => r['mv.Done'] === true)
      const d2 = firstScan(m, (r) => r['mv2.Done'] === true)
      expect(d2).toBeGreaterThan(d1)
      for (let k = 15; k < d2; k++) expect([m[k]!['mv3.Busy'], m[k]!['mv3.Active']], `scan ${k}`).toEqual([true, false])
      expect([m[319]!['mv3.Done'], m[319]!['AX.SetPosition']]).toEqual([true, 1])
    })

    it('an Aborting move aborts the active one and the one waiting, both from the next scan', () => {
      const m = run(
        program(['mv : MC_MoveAbsolute', 'mv2 : MC_MoveAbsolute', 'mv3 : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 5, ${MV});\nmv2(Axis := AX, Execute := cyc >= 10, Position := 8, ${MV}, ${BUF});\nmv3(Axis := AX, Execute := cyc >= 30, Position := 2, ${MV});`),
        150,
        engine,
      )
      expect([on(m, 'mv.CommandAborted')[0], on(m, 'mv2.CommandAborted')[0]]).toEqual([31, 31])
      expect([m[149]!['mv3.Done'], m[149]!['AX.SetPosition']]).toEqual([true, 2])
    })

    it('behind a velocity move: takes over the scan the velocity is reached; for that one scan the velocity block shows InVelocity and CommandAborted', () => {
      const m = run(program(['mv : MC_MoveVelocity', 'mv2 : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Velocity := 15, Acceleration := 100, Deceleration := 100);\nmv2(Axis := AX, Execute := cyc >= 10, Position := 6, ${MV}, ${BUF});`), 150, engine)
      const both = m.flatMap((r, k) => (r['mv.InVelocity'] === true && r['mv.CommandAborted'] === true ? [k] : []))
      expect(both).toHaveLength(1)
      expect([37, 38]).toContain(both[0])
      expect([m[both[0]! + 1]!['mv.InVelocity'], m[both[0]! + 1]!['mv.CommandAborted'], m[both[0]! + 1]!['mv.Busy']]).toEqual([false, true, false])
      expect(m[both[0]!]!['mv2.Active']).toBe(true)
      expect(m[149]!['AX.SetPosition']).toBe(6)
    })

    it('a Blending mode is not modelled: the block raises Error blendingNotSupported and the axis is untouched', () => {
      const m = run(
        program(['mv : MC_MoveAbsolute', 'vel : MC_MoveVelocity'], `mv(Axis := AX, Execute := pwr.Status, Position := 5, ${MV}, BufferMode := MC_BUFFER_MODE.BlendingLow);\nvel(Axis := AX, Execute := pwr.Status, Velocity := 5, Acceleration := 100, Deceleration := 100, BufferMode := MC_BUFFER_MODE.BlendingHigh);`),
        10,
        engine,
      )
      const r = m[9]!
      expect([r['mv.Error'], r['mv.ErrorID'], r['mv.Busy']]).toEqual([true, MOTION_ERROR.blendingNotSupported, false])
      expect([r['vel.Error'], r['vel.ErrorID'], r['vel.Busy']]).toEqual([true, MOTION_ERROR.blendingNotSupported, false])
      expect([r['AX.SetPosition'], r['AX.State']]).toEqual([0, S.standstill])
    })
  })

  describe('dynamics', () => {
    it('Jerk is accepted and ignored: a move that sets it is the same trapezoid as one that does not', () => {
      const m = run(program(['mv : MC_MoveAbsolute'], `mv(Axis := AX, Execute := pwr.Status, Position := 10, ${MV}, Jerk := 1000);`), 200, engine)
      sameMotion(m, kernel(200, {}, (k, a) => k === 0 && axisMoveAbsolute(a, 10, MOVE)), 'Jerk ignored')
      expect(m[199]!['mv.Done']).toBe(true)
    })

    it('a move with a velocity of 0 is refused (invalidDynamics)', () => {
      const m = run(program(['mv : MC_MoveAbsolute'], 'mv(Axis := AX, Execute := pwr.Status, Position := 1, Velocity := 0, Acceleration := 100, Deceleration := 100);'), 2, engine)
      expect([m[0]!['mv.Error'], m[0]!['mv.ErrorID']]).toEqual([true, MOTION_ERROR.invalidDynamics])
    })
  })
})

describe('the two engines', () => {
  it('agree on every variable, with random writes between scans (the engine oracle)', () => {
    const src = program(
      ['mv : MC_MoveVelocity', 's : MC_Stop', 'during : MC_MoveAbsolute', 'after : MC_MoveAbsolute'],
      `mv(Axis := AX, Execute := pwr.Status, Velocity := 15, Acceleration := 100, Deceleration := 100);
s(Axis := AX, Execute := cyc >= 60 AND cyc < 120, Deceleration := 100);
during(Axis := AX, Execute := cyc >= 90, Position := 0, ${MV});
after(Axis := AX, Execute := cyc >= 140, Position := 0, ${MV});`,
    )
    const r = compareEngines(src, Array.from({ length: 250 }, () => ({ dt: DT })))
    expect(r.refused).toBeUndefined()
    expect(r.diffs).toEqual([])
    expect(r.scans).toBe(250)
  })
})

describe('exporting a program that uses the motion blocks', () => {
  const src = `VAR
  Ax : AXIS_REF;
  pwr : MC_Power;
  mv : MC_MoveAbsolute;
END_VAR
pwr(Axis := Ax, Enable := TRUE);
mv(Axis := Ax, Execute := pwr.Status, Position := 10, Velocity := 20, Acceleration := 100, Deceleration := 100);`

  for (const target of ['iec-text', 'plcopen-xml'] as const) {
    it(`${target}: writes the calls, never the library's blocks or types, and says once what the target needs`, () => {
      const r = exportProgram(src, target)
      expect(r.content).toMatch(/MC_MoveAbsolute/) // the call and the instance
      expect(r.content).not.toMatch(/FUNCTION_BLOCK MC_|TYPE AXIS_REF|TYPE AXIS_STATE|AXIS_KERNEL|AXIS_LibState|pou name="MC_|dataType name="AXIS_/)
      expect(r.warnings.filter((w) => /PLCopen motion blocks/.test(w))).toHaveLength(1)
      // nothing about the library's own definitions (they are not the program's)
      expect(r.warnings.filter((w) => /AXIS_REF: a STRUCT|MC_Power, MC_MoveAbsolute, MC_MoveRelative/.test(w))).toEqual([])
    })
  }

  it('a program that defines its own MC_Power keeps it (a user block shadows the library one)', () => {
    const own = `FUNCTION_BLOCK MC_Power
VAR_INPUT Enable : BOOL; END_VAR
VAR_OUTPUT Status : BOOL; END_VAR
Status := Enable;
END_FUNCTION_BLOCK

VAR p : MC_Power; s : BOOL; END_VAR
p(Enable := TRUE);
s := p.Status;`
    const p = compile(own)
    p.scan(DT)
    expect(p.deepMemory['s']).toBe(true)
  })

  it('MC_Halt and MC_Home take no BufferMode: they run Aborting only', () => {
    expect(() => compile(`VAR Ax : AXIS_REF; h : MC_Halt; END_VAR
h(Axis := Ax, Execute := TRUE, Deceleration := 10, BufferMode := MC_BUFFER_MODE.Buffered);`)).toThrow(/BufferMode/)
  })
})
