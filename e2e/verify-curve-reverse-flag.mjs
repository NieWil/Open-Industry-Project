/* global console, process, window, document */
// Guard for the curved conveyor's snap-owned `reverse` flag (hidden, engine-owned storage).
//
// A curve can't be rotated 180° to turn its flow around (that would swap its inner/outer radius), so the
// snap reverses it instead, by toggling a hidden param. Negating the authored `speed` would silently rewrite
// the number the user typed in the Inspector (and flip it back on every re-snap). Two halves have to hold,
// and only the first is unit-testable:
//
//   1. hidden: `reverse` is real, stored, resolved state on the part, but never an Inspector field.
//   2. wired: flipping it reverses what the user sees (the flow arrow) and what cargo feels (the arc
//      surface velocity), without touching `speed`.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  const fails = []
  const check = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` - ${detail}` : ''}`)
    if (!cond) fails.push(label)
  }
  try {
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.getPackage?.('oip.curved-conveyor')), { timeout: 30000 })

    const partId = await page.evaluate(() => {
      window.__oip.store.enterPackageEdit('oip.curved-conveyor')
      return window.__oip.store.getState().packageEdit?.partId ?? null
    })
    check('curved conveyor placed', !!partId)
    if (!partId) return

    // 1. stored - the schema default resolved onto the instance, not dropped as an unknown key
    const baseline = await page.evaluate((id) => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
      return { reverse: p?.params.reverse, speed: p?.params.speed }
    }, partId)
    check('`reverse` resolves onto the part as stored state', baseline.reverse === false, JSON.stringify(baseline))

    // 1b. ...but not an Inspector field. Select the part and scan the panel for a field bearing its label.
    await page.evaluate((id) => window.__oip.store.select(id), partId)
    await page.waitForTimeout(600)
    const inspector = await page.evaluate(() => {
      const panel = document.querySelector('.inspector') ?? document.body
      const text = panel.textContent ?? ''
      return { text, hasSpeed: /Speed/i.test(text), hasBooleanField: /Inner guard/i.test(text) }
    })
    check('the Inspector is actually showing this part (non-vacuous)', inspector.hasSpeed)
    // ...and it renders this part's boolean params, so a missing `reverse` is the filter working rather
    // than booleans being absent for some unrelated reason
    check('the Inspector renders the part\'s other boolean params', inspector.hasBooleanField)
    // match the hidden param's own label, not a loose /revers/ - the speed field is labelled
    // "Speed (m/s, − reverses)" and would false-positive
    check('`reverse` is NOT an Inspector field', !/snap-owned/i.test(inspector.text), inspector.text.match(/.{0,30}snap-owned.{0,10}/i)?.[0] ?? '')

    // 2. wired - flip the flag the way the snap does; the value must reach the part and must not change
    // the authored speed (which is why the flag exists instead of speed negation).
    await page.evaluate((id) => {
      const s = window.__oip.store
      const scene = s.getState().scene
      s.commit('reverse', { ...scene, parts: scene.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, reverse: true } } : p)) })
    }, partId)
    await page.waitForTimeout(600)
    const after = await page.evaluate((id) => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
      return { reverse: p?.params.reverse, speed: p?.params.speed }
    }, partId)
    check('flipping `reverse` leaves the authored speed untouched', after.speed === baseline.speed, `${baseline.speed} → ${after.speed}`)
    check('the flag persists on the part', after.reverse === true)

    // The direction fold itself (arc field, flow arrow, pilot mirror, render scroll all reading
    // speed × reverse) is pure and lives in core/conveyor/conveyorDirection.ts - unit-tested there and in
    // snapFeatures.test.ts, which is a better home for it than a browser round-trip.
  } catch (e) {
    fails.push('exception')
    console.log('FAIL: exception —', e.message)
  } finally {
    await page.close().catch(() => {})
    vite.kill()
    await browser.close().catch(() => {})
  }
  console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILURE(S): ${fails.join('; ')}`)
  if (fails.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
