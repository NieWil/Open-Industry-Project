// Following someone's view (docs/live-share.md "Watching"). While this client follows someone (live/followTarget.ts),
// its camera follows theirs, eased between the poses they publish. Moving one's own camera detaches it
// (`liveViewDetached`), which keeps the run but not the view; the chip's Follow view, a new person followed or a new
// spotlight attach it again. In pilot or VR this client drives its own camera, so nothing is applied then.
//
// A client publishes its camera ten times a second while anyone follows it (presence `view`, collab/session.ts), and
// nothing otherwise.

import { getCollabSnapshot, getPeers, setLocalView, subscribePeers, type PeerView } from '../../collab/session'
import type { IRenderView } from '../../render/api'
import type { EditorStore } from '../store/store'

const PUBLISH_MS = 100
/** the follower's camera closes the gap to the pose it follows with this time constant, smoothing the 10 Hz samples */
const EASE_S = 0.12
/** poses closer than this are the same (metres) */
const SAME_M = 1e-3

type Pose = Omit<PeerView, 'ortho'>

const KEYS = ['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const
const apart = (a: Pose, b: Pose): number => Math.max(...KEYS.map((k) => Math.abs(a[k] - b[k])))

export interface LiveCameraHost {
  readonly view: Pick<IRenderView, 'cameraPose' | 'lookPose' | 'setCameraPose' | 'isNavigating' | 'isVRPresenting' | 'projectionMode' | 'setProjection'>
  readonly store: Pick<EditorStore, 'getState' | 'setState' | 'subscribe'>
}

export class LiveCamera {
  private readonly timer: ReturnType<typeof setInterval>
  private published: PeerView | null = null
  private raf: number | null = null
  private lastFrame = 0
  /** where this client last put the camera; a camera found elsewhere was moved by the user */
  private applied: Pose | null = null
  private unsubscribe: (() => void) | null = null

  // The host is the controller, whose store and view are set after this is built, so nothing here reads them until
  // the first tick.
  constructor(private readonly host: LiveCameraHost) {
    this.timer = setInterval(() => this.tick(), PUBLISH_MS)
  }

  private tick(): void {
    if (getCollabSnapshot().room === null) return
    this.publish()
    // and follow on the tick too: a camera that arrives with no change after it (someone followed who stands still)
    // would otherwise wait for a store or presence change that may not come
    this.follow()
  }

  /** publish this client's camera while someone follows it, and stop when nobody does */
  private publish(): void {
    const c = getCollabSnapshot()
    if (!this.unsubscribe) {
      const offStore = this.host.store.subscribe(() => this.follow())
      const offPeers = subscribePeers(() => this.follow())
      this.unsubscribe = () => {
        offStore()
        offPeers()
      }
    }
    const followed = c.selfId !== null && getPeers().some((p) => p.watching === c.selfId)
    let next: PeerView | null = null
    if (followed) {
      // where it really looks: in pilot mode the orbit target is left behind as the walker turns
      const pose = this.host.view.lookPose()
      next = { ...pose, ortho: this.host.view.projectionMode() === 'orthographic' }
      if (this.published && this.published.ortho === next.ortho && apart(this.published, next) < SAME_M) return
    } else if (this.published === null) return
    this.published = next
    setLocalView(next)
  }

  /** start or stop following the camera of the one this client follows (called on store and presence changes) */
  follow(): void {
    if (this.wanted() === null) {
      this.stop()
      return
    }
    if (this.raf !== null) return
    this.applied = null
    this.lastFrame = performance.now()
    const step = (): void => {
      const goal = this.wanted()
      if (goal === null) {
        this.stop()
        return
      }
      const view = this.host.view
      const now = view.cameraPose()
      // the user moved the camera: an orbit, pan or zoom since this client last put it somewhere
      if (view.isNavigating() || (this.applied && apart(now, this.applied) > SAME_M)) {
        this.host.store.setState({ liveViewDetached: true })
        this.stop()
        return
      }
      if (view.projectionMode() !== (goal.ortho ? 'orthographic' : 'perspective')) view.setProjection(goal.ortho ? 'orthographic' : 'perspective')
      const t = performance.now()
      const k = 1 - Math.exp(-(t - this.lastFrame) / 1000 / EASE_S)
      this.lastFrame = t
      const next = apart(now, goal) < SAME_M ? goal : (Object.fromEntries(KEYS.map((key) => [key, now[key] + (goal[key] - now[key]) * k])) as Pose)
      if (apart(now, next) >= SAME_M / 10) view.setCameraPose(next, { instant: true })
      this.applied = view.cameraPose()
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  /** the camera to follow now, or null: not following anyone, detached, driving one's own camera, or none published */
  private wanted(): PeerView | null {
    const s = this.host.store.getState()
    const target = s.liveTarget
    if (!target || s.liveViewDetached || s.mode === 'pilot' || this.host.view.isVRPresenting()) return null
    return getPeers().find((p) => p.clientId === target.who)?.view ?? null
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.applied = null
  }

  dispose(): void {
    clearInterval(this.timer)
    this.unsubscribe?.()
    this.stop()
    if (this.published) setLocalView(null)
  }
}
