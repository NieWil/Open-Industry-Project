// What the part guides' scripts share (e2e/guide-part-*.mjs): the moves a reader makes in the Part Editor and the
// scene. Each guide starts where the one before it ends, so a script first replays the earlier guides' steps
// (exported by their scripts) against those guides' own pages, then follows its own page.
/* global window, document */

import { fieldLabel, labelled, sleep } from './_guide.mjs'

/** the onboarding tour, which a new project opens over the view: a reader skips it */
export const skipTour = async (page) => {
  await page.evaluate(() => { for (const b of document.querySelectorAll('.tut-skip')) b.click() })
  await sleep(300)
}

/** A row of the Scene dock by its exact name. */
export const treeRow = (page, label) => page.locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${label}$`) }) }).first()

/** The Inspector's status line that contains `text`. */
export const hint = (page, text) => page.locator('.inspector-hint', { hasText: text }).first()

/** An Inspector field by its label (a badge such as "write BOOL" may follow it). */
export const field = (page, label) => page.locator('label.field', { has: page.locator('.field-label', { hasText: fieldLabel(label) }) }).first()

/** An Inspector group by its title, opened if it is folded; the group's element. */
export async function openGroup(page, title) {
  const head = page.locator('.inspector-group-head', { hasText: labelled(title) }).first()
  await head.waitFor({ timeout: 10000 })
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
  return head.locator('xpath=..')
}

/** Type `value` into an Inspector field and press Enter, as a reader does. */
export async function typeInto(page, label, value) {
  const input = field(page, label).locator('input').first()
  await input.waitFor({ timeout: 10000 })
  await input.fill(String(value))
  await input.press('Enter')
  await sleep(300)
}

/** Pick `option` (its visible text) in an Inspector field's dropdown. */
export async function choose(page, label, option) {
  await field(page, label).locator('select').first().selectOption({ label: option })
  await sleep(500)
}

/** A part's package as the editor holds it: name, category, nodes, joints, bounds and behavior. */
export const pkgOf = (page, id) =>
  page.evaluate((id) => {
    const p = window.__oip.getPackage(id)
    return p && {
      name: p.name,
      category: p.category,
      links: p.geometry.links.map((l) => ({ name: l.name, parent: l.parent ?? null, kind: l.shape.kind, hidden: !!l.hidden, size: l.shape.size, offset: l.offset })),
      joints: p.geometry.joints ?? [],
      bounds: p.geometry.bounds,
      behavior: p.behavior,
    }
  }, id)

/** A placed part's position and params. */
export const partOf = (page, id) =>
  page.evaluate((id) => {
    const p = window.__oip.store.getState().scene.parts.find((q) => q.id === id)
    return p && { position: p.position, params: p.params }
  }, id)

/** Select a placed part and show the Inspector. */
export async function select(page, id) {
  await page.evaluate((id) => {
    window.__oip.store.setState({ selectedIds: [id] })
    window.__oip.store.revealPanel('inspector')
  }, id)
  await sleep(300)
}

/** Import part > A model..., with `file` (the desktop's three-choice menu, then the system file picker). */
export async function importModel(page, { expect, says }, file) {
  const button = page.getByTestId('catalog-import')
  expect((await button.innerText()).trim() === says('Import part'), 'the Parts dock has Import part')
  await button.click()
  const item = page.getByTestId('catalog-import-model')
  await item.waitFor({ timeout: 5000 })
  expect((await item.innerText()).trim() === says('A model…'), 'Import part offers "A model…"')
  const chooser = page.waitForEvent('filechooser', { timeout: 10000 })
  await item.click()
  await (await chooser).setFiles(file)
}

/** A card dragged from a Parts dock tab to `at` (fractions of the view), as a reader does; the id of the part it
 *  placed, or null. Each part gets its own spot: one dropped on another lands on it, not on the floor. */
export async function dragIn(page, { expect }, tab, name, at) {
  // the Parts dock shares its place with the PLC tab: a reader who was just in the PLC tab clicks Parts first
  await page.evaluate(() => window.__oip.store.revealPanel('catalog'))
  await page.locator('.catalog-tab', { hasText: labelled(tab) }).first().click()
  const card = page.locator('.catalog-card', { has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${name}$`) }) }).first()
  if (!expect((await card.count()) === 1, `the ${tab} tab has ${name}`)) return null
  // a tab with many cards scrolls: a card below the fold is out of the pointer's reach until it is scrolled to
  await card.scrollIntoViewIfNeeded()
  // the desktop's "Saved as a folder" notice can sit over the dock's first card: a reader closes it first
  await page.evaluate(() => { for (const b of document.querySelectorAll('.part-build-toast-close')) b.click() })
  const before = await page.evaluate(() => window.__oip.store.getState().scene.parts.map((p) => p.id))
  const cb = await page.locator('.viewport canvas').first().boundingBox()
  const kb = await card.boundingBox()
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2)
  await sleep(300)
  await page.mouse.down()
  await page.mouse.move(cb.x + cb.width * at[0], cb.y + cb.height * at[1], { steps: 20 })
  await sleep(300)
  await page.mouse.up()
  await sleep(1000)
  return page.evaluate((before) => window.__oip.store.getState().scene.parts.find((p) => !before.includes(p.id))?.id ?? null, before)
}

/** Right-click a placed part's row in the Scene dock and choose Open Part Editor; resolves once the editor is open. */
export async function openPartEditor(page, { expect, says }, name) {
  await treeRow(page, name).click({ button: 'right' })
  await sleep(400)
  const item = page.getByText(says('Open Part Editor'), { exact: true }).filter({ visible: true }).first()
  if (!expect(await item.isVisible().catch(() => false), `${name}'s right-click menu has Open Part Editor`)) return
  await item.click()
  await page.waitForFunction(() => window.__oip.store.getState().focusedPartId !== null, null, { timeout: 10000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000, polling: 200 })
  await skipTour(page)
}

/** ‹ Scene at the top of the Scene dock: out of the Part Editor, back to the scene. A part opened from the Parts dock
 *  shows it as a button of its own, one opened from a placed copy as the start of a breadcrumb. */
export async function backToScene(page) {
  await page.locator('.scene-def-scope-back, .scene-breadcrumb').first().click()
  await page.waitForFunction(() => { const s = window.__oip.store.getState(); return s.packageEdit === null && s.focusedPartId === null }, null, { timeout: 10000 })
  await skipTour(page)
}

/**
 * Record one part's joints from every simulation frame: the latest value of each, the lowest and highest seen, and a
 * timeline of [sim time, value] for one joint. A poll from here would miss a stroke that starts and ends between two
 * polls, and a wall-clock time would count the page's own stalls.
 */
export async function recordJoints(page, partId, joint) {
  await page.evaluate(({ partId, joint }) => {
    const sim = window.__oip.sim
    if (!window.__partGuideRec) {
      const prior = sim.onFrame
      sim.onFrame = (f) => {
        prior(f)
        const r = window.__partGuideRec
        const j = f.joints?.[r.partId]
        if (!j) return
        for (const k in j) {
          r.now[k] = j[k]
          r.min[k] = Math.min(r.min[k] ?? Infinity, j[k])
          r.max[k] = Math.max(r.max[k] ?? -Infinity, j[k])
        }
        if (r.joint in j && r.trace.length < 20000) r.trace.push([f.simTime, j[r.joint]])
      }
    }
    window.__partGuideRec = { partId, joint, now: {}, min: {}, max: {}, trace: [] }
  }, { partId, joint })
}

/** The recorded joint values: `{ now, min, max }`, each by joint name, and the one joint's `trace`. */
export const joints = (page) => page.evaluate(() => {
  const r = window.__partGuideRec
  return { now: { ...r.now }, min: { ...r.min }, max: { ...r.max }, trace: r.trace.slice() }
})

/**
 * The strokes in a joint trace between `a` and `b`: each one's start time (it left an end), end time (it reached the
 * other) and direction. A stroke still under way when the trace ends is left out.
 */
export function strokes(trace, a, b, eps = 1e-4) {
  const out = []
  let from = null
  let leftAt = null
  for (const [t, v] of trace) {
    const at = Math.abs(v - a) < eps ? 'a' : Math.abs(v - b) < eps ? 'b' : null
    if (at && from === null) from = at
    else if (at === null && from !== null && leftAt === null) leftAt = t
    else if (at && from !== null && at !== from) {
      out.push({ start: leftAt ?? t, end: t, to: at })
      from = at
      leftAt = null
    } else if (at && at === from) leftAt = null
  }
  return out
}

/** A program variable's value in the PLC panel's watch (10 Hz), by bare name or `Main.`-qualified; undefined if none. */
export const watched = (page, name) =>
  page.evaluate((name) => {
    const w = window.__oip.controller.plcWatch ?? {}
    const key = Object.keys(w).find((k) => k === name || k.endsWith(`.${name}`))
    return key === undefined ? undefined : w[key]
  }, name)

/** Play in the toolbar; resolves once the run has started. */
export async function play(page) {
  await page.locator('.run-button.play').click()
  await page.waitForFunction(() => window.__oip.store.getState().running, null, { timeout: 20000, polling: 100 })
}

/** Stop in the toolbar; resolves once the run has ended. */
export async function stop(page) {
  await page.locator('.run-button.stop').click()
  await page.waitForFunction(() => !window.__oip.store.getState().running, null, { timeout: 20000, polling: 100 })
}

/** Paste `program` into the PLC panel's code editor in place of what is there, as a reader does. */
export async function pasteProgram(page, program) {
  await page.evaluate(() => window.__oip.store.revealPanel('st'))
  const code = page.locator('.cm-content').first()
  await code.waitFor({ timeout: 30000 })
  await code.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(program)
  const tail = program.trim().split('\n').at(-1)
  await page.waitForFunction((tail) => window.__oip.store.getState().stProgram.includes(tail), tail, { timeout: 10000, polling: 100 })
}
