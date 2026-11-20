// Program export and import, end to end through the real editor.
//
// Unit tests cover the exporter's output and the oracle checks the .st target compiles with
// a real IEC compiler. Only a browser run can check that a user can actually get the file:
// the button exists, the download fires, and the downloaded bytes are the bytes the exporter
// produced.
// Run: node e2e/verify-st-export.mjs [--headed]
/* global process, console, document, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

// exercises the pieces that must survive translation: a user FB, an enum, a sized STRING,
// and a duration literal. The latch's inputs are
// S1/R1, not S/R: those are IL operators a target may reserve (export.ts IL_OPERATOR_NAMES), which would warn
const PROGRAM = `TYPE Mode : (Idle, Running); END_TYPE
FUNCTION_BLOCK Latch
VAR_INPUT S1 : BOOL; R1 : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := (Q OR S1) AND NOT R1;
END_FUNCTION_BLOCK
VAR_INPUT Start : BOOL; Stop : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; Label : STRING[12]; END_VAR
VAR seal : Latch; state : Mode; period : TIME := T#1s500ms; END_VAR
seal(S1 := Start, R1 := Stop, Q => Motor);
Label := 'LINE-01';`

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

/** The first task in the PLC panel's organizer. A program with no table runs from the default task, whose interval is
 *  the scan time. */
const firstTask = (page) => page.locator('[data-testid="org-task"]').first()

/** Set the scan time: the default task's interval, in its properties (a double-click on the task in the organizer). */
async function setScan(page, ms) {
  await showPlc(page)
  await firstTask(page).locator('.org-head').first().dblclick()
  await page.locator('[data-testid="task-props-interval"]').fill(String(ms))
  await page.locator('[data-testid="task-props-ok"]').click()
}

/** Bring the PLC panel back to the front if another tab of its dock strip replaced it: the organizer, the file menu
 *  and the import report are all in it. */
async function showPlc(page) {
  const menu = page.locator('[data-testid="st-file-menu"]')
  if (!(await menu.isVisible())) {
    await page.locator('.dock-slot-tab').filter({ hasText: /^PLC$/ }).click()
    await menu.waitFor({ state: 'visible', timeout: 5000 })
  }
}

/** The scan time as the organizer shows it, on the default task. */
async function scanValue(page) {
  await showPlc(page)
  return ((await firstTask(page).locator('[data-testid="org-task-interval"]').textContent()) ?? '').replace(/\s*ms$/, '').trim()
}

/** Wait for an import to finish, on the program itself: the file is read and its reader loads (lazily) before it does,
 *  so a fixed sleep reads the previous program on a busy machine. */
async function landed(page, text) {
  await page
    .waitForFunction((t) => window.__oip.store.getState().stProgram.includes(t), text, { timeout: 30000, polling: 250 })
    .catch(() => {})
}

/** Run one of the PLC panel's file commands from its ⋯ menu, by the command's label (the File menu's label too). */
async function panelCommand(page, label) {
  await showPlc(page)
  const menu = page.locator('[data-testid="st-file-menu"]')
  await menu.click()
  // Wait for the menu to actually be open before clicking through it. Without this the item click can
  // happen while the panel is still mounting: the menu closes, no command runs and the download never
  // fires (measured as alternating runs of 0 and 17 passes on an otherwise idle machine).
  await page.locator('[data-testid="st-file-menu-items"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

/** Run a file command from the PLC panel's menu and return the downloaded file's name + contents. */
async function download(page, label) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 45000 }),
    panelCommand(page, label),
  ])
  const stream = await dl.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return { name: dl.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  // dark: the note colours below are the dark scheme's, and the app follows the OS (editor/appearance.ts 'system'),
  // which headless Chromium reports as light
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    // Any dock-layout write has to come after the app's own. `goto` resolves before the app mounts, and the app saves
    // its default layout on boot, so a layout written before that is overwritten: the reload comes back with the PLC
    // panel docked in the bottom strip, and the first click on another bottom tab unmounts the editor this run
    // reads. So wait for the app first, as verify-panel-maximize and verify-float-viewport-bounds do.
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout: 30000 })
    // the PLC panel docked, where the organizer (and its tasks, which hold the scan time) is beside the code
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await page.waitForTimeout(800)

    await setDoc(page, PROGRAM)
    await page.waitForFunction(() => document.querySelectorAll('.cm-lintRange-error').length === 0, null, { timeout: 6000 })
      .catch(() => {})

    // ---- the IEC text target ----
    const st = await download(page, 'Export PLC Program (.st)')
    check('.st downloads with a project-named file', st.name.endsWith('.st'), `name=${st.name}`)
    check('.st carries the generated configuration layer',
      st.text.includes('PROGRAM Main') && st.text.includes('END_PROGRAM') &&
      st.text.includes('CONFIGURATION Config0') && st.text.includes('TASK Tick('),
      `bytes=${st.text.length}`)
    check('.st keeps the user POUs ahead of the program',
      st.text.indexOf('FUNCTION_BLOCK Latch') > -1 && st.text.indexOf('FUNCTION_BLOCK Latch') < st.text.indexOf('PROGRAM Main'))
    // The sized spelling is IEC's own (single_byte_string_var_declaration), so it crosses
    // untouched. Hoisting it into a TYPE declaration would produce a form MATIEC cannot parse.
    check('.st keeps the sized STRING on the variable, as written',
      st.text.includes('Label : STRING[12];') && !st.text.includes('Str12'),
      st.text.includes('STRING[12]') ? 'ok' : 'no sized string found')

    // ---- the PLCopen XML target ----
    const xml = await download(page, 'Export PLC Program (PLCopen XML)')
    check('XML downloads', xml.name.endsWith('.xml'), `name=${xml.name}`)
    check('XML uses the TC6 namespace importers accept',
      // (the xhtml namespace follows it, for documentation bodies)
      xml.text.includes('<project xmlns="http://www.plcopen.org/xml/tc6_0201"'))
    check('XML carries every POU',
      xml.text.includes('<pou name="Latch" pouType="functionBlock">') &&
      xml.text.includes('<pou name="Main" pouType="program">'))
    check('XML sorts declarations into interface sections',
      xml.text.includes('<inputVars>') && xml.text.includes('<variable name="Start">') &&
      xml.text.includes('<outputVars>') && xml.text.includes('<variable name="Motor">'))
    // TC6 spells <string> lowercase and everything else uppercase; a validator rejects <STRING>
    check('XML spells elementary types per TC6, with the string length attached',
      xml.text.includes('<string length="12"/>') && xml.text.includes('<BOOL/>') && !xml.text.includes('<STRING'))
    check('XML keeps the duration literal as written', xml.text.includes('<simpleValue value="T#1s500ms"/>'),
      'T#1s500ms must not come back as 1500')
    check('XML carries the enumeration', xml.text.includes('<dataType name="Mode">') && xml.text.includes('<value name="Idle"'))
    check('XML body is the statements only, not the declarations',
      xml.text.includes('Q =&gt; Motor);') && !xml.text.includes('VAR_INPUT Start'))

    // ---- the export says what it did, in the right colour ----
    // a silent clean export and a warned one in the compiler's red would leave the user only
    // "nothing" and "looks broken" to tell the two outcomes apart
    const headline = page.locator('[data-testid="st-file-report-headline"]')
    check('a clean export confirms itself, naming the file',
      /^✓ Exported .*\.xml$/.test(((await headline.textContent().catch(() => '')) ?? '').trim()),
      (await headline.textContent().catch(() => '')) ?? '')
    const okColour = await headline.evaluate((el) => getComputedStyle(el).color).catch(() => '')
    check('the confirmation is NOT drawn in the error red', okColour !== 'rgb(255, 107, 94)', `color=${okColour}`)

    // a VAR_GLOBAL program warns, and that warning is amber, not red, and it is a checklist row
    // of its own rather than text appended to the headline
    await setDoc(page, 'VAR_GLOBAL Level : INT; END_VAR\nVAR_OUTPUT x : INT; END_VAR\nx := Level;')
    await page.waitForTimeout(400)
    const warned = await download(page, 'Export PLC Program (.st)')
    check('a warned export still downloads', warned.text.includes('VAR_GLOBAL'), `bytes=${warned.text.length}`)
    const warnRows = await page.locator('[data-testid="st-file-report-item"]').allTextContents()
    check('what the target may not carry is its own row, not appended to the headline',
      warnRows.some((r) => /VAR_EXTERNAL/.test(r)) && !/VAR_EXTERNAL/.test((await headline.textContent().catch(() => '')) ?? ''),
      warnRows.join(' | ').slice(0, 100))
    const warnColour = await headline.evaluate((el) => getComputedStyle(el).color).catch(() => '')
    check('an export note is amber (a warning), not the compiler red',
      warnColour === 'rgb(230, 184, 0)', `color=${warnColour}`)

    // ---- the generated TASK carries the editor's own scan time ----
    // a hardcoded 100 ms would make a program simulated at another period export a file
    // claiming a period it was never run at
    await setScan(page, 25)
    await page.waitForTimeout(600)
    const scanned = await download(page, 'Export PLC Program (.st)')
    check('the exported TASK interval is the scan time set in the editor',
      scanned.text.includes('INTERVAL := T#25ms'), scanned.text.match(/INTERVAL := T#\d+ms/)?.[0] ?? 'no TASK found')

    // ---- import ----
    // the user-visible round trip: take a file a vendor toolchain would produce, import it,
    // and the program must arrive whole with its scan time adopted and its losses named.
    // More than one thing the subset cannot hold, on purpose: the panel has to return a list of
    // them, which a one-note file cannot test. (The %IX/%QX pair crosses as written, since the scene
    // binds located inputs and outputs by address, and so does the memory address, which is storage
    // the program keeps. None of these gets a note, and they stay here as the control for that. The
    // losses are an incomplete address and RETAIN.)
    const VENDOR = `PROGRAM Cell
VAR Start AT %IX0.0 : BOOL; END_VAR
VAR RETAIN Count : INT; END_VAR
VAR Lamp AT %QX0.1 : BOOL; END_VAR
VAR Scratch AT %MW10 : INT; END_VAR
VAR Partial AT %IX* : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := Start;
END_PROGRAM

CONFIGURATION Plant
  RESOURCE CPU ON PLC
    TASK Fast(INTERVAL := T#40ms, PRIORITY := 1);
    PROGRAM P1 WITH Fast : Cell;
  END_RESOURCE
END_CONFIGURATION`
    // by testid, not `input[type=file]`: the app has other hidden file inputs (project JSON)
    // and the bare selector takes whichever is first in the DOM
    await page.setInputFiles('[data-testid="st-import-file"]', {
      name: 'cell.st', mimeType: 'text/plain', buffer: Buffer.from(VENDOR, 'utf8'),
    })
    await landed(page, 'Motor := Start;')
    const doc = await page.locator('.cm-content').textContent()
    check('the imported program lands in the editor, wrapper peeled',
      doc.includes('Motor := Start;') && !doc.includes('END_PROGRAM') && !doc.includes('CONFIGURATION'),
      (doc ?? '').slice(0, 60))
    check('the file\'s TASK period becomes the editor scan time',
      (await scanValue(page)) === '40')
    const report = page.locator('[data-testid="st-file-report"]')
    const items = page.locator('[data-testid="st-file-report-item"]')
    check('what the subset cannot hold is named, not swallowed',
      /%IX\*/.test((await report.textContent().catch(() => '')) ?? ''),
      ((await report.textContent().catch(() => '')) ?? '').slice(0, 90))
    check('the headline names the file and the scan time it adopted',
      /Imported cell\.st.*40 ms/.test((await page.locator('[data-testid="st-file-report-headline"]').textContent().catch(() => '')) ?? ''),
      (await page.locator('[data-testid="st-file-report-headline"]').textContent().catch(() => '')) ?? '')
    // the main purpose of the panel: the importer's notes are a to-do list, so they have to arrive as
    // separate rows to work through, not one run-together line that reads as "it broke"
    const rows = await items.allTextContents()
    check('each note is its own checklist row, one per thing that did not cross',
      rows.length === 2, `rows=${rows.length}: ${rows.map((r) => r.slice(0, 24)).join(' | ')}`)
    check('the two rows are the two distinct losses, not one blob repeated',
      new Set(rows).size === 2 && rows.some((r) => /%IX\*/.test(r)) && rows.some((r) => /RETAIN/.test(r)),
      rows.map((r) => r.slice(0, 24)).join(' | '))
    check('a row carries the note in full, cause AND fix',
      /target's I\/O configuration completes\. Here the variable is a plain one: wire a part to it by name/.test(rows.find((r) => /%IX\*/.test(r)) ?? ''),
      (rows.find((r) => /%IX\*/.test(r)) ?? '').slice(0, 80))
    // the control: a located input/output, and a memory address, cross as written, so none appears as a loss
    check('a located input/output or memory address is not reported as a loss (each crosses as written)',
      !rows.some((r) => /%IX0\.0/.test(r) || /%QX0\.1/.test(r) || /%MW10/.test(r)),
      rows.map((r) => r.slice(0, 24)).join(' | '))
    const progress = page.locator('[data-testid="st-file-report-progress"]')
    check('the list says how many things are left to check',
      /2 things to check before you trust the simulation/.test((await progress.textContent().catch(() => '')) ?? ''),
      (await progress.textContent().catch(() => '')) ?? '')
    // and it is a checklist, not a plain list: a row can be ticked off, and the count follows
    await items.first().locator('input[type="checkbox"]').check()
    check('ticking a row moves the count',
      /^1 of 2 checked/.test((await progress.textContent().catch(() => '')) ?? ''),
      (await progress.textContent().catch(() => '')) ?? '')
    // the reader is meant to fix the listed things, so editing must not clear the list
    await page.locator('.cm-content').focus()
    await page.keyboard.press('End')
    await page.keyboard.type(' ')
    await page.waitForTimeout(300)
    check('the checklist survives the edits it is asking for', (await report.count()) === 1)

    // ---- the other import format: PLCopen XML, which is what an IEC tool's export produces ----
    // `.st` only serves someone willing to copy source out POU by POU; the vendor button gives
    // you XML. Same three properties: the program arrives whole, the task period is adopted, and
    // what the subset cannot hold is named.
    const VENDOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types>
    <dataTypes/>
    <pous>
      <pou name="Seal" pouType="functionBlock">
        <interface>
          <inputVars><variable name="S"><type><BOOL/></type></variable></inputVars>
          <outputVars><variable name="Q"><type><BOOL/></type></variable></outputVars>
        </interface>
        <body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">Q := S;</xhtml></ST></body>
      </pou>
      <pou name="Line" pouType="program">
        <interface>
          <localVars>
            <variable name="seal"><type><derived name="Seal"/></type></variable>
            <variable name="Run" address="%IX0.1"><type><BOOL/></type></variable>
            <variable name="Hold" address="%MW4"><type><INT/></type></variable>
            <variable name="Spare" address="%IX*"><type><BOOL/></type></variable>
          </localVars>
          <outputVars><variable name="Lamp"><type><BOOL/></type></variable></outputVars>
        </interface>
        <body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">seal(S := Run, Q =&gt; Lamp);</xhtml></ST></body>
      </pou>
    </pous>
  </types>
  <instances><configurations><configuration name="Plant">
    <resource name="CPU">
      <task name="Cyc" interval="T#30ms" priority="0"><pouInstance name="P" typeName="Line"/></task>
    </resource>
  </configuration></configurations></instances>
</project>`
    await page.setInputFiles('[data-testid="st-import-file"]', {
      name: 'line.xml', mimeType: 'text/xml', buffer: Buffer.from(VENDOR_XML, 'utf8'),
    })
    await landed(page, 'seal(S := Run, Q => Lamp);')
    const xdoc = await page.locator('.cm-content').textContent()
    check('a PLCopen project lands in the editor as ST, wrapper peeled',
      xdoc.includes('FUNCTION_BLOCK Seal') && xdoc.includes('seal(S := Run, Q => Lamp);') && !xdoc.includes('<pou'),
      (xdoc ?? '').slice(0, 80))
    check('the XML task interval becomes the editor scan time',
      (await scanValue(page)) === '30')
    // %IX/%QX and a memory address cross as written, so the XML's loss is its incomplete address
    // (the note has to name it rather than drop it), and the memory variable ends up in the program
    check('an incomplete address in the XML is named, not swallowed',
      /%IX\*/.test((await report.textContent().catch(() => '')) ?? ''),
      ((await report.textContent().catch(() => '')) ?? '').slice(0, 90))
    check('a memory address in the XML crosses as written (storage the program keeps)',
      /Hold\s+AT\s+%MW4/.test(xdoc ?? '') && !/%MW4/.test((await report.textContent().catch(() => '')) ?? ''),
      ((xdoc ?? '').match(/Hold[^;]*/)?.[0] ?? 'Hold not found').slice(0, 60))
    check('the new file starts a fresh checklist, nothing pre-ticked',
      (await page.locator('[data-testid="st-file-report-item"] input:checked').count()) === 0)

    // ---- a file that is not a program: the failure has to be as informative as the success ----
    // "Could not import" on its own leaves someone re-picking the same file. The card names what
    // went wrong, that nothing was lost, and which formats the import accepts.
    await page.setInputFiles('[data-testid="st-import-file"]', {
      name: 'archive.xml', mimeType: 'text/xml', buffer: Buffer.from('<<<not xml at all', 'utf8'),
    })
    // wait on the card changing, not on a clock: a fixed sleep here reads the previous import's
    // report and reports the failure as silent
    await page.locator('[data-testid="st-file-report-headline"]').filter({ hasText: 'Could not import' })
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    const failed = (await report.textContent().catch(() => '')) ?? ''
    check('a refused file says which file, in the error lane',
      /Could not import archive\.xml/.test(failed), failed.slice(0, 80))
    check('a refused file says the program in the editor is untouched', /untouched/.test(failed))
    check('a refused file names the formats this door takes', /PLCopen TC6 XML/.test(failed) && /\.st/.test(failed))
    check('the editor still holds the program the failed import did not replace',
      ((await page.locator('.cm-content').textContent()) ?? '').includes('seal(S := Run'))

    // ---- the organizer: an index over the program just imported ----
    // it moves the view only, so this asserts the cursor moved into the block, not that any
    // document was swapped (there is one, shared with collaborators, and it must stay that way)
    const pouRows = page.locator(':is([data-testid="org-pou"], [data-testid="org-top"]) .org-name')
    check('a multi-POU program is listed in the organizer', (await pouRows.count()) === 2, `pouRows=${await pouRows.count()}`)
    check('the organizer names the program body and the function block',
      (await pouRows.allTextContents()).join(',') === 'Top-level code,Seal',
      (await pouRows.allTextContents()).join(','))
    await page.locator('[data-testid="org-pou"]').first().click()
    await page.waitForTimeout(250)
    const activeLine = (await page.locator('.cm-activeLine').first().textContent().catch(() => '')) ?? ''
    check('clicking a block puts the cursor in it', /FUNCTION_BLOCK Seal/.test(activeLine), activeLine.slice(0, 40))

    // ---- several controllers: each PLC's own file ----
    console.log('--- one file per controller ---')
    await page.evaluate(() => {
      const st = window.__oip.store
      st.commitProgram('Two controllers', {
        source: 'FUNCTION_BLOCK Hold\nVAR_INPUT\n  x : BOOL;\nEND_VAR\nVAR_OUTPUT\n  q : BOOL;\nEND_VAR\nq := x;\nEND_FUNCTION_BLOCK\n\n' +
          'FUNCTION_BLOCK Unused\nVAR\n  n : INT;\nEND_VAR\nn := n + 1;\nEND_FUNCTION_BLOCK\n\n' +
          'PROGRAM Line\nVAR_INPUT\n  Eye : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Run : BOOL;\nEND_VAR\nVAR\n  h : Hold;\nEND_VAR\nh(x := NOT Eye);\nRun := h.q;\nEND_PROGRAM\n\n' +
          'VAR_INPUT\n  Start : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Lamp : BOOL;\nEND_VAR\nLamp := Start;\n',
        controller: {
          tasks: [{ name: 'MainTask', intervalMs: 10, priority: 10 }, { name: 'Cell2Task', intervalMs: 20, priority: 10, plc: 'Cell2' }],
          programs: [{ name: 'Main', task: 'MainTask' }, { name: 'LineB', type: 'Line', task: 'Cell2Task' }],
        },
      })
      st.addNamedPlc('Cell2')
      st.setPlcRunsOn('Cell2', 'app')
    })
    const cell2Head = page.locator('[data-testid="org-plc"][data-plc="Cell2"] [data-testid="org-plc-head"]')
    await cell2Head.waitFor({ timeout: 10000 })
    await cell2Head.click({ button: 'right' })
    const [cell2Dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.locator('[data-testid="org-export-st"]').click()])
    const cell2Text = await (async () => {
      const chunks = []
      for await (const c of await cell2Dl.createReadStream()) chunks.push(c)
      return Buffer.concat(chunks).toString('utf8')
    })()
    check("Cell2's node exports Cell2's program: its task, its instance and the block it calls",
      /cell2/i.test(cell2Dl.suggestedFilename()) && /TASK Cell2Task/.test(cell2Text) && /PROGRAM LineB WITH Cell2Task : Line/.test(cell2Text) && /FUNCTION_BLOCK Hold/.test(cell2Text),
      `${cell2Dl.suggestedFilename()}: ${cell2Text.length} chars`)
    check("...and nothing it does not run: no MainTask, no default controller's own code, no unused block",
      !/MainTask/.test(cell2Text) && !/Lamp := Start/.test(cell2Text) && !/FUNCTION_BLOCK Unused/.test(cell2Text), cell2Text.slice(0, 120).replace(/\n/g, ' '))
    const main = await download(page, 'Export PLC Program (.st)')
    const mainReport = (await page.locator('[data-testid="st-file-report"]').innerText().catch(() => '')) ?? ''
    check("the File menu exports the default controller's program, and says Cell2 exports from its own node",
      /TASK MainTask/.test(main.text) && !/Cell2Task/.test(main.text) && /Lamp := Start/.test(main.text) && /Cell2 has its own file/.test(mainReport),
      `${main.name}; ${mainReport.replace(/\s+/g, ' ').slice(0, 160)}`)
    check('...leaving out the blocks the default controller does not use, by name', /Left out .*Unused/.test(mainReport) && !/FUNCTION_BLOCK Unused/.test(main.text), mainReport.replace(/\s+/g, ' ').slice(0, 200))

    // ---- a program that does not compile must not export ----
    await setDoc(page, 'VAR a : INT; END_VAR\na := Missing;')
    await page.locator('.cm-lintRange-error').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
    // The click is awaited and the verdict waits on the card changing. Racing the click against a short download
    // timeout lets the verdict arrive before the click happens, so "no download" would read as a refusal of a button
    // that was never pressed.
    let brokenDownloaded = false
    const onBrokenDownload = () => { brokenDownloaded = true }
    page.on('download', onBrokenDownload)
    await panelCommand(page, 'Export PLC Program (.st)')
    const refusedWithReport = await page.locator('[data-testid="st-file-report-headline"]').filter({ hasText: 'Could not export the program' })
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
    await page.waitForTimeout(1000) // long enough for a download the click did start to have been announced
    page.off('download', onBrokenDownload)
    check('a program that does not compile is refused, not exported half-formed', !brokenDownloaded)
    // ...and says so in the report card: the export is a command (File menu, palette), so the refusal cannot rely
    // on a red line in a PLC panel that may not be in view
    check('the refusal is a report that says so, not silence', refusedWithReport,
      ((await page.locator('[data-testid="st-file-report-headline"]').textContent().catch(() => '')) ?? '').slice(0, 60))

    const pageErrs = errors.filter((e) => !/favicon|manifest/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
