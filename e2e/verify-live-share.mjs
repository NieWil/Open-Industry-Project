// Verify live share (docs/live-share.md): anyone running in a shared project can be watched, and a follower draws the
// run without running anything of its own.
//
// Against a real collab server (server/liveRelay.mjs sends each run to its followers) and the demo line, it asserts:
//   - sharing from a solo tab enters the project in place with no Live switch to turn on; nothing done in it is
//     written over the solo project
//   - a view link waits for the owner's run, then follows it: it draws the cargo and the cargo moves, while its own
//     store stays stopped and nothing reaches the document; the owner sees how many watch
//   - an editor joining mid-run is offered the run, not taken over, and once it says Watch starts at the same point and
//     follows the owner's view; moving its own camera detaches the view but not the run, and Follow view goes back
//   - the owner's Spotlight takes that editor to the owner's run; the editor can dismiss it, a new spotlight asks again,
//     and Stop spotlight lets everyone go
//   - two people running at once: a view link follows the owner by default and can pick the other run instead
//   - the viewer's own Play replaces the run it follows, and Stop goes back to following
//   - the owner's Stop ends the run for its followers, and Stop sharing closes the project for everyone
//
// Run: node e2e/verify-live-share.mjs [--headed]
/* global process, console, window, document, localStorage, location, navigator, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { docNameFor } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-live-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let collabLog = ''
collab.stderr.on('data', (d) => (collabLog += String(d)))
collab.stdout.on('data', (d) => (collabLog += String(d)))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

const { url: APP_URL } = await startServer({ isolated: true })

const waitForApp = async (page, timeout = 90000) => {
  try {
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout, polling: 500 })
  } catch (err) {
    const seen = await page
      .evaluate(() => ({ hook: Object.keys(window.__oip ?? {}), loading: document.body.className, text: document.body.innerText.slice(0, 300) }))
      .catch((e) => String(e))
    console.log('[stalled tab]', JSON.stringify(seen))
    throw err
  }
}

const joinRoom = async (page, url, bootTimeout) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page, bootTimeout)
  await page.waitForSelector('.collab-status.connected', { timeout: 30000 })
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 30000 })
}

/** what a tab is drawing: run state, and the cargo it last drew by id */
const drawn = (page) =>
  page.evaluate(() => {
    const ec = window.__oip.controller
    const s = window.__oip.store.getState()
    const f = ec.lastFrame
    const at = {}
    if (f) for (let i = 0; i < f.count; i++) at[f.ids[i]] = [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]]
    return { running: s.running, following: s.liveFollowing, count: f?.count ?? 0, simTime: f?.simTime ?? 0, at }
  })

/** the largest distance any body moved between two reads (m) */
const moved = (a, b) => {
  let most = 0
  for (const [id, p] of Object.entries(b.at)) {
    const q = a.at[id]
    if (q) most = Math.max(most, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return most
}

const browser = await chromium.launch({ headless: !HEADED })
const browsers = [browser]
const contexts = []
const newPage = async (own = false) => {
  // `own`: a browser process of its own. Tabs of one browser share its GPU process, and with two of them drawing a
  // run every frame a third one's renderer start was measured at ~70 s on this box.
  let b = browser
  if (own) browsers.push((b = await chromium.launch({ headless: !HEADED })))
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } })
  contexts.push(ctx)
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept())
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || /unavailable|Uncaught|rejection/i.test(m.text())) console.log(`[console ${m.type()}] ${m.text().slice(0, 600)}`)
  })
  return page
}

try {
  // ── the owner: shares the untouched demo from a solo tab, as a user would; Can edit makes the project and enters it ──
  const editor = await newPage()
  await editor.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await editor.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(editor)
  await editor.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 30000 })
  await editor.locator('button.share-button').click()
  const soloProject = await editor.evaluate(async () => {
    window.__noReload = true // a reload would drop it
    return (await window.__oip.savedProject())
  })
  check('the Share popover has no Live switch to turn on', (await editor.locator('[data-testid=share-live-switch]').count()) === 0)
  // a link carries the camera it was copied at, as the visitor's opening view (controller/linkCamera.ts)
  const SHARED_AT = { px: -6.5, py: 8, pz: 11.25, tx: 2, ty: 0.5, tz: -3 }
  await editor.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), SHARED_AT)
  await editor.locator('button.share-option', { hasText: 'Can edit' }).click()
  const EDIT_LINK = await editor.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  check('a copied link carries the camera it was copied at', new URL(EDIT_LINK || 'about:blank').searchParams.get('cam') === '-6.5_8_11.25_2_0.5_-3', EDIT_LINK.replace(/room=[^&]+/, 'room=...'))
  await editor.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 })
  await editor.waitForSelector('.collab-status.connected', { timeout: 30000 })
  check('sharing entered the project in place: no reload', await editor.evaluate(() => window.__noReload === true && new URL(location.href).searchParams.has('room')))
  const afterShare = await editor.evaluate(() => window.__oip.view.cameraPose())
  check("sharing the demo leaves the sharer's camera where it was", ['px', 'py', 'pz', 'tx', 'ty', 'tz'].every((k) => Math.abs(afterShare[k] - SHARED_AT[k]) < 0.05), JSON.stringify(afterShare))
  check("...and the sharer's own address has no camera",!new URL(editor.url()).searchParams.has('cam'), editor.url().replace(/room=[^&]+/, 'room=...'))
  const ROOM = new URL(editor.url()).searchParams.get('room')
  if (!(await editor.locator('.share-popover').isVisible())) await editor.locator('button.share-button').click()
  await editor.locator('button.share-option', { hasText: 'Can view' }).click()
  const copied = await editor.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  check('Can view copies the view link', new URL(copied || 'about:blank').searchParams.get('room') === docNameFor(ROOM), copied)
  if (!(await editor.locator('.share-popover').isVisible())) await editor.locator('button.share-button').click()
  await editor.locator('[data-testid=share-display]').click()
  const forDisplay = new URL((await editor.evaluate(() => navigator.clipboard.readText()).catch(() => '')) || 'about:blank')
  check('For a display copies a view link that opens in Present', forDisplay.searchParams.get('room') === docNameFor(ROOM) && forDisplay.searchParams.get('present') === '1', forDisplay.toString())
  await editor.keyboard.press('Escape')
  const VIEW_URL = `${APP_URL}?room=${docNameFor(ROOM)}&view=1`

  // the owner frames the line somewhere no viewer starts, and then stands still
  await editor.evaluate(() => window.__oip.view.setCameraPose({ px: 4, py: 6, pz: 7, tx: 1, ty: 0, tz: -1 }, { instant: true }))
  const viewer = await newPage()
  await joinRoom(viewer, VIEW_URL)
  const viewerDoc0 = await viewer.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))
  const programs = [await editor.evaluate(() => window.__oip.store.getState().stProgram), await viewer.evaluate(() => window.__oip.store.getState().stProgram)]
  check("the room holds the owner's program, seeded in place", programs[0].length > 100 && programs[0] === programs[1], `${programs[0].length} / ${programs[1].length} chars`)
  await viewer.waitForSelector('[data-testid=live-chip]', { timeout: 15000 }).catch(() => {})
  const waitingText = await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check("before the first run, a view link waits for the owner's", /^Waiting for \S.* to run$/.test(waitingText), waitingText)

  await editor.evaluate(() => window.__oip.controller.run())
  await editor.waitForFunction(() => (window.__oip.controller.lastFrame?.count ?? 0) > 0, undefined, { timeout: 60000 })
  await editor.evaluate(() => {
    const start = window.__oip.store.getState().scene.parts.find((p) => p.name === 'Start')
    if (start) window.__oip.controller.sim.usePart(start.id)
  })

  // ── the view link follows it ──
  await viewer.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  const v0 = await drawn(viewer)
  check("the view link follows the owner's run", v0.following, JSON.stringify({ following: v0.following, count: v0.count }))
  check('the viewer runs nothing of its own (its store stays stopped)', !v0.running)
  await viewer.waitForTimeout(4000)
  const v1 = await drawn(viewer)
  const e1 = await drawn(editor)
  check("the viewer draws the run's cargo", v1.count > 50 && Math.abs(v1.count - e1.count) < 20, `viewer ${v1.count}, editor ${e1.count}`)
  check('the cargo the viewer draws moves', moved(v0, v1) > 0.2, `${moved(v0, v1).toFixed(2)} m`)
  check('the viewer plays close behind the owner', e1.simTime - v1.simTime < 1.5 && v1.simTime > 0, `editor ${e1.simTime.toFixed(2)} s, viewer ${v1.simTime.toFixed(2)} s`)
  check('the chip says whose run the viewer is watching', /^Watching \S/.test(await viewer.locator('[data-testid=live-chip]').innerText()))
  // the owner's camera has stood still since the viewer joined: no change brings it, and the viewer still takes it
  const [ownerLook, viewerCam] = [await editor.evaluate(() => window.__oip.view.lookPose()), await viewer.evaluate(() => window.__oip.view.cameraPose())]
  check("the viewer is at the owner's view, though it has not moved since", Math.max(...['px', 'py', 'pz', 'tx', 'ty', 'tz'].map((k) => Math.abs(ownerLook[k] - viewerCam[k]))) < 0.05, JSON.stringify({ ownerLook, viewerCam }))
  const counters = await viewer.evaluate(() => window.__oip.controller.plcGlobalTags)
  const editorCases = await editor.evaluate(() => window.__oip.controller.plcGlobalTags?.['Main.Cases'] ?? window.__oip.controller.plcGlobalTags?.Cases)
  const viewerCases = counters?.['Main.Cases'] ?? counters?.Cases
  check("the viewer reads the owner's PLC variables, so a counter on a note is not blank", typeof viewerCases === 'number' && Math.abs(viewerCases - editorCases) <= 2, `viewer ${viewerCases}, editor ${editorCases}`)
  // a viewer's Watch shows the followed run's values (WatchPanel.tsx), read only: the run is someone else's
  await viewer.evaluate(() => window.__oip.store.revealPanel('watch'))
  await viewer.locator('[data-testid=plc-watch-add-name]').fill('Cases')
  await viewer.locator('[data-testid=plc-watch-add-name]').press('Enter')
  await viewer.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-testid=plc-watch-row] [data-testid=plc-watch-value]')?.textContent?.trim() ?? ''), undefined, { timeout: 10000 }).catch(() => {})
  const viewerWatch = await viewer.evaluate(() => ({
    value: document.querySelector('[data-testid=plc-watch-row] [data-testid=plc-watch-value]')?.textContent?.trim() ?? '',
    writable: document.querySelector('[data-testid=plc-watch-row] [data-testid=plc-watch-write]') !== null,
  }))
  check("a viewer's Watch shows the followed run's values, read only", /^\d+$/.test(viewerWatch.value) && !viewerWatch.writable, JSON.stringify(viewerWatch))
  // a locked display (a display link's Present): a visitor may move the camera; a button goes back to the followed view,
  // and the screen goes back by itself after half a minute untouched
  await viewer.evaluate(() => window.__oip.store.setState({ presenting: true, presentLocked: true }))
  await viewer.waitForTimeout(1500)
  const moveAway = () => viewer.evaluate(() => window.__oip.view.setCameraPose({ px: -9, py: 3, pz: -9, tx: 0, ty: 0, tz: 0 }, { instant: true }))
  await moveAway()
  await viewer.waitForSelector('[data-testid=present-back]', { timeout: 5000 }).catch(() => {})
  const backText = await viewer.locator('[data-testid=present-back]').innerText().catch(() => '')
  check('a display moved by a visitor offers a way back to the followed view', /^Back to \S+'s view$/.test(backText), backText)
  await viewer.locator('[data-testid=present-back]').click()
  await viewer.waitForTimeout(500)
  check('...which goes back to following it', !(await viewer.evaluate(() => window.__oip.store.getState().liveViewDetached)) && (await viewer.locator('[data-testid=present-back]').count()) === 0)
  await viewer.waitForTimeout(1000)
  await moveAway()
  await viewer.waitForFunction(() => window.__oip.store.getState().liveViewDetached, undefined, { timeout: 5000 }).catch(() => {})
  const movedAway = await viewer.evaluate(() => window.__oip.store.getState().liveViewDetached)
  await viewer.waitForFunction(() => !window.__oip.store.getState().liveViewDetached, undefined, { timeout: 45000, polling: 1000 }).catch(() => {})
  check('...and left alone, it goes back by itself within half a minute', movedAway && !(await viewer.evaluate(() => window.__oip.store.getState().liveViewDetached)))
  await viewer.evaluate(() => window.__oip.store.setState({ presenting: false, presentLocked: false }))
  await editor.waitForFunction(() => /1 watching/i.test(document.querySelector('[data-testid=live-chip]')?.textContent ?? ''), undefined, { timeout: 10000 }).catch(() => {})
  const sharerChip = await editor.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check('the owner sees how many are watching, and is offered Spotlight', /1 watching/i.test(sharerChip) && (await editor.locator('[data-testid=spotlight-start]').count()) === 1, sharerChip)
  await viewer.locator('[data-testid=presence]').click()
  const people = await viewer.locator('[data-testid=people-list]').innerText().catch(() => '')
  check('the people list says who is running and who is watching whom', /running/.test(people) && /watching /.test(people), people.replace(/\n/g, ' | '))
  await viewer.keyboard.press('Escape')
  const viewerMenu = await viewer.locator('.project-menu').first().innerText().catch(() => '')
  check('the viewer sees what it is in by name, not as a room', viewerMenu.trim() === 'Palletizing demo', viewerMenu)

  // ── an editor joining mid-run is offered the run, and starts at the same point once it says Watch ──
  await editor.waitForTimeout(3000)
  const late = await newPage(true)
  // through the link the owner copied, which opens where the owner was looking then, not where they look now
  const lateLink = new URL(`${APP_URL}?room=${ROOM}`)
  lateLink.searchParams.set('cam', new URL(EDIT_LINK || 'about:blank').searchParams.get('cam') ?? '')
  await joinRoom(late, lateLink.toString(), 180000)
  await late.waitForSelector('[data-testid=live-chip]', { timeout: 20000 }).catch(() => {})
  await late.waitForTimeout(1500)
  const opened = await late.evaluate(() => window.__oip.view.cameraPose())
  check('a link opens on the camera it carries', ['px', 'py', 'pz', 'tx', 'ty', 'tz'].every((k) => Math.abs(opened[k] - SHARED_AT[k]) < 0.05), JSON.stringify(opened))
  check('...which then leaves the address, and is filed as this room\'s camera', await late.evaluate((p) => {
    if (new URL(location.href).searchParams.has('cam')) return false
    const slots = JSON.parse(localStorage.getItem('oip-web/viewport-state') ?? '[]')
    return slots.some((s) => s.key.startsWith('@room:') && Math.abs(s.pose.px - p.px) < 0.05 && Math.abs(s.pose.tz - p.tz) < 0.05)
  }, SHARED_AT))
  const offered = await late.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check('an editor is offered the run, not taken over by it', !(await drawn(late)).following && /is running · Watch$/.test(offered), offered)
  await late.locator('[data-testid=live-chip]').click()
  await late.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  await late.waitForTimeout(1500)
  const l = await drawn(late)
  const e2 = await drawn(editor)
  check('after Watch, the editor follows the run at once', l.following && l.count > 50 && Math.abs(l.count - e2.count) < 20, `late ${l.count}, editor ${e2.count}`)
  check('the late editor is at the same point in the run', e2.simTime - l.simTime < 1.5, `editor ${e2.simTime.toFixed(2)} s, late ${l.simTime.toFixed(2)} s`)
  // ── following someone follows their view too, until one's own camera moves (controller/liveCamera.ts) ──
  const camOf = (page) => page.evaluate(() => window.__oip.view.cameraPose())
  const setCam = (page, pose) => page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), pose)
  const near = (a, b) => Math.max(...['px', 'py', 'pz', 'tx', 'ty', 'tz'].map((k) => Math.abs(a[k] - b[k]))) < 0.05
  const P1 = { px: 6, py: 5, pz: 9, tx: 1, ty: 0.5, tz: 0 }
  await setCam(editor, P1)
  await late.waitForFunction((p) => { const c = window.__oip.view.cameraPose(); return Math.abs(c.px - p.px) < 0.05 && Math.abs(c.pz - p.pz) < 0.05 }, P1, { timeout: 10000 }).catch(() => {})
  check("the follower's camera follows the owner's view", near(await camOf(late), P1), JSON.stringify(await camOf(late)))
  const P2 = { px: -8, py: 4, pz: -6, tx: 0, ty: 0, tz: 0 }
  await setCam(late, P2)
  await late.waitForSelector('[data-testid=follow-view]', { timeout: 5000 }).catch(() => {})
  check('moving its own camera detaches the view, and the chip offers Follow view', (await late.evaluate(() => window.__oip.store.getState().liveViewDetached)) && (await late.locator('[data-testid=follow-view]').count()) === 1)
  check('...while it still follows the run', (await drawn(late)).following)
  const P3 = { px: 3, py: 8, pz: 4, tx: 2, ty: 0, tz: 1 }
  await setCam(editor, P3)
  await late.waitForTimeout(1500)
  check("a detached view stays where it was put", near(await camOf(late), P2), JSON.stringify(await camOf(late)))
  await late.locator('[data-testid=follow-view]').click()
  await late.waitForFunction((p) => { const c = window.__oip.view.cameraPose(); return Math.abs(c.px - p.px) < 0.05 && Math.abs(c.pz - p.pz) < 0.05 }, P3, { timeout: 10000 }).catch(() => {})
  check("Follow view goes back to the owner's view", near(await camOf(late), P3) && (await late.locator('[data-testid=follow-view]').count()) === 0, JSON.stringify(await camOf(late)))
  // the owner walks in pilot mode and turns: the follower faces where the owner looks, not the orbit point left behind
  const facing = (page) =>
    page.evaluate(() => {
      const c = window.__oip.view.camera
      const d = c.getWorldDirection(new c.position.constructor())
      return Math.atan2(d.x, d.z)
    })
  await editor.evaluate(() => window.__oip.store.enterPilot())
  await editor.waitForFunction(() => window.__oip.view.isNavigating(), undefined, { timeout: 10000 }).catch(() => {})
  await editor.evaluate(() => window.__oip.view.pilot.turn(Math.PI / 2))
  await editor.waitForTimeout(400)
  await editor.evaluate(() => window.__oip.view.pilot.turn(Math.PI / 2))
  await late.waitForTimeout(2500)
  const [ownerYaw, lateYaw] = [await facing(editor), await facing(late)]
  const yawGap = Math.abs(Math.atan2(Math.sin(ownerYaw - lateYaw), Math.cos(ownerYaw - lateYaw)))
  check('in pilot mode the follower faces where the owner looks', yawGap < 0.15, `owner ${ownerYaw.toFixed(2)} rad, follower ${lateYaw.toFixed(2)} rad`)
  await editor.evaluate(() => window.__oip.store.exitPilot())
  await late.locator('.live-chip-stop').click()
  await late.waitForTimeout(500)
  check('Stop watching takes the editor back to the design', !(await drawn(late)).following)
  check('a non-owner is offered no Spotlight anywhere', (await late.locator('[data-testid=spotlight-start], [data-testid=people-spotlight]').count()) === 0)

  // ── the owner's spotlight ──
  await editor.locator('[data-testid=spotlight-start]').click()
  await late.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  const lit = await late.locator('[data-testid=live-chip]').innerText().catch(() => '')
  check("the spotlight takes the editor to the owner's run", (await drawn(late)).following && /^Watching \S+ \(spotlight\)/.test(lit), lit)
  check('the owner sees the spotlight on, with a Stop', /spotlight/i.test(await editor.locator('[data-testid=live-chip]').innerText()) && (await editor.locator('[data-testid=spotlight-stop]').count()) === 1)
  await late.locator('.live-chip-stop').click()
  await late.waitForTimeout(500)
  check('the editor can dismiss the spotlight', !(await drawn(late)).following)
  await editor.locator('[data-testid=spotlight-stop]').click()
  await editor.waitForSelector('[data-testid=spotlight-start]', { timeout: 10000 }).catch(() => {})
  await editor.locator('[data-testid=spotlight-start]').click()
  await late.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 20000 }).catch(() => {})
  check('a new spotlight asks again', (await drawn(late)).following)
  await editor.locator('[data-testid=spotlight-stop]').click()
  await late.waitForFunction(() => !window.__oip.store.getState().liveFollowing, undefined, { timeout: 10000 }).catch(() => {})
  check('Stop spotlight lets everyone go back', !(await drawn(late)).following)

  // ── two people running at once ──
  await late.evaluate(() => window.__oip.controller.run())
  await late.waitForFunction(() => (window.__oip.controller.lastFrame?.count ?? 0) > 0, undefined, { timeout: 60000 })
  await viewer.waitForTimeout(2000)
  {
    const [v, o, n] = [await drawn(viewer), await drawn(editor), await drawn(late)]
    check("with two running, the view link stays on the owner's run", v.following && Math.abs(o.simTime - v.simTime) < 1.5 && v.simTime - n.simTime > 3, `viewer ${v.simTime.toFixed(2)} s, owner ${o.simTime.toFixed(2)} s, other ${n.simTime.toFixed(2)} s`)
  }
  await viewer.locator('[data-testid=presence]').click()
  const watchButtons = viewer.locator('[data-testid=people-watch]')
  check('the people list offers Watch beside both runs', (await watchButtons.count()) === 2, String(await watchButtons.count()))
  // the late editor's row: the one not being watched now
  await viewer.locator('[data-testid=people-watch]:not(.on)').first().click()
  await viewer.waitForTimeout(3000)
  const vl = await drawn(viewer)
  const ll = await drawn(late)
  const el = await drawn(editor)
  check("the viewer picked the other run: it is at that run's point, not the owner's", vl.following && Math.abs(ll.simTime - vl.simTime) < 1.5 && el.simTime - vl.simTime > 3, `viewer ${vl.simTime.toFixed(2)} s, late ${ll.simTime.toFixed(2)} s, owner ${el.simTime.toFixed(2)} s`)
  await late.evaluate(() => window.__oip.controller.stop())
  await viewer.waitForFunction(() => /^Waiting for/.test(document.querySelector('[data-testid=live-chip]')?.textContent ?? ''), undefined, { timeout: 10000 }).catch(() => {})
  check('when the picked run stops, the viewer waits for that person', /^Waiting for/.test(await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')))
  await viewer.locator('.live-chip-stop').click()
  await viewer.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 15000 }).catch(() => {})
  check("unpicking goes back to the owner's run", (await drawn(viewer)).following)

  // ── the viewer's own Play replaces the run it follows; Stop goes back to following ──
  await viewer.evaluate(() => window.__oip.controller.run())
  await viewer.waitForFunction(() => window.__oip.store.getState().running, undefined, { timeout: 20000 })
  const own = await drawn(viewer)
  check("the viewer's Play runs its own copy and stops following", own.running && !own.following)
  await viewer.waitForTimeout(1500)
  await viewer.evaluate(() => window.__oip.controller.stop())
  await viewer.waitForFunction(() => window.__oip.store.getState().liveFollowing, undefined, { timeout: 15000 }).catch(() => {})
  check("after the viewer's Stop it follows the owner's run again", (await drawn(viewer)).following)

  // ── the owner's Stop ends the run for its followers; a view link waits for the owner, though someone else runs ──
  await late.evaluate(() => window.__oip.controller.run())
  await late.waitForFunction(() => window.__oip.store.getState().running, undefined, { timeout: 30000 })
  await editor.evaluate(() => window.__oip.controller.stop())
  await viewer.waitForFunction(() => !window.__oip.store.getState().liveFollowing, undefined, { timeout: 10000 }).catch(() => {})
  check("Stop on the owner ends the run for its followers", !(await drawn(viewer)).following)
  await viewer.waitForTimeout(2000)
  check("...and the view link waits for the owner rather than jumping to another editor's run", !(await drawn(viewer)).following && /^Waiting for/.test(await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')))
  await late.evaluate(() => window.__oip.controller.stop())
  check('the view is back to the design after the run (no cargo drawn from it)', (await viewer.evaluate(() => window.__oip.controller.lastFrame)) === null)
  check('...and the view link waits for the next run', /^Waiting for/.test(await viewer.locator('[data-testid=live-chip]').innerText().catch(() => '')))
  const viewerDoc1 = await viewer.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))
  check("the run never reached the viewer's document", viewerDoc0 === viewerDoc1)
  check('the server refused nothing', !/\[(live|room)\] refused/.test(collabLog), collabLog.match(/\[(live|room)\].*/)?.[0] ?? '')
  // an edit in the room goes to the room, never to the solo project the tab came from
  await editor.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Add part', { ...s, parts: [...s.parts, { id: 'room_only', type: 'group', position: [0, 0.75, 0], rotationY: 0, params: {} }] })
  })
  await editor.waitForTimeout(1500)
  check('nothing done in the room was written over the solo project', (await editor.evaluate(async () => (await window.__oip.savedProject()))) === soloProject)
  check('...and the edit reached the room', await viewer.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'room_only')))
  // the shared demo is owned by whoever shared it: they can stop sharing it, which closes it for everyone
  await editor.locator('button.share-button').click()
  await editor.locator('[data-testid=share-stop-sharing]').click()
  // the viewer is watched from the moment it closes: its notice says why for 8 s (NoticeToast), and the owner's own
  // reload, checked first, can take longer than that
  const viewerTold = viewer
    .waitForFunction(() => !new URL(location.href).searchParams.has('room') && /shared project was closed/.test(document.body.innerText), undefined, { timeout: 60000, polling: 200 })
    .then(() => true, () => false)
  await editor.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(editor)
  check("Stop sharing the demo goes back to the demo on one's own", await editor.evaluate(() => !window.__oip.store.getState().collab && new URL(location.href).searchParams.get('scene') === 'demo'))
  check('...and the viewer is sent back, told it was closed', await viewerTold)
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  for (const c of contexts) await c.close().catch(() => {})
  for (const b of browsers) await b.close().catch(() => {})
  collab.kill()
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
