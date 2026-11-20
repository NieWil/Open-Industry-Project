// Follows the published OPC UA guide, guides/opcua/index.html (/guides/opcua/), step by step, in the real desktop
// shell, with an OPC UA client in place of the reader's SCADA.
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the
// rule): the program is the page's own <pre>, the wiring the page's table, the endpoint and every NodeId, type and
// access the page's tables, and each status line, label and status code it quotes is looked up on the page first.
//
//   step 1  the parts' Comms fields set through the Inspector, by name (Main.Eye, Main.Run, Main.Speed)
//   step 2  the page's program typed into the PLC panel's code editor
//   step 3  PLC Controllers... from the palette; "Publish the program's variables" ticked; the port; the status line
//   step 4  the client connects to the page's endpoint, finds the server by the page's name, browses PLC / Main, and
//           every variable has the NodeId, type and access the page's table gives
//   step 5  before Play: out of service, a write refused; Play: good, the belt waits; Start: the belt runs and the
//           box stops at the eye, a write to the eye refused; the last write shown; Stop and Play keep the
//           subscription; a Speed setpoint written by the client sets the belt's speed
//
// What it does not do: run a SCADA product. The client is node-opcua, the shell's own dependency, so this proves the page
// and the app agree, not that a given SCADA's screens read the way the page says (the page names none). Placing the
// parts from the library is not driven; the scene starts with them placed and unwired.
//
// Usage:
//   node e2e/guide-opcua.mjs                    follow the guide; exit 0 = it works as written
//   node e2e/guide-opcua.mjs --shots <dir>      also save a screenshot per step
//   node e2e/guide-opcua.mjs --images           also retake the page's pictures (guides/opcua/img/, see guidePictures)
//
// Needs the guide's port (4843) free. Opens a desktop-shell window for the run.
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { showPlcEditor } from './_plc.mjs'
import { boxX, commsGroup, guidePictures, guideTest, LINE_CAMERA, labelled, launchShell, loadParts, openExternalPlc, settledX, shot as shotTo, sleep, DESKTOP_DIR, squash, waitForReset, wire as wireRow } from './_guide.mjs'

const desktopRequire = createRequire(join(DESKTOP_DIR, 'package.json'))
const { OpcUaLink } = desktopRequire('./opcUaIo.cjs')
const { AttributeIds, TimestampsToReturn } = desktopRequire('node-opcua-client')

const argv = process.argv.slice(2)
const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
const shot = (page, name) => shotTo(page, shotsDir, name)

// ---- the page ----

const { html, expect, says, programs, wiring, failures } = guideTest('opcua')
const pics = guidePictures('opcua', { html, expect })
/** Step 2's program, and step 3's expected status line (the page's two listings, in order). */
const [program, statusLine] = programs
/** Step 4's variable table: name, NodeId, type, what a client may do. */
const variables = [...html.matchAll(/<tr><td>(\w+)<\/td><td class="m">(ns=[^<]+)<\/td><td>(\w+)<\/td><td>([^<]+)<\/td><\/tr>/g)].map((m) => ({
  name: m[1],
  nodeId: m[2],
  type: m[3],
  writable: m[4].startsWith('read and write'),
}))
const endpoint = /<code>(opc\.tcp:\/\/127\.0\.0\.1:\d+)<\/code> on the same computer/.exec(html)?.[1]
const guidePort = Number(/Port<\/span>: <b>(\d+)<\/b>/.exec(html)?.[1])
/** OPC UA built-in types the page names, as node-opcua reports a variable's DataType. */
const DATA_TYPE = { Boolean: 'ns=0;i=1', Float: 'ns=0;i=10' }

const PART_IDS = { 'Belt Conveyor': 'belt', 'Photo Eye': 'eye' }
const loadScene = (page) =>
  loadParts(page, [
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5 } },
    { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: {} },
  ])

const serverStatus = (page) => page.evaluate(() => window.__oip.controller.opcUaServerStatus)

/** The box's speed in m/s between two positions along the belt, sampled every 100 ms (null if it never crossed both). */
async function speedBetween(page, from, to, timeoutMs = 30000) {
  let a = null
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const x = await boxX(page)
    if (a === null && x !== null && x >= from) a = { t: Date.now(), x }
    if (a !== null && x !== null && x >= to) return (x - a.x) / ((Date.now() - a.t) / 1000)
    await sleep(100)
  }
  return null
}

async function main() {
  console.log('Following guides/opcua/index.html')
  expect(wiring.length === 3, `the guide wires three fields (${wiring.map((w) => `${w.part} ${w.field} = ${w.address}`).join(', ')})`)
  expect(variables.length === 4, `the guide lists four variables (${variables.map((v) => v.name).join(', ')})`)
  expect(!!program && !!statusLine, 'the guide has its program and its status line')
  expect(endpoint === `opc.tcp://127.0.0.1:${guidePort}`, `its endpoint is on the port step 3 sets (${endpoint})`)
  if (failures()) return 1

  const shell = await launchShell()
  const { page } = shell
  await pics.sizeWindow(shell.app)
  const pki = mkdtempSync(join(tmpdir(), 'oip-guide-scada-'))
  let client = null
  try {
    console.log('--- step 1: build the scene and wire it to the program ---')
    expect((await loadScene(page)) === true, 'the scene opens with a belt, a box and a photo eye, unwired')
    for (const row of wiring) await wireRow(page, row, { expect, says, partIds: PART_IDS })
    await shot(page, 'step1-inspector')
    await pics.ui(page, 'inspector-comms', commsGroup(page))

    console.log('--- step 2: write the program ---')
    await showPlcEditor(page)
    const code = page.locator('.cm-content').first()
    await code.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(program)
    await page.waitForFunction((tail) => window.__oip.store.getState().stProgram.includes(tail), 'Run := Start AND NOT Eye;', { timeout: 10000, polling: 100 })
    expect(squash(await page.evaluate(() => window.__oip.store.getState().stProgram)) === squash(program), "the PLC panel holds the guide's program")
    await shot(page, 'step2-program')

    console.log('--- step 3: start the OPC UA server ---')
    await openExternalPlc(page, { expect, says })
    const ext = page.locator('[data-testid="external-plc"]')
    await ext.waitFor({ timeout: 20000 })
    expect(await ext.locator('label.ctl-ext-field', { hasText: labelled(says('This simulator')) }).locator('input').isChecked(), '"Runs on" is This simulator')
    const section = page.locator('[data-testid="opcua-server"]')
    expect((await section.locator('h3').innerText()).trim() === says('OPC UA server'), 'the section is "OPC UA server"')
    await section.locator('label.ctl-ext-field', { hasText: labelled(says("Publish the program's variables")) }).locator('input').check()
    expect((await page.locator('[data-testid="opcua-server-port"]').inputValue()) === String(guidePort), `the port reads ${guidePort}`)
    const network = section.locator('label.ctl-ext-field', { hasText: labelled(says('Reachable from the network')) }).locator('input')
    expect((await network.count()) === 1 && !(await network.isChecked()), '"Reachable from the network" is there, and off')
    await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.state === 'serving' && window.__oip.controller.opcUaServerStatus.variables > 0, null, { timeout: 20000, polling: 100 })
    const before = squash(await page.locator('[data-testid="opcua-server-status"]').innerText())
    expect(before === squash(statusLine), `the status line is the guide's, before any Play ("${before}")`)
    await shot(page, 'step3-server')
    await pics.ui(page, 'opcua-server', section)
    await page.keyboard.press('Escape')

    console.log('--- step 4: connect the client ---')
    client = new OpcUaLink(pki, () => {})
    const connected = await client.connect(endpoint)
    expect(connected.error === '', `a client connects to ${endpoint} (${connected.error || 'ok'})`)
    const product = await client.session.read({ nodeId: 'ns=0;i=2261', attributeId: AttributeIds.Value })
    expect(product.value?.value === says('Open Industry Project simulator'), `the server calls itself "${product.value?.value}"`)
    const { variables: found } = await client.browse()
    const paths = found.map((v) => v.path.join(' > ')).sort()
    says('Objects')
    expect(JSON.stringify(paths) === JSON.stringify(variables.map((v) => `${says('PLC')} > ${says('Main')} > ${v.name}`).sort()), `PLC > Main holds the guide's four variables (${paths.join(', ')})`)
    for (const v of variables) {
      const node = found.find((f) => f.path.join('.') === `PLC.Main.${v.name}`)
      expect(node?.nodeId === v.nodeId, `${v.name}'s NodeId is ${v.nodeId} (${node?.nodeId})`)
    }
    const described = await client.describe(variables.map((v) => v.nodeId))
    variables.forEach((v, i) => {
      const d = described[i]
      expect(d?.dataType === DATA_TYPE[v.type], `${v.name} is a ${v.type} (${d?.dataType})`)
      expect((d?.access === 3) === v.writable, `${v.name} is ${v.writable ? 'read and write' : 'read only'} (access ${d?.access})`)
    })
    await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.clients.length === 1, null, { timeout: 5000, polling: 100 })
    const named = (await serverStatus(page)).clients
    await openExternalPlc(page, { expect, says })
    const withClient = squash(await page.locator('[data-testid="opcua-server-status"]').innerText())
    expect(withClient.startsWith(says(`Serving opc.tcp://127.0.0.1:${guidePort}: 1 connected (`)), `the status line names the client ("${withClient}", ${named.join(', ')})`)
    await page.keyboard.press('Escape')

    console.log('--- step 5: run the line from the client ---')
    const id = Object.fromEntries(variables.map((v) => [v.name, v.nodeId]))
    let r = await client.exchange([{ nodeId: id.Start, builtin: 1, value: true }], [id.Eye])
    expect(r.reads?.[0]?.status === says('BadOutOfService') && r.writes?.[0] === says('BadInvalidState'), `before Play: a read is out of service and a write refused (${JSON.stringify(r)})`)
    // a subscription, as the page says to keep one, on the eye and the motor
    const seen = []
    const sub = await client.session.createSubscription2({ requestedPublishingInterval: 100, requestedMaxKeepAliveCount: 20, publishingEnabled: true })
    const item = await sub.monitor({ nodeId: id.Eye, attributeId: AttributeIds.Value }, { samplingInterval: 100, queueSize: 20, discardOldest: true }, TimestampsToReturn.Both)
    item.on('changed', (dv) => seen.push({ status: dv.statusCode.name, value: dv.value?.value ?? null }))

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.live, null, { timeout: 20000, polling: 100 })
    await waitForReset(page)
    await sleep(1500)
    const x0 = await boxX(page)
    r = await client.exchange([], [id.Start, id.Eye, id.Run, id.Speed])
    const values = r.reads?.map((x) => `${x.value}/${x.status}`).join(', ')
    expect(values === 'false/Good, false/Good, false/Good, 0.5/Good', `on Play the values turn good: Start, Eye and Run false, Speed 0.5 (${values})`)
    expect(Math.abs((await boxX(page)) - x0) < 0.05, 'and the belt waits')
    expect(await page.evaluate(() => window.__oip.controller.programStatus.error === null), 'the program compiled with no errors')

    r = await client.exchange([{ nodeId: id.Start, builtin: 1, value: true }], [])
    expect(r.writes?.[0] === 'Good', `the client writes true to Start (${r.writes?.[0]})`)
    const stopped = await settledX(page, 25000, 1500)
    expect(seen.some((s) => s.status === 'Good' && s.value === true), 'the subscription sees Eye turn true')
    expect(stopped !== null && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the belt ran and stopped the box at the sensor (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
    await pics.scene(page, 'box-stopped', LINE_CAMERA)
    r = await client.exchange([{ nodeId: id.Eye, builtin: 1, value: false }], [])
    expect(r.writes?.[0] === says('BadNotWritable'), `a write to Eye is refused (${r.writes?.[0]})`)
    await openExternalPlc(page, { expect, says })
    const lastWrite = await page.locator('[data-testid="opcua-server-last-write"]').innerText()
    expect(lastWrite === says('Last write from a client: Main.Start := TRUE'), `Controller Properties shows the last write ("${lastWrite}")`)
    await shot(page, 'step5-last-write')
    await page.keyboard.press('Escape')

    // Stop and Play keep the connection
    await page.evaluate(() => window.__oip.controller.stop())
    await sleep(800)
    expect(seen.at(-1)?.status === 'BadOutOfService', `on Stop the subscription reads out of service (${seen.at(-1)?.status})`)
    const mark = seen.length
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.live, null, { timeout: 20000, polling: 100 })
    await waitForReset(page)
    await sleep(800)
    expect(seen.slice(mark).some((s) => s.status === 'Good'), 'on Play the same subscription turns good again')

    // the optional setpoint: 0.2 to Speed, then Start
    r = await client.exchange([{ nodeId: id.Speed, builtin: 10, value: 0.2 }], [])
    expect(r.writes?.[0] === 'Good', `the client writes ${says('0.2')} to Speed (${r.writes?.[0]})`)
    await client.exchange([{ nodeId: id.Start, builtin: 1, value: true }], [])
    const v = await speedBetween(page, 1.0, 2.0)
    expect(v !== null && Math.abs(v - 0.2) < 0.05, `the belt carries the box at the new speed (${v?.toFixed?.(2)} m/s)`)
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await client?.close().catch(() => {})
    await shell.close()
    rmSync(pki, { recursive: true, force: true })
  }
  await pics.finish()
  console.log(failures() === 0 ? '\nThe guide works as written.' : `\n${failures()} check(s) failed: the guide or the app has to change.`)
  return failures() === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
