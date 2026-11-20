// An external PLC drives the running scene, through the real desktop shell.
//
// The scene is wired to I/O points: a photo eye's PLC tag is %IX100.0 and a belt's run tag %QX100.0. With
// External PLC on (Controller Properties), Play serves those points over Modbus TCP from the shell's socket
// (apps/desktop/plcIo.cjs -> editor/links/externalPlc.ts) instead of running a program here. This script is the
// PLC: a Modbus master on a real TCP connection that reads the eye (discrete input 800) and writes the
// belt (coil 800) with the rung `Run := NOT Eye`, the way OpenPLC's master did in `npm run openplc-loop`.
//
// It checks what only the running app can show: Controller Properties lists the points before Play; Play opens the
// port and reports the PLC connecting; the box rides to the eye and the PLC's coil stops it; Play starts at 1x
// and another speed warns on the speed button; Stop closes the port. A browser tab cannot listen, and the last check is that it says so.
//
//   node e2e/verify-external-plc-electron.mjs
/* global process, console, window, document, URL, localStorage, setTimeout */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, Socket } from 'node:net'
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

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

/**
 * A PLC that serves its process image, the way a PLC's Modbus server device does: the simulator writes
 * holding registers (the PLC's inputs) and reads input registers (its outputs). Its scan runs the rung
 * `Run := NOT Eye` on every write, Eye being holding register 0 bit 0 and Run input register 0 bit 0 -
 * which is %IX100.0 and %QX100.0 once Controller Properties says the device's registers start at %IW50 / %QW50.
 */
function servingPlc() {
  const hr = new Uint16Array(65536)
  const ir = new Uint16Array(65536)
  const state = { silent: false, force: false, requests: 0, open: 0 }
  const sockets = new Set()
  const scan = () => {
    ir[0] = state.force || (hr[0] & 1) === 0 ? 1 : 0
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    state.open++
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 7) {
        const len = buf.readUInt16BE(4)
        if (buf.length < 6 + len) break
        const frame = buf.subarray(0, 6 + len)
        buf = buf.subarray(6 + len)
        if (state.silent) continue // a stopped program: the connection stays open and nothing answers
        state.requests++
        const pdu = frame.subarray(7)
        const addr = pdu.readUInt16BE(1)
        const n = pdu.readUInt16BE(3)
        let res
        if (pdu[0] === 0x10) {
          for (let i = 0; i < n; i++) hr[addr + i] = pdu.readUInt16BE(6 + i * 2)
          scan()
          res = pdu.subarray(0, 5)
        } else if (pdu[0] === 0x04) {
          res = Buffer.alloc(2 + n * 2)
          res[0] = 0x04
          res[1] = n * 2
          for (let i = 0; i < n; i++) res.writeUInt16BE(ir[addr + i], 2 + i * 2)
        } else {
          res = Buffer.from([pdu[0] | 0x80, 0x01])
        }
        const head = Buffer.from(frame.subarray(0, 7))
        head.writeUInt16BE(res.length + 1, 4)
        socket.write(Buffer.concat([head, res]))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      state.open--
    })
  })
  return {
    hr,
    ir,
    state,
    listen: (p) => new Promise((resolve) => server.listen(p, '127.0.0.1', resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * A PLC's OPC UA server: a Main object holding Main.Eye and Main.Run, Booleans, with the scan
 * `Run := NOT Eye` run whenever the simulator writes the eye (unless `force` holds Run on). node-opcua's
 * server, from the desktop shell's own dependencies; unsecured, like the link.
 */
async function uaPlc(port, pkiRoot, { discovery = false } = {}) {
  const desktopRequire = createRequire(join(desktopDir, 'package.json'))
  const { OPCUAServer } = desktopRequire('node-opcua-server')
  const { OPCUACertificateManager } = desktopRequire('node-opcua-certificate-manager')
  const { ApplicationType, MessageSecurityMode, SecurityPolicy } = desktopRequire('node-opcua-client')
  const server = new OPCUAServer({
    port,
    // declared a discovery server, it stands in for the one PLC software may install on port 4840
    ...(discovery ? { serverInfo: { applicationType: ApplicationType.DiscoveryServer, applicationName: { text: 'Local Discovery Server' } } } : {}),
    serverCertificateManager: new OPCUACertificateManager({ rootFolder: pkiRoot }),
    securityPolicies: [SecurityPolicy.None],
    securityModes: [MessageSecurityMode.None],
    allowAnonymous: true,
  })
  await server.initialize()
  const ns = server.engine.addressSpace.getOwnNamespace()
  const main = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'Main' })
  const state = { force: false, eye: false }
  const eye = ns.addVariable({ componentOf: main, browseName: 'Eye', dataType: 'Boolean', value: { dataType: 'Boolean', value: false } })
  const run = ns.addVariable({ componentOf: main, browseName: 'Run', dataType: 'Boolean', value: { dataType: 'Boolean', value: true } })
  const scan = () => run.setValueFromSource({ dataType: 'Boolean', value: state.force || !state.eye })
  eye.on('value_changed', (dv) => {
    state.eye = dv.value.value === true
    scan()
  })
  await server.start()
  return { server, state, scan, sessions: () => server.currentSessionCount }
}

/**
 * A Logix controller over EtherNet/IP: libplctag's own simulator (ab_server, fetched beside the library by
 * scripts/fetch-libplctag.mjs) holding the BOOL tags Eye and Run, and this script as its program: every 20 ms it reads
 * Eye and writes `Run := force OR NOT Eye`, through the desktop shell's own libplctag binding (eipIo.cjs), as a
 * second client of the controller beside the app. `kill` takes the controller away; `restart` brings a fresh one
 * up on the same port (its tags start at zero, as a re-downloaded controller's would). `micro800` makes it a
 * Micro800 instead, reached with no path.
 */
async function logix(port, micro800 = false) {
  const { spawn } = await import('node:child_process')
  const eipIo = require(join(desktopDir, 'eipIo.cjs'))
  const exe = join(desktopDir, 'vendor', 'libplctag', process.platform === 'win32' ? 'ab_server.exe' : 'ab_server')
  const state = { eye: false, force: false }
  let proc = null
  const up = async () => {
    const plc = micro800 ? ['--plc=Micro800'] : ['--plc=ControlLogix', '--path=1,0']
    proc = spawn(exe, [...plc, `--port=${port}`, '--tag=Eye:BOOL[1]', '--tag=Run:BOOL[1]'], { stdio: 'ignore' })
    const until = Date.now() + 5000
    for (;;) {
      const open = await new Promise((resolve) => {
        const s = new Socket()
        s.once('connect', () => (s.destroy(), resolve(true)))
        s.once('error', () => resolve(false))
        s.connect(port, '127.0.0.1')
      })
      if (open) return
      if (Date.now() > until) throw new Error('ab_server did not start')
      await sleep(50)
    }
  }
  await up()
  const link = new eipIo.EipLink()
  const opened = link.open(micro800 ? { gateway: `127.0.0.1:${port}`, path: '', family: 'micro800' } : { gateway: `127.0.0.1:${port}`, path: '1,0' })
  if (opened.error) throw new Error(opened.error)
  let running = true
  let bound = false
  const scan = (async () => {
    while (running) {
      if (!bound) bound = (await link.bind([{ name: 'Eye' }, { name: 'Run' }])).tags?.every((t) => t.status === 'ok') ?? false
      if (bound) {
        const r = await link.exchange([], ['Eye'])
        if (r.reads?.[0]?.status === 'ok') {
          state.eye = r.reads[0].value === true
          await link.exchange([{ name: 'Run', value: state.force || !state.eye }], [])
        } else bound = false
      }
      await sleep(20)
    }
  })()
  return {
    state,
    kill: async () => {
      const gone = new Promise((r) => proc.once('exit', r))
      proc.kill()
      await gone
    },
    restart: up,
    // stop this controller but leave libplctag up, for a second one in the same run
    retire: async () => {
      running = false
      await scan
      link.close()
      proc?.kill()
    },
    close: async () => {
      running = false
      await scan
      link.close()
      eipIo.shutdownEip()
      proc?.kill()
    },
  }
}

/**
 * An S7-1200 over PUT/GET, small enough to read: COTP connect, a 240-byte PDU, and read-var / write-var jobs on its
 * I and Q bytes, written here from the protocol as `servingPlc` is for Modbus (the strict unit-test CPU is
 * src/plc/link/s7FakeCpu.ts; scripts/s7-loop.mjs runs against snap7). Its scan is `Q100.0 := force OR NOT I100.0` on
 * every write; `putGet` false answers every job with 0x8104, as a CPU with PUT/GET off does.
 */
function s7Plc() {
  const mem = { 0x81: new Uint8Array(256), 0x82: new Uint8Array(256) }
  const state = { putGet: true, force: false, eye: false, jobs: 0, open: 0 }
  const sockets = new Set()
  const scan = () => {
    state.eye = (mem[0x81][100] & 1) === 1
    mem[0x82][100] = state.force || !state.eye ? 1 : 0
  }
  const tpkt = (body) => Buffer.concat([Buffer.from([3, 0, (body.length + 4) >> 8, (body.length + 4) & 0xff]), body])
  const ack = (job, params, data, error = 0) =>
    tpkt(Buffer.concat([Buffer.from([2, 0xf0, 0x80, 0x32, 3, 0, 0, job[4], job[5], params.length >> 8, params.length & 0xff, data.length >> 8, data.length & 0xff, error >> 8, error & 0xff]), params, data]))
  const answer = (job) => {
    const pLen = job.readUInt16BE(6)
    const params = job.subarray(10, 10 + pLen)
    const data = job.subarray(10 + pLen)
    const fn = params[0]
    if (fn === 0xf0) return ack(job, Buffer.from([0xf0, 0, 0, 1, 0, 1, 0, 240]), Buffer.alloc(0))
    state.jobs++
    if (!state.putGet) return ack(job, Buffer.from([fn, 0]), Buffer.alloc(0), 0x8104)
    const items = Array.from({ length: params[1] }, (_, i) => {
      const s = params.subarray(2 + i * 12, 14 + i * 12)
      const bits = (s[9] << 16) | (s[10] << 8) | s[11]
      return { unit: s[3], count: s.readUInt16BE(4), area: mem[s[8]], byte: bits >> 3, bit: bits & 7 }
    })
    if (fn === 0x04) {
      const out = []
      items.forEach((it, i) => {
        out.push(0xff, 4, (it.count * 8) >> 8, (it.count * 8) & 0xff, ...it.area.subarray(it.byte, it.byte + it.count))
        if (i < items.length - 1 && it.count % 2) out.push(0)
      })
      return ack(job, Buffer.from([4, items.length]), Buffer.from(out))
    }
    let at = 0
    for (const [i, it] of items.entries()) {
      const n = data[at + 1] === 3 ? 1 : data.readUInt16BE(at + 2) / 8
      const v = data.subarray(at + 4, at + 4 + n)
      if (it.unit === 1) it.area[it.byte] = v[0] & 1 ? it.area[it.byte] | (1 << it.bit) : it.area[it.byte] & ~(1 << it.bit)
      else it.area.set(v, it.byte)
      at += 4 + n + (i < items.length - 1 && n % 2 ? 1 : 0)
    }
    scan()
    return ack(job, Buffer.from([5, items.length]), Buffer.alloc(items.length, 0xff))
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    state.open++
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= buf.readUInt16BE(2)) {
        const frame = buf.subarray(0, buf.readUInt16BE(2))
        buf = buf.subarray(frame.length)
        const cotp = frame.subarray(4)
        if (cotp[1] === 0xe0) socket.write(tpkt(Buffer.from([6, 0xd0, 0, 1, 0, 0, 0])))
        else if (cotp[1] === 0xf0) socket.write(answer(cotp.subarray(3)))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      state.open--
    })
  })
  return {
    state,
    listen: (p) => new Promise((resolve) => server.listen(p, '127.0.0.1', resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/** Load the conveyor scene wired to I/O addresses, through the real Open path (validation included). */
async function loadScene(page, tags = { eye: '%IX100.0', run: '%qx100.0' }) {
  return page.evaluate((tags) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = ['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    const error = window.__oip.loadSceneText(JSON.stringify({
      version: st.getState().scene.version,
      parts: [
        { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0,
          params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: tags.run } },
        { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
        { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: { maxRange: 1.2, tag: tags.eye } },
      ],
      packages: need,
    }))
    st.setState({ selectedIds: [] })
    return error ?? true
  }, tags)
}

const boxX = (page) => page.evaluate(() => window.__oip.controller.livePosition('box')?.[0] ?? null)

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const port = await freePort()
let app
let master
let plc
let ua
let logixPlc
let s7
try {
  // a TcAdsDll that is not there, and adsIo.cjs then looks nowhere else: the ADS phase never reaches a TwinCAT router,
  // whatever this machine has installed
  const env = { ...process.env, DESKTOP_URL: url, OIP_TCADSDLL_PATH: join(profileDir, 'no-such-TcAdsDll.dll') }
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
  expect(loaded === true, `the conveyor scene opens, wired to %IX100.0 and %QX100.0 (${loaded})`)
  const stored = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'belt').params.runTag)
  expect(stored === '%QX100.0', `an address typed in any case is stored in its one spelling (${stored})`)
  // Controller Properties: the organizer's Controller node, double-clicked
  const openProps = async () => {
    await showPlcEditor(page)
    await page.locator('[data-testid="org-controller"]').dblclick()
    await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 20000 })
  }
  await openProps()
  const section = page.locator('[data-testid="external-plc"]')
  await section.waitFor({ timeout: 20000 })
  expect((await page.locator('[data-testid="controller-desktop-only"]').count()) === 0, 'the desktop app offers the external PLC')
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, port: p, network: false }), port)
  const points = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/%QX100\.0\s+coil 800/.test(points) && /%IX100\.0\s+discrete input 800/.test(points), `Controller Properties lists what Play will serve (${points.replace(/\s+/g, ' ')})`)
  expect(await page.locator('[data-testid="external-plc-enabled"]').isChecked(), 'the section shows the link switched on')
  // the link's state beside Play and Stop, drawn only while Play hands the scene to a PLC
  const link = page.locator('[data-testid="plc-link-status"]')
  expect((await link.count()) === 1, 'the toolbar shows the external PLC link beside Play')
  const before = (await link.getAttribute('title')) ?? ''
  expect(/the program here is not run while the PLC is/.test(before), `and says the program here will not run (${before})`)

  console.log('--- Play ---')
  await page.evaluate(() => window.__oip.controller.setTimeScale(2))
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'listening', null, { timeout: 15000, polling: 100 })
  expect((await page.evaluate(() => window.__oip.store.getState().timeScale)) === 1, 'Play with an external PLC runs at 1x, whatever speed was chosen')
  await page.evaluate(() => window.__oip.controller.setTimeScale(2))
  expect((await page.evaluate(() => window.__oip.store.getState().timeScale)) === 2, 'a speed can still be chosen while the PLC is connected')
  const speed = page.locator('[data-testid="sim-speed"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="sim-speed"]')?.classList.contains('plc-clock'), null, { timeout: 5000, polling: 100 })
  expect(/runs in real time/.test((await speed.getAttribute('title')) ?? ''), 'and the speed button warns that the PLC keeps real time')
  // the box checks below time the PLC's stop against the sim, so they run at 1x
  await page.evaluate(() => window.__oip.controller.setTimeScale(1))
  const note = await page.evaluate(() => window.__oip.controller.programStatus.warnings.join(' '))
  expect(/external PLC runs this project/.test(note), `the PLC panel says the program here is not attached (${note})`)

  master = await Master.connect(port)
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.masters.length === 1, null, { timeout: 5000, polling: 100 })
  const statusText = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Serving on 127\.0\.0\.1:\d+: 1 connected/.test(statusText), `Controller Properties reports the PLC connecting (${statusText})`)

  // The PLC's scan: Run := NOT Eye, every 20 ms of wall-clock time. The start position is the first frame's,
  // which headless can take a moment to post
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const x0 = await boxX(page)
  let eyeSeenAt = null
  let stoppedAt = null
  const t0 = Date.now()
  let polls = 0
  while (Date.now() - t0 < 20000) {
    const eye = await master.readInput(DI)
    await master.writeCoil(COIL, !eye)
    polls++
    if (eye && eyeSeenAt === null) eyeSeenAt = Date.now()
    if (eyeSeenAt !== null && Date.now() - eyeSeenAt > 1500) {
      stoppedAt = await boxX(page)
      break
    }
    await sleep(20)
  }
  expect(eyeSeenAt !== null, `the PLC saw the box reach the eye (after ${eyeSeenAt === null ? '-' : ((eyeSeenAt - t0) / 1000).toFixed(1)} s, ${polls} polls)`)
  expect(typeof x0 === 'number' && typeof stoppedAt === 'number' && stoppedAt > x0 + 1, `the PLC's coil ran the belt (box ${x0?.toFixed?.(2)} -> ${stoppedAt?.toFixed?.(2)} m)`)
  // the eye is 3 m along; the box stops with its front at the beam, its centre ~0.2 m short (2.83 in-process)
  expect(typeof stoppedAt === 'number' && Math.abs(stoppedAt - 2.83) < 0.3, `and its coil stopped the box at the eye (x = ${stoppedAt?.toFixed?.(3)} m)`)
  for (let i = 0; i < 10; i++) {
    await master.writeCoil(COIL, !(await master.readInput(DI)))
    await sleep(50)
  }
  const later = await boxX(page)
  expect(typeof later === 'number' && Math.abs(later - stoppedAt) < 0.01, `the box stays stopped while the PLC holds the coil off (moved ${((later - stoppedAt) * 1000).toFixed(1)} mm)`)
  const requests = await page.evaluate(() => window.__oip.controller.externalPlcStatus.requests)
  expect(/FC2 x\d+, FC5 x\d+/.test(requests), `the link counted the PLC's requests (${requests})`)

  // Watch with an external PLC (WatchPanel.tsx, controller/plcLinks.ts plcImage): the link's values are watched like a
  // program's. The box sits at the eye, so the eye reads TRUE and the PLC holds the belt's coil FALSE.
  const image = await page.evaluate(() => window.__oip.controller.plcWatch)
  expect(image?.['%IX100.0'] === true && image?.['%QX100.0'] === false, `the watched values include what the link carries (${JSON.stringify(image)})`)
  // (Controller Properties stays open over the docks for the checks after these, so the buttons are clicked in the page)
  const press = (sel) => page.evaluate((q) => document.querySelector(q)?.click(), sel)
  await page.evaluate(() => window.__oip.store.revealPanel('watch'))
  await page.waitForSelector('[data-testid="plc-watch"]', { timeout: 5000 })
  await press('[data-testid="plc-watch-clear"]')
  await page.waitForSelector('[data-testid="plc-watch-add-wired"]', { timeout: 5000 })
  await press('[data-testid="plc-watch-add-wired"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="plc-watch-row"]').length >= 2, null, { timeout: 5000 }).catch(() => {})
  const watched = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="plc-watch-row"]')].map((r) => ({
      name: r.getAttribute('data-name'),
      value: r.querySelector('[data-testid="plc-watch-value"]')?.textContent?.trim(),
      type: r.querySelector('[data-testid="plc-watch-type"]')?.textContent?.trim(),
      writable: r.querySelector('[data-testid="plc-watch-write"]') !== null,
    })),
  )
  const eyeRow = watched.find((w) => w.name === '%IX100.0')
  const beltRow = watched.find((w) => w.name === '%QX100.0')
  expect(eyeRow?.value === 'TRUE' && beltRow?.value === 'FALSE', `Add all wired tags lists the PLC's tags with live values (${JSON.stringify(watched)})`)
  expect(eyeRow?.type === 'BOOL' && beltRow?.type === 'BOOL', 'with the type the part declares')
  expect(!eyeRow?.writable && !beltRow?.writable && (await page.locator('[data-testid="plc-watch-force"]').count()) === 0, 'and read only: a real PLC is not written from the Watch panel')
  // Show on displays: saved in the project, listed live beside the scene in Present
  // a Watch row's right-click Show on displays: Watch is the reader's own list, the display the project's
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="plc-watch-row"][data-name="%IX100.0"]')
    const box = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 5 }))
  })
  await page.waitForSelector('[data-testid="plc-watch-display"]', { timeout: 5000 })
  await press('[data-testid="plc-watch-display"]')
  expect(JSON.stringify(await page.evaluate(() => window.__oip.store.getState().scene.display)) === '["%IX100.0"]', 'Show on displays puts the value in the project')
  await page.evaluate(() => window.__oip.store.setState({ presenting: true }))
  await page.waitForSelector('[data-testid="present-value"]', { timeout: 5000 }).catch(() => {})
  const shown = await page.locator('[data-testid="present-value"]').allInnerTexts()
  expect(shown.length === 1 && /%IX100\.0\s*BOOL\s+TRUE/.test(shown[0] ?? ''), `Present lists it beside the scene, live, with its type (${JSON.stringify(shown)})`)
  // the window's caption buttons stay over Present's top edge, so the list starts below their strip
  const clear = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;height:env(titlebar-area-height, 0px)'
    document.body.append(probe)
    const strip = probe.getBoundingClientRect().height
    probe.remove()
    return { strip, top: document.querySelector('[data-testid="present-values"]').getBoundingClientRect().top }
  })
  expect(clear.strip > 0 && clear.top >= clear.strip, `the list clears the window's caption buttons (${JSON.stringify(clear)})`)
  await page.evaluate(() => window.__oip.store.setState({ presenting: false }))
  // the PLC panel back in front of Watch, where the checks below find its organizer
  await page.evaluate(() => window.__oip.store.revealPanel('st'))

  // The PLC goes away. Its last coil value said run, and the image still holds it: without a watchdog the
  // belt runs forever on a value nobody is driving any more. The connection stays open here -
  // this is the ordinary case, a PLC whose program was stopped, which no disconnect event announces.
  console.log('--- the PLC stops polling ---')
  const runningFrom = await boxX(page)
  const pollUntil = Date.now() + 1500
  while (Date.now() < pollUntil) {
    await master.readInput(DI)
    await master.writeCoil(COIL, true) // run, whatever the eye says: we are the PLC
    await sleep(20)
  }
  const movedAgain = await boxX(page)
  expect(movedAgain > runningFrom + 0.1, `the PLC can still drive the belt (${runningFrom.toFixed(2)} -> ${movedAgain.toFixed(2)} m)`)

  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 5000, polling: 100 })
  const wentQuiet = await boxX(page)
  await sleep(1500) // the watchdog's second, plus the coast
  const settled = await boxX(page)
  await sleep(1000)
  const atRest = await boxX(page)
  expect(Math.abs(atRest - settled) < 0.005, `the belt stopped when the polls did (moved ${((atRest - settled) * 1000).toFixed(1)} mm in the last second)`)
  expect(atRest - wentQuiet < 0.5, `and it stopped promptly, not at the end of the belt (coasted ${((atRest - wentQuiet) * 1000).toFixed(0)} mm)`)
  const staleText = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/outputs are held off/.test(staleText), `Controller Properties says why the line stopped (${staleText})`)

  // and it hands control back the moment the PLC speaks again
  await master.writeCoil(COIL, true)
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === false, null, { timeout: 5000, polling: 100 })
  await sleep(500)
  expect((await boxX(page)) > atRest + 0.05, 'and the belt runs again once the PLC polls')
  await master.writeCoil(COIL, false)
  await sleep(500)

  console.log('--- Stop ---')
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  const closed = await new Promise((resolve) => {
    master.socket.once('close', () => resolve(true))
    setTimeout(() => resolve(master.socket.destroyed), 3000)
  })
  expect(closed, 'Stop drops the PLC connection')
  const refused = await Master.connect(port).then(
    (m) => {
      m.close()
      return false
    },
    () => true,
  )
  expect(refused, 'and closes the port')

  // The other way round: a PLC that serves its process image (a Modbus server device), which the
  // simulator connects to and polls. Same scene, same addresses: Controller Properties says the device's registers start
  // at %IW50 / %QW50, so %IX100.0 is holding register 0 bit 0 and %QX100.0 input register 0 bit 0.
  console.log('--- the simulator polls a PLC that serves ---')
  plc = servingPlc()
  const plcPort = await freePort()
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, mode: 'poll', plcHost: '127.0.0.1', plcPort: p, inputBase: 50, outputBase: 50 }), plcPort)
  const clientPoints = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/%IX100\.0\s+holding register 0 bit 0/.test(clientPoints) && /%QX100\.0\s+input register 0 bit 0/.test(clientPoints), `Controller Properties lists where each point sits in the PLC's registers (${clientPoints.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-input-base"]').inputValue()) === '50', 'and shows where the device sits in the image')

  // Play before the PLC is up, which is the ordinary order: the link waits and says so
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => /nothing is listening/.test(window.__oip.controller.externalPlcStatus.error ?? ''), null, { timeout: 15000, polling: 100 })
  const waiting = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Waiting for the PLC at 127\.0\.0\.1:\d+: nothing is listening/.test(waiting), `with no PLC up yet, Controller Properties says what it is waiting for (${waiting})`)
  await plc.listen(plcPort)
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 10000, polling: 100 })
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const cx0 = await boxX(page)
  const cStart = Date.now()
  let cEye = null
  while (Date.now() - cStart < 20000) {
    if (cEye === null && (plc.hr[0] & 1) === 1) cEye = Date.now()
    if (cEye !== null && Date.now() - cEye > 1500) break
    await sleep(50)
  }
  const cStopped = await boxX(page)
  expect(cEye !== null, `the PLC read the eye from its holding register (after ${cEye === null ? '-' : ((cEye - cStart) / 1000).toFixed(1)} s, ${plc.state.requests} requests)`)
  expect(typeof cx0 === 'number' && cStopped > cx0 + 1, `its input register ran the belt (box ${cx0?.toFixed?.(2)} -> ${cStopped?.toFixed?.(2)} m)`)
  expect(Math.abs(cStopped - 2.83) < 0.3, `and stopped the box at the eye (x = ${cStopped?.toFixed?.(3)} m)`)
  const polling = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Polling the PLC at 127\.0\.0\.1:\d+, FC4 x\d+, FC16 x\d+/.test(polling), `Controller Properties reports the polling (${polling})`)

  // the PLC's program stops with the connection open: its outputs must not keep the belt running
  plc.state.force = true
  await sleep(1200)
  const cRunning = await boxX(page)
  expect(cRunning > cStopped + 0.1, `the PLC can drive the belt past the eye (${cStopped.toFixed(2)} -> ${cRunning.toFixed(2)} m)`)
  plc.state.silent = true
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 5000, polling: 100 })
  const cQuiet = await boxX(page)
  await sleep(1500)
  const cSettled = await boxX(page)
  await sleep(1000)
  const cRest = await boxX(page)
  expect(Math.abs(cRest - cSettled) < 0.005 && cRest - cQuiet < 0.5, `the belt stopped when the PLC stopped answering (coasted ${((cRest - cQuiet) * 1000).toFixed(0)} mm)`)
  const cStale = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/stopped answering.*outputs are held off/.test(cStale), `Controller Properties says why (${cStale})`)
  plc.state.silent = false
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === false, null, { timeout: 5000, polling: 100 })
  await sleep(500)
  expect((await boxX(page)) > cRest + 0.05, 'and the belt runs again once the PLC answers')
  plc.state.force = false

  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  const deadline = Date.now() + 3000
  while (plc.state.open > 0 && Date.now() < deadline) await sleep(50)
  expect(plc.state.open === 0, 'Stop closes the connection to the PLC')

  // OPC UA: the same belt and eye, wired by the PLC's names rather than addresses. The eye's tag is the bare
  // `Eye` and the belt's `Main.Run`; the link finds both on the server by the end of their browse paths.
  console.log('--- OPC UA: the PLC\'s tags by name ---')
  const uaPort = await freePort()
  const uaPki = join(profileDir, 'ua-server-pki')
  ua = await uaPlc(uaPort, uaPki)
  const named = await loadScene(page, { eye: 'Eye', run: 'Main.Run' })
  expect(named === true, `the scene opens wired by name (${named})`)
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, mode: 'opcua', opcUaEndpoint: `opc.tcp://127.0.0.1:${p}` }), uaPort)
  const uaPlanned = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/Eye\s+written to the PLC/.test(uaPlanned) && /Main\.Run\s+read from the PLC/.test(uaPlanned), `before Play Controller Properties lists each tag and which way it goes (${uaPlanned.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-opcua-unsecured"]').count()) === 1, 'and says the connection is unsecured')
  // no address assignment, which names do not need: the Controller still lists the command, greyed out with the reason
  // (the scene's program is empty here, so there is no Main row: the node's own menu carries the I/O commands)
  await page.locator('[data-testid="controller-props-close"]').click()
  await page.locator('[data-testid="org-controller"]').click({ button: 'right' })
  const assignItem = page.locator('[data-testid="org-assign-io"]')
  expect(await assignItem.isDisabled(), 'and offers no address assignment, which names do not need')
  expect(/nothing is given an address/.test((await assignItem.getAttribute('title')) ?? ''), 'and says why')
  await page.keyboard.press('Escape')
  await openProps()

  // pointed at a discovery server - what holds 4840 on a machine with a vendor's OPC UA install - Controller Properties says
  // so and where to look, instead of listing every tag as missing
  const ldsPort = await freePort()
  const lds = await uaPlc(ldsPort, join(profileDir, 'ua-lds-pki'), { discovery: true })
  try {
    await page.evaluate((p) => window.__oip.store.setExternalPlc({ opcUaEndpoint: `opc.tcp://127.0.0.1:${p}` }), ldsPort)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'failed', null, { timeout: 20000, polling: 100 })
    const said = await page.locator('[data-testid="external-plc-status"]').innerText()
    expect(/^Could not connect: opc\.tcp:\/\/127\.0\.0\.1:\d+ is an OPC UA discovery server, not a PLC: .*Server field\.$/.test(said), `a discovery server is named as one (${said})`)
    expect((await page.locator('[data-testid="external-plc-problem"]').count()) === 0, 'and no tag is reported missing')
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  } finally {
    await lds.server.shutdown(0)
  }
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ opcUaEndpoint: `opc.tcp://127.0.0.1:${p}` }), uaPort)

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 20000, polling: 100 })
  const uaBound = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/Eye\s+Main\.Eye\s+Boolean/.test(uaBound) && /Main\.Run\s+Main\.Run\s+Boolean/.test(uaBound), `on Play each tag is found on the server (${uaBound.replace(/\s+/g, ' ')})`)
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const ux0 = await boxX(page)
  const uStart = Date.now()
  let uEye = null
  while (Date.now() - uStart < 20000) {
    if (uEye === null && ua.state.eye) uEye = Date.now()
    if (uEye !== null && Date.now() - uEye > 1500) break
    await sleep(50)
  }
  const uStopped = await boxX(page)
  expect(uEye !== null, `the PLC saw the eye through its OPC UA node (after ${uEye === null ? '-' : ((uEye - uStart) / 1000).toFixed(1)} s)`)
  expect(typeof ux0 === 'number' && uStopped > ux0 + 1 && Math.abs(uStopped - 2.83) < 0.3, `its Run node ran the belt and stopped the box at the eye (${ux0?.toFixed?.(2)} -> ${uStopped?.toFixed?.(3)} m)`)
  const uaStatus = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Reading and writing the PLC's tags at opc\.tcp:\/\/127\.0\.0\.1:\d+, \d+ read\/write cycles/.test(uaStatus), `the dock reports the link (${uaStatus})`)

  // the PLC goes away mid-run, with its Run on: the belt must stop, and come back with the PLC
  ua.state.force = true
  ua.scan()
  await sleep(1200)
  const uRunning = await boxX(page)
  expect(uRunning > uStopped + 0.1, `the PLC can drive the belt past the eye (${uStopped.toFixed(2)} -> ${uRunning.toFixed(2)} m)`)
  await ua.server.shutdown(0)
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 5000, polling: 100 })
  const uQuiet = await boxX(page)
  await sleep(1500)
  const uRest = await boxX(page)
  expect(uRest - uQuiet < 0.5, `the belt stopped when the PLC went away (coasted ${((uRest - uQuiet) * 1000).toFixed(0)} mm)`)
  const uaGone = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/The PLC at opc\.tcp:\/\/.* closed the connection: its outputs are held off/.test(uaGone), `Controller Properties says why (${uaGone})`)
  ua = await uaPlc(uaPort, uaPki)
  ua.state.force = true
  ua.scan()
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling' && !window.__oip.controller.externalPlcStatus.stale, null, { timeout: 10000, polling: 100 })
  await sleep(800)
  expect((await boxX(page)) > uRest + 0.05, 'and the belt runs again once the PLC is back, its tags found anew')

  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  const sessionsUntil = Date.now() + 5000
  while (ua.sessions() > 0 && Date.now() < sessionsUntil) await sleep(100)
  expect(ua.sessions() === 0, 'Stop ends the OPC UA session')

  // Browse from: the browse starts where the field says, through the preload and the shell. A start point the server
  // does not hold is said; one it holds binds the tags under their whole paths, matched ignoring case; a field that is
  // not a path or a NodeId snaps back
  const browseFrom = page.locator('[data-testid="external-plc-opcua-browse-from"]')
  const setBrowseFrom = async (text) => {
    await browseFrom.fill(text)
    await browseFrom.press('Enter')
  }
  await setBrowseFrom('Nope')
  expect(JSON.stringify(await page.evaluate(() => window.__oip.store.getState().externalPlc.opcUaBrowseFrom)) === '["Nope"]', 'Browse from saves a start point')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => /the PLC has no Nope to browse from/.test(window.__oip.controller.externalPlcStatus.error ?? ''), null, { timeout: 20000, polling: 100 })
  const noStart = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/the PLC has no Nope to browse from/.test(noStart), `a start point the server does not hold is said (${noStart})`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  await setBrowseFrom('main')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 20000, polling: 100 })
  const fromMain = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/Eye\s+Main\.Eye\s+Boolean/.test(fromMain) && /Main\.Run\s+Main\.Run\s+Boolean/.test(fromMain), `browsing from main finds the tags under their whole paths (${fromMain.replace(/\s+/g, ' ')})`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  await setBrowseFrom('Main..Eye')
  expect((await browseFrom.inputValue()) === 'main', `a field that is not a path snaps back (${await browseFrom.inputValue()})`)
  await setBrowseFrom('')
  expect(JSON.stringify(await page.evaluate(() => window.__oip.store.getState().externalPlc.opcUaBrowseFrom)) === '[]', 'and an empty field browses Objects again')

  // EtherNet/IP: the same belt and eye on a Logix controller, by its tag names, through libplctag in the shell. The
  // controller is libplctag's own simulator (ab_server) holding Eye and Run, and this script runs its scan.
  console.log('--- EtherNet/IP: a Logix controller\'s tags by name ---')
  const eipPort = await freePort()
  logixPlc = await logix(eipPort)
  const eipNamed = await loadScene(page, { eye: 'Eye', run: 'Run' })
  expect(eipNamed === true, `the scene opens wired by the controller's tag names (${eipNamed})`)
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, mode: 'eip', eipGateway: `127.0.0.1:${p}`, eipPath: '1,0' }), eipPort)
  const eipPlanned = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/Eye\s+written to the PLC\s+BOOL/.test(eipPlanned) && /Run\s+read from the PLC\s+BOOL/.test(eipPlanned), `before Play Controller Properties lists each tag and which way it goes (${eipPlanned.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-eip-names"]').count()) === 1, 'and says the tags are the controller\'s own names')
  const eipBefore = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/^Press Play to connect to the controller at 127\.0\.0\.1:\d+ \(path 1,0\) over EtherNet\/IP/.test(eipBefore), `and what Play will do (${eipBefore})`)

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 20000, polling: 100 })
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const ex0 = await boxX(page)
  const eStart = Date.now()
  let eEye = null
  while (Date.now() - eStart < 20000) {
    if (eEye === null && logixPlc.state.eye) eEye = Date.now()
    if (eEye !== null && Date.now() - eEye > 1500) break
    await sleep(50)
  }
  const eStopped = await boxX(page)
  expect(eEye !== null, `the controller saw the eye through its tag (after ${eEye === null ? '-' : ((eEye - eStart) / 1000).toFixed(1)} s)`)
  expect(typeof ex0 === 'number' && eStopped > ex0 + 1 && Math.abs(eStopped - 2.83) < 0.3, `its Run tag ran the belt and stopped the box at the eye (${ex0?.toFixed?.(2)} -> ${eStopped?.toFixed?.(3)} m)`)
  const eipStatus = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Reading and writing the PLC's tags at 127\.0\.0\.1:\d+ \(path 1,0\), \d+ read\/write cycles/.test(eipStatus), `the dock reports the link (${eipStatus})`)
  const eipBound = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/Eye\s+written to the PLC\s+BOOL/.test(eipBound) && /Run\s+read from the PLC\s+BOOL/.test(eipBound), `on Play each tag carries the controller's type (${eipBound.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-problem"]').count()) === 0, 'and no tag is reported missing')

  // the controller goes away mid-run, with its Run on: the belt must stop, and come back with the controller
  logixPlc.state.force = true
  await sleep(1200)
  const eRunning = await boxX(page)
  expect(eRunning > eStopped + 0.1, `the controller can drive the belt past the eye (${eStopped.toFixed(2)} -> ${eRunning.toFixed(2)} m)`)
  await logixPlc.kill()
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 5000, polling: 100 })
  const eQuiet = await boxX(page)
  await sleep(1500)
  const eRest = await boxX(page)
  expect(eRest - eQuiet < 0.5, `the belt stopped when the controller went away (coasted ${((eRest - eQuiet) * 1000).toFixed(0)} mm)`)
  const eipGone = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/The PLC at 127\.0\.0\.1:\d+ \(path 1,0\) stopped answering.*: its outputs are held off/.test(eipGone), `Controller Properties says why (${eipGone})`)
  await logixPlc.restart()
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling' && !window.__oip.controller.externalPlcStatus.stale, null, { timeout: 15000, polling: 100 })
  await sleep(800)
  expect((await boxX(page)) > eRest + 0.05, 'and the belt runs again once the controller is back, its tags asked for anew')

  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  await logixPlc.retire()

  // The same link to a Micro800: the family is the only setting that changes, and the path kept from the Logix
  // setup is neither shown nor sent (ab_server's Micro800 answers nothing to a request routed through one)
  console.log("--- EtherNet/IP: a Micro800's tags by name ---")
  const m800Port = await freePort()
  logixPlc = await logix(m800Port, true)
  const m800Named = await loadScene(page, { eye: 'Eye', run: 'Run' })
  expect(m800Named === true, `the scene opens wired by the Micro800's variable names (${m800Named})`)
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, mode: 'eip', eipGateway: `127.0.0.1:${p}`, eipPath: '1,0', eipFamily: 'micro800' }), m800Port)
  expect((await page.locator('[data-testid="external-plc-eip-family"]').inputValue()) === 'micro800', 'Controller Properties shows the family')
  expect((await page.locator('[data-testid="external-plc-eip-path"]').count()) === 0, 'and no path field for a Micro800')
  const m800Before = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/^Press Play to connect to the controller at 127\.0\.0\.1:\d+ \(Micro800\) over EtherNet\/IP/.test(m800Before), `and what Play will do (${m800Before})`)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 20000, polling: 100 })
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const mx0 = await boxX(page)
  const mStart = Date.now()
  let mEye = null
  while (Date.now() - mStart < 20000) {
    if (mEye === null && logixPlc.state.eye) mEye = Date.now()
    if (mEye !== null && Date.now() - mEye > 1500) break
    await sleep(50)
  }
  const mStopped = await boxX(page)
  expect(mEye !== null, 'the Micro800 saw the eye through its variable')
  expect(typeof mx0 === 'number' && mStopped > mx0 + 1 && Math.abs(mStopped - 2.83) < 0.3, `its Run variable ran the belt and stopped the box at the eye (${mx0?.toFixed?.(2)} -> ${mStopped?.toFixed?.(3)} m)`)
  expect((await page.locator('[data-testid="external-plc-problem"]').count()) === 0, 'and no variable is reported missing')
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })

  // S7 PUT/GET: the address scene again, on an S7-1200's I and Q bytes. %IX100.0 is I100.0 and %QX100.0 is Q100.0,
  // with no table. The session and its protocol are a lazy chunk, so this also loads it in the real app.
  console.log('--- S7 PUT/GET: an S7-1200\'s memory ---')
  const s7Port = await freePort()
  s7 = s7Plc()
  s7.state.putGet = false // a new CPU's default
  await s7.listen(s7Port)
  const s7Scene = await loadScene(page)
  expect(s7Scene === true, `the scene opens wired to addresses again (${s7Scene})`)
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ enabled: true, mode: 's7', s7Host: '127.0.0.1', s7Port: p, s7Rack: 0, s7Slot: 1 }), s7Port)
  const s7Planned = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/%IX100\.0\s+I100\.0\s+written to the PLC/.test(s7Planned) && /%QX100\.0\s+Q100\.0\s+read from the PLC/.test(s7Planned), `before Play Controller Properties lists each address in S7's spelling (${s7Planned.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-s7-putget"]').count()) === 1, 'and says the CPU must allow PUT/GET')
  expect((await page.locator('[data-testid="external-plc-s7-slot"]').inputValue()) === '1', 'and shows the rack and slot')

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => /PUT\/GET is off/.test(window.__oip.controller.externalPlcStatus.error ?? ''), null, { timeout: 20000, polling: 100 })
  const refusedText = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/0x8104.*PUT\/GET is off.*Permit access with PUT\/GET/.test(refusedText), `with PUT/GET off Controller Properties says where to allow it (${refusedText})`)
  const jobsWhileOff = s7.state.jobs
  await sleep(1000)
  expect(s7.state.jobs - jobsWhileOff <= 3, `and asks about once a second, not every cycle (${s7.state.jobs - jobsWhileOff} refused jobs in 1 s)`)
  s7.state.putGet = true // ticked, and downloaded
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.error === null && window.__oip.controller.externalPlcStatus.state === 'polling', null, { timeout: 5000, polling: 100 })
  await page.waitForFunction(() => window.__oip.controller.livePosition('box') != null, null, { timeout: 15000, polling: 100 })
  const sx0 = await boxX(page)
  const sStart = Date.now()
  let sEye = null
  while (Date.now() - sStart < 20000) {
    if (sEye === null && s7.state.eye) sEye = Date.now()
    if (sEye !== null && Date.now() - sEye > 1500) break
    await sleep(50)
  }
  const sStopped = await boxX(page)
  expect(sEye !== null, `the CPU read the eye at I100.0 (after ${sEye === null ? '-' : ((sEye - sStart) / 1000).toFixed(1)} s)`)
  expect(typeof sx0 === 'number' && sStopped > sx0 + 1 && Math.abs(sStopped - 2.83) < 0.3, `its Q100.0 ran the belt and stopped the box at the eye (${sx0?.toFixed?.(2)} -> ${sStopped?.toFixed?.(3)} m)`)
  const s7Status = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/Reading and writing the CPU's memory at 127\.0\.0\.1:\d+ \(rack 0, slot 1\), \d+ read and \d+ write jobs/.test(s7Status), `the dock reports the link (${s7Status})`)

  // the CPU goes away mid-run, with its Q on: the belt must stop, and come back with the CPU
  s7.state.force = true
  await sleep(1200)
  const sRunning = await boxX(page)
  expect(sRunning > sStopped + 0.1, `the CPU can drive the belt past the eye (${sStopped.toFixed(2)} -> ${sRunning.toFixed(2)} m)`)
  await s7.close()
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 5000, polling: 100 })
  const sQuiet = await boxX(page)
  await sleep(1500)
  const sRest = await boxX(page)
  expect(sRest - sQuiet < 0.5, `the belt stopped when the CPU went away (coasted ${((sRest - sQuiet) * 1000).toFixed(0)} mm)`)
  s7 = s7Plc()
  s7.state.force = true
  await s7.listen(s7Port)
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'polling' && !window.__oip.controller.externalPlcStatus.stale, null, { timeout: 10000, polling: 100 })
  await sleep(800)
  expect((await boxX(page)) > sRest + 0.05, 'and the belt runs again once the CPU is back, the connection set up anew')

  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  const s7Deadline = Date.now() + 3000
  while (s7.state.open > 0 && Date.now() < s7Deadline) await sleep(50)
  expect(s7.state.open === 0, 'Stop closes the connection to the CPU')

  // ADS: the address-free scene again, wired by symbol names, through the shell's ADS channel (adsIo.cjs). The shell
  // was launched with OIP_TCADSDLL_PATH naming a file that is not there, so nothing here loads a TcAdsDll or reaches a
  // router: this pins only the app's own side - the dock, the lazy session, the IPC into adsIo.cjs, its argument
  // checks, and its missing-DLL answer reaching the dock as a failure that is not retried.
  console.log('--- ADS: symbols by name, the app\'s side ---')
  const adsChecks = await page.evaluate(async () => {
    const badNetId = await window.oipAds.open({ netId: '1.2.3', port: 851 })
    const badPort = await window.oipAds.open({ netId: '', port: 0 })
    await window.oipAds.close()
    return { badNetId: badNetId.error ?? '', badPort: badPort.error ?? '' }
  })
  expect(/1\.2\.3 is not an AMS Net ID/.test(adsChecks.badNetId), `the shell refuses a malformed AMS Net ID before loading anything (${adsChecks.badNetId})`)
  expect(/0 is not an AMS port/.test(adsChecks.badPort), `and an AMS port out of range (${adsChecks.badPort})`)
  const adsScene = await loadScene(page, { eye: 'MAIN.Eye', run: 'MAIN.Run' })
  expect(adsScene === true, `the scene opens wired by symbol names (${adsScene})`)
  await page.evaluate(() => window.__oip.store.setExternalPlc({ enabled: true, mode: 'ads', adsNetId: '', adsPort: 851 }))
  const adsPlanned = await page.locator('[data-testid="external-plc-points"]').innerText()
  expect(/MAIN\.Eye\s+written to the PLC\s+BOOL/.test(adsPlanned) && /MAIN\.Run\s+read from the PLC\s+BOOL/.test(adsPlanned), `before Play Controller Properties lists each symbol and which way it goes (${adsPlanned.replace(/\s+/g, ' ')})`)
  expect((await page.locator('[data-testid="external-plc-ads-router"]').count()) === 1, "and says it goes through this PC's TwinCAT router")
  const adsBefore = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/^Press Play to connect to this PC's TwinCAT runtime, AMS port 851 over ADS/.test(adsBefore), `and what Play will do (${adsBefore})`)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'failed', null, { timeout: 20000, polling: 100 })
  const adsMissing = process.platform === 'win32' ? /OIP_TCADSDLL_PATH names a file that is not there/ : /runs on Windows/
  const adsError = await page.evaluate(() => window.__oip.controller.externalPlcStatus.error ?? '')
  expect(adsMissing.test(adsError), `Play loads the session, and adsIo.cjs's own missing-DLL answer comes back through the IPC (${adsError})`)
  const adsFailed = await page.locator('[data-testid="external-plc-status"]').innerText()
  expect(/^Could not connect: /.test(adsFailed) && adsMissing.test(adsFailed), `and reaches the dock (${adsFailed})`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 5000, polling: 100 })
  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  master?.close()
  await plc?.close()
  await ua?.server.shutdown(0).catch(() => {})
  await logixPlc?.close()
  await s7?.close()
  await app?.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
}

// A browser tab has no socket to offer, and Controller Properties says so rather than showing a dead switch
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
    expect(/needs the desktop app/.test(text), `the browser explains why there is no switch (${text})`)
    expect((await page.locator('[data-testid="external-plc-enabled"]').isDisabled()), 'and its switch is off')
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
console.log('\nall external-plc-electron checks passed')
