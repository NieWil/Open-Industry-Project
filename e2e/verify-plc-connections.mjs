// Verify the PLC connections window (src/editor/components/plc/PlcConnectionsWindow.tsx), opened from Controller
// Properties: the simulator's own program as the default controller's variables, then a fake TwinCAT runtime and a fake
// Logix controller in its place. Picking a field and a variable writes the name into the part's tag field. A field the
// program cannot connect that way, a second writer of one variable, and a field wired to another controller are each
// said in the note; the last moves only on a second pick. A pick whose part is gone does nothing. A large list shows its
// first rows and how many more, and a group closes while a filter is typed. Each PLC is a fake host handed to the
// controller (controller.adsHost and eipHost are public for this), so this tests the window, not the wire.
// Run: node e2e/verify-plc-connections.mjs [--headed]
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const PROGRAM = `PROGRAM Main
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
VAR
  Count : DINT;
END_VAR
Run := Eye;
END_PROGRAM
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const ready = () => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), null, { timeout: 60000 })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready()

    const built = await page.evaluate((src) => {
      const { store, getPackage } = window.__oip
      const belt = getPackage('oip.belt-conveyor')
      const eye = getPackage('oip.diffuse-sensor')
      if (!belt || !eye) return 'a bundled package is missing'
      store.loadScene({
        version: 4,
        packages: [belt, eye],
        parts: [
          { id: 'b1', name: 'Belt1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { runTag: '' } },
          { id: 's1', name: 'Eye1', type: 'part', packageId: 'oip.diffuse-sensor', position: [2, 0.75, 0], rotationY: 0, params: { tag: '' } },
          { id: 's2', name: 'Eye2', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, 0], rotationY: 0, params: { tag: '' } },
          { id: 's3', name: 'Eye3', type: 'part', packageId: 'oip.diffuse-sensor', position: [4, 0.75, 0], rotationY: 0, params: { tag: 'Cell3::Eye' } },
        ],
      })
      store.loadStProgram(src, { persist: false })
      return true
    }, PROGRAM)
    check('a scene of a belt and three eyes, and a program', built === true, String(built))

    const win = page.locator('[data-testid="plc-connections"]')
    const note = page.locator('[data-testid="plc-conn-note"]')
    const field = (part, key) => page.locator(`[data-testid="plc-conn-field"][data-part="${part}"][data-key="${key}"]`)
    const variable = (name) => page.locator(`[data-testid="plc-conn-variable"][data-name="${name}"]`)
    const param = (id, key) => page.evaluate(([i, k]) => window.__oip.store.getState().scene.parts.find((p) => p.id === i)?.params[k], [id, key])
    const open = async () => {
      if ((await page.locator('[data-testid="controller-props"]').count()) === 0) {
        await showPlcEditor(page)
        await page.locator('[data-testid="org-controller"]').dblclick()
        await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 10000 })
      }
      await page.locator('[data-testid="plc-default-connections"]').click()
      await win.waitFor({ timeout: 10000 })
    }
    const done = async () => {
      await page.locator('[data-testid="plc-conn-done"]').click()
      await win.waitFor({ state: 'detached', timeout: 5000 })
    }

    // ---- the simulator's own program
    await open()
    check("the default controller run here lists the program's variables", (await win.innerText()).includes("The simulator's program"))
    await variable('Run').waitFor({ timeout: 15000 })
    check('the program offers its bits and numbers', (await variable('Eye').count()) === 1 && (await variable('Count').count()) === 1)

    await field('b1', 'runTag').click()
    check('the program input a belt cannot read from is dimmed', (await variable('Eye').getAttribute('class'))?.includes('is-unfit') === true)
    await variable('Run').click()
    check('a pick writes the variable into the field', (await param('b1', 'runTag')) === 'Run', String(await param('b1', 'runTag')))

    await field('s1', 'tag').click()
    await variable('Run').click()
    const misfit = await note.innerText()
    check('wiring a sensor to a program output connects it, and says the program drives it itself', (await param('s1', 'tag')) === 'Run' && /drives Run itself/.test(misfit), misfit)

    await field('s1', 'tag').click()
    await variable('Eye').click()
    await field('s2', 'tag').click()
    await variable('Eye').click()
    const clash = await note.innerText()
    check('a second writer of one variable is connected and warned about', (await param('s2', 'tag')) === 'Eye' && /Eye1: .* writes it too/.test(clash), clash)

    await field('s3', 'tag').click()
    check('a field wired to another controller says so', (await field('s3', 'tag').innerText()).includes('Wired to Cell3'))
    await variable('Eye').click()
    const moveNote = await note.innerText()
    check('the first pick does not move it, and says how', (await param('s3', 'tag')) === 'Cell3::Eye' && /wired to Cell3\. Pick Eye again/.test(moveNote), moveNote)
    await variable('Eye').click()
    check('the second pick moves it here', (await param('s3', 'tag')) === 'Eye', String(await param('s3', 'tag')))

    await field('b1', 'runTag').click()
    await page.evaluate(() => {
      const { store } = window.__oip
      const s = store.getState().scene
      store.commit('Remove Belt1', { ...s, parts: s.parts.filter((p) => p.id !== 'b1') })
    })
    await variable('Count').click()
    check('a pick whose part is gone does nothing', (await note.innerText()).startsWith('Pick a machine field'), await note.innerText())
    await page.evaluate(() => window.__oip.store.undo())
    await done()

    // ---- a TwinCAT runtime: read on the window's own link, large, grouped
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      window.__fake = { calls: [] }
      const sym = (name, typeName, adsType, size) => ({ name, typeName, adsType, size })
      const many = Array.from({ length: 250 }, (_, i) => sym(`MAIN.Bit${String(i).padStart(3, '0')}`, 'BOOL', 33, 1))
      controller.adsHost = {
        open: async (o) => (window.__fake.calls.push(`open ${o.link}`), { error: '', localNetId: '10.0.0.5.1.1' }),
        bind: async () => ({ error: '' }),
        exchange: async () => ({ error: '' }),
        symbols: async (o) => (window.__fake.calls.push(`symbols ${o?.link}`), { error: '', code: 0, symbols: [...many, sym('GVL.Speed', 'REAL', 4, 4), sym('GVL.Extend', 'BOOL', 33, 1)] }),
        close: async (o) => void window.__fake.calls.push(`close ${o?.link}`),
      }
      store.setExternalPlc({ enabled: true, mode: 'ads', adsNetId: '', adsPort: 851 })
    })
    await open()
    await variable('MAIN.Bit000').waitFor({ timeout: 10000 })
    const calls = await page.evaluate(() => window.__fake.calls)
    check('a TwinCAT read opens, lists and closes its own link', JSON.stringify(calls) === JSON.stringify(['open 32', 'symbols 32', 'close 32']), JSON.stringify(calls))
    const rows = await page.locator('[data-testid="plc-conn-variable"]').count()
    const more = await page.locator('[data-testid="plc-conn-more"]').innerText()
    check('a large group shows its first rows and how many more', rows === 200 && /50 more/.test(more), `${rows} rows, ${more}`)
    await page.locator('[data-testid="plc-conn-filter"]').fill('extend')
    await variable('GVL.Extend').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="plc-conn-group"]').first().click()
    check('a group closes while a filter is typed', (await variable('GVL.Extend').count()) === 0)
    await page.locator('[data-testid="plc-conn-filter"]').fill('')
    await field('s1', 'tag').click()
    await variable('MAIN.Bit007').click()
    check('a TwinCAT variable is wired the same way', (await param('s1', 'tag')) === 'MAIN.Bit007', String(await param('s1', 'tag')))
    await done()

    // ---- a Logix controller over EtherNet/IP
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      controller.eipHost = {
        open: async () => ({ error: '' }),
        bind: async () => ({ error: '' }),
        exchange: async () => ({ error: '' }),
        tags: async () => ({ error: '', status: 'ok', tags: [{ name: 'Speed', type: 0xca }, { name: 'Program:MainProgram.Eye', type: 0xc1 }, { name: 'Recipe', type: 0x8f21 }] }),
        close: async () => {},
      }
      store.setExternalPlc({ mode: 'eip', eipGateway: '10.0.0.9', eipPath: '1,0' })
    })
    await open()
    await variable('Speed').waitFor({ timeout: 10000 })
    const groups = await page.locator('[data-testid="plc-conn-group"]').allInnerTexts()
    check("a Logix controller lists its own tags, then each program's", groups.length === 2 && groups[0].includes('Controller') && groups[1].includes('Program:MainProgram'), JSON.stringify(groups))
    await field('s2', 'tag').click()
    check('a REAL is dimmed for a bit field', (await variable('Speed').getAttribute('class'))?.includes('is-unfit') === true)
    await variable('Speed').click()
    const refused = await note.innerText()
    check('and refused, with the reason', (await param('s2', 'tag')) === 'Eye' && /Speed is REAL, and .* needs a bit/.test(refused), refused)
    await done()

    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
  }
}

try {
  await main()
} catch (e) {
  console.error(e)
  failures++
} finally {
  vite.kill()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
