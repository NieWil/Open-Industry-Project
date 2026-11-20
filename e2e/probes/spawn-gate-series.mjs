// Is verify-no-spawn-before-attach's failing birth a real spawn on a shut gate, or a gate the published
// frames never sampled as open?
//
// The spawner reads its run tag inside the worker, where the ST scan interleaves with the physics steps;
// the gate reads `controller.plcWatch`, which is the state carried by a published frame. If SpawnRun
// pulses between publishes, a legitimate spawn reads as "born on a shut gate". This records the tag's
// whole time series and prints the window around each birth, so the two are distinguishable.
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { clickDemo } from '../_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const WATCH_MS = Number(process.env.WATCH_MS ?? 45000)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
try {
  await page.goto(`http://localhost:${PORT}/app/`)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.sim), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.sim), { timeout: 60000 })
  await page.waitForTimeout(1000)
  const tut = page.locator('.tut-close')
  if (await tut.count()) await tut.first().click()
  await clickDemo(page)
  await page.waitForTimeout(3000)

  const spawners = await page.evaluate(() => window.__oip.store.getState().scene.parts
    .filter((p) => (p.packageId === 'oip.box-spawner' || p.packageId === 'oip.pallet-spawner') && p.params?.runTag)
    .map((p) => ({ name: p.name ?? p.packageId, tag: p.params.runTag, x: p.position[0], y: p.position[1], z: p.position[2] })))
  console.log('spawners:', spawners.map((s) => `${s.name}[${s.tag}]`).join(', '))
  console.log('scanMs:', await page.evaluate(() => window.__oip.store.getState().stScanMs))

  await page.evaluate((spawners) => {
    const sim = window.__oip.sim
    const prior = sim.onFrame
    const seen = new Set()
    window.__series = [] // every published frame: [simTime, ...tag values]
    window.__births = []
    window.__watchChanges = [] // simTime of every frame that brought a new watch table
    let lastWatchObj = null
    sim.onFrame = (f) => {
      prior(f)
      // client.ts carries the previous watch object forward on frames that bring none, so object
      // identity is an exact read of which frames actually refreshed it
      const raw = window.__oip.sim.plcState?.watch ?? null
      if (raw !== lastWatchObj) { lastWatchObj = raw; window.__watchChanges.push(+f.simTime.toFixed(3)) }
      const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
      const row = [+f.simTime.toFixed(3), ...spawners.map((s) => (w[s.tag] === true ? 1 : w[s.tag] === false ? 0 : -1))]
      window.__series.push(row)
      for (let i = 0; i < f.count; i++) {
        if (f.partIds[i] !== null && f.partIds[i] !== undefined) continue
        const id = f.ids[i]
        if (seen.has(id)) continue
        seen.add(id)
        const x = f.positions[i * 3], y = f.positions[i * 3 + 1], z = f.positions[i * 3 + 2]
        let owner = null, best = Infinity
        for (const s of spawners) { const d = Math.hypot(s.x - x, s.y - y, s.z - z); if (d < best) { best = d; owner = s } }
        window.__births.push({ simTime: +f.simTime.toFixed(3), id, owner: owner?.name, tag: owner?.tag, dist: +best.toFixed(2), frameIdx: window.__series.length - 1 })
      }
    }
  }, spawners)

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(WATCH_MS)

  const { series, births, tags, watchChanges } = await page.evaluate((s) => ({ series: window.__series, births: window.__births, tags: s.map((x) => x.tag), watchChanges: window.__watchChanges }), spawners)
  console.log(`\npublished frames: ${series.length}, births: ${births.length}`)
  const dts = series.slice(1).map((r, i) => r[0] - series[i][0]).filter((d) => d > 0).sort((a, b) => a - b)
  console.log(`frame simTime step: median ${dts[Math.floor(dts.length / 2)]?.toFixed(4)}s, max ${dts[dts.length - 1]?.toFixed(4)}s`)
  const wd = watchChanges.slice(1).map((t, i) => t - watchChanges[i]).filter((d) => d > 0).sort((a, b) => a - b)
  console.log(`watch table refreshed on ${watchChanges.length}/${series.length} frames; gap median ${wd[Math.floor(wd.length / 2)]?.toFixed(4)}s, min ${wd[0]?.toFixed(4)}s, max ${wd[wd.length - 1]?.toFixed(4)}s`)
  for (const t of tags) {
    const col = tags.indexOf(t) + 1
    const trues = series.filter((r) => r[col] === 1).length
    console.log(`  ${t}: true on ${trues}/${series.length} published frames`)
  }

  // the window around every birth whose own frame reads the gate shut
  const bad = births.filter((b) => {
    const col = tags.indexOf(b.tag) + 1
    return series[b.frameIdx]?.[col] !== 1
  })
  console.log(`\nbirths whose own frame reads the gate shut: ${bad.length}/${births.length}`)
  for (const b of bad.slice(0, 4)) {
    const col = tags.indexOf(b.tag) + 1
    const from = Math.max(0, b.frameIdx - 12)
    const win = series.slice(from, b.frameIdx + 13).map((r) => `${r[0].toFixed(2)}:${r[col] === 1 ? 'T' : r[col] === 0 ? 'f' : '?'}`)
    console.log(`\n  born id ${b.id} at ${b.simTime}s from ${b.owner}[${b.tag}] (dist ${b.dist} m), frame #${b.frameIdx}`)
    console.log(`  ${win.join(' ')}`)
    const everTrue = series.findIndex((r) => r[col] === 1)
    const lastTrueBefore = [...series.slice(0, b.frameIdx + 1)].map((r, i) => (r[col] === 1 ? i : -1)).filter((i) => i >= 0).pop()
    console.log(`  tag first true at frame ${everTrue}${everTrue >= 0 ? ` (${series[everTrue][0]}s)` : ''}; last true before birth: ${lastTrueBefore === undefined ? 'never' : `${series[lastTrueBefore][0]}s (${(b.simTime - series[lastTrueBefore][0]).toFixed(2)}s earlier)`}`)
  }
} catch (e) {
  console.log('probe error:', e.message.split('\n')[0])
} finally {
  await browser.close()
  vite.kill()
}
