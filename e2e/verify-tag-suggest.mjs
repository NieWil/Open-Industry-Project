// Verify a tag field's suggestions (src/editor/components/inspector/tagField.tsx): the scene's tags, the program's
// (of the field's type only), and, when the external link is OPC UA, ADS or EtherNet/IP, the PLC's. The PLC's tags are
// read on request while stopped, listed only once something is typed, and picked by click or keyboard into the param.
// A tag an OPC UA PLC does not hold gets a "not on PLC" chip; over ADS it gets none, since the symbol table leaves out
// structure members. The field's mark says what a binding does: a warning (undeclared, wrong type, undriven),
// connected, or no program; the Speed field says a bound speed tag replaces it. Each PLC is a fake host handed to the
// controller (controller.opcUaHost, adsHost and eipHost are public for this): this tests the field, not the wire,
// which verify-external-plc-electron covers.
// Run: node e2e/verify-tag-suggest.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const PROGRAM = `VAR
  Start : BOOL;
  Speed : REAL;
END_VAR
`

const TWO_LINES = `PROGRAM Line
VAR
  Run : BOOL;
  Speed : REAL;
END_VAR
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Cpu ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Line;
    PROGRAM Line2 WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const ready = () => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 30000 })
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
      if (!belt) return { ok: false, why: 'belt package not registered' }
      store.loadScene({
        version: 4,
        packages: [belt],
        parts: [
          { id: 'b1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { runTag: 'Motor' } },
          { id: 'b2', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 3], rotationY: 0, params: { runTag: '' } },
        ],
      })
      store.loadStProgram(src, { persist: false })
      store.select('b2')
      return { ok: true }
    }, PROGRAM)
    check('scene with two belts and a program', built.ok, built.why ?? '')

    const field = page.locator('label.field', { has: page.locator('.field-label', { hasText: /^Run tag/i }) }).locator('input[data-testid="tag-field"]')
    await field.waitFor({ timeout: 30000 })
    const list = page.getByTestId('tag-suggest')
    const names = (section) => list.getByTestId(`tag-suggest-${section}`).getByTestId('tag-suggest-item').allTextContents()

    // ---- scene + program, no PLC section while the link is not OPC UA
    await field.click()
    await list.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="tag-suggest-program"]'), { timeout: 10000 }).catch(() => {})
    const program = await names('program')
    const listed = await list.getByTestId('tag-suggest-item').allTextContents()
    check('a name another belt uses, which the program lacks, is not offered', !listed.some((t) => t.startsWith('Motor')), JSON.stringify(listed))
    check('the program section offers its BOOL, not its REAL', program.some((t) => t.startsWith('Start')) && !program.some((t) => t.startsWith('Speed')), JSON.stringify(program))
    check('no PLC section while the link is not OPC UA', (await list.getByTestId('tag-suggest-plc').count()) === 0)
    await page.keyboard.press('Escape')
    check('Escape closes the list', (await list.count()) === 0)
    await page.keyboard.press('Escape')

    // ---- a fake OPC UA PLC: a tree nested a few folders deep, with two Motor1s, an array and a structure
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      const base = ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs']
      const v = (...p) => ({ path: [...base, ...p], nodeId: `ns=4;s=${p.join('.')}` })
      window.__fakeUa = { connects: 0, closes: 0 }
      controller.opcUaHost = {
        connect: async () => {
          window.__fakeUa.connects++
          return { error: '' }
        },
        browse: async () => ({
          error: '',
          truncated: false,
          variables: [v('Main', 'Motor3'), v('Line2', 'Motor1'), v('Line3', 'Motor1'), v('Main', 'PhotoEye_1'), v('Main', 'Lanes', '[0]'), v('Main', 'Drive'), v('Main', 'Drive', 'Run')],
        }),
        describe: async () => ({ error: '', nodes: [] }),
        exchange: async () => ({ error: '' }),
        close: async () => {
          window.__fakeUa.closes++
        },
        onClosed: () => () => {},
      }
      store.setExternalPlc({ mode: 'opcua', opcUaEndpoint: 'opc.tcp://fake-plc:4840' })
    })

    await field.click()
    await list.waitFor({ timeout: 5000 })
    const read = list.getByTestId('tag-suggest-plc').getByTestId('tag-suggest-action')
    check('the PLC section offers to read its tags', (await read.textContent())?.includes('Read the PLC') === true, (await read.textContent()) ?? '')
    await read.click()
    await page.waitForFunction(() => /On the PLC \(\d+ tags?\)/.test(document.querySelector('[data-testid="tag-suggest-plc"]')?.textContent ?? ''), { timeout: 5000 }).catch(() => {})
    const plcText = (await list.getByTestId('tag-suggest-plc').textContent()) ?? ''
    // Motor3, Line2.Motor1, Line3.Motor1, PhotoEye_1, Drive.Run: the array element and the structure are left out
    check('the PLC\'s bindable tags were read', /On the PLC \(5 tags\)/.test(plcText), plcText.slice(0, 120))
    check('nothing typed: the PLC\'s tags are not listed yet', (await names('plc')).length === 0)
    const fake = await page.evaluate(() => window.__fakeUa)
    check('the read connected once and let go', fake.connects === 1 && fake.closes === 1, JSON.stringify(fake))

    await page.keyboard.type('motor1')
    const plc = await names('plc')
    check('typing lists the PLC\'s matches, each by a name that tells it apart', JSON.stringify(plc) === JSON.stringify(['Line2.Motor1', 'Line3.Motor1']), JSON.stringify(plc))
    await list.getByTestId('tag-suggest-item').filter({ hasText: 'Line3.Motor1' }).click()
    let tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a click writes the picked name into the param', tag === 'Line3.Motor1', tag)
    check('and closes the list', (await list.count()) === 0)

    // keyboard: arrow to a match and Enter
    await field.click()
    await field.fill('')
    await page.keyboard.type('motor3')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('ArrowDown + Enter picks the first match', tag === 'Motor3', tag)

    // ---- a tag the PLC does not hold
    await field.click()
    await field.fill('PhotoEye1')
    // Enter with no suggestion highlighted takes the text as typed (Escape would cancel the edit, as in any field)
    await page.keyboard.press('Enter')
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a typed name is still taken as typed', tag === 'PhotoEye1', tag)
    const badge = page.locator('[data-testid="tag-warn"][data-kinds~="plc"]')
    await badge.waitFor({ timeout: 3000 }).catch(() => {})
    const badgeTitle = (await badge.count()) ? await badge.getAttribute('title') : null
    check('it carries a warning mark that the PLC lacks it', /the PLC has no tag named PhotoEye1/.test(badgeTitle ?? ''), String(badgeTitle))
    check('naming the closest tag', /Closest: PhotoEye_1/.test(badgeTitle ?? ''), String(badgeTitle))

    // the other belt's tag is bound to a name the PLC does not hold either; back in serve mode there is no chip at all
    await page.evaluate(() => window.__oip.store.setExternalPlc({ mode: 'serve' }))
    await page.waitForTimeout(200)
    check('no PLC warning once the link is not OPC UA', (await badge.count()) === 0)

    // ---- a fake TwinCAT PLC over ADS: its symbol table, read on request while stopped, as OPC UA's tree is
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      const sym = (name, typeName, adsType, size) => ({ name, typeName, adsType, size })
      window.__fakeAds = { opens: 0, closes: 0 }
      controller.adsHost = {
        open: async () => {
          window.__fakeAds.opens++
          return { error: '', localNetId: '10.0.0.5.1.1' }
        },
        bind: async () => ({ error: '' }),
        exchange: async () => ({ error: '' }),
        symbols: async () => ({ error: '', code: 0, symbols: [sym('MAIN.Extend', 'BOOL', 33, 1), sym('GVL.Extend2', 'BOOL', 33, 1), sym('MAIN.tCycle', 'TON', 65, 32), sym('GVL.Speed', 'REAL', 4, 4)] }),
        close: async () => {
          window.__fakeAds.closes++
        },
      }
      store.setExternalPlc({ mode: 'ads', adsNetId: '', adsPort: 851 })
    })
    await field.click()
    await list.waitFor({ timeout: 5000 })
    const adsRead = list.getByTestId('tag-suggest-plc').getByTestId('tag-suggest-action')
    check('over ADS the PLC section offers to read its tags', (await adsRead.textContent())?.includes('Read the PLC') === true, (await adsRead.textContent()) ?? '')
    await adsRead.click()
    await page.waitForFunction(() => /On the PLC \(\d+ tags?\)/.test(document.querySelector('[data-testid="tag-suggest-plc"]')?.textContent ?? ''), { timeout: 5000 }).catch(() => {})
    const adsText = (await list.getByTestId('tag-suggest-plc').textContent()) ?? ''
    // MAIN.Extend, GVL.Extend2, GVL.Speed: the TON is left out
    check("the ADS PLC's bit and number symbols were read", /On the PLC \(3 tags\)/.test(adsText), adsText.slice(0, 120))
    const fakeAds = await page.evaluate(() => window.__fakeAds)
    check('the ADS read opened once and let go', fakeAds.opens === 1 && fakeAds.closes === 1, JSON.stringify(fakeAds))
    await field.fill('')
    await page.keyboard.type('exte')
    const adsNames = await names('plc')
    check('typing lists the ADS matches', JSON.stringify(adsNames) === JSON.stringify(['GVL.Extend2', 'MAIN.Extend']), JSON.stringify(adsNames))
    await list.getByTestId('tag-suggest-item').filter({ hasText: 'GVL.Extend2' }).click()
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a click writes the ADS symbol into the param', tag === 'GVL.Extend2', tag)
    // the symbol table lists no structure members, so a name it lacks may still be on the PLC: no warning
    await field.click()
    await field.fill('MAIN.Station.Run')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    check('no "not on the PLC" warning over ADS', (await badge.count()) === 0)

    // ---- a fake Logix controller over EtherNet/IP: its tags and its programs', read the same way
    await page.evaluate(() => {
      const { store, controller } = window.__oip
      window.__fakeEip = { opens: 0, closes: 0 }
      controller.eipHost = {
        open: async () => {
          window.__fakeEip.opens++
          return { error: '' }
        },
        bind: async () => ({ error: '' }),
        exchange: async () => ({ error: '' }),
        tags: async () => ({
          error: '',
          status: 'ok',
          tags: [
            { name: 'Extend', type: 0xc1 },
            { name: 'Program:MainProgram.Extend3', type: 0xc1 },
            { name: 'Recipe', type: 0x8f21 },
            { name: 'Speed', type: 0xca },
          ],
        }),
        close: async () => {
          window.__fakeEip.closes++
        },
      }
      store.setExternalPlc({ mode: 'eip', eipGateway: '10.0.0.9', eipPath: '1,0' })
    })
    await field.click()
    await list.waitFor({ timeout: 5000 })
    await list.getByTestId('tag-suggest-plc').getByTestId('tag-suggest-action').click()
    await page.waitForFunction(() => /On the PLC \(\d+ tags?\)/.test(document.querySelector('[data-testid="tag-suggest-plc"]')?.textContent ?? ''), { timeout: 5000 }).catch(() => {})
    const eipText = (await list.getByTestId('tag-suggest-plc').textContent()) ?? ''
    // Extend, Program:MainProgram.Extend3, Speed: the structure is left out
    check("the controller's bit and number tags were read", /On the PLC \(3 tags\)/.test(eipText), eipText.slice(0, 120))
    const fakeEip = await page.evaluate(() => window.__fakeEip)
    check('the EtherNet/IP read opened once and let go', fakeEip.opens === 1 && fakeEip.closes === 1, JSON.stringify(fakeEip))
    await field.fill('')
    await page.keyboard.type('exte')
    const eipNames = await names('plc')
    check('typing lists the EtherNet/IP matches', JSON.stringify(eipNames) === JSON.stringify(['Extend', 'Program:MainProgram.Extend3']), JSON.stringify(eipNames))
    await list.getByTestId('tag-suggest-item').filter({ hasText: 'Program:MainProgram.Extend3' }).click()
    tag = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b2').params.runTag)
    check('a click writes the program-scoped tag into the param', tag === 'Program:MainProgram.Extend3', tag)
    await page.evaluate(() => window.__oip.store.setExternalPlc({ mode: 'serve' }))

    // ---- the field's own tag is offered while it is retyped (it stays the saved value until a commit), with its uses
    await page.evaluate(() => {
      const { store } = window.__oip
      const scene = store.getState().scene
      store.commit('Edit runTag', { ...scene, parts: scene.parts.map((p) => (p.id === 'b1' ? { ...p, params: { ...p.params, runTag: 'Start' } } : p)) })
      store.select('b1')
    })
    await field.click()
    await field.fill('Sta')
    await list.waitFor({ timeout: 5000 })
    const own = await names('program')
    check("retyping the field's own tag lists it, used by one part", own.some((t) => /^Start1 part/.test(t)), JSON.stringify(own))
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__oip.store.select('b2'))

    // ---- the warning mark beside the box: the program's word on a tag (editor/program/tagVerdicts.ts)
    const kindsOf = (re) =>
      page.evaluate((src) => {
        const label = [...document.querySelectorAll('.field-label')].find((l) => new RegExp(src, 'i').test(l.textContent ?? ''))
        return label?.closest('label')?.querySelector('[data-testid="tag-warn"]')?.getAttribute('data-kinds') ?? ''
      }, re)
    const setB2 = (params) =>
      page.evaluate((params) => {
        const { store } = window.__oip
        const scene = store.getState().scene
        store.commit('Edit tags', { ...scene, parts: scene.parts.map((p) => (p.id === 'b2' ? { ...p, params: { ...p.params, ...params } } : p)) })
        store.select('b2')
      }, params)
    await page.evaluate(() => window.__oip.store.loadStProgram('VAR\n  Start : BOOL;\n  Speed : BOOL;\nEND_VAR\n', { persist: false }))
    await setB2({ runTag: 'Strt', speedTag: 'Speed' })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tag-warn"]').length >= 2, { timeout: 10000 }).catch(() => {})
    const runKinds = await kindsOf('^Run tag')
    const speedKinds = await kindsOf('^Speed tag')
    check('a name the program does not declare is marked', runKinds.split(' ').includes('undeclared'), runKinds)
    check('a REAL field on a BOOL variable is marked', speedKinds.split(' ').includes('type'), speedKinds)
    await page.evaluate(() => window.__oip.store.loadStProgram('VAR\n  Strt : BOOL;\n  Speed : REAL;\nEND_VAR\n', { persist: false }))
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tag-warn"]').length === 0, { timeout: 10000 }).catch(() => {})
    check('declaring them clears both marks', (await kindsOf('^Run tag')) === '' && (await kindsOf('^Speed tag')) === '')

    // ---- a sound binding says what it does: connected, or no program yet
    const statusOf = (re) =>
      page.evaluate((src) => {
        const label = [...document.querySelectorAll('.field-label')].find((l) => new RegExp(src, 'i').test(l.textContent ?? ''))
        const mark = label?.closest('label')?.querySelector('[data-testid="tag-status"]')
        return mark ? { kind: mark.getAttribute('data-kind'), title: mark.getAttribute('title') } : null
      }, re)
    const statusIs = (re, kind) =>
      page
        .waitForFunction(
          ([src, kind]) => {
            const label = [...document.querySelectorAll('.field-label')].find((l) => new RegExp(src, 'i').test(l.textContent ?? ''))
            return label?.closest('label')?.querySelector('[data-testid="tag-status"]')?.getAttribute('data-kind') === kind
          },
          [re, kind],
          { timeout: 10000 },
        )
        .catch(() => {})
    await statusIs('^Run tag', 'driven')
    check('a tag the program drives is marked connected', (await statusOf('^Run tag'))?.kind === 'driven', JSON.stringify(await statusOf('^Run tag')))
    const speedDriven = await statusOf('^Speed tag')
    check('a driven speed tag says what it replaces', speedDriven?.kind === 'driven' && /in place of its Speed/.test(speedDriven.title ?? ''), JSON.stringify(speedDriven))
    // the Speed field says, while stopped, that the tag will replace it
    const speedBadge = await page.evaluate(() => {
      const row = document.querySelector('[data-param="speed"]')
      return { badge: row?.querySelector('.field-badge')?.textContent ?? '', title: row?.querySelector('.field-label')?.getAttribute('title') ?? '' }
    })
    check('the Speed field says a bound speed tag replaces it', speedBadge.badge === 'tag' && /reads “Speed” instead of this value/.test(speedBadge.title), JSON.stringify(speedBadge))

    // the program's inputs: nothing drives them, so the run tag is ignored and the speed tag stalls the belt
    await page.evaluate(() => window.__oip.store.loadStProgram('PROGRAM Main\nVAR_INPUT\n  Strt : BOOL;\n  Speed : REAL;\nEND_VAR\nEND_PROGRAM\n', { persist: false }))
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tag-warn"]').length >= 2, { timeout: 10000 }).catch(() => {})
    const ignored = await page.evaluate(() => {
      const label = [...document.querySelectorAll('.field-label')].find((l) => /^Run tag/i.test(l.textContent ?? ''))
      const mark = label?.closest('label')?.querySelector('[data-testid="tag-warn"]')
      return { kinds: mark?.getAttribute('data-kinds') ?? '', title: mark?.getAttribute('title') ?? '' }
    })
    check('an undriven run tag warns that the part ignores it', ignored.kinds.split(' ').includes('undriven') && /ignores it and runs on its own setting/.test(ignored.title), JSON.stringify(ignored))
    const stall = await page.evaluate(() => {
      const label = [...document.querySelectorAll('.field-label')].find((l) => /^Speed tag/i.test(l.textContent ?? ''))
      const mark = label?.closest('label')?.querySelector('[data-testid="tag-warn"]')
      return { kinds: mark?.getAttribute('data-kinds') ?? '', title: mark?.getAttribute('title') ?? '' }
    })
    check('an undriven speed tag warns that the part uses 0 for its Speed', stall.kinds.split(' ').includes('undriven') && /uses 0 in place of its Speed/.test(stall.title), JSON.stringify(stall))
    // the list still offers the program's input, after any that connect, saying why it would not
    const runField = page.locator('label.field', { has: page.locator('.field-label', { hasText: /^Run tag/i }) }).locator('input[data-testid="tag-field"]')
    await runField.click()
    await list.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => /program reads it/.test(document.querySelector('[data-testid="tag-suggest-program"]')?.textContent ?? ''), { timeout: 10000 }).catch(() => {})
    const misfit = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tag-suggest-program"] .tag-suggest-row.misfit')
      return { text: row?.textContent ?? '', title: row?.getAttribute('title') ?? '' }
    })
    check("a program input is listed for a field the part reads, saying the program reads it", /^Strt/.test(misfit.text) && /program reads it/.test(misfit.text) && /Declare it as an output/.test(misfit.title), JSON.stringify(misfit))
    await page.keyboard.press('Escape')

    // no program at all
    await page.evaluate(() => window.__oip.store.loadStProgram('', { persist: false }))
    await statusIs('^Run tag', 'no-program')
    check('with no program the field says so', (await statusOf('^Run tag'))?.kind === 'no-program', JSON.stringify(await statusOf('^Run tag')))
    // Escape left the box focused: a click on it reopens the list
    await runField.click()
    await list.waitFor({ timeout: 5000 }).catch(() => {})
    await page.waitForFunction(() => /No program yet/.test(document.querySelector('[data-testid="tag-suggest-program"]')?.textContent ?? ''), { timeout: 10000 }).catch(() => {})
    const emptyNote = await page.evaluate(() => document.querySelector('[data-testid="tag-suggest-program"] .tag-suggest-note')?.textContent ?? '')
    check('with no program the list says what to do', /No program yet/.test(emptyNote), emptyNote)
    await page.keyboard.press('Escape')
    await setB2({ runTag: '', speedTag: '' })

    // ---- two instances of one program: each instance's variables, by the qualified names wiring binds
    await page.evaluate((src) => window.__oip.store.loadStProgram(src, { persist: false }), TWO_LINES)
    await field.click()
    await list.waitFor({ timeout: 5000 })
    await page.waitForFunction(() => /Line2\.Run/.test(document.querySelector('[data-testid="tag-suggest-program"]')?.textContent ?? ''), { timeout: 10000 }).catch(() => {})
    const instances = await names('program')
    check("two instances: the program section offers each one's BOOL", instances.some((t) => t.startsWith('Line1.Run')) && instances.some((t) => t.startsWith('Line2.Run')) && !instances.some((t) => t.includes('Speed')), JSON.stringify(instances))
    await page.keyboard.press('Escape')
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
