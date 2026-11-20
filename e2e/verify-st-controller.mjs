// The controller's tasks and programs, end to end through the real editor: the Tasks section of the PLC panel's
// organizer (components/plc/PlcOrganizer.tsx) and its two dialogs (ControllerPropertiesDialogs.tsx).
//
// Unit tests cover the edits (plc/controllerEdits.ts), the default table (plc/controller.ts), the tree over it
// (plc/taskTree.ts), the scene rewire (editor/program/controllerRewire.ts) and the named add (editor/program/controllerCommit.ts). Only
// a browser run can check that the panel connects them: that the tasks sit beside the code, where an edit to one is
// read back from the other, that a program with no table shows the default one, that retiming it sets the scan time
// and stores no table, that "New program" asks for a name and adds a PROGRAM beside the top-level code without
// renaming a tag, that a PROGRAM reads the top-level code's variables, that task and program properties edit the table,
// that Run attaches the result, that the table is part of the saved project rather than panel state, and that a table
// problem (in the Problems dock, or an attach error under the code) leads to the tasks.
//
// They live in the organizer rather than a dock of their own, because a tab in the same strip as the PLC panel never
// shows the tasks and the code they run together. Where the program runs is the organizer's Controller node, whose
// properties are the external PLC link.
// Run: node e2e/verify-st-controller.mjs [--headed]
/* global process, console, localStorage, window, document */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

const PROGRAM = `VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := Start;`

// the same top-level code, with a PROGRAM beside it that reads one of its variables
const WITH_SORTER = `PROGRAM Sorter
VAR_OUTPUT Divert : BOOL; END_VAR
Divert := Motor;
END_PROGRAM

${PROGRAM}`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function setDoc(page, text) {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

const tid = (page, id) => page.locator(`[data-testid="${id}"]`)
const programDoc = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { scanMs: s.stScanMs, controller: s.controller }
  })
const task = (page, name) => page.locator(`[data-testid="org-task"][data-task="${name}"]`)
const taskHead = (page, name) => task(page, name).locator('.org-head').first()
const programRow = (page, name) => page.locator(`[data-testid="org-program"][data-program="${name}"]`)
/** The instances the tree shows under task `name`, in order. */
const onTask = async (page, name) => (await task(page, name).locator('[data-testid="org-program"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-program')))).join(',')
/** Whether the organizer's Tasks section is on screen in its scrolled column. */
const tasksInView = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid="plc-organizer"]')
    const tasks = root?.querySelector('[data-group="tasks"]')
    if (!root || !tasks) return false
    const b = root.getBoundingClientRect()
    const r = tasks.getBoundingClientRect()
    return r.height > 0 && r.top >= b.top - 1 && r.top < b.bottom
  })

/** Right-click `locator` and pick the menu item `testid`. */
async function menu(page, locator, testid) {
  await locator.click({ button: 'right' })
  await tid(page, testid).click()
  await page.waitForTimeout(300)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private mode */
      }
    })
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout: 60000, polling: 250 })
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await tid(page, 'plc-organizer').waitFor({ state: 'visible', timeout: 30000 })
    await setDoc(page, PROGRAM)
    await page.waitForTimeout(700)

    // ---- the tasks sit beside the code ----
    check('the organizer is beside the code, docked', (await tid(page, 'plc-organizer').isVisible()) && (await page.locator('.cm-content').isVisible()))
    check('its Tasks list MainTask running the top-level code', (await task(page, 'MainTask').count()) === 1 && (await onTask(page, 'MainTask')) === 'Main', await onTask(page, 'MainTask'))
    check('...a row that says what it runs', /top-level code/.test((await programRow(page, 'Main').textContent()) ?? ''))
    const before = await programDoc(page)
    const shownInterval = ((await task(page, 'MainTask').locator('[data-testid="org-task-interval"]').textContent()) ?? '').trim()
    check('the task interval is the scan time', shownInterval === `${before.scanMs} ms`, `shown=${shownInterval} scan=${before.scanMs}`)
    check('the default table is shown, not stored', before.controller === null)
    await programRow(page, 'Main').click({ button: 'right' })
    check('the row running top-level statements cannot stop running them', await tid(page, 'org-unschedule').isDisabled())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)

    // ---- Task Properties: retiming the default task is the scan time ----
    await taskHead(page, 'MainTask').dblclick()
    await tid(page, 'task-props').waitFor({ timeout: 5000 })
    check('double-clicking a task opens its properties, on its interval', (await tid(page, 'task-props-interval').inputValue()) === String(before.scanMs))
    await tid(page, 'task-props-interval').fill('25')
    await tid(page, 'task-props-ok').click()
    await page.waitForTimeout(400)
    const retimed = await programDoc(page)
    check('retiming the default task sets the scan time', retimed.scanMs === 25, `scan=${retimed.scanMs}`)
    check('...and still stores no table', retimed.controller === null)
    check('...and the tree shows it', ((await task(page, 'MainTask').locator('[data-testid="org-task-interval"]').textContent()) ?? '').trim() === '25 ms')

    // ---- New program on a task: asks for the name, then a PROGRAM beside the top-level code, and nothing renamed ----
    await menu(page, taskHead(page, 'MainTask'), 'org-task-new-program')
    const newName = tid(page, 'org-new-program-name')
    await newName.waitFor({ timeout: 5000 })
    check('"New program" opens a name field under the task, with a free name in it', (await newName.inputValue()).trim() !== '' && (await task(page, 'MainTask').locator('[data-testid="org-new-program-name"]').count()) === 1, await newName.inputValue())
    await newName.fill('Motor')
    await newName.press('Enter')
    await page.waitForTimeout(250)
    const refused = (await tid(page, 'org-note').first().textContent().catch(() => '')) ?? ''
    check('a name the code already uses is refused, with the reason', /already used/.test(refused), refused)
    check('...the field stays open, and nothing was added', (await newName.count()) === 1 && (await programDoc(page)).controller === null)

    await newName.fill('Sorter')
    await newName.press('Enter')
    await page.waitForTimeout(600)
    const code = (await page.locator('.cm-content').textContent()) ?? ''
    check('the code shows the new PROGRAM, under the name from the field', code.includes('PROGRAM Sorter') && (await onTask(page, 'MainTask')) === 'Main,Sorter', await onTask(page, 'MainTask'))
    check('the top-level code is left where it was, not wrapped', !code.includes('PROGRAM Main') && code.includes('Motor := Start;'))
    check('no tag was renamed', (await tid(page, 'st-file-report-item').allTextContents()).every((t) => !t.includes(' is now ')))
    const added = await programDoc(page)
    check(
      'the table is stored: Main running the top-level code, Sorter beside it',
      JSON.stringify(added.controller?.programs) === JSON.stringify([{ name: 'Main', task: 'MainTask' }, { name: 'Sorter', type: 'Sorter', task: 'MainTask' }]),
      JSON.stringify(added.controller?.programs),
    )
    check('...on the task at the scan time the program had', added.controller?.tasks[0]?.intervalMs === 25)

    // ---- a PROGRAM reads the top-level code's variables ----
    await setDoc(page, WITH_SORTER)
    await page.waitForTimeout(900) // the gutter lints on a delay, the organizer's facts on a quiet period
    check('a PROGRAM using a top-level variable lints clean', (await page.locator('.cm-lintRange-error').count()) === 0)
    check('the table has no problems', (await tid(page, 'org-problem').count()) === 0)

    // ---- a task of its own, and a program moved onto it ----
    await tid(page, 'org-new-task').click()
    await page.waitForTimeout(300)
    check('+ adds Task1', (await task(page, 'Task1').count()) === 1)
    await taskHead(page, 'Task1').dblclick()
    await tid(page, 'task-props').waitFor({ timeout: 5000 })
    await tid(page, 'task-props-interval').fill('20')
    await tid(page, 'task-props-ok').click()
    await page.waitForTimeout(300)
    await programRow(page, 'Sorter').dblclick()
    await tid(page, 'program-props').waitFor({ timeout: 5000 })
    await tid(page, 'program-props-task').selectOption('Task1')
    await tid(page, 'program-props-ok').click()
    await page.waitForTimeout(400)
    check('the new task takes its interval', ((await task(page, 'Task1').locator('[data-testid="org-task-interval"]').textContent()) ?? '').trim() === '20 ms')
    check('the program moves onto it', (await onTask(page, 'Task1')) === 'Sorter' && (await onTask(page, 'MainTask')) === 'Main')
    await menu(page, taskHead(page, 'Task1'), 'org-task-delete')
    const busy = (await tid(page, 'org-note').first().textContent().catch(() => '')) ?? ''
    check('a task still running a program is not removed, and says why', /still runs Sorter/.test(busy) && (await task(page, 'Task1').count()) === 1, busy)

    // a duplicate name is refused in the dialog, which stays open with what was typed
    await taskHead(page, 'Task1').dblclick()
    await tid(page, 'task-props').waitFor({ timeout: 5000 })
    await tid(page, 'task-props-name').fill('maintask')
    await tid(page, 'task-props-ok').click()
    await page.waitForTimeout(200)
    const dup = (await tid(page, 'task-props-error').textContent()) ?? ''
    check('a duplicate task name is refused, with the reason', /already called maintask/.test(dup), dup)
    check('...and the dialog stays open with what was typed', (await tid(page, 'task-props').isVisible()) && (await tid(page, 'task-props-name').inputValue()) === 'maintask')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    check('...Escape closes it and changes nothing', (await tid(page, 'task-props').count()) === 0 && (await programDoc(page)).controller?.tasks[1]?.name === 'Task1')

    // ---- a view-only link: the tree is an index, nothing to add, and the dialogs are read-only ----
    await page.evaluate(() => window.__oip.store.setReadOnly(true))
    await page.waitForTimeout(250)
    check(
      'view-only: one line says why, and there is nothing to add',
      (await tid(page, 'org-readonly').count()) === 1 && (await tid(page, 'org-new-task').count()) === 0 && (await tid(page, 'org-new').count()) === 0,
    )
    await taskHead(page, 'Task1').dblclick()
    await tid(page, 'task-props').waitFor({ timeout: 5000 })
    check('...and a task\'s properties cannot be edited', await tid(page, 'task-props-name').isDisabled())
    await tid(page, 'task-props-ok').click()
    await page.evaluate(() => window.__oip.store.setReadOnly(false))
    await page.waitForTimeout(250)

    // ---- renaming a PROGRAM instance moves its tags: the receipt names them, as a list of what was done ----
    await programRow(page, 'Sorter').dblclick()
    await tid(page, 'program-props').waitFor({ timeout: 5000 })
    await tid(page, 'program-props-name').fill('SorterA')
    await tid(page, 'program-props-ok').click()
    await page.waitForTimeout(500)
    const renamed = await tid(page, 'st-file-report-item').allTextContents()
    check('a rename lists the tags it moved', renamed.some((t) => t.includes('Sorter.Divert is now SorterA.Divert')), renamed.join(' | '))
    check(
      '...as a receipt, not a checklist of work left to do',
      (await tid(page, 'st-file-report').locator('input[type="checkbox"]').count()) === 0 && (await tid(page, 'st-file-report-progress').count()) === 0,
    )

    // ---- Play attaches the program with its table ----
    await page.locator('button.run-button.play').click()
    await page.waitForTimeout(2500)
    check('Run attaches without a controller error', (await page.getByText(/Controller:/).count()) === 0)
    await page.evaluate(() => window.__oip.controller.stop?.())
    await page.waitForTimeout(300)

    // ---- the table is part of the saved project ----
    await page.reload()
    await showPlcEditor(page)
    await tid(page, 'plc-organizer').waitFor({ timeout: 30000 })
    await page.waitForTimeout(700)
    check('the controller survives a reload', (await tid(page, 'org-task').count()) === 2 && (await onTask(page, 'Task1')) === 'SorterA', await onTask(page, 'Task1'))

    // ---- a PROGRAM no task runs is marked, listed as not running, and one click runs it again ----
    const table = await page.evaluate(() => window.__oip.store.getState().controller)
    await page.evaluate(() => {
      const s = window.__oip.store
      const c = s.getState().controller
      s.setController({ ...c, programs: c.programs.filter((p) => p.type !== 'Sorter') })
    })
    await page.waitForTimeout(400)
    const sorterPou = page.locator('[data-testid="org-pou"][data-kind="programPou"]').filter({ hasText: 'Sorter' })
    check('a PROGRAM no task runs is marked in Programs', (await sorterPou.getAttribute('data-unscheduled')) === 'true')
    check('...and listed as not running', (await page.locator('[data-testid="org-unscheduled"][data-program="Sorter"]').count()) === 1)
    await page.locator('[data-testid="org-unscheduled"][data-program="Sorter"] [data-testid="org-schedule"]').click()
    await page.waitForTimeout(400)
    check('...Run puts an instance of it on the first task', (await onTask(page, 'MainTask')) === 'Main,Sorter' && (await sorterPou.getAttribute('data-unscheduled')) === null, await onTask(page, 'MainTask'))
    await page.evaluate((c) => window.__oip.store.setController(c), table)
    await page.waitForTimeout(300)

    // ---- a program row opens the code it runs ----
    const activeLine = () => page.locator('.cm-activeLine').first().textContent().catch(() => '')
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(200)
    await programRow(page, 'SorterA').click()
    await page.waitForTimeout(400)
    check("a program row puts the code's cursor on the PROGRAM it runs", /PROGRAM Sorter/.test((await activeLine()) ?? ''), await activeLine())

    // ---- a table problem has no line to jump to: its Problems row, and an attach error, lead to the tasks ----
    await page.evaluate(() => {
      const s = window.__oip.store
      const c = s.getState().controller
      s.setController({ ...c, programs: [...c.programs, { name: 'Ghost', type: 'Ghost', task: 'MainTask' }] })
    })
    await page.waitForTimeout(600)
    check('a row running a PROGRAM the code lacks is marked missing', /missing/.test((await programRow(page, 'Ghost').textContent()) ?? ''))
    check('...and the table problem is listed under Tasks', (await tid(page, 'org-problem').count()) >= 1)
    await page.locator('.dock-slot-tab').filter({ hasText: 'Problems' }).click()
    const tableRow = page.locator('.problems-row').filter({ hasText: 'Controller' }).first()
    await tableRow.waitFor({ timeout: 5000 })
    check('the Problems dock lists the table problem, as a row that goes to the tasks', (await tableRow.getAttribute('title')) === 'Show the tasks in the PLC organizer', await tableRow.getAttribute('title'))
    // scroll the organizer away from its Tasks first, so the reveal is what brings them back
    await tableRow.click()
    await tid(page, 'plc-organizer').waitFor({ timeout: 8000 })
    await page.waitForTimeout(500)
    check('clicking it brings the PLC panel forward with its Tasks in view', await tasksInView(page))

    await page.evaluate(() => window.__oip.controller.run())
    const showTasks = tid(page, 'st-error-show-tasks')
    const linked = await showTasks.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
    check('a controller attach error under the code links to the tasks', linked, (await page.getByText(/Controller:/).first().textContent().catch(() => '')) ?? '')
    if (linked) {
      // a program with enough POUs that the tree scrolls, scrolled to its end: the Tasks are off screen until the link
      // brings them back (a short tree shows them wherever it is scrolled, and the check would pass without the link)
      await page.evaluate(() => window.__oip.controller.stop?.())
      const functions = Array.from({ length: 30 }, (_, k) => `FUNCTION F${k} : INT\nVAR_INPUT x : INT; END_VAR\nF${k} := x;\nEND_FUNCTION\n`).join('\n')
      await setDoc(page, `${functions}\n${WITH_SORTER}`)
      await page.waitForTimeout(900)
      await page.evaluate(() => window.__oip.controller.run())
      await showTasks.waitFor({ state: 'visible', timeout: 8000 })
      await page.evaluate(() => {
        const root = document.querySelector('[data-testid="plc-organizer"]')
        if (root) root.scrollTop = root.scrollHeight
      })
      await page.waitForTimeout(200)
      check('control: scrolled to its end, the tree has the Tasks off screen', !(await tasksInView(page)))
      await showTasks.click()
      await page.waitForTimeout(400)
      check('...which the link brings into view', await tasksInView(page))
    }
    await page.evaluate(() => window.__oip.controller.stop?.())
    await page.waitForTimeout(300)

    // ---- the Controller node: where the program runs ----
    // There is no Controller dock tab in the PLC panel's strip; its settings are Controller Properties.
    check('the bottom dock has no Controller tab', (await page.locator('.dock-slot-tab').filter({ hasText: /^Controller$/ }).count()) === 0)
    const node = tid(page, 'org-controller')
    check('the organizer starts with the Controller, saying where the program runs', (await node.count()) === 1 && ((await tid(page, 'org-controller-runs-on').textContent()) ?? '').trim() === 'simulated')
    check('...with the top-level code (Main) under it', (await node.locator('xpath=..').locator('[data-testid="org-top"]').count()) === 1)
    await node.dblclick()
    await tid(page, 'controller-props').waitFor({ timeout: 8000 })
    check('double-clicking it opens Controller Properties, on this simulator', await tid(page, 'external-plc-here').isChecked())
    check('...where an external PLC needs the desktop app, and says so', (await tid(page, 'external-plc-enabled').isDisabled()) && (await tid(page, 'controller-desktop-only').count()) === 1)
    await page.keyboard.press('Escape')
    await tid(page, 'controller-props').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    check('...and Escape closes it', (await tid(page, 'controller-props').count()) === 0)
    check('no link status beside Play while the program runs here', (await tid(page, 'plc-link-status').count()) === 0)

    // ---- the count is every problem the table has ----
    // Ghost runs a missing PROGRAM; put it on a missing task too and that one row has two problems. Main moved off the
    // top-level code leaves statements nothing runs: the check points at them in the code, but a task row is what fixes it.
    await page.evaluate(() => {
      const s = window.__oip.store
      const c = s.getState().controller
      s.setController({ ...c, programs: c.programs.map((p) => (p.name === 'Ghost' ? { ...p, task: 'Nope' } : p.name === 'Main' ? { ...p, type: 'Sorter' } : p)) })
    })
    await page.waitForTimeout(900)
    const countText = ((await tid(page, 'org-problem-count').textContent().catch(() => '')) ?? '').trim()
    const problemRows = await tid(page, 'org-problem').allTextContents()
    check('the count is every problem the table has, including a second on one row and code nothing runs',
      countText === '3 problems' && problemRows.length === 3, countText + ' | ' + problemRows.join(' | '))
    check('...and the instance on a task the table lacks is listed apart', (await tid(page, 'org-missing-task').locator('[data-program="Ghost"]').count()) === 1)

    const real = errors.filter((e) => !/favicon|DevTools|WebGPU|webgpu|GPU/i.test(e))
    check('no page errors', real.length === 0, real.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nverify-st-controller: all checks passed' : `\nverify-st-controller: ${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
