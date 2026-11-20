// The agent door through the real desktop shell (docs/agent-tools.md): this script is the agent. It speaks MCP over
// HTTP to the server the shell runs on loopback (apps/desktop/mcpServer.cjs), the way Claude Desktop or Claude
// Code would, and builds a line from nothing: a belt, a box and a photo eye, wired to a program that runs the belt
// until the eye sees the box. Then it proves the line with run_test, and operates it live.
//
// What only the running app can show: the tool list arrives from the renderer. Each edit reaches the live editor
// as one labelled undo step. set_program reports a compile error at once. run_test runs a real spec on the in-app
// runner (real Jolt, real ST engine), and a spec whose stimulus is withheld fails, so the pass is not vacuous. run,
// set_tag and get_tags drive the live sim, and Stop leaves the document untouched. rename_tag moves the code and the
// wiring together, set_task retimes a task, and assign_io puts the wired tags on I/O addresses. capture_view returns
// an image of the view through the shell and puts the camera back; get_cargo, check_part, create_part and set_pou
// reach the live editor. new_project and open_project reload the editor and answer once it serves again; a folder
// outside Open Recent and the projects folder asks first (the native dialog is stubbed). sync_folder loads a file
// written in the project folder and says that loading it stopped the run.
//
//   node e2e/verify-agent-mcp-electron.mjs
/* global process, console, window, document, localStorage, setTimeout, URL, fetch, Buffer */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'

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

/** A minimal MCP client: one JSON-RPC request per POST, as the Streamable HTTP transport sends it. */
function mcpClient(url) {
  let id = 0
  async function request(method, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
    })
    const body = await res.json()
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }
  return {
    request,
    /** call a tool: { ok, text, json } */
    async call(name, args = {}) {
      const r = await request('tools/call', { name, arguments: args })
      const text = r.content?.[0]?.text ?? ''
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* a string result (get_guide) or an error message */
      }
      return { ok: !r.isError, text, json }
    },
  }
}

// What an agent writes first: Start as the program's own variable. Eye and Run are bound by wiring (the eye's tag and
// the belt's run tag name them), but nothing binds Start, so a test's input cannot reach it; run_test says so.
const NAIVE = `VAR
  Start : BOOL;
  Eye : BOOL;
  Run : BOOL;
END_VAR
Run := Start AND NOT Eye;
`
// ...and the fix it is told to make
const PROGRAM = `VAR_INPUT
  Start : BOOL;
END_VAR
VAR
  Eye : BOOL;
  Run : BOOL;
END_VAR
Run := Start AND NOT Eye;
`

// A 5 m belt 0.8 m wide at 0.8 m; the box starts at x = 0.6 and rides at 0.5 m/s. The eye is dropped anywhere and
// snap_part seats it where the editor would: on the guard, 57 mm off the belt edge, its range fitted across the belt
// (npm run snap-part -- oip.diffuse-sensor --onto oip.belt-conveyor reports the same seat). Unstopped, the box is
// off the end of the belt by t = 12.
const EYE_X = 3
const SPEC = (boxId, pressStart) => ({
  duration: 12,
  inputs: pressStart ? [{ at: 0.5, tag: 'Start', value: true }] : [],
  checks: [
    { eventually: true, within: 12, tag: 'Run', equals: true },
    { eventually: true, within: 12, tag: 'Eye', equals: true },
    { at: 12, tag: 'Run', equals: false },
    // what physically happened: the box stopped at the eye
    { at: 12, probe: { pose: { part: boxId, axis: 'x' } }, near: EYE_X - 0.3, tolerance: 0.5 },
  ],
})

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const port = await freePort()
let app
try {
  const env = { ...process.env, DESKTOP_URL: url, OIP_MCP_PORT: String(port) }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  delete env.OIP_MCP
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
  // start from an empty scene and no program, whatever the first run opened
  await page.evaluate(() => {
    const st = window.__oip.store
    window.__oip.loadSceneText(JSON.stringify({ version: st.getState().scene.version, parts: [] }))
    st.loadStProgram('')
  })

  const mcp = mcpClient(`http://127.0.0.1:${port}/mcp`)

  console.log('--- the handshake ---')
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-agent-mcp', version: '1' } })
  expect(init.protocolVersion === '2025-06-18' && init.serverInfo.name === 'open-industry-project', `initialize (${init.protocolVersion}, ${init.serverInfo.name})`)
  const { tools } = await mcp.request('tools/list')
  const names = tools.map((t) => t.name)
  for (const t of ['get_guide', 'get_scene', 'list_catalog', 'add_part', 'set_program', 'get_problems', 'run_test', 'save_test', 'snap_part', 'run', 'set_tag', 'get_tags', 'stop']) {
    expect(names.includes(t), `the editor serves ${t}`)
  }
  // a 2026-07-28 client skips the handshake: each request carries its version in _meta and mirrors it in headers
  const modern = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'm1', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  }).then((r) => r.json())
  expect(modern.result?.resultType === 'complete' && modern.result.tools.length === tools.length, `a 2026-07-28 client lists the same ${tools.length} tools without initialize`)
  const guide = await mcp.call('get_guide')
  expect(guide.ok && /metres/.test(guide.text), `get_guide returns the project guide (${guide.text.length} chars)`)
  const catalog = await mcp.call('list_catalog', { query: 'belt' })
  expect(catalog.ok && catalog.json.some((p) => p.id === 'oip.belt-conveyor' && p.tags?.some((t) => t.startsWith('runTag (in'))), 'list_catalog finds the belt and says its run tag is driven by the PLC')

  console.log('--- building the line ---')
  const belt = await mcp.call('add_part', {
    package: 'oip.belt-conveyor',
    position: [0, 0.8, 0],
    name: 'Infeed',
    params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, speed: 0.5, runTag: 'Run' },
  })
  expect(belt.ok, `add_part places the belt (${belt.text})`)
  const box = await mcp.call('add_part', { package: 'oip.box', position: [0.6, 1.0, 0], params: { length: 0.4, width: 0.3, height: 0.3 } })
  expect(box.ok, `add_part places the box (${box.text})`)
  const eye = await mcp.call('add_part', { package: 'oip.diffuse-sensor', position: [EYE_X, 1.5, 2], params: { tag: 'Eye' } })
  expect(eye.ok, `add_part places the eye, anywhere (${eye.text})`)
  const seated = await mcp.call('snap_part', { id: eye.json?.id, onto: belt.json?.id, near: [EYE_X, 0.8, -0.5] })
  expect(seated.ok && Math.abs(seated.json.position[2] + 0.457) < 0.01 && Math.abs(seated.json.fits?.maxRange - 0.84) < 0.01, `snap_part seats it on the belt guard and fits its range across the belt (${seated.text.replace(/\s+/g, ' ').slice(0, 200)})`)
  const refused = await mcp.call('add_part', { package: 'oip.box', position: [0, 1, 0], params: { colour: 'red' } })
  expect(!refused.ok && /no param 'colour'/.test(refused.text), `a param the part does not have is refused with the reason (${refused.text.slice(0, 80)})`)

  const live = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { parts: s.scene.parts.map((p) => p.packageId), labels: window.__oip.store.getEditHistory().events.map((e) => e.label) }
  })
  expect(JSON.stringify(live.parts) === JSON.stringify(['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor']), `the parts are in the live editor (${live.parts.join(', ')})`)
  expect(live.labels.filter((l) => l.startsWith('Agent: place')).length === 3, `each placement is one "Agent: place" undo step (${live.labels.join(' | ')})`)

  const boxId = box.json?.id
  const bad = await mcp.call('set_program', { source: NAIVE.replace('Run := Start AND NOT Eye;', 'Run := Start AND ;') })
  expect(bad.ok && bad.json.problems.some((p) => p.severity === 'error'), 'set_program reports a compile error at once')
  const naive = await mcp.call('set_program', { source: NAIVE })
  expect(naive.ok && naive.json.problems.length === 0, `the corrected program compiles (${naive.text.slice(0, 120)})`)
  const problems = await mcp.call('get_problems')
  expect(problems.ok && problems.json.errors === 0, `get_problems: no errors, the eye seated on the belt (${problems.text.slice(0, 300)})`)

  console.log('--- proving it ---')
  const dropped = await mcp.call('run_test', { spec: SPEC(boxId, true) })
  expect(dropped.ok && dropped.json.ok === false && /'Start' is a variable of the program but not one of its inputs/.test(dropped.json.warnings?.[0] ?? ''), `run_test: an input to a plain VAR fails AND says why (${JSON.stringify(dropped.json?.warnings)})`)
  const fixed = await mcp.call('set_program', { source: PROGRAM })
  expect(fixed.ok && fixed.json.problems.length === 0, 'the agent declares Start an input')
  expect((await page.evaluate(() => window.__oip.store.getState().stProgram)) === PROGRAM, 'the program is in the live editor')
  const pass = await mcp.call('run_test', { spec: SPEC(boxId, true) })
  expect(pass.ok && pass.json.ok === true && !pass.json.warnings, `run_test: with Start pressed the belt runs, the eye sees the box, the belt stops and the box is AT the eye (${pass.text.slice(0, 400)})`)
  // at t = 4 the box rides the running belt at 0.5 m/s: the snapshot gives its speed and the belt under it
  const snap = await mcp.call('run_test', { spec: SPEC(boxId, true), cargo: [4] })
  const rider = snap.json?.cargo?.[0]?.bodies?.find((b) => b.part === boxId)
  expect(snap.ok && Math.abs((rider?.vel?.[0] ?? 0) - 0.5) < 0.05 && rider?.touching?.includes(belt.json?.id), `run_test's cargo snapshot gives the box's velocity and what it touches (${JSON.stringify(rider)})`)
  const kept = await mcp.call('save_test', { spec: { name: 'box stops at the eye', ...SPEC(boxId, true) } })
  expect(kept.ok && kept.json.tests.includes('box stops at the eye'), `save_test keeps it in the project (${kept.text.replace(/\s+/g, ' ').slice(0, 160)})`)
  const all = await mcp.call('run_test')
  expect(all.ok && all.json.ok === true && all.json.tests.length === 1, `run_test with no spec runs what the project keeps (${all.text.replace(/\s+/g, ' ').slice(0, 160)})`)
  expect((await page.evaluate(() => window.__oip.store.getState().testCount)) === 1, 'the editor counts the kept test (the Tests overlay runs it)')
  const control = await mcp.call('run_test', { spec: SPEC(boxId, false) })
  expect(control.ok && control.json.ok === false, `run_test: without Start the same checks FAIL, so the pass was not vacuous (${control.text.slice(0, 200)})`)
  const invalid = await mcp.call('run_test', { spec: { checks: [] } })
  expect(!invalid.ok && /invalid test spec/.test(invalid.text), 'an invalid spec is refused with the reasons')

  console.log('--- operating it live ---')
  const docBefore = await page.evaluate(() => JSON.stringify(window.__oip.store.getState().scene.parts))
  const historyBefore = await page.evaluate(() => window.__oip.store.getEditHistory().events.length)
  const ran = await mcp.call('run')
  expect(ran.ok && ran.json.running === true, 'run starts the simulation')
  await page.waitForFunction(() => window.__oip.controller.plcWatch !== null, null, { timeout: 30000, polling: 100 })
  // trace_tags runs over the press: the belt starts, then stops when the box reaches the eye (calls run concurrently)
  const tracing = mcp.call('trace_tags', { names: ['Run', 'Eye'], seconds: 10 })
  await sleep(300)
  const pressed = await mcp.call('set_tag', { name: 'Start', value: true })
  expect(pressed.ok, `set_tag presses Start (${pressed.text})`)
  let seen = false
  for (let i = 0; i < 120 && !seen; i++) {
    const t = await mcp.call('get_tags', { names: ['Eye', 'Run'] })
    seen = t.ok && t.json.tags.Eye === true && t.json.tags.Run === false
    if (!seen) await sleep(250)
  }
  expect(seen, 'get_tags: the live line runs until the eye sees the box, then stops the belt')
  const trace = await tracing
  const changes = trace.json?.changes ?? []
  const runOn = changes.find((c) => c.tag === 'Run' && c.value === true)
  const eyeOn = changes.find((c) => c.tag === 'Eye' && c.value === true)
  const runOff = changes.find((c) => c.tag === 'Run' && c.value === false && eyeOn && c.t >= eyeOn.t)
  expect(trace.ok && runOn && eyeOn && runOff && runOn.t < eyeOn.t, `trace_tags sees Run on, then Eye on and Run off, at sim times (${JSON.stringify(changes).slice(0, 200)})`)
  const cargo = await mcp.call('get_cargo')
  expect(cargo.ok && cargo.json.running && cargo.json.cargo.some((c) => c.part === boxId), `get_cargo lists the box (${cargo.text.replace(/\s+/g, ' ').slice(0, 160)})`)
  // capture_view: an image of the 3D view alone, taken through the shell; the user's camera and the editor around
  // the view come back as they were
  const viewState = () => page.evaluate(() => ({ pose: JSON.stringify(window.__oip.controller.view.cameraPose()), hidden: document.querySelectorAll('[style*="visibility: hidden"]').length }))
  const viewBefore = await viewState()
  const shot = await mcp.request('tools/call', { name: 'capture_view', arguments: { parts: [belt.json?.id], from: 'iso' } })
  const image = shot.content?.find((c) => c.type === 'image')
  expect(!shot.isError && image?.mimeType === 'image/jpeg' && image.data.length > 4000, `capture_view returns a JPEG (${shot.isError ? shot.content?.[0]?.text : `${image?.data.length ?? 0} base64 chars`})`)
  if (image) {
    const shotPath = join(profileDir, 'capture_view.jpg')
    writeFileSync(shotPath, Buffer.from(image.data, 'base64'))
    console.log(`  (capture_view image: ${shotPath})`)
  }
  const viewAfter = await viewState()
  expect(viewAfter.pose === viewBefore.pose && viewAfter.hidden === viewBefore.hidden, 'capture_view puts the camera and the editor chrome back')
  // with no parts it frames the line, not the building around it (which put the camera ~50 m out)
  const whole = await mcp.request('tools/call', { name: 'capture_view', arguments: {} })
  const wholeInfo = JSON.parse(whole.content?.[0]?.text ?? '{}')
  const reach = wholeInfo.camera ? Math.hypot(...wholeInfo.camera.position.map((v, i) => v - wholeInfo.camera.target[i])) : Infinity
  expect(!whole.isError && wholeInfo.framed === 'every part but the building' && reach < 20, `capture_view's default frames the parts, not the building (${wholeInfo.framed}, camera ${reach.toFixed(1)} m out)`)
  // minimized, the window draws about one frame a second: the capture still answers at once, framed as it is shown
  const shownTop = JSON.parse((await mcp.request('tools/call', { name: 'capture_view', arguments: { from: 'top' } })).content?.[0]?.text ?? '{}')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  const t0 = Date.now()
  const hidden = await mcp.request('tools/call', { name: 'capture_view', arguments: { from: 'top' } })
  const hiddenMs = Date.now() - t0
  const hiddenInfo = JSON.parse(hidden.content?.[0]?.text ?? '{}')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  expect(!hidden.isError && hidden.content?.some((c) => c.type === 'image') && hiddenMs < 5000 && JSON.stringify(hiddenInfo.camera) === JSON.stringify(shownTop.camera), `capture_view answers with the framed view while the window is minimized (${hiddenMs} ms, ${hidden.content?.[0]?.text?.replace(/\s+/g, ' ').slice(0, 160)})`)
  const stopped = await mcp.call('stop')
  expect(stopped.ok && stopped.json.running === false, 'stop ends the run')
  const docAfter = await page.evaluate(() => JSON.stringify(window.__oip.store.getState().scene.parts))
  const historyAfter = await page.evaluate(() => window.__oip.store.getEditHistory().events.length)
  expect(docAfter === docBefore && historyAfter === historyBefore, 'operating wrote nothing to the document: same parts, no new undo step')

  console.log('--- renaming, timing and I/O ---')
  const beltId = belt.json?.id
  const renamed = await mcp.call('rename_tag', { from: 'Run', to: 'BeltRun' })
  expect(renamed.ok && renamed.json.rewiredParts?.includes(beltId), `rename_tag rewires the belt (${renamed.text.replace(/\s+/g, ' ').slice(0, 200)})`)
  expect(/box stops at the eye/.test(renamed.json?.warnings?.[0] ?? ''), 'rename_tag warns that the kept test still names Run')
  const afterRename = await page.evaluate((id) => {
    const s = window.__oip.store.getState()
    return { runTag: s.scene.parts.find((p) => p.id === id)?.params.runTag, program: s.stProgram, label: window.__oip.store.getEditHistory().events.at(-1)?.label }
  }, beltId)
  expect(afterRename.runTag === 'BeltRun' && /\bBeltRun\b/.test(afterRename.program) && !/\bRun\b/.test(afterRename.program), `the live editor has the new name in the code and the wiring (${afterRename.runTag})`)
  expect(afterRename.label === 'Agent: rename Run to BeltRun', `the rename is one undo step (${afterRename.label})`)
  const noTask = await mcp.call('set_task', { task: 'NoSuchTask', intervalMs: 20 })
  const taskName = /the tasks are: ([A-Za-z_]\w*)/.exec(noTask.text)?.[1]
  expect(!noTask.ok && taskName, `set_task names the tasks when it cannot find one (${noTask.text.slice(0, 120)})`)
  const retimed = await mcp.call('set_task', { task: taskName ?? '', intervalMs: 20 })
  expect(retimed.ok && retimed.json.tasks.some((t) => t.intervalMs === 20), `set_task retimes ${taskName} (${retimed.text.replace(/\s+/g, ' ').slice(0, 160)})`)
  const assigned = await mcp.call('assign_io')
  const at = Object.fromEntries((assigned.json?.assigned ?? []).map((a) => [a.name, a.address]))
  expect(assigned.ok && /^%IX/.test(at.Eye ?? '') && /^%QX/.test(at.BeltRun ?? ''), `assign_io gives the eye an input and the belt an output (${JSON.stringify(at)})`)
  const ioList = await mcp.call('get_io_list')
  expect(ioList.ok && ioList.json.csv.includes(`Eye,${at.Eye},BOOL,PLC input`) && ioList.json.csv.includes(`BeltRun,${at.BeltRun},BOOL,PLC output`), 'get_io_list lists both points')
  const wiredEye = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.params.tag, eye.json?.id)
  expect(wiredEye === at.Eye, `the eye is wired to its address in the live editor (${wiredEye})`)

  console.log('--- undo ---')
  await page.evaluate(() => window.__oip.store.undo())
  const afterUndo = await mcp.call('get_program')
  expect(afterUndo.ok && afterUndo.json.source !== PROGRAM, 'the user can take the agent\'s last edit back with one undo')

  console.log('--- part definitions and POUs ---')
  const typo = await mcp.call('check_part', { id: 'oip.box', manifest: { categry: 'Cargo' } })
  expect(typo.ok && typo.json.ok === false && /did you mean \\"category\\"/.test(typo.text), 'check_part catches a misspelt manifest field')
  const made = await mcp.call('create_part', { name: 'Gate Plinth', behavior: 'definePart({ params: {}, step(ctx) {} })' })
  expect(made.ok && made.json.id === 'user.gate-plinth', `create_part adds a part to the project (${made.text.slice(0, 160)})`)
  const placed = await mcp.call('add_part', { package: 'user.gate-plinth', position: [-3, 0, 0] })
  expect(placed.ok, `the new part places (${placed.text.slice(0, 120)})`)
  // import_model through the shell: a GLB (a tracked part asset), then STEP through the CAD kernel's worker (the
  // CAx-IF assembly verify-step-import.mjs uses: 18 solids)
  const meshOf = () => page.evaluate(() => {
    const pkg = window.__oip.store.getState().userPackages.find((p) => p.id === 'user.gate-plinth')
    return { shape: pkg?.geometry.links.find((l) => l.name === 'body')?.shape.kind, assets: pkg?.assets?.length ?? 0, label: window.__oip.store.getEditHistory().events.at(-1)?.label }
  })
  const glbPath = join(here, '..', 'public', 'part-assets', '929d5eae36c065f460ac5bb80c287977bcf7c7d5596680a56ab2946d483cdb32.glb')
  const glb = await mcp.call('import_model', { id: 'user.gate-plinth', link: 'body', path: glbPath })
  const afterGlb = await meshOf()
  expect(glb.ok && glb.json.bytes === statSync(glbPath).size && afterGlb.shape === 'mesh' && afterGlb.assets === 1, `import_model embeds a GLB as the link's mesh (${glb.text.replace(/\s+/g, ' ').slice(0, 160)})`)
  expect(afterGlb.label === 'Agent: import model into Gate Plinth', `the import is one labelled undo step (${afterGlb.label})`)
  const step = await mcp.call('import_model', { id: 'user.gate-plinth', link: 'body', path: require.resolve('occt-import-js/test/testfiles/cax-if/as1-oc-214.stp') })
  expect(step.ok && step.json.step?.solids === 18 && step.json.step.meshes >= 1 && (await meshOf()).assets === 2, `import_model converts a STEP file (${step.text.replace(/\s+/g, ' ').slice(0, 200)})`)
  // the model replaces the default part's one body link whole, so each import fits the part to it (no footprint hint)
  for (const [what, r] of [['GLB', glb], ['STEP', step]]) {
    expect(r.json?.fitted === true && r.json?.boundsHint === undefined, `import_model (${what}) fits a one-link part to the model (${JSON.stringify(r.json?.footprint)})`)
  }
  const notModel = await mcp.call('import_model', { id: 'user.gate-plinth', link: 'body', path: join(here, '..', 'package.json') })
  expect(!notModel.ok && /a model is a \.glb, \.step, \.stp, USD .* or URDF/.test(notModel.text), 'import_model refuses a file that is not a model')
  const pou = await mcp.call('set_pou', { name: 'Debounce', source: 'FUNCTION_BLOCK Debounce\nVAR_INPUT\n  In : BOOL;\nEND_VAR\nEND_FUNCTION_BLOCK' })
  expect(pou.ok && pou.json.pous.includes('Debounce'), `set_pou adds a POU (${pou.text.replace(/\s+/g, ' ').slice(0, 160)})`)

  console.log('--- projects (main runs these; each open reloads the editor) ---')
  const projectName = () => page.evaluate(() => window.__oip.store.getState().projectName)
  const first = await mcp.call('new_project', { name: 'Agent Made' })
  expect(first.ok && first.json.path?.startsWith(join(realpathSync.native(profileDir), 'Projects')) && (await projectName()) === 'Agent Made', `new_project makes a folder in the projects folder and the editor reloads into it (${first.text.slice(0, 160)})`)
  const second = await mcp.call('new_project', { name: 'Agent Two' })
  expect(second.ok && (await projectName()) === 'Agent Two', 'a second new_project replaces it on screen')
  const listed = await mcp.call('list_projects')
  const rows = listed.json?.projects ?? []
  expect(['Agent Made', 'Agent Two'].every((n) => rows.some((p) => p.name === n)) && rows.find((p) => p.open)?.name === 'Agent Two', `list_projects lists both and marks the open one (${JSON.stringify(rows.map((p) => [p.name, p.open]))})`)
  const back = await mcp.call('open_project', { project: 'Agent Made' })
  expect(back.ok && back.json.opened === 'Agent Made' && (await projectName()) === 'Agent Made', `open_project by name reopens a listed project unasked (${back.text.slice(0, 120)})`)
  const again = await mcp.call('open_project', { project: 'Agent Made' })
  expect(again.ok && /already the open project/.test(again.json?.note ?? ''), 'opening the open project says so')
  // a folder outside Open Recent and the projects folder asks; the stand-in for the native dialog answers
  const stranger = join(mkdtempSync(join(tmpdir(), 'oip-stranger-')), 'Stranger')
  cpSync(second.json.path, stranger, { recursive: true })
  const answerDialog = (response) => app.evaluate(({ dialog }, r) => {
    globalThis.__oipAsked = []
    dialog.showMessageBox = async (...a) => (globalThis.__oipAsked.push(a.at(-1).message), { response: r })
  }, response)
  await answerDialog(1)
  const declined = await mcp.call('open_project', { project: stranger })
  const askedOnce = await app.evaluate(() => globalThis.__oipAsked)
  expect(!declined.ok && /declined/.test(declined.text) && askedOnce.length === 1 && (await projectName()) === 'Agent Made', `a folder elsewhere asks first, and Cancel opens nothing (${declined.text}; ${askedOnce[0]})`)
  await answerDialog(0)
  const allowed = await mcp.call('open_project', { project: stranger })
  expect(allowed.ok && (await projectName()) === 'Agent Two', `Open in that dialog opens it (${allowed.text.slice(0, 120)})`)
  const tools2 = (await mcp.request('tools/list')).tools.map((t) => t.name)
  expect(['get_scene', 'list_projects', 'open_project', 'new_project'].every((t) => tools2.includes(t)), 'the reloaded editor serves its tools again, with main\'s beside them')

  // an agent that writes files in the folder: sync_folder loads them at once and says the load stopped the run
  const programPath = 'plc/program.st'
  const started = await mcp.call('run')
  const manifest = JSON.parse(readFileSync(join(stranger, 'project.json'), 'utf8'))
  mkdirSync(join(stranger, 'plc'), { recursive: true })
  writeFileSync(join(stranger, programPath), 'VAR\n  Seen : BOOL; (* written in the folder *)\nEND_VAR\n')
  writeFileSync(join(stranger, 'project.json'), JSON.stringify({ ...manifest, program: [programPath] }, null, 2))
  const synced = await mcp.call('sync_folder')
  const program = await page.evaluate(() => window.__oip.store.getState().stProgram)
  expect(started.ok && synced.ok && synced.json.loaded?.includes(programPath) && synced.json.stoppedRun === true && program.includes('written in the folder'), `sync_folder loads a file written in the folder and says the load stopped the run (${synced.text.slice(0, 200)})`)
  const quiet = await mcp.call('sync_folder')
  expect(quiet.ok && quiet.json.loaded?.length === 0 && quiet.json.stoppedRun === false, `a second sync_folder loads nothing (${quiet.text.slice(0, 160)})`)

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall agent-mcp-electron checks passed')
process.exit(0)
