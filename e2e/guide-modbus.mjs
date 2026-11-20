// Follows the published Modbus guide, guides/modbus/index.html (/guides/modbus/), step by step, in the real
// desktop shell, with a real OpenPLC Runtime v4 as the PLC.
//
// What it proves: a person who does what the page says ends up where the page says. The guide itself is the
// input, not a copy of it: the program the PLC runs is the page's own <pre> text, the addresses typed into the
// Inspector are the page's own wiring tables, and every label, menu item and status line the page quotes is
// looked up on the page (`says`) and then found in, or compared with, the running app. Reword the page or the
// app and this fails on the sentence that no longer matches.
//
//   step 1  the parts' Comms fields are set through the Inspector: group and tag field by their labels
//   step 2  PLC Controllers... from the command palette; the radios, the port and the network box by their labels;
//           the points it lists are the page's
//   step 4  the page's "Example: OpenPLC", clicked through the installed OpenPLC Editor (e2e/_openplcEditor.mjs):
//           new project, the program pasted in its two halves, the remote device on the page's port with its two
//           IO groups, the Runtime v4 target, connect, Build and upload. The Editor's labels are looked up on the
//           page too, so an Editor release that renames one fails here exactly where the guide went stale
//   step 5  Play; the status lines the page quotes; the box stops at the eye; stopping the PLC stops the belt
//   step 6  the page's analog program and register groups; the belt slows while the laser sees the box. The page
//           says OpenPLC's Editor cannot map a REAL, so this one is uploaded with a hand-written device file
//           (scripts/lib/openplc-deploy.mjs), the way the page says it has to be
//
// What it does not do: pick a folder in the Editor's native folder dialog (answered from its main process with an empty
// folder), or start and stop the PLC with the Editor's play button (the runtime's REST API does it). Placing the
// parts from the library is not driven either; the scene starts with them placed and unwired. Step 5 is pressed
// before step 4 here: the Editor's upload starts the PLC, and the page's "no PLC connected yet" line is only seen
// with Play pressed first.
//
// Usage:
//   node e2e/guide-modbus.mjs                     follow the guide; exit 0 = it works as written
//   node e2e/guide-modbus.mjs --shots <dir>       also save a screenshot per step
//   node e2e/guide-modbus.mjs --images            also retake the page's pictures (guides/modbus/img/, see guidePictures)
//
// Needs the OpenPLC Runtime (OPENPLC_URL, or the per-user Windows install; see scripts/openplc-loop.mjs), the OpenPLC
// Editor (4.3.0, per-user install, or OPENPLC_EDITOR_EXE), and the guide's port (5020) free. Opens two windows for the
// run: the desktop shell and the Editor.
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window, setTimeout */

import { join } from 'node:path'
import { boxX, commsGroup, guidePictures, LINE_CAMERA, launchShell, loadParts, openExternalPlc, settledX, shot as shotTo, sleep, squash, guideTest, labelled, waitForReset, wire as wireRow } from './_guide.mjs'
import { loadOurs } from '../scripts/lib/conveyor-loop.mjs'
import { buildProgramZip, openRuntime } from '../scripts/lib/openplc-deploy.mjs'
import { findEditor, launchEditor } from './_openplcEditor.mjs'
import { ensureDeps, ensureEditorSources, HarnessError, loadEditor, UPLOAD_ENTRIES, WORK } from '../scripts/lib/openplc-editor.mjs'

const OUT = join(WORK, 'guide-modbus')
const argv = process.argv.slice(2)
const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null

// ---- the page ----

const { html, expect, says, programs, wiring, failures } = guideTest('modbus')
const pics = guidePictures('modbus', { html, expect })
const guidePort = Number(/Port<\/span>: <b>(\d+)<\/b>/.exec(html)?.[1])

// ---- the PLC side: what step 4 and step 6 tell the reader to configure ----

/** OpenPLC's task + instance around the page's PROGRAM: what a new OpenPLC project already holds. */
const withConfiguration = (program) => `${program.trim()}

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK MainTask(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM Inst0 WITH MainTask : main;
  END_RESOURCE
END_CONFIGURATION
`

/** The remote device step 4's table describes (and step 6's register groups, when `analog`). */
function guideDevice(port, analog) {
  const group = (fc, offset, length, points) => ({ id: `${fc}-${offset}`, name: `${fc}-${offset}`, functionCode: fc, cycleTime: 20, offset: String(offset), length, errorHandling: 'keep-last-value', ioPoints: points })
  const point = (name, type, at) => ({ id: name, name, type, iecLocation: at })
  const ioGroups = [group('2', 0, 1, [point('Eye', 'BOOL', '%IX0.0')]), group('15', 0, 1, [point('Run', 'BOOL', '%QX0.0')])]
  if (analog) ioGroups.push(group('4', 100, 2, [point('Range', 'REAL', '%ID50')]), group('16', 100, 2, [point('Speed', 'REAL', '%QD50')]))
  return { name: 'oip_sim', protocol: 'modbus-tcp', modbusTcpConfig: { transport: 'tcp', host: '127.0.0.1', port, timeout: 1000, slaveId: 1, ioGroups } }
}

// ---- step 4 through the OpenPLC Editor's own screens ----

/** The page's step 4 program, split the way the OpenPLC Editor keeps it: the VAR block, and the logic. */
function splitProgram(program) {
  const decl = /^VAR\b[\s\S]*?^END_VAR;?$/m.exec(program)?.[0] ?? ''
  const body = program.slice(program.indexOf(decl) + decl.length).replace(/END_PROGRAM\s*$/, '').trim()
  return { decl, body }
}

/**
 * Step 4's "Example: OpenPLC", click for click: new project, the program pasted in its two halves, the remote
 * device on the guide's port with its two IO groups, the runtime target, Build and upload. Every label the page
 * names is looked up on the page first (`says`), so the page and the Editor are checked against each other.
 */
async function openPlcEditorStep4(program, shotDir) {
  const exe = findEditor()
  if (!exe) {
    throw new HarnessError(
      'no OpenPLC Editor: install OpenPLC.Editor_4.3.0.exe from https://github.com/Autonomy-Logic/openplc-editor/releases ' +
        '(a per-user install), or set OPENPLC_EDITOR_EXE',
    )
  }
  const ed = await launchEditor({ exe, profileDir: join(WORK, 'editor-profile') })
  const step = async (label, what = label) => {
    const ok = await ed.click(label)
    if (!expect(ok, `OpenPLC: "${what}" is on screen`)) throw new HarnessError(`the OpenPLC Editor has no "${label}" here`)
  }
  const shotEd = async (name) => {
    if (shotDir) await ed.screenshot(join(shotDir, `${name}.png`))
  }
  try {
    const { decl, body } = splitProgram(program)
    expect(decl !== '' && says(body) === body, `the guide's program splits into a VAR block and the line to paste ("${body}")`)

    await step(says('New Project'))
    await step(says('PLC Project'))
    await step(says('Next'))
    await ed.fill('Project Name', 'guide_modbus')
    await step('Choose path', 'the folder field') // a native folder picker, answered with an empty folder
    await step(says('Next'))
    await step('Select a language', 'the language list')
    await step(says('Structured Text'))
    expect(await ed.waitForText(says('T#20ms'), 2000), 'the cyclic task is T#20ms, as the guide says')
    await step(says('Create Project'))
    expect(await ed.waitForText('Program main'), 'the project opens on the program main')

    await step('Variables code visualization', `the ${says('</>')} button`)
    // the code view shows two editors: the VAR block above, the logic below
    expect(await ed.paste(0, decl, 2), 'the VAR block is pasted into the code view')
    expect(await ed.paste(1, body, 2), 'the logic is pasted into the editor below it')
    await step('Variables table visualization', 'the variables table')
    const table = await ed.text()
    expect(/Eye Local .*%IX0\.0/.test(table) && /Run Local .*%QX0\.0/.test(table), 'the Editor read Eye at %IX0.0 and Run at %QX0.0 from the pasted block')
    await shotEd('step4-openplc-program')

    await step('Create PLC element trigger component', 'the + beside the project name')
    await step(says('Remote Device'))
    await ed.fill('Device name', 'simulator')
    await step('Select a protocol', 'the protocol list')
    await step(says('Modbus'))
    await step(says('Create'))
    expect(await ed.waitForText('Remote Device: simulator'), "the device's page opens")
    says('from 502 to')
    expect((await ed.value(says('Port'))) === '502', 'a new device starts on port 502, as the guide warns')
    await ed.fill('Port', String(guidePort))
    expect((await ed.value('Port')) === String(guidePort), `and takes ${guidePort}`)
    expect((await ed.value(says('IP Address'))) === says('127.0.0.1') && (await ed.value(says('Slave ID'))) === '1', 'IP Address 127.0.0.1 and Slave ID 1 are already set')

    for (const [name, fc] of [['eye', 'Read Discrete Inputs (FC 2)'], ['run', 'Write Multiple Coils (FC 15)']]) {
      await step('Add IO Group', `the + beside ${says('IO Tag Mapping')}`)
      await ed.fill('IO Group Name', name)
      await step('Read Holding Registers (FC 3)', 'the function code list')
      await step(says(fc))
      await ed.fill(says('Offset'), '0')
      await ed.fill(says('Length'), '1')
      await step(says('Create'))
    }
    const groups = await ed.text()
    expect(/eye Digital Input \(Discrete Input\) %IX0\.0 0 1/.test(groups), `the discrete input group is at ${says('%IX0.0')}, offset 0`)
    expect(/run Digital Output \(Multiple Coils\) %QX0\.0 0 1/.test(groups), `the coil group is at ${says('%QX0.0')}, offset 0`)
    await shotEd('step4-openplc-device')
    await pics.window(ed.win, 'openplc-device', { app: ed.app, size: { width: 1280, height: 900 }, until: 'IO Tag Mapping' })

    await step(says('Configuration'))
    await step('OpenPLC Simulator', `the ${says('Device')} list`)
    await step(says('OpenPLC Runtime v4'))
    await ed.fill('127.0.0.1 or localhost', '127.0.0.1')
    await step(says('Connect'))
    expect(await ed.waitForText('Login to OpenPLC Runtime'), 'Connect asks for the runtime login')
    await ed.fill('Enter username', process.env.OPENPLC_USER ?? 'openplc')
    await ed.fill('Enter password', process.env.OPENPLC_PASSWORD ?? 'openplc')
    await step('Login')
    expect(await ed.waitForText('Disconnect'), 'the Editor is connected to the runtime')

    await step('Build options', 'the Build button')
    await step(says('Build and upload'))
    await new Promise((r) => setTimeout(r, 2000))
    if (await ed.click(says('Stop PLC and Continue'))) console.log('  (the runtime was running a program: "Stop PLC and Continue")')
    expect(await ed.waitForText(says('Upload complete.'), 180000), 'the console says "Upload complete."')
    expect((await ed.text()).includes(says('PLC started.')), 'and "PLC started."')
    await shotEd('step4-openplc-uploaded')
  } finally {
    await ed.close()
  }
}

// ---- the app side ----

const PART_IDS = { 'Belt Conveyor': 'belt', 'Photo Eye': 'eye', 'Laser Sensor': 'laser' }

/** The scene step 1 describes, placed and not wired: the wiring is done through the Inspector below. */
const loadScene = (page) =>
  loadParts(page, [
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5 } },
    { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: {} },
  ])

/** Step 6's "Add a Laser Sensor beside the belt, before the Photo Eye": one more part, one undo step. */
const addLaser = (page) =>
  page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.laser-sensor')
    if (!pkg) return 'the bundled laser sensor is missing'
    const packages = scene.packages?.some((p) => p.id === pkg.id) ? scene.packages : [...(scene.packages ?? []), pkg]
    const laser = { id: 'laser', type: 'part', packageId: 'oip.laser-sensor', position: [2.2, 0.75, -0.6], rotationY: 0, params: {} }
    st.commit('Add Laser Sensor', { ...scene, packages, parts: [...scene.parts, laser] })
    return true
  })

const wire = (page, row) => wireRow(page, row, { expect, says, partIds: PART_IDS })
const linkStatus = (page) => page.locator('[data-testid="plc-link-status"]').getAttribute('title')
const shot = (page, name) => shotTo(page, shotsDir, name)

// ---- the run ----

async function main() {
  console.log('Following guides/modbus/index.html')
  expect(programs.length === 2, `the guide has its two programs (${programs.length})`)
  expect(wiring.length === 4, `the guide wires four fields (${wiring.map((w) => `${w.part} ${w.field}`).join(', ')})`)
  expect(guidePort === 5020, `the guide's port is the app's default, 5020 (${guidePort})`)
  if (failures()) return 1

  // the PLC side first: a program the editor refuses is the guide's fault, and needs no app to find out
  await ensureEditorSources(UPLOAD_ENTRIES)
  await ensureDeps()
  const [ours, editor] = [await loadOurs(), await loadEditor(UPLOAD_ENTRIES)]
  // step 6 cannot be set up through the Editor's screens (the guide says so), so it goes the hand-written way
  const analog = buildProgramZip(ours, editor, {
    text: withConfiguration(programs[1]),
    device: guideDevice(guidePort, true),
    locations: ['%IX0.0', '%QX0.0', '%ID50', '%QD50'],
    outDir: join(OUT, 'step6'),
  })
  console.log(`  ok: step 6's program builds with OpenPLC's editor code (${analog.files} files)`)
  const runtime = await openRuntime({ outDir: OUT })
  const version = await runtime.client.waitReady(120000)
  await runtime.client.login(process.env.OPENPLC_USER ?? 'openplc', process.env.OPENPLC_PASSWORD ?? 'openplc')
  // a runtime starts whatever program it last ran, which would connect before the guide's step 5 says it should
  await runtime.client.stop()
  console.log(`  runtime: OpenPLC ${version} at ${runtime.source}, stopped`)

  const shell = await launchShell()
  const { page } = shell
  await pics.sizeWindow(shell.app)
  try {
    console.log('--- step 1: build the scene and wire it ---')
    expect((await loadScene(page)) === true, 'the scene opens with a belt, a box and a photo eye, unwired')
    for (const row of wiring.slice(0, 2)) await wire(page, row)
    await shot(page, 'step1-inspector')
    await pics.ui(page, 'inspector-comms', commsGroup(page))

    console.log('--- step 2: serve it ---')
    await openExternalPlc(page, { expect, says })
    const section = page.locator('[data-testid="external-plc"]')
    await section.waitFor({ timeout: 20000 })
    const radio = (label) => section.locator('label.ctl-ext-field', { hasText: labelled(says(label)) }).locator('input')
    await radio('An external PLC').check()
    await radio('The PLC polls the simulator').check()
    expect((await page.locator('[data-testid="external-plc-port"]').inputValue()) === String(guidePort), `the port field reads ${guidePort}`)
    const network = section.locator('label.ctl-ext-field', { hasText: labelled(says('Reachable from the network')) }).locator('input')
    expect((await network.count()) === 1 && !(await network.isChecked()), '"Reachable from the network" is there, and off')
    const points = squash(await page.locator('[data-testid="external-plc-points"]').innerText())
    for (const line of ['%IX0.0  discrete input 0', '%QX0.0  coil 0']) {
      expect(points.includes(squash(says(line))), `the dialog lists ${line} (${points})`)
    }
    await shot(page, 'step2-external-plc')
    await pics.ui(page, 'external-plc', section)
    await page.keyboard.press('Escape')

    console.log('--- step 5: press Play ---')
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'listening', null, { timeout: 15000, polling: 100 })
    const waiting = await linkStatus(page)
    expect(waiting === says(`Serving on 127.0.0.1:${guidePort}: no PLC connected yet`), `before the PLC starts: "${waiting}"`)
    console.log('--- step 4: set up the PLC, in the OpenPLC Editor ---')
    await openPlcEditorStep4(programs[0], shotsDir)
    await runtime.client.waitStatus('RUNNING')
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.masters.length >= 1, null, { timeout: 30000, polling: 100 })
    const connected = (await linkStatus(page)) ?? ''
    expect(connected.startsWith(says(`Serving on 127.0.0.1:${guidePort}: 1 connected (`)), `once it polls: "${connected}"`)
    // The program polling now must be the one step 4 uploaded, and it reads only the two bits. A runtime can run the
    // last program it held for a while first (seen: step 6's, left from an earlier run, while the Editor connected),
    // and that one stops the belt at the eye too, so the box alone would not tell them apart. Registers (FC4/FC16)
    // still being polled means an older program is driving the line.
    const registerPolls = async () => {
      const r = (await page.evaluate(() => window.__oip.controller.externalPlcStatus.requests)) ?? ''
      return Number(/FC4 x(\d+)/.exec(r)?.[1] ?? 0) + Number(/FC16 x(\d+)/.exec(r)?.[1] ?? 0)
    }
    const regsBefore = await registerPolls()
    await sleep(2000)
    const regsAfter = await registerPolls()
    expect(regsAfter === regsBefore, `the PLC now polls only the discrete input and the coil: the uploaded program is running (register polls ${regsBefore} -> ${regsAfter})`)
    const stopped = await settledX(page, 25000, 1500)
    // the eye is 3 m along; the box stops with its front at the beam, its centre ~0.2 m short (2.83, as in openplc-loop)
    expect(stopped !== null && Math.abs(stopped - 2.83) < 0.3, `the box rides to the sensor and the PLC stops the belt (x = ${stopped?.toFixed?.(3)} m)`)
    await shot(page, 'step5-stopped')
    await pics.scene(page, 'box-stopped', LINE_CAMERA)

    console.log('--- step 5: prove it ---')
    // Stop puts the box back where it was placed (a run never edits the scene): the guide's "move the box back"
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 10000, polling: 100 })
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.masters.length >= 1, null, { timeout: 15000, polling: 100 })
    await waitForReset(page)
    await page.waitForFunction(() => (window.__oip.controller.livePosition('box')?.[0] ?? 0) > 1.2, null, { timeout: 15000, polling: 100 })
    const before = await boxX(page)
    expect(before < 2.4, `Play again starts the box from the beginning (x = ${before.toFixed(2)} m while moving)`)
    await runtime.client.stop()
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.stale === true, null, { timeout: 10000, polling: 100 })
    const coast = await settledX(page, 10000)
    const stale = (await linkStatus(page)) ?? ''
    // a PLC that closes its connection on stop (OpenPLC does) reads "disconnected"; one that goes quiet on an open one, "stopped polling"
    const quiet = stale.startsWith(says('The PLC disconnected:')) || stale.startsWith(says('The PLC stopped polling for'))
    expect(quiet && stale.endsWith(says('its outputs are held off until it polls again.')), `stopping the PLC: "${stale}"`)
    expect(coast !== null && coast < 2.6, `and the belt stops short of the sensor (x = ${coast?.toFixed?.(3)} m)`)
    await shot(page, 'step5-plc-stopped')
    await runtime.client.start()
    await runtime.client.waitStatus('RUNNING')
    const resumed = await settledX(page, 25000, 1500)
    expect(resumed !== null && Math.abs(resumed - 2.83) < 0.3 && resumed > coast + 0.1, `starting the PLC again carries the box on to the sensor (x = ${resumed?.toFixed?.(3)} m)`)

    console.log('--- step 6: analog values ---')
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.controller.externalPlcStatus.state === 'off', null, { timeout: 10000, polling: 100 })
    expect((await addLaser(page)) === true, `a ${says('Laser Sensor')} goes in beside the belt, before the Photo Eye`)
    for (const row of wiring.slice(2)) await wire(page, row)
    await runtime.client.stop()
    await runtime.client.deploy(analog.zip)
    await page.evaluate(() => window.__oip.controller.run())
    await waitForReset(page)
    // the box's speed through the run, from its position every 100 ms - sampled from before the PLC starts, since
    // the box is moving by the time the runtime reports RUNNING and "before the laser" would otherwise be missed
    const samples = []
    const sampling = (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 40000) {
        samples.push({ t: Date.now(), x: await boxX(page) })
        if (samples.length > 15 && Math.abs(samples.at(-1).x - samples.at(-11).x) < 0.002 && samples.at(-1).x > 2.5) break
        await sleep(100)
      }
    })()
    await runtime.client.start()
    await runtime.client.waitStatus('RUNNING')
    await sampling
    const speeds = []
    for (let i = 5; i < samples.length; i += 5) speeds.push({ x: samples[i].x, v: (samples[i].x - samples[i - 5].x) / ((samples[i].t - samples[i - 5].t) / 1000) })
    const fast = Math.max(...speeds.filter((s) => s.x < 1.5).map((s) => s.v))
    // the laser (2.2 m along) sees the box from roughly when its front reaches the beam until its back leaves it
    const slow = Math.min(...speeds.filter((s) => s.x > 1.9 && s.x < 2.3 && s.v > 0.01).map((s) => s.v))
    expect(fast > 0.4, `before the laser sees it, the PLC runs the belt at 0.5 m/s (${fast.toFixed(2)} m/s)`)
    expect(slow < 0.2, `while the laser sees it, the PLC slows the belt to 0.1 m/s (${slow.toFixed(2)} m/s)`)
    const end = samples.at(-1).x
    expect(Math.abs(end - 2.83) < 0.3, `and the box still stops at the sensor (x = ${end.toFixed(3)} m)`)
    await shot(page, 'step6-analog')
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await runtime.client.stop().catch(() => {})
    runtime.stop()
    await shell.close()
  }
  await pics.finish()
  console.log(failures() === 0 ? '\nThe guide works as written.' : `\n${failures()} check(s) failed: the guide or the app has to change.`)
  return failures() === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof HarnessError ? `\nharness: ${e.message}` : e)
    process.exit(2)
  },
)
