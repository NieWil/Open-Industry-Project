// Tests for agentProjects.cjs - the agent door's project tools. Runs with plain Node (no Electron):
// `node apps/desktop/agentProjects.test.cjs`. A stand-in host answers the editor's half; the editor and the shell
// together are e2e/verify-agent-mcp-electron.mjs.

const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createProjectTools } = require('./agentProjects.cjs')
const { createFolderRegistry } = require('./folderRegistry.cjs')
const { createFolderGrants } = require('./folderGrants.cjs')

function project(dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name }))
  return dir
}

/** The host's editor half: records each request and answers it with `reply` (default: the page reloads). */
function fakeHost(reply = { ok: true, text: 'reloading' }) {
  const host = {
    requests: [],
    served: true,
    request: async (op, args) => {
      host.requests.push([op, args])
      return typeof reply === 'function' ? reply(op, args) : reply
    },
    nextServe: async () => host.served,
  }
  return host
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'oip-agent-projects-'))
  try {
    const projects = join(base, 'Projects')
    const recent = project(join(base, 'elsewhere', 'Bottling'), 'Bottling Line')
    const inFolder = project(join(projects, 'Sorter'), 'Sorter Cell')
    const outside = project(join(base, 'stranger', 'Secret'), 'Secret')
    mkdirSync(join(projects, 'not-a-project'))
    const registry = createFolderRegistry(join(base, 'registry.json'))
    registry.remember('doc-1', { path: recent, name: 'Bottling Line', touch: true })
    const grants = createFolderGrants()
    const asked = []
    let answer = false
    let current = recent
    /** folders another editor window has open, and the window the agent was moved to */
    const elsewhere = new Set()
    let drove = null
    const tools = createProjectTools({
      registry,
      grants,
      projectsRoot: () => projects,
      currentRoot: () => current,
      canonical: (p) => p,
      askToOpen: async (root, name) => {
        asked.push([root, name])
        return answer
      },
      reloadWaitMs: 50,
      openElsewhere: (root) => elsewhere.has(root),
      driveWindowWith: (root) => elsewhere.has(root) && ((drove = root), true),
    })
    const tool = (name) => tools.find((t) => t.definition.name === name)
    const json = (r) => (assert.equal(r.ok, true, r.error), JSON.parse(r.text))

    // list_projects: Open Recent first, then the projects folder's other project folders; the open one marked
    let host = fakeHost()
    let listed = json(await tool('list_projects').run(host, {}))
    assert.deepEqual(listed.projects.map((p) => [p.name, p.open]), [['Bottling Line', true], ['Sorter Cell', false]])
    assert.equal(listed.projectsFolder, projects)
    assert.equal(typeof listed.projects[0].openedAt, 'string')
    assert.equal(listed.projects[1].openedAt, null)
    console.log('ok: list_projects')

    // open_project by name: a listed project opens without asking, granted first, and the editor is asked to open it
    const opened = json(await tool('open_project').run(host, { project: 'sorter cell' }))
    assert.deepEqual(opened, { opened: 'Sorter Cell', path: inFolder })
    assert.deepEqual(host.requests, [['openFolder', { root: inFolder }]])
    assert.equal(asked.length, 0, 'a folder in the projects folder opens unasked')
    assert.equal(grants.allows(inFolder), true, 'the folder is granted before the editor reads it')
    // ...and a recent one by path
    host = fakeHost()
    assert.equal(json(await tool('open_project').run(host, { project: recent })).opened, 'Bottling Line')
    assert.equal(asked.length, 0, 'a folder in Open Recent opens unasked')
    // the editor says it is the open project already
    host = fakeHost({ ok: true, text: 'already' })
    assert.match(json(await tool('open_project').run(host, { project: recent })).note, /already the open project/)
    console.log('ok: open_project, listed')

    // any other folder asks; declined, nothing is granted or opened
    host = fakeHost()
    let r = await tool('open_project').run(host, { project: outside })
    assert.deepEqual(asked, [[outside, 'Secret']])
    assert.equal(r.ok, false)
    assert.match(r.error, /declined/)
    assert.equal(host.requests.length, 0)
    assert.equal(grants.allows(outside), false, 'a declined folder is not granted')
    answer = true
    assert.equal(json(await tool('open_project').run(host, { project: outside })).opened, 'Secret')
    assert.equal(grants.allows(outside), true)
    console.log('ok: open_project, asked')

    // refusals: not a project, an unknown name, two of one name, the editor refusing, the editor not coming back
    host = fakeHost()
    r = await tool('open_project').run(host, { project: join(projects, 'not-a-project') })
    assert.match(r.error, /not a project folder/)
    r = await tool('open_project').run(host, { project: 'Nope' })
    assert.match(r.error, /no project named 'Nope'/)
    r = await tool('open_project').run(host, { project: '' })
    assert.match(r.error, /must be a name or a folder path/)
    project(join(projects, 'Sorter Copy'), 'Sorter Cell')
    r = await tool('open_project').run(host, { project: 'Sorter Cell' })
    assert.match(r.error, /2 projects are named 'Sorter Cell'/)
    host = fakeHost({ ok: false, error: 'a collab room is open' })
    r = await tool('open_project').run(host, { project: recent })
    assert.deepEqual(r, { ok: false, error: 'a collab room is open' })
    host = fakeHost()
    host.served = false
    r = await tool('open_project').run(host, { project: recent })
    assert.match(r.error, /did not come back/)
    console.log('ok: open_project, refusals')

    // a project open in another window: listed as such, and open_project moves the agent there instead of opening it
    elsewhere.add(inFolder)
    listed = json(await tool('list_projects').run(fakeHost(), {}))
    assert.equal(listed.projects.find((p) => p.path === inFolder).openInAnotherWindow, true)
    assert.equal(listed.projects.find((p) => p.path === recent).openInAnotherWindow, undefined)
    host = fakeHost()
    r = await tool('open_project').run(host, { project: inFolder })
    assert.match(json(r).note, /open in another window/)
    assert.equal(drove, inFolder)
    assert.equal(host.requests.length, 0, 'nothing reloads')
    elsewhere.clear()
    console.log('ok: a project open in another window')

    // new_project: the editor makes it; the answer names the folder it recorded last
    host = fakeHost((op, args) => {
      registry.remember('doc-new', { path: join(projects, args.name), name: args.name, touch: true })
      return { ok: true, text: 'reloading' }
    })
    const made = json(await tool('new_project').run(host, { name: '  Palletizer ' }))
    assert.deepEqual(host.requests, [['newProject', { name: 'Palletizer' }]])
    assert.deepEqual(made, { created: 'Palletizer', path: join(projects, 'Palletizer') })
    r = await tool('new_project').run(fakeHost(), { name: ' ' })
    assert.match(r.error, /non-empty/)
    console.log('ok: new_project')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  console.log('\nall agentProjects checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
