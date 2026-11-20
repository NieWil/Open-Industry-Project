// End-to-end check: a saved document's snapshot of a built-in part never draws, even for a moment.
//
// A saved scene embeds the package of every part it places, first-party ones included, and loading it registers each
// snapshot unless its id is already the live one. If bundled parts were registered in the viewport effect, after the
// saved project has loaded and the viewport has drawn it, a snapshot saved by an older build would draw first, fetch
// its assets, and be replaced a moment later: with the sensors drawn in code, every saved scene with a Diffuse Sensor
// would request the retired DiffuseSensor.glb on each load until it was saved again.
// registerBundledPackages (main.tsx bootSolo) registers them first; this checks that, and that a user's fork of a
// built-in part still takes precedence, as it must.
//
// Two stored projects, one reload each: the demo's Diffuse Sensor snapshot turned into the pre-code package (a GLB
// housing link, a marker name), then the same with that package also in the project's authored library (a fork).
//
// Run: node e2e/verify-solo-stale-builtin.mjs [--headed]
/* global process, console */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const ID = 'oip.diffuse-sensor'
const STALE = 'Diffuse Sensor (stale saved snapshot)'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const { url: APP_URL, vite } = await startServer()
/** the sensor is in the scene, the viewport is up and its assets have loaded (a positive signal: before the view
 *  exists there is no assetsBusy, and an early read sees the boot half-done) */
const waitForSensor = (page) =>
  page.waitForFunction(
    (id) => {
      const o = window.__oip
      return !!o?.store?.getState().scene.parts.some((p) => p.packageId === id) && !!o.view && typeof o.assetsBusy === 'function' && !o.assetsBusy()
    },
    ID,
    { timeout: 120000 },
  )
/** what this client uses for the sensor, what the saved project now holds for it, and whether the scene settled */
const inspect = (page) =>
  page.evaluate(
    async ({ id }) => {
      const pkg = window.__oip.getPackage(id)
      const raw = (await window.__oip.savedProject())
      const project = raw ? JSON.parse(raw) : null
      // a format-4 project holds its scene at the top level; an older one (as planted below, before the boot rewrites it) listed them
      const scene = project?.scene ?? project?.scenes?.[project.activeScene ?? 0]?.scene
      const saved = scene?.packages?.find((p) => p.id === id)
      const own = project?.packages?.find((p) => p.id === id)
      return {
        live: pkg?.name ?? null,
        liveMesh: (pkg?.geometry?.links ?? []).some((l) => l.shape?.kind === 'mesh'),
        saved: saved?.name ?? null,
        library: own ? { name: own.name, stamped: typeof own.origin?.app === 'string' } : null,
      }
    },
    { id: ID },
  )

/** give the stored project a pre-code copy of the sensor, as a document saved by an older build holds one: in the
 *  scene's copies (project format 2 kept one per placed part, with no record of where it came from), and with `fork`
 *  also in the authored library. Without `fork` the library has no copy of the sensor, as a format-2 library had none:
 *  the copy the current format keeps there (core/project/project.ts keepDefinitionsOnce) is taken out first */
const plant = (page, fork) =>
  page.evaluate(
    async ({ id, stale, fork }) => {
      const raw = (await window.__oip.savedProject())
      if (!raw) return 'no stored project'
      const stored = JSON.parse(raw)
      // the stored project holds one scene at its top level (format 4 and later); an older build saved a list of scenes, so the
      // planted document is a format-2 one holding this project as its only scene
      const { version: _v, name, scene, packages, tests, assemblies, ...machine } = stored
      if (!scene) return `the stored project does not hold its scene at its top level (version ${stored.version})`
      if (!scene.parts.some((p) => p.packageId === id)) return 'no sensor placed in the stored scene'
      const project = {
        version: 2,
        name,
        activeScene: 0,
        scenes: [{ id: 'main', name: 'Main', scene, ...machine }],
        ...(packages ? { packages: packages.filter((p) => p.id !== id) } : {}),
        ...(tests ? { tests } : {}),
        ...(assemblies ? { assemblies } : {}),
      }
      const live = window.__oip.store.getState().bundledPackages.find((p) => p.id === id)
      if (!live) return 'no built-in sensor to copy'
      const pkg = JSON.parse(JSON.stringify(live))
      scene.packages = [...(scene.packages ?? []).filter((p) => p.id !== id), pkg]
      pkg.name = stale
      // idempotent: a snapshot the boot did not refresh already has the housing, and a second link of that name is an
      // invalid package (loading correctly drops it from the library, which would look like the fork being ignored)
      pkg.geometry.links = [
        { name: 'housing', shape: { kind: 'mesh', asset: 'glb', fitHeight: 0.16 }, offset: [0, 0, 0] },
        ...pkg.geometry.links.filter((l) => l.name !== 'housing'),
      ]
      pkg.assets = [{ id: 'glb', mime: 'model/gltf-binary', url: '/models/DiffuseSensor.glb' }]
      if (fork) project.packages = [...(project.packages ?? []).filter((p) => p.id !== id), JSON.parse(JSON.stringify(pkg))]
      localStorage.setItem('oip-web/project', JSON.stringify(project))
      return 'ok'
    },
    { id: ID, stale: STALE, fork },
  )

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  let oldModel = 0
  page.on('request', (r) => r.url().includes('DiffuseSensor.glb') && oldModel++)
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))

  // a saved project that places Diffuse Sensors: the demo, made the user's own project ("Palletizing demo", a fork
  // of it) by one persisting edit
  await page.goto(`${APP_URL}?scene=demo`, { timeout: 180000 })
  await waitForSensor(page)
  await page.evaluate((id) => {
    // a real edit (an unchanged scene is no document change): it forks the demo into the user's own saved scene
    const st = window.__oip.store
    const scene = st.getState().scene
    const eye = scene.parts.find((p) => p.packageId === id)
    st.commit('Move part', { ...scene, parts: scene.parts.map((p) => (p === eye ? { ...p, position: [p.position[0] + 0.01, p.position[1], p.position[2]] } : p)) })
    st.persistProject()
  }, ID)

  // --- 1. a stale snapshot: this build's sensor is used from the first frame, and the save drops the snapshot
  check('planted a pre-code sensor snapshot in the saved project', (await plant(page, false)) === 'ok')
  oldModel = 0
  await page.goto(`${APP_URL}`, { timeout: 180000 })
  await waitForSensor(page)
  const snap = await inspect(page)
  check("the saved snapshot's old model is never requested", oldModel === 0, `${oldModel} request(s) for DiffuseSensor.glb`)
  check("this build's sensor is the one registered", snap.live !== STALE && !snap.liveMesh, JSON.stringify(snap))
  // the scene keeps no copies; the project's own copy is this build's sensor, stamped as such
  check('the save dropped the stale snapshot from the scene', snap.saved === null, `saved: ${snap.saved}`)
  check("...and the project's own copy is this build's sensor, recorded as copied from it", !!snap.library && snap.library.name !== STALE && snap.library.stamped, JSON.stringify(snap.library))

  // --- 2. the same package as the user's fork (in the project's authored library): the fork takes precedence, by design
  check('planted the pre-code sensor as a fork in the library', (await plant(page, true)) === 'ok')
  await page.goto(`${APP_URL}`, { timeout: 180000 })
  await waitForSensor(page)
  const fork = await inspect(page)
  check("a user's fork of a built-in part still wins", fork.live === STALE && fork.liveMesh, JSON.stringify(fork))
} finally {
  await browser.close()
  vite.kill()
}
process.exit(failures ? 1 : 0)
