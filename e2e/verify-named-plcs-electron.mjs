// Several controllers drive one running scene, through the real desktop shell.
//
// Three conveyor lines, each a belt, a box and a photo eye. Line A has plain tags (Eye1, Run1), so the program in the
// PLC panel runs it, here in the simulator. Lines B and C name their controllers in their tags (`Cell2::%IX100.0`,
// `Cell3::%IX100.0`, core/io/controllerTag.ts): the same addresses on two PLCs. Controller Properties sets up Cell2
// and Cell3 as PLCs that poll the simulator over Modbus TCP, each on a port of its own, and this script is both PLCs:
// two Modbus masters, each running `Run := NOT Eye` on its own connection.
//
// It checks what only the running app can show: each named controller lists its own points before Play; Play keeps
// the program attached and opens one listener per controller (apps/desktop/plcIo.cjs, one link per controller); each
// master sees only its own line's eye, and its coil drives only its own belt; every box stops at its eye; Stop
// closes both ports; and a controller the tags name but this computer has not set up is a Problems row. Then the
// authoring side: the Inspector's one Controller row per part (and per-field pickers only when a part's tags
// disagree), a name typed in another case written as it is set up, the Scene tree naming only the rows off the
// default controller, Assign to Controller from the tree's menu, and a rename that every tag follows.
//
//   node e2e/verify-named-plcs-electron.mjs
/* global process, console, window, localStorage, setTimeout */

import { mkdtempSync, rmSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))
const { OpcUaLink } = createRequire(join(desktopDir, 'package.json'))('./opcUaIo.cjs')

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** OIP_SHOT_DIR: where to save pictures of the dialogs and the Inspector, for a person to look at */
const SHOTS = process.env.OIP_SHOT_DIR ?? null
const DI = 800 // %IX100.0
const COIL = 800 // %QX100.0

/** A minimal Modbus TCP master: one request at a time, answers matched by transaction id. */
class Master {
  constructor(socket) {
    this.socket = socket
    this.tid = 0
    this.buf = Buffer.alloc(0)
    this.waiting = new Map()
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      while (this.buf.length >= 7) {
        const len = this.buf.readUInt16BE(4)
        if (this.buf.length < 6 + len) break
        const frame = this.buf.subarray(0, 6 + len)
        this.buf = this.buf.subarray(6 + len)
        const w = this.waiting.get(frame.readUInt16BE(0))
        if (w) {
          this.waiting.delete(frame.readUInt16BE(0))
          w(frame.subarray(7))
        }
      }
    })
  }

  static connect(port) {
    return new Promise((resolve, reject) => {
      const s = new Socket()
      s.once('error', reject)
      s.connect(port, '127.0.0.1', () => resolve(new Master(s)))
    })
  }

  request(pdu) {
    const tid = (this.tid = (this.tid + 1) & 0xffff)
    const head = Buffer.alloc(7)
    head.writeUInt16BE(tid, 0)
    head.writeUInt16BE(0, 2)
    head.writeUInt16BE(pdu.length + 1, 4)
    head.writeUInt8(1, 6)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to FC${pdu[0]}`)), 3000)
      this.waiting.set(tid, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      this.socket.write(Buffer.concat([head, Buffer.from(pdu)]))
    })
  }

  async readInput(addr) {
    const res = await this.request([0x02, addr >> 8, addr & 0xff, 0, 1])
    if (res[0] !== 0x02) throw new Error(`FC2 answered with exception ${res[1]}`)
    return (res[2] & 1) === 1
  }

  async writeCoil(addr, on) {
    const res = await this.request([0x05, addr >> 8, addr & 0xff, on ? 0xff : 0, 0])
    if (res[0] !== 0x05) throw new Error(`FC5 answered with exception ${res[1]}`)
  }

  close() {
    this.socket.destroy()
  }
}

const PROGRAM = `VAR_INPUT
  Eye1 : BOOL;
END_VAR
VAR_OUTPUT
  Run1 : BOOL;
END_VAR
Run1 := NOT Eye1;
`

/** Three lines 2 m apart: A on the program here, B on Cell2, C on Cell3, through the real Open path. */
async function loadScene(page) {
  return page.evaluate((program) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = ['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    const line = (key, z, eye, run) => [
      { id: `belt${key}`, type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, z], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: run } },
      { id: `box${key}`, type: 'part', packageId: 'oip.box', position: [0.6, 1.0, z], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
      { id: `eye${key}`, type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, z - 0.6], rotationY: 0, params: { maxRange: 1.2, tag: eye } },
    ]
    const error = window.__oip.loadSceneText(
      JSON.stringify({
        version: st.getState().scene.version,
        parts: [...line('A', 0, 'Eye1', 'Run1'), ...line('B', 2.5, 'Cell2::%ix100.0', 'Cell2::%QX100.0'), ...line('C', 5, 'Cell3::%IX100.0', 'Cell3::%QX100.0')],
        packages: need,
      }),
    )
    st.loadStProgram(program)
    st.setState({ selectedIds: [] })
    return error ?? true
  }, PROGRAM)
}

const boxX = (page, key) => page.evaluate((id) => window.__oip.controller.livePosition(id)?.[0] ?? null, `box${key}`)

/** One PLC's scan on its own connection, `Run := NOT Eye`, every 20 ms until `until()`; when it first saw its eye. */
async function scan(master, until) {
  let sawEye = null
  while (!until()) {
    const eye = await master.readInput(DI)
    await master.writeCoil(COIL, !eye)
    if (eye && sawEye === null) sawEye = Date.now()
    await sleep(20)
  }
  return sawEye
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const port2 = await freePort()
const port3 = await freePort()
let app
let cell2
let cell3
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })

  console.log('--- before Play ---')
  const loaded = await loadScene(page)
  expect(loaded === true, `the three-line scene opens (${loaded})`)
  const stored = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'eyeB').params.tag)
  expect(stored === 'Cell2::%IX100.0', `an address behind a controller's name is stored in its one spelling (${stored})`)

  // the project lists no controller yet: the Problems dock (and get_problems) names both
  const missingRows = await page.evaluate(async () => {
    const { problems } = await import('/src/editor/agent/toolKit.ts')
    return problems({ store: window.__oip.store, controller: window.__oip.controller }).problems.filter((p) => p.key.startsWith('controller:')).map((p) => p.subject)
  })
  expect(JSON.stringify(missingRows) === '["Cell2","Cell3"]', `a controller the tags name but the project does not list is a Problems row (${JSON.stringify(missingRows)})`)

  await showPlcEditor(page)
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 20000 })
  const offered = await page.locator('[data-testid="named-plc-missing"]').count()
  expect(offered === 2, `Controller Properties offers to add both (${offered})`)
  // add Cell2 through the dialog's own button, Cell3 through the name field
  await page.locator('[data-testid="named-plc-missing"][data-name="Cell2"] [data-testid="named-plc-set-up"]').click()
  await page.locator('[data-testid="named-plc-name"]').fill('Cell3')
  await page.locator('[data-testid="named-plc-add"]').click()
  const defaults = await page.evaluate(() => window.__oip.store.getState().externalPlc.controllers.map((c) => c.port))
  expect(JSON.stringify(defaults) === '[5021,5022]', `each new controller gets a port no other link uses (${JSON.stringify(defaults)})`)
  // the list is the project's: saved in the scene, and adding one is an edit that undoes
  const saved = await page.evaluate(() => window.__oip.store.getState().scene.plcs?.map((c) => `${c.name}:${c.runsOn}`))
  expect(JSON.stringify(saved) === '["PLC1:app","Cell2:plc","Cell3:plc"]', `the controllers are saved with the scene, the default first (${JSON.stringify(saved)})`)
  const undone = await page.evaluate(() => {
    window.__oip.store.undo()
    const names = window.__oip.store.getState().externalPlc.controllers.map((c) => c.name)
    window.__oip.store.redo()
    return names
  })
  expect(JSON.stringify(undone) === '["Cell2"]', `an undo takes the last controller added back out (${JSON.stringify(undone)})`)
  // a clash is said where it is fixed: give Cell3 Cell2's port, then put it back
  await page.evaluate(() => window.__oip.store.setNamedPlc('Cell3', { port: 5021 }))
  const clash = await page.locator('[data-testid="named-plc-Cell3-port-clash"]').innerText()
  expect(/Port 5021 is also Cell2's/.test(clash), `two links on one port are named in Controller Properties (${clash})`)
  if (SHOTS) await page.locator('[data-testid="controller-props"] .author-dialog, [data-testid="controller-props"]').first().screenshot({ path: join(SHOTS, 'controller-properties.png') })
  await page.evaluate(
    ([p2, p3]) => {
      window.__oip.store.setNamedPlc('Cell2', { mode: 'serve', port: p2 })
      window.__oip.store.setNamedPlc('Cell3', { mode: 'serve', port: p3 })
    },
    [port2, port3],
  )
  const names = await page.locator('[data-testid="named-plc"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
  expect(JSON.stringify(names) === '["Cell2","Cell3"]', `both controllers are listed (${JSON.stringify(names)})`)
  // one controller's settings open at a time: the one just added; the other is a line saying what Play will do
  const folded = { open: await page.locator('[data-testid="named-plc-Cell3-points"]').count(), summary: await page.locator('[data-testid="named-plc-Cell2-summary"]').innerText() }
  expect(folded.open === 1 && folded.summary === 'Press Play to serve these points.', `the controller just added is open, the other folded to its status line (${folded.summary})`)
  if (SHOTS) await page.locator('[data-testid="controller-props"]').screenshot({ path: join(SHOTS, 'controller-properties-folded.png') })
  await page.locator('[data-testid="named-plc-Cell2-settings"]').click()
  const points2 = await page.locator('[data-testid="named-plc-Cell2-points"]').innerText()
  expect(/%QX100\.0\s+coil 800/.test(points2) && /%IX100\.0\s+discrete input 800/.test(points2), `Cell2 lists its own points under its own names (${points2.replace(/\s+/g, ' ')})`)
  const mainExternal = await page.locator('[data-testid="external-plc-enabled"]').isChecked()
  expect(!mainExternal, 'the default controller still runs the program here')
  const nowMissing = await page.evaluate(async () => {
    const { problems } = await import('/src/editor/agent/toolKit.ts')
    return problems({ store: window.__oip.store, controller: window.__oip.controller }).problems.filter((p) => p.key.startsWith('controller:')).length
  })
  expect(nowMissing === 0, `once the project lists both, the Problems rows go (${nowMissing})`)
  await page.locator('[data-testid="controller-props-close"]').click()
  const chip = page.locator('[data-testid="plc-link-status"]')
  expect((await chip.count()) === 1 && (await chip.innerText()).trim() === '2 PLCs', `the toolbar shows the link status beside Play, counting the PLCs (${(await chip.innerText()).trim()})`)
  // the organizer has a node per controller: the default one, and each PLC
  const runsOn = await page.locator('[data-testid="org-controller-runs-on"]').innerText()
  const kinds = await page.locator('[data-testid="org-plc"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-plc')}: ${e.querySelector('[data-testid="org-plc-kind"]')?.textContent}`))
  expect(runsOn === 'default · simulated' && JSON.stringify(kinds) === '["Cell2: external PLC","Cell3: external PLC"]', `the organizer lists each controller and what runs it (${runsOn}; ${kinds.join('; ')})`)

  console.log('--- Play ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => ['Cell2', 'Cell3'].every((n) => window.__oip.controller.namedPlcStatus(n).state === 'listening'), null, { timeout: 15000, polling: 100 })
  expect(true, 'Play opens a listener for each controller')
  const attached = await page.evaluate(() => window.__oip.controller.programStatus.attached)
  expect(attached === true, 'and keeps the program here attached for line A')
  cell2 = await Master.connect(port2)
  cell3 = await Master.connect(port3)
  await page.waitForFunction(() => ['Cell2', 'Cell3'].every((n) => window.__oip.controller.namedPlcStatus(n).masters.length === 1), null, { timeout: 5000, polling: 100 })
  expect(true, 'each PLC connects on its own port')
  const title = (await chip.getAttribute('title')) ?? ''
  expect(/^Cell2: Serving on 127\.0\.0\.1:\d+: 1 connected/m.test(title) && /^Cell3: /m.test(title), `the link status has a line per controller (${title.replace(/\n/g, ' | ')})`)

  await page.waitForFunction(() => ['A', 'B', 'C'].every((k) => window.__oip.controller.livePosition(`box${k}`) != null), null, { timeout: 15000, polling: 100 })
  const x0 = { A: await boxX(page, 'A'), B: await boxX(page, 'B'), C: await boxX(page, 'C') }

  // Cell3's PLC is not scanning yet: its belt has no run signal, and its box stays put while the others ride
  let done2 = false
  const seen2 = scan(cell2, () => done2)
  await sleep(2500)
  const early = { B: await boxX(page, 'B'), C: await boxX(page, 'C') }
  expect(early.B > x0.B + 0.5, `Cell2's coil runs line B (${x0.B.toFixed(2)} -> ${early.B.toFixed(2)} m)`)
  expect(Math.abs(early.C - x0.C) < 0.01, `and not line C, whose PLC writes nothing yet, at the same address (moved ${((early.C - x0.C) * 1000).toFixed(1)} mm)`)
  let done3 = false
  const seen3 = scan(cell3, () => done3)
  await sleep(9000)
  done2 = true
  done3 = true
  const [eye2, eye3] = await Promise.all([seen2, seen3])
  expect(eye2 !== null && eye3 !== null, 'each PLC saw its own box reach its own eye')
  const end = { A: await boxX(page, 'A'), B: await boxX(page, 'B'), C: await boxX(page, 'C') }
  // each eye is 3 m along; a box stops with its front at the beam, its centre ~0.2 m short (2.83 in-process)
  for (const k of ['A', 'B', 'C']) expect(Math.abs(end[k] - 2.83) < 0.3, `line ${k}'s box stopped at its eye (x = ${end[k].toFixed(3)} m)`)
  const requests = await page.evaluate(() => window.__oip.controller.namedPlcStatus('Cell2').requests)
  expect(/FC2 x\d+, FC5 x\d+/.test(requests), `Cell2's link counted its PLC's requests (${requests})`)
  const driven = await page.evaluate(() => [...window.__oip.controller.plcDrivenKeys].sort())
  expect(JSON.stringify(driven) === '["Cell2::%QX100.0","Cell3::%QX100.0","Run1"]', `the program and both PLCs own their own outputs (${JSON.stringify(driven)})`)

  console.log('--- Stop ---')
  const closed = (m) => new Promise((resolve) => (m.socket.destroyed ? resolve(true) : (m.socket.once('close', () => resolve(true)), setTimeout(() => resolve(m.socket.destroyed), 3000))))
  const closing = [closed(cell2), closed(cell3)]
  await page.evaluate(() => window.__oip.controller.stop())
  expect((await Promise.all(closing)).every(Boolean), 'Stop drops both PLC connections')
  const refused = await Master.connect(port2).then(
    (m) => (m.close(), false),
    () => true,
  )
  expect(refused, "and closes Cell2's port")
  expect((await page.evaluate(() => window.__oip.controller.namedPlcStatus('Cell3').state)) === 'off', "Cell3's status says it is off")

  console.log('--- wiring parts to a controller ---')
  const tagOf = (id, key) => page.evaluate(([id, key]) => window.__oip.store.getState().scene.parts.find((p) => p.id === id).params[key], [id, key])
  // the Inspector: one Controller row says which controller the part's tags are on, and the tag box holds the rest
  await page.evaluate(() => window.__oip.store.selectMany(['eyeB']))
  const row = page.locator('[data-testid="part-controller-select"]')
  await row.waitFor({ timeout: 10000 })
  const box = page.locator('[data-testid="tag-field"]').first()
  expect((await row.inputValue()) === 'Cell2' && (await box.inputValue()) === '%IX100.0', `the Inspector's Controller row says Cell2 and the box holds %IX100.0 (${await row.inputValue()} / ${await box.inputValue()})`)
  expect((await page.locator('[data-testid="tag-controller"]').count()) === 0, 'with the row naming the controller, the tag field has no picker of its own')
  if (SHOTS) await page.locator('.inspector').first().screenshot({ path: join(SHOTS, 'inspector-tag.png') })
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'window.png') })
  await row.selectOption('Cell3')
  expect((await tagOf('eyeB', 'tag')) === 'Cell3::%IX100.0', `picking another controller in the row moves the tag to it (${await tagOf('eyeB', 'tag')})`)
  await page.evaluate(() => window.__oip.store.undo())
  expect((await tagOf('eyeB', 'tag')) === 'Cell2::%IX100.0', 'one undo puts it back')
  await box.click()
  await box.fill('cell3::%ix100.0')
  await box.press('Enter')
  expect((await tagOf('eyeB', 'tag')) === 'Cell3::%IX100.0', `a controller typed in the box in another case is written as it is set up, the address in its one spelling (${await tagOf('eyeB', 'tag')})`)
  await page.evaluate(() => window.__oip.store.undo())
  // two parts on different controllers: the row says so, and each field shows its own picker
  await page.evaluate(() => window.__oip.store.selectMany(['eyeA']))
  await row.waitFor({ timeout: 10000 })
  expect((await row.inputValue()) === '', `a part on the program shows Program in the row (${await row.inputValue()})`)
  await page.evaluate(() => window.__oip.store.selectMany(['eyeA', 'eyeB']))
  await page.locator('[data-testid="tag-controller"]').first().waitFor({ timeout: 10000 })
  expect((await row.inputValue()) === '::', `parts on two controllers show Mixed in the row (${await row.inputValue()})`)
  if (SHOTS) await page.locator('.inspector').first().screenshot({ path: join(SHOTS, 'inspector-mixed.png') })

  // the Scene tree names the controller only on rows off the default one
  const badge = (id) => page.locator(`[data-row-id="${id}"] [data-testid="tree-controller"]`)
  const badges = [await badge('eyeA').count(), await badge('beltA').count(), await badge('eyeB').textContent(), await badge('beltC').textContent()]
  expect(JSON.stringify(badges) === '[0,0,"Cell2","Cell3"]', `the Scene tree names Cell2 and Cell3 on their rows and nothing on the program's (${JSON.stringify(badges)})`)
  if (SHOTS) await page.locator('.scene-tree, [data-testid="scene-tree"]').first().screenshot({ path: join(SHOTS, 'scene-tree.png') }).catch(() => {})

  // the Scene tree's right-click: Assign to Controller, to a name this computer has not set up yet
  await page.evaluate(() => window.__oip.store.selectMany(['beltC', 'eyeC']))
  await page.locator('[data-row-id="eyeC"]').first().click({ button: 'right' })
  await page.locator('button.context-item', { hasText: 'Assign to Controller…' }).click()
  await page.locator('[data-testid="assign-controller"]').waitFor({ timeout: 10000 })
  expect(await page.locator('[data-testid="assign-controller-ok"]').isDisabled(), 'Assign waits for a controller to be picked')
  if (SHOTS) await page.locator('[data-testid="assign-controller"]').screenshot({ path: join(SHOTS, 'assign-controller.png') })
  await page.locator('[data-testid="assign-controller-name"]').fill('Cell9')
  await page.locator('[data-testid="assign-controller-ok"]').click()
  const assigned = [await tagOf('beltC', 'runTag'), await tagOf('eyeC', 'tag')]
  expect(JSON.stringify(assigned) === '["Cell9::%QX100.0","Cell9::%IX100.0"]', `the right-click menu's Assign to Controller moves the selection's tags (${assigned.join(', ')})`)
  const setUp = await page.evaluate(() => window.__oip.store.getState().externalPlc.controllers.map((c) => c.name))
  expect(setUp.includes('Cell9'), `and adds a controller the project did not list (${setUp.join(', ')})`)
  const afterUndo = await page.evaluate(() => {
    window.__oip.store.undo()
    const s = window.__oip.store.getState()
    return [s.scene.parts.find((p) => p.id === 'eyeC').params.tag, s.externalPlc.controllers.some((c) => c.name === 'Cell9')]
  })
  expect(JSON.stringify(afterUndo) === '["Cell3::%IX100.0",false]', `one undo takes back both the tags and the controller it added (${JSON.stringify(afterUndo)})`)

  // rename, in Controller Properties: the controller and every tag on it
  await showPlcEditor(page)
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="named-plc-Cell3-rename"]').click()
  const field = page.locator('[data-testid="named-plc-Cell3-rename-field"]')
  await field.fill('Packing')
  await field.press('Enter')
  const renamed = await page.evaluate(() => window.__oip.store.getState().externalPlc.controllers.map((c) => c.name))
  expect(JSON.stringify(renamed) === '["Cell2","Packing"]', `a controller is renamed where it is set up (${renamed.join(', ')})`)
  const moved = [await tagOf('beltC', 'runTag'), await tagOf('eyeC', 'tag')]
  expect(JSON.stringify(moved) === '["Packing::%QX100.0","Packing::%IX100.0"]', `and every tag on it follows (${moved.join(', ')})`)
  const back = await page.evaluate(() => {
    window.__oip.store.undo()
    const s = window.__oip.store.getState()
    return [s.externalPlc.controllers.map((c) => c.name).join(','), s.scene.parts.find((p) => p.id === 'eyeC').params.tag, s.externalPlc.controllers[1].port]
  })
  expect(JSON.stringify(back) === `["Cell2,Cell3","Cell3::%IX100.0",${port3}]`, `one undo takes the name and the tags back, and the address is still there (${JSON.stringify(back)})`)
  // the default controller has a name too, and its tags carry none, so its rename moves no tag
  await page.locator('[data-testid="plc-default-rename"]').click()
  await page.locator('[data-testid="plc-default-rename-field"]').fill('Line')
  await page.locator('[data-testid="plc-default-rename-field"]').press('Enter')
  const main = await page.evaluate(() => [window.__oip.store.getState().externalPlc.mainName, window.__oip.store.getState().scene.parts.find((p) => p.id === 'eyeA').params.tag])
  expect(JSON.stringify(main) === '["Line","Eye1"]', `the default controller is renamed in Controller Properties, its tags untouched (${JSON.stringify(main)})`)
  if (SHOTS) await page.locator('[data-testid="controller-props"]').screenshot({ path: join(SHOTS, 'controller-properties-renamed.png') })
  await page.locator('[data-testid="controller-props-close"]').click()
  // a controller the simulator runs: Cell3 runs line C's program instance here, on memory and I/O of its own, with
  // no PLC connected. The same addresses as line B's, which Cell2 would carry, so only the controller tells them apart
  console.log('--- a controller the simulator runs ---')
  // a task on a controller the project does not list: its node claims no setup, and points at where it is set up
  await page.evaluate(() => {
    const st = window.__oip.store
    st.commitProgram('A task on Cell4', {
      source: st.getState().stProgram,
      controller: {
        tasks: [
          { name: 'MainTask', intervalMs: 10, priority: 10 },
          { name: 'Cell4Task', intervalMs: 10, priority: 10, plc: 'Cell4' },
        ],
        programs: [{ name: 'Main', task: 'MainTask' }],
      },
    })
  })
  const cell4 = page.locator('[data-testid="org-plc"][data-plc="Cell4"]')
  await cell4.waitFor({ timeout: 10000 })
  const cell4Kind = await cell4.locator('[data-testid="org-plc-kind"]').innerText()
  const cell4Note = await cell4.locator('[data-testid="org-plc-unlisted"]').innerText().catch(() => '')
  expect(cell4Kind === 'not set up' && /nothing runs its tasks/.test(cell4Note), `a controller only a task names says it is not set up, not that a PLC runs it (${cell4Kind}; ${cell4Note})`)
  await cell4.locator('[data-testid="org-plc-set-up"]').click()
  await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 20000 })
  const offer = await page.locator('[data-testid="named-plc-missing"][data-name="Cell4"]').innerText().catch(() => '')
  expect(/Tasks run on Cell4/.test(offer), `"Set up" opens Controller Properties, which offers to add it (${offer})`)
  await page.locator('[data-testid="controller-props-close"]').click()
  await page.evaluate((source) => {
    const st = window.__oip.store
    st.commitProgram('Run line C on Cell3', {
      source,
      controller: {
        tasks: [
          { name: 'MainTask', intervalMs: 10, priority: 10 },
          { name: 'Cell3Task', intervalMs: 10, priority: 10, plc: 'Cell3' },
        ],
        programs: [{ name: 'Main', task: 'MainTask' }, { name: 'LineC', type: 'Line', task: 'Cell3Task' }],
      },
    })
    st.setNamedPlc('Cell2', { enabled: false })
  }, `PROGRAM Line\nVAR\n  Eye AT %IX100.0 : BOOL;\n  Run AT %QX100.0 : BOOL;\nEND_VAR\nRun := NOT Eye;\nEND_PROGRAM\n\n${PROGRAM}`)
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 20000 })
  await page.locator('[data-testid="named-plc-Cell3-simulator"]').check()
  const sim3 = await page.evaluate(() => window.__oip.store.getState().scene.plcs?.find((c) => c.name === 'Cell3')?.runsOn)
  expect(sim3 === 'app', `Controller Properties runs Cell3 in the simulator, saved with the project (${sim3})`)
  const runsText = await page.locator('[data-testid="named-plc-Cell3-instances"]').innerText()
  expect(/LineC/.test(runsText), `and says which program instance it runs (${runsText})`)
  // Cell3 has an OPC UA server of its own, as each PLC on a line has
  await page.locator('[data-testid="named-plc-Cell3-opcua-enabled"]').check()
  const uaPort3 = await freePort()
  await page.evaluate((p) => window.__oip.store.setNamedPlc('Cell3', { uaServerPort: p }), uaPort3)
  await page.waitForFunction(() => window.__oip.controller.namedUaServerStatus('Cell3').state === 'serving', null, { timeout: 30000, polling: 200 })
  if (SHOTS) await page.locator('[data-testid="controller-props"]').screenshot({ path: join(SHOTS, 'controller-properties-simulated.png') })
  await page.locator('[data-testid="controller-props-close"]').click()
  const label = await page.locator('[data-testid="org-plc"][data-plc="Cell3"] [data-testid="org-plc-kind"]').innerText()
  expect(label === 'simulated', `the organizer's Cell3 node says it is simulated (${label})`)
  // Cell3 is a node of its own, with its task and the instance on it
  await page.locator('[data-testid="org-plc"][data-plc="Cell3"]').waitFor({ timeout: 10000 })
  const cell3Group = await page.locator('[data-testid="org-plc"][data-plc="Cell3"]').innerText().catch(() => '')
  expect(/Cell3/.test(cell3Group) && /simulated/.test(cell3Group) && /Cell3Task/.test(cell3Group) && /LineC/.test(cell3Group), `the organizer lists Cell3 with its own task and instance (${cell3Group.replace(/\s+/g, ' ')})`)
  if (SHOTS) await page.locator('[data-testid="plc-organizer"]').screenshot({ path: join(SHOTS, 'organizer-by-controller.png') }).catch(() => {})
  const noRows = await page.evaluate(async () => {
    const { problems } = await import('/src/editor/agent/toolKit.ts')
    return problems({ store: window.__oip.store, controller: window.__oip.controller }).problems.filter((p) => p.key.startsWith('instance-plc:') || p.key.startsWith('controller-idle:') || p.key.startsWith('unbound:')).map((p) => p.key)
  })
  expect(noRows.length === 0, `the Problems dock finds nothing to say about it (${JSON.stringify(noRows)})`)

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.programStatus.attached, null, { timeout: 15000, polling: 100 })
  await page.waitForFunction(() => ['A', 'C'].every((k) => window.__oip.controller.livePosition(`box${k}`) != null), null, { timeout: 15000, polling: 100 })
  const cOff = await page.evaluate(() => window.__oip.controller.namedPlcStatus('Cell3').state)
  expect(cOff === 'off', `Cell3 opens no link, since nothing outside the app runs it (${cOff})`)
  await sleep(9000)
  const simEnd = { A: await boxX(page, 'A'), C: await boxX(page, 'C') }
  for (const k of ['A', 'C']) expect(Math.abs(simEnd[k] - 2.83) < 0.3, `line ${k}'s box stopped at its eye with no PLC connected (x = ${simEnd[k].toFixed(3)} m)`)
  const simDriven = await page.evaluate(() => [...window.__oip.controller.plcDrivenKeys].sort())
  expect(JSON.stringify(simDriven) === '["Cell3::%QX100.0","Run1"]', `the default controller and simulated Cell3 each own their own outputs (${JSON.stringify(simDriven)})`)
  const watched = await page.evaluate(() => Object.keys(window.__oip.controller.plcWatch ?? {}).filter((k) => k.startsWith('LineC.')).sort())
  expect(watched.includes('LineC.Run'), `the watch table shows Cell3's instance by its own name (${watched.join(', ')})`)
  // a SCADA reaches Cell3 on its own endpoint, and finds Cell3's program there, not the default controller's
  const scada = new OpcUaLink(join(profileDir, 'scada-pki'), () => {})
  try {
    const endpoint = await page.evaluate(() => window.__oip.controller.namedUaServerStatus('Cell3').endpoint)
    const joined = await scada.connect(endpoint)
    expect(joined.error === '', `a client connects to Cell3's own OPC UA server (${endpoint} ${joined.error})`)
    const paths = (await scada.browse()).variables.map((v) => v.path.join('.')).sort()
    expect(paths.includes('PLC.LineC.Run') && !paths.some((p) => /Run1|Eye1/.test(p)), `it publishes Cell3's program and none of the default controller's (${paths.join(', ')})`)
    const runId = (await scada.browse()).variables.find((v) => v.path.join('.') === 'PLC.LineC.Run')?.nodeId
    const read = await scada.exchange([], [runId])
    expect(read.reads?.[0]?.value === false, `and serves its live value: LineC.Run is FALSE with its box at the eye (${JSON.stringify(read.reads?.[0])})`)
  } finally {
    await scada.close().catch(() => {})
  }
  await page.evaluate(() => window.__oip.controller.stop())

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  cell2?.close()
  cell3?.close()
  await app?.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall named-plcs-electron checks passed')
// node-opcua's client leaves handles open that would otherwise hold the process
process.exit(0)
