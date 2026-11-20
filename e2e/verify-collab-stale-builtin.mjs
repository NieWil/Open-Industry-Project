// End-to-end check: a room's copy of a built-in part is a snapshot, and loses to the part this build ships.
//
// A room holds the package of every part placed in it, first-party ones included, so the definition travels with
// the scene. For a built-in part that copy is only a snapshot of whatever build placed it. The bug this guards: if
// the room's packages are applied before this client loads its own bundled parts, the snapshot registers first and
// is filed as the user's fork, which the bundled loader never overwrites. Every room made before a built-in part
// changed would then show the old part to every client, forever; for example, an old room would fetch the retired
// DiffuseSensor.glb for a sensor housing that is now drawn in code.
//
// This plants exactly that: a room seeded the way an older build seeded one, by the app's own seeding code
// (collab/provider.ts seedIfEmpty) with the demo whose Diffuse Sensor copy is the pre-code package (a GLB housing link, a
// marker name), and asserts that neither its first visitor nor a later joiner with no local state uses it: the bundled
// part is what is registered, it is no fork, and the old model is never requested. The unit-level rule (and its fork counterpart: an edited entry
// does win) is collabBridge.test.ts.
//
// Run: node e2e/verify-collab-stale-builtin.mjs [--headed]
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { editSecret } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')
const ID = 'oip.diffuse-sensor'
const STALE = 'Diffuse Sensor (stale room snapshot)'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-stale-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// isolated: VITE_COLLAB_URL is read by the dev server's config, so a shared server would point at the wrong room server
const { url: APP_URL, vite } = await startServer({ isolated: true })
// a room an older build seeded, holding its copy of the sensor
const ROOM = editSecret(`verify-stale-builtin-${collabPort}`)

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 30000 })
const waitForSensor = (page) =>
  page.waitForFunction((id) => window.__oip.store.getState().scene.parts.some((p) => p.packageId === id), ID, { timeout: 30000 })
/** what this client actually uses for the sensor, and whether it counts it as the user's own fork */
const live = (page) =>
  page.evaluate((id) => {
    const pkg = window.__oip.getPackage(id)
    return {
      name: pkg?.name ?? null,
      meshLinks: (pkg?.geometry?.links ?? []).filter((l) => l.shape?.kind === 'mesh').length,
      fork: window.__oip.store.getState().userPackages.some((p) => p.id === id),
    }
  }, ID)

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  const oldModel = { A: 0, B: 0 }
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('request', (r) => r.url().includes('DiffuseSensor.glb') && oldModel[tag]++)
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
  }

  // --- an older build seeds the room: the demo (it has Diffuse Sensors), its sensor copy the old package
  // a fresh server (isolated, above) transforms the whole module graph on the first load: give it the time the other
  // cold-server gates do, not Playwright's 30 s default
  await a.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(a)
  const planted = await a.evaluate(
    async ({ room, id, stale }) => {
      const [{ connectRoom, seedIfEmpty }, { resolveRoom }, demos] = await Promise.all([
        import('/src/collab/provider.ts'),
        import('/src/collab/rooms.ts'),
        import('/src/editor/demo/demoScenes.ts'),
      ])
      const scene = demos.createPlcDemoScene()
      const pkg = (scene.packages ?? []).find((p) => p.id === id)
      if (!pkg) return 'the demo embeds no sensor'
      const old = JSON.parse(JSON.stringify(pkg))
      old.name = stale
      old.geometry.links = [{ name: 'housing', shape: { kind: 'mesh', asset: 'glb', fitHeight: 0.16 }, offset: [0, 0, 0] }, ...old.geometry.links]
      old.assets = [{ id: 'glb', mime: 'model/gltf-binary', url: '/models/DiffuseSensor.glb' }]
      const { ydoc, whenSynced, serverSynced, provider } = connectRoom(await resolveRoom(room, false))
      await whenSynced
      if (!serverSynced()) return 'the planting client never reached the collab server'
      const seededNow = seedIfEmpty(ydoc, { ...scene, packages: scene.packages.map((p) => (p.id === id ? old : p)) }, demos.DEMO_PROGRAM)
      await new Promise((r) => setTimeout(r, 1500)) // let the write reach the server before the page moves on
      provider.destroy()
      return seededNow ? 'ok' : 'the room was not empty'
    },
    { room: ROOM, id: ID, stale: STALE },
  )
  check("planted a room an older build seeded, with the pre-code sensor copy", planted === 'ok', planted)
  oldModel.A = 0 // count from the room on

  // --- A opens the room: its first visitor
  await a.goto(`${APP_URL}?room=${ROOM}`, { timeout: 180000 })
  await waitForApp(a)
  await waitForSensor(a)
  const seeded = await a.evaluate(
    ({ id, stale }) => (window.__oip.store.getState().scene.packages ?? []).some((p) => p.id === id && p.name === stale),
    { id: ID, stale: STALE },
  )
  check('the room really holds the stale snapshot (else this gate proves nothing)', seeded)
  const first = await live(a)
  check("its first visitor uses this build's sensor, not the room's snapshot", first.name !== STALE && first.meshLinks === 0, JSON.stringify(first))
  check('...and does not count the snapshot as its own fork', !first.fork)

  // --- B joins cold: the room is its only source, and its own build's part is still used
  await b.goto(`${APP_URL}?room=${ROOM}`, { timeout: 180000 })
  await waitForApp(b)
  await waitForSensor(b)
  const joiner = await live(b)
  check("a joiner uses this build's sensor, not the room's snapshot", joiner.name !== STALE && joiner.meshLinks === 0, JSON.stringify(joiner))
  check('a joiner does not count the snapshot as a fork', !joiner.fork)

  // let any late mesh load land before counting what was fetched
  await a.waitForTimeout(3000)
  check('nobody fetched the retired model', oldModel.A === 0 && oldModel.B === 0, `first visitor ${oldModel.A}, joiner ${oldModel.B}`)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}
process.exit(failures ? 1 : 0)
