// The top bar must fit the window at every width the docked desktop layout is used at, and every
// action it holds must stay reachable.
//   node e2e/verify-toolbar-fit.mjs
//
// The docked layout runs down to 821px (MOBILE_QUERY takes over below that). A row that needs more
// than the window (the full row once needed ~1119px) runs its right-hand group off the screen: at
// 900px Share plus every icon after it, at 821px Demo too. Nothing in the chain clips, so instead of
// the bar degrading, the document scrolls sideways and takes the viewport and docks with it. Every
// other gate misses this (the scene renders correctly and the store is right; only the pixels the user
// can reach are wrong), and so does dev unless the window happens to be half a 1080p screen.
//
// So the assertions are about fit and reachability, not about which breakpoint does the folding:
//   1. no control's right edge passes the viewport, at any width in the band
//   2. no two controls overlap each other
//   3. the document never scrolls horizontally
//   4. the file actions are always reachable: the project menu in the row, or the "…" menu on the
//      mobile layout, which carries the same rows
//   5. the desktop shell's menu button survives the same ladder
//   6. the project menu's label (a long project name, its widest form: a project holds one scene, and the
//      demo is a project of its own, "Palletizing demo" + an Example badge) stays above a readable floor in the
//      docked band
//
// (6) is what makes the breakpoint mean something. The left group is shrinkable (styles.css, the
// min-width chain), so (1)-(3) stay green with the label crushed to a 14px sliver. The label does give up
// width by design (the row is 1fr auto 1fr, so the left half cannot borrow the right half's spare room),
// and the floors are a budget on how much. Anything that widens the left group comes straight out of them:
// five square 28px scene buttons took a scene picker from 105px to 86, and the project menu in the group
// moves the branding fold from 1050 to 1200.
//
// (2) matters as much as fit. A row this tight has two ways to fail and fixing one tends to cause the
// other: too wide and controls leave the window, and the obvious fix (letting the side groups collapse)
// turns that into the centred run cluster sliding over the project menu. The overlap is the worse of
// the two (nothing looks wrong until you click), and a fit-only check reports it as PASS. It is also
// why the mobile layout does not use 1fr auto 1fr at all.
//
// Swept in the row's heaviest state, because its requirement is not a constant and a bare run would
// check the wrong thing: the demo's tagged label (the label is elastic), a live collab chip (+46) and
// the VR button on an XR-capable browser (+40). The XR runtime is stubbed, since headless Chromium
// reports none and the 40px button would never render. The chip only exists in a shared project. The two halves of the
// row are sized independently (1fr auto 1fr), so a long project name, shared or not, never meets the chip: the left
// group gets a second, solo sweep carrying the long project name instead.
// (5) is included because the shell shares this row and its rules cut differently there. The mark is
// decoration on the web; in the shell it is the menu button. The shell hides the OS menu bar, so the
// mark is the only pointer path to File/Edit/Simulation. A branding cut written for the web can shrink
// it to a 12x8 stub that still works but looks like nothing, which is why this runs the ladder a
// second time in a stubbed shell rather than trusting the web pass.
/* global process, console, window, document, navigator */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()

let failures = 0
const expect = (cond, msg) => {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

// The docked band only. verify-phone-shortfall.mjs covers phone widths; 820 is here as the
// handover check, the width where MOBILE_QUERY takes the row over.
const WIDTHS = [1440, 1320, 1280, 1201, 1200, 1160, 1119, 1051, 1050, 1000, 960, 941, 940, 900, 854, 830, 821, 820]
/** styles.css's one fold: the mark, on the web (there is no wordmark beside it, Toolbar.tsx) */
const MARK_FOLD = 1200
/** The narrowest the project menu's label may get in the docked band (assertion 6). A budget, like the draw
 *  budget: move it deliberately, in the commit that changed the left group. */
const PROJECT_FLOOR = 100
const LONG_PROJECT = 'Distribution Centre North - Phase 2'
// any room id will do: the chip renders as soon as the session has one, connected or not
const ROOM = 'e-toolbar-fit-gate'

/** Report an immersive-vr runtime, so the VR button renders as it does on a headset browser. */
const stubXr = () => {
  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: { isSessionSupported: () => Promise.resolve(true), addEventListener() {}, removeEventListener() {} },
  })
}

const measure = () => {
  const tb = document.querySelector('.toolbar')
  const ctrls = [...tb.querySelectorAll('button, a, select')].filter((el) => el.getBoundingClientRect().width > 0)
  const name = (el) => (el.textContent || '').trim() || el.getAttribute('aria-label') || el.title?.split(/[(:]/)[0].trim() || el.className
  return {
    mobile: document.querySelector('.app').classList.contains('mobile'),
    cut: ctrls.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).map(name),
    overlaps: (() => {
      const boxes = ctrls.map((el) => ({ el, n: name(el), r: el.getBoundingClientRect() })).sort((a, b) => a.r.left - b.r.left)
      const hits = []
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1]
        const b = boxes[i]
        // a segmented group's buttons share one border on purpose (toolbar.css `.segmented`: each after the first is
        // pulled 1px left), so neighbours in one group may overlap by that border; anywhere else 0.5px of tolerance
        // covers sub-pixel layout, and anything more is a real stack
        const shared = a.el.parentElement === b.el.parentElement && a.el.parentElement?.matches('.segmented')
        if (b.r.left < a.r.right - (shared ? 1.5 : 0.5)) hits.push(`${a.n} / ${b.n}`)
      }
      return hits
    })(),
    docScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    wordmark: !!tb.querySelector('.toolbar-title'),
    mark: (tb.querySelector('.toolbar-logo')?.getBoundingClientRect().width ?? 0) > 0,
    button: Math.round(tb.querySelector('.project-button')?.getBoundingClientRect().width ?? 0),
    project: Math.round(tb.querySelector('.project-name')?.getBoundingClientRect().width ?? 0),
    // the heavy chrome this sweep carries: if either stops rendering the run is vacuous
    chip: !!tb.querySelector('.collab-status'),
    vr: !!tb.querySelector('[data-vr-button]'),
  }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
  await page.addInitScript(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.addInitScript(stubXr)
  await page.goto(`http://localhost:${port}/app/?scene=demo&room=${ROOM}`)
  await page.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 90000 })
  // The VR probe and the collab session both resolve async. Wait for the two to appear rather than for a
  // fixed time: on a loaded machine 1.5s is not enough for the chip, and the sweep runs 46px light. The
  // catch leaves the expects below to report which one never came.
  await page
    .waitForFunction(() => !!document.querySelector('.collab-status') && !!document.querySelector('[data-vr-button]'), undefined, {
      timeout: 60000,
      polling: 250,
    })
    .catch(() => {})

  const heavy = await page.evaluate(measure)
  expect(heavy.chip, 'the collab chip is present (else this sweep is 46px lighter than it claims)')
  expect(heavy.vr, 'the VR button is present (else this sweep is 40px lighter than it claims)')
  const heavyLabel = await page.evaluate(() => document.querySelector('[data-testid="project-menu"]')?.textContent?.trim() ?? null)
  console.log(`toolbar fit across the docked band - heaviest state, label "${heavyLabel}"`)
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 860 })
    await page.waitForTimeout(250)
    // a parallel src edit can full-reload the dev server out from under the sweep
    await page.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 60000 })
    const m = await page.evaluate(measure)
    const tag = `${width}px${m.mobile ? ' (mobile)' : ''}`
    expect(m.cut.length === 0, `${tag}: every control inside the window${m.cut.length ? ` - off-screen: ${m.cut.join(', ')}` : ''}`)
    expect(
      m.overlaps.length === 0,
      `${tag}: no two controls overlap${m.overlaps.length ? ` - stacked: ${m.overlaps.join('; ')}` : ''}`,
    )
    expect(!m.docScrolls, `${tag}: the document does not scroll sideways`)
    // reachability: the project menu in the docked row. On the mobile layout the "…" overflow, which
    // renders the same rows, is the only path, so the invariant is the same
    expect(m.button > 0, `${tag}: the project menu (every file action) is in the row (${m.button}px)`)
    if (!m.mobile) {
      expect(m.mark === width > MARK_FOLD, `${tag}: the mark ${width > MARK_FOLD ? 'shows' : 'has folded'}`)
      expect(!m.wordmark, `${tag}: no wordmark beside the mark (the tab names the app)`)
    }
  }

  // the menu is only complete if it holds the file actions the row gave up
  await page.setViewportSize({ width: 1000, height: 860 })
  await page.waitForTimeout(300)
  await page.click('[data-testid="project-menu"]')
  await page.waitForTimeout(250)
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.project-popover [data-command]')]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => b.getAttribute('data-command')),
  )
  for (const id of ['file.newProject', 'file.save', 'file.importProject', 'file.openDemo', 'file.exportProject']) {
    expect(items.includes(id), `the project menu at 1000px offers ${id} (has: ${items.join(', ') || 'nothing'})`)
  }
  await page.keyboard.press('Escape')

  // ── the left group's own heaviest state: solo, a long project name ──────────────────────────────────
  const solo = await browser.newPage({ viewport: { width: 1440, height: 860 } })
  await solo.addInitScript(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  await solo.goto(`http://localhost:${port}/app/`)
  await solo.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 90000 })
  await solo.evaluate((p) => window.__oip.store.renameProject(p), LONG_PROJECT)
  await solo.waitForTimeout(600)
  const soloName = await solo.evaluate(() => document.querySelector('.project-name')?.textContent)
  expect(soloName === LONG_PROJECT, `the solo sweep carries the long name (shows ${JSON.stringify(soloName)})`)
  console.log(`left group, solo - ${LONG_PROJECT.length}-char project name`)
  for (const width of WIDTHS) {
    await solo.setViewportSize({ width, height: 860 })
    await solo.waitForTimeout(250)
    await solo.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 60000 })
    const m = await solo.evaluate(measure)
    if (m.mobile) continue
    const tag = `${width}px solo`
    expect(m.overlaps.length === 0, `${tag}: no two controls overlap${m.overlaps.length ? ` - stacked: ${m.overlaps.join('; ')}` : ''}`)
    expect(m.project >= PROJECT_FLOOR, `${tag}: the project name stays readable (${m.project}px, floor ${PROJECT_FLOOR})`)
  }
  await solo.close()
  // ── the same ladder in the desktop shell ────────────────────────────────────────────────────────
  // window.oipMenu is what DESKTOP_SHELL reads (editor/desktop/desktopMenuBridge.ts), so stubbing it gives the
  // real .desktop-shell / .desktop-mac classes and therefore the real CSS. It cannot reproduce the
  // window-controls inset (env(titlebar-area-*) needs a real Electron window, and reads 0 here), so
  // this pass judges the shell-only rules (what the row keeps and what it cuts) and leaves the inset
  // arithmetic to verify-desktop-titlebar.mjs, which drives the actual window.
  const shell = await browser.newPage({ viewport: { width: 1440, height: 860 } })
  await shell.addInitScript(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  await shell.addInitScript(() => {
    window.oipMenu = { platform: 'win32', onCommand: () => () => {}, setMenu() {}, setMenuEnabled() {}, showAppMenu() {} }
  })
  await shell.goto(`http://localhost:${port}/app/?scene=demo`)
  await shell.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 90000 })
  await shell.waitForTimeout(600)

  for (const width of [1440, 1201, 1200, 940, 900, 821]) {
    await shell.setViewportSize({ width, height: 860 })
    await shell.waitForTimeout(250)
    await shell.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 60000 })
    const m = await shell.evaluate(() => {
      const btn = document.querySelector('.toolbar-menu-btn')
      const r = btn?.getBoundingClientRect()
      return {
        isShell: document.querySelector('.app').classList.contains('desktop-shell'),
        w: Math.round(r?.width ?? 0),
        h: Math.round(r?.height ?? 0),
      }
    })
    expect(m.isShell, `${width}px shell: the stub put the app in desktop-shell mode`)
    // 24x24 is the mark's own size; anything near it means the button still reads as a button
    expect(m.w >= 24 && m.h >= 24, `${width}px shell: the menu button keeps a usable target (${m.w}x${m.h})`)
  }
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures ? `\nFAIL (${failures})` : '\nPASS')
process.exit(failures ? 1 : 0)
