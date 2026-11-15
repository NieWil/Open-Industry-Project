// Where the time goes at each step of working in the editor, on a line the size of a real site's.
//
//   npm run profile                         every step, on the 400-station reference line (e2e/_reference.mjs)
//   npm run profile -- reload play          only those steps
//   npm run profile -- --stations 1000      a larger line
//   npm run profile -- --project line.oip   a project file in place of the reference line
//   npm run profile -- --top 40             more functions per step
//   npm run profile -- --no-build           reuse the last profiling build
//
// Steps, in the order they run:
//   reload     the page reloaded with the project open: the loading cover's stages, the renderer's compile ledger
//   lift       the six seconds after the cover lifts, orbiting once a second
//   dock       the PLC dock opened
//   ladder     its ladder face shown
//   problems   the Problems panel opened, until its report is in
//   play       Play pressed, and the first eight seconds of the run
//   stop       the run stopped
//
// Each step prints the page's stalls and the functions that account for its time. It runs in a visible window,
// because headless Chromium has no WebGPU, on its own unminified build (`.profile-build/`), so the functions have
// their names and a build something else is measuring is left alone. That build skips the asset optimizer: read
// what the script does from it, not how long a model takes to arrive.
//
// Timings move with the machine. Compare two runs taken one after the other, and read `working` against `idle`
// before the totals: a step that is mostly idle is waiting on something, not computing.
/* global process, console, window, document, performance, requestAnimationFrame */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { withGpuArgs } from '../_gpuArgs.mjs'
import { acquireLease } from '../_lease.mjs'
import { pageNow, profiled, report, watchLongTasks } from '../_profile.mjs'
import { loadReference } from '../_reference.mjs'

const STEPS = ['reload', 'lift', 'dock', 'ladder', 'problems', 'play', 'stop']
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}
const wanted = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').match(/^--(stations|project|top)$/))
const unknown = wanted.filter((s) => !STEPS.includes(s))
if (unknown.length > 0) {
  console.error(`no such step: ${unknown.join(', ')} (steps: ${STEPS.join(', ')})`)
  process.exit(2)
}
const steps = wanted.length > 0 ? STEPS.filter((s) => wanted.includes(s)) : STEPS
const stations = Number(flag('stations', 400))
const project = flag('project', null)
const top = Number(flag('top', 22))
const log = (...a) => console.log(...a)

const root = fileURLToPath(new URL('../../', import.meta.url))
const BUILD = fileURLToPath(new URL('../../.profile-build/', import.meta.url))
if (!args.includes('--no-build') || !existsSync(`${BUILD}app/index.html`)) {
  log('building an unminified copy into .profile-build/ ...')
  execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)), 'build', '--minify', 'false', '--outDir', '.profile-build', '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' })
}

// the build behind the real host's headers (cross-origin isolation, the app-shell rewrite): apps/desktop/pagesHost.cjs
const { pagesHost } = createRequire(import.meta.url)('../../apps/desktop/pagesHost.cjs')
const host = pagesHost(BUILD)
const server = createServer((req, res) => {
  const { status, headers, file, location } = host.respond(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (location || !file) {
    res.writeHead(location ? status : 404, location ? headers : { 'Content-Type': 'text/plain' })
    return res.end(location ? undefined : 'not found')
  }
  const body = readFileSync(file)
  res.writeHead(status, { ...headers, 'Content-Length': body.length })
  res.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/app/?hook`

const release = await acquireLease({ label: 'profile-steps' })
const browser = await chromium.launch(withGpuArgs({ headless: false, args: ['--enable-unsafe-webgpu'] }))
let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  page.on('dialog', (d) => void d.accept())
  await watchLongTasks(page)
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
    // the loading cover's stages, stamped as they change
    window.__coverStages = []
    let last = ''
    const tick = () => {
      const el = document.querySelector('.viewport-cover')
      const now = el ? (el.classList.contains('ready') ? 'lifted' : (el.querySelector('.viewport-cover-status')?.textContent ?? '')) : 'none'
      if (now !== last) {
        last = now
        window.__coverStages.push([performance.now(), now])
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const coverLifted = () => page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready') && !!window.__oip?.view, null, { timeout: 300000, polling: 50 })
  const twoFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await coverLifted()
  if (project) {
    await page.locator('[data-testid="project-import"]').waitFor({ state: 'attached', timeout: 120000 })
    await page.setInputFiles('[data-testid="project-import"]', { name: basename(project), mimeType: 'application/zip', buffer: readFileSync(project) })
    const name = basename(project).replace(/\.oip$/i, '')
    await page.waitForFunction((n) => document.title.startsWith(n), name, { timeout: 300000, polling: 250 })
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 300000, polling: 250 })
    log(`project ${basename(project)}: ${await page.evaluate(() => window.__oip.store.getState().scene.parts.length)} parts`)
  } else {
    const built = await loadReference(page, { stations })
    log(`reference line: ${stations} stations, ${built.parts} parts, ${built.tags} wired tags, a program of ${built.lines} lines (${(built.bytes / 1e6).toFixed(2)} MB)`)
  }
  // long enough for the autosave that a reload opens from, and for the warm-ups a load leaves running
  await page.waitForTimeout(20000)

  const canvas = async () =>
    page.evaluate(() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
  const orbit = async () => {
    const c = await canvas()
    const t0 = await pageNow(page)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(c.x + 60, c.y + 20, { steps: 4 })
    await page.mouse.up({ button: 'right' })
    await twoFrames()
    return Math.round((await pageNow(page)) - t0)
  }
  /** profile one step: `act` does it and resolves when its result is on screen, `settle` ms are watched after */
  const step = async (name, title, act, settle) => {
    if (!steps.includes(name)) return act()
    const rec = await profiled(page, async () => {
      const t0 = await pageNow(page)
      await act()
      const shown = (await pageNow(page)) - t0
      await page.waitForTimeout(settle)
      return shown
    })
    report(`${title} (on screen after ${Math.round(rec.result)} ms)`, rec, { top, log })
  }

  // ---- reload, and the seconds after the cover lifts
  if (steps.includes('reload') || steps.includes('lift')) {
    const rec = await profiled(
      page,
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await coverLifted()
        const lifted = await pageNow(page)
        const answered = []
        if (steps.includes('lift')) {
          for (let i = 0; i < 6; i++) {
            answered.push(await orbit())
            await page.waitForTimeout(Math.max(0, 1000 - answered[i]))
          }
          await page.waitForFunction(() => (window.__oip.view.extrasWarmDone ?? window.__oip.view.warm?.extrasWarmDone) !== false, null, { timeout: 120000, polling: 100 }).catch(() => {})
        }
        return { lifted, answered, end: await pageNow(page) }
      },
      { fromNavigation: true },
    )
    const stages = await page.evaluate(() => window.__coverStages)
    const at = (test) => stages.find(([, s]) => test(s))?.[0] ?? 0
    const up = at((s) => s !== 'none' && s !== 'lifted')
    const shaders = at((s) => /shader/i.test(s))
    const { lifted, answered, end } = rec.result
    if (steps.includes('reload')) {
      log(`\ncover: ${stages.map(([t, s]) => `${Math.round(t)} ms ${s}`).join('  ->  ')}`)
      const ledger = await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.__oipCompilePhases ?? {}).map(([k, v]) => [k, Math.round(v)])))
      if (ledger.phase2Build !== undefined) log(`compile ledger: the building ${ledger.phase1Build} ms for ${ledger.phase1Items} items (${ledger.phase1Pipelines} pipelines); the parts ${ledger.phase2Build} ms for ${ledger.phase2Items} items (${ledger.phase2Pipelines - ledger.phase2PipesStart} more pipelines)`)
      report('reload: until the cover appears', rec, { from: 0, to: up, top, log })
      report('reload: the cover up, before it compiles shaders', rec, { from: up, to: shaders || lifted, top, log })
      if (shaders) report('reload: compiling shaders', rec, { from: shaders, to: lifted, top, log })
    }
    if (steps.includes('lift')) {
      log(`\norbits from the lift answered in ${answered.join(', ')} ms`)
      report('after the cover lifts', rec, { from: lifted, to: end, top, log })
    }
  }

  await step('dock', 'open the PLC dock', async () => {
    await page.evaluate(() => window.__oip.store.revealPanel('st'))
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content, [data-testid="ladder-view"]')].some((el) => el.getBoundingClientRect().height > 0), null, { timeout: 300000, polling: 100 })
  }, 5000)

  await step('ladder', 'show the ladder face', async () => {
    const button = page.locator('[data-testid="plc-view-ladder"]').first()
    if ((await button.count()) === 0) return log('(this panel has no ladder switch)')
    await button.click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ladder-view"]')].some((el) => el.getBoundingClientRect().height > 0), null, { timeout: 300000, polling: 100 })
  }, 5000)

  await step('problems', 'open the Problems panel', async () => {
    await page.evaluate(() => window.__oip.store.revealPanel('problems'))
    await page.waitForFunction(() => !!document.querySelector('.problems-panel'), null, { timeout: 300000, polling: 100 })
  }, 2000)

  await step('play', 'press Play', async () => {
    await page.evaluate(() => void window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true && !!window.__oip.controller.plcWatch, null, { timeout: 300000, polling: 100 })
  }, 8000)

  await step('stop', 'stop the run', async () => {
    await page.evaluate(() => void window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.store.getState().running === false, null, { timeout: 300000, polling: 100 })
  }, 3000)

  const gpu = await page.evaluate(() => globalThis.__oipGpuErrors?.count ?? 0)
  if (gpu > 0) log(`\n${gpu} GPU error(s) were recorded during the run (globalThis.__oipGpuErrors)`)
} catch (e) {
  failed = true
  console.error('profile-steps failed:', e)
} finally {
  await browser.close()
  server.close()
  await release?.()
}
process.exit(failed ? 1 : 0)
