// Gate for the ST editor's inline live-value overlay (live values drawn beside the code while it runs),
// and specifically for the `valueRefs` memo in `src/editor/program/stLang.ts`.
//
// The overlay's decorations recompute on every value push (StEditor polls the live variable
// image every 120 ms while a program runs), not just on edits. Rebuilding the document string and
// re-lexing it on each push to find identifier positions (which only move when the text does) is
// wasted work, so the positions are memoized on CodeMirror's immutable `Text` instance. The memo is
// only safe because a `Text` is replaced on every edit, so this asserts both sides of that contract:
//   - values keep changing while the text is stable (a cache hit must not freeze the overlay)
//   - positions re-derive after an edit          (a cache miss must actually re-lex)
// Run: node e2e/verify-st-inline-values.mjs [--headed]
/* global process, console, document, window, localStorage */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/** every inline value box, in document order, with its screen position */
const readWidgets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-st-value')].map((el) => {
      const r = el.getBoundingClientRect()
      return { text: el.textContent, x: Math.round(r.x), y: Math.round(r.y) }
    }),
  )

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.controller), { timeout: 30000 })
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    await clickDemo(page)
    await page.waitForTimeout(1200)

    // the ST editor docks behind Parts in the default layout, so it has to be brought forward to mount
    // the helper's own budget, not a tighter one: the demo opens on its ladder, so the text comes after its rungs are
    // drawn, at the ~1 fps a headless page manages with the whole cell on screen
    let why = ''
    const hasEditor = await showPlcEditor(page).then(() => true, (e) => ((why = String(e).split('\n')[0]), false))
    check('ST editor is mounted with the demo loaded', hasEditor, why)
    if (!hasEditor) return

    // 1. running the program lights up the inline value boxes
    await page.evaluate(() => window.__oip.controller.run())
    // Scroll into the code first. CodeMirror virtualizes, so only the lines on screen carry widgets, and
    // the demo program opens on its comment header (measured: 0 widgets at the top, 37 after
    // Control+End). Without this the gate reports "inline values gone" about a feature that works.
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(500)
    const appeared = await page.locator('.cm-st-value').first()
      .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    const first = await readWidgets(page)
    check('inline value widgets appear while the program runs', appeared && first.length > 0,
      `widgets=${first.length}`)
    if (!appeared) return

    // 2. the memo's risk: the text never changes while running, so every push is a cache hit.
    //    The values must still track the live image.
    // the demo takes a while to drive its tags (cargo has to reach the first sensor), so poll
    // generously: a real freeze never changes, a quiet window just needs waiting out.
    let changed = 0
    let sampled = first
    for (let i = 0; i < 60 && changed === 0; i++) {
      await page.waitForTimeout(400)
      const next = await readWidgets(page)
      changed = next.filter((w, j) => sampled[j] && w.text !== sampled[j].text).length
      sampled = next
    }
    check('values keep updating on a stable document (cache hit does not freeze)', changed > 0,
      `${changed} of ${sampled.length} boxes changed`)

    // 3. after an edit the refs must be re-derived: insert a leading comment line and the
    //    boxes should shift down a line, not stay anchored at their old offsets.
    const before = await readWidgets(page)
    const lineH = await page.evaluate(() => {
      const l = document.querySelector('.cm-content .cm-line')
      return l ? l.getBoundingClientRect().height : 0
    })
    // focused, not clicked: click() aims at the middle of the whole document, which in the short docked panel
    // is off the scroller and over the viewport (and the value boxes remount every poll besides)
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.insertText('(* memo probe *)\n')
    // …then back to the code. Control+Home leaves the view on the program's comment header, where the
    // virtualized editor renders no value widgets at all (0 there, 37 in the code), so reading there
    // would measure the header rather than the re-derivation this check is about.
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(600)
    const after = await readWidgets(page)
    // An edit re-compiles the program, so the widget count may correctly change (a variable that no
    // longer resolves stops being monitored). What must hold is that every surviving box sits one line
    // lower; stale refs would leave them anchored at their old offsets.
    // Re-derived means: every box still sits on a rendered line of the new document. Comparing against
    // `before.y + lineH` assumes the view stays put across the edit, which it does not: the edit is at
    // the top of the document and the code is at the bottom, so boxes at the scroll edges miss the
    // formula while still sitting on a line.
    const lineYs = await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.getBoundingClientRect().top))
    const stray = after.filter((w) => !lineYs.some((y) => Math.abs(w.y - y) <= lineH))
    const shifted = after.length > 0 && stray.length === 0
    check('widget positions re-derive after an edit (cache miss re-lexes)', shifted,
      `n=${before.length}->${after.length} lineH=${lineH.toFixed(1)} stray=${stray.length}`)

    // 4. and they are still live after the edit (new Text, memo repopulated)
    const t0 = await readWidgets(page)
    let livePostEdit = 0
    for (let i = 0; i < 12 && livePostEdit === 0; i++) {
      await page.waitForTimeout(400)
      const t1 = await readWidgets(page)
      livePostEdit = t1.filter((w, j) => t0[j] && w.text !== t0[j].text).length
    }
    check('values still update after an edit', livePostEdit > 0, `${livePostEdit} boxes changed`)

    // 5. names are read in the POU they are written in (plc/watchScope.ts). The program runs as one instance and
    //    publishes `Main.n` for the `n` its body spells, so that line shows live values. The block's own `n` is not
    //    published, so its line shows none, never the program's `n`.
    await page.evaluate(() => window.__oip.controller.stop())
    const SCOPED = 'FUNCTION_BLOCK Blk\nVAR\n  n : INT;\nEND_VAR\nn := n + 100;\nEND_FUNCTION_BLOCK\n' +
      'PROGRAM Main\nVAR\n  n : INT;\n  b : Blk;\nEND_VAR\nn := n + 1;\nb();\nEND_PROGRAM\n'
    await page.evaluate((program) => window.__oip.store.loadStProgram(program), SCOPED)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__oip.controller.run())
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+Home')
    const lineBoxes = (text) =>
      page.evaluate((text) => {
        // the line's own text, without the value boxes drawn into it
        const codeOf = (l) => {
          const c = l.cloneNode(true)
          c.querySelectorAll('.cm-st-value, .cm-st-monitor').forEach((el) => el.remove())
          return c.textContent.replace(/\s+/g, ' ').trim()
        }
        const line = [...document.querySelectorAll('.cm-content .cm-line')].find((l) => codeOf(l) === text)
        return line ? [...line.querySelectorAll('.cm-st-value')].map((el) => el.textContent) : null
      }, text)
    await page.locator('.cm-st-value').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    const p0 = await lineBoxes('n := n + 1;')
    await page.waitForTimeout(800)
    const p1 = await lineBoxes('n := n + 1;')
    check('a PROGRAM body shows its instance\'s live values', !!p0 && !!p1 && p1.length === 2 && p1.some((v, j) => v !== p0[j]),
      `${(p0 ?? []).join(',')} -> ${(p1 ?? []).join(',')}`)
    const inBlock = await lineBoxes('n := n + 100;')
    check('a function block\'s own variable shows no value, not the program\'s of the same name', inBlock !== null && inBlock.length === 0,
      `boxes=${JSON.stringify(inBlock)}`)

    // 6. a PROGRAM that runs as two instances shows one of them, says which on its header, and switches on a click of
    //    that chip or of an instance row in the organizer. Line1 scans ten times as often as Line2, so their counts
    //    tell the two apart.
    await page.evaluate(() => window.__oip.controller.stop())
    // an empty scene: the demo's parts name tags this program lacks, and their wiring warnings would fill the docked
    // panel and leave the code no height to click in
    await page.evaluate(() => window.__oip.store.loadScene({ version: window.__oip.store.getState().scene.version, parts: [] }))
    await page.evaluate(() =>
      window.__oip.store.commitProgram('two instances', {
        source: 'PROGRAM Merge\nVAR\n  n : INT;\nEND_VAR\nn := n + 1;\nEND_PROGRAM\n',
        controller: {
          tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }, { name: 'Slow', intervalMs: 100, priority: 2 }],
          programs: [{ name: 'Line1', type: 'Merge', task: 'Fast' }, { name: 'Line2', type: 'Merge', task: 'Slow' }],
        },
      }),
    )
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__oip.controller.run())
    // the chip sits on the PROGRAM's header, the first line: bring it into the editor's view (case 5 left it at the end)
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+Home')
    const chip = page.locator('[data-testid="st-monitor"]')
    const chipShown = await chip.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    // whose count the line shows: the instance whose live count it is nearer to, read in the same step
    const whose = () =>
      page.evaluate(() => {
        const line = [...document.querySelectorAll('.cm-content .cm-line')].find((l) => {
          const c = l.cloneNode(true)
          c.querySelectorAll('.cm-st-value, .cm-st-monitor').forEach((el) => el.remove())
          return c.textContent.replace(/\s+/g, ' ').trim() === 'n := n + 1;'
        })
        const shown = Number(line?.querySelector('.cm-st-value')?.textContent)
        const w = window.__oip.controller.plcWatch ?? {}
        const a = Number(w['Line1.n']), b = Number(w['Line2.n'])
        return { shown, a, b, who: !Number.isFinite(shown) ? null : Math.abs(shown - a) < Math.abs(shown - b) ? 'Line1' : 'Line2' }
      })
    await page.waitForTimeout(1500)
    const atFirst = await whose()
    check('two instances: the code shows the first, and its header says so', chipShown && atFirst.who === 'Line1' && /Line1 \(1 of 2\)/.test((await chip.textContent()) ?? ''),
      `chip="${chipShown ? await chip.textContent() : ''}" ${JSON.stringify(atFirst)}`)
    await chip.click()
    await page.waitForTimeout(600)
    const second = await whose()
    check('two instances: the header chip switches the code to the next instance', second.who === 'Line2' && /Line2 \(2 of 2\)/.test((await chip.textContent()) ?? ''),
      `chip="${await chip.textContent()}" ${JSON.stringify(second)}`)
    const row = page.locator('[data-testid="org-program"][data-program="Line1"]')
    const rowShown = await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
    if (rowShown) await row.click()
    await page.waitForTimeout(600)
    const third = await whose()
    const badge = await page.locator('[data-testid="org-program"][data-program="Line1"] [data-testid="org-monitored"]').count()
    check('two instances: an instance row in the organizer picks it, and wears the badge', rowShown && third.who === 'Line1' && badge === 1,
      `row=${rowShown} badge=${badge} ${JSON.stringify(third)}`)

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error('crashed:', err); vite.kill(); process.exit(2) })
