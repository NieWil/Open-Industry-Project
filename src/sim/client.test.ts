import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxFrame } from '../core/frame'
import type { SceneJSON } from '../core/types'
import type { WorkerToMain } from './protocol'

// SimClient's half of the frame wire (frameWire.ts): the worker sends partIds / dressings only as far as they
// changed, so the client must decode every frame message, including one it then drops because the sim is not
// running. Otherwise its copies fall behind and a later "kept" frame hands consumers stale ids. These pin that
// ordering in the real class, with the Worker faked.

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: ((e: MessageEvent<WorkerToMain>) => void) | null = null
  onerror: unknown = null
  messages: unknown[] = []
  constructor() {
    FakeWorker.last = this
  }
  postMessage(message: unknown): void { this.messages.push(message) }
  terminate(): void {}
  addEventListener(): void {}
}

type Wire = Pick<Extract<WorkerToMain, { type: 'frame' }>, 'partIds' | 'partIdsKept' | 'dressings' | 'dressingsPatch'>

function frame(n: number, wire: Wire): WorkerToMain {
  return {
    type: 'frame',
    count: n,
    simTime: 0,
    ids: new Uint32Array(n),
    positions: new Float32Array(n * 3),
    quats: new Float32Array(n * 4),
    halfExtents: new Float32Array(n * 3),
    colors: new Float32Array(n * 3),
    kinds: new Uint8Array(n),
    caps: new Uint8Array(n),
    stepStats: {} as never,
    ...wire,
  }
}

async function makeClient() {
  vi.stubGlobal('Worker', FakeWorker)
  const { SimClient } = await import('./client')
  const client = new SimClient()
  const frames: BoxFrame[] = []
  client.onFrame = (f) => frames.push(f)
  client.prewarm() // creates the worker without starting a run
  const deliver = (msg: WorkerToMain) => FakeWorker.last!.onmessage!({ data: msg } as MessageEvent<WorkerToMain>)
  return { client, frames, deliver }
}

const film = { anchor: 1, id: 'film', min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], color: [1, 1, 1] as [number, number, number], opacity: 0.4 }

describe('SimClient frame wire', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decodes a frame it drops while stopped, so the next "kept" frame carries the right ids', async () => {
    const { client, frames, deliver } = await makeClient()
    deliver(frame(2, { partIds: ['a', 'b'] })) // arrives while not running: dropped, but must still be decoded
    expect(frames).toHaveLength(0)
    client.start({ parts: [] } as unknown as SceneJSON)
    deliver(frame(2, { partIdsKept: true }))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.partIds).toEqual(['a', 'b'])
  })

  it('re-attaches ids and patched dressings to every frame handed on', async () => {
    const { client, frames, deliver } = await makeClient()
    client.start({ parts: [] } as unknown as SceneJSON)
    deliver(frame(1, { partIds: ['p'], dressings: [film] }))
    deliver(frame(1, { partIdsKept: true, dressingsPatch: { length: 1, changed: [[0, { ...film, opacity: 0.9 }]] } }))
    deliver(frame(1, { partIdsKept: true, dressingsPatch: { length: 1, changed: [] } }))
    deliver(frame(1, { partIdsKept: true })) // no dressings at all: the load was unwrapped
    expect(frames.map((f) => f.partIds)).toEqual([['p'], ['p'], ['p'], ['p']])
    expect(frames.map((f) => f.dressings?.[0]?.opacity)).toEqual([0.4, 0.9, 0.9, undefined])
  })
})


// The hang watchdog (SimClient.armWatchdog) ends a worker that shows no sign of life: no frame, no tick of the shared
// loop counter, no 'alive'. A paused loop sends no frames, so the counter (or 'alive') is what keeps a paused run.
describe('hang watchdog', () => {
  async function setup(shared: boolean) {
    vi.stubGlobal('crossOriginIsolated', shared)
    const { client, deliver } = await makeClient()
    const beacon = FakeWorker.last!.messages.find((m) => (m as { type?: string }).type === 'beacon') as { progress: SharedArrayBuffer } | undefined
    const progress = beacon ? new Int32Array(beacon.progress) : null
    vi.useFakeTimers()
    const hangs: (string | null)[] = []
    client.onHang = (p) => hangs.push(p)
    client.start({ parts: [] } as unknown as SceneJSON)
    // a second of the worker's step loop: it ticks the counter, or (paused, nothing shared) sends 'alive' once
    const second = (alive: boolean, paused = true) => {
      if (alive && progress) Atomics.add(progress, 0, 125)
      if (alive && !progress && paused) deliver({ type: 'alive' })
      vi.advanceTimersByTime(1000)
    }
    const seconds = (n: number, alive: boolean) => {
      for (let i = 0; i < n; i++) second(alive)
    }
    const done = () => {
      client.dispose()
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
    return { client, deliver, progress, hangs, seconds, done }
  }

  it('keeps a run the user paused for a minute', async () => {
    const { client, deliver, hangs, seconds, done } = await setup(true)
    try {
      deliver(frame(1, { partIds: ['p'] }))
      client.setPaused(true)
      seconds(60, true)
      expect(client.running).toBe(true)
      expect(hangs).toEqual([])
    } finally {
      done()
    }
  })

  it('ends a worker that gets stuck while paused', async () => {
    const { client, deliver, hangs, seconds, done } = await setup(true)
    try {
      deliver(frame(1, { partIds: ['p'] }))
      client.setPaused(true)
      seconds(5, true)
      seconds(11, false) // a paused step's part code never returns: no ticks, no frames
      expect(client.running).toBe(false)
      expect(hangs).toHaveLength(1)
    } finally {
      done()
    }
  })

  it('ends a worker that gets stuck while running, after 10 s and not before', async () => {
    const { client, deliver, hangs, seconds, done } = await setup(true)
    try {
      deliver(frame(1, { partIds: ['p'] }))
      seconds(9, false)
      expect(client.running).toBe(true)
      seconds(2, false)
      expect(client.running).toBe(false)
      expect(hangs).toHaveLength(1)
    } finally {
      done()
    }
  })

  it('keeps a live paused worker when the first check after a restore runs 60 s late', async () => {
    const { client, deliver, progress, hangs, done } = await setup(true)
    try {
      deliver(frame(1, { partIds: ['p'] }))
      client.setPaused(true) // the user paused, then minimized the window
      vi.stubGlobal('document', { visibilityState: 'hidden' })
      vi.advanceTimersByTime(1000) // one hidden check restarts the clock
      // the page's timer is then held for a minute while the worker's loop keeps ticking
      Atomics.add(progress!, 0, 7500)
      const late = performance.now() + 60_000
      vi.spyOn(performance, 'now').mockImplementation(() => late)
      vi.stubGlobal('document', { visibilityState: 'visible' })
      vi.advanceTimersByTime(1000) // the late check runs on restore, before any visibility handler
      expect(client.running).toBe(true)
      expect(hangs).toEqual([])
    } finally {
      done()
    }
  })

  it('allows 30 s for the first frame, while the world builds and the loop has not started', async () => {
    const { client, hangs, seconds, done } = await setup(true)
    try {
      seconds(25, false)
      expect(client.running).toBe(true)
      seconds(6, false)
      expect(client.running).toBe(false)
      expect(hangs).toHaveLength(1)
    } finally {
      done()
    }
  })

  it("without shared memory, keeps a paused run on the worker's 'alive' messages", async () => {
    const { client, deliver, progress, hangs, seconds, done } = await setup(false)
    try {
      expect(progress).toBeNull()
      deliver(frame(1, { partIds: ['p'] }))
      client.setPaused(true)
      seconds(60, true)
      expect(client.running).toBe(true)
      expect(hangs).toEqual([])
    } finally {
      done()
    }
  })

  it('without shared memory, ends a paused worker that goes silent', async () => {
    const { client, deliver, hangs, seconds, done } = await setup(false)
    try {
      deliver(frame(1, { partIds: ['p'] }))
      client.setPaused(true)
      seconds(5, true)
      seconds(11, false)
      expect(client.running).toBe(false)
      expect(hangs).toHaveLength(1)
    } finally {
      done()
    }
  })
})
