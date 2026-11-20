// Older project documents in the real app: a format-3 document (a scene naming built-ins by id, no copies) and a
// format-2 one can still be read, and convert to the current format: a project holds one scene, at the top level of
// the document, carries no copies in the scene, and keeps its own copy of every part it uses, built-ins
// included, each stamped with the version it was copied at (core/project/project.ts keepDefinitionsOnce, docs/part-sources.md).
// Format-2 project scenes embed a copy of every placed part's package: a snapshot of whatever build saved it, with no
// record of where it came from, so it can never be told apart from an edit.
//
// Checked through the stored project (localStorage, what the app writes and reads on every boot):
//   A. a one-scene format-3 project with no copies opens: the live scene gets its copies back (store applyProject),
//      so the sim worker can build it, and a free-running spawner spawns boxes;
//   B. an edit saves it as the current format (6): the scene at the top level, no copies in it, and the spawner the project's own
//      copy in the library, the app's current version, stamped `origin.app` with its fingerprint;
//   C. a format-2 document carrying a stale copy of a built-in (a snapshot, no `origin`) opens on the app's own
//      built-in, and saving it keeps the app's current version as the project's copy, never the snapshot, which
//      would freeze the part at a version nothing could ever report as out of date (the v1 placed-part-freeze bug);
//   D. a multi-scene format-3 document splits on read: the scene that was active is the project (keeping its name),
//      and every other scene becomes a project of its own, "<project> - <scene>", filed into the projects list
//      (IndexedDB) at that same boot with a "Split into projects" notice; the kept project saves as the current format (6).
//
//   node e2e/verify-project-format3.mjs [--headed]
/* global window, localStorage, indexedDB, console, process */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { readFileSync } from 'node:fs'

// The format a save writes today, read from the source so a format bump doesn't break this gate.
const CURRENT = Number(/export const PROJECT_VERSION = (\d+)/.exec(readFileSync(new globalThis.URL('../src/core/project/project.ts', import.meta.url), 'utf8'))?.[1])
if (!(CURRENT >= 6)) throw new Error('could not read PROJECT_VERSION from src/core/project/project.ts')

const { port, vite } = await startServer()
const URL = `http://localhost:${port}/app/`
const PROJECT_KEY = 'oip-web/project' // src/editor/project/projectFile.ts
const SPAWNER = 'oip.box-spawner'
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
let harness = null

const spawner = { id: 'sp_1', type: 'part', packageId: SPAWNER, name: 'Feeder', position: [0, 2.2, 0], rotationY: 0, params: { boxesPerMinute: 600, fixedRate: true, disable: false } }
const project = (version, scenePackages) => ({
  version,
  name: 'Format probe',
  activeScene: 0,
  scenes: [{ id: 'main', name: 'Main', scene: { version: 4, parts: [spawner], ...(scenePackages ? { packages: scenePackages } : {}) } }],
})
/** a format-3 document holding three scenes, the second one active; each scene's spawner is named after its scene */
const PROGRAM = 'VAR q : BOOL; END_VAR\nq := TRUE;\n'
const multi = () => ({
  version: 3,
  name: 'Split probe',
  activeScene: 1,
  scenes: ['Infeed', 'Sorter', 'Palletizer'].map((name, i) => ({
    id: `s${i}`,
    name,
    scene: { version: 4, parts: [{ ...spawner, name: `${name} feeder` }] },
    ...(i === 2 ? { stProgram: PROGRAM } : {}),
  })),
})

/** every document in the projects list (IndexedDB 'oip-web': docIndex + docPayload, src/editor/project/documentStore.ts) */
const library = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('docIndex')) {
            db.close()
            return resolve([])
          }
          const tx = db.transaction(['docIndex', 'docPayload'], 'readonly')
          const index = tx.objectStore('docIndex').getAll()
          const payloads = tx.objectStore('docPayload').getAll()
          tx.oncomplete = () => {
            db.close()
            resolve(
              index.result.map((meta) => {
                const doc = ((r) => r && (r.project ?? JSON.parse(r.text)))(payloads.result.find((p) => p.id === meta.id))
                return {
                  name: meta.name,
                  version: doc?.version,
                  scenes: doc?.scenes === undefined ? null : doc.scenes.length,
                  parts: (doc?.scene?.parts ?? []).map((p) => p.name),
                  program: doc?.stProgram ?? '',
                }
              }),
            )
          }
        }
      }),
  )

async function boot(doc) {
  await page.goto(URL, { timeout: 180000 })
  await page.evaluate(
    async ([key, d]) => {
      // a clean slate: no projects list from an earlier step (D counts what the split files)
      await new Promise((resolve) => {
        const del = indexedDB.deleteDatabase('oip-web')
        del.onsuccess = del.onerror = del.onblocked = () => resolve()
      })
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
      localStorage.setItem(key, JSON.stringify(d))
    },
    [PROJECT_KEY, doc],
  )
  await page.reload({ timeout: 180000 })
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
}
const live = () =>
  page.evaluate((id) => {
    const s = window.__oip.store.getState()
    return {
      parts: s.scene.parts.map((p) => p.id),
      copy: (s.scene.packages ?? []).find((p) => p.id === id) ?? null,
      app: window.__oip.getPackage(id) ?? null,
      builtIn: s.bundledPackages.find((p) => p.id === id) ?? null,
    }
  }, SPAWNER)
/** an edit, so the app saves the project, then what it saved */
const editAndRead = async () => {
  await page.evaluate(() => window.__oip.store.rename('sp_1', `Feeder ${Date.now()}`))
  await page.waitForTimeout(500)
  return page.evaluate(async () => JSON.parse((await window.__oip.savedProject()) ?? 'null'))
}
const oneScene = (doc) => doc?.version === CURRENT && doc.scenes === undefined && doc.activeScene === undefined && Array.isArray(doc.scene?.parts)

try {
  // ── A. a one-scene format-3 project, no copies anywhere ─────────────────────────────────────────
  await boot(project(3))
  const a = await live()
  check('A  a format-3 project with no copies opens, its part in the scene', a.parts.includes('sp_1'), JSON.stringify(a.parts))
  check('A  the live scene got its copy back, the app\'s own', !!a.copy && !!a.builtIn && a.copy.behavior === a.builtIn.behavior)
  await page.evaluate(() => window.__oip.controller.run())
  const spawned = await page
    .waitForFunction(() => (window.__oip.controller.boxCount ?? 0) > 0, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  check('A  ...and the sim builds it: the spawner spawns boxes', spawned, `boxCount=${await page.evaluate(() => window.__oip.controller.boxCount)}`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(500)
  const noSplit = await library()
  check('A  a one-scene document splits nothing off', !noSplit.some((x) => x.name.startsWith('Format probe - ')), JSON.stringify(noSplit.map((x) => x.name)))

  // ── B. saved: the current format, no copies in the scene, the spawner the project's own ───────────────────
  const saved = await editAndRead()
  check(`B  an edit saves it as format ${CURRENT}, the one scene at the top level`, oneScene(saved), JSON.stringify({ version: saved?.version, keys: Object.keys(saved ?? {}) }))
  check('B  ...with no copy in the scene', saved?.scene?.packages === undefined, JSON.stringify((saved?.scene?.packages ?? []).map((p) => p.id)))
  const own = (saved?.packages ?? []).find((p) => p.id === SPAWNER)
  check('B  ...and the spawner is the project\'s own copy, the app\'s version, stamped where it came from', !!own && own.behavior === a.builtIn?.behavior && typeof own.origin?.app === 'string', JSON.stringify({ ids: (saved?.packages ?? []).map((p) => p.id), origin: own?.origin }))

  // ── C. a format-2 document with a stale built-in copy ───────────────────────────────────────────
  const builtIn = (await live()).builtIn
  const stale = { ...builtIn, name: 'Stale Spawner', behavior: `${builtIn.behavior}\n// a copy saved by an older build\n` }
  await boot(project(2, [stale]))
  const c = await live()
  check('C  a format-2 document opens on the app\'s own built-in, not its stale copy', !!c.app && c.app.behavior === c.builtIn?.behavior && c.app.name !== 'Stale Spawner', c.app?.name)
  const resaved = await editAndRead()
  check(`C  saving writes format ${CURRENT} with no copy in the scene`, oneScene(resaved) && resaved.scene.packages === undefined, String(resaved?.version))
  const kept = (resaved?.packages ?? []).find((p) => p.id === SPAWNER)
  check('C  ...and the project\'s copy is the app\'s current version, never the stale snapshot', !!kept && kept.name !== 'Stale Spawner' && kept.behavior === builtIn.behavior && typeof kept.origin?.app === 'string', kept?.name)

  // ── D. a multi-scene format-3 document splits ───────────────────────────────────────────────────
  await boot(multi())
  const d = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { name: s.projectName, parts: s.scene.parts.map((p) => p.name), program: s.stProgram }
  })
  check('D  the scene that was active IS the project, under the project\'s name', d.name === 'Split probe' && d.parts.join() === 'Sorter feeder', JSON.stringify(d))
  check('D  ...with that scene\'s program (none)', (d.program ?? '').trim() === '', JSON.stringify(d.program))
  const want = ['Split probe - Infeed', 'Split probe - Palletizer']
  let docs = []
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    docs = await library()
    if (want.every((n) => docs.some((x) => x.name === n))) break
    await page.waitForTimeout(500)
  }
  check('D  the other scenes are projects of their own in the projects list, "<project> - <scene>"', want.every((n) => docs.some((x) => x.name === n)), JSON.stringify(docs.map((x) => x.name)))
  check('D  ...and the kept scene is not filed a second time', !docs.some((x) => x.name === 'Split probe - Sorter'), JSON.stringify(docs.map((x) => x.name)))
  const infeed = docs.find((x) => x.name === want[0])
  const pal = docs.find((x) => x.name === want[1])
  check(
    `D  ...each a format-${CURRENT} document holding its own scene`,
    infeed?.version === CURRENT && infeed.scenes === null && infeed.parts.join() === 'Infeed feeder' && pal?.version === CURRENT && pal.scenes === null && pal.parts.join() === 'Palletizer feeder',
    JSON.stringify([infeed, pal]),
  )
  check('D  ...and its own program', (pal?.program ?? '').includes('q := TRUE') && (infeed?.program ?? '') === '', JSON.stringify([infeed?.program, pal?.program]))
  check('D  nothing is left parked once filed', (await page.evaluate(() => localStorage.getItem('oip-web/split-off'))) === null)
  const notice = await page
    .getByText('Split into projects')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true, () => false)
  check('D  a notice says the project was split', notice)
  const split = await editAndRead()
  check(`D  saving writes the kept project as format ${CURRENT}, its one scene`, oneScene(split) && split.name === 'Split probe' && split.scene.parts.length === 1, JSON.stringify({ v: split?.version, name: split?.name }))
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script that broke on its own assumptions as HARNESS
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-project-format3 (${failures})` : 'PASS  verify-project-format3')
process.exit(failures ? 1 : 0)
