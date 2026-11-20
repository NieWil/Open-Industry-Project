// Live share on the controller's side (docs/live-share.md): this client's run frames go to the room for whoever
// follows it, and the run this client follows is drawn while it runs nothing of its own.
//
// Following draws the shared run's frames, smoothed by core/live/livePlayback.ts. No worker, no program, no part
// code: the store stays stopped, so nothing a run owns (Use, cargo promotion, the PLC panels) is live, and the
// document is never written. `liveFollowing` in the store puts the view alone in its running state (the controller's
// store listener), which is what draws cargo and run poses, and puts the idle poses back when it ends.

import type { BoxFrame } from '../../core/frame'
import { LivePlayback } from '../../core/live/livePlayback'
import type { LiveWatchValue } from '../../core/live/liveFrameWire'
import type { TagValue } from '../../plc'
import type { IRenderView } from '../../render/api'
import type { EditorStore } from '../store/store'
import { liveChannel, type LiveIn } from '../live/liveChannel'
import { LiveCamera, type LiveCameraHost } from './liveCamera'

/** What following needs of the controller, read when used: the view and store are set after this is built. */
export interface LiveViewHost {
  readonly view: Pick<IRenderView, 'applyBoxFrame'> & LiveCameraHost['view']
  readonly store: Pick<EditorStore, 'getState' | 'setState'> & LiveCameraHost['store']
  /** the frame the Inspector's live readouts read */
  lastFrame: BoxFrame | null
  /** this client's PLC variables, shared with its frames */
  readonly plcWatch: Readonly<Record<string, TagValue>> | null
}

export class LiveView {
  private readonly playback = new LivePlayback()
  private following = false
  private raf: number | null = null
  private drawn: BoxFrame | null = null
  private sharedWatch: Readonly<Record<string, LiveWatchValue>> | null = null
  private readonly channel: LiveIn = { frame: (f, w) => this.frame(f, w), end: () => this.end() }
  /** following the camera of the one this client follows (controller/liveCamera.ts) */
  private readonly camera: LiveCamera

  constructor(private readonly host: LiveViewHost) {
    liveChannel.in = this.channel
    this.camera = new LiveCamera(host)
  }

  /** a frame of this client's own run, for whoever follows it (main.tsx joinLiveShare) */
  share(frame: BoxFrame): void {
    if (this.host.store.getState().packageEdit) return // a run in the Part Editor tests the part, not the line
    liveChannel.out?.push(frame, this.host.plcWatch as Readonly<Record<string, LiveWatchValue>> | null)
  }

  /** The shared run's PLC variables while following it (what annotations and the Watch panel read), else null. */
  watch(): Readonly<Record<string, TagValue>> | null {
    return this.following ? this.sharedWatch : null
  }

  /**
   * A frame of the run this client follows arrived (live/followTarget.ts chose whose; the server sends only that one).
   * Never drawn while this client runs its own sim.
   */
  private frame(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>>): void {
    const h = this.host
    if (h.store.getState().running) return
    this.sharedWatch = watch
    this.playback.push(frame, performance.now())
    if (this.following) return
    this.following = true
    h.store.setState({ liveFollowing: true })
    const draw = (): void => {
      if (!this.following) return
      const f = this.playback.sample(performance.now())
      if (f && f !== this.drawn) {
        this.drawn = f
        h.view.applyBoxFrame(f)
        h.lastFrame = f
      }
      this.raf = requestAnimationFrame(draw)
    }
    draw()
  }

  /** Stop drawing the shared run: it ended, or this client is starting its own (simRun.ts run). */
  private end(): void {
    if (!this.following) return
    this.following = false
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.drawn = null
    this.playback.clear()
    this.sharedWatch = null
    this.host.lastFrame = null
    this.host.store.setState({ liveFollowing: false })
  }

  dispose(): void {
    this.camera.dispose()
    this.end()
    if (liveChannel.in === this.channel) liveChannel.in = null
  }
}
