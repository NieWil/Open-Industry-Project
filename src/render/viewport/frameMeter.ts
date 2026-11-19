/**
 * The two frame facts the stats window needs beside the main thread's time: what the GPU spent on each frame, and
 * how fast the display can show frames. The view owns one of each and feeds them from tick().
 */

/**
 * GPU time per frame, from WebGPU timestamp queries (`trackTimestamp`, createRenderer.ts).
 *
 * three resolves its queries a frame or two late, in batches, and `resolveTimestampsAsync()` returns only the newest
 * frame of a batch. Taking that return value as "this frame" mixes frames: a batch that lands after a long frame
 * reads as one huge frame, and frames in between are never counted. So this reads the resolved batch itself, the
 * render pool's `timestamps` map (uid to pass ms, each uid ending `:f<frameId>`), and adds every frame once, the way
 * three's own Inspector attributes passes to frames (examples/jsm/inspector/RendererInspector.js). The coupling is in
 * docs/three-coupling.md.
 */
export class GpuFrameTimes {
  /** GPU ms summed over every counted frame; window-diffed by the overlay the way cpuTotalMs is */
  totalMs = 0
  /** frames counted into totalMs */
  frames = 0
  /** EMA of one frame's GPU ms, for readers that want a single number (the device bench) */
  ema = 0
  private lastFrame = -1

  /**
   * Count the frames of one resolved batch. A batch can be handed over twice (three returns the pending resolve to
   * a second caller, and an early return leaves the last batch in the map), so a frame at or below the last one
   * counted is skipped. three inserts a frame's passes together and frames in order, so a frame is complete when the
   * next one starts.
   */
  collect(timestamps: ReadonlyMap<string, number>): void {
    let frame = -1
    let sum = 0
    for (const [uid, ms] of timestamps) {
      const at = uid.lastIndexOf(':f')
      if (at < 0) continue
      const f = Number(uid.slice(at + 2))
      if (!Number.isFinite(f) || f <= this.lastFrame) continue
      if (f !== frame) {
        if (frame >= 0) this.add(frame, sum)
        frame = f
        sum = 0
      }
      if (Number.isFinite(ms) && ms >= 0) sum += ms
    }
    if (frame >= 0) this.add(frame, sum)
  }

  private add(frame: number, ms: number): void {
    this.totalMs += ms
    this.frames++
    this.ema = this.ema === 0 ? ms : this.ema + 0.1 * (ms - this.ema)
    this.lastFrame = frame
  }
}

/** intervals kept for the estimate: about four seconds at 60 Hz */
const REFRESH_WINDOW = 256
/** the share of the window taken as "the fastest the display delivers"; a few stray fast frames can't reach it */
const REFRESH_PERCENTILE = 0.05
/** re-sort this often */
const REFRESH_EVERY = 64
/** an interval under this is a doubled rAF or a timer quirk, not a display */
const MIN_INTERVAL_MS = 4

/** the refresh interval assumed until a faster display shows itself: 60 Hz, the slowest rate in common use */
const ASSUMED_INTERVAL_MS = 1000 / 60

/**
 * The display's refresh interval: 60 Hz, or faster once the frames show it. The browser doesn't report the refresh
 * rate, so this is how a slow frame rate is told apart from a slow display.
 *
 * It starts at 60 Hz and only moves down, to the 5th percentile of recent intervals when that is shorter, and stays
 * at the shortest reading since the view mounted. A scene that is slow from the start never shows the display's rate
 * (measured: a run held under 30 fps read 33 ms), so an estimate taken from its frames alone would call a slow scene
 * a slow display. The 5th percentile, not the minimum: a 120 Hz panel showing a 60 fps app hands it the odd 8-10 ms
 * frame (measured, frameHitch.ts), and a minimum would take that for the display's rate. The costs: a display slower
 * than 60 Hz reads as 60, and moving the window to a slower monitor keeps the faster estimate until the view remounts.
 */
export class RefreshEstimate {
  private readonly ring = new Float64Array(REFRESH_WINDOW)
  private readonly sorted = new Float64Array(REFRESH_WINDOW)
  private filled = 0
  private head = 0
  private sincePass = 0
  private best = ASSUMED_INTERVAL_MS

  /** the estimated refresh interval in ms */
  get intervalMs(): number {
    return this.best
  }

  push(dtMs: number): void {
    if (!(dtMs >= MIN_INTERVAL_MS)) return
    this.ring[this.head] = dtMs
    this.head = (this.head + 1) % REFRESH_WINDOW
    if (this.filled < REFRESH_WINDOW) this.filled++
    if (this.filled < REFRESH_WINDOW || ++this.sincePass < REFRESH_EVERY) return
    this.sincePass = 0
    this.sorted.set(this.ring)
    this.sorted.sort()
    const p = this.sorted[Math.floor(REFRESH_WINDOW * REFRESH_PERCENTILE)]!
    if (p < this.best) this.best = p
  }
}

/** the view's frame facts beyond its main-thread time, held as one field on RenderView */
export class FrameMeter {
  readonly gpu = new GpuFrameTimes()
  readonly refresh = new RefreshEstimate()
}
