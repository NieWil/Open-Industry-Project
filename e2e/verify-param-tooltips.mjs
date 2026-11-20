// Gate: an Inspector property hover shows the part's doc line.
//
// The tooltip is assembled in ParamField (buildParamTooltip: label + description + range + default) and
// rendered as the field label's native `title`. A lookup keyed as `${part.type}.${key}` never finds the
// description for an SDK package part, since every package part reports `type: 'part'` (keys like
// `box_spawner.mass` can't match). Nothing errors when that happens: a missing description just renders a
// shorter tooltip, so this asserts the rendered DOM rather than the data behind it. Unit tests cover the
// data (packageParams.test.ts, bundledPackageData.test.ts); only a real render shows the string reaches a
// `title`.
//
// Asserts:
//   A. package desc - a spawner's fields carry their package-authored `desc` in the title.
//   B. range+default - the host-derived part of the hover is still appended.
//   C. built-in rows - Name / Visible / Position carry theirs too. These are stored unqualified, so a
//                       type-prefixed lookup can never reach them.
//   D. building - a core PartType still resolves from the host table (the fallback path).
// Run: node e2e/verify-param-tooltips.mjs
/* global process, console, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()

let failed = false
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${msg}`)
  if (!ok) failed = true
}

/** every rendered property row's label text + its hover title */
const readRows = (page) =>
  page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.inspector .field-label, .inspector .rig-joint')) {
      // the label's own text, without its chips (a bound speed tag's `tag` badge on Speed)
      const own = (el.querySelector('.rig-joint-name') ?? el).cloneNode(true)
      for (const b of own.querySelectorAll('.field-badge')) b.remove()
      const label = own.textContent?.trim() ?? ''
      const title = el.getAttribute('title') ?? ''
      if (label) out.push({ label, title })
    }
    return out
  })

const find = (rows, label) => rows.find((r) => r.label.toLowerCase().startsWith(label.toLowerCase()))

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${port}/app/?scene=demo&nowebgpu`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })

  const ids = await page.evaluate(() => {
    const parts = window.__oip.store.getState().scene.parts
    return {
      spawner: parts.find((p) => p.packageId === 'oip.box-spawner')?.id ?? null,
      building: parts.find((p) => p.type === 'building')?.id ?? null,
    }
  })
  check(ids.spawner !== null, 'demo scene has a box spawner to inspect')

  // --- A + B + C: a package part -----------------------------------------------------------------------
  await page.evaluate((id) => window.__oip.store.select(id), ids.spawner)
  await page.waitForTimeout(500)
  const rows = await readRows(page)
  check(rows.length > 5, `spawner inspector rendered ${rows.length} labelled rows`)

  const bpm = find(rows, 'Feed rate')
  check(!!bpm, 'the "Feed rate" row is present')
  // A: the package's own sentence
  check(!!bpm && bpm.title.includes('halts the feed'), 'its hover carries the package-authored description')
  // B: and the host-derived part is still appended
  check(!!bpm && /Range: 0 [-–] 1000/.test(bpm.title), 'its hover still states the range')
  check(!!bpm && /Default: 45/.test(bpm.title), 'its hover still states the default')

  // the description is the part of the string that goes missing, so check a second, different kind of field:
  // a boolean whose desc warns that it overrides three sibling params
  const rand = find(rows, 'Random size')
  check(!!rand && rand.title.includes('IGNORE the three dimensions above'), 'a boolean field carries its description too')

  // C: the `_`-prefixed built-in rows, reachable only via the unqualified fallback
  const name = find(rows, 'Name')
  check(!!name && name.title.includes('scene tree'), 'the built-in Name row carries its description')
  const visible = find(rows, 'Visible')
  check(!!visible && visible.title.includes('still collides'), 'the built-in Visible row carries its description')
  const pos = find(rows, 'Position')
  check(!!pos && pos.title.includes('World position'), 'the built-in Position row carries its description')

  // --- F: a conveyor, the highest-traffic part in the app ------------------------------------------------
  // Its two most misread fields: speed (reversing is a negative speed, not a 180° rotation) and the setpoint
  // tag (bound-but-undriven reads 0, so a half-wired belt sits still rather than running as authored).
  const conveyorId = await page.evaluate(() => {
    const parts = window.__oip.store.getState().scene.parts
    return parts.find((p) => /belt-conveyor|roller-conveyor/.test(p.packageId ?? ''))?.id ?? null
  })
  if (conveyorId) {
    await page.evaluate((id) => window.__oip.store.select(id), conveyorId)
    await page.waitForTimeout(500)
    const cRows = await readRows(page)
    // match the label exactly: both unit variants are labelled 'Speed' (the unit is the field's suffix), and a
    // 'Speed' prefix could also match the FPM unit toggle ('PLC speed in FPM') above it, whose tooltip explains
    // units rather than reversing.
    const speed = cRows.find((r) => r.label === 'Speed')
    check(!!speed && speed.title.includes('Negative runs'), 'the conveyor Speed field explains that negative reverses flow')
    const stand = find(cRows, 'Stand height')
    check(!!stand && stand.title.includes('when you drop or snap'), 'Stand height explains that the host fills it in')
  } else {
    console.log('note: demo scene has no belt/roller conveyor; skipped the conveyor checks')
  }

  // --- E: the rig node panel -----------------------------------------------------------------------------
  // Its joint fields (Type / Axis X-Z / Min / Max) are the most jargon-dense in the editor: an axis is a
  // normalised direction in the node's rest frame, and the limits clamp whatever the behavior script
  // commands rather than rejecting it. None of that can be inferred from the labels.
  const rigNode = await page.evaluate(() => {
    const st = window.__oip.store.getState()
    for (const p of st.scene.parts) {
      if (p.type !== 'part') continue
      const pkg = window.__oip.getPackage?.(p.packageId)
      const geom = pkg?.geometry
      if (geom?.kind !== 'rig' || !geom.joints?.length) continue
      return { partId: p.id, linkName: geom.joints[0].link }
    }
    return null
  })
  if (rigNode) {
    await page.evaluate((r) => window.__oip.store.selectRigNode(r.partId, r.linkName), rigNode)
    // the panel is its own lazy chunk, preloaded only inside the Part Editor: from here it can take seconds to
    // arrive on a cold dev server, so wait for the panel itself rather than a fixed delay
    await page.waitForSelector('[data-testid="rig-node-panel"] .field-label', { timeout: 30000 })
    const rRows = await readRows(page)
    check(rRows.length > 3, `rig node "${rigNode.linkName}" rendered ${rRows.length} labelled rows`)

    const parent = find(rRows, 'Parent')
    check(!!parent && parent.title.includes('hangs off'), 'the rig Parent row explains what it is relative to')
    const type = find(rRows, 'Type')
    check(!!type && type.title.includes('prismatic slides'), 'the joint Type field explains revolute vs prismatic')
    const axis = find(rRows, 'Axis X')
    check(!!axis && axis.title.includes('normalized'), 'the joint Axis field explains that only the direction counts')
    const min = find(rRows, 'Min')
    check(!!min && min.title.includes('clamped'), 'the joint limit explains that a command past it is clamped')
    const jname = find(rRows, 'Name')
    check(!!jname && jname.title.includes('ctx.setJoint'), 'the joint Name row names the script call that drives it')
  } else {
    console.log('note: no jointed rig part in the demo scene; skipped the rig-panel checks')
  }

  // --- G: descriptions survive serialization -------------------------------------------------------------
  // A scene embeds its packages, so a saved scene carries its own tooltips. Package fields have been lost in
  // transit before (a collab room dropped packageId + params), and the loss goes unnoticed until someone
  // opens the file and finds the hovers gone.
  const saved = await page.evaluate(() => window.__oip.sceneFileText())
  check(saved.includes('halts the feed'), 'a saved scene still carries the package descriptions')

  // --- D: a core PartType, which still resolves from the host table ------------------------------------
  if (ids.building) {
    await page.evaluate((id) => window.__oip.store.select(id), ids.building)
    await page.waitForTimeout(500)
    const bRows = await readRows(page)
    const brightness = find(bRows, 'Brightness')
    check(!!brightness && brightness.title.includes('ambient light'), 'the building resolves its description from the host table')
  } else {
    console.log('note: demo scene has no building; skipped the host-table check')
  }
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nFAILED' : '\nPASSED')
process.exit(failed ? 1 : 0)
