// Verify the agent tools that hold and step the live sim (src/editor/agent/simTools.ts) against the real worker:
//   - pause holds the sim clock, and the toolbar's paused state shows it
//   - step takes exactly the steps asked for, `seconds` at the run rate, and `until` stops on the first step at or past
//     that time, each answered after the frame that shows it
//   - a request of many seconds runs over several worker ticks and still ends exact
//   - paused, get_cargo gives every body a velocity and a touching list, and some box is moving and touching a part
//   - step refuses going back in time; a resume during a long step ends it early and says so; resume runs on
// The desktop bridge (preload.cjs window.oipAgent) is stood in for by a page script, as in verify-agent-review.mjs.
// Uses the demo project. Run: node e2e/verify-agent-sim-step.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

function fakeAgentBridge() {
  const bridge = { tools: null, onCall: null, replies: new Map(), next: 1 }
  window.__agentBridge = bridge
  window.oipAgent = {
    serve: (tools) => (bridge.tools = tools),
    onCall: (cb) => ((bridge.onCall = cb), () => (bridge.onCall = null)),
    reply: (id, r) => bridge.replies.get(id)?.(r),
  }
  window.__agentCall = (name, args) =>
    new Promise((resolve) => {
      const id = bridge.next++
      bridge.replies.set(id, (r) => resolve(r.ok ? { ok: true, value: JSON.parse(r.text) } : r))
      bridge.onCall({ id, name, args })
    })
}

const browser = await chromium.launch({ headless: !HEADED })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(fakeAgentBridge)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* storage disabled: the tour just shows up */
    }
  })
  await page.goto(`${BASE}?scene=demo`)
  await page.waitForFunction(() => !!(window.__oip?.controller && window.__oip.sim && window.__agentBridge?.tools && window.__oip.store.getState().scene.parts.length > 0), null, { timeout: 60000 })
  const call = (name, args = {}) => page.evaluate(([n, a]) => window.__agentCall(n, a), [name, args])
  const simTime = () => page.evaluate(() => window.__oip.view.lastFrameSimTime)
  // the tools give sim time to the millisecond
  const near = (a, b) => Math.abs(a - b) < 0.0015

  const names = await page.evaluate(() => window.__agentBridge.tools.map((t) => t.name))
  check('the editor serves pause, resume and step', ['pause', 'resume', 'step'].every((n) => names.includes(n)))

  const refusedStopped = await call('step')
  check('stopped: step refuses', !refusedStopped.ok && /not running/.test(refusedStopped.error), refusedStopped.error)

  await call('run')
  await page.waitForFunction(() => window.__oip.view.lastFrameSimTime > 3 && (window.__oip.sim.plcState?.scansRun ?? 0) > 10, null, { timeout: 60000 })

  const p = await call('pause')
  const t0 = p.value?.simTime
  check('pause answers paused, with the sim time', p.ok && p.value.paused === true && typeof t0 === 'number', JSON.stringify(p.value ?? p.error))
  check('... and the toolbar state is paused', await page.evaluate(() => window.__oip.store.getState().paused))
  check('... and the view shows that moment', near(await simTime(), t0), `${await simTime()} vs ${t0}`)
  await page.waitForTimeout(600)
  check('paused: the sim clock holds', near(await simTime(), t0))

  const hz = await page.evaluate(() => window.__oip.sim.runHz)
  const dt = 1 / hz
  const one = await call('step')
  check('step with no argument takes one step', one.ok && one.value.steps === 1 && near(one.value.simTime - t0, dt), JSON.stringify(one.value))
  check('... and the view already shows it when the call returns', near(await simTime(), one.value.simTime))

  const ten = await call('step', { steps: 10 })
  check('step 10 advances ten steps', ten.ok && ten.value.steps === 10 && near(ten.value.simTime - one.value.simTime, 10 * dt), JSON.stringify(ten.value))

  const two = await call('step', { seconds: 2 })
  check('seconds: 2 takes two seconds of steps at the run rate', two.ok && two.value.steps === 2 * hz && near(two.value.simTime - ten.value.simTime, 2 * hz * dt), JSON.stringify(two.value))

  // many ticks' worth of steps: the worker yields a frame every 40 ms and carries on
  const frames = await page.evaluate(() => {
    window.__frameCount = 0
    const prev = window.__oip.sim.onFrame
    window.__oip.sim.onFrame = (f) => {
      window.__frameCount++
      prev(f)
    }
    return true
  })
  const target = Math.round((two.value.simTime + 8.03) * 1000) / 1000
  const until = await call('step', { until: target })
  const fc = await page.evaluate(() => window.__frameCount)
  check('until stops on the first step at or past the time', until.ok && until.value.simTime >= target - 1e-9 && until.value.simTime < target + dt, `${until.value?.simTime} for ${target}`)
  check('... posting frames on the way', frames && fc > 1, `${fc} frames`)
  check('... and stays paused', await page.evaluate(() => window.__oip.store.getState().paused))

  const back = await call('step', { until: 1 })
  check('step refuses going back in time', !back.ok && /already at/.test(back.error), back.error)

  const cargo = await call('get_cargo')
  const rows = cargo.value?.cargo ?? []
  check('paused: get_cargo says paused', cargo.ok && cargo.value.paused === true && rows.length > 0, `${rows.length} bodies`)
  check('... every body has a velocity and a touching list', rows.every((r) => Array.isArray(r.vel) && r.vel.length === 3 && Array.isArray(r.touching)))
  const moving = rows.filter((r) => Math.hypot(...r.vel) > 0.05 && r.touching.some((t) => t !== 'floor' && !t.startsWith('cargo ')))
  check('... and some box is moving while it touches a part', moving.length > 0, moving[0] ? JSON.stringify({ vel: moving[0].vel, touching: moving[0].touching }) : 'none')

  // a resume while a long step is under way ends it early
  const long = page.evaluate(() => window.__agentCall('step', { seconds: 100 }))
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__oip.controller.togglePause())
  const cut = await long
  check('a resume ends a long step early and says so', cut.ok && cut.value.interrupted === true && cut.value.steps < 100 * hz, JSON.stringify(cut.value ?? cut.error))
  await call('pause')

  const resumed = await call('resume')
  const r0 = await simTime()
  await page.waitForTimeout(500)
  check('resume runs on', resumed.ok && resumed.value.paused === false && (await simTime()) > r0)

  await call('stop')
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
