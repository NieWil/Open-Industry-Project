// Checks in the real running editor that the shipped SDK Stairs snap onto the shipped SDK Platform (the
// stairs-to-platform snap). Boots /app/, waits for the bundled first-party parts to register, then dynamically
// imports the app's own core/snap/snapFeatures.ts and runs findSnap on real oip.stairs + oip.platform instances.
// Vite serves source in dev, so this is the same module singleton the editor uses, sharing the live part registry.
// This covers the app-side wiring: loadBundledExamples registers both parts with their snap blocks, and the live
// snap engine sizes the flight to the deck and seats it. See docs/part-snap-stairs.md.
// Run: node e2e/verify-stairs-platform-snap.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

async function main() {
  const server = await startServer()
  const url = `http://localhost:${server.port}/app/?hook`
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 160)) })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // wait for the store hook and for the bundled parts to be registered in the live registry
    await page.waitForFunction(
      () => !!(window.__oip?.store && window.__oip.getPackage?.('oip.stairs')?.snap?.edgeMount && window.__oip.getPackage?.('oip.platform')?.snap?.surfaces),
      { timeout: 45000 },
    )

    const result = await page.evaluate(async () => {
      const { findSnap } = await import('/src/core/snap/snapFeatures.ts')
      // a floor-rested 4×4 platform, deck top at y=2 (floor at 0); a stairs at 5 steps dropped just outside +X edge
      const platform = { id: 't', type: 'part', packageId: 'oip.platform', position: [0, 2, 0], rotationY: 0, params: { length: 4, width: 4, height: 2 } }
      const stair = { id: 'm', type: 'part', packageId: 'oip.stairs', position: [4.8, 0, 0], rotationY: 0, params: { numSteps: 5, width: 1.2 } }
      const snap = findSnap(stair, { position: [4.8, 0, 0], rotationY: 0 }, [platform])
      const platPkg = window.__oip.getPackage('oip.platform')
      const stairPkg = window.__oip.getPackage('oip.stairs')
      return {
        deckHasHeight: !!platPkg.snap.surfaces.find((s) => s.kind === 'deck')?.heightParam,
        edgeMount: stairPkg.snap.edgeMount,
        snap: snap && { pos: snap.pose.position, rotY: snap.pose.rotationY, overrides: snap.paramOverrides, targetId: snap.targetId, junctionY: snap.junction.y },
      }
    })

    const checks = []
    const ok = (name, cond) => { checks.push({ name, ok: !!cond }); console.log(`  ${cond ? '✓' : '✗'} ${name}`) }
    ok('platform deck surface advertises heightParam', result.deckHasHeight)
    ok('stairs declare an edgeMount facing into a deck, from the floor', result.edgeMount?.accepts === 'deck' && result.edgeMount?.facing === 'into' && result.edgeMount?.fromFloor?.param === 'numSteps')
    ok('a snap candidate is produced against the platform', result.snap && result.snap.targetId === 't')
    // The seat length is the run, not the far end of the stair's own landing (run + 0.76). The stairs' edgeMount
    // contact is the top of the flight, so its top meets the deck edge with the whole flight outside the deck, and
    // the deck is its landing (the stair's own landing drops once mounted).
    const TREAD = 0.28 // examples/parts/stairs/part.js TREAD
    const seatLen = 11 * TREAD
    ok('flight resized to 11 steps (deck height 2 / 0.178)', result.snap?.overrides?.numSteps === 11)
    ok('foot seats a run outward of the +X edge (x≈2+run)', result.snap && Math.abs(result.snap.pos[0] - (2 + seatLen)) < 1e-3)
    ok('foot on the platform floor (y≈0)', result.snap && Math.abs(result.snap.pos[1]) < 1e-3)
    ok('flight ascends INTO the deck (rotationY≈π)', result.snap && Math.abs(Math.abs(result.snap.rotY) - Math.PI) < 1e-3)
    ok('snap cue on the deck top (junction.y≈2)', result.snap && Math.abs(result.snap.junctionY - 2) < 1e-3)

    console.log('\n  raw snap:', JSON.stringify(result.snap))
    const failed = checks.filter((c) => !c.ok)
    if (failed.length) {
      console.error(`\nFAILED (${failed.length}): ${failed.map((c) => c.name).join('; ')}`)
      process.exitCode = 1
    } else {
      console.log('\nPASS - stairs snap onto platforms in the running app, sized to the deck.')
    }
  } finally {
    await browser.close()
    // `server.vite.kill()`, not `server.kill()`: startServer returns { url, port, vite }, so `server.kill()`
    // throws a TypeError inside `finally` and the vite child is never killed. Its live handle then keeps
    // the event loop open and the process hangs instead of exiting. The exit/signal safety net in
    // _server.mjs cannot fire for a process that never exits, and scripts/run-gates.mjs waits on every
    // worker, so run-gates also caps each script (SCRIPT_TIMEOUT_MS).
    server.vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
