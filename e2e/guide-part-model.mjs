// Follows the part guide guides/part-model/index.html (/guides/part-model/) step by step, in the real desktop shell,
// with the example model the page offers for download (public/guides/blade-stop.glb: the built-in Blade Stop's model,
// scaled to metres, its pieces grouped under Base and Blade).
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the rule).
// Every label, message and value the page quotes is looked up on the page first, then held against the app.
//
//   you need  the download link is the example file, at the size the page gives
//   step 2    Import part > A model... with the file; the Inspector's message is the page's; the nodes are the page's
//             table (body a mesh, collider a hidden box)
//   step 3    Split into pieces lists the groups the page names, Mesh no dark material; the collider's Box size is
//             the size the page gives; Import model... is where the page says
//   step 4    Name and Category typed from the page's table, and the part takes them
//   step 5    ‹ Scene, a Roller Conveyor and the part dragged in from the tabs the page names, the page's mounting
//             table typed into the Inspector, and the blade's top under the rollers by the margin the page gives; the
//             copy's right-click menu has Open Part Editor
//   trouble   a file that is not a model is refused in the page's words; ＋ New part makes a "My Part" box
//
// Steps 2 to 5 are exported (followPartModel): the next part guides start where this one ends, and replay them.
//
// What it does not do: the page's Blender and CAD exports (step 1) and the browser's file picker. The desktop path is
// the one followed; the browser's single picker is Catalog.tsx's `importRef`.
//
// Usage:
//   node e2e/guide-part-model.mjs                 follow the guide; exit 0 = it works as written
//   node e2e/guide-part-model.mjs --shots <dir>   also save a screenshot per step
//   node e2e/guide-part-model.mjs --images        also retake the page's pictures (guides/part-model/img/, see guidePictures)
//
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guidePictures, guideTest, labelled, launchShell, ROOT, shot as shotTo, sleep, squash } from './_guide.mjs'
import { backToScene, dragIn, field, hint, importModel, partOf, pkgOf, select, skipTour, treeRow, typeInto } from './_partGuide.mjs'

// ---- the page ----

/** This guide's page: its checks and everything the steps read from it. The next guide's script reads it too. */
export function partModelPage(argv = process.argv.slice(2)) {
  const g = guideTest('part-model')
  const { html, wiring } = g
  const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
  return {
    ...g,
    pics: guidePictures('part-model', g, argv),
    shot: (page, name) => shotTo(page, shotsDir, `part-model-${name}`),
    /** the example's link, and the size the page gives for it */
    download: /<a href="(\/guides\/[\w.-]+\.glb)" download>([\w.-]+)<\/a> \((\d+) KB\)/.exec(html),
    /** step 2's message, the page's one listing */
    importMessage: g.programs[0],
    /** step 2's node table: name, kind */
    nodes: [...html.matchAll(/<tr><td>(\w+)<\/td><td>(mesh|box)<\/td><td>/g)].map((m) => ({ name: m[1], kind: m[2] })),
    /** step 4's table: field, what to type */
    info: Object.fromEntries([...html.matchAll(/<tr><td>(Name|Category)<\/td><td class="m">([^<]+)<\/td>/g)].map((m) => [m[1], m[2]])),
    /** step 3's size, "0.180 by 0.409 by 1.080" */
    size: /The example is ([\d.]+) by ([\d.]+) by ([\d.]+):/.exec(html)?.slice(1).map(Number),
    /** step 3's groups: the bold names in the Split into pieces paragraph */
    pieces: /two groups,\s*<b>(\w+)<\/b> and <b>(\w+)<\/b>/.exec(html)?.slice(1),
    /** step 5's mounting table: part, field, what to type (a Position is "x, y, z") */
    mount: wiring.map((r) => ({ part: r.part, field: r.field, values: r.address.split(',').map((v) => Number(v.trim())) })),
  }
}

/** The example model the page links to. */
export const modelFileOf = (g) => (g.download ? join(ROOT, 'public', g.download[1]) : null)

/**
 * Steps 2 to 5 in an open shell, as the page has them: the part imported, checked, named and mounted under a roller
 * conveyor. Ends in the scene with nothing selected. Returns the part's package id and the placed parts' ids by name
 * (the page's names: "Roller Conveyor" and the part's own).
 */
export async function followPartModel(page, g) {
  const { expect, says, pics, shot, download, importMessage, nodes, info, size, pieces, mount, wiring } = g
  const modelFile = modelFileOf(g)
  expect(!!download && statSync(modelFile, { throwIfNoEntry: false })?.isFile(), `the page links the example model (${download?.[1]})`)
  if (download) expect(Math.round(statSync(modelFile).size / 1000) === Number(download[3]), `the example is ${download[3]} KB, as the page says (${statSync(modelFile).size} bytes)`)
  expect(!!importMessage, 'the page quotes the import message')
  expect(nodes.length === 2 && !!size && !!pieces && !!info.Name && !!info.Category, 'the page has its node table, size, pieces and name table')
  expect(mount.length === 4 && mount.every((r) => r.values.every(Number.isFinite)), `the page has its mounting table (${wiring.map((r) => `${r.part} ${r.field} = ${r.address}`).join('; ')})`)

  // ---- step 2: import it ----
  await skipTour(page)
  await importModel(page, g, modelFile)
  const msg = hint(page, 'Imported')
  await msg.waitFor({ timeout: 20000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000, polling: 200 })
  const said = squash(await msg.innerText())
  expect(said.startsWith(squash(importMessage)), `the Inspector says what the page quotes ("${said}")`)
  const pkgId = await page.evaluate(() => window.__oip.store.getState().packageEdit?.packageId ?? null)
  expect(!!pkgId, `the part opened in the Part Editor (${pkgId})`)
  const pkg = await pkgOf(page, pkgId)
  const expectedName = basename(modelFile).replace(/\.glb$/, '').replace(/-/g, ' ')
  expect(pkg?.name === says(expectedName), `the part is named after the file ("${pkg?.name}")`)
  for (const n of nodes) {
    const link = pkg?.links.find((l) => l.name === n.name)
    expect(link?.kind === n.kind, `node ${n.name} is a ${n.kind} (${link?.kind})`)
    expect((await treeRow(page, n.name).count()) === 1, `the Scene dock lists ${n.name}`)
  }
  expect(pkg?.links.length === nodes.length, `the part has just the page's ${nodes.length} nodes (${pkg?.links.map((l) => l.name).join(', ')})`)
  expect(pkg?.links.find((l) => l.name === 'collider')?.hidden === true, 'the collider is hidden')
  // the view frames the part again at its new size (it opened framed on the blank part's 0.6 m box)
  // the camera eases there, and slowly while the model's shaders compile: wait for it, not a fixed time
  const mid = (pkg?.bounds?.top ?? 0) / 2
  await page.waitForFunction((mid) => Math.abs(window.__oip.view.cameraPose().ty - mid) < 0.1, mid, { timeout: 10000, polling: 100 }).catch(() => {})
  const aim = await page.evaluate(() => window.__oip.view.cameraPose().ty)
  expect(Math.abs(aim - mid) < 0.1, `the view is framed on the model (aimed at y ${aim.toFixed(2)}, its middle is ${mid.toFixed(2)})`)
  await pics.ui(page, 'import-message', msg)
  await shot(page, 'step2-imported')

  // ---- step 3: check it ----
  await treeRow(page, 'body').click()
  await sleep(300)
  await shot(page, 'step3-body')
  const groupHead = (title) => page.locator('.inspector-group-head', { hasText: labelled(title) }).first()
  const split = groupHead(says('Split into pieces')).locator('xpath=..')
  await split.waitFor({ timeout: 10000 })
  const chips = (await split.locator('.glb-chip').allInnerTexts()).map((s) => s.trim())
  for (const p of pieces ?? []) expect(chips.includes(p), `Split into pieces lists ${p} (${chips.join(', ')})`)
  expect(chips.length === 10, `it lists eight pieces and the two groups (${chips.length})`)
  await pics.ui(page, 'model-nodes', split)
  const mesh = groupHead(says('Mesh'))
  if ((await mesh.getAttribute('aria-expanded')) === 'false') await mesh.click()
  await page.locator('.glb-mat').first().waitFor({ timeout: 10000 })
  expect((await page.locator('.glb-mat').count()) === 4 && says('four are fine'), `Mesh lists four materials (${await page.locator('.glb-mat').count()})`)
  expect((await page.locator('.glb-mat.warn').count()) === 0, `no material is marked "${says('⚠ renders dark')}"`)
  expect((await page.getByRole('button', { name: says('Import model…') }).count()) === 1, 'the body node has Import model…')
  await treeRow(page, 'collider').click()
  await page.locator('.fold-title, .inspector-group-head', { hasText: says('Box size') }).first().waitFor({ timeout: 10000 })
  const shown = []
  for (const ax of ['X', 'Y', 'Z']) shown.push(Number(await page.locator('label.field', { has: page.locator('.field-label', { hasText: new RegExp(`^${ax}$`) }) }).locator('input').first().inputValue()))
  expect(size?.every((v, i) => Math.abs(v - shown[i]) < 0.0005), `the collider's Box size is ${size?.join(' by ')} (${shown.join(', ')})`)

  // ---- step 4: name it ----
  await treeRow(page, expectedName).click()
  for (const name of ['Name', 'Category']) await typeInto(page, says(name), info[name])
  const named = await pkgOf(page, pkgId)
  expect(named?.name === info.Name && named?.category === info.Category, `the part is "${named?.name}" in ${named?.category}`)
  await pics.ui(page, 'part-name', [field(page, 'Name'), page.locator('label.field', { has: page.getByTestId('part-category') }).first()], { pad: 4 })
  await shot(page, 'step4-named')

  // ---- step 5: mount it in a conveyor ----
  const back = page.locator('.scene-def-scope-back')
  expect(squash(await back.innerText()) === squash(says('‹ Scene')).replace('‹ ', ''), 'the Scene dock has ‹ Scene')
  await backToScene(page)
  const conveyorName = says('Roller Conveyor')
  const ids = {
    [conveyorName]: await dragIn(page, g, says('Equipment'), conveyorName, [0.5, 0.45]),
    [info.Name]: await dragIn(page, g, says(info.Category), info.Name, [0.2, 0.9]),
  }
  expect(!!ids[conveyorName] && !!ids[info.Name], `a ${conveyorName} and a ${info.Name} are placed`)
  for (const row of mount) {
    const id = ids[row.part]
    if (!expect(!!id, `the table's part "${row.part}" is one the steps placed`)) continue
    await select(page, id)
    const inputs = page.locator('.field', { has: page.locator('.field-label', { hasText: labelled(row.field) }) }).first().locator('input')
    await inputs.first().waitFor({ timeout: 10000 }).catch(() => {})
    if (!expect((await inputs.count()) >= row.values.length, `${row.part}: the Inspector has "${row.field}"`)) continue
    for (let i = 0; i < row.values.length; i++) {
      await inputs.nth(i).fill(String(row.values[i]))
      await inputs.nth(i).press('Enter')
      await sleep(250)
    }
  }
  const conveyor = await partOf(page, ids[conveyorName])
  const stop = await partOf(page, ids[info.Name])
  for (const row of mount) {
    const p = row.part === info.Name ? stop : conveyor
    const got = row.field === 'Position' ? p?.position : [p?.params[{ 'Stand Height': 'standHeight', Width: 'width' }[row.field]]]
    expect(!!got && row.values.every((v, i) => Math.abs(v - got[i]) < 0.001), `${row.part}: ${row.field} is ${row.values.join(', ')} (${got?.map((v) => +v.toFixed(3)).join(', ')})`)
  }
  // the blade's top under the rollers: a part's Y is its underside, a conveyor's the top of its rollers
  const top = named?.bounds?.top ?? 0
  expect(says('the blade stop is 0.41 m tall') && Math.abs(top - 0.41) < 0.005, `the part is 0.41 m tall (${top.toFixed(3)})`)
  const gap = conveyor.position[1] - (stop.position[1] + top)
  expect(says('1 cm below') && Math.abs(gap - 0.01) < 0.002, `the blade's top is 1 cm under the rollers (${(gap * 100).toFixed(1)} cm)`)
  expect(says("the conveyor's Y minus 0.42") && Math.abs(conveyor.position[1] - 0.42 - stop.position[1]) < 0.001, "the troubleshooting rule gives the table's Y")
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000, polling: 200 })
  const [sx, , sz] = stop.position
  await pics.scene(page, 'placed', { px: sx + 1.1, py: 1.4, pz: sz + 1.8, tx: sx - 0.2, ty: 0.6, tz: sz })
  await shot(page, 'step5-mounted')
  // the copy's row in the Scene dock: the view's own right-click needs the pointer on the model, which a script
  // can't aim at as surely as a reader does
  await treeRow(page, info.Name).click({ button: 'right' })
  await sleep(400)
  const openItem = page.getByText(says('Open Part Editor'), { exact: true }).filter({ visible: true }).first()
  expect(await openItem.isVisible().catch(() => false), "a placed copy's right-click menu has Open Part Editor")
  await page.keyboard.press('Escape')
  return { pkgId, ids }
}

/** Troubleshooting: a file that is not a model, and a blank part. Leaves a new part open in the Part Editor. */
async function troubleshooting(page, { expect, says }) {
  await page.getByRole('button', { name: says('＋ New part') }).click()
  await page.waitForFunction(() => window.__oip.store.getState().packageEdit !== null, null, { timeout: 10000 })
  const blank = await page.evaluate(() => window.__oip.store.getState().packageEdit.packageId)
  const blankPkg = await pkgOf(page, blank)
  expect(/^My Part/.test(blankPkg?.name ?? '') && says('"My Part"') && blankPkg?.links[0]?.kind === 'box', `＋ New part makes "${blankPkg?.name}", a box`)
  const dir = mkdtempSync(join(tmpdir(), 'oip-guide-part-'))
  const junk = join(dir, 'not-a-model.glb')
  writeFileSync(junk, 'a text file renamed to .glb')
  try {
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 })
    await page.getByRole('button', { name: 'Import model…' }).click()
    await (await chooser).setFiles(junk)
    const quoted = says('is not a model this importer can read.')
    const junkMsg = hint(page, 'not-a-model.glb')
    await junkMsg.waitFor({ timeout: 10000 })
    const text = squash(await junkMsg.innerText())
    expect(text.startsWith(`not-a-model.glb ${quoted}`), `a file that is not a model is refused with the page's words ("${text}")`)
    const after = await pkgOf(page, blank)
    expect(after?.links[0]?.kind === 'box', 'and the part is left as it was')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(says('.glb, .step, .stp, .usd, .usda, .usdc and .usdz') && (await page.getByTestId('catalog-import-model-input').getAttribute('accept')) === '.glb,.step,.stp,.usd,.usda,.usdc,.usdz,model/gltf-binary', 'the file picker lists the file types the page names')
}

async function main() {
  console.log('Following guides/part-model/index.html')
  const g = partModelPage()
  const shell = await launchShell()
  try {
    await g.pics.sizeWindow(shell.app)
    await followPartModel(shell.page, g)
    await troubleshooting(shell.page, g)
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
