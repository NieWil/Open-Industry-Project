// Verifies the live side of the linked project folder (src/editor/project/projectFolderLink.ts) in a real
// browser, which unit tests can't reach:
//   - linking adopts the folder's project in place (no page reload; a reload per agent save would make
//     the loop unusable)
//   - the background sweep notices an external write and reloads the project, with no user action
//   - a write the validator rejects raises the sticky banner instead of failing silently
//   - a later good write clears the banner again
//   - an older multi-scene folder (format 1-3) is refused at the link, with an error and nothing changed: it splits
//     into a folder per scene, which a browser cannot create
//   - a linked folder that becomes multi-scene while the app has it open (a checkout of an old commit) is paused:
//     the banner says so, nothing is loaded or written, and restoring the format-4 manifest resumes the sync
//
// The folder is a synthetic DirLike injected through __oip.linkFolder: showDirectoryPicker is a
// native OS dialog and Playwright cannot drive it, so the gate builds the same structure the module
// works against. Everything after the picker is the real code path.
//
// Run: node e2e/verify-project-folder-link.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const ST_ONE = 'VAR_OUTPUT\n  Run : BOOL;\nEND_VAR\n\nRun := TRUE;\n'
const ST_TWO = 'VAR_OUTPUT\n  Run : BOOL;\n  Ready : BOOL;\nEND_VAR\n\nRun := TRUE;\nReady := TRUE;\n'

/** the folder an agent would have written, as the flat {path, contents} the codec defines (format 7) */
const MANIFEST = JSON.stringify({
  version: 7,
  name: 'Linked Factory',
  scene: 'scene.json',
  program: ['plc/program.st'],
  tests: ['tests/runs.test.json'],
})
const FILES = [
  { path: 'project.json', contents: MANIFEST },
  { path: 'scene.json', contents: JSON.stringify({ version: 4, parts: [] }) },
  { path: 'plc/program.st', contents: ST_ONE },
  {
    path: 'tests/runs.test.json',
    contents: JSON.stringify({ name: 'runs', duration: 1, checks: [{ tag: 'Run', at: 0.5, equals: true }] }),
  },
]

/** the same project as an older build wrote it: a format-2 manifest listing two scenes */
const MULTI_MANIFEST = JSON.stringify({
  version: 2,
  name: 'Linked Factory',
  activeScene: 0,
  scenes: [
    { id: 'line', name: 'Line', scene: 'scenes/line.scene.json', stProgram: 'scenes/line.st' },
    { id: 'pack', name: 'Packing', scene: 'scenes/pack.scene.json' },
  ],
})
const MULTI_SCENES = [
  { path: 'scenes/line.scene.json', contents: JSON.stringify({ version: 4, parts: [] }) },
  { path: 'scenes/line.st', contents: ST_ONE },
  { path: 'scenes/pack.scene.json', contents: JSON.stringify({ version: 4, parts: [] }) },
]
const OLD_FILES = [{ path: 'project.json', contents: MULTI_MANIFEST }, ...MULTI_SCENES]

// Installed in the page: a mutable fake folder plus a `write` that changes a file's contents and its
// mtime, which is what an agent saving a file looks like to the sweep.
function installFakeFolder(files) {
  const state = new Map(files.map((f) => [f.path, { contents: f.contents, mtime: 1 }]))
  const fileHandle = (name, path) => ({
    kind: 'file',
    name,
    getFile: async () => {
      const e = state.get(path)
      return { lastModified: e.mtime, size: e.contents.length, text: async () => e.contents }
    },
  })
  const dirAt = (name, prefix) => ({
    name,
    entries: async function* () {
      const seen = new Set()
      for (const path of state.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) yield [rest, fileHandle(rest, path)]
        else {
          const dir = rest.slice(0, slash)
          if (seen.has(dir)) continue
          seen.add(dir)
          yield [dir, dirAt(dir, prefix + dir + '/')]
        }
      }
    },
  })
  window.__fakeFolder = {
    dir: dirAt('my-factory', ''),
    write(path, contents) {
      const e = state.get(path) ?? { mtime: 1 }
      state.set(path, { contents, mtime: e.mtime + 1000 })
    },
    remove(path) {
      state.delete(path)
    },
  }
}

// A writable fake folder behind a stubbed showDirectoryPicker. The picker is a native OS dialog, but
// everything the command does with its result is real, so stubbing just the dialog lets the gate run
// the actual "Save Project to Folder…" path end to end, routing and confirmations included.
function installFakePicker() {
  const written = new Map()
  const fileHandle = (name, path) => ({
    kind: 'file',
    name,
    getFile: async () => {
      const e = written.get(path)
      return { lastModified: e.mtime, size: e.contents.length, text: async () => e.contents }
    },
  })
  const dirAt = (name, prefix) => ({
    name,
    entries: async function* () {
      const seen = new Set()
      for (const path of written.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) yield [rest, fileHandle(rest, path)]
        else {
          const dir = rest.slice(0, slash)
          if (seen.has(dir)) continue
          seen.add(dir)
          yield [dir, dirAt(dir, prefix + dir + '/')]
        }
      }
    },
    getDirectoryHandle: async (child) => dirAt(child, `${prefix}${child}/`),
    getFileHandle: async (child) => ({
      createWritable: async () => ({
        write: async (data) => void written.set(`${prefix}${child}`, { contents: data, mtime: 1 }),
        close: async () => {},
      }),
    }),
  })
  window.__savedFolder = {
    written,
    paths: () => [...written.keys()].sort(),
    write(path, contents) {
      const e = written.get(path) ?? { mtime: 1 }
      written.set(path, { contents, mtime: e.mtime + 1000 })
    },
  }
  window.showDirectoryPicker = async () => dirAt('saved-factory', '')
}

async function runFromPalette(page, query) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), { timeout: 5000 })
  await page.evaluate((q) => {
    const input = document.querySelector('.palette-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, q)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }, query)
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
}

const projectName = (page) => page.evaluate(() => window.__oip.store.getState().projectName)
const stProgram = (page) => page.evaluate(() => window.__oip.store.snapshotProject().stProgram ?? '')
const bannerText = (page) =>
  page.evaluate(() => document.querySelector('.autosave-banner')?.textContent ?? null)

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (e) => {
      failures++
      console.error('  FAIL: page error:', e.message)
    })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { timeout: 180000 })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.linkFolder), {
      timeout: 120000,
    })
    await page.waitForTimeout(1500)

    console.log('--- an older multi-scene folder is refused ---')
    const nameBefore = await projectName(page)
    await page.evaluate(installFakeFolder, OLD_FILES)
    const oldError = await page.evaluate(() => window.__oip.linkFolder(window.__fakeFolder.dir))
    expect(/holds 2 scenes/.test(oldError ?? '') && /desktop app/.test(oldError ?? ''), `linking it is refused, and says why (got: ${oldError})`)
    expect((await projectName(page)) === nameBefore, 'nothing was opened')
    expect(await page.evaluate(() => !window.__oip.store.getState().linkedFolder), 'and nothing is linked')

    console.log('--- link ---')
    await page.evaluate(installFakeFolder, FILES)
    const navigated = page.evaluate(() => new Promise((r) => window.addEventListener('beforeunload', () => r(true))))
    const linkError = await page.evaluate(() => window.__oip.linkFolder(window.__fakeFolder.dir))
    expect(linkError === null, `linking succeeds (got: ${linkError})`)
    expect((await projectName(page)) === 'Linked Factory', 'the folder\'s project is adopted')
    expect(
      await page.evaluate(() => window.__oip.store.getState().testCount === 1),
      'the folder\'s tests come with it',
    )
    expect((await stProgram(page)).includes('Run := TRUE;'), 'the ST program is loaded from the folder')
    expect(
      await page.evaluate(() => window.__oip.store.getState().linkedFolder === 'my-factory'),
      'the linked folder is published to state',
    )
    // the in-place check: adoptImportedProject would reload the page here
    expect(
      await Promise.race([navigated, new Promise((r) => setTimeout(() => r(false), 300))]) === false,
      'linking does NOT reload the page',
    )

    console.log('--- an external write ---')
    await page.evaluate((st) => window.__fakeFolder.write('plc/program.st', st), ST_TWO)
    await page.waitForFunction(
      () => (window.__oip.store.snapshotProject().stProgram ?? '').includes('Ready'),
      { timeout: 8000 },
    )
    expect(true, 'the sweep notices the write and reloads the program, with no user action')
    expect((await bannerText(page)) === null, 'no warning banner on a good read')

    console.log('--- a write the validator rejects ---')
    await page.evaluate(() =>
      window.__fakeFolder.write('scene.json', JSON.stringify({ version: 4, parts: [{ id: 'x', type: 'nope' }] })),
    )
    await page.waitForFunction(() => !!document.querySelector('.autosave-banner'), { timeout: 8000 })
    const text = await bannerText(page)
    // 'not in sync', not 'not loading': the project and the folder are kept in sync both ways, so
    // FolderLinkBanner shows the same banner for a failed write as for a failed read.
    expect(/Folder not in sync/.test(text ?? ''), 'a bad read raises the sticky banner')
    expect(/my-factory/.test(text ?? ''), 'the banner names the folder')
    expect(
      await page.evaluate(() => (window.__oip.store.snapshotProject().stProgram ?? '').includes('Ready')),
      'the last good project stays loaded rather than being half-replaced',
    )

    console.log('--- and recovering ---')
    await page.evaluate(() => window.__fakeFolder.write('scene.json', JSON.stringify({ version: 4, parts: [] })))
    await page.waitForFunction(() => !document.querySelector('.autosave-banner'), { timeout: 8000 })
    expect(true, 'a later good write clears the banner')

    console.log('--- the linked folder turns multi-scene under the app: held ---')
    await page.evaluate(
      ([manifest, scenes]) => {
        for (const f of scenes) window.__fakeFolder.write(f.path, f.contents)
        window.__fakeFolder.write('project.json', manifest)
      },
      [MULTI_MANIFEST, MULTI_SCENES],
    )
    await page.waitForFunction(() => /holds 2 scenes/.test(document.querySelector('.autosave-banner')?.textContent ?? ''), {
      timeout: 8000,
    })
    const held = (await bannerText(page)) ?? ''
    expect(/Nothing was loaded or written/.test(held), `the banner says the folder is held, and why (${held.slice(0, 90)}...)`)
    expect(
      (await stProgram(page)).includes('Ready') && (await projectName(page)) === 'Linked Factory',
      'the project on screen is untouched (its program is not the old scene\'s)',
    )
    // back to the format-4 commit: its manifest, and no scenes/ files (a checkout removes them, as git would)
    await page.evaluate(
      ([manifest, scenes]) => {
        for (const f of scenes) window.__fakeFolder.remove(f.path)
        window.__fakeFolder.write('project.json', manifest)
      },
      [MANIFEST, MULTI_SCENES],
    )
    const released = await page
      .waitForFunction(() => !document.querySelector('.autosave-banner'), null, { timeout: 15000, polling: 250 })
      .then(() => true, () => false)
    expect(released, `putting the format-4 folder back releases the hold (banner: ${released ? 'gone' : await bannerText(page)})`)

    if (process.env.OIP_SHOT) await page.screenshot({ path: process.env.OIP_SHOT })

    // ── the bootstrap: save the live project into a folder, and follow the folder just written ──
    console.log('--- save to a folder, then follow it ---')
    await page.evaluate(() => window.__oip.store.getState().linkedFolder && window.__oip.store.setFolderLink(null, null))
    const dialogs = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    await page.evaluate(installFakePicker)
    await runFromPalette(page, 'Save Project to Folder')
    await page.waitForFunction(() => window.__oip.store.getState().linkedFolder === 'saved-factory', { timeout: 10000 })

    const paths = await page.evaluate(() => window.__savedFolder.paths())
    console.log('  wrote:', JSON.stringify(paths))
    expect(paths.includes('project.json'), 'the manifest is written')
    expect(paths.includes('scene.json'), 'the scene is written, at the folder root (format 4)')
    expect(paths.includes('plc/program.st'), 'and so is the program, under plc/ (format 7)')
    expect(!paths.some((p) => p.startsWith('scenes/')), 'and nothing in the old scenes/ layout')
    // the version the app writes (core/project/project.ts PROJECT_VERSION), read from the app rather than hard-coded here,
    // so a format bump doesn't fail this check against a correct save
    const versions = await page.evaluate(() => ({
      manifest: JSON.parse(window.__savedFolder.written.get('project.json').contents).version,
      app: window.__oip.store.snapshotProject().version,
    }))
    expect(versions.manifest === versions.app, `the manifest carries the project format the app writes (${versions.manifest} vs ${versions.app})`)
    expect(
      await page.evaluate(() => JSON.parse(window.__savedFolder.written.get('project.json').contents).name),
      'the manifest carries the project name',
    )
    // The app says this in its own save notice, not a native dialog (projectFolderLink.ts:
    // 'Saved to folder' / 'This project now lives in the folder "x". Changes save there as you work.').
    // `dialogs` stays captured above so an unexpected native prompt still can't block the run.
    const savedNotice = await page.evaluate(() => {
      const n = window.__oip.store.getState().saveNotice
      return n ? `${n.title} ${n.message}` : null
    })
    expect(
      /now lives in the folder/.test(savedNotice ?? '') && /save there as you work/i.test(savedNotice ?? ''),
      'the user is told that saving also starts following, and that edits are not written back',
    )

    // The agent context file (core/agentGuide.ts), which gives an agent pointed at the folder its context.
    // Asserted through the real Save command rather than in a unit test, because the point is that it
    // is written by an ordinary save, on every surface, without anyone opting in.
    expect(paths.includes('AGENTS.md'), 'the agent guide is written by an ordinary save')
    const guide = await page.evaluate(() => window.__savedFolder.written.get('AGENTS.md')?.contents ?? '')
    expect(/agent guide/i.test(guide), 'the guide names itself')
    expect(guide.includes('st-capabilities.json'), 'it points at the probed ST capability manifest')
    expect(/checks geometry/.test(guide), 'it states how far the geometry check goes')
    // and it does not interfere with loading: the folder it was just written into still round-trips
    expect(
      await page.evaluate(() => window.__oip.store.getState().linkedFolder === 'saved-factory'),
      'the folder still loads with the guide present',
    )

    // and the folder it just wrote is live: an external edit to it flows back in
    console.log('--- and it is followed ---')
    const scenePath = paths.find((p) => p.endsWith('.st'))
    if (scenePath) {
      await page.evaluate((p) => window.__savedFolder.write(p, 'VAR_OUTPUT\n  Later : BOOL;\nEND_VAR\n\nLater := TRUE;\n'), scenePath)
      await page.waitForFunction(
        () => (window.__oip.store.snapshotProject().stProgram ?? '').includes('Later'),
        { timeout: 8000 },
      )
      expect(true, 'a write to the saved folder flows straight back into the app')
    } else {
      expect(false, 'expected the saved folder to contain an .st file to edit')
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall project-folder-link checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
