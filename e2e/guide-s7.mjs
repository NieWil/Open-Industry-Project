// Follows the published S7 guide, guides/s7/index.html (/guides/s7/), step by step, in the real desktop shell,
// against a stand-in S7-1200 on a real TCP socket.
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the
// rule): the addresses are the page's wiring table, the CPU's program is the page's tag table and its one SCL line,
// and each label, default and status line the page quotes is looked up on the page first.
//
//   step 2  the parts' Comms fields set through the Inspector, to the page's addresses
//   step 4  PLC Controllers... from the palette; "S7 PUT/GET"; the CPU, port, rack and slot defaults; the PUT/GET reminder;
//           the two points it lists; the consent prompt's wording, read from the shell's source
//   step 5  Play with nothing listening waits and says so; a wrong slot is refused with the page's advice; PUT/GET off
//           names the checkbox and holds the belt; ticking it (the stand-in allowing PUT/GET) mid-run lets the belt
//           start without pressing Play again, and the CPU stops the box at the eye; the bits beside I100.0 survive
//   step 6  the eye moved to the page's data block address and the program to the block: left optimized (TIA Portal's
//           default) the page's message names it and the belt never starts; unoptimized, the box stops at the eye
//
// What it does not do: drive TIA Portal or a real CPU. The CPU is src/plc/link/s7FakeCpu.ts, the unit tests' strict stand-in
// (rack and slot checked at the COTP connect, the PDU limit, bit writes, PUT/GET off refused with 0x8104), served
// over TCP here, with the page's program transcribed onto its memory. So what the page says the CPU needs, and that a real
// CPU answers PUT/GET off with 0x8104 and a wrong slot at the connect, are as believed as src/plc/DEVICE-IO.md says
// ("By address: S7 PUT/GET"); `npm run s7-loop` is the independent byte-level proof (snap7). The stand-in listens on
// a free port, not 102, which a Siemens service may hold: the run types that port where the page says 102, and the
// CPU's address where the page says the CPU's.
//
// Usage:
//   node e2e/guide-s7.mjs                    follow the guide; exit 0 = it works as written
//   node e2e/guide-s7.mjs --shots <dir>      also save a screenshot per step
//   node e2e/guide-s7.mjs --images           also retake the page's pictures (guides/s7/img/, see guidePictures)
//
// Needs no PLC software. Opens a desktop-shell window for the run.
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window, setInterval, clearInterval */

import { readFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { createServer as createVite } from 'vite'
import { boxX, commsGroup, guidePictures, guideTest, LINE_CAMERA, labelled, launchShell, loadParts, openExternalPlc, ROOT, settledX, shot as shotTo, sleep, DESKTOP_DIR, squash, waitForReset, wire as wireRow } from './_guide.mjs'

const argv = process.argv.slice(2)
const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
const shot = (page, name) => shotTo(page, shotsDir, name)

// ---- the page ----

const { html, expect, says, programs, wiring, failures } = guideTest('s7')
const pics = guidePictures('s7', { html, expect })
/** step 3b's program, and step 6's: the same line over the data block */
const [program, dbProgram] = programs
/** step 2's rows (the CPU's own addresses), and step 6's (a data block, in the S7 data-block spelling) */
const ioRows = wiring.filter((w) => w.address.startsWith('%'))
const dbRows = wiring.filter((w) => !w.address.startsWith('%'))
/** step 6's DB1.DBX0.0, as the stand-in reads it */
const dbEye = /^DB(\d+)\.DBX(\d+)\.(\d)$/.exec(dbRows[0]?.address ?? '')
/** Step 3b's PLC tags: name, data type, address. */
const tags = Object.fromEntries([...html.matchAll(/<tr><td class="m">(\w+)<\/td><td>(\w+)<\/td><td class="m">%([IQM])(\d+)\.(\d)<\/td><\/tr>/g)].map((m) => [m[1], { type: m[2], area: m[3], byte: Number(m[4]), bit: Number(m[5]) }]))
/** The one line of step 3b, `"Run" := NOT "Eye";`, as the stand-in runs it. */
const line = /^"(\w+)" := NOT "(\w+)";$/.exec((program ?? '').trim())

const PART_IDS = { 'Belt Conveyor': 'belt', 'Photo Eye': 'eye' }
const loadScene = (page) =>
  loadParts(page, [
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5 } },
    { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: {} },
  ])
const linkStatus = async (page) => squash((await page.locator('[data-testid="plc-link-status"]').getAttribute('title')) ?? '')
const run = (page) => page.evaluate(() => window.__oip.controller.run())
const stop = (page) => page.evaluate(() => window.__oip.controller.stop())

/** Wait until the link status matches `test`; the last status seen either way. */
async function statusUntil(page, test, timeoutMs) {
  const until = Date.now() + timeoutMs
  let s = ''
  while (Date.now() < until) {
    s = await linkStatus(page)
    if (test(s)) return s
    await sleep(250)
  }
  return s
}

// ---- the stand-in CPU ----

/** The unit tests' strict fake S7-1200, on a TCP port of this machine, running the page's program every 10 ms. */
async function standInCpu({ run: out, eye: input }) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } })
  const { FakeS7Cpu } = await vite.ssrLoadModule('/src/plc/link/s7FakeCpu.ts')
  await vite.close()
  // step 6's data block, as TIA Portal makes a new one: optimized
  const cpu = new FakeS7Cpu({ rack: 0, slot: 1, size: 256, putGet: false, dbs: dbEye ? { [Number(dbEye[1])]: { size: 16, optimized: true } } : {} })
  // a real input card's other bits in the eye's byte, which a bit write must leave alone
  const neighbours = 0xff & ~(1 << input.bit)
  cpu.memory.I[input.byte] = neighbours
  // the program's eye: step 3b's input, or step 6's data block once the page moves it there
  let fromDb = false
  const scan = setInterval(() => {
    const eye = fromDb ? (cpu.dbs.get(Number(dbEye[1])).bytes[Number(dbEye[2])] >> Number(dbEye[3])) & 1 : (cpu.memory[input.area][input.byte] >> input.bit) & 1
    const q = cpu.memory[out.area]
    q[out.byte] = eye ? q[out.byte] & ~(1 << out.bit) : q[out.byte] | (1 << out.bit)
  }, 10)
  const sockets = new Set()
  const server = createTcpServer((sock) => {
    sockets.add(sock)
    cpu.reset()
    sock.on('data', (chunk) => {
      try {
        for (const reply of cpu.push(new Uint8Array(chunk))) sock.write(reply)
      } catch {
        sock.destroy()
      }
    })
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    cpu,
    port: server.address().port,
    neighboursIntact: () => (cpu.memory.I[input.byte] & neighbours) === neighbours,
    /** step 6: the program reads the data block; `optimized` is the block's attribute, as last downloaded */
    readDb(optimized) {
      fromDb = true
      cpu.dbs.get(Number(dbEye[1])).optimized = optimized
    },
    async close() {
      clearInterval(scan)
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A free TCP port nothing listens on (for "nothing is listening"). */
async function freePort() {
  const s = createTcpServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}

async function main() {
  console.log('Following guides/s7/index.html')
  expect(ioRows.length === 2, `the guide wires two fields to addresses (${ioRows.map((w) => `${w.part} ${w.field} = ${w.address}`).join(', ')})`)
  expect(dbRows.length === 1 && !!dbEye && dbRows[0].part === 'Photo Eye', `step 6 moves the eye to a data block bit (${dbRows.map((w) => w.address).join(', ')})`)
  expect(/^"(\w+)" := NOT "DB(\d+)"\.(\w+);$/.exec((dbProgram ?? '').trim())?.[2] === dbEye?.[1], `step 6's program reads that data block (${dbProgram?.trim()})`)
  expect(!!line && !!tags[line?.[1]] && !!tags[line?.[2]], `step 3b's program is one line over two of its PLC tags (${program?.trim()})`)
  // the scene's address is the CPU's: %IX100.0 is I100.0
  for (const row of ioRows) {
    const t = Object.values(tags).find((t) => `%${t.area}X${t.byte}.${t.bit}` === row.address)
    expect(!!t && t.type === 'Bool', `${row.part}'s ${row.address} is one of step 3b's Bool tags`)
  }
  if (failures()) return 1
  const [, runName, eyeName] = line

  const cpu = await standInCpu({ run: tags[runName], eye: tags[eyeName] })
  const shell = await launchShell()
  const { page } = shell
  await pics.sizeWindow(shell.app)
  try {
    console.log('--- steps 1-2: build the scene and wire it ---')
    expect((await loadScene(page)) === true, 'the scene opens with a belt, a box and a photo eye, unwired')
    for (const row of ioRows) await wireRow(page, row, { expect, says, partIds: PART_IDS })
    await page.evaluate(() => window.__oip.store.setState({ selectedIds: ['eye'] }))
    await sleep(300)
    await shot(page, 'step2-inspector')
    await pics.ui(page, 'inspector-comms', commsGroup(page))

    console.log('--- step 4: point the simulator at the CPU ---')
    await openExternalPlc(page, { expect, says })
    const section = page.locator('[data-testid="external-plc"]')
    await section.waitFor({ timeout: 20000 })
    const radio = (label) => section.locator('label.ctl-ext-field', { hasText: labelled(says(label)) }).locator('input')
    await radio('An external PLC').check()
    await radio('S7 PUT/GET').check()
    const link = await section.locator('[data-testid="external-plc-guide"] a').getAttribute('href')
    expect(link === 'https://www.openindustryproject.org/guides/s7/', `the dialog links this guide (${link})`)
    const field = (label, testId) => section.locator('label.ctl-ext-field', { hasText: labelled(says(label)) }).locator(`[data-testid="${testId}"]`)
    const host = field('CPU', 'external-plc-s7-host')
    const port = field('Port', 'external-plc-s7-port')
    const rack = field('Rack', 'external-plc-s7-rack')
    const slot = field('Slot', 'external-plc-s7-slot')
    expect((await host.inputValue()) === says('192.168.0.1'), `the CPU field starts at 192.168.0.1 (${await host.inputValue()})`)
    expect((await port.inputValue()) === says('102'), `the port reads 102 (${await port.inputValue()})`)
    expect((await rack.inputValue()) === says('0') && (await slot.inputValue()) === says('1'), 'rack 0, slot 1')
    const reminder = squash(await page.locator('[data-testid="external-plc-s7-putget"]').innerText())
    // the page names the setting only and leaves where it lives to Siemens' documentation
    const setting = 'Permit access with PUT/GET communication from remote partner'
    expect(reminder.includes(says(setting)), `the dialog's reminder names "${setting}"`)
    const points = squash(await page.locator('[data-testid="external-plc-points"]').innerText())
    for (const p of ['%IX100.0  I100.0  written to the PLC', '%QX100.0  Q100.0  read from the PLC']) expect(points.includes(squash(says(p))), `the dialog lists ${p} (${points})`)
    await shot(page, 'step4-external-plc')
    await pics.ui(page, 'external-plc-s7', section)

    // the prompt the shell shows the first time a CPU off this machine is connected (a native dialog, out of reach)
    const main = readFileSync(join(DESKTOP_DIR, 'main.cjs'), 'utf8')
    const plcIo = readFileSync(join(DESKTOP_DIR, 'plcIo.cjs'), 'utf8')
    const prompt = says('Allow Open Industry Project to connect to a PLC at 192.168.0.1:102?')
    expect(main.includes('message: `Allow Open Industry Project to ${what}?`') && plcIo.includes('const what = `connect to a PLC at ${host}:${port}`'), `the shell's consent prompt reads "${prompt}"`)

    // the run's CPU is the stand-in on this machine
    const setField = async (loc, value) => {
      await loc.fill(value)
      await loc.press('Enter')
    }
    await setField(host, '127.0.0.1')

    console.log('--- step 5: run it ---')
    // nothing listening yet
    await setField(port, String(await freePort()))
    await page.keyboard.press('Escape')
    await run(page)
    const waiting = await statusUntil(page, (s) => s.startsWith('Waiting for the PLC'), 15000)
    expect(waiting.startsWith(says('Waiting for the PLC at')) && waiting.includes(says('nothing is listening')), `with nothing listening: "${waiting}"`)
    await stop(page)

    // a wrong slot
    await openExternalPlc(page, { expect, says })
    await setField(port, String(cpu.port))
    await setField(slot, '2')
    await page.keyboard.press('Escape')
    await run(page)
    const wrongSlot = await statusUntil(page, (s) => /slot/.test(s) && s.startsWith('Waiting'), 15000)
    expect(wrongSlot.includes(says('(rack 0, slot 1 for an S7-1200 or S7-1500)')), `a wrong slot is refused with the page's advice: "${wrongSlot}"`)
    await stop(page)

    // PUT/GET still off
    await openExternalPlc(page, { expect, says })
    await setField(slot, '1')
    await page.keyboard.press('Escape')
    await run(page)
    await waitForReset(page)
    const refused = await statusUntil(page, (s) => /PUT\/GET/.test(s), 15000)
    // the page's line, with the run's own endpoint where it has the reader's CPU
    const said = says('Waiting for the PLC at 192.168.0.1 (rack 0, slot 1): the CPU refused a write of I100.0 (error 0x8104): the CPU does not allow it. On an S7-1200/1500 that means PUT/GET is off')
    expect(refused.startsWith(said.replace('192.168.0.1', `127.0.0.1:${cpu.port}`)), `PUT/GET off is named, still waiting for the CPU: "${refused.slice(0, 220)}"`)
    expect(refused.endsWith('Trying again every second.'), '... and the link keeps asking')
    expect(refused.includes('Permit access with PUT/GET communication from remote partner'), '... with where the checkbox is')
    const x0 = await boxX(page)
    await sleep(1500)
    expect(Math.abs((await boxX(page)) - x0) < 0.05, 'and the belt does not run')

    // the reader ticks it and downloads: no second Play
    cpu.cpu.putGet = true
    const reading = await statusUntil(page, (s) => s.startsWith('Reading and writing'), 10000)
    expect(reading.startsWith(says("Reading and writing the CPU's memory at")) && reading.includes(`(${says('rack 0, slot 1')})`), `once the CPU allows it, with the same run: "${reading}"`)
    const stopped = await settledX(page, 30000, 1500)
    expect(stopped !== null && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the belt ran and the CPU stopped the box at the sensor (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
    expect(cpu.neighboursIntact(), `the simulator wrote I${tags[eyeName].byte}.${tags[eyeName].bit} alone, as the page says ("${says('writes it, that bit alone')}")`)
    await shot(page, 'step5-stopped')
    await pics.scene(page, 'box-stopped', LINE_CAMERA)
    await stop(page)

    console.log('--- step 6: a data block instead of inputs ---')
    // the reader moves the program to the data block and downloads it, forgetting Optimized block access
    cpu.readDb(true)
    for (const row of dbRows) await wireRow(page, row, { expect, says, partIds: PART_IDS })
    await run(page)
    await waitForReset(page)
    const optimized = await statusUntil(page, (s) => /optimized/.test(s), 15000)
    expect(
      optimized.startsWith(says('Waiting for the PLC at')) && optimized.includes(says('the CPU refused a write of DB1.DBX0.0')) && optimized.includes(says('A data block read or written over PUT/GET must exist and must NOT use optimized block access')),
      `an optimized block is named: "${optimized.slice(0, 260)}"`,
    )
    const x1 = await boxX(page)
    await sleep(1500)
    expect(Math.abs((await boxX(page)) - x1) < 0.05, `and the belt never starts (x = ${x1?.toFixed?.(2)} m)`)
    await stop(page)
    // untick, compile, download, run again
    cpu.readDb(false)
    await run(page)
    await waitForReset(page)
    const fine = await statusUntil(page, (s) => s.startsWith('Reading and writing') && !/optimized/.test(s), 15000)
    expect(fine.startsWith(says("Reading and writing the CPU's memory at")), `with the block unoptimized: "${fine}"`)
    const atDbEye = await settledX(page, 30000, 1500)
    expect(atDbEye !== null && Math.abs(atDbEye - 2.83) < 0.3, `the CPU stops the box at the sensor, through the data block (x = ${atDbEye?.toFixed?.(3)} m)`)
    await stop(page)
  } finally {
    await shell.close()
    await cpu.close()
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
