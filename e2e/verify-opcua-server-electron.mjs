// The simulated PLC's OPC UA server, through the real desktop shell: a SCADA or HMI connects to the
// simulator the way it connects to a real PLC's own server, while the program in the PLC panel runs here.
//
// This script acts as the SCADA: an OPC UA client (node-opcua, from the shell's own dependencies) that browses the
// program's variables, subscribes to the photo eye, and presses Start. The scene is a belt and an eye wired to the
// program by name (Main.Run, Main.Eye); the program is `Run := Start AND NOT Eye`, so the belt only runs once the
// client writes Start, and the box stops at the eye.
//
// It checks what only the running app can show: the server starts when switched on, before any Play, and publishes
// the program as it compiles; stopped, the values read out of service and a write is refused; on Play they go live
// with no new subscription; a client's write drives the line; an input the scene feeds is read-only; Stop and Play
// again keep the client's subscription; Controller Properties names the client. A browser tab cannot listen, and says so.
//
//   node e2e/verify-opcua-server-electron.mjs
/* global process, console, window, localStorage, setTimeout, URL */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))
const desktopRequire = createRequire(join(desktopDir, 'package.json'))
const { OpcUaLink } = desktopRequire('./opcUaIo.cjs')
const { AttributeIds, TimestampsToReturn } = desktopRequire('node-opcua-client')

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROGRAM = `PROGRAM Main
VAR
  Start : BOOL;
  Eye : BOOL;
  Run : BOOL;
  Speed : REAL := 0.5;
END_VAR
Run := Start AND NOT Eye;
END_PROGRAM
`

/** The belt and eye, wired to the program's variables by name, and the program. */
async function loadScene(page) {
  return page.evaluate((program) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = ['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    const error = window.__oip.loadSceneText(JSON.stringify({
      version: st.getState().scene.version,
      parts: [
        { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0,
          params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Main.Run' } },
        { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
        { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: { maxRange: 1.2, tag: 'Main.Eye' } },
      ],
      packages: need,
    }))
    if (error) return error
    st.loadStProgram(program)
    st.setState({ selectedIds: [] })
    return true
  }, PROGRAM)
}

const boxX = (page) => page.evaluate(() => window.__oip.controller.livePosition('box')?.[0] ?? null)
const serverStatus = (page) => page.evaluate(() => window.__oip.controller.opcUaServerStatus)

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const port = await freePort()
let app
let client
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

  console.log('--- switched on, before Play ---')
  const loaded = await loadScene(page)
  expect(loaded === true, `the scene and program open (${loaded})`)
  await showPlcEditor(page)
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="opcua-server"]').waitFor({ timeout: 20000 })
  expect((await page.locator('[data-testid="controller-desktop-only"]').count()) === 0, 'the desktop app offers the OPC UA server')
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ uaServer: true, uaServerPort: p }), port)
  await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.state === 'serving' && window.__oip.controller.opcUaServerStatus.variables > 0, null, { timeout: 30000, polling: 100 })
  const st0 = await serverStatus(page)
  expect(st0.endpoint === `opc.tcp://127.0.0.1:${port}`, `it listens on this machine (${st0.endpoint})`)
  expect(st0.variables === 4 && st0.writable === 3, `and publishes the program before Play: 4 variables, 3 writable (${st0.variables}, ${st0.writable})`)

  // the SCADA connects and finds the program where a PLC's server keeps it
  client = new OpcUaLink(join(profileDir, 'scada-pki'), () => {})
  const connected = await client.connect(st0.endpoint)
  expect(connected.error === '', `a client connects (${connected.error})`)
  const { variables } = await client.browse()
  const paths = variables.map((v) => v.path.join('.')).sort()
  expect(JSON.stringify(paths) === JSON.stringify(['PLC.Main.Eye', 'PLC.Main.Run', 'PLC.Main.Speed', 'PLC.Main.Start']), `it browses the program under Objects / PLC (${paths.join(', ')})`)
  const id = (name) => variables.find((v) => v.path.join('.') === `PLC.Main.${name}`)?.nodeId
  expect(id('Start') === 'ns=1;s=Main.Start', `a variable's NodeId is its name (${id('Start')})`)
  const types = await client.describe([id('Start'), id('Eye'), id('Speed')])
  expect(JSON.stringify(types) === JSON.stringify([{ dataType: 'ns=0;i=1', builtin: 1, access: 3 }, { dataType: 'ns=0;i=1', builtin: 1, access: 1 }, { dataType: 'ns=0;i=10', builtin: 10, access: 3 }]), `types and access follow the declarations, the eye the scene feeds read-only (${JSON.stringify(types)})`)
  let r = await client.exchange([{ nodeId: id('Start'), builtin: 1, value: true }], [id('Eye')])
  expect(r.reads?.[0]?.status === 'BadOutOfService' && r.writes?.[0] === 'BadInvalidState', `stopped, a read is out of service and a write refused (${JSON.stringify(r)})`)
  await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.clients.length === 1, null, { timeout: 5000, polling: 100 })
  const said = await page.locator('[data-testid="opcua-server-status"]').innerText()
  expect(/^Serving opc\.tcp:\/\/127\.0\.0\.1:\d+: 1 connected \(Open Industry Project \(127\.0\.0\.1\)\), 4 variables, 3 writable\. Stopped: they read as out of service until Play\.$/.test(said), `Controller Properties names the client (${said})`)
  await page.locator('[data-testid="controller-props-close"]').click()

  // a subscription, as a SCADA keeps one: it must see the eye change, across Stop and Play, without being made again
  const seen = []
  const sub = await client.session.createSubscription2({ requestedPublishingInterval: 100, requestedMaxKeepAliveCount: 20, publishingEnabled: true })
  const item = await sub.monitor({ nodeId: id('Eye'), attributeId: AttributeIds.Value }, { samplingInterval: 100, queueSize: 20, discardOldest: true }, TimestampsToReturn.Both)
  item.on('changed', (dv) => seen.push({ status: dv.statusCode.name, value: dv.value?.value ?? null }))

  console.log('--- Play: the SCADA runs the line ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.live && window.__oip.controller.livePosition('box') != null, null, { timeout: 20000, polling: 100 })
  await sleep(1500)
  const x0 = await boxX(page)
  r = await client.exchange([], [id('Start'), id('Run'), id('Speed')])
  expect(JSON.stringify(r.reads) === JSON.stringify([{ value: false, status: 'Good' }, { value: false, status: 'Good' }, { value: 0.5, status: 'Good' }]), `on Play the values go live (${JSON.stringify(r.reads)})`)
  expect(Math.abs((await boxX(page)) - x0) < 0.05, 'and the belt waits for Start')
  r = await client.exchange([{ nodeId: id('Start'), builtin: 1, value: true }], [])
  expect(r.writes?.[0] === 'Good', `the client presses Start (${JSON.stringify(r.writes)})`)
  r = await client.exchange([{ nodeId: id('Eye'), builtin: 1, value: true }], [])
  expect(r.writes?.[0] === 'BadNotWritable', `an input the scene feeds refuses a write (${JSON.stringify(r.writes)})`)
  const t0 = Date.now()
  let atEye = null
  while (Date.now() - t0 < 20000) {
    if (seen.some((s) => s.status === 'Good' && s.value === true)) {
      atEye = Date.now()
      break
    }
    await sleep(50)
  }
  expect(atEye !== null, `the subscription sees the eye (after ${atEye === null ? '-' : ((atEye - t0) / 1000).toFixed(1)} s)`)
  await sleep(1500)
  const stopped = await boxX(page)
  expect(typeof x0 === 'number' && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the program ran the belt and stopped the box at the eye (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
  r = await client.exchange([], [id('Start'), id('Run')])
  expect(r.reads?.[0]?.value === true && r.reads?.[1]?.value === false, `the program's own variables say so (Start ${r.reads?.[0]?.value}, Run ${r.reads?.[1]?.value})`)
  const watched = await page.evaluate(() => window.__oip.controller.plcWatch?.['Main.Start'])
  expect(watched === true, `the watch table shows the client's write (Main.Start = ${watched})`)
  await page.locator('[data-testid="org-controller"]').dblclick()
  const lastWrite = await page.locator('[data-testid="opcua-server-last-write"]').innerText()
  expect(lastWrite === 'Last write from a client: Main.Start := TRUE', `Controller Properties shows the last write (${lastWrite})`)
  await page.locator('[data-testid="controller-props-close"]').click()

  console.log('--- Stop and Play again ---')
  await page.evaluate(() => window.__oip.controller.stop())
  await sleep(800)
  r = await client.exchange([], [id('Eye')])
  expect(r.reads?.[0]?.status === 'BadOutOfService', `Stop takes the values out of service (${r.reads?.[0]?.status})`)
  expect(seen.at(-1)?.status === 'BadOutOfService', `and the subscription is told (${JSON.stringify(seen.at(-1))})`)
  const before = seen.length
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.live, null, { timeout: 20000, polling: 100 })
  await sleep(1000)
  expect(seen.slice(before).some((s) => s.status === 'Good'), `Play brings the same subscription back to Good (${JSON.stringify(seen.slice(before))})`)
  r = await client.exchange([], [id('Start')])
  expect(r.reads?.[0]?.value === false, 'and the program starts over, Start released')
  await page.evaluate(() => window.__oip.controller.stop())

  // switched off: the port closes and the client is dropped
  await page.evaluate(() => window.__oip.store.setExternalPlc({ uaServer: false }))
  await page.waitForFunction(() => window.__oip.controller.opcUaServerStatus.state === 'off', null, { timeout: 10000, polling: 100 })
  await sub.terminate().catch(() => {})
  await client.close()
  client = new OpcUaLink(join(profileDir, 'scada-pki'), () => {})
  const refused = await client.connect(st0.endpoint)
  expect(/nothing answered/.test(refused.error), `switched off, the port is closed (${refused.error})`)
  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await client?.close().catch(() => {})
  await app?.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
}

// A browser tab cannot listen on a port, and Controller Properties says so rather than showing a dead switch
try {
  console.log('--- a browser tab ---')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(url)
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    await showPlcEditor(page)
    await page.locator('[data-testid="org-controller"]').dblclick()
    await page.locator('[data-testid="controller-desktop-only"]').waitFor({ timeout: 20000 })
    const text = await page.locator('[data-testid="controller-desktop-only"]').innerText()
    expect(/needs the desktop app/.test(text), `the browser explains why there is no server (${text})`)
    expect(await page.locator('[data-testid="opcua-server-enabled"]').isDisabled(), 'and its switch is off')
  } finally {
    await browser.close()
  }
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall opcua-server-electron checks passed')
// node-opcua's client leaves handles open that would otherwise hold the process
process.exit(0)
