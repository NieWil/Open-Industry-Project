/* global process, console, setTimeout, setInterval, clearInterval, window, performance, requestAnimationFrame, PerformanceObserver, clearTimeout, URL */
// Guard: what does receiving a peer's presence cost? One instrumented browser client in a room with
// a 120-part scene; a node peer publishes awareness at a fixed rate. The collab server is local, so
// the wire is ~0.2 ms and every number here is the observer's own main-thread work.
//
//   phase 1  peer publishes only `cursor`  (someone moving their mouse)  -> must cost nothing
//   phase 2  peer publishes `drag` + `cursor` (someone dragging a part)  -> one rebuild per frame
//
// Regressions this pins (each one has shipped before):
//   - awareness fires per field, so a dragging peer's own cursor stream can double the work
//   - re-decoding the display scene from Yjs (docToScene) on every tick, though the doc is idle
//   - applying per WebSocket message rather than per frame, starving the frame loop: a 120-part scene
//     fell to ~8 fps on every other client while one person dragged
//   - the largest: resolveScene running the sim-only resolvers on the render thread. With all-or-nothing
//     memos, one moved part re-ran them over the whole scene every frame: 20 of the 29 ms per frame at
//     240 parts, computing deck clusters + guard runs render never reads. Pinned as a contract by
//     src/core/scene/sceneResolve.test.ts; this gate measures the consequence.
//   - resolvers memoized all-or-nothing, so one moved part re-derives every part's seams every frame.
//     They are memoized per target on their actual inputs (memoizeLocalized), which makes the cost
//     move-sized rather than scene-sized.
//
// Set OIP_PARTS to vary scene size (default 120). The cost per rebuild should track what moved, not
// the scene. At 240 parts the fixes took it from 53.4 -> 7.9 (consumer split) -> 2.3 ms (per-target
// memo), i.e. 11.2 -> 59.8 fps on the observing client; 480 parts costs less than 240 did before them.
//
// Frame rate is reported, never asserted (machine-dependent, same rule as verify-first-load's cover
// time); the rebuild counts are deterministic and are what fail this gate.
//
// Run: node e2e/verify-collab-presence-cost.mjs [--headed] [hz]
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { docNameFor, editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')
const HZ = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 60)
const SECS = 4

const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-recvcost-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true, stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('collab did not start')), 15000)
  collab.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res() } })
})
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`recvcost-${collabPort}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const instrument = () => {
  const w = window
  w.__m = { frames: 0, longMs: 0, longN: 0, transient: 0, applyRemote: 0, inCallMs: 0, t0: performance.now() }
  const tick = () => { w.__m.frames++; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { w.__m.longMs += e.duration; w.__m.longN++ } })
      .observe({ entryTypes: ['longtask'] })
  } catch { /* not supported */ }
  const st = w.__oip.store
  const t = st.setTransient.bind(st)
  st.setTransient = (s) => { w.__m.transient++; const t0 = performance.now(); const r = t(s); w.__m.inCallMs += performance.now() - t0; return r }
  const a = st.applyRemote.bind(st)
  st.applyRemote = (s) => { w.__m.applyRemote++; const t0 = performance.now(); const r = a(s); w.__m.inCallMs += performance.now() - t0; return r }
}
const reset = () => { const m = window.__m; m.frames = 0; m.longMs = 0; m.longN = 0; m.transient = 0; m.applyRemote = 0; m.inCallMs = 0; m.t0 = performance.now() }
const report = () => {
  const m = window.__m, dt = (performance.now() - m.t0) / 1000
  return { fps: +(m.frames / dt).toFixed(1), painted: m.frames, blockedMs: Math.round(m.longMs), longTasks: m.longN,
    sceneRebuilds: m.transient + m.applyRemote, msPerRebuild: +(m.inCallMs / Math.max(1, m.transient + m.applyRemote)).toFixed(1), inCallShare: +(m.inCallMs / (dt * 1000)).toFixed(2) }
}

const launch = async () => {
  for (const o of [{ channel: 'msedge', headless: !HEADED }, { headless: !HEADED }]) {
    try { return await chromium.launch(o) } catch { /* next */ }
  }
  return null
}
const browser = await launch()
try {
  const b = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()

  await b.addInitScript(() => {
    try { window.localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
  })

  // a realistically sized shared scene (a fresh room is just a building)
  const N = Number(process.env.OIP_PARTS ?? 120)
  const cols = Math.ceil(Math.sqrt(N))
  const parts = Array.from({ length: N }, (_, i) => ({
    id: `belt${i}`, type: 'part', packageId: 'oip.belt-conveyor',
    position: [(i % cols) * 6, 0, Math.floor(i / cols) * 6], rotationY: 0,
    params: { shapePreset: 'straight', segments: [[4, 0]], width: 1.524, height: 0.5, standHeight: 2, speed: 2, beltColor: '#ffffff' },
  }))

  await markSeeder(b, ROOM)
  await b.goto(`${APP_URL}?room=${ROOM}`)
  await b.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
  await b.waitForTimeout(1500)
  await b.evaluate((ps) => {
    const st = window.__oip.store
    st.loadScene({ ...st.getState().scene, parts: [...st.getState().scene.parts, ...ps] })
    st.setState({ selectedIds: [] })
  }, parts)
  await b.waitForTimeout(5000)
  const partCount = await b.evaluate(() => window.__oip.store.getState().scene.parts.length)
  const dragIds = await b.evaluate(() =>
    window.__oip.store.getState().scene.parts.filter((p) => p.type !== 'building').slice(0, 1).map((p) => p.id))
  console.log(`room scene: ${partCount} parts;  peer will "drag" ${JSON.stringify(dragIds)}\n`)

  // the node peer
  const doc = new Y.Doc()
  const peer = new HocuspocusProvider({ url: `ws://localhost:${collabPort}`, name: docNameFor(ROOM), document: doc, token: ROOM })
  await Promise.race([new Promise((r) => peer.on('synced', r)), sleep(10000)])
  peer.setAwarenessField('user', { name: 'Probe', color: '#f80' })
  await sleep(1000)

  const stream = async (label, withDrag) => {
    await b.evaluate(reset)
    let i = 0
    await new Promise((done) => {
      const iv = setInterval(() => {
        if (i >= HZ * SECS) { clearInterval(iv); done(); return }
        const k = i++
        if (withDrag) {
          peer.setAwarenessField('drag', dragIds.map((id) => ({ id, position: [k * 0.01, 0, 1.5], rotationY: 0 })))
        }
        peer.setAwarenessField('cursor', { x: k * 0.01, y: 0.4, z: 1.5 })
      }, 1000 / HZ)
    })
    const r = await b.evaluate(report)
    console.log(`${label.padEnd(30)} ${JSON.stringify(r)}`)
    if (withDrag) { peer.setAwarenessField('drag', null); await sleep(500) }
    return r
  }

  await b.evaluate(instrument)
  await b.evaluate(reset)
  await sleep(SECS * 1000)
  const idle = await b.evaluate(report)
  console.log(`${'baseline (peer idle)'.padEnd(30)} ${JSON.stringify(idle)}`)

  // control: the same store.setTransient path a local drag uses, driven at the same rate with no
  // collab involved. Reported for context - it is the floor the remote path can aim at.
  await b.evaluate(reset)
  await b.evaluate(async (n) => {
    const st = window.__oip.store
    const base = st.getState().scene
    for (let i = 0; i < n; i++) {
      const parts = base.parts.map((p) => (p.id === 'belt0' ? { ...p, position: [i * 0.01, 0, 1.5] } : p))
      st.setTransient({ ...base, parts })
      await new Promise((r) => setTimeout(r, 1000 / 60))
    }
  }, HZ * SECS)
  console.log(`${`LOCAL transient @${HZ}Hz`.padEnd(30)} ${JSON.stringify(await b.evaluate(report))}`)
  await sleep(500)
  const cursorOnly = await stream(`peer moves cursor @${HZ}Hz`, false)
  const dragging = await stream(`peer DRAGS a part @${HZ}Hz`, true)

  peer.destroy()

  // --- assertions. Rebuild counts are deterministic; frame rate is machine-dependent, so it is
  // reported above but never enforced (same rule as verify-first-load's cover time).
  console.log('')
  check('an idle room rebuilds nothing', idle.sceneRebuilds === 0, `${idle.sceneRebuilds}`)
  check(
    "a peer's CURSOR stream never rebuilds the scene",
    cursorOnly.sceneRebuilds === 0,
    `${cursorOnly.sceneRebuilds} rebuilds from ${HZ * SECS} cursor updates`,
  )
  const frames = HZ * SECS
  // Two independent guards on the drag path:
  //   <= 1 per drag frame - the dedupe: the dragger's own cursor stream must not double the work
  //   <= displayed frames - the rAF coalescing: never rebuild more often than the client paints
  check(
    'a drag rebuilds at most once per drag frame (cursor ticks deduped)',
    dragging.sceneRebuilds <= frames,
    `${dragging.sceneRebuilds} rebuilds for ${frames} drag frames`,
  )
  // The coalescing invariant, stated so it holds at both ends: a client that can paint every frame
  // legitimately rebuilds once per incoming pose, while a struggling one must do fewer, never more.
  // "rebuilds <= frames painted" is the property in both cases; "fewer than incoming" would pass only
  // while the client is too slow to keep up.
  check(
    'rebuilds are coalesced to the frame clock (never more work than frames painted)',
    dragging.sceneRebuilds <= dragging.painted * 1.05,
    `${dragging.sceneRebuilds} rebuilds vs ${dragging.painted} frames painted (${dragging.fps} fps)`,
  )
  check(
    'the client keeps painting while a peer drags (not starved)',
    dragging.fps >= idle.fps * 0.25,
    `${dragging.fps} fps vs ${idle.fps} idle`,
  )
} finally {
  await browser.close(); vite.kill(); collab.kill()
  try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
