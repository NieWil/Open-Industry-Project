// Follows step 1 of the published ADS guide, guides/ads/index.html (/guides/ads/), in the real desktop shell, and
// retakes the page's picture of it.
//
// What it proves: the page's step 1 works as written (e2e/_guide.mjs has the rule): the scene is the page's three
// parts, and each tag typed into the Inspector is a row of the page's wiring table, found by the labels the page
// names.
//
// What it does not do: connect to a PLC. ADS needs the user's own TwinCAT router and TcAdsDll, and this project
// runs no vendor software in testing (AGENTS.md, "Vendor boundary"). The app's side of the link (the dock, the
// shell's ADS channel apps/desktop/adsIo.cjs, its refusals) is e2e/verify-external-plc-electron.mjs's ADS phase.
//
// Usage:
//   node e2e/guide-ads.mjs             follow step 1; exit 0 = it works as written
//   node e2e/guide-ads.mjs --images    also retake the page's picture (guides/ads/img/, see guidePictures)
//
// Needs no PLC software. Opens a desktop-shell window for the run.
// Exit 0 = step 1 works; 1 = a check did not; 2 = it could not run.
/* global process, console, window */

import { commsGroup, guidePictures, guideTest, launchShell, loadParts, sleep, wire as wireRow } from './_guide.mjs'

const { html, expect, says, wiring, failures } = guideTest('ads')
const pics = guidePictures('ads', { html, expect })

const PART_IDS = { 'Belt Conveyor': 'belt', 'Photo Eye': 'eye' }
const loadScene = (page) =>
  loadParts(page, [
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5 } },
    { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: {} },
  ])

async function main() {
  console.log('Following step 1 of guides/ads/index.html')
  expect(wiring.length === 2 && wiring.every((w) => PART_IDS[w.part]), `the guide wires two fields by name (${wiring.map((w) => `${w.part} ${w.field} = ${w.address}`).join(', ')})`)
  if (failures()) return 1

  const shell = await launchShell()
  const { page } = shell
  await pics.sizeWindow(shell.app)
  try {
    console.log('--- step 1: build the scene and wire it ---')
    expect((await loadScene(page)) === true, 'the scene opens with a belt, a box and a photo eye, unwired')
    for (const row of wiring) await wireRow(page, row, { expect, says, partIds: PART_IDS })
    await page.evaluate(() => window.__oip.store.setState({ selectedIds: ['eye'] }))
    await sleep(300)
    await pics.ui(page, 'inspector-comms', commsGroup(page))
  } finally {
    await shell.close()
  }
  await pics.finish()
  console.log(failures() === 0 ? '\nStep 1 works as written.' : `\n${failures()} check(s) failed: the guide or the app has to change.`)
  return failures() === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
