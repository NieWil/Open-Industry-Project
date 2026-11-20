// Smooth playback of a shared run's frames (docs/live-share.md). They arrive ~20 times a second with network jitter;
// drawn as they come, cargo and joints would step. The viewer instead plays a little behind the newest frame and
// blends the two frames either side of its play time.
//
// The play clock advances at the rate the sharer's sim time advances against the viewer's wall clock (so a sharer
// at 2x plays at 2x), and is pulled gently toward DELAY behind where the sharer is now, so jitter in when frames
// arrive moves the clock a little and never makes it jump. It never passes the newest frame, so a paused run holds.

import type { BoxFrame } from '../frame'

/** how far behind the newest frame the viewer plays, in the sharer's seconds at 1x */
const DELAY_S = 0.12
/** how much of the gap to its target the play clock closes per sample */
const PULL = 0.1
/** frames kept, in sim seconds behind the newest */
const KEEP_S = 1.5

export class LivePlayback {
  private frames: BoxFrame[] = []
  private arrivals: number[] = []
  private playSim: number | null = null
  private lastSampleAt = 0
  private last: { a: BoxFrame; b: BoxFrame; t: number; out: BoxFrame } | null = null

  /** a frame as it arrives; `nowMs` is the viewer's clock */
  push(frame: BoxFrame, nowMs: number): void {
    const newest = this.frames[this.frames.length - 1]
    if (newest && frame.simTime < newest.simTime) this.clear() // the run restarted
    this.frames.push(frame)
    this.arrivals.push(nowMs)
    while (this.frames.length > 2 && frame.simTime - this.frames[0]!.simTime > KEEP_S) {
      this.frames.shift()
      this.arrivals.shift()
    }
  }

  clear(): void {
    this.frames = []
    this.arrivals = []
    this.playSim = null
    this.last = null
  }

  /** The frame to draw now: two received frames blended at the play time. null before the first frame. */
  sample(nowMs: number): BoxFrame | null {
    const n = this.frames.length
    if (!n) return null
    const newest = this.frames[n - 1]!
    const rate = this.rate() // sim s per wall ms
    if (this.playSim === null) this.playSim = newest.simTime - DELAY_S * rate * 1000
    else this.playSim += (nowMs - this.lastSampleAt) * rate
    this.lastSampleAt = nowMs
    // where the sharer is now, by the newest frame and the time since it came; DELAY behind that, never past the newest
    const target = newest.simTime + (nowMs - this.arrivals[n - 1]!) * rate - DELAY_S * rate * 1000
    if (Math.abs(target - this.playSim) > 1) this.playSim = target
    else this.playSim += (target - this.playSim) * PULL
    const oldest = this.frames[0]!
    this.playSim = Math.min(newest.simTime, Math.max(oldest.simTime, this.playSim))

    let i = n - 1
    while (i > 0 && this.frames[i - 1]!.simTime > this.playSim) i--
    const b = this.frames[i]!
    const a = i > 0 ? this.frames[i - 1]! : b
    const span = b.simTime - a.simTime
    const t = span > 0 ? Math.min(1, Math.max(0, (this.playSim - a.simTime) / span)) : 1
    if (this.last && this.last.a === a && this.last.b === b && Math.abs(this.last.t - t) < 1e-4) return this.last.out
    const out = t >= 1 || a === b ? b : blendFrames(a, b, t)
    this.last = { a, b, t, out }
    return out
  }

  private rate(): number {
    const n = this.frames.length
    if (n < 2) return 1 / 1000
    const dWall = this.arrivals[n - 1]! - this.arrivals[0]!
    const dSim = this.frames[n - 1]!.simTime - this.frames[0]!.simTime
    return dWall > 0 ? Math.max(0, dSim / dWall) : 1 / 1000
  }
}

/** `b` with every pose, joint and mobile base moved back toward `a` by 1 - t. Anything not blendable is b's. */
export function blendFrames(a: BoxFrame, b: BoxFrame, t: number): BoxFrame {
  const at = new Map<number, number>()
  for (let i = 0; i < a.count; i++) at.set(a.ids[i]!, i)
  const positions = new Float32Array(b.positions)
  const quats = new Float32Array(b.quats)
  for (let i = 0; i < b.count; i++) {
    const j = at.get(b.ids[i]!)
    if (j === undefined) continue
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = lerp(a.positions[j * 3 + k]!, b.positions[i * 3 + k]!, t)
    let dot = 0
    for (let k = 0; k < 4; k++) dot += a.quats[j * 4 + k]! * b.quats[i * 4 + k]!
    const sign = dot < 0 ? -1 : 1
    let len = 0
    for (let k = 0; k < 4; k++) {
      const v = lerp(sign * a.quats[j * 4 + k]!, b.quats[i * 4 + k]!, t)
      quats[i * 4 + k] = v
      len += v * v
    }
    len = Math.sqrt(len) || 1
    for (let k = 0; k < 4; k++) quats[i * 4 + k] = quats[i * 4 + k]! / len
  }
  const out: BoxFrame = { ...b, positions, quats, simTime: lerp(a.simTime, b.simTime, t) }
  if (a.joints && b.joints) {
    const joints: Record<string, Record<string, number>> = {}
    for (const [pid, rec] of Object.entries(b.joints)) {
      const from = a.joints[pid]
      joints[pid] = from ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, typeof from[k] === 'number' ? lerp(from[k]!, v, t) : v])) : rec
    }
    out.joints = joints
  }
  if (a.basePoses && b.basePoses) {
    const poses: NonNullable<BoxFrame['basePoses']> = {}
    for (const [pid, p] of Object.entries(b.basePoses)) {
      const from = a.basePoses[pid]
      poses[pid] = from
        ? { pos: [lerp(from.pos[0], p.pos[0], t), lerp(from.pos[1], p.pos[1], t), lerp(from.pos[2], p.pos[2], t)], yaw: from.yaw + wrapAngle(p.yaw - from.yaw) * t }
        : p
    }
    out.basePoses = poses
  }
  return out
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const wrapAngle = (r: number): number => r - 2 * Math.PI * Math.round(r / (2 * Math.PI))
