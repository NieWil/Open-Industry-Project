// The top bar must tell the truth about its own controls.
//   node e2e/verify-toolbar-affordances.mjs
//
// Each check guards against the same kind of fault: the UI knows something the user cannot find out.
//
//   1. A scene file comes in through Import Project, which opens it as a new project (a project holds one
//      scene), so there is nothing to ask: the project that was open is kept in the projects list. Replacing
//      the active scene instead would clear the undo stack, leaving nothing to take it back with. Checked
//      here: a project menu row, no confirm, a reload into a project named after the file, the old project kept.
//   2. Pause is the resume (Play stays disabled for the whole run), so it must name its state and carry
//      aria-pressed. A fixed "Toggle Pause Simulation" label leaves the paused state only in a CSS highlight.
//   3. File actions grey out while the sim runs and must say why. A disabled control whose tooltip still
//      advertises what it would do reads as broken, not as blocked.
//   4. The GitHub link must not say "the desktop version", which is wrong in the desktop app that renders
//      this same row.
//   5. Every sim-speed rung can be asked for by name, not only reached by clicking the toolbar button
//      round (four clicks for 8x from 1x).
//
// None of these change a pixel of the scene, so no rendering gate can see them. They are assertions
// about labels, ARIA and one confirm, which is what this script reads.
/* global process, console, window, document, Buffer */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { afterReload, openProjectsList, projectMenuItem, projectRow, runProjectMenu } from './_projectMenu.mjs'
import { docNameFor, editSecret } from './_collabRoom.mjs'

const { port, vite } = await startServer()

let failures = 0
const expect = (cond, msg) => {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const settle = async (page) => {
  await page.waitForFunction(() => !!window.__oip?.store, undefined, { timeout: 90000 })
  await page.waitForTimeout(1200)
}
const btn = (page, sel) =>
  page.evaluate((s) => {
    const b = document.querySelector(s)
    return b && { title: b.title, aria: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), disabled: !!b.disabled }
  }, sel)
/** the project menu's row for command `id` (file.save / file.openDemo / ...), or null when the menu has no such row, read with the menu open */
const fileRow = async (page, id) => {
  const row = await projectMenuItem(page, id)
  const read = (await row.count()) ? { title: (await row.getAttribute('title')) ?? '', disabled: await row.isDisabled() } : null
  await page.keyboard.press('Escape')
  return read
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.addInitScript(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${port}/app/`, { timeout: 120000 })
  await settle(page)
  // the boot sync files document #1 off a promise chain: a new project needs it there to be kept beside
  await page.waitForFunction(() => window.localStorage.getItem('oip-web/document-id') !== null, undefined, { timeout: 30000, polling: 100 })

  // ── 1. a scene file through Import Project makes a new project, so it asks nothing and replaces nothing ──
  console.log('Import Project with a scene file: a new project, never a replacement')
  const beforeOpen = await page.evaluate(() => ({ name: window.__oip.store.getState().projectName, doc: window.localStorage.getItem('oip-web/document-id') }))
  let asked = null
  const onDialog = (d) => {
    asked = d.message()
    void d.dismiss()
  }
  page.on('dialog', onDialog)
  // One way in for project and scene files: the project import's input, and no separate scene picker (the
  // catalog's part import is another hidden json input, with a confirm of its own)
  expect((await page.locator('[data-testid="project-import"]').count()) === 1, 'one project-import input to drive')
  expect((await page.locator('[data-testid="scene-picker"]').count()) === 0, 'and no separate scene picker')
  // The row has no loose file or scene buttons at all: they are the project menu's rows.
  expect((await page.locator('.toolbar-files, .scene-actions').count()) === 0, 'the row has no loose file or scene buttons')
  await afterReload(page, async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 20000 }), runProjectMenu(page, 'file.importProject')])
    await chooser.setFiles({
      name: 'other-line.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 4, parts: [] })),
    })
  })
  await settle(page)
  page.off('dialog', onDialog)
  expect(asked === null, `opening a scene file asks nothing${asked ? ` (asked "${asked.slice(0, 70)}…")` : ''}`)
  const opened = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { name: s.projectName, doc: window.localStorage.getItem('oip-web/document-id'), parts: s.scene.parts.length }
  })
  expect(opened.name === 'other-line' && opened.parts === 0, `the file is a new project named after it, on screen (${opened.name}, ${opened.parts} parts)`)
  expect(opened.doc !== beforeOpen.doc, `...a different document (${beforeOpen.doc} -> ${opened.doc})`)
  await openProjectsList(page)
  expect((await projectRow(page, beforeOpen.name).count()) === 1, `the project that was open ("${beforeOpen.name}") is kept in the projects list`)
  await page.keyboard.press('Escape')
  // to the demo for the run checks below
  await page.goto(`http://localhost:${port}/app/?scene=demo`, { timeout: 120000 })
  await settle(page)

  // ── 2. Pause names its own state ────────────────────────────────────────────────────────────────
  console.log('Play / Pause: the paused state')
  const pauseIdle = await btn(page, '.run-button.pause')
  expect(pauseIdle.pressed === 'false', `pause reports aria-pressed while stopped (got ${pauseIdle.pressed})`)
  await page.click('.run-button.play')
  await page.waitForTimeout(1200)
  const pauseRunning = await btn(page, '.run-button.pause')
  expect(/pause/i.test(pauseRunning.title) && !/resume/i.test(pauseRunning.title), `running: pause offers "${pauseRunning.title}"`)
  expect(pauseRunning.pressed === 'false', 'running: aria-pressed is false')
  await page.click('.run-button.pause')
  await page.waitForTimeout(600)
  const pausePaused = await btn(page, '.run-button.pause')
  const playPaused = await btn(page, '.run-button.play')
  expect(await page.evaluate(() => window.__oip.store.getState().paused), 'the sim is actually paused')
  expect(/resume/i.test(pausePaused.title), `paused: pause offers "${pausePaused.title}"`)
  expect(/resume/i.test(pausePaused.aria ?? ''), `paused: the accessible name says resume ("${pausePaused.aria}")`)
  expect(pausePaused.pressed === 'true', 'paused: aria-pressed is true')
  // Play stays disabled, so it has to point at where the resume actually is
  expect(playPaused.disabled, 'paused: Play is still disabled')
  expect(/pause/i.test(playPaused.title), `paused: Play points at the resume ("${playPaused.title}")`)

  // ── 3. A greyed file action says why ─────────────────────────────────────────────────────────────
  console.log('Project menu: why a greyed row is greyed')
  // Import Project, not Open Demo: this runs inside the example, whose menu leaves Open Demo out (it would
  // reopen what is already open)
  expect((await fileRow(page, 'file.openDemo')) === null, 'inside the example: no Open Demo row')
  for (const id of ['file.importProject']) {
    const b = await fileRow(page, id)
    expect(b.disabled, `running: ${id} is disabled`)
    expect(/stop the simulation/i.test(b.title), `running: ${id} explains itself - "${b.title}"`)
  }
  const save = await fileRow(page, 'file.save')
  // Save is the project save, not a download of a single scene file
  expect(!save.disabled && /save the project/i.test(save.title), `running: Save stays available - "${save.title}"`)
  await page.click('.run-button.stop')
  await page.waitForTimeout(800)
  const importIdle = await fileRow(page, 'file.importProject')
  expect(!importIdle.disabled, 'stopped: Import Project is enabled again')
  // "New" means a new project, filed beside the one you leave. No row empties this project in place (a
  // "Clear Scene and Program…"): New Project does the common job without destroying anything, and
  // select + Delete the rare one.
  const newProject = await fileRow(page, 'file.newProject')
  expect(newProject !== null && !newProject.disabled, 'New Project is in the menu, enabled')
  expect((await fileRow(page, 'file.new')) === null, 'no row clears the project in place')

  // ── 4. the GitHub link names a destination, not a surface ────────────────────────────────────────
  // It lives in the Help menu, beside the shortcuts and the tour, so the one control that leaves
  // the app does not look like the mode toggles.
  console.log('GitHub link (Help menu)')
  await page.evaluate(() => document.querySelector('.help-button').click())
  await page.waitForTimeout(200)
  const gh = await page.evaluate(() => {
    const a = document.querySelector('.help-popover a[role="menuitem"]')
    return a && { text: a.textContent.trim(), href: a.href, target: a.target }
  })
  expect(gh !== null, 'the Help menu carries the GitHub link')
  expect(gh && !/desktop version/i.test(gh.text), `the label does not claim "the desktop version" - "${gh?.text}"`)
  expect(gh && /github\.com/.test(gh.href) && gh.target === '_blank', 'it still points at GitHub, in a new tab')
  expect(
    (await page.evaluate(() => document.querySelectorAll('.toolbar-right > a, .toolbar-right > .icon-toggle.shortcuts-button').length)) === 0,
    'and the row no longer carries a loose GitHub or shortcuts icon of its own',
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  // ── 5. the tour has a menu entry, not only a button ──────────────────────────────────────────────
  console.log('Tutorial in the command registry')
  const tut = await page.evaluate(() => {
    const { COMMANDS, DESKTOP_MENU } = window.__oip.commands ?? {}
    if (!COMMANDS) return null
    const cmd = COMMANDS.find((c) => c.id === 'help.tutorial')
    const help = DESKTOP_MENU.find((s) => s.label === 'Help')
    return { exists: !!cmd, label: cmd?.label, inMenu: !!help?.items?.some((i) => i.command === 'help.tutorial') }
  })
  if (tut === null) {
    console.log('  note: window.__oip.commands is not exposed - menu membership checked in commands.test.ts instead')
  } else {
    expect(tut.exists, `help.tutorial is a real command ("${tut.label}")`)
    expect(tut.inMenu, 'and the desktop Help menu offers it')
  }

  // ── 5b. every speed rung can be asked for, not just cycled into ─────────────────────────────────
  // Through the palette: the toolbar button cycles and the menu lists the rungs, but neither is what a
  // keyboard user reaches for mid-run.
  console.log('Speed rungs in the command palette')
  await page.click('.run-button.play')
  await page.waitForTimeout(1000)
  const startScale = await page.evaluate(() => window.__oip.store.getState().timeScale)
  await page.keyboard.press('Control+Shift+P')
  await page.waitForTimeout(400)
  await page.keyboard.type('speed')
  await page.waitForTimeout(400)
  const rungs = await page.evaluate(() =>
    [...document.querySelectorAll('.palette-item')].map((el) => el.querySelector('.palette-label')?.textContent.trim()),
  )
  for (const want of ['0.5', '1', '2', '4', '8']) {
    expect(rungs.some((r) => r?.includes(`${want}×`)), `the palette offers ${want}× (found: ${rungs.join(' | ')})`)
  }
  // and picking one must actually move the clock, not just look right in a list
  const eight = page.locator('.palette-item', { hasText: '8×' }).first()
  await eight.click()
  await page.waitForTimeout(800)
  const picked = await page.evaluate(() => window.__oip.store.getState().timeScale)
  expect(picked === 8, `picking 8× sets the rate (${startScale}× -> ${picked}×)`)
  expect(
    (await page.evaluate(() => document.querySelector('.run-button.speed')?.textContent.trim()))?.startsWith('8'),
    'and the toolbar button agrees',
  )
  await page.click('.run-button.stop')
  await page.waitForTimeout(600)

  // ── 5c. keyboard focus survives an ordinary state change ────────────────────────────────────────
  // Guards against a component declared inside Toolbar's render (as a <FileButton/> was): that is a new
  // component type every render, so React replaces the buttons whenever the editor state moves, and a
  // keyboard user on the control drops to <body> on something as small as a selection. The project
  // menu's button is the row's file control, so it is the one checked.
  console.log('Project menu: focus survives a re-render')
  await page.evaluate(() => document.querySelector('[data-testid="project-menu"]').focus())
  await page.evaluate(() => {
    const s = window.__oip.store
    s.select(s.getState().scene.parts[0]?.id ?? null)
  })
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__oip.store.select(null))
  await page.waitForTimeout(200)
  const focused = await page.evaluate(() =>
    document.activeElement === document.body ? '<body>' : (document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent),
  )
  expect(focused === 'project-menu', `the project menu keeps focus across a select + deselect (focus is on: ${focused})`)

  // ── 5d. the Help menu is a menu to a keyboard too ───────────────────────────────────────────────
  console.log('Help menu: keyboard')
  // the tour's "shortcuts" step points at wherever the reference lives (tutorial/steps.ts), which is here
  expect(
    (await page.locator('.help-button[data-tutorial="shortcuts"]').count()) === 1,
    'the Help button carries the tour\'s "shortcuts" anchor',
  )
  await page.focus('.help-button')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const first = await page.evaluate(() => document.activeElement?.closest('.help-popover') !== null && document.activeElement?.getAttribute('role'))
  expect(first === 'menuitem', `opening it from the keyboard puts focus on its first item (${first})`)
  const before = await page.evaluate(() => document.activeElement?.textContent)
  await page.keyboard.press('ArrowDown')
  const after = await page.evaluate(() => document.activeElement?.textContent)
  // the first row is the command palette (the web's only other way in is its chord), then Keyboard Shortcuts
  expect(/command palette/i.test(before ?? ''), `the first Help row is the command palette ("${before}")`)
  expect(before !== after && /shortcuts/i.test(after ?? ''), `ArrowDown moves to the next item ("${after}")`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const back = await page.evaluate(() => ({ open: !!document.querySelector('.help-popover'), on: document.activeElement?.getAttribute('aria-label') }))
  expect(!back.open && back.on === 'Help', `Escape closes it and hands focus back to the Help button (${JSON.stringify(back)})`)
  await page.evaluate(() => document.querySelector('.help-button').click())
  await page.waitForTimeout(200)
  await page.evaluate(() => [...document.querySelectorAll('.help-popover [role="menuitem"]')].find((i) => /command palette/i.test(i.textContent))?.click())
  const palette = await page
    .waitForFunction(() => !!document.querySelector('.palette'), null, { polling: 250, timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  expect(palette, 'Help > Command Palette opens the palette')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.palette'), null, { polling: 250, timeout: 15000 }).catch(() => {})

  // ── 5d'. two ways into one dialog, each opening its own tab ─────────────────────────────────────
  // The dialog behind "Keyboard Shortcuts" is Settings (Preferences / Project / Keyboard). Settings has a
  // toolbar button of its own, since a Help row is not where anyone looks for preferences. Each entry
  // must open its own tab, or the pair is two labels for one thing.
  console.log('Settings button and Help > Keyboard Shortcuts')
  // Polled on a timer, not waitForSelector: a headless page here can run below 1 fps, and a rAF-polled
  // visibility wait then times out on a dialog that is already mounted.
  const helpRows = async () => {
    await page.evaluate(() => document.querySelector('.help-button').click())
    await page
      .waitForFunction(() => document.querySelectorAll('.help-popover [role="menuitem"]').length > 0, null, { polling: 250, timeout: 15000 })
      .catch(() => {})
    return page.evaluate(() => [...document.querySelectorAll('.help-popover [role="menuitem"]')].map((i) => i.textContent.trim()))
  }
  const openFromHelp = async (label) => {
    await helpRows()
    await page.evaluate((re) => {
      const item = [...document.querySelectorAll('.help-popover [role="menuitem"]')].find((i) => new RegExp(re, 'i').test(i.textContent))
      item?.click()
    }, label)
    return settingsTab()
  }
  const settingsTab = async () => {
    const tab = await page
      .waitForFunction(() => document.querySelector('[data-shortcuts-overlay]')?.getAttribute('data-settings-tab'), null, { polling: 250, timeout: 15000 })
      .then((h) => h.jsonValue())
      .catch(() => null)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-shortcuts-overlay]'), null, { polling: 250, timeout: 15000 }).catch(() => {})
    return tab
  }
  const rows = await helpRows()
  await page.keyboard.press('Escape')
  expect(!rows.some((t) => /^settings/i.test(t)), `Help no longer carries Settings (${rows.join(' | ')})`)
  await page.evaluate(() => document.querySelector('.settings-button').click())
  const prefsTab = await settingsTab()
  expect(prefsTab === 'preferences', `the Settings button opens the dialog on Preferences (${prefsTab})`)
  const keysTab = await openFromHelp('keyboard shortcuts')
  expect(keysTab === 'shortcuts', `Help → Keyboard Shortcuts still opens it on Keyboard (${keysTab})`)

  // ── 5e. tooltips print the active keymap, not a chord typed into a string ───────────────────────
  // A hand-typed chord goes stale once Settings rebinds keys, and can be wrong to begin with: a secondary
  // binding ("Shift+R" for Pilot), or Ctrl+Shift+F11 shown on a Mac.
  console.log('Tooltips follow a rebinding')
  // done with the first page: two apps booting side by side in one headless browser can starve the
  // second past its settle timeout
  await page.close()
  const rebound = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await rebound.addInitScript(() => {
    window.localStorage.setItem('oip-web/tutorial-done', '1')
    window.localStorage.setItem('oip-web/keymap', JSON.stringify({ 'pilot.enter': ['KeyJ'] }))
  })
  await rebound.goto(`http://localhost:${port}/app/?scene=demo`)
  await settle(rebound)
  const pilot = await btn(rebound, '.icon-toggle[aria-label="Pilot Mode"]')
  expect(/\(J\)/.test(pilot?.title ?? ''), `Pilot names the rebound key - "${pilot?.title}"`)
  await rebound.close()

  // ── 6. "View only" must not look like a button ───────────────────────────────────────────────────
  console.log('View-only badge')
  const view = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await view.addInitScript(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  await view.goto(`http://localhost:${port}/app/?scene=demo&view=1&room=${docNameFor(editSecret('affordance-gate'))}`)
  await settle(view)
  const badge = await view.evaluate(() => {
    const el = document.querySelector('.collab-viewonly')
    if (!el) return null
    const b = getComputedStyle(el)
    const anyBtn = document.querySelector('.toolbar button:not(.run-button):not(.overflow-button)')
    const a = anyBtn ? getComputedStyle(anyBtn) : null
    return {
      radius: b.borderRadius,
      bg: b.backgroundColor,
      btnBg: a?.backgroundColor ?? null,
      btnRadius: a?.borderRadius ?? null,
      tag: el.tagName,
    }
  })
  expect(badge !== null, 'the view-only badge renders on a read-only link')
  if (badge) {
    expect(badge.tag === 'SPAN', 'it is not a button element')
    expect(badge.bg !== badge.btnBg, `its fill differs from the buttons beside it (${badge.bg} vs ${badge.btnBg})`)
    expect(badge.radius !== badge.btnRadius, `and so does its shape (${badge.radius} vs ${badge.btnRadius})`)
  }

  // ── 7. a view link leaves out what it can never press ────────────────────────────────────────────
  // Greying New/Save/Load/Demo and the tour instead would leave half the bar dead on the one surface where
  // none of it can ever be enabled. Share and the scene switcher are left out the same way. The project
  // menu stays: a viewer can still export, or copy the room into a project of their own, and what it
  // cannot do is behind a click rather than greyed across the bar.
  console.log('View link: no dead controls')
  const ro = await view.evaluate(() => ({
    files: document.querySelectorAll('.toolbar-files button').length,
    overflow: (document.querySelector('.overflow-button')?.getBoundingClientRect().width ?? 0) > 0,
    disabled: [...document.querySelectorAll('.toolbar button:disabled')]
      .filter((b) => b.getBoundingClientRect().width > 0 && !b.classList.contains('run-button'))
      .map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
  }))
  expect(ro.files === 0, `no file buttons (${ro.files})`)
  expect(!ro.overflow, 'and no "…" menu with nothing in it')
  expect(ro.disabled.length === 0, `no greyed controls outside the transport (${ro.disabled.join(', ') || 'none'})`)
  await view.evaluate(() => document.querySelector('.help-button').click())
  await view.waitForTimeout(200)
  const roHelp = await view.evaluate(() => [...document.querySelectorAll('.help-popover [role="menuitem"]')].map((i) => i.textContent.trim()))
  expect(!roHelp.some((t) => /tutorial/i.test(t)), `the Help menu leaves the tour out (${roHelp.join(' | ')})`)
  expect(roHelp.some((t) => /shortcuts/i.test(t)), 'and keeps the shortcuts')
  expect(await view.evaluate(() => !!document.querySelector('.settings-button')), 'and Settings stays (preferences are this browser\'s own)')
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures ? `\nFAIL (${failures})` : '\nPASS')
process.exit(failures ? 1 : 0)
