// Follows the part guide guides/part-feedback/index.html (/guides/part-feedback/) step by step, in the real desktop
// shell. It starts where guides/part-motion/ ends, so it first replays the two guides before it, each against its page.
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the rule).
//
//   step 1  At A and At B typed from the page's table; the copy holds them; the badges the page names
//   step 2  the page's program pasted, no errors
//   step 3  Play: BladeUp and BladeDown follow the blade (never both true), the strokes take 0.2 s, BladeFault stays false
//   step 4  Stop, Stroke Time from the page's table, Play: BladeFault turns true while the first rise is still under
//           way, and stays true; Stop and the stroke time back to 0.2, where the next guide starts
//
// Usage:
//   node e2e/guide-part-feedback.mjs                 follow the guide; exit 0 = it works as written
//   node e2e/guide-part-feedback.mjs --shots <dir>   also save a screenshot per step
//   node e2e/guide-part-feedback.mjs --images        also retake the page's pictures (guides/part-feedback/img/)
//
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window, setTimeout */

import { pathToFileURL } from 'node:url'
import { guidePictures, guideTest, launchShell, shot as shotTo, sleep, squash } from './_guide.mjs'
import { field, joints, openGroup, partOf, pasteProgram, play, recordJoints, select, stop, strokes, typeInto, watched } from './_partGuide.mjs'
import { followPartModel, partModelPage } from './guide-part-model.mjs'
import { followPartMotion, partMotionPage } from './guide-part-motion.mjs'

/** This guide's page: its checks and everything the steps read from it. The next guide's script reads it too. */
export function partFeedbackPage(argv = process.argv.slice(2)) {
  const g = guideTest('part-feedback')
  const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
  return {
    ...g,
    pics: guidePictures('part-feedback', g, argv),
    shot: (page, name) => shotTo(page, shotsDir, `part-feedback-${name}`),
    /** step 1's table: the end-position tags */
    ends: g.wiring.filter((r) => r.field === 'At A' || r.field === 'At B'),
    /** step 4's table: the slow stroke */
    slow: g.wiring.find((r) => r.field === 'Stroke Time'),
    program: g.programs[0],
    /** the stroke time the program allows, from its Travel timer */
    allowed: Number(/Travel\(.*PT := T#(\d+)ms\)/.exec(g.programs[0] ?? '')?.[1]) / 1000,
  }
}

/** Sample the watch and the joint every 100 ms for `ms`: [BladeUp, BladeDown, BladeFault, joint] each time. */
async function sample(page, ms) {
  const out = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    out.push(await page.evaluate(() => {
      const w = window.__oip.controller.plcWatch ?? {}
      const v = (n) => w[Object.keys(w).find((k) => k === n || k.endsWith(`.${n}`))]
      return [v('BladeUp'), v('BladeDown'), v('BladeFault'), window.__partGuideRec.now.raise]
    }))
    await new Promise((r) => setTimeout(r, 100))
  }
  return out
}

/** Steps 1 to 4 on guide 2's end state. Ends stopped, in the scene, with the stroke time back where guide 2 left it. */
export async function followPartFeedback(page, g, prior) {
  const { expect, says, pics, shot, ends, slow, program, allowed } = g
  const stopId = prior.stopId
  expect(ends.length === 2 && !!slow && !!program && allowed > 0, `the page has its two end tags, its slow stroke, its program and the time it allows (${allowed} s)`)

  // ---- step 1: wire the end positions ----
  await select(page, stopId)
  const comms = await openGroup(page, says('Comms'))
  for (const row of ends) await typeInto(page, row.field, row.address)
  const p = await partOf(page, stopId)
  expect(p.params.raiseToB === 'RaiseBlade' && p.params.raiseAtA === ends[0].address && p.params.raiseAtB === ends[1].address, `Command holds RaiseBlade, At A ${ends[0].address}, At B ${ends[1].address}`)
  const badges = (await comms.locator('.field-label').allTextContents()).map(squash)
  expect(badges[0].endsWith('read BOOL') && badges.slice(1).every((b) => b.endsWith('write BOOL')) && says('marks these two write and Command read') !== '', `the Inspector marks At A and At B write, Command read (${badges.join(', ')})`)
  // each field's mark: its title, and whether it is the ! of a warning or the ✓ of a sound binding
  const marks = async () => {
    await sleep(1500) // the Inspector asks the program once the scene has held still (paramField.tsx VERDICT_DELAY_MS)
    const group = await openGroup(page, says('Comms'))
    return group.locator('[data-testid="tag-warn"], [data-testid="tag-status"]').evaluateAll((els) => els.map((e) => ({ text: e.textContent, title: e.title })))
  }
  const before = await marks()
  const undeclared = (name) => before.some((m) => m.text === '!' && m.title.startsWith(`The program does not declare ${name},`))
  expect(says('the two new fields have a ! beside them') !== '' && before.length === 3 && before[0].text === '✓' && undeclared('BladeDown') && undeclared('BladeUp'), `Command has ✓, and the two new fields ! because the program does not declare them yet (${before.map((m) => `${m.text} ${m.title}`).join(' | ')})`)
  await shot(page, 'step1-wired')

  // ---- step 2: write the program ----
  await pasteProgram(page, program)
  await sleep(1500)
  expect((await page.locator('[data-testid="st-error"]').count()) === 0, 'the PLC panel reports no errors')
  await select(page, stopId)
  const after = await marks()
  expect(says('Each of its three fields now has a ✓') !== '' && after.length === 3 && after.every((m) => m.text === '✓'), `each of the three fields has a ✓ (${after.map((m) => `${m.text} ${m.title}`).join(' | ')})`)
  expect(/drives RaiseBlade/i.test(after[0].title) && after.slice(1).every((m) => /reads/i.test(m.title)), `the program drives RaiseBlade and reads the other two (${after.map((m) => m.title).join(' | ')})`)
  await pics.ui(page, 'end-tags', comms)

  // ---- step 3: run it ----
  await recordJoints(page, stopId, 'raise')
  await play(page)
  const run = await sample(page, 9000)
  const max = 0.06
  const up = run.filter(([u, d, , j]) => u === true && d === false && Math.abs(j - max) < 1e-6).length
  const down = run.filter(([u, d, , j]) => d === true && u === false && Math.abs(j) < 1e-6).length
  const wrong = run.filter(([u, d, , j]) => (u === true && Math.abs(j - max) > 0.02) || (d === true && j > 0.02) || (u && d)).length
  expect(up > 5 && down > 5, `BladeUp is true while the blade is up (${up} samples) and BladeDown while it is down (${down})`)
  expect(wrong === 0, `neither is true away from its end (${wrong} samples)`)
  const rec = await joints(page)
  const times = strokes(rec.trace, 0, max).map((s) => s.end - s.start)
  expect(says('Each stroke takes 0.2 seconds') && times.length >= 3 && times.every((t) => Math.abs(t - 0.2) < 0.05), `each stroke takes 0.2 s (${times.map((t) => t.toFixed(2)).join(', ')})`)
  expect(run.every(([, , f]) => f === false) && 0.2 < allowed, `BladeFault stays false (${allowed} s allowed)`)
  await stop(page)

  // ---- step 4: make it fail ----
  await select(page, stopId)
  await typeInto(page, slow.field, slow.address)
  const slowTime = Number(slow.address)
  expect((await partOf(page, stopId)).params.raiseTime === slowTime && slowTime > allowed, `the copy's Stroke Time is ${slowTime} s, more than the ${allowed} s the program allows`)
  await recordJoints(page, stopId, 'raise')
  await play(page)
  await page.waitForFunction(() => { const w = window.__oip.controller.plcWatch ?? {}; return Object.entries(w).some(([k, v]) => /(^|\.)BladeFault$/.test(k) && v === true) }, null, { timeout: 20000, polling: 50 })
  const at = (await joints(page)).now.raise
  expect(at > 0 && at < max, `BladeFault turns true while the first rise is still under way (the blade at ${at.toFixed(3)} of ${max})`)
  await page.waitForFunction((max) => Math.abs(window.__partGuideRec.now.raise - max) < 1e-6, max, { timeout: 10000, polling: 50 })
  await sleep(1500)
  expect((await watched(page, 'BladeFault')) === true, 'it stays true while the blade carries on')
  await page.locator('.run-button.pause').click()
  await pics.ui(page, 'fault', page.locator('.cm-editor').first())
  await shot(page, 'step4-fault')
  await stop(page)
  await select(page, stopId)
  expect(says('set Stroke Time back to 0.2') !== '', 'the page sets the stroke time back')
  await typeInto(page, 'Stroke Time', 0.2)
  expect((await partOf(page, stopId)).params.raiseTime === 0.2 && Number(await field(page, 'Stroke Time').locator('input').first().inputValue()) === 0.2, 'the stroke time is back to 0.2, where the next guide starts')
  return { stopId }
}

async function main() {
  const g1 = partModelPage([])
  const g2 = partMotionPage([])
  const g = partFeedbackPage()
  const shell = await launchShell()
  try {
    await g.pics.sizeWindow(shell.app)
    console.log('Replaying guides/part-model/ and guides/part-motion/, where this guide starts')
    const p1 = await followPartModel(shell.page, g1)
    const p2 = g1.failures() === 0 ? await followPartMotion(shell.page, g2, p1) : null
    if (!p2 || g2.failures() > 0) throw new Error('an earlier part guide failed, so this one cannot start')
    console.log('Following guides/part-feedback/index.html')
    await followPartFeedback(shell.page, g, p2)
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
