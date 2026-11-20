// Gate for find/replace in the Structured Text editor (@codemirror/search with the panel from
// stSearchPanel.ts). Asserts Ctrl-F opens a themed panel at the top, matches highlight, the
// current match is distinguished and counted, the replace row opens from its chevron, replace-all rewrites the buffer, Escape closes, Ctrl-D
// multi-selects the next occurrence, and selecting a word highlights its siblings.
// Screenshots go to e2e/shots/. Run: node e2e/verify-st-editor-search.mjs [--headed]
//
// Type into the search box, never `locator.fill()`. CM's search panel commits its query on
// the input's `change`/`keyup`; Playwright's fill() only fires `input`, so the query is never
// applied and every match count reads 0 while the feature works.
/* global process, console, document, window, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')

// four occurrences of Motor, on distinct lines, so match counting is unambiguous
const PROGRAM = `VAR_INPUT
  Start : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := Start;
IF Motor THEN
  Motor := FALSE;
END_IF;`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function setDoc(page, text) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

/** type into a search-panel field the way a user does, so CM's keyup commit fires */
async function typeInto(page, name, text) {
  const field = page.locator(`.cm-panel.cm-search input[name=${name}]`)
  await field.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(text, { delay: 30 })
}

/** double-click a word on a given line (Playwright's element dblclick hits past the end of the text) */
async function dblclickWord(page, lineIndex, xOffset) {
  const box = await page.locator('.cm-content .cm-line').nth(lineIndex).boundingBox()
  await page.mouse.dblclick(box.x + xOffset, box.y + box.height / 2)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await page.waitForTimeout(800)
    await setDoc(page, PROGRAM)
    await page.waitForTimeout(200)

    // 1. Ctrl-F opens the panel (the browser's own find would otherwise take the key)
    await page.keyboard.press('Control+f')
    const opened = await page.locator('.cm-panel.cm-search')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)
    check('Ctrl-F opens the search panel', opened)

    // 2. docked above the content, clear of the diagnostics strip the ST panel renders below
    if (opened) {
      // against the scroller, the code's window: .cm-content scrolls inside it, and in the short docked panel a
      // cursor at the end of the program scrolls the content's top above the panel
      const geom = await page.evaluate(() => {
        const p = document.querySelector('.cm-panel.cm-search').getBoundingClientRect()
        const c = document.querySelector('.cm-scroller').getBoundingClientRect()
        return { panelBottom: p.bottom, contentTop: c.top }
      })
      check('panel is docked at the top', geom.panelBottom <= geom.contentTop + 1,
        `panel bottom=${geom.panelBottom.toFixed(0)} code top=${geom.contentTop.toFixed(0)}`)
    }

    // 3. themed to the app's panel chrome (stLang.ts: light-dark(#f7f7f8, #1f2023)), not CM's stock gray, in both
    //    schemes. The app follows the system scheme, and a browser that asks for neither (this one) gets the light one
    const panelBg = () => page.evaluate(() => {
      const el = document.querySelector('.cm-panels')
      return el ? window.getComputedStyle(el).backgroundColor : ''
    })
    const lightBg = await panelBg()
    check('search panel uses the light panel theme in a light scheme', lightBg === 'rgb(247, 247, 248)', `bg=${lightBg}`)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-panels')).backgroundColor !== 'rgb(247, 247, 248)', null, { timeout: 3000 }).catch(() => {})
    const darkBg = await panelBg()
    check('and the dark panel theme in a dark one', darkBg === 'rgb(31, 32, 35)', `bg=${darkBg}`)
    await page.emulateMedia({ colorScheme: 'light' })

    // 4. typing a query highlights every hit
    await typeInto(page, 'search', 'Motor')
    await page.waitForTimeout(300)
    const matches = await page.locator('.cm-searchMatch').count()
    check('all matches highlighted', matches === 4, `matches=${matches} (want 4)`)

    // 5. the current match is visually distinguished from the rest
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const selected = await page.locator('.cm-searchMatch-selected').count()
    check('current match is distinguished', selected === 1, `selected=${selected}`)
    const count = await page.locator('.cm-st-search-count').innerText()
    check('the count names the current match', /^1 of 4$/.test(count), `count=${JSON.stringify(count)}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-search.png') })

    // 6. the replace row opens from the chevron, and replace-all rewrites the buffer
    const replaceHidden = await page.locator('.cm-panel.cm-search input[name=replace]').isHidden()
    await page.locator('.cm-panel.cm-search button[name=toggleReplace]').click()
    await page.locator('.cm-panel.cm-search').screenshot({ path: join(OUT, 'st-editor-search-panel.png') })
    check('the replace row is collapsed until asked for', replaceHidden
      && await page.locator('.cm-panel.cm-search input[name=replace]').isVisible())
    await typeInto(page, 'replace', 'Drive')
    await page.getByRole('button', { name: /replace all/i }).click()
    await page.waitForTimeout(300)
    const doc = await page.locator('.cm-content').innerText()
    check('replace all rewrote every occurrence',
      !/Motor/.test(doc) && (doc.match(/Drive/g) || []).length === 4,
      `motors=${(doc.match(/Motor/g) || []).length} drives=${(doc.match(/Drive/g) || []).length}`)

    // 7. Escape closes it
    await page.locator('.cm-panel.cm-search input[name=search]').press('Escape')
    await page.waitForTimeout(300)
    check('Escape closes the panel', await page.locator('.cm-panel.cm-search').count() === 0)

    // 8. Ctrl-D adds the next occurrence to the selection; needs
    //    EditorState.allowMultipleSelections, without which it does nothing
    await setDoc(page, PROGRAM)
    await page.waitForTimeout(200)
    await dblclickWord(page, 6, 20) // "Motor := Start;"
    await page.waitForTimeout(150)
    const seeded = await page.evaluate(() => document.getSelection()?.toString())
    await page.keyboard.press('Control+d')
    await page.waitForTimeout(250)
    const twoRanges = await page.locator('.cm-selectionBackground').count()
    check('Ctrl-D multi-selects the next occurrence', seeded === 'Motor' && twoRanges >= 2,
      `seeded=${JSON.stringify(seeded)} ranges=${twoRanges}`)

    // 9. Ctrl-Shift-L selects every occurrence at once (rename a tag across the program)
    await dblclickWord(page, 6, 20)
    await page.waitForTimeout(150)
    await page.keyboard.press('Control+Shift+L')
    await page.waitForTimeout(250)
    const allRanges = await page.locator('.cm-selectionBackground').count()
    check('Ctrl-Shift-L selects all occurrences', allRanges === 4, `ranges=${allRanges} (want 4)`)
    // and a single keystroke rewrites them all
    await page.keyboard.type('Drive')
    await page.waitForTimeout(250)
    const renamed = await page.locator('.cm-content').innerText()
    check('typing over a multi-selection renames every occurrence',
      !/Motor/.test(renamed) && (renamed.match(/Drive/g) || []).length === 4,
      `motors=${(renamed.match(/Motor/g) || []).length} drives=${(renamed.match(/Drive/g) || []).length}`)

    // 10. selecting a word dim-highlights its siblings (highlightSelectionMatches)
    await setDoc(page, PROGRAM)
    await page.waitForTimeout(200)
    await dblclickWord(page, 6, 20)
    await page.waitForTimeout(300)
    const selMatches = await page.locator('.cm-selectionMatch').count()
    check('selection highlights other occurrences', selMatches > 0, `selectionMatches=${selMatches}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-selection-matches.png') })

    // 11. the rest of the editor is unaffected by the keymap reorder
    await setDoc(page, 'VAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Missing;')
    await page.waitForTimeout(600)
    check('linter still runs after the keymap reorder',
      await page.locator('.cm-lintRange-error').count() > 0)

    const pageErrs = errors.filter((e) => !/favicon|manifest/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(`\nshots: ${OUT}`)
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
