import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerView } from '../../collab/session'

// the room as this follower sees it: the owner (presence id 2) stands still at OWNER's view the whole time
const OWNER: PeerView = { px: 4, py: 6, pz: 7, tx: 1, ty: 0, tz: -1, ortho: false }
vi.mock('../../collab/session', () => ({
  getCollabSnapshot: () => ({ room: 'r-room', selfId: 1 }),
  getPeers: () => [{ clientId: 2, watching: null, view: OWNER }],
  // no presence change ever comes: the owner does not move
  subscribePeers: () => () => {},
  setLocalView: () => {},
}))

const { LiveCamera } = await import('./liveCamera')

type Pose = { px: number; py: number; pz: number; tx: number; ty: number; tz: number }

function follower() {
  let cam: Pose = { px: 9, py: 7, pz: 9, tx: 0, ty: 0, tz: 0 }
  const state = { liveTarget: { who: 2, stream: 's', why: 'view' as const }, liveViewDetached: false, mode: 'idle' as const }
  const host = {
    view: {
      cameraPose: () => ({ ...cam }),
      lookPose: () => ({ ...cam }),
      setCameraPose: (p: Pose) => void (cam = { ...p }),
      isNavigating: () => false,
      isVRPresenting: () => false,
      projectionMode: () => 'perspective' as const,
      setProjection: () => {},
    },
    store: {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => void Object.assign(state, patch),
      // no store change ever comes either
      subscribe: () => () => {},
    },
  }
  return { camera: new LiveCamera(host as unknown as ConstructorParameters<typeof LiveCamera>[0]), cam: () => cam, state }
}

describe('following a view', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('takes the view of someone standing still, with no store or presence change to start it', () => {
    const f = follower()
    vi.advanceTimersByTime(3000)
    const c = f.cam()
    expect(Math.max(Math.abs(c.px - OWNER.px), Math.abs(c.py - OWNER.py), Math.abs(c.pz - OWNER.pz), Math.abs(c.tz - OWNER.tz))).toBeLessThan(0.01)
    expect(f.state.liveViewDetached).toBe(false)
    f.camera.dispose()
  })
})
