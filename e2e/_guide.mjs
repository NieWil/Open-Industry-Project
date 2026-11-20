// What every published-guide script shares (e2e/guide-*.mjs): the page read as the test's input, a check that the
// page still says a phrase before the app is held to it, and the desktop-shell moves a reader makes in the app.
//
// The rule these scripts keep: the guide is followed, not copied. A program comes from the page's own <pre>, a value
// typed into the app from the page's own table, and every label or status line the page quotes is looked up on the
// page (`says`) before the app is compared with it, so rewording either side fails on the sentence that stopped
// matching.
/* global process, console, window, document, localStorage, setTimeout, URL */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
export const DESKTOP_DIR = join(ROOT, 'apps', 'desktop')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const squash = (s) => s.replace(/\s+/g, ' ').trim()
export const decode = (s) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&times;/g, '×')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * The guide at guides/<slug>/index.html, and the checks against it.
 *   expect(cond, msg)  one check, printed; returns cond
 *   says(phrase)       the page says it, verbatim (whitespace aside), or a failure; returns the phrase
 *   programs           the page's <pre class="code"> listings, in order
 *   wiring             its tables of (Part, Field, value-to-type) rows, in order
 */
export function guideTest(slug) {
  let failures = 0
  const expect = (cond, msg) => {
    if (cond) console.log('  ok:', msg)
    else {
      failures++
      console.error('  FAIL:', msg)
    }
    return cond
  }
  const html = readFileSync(join(ROOT, 'guides', slug, 'index.html'), 'utf8')
  const pageText = squash(decode(html.replace(/<(style|script|head)[\s\S]*?<\/\1>/g, ' ')))
  const says = (phrase) => {
    if (!pageText.includes(squash(phrase))) {
      failures++
      console.error(`  FAIL: the guide no longer says "${phrase}"`)
    }
    return phrase
  }
  const programs = [...html.matchAll(/<pre class="code"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decode(m[1]))
  const wiring = [...html.matchAll(/<tr><td>([^<]+)<\/td><td>([^<]+)<\/td><td class="m">([^<]+)<\/td>/g)].map((m) => ({ part: m[1].trim(), field: m[2].trim(), address: m[3].trim() }))
  return { html, expect, says, programs, wiring, failures: () => failures }
}

/** A label that starts with `text`, case and all (a plain hasText would ignore case and match any substring). */
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const labelled = (text) => new RegExp('^\\s*' + escaped(text) + '(?![A-Za-z])')
/** An Inspector label that is `text`: what may follow it is only a field badge (`read BOOL`, `write REAL`, `clash`, ...). */
export const fieldLabel = (text) => new RegExp('^\\s*' + escaped(text) + '(?=$|read |write |clash|bad address|= )')

/** The desktop shell (apps/desktop) on a dev server, past the tour and with the bundled parts loaded. */
export async function launchShell() {
  const { url, vite } = await startServer()
  const profileDir = mkdtempSync(join(tmpdir(), 'oip-guide-'))
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  const electronPath = require(join(DESKTOP_DIR, 'node_modules', 'electron'))
  // a window covered by the person's other windows stops painting on Windows (native occlusion), and a screenshot of
  // it waits for a frame that never comes: the run is unattended, so it keeps painting
  const args = [DESKTOP_DIR, `--user-data-dir=${profileDir}`, '--disable-features=CalculateNativeWinOcclusion']
  const app = await _electron.launch({ executablePath: electronPath, args, env })
  const close = async () => {
    await app.close().catch(() => {})
    vite.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.toolbar', { timeout: 60000 })
    await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
    await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
    return { app, page, profileDir, close }
  } catch (e) {
    await close()
    throw e
  }
}

/** Open a scene of `parts` (bundled packages by id), placed and unwired: a guide's step 1 wires them. */
export function loadParts(page, parts) {
  return page.evaluate((parts) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = [...new Set(parts.map((p) => p.packageId))].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    const error = window.__oip.loadSceneText(JSON.stringify({ version: st.getState().scene.version, parts, packages: need }))
    st.setState({ selectedIds: [] })
    return error ?? true
  }, parts)
}

/** One row of a guide's wiring table, done as the reader does it: select the part, open Comms, type. */
export async function wire(page, row, { expect, says, partIds }) {
  const id = partIds[row.part]
  if (!expect(!!id, `the guide's part "${row.part}" is one this scene has`)) return
  await page.evaluate((id) => {
    window.__oip.store.setState({ selectedIds: [id] })
    window.__oip.store.revealPanel('inspector')
  }, id)
  const head = page.locator('.inspector-group-head', { hasText: fieldLabel(says('Comms')) }).first()
  await head.waitFor({ timeout: 10000 })
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
  const field = page.locator('label.field', { has: page.locator('.field-label', { hasText: fieldLabel(row.field) }) }).locator('input').first()
  await field.waitFor({ timeout: 10000 }).catch(() => {})
  if (!expect((await field.count()) === 1, `${row.part}: the Inspector has "${row.field}"`)) return
  await field.fill(row.address)
  await field.press('Enter')
  await sleep(200)
  const stored = await page.evaluate(
    ({ id, address }) => Object.values(window.__oip.store.getState().scene.parts.find((p) => p.id === id).params).includes(address),
    { id, address: row.address },
  )
  expect(stored, `${row.part}: "${row.field}" holds ${row.address}`)
}

/** Simulation > PLC Controllers…, through the command palette (the native menu is out of a script's reach). */
export async function openExternalPlc(page, { expect, says }) {
  // the palette's chord is the app's, and a focused code editor keeps it (a reader in the PLC panel's editor reaches
  // for the menu instead): leave any text field first
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.palette-input')
  await input.waitFor({ timeout: 10000 })
  const command = says('PLC Controllers…')
  await input.fill(command)
  const item = page.locator('.palette-item', { has: page.locator('.palette-label', { hasText: labelled(command) }) }).first()
  expect((await item.locator('.palette-group').innerText()).trim() === says('Simulation'), `"${command}" is under Simulation, as the guide's menu path says`)
  await item.click()
}

export const boxX = (page) => page.evaluate(() => window.__oip.controller.livePosition('box')?.[0] ?? null)

/** After Play: wait for the box's first live position, back where it was placed (the last run's lingers until then). */
export const waitForReset = (page) =>
  page.waitForFunction(() => { const x = window.__oip.controller.livePosition('box')?.[0]; return typeof x === 'number' && x < 1 }, null, { timeout: 15000, polling: 100 })

/** Wait until the box has stood still for `holdMs`; its position, or null if it never settled. */
export async function settledX(page, timeoutMs, holdMs = 1000) {
  const until = Date.now() + timeoutMs
  let last = await boxX(page)
  let since = Date.now()
  while (Date.now() < until) {
    await sleep(100)
    const x = await boxX(page)
    if (x === null || last === null || Math.abs(x - last) > 0.002) since = Date.now()
    else if (Date.now() - since >= holdMs) return x
    last = x
  }
  return null
}

/** A screenshot of the page into `dir` (skipped when no dir was asked for). */
export async function shot(page, dir, name) {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`) })
}

// ---- the guide's pictures ----

/** The Inspector's Comms group of the selected part, the subject of every guide's step-1 picture. */
export const commsGroup = (page) => page.locator('.inspector-group-head', { hasText: fieldLabel('Comms') }).first().locator('xpath=..')

/** Every guide's line: a 5 m belt from the origin along +X, the box placed at 0.6 m, the eye at 3 m on the -Z side. */
export const LINE_CAMERA = { px: 3.7, py: 1.9, pz: -2.5, tx: 2.3, ty: 0.85, tz: 0 }

/** The window size pictures are taken at, so a crop does not depend on the monitor the script ran on. */
const PICTURE_WINDOW = { width: 1600, height: 1000 }
const PICTURE_RE = /<img\b[^>]*\bsrc="img\/([\w-]+)\.webp"[^>]*>/g

/**
 * The guide's screenshots. The page decides which exist: every `<img src="img/NAME.webp">` on it is a picture this
 * script takes at the moment the page describes, so a picture is retaken by the same run that proves the text, never
 * by hand, and goes stale only as fast as the script does.
 *
 *   ui(page, name, locator)     the app's own UI, cropped to one element, or to an array of them (lossless)
 *   scene(page, name, pose)     the 3D view alone, from a camera pose (cleanShot: no gizmo, no HUD), cut to a 2:1 band
 *   window(win, name, opts)     a whole window, such as a third-party tool's; `{ app, size }` shoots it at that content
 *                               size (an Electron app), then maximizes it again; `{ until }` cuts it below the bottom
 *                               of the first element whose text is `until` and the box around it
 *   finish()                    the checks: every picture the page shows exists at the size its tag says; with
 *                               --images, every one was retaken by this run and the tags get the new sizes
 *
 * Each take is a no-op unless the run was started with `--images` AND the page shows that name.
 */
export function guidePictures(slug, { html, expect }, argv = process.argv.slice(2)) {
  const dir = join(ROOT, 'guides', slug, 'img')
  const page = join(ROOT, 'guides', slug, 'index.html')
  const publish = argv.includes('--images')
  const shown = new Set([...html.matchAll(PICTURE_RE)].map((m) => m[1]))
  const taken = new Map()

  const wants = (name) => publish && shown.has(name)
  const save = async (name, png, { lossless }) => {
    const { default: sharp } = await import('sharp')
    mkdirSync(dir, { recursive: true })
    const img = sharp(png)
    const { width, height } = await img.metadata()
    await img.webp(lossless ? { lossless: true, effort: 6 } : { quality: 82, effort: 6 }).toFile(join(dir, `${name}.webp`))
    taken.set(name, { width, height })
    console.log(`  picture: img/${name}.webp (${width}x${height})`)
  }
  /** what would sit over the subject: the onboarding tour, a toast */
  const tidy = async (p) => {
    await p.evaluate(() => {
      for (const b of document.querySelectorAll('.tut-skip, .part-build-toast-close')) b.click()
    })
    await sleep(300)
  }

  return {
    publish,
    /** Size the app's window for pictures (only when they are being taken): same crop on any monitor. */
    async sizeWindow(app) {
      if (!publish) return
      await app.evaluate(({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.unmaximize()
        w.setContentSize(size.width, size.height)
      }, PICTURE_WINDOW)
      await sleep(800)
    },
    async ui(p, name, locator, { pad = 10 } = {}) {
      if (!wants(name)) return
      await tidy(p)
      // several locators: the one picture holds them all (two fields one above the other)
      const locators = [locator].flat()
      await locators[0].scrollIntoViewIfNeeded()
      const boxes = await Promise.all(locators.map((l) => l.boundingBox()))
      if (!expect(boxes.every(Boolean), `picture ${name}: its element is on screen`)) return
      const x0 = Math.min(...boxes.map((b) => b.x))
      const y0 = Math.min(...boxes.map((b) => b.y))
      const box = { x: x0, y: y0, width: Math.max(...boxes.map((b) => b.x + b.width)) - x0, height: Math.max(...boxes.map((b) => b.y + b.height)) - y0 }
      const vp = await p.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      const x = Math.max(0, Math.floor(box.x - pad))
      const y = Math.max(0, Math.floor(box.y - pad))
      const clip = { x, y, width: Math.min(vp.width, Math.ceil(box.x + box.width + pad)) - x, height: Math.min(vp.height, Math.ceil(box.y + box.height + pad)) - y }
      await save(name, await p.screenshot({ clip }), { lossless: true })
    },
    async scene(p, name, pose) {
      if (!wants(name)) return
      await tidy(p)
      await p.evaluate((pose) => window.__oip.view.setCameraPose(pose, { instant: true }), pose)
      await sleep(600)
      const { cleanShot } = await import('./_shot.mjs')
      const tmp = join(mkdtempSync(join(tmpdir(), 'oip-guide-pic-')), `${name}.png`)
      // the middle of the view at 2:1, whatever shape the docks left it: a page column is wide, not tall
      const band = await p.evaluate(() => {
        const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
        const r = c.getBoundingClientRect()
        const height = Math.min(r.height, Math.round(r.width / 2))
        return { x: r.x, y: r.y + Math.round((r.height - height) / 2), width: r.width, height }
      })
      await cleanShot(p, tmp, { clip: band })
      await save(name, readFileSync(tmp), { lossless: false })
      rmSync(dirname(tmp), { recursive: true, force: true })
    },
    async window(win, name, { app = null, size = null, until = null } = {}) {
      if (!wants(name)) return
      const resize = (to) =>
        app.evaluate(({ BrowserWindow }, to) => {
          const w = BrowserWindow.getAllWindows().find((w) => w.isVisible())
          if (to) {
            w.unmaximize()
            w.setContentSize(to.width, to.height)
          } else w.maximize()
        }, to)
      if (app && size) {
        await resize(size)
        await sleep(1000)
      }
      try {
        // the bottom of the panel holding `until`: the nearest ancestor that is drawn as a box
        const bottom = !until
          ? null
          : await win.evaluate((text) => {
              const el = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && e.textContent.trim() === text && e.getBoundingClientRect().width > 0)
              for (let a = el?.parentElement; a; a = a.parentElement) {
                const cs = getComputedStyle(a)
                if (cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && a.getBoundingClientRect().height > 200)) return Math.ceil(a.getBoundingClientRect().bottom + 8)
              }
              return null
            }, until)
        const vp = bottom ? await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) : null
        const clip = bottom ? { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, bottom) } : undefined
        await save(name, await win.screenshot({ timeout: 10000, clip }), { lossless: true })
      } finally {
        if (app && size) {
          await resize(null)
          await sleep(1000)
        }
      }
    },
    async finish() {
      if (publish) {
        for (const name of shown) expect(taken.has(name), `the page's picture img/${name}.webp was retaken by this run`)
        // the tags carry each picture's size (no layout shift as it loads): give them the new ones
        let text = readFileSync(page, 'utf8')
        text = text.replace(PICTURE_RE, (tag, name) => {
          const size = taken.get(name)
          return size ? tag.replace(/\swidth="\d+"/, ` width="${size.width}"`).replace(/\sheight="\d+"/, ` height="${size.height}"`) : tag
        })
        writeFileSync(page, text)
        html = text
      }
      const { default: sharp } = await import('sharp')
      for (const m of html.matchAll(PICTURE_RE)) {
        const [tag, name] = m
        const file = join(dir, `${name}.webp`)
        if (!expect(existsSync(file), `the page's picture img/${name}.webp exists`)) continue
        const { width, height } = await sharp(file).metadata()
        const said = { width: Number(/\swidth="(\d+)"/.exec(tag)?.[1]), height: Number(/\sheight="(\d+)"/.exec(tag)?.[1]) }
        expect(said.width === width && said.height === height, `img/${name}.webp is ${width}x${height}, as its tag says (${said.width}x${said.height})`)
        expect(/\salt="[^"]{12,}"/.test(tag), `img/${name}.webp has alt text`)
      }
    },
  }
}
