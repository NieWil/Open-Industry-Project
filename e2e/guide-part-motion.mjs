// Follows the part guide guides/part-motion/index.html (/guides/part-motion/) step by step, in the real desktop shell.
// It starts where guides/part-model/ ends, so it first replays that guide (e2e/guide-part-model.mjs, against that page).
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the rule).
//
//   step 1  Open Part Editor on the placed copy: the Scene dock lists body and collider
//   step 2  Split into pieces > Blade: a Blade node under body, selected, and nothing moved
//   step 3  Add joint, the page's table typed in: a prismatic joint on Blade, axis 0, 1, 0 as the page says to leave
//           it; Test motion runs and ends; the page's 5 cm follows from the joint and guide 1's 1 cm
//   step 4  PLC control Two positions and the stroke time: the hint the page quotes, the joint's name locked
//   step 5  ‹ Scene, the copy's Comms fields are the three the page names, Command wired, the page's program pasted,
//           Play: the blade reaches Max and comes back, every 2 s of simulated time, each stroke the page's stroke time;
//           the copy's Stroke Time holds it; the tip's Spins endlessly and Spin are where it says
//   trouble the messages the page quotes are the app's
//
// Usage:
//   node e2e/guide-part-motion.mjs                 follow the guide; exit 0 = it works as written
//   node e2e/guide-part-motion.mjs --shots <dir>   also save a screenshot per step
//   node e2e/guide-part-motion.mjs --images        also retake the page's pictures (guides/part-motion/img/)
//
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guidePictures, guideTest, launchShell, ROOT, shot as shotTo, sleep, squash } from './_guide.mjs'
import { backToScene, choose, field, joints, openGroup, openPartEditor, partOf, pasteProgram, pkgOf, play, recordJoints, select, stop, strokes, treeRow, typeInto } from './_partGuide.mjs'
import { followPartModel, partModelPage } from './guide-part-model.mjs'

/** This guide's page: its checks and everything the steps read from it. The next guide's script reads it too. */
export function partMotionPage(argv = process.argv.slice(2)) {
  const g = guideTest('part-motion')
  const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
  /** a two-column table's rows (Field, Set to), by field */
  const set = Object.fromEntries([...g.html.matchAll(/<tr><td>(Name|Type|Min|Max|PLC control|Stroke time)<\/td><td class="m">([^<]+)<\/td>/g)].map((m) => [m[1], m[2]]))
  return {
    ...g,
    pics: guidePictures('part-motion', g, argv),
    shot: (page, name) => shotTo(page, shotsDir, `part-motion-${name}`),
    set,
    /** step 5's program, the page's one listing */
    program: g.programs[0],
    /** the program's cycle, from its timer */
    cycle: Number(/PT := T#(\d+)s\)/.exec(g.programs[0] ?? '')?.[1]),
  }
}

/** The app's own messages, for a quoted line the run does not reach. */
const rigNodeSource = () => readFileSync(join(ROOT, 'src/editor/components/inspector/rigNode.tsx'), 'utf8')

/**
 * Steps 1 to 5 on guide 1's end state (`prior`: its part's package id and placed ids). Ends stopped, in the scene.
 * Returns the blade stop's id.
 */
export async function followPartMotion(page, g, prior) {
  const { expect, says, pics, shot, set, wiring, program, cycle } = g
  const partName = says('Blade Stop 900')
  const stopId = prior.ids[partName]
  expect(!!stopId, `guide 1 placed ${partName}`)
  expect(Object.keys(set).length === 6 && !!program && cycle > 0 && wiring.length === 1, `the page has its joint table, its PLC control table, its wiring row and its program (${JSON.stringify(set)})`)

  // ---- step 1: open the part ----
  await openPartEditor(page, g, partName)
  const rows = squash((await page.locator('.tree-name').allInnerTexts()).join(' '))
  expect(rows === `${partName} ${says('body')} ${says('collider')}`, `the Scene dock lists the part's nodes, body and collider ("${rows}")`)
  expect(await page.locator('.scene-breadcrumb').isVisible() && says('‹ Scene') !== '', 'the Scene dock has ‹ Scene')

  // ---- step 2: split the blade out ----
  const before = await pkgOf(page, prior.pkgId)
  await treeRow(page, 'body').click()
  const split = await openGroup(page, says('Split into pieces'))
  await split.locator('.glb-chip', { hasText: new RegExp(`^${says('Blade')}$`) }).first().click()
  await page.waitForFunction((id) => window.__oip.getPackage(id).geometry.links.some((l) => l.name === 'Blade'), prior.pkgId, { timeout: 10000 })
  const afterSplit = await pkgOf(page, prior.pkgId)
  const blade = afterSplit.links.find((l) => l.name === 'Blade')
  expect(blade?.parent === 'body' && blade.kind === 'mesh', `a new node, Blade, is under body (${JSON.stringify(blade)})`)
  expect((await page.locator('.inspector').innerText()).trim().startsWith('Blade'), 'and it is selected')
  const bodyBefore = before.links.find((l) => l.name === 'body').offset
  const bodyAfter = afterSplit.links.find((l) => l.name === 'body').offset
  expect(blade?.offset.every((v) => v === 0) && bodyBefore.every((v, i) => v === bodyAfter[i]), 'nothing moved: the split piece stays where it is')
  await sleep(300)
  await pics.ui(page, 'blade-node', [treeRow(page, partName), treeRow(page, 'collider')], { pad: 4 })
  await shot(page, 'step2-split')

  // ---- step 3: give it a joint ----
  await page.getByRole('button', { name: says('Add joint') }).click()
  await openGroup(page, says('Joint'))
  await typeInto(page, says('Name'), set.Name)
  await choose(page, says('Type'), set.Type)
  await typeInto(page, says('Min'), set.Min)
  await typeInto(page, says('Max'), set.Max)
  const jointNow = (await pkgOf(page, prior.pkgId)).joints.find((j) => j.link === 'Blade')
  expect(jointNow?.name === set.Name && jointNow.type === set.Type && jointNow.min === Number(set.Min) && jointNow.max === Number(set.Max), `Blade has a ${set.Type} joint "${set.Name}" from ${set.Min} to ${set.Max} (${JSON.stringify(jointNow)})`)
  expect(says('0, 1, 0') && jointNow?.axis.join(',') === '0,1,0', 'its Axis is 0, 1, 0, as the page says to leave it')
  // guide 1 put the blade's top 1 cm under the rollers; raised by Max it stands Max - 1 cm above them
  expect(says('1 cm below the rollers') && says('stands 5 cm above them') && Math.abs(Number(set.Max) - 0.01 - 0.05) < 1e-9, 'raised by Max, the blade stands 5 cm above the rollers')
  const test = page.getByRole('button', { name: says('Test motion') })
  await test.click()
  const stopTest = page.getByRole('button', { name: 'Stop test' })
  expect(await stopTest.isVisible().catch(() => false), 'Test motion runs')
  await test.waitFor({ timeout: 15000 })
  expect(true, 'and ends by itself, back at rest')

  // ---- step 4: let the PLC drive it ----
  await choose(page, says('PLC control'), set['PLC control'])
  await typeInto(page, says('Stroke time'), set['Stroke time'])
  const inspector = squash(await page.locator('.inspector').innerText())
  expect(inspector.includes(squash(says('A is Min and B is Max.'))), 'the Inspector explains that A is Min and B is Max')
  expect(inspector.includes(`PLC control drives “${set.Name}”, so it can't be renamed here.`) && says(`"PLC control drives “raise”, so it can't be renamed here."`) !== '', 'the joint\'s name is locked, in the words the troubleshooting quotes')
  const written = await pkgOf(page, prior.pkgId)
  expect(/twoPositions\(ctx, "raise", 0, 0\.06,/.test(written.behavior) && written.behavior.includes(`"time":${Number(set['Stroke time'])}`), 'the Part Editor wrote the behavior script for it')
  await pics.ui(page, 'joint', await openGroup(page, says('Joint')))
  await shot(page, 'step4-two-positions')

  // ---- step 5: wire it and run ----
  await backToScene(page)
  await select(page, stopId)
  const comms = await openGroup(page, says('Comms'))
  const labels = (await comms.locator('.field-label').allTextContents()).map((s) => squash(s).replace(/\s*(read|write) BOOL$/i, ''))
  expect(labels.join(', ') === [says('Command'), says('At A'), says('At B')].join(', '), `the copy's Comms group has Command, At A and At B (${labels.join(', ')})`)
  for (const row of wiring) await typeInto(page, row.field, row.address)
  const wired = await partOf(page, stopId)
  expect(wired.params.raiseToB === wiring[0].address, `Command holds ${wiring[0].address}`)
  await pasteProgram(page, program)
  await sleep(1500)
  expect((await page.locator('[data-testid="st-error"]').count()) === 0, 'the PLC panel reports no errors')
  await recordJoints(page, stopId, set.Name)
  await play(page)
  // a few cycles of simulated time
  await page.waitForFunction((n) => (window.__partGuideRec.trace.at(-1)?.[0] ?? 0) > n, cycle * 3.5, { timeout: 60000, polling: 200 })
  const rec = await joints(page)
  const max = Number(set.Max)
  expect(Math.abs(rec.max[set.Name] - max) < 1e-6 && Math.abs(rec.min[set.Name]) < 1e-6, `the blade rises to ${max} and sinks to 0 (${rec.min[set.Name]} to ${rec.max[set.Name]})`)
  const s = strokes(rec.trace, 0, max)
  const ups = s.filter((x) => x.to === 'b')
  const gaps = ups.slice(1).map((x, i) => x.start - ups[i].start)
  expect(ups.length >= 2 && gaps.every((d) => Math.abs(d - 2 * cycle) < 0.1), `it rises every ${2 * cycle} s of simulated time, up for ${cycle} s (rises ${gaps.map((d) => d.toFixed(2)).join(', ')} s apart)`)
  const times = s.map((x) => x.end - x.start)
  const stroke = Number(set['Stroke time'])
  expect(times.length >= 3 && times.every((d) => Math.abs(d - stroke) < 0.05), `each stroke takes the stroke time, ${stroke} s (${times.map((d) => d.toFixed(2)).join(', ')})`)
  const values = await page.locator('.cm-st-value').allTextContents()
  expect(says('the code editor shows each variable') && values.some((v) => /TRUE|FALSE/.test(v)), `the code editor shows the variables' values (${values.slice(0, 4).join(', ')})`)
  // the picture: the blade up, the run paused so it stays up while the shot is taken
  await page.waitForFunction((max) => Math.abs((window.__partGuideRec.now.raise ?? 0) - max) < 1e-6, max, { timeout: 10000, polling: 50 })
  await page.locator('.run-button.pause').click()
  const at = (await partOf(page, stopId)).position
  await pics.scene(page, 'raised', { px: at[0] + 0.9, py: 1.25, pz: at[2] + 1.3, tx: at[0] - 0.15, ty: 0.8, tz: at[2] })
  await shot(page, 'step5-raised')
  await stop(page)
  await select(page, stopId)
  const strokeField = field(page, says('Stroke Time')).locator('input').first()
  expect(Number(await strokeField.inputValue()) === stroke, `the copy's Stroke Time starts at ${stroke} (${await strokeField.inputValue()})`)

  // ---- the tip and the troubleshooting lines the run does not reach ----
  await openPartEditor(page, g, partName)
  await treeRow(page, 'Blade').click()
  await openGroup(page, says('Joint'))
  expect((await page.getByRole('button', { name: says('Remove joint') }).count()) === 1, 'the Joint section has Remove joint')
  await backToScene(page)
  const src = rigNodeSource()
  // a revolute joint's section has Spins endlessly; the blade's is prismatic, so the run never shows it
  expect(src.includes(`spin: '${says('Spins endlessly')}'`) && src.includes(`plcSpin: '${says('Spin')}'`), 'a turning joint offers Spins endlessly, and then PLC control offers Spin')
  expect(src.includes(`splitNone: '${says('Every piece of this model is already split out.')}'`), 'Split into pieces says "Every piece of this model is already split out." when nothing is left')
  expect(says('nothing is saved, and the joint goes back to rest') && src.includes('Nothing is saved: the joint goes back to rest'), "Position's tooltip says a test is not saved")
  return { stopId }
}

async function main() {
  console.log('Replaying guides/part-model/index.html, where this guide starts')
  const g1 = partModelPage([])
  const g = partMotionPage()
  const shell = await launchShell()
  try {
    await g.pics.sizeWindow(shell.app)
    const prior = await followPartModel(shell.page, g1)
    if (g1.failures() > 0) throw new Error('the first part guide failed, so this one cannot start')
    console.log('Following guides/part-motion/index.html')
    await followPartMotion(shell.page, g, prior)
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
