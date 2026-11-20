// Follows the part guide guides/part-product/index.html (/guides/part-product/) step by step, in the real desktop
// shell. It starts where guides/part-feedback/ ends, so it first replays the three guides before it, each against its
// page.
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the rule).
//
//   step 1  a box node added under Blade, renamed, the page's Offset and Box size typed in, hidden: it is a hidden box
//           under Blade, and it covers the blade as drawn (its thickness, its top edge, its width); at rest its top is
//           under the rollers, raised above them
//   step 2  a Box and a Photo Eye dragged in from the tabs the page names, the page's table typed in
//   step 3  the page's program pasted, no errors, the eye's Presence Tag connected
//   step 4  Play: the box stops against the raised blade, where the page says its centre stands, in the eye's beam;
//           3 s of simulated time later the blade sinks and the box rides on past it; the blade rises 1 s after the box
//           has left the beam
//   trouble the Parent field the troubleshooting names, and the conveyor's end
//
// Usage:
//   node e2e/guide-part-product.mjs                 follow the guide; exit 0 = it works as written
//   node e2e/guide-part-product.mjs --shots <dir>   also save a screenshot per step
//   node e2e/guide-part-product.mjs --images        also retake the page's pictures (guides/part-product/img/)
//
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window, setTimeout */

import { pathToFileURL } from 'node:url'
import { guidePictures, guideTest, labelled, launchShell, shot as shotTo, sleep } from './_guide.mjs'
import { backToScene, dragIn, field, openGroup, openPartEditor, partOf, pasteProgram, pkgOf, play, recordJoints, select, stop, treeRow, typeInto } from './_partGuide.mjs'
import { followPartModel, partModelPage } from './guide-part-model.mjs'
import { followPartMotion, partMotionPage } from './guide-part-motion.mjs'
import { followPartFeedback, partFeedbackPage } from './guide-part-feedback.mjs'

const nums = (s) => s.split(',').map((v) => Number(v.trim()))

/** This guide's page: its checks and everything the steps read from it. */
export function partProductPage(argv = process.argv.slice(2)) {
  const g = guideTest('part-product')
  const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
  const set = Object.fromEntries([...g.html.matchAll(/<tr><td>(Offset|Box size)<\/td><td class="m">([^<]+)<\/td>/g)].map((m) => [m[1], nums(m[2])]))
  return {
    ...g,
    pics: guidePictures('part-product', g, argv),
    shot: (page, name) => shotTo(page, shotsDir, `part-product-${name}`),
    /** step 1's table */
    set,
    /** step 1's node name */
    nodeName: /type <b>(\w+)<\/b> and press Enter/.exec(g.html)?.[1],
    program: g.programs[0],
    hold: Number(/Hold\(.*PT := T#(\d+)s\)/.exec(g.programs[0] ?? '')?.[1]),
    clear: Number(/Clear\(.*PT := T#(\d+)s\)/.exec(g.programs[0] ?? '')?.[1]),
  }
}

/** The blade's drawn pieces, measured in the part's frame: the low and high corners of their bounding box. */
const bladeBox = (page, stopId) =>
  page.evaluate((stopId) => {
    const part = window.__oip.store.getState().scene.parts.find((p) => p.id === stopId)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    window.__oip.view.scene.traverse((o) => {
      if (!o.isMesh || !/^Blade(Middle|Corner)/.test(o.name) && !/^Blade(Middle|Corner)/.test(o.parent?.name ?? '')) return
      const pos = o.geometry.attributes.position
      const v = o.position.clone()
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], v.getComponent(k))
          hi[k] = Math.max(hi[k], v.getComponent(k))
        }
      }
    })
    return { lo: lo.map((x, k) => x - part.position[k]), hi: hi.map((x, k) => x - part.position[k]) }
  }, stopId)

/** Sample the run every 100 ms until `until(samples)` or `ms`: sim time, the box's X, BoxAtStop, the blade's joint. */
async function sample(page, boxId, ms, until = () => false) {
  const out = []
  const end = Date.now() + ms
  while (Date.now() < end && !until(out)) {
    out.push(await page.evaluate((boxId) => {
      const w = window.__oip.controller.plcWatch ?? {}
      const eye = w[Object.keys(w).find((k) => /(^|\.)BoxAtStop$/.test(k))]
      const r = window.__partGuideRec
      return { t: r.trace.at(-1)?.[0] ?? 0, x: window.__oip.controller.livePosition(boxId)?.[0] ?? null, eye, j: r.now.raise }
    }, boxId))
    await new Promise((r) => setTimeout(r, 100))
  }
  return out
}

/** Steps 1 to 4 on guide 3's end state. */
export async function followPartProduct(page, g, prior) {
  const { expect, says, pics, shot, set, nodeName, wiring, program, hold, clear } = g
  const partName = says('Blade Stop 900')
  const stopId = prior.stopId
  expect(set.Offset?.length === 3 && set['Box size']?.length === 3 && !!nodeName && wiring.length === 4 && !!program && hold > 0 && clear > 0, `the page has its collider table, its node name, its scene table and its program (${JSON.stringify(set)})`)

  // ---- step 1: give the blade a collider ----
  await openPartEditor(page, g, partName)
  const pkgId = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.packageId, stopId)
  const blade = await bladeBox(page, stopId)
  await treeRow(page, says('Blade')).click()
  await sleep(300)
  await openGroup(page, 'Node')
  await field(page, says('New node')).locator('select').selectOption(says('box'))
  await page.getByRole('button', { name: says('Add child node') }).click()
  await page.waitForFunction((id) => window.__oip.getPackage(id).geometry.links.some((l) => l.parent === 'Blade' && l.shape.kind === 'box'), pkgId, { timeout: 10000 })
  const added = (await pkgOf(page, pkgId)).links.find((l) => l.parent === 'Blade' && l.kind === 'box')
  expect(!!added && (await page.locator('.inspector').innerText()).trim().startsWith(added.name), `a box node appears under Blade, selected (${added?.name})`)
  await treeRow(page, added.name).locator('.tree-name').dblclick()
  await sleep(300)
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(nodeName)
  await page.keyboard.press('Enter')
  await page.waitForFunction(({ id, name }) => window.__oip.getPackage(id).geometry.links.some((l) => l.name === name), { id: pkgId, name: nodeName }, { timeout: 10000 })
  expect((await treeRow(page, nodeName).count()) === 1, `double-clicking its name renames it ${nodeName}`)
  const offsetInputs = page.locator('.field', { has: page.locator('.field-label', { hasText: labelled(says('Offset')) }) }).first().locator('input')
  for (let i = 0; i < 3; i++) {
    await offsetInputs.nth(i).fill(String(set.Offset[i]))
    await offsetInputs.nth(i).press('Enter')
    await sleep(200)
  }
  await page.locator('.fold-title, .inspector-group-head', { hasText: says('Box size') }).first().waitFor({ timeout: 10000 })
  for (const [i, ax] of ['X', 'Y', 'Z'].entries()) {
    const input = page.locator('label.field', { has: page.locator('.field-label', { hasText: new RegExp(`^${ax}$`) }) }).locator('input').last()
    await input.fill(String(set['Box size'][i]))
    await input.press('Enter')
    await sleep(200)
  }
  await treeRow(page, nodeName).locator('.tree-eye').click()
  await sleep(400)
  const pk = await pkgOf(page, pkgId)
  const col = pk.links.find((l) => l.name === nodeName)
  expect(col?.parent === 'Blade' && col.kind === 'box' && col.hidden, `${nodeName} is a hidden box under Blade (${JSON.stringify(col)})`)
  expect(col?.offset.every((v, i) => Math.abs(v - set.Offset[i]) < 1e-6) && col.size.every((v, i) => Math.abs(v - set['Box size'][i]) < 1e-6), `its Offset is ${set.Offset.join(', ')} and its Box size ${set['Box size'].join(', ')}`)
  // the collider in the part's frame: the model's origin (body's offset; Blade sits on it at 0) plus its own offset
  const body = pk.links.find((l) => l.name === 'body').offset
  const c = col.offset.map((v, i) => body[i] + v)
  const cLo = c.map((v, i) => v - col.size[i] / 2)
  const cHi = c.map((v, i) => v + col.size[i] / 2)
  const mm = (v) => (v * 1000).toFixed(1)
  expect(cLo[0] <= blade.lo[0] + 0.001 && cHi[0] >= blade.hi[0] - 0.001 && cHi[0] - cLo[0] - (blade.hi[0] - blade.lo[0]) < 0.005, `it is as thick as the blade and a little more (blade ${mm(blade.lo[0])} to ${mm(blade.hi[0])} mm, collider ${mm(cLo[0])} to ${mm(cHi[0])})`)
  expect(Math.abs(cHi[1] - blade.hi[1]) < 0.002, `its top is the blade's top edge (${mm(cHi[1])} and ${mm(blade.hi[1])} mm)`)
  expect(says('the top 8 cm of it') && Math.abs(col.size[1] - 0.08) < 1e-9, 'it is the top 8 cm of the blade')
  const conveyorY = 0.8
  const stopY = (await partOf(page, stopId)).position[1]
  const restTop = stopY + cHi[1]
  const raisedTop = restTop + 0.06
  expect(restTop < conveyorY && Math.abs(raisedTop - conveyorY - 0.05) < 0.003, `lowered, its top is under the rollers (${mm(conveyorY - restTop)} mm); raised, ${mm(raisedTop - conveyorY)} mm above them`)
  const parent = await field(page, says('Parent')).locator('option').allTextContents().catch(() => [])
  expect(parent.includes('Blade'), `its Parent field offers Blade, as the troubleshooting says (${parent.join(', ')})`)
  await page.mouse.move(0, 0)
  await sleep(200)
  await pics.ui(page, 'collider', [treeRow(page, partName), treeRow(page, 'collider')], { pad: 4 })
  await shot(page, 'step1-collider')

  // ---- step 2: add a box and a photo eye ----
  await backToScene(page)
  const ids = { [says('Box')]: await dragIn(page, g, says('Products'), says('Box'), [0.35, 0.5]), [says('Photo Eye')]: await dragIn(page, g, says('Devices'), says('Photo Eye'), [0.6, 0.42]) }
  expect(Object.values(ids).every(Boolean), 'a Box and a Photo Eye are placed')
  for (const row of wiring) {
    const id = ids[row.part]
    if (!expect(!!id, `the table's part "${row.part}" is one the steps placed`)) continue
    await select(page, id)
    if (row.field === 'Presence Tag') {
      await openGroup(page, says('Comms'))
      await typeInto(page, row.field, row.address)
      continue
    }
    const inputs = page.locator('.field', { has: page.locator('.field-label', { hasText: labelled(row.field) }) }).first().locator('input')
    const values = nums(row.address)
    for (let i = 0; i < values.length; i++) {
      await inputs.nth(i).fill(String(values[i]))
      await inputs.nth(i).press('Enter')
      await sleep(200)
    }
  }
  const box = await partOf(page, ids.Box)
  const eye = await partOf(page, ids['Photo Eye'])
  const eyeRot = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id).rotationY, ids['Photo Eye'])
  expect(box.position.join(',') === '-1.5,1,0' && Math.abs(box.params.height / 2 + conveyorY - box.position[1]) < 1e-9 && says("the rollers' 0.8 plus half its 0.4 height") !== '', `the box stands on the rollers, its centre at Y ${box.position[1]} (its height ${box.params.height})`)
  expect(eye.position.join(',') === '0.15,0.78,0.56' && Math.abs(eyeRot - Math.PI) < 1e-6 && eye.params.tag === 'BoxAtStop', `the photo eye is at 0.15, 0.78, 0.56, turned 180°, its Presence Tag BoxAtStop (${eye.position}, ${eyeRot})`)
  const heldX = 0.5 + blade.lo[0] - box.params.length / 2
  expect(says('its centre stands at about 0.15') && Math.abs(heldX - 0.15) < 0.01 && box.params.length === 0.6, `held against the blade, the box's centre would stand at ${heldX.toFixed(3)}`)

  // ---- step 3: write the program ----
  await pasteProgram(page, program)
  await sleep(1500)
  expect((await page.locator('[data-testid="st-error"]').count()) === 0, 'the PLC panel reports no errors')
  await select(page, ids['Photo Eye'])
  await openGroup(page, says('Comms'))
  await sleep(1500)
  const mark = await page.locator('[data-testid="tag-warn"], [data-testid="tag-status"]').first().evaluate((e) => `${e.textContent} ${e.title}`)
  expect(mark.startsWith('✓'), `the eye's Presence Tag is connected (${mark})`)

  // ---- step 4: run it ----
  await recordJoints(page, stopId, 'raise')
  await play(page)
  const max = 0.06
  const isHeld = (s) => s.x !== null && Math.abs(s.x - heldX) < 0.015 && Math.abs(s.j - max) < 1e-6
  // to the first sample with the box held, then a picture with the run paused
  const arrive = await sample(page, ids.Box, 20000, (s) => s.length > 0 && isHeld(s.at(-1)))
  if (expect(arrive.length > 0 && isHeld(arrive.at(-1)), `the box rides to the blade and stops against it, its centre at ${arrive.at(-1)?.x?.toFixed(3)}`)) {
    await sleep(800)
    await page.locator('.run-button.pause').click()
    await pics.scene(page, 'held', { px: 1.9, py: 1.75, pz: 2.0, tx: 0.15, ty: 0.85, tz: 0 })
    await shot(page, 'step4-held')
    await page.locator('.run-button.pause').click()
  }
  const run = [...arrive, ...(await sample(page, ids.Box, 25000, (s) => s.length > 5 && s.at(-1).x > 1.2 && Math.abs(s.at(-1).j - max) < 1e-6))]
  const heldAt = run.filter(isHeld)
  const eyeOn = heldAt.every((s) => s.eye === true)
  expect(heldAt.length > 0 && eyeOn, 'the photo eye sees the held box')
  const seen = run.find((s) => s.eye === true)?.t ?? 0
  const dropped = run.find((s) => s.t > seen && s.j < max - 1e-6)
  const heldFor = dropped ? dropped.t - seen : 0
  // a sample every 100 ms, so either end can be up to that late
  expect(says('3 seconds after the beam first caught it') && Math.abs(heldFor - hold) < 0.2, `${hold} s of simulated time after the beam first caught the box, the blade sinks (${heldFor.toFixed(2)} s)`)
  const passed = run.find((s) => s.x !== null && s.x > 0.5 + blade.hi[0] + 0.3)
  expect(!!passed && passed.t > (dropped?.t ?? Infinity), 'and the box rides on over it')
  const left = run.find((s) => s.t > (dropped?.t ?? 0) && s.eye === false)
  const rose = run.find((s) => s.t > (left?.t ?? Infinity) && s.j > 1e-6)
  const after = rose && left ? rose.t - left.t : NaN
  expect(says('1 second after the box has left the beam') && Math.abs(after - clear) < 0.3, `the blade rises ${clear} s after the box has left the beam (${after.toFixed(2)} s)`)
  await stop(page)
  const conv = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.roller-conveyor'))
  expect(says('The conveyor ends at X = 2') && conv.position[0] + conv.params.length / 2 === 2, `the conveyor ends at X = ${conv.position[0] + conv.params.length / 2}`)
  expect(says('Equipment tab') && (await page.evaluate(() => window.__oip.store.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')?.category)) === 'Equipment', 'the built-in Blade Stop is in the Equipment tab')
}

async function main() {
  const g1 = partModelPage([])
  const g2 = partMotionPage([])
  const g3 = partFeedbackPage([])
  const g = partProductPage()
  const shell = await launchShell()
  try {
    await g.pics.sizeWindow(shell.app)
    console.log('Replaying guides/part-model/, part-motion/ and part-feedback/, where this guide starts')
    const p1 = await followPartModel(shell.page, g1)
    const p2 = g1.failures() === 0 ? await followPartMotion(shell.page, g2, p1) : null
    const p3 = p2 && g2.failures() === 0 ? await followPartFeedback(shell.page, g3, p2) : null
    if (!p3 || g3.failures() > 0) throw new Error('an earlier part guide failed, so this one cannot start')
    console.log('Following guides/part-product/index.html')
    await followPartProduct(shell.page, g, p3)
  } finally {
    await shell.close()
  }
  await g.pics.finish()
  const failures = g.failures()
  console.log(failures === 0 ? '\nThe guide works as written.' : `\n${failures} check(s) failed: the guide or the app has to change.`)
  return failures === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e)
      process.exit(2)
    },
  )
}
